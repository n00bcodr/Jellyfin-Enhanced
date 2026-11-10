/**
 * calendar's public API (frontend.md §2.3): types only, no runtime code. Another feature imports these with
 * `import type … from '…/calendar/public-api'` (feature-boundaries rule 1); everything else in this folder is
 * private to calendar. Step S2 seeded it with the types that code outside this folder imports today:
 * host/calendar-host.ts (C1 moved it here as host.ts), host/bootstrap-pages-host.ts.
 */
export type { CalendarLifetime } from './lifetime';
export type { CalendarEvent, CalendarFacade, CalendarInternal } from './types';
