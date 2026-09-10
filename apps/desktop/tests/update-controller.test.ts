import { describe, expect, it, vi } from "vitest";
import { UpdateController } from "../src/main/update-controller";
import { createQuitHandler } from "../src/main/quit-lifecycle";
function setup() {
  const port = { check: vi.fn(async (): Promise<string | null> => "0.2.0"), download: vi.fn(async () => {}), install: vi.fn() };
  const busy = vi.fn(() => false);
  return { port, busy, controller: new UpdateController(port, busy, vi.fn()) };
}
describe("Windows update safety", () => {
  it("checks without downloading and downloads only on request", async () => {
    const { port, controller } = setup();
    await controller.check();
    expect(controller.state).toEqual({ phase: "available", version: "0.2.0" });
    expect(port.download).not.toHaveBeenCalled();
    await controller.download();
    expect(controller.state.phase).toBe("downloaded");
    expect(port.install).not.toHaveBeenCalled();
    expect(controller.finishQuit()).toBe(false);
  });
  it("does not allow install before download or while AI is active", async () => {
    const { busy, controller } = setup();
    expect(controller.requestInstall()).toBe(false);
    await controller.check(); await controller.download();
    busy.mockReturnValue(true);
    expect(controller.requestInstall()).toBe(false);
    busy.mockReturnValue(false);
    expect(controller.requestInstall()).toBe(true);
    busy.mockReturnValue(true);
    expect(controller.canQuitForInstall()).toBe(false);
  });
  it("preserves services on unsaved-work veto and does not install on a later ordinary quit", async () => {
    const { port, controller } = setup();
    await controller.check(); await controller.download(); controller.requestInstall();
    const leave = vi.fn(async () => false);
    const shutdown = vi.fn(async () => {});
    const quit = vi.fn();
    const handler = createQuitHandler({
      prepare: async () => { const ok = await leave(); if (!ok) controller.cancelInstall(); return ok; },
      shutdown, quit: () => { if (!controller.finishQuit()) quit(); }, onError: vi.fn(),
    });
    await handler({ preventDefault: vi.fn() });
    expect(shutdown).not.toHaveBeenCalled(); expect(port.install).not.toHaveBeenCalled();
    leave.mockResolvedValue(true);
    await handler({ preventDefault: vi.fn() });
    expect(quit).toHaveBeenCalledOnce(); expect(port.install).not.toHaveBeenCalled();
  });
  it("waits for shutdown before installing exactly once", async () => {
    const { port, controller } = setup();
    await controller.check(); await controller.download(); controller.requestInstall();
    let finish!: () => void;
    const shutdown = new Promise<void>(resolve => { finish = resolve; });
    const handler = createQuitHandler({ prepare: async () => true, shutdown: () => shutdown,
      quit: () => { controller.finishQuit(); }, onError: vi.fn() });
    const quitting = handler({ preventDefault: vi.fn() });
    await Promise.resolve();
    expect(port.install).not.toHaveBeenCalled();
    finish(); await quitting;
    expect(port.install).toHaveBeenCalledOnce();
    expect(controller.finishQuit()).toBe(false);
  });
  it("deduplicates requests and recovers from download failures", async () => {
    const { port, controller } = setup();
    let resolve!: (v: string) => void;
    port.check.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const first = controller.check(); await controller.check();
    expect(port.check).toHaveBeenCalledOnce(); resolve("0.2.0"); await first;
    port.download.mockRejectedValueOnce(new Error("hash mismatch"));
    await expect(controller.download()).rejects.toThrow("hash mismatch");
    expect(controller.requestInstall()).toBe(false);
    await controller.check(); await controller.download();
    expect(controller.state.phase).toBe("downloaded");
  });
  it("retains a downloaded update and bounds progress", async () => {
    const { port, controller } = setup();
    await controller.check();
    let complete!: () => void;
    port.download.mockImplementationOnce(() => new Promise(r => { complete = r; }));
    const download = controller.download();
    controller.progress(150); expect(controller.state.percent).toBe(100);
    controller.progress(NaN); expect(controller.state.percent).toBe(100);
    complete(); await download;
    await controller.check(); expect(port.check).toHaveBeenCalledOnce();
  });
});
