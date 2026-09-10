import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MunhaeApi } from "../src/shared/munhae-api";
import { AuthGate } from "../src/renderer/scripts/auth-gate";
import { installPageTransition, PAGE_TRANSITION_TIMEOUT } from "../src/renderer/scripts/page-transition";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function transition() {
  const ready = deferred();
  const finished = deferred();
  return {
    ready, finished,
    view: { ready: ready.promise, finished: finished.promise, skipTransition: vi.fn() },
  };
}

function attributes(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    setAttribute: (name: string, value: string) => { values.set(name, value); },
    removeAttribute: (name: string) => { values.delete(name); },
    hasAttribute: (name: string) => values.has(name),
    values,
  };
}

function fixture() {
  const events = new EventTarget();
  const root = attributes();
  const body = attributes({ "data-auth-pending": "" });
  const showLoading = vi.fn();
  const target = Object.assign(events, {
    setTimeout: (callback: () => void, delay: number) => windowlessSetTimeout(callback, delay),
    clearTimeout: (id: ReturnType<typeof setTimeout> | undefined) => clearTimeout(id),
    location: { href: "http://localhost:5173/editor.html?doc=sample" },
    document: { body },
  });
  const controller = installPageTransition(target as unknown as Window, root as unknown as HTMLElement, showLoading);
  const dispatch = (name: string, view?: ReturnType<typeof transition>["view"] | null, url?: string) => {
    events.dispatchEvent(Object.assign(new Event(name), {
      viewTransition: view,
      activation: url ? { entry: { url } } : undefined,
    }));
  };
  return { root, body, showLoading, controller, dispatch };
}

// Resolve the global timer at call time so Vitest controls every scheduled callback.
function windowlessSetTimeout(callback: () => void, delay: number) {
  return setTimeout(callback, delay);
}

describe("authenticated page transition handoff", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("keeps the outgoing snapshot until page readiness, then releases it once", () => {
    const f = fixture();
    const t = transition();
    f.dispatch("pagereveal", t.view);
    vi.advanceTimersByTime(PAGE_TRANSITION_TIMEOUT - 1);
    expect(f.root.hasAttribute("data-page-transition-pending")).toBe(true);
    expect(t.view.skipTransition).not.toHaveBeenCalled();
    expect(f.showLoading).not.toHaveBeenCalled();
    f.controller.finish();
    f.controller.finish();
    expect(t.view.skipTransition).toHaveBeenCalledOnce();
    expect(f.root.hasAttribute("data-page-transition-pending")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.body.hasAttribute("data-auth-pending")).toBe(true);
  });

  it("does not start a hold when initialization finishes before pagereveal", () => {
    const f = fixture();
    const t = transition();
    f.controller.finish();
    f.dispatch("pagereveal", t.view);
    expect(t.view.skipTransition).toHaveBeenCalledOnce();
    expect(f.root.hasAttribute("data-page-transition-pending")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("yields to the loading UI on timeout without changing the authentication gate", () => {
    const f = fixture();
    const t = transition();
    f.root.setAttribute("data-auth-pending", "root-sentinel");
    const before = [...f.body.values];
    f.dispatch("pagereveal", t.view);
    vi.advanceTimersByTime(PAGE_TRANSITION_TIMEOUT);
    expect(f.showLoading).toHaveBeenCalledOnce();
    expect(t.view.skipTransition).toHaveBeenCalledOnce();
    expect(f.showLoading.mock.invocationCallOrder[0]).toBeLessThan(t.view.skipTransition.mock.invocationCallOrder[0]!);
    expect([...f.body.values]).toEqual(before);
    expect(f.root.values.get("data-auth-pending")).toBe("root-sentinel");
    expect(f.root.hasAttribute("data-page-transition-pending")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up a transition rejected before capture without overriding the auth gate", async () => {
    const f = fixture();
    const t = transition();
    f.dispatch("pagereveal", t.view);
    t.ready.reject(new Error("capture unavailable"));
    await Promise.resolve();
    expect(f.root.hasAttribute("data-page-transition-pending")).toBe(false);
    expect(f.body.hasAttribute("data-auth-pending")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(PAGE_TRANSITION_TIMEOUT);
    expect(f.showLoading).not.toHaveBeenCalled();
    expect(t.view.skipTransition).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)("cleans up when the browser %ss the active finished promise", async (settle) => {
    const f = fixture();
    const t = transition();
    f.dispatch("pagereveal", t.view);
    t.finished[settle]();
    await Promise.resolve();
    expect(f.root.hasAttribute("data-page-transition-pending")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.showLoading).not.toHaveBeenCalled();
  });

  it("ignores late completion and rejection from a previous navigation", async () => {
    const f = fixture();
    const first = transition();
    const next = transition();
    f.dispatch("pagereveal", first.view);
    f.controller.finish();
    f.controller.pending();
    f.dispatch("pagereveal", next.view);
    first.ready.reject(new Error("old capture cancelled"));
    first.finished.resolve();
    await Promise.resolve();
    expect(f.root.hasAttribute("data-page-transition-pending")).toBe(true);
    expect(next.view.skipTransition).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    f.controller.finish();
    expect(next.view.skipTransition).toHaveBeenCalledOnce();
  });

  it("replaces an unfinished capture without leaking its timer or clearing the new hold", async () => {
    const f = fixture();
    const first = transition();
    const next = transition();
    f.dispatch("pagereveal", first.view);
    vi.advanceTimersByTime(500);
    f.dispatch("pagereveal", next.view);
    expect(first.view.skipTransition).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    first.ready.reject(new Error("superseded"));
    first.finished.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(PAGE_TRANSITION_TIMEOUT - 500);
    expect(f.root.hasAttribute("data-page-transition-pending")).toBe(true);
    expect(f.showLoading).not.toHaveBeenCalled();
    f.controller.dispose();
    expect(next.view.skipTransition).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("can hold a BFCache activation after the prior page initialization settled", () => {
    const f = fixture();
    f.controller.finish();
    f.controller.pending();
    const restored = transition();
    f.dispatch("pagereveal", restored.view);
    expect(f.root.hasAttribute("data-page-transition-pending")).toBe(true);
    expect(restored.view.skipTransition).not.toHaveBeenCalled();
    f.controller.finish();
    expect(restored.view.skipTransition).toHaveBeenCalledOnce();
  });

  it.each(["account.html", "account.html?next=editor.html"])("does not retain work content when navigating to %s", (page) => {
    const f = fixture();
    f.body.removeAttribute("data-auth-pending");
    const outgoing = transition();
    f.dispatch("pageswap", outgoing.view, page);
    expect(outgoing.view.skipTransition).toHaveBeenCalledOnce();
  });

  it("suppresses an outgoing snapshot when authentication is pending or lost", () => {
    const f = fixture();
    const outgoing = transition();
    f.dispatch("pageswap", outgoing.view, "home.html");
    expect(outgoing.view.skipTransition).toHaveBeenCalledOnce();
  });

  it("allows authenticated app navigation but rejects a foreign origin with the same filename", () => {
    const f = fixture();
    f.body.removeAttribute("data-auth-pending");
    const owned = transition();
    const external = transition();
    f.dispatch("pageswap", owned.view, "http://localhost:5173/home.html");
    f.dispatch("pageswap", external.view, "https://external.example/editor.html");
    expect(owned.view.skipTransition).not.toHaveBeenCalled();
    expect(external.view.skipTransition).toHaveBeenCalledOnce();
  });

  it.each([
    "http://localhost:5173/foreign/editor.html",
    "http://reader@localhost:5173/editor.html",
    "https://localhost:5173/editor.html",
    "http://[invalid/editor.html",
  ])("does not retain a snapshot for a non-owned or invalid destination: %s", (url) => {
    const f = fixture();
    f.body.removeAttribute("data-auth-pending");
    const outgoing = transition();
    f.dispatch("pageswap", outgoing.view, url);
    expect(outgoing.view.skipTransition).toHaveBeenCalledOnce();
  });

  it.each(["auth", "load"])("releases the snapshot for a %s error without revealing protected content", async (failure) => {
    const f = fixture();
    const t = transition();
    f.dispatch("pagereveal", t.view);
    const error = new Error("화면을 불러오지 못했습니다.");
    const auth = {
      getState: vi.fn(async () => {
        if (failure === "auth") throw error;
        return { ok: true, data: { status: "signed_in" } };
      }),
      onStateChanged: () => () => undefined,
    } as unknown as MunhaeApi["auth"];
    const view = {
      load: vi.fn(async () => { throw error; }),
      reveal: vi.fn(() => { f.body.removeAttribute("data-auth-pending"); f.controller.finish(); }),
      requireAccount: vi.fn(() => f.controller.finish()),
      failed: vi.fn(() => f.controller.finish()),
    };
    const gate = new AuthGate(auth, view);
    await gate.start();
    expect(t.view.skipTransition).toHaveBeenCalledOnce();
    expect(f.body.hasAttribute("data-auth-pending")).toBe(true);
    expect(view.failed).toHaveBeenCalledWith(error);
    expect(view.reveal).not.toHaveBeenCalled();
    expect(view.load).toHaveBeenCalledTimes(failure === "load" ? 1 : 0);
    expect(f.showLoading).not.toHaveBeenCalled();
    gate.dispose();
  });

  it("disposes listeners and its timer even if browser promises settle later", async () => {
    const f = fixture();
    const t = transition();
    f.dispatch("pagereveal", t.view);
    f.controller.dispose();
    const later = transition();
    f.controller.pending();
    f.dispatch("pagereveal", later.view);
    f.dispatch("pageswap", later.view, "account.html");
    t.ready.reject(new Error("window left"));
    t.finished.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(PAGE_TRANSITION_TIMEOUT * 2);
    expect(t.view.skipTransition).toHaveBeenCalledOnce();
    expect(later.view.skipTransition).not.toHaveBeenCalled();
    expect(f.showLoading).not.toHaveBeenCalled();
    expect(f.root.hasAttribute("data-page-transition-pending")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves first visits and unsupported navigations to the ordinary auth gate", () => {
    const f = fixture();
    f.dispatch("pagereveal", null);
    f.dispatch("pageswap", undefined, "home.html");
    expect(f.root.hasAttribute("data-page-transition-pending")).toBe(false);
    expect(f.body.hasAttribute("data-auth-pending")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
