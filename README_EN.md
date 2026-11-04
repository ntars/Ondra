# Ondra (空谷)

[中文](./README.md) ｜ [English](./README_EN.md)

**On No Sound's Depth, Resonance Arises.**

Ondra is an open-source, one-click deployable and highly customizable AI companion application developed by Ntarstudio. It runs on the Cordis plugin system of the ondra runtime. The ondra runtime supplies only the plugin container and runtime foundation; every product capability is implemented by 133 `ondra-*` plugins plus the built-in interface.

| Item | Content |
| --- | --- |
| Chinese name | 空谷 Ondra, from the idiom 空谷足音 (footsteps in a silent valley) |
| Repository | [ntars/Ondra](https://github.com/ntars/Ondra) |
| Website | <https://ai.ntars.cn/> |
| Version | 1.2.0 |
| License | [AGPL-3.0](LICENSE) |
| Plugin count | 133, delivered in 13 batches from B0 to B13 (B8 Interface retired; the UI lives in the app shell) |
| Plugin directory | [`cordis/`](cordis/) |
| Factory persona | Ojingjing (package `哦鲸鲸`); Xia Ningqi is a sample package |
| Runtime | Bundled Node.js 24; no user installation required |

---

## 1. Plugin System

### 1.1 Layers and Blast Radius

Plugins are grouped into nine layers by what breaks when they fail, not by feature count. Upper layers may call lower layers; lower layers must never depend upward. Plugins within a layer communicate only through service keys and never import each other's source.

| Layer | Name | Plugins | Consequence of failure |
| --- | --- | --- | --- |
| L0 | Foundation | 5 | Cannot locate the problem |
| L1 | Storage | 5 | Memory cannot be recovered |
| L2 | Kernel (memory, persona, emotion) | 31 | Reply quality drops; conversation continues |
| L3 | Conversation pipeline | 5 | Cannot converse |
| L4 | Expression and life | 20 | No speech, expressions or sense of life |
| L5 | Channels | 13 | One channel stops sending or receiving |
| L6 | Device side | 8 | One extension becomes unavailable |
| L7 | System and delivery | 9 | Cannot install or start |
| L9 | Runtime governance and extensions | 37 | Governance or extension capability missing |

> L8 was the interface layer. It was retired on 2026-11-03 (the UI now lives in the app shell), so it is no longer listed. Layer numbers are left unshifted to avoid breaking existing `L9` references.
>
> The table counts each plugin by the layer it belongs to: **the nine layers sum to 133, matching the total plugin count**. Two easy-to-miss spots: the three B12 multi-option branch plugins are fallback implementations of the same capability and are still counted in their own layer (`ondra-store-json` in L1; `ondra-memory-vector` and `ondra-emotion-hormone` in L2); the three B9 multimodal plugins are counted in the L9 extension pool (`ondra-vision` / `ondra-asr` as perception extensions, `ondra-multimodal-memory` as a memory-write extension).

### 1.2 Plugin Contract

Each plugin is an independent npm package whose entry exports four items:

```ts
export const name = 'ondra-memory-core'        // plugin identifier, also the service key
export const inject = ['ondra-store-sqlite']   // required service keys, optional
export function apply(ctx: Context) { }        // lifecycle entry
export const Config = { /* configuration shape and defaults */ }
```

Six hard constraints:

1. No cross-package imports. Services are resolved with `ctx.get('ondra-xxx')`; a missing service degrades silently.
2. Sensible defaults, everything adjustable. Four presets in simple mode; concrete values in advanced mode.
3. Silent degradation. A failed enhancement never blocks the main conversation.
4. Reversible registration. Timers, listeners, routes and panels register through `ctx.effect()` or `ctx.on()` and return a disposer.
5. Single source of truth. Data structures and defaults are owned by the provider; consumers read only.
6. Naming constraint. Service keys, tool names and configuration keys must match `^[a-z][a-z0-9_-]{1,63}$`, using hyphens rather than colons.

### 1.3 Bundle Declaration (Omission Means Silent Non-Loading)

`package.json` must declare the patch file:

```json
{ "ondra": { "bundle": { "patch": "./cordis.patch.yml" } } }
```

Without this declaration the host prints one line to stderr (`declares no ondra.bundle`) and skips the package. The package exists in the dependency tree and is named in the bundle manifest, yet the plugin is never loaded. Patch semantics: an `insert` without `id` appends to the root entry list; an `insert` with `id` requires the target to be a group entry; a patch line without `insert` must provide `id`; a missing target, a non-group target or a name mismatch produces a warning and is skipped. Entries have exactly six fields: `id`, `name`, `config`, `group`, `disabled`, `inject`.

### 1.4 Three Reuse Tiers

| Tier | Meaning | Scope |
| --- | --- | --- |
| Reuse | Mature ecosystem; the plugin only wires, configures and degrades | Channels, speech, vision, desktop pet, market, icons, lunar calendar, memory backend |
| Thin wrapper | An implementation exists; wrap it with adaptation and guardrails | Language lock, chain-of-thought anchor, output review, heartbeat, life log, evidence gate |
| Self-developed | No mature implementation; may be substantial, capped at 15 items | Seven-stage arc, threshold drift, lexical statistics, nine-step filtering, restraint design, organ ABI, seven context-governance plugins |

### 1.5 Organ ABI (Constitutional Rules)

Plugins that involve organs must obey three non-negotiable constraints:

1. **C1 No direct state writes.** An organ submits a change proposal; the host accumulates proposals, applies them once and clamps the result.
2. **C2 Pay for perception.** Every perception returns an energy receipt with state `full`, `partial`, `starved` or `shadow`. When `denied` is true, the perception must be abandoned immediately.
3. **C3 No error propagation.** Exceptions are caught outside and converted to `degraded` with an empty result.

The context is exposed as a facade offering only `state`, `consume`, `emit`, `proposeGap`, `onToolResult`, `onTick`, `registerTool`, `onPrompt`, `kv` and `log`. The capability whitelist defaults to deny and unauthorized access raises `CapabilityDeniedError`. Prompt fragments carry `order`, `ttl` and `confidence`; scar weight is fixed at -1e4 and organs may not go below -1000.

### 1.6 Delivery Batches

| Batch | Scope | Plugins |
| --- | --- | --- |
| B0 | Foundation | 5 |
| B1 | Storage and model gateway | 5 |
| B2 | Memory depth | 14 |
| B3 | Persona and emotion | 15 |
| B4 | Conversation pipeline and expression | 14 |
| B5 | Proactive behavior and restraint | 10 |
| B6 | Runtime governance | 7 |
| B7 | Channels | 13 |
| B9 | Multimodal | 3 |
| B10 | Device side | 8 |
| B11 | System and delivery | 9 |
| B12 | Multi-option branches | 3 |
| B13 | Extension pool | 27 |

---

## 2. B0 Foundation (5 Plugins)

| ID | Plugin | Tier | Function | Implementation |
| --- | --- | --- | --- | --- |
| O-001 | `ondra-identity` | Self-developed | Single source for product name, process name, pidfile name and environment variable prefix | Pure constant module with no side effects; exports a read-only object and registers a service only. Naming completes before the app becomes ready so built-in directories land under the product name |
| O-002 | `ondra-path-layout` | Self-developed | Resolves data root, runtime root, skills root, user data root and temporary directory; creates directories and applies permissions | `path.join` for composition and recursive `fs.mkdir`. Directories use 0700 and files 0600; a failing `chmod` (network volumes) logs a degradation instead of blocking |
| O-003 | `ondra-clock` | Self-developed | Unified time source and natural-day determination for relationship day counting and scheduled tasks | Time function is injectable for testing. Natural days are split by local timezone and cross-day checks compare date parts only, without approximate time deltas |
| O-004 | `ondra-log-zh` | Self-developed | Two-tier logging: a user-facing overview layer and a developer code layer, with rotation and write-amplification protection | Ring buffer, same-key deduplication (one entry per second for a repeated error) and 4 MB rotation across three files. The code layer appears only in developer mode |
| O-005 | `ondra-config-schema` | Self-developed | Single source for the four-layer configuration structure and all defaults | Declarative schema merged in order: factory defaults, bundle defaults, user configuration, runtime overrides. A validation failure falls back per field rather than failing entirely |

---

## 3. B1 Storage and Model Gateway (5 Plugins)

| ID | Plugin | Tier | Function | Implementation |
| --- | --- | --- | --- | --- |
| O-006 | `ondra-store-sqlite` | Thin wrapper | SQLite port: schema creation, column backfill, transactions, permissions | Synchronous `node:sqlite` interface. On startup it runs `PRAGMA journal_mode=WAL` and `PRAGMA foreign_keys=ON`. `PRAGMA table_info` is compared against the expected schema and missing columns are added with `ALTER TABLE`. Files use 0600 |
| O-007 | `ondra-store-memory` | Self-developed | In-memory implementation with the same interface, used when SQLite is unavailable | A `Map` holds tables and indexes; data is lost on exit. Intended only for degradation, with no persistence promise |
| O-008 | `ondra-data-migrate` | Self-developed | Idempotent initialization and version migration | A version table records the current schema; migration scripts run in order inside a transaction; repeated runs have no additional effect |
| O-009 | `ondra-snapshot` | Self-developed | Memory database snapshots, three copies retained, explicit restore | Three-stage fallback: system `sqlite3 VACUUM INTO`, `node:sqlite` online export, then file copy. Before restore a `before-restore` copy is made; file names are whitelisted; restore never runs automatically |
| O-035 | `ondra-llm-gateway` | Thin wrapper | Model supply with three switchable sources (online API, local model, free model), key injection, timeouts and retries | OpenAI-compatible client. Keys are injected by the host environment and never written to configuration. Thinking models route through a nothink proxy so the visible content is not empty. Timeouts use exponential backoff and failures never block the main pipeline |

---

## 4. B2 Memory Depth (14 Plugins)

| ID | Plugin | Tier | Function | Implementation |
| --- | --- | --- | --- | --- |
| O-010 | `ondra-memory-core` | Self-developed | Two-tier storage and lifespan computation | Raw and fact tables written in one transaction. Lifespan `S(h) = baseHours × (0.45 + salience/100 × 1.25) × (1 + arousal × 0.65)`. Eleven baselines: commitment 8000, self 20000, person 240, study 80, feeling 50, event 40, misc 20, place 12, food 10, daily 3, watch 2 hours. Three channels of 4, 12 and 180 days act as a second modulation layer, multiplied after the category |
| O-011 | `ondra-memory-extract` | Self-developed | Extracts facts from conversation with source category and verbatim citation | Five-second timer, grouped by session, batches of 20 items and at most 3000 characters. The prompt includes existing facts and requires consistent wording. Strict JSON with five parsing fallbacks: direct parse, fence removal, bracket slicing, object salvage and sentence-level fallback. Assistant output is filtered by role |
| O-012 | `ondra-memory-dedupe` | Self-developed | Fact deduplication and supersession chain | Normalized key of subject, predicate and object with whitespace folding and lowercasing. Priority: manual edits, then higher importance, then earlier creation. Losing entries are retained and point to the winner; nothing is physically deleted |
| O-013 | `ondra-memory-decay` | Self-developed | Decay settlement, capacity eviction and spaced review | Exponential half-life by default. Hit extension `1 + 0.6·log2(1+count)` capped at 4 times; repeated mention extension `min(15, 3×(1+ln(1+times_said)))` days. SM-2 spaced review schedules by difficulty. Archiving lowers strength without deleting; a memory not surfaced for 30 days is forced out once |
| O-014 | `ondra-memory-recall` | Self-developed | Three-path retrieval and scoring | Five-factor weighting: semantic 0.18, keyword 0.46, graph 0.11, importance 0.14, freshness 0.11. BM25 with `k1=1.2` and `b=0.75`. Freshness `0.5^(time since last recall ÷ half-life)` anchored at last hit or creation. Normalization divides only by participating factors. RRF fusion ranks by position rather than score. Recall is never truncated by count |
| O-015 | `ondra-memory-graph` | Self-developed | Four edge types and associative diffusion | Shared entity, temporal proximity, calendar anchor and shared topic. After retrieval, expansion walks one hop with edge weight 0.6; diffusion threshold 0.4 and hub cap 40. Shared-topic edges start at 0.72 to 0.85 and gain 0.05; co-occurrence edges start at 0.15 and gain 0.10 |
| O-016 | `ondra-memory-prospective` | Self-developed | Prospective memory for commitments and to-dos | Commitments store the original text verbatim and are never compressed. Weight is inverted: `0.4 + 0.6·e^(-|due-now|/3d)`. Reminders enter the proactive reason pool 24 hours ahead. Unmet commitments after a 24-hour grace period are marked broken and trigger relationship settlement; fulfilled ones are marked kept with a small positive adjustment |
| O-017 | `ondra-memory-audit` | Self-developed | Explainable forgetting and four deletion states | Each memory shows channel, current strength, remaining half-life and why it is still remembered, with pin (floor set to 1) and forget actions. Four states: `forget` writes a tombstone that merging cannot revive, `seal` stores without recall participation, natural sinking retains the entry, `revise` keeps the old text with the new version winning on merge |
| O-018 | `ondra-memory-humanlike` | Self-developed | Three-channel view and random recall | Fact 4 days, gist 12 days, affect 180 days, with floors 0.02, 0.30 and 0.55. At session start a die roll with `p=0.15` may surface one weak memory naturally. A weak memory mentioned twice is promoted and gains 0.1 importance |
| O-019 | `ondra-memory-dream` | Self-developed | Gated nightly consolidation and a lightweight branch | Six nightly steps: co-occurrence reinforcement, decay (must carry a `decayed_at` cursor or the exponent repeats), soft pruning, surreal association, dream utterances and summary rewriting. An online backup precedes the run; each step is bounded; deletions are soft. The lightweight branch runs at 2 and 5 minutes of idle time, mining five card types with rule-based logic and a 168-hour half-life for unused cards |
| O-131 | `ondra-memory-pool` | Self-developed | Eight-pool layering and archiving | Core never decays and is capped at 32. Iron-rule pool has a 730-day half-life and stays fully resident. Experience 60 days, daily core 60 days, daily fragment 20 days, emotion 1 day and not a log, hippocampus 1 day and never injected. A label matching no pool is not guessed: it enters the hippocampus and is tagged unclassified; the same sentence written three times escalates to manual pool assignment |
| O-140 | `ondra-evidence-gate` | Self-developed | Memory write gating | Deterministic validation before writing: four citation categories must be locatable and compared verbatim; numeric assertions must carry a tool-source marker; attribution assertions without a user citation are rejected. Validation never depends on model compliance |
| O-142 | `ondra-inject-dedupe` | Self-developed | Injection deduplication | A large block is injected once on the first turn, after which only deltas are pushed. Seen identifiers are recorded and released on a compaction signal. Measurements show repeated injection on every wake-up adds over 13,000 characters to a single context |
| O-136 | `ondra-recall-eval` | Self-developed | Retrieval evaluation | 20 to 40 real questions including paraphrases; outputs recall@1, recall@3, MRR and end-to-end success rate; reports are written to disk. Every parameter change is evaluated, and evaluation precedes tuning |

---

## 5. B3 Persona and Emotion (15 Plugins)

| ID | Plugin | Tier | Function | Implementation |
| --- | --- | --- | --- | --- |
| O-020 | `ondra-persona-loader` | Self-developed | Reads persona packages and registers them as available personas | Scans `*.skill.zip` under `material/ondra-persona-skills/`, parsing `meta.json` and `SKILL.md`. Packages are read-only and never written or renamed. The factory persona is Jingjing; sample packages are replaceable |
| O-021 | `ondra-persona-core` | Self-developed | Persona kernel, five relationship variants and six slots | The kernel holds shared identity, character, honesty and boundaries. Each variant writes only relationship differences: address, pacing and typical reactions. On merge with the same id, the later definition wins |
| O-022 | `ondra-persona-vars` | Self-developed | Variable substitution and speech intensity | Supports `{{name}}`, `{{callUser}}`, `{{relation}}` and `{{toneLevel}}`. Unrecognized placeholders are preserved rather than cleared. Three intensity levels generate tone hints of different strength |
| O-023 | `ondra-persona-assemble` | Self-developed | Four-section assembly and budget trimming | Order is fixed: kernel, relationship adjustment, intensity, boundaries. `priority` only decides what to trim when over budget. The boundary layer is fully exempt; exceeding the budget returns `overBudget` rather than silently dropping a prohibition. Total budget 1600 characters |
| O-024 | `ondra-worldbook` | Self-developed | Six-layer world book selector | Total budget 1600 tokens across layers of 350, 180, 100, 500, 200 and 150. L1 and L6 are resident regardless of keywords; other layers trigger by keyword. Within a layer entries load by priority; an over-limit entry is dropped whole and recorded. Leftover quota carries to the next layer |
| O-025 | `ondra-worldbook-scenes` | Self-developed | Scene card data and trigger rules | Lowercased `includes` keyword matching. Within one layer only the highest-priority card is kept and the rest are recorded as suppressed. Only L4 may recurse, with depth at most 3 |
| O-129 | `ondra-drive-gap` | Self-developed | Gap pool and tension as the internal drive | `tension = clamp(base + h×rate − relief)`. Similarity at or above 0.6 adds only 10 to avoid repeated pressurization; waking threshold is 80; three generation sources; gap closure triggers related settlement; the commitment gate may be merged into this plugin |
| O-130 | `ondra-persona-evolve` | Self-developed | Personality rewriting from experience and threshold drift | `threshold = base × (1 + 0.6 × min(1, interactions/5000))`, capped at +60 percent, rising monotonically with familiarity, stage and cumulative interaction. Drift is persisted and `explainThreshold()` explains the current value |
| O-026 | `ondra-emotion-core` | Self-developed | Emotion state container, PAD dimensions, ten labels and chemical pool | Exponential regression `v(t)=baseline+(v₀−baseline)·e^(−λt)` with `λ=ln2/half-life`, computed lazily on read. Per-message change cap 0.12, label cap 0.6, label half-life 45 minutes, mood 6 hours. Dopamine 50/45 min, cortisol 20/30 min, serotonin 50/120 min. Missing archive fields default to the baseline of 50, never 0 |
| O-027 | `ondra-emotion-diffuse` | Self-developed | Cross-session emotional diffusion | `(mood − baseline) × 0.4 × (1 − familiarity × 0.5)`; the less familiar the relationship, the more likely irritation carries over. Pure function and unit-testable |
| O-028 | `ondra-emotion-stage` | Self-developed | Seven-stage relationship arc and anti-leap | Hostile, probing, fond, possessive, pathological, sacrificial, settled. Advancement requires all three axes (days, intimacy, trust) to qualify. Four anti-leap gates: time gate, step gate of 0.06, monotonic rise, and conflict lock override. The five-stage and six-band scales are read-only mappings |
| O-029 | `ondra-emotion-stress` | Self-developed | Stress attention multiplier | Cortisol at or above 80 gives crisis ×3 and daily ×0.1; at 60 the multipliers are ×2 and ×0.55 by linear interpolation; at or below 40 both are ×1. At 80 or above a behavior instruction is injected at the head of the system prompt |
| O-030 | `ondra-emotion-conflict` | Self-developed | Conflict lock and release | Conflict events raise tension by 0.15 and suppress mood. During the lock there is no cutesy behavior, no proactive messages and replies are shorter. Release requires an apology or two consecutive positive signals with mood recovering past the threshold |
| O-031 | `ondra-emotion-express` | Self-developed | State-to-six-mode expression mapping | Six modes: elated, soft, calm, wilted, bristling, sleepy. Selection order: locked or high tension, high stress with low mood, high stress, low energy, high mood with high energy, medium mood, default. Each mode defines chunk count, sentence length, interjections, punctuation and whether to open a topic |
| O-032 | `ondra-emotion-project` | Self-developed | Emotional projection and the interoception rule | Serializes six-dimensional state into 60 to 100 characters of natural language appended to the end of the user message to occupy a high-attention position. Reporting numbers is prohibited; only subjective phrasing is allowed |

---

## 6. B4 Conversation Pipeline and Expression (14 Plugins)

| ID | Plugin | Tier | Function | Implementation |
| --- | --- | --- | --- | --- |
| O-033 | `ondra-dialogue` | Self-developed | Conversation orchestration: gather context, assemble the prompt, stream the call, finalize | Assembly order is date facts, persona, world book, emotional projection, length discipline. The stable prefix is frozen within a session while volatile sections append at the tail; rebuilding every turn is prohibited. The plugin never creates a session record and never writes a session log. A missing prompt section continues as an empty string with a single warning |
| O-034 | `ondra-dialogue-protocol` | Self-developed | Conversation event protocol | Five frame types: text delta, text replace, crisis signal, usage and done. The done frame carries a stop reason of normal, aborted, error or length. Unknown fragments are ignored rather than raising |
| O-038 | `ondra-rhythm` | Self-developed | Pure computation of chunking and pauses | Splits on strong punctuation and only re-splits at soft pauses when a sentence exceeds 40 characters. At most 4 chunks, with excess merged from the tail. Typing speed is 6 characters per second with 150 to 500 millisecond punctuation surcharges. Delays are clamped, multiplied by the 1.6 late-night factor, then clamped again. First-character delay is 0.8 to 2.0 seconds; long pause probability 0.20 with at most one per turn; self-correction probability 0.05 |
| O-039 | `ondra-rhythm-typing` | Self-developed | Anthropomorphic typing rhythm | Typing duration derives from character count and speed plus punctuation surcharges. Long pauses and self-corrections land in this layer. Late night and low mood slow everything down; elation speeds it up |
| O-040 | `ondra-oral` | Self-developed | Colloquial speech | A catchphrase pool grouped by emotion, used at most twice per session to prevent repetition. Interjections follow the six-mode mapping; incomplete sentences at 8 percent; no trailing full stops to preserve a chat feel; median chunk length 8 to 12 characters; no deliberate typos |
| O-041 | `ondra-breath` | Self-developed | Non-verbal layer | Shows a typing indicator during the first-character delay; occasionally emits an information-free breathing action during long sessions, at most twice per day; shares minimum-interval constraints with stickers and speech |
| O-036 | `ondra-prompt-inject` | Self-developed | Context injection and budget allocation | Bin packing: items are globally sorted by weight and packed into the character budget; an item that does not fit is skipped and the next is attempted; the section header states how many remain unexpanded. Three budgets of 2600, 24000 and 1200 characters, default 2600. Core sections never participate. A large block is injected on the first turn and body text expands on demand |
| O-037 | `ondra-filter-chain` | Self-developed | Nine-step output filtering and post-hoc review | Pipeline passes: strip reasoning, replace hard violations, relationship red lines, stage red lines forcing regeneration, replace setting leakage, remove narration, detect repetition by 4-gram overlap, replace service tone, fall back to the last complete sentence on length overflow. Post-hoc review scores 1 to 100 with an independent model and regenerates with feedback at most twice per turn |
| O-137 | `ondra-lexicon` | Self-developed | Lexical statistics | Reads the latest 300 human messages, computes median sentence length, punctuation-free ratio and interjection distribution, and injects about 130 characters. Statistics never override the persona, and the injected block carries a marker for replacement |
| O-050 | `ondra-tts` | Reuse | Dual-channel speech synthesis | Local GPT-SoVITS over HTTP and cloud Edge TTS with 19 voices and 8 presets (gentle, lively, broadcast, northeastern, Shaanxi, Cantonese, Taiwan and English). Any synthesis or upload failure silently falls back to text |
| O-051 | `ondra-tts-gate` | Self-developed | Four speech gates | Explicit switch; sentence length 6 to 30 characters; emotional intensity `max(|mood−0.5|,(energy−0.5)×0.5) ≥ 0.15` or an emotional word this turn; at least 3 seconds since the last spoken reply; text forced after two consecutive spoken replies |
| O-052 | `ondra-expression-decide` | Self-developed | Rule-based expression decision from text | Three regex rules matched in order (sleepy, shy, happy) returning on first hit; minimum gap of 3 messages; fallback by mood and a random draw when no keyword matches. The model never emits expression markers directly, which would appear on every message at random positions |
| O-053 | `ondra-sticker` | Self-developed | Sticker pack loading and dispatch | Reads `stickers/` under the persona directory with an extension whitelist of png, webp, gif, jpg and jpeg. The prefix before the underscore is the label. A missing or empty directory falls back to three built-in stickers |
| O-054 | `ondra-avatar` | Reuse | Character rendering | Wraps ecosystem implementations (airi, dsh-whale-girl-live2d) in an adapter layer; falls back to a static image when the renderer is unavailable; shows an explicit notice rather than a clickable control when unimplemented |

---

## 7. B5 Proactive Behavior and Restraint (10 Plugins)

| ID | Plugin | Tier | Function | Implementation |
| --- | --- | --- | --- | --- |
| O-042 | `ondra-proactive-gate` | Thin wrapper | Three proactive gates and heartbeat engine | Timing gate: no contact during 23:00 to 08:00, idle of at least 25 minutes, at most 3 per day, at least 2 hours since the last. Reason gate: due commitments, to-dos, recent events, timeline, environment. Proportion gate: at most 20 characters, a concrete anchor required, the phrase "are you there" banned, 35 percent give-up rate. The heartbeat lets the model schedule alarms (one-shot, interval, cron with jitter), supports waking cold sessions, and ends silent wake-up turns with a fixed marker folded out of context. Six anti-ban gates apply on top |
| O-043 | `ondra-proactive-reason` | Self-developed | Reason ranking and cooldown | Priority order: due commitments, to-dos, recent events, timeline, environment. The gap pool adds the sense of missing something. Topics cool down for 72 hours; an excluded reason is not reused in the same turn |
| O-044 | `ondra-proactive-quota` | Self-developed | Quota and decay | Three per day; halved after three days without response and paused after seven. Exit rule: two days of silence or two proactive messages after the user last spoke triggers a single exit line. No proactive messages in groups; one-click mute supported |
| O-134 | `ondra-climb` | Self-developed | Backlog reading for group messages | Reads unread backlog and summarizes each item with time, speaker and group identifier; bounded by a count limit; wake-up applies only in private chat |
| O-135 | `ondra-narrative-log` | Self-developed | Reply decision explanation | Records the memories, emotion values, relationship stage and reason used this turn, appended to a read-only log, so the interface and audit can answer why she replied this way |
| O-045 | `ondra-diary` | Self-developed | Daily first-person diary | Generates 100 to 200 characters within the 02:00 to 04:00 window; idempotent by date so the same day is never rewritten; materials come only from real records, with no invented weather or meals; falls back to rules when the model is unavailable; no notifications, no unread changes, no popups |
| O-046 | `ondra-live` | Reuse | Date facts | Weekday, lunar date, solar term and festival. Lunar data uses lunar-javascript and tyme4ts as two implementations cross-checked against each other. Everything is computed locally without network access. Facts only, no instructions |
| O-047 | `ondra-weather` | Reuse | Weather | Enabled only when coordinates are configured; caches for 20 minutes and does not retry for 10 minutes after a failure; when unavailable, nothing is written into the prompt |
| O-048 | `ondra-life-rhythm` | Thin wrapper | Life layer, energy and daily rhythm | The life layer runs in a separate script process with six random activity types (studying, reading, watching videos, writing a diary, spacing out, chatting in groups). Interests carry weights and tags, with a 10 percent chance of exploring something new; when mood is low, relaxing activities are preferred. Energy recovers at +0.2 per minute while awake and +1 per minute in deep sleep or late night, with a natural cap of 60, frozen during emergency stop, integrated in 5-minute slices, and a wake-up instruction consumed once |
| O-049 | `ondra-onthisday` | Self-developed | On this day | Queries memories in the same date range through calendar-anchor edges, sorted by strength, returning a bounded number to produce a sense of reminiscence |

---

## 8. B6 Runtime Governance (7 Plugins)

| ID | Plugin | Tier | Function | Implementation |
| --- | --- | --- | --- | --- |
| O-132 | `ondra-organ-host` | Self-developed | Organ ABI and host | The facade context exposes ten capabilities. The capability whitelist defaults to deny and raises `CapabilityDeniedError`. The energy receipt state machine covers `full`, `partial`, `starved` and `shadow`; during migration the default is `shadow`, which accounts without charging. Feedback arbitration accumulates and applies once before clamping. Prompt fragments sort by `order` and filter expired or low-confidence entries. Scar weight is fixed at -1e4 |
| O-138 | `ondra-organ-gate` | Self-developed | Tool schema gating and intent routing | Deterministic rules determine intent and expose tool definitions on demand. Measured reduction from 55,154 to 8,433 tokens, an 84.7 percent cut. Gating rules never call a model, avoiding extra latency |
| O-139 | `ondra-failure-attrib` | Self-developed | Eight failure categories and prescriptions | Categories: tool missing, argument error, permission, timeout, network, not found, conflict and unknown. Argument errors are never retried automatically. A wound closes on the next success of the same tool and is marked chronic after 5 minutes. Results feed the diagnostics view |
| O-141 | `ondra-memory-recognition` | Self-developed | Recognition retrieval branch | Places the full index into the prompt (about 6k tokens for 500 entries, served by the prefix cache), has a small model pick slugs, then walks the neighborhood along `[[links]]`. Runs alongside the vector branch; inverted index remains the default |
| O-143 | `ondra-zero-residence` | Self-developed | Zero resident context | Deterministic pointers replace resident content, and obscured bytes can be restored verbatim from the session log, keeping the process reversible and auditable. State is written to SQLite before compaction. Four operations: compact, recall, ledger and fast |
| O-144 | `ondra-reflex` | Self-developed | Reflex arcs and chain crystallization | After three failures of the same tool for the same cause, a rule `R-auto-<cause>-<tool>` is written. Successful chains of three or more steps across organs are crystallized into skills. No model calls are involved. Three bad writes trigger a circuit breaker to prevent runaway cost |
| O-133 | `ondra-install-doctor` | Self-developed | Install self-check | Ports patch parsing, patch application and entry tree composition to compute the entry tree the host will actually see, reporting skipped bundles and warning counts. The tenth check asks whether the host will really load this plugin |

---

## 9. B7 Channels (13 Plugins)

The channel layer follows one isolation rule: one channel per plugin, with independent configuration, credential file (0600), log namespace, probe instance and start-stop control. Any channel crash, timeout or rate-limit event leaves other channels and the main conversation unaffected.

### 9.1 Common Layer (3 Plugins)

| ID | Plugin | Tier | Function | Implementation |
| --- | --- | --- | --- | --- |
| O-055 | `ondra-router` | Self-developed | Wake-up decisions, multi-session queuing and capability queries | Private messages always answered, mentions always answered, keyword hits answered, probabilistic wake-up (default 0.1) otherwise, and no reply beyond that. Sessions never run in parallel. Wake-up discipline restricts wake-up to private chat |
| O-056 | `ondra-channel-kit` | Self-developed | Shared channel path: receive, ask the persona, reply | Pure functions and factories. `callPersona` returns a string or null and warns then drops the message when the persona service is absent; `chunkText` splits by limit; `PeerHistory` is per-channel, memory-only and capped at 12 entries. Message persistence and rate limiting are deliberately excluded |
| O-057 | `ondra-channel-health` | Self-developed | Channel probe | Wraps warning and error log levels, calling the original function first and observing afterwards with full internal capture. Recognizes channels by the `[channel]` prefix and classifies by keywords, ignoring undecidable lines. Independent of the observed process, so a crashed adapter still shows as unhealthy |

### 9.2 Compliant Channels (7 Plugins)

| ID | Plugin | Tier | Transport and implementation |
| --- | --- | --- | --- |
| O-058 | `ondra-adapter-qq-official` | Reuse | Open Platform OpenAPI v2 over a WebSocket long connection. Fetches the gateway address first, sends heartbeats with sequence numbers, and requires passive replies to carry the original message id. Chunk limit 1200 characters |
| O-060 | `ondra-adapter-wechat-official` | Reuse | Webhook receiver with signature verification. Passive replies have a hard 5-second timeout, so a degraded line is sent first and the real reply is delivered through the customer service message interface within the 48-hour window. Chunk limit 800 characters |
| O-061 | `ondra-adapter-wechat-kf` | Reuse | Pull model: calls `sync_msg` every 5 seconds with a cursor, and the callback only signals that new messages exist. Only user-sent text is processed. Chunk limit 800 characters |
| O-063 | `ondra-adapter-wecom` | Reuse | Webhook receiver with self-implemented message cryptography: SHA1 signature verification, AES-256-CBC decryption, padding and random-prefix removal, and enterprise identifier validation. Returns success first and processes asynchronously. Chunk limit 2000 characters |
| O-064 | `ondra-adapter-feishu` | Reuse | Webhook receiver validating the verification token and echoing the challenge. Only message receive events are processed. Tenant tokens are cached and refreshed 300 seconds before expiry. Encrypted event bodies are unsupported and the configuration is reported |
| O-065 | `ondra-adapter-dingtalk` | Reuse | Webhook receiver with HMAC-SHA256 signature verification. Returns an empty message first and processes asynchronously; replies go through the session webhook. Requires a publicly reachable address |
| O-066 | `ondra-adapter-telegram` | Reuse | `getUpdates` long polling with a 50-second timeout. The token sits in the URL; offsets deduplicate naturally; failures back off for 3 seconds. Chunk limit 4000 characters |
| O-067 | `ondra-adapter-discord` | Reuse | Gateway WebSocket v10 with self-implemented connection and heartbeat. Only message create events are processed; groups require a mention while direct messages are always answered. Invalid-token close codes stop reconnection and other codes reconnect after 5 seconds. Chunk limit 1900 characters |

### 9.3 High-Risk Channels (3 Plugins)

| ID | Plugin | Tier | Transport and implementation |
| --- | --- | --- | --- |
| O-059 | `ondra-adapter-qq-napcat` | Reuse | NapCat reverse WebSocket (OneBot 11) where the protocol endpoint connects inbound to the local machine. Disabled by default and shown in a separate block with risk disclosure, never mixed with compliant channels |
| O-062 | `ondra-adapter-wechat-personal` | Reuse | User-provided protocol endpoint over local HTTP. Both `enabled` and `confirmed` must be true. Private text only, no history reading, fully local with no reporting |

---

## 10. B9 Multimodal (3 Plugins)

| ID | Plugin | Tier | Function | Implementation |
| --- | --- | --- | --- | --- |
| O-126 | `ondra-vision` | Reuse | Image understanding, OCR, object localization and video frame extraction | Pluggable providers: OpenAI-compatible cloud endpoints, local Ollama and Qwen. Disabled by default. Integrates with the privacy plugin to show an egress notice when enabled. When the model is unavailable, action stops rather than guessing |
| O-127 | `ondra-asr` | Reuse | Speech transcription | Local Whisper first with cloud fallback. Output carries timestamps and speaker separation. Failures are silent. Transcribed text enters memory as ordinary content |
| O-128 | `ondra-multimodal-memory` | Self-developed | Multimodal memory ingestion | Images store descriptions, audio stores transcriptions and video stores four frames plus an audio track. Records `modality` and `source_path` for traceability and shares the write path with the evidence gate |

---

## 11. B10 Device Side (8 Plugins)

| ID | Plugin | Tier | Function | Implementation |
| --- | --- | --- | --- | --- |
| O-068 | `ondra-adb` | Reuse | Android device capability | Primarily wraps scrcpy, whose mirroring and control exceed plain adb. Read-only by default; polling fetches only new data; failures are silent to avoid log flooding |
| O-069 | `ondra-device-mcp` | Self-developed | Phone read-only MCP | Five tools: notifications, SMS, contacts, battery and foreground app. All read-only. Per-call timeout 8 seconds; a device serial prefixes the device argument when provided |
| O-070 | `ondra-desktop-mcp` | Self-developed | Desktop read-only MCP | Five tools: processes, foreground window, clipboard metadata, file search and system status. Processes exclude command lines (which may contain tokens), the clipboard returns only type and length, and file search is limited to the home directory, depth 2 and 30 results. Timeout 5 seconds |
| O-071 | `ondra-browser` | Reuse | Browser automation | Wraps an ecosystem implementation in an adapter layer; tool output is sandboxed and compressed before entering context; disabled by default |
| O-072 | `ondra-gui-agent` | Self-developed | Desktop automation | Single-step loop: perceive, decide, execute one action, verify, report. Four risk levels (read-only, click, type, system). Three safety nets: dangerous-area blacklist, application whitelist with zero default authorization, and an action confirmation threshold. Form red line: stop immediately when a user-entered field is detected. Every step writes an audit record |
| O-073 | `ondra-minecraft` | Reuse | Game integration | Built on Mineflayer. Placeholder form, disabled by default, with an explicit notice when enabled |
| O-074 | `ondra-pet` | Reuse | Desktop pet | Reuses ecosystem implementations (dsh-pet, agentpet, MIT). Retained as a capability entry; rendering is not reimplemented |
| O-075 | `ondra-pet-mobile` | Reuse | Mobile desktop pet | Placeholder plugin recording the platform premises and form-factor differences, with an explicit notice while unimplemented |

---

## 12. B11 System and Delivery (9 Plugins)

| ID | Plugin | Tier | Function | Implementation |
| --- | --- | --- | --- | --- |
| O-076 | `ondra-privacy` | Self-developed | Compliance disclosure and risk notices | Shows the egress inventory, data handling statement and uninstall export path. Applies three notice levels to high-risk channels: full-screen confirmation on first binding, color coding in the list, and a banner when the failure rate exceeds 20 percent. The real privacy switch lives in configuration; this plugin only informs |
| O-077 | `ondra-startup-check` | Self-developed | Startup self-check | Ten checks including entry activation count, the two privacy switches and presence of key packages. Judgement and reporting only; refusing to start is decided by the rendering layer |
| O-078 | `ondra-market` | Reuse | Bundle marketplace | Reuses the dsh-market ecosystem implementation. Manifest-driven and read-only. The install entry depends on the restore-point mechanism and is hidden when no restore point exists |
| O-079 | `ondra-installer` | Self-developed | Installation pipeline | Nine steps: environment detection, component download, integrity verification, profile assembly, bundle installation, privacy hardening, view setup, first-run onboarding and main process start. Manifest-based bootstrap with per-component SHA-256 and an accounting file, finishing with a `bootstrap-ok` self-check. Multi-source fallback and resumable downloads |
| O-080 | `ondra-process-host` | Self-developed | Child process hosting | Starts in an independent process group with a rewritten process name; the pidfile records the group leader; termination targets the group from the pidfile and never uses fuzzy command-line matching. A 30-second readiness window and one restart on failure. After the port opens, a 3-second grace period waits for the tokenized address |
| O-081 | `ondra-window` | Self-developed | Window | Hides the system title bar, embeds and positions the traffic lights, and keeps a 44-pixel drag region at the top of the page. The preload script exposes only the restart capability and does not enable Node integration |
| O-082 | `ondra-onboarding` | Self-developed | First-run onboarding | Four progressive sections: model source, persona, address and relationship, interface preference. Uses navigation interception with a URL payload instead of inter-process communication. Closing the window counts as incomplete |
| O-083 | `ondra-port-picker` | Self-developed | Port selection | Probes available ports in the 9060 to 9079 loopback range and increments on conflict. Never binds a public address |
| O-084 | `ondra-dev-rebrand` | Self-developed | Development build renaming | Copies the runtime application and changes the display name and icon; re-signs layer by layer afterwards, otherwise the system refuses to launch; avoids confusing development and release builds in the process list |

---

## 13. B12 Multi-Option Branches (3 Plugins)

| ID | Plugin | Tier | Function | Implementation |
| --- | --- | --- | --- | --- |
| O-121 | `ondra-store-json` | Self-developed | JSONL persistence backend | Same interface as the SQLite port. Atomic writes use a temporary file plus rename. Provides a fallback when SQLite is unavailable or the database is corrupted. Disabled by default |
| O-122 | `ondra-memory-vector` | Self-developed | Vector retrieval branch and hybrid retrieval | Optional embedding model; hybrid retrieval combines BM25, vectors and reranking. Enabling condition is tiered by memory count: pure lexical below 300, hybrid from 300 to 1000, vector plus approximate nearest neighbor above 1000. Inverted index remains the default |
| O-123 | `ondra-emotion-hormone` | Self-developed | Hormone extension | See Chapter 5. Coexists with the core three dimensions as a read-only overlay; disabled by default |

---

## 14. B13 Extension Pool (27 Plugins)

The extension pool contains independently startable enhancements. All are disabled by default and enabled on demand after the core batches complete.

| ID | Plugin | Function |
| --- | --- | --- |
| O-097 | `ondra-grow` | Growth system with quantifiable progress and stage rewards, read-only metadata |
| O-098 | `ondra-persona-workshop` | Persona package workshop for creation, validation and export |
| O-099 | `ondra-memory-git` | Memory versioning with rollback and audit |
| O-100 | `ondra-memory-heal` | Memory self-healing with contradiction detection and repair suggestions |
| O-101 | `ondra-time-capsule` | Time capsule delivering messages to a future date |
| O-102 | `ondra-trust-dashboard` | Trust dashboard turning privacy state into a readable interface |
| O-103 | `ondra-forget-right` | Right to be forgotten with soft deletion and tombstones |
| O-104 | `ondra-redteam` | Red-team evaluation for stage violations, repetition and empty responses |
| O-105 | `ondra-digital-health` | Digital health guardrails and anti-dependency design |
| O-106 | `ondra-crisis` | Tiered crisis intervention protocol |
| O-107 | `ondra-first-meet` | Cold-start first-meeting script |
| O-108 | `ondra-absence` | Absence etiquette treating honesty as a persona asset |
| O-109 | `ondra-screen-sense` | Screen-aware companionship requiring explicit authorization |
| O-110 | `ondra-dev-companion` | Developer companionship with visible task state |
| O-111 | `ondra-ambient` | Keyboard and mouse reactivity with desktop physics |
| O-112 | `ondra-theater` | Multi-character on-screen theater |
| O-113 | `ondra-weekly` | Weekly diary summary |
| O-114 | `ondra-webhook-inbox` | Inbox for external event announcements |
| O-115 | `ondra-ritual` | Solar-term and festival rituals |
| O-116 | `ondra-study` | Study companion with spaced repetition |
| O-117 | `ondra-cocreate` | Co-creation for writing and brainstorming |
| O-118 | `ondra-consistency-bench` | Persona determinism evaluation pipeline |
| O-119 | `ondra-sandbox` | Tiered capability sandbox for plugins |
| O-120 | `ondra-daily-brief` | Morning briefing |
| O-146 | `ondra-browser-pane` | Built-in browser: plugin page registration, origin allowlist, no address bar (the interface half is `ui-browser-pane`) |
| O-147 | `ondra-beichen-api` | Beichen sign-up entry: locally generated master key, v1 minute-window tokens, one 302 hop |
| O-148 | `ondra-our-free-model` | Free-model channel layer: two keyless lanes (off by default) plus a registry of 76 aggregate channels |

---

## 15. Directory Structure

```
Ondra/
├── README.md                     Chinese primary document
├── README_EN.md                  Complete English version
├── NOTICE                        Third-party dependencies and license notices
├── LICENSE                       Full AGPL-3.0 text
├── package.json                  Repository metadata and root dependencies
├── .gitignore                    Ignore rules
├── index.html                    Official site homepage (EdgeOne deployment entry)
├── edgeone.json                  EdgeOne build command, output directory and cache headers
├── favicon.ico                   Site icon
├── icon.svg                      Single source for the app icon (plugin icon.svg files sync from it)
├── docs/                         Build and deployment notes
├── cordis/                       Plugin directory (133 plugins, all plugin packages)
│   ├── ondra-beichen-api/        Beichen sign-up entry (O-147)
│   ├── ondra-our-free-model/     Free-model channel layer (O-148)
│   └── ondra-browser-pane/       Built-in browser host half (O-146; the interface half is ui-browser-pane)
├── assets/                      Brand and site image assets
│   ├── icon/                    Layered macOS app icon sources (background/subject/breakout x Default/Dark/Tinted) plus the 1024 master
│   └── favicon-*.png            Site favicons at each size
├── content/                      Content assets shipped with the repository
│   └── personas/bundled/         Factory and sample personas (2 .skill.zip: 哦鲸鲸, 夏柠柒), read-only scanned by ondra-persona-loader
├── desktop/                      Desktop shell and runtime source
│   ├── apps/                     Application entry and build configuration
│   ├── packages/                 Host and client packages (workspace set)
│   ├── docs/                     Architecture, plugin tutorials, API reference
│   ├── scripts/                  Build and maintenance scripts
│   ├── website/                  Static official website
│   ├── snapshots/                Snapshot test baselines
│   └── vendor/                   Vendored Cordis and foundation libraries (9 items)
├── tools/                        Development helper scripts
├── toolchain/                    Toolchain cache (not committed; rebuilt by the installer)
├── build/                        Installer output (not committed)
└── .backup/                      Local backups (not committed)
```

**Uncommitted directories**: `toolchain/` holds the portable runtime cache, `build/` holds packaging output (macOS dmg, Windows nsis and the unpacked application), and `.backup/` holds local backups. All three can be rebuilt by the build or install pipeline and are excluded from version control to keep the repository size bounded.

**Persona package locations**: the factory and sample personas live in `content/personas/bundled/` (2 packages) and ship with the repository; other character personas are not distributed with the repository — place them in the user root to make them selectable. Personas are product assets and are never stored inside the plugin directory.

**Scan scope differs from the asset directory**: `ondra-persona-loader` resolves exactly two roots — the bundled root `content/personas/bundled/`, and the user root `~/.ondra/user/personas/` (`userSubdir` defaults to `personas` and is configurable). To make a character appear in the selectable list, place its zip in one of the two roots or point `bundledDir` at it.

---

## 16. Installation and Running

```bash
git clone https://github.com/ntars/Ondra.git
cd Ondra/desktop
pnpm install
pnpm run typecheck
pnpm start
```

The first launch runs the installation pipeline: environment detection, component download, integrity verification, profile assembly, bundle installation, privacy hardening, view setup, first-run onboarding and main process start. The data directory is `~/Library/Application Support/空谷 Ondra/` on macOS and `%APPDATA%\空谷 Ondra\` on Windows. Development builds use a separate directory with a `-dev` suffix. The application never writes to the user's dsh or agents configuration and does not occupy port 3080.

---

## 17. Configuration

Configuration has four layers, ordered by increasing priority: factory defaults, bundle defaults, user configuration and runtime overrides. Upgrades modify only the first two.

| Category | Setting | Default |
| --- | --- | --- |
| Persona | Persona package | 哦鲸鲸 |
| Persona | Relationship | Unset (one of five) |
| Emotion | Mood half-life | 4 hours |
| Emotion | Diffusion coefficient | 0.4 |
| Memory | Decay tier | standard |
| Memory | Injection budget | 2600 characters |
| Memory | Snapshot retention | 3 |
| Proactive | Quiet hours | 23:00 to 08:00 |
| Proactive | Daily quota | 3 |
| Proactive | Give-up rate | 35 percent |
| Speech | Speak aloud | Off |
| Speech | Sentence length | 6 to 30 characters |
| Rhythm | Chunk limit | 4 |
| Interface | Theme | Follow system |
| Privacy | Session log upload | Forced off |

Every change is written to the backend immediately; no setting lives only in the browser. Settings requiring a restart are labeled. Restoring defaults runs per category.

---

## 18. Interface and Performance

### 18.1 Interface

The local interface is mounted under a fixed prefix and requires token authentication through the `X-Ondra-Token` header. Core routes cover status, conversation with streaming, history, sessions, search, memory read and write, forget, emotion read and write, relationship stage, persona read and write, date facts, diary, stickers, market, channel switches, channel health, snapshots, prompt preview and health checks.

### 18.2 Measured Data

| Metric | Value | Condition |
| --- | --- | --- |
| Prefix cache hit rate | 99.3 to 99.6 percent | 5 sessions, 2001 requests |
| Cost change | CNY 879.97 to CNY 19.96 | Frozen prefix enabled |
| Tool definition compression | 55,154 to 8,433 tokens (84.7 percent) | Intent routing gate enabled |
| Browser snapshot compression | 315 KB to 5.4 KB (98 percent) | Output sandbox enabled |
| Memory injection volume | Constant within budget | 1000 memories capped at 24,000 characters |
| Recall truncation | 0 items | Unexpanded count is queryable |
| Decay example | 25.7 percent for a memory last touched 98 days ago with zero recalls | 12.6 percent at three, 9.2 percent at ten |
| Application bundle size | About 1.3 GB | Including bundled runtime |
| Workspace package count | 399 | Excluding dependency directories |

Cold start, first paint, time to first token and memory growth are not provided: these values depend heavily on hardware and model endpoint, so figures from elsewhere are not comparable.

---

## 19. Security and Privacy

1. **Local data**: Sessions, configuration, credentials, memory and workspace files reside in the application data directory and are not uploaded by default.
2. **Three privacy lines**: Configuration-level shutdown of session log upload (the only true defense, measured 0 of 3 requests carrying data), an environment telemetry switch, and a startup self-check on every launch. The application refuses to start when configuration has been altered.
3. **Egress inventory**: Package mirrors, runtime downloads, model endpoints, enabled channels and explicitly configured weather endpoints only. No telemetry, crash reporting, account verification or update checks.
4. **File permissions**: Directories 0700; memory database and credentials 0600.
5. **Local interface**: Token authentication, constant-time comparison and origin checks.
6. **Unencrypted memory is a deliberate trade-off**: Local encryption offers little protection against same-machine, same-user attacks while sacrificing the user's ability to inspect, export and repair data. The real defense is at the network layer.
7. **High-risk capabilities disabled by default**: Personal account channels, desktop automation and developer mode all require explicit enabling; personal channels require double confirmation.

---

## 20. Compatibility and Known Limitations

### 20.1 Platforms

macOS (Apple Silicon first, Intel supported) and Windows x64 are launch platforms. Linux build configuration exists but release is unverified. The mobile form factor is undecided; public wording is coming soon, with no beta commitment.

### 20.2 Runtime

Node.js 24 is bundled. The upstream baseline is `0.2.2-alpha.2`, and compatibility outside that range is not guaranteed. Local inference requires a user-provided OpenAI-compatible service.

### 20.3 Known Limitations

1. The 133 plugins are in staged delivery; unimplemented capabilities are explicitly marked as unsupported in this version.
2. Channels requiring public callbacks require a self-provided HTTPS address.
3. No proactive involvement in groups; only explicit mentions are answered.
4. Desktop automation is single-step only, with per-step confirmation for writes.
5. Vector retrieval is an optional branch; keyword and graph retrieval is the default.
6. License attribution for some dependencies still requires verification and is marked unconfirmed in NOTICE.

---

## 21. Changelog

### 1.2.0 (2026-11-04)

1. **L8 Interface retired**: 14 interface plugins (O-085 to O-096, O-124, O-125) never ran in production and are removed; the UI now lives in the app shell. Plugin count 144 to 130.
2. **Unified plugin icons**: every plugin uses the app icon. The single source of truth is the repository root `icon.svg`, synced by `tools/sync-plugin-icons.mjs` (`--check` verifies drift).
3. Handbook Part 7 (UI and Visualisation) is marked retired; its number is kept so later parts keep their `§7.x` references.

4. **macOS app icon rebuilt**: three-layer sources (background / subject / breakout) from the current brush mark, with the previously baked rounded corners and shadows removed and Default / Dark / Tinted appearances provided; the old orca icon has been deleted. See `assets/icon/README.md`.

5. **Three plugins added (O-146 to O-148)**, plugin count 130 to 133 (ledger number O-145 was already ruled "not built", so numbering starts at O-146):
   - `ondra-browser-pane` plus `@ntars/ondra-client-ui-browser-pane`: a minimal browser used only by built-in plugins. Pages are registered by plugins, the origin allowlist is enforced in one place, and there is no address bar and no input field. It ships as a host/interface pair because Cordis plugins in Ondra have no client-half loading mechanism (upstream dsh allows `client.js`).
   - `ondra-beichen-api`: the Beichen sign-up entry. It generates a master key locally (mode 0600, may share the same value as the EdgeOne deployment), mints v1 minute-window HMAC tokens, and issues a single 302 to the registration page after verification. No URL ever appears in the page, the affiliate code is only appended on that 302, and it never reaches the logs.
   - `ondra-our-free-model`: the free-model channel layer. Two keyless lanes (OpenCode / Kilo, **off by default, zero outbound traffic while off**) plus a registry of 76 aggregate channels (502 models, taken from upstream MIT-licensed data with the website promotion fields removed). It only produces pi-ai provider profiles and does not reimplement the transport; no degradation chain, no token saver, no usage dashboard, no in-app self-update.

6. **Right sidebar divider fixed**: the right panel now declares `box-sizing: border-box`, so the 0.5px hairline starts on a whole pixel instead of being spread across two device pixels by antialiasing. It now matches the left divider in weight, and the panel no longer overruns its track by half a pixel into the centre column. See `desktop/packages/client/ui-sidebar-right/src/client/shell/SidebarRight.module.css`.

7. **Persona packages moved out of the plugin directory**: factory and sample personas now ship from `content/personas/bundled/`. The default bundled root of `ondra-persona-loader` points there, and the old sibling directory is kept as a compatibility fallback.

8. **Repository slimmed**: the asset library, development notes, toolchain cache, packaging intermediates and installer output are no longer committed. The official site is defined by the repository-root `index.html`, `icon.svg`, `favicon.ico` and `assets/`; `tools/build-site.mjs` collects them into `dist/` for EdgeOne to publish.

### 1.0.1

1. Reorganized the plugin inventory into three reuse tiers per the development handbook, reducing self-developed items to fewer than 15.
2. Added 21 plugins: vision, speech recognition, multimodal memory, gap pool, threshold drift, eight pools, organ ABI, install self-check, climbing, narrative log, retrieval evaluation, lexical statistics and the seven context-governance plugins.
3. Unified service key naming to hyphens and required bundles to declare their patch file.
4. Unified the relationship model to seven stages and corrected the progress bar denominator to 7.
5. Confirmed Jingjing as the factory persona, with Xia Ningqi as a sample package.
6. Rewrote bilingual documentation at plugin granularity with one-to-one section correspondence.

### 1.0.0

1. First public release covering the conversation pipeline, memory, emotion, persona, channels, speech and main interface.
2. Shipped macOS and Windows installers with a one-click deployment pipeline.
3. Established the three privacy lines and the startup self-check.

---

## 22. Roadmap

| Phase | Content |
| --- | --- |
| Near term (before beta) | Deliver B0 to B6: foundation, storage and model gateway, memory depth, persona and emotion, expression, proactive behavior and restraint, runtime governance; complete the evaluation set; smoke-test both platform installers |
| Mid term | Deliver B7 to B11: channels, multimodal, device side, system and delivery; migrate the dialogue corpus and nine-step filter chain |
| Long term | Deliver B12 and B13: multi-option branches and extensions; evaluate the mobile form factor; establish an open persona format and evaluation pipeline |

---

## 23. Contributing

1. **Defect reports**: Provide reproduction steps, expected and actual behavior, environment details and log excerpts.
2. **Plugin development**: Follow the layering, dependency matrix and naming rules already established under `cordis/` (compare against sibling plugins' README and `package.json`). Each plugin must document its responsibilities, what it does not handle, its technical sources and isolation self-check results.
3. **Documentation**: Update Chinese and English together with one-to-one section correspondence.
4. **Assets**: Confirm the scope of authorization; do not submit text, images, audio or video of unknown origin.
5. **License obligations**: Released under AGPL-3.0. Distributing modified versions requires retaining LICENSE and NOTICE and providing complete source code on request.

---

## 24. Copyright and License

**This project**: Copyright © 2024–2026 Ntarstudio. Released under AGPL-3.0-or-later; the full text is in [LICENSE](LICENSE).

**Upstream**: DeepSeek-Harness and its ecosystem components are copyrighted by their respective authors under the MIT license. This project retains all upstream notices, and modifications are recorded in [NOTICE](NOTICE).

**Brand and persona**: Logos, icons and factory persona text are not covered by the AGPL grant; redistribution requires separate confirmation of ownership.

**Third-party components**: Names, versions, licenses, copyright holders and official addresses appear in [NOTICE](NOTICE). Entries with unconfirmed attribution are marked "see package LICENSE", with no inference made.

**Disclaimer**: This software is provided "as is", without warranty of any kind, express or implied. Users are responsible for evaluating fitness for purpose, and the authors accept no liability for consequences of use.

---

## 25. NOTICE Compliance Statement

This project ships a separate [NOTICE](NOTICE) maintained independently of this document; the two do not replace each other. NOTICE contains the project's own copyright and license statement, the upstream DeepSeek-Harness copyright and full MIT license text, item-by-item records for vendored dependencies with modification notes, complete lists of runtime and development dependencies, the authorization scope for brand assets and persona text, and legal clauses retained in the original English.

When distributing this software or a modified version, retain NOTICE and LICENSE in full and do not remove or alter the copyright and license statements they contain.
