# Loadable Harness plugin packages

This file is GENERATED from workspace manifests (`scripts/gen-plugin-packages.ts`) and verified fresh by `pnpm run verify-plugin-packages` (part of `doc-sync`); do not edit it by hand.

Every package below exports a Cordis plugin that a bundle patch can name in a Loader row. `Config` marks packages whose row accepts a `config` mapping; query `Config.listConfigs` through `cordis_inspect_query` (filter by `name`, then query the `entry` id) for the mounted schema. Packages under `experimental` are pre-stable.

## acp

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-acp` | yes | Automation-only Agent Client Protocol server for driving Ondra agents over JSON-RPC stdio |

## api

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-api-account-controller` | no | Expose safe account operations over authenticated Remote |
| `@ntars/ondra-api-gateway` | yes | Typert Remote Host dispatcher and Client API endpoint |
| `@ntars/ondra-api-job-controller` | yes | Job Remote observation stream and the reference-counted client job-output service |
| `@ntars/ondra-api-remote-access` | no | Method-level Remote access control for non-owner Peers and the per-Peer access snapshot |
| `@ntars/ondra-api-remotes` | no | Remote BFF assembly for application-selected Host capabilities |
| `@ntars/ondra-api-session-controller` | yes | Session Remote commands, cold reads, and live control transport |
| `@ntars/ondra-api-settings-controller` | yes | Remote owner for the configuration surfaces over the settings-domain seams |
| `@ntars/ondra-api-terminal-controller` | yes | Session-owned interactive terminals with shell discovery, screen recovery and typed Remote control |
| `@ntars/ondra-api-workspace-controller` | yes | Workspace Remote commands and reconnect-safe state transport |
| `@ntars/ondra-api-workspace-files` | yes | Workspace file service and Client resource provider: bounded reads, directory listing, and live metadata over the workspaceFiles Remote namespace |

## attachment

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-attachment-local` | yes | Private content-addressed ONDRA_HOME attachment storage |

## boot

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-config-editor` | no | Persist plugin configuration through profile patches and Loader reconciliation |
| `@ntars/ondra-hmr` | yes | Coordinated module and profile configuration hot reload |
| `@ntars/ondra-plugin-manager` | yes | Current-profile plugin and bundle management shared by ondra CLI, Web and agent tools |
| `@ntars/ondra-plugin-market` | yes | Configured plugin market indexes for the Web Discover page and the plugin_market agent tool |

## browser-use

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-browser-use` | no | Exclusive named browser-use provider registration |

## bundle

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-acp-app` | no | The ondra ACP profile bundle: automation-only JSON-RPC stdio and process lifecycle over ondra base |
| `@ntars/ondra-headless` | yes | The ondra one-shot bundle: a direct core Agent/Session runner over ondra base with no Host, HTTP, or browser layer |
| `@ntars/ondra-sdk-app` | yes | The ondra SDK profile bundle: stdio JSON-RPC serving and process lifecycle over ondra base |
| `@ntars/ondra-web-app` | yes | The ondra browser-surface bundle: the web patch layer over ondra base plus the runtime glue plugin (frontend dist serving, bash runtime variables, URL line) |

## client

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-client-connection` | yes | Authenticated RPC transport and generation lifecycle |
| `@ntars/ondra-client-file-upload` | no | Agent-scoped browser file upload, streaming intake, and staged receipt service |
| `@ntars/ondra-client-hmr` | yes | Web client graph synchronization and rebuilt-bundle reload transport |
| `@ntars/ondra-client-locale` | no | Locale plugin: Host-backed preference, extensible language catalog, browser fallback, and typed built-in dictionaries |
| `@ntars/ondra-client-modules` | no | Client module system, dual-face: node half composes the __ONDRA_BOOT__ entry graph (incremental ondra.client scan, bundle route, index tap, webPlugins service); browser half is the lazy-CJS module table the vendored cordis Loader consumes as its internal seam |
| `@ntars/ondra-client-product-analytics` | yes | Desktop product event collection and authenticated Host reporting |
| `@ntars/ondra-client-resources` | no | Unified client resource model: protocol-registered providers turn URL addresses into live values, consumed through the useResource global standard hook |
| `@ntars/ondra-client-shortcuts` | yes | Application keyboard command registry and physical-key routing |
| `@ntars/ondra-client-ui-agent-preset` | no | Agent-preset surfaces: the default for later sessions, this session's seat, and the composition editor |
| `@ntars/ondra-client-ui-approval` | no | Approval composer takeover over the scoped Remote Event waterfall |
| `@ntars/ondra-client-ui-attachment` | no | Dynamic attachment presentation plugin for conversation input, message-image, and trajectory image slots |
| `@ntars/ondra-client-ui-brand-official` | no | Official Ondra brand occupants for the Web client's sidebar slots |
| `@ntars/ondra-client-ui-chat` | no | Chat Conversation target, node definitions, renderers, and details surface |
| `@ntars/ondra-client-ui-commands` | no | Client command surface: global directory cache, '/' source, three command UI kinds, popupSelect registry |
| `@ntars/ondra-client-ui-conversation` | no | Target-neutral Conversation assembly, shell, composer, queue, and view navigation |
| `@ntars/ondra-client-ui-deliverables` | no | Changed-files card with per-file comparison tabs, delivery cards, and clickable final-response file references for Web |
| `@ntars/ondra-client-ui-directory-picker-browse` | no | In-app directory browsing surface: the workspace directory-flow owner rendering the host's listing and creation primitives |
| `@ntars/ondra-client-ui-directory-picker-native` | no | Native directory-picker surface: the renderless workspace directory-flow occupant driving the local Desktop or Host OS chooser |
| `@ntars/ondra-client-ui-entry-customization` | no | Customize plugin entries in the left sidebar, conversation views, and right sidebar, and quickly create new plugins. |
| `@ntars/ondra-client-ui-file-drag` | no | Application-owned file drag transfers and localized failure feedback |
| `@ntars/ondra-client-ui-goal` | no | Session goal surface: GoalBar docked above the composer, read from the goal session projection |
| `@ntars/ondra-client-ui-input-trigger` | no | Input trigger pipeline: '/' and '@' detection, candidate menu, pick routing to registered sources |
| `@ntars/ondra-client-ui-jobs` | no | Session-header background-job list with on-demand streaming record panels |
| `@ntars/ondra-client-ui-layout` | no | Shell plugin: three-column AppFrame with drag handles, ctx.layout viewing-state service (navigation + panels) |
| `@ntars/ondra-client-ui-message-feedback` | no | The Web feedback surface: per-message Like/Dislike in the assistant-message action strip and the feedback dialog behind both ratings and /feedback, backed by the messageFeedback and sessionFeedback Host Remotes |
| `@ntars/ondra-client-ui-model-selection` | no | Model selection over the shared model catalog, Session projection, and session.selectModel |
| `@ntars/ondra-client-ui-open-in-app` | no | Web "Open In..." controls: the Session-header split button opening the workspace directory in an installed application, and the document preview's default-application controls for one file |
| `@ntars/ondra-client-ui-permission-presets` | no | Permission surfaces: a new-session default in General settings and a current-session /permission popup over the permissions projection |
| `@ntars/ondra-client-ui-plan` | no | Plan mode controls, persistent transcript plan cards, and sidebar Markdown previews |
| `@ntars/ondra-client-ui-plugin-manager` | yes | Plugin management for the ondra web client: the sidebar Plugins panel installs, enables, disables, retries, and composes installed plugin packages |
| `@ntars/ondra-client-ui-plugin-market` | no | Discover tab of the ondra web Plugins page: browse configured plugin market indexes and install their bundles |
| `@ntars/ondra-client-ui-reference` | no | Unified Web @file and @session reference source |
| `@ntars/ondra-client-ui-renderer` | no | Browser UI renderer: React slot bindings, ctx.uiRenderer, and the assembled application root |
| `@ntars/ondra-client-ui-schedule` | no | Host task management page and Session reminder catalog |
| `@ntars/ondra-client-ui-secret-mask` | no | Web display masking for recognized credentials in sent user text |
| `@ntars/ondra-client-ui-session` | no | Session Controller adapter for React and session-scoped slots |
| `@ntars/ondra-client-ui-settings` | no | Settings domain base plugin: shared configuration forms and the canonical settings slot-type contract |
| `@ntars/ondra-client-ui-settings-account` | yes | Manage DeepSeek login and open Platform billing pages |
| `@ntars/ondra-client-ui-settings-agent-loop` | no | Settings page of the agent loop on the ondra web client's Plugins page: the parallel tool-call cap of the agent-loop namespace |
| `@ntars/ondra-client-ui-settings-general` | no | Settings ownerless-copy and product onboarding plugin: the General section, shell trigger/header chrome content, settings dictionaries, and the versioned welcome notice |
| `@ntars/ondra-client-ui-settings-models` | yes | Models settings and shared product-onboarding dialogs over existing settings and credential joins |
| `@ntars/ondra-client-ui-settings-plugin-inventory` | no | Read-only Cordis Loader inventory tab in Web Plugins settings |
| `@ntars/ondra-client-ui-settings-plugins` | no | Built-in plugins settings section for the ondra web client: the Settings navigation entry and the tab chrome feature-owned tabs register into |
| `@ntars/ondra-client-ui-settings-session-log` | no | General settings control for Session-log upload with DeepSeek API requests |
| `@ntars/ondra-client-ui-settings-shell` | no | Settings page of the shell executor on the ondra web client's Plugins page: the command timeout and the per-stream output cap of the shell namespace |
| `@ntars/ondra-client-ui-settings-subagent` | no | Settings page of Subagent delegation on the ondra web client's Plugins page: recursion depth, parallel capacity, and the models agents may choose for subagents |
| `@ntars/ondra-client-ui-settings-web-search` | no | Settings page of the DeepSeek web-search provider on the ondra web client's Plugins page: its API key, endpoint, and per-request search budget |
| `@ntars/ondra-client-ui-shortcuts` | no | Keyboard shortcut reference, recording, and local preference editing |
| `@ntars/ondra-client-ui-sidebar` | no | Sidebar plugin: session multi-level tree, search, grouping, state dots |
| `@ntars/ondra-client-ui-sidebar-browser` | no | Sandboxed Web browser tabs for the right Sidebar |
| `@ntars/ondra-client-ui-sidebar-documentpreview` | yes | Extensible Sidebar previews for Office documents, spreadsheets, Markdown, code, images, PDF, HTML, and plain text |
| `@ntars/ondra-client-ui-sidebar-files` | no | Workspace file tree tab type for the right Sidebar: lazy directory listing over the workspaceFiles Remote namespace, opening files into the Sidebar |
| `@ntars/ondra-client-ui-sidebar-right` | no | Right Sidebar: the docking surface's session-bound state, its panel and header expand control, and the navigation service over it |
| `@ntars/ondra-client-ui-sidebar-terminal` | no | Interactive shell tabs for the right Sidebar |
| `@ntars/ondra-client-ui-skill` | no | Web skill references and the dedicated skill tool row |
| `@ntars/ondra-client-ui-subagent` | no | Subagent conversation catalog, continuation routing UI, and '@' reference source |
| `@ntars/ondra-client-ui-theme` | yes | Theme plugin: Host bootstrap for the pre-plugin palette; ThemeRuntime for light/dark/system state and icon replacements; --dsw-* token styles and Appearance settings row |
| `@ntars/ondra-client-ui-tool` | no | Client Tool call-tree renderer and keyed per-tool presentation slot |
| `@ntars/ondra-client-ui-trajectory` | yes | Trajectory event ledger and timing overview with live tool-result inspection |
| `@ntars/ondra-client-ui-user-questions` | no | Web ask_user_question composer takeover and plan-review presentation UI |
| `@ntars/ondra-client-ui-workflow-run` | no | Durable workflow-run Conversation Node and nested member disclosure for ondra web |
| `@ntars/ondra-client-ui-workspace` | no | Workspace picker plugin: one WorkspacePicker registered into the sidebar and empty-state workspace slots |

## compaction

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-command-compact` | no | Human-facing slash command for explicit session compaction |
| `@ntars/ondra-compaction-basic` | yes | Token-meter-driven compaction policy and LLM summarization backend for the Ondra |
| `@ntars/ondra-compaction-image-offload` | no | Durable image offload for image-capable routes: replace over-budget request images with placeholders and retry |
| `@ntars/ondra-compaction-tool-result-pruner` | yes | Replay-safe model-free head/middle/tail pruning for tool-result surface nodes |

## computer-use

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-computer-use` | no | Exclusive named computer-use provider registration |

## context

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-agent-instructions` | yes | Workspace context loader for AGENTS.md/CLAUDE.md instruction files |
| `@ntars/ondra-file-reference-local` | yes | Local-filesystem ctx.fileReferences provider with bounded fuzzy indexes |
| `@ntars/ondra-dev-context` | no | Model context naming the Ondra checkout and Web GUI URL without letting either change the system prompt |
| `@ntars/ondra-session-reference` | yes | Cross-session snapshot references and durable untrusted model context (ctx.sessionReferenceResolver) |
| `@ntars/ondra-time-context` | yes | Durable per-step context with the current time and elapsed time |
| `@ntars/ondra-tmux-context` | yes | Opt-in durable per-step context with this agent's tmux pane and window location |

## core

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-agent` | no | Agent interface, registry, initiator scope, and event vocabulary for the Ondra |
| `@ntars/ondra-agent-default-model` | yes | Default model selection shared by Agent entry points |
| `@ntars/ondra-agent-loop` | yes | The concrete agent loop plugin for the Ondra |
| `@ntars/ondra-agent-tool-presentation` | yes | Deprecated tool presentation selector; use ondra-tool-executor-native or ondra-tool-executor-ptc directly |
| `@ntars/ondra-session` | no | Event-sourced session store for the Ondra |
| `@ntars/ondra-system-prompt` | yes | System prompt assembly registry for the Ondra |
| `@ntars/ondra-tool-executor-native` | no | Native tool execution plugin |
| `@ntars/ondra-tool-executor-ptc` | yes | PTC program execution, tool bindings, and generated SDK prompts |
| `@ntars/ondra-tools` | no | Tool registry and execution pipeline for the Ondra |

## credentials

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-authorization` | no | Authorization seam (ctx.authorization): plugin-owned flows that obtain a credential through a conversation with the human |
| `@ntars/ondra-credentials-local` | yes | File-backed credentials provider ($ONDRA_HOME/.env under the live process environment) for the Ondra |
| `@ntars/ondra-deepseek-account-platform` | yes | Authorize DeepSeek accounts through browser PKCE |

## deliverables

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-deliverable-file-references` | no | Shared model guidance for file links and deliverables across Ondra hosts |
| `@ntars/ondra-tool-present` | yes | Explicit workspace file delivery declarations for the Ondra |
| `@ntars/ondra-workspace-changes` | yes | Per-turn workspace file changes recorded from git working-tree snapshots and whole-file captures, with per-file comparisons, for the Ondra |

## document

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-office-to-pdf` | yes | Shared Office-to-PDF conversion with bounded queues and caching |

## experimental

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-action-cards` | yes | Optional action cards below answers: one shared proposal tool, card state, user actions and status notices |
| `@ntars/ondra-client-ui-action-cards` | no | Action cards below completed answers: the shared card frame, kind bodies and the compact tool row |
| `@ntars/ondra-client-ui-creation-recommendations` | no | Body of the personalized page card: location choice, creation progress, Keep, Undo and Restore |
| `@ntars/ondra-client-ui-plugin-recommendations` | no | Official plugin card body with catalog text and enabling |
| `@ntars/ondra-creation-recommendations` | no | Create persistent removable interface plugins from explicit conversation needs |
| `@ntars/ondra-cua` | no | Shared Computer Use application objects, authorization, and logged tool execution |
| `@ntars/ondra-experimental-agent-team` | yes | Implicit-root Agent Teams roster, direct peer messaging, and shared task DAG |
| `@ntars/ondra-experimental-api-speech-to-text` | yes | Authenticated experimental speech transcription for browser clients |
| `@ntars/ondra-experimental-auto-review` | no | Per-tool LLM authorization review for the Ondra Auto permission preset |
| `@ntars/ondra-experimental-browser-use-chrome-devtools-mcp` | yes | Experimental per-Session Chromium browser tools through chrome-devtools-mcp |
| `@ntars/ondra-experimental-browser-use-playwright-mcp` | yes | Experimental per-Session Chromium browser tools through @playwright/mcp |
| `@ntars/ondra-experimental-browser-use-stagehand-native` | yes | Experimental Stagehand browser tools with separately configured native models |
| `@ntars/ondra-experimental-claude-code-mods` | yes | Experimental bridge: load Claude Code mods (hooks modules) and run their hook chains on Ondra extension points |
| `@ntars/ondra-experimental-client-ui-agent-team` | no | Web Agent Teams roster, task board, and teammate navigation |
| `@ntars/ondra-experimental-client-ui-claude-code-mods` | no | Web band above the prompt for Claude Code mods: draws each session's mod tree and sends button presses back to the bridge |
| `@ntars/ondra-experimental-client-ui-cot-translation` | yes | Optional machine translation of expanded reasoning, preserving original Session text |
| `@ntars/ondra-experimental-client-ui-forge` | yes | Sidebar panel for a Session's change requests, with a worktree option for new Sessions and its Host Remote |
| `@ntars/ondra-experimental-client-ui-stats` | no | Per-turn and per-step context, timing, cache, and tool-cost table contributed as an experimental conversation View |
| `@ntars/ondra-experimental-client-ui-voice-input` | no | Record speech and insert editable text into the conversation draft |
| `@ntars/ondra-experimental-computer-use-cua-driver-mcp` | yes | Experimental computer use through an installed Cua Driver MCP executable |
| `@ntars/ondra-experimental-computer-use-cua-driver-native` | no | Experimental computer-use provider embedding the Cua Driver native npm SDK |
| `@ntars/ondra-experimental-cua-macos` | yes | macOS native provider for shared Computer Use application and window objects |
| `@ntars/ondra-experimental-forge` | yes | Provider-neutral change request registry with shared status polling |
| `@ntars/ondra-experimental-forge-github` | yes | GitHub provider for the experimental forge registry, read through the GitHub CLI on the host |
| `@ntars/ondra-experimental-forge-session` | yes | Binds change requests to the Session that created, pushed, or tracked them |
| `@ntars/ondra-experimental-inspector` | yes | Experimental cross-realm CDP hub for Host debugging and Client Runtime inspection |
| `@ntars/ondra-experimental-ptc-runtime-python` | yes | CPython subprocess implementation of the Ondra PTC execution seam |
| `@ntars/ondra-experimental-session-inspector` | no | Experimental virtualized Session log and live Chat group/node inspectors |
| `@ntars/ondra-experimental-speech-to-text` | yes | Experimental speech recognition with independently selectable providers |
| `@ntars/ondra-experimental-speech-to-text-sensevoice` | yes | Local SenseVoice ONNX transcription with a managed sherpa-onnx process |
| `@ntars/ondra-experimental-subagent-oar` | yes | Experimental one-shot subagents through OAR runtimes |
| `@ntars/ondra-experimental-tool-agent-team` | yes | Scoped model-facing Agent Teams tools over ctx.agentTeams |
| `@ntars/ondra-experimental-tool-subagent-oar` | yes | Delegate standalone tasks to configured external subagent providers |
| `@ntars/ondra-experimental-tool-worktree` | no | Model tool that creates and enters a new Git worktree |
| `@ntars/ondra-experimental-translator` | yes | Machine translation with reusable Session results |
| `@ntars/ondra-experimental-worktree` | yes | Creates a named Git worktree and changes the calling Session working directory |
| `@ntars/ondra-hooks-claude-code` | yes | Bridge plugin: run a Claude Code hooks.json / settings hook config on the Ondra interception seams |
| `@ntars/ondra-hooks-codex` | yes | Bridge plugin: run a Codex hooks.json hook config on the Ondra interception seams |
| `@ntars/ondra-plugin-recommendations` | no | Official plugin suggestions with explicit user activation and persistent conversation decisions |
| `@ntars/ondra-session-title-all-prompts-llm` | yes | All-user-messages LLM provider plugin for Ondra session titles |
| `@ntars/ondra-skill-badge` | no | Bundled ondra badge skill provider for Ondra |
| `@ntars/ondra-tool-ralph` | yes | Model-facing fresh-agent Ralph loop over the workflow and subagent seams |
| `@ntars/ondra-tool-session-query` | yes | Workspace-authorized model-facing session history search, trace, and event read tools |
| `@ntars/ondra-tool-terminal` | yes | Six model-facing persistent PTY tools with owner isolation and generic background-job integration |
| `@ntars/ondra-webhook` | no | Fire-and-forget webhook rule runtime that creates Workspace-backed Ondra Sessions |
| `@ntars/ondra-webhook-github` | yes | Signed GitHub HTTP webhook adapter for the Ondra webhook runtime |

## extensions

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-client-ui-cordis` | no | Cordis dynamic-plugin definition card: the keyed cordis_define tool row with its run/stop switch |
| `@ntars/ondra-cordis-client-runner` | no | Browser half of dynamic dual-half plugin packages: event subscription, closure evaluation, guard facade, and loader entries |
| `@ntars/ondra-cordis-host-runner` | yes | Dynamic package definition registry, host-half sandbox lifecycle, and invoke handler table for model-mounted dual-half packages |
| `@ntars/ondra-tool-cordis` | no | Read-only runtime API inspection for Harness plugin development |

## feedback

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-command-feedback` | no | Log-only session feedback: the record event, the sessionFeedback Host Remote, and the human-facing slash command |
| `@ntars/ondra-message-feedback` | yes | Canonical Session-log ratings and notes for finalized assistant messages |

## fs

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-fs-local` | yes | Local-filesystem implementation of the Ondra filesystem seam (ctx.fs) |
| `@ntars/ondra-fs-observation-policy` | no | File-context policy plugin for the Ondra — observed-state, read-before-edit, and version-guarded write/edit added over the ctx.fs provider seam through the fs/* event gate (no service API) |
| `@ntars/ondra-fs-sandbox` | yes | Sandbox-enforcing implementation of the Ondra filesystem seam: fences write/edit by the per-call sandbox mode (read-only denies mutation, workspace-write contains it to the workspace + temp roots) while reads pass through |
| `@ntars/ondra-tool-fs` | yes | Model-facing filesystem tools (read, write, edit) over the Ondra filesystem seam (ctx.fs) |
| `@ntars/ondra-tool-fs-search` | yes | Model-facing filesystem discovery tools (glob, grep) backed by the packaged ripgrep binary (@vscode/ripgrep) |
| `@ntars/ondra-tool-str-replace-editor` | yes | Model-facing view, create, literal replace, and line insert tool over the Harness filesystem service |

## goal

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-command-goal` | no | Human-facing slash command for persisted same-session goals |
| `@ntars/ondra-goal` | yes | Event-sourced same-session goal state and lifecycle service for the Ondra |
| `@ntars/ondra-goal-round-driver` | no | Race-fenced same-session goal-round driver |
| `@ntars/ondra-tool-goal` | yes | Model-facing same-session goal tools with execution-time authority checks |

## guard

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-repeat-tool-reminder` | yes | Repeat-tool-call guard plugin: advisory reminders when an agent loops on identical tool calls |
| `@ntars/ondra-tool-call-timeout-policy` | no | Tool-call timeout policy: a tools/execute wrapper that arms a per-tool deadline on exec.signal and returns TOOL_TIMEOUT when it wins |

## host

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-host-directory-picker-auto` | no | Adaptive chooser of the directory-picker seam: resolves the host situation at boot and mounts the native or browse backend for the Ondra web GUI host |
| `@ntars/ondra-host-directory-picker-browse` | yes | In-app browsing backend of the directory-picker seam (listing/creation primitives over the host filesystem) |
| `@ntars/ondra-host-directory-picker-native` | no | Native-OS-chooser backend of the directory-picker seam for the Ondra web GUI host |
| `@ntars/ondra-host-frontend-static` | yes | SPA dist server for the Web shell: owns the webserver fallback seat, serving explicit index entries and static assets with traversal rejection and 404 misses |
| `@ntars/ondra-host-open-in-app` | yes | Host half of open-in-app: resolved application catalog, icons, and the launch endpoint as three webServer routes |
| `@ntars/ondra-host-plugin-inventory` | no | Read-only Remote projection of current Cordis Loader plugin state |
| `@ntars/ondra-host-product-telemetry-otel` | yes | Explicit product usage events exported through OpenTelemetry HTTP logs |
| `@ntars/ondra-host-webserver` | yes | Web route-registration plugin: HTTP and upgrade routes, per-Peer index transform taps, and static dist fallback |

## interaction

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-commands` | no | Plugin-owned human command registry for Ondra UIs |
| `@ntars/ondra-permission-presets` | yes | User-facing permission presets (ctx.permissionPresets) for the Ondra: one product-level Permissions select bundling the sandbox-mode and approval-policy knobs, written through to their own session events |
| `@ntars/ondra-tool-ask-user` | yes | Model-facing ask_user_question tool over the ctx.userQuestions seam |
| `@ntars/ondra-user-approval` | yes | User-approval seam (ctx.approval) for the Ondra: one-shot permission decisions dispatched to composed answerers over the approval/request waterfall, fail-closed by default |
| `@ntars/ondra-user-questions` | no | Abstract user-questions seam (ctx.userQuestions) for asking the human during agent runs |

## jobs

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-jobs-local` | yes | Process-local implementation of the Ondra background job registry seam |
| `@ntars/ondra-tool-jobs` | yes | Model-facing background job control tools (job_output, job_list, job_kill) over the ctx.jobs registry |

## llm

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-deepseek-llm-api-extensions` | no | Additive request-field registry for the official DeepSeek LLM API adapter |
| `@ntars/ondra-llm` | no | Provider-neutral LLM service interface for the Ondra |
| `@ntars/ondra-llm-deepseek-account` | yes | DeepSeek account provider authentication and discovery |
| `@ntars/ondra-llm-deepseek-api-key` | yes | DeepSeek api-key provider authentication and discovery |
| `@ntars/ondra-llm-pi-ai` | yes | pi-ai-backed DeepSeek adapter for the Ondra LLM seam (design-verification twin of ondra-llm-deepseek) |
| `@ntars/ondra-llm-retry` | yes | Provider-routed LLM request retry policy for the Ondra |
| `@ntars/ondra-plugin-package-inventory-deepseek` | yes | Active Loader-backed plugin package inventory for official DeepSeek LLM API requests |
| `@ntars/ondra-token-meter` | yes | Replay-aware token measurement service (ctx.tokenMeter) for the Ondra |

## lsp

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-lsp` | no | Abstract LSP capability seam (ctx.lsp) for the Ondra — language-server provider registry keyed by branded id and extension mapping, order-independent per-query selection, normalized definition/references/implementation/hover requests and results, and the LspError taxonomy |
| `@ntars/ondra-lsp-stdio` | yes | Generic stdio language-server provider for the Ondra LSP capability seam (ctx.lsp) — spawns configured servers, translates JSON-RPC, and serves transient-open goToDefinition/findReferences/goToImplementation/hover queries in the host filesystem namespace |
| `@ntars/ondra-tool-lsp` | yes | Model-facing lsp tool over the Ondra LSP capability seam (ctx.lsp) — one read-only tool with goToDefinition/findReferences/goToImplementation/hover operations, one-based UTF-16 cursor coordinates, bounded location rendering, and hover normalization |

## mcp

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-mcp-client` | yes | MCP client bridge: connects to MCP servers and registers their tools on ctx.tools |
| `@ntars/ondra-mcp-resources` | no | Scoped MCP resource discovery and reading through shared model tools |

## plan

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-plan-mode` | yes | Logged per-agent plan mode with deployment guidance, a direct slash command, and a user-reviewed exit |

## preset

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-agent-preset` | yes | Declare an Agent capability composition in Cordis YAML |
| `@ntars/ondra-agent-preset-registry` | yes | Declarative Agent preset registry and profile-backed editing |
| `@ntars/ondra-persona` | yes | Composition-authored deployment persona section for the Ondra |

## ptc-runtime

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-ptc-runtime-node` | yes | Node PTC execution with async function, REPL and VM Script evaluators and optional retained state |

## sandbox

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-sandbox-local` | yes | Local process-sandbox backends for the Ondra sandbox seam: bwrap, the npm-distributed landlock-run launcher, macOS Seatbelt, or the Windows ACL restricted-token runner — functionally probed, fail-closed |
| `@ntars/ondra-sandbox-policy` | yes | Per-call sandbox policy resolver and current model context: deployment fallbacks plus each session's mode and workspace root, shared by every enforcing capability family |

## schedule

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-schedule` | yes | Host-wide durable reminders with shared management and original-Session delivery |
| `@ntars/ondra-tool-schedule` | no | Model-facing reminder management tools (schedule_create, schedule_list, schedule_update, schedule_delete) over the Host ctx.schedule service |

## sdk

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-sdk-jsonrpc-server` | yes | Stdio JSON-RPC server plugin for out-of-process Ondra SDK clients |

## session

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-message-quotes` | no | Selected-text quotation and Markdown blockquote presentation |
| `@ntars/ondra-session-checkpoint-policy` | no | Semantic session durability checkpoints before model requests and tool side effects |
| `@ntars/ondra-session-log-deepseek` | yes | Incremental lossless session-log request extension for the official DeepSeek LLM API |
| `@ntars/ondra-session-persistence-jsonl` | yes | JSONL durable session persistence backend for the Ondra |
| `@ntars/ondra-session-projection` | no | Session-projection seam: the merge-extensible projection type table, the provider contract, and the ctx.sessionProjections registry serving whole current values of log-derived per-session state |
| `@ntars/ondra-session-projection-cache` | yes | Persisted projection cache (ctx.sessionProjectionCache): durable per-session checkpoint records on the session_projcache storage domain (per-record layout), throttled write-behind, and the cached listing read |
| `@ntars/ondra-session-stats` | no | Whole-log conversation counts and wall times projection (sessionStats) for the Ondra |
| `@ntars/ondra-session-telemetry-otel` | yes | Feedback-authorized Session logs over byte-bounded OpenTelemetry HTTP requests |
| `@ntars/ondra-session-title` | yes | Log-backed session title service and provider registry for the Ondra |
| `@ntars/ondra-session-title-first-prompt-llm` | yes | First-message LLM provider plugin for Ondra session titles |
| `@ntars/ondra-session-turn-outline` | no | Whole-log turn outline projection (turnOutline) for the Ondra |
| `@ntars/ondra-tool-working-directory` | no | Read and change the active Session working directory |
| `@ntars/ondra-working-directory` | yes | Session working directories with durable changes and model context |

## session-query

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-session-log-export` | yes | Web Session-log ZIP export and Session Markdown copy |
| `@ntars/ondra-session-query-sqlite` | yes | Concrete ctx.sessionQuery backend with SQLite FTS5 search |

## settings

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-settings` | no | Abstract user-settings seam (ctx.settings) for the Ondra |

## shell

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-bash-local` | yes | Local-subprocess implementation of the Ondra bash executor seam |
| `@ntars/ondra-bash-sandbox` | yes | Sandbox-consuming implementation of the Ondra bash executor seam (confines every command via ctx.sandbox, reports denial/enforcement result facts) |
| `@ntars/ondra-pwsh-local` | yes | Local PowerShell implementation of the Ondra bash executor seam |
| `@ntars/ondra-pwsh-sandbox` | yes | Sandbox-consuming implementation of the Ondra PowerShell executor seam (confines every command via ctx.sandbox, reports denial/enforcement result facts) |
| `@ntars/ondra-shell-env` | yes | Tool-independent managed ONDRA_* shell environment registry |
| `@ntars/ondra-tool-bash` | yes | Model-facing bash tool with optional generic background-job and sandbox-escalation support |
| `@ntars/ondra-tool-bash-persistent` | yes | Model-facing owner-scoped persistent Bash tool backed by the Harness PTY service |
| `@ntars/ondra-tool-pwsh` | yes | Model-facing pwsh tool over the bash executor seam |
| `@ntars/ondra-tool-pwsh-persistent` | yes | Model-facing owner-scoped persistent PowerShell tool backed by the Harness PTY service |

## skill

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-skill` | yes | Agent skill provider registry for the Ondra |
| `@ntars/ondra-skill-filesystem` | yes | Local filesystem skill provider for the Ondra |
| `@ntars/ondra-skill-office` | yes | Bundled Word, PowerPoint, and Excel workflows and LibreOffice Kit operations |
| `@ntars/ondra-tool-skill` | yes | Model-facing skill loading tool for the Ondra |
| `@ntars/ondra-tool-workspace-dependencies` | yes | The load_workspace_dependencies tool: absolute paths into a bundled Python, Node.js, and pnpm payload |

## spill

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-spill-local` | yes | Local-filesystem implementation of the Ondra spill storage seam (private session-scoped files) |
| `@ntars/ondra-spill-policy` | yes | Token-budgeted tool-result retention with recoverable text and image paths |

## ssh

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-fs-ssh` | no | Filesystem provider over the shared POSIX SSH helper |
| `@ntars/ondra-sandbox-ssh` | no | Remote POSIX sandbox argv provider over the shared SSH helper |
| `@ntars/ondra-ssh` | yes | Shared OpenSSH connection and versioned POSIX remote helper |
| `@ntars/ondra-subprocess-ssh` | no | Subprocess and terminal provider over the shared POSIX SSH helper |

## storage

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-storage` | no | Storage hub (ctx.storage): named backend registry plus mounted data-form facilities for the Ondra |
| `@ntars/ondra-storage-domain` | yes | Domain data form (ctx.storage.domain): schema-validated, event-emitting KV domains over storage backends for the Ondra |
| `@ntars/ondra-storage-json` | yes | JSON file KV storage backend for the Ondra storage hub |
| `@ntars/ondra-storage-sqlite` | yes | SQLite storage backend (kv facet) for the Ondra storage hub |

## subagent

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-subagent` | yes | Abstract subagent seam (ctx.subagents): named-provider registry for delegating to child agents |
| `@ntars/ondra-subagent-acp` | yes | Out-of-process ACP subagent backend: drives a child agent in a spawned subprocess over the Agent Client Protocol |
| `@ntars/ondra-subagent-claude-code` | yes | One-shot Claude Code subagent provider over the official Agent SDK |
| `@ntars/ondra-subagent-codex` | yes | One-shot Codex subagent provider over the official app-server protocol |
| `@ntars/ondra-subagent-sdk` | yes | Out-of-process SDK subagent backend: drives a child Ondra runtime subprocess over stdio JSON-RPC through the TypeScript SDK client |
| `@ntars/ondra-subagent-fork-in-process` | yes | In-process fork subagent backend: runs a child agent seeded with a prefix of the parent's log |
| `@ntars/ondra-subagent-spawn-in-process` | yes | In-process spawn subagent backend: runs a fresh child agent on ctx.agents |
| `@ntars/ondra-tool-subagent` | yes | Model-facing subagent delegation tool over the ctx.subagents seam |
| `@ntars/ondra-tool-subagent-control` | no | Shared messaging, interruption, and child discovery tools for subagents |

## subprocess

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-subprocess-local` | no | Local-subprocess implementation of the Ondra subprocess seam |

## telemetry

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-otel` | no | Cordis service for independent ordinary-event and byte-bounded Session-log OTLP channels |

## terminal

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-terminal` | no | Persistent PTY session seam for the Ondra — owner-scoped ids, backend registry, interactive sends, reads, signals, and awaited cleanup |
| `@ntars/ondra-terminal-bash` | yes | Persistent shell PTY backend over the Ondra subprocess terminal primitive |

## test-support

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-llm-replay` | yes | Replay LLM plugin: short-circuits llm/stream with model chunks reconstructed from a recorded session JSONL (keyless snapshot tests) |

## todo

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-tool-todo` | yes | Model-facing todo_write tool over the Ondra event-sourced session log |

## typert

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-typert-loader` | yes | Loader integration for generated Typert package contributions |

## web

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-tool-web` | yes | Model-facing web tools (web_search, web_fetch) over the Ondra web capability seam (ctx.web) |
| `@ntars/ondra-web` | yes | Abstract web access capability seam (ctx.web) for the Ondra — search/fetch provider registry, registration-order-independent selection, request/result vocabulary, and the WebError taxonomy |
| `@ntars/ondra-web-deepseek-api` | yes | DeepSeek Search and Fetch API providers for the Ondra web capability seam (ctx.web) |
| `@ntars/ondra-web-fetch-http` | yes | Anonymous HTTP(S) fetch provider for the Ondra web capability seam (ctx.web) |
| `@ntars/ondra-web-search-deepseek` | yes | DeepSeek-backed search provider (native web_search via the Anthropic-compatible API) for the Ondra web capability seam (ctx.web) |
| `@ntars/ondra-web-search-exa` | yes | Exa-backed search provider for the Ondra web capability seam (ctx.web) |
| `@ntars/ondra-web-search-perplexity` | yes | Perplexity-backed search provider for the Ondra web capability seam (ctx.web) |

## workflow

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-tool-workflow` | yes | Model-facing workflow tool: run a JavaScript orchestration script over ctx.workflowEngine |
| `@ntars/ondra-workflow-ptc` | yes | Workflow orchestration in the shared sandboxed Node PTC runtime |

## workspace

| Package | Config | Description |
|---|---|---|
| `@ntars/ondra-workspace` | no | Workspace entity registry (ctx.workspaceRegistry): durable workspace records with validated session attachment over the domain data form for the Ondra |
