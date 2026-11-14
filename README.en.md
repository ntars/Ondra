[简体中文](README.md) | **English**

# 空谷 Ondra


**On No Sound's Depth, Resonance Arises.**

Ondra is a fully plugin-based desktop AI companion application. It splits the three things that make companionship feel real — that she remembers, that she has feelings, that she speaks like a person — into 75 plugins that can be installed and removed individually, plus one plugin manifest and two bridge layers, running inside a desktop program on your own machine.

The name comes from the Chinese idiom 空谷足音, hearing a person's footsteps in a silent valley, a metaphor for rare and precious news.

![Release Download](https://img.shields.io/github/downloads/ntars/Ondra/total?style=flat-square)
[![Release Version](https://img.shields.io/github/v/release/ntars/Ondra?style=flat-square)](https://github.com/ntars/Ondra/releases/latest)
[![GitHub license](https://img.shields.io/github/license/ntars/Ondra?style=flat-square)](./LICENSE)
[![GitHub Star](https://img.shields.io/github/stars/ntars/Ondra?style=flat-square)](https://github.com/ntars/Ondra/stargazers)
[![GitHub Fork](https://img.shields.io/github/forks/ntars/Ondra?style=flat-square)](https://github.com/ntars/Ondra/network/members)
![GitHub Repo size](https://img.shields.io/github/repo-size/ntars/Ondra?style=flat-square&color=3cb371)
[![GitHub Repo Languages](https://img.shields.io/github/languages/top/ntars/Ondra?style=flat-square)](https://github.com/ntars/Ondra/search?l=typescript)

[![Tauri](https://img.shields.io/badge/tauri-2.x-24c8db.svg?style=flat-square)](https://tauri.app/)
[![Cordis](https://img.shields.io/badge/cordis-4.x-8c45ab.svg?style=flat-square)](https://github.com/cordiverse/cordis)
[![Node](https://img.shields.io/badge/node-22.x-brightgreen.svg?style=flat-square&color=6da86a)](https://nodejs.org/)
[![React](https://img.shields.io/badge/react-19.x-blue.svg?style=flat-square&color=61dafb)](https://react.dev/)

[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-000000.svg?style=flat-square&logo=apple&logoColor=white)](#)
[![Plugins](https://img.shields.io/badge/plugins-75%20loadable-2ea44f.svg?style=flat-square)](#)
[![Data](https://img.shields.io/badge/data-100%25%20local-8957e5.svg?style=flat-square)](#)
[![QQ Group](https://img.shields.io/badge/QQ%20Group-1061684298-blue.svg?style=flat-square&color=12b7f5)](#qq-group)

Internal beta `1.0.1-alpha` — the `-alpha` suffix is the internal marker; this is not a stable build. Neither package is signed, so both are blocked on first launch — see the [release notes](https://github.com/ntars/Ondra/releases/tag/v1.0.1-alpha) for the workaround.

> **Document scope**: this README covers only the three core mechanisms (emotion, memory, context) plus an overview of everything else.
> Per-package responsibilities, configurable fields, defaults and ranges for all 78 packages are in [`docs/PLUGINS_EN.md`](./docs/PLUGINS_EN.md);
> per-version changes are in [GitHub Releases](https://github.com/ntars/Ondra/releases).

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
| Download | [Internal beta 1.0.1-alpha](https://github.com/ntars/Ondra/releases/tag/v1.0.1-alpha): macOS `arm64.dmg` + Windows `x64-setup.exe`, one click each. Carries the `-alpha` suffix, not a stable build |
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

This chapter expands on three things only: **where emotion comes from, how memory travels, and how context is assembled**. These three are the dividing line between Ondra and "one long prompt", and they are where all the engineering effort lands. Everything else (persona assembly, speech expression, voice and appearance, proactive gating, tool surface, storage fallback, UI grid) is covered in outline only; per-field defaults live in [`docs/PLUGINS_EN.md`](./docs/PLUGINS_EN.md).

### 3.1 Runtime skeleton

Three processes, each in its own process, communicating over explicit protocols. Any layer can be replaced, upgraded or restarted on its own.

| Layer | Path | Stack | Responsibility | Explicitly not |
| --- | --- | --- | --- | --- |
| Shell | `src-tauri/` | Rust 2024 + Tauri 2 | Window, tray, single instance, host lifecycle, native capability commands | No business logic |
| Host | `cordis-host/` | Node 22 + Cordis 4 + TypeScript | Plugin container, local HTTP API, token auth | Never touches the OS directly |
| Kernel | `dsh-sidecar/` | Node 22 + TypeScript | Inference loop, tool calls, session storage, model adapters | No UI, no listening ports |
| UI | `src/` | React 19 + Vite 8 | Rendering | No native capabilities |

Three communication paths: shell ↔ host is line-delimited JSON over stdio, where the host reports `ready` or `fatal` on stdout and the shell judges startup from that; host ↔ kernel is JSON-RPC 2.0 over stdio, framed as NDJSON, with the protocol defined in one place at `dsh-sidecar/src/protocol.ts`; UI ↔ host is HTTP on `127.0.0.1` with Bearer token auth, where the token is generated by the shell at startup.

**How plugins load.** `ondra-core` declares all 75 members in an explicit array and loads them one by one with `await ctx.plugin()`, each wrapped in its own `try/catch`; failures go into a `skipped` list with a recorded reason. There is not a single code-level `import` between the 75 plugins. They discover each other purely through service keys: `ctx.provide(key, impl)` to register, `ctx.get(key)` to consume, and when a key is absent the plugin skips that step and logs one line — it neither throws nor waits.

78 packages = 75 independently loadable plugins + one manifest (`ondra-core`) + two bridges (`desktop-bridge`, `dsh-client`), totalling 619 configurable fields (609 directly settable).

---

### 3.2 Emotion: state with inertia, not an adjective rewritten every turn

This is the most fundamental difference from "write in the prompt that you are happy right now". Emotion here is **a set of state variables that decay, linger and saturate**; each turn reads them without recomputing, and all expression parameters derive from a single decision.

#### 3.2.1 Four layers

| Layer | Plugin | Responsibility | Key mechanism |
| --- | --- | --- | --- |
| State | `ondra-emotion-core` | Baseline, three-axis emotion, hormone pool, temperament knobs | PAD three axes + 10 fixed tags; six-dimension exponential regression; three-hormone chemical pool |
| Ceiling | `ondra-emotion-stage` | How far intimacy can reach | Seven-stage relationship arc + four anti-jump gates; stages are a ratchet |
| Expression | `ondra-emotion-express` | Convert state into expression parameters | Six-state mapping, the single source for all coefficients |
| Dissipation | `ondra-emotion-diffuse` | Cross-session emotional residue | `(mood−baseline)×0.4×(1−familiarity×0.5)` |

#### 3.2.2 Why PAD instead of a single "happiness" number

A single happiness axis cannot distinguish "quietly content" from "excitedly elated", nor express "nervous and hopeful at once". The state therefore uses PAD (pleasure–arousal–dominance) as its base, plus 10 fixed tags for finer grain.

The decay constants are the heart of this mechanism and are hard-coded rather than configurable:

| Item | Value | Why this number |
| --- | --- | --- |
| Per-tag intensity | 0.12 | One message should not flip the whole conversation's state |
| Total tag ceiling | 0.6 | Leaves headroom for genuine long-conversation accumulation; one harsh sentence must not max it out |
| Tag half-life | 45 min | The emotion of one conversation should halve within about an hour, not persist until tomorrow |
| Mood half-life | 6 h | Mood is slower than momentary emotion but must still subside within one sleep |

The chemical pool holds three hormones: dopamine (baseline 50, half-life 45 min), cortisol (20 / 30 min), serotonin (50 / 120 min plus slow-variable rules). The three half-lives differ deliberately — a stress response should fade fastest (30 min), pleasure next (45 min), and the stable undertone slowest (120 min). With identical half-lives the three would collapse into one quantity.

**Missing fields in a save file are filled with the baseline 50, never 0.** This is the key fault-tolerance rule: filling 0 for a hormone field missing from an older save would drop the character into an "emotion reset" state after an upgrade, whereas filling 50 means "not recorded this time, treat as normal".

#### 3.2.3 Why relationship stages are a ratchet rather than a continuous value

Seven stages: hostile → probing → smitten (3 days, .18, .15) → possessive (14, .38, .32) → pathological (30, .62, .30 and trust ≤ .55) → sacrificial (45, .70, .45 and requires sacrifice) → settled (60, .75, .70).

The three numbers in parentheses are **minimum days at that stage, intimacy floor, trust floor**. Four gates prevent jumps:

1. **Time gate**: no promotion before the minimum days, so one long talk cannot skip three stages.
2. **Step gate**: intimacy rises at most 0.06 per settlement, so one confession cannot reach the top.
3. **Rise-only**: stages are a ratchet; ordinary friction does not demote — otherwise users would probe repeatedly to "get back to a good relationship".
4. **Conflict lock**: a detected conflict overrides to hostile. This is the only demotion path.

The three relationship axes (intimacy, trust, familiarity) each carry a half-life: 240 h / 720 h / 8760 h. A 30× spread is deliberate: **strangeness returns fastest (10 days), trust next (30 days), familiarity slowest (a year)**. Someone you have not spoken to for months feels "a bit distant but still familiar" — that is exactly the ratio of the three half-lives speaking.

Familiarity is derived from interaction count rather than stored separately, avoiding two competing definitions. The pathological and sacrificial stages stay out of the default UI — they exist to make the state machine complete, not for display.

#### 3.2.4 Six-state expression: single source of truth

Six states: **elated / soft / calm / wilted / bristling / sleepy**. Names and count are fixed and cannot be added to, removed or renamed.

One decision feeds three consumers — prompt, rhythm and speech — and every coefficient lives in this plugin only: speech rate ±10% / −15%, proactive quota ±1, whether to read aloud, sticker probability. The plugin emits parameters, never text; projection text belongs solely to `ondra-emotion-project`.

The value here is eliminating definition drift: once emotion must influence four places, four copies of the coefficients will inevitably fall out of sync after some change, showing up as "the prompt says she is elated but the voice is calm".

**Why three emotion-derivative plugins were removed.** Conflict, stress and hormone each had a derivative plugin; they are gone because they overlapped with six-state expression, and enabling both produced two emotion descriptions in the same turn. Better one dimension fewer than two answers.

#### 3.2.5 Emotional dissipation: cross-session residue

`(mood − baseline) × 0.4 × (1 − familiarity × 0.5)`

This formula answers one question: **how much of the mood at the end of the previous session carries into this one**.

- The further from baseline, the more carries over (`mood − baseline`);
- The 0.4 factor means at most forty percent carries, so last session's low mood is not transplanted verbatim;
- `(1 − familiarity × 0.5)` means the more familiar the person, the less last session affects this one — familiar people allow "I'm different this time".

It computes, never writes: the plugin hands out `target` and `delta`, and the caller applies them through the emotion core's `setAxis`. Within one session, a boundary key plus an interval gate (default 30 minutes) prevents "fading as you chat" — without the gate every turn produces a new boundary key and the mood is repeatedly washed back to baseline.

#### 3.2.6 How emotion enters the current turn

`ondra-emotion-project` is emotion's only textual outlet. The template is fixed as **one behavioural instruction sentence + one hint**, and is forbidden from containing numbers, axis names or emotion tag names — only subjective phrasing such as "a bit low on energy".

Three hard constraints:

1. **Never expose numbers.** Only when the user explicitly asks for values may it redirect to `ui-api`'s `/status`. Saying "my pleasure is 62" in ordinary conversation leaks internal state into dialogue.
2. **Fragment ordering is always positive** (default +800, i.e. tail). A negative value would break prefix caching — see 3.4.
3. **Never include tag names.** Saying "I am in elated state" makes the model parrot the label instead of sounding elated.

---

### 3.3 Memory: a full chain, not a vector store

Seventeen plugins split memory into a chain: intake → extraction → dedupe → pooling → decay → recall → human-like remembering → dreaming → promises and todos → forgetting audit → self-healing. Missing any link produces the same symptom — "she doesn't remember me" — but for entirely different reasons, so they must be handled separately.

#### 3.3.1 Two-layer table: raw text and facts separated

| Layer | Table | Holds | Why separate |
| --- | --- | --- | --- |
| Raw | `memory_raw` | Conversation verbatim | If fact extraction is wrong the original can be traced back; the right to be forgotten can locate the exact words |
| Fact | `memory_fact` | Extracted structured entries | Injection and recall read only this layer, keeping whole conversations out of context |

With extraction off (`extract: false`) only raw text is written: she remembers "that conversation happened" but cannot say "your name is X". This degradation is explicit, not a failure.

#### 3.3.2 Four citation gates on the write path

Every conclusion entering the store must carry one of four citation types, and the citation must actually appear in the source text:

| Citation | Meaning | Use |
| --- | --- | --- |
| `[USER]` | The user's own words | Any fact about the user requires one |
| `[TOOL]` | Tool return value | External data, computed results |
| `[ACT]` | System action | What she did |
| `[SELF]` | Character self-description | Her own settings and promises |

Three deterministic checks, zero model calls:

1. **Digits must have a verbatim source.** Numbers in the body must be covered verbatim by a citation (both `TOOL` and `USER` count by default; can be narrowed to `tool-only`).
2. **Attribution claims require `[USER]`.** Asserting "the user likes X" without the user's own words is rejected outright.
3. **Source-text comparison.** The citation must genuinely appear in the original, not be invented by the model.

**Why the gate sits on the write path rather than recall**: contamination happens at the moment of writing. However precise recall is, it only picks the most relevant entry out of an already-contaminated store — a guess from the previous turn gets recorded as fact, read back next turn, and repeated with more confidence; no prompt can stop that. The cost is possibly missing a memory, and that cost is explicitly accepted: **better to miss one than to record one wrongly**.

`allow-group` defaults to off: no extraction from group chats. Treating "no group chatter" as an admission red line rather than a performance trade-off.

#### 3.3.3 Dedupe: five-way adjudication

Before writing, each new fact gets one adjudication using a single measure — "character bigram containment 0.4":

| Verdict | Meaning | Outcome |
| --- | --- | --- |
| `add` | New fact | Create an entry |
| `merge` | Additional detail on the same thing | Merge into the existing entry |
| `append` | Same topic, new information | Append to the existing entry |
| `conflict` | Contradicts an existing entry | Handle per `conflict-policy` |
| `drop` | Duplicate or low value | Discard |

**Merging goes through `revise`, never `forget`**: `forget` writes a tombstone, whereas `revise` keeps the old text and leaves a correction record. If the user later asks "why did you say something different before", the answer is in the store.

`max-candidates` defaults to 5: above five candidates the model is not consulted. This is a cost gate — handing 50 candidates to a model does not improve accuracy, only the bill.

#### 3.3.4 Eight pools: lifetime is not one number

| Pool | Lifetime | Injected |
| --- | --- | --- |
| `core` | ∞ (cap 32) | Yes |
| `skillRule` | 730 days | Yes |
| `skillExp` | 60 days | Yes |
| `dailyCore` | 60 days | Yes |
| `dailyPartial` | 20 days | Yes |
| `emotion` | 1 day | Yes |
| `hippocampus` | 1 day | **Never** |
| Unclassified | → hippocampus | No |

Three day-scale timelines: grace → half-life → archive.

**The hippocampus never injects** is the key design point. It catches two kinds of content: tag misses, and unclassified items. These are "stored but not recallable" — which maps precisely onto human memory: some things are genuinely in your head but never surface on their own. `respect-pool` defaults to on; when the pool service is absent nothing is judged (without the service there is no way to know the pool, and letting it through beats guessing wrong).

**A full core pool rejects rather than evicts** (cap 32). Deleting one core memory amounts to deciding for the user "you should not be yourself". The same discipline applies to promises (cap 20) and pins (cap 8) — at the cap, refuse the new entry and report it so the user clears it themselves.

**A tag miss is never guessed**: if the same sentence fails to match three times it escalates to "needs manual pooling". A wrong pool is more dangerous than no pool, because a mis-pooled entry is cleaned up on the wrong lifetime.

#### 3.3.5 Decay: strength is asked of the core, never recomputed

`ondra-memory-decay` does three things: schedule reviews, produce clarity phrasing, and clean orphaned review plans. Strength is always asked of the memory core (public methods on `ondra-memory-core`); this plugin never recomputes a second formula.

SM-2 and Ebbinghaus eight-band fusion schedule the reviews. Three clarity bands go straight into the injected text:

| Strength | Phrasing | Effect |
| --- | --- | --- |
| ≥ 0.7 (`clear-above`) | No phrasing added | She states it normally |
| 0.4 – 0.7 | "a bit fuzzy now" | Tone carries uncertainty |
| < 0.4 (`faded-above`) | ", only a faint shadow left" | She only recalls the gist |

The point of this phrasing: **she forgets a little more slowly and speaks a little more accurately**. If a low-strength memory were still stated with certainty, that would be fabrication.

#### 3.3.6 Recall: five factors + RRF, no truncation by count

`ondra-memory-recall` weights: semantic .18 / keyword .46 / graph .11 / importance .14 / recency .11.

Keyword weight being highest (.46) is a product judgement rather than a technical compromise: in companionship the user usually mentions a specific noun (a name, a place, that thing), and semantic similarity drags in "similar things" while literal matching is more precise.

Three fusion modes:

- `rrf` (default): rank fusion, insensitive to score scale, suited to heterogeneous multi-path recall;
- `weighted`: five-factor weighted sum, highly explainable;
- plus BM25 and a vector branch that auto-switches between literal / hybrid / vector modes at 300 / 1000 thresholds.

**Recall never truncates by count** (`dropped` is always 0): the recall stage does not know the downstream budget, so truncating here would rob the packing stage of its basis for judgement. Budget belongs to prompt injection (see 3.4).

**Sealed memories never participate in recall** (`include-archived` defaults off): sealing is the user's explicit wish, not "unused for a long time". Archived (sunk) entries can still be found by category; sealed ones do not participate in active recall — the two have different semantics and must not be merged.

#### 3.3.7 Human-like remembering: three paths

Humans do not "retrieve" a memory, they are "reminded" of one. So beyond ordinary recall there are three paths (`ondra-memory-humanlike`):

| Path | Mechanism | Why designed this way |
| --- | --- | --- |
| Fixed recall dice | The fuzzier it is, the more likely to surface | In real memory fuzzy things pop up unexpectedly; clear things are available at will and need no "sudden recall" |
| Prompted by a phrase | Probability gate + reinforcement on hit | When a related word appears in conversation the memory is brought up, rather than waiting for retrieval |
| Aimless association | Ripple diffusion (2 rings by default) | One ring does not look "aimless"; three rings drag the whole graph into context |

Three channel views (`fact` / `gist` / `affect`) are kept apart: the same event can be remembered as detail (fact), as gist, and as how it felt (affect). Strength is asked of the core, diffusion of the graph, and the candidates for prompting come from the caller — this plugin never rebuilds retrieval.

#### 3.3.8 Dreaming: offline consolidation, not random generation

Three mutually exclusive branches behind a single enum rather than two switches (gated and surreal cannot coexist):

| Mode | What it does | Model calls |
| --- | --- | --- |
| `gate` (default) | Four gates fill in only facts with source citations | Yes |
| `lightweight` | Idle 2 min light sleep / 5 min deep sleep, pure rules mine five card types | **Zero** |
| `surreal` | Absurd association and dream talk; `surreal` edges never enter recall | Yes |

`lightweight` using zero model calls is the key trade-off: consolidating memory should not incur inference cost. Five card types (fact cards, tool pitfalls, tool playbooks, hot calls, unresolved failures) are mined silently by pure rules while the user is away.

`surreal` edges start at weight 0.03 and never enter recall — absurd association affects "what comes to mind", never "what is believed".

#### 3.3.9 Promises and todos: promises enter memory, todos do not

| Type | Enters memory chain | Lifetime | Cap |
| --- | --- | --- | --- |
| Promise | Yes (`promise` class) | 8000 hours | 20 |
| Todo | **No** | Expires after 3 days unmentioned | 3 |

**Todos staying out of the memory chain** is deliberate: a todo is a short-term errand, and putting it in the chain would make it persist as "she remembers you said you would do X" long after it should have expired.

Promises lock the original wording and carry reverse weighting (the nearer, the heavier). `kept` / `broken` settlement only emits a suggested relationship delta — the relationship belongs to `ondra-emotion-stage`, and two writers would fight. Extraction is pure regex, no model: `extract-min-chars` defaults to 4 (under 3 characters you cannot tell a promise from an offhand remark), `extract-max-chars` to 120 (longer sentences are usually narration).

#### 3.3.10 Forgetting audit: answering "why did she forget"

Three phrasing bands (strength / half-life / remaining time) plus pins (≤8) and four deletion modes:

| Action | Behaviour | Recoverable |
| --- | --- | --- |
| `forget` | Writes a tombstone | Yes (trace remains) |
| `seal` | Seals | Yes (not recalled but still stored) |
| Natural sinking | Archive | Yes (findable by category) |
| `revise` | Correct, keeping the old text | Yes |

It only calls public memory-core methods and never writes any `memory_fact` column. **The right to be forgotten** is the end of this chain: when the user asks for deletion, both raw text and facts are genuinely deleted, not flagged.

#### 3.3.11 Self-healing

`ondra-memory-heal` repairs inconsistencies: orphaned facts, dangling edges, invalid review plans, pool/lifetime mismatches. Four settings — repair behaviour is deliberately not very configurable, to avoid repairing into a state the user does not recognise.

---

### 3.4 Context: frozen prefix, incremental injection, budget packing

This section is the most easily overlooked part of the project and the one that most affects real experience. Three mechanisms each solve a specific problem, and they constrain one another.

#### 3.4.1 Frozen prefix: why rebuilding the system prompt every turn is a disaster

`ondra-conversation-compose` does this: **the stable segment is assembled once at session start and then locked, volatile segments are appended at the tail, history is append-only and never rebuilt, and compaction happens only at user-turn boundaries.**

| Segment | Content | When it changes |
| --- | --- | --- |
| Stable (prefix) | Persona + resident world book | Once at session start, then locked |
| Volatile (tail) | Date, emotion projection, injected fragments | Appended every turn |
| History | Conversation record | Append only, never rewritten |

Measured: rebuilding the system prompt every turn drops cache hit rate from **99% to 0**, and cost from **¥19.96 to ¥879.97**. This is the one line the whole repository defends — every other optimisation can yield, this one cannot.

Consequently every downstream plugin must order its fragments positively (append to the tail):

- `ondra-emotion-project`'s `projection-order` defaults to +800;
- `ondra-prompt-inject` always appends its blocks;
- `ondra-live` (date facts) **never enters the frozen prefix** — it changes daily, and putting it in the prefix would waste a cache every day.

**Compaction only at user-turn boundaries**: compacting mid-model-turn makes the same turn's context inconsistent and interrupts streaming. Waiting until the user finishes is the only safe point.

#### 3.4.2 Incremental injection: one big block first, then only deltas

`ondra-inject-dedupe` solves "the same memory appearing across multiple turns and multiple blocks":

1. First turn does one large injection;
2. Afterwards only deltas are pushed — each memory appears once;
3. When context is compacted, the seen ledger is released and a full block is injected again.

**Accounting is per memory, not per block**: `mem:` / `pin:` prefixes are normalised to `fact:`. Otherwise the same fact arriving through different blocks counts as two and dedupe fails.

**Two-phase commit**: `begin()` only produces the pending ledger, `commit()` actually writes. The caller confirms only after injection truly succeeded, preventing "recorded but not injected" from suppressing the next injection.

**On failure the whole block passes, not half of it**: a partial block leaves injection incomplete, and a model reading a truncated fragment is more likely to misjudge.

`auto-detect-compaction` defaults on: it reads the composition plugin's compaction counter to auto-release the seen ledger. **It only applies to a single session and explicitly does not guess with multiple sessions** — a wrong guess would double-inject another session's memories.

#### 3.4.3 Budget packing: skip what does not fit, never cut text

`ondra-prompt-inject` assembles eight blocks:

| Block | Content | Participates in packing |
| --- | --- | --- |
| Things promised | Promises | Yes |
| Must not forget | Pins / core | **No** (never trimmed) |
| People I know | `person` memories (≤5) | Yes |
| That day in history | Old events on the same date | Yes |
| What comes to mind now | Human-like recall | Yes |
| Lessons recorded | `skillRule` | Yes |
| Prompted by the phrase | Phrase-prompted recall | Yes |
| Remembered today | Minimum-exposure candidates | Yes |

Packing rule: **try every item globally by weight, skip the one that does not fit and continue to the next**, with the block header reading "N more not expanded".

Three hard constraints:

1. **Never cut text.** Cutting destroys the correspondence between citation and body; half a sentence is worse than none.
2. **Never drop silently.** Whatever does not fit must be counted in the block header so the user knows "12 more not expanded".
3. **Due reminders and pins never participate in packing.** Something due, and something the user personally pinned, outrank any budget.

#### 3.4.4 The full chain of three cooperating parts

One turn's context is assembled like this:

```
User message
  ↓
[Composition] stable segment (locked) + volatile (date/emotion/injection) + history (appended)
  ↓
[Inject dedupe] begin() produces pending ledger → only deltas pushed
  ↓
[Prompt inject] eight blocks packed by weight, reports "N more not expanded"
  ↓
[Composition] commit() records → send to model
  ↓
[Model returns]
  ↓
[Nine-step filter chain] strips repetition, narration, support-desk tone, over-explanation
  ↓
[Memory intake] raw text to memory_raw → extract → dedupe → pool
```

If any link is missing the symptom is "she doesn't seem to remember me", but the causes are entirely different:

| Missing link | Symptom |
| --- | --- |
| No `ondra-memory-pool` | All facts land in the hippocampus flagged `unclassified`, and the hippocampus never injects |
| No `ondra-prompt-inject` | Pooling works but nothing renders it into the prompt |
| No `systemPrompt` service key | Packing is ready but unread; only a warn line |
| No `ondra-inject-dedupe` | The same memory repeats, crowding out the budget |
| Prefix not frozen | All features correct, cost up 44× |

That last row means: **a broken prefix cache raises no functional error at all**, it only makes the bill ugly. Problems of this class must be caught by documentation and check scripts, never left for users to discover.

---

### 3.5 Remaining features, item by item

The first three sections of this chapter cover the three core mechanisms in depth. The remaining 57 plugins carry concrete responsibilities too; they are simply given less space in proportion to their importance. Each entry states **what it does** and **how it is implemented**. Per-field defaults are in [`docs/PLUGINS_EN.md`](./docs/PLUGINS_EN.md).

#### 3.5.1 Persona detail (18 plugins, 161 fields)

This group answers "who she is, how she speaks, in what role she accompanies you". The persona is split into replaceable parts rather than one hard-coded prompt.

| Plugin | What it does | How it is implemented |
|---|---|---|
| **Persona core** `persona-core` | Defines who she is | Splits `SKILL.md` into six slots (identity / speech / drive / scene / format / self-check) and five relationship variants (girlfriend / sister / daughter / friend / assistant) plus custom; changing the relationship never changes the persona |
| **Persona assembly** `persona-assemble` | Assembles the parts into one persona | Four fixed stages: core → relationship tuning → concentration → boundary; packed item by item under a character budget, skipping and continuing when an item does not fit; the boundary layer is wholly exempt from trimming; over-budget reports `overBudget` and writes "N more not expanded" into the segment header |
| **Persona vars and concentration** `persona-vars` | Replaces pronouns and controls speech density | Substitutes `{{user}}`/`{{char}}`/`{{relation}}` with user-supplied values (unknown or empty values are left verbatim); a 0–100 slider yields five concentration bands; concentration is never written into the core |
| **Persona loader** `persona-loader` | Loads replaceable personas | Read-only scan of `ondra-persona-skills/*.skill.zip`, parsing `meta.json` and `SKILL.md` to register available personas; ships with Jingjing, with Xia Ningqi as a sample pack; the pack itself is never written back |
| **Persona evolution** `persona-evolve` | Lets character drift with time spent | Numbers only, never prose: trait scores derive from "baseline + un-rolled-back delta" (bounded, reversible, explainable); thresholds move by `base × (1 + 0.6 × min(1, interactions/5000))`, capped at +60%; both `×1.00` and `0` are legal values, so neither drifting nor not-drifting raises an error |
| **World book** `worldbook` | Supplies background knowledge | Six hard-bucketed budget layers (1600 tokens total: L1 350 / L2 180 / L3 100 / L4 500 / L5 200 / L6 150); an entry that hits the limit is dropped whole, never truncated; resident entries form a separate segment frozen as the session prefix; in-layer ordering is stable and does not shift with hit counts |
| **Oral shaping** `oral` | Turns written language into speech | Catchphrase pool of 12–20 per persona, banded by the six states, at most twice per session; 8% incomplete sentences; punctuation habits (no closing full stop / repeated question marks for doubt / ellipsis for hesitation); particles only ever subtracted; stickers gated at a minimum 3-message interval but never sent by this plugin |
| **Output filter** `filter-chain` | Strips nine kinds of non-speech | Nine-step chain: draft tone → AI self-disclosure → hard red lines → relationship overreach → stage overreach → narration → 4-gram repetition → support-desk tone → length fallback; strips item by item, acting only at sentence boundaries; includes anchor detection and a post-hoc review loop |
| **Language feel** `lexicon` | Measures how the user speaks | Takes the last 300 human messages, computes median sentence length, unpunctuated rate and particle frequency, and compresses them into a 56–62 character volatile segment tagged `[语感]`; stores shape, never wording — the original text is discarded immediately |
| **Dialogue composition** `dialogue` | Decides how context is assembled | Freezes the prefix within a session: the stable segment is assembled once and locked, volatile segments are appended at the tail, history is append-only, and compaction happens only at user-turn boundaries (see 3.4) |
| **Dialogue protocol** `dialogue-protocol` | Defines the streaming frame format | Five frames: `text-delta` / `text-replace` / `crisis` / `usage` / `done`; end reasons are a closed set of four; cross-frame discipline (exactly one terminal frame, `usage` and `crisis` once each) and the NDJSON codec exist in exactly one place |
| **Emotion projection** `emotion-project` | Turns emotion into one sentence | Template fixed as "behavioural instruction + one hint", forbidden from containing numbers, axis names or tag names; fragment ordering is always positive (tail) to protect the prefix cache (see 3.2.6) |
| **Prompt injection** `prompt-inject` | Renders memory into the prompt | Eight-block assembly packed under a character budget; due reminders and pins never participate in packing (see 3.4.3) |
| **Absence etiquette** `absence` | How to open after a long gap | Five bands (today / yesterday / a few days / a while / a long time), each giving only what must be done, what must never be done, a sentence cap, whether to acknowledge the gap and whether warmth is allowed; **no numbers at all** — "we haven't spoken in 17 days" is not care, it turns a reunion into an interrogation |
| **First meeting** `first-meet` | How the first encounter unfolds | Five beats: arrival → self-introduction → setting boundaries → invitation → closing; each beat gives only purpose, must-do, must-not-do and a sentence cap, not one word of script; boundaries come before the invitation (state what I will not do, then ask the first question) |
| **Rhythm** `rhythm` | How many bubbles and how long to pause | Pure function: ≤4 bubbles, ≤40 characters each, 6 characters per second, punctuation adds 300/500/150 ms, pauses 300–6000 ms (clamp first → late night ×1.6 → clamp again), first-character delay 800–2000 ms, long pause 20% × 3000–9000 ms (at most once per turn) |
| **Typing execution** `rhythm-typing` | Runs the rhythm plan as a real timeline | First bubble "thinking", "typing" between bubbles, no fake typing during long pauses; cancellable per session; a new turn supersedes the old one in the same session; falls back to sending the whole block at once when the rhythm service is absent |
| **Breath** `breath` | Whether to show "typing" | Maps the typing stage onto "should typing be shown right now" (not shown during an absent-minded long pause); within a quota of at most twice a day it supplies one parenthetical action (a stretch, say) |

#### 3.5.2 Voice and appearance (4 plugins, 48 fields)

This group handles what she sounds and looks like.

| Plugin | What it does | How it is implemented |
|---|---|---|
| **Speech synthesis** `tts` | Text to speech | Three parallel channels: local GPT-SoVITS (api_v2), macOS `say` (zero dependencies), Edge TTS (19 voices plus 8 presets); only wiring, routing and degradation — never reimplementing a synthesis mechanism; audio goes to a content-addressed `cache/tts`; failures return reason codes rather than throwing |
| **Voice gate** `tts-gate` | Whether this line should be spoken | Four gates: switch, 6–30 characters, emotion intensity ≥0.15 (or an emotion word this turn), 3-second rate limit; plus "force text after two consecutive voice messages"; judgement only, no speech; results carry a reason code, real character count, emotion intensity and the six-state speech rate |
| **Transcription** `asr` | Speech to text | Local whisper first, cloud fallback; wiring only: assemble a whisper command, wait for it, read the JSON into millisecond timestamps; cloud multipart only when local is unavailable; failures are silent (no transcript means she did not hear it); never invents a speaker (whisper does no diarisation, so `diarized` is always false) |
| **Expression decide** `expression-decide` | What her face should do as the line is said | Judges the finalised body into one of six states by cue words, punctuation and sentence shape, handing it to the portrait to change faces; inserts no markers into the body and writes no state names into the prompt; falls back to the current six-state value when the body has no cues, and to the least error-prone default when neither exists, while letting the caller see "no basis this time" |

#### 3.5.3 Care and guidance (2 plugins, 7 fields)

| Plugin | What it does | How it is implemented |
|---|---|---|
| **Crisis intervention** `crisis` | Whether this line contains a signal that must be taken seriously | Five signal classes (indirect expression / direct expression / plan / farewell / self-harm) each map to one of four bands, then a context marker pass, finally three boolean suggestions (pause persona / offer resources / ask directly); no diagnosis, no scoring, no persistence, no built-in hotline numbers, no treating low mood as crisis; hypothetical context affects wording only and never downgrades, negation and past tense lower by one band only and never to zero |
| **Onboarding** `onboarding` | The four-stage first-run flow | A four-stage state machine: check the runtime environment → reuse an installed `.ondra` → pick a free port → open the interface with a token; each stage needs evidence to count as done, and skipping is allowed only in the single optional stage; the progress percentage is computed, never invented |

#### 3.5.4 Gating and compliance (4 plugins, 34 fields)

This group decides what she may do and may send. Shared discipline: **a red line that can be switched off is not a red line**, so red-line behaviour is not configurable.

| Plugin | What it does | How it is implemented |
|---|---|---|
| **Privacy and egress** `privacy` | Whether this may be sent, to whom, with whose approval | Capability providers first `declare()` (what is sent, where, why it must leave, which environment variable is needed), then call `evaluate()` before sending; anything undeclared is refused (not allowed by default); three risk tiers are divided by "can it be undone": metadata only goes to L1 notice, images/audio/files or identifiable content to L2 confirmation, key-shaped content leaving the domain to L3 block; consent is remembered per "capability + host" and persisted; credentials are stored as variable names only, values never pass through |
| **Capability sandbox** `sandbox` | How much this plugin may do this time | Four levels (`read` / `suggest` / `act` / `spend`) with a ticket carrying an expiry and a call cap; overreach is refused; four hard rules: deny by default (no ticket, no capability), expired tickets are invalid and must be traceable to which ticket and its exact expiry, exhausted caps are invalid, overreach attempts leave a trace |
| **Tool gate** `organ-gate` | Which tools this turn could actually need | Keyword rules over the user's actual words compute the tool families "likely needed" and remove the rest from that agent's schema view, saving input tokens every turn; measured 48 commands 55,154 → 8,433 tokens (84.7%), with no promise of the same ratio |
| **Proactive gate** `proactive-gate` | Whether a pending message may be sent right now | Nine gates: master switch and group-chat red line, circuit breaker and backoff, content red lines, quiet hours, daily budget, idle threshold, session cooldown, duplicate suppression, three-tier token bucket; judgement only, no sending and no timers; state persisted to `user/proactive-state.json` (0600, atomic write), because "resetting on restart = repeated harassment" |

#### 3.5.5 Tool and capability surface (3 plugins, 26 fields)

| Plugin | What it does | How it is implemented |
|---|---|---|
| **Proactive quota** `proactive-quota` | Whether she still wants to speak, and how many lines remain today | Quota tiers (slow / standard / fast), minimum interval between proactive messages, character-based silence (deterministic draw with a give-up rate), a farewell line after consecutive non-responses, and a one-tap mute entry; never judges whether a message may be sent, never recomputes quota decay |
| **Proactive reason** `proactive-reason` | What to use as the reason to speak now | Eight candidate classes (preoccupations / due promises / emotion deviation / todos / recent events / timeline / environment / line pool) sorted by priority (lexicographic, weights compared only within a class); a 72-hour topic cooldown ensures "the same thing is mentioned once in three days"; produces reasons only, never body text |
| **Organ host** `organ-host` | Manages loading and settlement of pluggable capabilities | Load topology, capability allowlist, energy accounting, feedback arbitration, prompt assembly, telemetry; three non-negotiable constraints: organs never write state directly (they may only propose via `feedback()`, and `flush()` accumulates per target then applies once and clamps — applying one by one would make the result depend on registration order), an organ bound by that constraint must be responsible for itself, and registration order must not affect the result |

#### 3.5.6 Storage and data (5 plugins, 0 fields)

This group is organised as a degradation chain: SQLite → JSONL → in-memory. All three have zero settings — degradation behaviour is not configurable, preventing a user from disabling automatic fallback and ending up with a half-broken storage layer.

| Plugin | What it does | How it is implemented |
|---|---|---|
| **SQLite backend** `store-sqlite` | Primary storage | WAL mode, foreign keys, STRICT table definitions, file permissions tightened to 0600 after writing; on failure it registers in a "degraded" state rather than throwing |
| **JSON backend** `store-json` | Second-level fallback | A multi-option branch used when SQLite is unavailable or the database is corrupt; append log plus compressed atomic write; failures degrade rather than block |
| **Memory backend** `store-memory` | Third-level fallback | Keeps the main conversation working when SQLite cannot open, and **explicitly declares itself non-persistent**; the UI shows "currently in-memory, lost on restart" |
| **Snapshot** `snapshot` | Memory backup and restore | `VACUUM INTO` for a consistent copy, `KEEP=3` rotation, `quick_check` validation; restore requires explicit confirmation and never runs automatically |
| **Version migration** `data-migrate` | Data format upgrades (off by default) | Registers only the `MigrationRunner` service; **the repository contains no migration scripts yet**, so it ships disabled — a migration runner with no scripts installed is a fake switch |
| **Vision** `vision` | Image understanding, OCR, object localisation, video frame extraction (off by default) | Pluggable providers (cloud OpenAI-compatible / local Ollama / Qwen), off by default; wired to `privacy`, deferring to its three-state verdict when present and never sending to the cloud without it; failures return reason codes quietly and never fabricate content (a guessed description would become a false memory) |

#### 3.5.7 Foundation and host (12 plugins, 27 fields)

This layer is the ground the application stands on. Most have zero fields: they provide contracts, not knobs.

| Plugin | What it does | How it is implemented |
|---|---|---|
| **Core assembly** `core` | Assembles all members | Declares the 75 members in an explicit list and loads them one by one with `await ctx.plugin()`, each wrapped in its own `try/catch`; failures go to `skipped` with a recorded reason |
| **Desktop bridge** `desktop-bridge` | Bridges native capabilities from the Tauri shell | Four command families: file selection, system theme, window title, external links; mounted unconditionally outside the main load list |
| **Kernel client** `dsh-client` | Talks to the dsh kernel | Wraps JSON-RPC 2.0: process lifecycle management and request pairing, framed as NDJSON |
| **Clock** `clock` | A single time source | Fixed timezone, calendar-based natural-day conversion, cancellable timer lifetimes; no direct `Date.now()` anywhere else in the repository |
| **Identity** `identity` | Single source for names and paths | Product name, process name, pidfile name, environment variable prefix, directory names and log namespace roots all come from here; no second hard-coded copy is allowed |
| **Config schema** `config-schema` | Four-layer configuration merge | Factory → bundle → user → runtime; the only implementation of verbatim-segment fallback and provenance tracing |
| **Path layout** `path-layout` | Data root and directory permissions | The only entry point for resolving the data root, creating five region directories and tightening to 0700/0600 |
| **Model gateway** `llm-gateway` | Selects a model, sends requests, accounts for usage | Three-source list (online API / local / free), priority routing, first-chunk and inter-chunk timeouts, retry before the first chunk with cross-source fallback, usage accounting; keys get an existence pre-check and reference registration only, never injection |
| **Chinese log** `log-zh` | Chinese log formatting (off by default) | The `ondra-log-zh` service key it provides has **no runtime consumer anywhere in the repository**, so installing it would be a no-op; hence disabled |
| **Port picker** `port-picker` | Finds a usable port | Splits "get me a number" into two intents: for a listener, a port nobody is bound to (system allocation, equivalent to `--port 0`); for the UI, a port the host is already bound to (read the established fact); mixing the two intents hands a child process the port the host itself occupies |
| **Process host** `process-host` | Manages child processes | Hands argv/cwd/stdio/grace period explicitly to upstream `ctx.subprocess`; restarts once under budget on crash; teardown goes through the provider's managed process scope (group kill); state lives in the user's `process-host` directory; deliberately never kills on its own |
| **Window** `window` | Window specification and version guard | Collects title area 48, draggable hotspot 44, traffic lights 20/19/12, circle centre 25, three columns 272/520/300 and five breakpoints into one definition; offers branch A (`hiddenInset` with native traffic lights, the safest default) and branch B (`hidden` with custom drawing, macOS only); checks the shell-side patch version allowlist |

#### 3.5.8 Life and perception (2 plugins, 18 fields)

| Plugin | What it does | How it is implemented |
|---|---|---|
| **Life rhythm** `life-rhythm` | Lets her live her own days | On one side, activities: six activity classes, interest weights and tags (demanding / relaxing / creative), a 10% chance of exploring a new interest, relaxing types preferred when mood is low, one weighted pick per run, half-life decay for long-unused interests, notes split into long-term and temporary. On the other side, energy: +0.2/min awake, +1/min in deep sleep or late night, natural cap 60, decaying at 0.1/min above 100 when fed |
| **Drive gap** `drive-gap` | Remembers what she has not figured out | Generated from three sources (the model admitting ignorance / a tool returning nothing / a request failing); tension derived idempotently from `created_at` (`base + hours×rate − relief + dedupe pressure`); similarity ≥0.6 adds pressure without creating a new entry and keeps the earliest wording; closing an entry also closes similar `open` entries; four wake conditions |

#### 3.5.9 Install and assembly (3 plugins, 20 fields)

| Plugin | What it does | How it is implemented |
|---|---|---|
| **Installer** `installer` | Manifest-driven installation | Nine-step pipeline, an independent `sha256` per component, verified once before and once after writing, a ledger in the user's `.ondra-bootstrap.json`, and a final `bootstrap-ok` self-check; **verification is hard-ordered before writing** (a file with a wrong hash never reaches disk) |
| **Install doctor** `install-doctor` | Which parts would this assembly miss | Uses ported `parsePatchYaml` / `applyEntryPatches` / `composeEntries` to compute "the entry tree the host will actually see", reporting which bundles would be skipped and how many patch warnings exist |
| **Startup check** `startup-check` | Whether it actually got installed | Ten checks that only judge and never block startup; what they verify is not "is the code correct" but "did it take effect"; three silent failures are listed: a `package.json` missing `ondra.bundle.patch` makes the host print one stderr line, with no effect on startup and nothing visible in the UI |

#### 3.5.10 Remaining emotion and memory plugins

The four emotion-engine plugins are expanded in 3.2 and the seventeen memory-system plugins in 3.3. The following are the ones not singled out there:

| Plugin | What it does | How it is implemented |
|---|---|---|
| **Memory graph** `memory-graph` | Remembers which things are related | Four edge classes and 1-hop diffusion: same-topic from 0.72 rising 0.05 per hit, co-occurrence from 0.15 rising 0.10, absurd 0.03 never entering recall; diffusion threshold 0.4, hub cap 40, 90-day ×0.5 (with a `decayed_at` cursor); touches only the edge table and never writes `memory_fact` |
| **Memory recognition** `memory-recognition` | A second retrieval path | A full index (one line of trigger words per memory) enters the prompt, a small model picks slugs, then a walk along `[[links]]` neighbourhoods; 500 entries ≈ 6k tokens; the index block is fixed in ascending `seq` order, so it can be prefix-cached |
| **Vector retrieval** `memory-vector` | A third retrieval path (off by default) | Deterministic hash embeddings + cosine recall + IVF bucketing; two thresholds at 300/1000 auto-switch between literal / hybrid / vector modes, fused with RRF; zero settings |
| **Multimodal memory** `multimodal-memory` | Stores image descriptions and transcripts as ordinary memories | Memory body exists in one place only (`memory_fact`); this plugin keeps no second copy; carries `modality` and `source_path` to remember provenance; image → description, speech → transcript, video → 4 frames + audio track |
| **Right to be forgotten** `forget-right` | Counts every place to clear when the user says "forget this" | Eleven surfaces: body, pins, graph edges, vectors, todos and promises, time capsules, language-feel samples, diary, narrative log, snapshots, decision log; two stages: planning is read-only and produces the list, execution requires an explicit confirmation token; if any surface fails or a surface that should have been cleared is skipped, `completeness = false` — the right to be forgotten has exactly two outcomes, fully done and not done |

#### 3.5.11 Totals

| Top-level menu | Groups | Plugins | Fields |
| --- | --- | --- | --- |
| Persona detail | 6 | 18 | 161 |
| Voice & appearance | 2 | 4 | 48 |
| Developer features | 8 | 35 | 192 |
| Emotion engine | 1 | 4 | 13 |
| Memory system | 1 | 17 | 205 |
| **Total** | **18** | **78** | **619** |

Three ship disabled: `ondra-vision` (reads the screen and calls an external model), `ondra-data-migrate` (no migration scripts), `ondra-log-zh` (its service key has no consumer). **Every one of them has a reason; none were disabled to shorten the list.**

---

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
- **`tauri.windows.conf.json` (Windows platform override)**: Tauri reads a platform-specific config and merges it into the main one with JSON Merge Patch. Here it does exactly one thing: `app.windows[0].decorations = false`, explained below. Note that **arrays are replaced wholesale**, so this file must repeat `label`, `width`, `height`, `minWidth`, `minHeight` and `backgroundColor`; omit one and it silently reverts to the Tauri default.

**Why Windows must turn decorations off**: `titleBarStyle: "Overlay"` is a **macOS-only field**. On Windows it is ignored and the system still paints a native title bar, while `TitleBar.tsx` also renders its own window buttons on Windows — so the top of the window showed two rows of buttons. Disabling `decorations` lets the custom set take over for real: an undecorated window in tao still keeps the rest of `WS_OVERLAPPEDWINDOW` (maximising does not cover the taskbar), edge resizing is handled separately through `WM_NCHITTEST`, and dragging the whole bar relies on `data-tauri-drag-region`.

The matching layout constraint: `.titlebar__controls` is `position: absolute` and takes no space in the flow, so the version badge must reserve room itself — `:root[data-platform='win32'] .titlebar__version { margin-right: 146px }` in `layout.css` (138 for the three buttons plus 8 of breathing room). Without it the badge sits underneath the close button.
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
├── README.en.md                  Full English version
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
├── .github/workflows/            CI: release.yml builds both platforms and publishes a release
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
    ├── tauri.windows.conf.json   Windows platform override (no system decorations)
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

1. **The model adapter covers only the OpenAI-compatible protocol.** The kernel's `ChatAdapter` implements just the `/chat/completions` shape; every provider difference is expressed in configuration (`baseUrl` + `model` + `apiKey`). **No provider ships in the box.** On first launch the only model is `local/echo`, an offline echo model that never goes online and produces no intelligence, but does walk the entire chain — session persisted, streamed deltas, character-by-character rendering — so that "installed, and the pipeline works" is directly observable. Real models are added one by one under Settings → Models & API. Earlier builds shipped a preset pointing at `http://127.0.0.1:3425/v1`; that gateway existed on the development machine and nowhere else, so the user's very first message was guaranteed to fail with `fetch failed`. The preset is gone, and a one-time migration removes the leftover entry from existing configs.
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
14. **Neither installer is signed or notarised.** macOS carries a linker ad-hoc signature (`codesign -dv` reports `flags=0x20002(adhoc,linker-signed)`, no `TeamIdentifier`); Windows has no code-signing certificate. Both are blocked on first launch — the workarounds are in the release notes. Signing and notarisation are stable-release work.
15. **The bundled Node runtime comes from the build machine, not a pinned version.** `build:runtime` copies `process.execPath`, so a cloud build ships Node 24.9.0 while a local build ships 22.22.2 — both satisfy `engines: { node: ">=22" }`. Two builds of the same version number can therefore differ in runtime. Removing that would mean downloading a fixed Node version in the collect step; not done yet.
16. **Memorial personas are not open.** None of the three preconditions described in 2.5 — authorisation, scope statement and data minimisation — has any implementation, so this persona form is not offered. This is a product-level constraint, not a pending feature.

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

The changelog lives on the **GitHub Releases** page; this README no longer duplicates it.

- All versions and per-item changes: <https://github.com/ntars/Ondra/releases>
- Current internal beta `1.0.1-alpha`: <https://github.com/ntars/Ondra/releases/tag/v1.0.1-alpha>

**Why releases rather than the README**: a changelog corresponds to one specific build, and the download entry, installer checksums and known issues all live in the same place; the README describes the project's current state. Mixing the two leaves readers unable to tell "how it is now" from "what changed that time". So the README covers only the present, and changes belong to releases.

Version numbering: the internal beta line starts at `1.0.1-alpha`; the `-alpha` suffix marks an internal build and means **neither a public beta nor a stable release**.


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

### 18.5 Contact

| Channel | Address |
| --- | --- |
| QQ group | **1061684298** |
| Website | <https://ai.ntars.cn/> |
| Repository | <https://github.com/ntars/Ondra> |
| Releases and changelog | <https://github.com/ntars/Ondra/releases> |
| Issues | <https://github.com/ntars/Ondra/issues> |
| Email | <ntars@qq.com> · <ntarsx@163.com> |

During the internal beta the QQ group is the fastest channel: you can ask about the current build's actual state and hear about workarounds for known issues. Feature requests and defects should go to Issues so they stay public and traceable.

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
---

Ntarstudio · <https://www.ntars.cn/>
