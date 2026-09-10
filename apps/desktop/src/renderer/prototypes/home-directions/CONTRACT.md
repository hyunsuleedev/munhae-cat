# Project home design studies

Standalone mock data only. No app entry, database API, external network, or persistence.

All variants import from `./shared.js`:

```js
import { getDemo, mountShell, badge, progress, docButton, esc } from './shared.js';
const demo = getDemo();
mountShell('01-atlas', '<main class="your-main">...</main>');
```

`getDemo()` returns `{scenario, project, docs, chapters, stats, recent, issues}`.
`project`: `{title, subtitle, description, period, scope}`.
`docs`: array `{id,title,ko,chapterId,chapter,stage,stageLabel,source,punctuation,translation,confirmed,needsReview,uncertainties,updated,excerpt,translationExcerpt}`. `stage` is source/punctuation/draft/review/confirmed. Booleans define actual completion flags.
`chapters`: array `{id,title,subtitle,docs,confirmed}`.
`stats`: `{total,source,punctuation,translation,confirmed,review,uncertainties}`.
`recent`: array `{docId,title,action,when}`.
`issues`: array `{docId,title,body}`.
Query `?scenario=single|full|large|empty`, default full. All statistics computed from fixtures, not hardcoded.

`mountShell(designId, html)` inserts your main HTML inside a common sidebar/titlebar shell, and wires shared document preview and project context dialogs. It does not rerender your page afterward. Use document-level delegated listeners for dynamic content. Supported buttons:
- `<button data-doc="d1">...</button>` opens the in-memory document preview.
- `<button data-panel="context|library|notes|project|add">...</button>` opens an informative mock panel.
- `docButton(doc, label='미리보기', className='btn')` generates a document preview button.
- `badge(doc)` produces accessible stage label; `progress(done,total)` produces a slim semantic progress meter.
- `esc(text)` escapes HTML.

Link `./base.css` before variant CSS. Shared CSS: `--paper`, `--surface`, `--ink`, `--muted`, `--line`, `--accent`, `--accent-soft`, `--green`, `--serif`; `.btn`, `.btn.primary`, `.eyebrow`, `.muted`, `.serif`, `.tag`, `.empty-state`, `.section-heading`, `.progress-meter`, `.mono`. Main host `.page-content`, shell `.app-shell`, sidebar 188px desktop / 160px under 1050 / hidden under 720. Topbar 52px. Main scroll is browser document scrolling.

Do not add implementation details inside the mock product. The shared topbar labels all screens as illustrative data. No emoji or external fonts. Use refined typography, line icons/inline SVG as needed, consistent warm neutral palette; prioritize distinct information hierarchy over color variation. Responsive at 1440,1280,1024,768,390. All actions must either change local UI, open a preview, or use a native disclosure. No inert dummy links.
