/// <reference types="electron-vite/node" />

import { resolve } from "node:path";
import { app, dialog } from "electron";
import { initAppUpdates, canQuitForUpdate, cancelUpdateInstall, finishUpdateQuit, stopAppUpdateChecks } from "./app-updates";
import { initFileLogging } from "./log";
import { startBrowserBridge, stopBrowserBridge } from "./browser-bridge";
import { log } from "./log";
import { installApplicationMenu } from "./menu";
import { registerIpcHandlers } from "./ipc";
import { registerAppSecurity } from "./security";
import {
  getAppConfig,
  getCurrentSummary,
  initSession,
  listRecent,
  openProjectFromPath,
  projectPathFromArgv,
  shutdownSession,
} from "./session";
import {
  createMainWindow,
  focusMainWindow,
  getMainWindow,
  loadRenderer,
  prepareMainWindowForProjectSwitch,
  prepareMainWindowForQuit,
  showProjectHome,
} from "./window";
import { cancelAllAiRuns, registerAiPersistenceHook } from "./ai-runs";
import { flushOnlineWorkspace, leaveOnlineWorkspace, getOnlineWorkspaceStatus } from "./session";
import { shutdownAgentRuntime } from "./agent-runtime-client";
import { stopAgentToolBridge } from "./agent-tool-bridge";
import { initAccount, shutdownAccount } from "./auth";
import { createQuitHandler } from "./quit-lifecycle";
import { installStartup } from "./startup";

app.setName("Munhae Studio");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  boot();
}

function boot(): void {
  let queuedOpen: string | null = projectPathFromArgv(process.argv);
  let readyForExternalOpen = false;
  let openQueue = Promise.resolve();
  let startup: ReturnType<typeof installStartup> | null = null;
  let stopping = false;

  const enqueueExternalOpen = (filePath: string): void => {
    openQueue = openQueue.then(() => openFromOs(filePath));
  };
  const acceptExternalOpens = (): void => {
    if (stopping) return;
    readyForExternalOpen = true;
    if (queuedOpen) {
      const path = queuedOpen;
      queuedOpen = null;
      enqueueExternalOpen(path);
    }
  };

  registerAppSecurity();

  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    if (readyForExternalOpen) {
      enqueueExternalOpen(filePath);
    } else {
      queuedOpen = filePath;
    }
  });

  app.on("second-instance", (_event, argv) => {
    const path = projectPathFromArgv(argv);
    if (!readyForExternalOpen) {
      if (path) queuedOpen = path;
      return;
    }
    if (path) enqueueExternalOpen(path);
    else focusMainWindow();
  });

  app.whenReady().then(async () => {
    initFileLogging(app.getPath("logs"));
    log.info("startup", { version: app.getVersion(), platform: process.platform, arch: process.arch, electron: process.versions.electron });
    let startupPrepared = false;
    startup = installStartup({
      getWindow: getMainWindow,
      enter: async (page) => {
        const win = getMainWindow();
        if (!win || stopping) return;
        await loadRenderer(win, page);
        acceptExternalOpens();
      },
    });
    const startupWindow = createMainWindow("splash.html");
    startupWindow.once("closed", () => {
      startup?.dispose();
      // macOS can reopen the app after its first window is closed mid-transition.
      if (startupPrepared) acceptExternalOpens();
    });
    initSession(app.getPath("userData"));
    registerAiPersistenceHook(flushOnlineWorkspace, { beforeLaunch: true });
    installApplicationMenu(getAppConfig().language);
    await initAccount();
    if (stopping) return;
    startBrowserBridge();
    registerIpcHandlers();
    initAppUpdates();

    let initialPage: "index.html" | "home.html" = "index.html";
    const launchPath = queuedOpen
      ?? (!getAppConfig().showWelcomeOnLaunch
        ? listRecent().find((project) => !project.missing)?.packagePath ?? null
        : null);
    queuedOpen = null;
    if (launchPath) {
      try {
        await openProjectFromPath(launchPath);
        initialPage = "home.html";
      } catch (error) {
        log.warn("launch project open failed", {
          code: error instanceof Error ? error.name : "unknown",
        });
      }
    }
    if (stopping) return;
    startupPrepared = true;
    if (startupWindow.isDestroyed()) {
      acceptExternalOpens();
      return;
    }
    startup.ready(initialPage);
  }).catch((error: unknown) => {
    startup?.fail();
    log.error("app ready failed", error);
    dialog.showErrorBox("문해 시작 오류", `문해를 시작하지 못했습니다. 진단 로그를 확인해 주세요.\n${app.getPath("logs")}`);
  });

  app.on("activate", () => {
    if (!readyForExternalOpen) {
      const win = getMainWindow();
      if (win) { win.show(); win.focus(); }
      return;
    }
    if (!getMainWindow()) createMainWindow(getCurrentSummary() ? "home.html" : "index.html");
    else focusMainWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  const handleQuit = createQuitHandler({
    prepare: async () => {
      if (!canQuitForUpdate()) {
        cancelUpdateInstall();
        focusMainWindow();
        await dialog.showMessageBox({ message: "AI 작업이 끝난 뒤 업데이트를 설치해 주세요." });
        return false;
      }
      const win = getMainWindow();
      const previousUrl = win?.webContents.getURL();
      const accepted = await prepareMainWindowForQuit();
      if (!accepted) cancelUpdateInstall();
      if (accepted && getOnlineWorkspaceStatus()) {
        await cancelAllAiRuns();
        try { await flushOnlineWorkspace(); }
        catch {
          const result = await dialog.showMessageBox({ type: "warning", title: "온라인 저장 대기",
            message: "온라인 저장을 마치지 못했습니다.",
            detail: "작업본은 이 기기에 보관되어 있습니다. 연결을 확인해 다시 저장하거나, 작업본을 보관한 채 종료할 수 있습니다.",
            buttons: ["계속 작업", "이 기기에 보관하고 종료"], defaultId: 0, cancelId: 0 });
          if (result.response === 0) {
            cancelUpdateInstall();
            if (win && previousUrl) { await win.loadURL(previousUrl); win.show(); }
            return false;
          }
        }
      }
      return accepted;
    },
    shutdown: async () => {
      stopping = true;
      stopAppUpdateChecks();
      startup?.dispose();
      stopBrowserBridge();
      await cancelAllAiRuns();
      await leaveOnlineWorkspace(true);
      await shutdownAgentRuntime();
      await stopAgentToolBridge();
      shutdownSession();
      shutdownAccount();
    },
    quit: () => { if (!finishUpdateQuit()) app.quit(); },
    onError: (error) => {
      cancelUpdateInstall();
      log.error("app shutdown failed", { name: error instanceof Error ? error.name : "unknown" });
      focusMainWindow();
    },
  });
  app.on("before-quit", (event) => {
    void handleQuit(event);
  });

  process.on("uncaughtException", (error) => {
    log.error("uncaughtException", { name: error.name });
  });
  process.on("unhandledRejection", (reason) => {
    log.error("unhandledRejection", {
      name: reason instanceof Error ? reason.name : "unknown",
    });
  });
}

async function openFromOs(filePath: string): Promise<void> {
  try {
    const previous = getCurrentSummary();
    const opened = await openProjectFromPath(
      filePath,
      previous ? prepareMainWindowForProjectSwitch : async () => true,
    );
    if (!opened) {
      focusMainWindow();
      return;
    }
    const sameOpenProject = previous
      ? resolve(previous.packagePath) === resolve(opened.packagePath)
      : false;
    if (!sameOpenProject || !getMainWindow()) await showProjectHome();
    focusMainWindow();
  } catch (error) {
    log.warn("open-file failed", { code: error instanceof Error ? error.name : "unknown" });
  }
}
