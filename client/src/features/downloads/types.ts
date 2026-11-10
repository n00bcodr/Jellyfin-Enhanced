import type { DownloadsContext, DownloadsHost, DownloadsWindow, DownloadsApi } from './host';
export type List = 'requests' | 'issues' | 'history';
export interface Item {
 id?: string | number | undefined;
 title?: string | undefined; subtitle?: string | undefined; source?: string | undefined; instanceName?: string | undefined; instanceId?: string | number | undefined;
 status?: string | undefined; mediaStatus?: string | undefined; requestStatus?: number | undefined;
 posterUrl?: string | undefined; jellyfinMediaId?: string | undefined; timeRemaining?: string | undefined;
 type?: string | undefined; requestedBy?: string | undefined; requestedByAvatar?: string | undefined; createdAt?: string | undefined; date?: string | undefined;
 nextAirDate?: string | undefined; digitalReleaseDate?: string | undefined; theatricalReleaseDate?: string | undefined; eventType?: string | undefined;
 progress?: number | undefined; seasonNumber?: number | undefined; episodeNumber?: number | undefined; totalSize?: number | undefined; sizeRemaining?: number | undefined;
 year?: number | undefined; tmdbId?: number | undefined; tvdbId?: number | undefined; episodeCount?: number | undefined; importedCount?: number | undefined; isOrphaned?: boolean | undefined;
}
export interface Media {
 id?: number | undefined; tmdbId?: number | undefined; title?: string | undefined; name?: string | undefined; originalTitle?: string | undefined; originalName?: string | undefined;
 posterPath?: string | undefined; poster_path?: string | undefined; posterUrl?: string | undefined; releaseDate?: string | undefined; release_date?: string | undefined;
 firstAirDate?: string | undefined; first_air_date?: string | undefined; mediaType?: string | undefined; jellyfinMediaId?: string | undefined; jellyfinMediaId4k?: string | undefined; jellyfinMediaId4K?: string | undefined;
 mediaInfo?: Media | undefined; mediaInfo4k?: Media | undefined; mediaInfo4K?: Media | undefined;
}
export interface Issue {
 id?: string | number | undefined; media?: Media | undefined; mediaType?: string | undefined; type?: string | undefined; tmdbId?: number | undefined;
 issueType?: number | undefined; problemType?: number | undefined; status?: string | number | undefined; createdAt?: string | undefined; message?: string | undefined;
 comments?: {message?: string | undefined}[] | undefined;
 createdBy?: {jellyfinUsername?: string | undefined; displayName?: string | undefined; username?: string | undefined; email?: string | undefined; avatar?: string | undefined} | undefined;
}
export type Group = {type:'single'; item: Item} | SeasonGroup;
export interface SeasonGroup {type:'seasonPack';item:Item;episodes:Item[];episodeRange:string;episodeCount:number}
export interface State {
 downloadsError?:boolean;requestsError?:boolean;historyError?:boolean;
 downloads: Item[]; requests: Item[]; issues: Issue[]; history: Item[];
 requestsPage:number; requestsTotalPages:number; requestsFilter:string; canApproveRequests:boolean;
 issuesPage:number; issuesTotalPages:number; issuesError:boolean; issuesFilter:string; issuesPermissionDenied?:boolean;
 historyPage:number; historyTotalPages:number; historyVisible:boolean;
 requestsPageSize?:number; issuesPageSize?:number; historyPageSize?:number;
 isLoading:boolean; pollTimer:number|null; pageVisible:boolean; previousPage:Element|null; locationSignature:string|null; locationUnsubscribe:(()=>void)|null;
 downloadsActiveTab:string; downloadsSearchQuery:string; downloadsSearchVisible:boolean; searchDebounceTimer:number|null;
 _customTabContainer:HTMLElement|null; _customTabMode?:boolean; _pluginPageVisible?:boolean;
}
export interface LinkMatch {urlMappings?:string; instanceUrl?:string; titleSlug?:string}
export interface LinkEntry {matches:LinkMatch[]}
export interface Links {movies?:Record<string,LinkEntry>;series?:Record<string,LinkEntry>}
export interface Page {
 runtime?: import("./runtime").Runtime;
 state:State;
 renderPage(target?:HTMLElement):void; renderSection(list:List):void; createPageContainer():HTMLElement; injectStyles():void;
 clearAvatarObjectUrlCache(force?:boolean):void; hydrateAvatarImages(container:Element):void; hydrateExternalLinks(container:Element):Promise<void>;
 fetchRequests():Promise<unknown>;fetchIssues():Promise<unknown>;fetchHistory():Promise<unknown>;loadAllData():Promise<void>;
 handleRequestAction(button:HTMLButtonElement,action:'approve'|'decline'):Promise<void>;
 getIssueMediaType(issue:Issue):string;getIssueTmdbId(issue:Issue):number|null;
 getStatusColors():Record<string,string>;translateStatus(status:string|undefined):string;getDownloadStatuses():[string,number][];getFilteredDownloads():Item[];
 formatTimeRemaining(value:string|null|undefined):string;formatRelativeDate(value:string|undefined):string;
 getReleaseDateLabel(item:Item):{label:string|{isHtml:boolean;text:string};icon:string;isHtml:boolean}|null;
 formatDownloadStats(total:number|undefined,remaining:number|undefined):string; resolveRequestStatus(status:string|undefined,item?:Item|null):{label:string;className:string};groupDownloads(items:Item[]):Group[];
 renderDownloadCard(item:Item):string;renderRequestCard(item:Item):string;renderIssueCard(item:Issue):string;renderHistoryCard(item:Item):string;renderSeasonPackCard(group:SeasonGroup):string;
 filterDownloads(status:string):void;searchDownloads(query:string):void;filterRequests(filter:string):void;filterIssues(filter:string):void;
 nextPage():void;prevPage():void;nextIssuesPage():void;prevIssuesPage():void;nextHistoryPage():void;prevHistoryPage():void;
}
export interface PublicPage extends Pick<Page,'renderPage'|'injectStyles'|'filterDownloads'|'searchDownloads'|'filterRequests'|'filterIssues'|'nextPage'|'prevPage'|'nextIssuesPage'|'prevIssuesPage'|'nextHistoryPage'|'prevHistoryPage'> {
 initialize():void;showPage():void;hidePage():void;refresh():Promise<void>;startPolling():void;stopPolling():void;renderForCustomTab(target?:HTMLElement):void;_state:State;
}
export interface Dependencies {JE:DownloadsHost;P:Page;host:DownloadsWindow;ctx:DownloadsContext;getApi():DownloadsApi}
