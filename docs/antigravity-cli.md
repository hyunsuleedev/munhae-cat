# Antigravity CLI

문해 설정의 **모델 및 제공업체 → Antigravity CLI**에서 선택한다. 실행 파일은 `agy`이며 PATH와 사용자 설치 경로에서 찾는다. 관리형 설치는 절대 경로인 `ANTIGRAVITY_BIN`으로 지정할 수 있다. 로그인은 터미널에서 `agy`를 실행해 완료한다. 문해는 인증 정보를 복사하거나 저장하지 않는다.

로컬 `open-design/apps/daemon/src/runtimes/defs/antigravity.ts`의 실행 계약을 참고했다. `agy -p -`는 실제 요청 대신 `-`를 전달하므로 요청 본문을 `-p` 인자로 전달한다. 일반 텍스트 응답은 완료 시 전달하며 CLI 세션을 재개하지 않는다. 후속 채팅은 문해의 전체 대화 요청을 사용한다. 번역·원문 연결·표점은 기존 실행별 문해 도구 권한과 제출 검증을 사용한다.

설치된 CLI의 도움말을 기준으로 지원 기능을 판단한다.

- 최신 버전: `agy models`에서 실제 모델 ID/이름을 조회한다. 모델 목록 조회 성공으로 연결 상태를 확인하고, 모델과 추론 강도를 `--model`/`--effort`로 전달한다. 서비스 등급은 지원하지 않는다.
- 구버전: OpenDesign과 같은 호환 모델 이름을 제공하며, 실행 전에 `~/.gemini/antigravity-cli/settings.json`의 `model`만 변경한다. `CLI 기본값`은 파일을 변경하지 않는다. 같은 문해 런타임 내 실행은 직렬화한다. 별도로 실행한 `agy`나 다른 앱이 설정을 변경하는 것은 이 잠금의 대상이 아니다. 손상된 설정 파일은 덮어쓰지 않는다.
- 도구 제출이 필요한 실행에는 지원 여부를 확인한 뒤 `--dangerously-skip-permissions`를 전달한다. CLI는 빈 임시 디렉터리에서 실행하며 문해 제출 도구는 실행별 일회성 권한으로 연결한다.
- `--log-file`은 `-p`보다 앞에 둔다. 실패하거나 응답이 비어 있을 때만 로그로 인증/모델 할당량 오류를 분류한다. 정상 응답이 있으면 초기화 중의 일시적인 인증 오류 로그를 무시한다. 원시 로그는 UI에 전달하지 않고 임시 실행 디렉터리와 함께 삭제한다.

검증 (2026-09-07): `agy 1.1.27`의 실시간 모델 조회, 한국어 응답, 실제 번역 제출 도구 호출, 설정 자동 저장/재진입을 확인했다. 구버전 동작은 가짜 CLI를 이용한 회귀 테스트로 검증했다.

```sh
pnpm --filter @munhae/agent-runtime test
pnpm --filter @munhae/desktop test
# 설치 및 로그인된 실제 CLI로 검사 (실제 모델 요청 발생)
MUNHAE_LIVE_ANTIGRAVITY=1 pnpm --filter @munhae/agent-runtime exec vitest run tests/antigravity.test.ts
MUNHAE_LIVE_ANTIGRAVITY=1 pnpm --filter @munhae/desktop exec vitest run tests/live-agent-tool.test.ts
```
