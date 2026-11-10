import {catchupHost} from './host';
import {currentLease, array, string} from '../shared/wire';
import type {CatchHost} from './host';
import type {SocialApi, RequestOptions} from '../activity/public-api';
import type {CatchRuntime, State, Item, Image, Gesture, Options} from './types';
import {readItems} from './model';

/** The core entry alone owns the mutable runtime. Other bundles consume its facade. */
export function createCatchUp(JE: CatchHost, api: () => SocialApi, navigate: (id: string) => void): CatchRuntime {
 const state: State = {mode:'Movie', queue:[], seen:new Set(), undoStack:[], dismissed:new Set(), loading:false, pickerOpen:false};
 let generation=0;
 const lease = () => {const captured=generation, current=currentLease(JE.session, api); return () => captured===generation && current();};
 const reset = () => {generation++; state.loading=false; state.queue=[]; state.seen.clear(); state.undoStack=[]; state.pickerOpen=false;};
 const userId=()=>api().getCurrentUserId();
 const jf=(path:string, options?:RequestOptions)=>JE.core.api.jf(path,{skipCache:true,...options});
 const tt=(key:string, fallback:string, params?:Record<string,string|number>)=>{const out=JE.t?.(key,params); return out && out!==key ? out : Object.entries(params || {}).reduce((s,[k,v])=>s.split(`{${k}}`).join(String(v)),fallback);};
 function h<K extends keyof HTMLElementTagNameMap>(tag:K, cls?:string, text?:string|null):HTMLElementTagNameMap[K] {const e=document.createElement(tag); if(cls)e.className=cls; if(text!=null)e.textContent=text; return e;}
 const icons: Record<string,string>={undo:'undo',x:'close',info:'info_outline',bookmark:'bookmark_border',check:'check',activity:'history',refresh:'refresh'};
 const icon=(name:string)=>{const i=h('i','material-icons',icons[name]); i.setAttribute('aria-hidden','true'); return i;};
 const imageOf=(item:Item):Image|null=>item.ImageTags?.Primary ? {id:item.Id,tag:item.ImageTags.Primary} : item.SeriesPrimaryImageTag && item.SeriesId ? {id:item.SeriesId,tag:item.SeriesPrimaryImageTag} : null;
 const imageUrl=(im:Image|null,width:number)=>im ? api().getUrl(`/Items/${im.id}/Images/Primary`,{maxWidth:width,quality:85,tag:im.tag}) : '';
 // Preserve the baseline per-user storage key and saved dismissals. Never write it from a stale action.
 const legacyKey=()=>`je-catchup-dismissed-${userId()}`;
 const dismissKey=()=>`${legacyKey()}:${encodeURIComponent(api().getUrl('/'))}`;
 function storedDismissed() {
  const key=dismissKey(), saved=localStorage.getItem(key); if(saved!==null)return saved;
  const legacy=legacyKey(), owner=localStorage.getItem(`${legacy}:server`), server=api().getUrl('/');
  if(owner!==null && owner!==server)return '[]';
  const old=localStorage.getItem(legacy)||'[]'; array(JSON.parse(old),string);
  try {localStorage.setItem(`${legacy}:server`,server); localStorage.setItem(key,old);} catch { /* retain readable legacy data when storage is full */ } return old;
 }
 function loadDismissed() {try {state.dismissed=new Set(array(JSON.parse(storedDismissed()),string));} catch {state.dismissed=new Set();}}
 function saveDismissed() {try {localStorage.setItem(dismissKey(),JSON.stringify([...state.dismissed]));} catch { /* blocked storage */ }}
 const isHidden=(item:Item)=>state.dismissed.has(item.Id) || !!(item.SeriesId && state.dismissed.has(item.SeriesId));
 async function refill() {
  if(state.loading)return 0;
  const current=lease(); state.loading=true;
  try {
   const query=new URLSearchParams({IncludeItemTypes:state.mode,Recursive:'true',Filters:'IsUnplayed',SortBy:'Random',Limit:'40',Fields:'Overview,Genres,CommunityRating,RunTimeTicks,ProductionYear,ChildCount',ImageTypeLimit:'1',EnableImageTypes:'Primary'});
   const items=readItems(await jf(`/Users/${userId()}/Items?${query}`));
   if(!current())return 0;
   let added=0;
   for(const item of items)if(!state.seen.has(item.Id)&&!isHidden(item)&&imageOf(item)){state.seen.add(item.Id);state.queue.push(item);added++;}
   return added;
  } finally {if(current())state.loading=false;}
 }
 const playedUrl=(id:string)=>`/Users/${userId()}/PlayedItems/${id}`;
 const ratingUrl=(id:string)=>`/Users/${userId()}/Items/${id}/Rating`;
 async function mark(ids: string[], method: string) {
  const results=await Promise.allSettled(ids.map(id=>jf(playedUrl(id),{method})));
  const failed=results.find(result=>result.status==='rejected');
  if(failed?.status==='rejected')throw failed.reason;
 }
 const ACTIONS: CatchRuntime['ACTIONS']={
  right:{name:'watched', run:(i,o)=>mark(o?.seasons || [i.Id],'POST'),undo:(i,o)=>mark(o?.seasons || [i.Id],'DELETE')},
  left:{name:'dismiss',run:async i=>{state.dismissed.add(i.SeriesId||i.Id);saveDismissed();},undo:async i=>{state.dismissed.delete(i.SeriesId||i.Id);saveDismissed();}},
  up:{name:'watchlist',run:i=>jf(`${ratingUrl(i.SeriesId||i.Id)}?likes=true`,{method:'POST'}),undo:i=>jf(ratingUrl(i.SeriesId||i.Id),{method:'DELETE'})}
 };
 const ACT_NAME:Record<Gesture,string>={right:'watched',left:'dismiss',up:'watchlist',down:'open'};
 const logEvent=(event:unknown)=>{JE.core.api.plugin('/catchup/event',{method:'POST',body:event,skipRetry:true}).catch(()=>{});};
 const logSwipe=(item:Item,dir:Gesture,opts:Options|null|undefined,ok:boolean)=>logEvent({type:'swipe',action:ACT_NAME[dir],itemId:item.Id,ok,seasons:dir==='right'&&item.Type==='Series'?(opts?.numbers??['all']):undefined});
 return {LOG:'🪼 Jellyfin Enhanced: Catch Up:',state,tt,h,icon,userId,jf,imageOf,imageUrl,navigateToItem:navigate,loadDismissed,saveDismissed,isHidden,refill,ACTIONS,ACT_NAME,logEvent,logSwipe,reset,lease};
}
const {ctx, getApi, Emby}=catchupHost();
const JE=ctx?.core;
if(ctx && JE?.pluginConfig?.CatchUpEnabled) {
 // ctx.own.catchUp creates JE.internals on first access (host.ts), as `JE.internals=JE.internals||{}` did here.
 if(!ctx.own.catchUp) {
  const runtime=createCatchUp(JE,()=>{const api=getApi();if(!api)throw Error('Jellyfin API unavailable');return api;},id=>{try {if(Emby?.Page?.showItem){Emby.Page.showItem(id);return;}}catch{} window.location.hash=`#!/details?id=${id}`;});
  ctx.own.catchUp=runtime;
  JE.session?.onUserChange('catchup',()=>{runtime.deck?.dispose();runtime.reset();runtime.state.dismissed.clear();});
 }
}
