# Agent 1 report — domain, project-format, db-sqlite, agent-runtime

Status: DONE_WITH_CONCERNS

## Test commands and results

All four packages typecheck and pass vitest.

```bash
pnpm --filter @munhae/domain test        # PASS  8 tests
pnpm --filter @munhae/project-format test # PASS  5 tests
pnpm --filter @munhae/agent-runtime test  # PASS  3 tests
pnpm --filter @munhae/db-sqlite test      # PASS  9 tests

pnpm --filter @munhae/domain typecheck
pnpm --filter @munhae/project-format typecheck
pnpm --filter @munhae/agent-runtime typecheck
pnpm --filter @munhae/db-sqlite typecheck
```

Required cases covered:

1. create project → close → reopen same sqlite, same projectId/title
2. `PRAGMA foreign_keys` is 1 on `openSqlite`
3. save draft then confirm; edit after confirm creates a new draft; confirmed row text unchanged
4. two saves with the same `expectedLockVersion` — second throws `cas_conflict`
5. seed demo 御製序: anchors A001–A006, literal 4 blocks covering all required anchors, reader 2 blocks
6. merge two blocks → new version, previous version preserved
7. split with a single-anchor block → `relation_kind = partial` on both
8. manifest has no absolute path
9. agent `probeAll()` does not throw if CLI binaries are missing
10. SHA-256 of `""` is `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`

`better-sqlite3` native bindings were not present after the first `pnpm install` (Node v25.4.0). They were compiled with:

```bash
cd node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3
npm run build-release
```

## Files changed

### packages/domain
- `src/index.ts`
- `tests/domain.test.ts`
- `vitest.config.ts`
- `package.json` (`@types/node`)
- `tsconfig.json` (`allowImportingTsExtensions`)

### packages/project-format
- `src/index.ts`
- `tests/project-format.test.ts`
- `vitest.config.ts`
- `package.json` (`fflate`, `@types/node`)
- `tsconfig.json`

### packages/agent-runtime
- `src/index.ts`
- `tests/agent-runtime.test.ts`
- `vitest.config.ts`
- `package.json` (`@types/node`)
- `tsconfig.json`

### packages/db-sqlite
- `src/index.ts`, `views.ts`, `sqlite.ts`, `sql.ts`, `migrate.ts`, `rows.ts`, `app-db.ts`, `bootstrap.ts`, `translation.ts`, `project-repo.ts`, `seed-demo.ts`
- `tests/db-sqlite.test.ts`
- `vitest.config.ts`
- `package.json` (`@types/node`)
- `tsconfig.json`
- `migrations/sqlite/001_init.sql` (runtime copy)
- `migrations/app/001_init.sql` (runtime copy)

### infra
- `infra/migrations/sqlite/001_init.sql`
- `infra/migrations/app/001_init.sql`

### lockfile
- `pnpm-lock.yaml` (fflate, `@types/node`)

## Exported API

### `@munhae/domain`
- `createId()`, `nowIso()`, `sha256Hex(text)`, `codepointCount(text)`, `sliceCodepoints(text, from, to)`, `utf8ByteLength(text)`
- `canonicalJson(value)`, `canonicalJsonHash(value)`, `sortKeys(value)`
- `joinBlockTranslations(translations)`, `blockTargetRanges(translations)`
- `type VersionState`, `VERSION_UI`
- `class MunhaeError` (`code`, `message`)

### `@munhae/project-format`
- `createPackageDir({ parentDir, title, projectId, createdAt })` → `{ packagePath, manifest }`
- `readManifest(packagePath)`, `validateManifest(json)`
- `acquireLock(packagePath)`, `releaseLock(packagePath)` — `.lock` with pid; steal if dead; throw `project_locked` if alive
- `checkpointAndZip(packagePath, destFile)` — zip of the directory (skips `.lock` / WAL/SHM)
- `sanitizeFolderTitle(title)`, types `ProjectManifest`

### `@munhae/db-sqlite`
- `openSqlite(filePath)` — `foreign_keys=ON`, WAL, busy_timeout=5000
- `openAppDatabase(userDataDir): AppDb`
- `class AppDb` — `listRecent`, `upsertRecent`, `markMissing`, `getPreference`, `setPreference`, `close`
- `createProject({ title, parentDir, actorDisplayName? })` → `{ handle, summary }`
- `openProject(packagePath): ProjectRepo`
- `seedDemoProject(parentDir): ProjectRepo`
- `class ProjectRepo` — `packagePath`, `projectId`, `title`, `openedAt`, `close`, `checkpoint`, `backupTo`, `getHome`, `createDocument`, `getEditor`, `saveTranslationDraft`, `confirmTranslation`, `reviseTranslation`, `mergeBlocks`, `splitBlock`, `getKnowledge`, `upsertGlossary`, `upsertPerson`, `upsertPlace`, `previewContext`
- View types copied in `src/views.ts` (do not import from `apps/desktop`)

### `@munhae/agent-runtime`
- `createClaudeAdapter()`, `createCodexAdapter()`, `probeAll()`
- `interface AgentAdapter { probe() }`
- `sanitizeEnv(env)`, `redactSecrets(text)`
- No `run()` LLM calls

## Concerns

1. **View extras vs `munhae-api.ts`.** `EditorView.lockVersion` is required so main/renderer can pass `expectedLockVersion` into `confirmTranslation`. `SaveTranslationDraftInput` / `MergeBlocksInput` / `SplitBlockInput` accept optional `expectedLockVersion` for CAS. Agent 2 should use these fields; they are not yet on the IPC types.

2. **`HomeView.agents` is always `[]`.** `ProjectRepo` does not probe CLIs. Electron main should merge `probeAll()` into the home payload.

3. **`better-sqlite3` native module.** Tests need a Node-ABI build. `pnpm install` did not compile it here (Node 25). Rebuild before `pnpm --filter @munhae/db-sqlite test`. Electron will need its own rebuild against Electron's headers.

4. **`document_translation_versions.version_no`.** schema.md §12 omits it; other version tables have it, and `EditorView.versionNo` needs it. Added as `INTEGER NOT NULL`.

5. **SQL is duplicated.** Runtime loader looks at `packages/db-sqlite/migrations/` then `infra/migrations/`. Keep them in sync.

6. **M0 tables skipped** (comment at top of `001_init.sql`): `search_*`, import/export jobs, `background_jobs`, `derived_artifacts`, `translation_split_plans*`, `ai_token_preflights`, `translation_quality_checks`, workflow_* .

7. **Uncertainty display ids.** DB ids are UUIDv7. Home labels start with `U-01` / `U-02` / `U-03` in `statement_md`. Locators are `御製序 · A002` etc.

8. **Confirm is the only in-place version UPDATE**, and only the `state` column (`draft` → `confirmed`). Text is never updated. Subsequent edits insert a new draft and CAS the head.

9. **Lock on open.** `createProject` / `openProject` / `seedDemoProject` acquire `.lock`; `close()` releases it. A second open of the same package throws `project_locked`.
