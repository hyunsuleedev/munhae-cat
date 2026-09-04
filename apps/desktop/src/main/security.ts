import { app, shell, type Session, type WebContents } from "electron";
import { fileURLToPath } from "node:url";
import { AppError, errorCode } from "./errors";
import { log } from "./log";
import { isPathInside, rendererDir } from "./paths";

export function isDev(): boolean {
  return Boolean(import.meta.env.DEV) || !app.isPackaged;
}

export function isHttpsUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function assertHttpsUrl(urlString: string): URL {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new AppError("invalid_url", "올바르지 않은 주소입니다.");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new AppError("invalid_url", "https 주소만 열 수 있습니다.");
  }
  return url;
}

export async function openHttpsExternal(urlString: string): Promise<void> {
  const url = assertHttpsUrl(urlString);
  await shell.openExternal(url.toString());
}

export function isAllowedNavigation(urlString: string): boolean {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (isDev() && devUrl) {
    try {
      return url.origin === new URL(devUrl).origin;
    } catch {
      return false;
    }
  }
  if (url.protocol !== "file:") return false;
  try {
    return isPathInside(rendererDir(), fileURLToPath(url));
  } catch {
    return false;
  }
}

function denyNavigation(event: { preventDefault: () => void }, url: string): void {
  event.preventDefault();
  if (isHttpsUrl(url)) {
    void openHttpsExternal(url).catch((error: unknown) => {
      log.warn("external navigation denied", { code: errorCode(error) });
    });
  }
}

export function attachWebContentsSecurity(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (isHttpsUrl(url)) {
      void openHttpsExternal(url).catch((error: unknown) => {
        log.warn("window.open external denied", { code: errorCode(error) });
      });
    }
    return { action: "deny" };
  });

  contents.on("will-navigate", (event) => {
    if (isAllowedNavigation(event.url)) return;
    denyNavigation(event, event.url);
  });

  contents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame) return;
    event.preventDefault();
  });

  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });

  contents.on("preload-error", (_event, _preloadPath, error) => {
    log.error("preload error", { name: error.name });
  });
}

export function registerAppSecurity(): void {
  app.on("web-contents-created", (_event, contents) => {
    attachWebContentsSecurity(contents);
  });
}

export function lockSession(session: Session): void {
  session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  session.setPermissionCheckHandler(() => false);
}
