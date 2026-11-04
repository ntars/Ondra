/**
 * Virtual root of the worker host's in-memory filesystem. Kept
 * in one module so the process shim, the path/os shims, and the VFS image
 * collector cannot drift apart.
 */

/** Virtual filesystem root; `process.cwd()` and every absolute path start here. */
export const ONDRA_ROOT = '/ondra'

/** `$ONDRA_HOME`: durable-state directory inside the image. */
export const ONDRA_HOME = `${ONDRA_ROOT}/home`

/** Flat, symlink-free package tree resolved by the worker module loader. */
export const ONDRA_NODE_MODULES = `${ONDRA_ROOT}/node_modules`

/** Image configuration directory: the VFS manifest and the shipped agent presets. */
export const ONDRA_CONFIG = `${ONDRA_ROOT}/config`

/** Default (empty) workspace directory. */
export const ONDRA_WORKSPACE = `${ONDRA_ROOT}/workspace`

/** Temporary directory reported by `os.tmpdir()`. */
export const ONDRA_TMP = `${ONDRA_ROOT}/tmp`
