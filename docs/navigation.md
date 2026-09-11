# Page navigation

Work screens remain separate HTML documents. Their module state, event listeners,
AI subscriptions, and unsaved-change guards still follow document lifetime.
Navigation does not remount these modules in a shared SPA.

`page-transition.ts` keeps Chromium's outgoing root snapshot visible until
`AuthGate` has received the main-process account state and the incoming page's
module/data initialization has finished. `reveal()` exposes the ready DOM and
then skips the held transition. Shared navigation therefore stays in place
visually, without cross-fades, blank frames, or DOM screenshots in storage.

The transition's old image uses a paused, constant-opacity CSS animation. This
works with Electron 37 / Chromium 138; it does not depend on the newer
`ViewTransition.waitUntil()` API. `blocking="render"` makes the incoming event
listener available before first paint; it does **not** wait for async page boot.
The renderer's Vite post-transform restores this attribute because bundling
otherwise drops it from generated module script tags.

Settings boot waits for local configuration and project data, while CLI probing
continues in the background. Cached agent results or an explicit checking state
appear immediately; a late cache response cannot overwrite a fresh probe.

Authentication remains independent from the visual transition:

- Protected HTML starts hidden. Only an authenticated, initialized page is revealed.
- Authentication or module errors release the held image to the existing gate.
- Account/recovery/external navigation does not retain a work-screen snapshot.
- After 1.5 seconds the image yields to loading feedback; timeout never reveals
  protected content. Browsers without a transition use normal gated loading.
- BFCache restoration reads the current main-process session again. Existing
  `beforeNavigate` / `beforeunload` checks continue to protect unsaved work.

Verification artifacts are in `output/navigation-qa/` (local, not a release):

- `probe.mjs` / `probe.json`: actual Electron dev renderer, normal sidebar click,
  a 700ms module delay, and frame capture without recording API response bodies.
- `file-check/`: actual production renderer assets under `file://` in an isolated
  Electron profile, with synthetic read-only account/project responses. Covers
  delayed auth, timeout, failures, settings, and sign-out. This is renderer QA,
  not a real account-provider or main-process integration test.
- Actual Orca editor → context → settings → back/forward → home → editor flow
  also checked against the running Electron bridge.

Focused checks: desktop typecheck/build and 70 passing tests across `page-transition`, `auth-gate`,
`browser-auth-events`, `quit-window-preflight`, and `editor-mutation-guards` tests.

References: [Chrome cross-document transitions](https://developer.chrome.com/docs/web-platform/view-transitions/cross-document),
[CSS transition lifetime](https://drafts.csswg.org/css-view-transitions-1/#handle-transition-frame-algorithm),
[HTML script execution](https://html.spec.whatwg.org/multipage/scripting.html#execute-the-script-element).
