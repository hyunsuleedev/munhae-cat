import { dirname, join } from "node:path";
import { BrowserWindow, app, dialog } from "electron";
import { log } from "./log";
import { preloadScriptPath, rendererIndexHtml } from "./paths";
import { isDev, lockSession } from "./security";

let mainWindow: BrowserWindow | null = null;
type LeaveCheck = { reason: "project-switch" | "quit"; cancelled: boolean };
const pendingLeaveChecks = new WeakMap<BrowserWindow, LeaveCheck>();

export type RendererPage = "index.html" | "home.html" | "splash.html";

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
    backgroundColor: "#f6f5f0",
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
      autoplayPolicy: "no-user-gesture-required",
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

  // A renderer's beforeunload also protects ordinary red-button closes and
  // reloads. One native handler covers them and scoped project/quit preflights.
  win.webContents.on("will-prevent-unload", (event) => {
    const check = pendingLeaveChecks.get(win);
    const reason = check?.reason;
    const response = dialog.showMessageBoxSync(win, {
      type: "warning",
      title: "저장하지 않은 변경",
      message: "저장하지 않은 변경이 있습니다.",
      detail: reason === "quit"
        ? "앱을 종료하면 현재 화면의 저장하지 않은 변경은 사라집니다. 계속 편집하려면 현재 화면에 머물러 저장하세요."
        : reason === "project-switch"
          ? "다른 프로젝트를 열면 현재 화면의 저장하지 않은 변경은 사라집니다."
          : "창을 닫거나 화면을 다시 불러오면 저장하지 않은 변경은 사라집니다. 계속 편집하려면 현재 화면에 머물러 저장하세요.",
      buttons: ["현재 화면에 머물기", reason === "quit"
        ? "저장하지 않고 종료"
        : reason === "project-switch" ? "저장하지 않고 프로젝트 열기" : "저장하지 않고 계속"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response === 1) {
      // Electron requires preventDefault here to override the renderer's veto.
      event.preventDefault();
    } else if (check) {
      check.cancelled = true;
    }
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
  return prepareMainWindowToLeave("project-switch");
}

export async function prepareMainWindowForQuit(): Promise<boolean> {
  const accepted = await prepareMainWindowToLeave("quit");
  if (accepted) getMainWindow()?.hide();
  return accepted;
}

async function prepareMainWindowToLeave(reason: "project-switch" | "quit"): Promise<boolean> {
  const win = getMainWindow();
  if (!win) return true;
  if (pendingLeaveChecks.has(win)) return false;
  const check: LeaveCheck = { reason, cancelled: false };
  pendingLeaveChecks.set(win, check);
  try {
    if (reason === "quit") {
      // Trigger the existing page's beforeunload without booting another app
      // page that could request project/agent state during service teardown.
      await win.loadURL("about:blank");
    } else {
      await loadRenderer(win, "home.html");
    }
    return true;
  } catch (error) {
    if (check.cancelled) return false;
    throw error;
  } finally {
    pendingLeaveChecks.delete(win);
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
