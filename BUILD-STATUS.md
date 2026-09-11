# Munhae 0.1.1 unsigned preview

Release candidate based on 0.1.0 snapshot d8d5695, with only the Antigravity integration and AI waiting-status changes from the original checkout.

- Antigravity available in translation preparation.
- Distinguish recovered authentication, timeout, and native tool permission errors.
- Allow up to 30 minutes; quiet periods show waiting status instead of canceling by default.
- Antigravity punctuation requests explicitly approve the native tool loop.
- Windows x64 and macOS arm64/x64 installers remain unsigned previews (Mac ad-hoc signed).

CI builds and validates both platforms before publishing immutable files and finally promoting the Windows update feed. Website download links follow public file verification.

## Published 2026-09-11

- Source: de50061, release/installers-20260911.
- Actions run 34583880601: Windows, Mac, publication all succeeded.
- Windows: 59 agent-runtime tests passed (6 skipped), 25 desktop tests passed, NSIS install and packaged renderer/preload smoke passed on Windows Server 2022.
- Mac: both DMGs and app signatures verified; arm64 packaged renderer/preload smoke passed. Intel execution not verified.
- R2: both DMGs, Windows EXE/blockmap and latest.yml published; publisher verified full public artifact hashes before promoting the feed.
- Windows public feed verified as 0.1.1. Mac remains manual DMG installation.
- Website: Hyunsulock/munhae-web b1ec531, production deployment munhae-mfijp67r2-hyunsulocks-projects.vercel.app, domain munhaestudio.com.
- Windows 10/11 physical-host testing and actual 0.1.0-to-0.1.1 updater installation are not verified.
