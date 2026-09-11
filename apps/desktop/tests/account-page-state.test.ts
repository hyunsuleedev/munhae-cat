import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountState, IpcResult, MunhaeApi } from "../src/shared/munhae-api";

const shared = vi.hoisted(() => ({ api: undefined as unknown, must: undefined as unknown }));
vi.mock("../src/renderer/scripts/shared", () => ({
  initShell: () => ({ api: shared.api }),
  must: (selector: string) => (shared.must as (selector: string) => unknown)(selector),
}));

const signedIn: AccountState = {
  status: "signed_in", persistence: "encrypted",
  user: { id: "reader", email: "reader@example.invalid", displayName: "Reader", emailConfirmedAt: null, providers: ["email"] },
};
const signedOut: AccountState = { status: "signed_out", persistence: "encrypted", user: null };
const flush = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };

class Element extends EventTarget {
  hidden = false;
  disabled = false;
  value = "";
  type = "password";
  textContent = "";
  innerHTML = "";
  dataset: Record<string, string> = {};
  focus = vi.fn();
  classList = { toggle: vi.fn() };
  setAttribute = vi.fn();
  querySelectorAll = () => [];
  querySelector = () => null;
  reportValidity = () => true;
}

async function fixture({ embedded = true, search = "" }: { embedded?: boolean; search?: string } = {}) {
  vi.resetModules();
  const elements = new Map<string, Element>();
  const element = (selector: string) => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector)!;
  };
  const requests: Array<{ resolve: (state: IpcResult<AccountState>) => void; reject: (error: Error) => void }> = [];
  let emit = (_state: AccountState) => undefined as void;
  const getCurrent = vi.fn(async () => null);
  const auth = {
      getState: vi.fn(() => new Promise<IpcResult<AccountState>>((resolve, reject) => { requests.push({ resolve, reject }); })),
      onStateChanged: (handler: typeof emit) => { emit = handler; return () => undefined; },
      signIn: vi.fn(async (): Promise<IpcResult<AccountState>> => ({ ok: true, data: signedIn })),
      updatePassword: vi.fn(async (): Promise<IpcResult<AccountState>> => ({ ok: true, data: signedIn })),
      signOut: vi.fn(async (): Promise<IpcResult<AccountState>> => ({ ok: true, data: signedOut })),
      requestPasswordReset: vi.fn(async () => ({ ok: true, data: undefined })),
      verifyCode: vi.fn(async (): Promise<IpcResult<AccountState>> => ({ ok: true, data: { ...signedIn, status: "password_recovery" } })),
  };
  shared.api = {
    auth,
    project: { getCurrent },
  };
  shared.must = element;
  const replace = vi.fn();
  vi.stubGlobal("location", { search, replace });
  vi.stubGlobal("window", { setInterval: vi.fn() });
  const modeButtons = ["SignIn", "SignUp", "Reset"].map((name) => {
    const button = element(`#account${name}Link`);
    button.dataset.accountMode = name.toLowerCase();
    return button;
  });
  vi.stubGlobal("document", { querySelectorAll: (selector: string) => selector === "[data-account-mode]" ? modeButtons : [] });
  let controller: { deactivate(): void } | null = null;
  if (embedded) {
    const { mountAccount } = await import("../src/renderer/scripts/account-ui");
    controller = mountAccount(shared.api as MunhaeApi, { embedded });
  } else await import("../src/renderer/scripts/account");
  return { element, requests, emit: (state: AccountState) => emit(state), replace, getCurrent, auth, controller };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("account page initial-state ordering", () => {
  it("does not restore an old signed-in snapshot after a newer logout event", async () => {
    const f = await fixture();
    f.emit(signedOut);
    f.requests[0]!.resolve({ ok: true, data: signedIn });
    await flush();
    expect(f.element("#accountTitle").textContent).toBe("다시 만나 반갑습니다");
    expect(f.element("#accountBack").hidden).toBe(true);
    expect(f.getCurrent).not.toHaveBeenCalled();
    expect(f.replace).not.toHaveBeenCalled();
  });

  it("preserves entered passwords when a signed-in event and an old initial snapshot arrive", async () => {
    const f = await fixture();
    f.emit(signedIn);
    f.element("#accountChangePassword").dispatchEvent(new Event("click"));
    f.element("#accountPassword").value = "new-password-in-progress";
    f.element("#accountCurrentPassword").value = "current-password-in-progress";
    f.emit({ ...signedIn, user: { ...signedIn.user!, displayName: "Updated profile" } });
    f.requests[0]!.resolve({ ok: true, data: signedIn });
    await flush();
    expect(f.element("#accountTitle").textContent).toBe("새 비밀번호 설정");
    expect(f.element("#accountPassword").value).toBe("new-password-in-progress");
    expect(f.element("#accountCurrentPassword").value).toBe("current-password-in-progress");
    expect(f.element("#accountForm").hidden).toBe(false);
  });

  it("ignores a stale initial error after an account event has already supplied state", async () => {
    const f = await fixture();
    f.emit(signedIn);
    f.requests[0]!.reject(new Error("old connection error"));
    await flush();
    expect(f.element("#accountTitle").textContent).toBe("계정");
    expect(f.element("#accountRetry").hidden).toBe(true);
    expect(f.element("#accountStatus").hidden).toBe(true);
  });

  it("lets a newer retry win over an earlier unresolved read", async () => {
    const f = await fixture();
    f.element("#accountRetry").dispatchEvent(new Event("click"));
    f.requests[1]!.resolve({ ok: true, data: signedIn });
    await flush();
    f.requests[0]!.resolve({ ok: true, data: signedOut });
    await flush();
    expect(f.element("#accountTitle").textContent).toBe("계정");
    expect(f.element("#accountBack").hidden).toBe(true);
  });
});

describe("standalone authentication and Settings account integration", () => {
  it("redirects an already signed-in direct account visit to Settings", async () => {
    const f = await fixture({ embedded: false });
    f.requests[0]!.resolve({ ok: true, data: signedIn });
    await flush();
    expect(f.replace).toHaveBeenCalledExactlyOnceWith("settings.html#account");
    expect(f.getCurrent).not.toHaveBeenCalled();
  });

  it.each(["account", "skills"])("preserves Settings %s after signing in without a project", async (section) => {
    const f = await fixture({ embedded: false, search: `?next=settings.html%23${section}` });
    f.requests[0]!.resolve({ ok: true, data: signedOut });
    await flush();
    expect(f.replace).not.toHaveBeenCalled();
    f.element("#accountEmail").value = "reader@example.invalid";
    f.element("#accountPassword").value = "password";
    f.element("#accountForm").dispatchEvent(new Event("submit"));
    await flush();
    expect(f.auth.signIn).toHaveBeenCalledWith({ email: "reader@example.invalid", password: "password" });
    expect(f.replace).toHaveBeenCalledExactlyOnceWith(`settings.html#${section}`);
    expect(f.getCurrent).not.toHaveBeenCalled();
  });

  it("preserves the original document destination after authentication", async () => {
    const f = await fixture({ embedded: false, search: "?next=editor.html%3Fdoc%3Dsource-document" });
    f.getCurrent.mockResolvedValueOnce({ path: "/project" } as never);
    f.requests[0]!.resolve({ ok: true, data: signedIn });
    await flush();
    expect(f.replace).toHaveBeenCalledExactlyOnceWith("editor.html?doc=source-document");
  });

  it("does not navigate using a stale project result after logout", async () => {
    const f = await fixture({ embedded: false, search: "?next=editor.html%3Fdoc%3Dsource-document" });
    let finish!: (value: null) => void;
    f.getCurrent.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    f.requests[0]!.resolve({ ok: true, data: signedIn });
    await flush();
    f.emit(signedOut);
    finish(null);
    await flush();
    expect(f.replace).not.toHaveBeenCalled();
    expect(f.element("#accountTitle").textContent).toBe("다시 만나 반갑습니다");
  });

  it("keeps embedded profile controls local and sends the current password when changing it", async () => {
    const f = await fixture();
    f.requests[0]!.resolve({ ok: true, data: signedIn });
    await flush();
    expect(f.element("#accountTitle").textContent).toBe("계정");
    expect(f.element("#accountBack").hidden).toBe(true);
    expect(f.element("#accountContinue").hidden).toBe(true);
    f.element("#accountChangePassword").dispatchEvent(new Event("click"));
    expect(f.element("#accountCurrentPasswordField").hidden).toBe(false);
    f.element("#accountCurrentPassword").value = "old-password";
    f.element("#accountPassword").value = "new-password";
    f.element("#accountPasswordConfirm").value = "new-password";
    f.element("#accountForm").dispatchEvent(new Event("submit"));
    await flush();
    expect(f.auth.updatePassword).toHaveBeenCalledExactlyOnceWith({ password: "new-password", currentPassword: "old-password" });
    expect(f.element("#accountTitle").textContent).toBe("계정");
    expect(f.element("#accountStatus").textContent).toBe("비밀번호를 변경했습니다.");
    expect(f.element("#accountPassword").value).toBe("");
    expect(f.replace).not.toHaveBeenCalled();
  });

  it("clears password drafts and returns to the profile when leaving the account section", async () => {
    const f = await fixture();
    f.emit(signedIn);
    f.element("#accountChangePassword").dispatchEvent(new Event("click"));
    for (const selector of ["#accountPassword", "#accountPasswordConfirm", "#accountCurrentPassword", "#accountCode"]) f.element(selector).value = "secret";
    f.element("#accountTogglePassword").dispatchEvent(new Event("click"));
    f.controller!.deactivate();
    for (const selector of ["#accountPassword", "#accountPasswordConfirm", "#accountCurrentPassword", "#accountCode"]) expect(f.element(selector).value).toBe("");
    expect(f.element("#accountPassword").type).toBe("password");
    expect(f.element("#accountTitle").textContent).toBe("계정");
    expect(f.element("#accountProfile").hidden).toBe(false);
    expect(f.auth.updatePassword).not.toHaveBeenCalled();
  });

  it("clears hidden secrets without cancelling an in-flight password change", async () => {
    const f = await fixture();
    f.emit(signedIn);
    let finish!: (result: IpcResult<AccountState>) => void;
    f.auth.updatePassword.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    f.element("#accountChangePassword").dispatchEvent(new Event("click"));
    f.element("#accountCurrentPassword").value = "old-password";
    f.element("#accountPassword").value = "new-password";
    f.element("#accountPasswordConfirm").value = "new-password";
    f.element("#accountForm").dispatchEvent(new Event("submit"));
    f.controller!.deactivate();
    expect(f.element("#accountPassword").value).toBe("");
    expect(f.element("#accountCurrentPassword").value).toBe("");
    expect(f.element("#accountSubmit").disabled).toBe(true);
    expect(f.auth.updatePassword).toHaveBeenCalledExactlyOnceWith({ password: "new-password", currentPassword: "old-password" });
    finish({ ok: true, data: signedIn });
    await flush();
    expect(f.element("#accountTitle").textContent).toBe("계정");
    expect(f.element("#accountStatus").textContent).toBe("비밀번호를 변경했습니다.");
    expect(f.element("#accountSubmit").disabled).toBe(false);
    expect(f.replace).not.toHaveBeenCalled();
  });

  it("keeps recovery in the standalone page until the replacement password succeeds", async () => {
    const f = await fixture({ embedded: false, search: "?next=settings.html%23account" });
    f.requests[0]!.resolve({ ok: true, data: signedOut });
    await flush();
    f.element("#accountResetLink").dispatchEvent(new Event("click"));
    f.element("#accountEmail").value = "reader@example.invalid";
    f.element("#accountForm").dispatchEvent(new Event("submit"));
    await flush();
    expect(f.auth.requestPasswordReset).toHaveBeenCalledWith("reader@example.invalid");
    f.element("#accountCode").value = "12345678";
    f.element("#accountForm").dispatchEvent(new Event("submit"));
    await flush();
    expect(f.auth.verifyCode).toHaveBeenCalledWith({ email: "reader@example.invalid", code: "12345678", purpose: "recovery" });
    expect(f.element("#accountCurrentPasswordField").hidden).toBe(true);
    expect(f.element("#accountTitle").textContent).toBe("새 비밀번호 설정");
    expect(f.replace).not.toHaveBeenCalled();
    f.auth.updatePassword.mockResolvedValueOnce({ ok: false, error: { code: "weak_password", message: "다른 비밀번호를 입력하세요." } });
    f.element("#accountPassword").value = "new-password";
    f.element("#accountPasswordConfirm").value = "new-password";
    f.element("#accountForm").dispatchEvent(new Event("submit"));
    await flush();
    expect(f.auth.updatePassword).toHaveBeenCalledWith({ password: "new-password" });
    expect(f.replace).not.toHaveBeenCalled();
    expect(f.element("#accountTitle").textContent).toBe("새 비밀번호 설정");
    f.element("#accountPassword").value = "replacement-password";
    f.element("#accountPasswordConfirm").value = "replacement-password";
    f.element("#accountForm").dispatchEvent(new Event("submit"));
    await flush();
    expect(f.replace).toHaveBeenCalledExactlyOnceWith("settings.html#account");
  });

  it("signs out a recovery session when returning to sign-in", async () => {
    const f = await fixture({ embedded: false });
    f.requests[0]!.resolve({ ok: true, data: { ...signedIn, status: "password_recovery" } });
    await flush();
    f.element("#accountSignInLink").dispatchEvent(new Event("click"));
    await flush();
    expect(f.auth.signOut).toHaveBeenCalledOnce();
    expect(f.element("#accountTitle").textContent).toBe("다시 만나 반갑습니다");
    expect(f.replace).not.toHaveBeenCalled();
  });
});
