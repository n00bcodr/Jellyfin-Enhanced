import type { ListedItem, AdminUser } from './model';
export interface Group {seriesName:string;seriesId:string;items:ListedItem[]}
export interface PageState {
 pageVisible:boolean;previousPage:Element|null;searchQuery:string;scopedOnly:boolean;
 locationSignature:string|null;locationTimer:ReturnType<typeof setInterval>|null;
 _customTabContainer:HTMLElement|null;_customTabMode?:boolean;
 adminIsAdmin:boolean|null;adminUsers:AdminUser[]|null;adminUsersLoading:boolean;
 selectedAdminUserId:string|null;adminEditMode:boolean;adminUserName:string;
 adminItems:ListedItem[]|null;adminItemsUserId:string|null;adminLoadError:boolean;adminLoadToken:number;
}
export interface PageSurface {
 state:PageState;sidebar:Element|null;pluginPagesExists:boolean;POSTER_MAX_WIDTH:number;
 scopeBadgeText(scope?:string):string;scopeUnhideText(scope?:string):string;
 showUnhideConfirmation(message:string,onConfirm:()=>void,itemName?:string):void;
 injectStyles():void;maybeInitAdminFilter():Promise<void>;onAdminUserChange(value:string|null):Promise<void>;
 toOpaqueColor(value:unknown):string|null;applyAdminThemeVars(container:HTMLElement):void;isCssColor(value:unknown):value is string;
 createAdminViewingBadge():HTMLElement;handleUnhide(key:string):void;handleUnhideMany(keys:string[]):void;openAdminAddModal():void;
 createGroupCard(group:Group):HTMLElement;createSection(title:string,content:HTMLElement,options?:{expandable?:boolean}):HTMLElement;
 renderPage(container?:HTMLElement):void;createPageContainer():HTMLElement;showPage():boolean;hidePage():void;
 interceptNavigation(event:HashChangeEvent|PopStateEvent):void;handleNavigation():void;handleViewShow(event:Event):void;handleNavClick(event:MouseEvent):void;
 injectNavigation():void;setupNavigationWatcher():void;renderForCustomTab(container?:HTMLElement):void;
}
export interface SearchResult {source:string;itemId:string;name:string;type:string;tmdbId:string;posterPath:string;year:string|number}
