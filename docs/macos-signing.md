# macOS 서명 및 공증

`pnpm dist:mac:signed`는 로컬 키체인의 Developer ID Application 인증서로
DMG/ZIP을 서명하고 Apple 공증을 받는다. Apple Developer Program 멤버십이 필요하다.
기존 `pnpm dist`는 미공증 미리보기 설정을 사용한다.

## 최초 준비

1. Xcode → Settings → Accounts에 유료 Apple Developer 계정을 추가한다.
2. 해당 팀 → Manage Certificates → `+` → **Developer ID Application**을 생성한다.
   Apple Development / Apple Distribution / Developer ID Installer와 다른 인증서다.
   조직 계정에서 생성 권한이 없다면 Account Holder가 생성해야 한다.
3. 아래 명령으로 인증서와 개인 키가 함께 있는지 확인한다.

```sh
security find-identity -v -p codesigning
```

4. [Apple 계정](https://account.apple.com/)에서 앱 암호를 생성하고,
   아래 명령의 대화형 입력으로 Apple ID, 인증서의 Team ID, 앱 암호를 입력한다.
   암호는 채팅이나 저장소에 입력하지 않는다.

```sh
xcrun notarytool store-credentials munhae-notary
```

공증 자격 증명은 키체인에 저장된다. 다른 프로필을 사용할 경우
`APPLE_KEYCHAIN_PROFILE`을 지정한다. 기본 프로필은 `munhae-notary`다.

## 확인 및 빌드

```sh
pnpm dist:mac:signed --check
pnpm dist:mac:signed --arm64
pnpm dist:mac:signed --x64
```

인증서가 여러 개면 `MUNHAE_MAC_SIGNING_IDENTITY`에 정확한 인증서 이름 또는
SHA-1을 지정한다. 기본 아키텍처는 현재 Mac의 아키텍처다. Intel 빌드의
네이티브 모듈과 실행은 별도로 확인해야 하며, 가능하면 Intel Mac에서 빌드한다.

빌드 전에 실제 인증서와 Apple 공증 인증을 확인하고, 없거나 실패하면 중단한다.
서명 빌드는 Hardened Runtime과 Electron JIT 권한을 사용하며, 공증 자격 증명이
없을 때 미공증 파일을 성공으로 보고하지 않는다. 공증 후 앱의 서명, Team ID,
Hardened Runtime, 공증 티켓, Gatekeeper 판정과 DMG 무결성을 검증한다.

출력은 `apps/desktop/release/mac-signed/`이다. 기존 배포 파일과 섞이지 않으며,
이 명령은 서버 업로드나 공개 배포를 하지 않는다. `publish-macos.mjs`는 기존
`release/` 경로를 읽으므로 이 새 경로를 자동으로 업로드하지 않는다.

배포 전 실제 DMG에서 설치·실행 및 주요 작업 흐름을 확인해야 한다.
서명·공증 검증 통과만으로 앱 기능 검증이 완료되지는 않는다.

## 오래 걸리는 공증 작업 재개

Apple에 앱 ZIP이 이미 접수됐고 서명된 앱이 출력 폴더에 그대로 남아 있다면,
기존 빌드 명령을 종료한 뒤 해당 Submission ID로 이어서 실행할 수 있다.
이 명령은 앱을 다시 제출하지 않고 기존 접수 결과를 기다린다. 승인 후 앱에
공증 티켓을 첨부하고 DMG/ZIP 생성 및 최종 DMG 공증·검증을 이어간다.

```sh
pnpm dist:mac:signed --arm64 --resume-app-job=SUBMISSION_UUID
```

공증 중에는 같은 출력 폴더의 앱을 교체하거나 다른 빌드를 동시에 실행하지 않는다.
재개 모드의 결과는 `notarization-app-arm64.json`, `notarization-dmg-arm64.json`,
`SHA256SUMS-arm64.txt`로 남는다. SHA256SUMS는 모든 검증이 성공한 뒤 생성된다.

참고: [Apple Developer ID](https://developer.apple.com/developer-id/),
[인증서 발급](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/),
[electron-builder macOS 설정](https://www.electron.build/v26/docs/mac/).
