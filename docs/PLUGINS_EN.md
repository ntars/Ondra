# Ondra · Plugin and Settings Reference

> This file is the full expansion of Chapter 3 of [README](./README_EN.md), covering the responsibility, configurable fields, defaults and ranges of all 78 packages.
> The README covers only the three core mechanisms (emotion, memory, context) plus an overview of everything else; field-level detail lives here.
> Field definitions follow the `FIELD_SPECS` declaration in each plugin's `src/settings.ts`.

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
