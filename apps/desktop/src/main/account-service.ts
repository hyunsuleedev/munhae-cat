import type { AuthChangeEvent, Session, SupabaseClient, User } from "@supabase/supabase-js";
import type { AccountCredentials, AccountPasswordInput, AccountSignUpInput, AccountState, AccountVerifyInput } from "../shared/munhae-api";
import type { AccountStorage } from "./auth-storage";
import { AppError } from "./errors";

const RECOVERY_KEY = "munhae-password-recovery";
type AuthClient = SupabaseClient["auth"];
type Mutation = { id: number; signedOutRevision: number };

function invalidSession(error: { status?: number; name?: string; code?: string }): boolean {
  return error.status === 401 || error.status === 403 || error.name === "AuthSessionMissingError"
    || ["session_not_found", "refresh_token_not_found", "refresh_token_already_used"].includes(error.code ?? "");
}

const ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: "이메일 또는 비밀번호가 올바르지 않습니다.",
  email_not_confirmed: "이메일 인증을 완료한 뒤 로그인하세요.",
  user_already_exists: "이미 가입된 이메일입니다. 로그인하거나 비밀번호를 재설정하세요.",
  weak_password: "비밀번호가 보안 기준에 맞지 않습니다. 8자 이상으로 설정하세요.",
  same_password: "기존 비밀번호와 다른 비밀번호를 입력하세요.",
  otp_expired: "인증번호가 올바르지 않거나 만료되었습니다. 새 번호를 받아 다시 시도하세요.",
  over_email_send_rate_limit: "인증 메일 요청이 많습니다. 잠시 후 다시 시도하세요.",
  over_request_rate_limit: "요청이 많습니다. 잠시 후 다시 시도하세요.",
  email_address_not_authorized: "현재 인증 메일을 이 주소로 보낼 수 없습니다. 문해 서비스의 메일 발송 설정이 필요합니다.",
  email_address_invalid: "올바른 이메일 주소를 입력하세요.",
  signup_disabled: "현재 신규 회원가입이 중지되어 있습니다.",
  captcha_failed: "인증 확인을 완료하지 못했습니다. 다시 시도하세요.",
  session_not_found: "로그인 세션이 만료되었습니다. 다시 로그인하세요.",
  refresh_token_not_found: "로그인 세션이 만료되었습니다. 다시 로그인하세요.",
  refresh_token_already_used: "로그인 세션이 만료되었습니다. 다시 로그인하세요.",
  reauthentication_needed: "다시 로그인한 뒤 비밀번호를 변경하세요.",
};

export function throwAccountError(error: unknown): never {
  if (error instanceof AppError) throw error;
  const e = error as { code?: string; name?: string; status?: number } | null;
  if (e?.name === "AuthRetryableFetchError" || e?.name === "TypeError" || e?.status === 0) {
    throw new AppError("auth_network_error", "문해 서버에 연결할 수 없습니다. 인터넷 연결을 확인한 뒤 다시 시도하세요.");
  }
  const code = e?.code && ERROR_MESSAGES[e.code] ? e.code : "auth_failed";
  throw new AppError(code, ERROR_MESSAGES[code] ?? "계정 요청을 완료하지 못했습니다. 잠시 후 다시 시도하세요.");
}

export class AccountService {
  private recovery: boolean;
  private restoring: Promise<AccountState> | null = null;
  private state: AccountState | null = null;
  private user: User | null = null;
  private revision = 0;
  private signedOutRevision = 0;
  private mutationId = 0;
  private mutationTail: Promise<void> = Promise.resolve();
  private pendingMutations = 0;
  private mutationsSettled: Promise<void> | null = null;
  private settleMutations: (() => void) | null = null;
  private disposed = false;
  private readonly unsubscribe: () => void;

  constructor(private readonly auth: AuthClient, private readonly storage: AccountStorage,
    private readonly notify: (state: AccountState) => void = () => undefined) {
    this.recovery = storage.getItem(RECOVERY_KEY) === "1";
    const { data } = auth.onAuthStateChange((event, session) => this.changed(event, session));
    this.unsubscribe = () => data.subscription.unsubscribe();
  }

  private setRecovery(value: boolean): void {
    this.recovery = value;
    if (value) this.storage.setItem(RECOVERY_KEY, "1");
    else this.storage.removeItem(RECOVERY_KEY);
  }

  private changed(event: AuthChangeEvent, session: Session | null): void {
    if (this.disposed || event === "INITIAL_SESSION") return;
    if (event === "SIGNED_OUT") {
      this.signedOutRevision += 1;
      this.setRecovery(false);
      this.publish(null);
      return;
    }
    if (!["SIGNED_IN", "TOKEN_REFRESHED", "USER_UPDATED", "PASSWORD_RECOVERY"].includes(event) || !session?.user) return;
    this.revision += 1;
    // SDK startup also emits SIGNED_IN for a session read from local storage.
    // Only the initial server verification or an explicit successful sign-in
    // may establish the first signed-in state. Managed mutations publish after
    // setting their recovery mode, so OTP events never briefly unlock the app.
    if (this.pendingMutations) return;
    if (event === "PASSWORD_RECOVERY") this.setRecovery(true);
    if (!this.state) return;
    this.publish(session.user);
  }

  private publish(user: User | null): AccountState {
    this.user = user;
    const state = this.view(user);
    const changed = JSON.stringify(state) !== JSON.stringify(this.state);
    this.state = state;
    this.revision += 1;
    if (changed && !this.disposed) this.notify(state);
    return state;
  }

  private async mutate<T>(action: (mutation: Mutation) => Promise<T>): Promise<T> {
    this.ensureActive();
    const id = ++this.mutationId;
    const previous = this.mutationTail;
    let finish!: () => void;
    this.mutationTail = new Promise((resolve) => { finish = resolve; });
    this.revision += 1;
    if (this.pendingMutations++ === 0) {
      this.mutationsSettled = new Promise((resolve) => { this.settleMutations = resolve; });
    }
    try {
      // SDK credential methods also write persistent session state. Serializing
      // them ensures a queued logout clears a late login's SDK session as well
      // as its UI state. Newer requests prevent older results being published.
      await previous;
      const mutation = { id, signedOutRevision: this.signedOutRevision };
      this.ensureCurrent(mutation);
      return await action(mutation);
    }
    finally {
      finish();
      this.revision += 1;
      if (--this.pendingMutations === 0) {
        this.settleMutations?.();
        this.settleMutations = null;
        this.mutationsSettled = null;
      }
    }
  }

  private ensureActive(): void {
    if (this.disposed) throw new AppError("auth_not_ready", "계정 연결을 준비 중입니다. 앱을 다시 열어 주세요.");
  }

  private ensureCurrent(mutation: Mutation, signingOut = false): void {
    this.ensureActive();
    if (mutation.id !== this.mutationId || (!signingOut && mutation.signedOutRevision !== this.signedOutRevision)) {
      throw new AppError("auth_request_superseded", "계정 상태가 바뀌어 이전 요청을 취소했습니다. 다시 시도하세요.");
    }
  }

  private view(user: User | null): AccountState {
    return {
      status: !user ? "signed_out" : this.recovery ? "password_recovery" : "signed_in",
      user: user ? {
        id: user.id,
        email: user.email ?? "",
        displayName: [user.user_metadata?.display_name, user.user_metadata?.full_name, user.user_metadata?.name].find((name): name is string => typeof name === "string")?.slice(0, 80) ?? "",
        emailConfirmedAt: user.email_confirmed_at ?? null,
        providers: [...new Set((user.identities ?? []).map((identity) => identity.provider))].filter((provider): provider is "email" | "google" => provider === "email" || provider === "google"),
      } : null,
      persistence: this.storage.persistent ? "encrypted" : "memory",
    };
  }

  async getState(): Promise<AccountState> {
    this.ensureActive();
    if (this.state) return this.state;
    // Every renderer shares the one main-process restoration. Once ready,
    // Supabase's refresh lifecycle and auth events keep the snapshot current.
    this.restoring ??= this.restoreState().finally(() => { this.restoring = null; });
    return this.restoring;
  }

  private async restoreState(): Promise<AccountState> {
    for (;;) {
      this.ensureActive();
      if (this.state) return this.state;
      if (this.mutationsSettled) { await this.mutationsSettled; continue; }
      const revision = this.revision;
      const { data, error } = await this.auth.getSession();
      if (revision !== this.revision) continue;
      if (error) {
        if (invalidSession(error)) return this.signOut();
        throwAccountError(error);
      }
      if (!data.session) { this.setRecovery(false); return this.publish(null); }
      // A restored local session is not proof that the account is still valid.
      const verified = await this.auth.getUser(data.session.access_token);
      if (revision !== this.revision) continue;
      if (verified.error) {
        if (invalidSession(verified.error)) {
          return this.signOut();
        }
        throwAccountError(verified.error);
      }
      if (!verified.data.user) return this.signOut();
      return this.publish(verified.data.user);
    }
  }

  async signUp(input: AccountSignUpInput): Promise<{ state: AccountState; confirmationRequired: boolean }> {
    return this.mutate(async (mutation) => {
      const { data, error } = await this.auth.signUp({
        email: input.email, password: input.password,
        options: { data: { display_name: input.displayName } },
      });
      if (error) throwAccountError(error);
      this.ensureCurrent(mutation);
      this.setRecovery(false);
      return { state: this.publish(data.session?.user ?? null), confirmationRequired: !data.session };
    });
  }

  async signIn(input: AccountCredentials): Promise<AccountState> {
    return this.mutate(async (mutation) => {
      const { data, error } = await this.auth.signInWithPassword(input);
      if (error) throwAccountError(error);
      this.ensureCurrent(mutation);
      this.setRecovery(false);
      return this.publish(data.session?.user ?? null);
    });
  }

  async signOut(): Promise<AccountState> {
    return this.mutate(async (mutation) => {
      const { error } = await this.auth.signOut({ scope: "local" });
      if (error && !invalidSession(error)) throwAccountError(error);
      this.ensureCurrent(mutation, true);
      this.signedOutRevision += 1;
      this.setRecovery(false);
      return this.publish(null);
    });
  }

  async acceptGoogleSession(tokens: { access_token: string; refresh_token: string }): Promise<AccountState> {
    return this.mutate(async (mutation) => {
      const { data, error } = await this.auth.setSession(tokens);
      if (error) throwAccountError(error);
      this.ensureCurrent(mutation);
      if (!data.session) throw new AppError("oauth_failed", "구글 로그인 세션을 저장하지 못했습니다.");
      this.setRecovery(false);
      return this.publish(data.session.user);
    });
  }

  async verifyCode(input: AccountVerifyInput): Promise<AccountState> {
    return this.mutate(async (mutation) => {
      const { data, error } = await this.auth.verifyOtp({ email: input.email, token: input.code, type: input.purpose });
      if (error) throwAccountError(error);
      this.ensureCurrent(mutation);
      this.setRecovery(input.purpose === "recovery");
      return this.publish(data.session?.user ?? null);
    });
  }

  async resendConfirmation(email: string): Promise<void> {
    const { error } = await this.auth.resend({ type: "signup", email });
    if (error) throwAccountError(error);
  }

  async requestPasswordReset(email: string): Promise<void> {
    const { error } = await this.auth.resetPasswordForEmail(email);
    if (error) throwAccountError(error);
  }

  async updatePassword(input: AccountPasswordInput): Promise<AccountState> {
    const state = await this.getState();
    if (!state.user) throw new AppError("session_not_found", "로그인 세션이 만료되었습니다. 다시 로그인하세요.");
    const email = state.user.email;
    const userId = state.user.id;
    return this.mutate(async (mutation) => {
      if (this.user?.id !== userId) throw new AppError("session_not_found", "계정 상태가 바뀌었습니다. 다시 로그인하세요.");
      if (!this.recovery) {
        if (!input.currentPassword) throw new AppError("current_password_required", "현재 비밀번호를 입력하세요.");
        const { error } = await this.auth.signInWithPassword({ email, password: input.currentPassword });
        if (error) throwAccountError(error);
        this.ensureCurrent(mutation);
      }
      const { data, error } = await this.auth.updateUser({ password: input.password });
      if (error) throwAccountError(error);
      this.ensureCurrent(mutation);
      this.setRecovery(false);
      return this.publish(data.user);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.revision += 1;
    this.user = null;
    this.state = null;
    this.unsubscribe();
    this.auth.stopAutoRefresh();
  }
}
