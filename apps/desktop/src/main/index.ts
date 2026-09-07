/// <reference types="electron-vite/node" />

import { resolve } from "node:path";
import { app } from "electron";
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
  prepareMainWindowForProjectSwitch,
  prepareMainWindowForQuit,
  showProjectHome,
} from "./window";
import { cancelAllAiRuns } from "./ai-runs";
import { shutdownAgentRuntime } from "./agent-runtime-client";
import { stopAgentToolBridge } from "./agent-tool-bridge";
import { initAccount, shutdownAccount } from "./auth";
import { createQuitHandler } from "./quit-lifecycle";

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

  const enqueueExternalOpen = (filePath: string): void => {
    openQueue = openQueue.then(() => openFromOs(filePath));
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
    installApplicationMenu();
    initSession(app.getPath("userData"));
    await initAccount();
    startBrowserBridge();
    registerIpcHandlers();

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
    createMainWindow(initialPage);
    readyForExternalOpen = true;

    if (queuedOpen) {
      const path = queuedOpen;
      queuedOpen = null;
      enqueueExternalOpen(path);
    }
  }).catch((error: unknown) => {
    log.error("app ready failed", { name: error instanceof Error ? error.name : "unknown" });
  });

  app.on("activate", () => {
    if (!getMainWindow()) createMainWindow(getCurrentSummary() ? "home.html" : "index.html");
    else focusMainWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  const handleQuit = createQuitHandler({
    prepare: prepareMainWindowForQuit,
    shutdown: async () => {
      stopBrowserBridge();
      await cancelAllAiRuns();
      await shutdownAgentRuntime();
      await stopAgentToolBridge();
      shutdownSession();
      shutdownAccount();
    },
    quit: () => app.quit(),
    onError: (error) => {
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
