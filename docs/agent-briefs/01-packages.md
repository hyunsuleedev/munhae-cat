# Agent 1 — domain, project-format, db-sqlite, agent-runtime

You are implementing the **data layer** of Munhae Studio (문해 CAT), an Electron CAT tool. Work **only** in:

- `packages/domain/`
- `packages/project-format/`
- `packages/db-sqlite/`
- `packages/agent-runtime/`
- `infra/migrations/sqlite/`
- tests next to those packages

Do **not** edit `apps/desktop/` except if you must add a dependency to a package.json you own. Do not edit `plan.md` / `schema.md`.

Read first:

- `/Users/hyunsulee/munhae-cat/plan.md` (especially §7–8, §13–14, §18)
- `/Users/hyunsulee/munhae-cat/schema.md` (Phase 1 tables, invariants §21, indexes §20)
- `/Users/hyunsulee/munhae-cat/docs/decisions.md`
- `/Users/hyunsulee/munhae-cat/apps/desktop/src/shared/munhae-api.ts` (view types the UI expects)

## Non-negotiables

- IDs: UUIDv7 as TEXT (`uuid` package `v7()`)
- Times: RFC 3339 TEXT UTC (`new Date().toISOString()`)
- Hash: SHA-256 of UTF-8 bytes, lowercase hex (`node:crypto`)
- Code-point ranges: Unicode code points via `Array.from(str)`, NEVER UTF-16 `.length`
- Version rows: append-only. Never UPDATE content of a version row
- Confirmed versions: immutable. Edits create a new draft
- Head updates: CAS on `lock_version`
- `PRAGMA foreign_keys = ON` on every connection; verify it is 1
- WAL mode, single writer
- No OAuth tokens, API keys, or credentials in any DB or manifest
- User-facing copy never says `리비전` or `공개본`. Use 원문안/표점안/번역안, 확정, 변경 이력, AI 제안
- `term_kind` exists on glossary_entries even though schema.md 13.1 omits it — plan.md includes it (`general | office | book_title | institution | era | technical | other`)

## packages/domain

Export from `src/index.ts`:

```ts
export function createId(): string; // uuid v7
export function nowIso(): string;
export function sha256Hex(text: string): string;
export function codepointCount(text: string): number;
export function sliceCodepoints(text: string, from: number, to: number): string;
export function utf8ByteLength(text: string): number;
export type VersionState = "draft" | "confirmed" | "rejected" | "superseded";
export const VERSION_UI = {
  draft: "작업안",
  confirmed: "확정",
  rejected: "제외됨",
  superseded: "변경 이력",
} as const;
```

Also export small helpers for canonical JSON hashing (sorted keys, no extra whitespace) used by punctuation content_hash and request_manifest_hash.

Tests: uuid format, hash stability, Korean/Hanja code-point slicing (`"한글".` and `"國之"`), UTF-8 byte length of `"가"` is 3.

## packages/project-format

`.munhae` is a **directory**, not a zip.

```
<title>.munhae/
  manifest.json
  project.sqlite3
  assets/originals/
  assets/derivatives/
  indexes/
```

`manifest.json` (formatVersion 1):

```json
{
  "format": "io.munhae.project",
  "formatVersion": 1,
  "projectId": "<uuidv7>",
  "title": "...",
  "storageMode": "local",
  "database": "project.sqlite3",
  "assetRoot": "assets",
  "createdAt": "<rfc3339>",
  "minimumAppVersion": "0.1.0"
}
```

API:

- `createPackageDir({ parentDir, title, projectId, createdAt })` → `{ packagePath, manifest }`
  - Sanitize title for folder name (keep Hangul). If collision, append `-2`, `-3`
  - Create dirs, write manifest (no absolute paths, no secrets)
- `readManifest(packagePath)`
- `validateManifest(json)` — reject extra secret-looking keys: token, apiKey, authorization, cookie, password
- `acquireLock(packagePath)` / `releaseLock(packagePath)` using `.lock` file with pid. If lock exists and pid is dead, steal it. If pid alive, throw `project_locked`
- `checkpointAndZip(packagePath, destFile)` — `.munhaepkg` is a zip of the directory after telling caller to checkpoint SQLite (db-sqlite will checkpoint first)

Tests with a temp dir.

## infra/migrations/sqlite

Write `001_init.sql` covering Phase 1 tables from schema.md that the demo needs. Skip Phase 2 (users, workspaces, releases, outbox). You MAY skip: search_*, import_*, export_*, background_jobs, derived_artifacts, translation_split_plans* for M0 **if** you document it in a comment at the top — but include the core translation/anchor/glossary/chat/provenance tables.

Must include:

- meta_schema_migrations, meta_project_state
- core_actors, core_projects, core_project_settings
- core_translation_policies, _versions, _heads
- document_nodes
- src_assets, src_asset_locations, src_asset_pages, src_node_assets
- src_texts, src_text_versions, src_text_heads
- punctuation_sets, punctuation_versions, punctuation_structure_spans, punctuation_heads
- translation_anchor_sets, translation_anchors, translation_anchor_structure_spans
- document_translations, document_translation_versions, document_translation_heads
- translation_blocks, translation_block_anchors
- document_translation_validations, document_translation_validation_findings
- reflection_reports, reflection_report_translation_versions, reflection_findings, reflection_finding_anchors
- translation_staleness
- glossary_entries (WITH term_kind)
- persons, places
- uncertainties, uncertainty_versions, uncertainty_options, uncertainty_anchors
- context_items
- chat_threads, chat_messages, chat_message_parts, chat_agent_sessions
- provenance_artifacts, provenance_lineage_edges
- user_edits (optional but preferred)

Use STRICT tables. Add the unique indexes from schema.md §20 that apply.

`app.sqlite3` migrations in `infra/migrations/app/001_init.sql`:

- app_preferences, app_recent_projects, app_window_state, app_devices, app_ai_connections, app_runtime_sessions, app_pending_diagnostics

## packages/db-sqlite

`better-sqlite3`. Wrap connections:

```ts
export function openSqlite(filePath: string): Database {
  const db = new Database(filePath);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  if (db.pragma("foreign_keys", { simple: true }) !== 1) throw new Error("foreign_keys off");
  return db;
}
```

Migration runner: apply SQL files in order, record checksum in meta_schema_migrations.

### Public API (this is the contract Electron main will import)

```ts
export type OpenAppDb = (userDataDir: string) => AppDb;

export class AppDb {
  listRecent(): RecentProject[];
  upsertRecent(row: { projectId: string; displayName: string; packagePath: string }): void;
  markMissing(packagePath: string): void;
  getPreference(key: string): unknown;
  setPreference(key: string, value: unknown): void;
  close(): void;
}

export function createProject(opts: {
  title: string;
  parentDir: string;
  actorDisplayName?: string;
}): { handle: ProjectRepo; summary: { projectId: string; title: string; packagePath: string; storageMode: "local"; openedAt: string } };

export function openProject(packagePath: string): ProjectRepo;
export function seedDemoProject(parentDir: string): ProjectRepo;

export class ProjectRepo {
  readonly packagePath: string;
  readonly projectId: string;
  readonly title: string;
  close(): void;
  checkpoint(): void;
  backupTo(destFile: string): void; // checkpoint then zip via project-format

  getHome(): HomeView; // type from munhae-api.ts — duplicate the shape, don't import from apps/
  createDocument(input: CreateDocumentInput): DocumentListItem;
  getEditor(documentNodeId: string): EditorView;
  saveTranslationDraft(input: SaveTranslationDraftInput): EditorView;
  confirmTranslation(input: { documentNodeId: string; stage: string; expectedLockVersion: number }): EditorView;
  reviseTranslation(documentNodeId: string, stage: string): EditorView;
  mergeBlocks(input: MergeBlocksInput): EditorView;
  splitBlock(input: SplitBlockInput): EditorView;
  getKnowledge(): KnowledgeView;
  upsertGlossary(entry: Omit<GlossaryEntryView, "id"> & { id?: string }): GlossaryEntryView;
  upsertPerson(person: Omit<PersonView, "id"> & { id?: string }): PersonView;
  upsertPlace(place: Omit<PlaceView, "id"> & { id?: string }): PlaceView;
  previewContext(documentNodeId: string): ContextPreview;
}
```

**Do not import from `apps/desktop`.** Copy the view type shapes into `packages/db-sqlite/src/views.ts` (keep them in sync with munhae-api.ts).

On `createProject`:

1. create package dir + manifest
2. create project.sqlite3, run migrations
3. insert core_actors (human local user + system)
4. insert core_projects, settings
5. insert default translation policy version (two_step + Reflection, target_locale ko, source_language lzh) as confirmed
6. insert a root document_node (work) titled with the project title

On `saveTranslationDraft` / merge / split:

- Insert a NEW document_translation_version with parent_version_id = current
- Rebuild ALL translation_blocks + translation_block_anchors for that version
- CAS update head.current_version_id / lock_version
- Compute target_codepoint_from/to from concatenated text_content using a single separator `" "` (space) between blocks — match the demo `joinBlocks`
- Validate coverage; if recoverable issues, set validation_state `needs_review` still save
- Confirm is rejected if needs_review or already confirmed

On `confirmTranslation`:

- Refuse if validation_state !== valid
- Insert nothing that mutates the version text; set version.state = confirmed (WAIT — versions are append-only. Schema says confirmed version is a state on the version row. Setting state from draft → confirmed on the SAME row is the one allowed state transition, OR insert a new confirmed version copying content. Prefer: UPDATE only the `state` column of the current draft to `confirmed` and set heads.confirmed_version_id. This is the standard head/version pattern. Do not change text_content.)

### seedDemoProject

Create `훈민정음 문헌 번역.munhae` under parentDir with the 御製序 fixture from `proto/editor-v2.html` and `proto/project-home-v2.html`:

Source (no punctuation marks):
`國之語音異乎中國與文字不相流通故愚民有所欲言而終不得伸其情者多矣予爲此憫然新制二十八字欲使人人易習便於日用耳`

Punctuated:
`國之語音，異乎中國，與文字不相流通，故愚民有所欲言，而終不得伸其情者多矣。予爲此憫然，新制二十八字，欲使人人易習，便於日用耳。`

Anchors A001–A006 exactly as in proto/editor-v2.html ANCHORS (clause/sentence, quotes including punctuation).

Structure spans: 1 paragraph covering all, 2 sentences.

Document tree as in proto home DOCS: 解例本 work, 御製序, 例義, 解例 chapter + 6 sections, 鄭麟趾 序, 世宗實錄 volume. Only 御製序 needs full source/punctuation/anchors/translations. Other nodes can be empty or partial.

Translations:

- stage `literal` current draft v2 (user-edited blocks from CANDIDATES.literal)
- stage `reader` AI draft from CANDIDATES.reader
- 例義 can have a confirmed translation stub (short placeholder) so progress shows 1 confirmed

Glossary from TERMS in editor-v2.html. Persons: 世宗, 鄭麟趾. Place: 中國. Uncertainties U-01, U-02, U-03 as in the home inspector.

Default editor document id must be stable enough that the renderer can open 御製序. Return it as the first source-bearing node; include originalTitle 御製序.

Context preview: required punctuated source + anchor manifest + policy; auxiliary glossary/person/place/uncertainty/context_items; characterCount and utf8ByteCount of the assembled prompt-ish string; outcome `fits`. Do not call any tokenizer.

## packages/agent-runtime

```ts
export interface AgentAdapter {
  probe(): Promise<{
    agentId: "codex" | "claude";
    installed: boolean;
    loggedIn: boolean | null;
    version: string | null;
    lastCheckedAt: string;
    detail: string;
  }>;
}
export function createClaudeAdapter(): AgentAdapter;
export function createCodexAdapter(): AgentAdapter;
export function probeAll(): Promise<...[]>;
```

Implementation:

- Resolve binary via `which`/`where` without a shell string: `execFile("which", ["claude"])` (or `command -v` via execFile of `sh` with args array `["-lc", "command -v claude"]` is OK if args array)
- `execFile(bin, ["--version"], { timeout: 4000, env: sanitized })`
- Login heuristic: claude — `claude auth status` if it exists, else look for `~/.claude` config file presence (NOT file contents). Codex — `~/.codex` similarly. Never read token files.
- Sanitize env: pass through PATH, HOME, LANG, TERM; strip AWS/GOOGLE/OPENAI keys, AUTHORIZATION
- Never log stdout if it might contain tokens; redaction helper that masks Bearer and sk- patterns

No `run()` LLM calls in this milestone.

## Tests (vitest)

Must pass:

1. create project → close → reopen same sqlite, same projectId/title
2. foreign_keys pragma is on
3. save draft then confirm; editing after confirm creates a new draft (confirmed row text unchanged)
4. CAS: two save attempts with stale lock_version — second throws
5. seed demo: 御製序 editor view has 6 anchors A001–A006, literal 4 blocks covering all required anchors, reader 2 blocks
6. merge two blocks → new version, previous version preserved
7. split with partial → relation_kind partial on both
8. manifest has no absolute path
9. agent probe does not throw if binary missing
10. SHA-256 of empty string is `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`

Run: `pnpm --filter @munhae/domain test` etc. Add vitest.config.ts per package (`include: ["tests/**/*.test.ts"]`).

## When done

Write `docs/agent-briefs/01-packages.report.md` with files changed, test commands + results, exported API list, and any concerns.

Do not commit unless tests pass.
