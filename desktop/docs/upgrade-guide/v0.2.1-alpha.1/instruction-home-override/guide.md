---
kind: upgrade-guide
description: "The `agent-instructions` row no longer accepts `ondraHome`; instruction loading always resolves the harness home from `$ONDRA_HOME` or `~/.ondra`."
---

# Instruction loading resolves one harness home

English | [中文](guide.zh.md)

## Change

`@ntars/ondra-agent-instructions` removed its `ondraHome` config field. The plugin resolves the harness home through `resolveOndraHome()` from `@ntars/ondra-home-paths`, like every other harness consumer: the home is `$ONDRA_HOME` when it is set and non-blank, otherwise `~/.ondra`, with tilde expansion.

A `cordis.yml`, profile patch, or `--patch` overlay that still sets `ondraHome` on the `agent-instructions` row has no effect: the row keeps the stray key and the plugin ignores it, so instruction loading follows the process home. Other providers, such as `ondra-skill-filesystem` and `ondra-shell-env`, keep their own home fields; this removal covers the instruction loader only.

## Migration

1. Delete `ondraHome` from the `agent-instructions` row in `cordis.yml`, `$ONDRA_HOME/cordis.patch.yml`, `$ONDRA_HOME/profiles/<profile>/cordis.patch.yml`, and any `--patch` overlay.
2. Where the override pointed at a non-default home, export `ONDRA_HOME` for the process instead, so every harness consumer reads that home.
3. Confirm with `ondra --profile <profile> --dump-config` that the `agent-instructions` row lists only its remaining fields, and that a new session's first request shows `Instructions from: $ONDRA_HOME/AGENTS.md` (or `~/.ondra/AGENTS.md`) when that file exists.
