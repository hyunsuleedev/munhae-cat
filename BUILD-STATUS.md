# Munhae 0.1.2 unsigned preview

Based on published 0.1.1 source, with additional Antigravity JSON envelope handling and reading-study dictionary sense selection/display improvements.

Original staged working tree preserved; six changed implementation/test files copied to this isolated release checkout.

Windows x64 and Mac arm64/x64 retain existing unsigned preview distribution. CI checks and packaged startup tests must pass before R2 publication; public hashes are verified before Windows feed promotion.

## Published 2026-09-11

- Source 012a7a3; Actions run 34586218259: all build, validation and publication jobs passed.
- Windows: 74 agent-runtime tests passed, 6 skipped; 34 desktop tests passed; installed EXE startup/preload verified on Windows Server 2022.
- Mac: arm64/x64 DMGs and internal signatures verified; arm64 packaged startup/preload verified. Intel runtime not verified.
- R2 immutable artifacts fully hash-verified through public HTTPS before Windows feed promotion to 0.1.2.
- Website: Hyunsulock/munhae-web 567a922, deployment munhae-q6j69nowd-hyunsulocks-projects.vercel.app.
- Windows 10/11 physical-host testing and an actual previous-version updater installation remain unverified.
