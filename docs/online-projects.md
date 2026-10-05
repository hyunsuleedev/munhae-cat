# 온라인 프로젝트

> 2026-09-29 보류: 로컬 작업을 먼저 다듬고 사용자가 모이면 다시 시작한다. `ONLINE_PROJECTS_ENABLED`(`apps/desktop/src/shared/online-projects.ts`)가 꺼져 있어 시작 화면의 온라인 프로젝트 목록·만들기와 초대가 보이지 않고, main도 생성·초대 요청을 `online_projects_paused`로 거부한다. 코드와 Supabase 마이그레이션은 남겨 두지만 **로컬 스키마 변경을 따라가지 않는다**(동기화 프로토콜은 스키마 10에 고정).
>
> 보류 시점의 알려진 한계:
> - v11~v14 로컬 테이블(구절 연구 번역 연결, 번역 묶음 5개, 문서 용어 4개)은 동기화하지 않는다. 원격 변경을 받으면 `hydrateOnlineRows`가 로컬 용어를 지운다.
> - 원격 변경마다 전체 스냅샷을 받아 로컬을 교체한다. 서버의 `get_online_project_changes`는 revision 이후 변경 행을 이미 돌려주지만 클라이언트는 변경 여부만 쓴다.
> - 충돌 단위가 프로젝트 revision이라 동시 편집이 되지 않는다. 행별 이전 값 비교는 서버에 이미 있다.
> - 초기 업로드는 한 번의 커밋(20,000행·16MB 상한)이며 나눠 보내지 않는다.
>
> 다시 시작할 때: 검토 중인 번역 모델 단순화(작업안 + 확정 사본, AI 결과는 버전으로 남기지 않음)가 들어갔다면 그 스키마를 기준으로 판단한다. 동기화할 데이터가 크게 줄면 캐시+증분 동기화(`get_online_project_changes` 연결 → 테이블 레지스트리·프로토콜 버전 → head 단위 충돌)와 "열 때마다 받아 임시 SQLite에서 실행 + 범용 커밋 RPC" 방식을 다시 비교한다. 온라인 사용자가 없다면 스키마 10 기준 마이그레이션을 새 기준으로 교체해도 된다.

온라인 프로젝트의 원본은 Supabase PostgreSQL이다. 문서, 원문 버전, 표점, 번역, 문장 연결, 용어, 자료, 댓글, AI 실행 이력을 각각 관계형 테이블에 저장한다. Supabase Storage에는 개별 첨부 파일만 저장한다. 로컬 프로젝트는 기존 `.munhae` 파일을 그대로 사용하며 자동 업로드하지 않는다.

## 저장 구조

| 저장소 | 내용 |
| --- | --- |
| `online_projects` | 온라인 프로젝트 이름, 설명, 소유자, 생성 요청 ID |
| `online_project_data` | 내부 프로젝트 ID, 스키마 버전, 서버 revision, 갱신 시각 |
| `online_data_document_nodes` 등 `online_data_*` 48개 테이블 | 기존 도메인 모델의 실제 열, 프로젝트별 복합키·외래키·검증 제약 |
| 변경 journal과 mutation receipt | 정확한 재시도, 버전 충돌 검사, 변경 조회 |
| private `online-project-assets` bucket | 첨부 파일, `계정ID/온라인프로젝트ID/SHA256` 경로 |
| 기기별 SQLite 캐시 | 기존 동기 편집·검색·AI 엔진용 재생성 가능한 캐시 |

JSON 문서 전체나 SQLite 파일을 서버 원본으로 보관하지 않는다. 기존 도메인의 JSON 형식 열은 문자열 표현을 유지하여 해시와 버전 비교가 변하지 않게 한다. SQLite의 FTS, 기기별 활성 문서, 파일 검증 시각, 로컬 CLI 세션과 파일 경로는 공유 데이터에서 제외한다. 인증 토큰은 메인 프로세스 계정 저장소에서만 관리한다.

## 읽기와 저장

`OnlineWorkspace` → `OnlinePostgresRemote` → 인증된 PostgreSQL RPC.

- `get_online_project_data`: 현재 revision과 48개 테이블의 일관된 읽기. 부모 프로젝트 행 잠금으로 저장 중간 상태를 읽지 않는다.
- `commit_online_project_data`: 변경한 행만 하나의 트랜잭션으로 저장. 예상 project revision과 이전 행을 검사하며, FK·도메인 검증 실패는 전체 rollback한다.
- `get_online_project_changes`: 특정 revision 이후 변경 여부와 내역을 조회한다.
- 성공한 편집 IPC 응답은 서버 commit이 끝난 뒤 반환한다. AI 실행 중 기록은 모아서 전송하고 종료 시 다시 flush한다.
- 응답 유실은 같은 mutation UUID와 동일한 변경 내용으로 재시도한다. 로컬 journal에 기준 행, 정확한 요청, 미전송 변경을 보존한다.
- 다른 기기가 먼저 저장하면 자동 덮어쓰기나 자동 병합을 하지 않는다. 현재 작업을 보존하고 복구본 내보내기 또는 서버 버전 열기를 제공한다.

첫 버전의 충돌 단위는 프로젝트 revision이다. 서로 다른 문서를 동시에 저장해도 기준 revision이 오래되면 충돌할 수 있다. 문서별 revision/병합은 별도 확장 사항이다.

## Realtime

`online_project_data`의 작은 metadata 변경만 Supabase Postgres Changes로 구독한다. 본문 전체를 websocket 이벤트에 싣지 않는다. 다른 기기 저장을 수신하면 RPC로 일관된 최신 행을 가져와 열린 SQLite 연결에 반영한다. 새 연결과 재연결 때 다시 확인하여 놓친 이벤트를 복구한다. 주기적 폴링은 하지 않는다. 연결 중 알림이 누락되어도 다음 저장의 revision CAS가 충돌을 검출하고, 다음 알림에서 최신 상태를 받는다. 현재 구현은 변경 알림 후 전체 행 스냅샷을 읽으므로 큰 프로젝트의 증분 읽기 최적화는 후속 작업이다.

별도의 인증된 장기 연결을 사용하며 로그인 세션 변경 시 즉시 끊는다. 토큰 갱신은 Realtime 연결에도 반영한다. 자신의 저장 이벤트는 중복 적용하지 않는다. Electron preload와 개발 browser bridge 모두 `project.onChanged` 이벤트를 전달한다.

렌더러는 프로젝트·계정·세션·revision을 검사하고, 조회 전후로 미저장 입력과 AI 작업 상태를 확인한다. 깨끗한 화면은 갱신하며 입력 중인 화면은 내용을 보존하고 갱신 안내를 제공한다. 타이핑 문자 단위의 공동 편집, 커서·접속자 표시, CRDT/OT는 구현 범위에 포함하지 않는다.

## 권한과 실행 범위

소유자·편집자·열람자 역할을 지원한다. RLS는 프로젝트 멤버십을 검사하고, 모든 저장 RPC는 소유자 또는 편집자 권한을 별도로 검사한다. 최종 확정과 프로젝트 설정 변경은 소유자만 가능하다. 열람자는 읽기·검색·내보내기가 가능하며 편집·AI 실행은 차단한다. 멤버 관리와 초대는 소유자만 가능하다.

기기 캐시는 프로젝트 소유자가 아닌 **현재 로그인 계정** 별로 분리한다. 첨부 파일은 원래 소유자의 namespace를 유지하며 편집자는 업로드, 열람자는 다운로드만 가능하다. 역할 변경과 저장은 같은 프로젝트 행을 잠가 순서를 보장한다. 권한 제거 후 새 서버 요청은 차단하며(데이터 RPC가 비멤버를 `42501`로 거부하면 앱은 잠금 상태로 전환), 열린 앱은 저장 전 접근 재검사로 역할 변경을 반영한다. 권한 확인을 위한 주기적 폴링은 하지 않는다. 이미 내려받거나 내보낸 데이터의 회수는 보장하지 않는다.

AI는 현재 기기의 기존 CLI/제공자 연결에서 실행하며 결과와 실행 기록을 PostgreSQL에 저장한다. 서버가 AI를 대신 실행하는 작업 큐는 포함하지 않는다.

첨부는 파일당 50MiB까지 허용한다. 파일 바이트의 SHA256과 크기를 업로드/다운로드에서 검사한다. 같은 경로의 덮어쓰기는 허용하지 않는다. 악성 파일 검사는 별도 기능이다.

## 멤버 초대와 정원 (2026-09-23 구현)

- Premium 온라인 프로젝트별 정원은 **소유자 포함 총 5명**이다. 소유자 외 초대 가능한 인원은 최대 4명이며 편집자와 열람자를 합산한다.
- 역할은 소유자·편집자·열람자 세 가지로 한다. 별도 검토자 역할은 두지 않는다.
- 유효한 수락 대기 초대도 자리를 예약한다. 같은 대상의 재초대는 중복 계산하지 않으며 취소·만료된 초대와 제거된 멤버는 제외한다. 초대 수락은 예약된 자리를 멤버로 전환하므로 정원을 추가 소비하지 않는다.
- 정원은 프로젝트에 참여할 수 있는 계정 수다. 동시 접속 수나 기기 수 제한을 뜻하지 않는다.
- 초대 생성·수락의 정원 검사는 서버 트랜잭션과 프로젝트 행 잠금으로 처리하여 동시 요청도 5명을 초과하지 못한다.
- `online_project_members`는 수락한 계정의 역할을, `online_project_invitations`는 이메일·역할·만료·응답 상태를 저장한다. 소유자는 `online_projects.owner_id`에 유지한다.
- 초대는 7일간 유효하며 해당 이메일로 인증한 계정의 앱 ‘받은 초대’에 표시한다. 이메일 발송은 포함하지 않는다. JWT의 임의 email claim 대신 `auth.users`의 인증된 이메일을 확인한다.
- 소유자의 문해 LIVE Premium 구독이 active/trialing이고 유효기간 내일 때 새 초대·수락을 허용한다. 전용 Stripe 계정·Price·LIVE 모드를 private 설정으로 고정한다. 구독 만료 시 기존 멤버를 자동 제거하지 않으며 새 초대·수락만 중지한다.
- 시작 화면의 온라인 프로젝트 상세 및 열린 온라인 프로젝트 상태바의 ‘공유’에서 멤버·역할·초대 취소를 관리한다. 내 프로젝트와 공유받은 프로젝트를 구분한다.

## 이전 온라인 프로젝트 전환

초기에 도입했던 `online_project_workspaces`와 private `online-project-workspaces` bucket의 ZIP 체크포인트는 **이전 방식**이다. 새 저장에는 사용하지 않는다.

기존 온라인 프로젝트를 열면 이전 저장본을 검증하여 48개 테이블로 이관한다. 초기 이관 때만 이전 lease/fence를 검사하여 구버전 앱과의 경합을 막는다. PostgreSQL 초기 commit 후에는 구버전 checkpoint 저장을 서버에서 거부한다. 기존 원격 ZIP과 교체된 로컬 사본은 복구를 위해 보존한다. 일반적인 이후 편집에는 프로젝트 전체 lease가 필요 없다.

## 관련 파일과 검증

- 서버: `supabase/migrations/20260922121922_online_postgres.sql`
- 협업: `supabase/migrations/20260923114543_online_project_collaboration.sql`, `scripts/test-online-collaboration.mjs`
- 생성기: `scripts/generate-online-postgres-schema.mjs` — fully migrated SQLite의 실제 PK/FK/trigger에서 생성. 적용된 원본 SQL은 고정하며, 변경하려 하면 실패한다.
- 인덱스 정리: `supabase/migrations/20260922122434_online_postgres_indexes.sql` — 원본을 수정하지 않고 정확히 중복된 비제약 인덱스만 제거한다. 키·정렬·opclass·collation·조건식·표현식·저장 옵션을 비교하며 PK/제약/replica identity/cluster/partition 인덱스는 보존한다.
- 캐시: `packages/db-sqlite/src/online-data.ts`
- 저장/구독: `apps/desktop/src/main/online-{workspace,postgres-remote}.ts`, `authenticated-client.ts`
- 화면 갱신: `apps/desktop/src/renderer/scripts/project-change-ui.ts`

```sh
pnpm --filter @munhae/desktop typecheck
pnpm --filter @munhae/desktop exec vitest run tests/authenticated-client.test.ts tests/online-postgres-remote.test.ts tests/online-workspace.test.ts tests/project-change-ui.test.ts tests/session-online-lifecycle.test.ts
node scripts/test-online-postgres.mjs
node scripts/test-online-collaboration.mjs
pnpm --filter @munhae/desktop build
```

격리 SQL 검증은 임시 로컬 PostgreSQL 클러스터를 사용한다. 권한·CAS·재시도·FK·검증 trigger·동시 저장·초기 데이터 이관을 확인한다. 실제 Supabase 및 Electron 검증은 별도로 수행하고 결과를 기록한다.

### 2026-09-22 실제 적용·확인

- 연결된 `munhae` Supabase에 `20260922121922_online_postgres`, `20260922122434_online_postgres_indexes` 적용. 기존 community 및 legacy migration은 보존했다.
- 기존 온라인 프로젝트 ‘구리’를 이관한 뒤 PostgreSQL 48개 테이블의 67개 행 전체를 이관 전 복구 사본과 비교하여 모든 값이 일치함을 확인했다. 기존 원격 checkpoint와 별도 로컬 복구 사본은 보존했다.
- Electron preload → 실제 소유자 세션 → PostgreSQL에서 프로젝트 생성, 원문 작성·저장·확정을 확인했다. 새 프로젝트에는 ZIP Storage 객체가 생성되지 않았다.
- 별도 DB 세션이 동일 소유자 권한으로 저장한 문서 변경을 실제 Realtime 연결로 수신하여 열린 홈 화면이 자동 갱신됐다. 편집 중인 원문은 보존되고 ‘다른 곳에서 변경됨’ 안내가 표시됐다. 두 대의 물리적 기기를 사용한 검증과는 구분한다.
- 실제 Codex 번역과 문장 연결을 실행했고 PostgreSQL에서 실행 상태 `completed`, 검증 `valid`를 확인했다. 로컬 캐시 폴더 전체를 치운 뒤 새 캐시로 열어 원문 V2, 번역문, 문장 연결을 서버 데이터만으로 복원했다.
- 검증용 원격 프로젝트·데이터와 로컬 캐시는 제거하고 기존 ‘구리’ 편집 화면으로 복귀했다.
- 핵심 desktop 14개 파일 170개 테스트, 실제 로컬 PostgreSQL 도메인 roundtrip/CAS/이관/첨부 검증, desktop 타입 검사·빌드 통과. 별도 AI 테스트와 Electron native 테스트도 통과했다.
- 원격 신규 보안 WARN 없음. 중복 인덱스 정리 후 performance WARN 0개. private 변경 로그의 직접 접근 불가 및 아직 사용량이 적은 인덱스 관련 INFO는 남는다.

저장 응답이 실패한 뒤 같은 편집을 재시도할 때에는 채널·입력의 해시로 기존 결과를 찾아 같은 PostgreSQL 요청만 재시도한다. 로컬 CAS를 다시 실행하지 않는다. 이 IPC 재시도 결과는 현재 앱 세션 메모리에만 두며, 영구적인 네트워크 재시도는 별도의 디스크 journal이 담당한다.

### 2026-09-23 협업 적용·검증

- 연결된 Supabase에 협업 테이블·RLS 및 private RPC 경계 마이그레이션 두 개를 적용했다. 원격에서 데이터 48개 테이블의 멤버 읽기 정책, 정원 5명, LIVE 모드, 이전 commit 우회 경로의 실행 권한 차단을 확인했다.
- 격리 PostgreSQL에서 인증 이메일 초대·수락·거절·취소·만료, 외부 계정 격리, 역할 변경·제거, 첨부 권한, 최종 확정 차단, 실제 문서의 편집자 저장, 마지막 자리 동시 초대를 검증했다. Desktop 관련 86개 테스트, 타입 검사와 빌드를 통과했다.
- 실제 Electron 계정에서 프로젝트 목록·상세 공유·상태바 공유와 온라인 프로젝트 열기를 확인했다. 현재 미구독 계정에는 Premium 안내가 표시된다. 별도 합성 데이터 화면에서는 초대·취소 시 정원 갱신, 역할 변경, 받은 초대 수락, 열람자 입력 차단을 확인했다. 실제 다른 사람에게 초대를 발송하거나 LIVE 구독 권한을 임의 부여하지 않았다.
- 원격 advisor의 신규 협업 관련 WARN은 없다. 기존 community 공개/인증 함수 관련 경고와 Auth 유출 암호 보호 경고는 이번 작업 범위 밖이며 남아 있다. 참고: [함수 실행 권한](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable), [유출 암호 보호](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).
