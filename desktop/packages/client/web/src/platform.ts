/**
 * Shared browser platform modules. Seeding, bundling externals, and Vite
 * aliases consume this list so their module identities cannot drift.
 * @module @ntars/ondra-client-web/src/platform
 */

/** The module specifiers the shell shares into the frozen module table. */
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@ntars/cordis',
  'zod', '@tanstack/react-virtual',
  '@ntars/ondra-client-store',
  '@ntars/ondra-client-ui-slots',
  '@ntars/ondra-client-ui-primitives',
  '@ntars/ondra-client-ui-dockkit',
] as const

/** Client-bundle specifiers whose factories the parser preloads before the shell starts. */
export const PRELOADED_CLIENT_EXTERNALS = [
] as const

/** One platform module specifier (a seed-table key). */
export type PlatformModule = (typeof PLATFORM_MODULES)[number]
