# 문해 (Munhae Studio)

고한문 번역가와 연구자를 위한 로컬 Electron CAT 도구. 회원가입 없이 `.munhae` 프로젝트(SQLite + assets)로 원문·표점·번역·용어를 관리한다.

Phase 1 범위와 데이터 모델은 `plan.md`, `schema.md`를 따른다. 화면의 시각 기준은 `proto/` HTML 데모다.

## 요구 사항

- Node.js ≥ 22.12
- pnpm 10

## 개발

```bash
pnpm install
pnpm --filter @munhae/desktop rebuild:native
pnpm dev
```

pnpm 10이 `electron` / `better-sqlite3` 설치 스크립트를 건너뛰면:

```bash
node node_modules/electron/install.js
# 테스트용 Node ABI
(cd node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3 && npm run build-release)
# Electron ABI
pnpm --filter @munhae/desktop rebuild:native
```

## 패키징 (electron-builder)

```bash
pnpm dist
```

산출물은 `apps/desktop/release/`.

## 워크스페이스

- `apps/desktop` — Electron main / preload / renderer
- `packages/domain` — ID, hash, code-point, version 용어
- `packages/project-format` — `.munhae` 디렉터리 패키지와 `.munhaepkg` 백업
- `packages/db-sqlite` — 프로젝트·앱 SQLite, command
- `packages/agent-runtime` — Codex/Claude CLI probe (토큰 미저장)
