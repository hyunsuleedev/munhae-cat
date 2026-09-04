# Agent 3 — Renderer: port proto HTML into Electron MPA

You own **only**:

- `apps/desktop/src/renderer/`
- optional `apps/desktop/src/renderer/assets/`

Do not edit main/preload/packages.

Read:

- `proto/index.html` (welcome)
- `proto/project-home-v2.html`
- `proto/editor-v2.html`
- `proto/context-inspector-v2.html`
- `proto/knowledge-v2.html`
- `apps/desktop/src/shared/munhae-api.ts`
- `apps/desktop/electron.vite.config.ts` — MPA inputs: index, home, editor, inspector, knowledge

## Goal

Pixel-faithful port of the five demo screens into the Electron renderer, then **replace demo notify-stubs** for file/project/document/translation/knowledge with `window.munhae`.

Visual language is already designed. Do **not** invent a new aesthetic. Copy CSS variables, chrome, typography, hanmun serif stack, traffic-light dots, desk gradient, tags, tables, 3-pane editor.

## File layout

```
src/renderer/
  index.html          ← welcome (from proto/index.html)
  home.html
  editor.html
  inspector.html
  knowledge.html
  styles/
    tokens.css        ← :root variables shared
    chrome.css        ← menubar, win, sidebar, titlebar, statusbar, btn, dialog, notif, palette
    welcome.css
    home.css
    editor.css
    inspector.css
    knowledge.css
  scripts/
    shared.ts         ← $, esc, menubar, palette, notify, go(), cmd() fallbacks, clock
    welcome.ts
    home.ts
    editor.ts
    inspector.ts
    knowledge.ts
  assets/
    minhwa-cat.jpg
    minhwa-cat-cutout.png
```

electron.vite.config.ts already lists those HTML entries. Each HTML includes its CSS + `<script type="module" src="./scripts/….ts">`.

## CSP

```
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'; font-src 'self'; connect-src 'self'">
```

No inline `<script>` bodies. Inline *styles* in HTML attributes are OK (`style=`). Event handlers must be in TS, not `onclick=` attributes — convert them.

## Navigation

Replace `location.href = 'project-home-v2.html'` with relative:

- welcome → `home.html` after a project is open
- `go('home')` → `home.html`
- `go('editor')` → `editor.html?doc=` + documentNodeId (query param)
- `go('inspector')` → `inspector.html?doc=`
- `go('knowledge')` → `knowledge.html`

If no project is open, screen pages redirect to `index.html`.

## window.munhae

Assume preload exposes `window.munhae` (see munhae-api.ts). Guard:

```ts
const api = window.munhae;
if (!api) { document.body.innerHTML = "<p>preload missing</p>"; throw new Error("preload"); }
```

### Welcome (`index.html`)

- Keep layout, catwalk animation, menubar, palette
- Recent projects: `api.project.listRecent()`. Missing paths get muted styling
- **새 프로젝트**: `api.project.create({ title })` — prompt title via a small dialog (not notify-only). On success navigate to home.html
- **열기**: `api.project.open()`
- **원문 붙여넣어 시작**: dialog with title + textarea → `createFromPaste`
- Clicking a recent item: `api.project.open(path)` then home.html
- Add a fourth action if recent is empty: **훈민정음 데모 열기** → `api.project.seedDemo()` then home.html
- Show welcome checkbox bound to `app.getConfig/setConfig` `showWelcomeOnLaunch`
- `quit` → `api.app.quit()`
- `ai` → `api.app.probeAgents()` then notify real status
- Cat images: if assets are missing, hide `#catwalk` and use the 文 glyph in `.app-icon` (already in demo as fallback conceptually). Do not break the page.

### Home

Keep table, inspector, new-doc dialog, sidebar tree.

- Load `api.home.get()`
- Render document rows from `documents`
- Progress bars from `progress`
- Uncertainties / recent / agents from view
- New document form → `api.home.createDocument`
- Continue / open 御製序 → editor.html?doc=<id of 御製序 or selected>`
- Backup → `api.project.backup`
- Statusbar path from `project.packagePath`

Sidebar tree can still be derived from documents (group by parent). If that's hard, keep a simplified tree: Home, each top-level node, tools.

### Editor

Port the 3-pane editor, views (source/parallel/full), candidate tabs, merge/split/link dialogs, confirm, reflection, chat (read-only from `editor.chat`), history from candidates/versions if present.

- Load `api.editor.get(docId)`
- Editing a block contenteditable → debounce save via `saveDraft` **or** save on blur/commit (blur + merge/split). Do not save every keystroke if that's slow; save on blur and on 확정/합치기/나누기
- Confirm → `api.editor.confirm` with lock version if you have it; if EditorView doesn't include lockVersion, add a best-effort call and surface the error message
- Merge/split → corresponding API
- Candidate tab switch is local if both candidates are in the view
- Chat compose: if no send API, notify "M3에서 로컬 CLI 호출이 연결됩니다" — do not fake an LLM
- Term hover cards: can stay client-side from knowledge terms in the punctuated text (optional: fetch knowledge)

If `getEditor` fails (no source yet), show a paste box that creates source via a simple textarea + save. If create-source IPC is missing, notify and send user to home.

### Inspector

Port context inspector UI. Load `api.context.preview(docId)`. Render required/auxiliary lists, character/byte counts, manifest JSON. **번역 실행** button notifies that M3 will call Claude/Codex CLI; do not invent streaming.

### Knowledge

Port tabs. Load `api.knowledge.get()`. Add-entry dialog calls upsert*. Selecting a row shows inspector detail.

## Shared shell

Extract menubar/palette/notify/sidebar helpers to `scripts/shared.ts` so each page isn't 200 duplicated lines — but **keep the visual HTML the same**. ENABLED commands: wire real ones (newproj, open, quit, home, editor, inspector, knowledge, palette, backup, confirm, etc.). Disabled ones may notify.

Keyboard shortcuts from the proto must still work (⌘K, ⇧⌘1–4, ⌃⌘S, etc.). Use `metaKey || ctrlKey`.

## Copy rules

Never display the words `리비전` or `공개본`. Keep 번역안/확정/변경 이력/AI 제안.

## Assets

If `minhwa-cat.jpg` / cutout are not in the folder, do not dummy-broken img: use `onerror` to hide. You may create a simple SVG cat as placeholder.

## Do not

- Introduce React/Vue/Svelte
- Change the color tokens
- Use Inter/Roboto/Arial as the primary UI font (demo uses SF Pro / system-ui)
- Call fetch() to the internet

## When done

Write `docs/agent-briefs/03-renderer.report.md`. List screens and which commands hit IPC vs notify stubs.
