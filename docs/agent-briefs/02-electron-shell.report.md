# Agent 2 report — Electron main, preload, security

Status: **source complete; blocked on Agent 1 public entry** (`@munhae/db-sqlite` has no `src/index.ts` / `ProjectRepo` yet).

## What landed

One `BrowserWindow` (1280×800, min 960×640, `show: false` until `ready-to-show`, title Munhae Studio, macOS `hiddenInset` + traffic lights, desk `backgroundColor`).

Renderer security:

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`
- Preload is a **CJS** bundle (`out/preload/index.cjs`) because sandboxed preload cannot load ESM
- `setWindowOpenHandler` denies; `https:` only via `shell.openExternal`
- `will-navigate` stays on the app origin (dev `ELECTRON_RENDERER_URL`, prod `file:` under `out/renderer`)
- `app.on("web-contents-created")` attaches the same handlers; webviews blocked
- Permission request/check handlers deny

IPC: every `IPC_CHANNELS` value is registered. Sender must be the main window `webContents`. Payloads are type-guarded. Methods typed as `IpcResult<T>` catch and return `{ ok: false, error: { code, message } }`. Logs never include source/translation/prompt text; Bearer / Authorization / Cookie / `sk-` are redacted.

App data:

- `userData/app-config.json` (defaults from `DEFAULT_APP_CONFIG`; secret-looking keys rejected)
- `userData/app.sqlite3` via Agent 1 `openAppDb` **or** `openAppDatabase` (Agent 1 currently implements `openAppDatabase`)

Project session: single `currentRepo`. Open/create/seed closes the previous. `.munhaepkg` unzip (store + deflate, zip-slip / symlink rejected) to a sibling `.munhae` then `openProject`. Backup save dialog default `title-YYYYMMDD.munhaepkg`. Demo parent: `Documents/문해`, fallback `userData/demo`.

Native menu: darwin app menu only (About / Hide / Quit) plus Edit so Cmd+C/V work. Not a duplicate of the in-window menubar. Single-instance lock; `open-file` + `second-instance` argv.

Agent probe: `@munhae/agent-runtime` `probeAll()`, 15s cache. Overlaid onto `home.get()` so the home view has live CLI status.

## Files

```
apps/desktop/src/main/index.ts
apps/desktop/src/main/window.ts
apps/desktop/src/main/security.ts
apps/desktop/src/main/menu.ts
apps/desktop/src/main/ipc.ts
apps/desktop/src/main/ipc-validate.ts
apps/desktop/src/main/session.ts
apps/desktop/src/main/agents.ts
apps/desktop/src/main/app-config.ts
apps/desktop/src/main/errors.ts
apps/desktop/src/main/log.ts
apps/desktop/src/main/paths.ts
apps/desktop/src/main/zip.ts
apps/desktop/src/preload/index.ts
apps/desktop/src/preload/index.d.ts
apps/desktop/electron.vite.config.ts   (bundle @munhae/*, externalize better-sqlite3, preload CJS, renderer base ./)
apps/desktop/electron-builder.yml      (fileAssociations for .munhae / .munhaepkg)
apps/desktop/package.json              (productName, better-sqlite3, rebuild:native)
```

`window.munhae` matches `MunhaeApi`. Extra channels `appShowAbout` / `appOpenPath` are handled in main only (not on `MunhaeApi`).

## Verification

- `pnpm install` at repo root: ok. pnpm 10 **ignored** build scripts for `better-sqlite3`, `electron`, `esbuild` (needs `pnpm approve-builds` at root).
- `pnpm --filter @munhae/desktop typecheck`: fails `TS2307` on `@munhae/db-sqlite` (no `src/index.ts`). Other tsc errors are renderer (Agent 3).
- `pnpm --filter @munhae/desktop build`: fails resolving `@munhae/db-sqlite` package entry.

`electron-vite/node` has no runtime `is.dev`; `isDev()` is `import.meta.env.DEV || !app.isPackaged`.

## Concerns

1. **Agent 1 public API** — main imports `createProject`, `openProject`, `seedDemoProject`, `ProjectRepo`, `AppDb` from `@munhae/db-sqlite`. Runtime also accepts `openAppDatabase` (the name already in `packages/db-sqlite/src/app-db.ts`). Need `packages/db-sqlite/src/index.ts` exporting that contract.

2. **Bundled migrations** — `packages/db-sqlite/src/sql.ts` reads SQL from disk via `import.meta.url`. After electron-vite bundles the package into `out/main`, those relative paths will miss `infra/migrations`. Prefer `?raw` SQL imports or extraResources + `process.resourcesPath`.

3. **Native rebuild** — `better-sqlite3` is a direct desktop dependency and stays external. Root `pnpm.onlyBuiltDependencies` / `pnpm approve-builds` must allow `better-sqlite3` and `electron`. `rebuild:native` runs `electron-builder install-app-deps`. decisions.md says v13; workspace packages use `^11.10.0` — desktop matches Agent 1.

4. **Window.munhae typing** — preload `index.d.ts` declares `window.munhae: MunhaeApi` (required). Agent 3’s `renderer/scripts/shared.ts` uses `munhae?: MunhaeApi`. Combined `tsc` reports a modifier/type conflict. Align on the required form; preload always injects the API.

5. **createFromPaste** — creates a project then `createDocument({ originKind: "paste", sourceText })`. If `createProject` already inserts a root work, this adds a second node. Agent 1 could treat paste as filling the root instead.

6. **Open dialog** — Electron on Windows/Linux cannot mix file + directory pickers; `.munhaepkg` is reliable via `open-file` / argv / explicit path. macOS allows both.

7. **Unzip** — custom zip reader (method 0/8). No ZIP64. `project-format` zips with `fflate` (non-zip64 for demo size is fine).

8. **Packaging icon** — `build/icon.jpg` only. electron-builder wants png/icns/ico for store-quality icons.

9. **CSP** — renderer HTML (Agent 3). Not added in main.
