# 번역 후 경계 앵커 연결

현재 새 요청에는 아래 v3 묶음 규칙을 적용한다. 앞부분은 기존 v2 형식의 설명이다.

번역 생성은 기존 전문 번역 요청을 유지한다. 번역 버전에 기록된 확정 표점 원문이 있을 때만 연결 요청을 `translation-alignment.v2`로 만든다. 표점이 없거나 미확정이면 기존 인용/occurrence 기반 v1을 사용한다.

앵커는 원문 시작, 표점 `。` 뒤, 마지막 끝에 배치하며 실제 저장 원문을 수정하지 않는다. Unicode 코드포인트와 기존 표점-원문 매핑으로 원래 원문의 위치를 계산한다. `a1–a3`은 `a1–a2`와 `a2–a3`의 합이다. 대응은 일대일로 제한하지 않고, 여러 범위와 여러 번역 문장의 원문 범위 공유를 허용한다.

```json
{"schemaVersion":2,"versionId":"translation-version","punctuationVersionId":"punctuation-version","links":[{"sentenceId":"T1","ranges":[{"start":"a1","end":"a3"}],"needsReview":false}]}
```

앵커 범위를 기존 `from/to/quote` 연결 데이터로 변환해 저장한다. 번역문 및 사용자가 고친 연결을 덮어쓰지 않는다. 원문·번역·표점 버전이 달라졌거나 ID/범위가 잘못된 응답은 적용하지 않는다. 모든 번역 문장의 항목을 요구하며, 빈 대응이나 원문 미포함 영역은 재검토 상태로 남긴다. 구조 검증은 의미상 대응 정확도의 보증이 아니다.

기존 연결 데이터를 일괄 변환하지 않는다. 새 번역의 후속 연결 또는 연결 재실행부터 적용한다. 기존 v1 요청의 응답도 계속 처리한다. 표점 구간 내부의 정밀 연결은 현재 v2 ID만으로 표현할 수 없으므로 재검토 표시/기존 수동 연결로 보완한다.

검증: DB 연결 테스트 29개(합침/분할/다대다, 틀린 경계, 표점 변경, Unicode·공백, 마지막 。 생략, 미확정 표점 제외), DB/desktop 타입 검사 및 desktop 빌드. 실제 공급자의 품질·속도 비교는 아직 수행하지 않았다.


## 서로 겹치지 않는 연결 묶음 (v3)

새 표점 연결 요청은 `translation-alignment.v3` / `schemaVersion: 3`을 사용한다. 각 links 항목은 `sentenceIds: ["T1", "T2"]`, `ranges: [{"start":"a1","end":"a2"}]`, `needsReview`를 가진 하나의 묶음이다. 번역 ID는 전체에서 정확히 한 번만 등장해야 하며 원문 범위는 묶음 안/밖 모두 중복되면 안 된다. 경계만 맞닿는 a1–a2와 a2–a3는 허용한다. 비연속 대응은 여러 범위로 표현한다.

기존 행 단위 표시/편집과 호환하기 위해 저장된 links는 groupId로 같은 묶음을 식별한다. 같은 groupId의 행들은 하나의 원문 대응을 나타내며 서로 다른 연결로 취급하지 않는다. UI는 묶음을 표시하고 수동 연결 시 전체 번역 묶음을 보여준다. 수동 대응 수정은 전체 묶음에 적용되고 다른 묶음의 원문을 침범할 수 없다. 번역 수정으로 묶음 일부가 바뀌면 남은 행에도 기존 전체 대응을 유지하지 않고 그 묶음을 재연결 대상으로 만든다.

분절 수가 다르다는 이유만으로 needsReview를 붙이지 않는다. 불확실하거나 근거 없는 대응만 재검토 표시한다. 예전 v1/v2 저장 결과는 자동 재해석하지 않고, 새 표점 연결 실행부터 v3를 적용한다. 기존 수동 수정은 자동 실행 결과로 덮어쓰지 않으며 충돌하는 결과는 거절한다.

## Stable editing groups (2026-09-19)

The comparison and book views now edit one contiguous alignment group as one
textarea. Existing group IDs collapse their member sentences for display without
changing any translation characters, including inter-sentence whitespace. Legacy
links without group IDs remain separate.

Saving `textGroups` persists each stable ID as a layout sentence, with its complete
text and source spans. The canonical translation must exactly equal the joined
group texts. Source quotes and exclusive range ownership are validated inside the
version transaction. Changed groups retain their source spans and require review;
unchanged groups retain their review status. Saving/reopening identical text keeps
the stored layout rather than re-segmenting it.

The book view shows group boundaries while editing and highlights corresponding
source or confirmed punctuation text. Enter only changes text inside a group.
Explicit split uses the translation caret and a confirmed `。` boundary; no internal
source boundary means no split. Explicit merge joins the next group and unions its
source ranges without changing translation text. Both operations require review.
Find/replace carries individual edit ranges so normal replacements also retain group
identity; a replacement crossing a group boundary requires an explicit merge first.
