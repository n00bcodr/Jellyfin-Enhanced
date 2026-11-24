(() => {
"use strict";(()=>{var Ie=Object.defineProperty;var ce=(e,t)=>{for(var m in t)Ie(e,m,{get:t[m],enumerable:!0})};function me(e,t,m){let n=t.core?.featureContext;if(typeof n!="function")throw new Error(`${e}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);return n(e,t,m)}function ue(e){let t=window.JellyfinEnhanced;if(!t)return;let m=t.core??(t.core={}),n=m.sharedModules;n||(n=Object.create(null),Object.defineProperty(m,"sharedModules",{value:n,configurable:!0,writable:!0,enumerable:!1}));for(let[f,v]of Object.entries(e))n[f]??(n[f]=v)}function X(e){let t=window.JellyfinEnhanced?.core?.sharedModules?.[e];if(!t)throw new Error(`${e} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return t}function Z(e,t){return e[t]}var ae={};ce(ae,{createLifetime:()=>ie});var re={};ce(re,{bookmarkOperation:()=>R,bookmarksHost:()=>oe,findBridge:()=>Be,isMissingItem:()=>ne,lease:()=>O,persistBookmarks:()=>D,readItem:()=>ke,readItems:()=>G,readSessions:()=>Ee,record:()=>L});var Te=X("contracts/schema"),W=Z(Te,"bootstrapSchema");var je=X("contracts/validate"),ee=Z(je,"validateSchema");function oe(){let e=window,t=e.JellyfinEnhanced;if(!t)throw new Error("Bookmarks loaded before Jellyfin Enhanced");return{ctx:me("bookmarks",t,{facades:["bookmarks","initializeBookmarks","cleanupBookmarks"],internalSlots:["bookmarksLibrary","bookmarkLifetimes"],internalsObject:()=>t.internals??(t.internals={})}),host:e,getApi:()=>{let f=e.ApiClient||e.ConnectionManager?.currentApiClient();if(!f)throw new Error("API client not available");return f}}}function Be(e){if(e.JE)return e.JE;if(e.JellyfinEnhanced)return e.JellyfinEnhanced;for(let t of[window.parent,window.top])try{let m=t,n=m?.JE||m?.JellyfinEnhanced;if(n)return n}catch{}return null}function L(e){return typeof e=="object"&&e!==null&&!Array.isArray(e)}function ke(e){if(!L(e)||typeof e.Id!="string")throw new Error("Invalid item response");let t=w=>typeof e[w]=="string"?e[w]:void 0,m=w=>typeof e[w]=="number"&&Number.isFinite(e[w])?e[w]:void 0,n=L(e.ProviderIds)?e.ProviderIds:{},f=L(e.ImageTags)?e.ImageTags:{},v=L(e.UserData)?e.UserData:{};return{Id:e.Id,Name:t("Name"),Type:t("Type"),SeriesId:t("SeriesId"),SeriesName:t("SeriesName"),ProductionYear:m("ProductionYear"),ParentIndexNumber:m("ParentIndexNumber"),IndexNumber:m("IndexNumber"),ProviderIds:{Tmdb:typeof n.Tmdb=="string"?n.Tmdb:void 0,Tvdb:typeof n.Tvdb=="string"?n.Tvdb:void 0},ImageTags:{Primary:typeof f.Primary=="string"?f.Primary:void 0},UserData:{Key:typeof v.Key=="string"?v.Key:void 0}}}function G(e){if(typeof e=="string")return G(JSON.parse(e));if(!L(e)||!Array.isArray(e.Items))throw new Error("Invalid items response");return e.Items.map(ke)}function Ee(e){if(!Array.isArray(e))throw new Error("Invalid sessions response");return e.flatMap(t=>L(t)&&typeof t.Id=="string"&&typeof t.DeviceId=="string"?[{Id:t.Id,DeviceId:t.DeviceId}]:[])}function O(e){let t=e.userConfig,m=e.session?.getEpoch();return()=>e.userConfig===t&&(m===void 0||e.session?.isCurrent(m)===!0)}function ne(e){return L(e)&&(e.status===404||e.statusCode===404)||L(e)&&typeof e.message=="string"&&/^404(?:\b|$)/.test(e.message)}function te(e){if(e===null||typeof e=="string"||typeof e=="boolean"||typeof e=="number"&&Number.isFinite(e))return e;if(Array.isArray(e))return e.map(te);if(L(e))return Object.fromEntries(Object.entries(e).filter(([,t])=>t!==void 0).map(([t,m])=>[t,te(m)]));throw new Error("Invalid bookmark edit value")}function R(e,t,m,n){return{Kind:e,Id:t??null,SourceId:null,ExpectedItemId:n??null,Offset:null,Fields:m?te(m):null}}function Me(e){return ee(e,W.$defs.BookmarkSaveReceipt,W.$defs)}function Se(e){return ee(e,W.$defs.BookmarkDocumentResponse,W.$defs)}function Ce(e){let t=new Set(["ItemId","TmdbId","TvdbId","MediaType","Name","Timestamp","Label","CreatedAt","UpdatedAt","SyncedFrom","SeasonNumber","EpisodeNumber","Progress"]),m=JSON.parse(e),n=L(m)?m:{},f=Object.entries(n).find(([w])=>w.toLowerCase()==="bookmarks")?.[1]??{};if(!L(f))throw new Error("Invalid bookmark records");let v=Object.fromEntries(Object.entries(f).map(([w,I])=>[w,L(I)?Object.fromEntries(Object.entries(I).map(([B,M])=>[t.has(B)?B.charAt(0).toLowerCase()+B.slice(1):B,M])):I]));return{...n,bookmarks:v}}function Le(e,t,m){let n=e.bookmark?.bookmarks??{},f=m.some(v=>v.Kind==="delete-all")?{}:t.bookmarks;for(let v of m)for(let w of[v.Id,v.SourceId]){if(!w)continue;let I=n[w];I?f[w]=I:delete f[w]}e.bookmark={...t,bookmarks:f}}async function D(e,t,m,n){let f=t(),v=f.getCurrentUserId(),w=f.accessToken?.(),I=f.getUrl("/"),B=O(e);if(!B()||e.userConfig!==m||!v)throw new Error("Bookmark owner changed before saving");let M=m.bookmarkBinding;if(M&&(M.client!==f||M.userId!==v||M.token!==w||M.baseUrl!==I))throw new Error("Bookmark identity changed. Reload before saving again.");if(!m.bookmarkRevision)throw e.toast("Bookmarks were not loaded safely. Reload before saving again.",5e3),new Error("Loaded bookmark revision required. Reload before saving again.");let N=()=>B()&&t()===f&&f.getCurrentUserId()===v&&f.accessToken?.()===w&&f.getUrl("/")===I,_=f.getUrl(`/JellyfinEnhanced/user-settings/${v}/bookmark-document`),F=async S=>{let j=await f.ajax({type:"POST",url:_,contentType:"application/json",dataType:"json",data:JSON.stringify({Revision:S,Operations:n})});if(!Me(j)||!j.Revision)throw new Error("Invalid bookmark save receipt. Reload before saving again.");return j.Revision},$=!1;try{let S;try{S=await F(m.bookmarkRevision)}catch(j){if($=L(j)&&(j.status===409||j.statusCode===409),!$||!N())throw j;let H=await f.ajax({type:"GET",url:f.getUrl(`/JellyfinEnhanced/user-settings/${v}/bookmark-document?_=${Date.now()}`),dataType:"json"});if(!Se(H))throw new Error("Invalid bookmark document");let q=Ce(H.Document);S=await F(H.Revision),Le(m,q,n)}m.bookmarkRevision=S}catch(S){throw $&&N()&&window.setTimeout(()=>{N()&&e.toast("Bookmarks changed in another tab or on the server. Reload before saving again.",5e3)},0),S}}function ie(e,t){let m=e.core,n=e.own;n.bookmarkLifetimes??(n.bookmarkLifetimes={}),n.bookmarkLifetimes[t]?.dispose();let f=new Set,v=new Set,w=!1,I=0,B=new Set,M=k=>{if(typeof k=="function")f.add(()=>k());else if(typeof k=="object"&&k!==null&&"unsubscribe"in k&&typeof k.unsubscribe=="function"){let T=k.unsubscribe.bind(k);f.add(()=>T())}},N=k=>{if(typeof k=="object"&&k!==null&&"teardown"in k&&typeof k.teardown=="function"){let T=k.teardown.bind(k);f.add(()=>T())}else M(k)},_=(k,T,i,a=!1)=>{k.addEventListener(T,i,a),f.add(()=>k.removeEventListener(T,i,a))},F=(k,T)=>{let i=O(m),a=I,r=()=>{window.clearTimeout(s),f.delete(r),B.delete(r)},s=window.setTimeout(()=>{f.delete(r),B.delete(r),!w&&I===a&&i()&&k()},T);return f.add(r),B.add(r),s},$=(k,T)=>{let i=window.setInterval(()=>{w||k()},T);return f.add(()=>window.clearInterval(i)),i},S=k=>{let T=document.activeElement;k.setAttribute("role","dialog"),k.setAttribute("aria-modal","true"),k.tabIndex=-1;let i=()=>{k.remove(),f.delete(i),v.delete(i),document.removeEventListener("viewshow",i),T instanceof HTMLElement&&T.isConnected&&T.focus()};return f.add(i),v.add(i),document.addEventListener("viewshow",i),k.addEventListener("keydown",a=>{if(a.key==="Escape"&&(a.preventDefault(),i()),a.key!=="Tab")return;let r=Array.from(k.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]')),s=r[0],l=r[r.length-1];if(!s||!l){a.preventDefault(),k.focus();return}a.shiftKey&&(document.activeElement===s||document.activeElement===k)?(a.preventDefault(),l.focus()):!a.shiftKey&&document.activeElement===l&&(a.preventDefault(),s.focus())}),F(()=>{k.isConnected&&(k.querySelector("input")||k.querySelector("button")||k).focus()},0),i},j=()=>{I++;for(let k of B)k();for(let k of v)k()},H=()=>{if(!w){w=!0,j();for(let k of f)k();f.clear()}},q={dispose:H,cancelPending:j,keep:N,listen:_,timeout:F,interval:$,modal:S,current:()=>{let k=O(m),T=I;return()=>!w&&I===T&&k()}};return n.bookmarkLifetimes[t]=q,M(m.session?.onUserChange("bookmarks-"+t,()=>{for(let k of v)k();document.querySelectorAll(".je-bm-player-modal-overlay, .je-bm-library-modal-overlay, .je-bookmark-marker").forEach(k=>k.remove()),document.querySelectorAll(".sections.bookmarks").forEach(k=>k.replaceChildren())})),_(window,"pagehide",k=>{k.target===window&&!k.persisted&&H()}),q}ue({"features/bookmarks/lifetime":ae,"features/bookmarks/host":re});function Y(e,t){let m=e.querySelector(t);if(!m)throw new Error("Missing bookmark control: "+t);return m}function fe(e){let t=Number.isFinite(e)?Math.max(0,e):0,m=Math.floor(t/3600),n=Math.floor(t%3600/60),f=Math.floor(t%60);return m>0?`${m}:${String(n).padStart(2,"0")}:${String(f).padStart(2,"0")}`:`${n}:${String(f).padStart(2,"0")}`}function be(e,t,m){let n="🪼 Jellyfin Enhanced: Bookmarks:";function f(i="updated"){try{document.dispatchEvent(new CustomEvent("je-bookmarks-updated",{detail:{reason:i}}))}catch(a){console.warn(`${n} Failed to emit update event`,a)}}let v=new WeakMap;function w(i,a){let r=(v.get(i)||Promise.resolve()).then(a);return v.set(i,r.catch(()=>{})),r}let I=null;async function B(i){let a=e.userConfig,r=e.session?e.session.getEpoch():0;(!I||I.owner!==a||I.epoch!==r||I.itemId!==i)&&(I={owner:a,epoch:r,itemId:i,data:null,pending:null});let s=I;if(s.itemId===i&&s.data)return s.data;if(s.pending&&s.itemId===i)return s.pending;let l=(async()=>{try{let d=t().getCurrentUserId?.();if(!d)return null;let u=G(await t().ajax({type:"GET",url:t().getUrl(`/Users/${d}/Items`,{Ids:i,Fields:"ProviderIds,Type,Name,SeriesId,ParentIndexNumber,IndexNumber"}),dataType:"json"}));if(e.userConfig!==a||e.session&&!e.session.isCurrent(r))return null;let o=u[0];if(!o)return null;let p=o;if((o.Type==="Season"||o.Type==="Episode")&&o.SeriesId)try{let P=G(await t().ajax({type:"GET",url:t().getUrl(`/Users/${d}/Items`,{Ids:o.SeriesId,Fields:"ProviderIds,Type,Name"}),dataType:"json"}))[0];P&&(p={...o,ProviderIds:{...o.ProviderIds||{},Tmdb:P.ProviderIds?.Tmdb||o.ProviderIds?.Tmdb,Tvdb:o.ProviderIds?.Tvdb||P.ProviderIds?.Tvdb}})}catch(C){console.warn(`${n} Failed to fetch series info:`,C)}let b=p.ProviderIds?.Tmdb||null,h=p.ProviderIds?.Tvdb||null,E=o.Type==="Movie"?"movie":o.Type==="Series"||o.Type==="Episode"||o.Type==="Season"?"tv":(o.Type||"").toString().toLowerCase(),c=o.Type==="Episode"?o.ParentIndexNumber??null:null,x=o.Type==="Episode"?o.IndexNumber??null:null,g={itemId:o.Id,tmdbId:b,tvdbId:h,mediaType:E,name:o.Name||"Unknown",type:o.Type,seasonNumber:c,episodeNumber:x};return e.userConfig!==a||e.session&&!e.session.isCurrent(r)?null:(s.data=g,g)}catch(d){return console.warn(`${n} Error fetching item details:`,d),null}finally{s.pending=null}})();return s.itemId=i,s.pending=l,l}function M(){return`bm_${Date.now()}_${Math.random().toString(36).substr(2,9)}`}function N(i,a,r,s=null,l=null){let d=e.userConfig?.bookmark?.bookmarks||{},u=[],o=[],p=l!==null;for(let[E,c]of Object.entries(d))if(!(typeof c!="object"||c===null)){if(c.itemId===i){u.push({...c,id:E,exactMatch:!0});continue}if(!(p&&c.episodeNumber!=null&&!(c.episodeNumber===l&&(c.seasonNumber??null)===(s??null)))){if(a&&c.tmdbId===a){o.push({...c,id:E,exactMatch:!1});continue}r&&c.tvdbId===r&&o.push({...c,id:E,exactMatch:!1})}}let b=u.length>0?u:o,h=u.length===0&&o.length>0;return{bookmarks:b,hasIdMismatch:h,exactMatches:u,providerMatches:o}}async function _(i,a=""){if(!Number.isFinite(i)||i<0)throw new Error("Invalid bookmark timestamp");let r=e.userConfig,s=O(e),l=m();if(!l)return e.toast(e.t("toast_bookmark_no_item"),3e3),null;let d=await B(l.itemId);return s()?d?w(r,async()=>{if(!s())return null;let u=M(),o=new Date().toISOString(),p={itemId:d.itemId||"",tmdbId:d.tmdbId||"",tvdbId:d.tvdbId||"",mediaType:d.mediaType||"",name:d.name||"",timestamp:i,label:a||"",createdAt:o,updatedAt:o,syncedFrom:"",seasonNumber:d.seasonNumber??null,episodeNumber:d.episodeNumber??null};r.bookmark||(r.bookmark={bookmarks:{}}),r.bookmark.bookmarks||(r.bookmark.bookmarks={});let b=r.bookmark.bookmarks;b[u]=p;try{return await D(e,t,r,[R("create",u,p)]),console.log(`${n} Bookmark added:`,u,p),s()&&f("add"),{...p,id:u}}catch(h){throw console.error(`${n} Failed to save bookmark:`,h),delete b[u],h}}):(e.toast(e.t("toast_bookmark_fetch_failed"),3e3),null):null}async function F(i,a){if(a.timestamp!==void 0&&(!Number.isFinite(a.timestamp)||a.timestamp<0))return!1;let r=e.userConfig,s=O(e);return e.userConfig?.bookmark?.bookmarks?.[i]?w(r,async()=>{if(!s()||!r.bookmark?.bookmarks?.[i])return console.warn(`${n} Bookmark not found:`,i),!1;let l=r.bookmark.bookmarks,d=l[i];if(!d)return!1;let u={...d,...Object.fromEntries(Object.entries(a).filter(([,o])=>o!==void 0)),updatedAt:new Date().toISOString()};l[i]=u;try{return await D(e,t,r,[R("edit",i,a,d.itemId)]),console.log(`${n} Bookmark updated:`,i),s()&&f("update"),!0}catch(o){return l[i]===u&&(l[i]=d),console.error(`${n} Failed to update bookmark:`,o),!1}}):(console.warn(`${n} Bookmark not found:`,i),!1)}function $(i){return S(i)}async function S(i,a){let r=e.userConfig,s=O(e);return e.userConfig?.bookmark?.bookmarks?.[i]?w(r,async()=>{if(!s()||!r.bookmark?.bookmarks?.[i])return console.warn(`${n} Bookmark not found:`,i),null;let l=r.bookmark.bookmarks,d=l[i];if(!d)return!1;if(a!==void 0&&d.itemId!==a)return null;delete l[i];try{return await D(e,t,r,[R("delete",i,void 0,d.itemId)]),console.log(`${n} Bookmark deleted:`,i),s()&&f("delete"),!0}catch(u){return Object.prototype.hasOwnProperty.call(l,i)||(l[i]=d),console.error(`${n} Failed to delete bookmark:`,u),!1}}):(console.warn(`${n} Bookmark not found:`,i),null)}async function j(){let i=e.userConfig,a=O(e);return w(i,async()=>{if(!a())return!1;i.bookmark||(i.bookmark={bookmarks:{}});let r=i.bookmark.bookmarks,s={};i.bookmark.bookmarks=s;try{return await D(e,t,i,[R("delete-all")]),console.log(`${n} All bookmarks deleted`),!0}catch(l){throw i.bookmark.bookmarks===s&&(i.bookmark.bookmarks=r),console.error(`${n} Failed to delete all bookmarks:`,l),l}})}async function H(i,a,r=0,{replaceOriginals:s=!1}={}){let l=e.userConfig,d=O(e);if(!Number.isFinite(r))throw new Error("Invalid bookmark offset");let u=i.map(o=>({...o}));return w(l,async()=>{if(!d())throw new Error("Bookmark owner changed before sync");l.bookmark||(l.bookmark={bookmarks:{}});let o=l.bookmark.bookmarks,p=u.map(c=>{if(!c.id)throw new Error("Stored bookmark identity required for copying");let x=c.id?o[c.id]:void 0;if(!x||x.itemId!==c.itemId)throw new Error("Bookmark selection changed before sync");return{...x,id:c.id,exactMatch:c.exactMatch}});if(p.some(c=>!Number.isFinite(c.timestamp)||!Number.isFinite(c.timestamp+r)))throw new Error("Invalid bookmark offset");let b=[],h=[],E=new Date().toISOString();if(s){for(let{id:c}of p)if(c&&Object.prototype.hasOwnProperty.call(o,c)){let x=o[c];x&&h.push([c,x]),delete o[c]}}for(let c of p){let x=M(),g=Math.max(0,c.timestamp+r),{id:C,exactMatch:P,...y}=c,A={...y,itemId:a.itemId,tmdbId:a.tmdbId??null,tvdbId:a.tvdbId??null,mediaType:a.mediaType??"",name:a.name??"",timestamp:g,label:c.label||"",createdAt:c.createdAt||E,updatedAt:E,syncedFrom:c.itemId,seasonNumber:a.seasonNumber??null,episodeNumber:a.episodeNumber??null};o[x]=A,b.push({...A,id:x})}try{return await D(e,t,l,b.map((c,x)=>{let g=p[x];if(!g?.id)throw new Error("Stored bookmark identity required for copying");return{...R(s?"replace":"copy",c.id,{itemId:c.itemId,tmdbId:c.tmdbId,tvdbId:c.tvdbId,mediaType:c.mediaType,name:c.name,seasonNumber:c.seasonNumber,episodeNumber:c.episodeNumber},g.itemId),SourceId:g.id,Offset:r}})),console.log(`${n} Synced ${b.length} bookmarks to new item ID`),d()&&f("sync"),b}catch(c){throw console.error(`${n} Failed to sync bookmarks:`,c),b.forEach(x=>delete o[x.id]),h.forEach(([x,g])=>{o[x]=g}),c}})}async function q(i,a){if(!Number.isFinite(a))throw new Error("Invalid offset");let r=e.userConfig,s=O(e);return w(r,async()=>{if(!s())throw new Error("Bookmark owner changed before offset adjustment");let l=r.bookmark?.bookmarks;if(!l)return 0;if(i.some(u=>{let o=l[u.id];return o&&Number.isFinite(o.timestamp)&&!Number.isFinite(o.timestamp+a)}))throw new Error("Invalid bookmark offset");let d=[];for(let u of i){let o=l[u.id];if(!o||o.itemId!==u.itemId||!Number.isFinite(o.timestamp))continue;let p={...o,timestamp:Math.max(0,o.timestamp+a),syncedFrom:"",updatedAt:new Date().toISOString()};l[u.id]=p,d.push([u.id,o,p])}if(!d.length)return 0;try{return await D(e,t,r,d.map(([u,o])=>({...R("offset",u,void 0,o.itemId),Offset:a}))),s()&&f("offset"),d.length}catch(u){for(let[o,p,b]of d)l[o]===b&&(l[o]=p);throw u}})}async function k(){let i=e.userConfig,a=O(e),r=i?.bookmark?.bookmarks||{},s=Object.entries(r).filter(([,d])=>d?.mediaType==="tv"&&d.itemId&&d.episodeNumber==null);if(s.length===0)return;let l=[];for(let[d,u]of s){if(!a())return;try{let o=await B(u.itemId);if(!a())return;o?.episodeNumber!=null&&l.push([d,u.itemId,o])}catch{}}l.length!==0&&await w(i,async()=>{if(!a())return;let d=i.bookmark?.bookmarks;if(!d)return;let u=[];for(let[o,p,b]of l){let h=d[o];if(!h||h.itemId!==p||h.episodeNumber!=null)continue;let E={...h,seasonNumber:b.seasonNumber,episodeNumber:b.episodeNumber,...b.tvdbId?{tvdbId:b.tvdbId}:{}};d[o]=E,u.push([o,h,E])}if(u.length!==0)try{await D(e,t,i,u.map(([o,p,b])=>R("backfill",o,{seasonNumber:b.seasonNumber,episodeNumber:b.episodeNumber,...b.tvdbId?{tvdbId:b.tvdbId}:{}},p.itemId))),console.log(`${n} Backfilled episode metadata for ${u.length} bookmark(s)`)}catch(o){u.forEach(([p,b,h])=>{d[p]===h&&(d[p]=b)}),console.warn(`${n} Failed to save backfilled episode metadata:`,o)}})}async function T(){let i=O(e),a=e.userConfig?.bookmark?.bookmarks||{},r=new Set,s=[];for(let o of Object.values(a))o?.itemId&&r.add(o.itemId);let l=t().getCurrentUserId?.();if(!l)return{cleaned:0,errors:0};let d=0,u=0;for(let o of r)try{if(await(e.helpers?.getItemCached?e.helpers.getItemCached(o,{userId:l}):t().getItem(l,o)),!i())return{cleaned:0,errors:0}}catch(p){if(!i())return{cleaned:0,errors:0};if(!ne(p)){u++;continue}for(let[b,h]of Object.entries(a))h?.itemId===o&&s.push({bookmarkId:b,itemId:o})}for(let{bookmarkId:o,itemId:p}of s){if(!i())return{cleaned:d,errors:u};try{let b=await S(o,p);b?d++:b===!1&&u++}catch{u++}}return console.log(`${n} Cleanup: ${d} orphaned bookmarks removed, ${u} errors`),{cleaned:d,errors:u}}return{addBookmark:_,updateBookmark:F,deleteBookmark:$,deleteAllBookmarks:j,syncBookmarks:H,backfillEpisodeMetadata:k,cleanupOrphanedBookmarks:T,findBookmarksForItem:N,fetchItemDetails:B,formatTimestamp:fe,adjustOffsets:q}}function pe(){return Array.from(document.querySelectorAll("#videoOsdPage")).find(e=>!e.classList.contains("hide"))||null}function z(e){let t=pe();return t?t.querySelector(e):null}function se(e){let t=String(e??"").replace(/\s+/g,""),m=/^(-)?(\d+(?::\d{1,2}){1,2})$/.exec(t);if(!m||!m[2])return null;let n=m[2].split(":").reduce((f,v)=>f*60+Number(v),0);return m[1]?-n:n}function ge(){let e=z(".osdPositionText");if(!e||e.classList.contains("hide"))return null;let t=se(e.textContent);return t!==null&&t>=0?t:null}function J(){let e=z(".osdDurationText");if(!e||e.classList.contains("hide"))return null;let t=se(e.textContent);if(t===null)return null;if(t>=0)return t>0?t:null;let m=ge();return m===null?null:m-t}function Oe(){if(J()===null)return null;let e=z(".btnUserRating[data-id]");return e&&e.getAttribute("data-id")||""}function Pe(e,t){return!!e&&!!t&&e.key===t.key&&Math.abs(e.duration-t.duration)<=3}function $e(){let e=z(".btnPause .material-icons");return e?e.classList.contains("play_arrow")?!0:e.classList.contains("pause")?!1:null:null}function he(e){let t=z(".osdPositionSlider");return!t||t.disabled||!Number.isFinite(e)||J()===null?!1:(t.value=String(Math.min(100,Math.max(0,e))),t.dispatchEvent(new Event("change",{bubbles:!0})),!0)}function He(e){let t=z(".osdPositionSlider"),m=J();return!t||t.disabled||!m||!Number.isFinite(e)?!1:he(Math.max(0,e)/m*100)}var Q={activeOsdPage:pe,parseRunningTime:se,positionSeconds:ge,durationSeconds:J,itemKey:Oe,sameItem:Pe,isPaused:$e,seekTo:He,seekToPercent:he};var V=()=>document.querySelector(".videoPlayerContainer video");function ye(e){return e?e.currentTime||0:Q.positionSeconds()}function le(e){return e?e.duration:Q.durationSeconds()}function de(e,t){return e?(e.currentTime=t,!0):Q.seekTo(t)}function we(){let e=V();if(e)return e.currentSrc||e.src||window.location.href;let t=Q.itemKey();return t===null?null:`${window.location.href}|${t}`}function xe(e,t){let n=document.createElement.call(document,e,t);return n.getAttribute("is")!==t&&n.setAttribute("is",t),n}var{ctx:K,host:xt,getApi:Ne}=oe();function _e(e){let t=ie(K,"bookmarks"),m=t.timeout;if(!e.pluginConfig?.BookmarksEnabled){console.log("🪼 Jellyfin Enhanced: Bookmarks feature is disabled");return}let n="🪼 Jellyfin Enhanced: Bookmarks:";function f(){try{let r=document.querySelector(".videoOsdBottom .btnUserRating[data-id]")?.dataset?.id||null;return r?{itemId:r}:(console.debug(`${n} No item ID found`),null)}catch(a){return console.warn(`${n} Error getting item data:`,a),null}}let v=e.escapeHtml,{addBookmark:w,updateBookmark:I,deleteBookmark:B,deleteAllBookmarks:M,syncBookmarks:N,backfillEpisodeMetadata:_,cleanupOrphanedBookmarks:F,findBookmarksForItem:$,fetchItemDetails:S,formatTimestamp:j,adjustOffsets:H}=be(e,Ne,f);function q(a,r){let s=t.current();console.log(`${n} createBookmarkMarkers called - video:`,!!a,"bookmarks:",r.length);let l=document.querySelector(".videoOsdBottom");if(!l){console.log(`${n} No .videoOsdBottom found`);return}let d=l.querySelector('.osdPositionSlider, .sliderBubble, .mdl-slider, input[type="range"]');if(!d){console.log(`${n} No position slider found`);return}let u=d.closest(".osdPositionSliderContainer, .sliderContainer")||d.parentElement;if(!u){console.log(`${n} No slider container found`);return}window.getComputedStyle(u).position==="static"&&(u.style.position="relative");let p=u.querySelectorAll(".je-bookmark-marker");console.log(`${n} Removing ${p.length} existing markers`),p.forEach(h=>h.remove());let b=le(a);if(!b||!isFinite(b)){console.log(`${n} Invalid duration:`,b);return}r.forEach(h=>{if(!Number.isFinite(h.timestamp)||h.timestamp<0)return;let E=h.timestamp/b*100,c=h.exactMatch?"#00d4ff":"#ffa500",x=document.createElement("div");x.className="je-bookmark-marker",x.style.cssText=`
        position: absolute;
        left: ${E}%;
        bottom: 0%;
        transform: translate(-50%, -50%);
        z-index: 1000;
        pointer-events: all;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
      `;let g=document.createElement("span");g.className="material-icons",g.textContent="location_pin",g.style.cssText=`
        font-size: 24px;
        color: ${c};
        filter: drop-shadow(0 2px 4px rgba(0,0,0,0.8));
        pointer-events: none;
      `,x.appendChild(g);let C=h.label||e.t("bookmark_no_label"),P=h.exactMatch?"":` ${e.t("bookmark_file_changed")}`;x.title=`${C} - ${j(h.timestamp)}${P}`,x.addEventListener("click",y=>{!s()||a&&!a.isConnected||(y.stopPropagation(),de(V()||a,h.timestamp)&&e.toast(`${e.t("toast_jumped_to_bookmark")}: ${j(h.timestamp)}`,2e3))}),u.appendChild(x)}),console.log(`${n} ✓ Created ${r.length} bookmark markers`)}async function k(){let a=t.current();console.log(`${n} updateBookmarkMarkersForCurrentVideo called`);let r=V();if(!r&&le(null)===null){console.log(`${n} No video element or OSD duration found`);return}let s=f();if(!s){console.log(`${n} No item data (no btnUserRating?)`);return}console.log(`${n} Fetching details for item:`,s.itemId);let l=await S(s.itemId);if(!a()||f()?.itemId!==s.itemId)return;if(!l){console.log(`${n} Failed to fetch item details`);return}console.log(`${n} Item details:`,l);let{bookmarks:d}=$(l.itemId,l.tmdbId,l.tvdbId,l.seasonNumber,l.episodeNumber);console.log(`${n} Found ${d.length} bookmarks for this item`),document.querySelector(".videoPlayerContainer video")===r&&q(r,d)}async function T(a="add",r=null){let s=t.current(),l=V(),d=ye(l);if(a==="add"&&d===null){e.toast(e.t("toast_player_unsupported"),3e3);return}let u=f();if(!u){s()&&e.toast(e.t("toast_bookmark_no_item"),3e3);return}let o=await S(u.itemId);if(!s()||f()?.itemId!==u.itemId)return;if(!o){s()&&e.toast(e.t("toast_bookmark_fetch_failed"),3e3);return}let{bookmarks:p}=$(o.itemId,o.tmdbId,o.tvdbId,o.seasonNumber,o.episodeNumber),b=a==="edit"&&r,h=b?e.t("bookmark_edit_title"):a==="view"?"Your Bookmarks":e.t("bookmark_add_title"),E=b?r.timestamp:d??0,c=b?r.label:"",x=`
      <style>
        .je-bm-player-modal-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0,0,0,0.85);
          z-index: 9999;
          display: flex;
          align-items: center;
          justify-content: center;
          opacity: 0;
          transition: opacity 0.2s;
        }
        .je-bm-player-modal-container {
          background: #181818;
          border-radius: 12px;
          max-width: 700px;
          width: 90%;
          max-height: 85vh;
          padding: 24px;
          position: relative;
          box-shadow: 0 8px 32px rgba(0,0,0,0.8);
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        @media (max-width: 600px) {
          .je-bm-player-modal-container {
            padding: 16px;
            max-height: 90vh;
            width: 95%;
          }
        }
        .je-bookmark-modal-close {
          position: absolute;
          top: 16px;
          right: 16px;
          background: transparent;
          border: none;
          color: #fff;
          font-size: 32px;
          cursor: pointer;
          width: 40px;
          height: 40px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 50%;
          transition: background 0.2s;
        }
        .je-bookmark-modal-close:hover {
          background: rgba(255,255,255,0.1);
        }
        .je-bookmark-modal-actions {
          display: flex;
          gap: 12px;
          margin-top: 16px;
          justify-content: flex-end;
          flex-shrink: 0;
        }
        .je-bookmark-btn-submit,
        .je-bookmark-btn-cancel {
          padding: 12px 24px;
          border: none;
          border-radius: 6px;
          font-size: 15px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
        }
        .je-bookmark-btn-submit {
          background: #00a86b;
          color: #fff;
        }
        .je-bookmark-btn-submit:hover {
          background: #00c47a;
        }
        .je-bookmark-btn-cancel {
          display: flex;
          align-items: center;
          gap: 6px;
          background: rgba(255,255,255,0.1);
          color: #fff;
        }
        .je-bookmark-btn-cancel:hover {
          background: rgba(255,255,255,0.15);
        }
        .je-bookmark-modal {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
          flex: 1;
          overflow-y: auto;
          min-height: 0;
        }
        .je-bookmark-hero { padding: 0 0 20px 0; border-bottom: 1px solid rgba(255,255,255,0.1); margin-bottom: 20px; }
        .je-bookmark-hero-title { font-size: 20px; font-weight: 600; color: #fff; margin: 0 0 6px 0; }
        .je-bookmark-hero-icon { display: none; }
        .je-bookmark-hero-subtitle { font-size: 14px; color: #888; margin: 0; }

        .je-bookmark-form-grid { display: grid; gap: 20px; }
        .je-bookmark-input-group { position: relative; }
        .je-bookmark-input-group label {
          display: block;
          margin-bottom: 8px;
          font-weight: 600;
          color: #e0e0e0;
          font-size: 13px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .je-bookmark-input, .je-bookmark-textarea {
          width: 100%;
          padding: 12px 16px;
          border: 1px solid rgba(255,255,255,0.15);
          border-radius: 6px;
          background: rgba(255,255,255,0.05);
          color: #fff;
          font-family: inherit;
          font-size: 15px;
          transition: all 0.2s;
          box-sizing: border-box;
        }
        .je-bookmark-input:focus, .je-bookmark-textarea:focus {
          outline: none;
          border-color: rgba(255,255,255,0.3);
          background: rgba(255,255,255,0.08);
        }
        .je-bookmark-input[readonly] {
          background: rgba(0,0,0,0.2);
          cursor: not-allowed;
          border-color: rgba(255,255,255,0.1);
        }
        .je-bookmark-textarea {
          resize: vertical;
          min-height: 80px;
          font-family: inherit;
        }

        .je-bookmark-list {
          margin-top: 28px;
          max-height: 300px;
          overflow-y: auto;
          padding-right: 8px;
        }
        @media (max-width: 600px) {
          .je-bookmark-list {
            max-height: 150px;
            margin-top: 16px;
          }
        }
        .je-bookmark-list::-webkit-scrollbar {
          width: 8px;
        }
        .je-bookmark-list::-webkit-scrollbar-track {
          background: rgba(255,255,255,0.05);
          border-radius: 4px;
        }
        .je-bookmark-list::-webkit-scrollbar-thumb {
          background: rgba(255,255,255,0.2);
          border-radius: 4px;
        }
        .je-bookmark-list::-webkit-scrollbar-thumb:hover {
          background: rgba(255,255,255,0.3);
        }
        .je-bookmark-list-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 12px;
          padding-bottom: 8px;
          border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        .je-bookmark-list-title {
          font-size: 13px;
          font-weight: 600;
          color: #aaa;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .je-bookmark-list-count {
          background: rgba(255,255,255,0.1);
          color: #fff;
          padding: 4px 12px;
          border-radius: 12px;
          font-size: 12px;
          font-weight: 600;
        }

        .je-bookmark-item {
            display: flex;
            gap: 12px;
            padding: 14px 16px;
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 8px;
            margin-bottom: 10px;
            transition: all 0.2s;
            flex-wrap: wrap;
            flex-direction: row;
            align-items: center;
        }

        .je-bookmark-item:hover {
          background: rgba(255,255,255,0.08);
          border-color: rgba(255,255,255,0.2);
        }
        .je-bookmark-item-marker {
          width: 3px;
          background: rgba(255,255,255,0.3);
          border-radius: 2px;
          flex-shrink: 0;
        }
        .je-bookmark-item-content { flex: 1; min-width: 0; }
        .je-bookmark-item-time {
          font-weight: 600;
          color: #fff;
          font-size: 15px;
          margin-bottom: 4px;
        }
        .je-bookmark-item-label {
          font-size: 14px;
          color: #ccc;
          margin-top: 4px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .je-bookmark-item-warning {
          color: #ffa500;
          font-size: 12px;
          margin-top: 6px;
          display: flex;
          align-items: center;
          gap: 4px;
        }
        .je-bookmark-item-actions {
          display: flex;
          gap: 8px;
          flex-shrink: 0;
        }
        .je-bookmark-btn {
          padding: 8px;
          font-size: 20px;
          border-radius: 50%;
          cursor: pointer;
          border: none;
          transition: all 0.2s;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 36px;
          height: 36px;
        }
        .je-bookmark-btn:hover {
          opacity: 0.9;
          color: #fff;
        }
        .je-bookmark-btn-jump:hover {
          background: #00a86b;
        }
        .je-bookmark-btn-delete:hover {
          background: #b60505;
        }

        .je-bookmark-empty {
          text-align: center;
          padding: 40px 20px;
          color: #888;
          font-size: 14px;
        }
        .je-bookmark-empty-icon {
          font-size: 48px;
          margin-bottom: 12px;
          opacity: 0.5;
        }
      </style>
      <div class="je-bookmark-modal">
        <div class="je-bookmark-hero">
          <div class="je-bookmark-hero-title">
            <span>${h}</span>
          </div>
          <div class="je-bookmark-hero-subtitle">${v(o.name)}</div>
        </div>
        <div class="je-bookmark-form-grid">
          <div class="je-bookmark-input-group">
            <label for="bookmark-time">${e.t("bookmark_time_label")}</label>
            <input
              type="text"
              id="bookmark-time"
              class="je-bookmark-input"
              value="${j(E)}"
              readonly>
          </div>
          <div class="je-bookmark-input-group">
            <label for="bookmark-label">${e.t("bookmark_label_label")}</label>
            <input
              type="text"
              id="bookmark-label"
              class="je-bookmark-input"
              placeholder="${e.t("bookmark_label_placeholder")}"
              value="${v(c)}"
              maxlength="100">
          </div>
        </div>
        ${p.length>0?`
          <div class="je-bookmark-list">
            <div class="je-bookmark-list-header">
              <div class="je-bookmark-list-title">${e.t("bookmark_existing_title")}</div>
              <div class="je-bookmark-list-count">${p.length}</div>
            </div>
            ${p.map(y=>`
              <div class="je-bookmark-item">
                <div class="je-bookmark-item-marker"></div>
                <div class="je-bookmark-item-content">
                  <div class="je-bookmark-item-time">${j(y.timestamp)}</div>
                  ${y.label?`<div class="je-bookmark-item-label">${v(y.label)}</div>`:""}
                  ${y.exactMatch?"":`<div class="je-bookmark-item-warning">${e.t("bookmark_file_changed")}</div>`}
                </div>
                <div class="je-bookmark-item-actions">
                  <button class="je-bookmark-btn je-bookmark-btn-jump" data-bookmark-id="${v(y.id)}" title="${e.t("bookmark_jump")}">
                    <span class="material-icons">forward</span>
                  </button>
                  <button class="je-bookmark-btn je-bookmark-btn-delete" data-bookmark-id="${v(y.id)}" title="${e.t("bookmark_delete_confirm")}">
                    <span class="material-icons">delete</span>
                  </button>
                </div>
              </div>
            `).join("")}
          </div>
        `:`
          <div class="je-bookmark-empty">
            <div>${e.t("bookmark_none")}</div>
          </div>
        `}
      </div>
    `,g=document.createElement("div");g.className="je-bm-player-modal-overlay",g.innerHTML=`
      <div class="je-bm-player-modal-container">
        <button class="je-bookmark-modal-close">×</button>
        ${x}
        <div class="je-bookmark-modal-actions">
          <button class="je-bookmark-btn-submit">${b?e.t("bookmark_save"):e.t("bookmark_add")}</button>
          <button class="je-bookmark-btn-cancel">
            <span class="material-icons" aria-hidden="true" style="font-size: 18px;">close</span>
            <span>Cancel</span>
          </button>
        </div>
      </div>
    `,document.body.appendChild(g),g.addEventListener("keydown",y=>y.stopPropagation()),g.addEventListener("keyup",y=>y.stopPropagation()),g.addEventListener("keypress",y=>y.stopPropagation()),g.addEventListener("wheel",y=>y.stopPropagation());let C=t.modal(g);Y(g,".je-bookmark-modal-close").addEventListener("click",C),Y(g,".je-bookmark-btn-cancel").addEventListener("click",C),g.addEventListener("click",y=>{y.target===g&&C()}),m(()=>{let y=g.querySelector("#bookmark-label");y&&y.focus(),g.style.opacity="1"},10);let P=Y(g,".je-bookmark-btn-submit");P.addEventListener("click",async()=>{if(!s())return;let y=Y(g,"#bookmark-label").value.trim();P.disabled=!0;try{if(b&&r){if(!await I(r.id,{label:y})){s()&&e.toast(e.t("toast_bookmark_save_failed"),3e3);return}s()&&e.toast(e.t("toast_bookmark_updated"),2e3)}else{if(!await w(E,y))return;s()&&e.toast(e.t("toast_bookmark_updated"),2e3)}if(!s())return;k(),C()}catch{s()&&e.toast(e.t("toast_bookmark_save_failed"),3e3)}finally{P.disabled=!1}}),g.querySelectorAll(".je-bookmark-btn-jump").forEach(y=>{y.addEventListener("click",()=>{let A=y.dataset.bookmarkId;if(!A)return;let U=p.find(ve=>ve.id===A);U&&de(V()||l,U.timestamp)&&(s()&&e.toast(`${e.t("toast_jumped_to_bookmark")}: ${j(U.timestamp)}`,2e3),C())})}),g.querySelectorAll(".je-bookmark-btn-delete").forEach(y=>{y.addEventListener("click",async()=>{if(!s())return;let A=y.dataset.bookmarkId;if(!A)return;y.disabled=!0;let U;try{U=await B(A)}finally{y.disabled=!1}if(!(!s()||U===null)){if(!U){s()&&e.toast(e.t("toast_bookmark_delete_failed"),3e3);return}s()&&e.toast(e.t("toast_bookmark_deleted"),2e3),k(),C(),m(()=>T(a,r),300)}})})}K.own.bookmarks={add:w,update:I,delete:B,deleteAll:M,findForItem:$,showModal:T,updateMarkers:k,formatTimestamp:j,syncBookmarks:N,cleanupOrphaned:F,backfillEpisodeMetadata:_,adjustOffsets:H};function i(){if(document.getElementById("jeBookmarkBtn"))return;let a=document.querySelector(".videoOsdBottom .buttons.focuscontainer-x");if(!a)return;let r=a.querySelector(".btnVideoOsdSettings");if(!r)return;let s=xe("button","paper-icon-button-light");s.id="jeBookmarkBtn",s.classList.add("autoSize","paper-icon-button-light"),s.title=e.t("shortcut_BookmarkCurrentTime"),s.innerHTML='<span class="largePaperIconButton material-icons" aria-hidden="true">bookmark_add</span>',s.onclick=l=>{l.stopPropagation(),T("add")},r.parentElement?.insertBefore(s,r),console.log(`${n} ✓ Added OSD bookmark button`)}K.own.initializeBookmarks=(function(){let a=!1,r=[];return function(){if(a){console.log(`${n} Already initialized, skipping...`);return}a=!0,console.log(`${n} Initializing enhanced bookmarks...`),_().catch(c=>console.warn(`${n} Backfill failed:`,c));let s=null,l="je-bookmarks-osd",d="je-bookmarks-video-changes";function u(c,x){let g,C=()=>{g!==void 0&&window.clearTimeout(g),g=void 0};return r.push(C),(...P)=>{C();let y=t.current();g=window.setTimeout(()=>{g=void 0,a&&y()&&c(...P)},x)}}let o=u(()=>{if(!e.isVideoPage())return;let c=document.querySelector(".videoOsdBottom"),x=we();c&&(V()||x)&&x!==s&&(k(),i(),s=x,console.log(`${n} Injected markers/button for ${x}`))},200);function p(){if(!e.isVideoPage()){e.helpers.disconnectObserver(l);return}e.helpers.createObserver(l,o,document.body,{childList:!0,subtree:!0})}let b=u(c=>{c.target instanceof HTMLVideoElement&&e.isVideoPage()&&o()},300),h=u(c=>{c.target instanceof HTMLVideoElement&&e.isVideoPage()&&o()},300),E=()=>{e.isVideoPage()?(s=null,p(),o()):(s=null,e.helpers.disconnectObserver(l),e.helpers.disconnectObserver(d))};document.addEventListener("playing",b,!0),r.push(()=>document.removeEventListener("playing",b,!0)),document.addEventListener("loadedmetadata",h,!0),r.push(()=>document.removeEventListener("loadedmetadata",h,!0)),document.addEventListener("viewshow",E),r.push(()=>document.removeEventListener("viewshow",E)),e.isVideoPage()&&(p(),o()),K.own.cleanupBookmarks=function(){t.cancelPending(),r.forEach(c=>c()),document.querySelectorAll(".je-bookmark-marker, #jeBookmarkBtn, .je-bm-player-modal-overlay").forEach(c=>c.remove()),r=[],e.helpers.disconnectObserver(l),e.helpers.disconnectObserver(d),a=!1,console.log(`${n} Cleaned up`)},t.keep(K.own.cleanupBookmarks),console.log(`${n} ✓ Initialized`)}})()}_e(K.core);})();
})();
