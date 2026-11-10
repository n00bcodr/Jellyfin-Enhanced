/**
 * activity's public API (frontend.md §2.3): types only, no runtime code. Another feature imports these with
 * `import type … from '…/activity/public-api'` (feature-boundaries rule 1); everything else in this folder is
 * private to activity. Step S2 seeded it with the types that code outside this folder imports today:
 * none yet. C1: the social host types catchup's host uses.
 */
export type { RequestOptions, SocialApi, SocialSession } from './host';
