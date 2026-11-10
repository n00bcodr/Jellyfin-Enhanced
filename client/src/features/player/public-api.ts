/**
 * player's public API (frontend.md §2.3): types only, no runtime code. Another feature imports these with
 * `import type … from '…/player/public-api'` (feature-boundaries rule 1); everything else in this folder is
 * private to player. Step S2 seeded it with the types that code outside this folder imports today:
 * host/player-host.ts (C1 moved it here as host.ts).
 */
export type { MediaSegment } from './wire';
