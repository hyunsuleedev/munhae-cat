import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DURATION } from "../src/renderer/splash/calligraphy";
import type { StartupState } from "../src/shared/startup-api";

const scene = vi.hoisted(() => ({ render: vi.fn(), dispose: vi.fn(), create: vi.fn() }));
vi.mock("../src/renderer/splash/book", () => ({ createBookScene: scene.create }));

function element() {
  const classes = new Set<string>();
  return Object.assign(new EventTarget(), {
    hidden: false, disabled: false, style: {}, textContent: "",
    classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) },
  });
}

let resolveReady: (state: StartupState) => void;
let enter: ReturnType<typeof vi.fn>;
let elements: Map<string, ReturnType<typeof element>>;
let frames: Map<number, FrameRequestCallback>;
let media: EventTarget & { matches: boolean };
let page: EventTarget & { hidden: boolean };
let frameId: number;

beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers();
  scene.render.mockReset(); scene.dispose.mockReset();
  scene.create.mockReset().mockResolvedValue(scene);
  elements = new Map(["splashScene", "splashFallback", "splashIdentity", "startup", "splashStatus", "splashContinue"]
    .map(id => [id, element()]));
  elements.get("splashContinue")!.hidden = true;
  frames = new Map(); frameId = 0;
  media = Object.assign(new EventTarget(), { matches: false });
  page = Object.assign(new EventTarget(), { hidden: false, getElementById: (id: string) => elements.get(id) });
  enter = vi.fn().mockResolvedValue(undefined);
  const pending = new Promise<StartupState>(resolve => { resolveReady = resolve; });
  vi.stubGlobal("window", Object.assign(new EventTarget(), { munhaeStartup: { wait: () => pending, enter } }));
  vi.stubGlobal("document", page);
  vi.stubGlobal("matchMedia", () => media);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { frames.set(++frameId, cb); return frameId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function start() {
  await import("../src/renderer/splash/startup");
  await vi.dynamicImportSettled();
}
function animate(until: number) {
  for (let now = 16; now <= until; now += 16) {
    const callbacks = [...frames.values()]; frames.clear();
    callbacks.forEach(cb => cb(now));
  }
}
async function ready() {
  resolveReady({ ok: true });
  await Promise.resolve();
}

describe("splash completion before screen entry", () => {
  it("finishes every animation frame even when native startup is already ready", async () => {
    await start(); await ready();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(enter).not.toHaveBeenCalled();
    expect(elements.get("splashContinue")!.hidden).toBe(true);
    elements.get("splashContinue")!.dispatchEvent(new Event("click"));
    await vi.advanceTimersByTimeAsync(220);
    expect(enter).not.toHaveBeenCalled();
    animate((DURATION + .1) * 1000);
    expect(scene.render).toHaveBeenLastCalledWith(DURATION);
    await vi.advanceTimersByTimeAsync(219);
    expect(enter).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(enter).toHaveBeenCalledOnce();
    expect(scene.dispose).toHaveBeenCalledOnce();
  });

  it("holds the completed scene until background loading finishes", async () => {
    await start(); animate((DURATION + .1) * 1000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(enter).not.toHaveBeenCalled();
    expect(scene.dispose).not.toHaveBeenCalled();
    await ready(); await vi.advanceTimersByTimeAsync(220);
    expect(enter).toHaveBeenCalledOnce();
  });

  it("does not count time in a hidden window as animation completion", async () => {
    await start(); await ready();
    page.hidden = true; page.dispatchEvent(new Event("visibilitychange"));
    animate(30_000); await vi.advanceTimersByTimeAsync(30_000);
    expect(enter).not.toHaveBeenCalled();
    page.hidden = false; page.dispatchEvent(new Event("visibilitychange"));
    animate((DURATION + .1) * 1000); await vi.advanceTimersByTimeAsync(220);
    expect(enter).toHaveBeenCalledOnce();
  });

  it("uses a static completed splash for reduced motion but still waits for loading", async () => {
    media.matches = true;
    await start(); await vi.advanceTimersByTimeAsync(30_000);
    expect(scene.create).not.toHaveBeenCalled(); expect(enter).not.toHaveBeenCalled();
    await ready(); await vi.advanceTimersByTimeAsync(0);
    expect(enter).toHaveBeenCalledOnce();
  });

  it("can complete through the static fallback after WebGL fails", async () => {
    scene.create.mockRejectedValueOnce(new Error("WebGL unavailable"));
    await start(); await ready(); await vi.advanceTimersByTimeAsync(220);
    expect(elements.get("splashFallback")!.hidden).toBe(false);
    expect(enter).toHaveBeenCalledOnce();
  });

  it("never enters after native initialization fails", async () => {
    await start();
    resolveReady({ ok: false, message: "초기화 실패" });
    await Promise.resolve(); animate(30_000); await vi.advanceTimersByTimeAsync(30_000);
    expect(enter).not.toHaveBeenCalled();
    expect(elements.get("splashStatus")!.textContent).toBe("초기화 실패");
  });

  it("offers an explicit retry after a failed navigation without an automatic retry loop", async () => {
    enter.mockRejectedValueOnce(new Error("load failed"));
    await start(); await ready(); animate((DURATION + .1) * 1000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(enter).toHaveBeenCalledOnce();
    expect(elements.get("splashContinue")!.hidden).toBe(false);
    elements.get("splashContinue")!.dispatchEvent(new Event("click"));
    await vi.advanceTimersByTimeAsync(220);
    expect(enter).toHaveBeenCalledTimes(2);
  });
});
