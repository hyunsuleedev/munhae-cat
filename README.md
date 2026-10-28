<p align="center">
  <img src="apps/desktop/build/icon.png" alt="문해 — 펼쳐진 서책 아이콘" width="112" height="112">
</p>

<h1 align="center">문해 文解 · Munhae Studio</h1>

<p align="center">
  <strong>한국어</strong> · <a href="README.en.md" lang="en">English</a>
</p>

<p align="center">
  <strong>원문을 읽고, 번역을 다듬고, 해석의 근거를 남기는 작업 공간.</strong><br>
  A desktop workspace for reading, translating, and annotating Classical Chinese texts.
</p>

<p align="center">
  <a href="#주요-기능">주요 기능</a> ·
  <a href="#시작하기">시작하기</a> ·
  <a href="#개발">개발</a> ·
  <a href="#문서">문서</a> ·
  <a href="#라이선스">MIT License</a>
</p>

문해는 고한문 번역가와 연구자를 위한 **번역 보조 도구(CAT, Computer-Assisted Translation)**입니다. 원문·표점·번역을 나란히 검토하고, 사전과 참고 자료를 확인하며, 구절별 해석과 용어 판단을 프로젝트에 모읍니다.

프로젝트는 컴퓨터의 `.munhae` 폴더에 SQLite와 첨부 파일로 저장됩니다. 직접 번역하거나, 사용자가 연결한 AI CLI로 번역안과 분석을 생성할 수 있습니다. AI가 만든 내용도 원문·출처와 함께 검토하고 수정할 수 있습니다.

> **현재 상태:** 개발 중인 데스크톱 앱입니다. 현재 빌드는 작업 화면에 들어갈 때 **문해 계정 로그인**이 필요합니다. 로컬 프로젝트를 중심으로 개발하고 있으며, 온라인 프로젝트·초대·협업 기능은 보류되어 있습니다.

## 주요 기능

| 작업 | 문해에서 할 수 있는 일 |
| --- | --- |
| 원문과 표점 | 문헌을 폴더와 문서로 구성하고, 원문 입력·텍스트 가져오기·표점 작성·확정을 진행합니다. 이미지와 PDF를 참고 자료로 첨부합니다. |
| 번역과 대조 | 전문 번역을 작성한 뒤 문장과 원문 구절을 연결합니다. 문장별 대조와 서책 보기를 전환하며 연결을 직접 조정합니다. |
| 용어 검토 | 문서의 용어 후보를 확인·수정·확정하고, 독음·번역어·뜻·다른 해석을 기록합니다. 프로젝트 공통 용어집도 관리합니다. |
| 사전과 구절 연구 | 내장 한자 사전에서 훈음·뜻·부수·획수·이체자를 확인하고, 구절별 독음·선택한 사전 뜻·풀이 순서를 기록합니다. |
| 문맥과 코멘트 | 번역 원칙과 배경 자료를 문서·폴더에 연결하고, 원문이나 번역의 특정 구절에 코멘트를 남깁니다. |
| 검토와 이력 | 프로젝트 안의 번역 용례를 찾고, 미연결 구절·용어 불일치 등을 점검합니다. 원문·표점·번역의 변경 이력과 확정 상태를 확인합니다. |
| 백업과 내보내기 | 프로젝트를 `.munhaepkg`로 백업·복원하고, 번역본을 Word·PDF·텍스트·Markdown으로 내보냅니다. 코멘트가 포함된 검토본도 출력합니다. |

화면 언어는 한국어와 영어를 지원합니다. 외부 AI 도구에서 열린 프로젝트를 읽고 편집하는 [로컬 MCP 연결](docs/local-mcp.md)도 개발 중입니다.

## 번역 작업 흐름

1. **원문 준비** — 프로젝트와 문서를 만들고 원문을 저장합니다. 문헌 정보와 이미지·PDF는 필요에 따라 추가합니다.
2. **읽기와 자료 정리** — 표점을 작성하고, 사전·용어·문맥 자료를 검토합니다. 문서 용어 후보를 생성·확정하려면 표점을 먼저 확정합니다.
3. **번역과 원문 연결** — 직접 번역하거나 AI에 전문 번역을 요청합니다. 번역을 저장한 뒤 별도 작업으로 원문 구절을 연결하고 대조합니다. 표점 없이 저장된 원문으로 번역을 시작할 수도 있습니다.
4. **검토와 전달** — 번역문·연결·코멘트를 확인하고 번역을 확정합니다. 작업을 백업하거나 목적에 맞는 번역본·검토본을 내보냅니다.

번역 생성과 원문 연결은 별개 작업입니다. 연결에 실패해도 저장된 번역은 유지되며, 연결만 다시 실행할 수 있습니다. 대응 관계를 확인하거나 번역을 확정하는 것은 사용자의 작업 상태를 기록하는 것이며, 번역의 학술적 정확도를 자동으로 보증하지 않습니다.

자세한 동작은 [전문 번역과 원문 연결](docs/full-text-translation.md), [번역가 작업 도구](docs/translator-workbench.md)를 참고하세요.

## 시작하기

### 소스에서 실행

필요한 개발 환경은 **Node.js 22.12 이상**, **pnpm 10**입니다. 저장소의 `packageManager`는 `pnpm@10.15.0`으로 지정되어 있습니다.

```sh
git clone https://github.com/hyunsuleedev/munhae-cat.git
cd munhae-cat
pnpm install --frozen-lockfile
pnpm --filter @munhae/desktop rebuild:native
pnpm dev
```

`pnpm dev`는 Electron 앱과 개발 서버를 함께 실행합니다. 처음 실행하면 문해 계정으로 로그인한 뒤 새 프로젝트를 만드세요. 최근 프로젝트가 없는 시작 화면에서는 **훈민정음 데모 열기**로 원문·표점·번역안이 들어 있는 예시 프로젝트를 살펴볼 수 있습니다.

현재 소스의 계정 연결은 문해 공식 서비스로 설정되어 있습니다. 별도의 인증 서버로 운영하려면 계정 설정과 서버 구성이 필요하며, 앱 안에서 서버를 바꾸는 설정은 제공하지 않습니다. [계정 구현과 운영 설정](docs/accounts.md)을 참고하세요.

### AI 연결

AI를 사용하려면 아래 CLI 중 하나를 **별도로 설치하고 해당 CLI에서 로그인**해야 합니다. 문해 계정과 AI 제공자의 계정은 별개이며, 모델 이용 권한·비용은 각 제공자의 조건을 따릅니다. 수동 편집과 내장 사전 조회에는 AI CLI가 필요하지 않습니다.

| 제공자 | 실행 파일 |
| --- | --- |
| Codex | `codex` |
| Claude Code | `claude` |
| Antigravity CLI | `agy` |

문해의 **설정 → 모델 및 제공업체**에서 설치·로그인 상태를 확인하고 사용할 모델을 선택합니다. 지원하는 모델과 실행 기능은 설치된 CLI 버전에 따라 달라집니다. Antigravity 연결은 [별도 안내](docs/antigravity-cli.md)를 참고하세요.

### 데이터 저장과 외부 연결

- **로컬 프로젝트:** 원문·번역·용어·코멘트는 프로젝트 SQLite에, 첨부 자료는 프로젝트의 `assets/`에 저장합니다. `.munhae`는 작업 폴더이고 `.munhaepkg`는 백업·전달용 압축 파일입니다.
- **AI 요청:** CLI는 컴퓨터에서 실행되지만, 선택한 원문·번역·문맥 자료는 해당 AI 제공자의 서비스로 전달될 수 있습니다. 로컬 파일 저장과 오프라인 AI 실행은 서로 다릅니다.
- **사전:** 내장 사전은 네트워크 없이 조회합니다. 온라인 사전·각주 검색은 선택한 외부 서비스에 검색어를 보냅니다. 국립국어원 API는 별도 인증키가 필요합니다.
- **계정:** 문해 로그인은 공식 인증 서비스를 이용합니다. 계정 세션과 사전 API 키는 프로젝트 밖에서 관리합니다.

저장 구조는 [로컬 저장소](docs/local-storage.md), 사전별 연결 조건과 출처는 [사전 안내](docs/dictionary.md)에 정리되어 있습니다.

## 개발

Electron·TypeScript 기반의 pnpm 모노레포입니다. 데스크톱 화면은 HTML/CSS와 TypeScript로 구성하며, SQLite 접근에는 `better-sqlite3`와 Drizzle을 사용합니다.

| 명령 | 용도 |
| --- | --- |
| `pnpm dev` | 개발 앱 실행 |
| `pnpm typecheck` | 워크스페이스 TypeScript 검사 |
| `pnpm test` | 패키지별 테스트 실행 |
| `pnpm build` | 앱 빌드 |
| `pnpm run pack` | 설치 프로그램 없이 앱 디렉터리 패키징 |
| `pnpm dist` | 현재 플랫폼용 배포 파일 생성 |

실제 AI·온라인 서비스에 연결하는 검사는 별도 환경과 실행 조건이 필요합니다. 기본 테스트가 통과해도 실제 로그인·모델 실행·설치본 검증을 대신하지는 않습니다.

<details>
<summary>Electron·SQLite 설치 문제 해결</summary>

Electron 바이너리 다운로드가 누락되었다면 저장소 루트에서 다음을 실행합니다.

```sh
pnpm --filter @munhae/desktop exec node node_modules/electron/install.js
```

`better-sqlite3` 로딩 실패나 `NODE_MODULE_VERSION` 불일치가 발생하면 앱이 사용하는 Electron용 네이티브 모듈을 다시 빌드합니다.

```sh
pnpm --filter @munhae/desktop rebuild:native
```

네이티브 모듈을 소스에서 컴파일하는 환경에는 운영체제별 C/C++ 빌드 도구와 Python이 필요할 수 있습니다. DB 패키지의 테스트 실행기는 Electron의 Node 런타임을 사용하므로, 시스템 Node용 SQLite 바이너리로 임의 교체하지 마세요.

</details>

### 저장소 구조

| 경로 | 역할 |
| --- | --- |
| `apps/desktop` | Electron main·preload·화면, 계정·AI 연결·내보내기 |
| `packages/domain` | 공통 타입·오류·식별자·텍스트 위치 처리 |
| `packages/project-format` | `.munhae` 프로젝트 형식과 백업 |
| `packages/db-sqlite` | 프로젝트 저장소·검색·변경 이력·번역 작업 |
| `packages/agent-runtime` | AI CLI 탐지·실행·응답 처리 |
| `infra/migrations` | 로컬 SQLite 마이그레이션 |
| `supabase` | 공식 서비스의 서버 함수·마이그레이션·플러그인 카탈로그 |
| `scripts` | 데이터 생성·서비스 검사·릴리스 도구 |
| `docs` | 기능별 사용법과 구현 문서 |
| `proto` | 초기 화면 실험과 디자인 시안 |

### 패키징

산출물은 `apps/desktop/release/`에 생성됩니다. 패키징 설정에는 macOS의 DMG·ZIP, Windows x64의 NSIS 설치 파일, Linux의 AppImage 타깃이 있습니다. 타깃 설정은 각 운영체제의 설치·실행 검증이나 서명 완료를 의미하지 않습니다.

일반 `pnpm dist`와 공식 배포용 서명·공증·게시 절차는 구분합니다. macOS는 [서명 및 공증](docs/macos-signing.md), Windows는 [직접 배포와 업데이트](docs/windows-release.md)를 참고하세요.

## 현재 범위와 후속 작업

현재는 로컬에서 읽기·번역·검토·출력하는 흐름을 다듬고 있습니다.

- **온라인 프로젝트·협업:** 기능 플래그로 비활성화되어 있습니다. 기존 코드와 서버 마이그레이션은 남아 있지만, 최신 로컬 스키마와 동기화되지 않습니다. [보류 상태와 재개 조건](docs/online-projects.md)
- **로컬 MCP:** 프로젝트 조회와 편집 도구가 구현되어 있으며, CLI 연결·화면 갱신·접근 제어에 남은 작업이 있습니다. [구현 현황](docs/local-mcp.md)
- **문서 교환:** HWPX·TMX·용어집 TBX/CSV 교환과 수정한 대역 DOCX를 다시 반영하는 기능은 후속 범위입니다. [내보내기 형식](docs/translation-export.md)
- **원문 취득:** OCR·이미지 영역 인식·자동 전사는 현재 범위에 포함하지 않습니다.

`plan.md`와 일부 설계 문서에는 초기 계획·과거 동작이 함께 남아 있습니다. 현재 기능을 확인할 때는 이 README와 각 문서의 최신 구현 현황을 먼저 참고하세요. `proto/`는 실행 중인 제품의 기능 명세가 아닙니다.

## 문서

| 주제 | 안내 |
| --- | --- |
| 번역 | [전문 번역과 원문 연결](docs/full-text-translation.md) · [검토 작업 도구](docs/translator-workbench.md) |
| 연구 | [한자·어휘 사전](docs/dictionary.md) · [구절 연구](docs/reading-study.md) · [용어 검토](docs/term-review.md) |
| 자료와 결과물 | [번역 자료와 문맥](docs/translation-materials.md) · [번역본 내보내기](docs/translation-export.md) |
| 저장과 연결 | [로컬 저장소](docs/local-storage.md) · [계정](docs/accounts.md) · [로컬 MCP](docs/local-mcp.md) |
| 설계 배경 | [제품 계획](plan.md) · [데이터 모델](schema.md) · [설계 결정](docs/decisions.md) |

## 기여하기

버그 제보, 번역가의 실제 작업 사례, 문서 수정과 코드 기여를 환영합니다.

- **버그 제보:** 운영체제·앱 버전·재현 순서·기대 동작·실제 동작을 함께 적어 주세요. AI 연결 문제에는 CLI 이름과 버전도 포함해 주세요.
- **기능 제안:** 어떤 문헌을 어떤 순서로 작업하다 막혔는지 알려 주세요. 공개할 수 있는 짧은 예문이 있으면 도움이 됩니다.
- **코드 기여:** 큰 구조·저장 형식 변경은 먼저 이슈에서 논의해 주세요. PR에는 변경 이유와 확인한 동작을 적고, 관련 테스트·타입 검사를 실행해 주세요.
- **문서 기여:** 기능·실행 방법·지원 범위가 바뀌면 한국어 README와 [영문 README](README.en.md)를 함께 갱신해 주세요.

제보나 예시 프로젝트에는 미공개 연구 자료·개인정보·인증키를 포함하지 마세요. 원문·사전·이미지·음원 등을 추가할 때는 출처와 재배포 조건도 함께 남겨 주세요.

## 라이선스

문해에서 직접 작성한 애플리케이션 코드는 [MIT License](LICENSE)로 배포합니다. 상업적 이용·수정·재배포가 가능하며, 저작권과 라이선스 고지를 유지해야 합니다.

외부에서 가져온 코드·데이터·자산에는 각각의 이용 조건이 적용됩니다. MIT 표기는 아래 자료의 라이선스를 대체하지 않습니다.

| 자료 | 이용 조건과 출처 |
| --- | --- |
| libhangul 한자 자료·한국어 위키낱말사전 가공 데이터 | [BSD-3-Clause·CC-BY-SA-4.0 및 출처 고지](apps/desktop/src/main/data/hanja-NOTICE.txt) |
| Unicode Unihan 문자 속성 | [Unicode License V3 및 출처 고지](apps/desktop/src/main/data/hanja-Unihan-NOTICE.txt) |
| AnimCJK 글자 자산 | [파일별 적용 조건](apps/desktop/src/renderer/public/licenses/animcjk/COPYING.txt) · [Arphic Public License](apps/desktop/src/renderer/public/licenses/animcjk/ARPHIC-LICENSE.txt) |
| 배경 음악 | [CC BY 4.0 및 출처 고지](apps/desktop/src/renderer/public/music/LICENSE.txt) |
| 알림음 | [공공누리 제1유형·가공 내역](apps/desktop/src/renderer/public/music/NOTIFICATION-LICENSE.txt) |

사용자가 가져오는 문헌·번역·참고 자료의 이용 권한은 해당 자료의 권리와 조건을 따릅니다.
