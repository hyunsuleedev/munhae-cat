# Sidebar HTML demo verification

Date: 2026-09-22

final result: passed

## Scope and visual sources

The user requested an interactive HTML demo of the three previously generated sidebar concepts. This is a standalone comparison, not an application change or a pixel-for-pixel recreation of the surrounding editor. There are no dependencies, production API calls, credentials, or changes to real project data. The document bodies are a static contextual preview; sidebar operations use in-memory sample data. Reload or “처음으로” resets the demo.

Preview: http://localhost:3188/sidebar-demo/

Source visual truth, in displayed order:

1. `/Users/hyunsulee/.codex/generated_images/01a0c825-e6b4-70d2-9a5a-bc1da1ee1261/exec-3f9d90f3-1bcc-4473-8478-29afc7ed6846.png`
2. `/Users/hyunsulee/.codex/generated_images/01a0c825-e6b4-70d2-9a5a-bc1da1ee1261/exec-032c6030-2445-4733-b1ba-3dbff06a02b6.png`
3. `/Users/hyunsulee/.codex/generated_images/01a0c825-e6b4-70d2-9a5a-bc1da1ee1261/exec-5a57bede-7711-4707-85cc-fe58dd4bc679.png`

Implementation evidence:

- `evidence/compare.png`: all three interactive sidebars at the initial document and expansion states.
- `evidence/editor-project.png`: the second variant in the full editor preview.
- `evidence/visual-comparison.png`: all three source and implementation sidebar regions rendered beside one another in one browser capture. This is the visual comparison input, not six separately viewed screenshots.

Viewport: 1373 × 817 CSS pixels. Browser-reported devicePixelRatio: 2.190890312194824. Captures: 3008 × 1790 pixels. Source images: 1625 × 968, 1625 × 968, and 1626 × 967 pixels. The comparison board displays every full image at 1373 CSS pixels wide before clipping the sidebar region; each paired crop is displayed at 0.8 scale. Sidebar design width is 224 CSS pixels; the comparison frame reserves about 2 pixels for its outer border. Typography is not stretched. The demo comparison shell intentionally reduces sidebar height; footer vertical placement is therefore assessed against the demo viewport, not the taller source image.

State: light theme, original two documents, first document selected, all branches expanded in variant 1, only the selected document expanded in variants 2 and 3. The project root is represented above search in variant 2. No filtered results or open menus in the final captures.

## Findings and corrections

No actionable P0, P1, or P2 findings remain for the requested desktop demo.

| Before | After | Reason |
| --- | --- | --- |
| Initial two-line titles could break inside Korean words. | `word-break: keep-all` with overflow handling for exceptionally long words. | Keeps 관서악부서 and 프롬프트 readable while preserving exact titles. |
| Project menu inherited an opposing left inset. | Explicit `left: auto; bottom: auto` with a right-aligned position. | The menu is visible at the project title's trailing edge. |
| The first visual comparison showed navigation text smaller than the reference. | Document and navigation labels use 13px; footer labels use 12px. | Makes the hierarchy and long titles readable at actual desktop scale. |

Comparison history:

1. Initial live comparison captured at `/tmp/munhae-sidebar-demo-compare.png`. Found the Korean word wrapping and project-menu positioning issues above; corrected them before functional verification.
2. Opened the full editor capture and a combined source/implementation sidebar comparison. Increased the navigation and footer text sizes.
3. Captured the revised comparison and full editor, then reloaded and captured the combined comparison board. Confirmed corrected word wrapping, visible project menu, readable 13px labels, preserved concept differences, and visible footer controls. The files under `evidence/` contain the final state.

## Required fidelity surfaces

- Fonts and typography: existing system Korean sans for navigation, existing serif family for 文解 and the source text. Variant 1 deliberately truncates single-line titles; variants 2 and 3 wrap at word boundaries. Brand and context labels retain separate emphasis.
- Spacing and layout rhythm: matched narrow sidebar width, fixed action gutter, 34px base row rhythm, two-line document rows where appropriate, consistent icon alignment. Comparison controls sit outside the simulated application. No document-level horizontal overflow at the tested desktop viewport.
- Colors and tokens: uses the live application's paper, sidebar, ink, sage selection, and brown accent values. Variant 3 uses a quiet white selected surface and brown left edge; the other variants use the sage selection fill.
- Image and asset fidelity: no raster artwork is needed for the interactive UI. Brand text and outline icons are reused from the existing application and prototype sources, not approximated from generated raster glyphs. Source images are used only for QA comparison.
- Copy and content: real supplied project and document names are preserved. Context, home, materials, account, and settings views provide local demo navigation. The central term view is deliberately simplified because the requested comparison concerns the sidebar.

## Interaction verification

51 browser DOM/event checks passed across the three variants:

- Comparison/full editor switching; correct visible variant.
- Matching search, no-results state, and clearing search.
- Root collapse/expand where the root appears in the tree.
- Document selection updates the selected row and editor title/content.
- Menu opening, viewport bounds, rename dialog, and renamed text.
- Context navigation with selected state.
- Local document creation and corresponding home list.
- Settings text size, translation-material navigation, and account navigation.
- Width slider, separator arrow-key handler, double-click reset, and resetting all sample data.

Also exercised through the browser's click/fill/hover tools: variant switching, search, clearing search, document selection, overflow menu, rename dialog, and cancel. The selected title's bounding rectangle was identical before and after hovering the overflow button.

Console messages after the exercised flows: none. Inline JavaScript syntax check: passed. Whitespace check: passed.

Verification limits: the native keyboard tool returned a receipt but did not deliver a keydown event to this tab; keyboard resize was checked through the real DOM event handler instead. Physical pointer dragging and narrow/mobile layouts were not separately exercised. No production Electron integration is claimed for this standalone HTML demo.

## Implementation checklist

- [x] Three distinct sidebars, using the same sample documents.
- [x] Side-by-side and full editor views.
- [x] Functional core navigation, search, context, local menus, add and rename.
- [x] Adjustable width with reset and accessible separator semantics.
- [x] No production data writes or application changes.
- [x] Browser-rendered visual comparison and interaction verification.
- [x] Local preview left open for the user.

Follow-up polish: none required before reviewing the concepts. Choosing a production direction and integrating it into the actual Electron shell is outside this demo request.
