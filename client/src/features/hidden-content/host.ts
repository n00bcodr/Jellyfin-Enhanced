import { featureContext, type FeatureContext } from '../../host/context';
import type { HomeSurfaceApi, HomeSurface } from './home-model';
import type { PageSurface } from './page-model';
import type { HiddenDocument, HiddenItem, ListedItem, Settings, AdminUser } from './model';
export interface DialogOptions { surface?: string; showEpisodeChoice?: boolean; onChooseScoped?(): void; onChooseShow?(): void }
export interface HiddenDataSurface {
 hiddenIdSet: Set<string>;
 normalizeId(id: unknown): string;
 getHiddenData(): HiddenDocument;
 assertWritable():void;
 captureItemIntent(itemId:string):{current():boolean};
 isLoadOk():boolean;
 getSettings(): Settings;
 rebuildSets(): void; shouldFilterSurface(surface: string): boolean; emitChange(): void;
 refresh(): Promise<boolean>; markScopedHidden(id: string, scope?: string): void;
 isHidden(id: unknown): boolean; isHiddenByTmdbId(id: unknown): boolean;
 hideItem(item: HiddenItem): void; unhideItem(id: string): void; updateSettings(settings: Partial<Settings>): void;
 getAllHiddenItems(): ListedItem[]; getHiddenCount(): number;
 filterJellyseerrResults<T extends {id?: unknown; tmdbId?: unknown}>(items: T[], surface: string): T[];
 filterCalendarEvents<T extends {tmdbId?: unknown; itemId?: unknown; title?: string}>(items: T[]): T[];
 filterRequestItems<T extends {tmdbId?: unknown; id?: unknown; jellyfinMediaId?: unknown}>(items: T[]): T[];
 unhideAll(): void; resetFromUserConfig(): void;
 debouncedSave(): void; flushPendingSave(): Promise<void>;
 fetchHiddenContentUsers(): Promise<AdminUser[] | null>;
 fetchUserHiddenItemsForAdmin(userId: string): Promise<ListedItem[] | null>;
 adminUnhideForUser(userId: string, keys: string[]): Promise<boolean>;
 adminHideForUser(userId: string, items: HiddenItem[]): Promise<number | false>;
 showUndoToast(name: string, key: string, undo?:()=>void): void;
 refreshNativeCardVisibility(): void; restoreNativeCardsForIds(ids: Set<string>): void;
 confirmAndHide(item: HiddenItem, callback?: () => void, options?: DialogOptions): void;
 addLibraryHideButtons(): void; removeLibraryHideButtons(): void;
 getCardSurface(card: HTMLElement): string | null; getCardItemId(card: HTMLElement): string | null;
 isHiddenOnSurface(id: string, surface: string): boolean;
 filterNativeCards(): void; filterAllNativeCards(): void; setupNativeObserver(): void;
 injectCSS(): void; showManagementPanel(): void; createItemCard(item: HiddenItem, onNavigate?: () => void): HTMLElement;
}
export interface HiddenHost {
 internals?: { hiddenContentRuntime?: Runtime; features?:Partial<HomeSurfaceApi>; hiddenContent?: Partial<HiddenDataSurface>; hiddenContentPage?: Partial<PageSurface> };
 hiddenContent: Omit<HiddenDataSurface,'hiddenIdSet'|'normalizeId'|'getHiddenData'|'rebuildSets'|'shouldFilterSurface'|'emitChange'|'resetFromUserConfig'|'debouncedSave'|'refreshNativeCardVisibility'|'restoreNativeCardsForIds'|'getCardSurface'|'getCardItemId'|'filterAllNativeCards'|'setupNativeObserver'|'injectCSS'|'assertWritable'|'captureItemIntent'>;
 hiddenContentPage: Pick<PageSurface,'showPage'|'hidePage'|'renderForCustomTab'|'renderPage'|'injectStyles'> & {initialize():void};
 initializeHiddenContentPage?:()=>void;
 pluginConfig?:{HiddenContentEnabled?:boolean;HiddenContentAdmin?:boolean;HiddenContentUsePluginPages?:boolean;HiddenContentUseCustomTabs?:boolean;HiddenContentUseNativeTab?:boolean};
 core:{api:{fetch(url:string):Promise<unknown>};ui:{skeletonGridHtml(count:number,options:{minWidth:string;height:string;label:string}):string}};
 nativeTabs:{register(id:string,title:string,mount:(panel:HTMLElement)=>void,icon:string):void};
 currentSettings:{removeContinueWatchingEnabled?:boolean};
 state:{removeContext:{itemId:string;surface:string|null;card?:HTMLElement;ts:number}|null};
 addRemoveButton?:()=>void;addMultiSelectRemoveButton?:()=>void;
 detectCardSurface(el:Element|null):HomeSurface|null;
 initializeHiddenContent?: () => void;
 homeRemoval?: HomeRemovalFacade;
 jellyseerrAPI?: {search(term:string):Promise<unknown>;fetchMovieDetails(id:number):Promise<unknown>;fetchTvShowDetails(id:number):Promise<unknown>};
 jellyseerrMoreInfo?: {open(id:number,type:string):void};
 userConfig: { hiddenContent?: unknown };
 session?: {checkNow?(reason?:string):unknown; getEpoch():number; isCurrent(epoch:number):boolean; onUserChange(name:string,fn:()=>void):()=>void; userScopedKey(base:string):string};
 helpers: {isAdmin():boolean|null;onSidebarRebuilt(name:string,selector:string,callback:()=>void):void;observeTabContainers(name:string,selector:string,callback:()=>void):void;isActiveTabContainer(container:Element):boolean; addCSS?(id:string,css:string):void;
 debounce(callback:()=>void, delay:number):()=>void;
 onViewPage(callback:()=>void):void;
 onBodyMutation(name:string,callback:(mutations:MutationRecord[])=>void,options:{priority:number}):void;
 getItemCached?(id:string,options:{userId:string|null}):Promise<unknown> };
 detectCardRowSurface(card:Element):HomeSurface|null;
 hideEmptyHomeSections?():void;
 themer?: {getThemeVariables():{secondaryBg?:string;primaryAccent?:string;blur?:string;textColor?:string;panelBg?:string}};
 t(key:string, replacements?:Record<string,string|number>):string;
 toast?(message:string,duration?:number):void;
}
interface AjaxOptions { type:'GET'|'POST'; url:string; dataType?:'json'; data?:string; contentType?:string; headers?:Record<string,string> }
interface Api {accessToken?():string; getDisplayPreferences(id:string,userId:string,client:string):Promise<unknown>; getCurrentUserId():string|null; getUrl(path:string,query?:Record<string,string|number|boolean|null>):string; getItem(userId:string|null,id:string):Promise<unknown>; ajax(options:AjaxOptions):Promise<unknown> }
const browser: Window & { JellyfinEnhanced?:HiddenHost; ApiClient?:Api;Dashboard?:{alert(message:string):void};Emby?:{Notifications?:{show(options:{title:string;type:string;timeout:number}):void}} }=window;
if (!browser.JellyfinEnhanced || !browser.ApiClient) throw new Error('Hidden Content host unavailable');
export const host={ JellyfinEnhanced:browser.JellyfinEnhanced, Dashboard:browser.Dashboard, Emby:browser.Emby };
/** Resolve transport when an operation starts, never when an entry bundle loads. */
export function getApi():Api {
 const api=browser.ApiClient; if(!api)throw new Error('Hidden Content API unavailable'); return api;
}
/** Each property lives in the host registry; importing this adapter creates no state owner. */
export function registry(JE:HiddenHost, name:'features'): HomeSurfaceApi;
export function registry(JE:HiddenHost, name:'hiddenContent'): HiddenDataSurface;
export function registry(JE:HiddenHost, name:'hiddenContentPage'): PageSurface;
export function registry(JE:HiddenHost, name:'hiddenContent'|'hiddenContentPage'|'features') {
 const internals=JE.internals??={};
 if (name==='features') return internals.features??={};
 if (name==='hiddenContentPage') return internals.hiddenContentPage??={};
 const surface=internals.hiddenContent??={};
 // The proxy validates loader dependencies when used, while setters retain the legacy facade.
 return new Proxy(surface, {get(target,key) {
  if (typeof key!=='string') return Reflect.get(target,key);
  const value:unknown=Reflect.get(target,key);
  if (value===undefined) throw new Error(`Missing hidden-content loader dependency: ${key}`);
  return value;
 }});
}
/** hidden-content's own slots (frontend.md §2.3): its owner-only `JE.internals` slots (internals-owners.json). */
export type HiddenContentOwn = Pick<NonNullable<HiddenHost['internals']>, 'hiddenContent' | 'hiddenContentPage' | 'hiddenContentRuntime' | 'features'>;
/**
 * Other features' facades hidden-content reads: seerr's `jellyseerrAPI` and `jellyseerrMoreInfo`. seerr's
 * public-api.ts types the full facades; the structural types on `HiddenHost` (only the members read here) type them.
 */
export type HiddenContentPeers = Required<Pick<HiddenHost, 'jellyseerrAPI' | 'jellyseerrMoreInfo'>>;
export type HiddenContentContext = FeatureContext<HiddenContentOwn, HiddenContentPeers, HiddenHost>;
/** The context a hidden-content module gets (step C3): `core` is the bridge the module already holds. */
export function hiddenContentContext(JE:HiddenHost):HiddenContentContext {
 return featureContext<HiddenContentOwn, HiddenContentPeers, HiddenHost>('hidden-content', JE, {
  internalSlots: ['hiddenContent', 'hiddenContentPage', 'hiddenContentRuntime', 'features'],
  // Same expression as registry() and runtime() below.
  internalsObject: () => JE.internals??={},
 });
}
/**
 * hidden-content's `JE.homeRemoval` facade (step C4), published by features-remove-home.ts next to the helper itself:
 * Media Tags' item-menu row reuses the native action-sheet row builder. It forwards the `features` slot's member on
 * each access, as media-tags' `JE.internals?.features?.buildNativeActionSheetItem` read did.
 */
export interface HomeRemovalFacade { readonly buildNativeActionSheetItem?: HomeSurfaceApi['buildNativeActionSheetItem'] | undefined }
export function homeRemovalFacade(JE:HiddenHost):HomeRemovalFacade {
 return { get buildNativeActionSheetItem() { return JE.internals?.features?.buildNativeActionSheetItem; } };
}
interface Runtime { modules:Set<string>; view:number; policy:number; queues:Map<string,Promise<unknown>>; cleanups:Set<()=>void>; identityCleanups:Set<()=>void> }
function runtime(JE:HiddenHost):Runtime {
 const internals=JE.internals??={};
 if(internals.hiddenContentRuntime)return internals.hiddenContentRuntime;
 const state:Runtime={modules:new Set(),view:0,policy:0,queues:new Map(),cleanups:new Set(),identityCleanups:new Set()};
 internals.hiddenContentRuntime=state;
 const invalidate=()=>{state.view++;for(const cleanup of [...state.cleanups])cleanup();};
 window.addEventListener('hashchange',invalidate);
 window.addEventListener('popstate',invalidate);
 document.addEventListener('viewhide',invalidate);
 const invalidateIdentity=()=>{invalidate();for(const cleanup of [...state.identityCleanups])cleanup();};
 window.addEventListener('pagehide',invalidateIdentity);
 JE.session?.onUserChange('hidden-content-runtime',invalidateIdentity);
 return state;
}
export function installOnce(JE:HiddenHost,name:string):boolean {
 const modules=runtime(JE).modules;if(modules.has(name))return false;modules.add(name);return true;
}
export function onDispose(JE:HiddenHost,cleanup:()=>void):()=>void {
 const cleanups=runtime(JE).cleanups;cleanups.add(cleanup);return ()=>cleanups.delete(cleanup);
}
/** Dispose identity-owned UI on account change or page exit, while preserving SPA navigation. */
export function onIdentityDispose(JE:HiddenHost,cleanup:()=>void):()=>void {
 const cleanups=runtime(JE).identityCleanups;cleanups.add(cleanup);return ()=>cleanups.delete(cleanup);
}
/** A shared view generation rejects navigation away and back to the same route. */
export function lease(JE:HiddenHost,view=false) {
 JE.session?.checkNow?.('hidden-content-operation');
 const state=runtime(JE), version=state.view, api=getApi();
 const epoch=JE.session?.getEpoch(), userId=api.getCurrentUserId(), root=api.getUrl('/'), token=api.accessToken?.(), route=location.hash;
 return {api,destination:JSON.stringify([root,userId]),current:()=> {
  try {return browser.ApiClient===api && (epoch===undefined || JE.session?.isCurrent(epoch)===true)
   && api.getCurrentUserId()===userId && api.getUrl('/')===root && api.accessToken?.()===token
   && (!view || (location.hash===route && state.view===version));} catch {return false;}
 }};
}
/** Invalidate queued visibility decisions when the current policy changes. */
export function invalidatePolicy(JE:HiddenHost):void {runtime(JE).policy++;}
/** Bind a visibility batch to the policy and view that produced it. */
export function policyLease(JE:HiddenHost) {
 const token=lease(JE,true), state=runtime(JE), policy=state.policy;
 return {current:()=>token.current() && state.policy===policy};
}
/** Order writes per destination document; unrelated accounts never wait for its transport. */
export function enqueueWrite<T>(JE:HiddenHost,operation:(api:Api)=>Promise<T>):Promise<T> {
 const token=lease(JE),queues=runtime(JE).queues;
 const previous=queues.get(token.destination)??Promise.resolve();
 const next=previous.catch(()=>undefined).then(()=>{if(!token.current())throw new Error('Stale hidden-content write');return operation(token.api);});
 queues.set(token.destination,next);
 const release=()=>{if(queues.get(token.destination)===next)queues.delete(token.destination);};
 void next.then(release,release);
 return next;
}
/** Wait only for this document, retaining its barrier if the user leaves and returns. */
export function pendingWrites(JE:HiddenHost):Promise<unknown>{
 const token=lease(JE);return runtime(JE).queues.get(token.destination)??Promise.resolve();
}
export function selectionLease(JE:HiddenHost,checkEditing=true){
 const token=lease(JE,true),state=registry(JE,'hiddenContentPage').state;
 const version=state.adminLoadToken,uid=state.selectedAdminUserId,editing=state.adminEditMode;
 return {current:()=>token.current() && state.adminLoadToken===version && state.selectedAdminUserId===uid && (!checkEditing || state.adminEditMode===editing)};
}
