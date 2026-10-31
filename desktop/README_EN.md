# Ondra (空谷)

[中文](./README.md) ｜ [English](./README_EN.md)

**On No Sound's Depth, Resonance Arises.**

Ondra is a desktop AI companion application produced by Ntarstudio (星玖工作室), built as a deeply customized distribution of DeepSeek Harness. It is designed for one-click deployment and deep customization. The Chinese name 空谷 (konggu, "empty valley") derives from the idiom 空谷足音 — hearing a person's footsteps in a silent valley, a figure for hearing news of something exceedingly rare.

| Item | Content |
| --- | --- |
| Chinese name | 空谷 Ondra |
| Repository | [ntars/Ondra](https://github.com/ntars/Ondra) |
| Website | <https://ai.ntars.cn/> |
| Form factor | Desktop application (Electron shell + local agent runtime) |
| Platform | macOS (Apple Silicon first) |
| Version | 1.0.1 |
| License | [AGPL-3.0](LICENSE) |
| Upstream baseline | DeepSeek Harness `0.2.2-alpha.2` (MIT) |
| Runtime dependency | Node.js 24 runtime is bundled; users install nothing |

---

## 1. Project Name and Positioning

**Name.** The product is called 空谷 Ondra. The Chinese name 空谷 and the English name Ondra refer to the same product. The identifiers `Ondra`, `ondra`, and `空谷 Ondra` appearing in code and repositories all refer to this project.

**One-sentence positioning.** A desktop AI companion application that can be deployed in one step and customized deeply, in which the user retains full control over model selection and data ownership.

**Relationship to upstream.** This project is a deeply customized distribution of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (abbreviated dsh), an agent framework built on an "everything is a plugin" architecture and released under the MIT license. dsh supplies the agent kernel, the plugin container, session persistence, and the graphical interface foundation. Ondra adds brand reshaping, interface trimming, plugin reduction, data directory isolation, and build toolchain adaptation on top of that foundation. Every modification to upstream code is recorded in this document and in [NOTICE](NOTICE).

**Boundary of the relationship.** This project is not an official dsh distribution and does not represent the position of DeepSeek. The copyright and license notices of upstream code are preserved in full. Modifications made by this project are released under AGPL-3.0.

---

## 2. Introduction

### 2.1 Background

Mainstream AI products implement companionship in three ways. First, they write emotion into the prompt, so every turn is independently randomized. Second, they store memory in the cloud, where users cannot inspect, delete, or export it. Third, they bind the model to the product, so users can neither switch models nor continue a conversation offline.

All three share the same structural problem. Companionship presupposes that the system remembers, has affect, and speaks like a person, and all three properties require long-lived state. Once long-lived state resides with a service provider, the user loses privacy and control at the same time.

### 2.2 Problems Addressed

1. **Data ownership.** Conversation content is among the most private categories of information. Entrusting it to a cloud service means it persists on someone else's servers, subject to changing terms of service and business decisions.
2. **Vendor lock-in.** When inference capability is bound to the product, users cannot choose their model source and cannot continue working without network access.
3. **State discontinuity.** Affect and memory are cut at session boundaries, so a relationship cannot accumulate across days.
4. **Deployment barrier.** Customizable local agent solutions usually require a command line, a Node environment, and dependency compilation, which ordinary users cannot complete.

### 2.3 Core Approach

This project takes the route of packaging the entire runtime inside the application:

- **Kernel.** The Cordis plugin container from dsh is adopted. Every capability — model access, tool execution, interface modules, storage backends — is a plugin assembled declaratively through YAML patch layers, so product behavior changes without modifying kernel source.
- **Shell.** Electron owns windows, menus, icons, code signing, and auto-update. The agent runtime starts as a child process, separated from the interface process.
- **Data.** All state lives under a single root at `~/.ondra`. The application neither reads nor writes the system Documents directory, and does not intersect with any other dsh installation.
- **Distribution.** The application bundle embeds the Node.js 24 runtime and all dependencies, so a user double-clicks to run without installing a development environment.

### 2.4 Applicable Scenarios

| Scenario | Description |
| --- | --- |
| Personal long-term companion conversation | Single machine, single user, data never leaves the device |
| Self-hosted model or third-party gateway | Point the YAML configuration at any OpenAI-compatible endpoint |
| Desktop agent workbench | File access, command execution, subagents, skills, and workflows assembled per preset |
| Secondary development and brand customization | The plugin system and patch layers allow product changes without touching the kernel |
| Offline or intranet environments | Runs without external network access once a local inference service is configured |

---

## 3. Core Features

Every feature below reflects the actual code in the current version. Capabilities marked "preset layer" are assembled per session by an agent preset rather than mounted globally.

### 3.1 Interface and Interaction

1. **Three-column persistent workbench.** The session list on the left, the conversation area in the middle, and the third column on the right are visible simultaneously. The third column never collapses, and displays a placeholder panel rather than empty space when no session is open.
2. **Bilingual interface.** Only Simplified Chinese and English copy is retained, with English as the fallback baseline.
3. **No sign-in barrier.** The application enters the workspace directly on launch. No login page appears, and no account or key is required to view the interface.
4. **Theme following.** The interface follows the system light or dark preference by default and can be pinned to either in settings.
5. **Session auto-recovery.** If the previously selected session is no longer valid at launch, the application opens the most recently updated session in the target workspace.

### 3.2 Agent Capabilities (Assembled at the Preset Layer)

The standard preset (`standard`) mounts the following capabilities, thirty-two entries in total:

| Category | Capabilities |
| --- | --- |
| Command execution | `tool-bash` (POSIX shell), `tool-pwsh` (PowerShell) |
| File operations | `tool-fs` (read, write, edit), `tool-fs-search` (content search) |
| Network | `tool-web` (search and fetch) |
| Task management | `tool-todo`, `tool-goal`, `tool-jobs` (background jobs), `tool-schedule` |
| Planning and compaction | `plan-mode`, `planning`, `compaction`, `compaction-basic`, `command-compact`, `tool-result-pruner` |
| Subagents | `tool-subagent`, `tool-subagent-control`, `tool-subagent-fork`, `delegation` |
| Skills and workflows | `skill-filesystem`, `tool-skill`, `workflow-ptc`, `tool-workflow` |
| Plugin management | `tool-plugin-manager`, `tool-plugin-market` |
| Interaction and presentation | `tool-ask-user`, `present`, `persona`, `agent-instructions`, `time-context` |

The remaining three presets:

| Preset | Positioning | Difference from the standard preset |
| --- | --- | --- |
| `cordis` | Plugin developer | Adds `tool-cordis` for direct access to plugin configuration and type graphs |
| `ptc` | Programmatic tool calling | Adds `tool-executor-ptc`, orchestrating tools as executable code |
| `minimal` | Minimal viable | Retains only file operations and persistent terminals (`persistent-shell`, `pty`, `terminal-bash`, `terminal-pwsh`, twelve entries in total) |

### 3.3 Model Access

1. **Configurable sources.** Model access is configured through the `llm-deepseek` plugin's `baseURL` and `models` fields, supporting official endpoints, third-party gateways, and local inference services.
2. **Custom model entries.** Each model entry declares `id`, `name`, `contextWindow`, `systemPromptUpdate`, `toolUpdate`, and `inputModalities` to accommodate different context lengths and multimodal capabilities.
3. **Local key storage.** API keys are written to the local credential store and never appear in plain text in configuration files.

### 3.4 Data and Workspace

1. **Single data root.** All application data resides under `~/.ondra`.
2. **Fixed workspace.** The agent working directory is always `~/.ondra/workspace`. The interface offers no way to change it, and the configuration layer does not consult the system Documents directory.
3. **Session persistence.** Sessions are written as zstd-framed logs, with directory names derived from an encoding of the working directory path.
4. **Workspace registry.** `~/.ondra/storages/workspace.json` records workspace entities.

### 3.5 Build and Distribution

1. **Three build granularities.** Product-layer hot update (about 40 seconds), source-layer incremental packaging (about 4 minutes), and full repackaging (several minutes). See Chapter 7.
2. **Type gates.** Separate TypeScript project configurations exist for the client and host sides. Any TypeScript change must pass a `tsc -b` compilation check.
3. **Brand assets.** The application icon is rebuilt to Apple HIG optical dimensions: a 1024 px canvas, an 856 px artwork base (83.6% of the canvas, matching macOS system applications), and a 186 px corner radius.

---

## 4. Core Highlights

### 4.1 Persistent Third Column: Treating a Ready Context Panel as a Product Premise

- **Value.** Solves the problem of the right-hand panel being collapsed by accident and never found again. Once collapsed, users typically do not know how to restore it, so the panel stays hidden long-term and delivers no value.
- **Implementation.** Every collapse intent is rewritten to "expand" at the state layer. The `setExpanded` and `toggleExpanded` writers in `packages/client/ui-sidebar-right/src/client/stores.ts` always call `planSetExpanded(state, true)`, ignoring the boolean argument. The render layer in `SidebarRight.tsx` holds `expanded` as a constant `true`. The gate on `state.expanded` is removed from tab visibility checks. The `ExpandButton` component is no longer registered, so no collapse control exists in the interface.
- **Differentiation.** The common approach hides the button or adds a setting while the state machine still accepts collapse. A keyboard shortcut, deep link, or legacy configuration can then drive the interface back to the collapsed state. This implementation converges at the writer, so a collapse request from any source is absorbed before it reaches the state machine and no bypass exists.
- **Evidence.** Lines 279 to 283 of `stores.ts` retain the `planSetExpanded(state, true)` call together with the comment "Ondra's third column is permanent". The layout history stack (undo and redo) still records the expand action, which is why undo cannot return the interface to a collapsed state.

### 4.2 Empty-State Third Column: Structural Integrity Without a Session

- **Value.** Solves the layout jump that occurs when the third column disappears on startup or workspace switching. A width change between two and three columns forces the middle conversation area to reflow, shifting content the user is reading.
- **Implementation.** `packages/client/ui-sidebar-right/src/client/shell/RightbarRoot.tsx` renders `RightbarEmpty` when the session view collection is empty, drawing the same panel frame and placeholder copy instead of returning `null`.
- **Differentiation.** Most desktop applications simply do not render a sidebar when it has no content, which looks cleaner but sacrifices layout stability. This implementation trades an empty-state placeholder for constant layout.
- **Evidence.** Line 42 of `RightbarRoot.tsx` reads `if (views.length === 0) return <RightbarEmpty />`, and the `RightbarEmpty` component is defined from line 52.

### 4.3 Fully Isolated Data Directory: One Root per Installation

- **Value.** Solves the risk of two dsh-family applications overwriting each other's project files on the same machine. Upstream resolves the workspace into a shared path under the system Documents directory, where multiple applications read and write the same tree.
- **Implementation.** `packages/api/workspace-controller/src/default-directory.ts` is rewritten. `defaultWorkspaceDirectory()` no longer queries the system Documents directory and always returns `$DSH_HOME/workspace`, where `$DSH_HOME` defaults to `~/.ondra`.
- **Differentiation.** The common approach lets users pick a directory and delegates isolation to them. This implementation chooses non-configurability. The cost is flexibility; the benefit is that no installation can corrupt another installation's data.
- **Evidence.** The implementation at lines 50 to 63 and the comment at lines 39 to 42 explicitly record that "another tool installed on this machine (dsh) owns `<Documents>/deepseek-harness`, so sharing that tree would let the two applications read and overwrite each other's project files". The `DSH_HOME` environment variable still relocates the whole root for testing and unusual deployments.

### 4.4 Direct Entry Without Sign-In: One Place Owns the Decision

- **Value.** Solves the first screen being occupied by a sign-in wall in a companion application. The user's first intent on opening the app is conversation, not registration.
- **Implementation.** `needsWelcome()` in `apps/desktop/src/welcome-api.ts` always returns `false`. The function is not deleted, because every call site still asks the question, and keeping a single searchable decision point is a maintainability choice.
- **Differentiation.** Deleting the welcome window outright leaves branches scattered across call sites, and restoring sign-in later requires re-tracing the call chain. Keeping the function with a fixed `false` makes restoration a one-line change.
- **Evidence.** Lines 68 to 79 of `welcome-api.ts` contain `return false` together with the comment "Ondra ships without a sign-in step: the workspace is the first screen".

### 4.5 Shortcut Service Seat Retained, Implementation Emptied: Avoiding Startup Service Loss

- **Value.** Solves the cascading failure in which removing the shortcut feature stalls startup. Eleven interface plugins depend on the `ctx.shortcuts` service seat. When the service is absent, those plugins enter a pending state and the application stops at the splash screen.
- **Implementation.** The standalone `packages/client/ui-shortcuts` package is deleted. `packages/client/shortcuts` is retained, but its host-side `apply()` becomes an empty function, and the client side provides only an inert service placeholder that injects nothing into pages and reads no configuration.
- **Differentiation.** A wholesale deletion is clean in unit tests but breaks service dependencies at runtime. Retaining the service seat while removing the implementation is a deliberate compromise: the feature genuinely disappears, and the startup chain stays intact.
- **Evidence.** `apply()` in `packages/client/shortcuts/src/index.ts` is empty, and the file header records "The plugin row still mounts so the `shortcuts` service seat exists for feature plugins".

### 4.6 Interface Copy Trimming: From 1752 Language Files to Two

- **Value.** Solves the installation and update package being inflated by six unused languages, and removes the inconsistency between available interface languages and product positioning.
- **Implementation.** Localization files for `ja`, `es`, `fr`, `de`, `ru`, and `pt` are deleted, 1765 files in total. Sixty-eight `locale.register` call sites are reduced to registering only `zh` and `en`. `FALLBACK_LOCALE` is set to `en`.
- **Differentiation.** The common approach keeps language files while hiding language options in the interface, leaving installation size unchanged. This implementation deletes the resources, reducing both size and maintenance surface.
- **Evidence.** The change deletes 37,317 lines across 1765 files, reproducible with `git diff --stat`.

### 4.7 Icon Rebuilt to Apple HIG Optical Dimensions

- **Value.** Solves the icon appearing undersized in Finder and the Dock. Drawing artwork to the full canvas makes an icon look smaller than system icons, because system artwork does not fill its canvas.
- **Implementation.** A 1024 px canvas, an 856 px artwork base (83.6% of the canvas, matching the measured ratio of the system Notes and Music apps), and a 186 px corner radius. Glyphs are emboldened to optical size so stroke weight survives at small sizes. The PNG is exported and packed into `.icns`, replacing the resource inside the application bundle.
- **Differentiation.** Most custom icons draw artwork to the canvas edge, which looks large in isolation but oversized next to system icons. Matching the measured 83.6% system ratio is what makes the icon appear the same size in Finder.
- **Evidence.** `apps/desktop/resources/icon-macos.png` and `icon.png` are both 1024 px canvases of roughly 48 KB, and the `.icns` has been replaced inside `空谷 Ondra.app`.

### 4.8 Four Agent Presets: Capability Determined by Composition, Not Compile-Time Switches

- **Value.** Solves the need for one installation package to serve users with different intensity requirements. Heavy users need command execution and subagents; light users need only conversation and file access. These should not require two installers.
- **Implementation.** Capabilities are declared as YAML patches. Four patch files under `packages/bundle/web-app/presets/` assemble `standard` (32 entries), `cordis` (33), `ptc` (33), and `minimal` (12). The global layer (`web-app/cordis.patch.yml`) retains only the interface skeleton and registries, while tool plugins descend to the preset layer and mount per session.
- **Differentiation.** Compile-time trimming requires maintaining multiple build artifacts, and runtime switches easily produce an incomplete dependency graph. Preset-layer composition operates at the granularity of a session's agent, so capability sets switch per session while a single installer suffices.
- **Evidence.** The `id` lists in `packages/bundle/web-app/presets/standard.patch.yml` and its three siblings can be counted directly, as summarized in section 3.2.

---

## 5. Design Details and Small Decisions

This chapter records non-obvious implementation decisions, including boundary conditions, degradation strategies, default-value trade-offs, and cross-platform adaptation.

### 5.1 Abnormal Input and Boundary Conditions

1. **Session selection fallback.** `packages/client/ui-workspace/src/client/navigation.ts` adds `newestSessionIn()` (defined at line 594, called at line 496). If the previously selected session has been deleted or migrated, the interface opens the most recently updated session in that workspace instead of showing a blank page. Falling back to the newest session rather than creating an empty one avoids producing a useless session directory on every invalidation.
2. **Empty workspace.** When a workspace contains no sessions, the third column enters the `RightbarEmpty` state and the middle area shows a creation prompt. No error state is entered.
3. **Path-encoded session directories.** Session directory names are derived from an encoding of the working directory path: `/` becomes `-` and other special characters are escaped as `~XXXX`. Consequently `~/.ondra/workspace` maps to `--Users-ntars-.ondra-workspace--`. Changing the workspace path requires migrating both the directory name and the `cwd` field inside each session file, or the interface cannot locate sessions by path.
4. **Empty configuration values.** `defaultWorkspaceDirectory()` tests `DSH_HOME` for presence and non-emptiness after trimming, preventing a relative path when an empty string is supplied.

### 5.2 Timeouts, Retries, Degradation, and Fault Tolerance

1. **Compiler memory ceiling.** Host-side compilation on the development machine exceeds the default heap limit, so build scripts set `NODE_OPTIONS=--max-old-space-size=8192`. Without it the process exits on out-of-memory.
2. **Fallback for broken service dependencies.** The `shortcuts` service seat is retained as an empty implementation, as described in 4.5. The same pattern applies wherever an interface plugin depends on a service whose feature has been removed.
3. **Cross-checking plugin disables against preset membership.** Before disabling a plugin, confirm it is absent from every preset's member set, or new sessions fail with `agent-preset/invalid`. Historically, disabling `goal` left `tool-goal` waiting on a `goals` service and broke the entire session-creation path. The rule is: preset member set intersected with the disable list must be empty.
4. **Sign-in degradation.** `needsWelcome()` always returns `false`, so even an account read failure cannot block entry into the workspace.

### 5.3 Caching and Performance Optimization

1. **Three build granularities.** A product-layer hot update synchronizes only already-unpacked files inside `app.asar` and takes about 40 seconds. A source-layer incremental package recompiles `packages/**/src`, synchronizes artifacts, re-signs, and restarts in about 4 minutes. A full repackage handles the dependency tree, package manifest, and icons in several minutes. Choosing the smallest sufficient granularity avoids running the full pipeline every time.
2. **Configuration synchronization scope.** In addition to compiled `lib` output, the incremental packaging script synchronizes `*.yml` files at package roots (`cordis.patch.yml`, `presets/*.yml`). Omitting this produces the most expensive class of failure: configuration changes that compile successfully but never take effect.
3. **On-demand page loading.** Interface modules register as plugins, so disabled plugins never enter the render tree and contribute no runtime code path.

### 5.4 Concurrency and Data Consistency

1. **Locked configuration writes.** The desktop main process serializes writes to the profile directory through a lock file (`withLock` in `apps/desktop/src/project-manager.ts`) and verifies that the lock path is a regular file, preventing concurrent writes from producing a half-written configuration.
2. **Undo semantics for layout history.** The third column's expand action is still recorded in the layout history stack. Undoing a tab operation cannot return the interface to a collapsed state, because no collapsed state exists in history.
3. **Framed session log writes.** Session logs use one zstd frame per line, and the first frame must be exactly one header line. Decompressing the whole file and recompressing merges frames and breaks the format, producing `first frame is not exactly one header line`. Any session rewrite must rebuild frame by frame, never re-compress the whole file.

### 5.5 Memory and Storage Optimization

1. **Language resource deletion.** Removing 1765 files across six languages reduces installation size and file handle count, with no runtime memory impact.
2. **Output spill and result pruning.** The preset layer mounts `tool-result-pruner` and the `compaction` family to prune oversized tool output and compress context, preventing a single tool call from exhausting the context window.
3. **Attachment and binary separation.** Binary attachments are managed by a dedicated plugin and never enter the conversational text stream.

### 5.6 Security and Protective Design

1. **Process isolation.** The agent runtime starts as a child process separate from the Electron main process, so an interface crash does not take down the runtime, and a runtime crash can be restarted by the main process.
2. **Least privilege.** Tools mount at session scope, so an unmounted tool has no invocation entry point.
3. **Data never leaves the device.** Sessions, configuration, and credentials all live under `~/.ondra` unless the user explicitly configures a remote model endpoint.
4. **Sandbox boundary.** Upstream provides process restriction and approval mechanisms, but these do not constitute a security isolation guarantee. See Chapter 13.

### 5.7 Small User-Experience Decisions

1. **English as the fallback locale.** When an interface locale file lacks a key, the fallback is English rather than Chinese, because English entries have the most complete coverage after trimming.
2. **No collapse control in the third column.** The interface offers no collapse entry rather than a greyed-out unavailable button. An unusable control is more confusing than no control.
3. **Theme follows the system by default.** No brand-color theme is preset, avoiding a bright first launch on a dark system.
4. **Window title and version.** The application bundle does not display Electron's own build number, showing only the product version, so version information has a single source.

### 5.8 Rationale for Default Values

| Default | Value | Rationale |
| --- | --- | --- |
| Data root | `~/.ondra` | Isolates from other dsh installations and keeps the system Documents directory clean |
| Workspace | `~/.ondra/workspace` | A fixed path makes session directory names predictable for backup and migration |
| Fallback locale | `en` | English entries have the most complete coverage after trimming |
| Icon base ratio | 83.6% | Matches the measured ratio of macOS system applications |
| Compiler heap ceiling | 8192 MB | The lowest workable value measured for host-side compilation on the development machine |
| Theme | Follow system | Avoids a brightness jump on first launch under a dark system |

### 5.9 Cross-Platform and Version Compatibility Strategy

1. **Path separator handling.** `default-directory.ts` selects the `posix` or `win32` path module by `process.platform`, and explicitly rejects a Windows drive root as a workspace.
2. **Packaging targets.** Current scripts cover macOS arm64, macOS x64, and Windows x64. macOS arm64 is the verified platform; the others retain scripts but are not verified in this version.
3. **Upstream session format compatibility.** The session format is maintained upstream. This project does not change the format version number and follows upstream version rules when migrating sessions.

---

## 6. Technology Stack and Dependencies

### 6.1 Core Stack

| Layer | Technology | Version | Purpose |
| --- | --- | --- | --- |
| Desktop shell | Electron | See dependency list | Windows, menus, icons, signing, auto-update |
| Agent kernel | DeepSeek Harness (dsh) | `0.2.2-alpha.2` | Agent loop, sessions, tool execution, plugin container |
| Plugin framework | Cordis (vendored) | See `vendor/README.md` | Dependency injection, plugin lifecycle, configuration patches |
| Interface | React | 18.3.x | Render-layer components |
| Language | TypeScript | See dependency list | All source code |
| Build | tsdown + Vite | See dependency list | Host and client artifact bundling |
| Package manager | pnpm workspace | lockfile v9.0 | 396 packages in one repository |
| Runtime | Node.js | 24.x | Bundled and distributed with the application |
| Session storage | zstd framed logs + SQLite | See dependency list | Session persistence and indexing |

### 6.2 Scope and Completeness of Dependency Disclosure

The following conventions govern dependency disclosure, to avoid both omission and overstatement:

1. **Direct dependencies.** External packages declared in `dependencies`, `peerDependencies`, or `optionalDependencies` across `package.json` files: 121 items, listed individually in 6.3.
2. **Transitive dependencies.** The complete closure is recorded in `pnpm-lock.yaml` (lockfile v9.0, 1753 resolved records) and can be reviewed with `pnpm licenses list`. It is not restated item by item here, to avoid maintaining two sources of truth.
3. **Source-vendored dependencies.** The Cordis framework and its foundation libraries are vendored into the repository rather than installed from npm: 9 items, all MIT, each preserving its upstream `LICENSE` file. Upstream commits and local modifications are recorded in `vendor/README.md`.
4. **Development-only dependencies.** Used solely for building, testing, and static analysis, and not distributed with the application: 75 items, listed in 6.4. Development-only dependencies are not subject to distribution license obligations but are still fully disclosed.
5. **Copyright holder values.** The copyright holder field is taken from the copyright line in each package's bundled `LICENSE` file. Some packages use a standard license template without an independent copyright line; those entries are recorded as "See bundled LICENSE" without inference.
6. **Modification status.** Apart from the 9 source-vendored dependencies under `vendor/`, no third-party package source is modified. Modifications to vendored items are recorded per item in `vendor/README.md` and in [NOTICE](NOTICE).
7. **Purpose classification.** The table classifies packages by their actual role in the project rather than by name. Classification is based on `package.json` references and build configuration.

### 6.3 Runtime Dependencies (121 Items)

The following dependencies ship with the application or are bundled into host and browser artifacts.

<details>
<summary>Expand the complete list (121 items)</summary>

__DEPS_TABLE__

</details>

### 6.4 Development-Only Dependencies (75 Items)

Used only for building, testing, and static analysis; never included in distributed artifacts. The complete list and licenses appear in the Development-only section of [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Two items require particular attention:

| Package | License | Note |
| --- | --- | --- |
| `eslint-plugin-sonarjs` | LGPL-3.0-only | Invoked only during static analysis; its code is not linked into any distributed artifact |
| `lightningcss` | MPL-2.0 | Invoked only during builds; its output is CSS, which contains no source from the package |

### 6.5 Non-npm Dependencies

| Component | Version | License | Note |
| --- | --- | --- | --- |
| Node.js runtime | 24.x | MIT | Distributed with the application under the bundle's `Resources` directory |
| Python distributions | See `THIRD_PARTY_NOTICES.md` | Respective licenses | Used by the Python SDK and some tools; 14 items |
| Python SDK dependencies | See `python/sdk/uv.lock` | Respective licenses | 5 items |
| Claude Code platform payloads | See `THIRD_PARTY_NOTICES.md` | Respective licenses | 9 items, provided with the optional ACP channel |

### 6.6 Handling Non-Permissive Licenses

This project is released under AGPL-3.0. Its combination with upstream MIT is handled as follows:

1. **MIT upstream code.** MIT permits relicensing under AGPL-3.0. The upstream dsh copyright notice and the full MIT license text are preserved in `NOTICE` without deletion or alteration.
2. **MPL-2.0 components** (`@deepseek-ai/libreoffice-kit`, `dompurify`). MPL-2.0 permits combination into a larger work governed by AGPL, provided the source code availability path and modification notices are preserved. `dompurify` is dual-licensed with Apache-2.0 and may be treated under the more permissive option.
3. **LGPL-3.0-only component** (`eslint-plugin-sonarjs`). Used only during development and not distributed, so LGPL linking obligations are not triggered.
4. **CC0-1.0** (`simple-icons`). A public domain dedication with no additional conditions.
5. **BlueOak-1.0.0** (`tar`). A permissive license that permits relicensing.
6. **Apache-2.0 components.** Compatible with AGPL-3.0; their `NOTICE` files and patent grants must be preserved.

---

## 7. Installation and Deployment

### 7.1 Requirements

| Item | Requirement |
| --- | --- |
| Operating system | macOS 12 or later (Apple Silicon first); Windows build scripts exist but are unverified in this version |
| Node.js | 24.9 or later for building; the runtime is bundled so end users install nothing |
| pnpm | A version compatible with lockfile v9.0 (provided through corepack) |
| Disk | About 3 GB for source and dependencies, about 1.3 GB for the packaged application |
| Memory | 16 GB or more recommended for building; the compiler heap ceiling requires 8 GB |

### 7.2 Building from Source

```bash
# 1. Obtain the source
git clone https://github.com/ntars/Ondra.git
cd Ondra

# 2. Install dependencies (396 packages in one repository; this takes a while)
pnpm install

# 3. Full build
pnpm run build

# 4. Package the macOS arm64 application
pnpm run package:desktop:mac:arm64
```

Artifacts are written to the `build/` directory, and the application bundle is named `空谷 Ondra.app`.

### 7.3 Compilation Verification

After any TypeScript source change, both project configurations must compile with exit code 0:

```bash
node node_modules/typescript/bin/tsc -b tsconfig.client.json tsconfig.host.json
echo "EXIT=$?"
```

Host-side compilation is memory-sensitive. If the process exits on out-of-memory, set:

```bash
export NODE_OPTIONS=--max-old-space-size=8192
```

### 7.4 Three Build Granularities

| Mode | Duration | Scope | Behavior |
| --- | --- | --- | --- |
| Product-layer hot update | About 40 s | Files already unpacked inside `app.asar` | Replaces artifact files and restarts the application |
| Source-layer incremental package | About 4 min | TypeScript source under `packages/**/src` | Compiles, synchronizes artifacts, re-signs, restarts |
| Full repackage | Several minutes | Dependency tree, package manifest, icons | Runs the complete packaging pipeline |

**Important.** Beyond compiled artifacts, a source-layer incremental package must also synchronize `*.yml` configuration files at package roots (`cordis.patch.yml`, `presets/*.yml`). Omitting this yields a silent failure in which the configuration compiles but never takes effect.

These three script families belong to the developer's local workspace and are not distributed with the repository. The public repository builds through the pnpm flow in 7.2.

### 7.5 Runtime Directories

The following directories are created automatically on first launch. No manual preparation is required.

```
~/.ondra/
├── profiles/desktop/        # Plugin configuration and patch layers
├── sessions/                # Session logs, split by workspace path
├── storages/                # Workspace registry and other non-session storage
└── workspace/               # Agent working directory, fixed path
```

### 7.6 Uninstallation

Deleting the application bundle and the `~/.ondra` directory removes the application completely. Deleting `~/.ondra` discards all sessions and configuration, so back it up first.

---

## 8. Getting Started

### 8.1 First Launch

1. Open `空谷 Ondra.app`. First launch initializes the configuration directory and workspace under `~/.ondra`.
2. The application enters the workspace directly, with no sign-in page.
3. The session list is on the left, the conversation area in the middle, and the persistent panel on the right.

### 8.2 Configuring Model Access

Model configuration lives in `~/.ondra/profiles/desktop/cordis.patch.yml`. The following is a minimal working configuration:

```yaml
- id: llm-deepseek
  name: "@deepseek-ai/dsh-llm-deepseek-api-key"
  config:
    baseURL: https://api.example.com/v1
    models:
      - id: deepseek-flash
        name: DeepSeek-V4.1-Flash
        contextWindow: 1048576
        systemPromptUpdate: in-history
        toolUpdate: addition-only
        inputModalities:
          - text
          - image
```

Field reference:

| Field | Meaning |
| --- | --- |
| `baseURL` | An OpenAI-compatible endpoint. May point at the official service, a third-party gateway, or a local server |
| `models[].id` | The model identifier used in requests; must match the server |
| `models[].name` | The display name in the interface |
| `contextWindow` | Context window size in tokens, affecting compaction and truncation strategy |
| `systemPromptUpdate` | How system prompts are updated; `in-history` writes them into session history |
| `toolUpdate` | How tool definitions are updated; `addition-only` never removes |
| `inputModalities` | Supported input modalities: `text`, `image` |

Restart the application for configuration changes to take effect.

### 8.3 Starting a Conversation

1. Create a new session at the bottom of the left-hand session list.
2. Select an agent preset. `standard` is the default.
3. Enter content and send. The session is saved automatically under `~/.ondra/sessions/`.

### 8.4 Verifying the Installation

```bash
# Confirm the data directory exists
ls ~/.ondra

# Confirm the fixed workspace path is in effect
cat ~/.ondra/storages/workspace.json

# Confirm session directories are created
ls ~/.ondra/sessions/
```

---

## 9. Configuration Reference

### 9.1 Configuration Layers

Configuration layers stack in the following order, with later layers overriding earlier ones:

| Layer | Location | Scope |
| --- | --- | --- |
| Base bundle | `packages/bundle/base/cordis.patch.yml` | Plugin skeleton shared by all presets: 80 enabled, 15 hard-disabled |
| Application bundle | `packages/bundle/web-app/cordis.patch.yml` | Interface skeleton and registries: 51 enabled, 63 descended |
| Presets | `packages/bundle/web-app/presets/*.patch.yml` | Per-session agent capability assembly |
| User layer | `~/.ondra/profiles/desktop/cordis.patch.yml` | User overrides with the highest priority |

### 9.2 Patch Syntax

A patch file is a YAML array in which each entry targets one plugin row by `id`:

```yaml
# Override a plugin's configuration
- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: light

# Disable a plugin
- id: tool-web
  disabled: true

# Insert a new plugin row
- insert:
    - id: my-plugin
      name: "@scope/my-plugin"
```

Field reference:

| Field | Meaning |
| --- | --- |
| `id` | Row identifier, unique within a layer |
| `name` | Plugin package name, required when creating a row |
| `config` | The row's complete replacement configuration, not a deep merge |
| `disabled` | Whether the row is disabled; accepts `!!js` expressions |
| `insert` | A list of plugin rows to add |

**Note.** `config` replaces rather than deep-merges, so a plugin row whose values differ by mode must not live in a shared layer, where the next layer would overwrite it wholesale.

### 9.3 Environment Variables

| Variable | Effect | Default |
| --- | --- | --- |
| `DSH_HOME` | Data root directory | `~/.ondra` |
| `NODE_OPTIONS` | Node parameters during builds; host-side compilation needs a larger heap ceiling | None |
| `TMPDIR` | Temporary directory during builds | System default |
| `ELECTRON_RUN_AS_NODE` | Must be unset before building, or Electron starts in Node mode | Unset |

### 9.4 Common Behavior Switches

| Goal | How |
| --- | --- |
| Pin the light theme | Override `ui-theme` `preference` to `light` in the user layer |
| Pin the dark theme | Override `ui-theme` `preference` to `dark` in the user layer |
| Disable a tool | Set `disabled: true` on that tool's `id` in the user layer |
| Change the model endpoint | Modify `llm-deepseek` `baseURL` and `models` |
| Relocate the data root | Set the `DSH_HOME` environment variable, restart, and migrate the directory manually |

---

## 10. API and Module Reference

### 10.1 Module Organization Principle

The project organizes everything as plugins. Each capability is an independent workspace package named `@deepseek-ai/dsh-<group>-<name>`, and the Cordis container performs dependency injection and lifecycle management. Plugins never reference each other's internal implementation directly; they collaborate through service seats.

### 10.2 Major Module Groups

| Group | Responsibility | Packages |
| --- | --- | --- |
| `core` | Agent loop, sessions, system prompts, tool executors | 10 |
| `session` | Session persistence, format versions, migration | 22 |
| `llm` | Model provider integration | 9 |
| `shell` | Command execution abstraction | 10 |
| `subprocess` | Child process management | 3 |
| `sandbox` | Process confinement | 4 |
| `fs` | Filesystem access | 7 |
| `web` | Search and fetch | 7 |
| `subagent` | Subagent orchestration | 9 |
| `skill` | Skill loading | 5 |
| `workflow` | Workflow execution | 3 |
| `preset` | Agent capability composition and persona injection | 3 |
| `bundle` | Preset bundles and patch layers | 6 |
| `client` | Interface plugins (modules, panels, settings pages) | 66 |
| `api` | Communication layer between interface and host | 10 |
| `host` | Graphical host | 9 |
| `boot` | Application startup and plugin management | 6 |
| `storage` | Non-session storage | 4 |
| `credentials` | Credentials and authorization | 5 |
| `util` | Zero-dependency utilities | 21 |
| `experimental` | Evaluated capabilities without a product-support commitment | 65 |

Group documentation is in `packages/README.md`. Per-package contracts appear in each package's README and in the exported types of `src/index.ts`.

### 10.3 Interface-to-Host Communication

Interface plugins run in the renderer process and cannot touch the filesystem or child processes directly. All privileged operations travel through IPC channels to the main process or the agent runtime:

| Channel family | Purpose |
| --- | --- |
| `dsh-welcome:*` | Private channels of the first-run window, installed only while the window exists |
| Platform view channels | Panels and views registered by interface plugins |
| Agent runtime channels | Session reads and writes, tool calls, model requests |

Channel names and payload types are organized by module under `apps/desktop/src/`. Adding a channel requires updating both the type definitions and the call sites.

### 10.4 Session Format

Sessions are stored as one zstd frame per line:

1. The first frame must be exactly one header line containing the format version.
2. Each subsequent frame carries one event record.
3. Frame boundaries are part of the format. Decompressing and recompressing the whole file merges frames and breaks the format.

Any session rewrite must rebuild frame by frame and never decompress the whole file for rewriting. The format version is maintained upstream, and this project introduces no private version numbers.

### 10.5 Adding a Plugin

1. Create a package under `packages/<group>/<name>/`, naming it `@deepseek-ai/dsh-<group>-<name>` in `package.json`.
2. Export an `apply(ctx)` function that registers services, tools, or interface modules.
3. Declare the row with `insert` in the target preset's `*.patch.yml`, or in the user-layer configuration.
4. If disabling the plugin would affect preset membership, verify that the preset member set intersected with the disable list is empty.
5. Run the compilation verification and the relevant tests.

---

## 11. Directory Structure

```
.
├── apps/                       Application layer
│   ├── desktop/                Electron desktop shell
│   │   ├── src/                Main process, preload, IPC, window management
│   │   ├── renderer/           First-run render resources
│   │   ├── resources/          Icons and brand assets
│   │   ├── scripts/            Packaging, signing, notarization, smoke tests
│   │   └── packaging/          Per-platform packaging configuration
│   ├── web/                    Browser entry point
│   ├── cli/                    Command-line entry point
│   ├── desktop-host/           Desktop host runtime
│   └── plugin-market-generator/Plugin market index generator
├── packages/                   Workspace packages, 396 in total
│   ├── core/                   Agent kernel
│   ├── session/                Session persistence
│   ├── llm/                    Model integration
│   ├── client/                 Interface plugins (66)
│   ├── bundle/                 Preset bundles and patch layers
│   ├── preset/                 Agent composition and persona
│   ├── experimental/           Experimental capabilities (65)
│   └── ...                     The remaining 45 groups
├── vendor/                     Vendored Cordis framework (9 packages)
├── native/                     Native addon source
├── python/                     Python SDK and runtime
├── benchmarks/                 Performance gates
├── scripts/                    Verification scripts and generators
├── docs/                       Developer documentation
├── website/                    Documentation site
├── AGENTS.md                   Repository conventions for automation
├── THIRD_PARTY_NOTICES.md      Third-party dependency disclosure
├── LICENSE                     Full AGPL-3.0 text
├── NOTICE                      Copyright and compliance notice
└── README.md / README_EN.md    This document
```

---

## 12. Performance

### 12.1 Established Deterministic Data

The following values are measured directly on the development machine or read from the filesystem and are reproducible:

| Metric | Value | Measurement |
| --- | --- | --- |
| Application bundle size | About 1.3 GB | `du -sh "空谷 Ondra.app"` |
| Main resource archive | About 522 MB | `du -sh Contents/Resources/app.asar` |
| Language resource deletion | 1765 files / 37,317 lines | `git diff --stat` |
| Workspace package count | 396 | Counting `package.json` files excluding `node_modules` |
| Lockfile resolved records | 1753 | The `packages` section of `pnpm-lock.yaml` |

### 12.2 Build Duration

| Mode | Duration | Note |
| --- | --- | --- |
| Product-layer hot update | About 40 s | Measured locally |
| Source-layer incremental package | About 4 min | Includes compilation, synchronization, re-signing, restart |
| Full repackage | Several minutes | Varies with dependency tree size |

### 12.3 Metrics Not Provided

This project does **not** provide independently benchmarked values for the following, and makes no speculative claims:

1. Cold start time, first paint time, or time to first token.
2. Per-session memory usage or long-run memory growth.
3. End-to-end tool call latency.
4. Throughput comparisons across model endpoints.

The repository includes a `benchmarks/` directory and related gates for regression detection, not for publishing external metrics. Any performance figure should be measured locally under identical hardware and model endpoint conditions rather than quoted from elsewhere.

### 12.4 Structural Factors Affecting Performance

1. **Bundle size is dominated by the bundled runtime.** The Node.js runtime, Python distributions, and native libraries account for most of the volume; JavaScript artifacts are a small fraction.
2. **The startup path includes plugin composition.** Plugin count directly affects composition time at startup, and disabling plugins shortens the startup chain.
3. **The preset determines tool count.** The `minimal` preset mounts 12 capabilities and `standard` mounts 32. Tool definitions enter every request's context, so fewer capabilities mean lower context overhead.

---

## 13. Security and Privacy

### 13.1 Data Handling Principles

1. **Data localization.** Sessions, configuration, credentials, and workspace files all live under `~/.ondra`. Nothing is uploaded to any service by default.
2. **The only outbound destination is the model endpoint.** Unless a remote model service is configured, the application makes no external network requests. Search and fetch tools contact target addresses only when the user invokes them explicitly.
3. **No account system.** No account information is collected, no cross-device synchronization exists, and no server-side copy of conversations exists.
4. **Backups remain under user control.** The application does not upload backups automatically; backup generation and storage location are the user's decision.

### 13.2 Permission and Execution Boundaries

1. **Tools mount per session.** An unmounted tool has no invocation entry point, and the model cannot call a tool that does not exist.
2. **Command execution requires an explicit capability.** `tool-bash` and `tool-pwsh` provide command execution, and whether they mount is decided by the preset.
3. **The role of the sandbox.** Process restriction and approval mechanisms reduce risk but do not constitute a security isolation guarantee. A sandbox cannot protect resources the application has been authorized to access.

### 13.3 Risks the User Must Accept

The following risks cannot be eliminated by software and should be assessed before use:

1. Model-generated commands may modify or delete files. Confirm target paths and scope before execution.
2. Third-party plugins may read or write host resources. Review source code and permission declarations before installing a plugin.
3. When configuration points at an untrusted model endpoint, conversation content is sent to that endpoint. The endpoint is the user's choice, and its data handling policy is its own responsibility.
4. Files in the workspace are visible to the agent. Sensitive files should not be placed in the workspace.

### 13.4 Security Recommendations

1. Grant only the minimum permissions needed for the task.
2. Trial new plugins and presets in a disposable virtual machine or container first.
3. Back up `~/.ondra` regularly.
4. Do not place production credentials in the workspace directory.
5. Review every remote endpoint that appears in configuration files.

---

## 14. Compatibility

### 14.1 Platform Support Matrix

| Platform | Architecture | Status | Note |
| --- | --- | --- | --- |
| macOS 12+ | Apple Silicon (arm64) | Verified | The primary verified platform for this version |
| macOS 12+ | Intel (x64) | Scripts exist, unverified | Packaging scripts work; no hardware verification performed |
| Windows 10/11 | x64 | Scripts exist, unverified | Packaging scripts work; no hardware verification performed |
| Linux | — | Unsupported | No packaging target |

### 14.2 Runtime Compatibility

1. **Node.js.** Building requires 24.9 or later. The application bundles a 24.x runtime, so users install nothing.
2. **pnpm.** Uses lockfile v9.0 and requires a v9-compatible pnpm.
3. **Electron.** The version is pinned in the lockfile; upgrading requires re-verifying signing and the auto-update path.

### 14.3 Data Compatibility

1. **Session format version.** Maintained upstream. Upgrades may introduce new format versions. Upstream rules permit adding a version number but never rewriting already-committed data of an older version in place.
2. **Configuration format.** Patch files are YAML and their fields evolve with plugin versions. If an upgrade removes a plugin field, leftover fields in the user layer are ignored rather than raising an error.
3. **Downgrade.** Not supported. An older version may be unable to read sessions written by a newer version.

### 14.4 Compatibility with Upstream dsh

This project is customized against upstream `0.2.2-alpha.2` and does not maintain API compatibility with upstream. Later upstream versions require manual merging, and any merge must re-verify: the number of locale registration points, the shortcut service seat, the right column's state writers, workspace path resolution, and the intersection of preset membership with the disable list.

---

## 15. Known Issues and Limitations

This chapter records current defects and boundaries honestly.

### 15.1 Functional Gaps

1. **Companion capabilities are not yet ported.** The six-dimensional affect engine, two-layer long-term memory, nine-step output filter chain, humanized pacing, diary, and proactive message gate from the previous implementation **do not exist** in this version. What exists today is agent conversation, persona section injection (`packages/preset/persona`), and session history persistence. Affect state, cross-session memory extraction, and relationship stage determination are unimplemented.
2. **The workspace selection entry point remains.** `ui-conversation` still exposes a "select workspace" interaction, while the workspace path is fixed at `~/.ondra/workspace` in the data layer. The current state is "selectable but ineffective", and the entry point should be removed.
3. **The plugin disable list has not been systematically reviewed.** The 70 new disables were applied without fully validating preset membership, so a latent gap may exist where disabling one plugin removes a capability from a preset. Disabling `goal` previously broke session creation, and analogous problems may remain.

### 15.2 Known Defects

1. **Residual non-target language files.** Thirty-six `ja`, `es`, `fr`, `de`, `ru`, and `pt` files remain after trimming, distributed across `boot/plugin-manager`, `bundle/web-app`, `extensions/tool-cordis`, `preset/agent-preset/skills/templates` (both decoration and mcp sets), and `subagent/tool-subagent`. They do not affect runtime behavior but contradict the "Chinese and English only" positioning.
2. **Failing sidebar tests.** Tests under `packages/client/ui-sidebar-right/tests/` still verify collapse and expand behavior that has been removed by design. These tests fail and should be rewritten to verify "always expanded" semantics rather than deleted outright.
3. **Icon appearance in Finder not finalized.** The icon has been rebuilt at the 83.6% base ratio, but a side-by-side comparison with system icons has not been signed off, so minor adjustment remains possible.

### 15.3 Engineering Limitations

1. **Build scripts are not open-sourced.** The product-layer hot update, source-layer incremental package, and full repackage scripts belong to the developer's local workspace and are not distributed. The public repository can only use the standard pnpm flow, which is slower.
2. **Host-side compilation is memory-sensitive.** Without a larger heap ceiling, the compiler exits on out-of-memory.
3. **Configuration synchronization is easy to miss.** An incremental package that synchronizes only compiled artifacts and not `*.yml` files produces a silent failure where the configuration compiles but does not take effect.
4. **Interface automation requires accessibility permission.** UI automation testing depends on accessibility authorization; without it, only process-level verification is possible.

### 15.4 Documentation Limitations

1. No independent benchmark has been performed. Chapter 12 discloses only deterministic data.
2. Some third-party packages lack an independent copyright line in their license files, so the copyright holder field is recorded as "See bundled LICENSE".

---

## 16. Changelog

### 1.0.1 (Current)

**Documentation and compliance**

- Established the complete documentation system: Chinese primary version, full English version, and open-source compliance notice.
- Changed the project license from upstream MIT to AGPL-3.0, preserving the upstream copyright notice in NOTICE.
- Disclosed all 121 runtime dependencies and 75 development-only dependencies individually.

**Engineering**

- Synchronized the application package version to 1.0.1.
- Removed residual non-target language files.

**Known incomplete work**

- Companion capabilities (affect, memory, relationship stages) are not ported. See Chapter 15.
- Systematic review of the plugin disable list has not been performed.

### 1.0.0

**Baseline**

- Established the customization baseline against DeepSeek Harness `0.2.2-alpha.2`, commit `81e326b1`.
- Brand reshaping: product name, application identifier, icon, first-run resources.

**Interface**

- Persistent third column: all collapse intents converged at the state layer, the collapse gate removed from the render layer, and the collapse control removed.
- Empty-state third column: renders a placeholder panel when no session exists.
- Interface copy trimming: deleted 1765 language files, retaining only Chinese and English, with English as the fallback.
- Shortcut removal: deleted the standalone package, retaining an inert service seat.
- First-run sign-in replaced with direct workspace entry.

**Data**

- Workspace path fixed at `~/.ondra/workspace`, no longer reading the system Documents directory.
- Migrated the workspace registry, session directory names, and the `cwd` field inside sessions.
- Automatically opens the most recent session at startup.

**Build**

- Adapted to the local Node.js 24 toolchain and memory parameters.
- Icon rebuilt to Apple HIG optical proportions and replaced in the application bundle.

---

## 17. Roadmap

The following is directional planning, not a delivery commitment. Items are ordered by dependency.

### 17.1 Near Term (1.0.x)

1. **Residual cleanup.** Delete the 36 redundant language files and rewrite failing sidebar tests to verify "always expanded" semantics.
2. **Remove ineffective entries.** Delete the workspace selection interaction in `ui-conversation`.
3. **Finalize the icon.** Compare side by side with system icons and settle the base ratio.
4. **Review plugin disables.** Build a three-way verification script across the disable list, preset membership, and service contracts to eliminate latent capability gaps.

### 17.2 Mid Term (1.1)

1. **Port companion capabilities.** Introduce persona composition, long-term memory, and affect state in that order, because affect requires a timeline that memory supplies.
2. **Redesign the third column.** The current third column is a multi-tab container; the target form is a fixed panel covering status, relationship, memory, and desktop pet. The coexistence model must be decided first: a new permanent tab, or a separate slot.
3. **Open-source the build scripts.** Package the incremental build scripts as in-repository tools to lower the barrier for secondary development.

### 17.3 Long Term

1. **Cross-platform verification.** Complete hardware verification for Windows x64 and macOS Intel.
2. **Plugin ecosystem.** Improve the plugin market index and installation flow.
3. **Multimodality.** Voice input and avatar presentation.

---

## 18. Contributing

### 18.1 Reporting Issues

Include the following. Issues missing this information are difficult to diagnose:

1. Operating system version and architecture.
2. Application version, visible in the About page.
3. Reproduction steps, described from launch onward.
4. Expected and actual results.
5. Relevant logs. Session-related issues must state whether the session was newly created or pre-existing.

### 18.2 Contributing Code

1. Branch from `main` using the `feat/`, `fix/`, `docs/`, or `chore/` prefix.
2. Any TypeScript change must pass compilation verification with exit code 0.
3. Any change to runtime behavior must be verified by actually launching the application. Compilation alone is insufficient proof of usability.
4. When changing plugin configuration, confirm that the preset member set intersected with the disable list is empty.
5. When changing session file handling, rebuild frame by frame. Never decompress and rewrite the whole file.
6. Commit messages must state what changed and why, without inflated language.
7. Changes involving destructive operations (deleting, moving, or overwriting user data) must state the impact scope and recovery path in the commit message.

### 18.3 Contributing Documentation

1. Chinese is the primary documentation language. The English version must correspond chapter by chapter and must not be a summary.
2. Define each term at first occurrence.
3. Attribute third-party content to its source and state the license.
4. Every numeric value must be reproducible; non-reproducible values must state their measurement conditions.

### 18.4 License Constraints

This project is released under AGPL-3.0. Submitting code agrees to license your contribution under the same terms. If a contribution includes third-party code, state its source and license in the submission and confirm compatibility with this project's license.

---

## 19. Copyright and License

### 19.1 Project Copyright

Copyright © 2024–2026 Ntarstudio (星玖工作室). All Rights Reserved.

This project is released under the GNU Affero General Public License v3.0 (AGPL-3.0). The full license text is in [LICENSE](LICENSE).

The core obligation of AGPL-3.0: when distributing this software or a modified version, you must make the complete source code available; if you provide the software as a network service, you must also make the source available to users. All modifications in this project are subject to the same obligation.

### 19.2 Upstream Copyright

This project is built on DeepSeek Harness. The upstream copyright notice follows and is preserved in full:

```
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 19.3 Brand and Design Assets

The application icon, brand visuals, the product names 空谷 and Ondra, and the website content are assets owned by Ntarstudio and distributed with this project under AGPL-3.0. AGPL-3.0 grants rights over code, not trademark rights. Redistributions must not use this project's name or icon to imply official endorsement.

### 19.4 Disclaimer

This software is provided "as is", without warranty of any kind, express or implied. To the maximum extent permitted by applicable law, the authors and copyright holders accept no liability for any damages arising from use of this software, including but not limited to data loss, device damage, or business interruption.

This product is a companionship tool, not a substitute for psychotherapy, medical care, or professional advice. In-application personas are fictional character settings and do not represent the position of any real person.

---

## 20. NOTICE and Open-Source Compliance

The complete open-source compliance notice is in [NOTICE](NOTICE) and complements this chapter. NOTICE contains:

1. The project's copyright and license statement, including the English legal text of AGPL-3.0.
2. The full MIT license and copyright notice of upstream DeepSeek Harness.
3. Ownership and derivation notes for brand and design assets.
4. Item-by-item disclosure of source-vendored dependencies (`vendor/`, 9 items), including upstream commits and local modifications.
5. Item-by-item disclosure of runtime dependencies (121 items), including version, license, copyright holder, and repository.
6. Disclosure of development-only dependencies (75 items) and the non-distribution statement.
7. Disclosure of non-npm dependencies (Node.js runtime, Python distributions, Python SDK, platform payloads).
8. Compatibility analysis and obligation statements for non-permissive license components.

### 20.1 Compliance Checklist

| Item | Status |
| --- | --- |
| Upstream MIT copyright notice preserved | Preserved, see 19.2 and NOTICE |
| Project copyright statement | Declared, AGPL-3.0 |
| Runtime dependency disclosure | 121 items, see 6.3 and NOTICE |
| Development dependency disclosure | 75 items, see 6.4 and NOTICE |
| Transitive dependency disclosure | Recorded in `pnpm-lock.yaml`, reviewable with `pnpm licenses list` |
| Source-vendored dependency disclosure | 9 items, see NOTICE and `vendor/README.md` |
| Third-party license texts | Preserved alongside each package in `node_modules`; vendored items retain their own `LICENSE` |
| Annotation of modified third-party code | Vendored items recorded in `vendor/README.md`; upstream code changes appear in this document and the commit history |
| Asset provenance | Icon and brand assets are original designs; no third-party assets used |
| Unconfirmed copyright ownership | Marked "See bundled LICENSE" in the dependency list; no inference made |

### 20.2 Verification Commands

```bash
# Verify the third-party notice matches the dependency tree
pnpm run verify-third-party-notices

# Regenerate the third-party notice
pnpm run gen-third-party-notices

# List licenses for all dependencies
pnpm licenses list

# Verify package metadata
pnpm run verify-package-meta
```

---

## Appendix: Related Documents

| Document | Content |
| --- | --- |
| [README.md](README.md) | Chinese primary version, corresponding chapter by chapter |
| [NOTICE](NOTICE) | Open-source compliance notice and full dependency disclosure |
| [LICENSE](LICENSE) | Full AGPL-3.0 text |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | Generated third-party dependency list |
| [SAFETY.md](SAFETY.md) / [SAFETY.zh.md](SAFETY.zh.md) | Safety notice |
| [AGENTS.md](AGENTS.md) | Repository conventions for automation |
| [packages/README.md](packages/README.md) | Package group documentation |
| [vendor/README.md](vendor/README.md) | Upstream commits and modification records for vendored dependencies |
