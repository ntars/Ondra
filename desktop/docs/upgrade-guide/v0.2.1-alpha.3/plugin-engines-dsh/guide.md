---
kind: upgrade-guide
description: "Plugin compatibility checks read engines.ondra before Ondra peerDependencies, and refusals report requirements instead of peers."
---

# Plugin compatibility reads `engines.ondra` first

English | [中文](guide.zh.md)

## Change

In v0.2.1-alpha.3, installation and profile startup judged a plugin or bundle only by its `peerDependencies` on `@ntars/ondra` and `@ntars/ondra-*`, and ignored `engines.ondra`. In the next release, an own `engines.ondra` range decides alone and those peers are ignored; the peer rule applies only when `engines.ondra` is absent. `workspace:` values are valid only in peers; in `engines.ondra` they are incompatible. A non-object `engines` or a non-string `engines.ondra` makes the manifest unreadable for compatibility, which refuses the package. Plugin authors whose package declares `engines.ondra`, or declares `engines` as something other than an object, are affected.

The `incompatible-version` refusal record that the plugin manager returns to clients, `IncompatiblePlugin`, and the app-boot `PluginCompatibility` result rename `peers` to `requirements`. Keys are `engines.ondra` for the engines rule or the peer package name for the fallback. Code that reads these records is affected.

## Migration

1. If your package declares `engines.ondra`, make that range cover every Ondra release the package supports, because Ondra peer ranges no longer widen or narrow it. Remove `engines.ondra` to keep peer-based checking.
2. Replace `workspace:` values in `engines.ondra` with a semantic version range.
3. Read `requirements` instead of `peers` from `IncompatiblePlugin` and `PluginCompatibility`.
4. Confirm by installing the package with `ondra plugin --profile <profile> add <package@version>` or the plugin manager: a mismatch names `engines.ondra` or the peer package in the refusal.
