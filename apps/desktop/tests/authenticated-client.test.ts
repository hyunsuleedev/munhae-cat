import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthChangeEvent, Session, SupabaseClient } from "@supabase/supabase-js";
import type { AccountState } from "../src/shared/munhae-api";
import { AuthenticatedClientAccess } from "../src/main/authenticated-client";

function session(userId = "reader-a", sessionId = "session-a", revision = 1): Session {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return {
    access_token: `${encode({ alg: "HS256" })}.${encode({ sub: userId, session_id: sessionId, revision })}.test-signature`,
    refresh_token: "test-refresh", token_type: "bearer", expires_in: 3_600,
    user: { id: userId, email: `${userId}@example.invalid`, user_metadata: {} },
  } as Session;
}

function state(value: Session | null, status?: AccountState["status"]): AccountState {
  return {
    status: status ?? (value ? "signed_in" : "signed_out"), persistence: "memory",
    user: value ? { id: value.user.id, email: value.user.email!, displayName: "Reader", emailConfirmedAt: null, providers: ["email"] } : null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };

function fixture(initial: Session | null = session()) {
  let active = initial;
  let snapshot = state(initial);
  let listener = (_event: AuthChangeEvent, _session: Session | null) => undefined as void;
  const unsubscribe = vi.fn();
  const account = { getState: vi.fn(async () => snapshot) };
  const auth = {
    getSession: vi.fn(async () => ({ data: { session: active }, error: null })),
    onAuthStateChange: vi.fn((callback: typeof listener) => {
      listener = callback;
      return { data: { subscription: { unsubscribe } } };
    }),
  };
  const fetcher = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => new Response(JSON.stringify([{ id: "project-a" }]), {
    status: 200, headers: { "Content-Type": "application/json" },
  }));
  const access = new AuthenticatedClientAccess(account, auth as unknown as SupabaseClient["auth"], {
    url: "https://project.example.invalid", publishableKey: "sb_publishable_test", fetch: fetcher,
  });
  return {
    access, account, auth, fetcher, unsubscribe,
    setState: (value: AccountState) => { snapshot = value; },
    setSession: (value: Session | null) => { active = value; },
    emit: (event: AuthChangeEvent, value: Session | null = active) => {
      active = value;
      if (event !== "INITIAL_SESSION") snapshot = state(value, event === "PASSWORD_RECOVERY" ? "password_recovery" : undefined);
      listener(event, value);
    },
  };
}

describe("main-only authenticated data client", () => {
  it("gives project checkpoint transfers 120 seconds while keeping data requests at 15 seconds", async () => {
    const f = fixture();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      await f.access.run(async (client) => {
        await client.from("online_projects").select("id");
        expect(timeout).toHaveBeenLastCalledWith(15_000);
        await client.storage.from("online-project-checkpoints").download("owner/project/checkpoint.zip");
        expect(timeout).toHaveBeenLastCalledWith(120_000);
        await client.from("online_projects").select("id");
        expect(timeout).toHaveBeenLastCalledWith(15_000);
      });
    } finally { timeout.mockRestore(); f.access.dispose(); }
  });

  it("immediately aborts a Storage transfer when credentials begin changing", async () => {
    const f = fixture();
    const started = deferred<void>();
    let signal: AbortSignal | null | undefined;
    f.fetcher.mockImplementation(async (_input, init) => {
      signal = init?.signal;
      started.resolve();
      return new Promise<Response>((_resolve, reject) => { signal?.addEventListener("abort", () => reject(new Error("canceled")), { once: true }); });
    });
    const downloading = f.access.run(client => client.storage.from("online-project-checkpoints").download("checkpoint.zip"));
    const rejected = expect(downloading).rejects.toMatchObject({ code: "auth_request_superseded" });
    await started.promise;
    const finish = f.access.beginAccountChange();
    expect(signal?.aborted).toBe(true);
    await rejected;
    finish();
    f.access.dispose();
  });

  it("requires both a verified snapshot and matching SDK identity for synchronous repo access", async () => {
    const f = fixture();
    f.emit("INITIAL_SESSION");
    expect(() => f.access.assertAuthenticatedUser("reader-a")).toThrow();
    f.access.updateAccountState(state(session()));
    expect(() => f.access.assertAuthenticatedUser("reader-a")).not.toThrow();
    expect(() => f.access.assertAuthenticatedUser("reader-b")).toThrow();
    f.emit("SIGNED_IN", session("reader-b", "session-b"));
    expect(() => f.access.assertAuthenticatedUser("reader-a")).toThrow();
    expect(() => f.access.assertAuthenticatedUser("reader-b")).toThrow();
    f.access.updateAccountState(state(session("reader-b", "session-b")));
    expect(() => f.access.assertAuthenticatedUser("reader-b")).not.toThrow();
    f.access.dispose();
  });

  it("immediately blocks captured online repo access during credential changes, recovery, logout, and disposal", async () => {
    const f = fixture();
    await f.access.run(async () => undefined);
    const finish = f.access.beginAccountChange();
    expect(() => f.access.assertAuthenticatedUser("reader-a")).toThrow();
    finish();
    expect(() => f.access.assertAuthenticatedUser("reader-a")).not.toThrow();
    f.emit("PASSWORD_RECOVERY");
    expect(() => f.access.assertAuthenticatedUser("reader-a")).toThrow();
    f.access.updateAccountState(state(session()));
    expect(() => f.access.assertAuthenticatedUser("reader-a")).not.toThrow();
    f.emit("SIGNED_OUT", null);
    expect(() => f.access.assertAuthenticatedUser("reader-a")).toThrow();
    f.emit("SIGNED_IN", session("reader-a", "new-session"));
    expect(() => f.access.assertAuthenticatedUser("reader-a")).toThrow();
    f.access.updateAccountState(state(session("reader-a", "new-session")));
    expect(() => f.access.assertAuthenticatedUser("reader-a")).not.toThrow();
    f.access.dispose();
    expect(() => f.access.assertAuthenticatedUser("reader-a")).toThrow();
  });

  it("keeps synchronous workspace access across token refresh and profile changes", async () => {
    const f = fixture();
    await f.access.run(async () => undefined);
    f.emit("TOKEN_REFRESHED", session("reader-a", "session-a", 2));
    f.emit("USER_UPDATED", session("reader-a", "session-a", 2));
    expect(() => f.access.assertAuthenticatedUser("reader-a")).not.toThrow();
    f.access.dispose();
  });

  it("uses the verified user's captured JWT without a second mutable Auth client", async () => {
    const f = fixture();
    const result = await f.access.run(async (client, userId) => {
      expect(userId).toBe("reader-a");
      expect(() => client.auth.getSession).toThrow(/accessToken/);
      return client.from("online_projects").select("id");
    });
    expect(result.data).toEqual([{ id: "project-a" }]);
    expect(f.auth.getSession).toHaveBeenCalledOnce();
    const headers = new Headers(f.fetcher.mock.calls[0]![1]!.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${session().access_token}`);
    expect(headers.get("apikey")).toBe("sb_publishable_test");
    expect(JSON.stringify(result)).not.toContain("test-signature");
    f.access.dispose();
  });

  it.each(["signed_out", "password_recovery"] as const)("rejects %s before reading credentials or querying", async (status) => {
    const f = fixture();
    f.setState(state(status === "signed_out" ? null : session(), status));
    const action = vi.fn();
    await expect(f.access.run(action)).rejects.toMatchObject({ code: "session_not_found" });
    expect(f.auth.getSession).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
    f.access.dispose();
  });

  it.each([null, session("reader-b"), { ...session(), access_token: "malformed" }, {
    ...session(), access_token: session("reader-b").access_token,
  }])("rejects a missing, invalid, or differently owned SDK session", async (value) => {
    const f = fixture();
    f.setSession(value);
    const action = vi.fn();
    await expect(f.access.run(action)).rejects.toMatchObject({ code: "auth_request_superseded" });
    expect(action).not.toHaveBeenCalled();
    f.access.dispose();
  });

  it("blocks new work while a credential mutation is pending and resumes after a failed mutation", async () => {
    const f = fixture();
    const finish = f.access.beginAccountChange();
    const action = vi.fn(async () => "done");
    await expect(f.access.run(action)).rejects.toMatchObject({ code: "auth_request_superseded" });
    expect(f.account.getState).not.toHaveBeenCalled();
    finish(); finish();
    await expect(f.access.run(action)).resolves.toBe("done");
    f.access.dispose();
  });

  it("rejects a late initial account read after logout instead of asking for the new session", async () => {
    const f = fixture();
    const initial = deferred<AccountState>();
    f.account.getState.mockImplementationOnce(() => initial.promise);
    const action = vi.fn();
    const pending = f.access.run(action);
    const rejected = expect(pending).rejects.toMatchObject({ code: "auth_request_superseded" });
    f.emit("SIGNED_OUT", null);
    initial.resolve(state(session()));
    await rejected;
    expect(f.auth.getSession).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
    f.access.dispose();
  });

  it("rejects a late getSession result after logout and same-user login", async () => {
    const f = fixture();
    const read = deferred<Awaited<ReturnType<typeof f.auth.getSession>>>();
    f.auth.getSession.mockImplementationOnce(() => read.promise);
    const action = vi.fn();
    const pending = f.access.run(action);
    const rejected = expect(pending).rejects.toMatchObject({ code: "auth_request_superseded" });
    await flush();
    f.emit("SIGNED_OUT", null);
    f.emit("SIGNED_IN", session("reader-a", "session-new"));
    read.resolve({ data: { session: session() }, error: null });
    await rejected;
    expect(action).not.toHaveBeenCalled();
    f.access.dispose();
  });

  it("rechecks verified identity after reading the SDK session", async () => {
    const f = fixture();
    f.account.getState.mockResolvedValueOnce(state(session())).mockResolvedValueOnce(state(session("reader-b")));
    const action = vi.fn();
    await expect(f.access.run(action)).rejects.toMatchObject({ code: "auth_request_superseded" });
    expect(action).not.toHaveBeenCalled();
    f.access.dispose();
  });

  it.each(["logout", "same-user-login", "other-user-login", "recovery", "pending-change", "dispose"])("blocks an unsent old-account query after %s", async (change) => {
    const f = fixture();
    const proceed = deferred<void>();
    let ready!: () => void;
    const entered = new Promise<void>((resolve) => { ready = resolve; });
    const pending = f.access.run(async (client) => {
      ready();
      await proceed.promise;
      return client.from("online_projects").insert({ name: "old account intent" }).select("id");
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: change === "dispose" ? "auth_not_ready" : "auth_request_superseded" });
    await entered;
    if (change === "logout") f.emit("SIGNED_OUT", null);
    else if (change === "same-user-login") f.emit("SIGNED_IN", session("reader-a", "session-new"));
    else if (change === "other-user-login") f.emit("SIGNED_IN", session("reader-b", "session-b"));
    else if (change === "recovery") f.emit("PASSWORD_RECOVERY", session());
    else if (change === "pending-change") f.access.beginAccountChange();
    else f.access.dispose();
    proceed.resolve();
    await rejected;
    expect(f.fetcher).not.toHaveBeenCalled();
    if (change !== "dispose") f.access.dispose();
  });

  it("discards an already-sent response after logout, including same-user relogin", async () => {
    const f = fixture();
    const response = deferred<Response>();
    f.fetcher.mockImplementationOnce(() => response.promise);
    const pending = f.access.run(async (client) => client.from("online_projects").select("id"));
    const rejected = expect(pending).rejects.toMatchObject({ code: "auth_request_superseded" });
    await flush();
    expect(f.fetcher).toHaveBeenCalledOnce();
    f.emit("SIGNED_OUT", null);
    expect(f.fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    f.emit("SIGNED_IN", session("reader-a", "session-new"));
    response.resolve(new Response(JSON.stringify([{ id: "private-old-project" }]), { status: 200 }));
    await rejected;
    f.access.dispose();
  });

  it("keeps normal refresh and profile updates valid while fixing the operation's original JWT", async () => {
    const f = fixture();
    const original = session().access_token;
    const result = await f.access.run(async (client) => {
      f.emit("TOKEN_REFRESHED", session("reader-a", "session-a", 2));
      f.emit("USER_UPDATED", session("reader-a", "session-a", 3));
      f.emit("SIGNED_IN", session("reader-a", "session-a", 3));
      return client.from("online_projects").select("id");
    });
    expect(result.data).toEqual([{ id: "project-a" }]);
    expect(new Headers(f.fetcher.mock.calls[0]![1]!.headers).get("authorization")).toBe(`Bearer ${original}`);
    f.access.dispose();
  });

  it("accepts an SDK refresh completed during getSession when its session identity is unchanged", async () => {
    const f = fixture();
    f.emit("INITIAL_SESSION", session());
    f.auth.getSession.mockImplementationOnce(async () => {
      const refreshed = session("reader-a", "session-a", 2);
      f.emit("TOKEN_REFRESHED", refreshed);
      return { data: { session: refreshed }, error: null };
    });
    await f.access.run(async (client) => client.from("online_projects").select("id"));
    expect(new Headers(f.fetcher.mock.calls[0]![1]!.headers).get("authorization")).toBe(`Bearer ${session("reader-a", "session-a", 2).access_token}`);
    f.access.dispose();
  });

  it("does not let a late initial SDK event replace a newer established identity", async () => {
    const f = fixture();
    f.emit("SIGNED_IN", session("reader-a", "session-new"));
    f.emit("INITIAL_SESSION", session());
    f.setSession(session("reader-a", "session-new"));
    await expect(f.access.run(async () => "current project")).resolves.toBe("current project");
    f.access.dispose();
  });

  it("rechecks after the action and final account read before returning data", async () => {
    const f = fixture();
    const finalState = deferred<AccountState>();
    f.account.getState.mockResolvedValueOnce(state(session())).mockResolvedValueOnce(state(session())).mockImplementationOnce(() => finalState.promise);
    const pending = f.access.run(async () => "private-project");
    const rejected = expect(pending).rejects.toMatchObject({ code: "auth_request_superseded" });
    await flush();
    f.emit("SIGNED_OUT", null);
    f.emit("SIGNED_IN", session("reader-a", "session-new"));
    finalState.resolve(state(session()));
    await rejected;
    f.access.dispose();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });

  it("maps session-read errors without exposing SDK details", async () => {
    const f = fixture();
    f.auth.getSession.mockRejectedValueOnce(Object.assign(new Error("private diagnostic"), { name: "AuthRetryableFetchError" }));
    await expect(f.access.run(vi.fn())).rejects.toMatchObject({ code: "auth_network_error" });
    f.access.dispose();
  });
});

// Real Supabase Realtime client/serializer/channel against an in-memory WebSocket.
// This exercises the persistent-client lifetime rather than mocking watchProject itself.
class RealtimeSocket extends EventTarget {
  static sockets: RealtimeSocket[] = [];
  readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSING = 2; readonly CLOSED = 3;
  readyState = 0; protocol = ""; binaryType = "arraybuffer";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  frames: Array<[string | null, string | null, string, string, Record<string, any>]> = [];
  constructor(readonly url: string) {
    super(); RealtimeSocket.sockets.push(this);
    queueMicrotask(() => { if (this.readyState !== 0) return; this.readyState = 1; const event = new Event("open"); this.onopen?.(event); this.dispatchEvent(event); });
  }
  send(raw: string) {
    const frame = JSON.parse(raw) as RealtimeSocket["frames"][number]; this.frames.push(frame);
    const [join, ref, topic, event, payload] = frame;
    if (event === "phx_join" || event === "phx_leave" || event === "heartbeat") {
      const response = event === "phx_join" ? { postgres_changes: payload.config.postgres_changes.map((filter: object) => ({ ...filter, id: 1 })) } : {};
      queueMicrotask(() => this.receive([join, ref, topic, "phx_reply", { status: "ok", response }]));
    }
  }
  receive(frame: unknown[]) { const event = new MessageEvent("message", { data: JSON.stringify(frame) }); this.onmessage?.(event); this.dispatchEvent(event); }
  change(projectId: string, revision: number) {
    const join = this.frames.find(frame => frame[3] === "phx_join")!;
    this.receive([join[0], null, join[2], "postgres_changes", { ids: [1], data: { schema: "public", table: "online_project_data", type: "UPDATE",
      commit_timestamp: "2026-09-22T00:00:00Z", columns: [{ name: "project_id", type: "uuid" }, { name: "revision", type: "int8" }], record: { project_id: projectId, revision }, old_record: {}, errors: null } }]);
  }
  close() { if (this.readyState === 3) return; this.readyState = 3; const event = Object.assign(new Event("close"), { code: 1000, reason: "", wasClean: true }); this.onclose?.(event); this.dispatchEvent(event); }
  loseConnection() { this.readyState = 3; const event = Object.assign(new Event("close"), { code: 1006, reason: "network lost", wasClean: false }); this.onclose?.(event); this.dispatchEvent(event); }
}

describe("account-scoped persistent Realtime", () => {
  const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const accesses: AuthenticatedClientAccess[] = [];
  afterEach(async () => { for (const access of accesses.splice(0)) access.dispose(); await flush(); for (const socket of RealtimeSocket.sockets) socket.close(); RealtimeSocket.sockets = []; vi.unstubAllGlobals(); vi.useRealTimers(); });
  function realtimeFixture() { vi.stubGlobal("WebSocket", RealtimeSocket); const f = fixture(); accesses.push(f.access); return f; }

  it("survives completion of its setup RPC and delivers authenticated changes on its own connection", async () => {
    const f = realtimeFixture(), notice = vi.fn(), connection = vi.fn();
    const stop = await f.access.watchProject(projectId, notice, connection);
    await flush();
    expect(connection).toHaveBeenCalledWith(true);
    expect(notice).toHaveBeenCalledWith(null);
    const socket = RealtimeSocket.sockets[0]!;
    expect(socket.readyState).toBe(1);
    expect(socket.frames.find(frame => frame[3] === "phx_join")![4].access_token).toBe(session().access_token);
    notice.mockClear(); socket.change(projectId, 2); await flush();
    expect(notice).toHaveBeenCalledExactlyOnceWith(2);
    await f.access.run(async () => "unrelated RPC");
    socket.change(projectId, 3); await flush();
    expect(notice).toHaveBeenLastCalledWith(3);
    stop(); stop(); await flush(); expect(socket.readyState).toBe(3);
  });

  it("refreshes the token on the same session without closing or rebuilding the channel", async () => {
    const f = realtimeFixture(), notice = vi.fn();
    await f.access.watchProject(projectId, notice, vi.fn()); await flush();
    const socket = RealtimeSocket.sockets[0]!;
    f.emit("TOKEN_REFRESHED", session("reader-a", "session-a", 2)); await flush();
    expect(RealtimeSocket.sockets).toHaveLength(1); expect(socket.readyState).toBe(1);
    expect(socket.frames.filter(frame => frame[3] === "access_token").at(-1)![4].access_token).toBe(session("reader-a", "session-a", 2).access_token);
    notice.mockClear(); socket.change(projectId, 4); await flush(); expect(notice).toHaveBeenCalledExactlyOnceWith(4);
  });

  it("requests a fresh snapshot after reconnect so missed revisions are recovered", async () => {
    vi.useFakeTimers();
    const f = realtimeFixture(), notice = vi.fn(), connection = vi.fn();
    await f.access.watchProject(projectId, notice, connection); await flush();
    notice.mockClear(); connection.mockClear();
    RealtimeSocket.sockets[0]!.loseConnection(); await flush();
    expect(connection).toHaveBeenCalledWith(false);
    await vi.advanceTimersByTimeAsync(1500); await flush();
    expect(RealtimeSocket.sockets).toHaveLength(2);
    expect(connection).toHaveBeenLastCalledWith(true);
    expect(notice).toHaveBeenCalledWith(null);
    RealtimeSocket.sockets[1]!.change(projectId, 7); await flush();
    expect(notice).toHaveBeenLastCalledWith(7);
  });

  it.each(["logout", "credentials", "recovery", "account-switch", "dispose"])("closes immediately and rejects late old-socket delivery on %s", async reason => {
    const f = realtimeFixture(), notice = vi.fn(), connection = vi.fn();
    await f.access.watchProject(projectId, notice, connection); await flush();
    const socket = RealtimeSocket.sockets[0]!, late = socket.onmessage;
    notice.mockClear(); connection.mockClear();
    if (reason === "logout") f.emit("SIGNED_OUT", null);
    else if (reason === "credentials") f.access.beginAccountChange();
    else if (reason === "recovery") f.emit("PASSWORD_RECOVERY");
    else if (reason === "account-switch") f.emit("SIGNED_IN", session("reader-b", "session-b"));
    else f.access.dispose();
    await flush(); expect(socket.readyState).toBe(3);
    socket.onmessage = late; socket.change(projectId, 99); await flush();
    expect(notice).not.toHaveBeenCalled(); expect(connection).not.toHaveBeenCalled();
  });

  it("tears down a channel if final setup account verification is overtaken by logout", async () => {
    const f = realtimeFixture(), finalState = deferred<AccountState>();
    f.account.getState.mockResolvedValueOnce(state(session())).mockResolvedValueOnce(state(session())).mockImplementationOnce(() => finalState.promise);
    const watching = f.access.watchProject(projectId, vi.fn(), vi.fn());
    const rejected = expect(watching).rejects.toMatchObject({ code: "auth_request_superseded" });
    await flush(); f.emit("SIGNED_OUT", null); finalState.resolve(state(session())); await rejected; await flush();
    expect(RealtimeSocket.sockets.every(socket => socket.readyState === 3)).toBe(true);
  });

  it("ignores cross-project notices and treats malformed revisions only as a refetch hint", async () => {
    const f = realtimeFixture(), notice = vi.fn();
    await f.access.watchProject(projectId, notice, vi.fn()); await flush(); notice.mockClear();
    const socket = RealtimeSocket.sockets[0]!;
    socket.change("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", 2); await flush(); expect(notice).not.toHaveBeenCalled();
    socket.change(projectId, -1); await flush(); expect(notice).toHaveBeenCalledExactlyOnceWith(null);
  });
});
