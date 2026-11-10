import type { CatchRuntime } from './types';
import type { SocialApi, SocialSession, RequestOptions } from '../activity/public-api';
import { featureContext, type FeatureContext } from '../../host/context';
export interface CatchHost {
 pluginConfig?: {CatchUpEnabled?: boolean; CatchUpUseCustomTabs?: boolean; CatchUpUseNativeTab?: boolean};
 themer?: {getThemeVariables(): {primaryAccent?: string; panelBg?: string; secondaryBg?: string}};
 internals: {catchUp?: CatchRuntime}; session?: SocialSession;
 t(key: string, params?: Record<string, string | number>): string; toast(message: string): void;
 core: {api: {jf(path: string, options?: RequestOptions): Promise<unknown>; plugin(path: string, options?: RequestOptions): Promise<unknown>}};
 helpers: {isActiveTabContainer(node: HTMLElement): boolean; observeTabContainers(name: string, selector: string, callback: () => void): unknown};
 nativeTabs: {register(id: string, title: string, mount: (panel: HTMLElement) => void, icon: string): void};
 catchUpPage?: {injectStyles(): void; renderPage(container?: HTMLElement): void};
}
interface CatchWindow extends Window {JellyfinEnhanced?: CatchHost; JE?: CatchHost; ApiClient?: SocialApi; Emby?: {Page?: {showItem(id: string): void}}}
/** catchup's own slots (frontend.md §2.3): the facade it publishes on JE and its JE.internals slot. */
export type CatchupOwn = Pick<CatchHost, 'catchUpPage'> & CatchHost['internals'];
/** catchup reads no other feature's facade. */
export type CatchupPeers = Record<never, never>;
export type CatchupContext = FeatureContext<CatchupOwn, CatchupPeers, CatchHost>;
/** `ctx` is undefined when the script loads before Jellyfin Enhanced (the entries then do nothing, as before). */
export function catchupHost() {
 const host: CatchWindow = window, JE = host.JellyfinEnhanced;
 const ctx: CatchupContext | undefined = JE && featureContext<CatchupOwn, CatchupPeers, CatchHost>('catchup', JE, {
  facades: ['catchUpPage'],
  internalSlots: ['catchUp'],
  internalsObject: () => JE.internals ??= {},
 });
 return {host, ctx, getApi: () => host.ApiClient, Emby: host.Emby};
}
