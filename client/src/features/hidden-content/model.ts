/** Stored documents deliberately retain unknown fields until backend migration. */
export interface HiddenItem extends Record<string, unknown> {
 itemId?: string; name?: string; type?: string; tmdbId?: string | number;
 posterPath?: string; seriesId?: string; seriesName?: string; hiddenAt?: string;
 seasonNumber?: number | null; episodeNumber?: number | null; hideScope?: string;
}
export interface HiddenDocument extends Record<string, unknown> { items: Record<string, HiddenItem>; settings: Record<string, unknown> }
export type ListedItem = HiddenItem & { _key: string };
export interface AdminUser { userId: string; userName: string; count: number }
export const defaults = {
 enabled:true, filterLibrary:true, filterDiscovery:true, filterUpcoming:true, filterCalendar:true,
 filterSearch:false, filterRecommendations:true, filterRequests:true, filterNextUp:true,
 filterContinueWatching:true, showHideConfirmation:true, showHideButtons:true, showButtonJellyseerr:true,
 showButtonLibrary:false, showButtonDetails:true, showButtonCast:false, experimentalHideCollections:false
};
export type Settings = typeof defaults;
export function record(value: unknown): Record<string, unknown> {
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid hidden-content object');
 return value as Record<string, unknown>;
}
export function normalizeId(id: unknown): string {
 return typeof id === 'string' || typeof id === 'number' || typeof id === 'bigint' ? String(id).replace(/-/g,'').toLowerCase() : '';
}
const itemStrings = ['itemId','name','type','posterPath','seriesId','seriesName','hiddenAt','hideScope'] as const;
function field(source: Record<string, unknown>, name: string): unknown {
 return Object.prototype.hasOwnProperty.call(source,name) ? source[name] : source[name[0]?.toUpperCase() + name.slice(1)];
}
export function decodeItem(value: unknown): HiddenItem {
 const raw = record(value);
 const item: HiddenItem = { ...raw };
 for(const key of [...itemStrings,'tmdbId','seasonNumber','episodeNumber']) delete item[key];
 for (const key of itemStrings) {
  const v = field(raw,key);
  if (v !== undefined && v !== null) { if (typeof v !== 'string') throw new Error(`Invalid ${key}`); item[key]=v; }
 }
 const tmdb = field(raw,'tmdbId');
 if (tmdb !== undefined && tmdb !== null) {
  if (typeof tmdb !== 'string' && (typeof tmdb !== 'number' || !Number.isFinite(tmdb))) throw new Error('Invalid tmdbId');
  item.tmdbId=tmdb;
 }
 for (const key of ['seasonNumber','episodeNumber'] as const) {
  const v=field(raw,key);
  if (v !== undefined) { if (v !== null && (typeof v !== 'number' || !Number.isFinite(v))) throw new Error(`Invalid ${key}`); item[key]=v; }
 }
 // Remove only recognized PascalCase aliases, never unknown extension data.
 for (const key of [...itemStrings,'tmdbId','seasonNumber','episodeNumber']) delete item[key[0]?.toUpperCase()+key.slice(1)];
 return item;
}
export function decodeDocument(value: unknown): HiddenDocument {
 const raw=record(value);
 const rawItems=record(field(raw,'items'));
 const rawSettings=field(raw,'settings');
 const settings=rawSettings == null ? {} : { ...record(rawSettings) };
 for (const key of Object.keys(defaults) as (keyof Settings)[]) {
  const v=field(settings,key);
  if (v !== undefined && typeof v !== 'boolean') throw new Error(`Invalid setting ${key}`);
  if (v !== undefined) settings[key]=v;
  delete settings[key[0]?.toUpperCase()+key.slice(1)];
 }
 const items: Record<string,HiddenItem>=Object.fromEntries(Object.entries(rawItems).map(([key,item])=>[key,decodeItem(item)]));
 const document: HiddenDocument={...raw,items,settings};
 delete document.Items; delete document.Settings;
 return document;
}
export function settingsFor(data: HiddenDocument): Settings {
 const settings={...defaults};
 for (const key of Object.keys(defaults) as (keyof Settings)[]) { const v=data.settings[key]; if (typeof v==='boolean') settings[key]=v; }
 return settings;
}
export function decodeUsers(value: unknown): AdminUser[] {
 const users=record(value).users;
 if (!Array.isArray(users)) throw new Error('Invalid admin user list');
 return users.map(value=>{
  const u=record(value);
  if (typeof u.userId!=='string'||typeof u.userName!=='string'||typeof u.count!=='number'||!Number.isInteger(u.count)||u.count<0) throw new Error('Invalid admin user');
  return {userId:u.userId,userName:u.userName,count:u.count};
 });
}
export function widestScope(a: string | undefined, b: string | undefined): string {
 if (!a) return b || ''; if (!b) return a;
 const left=a.toLowerCase(), right=b.toLowerCase();
 const ranks: Record<string,number>={global:4,homesections:3,continuewatching:2,nextup:2};
 const ra=ranks[left]??1, rb=ranks[right]??1;
 return ra===2 && rb===2 && left!==right ? 'homesections' : ra>=rb ? left : right;
}
export function mergeHomeScope(existing: string, incoming='continuewatching'): string {
 const ex=existing.toLowerCase(), inc=incoming.toLowerCase();
 return !ex ? inc : ex==='global'||ex==='homesections'||ex===inc ? ex : 'homesections';
}
export interface LibraryItem {
 Id?:string; Name?:string; Type?:string; SeriesId?:string; SeriesName?:string;
 ParentIndexNumber?:number; IndexNumber?:number; ProductionYear?:number;
 ProviderIds?:{Tmdb?:string;tmdb?:string};
}
export function decodeLibraryItem(value:unknown):LibraryItem {
 const r=record(value); const result:LibraryItem={};
 for(const k of ['Id','Name','Type','SeriesId','SeriesName'] as const){ const v=r[k];if(v!=null){if(typeof v!=='string')throw new Error(`Invalid item ${k}`);result[k]=v;} }
 for(const k of ['ParentIndexNumber','IndexNumber','ProductionYear'] as const){ const v=r[k];if(v!=null){if(typeof v!=='number'||!Number.isFinite(v))throw new Error(`Invalid item ${k}`);result[k]=v;} }
 if(r.ProviderIds!=null){const ids=record(r.ProviderIds);result.ProviderIds={}; for(const k of ['Tmdb','tmdb'] as const){const v=ids[k];if(v!=null){if(typeof v!=='string')throw new Error('Invalid provider ID');result.ProviderIds[k]=v;}}}
 return result;
}
export interface SeerrItem {id?:number;mediaType?:string;posterPath?:string;poster_path?:string;title?:string;name?:string;releaseDate?:string;firstAirDate?:string;jellyfinMediaId?:string}
export function decodeSeerrItem(value:unknown):SeerrItem {
 const r=record(value), result:SeerrItem={};
 for(const k of ['mediaType','posterPath','poster_path','title','name','releaseDate','firstAirDate'] as const){const v=r[k];if(v!=null){if(typeof v!=='string')throw new Error(`Invalid Seerr ${k}`);result[k]=v;}}
 if(r.id!=null){if(typeof r.id!=='number'||!Number.isFinite(r.id))throw new Error('Invalid Seerr ID');result.id=r.id;}
 // The Jellyfin item Seerr links the title to: set only for a title the library has.
 const info=r.mediaInfo&&typeof r.mediaInfo==='object'&&!Array.isArray(r.mediaInfo)?record(r.mediaInfo):{};
 const linked=[info.jellyfinMediaId,info.jellyfinMediaId4k].find((id):id is string=>typeof id==='string'&&id!=='');
 if(linked)result.jellyfinMediaId=linked;
 return result;
}
export function decodeSeerrSearch(value:unknown):{results:SeerrItem[]} {
 const results=record(value).results;if(!Array.isArray(results))throw new Error('Invalid Seerr results');return {results:results.map(decodeSeerrItem)};
}

/** Compare decoded records without depending on object identity or JSON key order. */
export function sameValue(left:unknown,right:unknown):boolean {
 if(Object.is(left,right))return true;
 if(left===null || right===null || typeof left!=='object' || typeof right!=='object')return false;
 if(Array.isArray(left)||Array.isArray(right))return Array.isArray(left)&&Array.isArray(right)&&left.length===right.length&&left.every((v,i)=>sameValue(v,right[i]));
 const a=record(left),b=record(right),keys=Object.keys(a);
 return keys.length===Object.keys(b).length&&keys.every(k=>Object.prototype.hasOwnProperty.call(b,k)&&sameValue(a[k],b[k]));
}
/** Ask the same parser which decimal fraction supplies the clock, ignoring comments/date fields. */
function parsedFraction(stamp:string,time:number):string {
 const seconds=Math.floor(time/1000)*1000,millis=time-seconds;
 const probe=millis===123?456:123;
 const decimals=/\.(\d+)/g;
 for(let match=decimals.exec(stamp);match;match=decimals.exec(stamp)) {
  const digits=match[1];if(!digits)continue;
  const start=match.index+1,end=start+digits.length;
  const replace=(value:string)=>stamp.slice(0,start)+value+digits.slice(3)+stamp.slice(end);
  const changed=Date.parse(replace(String(probe).padStart(3,'0')));
  if(changed===seconds+probe)return digits;
  // At Date's maximum instant, any positive millisecond is outside TimeClip.
  // The zero probe must still identify this exact second; ignored comments do not become invalid.
  if(seconds+probe>8640000000000000&&!Number.isFinite(changed)&&Date.parse(replace('000'))===seconds)return digits;
 }
 return String(millis).padStart(3,'0');
}
/** Compare instants at their stored precision without duplicating Date.parse's legacy grammar. */
function compareHiddenTimes(left:string,right:string):number {
 const a=Date.parse(left),b=Date.parse(right);
 if(!Number.isFinite(a)||!Number.isFinite(b))return 0;
 const seconds=Math.floor(a/1000)-Math.floor(b/1000);
 if(seconds!==0)return seconds;
 const x=parsedFraction(left,a),y=parsedFraction(right,b),width=Math.max(x.length,y.length);
 const ax=x.padEnd(width,'0'),by=y.padEnd(width,'0');
 return ax<by?-1:ax>by?1:0;
}
/** Retain the original spelling of the earliest known hide time across aliases. */
export function earliestHiddenAt(items:HiddenItem[]):string {
 let selected='';
 for(const item of items) {
  const stamp=item.hiddenAt;if(!stamp)continue;
  if(!selected || compareHiddenTimes(stamp,selected)<0)selected=stamp;
 }
 return selected||new Date().toISOString();
}
/** Prefer the primary record's populated metadata, then fall back through its aliases. */
export function aliasMetadata(items:HiddenItem[]):HiddenItem {
 const merged:HiddenItem=Object.assign({},...items.slice().reverse());
 for(const key of ['name','type','posterPath','seriesId','seriesName'] as const) {
  const value=items.find(item=>!!item[key])?.[key];
  if(value!==undefined)merged[key]=value;
 }
 const tmdb=items.find(item=>item.tmdbId!==undefined&&item.tmdbId!=='')?.tmdbId;
 if(tmdb!==undefined)merged.tmdbId=tmdb;
 for(const key of ['seasonNumber','episodeNumber'] as const) {
  const value=items.find(item=>item[key]!=null)?.[key];
  if(value!==undefined)merged[key]=value;
 }
 return merged;
}
