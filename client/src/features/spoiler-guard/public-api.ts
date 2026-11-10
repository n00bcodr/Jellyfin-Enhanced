/**
 * spoiler-guard's public API (frontend.md §2.3): types only, no runtime code. Another feature imports these with
 * `import type … from '…/spoiler-guard/public-api'` (feature-boundaries rule 1); everything else in this folder is
 * private to spoiler-guard. Step S2 seeded it with the types that code outside this folder imported then: none.
 */
import type { SpoilerBlurForwards } from './host';

/**
 * The `JE.spoilerBlur` members seerr (more-info modal) and settings-panel (panel shell) read through
 * `ctx.peer('spoilerBlur')` (step C4): each forwards, on every access, the `JE.internals.spoilerGuard` registry member.
 */
export type SpoilerBlurPeerApi = SpoilerBlurForwards;
