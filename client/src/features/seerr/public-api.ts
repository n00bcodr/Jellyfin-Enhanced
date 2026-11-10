/**
 * seerr's public API (frontend.md §2.3): types only, no runtime code. Another feature imports these with
 * `import type … from '…/seerr/public-api'` (feature-boundaries rule 1); everything else in this folder is
 * private to seerr. Step S2 seeded it with the types that code outside this folder imports today:
 * host/seerr-*-host.ts, host/bootstrap-pages-host.ts.
 */
export type { SeerrApiFacade, SeerrModalFacade, SeerrStatusFacade, SeerrUiFacade, SeerrUiInternals } from './core/contract';
export type { DiscoveryBaseFacade, DiscoveryConfigKey, DiscoveryFilterFacade, FeedKind, LoadMore, ScrollHint, ScrollOptions, ScrollState, SeerrResult } from './discovery/types';
export type { RecommendationsFacade, RecommendationsStage } from './recommendations/types';
