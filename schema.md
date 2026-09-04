# 문해 CAT 논리 스키마

상태: 구현 전 기준안
관련 문서: `plan.md`
범위: Phase 1 로컬 SQLite·프로젝트 문맥·LLM 실행. Cloud는 18절 Phase 2에서 별도 정의

## 1. 스키마 원칙

문해의 기준 데이터는 관계형 SQL에 저장한다.

- 로컬 프로젝트: SQLite
- 이미지·PDF: 로컬 파일 시스템
- JSON: 유연한 설정·provider metadata·output schema에만 사용
- 검색·embedding: 삭제 후 재생성 가능한 파생 데이터
- OAuth token·API key: 프로젝트 DB 저장 금지

현재 스키마에는 다음을 포함하지 않는다.

- OCR
- 전사 workflow
- 원본 이미지·필사본의 물리적 행 단위 전사 데이터(논리적 시행은 표점 구조로 지원)
- 문자 token
- 외자 편집
- 이미지 영역과 문자 연결
- 다판본 자동 교감
- Phase 1 데모의 주석·댓글·작업 배정·협업 검토

## 2. 사용자 용어와 내부 용어

| 사용자 화면 | 내부 코드·DB |
|---|---|
| 원문안·표점안·번역안 | draft version |
| 확정 | 승인된 `confirmed` version |
| 변경 이력 | version history |
| AI 제안 | AI output artifact |
| 공유 | Phase 2에서 별도로 정의 |

사용자 화면에는 `리비전`과 `공개본`이라는 표현을 사용하지 않는다. 이 문서에서 approval은 사용자의 `확정`, sharing은 사용자의 `공유`를 뜻한다. `확정`은 내용 승인 상태이고 `공유`는 별도의 배포 행동이다. 확정된 내용을 공유하지 않을 수 있고, 공유를 중단해도 확정 상태는 유지된다.

## 3. 전체 관계

```text
Project
 └─ Document Node
     ├─ Source Asset / Page (선택적 참고 이미지·PDF)
     └─ Source Text → Source Text Version
         └─ Punctuation Version
             ├─ Punctuation Structure Span
             └─ Translation Anchor Set → Translation Anchor
                 └─ Document Translation → Document Translation Version
                     └─ Translation Block ↔ Translation Anchor
                         └─ Term Decision / Reflection / Quality Check

Translation Policy + Glossary + Person + Place + Uncertainty
Confirmed Translation + User Context Item
 └─ Exact Request Artifact
     └─ Assistant Message → 구조화된 Block 제안 → 사용자 편집
         └─ Document Translation Version

```

## 4. 공통 규칙

### 4.1 ID

- 모든 domain ID는 애플리케이션이 생성하는 UUIDv7이다.
- SQLite에서는 `TEXT`로 저장한다.
- 사람이 정하는 title·slug·순번을 ID로 사용하지 않는다.

### 4.2 시간

- 모든 시각은 UTC다.
- SQLite는 RFC 3339 `TEXT` 또는 epoch millisecond `INTEGER` 중 하나를 프로젝트 전체에서 통일한다.
- 역사 일자·연호처럼 불확실한 시점은 `timestamptz`로 강제 변환하지 않고 원문 표기와 구조화된 보조정보를 별도 저장한다.

### 4.3 Version

- version row는 append-only다.
- 내용을 바꿀 때 기존 row를 `UPDATE`하지 않고 새 version을 추가한다.
- `parent_version_id`로 변경 계보를 남긴다.
- 동시 편집은 각 version이 같은 부모를 가리키는 branch로 모두 보존한다. 초기 범위에서는 multi-parent merge version을 만들지 않고 사용자가 비교·선택하거나 한 branch를 부모로 새 통합 draft를 만든다.
- current head만 `lock_version`을 이용해 원자적으로 갱신한다.
- 확정된 version은 수정하지 않는다.
- 확정된 내용을 고칠 때는 새 draft version을 만든다.

### 4.4 상태

공통 version state:

```text
draft | confirmed | rejected | superseded
```

UI mapping:

```text
작업안 | 확정 | 제외됨 | 변경 이력
```

### 4.5 Hash

- 불변 text와 artifact에 SHA-256을 저장한다.
- 원문 raw text와 검색용 정규화 text의 hash를 구분한다.
- JSON hash가 필요하면 정해진 canonicalization을 적용한 뒤 계산한다.

### 4.6 프로젝트 경계

- 모든 프로젝트 row는 직접 `project_id`를 가지며 부모 row와 같은 프로젝트인지 검증한다.

### 4.7 삭제

- version row는 hard delete하지 않는다.
- 안정적 identity에는 `tombstoned_at` 또는 `archived_at`을 사용한다.
- 개인정보 삭제가 필요한 artifact는 payload를 제거하고 최소 tombstone만 남길 수 있다.

### 4.8 Text anchor

문자 token을 만들지 않으므로 번역의 기준 anchor는 특정 표점본의 정확한 code-point 범위다.

- `translation_anchor_set_id`
- 그 집합이 참조하는 정확한 `source_text_version_id`와 필수 `punctuation_version_id`
- 표점본 Unicode code-point 기준 `punctuation_codepoint_from`, `punctuation_codepoint_to`
- 당시 표점 문자열 `punctuated_quote`, `punctuated_quote_hash`
- 동일 문자를 무표점 원문에서 가리키는 `source_codepoint_from`, `source_codepoint_to`, `source_quote`, `source_quote_hash`
- 앞뒤 문맥 hash
- `boundary_kind`
- 운문이면 대응하는 논리적 `punctuation_structure_span_id`

JavaScript UTF-16 offset, 현재 head, 임의로 복사한 부분 문자열 중 하나만으로 번역 근거를 식별하지 않는다. source character가 하나라도 바뀌면 새 source text version이고, 구두점·문단·운문 구조만 바뀌면 새 punctuation version이다.

## 5. 로컬 프로젝트 파일 스키마

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
    # 재생성 가능한 검색 index만 허용
```

백업·전달용 `.munhaepkg`는 위 디렉터리를 checkpoint 후 압축한 package다.

### 5.1 `manifest.json`

```json
{
  "$schema": "https://munhae.org/schemas/project-manifest-v1.json",
  "format": "io.munhae.project",
  "formatVersion": 1,
  "projectId": "019...",
  "title": "홍길동전 번역",
  "storageMode": "local",
  "database": "project.sqlite3",
  "assetRoot": "assets",
  "createdAt": "2026-09-01T12:00:00Z",
  "minimumAppVersion": "0.1.0"
}
```

금지 항목:

- 절대 경로
- OAuth token
- API key
- provider cookie
- Codex·Claude session secret
- 개인 UI 설정

## 6. 앱 자체 로컬 DB

Electron user data 디렉터리의 `app.sqlite3`는 프로젝트 DB와 분리한다.

### 6.1 테이블

- `app_preferences(id, key, value_json, updated_at)`
- `app_recent_projects(project_id, display_name, package_path, last_opened_at, missing_at)`
- `app_window_state(window_key, state_json, updated_at)`
- `app_devices(id, public_device_id, display_name, created_at, last_seen_at)`
- `app_ai_connections(id, provider_kind, account_label, credential_reference, status, last_checked_at)`
- `app_runtime_sessions(id, provider_kind, project_id, thread_id, provider_session_ref, updated_at)`
- `app_pending_diagnostics(id, safe_payload_json, consent_state, created_at)`

`credential_reference`는 OS Keychain 또는 CLI-owned credential을 가리키는 opaque reference다. token 자체는 저장하지 않는다.

## 7. META / CORE

### 7.1 Migration

- `meta_schema_migrations(version, name, checksum, applied_at)`
- `meta_project_state(project_id, schema_version, format_version, last_compacted_at, integrity_hash)`

### 7.2 Actor

- `core_actors(id, actor_kind, display_name, subject_uri, metadata_json, created_at)`

`actor_kind`:

```text
human | llm | importer | system
```

프로젝트를 내보내도 누가 만들고 수정했는지 provenance가 보존된다.

### 7.3 Project

- `core_projects(id, title, slug, description, default_target_locale, status, created_by_actor_id, created_at, updated_at, archived_at)`
- `core_project_settings(project_id, active_document_node_id, autosave_interval_ms, ai_data_policy_json, settings_json, lock_version)`

### 7.4 Translation policy

- `core_translation_policies(id, project_id, name, created_at)`
- `core_translation_policy_versions(id, policy_id, parent_version_id, version_no, source_language, target_locale, audience, workflow_mode, reflection_required, hanja_policy, supplement_policy, uncertainty_policy, style_guide_md, rules_json, state, content_hash, created_by_actor_id, created_at)`
- `core_translation_policy_heads(policy_id, current_version_id, confirmed_version_id, lock_version, updated_at)`

기본 정책:

- `two_step + Reflection`
- 문학·수사 텍스트는 `three_step + Reflection`
- 중요 용어는 `한국어(漢字)`
- 원문 밖 보충은 별도 표시
- textual uncertainty와 interpretive uncertainty 분리

## 8. DOCUMENT NODE

- `document_nodes(id, project_id, parent_node_id, node_role, is_master, structural_kind, title, original_title, ordinal, genre, author_person_id, language, period_text, date_text, description_md, source_reference, created_at, updated_at, archived_at)`

`parent_node_id`는 프로젝트 마스터에서만 null이며, 다른 node의 부모는 같은 프로젝트의 `container`여야 한다. 순환 관계는 허용하지 않는다.

`structural_kind`:

```text
collection | work | volume | chapter | section | item
```

`node_role`은 파일 시스템의 폴더와 파일에 해당하는 책임을 명시한다.

- `container`: 하위 node와 metadata·context를 가질 수 있지만 원문·표점·앵커·번역을 가질 수 없다.
- `source_unit`: 정확히 하나의 활성 source text를 갖는 실제 번역 작업 단위이며 하위 node를 가질 수 없다.

각 프로젝트에는 `is_master=1`인 활성 최상위 `container`가 정확히 하나 있다. 모든 다른 node는 이 마스터의 자손이며 마스터는 이동·삭제·archive하거나 `source_unit`으로 바꿀 수 없다. 프로젝트 공통 문맥은 별도 project scope가 아니라 이 마스터 node에 연결한 문맥이다.

`structural_kind`는 학술적 문서 구조이고 `node_role`은 저장·편집 책임이므로 서로 독립적이다. 예를 들어 `chapter`는 여러 원문 단위를 묶는 `container`일 수도 있고, 장 전체가 한 작업 단위인 `source_unit`일 수도 있다. document node에 묶인 context는 두 역할 모두에 허용하며, 하위 `source_unit`은 조상 `container`의 context를 요청 조립 시 상속한다.

`genre`는 구조와 분리하며 `poetry | letter | memorial | preface | epitaph | biography | official_document | prose | other`를 초기값으로 사용한다.

문맥을 만들 때 `author_person_id`, `language`, `period_text`, `source_reference`는 현재 node부터 부모 방향으로 올라가며 처음 발견한 값을 사용한다. `title`, `original_title`, `structural_kind`, `ordinal`, `genre`, `date_text`는 현재 node의 값만 사용한다. `description_md`는 상위 설명과 현재 설명을 구분해 함께 렌더링할 수 있지만 하나의 값처럼 덮어쓰거나 합쳐 저장하지 않는다.

발신자·수신자 컬럼과 별도 문서-인물 연결 table은 Phase 1 데모에 두지 않는다. 필요한 장르 특화 정보는 우선 `description_md` 또는 `context_items`에 기록한다.

## 9. SOURCE ASSET / SOURCE TEXT

### 9.2 Source asset

- `src_assets(id, project_id, asset_kind, original_filename, mime_type, byte_size, sha256, width, height, page_count, source_uri, acquired_at, created_by_actor_id)`
- `src_asset_locations(id, project_id, asset_id, relative_path, state, verified_at)`
- `src_asset_pages(id, project_id, asset_id, page_no, label, width, height, rotation, derivative_asset_id)`
- `src_node_assets(project_id, document_node_id, asset_id, role, page_from, page_to, locator_text, ordinal)`

원본 바이너리는 SQL BLOB에 넣지 않고 `.munhae` 패키지 내부 상대경로만 저장한다.

### 9.3 Source text

- `src_texts(id, project_id, document_node_id, name, status, created_at, tombstoned_at)`
- `src_text_versions(id, project_id, source_text_id, parent_version_id, version_no, content_text, origin_kind, source_asset_id, page_from, page_to, locator_text, change_summary, state, content_hash, created_by_actor_id, created_at)`
- `src_text_heads(project_id, source_text_id, current_version_id, confirmed_version_id, lock_version, updated_at)`

`origin_kind`:

```text
manual | paste | import | derived_part
```

`node_role='source_unit'`인 document node만 실제 번역 작업 단위이며 정확히 하나의 활성 source text를 가져야 한다. `node_role='container'`에는 source text를 연결하지 않는다. 기본 번역 범위는 해당 source text 전체이고, 모델 token 한도를 넘는 경우에만 사용자가 확인한 장·편 node 경계로 나눈다. 임의의 작은 block이나 anchor 단위로 원문을 미리 나누지 않는다. `src_text_versions.content_text`에는 그 범위의 전체 무표점 원문을 저장한다. 원문 문자 하나라도 추가·삭제·교체되면 기존 row를 수정하지 않고 새 source text version을 만든다.

## 10. PUNCTUATION

- `punctuation_sets(id, project_id, source_text_id, name, policy_version_id, status, created_at)`
- `punctuation_versions(id, project_id, punctuation_set_id, source_text_version_id, parent_version_id, version_no, punctuated_text, structure_json, change_summary, state, content_hash, created_by_actor_id, created_at)`
- `punctuation_structure_spans(id, project_id, punctuation_version_id, span_kind, parent_span_id, ordinal, codepoint_from, codepoint_to, quote, quote_hash, origin_kind, confidence, label, created_by_actor_id, created_at)`
- `punctuation_heads(project_id, punctuation_set_id, current_version_id, confirmed_version_id, lock_version, updated_at)`

규칙:

- 표점은 원문 version을 덮어쓰지 않는다.
- 구두점 하나마다 row를 만들지 않는다.
- 전체 표점 문자열을 version으로 저장한다.
- `structure_json`은 span으로 표현하지 않는 표점기 설정에만 사용한다.
- 제목·운문 행·대구·연은 `punctuation_structure_spans`로 구조화한다.
- punctuation version의 `content_hash`는 `punctuated_text`, canonical `structure_json`, ID를 제외하고 정렬한 structure-span manifest를 함께 hash한다. text나 논리 구조가 바뀌면 새 version과 새 hash가 필요하다.
- 표점 확정 후에도 수정은 가능하지만 새 표점안이 된다.
- `codepoint_from/to`와 `quote/hash`는 정확한 `punctuated_text`를 기준으로 검증한다.

`span_kind`의 최소 집합:

```text
title | heading | paragraph | sentence | clause | quotation
verse_line | couplet | stanza
```

`origin_kind`:

```text
manual | rule | ai | import
```

운문의 `verse_line`은 텍스트의 논리적 시구다. 원본 이미지의 물리적 행, PDF 줄, OCR line을 뜻하지 않는다. `couplet`과 `stanza`는 `parent_span_id`와 `ordinal`로 논리적 시구를 묶는다. 이 범위에서는 이미지/OCR 행과 문자 범위를 연결하지 않는다.

## 11. TRANSLATION ANCHOR

- `translation_anchor_sets(id, project_id, document_node_id, source_text_version_id, punctuation_version_id, strategy_key, strategy_version, coverage_policy, anchor_set_hash, created_by_actor_id, created_at)`
- `translation_anchors(id, project_id, anchor_set_id, anchor_key, ordinal, boundary_kind, punctuation_codepoint_from, punctuation_codepoint_to, punctuated_quote, punctuated_quote_hash, source_codepoint_from, source_codepoint_to, source_quote, source_quote_hash, context_before_hash, context_after_hash, display_label, required, created_at)`
- `translation_anchor_structure_spans(project_id, anchor_id, punctuation_structure_span_id, ordinal)`

`punctuation_version_id`는 선택값이 아니다. 모든 anchor set은 정확한 source text version과 그 source에서 파생된 정확한 punctuation version을 함께 참조한다. `anchor_set_hash`는 다음 canonical manifest의 hash다.

```json
{
  "sourceTextVersionId": "...",
  "sourceHash": "...",
  "punctuationVersionId": "...",
  "punctuationHash": "...",
  "strategyKey": "sentence-clause-v1",
  "strategyVersion": 1,
  "coveragePolicy": "full_text",
  "anchors": [
    {
      "anchorKey": "A001",
      "ordinal": 1,
      "boundaryKind": "sentence",
      "punctuationFrom": 0,
      "punctuationTo": 18,
      "punctuatedQuoteHash": "...",
      "sourceFrom": 0,
      "sourceTo": 16,
      "sourceQuoteHash": "...",
      "structureLinks": [
        {
          "spanKind": "sentence",
          "from": 0,
          "to": 18,
          "quoteHash": "...",
          "parentPath": ["paragraph:1"]
        }
      ]
    }
  ]
}
```

`boundary_kind` 예시:

```text
document | title | heading | paragraph | sentence | clause
verse_line | manual
```

규칙:

- anchor 범위는 Unicode code-point 기준 반열림 구간 `[from, to)`다.
- `punctuated_quote`는 `punctuation_codepoint_from/to`가 가리키는 `punctuated_text`와 정확히 같아야 한다.
- `source_quote`는 `source_codepoint_from/to`가 가리키는 `src_text_versions.content_text`와 정확히 같아야 한다.
- anchor ID는 LLM이 만들지 않고 실행 전에 애플리케이션이 확정한다.
- LLM contract의 `sourceAnchorIds`는 DB UUID가 아니라 해당 set 안에서 결정론적인 `anchor_key`(`A001` 등)를 사용한다.
- `full_text` 집합은 required anchor의 순서·비중첩·연속성과 `punctuated_text` 전체 coverage를 검증한다.
- 운문의 기본 anchor 경계는 `verse_line`이다. `couplet`과 `stanza`는 중첩 anchor로 추가하지 않고 `translation_anchor_structure_spans`를 통한 상위 구조로 참조한다. 물리적 이미지/OCR 행 ID를 참조하지 않는다.
- structure bridge가 참조하는 span은 anchor set과 같은 punctuation version에 속해야 하며 anchor의 punctuation 범위를 포함해야 한다. `boundary_kind = verse_line`인 anchor는 범위가 정확히 같은 `verse_line` span 하나를 필수로 참조하고, 그 밖에 해당 시행을 포함하는 `couplet`·`stanza` 상위 span을 추가로 참조할 수 있다.
- `punctuation_structure_spans`의 parent와 child는 같은 punctuation version에 속하고 child 범위가 parent 범위 안에 있어야 하며 순환을 허용하지 않는다.
- 같은 punctuation version에 다른 전략의 anchor set이 공존할 수 있다.

anchor set은 사용자가 편집하는 version/head aggregate가 아니라, 정확한 punctuation version과 전략에서 생성되는 불변 파생 집합이다. `anchor_key`는 정렬된 범위에서 `A001`처럼 결정론적으로 만든다. `anchor_set_hash`에는 새 anchor/span UUID가 아니라 key·범위·quote hash와 각 anchor의 정렬된 structure-span signature(`span_kind`, 범위, `quote_hash`, parent kind/ordinal path)를 포함한다. 유니크 제약으로 동일 입력의 재생성은 기존 set을 재사용한다.

## 12. TRANSLATION

- `document_translations(id, project_id, document_node_id, source_text_id, target_locale, stage, created_at, tombstoned_at)`
- `document_translation_versions(id, project_id, document_translation_id, parent_version_id, source_text_version_id, punctuation_version_id, translation_anchor_set_id, translation_policy_version_id, text_content, origin_kind, workflow_execution_id, generated_by_message_id, generation_candidate_key, validation_state, needs_review, state, content_hash, created_by_actor_id, created_at)`
- `document_translation_heads(project_id, document_translation_id, current_version_id, confirmed_version_id, lock_version, updated_at)`
- `translation_blocks(id, project_id, document_translation_version_id, block_key, ordinal, block_kind, target_codepoint_from, target_codepoint_to, target_hash, validation_state)`
- `translation_block_anchors(project_id, translation_block_id, translation_anchor_id, ordinal, relation_kind, confidence)`
- `document_translation_validations(id, project_id, document_translation_version_id, source_message_id, validator_version, result, needs_review, summary_json, validated_at)`
- `document_translation_validation_findings(id, project_id, validation_id, finding_kind, severity, block_key, anchor_id, details_json)`
- `reflection_reports(id, project_id, source_message_id, reflection_kind, verdict, summary_md, content_hash, created_at)`
- `reflection_report_translation_versions(project_id, report_id, document_translation_version_id, ordinal)`
- `reflection_findings(id, project_id, report_id, document_translation_version_id, finding_kind, severity, source_codepoint_from, source_codepoint_to, source_quote, target_codepoint_from, target_codepoint_to, explanation_md, resolution_state, resolved_by_document_translation_version_id)`
- `reflection_finding_anchors(project_id, finding_id, translation_anchor_id, ordinal)`
- `translation_quality_checks(id, project_id, document_translation_version_id, check_kind, result, severity, details_json, checked_by_actor_id, checked_at)`
- `translation_staleness(id, project_id, document_translation_version_id, cause_kind, old_dependency_id, new_dependency_id, detected_at, resolved_by_document_translation_version_id)`

`stage` 예시:

```text
literal | shin | dal | a | reader | final
```

### 12.1 저장 단위

- 번역 전문은 `document_translation_versions.text_content` 한 곳에 저장한다.
- `translation_blocks`는 target text를 복사하지 않고 전문 안의 정확한 code-point 범위와 `target_hash`만 저장한다.
- block과 source의 관계는 `translation_block_anchors` many-to-many로 표현한다. 여러 anchor가 한 문단으로 합쳐지거나 한 anchor가 여러 번역 block에 걸치는 경우를 모두 보존한다.
- `translation_anchor_set_id`는 version의 필수 의존성이다.
- LLM output은 항상 draft AI 제안이다. 자동으로 confirmed head가 되지 않는다.

### 12.2 번역 실행 contract

token 한도에 맞는 경우 하나의 run에는 다음을 한 번씩만 보낸다.

1. 정확한 punctuation version의 전체 `punctuated_text`
2. anchor ID와 경계 manifest
3. 번역 policy
4. 관련 glossary·person·place·uncertainty
5. 구조화된 output schema

원문을 block마다 반복하거나 LLM이 응답에서 source text를 되풀이하게 하지 않는다. recipe가 요구하는 번역안이 하나면 `candidates`에 하나만 넣고, 信·達·雅처럼 여러 완성 번역안을 요구하면 같은 한 번의 응답에 모두 담는다. 기본 output envelope:

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

문해 앱은 candidate별 block 순서와 정해진 separator 정책으로 `translation`을 결합하여 `document_translation_versions.text_content`를 만들고, 각 block의 target range/hash를 계산한다. 모든 candidate는 해당 `stage`의 `document_translations`에 독립 draft version으로 적용되며 모두 응답을 생성한 assistant `chat_message`를 `generated_by_message_id`로 참조한다. 사용자가 하나를 후속 편집·확정의 기반으로 채택해도 나머지 draft는 이력과 provenance로 보존한다. envelope의 Reflection은 report 하나로 저장하고 `reflection_report_translation_versions`로 모든 candidate version과 연결한다. candidate 특정 finding은 해당 `document_translation_version_id`를 가리킨다. `submit_translation`에 제출된 canonical envelope는 assistant message의 `response_artifact_id`로, 정규화한 스트림·tool-call event는 `events_artifact_id`로 보존한다.

`ApplyDocumentTranslationEnvelope`는 fatal envelope validation을 통과한 뒤 하나의 SQLite transaction에서 모든 candidate version·block·유효한 anchor 연결을 삽입하고, stage별 current head를 CAS로 갱신하고, Reflection report·version link·finding을 남긴다. recoverable structural finding이 있는 candidate는 `needs_review`로 적용하고 confirmed head는 변경하지 않는다. 하나라도 실패하면 전체를 rollback하고 assistant message의 raw response artifact는 그대로 보존한다.

같은 assistant message에서 같은 `generation_candidate_key`를 다시 적용하면 기존 translation version을 반환한다. 이를 위해 `(generated_by_message_id, generation_candidate_key)`를 유일하게 하고, message의 immutable `response_artifact_id`와 response hash가 달라진 상태에서는 재적용하지 않는다. 한 envelope에는 Reflection report가 최대 하나이고, candidate-specific finding의 `document_translation_version_id`는 그 report의 `reflection_report_translation_versions`에 포함되어야 한다. 전역 finding만 이 값을 null로 둔다.

유효한 Reflection `sourceAnchorIds`는 저장 시 `reflection_finding_anchors`로 정규화한다. 존재하지 않는 원시 key는 FK로 만들지 않고 response artifact와 document translation validation finding에 보존한다.

### 12.3 필수 validation

적용 전에 다음을 모두 검사한다.

- `anchorSetId` 일치
- `schemaVersion`이 현재 output contract의 지원 version과 일치함
- `candidateKey`가 envelope 안에서 유일함
- 알 수 없는 anchor ID가 없음
- candidate의 `stage`가 recipe output contract에 정의되어 있고 stage당 candidate가 하나뿐임
- envelope의 `(candidateKey, stage)` 집합이 recipe `output_contract_json`의 필수 집합과 정확히 일치하여 누락·추가·잘못된 pairing이 없음
- candidate별 모든 required anchor가 coverage됨
- `blockKey`가 candidate 안에서 유일하고 block ordinal이 중복되지 않음
- block마다 source anchor와 비어 있지 않은 `translation`이 있음
- anchor ordinal이 block 순서에서 역행하지 않음
- 기본 정책에서는 anchor 중복·누락·비연속 참조가 없음
- 계산된 target block 범위가 비어 있지 않고 겹치지 않으며 전문을 순서대로 연속 coverage함
- 저장된 punctuated/source quote·hash와 target 범위에서 계산한 `target_hash`가 각각의 실제 문자열과 일치
- policy/recipe가 Reflection을 요구하면 envelope에 정확히 하나의 Reflection이 있고, finding의 `candidateKey`는 null(전역 finding) 또는 기존 candidate key이며 `sourceAnchorIds`는 해당 anchor set에 존재함

초기 AI 응답은 각 required anchor를 candidate별로 정확히 한 번 참조하는 것을 기본으로 한다. 사용자가 번역 block을 나누어 하나의 anchor를 여러 block에 연결할 때는 인접한 block에만 `relation_kind = partial`을 명시하여 many-to-many 예외를 표현한다.

validation은 두 단계다.

- **fatal envelope validation**: JSON parse, `schemaVersion`, `anchorSetId`, recipe의 exact candidate identity 집합, candidate/block key 고유성을 검사한다. 실패하면 version을 적용하지 않고 raw AI output artifact를 `invalid_unapplied`로 보존하며 head를 갱신하지 않는다.
- **recoverable structural validation**: 번역 문자열은 복구할 수 있지만 anchor coverage·순서·연속성·Reflection finding 연결이 깨진 경우다. fatal 단계를 통과했다면 envelope의 모든 candidate와 Reflection을 하나의 SQLite transaction으로 저장하되, 영향받은 candidate를 `validation_state = needs_review`, `needs_review = true`로 표시하고 해당 stage의 current head로 올린다. confirmed head는 변경하지 않고, 유효하지 않은 FK 연결은 삽입하지 않으며 원시 key와 finding을 보존한다.

`needs_review` version은 사용자가 연결을 고쳐 새 `valid` draft를 만들기 전에는 확정할 수 없다.

`document_translation_versions.validation_state`:

```text
valid | needs_review
```

assistant message의 `output_validation_state`는 위 두 값과, 번역 version으로 적용할 수 없는 `invalid_unapplied`, 일반 채팅용 `not_applicable`을 사용한다.

`finding_kind` 최소 집합:

```text
schema_version | anchor_set_mismatch | unknown_anchor | missing_coverage
duplicate_candidate_key | duplicate_stage | missing_candidate
unexpected_candidate | candidate_stage_pair
duplicate_block_key | duplicate_block_ordinal
reflection_missing | reflection_count | reflection_candidate
anchor_order | noncontiguous_anchors | empty_block
target_range | punctuation_hash | source_hash | target_hash
```

### 12.4 상위 text 변경

표점 변경 절차:

1. 새 punctuation version 생성
2. 그 version을 위한 새 translation anchor set 생성
3. 새 anchor의 range·quote·hash·coverage 검증
4. 기존 document translation version과 block/anchor 연결은 그대로 보존
5. 이전 punctuation/anchor set 기반 번역에 `punctuation_changed` 또는 `anchor_set_superseded` staleness 기록
6. 새 번역·재연결·사용자 확인을 거쳐 새 draft 생성

원문 문자가 바뀌면 새 source text version과 그에 종속된 새 punctuation version/anchor set이 필요하다. 원문 문자를 기존 source version 안에서 고친 뒤 offset만 보정해서는 안 된다.

`document_translation_versions.needs_review`는 생성 당시 구조 validation 결과처럼 version 자체에 속하는 불변 사실이다. 나중의 punctuation 변경으로 생기는 재확인 필요성은 version row를 수정하지 않고 `translation_staleness`에서 파생한다.

### 12.5 Token preflight와 명시적 문서 나누기

- provider 호출 전에 exact rendered source+context를 해당 tokenizer로 계산한다.
- model context limit, 모든 candidate와 Reflection의 예상 output tokens, reserved output tokens, tool/schema overhead, safety margin을 포함한다.
- 맞지 않으면 source를 조용히 자르거나 낮은 우선순위 원문을 누락하지 않는다.
- 문서 전체가 맞지 않는 경우 사용자가 확인한 장·편 `document_node` 경계로 별도 source text/translation run을 만든다.
- 자동 제안한 문서 나누기도 실행 전에 명시적 `translation_split_plan`으로 저장하고 사용자가 확인한다.

- `translation_split_plans(id, project_id, document_node_id, source_text_version_id, punctuation_version_id, source_content_hash, punctuation_content_hash, strategy, state, created_by_actor_id, created_at)`
- `translation_split_plan_parts(id, project_id, split_plan_id, document_node_id, ordinal, source_codepoint_from, source_codepoint_to, source_quote_hash, punctuation_codepoint_from, punctuation_codepoint_to, punctuated_quote_hash, estimated_tokens)`
- `translation_split_plan_results(id, project_id, split_plan_id, split_plan_part_id, resulting_source_text_id, resulting_source_text_version_id, resulting_punctuation_set_id, resulting_punctuation_version_id, resulting_anchor_set_id, state, created_at)`
- `ai_token_preflights(id, project_id, task_kind, source_text_version_id, punctuation_version_id, anchor_set_id, provider_kind, model_id, tokenizer_id, context_limit_tokens, estimated_input_tokens, estimated_output_tokens, schema_overhead_tokens, safety_margin_tokens, reserved_output_tokens, outcome, split_plan_id, created_at)`

`ConfirmTranslationSplitPlan`은 확인 시점의 source/punctuation hash가 제안 시점과 같은지 재검증한 뒤, 한 transaction에서 part별 `src_texts`·`origin_kind = derived_part`인 최초 `src_text_versions`·`punctuation_sets`·`punctuation_versions`·구조 span·anchor set을 만들고 result row를 저장한다. 원본 source text는 변경하지 않는다. 같은 plan의 재호출은 기존 result를 반환하는 idempotent command이며, 후속 `ai_token_preflights.source_text_version_id`와 assistant `chat_messages.token_preflight_id`로 각 part의 번역 실행을 추적한다.

split part의 source/punctuation 범위는 각각 Unicode code-point 반열림 구간이며 모두 비어 있지 않아야 한다. ordinal 순으로 겹침과 빈틈 없이 각 원문 version과 표점 version의 전문을 정확히 한 번 coverage하고, 각 quote hash가 실제 substring과 일치해야 한다. 나누기 경계는 기존 structure span이나 required anchor의 내부를 가로지를 수 없다. result의 `split_plan_part_id`는 같은 `split_plan_id`의 part여야 하며 resulting source text/version, punctuation set/version, anchor set은 모두 같은 project 안에서 `source → punctuation → anchor` 의존성 사슬을 정확히 이뤄야 한다.

confirmed plan의 모든 part는 정확히 하나의 result를 가져야 한다. child `src_text_versions.content_text`와 `punctuation_versions.punctuated_text`는 각각 part가 가리킨 parent substring과 정확히 같아야 한다. structure span·anchor·anchor-span bridge는 part 시작 offset을 뺀 child 좌표와 새 ID로 재기준화하고 quote/hash 및 parent-child 관계를 다시 검증한다. DB는 `translation_split_plan_results(split_plan_part_id, split_plan_id) → translation_split_plan_parts(id, split_plan_id)` 복합 FK를 둔다.

`outcome`:

```text
fits | requires_explicit_split | rejected
```

### 12.6 별도 분절 모델 없음

별도의 segmentation/segment identity, version, lineage, head는 두지 않는다. `translation_anchors`가 source 경계를, `translation_blocks`가 사용자가 합치고 나누고 순서를 조정하는 번역 편집 단위를 맡으며, 두 계층의 many-to-many 관계가 alignment다. 세부 대조·참고 번역 조회·export의 콘텐츠 단위는 `translation_blocks`이며, `translation_anchors`는 원문 위치와 coverage 근거로만 사용한다.

## 13. KNOWLEDGE

### 13.1 Glossary

- `glossary_entries(id, project_id, source_term, target_locale, target_term, reading, note_md, usage_status, content_hash, lock_version, created_by_actor_id, updated_by_actor_id, created_at, updated_at, archived_at)`

한 row는 하나의 `원문 용어 → 번역 용어` 대응이다. 같은 `source_term`에 후보가 여러 개면 row를 여러 개 만들고 `usage_status`로 `preferred | allowed | forbidden`을 구분한다. 프로젝트가 용어집 범위이므로 별도 glossary container를 두지 않는다.

용어 entry는 별도 version/head aggregate가 아닌 CAS 가능한 현재 설정값이다. 수정 시 `lock_version`과 `updated_at`을 갱신한다. AI 실행 당시 사용한 entry의 ID와 `content_hash`는 assistant `chat_messages.request_manifest_json`에, 실제 렌더링 문자열은 request artifact에 고정한다.

표기 변형·다의어 의미·출현 위치를 별도 table로 분리하지 않는다. 현재 `src_text_versions.content_text`에서 `source_term`을 exact match하고, 검색 범위를 포함하는 현재 anchor set의 source 좌표를 이용해 표점문 highlight와 LLM context를 만든다. 위치는 실행 시 계산하며 기준 데이터로 저장하지 않는다.

### 13.2 Person / Place

- `persons(id, project_id, preferred_name, hanja_name, reading, aliases_json, description_md, date_text, content_hash, lock_version, created_by_actor_id, updated_by_actor_id, created_at, updated_at, archived_at)`
- `places(id, project_id, preferred_name, hanja_name, reading, aliases_json, place_kind, location_note_md, description_md, content_hash, lock_version, created_by_actor_id, updated_by_actor_id, created_at, updated_at, archived_at)`

인물과 지명은 별도 table로 저장하고 관직·책 제목·기관·연호는 `glossary_entries.term_kind`로 구분한다. 이름과 별칭은 현재 source text에서 실행 시 exact match하며 출현 좌표 table은 만들지 않는다.

### 13.3 Uncertainty

- `uncertainties(id, project_id, category, severity, blocking, state, created_at)`
- `uncertainty_versions(id, project_id, uncertainty_id, parent_version_id, version_no, statement_md, rationale_md, confidence_label, content_hash, created_by_actor_id, created_at)`
- `uncertainty_options(id, project_id, uncertainty_version_id, label, interpretation_md, ordinal)`
- `uncertainty_anchors(id, project_id, uncertainty_version_id, target_kind, target_version_id, codepoint_from, codepoint_to, quote, quote_hash)`

`category`:

```text
textual | interpretive | identification
```

## 14. 주석·댓글·협업 검토 — 데모 제외

Phase 1 데모에는 관련 table을 만들지 않는다. Phase 2 협업 workflow가 구체화될 때 별도로 설계한다.

## 15. WORKFLOW

- `workflow_recipes(id, project_id, name, purpose, state)`
- `workflow_recipe_versions(id, project_id, recipe_id, parent_version_id, version_no, definition_json, content_hash, created_by_actor_id, created_at)`
- `workflow_recipe_steps(id, project_id, recipe_version_id, step_key, step_kind, ordinal, input_contract_json, output_contract_json, confirmation_required)`
- `workflow_executions(id, project_id, recipe_version_id, scope_kind, scope_id, state, started_by_actor_id, started_at, completed_at)`
- `workflow_step_runs(id, project_id, execution_id, recipe_step_id, attempt_no, state, assistant_message_id, started_at, completed_at)`

이 workflow는 로컬 AI recipe 실행을 위한 최소 구조다. 배정·이슈·검토 라운드·검토 결정·체크리스트·협업 event는 포함하지 않는다.

## 16. CONTEXT 저장 스키마

프로젝트 context는 하나의 `context.json`이나 긴 채팅 기록이 아니다. 다음 세 층으로 처리한다.

```text
1. 원본 지식
   정책·원문·용어·인물·지명·불확실성·확정 번역

2. 문맥 선택 규칙
   Phase 1 코드에 고정한 순서·exact match·token budget·overflow 정책

3. assistant message의 request manifest와 exact request artifact
   LLM에게 실제 전달한 출처·순서·내용·hash
```

### 16.1 원본 지식은 원래 domain table에 저장

| 문맥 종류 | 기준 table |
|---|---|
| 프로젝트 번역 원칙 | `core_translation_policy_versions` |
| 문서 metadata·구조 | `document_nodes` |
| 현재 원문 | `src_text_versions`, `punctuation_versions` |
| 번역 경계 | `translation_anchor_sets`, `translation_anchors` |
| 용어 | `glossary_entries` |
| 인물 | `persons` |
| 지명 | `places` |
| 불확실성 | `uncertainty_versions` |
| 확정 번역 | `document_translation_versions`, `translation_blocks` |

용어·인물·지명·확정 번역을 `context_items`에 다시 복사하지 않는다. `context_items`는 다른 domain table로 표현되지 않는 사용자의 문맥 카드에만 사용한다.

### 16.2 사용자 문맥 카드

#### `context_items`

다른 domain table에 속하지 않는 명시적 프로젝트 지식이다.

```text
context_items(
  id,
  project_id,
  item_kind,
  scope_kind,
  scope_id,
  title,
  content_md,
  priority,
  enabled,
  content_hash,
  created_at,
  updated_at,
  archived_at
)
```

`item_kind` 예시:

```text
project_brief | document_summary | period_background
style_instruction | custom_instruction | external_evidence
```

별도 version/head는 두지 않는다. 사용자는 카드를 직접 수정하고 `enabled`로 기본 포함 여부를 정한다. 과거 AI 실행에 사용한 정확한 내용은 해당 assistant `chat_message`의 request manifest와 exact request artifact가 보존한다. 채팅 전체를 자동 문맥으로 사용하지 않는다.

`scope_kind`는 `document_node`만 허용하며 `scope_id`는 같은 프로젝트의 활성 `document_nodes.id`를 가리킨다. 요청 조립기는 현재 node에서 시작해 프로젝트 마스터까지 조상을 올라가며 관련 카드만 선택한다. 정렬은 `(scope_distance ASC, priority DESC, updated_at ASC)`이다. `scope_distance=0`은 현재 node, `1`은 부모 node다. 프로젝트 공통 카드는 마스터 node 문맥으로 저장되므로 조상 경로의 마지막에 자연스럽게 포함된다. 다른 문서 가지의 카드는 포함하지 않는다.

### 16.3 고정 문맥 조립 규칙

Phase 1에는 profile·override·retrieval 기록 table을 두지 않고 다음 순서를 코드에 고정한다.

1. 정확한 punctuation version의 전체 표점 원문
2. 해당 translation anchor manifest
3. confirmed translation policy
4. 전체 원문에서 이름·별칭이 exact match된 glossary entry·person·place
5. 관련 uncertainty와 `enabled`인 context item. context item은 현재 node부터 가까운 조상을 거쳐 프로젝트 마스터 순으로 붙인다.
6. 기존 confirmed translation에서 직접 조회한 참고 번역
7. 번역 task라면 `translation-envelope.v1` schema, 일반 chat이라면 없음

사용자는 현재 원문을 보고 있는 문서 상세 화면의 AI 번역 대화상자에서 보조 항목을 이번 실행에 포함하거나 제외할 수 있고 그 최종 선택은 assistant `chat_messages.request_manifest_json`에 기록한다. 전체 표점 원문은 항상 required input이며 token 한도를 넘으면 `requires_explicit_split` preflight로 전환한다.

### 16.4 assistant message의 실행 문맥 기록

별도 Context Snapshot이나 AI run aggregate를 만들지 않는다. AI가 생성하는 assistant `chat_message` 하나가 provider CLI adapter 호출 하나의 영구 원장이며 다음 두 값으로 실행 당시 문맥을 보존한다.

- `request_manifest_json`: 포함한 domain row의 종류·ID·version·hash·순서·선택 이유
- `request_artifact_id`: 앱이 provider CLI adapter에 전달한 최종 request payload

`request_manifest_json` 예시:

```json
{
  "schemaVersion": 1,
  "sources": [
    {"ordinal": 1, "kind": "translation_policy", "id": "...", "versionId": "...", "hash": "...", "reason": "required"},
    {"ordinal": 2, "kind": "punctuated_source", "id": "...", "versionId": "...", "hash": "...", "reason": "required"},
    {"ordinal": 3, "kind": "anchor_manifest", "id": "...", "hash": "...", "reason": "required"},
    {"ordinal": 4, "kind": "glossary", "id": "...", "hash": "...", "reason": "exact_match"},
    {"ordinal": 5, "kind": "context_item", "id": "...", "hash": "...", "reason": "enabled"}
  ]
}
```

manifest는 canonical JSON으로 만든 뒤 `request_manifest_hash`를 계산한다. system/user message와 전체 표점 원문·anchor manifest·output schema를 합쳐 앱이 adapter에 전달한 최종 요청은 `provenance_artifacts`에 `artifact_kind = exact_llm_request`로 저장한다. CLI나 provider가 내부적으로 추가한 비공개 prompt·metadata까지 재현한다고 주장하지 않는다. 같은 canonical hash의 artifact는 재사용한다.

### 16.5 요청 생성 절차

1. task, document translation, source text version, punctuation version 결정
2. 정확한 translation anchor set과 전체 `punctuated_text` 로드
3. `glossary_entries.source_term`과 `persons`·`places` 이름·별칭 exact match
4. 관련 uncertainty와 `enabled` context item 로드
5. 기존 confirmed translation에서 필요한 참고 번역 직접 조회
6. 문서 상세의 AI 번역 대화상자에서 사용자가 보조 항목 포함·제외
7. source ID·version·hash·순서·선택 이유로 request manifest 생성
8. 전체 exact request를 render하고 token preflight 실행
9. source가 맞지 않으면 request artifact와 assistant message를 만들지 않고 명시적 document/chapter split 요구
10. 실행 예정 assistant message와 exact request artifact를 짧은 DB transaction으로 저장
11. transaction 종료 후 로컬 Codex·Claude CLI 호출
12. 최종 응답/envelope artifact, 구조 validation 결과, usage·error 저장
13. 적용 가능한 output은 document translation draft와 block/anchor 관계 생성

LLM network/process 호출을 DB transaction 안에서 기다리지 않는다.

### 16.6 Context 변경

```text
Glossary entry G3 수정
 → `lock_version` CAS로 row와 `content_hash` 갱신
 → 다음 assistant message는 request manifest에 새 hash 기록
 → 과거 assistant message의 manifest와 exact request artifact는 그대로 유지
```

### 16.7 로컬 저장 위치

- 로컬에서는 context source, assistant message, manifest와 artifact를 `project.sqlite3`에 저장한다.
- provider 전송 전에 문서 상세의 AI 번역 대화상자로 exact request 범위를 보여준다.

### 16.8 Request 예시

```text
Assistant Message M103
├─ request_manifest_json
│  ├─ translation policy V4
│  ├─ source text V7 / punctuation P3
│  ├─ anchor set TAS9
│  ├─ glossary: 玄德
│  ├─ person: 劉備
│  └─ context item: 시대 배경
└─ request_artifact_id → provider CLI adapter에 전달한 최종 요청
```

## 17. AI / PROVENANCE / CHAT

### 17.1 AI runtime configuration

OpenDesign 방식처럼 Phase 1의 agent adapter·기본 prompt·output contract는 애플리케이션 코드와 버전 관리되는 파일에 둔다. 선택한 agent와 agent별 model·reasoning·service tier preference는 프로젝트 package 밖의 Electron app data `app-config.json`에 저장한다.

```json
{
  "agentId": "codex",
  "agentModels": {
    "codex": {"model": "default", "reasoning": "medium", "serviceTier": null},
    "claude": {"model": "default", "reasoning": null, "serviceTier": null}
  }
}
```

설치된 CLI의 version·지원 model·capability는 실행 전에 probe한다. 탐지 결과와 preference를 version table로 누적하지 않고, 실제로 실행된 값만 assistant message에 기록한다. Phase 1에는 `ai_profiles`, `ai_profile_versions`, `ai_prompt_templates`, `ai_prompt_versions`, `ai_model_configs` table을 만들지 않는다. 사용자 편집 prompt preset·팀 공유 AI profile·prompt 실험은 요구가 생기면 Phase 2에서 설계한다.

### 17.2 Chat 기반 AI 실행

- `chat_threads(id, project_id, title, scope_kind, scope_id, created_by_actor_id, created_at)`
- `chat_messages(id, project_id, thread_id, parent_message_id, role, actor_id, state, agent_id, requested_model, resolved_model, reasoning_level, service_tier, runtime_version, task_kind, output_contract, prompt_contract_version, token_preflight_id, request_manifest_json, request_manifest_hash, request_artifact_id, response_artifact_id, events_artifact_id, output_validation_state, usage_json, error_json, started_at, completed_at, created_at)`
- `chat_message_parts(id, project_id, message_id, ordinal, part_kind, text_content, structured_json, artifact_id)`
- `chat_agent_sessions(project_id, thread_id, agent_id, native_session_id, model, cwd_hash, last_message_id, stable_prompt_hash, state, updated_at)`

사용자 message는 실행 필드가 null이다. AI 호출 하나는 assistant message 하나이며 그 message ID를 실행 중 취소·스트리밍·재접속의 run ID로도 사용한다. `requested_model`은 preference나 요청에서 선택한 값이고 `resolved_model`은 CLI/provider가 실제 사용했다고 확인된 값이다. `runtime_version`에는 실행한 Claude/Codex CLI version을 기록한다. 일반 채팅은 `task_kind = chat`, `output_contract = null`, `output_validation_state = not_applicable`이다. 번역은 `task_kind = translation`, `output_contract = translation-envelope.v1`이며 `submit_translation` 도구 인자를 같은 schema로 검증한다.

실시간 상세 이벤트와 tool call은 `runs/<assistant-message-id>/events.jsonl`에 append하고 완료 시 `events_artifact_id`로 연결한다. `response_artifact_id`에는 일반 chat의 최종 응답 또는 번역 task에서 `submit_translation`에 제출된 canonical envelope를 저장한다. 사용량과 오류는 조회 요구가 생기기 전까지 `usage_json`, `error_json`에 둔다. 별도 `ai_runs`, output, usage, error, feedback, tool-call, application table은 만들지 않는다.

`chat_agent_sessions`는 `(thread_id, agent_id)`마다 하나의 native session을 가진다. Claude session ID와 Codex thread ID는 이 table에 저장하고, model·working-directory hash·`last_message_id`가 맞을 때만 resume한다. 같은 thread의 AI 실행은 하나씩 직렬화한다.

원격 LLM output이 항상 동일하게 재생성된다고 가정하지 않는다. 대신 request/response artifact와 실제 생성된 translation version의 연결을 보존한다.

### 17.3 Artifact lineage

- `provenance_artifacts(id, project_id, artifact_kind, media_type, payload_text, payload_json, storage_asset_id, raw_sha256, canonical_sha256, byte_size, schema_name, schema_version, classification, retention_class, redaction_state, created_at)`
- `provenance_lineage_edges(id, project_id, from_artifact_id, to_artifact_id, relation_kind, message_id, ordinal, created_at)`
- `user_edits(id, project_id, workflow_execution_id, document_translation_id, base_document_translation_version_id, result_document_translation_version_id, base_translation_block_id, target_codepoint_from, target_codepoint_to, base_artifact_id, result_artifact_id, patch_artifact_id, patch_format, edit_kind, reason, actor_id, client_version, created_at)`

`provenance_artifacts`에는 `(project_id, artifact_kind, canonical_sha256)` unique constraint를 둔다. 동일한 exact request bytes는 내용 hash로 dedupe하여 여러 assistant message가 같은 artifact를 안전하게 참조할 수 있다.

AI 실행 입력은 assistant message의 `request_manifest_json`과 `request_artifact_id`로 재현한다. 별도 run/input table은 두지 않으며 exact request에서도 전체 source는 한 section에 한 번만 렌더링한다.

`relation_kind`:

```text
used | generated | derived_from | revised_from | critiques
supports | selected_from | supersedes | accepted_as
```

## 18. Phase 2 — Cloud·협업·공개 서비스

이 절의 table과 PostgreSQL 구현은 Phase 1 SQLite 데모에 포함하지 않는다. 로컬 프로젝트와 cloud 프로젝트는 독립 identity이며 명시적 import/export만 제공하고 자동 양방향 동기화하지 않는다.

### 18.1 Cloud IAM / Realtime

- `users(id, auth_subject, display_name, state, created_at)`
- `workspaces(id, name, owner_user_id, created_at)`
- `workspace_projects(workspace_id, project_id, state, linked_at)`
- `workspace_members(workspace_id, user_id, role, state, joined_at)`
- `project_members(project_id, user_id, role, stage_permissions_json, state, joined_at)`
- `actor_bindings(actor_id, user_id, workspace_id, created_at)`
- `invitations(id, workspace_id, project_id, email_lookup_hmac, role, token_hash, expires_at, accepted_at)`
- `devices(id, user_id, device_public_id, display_name, last_seen_at, revoked_at)`
- `change_events(seq, project_id, aggregate_kind, aggregate_id, version_id, operation, actor_id, occurred_at)`
- `transactional_outbox(id, project_id, event_seq, topic, payload_json, state, attempts, available_at, created_at)`
- `idempotency_keys(project_id, user_id, idempotency_key, request_hash, response_ref, expires_at)`
- `notifications(id, user_id, project_id, kind, payload_json, read_at, created_at)`
- `audit_events(id, workspace_id, project_id, actor_id, action, target_kind, target_id, safe_metadata_json, occurred_at)`

presence·typing·soft lock은 메모리 또는 TTL 저장소에 두고 기준 원장으로 취급하지 않는다.

#### Mutation transaction

```text
BEGIN
  INSERT immutable version
  UPDATE head WHERE lock_version = expected
  INSERT change_event
  INSERT transactional_outbox
COMMIT
```

WebSocket은 `change_events.seq`를 알리는 전달 채널이다. 재접속 시 HTTP로 누락 event를 조회한다.

### 18.2 Release / Community

- `release_candidates(id, project_id, label, state, created_by_actor_id, created_at)`
- `release_candidate_items(candidate_id, project_id, item_kind, item_id, version_id, content_hash, ordinal)`
- `releases(id, project_id, version_label, manifest_hash, license_code, attribution_text, source_rights_state, released_by_actor_id, released_at)`
- `release_items(release_id, project_id, item_kind, item_id, version_id, content_hash, ordinal)`
- `publications(id, project_id, release_id, public_slug, visibility, state, shared_at, withdrawn_at)`
- `catalog_entries(id, project_id, publication_id, title, summary, cover_asset_id, metadata_json)`
- `attributions(id, project_id, release_id, actor_id, contribution_role, display_text, ordinal)`
- `errata(id, project_id, publication_id, target_item_id, description_md, state, superseding_release_id, reported_at)`
- `forks(id, project_id, source_release_id, destination_project_id, forked_by_actor_id, forked_at)`
- `community_proposals(id, project_id, source_release_id, destination_project_id, proposer_actor_id, title, description_md, state, created_at)`
- `community_proposal_items(proposal_id, project_id, target_kind, target_id, base_version_id, proposed_version_id, change_summary_md)`
- `export_artifacts(id, project_id, release_id, format, profile_version, storage_asset_id, sha256, byte_size, created_at)`

공유는 `is_public=true`가 아니다. confirmed version ID와 hash의 불변 manifest를 만든다.

### 18.3 SQLite → PostgreSQL 타입 대응

| 논리 타입 | Phase 1 SQLite | Phase 2 PostgreSQL |
|---|---|---|
| UUIDv7 | `TEXT` | `uuid` |
| UTC instant | RFC 3339 `TEXT` 또는 epoch ms `INTEGER` | `timestamptz` |
| boolean | `INTEGER CHECK (x IN (0,1))` | `boolean` |
| state | `TEXT CHECK (...)` | `text CHECK (...)` |
| JSON | `TEXT CHECK(json_valid(x))` | `jsonb` |
| SHA-256 | lowercase hex `TEXT` | hex `text` 또는 `bytea` |
| order key | bytewise `TEXT` | deterministic `text` |

SQLite와 PostgreSQL의 migration 파일은 분리한다. 교환 형식은 canonical UTF-8 JSON으로 고정하고 Phase 1 domain command에 PostgreSQL contract test를 추가한다.

### 18.4 Cloud 전용 제약과 인덱스

- `change_events(project_id, seq)`
- `project_members(project_id, user_id, state)`
- 공유 release에는 confirmed version만 포함하며 확정과 공유는 별개 행동이다.
- 로컬 context item은 사용자가 명시적으로 선택하지 않는 한 공유하지 않는다.
- WebSocket event는 영구 저장이 아니며 `change_events`를 기준으로 누락 변경을 복구한다.

## 19. Phase 1 OPS / SEARCH

### 19.1 Import·export

- `import_jobs(id, project_id, source_kind, source_uri, importer_version, state, started_at, completed_at)`
- `import_items(id, project_id, import_job_id, legacy_system, legacy_id, legacy_locator, target_kind, target_id, state, warning_json, error_json)`
- `external_mappings(id, project_id, system, external_kind, external_id, target_kind, target_id)`
- `export_jobs(id, project_id, format, state, started_at, completed_at)`
- `export_items(id, project_id, export_job_id, target_kind, target_id, version_id, content_hash)`
- `background_jobs(id, project_id, job_kind, payload_json, state, attempts, available_at, lease_until, created_at)`
- `derived_artifacts(id, project_id, source_kind, source_id, source_hash, artifact_kind, asset_id, generator_version, created_at)`

### 19.2 Search

- `search_documents(id, project_id, source_kind, source_id, source_version_id, title, body, language, content_hash, indexed_at)`
- `search_terms(id, project_id, normalized_term, source_kind, source_id, source_version_id, position_json)`
검색 table은 기준 데이터가 아니며 재생성 가능해야 한다. SQLite core table은 runtime 지원을 확인한 뒤 `STRICT` 사용을 권장한다.

## 20. 필수 인덱스

- 모든 FK child column
- unique `document_nodes(project_id, parent_node_id, ordinal) WHERE parent_node_id IS NOT NULL`
- unique `document_nodes(project_id, ordinal) WHERE parent_node_id IS NULL`
- unique `document_nodes(project_id) WHERE is_master = 1 AND archived_at IS NULL`
- `document_nodes(project_id, author_person_id) WHERE author_person_id IS NOT NULL`
- unique `src_node_assets(document_node_id, asset_id, ordinal)`
- unique `punctuation_structure_spans(punctuation_version_id, parent_span_id, span_kind, ordinal) WHERE parent_span_id IS NOT NULL`
- unique `punctuation_structure_spans(punctuation_version_id, span_kind, ordinal) WHERE parent_span_id IS NULL`
- unique `translation_anchor_structure_spans(anchor_id, ordinal)`
- unique `translation_anchor_structure_spans(anchor_id, punctuation_structure_span_id)`
- unique `translation_anchors(anchor_set_id, ordinal)`
- unique `translation_anchors(anchor_set_id, anchor_key)`
- `translation_anchors(anchor_set_id, punctuation_codepoint_from, punctuation_codepoint_to)`
- `translation_anchors(anchor_set_id, source_codepoint_from, source_codepoint_to)`
- unique `translation_anchor_sets(punctuation_version_id, strategy_key, strategy_version, coverage_policy)`
- unique `document_translations(source_text_id, target_locale, stage)`
- unique `document_translation_heads(document_translation_id)`
- `document_translation_versions(document_translation_id, created_at desc)`
- unique `document_translation_versions(generated_by_message_id, generation_candidate_key) WHERE generated_by_message_id IS NOT NULL`
- unique `translation_blocks(document_translation_version_id, ordinal)`
- unique `translation_blocks(document_translation_version_id, block_key)`
- unique `translation_block_anchors(translation_block_id, ordinal)`
- unique `translation_block_anchors(translation_block_id, translation_anchor_id)`
- unique `reflection_report_translation_versions(report_id, ordinal)`
- unique `reflection_report_translation_versions(report_id, document_translation_version_id)`
- unique `reflection_reports(source_message_id) WHERE source_message_id IS NOT NULL`
- unique `reflection_finding_anchors(finding_id, ordinal)`
- unique `reflection_finding_anchors(finding_id, translation_anchor_id)`
- unique `translation_split_plan_parts(split_plan_id, ordinal)`
- unique `translation_split_plan_parts(id, split_plan_id)`
- unique `translation_split_plan_results(split_plan_part_id)`
- `chat_messages(thread_id, created_at)`
- unique `chat_agent_sessions(thread_id, agent_id)`
- unique `glossary_entries(project_id, source_term, target_locale, target_term) WHERE archived_at IS NULL`
- unique `glossary_entries(project_id, source_term, target_locale) WHERE usage_status = 'preferred' AND archived_at IS NULL`
- `glossary_entries(project_id, source_term, usage_status) WHERE archived_at IS NULL`
- `context_items(project_id, enabled, priority) WHERE archived_at IS NULL`
- unique `provenance_artifacts(project_id, artifact_kind, canonical_sha256)`
- active row partial index: `WHERE archived_at IS NULL`

JSON은 실제 query path가 확인된 경우에만 expression/GIN index를 추가한다.

## 21. 필수 불변조건

1. source character 변경은 항상 새 `source_text_version`이며 기존 version을 수정하지 않는다.
2. punctuation version은 정확히 하나의 source text version을 참조하고 원문을 덮어쓰지 않는다.
3. translation anchor set은 정확한 source text version과 필수 punctuation version, strategy/hash를 가지며, punctuation version의 `source_text_version_id`와 anchor set의 값이 같아야 한다.
4. anchor의 필수 punctuation code-point 범위·quote·hash는 해당 punctuation text와 일치해야 하며, source 범위·quote·hash는 해당 source text version과 일치해야 한다.
5. 운문 anchor는 논리적 `punctuation_structure_span`을 참조하며 물리적 이미지/OCR line을 참조하지 않는다.
6. document translation version은 정확한 source text·punctuation·anchor set·policy version을 참조하고, anchor set의 source/punctuation dependency와 그 version의 dependency가 같아야 한다.
7. 번역 전문은 `document_translation_versions.text_content`에 한 번 저장한다. block은 target range/hash만 저장한다.
8. block과 source anchor는 many-to-many이다. 초기 AI output에서는 unknown ID, 누락 coverage, 순서 역행, 비연속 범위, 빈 block, 중복 anchor를 허용하지 않고, 사용자가 나눈 인접 block에만 명시적 `partial` 연결을 허용한다.
9. validation 실패 output을 삭제하지 않고 raw artifact와 finding을 남기며 적용 가능한 초안은 `needs_review`로 저장한다.
10. punctuation 변경은 새 anchor set을 만들며 기존 번역을 삭제하지 않고 stale/needs-review로 표시한다.
11. 별도 segmentation row는 없다. 편집 단위의 합치기·나누기·정렬은 새 document translation version의 block/range/anchor 관계로 보존한다.
12. confirmed version의 text는 수정할 수 없고, 확정 후 편집은 새 draft version이다.
13. AI output과 `needs_review` version은 자동 확정되지 않는다.
14. 참고 번역은 별도 memory table 없이 confirmed document translation/block에서 직접 조회한다.
15. 번역 run은 token-fit이면 전체 표점 원문을 한 번만 전달하고 output에서 원문 재출력을 요구하지 않는다.
16. token preflight 없이 provider를 호출하지 않으며 source를 silent truncation하지 않는다. 초과 시 명시적 document/chapter split이 필요하다.
17. 문서 나누기 plan 확정은 source/punctuation hash를 재검증하고 part별 child source·punctuation·anchor 결과를 원자적·멱등적으로 생성하며 원본을 변경하지 않는다.
18. AI assistant message의 request manifest는 포함한 문맥의 순서·ID·version·hash를 남기고 request artifact는 앱이 provider CLI adapter에 전달한 최종 payload를 보존한다. 번역 task만 `translation-envelope.v1`을 강제하며 일반 chat은 자유 텍스트다.
19. 긴 chat history는 자동 context가 아니다. 같은 thread의 AI 실행은 하나씩 직렬화하고, native session은 `(thread_id, agent_id)`의 model·cwd hash·마지막 message가 일치할 때만 resume한다.
20. credential은 project/app DB, request manifest와 request artifact에 저장하지 않는다.
21. LLM 호출 같은 외부 I/O를 DB transaction 안에서 기다리지 않는다.
22. SQLite connection마다 foreign key enforcement를 켠다.
23. SQLite project는 같은 컴퓨터의 single writer로 연다.
24. anchor set 안에서 `anchor_key`와 `ordinal`은 각각 유일하며 LLM은 UUID 대신 이 key를 참조한다.
25. translation envelope의 `candidateKey`와 stage는 중복될 수 없고, 모든 candidate·head·Reflection은 하나의 원자적·멱등 transaction으로 저장한다.
26. anchor set 재사용 key에는 `coverage_policy`가 포함된다. structure bridge는 같은 punctuation version의 span만 연결하고, 논리적 시행 anchor의 범위는 연결된 `verse_line` span과 정확히 같아야 한다.
27. punctuation structure parent-child는 같은 version, 범위 포함, 비순환 조건을 만족하고 같은 kind의 sibling ordinal은 중복될 수 없다. anchor-span bridge의 span과 ordinal도 anchor 안에서 각각 중복될 수 없다.
28. translation version 안에서 block의 `block_key`와 ordinal은 각각 유일하다. block의 target 범위는 순서대로 전문을 coverage하고 hash가 실제 substring과 일치하며, 연결 anchor는 그 translation version의 anchor set에 속해야 한다. block 자체가 번역 편집 단위이며 이를 감싸는 별도 segment/work-unit aggregate를 만들지 않는다.
29. split part는 source와 punctuation 전문을 각각 ordinal 순으로 비중첩·연속·전체 coverage한다. result의 `(split_plan_part_id, split_plan_id)`는 동일 part를 가리키고 resulting source/version·punctuation set/version·anchor set은 같은 project의 정확한 의존성 사슬이어야 한다.
30. `generated_by_message_id`와 `generation_candidate_key`는 함께 null이거나 함께 존재해야 한다. AI 생성 translation version과 Reflection report는 같은 project의 `role = assistant`, `task_kind = translation` message를 출처로 가져야 하며, Reflection report의 version bridge는 그 message의 candidate version 집합과 정확히 같아야 한다.
31. `(generated_by_message_id, generation_candidate_key)` 재사용은 같은 immutable response artifact의 동일 candidate일 때만 기존 version을 반환한다. 내용이 다르면 적용하지 않고 `idempotency_conflict`를 반환한다.
32. Reflection finding의 유효한 source anchor는 join row로 순서 있게 보존한다. candidate-specific finding은 report가 연결한 해당 translation version을 가리키고, finding anchor는 envelope의 anchor set에 속해야 한다.
33. confirmed split plan은 part마다 정확히 하나의 result를 갖는다. child source/punctuation text는 parent part substring과 정확히 같고 모든 structure/anchor 좌표와 bridge는 child 기준으로 재기준화된다.
34. glossary는 `glossary_entries` 단일 table을 기준으로 한다. 같은 원문 용어·target locale에는 활성 `preferred` row가 최대 하나다. 용어 출현 좌표는 저장하지 않고 현재 source text version에서 동적으로 exact match하며, AI 실행에 사용한 entry ID/hash와 렌더링 결과는 request manifest와 request artifact로 보존한다.
35. document translation version은 `parent_version_id` 하나만 가질 수 있다. parent는 같은 `document_translation_id`에 속해야 하고 순환할 수 없으며, multi-parent 계보가 필요한 자동 merge는 초기 범위에 포함하지 않는다.
36. document node의 parent와 `author_person_id`는 같은 project에 속해야 하며 parent 관계는 순환할 수 없다.
37. `src_texts`, `src_node_assets`, translation anchor set과 document translation의 `document_node_id`는 모두 같은 project의 실제 node를 가리켜야 한다.
38. document node는 `container | source_unit` 역할을 명시한다. `container`는 하위 node·context를 가질 수 있지만 source chain을 가질 수 없고, `source_unit`은 source chain을 가질 수 있지만 하위 node를 가질 수 없다.
39. 프로젝트에는 이동·삭제할 수 없는 활성 최상위 마스터 `container`가 정확히 하나 있으며 모든 다른 document node는 그 자손이다. 프로젝트 공통 문맥은 마스터 node의 `document_node` 문맥으로 저장한다.

## 22. Phase 1 구현 순서

1. project package·migration·UUID·version/head 공통 구조
2. document node tree·metadata 상속·source text·punctuation·poetry structure span
3. translation anchor set·anchor validation
4. whole-source context artifact·token preflight·명시적 문서 나누기
5. document translation·block/anchor validation·Reflection·confirmation
6. glossary·person·place·uncertainty
7. context item·request manifest·request artifact
8. Chat 기반 AI 실행·provenance
9. search 고도화

OCR·전사·문자 token·외자·자동 교감은 위 흐름이 안정화되기 전에는 추가하지 않는다.
