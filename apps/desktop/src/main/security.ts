import { app, shell, type Session, type WebContents } from "electron";
import { fileURLToPath } from "node:url";
import { AppError, errorCode } from "./errors";
import { log } from "./log";
import { isPathInside, rendererDir } from "./paths";

export function isDev(): boolean {
  return Boolean(import.meta.env.DEV) || !app.isPackaged;
}

const EXTERNAL_HOST_ALLOWLIST = new Set([
  "openai.com",
  "www.openai.com",
  "help.openai.com",
  "platform.openai.com",
  "developers.openai.com",
  "anthropic.com",
  "www.anthropic.com",
  "docs.anthropic.com",
  "support.anthropic.com",
  "console.anthropic.com",
  "claude.ai",
  "hanja.dict.naver.com",
  "dic.daum.net",
  "oriental-dic.dankook.ac.kr",
  "ko.wiktionary.org",
  "zonmal.cafe24.com",
  "kostma.aks.ac.kr",
  "encykorea.aks.ac.kr",
  "opendict.korean.go.kr",
  "stdict.korean.go.kr",
  "db.itkc.or.kr",
  "kaikki.org",
  "github.com",
  "opensource.org",
  "creativecommons.org",
  "foundation.wikimedia.org",
  "gongu.copyright.or.kr",
  "www.kogl.or.kr",
  "unicode.org",
  "www.unicode.org",
]);

export function isAllowedExternalUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && EXTERNAL_HOST_ALLOWLIST.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function assertAllowedExternalUrl(urlString: string): URL {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new AppError("invalid_url", "올바르지 않은 주소입니다.");
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || !EXTERNAL_HOST_ALLOWLIST.has(url.hostname.toLowerCase())
  ) {
    throw new AppError("invalid_url", "등록된 사전·자료 출처와 공식 도움말 주소만 열 수 있습니다.");
  }
  return url;
}

export async function openHttpsExternal(urlString: string): Promise<void> {
  const url = assertAllowedExternalUrl(urlString);
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
  if (isAllowedExternalUrl(url)) {
    void openHttpsExternal(url).catch((error: unknown) => {
      log.warn("external navigation denied", { code: errorCode(error) });
    });
  }
}

export function attachWebContentsSecurity(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
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
    // Reference PDFs are loaded from an in-memory Blob URL in a sandboxed iframe.
    // No package path is exposed to the renderer and every byte was hash-verified
    // by the main-process repository before the Blob was created.
    if (event.url.startsWith("blob:")) return;
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
