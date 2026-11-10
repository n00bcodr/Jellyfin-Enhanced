(() => {
"use strict";(()=>{function j(r){let s=window.JellyfinEnhanced?.core?.sharedModules?.[r];if(!s)throw new Error(`${r} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return s}function g(r,s){return r[s]}var C=j("features/bookmarks/host");var T=g(C,"bookmarksHost");var E=g(C,"readItem"),L=g(C,"readItems");function m(r,s){let h=r.querySelector(s);if(!h)throw new Error("Missing bookmark control: "+s);return h}var F=j("features/bookmarks/lifetime"),S=g(F,"createLifetime");var{ctx:v,host:Y,getApi:P}=T();function N(r){let s=S(v,"library-replacements");s.listen(document,"viewshow",s.cancelPending,!0);let h=s.timeout,M=v.own.bookmarksLibrary=v.own.bookmarksLibrary||{};if(!r?.pluginConfig?.BookmarksEnabled)return;let B=(...e)=>{let a=M.renderBookmarksLibrary;if(!a)throw new Error("Missing bookmark module: renderBookmarksLibrary");return a(...e)},p=r.escapeHtml;async function H(e,a,k,l=null,n=null){let u=s.current(),b=P();if(!b)return null;let x=b.getCurrentUserId();try{let t=k==="tv"?"Series,Episode":k==="movie"?"Movie":null,i=[],o=new Set;for(let c=0;;c+=500){let y=`Users/${encodeURIComponent(x||"")}/Items?Recursive=true${t?`&IncludeItemTypes=${t}`:""}&Fields=ProviderIds&SortBy=DateCreated&SortOrder=Descending&Limit=500&StartIndex=${c}`,I=await r.core.api.fetch(b.getUrl(y));if(!u())return null;let f=L(I),O=f.filter(w=>!o.has(w.Id));for(let w of O)o.add(w.Id),i.push(w);if(f.length<500||O.length===0)break}let d=i.filter(c=>{let y=c.ProviderIds||{},I=c.UserData||{},f=!1;return e&&(y.Tmdb===String(e)&&(f=!0),I.Key===String(e)&&(f=!0)),!f&&a&&y.Tvdb===String(a)&&(f=!0),f?n!=null?c.Type==="Episode"&&c.ParentIndexNumber===l&&c.IndexNumber===n:!0:!1});return console.log(`🪼 Jellyfin Enhanced: Bookmarks Library: Found ${d.length} matches for ${e?"TMDB:"+e:"TVDB:"+a}`,d),d.length>0?d:null}catch(t){return console.error("Failed to search for replacement:",t),null}}async function $(e,a){let k=s.current();a.disabled=!0;let l=await H(e.details.tmdbId,e.details.tvdbId,e.details.mediaType,e.details.seasonNumber??null,e.details.episodeNumber??null);if(k()){if(!l||l.length===0){k()&&r.toast(r.t("bookmark_no_replacement"),3e3),a.disabled=!1;return}R(e,l),a.disabled=!1}}function R(e,a){let k=s.current(),l=P();if(!l)return;let n=document.createElement("div"),u=()=>k()&&n.isConnected;n.className="je-bm-library-modal-overlay",n.style.cssText="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.9); z-index: 10000; display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.2s;",n.innerHTML=`
      <div class="je-bm-library-modal-container je-replacement-modal-container">
        <button class="je-bm-library-modal-close">×</button>
        <div class="je-bm-library-modal-content" style="padding: 28px;">
          <div class="je-bookmarks-modal-header">
            <span class="material-icons" aria-hidden="true" style="font-size: 48px; color: #4caf50; flex-shrink: 0;">find_replace</span>
            <div style="flex: 1;">
              <h2 class="je-modal-title">Replacement Found</h2>
              <p class="je-modal-subtitle">Migrate ${e.bookmarks.length} bookmark(s) from the old item to a new version</p>
            </div>
          </div>

          <div class="je-modal-warning-box">
            <div class="je-modal-warning-label">Old Item (Missing)</div>
            <div class="je-modal-item-name">${p(e.details.name)}</div>
            <div class="je-modal-item-meta">TMDB: ${p(e.details.tmdbId||"N/A")} • Item ID: ${p(e.details.itemId.substring(0,16))}...</div>
          </div>

          <div class="je-replacement-section-title">Select Replacement:</div>
          <div class="je-replacement-options">
            ${a.map((t,i)=>{let o=l.getImageUrl(t.Id,{type:"Primary",maxWidth:120,tag:t.ImageTags?.Primary});return`
                <div class="replacement-option" data-item-index="${i}" style="display: flex; gap: 12px; background: rgba(76,175,80,0.05); border: 2px solid rgba(76,175,80,0.2); border-radius: 8px; padding: 12px; cursor: pointer; transition: all 0.2s; align-items: center;">
                  ${o?`<img src="${p(o)}" style="width: 60px; height: 90px; object-fit: cover; border-radius: 6px; flex-shrink: 0;">`:'<div style="width: 60px; height: 90px; background: rgba(255,255,255,0.05); border-radius: 6px; flex-shrink: 0;"></div>'}
                  <div style="flex: 1;">
                    <div style="font-weight: 600; margin-bottom: 4px; color: #fff; font-size: 15px;">${p(t.Name)}</div>
                    <div style="font-size: 12px; color: #aaa; margin-bottom: 4px;">${t.ProductionYear||""}</div>
                    <div style="font-size: 11px; color: #888;">Item ID: ${p(t.Id.substring(0,16))}...</div>
                  </div>
                  <span class="material-icons" aria-hidden="true" style="color: #4caf50; font-size: 28px; display: none; flex-shrink: 0;">check_circle</span>
                </div>
              `}).join("")}
          </div>
        </div>
        <div class="je-modal-actions-padded">
          <button class="je-modal-btn-cancel-alt je-bookmark-btn-cancel">
            <span class="material-icons" aria-hidden="true" style="font-size: 18px;">close</span>
            <span>Cancel</span>
          </button>
          <button class="je-modal-btn-submit je-bookmark-btn-submit" disabled>
            <span class="material-icons" aria-hidden="true" style="font-size: 18px;">swap_horiz</span>
            <span>Migrate Bookmarks</span>
          </button>
        </div>
      </div>
    `,document.body.appendChild(n);let b=null,x=s.modal(n);m(n,".je-bm-library-modal-close").addEventListener("click",x),m(n,".je-bookmark-btn-cancel").addEventListener("click",x),n.addEventListener("click",t=>{t.target===n&&x()}),n.querySelectorAll(".replacement-option").forEach(t=>{t.addEventListener("click",()=>{if(!u())return;let i=Number(t.dataset.itemIndex);b=a[i]??null,n.querySelectorAll(".replacement-option").forEach(d=>{d.style.borderColor="rgba(76,175,80,0.2)",d.style.background="rgba(76,175,80,0.05)",m(d,".material-icons").style.display="none"}),t.style.borderColor="#4caf50",t.style.background="rgba(76,175,80,0.15)",m(t,".material-icons").style.display="block";let o=m(n,".je-bookmark-btn-submit");o.disabled=!1,o.style.opacity="1"})}),m(n,".je-bookmark-btn-submit").addEventListener("click",async()=>{if(!u()||!b)return;let t=m(n,".je-bookmark-btn-submit");t.disabled=!0,m(t,"span:last-child").textContent="Migrating...";try{let i=l.getCurrentUserId(),o=E(r.helpers?.getItemCached?await r.helpers.getItemCached(b.Id,{userId:i}):await l.getItem(i,b.Id));if(!u())return;let d={itemId:o.Id,tmdbId:o.ProviderIds?.Tmdb||e.details.tmdbId,tvdbId:o.ProviderIds?.Tvdb||e.details.tvdbId,mediaType:e.details.mediaType,name:o.Name,seasonNumber:o.Type==="Episode"?o.ParentIndexNumber??null:null,episodeNumber:o.Type==="Episode"?o.IndexNumber??null:null},c=await v.own.bookmarks.syncBookmarks(e.bookmarks,d,0,{replaceOriginals:!0});if(!u())return;u()&&r.toast(r.t("bookmark_migrated").replace("{count}",String(c.length)).replace("{name}",()=>p(o.Name||"")),4e3),x();let y=document.querySelector(".sections.bookmarks");y&&h(()=>B(y),500)}catch(i){console.error("Migration failed:",i),u()&&r.toast(r.t("bookmark_migration_failed"),3e3),t.disabled=!1,m(t,"span:last-child").textContent=r.t("bookmark_migrate")}}),h(()=>n.style.opacity="1",10)}Object.assign(M,{findAndOfferReplacement:$})}N(v.core);})();
})();
