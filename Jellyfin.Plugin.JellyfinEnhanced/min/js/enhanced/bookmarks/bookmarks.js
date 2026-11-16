(() => {
"use strict";(()=>{var xe=Object.defineProperty;var ce=(e,o)=>{for(var m in o)xe(e,m,{get:o[m],enumerable:!0})};function me(e,o,m){let n=o.core?.featureContext;if(typeof n!="function")throw new Error(`${e}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);return n(e,o,m)}function ue(e){let o=window.JellyfinEnhanced;if(!o)return;let m=o.core??(o.core={}),n=m.sharedModules;n||(n=Object.create(null),Object.defineProperty(m,"sharedModules",{value:n,configurable:!0,writable:!0,enumerable:!1}));for(let[f,x]of Object.entries(e))n[f]??(n[f]=x)}function X(e){let o=window.JellyfinEnhanced?.core?.sharedModules?.[e];if(!o)throw new Error(`${e} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return o}function Z(e,o){return e[o]}var ae={};ce(ae,{createLifetime:()=>ie});var re={};ce(re,{bookmarkOperation:()=>A,bookmarksHost:()=>te,findBridge:()=>Be,isMissingItem:()=>ne,lease:()=>M,persistBookmarks:()=>D,readItem:()=>ke,readItems:()=>G,readSessions:()=>Te,record:()=>$});var Ie=X("contracts/schema"),W=Z(Ie,"bootstrapSchema");var je=X("contracts/validate"),ee=Z(je,"validateSchema");function te(){let e=window,o=e.JellyfinEnhanced;if(!o)throw new Error("Bookmarks loaded before Jellyfin Enhanced");return{ctx:me("bookmarks",o,{facades:["bookmarks","initializeBookmarks","cleanupBookmarks"],internalSlots:["bookmarksLibrary","bookmarkLifetimes"],internalsObject:()=>o.internals??(o.internals={})}),host:e,getApi:()=>{let f=e.ApiClient||e.ConnectionManager?.currentApiClient();if(!f)throw new Error("API client not available");return f}}}function Be(e){if(e.JE)return e.JE;if(e.JellyfinEnhanced)return e.JellyfinEnhanced;for(let o of[window.parent,window.top])try{let m=o,n=m?.JE||m?.JellyfinEnhanced;if(n)return n}catch{}return null}function $(e){return typeof e=="object"&&e!==null&&!Array.isArray(e)}function ke(e){if(!$(e)||typeof e.Id!="string")throw new Error("Invalid item response");let o=w=>typeof e[w]=="string"?e[w]:void 0,m=w=>typeof e[w]=="number"&&Number.isFinite(e[w])?e[w]:void 0,n=$(e.ProviderIds)?e.ProviderIds:{},f=$(e.ImageTags)?e.ImageTags:{},x=$(e.UserData)?e.UserData:{};return{Id:e.Id,Name:o("Name"),Type:o("Type"),SeriesId:o("SeriesId"),SeriesName:o("SeriesName"),ProductionYear:m("ProductionYear"),ParentIndexNumber:m("ParentIndexNumber"),IndexNumber:m("IndexNumber"),ProviderIds:{Tmdb:typeof n.Tmdb=="string"?n.Tmdb:void 0,Tvdb:typeof n.Tvdb=="string"?n.Tvdb:void 0},ImageTags:{Primary:typeof f.Primary=="string"?f.Primary:void 0},UserData:{Key:typeof x.Key=="string"?x.Key:void 0}}}function G(e){if(typeof e=="string")return G(JSON.parse(e));if(!$(e)||!Array.isArray(e.Items))throw new Error("Invalid items response");return e.Items.map(ke)}function Te(e){if(!Array.isArray(e))throw new Error("Invalid sessions response");return e.flatMap(o=>$(o)&&typeof o.Id=="string"&&typeof o.DeviceId=="string"?[{Id:o.Id,DeviceId:o.DeviceId}]:[])}function M(e){let o=e.userConfig,m=e.session?.getEpoch();return()=>e.userConfig===o&&(m===void 0||e.session?.isCurrent(m)===!0)}function ne(e){return $(e)&&(e.status===404||e.statusCode===404)||$(e)&&typeof e.message=="string"&&/^404(?:\b|$)/.test(e.message)}function oe(e){if(e===null||typeof e=="string"||typeof e=="boolean"||typeof e=="number"&&Number.isFinite(e))return e;if(Array.isArray(e))return e.map(oe);if($(e))return Object.fromEntries(Object.entries(e).filter(([,o])=>o!==void 0).map(([o,m])=>[o,oe(m)]));throw new Error("Invalid bookmark edit value")}function A(e,o,m,n){return{Kind:e,Id:o??null,SourceId:null,ExpectedItemId:n??null,Offset:null,Fields:m?oe(m):null}}function Ce(e){return ee(e,W.$defs.BookmarkSaveReceipt,W.$defs)}function Se(e){return ee(e,W.$defs.BookmarkDocumentResponse,W.$defs)}function Oe(e){let o=new Set(["ItemId","TmdbId","TvdbId","MediaType","Name","Timestamp","Label","CreatedAt","UpdatedAt","SyncedFrom","SeasonNumber","EpisodeNumber","Progress"]),m=JSON.parse(e),n=$(m)?m:{},f=Object.entries(n).find(([w])=>w.toLowerCase()==="bookmarks")?.[1]??{};if(!$(f))throw new Error("Invalid bookmark records");let x=Object.fromEntries(Object.entries(f).map(([w,I])=>[w,$(I)?Object.fromEntries(Object.entries(I).map(([T,S])=>[o.has(T)?T.charAt(0).toLowerCase()+T.slice(1):T,S])):I]));return{...n,bookmarks:x}}function Pe(e,o,m){let n=e.bookmark?.bookmarks??{},f=m.some(x=>x.Kind==="delete-all")?{}:o.bookmarks;for(let x of m)for(let w of[x.Id,x.SourceId]){if(!w)continue;let I=n[w];I?f[w]=I:delete f[w]}e.bookmark={...o,bookmarks:f}}async function D(e,o,m,n){let f=o(),x=f.getCurrentUserId(),w=f.accessToken?.(),I=f.getUrl("/"),T=M(e);if(!T()||e.userConfig!==m||!x)throw new Error("Bookmark owner changed before saving");let S=m.bookmarkBinding;if(S&&(S.client!==f||S.userId!==x||S.token!==w||S.baseUrl!==I))throw new Error("Bookmark identity changed. Reload before saving again.");if(!m.bookmarkRevision)throw e.toast("Bookmarks were not loaded safely. Reload before saving again.",5e3),new Error("Loaded bookmark revision required. Reload before saving again.");let _=()=>T()&&o()===f&&f.getCurrentUserId()===x&&f.accessToken?.()===w&&f.getUrl("/")===I,H=f.getUrl(`/JellyfinEnhanced/user-settings/${x}/bookmark-document`),F=async O=>{let B=await f.ajax({type:"POST",url:H,contentType:"application/json",dataType:"json",data:JSON.stringify({Revision:O,Operations:n})});if(!Ce(B)||!B.Revision)throw new Error("Invalid bookmark save receipt. Reload before saving again.");return B.Revision},L=!1;try{let O;try{O=await F(m.bookmarkRevision)}catch(B){if(L=$(B)&&(B.status===409||B.statusCode===409),!L||!_())throw B;let E=await f.ajax({type:"GET",url:f.getUrl(`/JellyfinEnhanced/user-settings/${x}/bookmark-document?_=${Date.now()}`),dataType:"json"});if(!Se(E))throw new Error("Invalid bookmark document");let U=Oe(E.Document);O=await F(E.Revision),Pe(m,U,n)}m.bookmarkRevision=O}catch(O){throw L&&_()&&window.setTimeout(()=>{_()&&e.toast("Bookmarks changed in another tab or on the server. Reload before saving again.",5e3)},0),O}}function ie(e,o){let m=e.core,n=e.own;n.bookmarkLifetimes??(n.bookmarkLifetimes={}),n.bookmarkLifetimes[o]?.dispose();let f=new Set,x=new Set,w=!1,I=0,T=new Set,S=k=>{if(typeof k=="function")f.add(()=>k());else if(typeof k=="object"&&k!==null&&"unsubscribe"in k&&typeof k.unsubscribe=="function"){let j=k.unsubscribe.bind(k);f.add(()=>j())}},_=k=>{if(typeof k=="object"&&k!==null&&"teardown"in k&&typeof k.teardown=="function"){let j=k.teardown.bind(k);f.add(()=>j())}else S(k)},H=(k,j,i,a=!1)=>{k.addEventListener(j,i,a),f.add(()=>k.removeEventListener(j,i,a))},F=(k,j)=>{let i=M(m),a=I,r=()=>{window.clearTimeout(s),f.delete(r),T.delete(r)},s=window.setTimeout(()=>{f.delete(r),T.delete(r),!w&&I===a&&i()&&k()},j);return f.add(r),T.add(r),s},L=(k,j)=>{let i=window.setInterval(()=>{w||k()},j);return f.add(()=>window.clearInterval(i)),i},O=k=>{let j=document.activeElement;k.setAttribute("role","dialog"),k.setAttribute("aria-modal","true"),k.tabIndex=-1;let i=()=>{k.remove(),f.delete(i),x.delete(i),document.removeEventListener("viewshow",i),j instanceof HTMLElement&&j.isConnected&&j.focus()};return f.add(i),x.add(i),document.addEventListener("viewshow",i),k.addEventListener("keydown",a=>{if(a.key==="Escape"&&(a.preventDefault(),i()),a.key!=="Tab")return;let r=Array.from(k.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]')),s=r[0],d=r[r.length-1];if(!s||!d){a.preventDefault(),k.focus();return}a.shiftKey&&(document.activeElement===s||document.activeElement===k)?(a.preventDefault(),d.focus()):!a.shiftKey&&document.activeElement===d&&(a.preventDefault(),s.focus())}),F(()=>{k.isConnected&&(k.querySelector("input")||k.querySelector("button")||k).focus()},0),i},B=()=>{I++;for(let k of T)k();for(let k of x)k()},E=()=>{if(!w){w=!0,B();for(let k of f)k();f.clear()}},U={dispose:E,cancelPending:B,keep:_,listen:H,timeout:F,interval:L,modal:O,current:()=>{let k=M(m),j=I;return()=>!w&&I===j&&k()}};return n.bookmarkLifetimes[o]=U,S(m.session?.onUserChange("bookmarks-"+o,()=>{for(let k of x)k();document.querySelectorAll(".je-bm-player-modal-overlay, .je-bm-library-modal-overlay, .je-bookmark-marker").forEach(k=>k.remove()),document.querySelectorAll(".sections.bookmarks").forEach(k=>k.replaceChildren())})),H(window,"pagehide",k=>{k.target===window&&!k.persisted&&E()}),U}ue({"features/bookmarks/lifetime":ae,"features/bookmarks/host":re});function Y(e,o){let m=e.querySelector(o);if(!m)throw new Error("Missing bookmark control: "+o);return m}function fe(e){let o=Number.isFinite(e)?Math.max(0,e):0,m=Math.floor(o/3600),n=Math.floor(o%3600/60),f=Math.floor(o%60);return m>0?`${m}:${String(n).padStart(2,"0")}:${String(f).padStart(2,"0")}`:`${n}:${String(f).padStart(2,"0")}`}function be(e,o,m){let n="🪼 Jellyfin Enhanced: Bookmarks:";function f(i="updated"){try{document.dispatchEvent(new CustomEvent("je-bookmarks-updated",{detail:{reason:i}}))}catch(a){console.warn(`${n} Failed to emit update event`,a)}}let x=new WeakMap;function w(i,a){let r=(x.get(i)||Promise.resolve()).then(a);return x.set(i,r.catch(()=>{})),r}let I=null;async function T(i){let a=e.userConfig,r=e.session?e.session.getEpoch():0;(!I||I.owner!==a||I.epoch!==r||I.itemId!==i)&&(I={owner:a,epoch:r,itemId:i,data:null,pending:null});let s=I;if(s.itemId===i&&s.data)return s.data;if(s.pending&&s.itemId===i)return s.pending;let d=(async()=>{try{let l=o().getCurrentUserId?.();if(!l)return null;let u=G(await o().ajax({type:"GET",url:o().getUrl(`/Users/${l}/Items`,{Ids:i,Fields:"ProviderIds,Type,Name,SeriesId,ParentIndexNumber,IndexNumber"}),dataType:"json"}));if(e.userConfig!==a||e.session&&!e.session.isCurrent(r))return null;let t=u[0];if(!t)return null;let p=t;if((t.Type==="Season"||t.Type==="Episode")&&t.SeriesId)try{let N=G(await o().ajax({type:"GET",url:o().getUrl(`/Users/${l}/Items`,{Ids:t.SeriesId,Fields:"ProviderIds,Type,Name"}),dataType:"json"}))[0];N&&(p={...t,ProviderIds:{...t.ProviderIds||{},Tmdb:N.ProviderIds?.Tmdb||t.ProviderIds?.Tmdb,Tvdb:t.ProviderIds?.Tvdb||N.ProviderIds?.Tvdb}})}catch(P){console.warn(`${n} Failed to fetch series info:`,P)}let b=p.ProviderIds?.Tmdb||null,h=p.ProviderIds?.Tvdb||null,C=t.Type==="Movie"?"movie":t.Type==="Series"||t.Type==="Episode"||t.Type==="Season"?"tv":(t.Type||"").toString().toLowerCase(),c=t.Type==="Episode"?t.ParentIndexNumber??null:null,v=t.Type==="Episode"?t.IndexNumber??null:null,g={itemId:t.Id,tmdbId:b,tvdbId:h,mediaType:C,name:t.Name||"Unknown",type:t.Type,seasonNumber:c,episodeNumber:v};return e.userConfig!==a||e.session&&!e.session.isCurrent(r)?null:(s.data=g,g)}catch(l){return console.warn(`${n} Error fetching item details:`,l),null}finally{s.pending=null}})();return s.itemId=i,s.pending=d,d}function S(){return`bm_${Date.now()}_${Math.random().toString(36).substr(2,9)}`}function _(i,a,r,s=null,d=null){let l=e.userConfig?.bookmark?.bookmarks||{},u=[],t=[],p=d!==null;for(let[C,c]of Object.entries(l))if(!(typeof c!="object"||c===null)){if(c.itemId===i){u.push({...c,id:C,exactMatch:!0});continue}if(!(p&&c.episodeNumber!=null&&!(c.episodeNumber===d&&(c.seasonNumber??null)===(s??null)))){if(a&&c.tmdbId===a){t.push({...c,id:C,exactMatch:!1});continue}r&&c.tvdbId===r&&t.push({...c,id:C,exactMatch:!1})}}let b=u.length>0?u:t,h=u.length===0&&t.length>0;return{bookmarks:b,hasIdMismatch:h,exactMatches:u,providerMatches:t}}async function H(i,a=""){if(!Number.isFinite(i)||i<0)throw new Error("Invalid bookmark timestamp");let r=e.userConfig,s=M(e),d=m();if(!d)return e.toast(e.t("toast_bookmark_no_item"),3e3),null;let l=await T(d.itemId);return s()?l?w(r,async()=>{if(!s())return null;let u=S(),t=new Date().toISOString(),p={itemId:l.itemId||"",tmdbId:l.tmdbId||"",tvdbId:l.tvdbId||"",mediaType:l.mediaType||"",name:l.name||"",timestamp:i,label:a||"",createdAt:t,updatedAt:t,syncedFrom:"",seasonNumber:l.seasonNumber??null,episodeNumber:l.episodeNumber??null};r.bookmark||(r.bookmark={bookmarks:{}}),r.bookmark.bookmarks||(r.bookmark.bookmarks={});let b=r.bookmark.bookmarks;b[u]=p;try{return await D(e,o,r,[A("create",u,p)]),console.log(`${n} Bookmark added:`,u,p),s()&&f("add"),{...p,id:u}}catch(h){throw console.error(`${n} Failed to save bookmark:`,h),delete b[u],h}}):(e.toast(e.t("toast_bookmark_fetch_failed"),3e3),null):null}async function F(i,a){if(a.timestamp!==void 0&&(!Number.isFinite(a.timestamp)||a.timestamp<0))return!1;let r=e.userConfig,s=M(e);return e.userConfig?.bookmark?.bookmarks?.[i]?w(r,async()=>{if(!s()||!r.bookmark?.bookmarks?.[i])return console.warn(`${n} Bookmark not found:`,i),!1;let d=r.bookmark.bookmarks,l=d[i];if(!l)return!1;let u={...l,...Object.fromEntries(Object.entries(a).filter(([,t])=>t!==void 0)),updatedAt:new Date().toISOString()};d[i]=u;try{return await D(e,o,r,[A("edit",i,a,l.itemId)]),console.log(`${n} Bookmark updated:`,i),s()&&f("update"),!0}catch(t){return d[i]===u&&(d[i]=l),console.error(`${n} Failed to update bookmark:`,t),!1}}):(console.warn(`${n} Bookmark not found:`,i),!1)}function L(i){return O(i)}async function O(i,a){let r=e.userConfig,s=M(e);return e.userConfig?.bookmark?.bookmarks?.[i]?w(r,async()=>{if(!s()||!r.bookmark?.bookmarks?.[i])return console.warn(`${n} Bookmark not found:`,i),null;let d=r.bookmark.bookmarks,l=d[i];if(!l)return!1;if(a!==void 0&&l.itemId!==a)return null;delete d[i];try{return await D(e,o,r,[A("delete",i,void 0,l.itemId)]),console.log(`${n} Bookmark deleted:`,i),s()&&f("delete"),!0}catch(u){return Object.prototype.hasOwnProperty.call(d,i)||(d[i]=l),console.error(`${n} Failed to delete bookmark:`,u),!1}}):(console.warn(`${n} Bookmark not found:`,i),null)}async function B(){let i=e.userConfig,a=M(e);return w(i,async()=>{if(!a())return!1;i.bookmark||(i.bookmark={bookmarks:{}});let r=i.bookmark.bookmarks,s={};i.bookmark.bookmarks=s;try{return await D(e,o,i,[A("delete-all")]),console.log(`${n} All bookmarks deleted`),!0}catch(d){throw i.bookmark.bookmarks===s&&(i.bookmark.bookmarks=r),console.error(`${n} Failed to delete all bookmarks:`,d),d}})}async function E(i,a,r=0,{replaceOriginals:s=!1}={}){let d=e.userConfig,l=M(e);if(!Number.isFinite(r))throw new Error("Invalid bookmark offset");let u=i.map(t=>({...t}));return w(d,async()=>{if(!l())throw new Error("Bookmark owner changed before sync");d.bookmark||(d.bookmark={bookmarks:{}});let t=d.bookmark.bookmarks,p=u.map(c=>{if(!c.id)throw new Error("Stored bookmark identity required for copying");let v=c.id?t[c.id]:void 0;if(!v||v.itemId!==c.itemId)throw new Error("Bookmark selection changed before sync");return{...v,id:c.id,exactMatch:c.exactMatch}});if(p.some(c=>!Number.isFinite(c.timestamp)||!Number.isFinite(c.timestamp+r)))throw new Error("Invalid bookmark offset");let b=[],h=[],C=new Date().toISOString();if(s){for(let{id:c}of p)if(c&&Object.prototype.hasOwnProperty.call(t,c)){let v=t[c];v&&h.push([c,v]),delete t[c]}}for(let c of p){let v=S(),g=Math.max(0,c.timestamp+r),{id:P,exactMatch:N,...y}=c,R={...y,itemId:a.itemId,tmdbId:a.tmdbId??null,tvdbId:a.tvdbId??null,mediaType:a.mediaType??"",name:a.name??"",timestamp:g,label:c.label||"",createdAt:c.createdAt||C,updatedAt:C,syncedFrom:c.itemId,seasonNumber:a.seasonNumber??null,episodeNumber:a.episodeNumber??null};t[v]=R,b.push({...R,id:v})}try{return await D(e,o,d,b.map((c,v)=>{let g=p[v];if(!g?.id)throw new Error("Stored bookmark identity required for copying");return{...A(s?"replace":"copy",c.id,{itemId:c.itemId,tmdbId:c.tmdbId,tvdbId:c.tvdbId,mediaType:c.mediaType,name:c.name,seasonNumber:c.seasonNumber,episodeNumber:c.episodeNumber},g.itemId),SourceId:g.id,Offset:r}})),console.log(`${n} Synced ${b.length} bookmarks to new item ID`),l()&&f("sync"),b}catch(c){throw console.error(`${n} Failed to sync bookmarks:`,c),b.forEach(v=>delete t[v.id]),h.forEach(([v,g])=>{t[v]=g}),c}})}async function U(i,a){if(!Number.isFinite(a))throw new Error("Invalid offset");let r=e.userConfig,s=M(e);return w(r,async()=>{if(!s())throw new Error("Bookmark owner changed before offset adjustment");let d=r.bookmark?.bookmarks;if(!d)return 0;if(i.some(u=>{let t=d[u.id];return t&&Number.isFinite(t.timestamp)&&!Number.isFinite(t.timestamp+a)}))throw new Error("Invalid bookmark offset");let l=[];for(let u of i){let t=d[u.id];if(!t||t.itemId!==u.itemId||!Number.isFinite(t.timestamp))continue;let p={...t,timestamp:Math.max(0,t.timestamp+a),syncedFrom:"",updatedAt:new Date().toISOString()};d[u.id]=p,l.push([u.id,t,p])}if(!l.length)return 0;try{return await D(e,o,r,l.map(([u,t])=>({...A("offset",u,void 0,t.itemId),Offset:a}))),s()&&f("offset"),l.length}catch(u){for(let[t,p,b]of l)d[t]===b&&(d[t]=p);throw u}})}async function k(){let i=e.userConfig,a=M(e),r=i?.bookmark?.bookmarks||{},s=Object.entries(r).filter(([,l])=>l?.mediaType==="tv"&&l.itemId&&l.episodeNumber==null);if(s.length===0)return;let d=[];for(let[l,u]of s){if(!a())return;try{let t=await T(u.itemId);if(!a())return;t?.episodeNumber!=null&&d.push([l,u.itemId,t])}catch{}}d.length!==0&&await w(i,async()=>{if(!a())return;let l=i.bookmark?.bookmarks;if(!l)return;let u=[];for(let[t,p,b]of d){let h=l[t];if(!h||h.itemId!==p||h.episodeNumber!=null)continue;let C={...h,seasonNumber:b.seasonNumber,episodeNumber:b.episodeNumber,...b.tvdbId?{tvdbId:b.tvdbId}:{}};l[t]=C,u.push([t,h,C])}if(u.length!==0)try{await D(e,o,i,u.map(([t,p,b])=>A("backfill",t,{seasonNumber:b.seasonNumber,episodeNumber:b.episodeNumber,...b.tvdbId?{tvdbId:b.tvdbId}:{}},p.itemId))),console.log(`${n} Backfilled episode metadata for ${u.length} bookmark(s)`)}catch(t){u.forEach(([p,b,h])=>{l[p]===h&&(l[p]=b)}),console.warn(`${n} Failed to save backfilled episode metadata:`,t)}})}async function j(){let i=M(e),a=e.userConfig?.bookmark?.bookmarks||{},r=new Set,s=[];for(let t of Object.values(a))t?.itemId&&r.add(t.itemId);let d=o().getCurrentUserId?.();if(!d)return{cleaned:0,errors:0};let l=0,u=0;for(let t of r)try{if(await(e.helpers?.getItemCached?e.helpers.getItemCached(t,{userId:d}):o().getItem(d,t)),!i())return{cleaned:0,errors:0}}catch(p){if(!i())return{cleaned:0,errors:0};if(!ne(p)){u++;continue}for(let[b,h]of Object.entries(a))h?.itemId===t&&s.push({bookmarkId:b,itemId:t})}for(let{bookmarkId:t,itemId:p}of s){if(!i())return{cleaned:l,errors:u};try{let b=await O(t,p);b?l++:b===!1&&u++}catch{u++}}return console.log(`${n} Cleanup: ${l} orphaned bookmarks removed, ${u} errors`),{cleaned:l,errors:u}}return{addBookmark:H,updateBookmark:F,deleteBookmark:L,deleteAllBookmarks:B,syncBookmarks:E,backfillEpisodeMetadata:k,cleanupOrphanedBookmarks:j,findBookmarksForItem:_,fetchItemDetails:T,formatTimestamp:fe,adjustOffsets:U}}function pe(){return Array.from(document.querySelectorAll("#videoOsdPage")).find(e=>!e.classList.contains("hide"))||null}function V(e){let o=pe();return o?o.querySelector(e):null}function se(e){let o=String(e??"").replace(/\s+/g,""),m=/^(-)?(\d+(?::\d{1,2}){1,2})$/.exec(o);if(!m||!m[2])return null;let n=m[2].split(":").reduce((f,x)=>f*60+Number(x),0);return m[1]?-n:n}function ge(){let e=V(".osdPositionText");if(!e||e.classList.contains("hide"))return null;let o=se(e.textContent);return o!==null&&o>=0?o:null}function J(){let e=V(".osdDurationText");if(!e||e.classList.contains("hide"))return null;let o=se(e.textContent);if(o===null)return null;if(o>=0)return o>0?o:null;let m=ge();return m===null?null:m-o}function $e(){if(J()===null)return null;let e=V(".btnUserRating[data-id]");return e&&e.getAttribute("data-id")||""}function Me(e,o){return!!e&&!!o&&e.key===o.key&&Math.abs(e.duration-o.duration)<=3}function Ne(){let e=V(".btnPause .material-icons");return e?e.classList.contains("play_arrow")?!0:e.classList.contains("pause")?!1:null:null}function he(e){let o=V(".osdPositionSlider");return!o||o.disabled||!Number.isFinite(e)||J()===null?!1:(o.value=String(Math.min(100,Math.max(0,e))),o.dispatchEvent(new Event("change",{bubbles:!0})),!0)}function Le(e){let o=V(".osdPositionSlider"),m=J();return!o||o.disabled||!m||!Number.isFinite(e)?!1:he(Math.max(0,e)/m*100)}var Q={activeOsdPage:pe,parseRunningTime:se,positionSeconds:ge,durationSeconds:J,itemKey:$e,sameItem:Me,isPaused:Ne,seekTo:Le,seekToPercent:he};var q=()=>document.querySelector(".videoPlayerContainer video");function ye(e){return e?e.currentTime||0:Q.positionSeconds()}function de(e){return e?e.duration:Q.durationSeconds()}function le(e,o){return e?(e.currentTime=o,!0):Q.seekTo(o)}function we(){let e=q();if(e)return e.currentSrc||e.src||window.location.href;let o=Q.itemKey();return o===null?null:`${window.location.href}|${o}`}var{ctx:K,host:ho,getApi:Ee}=te();function _e(e){let o=ie(K,"bookmarks"),m=o.timeout;if(!e.pluginConfig?.BookmarksEnabled){console.log("🪼 Jellyfin Enhanced: Bookmarks feature is disabled");return}let n="🪼 Jellyfin Enhanced: Bookmarks:";function f(){try{let r=document.querySelector(".videoOsdBottom .btnUserRating[data-id]")?.dataset?.id||null;return r?{itemId:r}:(console.debug(`${n} No item ID found`),null)}catch(a){return console.warn(`${n} Error getting item data:`,a),null}}let x=e.escapeHtml,{addBookmark:w,updateBookmark:I,deleteBookmark:T,deleteAllBookmarks:S,syncBookmarks:_,backfillEpisodeMetadata:H,cleanupOrphanedBookmarks:F,findBookmarksForItem:L,fetchItemDetails:O,formatTimestamp:B,adjustOffsets:E}=be(e,Ee,f);function U(a,r){let s=o.current();console.log(`${n} createBookmarkMarkers called - video:`,!!a,"bookmarks:",r.length);let d=document.querySelector(".videoOsdBottom");if(!d){console.log(`${n} No .videoOsdBottom found`);return}let l=d.querySelector('.osdPositionSlider, .sliderBubble, .mdl-slider, input[type="range"]');if(!l){console.log(`${n} No position slider found`);return}let u=l.closest(".osdPositionSliderContainer, .sliderContainer")||l.parentElement;if(!u){console.log(`${n} No slider container found`);return}window.getComputedStyle(u).position==="static"&&(u.style.position="relative");let p=u.querySelectorAll(".je-bookmark-marker");console.log(`${n} Removing ${p.length} existing markers`),p.forEach(h=>h.remove());let b=de(a);if(!b||!isFinite(b)){console.log(`${n} Invalid duration:`,b);return}r.forEach(h=>{if(!Number.isFinite(h.timestamp)||h.timestamp<0)return;let C=h.timestamp/b*100,c=h.exactMatch?"#00d4ff":"#ffa500",v=document.createElement("div");v.className="je-bookmark-marker",v.style.cssText=`
        position: absolute;
        left: ${C}%;
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
      `,v.appendChild(g);let P=h.label||e.t("bookmark_no_label"),N=h.exactMatch?"":` ${e.t("bookmark_file_changed")}`;v.title=`${P} - ${B(h.timestamp)}${N}`,v.addEventListener("click",y=>{!s()||a&&!a.isConnected||(y.stopPropagation(),le(q()||a,h.timestamp)&&e.toast(`${e.t("toast_jumped_to_bookmark")}: ${B(h.timestamp)}`,2e3))}),u.appendChild(v)}),console.log(`${n} ✓ Created ${r.length} bookmark markers`)}async function k(){let a=o.current();console.log(`${n} updateBookmarkMarkersForCurrentVideo called`);let r=q();if(!r&&de(null)===null){console.log(`${n} No video element or OSD duration found`);return}let s=f();if(!s){console.log(`${n} No item data (no btnUserRating?)`);return}console.log(`${n} Fetching details for item:`,s.itemId);let d=await O(s.itemId);if(!a()||f()?.itemId!==s.itemId)return;if(!d){console.log(`${n} Failed to fetch item details`);return}console.log(`${n} Item details:`,d);let{bookmarks:l}=L(d.itemId,d.tmdbId,d.tvdbId,d.seasonNumber,d.episodeNumber);console.log(`${n} Found ${l.length} bookmarks for this item`),document.querySelector(".videoPlayerContainer video")===r&&U(r,l)}async function j(a="add",r=null){let s=o.current(),d=q(),l=ye(d);if(a==="add"&&l===null){e.toast(e.t("toast_player_unsupported"),3e3);return}let u=f();if(!u){s()&&e.toast(e.t("toast_bookmark_no_item"),3e3);return}let t=await O(u.itemId);if(!s()||f()?.itemId!==u.itemId)return;if(!t){s()&&e.toast(e.t("toast_bookmark_fetch_failed"),3e3);return}let{bookmarks:p}=L(t.itemId,t.tmdbId,t.tvdbId,t.seasonNumber,t.episodeNumber),b=a==="edit"&&r,h=b?e.t("bookmark_edit_title"):a==="view"?"Your Bookmarks":e.t("bookmark_add_title"),C=b?r.timestamp:l??0,c=b?r.label:"",v=`
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
          <div class="je-bookmark-hero-subtitle">${x(t.name)}</div>
        </div>
        <div class="je-bookmark-form-grid">
          <div class="je-bookmark-input-group">
            <label for="bookmark-time">${e.t("bookmark_time_label")}</label>
            <input
              type="text"
              id="bookmark-time"
              class="je-bookmark-input"
              value="${B(C)}"
              readonly>
          </div>
          <div class="je-bookmark-input-group">
            <label for="bookmark-label">${e.t("bookmark_label_label")}</label>
            <input
              type="text"
              id="bookmark-label"
              class="je-bookmark-input"
              placeholder="${e.t("bookmark_label_placeholder")}"
              value="${x(c)}"
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
                  <div class="je-bookmark-item-time">${B(y.timestamp)}</div>
                  ${y.label?`<div class="je-bookmark-item-label">${x(y.label)}</div>`:""}
                  ${y.exactMatch?"":`<div class="je-bookmark-item-warning">${e.t("bookmark_file_changed")}</div>`}
                </div>
                <div class="je-bookmark-item-actions">
                  <button class="je-bookmark-btn je-bookmark-btn-jump" data-bookmark-id="${x(y.id)}" title="${e.t("bookmark_jump")}">
                    <span class="material-icons">forward</span>
                  </button>
                  <button class="je-bookmark-btn je-bookmark-btn-delete" data-bookmark-id="${x(y.id)}" title="${e.t("bookmark_delete_confirm")}">
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
        ${v}
        <div class="je-bookmark-modal-actions">
          <button class="je-bookmark-btn-submit">${b?e.t("bookmark_save"):e.t("bookmark_add")}</button>
          <button class="je-bookmark-btn-cancel">
            <span class="material-icons" aria-hidden="true" style="font-size: 18px;">close</span>
            <span>Cancel</span>
          </button>
        </div>
      </div>
    `,document.body.appendChild(g),g.addEventListener("keydown",y=>y.stopPropagation()),g.addEventListener("keyup",y=>y.stopPropagation()),g.addEventListener("keypress",y=>y.stopPropagation()),g.addEventListener("wheel",y=>y.stopPropagation());let P=o.modal(g);Y(g,".je-bookmark-modal-close").addEventListener("click",P),Y(g,".je-bookmark-btn-cancel").addEventListener("click",P),g.addEventListener("click",y=>{y.target===g&&P()}),m(()=>{let y=g.querySelector("#bookmark-label");y&&y.focus(),g.style.opacity="1"},10);let N=Y(g,".je-bookmark-btn-submit");N.addEventListener("click",async()=>{if(!s())return;let y=Y(g,"#bookmark-label").value.trim();N.disabled=!0;try{if(b&&r){if(!await I(r.id,{label:y})){s()&&e.toast(e.t("toast_bookmark_save_failed"),3e3);return}s()&&e.toast(e.t("toast_bookmark_updated"),2e3)}else{if(!await w(C,y))return;s()&&e.toast(e.t("toast_bookmark_updated"),2e3)}if(!s())return;k(),P()}catch{s()&&e.toast(e.t("toast_bookmark_save_failed"),3e3)}finally{N.disabled=!1}}),g.querySelectorAll(".je-bookmark-btn-jump").forEach(y=>{y.addEventListener("click",()=>{let R=y.dataset.bookmarkId;if(!R)return;let z=p.find(ve=>ve.id===R);z&&le(q()||d,z.timestamp)&&(s()&&e.toast(`${e.t("toast_jumped_to_bookmark")}: ${B(z.timestamp)}`,2e3),P())})}),g.querySelectorAll(".je-bookmark-btn-delete").forEach(y=>{y.addEventListener("click",async()=>{if(!s())return;let R=y.dataset.bookmarkId;if(!R)return;y.disabled=!0;let z;try{z=await T(R)}finally{y.disabled=!1}if(!(!s()||z===null)){if(!z){s()&&e.toast(e.t("toast_bookmark_delete_failed"),3e3);return}s()&&e.toast(e.t("toast_bookmark_deleted"),2e3),k(),P(),m(()=>j(a,r),300)}})})}K.own.bookmarks={add:w,update:I,delete:T,deleteAll:S,findForItem:L,showModal:j,updateMarkers:k,formatTimestamp:B,syncBookmarks:_,cleanupOrphaned:F,backfillEpisodeMetadata:H,adjustOffsets:E};function i(){if(document.getElementById("jeBookmarkBtn"))return;let a=document.querySelector(".videoOsdBottom .buttons.focuscontainer-x");if(!a)return;let r=a.querySelector(".btnVideoOsdSettings");if(!r)return;let s=document.createElement("button");s.id="jeBookmarkBtn",s.setAttribute("is","paper-icon-button-light"),s.className="autoSize paper-icon-button-light",s.title=e.t("shortcut_BookmarkCurrentTime"),s.innerHTML='<span class="largePaperIconButton material-icons" aria-hidden="true">bookmark_add</span>',s.onclick=d=>{d.stopPropagation(),j("add")},r.parentElement?.insertBefore(s,r),console.log(`${n} ✓ Added OSD bookmark button`)}K.own.initializeBookmarks=(function(){let a=!1,r=[];return function(){if(a){console.log(`${n} Already initialized, skipping...`);return}a=!0,console.log(`${n} Initializing enhanced bookmarks...`),H().catch(c=>console.warn(`${n} Backfill failed:`,c));let s=null,d="je-bookmarks-osd",l="je-bookmarks-video-changes";function u(c,v){let g,P=()=>{g!==void 0&&window.clearTimeout(g),g=void 0};return r.push(P),(...N)=>{P();let y=o.current();g=window.setTimeout(()=>{g=void 0,a&&y()&&c(...N)},v)}}let t=u(()=>{if(!e.isVideoPage())return;let c=document.querySelector(".videoOsdBottom"),v=we();c&&(q()||v)&&v!==s&&(k(),i(),s=v,console.log(`${n} Injected markers/button for ${v}`))},200);function p(){if(!e.isVideoPage()){e.helpers.disconnectObserver(d);return}e.helpers.createObserver(d,t,document.body,{childList:!0,subtree:!0})}let b=u(c=>{c.target instanceof HTMLVideoElement&&e.isVideoPage()&&t()},300),h=u(c=>{c.target instanceof HTMLVideoElement&&e.isVideoPage()&&t()},300),C=()=>{e.isVideoPage()?(s=null,p(),t()):(s=null,e.helpers.disconnectObserver(d),e.helpers.disconnectObserver(l))};document.addEventListener("playing",b,!0),r.push(()=>document.removeEventListener("playing",b,!0)),document.addEventListener("loadedmetadata",h,!0),r.push(()=>document.removeEventListener("loadedmetadata",h,!0)),document.addEventListener("viewshow",C),r.push(()=>document.removeEventListener("viewshow",C)),e.isVideoPage()&&(p(),t()),K.own.cleanupBookmarks=function(){o.cancelPending(),r.forEach(c=>c()),document.querySelectorAll(".je-bookmark-marker, #jeBookmarkBtn, .je-bm-player-modal-overlay").forEach(c=>c.remove()),r=[],e.helpers.disconnectObserver(d),e.helpers.disconnectObserver(l),a=!1,console.log(`${n} Cleaned up`)},o.keep(K.own.cleanupBookmarks),console.log(`${n} ✓ Initialized`)}})()}_e(K.core);})();
})();
