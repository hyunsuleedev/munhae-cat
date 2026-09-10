import type { AccountState, IpcResult, MunhaeApi } from "../../shared/munhae-api";
import { must } from "./shared";
import { renderAccountContent } from "./account-markup";
import { safeAccountReturn } from "./auth-gate";

type Mode = "signin" | "signup" | "verify_signup" | "reset" | "verify_recovery" | "password" | "profile";
export function mountAccount(api: MunhaeApi, { embedded = false }: { embedded?: boolean } = {}): { deactivate(): void } {
  renderAccountContent();
  let state: AccountState | null = null;
  let stateRevision = 0;
  const returnPage = safeAccountReturn(new URLSearchParams(location.search).get("next"));
  let returnAfterSignIn = returnPage !== null;
  let mode: Mode = embedded ? "profile" : new URLSearchParams(location.search).get("mode") === "signup" ? "signup" : "signin";
  let busy = false;
  let deactivateAfterAction = false;
  let googlePending = false;
  let retryAt = 0;
  const form = must<HTMLFormElement>("#accountForm");
  const email = must<HTMLInputElement>("#accountEmail");
  const password = must<HTMLInputElement>("#accountPassword");
  const currentPassword = must<HTMLInputElement>("#accountCurrentPassword");
  const passwordConfirm = must<HTMLInputElement>("#accountPasswordConfirm");
  const code = must<HTMLInputElement>("#accountCode");

  function showMessage(text: string, error = false): void {
    const box = must("#accountStatus");
    box.hidden = !text;
    box.classList.toggle("is-error", error);
    box.setAttribute("role", error ? "alert" : "status");
    box.textContent = text;
  }

  function clearPasswords(): void {
    password.value = "";
    currentPassword.value = "";
    passwordConfirm.value = "";
    password.type = "password";
    must("#accountTogglePassword").setAttribute("aria-pressed", "false");
    must("#accountTogglePassword").textContent = "표시";
  }

  function field(id: string, visible: boolean): void {
    const container = must(id);
    container.hidden = !visible;
    container.querySelectorAll<HTMLInputElement>("input").forEach((input) => { input.disabled = !visible || busy; });
  }

  function render(): void {
    const verifying = mode === "verify_signup" || mode === "verify_recovery";
    const profile = mode === "profile";
    const titles: Record<Mode, [string, string, string]> = {
      signin: ["다시 만나 반갑습니다", "문해 계정으로 로그인하세요.", "로그인"],
      signup: ["문해와 함께 시작하세요", "Google 계정 또는 이메일로 가입하세요.", "회원가입"],
      verify_signup: ["이메일을 확인해 주세요", `${email.value}로 받은 인증번호를 입력하세요.`, "인증하고 시작하기"],
      reset: ["비밀번호를 잊으셨나요?", "가입한 이메일로 비밀번호 재설정 인증번호를 보내드립니다.", "인증번호 받기"],
      verify_recovery: ["이메일 인증", `${email.value}로 받은 재설정 인증번호를 입력하세요.`, "인증번호 확인"],
      password: ["새 비밀번호 설정", "계정을 보호할 새 비밀번호를 입력하세요.", "비밀번호 저장"],
      profile: [embedded ? "계정" : "내 문해 계정", embedded ? "문해 계정 정보와 로그인 보안을 관리합니다." : "문해 공식 서비스에 로그인되어 있습니다.", ""],
    };
    const [title, description, submit] = titles[mode];
    must("#accountTitle").textContent = title;
    must("#accountBack").hidden = embedded || state?.status !== "signed_in";
    must("#accountContinue").hidden = embedded;
    must("#accountDescription").textContent = description;
    form.hidden = profile;
    field("#accountNameField", mode === "signup");
    field("#accountEmailField", mode === "signin" || mode === "signup" || mode === "reset");
    field("#accountPasswordField", mode === "signin" || mode === "signup" || mode === "password");
    field("#accountPasswordConfirmField", mode === "signup" || mode === "password");
    field("#accountCurrentPasswordField", mode === "password" && state?.status !== "password_recovery");
    field("#accountCodeField", verifying);
    password.minLength = mode === "signin" ? 1 : 8;
    password.autocomplete = mode === "signin" ? "current-password" : "new-password";
    must("#accountPasswordLabel").textContent = mode === "password" ? "새 비밀번호" : "비밀번호";
    must("#accountPasswordHelp").hidden = mode === "signin";
    must("#accountProfile").hidden = !profile;
    must("#accountModeLinks").hidden = profile;
    must("#accountSignUpLink").hidden = mode !== "signin";
    must("#accountResetLink").hidden = mode !== "signin";
    must("#accountSignInLink").hidden = mode === "signin";
    must("#accountSignInLink").textContent = state?.status === "signed_in" ? "내 계정으로 돌아가기" : "로그인으로 돌아가기";
    must("#accountResend").hidden = !verifying;
    must("#accountPersistence").hidden = state?.persistence !== "memory";
    must("#accountRetry").hidden = true;
    must("#accountGoogle").hidden = mode !== "signin" && mode !== "signup";
    must("#accountGoogleCancel").hidden = !googlePending;
    const googleOnly = state?.user?.providers.includes("google") && !state.user.providers.includes("email");
    must("#accountChangePassword").hidden = Boolean(googleOnly);
    must("#accountGooglePasswordHelp").hidden = !googleOnly;
    const submitButton = must<HTMLButtonElement>("#accountSubmit");
    submitButton.textContent = busy ? "처리 중…" : submit;
    submitButton.disabled = busy;
    form.setAttribute("aria-busy", String(busy));
    document.querySelectorAll<HTMLButtonElement>(".account-card button:not(#accountSubmit)").forEach((button) => { button.disabled = busy; });
    must<HTMLButtonElement>("#accountGoogleCancel").disabled = !googlePending;
    if (profile && state?.user) {
      must("#accountDisplayName").textContent = state.user.displayName || "문해 사용자";
      must("#accountUserEmail").textContent = state.user.email;
      must("#accountAvatar").textContent = Array.from(state.user.displayName || "文")[0] ?? "文";
    }
    updateResend();
  }

  function changeMode(next: Mode, focus = true): void {
    clearPasswords();
    code.value = "";
    mode = next;
    showMessage("");
    render();
    if (focus && !form.hidden) form.querySelector<HTMLInputElement>("input:not(:disabled)")?.focus();
  }

  function acceptState(next: AccountState): void {
    stateRevision += 1;
    state = next;
    if (next.status === "signed_out") returnAfterSignIn = true;
    if (next.status === "signed_in" && !embedded) {
      if (returnAfterSignIn) void returnToProject();
      else location.replace("settings.html#account");
      return;
    }
    changeMode(next.status === "password_recovery" ? "password" : next.user ? "profile" : "signin", !embedded);
  }

  function unwrap<T>(result: IpcResult<T>): T {
    if (result.ok) return result.data;
    throw Object.assign(new Error(result.error.message), { code: result.error.code });
  }

  async function perform(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    showMessage("");
    render();
    try { await action(); }
    catch (error) {
      const e = error as { code?: string; message?: string };
      if (e.code === "email_not_confirmed") changeMode("verify_signup");
      showMessage(e.message || "계정 서버에 연결하지 못했습니다. 다시 시도하세요.", e.code !== "oauth_cancelled");
    } finally {
      busy = false;
      clearPasswords();
      if (deactivateAfterAction) {
        deactivateAfterAction = false;
        mode = state?.status === "signed_in" ? "profile" : state?.status === "password_recovery" ? "password" : "signin";
      }
      render();
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy || !form.reportValidity()) return;
    if ((mode === "signup" || mode === "password") && password.value !== passwordConfirm.value) {
      showMessage("비밀번호 확인이 일치하지 않습니다.", true);
      passwordConfirm.focus();
      return;
    }
    const input = { email: email.value.trim(), password: password.value };
    const displayName = must<HTMLInputElement>("#accountName").value.trim();
    const current = currentPassword.value;
    const token = code.value.trim();
    void perform(async () => {
      if (mode === "signin") {
        acceptState(unwrap(await api.auth.signIn(input)));
      } else if (mode === "signup") {
        const result = unwrap(await api.auth.signUp({ ...input, displayName }));
        stateRevision += 1;
        state = result.state;
        if (result.confirmationRequired) { retryAt = Date.now() + 60_000; changeMode("verify_signup"); }
        else acceptState(result.state);
      } else if (mode === "verify_signup" || mode === "verify_recovery") {
        acceptState(unwrap(await api.auth.verifyCode({ email: input.email, code: token, purpose: mode === "verify_signup" ? "signup" : "recovery" })));
      } else if (mode === "reset") {
        unwrap(await api.auth.requestPasswordReset(input.email));
        retryAt = Date.now() + 60_000;
        changeMode("verify_recovery");
        showMessage("가입된 이메일이라면 인증번호가 발송됩니다. 스팸함도 확인해 주세요.");
      } else if (mode === "password") {
        acceptState(unwrap(await api.auth.updatePassword({ password: input.password, ...(state?.status !== "password_recovery" ? { currentPassword: current } : {}) })));
        showMessage("비밀번호를 변경했습니다.");
      }
    });
  });

  function updateResend(): void {
    const button = must<HTMLButtonElement>("#accountResend");
    const remaining = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
    button.disabled = busy || remaining > 0;
    button.textContent = remaining > 0 ? `${remaining}초 후 다시 받기` : "인증번호 다시 받기";
  }
  window.setInterval(updateResend, 1000);

  must("#accountResend").addEventListener("click", () => {
    if (Date.now() < retryAt) return;
    void perform(async () => {
      unwrap(mode === "verify_recovery"
        ? await api.auth.requestPasswordReset(email.value.trim())
        : await api.auth.resendConfirmation(email.value.trim()));
      retryAt = Date.now() + 60_000;
      showMessage("인증번호를 다시 요청했습니다. 가장 최근에 받은 번호를 입력하세요.");
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-account-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      if (busy) return;
      if (state?.status === "password_recovery") {
        void perform(async () => { acceptState(unwrap(await api.auth.signOut())); });
      } else changeMode(state?.user ? "profile" : button.dataset.accountMode as Mode);
    });
  });
  must("#accountTogglePassword").addEventListener("click", () => {
    const visible = password.type === "password";
    password.type = visible ? "text" : "password";
    must("#accountTogglePassword").textContent = visible ? "숨기기" : "표시";
    must("#accountTogglePassword").setAttribute("aria-pressed", String(visible));
  });
  must("#accountSignOut").addEventListener("click", () => void perform(async () => {
    acceptState(unwrap(await api.auth.signOut()));
    showMessage("이 기기에서 로그아웃했습니다.");
  }));
  must("#accountChangePassword").addEventListener("click", () => { if (!busy) changeMode("password"); });
  must("#accountGoogleSignIn").addEventListener("click", () => {
    if (busy) return;
    googlePending = true;
    clearPasswords();
    void perform(async () => {
      showMessage("브라우저에서 Google 계정을 선택해 주세요. 인증을 마치면 앱으로 돌아옵니다.");
      acceptState(unwrap(await api.auth.signInWithGoogle()));
    }).finally(() => { googlePending = false; render(); });
  });
  must("#accountGoogleCancel").addEventListener("click", () => {
    void api.auth.cancelGoogleSignIn().then((result) => { unwrap(result); }).catch((error) => showMessage(error.message, true));
  });

  async function returnToProject(): Promise<void> {
    if (embedded || state?.status !== "signed_in") return;
    // Settings and the start page are valid without an open project. Preserve
    // the validated settings section when authentication began there.
    if (returnPage === "index.html" || returnPage?.split("#", 1)[0] === "settings.html") {
      location.replace(returnPage);
      return;
    }
    const userId = state.user?.id;
    const project = await api.project.getCurrent().catch(() => null);
    if (state?.status !== "signed_in" || state.user?.id !== userId) return;
    location.replace(returnPage && project ? returnPage : project ? "home.html" : "index.html");
  }
  must("#accountBack").addEventListener("click", () => void returnToProject());
  must("#accountContinue").addEventListener("click", () => void returnToProject());

  async function loadAccount(): Promise<void> {
    const revision = ++stateRevision;
    try {
      const next = unwrap(await api.auth.getState());
      if (revision !== stateRevision) return;
      state = next;
      if (state.user) acceptState(state);
      else { returnAfterSignIn = true; render(); }
    } catch (error) {
      if (revision !== stateRevision) return;
      must("#accountTitle").textContent = "계정 연결을 확인해 주세요";
      must("#accountDescription").textContent = "연결을 복구한 뒤 다시 시도할 수 있습니다.";
      showMessage(error instanceof Error ? error.message : "계정 서버에 연결하지 못했습니다.", true);
      must("#accountRetry").hidden = false;
    }
  }
  must("#accountRetry").addEventListener("click", () => void loadAccount());
  api.auth.onStateChanged((next) => {
    stateRevision += 1;
    const changed = state?.status !== next.status || state.user?.id !== next.user?.id;
    state = next;
    if (!busy && changed) acceptState(next);
  });
  render();
  void loadAccount();
  return {
    deactivate(): void {
      clearPasswords();
      code.value = "";
      if (busy) { deactivateAfterAction = true; return; }
      changeMode(state?.status === "signed_in" ? "profile" : state?.status === "password_recovery" ? "password" : "signin", false);
    },
  };
}
