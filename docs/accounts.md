# 문해 공식 계정

운영자 Supabase 프로젝트 `xanucaevzpwwabnmpamm` (`munhae`, Seoul)를 사용한다. 공식 앱에는 서버 선택 설정이 없다. 현재 구현은 계정 인증까지이며 공유 프로젝트, 멤버십, 결제, 클라우드 저장은 포함하지 않는다.

## 사용자 흐름

- Electron 메인 프로세스의 Supabase SDK와 계정 서비스가 앱 실행 동안 세션을 관리한다. 최초 복원 시 저장된 세션을 확인하고, 저장 세션의 사용자 정보는 `getUser`로 서버에서 한 번 검증한다. 초기 연결 실패는 로그인 정보를 지우지 않고 재시도를 제공한다.
- 모든 작업 화면의 공통 진입점(`app-entry.ts`)은 메인에서 현재 상태를 받고 변경 이벤트를 구독한다. 초기 복원이 끝나지 않았으면 기다리며, 이후 페이지 이동은 메모리에 유지된 상태를 즉시 받는다. 페이지마다 `getSession`/`getUser`를 실행하거나 30초 캐시를 만료시키지 않는다.
- 로그인되지 않았거나 세션이 무효하면 로그인 화면으로 이동하며, 로그인 후 원래 요청한 앱 내부 화면으로 돌아간다. 비밀번호 복구 세션은 새 비밀번호 설정을 먼저 완료한다.
- 빠른 확인에서는 중간 로그인 안내를 표시하지 않는다. 준비가 200ms를 넘으면 진행 안내를 표시하고, 인증 실패는 지연 없이 오류와 재시도를 보여준다. 페이지 초기화 중에는 로그인 확인과 구별해 화면 준비 안내를 표시한다.
- 토큰 만료에 따른 갱신과 재시도는 SDK의 자동 갱신이 담당한다. 로그인·토큰 갱신·사용자 변경·복구·로그아웃 이벤트를 메인이 반영하고 화면으로 전달한다. 프런트의 주기적 인증 검사와 포커스마다 수행하던 재검증은 없다. 토큰 갱신과 일시적인 네트워크 장애로 이미 열린 작업 화면을 초기화하지 않으며, SDK가 실제 세션 종료를 알리면 로그인 화면으로 전환한다. 인증 상실로 화면을 이동할 때 기존의 미저장 변경 보호를 유지한다.
- Electron은 IPC로 상태 변경을 받고, localhost 개발 미리보기는 같은 메인 상태를 HTTP 스트림으로 받는다. 스트림 연결 실패는 로그아웃으로 취급하지 않으며 재연결 시 현재 상태를 다시 받는다. 브라우저의 뒤로 가기 캐시에서 복원될 때는 누락된 이벤트를 보완하도록 메인의 현재 상태를 다시 읽는다.
- 프로젝트 사이드바의 **문해 계정**에서는 프로필·비밀번호 변경·로그아웃을 관리한다. 로그아웃 상태에서는 프로젝트로 돌아가기 및 작업 메뉴를 사용할 수 없다.
- **Google로 계속하기**를 누르면 시스템 브라우저에서 계정을 선택한다. 인증을 마치면 앱에 로그인되며 별도 이메일 인증번호는 필요하지 않다. 취소하거나 5분 안에 완료하지 않으면 다시 시작할 수 있다.
- 이름·이메일·비밀번호로 가입하고 이메일로 받은 8자리 인증번호를 앱에 입력한다. 비밀번호는 8자 이상이다.
- 이메일·비밀번호로 로그인하며, 이메일 미인증 계정은 인증 화면으로 안내한다.
- 설정의 **계정** 섹션(`settings.html#account`)에서 프로필·로그인 상태 확인, 비밀번호 변경, 로그아웃을 관리한다. 사이드바에는 별도 계정 화면 대신 설정만 표시한다.
- 비밀번호 변경은 현재 비밀번호를 확인한 뒤 진행한다. 가입·로그인·복구는 독립 로그인 진입 화면을 사용하며, 로그인 후에는 요청했던 문서나 설정 섹션으로 돌아온다.
- 비밀번호를 잊은 경우 이메일로 복구 인증번호를 받아 앱에서 인증하고 새 비밀번호를 설정한다.
- 인증번호 재발송, 요청 중 중복 제출 방지, 실패 안내, 이 기기에서 로그아웃을 지원한다.
- 앱 사용에는 로그인이 필요하다. 프로젝트를 열거나 로그인해도 프로젝트 파일을 서버로 전송하지 않는다. 이 진입 제어는 앱 화면에 적용되며 로컬 파일 암호화나 서버의 프로젝트 권한 검증을 대체하지 않는다.

메일은 링크 대신 `{{ .Token }}`을 표시하므로 이메일 인증은 브라우저 리디렉션이나 desktop deep link 없이 마칠 수 있다. Google만 연결된 계정은 비밀번호를 Google에서 관리한다. 이메일 로그인도 연결된 계정은 기존 비밀번호 변경 기능을 유지한다.

## 저장과 권한 경계

- `src/main/auth-config.ts`: 공식 URL·publishable key만 포함한다. 서비스 관리자 키는 앱에 넣지 않는다.
- `src/main/auth.ts`, `account-service.ts`: main process가 요청, 세션 갱신, 인증 이벤트를 처리한다. renderer는 제한된 IPC만 호출한다.
- `src/main/auth-storage.ts`: OS `safeStorage`로 암호화한 세션을 Electron user data의 `account-session.enc`에 저장한다. 프로젝트 SQLite·assets·백업에는 세션을 넣지 않는다. OS 암호화를 쓸 수 없거나 Linux `basic_text` backend면 메모리에만 유지한다.
- renderer에는 사용자 ID·이메일·표시 이름·이메일 인증 시각, 연결된 로그인 방식(`email`, `google`)과 상태만 전달한다. access/refresh token과 공급자의 임의 응답은 전달하지 않는다.
- 표시 이름은 `auth.users.user_metadata.display_name`을 우선하며 Google 계정의 `full_name`, `name`도 읽는다. 향후 유료 이용 권한이나 프로젝트 역할은 이 metadata나 UI 상태를 신뢰하지 않고 서버의 멤버십·결제 원장에서 검증한다.
- Google 인증은 `google-oauth.ts`의 임시 PKCE 클라이언트가 처리한다. 매 시도마다 `127.0.0.1`의 임의 포트와 256비트 무작위 경로를 사용하고, 인증 응답의 Host·경로·HTTP 메서드를 확인한 뒤 코드를 한 번만 교환한다. 완료·취소·시간 초과 시 수신 서버를 닫는다.
- Google provider token은 보관하지 않는다. 기존 계정 서비스에는 Supabase access/refresh token만 전달한다. Google client secret은 Supabase 서버에만 설정하며 앱·저장소에는 포함하지 않는다.
- Codex·Claude CLI 로그인과 문해 계정은 독립적이다.

## Supabase 운영 설정

CLI로 공식 프로젝트를 확인하고 연결한다.

```sh
supabase projects list
supabase link --project-ref xanucaevzpwwabnmpamm
```

2026-09-05에 공식 프로젝트에 적용·재확인한 항목:

- 이메일 가입 허용, 이메일 확인 필수 유지
- 최소 비밀번호 길이 8
- 가입·비밀번호 복구 이메일의 한국어 제목 및 `supabase/templates/` 인증번호 템플릿
- 기존 8자리 인증번호와 1시간 만료 유지

**공개 회원가입에 남은 운영 설정은 SMTP다.** 확인 당시 custom SMTP가 없었다. Supabase 기본 메일은 일반 사용자 대상 운영용 발송을 제공하지 않으므로, 운영자의 발송 도메인·발신 주소와 SMTP 제공자를 연결해야 한다. 이메일 확인을 끄는 방식으로 대체하지 않는다. 비밀번호 복구 이메일에도 같은 설정이 필요하다. [Supabase SMTP 문서](https://supabase.com/docs/guides/auth/auth-smtp).

`supabase/config.toml`에는 개발용 Auth 설정과 템플릿을 기록했다. 원격 설정은 필요한 Auth 필드만 변경했다. 생성된 로컬 config 전체를 원격으로 덮어쓰지 않는다. SMTP 자격 증명은 저장소에 커밋하거나 클라이언트 환경변수에 넣지 않는다.

## Google 로그인 운영 설정

2026-09-05에 운영자 계정 `hyunsulee.dev@gmail.com`으로 기존 프로젝트와 별개인 Google Cloud 프로젝트를 생성했다.

| 항목 | 값 |
| --- | --- |
| Google Cloud 프로젝트 ID | `munhae-cat-studio` |
| 프로젝트·동의 화면 앱 이름 | `munhae cat studio` |
| OAuth 클라이언트 | `munhae cat studio - Supabase` / Web application |
| Client ID (공개 식별자) | `83754412622-1e719eh3026dotffq64s44trc4avctlo.apps.googleusercontent.com` |
| Google에 등록한 redirect URI | `https://xanucaevzpwwabnmpamm.supabase.co/auth/v1/callback` |
| Supabase의 앱 복귀 허용 패턴 | `http://127.0.0.1:*/auth/google/callback/*` |
| 요청 권한 | `openid`, `email`, `profile` |

Supabase CLI 로그인 자격으로 Management API의 Google provider와 redirect 허용 목록만 갱신했다. Google provider 활성화·새 client ID·nonce 검사 유지·허용 목록을 다시 조회했다. API가 secret을 가린 형태로 반환하므로 저장값 문자열 비교로 secret 유효성을 판정하지 않는다. 실제 코드 교환이 최종 검증이다.

현재 Google Audience는 **Testing**이며 운영자 이메일을 테스트 사용자로 등록했다. 홈페이지·개인정보처리방침 등 공개 브랜딩 정보와 Google의 브랜드 검증은 아직 완료하지 않았다. 이 상태에서 Google 계정 선택 화면에는 앱 이름 대신 Supabase 프로젝트 도메인이 표시될 수 있다. 공개 운영 상태와 브랜드 표시 완료를 구분한다. [Supabase Google 설정 문서](https://supabase.com/docs/guides/auth/social-login/auth-google).

앱의 Google 버튼에는 [Google 공식 브랜드 안내](https://developers.google.com/identity/branding-guidelines)의 [G 이미지](https://developers.google.com/static/identity/images/g-logo.png)를 사용한다.

## 검증

`apps/desktop/tests/account.test.ts`는 입력 검증, 비밀 정보 제외, OS 암호화 저장·복원, 복구 세션과 일반 세션의 비밀번호 변경 조건, Google 계정 표시와 세션 수락을 검사한다. `account-session-lifecycle.test.ts`는 초기 복원 공유, 초기 서버 검증, 실패 후 재시도, SDK 이벤트, 로그인·로그아웃 경합을 검사한다. `auth-gate.test.ts`와 `browser-auth-events.test.ts`는 화면의 상태 수신 순서, 페이지 중복 초기화 방지, 스트림 연결 종료·재연결과 토큰 제외를 검사한다. `google-oauth.test.ts`는 실제 loopback HTTP 요청으로 응답 경로·Host·메서드·중복 코드 검사, 취소·시간 초과·앱 종료, provider token 제외를 검사한다.

```sh
pnpm typecheck
pnpm --filter @munhae/desktop exec vitest run tests/account.test.ts tests/account-session-lifecycle.test.ts tests/account-page-state.test.ts tests/auth-gate.test.ts tests/browser-auth-events.test.ts tests/google-oauth.test.ts
pnpm --filter @munhae/desktop build
```

실제 서버 검증은 임시 계정으로 수행하고 끝나면 삭제한다. 관리자 발급 OTP 검증과 사용자가 실제 메일을 수신하는 검증은 구분한다. SMTP 연결 후에는 일반 주소의 신규 가입 → 메일 수신 → 코드 인증 → 로그인과 비밀번호 복구 메일 수신까지 확인해야 한다.

2026-09-08 세션 수명 전환 검증: 격리된 Electron에서 실제 `AccountService`와 preload/IPC, 빌드된 편집 화면을 사용하고 Supabase 응답만 모의했다. 페이지 이동과 상태 조회를 반복해도 `getSession`·`getUser`는 각각 최초 1회였다. 토큰 갱신과 검증 서버의 연결 실패를 모의해도 미저장 번역 초안과 같은 편집 DOM이 유지됐으며, 로그아웃 이벤트는 계정 화면으로, 재로그인은 원래 문서로 이동했다. 실제 개발 앱 재시작 후에도 기존 암호화 세션이 복원됐고 localhost의 상태 이벤트 스트림이 HTTP 200과 `signed_in`을 반환했다. 이 검증은 신규 OAuth 로그인이나 실제 토큰 만료를 기다린 검증과는 구분한다.

2026-09-05 검증 결과: 타입 검사·빌드와 계정/IPC/프로젝트 이동 관련 36개 테스트 통과. 실제 Electron과 공식 서버에서 미인증 로그인 차단, 관리자 발급 가입 OTP 인증, 비밀번호 변경과 이전 비밀번호 거부, 암호화 세션의 앱 재시작 복원, 복구 OTP 인증·새 비밀번호 로그인, 로그아웃을 확인했다. 임시 계정은 삭제했으며 기존 프로젝트 53개 table은 변경되지 않았다.

같은 날 운영자 본인 계정으로 이메일 회원가입 → Chrome의 Gmail 받은편지함에서 실제 인증 메일 수신 → 앱에서 인증번호 확인 → 로그아웃 → 비밀번호 재로그인도 통과했다. 본인 계정은 요청에 따라 유지했다. 일반 사용자 주소의 가입·복구 메일 수신 검증은 custom SMTP 연결 후 진행한다.

Google 로그인 추가 검증: 계정·OAuth·IPC·프로젝트 이동 관련 47개 테스트와 전체 타입 검사·앱 빌드가 통과했다. 실제 Electron에서 공식 Supabase를 거쳐 새 OAuth 클라이언트의 Google 계정 선택 화면까지 진입했다. Google의 패스키 본인 인증을 기다리고 있으므로 실제 로그인 완료와 기존 이메일 계정의 자동 연결은 아직 검증 완료로 기록하지 않는다. 기존 프로젝트 53개 table의 전체 데이터는 변경되지 않았고 SQLite 무결성 검사도 통과했다.
