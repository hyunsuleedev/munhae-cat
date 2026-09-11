import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { STARTUP_CHANNELS, type StartupState } from "../shared/startup-api";
import { isAllowedNavigation } from "./security";
import { log } from "./log";

export type StartupPage = "index.html" | "home.html";
type StartupOptions = {
  getWindow(): BrowserWindow | null;
  enter(page: StartupPage): Promise<void>;
};

/** The renderer can enter only after native startup succeeds, and cannot choose a destination. */
export function installStartup(options: StartupOptions) {
  let resolveReady!: (state: StartupState) => void;
  const pending = new Promise<StartupState>((resolve) => { resolveReady = resolve; });
  let page: StartupPage | null = null;
  let settled = false;
  let disposed = false;
  let entering: Promise<void> | null = null;

  function assertSplash(event: IpcMainInvokeEvent) {
    const win = options.getWindow();
    const frame = event.senderFrame;
    if (!win || win.isDestroyed() || event.sender !== win.webContents
      || frame !== win.webContents.mainFrame || !frame
      || !isAllowedNavigation(frame.url) || !new URL(frame.url).pathname.endsWith("/splash.html")) {
      throw new Error("시작 화면에서만 사용할 수 있습니다.");
    }
  }

  async function enter(): Promise<void> {
    const state = await pending;
    if (!state.ok || disposed || !page) return;
    const win = options.getWindow();
    if (!win || win.isDestroyed()) return;
    if (!entering) {
      entering = options.enter(page).then(dispose).catch((error: unknown) => {
        entering = null;
        log.error("startup page failed", { name: error instanceof Error ? error.name : "unknown" });
        throw error;
      });
    }
    await entering;
  }

  ipcMain.handle(STARTUP_CHANNELS.wait, (event) => { assertSplash(event); return pending; });
  ipcMain.handle(STARTUP_CHANNELS.enter, (event) => { assertSplash(event); return enter(); });

  function dispose() {
    if (disposed) return;
    disposed = true;
    resolveReady({ ok: false, message: "시작이 취소되었습니다." });
    ipcMain.removeHandler(STARTUP_CHANNELS.wait);
    ipcMain.removeHandler(STARTUP_CHANNELS.enter);
  }

  return {
    ready(destination: StartupPage) {
      if (settled || disposed) return;
      settled = true; page = destination; resolveReady({ ok: true });
      // The splash renderer requests entry only after its animation has finished.
    },
    fail() {
      if (settled || disposed) return;
      settled = true;
      resolveReady({ ok: false, message: "문해를 시작하지 못했습니다. 앱을 종료한 뒤 다시 열어 주세요." });
    },
    dispose,
  };
}
