import { featureContext, type FeatureContext } from '../../host/context';
export interface SocialSession {
 getEpoch(): number; isCurrent(epoch: number): boolean;
 onUserChange(name: string, callback: () => void): (() => void) | void;
}
export interface RequestOptions { skipCache?: boolean; skipRetry?: boolean; method?: string; body?: unknown }
export interface ActivityHost {
 pluginConfig?: { ActivityFeedEnabled?: boolean; ActivityFeedUseCustomTabs?: boolean; ActivityFeedUseNativeTab?: boolean;
 ActiveStreamsEnabled?: boolean; ActivityFeedShowActiveStreams?: boolean; ActivityFeedShowWatched?: boolean; ActivityFeedShowFavorited?: boolean; ActivityFeedShowReviewed?: boolean };
 session?: SocialSession;
 t(key: string): string;
 themer?: {getThemeVariables(): {primaryAccent?: string}};
 core: {api: {plugin(path: string, options?: RequestOptions): Promise<unknown>};
 ui: {skeletonGridHtml(count: number, options: {minWidth: string; height: string}): string};
 lifecycle: {register(name: string): {track(dispose: unknown): void; teardown(): void}};
 navigation: {onNavigate(callback: () => void): unknown}};
 helpers: {isActiveTabContainer(node: HTMLElement): boolean; observeTabContainers(name: string, selector: string, callback: () => void): unknown;
 onBodyMutation?(name: string, callback: (records: MutationRecord[]) => void): {unsubscribe(): void}};
 nativeTabs: {register(id: string, title: string, mount: (panel: HTMLElement) => void, icon: string): void};
 activityPage?: {injectStyles(): void; renderForCustomTab(host: HTMLElement): Promise<void>; stopPolling(): void};
 initializeActivityIcons?(): void; stopActivityIconsMonitoring?(): void;
}
export interface SocialApi {getCurrentUserId(): string; getUrl(path: string, query?: Record<string, string | number>): string;
 getImageUrl(id: string, options: {type: string; width: number; quality: number; tag?: string}): string}
interface ActivityWindow extends Window {JellyfinEnhanced?: ActivityHost; JE?: ActivityHost; ApiClient?: SocialApi; Emby?: {Page?: {showItem(id: string): void}}}
/** activity's own slots (frontend.md §2.3): the facades it publishes on JE. It has no JE.internals slot. */
export type ActivityOwn = Pick<ActivityHost, 'activityPage' | 'initializeActivityIcons' | 'stopActivityIconsMonitoring'>;
/** activity reads no other feature's facade. */
export type ActivityPeers = Record<never, never>;
export type ActivityContext = FeatureContext<ActivityOwn, ActivityPeers, ActivityHost>;
/** `ctx` is undefined when the script loads before Jellyfin Enhanced (the entries then do nothing, as before). */
export function activityHost() {
 const host: ActivityWindow = window, JE = host.JellyfinEnhanced;
 const ctx: ActivityContext | undefined = JE && featureContext<ActivityOwn, ActivityPeers, ActivityHost>('activity', JE, {
  facades: ['activityPage', 'initializeActivityIcons', 'stopActivityIconsMonitoring'],
 });
 return {host, ctx, getApi: () => host.ApiClient, Emby: host.Emby};
}
