import { checkAppUpdates } from "./app-updates";
import { Menu, app, type MenuItemConstructorOptions } from "electron";
import { IPC_CHANNELS } from "../shared/munhae-api";
import { getMainWindow } from "./window";

function accelerator(kbd: string): string | undefined {
  if (!kbd) return undefined;
  const mods: string[] = [];
  if (kbd.includes("⌃")) mods.push("Control");
  if (kbd.includes("⌥")) mods.push("Alt");
  if (kbd.includes("⇧")) mods.push("Shift");
  if (kbd.includes("⌘")) mods.push("CommandOrControl");
  let key = kbd.replace(/[⌃⌥⇧⌘]/g, "");
  if (key === "↩") key = "Return";
  if (key === ",") key = ",";
  if (!key) return undefined;
  return [...mods, key].join("+");
}

function dispatch(id: string): void {
  const win = getMainWindow();
  if (id === "updates") { void checkAppUpdates(); return; }
  if (id === "quit") {
    app.quit();
    return;
  }
  if (id === "min") {
    win?.minimize();
    return;
  }
  if (id === "zoom") {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return;
  }
  if (id === "about") {
    app.showAboutPanel();
    return;
  }
  win?.webContents.send(IPC_CHANNELS.menuCommand, id);
}

function item(label: string, kbd: string, id: string, extra?: Partial<MenuItemConstructorOptions>): MenuItemConstructorOptions {
  return {
    label,
    id,
    accelerator: accelerator(kbd),
    click: () => dispatch(id),
    ...extra,
  };
}

export function installApplicationMenu(): void {
  app.setAboutPanelOptions({
    applicationName: "Munhae Studio",
    applicationVersion: app.getVersion(),
    copyright: "Copyright © 2026 Munhae",
  });

  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              item("설정…", "⌘,", "prefs"),
              item("AI 연결 상태…", "", "ai"),
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "파일",
      submenu: [
        item("새 프로젝트…", "⇧⌘N", "newproj"),
        item("프로젝트 열기…", "⌘O", "open"),
        { type: "separator" },
        item("새 문서 node…", "⌘N", "newdoc"),
        item("원문 가져오기…", "", "import"),
        { type: "separator" },
        item("백업 만들기…", "", "backup"),
        item("내보내기…", "⌘E", "export"),
        { type: "separator" },
        item("프로젝트 닫기", "⌘W", "close"),
        ...(process.platform === "darwin" ? [] : [{ type: "separator" as const }, { role: "quit" as const }]),
      ],
    },
    {
      label: "편집",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        { type: "separator" },
        item("찾기…", "⌘F", "find"),
      ],
    },
    {
      label: "보기",
      submenu: [
        item("사이드바 보기/가리기", "⌃⌘S", "sidebar"),
        item("참고 자료 패널", "⌥⌘R", "refpane"),
        item("참고 자료·AI 패널", "⌥⌘I", "ctxpane"),
        { type: "separator" },
        item("표점 전문", "⌘1", "v-source"),
        item("대조", "⌘2", "v-parallel"),
        item("번역 전문", "⌘3", "v-full"),
        { type: "separator" },
        item("구조 표시", "", "struct"),
        item("앵커 ID 표시", "", "keys"),
      ],
    },
    {
      label: "번역",
      submenu: [
        item("AI 번역…", "⌥⌘K", "prepare"),
        { type: "separator" },
        item("다음 블록과 합치기", "⌥⌘M", "merge"),
        item("블록 나누기…", "⌥⌘S", "split"),
        item("앵커 연결…", "⌥⌘L", "link"),
        { type: "separator" },
        item("변경 비교", "⌘D", "diff"),
        item("번역안 확정", "⇧⌘↩", "confirm"),
      ],
    },
    {
      label: "이동",
      submenu: [
        item("프로젝트 홈", "⇧⌘1", "home"),
        item("편집", "⇧⌘2", "editor"),
        item("번역 자료", "⇧⌘3", "knowledge"),
        { type: "separator" },
        item("명령 검색…", "⌘K", "palette"),
      ],
    },
    {
      label: "창",
      role: "windowMenu",
    },
    {
      label: "도움말",
      submenu: [
        item("문해 도움말", "", "help"),
        item("업데이트 확인…", "", "updates"),
        item("plan.md 보기", "", "plan"),
        item("schema.md 보기", "", "schema"),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
