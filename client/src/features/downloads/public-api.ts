/**
 * downloads's public API (frontend.md §2.3): types only, no runtime code. Another feature imports these with
 * `import type … from '…/downloads/public-api'` (feature-boundaries rule 1); everything else in this folder is
 * private to downloads. Step S2 seeded it with the types that code outside this folder imports today:
 * host/downloads-host.ts (C1 moved it here as host.ts), host/bootstrap-pages-host.ts.
 */
export type { Page, PublicPage } from './types';
