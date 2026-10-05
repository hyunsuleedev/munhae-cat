# 문해 CAT 구현 계획

> 2026-09-05 기본 흐름 변경: [전문 번역 후 원문 연결](docs/full-text-translation.md)이 현재 실행·저장·UI 계약이다. 아래의 표점/앵커 필수 및 `translation-envelope.v2` 설명은 기존 번역의 호환 경로에 적용한다. 스키마 1 → 2 자동 백업·업그레이드를 지원한다.

상태: 제품·아키텍처 기준안
프로젝트명: **문해(文解) / Munhae CAT**
데스크톱 앱: **Munhae Studio**
로컬 AI 실행기: **역관(譯官) Agent**
커뮤니티 서비스: **Munhae Commons**

## 1. 제품 목표

문해는 고한문 번역가와 연구자가 원문 전체의 문맥을 유지한 채 표점·번역·검토·확정 과정을 관리하고, Codex 또는 Claude의 도움을 받아 결과를 축적하는 Electron 기반 CAT 도구다. 번역의 기본 단위는 토큰 예산 안에 들어오는 하나의 문서 또는 장 전체이며, 번역 블록이 원문 대조와 세부 편집 단위를 겸한다.

핵심 목표는 다음과 같다.

- 로컬에서 회원가입 없이 완전한 번역 작업 가능
- 원본 이미지·PDF를 참고 자료로 첨부 가능
- 붙여넣기·직접 입력·파일 가져오기로 원문 구성
- 저장된 원문 전체 또는 확정 표점 전체로 문서 번역안을 먼저 생성
- 번역 저장 후 독립된 요청으로 한국어 문장과 원문 범위를 연결
- 번역 블록을 합치거나 나누고 연결 앵커를 조정해 세부 편집
- Codex·Claude를 프로젝트 내부 채팅과 구조화된 번역 기능에서 사용
- LLM 결과와 사용자의 수정 결과를 모두 변경 이력으로 보존
- 프로젝트별 용어집·인물·지명·번역 원칙을 문맥으로 활용
- Phase 2에서 서버 협업과 확정 결과의 선택적 공유 지원

## 2. 확정된 제품 결정

| 항목 | 결정 |
|---|---|
| 앱 형태 | Electron 데스크톱 앱 |
| 로컬 데이터 | `.munhae` 디렉터리 패키지 + SQLite + assets 폴더 |
| LLM 인증 | Codex·Claude CLI가 소유한 OAuth 로그인 사용. 앱은 토큰을 저장하지 않음 |
| 문해 계정 | 운영자 소유 Supabase Auth에서 Google 로그인, 이메일·비밀번호 가입, 이메일 인증번호 확인, 로그인·로그아웃, 비밀번호 변경·복구 |
| 공식 서버 | `xanucaevzpwwabnmpamm` 프로젝트로 고정. 사용자 지정 서버 설정은 제공하지 않음 |
| 서비스 운영 | 오픈소스 데스크톱 클라이언트와 운영자 공식 서비스를 분리. 유료 공유 프로젝트·권한·결제는 후속 구현 |
| LLM 실행 위치 | 기본적으로 각 사용자의 데스크톱에서 로컬 CLI 실행 |
| 이미지 | 참고용으로 첨부·표시. DB에는 metadata와 상대경로만 저장 |
| OCR | 현재 범위에서 제외 |
| 전사 | 현재 범위에서 제외 |
| 저장 모델 | SQLite 관계형 원장 + 선택적 JSON + 로컬 파일 |
| 공개 | 내용의 `확정`과 외부 `공유`를 별개 상태로 관리 |
| AI 기본 번역 단위 | 토큰 예산 안에 들어오는 표점된 문서·장 전체 |
| 원문-번역 연결 | 정확한 표점 version에서 생성한 기술적 앵커와 번역 블록의 연결 |
| 세부 편집 단위 | 별도 계층 없이 `translation_blocks` 사용 |
| 긴 요청 | 모델별 token을 사전 계산하지 않음. 문자 수·UTF-8 byte만 표시하고 context 초과 오류 시 문서·장 경계에서 수동 분할 안내 |
| 공공 용어 서비스 | Phase 2의 미래 계획. Phase 1에는 로컬 프로젝트 용어집만 구현 |

## 3. 사용자 용어

사용자 화면에는 개발자 용어인 `리비전`을 노출하지 않는다.

| 내부 개념 | 사용자 화면 |
|---|---|
| 편집 중인 version | `원문안`·`표점안`·`번역안` |
| 승인된 version | `확정` |
| 이전 version | `변경 이력` |
| LLM output | `AI 제안` |
| 확정 결과의 외부 배포 | `공유` 또는 `공개` |
| 서로 다른 version 비교 | `본 비교` 또는 `변경 비교` |

내부 코드와 데이터베이스에서는 `version`, `parent_version_id`, `current_version_id`를 사용한다.

확정과 공유는 독립적이다.

```text
번역안 → 확정
          └─ 사용자가 선택한 경우에만 공유
```

- 비공개 확정이 가능하다.
- 공유를 중단해도 확정 상태는 유지한다.
- 확정된 내용을 고치면 기존 확정을 덮어쓰지 않고 새 작업안을 만든다.

## 4. 현재 범위와 제외 범위

### 4.1 포함

- 문해 공식 계정의 Google 로그인·회원가입·이메일 인증·로그인·로그아웃·비밀번호 변경·복구. 세션은 프로젝트 밖에 OS 암호화로 보관 ([운영 설정](docs/accounts.md))
- 프로젝트 생성·열기·백업·내보내기
- 원본 이미지·PDF 첨부와 페이지 보기
- 원문 붙여넣기·직접 입력·텍스트 파일 가져오기
- 원문 변경 이력
- 표점안 작성·AI 제안·수동 편집·확정
- 표점안의 문장·문단과 운문의 논리적 시행·대구·연 구조 편집
- 정확한 표점 version을 기반으로 한 번역 앵커 자동 생성
- 문서 전체의 단일 완성 번역안·확정과 번역 블록 편집
- 앵커와 번역 블록에 의한 원문-번역 대조 및 구간 연결
- 번역 블록 합치기·나누기·순서와 원문 앵커 연결 조정
- 번역 제출의 참조·구조 무결성 검사와 사용자 의미·품질 검토
- 용어집·인물·지명·불확실성 기록
- 프로젝트 문맥 미리보기·고정·제외
- Codex·Claude 내부 채팅 및 번역 작업
- 번역안 확인·확정
- Phase 2 Cloud·협업·공개 서비스는 별도 섹션에서 정의

### 4.2 현재 제외

- 외부 MCP server 연결·설정 UI와 project별 MCP 구성
- OCR
- 이미지 영역 인식
- 전사 workflow
- 원본 이미지·필사본의 물리적 행 단위 전사 데이터(논리적 시행은 표점 구조로 지원)
- 문자 token
- 외자 편집기
- 이미지 문자와 원문 문자 연결
- 다판본 자동 교감
- 여러 사용자의 문자 단위 동시 타이핑 CRDT
- 모바일 앱과 웹 편집기
- 독립적인 연구 노트·인용 관리
- 사용자 데이터로 모델을 자동 학습시키는 기능
- 확정되지 않은 작업의 자동 공개

위 기능은 실제 사용 수요가 확인되었을 때 독립 모듈 또는 플러그인으로 검토한다.

## 5. 핵심 작업 흐름

### 5.1 로컬 프로젝트

```text
새 로컬 프로젝트 → 원본 자료 첨부(선택) → 원문 저장
 → 표점 작성·확정(선택) → 전문 번역 생성 또는 직접 작성
 → 번역 저장 후 한국어 문장별 원문 연결 → 사용자 검토·확정
 → 로컬 백업·내보내기
```

확정 원문은 수정 버튼을 눌러야 편집할 수 있다. 표점은 좌우 대조로 편집한다. 별도의 사전 분절 단계는 없다.

### 5.2 AI 번역

```text
저장된 원문 전체 + 사용 가능한 확정 표점 + 선택 문맥
 → 앱에 기본 포함된 번역 스킬의 실제 내용과 버전을 요청에 주입
 → 첫 독립 CLI 요청: 의미 흐름에 따른 한국어 전문 제출
 → 정확한 입력 version과 번역 head CAS 검사 → 번역 전문 먼저 저장
 → 두 번째 독립 CLI 요청: 저장된 번역 문장과 정확한 원문 인용 대응
 → exact quote·출현 순번·version 검사 → 대조 표시
 → 전체 번역과 대응을 검토한 뒤 확정
```

연결에 실패해도 번역은 유지되며 현재 번역의 연결만 다시 실행할 수 있다. 연결은 many-to-many이며 번역 내용을 다시 작성하지 않는다. 번역문을 수정하면 새 version으로 저장하고 이전 연결은 그 version의 이력에 남긴다. 표점과 원문 앵커는 선택적 힌트이며 번역 문단을 강제하지 않는다. 품질이나 대응 정확도를 구조 검사로 보증하지 않는다.

MVP는 provider/model별 tokenizer나 context window catalog를 구현하지 않는다. CLI가 context 초과를 반환하면 원문을 조용히 자르거나 일부만 재시도하지 않고, 사용자가 저작의 실제 문서·장·편 경계에서 source text를 수동으로 나누도록 안내한다.

## 6. 전체 데이터 흐름

```text
Project
 └─ Document Node
     ├─ Source Asset / Page (선택적 이미지·PDF)
     └─ Source Text → Source Text Version
         └─ Punctuation Version
             ├─ Punctuation Structure Span
             │   └─ 문장·문단·논리적 시행·대구·연
             └─ Translation Anchor Set → Translation Anchor
                 └─ Document Translation → Document Translation Version
                     ├─ Translation Block ↔ Anchor 연결
                     └─ Validation / Term Decision / Quality Check

Policy + Glossary + Person + Place + Uncertainty + Confirmed Translation
 └─ Exact Request Artifact → Assistant Message → AI 제안

```

## 7. 저장소 아키텍처

### 7.1 데이터 종류별 저장소

| 데이터 | 저장소 | 기준 데이터 여부 |
|---|---|---|
| 로컬 프로젝트 관계 데이터 | SQLite | 기준 |
| 원본 이미지·PDF | 로컬 파일 시스템 | 기준 asset |
| 설정·좌표·provider 부가정보 | SQL JSON 컬럼 | 보조 |
| 검색 인덱스 | SQLite FTS | 파생 |
| 임베딩 | 선택적 vector index | 파생 |
| OAuth token·API key | OS Keychain / provider CLI | 프로젝트 데이터 아님 |

### 7.2 SQL을 원장으로 사용하는 이유

- 원문·표점·앵커·문서 번역의 정확한 version 의존 관계가 필요하다.
- 용어·인물·지명이 원문 앵커와 번역 블록에 관련된다.
- version 추가와 current head 변경을 한 transaction으로 처리해야 한다.
- 확정 결과와 변경 이력에 참조 무결성이 필요하다.
- 로컬 Electron에는 embedded SQLite가 단순하고 안정적이다.

MongoDB 같은 문서형 NoSQL을 별도 원장으로 추가하지 않는다. JSON은 plugin 설정, provider metadata, structured output schema처럼 유연성이 필요한 부가 필드에만 사용한다.

### 7.3 로컬 프로젝트 패키지

실제 작업 파일은 ZIP이 아니라 디렉터리 패키지다.

```text
프로젝트명.munhae/
  manifest.json
  project.sqlite3
  assets/
    originals/
      ab/cd/<sha256>.<ext>
    derivatives/
      <asset-id>/thumbnail.webp
      <asset-id>/page-0001.webp
  indexes/
    # 삭제 후 재생성 가능한 검색 인덱스만 허용
```

전달·백업용 `.munhaepkg`만 위 폴더를 압축한다.

`manifest.json` 예시:

```json
{
  "format": "io.munhae.project",
  "formatVersion": 1,
  "projectId": "uuid-v7",
  "title": "홍길동전 번역",
  "storageMode": "local",
  "database": "project.sqlite3",
  "assetRoot": "assets",
  "createdAt": "2026-09-01T12:00:00Z",
  "minimumAppVersion": "0.1.0"
}
```

manifest에 절대 경로, OAuth token, API key, provider 세션 비밀을 넣지 않는다.

### 7.4 앱 자체 로컬 DB

프로젝트 DB와 별도로 Electron user data 위치에 `app.sqlite3`를 둔다.

- `app_preferences`
- `app_recent_projects`
- `app_window_state`
- `app_devices`
- `app_ai_connections`: keychain reference만 저장
- `app_runtime_sessions`: 실제 provider session ref를 보관하는 로컬 CLI resume 정보
- `app_pending_diagnostics`

이 DB는 `.munhae`에 포함하지 않는다.

## 8. 데이터 모델

Phase 1 물리 스키마는 SQLite를 기준으로 한다.

전체 필드·관계와 AI exact request 저장 구조는 `schema.md`를 기준으로 한다.

### 8.1 공통 규칙

- ID: 애플리케이션이 생성하는 UUIDv7
- 시간: UTC
- version row: append-only
- current head: `current_version_id + lock_version`
- 삭제: 이력이 있는 자료는 hard delete 대신 tombstone
- hash: 불변 내용에 SHA-256
- 모든 프로젝트 row는 명시적 `project_id` 보유
- FK child column: 인덱스 필수
- confirmed version: 내용 수정 금지
- confirmed version 편집: 새 draft version 생성

### 8.2 프로젝트·정책

- `core_actors`
- `core_projects`
- `core_project_settings`
- `core_translation_policies`
- `core_translation_policy_versions`
- `core_translation_policy_heads`

번역 정책에는 대상 독자, 중요 용어의 `한국어(漢字)` 표기, 보충 표현 규칙, 불확실성 표시를 포함한다. 번역 방식·후보 수·provider 내부 검토 단계는 정책 column이나 사용자 선택값으로 저장하지 않는다.

### 8.3 문서 노드·참고 자료

- `document_nodes`
- `src_assets`
- `src_asset_locations`
- `src_asset_pages`
- `src_node_assets`

작품·권·장·개별 글은 공통 metadata를 가질 수 있는 `document_nodes` 트리로 표현한다. 프로젝트 생성 시 프로젝트 제목의 `is_master=1` 최상위 `container`를 정확히 하나 만들고, 모든 문서 node는 그 아래에 둔다. 이 마스터 container는 이동·삭제·원문 단위 전환을 허용하지 않는다. node에 구조 분류나 장르 필드를 두지 않으며, 생성·수정 때 분류를 요구하거나 기본값으로 저장하지 않는다. 필요할 때 확인한 문헌 구조·장르 정보는 근거와 함께 선택적인 문맥 카드로 기록한다.

각 node는 파일 시스템의 폴더/파일에 해당하는 `node_role = container | source_unit`을 명시한다. `container`는 하위 node와 metadata·context를 가질 수 있지만 원문·표점·앵커·번역안을 가질 수 없다. `source_unit`은 원문부터 번역까지의 실제 작업 단위이며 하위 node를 가질 수 없다. 트리는 역할·부모 관계·순서로 구성한다. 상위 `container`에 묶인 context는 복사하지 않고 하위 `source_unit`의 AI 요청에서 상속한다. 표점 편집의 산문·운문 구조 모드는 node의 분류가 아니라 표점 버전에 속한다.

공통 `author_person_id`, `language`, `period_text`, `source_reference`는 현재 node에 값이 없으면 가장 가까운 상위 node에서 가져온다. 제목·순서·개별 날짜는 상속하지 않는다. 발신자·수신자와 별도 다중 인물 연결 table은 데모에 두지 않는다.

이미지는 참고 자료로만 연결하며 OCR·문자 좌표를 저장하지 않는다.

### 8.4 원문

- `src_texts(id, project_id, document_node_id, name, status, created_at, tombstoned_at)`
- `src_text_versions(id, project_id, source_text_id, parent_version_id, version_no, content_text, origin_kind, source_asset_id, page_from, page_to, locator_text, change_summary, state, content_hash, created_by_actor_id, created_at)`
- `src_text_heads(project_id, source_text_id, current_version_id, confirmed_version_id, lock_version, updated_at)`

`origin_kind`: `manual | paste | import`.

한 source text는 책 전체보다 문서·장·편처럼 문학적으로 완결된 단위를 권장하지만 저장 크기를 강제하지 않는다. 요청이 provider context를 초과하면 사용자가 문서 구조에 맞게 source text를 수동으로 나누어 다시 실행한다.

### 8.5 표점

- `punctuation_sets(id, project_id, source_text_id, name, policy_version_id, status, created_at)`
- `punctuation_versions(id, project_id, punctuation_set_id, source_text_version_id, parent_version_id, version_no, punctuated_text, structure_json, change_summary, state, content_hash, created_by_actor_id, created_at)`
- `punctuation_heads(project_id, punctuation_set_id, current_version_id, confirmed_version_id, lock_version, updated_at)`
- `punctuation_structure_spans(id, project_id, punctuation_version_id, span_kind, parent_span_id, ordinal, codepoint_from, codepoint_to, quote, quote_hash, origin_kind, confidence, label, created_by_actor_id, created_at)`

표점은 원문을 덮어쓰지 않는다. 구두점 하나마다 별도 row를 만들지 않고 전체 표점 문자열을 version으로 저장한다. 표점 단계는 원문 문자에 문장부호와 표시 구조를 더할 수 있지만 원문 문자를 조용히 교체하지 않는다. 원문 문자가 바뀌면 먼저 새 source text version을 만든다.

표점안의 공백·줄바꿈 재배치는 허용하며, 한자와 기존 부호 등 공백이 아닌 원문 문자는 순서와 코드 포인트를 보존한다. 원본의 공백은 source version과 source 범위·인용에 그대로 남긴다. 이전 검사에서 공백 차이로 거절된 AI 제안은 원래 요청의 source snapshot과 부호 규칙으로 재검사하고, 이전 오류를 이력에 남긴 채 적용 가능한 미적용 제안으로 복구한다. 원문 또는 표점 head가 바뀌었으면 적용 시 기존 stale 검사로 막는다.

새 source unit 생성은 source text/version/head까지만 만든다. 사용자가 원문안을 확정하고 `표점 원문 생성`을 명시적으로 선택해야 최초 punctuation set/version/head가 생긴다. 수동 생성은 확정 원문 전문을 그대로 복사한 draft로 시작하며, AI 생성은 표점 원문 입력란의 `AI 제안` 보기에서 검토하고 `제안 적용하고 편집`을 선택할 때만 draft를 만든다. 생성·취소·검증 상태도 같은 입력 상자에 표시하며, `작업안`과 `AI 제안`을 전환해도 저장하지 않은 수동 편집은 유지한다. 제안 보기에서는 작업안 저장·확정·구조 편집을 잠그고, 적용 후 같은 입력란에서 편집한다. 원문을 수정·재확정한 경우 기존 punctuation/anchor/translation 이력은 보존하고 같은 active punctuation set에 새 source version을 참조하는 후속 draft를 만든다.

punctuation version의 content hash는 표점 문자열뿐 아니라 ID를 제외하고 정렬한 논리 구조 span manifest까지 포함한다. 구두점이 같아도 시행·대구·연·문단 구조가 바뀌면 새 punctuation version과 hash를 만든다.

표점 version은 구두점뿐 아니라 번역 연결에 필요한 논리 구조도 가진다.

- 산문: `title | heading | paragraph | sentence | clause | quotation`
- 운문: `verse_line | couplet | stanza`
- 사(詞): 구와 상편·하편을 parent-child span으로 표현 가능
- 부(賦)·소(騷): 문장 구조와 운문 구조를 함께 표현 가능

`verse_line`은 연구자가 표점안에서 확정한 논리적 시행이다. 원본 이미지나 필사본의 물리적 행과 동일한 개념이 아니며 OCR·이미지 좌표·전사 행을 도입하지 않는다. 절구·율시는 시행 앵커를 기본으로 하되 대구와 연을 상위 span으로 묶고, 고시·악부·가행은 글자 수만으로 기계 분리하지 않는다.

사용자 흐름:

```text
표점 원문 생성 → 편집 → 저장(version + structure spans, anchor 없음)
 → 변경 이력 → 검토 → 확정(transaction 안에서 anchor set/anchors 최초 생성)
```

무표점 원문은 확정된 source version에서 표점 draft를 먼저 만들어야 한다. draft 저장은 punctuation version과 검증된 structure span만 기록하고 anchor를 만들지 않는다. 표점 확정 transaction이 정확한 punctuation version에서 결정론적 anchor set을 처음 생성·검증한 뒤 confirmed head를 갱신한다. 이미 표점된 텍스트를 가져온 경우에도 원문 version과 구별되는 최초 punctuation version으로 저장·확정한 뒤 같은 방식으로 앵커를 만든다.

### 8.6 번역 앵커와 표점 구조

- `translation_anchor_sets(id, project_id, document_node_id, source_text_version_id, punctuation_version_id, strategy_key, strategy_version, coverage_policy, anchor_set_hash, created_by_actor_id, created_at)`
- `translation_anchors(id, project_id, anchor_set_id, anchor_key, ordinal, boundary_kind, punctuation_codepoint_from, punctuation_codepoint_to, punctuated_quote, punctuated_quote_hash, source_codepoint_from, source_codepoint_to, source_quote, source_quote_hash, context_before_hash, context_after_hash, display_label, required, created_at)`
- `translation_anchor_structure_spans(project_id, anchor_id, punctuation_structure_span_id, ordinal)`

한 anchor set은 정확히 하나의 source text version과 punctuation version에서 결정론적으로 생성하는 불변 파생 집합이다. `punctuation_version_id`는 필수이며 `anchor_set_hash`는 새 UUID가 아니라 결정론적 `anchor_key`·범위·quote hash와 ID를 제외한 structure-span signature를 포함한다. `(punctuation_version_id, strategy_key, strategy_version, coverage_policy)`를 unique로 두어 같은 입력의 재생성은 기존 set을 재사용한다. anchor set에는 별도 version/head를 두지 않는다.

앵커는 모델과 편집기가 원문 위치를 참조하기 위한 가벼운 기술 표지다. 의미상 번역 단위가 아니고 1:1 번역을 강제하지 않는다. `boundary_kind`는 `document | title | heading | paragraph | sentence | clause | verse_line | manual`을 사용하며 운문에서는 `punctuation_structure_spans`의 `verse_line`을 직접 참조할 수 있다.

anchor-span 연결은 같은 punctuation version 안에서만 허용한다. `verse_line` anchor는 범위가 정확히 같은 논리적 `verse_line` span 하나를 필수로 참조하며, 해당 시행을 포함하는 `couplet`·`stanza`는 상위 문맥 span으로 추가 참조한다. structure parent-child는 같은 version, child 범위의 parent 포함, 비순환 조건을 검증한다.

LLM output의 `sourceAnchorIds`는 랜덤 DB UUID가 아니라 해당 anchor set 안에서 결정론적으로 생성한 `anchor_key`(`A001` 등)를 사용한다.

새 표점 draft가 생기는 즉시 기존 번역은 `재검토 필요`가 되지만 새 anchor set은 아직 만들지 않는다. 그 draft를 확정할 때 새 anchor set을 만들며 기존 번역과 앵커는 삭제하지 않는다.

표점이 변경되면:

1. 새 punctuation version 생성
2. 이전과 새 표점의 차이 계산
3. 기존 문서 번역을 `재검토 필요`로 표시
4. 사용자가 새 punctuation version을 확정할 때 같은 transaction에서 새 translation anchor set 생성·검증
5. confirmed head 갱신
6. 기존 번역·블록·앵커 연결 이력은 삭제하지 않음

### 8.7 문서 번역과 번역 블록

- `document_translations`: source text + target locale의 안정적 번역 작업
- `document_translation_versions`
- `document_translation_heads`
- `translation_blocks`
- `translation_block_anchors`
- `document_translation_validations`
- `document_translation_validation_findings`
- `translation_quality_checks`
- `translation_staleness`

`document_translation_versions`는 nullable `parent_version_id` 하나를 직접 가진다. 일반 편집·AI 재생성은 기준 version을 부모로 새 version을 만들고, 동시 편집은 같은 부모에서 갈라진 두 branch를 모두 보존한다. 별도 parent join table과 multi-parent merge 계보는 초기 범위에 두지 않는다.

`document_translation_heads`는 번역 작업별 `current_version_id`, `confirmed_version_id`, `lock_version`만 관리한다. 현재 작업안과 마지막 확정본을 빠르게 찾고 CAS로 동시 저장 충돌을 막기 위한 내부 포인터이며 사용자 화면에 노출하지 않는다.

`document_translation_versions`는 전체 한국어 번역문을 `text_content`로 저장하고 정확한 다음 입력을 참조한다.

- `source_text_version_id`
- `punctuation_version_id`
- `translation_anchor_set_id`
- `translation_policy_version_id`
- AI 생성이면 유일한 `generated_by_message_id`, 사람 작성이면 human actor
- `document_translation_versions.validation_state`: `valid | needs_review`
- assistant message의 `output_validation_state`: `valid | needs_review | invalid_unapplied | not_applicable`

`translation_blocks`는 번역 전문을 복사하지 않고 문서 번역 version 안의 한국어 code-point 범위와 `target_hash`를 보관한다. version 안에서 block key·ordinal은 각각 유일하고 target 범위는 전문을 순서대로 coverage한다. `translation_block_anchors`가 블록과 하나 이상의 원문 앵커를 연결하며 한 block 안에서 anchor와 연결 ordinal을 중복할 수 없다. 번역 문구, block 묶음, `sourceAnchorIds` 대응은 provider가 제출한 결과를 그대로 받으며 앱이 의미적 적절성을 판정하거나 재배치하지 않는다. 사용자가 전체 번역과 대응을 검토하고, 필요하면 block을 합치거나 나누고 anchor 연결을 수정한다.

블록 합치기·나누기·순서·앵커 연결 수정은 새 document translation version과 그 version의 block 집합을 만든다. 이전 version의 전체 번역문과 block 집합은 변경 이력으로 보존한다.

AI는 원문을 되풀이하지 않고 한 번의 `submit_translation` 호출로 단일 완성 번역을 제출하며 기존 앵커 ID만 참조한다. 앱 외부의 provider skill·내부 추론 workflow는 앱의 저장 계약이나 UI 선택지가 아니다.

```json
{
  "schemaVersion": 2,
  "anchorSetId": "tas_...",
  "blocks": [
    {
      "blockKey": "b1",
      "sourceAnchorIds": ["A001", "A002"],
      "blockKind": "paragraph",
      "translation": "…"
    }
  ]
}
```

저장 전에 다음의 결정론적 수용 조건만 검사한다.

- `anchorSetId`가 요청에 고정한 set과 일치하는가
- `schemaVersion`이 지원하는 output contract version과 일치하는가
- `blockKey`가 유일하고 각 block의 번역 문자열과 `sourceAnchorIds`가 비어 있지 않은가
- `sourceAnchorIds`가 모두 현재 anchor set에 존재하며 하나의 block 안에서 같은 관계가 중복되지 않는가
- 실행에 고정한 source/punctuation/anchor snapshot이 현재 head와 같고 CAS expected value가 유효한가

AI는 prompt에서 전체 원문을 완전히 번역하고 앵커 대응을 스스로 검토하도록 지시받는다. 다만 앱은 required 앵커 누락이나 서로 다른 block의 같은 앵커 참조를 완성도 대리 지표로 계산하여 거부하지 않는다. 번역의 완성도·정확성·자연스러움·block 묶음·원문 대응은 사용자가 검토한다. validation은 두 단계로 처리하며 어느 경우에도 원시 AI output을 조용히 자동 교정하지 않는다.

- **envelope validation 실패**: JSON parse/exact schema, `schemaVersion`, 현재 `anchorSetId`, block key 고유성, 빈 block/번역, unknown anchor, 하나의 block 안의 중복 anchor 관계, stale snapshot/CAS 검사가 깨진 경우다. translation version을 적용하지 않고 민감 정보가 없는 output artifact를 `invalid_unapplied`로 보존하며 head를 갱신하지 않는다.
- **수동 편집 구조 검증**: 사용자가 block-anchor 연결을 편집해 구조가 깨진 경우 새 draft를 `needs_review`로 보존하고 confirmed head는 변경하지 않는다.

`needs_review` draft는 사용자가 block-anchor 연결을 고쳐 새 `valid` draft를 만들기 전에는 확정할 수 없다.

데모의 내부 state 후보:

```text
draft | confirmed | superseded | rejected
```

UI에서는 각각 `번역안 | 확정 | 변경 이력 | 제외됨`으로 표시한다.

### 8.8 용어·인물·지명·불확실성

- `glossary_entries`
- `persons`
- `places`
- `uncertainties`
- `uncertainty_versions`
- `uncertainty_options`
- `uncertainty_anchors`

용어집은 일반 CAT 도구처럼 프로젝트별 단일 `glossary_entries` 표로 시작한다. 한 row가 `원문 용어 → 번역 용어` 한 쌍이며 같은 원문 용어에 여러 번역 후보가 필요하면 row를 여러 개 둔다.

```text
glossary_entries(
  id, project_id,
  source_term, target_locale, target_term, term_kind,
  reading, note_md, usage_status,
  content_hash, lock_version,
  created_by_actor_id, updated_by_actor_id,
  created_at, updated_at, archived_at
)
```

`usage_status`는 `preferred | allowed | forbidden`을 사용한다. `term_kind`는 우선 `general | office | book_title | institution | era | technical | other` 정도만 둔다. 관직·책 제목·기관·연호처럼 번역 대응어와 설명이 중요한 항목은 모두 이 용어집에 포함한다.

인물과 지명은 번역 용어가 아니라 동일성·별칭·설명이 중요한 대상이므로 별도 표로 둔다.

```text
persons(
  id, project_id,
  preferred_name, hanja_name, reading,
  aliases_json, description_md, date_text,
  content_hash, lock_version,
  created_by_actor_id, updated_by_actor_id,
  created_at, updated_at, archived_at
)

places(
  id, project_id,
  preferred_name, hanja_name, reading,
  aliases_json, place_kind,
  location_note_md, description_md,
  content_hash, lock_version,
  created_by_actor_id, updated_by_actor_id,
  created_at, updated_at, archived_at
)
```

Phase 1에는 범용 `entities`, `entity_versions`, `entity_names`, `entity_relations`, `entity_mentions` 계층을 만들지 않는다. 이름과 별칭은 각 row에 함께 저장한다. 현재 `source_text_version`의 무표점 원문에서 용어·인명·지명을 실행 시 exact match하고, 결과 범위를 포함하는 기존 translation anchor를 찾아 관련 항목만 화면과 LLM context에 포함한다. 출현 좌표는 기준 데이터로 저장하지 않는다. 과거 AI 실행은 해당 assistant message의 `request_manifest_json`과 request artifact로 당시 사용한 항목을 재현한다.

용어집을 서버에서 공동 사용하고 제안·검토·배포하는 공공 용어 서비스는 Phase 2의 미래 계획으로만 둔다. Phase 1에는 이를 위한 서버 table이나 API를 만들지 않는다.

불확실성은 최소 다음을 분리한다.

- `textual`: 원문 자체가 불명확
- `interpretive`: 문법·의미 해석이 여러 가지
- `identification`: 인물·지명·서명 동정이 불확실

### 8.9 주석·댓글·협업 검토 — 데모 제외

Phase 1 데모에는 주석·댓글·작업 배정·검토 라운드·체크리스트용 schema를 만들지 않는다. 사용자는 번역안을 직접 편집한 뒤 단순히 `확정`할 수 있다. 협업이 필요한 Phase 2에서 실제 workflow를 정한 뒤 관련 schema를 설계한다.

### 8.10 문맥

- `context_items`

문맥 조립 규칙은 Phase 1 코드에 하나의 기본 순서로 고정한다. 문맥 카드에는 종류 분류를 두지 않고, 노드에 제목과 자유문 본문을 연결한다. 해제 전문도 분해하지 않고 하나의 문맥으로 저장할 수 있다. `context_items`에는 다른 domain table로 표현되지 않는 프로젝트 설명·시대 배경·문체 지침·외부 근거만 저장한다. 용어·인물·지명·확정 번역은 원래 table에서 직접 선택하며 중복 복사하지 않는다. 독립적인 연구 노트와 인용 관리 기능은 MVP에 포함하지 않는다.

`context_items`의 적용 범위는 `document_node` 하나로 통일한다. 특정 문서 node에서 AI 요청을 조립할 때는 **현재 node → 가장 가까운 상위 node → 더 먼 상위 node → 프로젝트 마스터 container** 순으로 적용하고, 같은 범위 안에서는 `priority` 내림차순으로 놓는다. 프로젝트 공통 문맥은 별도 scope가 아니라 마스터 container에 직접 연결한 문맥이다. 하위 node에 상위 문맥을 복사해 저장하지 않고 요청 시점에 조상 경로를 해석한다. 다른 가지의 문맥은 자동 포함하지 않는다. 프로젝트 용어·인물·지명은 node마다 복사하지 않고 공통 원본을 유지하되, 현재 원문의 exact match·상속 저자·관련 앵커로 해당 node에 적용할 항목만 고른다.

문서 metadata와 문맥 카드는 `lock_version` CAS로 저장 충돌을 막는다. 문맥 카드의 내용·`enabled`·`priority`·보관 상태 변경은 모두 같은 잠금을 증가시키며, 보관된 카드는 새 AI 요청에서 제외하되 과거 request manifest와 artifact는 그대로 유지한다. 불확실성은 append-only version과 선택지·대상 앵커를 함께 저장하고, 현재 문서에 연결된 열린 `blocking` 불확실성이 남아 있으면 번역 확정을 허용하지 않는다.

사이드바의 각 node 아래 `문맥`은 `context.html?node=<id>` 편집 페이지로 연결한다. 직접 연결한 문맥은 제목과 본문을 바로 편집하고, 문맥이 없으면 빈 편집란을 표시한다. 상속한 문맥은 가까운 상위 node부터 읽기 전용으로 보여 주고 해당 소유 node의 편집 페이지로 이동할 수 있게 한다. 저장하지 않은 변경이 있으면 화면 이동 전에 확인한다.

별도 context snapshot, profile/version/head, override, retrieval 실행 기록, materialized translation memory, embedding table은 데모에 만들지 않는다. 실행에 포함한 domain row의 종류·ID·version·hash·순서·선택 이유는 assistant `chat_messages.request_manifest_json`에 기록하고 앱이 provider CLI adapter에 전달한 최종 요청 payload는 `request_artifact_id`가 가리키는 content-addressed `provenance_artifacts`에 저장한다. 하나의 AI assistant message가 곧 실행 당시 문맥 기록이다.

### 8.11 AI runtime·provenance

- `provenance_artifacts`
- `provenance_lineage_edges`
- `user_edits`

OpenDesign처럼 agent adapter와 기본 prompt는 애플리케이션 코드·버전 관리되는 파일에 둔다. 사용자가 선택한 agent·model·reasoning·service tier는 프로젝트 DB가 아니라 Electron app data의 `app-config.json`에 로컬 preference로 저장한다. 설치된 CLI의 version·지원 model·capability는 실행 전에 probe하며 이를 별도 version table로 누적하지 않는다.

```json
{
  "agentId": "codex",
  "agentModels": {
    "codex": {"model": "default", "reasoning": "medium", "serviceTier": null},
    "claude": {"model": "default", "reasoning": null, "serviceTier": null}
  }
}
```

Phase 1에는 `ai_profiles`, `ai_profile_versions`, `ai_prompt_templates`, `ai_prompt_versions`, `ai_model_configs`를 만들지 않는다. 대신 실제 실행값과 `prompt_contract_version`을 assistant message에 기록하고, adapter에 전달한 완성 prompt는 `request_artifact_id`로 보존한다. 사용자 편집 prompt preset·팀 공유 AI profile·prompt A/B test가 필요해질 때 Phase 2에서 별도 schema를 설계한다.

저장 금지:

- OAuth access/refresh token
- API key
- provider cookie
- provider의 숨겨진 chain-of-thought
- 사용자가 보관을 허용하지 않은 원시 debug stream

### 8.12 Chat 기반 AI 실행

- `chat_threads(id, project_id, title, scope_kind, scope_id, created_by_actor_id, created_at)`
- `chat_messages(id, project_id, thread_id, parent_message_id, role, actor_id, state, agent_id, requested_model, resolved_model, reasoning_level, service_tier, runtime_version, task_kind, output_contract, prompt_contract_version, request_manifest_json, request_manifest_hash, request_artifact_id, response_artifact_id, events_artifact_id, output_validation_state, usage_json, error_json, started_at, completed_at, created_at)`
- `chat_message_parts(id, project_id, message_id, ordinal, part_kind, text_content, structured_json, artifact_id)`
- `chat_agent_sessions(project_id, thread_id, agent_id, model, cwd_hash, last_message_id, stable_prompt_hash, state, updated_at)`

AI 호출 하나는 assistant message 하나이며 message ID를 runtime run ID로도 사용한다. `scope_kind = project | document_node`인 내부 채팅은 자유 텍스트로 저장하고 source-only 문서에서도 동작한다. 아직 없는 punctuation/anchor는 request manifest에서 optional snapshot으로 기록한다. 같은 thread는 app-local provider session을 검증해 이어서 대화할 수 있지만, 일반 채팅은 source/punctuation/translation head를 변경하지 않는다. 번역 작업만 `translation-envelope.v2`를 인자로 받는 `submit_translation` 앱 도구 호출을 정확히 한 번 요구한다. 검증을 통과한 단일 완성 번역은 기존 번역을 덮어쓰지 않고 새 draft version을 자동 생성한다. `punctuation_suggest`는 검증된 제안을 응답 artifact와 미리보기로만 보존하며, 사용자가 별도 적용 버튼을 누를 때 snapshot/CAS를 다시 검사하여 anchor 없는 새 표점 draft를 만든다. 표점 제안 실행 자체는 표점 head를 바꾸거나 자동 확정하지 않으며, 표점 확정·삭제도 별도 사용자 확인을 요구한다.

일반 채팅 UI에는 user/assistant의 대화문과 `연결 중 | 생성 중 | 완료 | 취소됨 | 실패` 같은 거친 실행 상태만 표시한다. provider의 reasoning, 내부 activity, 도구 호출, 도구 입력과 결과, raw stream은 채팅 message part나 renderer payload로 보내지 않는다. provenance가 필요하면 token·session ref·경로·원문 payload를 제거한 정규화 event만 private artifact로 보존하고 `events_artifact_id`로 연결한다. ordinary renderer API는 이 artifact 본문을 제공하지 않는다. 일반 chat의 최종 답변 또는 `submit_translation`에 제출된 canonical envelope는 `response_artifact_id`에 저장한다. 번역 envelope는 채팅 tool card로 표시하지 않고 적용된 translation version을 editor에서 보여준다. 사용량·오류는 message의 JSON에 두며 별도 AI run·output·usage·error·feedback·tool-call·application table은 만들지 않는다. 생성된 단일 translation version은 assistant message 하나를 `generated_by_message_id`로 유일하게 참조하여 출처와 멱등성을 보존한다.

## 9. 표점·앵커·번역 블록의 관계

번역 연결의 기준은 임의의 원문 글자 구간이 아니라 정확한 표점 version이다.

```text
SourceText V1
 └─ Punctuation P1
     ├─ Structure Spans
     │   └─ 문장·문단·논리적 시행·대구·연
     ├─ Anchor Set A1
     │   └─ Anchors A001…A0NN
     │       └─ Document Translation T1
     │           └─ Translation Blocks ↔ Anchors
```

문해에는 별도의 분절 계층을 두지 않는다. 앵커는 원문 위치를 안정적으로 가리키는 기술 참조이고, `translation_blocks`가 실제 대조·편집·작업 배정·검토 단위다.

- 표점 수정은 새 punctuation version을 만든다.
- 새 punctuation draft는 anchor가 없고, 그 version을 확정할 때 새 anchor set을 요구한다.
- 앵커는 표점 경계와 논리 구조를 참조하는 기술적 위치 표지이며 편집 단위가 아니다.
- 문서 번역 version은 자신이 사용한 source text, punctuation, anchor set을 모두 고정 참조한다.
- 하나의 번역 블록은 AI가 판단한 여러 원문 앵커를 묶을 수 있으며 앱은 그 대응을 의미적으로 재판단하지 않는다.
- 사용자는 번역 블록을 합치거나 나누고, 순서와 앵커 연결을 조정할 수 있다.
- 표점안이 바뀌어도 이전 anchor set과 번역을 삭제하지 않고 재검토 상태로 둔다.

운문에서도 원칙은 같다. 다만 마침표만으로 앵커를 자르지 않고 표점안에 기록된 `verse_line`을 기본 경계로 사용한다. `couplet`과 `stanza`는 시행을 묶는 상위 구조이고 LLM에는 시 전체를 제공한다. 모델은 한 시행 또는 대구 전체를 하나의 자연스러운 번역 블록으로 반환할 수 있다.

```text
[A001] 白日依山盡，
[A002] 黃河入海流。
[A003] 欲窮千里目，
[A004] 更上一層樓。

LLM 입력: A001~A004를 포함한 시 전체
번역 블록 예: [A001, A002] / [A003, A004]
```

## 10. 프로젝트 문맥 설계

긴 채팅 기록 자체를 프로젝트 문맥으로 사용하지 않는다. 매 실행마다 필요한 자료를 선별해 provider CLI adapter에 전달할 하나의 exact request를 만든다.

`context_items`, request manifest, exact request artifact와 assistant message 연결의 상세 필드는 `schema.md`의 **CONTEXT 저장 스키마**를 기준으로 한다.

### 10.1 문맥 계층

1. 번역 대상인 현재 punctuation version의 전체 표점 원문과 anchor set
2. 프로젝트 번역 원칙과 단일 완성 번역 output schema
3. 문서 서지·시대·장르·논리 구조
4. 관련 용어와 채택된 의미
5. 관련 인물·지명과 용어집의 관직·책 제목·기관·연호
6. 열린 불확실성
7. 기존 확정 번역에서 직접 조회한 번역 예시

초안·거절된 AI 결과는 번역 예시 후보로 사용하지 않는다.

### 10.2 문맥 선택 규칙

- 현재 punctuation version의 전체 표점 원문은 항상 포함하며 어떤 보조 문맥보다 우선
- 전체 원문을 여러 batch에 반복하거나 단순히 앞뒤 몇 문장으로 대체하지 않음
- 앱은 전체 원문을 임의로 절단하거나 일부만 번역하도록 요청을 변형하지 않음
- 단순 cosine 유사도만으로 문맥을 결정하지 않음
- `glossary_entries.source_term`과 `persons`·`places`의 이름·별칭 정확 일치에 높은 우선순위
- 확정된 번역만 참고 번역 예시 후보
- 외부 연구정보는 원문 사실과 분리해 표시
- 요청 전 전체 prompt의 문자 수와 UTF-8 byte를 참고 정보로 표시
- provider가 context 초과 오류를 반환하면 문서·장·편 같은 실제 경계에서 source text를 수동으로 나누도록 안내
- 사용자는 원문이 있는 문서 상세 화면의 AI 번역 대화상자에서 보조 context item을 포함하거나 제외 가능

### 10.3 문맥 미리보기 UI

LLM 실행 전 다음을 보여준다.

- 보낼 전체 표점 원문과 정확한 source/punctuation/anchor set version
- 적용할 번역 원칙
- 적용할 용어·인물·지명 정보
- 포함할 확정 번역 예시
- 전체 요청의 문자 수와 UTF-8 byte
- provider로 전송되는 데이터 범위
- 실행 불가 시 권장 문서·장 나누기 지점

## 11. LLM 연결 구조

### 11.1 기본 원칙

- 앱이 Codex·Claude OAuth token을 직접 받거나 저장하지 않는다.
- 설치된 provider CLI의 로그인 상태를 확인한다.
- 로그인이 필요하면 사용자가 provider CLI의 공식 로그인 흐름을 완료한다.
- 각 사용자는 자신의 로컬 provider 계정과 사용량을 사용한다.

### 11.2 Electron process 경계

```text
Renderer
  └─ Preload typed IPC
      └─ Main Process
          ├─ Local Project Repository (SQLite 단일 writer)
          ├─ App-owned Tool Bridge (127.0.0.1, loopback-only)
          │   └─ run-scoped token·endpoint·operation·TTL·single-use 검증
          └─ Utility Process: Agent Runtime
              ├─ CodexAdapter → codex CLI ─┐
              ├─ ClaudeAdapter → claude CLI ─┤ native shell에서 JSON을 stdin 전달
              └─ `munhae tools submit-translation` wrapper ←┘
                   └─ authenticated POST → Main validator → ProjectRepository transaction
```

Renderer에서 shell이나 Node API에 직접 접근하지 않는다.

Main Process는 앱이 소유한 loopback HTTP bridge를 제공한다. 문서 번역 실행을 시작할 때 불투명 난수 token을 발급하고, token을 `projectId`, assistant message ID인 `runId`, `submit_translation` operation, 만료 시간, 사용 여부에 결합한다. adapter는 bridge URL·token·run ID와 앱의 Node runtime·bundled wrapper 경로만 child process 환경에 주입한다. prompt는 이 환경변수가 앱의 Node runtime과 bundled wrapper를 가리키고 wrapper가 SQLite를 직접 열지 않으며 제출 결과가 즉시 편집기에 표시된다는 사실을 provider에 설명한다. AI는 필요하면 환경·wrapper를 native tool로 확인할 수 있고, 완성한 canonical JSON 하나를 quoted heredoc이나 동등한 shell pipeline으로 `munhae tools submit-translation`의 표준 입력에 정확히 한 번 전달한다.

wrapper는 SQLite를 열지 않는다. 표준 입력에서 크기 제한이 있는 JSON body 하나를 읽어 Bearer token과 함께 고정 경로 `POST /v1/tools/submit-translation`으로 전달한다. Main Process는 endpoint·operation·project·run·TTL·사용 횟수와 envelope·snapshot·CAS를 다시 검증하고 `ProjectRepository` transaction으로만 번역 draft와 block을 쓴다. bridge는 이 app-owned repository callback과 SQLite transaction이 커밋된 뒤에만 2xx를 반환하며, provider가 화면용으로 출력한 텍스트는 제출로 인정하지 않는다. 제출 body에 일반 credential 형식, 상속된 credential 환경값 또는 현재 run token이 포함되면 repository나 artifact에 넘기지 않고 즉시 실패한다. 첫 호출이 invalid이어도 token을 소비하여 같은 run의 재제출을 막고, 성공·실패·취소·timeout·child process 종료 시 즉시 폐기한다. body의 project/run override, loopback 이외의 접속, 만료·중복 token은 거부한다.

OpenDesign 방식처럼 model 호출·tool use·context 관리·session resume는 Codex·Claude의 native agent loop에 위임한다. 앱은 provider의 native Read/Write/Edit/Bash/Web 도구나 기존 CLI 사용자 수준 config·skills·hooks·per-CLI MCP 설정을 끄거나 대체하지 않는다. provider process에는 Electron Main Process가 상속한 사용자 환경변수를 전달하되, 이전 실행에서 남거나 외부에서 위조된 `MUNHAE_*` 값은 제거한 뒤 번역 run에만 새 일회성 값을 주입한다. Claude의 비대화형 app run은 OpenDesign과 같이 `--permission-mode bypassPermissions`를 사용하고, Codex는 OpenDesign과 같이 `workspace-write` sandbox와 network 허용을 명시한다. 이는 도구 종류를 앱이 골라 주는 allowlist가 아니라 사용자가 앱에서 시작한 run을 trusted run으로 전달하는 방식이며, 실제 도구 선택은 provider가 한다. `--tools`, `--allowedTools`, safe/restricted mode, settings·MCP 차단 flag는 추가하지 않는다. Phase 1에는 문해가 MCP 연결 UI를 제공하거나 MCP server/config를 생성·주입·수정하는 기능은 없다. 각 실행은 문해 프로젝트가 아닌 새 빈 임시 directory에서 시작하고, CLI에 문해 프로젝트 경로·SQLite 경로·connection·SQL API를 제공하지 않는다. 문해가 제공하고 성공으로 인정하는 앱 데이터 변경 경로는 위 wrapper→bridge→repository뿐이며, 일반 채팅 run에는 변경 operation을 발급하지 않는다. 다만 Claude의 `bypassPermissions`는 OS 전체 filesystem sandbox가 아니므로, 임의의 직접 파일 조작까지 기술적으로 차단한다고 주장하지 않는다. 그런 동작은 문해 operation으로 인정하거나 추적하지 않으며 prompt에서도 금지한다.

### 11.3 Agent adapter 계약

```ts
interface AgentAdapter {
  probe(): Promise<AgentStatus>;
  beginLogin(): Promise<LoginInstruction>;
  run(request: AgentRunRequest, sink: AgentEventSink): Promise<AgentRunResult>;
  cancel(runId: string): Promise<void>;
  resume?(sessionRef: string, request: AgentRunRequest): Promise<AgentRunResult>;
}
```

adapter 책임:

- CLI 실행파일 탐색
- 설치·로그인·버전·기능 확인
- shell string이 아닌 arguments array로 안전하게 process 실행
- streaming JSON/JSONL 또는 text event 정규화
- 취소·timeout·process 종료
- provider 오류를 안전한 공통 오류로 변환
- token·cookie·환경변수 redaction
- provider session ref는 app-local DB에만 저장
- user/assistant text와 거친 상태 event만 renderer에 전달
- tool/reasoning/activity event의 입력·결과를 일반 채팅 UI에서 제거

OpenDesign처럼 모델별 token 수를 추정하지 않는다. Claude·Codex처럼 prompt를 stdin으로 받는 adapter에는 모델 context preflight를 두지 않는다. 향후 prompt를 argv로 전달하는 adapter를 추가할 때만 운영체제 command-line 한도를 넘지 않도록 adapter별 UTF-8 byte guard를 둔다.

provider CLI의 native agent loop와 도구 사용을 앱이 재구현하지 않는다. 문해가 정상 operation으로 제공·검증하는 프로젝트 DB 변경은 run-scoped wrapper capability로만 수행한다.

### 11.4 구조화된 AI 작업

- `project_chat`
- `punctuation_suggest`
- `translation`
- `review_consistency`
- `suggest_glossary`
- `explain_uncertainty`

일반 `project_chat`은 자유 텍스트다. 프로젝트 또는 문서 thread에서 Codex·Claude session을 이어 대화할 수 있으며, native tool·web·설치된 skill의 사용 여부는 AI가 판단한다. 다만 앱 domain 데이터 변경을 시도하거나 변경했다고 주장할 수 없다. 문서 번역 작업만 `translation-envelope.v2` JSON Schema를 인자로 받는 `submit_translation` wrapper 호출을 필수로 한다. 다른 작업은 실제 요구가 확인되기 전까지 별도 JSON contract를 강제하지 않는다. 자유 채팅 답변과 실제 프로젝트 mutation은 분리한다.

`punctuation_suggest`도 native tool·web·설치된 skill의 사용 여부는 AI가 판단하되, 앱 데이터 변경을 시도하지 않고 최종 응답으로 완전한 표점문만 반환한다. 앱은 확정 원문의 문자 보존을 검증한 뒤 제안 원문과 검증 상태를 저장한다. 성공 응답도 자동 적용하지 않으며, UI에서 제안을 미리 본 사용자가 명시적으로 적용할 때만 실행 당시 source/punctuation snapshot과 현재 head를 다시 비교하고 새 AI 표점 draft를 만든다. 이 경로는 `submit_translation`을 호출하지 않고 번역 데이터도 변경하지 않는다.

문서 번역 작업은 다음 계약을 따른다.

1. exact source text·punctuation·anchor set·policy와 선택한 보조 문맥을 고정한다.
2. 전체 표점 원문과 앵커를 포함한 최종 요청의 문자 수와 UTF-8 byte를 계산해 사용자에게 표시한다.
3. 해당 문서/version의 번역 생성은 한 번의 LLM 호출로 실행한다.
4. 모델은 원문을 되풀이하지 않고 `blocks[{blockKey, sourceAnchorIds, blockKind, translation}]`를 가진 단일 완성 번역 envelope를 `submit_translation`으로 정확히 한 번 제출한다.
5. JSON·현재 anchor set·block/anchor 참조 형식·stale/CAS만 검사한 뒤 같은 assistant message를 참조하는 document translation version 하나와 block 연결을 저장한다.

provider가 번역 문구, block 묶음, source anchor 대응을 결정한다. 앱은 제출 결과의 참조·구조 무결성만 확인하며, 의미적 완성도·품질·추론 타당성은 점수화하거나 적용 gate로 사용하지 않는다. 이 검토의 주체는 사용자다.

translation generation을 작은 묶음의 반복 batch로 나누면서 같은 전체 원문을 매번 재전송하는 구현은 금지한다. 사용자가 새 AI 번역을 요청하면 독립된 assistant message를 만들고 실행 전에 원문 재전송 범위와 문자·byte 크기를 다시 보여준다.

CLI가 `context_length_exceeded`, `prompt_too_large`, `input_too_long`, `maximum_context_length` 계열 오류를 반환하면 공통 `context_too_large` 오류로 정규화한다. 앱은 자동 절단·자동 분할·부분 재시도를 하지 않고 사용자가 문서·장·편 단위로 원문을 나누도록 안내한다.

### 11.5 단일 완성 번역

앱의 번역 계약은 내부 추론 단계나 provider skill의 구성과 무관하다. 사용자는 번역 방식·후보 개수·내부 검토 단계를 선택하지 않는다. 한 번의 실행은 현재 문서 전체에 대한 완성 번역 하나를 제출하고, 앱은 이를 하나의 편집 가능한 draft로 가져온다.

내부 추론·자가 검토·도구 사용은 provider 실행 세부사항이다. 문해는 이를 별도 번역안, 품질 단계, 사용자 선택지로 저장하지 않고 일반 채팅 화면에도 노출하지 않는다.

## 12. 번역 작업 흐름

1. 원문을 저장하고 확정한다.
2. 표점 원문 작업안을 만들고 편집·저장·확정한다.
3. 확정과 함께 생성된 분절 앵커를 읽기 전용으로 검토한다.
4. 사람 번역 작업안을 만들거나, 한 번의 AI 실행으로 단일 완성 번역을 가져온다.
5. 사용자가 번역 문구·블록·앵커 대응의 의미를 검토하고, 필요하면 편집한 뒤 번역을 확정한다.

원문 또는 표점이 바뀌면 이전 번역 version은 이력으로 보존하되 새 의존성에 자동 재연결하지 않는다. 사용자가 현재 분절에 맞는 빈 번역 작업안을 명시적으로 만들거나 새 AI 번역을 실행해야 한다.

시·사·부 등 운문은 전체 작품이 하나의 source text에 들어오는 경우 작품 전체를 같은 호출에 제공한다. 시행 앵커와 대구·연 구조는 정렬을 돕지만 모델의 해석 문맥을 시행 단위로 잘라내지 않는다.

## 13. Electron 보안 구조

- `contextIsolation: true`
- `nodeIntegration: false`
- Renderer sandbox 활성화
- preload에 좁은 typed API만 노출
- IPC sender와 payload schema 검증
- 외부 URL은 allowlist 후 system browser로 열기
- 로컬 file path는 project root 내부인지 검증
- asset path traversal 방지
- Electron Main Process가 상속한 provider CLI 환경은 보존하되 상속된 `MUNHAE_*`를 제거하고 현재 run의 일회성 capability만 주입
- 로그에서 token·cookie·Authorization header 제거
- auto-update 서명 검증
- Content Security Policy 적용
- crash report는 opt-in

## 14. 로컬 SQLite 운영

- Phase 1은 새 baseline schema로 생성한 프로젝트만 지원한다. 구 schema·정책 column·AI 실행 table을 유지하는 upgrade migration은 작성하지 않고, 지원하지 않는 schema version은 열기 전에 거부하여 새 프로젝트 생성을 안내한다.
- Electron main process의 DB service만 writer가 된다.
- 모든 connection에서 `PRAGMA foreign_keys = ON`을 확인한다.
- WAL 모드를 사용하되 같은 컴퓨터의 단일 writer로 제한한다.
- 네트워크 드라이브의 `.munhae`를 공동 편집하지 않는다.
- 백업·압축 전 checkpoint를 수행한다.
- 시작 시 migration과 integrity check를 수행한다.
- app 종료 실패 후 WAL 복구를 테스트한다.
- 이미지 파일은 content hash로 검증한다.
- search index는 기준 데이터가 아니며 재생성 가능해야 한다.

## 15. Phase 2 — Cloud·협업·공개 서비스

Phase 2는 로컬 데모가 안정된 뒤 착수하는 독립 범위다. Phase 1의 SQLite 프로젝트를 offline replica로 바꾸거나 자동 양방향 동기화하지 않는다.

이 중 공식 계정의 이메일 인증은 Supabase Auth로 선행 구현했다. 로그인은 로컬 프로젝트를 자동 업로드하거나 공유 권한·유료 이용 권한을 부여하지 않는다. 공유 프로젝트의 멤버십과 결제 권한은 공식 서버에서 별도로 검증한다.

### 15.1 프로젝트 모드와 승격

- 서버 기준 데이터: PostgreSQL + Object Storage
- 로컬과 cloud는 독립 프로젝트 identity
- 로컬 → cloud는 사용자가 실행하는 명시적 import
- cloud → 로컬은 별도 fork/export
- cloud 프로젝트의 LLM 실행도 기본적으로 사용자 Electron의 Codex·Claude CLI 사용
- 서버에는 사용자가 저장한 결과와 안전한 provenance만 전송

승격 절차는 `무결성 검사 → SQLite checkpoint → cloud project 생성 → asset hash upload → 논리 row import → row/hash 검증` 순서다. 승격 후 로컬 프로젝트는 백업으로 남고 cloud 프로젝트와 자동 동기화되지 않는다.

### 15.2 Cloud 전용 schema

- 계정·권한: `users`, `workspaces`, `workspace_projects`, `workspace_members`, `project_members`, `actor_bindings`, `invitations`, `devices`
- 전달·감사: `change_events`, `transactional_outbox`, `idempotency_keys`, `notifications`, `audit_events`
- 공유·커뮤니티: `release_candidates`, `release_candidate_items`, `releases`, `release_items`, `publications`, `catalog_entries`, `attributions`, `errata`, `forks`, `community_proposals`, `community_proposal_items`, `export_artifacts`
- 공공 용어 서비스와 제안·검토·배포 schema는 Phase 2 착수 시 별도 설계

### 15.3 서버 아키텍처

```text
Electron
 ├─ HTTPS command/query API
 ├─ WebSocket event channel
 └─ Object Storage upload/download

Server
 ├─ Auth
 ├─ Project API
 ├─ PostgreSQL
 ├─ Object Storage
 ├─ Transactional Outbox Worker
 └─ WebSocket Gateway
```

### 15.4 mutation transaction

```text
BEGIN
  INSERT immutable version
  UPDATE current head
    WHERE lock_version = expected
  INSERT change_event
  INSERT transactional_outbox
COMMIT
```

LLM 호출, 파일 업로드, WebSocket 전송을 DB transaction 안에서 기다리지 않는다.

### 15.5 실시간

WebSocket 용도:

- 새 version 생성 알림
- 댓글·검토 상태 알림
- presence
- typing 표시
- 짧은 soft lock
- background job 진행률

WebSocket으로 받은 event를 영구 저장으로 간주하지 않는다. 재접속 시 `change_events.seq` 이후의 변경을 HTTP로 다시 조회한다.

### 15.6 충돌

- head update에 `lock_version` 기반 CAS 사용
- 예상 version이 다르면 HTTP 409 반환
- 두 작업안을 모두 보존
- 사용자에게 비교·선택·수동 통합 UI 제공
- last-write-wins로 번역을 조용히 덮어쓰지 않음
- 문자 단위 공동 입력은 초기 범위에서 제외하고 문서·표점안·번역 블록 단위 soft lock 사용

### 15.7 권한

기본 역할:

- `viewer`: 읽기
- `commenter`: 댓글·제안
- `editor`: 원문안·표점안·번역안과 번역 블록 연결 편집
- `reviewer`: 검토·확정 요청·확정
- `publisher`: 확정 결과 공유
- `admin`: 멤버·정책·프로젝트 관리

PostgreSQL tenant table에는 project/workspace membership 기반 Row Level Security를 적용한다. 필요하면 번역 작성자와 최종 확정자의 자기승인을 금지한다.

### 15.8 공유와 커뮤니티

#### 공유 조건

- 공유 대상은 확정된 version만 가능
- 공유 범위 선택: 프로젝트 전체·문서·구간
- license와 attribution 필수
- 원본 이미지의 공유 권한을 번역문과 별도로 확인
- manifest에 정확한 version ID와 content hash 기록
- 공유 후 내용을 바꾸면 새 release 생성

#### 커뮤니티 수정

공유된 결과를 직접 수정하지 않는다.

```text
공유 release
 ├─ Fork → 독립 프로젝트
 └─ Proposal → 원 프로젝트 검토 → 새 작업안 → 확정 → 다음 release
```

#### 개인정보와 AI 데이터

- 로컬 프로젝트는 사용자가 승격하기 전까지 서버로 전송하지 않음
- cloud 프로젝트의 AI 실행 시 provider로 전송할 문맥을 미리 표시
- AI request 원문 전체 보관 여부는 프로젝트 정책으로 설정
- 공유 release에서 내부 댓글·private note·provider session 정보 제외
- user content를 모델 학습에 자동 사용하지 않음

### 15.9 Phase 2 코드 추가

- `apps/server`: HTTP API, WebSocket, worker
- `packages/db-postgres`: PostgreSQL migration·repository
- `packages/api-contracts`, `packages/api-client`: cloud command/query 계약
- `CloudProjectRepository`: HTTPS API adapter
- `infra/migrations/postgres`

Phase 1의 domain command를 재사용하되 SQLite와 PostgreSQL migration 파일은 합치지 않는다.

### 15.10 Phase 2 마일스톤

- **M4 서버 프로젝트**: auth·workspace·membership, PostgreSQL·RLS, Object Storage, query/command API, idempotency·CAS·audit, local import와 cloud export/fork
- **M5 협업·Realtime**: WebSocket change cursor, presence·soft lock, comments·mentions·assignments·notifications, 충돌 비교·수동 통합, reconnect catch-up
- **M6 공유·커뮤니티**: 공공 용어 서비스, release manifest, license·attribution·rights, public catalog, fork·proposal·errata, 공유 취소와 새 release

### 15.11 Phase 2 검증과 남은 선택

- SQLite/PostgreSQL domain contract test
- workspace 초대·RLS 교차 프로젝트 차단·asset signed access
- CAS 409·WebSocket reconnect·local import·공유/fork/proposal E2E
- cloud API latency·DB transaction·outbox delay·WebSocket catch-up 측정
- server framework, Object Storage 선택. 계정 인증은 운영자 Supabase Auth로 확정
- 완료 조건: import 전후 row/hash 일치, 자동 sync 없음, 미확정 version 공유 차단, 내부 정보 release 제외

### 15.12 제품 방향 로드맵 — 온라인 기본·MCP·빌트인 AI (2026-09-27)

결정 사항:

- 문해는 데스크톱 앱 전용이다. 브라우저 편집기는 만들지 않는다. 모든 AI 경로는 Electron main을 거친다.
- 장기적으로 온라인 프로젝트를 기본 작업 방식으로 한다(노션·Paper형). 서버가 원본이어야 한도를 서버에서 강제할 수 있다. `.munhae`는 내보내기·백업·가져오기 형식으로 남긴다.
- 당분간 로컬 프로젝트 기능은 그대로 두고 앱 고도화를 우선한다. 아래 R1 이후는 착수 시점에 다시 결정한다.

참고한 구조: Paper Desktop은 앱 전용에 가까운 Electron 앱이다. 문서 원본은 서버(`sync.paper.design`)에 있고, 앱이 켜져 있는 동안 로컬 MCP 서버(`127.0.0.1:29979/mcp`, 브라우저 Origin·DNS rebinding 차단, Bearer는 headless 모드에서만)를 열고, 사용자가 앱에서 고른 AI 도구의 설정 파일에 `~/.paper/bin/paper mcp` stdio 중계 CLI를 등록한다. 협업은 무료이고, 한도는 MCP 도구 호출(무료 주 100회)·이미지 생성·첨부 크기에 건다.

#### R0 — 지금: 로컬 유지, 앱 고도화

전환 비용을 늘리지 않기 위한 규칙:

- 앱 도구 핸들러(`submit-translation`, `get-reading-context` 등)는 SQLite·Electron에 묶지 않고 `입력 → 검증 → repository 반영`만 하도록 유지한다. R1·R3·R4가 같은 핸들러를 재사용한다.
- 새 domain table은 온라인 schema 생성기로 PostgreSQL에도 반영한다. 로컬 파일 경로를 기준 데이터로 쓰는 기능을 추가하지 않는다.
- AI 실행의 provider 토큰 사용량을 실행 기록에 남긴다. 빌트인 AI 가격과 한도 산정의 실측 근거로 쓴다.

#### R1 — stdio MCP

- Paper처럼 main이 고정 포트 HTTP MCP 서버를 열고(Origin·Host 검사), 홈 폴더의 stdio 중계 명령(`~/.munhae/bin/munhae-mcp`)이 그 서버로 중계한다. 앱을 켤 때마다 중계 명령을 현재 앱 위치로 다시 써서 업데이트·이동에도 등록이 깨지지 않게 한다(2026-09-29 결정, 발견 파일·Bearer 방식을 대체).
- 설정의 연결 화면에서 Claude Code·Codex·Antigravity 설정 파일에 중계 명령을 직접 등록한다.
- 문해가 시작한 run은 run별 MCP 설정 주입과 기존 일회성 grant를 유지한다. 외부 AI가 시작한 쓰기는 바로 반영하고 사용자가 되돌릴 수 있게 한다(2026-09-29 결정, 초안 수락 방식을 대체).
- 앱 AI 작업과 겹치면 그 문서에 대한 외부 쓰기만 거절한다. 세부 설계·도구 목록·전송 방식 비교는 `docs/local-mcp.md`에 둔다.
- 착수 시 §4.2와 §11.2의 MCP 제외 조항을 개정한다.

#### R2 — 온라인 기본 전환

- 선행: 변경 알림마다 전체 스냅샷을 읽지 않고 `get_online_project_changes`로 변경분만 반영한다. 전송량이 서버비의 주 변수다.
- 선행: 충돌 단위를 프로젝트 revision에서 문서·블록 단위로 낮춘다.
- 한도는 서버에서 검사한다. AI 실행은 `persistAiBeforeLaunch`의 예약 commit에서 실행 계정 기준으로 세고, 전용 오류 코드로 업그레이드 안내를 연결한다. MCP 쓰기는 도구 호출 단위로 센다. 첨부 용량에도 한도를 둔다.
- CLI·MCP 한도는 요금제 구분 장치다. 서버는 AI 입력과 수동 입력을 구분할 수 없으므로 변조된 앱은 우회할 수 있지만, AI 비용은 사용자 부담이다.
- 로컬 → 온라인 가져오기와 한도 초과 처리, 무료 내보내기를 제공한다. 오프라인 편집·AI 실행 불가를 명시한다.
- 비용 기준: Supabase Pro 월 $25(DB 8GB, Storage 100GB, egress 250GB, Realtime 동시 500). 텍스트 프로젝트는 수 MB 수준이다.

#### R3 — 빌트인 AI: 앱 안 루프

- `AgentAdapter`에 `munhae` 어댑터를 추가한다. Anthropic SDK Tool Runner로 도구 루프를 돌리고 앱 도구를 정식 API 도구로 정의한다. 브리지·CLI wrapper를 거치지 않고 핸들러를 직접 호출한다.
- SDK `baseURL`은 Supabase `ai-proxy` 함수다. 프록시는 JWT·Premium·예약 run 소유를 확인하고, 모델 허용 목록과 `max_tokens` 상한을 적용하고, stream usage로 사용자별 월 예산을 강제한다. 이 경로의 한도는 우회할 수 없어야 한다.
- edge function은 요청당 400초(유료)·무응답 150초 제한이 있으므로 긴 번역은 분절 단위로 호출한다.
- 앱을 닫으면 실행이 멈춘다. 모델과 한도는 R0 실측 비용으로 정한다.

#### R4 — 원격 MCP + Managed Agents

- 도구 핸들러를 PostgreSQL 위의 원격 MCP 서버로도 노출한다. 사용자가 claude.ai·ChatGPT에서 온라인 프로젝트에 연결하는 경로도 된다.
- Premium 백그라운드 문서 전체 번역을 Managed Agents로 실행한다. outcome 채점 기준(분절 누락 없음·문장 연결 유효·용어 일관성), 분절 병렬 처리, 세션 금액 상한을 쓴다.
- 진행 상황은 SSE 중계 대신 웹훅 → PostgreSQL 기록 → Realtime으로 앱에 전달한다. MCP 인증은 사용자별 vault 자격증명으로 하고, 문해 MCP 도구에는 `always_allow`를 설정한다.

## 16. 검색

MVP:

- 원문 exact search
- 한국어 번역 검색
- 용어·인물·지명 필터
- 문서·상태 필터
- SQLite FTS

고한문과 한국어는 공백 기반 검색만으로 부족할 수 있으므로 character n-gram/trigram을 실제 corpus로 검증한다. 1~2자 한자어는 exact/prefix 인덱스를 별도로 둔다.

후순위:

- 유사 번역 검색
- semantic context retrieval
- 선택적 로컬 vector index
- 이체자·독음·정규화 확장 검색

검색과 embedding은 언제든 원장 version에서 다시 만들 수 있어야 한다.

## 17. UI 정보구조

### 17.1 프로젝트 홈

- 최근 작업
- 왼쪽 사이드바의 프로젝트 마스터 container에서 시작하는 작품·권·장·편 목차 트리
- 중앙의 원문 작업 단위 목록: `node_role='source_unit'`인 node만 원문·표점·번역 상태를 표시
- 단계별 진행률
- 열린 불확실성
- 확정 상태

`node_role='container'`인 목차 폴더는 중앙 작업 목록과 단계별 진행률의 분모에서 제외한다. `source_unit`은 구조 종류와 무관하게 하나의 실제 작업 단위로 세고, 상위 작품·권·장 경로를 함께 표시한다.

### 17.2 편집 화면

```text
┌──────────────────┬────────────────────────────┬──────────────────┐
│ 참고 이미지/PDF  │ 원문·표점·분절·전체 번역  │ 문맥·AI 채팅      │
│ 선택적 패널       │ 주 편집 영역               │ 용어·문맥 카드      │
└──────────────────┴────────────────────────────┴──────────────────┘
```

주요 상호작용:

- `원문 → 표점 원문 → 분절 → 번역`의 명시적 4단계 진행
- 원문 확정 뒤 수동 표점 작업안 생성 또는 AI 표점 미리보기·가져오기
- 표점 확정 뒤 생성된 앵커 ID·범위·전문을 분절 단계에서 읽기 전용 검토
- 번역 생성 CTA는 확정된 표점과 anchor가 있는 분절 단계에서만 제공
- 원문/표점/번역 병렬 보기
- 전체 번역문을 끊김 없이 읽고 편집
- 원문 앵커와 번역 블록 사이 이동·강조
- 운문의 시행·대구·연 구조 표시
- 번역 블록 합치기·나누기와 앵커 연결 조정
- AI가 가져온 단일 번역과 사용자 수정 이력 비교
- 변경 이력 diff
- 용어·인물·지명 hover 카드
- 불확실성 표시
- 번역안과 `확정` 상태를 명확히 분리
- 오른쪽 패널에서 프로젝트 또는 현재 문서 범위의 Codex·Claude 채팅 thread 생성·재개
- 채팅에는 user/assistant 대화문과 거친 실행 상태만 보이고 reasoning·activity·tool 호출·tool 입력/결과는 표시하지 않음
- 번역 run 완료 시 tool 호출 카드 대신 새 번역안으로 이동하는 결과 안내만 표시

### 17.3 문서 상세의 AI 번역 대화상자

별도 실행 페이지를 만들지 않는다. 현재 원문·표점·번역을 보고 있는 문서 상세 화면에서 AI 번역을 열고 다음을 확인한다.

- 이번 AI 실행에 포함할 항목
- 포함 이유와 출처
- exact version과 hash
- 보조 항목 pin/exclude
- provider 전송 범위
- exact request의 문자 수와 UTF-8 byte
- provider가 context 초과를 반환했을 때 필요한 문서·장·편 단위 수동 나누기 안내

## 18. 코드 구조

초기 monorepo 제안:

```text
munhae-cat/
  plan.md
  apps/
    desktop/               # Electron main, preload, renderer
  packages/
    domain/                # entity, value object, command, policy
    project-format/        # .munhae manifest, import/export
    db-sqlite/             # local migrations, repository
    agent-runtime/         # Codex/Claude adapters
    context-engine/        # 문맥 조립, budget, request manifest
    search/                # local search adapter
    ui/                    # shared UI components
    test-fixtures/         # cross-database contract fixtures
  infra/
    migrations/
      sqlite/
  docs/
    architecture/
    decisions/
```

### 18.1 repository 계약

```ts
interface ProjectRepository {
  getProject(id: ProjectId): Promise<Project>;
  listDocuments(projectId: ProjectId): Promise<Document[]>;
  execute(command: ProjectCommand): Promise<CommandResult>;
}
```

- `LocalProjectRepository`: SQLite transaction
- UI와 workflow는 SQLite 구현 세부를 직접 알지 않음
- 검색과 로컬 asset storage는 별도 interface

### 18.2 핵심 command

- `CreateProject`
- `AttachSourceAsset`
- `CreateSourceTextDraft`
- `SaveSourceTextDraft`
- `CreatePunctuationDraft`
- `SavePunctuationStructure`
- `ConfirmPunctuation`
- `CreateTranslationAnchorSet`
- `ValidateTranslationAnchors`
- `RequestDocumentTranslation`
- `ApplyDocumentTranslationEnvelope`
- `SaveDocumentTranslationDraft`
- `ReplaceDocumentTranslationBlocks`
- `ValidateDocumentTranslationDraft`
- `ConfirmTranslation`
- `RequestAiSuggestion`
- `AddGlossaryDecision`
- `RecordUncertainty`

`SaveDocumentTranslationDraft`와 `ReplaceDocumentTranslationBlocks`는 기존 block row를 부분 수정하지 않는다. 전체 `text_content`, 완전한 block 집합, block-anchor 연결을 하나의 새 document translation version으로 원자적으로 저장하고 head를 CAS로 갱신한다. UI의 블록 합치기·나누기·순서 변경·재연결은 모두 이 command로 귀결된다.

`ApplyDocumentTranslationEnvelope`는 `submit_translation` wrapper가 bridge로 제출한 envelope validation을 통과한 뒤 단일 draft·block·유효한 anchor 연결과 current head를 하나의 SQLite transaction에서 적용한다. 민감 정보가 없는 구조 검증 실패는 draft/head를 변경하지 않고 `invalid_unapplied` response artifact로 보존하지만, credential이나 run token이 포함된 payload는 artifact에 보존하지 않는다. DB 적용 중 하나라도 실패하면 전체를 rollback한다.

같은 assistant message에서 이미 번역 version이 생성됐다면 그 version을 반환한다. message의 immutable response artifact hash가 달라졌거나 내용이 다르면 적용하지 않고 `idempotency_conflict`로 거부한다. AI 생성 translation version의 `generated_by_message_id` unique 제약이 이 멱등성을 보장한다.

## 19. 구현 단계

이 절은 M0~M3의 Phase 1 로컬 CAT 도구만 다룬다. Cloud 구현은 15절의 Phase 2 계획을 따른다.

### M0 — 기술 검증과 저장소 골격

구현:

- Electron main/preload/renderer 기본 구조
- domain package와 UUIDv7
- SQLite 연결·migration·transaction wrapper
- `.munhae` 생성·열기·잠금·닫기
- asset import와 hash 저장
- backup/checkpoint/integrity check
- Codex·Claude CLI probe spike

완료 조건:

- 새 프로젝트 생성 후 종료·재실행해 동일 데이터 열기
- 이미지 첨부 후 패키지를 옮겨도 상대경로로 열기
- 비정상 종료 후 SQLite 복구 시험 통과
- provider token이 project/app DB에 저장되지 않음을 검사

### M1 — 로컬 원문·표점·앵커 편집

구현:

- document node tree와 metadata 상속
- source text draft·version·변경 이력
- source-only 문서 생성과 원문 확정 뒤 명시적인 punctuation draft 생성
- punctuation draft·수동 편집·span 저장·확정(이 단계의 자동 제안은 rule/fixture만 사용)
- 산문의 문장·문단과 운문의 논리적 시행·대구·연 구조 편집
- punctuation draft에는 anchor를 만들지 않고 확정 transaction에서 version별 translation anchor set 결정론적 생성
- 앵커 code-point·quote/hash 검증
- 원문·표점 전체 보기와 앵커 강조 UI

완료 조건:

- 원문을 붙여넣으면 source-only 상태이며, 원문 확정 뒤 표점 작업안을 별도로 만들고 편집·확정 가능
- 같은 punctuation version과 전략으로 같은 anchor set 생성
- 시 전체에 시행 앵커와 대구·연 상위 구조를 만들 수 있음
- 논리적 시행이 참고 이미지의 물리적 행·OCR 데이터와 섞이지 않음
- 표점 변경 시 새 anchor set이 생성되고 이전 집합이 보존됨

### M2 — 번역·용어·검증

구현:

- document translation/version/head
- 전체 번역문과 translation block 편집
- translation block ↔ anchor 다대다 연결과 검증
- 단일 `glossary_entries`와 `persons`·`places`·uncertainty
- confirmation
- 번역 블록 합치기·나누기·순서와 앵커 연결 편집
- Markdown/JSON/CSV export

완료 조건:

- 문서 전체의 단일 번역안을 끊김 없이 읽고 편집 가능
- 하나의 자연스러운 번역 블록을 AI가 선택한 여러 앵커에 연결 가능
- 사용자 편집으로 빈 block·unknown anchor·block 내 중복 관계 같은 저장 구조 문제가 생기면 삭제하지 않고 `needs_review`로 보존
- 확정된 내용을 수정하면 새 작업안 생성
- 변경 전후 diff 제공
- textual/interpretive uncertainty 분리
- 번역 블록만으로 대조·세부 편집·확정 가능

### M3 — AI와 프로젝트 문맥

구현:

- CodexAdapter·ClaudeAdapter
- utility process streaming·cancel·error handling
- provider-backed `punctuation_suggest`
- 코드 registry 기반 agent adapter와 `app-config.json` 기반 agent/model preference
- 요청 문자 수·UTF-8 byte 계산과 표시
- provider별 context 초과 오류를 공통 `context_too_large`로 정규화
- exact request·request manifest builder
- 문서 상세에 통합된 AI 번역 대화상자
- 프로젝트·문서 범위의 비변경 자유 채팅
- app-local `app_runtime_sessions`의 실제 session ref와 project-local 비민감 `chat_agent_sessions` metadata를 함께 검사하는 Claude session·Codex thread resume
- assistant message ID 기반 streaming·cancel·private normalized event artifact
- loopback tool bridge·stdin `munhae tools submit-translation` wrapper·run-scoped single-use token
- 한 문서/version당 단일 structured translation call
- JSON schema·현재 anchor set·block key 고유성·빈 block/번역·unknown anchor·block 내 중복 관계·stale/CAS ingestion guard
- AI 제안 → 문서 번역안·번역 블록 적용
- 단일 완성 번역과 block 연결을 적용하는 원자적·멱등 `ApplyDocumentTranslationEnvelope`
- assistant message 기반 request/response provenance·usage·error

완료 조건:

- 두 provider의 설치·로그인 상태를 구분
- 선택 preference와 별개로 실행마다 실제 agent·requested/resolved model·reasoning·service tier·CLI version을 assistant message에 기록
- 로그인 안 됨·CLI 없음·실행 실패를 안전하게 안내
- 실행마다 assistant message에 정확한 request manifest·request/response artifact 저장
- 같은 원문을 작은 묶음 batch마다 반복 전송하지 않음
- context 초과 시 무음 절단·자동 분할·부분 재시도 없이 문서·장·편 단위의 수동 분할을 안내
- 모델 출력이 원문을 되풀이하지 않고 기존 앵커 ID만 참조
- `schemaVersion`, 현재 `anchorSetId`, unique `blockKey`, 빈 block/번역, unknown anchor, block 내 중복 관계, stale/CAS를 검사
- required anchor 누락과 여러 block의 같은 anchor 참조는 앱이 완성도 지표로 강제하지 않고 AI 지침·사용자 검토에 맡김
- 번역 문구·block 묶음·source anchor 대응의 의미적 적절성은 앱이 판정하지 않고 사용자가 검토
- 같은 assistant message의 재적용이 translation version을 중복 생성하지 않고, 다른 response 내용은 거부
- AI output은 참조·구조 수용 조건 하나라도 실패하면 원시 결과만 `invalid_unapplied`로 보존하고 translation draft/head에는 적용하지 않음. `needs_review`는 이후 사용자 수동 편집·연결 과정에만 사용
- 번역 task의 검증된 `submit_translation`만 새 draft를 자동 생성하고 일반 채팅은 번역 데이터를 변경하지 않음
- 일반 채팅에는 user/assistant text와 거친 상태만 보이고 reasoning·activity·tool 호출·tool 입력/결과·raw stream이 노출되지 않음
- run token이 project·message·operation·TTL에 결합되고 첫 호출 후 소비되며 종료·취소에서 폐기됨
- 표점 제안은 검증·미리보기까지만 자동 수행하고, 명시적 적용 전에는 표점 draft/head와 번역 데이터를 변경하지 않음
- 명시적 적용 후에도 anchor 없는 표점 draft만 만들고, 사용자 확정 전에는 anchor/confirmed head를 만들거나 바꾸지 않음
- 같은 Chat thread에서 AI 실행을 직렬화하고 유효한 app-local provider session만 resume
- 실제 provider session ref가 `.munhae`, request/response/event artifact 또는 renderer payload에 남지 않음
- AI 대화상자에는 한 실행이 `submit_translation`으로 완성 번역 하나를 가져온다고 표시됨

## 20. 테스트 전략

### 20.1 단위 테스트

- 단일 `parent_version_id` 계보와 동시 편집 branch 보존
- confirmed immutability
- head CAS
- 표점 변경 diff
- 논리적 시행·대구·연 parent-child의 same-version·범위 포함·비순환 검증
- punctuation version·strategy·coverage policy별 anchor set 결정론과 quote/hash 검증
- 시행 anchor와 같은-version `verse_line` span의 정확한 범위 일치 및 bridge 고유성
- anchor set hash가 ID가 아닌 structure-span signature까지 포함하는지 검증
- anchor set 내 `anchor_key`·ordinal 고유성
- translation block ↔ anchor 존재·block 내 중복·빈 문자열 검사
- envelope의 `schemaVersion`·현재 `anchorSetId`·block key 고유성·stale snapshot/CAS 검사
- 비연속·재정렬 anchor 묶음을 의미적 이유로 거부하지 않고 제출 결과를 사용자 검토에 노출
- 단일 translation transaction의 원자성·rollback·assistant-message 기반 멱등 재시도와 response-hash 충돌 거부
- 구조 연결이 깨진 AI output의 `invalid_unapplied` artifact 보존과 translation head 미갱신
- parse 불가능 AI output의 `invalid_unapplied` artifact 보존과 translation head 미갱신
- 전체 표점 원문 우선순위와 요청 문자 수·UTF-8 byte 계산
- provider context 초과 오류 정규화와 무음 truncate·자동 부분 재시도 방지
- 번역 블록 합치기·나누기 후 target 범위/hash·앵커 연결 보존
- glossary entry와 인물·지명 이름·별칭 exact matching
- glossary `term_kind`와 `preferred/allowed/forbidden` QA
- assistant message의 task별 output contract와 일반 chat의 `not_applicable` 검증
- 표점 제안의 자동 미적용, 명시적 적용, stale snapshot/CAS 거부, invalid 응답 보존
- app-local `(thread_id, agent_id)` provider session round-trip·clear, artifact session-ref 누출 방지와 같은 thread 동시 실행 차단
- loopback tool token의 project/run/operation/TTL binding·single-use·취소 후 폐기·override 거부
- chat renderer에 user/assistant text·거친 상태만 전달되고 tool/reasoning 입력·결과가 제거되는지 검증

### 20.2 Electron E2E

- 새 프로젝트 → 원문 저장·확정 → 표점 원문 생성·편집·저장·확정 → 분절 검토 → 문서 전체 번역 → 확정
- 시 전체 → 시행·대구·연 → 시행 앵커 → 대구 단위 번역 블록
- 번역 블록으로 단일 번역 생성·편집·검증·확정
- provider context 초과 응답 시 원문을 변경하지 않고 수동 문서·장 분할 안내
- unknown anchor·block 내 중복 관계·빈 block AI 응답을 `invalid_unapplied`로 보존하고 미적용
- required anchor를 생략하거나 같은 anchor를 여러 block에 연결한 AI 응답도 완성도를 기계적으로 판정하지 않고 작업안으로 보여줌
- 앱 재시작·crash recovery
- asset 이동·누락·checksum 오류
- provider CLI 없음·로그인 필요·취소·timeout
- 프로젝트·문서 내부 채팅 session resume와 비변경 보장
- 번역 중 wrapper 호출이 채팅에 보이지 않고 완료 후 번역안만 editor에 나타남
- large document scrolling
- keyboard-only editing
- CSP·IPC validation·path traversal

## 21. 관측성과 진단

- 사용자 원문과 번역문은 기본 로그에 기록하지 않음
- assistant message ID·command ID·project ID는 안전한 opaque ID로 기록
- provider 오류에서 credential과 prompt redaction
- SQLite migration·checkpoint·integrity 결과 기록
- AI token/cost는 provider가 제공한 경우에만 표시
- crash report와 usage analytics는 opt-in

## 22. 주요 위험과 대응

| 위험 | 대응 |
|---|---|
| 고한문 장문에서 입력+출력 context 초과 | 모델별 token 계산 없이 provider 오류를 정규화하고, 무음 절단 없이 사용자가 문서·장·편 경계에서 수동 분할 |
| AI 오류가 후속 번역 예시에 누적 | 확정된 번역만 실행 시 직접 조회해 예시 후보로 사용 |
| 표점 변경으로 번역 연결 붕괴 | exact punctuation version별 새 anchor set, code-point+quote hash, 이전 번역 보존과 stale 표시 |
| 앵커를 편집 단위로 오해 | 앵커는 기술 참조로 한정하고 AI가 선택한 앵커를 번역 블록으로 묶는 다대다 연결 제공 |
| 시를 문장부호만으로 잘못 분리 | 표점안에 논리적 시행·대구·연 구조 저장, 시 전체 입력, 물리적 이미지 행과 분리 |
| 구조화 AI 제출의 참조 무결성 실패 | JSON schema·현재 anchor set·빈 block/번역·unknown anchor·block 내 중복 관계·stale/CAS 검사 후 민감 정보가 없는 원시 결과만 `invalid_unapplied`로 보존하고 draft/head 미변경 |
| SQLite 파일 손상 | single writer, WAL checkpoint, backup API, integrity check |
| OAuth token 노출 | CLI·Keychain 소유, DB 저장 금지, log redaction |
| 스키마 과설계 | M0~M3 로컬 핵심부터 구현, 후순위 table은 실제 기능과 함께 추가 |

## 23. 구현 전 남은 선택

다음 항목은 M0 spike 결과로 결정한다.

- Electron bundler와 packaging 도구
- SQLite driver와 native module 배포 방식
- query builder/ORM 사용 여부
- Codex·Claude CLI의 안정적인 streaming·resume capability
- context 초과 시 문서·장·편 경계에서 수동 분할하도록 안내하는 UX
- AI request 원문 보관 기본값

선택 기준은 기능 수보다 다음을 우선한다.

- Electron 배포 안정성
- migration 통제
- 보안 경계의 명확성
- provider 교체 가능성
- 오픈소스 기여자가 로컬에서 쉽게 실행할 수 있는가

## 24. 첫 구현 작업 목록

1. monorepo와 Electron skeleton 생성
2. `packages/domain`에 ID·version·state·command 정의
3. `.munhae/manifest.json` JSON Schema 작성
4. SQLite M0 schema와 migration runner 작성
5. project create/open/lock/backup 구현
6. source asset import·hash·relative path 구현
7. source text draft/version/head 구현
8. punctuation draft/version/head와 논리 구조 span 구현
9. punctuation 확정 transaction의 version 기반 translation anchor generator 구현
10. document translation/version/head와 block-anchor 연결 구현
11. 전체 원문·표점·번역 editor vertical slice 완성
12. Codex/Claude CLI probe와 fixture 기반 parser spike
13. 요청 문자 수·UTF-8 byte 표시와 provider context 오류 정규화 구현
14. context item 선택 → request manifest·request artifact 생성 구현
15. Chat thread·assistant message·app-local provider session·비민감 project metadata·private normalized event log 구현
16. loopback tool bridge·wrapper·run-scoped token 구현
17. 번역 task의 `submit_translation` → 문서 번역안·block validator → 사용자 수정 → 확정 vertical slice

첫 vertical slice의 성공 기준:

```text
로컬 프로젝트 생성
 → 원문 입력
 → 원문 저장·확정
 → 표점 원문 작업안 명시 생성·편집·저장
 → 표점 확정과 함께 번역 앵커 생성
 → 분절 앵커 읽기 전용 검토
 → 전체 요청의 문자 수·UTF-8 byte 표시
 → Codex 또는 Claude에 표점된 문서 전체를 한 번 전송
 → assistant message와 request/response artifact 저장
 → 완성 JSON 하나를 native shell에서 wrapper 표준 입력으로 전달
 → run-scoped token으로 `munhae tools submit-translation` 한 번 호출
 → `submit_translation` JSON Schema 검증
 → 앵커 ID 기반 참조·구조 무결성 검사·저장
 → 단일 완성 번역 작업안 표시
 → 전체 번역문 사용자 수정
 → 확정
 → 앱 재실행 후 전체 이력 복구
```

이 흐름이 안정적으로 동작하기 전에는 OCR, 전사, 다판본 교감, CRDT, vector search를 추가하지 않는다.
