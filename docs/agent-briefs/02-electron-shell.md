# Agent 2 — Electron main, preload, security, electron-builder wiring

You own **only**:

- `apps/desktop/src/main/`
- `apps/desktop/src/preload/`
- `apps/desktop/build/` (icons if you add them)
- You may tweak `apps/desktop/electron.vite.config.ts`, `electron-builder.yml`, `apps/desktop/package.json` if required for native modules

Do **not** rewrite renderer HTML. Do **not** implement SQLite yourself — import `@munhae/db-sqlite`, `@munhae/project-format`, `@munhae/agent-runtime`, `@munhae/domain`.

If those packages are still empty when you start, **write main against the API in `docs/agent-briefs/01-packages.md`** and `apps/desktop/src/shared/munhae-api.ts`. Use TypeScript imports; compilation may fail until Agent 1 lands — still write complete source.

Read:

- `plan.md` §11.2, §13, §7.4
- `docs/decisions.md`
- `apps/desktop/src/shared/munhae-api.ts` (IPC_CHANNELS + MunhaeApi)
- `apps/desktop/electron.vite.config.ts`
- `apps/desktop/electron-builder.yml`

## Window

- One `BrowserWindow`
- `width: 1280, height: 800`, min 960×640
- `show: false` until `ready-to-show`
- `title: Munhae Studio`
- macOS: `titleBarStyle: 'hiddenInset'`, `trafficLightPosition: { x: 16, y: 18 }`
- `backgroundColor: '#c9d0d8'` approximating the desk gradient
- Security:
  - `contextIsolation: true`
  - `nodeIntegration: false`
  - `sandbox: true`
  - `webSecurity: true`
  - `preload` = compiled preload
- Load renderer `index.html` from electron-vite (`MAIN_WINDOW_VITE` / `electron-vite` `loadUrl` pattern). Use:

```ts
import { join } from "node:path";
import { shell } from "electron";

if (is.dev && process.env.ELECTRON_RENDERER_URL) {
  win.loadURL(process.env.ELECTRON_RENDERER_URL);
} else {
  win.loadFile(join(__dirname, "../renderer/index.html"));
}
```

electron-vite sets `ELECTRON_RENDERER_URL` in dev.

- `setWindowOpenHandler`: deny, open http(s) via `shell.openExternal` after allowlist (`https:` only)
- `will-navigate`: prevent leaving app origin
- Register `app.on("web-contents-created")` to attach the same handlers to all contents

## App data

- `app.getPath("userData")` → `app.sqlite3` via `openAppDatabase`
- `app-config.json` in userData with `DEFAULT_APP_CONFIG`. Never store tokens.

## IPC

Implement every channel in `IPC_CHANNELS`. Preload exposes `window.munhae` matching `MunhaeApi`.

preload:

```ts
import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS, type MunhaeApi } from "../shared/munhae-api";

const api: MunhaeApi = { /* invoke wrappers */ };
contextBridge.exposeInMainWorld("munhae", api);
```

Add `apps/desktop/src/preload/index.d.ts`:

```ts
import type { MunhaeApi } from "../shared/munhae-api";
declare global {
  interface Window {
    munhae: MunhaeApi;
  }
}
export {};
```

Main handlers:

- Validate sender: `event.sender === win.webContents`
- Validate channel is in allowlist
- Wrap errors as `{ ok: false, error: { code, message } }` for methods that return `IpcResult`
- `project.create`: if no parentDir, `dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] })`
- `project.open`: if no path, dialog for folder (mac can select .munhae bundle as directory). Also accept `.munhaepkg` — unzip to a sibling folder then open
- `project.seedDemo`: create under `userData/demo` or Documents/문해
- `project.backup`: save dialog default `title-YYYYMMDD.munhaepkg`
- `app.openExternal`: only https URLs
- `app.quit`: `app.quit()`
- Keep a single `currentRepo: ProjectRepo | null`. Opening another project closes the previous.

File path checks: any fs path used for assets must stay inside the current `.munhae` package root (`path.resolve` + prefix check with separator).

## Native menu (minimal)

On darwin, set a small application menu so Cmd+Q / Cmd+H work. Do **not** duplicate the full in-window menubar. Forward nothing else.

Also handle `open-file` / second instance with a single-instance lock (`requestSingleInstanceLock`).

## Agent probe

Call `@munhae/agent-runtime` `probeAll()` from `appProbeAgents`. Cache 15s.

## Logging

- Don't log source text, translations, or prompt bodies
- Redact Authorization / Bearer / sk- / cookie
- Log projectId, message ids only

## better-sqlite3

Keep it externalized (electron-vite `externalizeDepsPlugin` default). electron-builder.yml already has asarUnpack for `*.node`. If you must, add to electron.vite.config.ts:

```
externalizeDepsPlugin({ exclude: [] })
```

Do not bundle better-sqlite3.

Workspace packages `@munhae/*` **should be bundled** (they are TS). If externalizeDepsPlugin externalizes them, pass:

```
externalizeDepsPlugin({ exclude: ["@munhae/domain", "@munhae/db-sqlite", "@munhae/project-format", "@munhae/agent-runtime"] })
```

Wait — `exclude` in electron-vite means "do not externalize, bundle them". Confirm electron-vite docs: `exclude` = deps that should NOT be externalized. Yes, exclude workspace packages so they are bundled.

## Dev vs prod

Use `electron-vite/node` `is.dev` if available, else `!app.isPackaged`.

## When done

Write `docs/agent-briefs/02-electron-shell.report.md`. No renderer pages. Do not run a full UI rewrite.
