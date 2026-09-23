import { createClient, type AuthChangeEvent, type Session, type SupabaseClient } from "@supabase/supabase-js";
import type { AccountState } from "../shared/munhae-api";
import { throwAccountError } from "./account-service";
import { AppError } from "./errors";

type AccountReader = { getState(): Promise<AccountState> };
type SessionReader = Pick<SupabaseClient["auth"], "getSession" | "onAuthStateChange">;
type ClientOptions = { url: string; publishableKey: string; fetch?: typeof fetch };

/** Only this project's Storage endpoint gets the larger checkpoint transfer budget. */
function requestTimeout(input: Parameters<typeof fetch>[0], projectUrl: string): number {
  try {
    const target = new URL(input instanceof Request ? input.url : String(input));
    const project = new URL(projectUrl);
    const storagePrefix = `${project.pathname.replace(/\/+$/, "")}/storage/v1/`;
    if (target.origin === project.origin && !target.username && !target.password && target.pathname.startsWith(storagePrefix)) return 120_000;
  } catch { /* An invalid request still gets the conservative network deadline. */ }
  return 15_000;
}

function superseded(): AppError {
  return new AppError("auth_request_superseded", "계정 상태가 바뀌어 이전 요청을 취소했습니다. 다시 시도하세요.");
}

function requireSignedIn(state: AccountState): string {
  if (state.status !== "signed_in" || !state.user?.id) {
    throw new AppError("session_not_found", "온라인 프로젝트를 사용하려면 문해 계정으로 로그인하세요.");
  }
  return state.user.id;
}

/** Only a local change marker, never an authorization decision. The server verifies the JWT. */
function sessionIdentity(session: Session | null): string | null {
  if (!session?.user?.id || !session.access_token) return null;
  try {
    const claims = JSON.parse(Buffer.from(session.access_token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof claims.session_id !== "string" || !claims.session_id || claims.sub !== session.user.id) return null;
    return `${session.user.id}:${claims.session_id}`;
  } catch { return null; }
}

/** Main-only access: each operation owns a fixed user JWT and cannot follow a later login. */
export class AuthenticatedClientAccess {
  private epoch = 0;
  private identity: string | null | undefined;
  private verifiedState: AccountState | null = null;
  private pendingChanges = 0;
  private disposed = false;
  private readonly requests = new Set<AbortController>();
  private readonly realtime = new Set<{ client: SupabaseClient; stop(): void }>();
  private readonly unsubscribe: () => void;

  constructor(private readonly account: AccountReader, private readonly auth: SessionReader, private readonly options: ClientOptions) {
    const { data } = auth.onAuthStateChange((event, session) => this.changed(event, session));
    this.unsubscribe = () => data.subscription.unsubscribe();
  }

  private invalidate(): void {
    this.epoch += 1;
    for (const controller of this.requests) controller.abort();
    for (const stream of [...this.realtime]) stream.stop();
  }

  /** Bracket credential mutations so cached signed-in state cannot admit work during logout. */
  beginAccountChange(): () => void {
    this.pendingChanges += 1;
    this.invalidate();
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.pendingChanges -= 1;
      this.invalidate();
    };
  }

  private changed(event: AuthChangeEvent, session: Session | null): void {
    if (this.disposed) return;
    if (!["INITIAL_SESSION", "SIGNED_IN", "SIGNED_OUT", "TOKEN_REFRESHED", "USER_UPDATED", "PASSWORD_RECOVERY"].includes(event)) return;
    if (event === "INITIAL_SESSION" && this.identity !== undefined) return;
    const identity = sessionIdentity(session);
    if (event === "SIGNED_OUT" || event === "PASSWORD_RECOVERY" || (this.identity !== undefined && identity !== this.identity)) this.invalidate();
    this.identity = identity;
    if (event === "TOKEN_REFRESHED" && session?.access_token) {
      for (const stream of this.realtime) void stream.client.realtime.setAuth(session.access_token).catch(() => stream.stop());
    }
    if (event === "SIGNED_OUT") this.verifiedState = null;
    if (event === "PASSWORD_RECOVERY" && this.verifiedState) this.verifiedState = { ...this.verifiedState, status: "password_recovery" };
  }

  /** Main-owned, server-verified AccountService publications, never renderer input. */
  updateAccountState(state: AccountState): void {
    this.verifiedState = { ...state, user: state.user ? { ...state.user } : null };
  }

  /** Synchronous guard for a captured online working copy, including background writes. */
  assertAuthenticatedUser(userId: string): void {
    this.assertCurrent(this.epoch);
    if (!this.verifiedState) throw new AppError("session_not_found", "온라인 프로젝트를 사용하려면 문해 계정으로 로그인하세요.");
    if (requireSignedIn(this.verifiedState) !== userId || !this.identity?.startsWith(`${userId}:`)) throw superseded();
  }

  private assertCurrent(epoch: number): void {
    if (this.disposed) throw new AppError("auth_not_ready", "계정 연결을 준비 중입니다. 앱을 다시 열어 주세요.");
    if (this.pendingChanges || this.epoch !== epoch) throw superseded();
  }

  private async readAccount(epoch: number): Promise<AccountState> {
    try {
      const state = await this.account.getState();
      this.assertCurrent(epoch);
      this.updateAccountState(state);
      return state;
    } catch (error) { this.assertCurrent(epoch); throw error; }
  }

  async run<T>(action: (client: SupabaseClient, userId: string) => Promise<T>): Promise<T> {
    const epoch = this.epoch;
    this.assertCurrent(epoch);
    const state = await this.readAccount(epoch);
    this.assertCurrent(epoch);
    const userId = requireSignedIn(state);
    let sessionResult: Awaited<ReturnType<SessionReader["getSession"]>>;
    try { sessionResult = await this.auth.getSession(); }
    catch (error) { this.assertCurrent(epoch); throwAccountError(error); }
    this.assertCurrent(epoch);
    if (sessionResult.error) throwAccountError(sessionResult.error);
    const session = sessionResult.data.session;
    const identity = sessionIdentity(session);
    if (!session || !identity || session.user.id !== userId) throw superseded();
    if (this.identity === undefined) this.identity = identity;
    if (this.identity !== identity) throw superseded();
    const ready = await this.readAccount(epoch);
    this.assertCurrent(epoch);
    if (requireSignedIn(ready) !== userId) throw superseded();

    const controller = new AbortController();
    this.requests.add(controller);
    let finished = false;
    const assertCurrent = () => {
      this.assertCurrent(epoch);
      if (finished || this.identity !== identity) throw superseded();
    };
    const accessToken = session.access_token;
    // accessToken avoids a second Auth SDK/storage instance and fixes the credential for
    // every query. Do not use the shared auth client's late-reading fetch wrapper here.
    const client = createClient(this.options.url, this.options.publishableKey, {
      accessToken: async () => accessToken,
      // Surface failures promptly; a cancelled account must not enter SDK retry backoff.
      db: { retry: false },
      global: {
        fetch: async (input, init) => {
          assertCurrent();
          const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(requestTimeout(input, this.options.url)), ...(requestSignal ? [requestSignal] : [])]);
          try {
            const response = await (this.options.fetch ?? fetch)(input, { ...init, signal });
            assertCurrent();
            return response;
          } catch (error) { assertCurrent(); throw error; }
        },
      },
    });
    try {
      assertCurrent();
      const result = await action(client, userId);
      assertCurrent();
      const current = await this.readAccount(epoch);
      assertCurrent();
      if (requireSignedIn(current) !== userId) throw superseded();
      return result;
    } catch (error) { assertCurrent(); throw error; }
    finally {
      finished = true;
      this.requests.delete(controller);
      controller.abort();
    }
  }

  /** A separate main-owned connection: its lifetime is the account session, not an RPC. */
  async watchProject(projectId: string, notice: (revision: number | null) => void,
    state: (connected: boolean) => void): Promise<() => void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
      throw new AppError("invalid_input", "프로젝트 식별자를 확인하세요.");
    }
    let stop: (() => void) | undefined;
    try {
      return await this.run(async (_requestClient, userId) => {
        const epoch = this.epoch;
        const identity = this.identity;
        let active = true;
        const current = () => {
          if (!active || epoch !== this.epoch || identity !== this.identity) return false;
          try { this.assertAuthenticatedUser(userId); return true; } catch { return false; }
        };
        const client = createClient(this.options.url, this.options.publishableKey, {
          accessToken: async () => {
            if (!current()) throw superseded();
            const { data, error } = await this.auth.getSession();
            if (error || !current() || sessionIdentity(data.session) !== identity) throw superseded();
            return data.session!.access_token;
          },
        });
        const stream = { client, stop: () => {
          if (!active) return;
          active = false;
          this.realtime.delete(stream);
          // Close immediately on logout; do not wait for a server leave acknowledgement.
          // Cleanup failures must never become unhandled rejections during account teardown.
          void client.removeAllChannels().catch(() => undefined);
          void client.realtime.disconnect().catch(() => undefined);
        } };
        stop = stream.stop;
        this.realtime.add(stream);
        // Await the async token callback before phx_join; otherwise a fast socket
        // can attempt the first subscription anonymously and fail its RLS check.
        await client.realtime.setAuth();
        if (!current()) throw superseded();
        client.channel(`project-data:${projectId}`)
          .on("postgres_changes", { event: "*", schema: "public", table: "online_project_data", filter: `project_id=eq.${projectId}` }, payload => {
            if (!current()) return;
            const row = payload.new as Record<string, unknown> | null | undefined;
            if (row?.project_id !== undefined && row.project_id !== projectId) return;
            const revision = row?.revision;
            notice(typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0 ? revision : null);
          }).subscribe(status => {
            if (!current()) return;
            const connected = status === "SUBSCRIBED";
            state(connected);
            // Subscribe first, then read. Also closes every reconnect delivery gap.
            if (connected) notice(null);
          });
        return stream.stop;
      });
    } catch (error) { stop?.(); throw error; }
  }

  dispose(): void {
    this.disposed = true;
    this.invalidate();
    this.unsubscribe();
  }
}
