/// <reference types="electron-vite/node" />

import { app } from "electron";
import { startBrowserBridge, stopBrowserBridge } from "./browser-bridge";
import { log } from "./log";
import { installApplicationMenu } from "./menu";
import { registerIpcHandlers } from "./ipc";
import { registerAppSecurity } from "./security";
import {
  initSession,
  openProjectFromPath,
  projectPathFromArgv,
  shutdownSession,
} from "./session";
import { createMainWindow, focusMainWindow, getMainWindow } from "./window";

app.setName("Munhae Studio");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  boot();
}

function boot(): void {
  let queuedOpen: string | null = projectPathFromArgv(process.argv);
  let shuttingDown = false;

  registerAppSecurity();

  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    if (app.isReady()) {
      void openFromOs(filePath);
    } else {
      queuedOpen = filePath;
    }
  });

  app.on("second-instance", (_event, argv) => {
    focusMainWindow();
    const path = projectPathFromArgv(argv);
    if (path) void openFromOs(path);
  });

  app.whenReady().then(async () => {
    installApplicationMenu();
    initSession(app.getPath("userData"));
    startBrowserBridge();
    registerIpcHandlers();
    createMainWindow();
    if (queuedOpen) {
      const path = queuedOpen;
      queuedOpen = null;
      await openFromOs(path);
    }
  }).catch((error: unknown) => {
    log.error("app ready failed", { name: error instanceof Error ? error.name : "unknown" });
  });

  app.on("activate", () => {
    if (!getMainWindow()) createMainWindow();
    else focusMainWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopBrowserBridge();
    shutdownSession();
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
    await openProjectFromPath(filePath);
    focusMainWindow();
  } catch (error) {
    log.warn("open-file failed", { code: error instanceof Error ? error.name : "unknown" });
  }
}
