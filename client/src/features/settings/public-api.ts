/**
 * settings's public API (frontend.md §2.3): types only, no runtime code. Another feature imports these with
 * `import type … from '…/settings/public-api'` (feature-boundaries rule 1); everything else in this folder is
 * private to settings. Step S2 seeded it with the types that code outside this folder imports today:
 * none yet.
 */
export {};
