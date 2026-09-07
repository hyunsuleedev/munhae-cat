import { describe, expect, it, vi } from "vitest";
import { createQuitHandler } from "../src/main/quit-lifecycle";

function dependencies() {
  return {
    prepare: vi.fn(async () => true),
    shutdown: vi.fn(async () => {}),
    quit: vi.fn(),
    onError: vi.fn(),
  };
}

describe("application quit preserves the live editing session", () => {
  it("leaves services live after a renderer veto and allows a later approved quit", async () => {
    const deps = dependencies();
    deps.prepare.mockResolvedValueOnce(false);
    const handle = createQuitHandler(deps);
    const first = { preventDefault: vi.fn() };
    await handle(first);
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(deps.shutdown).not.toHaveBeenCalled();
    expect(deps.quit).not.toHaveBeenCalled();

    await handle({ preventDefault: vi.fn() });
    expect(deps.prepare).toHaveBeenCalledTimes(2);
    expect(deps.shutdown).toHaveBeenCalledOnce();
    expect(deps.quit).toHaveBeenCalledOnce();
    const finalQuit = { preventDefault: vi.fn() };
    await handle(finalQuit);
    expect(finalQuit.preventDefault).not.toHaveBeenCalled();
    expect(deps.shutdown).toHaveBeenCalledOnce();
  });

  it("does not start cleanup or another dialog while leave approval is pending", async () => {
    const deps = dependencies();
    let decide!: (approved: boolean) => void;
    deps.prepare.mockImplementationOnce(() => new Promise<boolean>(resolve => { decide = resolve; }));
    const handle = createQuitHandler(deps);
    const pending = handle({ preventDefault: vi.fn() });
    const repeat = { preventDefault: vi.fn() };
    await handle(repeat);
    expect(repeat.preventDefault).toHaveBeenCalledOnce();
    expect(deps.prepare).toHaveBeenCalledOnce();
    expect(deps.shutdown).not.toHaveBeenCalled();
    decide(true);
    await pending;
    expect(deps.shutdown).toHaveBeenCalledOnce();
  });

  it("blocks repeated quit while cleanup is running and allows only the completed final quit", async () => {
    const deps = dependencies();
    let complete!: () => void;
    deps.shutdown.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
    const handle = createQuitHandler(deps);
    const pending = handle({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(deps.shutdown).toHaveBeenCalledOnce());
    const repeat = { preventDefault: vi.fn() };
    await handle(repeat);
    expect(repeat.preventDefault).toHaveBeenCalledOnce();
    expect(deps.quit).not.toHaveBeenCalled();
    complete();
    await pending;
    expect(deps.quit).toHaveBeenCalledOnce();
  });

  it("reports preflight or cleanup failures and permits retry instead of leaving quit stuck", async () => {
    const deps = dependencies();
    deps.prepare.mockRejectedValueOnce(new Error("navigation failed"));
    deps.shutdown.mockRejectedValueOnce(new Error("runtime shutdown failed"));
    const handle = createQuitHandler(deps);
    await handle({ preventDefault: vi.fn() });
    expect(deps.shutdown).not.toHaveBeenCalled();
    await handle({ preventDefault: vi.fn() });
    expect(deps.quit).not.toHaveBeenCalled();
    expect(deps.onError).toHaveBeenCalledTimes(2);
    await handle({ preventDefault: vi.fn() });
    expect(deps.quit).toHaveBeenCalledOnce();
  });
});
