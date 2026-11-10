/**
 * hidden-content's public API (frontend.md §2.3): types only, no runtime code. Another feature imports these with
 * `import type … from '…/hidden-content/public-api'` (feature-boundaries rule 1); everything else in this folder is
 * private to hidden-content. Step S2 seeded it with the types that code outside this folder imports today:
 * host/hidden-content-host.ts (C1 moved it here as host.ts).
 */
export type { HomeSurface, HomeSurfaceApi } from './home-model';
export type { AdminUser, HiddenDocument, HiddenItem, ListedItem, Settings } from './model';
export type { PageSurface } from './page-model';
// Step C4: the facade media-tags' item menu reads (features-remove-home.ts publishes it as `JE.homeRemoval`).
export type { HomeRemovalFacade } from './host';
