import type { Session, SupabaseClient } from "@supabase/supabase-js";
import type { AccountCredentials, AccountPasswordInput, AccountSignUpInput, AccountState, AccountVerifyInput } from "../shared/munhae-api";
import type { AccountStorage } from "./auth-storage";
import { AppError } from "./errors";

const RECOVERY_KEY = "munhae-password-recovery";
type AuthClient = SupabaseClient["auth"];

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
  private readonly unsubscribe: () => void;

  constructor(private readonly auth: AuthClient, private readonly storage: AccountStorage,
    private readonly notify: (state: AccountState) => void = () => undefined) {
    this.recovery = storage.getItem(RECOVERY_KEY) === "1";
    const { data } = auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") this.setRecovery(true);
      if (event === "SIGNED_OUT") this.setRecovery(false);
      this.notify(this.view(session));
    });
    this.unsubscribe = () => data.subscription.unsubscribe();
  }

  private setRecovery(value: boolean): void {
    this.recovery = value;
    if (value) this.storage.setItem(RECOVERY_KEY, "1");
    else this.storage.removeItem(RECOVERY_KEY);
  }

  private view(session: Session | null): AccountState {
    const user = session?.user;
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
    const { data, error } = await this.auth.getSession();
    if (error) throwAccountError(error);
    return this.view(data.session);
  }

  async signUp(input: AccountSignUpInput): Promise<{ state: AccountState; confirmationRequired: boolean }> {
    const { data, error } = await this.auth.signUp({
      email: input.email, password: input.password,
      options: { data: { display_name: input.displayName } },
    });
    if (error) throwAccountError(error);
    return { state: this.view(data.session), confirmationRequired: !data.session };
  }

  async signIn(input: AccountCredentials): Promise<AccountState> {
    const { data, error } = await this.auth.signInWithPassword(input);
    if (error) throwAccountError(error);
    this.setRecovery(false);
    return this.view(data.session);
  }

  async signOut(): Promise<AccountState> {
    const { error } = await this.auth.signOut({ scope: "local" });
    if (error) throwAccountError(error);
    this.setRecovery(false);
    return this.view(null);
  }

  async acceptGoogleSession(tokens: { access_token: string; refresh_token: string }): Promise<AccountState> {
    const { data, error } = await this.auth.setSession(tokens);
    if (error) throwAccountError(error);
    if (!data.session) throw new AppError("oauth_failed", "구글 로그인 세션을 저장하지 못했습니다.");
    this.setRecovery(false);
    const state = this.view(data.session);
    this.notify(state);
    return state;
  }

  async verifyCode(input: AccountVerifyInput): Promise<AccountState> {
    const { data, error } = await this.auth.verifyOtp({ email: input.email, token: input.code, type: input.purpose });
    if (error) throwAccountError(error);
    this.setRecovery(input.purpose === "recovery");
    return this.view(data.session);
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
    if (!this.recovery) {
      if (!input.currentPassword) throw new AppError("current_password_required", "현재 비밀번호를 입력하세요.");
      const { error } = await this.auth.signInWithPassword({ email: state.user.email, password: input.currentPassword });
      if (error) throwAccountError(error);
    }
    const { error } = await this.auth.updateUser({ password: input.password });
    if (error) throwAccountError(error);
    this.setRecovery(false);
    const updated = await this.getState();
    this.notify(updated);
    return updated;
  }

  dispose(): void {
    this.unsubscribe();
    this.auth.stopAutoRefresh();
  }
}
