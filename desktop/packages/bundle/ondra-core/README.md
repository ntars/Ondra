---
description: "The 空谷 Ondra persona bundle: 133 cordis persona-side plugins stacked as ONE installable patch layer over a host profile."
kind: "package-bundle"
---

# @ntars/ondra-core

[中文](README.zh.md) | English

## Summary

`@ntars/ondra-core` installs the full 空谷 Ondra persona-side plugin set — identity, path layout, memory, persona, emotion, chat channels, on-device endpoints, and delivery — as a single patch layer for `ondra --profile`. Its substance is `cordis.patch.yml` (declared by the `ondra.bundle.patch` manifest field): one `insert` that appends 133 rows keyed by plugin id. Row order carries no load semantics; activation is service-availability driven. The two chat-channel adapters that depend on external credentials (`ondra-adapter-qq-official`, `ondra-adapter-qq-napcat`) ship with `disabled: true` and are enabled by a later patch or the user's profile patch (last write wins per row).

You usually do not operate on this package directly. Add it to a profile by referencing the package name in the profile's bundle list; the launcher links the 133 plugins as workspace members of the host tree (`../cordis/*`) and resolves them through the manifest. This package is not a library to import.

## What you get

- 133 plugins across the nine layers (L0 identity → L9 extension pool), each with its own `cordis.patch.yml`, locale files, and service keys verified closed (0 dangling, 0 multi-owner).
- Two QQ channel adapters present but `disabled` until credentials exist.
- No runtime API: the module is an empty stub; the bundle is patch-only.

## Changing the defaults

Every row can be overridden by a later patch layer or the user's profile `cordis.patch.yml`: restate the row by `id` with the desired `config` (or `disabled`). A patch replaces the targeted row's whole `config` rather than merging into it.
