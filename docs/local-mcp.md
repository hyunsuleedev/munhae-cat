# 로컬 MCP — Claude Code·Codex에서 문해 다루기 (설계, 2026-09-29)

상태: 1~3단계 구현(2026-09-30). `plan.md` §15.12 R1을 구체화한다.

## 구현 현황 (2026-09-30)

- 서버: `apps/desktop/src/main/mcp-server.ts`(Streamable HTTP, JSON 응답, `127.0.0.1:27183/mcp`), 도구 처리는 `mcp-handlers.ts`, 앱 연결·중계 명령·연결 화면 IPC는 `mcp-connect.ts`, 변경 기록과 되돌리기는 `mcp-changes.ts`.
- 중계: `mcp-relay.ts`를 `out/main/mcp-relay.js`로 빌드한다. 앱이 켤 때마다 `~/.munhae/bin/munhae-mcp`를 현재 앱 위치로 다시 쓴다. 도구 정의는 `shared/mcp-tools.ts` 한 곳에 있고 중계에도 번들된다.
- 도구: 읽기 7개, 쓰기 9개(`edit_translation_sentences`, `replace_translation`, `confirm_translation`, `add_comment`, `propose_terms`, `confirm_terms`, `dismiss_term_candidates`, `update_terms`, `undo_change`).
- 되돌리기: 용어는 db-sqlite의 `snapshotTermRows`/`restoreTermRows`로 문서의 용어 행을 통째로 복원한다. 번역 확정은 `unconfirmTranslation`으로 되돌린다. 번역 문장·전문은 편집기와 같은 묶음 저장 경로로 이전 글과 원문 연결을 다시 저장한다. 빈 번역안으로 돌아갈 때는 번역안을 초기화한다.
- 화면: 쓰기와 되돌리기 뒤에 `munhae:mcp:changed` 이벤트를 보내면, 각 화면이 `registerProjectRefresh`로 등록한 새로 고침을 다시 쓴다. 알림에 되돌리기 버튼을 두고, 편집기 이력 탭에 이번 실행의 변경 목록을 보여 준다.
- 편집 중 거절: 편집기가 `mcp.reportEditing`으로 미저장 문서를 알린다.
- 남은 일:
  - 용어집 페이지는 MCP 변경 뒤 자동으로 다시 읽지 않는다.
  - MCP로 만든 번역 버전은 이력에 "로컬 사용자"로 표시된다.
  - 연결 화면의 `claude/codex/agy mcp add` 실행은 실제 설정 파일로는 아직 시험하지 않았다.
  - 4단계(화면 조작 도구), 플러그인 규칙, 보안 강화.

## 목표

사용자가 Claude Code·Codex 대화에서 열려 있는 문해 프로젝트를 읽고 고칠 수 있게 한다. 예를 들어 "이 문서 용어 목록 보여 줘" 다음에 "전부 확정해"라고 하면 그대로 처리돼야 한다.

앱 버튼으로 시작하는 기존 AI 실행(일회성 CLI 실행과 실행별 제출 권한)은 그대로 둔다. MCP는 그 옆에 추가하는 두 번째 경로다. AI 비용은 사용자의 CLI 구독이 부담한다.

## 결정 사항 (2026-09-29)

1. 외부 AI의 쓰기는 바로 반영하고, 사용자가 되돌릴 수 있게 한다. `plan.md` R1의 "초안으로 저장하고 편집기에서 수락"을 대체한다.
2. 도구는 문해 작업 단위로 만든다. DB나 파일을 직접 열지 않는다. 기존 앱 도구 핸들러처럼 `입력 → 검증 → repository 반영`을 재사용한다.
3. 앱이 실행 중일 때만 동작한다. 앱이 꺼져 있으면 분명하게 실패한다.
4. 보안 강화(배포 앱 디버거 차단, 토큰 인증)는 뒤로 미룬다. Paper와 같은 기본 방어만 처음부터 둔다.
5. 앱 AI 작업과 겹치면 문서 단위로 막는다.
6. 연결 방식은 Paper를 따른다(아래 "연결 방식").
7. 되돌리기 기록은 메모리에만 두고, 앱을 끄면 지운다.
8. 용어 단계는 확정까지 MCP로 할 수 있게 한다.
9. 서버는 Paper처럼 앱이 켜져 있는 동안 항상 연다. 켜고 끄는 설정은 두지 않는다.
10. 번역 확정도 MCP로 할 수 있게 한다(`confirm_translation`).

## 세션 모델

앱이 시작하는 AI 실행과 MCP로 붙는 외부 AI는 성격이 다르다.

| | 앱 AI 실행 | 외부 MCP 세션 |
|---|---|---|
| 시작·종료 | 앱이 안다 | 앱이 모른다. 대화가 몇 시간 열려 있을 수 있다 |
| 반영 방식 | 시작할 때 기준(head)을 찍고, 끝날 때 기준을 비교(CAS)해 반영 | 도구 호출 하나가 짧은 작업 하나 |
| 잠금 | 프로젝트당 하나(`hasActiveAiRuns`) | 세션 전체는 잠그지 않음 |
| 대화 저장 | 채팅만 스레드별 CLI 세션을 이어 쓰고, 나머지는 매번 새 세션 | 대화는 외부 CLI에 남고 문해에는 저장하지 않음 |

- 읽기 도구는 잠금 없이 동작한다.
- 쓰기 도구는 호출 순간 검증과 저장을 한 트랜잭션으로 끝낸다. 그래서 앱 AI 실행의 기준 스냅샷과 섞이지 않는다.
- 세션 식별: MCP `initialize`의 `clientInfo.name`(예: Claude Code, Codex)과 서버가 발급한 세션 ID(`mcp-session-id`)를 쓴다. 편집기 표시("Claude Code가 수정")와 되돌리기 묶음에 사용한다.
- 문해에 남는 것은 도구로 바뀐 내용뿐이다. 앱 안 AI 채팅과는 별개다.

## 잠금: 문서 단위

- 앱 AI 작업이 문서 X에서 돌고 있으면 X에 대한 MCP 쓰기를 거절한다. 오류 코드는 `document_busy`이고 메시지는 "문해에서 이 문서의 AI 작업이 진행 중입니다. 끝난 뒤 다시 시도하세요."이다.
- 읽기와 다른 문서에 대한 쓰기는 허용한다.
- 문서를 쓰지 않는 앱 채팅은 막지 않는다.
- 문서가 정해지지 않은 작업(자료 정리)이 돌고 있으면 프로젝트 전체 쓰기를 막는다.
- 구현하려면 두 곳을 바꿔야 한다.
  - 번역, 표점 제안 같은 실행은 `runs`의 `AiRunView.documentNodeId`로 판정한다.
  - 용어 추출, 각주 분석, 읽기 분석은 `registerExternalAiActivity`에 문서 ID를 새로 넘겨야 한다.
- MCP 쓰기는 앱 AI 실행의 시작을 막지 않는다.
- 사용자가 편집기에서 그 문서를 고치다가 아직 저장하지 않았으면 쓰기를 거절한다(`document_editing`). 이를 위해 편집기가 main에 문서별 미저장 상태를 알리는 IPC를 새로 둔다.
- 모든 도구는 `projectId`를 받는다. 사용자가 그사이 프로젝트를 바꿨으면 `project_changed`로 거절한다.
- 참고: 앱이 직접 띄우는 Claude·Codex·Antigravity 실행도 사용자 설정에 등록된 문해 MCP를 볼 수 있다. 앱은 CLI의 사용자 MCP 설정을 끄지 않는다(§11.2). 같은 문서에 대한 쓰기는 위 잠금이 막는다.

## 연결 방식: Paper처럼

### Paper가 하는 방식

설치된 Paper Desktop 앱 번들을 직접 확인했다.

- 앱이 켜지면 MCP 서버를 `http://127.0.0.1:29979/mcp`에 항상 연다. 켜고 끄는 설정은 없다.
- 기본 방어:
  - `Origin` 헤더가 있는 요청은 거절한다(브라우저 차단).
  - `Host`가 `127.0.0.1:29979`나 `localhost:29979`가 아니면 거절한다(DNS rebinding 방지).
  - Bearer 토큰은 화면 없이 도는(headless) 모드에서만 검사한다.
- 중계 CLI를 `~/.paper/bin/paper`에 설치한다.
- 사용자가 앱에서 연결할 AI 도구를 고르면, 앱이 그 도구의 설정 파일에 `paper mcp`(stdio) 항목을 직접 써 넣는다.
  - Claude Code: `~/.claude.json`
  - Codex·ChatGPT: `~/.codex/config.toml`
  - Antigravity: `~/.gemini/antigravity/mcp_config.json`
  - GitHub Copilot, OpenCode
  - 기존 설정 파일이 올바르지 않으면 건드리지 않는다.
- 중계 CLI는 요청을 로컬 서버로 넘기면서 `x-paper-from: CLI` 헤더로 출처를 표시한다.
- 이 컴퓨터의 Codex 설정(`url = "http://127.0.0.1:29979/mcp"`)과 Claude Code의 Paper 플러그인은 이전 방식인 HTTP URL 직접 등록이다.

### 문해에 적용

- **서버**: main에서 `@modelcontextprotocol/sdk`(아직 의존성에 없음)로 Streamable HTTP 서버를 `127.0.0.1:<고정 포트>/mcp`에 연다.
  - Paper와 같은 Origin·Host 검사를 둔다.
  - 포트가 이미 쓰이고 있으면 서버를 열지 않고 설정 화면에 표시한다.
- **중계 명령**: `~/.munhae/bin/munhae-mcp`(Windows는 `.cmd`)를 둔다.
  - 앱을 켤 때마다 현재 앱 위치로 이 파일을 다시 쓴다. 그래서 앱을 업데이트하거나 옮겨도 등록한 명령이 그대로 동작한다.
  - 하는 일: 앱의 Electron 실행 파일을 `ELECTRON_RUN_AS_NODE=1`로 실행해 번들된 중계 스크립트를 돌린다.
  - 나중에 Electron fuse를 설정할 때 `RunAsNode`는 켜 둬야 한다.
- **도구 정의**: 공유 모듈 하나에 두고 서버와 중계 스크립트에 함께 번들한다.
  - 앱이 꺼져 있어도 중계가 도구 목록은 보여 준다.
  - 도구를 부르면 "문해가 실행 중이 아닙니다. 문해를 열고 다시 시도하세요."를 오류 결과로 돌려준다(결정 3).
- **연결 화면**: 설정의 "AI 도구 연결"에서 Claude Code, Codex, Antigravity를 고르면 각 CLI의 `mcp add` 명령으로 `munhae`를 등록한다(`claude mcp add --scope user`, `codex mcp add`, `agy mcp add`). Paper는 설정 파일을 직접 고치지만, CLI 명령을 쓰면 CLI가 같은 파일을 쓰는 중에 겹치지 않는다. 연결 여부는 각 설정 파일을 읽기만 해서 확인한다.
  - 파일을 읽을 수 없거나 형식이 올바르지 않으면 건드리지 않고 이유를 보여 준다.
  - 이미 등록돼 있으면 그대로 둔다.
  - 연결 해제도 같은 화면에서 한다.

## 도구 (1차)

### 읽기

| 도구 | 내용 | repository |
|---|---|---|
| `get_open_project` | 열린 프로젝트 ID·제목·번역 언어, 문서 트리(ID, 제목, 원문 확정·표점·용어·번역 단계) | `getHome` |
| `get_document` | 메타데이터, 저장된 원문(확정 표점본이 있으면 그 전문), 번역 전문과 문장 목록(문장 ID, 원문 연결 범위, 검토 필요 표시), 번역 상태, 쓰기에 쓸 `revision` | `getEditor`, `getDocumentMetadata` |
| `search_project` | 원문·번역 검색 | `search` |
| `get_terms` | 문서의 용어 후보(ID, 표기, 독음, 번역, 뜻, 출현 위치, 근거)와 확정 용어(ID, `lockVersion`), 프로젝트 용어집에서 겹치는 항목 | `getDocumentTerms`, `getProjectTerms` |
| `list_comments` | 문서 코멘트 | `listReviewComments` |
| `get_materials` | 참고 자료 | `getMaterials` |
| `get_translation_guide` | 프로젝트 번역 원칙과 번역 스킬(플러그인 포함). 외부 AI도 앱 실행과 같은 원칙을 따르게 한다 | `getTranslationSkill`, 번역 원칙 |

### 쓰기 (바로 반영, 되돌리기 가능)

| 도구 | 내용 | repository |
|---|---|---|
| `edit_translation_sentences` | `documentId`, `revision`, `edits[{sentenceId, text}]`. 문장 단위로 고치고 원문 연결은 유지한다 | `saveTranslationDraft`의 묶음 저장 경로 |
| `replace_translation` | `documentId`, `revision`, `text`. 전문을 교체한다. 번역이 없는 문서에는 새 번역안을 만든다. 원문 연결은 다시 필요한 상태가 된다 | `saveTranslationDraft`, `createTranslationDraft` |
| `add_comment` | `documentId`, 대상(원문/번역, 인용, 출현 순번), 본문 | `createReviewComment` |
| `propose_terms` | `documentId`, 새 용어 후보 목록 | `storeTermCandidates` |
| `confirm_terms` | `documentId`, `items[{candidateId, 고칠 독음·번역·뜻·종류·이 글에서의 풀이·확신(confidence)·다른 해석(alternatives)}]`. 후보를 그 출현 위치 그대로 확정한다. 여러 개를 한 트랜잭션으로 처리해 전부 성공하거나 전부 실패한다. "전부 확정"은 `get_terms`로 받은 후보 ID를 모두 넘기면 된다 | `confirmTerm` |
| `dismiss_term_candidates` | `documentId`, `candidateIds[]` | `dismissTermCandidate` |
| `update_terms` | `items[{termId, expectedLockVersion, 독음·번역·뜻·종류}]`. 여러 문서가 함께 쓰는 용어 내용만 고친다. 문서별 판단(이 글에서의 풀이, 확신 정도, 다른 해석)은 후보를 넣거나 확정할 때 정한다 | `updateTerm` |
| `confirm_translation` | `documentId`, `revision`. 번역안을 확정한다. 편집기의 확정 버튼과 같은 검사를 거친다 | `confirmTranslation` |
| `undo_change` | `changeId`. 같은 세션이 만든 변경만 되돌린다 | 아래 "되돌리기" |

- 용어는 확정 표점본의 위치에 걸린다. 확정 표점이 없는 문서에서는 용어 도구가 "이 문서는 표점을 먼저 확정해야 용어를 다룰 수 있습니다"로 멈춘다.
- 1차에 넣지 않는 것:
  - 원문·표점 수정: 용어와 읽기 주석이 여기에 앵커로 걸려 있다.
  - 확정 용어 삭제. AI가 방금 한 확정은 되돌리기로 취소한다.
  - 프로젝트 열기·전환.
  - 설정 변경.
- 2차에 넣을 화면 조작 도구: `open_document`, `focus_sentence`(편집기에서 해당 문장으로 이동해 강조).

### 공통 규칙

- 번역 쓰기는 `get_document`에서 받은 `revision`을, 용어 수정은 `lockVersion`을 요구한다. 값이 다르면 `stale_revision`으로 거절하고 "그사이 바뀌었습니다. 다시 읽으세요"라고 알린다.
- 오류는 두 종류로 나눠 돌려준다.
  - AI가 고칠 수 있는 형식 오류: `invalid_input`에 이유를 붙인다.
  - 멈춰야 하는 오류: `document_busy`, `document_editing`, `project_changed`, `not_found`, `app_not_running`. 여기에는 "사용자에게 알리고 멈추라"는 안내를 붙인다. 2026-09-28 Antigravity가 제출 제한을 디버거로 우회한 사례 때문이다.
- 서버 `instructions`에 넣을 내용:
  - 도구 외의 방법으로 문해 데이터·파일·프로세스·포트에 접근하지 말 것.
  - 번역을 고치기 전에 `get_translation_guide`를 읽을 것.
  - 인터넷 검색은 원문 내용 조사에 쓸 것.

## 되돌리기

- main 메모리에 프로젝트별로 둔다. 앱을 끄면 지운다. 앱이 비정상 종료돼도 사라진다.
- DB 테이블을 새로 만들지 않는다. schema 변경도 없다.
- 쓰기를 하기 전에 바뀔 행을 떠 두고, 쓰기 뒤의 상태도 함께 기록한다. 되돌릴 때 그 행들이 아직 변경 직후 상태면 원래대로 복원한다.
- 그 뒤에 사람이나 다른 변경이 손댔으면 되돌리지 않고 "이후에 바뀐 내용이 있어 되돌릴 수 없습니다"를 보여 준다.
- 대상별로 되돌리는 방법:
  - 번역: 변경 전 전문과 묶음으로 다시 저장한다.
  - 코멘트 추가: 보관 처리한다.
  - 용어 후보 추가: 후보를 제거한다.
  - 용어 확정: 후보 행, 문서 용어 연결, 출현 위치, 새로 만든 프로젝트 용어, 검토 완료 상태를 복원한다. 후보는 다시 후보로 돌아온다.
  - 용어 수정, 후보 버리기: 같은 방식으로 행을 복원한다.
  - 번역 확정: 확정 전 번역안 상태로 되돌린다. 확정 뒤 수정본을 만들었으면 되돌리지 않는다.
- 여러 항목을 한 번에 처리한 호출(예: "전부 확정")은 변경 하나로 기록한다. 되돌릴 때도 한 번에 되돌린다.

## 편집기 반영

- 로컬 프로젝트에도 변경 알림을 보낸다.
  - 지금 `emitProjectChange`는 온라인 작업본에서만 쓴다.
  - MCP 쓰기 뒤에 `documentIds`, `scopes`를 보내면 편집기, 용어, 코멘트 화면이 `registerProjectRefresh`로 다시 읽는다.
  - `accountId` 검사는 로컬용으로 맞춘다.
- 알림은 기존 알림 영역에 조용한 한 줄로 띄운다. 예: "Claude Code가 용어 12개를 확정했습니다 · 되돌리기"
- 이력 탭에서 이번 앱 실행 동안의 외부 AI 변경을 세션별로 묶어 보여 주고 되돌리기를 제공한다.
- 알림이 사라진 뒤에는 수정된 곳에 별도 표시를 남기지 않는다(조용한 편집기 원칙).

## 단계

1. 서버, 중계 명령, 읽기 도구, 연결 화면. 이 단계가 끝나면 Claude Code·Codex에서 문서와 용어를 읽으며 대화할 수 있다.
2. 쓰기 도구(번역, 코멘트, 용어 확정 포함), 되돌리기, 문서 단위 잠금, 편집 중 거절, 로컬 변경 알림, 편집기 알림과 이력.
3. `get_translation_guide`와 서버 안내문.
4. 화면 조작 도구.

## 검증

- main 단위 테스트: Host·Origin 거절, 도구 입력 검증, 문서 단위 잠금, 편집 중 거절, `project_changed`, 앱이 꺼졌을 때 중계의 응답.
- repository 테스트: 여러 용어 확정이 전부 성공하거나 전부 실패하는지, 되돌리기 전후 행 비교.
- 실제 확인: 개발 앱을 켜고 Claude Code와 Codex를 연결한 뒤 "용어 목록 → 전부 확정 → 용어 화면 반영 → 되돌리기"와 "문장 수정 → 편집기 반영 → 되돌리기"를 해 본다.
- 착수할 때 `plan.md` §4.2의 "외부 MCP server 연결·설정 UI" 제외 항목과 §11.2 문구를 고친다.

