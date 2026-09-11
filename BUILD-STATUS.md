# Munhae 0.1.1 unsigned preview

Release candidate based on 0.1.0 snapshot d8d5695, with only the Antigravity integration and AI waiting-status changes from the original checkout.

- Antigravity available in translation preparation.
- Distinguish recovered authentication, timeout, and native tool permission errors.
- Allow up to 30 minutes; quiet periods show waiting status instead of canceling by default.
- Antigravity punctuation requests explicitly approve the native tool loop.
- Windows x64 and macOS arm64/x64 installers remain unsigned previews (Mac ad-hoc signed).

CI builds and validates both platforms before publishing immutable files and finally promoting the Windows update feed. Website download links follow public file verification.
