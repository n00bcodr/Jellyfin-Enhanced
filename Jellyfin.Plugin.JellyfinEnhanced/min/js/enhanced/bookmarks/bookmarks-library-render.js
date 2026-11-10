(() => {
"use strict";(()=>{function C(t){let a=window.JellyfinEnhanced?.core?.sharedModules?.[t];if(!a)throw new Error(`${t} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return a}function L(t,a){return t[a]}var D=C("features/bookmarks/host");var E=L(D,"bookmarksHost");function $(t){return Object.fromEntries(Object.entries(t??{}).filter(a=>{let s=a[1];return typeof s=="object"&&s!==null&&"itemId"in s&&typeof s.itemId=="string"&&["name","mediaType","label","tmdbId","tvdbId","syncedFrom"].every(l=>!Object.prototype.hasOwnProperty.call(s,l)||Reflect.get(s,l)==null||typeof Reflect.get(s,l)=="string")&&"timestamp"in s&&typeof s.timestamp=="number"&&Number.isFinite(s.timestamp)&&s.timestamp>=0}))}function I(t){let a=Number.isFinite(t)?Math.max(0,t):0,s=Math.floor(a/3600),l=Math.floor(a%3600/60),p=Math.floor(a%60);return s>0?`${s}:${String(l).padStart(2,"0")}:${String(p).padStart(2,"0")}`:`${l}:${String(p).padStart(2,"0")}`}function P(t){if(typeof t!="string"&&typeof t!="number")return null;let a=String(t).trim();if(!/^\d+(?:\.\d+)?(?::\d+(?:\.\d+)?){0,2}$/.test(a))return null;let l=a.split(":").map(Number).reduce((p,h)=>p*60+h,0);return Number.isFinite(l)?l:null}var N=C("features/bookmarks/lifetime"),F=L(N,"createLifetime");var{ctx:f,host:J,getApi:ee}=E();function V(t){let a=F(f,"library-render"),s=f.own.bookmarksLibrary=f.own.bookmarksLibrary||{};if(!t?.pluginConfig?.BookmarksEnabled)return;let l=(...e)=>{let r=s.renderBookmarkItems;if(!r)throw new Error("Missing bookmark module: renderBookmarkItems");return r(...e)},p=(...e)=>{let r=s.showDuplicatesSyncModal;if(!r)throw new Error("Missing bookmark module: showDuplicatesSyncModal");return r(...e)},h="🪼 Jellyfin Enhanced: Bookmarks Library:",v=!1,d=null;a.keep(t.session?.onUserChange("bookmarks-library-render-state",()=>{d=null}));function O(){d=null,g()}a.listen(document,"je:user-data-loaded",O),a.listen(document,"je-bookmarks-updated",O);function g(){if(v)return;let e=_();if(!e){d=null;return}if(e!==d||!e.hasChildNodes()||d&&!document.contains(d)){q(e),v=!0,d=e;let c=!1;w(e).then(()=>{c=!0}).catch(y=>{console.error(`${h} Failed to render bookmarks:`,y)}).finally(()=>{v=!1,(d!==e||_()!==e||c&&!e.hasChildNodes())&&g()})}}function _(){let e=document.querySelectorAll(".sections.bookmarks");for(let r=e.length-1;r>=0;r--){let c=e[r];if(c&&t.helpers.isActiveTabContainer(c))return c}return null}function R(){a.keep(t.core.navigation.onViewPage((e,r,c,y,m)=>{m&&(v||g())}))}function q(e){e.classList.remove("hide"),e.style.removeProperty("display"),e.style.removeProperty("visibility")}async function w(e){let r=a.current();console.log(`${h} Rendering bookmarks library...`);let c=$(t.userConfig?.bookmark?.bookmarks),y=Object.entries(c),m=Object.create(null),b={tv:{items:0,bookmarks:0},movie:{items:0,bookmarks:0},other:{items:0,bookmarks:0}};for(let[o,n]of y){let i=n.itemId||n.tmdbId||n.tvdbId||"unknown",k=T(n.mediaType);m[i]||(m[i]={details:n,bookmarks:[],type:k},b[k]&&(b[k].items+=1)),m[i]?.bookmarks.push({...n,id:o}),b[k].bookmarks+=1}Object.values(m).forEach(o=>{o.bookmarks.sort((n,i)=>n.timestamp-i.timestamp)});let B=y.length,A=["movie","tv","other"],u=T(e.dataset.currentTab||"movie");if(!b[u]||b[u].items===0){let o=A.find(n=>b[n].items>0);o&&(u=o)}e.dataset.currentTab=u,e.innerHTML=`
      <div class="je-bookmarks-wrapper">
        <input type="search" class="je-bookmark-search je-input" aria-label="Search bookmarks" placeholder="Search bookmarks">
        <div class="je-bookmark-tabs">
          <button class="je-tab ${u==="movie"?"active":""}" data-tab="movie">
            ${t.t("bookmarks_library_tab_movies")}
          </button>
          <button class="je-tab ${u==="tv"?"active":""}" data-tab="tv">
            ${t.t("bookmarks_library_tab_series")}
          </button>
          <button class="je-tab ${u==="other"?"active":""}" data-tab="other">
            ${t.t("bookmarks_library_tab_others")}
          </button>
        </div>

        <div class="bookmarks-container">
          ${B===0?`
            <div class="je-bookmarks-empty">
              <div class="je-bookmarks-empty-icon material-icons" aria-hidden="true">bookmark_border</div>
              <div class="je-bookmarks-empty-title">${t.t("bookmarks_library_empty_title")}</div>
              <div class="je-bookmarks-empty-hint">${t.t("bookmarks_library_empty_hint")}</div>
            </div>
          `:`
            <div class="je-bookmarks-grid" id="bookmarks-items-container"></div>
            <div class="je-bookmark-actions-footer">
              <button class="btnFindDuplicates je-btn-footer">
                <span class="material-icons" aria-hidden="true">merge</span>
                <span>${t.t("bookmarks_library_button_find_duplicates")}</span>
              </button>
              <button class="btnCleanupBookmarks je-btn-footer">
                <span class="material-icons" aria-hidden="true">cleaning_services</span>
                <span>${t.t("bookmarks_library_button_cleanup")}</span>
              </button>
              <button class="btnDeleteAllBookmarks je-btn-footer je-btn-footer-delete">
                <span class="material-icons" aria-hidden="true">delete</span>
                <span>${t.t("bookmarks_library_button_delete_all")}</span>
              </button>
            </div>
          `}
        </div>
      </div>
    `;let H=e.querySelector(".je-bookmark-search"),S=()=>{let o=H?.value.trim().toLocaleLowerCase()||"";e.querySelectorAll(".je-bookmark-item").forEach(n=>{n.hidden=!(n.textContent||"").toLocaleLowerCase().includes(o)})};H?.addEventListener("input",S);let x=e.querySelector(".btnFindDuplicates"),j=e.querySelector(".btnCleanupBookmarks"),M=e.querySelector(".btnDeleteAllBookmarks");if(x?.addEventListener("click",async()=>{if(!r())return;x.disabled=!0;let o=x.querySelector("span:last-child");if(!o)return;let n=o.innerHTML;o.innerHTML='<span class="material-icons" style="animation: spin 1s linear infinite;">refresh</span>',p(c),x.disabled=!1,o.innerHTML=n}),j?.addEventListener("click",async()=>{if(!r())return;j.disabled=!0;let o=j.querySelector("span:last-child"),n=o?.innerHTML;o&&(o.innerHTML='<span class="material-icons" style="animation: spin 1s linear infinite;">refresh</span>');try{let i=await f.own.bookmarks.cleanupOrphaned();if(!r())return;r()&&t.toast(t.t("bookmark_cleanup_complete").replace("{count}",String(i.cleaned)),4e3),w(e)}catch(i){console.error("Cleanup failed:",i),r()&&t.toast(t.t("bookmark_cleanup_failed"),3e3)}finally{j.disabled=!1,o&&n&&(o.innerHTML=n)}}),M?.addEventListener("click",async()=>{if(!r()||!confirm(t.t("bookmark_delete_all_confirm")))return;M.disabled=!0;let o=M.querySelector("span:last-child"),n=o?.innerHTML;o&&(o.innerHTML='<span class="material-icons" style="animation: spin 1s linear infinite;">refresh</span>');try{if(!await f.own.bookmarks.deleteAll()||!r())return;r()&&t.toast(t.t("bookmark_deleted_all"),3e3),w(e)}catch(i){console.error("Delete failed:",i),r()&&t.toast(t.t("bookmark_delete_failed"),3e3)}finally{M.disabled=!1,o&&n&&(o.innerHTML=n)}}),B>0){let o=e.querySelector("#bookmarks-items-container");if(o){if(await l(o,m,u),!r())return;S(),e.querySelectorAll(".je-tab").forEach(n=>{n.addEventListener("click",async()=>{if(!r())return;let i=T(n.dataset.tab);e.dataset.currentTab=i,e.querySelectorAll(".je-tab").forEach(k=>{k.classList.toggle("active",k.dataset.tab===i)}),await l(o,m,i),r()&&S()})})}}}function T(e){let r=(e||"").toLowerCase();return r==="series"||r==="episode"||r==="tvshow"||r==="tv"?"tv":r==="movie"||r==="film"?"movie":"other"}Object.assign(s,{renderIfSectionExists:g,hookViewEvents:R,renderBookmarksLibrary:w,formatTimestamp:I,parseTimestampInput:P})}V(f.core);})();
})();
