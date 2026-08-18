/**
 * Package-owned invariant companion for `dsh-workspace-guard`.
 * @module dsh-workspace-guard/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-workspace-guard'

/** Cordis companion plugin name. */
export const name = 'workspace-guard-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package owns no durable state, events, or service
 * registrations. It monkey-patches existing services and restores them on
 * disposal. Nothing is registered into a registry that needs a runtime check
 * beyond the package-name ownership the companion reserves.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
