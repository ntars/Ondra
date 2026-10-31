/**
 * Host half of the command seat.
 *
 * Ondra ships no keyboard shortcuts: the sequence timing config, key routing,
 * and preference persistence are gone. The plugin row still mounts so the
 * `shortcuts` service seat exists for feature plugins, but it injects nothing
 * into product pages and reads no configuration.
 */
import type { Context } from '@deepseek-ai/cordis'

/**
 * Mount the inert command seat; the browser half provides the service.
 * @param _ctx - Host context; nothing is injected into served pages.
 */
export function apply(_ctx: Context): void {}
