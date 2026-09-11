# 문해 직접 배포와 R2 업데이트

## 배포 결정 (2026-09-10)

유료 코드 서명, Azure Artifact Signing, Microsoft Store 등록은 보류한다. Windows EXE는 미서명 시험 배포본으로 제공한다. Mac DMG는 Apple Developer ID/공증 없이 제공하되, 패키지 무결성을 위해 electron-builder의 ad-hoc 서명(identity `-`)을 적용한다. 이는 Apple이 배포자를 확인한 서명이 아니다.

- 홈페이지: https://munhaestudio.com
- 공개 파일 호스트: https://download.munhaestudio.com
- R2 버킷: `munhae-releases`. `estaitt.com` 등 다른 프로그램의 리소스는 사용하지 않는다.
- 소스: 비공개 `hyunsuleedev/munhae-cat`.
- 이번 릴리스는 원래 작업 폴더의 미커밋 변경을 보존하기 위해 `/Users/hyunsulee/munhae-release-20260910`에 별도 소스 스냅샷을 만들었다. 원격 `release/installers-20260910`은 독립 이력의 배포용 브랜치다. main에 그대로 병합하지 않는다.

## 플랫폼

- Windows 10/11 x64: NSIS 전체 EXE, 사용자별 설치. Windows 32비트/ARM 네이티브 빌드는 제공하지 않는다.
- macOS arm64와 x64: 별도 DMG. Mac 업데이트는 새 DMG 수동 설치.
- Linux: 준비 중.
- Windows Server 2022 CI의 설치/실행 검사는 Windows 10 또는 Windows 11 실기기 검증을 대신하지 않는다.
- Apple Silicon Mac의 실제 패키지 시작 화면/계정 화면과 preload 연결을 확인했다. Intel 패키지는 아키텍처/내부 서명 검사를 통과했지만 이 Apple Silicon 환경의 Intel 실행 검사는 완료하지 못했다.

## Windows 자동 업데이트

Electron 38.8.6 / electron-updater 6.6.2. 공개 feed는 `https://download.munhaestudio.com/windows/x64/`.

패키지에 `app-update.yml`이 있는 Windows x64에서만 업데이트를 지원한다. 시작 30초 후 및 도움말 → 업데이트 확인에서 확인한다. 자동 다운로드, 일반 종료 시 자동 설치, 다운그레이드는 끈다. 사용자가 다운로드와 종료·설치를 선택해야 한다. 미저장 작업 종료 확인과 실행 중 AI 작업 차단을 통과한 뒤 서비스와 DB를 종료한다. 실제 버전 간 업그레이드는 아직 검증하지 않았다.

## 빌드와 게시

`build-installers.yml`은 배포용 브랜치 push에서 Windows 빌드, npm CLI shim 테스트, EXE 설치 및 실제 패키지 시작 검사를 수행한다. GitHub Actions artifact는 비공개이며 R2 게시 전까지 홈페이지에 연결하지 않는다.

원래 checkout의 `windows-release.yml`은 workflow_dispatch용이다. `unsigned_preview=true`는 명시적인 미서명 시험 배포 모드다. 서명 배포 모드는 Authenticode와 Windows 10 검증 선언이 필요하다. 이 선언은 실제 OS 자동 테스트가 아니다.

GitHub environment `windows-release`:

|종류|이름|
|---|---|
|Variable|MUNHAE_UPDATE_URL, R2_BUCKET, R2_PREFIX|
|Secret|R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY|

S3 키는 문해 버킷의 Object Read & Write 범위만 갖는다. 앱, 웹사이트, Git에는 키를 넣지 않는다.

```powershell
pnpm install --frozen-lockfile
node scripts/release/build-windows.mjs
node scripts/release/publish-r2.mjs                     # dry run
node scripts/release/publish-r2.mjs --publish --allow-unsigned
```

macOS에서:

```sh
pnpm --filter @munhae/desktop dist --mac --arm64 --x64 --publish never
node scripts/release/publish-macos.mjs --publish
```

게시 전 버전/이름/크기/SHA-512를 검증한다. 버전 파일을 먼저 업로드하고 공개 HTTPS에서 전체 파일 SHA-256을 확인한 후 `latest.yml`을 마지막에 갱신한다. 파일은 immutable이며 같은 이름의 다른 파일로 덮어쓰지 않는다. 메타데이터는 no-store 및 ETag 조건부 쓰기로 게시한다. 다음 배포 때 버전을 올린다.

## 검증과 설치 실패 진단

- 로컬 agent-runtime 회귀: 55 통과, 5 건너뜀(실제 CLI 및 Windows 전용 항목 포함).
- 배포 유틸리티: 5 통과. 기존 업데이트/종료/로그 테스트: 11 통과.
- Windows npm `.cmd` CLI는 cross-spawn 7.0.6으로 실행한다. 프롬프트 인자/표준입력 보존을 Windows 전용 테스트로 검사한다.
- `scripts/release/smoke-packaged.mjs`는 실제 패키지를 디버거에서 일시정지하고 임시 userData/log 경로를 설정한 뒤 시작 화면과 preload를 확인한다. 개발 서버 테스트가 아니다. 로그인/AI 전체 기능이나 OS 보안 경고 통과를 보증하지 않는다.
- NSIS 초기 기록: `%TEMP%\Munhae-setup.log`.
- 앱 로그: Electron logs 경로의 `main.log`/`main.log.previous`.
- 네이티브 모듈 로드 실패: `startup-fatal.log`와 오류 창.
- OS/백신이 프로세스 자체를 차단하면 앱 로그가 없을 수 있다. 내려받은 파일 해시, Defender 보호 기록, Windows 이벤트 로그를 확인한다.

## 공개 완료 기록 (2026-09-10)

- Windows 0.1.0 빌드: commit `21530ef`, Actions run `34536539524`. 이 빌드의 설치 검사는 테스트 환경 변수 문제로 실패했으며 설치 파일 빌드와 업로드는 성공했다.
- 동일 파일 재검증: run `34536998669`, success. SHA-256 일치, Authenticode `NotSigned`, 자동 설치 exit 0, 실제 Electron 38.8.6 x64 계정 화면과 preload object 확인.
- Windows `.cmd` CLI 테스트는 Windows runner에서 3개 통과. 로컬 회귀는 55 통과/5 건너뜀.
- Windows EXE와 blockmap을 R2에 올리고 공개 파일 전체 SHA-256 검증 후 `latest.yml`을 게시했다. feed HTTP 200, no-store, EXE 단일 Range HTTP 206 확인.
- Mac arm64/x64 DMG: `357f45f`의 ad-hoc 설정, 앱 소스는 최초 snapshot `f6888aa`. 두 DMG의 이미지 무결성, 내부 codesign 검증, 공개 전체 SHA-256 검증 완료. Mac arm64 시작/계정 화면 확인. Intel 실행은 미검증.
- 홈페이지에 Windows/Apple Silicon/Intel 다운로드와 미서명 설치 안내를 공개했다. Chrome 자동화 클릭은 ERR_BLOCKED_BY_CLIENT였으며 다운로드 관리 페이지 접근도 브라우저 정책이 차단했다. 공개 HTTPS 다운로드 검증과 브라우저 클릭 완료 여부를 구분한다.
- Windows 10/11 실기기, 실제 버전 간 자동 업그레이드, 전체 실제 AI CLI 로그인/번역 동작은 이번 배포에서 검증하지 않았다.

### 배포 파일 SHA-256

```text
2f4e80ee1b26bd154841508a363e6d19f720ccbfa4bc3626452d9a18663d68ac  Munhae-Studio-0.1.0-x64-setup.exe
ce3413f4b29d01ff8ad7e3ea745cdcbb84d9df690d637efecdd9ee87d3c5053f  Munhae-Studio-0.1.0-x64-setup.exe.blockmap
806e8dcbae2fc98329ea8534f2fb23ce9285d3eb4d64c08da65696b5cbe42006  latest.yml
41f3a667247a3cdb63f1fcd5936a64a5de50be6ff01588dbcf29aceec14db62b  Munhae Studio-0.1.0-arm64.dmg
722db7c7c73d55940cdf17525823db6b50ada5a68e70e2690c015826545fd593  Munhae Studio-0.1.0-x64.dmg
```
