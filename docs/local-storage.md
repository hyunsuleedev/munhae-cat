# 로컬 원문·번역 저장소

프로젝트의 `project.sqlite3`는 기존 SQLite 파일 형식을 유지한다. 원문·표점·번역의 생성, 조회, 저장, 확정, 버전 이력, 문장 연결 및 AI 결과 반영은 `drizzle-orm/better-sqlite3`의 동기 쿼리로 처리한다. Electron main의 기존 repository API와 IPC 계약은 그대로다.

`src/drizzle-db.ts`는 열린 `better-sqlite3` 연결마다 Drizzle 인스턴스를 하나만 만든다. 따라서 기존 native SQL과 Drizzle 쿼리는 동일한 연결, foreign key 설정, 트랜잭션과 savepoint를 사용한다. 버전 저장과 head의 `lock_version` 조건부 갱신은 같은 트랜잭션 안에서 실행하며 충돌하면 전체를 롤백한다.

## 스키마 변경

물리 스키마의 기준은 `infra/migrations/sqlite/*.sql`과 기존 checksum 기반 마이그레이션 실행기다. Drizzle은 쿼리의 타입과 SQL 생성을 담당한다. 기존 migration, trigger, CHECK 제약, FTS5, 프로젝트 데이터는 이 전환으로 수정하지 않는다. `drizzle-kit push`나 별도의 Drizzle migration 이력을 사용하지 않는다.

`packages/db-sqlite/src/drizzle-schema.ts`는 기존 SQL을 메모리 DB에 순서대로 적용한 결과에서 생성한 쿼리용 매핑이다. 새 migration을 추가할 때 기존 배포용 SQL 사본·embedded SQL도 갱신하고 다음을 실행한다.

```sh
pnpm --filter @munhae/db-sqlite generate:schema
pnpm --filter @munhae/db-sqlite test
pnpm --filter @munhae/db-sqlite typecheck
```

테스트 실행 전 생성물 일치 여부를 확인한다. DB 테스트는 앱과 동일한 Electron ABI에서 실행하며, 실제 migration 결과와 컬럼 이름·타입·null 허용·기본값을 비교한다. 생성물에는 쿼리에 필요한 컬럼 매핑만 포함된다. 인덱스·외래키·trigger의 정의는 SQL에 남는다.

## SQL을 유지하는 경계

- migration, PRAGMA, 무결성 검사, checkpoint, `VACUUM INTO` 백업은 SQLite 고유 API를 유지한다.
- FTS5 검색·갱신과 재귀 CTE 같은 SQLite 기능은 매개변수를 바인딩한 SQL 표현식을 사용한다.
- 용례 검색의 큰 결과는 Drizzle이 생성한 SQL을 기존 native iterator로 읽어 메모리에 전체 원문을 적재하지 않는다.
- 기기 설정용 `app.sqlite3`, 자료·코멘트·용어 등 별도 저장소의 일반 CRUD는 이번 원문·번역 전환 범위 밖이다.

원격 공유·인증 계층은 별도로 유지한다. 이 변경은 로컬 데이터 접근 계층을 바꾸며 원격 동기화 정책을 바꾸지 않는다.
