import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";

const mock = vi.hoisted(() => {
  const contents = { on: vi.fn(), send: vi.fn() };
  return {
    contents, win: { webContents: contents, setMenuBarVisibility: vi.fn() },
    popup: vi.fn(), build: vi.fn(), set: vi.fn(), appOn: vi.fn(),
  };
});
vi.mock("electron", () => ({
  app: { name: "Munhae Studio", setAboutPanelOptions: vi.fn(), getVersion: () => "0.1.0", on: mock.appOn },
  webContents: { getAllWebContents: () => [mock.contents] },
  Menu: { buildFromTemplate: mock.build, setApplicationMenu: mock.set },
}));
vi.mock("../src/main/window", () => ({ getMainWindow: () => mock.win }));
import { installApplicationMenu } from "../src/main/menu";

function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap(item => [item, ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])]);
}
beforeEach(() => { mock.build.mockClear(); mock.popup.mockClear(); mock.contents.send.mockClear(); mock.build.mockImplementation(template => ({ template, popup: mock.popup })); });

describe("sidebar replaces application menus without losing native editing", () => {
  it("removes the task menus while retaining hidden editing and project shortcuts", () => {
    installApplicationMenu("ko");
    const template = mock.build.mock.calls[0]![0] as MenuItemConstructorOptions[];
    expect(template.filter(item => item.visible !== false).map(item => item.label)).toEqual(process.platform === "darwin" ? ["Munhae Studio"] : []);
    const items = flatten(template);
    for (const role of ["undo", "redo", "cut", "copy", "paste", "selectAll"]) {
      expect(items.find(item => item.role === role)).toMatchObject({ visible: false, acceleratorWorksWhenHidden: true });
    }
    for (const id of ["newdoc", "open", "close", "export", "find", "sidebar", "palette", "confirm"]) {
      expect(items.find(item => item.id === id)).toMatchObject({ visible: false, acceleratorWorksWhenHidden: true, accelerator: expect.any(String) });
    }
  });
  it("dispatches hidden shortcuts through the existing renderer transition handler", () => {
    installApplicationMenu();
    const items = flatten(mock.build.mock.calls[0]![0]);
    const open = items.find(item => item.id === "open")!;
    (open.click as () => void)();
    expect(mock.contents.send).toHaveBeenCalledWith("munhae:menu:command", "open");
  });
  it("attaches one editing context menu across language updates and respects edit capabilities", () => {
    installApplicationMenu("ko"); installApplicationMenu("en");
    expect(mock.contents.on.mock.calls.filter(([event]) => event === "context-menu")).toHaveLength(1);
    const handler = mock.contents.on.mock.calls.find(([event]) => event === "context-menu")![1];
    mock.build.mockClear();
    handler({}, { isEditable: false });
    expect(mock.build).not.toHaveBeenCalled();
    handler({}, { isEditable: true, editFlags: { canUndo: true, canRedo: false, canCut: false, canCopy: true, canPaste: true, canSelectAll: true } });
    expect(mock.build.mock.calls[0]![0]).toContainEqual({ role: "copy", label: "Copy", enabled: true });
    expect(mock.build.mock.calls[0]![0]).toContainEqual({ role: "cut", label: "Cut", enabled: false });
    expect(mock.popup).toHaveBeenCalledWith({ window: mock.win });
  });
});
