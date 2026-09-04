# Agent 3 — Renderer report

Pixel-faithful MPA port of `proto/*.html` into `apps/desktop/src/renderer/`. No React. Visual tokens/chrome copied from the proto. Inline scripts converted to TypeScript modules; `window.munhae` wired where the IPC contract exists.

`pnpm --filter @munhae/desktop exec electron-vite build` — renderer + main + preload all succeeded (18 renderer modules). Renderer `tsc` errors: none. Remaining desktop `tsc` failures are in `src/main/session.ts` (`@munhae/db-sqlite` missing) — Agent 1/2.

## Layout

```
apps/desktop/src/renderer/
  index.html          welcome
  home.html
  editor.html
  inspector.html
  knowledge.html
  styles/{tokens,chrome,welcome,home,editor,inspector,knowledge}.css
  scripts/{shared,welcome,home,editor,inspector,knowledge}.ts
  assets/minhwa-cat.jpg
  assets/minhwa-cat-cutout.png
```

Each HTML: CSP as specified, linked CSS, `<script type="module">`. No inline `<script>` bodies, no `onclick=`. Event handlers in TS. Shared menubar / palette / notify / `go()` / `cmd()` live in `scripts/shared.ts`.

Menubar left padding is 78px so macOS `hiddenInset` traffic lights (`x:16,y:18`) do not sit on 문해/파일.

## Screens

| Screen | File | Data |
|---|---|---|
| Welcome | `index.html` | `listRecent`, `create`, `open`, `createFromPaste`, `seedDemo`, `getConfig`/`setConfig`, `getVersion`, `quit`, `probeAgents` |
| Home | `home.html` | `getCurrent` (redirect if none), `home.get`, `createDocument`, `backup` |
| Editor | `editor.html?doc=` | `editor.get/saveDraft/confirm/revise/mergeBlocks/splitBlock`; terms from `knowledge.get` |
| Inspector | `inspector.html?doc=` | `context.preview`; target list from `home.get` |
| Knowledge | `knowledge.html` | `knowledge.get` + `upsertGlossary` / `upsertPerson` / `upsertPlace` |

Navigation: welcome → `home.html` after a project is open. `go('editor'|'inspector')` keeps `?doc=` (sessionStorage fallback). No project → screen pages redirect to `index.html`.

Copy: no `리비전` / `공개본`. Uses 번역안 / 확정 / 변경 이력 / AI 제안.

## Commands — IPC vs notify stubs

### Hit IPC (`window.munhae`)

| Command / action | API |
|---|---|
| 문해 정보 | `app.getVersion` then notify |
| 설정… | dialog → `app.getConfig` / `setConfig` |
| AI 연결 상태… | `app.probeAgents` then real status notify |
| 문해 종료 | `app.quit` |
| 새 프로젝트… | dialog → `project.create` → home |
| 프로젝트 열기… | `project.open` → home if a package was chosen |
| 원문 붙여넣어 시작 | dialog → `project.createFromPaste` → home |
| 훈민정음 데모 열기 | `project.seedDemo` → home (welcome action if recent is empty) |
| 최근 프로젝트 클릭 | `project.open(path)` → home (missing paths muted, not opened) |
| 시작 창 표시 체크 | `app.getConfig` / `setConfig` `showWelcomeOnLaunch` |
| 프로젝트 닫기 | `project.close` → index |
| 백업 만들기… | `project.backup` |
| 새 문서 node… | `home.createDocument` (home dialog; other pages stash flag and open home) |
| 홈 로드 / 사이드바 트리 | `home.get` |
| 편집 로드 | `editor.get(docId)` |
| 블록 blur / 채택 | `editor.saveDraft` |
| 번역안 확정 | `editor.confirm` (`expectedLockVersion` = candidate `versionNo`, best-effort) |
| 새 번역안으로 수정 | `editor.revise` |
| 다음 블록과 합치기 | `editor.mergeBlocks` |
| 블록 나누기 | `editor.splitBlock` (`splitAt` = textarea caret) |
| 앵커 연결 저장 | `editor.saveDraft` with updated `sourceAnchorIds` |
| 문맥 검사 로드 | `context.preview` |
| 용어·지식 로드 | `knowledge.get` |
| 용어/인물/지명 추가·저장 | `knowledge.upsert*` |

### Local UI (no IPC)

사이드바, 검사기/참고/문맥 패널, 명령 검색 ⌘K, 표점 전문/대조/번역 전문, 구조·앵커 ID 토글, 번역안 탭 전환, 변경 비교 대화상자, 문맥 검사 보조 항목 자동/고정/제외 (표시만, 미리보기 API에 반영하지 않음), 고양이 어슬렁.

### Notify stubs (no IPC / M3)

| Command | Message |
|---|---|
| 원문 가져오기… | 파일 가져오기 미연결. 붙여넣기 안내 |
| 내보내기… | 확정 번역 내보내기 미연결 |
| 번역 실행… | **M3에서 로컬 CLI 호출이 연결됩니다** (스트리밍 없음) |
| Reflection 다시 요청 | 편집: 문맥 검사로 이동. 검사기: M3 notify |
| 채팅 보내기 | 같은 M3 문구. LLM 응답 위조 없음. 기존 `editor.chat`만 표시 |
| 원문 저장 (편집 빈 문서) | create-source 채널 없음 → 홈으로 |
| 용어 보관 | delete API 없음 |
| 불확실성 해결 | 상태 변경 API 없음 |
| 나누기 안 확정 (검사기) | 문서 나누기 M3 |
| 도움말 / plan.md / schema.md | 저장소 루트 안내. `fetch()` 없음 |
| 최소화 / 확대 | 시스템 창 단추 |
| 찾기 (홈·지식 외) | 미연결 |
| 실행 취소·다시·잘라내기·복사·붙여넣기 메뉴 | 브라우저 기본 / no-op |

## Screen notes

**Welcome** — proto layout, catwalk, 文 fallback if cat images fail (`onerror` + `.is-fallback`). Recent rows from `listRecent()`; `missing` is muted. Empty recent shows **훈민정음 데모 열기**.

**Home** — document table from `documents`; progress / uncertainties / recent / agents from `HomeView`. Sidebar tree grouped by `parentId`. Continue opens 御製序 (`originalTitle`/`title` match) or the selected row.

**Editor** — 3-pane workspace, candidate tabs, merge/split/link/confirm dialogs, Reflection, history from `candidates`. Save on blur and before confirm/merge/split — not per keystroke. `get` failure or empty source → paste panel + notify (no create-source IPC). Chat compose does not invent an assistant reply.

**Inspector** — required/auxiliary lists, character + UTF-8 byte counts, `manifestJson`. Outcome `fits` | `requires_explicit_split`. **번역 실행** notifies M3 only.

**Knowledge** — four tabs; row select fills inspector; add dialog calls the matching upsert. Uncertainties are read-only.

## Concerns

- `ConfirmTranslationInput.expectedLockVersion` is not on `EditorView`; renderer sends `candidate.versionNo`. Wrong CAS will surface the IPC error string.
- No create-source / import-file / export / uncertainty-resolve / glossary-archive channels — those stay notify or home-create.
- Inspector pin/exclude is visual only until an aux-context IPC exists.
- Chat and 번역 실행 are intentionally non-LLM until M3.
