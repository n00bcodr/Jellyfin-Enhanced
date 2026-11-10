import type { Item, Issue, Media, Links, LinkEntry } from './types';
export function record(v:unknown):v is Record<string,unknown>{return typeof v==='object' && v!==null && !Array.isArray(v);}
export function response(v:unknown):Record<string,unknown>{if(!record(v))throw new Error('Invalid downloads response');return v;}
function text(v:unknown):string|undefined {if(v==null)return undefined;if(typeof v!=='string')throw new Error('Invalid text');return v;}
function number(v:unknown):number|undefined {if(v==null)return undefined;if(typeof v!=='number'||!Number.isFinite(v))throw new Error('Invalid number');return v;}
function id(v:unknown):string|number|undefined {return typeof v==='string'?v:number(v);}
function boolean(v:unknown):boolean|undefined {if(v==null)return undefined;if(typeof v!=='boolean')throw new Error('Invalid boolean');return v;}
export function readItems(v:unknown):Item[]{if(v==null)return [];if(!Array.isArray(v))throw new Error('Invalid items');return v.map((x:unknown)=>{const r=response(x);return {
title:text(r.title),
subtitle:text(r.subtitle),
source:text(r.source),
instanceName:text(r.instanceName),
status:text(r.status),
mediaStatus:text(r.mediaStatus),
requestStatus:number(r.requestStatus),
posterUrl:text(r.posterUrl),
jellyfinMediaId:text(r.jellyfinMediaId),
timeRemaining:text(r.timeRemaining),
type:text(r.type),
requestedBy:text(r.requestedBy),
requestedByAvatar:text(r.requestedByAvatar),
createdAt:text(r.createdAt),
date:text(r.date),
nextAirDate:text(r.nextAirDate),
digitalReleaseDate:text(r.digitalReleaseDate),
theatricalReleaseDate:text(r.theatricalReleaseDate),
eventType:text(r.eventType),
progress:number(r.progress),
seasonNumber:number(r.seasonNumber),
episodeNumber:number(r.episodeNumber),
totalSize:number(r.totalSize),
sizeRemaining:number(r.sizeRemaining),
year:number(r.year),
tmdbId:number(r.tmdbId),
tvdbId:number(r.tvdbId),
episodeCount:number(r.episodeCount),
importedCount:number(r.importedCount),
id:id(r.id),instanceId:id(r.instanceId),isOrphaned:boolean(r.isOrphaned)};});}
export function readMedia(v:unknown,depth=0):Media {const r=response(v);return {id:number(r.id),tmdbId:number(r.tmdbId),
title:text(r.title),
name:text(r.name),
originalTitle:text(r.originalTitle),
originalName:text(r.originalName),
posterPath:text(r.posterPath),
poster_path:text(r.poster_path),
posterUrl:text(r.posterUrl),
releaseDate:text(r.releaseDate),
release_date:text(r.release_date),
firstAirDate:text(r.firstAirDate),
first_air_date:text(r.first_air_date),
mediaType:text(r.mediaType),
jellyfinMediaId:text(r.jellyfinMediaId),
jellyfinMediaId4k:text(r.jellyfinMediaId4k),
jellyfinMediaId4K:text(r.jellyfinMediaId4K),
mediaInfo:r.mediaInfo!=null&&depth<2?readMedia(r.mediaInfo,depth+1):undefined,
mediaInfo4k:r.mediaInfo4k!=null&&depth<2?readMedia(r.mediaInfo4k,depth+1):undefined,
mediaInfo4K:r.mediaInfo4K!=null&&depth<2?readMedia(r.mediaInfo4K,depth+1):undefined,
};}
export function readIssues(v:unknown):Issue[]{if(v==null)return [];if(!Array.isArray(v))throw new Error('Invalid issues');return v.map((x:unknown)=>{const r=response(x);const user=r.createdBy==null?{}:response(r.createdBy);return {id:id(r.id),media:r.media==null?undefined:readMedia(r.media),mediaType:text(r.mediaType),type:text(r.type),tmdbId:number(r.tmdbId),issueType:number(r.issueType),problemType:number(r.problemType),status:id(r.status),createdAt:text(r.createdAt),message:text(r.message),createdBy:{jellyfinUsername:text(user.jellyfinUsername),displayName:text(user.displayName),username:text(user.username),email:text(user.email),avatar:text(user.avatar)},comments:Array.isArray(r.comments)?r.comments.map((c:unknown)=>({message:text(response(c).message)})):[]};});}
export function readLinks(v:unknown):Links {const r=response(v);const result:Links={};for(const key of ['movies','series'] as const){if(r[key]==null)continue;const entries=response(r[key]);const out:Record<string,LinkEntry>={};for(const [id,v] of Object.entries(entries)){const entry=response(v);out[id]={matches:Array.isArray(entry.matches)?entry.matches.map((m:unknown)=>{const r=response(m);return {urlMappings:text(r.urlMappings)||'',instanceUrl:text(r.instanceUrl)||'',titleSlug:text(r.titleSlug)||''};}):[]};}result[key]=out;}return result;}
export function pages(v:unknown):number {const n=number(v);return n===undefined?1:Math.max(1,Math.floor(n));}

/** Upstream navigation targets must remain HTTP(S); escaping alone cannot reject executable schemes. */
export function safeUrl(value:string,base:string):string {
 if(!value)return '';
 try {const url=new URL(value,base);return url.protocol==='http:'||url.protocol==='https:'?url.href:'';}catch{return '';}
}

/** Append a provider route without losing reverse-proxy prefixes or duplicating separators. */
export function serviceUrl(value:string,path:string,base:string):string {
 const validated=safeUrl(value,base);
 if(!validated)return '';
 const url=new URL(validated);
 url.pathname=url.pathname.replace(/\/+$/,'')+'/'+path;
 return url.href;
}
