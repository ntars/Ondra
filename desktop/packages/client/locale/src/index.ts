/** Host registration for the browser locale preference. */
import type {} from '@ntars/ondra-settings'

import type { Volatile, Context } from '@ntars/cordis'

import z from '@ntars/schemastery'
import { LOCALE_PREFERENCE_FIELD } from './locale-settings.ts'

import { LocaleSettingsFields } from './locale-settings.ts'

export {
  LOCALE_IDS, LOCALE_PREFERENCE_FIELD, LOCALE_SETTINGS_NAMESPACE,
  type BuiltInLocaleId, type LocaleId, type LocaleSettings,
} from './locale-settings.ts'

/** Runtime preferences projected to the browser. */
export interface Config {
  /** Explicit locale; omission follows the browser. */
  preference: Volatile<string | undefined>
}

/** Live preferences projected to the browser. */
export const Config = z.object({
  [LOCALE_PREFERENCE_FIELD]: LocaleSettingsFields[LOCALE_PREFERENCE_FIELD].volatile(),
})

/** Host preferences are consumed through the configuration form projection.
 * @param ctx Plugin context used for optional settings presentation.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
}
