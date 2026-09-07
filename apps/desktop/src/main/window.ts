import { dirname, join } from "node:path";
import { BrowserWindow, app, dialog } from "electron";
import { log } from "./log";
import { preloadScriptPath, rendererIndexHtml } from "./paths";
import { isDev, lockSession } from "./security";

let mainWindow: BrowserWindow | null = null;

export type RendererPage = "index.html" | "home.html";

export function getMainWindow(): BrowserWindow | null {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  return null;
}

export function createMainWindow(initialPage: RendererPage = "index.html"): BrowserWindow {
  const existing = getMainWindow();
  if (existing) return existing;

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: "Munhae Studio",
    backgroundColor: "#f3f4f6",
    autoHideMenuBar: process.platform === "darwin",
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 16, y: 16 },
        }
      : {}),
    webPreferences: {
      preload: preloadScriptPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      navigateOnDragDrop: false,
    },
  });

  mainWindow = win;
  lockSession(win.webContents.session);

  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) win.show();
  });

  win.webContents.on("did-fail-load", (_event, code, _desc, url, isMainFrame) => {
    if (!isMainFrame) return;
    log.error("renderer failed to load", { code });
    if (!win.isDestroyed() && !win.isVisible()) win.show();
    void url;
  });

  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  void loadRenderer(win, initialPage).catch((error: unknown) => {
    log.error("renderer failed to load", { name: error instanceof Error ? error.name : "unknown" });
  });
  return win;
}

export async function loadRenderer(
  win: BrowserWindow,
  page: RendererPage = "index.html",
): Promise<void> {
  if (isDev() && process.env.ELECTRON_RENDERER_URL) {
    const base = process.env.ELECTRON_RENDERER_URL.endsWith("/")
      ? process.env.ELECTRON_RENDERER_URL
      : `${process.env.ELECTRON_RENDERER_URL}/`;
    await win.loadURL(new URL(page, base).toString());
  } else {
    await win.loadFile(join(dirname(rendererIndexHtml()), page));
  }
}

/**
 * Move the existing renderer to the project home before replacing its project
 * session. The editor's beforeunload handler is the single source of truth for
 * unsaved drafts; Electron surfaces that veto through will-prevent-unload.
 */
export async function prepareMainWindowForProjectSwitch(): Promise<boolean> {
  const win = getMainWindow();
  if (!win) return true;

  let cancelledForUnsavedChanges = false;
  const onWillPreventUnload = (event: Electron.Event): void => {
    const response = dialog.showMessageBoxSync(win, {
      type: "warning",
      title: "저장하지 않은 변경",
      message: "저장하지 않은 변경이 있습니다.",
      detail: "다른 프로젝트를 열면 현재 화면의 저장하지 않은 변경은 사라집니다.",
      buttons: ["현재 화면에 머물기", "저장하지 않고 프로젝트 열기"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response === 1) {
      // Electron requires preventDefault here to override the renderer's veto.
      event.preventDefault();
      return;
    }
    cancelledForUnsavedChanges = true;
  };

  win.webContents.on("will-prevent-unload", onWillPreventUnload);
  try {
    await loadRenderer(win, "home.html");
    return true;
  } catch (error) {
    if (cancelledForUnsavedChanges) return false;
    throw error;
  } finally {
    if (!win.isDestroyed()) {
      win.webContents.removeListener("will-prevent-unload", onWillPreventUnload);
    }
  }
}

export async function showProjectHome(): Promise<void> {
  const existing = getMainWindow();
  if (!existing) {
    createMainWindow("home.html");
    return;
  }
  const win = existing;
  if (win.webContents.isLoadingMainFrame()) win.webContents.stop();
  await loadRenderer(win, "home.html");
}

export function focusMainWindow(): void {
  const win = getMainWindow();
  if (!win) {
    if (app.isReady()) createMainWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
