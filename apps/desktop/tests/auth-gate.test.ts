import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AccountState, IpcResult, MunhaeApi } from "../src/shared/munhae-api";
import { accountGateUrl, AuthGate, safeAccountReturn } from "../src/renderer/scripts/auth-gate";

function state(status: AccountState["status"]): AccountState {
  return { status, user: status === "signed_out" ? null : { id: "reader", email: "reader@example.com", displayName: "Reader", emailConfirmedAt: "2026-09-01", providers: ["email"] }, persistence: "encrypted" };
}
function fixture(status: AccountState["status"] = "signed_in") {
  let listener: (state: AccountState) => void = () => undefined;
  const getState = vi.fn(async (): Promise<IpcResult<AccountState>> => ({ ok: true, data: state(status) }));
  const unsubscribe = vi.fn();
  const auth = { getState, onStateChanged: (cb: typeof listener) => { listener = cb; return unsubscribe; } } as MunhaeApi["auth"];
  const view = { load: vi.fn(async () => undefined), reveal: vi.fn(), requireAccount: vi.fn(), failed: vi.fn() };
  return { gate: new AuthGate(auth, view), getState, view, unsubscribe, emit: (next: AccountState["status"]) => listener(state(next)) };
}

describe("global authentication gate", () => {
  it.each(["signed_out", "password_recovery"] as const)("never loads protected page code for %s", async (status) => {
    const f = fixture(status);
    await f.gate.start();
    expect(f.view.load).not.toHaveBeenCalled();
    expect(f.view.reveal).not.toHaveBeenCalled();
    expect(f.view.requireAccount).toHaveBeenCalledOnce();
  });
  it("waits for verification before loading and reveals only after initialization", async () => {
    const f = fixture();
    let verify!: (value: IpcResult<AccountState>) => void;
    f.getState.mockImplementationOnce(() => new Promise((resolve) => { verify = resolve; }));
    const boot = f.gate.start();
    expect(f.view.load).not.toHaveBeenCalled();
    verify({ ok: true, data: state("signed_in") });
    await boot;
    expect(f.view.load).toHaveBeenCalledOnce();
    expect(f.view.reveal).toHaveBeenCalledOnce();
    await f.gate.check();
    expect(f.view.load).toHaveBeenCalledOnce();
  });
  it("blocks on network failure and retries without importing before validation", async () => {
    const f = fixture();
    f.getState.mockRejectedValueOnce(new Error("offline"));
    await f.gate.start();
    expect(f.view.failed).toHaveBeenCalledOnce();
    expect(f.view.load).not.toHaveBeenCalled();
    expect(f.view.requireAccount).not.toHaveBeenCalled();
    await f.gate.check();
    expect(f.view.load).toHaveBeenCalledOnce();
  });
  it("a logout during validation wins over a late signed-in result", async () => {
    const f = fixture();
    let verify!: (value: IpcResult<AccountState>) => void;
    f.getState.mockImplementationOnce(() => new Promise((resolve) => { verify = resolve; }));
    const boot = f.gate.start();
    f.emit("signed_out");
    verify({ ok: true, data: state("signed_in") });
    await boot;
    expect(f.view.load).not.toHaveBeenCalled();
    expect(f.view.reveal).not.toHaveBeenCalled();
    expect(f.view.requireAccount).toHaveBeenCalledOnce();
  });
  it("locks an already loaded page when its session ends", async () => {
    const f = fixture();
    await f.gate.start();
    f.emit("signed_out");
    expect(f.view.requireAccount).toHaveBeenCalledOnce();
    f.gate.dispose();
    f.emit("signed_out");
    expect(f.view.requireAccount).toHaveBeenCalledOnce();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });
  it("uses signed-in updates without fetching or remounting a loaded page", async () => {
    const f = fixture();
    await f.gate.start();
    f.emit("signed_in");
    f.emit("signed_in");
    await Promise.resolve();
    expect(f.getState).toHaveBeenCalledOnce();
    expect(f.view.load).toHaveBeenCalledOnce();
    expect(f.view.reveal).toHaveBeenCalledOnce();
    expect(f.view.requireAccount).not.toHaveBeenCalled();
  });
  it("recovers from a failed startup using a main-process event without another lookup", async () => {
    const f = fixture();
    f.getState.mockRejectedValueOnce(new Error("offline"));
    await f.gate.start();
    f.emit("signed_in");
    await vi.waitFor(() => expect(f.view.reveal).toHaveBeenCalledOnce());
    expect(f.getState).toHaveBeenCalledOnce();
    expect(f.view.load).toHaveBeenCalledOnce();
  });
  it("does not let a delayed signed-out snapshot overwrite a newer sign-in event", async () => {
    const f = fixture();
    let reply!: (value: IpcResult<AccountState>) => void;
    f.getState.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
    const boot = f.gate.start();
    f.emit("signed_in");
    reply({ ok: true, data: state("signed_out") });
    await boot;
    await vi.waitFor(() => expect(f.view.reveal).toHaveBeenCalledOnce());
    expect(f.view.requireAccount).not.toHaveBeenCalled();
  });
  it("shares page initialization across token updates and lets logout win", async () => {
    const f = fixture();
    let finish!: () => void;
    f.view.load.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const boot = f.gate.start();
    await vi.waitFor(() => expect(f.view.load).toHaveBeenCalledOnce());
    f.emit("signed_in");
    f.emit("signed_out");
    finish();
    await boot;
    expect(f.view.load).toHaveBeenCalledOnce();
    expect(f.view.reveal).not.toHaveBeenCalled();
    expect(f.view.requireAccount).toHaveBeenCalledOnce();
  });
  it("can reveal an initialized page after a BFCache snapshot check", async () => {
    const f = fixture();
    await f.gate.start();
    await f.gate.check();
    expect(f.view.load).toHaveBeenCalledOnce();
    expect(f.view.reveal).toHaveBeenCalledTimes(2);
  });
  it.each(["index", "home", "editor", "context", "knowledge", "settings"])("%s cannot bypass the common entry or flash protected UI", (page) => {
    const html = readFileSync(resolve("src/renderer", `${page}.html`), "utf8");
    expect(html).toContain("<body data-auth-pending");
    expect(html.match(/<script[^>]+src="([^"]+)"/g)).toEqual([expect.stringContaining('src="./scripts/app-entry.ts"')]);
    expect(html.split("</head>")[0]).toContain('<script type="module" blocking="render" src="./scripts/app-entry.ts">');
  });
  it.each(["index", "home", "editor", "context", "knowledge", "settings"])("%s production entry installs navigation handling before first paint", (page) => {
    // The normal desktop test command builds first. Vite otherwise silently
    // strips blocking=render from the source entry, regressing only releases.
    const html = readFileSync(resolve("out/renderer", `${page}.html`), "utf8");
    const modules = html.split("</head>")[0].match(/<script\b[^>]*type="module"[^>]*>/g) ?? [];
    expect(modules.length).toBeGreaterThan(0);
    for (const module of modules) expect(module).toContain('blocking="render"');
  });
});

describe("account return routes", () => {
  it.each(["https://other.invalid/editor.html", "//other.invalid", "../editor.html", "account.html", "javascript:alert(1)", "editor.html#x", "editor.html\\x"])("rejects unsafe or looping route %s", (route) => {
    expect(safeAccountReturn(route)).toBeNull();
  });
  it("preserves only document navigation parameters", () => {
    expect(safeAccountReturn("editor.html?doc=abc&arbitrary=value")).toBe("editor.html?doc=abc");
    expect(safeAccountReturn("context.html?node=abc")).toBe("context.html?node=abc");
    expect(accountGateUrl("editor.html?doc=abc")).toBe("account.html?next=editor.html%3Fdoc%3Dabc");
  });
  it.each(["account", "models", "skills", "general"])("returns to the known Settings section %s", (section) => {
    expect(safeAccountReturn(`settings.html#${section}`)).toBe(`settings.html#${section}`);
    expect(safeAccountReturn(`settings.html?arbitrary=value#${section}`)).toBe(`settings.html#${section}`);
    expect(accountGateUrl(`settings.html#${section}`)).toBe(`account.html?next=settings.html%23${section}`);
  });
  it.each(["settings.html#", "settings.html#unknown", "settings.html#account#general", "settings.html#%61ccount", "settings.html#account?next=editor.html", "editor.html?doc=abc#account", "account.html#account"])("rejects unknown or misplaced Settings fragments %s", (route) => {
    expect(safeAccountReturn(route)).toBeNull();
  });
});
