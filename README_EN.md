# 空谷 Ondra

[中文](./README.md) ｜ [English](./README_EN.md)

**On No Sound's Depth, Resonance Arises.**

Ondra is a fully plugin-based desktop AI companion application. It splits the three things that make companionship feel real — that she remembers, that she has feelings, that she speaks like a person — into 75 plugins that can be installed and removed individually, plus one plugin manifest and two bridge layers, running inside a desktop program on your own machine.

The name comes from the Chinese idiom 空谷足音, hearing a person's footsteps in a silent valley, a metaphor for rare and precious news.

| Item | Value |
| --- | --- |
| Version | 1.0.1-alpha |
| Form | Desktop application (Tauri shell + Cordis host + dsh kernel, three process layers) |
| Platform | Nine targets: (1) macOS 11+ (Apple Silicon first) (2) Windows 10+ (3) Linux (deb/rpm/AppImage) (4) iPad (iPadOS 15+) (5) iPhone (iOS 15+) (6) Android 8+ (7) HarmonyOS NEXT (8) CLI and Web (9) dsh kernel. **This release targets (1) macOS and (2) Windows first**; the rest follow the compatibility table in chapter 14 |
| Positioning | A companionship app. Not a general assistant, not a model, not a cloud service |
| Plugin scale | 78 packages = 75 loadable plugins + 1 plugin manifest + 2 bridges; 619 config fields, of which 609 are directly settable |
| Interface | One window: 56px rail (session / log / extension drawers plus preferences), conversation column, 56px spine (mood and energy levels); baseline 820 × 580. **Single-session by design**: no new or deleted sessions, only single-message deletion or a full clear. Opens straight into a conversation, no separate home screen |
| Data ownership | Everything stays on your machine. No accounts, no community, no sharing, no telemetry |
| Inference source | Cloud API / local model / free model, switchable at any time |
| License | [AGPL-3.0](./LICENSE) |
| Repository | [ntars/Ondra](https://github.com/ntars/Ondra) |
| Website | <https://ai.ntars.cn/> |
| Publisher | Ntarstudio（星玖工作室） |

---

## 1. Name and Positioning

**Terminology.** In this document the **shell** is the desktop shell process built with Tauri; the **host** is the Cordis plugin container process; the **kernel** is the dsh-sidecar process that runs inference and tool calls; a **plugin** is a functional unit loaded in Cordis form that discovers its peers through service keys; and a **persona** is a structured text describing who she is and how she speaks, with 鲸鲸 as the factory persona and 夏柠柒 as the example pack.

**Positioning in one sentence.** Ondra is an open-source AI companion application that can be deployed in one step and customised in depth. It gives a language model long-term memory, emotional rhythm and a way of speaking, and keeps all data on the user's own machine.

**Where the project stands.** Ondra was indexed by XERJ on 29 October 2026, and on the same day the team's two original projects, NT-Sine and NT-Dpet, were merged and chartered as Ondra. The first **internal beta**, `1.0.1-alpha`, shipped on 13 November 2026 and is marked as a GitHub Pre-release. **No public beta or stable release is scheduled**: promoting a build is a decision for the project owner and never happens automatically in the pipeline. Core functionality is complete; the remaining work is integration and debugging.

**Three boundaries of that positioning:**

1. **It is a companionship tool, not a general assistant.** It does not write articles, does not generate code, and is not a question-answering productivity tool. The test for whether a feature belongs is whether it makes companionship feel more like companionship.
2. **It is a host, not a model.** Inference is the user's choice, and three sources — an online API, a local model or a free model — can be switched at any time. Where inference comes from is the user's decision, not an attribute of the product.
3. **It is a local program, not a cloud service.** There is no account system, no community, no share button and no telemetry. The conversation belongs to the user and to this machine.

---

## 2. Overview

### 2.1 Background

Desktop AI applications have long taken one of two extreme forms. A monolith puts the interface, business logic and model calls into a single process: changing one thing requires repackaging the whole application, and one optional feature failing can prevent the application from opening at all. A pure web wrapper packs a website into a window, but its capabilities are limited by the browser sandbox — it cannot touch local files, and it cannot run in the background for long.

At the same time, AI companion products on the market generally implement companionship as one very long prompt. A prompt shapes tone, but it does not solve three technical problems: she cannot remember what was said last week; her emotion is re-invented every turn; and her way of speaking does not change with whom she is speaking. These are not copywriting problems, they are engineering problems.

Ondra takes a different path for each of the two situations. Architecturally it splits the application into three independent processes; in capability it makes memory, emotion and expression replaceable plugins rather than a prompt.

### 2.2 Problems addressed

1. **Change cost grows non-linearly with feature count.** When everything lives in one process, every new capability touches the main entry point and widens the regression surface. Maintaining 75 plugins by hand in a single process makes the impact of any change unpredictable.
2. **A failing optional capability takes down the whole application.** One badly written plugin can prevent startup. Plugins that need an external backend or external credentials — vision, the installer, the model gateway — fail far more often by nature than purely local features.
3. **Interface evolution drags the lower layers along.** When interface and business logic are coupled, a single visual change requires a full build and signing cycle.
4. **Third-party capabilities cannot be isolated.** Plugins share the process and its privileges, so one plugin's problem becomes everyone's problem.
5. **The inference kernel cannot be upgraded independently.** When kernel and interface share a process, changing the model protocol forces a release of both.
6. **Anthropomorphism lacks any cumulative mechanism.** Tone can be imitated with a prompt, but remembering requires a complete chain of writing, deduplicating, retrieving, decaying and archiving; having feelings requires state variables with inertia rather than a fresh description each turn; and speaking like a person requires a verifiable filter chain. None of these three can be expressed in a prompt.

### 2.3 Core idea

The first principle is that the process is the boundary:

- **Shell (Tauri / Rust)** does only operating-system-level work — windows, tray, file pickers, system theme. It does not know what a session is, or what a model is.
- **Host (Cordis / Node)** is the plugin container. All of Ondra's capabilities are loaded here as plugins, and it exposes a local HTTP interface.
- **Kernel (dsh-sidecar / Node)** runs four responsibilities only: the inference loop, tool invocation, session storage and model adaptation. It loads no interface code and does not know that a window exists.

The test for where code belongs: **if this logic still makes sense in an environment with no window, it does not belong to the shell.**

The second principle governs how capabilities are organised: the service key is the interface. None of the 75 plugins imports another at code level; they discover each other at runtime through Cordis service keys, and when an upstream is absent they skip that step and leave a trace. This is what allows plugins to be added or removed without compile-time ripples.

### 2.4 Where it fits

- A desktop companion intended to run continuously in the background, rather than a one-question-at-a-time chat box.
- Product forms that need capabilities outside the browser sandbox, such as local files, the clipboard and system state.
- Applications assembled from several independent capabilities that should be installed and removed on demand.
- Situations where model capability must be upgraded by swapping the kernel alone, with no interface change.
- Privacy-sensitive environments where conversation data must never leave the machine.

### 2.5 Why this exists

Technology is only a means. This section answers why the work is done at all, and it is the highest authority for product decisions: where any feature trade-off conflicts with this section, this section wins.

**Five kinds of need.** Each corresponds to real users, not to marketing personas.

**One: children left behind.** When parents work away from home year after year, what a child needs is not a machine that can explain homework, but someone who is there every night, who remembers what was said yesterday, and who asks on their own how school went today. This need is commercially inconspicuous — it brings no growth, creates no engagement time, and no investor asks about it — yet it exists in tens of thousands of rooms. The corresponding form in the product is the homework card: a list of subjects ticked off one by one, ending with a single line saying goodnight and see you tomorrow.

**Two: empty-nest and solitary elderly people.** Children far away, a spouse gone first, and only the sound of a clock left in the room. These users do not lack information tools; they lack someone who remembers what day it is, remembers that they mentioned back pain yesterday, and asks first on a day when they have not spoken. What older users actually require from an interface is slow, large text, and the ability to complete everything by speaking — all of which are negative points in products designed for efficiency, and this product does them anyway. The corresponding form in the product is the elder card: the weather, one line reminding them to take medicine at eight, and a note that it has turned cold and a coat is needed outside.

**Three: people who want to hear that tone once more.** After a close relative dies, what a family most wants is often not a photograph but to hear that familiar tone again, and to be called by name in that familiar way. This need carries very high risk, so the boundaries must come first. Enabling a memorial persona has three preconditions, and these are product conditions rather than technical steps:

1. **Authorisation**: written consent and data authorisation from the family or from the person before death.
2. **Scope statement**: a memorial is not a replacement, and its output constitutes neither medical nor psychological advice.
3. **Data minimisation**: only material within the authorised scope is used, and nothing is completed or invented.

If any one of the three does not hold, the feature is not opened.

**Four: people who care about privacy.** Conversation with a companion is among the most private content there is: confidences during a low point, conflicts with family, hesitation about the future. Handing that to the cloud means it lives on someone else's server forever, exposed to changes in terms of service, acquisitions and data policy. Companionship and privacy are usually presented as a choice in existing products; this product holds that they should not be, so all data stays on this machine, with no telemetry, no crash reporting and no usage statistics.

**Five: people who do not want to be locked to a vendor.** Model A today, model B tomorrow, and fully offline the day after — inference capability should not be bound to the product. Where inference comes from should be the user's choice, not an attribute of the product. This product therefore offers an online API, a local model and a free model, switchable at any time.

**The unified technical conclusion.** All five needs point to one sentence: **companionship presupposes that she remembers, that she has feelings, and that she speaks like a person.** These happen to be the three hardest things to build and the easiest to turn into a demo reel, so the reusable mechanisms are distilled into a technology stack, and Ondra is its first complete host.

**Boundaries and proportion.** The following five are constitutional constraints, not options:

- This is a companionship tool and **not psychotherapy**: it does not diagnose, does not prescribe and does not replace professional help; when a conversation carries clear crisis signals, the product points toward real-world support.
- The persona is a **fictional character setting**: the default persona is a carefully written character text, is not a real person, does not claim to be one, and its output represents no real person's position.
- Memorial personas are bound by the three preconditions above and are not opened when they are unmet.
- **No content upload and no social distribution**: no community, no public square, no share button — the conversation belongs to the user and to this machine.
- **No design that stretches time spent**: comparable products treat dwell time as a success metric, and this product is the opposite, since she should be able to stay quietly to one side without disturbing anyone. The anti-dependence guardrail and the presence-without-intrusion protocol are described in chapter 5.

**Non-goals.** The capability boundary is the product positioning:

- No multi-user or account system: one machine, one user, no synchronisation across devices, and backups performed by the user by hand.
- Desktop experience first: macOS and Windows are the launch platforms, and the mobile form is undecided.
- No content production: no articles, no code, no general assistance.
- No arms race toward being more like a chatbot: the difference is not in elaborate phrasing but in whether she remembers the user's timeline, whether she has an emotional rhythm of her own, and whether she knows when not to speak.

---
## 3. Core Features

This chapter has two parts. Section 3.1 describes the runtime skeleton that carries every capability, covering only the necessary structure and boundaries. From 3.2 onward it describes the 78 packages one by one, together with their configurable settings, and that is the body of this document.

### 3.1 Runtime skeleton

**Three process layers.** Shell, host and kernel each occupy a process and communicate over explicit protocols, so any layer can be replaced, upgraded or restarted on its own.

| Layer | Path | Stack | Responsibility | Explicitly not |
| --- | --- | --- | --- | --- |
| Shell | `src-tauri/` | Rust 2024 + Tauri 2 | Window, tray, single instance, host lifecycle, native capability commands | Contains no business logic |
| Host | `cordis-host/` | Node 22 + Cordis 4 + TypeScript | Plugin container, local HTTP interface, token authentication | Does not touch the operating system directly |
| Kernel | `dsh-sidecar/` | Node 22 + TypeScript | Inference loop, tool invocation, session storage, model adaptation | Loads no interface, listens on no port |
| Interface | `src/` | React 19 + Vite 8 | Interface rendering | Does not own native capabilities |

**Three communication paths.** Between shell and host the transport is line-delimited JSON over standard input and output, where the host reports ready or fatal on standard output and the shell decides from that whether startup succeeded. Between host and kernel the transport is JSON-RPC 2.0 over standard input and output framed as newline-delimited JSON, defined in one place in `dsh-sidecar/src/protocol.ts`. Between interface and host the transport is HTTP on `127.0.0.1` with Bearer token authentication, where the token is generated by the shell at startup.

**The kernel's 18 methods** cover five domains: lifecycle, session (`create` / `get` / `list` / `archive` / `messages` / `deleteMessage` / `clear`), inference, tools and models (`list` / `select` / `configure` / `complete`). The handshake reports the capability list once, so callers can trim their interfaces accordingly rather than probing one method at a time.

**How plugins are loaded.** `cordis-host/plugins/` holds 78 packages. Of these, 75 are declared in an explicit array inside `ondra-core`, loaded one at a time, each load wrapped in its own `try/catch` so a failure lands in the skipped list with its reason recorded. The other three belong to the assembly layer itself: `ondra-core` owns that member list, while `desktop-bridge` and `dsh-client` are mounted directly by the host entry and never enter the core array. None of the 75 imports another at code level; they discover each other entirely through service keys.

---
### 3.2 Plugin Inventory

The 78 packages fall into 5 top-level menus and 18 second-level groups. Every field follows the declaration in that plugin's `src/settings.ts`, and the default values come from the same declaration, so there is never a second set of values.

**Reading conventions**: `Switch` is a boolean toggle; `Slider` is a number with bounds; `Segmented` is a fixed set of enumerated choices; `Tag list` is a list of strings that can be added to and removed from entry by entry; `URL` and `Route` are text inputs, the former for an address and the latter for a path relative to the site. **Advanced** fields are collapsed in the interface by default and can be set once expanded; their keys are listed here so they can be searched.

> The full field list can be exported straight from `FIELD_SPECS` in `cordis-host/plugins/*/src/settings.ts`; no separate attachment is needed. Earlier versions of this file pointed at `ondra-settings.csv` and `ondra-panel-model.json`, neither of which exists in this repository, so that reference has been removed — **this document does not cite files the repository does not contain**.

| Top-level menu | Groups | Plugins | Enabled | Off at factory | Total fields | Directly settable | Not directly settable | Of which advanced | Of which secret |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Persona Detail | 6 | 18 | 18 | 0 | 161 | 158 | 3 | 81 | 0 |
| Voice & Appearance | 2 | 4 | 4 | 0 | 48 | 48 | 0 | 22 | 0 |
| Developer Features | 8 | 35 | 34 | 1 | 192 | 185 | 7 | 103 | 0 |
| Emotion Engine | 1 | 4 | 4 | 0 | 13 | 13 | 0 | 6 | 0 |
| Memory System | 1 | 17 | 17 | 0 | 205 | 205 | 0 | 131 | 0 |
| **Total** | **18** | **78** | **77** | **1** | **619** | **609** | **10** | **343** | **0** |

**Every column is counted field by field from `FIELD_SPECS` in each plugin's `src/settings.ts`**, so re-running the same script after any code change reproduces them exactly:

| Column | Definition |
| --- | --- |
| Plugins | Packages appearing as entries in this chapter. This includes `ondra-core` and the two bridges, hence 78; the number of independently loadable plugins is 75 |
| Enabled / Off at factory | `FIELD_SPECS.enable.default`. 3 sections have no `enable` field and 14 plugins have no `settings.ts` at all; both are permanently enabled and counted under Enabled |
| Total fields | Number of top-level keys in `FIELD_SPECS`, **including fields the interface gives no editing control for** |
| Directly settable | Total fields minus "not directly settable". This is the number of entries a user can actually change in the UI, and it is what each plugin entry below calls its "configurable settings" |
| Not directly settable | Two kinds: (1) **on-disk paths** (key ends in `Dir` / `File` / `Path` and `kind: 'string'`), which the program probes at runtime so the interface only echoes them read-only, and a hand-typed mistake surfaces only at runtime; (2) **structured arrays** (`kind: 'json'` with an array default), which need a per-item form rather than a single input box. Measured this round: no path field remains on a user-editable surface, so all 10 are structured arrays |
| Of which advanced | Fields carrying `advancedOnly: true`, i.e. 55.4% of all fields (343 / 619). Collapsed by default, editable once expanded |
| Of which secret | Fields carrying `secret: true`. **Measured at 0** — no field anywhere declares itself secret, so the interface needs no password input, see 5.6 |

The figures reconcile in three directions: **row by row**, `Total fields = Directly settable + Not directly settable` holds for all 5 rows; **by column**, `619 = 609 + 10`; and `609` matches the sum of the 78 individual plugin entries in the body text, item by item.


### 3.3 Persona Detail

This menu answers who she is, how she speaks, and in what capacity she keeps you company. It holds 6 groups, 18 plugins and 161 configurable fields, of which 158 can be changed directly, all enabled at the factory default. The persona is split into replaceable parts rather than one hard-coded prompt: Persona Core owns the six-slot structure that defines who she is, Persona Variables & Intensity owns how strong the delivery is, Persona Assembly owns the fixed order of the four segments, and Persona Pack owns swapping the character. The World Book supplies background knowledge, Speech Expression (colloquialism, output filtering, lexicon, dialogue staging, dialogue protocol) turns the model's written register into spoken language, Emotion Projection & Injection carries the current mood into this turn's tone, Relationship & Narrative owns the absence etiquette and first meetings, and Presence owns whether she should pause, split a message, or leave room to breathe.


#### Persona Detail · Persona Core

**1. Persona Core** · package `ondra-persona-core` · enabled · 6 settings

Persona Core: splits SKILL.md into six slots (identity, speech, drives, scenes, format, self-check) and pairs them with five relationship variants (girlfriend, sister, daughter, friend, assistant) plus a custom one, so only the relationship changes and the persona does not. It never trims, never adds intensity and never adds boundaries.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the core is no longer assembled and the service registers as unavailable. |
| `relation` | Segmented | friend | girlfriend / sister / daughter / friend / assistant / custom | Relationship. Defaults to friend, the only one of the five that presumes no intimacy. The product does not decide for the user what she is to them. |

Advanced (collapsed by default, 4): `persona-id`, `include-extras`, `cache-kernels`, `boundary-item-limit`

**2. Persona Assembly** · package `ondra-persona-assemble` · enabled · 4 settings

Persona Assembly: assembles four segments in the fixed order of core, relationship tuning, intensity and boundaries, never sorting by priority. Segments are packed one by one against a character budget, skipping any that do not fit and continuing with the next. The boundary layer is exempt from trimming as a whole. Exceeding the budget is reported honestly as overBudget, with a note that a number of further segments were left out written into the segment heading. It never cuts characters and never drops anything silently.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, nothing is assembled and the service registers as unavailable. |
| `budget-chars` | Slider | 12000 | 400 – 48000 | Character budget for each turn's prompt. Defaults to 12000 — a complete persona load measures 7,725–10,057 characters, plus about 20% headroom for fragments and relation tuning. Lowering it to 2600 drops the entire "voice" slot and she stops sounding like herself. Exceeding it is reported as overBudget rather than silently truncated. |
| `include-headings` | Switch | On | — | Whether to add a short heading to each segment. Turning it off saves a few dozen characters, but the model may then read the intensity segment as part of the core. |

Advanced (collapsed by default, 1): `report-over-budget`

**3. Persona Variables & Intensity** · package `ondra-persona-vars` · enabled · 5 settings

Persona Variables & Intensity: substitutes the user, character and relationship placeholders with the values the user filled in, leaving anything unknown or empty exactly as written, then produces a five-tier intensity segment from a 0 to 100 slider. It only changes forms of reference and strength of delivery, never a single word of the persona, and intensity is never written into the core.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, no variables are substituted and no intensity segment is produced; the service registers as unavailable. |
| `user-address` | Text | Blank | — | What she calls you, substituted into {{user}}. Leaving it empty means unset, and the runtime falls back to a generic second-person pronoun. Twelve characters maximum. |
| `tone-level` | Slider | 50 | 0 – 100 | Speaking intensity. 0 is very reserved, 50 is moderate and matches the persona pack's original wording, 100 is very warm. It only changes how much of the same phrasing is used; it never adds new words. |

Advanced (collapsed by default, 2): `char-name`, `substitute-in-boundaries`

**4. Persona Pack** · package `ondra-persona-loader` · enabled · 10 settings · 1 not directly settable

Persona Pack loader: scans the persona skills directory for packaged persona files in read-only mode, parses the metadata and the SKILL.md inside, and registers the available personas. A factory persona ships with the product and one example pack is included. The pack itself is never written back.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, persona packs are no longer scanned and the service registers as unavailable. |
| `active-persona` | Text | oh-jingjing | — | Persona id to activate initially. Switching only changes the in-memory state; persisting the choice belongs to the user layer of the configuration source or to the interface. |

Advanced (collapsed by default, 8): `user-subdir`, `factory-persona`, `sample-persona`, `max-archive-bytes`, `max-entry-bytes`, `max-text-cache-bytes`, `max-personas`, `keep-issues`

Not directly settable (1): `bundled-dir` (State or data file. Leaving it empty uses the built-in default; no manual entry is needed.)

**5. Persona Evolution** · package `ondra-persona-evolve` · enabled · 4 settings

Persona Evolution: only the baseline ships at the factory, and character grows out of experience. It moves numbers and never prose: trait scores derive from the baseline plus un-rolled-back increments, which are bounded, reversible and explainable, with drift capped at a share of the scale. Thresholds rise with time spent together according to a formula that tops out at sixty percent above the baseline, and an explanation call can answer why sixty used to count as happy while eighty does now. The baseline is passed in by the caller; this plugin persists the interaction count only and keeps no second copy of the baseline.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, traits always read the baseline and thresholds never drift. The service still registers, so downstream callers never receive undefined. |
| `default-trait-drift-ratio` | Slider | 0.15 | 0.01 – 0.6 | Default cap on trait drift as a share of the scale. 0.15 keeps the change visible while still recognisably the same person. |

Advanced (collapsed by default, 2): `max-delta-ratio`, `verbose`

#### Persona Detail · World Book & Scenes

**6. World Book** · package `ondra-worldbook` · enabled · 9 settings · 1 not directly settable

World Book: six budget layers, totalling 1600 tokens and split as 350, 180, 100, 500, 200 and 150. A layer that would overflow drops the whole entry rather than cutting characters. Resident entries form their own segment and are frozen as the session prefix, and ordering inside a layer is stable rather than floating with hit counts, which guarantees the prefix of one session never changes.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the world book no longer takes part in assembly and the service registers as unavailable. |
| `load-file` | Switch | On | — | Whether to load the world book from a file at startup. A missing file is not an error, since having no world book is a normal state. |
| `include-headings` | Switch | On | — | Whether to add a short heading to each layer. Turning it off saves a few dozen tokens, but the model may then read a prohibition as plot. |

Advanced (collapsed by default, 6): `annotate-dropped`, `report-dropped`, `fit-policy`, `cjk-chars-per-token`, `ascii-chars-per-token`, `max-entry-tokens`

Not directly settable (1): `worldbook-file` (State or data file. Leaving it empty uses the built-in default; no manual entry is needed.)

#### Persona Detail · Speech Expression

**7. Colloquialization** · package `ondra-oral` · enabled · 14 settings

Colloquialization: shapes spoken texture. The verbal-tic pool holds twelve to twenty entries per persona, tiered by the six emotional states, with at most two uses per scene. Incomplete sentences run at eight percent, dropping either the subject or the closing particle. Punctuation habits cover no closing period, repeated question marks for doubt and ellipses for hesitation. Interjections are only ever subtracted. Median length of eight to twelve characters is reported rather than enforced, and the minimum sticker interval of three messages acts as a gate without ever sending a sticker. The zero-typo rule is written into a type literal, so pretending to be careless requires changing a type.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers and apply returns unchanged. |
| `habit-enabled` | Switch | On | — | Whether to insert verbal tics. They are skipped automatically when the pool holds fewer than twelve. |
| `habit-max-per-session` | Slider | 2 | 0 – 2 | Maximum number of verbal tics per scene. The original value is 2 and the cap is locked at 2. |
| `habit-placement` | Segmented | suffix | suffix / prefix | Whether tics marked placement any go at the end or the start of a sentence. |
| `incomplete-enabled` | Switch | On | — | Whether incomplete sentences are allowed, dropping either the subject or the closing particle. |
| `particles-enabled` | Switch | On | — | Whether to filter interjections by the six-state expression tier. This only removes them; adding words is left to the model. |
| `punct-enabled` | Switch | On | — | Whether to shape punctuation habits, such as no closing period, repeated question marks, and ellipses. |

Advanced (collapsed by default, 7): `habit-min-pool-size`, `habit-max-pool-size`, `incomplete-p`, `median-min`, `median-max`, `sticker-gap`, `verbose`

**8. Output Filtering** · package `ondra-filter-chain` · enabled · 20 settings

Output Filtering: a nine-step chain running draft register, AI self-disclosure, hard red lines, relationship overreach, stage overreach, third-person narration, four-gram repetition, customer-service register and a length backstop, stripping each in turn and acting only at sentence boundaries. It also carries anchor detection and a post-hoc review loop. It does not generate the text, does not change tone and performs no semantic judgement that would need a second model.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, but run returns the text unchanged. |
| `max-chars` | Slider | 400 | 20 – 8000 | Upper bound on reply length. Set to 400, since anything longer is usually customer-service prose. |
| `hard-redline` | Switch | On | — | Whether to enforce hard red lines taken from the persona core's hard constraints. |
| `relation-guard` | Switch | On | — | Whether to enforce relationship violations taken from the current relationship's cautions. |
| `stage-guard` | Switch | On | — | Whether to enforce stage violations against a built-in table of seven entries awaiting adjudication. |
| `strip-parenthetical` | Switch | On | — | Whether to strip third-person narration. Short first-person actions are always kept, since they carry presence. |
| `you-formal` | Switch | On | — | Whether to rewrite the formal second-person pronoun to the informal one. |
| `review-enabled` | Switch | On | — | Whether to enable post-hoc review by an independent model scoring 1 to 100. |
| `review-threshold` | Slider | 70 | 1 – 100 | Passing score for that review. User-defined. |
| `review-max-rounds` | Slider | 2 | 1 – 4 | Maximum reviews per turn. The specification says at most two rounds per turn. |

Advanced (collapsed by default, 10): `min-chars`, `repeat-ngram`, `repeat-threshold`, `repeat-recent-count`, `redline-patterns`, `relation-patterns`, `emotion-shrink`, `review-source`, `review-temperature`, `verbose`

**9. Language Feel** · package `ondra-lexicon` · enabled · 10 settings

Language Feel: computes how the owner speaks from the last 300 human messages and compresses it into a volatile segment of 56 to 62 characters carrying a marker. Four rulings are hard-coded. First, only the shape is kept and never the wording: an incoming message is immediately reduced to sentence-length arrays, whether punctuation was present and the count of trailing interjections, while the raw text is discarded that same pass and never appears in the archive, which makes remembering the shape without remembering the words a structural fact rather than a promise. Second, only real people count and she never counts herself: messages from the assistant are rejected outright, since otherwise her own sentences train her to resemble her previous turn and the owner's real changes get diluted. Third, the median rather than the mean, because one pasted block of code can fling the mean away while the median only cares that half the sentences are shorter than it. Fourth, the no-punctuation rate is computed per message rather than per sentence, since per sentence it collapses into the same measure as whether the whole message had punctuation. With fewer than thirty samples it yields an empty segment instead of a placeholder, because a placeholder crowds out real injection and is read by the model as information. The text never says how many recent messages were counted, since that is a tally and the model will repeat it back as a statement about the owner's messages. This plugin changes no persona, writes no system prompt, adds nothing to the eight injection blocks, calls no model, installs no timer and draws no interface.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, but compose returns a disabled empty segment rather than silently continuing. |
| `window-size` | Slider | 300 | 50 – 1000 | Sample window size in messages. 300 comes from the design specification; the floor of 50 is the empirical point below which a median is not stable. |
| `min-samples` | Slider | 30 | 5 – 300 | Below how many samples no segment is produced. At 30, the window usually holds more than sixty sentences and the median starts to settle; fewer than that amounts to summarising a person from two sentences. |
| `max-chars` | Slider | 130 | 40 – 400 | Character cap on the injected text. 130 comes from the design specification's roughly 130 characters; actual text runs about 55 characters, so this cap is a guardrail rather than a target. |
| `top-particles` | Slider | 3 | 1 – 6 | Maximum number of interjections reported in the text. Above three the line turns into a list, whereas its purpose is to let her drop one in naturally. |
| `owner-only` | Switch | On | — | Whether to count only the owner's own messages. On by default, because other people's messages in a group chat are real human messages but not the owner's language feel, and mixing them in teaches her the wrong person. |
| `max-age-hours` | Slider | 720 | 0 – 8760 | Maximum sample age. 720 hours, or thirty days, because language feel shifts and sentences from a month ago should no longer represent the present. 0 disables ageing by time. |
| `persist` | Switch | On | — | Whether to persist the computed shape. When off, every restart has to rebuild the sample, and the symptom is a language feel that comes and goes without any error. The archive holds the shape only, never the original wording. |

Advanced (collapsed by default, 2): `flush-every`, `verbose`

**10. Dialogue Orchestration** · package `ondra-dialogue` · enabled · 10 settings

Dialogue Orchestration: freezes the prefix within a session. The stable segment of persona and resident world book is assembled once at the start of a session and locked, volatile segments such as date and emotion are appended at the tail, history only appends and is never reassembled, and compression happens only at user-turn boundaries. Reassembling the system prompt every turn drops the cache hit rate from ninety-nine percent to zero, measured as a cost change from roughly 880 to roughly 20 yuan, and this is the one place in the repository that holds that line. It creates no session, writes no application session log, rewrites no text and does no injection packing.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, but turn ends immediately with an error rather than staying silent. |
| `max-turns` | Slider | 10 | 1 – 200 | Upper bound on retained history rounds. One round is one user message plus one assistant message. Defaults to 10. |
| `max-history-chars` | Slider | 2000 | 200 – 200000 | Character cap on history. This and the round cap are independent gates: the round cap cannot stop an oversized message and the character cap cannot stop many short ones. |
| `temperature` | Slider | 0.8 | 0 – 2 | Sampling temperature. Companion dialogue leans loose, so the default is 0.8. |
| `include-persona` | Switch | On | — | Whether to take the four segments from persona assembly automatically as the stable segment. They are read once at begin and frozen afterwards. |
| `include-worldbook` | Switch | On | — | Whether to take the resident block from the world book automatically as part of the stable segment. Only the resident part is taken, never on-demand entries. |

Advanced (collapsed by default, 4): `max-tokens`, `min-tail-confidence`, `max-conversations`, `verbose`

**11. Dialogue Protocol** · package `ondra-dialogue-protocol` · enabled · 3 settings

Dialogue Protocol: a five-frame protocol of text delta, text replace, crisis, usage and done, with a closed set of four finish reasons. The frame shapes, the cross-frame discipline of a single final frame and exactly one usage and one crisis each, and the NDJSON codec exist in one copy here. In the previous project those three shapes were scattered across the session loop, the interface and the channels, so a text-replace frame treated as an increment showed the user the opening twice, and a silently dropped crisis frame meant the crisis notice never reached the user. It makes no business judgement, rewrites no text, persists nothing and creates no session.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, but create returns a writer that closes at once, so downstream callers receive no frames instead of silently continuing. |

Advanced (collapsed by default, 2): `allow-empty-delta`, `verbose`


#### Persona Detail · Emotion Projection & Injection

**12. Emotional Projection** · package `ondra-emotion-project` · enabled · 6 settings

Emotional Projection: the single textual outlet for emotion. The template is fixed as one behavioural instruction sentence plus one hint, and any number, dimension name or emotion label is forbidden, leaving only subjective phrasing such as not quite feeling up to it. Turning to numeric status is allowed only when the user explicitly asks for a value, and the fragment sort key is always positive so it stays at the tail and preserves the prefix cache.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, but every projection request is refused with the reason code disabled. |
| `projection-ttl-minutes` | Slider | 10 | 1 – 1440 | Lifetime of the projection segment in minutes. The default of 10 reflects that it is only advice on the tone for this turn, shorter-lived than any state variable. |
| `projection-order` | Slider | 800 | 0 – 1000 | Sort key for the projection segment, positive by default so it lands at the tail. The requirement is that volatile segments are appended at the end; a negative value breaks the prefix cache. |
| `confidence-matched` | Slider | 0.9 | 0 – 1 | Confidence when an explicit criterion is matched. The criteria are written literally, so 0.9. |
| `confidence-fallback` | Slider | 0.5 | 0 – 1 | Confidence when falling back on a gap. A fallback is not a decision, so 0.5. |

Advanced (collapsed by default, 1): `verbose`

**13. Prompt Injection** · package `ondra-prompt-inject` · enabled · 14 settings

Prompt Injection: packs eight blocks covering what was agreed, what must not be forgotten, people I know, on this day in past years, what comes to mind now, lessons recorded, what follows from the thread and what surfaced today. Packing works against a character budget, trying blocks by weight, skipping any that does not fit and continuing, with the block heading noting how many entries were left out. The due-reminder and pinned blocks never take part in packing. It does no dedupe bookkeeping and never touches the persona segment.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, but render returns empty text with a stated reason. |
| `budget-preset` | Segmented | standard | small / standard / large | Preset budget tiers: small 1200, standard 2600, large 24000. A positive budgetChars value overrides the preset. |
| `max-pinned` | Slider | 8 | 0 – 32 | Upper bound on pinned entries. The specification says at most eight. |
| `max-persons` | Slider | 5 | 0 – 32 | Upper bound on person-type memories. The specification says at most five. |
| `max-anniversary` | Slider | 3 | 0 – 32 | Upper bound on On This Day entries. The specification says at most three. |
| `max-lessons` | Slider | 3 | 0 – 32 | Upper bound on remembered lessons. The specification says at most three. |
| `include-headings` | Switch | On | — | Whether to add a short heading to each block. Turning it off also hides the note about entries left out, which then only appears in the report. |
| `respect-pool` | Switch | On | — | Whether to honour the memory pool's rule that some memories never enter injection. Nothing is judged while the pool service is absent. |
| `clarity-suffix` | Switch | On | — | Whether to append a clarity phrase to each memory line. The phrasing comes from the memory core, so this plugin does not write its own copy. |

Advanced (collapsed by default, 5): `budget-chars`, `max-promises`, `anniversary-scan-limit`, `ripple-rings`, `verbose`


#### Persona Detail · Relationship & Narrative

**14. Lull Etiquette** · package `ondra-absence` · enabled · 6 settings

Lull Etiquette: answers one question, which is how to respond when someone returns after a long gap. It defines five tiers covering today, yesterday, a few days, a while and a long time, and each tier gives only what must be done, what must never be done, a sentence cap, whether to acknowledge the gap and whether a little warmth is allowed, with no number anywhere. Even the length of the gap appears only as one of five coarse words, because saying that seventeen days have passed is not care but turning a reunion into an interrogation. The type of the ask-about-gap field is the literal false, since a boolean would guarantee a true branch and that branch would inevitably be switched on during some attempt to show concern. Four general prohibitions hold across every tier: never ask where they went, never report the exact interval, never invent a story for the gap and never read the absence as being abandoned. Reading does not advance the state, and only the side that actually speaks records that it was mentioned, so a caller polling freely never says the same greeting twice. The archive holds three timestamps and two counters, never what was last discussed and never why the person left, since that would be attendance tracking rather than etiquette. It builds no interface, installs no timer and sends nothing on its own initiative.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, touch and mention throw disabled, and view stays readable. |
| `brief-hours` | Slider | 6 | 1 – 48 | Gaps shorter than this many hours do not count. The default of 6 is one full night's sleep. |
| `noticed-days` | Slider | 1 | 1 – 7 | Beyond this many days the gap moves to the tier that remembers the person but loses the thread. Defaults to 1. |
| `long-days` | Slider | 3 | 2 – 30 | Beyond this many days the gap moves to the tier that remembers the person but forgets the details and must acknowledge the time apart. Defaults to 3. |
| `distant-days` | Slider | 14 | 4 – 365 | Beyond this many days the gap moves to the tier that may have forgotten who she is. Defaults to 14 and must exceed the previous field. |

Advanced (collapsed by default, 1): `max-sentences-cap`

**15. First-meeting Script** · package `ondra-first-meet` · enabled · 3 settings

First-meeting Script: cuts the first meeting into five beats of arrival, introduction, boundary, invitation and closing, where each beat gives only the purpose, what must be done, what must never be done and a sentence cap, with not one word of script. Boundaries come before the invitation, since explaining what she will not do before asking the first question keeps the opening from becoming a demand. Reading does not advance the water mark and only the side that actually speaks the beat advances it, so polling never consumes a beat, and when the user speaks first the flow jumps straight to the closing beat rather than forcing the script through. The archive holds only the beat watermark and timestamps and never a single sentence the other person said, because on a first meeting people give real names and circumstances, and those belong to the memory system and the right to be forgotten. It does not send the first message, does not initiate, and builds no interface.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, advance and reset throw disabled, and plan stays readable. |
| `auto-start` | Switch | On | — | Whether the first exchange enters the first meeting automatically. When off, plan returns an empty beat and the flow only starts when called explicitly. |

Advanced (collapsed by default, 1): `max-sentences-cap`

#### Persona Detail · Presence

**16. Message Splitting & Pauses** · package `ondra-rhythm` · enabled · 22 settings

Message Splitting & Pauses as pure functions: at most 4 messages, 40 characters each, 6 characters per second, 300, 500 and 150 milliseconds added at punctuation, pauses between 300 and 6000 milliseconds clamped before and after a late-night multiplier of 1.6, first-character delay between 800 and 2000 ms, long pauses at 20% probability lasting 3 to 9 seconds and at most once per turn, self-correction at 5% and not inserted by default, and on overflow keeping the first three messages while merging the tail into the fourth. It only computes and never sends: timed execution belongs to the typing layer and text editing belongs to the filter chain.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, but plan falls back to sending everything in one block. |
| `max-messages` | Slider | 4 | 1 – 4 | Cap on message splits. Official QQ allows five calls, so one is held in reserve and the cap is locked at 4. |
| `max-chars-per-message` | Slider | 40 | 10 – 120 | Character cap per message. The original value is 40. |
| `chars-per-second` | Slider | 6 | 2 – 20 | Typing speed in characters per second. The original value is 6. |
| `self-correct-enabled` | Switch | Off | — | Whether to enable self-correction. The specification says it is not inserted by default, so this is off. |
| `night-enabled` | Switch | On | — | Whether to amplify pauses late at night. |

Advanced (collapsed by default, 16): `min-delay-ms`, `max-delay-ms`, `first-delay-min-ms`, `first-delay-max-ms`, `long-pause-p`, `long-pause-min-ms`, `long-pause-max-ms`, `self-correct-p`, `night-factor`, `night-start`, `night-end`, `pause-period-ms`, `pause-ellipsis-ms`, `pause-comma-ms`, `emotion-adjust`, `verbose`

**17. Typing & Pause Execution** · package `ondra-rhythm-typing` · enabled · 6 settings

Typing & Pause Execution: runs the splitting plan from the rhythm module as a real timeline, showing thinking before the first message and typing between two, never showing typing during a long pause, allowing cancellation per conversation, letting a new turn displace the previous one in the same conversation, and stopping on unload. Without the rhythm service it falls back to sending everything in one block rather than simulating typing. It only executes and never produces content: splitting belongs to the rhythm module and typing display and presence belong to the breathing module.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, but run falls back to sending everything in one block. |

Advanced (collapsed by default, 5): `conversation-id`, `long-pause-threshold-ms`, `wake-buffer-ms`, `emit-phase-events`, `verbose`

**18. Breathing Room** · package `ondra-breath` · enabled · 7 settings

Breathing Room: maps the typing phase from the execution layer into whether typing should be shown right now, hiding it during long distracted pauses, and within a budget of twice a day supplies one bracketed action such as stretching. It only decides whether and which line, and never sends, draws no interface and installs no timer.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, but presence reports nothing and take returns disabled. |
| `presence-enabled` | Switch | On | — | Whether to answer the is-typing question. This only produces a decision; it does not draw any interface. |
| `breath-enabled` | Switch | On | — | Whether to allow a bit-of-life action, at most twice a day. |
| `daily-cap` | Slider | 2 | 0 – 2 | Daily cap on those actions. The original value is 2 and the cap is locked at 2. |

Advanced (collapsed by default, 3): `same-action-once-per-day`, `extra-actions`, `verbose`


### 3.4 Voice & Appearance

This menu answers what she looks like and what voice she speaks with. It holds 2 groups, 4 plugins and 48 configurable fields, all of them directly changeable, all enabled at the factory default. The Voice group converts text to speech, decides when speaking is appropriate and when it is not, and converts speech back to text; the Appearance group is down to expression detection alone — the portrait, stickers and desktop pet entry point were removed with the plugin trim, since each needs its own rendering process and external assets.


#### Voice & Appearance · Voice

**19. Speech Synthesis** · package `ondra-tts` · enabled · 18 settings

Speech Synthesis: three channels coexist, namely a local GPT-SoVITS service over api v2, macOS say with no dependencies, and Edge TTS with nineteen voices and eight presets. It only wires, selects a route and degrades, never reimplementing any synthesis mechanism: text goes in, audio comes out, the result lands in a content-addressed cache, and failures always return a reason code rather than throwing. Whether to speak at all is decided by the four voice gates, so this plugin makes no such judgement and registers no tools.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, but speak always returns disabled. |
| `provider` | Segmented | auto | auto / gpt-sovits / macos-say / edge-tts | Channel selection: auto picks the first ready path in the order local GPT-SoVITS, then macOS say, then Edge TTS. |
| `preset` | Segmented | soft | soft / lively / broadcast / dongbei / shaanxi / cantonese / taiwan / english | Default voice pack preset: gentle, lively, broadcast, northeastern, shaanxi, cantonese, taiwan, english. |
| `voice` | Text | Blank | — | Explicit voice id. Leaving it empty follows the preset. |
| `volume` | Segmented | normal | normal / low | Volume tier. The macOS say branch has no volume parameter and ignores this setting. |
| `gsv-endpoint` | URL | http://127.0.0.1:9880 | — | GPT-SoVITS service address for api_v2. Loopback addresses only. |
| `gsv-ref-audio` | Text | Blank | — | Absolute path to the reference audio. Leaving it empty makes this channel unavailable, because it requires a voice sample. |
| `playback` | Segmented | auto | auto / off | In auto mode, play through the system player; when off, only synthesise the file, which is what channels use to send voice clips. |

Advanced (collapsed by default, 10): `rate`, `max-chars`, `gsv-prompt-text`, `gsv-text-lang`, `edge-bin`, `say-voice`, `say-wpm`, `timeout-ms`, `cache-files`, `verbose`

**20. Voice Gate** · package `ondra-tts-gate` · enabled · 8 settings

Voice Gate: four gates covering the switch, a length window of six to thirty characters, an emotion intensity of at least 0.15 or an emotion word present in the turn, and a three-second rate limit, plus a rule that forces text after two consecutive voice messages. It only decides and neither speaks nor synthesises: the decision carries a reason code, the real character count, the emotion intensity and the six-state speaking rate, and the dialogue chain hands it to synthesis. When the emotion service is absent it passes through as degraded and says so, while a missing synthesis channel is reported honestly as unavailable, and those two failure directions point opposite ways on purpose.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, nothing is ever read aloud. The service still registers. |
| `min-chars` | Slider | 6 | 2 – 30 | Lower bound on sentence length, counted after whitespace is removed. A sentence that short sounds like a notification tone. |
| `max-chars` | Slider | 30 | 6 – 120 | Upper bound on sentence length. Beyond it the text should be split rather than read out. |
| `intensity-min` | Slider | 0.15 | 0 – 1 | Emotion intensity threshold between 0 and 1. Below it, and with no emotion word present, nothing is spoken, because plain statement is better served by text. |
| `cooldown-ms` | Slider | 3000 | 0 – 10000 | Rate-limit interval in milliseconds. 0 disables rate limiting. |

Advanced (collapsed by default, 3): `max-consecutive`, `emotive-bypass`, `verbose`

**21. Speech Transcription** · package `ondra-asr` · enabled · 15 settings · 2 not directly settable

Speech Transcription: local whisper first with a cloud fallback, producing text with timestamps. It only wires things up: it builds a whisper command, waits for it to finish and reads the JSON it writes into millisecond timestamps, and only when the local path is unavailable does it make a single multipart upload to the cloud. Three rulings are hard-coded. First, local first, because voice is among the most private content and anything that can be transcribed on this machine never leaves it. Second, silent failure, since a user sending a voice message should not receive an error and anything that cannot be transcribed counts as unheard. Third, no invented speakers: whisper does no speaker separation and this plugin does not pretend otherwise, keeping the speaker field but leaving it empty when unknown and reporting separation as always false. The transcript never enters memory directly; it hands a multimodal draft to multimodal memory instead. This plugin creates no tables, concatenates no prompts, draws no interface and installs no timer.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, but transcribe always returns disabled. |
| `provider` | Segmented | local | local / cloud | Preferred source. The requirement is local whisper first with a cloud fallback, so the default is local. |
| `binary` | Text | whisper-cli | — | Whisper executable, located on PATH. Newer whisper.cpp builds name it whisper-cli and older ones name it main. |
| `language` | Text | Blank | — | Language hint, one of zh, en or auto. Leaving it empty means detect automatically. |
| `cloud-base-url` | URL | https://api.openai.com/v1 | — | Cloud endpoint, an OpenAI-compatible audio transcriptions route. |
| `cloud-model` | Text | whisper-1 | — | Cloud model id. The example is OpenAI's whisper-1, though a compatible endpoint can use its own. |
| `credential-ref` | Text | OPENAI_API_KEY | — | Name of the environment variable holding the cloud credential, not the value itself. |
| `allow-cloud-fallback` | Switch | On | — | Whether to fall back to the cloud when the local path fails. Turning it off keeps everything on this machine. |
| `quiet` | Switch | On | — | Whether to suppress warnings on failure. Counters and the last error are still recorded. |

Advanced (collapsed by default, 6): `threads`, `timeout-ms`, `cloud-without-privacy`, `max-audio-bytes`, `max-chars`, `verbose`

Not directly settable (2): `model-path` (Executable or model path. The panel cannot locate it on the user's behalf, and a wrong value only surfaces at runtime.); `ffmpeg-path` (Executable or model path. The panel cannot locate it on the user's behalf, and a wrong value only surfaces at runtime.)


#### Voice & Appearance · Appearance

**22. Expression Decision** · package `ondra-expression-decide` · enabled · 5 settings

Expression Decision: classifies finished text into one of six states by clue words, punctuation and sentence shape, and hands that to the portrait layer to change the face. It answers only what the face should show when this line is spoken, inserting no marker into the text and writing no state name into the prompt. With no clue in the text it falls back to the current state from six-state expression, and when neither is available it gives the least error-prone default expression while letting the caller see that this time there was no basis.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, no marker is ever produced. The service still registers. |
| `min-score` | Slider | 2 | 1 – 10 | Score threshold between 1 and 10, where a strong word scores 3, a medium word 2, punctuation 2 and sentence shape 1. The default of 2 means one medium word or two weak clues. |
| `use-state-fallback` | Switch | On | — | Whether to follow the current six-state emotion when the text carries no clue, leaving the face unchanged. When off, the default expression is used directly. |

Advanced (collapsed by default, 2): `fallback-state`, `verbose`

### 3.5 Developer Features

This menu answers how to find out why she behaves a certain way, how to change it, and how to inspect it. It holds 8 groups, 35 plugins and 192 configurable fields, of which 185 can be changed directly, the largest top-level menu in the project. It contains Foundation & Host (core assembly, desktop bridge, kernel client, clock, identity, configuration source of truth, path layout, model gateway, Chinese logging, port picking, process supervision, window), Storage & Data, Context Assembly, Gating & Compliance, Tools & Capability Surface, Life & Perception, Care & Guidance, and Installation & Assembly. Exactly one of its 35 plugins is off at the factory default: vision (`ondra-vision`), which reads the screen and sends captures to an external model, putting both steps outside the machine.


#### Developer Features · Care & Guidance

**23. Crisis Escalation** · package `ondra-crisis` · enabled · 4 settings · 1 not directly settable

Crisis Escalation: answers exactly one question, which is whether this sentence carries a signal that deserves stopping for. Five signal classes covering indirect expression, direct expression, planning, farewell and self-harm each map to one of four tiers, then pass through contextual markers, and finally produce three boolean suggestions: whether to pause the persona, whether to offer help resources and whether to ask directly. It deliberately does not diagnose and does not score, because a stated risk score of seventy-two would be taken as a conclusion when it is only the output of a pattern match. It promises no confidentiality, since that would make the person stop looking for someone who can actually show up. It persists nothing and writes nothing into the memory library, because storing someone's darkest moment as a searchable memory means she may raise it again at any time, which is a second injury. It embeds no hotline numbers, since numbers differ by region and change over time, and a wrong hard-coded number at a crisis moment is a disaster. It does not treat low mood as a crisis, because sadness is not a crisis and treating every low point as one teaches people to hide their feelings. It returns no original text, only matched offsets, because the matched sentence is itself the most sensitive content. It installs no timer and builds no interface. An assumed context only affects wording and never downgrades anything, and negation and past tense lower the tier by one without zeroing it, so a statement that the person does not want to die but may lose control tonight must still be caught. It has zero upstream service dependencies, the decision is a pure function, and replaying the same text always yields the same conclusion.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, but assess throws disabled instead of silently returning none. |
| `extra-guidance` | Text | Blank | — | One sentence appended after the fallback guidance, for example the name of a local service. Leaving it empty uses the built-in guidance only. |

Advanced (collapsed by default, 2): `scan-chars`, `third-party-resources`

Not directly settable (1): `hotlines` (Structured array (readonly HotlineConfig[]). It needs a form with one row per entry, so a flat settings field does not fit.)

**24. First-run Onboarding** · package `ondra-onboarding` · enabled · 3 settings · 1 not directly settable

First-run Onboarding state machine: turns the four-stage first run into four decidable stages of checking the environment, reusing an existing installation, picking a free port and opening the interface with a token, where each stage must carry evidence to count as done and skipping is allowed only in the single optional stage. It doubles as the acceptance baseline for the opening chapter of the promotional video: the installer title is composed from the identity source, the progress percentage is computed rather than hard-coded, the status lines use two documented sentences, and the first message must be sent proactively by the current persona with copy taken from the current persona name, reporting no persona rather than signing on the persona's behalf when the name is missing. Each of the five acceptance items is three-valued, passing, failing or undecidable, because treating undecidable as passing is self-deception and treating it as failing is a false accusation. It also absorbs five frequent beginner pitfalls from the deployment guide, giving the next step for each rather than restating the symptom, because four of them share the trait that the error does not point at its cause and the fifth reports nothing at all. It renders no interface, sends no message and mounts no component, since rendering belongs to the interface layer, sending to the dialogue layer and component mounting to the installer, and a duplicate copy would inevitably diverge. No method ever throws, because any failed step during the first run should be displayed by the interface rather than reaching the host as an unhandled rejection.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Onboarding switch. When off, begin and advance always return disabled. |

Advanced (collapsed by default, 2): `required-node-major`, `verbose`

Not directly settable (1): `state-dir` (State or data file. Leaving it empty uses the built-in default; no manual entry is needed.)


#### Developer Features · Context Assembly

**25. Injection Dedupe** · package `ondra-inject-dedupe` · enabled · 7 settings

Injection Dedupe: injects one large block on the first round and only deltas afterwards, so the same memory appears once across rounds and blocks, and once context is compressed it releases what has been seen and injects the full block again. Bookkeeping is per memory rather than per block, with memory and pin entries normalised into one fact namespace, and it commits in two stages where the first only lists what to record and the second actually writes, releasing the whole block rather than half of it on failure. It does no packing or budgeting and never touches the prefix.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, begin returns bypassed, and the caller falls back to injecting the whole block. |
| `default-conversation` | Text | default | — | Default session id used when begin is called without one. Call release with the session restart reason before switching sessions. |
| `auto-detect-compaction` | Switch | On | — | Whether to read the dialogue orchestrator's compression counter and release seen entries automatically. This only applies to a single session; with several, it explicitly does not guess. |

Advanced (collapsed by default, 4): `max-seen-per-conversation`, `max-conversations`, `max-pending-batches`, `verbose`

**26. Date Facts** · package `ondra-live` · enabled · 6 settings

Date Facts: the weekday, the lunar date, whether a solar term falls today and whether a festival occurs, all computed locally without a network call. Not one line of lunar algorithm is written here: the lunar library is wired in, two branches are cross-checked against each other, and without the package it honestly degrades to the Gregorian calendar alone. The output is intended only for the volatile segment of the prompt and never enters the frozen prefix.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. The facts remain computable as pure date arithmetic when off, but the interface should show it as disabled. |
| `provider` | Segmented | auto | auto / lunar-js / tyme4ts / solar-only | Calendar branch: auto uses a lunar package when present and the Gregorian calendar otherwise; lunar-js, tyme4ts and solar-only force a specific one. |

Advanced (collapsed by default, 4): `crosscheck-on-start`, `upcoming-days`, `cache-days`, `verbose`


#### Developer Features · Gating & Compliance

**27. Evidence Gate** · package `ondra-evidence-gate` · enabled · 13 settings

Evidence Gate: the memory write gate, covering four quotation classes of user, tool, action and self, verbatim comparison against the original, a requirement that numbers carry a source, and rejection of attribution claims lacking a user quotation. It is a deterministic code gate with zero model calls.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the gate admits everything, which amounts to abandoning the rule that nothing enters memory without a source. |
| `max-text-chars` | Slider | 200 | 20 – 2000 | Character cap on the body. Entries are required to stay within 200 characters, and longer ones are truncated rather than rejected outright. |
| `max-summary-chars` | Slider | 80 | 10 – 500 | Character cap on the summary, required to stay within 80. |
| `digit-source` | Segmented | tool-or-user | tool-or-user / tool-only / off | Permitted sources for digits. tool-or-user accepts coverage by a TOOL or USER quotation, tool-only accepts TOOL alone, and off performs no check. |
| `strict-attribution` | Switch | On | — | Whether to run text-level attribution detection, rejecting a body that names the user with an attribution verb while carrying no USER quotation. |

Advanced (collapsed by default, 8): `min-quote-chars`, `max-evidence`, `unbacked-digit-action`, `strict-source`, `self-only-action`, `log-limit`, `log-prune-batch`, `max-log-text-chars`

**28. Privacy & Egress** · package `ondra-privacy` · enabled · 6 settings

Privacy & Egress: compliance notice, three-tier risk reminders and an egress manifest. It does no encryption and no proxying, because becoming a gateway would force data through this plugin, putting credential values into its memory, error context and logs, which would grow a second key pathway out of nothing, and the model gateway had just changed key injection into an existence pre-check plus reference registration for exactly that reason. So this plugin answers one question only: whether this may be sent, to whom, and who approved it. A capability first declares what it sends, where, why it must leave and which environment variable it needs, and then evaluates before actually sending; anything undeclared is refused rather than allowed by default. Risk has three tiers and the boundary is not an adjective but reversibility: metadata or text without identity goes through the first tier of notice, while images, voice, files, identifiable content and anything that cannot be recalled go through the second tier of confirmation, and key-shaped content leaving the boundary, a credential reference written as a value or an undeclared target host triggers the third tier of blocking. The tier setting changes only the handling and never the tier itself, because letting a fully automatic mode lower the tier would hide a genuinely high risk from the panel, which is a variant of a fake switch. Turning the gate off removes only notice and confirmation while the red lines still block, since a red line that a switch can disable is no red line at all. Consent is remembered and persisted per capability and host, because otherwise every start asks again and after three times the user switches it off; a parse failure counts as empty rather than as blanket consent; credentials are stored as variable names only and values never pass through here; and a scan hit returns position and kind, never the original text. It registers no tools, because consent is a human action and a model should not be able to nod on its own.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Privacy gate. Turning it off removes the notice and confirmation steps, while the red lines still block: keys leaving the boundary and undeclared hosts. |
| `approval-mode` | Segmented | auto | supervised / auto / full | Tiered auto-approval: supervised asks for every high-risk action, auto lets low-risk actions through while asking for high-risk ones, and full skips approval but requires the sandbox write boundary. |
| `strict-hosts` | Switch | On | — | Whether to refuse outright when the target host is missing from the declared list. Turning it off asks once instead of admitting it. |
| `scan-secrets` | Switch | On | — | Whether to scan outgoing samples for key-shaped fragments. Long hashes trigger false positives, so turn it off if that happens. |

Advanced (collapsed by default, 2): `consent-ttl-ms`, `verbose`

**29. Capability Sandbox** · package `ondra-sandbox` · enabled · 6 settings

Capability Sandbox: divides how much a plugin may do this time into four levels of read, suggest, act and spend, issues a ticket with an expiry and a use cap, and refuses anything beyond it. Four rulings are hard-coded. Deny by default, so no ticket means no capability. A ticket becomes invalid on expiry, and after expiry it must still be possible to find which ticket it was and the exact second it ended, with the end time stored as the expiry rather than the moment expiry was noticed. The spend level requires a second confirmation, where the caller must place the action name verbatim into the confirmation, because a boolean always gets copied as true while retyping the action name at least requires knowing what is being done. Tickets are persisted with mode 0600 and atomic writes, holding tickets only and no call content at all, since parameters, return values and reasons would amount to a behavioural log. The boundary with the tool gate is that one governs whether an organ may use the host facade as an in-process capability allow list raising a capability denied error, while this one governs whether a specific action should be admitted with a ticket, a deadline and a use count raising a sandbox denied error; both layers must pass, neither replaces the other, and the error classes are deliberately named differently so a single catch cannot conflate lacking authority with an expired ticket. It does not take over the host permission system, does not implement the organ interface, builds no interface, installs no timer and initiates nothing.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, grant, check and revoke throw disabled, and snapshot stays readable. |
| `default-ttl-hours` | Slider | 24 | 1 – 8760 | Default ticket lifetime in hours. The default of 24 reflects that the world has usually changed overnight. |
| `max-ttl-hours` | Slider | 168 | 1 – 8760 | Maximum ticket lifetime in hours, defaulting to 168, or seven days. Anything longer cancels the meaning of a time limit. |
| `default-uses` | Slider | 8 | 1 – 10000 | Default cap on uses, defaulting to 8. Beyond that the action deserves its own ticket rather than one broad ticket. |
| `max-uses` | Slider | 100 | 1 – 10000 | Maximum uses on a single ticket, defaulting to 100. At that point the ticket is standing authorisation and belongs to manual review. |

Advanced (collapsed by default, 1): `max-tickets`

**30. Tool Gate** · package `ondra-organ-gate` · enabled · 9 settings

Tool Gate: schema gating and deterministic intent routing. It runs keyword rules over this turn's user wording, works out which tool families could actually be needed and removes the rest from that agent's schema view, saving input tokens every turn. On a measured set of forty-eight commands the figure went from 55,154 to 8,433, a reduction of 84.7 percent, though this plugin promises no particular ratio, since that number came from another agent's own rule table and this plugin's default rule table is written against real upstream tool names, so the ratio has to be measured. Three safety designs apply. It observes by default, computing without blocking so the report comes before enforcement, the same migration discipline as shadow billing. It gives everything when unsure, applying no restriction at all when no rule matches, preferring to spend tokens over guessing. And it breaks the circuit, abandoning gating for the whole turn when the share to be removed exceeds a ceiling or the remaining tools fall below a floor. In implementation there is one action only, restricting the agent's tool view, which changes no tool implementation and no upstream code. Each turn first withdraws last turn's restriction, since otherwise a view trimmed by itself would never let the needed tools come back. This plugin installs no timer, registers no tool, writes no prompt and calls no model.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `mode` | Segmented | observe | off / observe / enforce | off does nothing, observe computes without blocking and is the default for reading the report first, and enforce actually strips. |

Advanced (collapsed by default, 8): `min-tools-to-gate`, `min-keep-tools`, `max-deny-ratio`, `chars-per-token`, `report-limit`, `never-deny`, `intent-chars`, `verbose`

**31. Proactive Gate** · package `ondra-proactive-gate` · enabled · 21 settings

Proactive Gate: whether a pending message may be sent right now. Nine gates apply, covering the master switch and the group-chat red line, the circuit breaker and backoff, content red lines, the silence period, the daily budget, the idle threshold, the conversation cooldown, duplicate dedupe and a three-layer token bucket. It only decides, never sending, never scheduling an alarm and installing no timer, and state is persisted with mode 0600 and atomic writes, because clearing it on restart would let a restart bypass the anti-ban protections.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, but gate always drops with reason disabled. |
| `daily-quota` | Slider | 3 | 0 – 20 | Daily budget for proactive delivery. It counts proactive messages only, never replies. |
| `quiet-start` | Text | 23:00 | — | Start of the product silence period. It blocks proactive messages only. |
| `quiet-end` | Text | 08:00 | — | End of the product silence period. |
| `idle-minutes` | Slider | 25 | 0 – 1440 | How many minutes the target conversation must have been quiet before a proactive message is allowed. |

Advanced (collapsed by default, 16): `anti-ban-quiet-start`, `anti-ban-quiet-end`, `per-minute`, `per-hour`, `per-day`, `max-len`, `hard-max-len`, `group-cooldown-ms`, `private-cooldown-ms`, `dedupe-minutes`, `dedupe-min-len`, `jitter-ms`, `circuit-hits`, `circuit-minutes`, `block-words`, `verbose`

**32. Proactive Rhythm** · package `ondra-proactive-quota` · enabled · 9 settings

Proactive Rhythm: whether she still feels like talking right now, how many messages remain today and whether it is time to bow out. It covers the quota tier of slow, standard and fast, the minimum interval between two proactive messages, characterful silence with a deterministic drop rate, the farewell line after several unanswered attempts, and a one-touch mute entry. It does not decide whether sending is allowed, does not recompute quota decay, generates no text and installs no timer.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, but plan always drops with reason disabled. |
| `profile` | Segmented | standard | slow / standard / fast | Quota tier: slow sends one a day, standard three a day and fast six a day. Use the enable switch to turn it off. |
| `min-interval-minutes` | Slider | 90 | 0 – 1440 | Minimum interval between two proactive messages, in minutes. A provisional value of 90 awaits adjudication. |
| `give-up-rate` | Slider | 0.3 | 0 – 1 | Drop rate for characterful silence. The documented value is 0.35 and two places disagree, so this awaits adjudication. |
| `retreat-after-proactive` | Slider | 2 | 1 – 10 | How many proactive messages after the user speaks before switching to a farewell line. |
| `retreat-silent-days` | Slider | 2 | 1 – 30 | How many consecutive silent days before switching to a farewell line. |

Advanced (collapsed by default, 3): `quota-override`, `retreat-per-day`, `verbose`

**33. Proactive Motivation** · package `ondra-proactive-reason` · enabled · 4 settings

Proactive Motivation: what to use as a reason to speak right now. Eight candidate classes covering obsessions, due promises, emotional deviation, todos, recent events, the timeline, the environment and a line pool are ordered by priority in dictionary order, with weights compared only within the same class, and a seventy-two-hour topic cooldown guarantees the same matter is raised only once in three days. It produces the reason without generating text, does not decide whether to send and does not cut by count.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, but plan returns disabled. |
| `cooldown-hours` | Slider | 72 | 0 – 720 | Cooldown in hours for the same topic, with 72 as the documented value. |
| `pool-enabled` | Switch | On | — | Whether a fallback line pool is allowed. |

Advanced (collapsed by default, 1): `verbose`

#### Developer Features · Tools & Capability Surface

**34. Organ Host** · package `ondra-organ-host` · enabled · 11 settings

Organ Host: the organ interface host, covering load topology, capability allow list, energy accounting, feedback arbitration, prompt assembly and telemetry. Three non-negotiable constraints live here. Organs never write state directly, since they can only propose through feedback while the flush accumulates per target, applies once and clamps, because applying each proposal would make the result depend on registration order. An organ must pay energy for its own perception and may be refused, since consuming is the only entry point to read-state permission and a denial makes the read throw rather than relying on self-restraint. And organ errors must not propagate, with each of the tick, tool-result and prompt handlers wrapped in its own try and catch that converts a throw into a degraded count. The context handed to organs is a facade rather than the raw context, exposing ten members for state, consumption, events, gap proposals, tool results, ticks, tool registration, prompts, key-value storage and logging, and the capability allow list denies by default, raising a capability denied error for anything undeclared rather than ignoring it. Prompt fragments carry order, lifetime and confidence, are sorted by order and filtered for expiry and low confidence. Scars are always pinned at the lowest weight, and an organ declaring a weight below the floor is refused rather than clamped, since clamping would let the author believe the value took effect. Energy accounting defaults to shadow billing that records without charging; after a week of telemetry each organ is switched to real charging individually, and any step can be rolled back with no window of double billing ever existing. This plugin installs no timer at all, since ticks are scheduled by the host, and that is exactly what zero residence means.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Organ host master switch. When off, every register call is refused with reason disabled. |
| `charge-mode` | Segmented | shadow | shadow / additive | Billing mode. shadow only records without charging and is the default, while additive charges for real. Run shadow for a week during migration. |
| `min-confidence` | Slider | 0.2 | 0 – 1 | Minimum fragment confidence; anything below it is not injected. The value of 0.2 is an engineering choice, since no number was supplied. |
| `enforce-receipt` | Switch | On | — | Whether to enforce consuming before reading state. This is the only enforcement of that constraint, so avoid turning it off routinely. |

Advanced (collapsed by default, 7): `receipt-ttl-ms`, `max-fragments`, `max-chars-per-fragment`, `kv-limit`, `max-pending`, `denied-capabilities`, `verbose`

**35. Vision** · package `ondra-vision` · off at factory · 12 settings · 1 not directly settable

Vision: image understanding, text extraction by OCR, object localisation and video frame sampling. The requirement is a pluggable provider with the feature off by default and linked to the privacy gate so egress is announced first, so this plugin does three things: turn an image into a Chinese description, pull the text out of an image and turn where something is into a normalised box, plus sampling four frames from a video. Not one line of model inference is written here: recognition belongs to the provider, and this plugin handles request shaping, configuration, timeouts, degradation and egress permission. Three rulings are hard-coded. It is off by default, because sending one image outward amounts to sending the user's screen to someone else. Egress must have someone say whether it may be sent, so with the privacy gate present its verdict of allow, ask or deny is followed, and without it nothing goes to the cloud unless cloud use without privacy is explicitly enabled. Failures quietly return a reason code without throwing or inventing content, since a guessed description would enter memory as a false fact. This plugin draws no interface, creates no session, writes no memory and installs no timer; storage belongs to multimodal memory, egress compliance to the privacy gate, and the interface to the shell.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | Off | — | Master switch, required to default to off: sending one image outward amounts to sending the user's screen to someone else. |
| `provider` | Segmented | ollama | ollama / openai / qwen | Provider: ollama for a local service, openai for an OpenAI-compatible endpoint, or qwen for a Qwen-compatible endpoint. |
| `base-url` | URL | Blank | — | Overrides the default endpoint. Leaving it empty uses the provider default, and a wrong value reports a bad base rather than falling back silently. |
| `model` | Text | Blank | — | Model name, required. Examples are llava for ollama, gpt-4o-mini for openai and qwen-vl-plus for qwen, though these are examples rather than defaults. |
| `credential-ref` | Text | Blank | — | Name of the environment variable holding the credential, not the value. Leaving it empty uses the provider default, OPENAI_API_KEY for openai and DASHSCOPE_API_KEY for qwen. |
| `detail` | Segmented | auto | auto / low / high | Image detail tier, meaningful only for OpenAI-compatible endpoints. auto leaves the choice to the provider. |

Advanced (collapsed by default, 6): `timeout-ms`, `max-image-bytes`, `max-output-chars`, `video-frames`, `cloud-without-privacy`, `verbose`

Not directly settable (1): `ffmpeg-path` (Executable or model path. The panel cannot locate it on the user's behalf, and a wrong value only surfaces at runtime.)


#### Developer Features · Storage & Data

**36. SQLite Backend** · package `ondra-store-sqlite` · enabled · 0 settings

SQLite Backend: the SQLite storage port, with write-ahead logging, foreign keys, strict tables, column backfill and file permissions tightened to 0600, degrading rather than blocking on failure.

This plugin has no settings visible at the factory default.

**37. JSON Backend** · package `ondra-store-json` · enabled · 0 settings

JSON Backend: the JSONL persistence backend and the multi-scheme fallback used when SQLite is unavailable or its database is corrupt, with append logging and atomic compaction, degrading rather than blocking on failure.

This plugin has no settings visible at the factory default.

**38. In-memory Backend** · package `ondra-store-memory` · enabled · 0 settings

In-memory Backend: the in-memory fallback store that keeps the main conversation going when SQLite cannot be opened, explicitly without persistence.

This plugin has no settings visible at the factory default.

**39. Snapshot** · package `ondra-snapshot` · enabled · 0 settings

Memory Snapshot: a consistent copy through VACUUM INTO, rotation keeping three, integrity verification, and a restore that must be confirmed explicitly and never runs automatically.

This plugin has no settings visible at the factory default.

**40. Version Migration** · package `ondra-data-migrate` · enabled · 0 settings

Version Migration: idempotent version migration, with the user version pragma as the single source of truth, one transaction per migration, and table rebuilds for type, primary key and not-null drift.

This plugin has no settings visible at the factory default.

#### Developer Features · Foundation & Host

**41. Core Assembly** · package `ondra-core` · enabled · 0 settings

Core Assembly: assembles the Cordis plugin members owned by this project through an explicit list, replacing the previous approach of stacking patches.

This plugin has no settings visible at the factory default.

**42. Desktop Bridge** · package `desktop-bridge` · enabled · 0 settings

Desktop Bridge: bridges the native capabilities of the Tauri shell, covering file selection, system theme, window title and external links.

This plugin has no settings visible at the factory default.

**43. Kernel Client** · package `dsh-client` · enabled · 0 settings

Kernel Client: wraps JSON-RPC communication with the kernel, covering child process lifecycle management and request pairing.

This plugin has no settings visible at the factory default.

**44. Clock** · package `ondra-clock` · enabled · 0 settings

Clock: the unified time source, with a fixed time zone, calendar-correct day boundaries and revocable timer lifetimes.

This plugin has no settings visible at the factory default.

**45. Identity** · package `ondra-identity` · enabled · 0 settings

Identity: the single source for product name, process name, pidfile name, environment variable prefix, directory names and the log namespace root.

This plugin has no settings visible at the factory default.

**46. Config Source of Truth** · package `ondra-config-schema` · enabled · 0 settings

Config Source of Truth: the only implementation of four-layer merging from factory through bundle and user to runtime, with per-field fallback and provenance tracking.

This plugin has no settings visible at the factory default.

**47. Path Layout** · package `ondra-path-layout` · enabled · 0 settings

Path Layout: the single entry point for resolving the data root, creating the five area directories and tightening permissions to 0700 and 0600.

This plugin has no settings visible at the factory default.

**48. Model Gateway** · package `ondra-llm-gateway` · enabled · 8 settings · 1 not directly settable

Model Gateway: a three-source list of online API, local and free models, priority-based routing, first-chunk and inter-chunk timeouts, pre-first-chunk retries with cross-source degradation, and usage accounting.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `timeout-ms` | Slider | 20000 | 1000 – 600000 | First-chunk timeout in milliseconds, measured from sending the request to the first chunk. A local large model may take over twenty seconds to load the first time, so raise this per source. |
| `idle-timeout-ms` | Slider | 60000 | 1000 – 600000 | Inter-chunk timeout in milliseconds, the longest wait allowed between two chunks. The total length of a streaming reply is unpredictable, so the gap is bounded rather than the total. |
| `max-attempts` | Slider | 2 | 1 – 5 | Maximum attempts per source including the first. A request that has already produced text is never retried, so this number only covers the time before the first chunk. |
| `backoff-ms` | Slider | 500 | 0 – 10000 | Retry backoff base in milliseconds, growing as powers of two with symmetric jitter. |
| `max-backoff-ms` | Slider | 8000 | 0 – 60000 | Retry backoff ceiling in milliseconds. |
| `allow-fallback` | Switch | On | — | Whether to move on to the next source after one fails completely before producing a first chunk. |
| `check-credential` | Switch | On | — | Whether to check that the credential reference resolves before making a request. When off, a missing key surfaces as an authentication error from upstream. |

Advanced (collapsed by default, 1): `retryable-codes`

Not directly settable (1): `sources` (Structured array (readonly SourceSpec[]). It needs a form with one row per entry, so a flat settings field does not fit.)

**49. Chinese Log** · package `ondra-log-zh` · enabled · 0 settings

Chinese Log: a two-layer log where sentences meant for people and code logs meant for developers are written separately, rotating at 4 MB across three files, with duplicate errors deduplicated to prevent write amplification.

This plugin has no settings visible at the factory default.

**50. Port Picker** · package `ondra-port-picker` · enabled · 9 settings

Port Picker: splits the request for a port number into two intents. When a listener needs a number nobody currently holds, the system may allocate one, equivalent to port zero and the most robust option, or a fixed range from the design may be used. When the interface needs the number the host already holds, there is only the established fact of the host web server to read. Mixing the two intents hands a child process the port the host itself occupies, whose symptom is a port conflict at startup while the log claims a free port was found. It releases the port immediately after probing and the interface has no hold operation, because holding one means keeping in hand the number meant to be handed over, leaving the child unable to bind. Every allocation therefore states honestly whether a race window exists, and only reading an already-bound host port has none. It accepts loopback literals only and refuses wildcard addresses, matching the upstream stance. It never assembles URLs, since assembling addresses belongs to the bootstrap layer, which is the side that knows where the token comes from, and two copies would eventually produce two shapes. It also does not probe at load time, since binding a port when nobody needs it only wastes one slot in the kernel table. No method throws, because failing to find a port is normal and callers should not have to choose whether to wrap the call.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Port picking switch. When off, pick returns disabled while the ledger stays readable. |
| `branch` | Segmented | system | system / fixed | system lets the kernel allocate, equivalent to port zero and the most robust choice; fixed scans within the range, useful when a whitelist or firewall needs a fixed port. |

Advanced (collapsed by default, 7): `range-start`, `range-end`, `host`, `probe-timeout-ms`, `max-scan`, `ledger-ttl-ms`, `verbose`

**51. Process Supervisor** · package `ondra-process-host` · enabled · 10 settings · 1 not directly settable

Process Supervisor wiring layer: hands the argument vector, working directory, standard streams and grace period explicitly to the upstream subprocess service, restarts once on a crash within budget, cleans up through the provider's supervised process scope so the whole group is killed, and keeps state under the user's process host directory. It deliberately never kills on its own, because POSIX process scopes and Windows job objects are the layer that prevents a trail of orphaned grandchildren, and rebuilding a job object would be in-house work where reuse is required. It also deliberately does not outlive its parent, because a process detached from the parent's lifetime has nobody to collect it after the plugin unloads, leaving the port occupied and the pid file stale until the next start hits a conflict, and the platform rules forbid shipping anything but a plugin package with no resident background service. The pid file does only what it can: the upstream handle does not expose a pid, so it is written when available and not created otherwise, since a fake pid is far worse than a missing file when scripts read it and kill an unrelated process. Restarts carry a generation number, so a late callback from an old handle cannot misjudge the new process as crashed. Stopping reports the group kill being issued separately from silence being confirmed, because the first is a request and only the second is a fact. No method ever throws, because supervision failure is normal and callers should not have to choose whether to wrap the call.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Supervision switch. When off, start refuses outright while stop can still clean up something already running. |
| `max-restarts` | Slider | 1 | 0 – 5 | Maximum restarts. The documented value is 1, and 0 means a crash is left alone. A second retry is worth close to nothing. |
| `cwd` | Text | Blank | — | Default working directory. Empty means the host working directory, since upstream requires the caller to supply one and this plugin never guesses a project path. |

Advanced (collapsed by default, 7): `restart-delay-ms`, `min-uptime-ms`, `grace-ms`, `stop-timeout-ms`, `write-pid-file`, `collect-bytes`, `verbose`

Not directly settable (1): `state-dir` (State or data file. Leaving it empty uses the built-in default; no manual entry is needed.)

**52. Window** · package `ondra-window` · enabled · 6 settings

Window: consolidates the window specification and the version guard, gathering the title-bar height, draggable hot zone, traffic light geometry, centre point, three-column widths and five breakpoints into one definition, offering two branches of hidden inset with system traffic lights as the default and most robust, or hidden with custom drawing on macOS only where the coordinates have no documented source, and checking the version allow list in the shell-side patch. It creates no window, because no window service key exists upstream, the Electron shell is not here, and inventing a service key would only yield a dependency that is forever undefined. It patches nothing either, since that needs the shell main process, so the applied field in its plan is typed as the literal false, which pins the truth down in the type system and makes any attempt to change it fail compilation. The version guard is written against the named past failures: the allow list is not a minimum version but the list actually verified, and a version outside it leaves the patch unapplied, because applying wrongly is far worse than not applying, producing a misaligned title bar, traffic lights overlapping content and a drag zone covering buttons, all without any error. The expected version defaults to empty, because empty means nothing was declared verified and judging it as passing would treat silence as full verification. The self-consistency check reports three conflicting figures, the relationship between the title and drag values, a one-pixel discrepancy between two radii and a layout that does not fit, reporting all of them honestly without altering any settled value.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Window spec switch. When off, plan reports disabled while spec stays readable, since a spec is not behaviour. |
| `branch` | Segmented | a | a / b | a gives hiddenInset with the system traffic lights and is the default and most robust; b gives hidden with custom drawing, macOS only, and its coordinates have no documented source. |
| `platform` | Segmented | auto | auto / macos / windows / linux | auto follows the process platform. An unrecognised platform stays unrecognised rather than defaulting to macOS. |
| `patch-target` | Text | Blank | — | Absolute path to the shell-side patch file, such as a patch-host script. Empty means it cannot be judged. |
| `expected-versions` | Text | Blank | — | Verified Electron versions, comma or space separated, for example 33,34. Empty means it cannot be judged, and nothing is signed off on your behalf. |

Advanced (collapsed by default, 1): `verbose`

#### Developer Features · Life & Perception

**53. Life & Routine** · package `ondra-life-rhythm` · enabled · 10 settings

Life & Routine: on one side she lives her own days, with six activity classes, interest weights and tags of demanding, relaxing and creative, a ten percent chance of exploring a new interest, a preference for relaxing activities when mood is low, one weighted draw per cycle, half-life decay for interests long untouched, and notes split into long-term and temporary. On the other side sits the energy score, rising while awake, rising faster during deep sleep or late at night, with a natural ceiling, a slow decline above the full mark, a freeze during an emergency stop, integration in five-minute slices, and a waking buffer that clears once taken. There is a single clock-driven tick, no subprocess, no resident loop, and it stops on unload.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, but plan always returns disabled. |
| `activity-every-minutes` | Slider | 45 | 10 – 180 | Minimum interval between two activities, in minutes between 10 and 180. A provisional value, since the requirement only says random. |
| `explore-rate` | Slider | 0.1 | 0 – 1 | Probability of exploring a new interest. Drawn deterministically, so it stays constant within the same time slot. |
| `rest-start` | Text | 23:30 | — | Start of the rest period. No activity is scheduled during it; late night is for recovery only. |
| `rest-end` | Text | 07:00 | — | End of the rest period, exclusive and allowed to cross midnight. |
| `enable-energy` | Switch | On | — | Energy system switch. When off, only the life layer runs and the energy readout keeps returning the value from when it was closed. |

Advanced (collapsed by default, 4): `interest-decay-hours`, `mood-low-threshold`, `max-notes`, `verbose`

**54. Gap Pool** · package `ondra-drive-gap` · enabled · 8 settings

Gap Pool: records the few things she has not worked out. Three sources generate entries, namely the model admitting it does not know, a tool search returning nothing and a request failing. Tension derives idempotently from creation time as base plus hours times rate minus relief plus added pressure from dedupe, similarity at or above 0.6 adds pressure without creating a new entry and keeps the earliest wording, and closing an entry closes similar open ones with it. Four wake conditions apply, with tension at least 80, energy above 30, idle time beyond 30 minutes and no cooldown within 60 minutes, plus an offline dream window from 02:00 to 05:00, and sleep duration only feeds gaps that already existed at that time.

**The writer for the first source is `ondra-memory-intake`.** After each turn, `intake` takes her own sentences that admit uncertainty, failed searches or an inability to recall, passes the whole sentence to `detect()` and then to `open()` — at most one per turn, and only from `role=assistant`. Before that, `open()` had no caller anywhere in the repository: however complete the pool was, it had been empty since the database was created, and the symptom matches "this feature was never built" exactly.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, nothing is tracked, no wake-up is judged and no fragment is produced. The service still registers, and readers see an empty pool. |
| `base-tension` | Slider | 40 | 0 – 100 | Starting tension of a new gap, between 0 and 100. The default of 40 with 2.5 per hour reaches the wake line in about sixteen hours, which means leaving it for a whole day. |
| `tension-per-hour` | Slider | 2.5 | 0.1 – 20 | How many points are added per hour. The default is 2.5. Raising it only makes the same matter wake her sooner. |
| `fragment-ttl-minutes` | Slider | 30 | 1 – 720 | How long an obsession fragment stays alive, in minutes. The default of 30 reflects that whether to raise something in one conversation stays relevant for half an hour. |

Advanced (collapsed by default, 4): `max-open`, `fragment-order`, `closed-retain-days`, `verbose`

#### Developer Features · Installation & Assembly

**55. Installer** · package `ondra-installer` · enabled · 7 settings · 4 not directly settable

Installer: a manifest-driven installer with a nine-step pipeline, a separate sha256 per component verified both before and after writing, a ledger kept in the user's bootstrap file, and a final self-check. The old project's root cause is named plainly: the manifest held hashes but there was no ledger and no self-check command, so those three are the backbone here. Ordering puts verification strictly before writing, since a hash mismatch means not one byte is written, because otherwise the target directory is already dirty and a rollback either deletes something unrecoverable or leaves bad files to explode somewhere further away on the next start. Overwriting is a separate step: a path present in the ledger means this installer put it there and an upgrade is allowed, while a same-named file at the target that is absent from the ledger belongs to somebody else and is refused by default. Bookkeeping is two-stage, recording half-installed before recording installed, so a process killed mid-copy is seen next time as needing a reinstall rather than as never installed. It rehearses by default and writes nothing, because installation is the only capability that writes the user's directories and an irreversible operation belongs after an explicit second confirmation. All paths default to empty, and being empty it honestly reports a missing manifest, source or target, since a guessed target directory would grow a runtime tree out of nowhere on the user's machine. A failed install is not rolled back automatically, since rollback belongs to the snapshot module, and archives are never extracted, because dependencies may not be added, so this plugin reports the lack of support honestly rather than pretending to unpack.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Installer switch. When off, run refuses outright while verify can still read the ledger. |
| `dry-run` | Switch | On | — | Dry run by default: work out the nine-step conclusion without writing a single byte. Turn this off only after confirming it. |

Advanced (collapsed by default, 5): `max-components`, `max-component-bytes`, `verify-after-copy`, `allow-overwrite`, `verbose`

Not directly settable (4): `manifest-path` (State or data file. Leaving it empty uses the built-in default; no manual entry is needed.); `source-dir` (State or data file. Leaving it empty uses the built-in default; no manual entry is needed.); `dest-dir` (State or data file. Leaving it empty uses the built-in default; no manual entry is needed.); `ledger-path` (State or data file. Leaving it empty uses the built-in default; no manual entry is needed.)

**56. Install Self-check** · package `ondra-install-doctor` · enabled · 5 settings · 1 not directly settable

Install Self-check: uses ported patch parsing, entry patching and entry composition to compute the entry tree the host would actually see, reporting which bundles would be skipped and how many patch warnings arise. It answers a different question from the per-package check: that one asks whether a given package will load, while this one asks what the composed profile looks like, since a package with a correct patch of its own is not necessarily installable in its profile, and the four failures of an unregistered package, an unresolvable bundle, a missing declaration and a patch path written relative to the wrong directory all happen outside the package, all without any error, and all silently remove features. Three implementation rulings follow. Layers are applied one at a time rather than flattened, which is semantically equivalent but lets warnings name the layer, and the layer name is the reason this plugin exists. Reports are cached by content fingerprint with a thirty-second lifetime compared on read, installing no timer. And inspection never throws, folding any exception into an undetermined verdict plus one conclusion, because it is called by both the startup self-check and the interface, and throwing once would get it switched off for good. Read-only is a hard property: it changes no profile, writes no disabled marker, installs no package and runs no organ. It deliberately does not guess the profile path, because the host resolves it from an install anchor and module hoisting rules this plugin cannot see, and a hard-coded copy would inevitably drift, at which point a report saying it will install while the host skips it is worse than no report at all.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Check-up switch. Turning it off only skips the check and never affects loading. This plugin decides without ever blocking startup. |
| `user-layer` | Switch | On | — | Whether to treat the profile's own cordis.patch.yml as the last layer. |

Advanced (collapsed by default, 3): `max-file-bytes`, `verbose`, `ttl-ms`

Not directly settable (1): `profile-path` (State or data file. Leaving it empty uses the built-in default; no manual entry is needed.)

**57. Load Self-check** · package `ondra-startup-check` · enabled · 8 settings

Load Self-check: ten items that only judge and never block startup. What it verifies is not whether the code is correct but whether it was actually installed at all. Three silent failures are listed, and none of them raises an error, affects startup or shows up in the interface. When the package manifest omits the bundle patch declaration, the host prints one line saying so and never loads it. When the patch semantics are wrong, such as an insert carrying an id but pointing at something that is not a group, or an insert with no id, the host warns once and skips it. And when the entry field or the name disagrees with the package name, the outcome is equally silent. All three share the same bad form: clean logs, a healthy process and an absent feature. The tenth item therefore ports the host's entry-patching semantics, computes the entry tree the host would see and checks whether it is in it. The port follows the source rather than a summary: the name mismatch check only applies to patch lines without an insert, the insert branch never looks at the name, an insert with an id silently turns a non-array target into an empty array, and an inserted line immediately enters the index so later patches in the same list can target it, and missing any one of these would make the check report an error against a package that actually loads. When a patch contains syntax outside the supported subset, such as embedded code tags, anchors or streaming collections, the verdict is undetermined rather than passing, because pretending to compute would produce a self-check saying it loads while the host says it does not. The first nine items are the platform's mechanical checks covering structure, manifest, build configuration, the entry contract, service key uniqueness, resolvable dependencies, no out-of-boundary imports, degradation in place and complete deliverables. Degradation in place is a heuristic and produces reminders at most, never a fatal verdict, while service key uniqueness and dependency resolution need a repository-wide index and honestly report that they are not judged when no index exists, rather than treating a single package as unique. The root defaults to empty, because a guessed scan root would run the check against the wrong directory and report everything as passing, which is worse than not checking.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Self-check switch. It only decides and never blocks startup, so turning it off skips the check without affecting any plugin load. |
| `root` | Text | Blank | — | Parent directory holding the plugin packages, which is cordis/ in the development repository. Empty means no scan, and status reports no-root. |
| `self-check` | Switch | On | — | Whether to run its own tenth item at startup, whether the host will load it, and log the result. It only logs and never blocks startup. |

Advanced (collapsed by default, 5): `max-files`, `max-file-bytes`, `max-packages`, `host-keys`, `verbose`

### 3.6 Emotion Engine

This menu answers what state she is in right now. It holds 1 group, 4 plugins and 13 configurable fields, all of them directly changeable. Emotion is not the prompt line you are happy right now; it is a set of state variables that carry inertia and decay on their own. The core maintains the baseline, the relationship stage caps the upper bound of intimacy, six-state expression decides which six words describe the state, and diffusion decides how long an emotion takes to settle. The three derived plugins (conflict, stress, hormone) were removed in that trim: they overlapped with six-state expression, and enabling both made a single turn carry two descriptions of the same mood.


#### Emotion Engine · Emotion Engine

**58. Emotion Core** · package `ondra-emotion-core` · enabled · 4 settings

Emotion Core: three PAD dimensions plus ten fixed labels with each label capped at 0.12, a total label weight capped at 0.6, a label half-life of 45 minutes and a mood half-life of 6 hours, six-dimension exponential regression, a chemical pool with three hormones, temperament knobs, and at most twelve dynamic hormones. A stored record missing a field is filled from the baseline of 50 rather than from zero. It produces state only and handles neither expression nor the stress multiplier.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off nothing is settled or persisted, and downstream reads the baseline state rather than an error. |
| `tension-high-threshold` | Slider | 0.5 | 0 – 1 | Criterion for tension running high. It only answers whether a line was crossed; it is not the conflict lock. |

Advanced (collapsed by default, 2): `max-settle-minutes`, `verbose-save`

**59. Relationship Stage** · package `ondra-emotion-stage` · enabled · 4 settings

Relationship Stage: a seven-stage relationship arc running from hostility through testing, attraction, possessiveness, dysfunction, devotion and finally settling, with four guards against jumping, namely a time gate, a step limit, monotonic increase only and the conflict lock overriding the stage to hostility, which makes the stage a ratchet. The three relationship dimensions carry half-lives, and familiarity derives from interaction count. The five-stage and six-segment views are read-only derivations, and the dysfunction and devotion stages are not shown in the default interface.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, no stage advances and no decay occurs, so the relationship stays as last settled. |
| `idle-settle-minutes` | Slider | 15 | 1 – 10080 | How much idle time must pass before settling. Shorter gaps are skipped, which avoids a disk write every turn. |

Advanced (collapsed by default, 2): `max-settle-hours`, `verbose`

**60. Six-state Emotion Expression** · package `ondra-emotion-express` · enabled · 2 settings

Six-state Emotion Expression: the six states of elated, soft, calm, wilted, bristling and sleepy, matching the promotional chapter exactly with no additions, removals or renaming. One decision feeds the prompt, the rhythm and the speech layers at once, and the speaking rate changes, the proactive quota adjustment, the decision not to read aloud and the sticker probability appear exactly once in the whole repository, here. It emits parameters and never text, since projected text belongs solely to emotional projection.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers but always reports the calm tier and changes no expression parameter. |

Advanced (collapsed by default, 1): `verbose`

**61. Emotion Diffusion** · package `ondra-emotion-diffuse` · enabled · 3 settings

Emotion Diffusion: computes how much of the mood at the end of the previous session carries into this one, by the difference between mood and baseline scaled by 0.4 and damped by familiarity. It computes without writing: it hands out a target and a delta, and the write is done by the caller through the emotion core, while idempotence by boundary key plus an interval gate prevents a conversation from washing the mood out.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, no diffusion is claimed, so the mood keeps the warmth of the previous session. |
| `min-gap-minutes` | Slider | 30 | 0 – 1440 | Interval in minutes between decisions within one session. This number was not supplied and 30 is an engineering choice that keeps a fresh boundary key each turn from washing the mood back to baseline. |

Advanced (collapsed by default, 1): `verbose`


### 3.7 Memory System

This menu answers what she remembers, what she forgets, and when something comes back to her. It holds 1 group, 17 plugins and 205 configurable fields, all of them directly changeable, the largest top-level menu by setting count, all enabled at the factory default. Memory is built as a complete pipeline rather than a vector store: write turns a conversation into both raw text and facts, extraction pulls the facts out, dedupe merges and resolves conflicts, recall retrieves, recognition provides a second retrieval path, the graph holds relations, the eight pools assign tiered lifetimes, decay lets memories fade, dreaming tidies up while idle, promises and todos hold what is unfinished, the forgetting audit answers why she forgot, self-healing repairs inconsistencies, and the right to be forgotten performs real deletion.


#### Memory System · Memory System

**62. Memory Core** · package `ondra-memory-core` · enabled · 12 settings

Memory Core: the two-layer tables of raw text and extracted facts, eleven baseline lifetime classes multiplied together, write scoring, four-state deletion with tombstones, archiving and sinking, and minimum-exposure candidates.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `important-salience` | Slider | 70 | 0 – 100 | Salience boundary for important. Reaching it uses the ninety-day archive window, otherwise thirty days. |
| `archive-normal-days` | Slider | 30 | 1 – 3650 | How long an ordinary memory goes unreferenced before it sinks. It is forgotten rather than deleted, and can still be found by category. |
| `archive-important-days` | Slider | 90 | 1 – 3650 | How long an important memory goes unreferenced before it sinks. |
| `resurface-days` | Slider | 30 | 1 – 3650 | After how many days without being brought up a memory should surface once, as a minimum exposure. This only proposes candidates; injection decides. |
| `max-text-chars` | Slider | 200 | 20 – 4000 | Character cap on the body. Oversized text is truncated with an issue recorded rather than rejected, since rejection would erase the memory entirely. |
| `max-summary-chars` | Slider | 80 | 10 – 1000 | Character cap on the summary. |

Advanced (collapsed by default, 6): `long-term-base-hours`, `channel-anchor-days`, `floor-weight`, `default-channel`, `max-select-rows`, `score-on-write`

**63. Memory Write** · package `ondra-memory-intake` · enabled · 5 settings

Memory Write: writes conversation turns into memory, putting raw text into the raw layer and then handing it to extraction to pull out facts.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | When off, the service still registers but accepts nothing, so the side panel keeps showing no memories. |
| `extract` | Switch | On | — | When off, only the raw text is written: she remembers the conversation happened but cannot say your name. |
| `maxConcurrent` | Slider | 1 | 1 – 4 | Extraction calls the model once per turn. Raising this makes her more responsive and costs more. |
| `maxFacts` | Slider | 6 | 1 – 30 | Leaving it empty lets the extraction service decide, and its default collects by evidence strength. |
| `verbose` | Switch | On | — | Whether to log one line on both acceptance and failure, which is useful when investigating why she does not remember. |

**64. Memory Extraction** · package `ondra-memory-extract` · enabled · 10 settings

Memory Extraction: calls a model to extract facts from conversation, with four quotation classes and verbatim comparison, a requirement that numbers carry a tool source and five levels of parse fallback. It does no deduplication and computes no lifetime.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Extraction master switch. When off, the service still registers but reports unavailable, since off and not installed must be distinguishable. |
| `allow-group` | Switch | Off | — | Whether to extract from group chats. Off by default: not collecting group chatter is an admission red line, not a performance trade-off. |
| `max-facts` | Slider | 8 | 1 – 64 | Maximum extractions per turn. The remainder is refused and recorded as over-limit rather than silently dropped. |
| `max-text-chars` | Slider | 200 | 20 – 2000 | Character cap on the body. Oversized text is truncated on the same basis as the memory core rather than rejected. |
| `max-summary-chars` | Slider | 80 | 10 – 500 | Character cap on the summary. When the model returns none, the leading characters of the body are used instead. |
| `require-tool-for-digits` | Switch | On | — | Whether digits require TOOL coverage. When off, spoken numbers such as an age given in conversation still enter memory. |

Advanced (collapsed by default, 4): `min-quote-chars`, `temperature`, `max-tokens`, `max-input-chars`

**65. Memory Dedupe** · package `ondra-memory-dedupe` · enabled · 15 settings

Memory Dedupe: a five-way verdict before writing, choosing add, merge, append, conflict or drop on a single measure of character bigram containment at 0.4. Merging revises rather than forgets, and the decision log explains it.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, dedupe does not apply and every write creates a new entry, which amounts to disabling deduplication. |
| `merge-threshold` | Slider | 0.4 | 0.05 – 1 | Merge threshold on containment. Below it two texts count as different matters and a new entry is created. The documented value is 0.4. |
| `max-candidates` | Slider | 5 | 1 – 50 | Maximum candidates brought back. The requirement is that only five or fewer candidates reach the model, which is the cost gate. |

Advanced (collapsed by default, 12): `duplicate-threshold`, `append-novelty`, `append-novelty-grams`, `min-compare-chars`, `slot-coverage`, `max-slot-chars`, `candidate-pool`, `max-scan-rows`, `conflict-policy`, `log-limit`, `log-prune-batch`, `max-log-text-chars`

**66. Memory Decay** · package `ondra-memory-decay` · enabled · 9 settings

Memory Decay: strength is always asked of the memory core rather than recomputed, while spaced repetition and Ebbinghaus eight-tier fusion order the reviews, clarity phrasings have three tiers, and orphaned review plans are cleaned up. It decays entries only, since edges belong to the graph.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, nothing is scanned and no review is scheduled, and the memory core's strength calculation is unaffected since it never depended on this plugin. |
| `clear-above` | Slider | 0.7 | 0.05 – 1 | Strength floor for clear. Above it no phrasing is appended at injection time. |
| `faded-above` | Slider | 0.4 | 0.01 – 0.99 | Strength floor for faint. Below it only a shadow remains, and injection appends a note that only a faint shadow is left. |
| `max-review-batch` | Slider | 100 | 1 – 1000 | Cap on the review list per call. Review is for a human to read, and a thousand entries at once is more than anyone finishes. |

Advanced (collapsed by default, 5): `max-scan-rows`, `max-init-per-scan`, `max-interval-days`, `auto-scan`, `scan-interval-minutes`

**67. Memory Graph** · package `ondra-memory-graph` · enabled · 18 settings

Memory Graph: builds four kinds of edges and diffuses one hop. Same-topic edges start at 0.72 and gain 0.05 each time, co-occurrence edges start at 0.15 and gain 0.10, and absurd edges start at 0.03 and never enter retrieval; diffusion has a threshold of 0.4, a hub-degree ceiling of 40 and a ninety-day decay of one half, tracked with a decay cursor. It touches the edge table only and never writes a fact row.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, neither edge creation nor queries work and the service registers as unavailable. |
| `diffuse-min-weight` | Slider | 0.4 | 0 – 1 | Diffusion threshold. The documented value is 0.4, shared with the memory core's graph factor threshold. |
| `hub-cap` | Slider | 40 | 2 – 1000 | Cap on hub degree. Edge creation and diffusion share this constant. |

Advanced (collapsed by default, 15): `same-topic-init`, `same-topic-step`, `cooccur-init`, `cooccur-step`, `surreal-weight`, `default-init`, `default-step`, `max-rings`, `decay-days`, `decay-factor`, `prune-below`, `prune-to`, `max-edges`, `validate-endpoints`, `page-size`

**68. Memory Eight Pools** · package `ondra-memory-pool` · enabled · 8 settings

Memory Eight Pools: a three-stage day-level timeline of grace, half-life and archive, where the core pool never expires but is capped at 32 entries and the other pools run from two years down to one day, with two of them never injected. An unmatched tag is not guessed at but routed to the hippocampus and unclassified, and the same sentence written three times is escalated for manual pool assignment. It computes no strength and changes no column of the fact table.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, neither pool classification nor the timeline works and the service registers as unavailable. |
| `core-cap` | Slider | 32 | 1 – 512 | Cap on the core pool. Reaching it refuses new entries rather than evicting, since deleting a core memory decides for the user that they should not be themselves. |

Advanced (collapsed by default, 6): `escalate-after`, `hint-cap`, `preview-chars`, `allow-legacy-skill`, `due-scan-limit`, `page-size`

**69. Memory Recall** · package `ondra-memory-recall` · enabled · 17 settings

Memory Recall: five factors of semantic, keyword, graph, importance and recency plus rank fusion and BM25. Recall never cuts by count, and sealed memories never take part.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, recall does not work and the service registers as unavailable. |
| `fuse` | Segmented | rrf | rrf / weighted | Fusion mode: rrf for rank fusion, the default, or weighted for a five-factor sum as documented. |
| `graph-seeds` | Slider | 3 | 0 – 20 | Graph seed count, taking the top N literal hits as starting points for one-hop diffusion. 0 disables the graph factor. |
| `include-archived` | Switch | Off | — | Whether sunken memories enter the candidate pool. They do not by default: sunk memories occupy no active slot even though they were never deleted. |
| `vector-branch` | Segmented | auto | auto / off | Vector branch: auto uses vector retrieval when installed, while off forces it closed and drops the semantic factor from normalisation. |
| `recognition-branch` | Segmented | auto | auto / off | Recognition branch: auto uses memory recognition when installed, while off forces it closed. |

Advanced (collapsed by default, 11): `rrf-k`, `bm25-k1`, `bm25-b`, `bm25-half`, `rare-idf`, `rare-min-docs`, `graph-min-weight`, `index-ttl-ms`, `page-size`, `max-scan-rows`, `external-limit`

**70. Memory Recognition** · package `ondra-memory-recognition` · enabled · 15 settings

Memory Recognition: the recognition retrieval branch, where a full index of one trigger line per memory enters the prompt, a small model picks the slug and the walk moves through the link neighbourhood. 500 entries run about 6000 tokens, and the index block is ordered by sequence so it can serve as a prefix cache.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, this service registers as unavailable and the memory core's recognition channel leaves the fusion automatically. |
| `max-entries` | Slider | 500 | 20 – 5000 | Maximum entries indexed. The documented value is 500 entries, roughly 6k tokens, where one Chinese character counts as about one token and four ASCII characters as about one token. |
| `max-ring` | Slider | 2 | 0 – 3 | How many hops to walk along links. 0 disables walking. The requirement only says neighbouring hops, so this plugin supplies the count and defaults to 2, since the third hop is already down to a weight of 0.16 and mostly brings noise. |
| `include-archived` | Switch | Off | — | Whether sunken memories enter the index. They do not by default, since something sunk should not be recognised proactively, though it can still be found by category. |
| `pick-enabled` | Segmented | auto | auto / off | Small-model branch: auto uses the model gateway when available, while off keeps only synchronous deterministic recognition. |

Advanced (collapsed by default, 10): `index-budget-tokens`, `entry-char-limit`, `triggers-per-entry`, `min-score`, `max-seeds`, `index-ttl-ms`, `page-size`, `pick-max-tokens`, `pick-temperature`, `pick-timeout-ms`

**71. Vector Retrieval** · package `ondra-memory-vector` · enabled · 0 settings

Vector Retrieval: the vector branch, with deterministic hash embeddings, cosine recall and inverted-file bucketing, automatically switching between literal, hybrid and vector modes at the 300 and 1000 thresholds with rank fusion. It ships disabled.

This plugin has no settings visible at the factory default.

**72. Memory Anthropomorphization** · package `ondra-memory-humanlike` · enabled · 13 settings

Memory Anthropomorphization: three channel views of fact, gist and affect plus three paths to remembering. A fixed recall dice roll makes fainter memories easier to surface, being prompted by the thread uses a probability gate with reinforcement on a hit, and aimless association ripples outward. Strength is always asked of the memory core and diffusion always of the graph, candidates are supplied by the caller, and no retrieval is rebuilt.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, all three recall paths report unavailable, and the service still registers. |
| `ripple-rings` | Slider | 2 | 1 – 3 | Number of ripple rings. The default of 2 reflects that one ring does not read as aimless and three rings pull the whole graph into context. |

Advanced (collapsed by default, 11): `long-term-base-hours`, `permanent-base-hours`, `min-strength`, `max-strength`, `recent-skip-days`, `cue-base-probability`, `cue-overlap-weight`, `cue-strength-weight`, `min-shared-grams`, `scan-limit`, `page-size`

**73. Memory Dreaming** · package `ondra-memory-dream` · enabled · 30 settings

Memory Dreaming: gated dreaming, where four gates admit only facts carrying textual provenance and which is the default; light sleep consolidation, with shallow sleep after two idle minutes and deep sleep after five, mining five card types by pure rules with zero model calls; and absurd association with dream talk, whose edges never enter retrieval. The three branches are mutually exclusive and every write goes through the memory core.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. The service still registers but reports unavailable when off. |
| `mode` | Segmented | gate | gate / lightweight / surreal | Branch selection. gate supplements only facts carrying textual provenance and is the default; lightweight produces five rule-based card types with no model call; surreal does absurd association and dream talk. Gate and surreal are mutually exclusive, so this is one enumeration rather than two switches. |
| `max-items` | Slider | 6 | 1 – 64 | Maximum facts written per night. Candidates beyond it are refused and recorded as max-items rather than silently dropped. |
| `max-text-chars` | Slider | 200 | 20 – 2000 | Character cap on a fact. Longer text is refused rather than truncated, since truncation destroys the correspondence between quotation and body. |
| `card-half-life-hours` | Slider | 168 | 1 – 8760 | Half-life of a card in hours, with unused cards at 168 hours. A card that has been used restarts from the moment of use. |

Advanced (collapsed by default, 25): `max-candidates`, `dream-salience`, `min-quote-chars`, `surreal-min-gap-days`, `max-surreal-per-night`, `surreal-min-shared-grams`, `card-archive-weight`, `idle-shallow-ms`, `idle-deep-ms`, `talk-min-chars`, `talk-max-chars`, `scan-limit`, `page-size`, `fact-card-days`, `fact-card-salience`, `max-fact-cards`, `temperature`, `max-tokens`, `talk-temperature`, `surreal-recent-seeds`, `tool-pitfall-streak`, `tool-playbook-repeat`, `tool-hotspot-calls`, `tool-hotspot-rate`, `tool-unresolved-fails`

**74. Promises & Todos** · package `ondra-memory-prospective` · enabled · 16 settings

Promises & Todos: promises lock the original wording, weigh more the closer they come, and settle as kept or broken while only suggesting a relationship delta. Promises enter memory with a long lifetime, while todos stay outside the memory chain. Extraction is pure pattern matching with no model call.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, nothing is extracted or stored and the service registers as unavailable. |
| `extract-min-chars` | Slider | 4 | 2 – 40 | Minimum characters for extraction. The documented value of 4 reflects that within three characters a promise cannot be told apart from an offhand remark. |
| `extract-max-chars` | Slider | 120 | 20 – 600 | Maximum characters for extraction. The documented value of 120 reflects that longer sentences are usually narrative rather than promises. |
| `max-promises` | Slider | 20 | 1 – 200 | Cap on promises. Reaching it refuses new entries and reports the refusal rather than evicting, since deleting a promise decides for the user which matter is unimportant. |
| `max-todos` | Slider | 3 | 1 – 20 | Cap on todos. Reaching it refuses new entries and suggests clearing first, the same discipline as the core pool cap. |
| `todo-idle-days` | Slider | 3 | 1 – 30 | How many days an unmentioned todo may live before it expires. |
| `expire-grace-days` | Slider | 3 | 0 – 90 | How many days past the grace period an unsettled promise takes before being converted to expired. |
| `remind-ahead-hours` | Slider | 24 | 0 – 240 | How many hours ahead to remind. |
| `grace-hours` | Slider | 24 | 0 – 240 | Grace period in hours. Within it a promise still counts as in time and is not treated as broken. |

Advanced (collapsed by default, 7): `urgency-horizon-days`, `urgency-floor`, `soon-hours`, `promise-salience`, `promise-arousal`, `max-scan-rows`, `auto-expire`

**75. Forgetting Audit** · package `ondra-memory-audit` · enabled · 9 settings

Forgetting Audit: answers why she can no longer remember, giving strength, half-life, remaining time and three tiers of phrasing, alongside pins capped at eight and four deletion modes, where forgetting writes a tombstone, sealing closes an entry, sinking is natural and revision keeps the old text. It calls only the memory core's public methods and writes no column of the fact table.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, neither explanation nor deletion works and the service registers as unavailable. |
| `pin-cap` | Slider | 8 | 1 – 64 | Cap on pins. Reaching it refuses new entries and reports the refusal rather than evicting, since pulling a pin decides for the user which matter may be forgotten. |
| `resurface-days` | Slider | 30 | 1 – 3650 | Days for minimum exposure. This plugin only produces a candidate list; deciding what to inject belongs to prompt injection. |

Advanced (collapsed by default, 6): `fading-days`, `scan-limit`, `page-size`, `pin-note-max-chars`, `preview-chars`, `auto-scan`

**76. Memory Self-healing** · package `ondra-memory-heal` · enabled · 4 settings

Memory Self-healing: inspects the memory library on demand for fixable problems such as orphaned edges, pins pointing at deleted memories, tombstone leaks, mutually exclusive state flags and empty summaries, sorts each into automatically fixable, advisory only or must not touch, and produces a checkable repair plan that rehearses first. It produces plans and executes item by item only, running nothing in the background, nothing automatically and guessing nothing.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. Self-healing only runs checks on demand, so when off the service still registers but reports unavailable. |
| `check-duplicates` | Switch | On | — | Whether to also check for likely duplicates, reporting only and never merging, since merging belongs to memory dedupe. |

Advanced (collapsed by default, 2): `scan-limit`, `verbose`

**77. Multimodal Memory** · package `ondra-multimodal-memory` · enabled · 19 settings

Multimodal Memory: stores visual descriptions and speech transcripts as ordinary memories while remembering which file they came from. Four rulings are hard-coded. First, the memory body exists in one copy, written into the memory core's fact table, and this plugin builds no second memory library; since that table has no modality or source path columns, this plugin keeps its own edge table hanging metadata off each fact id, and dropping that table would not affect retrieval or injection of any memory. Second, entries stay short while the full text is archived, because entries are capped at 200 characters while a three-minute transcript runs to thousands, so the truncated entry enters retrieval and the full text stays in the edge table, and the 800 characters cut away do not vanish. Third, the fingerprint is recomputed, because the meaning of deduplication is that one piece of content is stored once, and one piece of content must be decided by the content rather than asserted by upstream, so this plugin hashes modality, source path and text again and uses its own value while recording the degradation when they disagree, preferring one visible duplicate over one invisible missing memory. Fourth, the evidence source follows who said it: a transcript is marked as the user speaking and an image description as the tool speaking, since otherwise either the user's words would be recorded as the model's guess or a guess about an image would testify on the user's behalf. This plugin exposes no tools, installs no timer, makes no outbound request and draws no interface; frame sampling belongs to vision, transcription to speech transcription, the evidence gate to its own module, storage to the SQLite backend and the interface to the shell.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, but ingest always returns disabled. |
| `default-subject` | Text | user | — | Which subject to assume when the caller names none. The default is user, since both images and voice come from the user; group chats should pass the speaker explicitly. |
| `max-text-chars` | Slider | 200 | 20 – 4000 | Character cap on an entry entering retrieval, where entries are capped at 200 characters and the remainder stays in the full-text column of the edge table. |
| `dedupe` | Switch | On | — | Whether to deduplicate by content fingerprint. When off, describing the same image twice produces two memories. |
| `respect-tombstone` | Switch | On | — | Whether to respect tombstones, so content the user asked to forget never re-enters even when the same file arrives again. |
| `use-evidence-gate` | Switch | On | — | Whether to pass through the evidence gate. When the gate is absent the entry still lands but the degradation is recorded. |
| `video-frames` | Slider | 4 | 1 – 12 | How many frames to sample from a video. The documented value is 4. |
| `video-describe-frames` | Switch | On | — | Whether to ask vision for a description of each frame. When off only frame paths are stored, saving four model calls but leaving the entry with just a count of frames. |
| `quiet` | Switch | Off | — | Whether to suppress warnings on failure. The default is false, since a failed write is invisible to the user at the time and must leave a trace. |
| `verbose` | Switch | On | — | Whether to log a line on success as well. |

Advanced (collapsed by default, 9): `default-channel`, `image-kind`, `image-category`, `audio-kind`, `audio-category`, `video-kind`, `video-category`, `max-title-chars`, `max-full-chars`

**78. Right to be Forgotten** · package `ondra-forget-right` · enabled · 5 settings

Right to be Forgotten: when the user asks for something to be forgotten, it counts in one pass every place that must be cleared, eleven surfaces in all, covering body text in the memory core, pins in the forgetting audit, graph edges, vectors, todos and promises, time capsules, language-feel samples, diary entries, narrative logs, decision logs and snapshots. What can be deleted is deleted with a per-surface count, and what cannot be deleted is reported honestly with the best available count of what remains. It runs in two stages: planning is read-only and produces the list, while execution must carry an explicit confirmation token. If any surface fails or a surface that should have been cleared is skipped, completeness is false, because the right to be forgotten has exactly two outcomes, fully done and not done. It connects to no data table directly, deletes no file itself, never declares the result clean on its own, never clears the line pool automatically, which would also erase what other people said, and builds no interface.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, but plan and execute always throw disabled. |
| `scan-diary` | Switch | On | — | Whether the residual scan counts diary entries. When off, that line shows not counted rather than zero. |
| `scan-trace` | Switch | On | — | Whether the residual scan counts narrative log entries. When off, that line shows not counted rather than zero. |

Advanced (collapsed by default, 2): `clear-lexicon`, `verbose`
## 4. Highlights

All six can be reproduced and verified. Each gives the name, the value, the implementation, the difference from common approaches, and the evidence that supports it.

### Highlight 1: Discovery through service keys rather than code-level dependencies

- **Name**: the service-key discovery mechanism.
- **Value**: it solves the problem that change cost grows non-linearly with feature count. With 75 plugins in one codebase, mutual imports would mean any signature change in a shared module breaks compilation across the whole repository, and the regression surface could never converge.
- **Implementation**: there is not one cross-package import between plugins. Each plugin registers capabilities through `ctx.provide(key, implementation)` inside `apply(ctx, config)` and consumes upstream capabilities through `ctx.get(key)`. When the key is absent it neither throws nor waits; it skips that step and leaves one line in the log noting the missing upstream. Cordis handles service registration and dependency ordering, and a plugin does not know who consumes it.
- **Difference**: common plugin systems declare dependencies with interfaces or a registry, so a mismatch is caught at compile time at the cost of a full rebuild for any change. This approach defers coupling to runtime, trading zero compile-time impact for graceful degradation. That trade presupposes every plugin has a working degradation path, which makes degradation an admission condition rather than an optional optimisation.
- **Evidence**: `cordis-host/check-core.mjs` loads all 75 members one by one. Measured result: 75 of 75 succeeded, 0 skipped, in about 200 milliseconds. Zero skips is itself the proof that each plugin can stand up without its upstream — a plugin hard-depending on one would fail at load time when the service could not be obtained.

### Highlight 2: Memory writing matters more than retrieval, so writing has a deterministic gate

- **Name**: evidence gating on the write side.
- **Value**: it solves the problem of self-reinforcing hallucination contaminating the whole store. If the model records its own previous guess as a fact, the next turn reads that fact back and repeats it with more confidence, and no prompt can stop the process.
- **Implementation**: every conclusion awaiting storage must carry one of four provenance quotations — user wording, tool return, system action or character self-report — and the quotation is checked character by character against the original text. Numeric assertions require a tool source, and any attribution claim without user wording is refused. Verification runs as deterministic code, never as a model judgement.
- **Difference**: most memory designs put quality control on the retrieval side, filtering noise by relevance after retrieval. This design holds that contamination happens on the write side, and that no retrieval precision can do better than pick the most relevant entry out of a contaminated store. Gating the write side risks losing a memory, and that cost is accepted explicitly: better to record one fewer than to record one wrongly.
- **Evidence**: among the 13 settings of the evidence gate, both the requirement that digits carry a tool source and the minimum quotation length are configurable, defaulting to on and to four characters. The group-chat switch of the extension module is off by default, which makes excluding group chatter an admission red line rather than a performance trade-off.

### Highlight 3: Memory and storage are tiered, so a session survives a restart

- **Name**: three-tier storage degradation.
- **Value**: it solves the problem that an unopenable database makes the whole application unusable. SQLite depends on file-system permission, disk space and write-ahead locking, and it does fail in corporate environments and on faulty disks, and what a user needs most at that moment is at least to be able to talk.
- **Implementation**: the SQLite module is the primary store, creating tables in write-ahead mode with foreign keys enabled, strict table declarations and file permissions tightened to 0600 after writing. On failure it does not throw and abort; it registers its service in a degraded state, the in-memory module takes over and states explicitly that it does not persist, and the JSON module offers a third option in between.
- **Difference**: the common approach is that storage failure means startup failure, which is simple but stakes all availability on storage. This design makes degradation an explicit contract: it is not silent, the interface shows that the current mode is in-memory and will lose data on restart, and the user decides from that whether to fix the disk first.
- **Evidence**: the in-memory module's description states plainly that it keeps the main conversation going when SQLite cannot be opened and that it explicitly does not persist. All three storage plugins have zero configurable settings — degradation behaviour is not exposed, which prevents a user from switching off automatic degradation and ending up with a half-broken storage layer.

### Highlight 4: The six emotional states are decided by a single source of truth

- **Name**: the single source for emotional expression.
- **Value**: it solves the problem of two descriptions of emotion contradicting each other within one turn. Once emotion has to take effect simultaneously in the prompt, the speaking rate, the sticker choice and the rhythm, four separate sets of coefficients will inevitably drift.
- **Implementation**: the six-state expression module fixes emotion to six states — elated, soft, calm, wilted, bristling and sleepy — with names and count closed to additions or removals. One decision feeds the prompt, the rhythm and the speech layer, and the speaking-rate coefficients, the proactive quota adjustment, the read-aloud decision and the sticker probability each appear exactly once in the whole repository, here. This plugin emits parameters only and no text; projected text belongs solely to the projection module.
- **Difference**: common designs let each module read emotion and decide for itself how to express it, so changing one coefficient means changing four places. This design compresses how emotion affects expression into one parameter packet that other modules may read but not compute. The hormone dimension extension is off at the factory precisely because it overlaps with six-state expression, and enabling both would put two descriptions of the same mood in one turn.
- **Evidence**: six-state expression has 2 settings, the emotion core 4 and the conflict module 4 — the whole emotion engine of 7 plugins totals 25 settings, the smallest configuration surface of any top-level menu. A small surface is not a missing feature; it is freedom of choice deliberately concentrated in one source of truth.

### Highlight 5: Proactive behaviour is constrained by three gates

- **Name**: the three constraints on proactive behaviour.
- **Value**: it solves the problem of a companion turning into a source of nuisance. A program with proactive capability but no restraint mechanism feels thoughtful the first time, and by the third time the user switches it off and never opens it again.
- **Implementation**: the proactive gate with 21 settings decides whether to speak this turn, based on silence hours, idle duration and recent speaking frequency. The quota module with 9 settings decides how many more messages remain today, limited by both a daily budget and a delivery interval. The motivation module with 4 settings decides what to say and accepts only lines with a concrete reason — an unfinished todo, a promise made, a change in the environment — never a casual chat.
- **Difference**: most proactive features expose a single frequency parameter, so the user can only raise it globally or switch it off. This design splits whether, how much remains and what to say into three independent decisions, where failing any one keeps her silent, and each of the three has its own configurable threshold. A user can therefore lower the frequency while keeping genuinely motivated messages such as a reminder to take an umbrella because it is raining.
- **Evidence**: the three plugins total 34 settings, and the proactive gate is one of the single plugins with the most settings across both the extended and developer domains. The digital wellbeing guardrail adds 8 more, splitting continuous use and daily total into four tiers of normal, gentle reminder, clear discouragement and stop, and it never locks the screen, shows a dialog or interrupts at the factory default.

### Highlight 6: The way she speaks passes through a verifiable filter chain rather than a prompt constraint

- **Name**: the nine-step output filter chain.
- **Value**: it solves the problem of a model that talks like customer service. Tone can be imitated with a prompt, but repetition, narration, service register and over-explanation inevitably appear in long conversations, and a prompt can only lower the probability, never clear it.
- **Implementation**: the filter chain with 20 settings strips these after the model responds and before the reply enters the conversation. Repetition is detected by n-gram overlap, narration by action descriptions wrapped in brackets or asterisks, service register by a list of fixed phrases, and excessive length by a reply cap. Each step is an individually switchable toggle plus a threshold, not a wholesale rewrite of style.
- **Difference**: the common approach writes do not sound like customer service and do not preach into the system prompt, which is a probabilistic constraint that decays as context grows. This design puts the constraints after output, independent of the model and of context length, switchable off or tightened step by step.
- **Evidence**: the filter chain has the most settings in the speech-expression group at 20. The companion lexicon module with 10 settings computes the median sentence length, the no-punctuation rate and interjection frequency of the last 300 human messages and injects about 130 characters as its result, measuring without overriding the persona: the statistics describe how this person speaks, while the chain ensures she does not speak a certain way, and the two roles do not overlap.

---

## 5. Design Details and Small Decisions

This chapter records decisions that are not obvious. Each gives the concrete practice and the trade-off behind it.

### 5.1 Unusual input and boundary cases

**Quotations are compared character by character rather than by similarity.** The evidence gate does not use a similarity threshold to decide whether a quotation holds; it requires the quotation to appear verbatim in the original. Similarity would let a claim about the person being twenty-eight pass against an original saying thirty-eight, and numbers are precisely what must never be wrong.

**Over-long memories are truncated rather than rejected.** When a single memory body exceeds the cap of 200 characters by default, it is truncated with an issue recorded rather than rejected outright, for the reason written into the field description: rejection erases the memory completely, while truncation at least keeps the first half.

**A missing summary falls back to the body.** When the model returns no summary, the leading characters of the body serve as one, so the summary field is never empty, since an empty summary would show as a blank line in the list view.

**A missing upstream never throws.** Every service lookup is written to handle absence. When an upstream plugin is missing, the service still registers and is merely marked unavailable. This is what lets 75 plugins load in any order and makes debugging a single plugin possible.

**The meaning of an empty array is written out for each field rather than unified.** The repository holds 10 structured array fields and two kinds of emptiness: an empty `block-words` in `ondra-proactive-gate` blocks nothing extra, while an empty `hotlines` in `ondra-crisis` means not a single helpline is built in — numbers differ by region and change over time, so shipping a stale list would be worse than shipping none. Same shape, two meanings, so each field states its own case instead of leaving it to be guessed; unifying them under "empty means no limit" would turn the crisis entry into a false promise.

### 5.2 Timeouts, retries, degradation and fault tolerance

**Plugins that need an external backend ship switched off.** `ondra-vision` is the only plugin in the repository whose `enable` defaults to false: it reads the screen and sends the screenshot to an external vision model, and both halves happen off this machine. Shipping it off lets "installed and ready" and "no screen reading without consent" hold at the same time; the other 34 plugins in the same menu are on by default.

**Duplicate writes are judged by containment rather than by a time window.** When the same fact is recorded a second time, the memory dedupe module decides by the containment of the two bodies: below 0.4 they are two different things and a new entry is created; at 0.95 or above they are near-identical, and novelty decides restatement versus supplement (at most 0.25 bigram share and at most 2 new bigrams counts as a restatement); in between, a slot-coverage line of 0.45 decides whether it is the same sentence with a different value. A time window fails across days, across devices and when catching up on notes, while containment does not depend on a clock. The candidate pool holds the most recent 200 entries and a scan is capped at 300 rows, since pairwise comparison is O(n²) and anything larger stalls.

**Failures are attributed to eight classes, and argument errors are never retried automatically.** A failed tool call is not recorded vaguely as a failure but sorted into one of eight classes: tool missing, argument error, permission, timeout, network, not found, conflict or unknown. Each class has its own prescription, but the retry budget for argument errors is pinned to zero in the first line — retrying a wrong argument a hundred times gives the same result, and someone who does not know the password still cannot log in after a hundred attempts.

**A wound closes only on the next success.** Failure attribution opens a wound for each failing tool, and a wound closes only when that tool next succeeds, never on a timeout, because closing on time would make a permanently broken tool look healed. A wound still open after five minutes is marked chronic and retrying stops.

**Port conflicts yield automatically.** The port picker with 9 settings searches upward through a range when the preferred port is taken and reports the actual port back to the shell, so running two instances at once never leaves one failing silently.

### 5.3 Caching and performance

**Persona kernels are cached by persona version.** The kernel cache is on by default and its key includes the persona version, so swapping the persona pack invalidates it. Turning it off is useful only when editing a persona pack while debugging; in daily use there is no reason to recompute.

**Zero residence: resident content is replaced with pointers.** The zero-residence module with 7 settings keeps deterministic pointers rather than full content in context, and every replaced byte can be restored verbatim from the session log. This addresses context being crowded out by history in long conversations, since resident content costs tokens that must be paid every turn.

**Injection dedupe: one large block first, then deltas only.** The dedupe module with 7 settings injects one large block on the first round, then only deltas, maintaining a ledger of seen entry ids. When a context-compression signal appears it releases the ledger and injects the full block again, so compression does not take key information with it.

**Tool schema gating.** The tool gate with 9 settings decides by deterministic rules which tools to expose this turn rather than putting every tool definition into the prompt at once. Tool definitions are the largest single consumer of context, and after gating only the subset the current intent might need is exposed.

**Plugins load serially, never concurrently.** The 75 plugins are awaited one by one; measured at about 200 ms. Concurrent loading would let a dependent initialise before its dependency has registered its service, producing races that are hard to reproduce. Trading roughly 200 ms for the elimination of a whole class of intermittent failures is worthwhile.

### 5.4 Concurrency and data consistency

**Organ state accumulates and then applies once.** The organ host's flush accumulates the turn's state proposals per target, writes them once and clamps the result into the legal range. Writing each proposal separately would make the final value depend on plugin registration order, so the same organ would end up with different state depending on when it registered.

**There is exactly one concurrency cap, set for the scarcest resource.** Only `ondra-memory-intake` exposes `maxConcurrent`, defaulting to one: memory extraction needs a single model call per turn, and raising it only queues more requests against the model gateway. No other plugin opens its own concurrency knob, because stacked knobs turn "why is it slow" into an arithmetic problem.

**Memory writes complete inside one transaction.** The memory core writes the raw text and the extracted result in the same transaction, avoiding the intermediate state where the raw text landed but no facts were extracted, or where facts were extracted but the raw text was lost.

### 5.5 Memory and storage optimisation

**Data directory permissions are tightened at creation.** The path layout module is the single entry point for resolving the data root and creating directories, setting the five area directories to 0700 and files to 0600 in one pass. Permissions are set at creation rather than repaired afterwards, which avoids a window in which anyone could read them.

**Logs rotate at 4 MB across three files, with duplicate errors deduplicated.** The Chinese log module writes two layers: sentences for people and code logs for developers go to separate places. Rotation caps at 4 MB across three files, and when the same error recurs within a short time only the first occurrence is written in full while later ones add to a counter, which keeps a persistently failing plugin from filling the disk.

**Empty state files use the built-in default.** All 20 state-file settings default to empty, and an empty value uses the built-in path. These fields do not appear in the interface, because their purpose is putting state somewhere else and almost nobody needs to put state somewhere else.

**Dependencies do not duplicate project space.** pnpm's content-addressed store keeps the real files of every package in a global store, and `node_modules` inside the project holds only symbolic links. Measured, all 6131 files inside the project have a hard link count of one, and both logical size and disk usage are zero bytes.

### 5.6 Security and anti-attack measures

**The pipe is the authentication.** Shell to host and host to kernel communicate over standard input and output without touching the network. The operating system guarantees that only the parent can read and write a child's pipe, so this channel needs no additional authentication layer.

**The HTTP service listens on the loopback address only.** The host's local HTTP service binds `127.0.0.1` and never `0.0.0.0`, so no other device on the local network can connect.

**The token is generated at startup and never written to disk.** A 32-byte random token is generated by the shell when it starts the host and passes it in memory only, every request is checked for a Bearer token, and requests without one are refused before the body is parsed. Responses all carry `cache-control: no-store`.

**The browser guardrail refuses internal targets.** The browser module with 10 settings blocks tools that execute arbitrary code in a page and refuses the `file:`, `javascript:` and `data:` schemes along with private targets such as `127.0.0.1`, `localhost` and `*.local`. These are the entry forms of server-side request forgery.

**Tool results are truncated by budget with the numbers stated.** A browser snapshot can return hundreds of kilobytes, so the guardrail trims the tail against a double budget of 4000 characters and 80 lines and writes at the start of the result how large the original was and that the rest is not expanded. Truncation is never silent, so the user knows something was omitted.

**The egress gate reminds rather than proxies.** The privacy module with 6 settings provides compliance notice and three-tier risk reminders; it does neither encryption nor proxying. Becoming a proxy would force data through the plugin, putting credential values into plugin memory, which would turn a privacy feature into a new privacy risk.

**Capability permissions deny by default.** The organ host's capability allow list denies by default: calling an undeclared capability raises an error rather than being silently ignored, because silently ignoring would make a plugin author believe the capability took effect.

### 5.7 Small user-experience decisions

**The permission tier sits at the lower left of the input box.** Permission state is the setting in this product that most needs to be seen, since it decides whether this conversation's data leaves the machine. Moving it from the settings page to beside the input box means the user sees the current tier with every message sent, rather than remembering to check afterwards.

**Unavailable voice input gives a clear message.** Voice input uses the Web Speech API, which is unavailable in most desktop web views. When unavailable the button says the current environment does not support voice input rather than failing silently, since silent failure would make users tap repeatedly and suspect the microphone.

**Window size is forced back on every start.** The main window's default and minimum size are both 820 by 580, and every start returns to it regardless of how large it was dragged. Reading width in a conversation interface has an optimal range, and a single line becomes hard to read when the window is stretched to 2000 pixels.

**Settings are presented in two tiers.** Of the 619 fields, 276 appear directly in the interface and 343 are folded into the advanced layer. A single plugin holds at most 30 fields (`ondra-memory-dream`), and flattening all of them would turn the settings page into an unnavigable table. Folding removes no functionality; it moves the rarely changed into a second layer.

**Almost every setting carries an explanation.** All 619 fields carry a non-empty `doc` (100%), averaging 36 characters and running up to 115. The fallback policy still stands: where a `doc` is missing the interface shows the field key instead of inventing a description. The descriptions come from the field declarations in the compiled output and share their source with the code, so the documentation cannot drift into saying on by default while the code says off.

**Disabled plugins are shown too.** The single plugin that ships switched off (`ondra-vision`) appears in the plugin list with a grey dot rather than being hidden. A grey dot means installed but not switched on, which is a different thing from not installed, and hiding them would make users believe those capabilities do not exist.

### 5.8 Why certain defaults were chosen

**The relationship defaults to friend.** Among the five relationships of girlfriend, sister, daughter, friend and assistant, friend is the only one that presumes no intimacy. The product does not decide for the user what she is to them, so the most neutral option is the default.

**Speaking intensity defaults to 50.** The intensity slider runs from 0 to 100, where 50 is the persona pack's original wording. The default is not a compromise but a way of leaving the author's original expression untouched; moving toward either end is the user's own choice.

**The persona assembly budget defaults to 12000 characters.** A complete persona load measures 7,725 characters for the factory persona (Oh Jingjing) up to 10,057 for the sample persona (Xia Ningqi), plus about 20% headroom for fragments and relation tuning. The number is not a round "big enough" figure: the previous default of 2600 dropped the entire "voice" slot (2169 characters) out of the prompt — she knew who she was but could not read how she speaks, and none of the three assembly code paths reported anything wrong. The factory model profile declares a context window of 1,000,000, so 2600 was never a number forced by capability.

**The cost of leaving two strict checks off is stated explicitly.** The two options for exact optional properties and unchecked indexed access do not apply to the 75 migrated plugins, though they are on everywhere else. The cost is that those plugins carry lower type precision than the rest of the repository, which is the price of migrating existing assets rather than an oversight.

**The factory persona is 鲸鲸 and 夏柠柒 is the example pack.** Separating the two means that swapping the persona is a first-class operation from the first launch, rather than a hidden feature.

**Plugins load serially rather than concurrently.** As described in 5.3, about 200 ms buys the elimination of a whole class of races.

**The emotion hormone dimension ships disabled.** It overlaps with six-state expression, and enabling both would put two descriptions of emotion in one turn. It is off not because it is poor but because two mechanisms describing the same thing should not be active at once.

### 5.9 Compatibility with older versions and across platforms

**The old assembly declarations are kept for comparison.** 74 copies of `cordis.patch.yml` remain in the plugin directories but are no longer read, since assembly semantics have been transcribed into an explicit array in `ondra-core`. Keeping the old files supports comparison: when something goes wrong, one can check where the old patch said a plugin should be against where the new array puts it. That is one fewer than the member count because `ondra-memory-intake` was written against the explicit array from the start and never generated a patch file.

**The private scope is redirected through a dependency alias.** Historically the first-party plugins declared the framework as `@ntars/cordis`, a scope that was never published to public npm. This project overrides that name in `pnpm-workspace.yaml` to point at the official `cordis@4.0.0-rc.12`. This is a redirect at dependency-resolution level; it modifies no Cordis source and changes no licence.

**Time is accepted only as an instant from outside.** The study companion installs no timer and infers no elapsed time from file timestamps; it accepts only an instant passed in. A gap between two marks exceeding fifteen minutes is judged an interruption and contributes not a single second, because a resident timer keeps running while nobody watches and would produce the report of eight hours studied after the window was closed for eight hours.

**Daily totals reset across midnight but the fact of having started is kept.** The study companion's daily total resets when the day changes but keeps the marker that a session was once started. Clearing it would make the first read the next day report that nothing had ever started, which is false comfort to someone who studied two hours yesterday.

**Interface differences between Windows and macOS are recorded rather than hidden.** The Windows installer window size cannot be set directly in configuration and needs a custom template. The default is kept so that Windows packaging works, and the difference is written into the known limitations rather than concealed.

---
---

## 6. Technology Stack and Dependencies

### 6.1 Runtime dependencies

Shipped with the application and part of the final installation package.

| Name | Version | License | Purpose in this project |
| --- | --- | --- | --- |
| [Tauri](https://github.com/tauri-apps/tauri) | 2.12.5 | Apache-2.0 / MIT | Desktop shell framework: window, web-view injection, IPC command channel, packaging for dmg, app and nsis |
| [tauri-plugin-opener](https://github.com/tauri-apps/plugins-workspace) | 2.7.2 | Apache-2.0 / MIT | Opens external links in the system default browser, handling per-platform differences and permission checks |
| [tokio](https://github.com/tokio-rs/tokio) | 1.54.1 | MIT | Rust async runtime: starting the host process, reading standard streams, timeout control, waiting for exit |
| [serde](https://github.com/serde-rs/serde) | 1.0.229 | Apache-2.0 / MIT | Serialisation and deserialisation of messages between shell and host |
| [serde_json](https://github.com/serde-rs/serde) | 1.0.154 | Apache-2.0 / MIT | JSON data format support |
| [Cordis](https://github.com/cordiverse/cordis) | 4.0.0-rc.12 | MIT | Host-side plugin framework: context, service registration and injection, plugin lifecycle and dependency ordering |
| [React](https://github.com/facebook/react) | 19.3.1 | MIT | Interface rendering layer, depending on no UI component library |
| [React DOM](https://github.com/facebook/react) | 19.3.1 | MIT | The browser rendering implementation of React |
| [morphicons](https://github.com/guillermolg00/morphicons) | 2.0.2 | MIT | Morphing icon component used in the interface |
| [lucide](https://github.com/lucide-icons/lucide) | 1.68.0 | ISC | Interface icon data. A uniform 24×24 grid with 1.5 stroke and rounded caps, wrapped semantically by `src/components/icons.ts` |

### 6.2 Development dependencies

Used only during development and build, and absent from the final artifact.

| Name | Version | License | Purpose |
| --- | --- | --- | --- |
| [TypeScript](https://github.com/microsoft/TypeScript) | 7.0.2 | Apache-2.0 | Type checking of all TypeScript code and compilation to ES modules |
| [Vite](https://github.com/vitejs/vite) | 8.3.6 | MIT | Front-end development server and production build |
| [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react) | 6.2.1 | MIT | Provides the JSX transform and hot reload for React inside Vite |
| [@tauri-apps/cli](https://github.com/tauri-apps/tauri) | 2.12.4 | Apache-2.0 / MIT | Command-line entry for the dev and build commands |
| [tauri-build](https://github.com/tauri-apps/tauri) | 2.7.4 | Apache-2.0 / MIT | Build script: generates the Tauri context code, permission schema and packaging metadata |
| [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped) | 26.6.6 | MIT | Type definitions for Node.js built-in modules |
| [@types/react](https://github.com/DefinitelyTyped/DefinitelyTyped) | 19.3.0 | MIT | Type definitions for React |
| [@types/react-dom](https://github.com/DefinitelyTyped/DefinitelyTyped) | 19.3.0 | MIT | Type definitions for React DOM |

### 6.3 Dependency scale

| Dependency tree | Packages | Source |
| --- | --- | --- |
| Rust crates including transitive dependencies | 442 | `src-tauri/Cargo.lock` |
| npm packages including transitive dependencies | 87 | `pnpm-lock.yaml` |

These numbers come from parsing the lockfiles and are not estimates. The name, version, copyright holder, licence, official address, purpose in this project and modification status of all 529 third-party components are listed item by item in [NOTICE](./NOTICE). That file must be updated whenever dependencies are changed.

**Licence compatibility.** This project uses AGPL-3.0. None of the 529 third-party components carries a licence that conflicts with it.

| Licence type | Components | Note |
| --- | --- | --- |
| MIT / Apache-2.0 and combinations of the two | 448 | The large majority; permissive and fully compatible with AGPL-3.0 |
| Zlib, including multi-choice combinations | 22 | Permissive, at the same level as MIT |
| Unicode-3.0 | 19 | Unicode data tables; permissive |
| MPL-2.0 | 17 | Weak copyleft, see below |
| BSD-3-Clause | 10 | Permissive |
| Unlicense / 0BSD / CC0-1.0 / MIT-0 | 8 | Public-domain equivalents, the most permissive class |
| ISC | 3 | Permissive |
| LGPL-2.1-or-later, as one option among several | 2 | `r-efi` also offers MIT and Apache-2.0; this project uses it under a permissive option |
| **Total** | **529** | |

Seventeen components are MPL-2.0: five on the Rust side (`cssparser`, `cssparser-macros`, `dtoa-short`, `option-ext`, `selectors`) and twelve on the npm side (`lightningcss` plus its eleven platform-specific binary packages). All seventeen enter as unmodified published releases, and no source of any of them has been changed in this project, so no derivative-work obligation arises under section 3 of MPL-2.0 and there is no obligation to publish source. If any of them ever needs to be modified, the modified files must be published under MPL-2.0.

`r-efi` declares its licence as MIT OR Apache-2.0 OR LGPL-2.1-or-later, meaning any one of the three. This project takes it under a permissive option and does not engage the LGPL terms.

**No dependency has been modified.** Every third-party component is taken from an unmodified release. There is no `vendor/` directory in the project and no `[patch]` section in `Cargo.toml`.

---

## 7. Installation and Deployment

### 7.1 Requirements

| Item | Requirement | Notes |
| --- | --- | --- |
| Node.js | 22 or later | Host and kernel both run on Node 22; the engines field in the package manifest declares it |
| pnpm | 11.28.5 | Pinned by the package manager field; another version may produce lockfile differences |
| Rust | 1.85 or later | Needed only to build the shell; development mode runs without it |
| System | macOS 11+, Windows 10+ | The Linux system integration has not been adapted |

### 7.2 Installing the Rust toolchain

Run this only when building the desktop installation package.

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
```

### 7.3 Getting the source and installing dependencies

```bash
git clone https://github.com/ntars/Ondra.git
cd Ondra
pnpm install
```

`pnpm install` creates workspace links for the 78 packages under `cordis-host/plugins/`. The first run takes a while; later incremental installs are fast.

### 7.4 Building

```bash
# Build front end, host, kernel and the dsh kernel in order
pnpm run build

# Build the desktop installation package (requires the Rust toolchain)
pnpm run build:app

# Build and move the package into releases/ at the repository root
pnpm run release
```

`pnpm run release` runs `build:app`, which is the Tauri build and already includes the full build pipeline, then moves the artifacts from `src-tauri/target/release/bundle/` into `releases/` at the repository root, keeping the `dmg/`, `macos/` and `nsis/` subdirectory structure. `releases/` is in `.gitignore` and never enters the repository.

**A fresh clone must be built before `check:core`, `smoke` or development mode will run.** The repository does not store TypeScript compilation output: the `lib/` directory of each of the 78 plugin packages, the host and the kernel is generated by `tsc -b` from the corresponding `src/` (2201 files, about 16 MB in total) and is excluded by `.gitignore`. Each package's `package.json` points `main` at `lib/index.js`, and `cordis-host/check-core.mjs` imports `./plugins/ondra-core/lib/index.js` directly. A fresh clone therefore has no `lib/`, and skipping `pnpm run build` produces a "Cannot find module" error.

`pnpm run build` runs `build:web` → `build:plugins` → `build:host` → `build:sidecar` in that order. Plugins build before the host precisely so that the host can resolve each plugin's `lib/` when it compiles.

Tauri cannot be told to output into `releases/` directly because the bundle location is determined by Cargo's target directory and cannot be changed in configuration, so one copy step concentrates the artifacts.

**Build-time caveat.** In an environment with a safe-delete shim enabled, the temporary-file cleanup at the end of pnpm may be judged a bulk deletion and interrupt the build. Setting `CODEBUDDY_SAFE_DELETE_ENABLED=0` for that run bypasses it. The variable affects build-time cleanup only, never the artifacts.

### 7.5 Website deployment

The website is deployed automatically by EdgeOne, configured in `edgeone.json`:

```bash
node tools/build-site.mjs
```

Output goes to `.site-dist/` and contains only `index.html`, `icon.svg`, `favicon.ico` and `assets/`. The build script strips three kinds of macOS metadata files and skips empty source directories, so the output never contains empty directory shells.

---

## 8. Quick Start

### 8.1 Development mode

Start the three processes separately for easier debugging:

```bash
# Terminal 1: front end with hot reload
pnpm run dev:web

# Terminal 2: host, which starts the kernel automatically
pnpm run dev:host

# Terminal 3: shell, which loads the front end and manages the host
pnpm run tauri dev
```

### 8.2 Smoke test

Verifies that the three-layer chain is connected:

```bash
pnpm run smoke
```

Expected output:

```
Host ready: http://127.0.0.1:64158
  PASS  health check
  PASS  request without token returns 401
  PASS  create session
  PASS  session list contains the new session
  PASS  model list readable
  PASS  tool list readable
  PASS  unknown route returns 404
```

### 8.3 Checking plugin assembly

Verifies plugin loading on its own, without the HTTP service:

```bash
pnpm run check:core
```

Expected output:

```
=== Core assembly result ===
Declared members: 75
Enabled list:     75
Loaded:           75
Skipped:          0
Elapsed:          200 ms
```

When anything is skipped, the reason is printed for each and the process exits with a non-zero code, so it can serve directly as a continuous-integration gate.

### 8.4 Running the kernel alone

The kernel can be verified without the host:

```bash
cd dsh-sidecar
node lib/index.js
```

Then feed JSON-RPC requests line by line on standard input:

```json
{"jsonrpc":"2.0","id":1,"method":"kernel.handshake","params":{"protocolVersion":"1.0","client":"host","clientVersion":"2.1.2"}}
{"jsonrpc":"2.0","id":2,"method":"kernel.ping"}
{"jsonrpc":"2.0","id":3,"method":"session.create","params":{"title":"test"}}
```

### 8.5 Adding a plugin

`tools/prepare-plugins.mjs` generates the shared package manifest and TypeScript configuration for plugins. The script is idempotent and produces the same result on repeated runs:

```bash
pnpm run prepare:plugins                 # process every plugin
pnpm run prepare:plugins -- ondra-clock  # process one plugin only
```

The complete manual steps for adding a plugin:

1. Create a directory under `cordis-host/plugins/`, add `src/index.ts` and export `name` and `apply`.
2. Run `pnpm run prepare:plugins -- <plugin-name>` to generate the build configuration.
3. Add one import and one member entry in `cordis-host/plugins/ondra-core/src/index.ts`, and increment the migrated plugin count.
4. Run `pnpm install` so pnpm links the new package and its dependencies.
5. Run `pnpm run check:core` and confirm the loaded count increased with no skips.

Step 3 cannot be skipped. `ondra-core` declares every plugin as a dependency, so omitting it makes TypeScript report a missing module instead of failing at runtime.

---

## 9. Configuration

Settings come in three layers: environment variables control how processes start, workspace configuration controls how dependencies resolve, and plugin declarations control how each feature behaves. The third layer corresponds to the 619 fields listed one by one in chapter 3.

### 9.1 Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `ONDRA_HOST_ENTRY` | Absolute path to the host entry script | `cordis-host/lib/index.js` |
| `ONDRA_NODE` | Path to the Node executable | Detected automatically |
| `ONDRA_SIDECAR_ENTRY` | Absolute path to the kernel entry script | `dsh-sidecar/lib/index.js` |
| `CODEBUDDY_SAFE_DELETE_ENABLED` | Build-time safe-delete shim switch | Unset, which means enabled |

### 9.2 Workspace configuration

Key settings in `pnpm-workspace.yaml`:

- **`packages`**: `src`, `cordis-host`, `cordis-host/plugins/*` including all 78 packages, and `dsh-sidecar` are workspace members. `src-tauri` is managed by Cargo and stays outside the pnpm workspace.
- **`overrides`**: the private framework scope is aliased to the official Cordis package version. The older plugins all declare a peer dependency on the private scope, which was never published to the public registry, and the official package is its only upstream implementation.

### 9.3 Where dependencies live

pnpm produces two layers of `node_modules`, and understanding this explains why dependencies appear to be inside the project without occupying project space:

| Layer | Location | Contents | Occupies project size |
| --- | --- | --- | --- |
| Content-addressed store | `~/Library/pnpm/store/` | The real files of every package, shared globally | No |
| Virtual store | `<project>/node_modules/.pnpm/` | Symbolic links into that store | No |

The real files live in the system-level store and the project holds only links. In this repository `node_modules` reports 89 MB to `du`, mostly the macOS native binary of the Tauri command-line tool at about 14 MB per file, which is a development-time tool and never enters the final package.

Measured data: all 6131 files under `node_modules` have a hard link count of one, and both logical size and disk usage are zero bytes, which shows their content is shared with the store rather than duplicated in the project.

Why `node_modules` cannot be moved out of the project entirely: Node resolves modules by walking up from the script's directory looking for `node_modules`, which is a runtime convention rather than a pnpm choice. Moving it would require `NODE_PATH` or a loader hook and would distort IDE navigation, debugger breakpoints and TypeScript module resolution all at once.

Output directories are likewise excluded from the repository: `node_modules/`, `dist/`, `target/`, `.site-dist/`, `src-tauri/target/` and `releases/` are all in `.gitignore`.

### 9.4 Shell configuration

Key entries in `src-tauri/tauri.conf.json`:

- **`app.windows`**: the width and height of the main window together with its minimum width and height are all 820 by 580. Apart from the Windows installer, every interface uses this size, and it is also the minimum.
- **Forced size at startup**: the setup hook in `src-tauri/src/main.rs` calls `set_size(820, 580)` and `set_min_size(820, 580)` on the main window again, which guarantees the window returns to this size on every start no matter how large it was dragged.
- **`build.frontendDist`**: `../dist`, matching Vite's output directory.
- **`app.security.csp`**: `default-src 'self'`, with `connect-src` allowing only HTTP and WebSocket on `127.0.0.1`.
- **`bundle.resources`**: packs `cordis-host/lib` and `dsh-sidecar/lib` into the installation package.
- **Windows installer size of 410 by 290**: macOS needs no installer window, since the disk image is provided by the system. The NSIS installer's default window size cannot be set to an arbitrary pixel size in configuration; reaching exactly 410 by 290 needs a custom NSIS template and a pointer to it in the bundle configuration. The approach is to run a Windows build once, take the complete generated script from the NSIS bundle output, adapt the dialog sizes, and feed it back into configuration. The default NSIS template is kept for now so that Windows packaging works, and the exact size awaits verification on a Windows build.

### 9.5 Capability permissions

`src-tauri/capabilities/default.json` opens only the minimum necessary permissions for the main window: the core defaults and opening external links restricted to HTTP and HTTPS. The front end never holds a native capability directly; choosing files and opening links always go through the host.

---
---

## 10. API and Module Reference

### 10.1 Local HTTP interface

Every request must carry `Authorization: Bearer <token>`. Unauthorised requests are refused before the body is parsed.

| Method | Path | Description | Response |
| --- | --- | --- | --- |
| GET | `/api/health` | Health check | `{ ok, at }` |
| GET | `/api/sessions` | Session list | `SessionMeta[]` |
| POST | `/api/sessions` | Create a session | `SessionMeta`, status 201 |
| GET | `/api/sessions/:id` | Session detail | `SessionMeta` |
| GET | `/api/models` | Available models | `ModelDescriptor[]` |
| GET | `/api/tools` | Registered tools | `ToolDescriptor[]` |
| POST | `/api/proactive/check` | Decide whether she may speak up right now (the nine gates live in the host) | `ProactiveVerdict` |
| POST | `/api/proactive/decline` | The user dismissed this one with "not now"; the host records a decline | `{ ok }` |

### 10.2 Kernel protocol methods

The kernel's 18 methods are called over JSON-RPC 2.0 framed as newline-delimited JSON. Error codes follow the JSON-RPC 2.0 range from -32700 to -32603, and this project defines kernel-specific codes from -32000 to -32004.

| Domain | Method | Parameters | Description |
| --- | --- | --- | --- |
| Lifecycle | `kernel.handshake` | `protocolVersion`, `client`, `clientVersion` | Version negotiation, returns the capability list |
| | `kernel.ping` | None | Liveness probe |
| | `kernel.shutdown` | None | Graceful shutdown |
| Session | `session.create` | `title` | Creates a session |
| | `session.get` | `id` | Reads session metadata |
| | `session.list` | `includeArchived` | Lists sessions |
| | `session.archive` | `id` | Archives a session, idempotent |
| Inference | `inference.run` | `sessionId`, `input` (optional), `nudge` (optional) | Runs one turn, streaming deltas. Omitting `input` means she speaks up on her own; `nudge` is a transient system hint that is never persisted |
| | `inference.abort` | `sessionId` | Aborts the current turn, idempotent |
| Tools | `tool.list` | None | Lists registered tools |
| | `tool.invoke` | `name`, `arguments` | Invokes one tool, validating arguments first |
| Models | `model.list` | None | Lists available models |
| | `model.select` | `id` | Switches the current model |

### 10.3 Module responsibilities

| Path | Responsibility |
| --- | --- |
| `dsh-sidecar/src/protocol.ts` | The single source for the protocol: method names, event names, error codes, type guards |
| `dsh-sidecar/src/rpc/transport.ts` | Newline-delimited JSON framing, splitting messages by line |
| `dsh-sidecar/src/rpc/dispatcher.ts` | Request dispatch, error translation, event push |
| `dsh-sidecar/src/kernel/types.ts` | Shared types for the four responsibilities |
| `dsh-sidecar/src/kernel/sessions.ts` | Session storage |
| `dsh-sidecar/src/kernel/models.ts` | Model adapters |
| `dsh-sidecar/src/kernel/tools.ts` | Tool registration and argument validation |
| `dsh-sidecar/src/kernel/index.ts` | Wires the four responsibilities to protocol methods |
| `cordis-host/index.ts` | Host entry: assembles plugins, starts the service, reports ready |
| `cordis-host/check-core.mjs` | Core assembly check, verifying each member load |
| `cordis-host/src/server.ts` | Local HTTP service and token authentication |
| `cordis-host/plugins/ondra-core/src/index.ts` | The member list of the core: 75 imports and one member array |
| `cordis-host/plugins/ondra-core/src/types.ts` | The assembly contract |
| `cordis-host/plugins/dsh-client/` | Kernel subprocess lifecycle and request pairing |
| `cordis-host/plugins/desktop-bridge/` | Desktop capability bridge |
| `cordis-host/plugins/ondra-*/` | 78 packages (75 loadable plugins plus the manifest and two bridges), each its own package |
| `tools/prepare-plugins.mjs` | Generates the shared build configuration for migrated plugins |
| `tools/build-site.mjs` | Collects website static files and strips macOS metadata |
| `tools/version.mjs` | Keeps the version in seven places; on `--minor` commits the version files, tags and pushes |
| `tools/smoke.mjs` | Three-layer smoke test |
| `tools/check-ui.mjs` | UI spec assertions: dimensions, layering, token definitions, the close dialog and the error tiers |
| `tools/check-installer.mjs` | Windows installer script syntax: renders the placeholders, then compiles once with makensis |
| `tools/build-tray-icons.mjs` | Renders the tray silhouette at three sizes (16 / 32 / 64) from `icon.svg`: no plate, alpha preserved |
| `src-tauri/src/main.rs` | Shell entry: window, events, cleanup on exit |
| `src-tauri/src/host.rs` | Host process management: start, wait, stop |
| `src-tauri/src/commands.rs` | Native capability commands |
| `src-tauri/src/tray.rs` | Tray icon and menu: open, today, mute (label switches between "Mute 1 hour" and "Unmute" with state), quit |
| `src-tauri/src/window.rs` | Close interception: hide to tray or quit, preference persisted, falls back to minimise when no tray exists |
| `src-tauri/src/browser.rs` | Built-in read-only browser: site, repository, changelog and licence open in-window, never leaving the app |
| `src-tauri/installer/installer.nsi` | Windows installer script: three pages, 410 × 290, DPI aware |
| `src/lib/host.ts` | The single entry for front-end to host communication |
| `src/lib/shell.ts` | Thin wrapper for front-end to shell communication |
| `src/lib/api.ts` | Business interface wrappers |

### 10.4 The configuration declaration convention

Each plugin declares its configuration in its own `src/settings.ts`, and that declaration is the single source of truth from which both interface and documentation read. The shape is an object whose keys are setting keys and whose values carry the following members:

| Member | Type | Purpose |
| --- | --- | --- |
| `kind` | `boolean` / `number` / `string` / `json` / `enum` | The data type, which decides the interface control |
| `default` | Matching `kind` | The factory value, which the restore-defaults action uses |
| `values` or `options` | String array | Enumerated choices; the two spellings are equivalent and only one is used per field |
| `min` / `max` | Number | Bounds for numeric fields, used to limit the slider range |
| `advancedOnly` | Boolean | Whether the field folds into the advanced layer |
| `secret` | Boolean | Whether the value is sensitive and shown masked in the interface |
| `doc` | String | User-facing explanation, rendered beside the field |

Because `doc` shares its source with the code, documentation cannot drift from actual behaviour. All 619 fields in this project carry a `doc`, averaging 36 characters.

---

## 11. Repository Layout

```
Ondra/
├── README.md                     Chinese main document
├── README_EN.md                  Full English version
├── NOTICE                        Third-party dependency and licence statement
├── LICENSE                       Full AGPL-3.0 text
├── package.json                  Repository metadata and scripts
├── pnpm-workspace.yaml           Workspace members and dependency overrides
├── tsconfig.base.json            Shared TypeScript configuration
├── edgeone.json                  EdgeOne deployment configuration
├── index.html                    Website home page
├── icon.svg                      Single source for the application icon
├── favicon.ico                   Site icon
├── assets/                       Brand image assets
├── .github/workflows/            CI: release.yml builds both platforms and publishes a pre-release
├── tools/
│   ├── build-site.mjs            Website static file collection
│   ├── prepare-plugins.mjs       Generates shared build configuration for migrated plugins
│   ├── collect-runtime.mjs       Collects runtime files
│   ├── bundle-release.mjs        Moves installation packages into releases/
│   ├── version.mjs               Keeps the version in seven places, commits and tags on --minor
│   └── smoke.mjs                 Three-layer smoke test
├── src/                          Front-end UI (React 19 + Vite 8)
│   ├── index.html                Single entry, one tree only
│   ├── main.tsx                  Applies the global prerequisites, then mounts App; no router
│   ├── App.tsx                   Main window root: wires the interface regions and global shortcuts
│   ├── components/               Interface components
│   │   ├── TitleBar.tsx          Custom title bar: persona avatar and switcher, three-state presence, window buttons
│   │   ├── Avatar.tsx            Avatar: draws the same geometry as icon.svg; custom images centre-cropped to 96
│   │   ├── TopBar.tsx            Phone top bar: hamburger opens the drawer, title, mood dot, 2px water line
│   │   ├── Rail.tsx              Leftmost icon rail: session / log / extension entries plus the gear at the bottom
│   │   ├── Spine.tsx             Right spine: a 6 × 150 level gauge plus three readings, height is energy and colour is mood
│   │   ├── Inspector.tsx         Profile inspector: right now, how she sees you, what she remembers, what she is doing
│   │   ├── Drawer.tsx            Drawer container shared by session / log / extension, swapping content in place
│   │   ├── SessionStats.tsx      Session drawer: rounds / characters / started at / archived segments, plus "clear all"
│   │   ├── LogDrawer.tsx         Log drawer: session log / channel log / system log
│   │   ├── ExtensionDrawer.tsx   Extension drawer: three-section package list (bridge / kernel / packs) and config entries
│   │   ├── Timeline.tsx          Conversation reading flow: messages, quotes, copy
│   │   ├── RichText.tsx          Message body typesetting: headings, lists, tables, code, quotes, never touching innerHTML
│   │   ├── Composer.tsx          Input box: attachments, drag and drop, send mode
│   │   ├── Settings.tsx          Settings shell: left nav plus one content pane, one entry, one panel
│   │   ├── SettingsGeneral.tsx   General page: theme, font size, language, send mode, system notifications, default permission, sounds, voice input
│   │   ├── SettingsProviders.tsx Models & API page: preset-source notes and custom OpenAI-compatible endpoints
│   │   ├── SettingsPersona.tsx   Persona page: voice, tone, pace, rules, knowledge base
│   │   ├── SettingsData.tsx      Backup & restore page: session export and import
│   │   ├── SettingsBackup.tsx    Backup & restore page: full-store snapshots and rollback
│   │   ├── SettingsPlugins.tsx   Extensions page: scene / module / raw plugin parameters
│   │   ├── SceneLayer.tsx        First layer: fill parameters by scene, preview the writes
│   │   ├── ModuleLayer.tsx       Second layer: field forms grouped by module
│   │   ├── RawLayer.tsx          Third layer: flat key-value table, fully searchable
│   │   ├── SettingsAbout.tsx     About page: version, updates
│   │   ├── SettingsPrivacy.tsx   About page: data location, network scope, offline capability
│   │   ├── SettingsPermissions.tsx About page: app permissions
│   │   ├── settingsUi.tsx        Settings form primitives: choice cards, switches, rows, notes
│   │   ├── Dialog.tsx            Confirmation dialog with focus trapping and restore
│   │   ├── Toast.tsx             Toasts in three tiers: success, warning, error
│   │   ├── ScrollArea.tsx        Custom scroll container with a consistent overlay scrollbar
│   │   ├── Icon.tsx              The only icon exit (morphicons); components refer to icons by name
│   │   ├── icons.ts              Named icon re-exports, tree-shakeable; rendering still goes through Icon.tsx
│   │   └── Mark.tsx              Brand mark component, geometry taken from brand/mark.ts
│   ├── lib/
│   │   ├── api.ts                Business interfaces and shared types
│   │   ├── host.ts               The single entry for front-end to host communication
│   │   ├── shell.ts              Thin wrapper for front-end to shell communication
│   │   ├── useAppState.ts        Main window state
│   │   ├── persona.ts            Persona constants and the three presence labels
│   │   ├── usePersona.ts         Persona singleton: list, active pack, hot swap, presence rules
│   │   ├── preferences.ts        Single source for preferences: load, apply, broadcast across windows
│   │   ├── mute.ts               One-hour mute: deadline, self-expiry, tray label sync
│   │   ├── sound.ts              Cues: three synthesized tones, own volume, honours mute
│   │   ├── absence.ts            Time away: 10-minute threshold, human wording, one line on return
│   │   ├── paste.ts              Paste: images become attachments, 48px thumbs, one length limit
│   │   ├── richText.ts           Body parser: Markdown into structures, link allowlist, depth limits
│   │   ├── settings.ts           Settings read and write
│   │   ├── settingTypes.ts       Types for settings fields and sections
│   │   ├── scenes.ts             Scene definitions and write derivation
│   │   ├── shortcuts.ts          Shortcut table and key context checks
│   │   ├── platform.ts           Single source of platform truth: writes data-platform / data-input, includes the linux branch
│   │   ├── types.ts              Memory, bond and mood domain types
│   │   ├── moodColor.ts          Water colour, mood word and energy ratio: one source shared by the top bar and the spine
│   │   ├── viewport.ts           Writes the keyboard occlusion height into --kb-h, read from visualViewport, never innerHeight
│   │   ├── wakelock.ts           Keeps the screen awake while generating, releases on finish, re-acquires on return
│   │   ├── useRestoreFocus.ts    Focus restore: returns focus to the trigger after an overlay closes
│   │   └── useResolvedTheme.ts   Resolves a theme mode into light or dark
│   ├── styles/                   Site-wide styles
│   │   ├── tokens.css            The single source for design tokens (189 of them)
│   │   ├── global.css            Style order manifest; the real imports live in main.tsx
│   │   ├── base.css              Global base styles: reset and invisible rules
│   │   ├── compact.css           Mobile and touch: top bar, single column, 44px hit areas, type tiers, safe areas
│   │   └── *.css                 One file per component, named after it
│   ├── assets/fonts/             Interface typeface MiSans VF with its licence
│   ├── brand/mark.ts             Brand mark geometry, generated from icon.svg
│   ├── package.json
│   ├── tsconfig.json
│   └── vite.config.ts
├── cordis-host/                  Cordis host (Node 22 + TypeScript)
│   ├── index.ts                  Startup entry
│   ├── check-core.mjs            Core assembly check
│   ├── src/
│   │   └── server.ts             Local HTTP service
│   └── plugins/
│       ├── ondra-core/           Core assembly, where the member list lives
│       ├── desktop-bridge/       Bridges shell capabilities
│       ├── dsh-client/           Wraps JSON-RPC communication
│       └── ondra-*/              78 packages: 75 members plus ondra-core and two bridges
│           ├── src/              Source, including the settings declaration
│           ├── lib/              Compiled output
│           ├── locale/           Interface strings, present in some plugins
│           ├── icon.svg          Plugin icon
│           └── cordis.patch.yml  Old assembly declaration, kept for comparison, no longer read
├── dsh-sidecar/                  dsh kernel (Node 22 + TypeScript)
│   ├── src/
│   │   ├── index.ts              Process entry
│   │   ├── protocol.ts           Single source for the protocol
│   │   ├── rpc/
│   │   │   ├── transport.ts      Newline-delimited JSON framing
│   │   │   └── dispatcher.ts     Request dispatch
│   │   └── kernel/
│   │       ├── index.ts          Assembly
│   │       ├── types.ts          Shared types
│   │       ├── sessions.ts       Session storage
│   │       ├── models.ts         Model adaptation
│   │       └── tools.ts          Tool registration
│   ├── package.json
│   └── tsconfig.json
└── src-tauri/                    Tauri shell (Rust 2024)
    ├── Cargo.toml                Rust dependencies
    ├── Cargo.lock                Rust dependency lock
    ├── build.rs                  Build script
    ├── tauri.conf.json           Application configuration
    ├── capabilities/
    │   └── default.json          Default capability set for both windows
    ├── icons/                    Application icons at each size
    ├── installer/
    │   └── installer.nsi         Windows installer script
    └── src/
        ├── main.rs               Entry: window, events, cleanup on exit
        ├── host.rs               Host process management: start, wait, stop
        ├── commands.rs           Native capability commands
        ├── browser.rs            Built-in read-only browser: site, licence and changelog open in-window
        ├── tray.rs               Tray icon and menu
        └── window.rs             Close interception: hide to tray or quit
```

---

## 12. Performance

The following figures were measured on Apple Silicon macOS with Node 22.22.2.

| Metric | Value | How measured |
| --- | --- | --- |
| Front-end JS output | 365.86 KB, gzip 118.80 KB | `vite build` output, both chunks combined |
| Front-end CSS output | 70.74 KB, gzip 11.49 KB | `vite build` output |
| Front-end build time | About 2.1 seconds | `built in` line from `vite build` |
| Plugin loading, 75 members | 75 of 75, 0 skipped, about 200 ms | `pnpm run check:core` |
| Kernel cold start to a usable handshake | Under 500 ms | Observed during the smoke test |
| Host start to reporting ready | Under 2 seconds | Observed during the smoke test |
| Full smoke test | Under 5 seconds | Includes 7 interface checks and two process exits |

**CSS growing from 6 KB to 71 KB is the unavoidable cost of the interface rewrite, not a leak.** The old interface shared one stylesheet across a dozen components; the new one splits into 20 per-component files per §5, and adds the full design-token layer (189 tokens), the mobile and touch batch (`compact.css`, 459 lines), eight pages of preferences, and print layout. Gzipped it is 11.49 KB — smaller than the old version's uncompressed size. **The curve says the source grew, not that the transfer got heavier.**

**Of the 365 KB of JS, 12.65 KB is a lazily loaded `region` chunk** that is not on the critical path. The initial chunk is 361.98 KB (gzip 117.09 KB).

**Why loading time accumulates serially rather than in parallel.** The 75 plugins are awaited one at a time. Concurrent loading would let a dependent initialise before its dependency has registered its service, producing intermittent service-not-found failures. Paying a measured 200 milliseconds to remove a whole class of hard-to-reproduce races is worthwhile.

**Two measured constraints on context consumption.** Tool definitions and raw tool output are the two largest consumers of context. The tool gate decides by intent which tools to expose this turn, and the browser module truncates page snapshots against a double budget of 4000 characters and 80 lines. Neither shows up as local runtime latency; both show up as token cost and response quality in model calls.

---

## 13. Security and Privacy

### 13.1 Network boundary

- The host HTTP service listens on `127.0.0.1` only and never on `0.0.0.0`, so nothing outside this machine can reach it.
- The kernel listens on no port and communicates only through pipes with the host, so other local processes cannot connect to it.
- The content security policy restricts front-end to host connections to `127.0.0.1`.
- The browser module refuses private targets such as `127.0.0.1`, `localhost` and `*.local`, blocking the entry forms of server-side request forgery.

### 13.2 Authentication

- The token is generated as 32 random bytes when the host starts, passed to the page through the shell and never written to disk.
- Every request is checked for `Authorization: Bearer <token>`, and unauthorised requests are refused before the body is parsed.
- All responses carry `cache-control: no-store`, so tokens and session data enter no cache.

### 13.3 Capability permissions

- The front end holds no native capability directly. Choosing files and opening links always go through the host.
- External links are restricted to HTTP and HTTPS; the `file:` scheme and custom schemes are refused.
- Tauri capability permissions are configured per window, opening only the core defaults and restricted external link opening.
- The organ host's capability allow list denies by default: calling an undeclared capability raises an error rather than being silently ignored.

### 13.4 Data

- No telemetry, no crash reporting, no usage statistics. There is no code in the project pointing at any third-party analytics service.
- Data directory permissions are tightened at creation: directories 0700, files 0600.
- There is no account system, data does not synchronise across devices, and backups are performed by the user manually.
- There is no community, no public square and no share button; the conversation belongs to the user and to this machine.
- When a storage layer fails it degrades to memory and states explicitly that it does not persist, rather than discarding silently.

### 13.5 Prerequisites for high-risk capabilities

- Seven capabilities ship switched off and must be enabled manually: GUI operation, desktop read-only, phone read-only, SMS over adb, the browser guardrail, Minecraft and vision.
- The **egress gate** reminds and informs rather than proxying. Making it a proxy would force data through the plugin, putting credential values into plugin memory and creating a new risk instead.

---

## 14. Compatibility

| Platform | Status | Notes |
| --- | --- | --- |
| (1) macOS 11+ (Apple Silicon) | Primary target | Full functionality; build and packaging verified on this platform |
| (1) macOS 11+ (Intel) | Supported | Full functionality |
| (2) Windows 10+ | Supported | The installer builds; the file picker dialog is not yet implemented |
| (3) Linux (deb/rpm/AppImage) | Unverified | Same code, needs system integration configuration |
| (4) iPad (iPadOS 15+) | Not started | Requires a new iOS build |
| (5) iPhone (iOS 15+) | Not started | Requires a new iOS build |
| (6) Android 8+ | Not started | Requires a new Android build |
| (7) HarmonyOS NEXT | Not started | **No existing solution**; the ArkTS-side host transport has to be settled first |
| (8) CLI and Web | Partially available | Can reach a host remotely when a shell is present; needs one capability flag |
| (9) dsh kernel | Exists | The kernel process target, independently replaceable, no interface of its own |

**Why mobile is not just a configuration change.** The host is a Node process (about 108 MB) launched as a child process by the shell and spoken to over stdio plus local HTTP. The iOS sandbox forbids an app from creating child processes and forbids JIT; Android allows child processes but shipping a 108 MB runtime conflicts with the "install and go" expectation. Mobile therefore has to use a **remote host** — either the one running on your own computer or a hosted instance. Fortunately this already holds in the code: `HostConnection { url, token, port }` in `src/lib/host.ts` is injected by the shell, and the front end does not care where the host lives, so mobile only needs to change the injection source.

One real obstacle remains: `src-tauri/Cargo.toml` currently declares no `[lib]`, keeping the entry point in `main.rs`. Tauri's mobile targets **require** `lib.rs` plus `cdylib`, because iOS and Android link the Rust code as a dynamic library into a native project. Mobile therefore needs the `lib` structure restored and the entry point split.

**Browser development mode**, used by the front-end development script, has no shell, so native capability calls report an explicit error rather than failing silently.

**Node version.** Host and kernel rely on Node 22 features, and the engines field declares 22 or later. Node 20 and below fail at startup.

**Format compatibility.** A persona pack is a compressed package containing a metadata file and a skill description. The format is compatible with version 1.x of this project, so older persona packs can be used directly.

---

## 15. Known Limitations

1. **The model adapter covers only the OpenAI-compatible protocol.** The built-in adapter reads environment variables under a project prefix to select a provider and offers a local echo model, so the chain works without a key. Other third-party providers must be added one by one in settings.
2. **The tool registry is empty.** The skeleton registers no tool that the model can call. Note that this is separate from the 75 loaded plugins: plugins provide application capabilities such as memory, emotion, expression and assembly, while tool calls refer to tools the model can invoke, which are not yet connected.
3. **The shell command channel is not fully connected.** The desktop bridge's invoke does not yet reach the Tauri custom command endpoint on the host side, and calls return an explicit error.
4. **Windows file selection is not implemented.** The file picker returns not implemented on platforms other than macOS.
5. **The tray icon and menu are wired up, but only verified on macOS.** The tray is created in `src-tauri/src/tray.rs`; its three sizes (16 / 32 / 64) are rendered from `icon.svg` by `tools/build-tray-icons.mjs` and tinted as a template image on macOS. On macOS the four menu items, the click-to-reveal behaviour and the hide-to-tray close flow were all verified by hand. Windows and Linux have only had a code review.
6. **Single-window form.** Closing the main window hides it to the tray rather than quitting. Settings is a sheet over the main window, not a second window; closing the sheet returns you to the conversation.
7. **No automatic updates.** The update flow is not implemented.
8. **Plugin configuration reaches the interface only through three views.** The settings panel presents the 619 fields in a scene / module / raw layering; the extension drawer groups all 78 packages into three sections by responsibility (desktop bridge / kernel client / capability packs) and offers **no per-package switch** — all three are core components, and the app will not run without any of them, so the toggle capability stays on the host side for diagnostics. Corner fields that no top-level menu claims can only be edited as JSON in the raw layer.
9. **Two strict type checks do not apply to migrated plugins.** The exact optional properties and unchecked indexed access options are enabled only in the host, the kernel, the front end and three newly written plugins. The 75 migrated plugins have them off, and the reason and the cost are described in 5.8.
10. **The exact 410 by 290 Windows installer size awaits a real-machine check.** The default NSIS window size cannot be set to an arbitrary pixel size in configuration, so a custom template in `src-tauri/installer/installer.nsi` is already implemented: `guiInit` sizes the frame with `SetWindowPos` and scales it from a 96 DPI baseline via `GetDpiForWindow` (with a 96 DPI fallback on older systems), and `check:acceptance` guards both numbers with static assertions. What is missing is one real install on Windows; see the unverified list in 15.1.
11. **Voice input depends on system capability.** Voice input uses the Web Speech API, which may be unavailable in most desktop web views, in which case the button says the current environment does not support voice input.
12. **The installer carries its own runtime, but a real Windows launch has not been verified.** `build:runtime` collects the Node binary plus the host and kernel `node_modules` into `src-tauri/runtime/`, and `bundle.resources` packs that into the installer; `commands.rs` looks for `Resources/node/bin/node` (`node/bin/node.exe` beside the executable on Windows). Double-click launch is verified on macOS; on Windows the path resolution and startup have only been reviewed in code, and still need one real-machine check.
13. **The disk image is produced manually with `hdiutil`.** The bundling script shipped with the Tauri version in use fails on newer macOS because an unescaped bracket in a `grep` pattern breaks its parsing of `hdiutil` output, interrupting disk image creation. The application bundle itself is unaffected; the release flow wraps the bundle with `hdiutil create -srcfolder` after Tauri produces it, bypassing the script defect.
14. **Memorial personas are not open.** None of the three preconditions described in 2.5 — authorisation, scope statement and data minimisation — has any implementation, so this persona form is not offered. This is a product-level constraint, not a pending feature.

These limitations are explicit trade-offs at the current stage and do not represent the final form.

### 15.1 Unverified list (what cannot be checked on macOS)

These items are **implemented and reviewable in code, but have never actually run on the target platform**. They are listed separately because "it ran" and "it is written correctly" are two different things, and folding them into "done" would mislead whoever picks this up next.

| Item | What is done | What is missing | Risk |
| --- | --- | --- | --- |
| Windows installer (NSIS, 410×290, 3 pages) | Template, page sequence, variable declarations, DPI maths | A real install on Windows | Shortcut target, uninstall leftovers, high-DPI centring |
| Windows tray icon | Three sizes (16 / 32 / 64) rendered by script and bundled into `Resources/tray` | Never looked at it in the Windows notification area | Notification-area sizing and DPI handling may differ from the macOS menu bar |
| `cargo build` (release) | `cargo check` passes | A full release build | Problems that only surface at link or packaging time |
| Linux desktop integration | Code shared with the other platforms | A build on any distribution | deb/rpm dependencies, tray fallback when StatusNotifier is absent |
| 0.5px lines at 125% / 150% scaling | CSS declares a fallback to 1px | Never checked on real hardware | Lines may vanish or look fuzzy |
| Touch / iPadOS | Specification in the mobile section of this chapter | Implementation not started | — |

The bar is simple: **once any row above has been walked through manually on its platform and matches the status column of the compatibility table at the start of this chapter, it can move off this table.**

---

## 16. Changelog

> **Version numbering restarts here.** The internal beta line begins at `1.0.1-alpha`
> and no longer continues the earlier 2.x records; the previous 2.0–2.3 entries have
> been removed as requested. Every pre-release carries the `-alpha` suffix. It means
> **neither a public beta nor a stable release**.

### 1.0.1-alpha · first internal beta (2026-11-13)

#### Title bar: from "one hard-coded name" to "the current persona"

- The name is now the **display name of the active persona pack**, served by the host at `GET /api/personas`; it falls back to「空谷」while the host is not up yet. The pack list comes from `ondra-persona-loader` scanning `.skill.zip` archives; the factory pack is `oh-jingjing`（哦鲸鲸）.
- The top-left avatar is **the app icon itself**: white ground, black mark, the same geometry and the same proportions as `icon.svg`. It can be replaced in Settings → Persona (centre-cropped to 96×96, stored on this machine, never uploaded) and restored to the default in one click.
- Clicking the avatar or the name opens a **persona switcher**: factory, sample and user packs are listed, and picking one switches immediately. It goes through `POST /api/persona/activate` → `loader.setActive()`, so **the next prompt already uses the new persona** (hot swap), while `persona-loader.active-persona` is persisted so a restart keeps the same one. This is the path the persona loader always supported but which had no entry point.
- Presence is now **derived from real conditions**, and there are three states rather than two:

  | State | Condition |
  | --- | --- |
  | thinking | generating, and the path is up |
  | online | network up + host alive (`/api/health`) + at least one model connected (`/api/models` non-empty) |
  | offline | any of the above fails — drawn as a hollow dot, not a lie that says "online" |

#### Extension drawer: 78 rows collapsed into three sections, per-package switches gone

- Grouped by responsibility into **Desktop bridge (`desktop-bridge`) / Kernel client (`dsh-client`) / Capability packs (every other `ondra-*`)**. Sections collapse, and search still spans all of them.
- All three are **core components**: lose any one and the app either cannot reach the shell, cannot reach the kernel, or "she" has nothing left. So **no per-package switch is offered and there is no way to turn one off** — a greyed-out switch still implies that the thing is optional, and it is not.
- Packs added later need no code change: the test is the directory name, and a new pack lands in "Capability packs" automatically. The toggle capability stays in the host (`plugins.json` + `POST /api/plugins/:id/toggle`) as a diagnostic and advanced tool only; the interface exposes no entry point for it.

#### Right column "profile": wired to real numbers

- A new host route, `GET /api/companion/state`, merges the readings of two engines: the six axes of `ondra-emotion-core` (pleasure / arousal / dominance / mood / energy / tension) and the seven stages plus four relationship axes (affection / trust / intimacy / familiarity) of `ondra-emotion-stage`.
- Two derivation functions that always returned empty values were deleted from the interface (`deriveMood()` always `{0,0}`, `deriveBond()` always empty). They were correct when written — the engines were not connected; once the engines were connected they became "a page that admits a gap and always keeps it".
- The honest boundary stays: when the emotion service is absent `measured` is `false`, the interface says "not measured yet", and no bar parked at the midpoint pretends she is calm.

#### Frame and title bar in one colour

- The window body (the 8px frame and the four corners) now uses the same `--ui-bg-canvas` as the title bar; content sheets keep `--ui-bg-sheet`. The previous frame was one step lighter than the title bar, leaving a sandwich on all four edges that was only visible at the corners. **Only the colour changed — thickness and margins are untouched.**

#### Versioning and release

- The version is `1.0.1-alpha`, synchronised in seven places (four `package.json` files, `tauri.conf.json`, `Cargo.toml`, `Cargo.lock`).
- New `pnpm version:alpha`: patch +1 (`1.0.1 → 1.0.2`), local only, no release.
- New `pnpm version:alpha:minor`: minor +1 (`1.0.2 → 1.1.0`), commits the version files, tags `v*` and pushes; `.github/workflows/release.yml` then builds macOS (arm64 dmg) and Windows (x64 installer) and publishes a **pre-release**. Promoting to public beta or stable is always a manual act, never part of the pipeline.
- How the first internal build is obtained: macOS is built locally → dmg; Windows is built in the cloud by GitHub Actions → the artefact is downloaded and attached to the same release.

## 17. Roadmap

Ordered by dependency, where each item is a prerequisite for the next.

1. **Connect the shell command channel**, so the desktop bridge actually reaches Tauri. This is the prerequisite for file selection and external links working.
2. **Streaming conversation interface.** Subscribe to the inference delta event and implement incremental rendering and interruption.
3. **Tool registry.** Provide a basic tool set for file access, terminal and network, with argument validation before execution.
4. **Automatic updates** with signature verification, incremental download and rollback on failure.
5. **Plugin hot loading**, turning the "applies on restart" switches in the extension drawer into real hot swapping. Today a switch only edits the next launch list, because withdrawing a plugin that already provides a service key leaves dangling references behind.
6. **Restore the two strict type checks**, gradually fixing the 438 issues across 75 plugins and unifying the whole repository in the end.
7. **Standalone distribution package**, bundling the Node binary and dependencies into the installer so the target machine needs no Node installation.
8. **Linux support**, adapting the system integration.

---

## 18. Contributing

### 18.1 Development conventions

- **Units**: styles use px or rem only; rpx is forbidden.
- **Interface**: follow the Apple Human Interface Guidelines, with closed curves, consistent line weights and a clear hierarchy.
- **Code**: fully modular with on-demand loading; solve problems with the smallest and most direct code, and add no feature that was not asked for.
- **Comments**: explain why something is done rather than what is done; explain technical terms in plain language.
- **Language**: explanations, logs and error messages in Simplified Chinese; code, commands, variable names and paths keep their original form.
- **Plugins**: a new plugin must export `name` and `apply(ctx, config)`, must have a degradation path for a missing upstream, and must provide a description for every setting.

### 18.2 Checks before committing

```bash
pnpm run typecheck        # type check across the workspace
pnpm run build            # build front end, host and kernel
pnpm run smoke            # three-layer smoke test
pnpm run check:core       # plugin assembly check
pnpm run check:gap        # pre-occupation chain end to end (she says she is unsure → gap pool → talking point)
pnpm run check:gap-wake   # pre-occupation wake eligibility (a fresh 40-tension gap must not bury promises)
pnpm run check:system-prompt  # system prompt assembly (the four persona sections really produce text)
pnpm run check:prompt-context # memory injection (plugin-registered context really reaches the prompt)
pnpm run check:kernel-system  # kernel `system` param (really reaches the provider, and is never persisted)
pnpm run check:host-persona   # host end to end (post over HTTP; the provider receives the persona text)
pnpm run check:e2e            # proactive end to end (say one thing → stored → gate yields a talking point → model receives it)
pnpm run check:emotion      # emotion read chain (write one reading → six states → talking point)
pnpm run check:feel         # emotion write chain (one turn → signal → emotion core → persisted state)
pnpm run check:diffuse      # cross-session emotion diffusion (new session → mood keeps 40% of the remainder → written back and persisted)
pnpm run check:relation     # relation domain (one turn → interaction count → familiarity → diffusion really receives it)
pnpm run check:evolve       # persona evolution (one turn → interaction count → threshold really drifts to 1.0004)
pnpm run check:drift        # threshold drift takes effect (the same reading classifies differently before and after)
pnpm run check:project      # emotion projection (six states → template → last system-prompt section → passes the guard)
pnpm run check:e2e-memory     # memory extraction end to end (say something about yourself → extract → fact stored)
pnpm run check:ui         # UI spec assertions and token check
pnpm run check:installer  # Windows installer script syntax (needs makensis)
```

All twenty-one must pass before a commit. The assembly check exits non-zero when anything is skipped, so it serves directly as a gate. `check:gap` really loads the plugin chain and feeds it one conversation: what it proves is that the thing she could not answer actually lands in the pre-occupation pool and can actually be taken up as a talking point — merely grepping for a call site cannot catch that class of break. `check:gap-wake` covers the reverse side: gaps rank first among talking points and ranking is lexicographic, so without an eligibility test a brand-new gap at tension 40 would bury every promise and to-do. The script runs the same input down both the eligible and ineligible paths and checks that `pick.kind` actually changes hands, then verifies that `markDelivered()` really writes `picks` and `lastWakeAt`. `check:system-prompt` / `check:kernel-system` / `check:host-persona` are three links of one chain. The first reads the plugins' own views and proves the four persona sections really assemble — before this they assembled fine but had no consumer anywhere in the repo. The second spins up a fake provider and proves the `system` parameter of `inference.run` genuinely becomes the first wire `message` and is never persisted. The third posts to `POST /api/inference` and confirms from the provider's side that the persona text actually arrived — **the only reading that cannot be faked**, because the wire between "it assembled" and "it was sent" fails silently on both ends. `check:e2e` covers the other half of that same chain: `session/event` had only subscribers and never an emitter anywhere in the repo, so the turn drafts of `ondra-memory-intake` stayed empty and five tables — `memory_raw`, `working_todo`, `memory_fact`, `drive_gap`, `emotion_state` — held zero rows from the day the database was created, while every unit-level check stayed green (each of them calls `intake.ingest()` directly, stepping over the question of who triggers it). The script posts "remind me to print the contract tomorrow" to `POST /api/inference`, then reads the **database file** to confirm it was persisted, calls `POST /api/proactive/check` to confirm the reason switched to "something you asked me to do", and finally confirms on the fake provider's side that this talking point really entered the model context — plus the reverse proof that a proactive turn adds no new to-do. `check:e2e-memory` covers the **second half** of the memory chain: once `session/event` was fixed `memory_raw` had rows, yet `memory_fact` still held zero — because **five links of the model-calling chain were missing at once, all silently** (the gateway was not in the default enable list, `ctx.llm` had no provider anywhere in the repo, the gateway's `sources` default to an empty array, `sources[].model` must carry the provider id rather than the model name, and the extractor was not in the default enable list either). Break any one and the symptom is identical — everything downstream stays empty — so the script first prints the four layers' reason codes side by side from `/api/diagnostics/memory`, then posts "my name is Xiao Jiu, I live in Hangzhou" to `POST /api/inference`, and finally reads the **database file** to confirm those two rows really exist in `memory_fact`, with the reverse proof that neither the extraction prompt nor the returned JSON ever enters the conversation history. `check:emotion` and `check:feel` are the two sides of one chain: the first covers the read side (write a reading → the six states move → it becomes a talking point), the second the write side (one turn → recognise a signal → feed the emotion core → persist the state). The write side had no caller anywhere in the repo — `feel()` / `comfort()` / `setAxis()` / `save()` were never asked by anyone, so `emotion_state` held zero rows from the day the database was created and the six states stayed at calm; and since calm is a legal state, **nothing ever reported an error**. `check:feel` deliberately does not guess semantic emotion: `stumble` fires only when `ondra-drive-gap`'s `detect()` hits (the one source of truth for that criterion), `apology` / `gratitude` accept only an explicit word list of speech acts, and `reunion` is pure elapsed time; the magnitudes are left to the upstream 0.12 per-message cap and the 0.08 comfort step, and the caller recomputes neither. `check:installer` exits with code 2 (a skip, not a failure) where `makensis` is absent; where it is present the script compiles the installer for real. The installer script is over a thousand lines and is only ever consumed by the Tauri bundler on Windows — this check is the only way to surface its problems on the development machine.`check:diffuse` covers the **cross-session** half of the emotion chain: `ondra-emotion-diffuse` already had its formula, idempotency gate, gap gate, single-row mark table and parameter table written — what it lacked was a caller, since `claim()` had no call site anywhere in the repo and the plugin was not in the default enable list. So "how much of last session's mood carries over" never happened at all, and the symptom was that **she always behaves as if the previous conversation never ended**. The write-back lives in the host's `src/diffuse.ts` (the plugin deliberately keeps `setAxis` out of its own interface and types `applied` as the literal `false`), because the interface does not know about the thirty-minute gate and has no access to the mark table — calling it twice would multiply the remainder twice, and the symptom of that is a mood that fades the longer you talk. The script checks three layers: the plugin arithmetic (0.2 → 0.38, then four tenths of the remainder again), the host really calling `setAxis` (reading the emotion core's own view again, because checking only the return value misses an implementation that never writes and simply echoes the target back), and persistence (the row in the database is not last round's stale value). `check:relation` covers the **write side** of the relation domain: `ondra-emotion-stage` already had its seven-stage table, four gates, closed-form decay and storage written, yet all three write entries (`touch` / `adjust` / `observe`) had no caller anywhere in the repo — so `interactions` stayed at 0, hence `familiarity` stayed at 0, hence the `(1 − familiarity × 0.5)` term in the diffusion formula was entirely dead, the seven stages never left hostility, and the three dimensions could only decay, never grow. All three symptoms look like **nothing happened at all**: zero is the legal value for a stranger, hostility is a legal stage, so nothing anywhere reports an error — the seventh time this repository has hit that same shape. The fix has four parts: `touch()` becomes the single entry for counting an interaction (`adjust()` no longer counts, because counting in both places makes a turn count twice while the 5000 denominator is calibrated per turn); the host's `src/relation.ts` `recordTurn()` calls `touch()` and then `observe()` on turns where the user actually spoke (reversed, the first turn stalls on the second stage's interaction gate and the symptom is "stages always arrive one turn late"); `src/diffuse.ts` really passes `familiarity` into `claim()` (it previously passed only the boundary key, so the plugin treated it as zero); and `ondra-emotion-stage` enters the default enable list. The script checks four layers: the plugin arithmetic, the plugin write (`touch()` moves the count and persists it), the host wiring (**installing counters on the real service instance and counting calls**, because a boolean flag cannot prove that the one place actually executed), and downstream consumption (a stand-in records what `claim()` received, sidestepping the magnitude trap where a 0.0004 difference is invisible in the retain ratio).
`check:evolve` covers the **write side** of persona evolution: `ondra-persona-evolve` already had its drift formula, three-layer clamping, rollbackable log and three tables written, and its README even listed the feel table for "60 used to count as happy, later it takes 80" — what it lacked were four things, none of which reports an error: the plugin was not in the default enable list (so the service never registered), `noteInteraction()` had no call site anywhere in the repo (`interactions` stayed at 0, the factor stayed at ×1.00), and `thresholdOf()` and `personaState()` had no callers either. A factor of ×1.00 is legal and 0 is a legal interaction count, so the only symptom is **she always behaves as if she met you for the first time** — the eighth time this repository has hit that same shape. The fix deliberately avoids a second source of truth: the single source for the interaction count is the relation plugin's `touch()`, and the host's `src/evolve.ts` `syncEvolveInteractions()` only performs **difference alignment** — it brings the mirror up to whatever the source says, rather than adding one per turn, because the latter lets two counters accumulate from different starting points so history is never caught up and the two eventually drift apart. When the mirror runs ahead it only reports `drifted` and never flattens the difference; when the source is absent it does nothing at all, since using the mirror as its own ruler would be self-certification. The script checks six layers: the arithmetic (the 5000 saturation point, the 0.6 slope, the +60% ceiling, `effectiveThreshold(60, 2778) ≈ 80`), the host difference alignment (three added at once, not one per turn), idempotency (aligning twice adds nothing), persistence (the row in the database really holds 3), the probe (`appliedTo` lists only what actually consumes it), and the two boundaries of a mirror running ahead and an absent source. **That round only wired up "it can be computed"**: the thresholds of both the six states and the seven stages were constant tables inside their own plugins, and neither accepted a value passed in from outside — so `appliedTo` was deliberately left empty, and the `evolve` slot of `GET /api/diagnostics/emotion` answers that in machine-readable form instead of relying on a reminder in the documentation. The twenty-eighth round finished that job; see `check:drift`. `check:drift` covers exactly the half that was left hanging — **the judging side of threshold drift**. The previous round wired up "it can be computed" while the judgements still read constant tables, so "she gets harder and harder to please" held only inside its own README. Both sides are now connected: the six-state plugin gained a `thresholds.ts` that hands the `base` from `STATE_SPECS` to `persona-evolve.thresholdOf()` for the multiplication, and the seven-stage plugin gained the same for `affection` / `trust`; `base` always comes from the owner of the constant table, the multiplication belongs solely to O-130, and neither side stores the other's number — verbatim aligned with that plugin's README line that `base` is passed in by the caller every time. Three rules are written into the code: **lower bounds never drift** (`wilted` is `mood < 0.35` and `sleepy` is `energy < 30`; raising a lower bound would mean "she gets listless more easily", a misreading rather than "harder to please"); **`days` never drifts** (days spent together is objectively elapsed time, and multiplying it by 1.6 would claim "the longer you have been together, the longer affection takes to arrive" — circular); and a **reachability guard** (`mood > 0.7` times 1.6 is 1.12 while the mood scale stops at 1, so `mood > 1.12` can never hold and the `joyful` state would be killed off after about 3571 interactions; anything that overflows the scale falls back to the factory value and is reported honestly — better to drift less than to turn six states into five). The assertion is not "was the value passed" but **the same reading classifies differently before and after the drift**: `mood 0.78` classifies as joyful at zero interactions, and the same 0.78 stops being joyful at 1667 interactions (factor ×1.20). `evolve.appliedTo` in `GET /api/diagnostics/emotion` went from an empty array to a real list of consumers, and **its assertion is the consumers' own `drift.applied` being non-empty** — at a factor of ×1.00 the thresholds are identical to the factory values, so filling in a name there would be a lie, and that is exactly the normal state right after installation.
`check:project` covers the edge that is "the single text exit for emotion". `ondra-emotion-project` already had its six-state templates, four guard word lists, four refusal gates, config section and startup self-check written; what it lacked were four things, none of which reports an error: the plugin was not in the default enable list (so the service never registered), `project()` had no call site anywhere in the repo (the templates were written but nobody asked), the projection text had no consumer (the system prompt carried only persona plus organ fragments, not one word about how to speak today), and `constraint` had no consumer either (§4.4's limiting sentence never entered the prompt). So she always speaks in the same tone, and "there is no emotion block this turn" looks exactly like "there was never meant to be one" — the ninth time this repository has hit that same shape. The work landed in the host's `src/emotion.ts`, wired as the **last section** of the system prompt (handbook §8.5: stable sections at the head, volatile sections appended at the tail — the persona does not change between sessions, organ fragments change slowly, the projection changes every turn). Three boundaries are written into the code: **no constraint, no injection** (without §4.4's limiting sentence it is better to have no emotion block at all, because "you can talk a little more today" without "emotion affects tone, not judgement" would be read as behavioural authorisation); **never guess from the conversation whether the user is asking for numbers** (the plugin models that as an `askedForNumbers` input precisely because guessing is what it set out to avoid, and a keyword list in the host would be harder to audit; the cost is that this one exception exit never fires today, and the probe reports `askedForNumbersWired: false` rather than pretending otherwise); and **refusals are not logged** (a refusal is normal product behaviour, and one "no emotion block" line per minute would drown out the line that actually matters). The script checks nine layers: the four services in place, all six templates producing output at order 800, the exception gate really refusing, the emotion section really reaching the assembly result and arriving last, **the guard run over the finished text** (the plugin's own self-check only scans `command + hint`, while what actually enters the prompt is that plus the constraint — the limiting sentence had never been scanned), the section really changing when the state changes, idempotency, the probe readings, and six abnormal paths (service absent / config disabled / empty constraint / empty body / the projection throwing / the plugin refusing). The real-host section additionally checks two things only an end-to-end run can answer: whether the plugin is in the **default enable list**, and whether `emotionApplied` (turns where the host really spliced it into the prompt) stays in step with `project.counters.projects` (times the plugin produced one) — checking only the latter would miss "it was retrieved and then dropped".

### 18.3 Reporting problems

Please state the reproduction steps, the expected result, the actual result, and the standard error output of the kernel and the host. For a specific plugin, include the package name and the current values of the relevant settings.

### 18.4 Contributing content

Persona packs, world books and scene cards are welcome. Contributors must confirm the copyright of their own content and must not include copyrighted text written by others. Material relating to memorial personas must come with authorisation evidence, otherwise it will not be merged.

---

## 19. Copyright and License

Copyright © 2024–2026 Ntarstudio（星玖工作室）. All Rights Reserved.

This project is licensed under the [GNU Affero General Public License v3.0](./LICENSE). The full licence text is in the `LICENSE` file.

The core obligation of AGPL-3.0: if you modify this program and make it available over a network, you must publish the modified source under the same licence. This does not affect private use of the program on your own machine.

**Trademarks.** 空谷, Ondra, Ntarstudio and 星玖工作室 are names and marks used by this project. AGPL-3.0 grants a copyright licence, not a trademark licence. Derivative works must not suggest that they are produced or endorsed by Ntarstudio.

**No warranty.** This program is provided as is, without any express or implied warranty, including but not limited to warranties of merchantability, fitness for a particular purpose and non-infringement. The complete disclaimer is in sections 15 and 16 of the licence.

---

## 20. NOTICE Open-source Compliance Statement

Every third-party software component, asset and algorithm source used by this project is disclosed item by item in the [NOTICE](./NOTICE) file, including name, version, copyright holder, licence type, official address, purpose in this project and modification status.

**Scope of disclosure.** It covers direct dependencies and all transitive dependencies: 442 Rust crates (6 direct, 436 transitive) and 87 npm packages (12 direct, 75 transitive), 529 components in total. The numbers come from parsing `Cargo.lock` and `pnpm-lock.yaml` and are not estimates. Different versions of the same crate are counted separately, since versions may carry different licences; de-duplicated by name the figures are 416 Rust crates and 74 npm packages.

**Licence distribution.** MIT and Apache-2.0 together with combinations of the two account for 448 components, Zlib for 22, Unicode-3.0 for 19, MPL-2.0 for 17, BSD-3-Clause for 10, Unlicense, 0BSD, CC0-1.0 and MIT-0 together for 8, ISC for 3, and LGPL-2.1-or-later taken as one option among several for 2. Every one of them is compatible with AGPL-3.0.

**How the weak-copyleft obligation is handled.** All 17 MPL-2.0 components enter as unmodified published releases, so no derivative-work obligation arises under section 3 of MPL-2.0 and there is no obligation to publish source. If any of them is ever modified, the modified files must be published under MPL-2.0.

**Content not used.** This project uses no code, model weights, datasets, images or audio of unknown origin, unknown licence or requiring a paid licence. The interface font **MiSans VF** ships with the front-end bundle (`src/assets/fonts/MiSansVF.woff2`, 8.8 MB, subsetted from the official TTF) and is embedded under Xiaomi's free-for-commercial-use grant; the grant terms, subset ranges and attribution duty are in `src/assets/fonts/LICENSE-MiSans.md`, and the font is registered item by item in section 6 of NOTICE. The system font stack is only a fallback. Icon geometry comes from `lucide` (ISC); rendering and morphing are handled by `morphicons` (MIT), both consumed unmodified as dependencies. The application icon is an original design licensed with the source under AGPL-3.0.

**No model weights.** The kernel is a pure code implementation containing no model weights. Inference is provided by a model service the user configures at runtime, and the terms governing that model are set by the agreement between the user and the provider, independent of this project's licence.

**Where others' content is referenced**, the source is stated and compliance with its licence confirmed. This project's own copyright notices and third-party notices are kept side by side in the same file without overriding each other.

If you believe this project infringes your copyright, trademark or other rights, or you find an omission or error in NOTICE, please reach us through the repository issues or the website. We will correct or remove the relevant content within seven working days of verification.
