(() => {
"use strict";(()=>{var ce=Object.defineProperty;var re=(e,t)=>{for(var b in t)ce(e,b,{get:t[b],enumerable:!0})};function ne(e,t,b){let n=t.core?.featureContext;if(typeof n!="function")throw new Error(`${e}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);return n(e,t,b)}function ie(e){let t=window.JellyfinEnhanced;if(!t)return;let b=t.core??(t.core={}),n=b.sharedModules;n||(n=Object.create(null),Object.defineProperty(b,"sharedModules",{value:n,configurable:!0,writable:!0,enumerable:!1}));for(let[u,x]of Object.entries(e))n[u]??(n[u]=x)}function G(e){let t=window.JellyfinEnhanced?.core?.sharedModules?.[e];if(!t)throw new Error(`${e} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return t}function Y(e,t){return e[t]}var te={};re(te,{createLifetime:()=>oe});var ee={};re(ee,{bookmarkOperation:()=>A,bookmarksHost:()=>Z,findBridge:()=>ke,isMissingItem:()=>J,lease:()=>M,persistBookmarks:()=>D,readItem:()=>ae,readItems:()=>K,readSessions:()=>be,record:()=>P});var me=G("contracts/schema"),V=Y(me,"bootstrapSchema");var ue=G("contracts/validate"),Q=Y(ue,"validateSchema");function Z(){let e=window,t=e.JellyfinEnhanced;if(!t)throw new Error("Bookmarks loaded before Jellyfin Enhanced");return{ctx:ne("bookmarks",t,{facades:["bookmarks","initializeBookmarks","cleanupBookmarks"],internalSlots:["bookmarksLibrary","bookmarkLifetimes"],internalsObject:()=>t.internals??(t.internals={})}),host:e,getApi:()=>{let u=e.ApiClient||e.ConnectionManager?.currentApiClient();if(!u)throw new Error("API client not available");return u}}}function ke(e){if(e.JE)return e.JE;if(e.JellyfinEnhanced)return e.JellyfinEnhanced;for(let t of[window.parent,window.top])try{let b=t,n=b?.JE||b?.JellyfinEnhanced;if(n)return n}catch{}return null}function P(e){return typeof e=="object"&&e!==null&&!Array.isArray(e)}function ae(e){if(!P(e)||typeof e.Id!="string")throw new Error("Invalid item response");let t=v=>typeof e[v]=="string"?e[v]:void 0,b=v=>typeof e[v]=="number"&&Number.isFinite(e[v])?e[v]:void 0,n=P(e.ProviderIds)?e.ProviderIds:{},u=P(e.ImageTags)?e.ImageTags:{},x=P(e.UserData)?e.UserData:{};return{Id:e.Id,Name:t("Name"),Type:t("Type"),SeriesId:t("SeriesId"),SeriesName:t("SeriesName"),ProductionYear:b("ProductionYear"),ParentIndexNumber:b("ParentIndexNumber"),IndexNumber:b("IndexNumber"),ProviderIds:{Tmdb:typeof n.Tmdb=="string"?n.Tmdb:void 0,Tvdb:typeof n.Tvdb=="string"?n.Tvdb:void 0},ImageTags:{Primary:typeof u.Primary=="string"?u.Primary:void 0},UserData:{Key:typeof x.Key=="string"?x.Key:void 0}}}function K(e){if(typeof e=="string")return K(JSON.parse(e));if(!P(e)||!Array.isArray(e.Items))throw new Error("Invalid items response");return e.Items.map(ae)}function be(e){if(!Array.isArray(e))throw new Error("Invalid sessions response");return e.flatMap(t=>P(t)&&typeof t.Id=="string"&&typeof t.DeviceId=="string"?[{Id:t.Id,DeviceId:t.DeviceId}]:[])}function M(e){let t=e.userConfig,b=e.session?.getEpoch();return()=>e.userConfig===t&&(b===void 0||e.session?.isCurrent(b)===!0)}function J(e){return P(e)&&(e.status===404||e.statusCode===404)||P(e)&&typeof e.message=="string"&&/^404(?:\b|$)/.test(e.message)}function X(e){if(e===null||typeof e=="string"||typeof e=="boolean"||typeof e=="number"&&Number.isFinite(e))return e;if(Array.isArray(e))return e.map(X);if(P(e))return Object.fromEntries(Object.entries(e).filter(([,t])=>t!==void 0).map(([t,b])=>[t,X(b)]));throw new Error("Invalid bookmark edit value")}function A(e,t,b,n){return{Kind:e,Id:t??null,SourceId:null,ExpectedItemId:n??null,Offset:null,Fields:b?X(b):null}}function fe(e){return Q(e,V.$defs.BookmarkSaveReceipt,V.$defs)}function pe(e){return Q(e,V.$defs.BookmarkDocumentResponse,V.$defs)}function ge(e){let t=new Set(["ItemId","TmdbId","TvdbId","MediaType","Name","Timestamp","Label","CreatedAt","UpdatedAt","SyncedFrom","SeasonNumber","EpisodeNumber","Progress"]),b=JSON.parse(e),n=P(b)?b:{},u=Object.entries(n).find(([v])=>v.toLowerCase()==="bookmarks")?.[1]??{};if(!P(u))throw new Error("Invalid bookmark records");let x=Object.fromEntries(Object.entries(u).map(([v,I])=>[v,P(I)?Object.fromEntries(Object.entries(I).map(([T,S])=>[t.has(T)?T.charAt(0).toLowerCase()+T.slice(1):T,S])):I]));return{...n,bookmarks:x}}function he(e,t,b){let n=e.bookmark?.bookmarks??{},u=b.some(x=>x.Kind==="delete-all")?{}:t.bookmarks;for(let x of b)for(let v of[x.Id,x.SourceId]){if(!v)continue;let I=n[v];I?u[v]=I:delete u[v]}e.bookmark={...t,bookmarks:u}}async function D(e,t,b,n){let u=t(),x=u.getCurrentUserId(),v=u.accessToken?.(),I=u.getUrl("/"),T=M(e);if(!T()||e.userConfig!==b||!x)throw new Error("Bookmark owner changed before saving");let S=b.bookmarkBinding;if(S&&(S.client!==u||S.userId!==x||S.token!==v||S.baseUrl!==I))throw new Error("Bookmark identity changed. Reload before saving again.");if(!b.bookmarkRevision)throw e.toast("Bookmarks were not loaded safely. Reload before saving again.",5e3),new Error("Loaded bookmark revision required. Reload before saving again.");let F=()=>T()&&t()===u&&u.getCurrentUserId()===x&&u.accessToken?.()===v&&u.getUrl("/")===I,H=u.getUrl(`/JellyfinEnhanced/user-settings/${x}/bookmark-document`),R=async $=>{let C=await u.ajax({type:"POST",url:H,contentType:"application/json",dataType:"json",data:JSON.stringify({Revision:$,Operations:n})});if(!fe(C)||!C.Revision)throw new Error("Invalid bookmark save receipt. Reload before saving again.");return C.Revision},E=!1;try{let $;try{$=await R(b.bookmarkRevision)}catch(C){if(E=P(C)&&(C.status===409||C.statusCode===409),!E||!F())throw C;let _=await u.ajax({type:"GET",url:u.getUrl(`/JellyfinEnhanced/user-settings/${x}/bookmark-document?_=${Date.now()}`),dataType:"json"});if(!pe(_))throw new Error("Invalid bookmark document");let U=ge(_.Document);$=await R(_.Revision),he(b,U,n)}b.bookmarkRevision=$}catch($){throw E&&F()&&window.setTimeout(()=>{F()&&e.toast("Bookmarks changed in another tab or on the server. Reload before saving again.",5e3)},0),$}}function oe(e,t){let b=e.core,n=e.own;n.bookmarkLifetimes??(n.bookmarkLifetimes={}),n.bookmarkLifetimes[t]?.dispose();let u=new Set,x=new Set,v=!1,I=0,T=new Set,S=c=>{if(typeof c=="function")u.add(()=>c());else if(typeof c=="object"&&c!==null&&"unsubscribe"in c&&typeof c.unsubscribe=="function"){let j=c.unsubscribe.bind(c);u.add(()=>j())}},F=c=>{if(typeof c=="object"&&c!==null&&"teardown"in c&&typeof c.teardown=="function"){let j=c.teardown.bind(c);u.add(()=>j())}else S(c)},H=(c,j,i,a=!1)=>{c.addEventListener(j,i,a),u.add(()=>c.removeEventListener(j,i,a))},R=(c,j)=>{let i=M(b),a=I,r=()=>{window.clearTimeout(s),u.delete(r),T.delete(r)},s=window.setTimeout(()=>{u.delete(r),T.delete(r),!v&&I===a&&i()&&c()},j);return u.add(r),T.add(r),s},E=(c,j)=>{let i=window.setInterval(()=>{v||c()},j);return u.add(()=>window.clearInterval(i)),i},$=c=>{let j=document.activeElement;c.setAttribute("role","dialog"),c.setAttribute("aria-modal","true"),c.tabIndex=-1;let i=()=>{c.remove(),u.delete(i),x.delete(i),document.removeEventListener("viewshow",i),j instanceof HTMLElement&&j.isConnected&&j.focus()};return u.add(i),x.add(i),document.addEventListener("viewshow",i),c.addEventListener("keydown",a=>{if(a.key==="Escape"&&(a.preventDefault(),i()),a.key!=="Tab")return;let r=Array.from(c.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]')),s=r[0],d=r[r.length-1];if(!s||!d){a.preventDefault(),c.focus();return}a.shiftKey&&(document.activeElement===s||document.activeElement===c)?(a.preventDefault(),d.focus()):!a.shiftKey&&document.activeElement===d&&(a.preventDefault(),s.focus())}),R(()=>{c.isConnected&&(c.querySelector("input")||c.querySelector("button")||c).focus()},0),i},C=()=>{I++;for(let c of T)c();for(let c of x)c()},_=()=>{if(!v){v=!0,C();for(let c of u)c();u.clear()}},U={dispose:_,cancelPending:C,keep:F,listen:H,timeout:R,interval:E,modal:$,current:()=>{let c=M(b),j=I;return()=>!v&&I===j&&c()}};return n.bookmarkLifetimes[t]=U,S(b.session?.onUserChange("bookmarks-"+t,()=>{for(let c of x)c();document.querySelectorAll(".je-bm-player-modal-overlay, .je-bm-library-modal-overlay, .je-bookmark-marker").forEach(c=>c.remove()),document.querySelectorAll(".sections.bookmarks").forEach(c=>c.replaceChildren())})),H(window,"pagehide",c=>{c.target===window&&!c.persisted&&_()}),U}ie({"features/bookmarks/lifetime":te,"features/bookmarks/host":ee});function W(e,t){let b=e.querySelector(t);if(!b)throw new Error("Missing bookmark control: "+t);return b}function se(e){let t=Number.isFinite(e)?Math.max(0,e):0,b=Math.floor(t/3600),n=Math.floor(t%3600/60),u=Math.floor(t%60);return b>0?`${b}:${String(n).padStart(2,"0")}:${String(u).padStart(2,"0")}`:`${n}:${String(u).padStart(2,"0")}`}function de(e,t,b){let n="🪼 Jellyfin Enhanced: Bookmarks:";function u(i="updated"){try{document.dispatchEvent(new CustomEvent("je-bookmarks-updated",{detail:{reason:i}}))}catch(a){console.warn(`${n} Failed to emit update event`,a)}}let x=new WeakMap;function v(i,a){let r=(x.get(i)||Promise.resolve()).then(a);return x.set(i,r.catch(()=>{})),r}let I=null;async function T(i){let a=e.userConfig,r=e.session?e.session.getEpoch():0;(!I||I.owner!==a||I.epoch!==r||I.itemId!==i)&&(I={owner:a,epoch:r,itemId:i,data:null,pending:null});let s=I;if(s.itemId===i&&s.data)return s.data;if(s.pending&&s.itemId===i)return s.pending;let d=(async()=>{try{let l=t().getCurrentUserId?.();if(!l)return null;let m=K(await t().ajax({type:"GET",url:t().getUrl(`/Users/${l}/Items`,{Ids:i,Fields:"ProviderIds,Type,Name,SeriesId,ParentIndexNumber,IndexNumber"}),dataType:"json"}));if(e.userConfig!==a||e.session&&!e.session.isCurrent(r))return null;let o=m[0];if(!o)return null;let p=o;if((o.Type==="Season"||o.Type==="Episode")&&o.SeriesId)try{let N=K(await t().ajax({type:"GET",url:t().getUrl(`/Users/${l}/Items`,{Ids:o.SeriesId,Fields:"ProviderIds,Type,Name"}),dataType:"json"}))[0];N&&(p={...o,ProviderIds:{...o.ProviderIds||{},Tmdb:N.ProviderIds?.Tmdb||o.ProviderIds?.Tmdb,Tvdb:o.ProviderIds?.Tvdb||N.ProviderIds?.Tvdb}})}catch(B){console.warn(`${n} Failed to fetch series info:`,B)}let f=p.ProviderIds?.Tmdb||null,y=p.ProviderIds?.Tvdb||null,O=o.Type==="Movie"?"movie":o.Type==="Series"||o.Type==="Episode"||o.Type==="Season"?"tv":(o.Type||"").toString().toLowerCase(),k=o.Type==="Episode"?o.ParentIndexNumber??null:null,g=o.Type==="Episode"?o.IndexNumber??null:null,h={itemId:o.Id,tmdbId:f,tvdbId:y,mediaType:O,name:o.Name||"Unknown",type:o.Type,seasonNumber:k,episodeNumber:g};return e.userConfig!==a||e.session&&!e.session.isCurrent(r)?null:(s.data=h,h)}catch(l){return console.warn(`${n} Error fetching item details:`,l),null}finally{s.pending=null}})();return s.itemId=i,s.pending=d,d}function S(){return`bm_${Date.now()}_${Math.random().toString(36).substr(2,9)}`}function F(i,a,r,s=null,d=null){let l=e.userConfig?.bookmark?.bookmarks||{},m=[],o=[],p=d!==null;for(let[O,k]of Object.entries(l))if(!(typeof k!="object"||k===null)){if(k.itemId===i){m.push({...k,id:O,exactMatch:!0});continue}if(!(p&&k.episodeNumber!=null&&!(k.episodeNumber===d&&(k.seasonNumber??null)===(s??null)))){if(a&&k.tmdbId===a){o.push({...k,id:O,exactMatch:!1});continue}r&&k.tvdbId===r&&o.push({...k,id:O,exactMatch:!1})}}let f=m.length>0?m:o,y=m.length===0&&o.length>0;return{bookmarks:f,hasIdMismatch:y,exactMatches:m,providerMatches:o}}async function H(i,a=""){if(!Number.isFinite(i)||i<0)throw new Error("Invalid bookmark timestamp");let r=e.userConfig,s=M(e),d=b();if(!d)return e.toast(e.t("toast_bookmark_no_item"),3e3),null;let l=await T(d.itemId);return s()?l?v(r,async()=>{if(!s())return null;let m=S(),o=new Date().toISOString(),p={itemId:l.itemId||"",tmdbId:l.tmdbId||"",tvdbId:l.tvdbId||"",mediaType:l.mediaType||"",name:l.name||"",timestamp:i,label:a||"",createdAt:o,updatedAt:o,syncedFrom:"",seasonNumber:l.seasonNumber??null,episodeNumber:l.episodeNumber??null};r.bookmark||(r.bookmark={bookmarks:{}}),r.bookmark.bookmarks||(r.bookmark.bookmarks={});let f=r.bookmark.bookmarks;f[m]=p;try{return await D(e,t,r,[A("create",m,p)]),console.log(`${n} Bookmark added:`,m,p),s()&&u("add"),{...p,id:m}}catch(y){throw console.error(`${n} Failed to save bookmark:`,y),delete f[m],y}}):(e.toast(e.t("toast_bookmark_fetch_failed"),3e3),null):null}async function R(i,a){if(a.timestamp!==void 0&&(!Number.isFinite(a.timestamp)||a.timestamp<0))return!1;let r=e.userConfig,s=M(e);return e.userConfig?.bookmark?.bookmarks?.[i]?v(r,async()=>{if(!s()||!r.bookmark?.bookmarks?.[i])return console.warn(`${n} Bookmark not found:`,i),!1;let d=r.bookmark.bookmarks,l=d[i];if(!l)return!1;let m={...l,...Object.fromEntries(Object.entries(a).filter(([,o])=>o!==void 0)),updatedAt:new Date().toISOString()};d[i]=m;try{return await D(e,t,r,[A("edit",i,a,l.itemId)]),console.log(`${n} Bookmark updated:`,i),s()&&u("update"),!0}catch(o){return d[i]===m&&(d[i]=l),console.error(`${n} Failed to update bookmark:`,o),!1}}):(console.warn(`${n} Bookmark not found:`,i),!1)}function E(i){return $(i)}async function $(i,a){let r=e.userConfig,s=M(e);return e.userConfig?.bookmark?.bookmarks?.[i]?v(r,async()=>{if(!s()||!r.bookmark?.bookmarks?.[i])return console.warn(`${n} Bookmark not found:`,i),null;let d=r.bookmark.bookmarks,l=d[i];if(!l)return!1;if(a!==void 0&&l.itemId!==a)return null;delete d[i];try{return await D(e,t,r,[A("delete",i,void 0,l.itemId)]),console.log(`${n} Bookmark deleted:`,i),s()&&u("delete"),!0}catch(m){return Object.prototype.hasOwnProperty.call(d,i)||(d[i]=l),console.error(`${n} Failed to delete bookmark:`,m),!1}}):(console.warn(`${n} Bookmark not found:`,i),null)}async function C(){let i=e.userConfig,a=M(e);return v(i,async()=>{if(!a())return!1;i.bookmark||(i.bookmark={bookmarks:{}});let r=i.bookmark.bookmarks,s={};i.bookmark.bookmarks=s;try{return await D(e,t,i,[A("delete-all")]),console.log(`${n} All bookmarks deleted`),!0}catch(d){throw i.bookmark.bookmarks===s&&(i.bookmark.bookmarks=r),console.error(`${n} Failed to delete all bookmarks:`,d),d}})}async function _(i,a,r=0,{replaceOriginals:s=!1}={}){let d=e.userConfig,l=M(e);if(!Number.isFinite(r))throw new Error("Invalid bookmark offset");let m=i.map(o=>({...o}));return v(d,async()=>{if(!l())throw new Error("Bookmark owner changed before sync");d.bookmark||(d.bookmark={bookmarks:{}});let o=d.bookmark.bookmarks,p=m.map(k=>{if(!k.id)throw new Error("Stored bookmark identity required for copying");let g=k.id?o[k.id]:void 0;if(!g||g.itemId!==k.itemId)throw new Error("Bookmark selection changed before sync");return{...g,id:k.id,exactMatch:k.exactMatch}});if(p.some(k=>!Number.isFinite(k.timestamp)||!Number.isFinite(k.timestamp+r)))throw new Error("Invalid bookmark offset");let f=[],y=[],O=new Date().toISOString();if(s){for(let{id:k}of p)if(k&&Object.prototype.hasOwnProperty.call(o,k)){let g=o[k];g&&y.push([k,g]),delete o[k]}}for(let k of p){let g=S(),h=Math.max(0,k.timestamp+r),{id:B,exactMatch:N,...w}=k,L={...w,itemId:a.itemId,tmdbId:a.tmdbId??null,tvdbId:a.tvdbId??null,mediaType:a.mediaType??"",name:a.name??"",timestamp:h,label:k.label||"",createdAt:k.createdAt||O,updatedAt:O,syncedFrom:k.itemId,seasonNumber:a.seasonNumber??null,episodeNumber:a.episodeNumber??null};o[g]=L,f.push({...L,id:g})}try{return await D(e,t,d,f.map((k,g)=>{let h=p[g];if(!h?.id)throw new Error("Stored bookmark identity required for copying");return{...A(s?"replace":"copy",k.id,{itemId:k.itemId,tmdbId:k.tmdbId,tvdbId:k.tvdbId,mediaType:k.mediaType,name:k.name,seasonNumber:k.seasonNumber,episodeNumber:k.episodeNumber},h.itemId),SourceId:h.id,Offset:r}})),console.log(`${n} Synced ${f.length} bookmarks to new item ID`),l()&&u("sync"),f}catch(k){throw console.error(`${n} Failed to sync bookmarks:`,k),f.forEach(g=>delete o[g.id]),y.forEach(([g,h])=>{o[g]=h}),k}})}async function U(i,a){if(!Number.isFinite(a))throw new Error("Invalid offset");let r=e.userConfig,s=M(e);return v(r,async()=>{if(!s())throw new Error("Bookmark owner changed before offset adjustment");let d=r.bookmark?.bookmarks;if(!d)return 0;if(i.some(m=>{let o=d[m.id];return o&&Number.isFinite(o.timestamp)&&!Number.isFinite(o.timestamp+a)}))throw new Error("Invalid bookmark offset");let l=[];for(let m of i){let o=d[m.id];if(!o||o.itemId!==m.itemId||!Number.isFinite(o.timestamp))continue;let p={...o,timestamp:Math.max(0,o.timestamp+a),syncedFrom:"",updatedAt:new Date().toISOString()};d[m.id]=p,l.push([m.id,o,p])}if(!l.length)return 0;try{return await D(e,t,r,l.map(([m,o])=>({...A("offset",m,void 0,o.itemId),Offset:a}))),s()&&u("offset"),l.length}catch(m){for(let[o,p,f]of l)d[o]===f&&(d[o]=p);throw m}})}async function c(){let i=e.userConfig,a=M(e),r=i?.bookmark?.bookmarks||{},s=Object.entries(r).filter(([,l])=>l?.mediaType==="tv"&&l.itemId&&l.episodeNumber==null);if(s.length===0)return;let d=[];for(let[l,m]of s){if(!a())return;try{let o=await T(m.itemId);if(!a())return;o?.episodeNumber!=null&&d.push([l,m.itemId,o])}catch{}}d.length!==0&&await v(i,async()=>{if(!a())return;let l=i.bookmark?.bookmarks;if(!l)return;let m=[];for(let[o,p,f]of d){let y=l[o];if(!y||y.itemId!==p||y.episodeNumber!=null)continue;let O={...y,seasonNumber:f.seasonNumber,episodeNumber:f.episodeNumber,...f.tvdbId?{tvdbId:f.tvdbId}:{}};l[o]=O,m.push([o,y,O])}if(m.length!==0)try{await D(e,t,i,m.map(([o,p,f])=>A("backfill",o,{seasonNumber:f.seasonNumber,episodeNumber:f.episodeNumber,...f.tvdbId?{tvdbId:f.tvdbId}:{}},p.itemId))),console.log(`${n} Backfilled episode metadata for ${m.length} bookmark(s)`)}catch(o){m.forEach(([p,f,y])=>{l[p]===y&&(l[p]=f)}),console.warn(`${n} Failed to save backfilled episode metadata:`,o)}})}async function j(){let i=M(e),a=e.userConfig?.bookmark?.bookmarks||{},r=new Set,s=[];for(let o of Object.values(a))o?.itemId&&r.add(o.itemId);let d=t().getCurrentUserId?.();if(!d)return{cleaned:0,errors:0};let l=0,m=0;for(let o of r)try{if(await(e.helpers?.getItemCached?e.helpers.getItemCached(o,{userId:d}):t().getItem(d,o)),!i())return{cleaned:0,errors:0}}catch(p){if(!i())return{cleaned:0,errors:0};if(!J(p)){m++;continue}for(let[f,y]of Object.entries(a))y?.itemId===o&&s.push({bookmarkId:f,itemId:o})}for(let{bookmarkId:o,itemId:p}of s){if(!i())return{cleaned:l,errors:m};try{let f=await $(o,p);f?l++:f===!1&&m++}catch{m++}}return console.log(`${n} Cleanup: ${l} orphaned bookmarks removed, ${m} errors`),{cleaned:l,errors:m}}return{addBookmark:H,updateBookmark:R,deleteBookmark:E,deleteAllBookmarks:C,syncBookmarks:_,backfillEpisodeMetadata:c,cleanupOrphanedBookmarks:j,findBookmarksForItem:F,fetchItemDetails:T,formatTimestamp:se,adjustOffsets:U}}var{ctx:z,host:Ye,getApi:ye}=Z();function we(e){let t=oe(z,"bookmarks"),b=t.timeout;if(!e.pluginConfig?.BookmarksEnabled){console.log("🪼 Jellyfin Enhanced: Bookmarks feature is disabled");return}let n="🪼 Jellyfin Enhanced: Bookmarks:";function u(){try{let r=document.querySelector(".videoOsdBottom .btnUserRating[data-id]")?.dataset?.id||null;return r?{itemId:r}:(console.debug(`${n} No item ID found`),null)}catch(a){return console.warn(`${n} Error getting item data:`,a),null}}let x=e.escapeHtml,{addBookmark:v,updateBookmark:I,deleteBookmark:T,deleteAllBookmarks:S,syncBookmarks:F,backfillEpisodeMetadata:H,cleanupOrphanedBookmarks:R,findBookmarksForItem:E,fetchItemDetails:$,formatTimestamp:C,adjustOffsets:_}=de(e,ye,u);function U(a,r){let s=t.current();if(console.log(`${n} createBookmarkMarkers called - video:`,!!a,"bookmarks:",r.length),!a){console.log(`${n} Early return - no video or no bookmarks`);return}let d=document.querySelector(".videoOsdBottom");if(!d){console.log(`${n} No .videoOsdBottom found`);return}let l=d.querySelector('.osdPositionSlider, .sliderBubble, .mdl-slider, input[type="range"]');if(!l){console.log(`${n} No position slider found`);return}let m=l.closest(".osdPositionSliderContainer, .sliderContainer")||l.parentElement;if(!m){console.log(`${n} No slider container found`);return}window.getComputedStyle(m).position==="static"&&(m.style.position="relative");let p=m.querySelectorAll(".je-bookmark-marker");console.log(`${n} Removing ${p.length} existing markers`),p.forEach(y=>y.remove());let f=a.duration;if(!f||!isFinite(f)){console.log(`${n} Invalid duration:`,f);return}r.forEach(y=>{if(!Number.isFinite(y.timestamp)||y.timestamp<0)return;let O=y.timestamp/f*100,k=y.exactMatch?"#00d4ff":"#ffa500",g=document.createElement("div");g.className="je-bookmark-marker",g.style.cssText=`
        position: absolute;
        left: ${O}%;
        bottom: 0%;
        transform: translate(-50%, -50%);
        z-index: 1000;
        pointer-events: all;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
      `;let h=document.createElement("span");h.className="material-icons",h.textContent="location_pin",h.style.cssText=`
        font-size: 24px;
        color: ${k};
        filter: drop-shadow(0 2px 4px rgba(0,0,0,0.8));
        pointer-events: none;
      `,g.appendChild(h);let B=y.label||e.t("bookmark_no_label"),N=y.exactMatch?"":` ${e.t("bookmark_file_changed")}`;g.title=`${B} - ${C(y.timestamp)}${N}`,g.addEventListener("click",w=>{!s()||!a.isConnected||(w.stopPropagation(),a.currentTime=y.timestamp,e.toast(`${e.t("toast_jumped_to_bookmark")}: ${C(y.timestamp)}`,2e3))}),m.appendChild(g)}),console.log(`${n} ✓ Created ${r.length} bookmark markers`)}async function c(){let a=t.current();console.log(`${n} updateBookmarkMarkersForCurrentVideo called`);let r=document.querySelector(".videoPlayerContainer video");if(!r){console.log(`${n} No video element found`);return}let s=u();if(!s){console.log(`${n} No item data (no btnUserRating?)`);return}console.log(`${n} Fetching details for item:`,s.itemId);let d=await $(s.itemId);if(!a()||u()?.itemId!==s.itemId)return;if(!d){console.log(`${n} Failed to fetch item details`);return}console.log(`${n} Item details:`,d);let{bookmarks:l}=E(d.itemId,d.tmdbId,d.tvdbId,d.seasonNumber,d.episodeNumber);console.log(`${n} Found ${l.length} bookmarks for this item`),document.querySelector(".videoPlayerContainer video")===r&&U(r,l)}async function j(a="add",r=null){let s=t.current(),d=document.querySelector(".videoPlayerContainer video"),l=d?.currentTime||0,m=u();if(!m){s()&&e.toast(e.t("toast_bookmark_no_item"),3e3);return}let o=await $(m.itemId);if(!s()||u()?.itemId!==m.itemId)return;if(!o){s()&&e.toast(e.t("toast_bookmark_fetch_failed"),3e3);return}let{bookmarks:p}=E(o.itemId,o.tmdbId,o.tvdbId,o.seasonNumber,o.episodeNumber),f=a==="edit"&&r,y=f?e.t("bookmark_edit_title"):a==="view"?"Your Bookmarks":e.t("bookmark_add_title"),O=f?r.timestamp:l,k=f?r.label:"",g=`
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
            <span>${y}</span>
          </div>
          <div class="je-bookmark-hero-subtitle">${x(o.name)}</div>
        </div>
        <div class="je-bookmark-form-grid">
          <div class="je-bookmark-input-group">
            <label for="bookmark-time">${e.t("bookmark_time_label")}</label>
            <input
              type="text"
              id="bookmark-time"
              class="je-bookmark-input"
              value="${C(O)}"
              readonly>
          </div>
          <div class="je-bookmark-input-group">
            <label for="bookmark-label">${e.t("bookmark_label_label")}</label>
            <input
              type="text"
              id="bookmark-label"
              class="je-bookmark-input"
              placeholder="${e.t("bookmark_label_placeholder")}"
              value="${x(k)}"
              maxlength="100">
          </div>
        </div>
        ${p.length>0?`
          <div class="je-bookmark-list">
            <div class="je-bookmark-list-header">
              <div class="je-bookmark-list-title">${e.t("bookmark_existing_title")}</div>
              <div class="je-bookmark-list-count">${p.length}</div>
            </div>
            ${p.map(w=>`
              <div class="je-bookmark-item">
                <div class="je-bookmark-item-marker"></div>
                <div class="je-bookmark-item-content">
                  <div class="je-bookmark-item-time">${C(w.timestamp)}</div>
                  ${w.label?`<div class="je-bookmark-item-label">${x(w.label)}</div>`:""}
                  ${w.exactMatch?"":`<div class="je-bookmark-item-warning">${e.t("bookmark_file_changed")}</div>`}
                </div>
                <div class="je-bookmark-item-actions">
                  <button class="je-bookmark-btn je-bookmark-btn-jump" data-bookmark-id="${x(w.id)}" title="${e.t("bookmark_jump")}">
                    <span class="material-icons">forward</span>
                  </button>
                  <button class="je-bookmark-btn je-bookmark-btn-delete" data-bookmark-id="${x(w.id)}" title="${e.t("bookmark_delete_confirm")}">
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
    `,h=document.createElement("div");h.className="je-bm-player-modal-overlay",h.innerHTML=`
      <div class="je-bm-player-modal-container">
        <button class="je-bookmark-modal-close">×</button>
        ${g}
        <div class="je-bookmark-modal-actions">
          <button class="je-bookmark-btn-submit">${f?e.t("bookmark_save"):e.t("bookmark_add")}</button>
          <button class="je-bookmark-btn-cancel">
            <span class="material-icons" aria-hidden="true" style="font-size: 18px;">close</span>
            <span>Cancel</span>
          </button>
        </div>
      </div>
    `,document.body.appendChild(h),h.addEventListener("keydown",w=>w.stopPropagation()),h.addEventListener("keyup",w=>w.stopPropagation()),h.addEventListener("keypress",w=>w.stopPropagation()),h.addEventListener("wheel",w=>w.stopPropagation());let B=t.modal(h);W(h,".je-bookmark-modal-close").addEventListener("click",B),W(h,".je-bookmark-btn-cancel").addEventListener("click",B),h.addEventListener("click",w=>{w.target===h&&B()}),b(()=>{let w=h.querySelector("#bookmark-label");w&&w.focus(),h.style.opacity="1"},10);let N=W(h,".je-bookmark-btn-submit");N.addEventListener("click",async()=>{if(!s())return;let w=W(h,"#bookmark-label").value.trim();N.disabled=!0;try{if(f&&r){if(!await I(r.id,{label:w})){s()&&e.toast(e.t("toast_bookmark_save_failed"),3e3);return}s()&&e.toast(e.t("toast_bookmark_updated"),2e3)}else{if(!await v(O,w))return;s()&&e.toast(e.t("toast_bookmark_updated"),2e3)}if(!s())return;c(),B()}catch{s()&&e.toast(e.t("toast_bookmark_save_failed"),3e3)}finally{N.disabled=!1}}),h.querySelectorAll(".je-bookmark-btn-jump").forEach(w=>{w.addEventListener("click",()=>{let L=w.dataset.bookmarkId;if(!L)return;let q=p.find(le=>le.id===L);q&&d&&(d.currentTime=q.timestamp,s()&&e.toast(`${e.t("toast_jumped_to_bookmark")}: ${C(q.timestamp)}`,2e3),B())})}),h.querySelectorAll(".je-bookmark-btn-delete").forEach(w=>{w.addEventListener("click",async()=>{if(!s())return;let L=w.dataset.bookmarkId;if(!L)return;w.disabled=!0;let q;try{q=await T(L)}finally{w.disabled=!1}if(!(!s()||q===null)){if(!q){s()&&e.toast(e.t("toast_bookmark_delete_failed"),3e3);return}s()&&e.toast(e.t("toast_bookmark_deleted"),2e3),c(),B(),b(()=>j(a,r),300)}})})}z.own.bookmarks={add:v,update:I,delete:T,deleteAll:S,findForItem:E,showModal:j,updateMarkers:c,formatTimestamp:C,syncBookmarks:F,cleanupOrphaned:R,backfillEpisodeMetadata:H,adjustOffsets:_};function i(){if(document.getElementById("jeBookmarkBtn"))return;let a=document.querySelector(".videoOsdBottom .buttons.focuscontainer-x");if(!a)return;let r=a.querySelector(".btnVideoOsdSettings");if(!r)return;let s=document.createElement("button");s.id="jeBookmarkBtn",s.setAttribute("is","paper-icon-button-light"),s.className="autoSize paper-icon-button-light",s.title=e.t("shortcut_BookmarkCurrentTime"),s.innerHTML='<span class="largePaperIconButton material-icons" aria-hidden="true">bookmark_add</span>',s.onclick=d=>{d.stopPropagation(),j("add")},r.parentElement?.insertBefore(s,r),console.log(`${n} ✓ Added OSD bookmark button`)}z.own.initializeBookmarks=(function(){let a=!1,r=[];return function(){if(a){console.log(`${n} Already initialized, skipping...`);return}a=!0,console.log(`${n} Initializing enhanced bookmarks...`),H().catch(g=>console.warn(`${n} Backfill failed:`,g));let s=null,d="je-bookmarks-osd",l="je-bookmarks-video-changes";function m(){let g=document.querySelector(".videoPlayerContainer video");return g?.currentSrc||g?.src||window.location.href}function o(g,h){let B,N=()=>{B!==void 0&&window.clearTimeout(B),B=void 0};return r.push(N),(...w)=>{N();let L=t.current();B=window.setTimeout(()=>{B=void 0,a&&L()&&g(...w)},h)}}let p=o(()=>{if(!e.isVideoPage())return;let g=document.querySelector(".videoOsdBottom"),h=document.querySelector(".videoPlayerContainer video"),B=m();g&&h&&B!==s&&(c(),i(),s=B,console.log(`${n} Injected markers/button for ${B}`))},200);function f(){if(!e.isVideoPage()){e.helpers.disconnectObserver(d);return}e.helpers.createObserver(d,p,document.body,{childList:!0,subtree:!0})}let y=o(g=>{g.target instanceof HTMLVideoElement&&e.isVideoPage()&&p()},300),O=o(g=>{g.target instanceof HTMLVideoElement&&e.isVideoPage()&&p()},300),k=()=>{e.isVideoPage()?(s=null,f(),p()):(s=null,e.helpers.disconnectObserver(d),e.helpers.disconnectObserver(l))};document.addEventListener("playing",y,!0),r.push(()=>document.removeEventListener("playing",y,!0)),document.addEventListener("loadedmetadata",O,!0),r.push(()=>document.removeEventListener("loadedmetadata",O,!0)),document.addEventListener("viewshow",k),r.push(()=>document.removeEventListener("viewshow",k)),e.isVideoPage()&&(f(),p()),z.own.cleanupBookmarks=function(){t.cancelPending(),r.forEach(g=>g()),document.querySelectorAll(".je-bookmark-marker, #jeBookmarkBtn, .je-bm-player-modal-overlay").forEach(g=>g.remove()),r=[],e.helpers.disconnectObserver(d),e.helpers.disconnectObserver(l),a=!1,console.log(`${n} Cleaned up`)},t.keep(z.own.cleanupBookmarks),console.log(`${n} ✓ Initialized`)}})()}we(z.core);})();
})();
