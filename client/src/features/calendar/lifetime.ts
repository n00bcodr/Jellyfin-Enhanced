import type {CalendarContext, CalendarHost} from './host';
export interface CalendarLifetime {
 view: number; navigation: number; refresh: number; events: number; userData: number; requests: number;
 initialized: boolean; disposers: Map<string, () => void>;
}
/** Owner is stored on the host, never in a bundled module-local singleton. */
export function lifetime(ctx: CalendarContext): CalendarLifetime {
 return ctx.own.calendarLifetime ||= {view:0,navigation:0,refresh:0,events:0,userData:0,requests:0,initialized:false,disposers:new Map()};
}
export function lease(ctx: CalendarContext, channel?: 'navigation' | 'refresh' | 'events' | 'userData' | 'requests') {
 const JE = ctx.core, owner = lifetime(ctx), view = owner.view, epoch = JE.session?.getEpoch(), session = JE.session?.createLease?.();
 const serial = channel ? ++owner[channel] : 0;
 const container = ctx.own.calendarPage?.state?._customTabContainer;
 return () => owner.view === view && (!channel || owner[channel] === serial) &&
  (epoch === undefined || JE.session?.isCurrent(epoch) === true) && (!session || session.isCurrent()) &&
  (!container || container.isConnected && JE.helpers.isActiveTabContainer(container));
}
/** Cancel only pending item navigation; refresh and request caches retain ownership. */
export function cancelNavigation(ctx: CalendarContext): void {
 lifetime(ctx).navigation++;
}
export function invalidate(ctx: CalendarContext): void {
 const owner = lifetime(ctx); owner.view++;
 const state = ctx.own.calendarPage?.state;
 if (state) {state.isLoading=false; state.requestedLoading=false;}
}
export function own(ctx: CalendarContext, key: string, dispose: () => void): void {
 const owner = lifetime(ctx); owner.disposers.get(key)?.(); owner.disposers.set(key,dispose);
}
export function disposeCalendar(ctx: CalendarContext): void {
 invalidate(ctx);
 const owner = lifetime(ctx); for (const dispose of owner.disposers.values()) dispose(); owner.disposers.clear(); owner.initialized=false;
 const state = ctx.own.calendarPage?.state;
 if (state) {state._customTabContainer=null;state.pageVisible=false;state.locationUnsubscribe=null;}
}
/** Migrate only after a successful scoped write; never delete a preference on storage failure. */
export function preferenceKey(JE: CalendarHost, storage: Storage, base: string): string {
 const legacyUser = JE.session?.userScopedKey(base) ?? `${base}:anonymous`;
 const server = JE.session?.getServerId?.();
 const scoped = server ? `${legacyUser}:server:${encodeURIComponent(server)}` : legacyUser;
 for (const old of [...new Set([legacyUser,base])]) {
  if (old === scoped) continue;
  try {
   const value = storage.getItem(old);
   if (value === null) continue;
   if (storage.getItem(scoped) === null) storage.setItem(scoped,value);
   storage.removeItem(old);
  } catch { /* Keep the old document if storage is unavailable. */ }
 }
 return scoped;
}
