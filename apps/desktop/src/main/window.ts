import { BrowserWindow, app } from "electron";
import { log } from "./log";
import { preloadScriptPath, rendererIndexHtml } from "./paths";
import { isDev, lockSession } from "./security";

let mainWindow: BrowserWindow | null = null;

export function getMainWindow(): BrowserWindow | null {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  return null;
}

export function createMainWindow(): BrowserWindow {
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

  void loadRenderer(win);
  return win;
}

export async function loadRenderer(win: BrowserWindow): Promise<void> {
  if (isDev() && process.env.ELECTRON_RENDERER_URL) {
    await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await win.loadFile(rendererIndexHtml());
  }
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
