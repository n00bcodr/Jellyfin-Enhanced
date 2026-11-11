import type { CalendarLifetime } from './lifetime';
import { featureContext, type FeatureContext } from '../../host/context';
import type { CalendarEvent, CalendarInternal, CalendarFacade } from './types';
interface Settings { calendarDefaultViewMode?: string; calendarDisplayMode?: string }
interface Lifecycle {
 track<T extends (() => void) | {disconnect(): void}>(resource: T): T;
 untrack(resource: () => void): void; teardown(): void;
 addListener(target: EventTarget, type: string, callback: (event: Event) => void, capture?: boolean): void;
}
export interface CalendarHost {
 internals: {calendarLifetime?: CalendarLifetime; calendarPage?: Partial<CalendarInternal>}; calendarPage?: CalendarFacade;
 initializeCalendarPage?: () => void;
 currentSettings?: Settings; loadSettings?(): Settings;
 saveUserSettings?(file: string, settings: Settings): unknown;
 pluginConfig?: {
 CalendarPageEnabled?: boolean; CalendarUsePluginPages?: boolean; CalendarUseCustomTabs?: boolean; CalendarUseNativeTab?: boolean;
 CalendarFirstDayOfWeek?: string; CalendarTimeFormat?: string; CalendarHighlightFavorites?: boolean; CalendarHighlightWatchedSeries?: boolean;
 CalendarForceOnlyRequested?: boolean; CalendarShowOnlyRequested?: boolean; CalendarFilterByLibraryAccess?: boolean;
 JellyseerrEnabled?: boolean; ShokoConfigured?: boolean; ShokoUrl?: string; ShokoUrlMappings?: string;
 };
 session?: {userScopedKey(base: string): string; getEpoch(): number; isCurrent(epoch: number): boolean; getServerId?(): string | null; getUserId?(): string | null; createLease?(): {isCurrent(): boolean}; onUserChange(name: string, callback: () => void): (() => void) | void};
 t(key: string, params?: Record<string, string | number>): string; escapeHtml(value: string | undefined): string; toast?(message: string): void;
 cdn: {selfhst(path: string): string}; themer?: {getThemeVariables(): {primaryAccent?: string}};
 helpers: {escHtml?(value: unknown): string; onNavigate?(callback: () => void): () => void;
 onSidebarRebuilt(id: string, selector: string, callback: () => void): () => void;
 isActiveTabContainer(element: HTMLElement): boolean;
 observeTabContainers(id: string, selector: string, callback: () => void): {teardown(): void};};
 nativeTabs: {register(id: string, title: string, mount: (panel: HTMLElement) => void, icon: string): void};
 core: {api: {plugin(path: string, options?: {method: string; body: unknown}): Promise<unknown>}; mediaLanguage?: {uiLocale?(): string | undefined};
 ui: {injectCss(id: string, css: string): void; skeletonGridHtml(count: number, options: {minWidth: string; height: string; label: string}): string};
 lifecycle: {register(name: string): Lifecycle}};
}
interface HostWindow extends Window { JellyfinEnhanced?: CalendarHost; ApiClient?: {serverAddress?(): string; getImageUrl(id: string, options: {type: string; quality: number}): string} }
/**
 * calendar's own slots (frontend.md §2.3): its JE.internals slots and the initializeCalendarPage facade. The
 * `JE.calendarPage` facade stays on the typed bridge: it has the same name as the `JE.internals.calendarPage` slot,
 * and `own` is a single namespace (featureContext throws on a duplicate key).
 */
export type CalendarOwn = Pick<CalendarHost, 'initializeCalendarPage'> & CalendarHost['internals'];
/**
 * The peer facade calendar reads: hidden-content's `JE.hiddenContent` (published by hidden-content only). Declared
 * here with the one member calendar calls, because hidden-content/public-api.ts does not export that facade's type.
 */
export interface CalendarPeers { hiddenContent: {filterCalendarEvents(events: CalendarEvent[]): CalendarEvent[]} }
export type CalendarContext = FeatureContext<CalendarOwn, CalendarPeers, CalendarHost>;
/** Only this adapter touches the legacy namespace. Each ordered entry fills its declared facade slots. */
export function calendarHost() {
 const host: HostWindow = window;
 const JE = host.JellyfinEnhanced;
 if (!JE) throw new Error('Calendar loaded before Jellyfin Enhanced');
 JE.internals ||= {};
 const partial = JE.internals.calendarPage ||= {};
 // The production loader establishes data -> render -> actions -> init order.
 // This assertion describes that explicit staged facade, not an untrusted response.
 const P = partial as CalendarInternal;
 const ctx: CalendarContext = featureContext<CalendarOwn, CalendarPeers, CalendarHost>('calendar', JE, {
  facades: ['initializeCalendarPage'],
  internalSlots: ['calendarLifetime', 'calendarPage'],
  internalsObject: () => JE.internals ||= {},
 });
 return {JE, ctx, host, P};
}
