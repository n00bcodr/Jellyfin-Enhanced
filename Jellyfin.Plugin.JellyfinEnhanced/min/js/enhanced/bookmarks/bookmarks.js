(() => {
"use strict";(()=>{var le=Object.defineProperty;var oe=(e,n)=>{for(var p in n)le(e,p,{get:n[p],enumerable:!0})};function te(e,n,p){let s=n.core?.featureContext;if(typeof s!="function")throw new Error(`${e}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);return s(e,n,p)}function re(e){let n=window.JellyfinEnhanced;if(!n)return;let p=n.core??(n.core={}),s=p.sharedModules;s||(s=Object.create(null),Object.defineProperty(p,"sharedModules",{value:s,configurable:!0,writable:!0,enumerable:!1}));for(let[k,x]of Object.entries(e))s[k]??(s[k]=x)}function K(e){let n=window.JellyfinEnhanced?.core?.sharedModules?.[e];if(!n)throw new Error(`${e} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return n}function W(e,n){return e[n]}var ee={};oe(ee,{createLifetime:()=>J});var Z={};oe(Z,{bookmarkOperation:()=>E,bookmarksHost:()=>Q,findBridge:()=>ue,isMissingItem:()=>X,lease:()=>S,persistBookmarks:()=>_,readItem:()=>ie,readItems:()=>D,readSessions:()=>ke,record:()=>L});var ce=K("contracts/schema"),Y=W(ce,"bootstrapSchema");var me=K("contracts/validate"),ne=W(me,"validateSchema");function Q(){let e=window,n=e.JellyfinEnhanced;if(!n)throw new Error("Bookmarks loaded before Jellyfin Enhanced");return{ctx:te("bookmarks",n,{facades:["bookmarks","initializeBookmarks","cleanupBookmarks"],internalSlots:["bookmarksLibrary","bookmarkLifetimes"],internalsObject:()=>n.internals??(n.internals={})}),host:e,getApi:()=>{let k=e.ApiClient||e.ConnectionManager?.currentApiClient();if(!k)throw new Error("API client not available");return k}}}function ue(e){if(e.JE)return e.JE;if(e.JellyfinEnhanced)return e.JellyfinEnhanced;for(let n of[window.parent,window.top])try{let p=n,s=p?.JE||p?.JellyfinEnhanced;if(s)return s}catch{}return null}function L(e){return typeof e=="object"&&e!==null&&!Array.isArray(e)}function ie(e){if(!L(e)||typeof e.Id!="string")throw new Error("Invalid item response");let n=v=>typeof e[v]=="string"?e[v]:void 0,p=v=>typeof e[v]=="number"&&Number.isFinite(e[v])?e[v]:void 0,s=L(e.ProviderIds)?e.ProviderIds:{},k=L(e.ImageTags)?e.ImageTags:{},x=L(e.UserData)?e.UserData:{};return{Id:e.Id,Name:n("Name"),Type:n("Type"),SeriesId:n("SeriesId"),SeriesName:n("SeriesName"),ProductionYear:p("ProductionYear"),ParentIndexNumber:p("ParentIndexNumber"),IndexNumber:p("IndexNumber"),ProviderIds:{Tmdb:typeof s.Tmdb=="string"?s.Tmdb:void 0,Tvdb:typeof s.Tvdb=="string"?s.Tvdb:void 0},ImageTags:{Primary:typeof k.Primary=="string"?k.Primary:void 0},UserData:{Key:typeof x.Key=="string"?x.Key:void 0}}}function D(e){if(typeof e=="string")return D(JSON.parse(e));if(!L(e)||!Array.isArray(e.Items))throw new Error("Invalid items response");return e.Items.map(ie)}function ke(e){if(!Array.isArray(e))throw new Error("Invalid sessions response");return e.flatMap(n=>L(n)&&typeof n.Id=="string"&&typeof n.DeviceId=="string"?[{Id:n.Id,DeviceId:n.DeviceId}]:[])}function S(e){let n=e.userConfig,p=e.session?.getEpoch();return()=>e.userConfig===n&&(p===void 0||e.session?.isCurrent(p)===!0)}function X(e){return L(e)&&(e.status===404||e.statusCode===404)||L(e)&&typeof e.message=="string"&&/^404(?:\b|$)/.test(e.message)}function G(e){if(e===null||typeof e=="string"||typeof e=="boolean"||typeof e=="number"&&Number.isFinite(e))return e;if(Array.isArray(e))return e.map(G);if(L(e))return Object.fromEntries(Object.entries(e).filter(([,n])=>n!==void 0).map(([n,p])=>[n,G(p)]));throw new Error("Invalid bookmark edit value")}function E(e,n,p,s){return{Kind:e,Id:n??null,SourceId:null,ExpectedItemId:s??null,Offset:null,Fields:p?G(p):null}}function fe(e){return ne(e,Y.$defs.BookmarkSaveReceipt,Y.$defs)}async function _(e,n,p,s){let k=n(),x=k.getCurrentUserId(),v=k.accessToken?.(),B=k.getUrl("/"),T=S(e);if(!T()||e.userConfig!==p||!x)throw new Error("Bookmark owner changed before saving");let $=p.bookmarkBinding;if($&&($.client!==k||$.userId!==x||$.token!==v||$.baseUrl!==B))throw new Error("Bookmark identity changed. Reload before saving again.");if(!p.bookmarkRevision)throw e.toast("Bookmarks were not loaded safely. Reload before saving again.",5e3),new Error("Loaded bookmark revision required. Reload before saving again.");try{let O=await k.ajax({type:"POST",url:k.getUrl(`/JellyfinEnhanced/user-settings/${x}/bookmark-document`),contentType:"application/json",dataType:"json",data:JSON.stringify({Revision:p.bookmarkRevision,Operations:s})});if(!fe(O)||!O.Revision)throw new Error("Invalid bookmark save receipt. Reload before saving again.");p.bookmarkRevision=O.Revision}catch(O){throw T()&&n()===k&&k.getCurrentUserId()===x&&k.accessToken?.()===v&&k.getUrl("/")===B&&L(O)&&(O.status===409||O.statusCode===409)&&window.setTimeout(()=>{T()&&n()===k&&k.getCurrentUserId()===x&&k.accessToken?.()===v&&k.getUrl("/")===B&&e.toast("Bookmarks changed in another tab or on the server. Reload before saving again.",5e3)},0),O}}function J(e,n){let p=e.core,s=e.own;s.bookmarkLifetimes??(s.bookmarkLifetimes={}),s.bookmarkLifetimes[n]?.dispose();let k=new Set,x=new Set,v=!1,B=0,T=new Set,$=c=>{if(typeof c=="function")k.add(()=>c());else if(typeof c=="object"&&c!==null&&"unsubscribe"in c&&typeof c.unsubscribe=="function"){let I=c.unsubscribe.bind(c);k.add(()=>I())}},O=c=>{if(typeof c=="object"&&c!==null&&"teardown"in c&&typeof c.teardown=="function"){let I=c.teardown.bind(c);k.add(()=>I())}else $(c)},F=(c,I,r,i=!1)=>{c.addEventListener(I,r,i),k.add(()=>c.removeEventListener(I,r,i))},A=(c,I)=>{let r=S(p),i=B,t=()=>{window.clearTimeout(a),k.delete(t),T.delete(t)},a=window.setTimeout(()=>{k.delete(t),T.delete(t),!v&&B===i&&r()&&c()},I);return k.add(t),T.add(t),a},H=(c,I)=>{let r=window.setInterval(()=>{v||c()},I);return k.add(()=>window.clearInterval(r)),r},R=c=>{let I=document.activeElement;c.setAttribute("role","dialog"),c.setAttribute("aria-modal","true"),c.tabIndex=-1;let r=()=>{c.remove(),k.delete(r),x.delete(r),document.removeEventListener("viewshow",r),I instanceof HTMLElement&&I.isConnected&&I.focus()};return k.add(r),x.add(r),document.addEventListener("viewshow",r),c.addEventListener("keydown",i=>{if(i.key==="Escape"&&(i.preventDefault(),r()),i.key!=="Tab")return;let t=Array.from(c.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]')),a=t[0],d=t[t.length-1];if(!a||!d){i.preventDefault(),c.focus();return}i.shiftKey&&(document.activeElement===a||document.activeElement===c)?(i.preventDefault(),d.focus()):!i.shiftKey&&document.activeElement===d&&(i.preventDefault(),a.focus())}),A(()=>{c.isConnected&&(c.querySelector("input")||c.querySelector("button")||c).focus()},0),r},N=()=>{B++;for(let c of T)c();for(let c of x)c()},U=()=>{if(!v){v=!0,N();for(let c of k)c();k.clear()}},q={dispose:U,cancelPending:N,keep:O,listen:F,timeout:A,interval:H,modal:R,current:()=>{let c=S(p),I=B;return()=>!v&&B===I&&c()}};return s.bookmarkLifetimes[n]=q,$(p.session?.onUserChange("bookmarks-"+n,()=>{for(let c of x)c();document.querySelectorAll(".je-bm-player-modal-overlay, .je-bm-library-modal-overlay, .je-bookmark-marker").forEach(c=>c.remove()),document.querySelectorAll(".sections.bookmarks").forEach(c=>c.replaceChildren())})),F(window,"pagehide",c=>{c.target===window&&!c.persisted&&U()}),q}re({"features/bookmarks/lifetime":ee,"features/bookmarks/host":Z});function V(e,n){let p=e.querySelector(n);if(!p)throw new Error("Missing bookmark control: "+n);return p}function ae(e){let n=Number.isFinite(e)?Math.max(0,e):0,p=Math.floor(n/3600),s=Math.floor(n%3600/60),k=Math.floor(n%60);return p>0?`${p}:${String(s).padStart(2,"0")}:${String(k).padStart(2,"0")}`:`${s}:${String(k).padStart(2,"0")}`}function se(e,n,p){let s="🪼 Jellyfin Enhanced: Bookmarks:";function k(r="updated"){try{document.dispatchEvent(new CustomEvent("je-bookmarks-updated",{detail:{reason:r}}))}catch(i){console.warn(`${s} Failed to emit update event`,i)}}let x=new WeakMap;function v(r,i){let t=(x.get(r)||Promise.resolve()).then(i);return x.set(r,t.catch(()=>{})),t}let B=null;async function T(r){let i=e.userConfig,t=e.session?e.session.getEpoch():0;(!B||B.owner!==i||B.epoch!==t||B.itemId!==r)&&(B={owner:i,epoch:t,itemId:r,data:null,pending:null});let a=B;if(a.itemId===r&&a.data)return a.data;if(a.pending&&a.itemId===r)return a.pending;let d=(async()=>{try{let l=n().getCurrentUserId?.();if(!l)return null;let m=D(await n().ajax({type:"GET",url:n().getUrl(`/Users/${l}/Items`,{Ids:r,Fields:"ProviderIds,Type,Name,SeriesId,ParentIndexNumber,IndexNumber"}),dataType:"json"}));if(e.userConfig!==i||e.session&&!e.session.isCurrent(t))return null;let o=m[0];if(!o)return null;let b=o;if((o.Type==="Season"||o.Type==="Episode")&&o.SeriesId)try{let h=D(await n().ajax({type:"GET",url:n().getUrl(`/Users/${l}/Items`,{Ids:o.SeriesId,Fields:"ProviderIds,Type,Name"}),dataType:"json"}))[0];h&&(b={...o,ProviderIds:{...o.ProviderIds||{},Tmdb:h.ProviderIds?.Tmdb||o.ProviderIds?.Tmdb,Tvdb:o.ProviderIds?.Tvdb||h.ProviderIds?.Tvdb}})}catch(j){console.warn(`${s} Failed to fetch series info:`,j)}let f=b.ProviderIds?.Tmdb||null,w=b.ProviderIds?.Tvdb||null,C=o.Type==="Movie"?"movie":o.Type==="Series"||o.Type==="Episode"||o.Type==="Season"?"tv":(o.Type||"").toString().toLowerCase(),u=o.Type==="Episode"?o.ParentIndexNumber??null:null,g=o.Type==="Episode"?o.IndexNumber??null:null,y={itemId:o.Id,tmdbId:f,tvdbId:w,mediaType:C,name:o.Name||"Unknown",type:o.Type,seasonNumber:u,episodeNumber:g};return e.userConfig!==i||e.session&&!e.session.isCurrent(t)?null:(a.data=y,y)}catch(l){return console.warn(`${s} Error fetching item details:`,l),null}finally{a.pending=null}})();return a.itemId=r,a.pending=d,d}function $(){return`bm_${Date.now()}_${Math.random().toString(36).substr(2,9)}`}function O(r,i,t,a=null,d=null){let l=e.userConfig?.bookmark?.bookmarks||{},m=[],o=[],b=d!==null;for(let[C,u]of Object.entries(l))if(!(typeof u!="object"||u===null)){if(u.itemId===r){m.push({...u,id:C,exactMatch:!0});continue}if(!(b&&u.episodeNumber!=null&&!(u.episodeNumber===d&&(u.seasonNumber??null)===(a??null)))){if(i&&u.tmdbId===i){o.push({...u,id:C,exactMatch:!1});continue}t&&u.tvdbId===t&&o.push({...u,id:C,exactMatch:!1})}}let f=m.length>0?m:o,w=m.length===0&&o.length>0;return{bookmarks:f,hasIdMismatch:w,exactMatches:m,providerMatches:o}}async function F(r,i=""){if(!Number.isFinite(r)||r<0)throw new Error("Invalid bookmark timestamp");let t=e.userConfig,a=S(e),d=p();if(!d)return e.toast(e.t("toast_bookmark_no_item"),3e3),null;let l=await T(d.itemId);return a()?l?v(t,async()=>{if(!a())return null;let m=$(),o=new Date().toISOString(),b={itemId:l.itemId||"",tmdbId:l.tmdbId||"",tvdbId:l.tvdbId||"",mediaType:l.mediaType||"",name:l.name||"",timestamp:r,label:i||"",createdAt:o,updatedAt:o,syncedFrom:"",seasonNumber:l.seasonNumber??null,episodeNumber:l.episodeNumber??null};t.bookmark||(t.bookmark={bookmarks:{}}),t.bookmark.bookmarks||(t.bookmark.bookmarks={});let f=t.bookmark.bookmarks;f[m]=b;try{return await _(e,n,t,[E("create",m,b)]),console.log(`${s} Bookmark added:`,m,b),a()&&k("add"),{...b,id:m}}catch(w){throw console.error(`${s} Failed to save bookmark:`,w),delete f[m],w}}):(e.toast(e.t("toast_bookmark_fetch_failed"),3e3),null):null}async function A(r,i){if(i.timestamp!==void 0&&(!Number.isFinite(i.timestamp)||i.timestamp<0))return!1;let t=e.userConfig,a=S(e);return e.userConfig?.bookmark?.bookmarks?.[r]?v(t,async()=>{if(!a()||!t.bookmark?.bookmarks?.[r])return console.warn(`${s} Bookmark not found:`,r),!1;let d=t.bookmark.bookmarks,l=d[r];if(!l)return!1;let m={...l,...Object.fromEntries(Object.entries(i).filter(([,o])=>o!==void 0)),updatedAt:new Date().toISOString()};d[r]=m;try{return await _(e,n,t,[E("edit",r,i,l.itemId)]),console.log(`${s} Bookmark updated:`,r),a()&&k("update"),!0}catch(o){return d[r]===m&&(d[r]=l),console.error(`${s} Failed to update bookmark:`,o),!1}}):(console.warn(`${s} Bookmark not found:`,r),!1)}function H(r){return R(r)}async function R(r,i){let t=e.userConfig,a=S(e);return e.userConfig?.bookmark?.bookmarks?.[r]?v(t,async()=>{if(!a()||!t.bookmark?.bookmarks?.[r])return console.warn(`${s} Bookmark not found:`,r),null;let d=t.bookmark.bookmarks,l=d[r];if(!l)return!1;if(i!==void 0&&l.itemId!==i)return null;delete d[r];try{return await _(e,n,t,[E("delete",r,void 0,l.itemId)]),console.log(`${s} Bookmark deleted:`,r),a()&&k("delete"),!0}catch(m){return Object.prototype.hasOwnProperty.call(d,r)||(d[r]=l),console.error(`${s} Failed to delete bookmark:`,m),!1}}):(console.warn(`${s} Bookmark not found:`,r),null)}async function N(){let r=e.userConfig,i=S(e);return v(r,async()=>{if(!i())return!1;r.bookmark||(r.bookmark={bookmarks:{}});let t=r.bookmark.bookmarks,a={};r.bookmark.bookmarks=a;try{return await _(e,n,r,[E("delete-all")]),console.log(`${s} All bookmarks deleted`),!0}catch(d){throw r.bookmark.bookmarks===a&&(r.bookmark.bookmarks=t),console.error(`${s} Failed to delete all bookmarks:`,d),d}})}async function U(r,i,t=0,{replaceOriginals:a=!1}={}){let d=e.userConfig,l=S(e);if(!Number.isFinite(t))throw new Error("Invalid bookmark offset");let m=r.map(o=>({...o}));return v(d,async()=>{if(!l())throw new Error("Bookmark owner changed before sync");d.bookmark||(d.bookmark={bookmarks:{}});let o=d.bookmark.bookmarks,b=m.map(u=>{if(!u.id)throw new Error("Stored bookmark identity required for copying");let g=u.id?o[u.id]:void 0;if(!g||g.itemId!==u.itemId)throw new Error("Bookmark selection changed before sync");return{...g,id:u.id,exactMatch:u.exactMatch}});if(b.some(u=>!Number.isFinite(u.timestamp)||!Number.isFinite(u.timestamp+t)))throw new Error("Invalid bookmark offset");let f=[],w=[],C=new Date().toISOString();if(a){for(let{id:u}of b)if(u&&Object.prototype.hasOwnProperty.call(o,u)){let g=o[u];g&&w.push([u,g]),delete o[u]}}for(let u of b){let g=$(),y=Math.max(0,u.timestamp+t),{id:j,exactMatch:h,...P}=u,M={...P,itemId:i.itemId,tmdbId:i.tmdbId??null,tvdbId:i.tvdbId??null,mediaType:i.mediaType??"",name:i.name??"",timestamp:y,label:u.label||"",createdAt:u.createdAt||C,updatedAt:C,syncedFrom:u.itemId,seasonNumber:i.seasonNumber??null,episodeNumber:i.episodeNumber??null};o[g]=M,f.push({...M,id:g})}try{return await _(e,n,d,f.map((u,g)=>{let y=b[g];if(!y?.id)throw new Error("Stored bookmark identity required for copying");return{...E(a?"replace":"copy",u.id,{itemId:u.itemId,tmdbId:u.tmdbId,tvdbId:u.tvdbId,mediaType:u.mediaType,name:u.name,seasonNumber:u.seasonNumber,episodeNumber:u.episodeNumber},y.itemId),SourceId:y.id,Offset:t}})),console.log(`${s} Synced ${f.length} bookmarks to new item ID`),l()&&k("sync"),f}catch(u){throw console.error(`${s} Failed to sync bookmarks:`,u),f.forEach(g=>delete o[g.id]),w.forEach(([g,y])=>{o[g]=y}),u}})}async function q(r,i){if(!Number.isFinite(i))throw new Error("Invalid offset");let t=e.userConfig,a=S(e);return v(t,async()=>{if(!a())throw new Error("Bookmark owner changed before offset adjustment");let d=t.bookmark?.bookmarks;if(!d)return 0;if(r.some(m=>{let o=d[m.id];return o&&Number.isFinite(o.timestamp)&&!Number.isFinite(o.timestamp+i)}))throw new Error("Invalid bookmark offset");let l=[];for(let m of r){let o=d[m.id];if(!o||o.itemId!==m.itemId||!Number.isFinite(o.timestamp))continue;let b={...o,timestamp:Math.max(0,o.timestamp+i),syncedFrom:"",updatedAt:new Date().toISOString()};d[m.id]=b,l.push([m.id,o,b])}if(!l.length)return 0;try{return await _(e,n,t,l.map(([m,o])=>({...E("offset",m,void 0,o.itemId),Offset:i}))),a()&&k("offset"),l.length}catch(m){for(let[o,b,f]of l)d[o]===f&&(d[o]=b);throw m}})}async function c(){let r=e.userConfig,i=S(e),t=r?.bookmark?.bookmarks||{},a=Object.entries(t).filter(([,l])=>l?.mediaType==="tv"&&l.itemId&&l.episodeNumber==null);if(a.length===0)return;let d=[];for(let[l,m]of a){if(!i())return;try{let o=await T(m.itemId);if(!i())return;o?.episodeNumber!=null&&d.push([l,m.itemId,o])}catch{}}d.length!==0&&await v(r,async()=>{if(!i())return;let l=r.bookmark?.bookmarks;if(!l)return;let m=[];for(let[o,b,f]of d){let w=l[o];if(!w||w.itemId!==b||w.episodeNumber!=null)continue;let C={...w,seasonNumber:f.seasonNumber,episodeNumber:f.episodeNumber,...f.tvdbId?{tvdbId:f.tvdbId}:{}};l[o]=C,m.push([o,w,C])}if(m.length!==0)try{await _(e,n,r,m.map(([o,b,f])=>E("backfill",o,{seasonNumber:f.seasonNumber,episodeNumber:f.episodeNumber,...f.tvdbId?{tvdbId:f.tvdbId}:{}},b.itemId))),console.log(`${s} Backfilled episode metadata for ${m.length} bookmark(s)`)}catch(o){m.forEach(([b,f,w])=>{l[b]===w&&(l[b]=f)}),console.warn(`${s} Failed to save backfilled episode metadata:`,o)}})}async function I(){let r=S(e),i=e.userConfig?.bookmark?.bookmarks||{},t=new Set,a=[];for(let o of Object.values(i))o?.itemId&&t.add(o.itemId);let d=n().getCurrentUserId?.();if(!d)return{cleaned:0,errors:0};let l=0,m=0;for(let o of t)try{if(await(e.helpers?.getItemCached?e.helpers.getItemCached(o,{userId:d}):n().getItem(d,o)),!r())return{cleaned:0,errors:0}}catch(b){if(!r())return{cleaned:0,errors:0};if(!X(b)){m++;continue}for(let[f,w]of Object.entries(i))w?.itemId===o&&a.push({bookmarkId:f,itemId:o})}for(let{bookmarkId:o,itemId:b}of a){if(!r())return{cleaned:l,errors:m};try{let f=await R(o,b);f?l++:f===!1&&m++}catch{m++}}return console.log(`${s} Cleanup: ${l} orphaned bookmarks removed, ${m} errors`),{cleaned:l,errors:m}}return{addBookmark:F,updateBookmark:A,deleteBookmark:H,deleteAllBookmarks:N,syncBookmarks:U,backfillEpisodeMetadata:c,cleanupOrphanedBookmarks:I,findBookmarksForItem:O,fetchItemDetails:T,formatTimestamp:ae,adjustOffsets:q}}var{ctx:z,host:Ve,getApi:be}=Q();function pe(e){let n=J(z,"bookmarks"),p=n.timeout;if(!e.pluginConfig?.BookmarksEnabled){console.log("🪼 Jellyfin Enhanced: Bookmarks feature is disabled");return}let s="🪼 Jellyfin Enhanced: Bookmarks:";function k(){try{let t=document.querySelector(".videoOsdBottom .btnUserRating[data-id]")?.dataset?.id||null;return t?{itemId:t}:(console.debug(`${s} No item ID found`),null)}catch(i){return console.warn(`${s} Error getting item data:`,i),null}}let x=e.escapeHtml,{addBookmark:v,updateBookmark:B,deleteBookmark:T,deleteAllBookmarks:$,syncBookmarks:O,backfillEpisodeMetadata:F,cleanupOrphanedBookmarks:A,findBookmarksForItem:H,fetchItemDetails:R,formatTimestamp:N,adjustOffsets:U}=se(e,be,k);function q(i,t){let a=n.current();if(console.log(`${s} createBookmarkMarkers called - video:`,!!i,"bookmarks:",t.length),!i){console.log(`${s} Early return - no video or no bookmarks`);return}let d=document.querySelector(".videoOsdBottom");if(!d){console.log(`${s} No .videoOsdBottom found`);return}let l=d.querySelector('.osdPositionSlider, .sliderBubble, .mdl-slider, input[type="range"]');if(!l){console.log(`${s} No position slider found`);return}let m=l.closest(".osdPositionSliderContainer, .sliderContainer")||l.parentElement;if(!m){console.log(`${s} No slider container found`);return}window.getComputedStyle(m).position==="static"&&(m.style.position="relative");let b=m.querySelectorAll(".je-bookmark-marker");console.log(`${s} Removing ${b.length} existing markers`),b.forEach(w=>w.remove());let f=i.duration;if(!f||!isFinite(f)){console.log(`${s} Invalid duration:`,f);return}t.forEach(w=>{if(!Number.isFinite(w.timestamp)||w.timestamp<0)return;let C=w.timestamp/f*100,u=w.exactMatch?"#00d4ff":"#ffa500",g=document.createElement("div");g.className="je-bookmark-marker",g.style.cssText=`
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
      `;let y=document.createElement("span");y.className="material-icons",y.textContent="location_pin",y.style.cssText=`
        font-size: 24px;
        color: ${u};
        filter: drop-shadow(0 2px 4px rgba(0,0,0,0.8));
        pointer-events: none;
      `,g.appendChild(y);let j=w.label||e.t("bookmark_no_label"),h=w.exactMatch?"":` ${e.t("bookmark_file_changed")}`;g.title=`${j} - ${N(w.timestamp)}${h}`,g.addEventListener("click",P=>{!a()||!i.isConnected||(P.stopPropagation(),i.currentTime=w.timestamp,e.toast(`${e.t("toast_jumped_to_bookmark")}: ${N(w.timestamp)}`,2e3))}),m.appendChild(g)}),console.log(`${s} ✓ Created ${t.length} bookmark markers`)}async function c(){let i=n.current();console.log(`${s} updateBookmarkMarkersForCurrentVideo called`);let t=document.querySelector(".videoPlayerContainer video");if(!t){console.log(`${s} No video element found`);return}let a=k();if(!a){console.log(`${s} No item data (no btnUserRating?)`);return}console.log(`${s} Fetching details for item:`,a.itemId);let d=await R(a.itemId);if(!i()||k()?.itemId!==a.itemId)return;if(!d){console.log(`${s} Failed to fetch item details`);return}console.log(`${s} Item details:`,d);let{bookmarks:l}=H(d.itemId,d.tmdbId,d.tvdbId,d.seasonNumber,d.episodeNumber);console.log(`${s} Found ${l.length} bookmarks for this item`),document.querySelector(".videoPlayerContainer video")===t&&q(t,l)}async function I(i="add",t=null){let a=n.current(),d=document.querySelector(".videoPlayerContainer video"),l=d?.currentTime||0,m=k();if(!m){a()&&e.toast(e.t("toast_bookmark_no_item"),3e3);return}let o=await R(m.itemId);if(!a()||k()?.itemId!==m.itemId)return;if(!o){a()&&e.toast(e.t("toast_bookmark_fetch_failed"),3e3);return}let{bookmarks:b}=H(o.itemId,o.tmdbId,o.tvdbId,o.seasonNumber,o.episodeNumber),f=i==="edit"&&t,w=f?e.t("bookmark_edit_title"):i==="view"?"Your Bookmarks":e.t("bookmark_add_title"),C=f?t.timestamp:l,u=f?t.label:"",g=`
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
            <span>${w}</span>
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
              value="${N(C)}"
              readonly>
          </div>
          <div class="je-bookmark-input-group">
            <label for="bookmark-label">${e.t("bookmark_label_label")}</label>
            <input
              type="text"
              id="bookmark-label"
              class="je-bookmark-input"
              placeholder="${e.t("bookmark_label_placeholder")}"
              value="${x(u)}"
              maxlength="100">
          </div>
        </div>
        ${b.length>0?`
          <div class="je-bookmark-list">
            <div class="je-bookmark-list-header">
              <div class="je-bookmark-list-title">${e.t("bookmark_existing_title")}</div>
              <div class="je-bookmark-list-count">${b.length}</div>
            </div>
            ${b.map(h=>`
              <div class="je-bookmark-item">
                <div class="je-bookmark-item-marker"></div>
                <div class="je-bookmark-item-content">
                  <div class="je-bookmark-item-time">${N(h.timestamp)}</div>
                  ${h.label?`<div class="je-bookmark-item-label">${x(h.label)}</div>`:""}
                  ${h.exactMatch?"":`<div class="je-bookmark-item-warning">${e.t("bookmark_file_changed")}</div>`}
                </div>
                <div class="je-bookmark-item-actions">
                  <button class="je-bookmark-btn je-bookmark-btn-jump" data-bookmark-id="${x(h.id)}" title="${e.t("bookmark_jump")}">
                    <span class="material-icons">forward</span>
                  </button>
                  <button class="je-bookmark-btn je-bookmark-btn-delete" data-bookmark-id="${x(h.id)}" title="${e.t("bookmark_delete_confirm")}">
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
    `,y=document.createElement("div");y.className="je-bm-player-modal-overlay",y.innerHTML=`
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
    `,document.body.appendChild(y),y.addEventListener("keydown",h=>h.stopPropagation()),y.addEventListener("keyup",h=>h.stopPropagation()),y.addEventListener("keypress",h=>h.stopPropagation()),y.addEventListener("wheel",h=>h.stopPropagation());let j=n.modal(y);V(y,".je-bookmark-modal-close").addEventListener("click",j),V(y,".je-bookmark-btn-cancel").addEventListener("click",j),y.addEventListener("click",h=>{h.target===y&&j()}),p(()=>{let h=y.querySelector("#bookmark-label");h&&h.focus(),y.style.opacity="1"},10),V(y,".je-bookmark-btn-submit").addEventListener("click",async()=>{if(!a())return;let h=V(y,"#bookmark-label").value.trim();try{if(f&&t){if(!await B(t.id,{label:h})){a()&&e.toast(e.t("toast_bookmark_save_failed"),3e3);return}a()&&e.toast(e.t("toast_bookmark_updated"),2e3)}else{if(!await v(C,h))return;a()&&e.toast(e.t("toast_bookmark_updated"),2e3)}if(!a())return;c(),j()}catch{a()&&e.toast(e.t("toast_bookmark_save_failed"),3e3)}}),y.querySelectorAll(".je-bookmark-btn-jump").forEach(h=>{h.addEventListener("click",()=>{let P=h.dataset.bookmarkId;if(!P)return;let M=b.find(de=>de.id===P);M&&d&&(d.currentTime=M.timestamp,a()&&e.toast(`${e.t("toast_jumped_to_bookmark")}: ${N(M.timestamp)}`,2e3),j())})}),y.querySelectorAll(".je-bookmark-btn-delete").forEach(h=>{h.addEventListener("click",async()=>{if(!a())return;let P=h.dataset.bookmarkId;if(!P)return;h.disabled=!0;let M;try{M=await T(P)}finally{h.disabled=!1}if(!(!a()||M===null)){if(!M){a()&&e.toast(e.t("toast_bookmark_delete_failed"),3e3);return}a()&&e.toast(e.t("toast_bookmark_deleted"),2e3),c(),j(),p(()=>I(i,t),300)}})})}z.own.bookmarks={add:v,update:B,delete:T,deleteAll:$,findForItem:H,showModal:I,updateMarkers:c,formatTimestamp:N,syncBookmarks:O,cleanupOrphaned:A,backfillEpisodeMetadata:F,adjustOffsets:U};function r(){if(document.getElementById("jeBookmarkBtn"))return;let i=document.querySelector(".videoOsdBottom .buttons.focuscontainer-x");if(!i)return;let t=i.querySelector(".btnVideoOsdSettings");if(!t)return;let a=document.createElement("button");a.id="jeBookmarkBtn",a.setAttribute("is","paper-icon-button-light"),a.className="autoSize paper-icon-button-light",a.title=e.t("shortcut_BookmarkCurrentTime"),a.innerHTML='<span class="largePaperIconButton material-icons" aria-hidden="true">bookmark_add</span>',a.onclick=d=>{d.stopPropagation(),I("add")},t.parentElement?.insertBefore(a,t),console.log(`${s} ✓ Added OSD bookmark button`)}z.own.initializeBookmarks=(function(){let i=!1,t=[];return function(){if(i){console.log(`${s} Already initialized, skipping...`);return}i=!0,console.log(`${s} Initializing enhanced bookmarks...`),F().catch(g=>console.warn(`${s} Backfill failed:`,g));let a=null,d="je-bookmarks-osd",l="je-bookmarks-video-changes";function m(){let g=document.querySelector(".videoPlayerContainer video");return g?.currentSrc||g?.src||window.location.href}function o(g,y){let j,h=()=>{j!==void 0&&window.clearTimeout(j),j=void 0};return t.push(h),(...P)=>{h();let M=n.current();j=window.setTimeout(()=>{j=void 0,i&&M()&&g(...P)},y)}}let b=o(()=>{if(!e.isVideoPage())return;let g=document.querySelector(".videoOsdBottom"),y=document.querySelector(".videoPlayerContainer video"),j=m();g&&y&&j!==a&&(c(),r(),a=j,console.log(`${s} Injected markers/button for ${j}`))},200);function f(){if(!e.isVideoPage()){e.helpers.disconnectObserver(d);return}e.helpers.createObserver(d,b,document.body,{childList:!0,subtree:!0})}let w=o(g=>{g.target instanceof HTMLVideoElement&&e.isVideoPage()&&b()},300),C=o(g=>{g.target instanceof HTMLVideoElement&&e.isVideoPage()&&b()},300),u=()=>{e.isVideoPage()?(a=null,f(),b()):(a=null,e.helpers.disconnectObserver(d),e.helpers.disconnectObserver(l))};document.addEventListener("playing",w,!0),t.push(()=>document.removeEventListener("playing",w,!0)),document.addEventListener("loadedmetadata",C,!0),t.push(()=>document.removeEventListener("loadedmetadata",C,!0)),document.addEventListener("viewshow",u),t.push(()=>document.removeEventListener("viewshow",u)),e.isVideoPage()&&(f(),b()),z.own.cleanupBookmarks=function(){n.cancelPending(),t.forEach(g=>g()),document.querySelectorAll(".je-bookmark-marker, #jeBookmarkBtn, .je-bm-player-modal-overlay").forEach(g=>g.remove()),t=[],e.helpers.disconnectObserver(d),e.helpers.disconnectObserver(l),i=!1,console.log(`${s} Cleaned up`)},n.keep(z.own.cleanupBookmarks),console.log(`${s} ✓ Initialized`)}})()}pe(z.core);})();
})();
