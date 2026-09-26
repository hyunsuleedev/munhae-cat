import { Menu, app, webContents, type MenuItemConstructorOptions, type WebContents } from "electron";
import { IPC_CHANNELS } from "../shared/munhae-api";
import { getMainWindow } from "./window";
import { translateUi, type UiLanguage } from "../shared/ui-translations";

let menuLanguage: UiLanguage = "ko";
const editingMenus = new WeakSet<WebContents>();
let watchingContents = false;

function shortcut(label: string, accelerator: string, id: string): MenuItemConstructorOptions {
  return {
    label, id, accelerator, visible: false, acceleratorWorksWhenHidden: true,
    click: () => getMainWindow()?.webContents.send(IPC_CHANNELS.menuCommand, id),
  };
}

function attachEditingMenu(contents: WebContents): void {
  if (editingMenus.has(contents)) return;
  editingMenus.add(contents);
  contents.on("context-menu", (_event, params) => {
    const win = getMainWindow();
    // Document rows have their own contextual actions. Native editing belongs
    // only to editable fields and keeps the selection/focus in that field.
    if (!params.isEditable || !win || win.webContents !== contents) return;
    const edit = (label: string, role: MenuItemConstructorOptions["role"], enabled: boolean): MenuItemConstructorOptions => ({
      label: translateUi(label, menuLanguage), role, enabled,
    });
    Menu.buildFromTemplate([
      edit("실행 취소", "undo", params.editFlags.canUndo),
      edit("다시 실행", "redo", params.editFlags.canRedo),
      { type: "separator" },
      edit("잘라내기", "cut", params.editFlags.canCut),
      edit("복사", "copy", params.editFlags.canCopy),
      edit("붙여넣기", "paste", params.editFlags.canPaste),
      { type: "separator" },
      edit("전체 선택", "selectAll", params.editFlags.canSelectAll),
    ]).popup({ window: win });
  });
}

export function installApplicationMenu(language: UiLanguage = "ko"): void {
  menuLanguage = language;
  app.setAboutPanelOptions({ applicationName: "Munhae Studio", applicationVersion: app.getVersion(), copyright: "Copyright © 2026 Munhae" });
  // Keep native accelerators registered after removing their visible menus.
  // In particular, macOS text editing relies on the native edit roles.
  const hidden: MenuItemConstructorOptions[] = [
    ...(["undo", "redo", "cut", "copy", "paste", "selectAll", "minimize", "togglefullscreen"] as const)
      .map(role => ({ role, visible: false, acceleratorWorksWhenHidden: true })),
    shortcut("새 프로젝트…", "CommandOrControl+Shift+N", "newproj"),
    shortcut("프로젝트 열기…", "CommandOrControl+O", "open"),
    shortcut("새 문서", "CommandOrControl+N", "newdoc"),
    shortcut("내보내기…", "CommandOrControl+E", "export"),
    shortcut("프로젝트 닫기", "CommandOrControl+W", "close"),
    shortcut("찾기…", "CommandOrControl+F", "find"),
    shortcut("사이드바 보기/가리기", "Control+CommandOrControl+S", "sidebar"),
    shortcut("참고 자료 패널", "Alt+CommandOrControl+R", "refpane"),
    shortcut("참고 자료·AI 패널", "Alt+CommandOrControl+I", "ctxpane"),
    shortcut("원문 전문", "CommandOrControl+1", "v-source"),
    shortcut("문장별 대조", "CommandOrControl+2", "v-parallel"),
    shortcut("서책 보기", "CommandOrControl+3", "v-full"),
    shortcut("AI 번역…", "Alt+CommandOrControl+K", "prepare"),
    shortcut("다음 블록과 합치기", "Alt+CommandOrControl+M", "merge"),
    shortcut("블록 나누기…", "Alt+CommandOrControl+S", "split"),
    shortcut("앵커 연결…", "Alt+CommandOrControl+L", "link"),
    shortcut("변경 비교", "CommandOrControl+D", "diff"),
    shortcut("번역안 확정", "Shift+CommandOrControl+Return", "confirm"),
    shortcut("프로젝트 홈", "Shift+CommandOrControl+1", "home"),
    shortcut("편집", "Shift+CommandOrControl+2", "editor"),
    shortcut("문맥", "Shift+CommandOrControl+3", "knowledge"),
    shortcut("명령 검색…", "CommandOrControl+K", "palette"),
  ];
  const prefs = shortcut("설정…", "CommandOrControl+,", "prefs");
  const template: MenuItemConstructorOptions[] = process.platform === "darwin" ? [{
    label: app.name,
    submenu: [
      { role: "about" }, { type: "separator" }, { ...prefs, visible: true },
      { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" },
      { type: "separator" }, { role: "quit" }, ...hidden,
    ],
  }] : [...hidden, prefs, { role: "quit", visible: false }];
  const localize = (items: MenuItemConstructorOptions[]): void => {
    for (const entry of items) {
      if (language === "en" && entry.role && !entry.label) {
        const labels: Record<string, string> = { about: "About Munhae Studio", hide: "Hide Munhae Studio", hideOthers: "Hide Others", unhide: "Show All", quit: "Quit Munhae Studio" };
        entry.label = labels[entry.role];
      }
      if (entry.label) entry.label = translateUi(entry.label, language);
      if (Array.isArray(entry.submenu)) localize(entry.submenu);
    }
  };
  localize(template);
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  if (process.platform !== "darwin") getMainWindow()?.setMenuBarVisibility(false);
  webContents.getAllWebContents().forEach(attachEditingMenu);
  if (!watchingContents) {
    watchingContents = true;
    app.on("web-contents-created", (_event, contents) => attachEditingMenu(contents));
  }
}
