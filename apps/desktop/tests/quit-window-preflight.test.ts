import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const win = {
    isDestroyed: () => false,
    isVisible: () => true,
    once: vi.fn(),
    on: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    loadFile: vi.fn(async () => {}),
    loadURL: vi.fn(async () => {}),
    webContents: {
      session: {},
      on: vi.fn((name: string, listener: (...args: unknown[]) => void) => { listeners.set(name, listener); }),
      removeListener: vi.fn((name: string) => { listeners.delete(name); }),
    },
  };
  return { win, listeners, showMessageBoxSync: vi.fn(() => 0) };
});

vi.mock("electron", () => ({
  BrowserWindow: vi.fn(function () { return fixture.win; }),
  app: {},
  dialog: { showMessageBoxSync: fixture.showMessageBoxSync },
}));
vi.mock("../src/main/security", () => ({ isDev: () => false, lockSession: vi.fn() }));
vi.mock("../src/main/paths", () => ({ preloadScriptPath: () => "/preload.js", rendererIndexHtml: () => "/renderer/index.html" }));
vi.mock("../src/main/log", () => ({ log: { error: vi.fn() } }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fixture.listeners.clear();
  fixture.win.loadFile.mockImplementation(async () => {});
  fixture.win.loadURL.mockImplementation(async () => {});
  fixture.showMessageBoxSync.mockReturnValue(0);
});

async function openUnsavedWindow() {
  const module = await import("../src/main/window");
  module.createMainWindow();
  const leaveUnsavedPage = async () => {
    let overridden = false;
    fixture.listeners.get("will-prevent-unload")?.({ preventDefault: () => { overridden = true; } });
    if (!overridden) throw new Error("ERR_ABORTED: renderer preserved its unsaved draft");
  };
  fixture.win.loadFile.mockImplementation(leaveUnsavedPage);
  fixture.win.loadURL.mockImplementation(leaveUnsavedPage);
  return module;
}

describe("quit window preflight", () => {
  it("retains the visible editor when the user keeps unsaved changes", async () => {
    const module = await openUnsavedWindow();
    expect(await module.prepareMainWindowForQuit()).toBe(false);
    expect(fixture.win.hide).not.toHaveBeenCalled();
    expect(fixture.showMessageBoxSync).toHaveBeenCalledWith(fixture.win, expect.objectContaining({
      buttons: ["현재 화면에 머물기", "저장하지 않고 종료"], defaultId: 0, cancelId: 0,
    }));
    expect(fixture.listeners.has("will-prevent-unload")).toBe(true);
    expect(fixture.win.webContents.on.mock.calls.filter(([name]) => name === "will-prevent-unload")).toHaveLength(1);
  });

  it("overrides the unload veto only for approved discard, then hides an inert blank page before teardown", async () => {
    const module = await openUnsavedWindow();
    fixture.showMessageBoxSync.mockReturnValue(1);
    expect(await module.prepareMainWindowForQuit()).toBe(true);
    expect(fixture.win.loadURL).toHaveBeenLastCalledWith("about:blank");
    expect(fixture.win.loadFile).toHaveBeenCalledTimes(1);
    expect(fixture.win.loadFile).toHaveBeenLastCalledWith("/renderer/index.html");
    expect(fixture.win.hide).toHaveBeenCalledOnce();
    expect(fixture.listeners.has("will-prevent-unload")).toBe(true);
  });

  it("retains project-switch wording and does not hide the window for a project switch", async () => {
    const module = await openUnsavedWindow();
    fixture.showMessageBoxSync.mockReturnValue(1);
    expect(await module.prepareMainWindowForProjectSwitch()).toBe(true);
    expect(fixture.win.loadFile).toHaveBeenLastCalledWith("/renderer/home.html");
    expect(fixture.win.loadURL).not.toHaveBeenCalled();
    expect(fixture.showMessageBoxSync).toHaveBeenCalledWith(fixture.win, expect.objectContaining({
      buttons: ["현재 화면에 머물기", "저장하지 않고 프로젝트 열기"],
    }));
    expect(fixture.win.hide).not.toHaveBeenCalled();
  });

  it("accepts quit without a window or a discard dialog", async () => {
    const module = await import("../src/main/window");
    expect(await module.prepareMainWindowForQuit()).toBe(true);
    expect(fixture.showMessageBoxSync).not.toHaveBeenCalled();
  });

  it.each([0, 1])("prompts for ordinary window close/reload and honors the decision (%s)", async (response) => {
    const module = await import("../src/main/window");
    module.createMainWindow();
    fixture.showMessageBoxSync.mockReturnValue(response);
    const event = { preventDefault: vi.fn() };
    fixture.listeners.get("will-prevent-unload")?.(event);
    expect(fixture.showMessageBoxSync).toHaveBeenCalledOnce();
    expect(fixture.showMessageBoxSync).toHaveBeenCalledWith(fixture.win, expect.objectContaining({
      buttons: ["현재 화면에 머물기", "저장하지 않고 계속"], defaultId: 0, cancelId: 0,
    }));
    expect(event.preventDefault).toHaveBeenCalledTimes(response === 1 ? 1 : 0);
  });

  it("returns to the ordinary prompt after a cancelled quit without installing a duplicate handler", async () => {
    const module = await openUnsavedWindow();
    expect(await module.prepareMainWindowForQuit()).toBe(false);
    fixture.showMessageBoxSync.mockClear();
    fixture.listeners.get("will-prevent-unload")?.({ preventDefault: vi.fn() });
    expect(fixture.showMessageBoxSync).toHaveBeenCalledOnce();
    expect(fixture.showMessageBoxSync).toHaveBeenCalledWith(fixture.win, expect.objectContaining({
      buttons: ["현재 화면에 머물기", "저장하지 않고 계속"],
    }));
    expect(fixture.win.webContents.on.mock.calls.filter(([name]) => name === "will-prevent-unload")).toHaveLength(1);
  });
});
