import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>() }));
vi.mock("electron", () => ({ ipcMain: {
  handle: (channel: string, callback: (...args: any[]) => any) => f.handlers.set(channel, callback),
  removeHandler: (channel: string) => f.handlers.delete(channel),
} }));
vi.mock("../src/main/security", () => ({ isAllowedNavigation: (url: string) => url.startsWith("file:///renderer/") }));
vi.mock("../src/main/log", () => ({ log: { error: vi.fn() } }));
import { installStartup } from "../src/main/startup";
import { STARTUP_CHANNELS } from "../src/shared/startup-api";

beforeEach(() => { vi.useFakeTimers(); f.handlers.clear(); });
afterEach(() => { vi.useRealTimers(); });

function setup() {
  const frame = { url: "file:///renderer/splash.html" };
  const contents = { mainFrame: frame };
  const win = { isDestroyed: () => false, webContents: contents };
  const show = vi.fn(async (_page: string) => {});
  const control = installStartup({ getWindow: () => win as never, enter: show });
  const event = { sender: contents, senderFrame: frame };
  return { control, event, frame, show, win,
    wait: () => f.handlers.get(STARTUP_CHANNELS.wait)!(event),
    enter: () => f.handlers.get(STARTUP_CHANNELS.enter)!(event),
  };
}

describe("native splash startup", () => {
  it("holds entry until initialization succeeds and preserves the native destination", async () => {
    const s = setup();
    const ready = vi.fn();
    void s.wait().then(ready);
    const entering = s.enter();
    await Promise.resolve();
    expect(ready).not.toHaveBeenCalled(); expect(s.show).not.toHaveBeenCalled();
    s.control.ready("home.html");
    await entering;
    expect(ready).toHaveBeenCalledWith({ ok: true });
    expect(s.show).toHaveBeenCalledExactlyOnceWith("home.html");
    expect(f.handlers.size).toBe(0);
  });

  it("coalesces repeated completion requests into a single navigation", async () => {
    const s = setup();
    const first = s.enter(), second = s.enter();
    s.control.ready("index.html");
    await Promise.all([first, second]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(s.show).toHaveBeenCalledExactlyOnceWith("index.html");
  });

  it("shows an initialization failure without navigating to a partly initialized workspace", async () => {
    const s = setup();
    const waiting = s.wait(); const entering = s.enter();
    s.control.fail();
    expect(await waiting).toEqual({ ok: false, message: expect.stringContaining("시작하지 못했습니다") });
    await entering; await vi.advanceTimersByTimeAsync(30_000);
    expect(s.show).not.toHaveBeenCalled();
    s.control.dispose();
  });

  it("never bypasses splash completion even when initialization finished long ago", async () => {
    const s = setup();
    s.control.ready("index.html");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.show).not.toHaveBeenCalled();
    await s.enter();
    expect(s.show).toHaveBeenCalledExactlyOnceWith("index.html");
  });

  it("cancels pending startup when the window closes or the app quits", async () => {
    const s = setup(); const waiting = s.wait();
    s.control.dispose(); s.control.ready("home.html");
    expect(await waiting).toEqual({ ok: false, message: "시작이 취소되었습니다." });
    await vi.advanceTimersByTimeAsync(30_000); expect(s.show).not.toHaveBeenCalled();
    expect(f.handlers.size).toBe(0);
  });

  it("rejects other windows, subframes, and ordinary app pages", () => {
    const s = setup(); const handler = f.handlers.get(STARTUP_CHANNELS.wait)!;
    expect(() => handler({ ...s.event, sender: {} })).toThrow();
    expect(() => handler({ ...s.event, senderFrame: { ...s.frame } })).toThrow();
    s.frame.url = "file:///renderer/editor.html";
    expect(() => handler(s.event)).toThrow();
    s.frame.url = "https://example.com/splash.html";
    expect(() => handler(s.event)).toThrow();
    s.control.dispose();
  });
});
