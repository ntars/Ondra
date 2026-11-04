/**
 * ondra-jobs' owned branded id, carried across the registry, the model-facing
 * control surface, and the client wire.
 *
 * It lives in its own leaf because the package root and `./types` both reach
 * `ondra-agent` through the owner and listener signatures, which a Client program
 * cannot resolve even as a type. A browser-safe consumer imports the id here;
 * `Branded<B>` itself comes from the zero-dependency `@ntars/ondra-brand`.
 *
 * @module @ntars/ondra-jobs/brand
 */

import type { Branded } from '@ntars/ondra-brand'

/**
 * Identifies one job across registry lifetimes. The registry generates `<kind>-<short-uuid>`;
 * access still requires owner authorization.
 */
export type JobId = Branded<'JobId'>

/**
 * Brand a string as a {@link JobId}.
 * @param id - the raw job-id string (the registry generates 16 UUID hex characters after the kind).
 * @returns the same string, branded; no validation is performed.
 */
export function JobId(id: string): JobId {
  return id as JobId
}
