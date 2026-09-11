# Munhae 0.1.3 unsigned preview

Based on published 0.1.2. Removes the unconditional ellipsis between linked source passages in sentence comparison; all linked passages remain visible, separated by a space. Unused gap CSS removed.

Actual development Electron view verified with the two linked passages in sentence 28. Existing Windows/Mac build, integrity, packaged startup and public hash checks gate publication.

## Publication results

- Release source: 643c538. Actions run 34592211766 passed Windows, Mac and publication jobs.
- Initial run 34591610792 was canceled after Mac smoke passed but its process cleanup hung; smoke harness now terminates its isolated process tree.
- R2: Windows EXE/blockmap, arm64/x64 DMGs and Windows latest.yml published with full public artifact hash verification. Feed version confirmed as 0.1.3.
- Packaged startup verified on Windows Server 2022 and arm64 macOS; Intel runtime and actual previous-version updater installation remain unverified.
- Website download source: Hyunsulock/munhae-web commit 285f796.
