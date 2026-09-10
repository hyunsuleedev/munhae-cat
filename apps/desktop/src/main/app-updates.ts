import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, dialog, Menu, shell, type MessageBoxOptions } from "electron";
import electronUpdater from "electron-updater";
import { hasActiveAiRuns } from "./ai-runs";
import { getMainWindow } from "./window";
import { log } from "./log";
import { UpdateController, type UpdateState } from "./update-controller";

let controller: UpdateController | null = null;
let dialogBusy = false;
let startupTimer: ReturnType<typeof setTimeout> | undefined;
function message(options: MessageBoxOptions) {
  const win = getMainWindow();
  const opts = { title: "문해 업데이트", noLink: true, ...options };
  return win && !win.isDestroyed() ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
}
function changed(state: UpdateState) {
  const label = state.phase === "downloading" ? `업데이트 다운로드 중 (${Math.floor(state.percent ?? 0)}%)…`
    : state.phase === "downloaded" ? "다운로드한 업데이트 설치…" : "업데이트 확인…";
  const item = Menu.getApplicationMenu()?.getMenuItemById("updates");
  if (item) item.label = label;
  getMainWindow()?.setProgressBar(state.phase === "downloading" ? (state.percent ?? 0) / 100 : -1);
  if (state.phase !== "downloading") log.info("updater state", state);
}
export function initAppUpdates(): void {
  // A developer checkout and a package without a release feed must never contact an inferred GitHub feed.
  if (controller || !app.isPackaged || process.platform !== "win32" || process.arch !== "x64"
    || !existsSync(join(process.resourcesPath, "app-update.yml"))) return;
  const { autoUpdater } = electronUpdater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.disableWebInstaller = true;
  autoUpdater.logger = log;
  autoUpdater.on("error", (error: Error) => log.error("updater error", error));
  autoUpdater.on("download-progress", ({ percent }: { percent: number }) => controller?.progress(percent));
  controller = new UpdateController({
    async check() {
      let version: string | null = null;
      const available = (info: { version: string }) => { version = info.version; };
      autoUpdater.on("update-available", available);
      try { await autoUpdater.checkForUpdates(); return version; }
      finally { autoUpdater.removeListener("update-available", available); }
    },
    async download() { await autoUpdater.downloadUpdate(); },
    install() { autoUpdater.quitAndInstall(false, true); },
  }, hasActiveAiRuns, changed);
  startupTimer = setTimeout(() => { void checkAppUpdates(false); }, 30_000);
  startupTimer.unref();
}
export function stopAppUpdateChecks(): void { clearTimeout(startupTimer); }
export async function checkAppUpdates(manual = true): Promise<void> {
  if (dialogBusy) return;
  dialogBusy = true;
  let interactive = manual;
  try {
    if (!controller) {
      if (manual) await message({ type: "info", message: "이 실행 환경에서는 업데이트를 사용할 수 없습니다.",
        detail: "업데이트는 배포 주소가 연결된 Windows 64비트 설치본에서 지원합니다." });
      return;
    }
    if (controller.state.phase === "downloading") {
      if (manual) await message({ message: `업데이트 다운로드 중 (${Math.floor(controller.state.percent ?? 0)}%)`, detail: "다운로드가 끝나면 설치 여부를 안내합니다. 작업을 계속하셔도 됩니다." });
      return;
    }
    if (controller.state.phase !== "downloaded") {
      await controller.check();
      if (controller.state.phase === "idle") {
        if (manual) await message({ message: "최신 버전을 사용하고 있습니다.", detail: `현재 버전 ${app.getVersion()}` });
        return;
      }
      if (controller.state.phase !== "available") return;
      const result = await message({ message: `문해 ${controller.state.version} 업데이트가 있습니다.`,
        detail: `현재 버전 ${app.getVersion()}\n다운로드 중에도 작업할 수 있습니다. 설치는 나중에 선택할 수 있습니다.`,
        buttons: ["다운로드", "나중에"], defaultId: 0, cancelId: 1 });
      if (result.response !== 0) return;
      interactive = true;
      await controller.download();
    }
    const result = await message({ message: "업데이트를 설치할 준비가 되었습니다.",
      detail: "작업을 먼저 저장해 주세요. 설치하면 문해가 종료된 뒤 다시 시작됩니다. 저장하지 않은 변경이 있으면 종료 전에 확인합니다.",
      buttons: ["나중에", "종료하고 설치"], defaultId: 0, cancelId: 0 });
    if (result.response === 1) {
      if (!controller.requestInstall()) {
        await message({ message: "AI 작업이 끝난 뒤 설치해 주세요.", detail: "도움말 → 업데이트 확인에서 다시 설치할 수 있습니다." });
        return;
      }
      app.quit(); // Existing before-quit handler validates drafts and shuts down services before installer starts.
    }
  } catch (error) {
    log.error("update operation failed", error);
    if (interactive) {
      const result = await message({ type: "error", message: "업데이트를 완료하지 못했습니다.",
        detail: "현재 버전은 계속 사용할 수 있습니다. 네트워크를 확인한 뒤 다시 시도해 주세요. 문제가 반복되면 진단 로그를 확인해 주세요.",
        buttons: ["닫기", "로그 폴더 열기"], cancelId: 0 });
      if (result.response === 1) await shell.openPath(app.getPath("logs"));
    }
  } finally { dialogBusy = false; }
}
export function canQuitForUpdate(): boolean { return controller?.canQuitForInstall() ?? true; }
export function cancelUpdateInstall(): void { controller?.cancelInstall(); }
export function finishUpdateQuit(): boolean { return controller?.finishQuit() ?? false; }
