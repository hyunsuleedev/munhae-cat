# 문해 CAT 구현 계획

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
- 표점안 전체를 기본 LLM 입력으로 사용하고 한 번의 요청으로 문서 번역안 생성
- 표점안의 문장·문단·논리적 시행 경계에서 가벼운 앵커를 만들고 원문-번역 연결
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

- 프로젝트 생성·열기·백업·내보내기
- 원본 이미지·PDF 첨부와 페이지 보기
- 원문 붙여넣기·직접 입력·텍스트 파일 가져오기
- 원문 변경 이력
- 표점안 작성·AI 제안·수동 편집·확정
- 표점안의 문장·문단과 운문의 논리적 시행·대구·연 구조 편집
- 정확한 표점 version을 기반으로 한 번역 앵커 자동 생성
- 문서 전체 번역안·대안·확정과 번역 블록 편집
- 앵커와 번역 블록에 의한 원문-번역 대조 및 구간 연결
- 번역 블록 합치기·나누기·순서와 원문 앵커 연결 조정
- Reflection과 품질 점검
- 용어집·인물·지명·불확실성 기록
- 프로젝트 문맥 미리보기·고정·제외
- Codex·Claude 내부 채팅 및 번역 작업
- 번역안 확인·확정
- Phase 2 Cloud·협업·공개 서비스는 별도 섹션에서 정의

### 4.2 현재 제외

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
새 로컬 프로젝트
 → 원본 이미지/PDF 첨부(선택)
 → 원문 입력·가져오기
 → 표점·문단·운문 구조안 생성·편집·확정
 → 해당 표점안에서 번역 앵커 생성
 → 표점된 문서 전체 번역안 생성·편집
 → 원문 앵커와 번역 블록 연결 검토
 → Reflection·검토
 → 확정
 → 로컬 백업·내보내기
```

로컬 프로젝트는 회원가입이나 서버 연결 없이 동작해야 한다.

### 5.2 AI 번역

```text
사용자가 번역할 문서·장과 정확한 표점안 선택
 → 표점 version에서 번역 앵커 생성·검증
 → 전체 요청의 문자 수·UTF-8 byte 표시
 → 사용할 프로젝트 문맥과 provider 전송 범위 미리보기
 → Codex 또는 Claude 선택
 → 로컬 CLI로 한 번의 문서 번역 요청
 → 앵커 ID를 참조한 구조화 결과 streaming
 → coverage·ID·순서·연속성·빈 번역 검증
 → AI 제안·번역 블록 연결·가시적 Reflection 저장
 → Reflection 결과 표시
 → 전체 번역문과 블록을 사용자 편집
 → 검토 후 확정
```

AI가 만든 결과는 자동으로 확정하지 않는다.

번역 요청에는 표점된 원문 전체를 한 번만 넣고, 같은 원문을 여러 batch에 반복해서 보내지 않는다. 모델은 원문을 출력에 되풀이하지 않고 기존 앵커 ID와 번역문만 반환한다. 인접한 여러 앵커를 자연스러운 한국어 번역 블록 하나로 묶을 수 있으며 앵커는 의미상 1:1 번역 단위를 강제하지 않는다.

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
                     ├─ Validation / Term Decision
                     └─ Reflection / Quality Check

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

MongoDB 같은 문서형 NoSQL을 별도 원장으로 추가하지 않는다. JSON은 plugin 설정, provider metadata, workflow output schema처럼 유연성이 필요한 부가 필드에만 사용한다.

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
- `app_runtime_sessions`: 로컬 CLI resume 정보
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

번역 정책에는 대상 독자, 번역 단계, 중요 용어의 `한국어(漢字)` 표기, 보충 표현 규칙, 불확실성 표시, Reflection 필수 여부를 포함한다.

### 8.3 문서 노드·참고 자료

- `document_nodes`
- `src_assets`
- `src_asset_locations`
- `src_asset_pages`
- `src_node_assets`

작품·권·장·개별 글은 공통 metadata를 가질 수 있는 `document_nodes` 트리로 표현한다. 프로젝트 생성 시 프로젝트 제목의 `is_master=1` 최상위 `container`를 정확히 하나 만들고, 모든 문서 node는 그 아래에 둔다. 이 마스터 container는 이동·삭제·원문 단위 전환을 허용하지 않는다. `structural_kind`는 `collection | work | volume | chapter | section | item`, `genre`는 번역에 필요한 문학·문서 장르로 분리한다.

각 node는 파일 시스템의 폴더/파일에 해당하는 `node_role = container | source_unit`을 명시한다. `container`는 하위 node와 metadata·context를 가질 수 있지만 원문·표점·앵커·번역안을 가질 수 없다. `source_unit`은 원문부터 번역까지의 실제 작업 단위이며 하위 node를 가질 수 없다. 구조 종류와 역할은 독립적이어서 같은 `chapter`도 목차 폴더나 장 전체 원문 문서가 될 수 있다. 상위 `container`에 묶인 context는 복사하지 않고 하위 `source_unit`의 AI 요청에서 상속한다.

공통 `author_person_id`, `language`, `period_text`, `source_reference`는 현재 node에 값이 없으면 가장 가까운 상위 node에서 가져온다. 제목·구조 종류·순서·개별 날짜·장르는 상속하지 않는다. 발신자·수신자와 별도 다중 인물 연결 table은 데모에 두지 않는다.

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

punctuation version의 content hash는 표점 문자열뿐 아니라 ID를 제외하고 정렬한 논리 구조 span manifest까지 포함한다. 구두점이 같아도 시행·대구·연·문단 구조가 바뀌면 새 punctuation version과 hash를 만든다.

표점 version은 구두점뿐 아니라 번역 연결에 필요한 논리 구조도 가진다.

- 산문: `title | heading | paragraph | sentence | clause | quotation`
- 운문: `verse_line | couplet | stanza`
- 사(詞): 구와 상편·하편을 parent-child span으로 표현 가능
- 부(賦)·소(騷): 문장 구조와 운문 구조를 함께 표현 가능

`verse_line`은 연구자가 표점안에서 확정한 논리적 시행이다. 원본 이미지나 필사본의 물리적 행과 동일한 개념이 아니며 OCR·이미지 좌표·전사 행을 도입하지 않는다. 절구·율시는 시행 앵커를 기본으로 하되 대구와 연을 상위 span으로 묶고, 고시·악부·가행은 글자 수만으로 기계 분리하지 않는다.

사용자 흐름:

```text
표점안 저장 → 변경 이력 → 검토 → 확정
```

무표점 원문은 표점 version을 먼저 만들어야 정렬 가능한 번역 앵커를 생성할 수 있다. 이미 표점된 텍스트를 가져온 경우에도 원문 version과 구별되는 최초 punctuation version으로 저장한 뒤 같은 방식으로 앵커를 만든다.

### 8.6 번역 앵커와 표점 구조

- `translation_anchor_sets(id, project_id, document_node_id, source_text_version_id, punctuation_version_id, strategy_key, strategy_version, coverage_policy, anchor_set_hash, created_by_actor_id, created_at)`
- `translation_anchors(id, project_id, anchor_set_id, anchor_key, ordinal, boundary_kind, punctuation_codepoint_from, punctuation_codepoint_to, punctuated_quote, punctuated_quote_hash, source_codepoint_from, source_codepoint_to, source_quote, source_quote_hash, context_before_hash, context_after_hash, display_label, required, created_at)`
- `translation_anchor_structure_spans(project_id, anchor_id, punctuation_structure_span_id, ordinal)`

한 anchor set은 정확히 하나의 source text version과 punctuation version에서 결정론적으로 생성하는 불변 파생 집합이다. `punctuation_version_id`는 필수이며 `anchor_set_hash`는 새 UUID가 아니라 결정론적 `anchor_key`·범위·quote hash와 ID를 제외한 structure-span signature를 포함한다. `(punctuation_version_id, strategy_key, strategy_version, coverage_policy)`를 unique로 두어 같은 입력의 재생성은 기존 set을 재사용한다. anchor set에는 별도 version/head를 두지 않는다.

앵커는 모델과 편집기가 원문 위치를 참조하기 위한 가벼운 기술 표지다. 의미상 번역 단위가 아니고 1:1 번역을 강제하지 않는다. `boundary_kind`는 `document | title | heading | paragraph | sentence | clause | verse_line | manual`을 사용하며 운문에서는 `punctuation_structure_spans`의 `verse_line`을 직접 참조할 수 있다.

anchor-span 연결은 같은 punctuation version 안에서만 허용한다. `verse_line` anchor는 범위가 정확히 같은 논리적 `verse_line` span 하나를 필수로 참조하며, 해당 시행을 포함하는 `couplet`·`stanza`는 상위 문맥 span으로 추가 참조한다. structure parent-child는 같은 version, child 범위의 parent 포함, 비순환 조건을 검증한다.

LLM output의 `sourceAnchorIds`는 랜덤 DB UUID가 아니라 해당 anchor set 안에서 결정론적으로 생성한 `anchor_key`(`A001` 등)를 사용한다.

표점 version이 바뀌면 새 anchor set을 만든다. 기존 번역과 앵커는 삭제하지 않고 새 표점안 기준으로 `재검토 필요`를 표시한다.

표점이 변경되면:

1. 새 punctuation version 생성
2. 이전과 새 표점의 차이 계산
3. 새 translation anchor set 생성
4. 기존 문서 번역을 `재검토 필요`로 표시
5. 기존 번역·블록·앵커 연결 이력은 삭제하지 않음

### 8.7 문서 번역과 번역 블록

- `document_translations`: source text + target locale + stage의 안정적 번역 작업
- `document_translation_versions`
- `document_translation_heads`
- `translation_blocks`
- `translation_block_anchors`
- `document_translation_validations`
- `document_translation_validation_findings`
- `reflection_reports`
- `reflection_report_translation_versions`
- `reflection_findings`
- `reflection_finding_anchors`
- `translation_quality_checks`
- `translation_staleness`

`document_translation_versions`는 nullable `parent_version_id` 하나를 직접 가진다. 일반 편집·AI 재생성은 기준 version을 부모로 새 version을 만들고, 동시 편집은 같은 부모에서 갈라진 두 branch를 모두 보존한다. 별도 parent join table과 multi-parent merge 계보는 초기 범위에 두지 않는다.

`document_translation_heads`는 번역 작업별 `current_version_id`, `confirmed_version_id`, `lock_version`만 관리한다. 현재 작업안과 마지막 확정본을 빠르게 찾고 CAS로 동시 저장 충돌을 막기 위한 내부 포인터이며 사용자 화면에 노출하지 않는다.

`document_translation_versions`는 전체 한국어 번역문을 `text_content`로 저장하고 정확한 다음 입력을 참조한다.

- `source_text_version_id`
- `punctuation_version_id`
- `translation_anchor_set_id`
- `translation_policy_version_id`
- `generated_by_message_id`·`generation_candidate_key` 또는 human actor
- `document_translation_versions.validation_state`: `valid | needs_review`
- assistant message의 `output_validation_state`: `valid | needs_review | invalid_unapplied | not_applicable`

`translation_blocks`는 번역 전문을 복사하지 않고 문서 번역 version 안의 한국어 code-point 범위와 `target_hash`를 보관한다. version 안에서 block key·ordinal은 각각 유일하고 target 범위는 전문을 순서대로 coverage한다. `translation_block_anchors`가 블록과 하나 이상의 원문 앵커를 연결하며 한 block 안에서 anchor와 연결 ordinal을 중복할 수 없다. 자연스러운 번역을 위해 하나의 한국어 블록이 인접한 여러 원문 앵커를 묶을 수 있고, 사용자가 블록을 나눈 경우에는 한 앵커가 `relation_kind = partial`로 인접한 여러 한국어 블록과 연결될 수 있다.

블록 합치기·나누기·순서·앵커 연결 수정은 새 document translation version과 그 version의 block 집합을 만든다. 이전 version의 전체 번역문과 block 집합은 변경 이력으로 보존한다.

AI는 원문을 되풀이하지 않고, 한 번의 응답 envelope에 recipe가 요구한 모든 완성 번역안과 가시적 Reflection을 담으며 기존 앵커 ID만 참조한다. 번역안이 하나인 recipe는 `candidates`에 하나만 넣는다.

```json
{
  "schemaVersion": 1,
  "anchorSetId": "tas_...",
  "candidates": [
    {
      "candidateKey": "shin",
      "stage": "shin",
      "blocks": [
        {
          "blockKey": "b1",
          "sourceAnchorIds": ["A001", "A002"],
          "blockKind": "paragraph",
          "translation": "…"
        }
      ]
    }
  ],
  "reflection": {
    "summary": "…",
    "findings": [
      {
        "candidateKey": "shin",
        "findingKind": "term_consistency",
        "severity": "warning",
        "sourceAnchorIds": ["A001"],
        "message": "…"
      }
    ]
  }
}
```

저장 전에 다음을 검증한다.

- `anchorSetId`가 요청에 고정한 set과 일치하는가
- `schemaVersion`이 지원하는 output contract version과 일치하는가
- `candidateKey`가 envelope 안에서 중복되지 않는가
- candidate `stage`가 recipe에 정의되어 있고 stage당 candidate가 하나뿐인가
- `(candidateKey, stage)` 집합이 recipe output contract의 필수 집합과 정확히 같아서 누락·추가·잘못된 pairing이 없는가
- candidate별 anchor set의 모든 required 앵커가 빠짐없이 연결되는가
- candidate 안에서 `blockKey`가 유일하고 배열 순서에서 계산한 block ordinal이 중복되지 않는가
- 존재하지 않는 앵커 ID가 없는가
- 원문 앵커 순서가 뒤집히지 않았는가
- 한 블록이 묶은 앵커가 연속하는가
- 번역 문자열이 비어 있지 않은가
- Reflection이 policy/recipe가 요구한 개수대로 있고, 각 finding의 `candidateKey`가 null(전역) 또는 존재하는 candidate이며 `sourceAnchorIds`가 유효한가. 유효한 ID는 `reflection_finding_anchors`에 순서대로 저장하고 잘못된 원시 key는 AI output·validation finding에 보존한다.

validation은 두 단계로 처리하며 어느 경우에도 원시 AI output을 삭제하거나 조용히 자동 교정하지 않는다.

- **fatal envelope validation**: JSON parse, `schemaVersion`, `anchorSetId`, recipe가 요구한 exact `(candidateKey, stage)` 집합, candidate/block key 고유성이 깨진 경우다. translation version을 적용하지 않고 output artifact를 `invalid_unapplied`로 보존하며 head를 갱신하지 않는다.
- **recoverable structural validation**: 번역 문자열은 복구할 수 있지만 anchor coverage·순서·연속성·Reflection 연결이 깨진 경우다. 모든 candidate와 Reflection을 하나의 transaction으로 보존하되 영향받은 candidate를 `needs_review` draft로 current head에 올리고 confirmed head는 변경하지 않는다. 유효하지 않은 FK 연결은 삽입하지 않고 원시 key와 finding을 남긴다.

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

문맥 조립 규칙은 Phase 1 코드에 하나의 기본 순서로 고정한다. `context_items`에는 다른 domain table로 표현되지 않는 프로젝트 설명·시대 배경·문체 지침·외부 근거만 저장한다. 용어·인물·지명·확정 번역은 원래 table에서 직접 선택하며 중복 복사하지 않는다. 독립적인 연구 노트와 인용 관리 기능은 MVP에 포함하지 않는다.

`context_items`의 적용 범위는 `document_node` 하나로 통일한다. 특정 문서 node에서 AI 요청을 조립할 때는 **현재 node → 가장 가까운 상위 node → 더 먼 상위 node → 프로젝트 마스터 container** 순으로 적용하고, 같은 범위 안에서는 `priority` 내림차순으로 놓는다. 프로젝트 공통 문맥은 별도 scope가 아니라 마스터 container에 직접 연결한 문맥이다. 하위 node에 상위 문맥을 복사해 저장하지 않고 요청 시점에 조상 경로를 해석한다. 다른 가지의 문맥은 자동 포함하지 않는다. 프로젝트 용어·인물·지명은 node마다 복사하지 않고 공통 원본을 유지하되, 현재 원문의 exact match·상속 저자·관련 앵커로 해당 node에 적용할 항목만 고른다.

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
- `chat_agent_sessions(project_id, thread_id, agent_id, native_session_id, model, cwd_hash, last_message_id, stable_prompt_hash, state, updated_at)`

AI 호출 하나는 assistant message 하나이며 message ID를 runtime run ID로도 사용한다. 일반 채팅은 자유 텍스트로 저장하고, 번역 작업만 `translation-envelope.v1`을 인자로 받는 `submit_translation` domain tool 호출을 요구한다. 검증을 통과한 tool 호출은 기존 번역을 덮어쓰지 않고 새 draft version을 자동 생성하며, 표점 변경·확정·삭제는 별도 사용자 확인을 요구한다.

일반 chat의 최종 응답 또는 `submit_translation`에 제출된 canonical envelope는 `response_artifact_id`에 저장한다. 사용량·오류는 message의 JSON에, 실시간 tool call과 상세 event는 `runs/<assistant-message-id>/events.jsonl`에 저장하고 `events_artifact_id`로 연결한다. 별도 AI run·output·usage·error·feedback·tool-call·application table은 만들지 않는다. 생성된 translation version은 `generated_by_message_id`와 `generation_candidate_key`로 출처와 멱등성을 보존한다.

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
- 새 punctuation version은 새 anchor set을 요구한다.
- 앵커는 표점 경계와 논리 구조를 참조하는 기술적 위치 표지이며 편집 단위가 아니다.
- 문서 번역 version은 자신이 사용한 source text, punctuation, anchor set을 모두 고정 참조한다.
- 하나의 번역 블록은 자연스러운 한국어를 위해 인접 앵커 여러 개를 묶을 수 있다.
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
2. 프로젝트 번역 원칙과 현재 작업 recipe·output schema
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
          ├─ Local Project Repository
          └─ Utility Process: Agent Runtime
              ├─ CodexAdapter → codex CLI
              └─ ClaudeAdapter → claude CLI
```

Renderer에서 shell이나 Node API에 직접 접근하지 않는다.

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

OpenDesign처럼 모델별 token 수를 추정하지 않는다. Claude·Codex처럼 prompt를 stdin으로 받는 adapter에는 모델 context preflight를 두지 않는다. 향후 prompt를 argv로 전달하는 adapter를 추가할 때만 운영체제 command-line 한도를 넘지 않도록 adapter별 UTF-8 byte guard를 둔다.

unsafe permission bypass 옵션을 기본값으로 사용하지 않는다. 번역 실행용 임시 작업 디렉터리는 최소 파일만 포함하고 사용자 홈이나 프로젝트 전체에 불필요한 쓰기 권한을 주지 않는다.

### 11.4 구조화된 AI 작업

- `project_chat`
- `punctuation_suggest`
- `translate_document_literal`
- `translate_document_shin_dal_a`
- `translate_document_reader`
- `reflect_translation`
- `review_consistency`
- `suggest_glossary`
- `explain_uncertainty`

일반 `project_chat`은 자유 텍스트다. 문서 번역 작업만 `translation-envelope.v1` JSON Schema를 인자로 받는 `submit_translation` domain tool 호출을 필수로 한다. 다른 작업은 실제 요구가 확인되기 전까지 별도 JSON contract를 강제하지 않는다. 자유 채팅 답변과 실제 프로젝트 mutation은 분리한다.

문서 번역 작업은 다음 계약을 따른다.

1. exact source text·punctuation·anchor set·policy와 선택한 보조 문맥을 고정한다.
2. 전체 표점 원문과 앵커를 포함한 최종 요청의 문자 수와 UTF-8 byte를 계산해 사용자에게 표시한다.
3. 해당 문서/version의 번역 생성은 한 번의 LLM 호출로 실행한다.
4. 모델은 원문을 되풀이하지 않고 `candidates[{candidateKey, stage, blocks[{blockKey, sourceAnchorIds, blockKind, translation}]}]`와 가시적 Reflection을 반환한다. candidate별 block을 순서대로 합친 값이 해당 stage의 전체 번역안이다.
5. candidate별 구조화 결과를 검증한 뒤 같은 assistant message를 참조하는 document translation version과 block 연결을 저장한다.

translation generation을 작은 묶음의 반복 batch로 나누면서 같은 전체 원문을 매번 재전송하는 구현은 금지한다. 별도의 사용자 요청으로 확정 후 재검토하거나 수정본을 다시 Reflection하는 실행은 독립된 새 assistant message이며, 실행 전에 원문 재전송 범위와 문자·byte 크기를 다시 보여준다.

CLI가 `context_length_exceeded`, `prompt_too_large`, `input_too_long`, `maximum_context_length` 계열 오류를 반환하면 공통 `context_too_large` 오류로 정규화한다. 앱은 자동 절단·자동 분할·부분 재시도를 하지 않고 사용자가 문서·장·편 단위로 원문을 나누도록 안내한다.

### 11.5 Reflection

Reflection은 기본 workflow에 포함하며 최초 문서 번역에서는 같은 구조화 응답으로 요청한다. 숨은 사고과정을 요구하지 않고 아래 검사 결과·근거 앵커·제안만 받는다.

검사 항목:

- 원문 누락
- 부정·수량·시간·인과 관계 오류
- 주체·객체·수식 범위 오류
- 인물·지명·관직·서명 불일치
- 용어집 위반
- 원문 밖 정보의 무표시 삽입
- 지나친 축약·의역
- 문체·독자층 불일치
- textual uncertainty와 interpretive uncertainty 혼동

Reflection은 숨은 사고과정이 아니라 사용자가 볼 수 있는 구조화된 검토 결과로 저장한다.

사용자 편집 후 Reflection을 다시 요청하는 것은 선택적 후속 기능이다. 이 경우 편집된 번역 version과 정확한 전체 표점 원문을 기준으로 새 request artifact와 assistant message를 만들며, 최초 단일 번역 호출에 포함된 Reflection과 구분한다.

## 12. 번역 작업 recipe

### 12.1 기본: two-step + Reflection

1. 원문 구조와 중요 용어 확인
2. 직역 중심 번역안
3. 독자 친화적 번역안
4. Reflection
5. 사용자 수정
6. 검토·확정

### 12.2 문학·수사 텍스트: three-step + Reflection

1. 信: 원문 정보와 논리 보존
2. 達: 자연스럽고 명료한 한국어
3. 雅: 문체·운율·수사 반영
4. Reflection
5. 사용자 수정
6. 검토·확정

각 단계는 독립적으로 읽을 수 있는 완성 번역안을 보여준다. 중요한 용어의 `한국어(漢字)` 표기도 단계별로 유지한다.

기본적으로 한 recipe의 번역 단계와 Reflection을 한 문서 번역 호출의 구조화 결과로 함께 받는다. 응답의 모든 candidate는 해당 stage의 전체 번역·block·anchor 연결을 갖는 독립 draft로 저장하여 사용자가 모두 읽고 비교할 수 있게 한다. 사용자는 그중 하나를 후속 편집·확정의 기반으로 채택하며, 나머지 candidate도 자동 삭제하지 않고 AI draft와 provenance로 보존한다. envelope 단위 Reflection report 하나를 모든 candidate version과 연결하고, candidate 특정 finding은 해당 document translation version을 가리킨다.

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
- provider process에 전달할 환경변수 allowlist
- 로그에서 token·cookie·Authorization header 제거
- auto-update 서명 검증
- Content Security Policy 적용
- crash report는 opt-in

## 14. 로컬 SQLite 운영

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
- server framework, Object Storage, auth/OIDC provider 선택
- 완료 조건: import 전후 row/hash 일치, 자동 sync 없음, 미확정 version 공유 차단, 내부 정보 release 제외

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
│ 참고 이미지/PDF  │ 원문·표점·문서 전체 번역  │ 문맥·AI 채팅      │
│ 선택적 패널       │ 주 편집 영역               │ 용어·문맥 카드      │
└──────────────────┴────────────────────────────┴──────────────────┘
```

주요 상호작용:

- 원문/표점/번역 병렬 보기
- 전체 번역문을 끊김 없이 읽고 편집
- 원문 앵커와 번역 블록 사이 이동·강조
- 운문의 시행·대구·연 구조 표시
- 번역 블록 합치기·나누기와 앵커 연결 조정
- AI 제안과 사용자 번역 비교
- 변경 이력 diff
- 용어·인물·지명 hover 카드
- 불확실성 표시
- Reflection finding에서 원문·번역 span 이동
- 번역안과 `확정` 상태를 명확히 분리

### 17.3 문서 상세의 AI 번역 대화상자

별도 실행 페이지를 만들지 않는다. 현재 원문·표점·번역을 보고 있는 문서 상세 화면에서 AI 번역을 열고 다음을 확인한다.

- 이번 AI 실행에 포함할 항목
- 포함 이유와 출처
- exact version과 hash
- 보조 항목 pin/exclude
- provider 전송 범위
- 전체 입력·예상 출력·응답 여유분과 model limit
- 실행 가능 여부와 필요한 경우 문서·장 나누기 안내

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
    workflow-engine/       # recipe, stage, confirmation
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

`ApplyDocumentTranslationEnvelope`는 `submit_translation` tool argument의 fatal envelope validation을 통과한 뒤 모든 candidate draft·block·유효한 anchor 연결·stage current head·공통 Reflection report·candidate link를 하나의 SQLite transaction에서 적용한다. recoverable structural finding이 있는 candidate는 `needs_review`로 적용하고 confirmed head는 그대로 둔다. DB 적용 중 하나라도 실패하면 전체를 rollback하고 assistant message의 raw response artifact는 보존한다.

같은 assistant message와 `generation_candidate_key`의 재호출은 기존 translation version을 반환한다. message의 immutable response artifact hash가 달라졌거나 같은 candidate key가 다른 내용으로 들어오면 적용하지 않고 `idempotency_conflict`로 거부한다.

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
- punctuation draft·수동 편집·확정(이 단계의 자동 제안은 rule/fixture만 사용)
- 산문의 문장·문단과 운문의 논리적 시행·대구·연 구조 편집
- punctuation version별 translation anchor set 결정론적 생성
- 앵커 code-point·quote/hash 검증
- 원문·표점 전체 보기와 앵커 강조 UI

완료 조건:

- 원문을 붙여넣고 표점안과 논리 구조를 확정 가능
- 같은 punctuation version과 전략으로 같은 anchor set 생성
- 시 전체에 시행 앵커와 대구·연 상위 구조를 만들 수 있음
- 논리적 시행이 참고 이미지의 물리적 행·OCR 데이터와 섞이지 않음
- 표점 변경 시 새 anchor set이 생성되고 이전 집합이 보존됨

### M2 — 번역·용어·Reflection

구현:

- document translation/version/head
- 전체 번역문과 translation block 편집
- translation block ↔ anchor 다대다 연결과 검증
- 단일 `glossary_entries`와 `persons`·`places`·uncertainty
- Reflection report·finding
- confirmation
- 번역 블록 합치기·나누기·순서와 앵커 연결 편집
- Markdown/JSON/CSV export

완료 조건:

- 문서 전체 번역안과 대안을 끊김 없이 읽고 편집 가능
- 하나의 자연스러운 번역 블록을 여러 인접 앵커에 연결 가능
- 잘못된·불완전한 연결은 삭제하지 않고 `needs_review`로 보존
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
- 프로젝트 채팅
- `chat_agent_sessions` 기반 Claude session·Codex thread resume
- assistant message ID 기반 streaming·cancel·`events.jsonl`
- 한 문서/version당 단일 structured translation call
- anchor set·exact candidate key/stage 집합·block key/ordinal 고유성·앵커 coverage·unknown ID·순서·연속성·빈 번역 validator
- AI 제안 → 문서 번역안·번역 블록 적용
- 모든 candidate와 공통 Reflection을 적용하는 원자적·멱등 `ApplyDocumentTranslationEnvelope`
- assistant message 기반 request/response provenance·usage·error

완료 조건:

- 두 provider의 설치·로그인 상태를 구분
- 선택 preference와 별개로 실행마다 실제 agent·requested/resolved model·reasoning·service tier·CLI version을 assistant message에 기록
- 로그인 안 됨·CLI 없음·실행 실패를 안전하게 안내
- 실행마다 assistant message에 정확한 request manifest·request/response artifact 저장
- 같은 원문을 작은 묶음 batch마다 반복 전송하지 않음
- context 초과 시 무음 절단·자동 분할·부분 재시도 없이 문서·장·편 단위의 수동 분할을 안내
- 모델 출력이 원문을 되풀이하지 않고 기존 앵커 ID만 참조
- `schemaVersion`, `anchorSetId`, recipe가 요구한 exact `(candidateKey, stage)` 집합, unique `blockKey`를 검증
- 같은 assistant message·candidate key의 재적용이 candidate version·Reflection link를 중복 생성하지 않고, 다른 response 내용은 거부
- validation 실패 시 원시 결과를 보존하고 복구 가능한 안은 `needs_review`, parse 불가능 응답은 `invalid_unapplied` 표시
- 번역 task의 검증된 `submit_translation`만 새 draft를 자동 생성하고 일반 채팅은 번역 데이터를 변경하지 않음
- 같은 Chat thread에서 AI 실행을 직렬화하고 유효한 native session만 resume
- Reflection이 별도 가시적 결과로 표시됨

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
- translation block ↔ anchor coverage·unknown ID·순서·연속성·빈 번역 검증
- envelope의 `schemaVersion`·`anchorSetId`·exact candidate 집합·candidate/block key 고유성 검증
- 다중 candidate + 공통 Reflection transaction의 원자성·rollback·assistant-message 기반 멱등 재시도와 response-hash 충돌 거부
- Reflection finding의 candidate-version 소속과 source-anchor join 순서·고유성 검증
- 구조 연결만 깨진 복구 가능 AI output의 `needs_review` draft 보존
- parse 불가능 AI output의 `invalid_unapplied` artifact 보존과 translation head 미갱신
- 전체 표점 원문 우선순위와 요청 문자 수·UTF-8 byte 계산
- provider context 초과 오류 정규화와 무음 truncate·자동 부분 재시도 방지
- 번역 블록 합치기·나누기 후 target 범위/hash·앵커 연결 보존
- glossary entry와 인물·지명 이름·별칭 exact matching
- glossary `term_kind`와 `preferred/allowed/forbidden` QA
- assistant message의 task별 output contract와 일반 chat의 `not_applicable` 검증
- `(thread_id, agent_id)` native session resume와 같은 thread 동시 실행 차단

### 20.2 Electron E2E

- 새 프로젝트 → 원문 → 표점·구조 → 앵커 → 문서 전체 번역 → 확정
- 시 전체 → 시행·대구·연 → 시행 앵커 → 대구 단위 번역 블록
- 번역 블록으로 번역 생성·편집·Reflection·확정
- provider context 초과 응답 시 원문을 변경하지 않고 수동 문서·장 분할 안내
- unknown·누락·비연속 앵커 AI 응답을 `needs_review`로 복구
- 앱 재시작·crash recovery
- asset 이동·누락·checksum 오류
- provider CLI 없음·로그인 필요·취소·timeout
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
| 앵커를 편집 단위로 오해 | 앵커는 기술 참조로 한정하고 인접 앵커를 자연스러운 번역 블록으로 묶는 다대다 연결 제공 |
| 시를 문장부호만으로 잘못 분리 | 표점안에 논리적 시행·대구·연 구조 저장, 시 전체 입력, 물리적 이미지 행과 분리 |
| 구조화 AI 응답 정렬 실패 | coverage·ID·순서·연속성 검증 후 원시 결과 보존, `needs_review` 편집 UI 제공 |
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
9. punctuation version 기반 translation anchor generator 구현
10. document translation/version/head와 block-anchor 연결 구현
11. 전체 원문·표점·번역 editor vertical slice 완성
12. Codex/Claude CLI probe와 fixture 기반 parser spike
13. 요청 문자 수·UTF-8 byte 표시와 provider context 오류 정규화 구현
14. context item 선택 → request manifest·request artifact 생성 구현
15. Chat thread·assistant message·native session·event log 구현
16. 번역 task의 `submit_translation` → 문서 번역안·block validator → 사용자 수정 → 확정 vertical slice

첫 vertical slice의 성공 기준:

```text
로컬 프로젝트 생성
 → 원문 입력
 → 표점·논리 구조안 편집
 → 번역 앵커 생성
 → 전체 요청의 문자 수·UTF-8 byte 표시
 → Codex 또는 Claude에 표점된 문서 전체를 한 번 전송
 → assistant message와 request/response artifact 저장
 → `submit_translation` JSON Schema 검증
 → 앵커 ID 기반 번역 블록 검증·저장
 → 같은 초기 응답의 Reflection 표시
 → 전체 번역문 사용자 수정
 → 확정
 → 앱 재실행 후 전체 이력 복구
```

이 흐름이 안정적으로 동작하기 전에는 OCR, 전사, 다판본 교감, CRDT, vector search를 추가하지 않는다.
