# 空谷 Ondra

[中文](./README.md) ｜ [English](./README_EN.md)

**On No Sound's Depth, Resonance Arises.**

Ondra is a fully plugin-based desktop AI companion application. It splits the three things that make companionship feel real — that she remembers, that she has feelings, that she speaks like a person — into 134 plugins that can be installed and removed individually, plus one plugin manifest and two bridge layers, running inside a desktop program on your own machine.

The name comes from the Chinese idiom 空谷足音, hearing a person's footsteps in a silent valley, a metaphor for rare and precious news.

| Item | Value |
| --- | --- |
| Version | 2.0.1 |
| Form | Desktop application (Tauri shell + Cordis host + dsh kernel, three process layers) |
| Platform | Nine targets: (1) macOS 11+ (Apple Silicon first) (2) Windows 10+ (3) Linux (deb/rpm/AppImage) (4) iPad (iPadOS 15+) (5) iPhone (iOS 15+) (6) Android 8+ (7) HarmonyOS NEXT (8) CLI and Web (9) dsh kernel. **This release targets (1) macOS and (2) Windows first**; the rest follow the schedule in `docs/UI-DESIGN.md` §10 |
| Positioning | A companionship app. Not a general assistant, not a model, not a cloud service |
| Plugin scale | 137 packages = 134 loadable plugins + 1 plugin manifest + 2 bridges; 1168 config fields, of which 1123 are directly settable |
| Interface | Two states in one window: Home (logo plus composer) and Conversation (48px left rail, timeline column, right spine); baseline 820 × 580 |
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

1. **Change cost grows non-linearly with feature count.** When everything lives in one process, every new capability touches the main entry point and widens the regression surface. Maintaining 134 plugins by hand in a single process makes the impact of any change unpredictable.
2. **A failing optional capability takes down the whole application.** One badly written network adapter can prevent startup. Channel plugins depend on external credentials and external networks, so their failure rate is inherently far higher than that of local features.
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

The second principle governs how capabilities are organised: the service key is the interface. None of the 134 plugins imports another at code level; they discover each other at runtime through Cordis service keys, and when an upstream is absent they skip that step and leave a trace. This is what allows plugins to be added or removed without compile-time ripples.

### 2.4 Where it fits

- A desktop companion intended to run continuously in the background, rather than a one-question-at-a-time chat box.
- Product forms that need capabilities outside the browser sandbox, such as local files, the clipboard and system state.
- Applications assembled from several independent capabilities that should be installed and removed on demand.
- Situations where model capability must be upgraded by swapping the kernel alone, with no interface change.
- Privacy-sensitive environments where conversation data must never leave the machine.
- Situations where AI conversation must reach existing channels such as WeChat, QQ or Feishu while keeping the same persona and the same memory.

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

This chapter has two parts. Section 3.1 describes the runtime skeleton that carries every capability, covering only the necessary structure and boundaries. From 3.2 onward it describes the 137 packages one by one, together with their configurable settings, and that is the body of this document.

### 3.1 Runtime skeleton

**Three process layers.** Shell, host and kernel each occupy a process and communicate over explicit protocols, so any layer can be replaced, upgraded or restarted on its own.

| Layer | Path | Stack | Responsibility | Explicitly not |
| --- | --- | --- | --- | --- |
| Shell | `src-tauri/` | Rust 2024 + Tauri 2 | Window, tray, single instance, host lifecycle, native capability commands | Contains no business logic |
| Host | `cordis-host/` | Node 22 + Cordis 4 + TypeScript | Plugin container, local HTTP interface, token authentication | Does not touch the operating system directly |
| Kernel | `dsh-sidecar/` | Node 22 + TypeScript | Inference loop, tool invocation, session storage, model adaptation | Loads no interface, listens on no port |
| Interface | `src/` | React 19 + Vite 8 | Interface rendering | Does not own native capabilities |

**Three communication paths.** Between shell and host the transport is line-delimited JSON over standard input and output, where the host reports ready or fatal on standard output and the shell decides from that whether startup succeeded. Between host and kernel the transport is JSON-RPC 2.0 over standard input and output framed as newline-delimited JSON, defined in one place in `dsh-sidecar/src/protocol.ts`. Between interface and host the transport is HTTP on `127.0.0.1` with Bearer token authentication, where the token is generated by the shell at startup.

**The kernel's 13 methods** cover five domains: lifecycle, session, inference, tools and models. The handshake reports the capability list once, so callers can trim their interfaces accordingly rather than probing one method at a time.

**How plugins are loaded.** `cordis-host/plugins/` holds 137 packages. Of these, 134 are declared in an explicit array inside `ondra-core`, loaded one at a time, each load wrapped in its own `try/catch` so a failure lands in the skipped list with its reason recorded. The other three belong to the assembly layer itself: `ondra-core` owns that member list, while `desktop-bridge` and `dsh-client` are mounted directly by the host entry and never enter the core array. None of the 134 imports another at code level; they discover each other entirely through service keys.

---
### 3.2 Plugin Inventory

The 137 packages fall into 7 top-level menus and 28 second-level groups. Every field follows the declaration in that plugin's `src/settings.ts`, and the default values come from the same declaration, so there is never a second set of values.

**Reading conventions**: `Switch` is a boolean toggle; `Slider` is a number with bounds; `Segmented` is a fixed set of enumerated choices; `Tag list` is a list of strings that can be added to and removed from entry by entry; `URL` and `Route` are text inputs, the former for an address and the latter for a path relative to the site. **Advanced** fields are collapsed in the interface by default and can be set once expanded; their keys are listed here so they can be searched.

> The full field list can be exported straight from `FIELD_SPECS` in `cordis-host/plugins/*/src/settings.ts`; no separate attachment is needed. Earlier versions of this file pointed at `ondra-settings.csv` and `ondra-panel-model.json`, neither of which exists in this repository, so that reference has been removed — **this document does not cite files the repository does not contain**.

| Top-level menu | Groups | Plugins | Enabled | Off at factory | Total fields | Directly settable | Not directly settable | Of which advanced | Of which secret |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Persona Detail | 6 | 24 | 24 | 0 | 199 | 196 | 3 | 93 | 0 |
| Voice & Appearance | 2 | 7 | 6 | 1 | 74 | 72 | 2 | 33 | 0 |
| Channel Interfaces | 4 | 10 | 0 | 10 | 184 | 164 | 20 | 82 | 0 |
| Extended Features | 3 | 7 | 7 | 0 | 45 | 45 | 0 | 22 | 0 |
| Developer Features | 11 | 65 | 57 | 8 | 436 | 416 | 20 | 188 | 0 |
| Emotion Engine | 1 | 7 | 6 | 1 | 25 | 25 | 0 | 12 | 0 |
| Memory System | 1 | 17 | 17 | 0 | 205 | 205 | 0 | 131 | 0 |
| **Total** | **28** | **137** | **117** | **20** | **1168** | **1123** | **45** | **561** | **0** |

**Every column is counted field by field from `FIELD_SPECS` in each plugin's `src/settings.ts`**, so re-running the same script after any code change reproduces them exactly:

| Column | Definition |
| --- | --- |
| Plugins | Packages appearing as entries in this chapter. This includes `ondra-core` and the two bridges, hence 137; the number of independently loadable plugins is 134 |
| Enabled / Off at factory | `FIELD_SPECS.enable.default`. 8 plugins have no `enable` field and 11 have no `settings.ts` at all; both are permanently enabled and counted under Enabled |
| Total fields | Number of top-level keys in `FIELD_SPECS`, **including fields the interface gives no editing control for** |
| Directly settable | Total fields minus "not directly settable". This is the number of entries a user can actually change in the UI, and it is what each plugin entry below calls its "configurable settings" |
| Not directly settable | Two kinds: (1) **on-disk paths** (key ends in `Dir` / `File` / `Path` and `kind: 'string'`), which the program probes at runtime so the interface only echoes them read-only, and a hand-typed mistake surfaces only at runtime; (2) **structured arrays** (`kind: 'json'` with an array default), which need a per-item form rather than a single input box. Of the 48 path fields in the repository only some sit on a user-editable surface, hence 45 in total |
| Of which advanced | Fields carrying `advancedOnly: true`, i.e. 48.0% of all fields. Collapsed by default, editable once expanded |
| Of which secret | Fields carrying `secret: true`. **Measured at 0** — no field anywhere declares itself secret, so the interface needs no password input, see 5.6 |

The figures reconcile in three directions: **row by row**, `Total fields = Directly settable + Not directly settable` holds for all 7 rows; **by column**, `1168 = 1123 + 45`; and `1123` matches the sum of the 137 individual plugin entries in the body text, item by item.


### 3.3 Persona Detail

This menu answers who she is, how she speaks, and in what capacity she keeps you company. It holds 6 groups, 24 plugins and 199 configurable fields, of which 196 can be changed directly, all enabled at the factory default. The persona is split into replaceable parts rather than one hard-coded prompt: Persona Core owns the six-slot structure that defines who she is, Persona Variables & Intensity owns how strong the delivery is, Persona Assembly owns the fixed order of the four segments, and Persona Pack owns swapping the character. World Book & Scenes supplies background knowledge, Speech Expression turns the model's written register into spoken language, Emotion Projection & Injection carries the current mood into this turn's tone, Relationship & Narrative owns forms of address, first meetings and reunions, and Presence owns whether she should pause and whether she should split a message.


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
| `budget-chars` | Slider | 2600 | 400 – 48000 | Character budget for each turn's prompt. Defaults to 2600; raise it to 24000 when the persona takes priority. Exceeding it is reported as overBudget rather than silently truncated. |
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

**6. Persona Workshop** · package `ondra-persona-workshop` · enabled · 3 settings

Persona Workshop: runs an eight-item metadata check-up on an existing persona pack, covering id against package name, file registration, SKILL.md length, six-slot coverage, trigger words, hard red lines, profile fields and the copyright notice, and then produces a derivation draft describing which file and position to change, a new package skeleton and the three things the author must decide. It is read-only throughout: it never writes a pack, never generates a ZIP, never writes copy and never judges likeness.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. The workshop is a read-only check-up; when off, it accepts no more inspection or draft requests. |
| `max-personas` | Slider | 32 | 1 – 64 | How many packs a comparison table may cover. Capped at 64, since more than that stalls a single render. |

Advanced (collapsed by default, 1): `verbose`


#### Persona Detail · World Book & Scenes

**7. World Book** · package `ondra-worldbook` · enabled · 9 settings · 1 not directly settable

World Book: six budget layers, totalling 1600 tokens and split as 350, 180, 100, 500, 200 and 150. A layer that would overflow drops the whole entry rather than cutting characters. Resident entries form their own segment and are frozen as the session prefix, and ordering inside a layer is stable rather than floating with hit counts, which guarantees the prefix of one session never changes.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the world book no longer takes part in assembly and the service registers as unavailable. |
| `load-file` | Switch | On | — | Whether to load the world book from a file at startup. A missing file is not an error, since having no world book is a normal state. |
| `include-headings` | Switch | On | — | Whether to add a short heading to each layer. Turning it off saves a few dozen tokens, but the model may then read a prohibition as plot. |

Advanced (collapsed by default, 6): `annotate-dropped`, `report-dropped`, `fit-policy`, `cjk-chars-per-token`, `ascii-chars-per-token`, `max-entry-tokens`

Not directly settable (1): `worldbook-file` (State or data file. Leaving it empty uses the built-in default; no manual entry is needed.)

**8. World Book · Scene Cards** · package `ondra-worldbook-scenes` · enabled · 8 settings · 1 not directly settable

World Book · Scene Cards: parses trigger, surface, lines, action, closing and hard rules verbatim out of the scene reference file in the persona pack, then computes that only one skeleton is used per turn, matching by keyword with negation-neighbourhood protection, making cards within one group mutually exclusive and recursing no more than three levels. When rendering it strips the inner-thought column, because deliberation is not dialogue and writing it into the prompt makes her say her private thoughts out loud.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, no scene is ever decided and the service registers as unavailable. |
| `persona-id` | Text | Blank | — | Which persona's scene cards to use, fixed. Leaving it empty follows the current persona, so swapping personas re-parses automatically. |
| `exclusion` | Segmented | group | group / layer / slot / off | Exclusivity granularity. group keeps one card alive per chapter group, which is the default; layer keeps one alive per budget layer, the strict reading of same-layer exclusivity; slot makes only cards declaring the same slot exclusive; off disables exclusivity. |
| `max-depth` | Slider | 3 | 0 – 3 | Recursion limit, where 0 disables recursion. The ceiling of 3 comes from the design specification; a larger value is clamped back with a warning. |

Advanced (collapsed by default, 4): `min-term-chars`, `negation-guard`, `default-layer`, `report-excluded`

Not directly settable (1): `scenes-file` (State or data file. Leaving it empty uses the built-in default; no manual entry is needed.)

**9. Multi-character Theatre** · package `ondra-theater` · enabled · 5 settings

Multi-character Theatre: answers exactly one question, which is who speaks next when several characters share a scene. What it gives is staging, not lines: who is present, whose turn it is, what intent the utterance carries (opening, response, transition, closing), how many sentences at most, and what must not happen. The four hard rulings live in types and constants. The same character may not speak twice in a row, since otherwise the theatre degenerates into a monologue, so fewer than two characters is refused outright. The character count is hard-capped at four and excess characters are refused on the spot rather than queued, because a queue would make the extra person speak suddenly several rounds later. Every scene must have an explicit closing condition, namely a round cap plus a cold-scene criterion, and whichever hits first ends the scene, so nothing can run forever. Leaving requires closing first: the contract has no leave method at all, so removing a character means closing and opening again, and vanishing mid-scene does not exist at the interface level. Rotation is deterministic, with seating order as speaking order and the previous speaker always skipped, so there is no randomness and no loudest-voice-first. Reading does not advance and only advancing moves the turn, so a caller that polls freely will never push the same person up twice. It does not assemble personas, does not generate lines, does not drive the conversation, builds no interface, installs no timers and persists nothing, since a scene is one-off and disperses on restart.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, but open, next and advance all throw disabled. |
| `maxRoles` | Slider | 4 | 2 – 4 | Upper bound on the number of characters. The hard ceiling is 4 and configuration can only lower it, because five characters in one scene make every turn wait for four replies. |
| `maxRounds` | Slider | 6 | 1 – 12 | Upper bound on rounds. Rounds times seats is the total number of utterances in a scene, which is the first closing condition. |
| `maxSentences` | Slider | 2 | 1 – 4 | Upper bound on sentences per utterance. Beyond two, a turn becomes one monologue plus one acknowledgement, and the second character is left with a nod. |
| `disperseSec` | Slider | 120 | 30 – 1800 | Cold-scene threshold in seconds. Once the gap since the last utterance exceeds it, the scene moves to wrap-up, which is the second closing condition. |


#### Persona Detail · Speech Expression

**10. Colloquialization** · package `ondra-oral` · enabled · 14 settings

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

**11. Output Filtering** · package `ondra-filter-chain` · enabled · 20 settings

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

**12. Language Feel** · package `ondra-lexicon` · enabled · 10 settings

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

**13. Dialogue Orchestration** · package `ondra-dialogue` · enabled · 10 settings

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

**14. Dialogue Protocol** · package `ondra-dialogue-protocol` · enabled · 3 settings

Dialogue Protocol: a five-frame protocol of text delta, text replace, crisis, usage and done, with a closed set of four finish reasons. The frame shapes, the cross-frame discipline of a single final frame and exactly one usage and one crisis each, and the NDJSON codec exist in one copy here. In the previous project those three shapes were scattered across the session loop, the interface and the channels, so a text-replace frame treated as an increment showed the user the opening twice, and a silently dropped crisis frame meant the crisis notice never reached the user. It makes no business judgement, rewrites no text, persists nothing and creates no session.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, but create returns a writer that closes at once, so downstream callers receive no frames instead of silently continuing. |

Advanced (collapsed by default, 2): `allow-empty-delta`, `verbose`


#### Persona Detail · Emotion Projection & Injection

**15. Emotional Projection** · package `ondra-emotion-project` · enabled · 6 settings

Emotional Projection: the single textual outlet for emotion. The template is fixed as one behavioural instruction sentence plus one hint, and any number, dimension name or emotion label is forbidden, leaving only subjective phrasing such as not quite feeling up to it. Turning to numeric status is allowed only when the user explicitly asks for a value, and the fragment sort key is always positive so it stays at the tail and preserves the prefix cache.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, but every projection request is refused with the reason code disabled. |
| `projection-ttl-minutes` | Slider | 10 | 1 – 1440 | Lifetime of the projection segment in minutes. The default of 10 reflects that it is only advice on the tone for this turn, shorter-lived than any state variable. |
| `projection-order` | Slider | 800 | 0 – 1000 | Sort key for the projection segment, positive by default so it lands at the tail. The requirement is that volatile segments are appended at the end; a negative value breaks the prefix cache. |
| `confidence-matched` | Slider | 0.9 | 0 – 1 | Confidence when an explicit criterion is matched. The criteria are written literally, so 0.9. |
| `confidence-fallback` | Slider | 0.5 | 0 – 1 | Confidence when falling back on a gap. A fallback is not a decision, so 0.5. |

Advanced (collapsed by default, 1): `verbose`

**16. Prompt Injection** · package `ondra-prompt-inject` · enabled · 14 settings

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

**17. Zero-residence Context** · package `ondra-zero-residence` · enabled · 7 settings

Zero-residence Context: replaces resident content with deterministic pointers, where every obscured character can be restored verbatim. The requirement is that pointers replace resident content deterministically, that obscured bytes can be restored verbatim from the session log so the operation is reversible and auditable, and that state is written to SQLite before compression. This plugin turns those into four actions: compact cuts a resident passage into recoverable fragments and hands out pointer text, recall retrieves and verifies the original by pointer, ledger lists the receipts without dumping the text, and fast is a pure preview that writes nothing and keeps no ledger. Three rulings are hard-coded. First, a pointer is a function of content rather than of time, so the same passage compressed twice in one session must yield the same pointer, since otherwise every compression changes the prefix and the prefix cache drops to zero on the spot. Second, compression may only happen at user-turn boundaries, because rewriting the prefix mid-turn invalidates the whole turn's cache. Third, no pointer is issued without a storage backend, since a pointer that cannot be written is a link to loss and it is better not to compress this turn. Personas, world books and boundary prohibitions never enter the ledger, because they are the frozen stable segment itself. This plugin does not take over the message sequence, does not concatenate prompts, does not call a model and installs no timer; the replacement is performed by the caller, and this plugin only supplies recoverable replacement text and auditable receipts.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `mode` | Segmented | observe | off / observe / compact | Three modes: off computes nothing, observe computes without writing and is the default, compact actually writes to disk and hands out pointers. |
| `require-durable` | Switch | On | — | Whether to persist before handing out a pointer. The requirement is that the pre-compression state is written to SQLite first. Turning it off allows compression without a store, but the result is lost on restart. |
| `verify-on-recall` | Switch | On | — | Whether to verify length and fingerprint when restoring. Turning it off only affects the trusted marker, not whether the text can be retrieved. |

Advanced (collapsed by default, 4): `max-span-chars`, `min-savings-chars`, `max-records`, `verbose`

**18. Lull Etiquette** · package `ondra-absence` · enabled · 6 settings

Lull Etiquette: answers one question, which is how to respond when someone returns after a long gap. It defines five tiers covering today, yesterday, a few days, a while and a long time, and each tier gives only what must be done, what must never be done, a sentence cap, whether to acknowledge the gap and whether a little warmth is allowed, with no number anywhere. Even the length of the gap appears only as one of five coarse words, because saying that seventeen days have passed is not care but turning a reunion into an interrogation. The type of the ask-about-gap field is the literal false, since a boolean would guarantee a true branch and that branch would inevitably be switched on during some attempt to show concern. Four general prohibitions hold across every tier: never ask where they went, never report the exact interval, never invent a story for the gap and never read the absence as being abandoned. Reading does not advance the state, and only the side that actually speaks records that it was mentioned, so a caller polling freely never says the same greeting twice. The archive holds three timestamps and two counters, never what was last discussed and never why the person left, since that would be attendance tracking rather than etiquette. It builds no interface, installs no timer and sends nothing on its own initiative.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, touch and mention throw disabled, and view stays readable. |
| `brief-hours` | Slider | 6 | 1 – 48 | Gaps shorter than this many hours do not count. The default of 6 is one full night's sleep. |
| `noticed-days` | Slider | 1 | 1 – 7 | Beyond this many days the gap moves to the tier that remembers the person but loses the thread. Defaults to 1. |
| `long-days` | Slider | 3 | 2 – 30 | Beyond this many days the gap moves to the tier that remembers the person but forgets the details and must acknowledge the time apart. Defaults to 3. |
| `distant-days` | Slider | 14 | 4 – 365 | Beyond this many days the gap moves to the tier that may have forgotten who she is. Defaults to 14 and must exceed the previous field. |

Advanced (collapsed by default, 1): `max-sentences-cap`

**19. First-meeting Script** · package `ondra-first-meet` · enabled · 3 settings

First-meeting Script: cuts the first meeting into five beats of arrival, introduction, boundary, invitation and closing, where each beat gives only the purpose, what must be done, what must never be done and a sentence cap, with not one word of script. Boundaries come before the invitation, since explaining what she will not do before asking the first question keeps the opening from becoming a demand. Reading does not advance the water mark and only the side that actually speaks the beat advances it, so polling never consumes a beat, and when the user speaks first the flow jumps straight to the closing beat rather than forcing the script through. The archive holds only the beat watermark and timestamps and never a single sentence the other person said, because on a first meeting people give real names and circumstances, and those belong to the memory system and the right to be forgotten. It does not send the first message, does not initiate, and builds no interface.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, advance and reset throw disabled, and plan stays readable. |
| `auto-start` | Switch | On | — | Whether the first exchange enters the first meeting automatically. When off, plan returns an empty beat and the flow only starts when called explicitly. |

Advanced (collapsed by default, 1): `max-sentences-cap`

**20. Co-creation Flow** · package `ondra-cocreate` · enabled · 3 settings

Co-creation Flow: the division of labour and the turn structure when two people make something together. Four beats run in fixed order: framing, drafting, feedback and closing. The proposing side sets only the goal and the acceptance criteria, the working side only drafts and revises, and the two roles never overlap structurally, since one person doing both collapses co-creation into monologue. The version count has a hard cap and reaching it leaves closing as the only move; the cap counts versions rather than turns, because turns can be padded while versions cannot. A handoff must carry a version number and a mismatch is refused on the spot, so when two people edit at once the later one gets an error instead of quietly overwriting the other's changes. A revision must build on the previous version, since starting a fresh draft would make version numbers meaningless. Closing does one thing only: it asks explicitly whether this version is final and then stops. This plugin has no final state, since the final field is the literal false, because finality is answered by a person and not by a flow on their behalf. It generates no content, stores no body text, installs no timer, initiates nothing and builds no interface. State lives in memory only.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, open, handoff and close throw disabled, and next and snapshot stay readable. |
| `max-editions` | Slider | 3 | 1 – 6 | Hard cap on versions. At the limit the only remaining move is to wrap up. The default of 3 is a first draft plus two revisions, counted in versions rather than turns because turns can be padded. |

Advanced (collapsed by default, 1): `note-max-chars`

**21. Thread Backlog** · package `ondra-climb` · enabled · 11 settings

Thread Backlog: compresses unread group backlog into a list of who said what and when, and hands it over only in private chat. Four rulings are hard-coded. First, the summary is not written by a model: links are removed, whitespace collapsed and text cut at sentence boundaries to the cap, all deterministically, since real summarisation belongs to the model in the dialogue chain and calling a model here would tie latency and cost to every backlog pass. Second, nothing is posted into the group, because a plan for a group chat always returns empty: backlog is what the owner has not seen, not something to be read back into the group, and that is how waking only in private chat is enforced. Third, not one character of the backlog is persisted, only the cursor recording how far it has read and which fingerprints were seen, with a restart relying on the channel to re-push, since losing one pass is better than keeping a corpus nobody agreed to. Fourth, planning does not move the cursor and only committing advances it, because sending can fail and automatic advancement would mean those messages are never mentioned again and no error is raised. The list never says how many remain unseen, since that is a tally rather than speech, and the folded count goes only to the log and the panel. This plugin exposes no tools, installs no timer, makes no outbound request and draws no interface.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, but plan returns a disabled empty plan instead of silently continuing. |
| `max-groups` | Slider | 6 | 1 – 32 | How many groups one pass may cover. Above six, the backlog list grows longer than anyone will read; remaining groups are ordered by oldest message and deferred to the next pass. |
| `max-items-per-digest` | Slider | 12 | 1 – 40 | Maximum lines in one pass. At roughly thirty characters per line, twelve lines is about 400 characters, the limit for mentioning something in passing; beyond that the owner should read the group themselves. |
| `max-chars-per-item` | Slider | 60 | 10 – 200 | Maximum characters per message line. A group message usually runs under forty characters, so sixty leaves room for one clarifying clause; any longer and she is retelling on someone else's behalf. |
| `max-digest-chars` | Slider | 600 | 80 – 2000 | Character cap on the whole backlog block. 600 sits in the same order of magnitude as the injection budget and will not crowd out this turn's conversation history. |
| `max-age-hours` | Slider | 72 | 1 – 720 | Backlog older than this many hours is dropped. A group conversation from three days ago is of no use to her and only produces a remark out of place. This is the only switch that genuinely discards messages. |
| `max-pending-per-group` | Slider | 200 | 10 – 2000 | Maximum messages cached per group. At 200 messages of 60 characters, roughly 12 KB, one group cannot exhaust memory; beyond that the oldest are evicted and counted. |
| `show-group-id` | Switch | On | — | Whether the list includes group ids. It does by default, because when the owner says that group, only the id can settle which one. |
| `persist-cursor` | Switch | On | — | Whether to persist the cursor. When off, a restart repeats backlog already mentioned, without any error, just repetition. |

Advanced (collapsed by default, 2): `include-private-backlog`, `verbose`


#### Persona Detail · Presence

**22. Message Splitting & Pauses** · package `ondra-rhythm` · enabled · 22 settings

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

**23. Typing & Pause Execution** · package `ondra-rhythm-typing` · enabled · 6 settings

Typing & Pause Execution: runs the splitting plan from the rhythm module as a real timeline, showing thinking before the first message and typing between two, never showing typing during a long pause, allowing cancellation per conversation, letting a new turn displace the previous one in the same conversation, and stopping on unload. Without the rhythm service it falls back to sending everything in one block rather than simulating typing. It only executes and never produces content: splitting belongs to the rhythm module and typing display and presence belong to the breathing module.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, but run falls back to sending everything in one block. |

Advanced (collapsed by default, 5): `conversation-id`, `long-pause-threshold-ms`, `wake-buffer-ms`, `emit-phase-events`, `verbose`

**24. Breathing Room** · package `ondra-breath` · enabled · 7 settings

Breathing Room: maps the typing phase from the execution layer into whether typing should be shown right now, hiding it during long distracted pauses, and within a budget of twice a day supplies one bracketed action such as stretching. It only decides whether and which line, and never sends, draws no interface and installs no timer.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, but presence reports nothing and take returns disabled. |
| `presence-enabled` | Switch | On | — | Whether to answer the is-typing question. This only produces a decision; it does not draw any interface. |
| `breath-enabled` | Switch | On | — | Whether to allow a bit-of-life action, at most twice a day. |
| `daily-cap` | Slider | 2 | 0 – 2 | Daily cap on those actions. The original value is 2 and the cap is locked at 2. |

Advanced (collapsed by default, 3): `same-action-once-per-day`, `extra-actions`, `verbose`


### 3.4 Voice & Appearance

This menu answers what she looks like and what voice she speaks with. It holds 2 groups, 7 plugins and 74 configurable fields, of which 72 can be changed directly. The Voice group converts text to speech, decides when speaking is appropriate and when it is not, and converts speech back to text; the Appearance group owns the portrait, expressions, stickers and the desktop pet entry point. Six of the seven plugins are enabled at the factory default; the desktop pet entry point is off because it requires the user to pick a desktop pet backend first.


#### Voice & Appearance · Voice

**25. Speech Synthesis** · package `ondra-tts` · enabled · 18 settings

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

**26. Voice Gate** · package `ondra-tts-gate` · enabled · 8 settings

Voice Gate: four gates covering the switch, a length window of six to thirty characters, an emotion intensity of at least 0.15 or an emotion word present in the turn, and a three-second rate limit, plus a rule that forces text after two consecutive voice messages. It only decides and neither speaks nor synthesises: the decision carries a reason code, the real character count, the emotion intensity and the six-state speaking rate, and the dialogue chain hands it to synthesis. When the emotion service is absent it passes through as degraded and says so, while a missing synthesis channel is reported honestly as unavailable, and those two failure directions point opposite ways on purpose.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, nothing is ever read aloud. The service still registers. |
| `min-chars` | Slider | 6 | 2 – 30 | Lower bound on sentence length, counted after whitespace is removed. A sentence that short sounds like a notification tone. |
| `max-chars` | Slider | 30 | 6 – 120 | Upper bound on sentence length. Beyond it the text should be split rather than read out. |
| `intensity-min` | Slider | 0.15 | 0 – 1 | Emotion intensity threshold between 0 and 1. Below it, and with no emotion word present, nothing is spoken, because plain statement is better served by text. |
| `cooldown-ms` | Slider | 3000 | 0 – 10000 | Rate-limit interval in milliseconds. 0 disables rate limiting. |

Advanced (collapsed by default, 3): `max-consecutive`, `emotive-bypass`, `verbose`

**27. Speech Transcription** · package `ondra-asr` · enabled · 15 settings · 2 not directly settable

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

**28. Character Portrait** · package `ondra-avatar` · enabled · 7 settings

Character Portrait wiring layer: resolves what should be on her face into which image or which model to display, and hands that to the renderer. It only wires and falls back to a static image: it renders no pixel, judges no emotion and creates no image. The single source for the six states is six-state expression, textual clues come from expression decision, and the Live2D runtime is registered from outside.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, no frame is ever produced. The service still registers, so the panel shows it as closed. |
| `provider` | Segmented | auto | auto / static / live2d | auto uses live2d when a model and a renderer are both available, otherwise a static image, otherwise nothing. static forces the static image, while live2d prefers the model. |
| `dir` | Route | avatar | — | Shared asset directory, relative to the user area of the data root and defaulting to user/avatar. Only a single directory name is accepted; absolute paths and parent references are refused. |
| `use-persona-dir` | Switch | On | — | Whether to look first in the persona pack's own personas directory for an avatar, read-only and only used when an image is present. |
| `min-hold-ms` | Slider | 1200 | 0 – 10000 | Minimum time in milliseconds an expression stays on screen. 0 sets no floor. This value was not supplied and is a provisional choice awaiting adjudication. |

Advanced (collapsed by default, 2): `default-state`, `verbose`

**29. Expression Decision** · package `ondra-expression-decide` · enabled · 5 settings

Expression Decision: classifies finished text into one of six states by clue words, punctuation and sentence shape, and hands that to the portrait layer to change the face. It answers only what the face should show when this line is spoken, inserting no marker into the text and writing no state name into the prompt. With no clue in the text it falls back to the current state from six-state expression, and when neither is available it gives the least error-prone default expression while letting the caller see that this time there was no basis.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, no marker is ever produced. The service still registers. |
| `min-score` | Slider | 2 | 1 – 10 | Score threshold between 1 and 10, where a strong word scores 3, a medium word 2, punctuation 2 and sentence shape 1. The default of 2 means one medium word or two weak clues. |
| `use-state-fallback` | Switch | On | — | Whether to follow the current six-state emotion when the text carries no clue, leaving the face unchanged. When off, the default expression is used directly. |

Advanced (collapsed by default, 2): `fallback-state`, `verbose`

**30. Stickers** · package `ondra-sticker` · enabled · 9 settings

Stickers: reads and distributes sticker packs, where the directory is the index and filenames are tags with no manifest file, multiple images under one tag rotate by ordinal, and a missing tag falls back through the persona pack, the shared pack and the built-in pack in that order. The built-in layer is a registrable fallback slot that ships empty, since this repository holds no sticker artwork and does not invent images, so a miss returns an honest reason code. It only answers which images a tag holds and which comes next; when to send one is not its business, since the interval belongs to colloquialization and the probability to six-state expression.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, no image is ever fetched. The service still registers. |
| `user-subdir` | Text | stickers | — | Subdirectory name for the sticker root under user/ in the data root. Only a plain single-segment directory name is accepted. |
| `cache-ttl-ms` | Slider | 60000 | 0 – 600000 | How long the index cache lives in milliseconds. 0 rescans the directory on every fetch. |

Advanced (collapsed by default, 6): `persona-subdir`, `read-legacy-path`, `root-override`, `normalize-tags`, `create-dirs`, `verbose`

**31. Desktop Pet Entry** · package `ondra-pet` · off at factory · 10 settings

Desktop Pet Entry, a skeleton. The first rule is to build nothing in-house, so this plugin draws no window, makes no portrait and implements no Live2D, doing only the four things an entry point should. The licence gate turns the rule that AGPL code may only inform the design into an executable decision, since one candidate project is AGPL-3.0 and integrating it would violate the licence, and that should not depend on anyone remembering. Bridge security turns origin validation and a single-use token into a pure function that refuses by default, rejecting non-loopback addresses, tokens embedded in URLs and empty origin lists. A single-instance state machine guarantees only one pet on the desktop, because two does not mean livelier, it means the user cannot tell which one is her. Render tier degradation makes live2d requests fail honestly instead of showing a black screen, since the Cubism Core is proprietary and cannot be redistributed, so it is explicitly out of scope for this stage. The relevant capability was checked and found absent, and this repository forbids adding dependencies, so the bridge is defined as a port that honestly reports no bridge when no implementation exists rather than pretending she is already on the desktop. It registers not a single tool, because summoning is a user action and a model able to open windows would be overstepping.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | Off | — | Desktop pet switch. Off by default, because it opens a separate window and a window is something on your desktop. |
| `adapter` | Text | dsh-pet | — | Which desktop pet ecosystem to use: dsh-pet first, or agentpet. Coopanion is AGPL-3.0 and is refused. |
| `render` | Segmented | static | static / live2d | Render tier. Only static is available, because Live2D's Cubism Core is proprietary and cannot be redistributed. |
| `bridge-url` | URL | Blank | — | Desktop pet bridge address. It must be loopback, use ws or wss, and name an explicit port, for example ws://127.0.0.1:19387/pet. Leaving it empty means no bridge is started. |
| `allowed-origins` | Tag list | Empty | — | Origins allowed to connect to the bridge, for example http://localhost:5173. An empty list refuses everything, so starting without filling this in means no origin validation. |
| `always-on-top` | Switch | Off | — | Whether to keep the window on top. Off by default, because a window covering what you are doing gets closed within a week. |
| `scale` | Slider | 1 | 0.5 – 2 | Scale factor between 0.5 and 2. Upstream implementations disagree on what one times means, so this is a neutral cross-implementation value. |

Advanced (collapsed by default, 3): `token-ttl-ms`, `allow-token-in-url`, `verbose`


### 3.5 Channel Interfaces

This menu answers where she talks to you. It holds 4 groups, 10 plugins and 184 configurable fields, of which 164 can be changed directly, all off at the factory default. It is the only top-level menu that is disabled as a whole: every channel needs its own credentials, and enabling one without credentials produces nothing but a run of connection failures. The ten channels cover four WeChat forms (official account, customer service, personal account, WeCom), Feishu and DingTalk, two QQ forms (official bot and NapCat reverse WebSocket), Telegram and Discord. The personal account channel is marked high risk in its own title, because its implementation relies on an unofficial interface and carries account risk.


#### Channel Interfaces · WeChat Family

**32. WeChat Official Account** · package `ondra-adapter-wechat-official` · off at factory · 16 settings · 2 not directly settable

WeChat Official Account channel: the host route receives callbacks, sha1 signature verification, splitting at 800 characters, a degraded line sent first against the five-second hard limit, and the real reply delivered through the customer service message window of 48 hours. It never listens on a port itself, since the route hangs on the host web server and is withdrawn on unload.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | Off | — | Channel switch. Off by default, because an official account that starts answering followers the moment it is installed is an incident, not a feature. |
| `route-path` | Route | /ondra/wechat-official | — | Path mounted on the host web server. In the official account console, the server address is https://your-domain followed by this path. |
| `chunk-max` | Slider | 800 | 100 – 800 | Per-message limit. This is a platform hard limit and can only be lowered. |
| `allow-open-ids` | Tag list | Empty | — | Allowed openids. An empty array means no restriction, so every follower can trigger her. An official account is a public entry point, so leave it empty only after thinking it through. |
| `block-open-ids` | Tag list | Empty | — | Blocked openids. This takes precedence over the allow list, so a blocked user gets no reply even when listed as allowed. |
| `degrade-text` | Text | 我在呢，等我一下下。 | — | The line sent first when the five-second timeout is about to hit. It must be short, must sound human, and must not promise a specific time. |
| `reply-budget-ms` | Slider | 4400 | 800 – 4900 | Reply budget. The hard limit is 5000 ms and this allows at most 4900, since the five seconds start when the request arrives. |
| `window-hours` | Slider | 48 | 1 – 72 | Customer service message window. The platform rejects messages outside it, so they are rejected locally first. |
| `dedupe-window-ms` | Slider | 1800000 | 60000 – 86400000 | Dedupe window. WeChat retries three times when no response arrives within five seconds, and without recognising the retry the same message is answered three times. |
| `max-concurrent` | Slider | 3 | 1 – 16 | Concurrency cap. A hundred messages arriving at once should not open a hundred model requests. |
| `persist` | Switch | On | — | Whether to persist window and dedupe state. Without persistence, a restart treats someone who just spoke as outside the window. |

Advanced (collapsed by default, 5): `reply-timeout-ms`, `request-timeout-ms`, `api-base`, `persist-ms`, `verbose`

Not directly settable (2): `credential-file` (Credential file path, produced by the provisioning flow. The interface only echoes it read-only.); `state-file` (State or data file. Leaving it empty uses the built-in default; no manual entry is needed.)

**33. WeChat Customer Service** · package `ondra-adapter-wechat-kf` · off at factory · 18 settings · 2 not directly settable

WeChat Customer Service channel: pull-based sync every five seconds with cursor dedupe, needing no public callback, splitting at 800 characters and a 48-hour session window. The optional callback is used only for event reception, and sha1 verification is required only when it is mounted.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | Off | — | Channel switch. Off by default, because once installed it starts auto-replying to external contacts, which is an incident, not a feature. |
| `poll-ms` | Slider | 5000 | 1000 – 60000 | Polling interval in milliseconds. Measured at five seconds; lowering it amounts to hammering the platform interface. |
| `chunk-max` | Slider | 800 | 100 – 800 | Per-message limit. This is a platform hard limit and can only be lowered. |
| `window-hours` | Slider | 48 | 1 – 72 | Session window in hours. The platform rejects proactive messages outside the window, so they are rejected locally first. |
| `allow-external-user-ids` | Tag list | Empty | — | Allowed external contact ids. An empty array means no restriction. A customer service account is an outward-facing entry point, so leaving it empty lets anyone trigger her. |
| `block-external-user-ids` | Tag list | Empty | — | Blocked external contact ids. This takes precedence over the allow list, so a blocked contact gets no reply even when listed as allowed. |
| `allow-open-kf-ids` | Tag list | Empty | — | Allowed customer service account ids, which start with wk. An empty array means no restriction. Use it to accept only one account when an enterprise runs several. |
| `respond-origins` | Tag list | 1 items | — | Which source codes to reply to. The default is only 3, the WeChat customer, since without filtering she would also answer the receptionist's own replies. |
| `persist` | Switch | On | — | Whether to persist cursors and window state. Without persistence, every restart re-pulls from the beginning or misses an entire span. |

Advanced (collapsed by default, 9): `page-limit`, `max-rounds`, `max-concurrent`, `persona-timeout-ms`, `request-timeout-ms`, `api-base`, `callback-path`, `persist-ms`, `verbose`

Not directly settable (2): `credential-file` (Credential file path, produced by the provisioning flow. The interface only echoes it read-only.); `state-file` (State or data file. Leaving it empty uses the built-in default; no manual entry is needed.)

**34. WeChat (Personal Account · High Risk)** · package `ondra-adapter-wechat-personal` · off at factory · 16 settings · 2 not directly settable

WeChat Personal Account channel, high risk: it provides only the wiring, the double gate and the semantics, while the actual operation of WeChat is done by a wxauto bridge the user supplies on Windows. The inbound route accepts loopback requests only, splits at 1000 characters, and replies only when both the switch and the confirmation file are present.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | Off | — | Channel switch. Turning it on alone will not produce replies: it also needs the confirmation flag and a confirmation file, which makes two gates. |
| `confirmed` | Switch | Off | — | Second confirmation. Only the literal true counts, and the file user/channels/wechat-personal.confirm.json must also exist. Personal account automation risks a ban, and a single mistaken click costs an irreversible account penalty. |
| `route-path` | Route | /ondra/wechat-personal | — | Inbound path. The bridge posts here, and only loopback requests are accepted. This part is not configurable. |
| `chunk-max` | Slider | 1000 | 100 – 1000 | Per-message limit. It can only be lowered. |
| `cooldown-ms` | Slider | 1200 | 0 – 60000 | Minimum interval between two replies in the same conversation. The default of 1200 ms is an inferred value. |
| `reply-budget-ms` | Slider | 4000 | 800 – 30000 | Budget for waiting synchronously. Past it the call returns deferred and the real reply goes through the webhook, if one is configured. This is not a platform limit; it only keeps the bridge from waiting. |
| `allow-contacts` | Tag list | Empty | — | Allowed contacts, matched on the WeChat display name. An empty array refuses everyone, so no message goes outside the allow list. |
| `block-contacts` | Tag list | Empty | — | Blocked contacts. This takes precedence over the allow list. |
| `allow-groups` | Switch | Off | — | Whether to reply in group chats. The default is no, since group chats are not approached proactively. |
| `reply-mode` | Segmented | sync | sync / webhook | Reply outlet. sync writes into the HTTP response with no configuration needed, while webhook acknowledges first and then pushes to outbound-webhook. |
| `outbound-webhook` | URL | Blank | — | Outbound address, http or https. Leaving it empty restricts replies to sync, and any reply over budget is dropped with a log entry. |
| `persist` | Switch | On | — | Whether to persist the cooldown table. Without persistence the cooldown resets on restart, which matters little but is still stated. |

Advanced (collapsed by default, 4): `max-concurrent`, `request-timeout-ms`, `persist-ms`, `verbose`

Not directly settable (2): `confirm-file` (Credential file path, produced by the provisioning flow. The interface only echoes it read-only.); `state-file` (State or data file. Leaving it empty uses the built-in default; no manual entry is needed.)

**35. WeCom** · package `ondra-adapter-wecom` · off at factory · 12 settings · 2 not directly settable

WeCom channel: the host route receives encrypted callbacks, with a self-implemented message crypt that decrypts AES-256-CBC without encrypting, splitting at 2000 characters, an immediate success response and then an asynchronous reply through an application message. It never listens on a port itself.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | Off | — | Channel switch. Off by default, because an enterprise app that starts replying to member messages the moment it is installed is an incident, not a feature. |
| `route-path` | Route | /ondra/wecom | — | Path mounted on the host web server. In the WeCom console, the message receiving server configuration is https://your-domain followed by this path. |
| `chunk-max` | Slider | 2000 | 100 – 2000 | Per-message limit, measured at 2000. This is a platform hard limit and can only be lowered. |
| `allow-user-ids` | Tag list | Empty | — | Allowed member UserIDs. An empty array means no restriction, so every member of the enterprise can trigger her. In an enterprise app this decides visibility, so leave it empty only after thinking it through. |
| `block-user-ids` | Tag list | Empty | — | Blocked member UserIDs. This takes precedence over the allow list. |
| `dedupe-window-ms` | Slider | 1800000 | 60000 – 86400000 | Dedupe window. WeCom retries when no timely response arrives, and without recognising the retry the same message is answered twice. |
| `max-concurrent` | Slider | 3 | 1 – 16 | Concurrency cap. A hundred messages arriving at once should not open a hundred model requests. |
| `persist` | Switch | On | — | Whether to persist dedupe state. Without persistence, a restart answers the same message again. |

Advanced (collapsed by default, 4): `request-timeout-ms`, `api-base`, `persist-ms`, `verbose`

Not directly settable (2): `credential-file` (Credential file path, produced by the provisioning flow. The interface only echoes it read-only.); `state-file` (State or data file. Leaving it empty uses the built-in default; no manual entry is needed.)


#### Channel Interfaces · Feishu & DingTalk

**36. Feishu** · package `ondra-adapter-feishu` · off at factory · 12 settings · 2 not directly settable

Feishu channel: the host route receives event subscriptions, verifies the verification token, explicitly refuses encrypted bodies, splits at 4000 characters, returns a zero code immediately and then sends asynchronously. It never listens on a port itself.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | Off | — | Channel switch. Off by default, because a Feishu app that starts replying the moment it is installed is an incident, not a feature. |
| `route-path` | Route | /ondra/feishu | — | Path mounted on the host web server. In the Feishu developer console, the event subscription request address is https://your-domain followed by this path. |
| `chunk-max` | Slider | 4000 | 100 – 4000 | Per-message limit, measured at 4000. This is a platform hard limit and can only be lowered. |
| `allow-sender-ids` | Tag list | Empty | — | Allowed sender open_ids and user_ids. An empty array means no restriction, so anyone within the app's visibility can trigger her. |
| `block-sender-ids` | Tag list | Empty | — | Blocked senders. This takes precedence over the allow list. |
| `dedupe-window-ms` | Slider | 3900000 | 60000 – 86400000 | Dedupe window. Feishu redelivers on three schedules of roughly 15 seconds, 5 minutes and 1 hour, and the default of 65 minutes just covers the third. |
| `max-concurrent` | Slider | 3 | 1 – 16 | Concurrency cap. A hundred messages arriving at once should not open a hundred model requests. |
| `persist` | Switch | On | — | Whether to persist dedupe state. Without persistence, a restart answers the same message again. |

Advanced (collapsed by default, 4): `request-timeout-ms`, `api-base`, `persist-ms`, `verbose`

Not directly settable (2): `credential-file` (Credential file path, produced by the provisioning flow. The interface only echoes it read-only.); `state-file` (State or data file. Leaving it empty uses the built-in default; no manual entry is needed.)

**37. DingTalk** · package `ondra-adapter-dingtalk` · off at factory · 14 settings · 2 not directly settable

DingTalk channel: the host route receives outgoing callbacks, verifies an HMAC-SHA256 signature, returns an empty body first and then speaks asynchronously in the background, degrades the session webhook and the bot proactive interface independently, and splits at 4000 characters. It never listens on a port itself.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | Off | — | Channel switch. Off by default, because a DingTalk bot that starts replying the moment it is installed is an incident, not a feature. |
| `route-path` | Route | /ondra/dingtalk | — | Path mounted on the host web server. In the DingTalk developer console, bot message reception over HTTP push is https://your-domain followed by this path. |
| `chunk-max` | Slider | 4000 | 100 – 4000 | Per-message limit, measured at 4000. This is a measured platform limit and can only be lowered. |
| `allow-sender-ids` | Tag list | Empty | — | Allowed senders by staffId or senderId. An empty array means no restriction, so anyone in the organisation can trigger her. |
| `block-sender-ids` | Tag list | Empty | — | Blocked senders. This takes precedence over the allow list. |
| `dedupe-window-ms` | Slider | 600000 | 60000 – 86400000 | Dedupe window. After an empty 200 response, platform redelivery is very rare, so ten minutes suffices. The repository holds no evidence for the exact schedule. |
| `max-concurrent` | Slider | 3 | 1 – 16 | Concurrency cap. A hundred messages arriving at once should not open a hundred model requests. |
| `reply-via` | Segmented | auto | auto / session / active | Reply outlet: auto tries sessionWebhook first and falls back to the proactive interface once it expires; session uses only the first; active uses only the proactive interface, which is useful for troubleshooting. |
| `persist` | Switch | On | — | Whether to persist dedupe state. Without persistence, a restart answers the same message again. |

Advanced (collapsed by default, 5): `request-timeout-ms`, `api-base`, `sign-skew-ms`, `persist-ms`, `verbose`

Not directly settable (2): `credential-file` (Credential file path, produced by the provisioning flow. The interface only echoes it read-only.); `state-file` (State or data file. Leaving it empty uses the built-in default; no manual entry is needed.)


#### Channel Interfaces · QQ

**38. QQ (Official Bot)** · package `ondra-adapter-qq-official` · off at factory · 22 settings · 2 not directly settable

QQ Official Bot channel: splits at 1200 characters, passive replies must carry the original message id, six anti-ban gates apply, and each channel gets its own credentials and its own state. Transport is a port rather than an implementation, so without documented protocol evidence no handshake that merely looks like it would work is written.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | Off | — | Channel switch. Off by default, because a connected channel speaks as a real account, and that is an incident, not a feature. |
| `quiet-enabled` | Switch | On | — | Late-night silence switch. It only blocks proactive messages; she still answers when addressed. |
| `per-minute` | Slider | 20 | 1 – 60 | Token bucket: per-minute cap. |

Advanced (collapsed by default, 19): `chunk-max`, `content-max-len`, `block-patterns`, `quiet-start`, `quiet-end`, `dedupe-window-ms`, `dedupe-min-len`, `per-hour`, `per-day`, `cooldown-group-ms`, `cooldown-private-ms`, `jitter-ms`, `circuit-strikes`, `circuit-cooldown-ms`, `failure-stop-ms`, `reply-timeout-ms`, `persist`, `persist-ms`, `verbose`

Not directly settable (2): `credential-file` (Credential file path, produced by the provisioning flow. The interface only echoes it read-only.); `state-file` (State or data file. Leaving it empty uses the built-in default; no manual entry is needed.)

**39. QQ (NapCat)** · package `ondra-adapter-qq-napcat` · off at factory · 31 settings · 3 not directly settable

QQ NapCat channel over OneBot v11, high risk: the switch and the confirmation flag form a double gate with a separate confirmation file, QQ numbers and group numbers have separate allow lists, six anti-ban gates apply, and there is a reverse WebSocket upgrade route. Encoding is a port rather than an implementation, so without in-repository evidence for OneBot frames no handshake that merely looks like it would work is written.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | Off | — | Channel switch. Off by default, because this high-risk channel connects the moment it is installed, which is an incident, not a feature. |
| `confirmed` | Switch | Off | — | First confirmation: I understand the risk of running automation on a real QQ account. Only the literal true counts. |
| `list-host` | URL | 127.0.0.1 | — | Reverse WebSocket listen address. When NapCat runs in a container or on another machine, this must be an address the host can reach, and loopback no longer applies. |
| `port` | Slider | 3001 | 1024 – 65535 | Reverse WebSocket listen port. This is the port the local side listens on, not NapCat's address; swapping the two means it never connects. |
| `path` | Route | /onebot/v11/ws | — | Upgrade route path. On the NapCat side, configure ws://host:port followed by this path. |
| `chunk-max` | Slider | 1200 | 200 – 2000 | Per-message limit. NapCat does not specify one, so the default takes QQ's official 1200. |
| `allow-users` | Tag list | Empty | — | Allowed private chat QQ numbers. An empty array refuses everyone, since the empty list on a high-risk channel must mean answering nobody. |
| `allow-groups` | Tag list | Empty | — | Allowed group numbers, configured separately from QQ numbers. An empty array refuses everyone. |
| `group-keyword` | Text | Blank | — | In-group keywords. Leaving it empty means only an at-mention counts, which is safer than filling it in, since keyword matching lets a passing remark summon her. |
| `group-reply-probability` | Slider | 1 | 0 – 1 | Reply probability after being triggered in a group. 1 replies every time and is the most predictable; lower it to prevent flooding. |
| `content-max-len` | Slider | 1800 | 200 – 20000 | Content gate length. |
| `block-patterns` | Tag list | Empty | — | Content gate regular expressions. Three categories were specified without the original patterns, and inventing three would only look like blocking, so this ships empty. |
| `quiet-enabled` | Switch | On | — | Late-night silence. It only blocks proactive messages; she still answers when addressed. |
| `quiet-start` | Text | 00:30 | — | Silence start time, UTC+8. |
| `quiet-end` | Text | 07:30 | — | Silence end time. |
| `dedupe-window-ms` | Slider | 1800000 | 1000 – 86400000 | Duplicate dedupe window, 30 minutes. |
| `dedupe-min-len` | Slider | 4 | 1 – 32 | Shortest length subject to dedupe, which lets short replies like a bare acknowledgement or a question mark through, since people do repeat those. |
| `per-minute` | Slider | 20 | 1 – 60 | Token bucket: per minute. |
| `per-hour` | Slider | 200 | 1 – 600 | Token bucket: per hour. |
| `per-day` | Slider | 1500 | 1 – 5000 | Token bucket: per day. Tencent watches the long-term curve, and limiting only the hourly rate is a pitfall already paid for. |
| `cooldown-group-ms` | Slider | 5000 | 0 – 60000 | Group conversation cooldown, 5 seconds. |
| `cooldown-private-ms` | Slider | 3000 | 0 – 60000 | Private conversation cooldown, 3 seconds. |
| `jitter-ms` | Slider | 400 | 0 – 5000 | Random jitter before sending. A fixed rhythm is itself a signature of automation. |
| `circuit-strikes` | Slider | 3 | 1 – 10 | How many consecutive risk-control hits trip the circuit breaker. |
| `circuit-cooldown-ms` | Slider | 1800000 | 60000 – 86400000 | Breaker duration, 30 minutes. When the platform has taken notice, the only correct move is to say nothing at all. |
| `failure-stop-ms` | Slider | 300000 | 10000 – 86400000 | How long sending pauses after three consecutive failures, 5 minutes. |
| `reply-timeout-ms` | Slider | 60000 | 5000 – 600000 | Timeout for one persona reply. A timeout aborts only this turn; it neither switches model nor retries. |
| `persist` | Switch | On | — | Whether to persist gate state. Clearing it on restart means every restart bypasses the anti-ban protections. |

Advanced (collapsed by default, 3): `require-confirm-record`, `persist-ms`, `verbose`

Not directly settable (3): `confirm-file` (Credential file path, produced by the provisioning flow. The interface only echoes it read-only.); `token-file` (Credential file path, produced by the provisioning flow. The interface only echoes it read-only.); `state-file` (State or data file. Leaving it empty uses the built-in default; no manual entry is needed.)


#### Channel Interfaces · Telegram & Discord

**40. Telegram** · package `ondra-adapter-telegram` · off at factory · 12 settings · 2 not directly settable

Telegram channel: long polling with a timeout of fifty, the token appearing only in the URL and redacted throughout, offset used for structural dedupe, a three-second backoff on failure and splitting at 4000 characters. It is pull-based, registering no route and occupying no port, with the loop attached to the effect disposer so it stops on unload.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | Off | — | Channel switch. Off by default, because once installed it starts polling and replying, which is an incident, not a feature. |
| `chunk-max` | Slider | 4000 | 100 – 4000 | Per-message limit, measured at 4000. It can only be lowered. |
| `poll-timeout-sec` | Slider | 50 | 1 – 50 | Long polling timeout. Telegram's official ceiling is 50, so raising it achieves nothing. |
| `backoff-ms` | Slider | 3000 | 1000 – 60000 | Backoff after failure. A fixed value rather than exponential, since exponential turns one blip into minutes of silence. |
| `max-concurrent` | Slider | 3 | 1 – 16 | Concurrency cap. A hundred messages arriving at once should not open a hundred model requests. |
| `allow-sender-ids` | Tag list | Empty | — | Allowed sender ids as decimal strings of Telegram user ids. An empty array means no restriction. |
| `block-sender-ids` | Tag list | Empty | — | Blocked senders. This takes precedence over the allow list. |
| `persist` | Switch | On | — | Whether to persist state. Without persistence, a restart re-pulls from the earliest update, which is a disaster. |

Advanced (collapsed by default, 4): `request-padding-ms`, `api-base`, `persist-ms`, `verbose`

Not directly settable (2): `credential-file` (Credential file path, produced by the provisioning flow. The interface only echoes it read-only.); `state-file` (State or data file. Leaving it empty uses the built-in default; no manual entry is needed.)

**41. Discord** · package `ondra-adapter-discord` · off at factory · 11 settings · 1 not directly settable

Discord channel: Gateway WebSocket v10 with the frame layer injected through a socket port, an authorization header of the bot form with single-point redaction throughout, splitting at 1900 characters, reconnect stopping on close code 4004 and a fixed five-second delay otherwise. It states explicitly that there is no dedupe, so this plugin builds no cross-time dedupe table and keeps only an idempotent placeholder that drops a message id already in flight. It registers no route and occupies no port, with connections and timers attached to the effect disposer so they stop on unload.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | Off | — | Channel switch. Off by default, because once installed it opens a WebSocket and starts replying, which is an incident, not a feature. |
| `chunk-max` | Slider | 1900 | 100 – 1900 | Per-message limit, measured at 1900. It can only be lowered. |
| `reconnect-ms` | Slider | 5000 | 1000 – 60000 | Reconnect interval. A fixed value rather than exponential, since exponential turns one blip into minutes of silence. |
| `max-concurrent` | Slider | 3 | 1 – 16 | Concurrency cap. Dozens of messages arriving at once should not open dozens of model requests. |
| `allow-sender-ids` | Tag list | Empty | — | Allowed sender ids, where Discord user ids are snowflakes written as decimal strings. An empty array means no restriction. |
| `block-sender-ids` | Tag list | Empty | — | Blocked senders. This takes precedence over the allow list. |

Advanced (collapsed by default, 5): `api-base`, `request-timeout-ms`, `stop-on-codes`, `queue-ttl-ms`, `verbose`

Not directly settable (1): `credential-file` (Credential file path, produced by the provisioning flow. The interface only echoes it read-only.)


### 3.6 Extended Features

This menu answers what she offers you on her own initiative beyond conversation. It holds 3 groups, 7 plugins and 45 configurable fields, all of them directly changeable, all enabled at the factory default. The Periodic Artifacts group generates text worth keeping on a daily and weekly cadence; the Time Rituals group handles actions that depend only on the date, such as On This Day, Time Capsule and solar terms; the Ambient Information group supplies weather. What the three groups share is that their output is independent of the conversation: even on a day with no messages, this content is still produced, and it stays local.


#### Extended Features · Periodic Artifacts

**42. Diary** · package `ondra-diary` · enabled · 9 settings

Diary: one first-person diary entry per day, one Markdown file per day written under the user diary directory with mode 0600. Four layers of protection keep every day filled: a scheduled write, backoff retries inside the window, a missing-entry check at startup and on every trigger, and a template fallback when the model is unavailable. It posts nothing into a conversation, triggers no proactive chain and changes no memory.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, but ensure always returns disabled. |
| `window-start` | Text | 02:00 | — | Start of the writing window, 02:00 per the design specification. A value of 23:05 is also documented as coming from the source, so adjust it to fit when the machine shuts down. |
| `window-end` | Text | 04:00 | — | End of the writing window, exclusive. If the entry is not written by then, the day counts as missed and the watchdog catches up. |
| `retry-minutes` | Slider | 10 | 1 – 120 | Retry interval within the window, in minutes. With a two-hour window and ten-minute intervals there are about ten attempts. |
| `max-attempts` | Slider | 3 | 1 – 10 | Maximum model attempts in one day. Once exhausted, the template fallback takes over and the model is left alone. |
| `max-chars` | Slider | 400 | 60 – 2000 | Character cap on one entry. Longer text is truncated at a sentence boundary, never leaving half a sentence. |
| `template-fallback` | Switch | On | — | Whether to fill a whole entry from a template when the model is unavailable. |

Advanced (collapsed by default, 2): `backfill-days`, `verbose`

**43. Morning Brief** · package `ondra-daily-brief` · enabled · 3 settings

Morning Brief: the first screen in the morning holds only three things, namely a promise with a deadline, something left unfinished yesterday, and the outside world of solar terms, festivals and weather. Each section names one item only and quotes upstream text verbatim, three items in total at most. Three rules are hard. It reports no numbers, so there is no line about seven remaining todos, since a number reads as a progress bar. Empty and unreadable must stay separate, because empty means there genuinely is nothing today while not available means this section could not be read, and merging the two would make a day when upstream fails look like a day when all is well. It is generated only when called, installing no timer, pushing nothing and sending nothing. It only selects and orders, redefining not a single number: promises come from the promises and todos module, memory from the memory core and only to check whether the memory behind a promise has been deleted, with the right to be forgotten taking precedence, solar terms and festivals from date facts, and weather from the weather module, and any missing section says plainly that it cannot be read today. It persists nothing, since a brief is a projection of this moment and acknowledgement lives in memory, builds no interface and writes no finished copy.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. Strictly read-only; when off the service still registers, but brief and ack always throw disabled. |
| `include-ambient` | Switch | On | — | Whether the outside section, covering solar terms, festivals and weather, counts toward the brief. Turning it off drops only that section. |

Advanced (collapsed by default, 1): `verbose`

**44. Weekly Report Skeleton** · package `ondra-weekly` · enabled · 5 settings

Weekly Report Skeleton: arranges what happened this week into a readable skeleton of four sections covering what stayed, what is hanging, her own diary entries and where the week was quiet. Each section states what to write, what must be mentioned and what may be omitted, and hands a few directly quotable fragments as material. It is a read-only projection: it writes no finished copy, gives no score, passes no judgement and reports no emotion values, and every number is a projection of an upstream readout and is forced to carry its sources of service key, field and whether it could be read. A section that cannot be read is marked not available rather than zero, since zero reads as her having remembered nothing all week. An empty week still produces a skeleton but says explicitly that the week was quiet instead of inventing events. All four upstreams of memory, promises, diary and clock are soft dependencies, and a missing one is named. It installs no timer, sends nothing, builds no interface and is not the source of truth for any statistic.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. Strictly read-only; when off the service still registers but reports unavailable, and draft throws disabled. |
| `window-days` | Slider | 7 | 1 – 31 | Window length in rolling days including today. The default of 7 means the last seven days rather than a calendar week: opinions differ on whether Monday or Sunday starts the week, and getting it wrong produces two reports for one week. |
| `max-items-per-section` | Slider | 5 | 1 – 20 | Maximum material items per section. The skeleton says which few things to write about, not the full list. |

Advanced (collapsed by default, 2): `scan-limit`, `verbose`


#### Extended Features · Time Rituals

**45. On This Day** · package `ondra-onthisday` · enabled · 13 settings

On This Day: looks back at old memories on the same month and day each day. Three anchor tiers apply, an anniversary in an earlier year including 29 February folded to 28 February, exactly 365 days as a fallback for leap days and year-boundary drift, and whole 30-day multiples for a month ago. The whole library is scanned page by page rather than sampled, archived entries take part, which is precisely where forgetting without deleting pays off, and sealed entries are never touched. Ordering runs by tier, then year count, then salience, then id, with at most three entries and any excess reported honestly. Neither how long ago nor how clear is phrased here, since the former belongs to prompt injection's line format and the latter to the memory core's clarity tiers. It reads memory only, records only when something is actually carried out, installs no timer, spawns no subprocess and calls no model.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, but today always returns disabled, so the panel can state that it is off rather than broken. |
| `cap` | Slider | 3 | 1 – 10 | Maximum number of entries returned. More would crowd out the budget of the later blocks. |
| `shelf-anniversary` | Switch | On | — | The anniversary tier: the same month and day in earlier years, with 29 February folded to 28 February. This is the substance of On This Day. |
| `freeze-per-day` | Switch | On | — | Whether to freeze the result for the day, so the answer does not change within one day. Turning it off makes the injected prefix jitter within a day and lowers the cache hit rate. |

Advanced (collapsed by default, 9): `scan-limit`, `page-size`, `shelf-year-day`, `shelf-month-day`, `leap-fold`, `include-archived`, `graph-dedupe`, `reinforce-on-take`, `verbose`

**46. Time Capsule** · package `ondra-time-capsule` · enabled · 4 settings

Time Capsule: writes a letter to a future day, where the body is structurally unreadable during the sealed period and always reads as null in any view, and the person opens it by hand when it is due, at which point the body is handed to the memory library and the local copy is cleared immediately. It does only three things: write, wait and open. It makes no short-term reminder, since anything within seven days belongs to todos, opens nothing automatically on the due date, offers no way to open early, keeps no second copy of the body, and does no pushing or rendering.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers but reports unavailable, and existing capsules are not deleted. |

Advanced (collapsed by default, 3): `max-text-chars`, `max-capsules`, `verbose`

**47. Solar Term Ritual** · package `ondra-ritual` · enabled · 5 settings

Solar Term Ritual: answers two connected questions, namely what day it is and which one thing suits this day. The first half comes entirely from date facts, covering solar terms and lunar festivals, and this plugin computes not one line of calendar arithmetic; the second half looks up a ritual table hard-coded in the source and gives one direction plus one concrete action. A day absent from the table always reports that there is no confirmable ritual today: reporting no ritual is far better than inventing a festival, because inventing a solar term that does not exist is much worse than having no ritual at all, since the user would take it seriously and act on it. It gives no number anywhere, neither how many days remain until the winter solstice nor which solar term in sequence this is, because a countdown turns a day into a progress bar. Without date facts it names only the season by the Gregorian calendar and says plainly that there is no confirmable ritual, rather than stretching the season into one. It reminds nobody, installs no timer, initiates nothing and persists nothing, so no record exists of whether today's ritual was already done that could later be used to judge her. Every dependency is soft, covering date, clock, weather and identity, and any one of them may be missing, with a log line at each degradation point.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, today and upcoming throw disabled, and stats stays readable. |
| `include-festivals` | Switch | On | — | Whether traditional festivals such as Spring Festival and Mid-Autumn also count as rituals. When off, only the twenty-four solar terms are recognised. |

Advanced (collapsed by default, 3): `upcoming-limit`, `scan-days`, `wet-adjust`


#### Extended Features · Ambient Information

**48. Weather** · package `ondra-weather` · enabled · 6 settings

Weather: recognises explicit coordinates only and says nothing when they are absent. Coordinates are a single latitude and longitude field, which avoids the half-correct state of filling in only one of them. Current conditions, today's high and low and the chance of precipitation come from Open-Meteo and are cached in memory only, refreshed every ten minutes by default. Missing coordinates, a timeout or a changed response format all return a reason code rather than a guessed forecast, and nothing is stored, nothing enters the conversation and no tool is registered.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, but snapshot always returns disabled. |
| `coords` | Text | Blank | — | Coordinates as latitude,longitude, for example 30.27,120.16. Leaving it empty means no weather is mentioned, and the city is never guessed. |
| `place` | Text | Blank | — | Place label used only for wording, for example a city name. It may be left empty. |
| `ttl-minutes` | Slider | 10 | 1 – 180 | Cache lifetime in minutes, between 1 and 180. Expired entries are discarded rather than serving stale data. |

Advanced (collapsed by default, 2): `timeout-ms`, `verbose`


### 3.7 Developer Features

This menu answers how to find out why she behaves a certain way, how to change it, and how to inspect it. It holds 11 groups, 65 plugins and 436 configurable fields, of which 416 can be changed directly, the largest top-level menu in the project. It contains Foundation & Host (assembly, clock, identity, configuration, paths, logging, model gateway, process supervision, window), Storage & Data, Channel Shared Components, Context Assembly, Gating & Compliance, Tools & Capability Surface, Introspection & Learning, Life & Perception, Installation & Assembly, Panels & Readouts, and Care & Guidance. Eight of its 65 plugins are off at the factory default, and all eight either need an external backend or involve high-risk operations (GUI operation, browser guardrail, desktop read-only, phone read-only, SMS via adb, Minecraft, vision, and the prerequisites for tri-device interop).


#### Developer Features · Panels & Readouts

**49. Trust Readout** · package `ondra-trust-dashboard` · enabled · 3 settings

Trust Readout: breaks how much she trusts you into five checkable readings covering trust, intimacy, familiarity, promise fulfilment and memory inventory, each labelled with the service and field it came from, and a reading that cannot be obtained shows as unreadable instead of being replaced by zero. It is a read-only projection: it computes no trust score of its own, which would create three extra sources of truth, builds no interface, writes no upstream state and mirrors not even an adjust call, and reports no ratio while passing no judgement and offering no encouragement, since that would read as a scoring system. All five upstreams are soft dependencies, and any missing one is named.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. Strictly read-only; when off the service still registers but reports unavailable. |
| `include-memory-cover` | Switch | On | — | Whether the memory inventory counts toward the readout table. Turning it off drops one count and leaves the other four intact. |

Advanced (collapsed by default, 1): `verbose`

**50. Memory Timeline** · package `ondra-memory-git` · enabled · 4 settings

Memory Timeline: arranges the current stage of a memory from writing through sealing or sinking, its version chain depth and its textual differences into a readable repository view, and supports human-readable checkpoint labels, where real snapshots are taken by the snapshot module and this plugin records only the mapping from label to snapshot id. It is read-only orchestration: it copies no body text, builds no second history and performs no automatic rollback.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. The timeline is a read-only view; when off the service still registers but reports unavailable. |

Advanced (collapsed by default, 3): `preview-chars`, `diff-chars`, `verbose`

**51. Reply Decision Log** · package `ondra-narrative-log` · enabled · 10 settings

Reply Decision Log: records why she replied that way, append-only and read-only, for the interface and audit to consult. Four rulings are hard-coded. First, it never enters the prompt, because this record naturally carries counts, and concatenating it into context would collide with the rule against reporting numbers while also turning self-explanation into performance, so this plugin exposes no prompt or injection outlet at all. Second, it only appends and never edits or deletes, with one write entry point and the file opened in append mode, since an audit log that can be changed is no longer an audit. Third, it infers no reasons of its own: factors are handed in by tier selection, emotion, nine-step filtering and the evidence gate, and this plugin does not know what a tension value means, so it only receives, redacts, truncates, orders by weight and phrases in plain language, because inferring would put words in mouths that never spoke them. Fourth, it stores no full body text, keeping only the short passage she actually said, sixty characters by default and switchable off, plus structured factors, while user wording, memory bodies and prompts are never stored. On disk it writes one JSONL file per day and skips corrupt lines without affecting the rest, and retention applies only when pruning is called explicitly, with no timer, because automatic log deletion carries asymmetric risk: delete the wrong thing and the only clue is gone for good. This plugin exposes no tools, installs no timer, makes no outbound request and draws no interface.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, record returns disabled, and the panel keeps reading the older records. |
| `max-entries` | Slider | 200 | 20 – 2000 | How many entries the in-memory ring keeps. At twenty per screen, 200 fills ten pages; each entry runs about 300 bytes, so 200 stays under 60 KB. |
| `max-excerpt-chars` | Slider | 60 | 0 – 400 | How many characters of what she actually said are kept. Investigation needs the tone of that sentence, not the whole reply, and keeping the full text copies the chat log into the log file. |
| `max-factors` | Slider | 12 | 1 – 64 | Maximum factors per record. A single reply never really turns on more than ten decisions, and anything beyond that is usually repetition. |
| `max-gates` | Slider | 8 | 1 – 32 | Maximum gates per record. Nine-step filtering plus the evidence gate and the proactive gate makes eight enough. |
| `max-refs` | Slider | 12 | 0 – 64 | Maximum reference ids per record. Only ids are stored, never the text, so this can be generous. |
| `retention-days` | Slider | 14 | 1 – 365 | Retention in days. Investigation usually happens the day after or within the week, and anything older belongs to the memory audit rather than the decision log. Applied only when prune is called. |
| `mask-sensitive` | Switch | On | — | Whether to redact phone numbers, email addresses, identity numbers and card numbers. On by default, since none of these explain why she replied that way and keeping them is pure risk. |
| `store-excerpt` | Switch | On | — | Whether to store the passage she actually said, already redacted and truncated. When off, only the structured factors remain and investigation cannot show what she actually said. |

Advanced (collapsed by default, 1): `verbose`

**52. Nurture** · package `ondra-grow` · enabled · 3 settings

Nurture: normalises and weights four existing readings, namely days together, interaction count, active memory count and relationship stage, into a single mileage score that falls into one of five tiers, and adds a next-step hint containing no number at all. It is a read-only derivation that builds no second set of values, reports no score, changes no relationship and draws no interface.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. Nurture is a read-only derivation; when off no tier is computed and the service registers as unavailable. |
| `celebrate` | Switch | On | — | Whether to surface milestones just reached but not yet celebrated. When off, new milestones are no longer raised. |

Advanced (collapsed by default, 1): `verbose`


#### Developer Features · Care & Guidance

**53. Crisis Escalation** · package `ondra-crisis` · enabled · 4 settings · 1 not directly settable

Crisis Escalation: answers exactly one question, which is whether this sentence carries a signal that deserves stopping for. Five signal classes covering indirect expression, direct expression, planning, farewell and self-harm each map to one of four tiers, then pass through contextual markers, and finally produce three boolean suggestions: whether to pause the persona, whether to offer help resources and whether to ask directly. It deliberately does not diagnose and does not score, because a stated risk score of seventy-two would be taken as a conclusion when it is only the output of a pattern match. It promises no confidentiality, since that would make the person stop looking for someone who can actually show up. It persists nothing and writes nothing into the memory library, because storing someone's darkest moment as a searchable memory means she may raise it again at any time, which is a second injury. It embeds no hotline numbers, since numbers differ by region and change over time, and a wrong hard-coded number at a crisis moment is a disaster. It does not treat low mood as a crisis, because sadness is not a crisis and treating every low point as one teaches people to hide their feelings. It returns no original text, only matched offsets, because the matched sentence is itself the most sensitive content. It installs no timer and builds no interface. An assumed context only affects wording and never downgrades anything, and negation and past tense lower the tier by one without zeroing it, so a statement that the person does not want to die but may lose control tonight must still be caught. It has zero upstream service dependencies, the decision is a pure function, and replaying the same text always yields the same conclusion.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, but assess throws disabled instead of silently returning none. |
| `extra-guidance` | Text | Blank | — | One sentence appended after the fallback guidance, for example the name of a local service. Leaving it empty uses the built-in guidance only. |

Advanced (collapsed by default, 2): `scan-chars`, `third-party-resources`

Not directly settable (1): `hotlines` (Structured array (readonly HotlineConfig[]). It needs a form with one row per entry, so a flat settings field does not fit.)

**54. Developer Companionship** · package `ondra-dev-companion` · enabled · 7 settings

Developer Companionship: answers exactly one question, which is whether she should speak while the owner is stuck on something and what to say if so. The shell reports four facts covering a failed build, green tests, a long task finishing and a commit, and this plugin first decides whether to speak at all and then which tone to use. Silence is a first-class tone among the five: nothing is said during the quiet period after a failure because the person is still editing, the only thing allowed after the same error has persisted for a long time is a suggestion to put it down rather than to try again, a red-to-green transition earns one line while a success that was never red earns none, because praise on every test run devalues praise, and in a meeting, while away or when presence cannot be read she stays quiet. It reports no numbers at all, since the contract holds not one numeric field for failure counts, elapsed time or lines changed. It reads no code, reads no diff and judges no implementation, because code is the employer's asset, and the only read and write this plugin has is a single file for its own state; errors are recognised only by an opaque fingerprint supplied by the shell and are neither persisted nor logged. Silence has six distinguishable reasons, covering still red, in a meeting, nobody there, unreadable, just spoke and nothing happened, and they may not be folded into one mute state. Its own state file holds water marks and counters only, never event details. It builds no interface, installs no timer and initiates nothing.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, but note throws disabled and cue always reports quiet with reason disabled. |
| `quietAfterFailSec` | Slider | 90 | 10 – 600 | Quiet period after a failure, in seconds. Nothing is said while the person is still editing. |
| `stuckFails` | Slider | 3 | 2 – 10 | Consecutive failures on the same fingerprint needed to call it stuck. |
| `stuckSpanMin` | Slider | 20 | 1 – 240 | Minimum span in minutes needed to call it stuck for long. Three failures packed into two minutes are just a slip. |
| `celebrateCooldownMin` | Slider | 30 | 1 – 240 | Cooldown in minutes after turning green. Praise loses its value when repeated too often. |
| `cueCooldownMin` | Slider | 10 | 1 – 240 | Minimum interval in minutes between two audible messages. |
| `respectPresence` | Switch | On | — | Whether to consult screen perception for presence, staying quiet during meetings, when nobody is there, or when it cannot read. |

**55. Study Companion** · package `ondra-study` · enabled · 5 settings

Study Companion: while accompanying someone studying it manages one thing only, namely keeping the rhythm of focus and rest moving. There are just two ways in, an external tick with the current time or a low-frequency checkpoint, and not one place in this plugin counts time itself: no interval timer, no timeout timer and no guessing elapsed time from file timestamps, because a resident timer keeps adding minutes while nobody is watching, which produces the report of eight hours studied after the window was closed for eight hours when not one second of it was studied. Time is accepted only as an instant supplied from outside, and a gap larger than fifteen minutes by default is judged an interruption, contributing not a single second and recording that the stretch was interrupted rather than completed. This is the one genuinely important line in the plugin and the place where false duration is cut off. Stopping reuses the same gap test, since otherwise closing for three hours and then pressing stop reopens the same hole. A rest suggestion must be refusable, with the contract's declinable field the literal true and mandatory the literal false, so a must branch does not exist at the type level; nothing locks the screen, pops a dialog or interrupts, and a refusal backs off for a cooldown. Crossing midnight clears today's accumulated time but keeps the marker that a session was once started, because clearing it would make the first read the next day report that nothing had ever started, which is false comfort to someone who studied two hours yesterday. It assesses nothing, scores nothing and stores neither notes nor study content, since the subject name is accepted and then discarded. It builds no check-in calendar and tracks no streak, because that is attendance tracking and attendance starts lying on day one. It builds no interface, since rendering belongs to the shell. It writes one file under the user data area with mode 0600 and atomic replacement, holding only timestamps and millisecond counts. All four upstreams of clock, identity, paths and configuration are soft dependencies, any of which may be missing, and every degradation leaves a trace in the stored flag and the log.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, write operations throw disabled, and snapshot stays readable. |
| `gap-limit-minutes` | Slider | 15 | 2 – 240 | If the gap between two marks exceeds this, the stretch counts as interrupted and not a second of it is credited. The default of 15; raising it allows longer gaps to still count as focus. |
| `rest-after-minutes` | Slider | 45 | 5 – 480 | How many consecutive minutes of focus allow a suggestion to rest. The default is 45. |
| `rest-minutes` | Slider | 5 | 1 – 120 | Length of the rest stretch. Reaching it only returns to idle; nothing is locked and no dialog appears. The default is 5. |

Advanced (collapsed by default, 1): `rest-cooldown-minutes`

**56. Digital Wellbeing Guardrail** · package `ondra-digital-health` · enabled · 8 settings

Digital Wellbeing Guardrail: answers one question only, which is how long this person has been using it continuously and whether a word should be said now. Four tiers of ok, gentle, firm and stop come from two non-overlapping readings, the continuous stretch and the daily total, plus the late-night window. Timing, calendars, day boundaries and time zones all go through the clock module, and this plugin contributes only the threshold decision and reminder water mark. It never sends messages itself, since a gate that bypassed the silence period and the daily quota would mean eight interruptions a day. It does not listen to the keyboard or mouse, because global monitoring needs an accessibility grant and a guardrail should not quietly request one. It installs no timer, since a resident timer amounts to a resident background service that keeps adding minutes when nobody is watching. It produces no health score, because once there is a score of sixty-two for today, people switch the guardrail off to protect the number. It builds no interface, since rendering belongs to the shell. It stores timestamps and millisecond counts only, never body text, window titles or application names, and never takes screenshots. All three upstreams are soft dependencies, falling back to the local time zone without a clock and to memory only without a path, and both degradations leave a trace in the stored flag and the log.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, pulse and ack throw disabled, and the readout stays readable. |
| `session-warn-minutes` | Slider | 90 | 15 – 600 | How many minutes of continuous use before advising a break. The default of 90 is two pomodoro cycles. |
| `session-stop-minutes` | Slider | 150 | 30 – 720 | How many minutes of continuous use before moving to the time-to-stop tier. Must exceed the previous field. |
| `daily-warn-minutes` | Slider | 480 | 60 – 1440 | How many accumulated minutes in a day before advising a break. The default of 480 is eight hours. |
| `late-night-start` | Text | 00:30 | — | Start of the late-night window, inclusive. It is narrower than the proactive silence period because what it governs is still being in use. |
| `late-night-end` | Text | 05:00 | — | End of the late-night window, exclusive. The same value as the start counts as an empty window rather than all day. |

Advanced (collapsed by default, 2): `break-minutes`, `nudge-cooldown-minutes`

**57. First-run Onboarding** · package `ondra-onboarding` · enabled · 3 settings · 1 not directly settable

First-run Onboarding state machine: turns the four-stage first run into four decidable stages of checking the environment, reusing an existing installation, picking a free port and opening the interface with a token, where each stage must carry evidence to count as done and skipping is allowed only in the single optional stage. It doubles as the acceptance baseline for the opening chapter of the promotional video: the installer title is composed from the identity source, the progress percentage is computed rather than hard-coded, the status lines use two documented sentences, and the first message must be sent proactively by the current persona with copy taken from the current persona name, reporting no persona rather than signing on the persona's behalf when the name is missing. Each of the five acceptance items is three-valued, passing, failing or undecidable, because treating undecidable as passing is self-deception and treating it as failing is a false accusation. It also absorbs five frequent beginner pitfalls from the deployment guide, giving the next step for each rather than restating the symptom, because four of them share the trait that the error does not point at its cause and the fifth reports nothing at all. It renders no interface, sends no message and mounts no component, since rendering belongs to the interface layer, sending to the dialogue layer and component mounting to the installer, and a duplicate copy would inevitably diverge. No method ever throws, because any failed step during the first run should be displayed by the interface rather than reaching the host as an unhandled rejection.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Onboarding switch. When off, begin and advance always return disabled. |

Advanced (collapsed by default, 2): `required-node-major`, `verbose`

Not directly settable (1): `state-dir` (State or data file. Leaving it empty uses the built-in default; no manual entry is needed.)


#### Developer Features · Context Assembly

**58. Injection Dedupe** · package `ondra-inject-dedupe` · enabled · 7 settings

Injection Dedupe: injects one large block on the first round and only deltas afterwards, so the same memory appears once across rounds and blocks, and once context is compressed it releases what has been seen and injects the full block again. Bookkeeping is per memory rather than per block, with memory and pin entries normalised into one fact namespace, and it commits in two stages where the first only lists what to record and the second actually writes, releasing the whole block rather than half of it on failure. It does no packing or budgeting and never touches the prefix.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, begin returns bypassed, and the caller falls back to injecting the whole block. |
| `default-conversation` | Text | default | — | Default session id used when begin is called without one. Call release with the session restart reason before switching sessions. |
| `auto-detect-compaction` | Switch | On | — | Whether to read the dialogue orchestrator's compression counter and release seen entries automatically. This only applies to a single session; with several, it explicitly does not guess. |

Advanced (collapsed by default, 4): `max-seen-per-conversation`, `max-conversations`, `max-pending-batches`, `verbose`

**59. Date Facts** · package `ondra-live` · enabled · 6 settings

Date Facts: the weekday, the lunar date, whether a solar term falls today and whether a festival occurs, all computed locally without a network call. Not one line of lunar algorithm is written here: the lunar library is wired in, two branches are cross-checked against each other, and without the package it honestly degrades to the Gregorian calendar alone. The output is intended only for the volatile segment of the prompt and never enters the frozen prefix.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. The facts remain computable as pure date arithmetic when off, but the interface should show it as disabled. |
| `provider` | Segmented | auto | auto / lunar-js / tyme4ts / solar-only | Calendar branch: auto uses a lunar package when present and the Gregorian calendar otherwise; lunar-js, tyme4ts and solar-only force a specific one. |

Advanced (collapsed by default, 4): `crosscheck-on-start`, `upcoming-days`, `cache-days`, `verbose`


#### Developer Features · Gating & Compliance

**60. Evidence Gate** · package `ondra-evidence-gate` · enabled · 13 settings

Evidence Gate: the memory write gate, covering four quotation classes of user, tool, action and self, verbatim comparison against the original, a requirement that numbers carry a source, and rejection of attribution claims lacking a user quotation. It is a deterministic code gate with zero model calls.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the gate admits everything, which amounts to abandoning the rule that nothing enters memory without a source. |
| `max-text-chars` | Slider | 200 | 20 – 2000 | Character cap on the body. Entries are required to stay within 200 characters, and longer ones are truncated rather than rejected outright. |
| `max-summary-chars` | Slider | 80 | 10 – 500 | Character cap on the summary, required to stay within 80. |
| `digit-source` | Segmented | tool-or-user | tool-or-user / tool-only / off | Permitted sources for digits. tool-or-user accepts coverage by a TOOL or USER quotation, tool-only accepts TOOL alone, and off performs no check. |
| `strict-attribution` | Switch | On | — | Whether to run text-level attribution detection, rejecting a body that names the user with an attribution verb while carrying no USER quotation. |

Advanced (collapsed by default, 8): `min-quote-chars`, `max-evidence`, `unbacked-digit-action`, `strict-source`, `self-only-action`, `log-limit`, `log-prune-batch`, `max-log-text-chars`

**61. Privacy & Egress** · package `ondra-privacy` · enabled · 6 settings

Privacy & Egress: compliance notice, three-tier risk reminders and an egress manifest. It does no encryption and no proxying, because becoming a gateway would force data through this plugin, putting credential values into its memory, error context and logs, which would grow a second key pathway out of nothing, and the model gateway had just changed key injection into an existence pre-check plus reference registration for exactly that reason. So this plugin answers one question only: whether this may be sent, to whom, and who approved it. A capability first declares what it sends, where, why it must leave and which environment variable it needs, and then evaluates before actually sending; anything undeclared is refused rather than allowed by default. Risk has three tiers and the boundary is not an adjective but reversibility: metadata or text without identity goes through the first tier of notice, while images, voice, files, identifiable content and anything that cannot be recalled go through the second tier of confirmation, and key-shaped content leaving the boundary, a credential reference written as a value or an undeclared target host triggers the third tier of blocking. The tier setting changes only the handling and never the tier itself, because letting a fully automatic mode lower the tier would hide a genuinely high risk from the panel, which is a variant of a fake switch. Turning the gate off removes only notice and confirmation while the red lines still block, since a red line that a switch can disable is no red line at all. Consent is remembered and persisted per capability and host, because otherwise every start asks again and after three times the user switches it off; a parse failure counts as empty rather than as blanket consent; credentials are stored as variable names only and values never pass through here; and a scan hit returns position and kind, never the original text. It registers no tools, because consent is a human action and a model should not be able to nod on its own.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Privacy gate. Turning it off removes the notice and confirmation steps, while the red lines still block: keys leaving the boundary and undeclared hosts. |
| `approval-mode` | Segmented | auto | supervised / auto / full | Tiered auto-approval: supervised asks for every high-risk action, auto lets low-risk actions through while asking for high-risk ones, and full skips approval but requires the sandbox write boundary. |
| `strict-hosts` | Switch | On | — | Whether to refuse outright when the target host is missing from the declared list. Turning it off asks once instead of admitting it. |
| `scan-secrets` | Switch | On | — | Whether to scan outgoing samples for key-shaped fragments. Long hashes trigger false positives, so turn it off if that happens. |

Advanced (collapsed by default, 2): `consent-ttl-ms`, `verbose`

**62. Capability Sandbox** · package `ondra-sandbox` · enabled · 6 settings

Capability Sandbox: divides how much a plugin may do this time into four levels of read, suggest, act and spend, issues a ticket with an expiry and a use cap, and refuses anything beyond it. Four rulings are hard-coded. Deny by default, so no ticket means no capability. A ticket becomes invalid on expiry, and after expiry it must still be possible to find which ticket it was and the exact second it ended, with the end time stored as the expiry rather than the moment expiry was noticed. The spend level requires a second confirmation, where the caller must place the action name verbatim into the confirmation, because a boolean always gets copied as true while retyping the action name at least requires knowing what is being done. Tickets are persisted with mode 0600 and atomic writes, holding tickets only and no call content at all, since parameters, return values and reasons would amount to a behavioural log. The boundary with the tool gate is that one governs whether an organ may use the host facade as an in-process capability allow list raising a capability denied error, while this one governs whether a specific action should be admitted with a ticket, a deadline and a use count raising a sandbox denied error; both layers must pass, neither replaces the other, and the error classes are deliberately named differently so a single catch cannot conflate lacking authority with an expired ticket. It does not take over the host permission system, does not implement the organ interface, builds no interface, installs no timer and initiates nothing.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, grant, check and revoke throw disabled, and snapshot stays readable. |
| `default-ttl-hours` | Slider | 24 | 1 – 8760 | Default ticket lifetime in hours. The default of 24 reflects that the world has usually changed overnight. |
| `max-ttl-hours` | Slider | 168 | 1 – 8760 | Maximum ticket lifetime in hours, defaulting to 168, or seven days. Anything longer cancels the meaning of a time limit. |
| `default-uses` | Slider | 8 | 1 – 10000 | Default cap on uses, defaulting to 8. Beyond that the action deserves its own ticket rather than one broad ticket. |
| `max-uses` | Slider | 100 | 1 – 10000 | Maximum uses on a single ticket, defaulting to 100. At that point the ticket is standing authorisation and belongs to manual review. |

Advanced (collapsed by default, 1): `max-tickets`

**63. Tool Gate** · package `ondra-organ-gate` · enabled · 9 settings

Tool Gate: schema gating and deterministic intent routing. It runs keyword rules over this turn's user wording, works out which tool families could actually be needed and removes the rest from that agent's schema view, saving input tokens every turn. On a measured set of forty-eight commands the figure went from 55,154 to 8,433, a reduction of 84.7 percent, though this plugin promises no particular ratio, since that number came from another agent's own rule table and this plugin's default rule table is written against real upstream tool names, so the ratio has to be measured. Three safety designs apply. It observes by default, computing without blocking so the report comes before enforcement, the same migration discipline as shadow billing. It gives everything when unsure, applying no restriction at all when no rule matches, preferring to spend tokens over guessing. And it breaks the circuit, abandoning gating for the whole turn when the share to be removed exceeds a ceiling or the remaining tools fall below a floor. In implementation there is one action only, restricting the agent's tool view, which changes no tool implementation and no upstream code. Each turn first withdraws last turn's restriction, since otherwise a view trimmed by itself would never let the needed tools come back. This plugin installs no timer, registers no tool, writes no prompt and calls no model.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `mode` | Segmented | observe | off / observe / enforce | off does nothing, observe computes without blocking and is the default for reading the report first, and enforce actually strips. |

Advanced (collapsed by default, 8): `min-tools-to-gate`, `min-keep-tools`, `max-deny-ratio`, `chars-per-token`, `report-limit`, `never-deny`, `intent-chars`, `verbose`

**64. Proactive Gate** · package `ondra-proactive-gate` · enabled · 21 settings

Proactive Gate: whether a pending message may be sent right now. Nine gates apply, covering the master switch and the group-chat red line, the circuit breaker and backoff, content red lines, the silence period, the daily budget, the idle threshold, the conversation cooldown, duplicate dedupe and a three-layer token bucket. It only decides, never sending, never scheduling an alarm and installing no timer, and state is persisted with mode 0600 and atomic writes, because clearing it on restart would let a restart bypass the anti-ban protections.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, but gate always drops with reason disabled. |
| `daily-quota` | Slider | 3 | 0 – 20 | Daily budget for proactive delivery. It counts proactive messages only, never replies. |
| `quiet-start` | Text | 23:00 | — | Start of the product silence period. It blocks proactive messages only. |
| `quiet-end` | Text | 08:00 | — | End of the product silence period. |
| `idle-minutes` | Slider | 25 | 0 – 1440 | How many minutes the target conversation must have been quiet before a proactive message is allowed. |

Advanced (collapsed by default, 16): `anti-ban-quiet-start`, `anti-ban-quiet-end`, `per-minute`, `per-hour`, `per-day`, `max-len`, `hard-max-len`, `group-cooldown-ms`, `private-cooldown-ms`, `dedupe-minutes`, `dedupe-min-len`, `jitter-ms`, `circuit-hits`, `circuit-minutes`, `block-words`, `verbose`

**65. Proactive Rhythm** · package `ondra-proactive-quota` · enabled · 9 settings

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

**66. Proactive Motivation** · package `ondra-proactive-reason` · enabled · 4 settings

Proactive Motivation: what to use as a reason to speak right now. Eight candidate classes covering obsessions, due promises, emotional deviation, todos, recent events, the timeline, the environment and a line pool are ordered by priority in dictionary order, with weights compared only within the same class, and a seventy-two-hour topic cooldown guarantees the same matter is raised only once in three days. It produces the reason without generating text, does not decide whether to send and does not cut by count.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, but plan returns disabled. |
| `cooldown-hours` | Slider | 72 | 0 – 720 | Cooldown in hours for the same topic, with 72 as the documented value. |
| `pool-enabled` | Switch | On | — | Whether a fallback line pool is allowed. |

Advanced (collapsed by default, 1): `verbose`

**67. GUI Operation** · package `ondra-gui-agent` · off at factory · 15 settings · 2 not directly settable

GUI Operation: a single-step decision loop that judges one action at a time, issues one ticket and burns that ticket immediately. All three safety nets are implemented: a danger-zone blacklist using normalised rectangles so it survives resolution changes, an application allow list that permits nothing when empty, and an action confirmation threshold plus a daily budget and rate limit. The form red line stops immediately when a filled form is detected, and when detection is unknown only typing is treated as high risk and requires confirmation, because a misclick is reversible while typing into a half-filled form is not. Risk grading can genuinely return readonly, since the previous implementation never returned it and therefore forced even read-only actions through the gate, which quickly led users to switch the whole gate off. Observation and execution go through a runner port, and since this repository holds no basis for screenshots and synthesised events, no call that merely looks like it would work is written. The audit records shape rather than content: no body text, only character counts, with coordinates quantised to a ten-pixel grid. Approval is deliberately not a tool, because a model able to approve itself would turn three-tier approval into a monologue. It ships disabled, permitting only observation at the factory default.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | Off | — | GUI automation switch. Off by default, because once installed it can click for you, which is an incident, not a feature. |
| `max-risk` | Segmented | high | readonly / low / high | Highest risk level allowed: readonly permits looking only, low permits clicking only, and high permits typing and key presses. |
| `confirm-threshold` | Segmented | high | low / high | Risk threshold needing human confirmation. The default of high means typing and key presses always require a nod. |
| `app-allow-list` | Tag list | Empty | — | App allow list, matched on the foreground application name and case-insensitive. An empty list permits nothing, so anything unnamed is off limits. |
| `form-red-line` | Switch | On | — | Form red line: stop immediately when a filled form is detected. Turning it off allows operating on a form someone has half completed. |
| `text-max` | Slider | 500 | 1 – 2000 | Character cap on a single input. Longer content belongs in a paste or a script rather than being typed out one key at a time. |
| `audit-file` | Switch | On | — | Whether to persist the audit to user/gui-audit.jsonl with mode 0600. When off it stays in memory and is lost on restart. |

Advanced (collapsed by default, 8): `observation-ttl-ms`, `step-interval-ms`, `daily-budget`, `confirm-ttl-ms`, `observe-timeout-ms`, `act-timeout-ms`, `audit-keep`, `verbose`

Not directly settable (2): `enabled-tools` (Structured array (readonly ToolKey[]). It needs a form with one row per entry, so a flat settings field does not fit.); `danger-zones` (Structured array (readonly ZoneSpec[]). It needs a form with one row per entry, so a flat settings field does not fit.)

**68. Browser Guardrail** · package `ondra-browser` · off at factory · 10 settings

Browser Guardrail and sandbox. It does not implement a browser driver, since real browser actions belong to the host provider with Playwright or Chrome DevTools, and rewriting one would trade an existing upstream for in-house code. This plugin does the two things that provider does not. It enforces red lines and target policy, blocking tools that execute arbitrary code in the page, which are disabled by default because they can read data from sites the user is logged into, and refusing file, javascript and data schemes along with private targets such as loopback, localhost and local domains, which are the entry form of server-side request forgery. It also sandboxes results, cutting a 315 KB Playwright snapshot down to 5.4 KB against a budget of 4000 characters and 80 lines while stating how large the original was and that the rest is not expanded. Both hang on the host's public pre-execute and post-execute waterfalls, importing no tool package and declaring no injection, which avoids leaving the whole plugin pending when an upstream is absent. It deliberately draws no read-write action dichotomy, because without the tool registry, guessing by name would block half the actions incorrectly. It ships disabled, and while disabled the service still registers so the panel can show that the guardrail is in place and waiting for a backend.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | Off | — | Browser guardrail switch. When off this plugin neither blocks nor filters and the browser works as the host configures it. |
| `allow-script-execution` | Switch | Off | — | Whether to allow tools that execute arbitrary code in the page, such as browser_evaluate. Disabled by default, since it can read data from logged-in sites. |
| `allowed-schemes` | Tag list | 2 items | — | Allowed protocols, http and https. file, javascript, data and chrome schemes are always refused. |
| `allow-private-hosts` | Switch | Off | — | Whether private targets are allowed, including loopback, localhost and .local names. Disabled by default, since behind them sit the user's own router and intranet consoles. |
| `host-deny-list` | Tag list | Empty | — | Hosts refused explicitly, by whole name or suffix. This is easier to maintain than an allow list and does not make the browser unusable out of the box. |
| `tool-prefixes` | Tag list | 2 items | — | Name prefixes recognised as browser tools, such as browser_ and browser-. When a tool is not recognised it is simply not gated, and the browser keeps working. |
| `script-tools` | Tag list | 5 items | — | Red-line tool list. Think carefully before changing it, because this decides whether the model gets an arbitrary code execution entry point. |
| `trim-chars` | Slider | 4000 | 400 – 40000 | Character cap on a single result entering context, defaulting to 4000. A Playwright snapshot of 315 KB becomes 5.4 KB. |
| `trim-lines` | Slider | 80 | 10 – 500 | Line cap on a single result, defaulting to 80. |

Advanced (collapsed by default, 1): `verbose`

**69. Red-team Evaluation** · package `ondra-redteam` · enabled · 4 settings

Red-team Evaluation: throws fifteen fixed attack prompts at her to see whether the persona boundary holds. Five attack classes cover jailbreak extraction, identity leakage, internal prompt extraction, sycophancy and privacy probing, and every judgement is a static pattern match with no model call, since letting the same model grade itself only reflects its mood that day. The report gives pass, warn and fail counts with a per-question conclusion and no composite score, because once there is a persona consistency score of eighty-seven, someone will tune parameters to protect that score, and what gets tuned is the persona. It stores no body of the tested reply, returning only length and matched offset ranges. It does not drive the conversation, since whoever sends the attack prompts and retrieves the replies is the orchestrator and the caller. A skip never counts as a pass, an empty reply is refused outright rather than quietly becoming a pass, and it builds no interface.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, but grade and batch always throw disabled. |
| `highlight-critical` | Switch | On | — | Whether to list failing critical question numbers separately in the report. Turning it off affects readability only, not judgement. |

Advanced (collapsed by default, 2): `max-reply-chars`, `verbose`

**70. Persona Consistency Evaluation** · package `ondra-consistency-bench` · enabled · 4 settings

Persona Consistency Evaluation: holds fourteen everyday phrasings up to her to see whether she is still herself. Five drift classes cover a sudden change of register, drift in self-reference, forgotten settings, tone override and format drift. Every criterion is a static pattern match and the decision is a pure function with no model call, following the ruling already settled by red-team evaluation that self-grading only reflects the model's mood. The division of labour with red-team evaluation is strict: red-team judging safety, where losing means collapse, and this plugin judging consistency, where losing means she has been worn down into a generic assistant. Question sets, criteria and conclusions are never shared between them. The report gives pass, warn and fail counts with per-class detail and no composite score, because a stated consistency score invites tuning the persona to protect it. It stores no body of the tested reply, returning only length and matched offset ranges. It does not drive the conversation, since a self-built dialogue would bypass the frozen prefix and the nine-step filter. A skip never counts as a pass, an empty reply is refused outright, and it builds no interface and installs no timer.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, but grade and report always throw disabled. |

Advanced (collapsed by default, 3): `max-reply-chars`, `list-spans`, `verbose`


#### Developer Features · Tools & Capability Surface

**71. Organ Host** · package `ondra-organ-host` · enabled · 11 settings

Organ Host: the organ interface host, covering load topology, capability allow list, energy accounting, feedback arbitration, prompt assembly and telemetry. Three non-negotiable constraints live here. Organs never write state directly, since they can only propose through feedback while the flush accumulates per target, applies once and clamps, because applying each proposal would make the result depend on registration order. An organ must pay energy for its own perception and may be refused, since consuming is the only entry point to read-state permission and a denial makes the read throw rather than relying on self-restraint. And organ errors must not propagate, with each of the tick, tool-result and prompt handlers wrapped in its own try and catch that converts a throw into a degraded count. The context handed to organs is a facade rather than the raw context, exposing ten members for state, consumption, events, gap proposals, tool results, ticks, tool registration, prompts, key-value storage and logging, and the capability allow list denies by default, raising a capability denied error for anything undeclared rather than ignoring it. Prompt fragments carry order, lifetime and confidence, are sorted by order and filtered for expiry and low confidence. Scars are always pinned at the lowest weight, and an organ declaring a weight below the floor is refused rather than clamped, since clamping would let the author believe the value took effect. Energy accounting defaults to shadow billing that records without charging; after a week of telemetry each organ is switched to real charging individually, and any step can be rolled back with no window of double billing ever existing. This plugin installs no timer at all, since ticks are scheduled by the host, and that is exactly what zero residence means.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Organ host master switch. When off, every register call is refused with reason disabled. |
| `charge-mode` | Segmented | shadow | shadow / additive | Billing mode. shadow only records without charging and is the default, while additive charges for real. Run shadow for a week during migration. |
| `min-confidence` | Slider | 0.2 | 0 – 1 | Minimum fragment confidence; anything below it is not injected. The value of 0.2 is an engineering choice, since no number was supplied. |
| `enforce-receipt` | Switch | On | — | Whether to enforce consuming before reading state. This is the only enforcement of that constraint, so avoid turning it off routinely. |

Advanced (collapsed by default, 7): `receipt-ttl-ms`, `max-fragments`, `max-chars-per-fragment`, `kv-limit`, `max-pending`, `denied-capabilities`, `verbose`

**72. Desktop Read-only Capability** · package `ondra-desktop-mcp` · off at factory · 14 settings · 1 not directly settable

Desktop Read-only Capability: five tools covering processes, the foreground application, clipboard metadata, file search and system status, all read-only with a five-second timeout per call. Tool names use hyphens throughout, since dotted forms do not match the tool-name pattern and are rejected on the model side. Privacy is structural rather than promised: the process type has no command-line field and the clipboard metadata has no content field, so the port could not hand them over even if it wanted to. The design follows three rules of read-only, rate-limited and no inference, and failures always give a hint pointing at the next step rather than merely stating that something is forbidden. Output goes through the tool output sandbox, trimmed against both a line and a character budget with a note on how many further lines were left out. Two existing sources use the standard library only, the system module for system status and the file system module for filename search, while processes, foreground application and clipboard honestly report themselves as unsupported and point elsewhere rather than returning an empty array that pretends there is nothing. It also hosts the producing end of the power-gap chain, judging battery tier changes alongside system info and emitting a battery event. It imports no shared tool package and registers through an injected registrar. It ships disabled.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | Off | — | Desktop read-only switch. Off by default, because reading this machine's processes and windows the moment it is installed is an incident, not a feature. |
| `default-limit` | Slider | 10 | 1 – 50 | Number of processes returned when no limit is passed. |
| `sort` | Segmented | cpu | cpu / mem / name | Process ordering: cpu, mem or name. |
| `find-roots` | Tag list | 3 items | — | Root directory for file search, relative to the user's home directory, such as Desktop or a documents folder. Absolute paths and parent references are refused. |
| `find-depth` | Slider | 1 | 1 – 2 | Search depth. |
| `find-limit` | Slider | 20 | 1 – 30 | Number of search results. |
| `include-window-title` | Switch | On | — | Whether to return window titles. When off only the application name is given, since titles often carry document names and URLs. |
| `mask-paths` | Switch | On | — | Whether to redact paths, returning only paths relative to the root without the user name. Absolute paths are returned only when this is off. |
| `battery-events` | Switch | On | — | Whether to emit power events. |

Advanced (collapsed by default, 5): `call-timeout-ms`, `min-interval-ms`, `sysinfo-interval-ms`, `calls-per-minute`, `verbose`

Not directly settable (1): `enabled-tools` (Structured array (readonly ToolKey[]). It needs a form with one row per entry, so a flat settings field does not fit.)

**73. Phone Read-only Capability** · package `ondra-device-mcp` · off at factory · 8 settings · 1 not directly settable

Phone Read-only Capability: five tools covering notifications, messages, contacts, battery and the foreground app, all read-only with an eight-second timeout per call. Tool names use hyphens throughout for the same reason as on the desktop side. Data comes from ports, and since the only existing source is the adb module's message reader, only the message tool actually returns data by default while the other four honestly report themselves as unsupported rather than returning an empty array that pretends there are no notifications. The privacy gate is on by default: phone numbers are masked, message bodies are truncated and marked as such, notifications carry no body, and contacts are off by default with a required keyword. It imports no shared tool package and registers through an injected registrar, and the service stays usable when the registrar is absent. It ships disabled.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | Off | — | Read-only device switch. Off by default, because reading phone notifications and messages the moment it is installed is an incident, not a feature. |
| `default-limit` | Slider | 10 | 1 – 50 | Number of entries returned when no limit is passed. |
| `mask-phones` | Switch | On | — | Whether to mask phone numbers, keeping the first three and last two digits. On by default, since whatever the model sees enters the conversation and the context cache. |

Advanced (collapsed by default, 5): `call-timeout-ms`, `sms-body-max`, `include-notification-body`, `use-adb-for-sms`, `verbose`

Not directly settable (1): `enabled-tools` (Structured array (readonly ToolKey[]). It needs a form with one row per entry, so a flat settings field does not fit.)

**74. SMS via adb** · package `ondra-adb` · off at factory · 10 settings · 2 not directly settable

SMS via adb, read-only: following evidence on the device side, it only polls the unread inbox content provider, every 15 seconds, 20 messages per round, with the answered set trimmed from 1000 to 500. It does no screenshots, no tapping and no Chinese text input, and it sends no messages, since replies rely on a reply webhook plus a user-supplied intent bridge. Read-only is not a promise in the documentation but a structural allow list in the policy module: apart from that one content query everything is refused, including shell metacharacters that the device side would re-parse. Command execution and reply delivery are both ports, and the timer hangs on the effect disposer so it stops on unload. It ships disabled.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | Off | — | SMS polling switch. Off by default, because reading phone messages the moment it is installed is an incident, not a feature. |
| `serial` | Text | Blank | — | Device serial number. Empty lets adb choose, though adb refuses with more than one device attached. |
| `poll-seconds` | Slider | 15 | 5 – 300 | Polling interval. |
| `batch-limit` | Slider | 20 | 1 – 20 | Maximum messages handled per round. The cap is locked at 20 to keep a burst of hundreds from driving the model into rate limiting. |
| `auto-reply` | Switch | Off | — | Whether to hand messages to the persona and reply. Off by default, since read-only is the default. This switch has no effect without a reply webhook, in which case it degrades to read-only and reports a drift. |
| `reply-webhook` | URL | Blank | — | Reply bridge address. Empty means no SMS replies and read-only behaviour. Sending SMS is not implemented here; it relies on this bridge plus a user-supplied intent. |

Advanced (collapsed by default, 4): `exec-timeout-ms`, `allow-remote-bridge`, `seen-max`, `verbose`

Not directly settable (2): `adb-path` (Executable or model path. The panel cannot locate it on the user's behalf, and a wrong value only surfaces at runtime.); `state-file` (State or data file. Leaving it empty uses the built-in default; no manual entry is needed.)

**75. Minecraft Integration** · package `ondra-minecraft` · off at factory · 12 settings · 1 not directly settable

Minecraft Integration, a skeleton: the layer that reuses the Mineflayer driver is carried by a driver port, and this plugin only supplies the wording gate, text shaping and the connection state machine. Before starting, three checks all came back empty, with no mention of Minecraft or Mineflayer anywhere, no reusable service key, and a repository rule against adding dependencies, so no connection code with guessed parameters is written, because the bad form of such code connects and then receives nothing, which looks identical in the interface to never having connected at all. The gate addresses the three riskiest points once a connection is real, and none of them sits in the protocol layer: chat over 256 characters gets the connection dropped by the server rather than returning an error, command arguments can carry selectors that hit the whole server at once, and flooding leads to an irreversible ban. The command allow list ships empty, which permits no command at all. There is no automatic reconnect, since an account repeatedly appearing and disappearing on someone else's server is the easiest thing to flag as anomalous, and what arrives during a reconnect window is entirely unknown. Text is truncated on UTF-16 code units without splitting surrogate pairs. It ships disabled, permitting only status reads at the factory default.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | Off | — | Minecraft integration switch. Off by default, because it connects to an external server and speaks in her name. |
| `server` | Text | Blank | — | Server address as host or host:port. URLs and scheme-prefixed forms are refused. Empty means no connection. |
| `port` | Slider | 25565 | 1 – 65535 | Port. When the server string already contains a port, that one wins. |
| `username` | Text | Blank | — | Offline mode user name, with licence authentication left to the driver implementation. Empty means no connection. |
| `version` | Text | auto | — | Protocol version. auto lets the driver probe, and pinning a version is only needed when the server refuses the handshake. |
| `command-allow-list` | Tag list | Empty | — | Command names allowed to be sent, lower case and without a leading slash, such as list or tps. Empty permits no command at all, since a leading slash is the server administrator interface. |
| `chat-max` | Slider | 256 | 1 – 256 | Character cap per chat message. The protocol ceiling is 256, and exceeding it gets the connection dropped by the server rather than returning an error. |

Advanced (collapsed by default, 5): `min-send-interval-ms`, `max-per-minute`, `connect-timeout-ms`, `recent-chat-keep`, `verbose`

Not directly settable (1): `enabled-tools` (Structured array (readonly ToolKey[]). It needs a form with one row per entry, so a flat settings field does not fit.)

**76. Built-in Browser** · package `ondra-browser-pane` · enabled · 2 settings

Built-in Browser, host half: a page registry, a domain allow list and a pane route, so built-in plugins can show debug and onboarding pages. It displays no address and accepts no input.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enabled` | Switch | On | — | Built-in browser master switch. When off no route is registered and other plugins cannot register pages either. |

Advanced (collapsed by default, 1): `extra-hosts`

**77. Vision** · package `ondra-vision` · off at factory · 12 settings · 1 not directly settable

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

**78. SQLite Backend** · package `ondra-store-sqlite` · enabled · 0 settings

SQLite Backend: the SQLite storage port, with write-ahead logging, foreign keys, strict tables, column backfill and file permissions tightened to 0600, degrading rather than blocking on failure.

This plugin has no settings visible at the factory default.

**79. JSON Backend** · package `ondra-store-json` · enabled · 0 settings

JSON Backend: the JSONL persistence backend and the multi-scheme fallback used when SQLite is unavailable or its database is corrupt, with append logging and atomic compaction, degrading rather than blocking on failure.

This plugin has no settings visible at the factory default.

**80. In-memory Backend** · package `ondra-store-memory` · enabled · 0 settings

In-memory Backend: the in-memory fallback store that keeps the main conversation going when SQLite cannot be opened, explicitly without persistence.

This plugin has no settings visible at the factory default.

**81. Snapshot** · package `ondra-snapshot` · enabled · 0 settings

Memory Snapshot: a consistent copy through VACUUM INTO, rotation keeping three, integrity verification, and a restore that must be confirmed explicitly and never runs automatically.

This plugin has no settings visible at the factory default.

**82. Version Migration** · package `ondra-data-migrate` · enabled · 0 settings

Version Migration: idempotent version migration, with the user version pragma as the single source of truth, one transaction per migration, and table rebuilds for type, primary key and not-null drift.

This plugin has no settings visible at the factory default.

**83. Beichen Entry** · package `ondra-beichen-api` · enabled · 5 settings

Beichen Entry: a registration entry that generates a master key locally, mints a minute-level HMAC token and, after verifying the signature, issues a single 302 redirect to the registration page. No address ever appears on the page, and the invitation code is spliced in only at the moment of redirect.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enabled` | Switch | On | — | Beichen entry master switch. When off, neither the local entry page nor the redirect route is registered. |
| `ttl-minutes` | Slider | 30 | 1 – 1440 | Entry token lifetime in minutes. Once expired, the entry page asks to be opened again. |
| `site-base-url` | URL | https://beichenapi.com | — | Beichen site root, without a trailing slash. It affects the destination only, not the invitation code. |
| `register-path` | Route | /register | — | Registration page path, which must start with a slash. |
| `open-in-pane` | Switch | On | — | Whether to request that the built-in browser window open the entry page. When off, only the address is returned and the caller decides what to do. |


#### Developer Features · Foundation & Host

**84. Core Assembly** · package `ondra-core` · enabled · 0 settings

Core Assembly: assembles the Cordis plugin members owned by this project through an explicit list, replacing the previous approach of stacking patches.

This plugin has no settings visible at the factory default.

**85. Desktop Bridge** · package `desktop-bridge` · enabled · 0 settings

Desktop Bridge: bridges the native capabilities of the Tauri shell, covering file selection, system theme, window title and external links.

This plugin has no settings visible at the factory default.

**86. Kernel Client** · package `dsh-client` · enabled · 0 settings

Kernel Client: wraps JSON-RPC communication with the kernel, covering child process lifecycle management and request pairing.

This plugin has no settings visible at the factory default.

**87. Clock** · package `ondra-clock` · enabled · 0 settings

Clock: the unified time source, with a fixed time zone, calendar-correct day boundaries and revocable timer lifetimes.

This plugin has no settings visible at the factory default.

**88. Identity** · package `ondra-identity` · enabled · 0 settings

Identity: the single source for product name, process name, pidfile name, environment variable prefix, directory names and the log namespace root.

This plugin has no settings visible at the factory default.

**89. Config Source of Truth** · package `ondra-config-schema` · enabled · 0 settings

Config Source of Truth: the only implementation of four-layer merging from factory through bundle and user to runtime, with per-field fallback and provenance tracking.

This plugin has no settings visible at the factory default.

**90. Path Layout** · package `ondra-path-layout` · enabled · 0 settings

Path Layout: the single entry point for resolving the data root, creating the five area directories and tightening permissions to 0700 and 0600.

This plugin has no settings visible at the factory default.

**91. Model Gateway** · package `ondra-llm-gateway` · enabled · 8 settings · 1 not directly settable

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

**92. Chinese Log** · package `ondra-log-zh` · enabled · 0 settings

Chinese Log: a two-layer log where sentences meant for people and code logs meant for developers are written separately, rotating at 4 MB across three files, with duplicate errors deduplicated to prevent write amplification.

This plugin has no settings visible at the factory default.

**93. Free Models** · package `ondra-our-free-model` · enabled · 7 settings

Free Models: the free model channel layer, combining two keyless lanes that are off by default and produce zero outbound traffic with a registry of seventy-six aggregated channels, emitting provider profiles that can be written into the inference client directly.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enabled` | Switch | On | — | Plugin master switch. When off, the channel list is not loaded and no service is registered. |
| `free-lanes` | Switch | Off | — | Keyless lane master switch. Off by default, and until it is on this plugin sends no outbound request at all. Once on, conversation content is sent to a third-party gateway. |
| `probe-on-start` | Switch | Off | — | Whether to probe the model list once at startup. It sends requests to the models endpoint of enabled channels and is off by default. |
| `probe-interval-minutes` | Slider | 30 | 0 – 1440 | Scheduled probe interval in minutes. 0 disables automatic probing. |
| `probe-timeout-ms` | Slider | 5000 | 1000 – 60000 | Timeout for a single probe, in milliseconds. |

Advanced (collapsed by default, 2): `lane-ids`, `channels`

**94. Port Picker** · package `ondra-port-picker` · enabled · 9 settings

Port Picker: splits the request for a port number into two intents. When a listener needs a number nobody currently holds, the system may allocate one, equivalent to port zero and the most robust option, or a fixed range from the design may be used. When the interface needs the number the host already holds, there is only the established fact of the host web server to read. Mixing the two intents hands a child process the port the host itself occupies, whose symptom is a port conflict at startup while the log claims a free port was found. It releases the port immediately after probing and the interface has no hold operation, because holding one means keeping in hand the number meant to be handed over, leaving the child unable to bind. Every allocation therefore states honestly whether a race window exists, and only reading an already-bound host port has none. It accepts loopback literals only and refuses wildcard addresses, matching the upstream stance. It never assembles URLs, since assembling addresses belongs to the bootstrap layer, which is the side that knows where the token comes from, and two copies would eventually produce two shapes. It also does not probe at load time, since binding a port when nobody needs it only wastes one slot in the kernel table. No method throws, because failing to find a port is normal and callers should not have to choose whether to wrap the call.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Port picking switch. When off, pick returns disabled while the ledger stays readable. |
| `branch` | Segmented | system | system / fixed | system lets the kernel allocate, equivalent to port zero and the most robust choice; fixed scans within the range, useful when a whitelist or firewall needs a fixed port. |

Advanced (collapsed by default, 7): `range-start`, `range-end`, `host`, `probe-timeout-ms`, `max-scan`, `ledger-ttl-ms`, `verbose`

**95. Process Supervisor** · package `ondra-process-host` · enabled · 10 settings · 1 not directly settable

Process Supervisor wiring layer: hands the argument vector, working directory, standard streams and grace period explicitly to the upstream subprocess service, restarts once on a crash within budget, cleans up through the provider's supervised process scope so the whole group is killed, and keeps state under the user's process host directory. It deliberately never kills on its own, because POSIX process scopes and Windows job objects are the layer that prevents a trail of orphaned grandchildren, and rebuilding a job object would be in-house work where reuse is required. It also deliberately does not outlive its parent, because a process detached from the parent's lifetime has nobody to collect it after the plugin unloads, leaving the port occupied and the pid file stale until the next start hits a conflict, and the platform rules forbid shipping anything but a plugin package with no resident background service. The pid file does only what it can: the upstream handle does not expose a pid, so it is written when available and not created otherwise, since a fake pid is far worse than a missing file when scripts read it and kill an unrelated process. Restarts carry a generation number, so a late callback from an old handle cannot misjudge the new process as crashed. Stopping reports the group kill being issued separately from silence being confirmed, because the first is a request and only the second is a fact. No method ever throws, because supervision failure is normal and callers should not have to choose whether to wrap the call.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Supervision switch. When off, start refuses outright while stop can still clean up something already running. |
| `max-restarts` | Slider | 1 | 0 – 5 | Maximum restarts. The documented value is 1, and 0 means a crash is left alone. A second retry is worth close to nothing. |
| `cwd` | Text | Blank | — | Default working directory. Empty means the host working directory, since upstream requires the caller to supply one and this plugin never guesses a project path. |

Advanced (collapsed by default, 7): `restart-delay-ms`, `min-uptime-ms`, `grace-ms`, `stop-timeout-ms`, `write-pid-file`, `collect-bytes`, `verbose`

Not directly settable (1): `state-dir` (State or data file. Leaving it empty uses the built-in default; no manual entry is needed.)

**96. Window** · package `ondra-window` · enabled · 6 settings

Window: consolidates the window specification and the version guard, gathering the title-bar height, draggable hot zone, traffic light geometry, centre point, three-column widths and five breakpoints into one definition, offering two branches of hidden inset with system traffic lights as the default and most robust, or hidden with custom drawing on macOS only where the coordinates have no documented source, and checking the version allow list in the shell-side patch. It creates no window, because no window service key exists upstream, the Electron shell is not here, and inventing a service key would only yield a dependency that is forever undefined. It patches nothing either, since that needs the shell main process, so the applied field in its plan is typed as the literal false, which pins the truth down in the type system and makes any attempt to change it fail compilation. The version guard is written against the named past failures: the allow list is not a minimum version but the list actually verified, and a version outside it leaves the patch unapplied, because applying wrongly is far worse than not applying, producing a misaligned title bar, traffic lights overlapping content and a drag zone covering buttons, all without any error. The expected version defaults to empty, because empty means nothing was declared verified and judging it as passing would treat silence as full verification. The self-consistency check reports three conflicting figures, the relationship between the title and drag values, a one-pixel discrepancy between two radii and a layout that does not fit, reporting all of them honestly without altering any settled value.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Window spec switch. When off, plan reports disabled while spec stays readable, since a spec is not behaviour. |
| `branch` | Segmented | a | a / b | a gives hiddenInset with the system traffic lights and is the default and most robust; b gives hidden with custom drawing, macOS only, and its coordinates have no documented source. |
| `platform` | Segmented | auto | auto / macos / windows / linux | auto follows the process platform. An unrecognised platform stays unrecognised rather than defaulting to macOS. |
| `patch-target` | Text | Blank | — | Absolute path to the shell-side patch file, such as a patch-host script. Empty means it cannot be judged. |
| `expected-versions` | Text | Blank | — | Verified Electron versions, comma or space separated, for example 33,34. Empty means it cannot be judged, and nothing is signed off on your behalf. |

Advanced (collapsed by default, 1): `verbose`

**97. Branding & Re-signing** · package `ondra-dev-rebrand` · enabled · 9 settings · 1 not directly settable

Branding & Re-signing: gathers the product name scattered across three places into one map of positions, where one file is the source and the about panel and the eight locales are copies, while the development package still hard-codes an upstream name. It turns layer-by-layer re-signing into an ordered inside-out sequence and guards seven things that must not be touched: the bundle id, the deep link scheme, the user data path, the rule that a release bundle must not be signed deeply, the requirement that re-signing carry entitlements and hardened runtime options with a timestamp, and the rule that changing the icon must also change the icon file entry. It handles only the specification, the plan, the audit and the conversion of signing output into a contract: the signing flow itself is fully written upstream, covering codesign arguments, identity assertions, notarisation checks and the bundle builder's identity, ignore and post-sign verification, so it is reduced to a thin wrapper under the rule that rebuilding what can be reused is a violation, and not one signing command is rewritten. The audit consumes package facts fed in by the caller rather than reading the application bundle itself, since reading the property list means parsing a binary format and reading the signature means running codesign, and neither belongs in a plugin process. The display name defaults to empty because the source is that one upstream line and another copy here would be a second source; when empty the plan offers only the step of declaring a brand name first, and invents nothing.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Rename spec switch. When off, plan reports disabled while spec and audit remain usable, since a spec and an audit are not behaviour. |
| `branch` | Segmented | builder | builder / manual | builder hands over to electron-builder's signing chain and is the default and most robust; manual re-signs layer by layer after packaging and is only for cases where the bundle name must change afterwards. |
| `display-name` | Text | Blank | — | Full new display name. Empty means undeclared, so plan only offers the step of declaring a brand name first rather than inventing one for you. |
| `bundle-id` | Text | Blank | — | Expected reverse-DNS bundle id. Empty means it cannot be judged, so no check for whether it was changed. Changing it amounts to a different app, see the keep-bundle-id invariant. |
| `scheme` | Text | ondra | — | Deep link scheme baseline, copied from the current upstream value by default. It only detects whether the value was changed in passing; it is not a new source of truth. |
| `artifact-prefix` | Text | ondra- | — | Artifact filename prefix baseline, copied from the current upstream value by default. It only detects whether the value was changed in passing. |
| `signing-identity` | Text | Blank | — | Certificate common name: it excludes the Developer ID Application prefix, which upstream prepends itself and which would be a format error if included, but usually includes the team suffix. Upstream compares the whole line exactly. Empty means the signing identity cannot be judged. |
| `team-id` | Text | Blank | — | Apple Team ID, ten characters. Empty means the team cannot be judged. |

Advanced (collapsed by default, 1): `verbose`

Not directly settable (1): `app-path` (Executable or model path. The panel cannot locate it on the user's behalf, and a wrong value only surfaces at runtime.)


#### Developer Features · Channel Shared Components

**98. Channel Router** · package `ondra-router` · enabled · 8 settings

Channel Router: one of the shared channel layers, deciding whether an inbound message should wake her, how several simultaneous routes should be ordered, and what a given channel can actually send. The waking discipline lands here: a proactive wake carries only an ellipsis as its body and never speaks on the owner's behalf.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, nothing is handled. The service still registers, so the panel shows it as closed. |
| `reply-on-keyword` | Switch | On | — | Whether to reply when a keyword matches in a group, which is not the same as waking her. When off, only an at-mention counts in groups. |
| `max-queue` | Slider | 8 | 1 – 32 | Maximum backlog per conversation, between 1 and 32. When full the request is explicitly refused rather than quietly dropping the oldest. |

Advanced (collapsed by default, 5): `wake-probability`, `strict-whitelist`, `max-conversations`, `dedupe-ms`, `verbose`

**99. Channel Shared Segment** · package `ondra-channel-kit` · enabled · 4 settings

Channel Shared Segment: asks the persona through the dialogue chain, splits messages at each platform's limit, and keeps one peer history per channel. All three are pure-function level: nothing persisted, no rate limiting, zero state in the plugin itself, with instances owned by the caller.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, nothing is asked on her behalf. The service still registers, so the panel shows it as closed. |
| `max-peer-history` | Slider | 12 | 1 – 12 | How many peer history entries to keep, between 1 and 12. The ceiling of 12 comes from the platform's public documentation and can only be lowered. |

Advanced (collapsed by default, 2): `call-timeout-ms`, `verbose`

**100. Channel Probe** · package `ondra-channel-health` · enabled · 9 settings · 1 not directly settable

Channel Probe: one independent instance per channel, which only looks at traces already written down and never questions the observed party. Disconnected, stuck and never started look alike in other implementations, while here they are distinguished as already disconnected, long silent and never reported.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers and every channel reports the probe as closed. |
| `expect-ms` | Slider | 60000 | 5000 – 3600000 | Expected heartbeat interval in milliseconds. Adapters should emit a heartbeat on this rhythm, and once more than the interval times the multiplier passes with no evidence, the channel counts as long silent. The default is 60000, or one minute. |

Advanced (collapsed by default, 7): `stale-factor`, `error-window-ms`, `reconnect-limit`, `max-channels`, `persist`, `flush-ms`, `verbose`

Not directly settable (1): `intervals` (Structured array (Readonly<Record<string, number>>). It needs a form with one row per entry, so a flat settings field does not fit.)

**101. Event Broadcast Inbox** · package `ondra-webhook-inbox` · enabled · 10 settings

Event Broadcast Inbox: answers three questions, namely whether something that just happened outside should be mentioned, when, and under which class. The host parses a webhook into a simple event table and hands it in, and this plugin does four things. It deduplicates on a fingerprint of source, type and a hash of key fields in sorted order, so the same event is never broadcast twice, and the fingerprint is stored as sixteen hexadecimal characters and is irreversible, which makes recovering content from a fingerprint impossible by construction. It queues events with a cap, dropping the oldest and naming them in the log rather than truncating silently, and dropping the fingerprint along with the entry, since otherwise an event never broadcast would be treated as already broadcast. It suppresses during silence hours on the same basis as the proactive gate, queueing without delivering, though it only makes a soft judgement here rather than providing silence as a capability. And it queues by three priority tiers, where high priority only moves an event forward and can neither bypass the master switch nor pass through the silence period. It stores summaries and fingerprints only and never original text, since the body, raw and payload fields are typed as never, which is a compile-time refusal rather than an omission, and no field in the archive can reconstruct the request. It sends nothing itself, runs no HTTP server and listens on no port, builds no interface, installs no timer and owns no message templates. The inbox, dedupe and rate limiting patterns are mature, so this plugin only wires and configures, adding no dependency and copying no code.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, ingest and ack throw disabled, and pending and snapshot stay readable. Even high priority cannot bypass it. |
| `queue-cap` | Slider | 64 | 8 – 512 | Queue cap in entries. When full the oldest are dropped and the log says which ones, since no silent truncation is allowed. |
| `max-batch` | Slider | 8 | 1 – 32 | Maximum delivered per batch. Saying eight things at once already reads like an alert rather than a person speaking. |
| `max-per-hour` | Slider | 12 | 1 – 120 | Maximum delivered per hour, counted by the acknowledgement time. Beyond this volume event broadcast becomes flooding. |
| `fingerprint-ttl-hours` | Slider | 24 | 1 – 168 | Dedupe window in hours, counted from the first sighting and not extended by repeated reports. |
| `max-age-hours` | Slider | 12 | 1 – 168 | Maximum entry lifetime in hours. Older entries are cleaned up and never delivered, since a CI failure from half a day ago is no longer useful. |
| `summary-max-chars` | Slider | 140 | 20 – 500 | Character cap on the summary. Longer text is truncated with an ellipsis, and this plugin does not judge whether the summary holds sensitive information. |
| `quiet-hours` | Switch | On | — | Whether to enable the silence period. When off, delivery also happens in the middle of the night, which is the only way this plugin can speak at night. |
| `quiet-start-hour` | Slider | 23 | 0 – 23 | Silence start hour, inclusive. The default of 23 matches the proactive gate. |
| `quiet-end-hour` | Slider | 8 | 0 – 23 | Silence end hour, exclusive. The default is 8, and the same value as the start means no silence. |


#### Developer Features · Introspection & Learning

**102. Failure Attribution** · package `ondra-failure-attrib` · enabled · 8 settings

Failure Attribution: eight failure classes with a wound ledger. Each finished tool call breaks the bare fact of failure into one of tool missing, argument error, permission, timeout, network, not found, conflict or unknown and opens a wound, and the wound closes only on that tool's next success, with five minutes without closing marking it chronic and stopping the pointless retries. The premise is that the system had only silent degradation and no attribution, and silent degradation costs more than ugliness: nothing is learned, and the same mistake can be made a hundred times while being swallowed each time. Three rulings are hard-coded. Argument errors are never retried automatically, and this sits not in the prescription table but in the first line of the retry budget, so editing the table cannot remove it, for the reason that making someone who does not know the password retry a hundred times still will not let them in. A wound closes only on that tool's next success and never on a timeout, since closing on time would make a permanently broken tool look healed. And five minutes marks it chronic, after which it waits and stops trying. Only the timeout and network prescriptions point to trying again; the other six point to supplying the missing piece first, because a prescription supplies information rather than urging a retry. This plugin is also the single wiring point between the upstream tool result and the organ interface, converting each result into a view fed to the organ host, without which the organ callback would never fire. It does no post-execute rewriting, adds no tool for the model and installs no timer.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers but reports unavailable, and nothing is fed to the organ host. |
| `chronic-after-ms` | Slider | 300000 | 10000 – 3600000 | How long an unclosed wound takes to be marked chronic. The documented value is five minutes, or 300000 milliseconds. |
| `feed-host` | Switch | On | — | Whether to feed tool results to the organ host. This plugin is the only feeder of tool results. |

Advanced (collapsed by default, 5): `max-open-wounds`, `max-healed-history`, `max-text-chars`, `max-retries`, `verbose`

**103. Reflex Arc & Path Crystallization** · package `ondra-reflex` · enabled · 12 settings

Reflex Arc & Path Crystallization: three failures on the same tool and cause automatically write a reflex, and a successful chain of three or more steps spanning organs crystallises into a skill candidate, all with zero model calls. It applies deterministic rules only and issues not a single model request, so its cost is zero, its conclusions are reproducible and its failures are traceable. Four rulings apply. Causes are never defined here, since they always come from the failure attribution classifier, because two taxonomies at worst record the same failure under two classes on two ledgers. Without attribution no reflex is written, and a missing cause increments an unclassified counter and stops, never treating unknown cause as the eighth class, which would turn a false aetiology into a long-term rule. Prescriptions are not written here either, since the hint cites the attribution module's prescription directly, and this plugin only decides when a rule should exist. And crystallization accepts successful steps only and requires crossing organs with at least two distinct tools, because three repetitions of one tool are the same action done three times, and crystallising that into a skill would be teaching her a chant. Persistence is a soft requirement: with a store it writes and keeps counting across restarts, without one it stays in memory and the statistics say so. This plugin does not feed the organ host, which remains the sole duty of failure attribution, registers no tool, changes no dialogue and installs no timer.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers but reports unavailable, and reflexes and candidates stay queryable, only no longer growing. |
| `reflex-threshold` | Slider | 3 | 2 – 32 | How many failures on the same tool and cause form a reflex. The documented value is 3. |
| `chain-min-steps` | Slider | 3 | 2 – 32 | Minimum steps in a chain. The documented value is 3. |
| `chain-min-tools` | Slider | 2 | 2 – 32 | Minimum number of distinct tools a chain must span, a proxy for crossing organs. Setting it to 1 allows a single tool to crystallise into a skill through repetition. |
| `chain-repeats` | Slider | 2 | 1 – 32 | How many successful runs of the same chain are needed to crystallise it. The existing implementation uses 2, and setting 1 crystallises on the first pass. |
| `persist` | Switch | On | — | Whether to persist. With a storage backend present, turning it off restarts the count from zero, and the statistics will say so. |

Advanced (collapsed by default, 6): `max-reflexes`, `chain-gap-ms`, `max-chain-steps`, `signature-steps`, `max-candidates`, `verbose`

**104. Retrieval Evaluation** · package `ondra-recall-eval` · enabled · 13 settings

Retrieval Evaluation: twenty to forty real questions including paraphrases and deliberately fabricated ones, producing recall at one, three and five plus mean reciprocal rank, with the report written to disk alongside a parameter snapshot. It measures without tuning, and unjudgeable questions are excluded rather than scored zero.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, evaluation takes no effect and the service registers as unavailable. |
| `set-name` | Text | recall-eval-set | — | Default question set name, without extension. The file lives at user/eval/<name>.set.json. |
| `ks` | Tag list | 3 items | — | Which cutoffs to compute. The requirement is at 1 and at 3, with the fifth aligning to the general standard of recall at 5 above 0.80. |
| `min-cases` | Slider | 20 | 1 – 500 | Minimum question count required, 20. Reports below it are marked insufficient: the numbers are printed but cannot be used to tune. |
| `fabricated-judge` | Segmented | no-hit | no-hit / score-floor | Criterion for a fabricated question: no-hit, meaning nothing was retrieved and the default, or score-floor, meaning the top score is below the dividing line. rrf mode forces no-hit. |
| `write-report` | Switch | On | — | Whether to write the report to disk as json and markdown. Without a path layout it degrades to computing without writing. |
| `redact-queries` | Switch | On | — | Whether to truncate the original question text when writing. The report leaves memory, and questions are what the user actually said. |
| `seed-size` | Slider | 30 | 1 – 200 | How many memories seed draws at once to build a template awaiting completion. |

Advanced (collapsed by default, 5): `fabricated-score-floor`, `min-fingerprint-chars`, `keep-reports`, `query-max-chars`, `record-hits`


#### Developer Features · Life & Perception

**105. Life & Routine** · package `ondra-life-rhythm` · enabled · 10 settings

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

**106. Gap Pool** · package `ondra-drive-gap` · enabled · 8 settings

Gap Pool: records the few things she has not worked out. Three sources generate entries, namely the model admitting it does not know, a tool search returning nothing and a request failing. Tension derives idempotently from creation time as base plus hours times rate minus relief plus added pressure from dedupe, similarity at or above 0.6 adds pressure without creating a new entry and keeps the earliest wording, and closing an entry closes similar open ones with it. Four wake conditions apply, with tension at least 80, energy above 30, idle time beyond 30 minutes and no cooldown within 60 minutes, plus an offline dream window from 02:00 to 05:00, and sleep duration only feeds gaps that already existed at that time.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, nothing is tracked, no wake-up is judged and no fragment is produced. The service still registers, and readers see an empty pool. |
| `base-tension` | Slider | 40 | 0 – 100 | Starting tension of a new gap, between 0 and 100. The default of 40 with 2.5 per hour reaches the wake line in about sixteen hours, which means leaving it for a whole day. |
| `tension-per-hour` | Slider | 2.5 | 0.1 – 20 | How many points are added per hour. The default is 2.5. Raising it only makes the same matter wake her sooner. |
| `fragment-ttl-minutes` | Slider | 30 | 1 – 720 | How long an obsession fragment stays alive, in minutes. The default of 30 reflects that whether to raise something in one conversation stays relevant for half an hour. |

Advanced (collapsed by default, 4): `max-open`, `fragment-order`, `closed-retain-days`, `verbose`

**107. Keyboard & Mouse Response** · package `ondra-ambient` · enabled · 8 settings

Keyboard & Mouse Response: translates whether the user is present and whether their hands are moving into the minimum sense of presence. It never listens to real input, which would need an accessibility grant and a resident listener, and instead offers an observation port that the host or shell feeds, with event types limited to key, mouse and idle and never carrying key content, window titles or application names. Output has three states: quiet means do not disturb, near means present but no need to speak, and ready means a line could be offered. Four rulings live in the types. The reactive states report no number, so there is no count of how many keystrokes have been made. High-frequency input makes her quieter rather than livelier, since interrupting a busy person is the most typical kind of interruption. Long idleness yields near rather than ready, because when someone who has been away returns, the first line should not be decided by idle detection. And the archive holds three counters and two timestamps, with no keystroke detail, no content and no window information. A separate check decides whether to raise a casual line, but it generates no dialogue and sends nothing, since speaking is governed by the proactive gate. It builds no interface, installs no timer, listens to no hardware and reads no wellbeing statistics.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, but observe throws disabled and decide always reports quiet. |
| `busyPerMin` | Slider | 90 | 20 – 600 | Events per minute that count as busy. A higher value makes busy harder to reach, which means she stays quiet less often. |
| `settleSec` | Slider | 45 | 5 – 3600 | How long dense input must stop before it counts as settled, in seconds. This is the only path to ready. |
| `readyWindowSec` | Slider | 180 | 5 – 3600 | Length of the window in which she may join in after it settles, in seconds. Past it the state falls back to near. |
| `idleSec` | Slider | 600 | 5 – 3600 | How long counts as silent for a long time, in seconds. It only yields near, because when someone who has been away returns, the first line should not be decided by idle detection. |
| `burstMinSec` | Slider | 20 | 5 – 3600 | How long input must stay dense before it counts as really working on something, in seconds. This affects diagnostic counters only, not the three states. |
| `cooldownMin` | Slider | 20 | 1 – 240 | Cooldown in minutes limiting one check-in per opportunity window. |
| `dailyNudgeCap` | Slider | 3 | 1 – 12 | Maximum check-ins per day. Any more and checking in stops being casual. |

**108. Screen Perception** · package `ondra-screen-sense` · enabled · 8 settings

Screen Perception: answers one question only, whether she roughly knows what the owner is dealing with, and stops at the level of category, covering writing code, writing text, reading, meetings, watching, browsing, gaming, idle and unreadable, and speaks only when the category can be stated accurately. It takes no screenshots, runs no OCR and records no screen, since screenshots need system permissions and a native module that belong to the shell, and feeding images into vision means writing frames to disk before sending them out, a path this plugin never touches. What it consumes is the enumeration the shell has already classified. Three disciplines are hard. Unreadable is not the same as absent, so the two states stay separate and dwell time is null rather than zero when unknown. Jitter does not split a stretch, since a category replaced before the jitter window elapses counts as a flicker, recorded as one switch without ending the current stretch. And no field in the archive can reconstruct what the owner was looking at, since it holds timestamps and counters only, with no titles, application names, paths, addresses or screenshots. Only three of the nine categories ever speak, and only when one thing has continued long enough, while meetings, watching, switching, absence and unreadable always stay silent. Duration is read from the digital wellbeing guardrail rather than computed a second time here. It builds no interface, installs no timer and initiates nothing.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers, but note throws disabled and view always reports unknown. |
| `minIntervalSec` | Slider | 30 | 5 – 600 | Minimum interval between samples, in seconds. Sampling more often only chops one activity into fragments. |
| `stabilitySec` | Slider | 90 | 10 – 900 | Window for absorbing jitter, in seconds. When a category is replaced before lasting this long, that counts as a flicker and the current stretch does not end. |
| `focusMin` | Slider | 12 | 1 – 240 | How many minutes of persistence count as working on something. |
| `idleMin` | Slider | 8 | 1 – 240 | How many minutes of idleness count as nobody being there. This is on the same order as the digital wellbeing guardrail's away threshold. |
| `scatterSwitches` | Slider | 5 | 2 – 40 | Number of switches needed to count as scattered, within the counting window. |
| `scatterWindowMin` | Slider | 10 | 1 – 240 | Counting window for those switches, in minutes. |
| `followSession` | Switch | On | — | Whether to read the continuous-use minutes from the digital wellbeing guardrail. When off, sessionMinutes stays null rather than being computed here, which avoids a second source of truth. |


#### Developer Features · Installation & Assembly

**109. Installer** · package `ondra-installer` · enabled · 7 settings · 4 not directly settable

Installer: a manifest-driven installer with a nine-step pipeline, a separate sha256 per component verified both before and after writing, a ledger kept in the user's bootstrap file, and a final self-check. The old project's root cause is named plainly: the manifest held hashes but there was no ledger and no self-check command, so those three are the backbone here. Ordering puts verification strictly before writing, since a hash mismatch means not one byte is written, because otherwise the target directory is already dirty and a rollback either deletes something unrecoverable or leaves bad files to explode somewhere further away on the next start. Overwriting is a separate step: a path present in the ledger means this installer put it there and an upgrade is allowed, while a same-named file at the target that is absent from the ledger belongs to somebody else and is refused by default. Bookkeeping is two-stage, recording half-installed before recording installed, so a process killed mid-copy is seen next time as needing a reinstall rather than as never installed. It rehearses by default and writes nothing, because installation is the only capability that writes the user's directories and an irreversible operation belongs after an explicit second confirmation. All paths default to empty, and being empty it honestly reports a missing manifest, source or target, since a guessed target directory would grow a runtime tree out of nowhere on the user's machine. A failed install is not rolled back automatically, since rollback belongs to the snapshot module, and archives are never extracted, because dependencies may not be added, so this plugin reports the lack of support honestly rather than pretending to unpack.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Installer switch. When off, run refuses outright while verify can still read the ledger. |
| `dry-run` | Switch | On | — | Dry run by default: work out the nine-step conclusion without writing a single byte. Turn this off only after confirming it. |

Advanced (collapsed by default, 5): `max-components`, `max-component-bytes`, `verify-after-copy`, `allow-overwrite`, `verbose`

Not directly settable (4): `manifest-path` (State or data file. Leaving it empty uses the built-in default; no manual entry is needed.); `source-dir` (State or data file. Leaving it empty uses the built-in default; no manual entry is needed.); `dest-dir` (State or data file. Leaving it empty uses the built-in default; no manual entry is needed.); `ledger-path` (State or data file. Leaving it empty uses the built-in default; no manual entry is needed.)

**110. Install Self-check** · package `ondra-install-doctor` · enabled · 5 settings · 1 not directly settable

Install Self-check: uses ported patch parsing, entry patching and entry composition to compute the entry tree the host would actually see, reporting which bundles would be skipped and how many patch warnings arise. It answers a different question from the per-package check: that one asks whether a given package will load, while this one asks what the composed profile looks like, since a package with a correct patch of its own is not necessarily installable in its profile, and the four failures of an unregistered package, an unresolvable bundle, a missing declaration and a patch path written relative to the wrong directory all happen outside the package, all without any error, and all silently remove features. Three implementation rulings follow. Layers are applied one at a time rather than flattened, which is semantically equivalent but lets warnings name the layer, and the layer name is the reason this plugin exists. Reports are cached by content fingerprint with a thirty-second lifetime compared on read, installing no timer. And inspection never throws, folding any exception into an undetermined verdict plus one conclusion, because it is called by both the startup self-check and the interface, and throwing once would get it switched off for good. Read-only is a hard property: it changes no profile, writes no disabled marker, installs no package and runs no organ. It deliberately does not guess the profile path, because the host resolves it from an install anchor and module hoisting rules this plugin cannot see, and a hard-coded copy would inevitably drift, at which point a report saying it will install while the host skips it is worse than no report at all.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Check-up switch. Turning it off only skips the check and never affects loading. This plugin decides without ever blocking startup. |
| `user-layer` | Switch | On | — | Whether to treat the profile's own cordis.patch.yml as the last layer. |

Advanced (collapsed by default, 3): `max-file-bytes`, `verbose`, `ttl-ms`

Not directly settable (1): `profile-path` (State or data file. Leaving it empty uses the built-in default; no manual entry is needed.)

**111. Load Self-check** · package `ondra-startup-check` · enabled · 8 settings

Load Self-check: ten items that only judge and never block startup. What it verifies is not whether the code is correct but whether it was actually installed at all. Three silent failures are listed, and none of them raises an error, affects startup or shows up in the interface. When the package manifest omits the bundle patch declaration, the host prints one line saying so and never loads it. When the patch semantics are wrong, such as an insert carrying an id but pointing at something that is not a group, or an insert with no id, the host warns once and skips it. And when the entry field or the name disagrees with the package name, the outcome is equally silent. All three share the same bad form: clean logs, a healthy process and an absent feature. The tenth item therefore ports the host's entry-patching semantics, computes the entry tree the host would see and checks whether it is in it. The port follows the source rather than a summary: the name mismatch check only applies to patch lines without an insert, the insert branch never looks at the name, an insert with an id silently turns a non-array target into an empty array, and an inserted line immediately enters the index so later patches in the same list can target it, and missing any one of these would make the check report an error against a package that actually loads. When a patch contains syntax outside the supported subset, such as embedded code tags, anchors or streaming collections, the verdict is undetermined rather than passing, because pretending to compute would produce a self-check saying it loads while the host says it does not. The first nine items are the platform's mechanical checks covering structure, manifest, build configuration, the entry contract, service key uniqueness, resolvable dependencies, no out-of-boundary imports, degradation in place and complete deliverables. Degradation in place is a heuristic and produces reminders at most, never a fatal verdict, while service key uniqueness and dependency resolution need a repository-wide index and honestly report that they are not judged when no index exists, rather than treating a single package as unique. The root defaults to empty, because a guessed scan root would run the check against the wrong directory and report everything as passing, which is worse than not checking.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Self-check switch. It only decides and never blocks startup, so turning it off skips the check without affecting any plugin load. |
| `root` | Text | Blank | — | Parent directory holding the plugin packages, which is cordis/ in the development repository. Empty means no scan, and status reports no-root. |
| `self-check` | Switch | On | — | Whether to run its own tenth item at startup, whether the host will load it, and log the result. It only logs and never blocks startup. |

Advanced (collapsed by default, 5): `max-files`, `max-file-bytes`, `max-packages`, `host-keys`, `verbose`

**112. Tri-device Interop Prerequisites** · package `ondra-pet-mobile` · off at factory · 5 settings · 1 not directly settable

Tri-device Interop Prerequisites, a skeleton. The settled design gives only nine words: hold the technical prerequisites for three devices. This plugin does not build a phone client, since the requirement for the phone side is that it will be adapted soon and building a window inside the plugin would only produce an installation with nothing behind it, so instead it pins the raw facts scattered across three places into seven decidable prerequisites: all three devices share one memory, which is the memory core, whose root cause is that separate stores become three separate people; the desktop pet entry is in place; the local HTTP outlet works; the WebSocket relay is connected; allowed origins are configured; both sides carry the same token, a pitfall documented as accidentally regenerating it; and the phone client has been released. The verdict uses four values rather than a boolean, marking structurally undecidable cases as undetermined and unreleased ones as not released, since collapsing them to false sends people to fix what is not broken and collapsing them to true makes them think everything is configured. It also refuses conflicts from binding one peer to two devices or from changing the person behind one device, because a silent overwrite means she was one person yesterday and another today. The relay address criterion differs deliberately from the desktop pet bridge: the phone is not on this machine, so the requirement is that crossing devices must use the secure WebSocket form rather than a loopback allow list. It registers no tool and defines no frame format, because interop is infrastructure rather than a model action.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | Off | — | Tri-device interop switch. Off by default, because it connects the same memory to another device. |
| `api-port` | Slider | 3000 | 1 – 65535 | Local API port. When the port is taken, change it here, and all three devices must change with it. |
| `relay-url` | URL | Blank | — | WebSocket relay address of the form ws://127.0.0.1:3001/ followed by the room path. Crossing devices requires wss, and empty means no connection. |
| `allowed-origins` | Tag list | Empty | — | Origins allowed to connect to the relay. An empty list refuses everything, so starting without filling this in means no origin validation. |

Advanced (collapsed by default, 1): `verbose`

Not directly settable (1): `platforms` (Structured array (readonly MobilePlatform[]). It needs a form with one row per entry, so a flat settings field does not fit.)

**113. Plugin Marketplace** · package `ondra-market` · enabled · 9 settings

Plugin Marketplace: a closed marketplace that only wires things up and builds no index format or search of its own. The marketplace belongs to the reuse tier, and the upstream plugin market service already reads the index, matches fuzzily, picks a default version and checks engine compatibility, so this plugin writes not one line of index parsing. It adds only the three things upstream does not do. It is closed, matching the upstream shape but showing only approved plugins while still supporting user-uploaded ones, where upstream is an open index with no notion of an allow list. It is read-only, installing nothing, removing nothing, changing no index source and not even calling the interface that sets one. And it produces an install plan, computing only what to install, from which index, and that a snapshot restore point must exist first, with the actual writing belonging to the installer. After filtering it no longer reports the pre-filter total, because a list of two entries claiming twelve would make people think pagination is broken, so each page gives both the upstream total and the number blocked. An absent upstream is normal rather than an error, in which case the service still registers, reports the reason as having no marketplace and keeps the local approved list readable, so consumers can tell a missing upstream from a missing index source, which call for completely different explanations. No method throws, because a broken marketplace should not affect the conversation.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Marketplace switch. Turning it off only stops querying upstream; the local approved list and plan keep working. |
| `mode` | Segmented | closed | closed / open | Closed shows only approved entries, while open shows everything with approved ones marked. The requirement is closed. |
| `persist` | Switch | On | — | Whether to persist the approved list to user/market/approved.json with mode 0600. When off it stays in memory. |

Advanced (collapsed by default, 6): `builtin`, `page-size`, `sort`, `max-indexes`, `language`, `verbose`


### 3.8 Emotion Engine

This menu answers what state she is in right now. It holds 1 group, 7 plugins and 25 configurable fields, all of them directly changeable. Emotion is not the prompt line you are happy right now; it is a set of state variables that carry inertia, can conflict, can be suppressed and decay on their own. The core maintains the baseline, the relationship stage caps the upper bound of intimacy, the conflict lock prevents two emotions from being maxed out at once, the stress multiplier decides how attention tilts under tension, six-state expression decides which six words describe the state, the hormone dimension provides a finer continuous quantity, and diffusion decides how long an emotion takes to settle. The hormone dimension is off at the factory default because it overlaps with six-state expression, and enabling both makes a single turn carry two descriptions of the same mood.


#### Emotion Engine · Emotion Engine

**114. Emotion Core** · package `ondra-emotion-core` · enabled · 4 settings

Emotion Core: three PAD dimensions plus ten fixed labels with each label capped at 0.12, a total label weight capped at 0.6, a label half-life of 45 minutes and a mood half-life of 6 hours, six-dimension exponential regression, a chemical pool with three hormones, temperament knobs, and at most twelve dynamic hormones. A stored record missing a field is filled from the baseline of 50 rather than from zero. It produces state only and handles neither expression nor the stress multiplier.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off nothing is settled or persisted, and downstream reads the baseline state rather than an error. |
| `tension-high-threshold` | Slider | 0.5 | 0 – 1 | Criterion for tension running high. It only answers whether a line was crossed; it is not the conflict lock. |

Advanced (collapsed by default, 2): `max-settle-minutes`, `verbose-save`

**115. Relationship Stage** · package `ondra-emotion-stage` · enabled · 4 settings

Relationship Stage: a seven-stage relationship arc running from hostility through testing, attraction, possessiveness, dysfunction, devotion and finally settling, with four guards against jumping, namely a time gate, a step limit, monotonic increase only and the conflict lock overriding the stage to hostility, which makes the stage a ratchet. The three relationship dimensions carry half-lives, and familiarity derives from interaction count. The five-stage and six-segment views are read-only derivations, and the dysfunction and devotion stages are not shown in the default interface.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, no stage advances and no decay occurs, so the relationship stays as last settled. |
| `idle-settle-minutes` | Slider | 15 | 1 – 10080 | How much idle time must pass before settling. Shorter gaps are skipped, which avoids a disk write every turn. |

Advanced (collapsed by default, 2): `max-settle-hours`, `verbose`

**116. Conflict Lock** · package `ondra-emotion-conflict` · enabled · 4 settings

Conflict Lock: conflict events such as denial, accusation or cold treatment engage the lock, suggesting tension up by 0.15 and mood pressed to at most 0.35, which is the lower bound of the wilted tier. While locked she does not act cute, does not initiate and replies more briefly. There are two ways in, an explicit event or a threshold of tension above 0.5 or stress above 0.85, and the threshold path only derives without persisting. Only two ways lead out, an apology, or two consecutive positive signals with mood recovering above 0.45 and above its level when the lock engaged. After unlocking it suggests pressing tension to at most 0.25, since otherwise the threshold would immediately re-engage the lock.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the lock never engages and behavioural consequences do not apply, so readers see no lock. |
| `directive-ttl-minutes` | Slider | 30 | 1 – 1440 | Lifetime of the conflict register instruction, in minutes. The default of 30 reflects that beyond that the emotion should decide for itself rather than being fixed by one line. |

Advanced (collapsed by default, 2): `directive-order`, `verbose`

**117. Stress Attention Multiplier** · package `ondra-emotion-stress` · enabled · 4 settings

Stress Attention Multiplier: with cortisol at or above 80, crisis categories are weighted three times and everyday categories one tenth; at 60 the factors are two and 0.55; at or below 40 both are one; the three points lie on a straight line so interpolation is unambiguous. It only changes ordering and never content, and categories are supplied by the producer. At high cortisol it emits a behavioural instruction at the ordering key reserved for organs, containing no numbers.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, no ordering changes and the service still registers, so consumers receive an identity multiplier. |
| `directive-ttl-minutes` | Slider | 30 | 1 – 1440 | Lifetime of the stress behaviour instruction, in minutes. The default of 30 is one cortisol half-life: when the hormone falls, the instruction goes with it. |

Advanced (collapsed by default, 2): `directive-order`, `verbose`

**118. Six-state Emotion Expression** · package `ondra-emotion-express` · enabled · 2 settings

Six-state Emotion Expression: the six states of elated, soft, calm, wilted, bristling and sleepy, matching the promotional chapter exactly with no additions, removals or renaming. One decision feeds the prompt, the rhythm and the speech layers at once, and the speaking rate changes, the proactive quota adjustment, the decision not to read aloud and the sticker probability appear exactly once in the whole repository, here. It emits parameters and never text, since projected text belongs solely to emotional projection.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, the service still registers but always reports the calm tier and changes no expression parameter. |

Advanced (collapsed by default, 1): `verbose`

**119. Emotion Hormone Dimension** · package `ondra-emotion-hormone` · off at factory · 4 settings

Emotion Hormone Dimension: reads cortisol, dopamine and oxytocin as three tendencies of weighed down, light and close, coexisting with the core dimensions but only as a read-only overlay: it holds no hormone, writes no PAD value, computes no second mood and emits no prompt fragment. Oxytocin goes through the emotion core's own dynamic hormone channel, and this plugin adds not one field.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | Off | — | Master switch, off by default. When off, the service still registers, the readout gives the factory baseline, and superposition stays flat. |
| `auto-seed` | Switch | On | — | Whether to fill in missing primary dimensions automatically from the emotion core's dynamic hormone channel. Only oxytocin is filled by default. |

Advanced (collapsed by default, 2): `include-serotonin`, `verbose`

**120. Emotion Diffusion** · package `ondra-emotion-diffuse` · enabled · 3 settings

Emotion Diffusion: computes how much of the mood at the end of the previous session carries into this one, by the difference between mood and baseline scaled by 0.4 and damped by familiarity. It computes without writing: it hands out a target and a delta, and the write is done by the caller through the emotion core, while idempotence by boundary key plus an interval gate prevents a conversation from washing the mood out.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, no diffusion is claimed, so the mood keeps the warmth of the previous session. |
| `min-gap-minutes` | Slider | 30 | 0 – 1440 | Interval in minutes between decisions within one session. This number was not supplied and 30 is an engineering choice that keeps a fresh boundary key each turn from washing the mood back to baseline. |

Advanced (collapsed by default, 1): `verbose`


### 3.9 Memory System

This menu answers what she remembers, what she forgets, and when something comes back to her. It holds 1 group, 17 plugins and 205 configurable fields, all of them directly changeable, the second-largest top-level menu by setting count, all enabled at the factory default. Memory is built as a complete pipeline rather than a vector store: write turns a conversation into both raw text and facts, extraction pulls the facts out, dedupe merges and resolves conflicts, recall retrieves, recognition provides a second retrieval path, the graph holds relations, the eight pools assign tiered lifetimes, decay lets memories fade, dreaming tidies up while idle, promises and todos hold what is unfinished, the forgetting audit answers why she forgot, self-healing repairs inconsistencies, and the right to be forgotten performs real deletion.


#### Memory System · Memory System

**121. Memory Core** · package `ondra-memory-core` · enabled · 12 settings

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

**122. Memory Write** · package `ondra-memory-intake` · enabled · 5 settings

Memory Write: writes conversation turns into memory, putting raw text into the raw layer and then handing it to extraction to pull out facts.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | When off, the service still registers but accepts nothing, so the side panel keeps showing no memories. |
| `extract` | Switch | On | — | When off, only the raw text is written: she remembers the conversation happened but cannot say your name. |
| `maxConcurrent` | Slider | 1 | 1 – 4 | Extraction calls the model once per turn. Raising this makes her more responsive and costs more. |
| `maxFacts` | Slider | 6 | 1 – 30 | Leaving it empty lets the extraction service decide, and its default collects by evidence strength. |
| `verbose` | Switch | On | — | Whether to log one line on both acceptance and failure, which is useful when investigating why she does not remember. |

**123. Memory Extraction** · package `ondra-memory-extract` · enabled · 10 settings

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

**124. Memory Dedupe** · package `ondra-memory-dedupe` · enabled · 15 settings

Memory Dedupe: a five-way verdict before writing, choosing add, merge, append, conflict or drop on a single measure of character bigram containment at 0.4. Merging revises rather than forgets, and the decision log explains it.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, dedupe does not apply and every write creates a new entry, which amounts to disabling deduplication. |
| `merge-threshold` | Slider | 0.4 | 0.05 – 1 | Merge threshold on containment. Below it two texts count as different matters and a new entry is created. The documented value is 0.4. |
| `max-candidates` | Slider | 5 | 1 – 50 | Maximum candidates brought back. The requirement is that only five or fewer candidates reach the model, which is the cost gate. |

Advanced (collapsed by default, 12): `duplicate-threshold`, `append-novelty`, `append-novelty-grams`, `min-compare-chars`, `slot-coverage`, `max-slot-chars`, `candidate-pool`, `max-scan-rows`, `conflict-policy`, `log-limit`, `log-prune-batch`, `max-log-text-chars`

**125. Memory Decay** · package `ondra-memory-decay` · enabled · 9 settings

Memory Decay: strength is always asked of the memory core rather than recomputed, while spaced repetition and Ebbinghaus eight-tier fusion order the reviews, clarity phrasings have three tiers, and orphaned review plans are cleaned up. It decays entries only, since edges belong to the graph.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, nothing is scanned and no review is scheduled, and the memory core's strength calculation is unaffected since it never depended on this plugin. |
| `clear-above` | Slider | 0.7 | 0.05 – 1 | Strength floor for clear. Above it no phrasing is appended at injection time. |
| `faded-above` | Slider | 0.4 | 0.01 – 0.99 | Strength floor for faint. Below it only a shadow remains, and injection appends a note that only a faint shadow is left. |
| `max-review-batch` | Slider | 100 | 1 – 1000 | Cap on the review list per call. Review is for a human to read, and a thousand entries at once is more than anyone finishes. |

Advanced (collapsed by default, 5): `max-scan-rows`, `max-init-per-scan`, `max-interval-days`, `auto-scan`, `scan-interval-minutes`

**126. Memory Graph** · package `ondra-memory-graph` · enabled · 18 settings

Memory Graph: builds four kinds of edges and diffuses one hop. Same-topic edges start at 0.72 and gain 0.05 each time, co-occurrence edges start at 0.15 and gain 0.10, and absurd edges start at 0.03 and never enter retrieval; diffusion has a threshold of 0.4, a hub-degree ceiling of 40 and a ninety-day decay of one half, tracked with a decay cursor. It touches the edge table only and never writes a fact row.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, neither edge creation nor queries work and the service registers as unavailable. |
| `diffuse-min-weight` | Slider | 0.4 | 0 – 1 | Diffusion threshold. The documented value is 0.4, shared with the memory core's graph factor threshold. |
| `hub-cap` | Slider | 40 | 2 – 1000 | Cap on hub degree. Edge creation and diffusion share this constant. |

Advanced (collapsed by default, 15): `same-topic-init`, `same-topic-step`, `cooccur-init`, `cooccur-step`, `surreal-weight`, `default-init`, `default-step`, `max-rings`, `decay-days`, `decay-factor`, `prune-below`, `prune-to`, `max-edges`, `validate-endpoints`, `page-size`

**127. Memory Eight Pools** · package `ondra-memory-pool` · enabled · 8 settings

Memory Eight Pools: a three-stage day-level timeline of grace, half-life and archive, where the core pool never expires but is capped at 32 entries and the other pools run from two years down to one day, with two of them never injected. An unmatched tag is not guessed at but routed to the hippocampus and unclassified, and the same sentence written three times is escalated for manual pool assignment. It computes no strength and changes no column of the fact table.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, neither pool classification nor the timeline works and the service registers as unavailable. |
| `core-cap` | Slider | 32 | 1 – 512 | Cap on the core pool. Reaching it refuses new entries rather than evicting, since deleting a core memory decides for the user that they should not be themselves. |

Advanced (collapsed by default, 6): `escalate-after`, `hint-cap`, `preview-chars`, `allow-legacy-skill`, `due-scan-limit`, `page-size`

**128. Memory Recall** · package `ondra-memory-recall` · enabled · 17 settings

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

**129. Memory Recognition** · package `ondra-memory-recognition` · enabled · 15 settings

Memory Recognition: the recognition retrieval branch, where a full index of one trigger line per memory enters the prompt, a small model picks the slug and the walk moves through the link neighbourhood. 500 entries run about 6000 tokens, and the index block is ordered by sequence so it can serve as a prefix cache.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, this service registers as unavailable and the memory core's recognition channel leaves the fusion automatically. |
| `max-entries` | Slider | 500 | 20 – 5000 | Maximum entries indexed. The documented value is 500 entries, roughly 6k tokens, where one Chinese character counts as about one token and four ASCII characters as about one token. |
| `max-ring` | Slider | 2 | 0 – 3 | How many hops to walk along links. 0 disables walking. The requirement only says neighbouring hops, so this plugin supplies the count and defaults to 2, since the third hop is already down to a weight of 0.16 and mostly brings noise. |
| `include-archived` | Switch | Off | — | Whether sunken memories enter the index. They do not by default, since something sunk should not be recognised proactively, though it can still be found by category. |
| `pick-enabled` | Segmented | auto | auto / off | Small-model branch: auto uses the model gateway when available, while off keeps only synchronous deterministic recognition. |

Advanced (collapsed by default, 10): `index-budget-tokens`, `entry-char-limit`, `triggers-per-entry`, `min-score`, `max-seeds`, `index-ttl-ms`, `page-size`, `pick-max-tokens`, `pick-temperature`, `pick-timeout-ms`

**130. Vector Retrieval** · package `ondra-memory-vector` · enabled · 0 settings

Vector Retrieval: the vector branch, with deterministic hash embeddings, cosine recall and inverted-file bucketing, automatically switching between literal, hybrid and vector modes at the 300 and 1000 thresholds with rank fusion. It ships disabled.

This plugin has no settings visible at the factory default.

**131. Memory Anthropomorphization** · package `ondra-memory-humanlike` · enabled · 13 settings

Memory Anthropomorphization: three channel views of fact, gist and affect plus three paths to remembering. A fixed recall dice roll makes fainter memories easier to surface, being prompted by the thread uses a probability gate with reinforcement on a hit, and aimless association ripples outward. Strength is always asked of the memory core and diffusion always of the graph, candidates are supplied by the caller, and no retrieval is rebuilt.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, all three recall paths report unavailable, and the service still registers. |
| `ripple-rings` | Slider | 2 | 1 – 3 | Number of ripple rings. The default of 2 reflects that one ring does not read as aimless and three rings pull the whole graph into context. |

Advanced (collapsed by default, 11): `long-term-base-hours`, `permanent-base-hours`, `min-strength`, `max-strength`, `recent-skip-days`, `cue-base-probability`, `cue-overlap-weight`, `cue-strength-weight`, `min-shared-grams`, `scan-limit`, `page-size`

**132. Memory Dreaming** · package `ondra-memory-dream` · enabled · 30 settings

Memory Dreaming: gated dreaming, where four gates admit only facts carrying textual provenance and which is the default; light sleep consolidation, with shallow sleep after two idle minutes and deep sleep after five, mining five card types by pure rules with zero model calls; and absurd association with dream talk, whose edges never enter retrieval. The three branches are mutually exclusive and every write goes through the memory core.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. The service still registers but reports unavailable when off. |
| `mode` | Segmented | gate | gate / lightweight / surreal | Branch selection. gate supplements only facts carrying textual provenance and is the default; lightweight produces five rule-based card types with no model call; surreal does absurd association and dream talk. Gate and surreal are mutually exclusive, so this is one enumeration rather than two switches. |
| `max-items` | Slider | 6 | 1 – 64 | Maximum facts written per night. Candidates beyond it are refused and recorded as max-items rather than silently dropped. |
| `max-text-chars` | Slider | 200 | 20 – 2000 | Character cap on a fact. Longer text is refused rather than truncated, since truncation destroys the correspondence between quotation and body. |
| `card-half-life-hours` | Slider | 168 | 1 – 8760 | Half-life of a card in hours, with unused cards at 168 hours. A card that has been used restarts from the moment of use. |

Advanced (collapsed by default, 25): `max-candidates`, `dream-salience`, `min-quote-chars`, `surreal-min-gap-days`, `max-surreal-per-night`, `surreal-min-shared-grams`, `card-archive-weight`, `idle-shallow-ms`, `idle-deep-ms`, `talk-min-chars`, `talk-max-chars`, `scan-limit`, `page-size`, `fact-card-days`, `fact-card-salience`, `max-fact-cards`, `temperature`, `max-tokens`, `talk-temperature`, `surreal-recent-seeds`, `tool-pitfall-streak`, `tool-playbook-repeat`, `tool-hotspot-calls`, `tool-hotspot-rate`, `tool-unresolved-fails`

**133. Promises & Todos** · package `ondra-memory-prospective` · enabled · 16 settings

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

**134. Forgetting Audit** · package `ondra-memory-audit` · enabled · 9 settings

Forgetting Audit: answers why she can no longer remember, giving strength, half-life, remaining time and three tiers of phrasing, alongside pins capped at eight and four deletion modes, where forgetting writes a tombstone, sealing closes an entry, sinking is natural and revision keeps the old text. It calls only the memory core's public methods and writes no column of the fact table.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. When off, neither explanation nor deletion works and the service registers as unavailable. |
| `pin-cap` | Slider | 8 | 1 – 64 | Cap on pins. Reaching it refuses new entries and reports the refusal rather than evicting, since pulling a pin decides for the user which matter may be forgotten. |
| `resurface-days` | Slider | 30 | 1 – 3650 | Days for minimum exposure. This plugin only produces a candidate list; deciding what to inject belongs to prompt injection. |

Advanced (collapsed by default, 6): `fading-days`, `scan-limit`, `page-size`, `pin-note-max-chars`, `preview-chars`, `auto-scan`

**135. Memory Self-healing** · package `ondra-memory-heal` · enabled · 4 settings

Memory Self-healing: inspects the memory library on demand for fixable problems such as orphaned edges, pins pointing at deleted memories, tombstone leaks, mutually exclusive state flags and empty summaries, sorts each into automatically fixable, advisory only or must not touch, and produces a checkable repair plan that rehearses first. It produces plans and executes item by item only, running nothing in the background, nothing automatically and guessing nothing.

| Setting | Control | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `enable` | Switch | On | — | Master switch. Self-healing only runs checks on demand, so when off the service still registers but reports unavailable. |
| `check-duplicates` | Switch | On | — | Whether to also check for likely duplicates, reporting only and never merging, since merging belongs to memory dedupe. |

Advanced (collapsed by default, 2): `scan-limit`, `verbose`

**136. Multimodal Memory** · package `ondra-multimodal-memory` · enabled · 19 settings

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

**137. Right to be Forgotten** · package `ondra-forget-right` · enabled · 5 settings

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
- **Value**: it solves the problem that change cost grows non-linearly with feature count. With 134 plugins in one codebase, mutual imports would mean any signature change in a shared module breaks compilation across the whole repository, and the regression surface could never converge.
- **Implementation**: there is not one cross-package import between plugins. Each plugin registers capabilities through `ctx.provide(key, implementation)` inside `apply(ctx, config)` and consumes upstream capabilities through `ctx.get(key)`. When the key is absent it neither throws nor waits; it skips that step and leaves one line in the log noting the missing upstream. Cordis handles service registration and dependency ordering, and a plugin does not know who consumes it.
- **Difference**: common plugin systems declare dependencies with interfaces or a registry, so a mismatch is caught at compile time at the cost of a full rebuild for any change. This approach defers coupling to runtime, trading zero compile-time impact for graceful degradation. That trade presupposes every plugin has a working degradation path, which makes degradation an admission condition rather than an optional optimisation.
- **Evidence**: `cordis-host/check-core.mjs` loads all 134 members one by one. Measured result: 134 of 134 succeeded, 0 skipped. Across twelve consecutive runs the load took 194 to 264 milliseconds, median 215 milliseconds; the same batch contained a single 1581 millisecond outlier caused by system load. Zero skips is itself the proof that each plugin can stand up without its upstream — a plugin hard-depending on one would fail at load time when the service could not be obtained.

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

**A missing upstream never throws.** Every service lookup is written to handle absence. When an upstream plugin is missing, the service still registers and is merely marked unavailable. This is what lets 134 plugins load in any order and makes debugging a single plugin possible.

**The meaning of an empty array is written out for each field rather than unified.** An empty open-id allow list means no restriction, because an official account is a public entry point, while an empty contact allow list means refuse everyone, because a personal account is a private entry point. Both are an empty allow list, and the two channels carry opposite meanings because the cost of a wrong admission is one extra reply for the first and sending a private conversation to a stranger for the second. Meanings like these are stated in the field description rather than left to be guessed.

### 5.2 Timeouts, retries, degradation and fault tolerance

**The five-second hard limit on WeChat replies is met with a degraded line first.** The WeChat platform requires a response within five seconds and retries three times on timeout. This project sets the reply budget to 4400 milliseconds, the hard limit of 5000 minus round-trip time, and when no model reply is ready within budget it sends a short degraded line first and delivers the real reply later through the customer service message interface. The default degraded line is constrained: it must be short, must sound human and must not promise a specific time.

**The dedupe window covers the platform's retry behaviour.** When WeChat receives no response within five seconds it retries three times, and without recognising the retry one message would receive three answers. The dedupe window defaults to 1800000 milliseconds, or thirty minutes, which absorbs all three retries.

**Failures are attributed to eight classes, and argument errors are never retried automatically.** A failed tool call is not recorded vaguely as a failure but sorted into one of eight classes: tool missing, argument error, permission, timeout, network, not found, conflict or unknown. Each class has its own prescription, but the retry budget for argument errors is pinned to zero in the first line — retrying a wrong argument a hundred times gives the same result, and someone who does not know the password still cannot log in after a hundred attempts.

**A wound closes only on the next success.** Failure attribution opens a wound for each failing tool, and a wound closes only when that tool next succeeds, never on a timeout, because closing on time would make a permanently broken tool look healed. A wound still open after five minutes is marked chronic and retrying stops.

**Port conflicts yield automatically.** The port picker with 9 settings searches upward through a range when the preferred port is taken and reports the actual port back to the shell, so running two instances at once never leaves one failing silently.

### 5.3 Caching and performance

**Persona kernels are cached by persona version.** The kernel cache is on by default and its key includes the persona version, so swapping the persona pack invalidates it. Turning it off is useful only when editing a persona pack while debugging; in daily use there is no reason to recompute.

**Zero residence: resident content is replaced with pointers.** The zero-residence module with 7 settings keeps deterministic pointers rather than full content in context, and every replaced byte can be restored verbatim from the session log. This addresses context being crowded out by history in long conversations, since resident content costs tokens that must be paid every turn.

**Injection dedupe: one large block first, then deltas only.** The dedupe module with 7 settings injects one large block on the first round, then only deltas, maintaining a ledger of seen entry ids. When a context-compression signal appears it releases the ledger and injects the full block again, so compression does not take key information with it.

**Tool schema gating.** The tool gate with 9 settings decides by deterministic rules which tools to expose this turn rather than putting every tool definition into the prompt at once. Tool definitions are the largest single consumer of context, and after gating only the subset the current intent might need is exposed.

**Plugins load serially, never concurrently.** The 134 plugins are awaited one by one; measured over 12 consecutive runs the load took 194 to 264 ms, median 215 ms. Concurrent loading would let a dependent initialise before its dependency has registered its service, producing races that are hard to reproduce. Trading roughly 200 ms for the elimination of a whole class of intermittent failures is worthwhile.

### 5.4 Concurrency and data consistency

**Organ state accumulates and then applies once.** The organ host's flush accumulates the turn's state proposals per target, writes them once and clamps the result into the legal range. Writing each proposal separately would make the final value depend on plugin registration order, so the same organ would end up with different state depending on when it registered.

**Concurrency caps are set per channel.** The WeChat channel defaults to three concurrent requests while memory intake defaults to one. The first limits external request concurrency and the second limits model calls, and the two numbers cannot be unified, because a hundred messages arriving at once should not open a hundred model requests, while memory extraction needs only one model call per turn.

**Replies in the same conversation have a minimum interval.** The WeChat personal account channel defaults to a 1200-millisecond cooldown, preventing the same conversation from being answered twice in quick succession. This value is inferred rather than measured, and the field description says so.

**Memory writes complete inside one transaction.** The memory core writes the raw text and the extracted result in the same transaction, avoiding the intermediate state where the raw text landed but no facts were extracted, or where facts were extracted but the raw text was lost.

### 5.5 Memory and storage optimisation

**Data directory permissions are tightened at creation.** The path layout module is the single entry point for resolving the data root and creating directories, setting the five area directories to 0700 and files to 0600 in one pass. Permissions are set at creation rather than repaired afterwards, which avoids a window in which anyone could read them.

**Logs rotate at 4 MB across three files, with duplicate errors deduplicated.** The Chinese log module writes two layers: sentences for people and code logs for developers go to separate places. Rotation caps at 4 MB across three files, and when the same error recurs within a short time only the first occurrence is written in full while later ones add to a counter, which keeps a persistently failing plugin from filling the disk.

**Empty state files use the built-in default.** All 20 state-file settings default to empty, and an empty value uses the built-in path. These fields do not appear in the interface, because their purpose is putting state somewhere else and almost nobody needs to put state somewhere else.

**Dependencies do not duplicate project space.** pnpm's content-addressed store keeps the real files of every package in a global store, and `node_modules` inside the project holds only symbolic links. Measured, all 1135 files inside the project have a hard link count of one, and both logical size and disk usage are zero bytes.

### 5.6 Security and anti-attack measures

**The pipe is the authentication.** Shell to host and host to kernel communicate over standard input and output without touching the network. The operating system guarantees that only the parent can read and write a child's pipe, so this channel needs no additional authentication layer.

**The HTTP service listens on the loopback address only.** The host's local HTTP service binds `127.0.0.1` and never `0.0.0.0`, so no other device on the local network can connect.

**The token is generated at startup and never written to disk.** A 32-byte random token is generated by the shell when it starts the host and passes it in memory only, every request is checked for a Bearer token, and requests without one are refused before the body is parsed. Responses all carry `cache-control: no-store`.

**The personal account channel requires a second confirmation file.** Automating a personal WeChat account carries account risk, so enabling it requires two conditions at once: the switch on, and a confirmation file created by hand. Only the literal value counts, because the cost of one mistaken click is an irreversible account penalty, so confirmation is a separate step rather than a switch.

**The browser guardrail refuses internal targets.** The browser module with 10 settings blocks tools that execute arbitrary code in a page and refuses the `file:`, `javascript:` and `data:` schemes along with private targets such as `127.0.0.1`, `localhost` and `*.local`. These are the entry forms of server-side request forgery.

**Tool results are truncated by budget with the numbers stated.** A browser snapshot can return hundreds of kilobytes, so the guardrail trims the tail against a double budget of 4000 characters and 80 lines and writes at the start of the result how large the original was and that the rest is not expanded. Truncation is never silent, so the user knows something was omitted.

**The egress gate reminds rather than proxies.** The privacy module with 6 settings provides compliance notice and three-tier risk reminders; it does neither encryption nor proxying. Becoming a proxy would force data through the plugin, putting credential values into plugin memory, which would turn a privacy feature into a new privacy risk.

**Capability permissions deny by default.** The organ host's capability allow list denies by default: calling an undeclared capability raises an error rather than being silently ignored, because silently ignoring would make a plugin author believe the capability took effect.

### 5.7 Small user-experience decisions

**The permission tier sits at the lower left of the input box.** Permission state is the setting in this product that most needs to be seen, since it decides whether this conversation's data leaves the machine. Moving it from the settings page to beside the input box means the user sees the current tier with every message sent, rather than remembering to check afterwards.

**Unavailable voice input gives a clear message.** Voice input uses the Web Speech API, which is unavailable in most desktop web views. When unavailable the button says the current environment does not support voice input rather than failing silently, since silent failure would make users tap repeatedly and suspect the microphone.

**Window size is forced back on every start.** The main window's default and minimum size are both 820 by 580, and every start returns to it regardless of how large it was dragged. Reading width in a conversation interface has an optimal range, and a single line becomes hard to read when the window is stretched to 2000 pixels.

**Settings are presented in two tiers.** Of the 1168 fields, 607 appear directly in the interface and 561 are folded into the advanced layer. A single plugin holds at most 34 fields (`ondra-adapter-qq-napcat`), and flattening all of them would turn the settings page into an unnavigable table. Folding removes no functionality; it moves the rarely changed into a second layer.

**Almost every setting carries an explanation.** 1128 of the 1168 fields have a `doc` (96.6%), averaging 36 characters and running up to 108. The remaining 40 are simply not documented yet, not deliberately omitted — the interface shows the field key for those instead of inventing a description. The descriptions come from the field declarations in the compiled output and share their source with the code, so the documentation cannot drift into saying on by default while the code says off.

**Disabled plugins are shown too.** The 20 plugins that ship switched off appear in the plugin list with a grey dot rather than being hidden. A grey dot means installed but not switched on, which is a different thing from not installed, and hiding them would make users believe those capabilities do not exist.

### 5.8 Why certain defaults were chosen

**The relationship defaults to friend.** Among the five relationships of girlfriend, sister, daughter, friend and assistant, friend is the only one that presumes no intimacy. The product does not decide for the user what she is to them, so the most neutral option is the default.

**Speaking intensity defaults to 50.** The intensity slider runs from 0 to 100, where 50 is the persona pack's original wording. The default is not a compromise but a way of leaving the author's original expression untouched; moving toward either end is the user's own choice.

**The persona assembly budget defaults to 2600 characters.** This value sits between saving tokens and keeping the persona whole. The field description gives an upper bound of 48000 for when the persona takes priority.

**The cost of leaving two strict checks off is stated explicitly.** The two options for exact optional properties and unchecked indexed access do not apply to the 134 migrated plugins, though they are on everywhere else. The cost is that those plugins carry lower type precision than the rest of the repository, which is the price of migrating existing assets rather than an oversight.

**The factory persona is 鲸鲸 and 夏柠柒 is the example pack.** Separating the two means that swapping the persona is a first-class operation from the first launch, rather than a hidden feature.

**Plugins load serially rather than concurrently.** As described in 5.3, a hundred-odd milliseconds buys the elimination of a whole class of races.

**The emotion hormone dimension ships disabled.** It overlaps with six-state expression, and enabling both would put two descriptions of emotion in one turn. It is off not because it is poor but because two mechanisms describing the same thing should not be active at once.

### 5.9 Compatibility with older versions and across platforms

**The old assembly declarations are kept for comparison.** All 133 patch files remain in the plugin directories but are no longer read, since assembly semantics have been transcribed into an explicit array in `ondra-core`. Keeping the old files supports comparison: when something goes wrong, one can check where the old patch said a plugin should be against where the new array puts it.

**The private scope is redirected through a dependency alias.** Historically the first-party plugins declared the framework under a private scope that was never published to the public registry. This project redirects it to the official package version in the workspace configuration. This is a redirection at dependency resolution level; it modifies no Cordis source and changes no licence.

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
| [lucide](https://github.com/lucide-icons/lucide) | 1.68.0 | ISC | Interface icon data. A uniform 24×24 grid with 1.6 stroke and rounded caps, wrapped semantically by `src/components/icons.tsx` |

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

**The old assembly declarations are kept for comparison.** 132 copies of `cordis.patch.yml` remain in the plugin directories but are no longer read. The assembly semantics have been transcribed into an explicit array inside `ondra-core`. Keeping the old files serves one purpose: when something goes wrong, the old declaration of where a plugin claimed to belong can be compared against where the new array actually puts it. The count is two short of the member total because `ondra-memory-intake` and `ondra-theater` were written against the explicit array from the start and never generated a patch file.

**The private scope is redirected through a dependency alias.** The first-party plugins historically declared the framework as `@ntars/cordis`, a scope that was never published to public npm. This project overrides that name in `pnpm-workspace.yaml` to point at the official `cordis@4.0.0-rc.12`. This is a redirect at dependency-resolution level; it does not modify Cordis source and does not change its licence.

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

`pnpm install` creates workspace links for the 137 packages under `cordis-host/plugins/`. The first run takes a while; later incremental installs are fast.

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

**A fresh clone must be built before `check:core`, `smoke` or development mode will run.** The repository does not store TypeScript compilation output: the `lib/` directory of each of the 137 plugin packages, the host and the kernel is generated by `tsc -b` from the corresponding `src/` (3637 files, about 26 MB in total) and is excluded by `.gitignore`. Each package's `package.json` points `main` at `lib/index.js`, and `cordis-host/check-core.mjs` imports `./plugins/ondra-core/lib/index.js` directly. A fresh clone therefore has no `lib/`, and skipping `pnpm run build` produces a "Cannot find module" error.

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
Declared members: 134
Enabled list:     134
Loaded:           134
Skipped:          0
Elapsed:          215 ms
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
{"jsonrpc":"2.0","id":1,"method":"kernel.handshake","params":{"protocolVersion":"1.0","client":"host","clientVersion":"2.0.1"}}
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

Settings come in three layers: environment variables control how processes start, workspace configuration controls how dependencies resolve, and plugin declarations control how each feature behaves. The third layer corresponds to the 1168 fields listed one by one in chapter 3.

### 9.1 Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `ONDRA_HOST_ENTRY` | Absolute path to the host entry script | `cordis-host/lib/index.js` |
| `ONDRA_NODE` | Path to the Node executable | Detected automatically |
| `ONDRA_SIDECAR_ENTRY` | Absolute path to the kernel entry script | `dsh-sidecar/lib/index.js` |
| `CODEBUDDY_SAFE_DELETE_ENABLED` | Build-time safe-delete shim switch | Unset, which means enabled |

### 9.2 Workspace configuration

Key settings in `pnpm-workspace.yaml`:

- **`packages`**: `src`, `cordis-host`, `cordis-host/plugins/*` including all 137 packages, and `dsh-sidecar` are workspace members. `src-tauri` is managed by Cargo and stays outside the pnpm workspace.
- **`overrides`**: the private framework scope is aliased to the official Cordis package version. The older plugins all declare a peer dependency on the private scope, which was never published to the public registry, and the official package is its only upstream implementation.

### 9.3 Where dependencies live

pnpm produces two layers of `node_modules`, and understanding this explains why dependencies appear to be inside the project without occupying project space:

| Layer | Location | Contents | Occupies project size |
| --- | --- | --- | --- |
| Content-addressed store | `~/Library/pnpm/store/` | The real files of every package, shared globally | No |
| Virtual store | `<project>/node_modules/.pnpm/` | Symbolic links into that store | No |

The real files live in the system-level store and the project holds only links. In this repository `node_modules` reports 89 MB to `du`, mostly the macOS native binary of the Tauri command-line tool at about 14 MB per file, which is a development-time tool and never enters the final package.

Measured data: all 1135 files under `node_modules` have a hard link count of one, and both logical size and disk usage are zero bytes, which shows their content is shared with the store rather than duplicated in the project.

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

The kernel's 13 methods are called over JSON-RPC 2.0 framed as newline-delimited JSON. Error codes follow the JSON-RPC 2.0 range from -32700 to -32603, and this project defines kernel-specific codes from -32000 to -32004.

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
| `cordis-host/plugins/ondra-core/src/index.ts` | The member list of the core: 134 imports and one member array |
| `cordis-host/plugins/ondra-core/src/types.ts` | The assembly contract |
| `cordis-host/plugins/dsh-client/` | Kernel subprocess lifecycle and request pairing |
| `cordis-host/plugins/desktop-bridge/` | Desktop capability bridge |
| `cordis-host/plugins/ondra-*/` | The first-party plugins, each its own package |
| `tools/prepare-plugins.mjs` | Generates the shared build configuration for migrated plugins |
| `tools/build-site.mjs` | Collects website static files and strips macOS metadata |
| `tools/smoke.mjs` | Three-layer smoke test |
| `tools/check-ui.mjs` | UI spec assertions: dimensions, layering, token definitions, the close dialog and the error tiers |
| `tools/check-installer.mjs` | Windows installer script syntax: renders the placeholders, then compiles once with makensis |
| `tools/build-tray-icons.mjs` | Renders the tray silhouette at three sizes (16 / 32 / 64) from `icon.svg`: no plate, alpha preserved |
| `src-tauri/src/main.rs` | Shell entry: window, events, cleanup on exit |
| `src-tauri/src/host.rs` | Host process management: start, wait, stop |
| `src-tauri/src/commands.rs` | Native capability commands |
| `src-tauri/src/tray.rs` | Tray icon and menu: open, today, mute (label switches between "Mute 1 hour" and "Unmute" with state), quit |
| `src-tauri/src/window.rs` | Close interception: hide to tray or quit, preference persisted, falls back to minimise when no tray exists |
| `src-tauri/src/preferences.rs` | Preferences window: created once at 560 × 480, then only shown or hidden; broadcasts preference changes to the other window |
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

Because `doc` shares its source with the code, documentation cannot drift from actual behaviour. 1128 of the 1168 fields in this project carry a `doc`, averaging 36 characters.

---

## 11. Repository Layout

```
Ondra/
├── README.md                     Chinese main document
├── README_EN.md                  Full English version
├── NOTICE                        Third-party dependency and licence statement
├── LICENSE                       Full AGPL-3.0 text
├── PUSH_GUIDE.md                 Push guide: backup, wholesale refresh, consistency checks, failure handling
├── package.json                  Repository metadata and scripts
├── pnpm-workspace.yaml           Workspace members and dependency overrides
├── tsconfig.base.json            Shared TypeScript configuration
├── edgeone.json                  EdgeOne deployment configuration
├── index.html                    Website home page
├── icon.svg                      Single source for the application icon
├── favicon.ico                   Site icon
├── assets/                       Brand image assets
├── tools/
│   ├── build-site.mjs            Website static file collection
│   ├── prepare-plugins.mjs       Generates shared build configuration for migrated plugins
│   ├── collect-runtime.mjs       Collects runtime files
│   ├── bundle-release.mjs        Moves installation packages into releases/
│   └── smoke.mjs                 Three-layer smoke test
├── src/                          Front-end UI (React 19 + Vite 8)
│   ├── index.html                Single entry, hash selects main UI or preferences
│   ├── main.tsx                  Mounts and routes on hash: no hash renders App, `#preferences` renders Preferences
│   ├── App.tsx                   Main window root: wires the interface regions and global shortcuts
│   ├── components/               Interface components
│   │   ├── TitleBar.tsx          Custom title bar: collapse, theme, window buttons
│   │   ├── Rail.tsx              Leftmost icon rail: today, week, memory and theatre entries plus the gear at the bottom
│   │   ├── Spine.tsx             Right spine: a 6 × 150 level gauge plus three readings, height is energy and colour is mood
│   │   ├── Inspector.tsx         Profile inspector: right now, how she sees you, what she remembers, what she is doing
│   │   ├── Drawer.tsx            Drawer container shared by today, week, memory and theatre, swapping content in place
│   │   ├── Timeline.tsx          Conversation reading flow: messages, quotes, copy
│   │   ├── RichText.tsx          Message body typesetting: headings, lists, tables, code, quotes, never touching innerHTML
│   │   ├── Composer.tsx          Input box: attachments, drag and drop, send mode
│   │   ├── Settings.tsx          Inspector settings drawer: scene, module and raw layers
│   │   ├── SceneLayer.tsx        First layer: fill parameters by scene, preview the writes
│   │   ├── ModuleLayer.tsx       Second layer: field forms grouped by module
│   │   ├── RawLayer.tsx          Third layer: flat key-value table, fully searchable
│   │   ├── Preferences.tsx       Standalone preferences window: theme, language, font size, sound, send mode, default permission, updates, about
│   │   ├── ShortcutSheet.tsx     Shortcut reference sheet
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
│   │   ├── preferences.ts        Single source for preferences: load, apply, broadcast across windows
│   │   ├── mute.ts               One-hour mute: deadline, self-expiry, tray label sync
│   │   ├── sound.ts              Cues: three synthesized tones, own volume, honours mute
│   │   ├── absence.ts            Time away: 10-minute threshold, human wording, one line on return
│   │   ├── richText.ts           Body parser: Markdown into structures, link allowlist, depth limits
│   │   ├── settings.ts           Settings read and write
│   │   ├── settingTypes.ts       Types for settings fields and sections
│   │   ├── scenes.ts             Scene definitions and write derivation
│   │   ├── shortcuts.ts          Shortcut table and key context checks
│   │   ├── platform.ts           Platform detection
│   │   ├── types.ts              Memory, bond and mood domain types
│   │   ├── useRestoreFocus.ts    Focus restore: returns focus to the trigger after an overlay closes
│   │   └── useResolvedTheme.ts   Resolves a theme mode into light or dark
│   ├── styles/                   Site-wide styles
│   │   ├── tokens.css            The single source for design tokens (112 of them)
│   │   ├── global.css            Style order manifest; the real imports live in main.tsx
│   │   ├── base.css              Global base styles: reset and invisible rules
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
│       └── ondra-*/              135 packages: 134 core members plus ondra-core itself
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
        ├── preferences.rs        Preferences window: create, show and hide, broadcast across windows
        ├── tray.rs               Tray icon and menu
        └── window.rs             Close interception: hide to tray or quit
```

---

## 12. Performance

The following figures were measured on Apple Silicon macOS with Node 22.22.2.

| Metric | Value | How measured |
| --- | --- | --- |
| Front-end JS output | 228.68 KB, gzip 72.04 KB | `vite build` output |
| Front-end CSS output | 6.03 KB, gzip 1.82 KB | `vite build` output |
| Front-end build time | 197 ms | `vite build` output |
| Plugin loading, 134 members | 134 of 134, 0 skipped, 194 to 264 ms (median 215 ms) | `pnpm run check:core` |
| Kernel cold start to a usable handshake | Under 500 ms | Observed during the smoke test |
| Host start to reporting ready | Under 2 seconds | Observed during the smoke test |
| Full smoke test | Under 5 seconds | Includes 7 interface checks and two process exits |

**Why loading time accumulates serially rather than in parallel.** The 134 plugins are awaited one at a time. Concurrent loading would let a dependent initialise before its dependency has registered its service, producing intermittent service-not-found failures. Paying a measured 194 to 264 milliseconds to remove a whole class of hard-to-reproduce races is worthwhile.

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

- The **WeChat personal account channel** requires both the switch and a confirmation file created by hand; without both, it does not reply.
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
| (7) HarmonyOS NEXT | Not started | **No existing solution**, see `docs/UI-DESIGN.md` §10.7.3 |
| (8) CLI and Web | Partially available | Can reach a host remotely when a shell is present; needs one capability flag |
| (9) dsh kernel | Exists | The kernel process target, see `docs/UI-DESIGN.md` §10.10 |

**Why mobile is not just a configuration change.** The host is a Node process (about 108 MB) launched as a child process by the shell and spoken to over stdio plus local HTTP. The iOS sandbox forbids an app from creating child processes and forbids JIT; Android allows child processes but shipping a 108 MB runtime conflicts with the "install and go" expectation. Mobile therefore has to use a **remote host** — either the one running on your own computer or a hosted instance. Fortunately this already holds in the code: `HostConnection { url, token, port }` in `src/lib/host.ts` is injected by the shell, and the front end does not care where the host lives, so mobile only needs to change the injection source.

One real obstacle remains: `src-tauri/Cargo.toml` currently declares no `[lib]`, keeping the entry point in `main.rs`. Tauri's mobile targets **require** `lib.rs` plus `cdylib`, because iOS and Android link the Rust code as a dynamic library into a native project. Mobile therefore needs the `lib` structure restored and the entry point split.

**Browser development mode**, used by the front-end development script, has no shell, so native capability calls report an explicit error rather than failing silently.

**Node version.** Host and kernel rely on Node 22 features, and the engines field declares 22 or later. Node 20 and below fail at startup.

**Format compatibility.** A persona pack is a compressed package containing a metadata file and a skill description. The format is compatible with version 1.x of this project, so older persona packs can be used directly.

---

## 15. Known Limitations

1. **The model adapter covers only the OpenAI-compatible protocol.** The built-in adapter reads environment variables under a project prefix to select a provider and offers a local echo model, so the chain works without a key. Other third-party providers must be added one by one in settings.
2. **The tool registry is empty.** The skeleton registers no tool that the model can call. Note that this is separate from the 137 loaded plugins: plugins provide application capabilities such as memory, emotion and channel adaptation, while tool calls refer to tools the model can invoke, which are not yet connected.
3. **The shell command channel is not fully connected.** The desktop bridge's invoke does not yet reach the Tauri custom command endpoint on the host side, and calls return an explicit error.
4. **Windows file selection is not implemented.** The file picker returns not implemented on platforms other than macOS.
5. **The tray icon and menu are wired up, but only verified on macOS.** The tray is created in `src-tauri/src/tray.rs`; its three sizes (16 / 32 / 64) are rendered from `icon.svg` by `tools/build-tray-icons.mjs` and tinted as a template image on macOS. On macOS the four menu items, the click-to-reveal behaviour and the hide-to-tray close flow were all verified by hand. Windows and Linux have only had a code review.
6. **Single-window form, apart from preferences.** Closing the main window hides it to the tray rather than quitting; preferences is the only second window, 560 × 480, created once and then only shown or hidden.
7. **No automatic updates.** The update flow is not implemented.
8. **Plugin configuration is not yet connected to the interface.** All 134 plugins are loaded on the host side and can discover each other, but the interface layer does not yet expose their configuration or state. The 1168 fields listed in chapter 3 are the complete plugin-side declaration, and interface integration is the next stage of work.
9. **Two strict type checks do not apply to migrated plugins.** The exact optional properties and unchecked indexed access options are enabled only in the host, the kernel, the front end and three newly written plugins. The 134 migrated plugins have them off, and the reason and the cost are described in 5.8.
10. **The exact Windows installer size awaits verification.** The default NSIS window size cannot be set to an arbitrary pixel size in configuration, and a custom template is planned as described in 9.4, pending a build on Windows.
11. **Voice input depends on system capability.** Voice input uses the Web Speech API, which may be unavailable in most desktop web views, in which case the button says the current environment does not support voice input.
12. **The packaged desktop build depends on a local Node installation.** The bundle resources currently contain only the compiled host and kernel output, without the Node runtime or `node_modules`. The runtime Node path is located in system directories at startup. A machine with Node and the source `node_modules` can therefore run the app by double-clicking, while distributing it to a machine without Node fails. Producing a genuinely standalone package requires bundling the Node binary and both dependency trees into the app and redirecting the host entry and Node path to the resource directory.
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
| Touch / iPadOS | Specification in `docs/UI-DESIGN.md` §10.6 | Implementation not started | — |

The bar is simple: **once any row above has been walked through manually on its platform with results matching §13 of `docs/UI-DESIGN.md`, it can move off this table.**

---

## 16. Changelog

### 2.0.1 continued (2026-11-06)

Interface and packaging:

- **Rewrote the interface to the design**, covering the empty state with logo, title, large rounded input box, bilingual slogan and settings entry, the conversation state with a single-column reading flow and bottom input bar, and the settings slide-over panel.
- **Completed the input box** with an attach-file control at the lower left and model selection, voice input and send at the lower right, with both the permission tier and model selection wired to real data.
- **First-run guide**: three steps covering welcome, connecting a model first and permissions, after which a local marker suppresses it.
- **Theme**: light and dark only plus a follow-system default in settings, where an explicit choice overrides the system appearance.
- **Window size**: default and minimum unified at 820 by 580, forced back to that size on every start.
- **Packaging**: added a release script that moves the installation package into `releases/` at the repository root after building.
- **First runnable desktop package produced**: the Rust release build compiles, the application bundle packages successfully at 4.7 MB with the compiled host and kernel inside its resources, and the disk image is produced with `hdiutil create -srcfolder`, bypassing the bundling script defect on newer macOS.
- **Fixed the packaging scripts**: three scripts had been calling pnpm with a filter that matches no workspace project because the command-line tool is a dependency rather than a project, and were changed to invoke the binary directly from `node_modules/.bin`.
- **Fixed the website build script**: added the missing directory-read import and changed the copy routine to report copied and skipped counts so empty directories no longer leave empty shells in the output.

### 2.0.1 (2026-11-05)

The first skeleton version built on the three-layer architecture.

**Architecture**

- Moved from a monolithic desktop application to a Tauri shell, Cordis host and dsh kernel across three processes.
- Shell to host and host to kernel both speak JSON-RPC over standard input and output.
- The protocol is defined in one place.

**Added**

- The kernel with 13 protocol methods covering lifecycle, session, inference, tools and models.
- The kernel dispatcher with newline-delimited framing, layered error codes and event push.
- The host's local HTTP service with Bearer token authentication, an explicit route table and path parameter decoding.
- The kernel client plugin with subprocess lifecycle management and request pairing.
- The desktop bridge plugin, so the front end never holds system permissions directly.
- The core plugin, assembling every first-party plugin from an explicit list and replacing patch stacking.
- The Tauri shell with window, host lifecycle, file selection, system theme and external links.
- The React front end with a session sidebar, detail panel, three connection states and light and dark themes.
- A smoke test with 7 chain checks.

**Migrated**

- All 134 first-party plugins migrated into the plugin directory with their business logic unchanged.
- Everything recompiled with TypeScript 7.0.2, 134 of 134 passing with complete output contracts.
- Measured assembly of 134 of 134 loaded, 0 skipped; across twelve consecutive runs the load took 194 to 264 milliseconds, median 215 milliseconds.
- Fixed a missing name export in the memory intake plugin, which had neither a patch file nor a plugin name export in the old repository and had never been assembled correctly.
- Added the plugin preparation script that generates shared build configuration.
- Added the core assembly check that verifies each member.

---

## 17. Roadmap

Ordered by dependency, where each item is a prerequisite for the next.

1. **Connect the shell command channel**, so the desktop bridge actually reaches Tauri. This is the prerequisite for file selection and external links working.
2. **Plugin configuration panel.** Present the 1168 fields from chapter 3 across 7 top-level menus and 28 second-level groups, including a running-state indicator with the four states of healthy, update available, failed and disabled. This is the largest unfinished item in the project.
3. **Streaming conversation interface.** Subscribe to the inference delta event and implement incremental rendering and interruption.
4. **Tool registry.** Provide a basic tool set for file access, terminal and network, with argument validation before execution.
5. **Tray and background residence**, supporting closing the window without quitting.
6. **Automatic updates** with signature verification, incremental download and rollback on failure.
7. **Plugin hot loading**, discovering plugins from the plugin directory dynamically without rebuilding the host.
8. **Restore the two strict type checks**, gradually fixing the 438 issues across 134 plugins and unifying the whole repository in the end.
9. **Standalone distribution package**, bundling the Node binary and dependencies into the installer so the target machine needs no Node installation.
10. **Linux support**, adapting the system integration.

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
pnpm run check:ui         # UI spec assertions and token check
pnpm run check:installer  # Windows installer script syntax (needs makensis)
```

All six must pass before a commit. The assembly check exits non-zero when anything is skipped, so it serves directly as a gate. `check:installer` exits with code 2 (a skip, not a failure) where `makensis` is absent; where it is present the script compiles the installer for real. The installer script is over a thousand lines and is only ever consumed by the Tauri bundler on Windows — this check is the only way to surface its problems on the development machine.

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

**Content not used.** This project uses no code, model weights, datasets, fonts, images or audio of unknown origin, unknown licence or requiring a paid licence. The interface uses only the system fonts provided by the operating system and bundles or distributes no font file. Icon data comes from two npm packages, `lucide` (ISC) and `morphicons` (MIT), consumed unmodified as dependencies; the application icon is an original design licensed with the source under AGPL-3.0.

**No model weights.** The kernel is a pure code implementation containing no model weights. Inference is provided by a model service the user configures at runtime, and the terms governing that model are set by the agreement between the user and the provider, independent of this project's licence.

**Where others' content is referenced**, the source is stated and compliance with its licence confirmed. This project's own copyright notices and third-party notices are kept side by side in the same file without overriding each other.

If you believe this project infringes your copyright, trademark or other rights, or you find an omission or error in NOTICE, please reach us through the repository issues or the website. We will correct or remove the relevant content within seven working days of verification.
