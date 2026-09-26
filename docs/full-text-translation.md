# 전문 번역 후 원문 연결 (2026-09-05)

현재 기본 흐름은 **원문 저장 → 전문 번역 → 번역 문장별 원문 연결 → 사용자 검토·확정**이다. 표점은 선택 작업이며 번역 전 분절은 필수가 아니다. 원문에 줄바꿈이 없어도 번역은 의미 흐름에 따라 문단을 구성한다. 실제 번역 품질과 대응 정확도는 별도 표본 평가가 필요하며 구조 검증 통과로 보증하지 않는다.

## 두 요청과 내장 스킬

`packages/db-sqlite/skills/translate-document/SKILL.md`와 `align-translation/SKILL.md`를 앱에 기본 포함한다. 번들 모듈의 내용이 파일과 같은지 테스트한다. 스킬 이름만 보내거나 사용자 CLI에 설치된 스킬에 의존하지 않는다. 각 실행에 실제 지침을 넣고 버전·SHA-256과 정확한 요청을 기록한다. 외부 설치나 npx 설치 단계는 없다.

1. 첫 CLI 요청은 저장된 원문 전체(사용 가능한 확정 표점이 있으면 그 전문), 번역 원칙, 상속 문맥·지식을 받는다. 원문 앵커로 번역을 잘라내지 않는다. `tools submit-translation`으로 `{schemaVersion:1,translation:string}`을 제출한다. 앱은 원문/표점 버전과 번역 head의 CAS를 검사하고 문단·줄바꿈을 그대로 보존하여 번역 version을 먼저 저장한다.
2. 두 번째는 새로운 CLI 요청이다. 번역에 사용한 정확한 원문 version, 저장된 번역 전문, 앱이 파생한 한국어 문장 범위를 받는다. 확정 표점을 사용한 번역은 그 버전에 저장된 문장·시행 앵커 `A001`, `A002` 등을 재사용한다. `tools submit-alignment`으로 `{schemaVersion:4,versionId,punctuationVersionId,anchorSetId,links:[{sentenceIds,segmentIds,needsReview}]}`을 제출하면 앱이 번호를 저장된 원문 범위로 해석한다. 한문을 다시 분할하거나 모델에게 위치 계산을 맡기지 않는다. 확정 표점을 사용하지 않은 번역은 기존 exact quote와 출현 순번 방식인 schemaVersion 1을 유지한다.

두 요청은 별도의 제출 권한을 쓴다. 두 번째는 번역문·원문을 변경할 수 없으며 여러 원문 분절과 여러 번역 문장을 하나의 연결 묶음으로 대응시킬 수 있다. 떨어진 분절도 선택할 수 있고 그 사이 본문은 자동 포함하지 않는다. 없는 분절 번호, 누락/중복 문장 ID, 묶음 사이 원문 중복, 바뀐 원문/표점/번역 version 및 앵커 세트, 임의의 번역 수정 필드는 거부한다. 원문 미대응 범위와 불확실한 연결은 확인 필요로 표시한다. 제출 후 `check-alignment`로 저장 결과를 검사하고 필요하면 부분 수정한 뒤, 마지막 검사 revision으로 `finish-alignment`를 호출해야 완료된다.

## 번역 플러그인 (2026-09-26)

첫 요청의 번역 스킬은 프로젝트마다 표준 `SKILL.md` 플러그인으로 바꿀 수 있다. 설정 → 플러그인에서 `SKILL.md` 파일이나 폴더를 가져오면 앱 데이터의 `plugins/<name>/SKILL.md`에 설치된다. 프로젝트에 적용하면 전문이 `core_project_settings.settings_json.translationSkill`에 복사되어 온라인 공동 작업자와 이후 기록에도 같은 지침이 남는다. 설치본을 지우거나 고쳐도 프로젝트 사본은 다시 적용하기 전까지 바뀌지 않는다. 추천 목록은 Supabase `plugin_catalog`의 `published` 행에서 가져오며(로그인 사용자 읽기 전용, 관리는 service role), 설치하면 서버 사본을 같은 라이브러리에 저장한다.

플러그인은 `translate-document` 자리만 대체한다. 제출 규칙(최종 전문만 제출, 정렬 정보 금지)은 앱이 요청 앞부분에 고정하고, `output_contract`와 두 번째 요청의 `align-translation`도 바꿀 수 없다. 실행 기록의 스킬 목록에는 플러그인 이름·버전·SHA-256이 남는다.

## 저장된 분절과 누락 검사 (2026-09-24)

연결 요청을 만들 때 확정 표점의 구조 범위·앵커·인용·해시와 원문 좌표를 확인한다. 분절 사이 및 전문 양끝에 남는 구간은 공백·줄바꿈만 허용한다. 새 연결에는 분절 바깥의 공백을 포함하지 않지만 전문에는 그대로 남는다. 연결 검사도 공백·줄바꿈만 제외하며, 원문에 있던 문장부호가 빠지면 누락으로 보고한다. 표점에서 추가한 문장부호는 표점 분절 범위로 검증하고, 번역 연결은 기존대로 표점 전 원문 좌표로 저장한다.

기존에 저장된 연결과 구조 범위는 바꾸지 않는다. 공백을 포함하던 옛 앵커를 새 연결 요청에 사용할 때만 바깥 공백을 제외한다. 이미 발행된 경계 방식 v2/v3 요청도 처리할 수 있다. 사람이 확인한 연결은 자동 연결이 덮어쓰지 않으며, 분절 일부를 세밀하게 연결해야 하는 경우 기존 수동 범위 수정 기능을 사용한다. DB 스키마와 `links_json`의 원문 범위 저장 형식은 유지한다.

연결 실패·취소·앱 종료 시 저장된 번역은 남는다. 현재 번역만 연결을 다시 요청할 수 있다. 번역문을 수정하면 새 version이 생성되고 연결은 미생성 상태로 돌아간다. `valid`는 번역 품질 인증이 아니다. 연결 상태와 번역 확정은 별도이며, 사용자는 전문을 검토해 확정할 수 있다.

## 저장과 호환

스키마 2의 `002_full_text_translation.sql`은 기존 version ID와 이력을 보존한다. `punctuation_version_id`, `translation_anchor_set_id`를 nullable로 변경하고 `translation_text_layouts`에 version별 문장 범위·연결·상태·요청·응답·오류·스킬 기록을 저장한다. 지원하는 스키마 1 프로젝트를 열면 SQLite 일관 백업을 만든 뒤 transaction으로 적용하고 외래키와 무결성을 검사한다. 이전의 다른 스키마 계열은 계속 거부한다.

기존 `translation-envelope.v2`, `translation_blocks`, `translation_block_anchors`는 과거 번역의 표시·수정·이력 호환용이다. 새 기본 번역은 이 블록 생성을 요구하지 않는다. 내보내기는 전문을 보존하고 JSON에는 새 문장 연결도 포함한다.

번역 문장·편집 묶음의 범위는 앞뒤 공백과 줄바꿈을 제외한 본문만 가리킨다. 구간 사이 공백은 `text_content`에 그대로 남으며 별도 테이블에 저장하지 않는다. 묶음을 편집하면 전문의 해당 코드포인트 범위만 교체하고 길이 차이만큼 뒤 범위를 이동한다. 저장 요청은 묶음별 `from`, `to`, 본문과 원문 연결을 전달한다. 앱은 전문과의 인용 일치, 범위 순서·겹침, 구간 밖 본문 누락을 확인한다. 합치기는 사이 공백을 포함하는 하나의 범위로, 나누기는 앞뒤 공백을 제외한 두 범위로 바꾸며 전문 자체는 유지한다. 과거 버전의 범위는 열 때 편집용으로 정리하고, 새로 저장하는 버전에 본문 범위를 기록한다.

## 화면

- 원문 / 표점(선택) / 번역의 세 작업 탭. 원문 저장 후 바로 AI 번역 가능.
- 원문 확정 후 읽기 전용. 수정 버튼을 눌러야 편집 가능.
- 표점 작업은 원문을 왼쪽, 표점안을 오른쪽에 배치하고 좁은 화면에서 세로 배치.
- 번역 전문을 먼저 표시하고 연결 진행·실패·확인 필요 상태와 연결 재시도 버튼 제공.
- 문장 대조는 저장된 번역 문장과 원문 인용을 표시. 전문 편집은 새 version으로 저장.
- 채팅에는 설정된 모델과 effort를 표시. 모델 변경은 설정에서 수행.
- 사이드바 +는 현재 페이지에서 문서 생성 대화상자를 연다.

## 구절 코멘트와 전문 재번역 (2026-09-07)

**코멘트 달기**를 먼저 눌러 선택 모드를 켜고, 문장별 대조에서 원문 인용 또는 번역문의 일부를 선택하면 입력창이 열린다. 평소의 텍스트 선택은 코멘트 작성을 시작하지 않는다. 선택 모드는 입력창이 열리면 해제되며 버튼 재클릭, Esc, 문서·버전 변경, 대조 보기 이탈로 취소할 수도 있다. 모드 중 번역문은 범위 선택만 가능하고, 종료하면 기존 편집 상태로 돌아간다. 키보드로 번역문 범위를 선택할 때는 Shift를 놓거나 Enter를 눌러 완료한다.

선택 모드에서는 선택한 글자만 반투명 황금색으로 표시한다. 입력창을 작성하는 동안에도 같은 구절의 옅은 배경과 밑줄이 유지된다. 저장된 코멘트는 얇은 밑줄로 표시하며, 패널의 코멘트를 누르면 해당 구절에 황금색 배경이 켜진다. 평소의 복사·읽기용 텍스트 선택은 기본 선택 색상을 유지한다. 번역문을 편집하여 저장된 문장과 달라지면 그 문장의 코멘트 표시는 숨겨 잘못된 위치를 가리키지 않도록 한다.

코멘트에는 자유로운 해석·수정 의견을 적고 문서, 작성 당시 번역 버전, 원문/번역 대상 버전, 정확한 유니코드 코드포인트 범위와 인용을 연결한다. 원문은 표점 전 저장 원문 좌표를 쓰며, 반복 표현·보충 평면 한자·CRLF 줄바꿈에서도 선택 위치를 보존한다. 저장하지 않은 편집이 있거나 원문 기준이 달라진 번역에서는 새 코멘트 작성을 막는다.

오른쪽 **코멘트** 패널에서 의견을 수정하거나 제외하고, 재번역에 포함할 항목을 선택한다. **코멘트로 재번역**은 기존 전송 자료 미리보기에 원문, 현재 번역 전문, 선택한 코멘트를 추가한다. 질문이나 불확실성은 확정된 판단으로 바꾸지 않도록 지시하며, 일부 수정문이 아닌 전체 번역을 제출받는다. 실행 시점의 이전 번역 해시와 코멘트 본문·범위·버전·잠금 값은 요청 manifest/artifact에 고정된다. 실행 이후 코멘트를 수정해도 과거 요청은 달라지지 않는다.

결과는 기존 CAS 검사를 거쳐 새 번역 버전으로 저장하고 원문 연결을 다시 생성한다. **이전 번역과 비교**는 현재 버전과 부모 버전을 기본 선택해 변경 전·후 전문과 차이를 보여주며 다른 버전도 고를 수 있다. AI 의견 반영이나 번역 정확성을 자동 보증하지 않는다.

코멘트는 작성 당시 버전에 남는다. 재번역하거나 번역문을 직접 수정해 저장하면 기존 코멘트는 **이전 버전의 코멘트**에서 볼 수 있고 새 번역에 자동 재사용하지 않는다. 번역문 수정 전 작성한 의견을 새 버전에 적용하려면 현재 구절을 다시 선택해 코멘트를 작성한다.

스키마 4의 `004_review_comments.sql`이 코멘트 저장소와 문서·버전 소유권 검증을 추가한다. 기존 프로젝트 업그레이드 전 SQLite 백업을 만들고, 코멘트 수정은 낙관적 잠금, 제외는 soft archive를 사용한다. 기존 번역과 이력은 보존한다.

코멘트 작성 중 **이 구절의 각주 용례 찾기**에서 한국고전종합DB의 각주를 검색하고 설명과 출처를 참고자료로 추가할 수 있다. 독립 검색과 인용 복사도 지원한다. 자세한 사용법과 검색 범위는 [각주 용례 검색](footnote-search.md)을 참고한다.

## Local group storage (schema 12)

Local editor saves now send `textBaseVersionId` and `textBaseRevision` with the edited group ranges. The ranges are input validation/rendering projections, not persisted group coordinates. New human drafts and completed local AI workflows use this structure. The first edit save of an older translation imports its existing layout after verifying that all body characters are covered and that reconstructing the content preserves every codepoint, including whitespace and CRLF. Old versions remain readable without migration of their historical layouts.

- `translation_groups`: stable group identity, review metadata, and per-group revision.
- `translation_group_source_links`: the source version and exact source ranges owned by that group.
- `translation_content_parts`: ordered text pieces belonging to groups, and independently editable whitespace pieces. Paragraphs and group boundaries need not coincide. Order keys are exact rational strings; inserting a piece does not renumber later pieces.
- `translation_content_revisions`: immutable revisions of changed groups/pieces only.
- `translation_content_snapshots`: each saved version references those immutable revisions. Unchanged revisions are reused.

For compatibility with history, comments, search, AI prompts and exports, each save still creates an immutable whole-text checkpoint in `document_translation_versions`. New normalized versions store empty `sentences_json`/`links_json`; consumers derive the layout from the referenced content revisions. The current group/part rows of other groups are not rewritten, and no shifted whole-translation offsets are saved for them. Existing comments remain attached to their immutable translation version and therefore need no coordinate updates when another group changes.

Saves compare the edited entities with the editor's base snapshot and merge them into the current snapshot in a SQLite/Drizzle transaction. Independent edits from an older editor can be accepted together; competing edits to the same group or whitespace piece are rejected. Source-version changes and active alignment runs reject a save. Split and merge retain exact document content while updating only affected group ownership/source links. Human corrections and AI re-alignment also update normalized correspondence. While an alignment run is active, its target/layout projection is retained as transient request state.

In the book view, clicking a blank line (or the empty space after a paragraph's last word) selects that paragraph break; Backspace or Delete asks for confirmation and then joins the two paragraphs with a single space. Removing a break preserves group identities and source links, and is undoable. Editing one group's text or its internal line breaks preserves all other group identities. Replacing text across multiple group bodies requires an explicit group merge first. Unchanged CRLF sequences survive textarea newline normalization.

This is a local storage change. The existing online row protocol continues to receive a derived legacy layout; normalized local tables are excluded from that protocol. Online leases/locking are not implemented by this change.

### AI 연결 해제 보호

여러 번역 문장이 하나의 저장된 원문 분절에 대응하면 하나의 연결 묶음으로 저장한다. AI가 이미 연결된 문장의 원문 범위를 비우려면 제출 최상위 `unlinkReasons`에 `{ sentenceId, reason }`을 넣고 해당 문장을 `needsReview: true`로 표시해야 한다. 사유는 실제 의미 불일치나 번역의 추가 내용을 설명하는 10~1000자 문자열이다. 사유가 없거나 형식이 틀리면 제출 전체를 거부해 기존 연결과 검사 revision을 유지한다. 초기 미연결에는 사유가 필요하지 않으며, 사람이 확인한 연결의 보호 규칙은 그대로 적용한다. 제출 원문에 사유를 보존하며 DB 테이블을 추가하지 않는다. 사유의 의미적 타당성까지 자동으로 판정하지는 않는다.

구조 검사 통과 후 의미 대응도 검토했다면 AI는 추가 재분할 없이 완료한다. 실행 화면은 앱이 실제로 반환한 연결 도구의 거부 사유를 표시하며, 같은 종류의 요청이 뒤이어 성공했으면 이전 거부에 ‘이후 요청 성공’을 표시한다. 이는 이후 요청의 성공을 뜻하며 번역 전체의 의미 정확성을 보증하지 않는다.
