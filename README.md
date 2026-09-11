# 문해 (Munhae Studio)

고한문 번역가와 연구자를 위한 로컬 Electron CAT 도구. 회원가입 없이 `.munhae` 프로젝트(SQLite + assets)로 원문·표점·번역·용어를 관리한다.

문해 공식 서비스의 Google 로그인과 이메일 회원가입·로그인도 지원한다. 시작 화면 또는 사이드바의 **문해 계정**에서 Google 인증, 이메일 인증, 비밀번호 재설정, 계정 관리를 할 수 있다. 서버는 운영자의 Supabase 프로젝트를 사용한다. 공유 프로젝트·팀 권한·결제는 후속 구현 범위다. [계정 구현과 운영 설정](docs/accounts.md).

Phase 1 범위와 데이터 모델, 현재 제품 흐름은 `plan.md`, `schema.md`를 따른다. `proto/`는 초기 화면 탐색 기록이며 현재 동작의 규범이 아니다.

## 번역 흐름

원문을 저장하면 표점이나 사전 분절 없이 전문 번역을 시작할 수 있다. 번역을 먼저 저장한 뒤 별도 AI 요청으로 한국어 문장과 원문을 연결한다. 두 작업의 스킬은 앱에 기본 포함된다. [구현 계약과 저장 방식](docs/full-text-translation.md).

## 번역가 작업 도구

문서 찾기·바꾸기, 프로젝트 대역 용례, 직접 용어 등록, 번역 점검, 코멘트 포함 검토본 출력을 제공합니다. [사용법과 검증 범위](docs/translator-workbench.md), [다른 번역 도구 조사](docs/translator-tool-research.md).

공통 지식은 **문맥·용어집·불확실성**으로 관리합니다. 필요한 배경 설명은 문맥 카드에 기록하고 문서 범위에서 상속합니다. 저자는 문서 정보에 자유롭게 입력합니다. 스키마 v5에서 기존 인물·지명 전용 데이터와 테이블을 제거하며 문맥으로 복사하거나 별도로 보존하지 않습니다. [지식 모델 단순화](docs/knowledge-simplification.md).

**한자·어휘 사전**에서 무료 오프라인 훈음·한국어 풀이, KOSTMA 고문헌 용어, 국립국어원 API를 조회하고 선택한 뜻을 출처와 함께 코멘트·용어 등록으로 가져옵니다. [사전 사용과 무료 API 연결](docs/dictionary.md).

## 요구 사항

- Node.js ≥ 22.12
- pnpm 10

## 개발

```bash
pnpm install
pnpm --filter @munhae/desktop rebuild:native
pnpm dev
```

pnpm 10이 `electron` / `better-sqlite3` 설치 스크립트를 건너뛰면:

```bash
node node_modules/electron/install.js
# 테스트용 Node ABI
(cd node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3 && npm run build-release)
# Electron ABI
pnpm --filter @munhae/desktop rebuild:native
```

## 패키징 (electron-builder)

```bash
pnpm dist
```

산출물은 `apps/desktop/release/`.

## 워크스페이스

- `apps/desktop` — Electron main / preload / renderer
- `packages/domain` — ID, hash, code-point, version 용어
- `packages/project-format` — `.munhae` 디렉터리 패키지와 `.munhaepkg` 백업
- `packages/db-sqlite` — 프로젝트·앱 SQLite, command
- `packages/agent-runtime` — Codex/Claude/Antigravity CLI 탐지·실행과 비공개 도구 스트림 경계

## Windows 배포와 앱 업데이트

Windows 10/11 x64용 NSIS 설치본, R2 파일 배포, 앱 업데이트 흐름은 [Windows 배포 안내](docs/windows-release.md)를 참고하세요. 실제 R2 연결과 Windows 설치 검증 전에는 설치본을 공개하지 않습니다.
