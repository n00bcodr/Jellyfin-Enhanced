export type HomeSurface='continuewatching'|'nextup';
export interface RemoveTarget {itemId:string;surface:HomeSurface;card:HTMLElement;name:string}
export interface SurfaceConfig {path:string;labelKey:string;nameKey:string;successKey:string}
export interface HomeSurfaceApi {
 showNotification(message:string,type?:string):void;
 REMOVE_SURFACES:Record<HomeSurface,SurfaceConfig>;
 buildNativeActionSheetItem(scroller:HTMLElement,options:{dataId:string;icon:string;text:string}):HTMLButtonElement;
 setActionSheetItemIcon(button:HTMLElement,icon:string):void;
 fitRemoveItemToMenu(button:HTMLElement,scroller:HTMLElement):void;
 removeFromHomeSurface(itemId:string,surface:string,card?:HTMLElement|null):Promise<boolean>;
 closeOpenActionSheet():boolean;hideEmptyHomeSections():void;getActiveActionSheetScroller():HTMLElement|null;
}
export function isHomeSurface(value:unknown):value is HomeSurface {return value==='continuewatching'||value==='nextup';}
export function errorMessage(error:unknown,fallback:string):string {
 if(!error||typeof error!=='object')return fallback;
 if('responseJSON' in error && error.responseJSON && typeof error.responseJSON==='object') {
  const r=error.responseJSON;
  if('message' in r && typeof r.message==='string')return r.message;
  if('Message' in r && typeof r.Message==='string')return r.Message;
 }
 return 'statusText' in error && typeof error.statusText==='string'?error.statusText:fallback;
}
