# M0 기술 선택

plan.md §23의 구현 전 남은 선택에 대한 결정.

| 항목 | 결정 | 이유 |
|---|---|---|
| Bundler | electron-vite | main/preload/renderer 분리, HMR, electron-builder와 표준 조합 |
| Packaging | electron-builder | 사용자 요청. mac dmg+zip, win nsis, linux AppImage |
| SQLite | better-sqlite3 v13 (N-API) | WAL·단일 writer·동기 transaction. ORM 없음 |
| UUID | `uuid` 패키지의 v7 | 스키마: 애플리케이션이 생성하는 UUIDv7 |
| 시간 | RFC 3339 `TEXT` UTC | 프로젝트 전체 통일 |
| boolean | `INTEGER CHECK (x IN (0,1))` | schema.md §18.3 |
| JSON | `TEXT CHECK(json_valid(x))` | schema.md §18.3 |
| Renderer | 데모 HTML을 MPA로 이식 (React 없음) | 화면 충실도. proto/ 가 시각 기준 |
| Agent runtime | probe만 (which + version). 실제 LLM 호출은 M3 | 데모와 동일. 토큰은 CLI가 보관 |
| App config | `userData/app-config.json` + `userData/app.sqlite3` | plan §7.4, §8.11 |

보안 기본값 (plan §13):

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true` (renderer)
- preload는 좁은 typed API만
- IPC payload는 채널 allowlist + 타입 가드
- 외부 URL은 system browser
- 로컬 path는 project root 내부만
- CSP in renderer HTML
