[简体中文](README.md) | [English](README_EN.md)

# Ondra (空谷)

**A plugin-first desktop AI companion: the UI only reads state projected by plugins, while emotion, memory and context are the three core mechanisms, and all data stays on this machine.**

![Status](https://img.shields.io/badge/status-alpha-fb8500?style=flat-square)
[![Version](https://img.shields.io/badge/version-2.0.0--alpha-8957e5.svg?style=flat-square)](#)
[![GitHub license](https://img.shields.io/github/license/ntars/Ondra?style=flat-square)](./LICENSE)
[![Flutter](https://img.shields.io/badge/Flutter-desktop-02569B.svg?style=flat-square&logo=flutter&logoColor=white)](https://flutter.dev/)
[![Local](https://img.shields.io/badge/data-local--only-2ea44f.svg?style=flat-square)](#)
[![Tests](https://img.shields.io/badge/tests-96%20passing-2ea44f.svg?style=flat-square)](#)

---

## 1. Name and Positioning

**Name**: 空谷 Ondra. The application name (window title, web title, about page) uses the full form; the UI brand block uses the short form 空谷 because the sidebar is only 200 wide.

**One-line positioning**: a desktop companion that breaks "companionship" into loadable plugins — the same plugin code runs on desktop and mobile, and data never leaves the machine.

**Repository description**: `空谷 Ondra —— 全插件式桌面 AI 陪伴体：Cordis 插件体系，情绪、记忆、上下文三大机制，数据全留本机 | A plugin-first desktop AI companion: Cordis plugins with emotion, memory and context, all data kept on your machine.`

**Topics** (20, English only): `ai-companion`, `virtual-companion`, `ai-persona`, `emotional-ai`, `affective-computing`, `digital-life`, `long-term-memory`, `plugin-architecture`, `plugin-system`, `cordis`, `llm`, `local-llm`, `local-first`, `privacy-first`, `text-to-speech`, `speech-recognition`, `flutter`, `dart`, `typescript`, `desktop-app`

| Item | Value |
|---|---|
| Version | 2.0.0-alpha |
| Status | Internal alpha: macOS builds and runs, web builds, Windows builds but the release package does not yet bundle the runtime |
| Platforms | macOS (runs) · Web (builds) · Windows (builds, in progress) |
| Repository | <https://github.com/ntars/Ondra> |
| License | Apache-2.0 / MIT (layered by directory) |

**No back end, no demo data.** The list shows exactly as many plugins as exist; memory, sessions, backups and logs show empty states when there is no source, never a set of plausible-looking sample rows.

---

## 2. Overview

### 2.1 Background

Most "AI companion" products are a chat box plus a persona prompt. The persona is re-described every turn, memory means stuffing history into the context window, and emotion is an adjective. None of them accumulate, and all reset with a new session.

### 2.2 The problem

Break companionship into **separately engineered mechanisms**: emotion as a state variable with inertia, memory as a pipeline, context as a budgeted assembly — and let third parties replace any of them as plugins.

### 2.3 Approach

The UI is a runtime client, not a plugin framework. There is exactly one plugin system (Cordis), and exactly one layer between UI and plugins: **projection**. Pages read projected state and never hold plugin internals.

### 2.4 Suitable for

- Local desktop companion apps whose data must not leave the machine;
- Architectures where third parties should be able to replace memory or emotion implementations;
- Reusing one plugin code base across desktop and mobile.

### 2.5 Not suitable for

- Multi-user accounts and cloud sync: data is local and there are no accounts;
- Turnkey public services: there is no back end;
- Full mobile experience: the three-column layout degrades to drawers on narrow screens, which is a non-goal.

### 2.6 Strengths and limitations

| Strength | Evidence |
|---|---|
| Everything is a plugin | Capabilities, pages and services all come from plugins; the core cannot be disabled but its implementations can be replaced |
| Data provably local | Routes through the local gateway `127.0.0.1:3425` by default, with no key and no external calls |
| Content-addressed backups | A second snapshot with identical content adds 0 bytes (measured locally) |
| Single UI exit | Pages never hard-code colours or sizes; everything comes from `lib/design/` |
| Honest empty states | With no data it says "emotion has not settled yet", not "waiting for a data source" |

| Limitation | Scope | Mitigation |
|---|---|---|
| Sandbox disabled on macOS | Cannot ship on the Mac App Store | Distribute a `.dmg` directly; documented in README and build script |
| No subprocess on web | The right pane cannot reach the local kernel and says so | Use the desktop build |
| Narrow screens are a non-goal | iOS / Android degrade to drawers | Preview targets only |
| Keychain write not implemented | Model keys come from environment variables | Inject `DEEPSEEK_API_KEY` / `MAGPIE_API_KEY` |

---

## 3. Core Features

| Feature | Trigger | Result |
|---|---|---|
| Three-column shell | Launch | 200 sidebar + 480 content + 280 chat, 960×600 content area |
| Right-pane chat | Send a message | Spawns `dsh --profile ondra`, JSON-RPC over stdio, routed to the local gateway |
| Plugin page | Open "Plugins" | Merges 18 bundled entries with 75 from the assembly layer; toggles apply on next kernel connection |
| Memory map | Open "Memory" | Reads `memory_fact` / `memory_link` from `~/.ondra/user/ondra.db`, laid out deterministically by id hash |
| History | Open "History" | Reads the kernel session store, titles from the first user message, newest activity first |
| Backups and timeline | Open "Backups" | Content-addressed snapshots; the timeline takes the window, wheel / arrow keys to travel, `⏎` restore, `esc` exit |
| Memory import/export | Open "Transfer" | Exports Markdown / JSON, imports really write to the database with id + text dedup |
| Status panel | Open "Status" | Three vitals, two emotion axes, three logs, gateway probe, kernel assembly check |
| Local deployment | Settings → "Model base" | Finds `llama-server`, downloads GGUF, starts/stops it, polls `/v1/models` |
| Web browsing | Allow-listed open request | System WKWebView platform view, no sidebar entry |

---

## 4. Core Characteristics

### 4.1 Everything is a plugin

The UI implements no capability. `ondra-core/` ships by default and cannot be disabled, `ondra-extensions/` can be toggled, `ondra-custom/` is user-installed; `cordis/` is the host, not a plugin.

### 4.2 Emotion is a state variable, not an adjective

Emotion carries inertia: the previous turn influences this one instead of being re-described. The two axes show settled values, and with no data they say "not settled yet".

### 4.3 Memory is a pipeline, not a vector store

Capture, distillation, deduplication, decay, recall and injection are one chain; every link is a separate plugin that can be replaced or disabled.

### 4.4 Context has a budget

Frozen prefix + incremental injection + budget packing. Reassembling the system prompt every turn multiplies cost, and freezing the prefix is the answer for the cost-sensitive part.

### 4.5 Content-addressed backups

`~/.ondra/backups` holds an object store and snapshot manifests only. Identical content is stored once: 32 files / 437 KB locally, with a second snapshot adding 0 bytes.

### 4.6 Boot-order self-healing

The kernel's thirty-odd plugins turn "unavailable" when a dependency is missing, and the loader applies them concurrently. `ondra-boot-settle` restarts the ones that raced ahead once dependencies are truly ready: measured startup degradation went **55 → 0**.

---

## 5. Design Details and Engineering Trade-offs

The full reasoning lives in [docs/design-notes.md](docs/design-notes.md) (Chinese); key decisions:

| Decision | Rationale |
|---|---|
| No system title bar, content exactly 960×600 | Each column has its own header; a system title bar would make two. `frameRect(forContentRect:)` converts content size to frame to avoid 32pt shrinkage |
| Paper with radius 12 and a 4px gap | The 4px gap is the entire sense of translucency: desktop shows through the seam. The paper must be opaque or seam and surface blur together |
| Four right-pane states on one width track | Collapse / expand / enter immersion / leave immersion can reverse mid-flight; the collapsed pane stays in the tree to keep scroll position and drafts, with `ExcludeFocus` blocking the keyboard |
| Local gateway magpie by default | No external calls; `apiKeyEnv` must be non-empty or the manual route fails at credential resolution |
| Toggle plugins by editing YAML comments | The assembly layer is the kernel's only entry; writes keep a `.bak` and rename a temp file into place |
| Restore overwrites but never deletes | "Not in the snapshot" may mean it did not exist or was out of scope; a `preRestore` snapshot is taken first |
| Font not committed | The MiSans subset licence forbids modification and redistribution; it can be generated locally, otherwise the app falls back to system fonts |

---

## 6. Technology Stack and Dependencies

| Layer | Technology | Version constraint |
|---|---|---|
| UI | Flutter (desktop + web) | Dart SDK ^3.14.0 |
| Plugin framework | Cordis (`@deepseek-ai/cordis`) | 4.1.0, vendored, MIT |
| Kernel | dsh (`@deepseek-ai/dsh`) | Global install, subprocess JSON-RPC over stdio |
| Plugin source | TypeScript | Under `~/.ondra/dsh/profiles/ondra` |
| Local storage | SQLite (read via `/usr/bin/sqlite3 -json`) | No native package |
| Model gateway | magpie (OpenAI-compatible) | `127.0.0.1:3425` |
| Tests | `flutter test` | 96 cases |

Full third-party disclosure (including fonts and icons) is in [NOTICE](NOTICE).

---

## 7. Installation and Deployment

### 7.1 Requirements

| Item | Requirement | Purpose |
|---|---|---|
| Flutter | 3.32+ (Dart 3.14+) | Desktop and web builds |
| Xcode | Full install | macOS build |
| Node.js | 18+ | Kernel and plugins |
| llama.cpp | Optional, `brew install llama.cpp` | Local model deployment |

### 7.2 Install and run

```sh
git clone https://github.com/ntars/Ondra.git
cd Ondra && flutter pub get
flutter run -d macos
```

### 7.3 Direct download

Installers for all three platforms live in [Releases](https://github.com/ntars/Ondra/releases), with `SHA256SUMS.txt`:

| Platform | File | Notes |
|---|---|---|
| macOS (universal) | `Ondra-2.0.0-alpha-macos-universal.dmg` | One bundle for Intel and Apple Silicon |
| Windows (x64) | `Ondra-2.0.0-alpha-windows-x64.zip` | Unzip, then run `ondra.exe`; extract the whole folder |
| Android | `Ondra-2.0.0-alpha-android-arm64.apk` | Regular phones; `-universal.apk` adds 32-bit and emulators |

Verify with `shasum -a 256 -c SHA256SUMS.txt`. None of the three is properly signed; see the release notes for bypassing each OS prompt.

### 7.4 Build and distribute

```sh
# macOS: a universal binary (x86_64 + arm64) straight from this machine
flutter build macos --release
# → build/macos/Build/Products/Release/空谷 Ondra.app
ditto -c -k --norsrc --noextattr --keepParent "空谷 Ondra.app" Ondra-macos.zip
hdiutil create -volname "空谷 Ondra" -srcfolder "空谷 Ondra.app" -ov -format UDZO Ondra-macos.dmg

# Android: 18.6 MB for arm64 alone, 52.7 MB for every ABI
flutter build apk --release --target-platform android-arm64

# Web: static output, cannot reach the local kernel
flutter build web --release     # → build/web
```

`ditto` must use `--norsrc --noextattr`. `--sequesterRsrc` stuffs extended attributes into `__MACOSX/`,
which lands hundreds of `._*` leaf files on the unpacking side; WinRAR and some extractors then flag the archive as corrupt.

**Windows can only be built on Windows** (no MSVC cross-compilation), via `.github/workflows/release.yml`:
Actions → Release build → Run workflow, then grab `ondra-windows` from Artifacts.

Four hard constraints: App Sandbox off (needed to spawn a local subprocess), no native plugins, the GUI locates `dsh` itself, and a separate data directory (`DSH_HOME=~/.ondra/dsh`).

### 7.5 Upgrade and uninstall

Upgrade: replace the `.app`, leave the data directory alone. Uninstall: delete the app and `~/.ondra/` (sessions, memory, backups, logs) — irreversible, so export a backup first.

### 7.6 Containerisation

A desktop app is not containerised; the web build is static output that can be hosted anywhere, but cannot reach the local kernel.

---

## 8. Quick Start

```sh
flutter run -d macos            # desktop: can spawn dsh, the right pane really talks
flutter run -d chrome           # browser preview: no subprocess, the right pane reports it honestly
tool/dev.sh                     # dev preview on 9060 with hot reload (r / R / q)
```

To get real replies on desktop:

```sh
npm i -g @deepseek-ai/dsh       # kernel
export DEEPSEEK_API_KEY=sk-...  # model key
```

Expected result: the boot screen shows "空谷 · 记得住，也帮得上", then the three-column shell; ten sidebar items switch pages; the right pane returns text and usage after sending a message.

Debug parameters (web only): `?page=plugins`, `?settings=1`, `?boot=hold`.

---

## 9. Configuration

| Key | Type | Default | Required | Purpose |
|---|---|---|---|---|
| `DEEPSEEK_API_KEY` | env | none | yes for chat | Model key |
| `MAGPIE_API_KEY` | env | `local-loopback` injected by the app | no | Local gateway credential; empty breaks the manual route |
| `DSH_HOME` | env (injected into subprocess) | `~/.ondra/dsh` | no | Kernel data directory |
| `ONDRA_DSH_HOME` | env | none | no | Overrides `DSH_HOME` |
| `--dart-define` | build flag | none | no | Compile-time constants |

Locations: `~/.ondra/user/ondra.db` (memory), `~/.ondra/dsh/` (sessions and assembly), `~/.ondra/backups/` (snapshots), `~/.ondra/logs/transport.log`, `ondra-code.log`, `window.log`.

Hot update: plugin toggles take effect on the next kernel connection; a running process does not re-read YAML, and the UI says so.

---

## 10. API and Module Reference

| Interface | Form | Note |
|---|---|---|
| `plugin.json` | manifest | Fields: `id` / `layer` / `closable` / `owner` / `provides` / `depends` |
| Plugin id rule | naming | `ondra-` prefix with hyphens; Dart files stay snake_case |
| Injection | `ctx.inject([...], cb)` | Callback injection runs when all services are ready; plain `inject` does not block on unprovided services |
| Projection | `*_client.dart` | The only layer between UI and plugins |
| Module registration | `OndraModule` | One module = one sidebar item + one page, registered in `ondra-ui/ui/registry.dart` |
| Kernel protocol | JSON-RPC over stdio | Subprocess `dsh --profile ondra` with handshake and message stream |

---

## 11. Repository Layout

```text
Ondra/
├── lib/
│   ├── main.dart                 single entry: persona / plugin list → kernel → runApp
│   ├── app/                      root widget, window capability, version, debug port
│   ├── design/                   colours, radius, spacing, theme, page frame, primitives
│   └── plugins/                  every capability is a Cordis plugin
│       ├── cordis/               framework (4.1.0, vendored)
│       ├── dsh-base/             kernel
│       ├── ondra-core/           bundled, not closable (UI under ondra-ui/)
│       ├── ondra-extensions/     bundled, closable
│       └── ondra-custom/         user-installed
├── macos/                        native window entry (no title bar, 960×600)
├── assets/                       brand, personas, icons
├── docs/                         design-notes.md, platforms.md
├── tool/                         dev.sh, icons.sh, subset_font.sh, typecheck_plugins.sh
└── test/                         96 tests
```

---

## 12. Performance

Measured locally on macOS:

| Item | Result | Condition |
|---|---|---|
| Startup degradation entries | 55 → 0 | After `ondra-boot-settle`; 18 plugins restarted |
| Backup deduplication | second snapshot added 0 bytes | 32 files / 437 KB, identical content |
| Memory import dedup | two imports added 0, skipped 10 | 10 memories / 55 source passages |
| Tests | 96 passing | `flutter test` |
| Plugin loading | 75 / 76 | The one failure needs `node:net` port probing |

Not measured: frame rate, memory footprint, cold start. No numbers are published before benchmarks exist.

---

## 13. Security and Privacy

- **No external network by default**: chat routes through the local gateway `127.0.0.1:3425`.
- **Credentials excluded from backups**: `.credentials.yaml` is explicitly out of scope, as are `logs/`, `cache/`, `tmp/` and `node_modules/`.
- **Cost of a disabled sandbox**: spawning a local subprocess and reading the user directory requires it, so the app ships directly and not via the Mac App Store.
- **Allow-listed browsing**: `ondra-browser` opens only allow-listed addresses and has no sidebar entry.
- **Third-party plugins are trusted code**: they run in-process and are not sandboxed.
- **Reporting**: see [SECURITY.md](SECURITY.md).

---

## 14. Compatibility

| Platform | Status | Note |
|---|---|---|
| macOS | builds, runs | Sandbox off; no title bar; 960×600 |
| Web | builds | Full UI, no subprocess |
| Windows / Linux | project generated | Window sizing not yet pushed to native entry; features unaffected |
| iOS / Android / HarmonyOS | project generated | Three columns degrade to drawers; non-goal form factor |

Runtime: Flutter 3.32+ / Dart 3.14+; the kernel needs Node.js 18+. Missing fonts fall back to PingFang / Hiragino Sans GB / Microsoft YaHei / Source Han Sans.

---

## 15. Known Issues and Limitations

### 15.1 Known issues

| Issue | Scope | Workaround | Tracking |
|---|---|---|---|
| Model keys only via environment | Keychain writing is unfinished | `export DEEPSEEK_API_KEY=...` | Platform layer pending |
| Web cannot reach the kernel | Right pane unusable in browsers | Use the desktop build | By design |
| Five plugins call `schema.register()` outside `ctx.effect` | Would collide on restart | Not in the restart list today | Logged |
| Narrow-screen degradation | Limited mobile experience | Preview only | Unscheduled |

### 15.2 Unimplemented features

| Feature | Reason | Status |
|---|---|---|
| Keychain storage | Needs platform layer | Planned |
| Native window sizing on Windows / Linux | Needs per-platform entry | Planned |
| `asr` / `vision` plugins | Privacy and manifest dependencies missing | Unscheduled |
| Multi-user and cloud sync | Conflicts with the local-data positioning | Not planned |

---

## 16. Changelog

Follows Keep a Changelog and semantic versioning.

### [2.0.0-alpha] - 2026-11-18

- Changed: front end rewritten in Flutter; three-column shell, paper layer and four right-pane states complete.
- Added: `ondra-boot-settle` boot-order patch; startup degradation 55 → 0.
- Added: content-addressed backups and the timeline view; second snapshot adds 0 bytes.
- Added: memory import/export (Markdown / JSON) with real writes and double dedup.
- Added: plugin page merging 18 bundled entries with 75 assembly entries.
- Tests: 96 `flutter test` cases passing.

---

## 17. Roadmap

| Item | Target version | Status |
|---|---|---|
| Keychain storage and key management | 2.0.0-beta | Planned |
| Windows release package bundling the runtime (assembly and cache in workflow) | 2.0.0-beta | In progress |
| Native window entry for Windows | 2.0.0-beta | In progress |
| Native window entry for Linux | 2.0.0-beta | Planned |
| Wrap five `schema.register()` calls in `ctx.effect` | 2.0.1 | Planned |
| End-to-end memory pipeline visualisation | 2.1.0 | Planned |
| Frame-rate and cold-start benchmarks | 2.1.0 | Planned |

All non-commitments.

---

## 18. Contributing

- Environment: Flutter 3.32+ / Dart 3.14+ / Node.js 18+.
- Three checks: `flutter analyze`, `flutter test`, `tool/typecheck_plugins.sh`.
- Branches: `main` stays buildable; work on `feat/` or `fix/`.
- Commit messages: `<type>(<scope>): <subject>`, scope from `ui` / `plugin` / `core` / `design` / `docs`.
- New plugins need `plugin.json`, a README and a dependency entry in the assembly layer.
- Full process in [CONTRIBUTING.md](CONTRIBUTING.md); community expectations in [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Contributors and their scopes of responsibility: [CONTRIBUTORS.md](CONTRIBUTORS.md) (Chinese).

---

## 19. Copyright and License

Copyright © 2024-2026 星玖工作室 Ntarstudio. Licensed under Apache-2.0 / MIT.

| Path | License |
|---|---|
| `lib/plugins/ondra-core/` `ondra-extensions/` `ondra-custom/` `dsh-base/` | Apache-2.0 |
| `lib/app/` `lib/design/` `lib/main.dart` `tool/` `test/` | MIT |
| `assets/brand/` `assets/personas/` `assets/icons/` and the brand UI | All rights reserved |

`lib/plugins/cordis/` is a vendored copy of Cordis 4.1.0, MIT licensed, copyright its authors, not covered by this repository's layered licensing.

The names 空谷, Ondra, 星玖工作室 and Ntarstudio belong to the studio; the code licence grants no trademark rights. Copyleft components (GPL / LGPL / AGPL / MPL) are not permitted.

---

## 20. NOTICE and Open-Source Compliance

Third-party summary:

| Component | Purpose | License |
|---|---|---|
| Cordis 4.1.0 | Plugin framework (vendored) | MIT |
| dsh kernel | Chat and tool calls | Per upstream |
| Flutter runtime dependencies | UI and rendering | BSD-3-Clause |
| lucide icons | UI icons | ISC |
| MiSans subset | Chinese glyphs (not committed, optional) | MiSans font licence |

Full inventory, font restrictions and trademark terms are in [NOTICE](NOTICE).
