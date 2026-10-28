<p align="center">
  <img src="apps/desktop/build/icon.png" alt="Munhae — an open book" width="112" height="112">
</p>

<h1 align="center">Munhae Studio · 문해 文解</h1>

<p align="center">
  <a href="README.md" lang="ko">한국어</a> · <strong>English</strong>
</p>

<p align="center">
  <strong>Read the source. Refine the translation. Keep the evidence.</strong><br>
  A desktop workspace for reading, translating, and annotating Classical Chinese texts.
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#getting-started">Getting started</a> ·
  <a href="#development">Development</a> ·
  <a href="#documentation">Documentation</a> ·
  <a href="#license">MIT License</a>
</p>

Munhae is a **computer-assisted translation (CAT) tool** for translators and researchers working with Classical Chinese texts, with a focus on the Korean scholarly tradition. Review source texts, punctuation, and translations side by side; consult dictionaries and reference materials; and keep passage annotations and terminology decisions in one project.

Projects live on your computer as `.munhae` folders containing a SQLite database and attached files. Translate manually or connect an AI CLI to generate drafts and analyses. AI-generated content remains available for review and revision alongside the source text and supporting references.

> **Current status:** This desktop app is under active development. The current build **requires a Munhae account to access the workspace**. Development focuses on local projects; online projects, invitations, and collaboration are on hold.

## Features

| Task | What you can do |
| --- | --- |
| Source text and punctuation | Organize texts into folders and documents. Enter or import text, add and confirm punctuation, and attach images or PDFs as reference materials. |
| Translation and alignment | Write a full translation, then link its sentences to source passages. Switch between sentence comparison and book views, and adjust the links manually. |
| Terminology review | Review, edit, and confirm document terms. Record readings, translations, meanings, and alternative interpretations, alongside a shared project glossary. |
| Dictionaries and passage study | Look up Korean readings and glosses, radicals, stroke counts, and character variants in the built-in Hanja dictionaries. Record readings, selected dictionary senses, and reading order for individual passages. |
| Context and comments | Attach translation guidelines and background materials to documents or folders. Leave comments on specific passages in the source or translation. |
| Review and history | Search previous translations within a project, check unlinked passages and terminology inconsistencies, and inspect the history and confirmation status of source texts, punctuation, and translations. |
| Backup and export | Back up and restore projects as `.munhaepkg` archives. Export translations to Word, PDF, plain text, or Markdown, and produce review copies with comments. |

The interface supports Korean and English. A [local Model Context Protocol (MCP) connection](docs/local-mcp.md) for reading and editing the open project from external AI tools is also in development.

## Translation workflow

1. **Prepare the source.** Create a project and document, then save the source text. Add bibliographic details, images, or PDFs as needed.
2. **Read and gather context.** Add punctuation and review dictionaries, terminology, and reference materials. Confirm punctuation before generating or confirming document term candidates.
3. **Translate and align.** Write a translation yourself or request an AI draft of the full document. Save the translation, then link it to source passages in a separate step. You can also start translating directly from a saved source text without adding punctuation first.
4. **Review and share the result.** Check the translation, alignment, and comments, then confirm the translation. Back up your work or export a translation or review copy.

Translation generation and source alignment are separate operations. If alignment fails, the saved translation remains intact and you can retry alignment alone. Confirming a translation or its alignment records a review decision; it does not automatically establish scholarly accuracy.

See [full-document translation and alignment](docs/full-text-translation.md) and the [translator workbench](docs/translator-workbench.md) for details.

## Getting started

### Run from source

You need **Node.js 22.12 or later** and **pnpm 10**. The repository specifies `pnpm@10.15.0` in its `packageManager` field.

```sh
git clone https://github.com/hyunsuleedev/munhae-cat.git
cd munhae-cat
pnpm install --frozen-lockfile
pnpm --filter @munhae/desktop rebuild:native
pnpm dev
```

`pnpm dev` launches the Electron app and development server together. Sign in with a Munhae account, then create a project. When there are no recent projects, the welcome screen offers a **Hunminjeongeum demo** containing source text, punctuation, and a draft translation.

The source currently connects to the official Munhae account service. Running a separate authentication service requires changes to the account configuration and server setup; there is no in-app server selector. See [account implementation and configuration](docs/accounts.md).

### Connect an AI tool

To use AI features, **install one of the following CLIs separately and sign in through that CLI**. Your Munhae account and AI provider account are separate. Model access and costs follow the provider's terms. Manual editing and built-in dictionary lookups do not require an AI CLI.

| Provider | Executable |
| --- | --- |
| Codex | `codex` |
| Claude Code | `claude` |
| Antigravity CLI | `agy` |

In **Settings → Models & providers**, check the installation and sign-in status, then choose a model. Available models and capabilities depend on the installed CLI version. See the [Antigravity guide](docs/antigravity-cli.md) for its connection details.

### Data storage and external services

- **Local projects:** Source texts, translations, terms, and comments are stored in the project's SQLite database. Attachments live in its `assets/` directory. A `.munhae` project is a working folder; a `.munhaepkg` file is an archive for backup or transfer.
- **AI requests:** The CLI runs on your computer, but selected source texts, translations, and context may be sent to the AI provider's service. Local file storage does not mean that AI inference runs offline.
- **Dictionaries:** Built-in dictionaries work without a network connection. Online dictionary and footnote searches send queries to the selected external service. The National Institute of Korean Language APIs require a separate API key.
- **Accounts:** Munhae sign-in uses the official authentication service. Account sessions and dictionary API keys are managed outside project files.

See [local storage](docs/local-storage.md) for the storage model and the [dictionary guide](docs/dictionary.md) for sources and connection requirements.

## Development

Munhae is an Electron and TypeScript application in a pnpm monorepo. The desktop interface uses HTML, CSS, and TypeScript; SQLite access uses `better-sqlite3` and Drizzle.

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Run the development app |
| `pnpm typecheck` | Check TypeScript across the workspace |
| `pnpm test` | Run package tests |
| `pnpm build` | Build the app |
| `pnpm run pack` | Package the app directory without an installer |
| `pnpm dist` | Generate distribution files for the current platform |

Tests that connect to real AI providers or online services need additional configuration and explicit execution conditions. Passing the default tests does not replace checks of real sign-in, model execution, or packaged installations.

<details>
<summary>Troubleshooting Electron and SQLite installation</summary>

If the Electron binary was not downloaded, run this from the repository root:

```sh
pnpm --filter @munhae/desktop exec node node_modules/electron/install.js
```

If `better-sqlite3` fails to load or reports a `NODE_MODULE_VERSION` mismatch, rebuild the native module for the app's Electron runtime:

```sh
pnpm --filter @munhae/desktop rebuild:native
```

Compiling native modules from source may require your operating system's C/C++ build tools and Python. The database package's test runner uses Electron's Node runtime, so do not replace its SQLite binary with one built for the system Node runtime.

</details>

### Repository structure

| Path | Purpose |
| --- | --- |
| `apps/desktop` | Electron main process, preload, UI, accounts, AI integration, and export |
| `packages/domain` | Shared types, errors, identifiers, and text-position utilities |
| `packages/project-format` | The `.munhae` project format and backups |
| `packages/db-sqlite` | Project storage, search, version history, and translation operations |
| `packages/agent-runtime` | AI CLI detection, execution, and response handling |
| `infra/migrations` | Local SQLite migrations |
| `supabase` | Server functions, migrations, and the official service's plugin catalog |
| `scripts` | Data generation, service checks, and release tools |
| `docs` | Feature guides and implementation documentation |
| `proto` | Early UI experiments and design prototypes |

### Packaging

Build artifacts are written to `apps/desktop/release/`. The packaging configuration includes DMG and ZIP targets for macOS, an NSIS installer for Windows x64, and AppImage for Linux. A configured target does not establish that installation, runtime behavior, or signing has been verified on that operating system.

The standard `pnpm dist` command is separate from the signing, notarization, and publishing process for official releases. See [macOS signing and notarization](docs/macos-signing.md) and [Windows distribution and updates](docs/windows-release.md).

## Current scope and next steps

Development currently focuses on local reading, translation, review, and export.

- **Online projects and collaboration:** Disabled by a feature flag. Existing code and server migrations remain in the repository, but do not track the latest local schema. See the [paused status and requirements for resuming work](docs/online-projects.md).
- **Local MCP:** Project reading and editing tools are implemented. CLI connection, UI refresh, and access control still have outstanding work. See the [implementation status](docs/local-mcp.md).
- **Document interchange:** HWPX, TMX, glossary TBX/CSV interchange, and importing edits from bilingual DOCX files are future work. See [export formats](docs/translation-export.md).
- **Source acquisition:** OCR, image-region recognition, and automatic transcription are outside the current scope.

`plan.md` and some design documents retain early plans and descriptions of older behavior. Start with this README and the latest implementation notes in each document when checking current capabilities. `proto/` is not a specification of the running product.

## Documentation

The detailed guides linked below are currently written in Korean. This English README covers the project overview and setup; the linked guides have not yet been translated.

| Topic | Guides |
| --- | --- |
| Translation | [Full-document translation and alignment](docs/full-text-translation.md) · [Translator workbench](docs/translator-workbench.md) |
| Research | [Hanja and vocabulary dictionaries](docs/dictionary.md) · [Passage study](docs/reading-study.md) · [Terminology review](docs/term-review.md) |
| Materials and output | [Reference materials and context](docs/translation-materials.md) · [Translation export](docs/translation-export.md) |
| Storage and connections | [Local storage](docs/local-storage.md) · [Accounts](docs/accounts.md) · [Local MCP](docs/local-mcp.md) |
| Design background | [Product plan](plan.md) · [Data model](schema.md) · [Design decisions](docs/decisions.md) |

## Contributing

Bug reports, examples from real translation work, documentation improvements, and code contributions are welcome.

- **Bug reports:** Include your operating system, app version, reproduction steps, expected behavior, and actual behavior. For AI connection issues, include the CLI name and version.
- **Feature requests:** Describe the text you were working with, your workflow, and where you got stuck. A short example you have permission to share helps.
- **Code contributions:** Discuss major architectural or storage-format changes in an issue first. Explain the reason for the change and what you verified in your PR, and run relevant tests and type checks.
- **Documentation:** Keep the [Korean README](README.md) and this English README in sync when features, setup instructions, or supported workflows change.

Do not include unpublished research, personal information, or credentials in reports or example projects. When contributing texts, dictionaries, images, or audio, include their sources and redistribution terms.

## License

Original Munhae application code is distributed under the [MIT License](LICENSE). Commercial use, modification, and redistribution are permitted, provided the copyright and license notices are retained.

Third-party code, data, and assets remain subject to their own terms. The MIT license does not replace the licenses of the materials below.

| Material | Terms and attribution |
| --- | --- |
| libhangul Hanja data and the adapted Korean Wiktionary dataset | [BSD-3-Clause, CC-BY-SA-4.0, and source notices](apps/desktop/src/main/data/hanja-NOTICE.txt) |
| Unicode Unihan character properties | [Unicode License V3 and source notices](apps/desktop/src/main/data/hanja-Unihan-NOTICE.txt) |
| AnimCJK character assets | [Terms by file type](apps/desktop/src/renderer/public/licenses/animcjk/COPYING.txt) · [Arphic Public License](apps/desktop/src/renderer/public/licenses/animcjk/ARPHIC-LICENSE.txt) |
| Background music | [CC BY 4.0 and attribution](apps/desktop/src/renderer/public/music/LICENSE.txt) |
| Notification sound | [Korea Open Government License Type 1 and modification notes](apps/desktop/src/renderer/public/music/NOTIFICATION-LICENSE.txt) |

Texts, translations, and reference materials you import remain subject to their respective rights and terms.
