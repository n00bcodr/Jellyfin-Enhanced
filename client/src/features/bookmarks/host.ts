import type { BookmarkDocumentResponse, BookmarkOperation, BookmarkSaveReceipt, JsonValue } from '../../contracts/generated';
import { bootstrapSchema } from '../../contracts/schema';
import { validateSchema } from '../../contracts/validate';
import { featureContext, type FeatureContext } from '../../host/context';
import type { BookmarkApi,BookmarkDocument,BookmarkMap,Item,Library,Owner } from './types';
interface Ajax { type: string; url: string; dataType?: string; contentType?: string; data?: string }
export interface BookmarkHost {
 pluginConfig?: { BookmarksEnabled?: boolean; BookmarksUsePluginPages?: boolean; BookmarksUseCustomTabs?: boolean; BookmarksUseNativeTab?: boolean };
 userConfig: Owner; bookmarks: BookmarkApi; internals: { bookmarksLibrary?: Partial<Library>; bookmarkLifetimes?: Record<string, {dispose(): void}> };
 session?: { getEpoch(): number; isCurrent(epoch: number): boolean; onUserChange(name: string, callback: () => void): (() => void) | void };
 t(key: string): string; toast(message: string, duration?: number): void; escapeHtml(text: string | undefined): string;
 isVideoPage(): boolean; initializeBookmarks(): void; cleanupBookmarks(): void;
 saveUserSettings(file: string, data: unknown, options: { throwOnError: true }): Promise<unknown>;
 nativeTabs: { register(id: string, title: string, mount: (panel: HTMLElement) => void, icon: string): void };
 helpers: {
 getItemCached?(id: string, options: {userId: string | null}): Promise<unknown>;
 debounce<T extends unknown[]>(callback: (...args: T) => void, delay: number): (...args: T) => void;
 disconnectObserver(id: string): void; createObserver(id: string, callback: () => void, node: Node, options: MutationObserverInit): void;
 isActiveTabContainer(node: HTMLElement): boolean;
 onSidebarRebuilt(id: string, selector: string, callback: () => void): unknown;
 observeTabContainers(id: string, selector: string, callback: () => void): unknown;
 };
 core: {
 api: { fetch(url: string): Promise<unknown> };
 lifecycle: { register(name: string): {addListener(target: EventTarget, event: string, callback: (event: Event) => void, capture?: boolean): void} };
 navigation: { onViewPage(callback: (view: unknown, element: unknown, hash: unknown, item: unknown, event: Event | null) => void): unknown; onNavigate(callback: () => void): unknown };
 };
}
interface Api {
 accessToken?(): string; getCurrentUserId(): string | null; getUrl(path: string, query?: Record<string, string>): string; ajax(options: Ajax): Promise<unknown>;
 getItem(userId: string | null, id: string): Promise<unknown>;
 getImageUrl(id: string, options: {type: string; maxWidth: number; tag?: string | undefined}): string;
 _deviceId?: string; deviceId(): string;
}
export interface HostWindow extends Window {
 JellyfinEnhanced?: BookmarkHost; JE?: BookmarkHost; ApiClient?: Api;
 ConnectionManager?: {currentApiClient(): Api | undefined};
 Emby?: {Page?: {show(path: string): void}};
}
/** bookmarks' own slots (frontend.md §2.3): the facades it publishes on JE and its JE.internals slots. */
export type BookmarksOwn = Pick<BookmarkHost, 'bookmarks' | 'initializeBookmarks' | 'cleanupBookmarks'> & BookmarkHost['internals'];
/** bookmarks reads no other feature's facade. */
export type BookmarksPeers = Record<never, never>;
export type BookmarksContext = FeatureContext<BookmarksOwn, BookmarksPeers, BookmarkHost>;
export function bookmarksHost() {
 const host: HostWindow = window;
 const JE = host.JellyfinEnhanced;
 if (!JE) throw new Error('Bookmarks loaded before Jellyfin Enhanced');
 const ctx: BookmarksContext = featureContext<BookmarksOwn, BookmarksPeers, BookmarkHost>('bookmarks', JE, {
  facades: ['bookmarks', 'initializeBookmarks', 'cleanupBookmarks'],
  internalSlots: ['bookmarksLibrary', 'bookmarkLifetimes'],
  internalsObject: () => JE.internals ??= {},
 });
 const getApi = () => { const api = host.ApiClient || host.ConnectionManager?.currentApiClient(); if (!api) throw new Error('API client not available'); return api; };
 return { ctx, host, getApi };
}
/** The bridge the library boot waits for (library-init.ts): this window's, else a same-origin parent frame's. */
export function findBridge(host: HostWindow): BookmarkHost | null {
    // Try common globals first
    if (host.JE) return host.JE;
    if (host.JellyfinEnhanced) return host.JellyfinEnhanced;

    // Optional same-origin frame bridge; cross-origin frames are not readable.
    for (const frame of [window.parent, window.top]) {
      try {
        const parent: (Window & {JE?: BookmarkHost; JellyfinEnhanced?: BookmarkHost}) | null = frame;
        const candidate = parent?.JE || parent?.JellyfinEnhanced;
        if (candidate) return candidate;
      } catch { /* Cross-origin frame: use local host only. */ }
    }

    return null;
}
export function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
export function readItem(value: unknown): Item {
 if (!record(value) || typeof value.Id !== 'string') throw new Error('Invalid item response');
 const text = (key: string) => typeof value[key] === 'string' ? value[key] : undefined;
 const number = (key: string) => typeof value[key] === 'number' && Number.isFinite(value[key]) ? value[key] : undefined;
 const providers = record(value.ProviderIds) ? value.ProviderIds : {};
 const tags = record(value.ImageTags) ? value.ImageTags : {};
 const user = record(value.UserData) ? value.UserData : {};
 return { Id: value.Id, Name: text('Name'), Type: text('Type'), SeriesId: text('SeriesId'), SeriesName: text('SeriesName'), ProductionYear: number('ProductionYear'),
 ParentIndexNumber: number('ParentIndexNumber'), IndexNumber: number('IndexNumber'),
 ProviderIds: { Tmdb: typeof providers.Tmdb === 'string' ? providers.Tmdb : undefined, Tvdb: typeof providers.Tvdb === 'string' ? providers.Tvdb : undefined },
 ImageTags: {Primary: typeof tags.Primary === 'string' ? tags.Primary : undefined}, UserData: {Key: typeof user.Key === 'string' ? user.Key : undefined} };
}
export function readItems(value: unknown): Item[] {
 if (typeof value === 'string') return readItems(JSON.parse(value));
 if (!record(value) || !Array.isArray(value.Items)) throw new Error('Invalid items response');
 return value.Items.map(readItem);
}
export function readSessions(value: unknown): {Id: string; DeviceId: string}[] {
 if (!Array.isArray(value)) throw new Error('Invalid sessions response');
 return value.flatMap((entry: unknown) => record(entry) && typeof entry.Id === 'string' && typeof entry.DeviceId === 'string' ? [{Id: entry.Id, DeviceId: entry.DeviceId}] : []);
}
export function lease(JE: BookmarkHost): () => boolean {
 const owner = JE.userConfig, epoch = JE.session?.getEpoch();
 return () => JE.userConfig === owner && (epoch === undefined || JE.session?.isCurrent(epoch) === true);
}
export type BookmarkApiClient = Api;
export function isMissingItem(error: unknown): boolean {
 return record(error) && (error.status === 404 || error.statusCode === 404) || record(error) && typeof error.message === 'string' && /^404(?:\b|$)/.test(error.message);
}


/** Build explicit edits; extension values from old records are never copied through this port. */
function jsonValue(value: unknown): JsonValue {
 if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
 if (typeof value === 'number' && Number.isFinite(value)) return value;
 if (Array.isArray(value)) return value.map(jsonValue);
 if (record(value)) return Object.fromEntries(Object.entries(value).filter(([,v]) => v !== undefined).map(([k,v]) => [k, jsonValue(v)]));
 throw new Error('Invalid bookmark edit value');
}
export function bookmarkOperation(Kind: string, Id?: string, fields?: Record<string, unknown>, ExpectedItemId?: string): BookmarkOperation {
 return {Kind, Id: Id ?? null, SourceId: null, ExpectedItemId: ExpectedItemId ?? null, Offset: null, Fields: fields ? jsonValue(fields) : null};
}
function isReceipt(value: unknown): value is BookmarkSaveReceipt {
 return validateSchema(value, bootstrapSchema.$defs.BookmarkSaveReceipt, bootstrapSchema.$defs);
}
function isDocument(value: unknown): value is BookmarkDocumentResponse {
 return validateSchema(value, bootstrapSchema.$defs.BookmarkDocumentResponse, bootstrapSchema.$defs);
}
/** The stored document as the page holds it, mapped as the loader's bookmarkSnapshotView maps it: record ids verbatim. */
function documentView(text: string): BookmarkDocument {
 const BOOKMARK_FIELDS = new Set(['ItemId', 'TmdbId', 'TvdbId', 'MediaType', 'Name', 'Timestamp', 'Label', 'CreatedAt', 'UpdatedAt', 'SyncedFrom', 'SeasonNumber', 'EpisodeNumber', 'Progress']);
 const parsed: unknown = JSON.parse(text);
 const fields = record(parsed) ? parsed : {};
 const records = Object.entries(fields).find(([key]) => key.toLowerCase() === 'bookmarks')?.[1] ?? {};
 if (!record(records)) throw new Error('Invalid bookmark records');
 const bookmarks = Object.fromEntries(Object.entries(records).map(([id, value]) => [id, record(value)
  ? Object.fromEntries(Object.entries(value).map(([key, child]) => [BOOKMARK_FIELDS.has(key) ? key.charAt(0).toLowerCase() + key.slice(1) : key, child]))
  : value])) as BookmarkMap;
 return { ...fields, bookmarks };
}
/** The re-read document with this save's records taken from the page's copy, which already holds the change. */
function rebase(owner: Owner, stored: BookmarkDocument, Operations: BookmarkOperation[]): void {
 const local = owner.bookmark?.bookmarks ?? {};
 const bookmarks = Operations.some(op => op.Kind === 'delete-all') ? {} : stored.bookmarks;
 for (const op of Operations) for (const id of [op.Id, op.SourceId]) {
  if (!id) continue;
  const mine = local[id];
  if (mine) bookmarks[id] = mine; else delete bookmarks[id];
 }
 owner.bookmark = { ...stored, bookmarks };
}
export async function persistBookmarks(JE: BookmarkHost, getApi: () => BookmarkApiClient, owner: Owner, Operations: BookmarkOperation[]): Promise<void> {
 const api = getApi(), userId = api.getCurrentUserId(), token = api.accessToken?.(), baseUrl = api.getUrl('/'), current = lease(JE);
 if (!current() || JE.userConfig !== owner || !userId) throw new Error('Bookmark owner changed before saving');
 const binding = owner.bookmarkBinding;
 if (binding && (binding.client !== api || binding.userId !== userId || binding.token !== token || binding.baseUrl !== baseUrl)) throw new Error('Bookmark identity changed. Reload before saving again.');
 if (!owner.bookmarkRevision) {
  JE.toast('Bookmarks were not loaded safely. Reload before saving again.', 5000);
  throw new Error('Loaded bookmark revision required. Reload before saving again.');
 }
 const same = () => current() && getApi() === api && api.getCurrentUserId() === userId && api.accessToken?.() === token && api.getUrl('/') === baseUrl;
 const url = api.getUrl(`/JellyfinEnhanced/user-settings/${userId}/bookmark-document`);
 const save = async (Revision: string): Promise<string> => {
  const response = await api.ajax({type: 'POST', url, contentType: 'application/json', dataType: 'json', data: JSON.stringify({Revision, Operations})});
  if (!isReceipt(response) || !response.Revision) throw new Error('Invalid bookmark save receipt. Reload before saving again.');
  return response.Revision;
 };
 let conflicted = false;
 try {
  let revision: string;
  try { revision = await save(owner.bookmarkRevision); }
  catch (error) {
   // Another tab or device saved since this page read the document: read it again and send this change once more.
   conflicted = record(error) && (error.status === 409 || error.statusCode === 409);
   if (!conflicted || !same()) throw error;
   const stored: unknown = await api.ajax({type: 'GET', url: api.getUrl(`/JellyfinEnhanced/user-settings/${userId}/bookmark-document?_=${Date.now()}`), dataType: 'json'});
   if (!isDocument(stored)) throw new Error('Invalid bookmark document');
   const document = documentView(stored.Document);
   revision = await save(stored.Revision);
   rebase(owner, document, Operations);
  }
  // Finish the captured owner's queue even after navigation, never bind to a new owner.
  owner.bookmarkRevision = revision;
 } catch (error) {
  if (conflicted && same()) window.setTimeout(() => {
   if (same()) JE.toast('Bookmarks changed in another tab or on the server. Reload before saving again.', 5000);
  }, 0);
  throw error;
 }
}
