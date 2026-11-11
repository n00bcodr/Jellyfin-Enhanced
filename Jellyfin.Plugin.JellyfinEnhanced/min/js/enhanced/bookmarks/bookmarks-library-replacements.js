(() => {
"use strict";(()=>{function C(n){let s=window.JellyfinEnhanced?.core?.sharedModules?.[n];if(!s)throw new Error(`${n} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return s}function g(n,s){return n[s]}var O=C("features/bookmarks/host");var L=g(O,"bookmarksHost");var S=g(O,"readItem"),P=g(O,"readItems");function d(n,s){let h=n.querySelector(s);if(!h)throw new Error("Missing bookmark control: "+s);return h}var D=C("features/bookmarks/lifetime"),$=g(D,"createLifetime");var{ctx:v,host:X,getApi:B}=L();function z(n){let s=$(v,"library-replacements");s.listen(document,"viewshow",s.cancelPending,!0);let h=s.timeout,E=v.own.bookmarksLibrary=v.own.bookmarksLibrary||{};if(!n?.pluginConfig?.BookmarksEnabled)return;let H=(...e)=>{let a=E.renderBookmarksLibrary;if(!a)throw new Error("Missing bookmark module: renderBookmarksLibrary");return a(...e)},k=n.escapeHtml;async function R(e,a,c,i=null,r=null){let m=s.current(),u=B();if(!u)return null;let x=u.getCurrentUserId();try{let t=c==="tv"&&i!=null&&r!=null,l=t?"Episode":c==="tv"?"Series,Episode":c==="movie"?"Movie":null,o=t?`&ParentIndexNumber=${i}&IndexNumber=${r}`:"",b=[],w=new Set;for(let f=0;;f+=500){let j=`Items?userId=${encodeURIComponent(x||"")}&Recursive=true${l?`&IncludeItemTypes=${l}`:""}${o}&Fields=ProviderIds&SortBy=DateCreated&SortOrder=Descending&Limit=500&StartIndex=${f}`,M=await n.core.api.fetch(u.getUrl(j));if(!m())return null;let p=P(M),T=p.filter(I=>!w.has(I.Id));for(let I of T)w.add(I.Id),b.push(I);if(p.length<500||T.length===0)break}let y=b.filter(f=>{let j=f.ProviderIds||{},M=f.UserData||{},p=!1;return e&&(j.Tmdb===String(e)&&(p=!0),M.Key===String(e)&&(p=!0)),!p&&a&&j.Tvdb===String(a)&&(p=!0),p?r!=null?f.Type==="Episode"&&f.ParentIndexNumber===i&&f.IndexNumber===r:!0:!1});return console.log(`🪼 Jellyfin Enhanced: Bookmarks Library: Found ${y.length} matches for ${e?"TMDB:"+e:"TVDB:"+a}`,y),y.length>0?y:null}catch(t){return console.error("Failed to search for replacement:",t),null}}async function F(e,a){let c=s.current();a.disabled=!0;let i=await R(e.details.tmdbId,e.details.tvdbId,e.details.mediaType,e.details.seasonNumber??null,e.details.episodeNumber??null);if(c()){if(!i||i.length===0){c()&&n.toast(n.t("bookmark_no_replacement"),3e3),a.disabled=!1;return}N(e,i),a.disabled=!1}}function N(e,a){let c=s.current(),i=B();if(!i)return;let r=document.createElement("div"),m=()=>c()&&r.isConnected;r.className="je-bm-library-modal-overlay",r.style.cssText="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.9); z-index: 10000; display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.2s;",r.innerHTML=`
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
            <div class="je-modal-item-name">${k(e.details.name)}</div>
            <div class="je-modal-item-meta">TMDB: ${k(e.details.tmdbId||"N/A")} • Item ID: ${k(e.details.itemId.substring(0,16))}...</div>
          </div>

          <div class="je-replacement-section-title">Select Replacement:</div>
          <div class="je-replacement-options">
            ${a.map((t,l)=>{let o=i.getImageUrl(t.Id,{type:"Primary",maxWidth:120,tag:t.ImageTags?.Primary});return`
                <div class="replacement-option" data-item-index="${l}" style="display: flex; gap: 12px; background: rgba(76,175,80,0.05); border: 2px solid rgba(76,175,80,0.2); border-radius: 8px; padding: 12px; cursor: pointer; transition: all 0.2s; align-items: center;">
                  ${o?`<img src="${k(o)}" style="width: 60px; height: 90px; object-fit: cover; border-radius: 6px; flex-shrink: 0;">`:'<div style="width: 60px; height: 90px; background: rgba(255,255,255,0.05); border-radius: 6px; flex-shrink: 0;"></div>'}
                  <div style="flex: 1;">
                    <div style="font-weight: 600; margin-bottom: 4px; color: #fff; font-size: 15px;">${k(t.Name)}</div>
                    <div style="font-size: 12px; color: #aaa; margin-bottom: 4px;">${t.ProductionYear||""}</div>
                    <div style="font-size: 11px; color: #888;">Item ID: ${k(t.Id.substring(0,16))}...</div>
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
    `,document.body.appendChild(r);let u=null,x=s.modal(r);d(r,".je-bm-library-modal-close").addEventListener("click",x),d(r,".je-bookmark-btn-cancel").addEventListener("click",x),r.addEventListener("click",t=>{t.target===r&&x()}),r.querySelectorAll(".replacement-option").forEach(t=>{t.addEventListener("click",()=>{if(!m())return;let l=Number(t.dataset.itemIndex);u=a[l]??null,r.querySelectorAll(".replacement-option").forEach(b=>{b.style.borderColor="rgba(76,175,80,0.2)",b.style.background="rgba(76,175,80,0.05)",d(b,".material-icons").style.display="none"}),t.style.borderColor="#4caf50",t.style.background="rgba(76,175,80,0.15)",d(t,".material-icons").style.display="block";let o=d(r,".je-bookmark-btn-submit");o.disabled=!1,o.style.opacity="1"})}),d(r,".je-bookmark-btn-submit").addEventListener("click",async()=>{if(!m()||!u)return;let t=d(r,".je-bookmark-btn-submit");t.disabled=!0,d(t,"span:last-child").textContent="Migrating...";try{let l=i.getCurrentUserId(),o=S(n.helpers?.getItemCached?await n.helpers.getItemCached(u.Id,{userId:l}):await i.getItem(l,u.Id));if(!m())return;let b={itemId:o.Id,tmdbId:o.ProviderIds?.Tmdb||e.details.tmdbId,tvdbId:o.ProviderIds?.Tvdb||e.details.tvdbId,mediaType:e.details.mediaType,name:o.Name,seasonNumber:o.Type==="Episode"?o.ParentIndexNumber??null:null,episodeNumber:o.Type==="Episode"?o.IndexNumber??null:null},w=await v.own.bookmarks.syncBookmarks(e.bookmarks,b,0,{replaceOriginals:!0});if(!m())return;m()&&n.toast(n.t("bookmark_migrated").replace("{count}",String(w.length)).replace("{name}",()=>k(o.Name||"")),4e3),x();let y=document.querySelector(".sections.bookmarks");y&&h(()=>H(y),500)}catch(l){console.error("Migration failed:",l),m()&&n.toast(n.t("bookmark_migration_failed"),3e3),t.disabled=!1,d(t,"span:last-child").textContent=n.t("bookmark_migrate")}}),h(()=>r.style.opacity="1",10)}Object.assign(E,{findAndOfferReplacement:F})}z(v.core);})();
})();
