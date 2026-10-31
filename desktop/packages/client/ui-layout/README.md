---
description: "Shell layout for the Web GUI: the three-column AppFrame whose right column is a track for an edge-anchored panel, the panel-geometry service, and theme presentation; for users and maintainers of the window chrome."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-layout

English | [中文](README.zh.md)

## Summary

This package provides the Web GUI's three-column AppFrame, edge-column widths, and `ctx.layout` presentation control. The right column concedes space before the center, and its occupant draws one permanent column rather than a presentation the frame has to model. The theme presenter owns color scheme, alias tokens, font sizes, font lists, and document metadata. Layout state resets on reload.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The frame binds no collapse command, because the column never collapses; the shortcuts seat is inert (ui-shortcuts ships no catalog), so no key toggles a column.

The root slot composes the sidebar, main content, and right column. All three tracks come from a fixed quarter split (columns.ts): the left column takes 1/4, the centre 2/4, and the right column 1/4, none of them resizable and none collapsible. The right column's quarter is reserved from the first paint; its occupant reports whether it is shown and whether it keeps the track.

Global panels occupy the root-scoped `main` keyed slot; `conversation` is the reserved key for the Conversation. `ctx.layout.selectPanel(id)` selects a registered panel, and `null` selects the Conversation without changing the current Session. The Plugins page contributes one of the shipped global panels.

The single root-scoped `shell.bottom` slot spans the full width below the three columns. Its occupant controls its own height and visibility; the columns shrink by that height, and empty content reserves no space. Main-panel navigation preserves the bottom component. Column resize handles stop above it, while `shell.overlay` covers the whole frame. The default composition leaves this slot empty.

<a id="window-chrome-seat"></a>
### Window-chrome seat

On macOS desktop (`html[data-platform='darwin']`, set only by the desktop preload) a collapsed sidebar hides its column entirely instead of keeping the rail, and the frame mounts the single root-scoped `shell.leading` seat at its top-left — beside the hiddenInset traffic lights, over every main panel; ui-sidebar occupies it with the reopen and New Session controls. While the seat is mounted the frame publishes `--dsh-frame-leading-clearance`, the inline band the window chrome occupies measured from the frame's left edge; a main panel whose content reaches the top-left corner pads by it so nothing lands under the lights or the controls. The frame also always publishes `--dsh-frame-top-clearance` (48px) on the root element, the constant step below the window's top strip; entry pages in the main panel (plugin manager and similar, not the conversation) pad their top by it. The frame declares no darwin drag of its own: every chrome row marks itself `data-window-drag`, ui-web base.css turns that mark into the one darwin drag rule, and the row's own box is therefore the window's draggable geometry — a row's blank runs drag while its controls stay clickable. The frame's remaining drag rule is the Windows caption row, which belongs to that platform.

Windows Electron's `data-windows-titlebar` marker reserves the caption height above all columns and removes the collapsed sidebar rail. Only the content area's top-left corner has a 16px radius; the other corners and the internal divider remain square. The frame publishes `--dsh-windows-content-radius` for its own top-left corner and `--dsh-windows-sidebar-width` so that column can clear the expanded sidebar. Ordinary Web documents do not receive the marker; macOS retains its separate layout.

The root publishes `--dsh-frame-top-clearance` for the reserved strip (48px on macOS, the caption height on Windows), and `--dsh-frame-overlay-top` adds 20px for dialogs and menus. Native fullscreen reduces the overlay inset to 20px; dialogs retain their own 24px minimum. `--dsh-frame-chrome-top` excludes the Windows caption from modal mask painting and becomes zero in fullscreen. The full-viewport modal layer still blocks background clicks. Plain browser documents publish none of these values.

### Theme presentation

The presenter consumes resolved theme snapshots and projects them onto the document: `html { color-scheme }` for native UA chrome, `body[data-ds-dark-theme]` from the active color scheme, the theme's alias tokens, `--dsh-content-font-size`, `--dsh-code-font-size`, `--dsh-terminal-font-size`, and each non-empty `--dsh-font-family-<role>` list as inline variables on body, and one owned `<meta name="theme-color">` whose content follows the computed body background. Disposing the presenter removes its metadata node with its other global writes.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`selectPanel(id)` checks the live `main` registry before changing selection; an absent key throws and leaves the current panel intact. `beginNavigation()` returns an abort signal for an asynchronous UI navigation. A later call, a valid panel selection (including repeated selection), or layout disposal aborts that signal without cancelling underlying Session creation. Consumers check the signal before committing navigation or moving drafts.

One registration declares the frame slots and binds `ctx.layout` methods `selectPanel`, `openRightbar(track)`, and `closeRightbar`. One root store separates `panelInfo` selection from `layoutInfo` measurements and right-panel reports. `ctx.layout.panelInfo` and the standard `usePanelInfo` hook share the same selection source; AppFrame subscribes to the stable layout object. The frame's columns are fixed (columns.ts), so the store records only whether each side column is open — never a width, a collapse flag, or a presentation — and `openRightbar` takes the occupancy flag alone. AppFrame keeps the column containers mounted. The right column's root controller renders `rightbar.session` through `SessionProvider` only while the Conversation is selected; its unmount report releases the track. The independent title component uses the selected Session title only while the Conversation is visible, with the build-configured product title or localized `common.brand.localBuild` as its fallback; locale revisions update that fallback. The theme presenter is a second effect: pure DOM writes from resolved snapshots — initial state through the getter once, then event-driven only, with no React path. It applies palette, font-size, font-list, and token variables before measuring the rendered background as the single color authority.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the layout surface is not enough. They move from the frame to the columns it renders and the theme it presents.

- [ui-sidebar](../ui-sidebar/README.md) — occupies the `sidebar` column and its seats.
- [ui-conversation](../ui-conversation/README.md) — occupies the `main` key `conversation`.
- [ui-sidebar-right](../ui-sidebar-right/README.md) — occupies the `rightbar` column with one docking surface per session.
- [ui-theme](../ui-theme/README.md) — the theme seam whose resolved snapshots the presenter consumes.
- [Web client architecture](../../../docs/subsystems/web-client.md) — how browser plugin rows load and register slots.

-----

<a id="model-experience"></a>
## Model Experience

None, as the layout shell manages browser viewing state; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current layout behavior. They are current package constraints, not a general window-manager comparison or a task backlog.

- **Panel geometry is transient** — reload restores the sidebar open and the right panel hidden; the proportions are recomputed from the live frame width, so no preference is stored.
- **Extremely narrow windows** — the two side columns keep their quarter each and the centre absorbs the remainder, which may fall below 400px; the frame never collapses a side column to reclaim space.
- **No transition covers the tracks** — the split is fixed and no state writes it at pointer cadence, so the frame carries no track transition and no reduced-motion exception for one.
- **No scroll anchoring during squeeze reflow** — layout changes may move the reader's viewport.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
