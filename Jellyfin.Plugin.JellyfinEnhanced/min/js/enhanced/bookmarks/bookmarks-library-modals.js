(() => {
"use strict";(()=>{function v(e){let d=window.JellyfinEnhanced?.core?.sharedModules?.[e];if(!d)throw new Error(`${e} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return d}function h(e,d){return e[d]}var S=v("features/bookmarks/host");var C=h(S,"bookmarksHost");function m(e,d){let b=e.querySelector(d);if(!b)throw new Error("Missing bookmark control: "+d);return b}var B=v("features/bookmarks/lifetime"),L=h(B,"createLifetime");var{ctx:k,host:A,getApi:K}=C();function H(e){let d=L(k,"library-modals"),b=d.timeout,j=k.own.bookmarksLibrary=k.own.bookmarksLibrary||{};if(!e?.pluginConfig?.BookmarksEnabled)return;let w=(...f)=>{let n=j.formatTimestamp;if(!n)throw new Error("Missing bookmark module: formatTimestamp");return n(...f)},_=(...f)=>{let n=j.renderBookmarksLibrary;if(!n)throw new Error("Missing bookmark module: renderBookmarksLibrary");return n(...f)},y=e.escapeHtml;function O(f){let n=d.current(),c=f.bookmarks.filter(t=>t.syncedFrom);if(c.length===0){n()&&e.toast(e.t("bookmark_no_synced"),2e3);return}let o=document.createElement("div");o.className="je-bm-library-modal-overlay",o.innerHTML=`
      <div class="je-bm-library-modal-container" style="max-width: 550px;">
        <button class="je-bm-library-modal-close">×</button>
        <div class="je-bm-library-modal-content">
          <div class="je-bookmarks-modal-header">
            <span class="material-icons" aria-hidden="true" style="font-size: 48px; color: #2196f3; flex-shrink: 0;">schedule</span>
            <div style="flex: 1;">
              <h2 class="je-modal-title">${e.t("bookmark_adjust_offset")}</h2>
              <p class="je-modal-subtitle">${e.t("bookmark_synced_count").replace("{count}",String(c.length))} ${e.t("bookmark_for_item").replace("{name}",y(f.details.name))}</p>
            </div>
          </div>

          <div class="je-modal-info-box">
            <div class="je-modal-info-title"><span class="material-icons" style="font-size: 14px; vertical-align: middle;">info</span> ${e.t("bookmark_synced_info_title")}</div>
            <div class="je-modal-info-text">${e.t("bookmark_synced_info_body")}</div>
          </div>

          <div style="margin-bottom: 24px;">
            <label for="offset-adjustment-input" class="je-modal-label"><span class="material-icons" style="font-size: 14px; vertical-align: middle;">schedule</span> ${e.t("bookmark_offset_label")}</label>
            <input type="number" id="offset-adjustment-input" value="0" step="0.1" placeholder="0" class="je-modal-input">
            <div class="je-modal-help-text">${e.t("bookmark_offset_help")}</div>
          </div>

          <div class="je-modal-list-container">
            <div class="je-modal-list-title">${e.t("bookmark_offset_affected")}</div>
            ${c.map(t=>`
              <div class="je-modal-list-item">
                <div class="je-modal-list-item-title">${y(t.label||e.t("bookmark_unlabeled"))}</div>
                <div class="je-modal-list-item-meta">${w(t.timestamp)} • ${e.t("bookmark_from").replace("{source}",y(t.syncedFrom||""))}</div>
              </div>
            `).join("")}
          </div>
        </div>

        <div class="je-bookmark-modal-actions">
          <button class="je-bookmark-btn-cancel">
            <span class="material-icons" aria-hidden="true" style="font-size: 18px;">close</span>
            <span>Cancel</span>
          </button>
          <button class="btnApplyOffset je-modal-btn-primary">
            <span class="material-icons" aria-hidden="true" style="font-size: 18px;">check</span>
            <span>${e.t("bookmark_apply_offset")}</span>
          </button>
        </div>
      </div>
    `,document.body.appendChild(o);let r=d.modal(o);m(o,".je-bm-library-modal-close").addEventListener("click",r),m(o,".je-bookmark-btn-cancel").addEventListener("click",r),o.addEventListener("click",t=>{t.target===o&&r()}),m(o,".btnApplyOffset").addEventListener("click",async()=>{if(!n())return;let t=parseFloat(m(o,"#offset-adjustment-input").value)||0,l=m(o,".btnApplyOffset");l.disabled=!0,m(l,"span:last-child").innerHTML='<span class="material-icons" style="animation: spin 1s linear infinite; font-size: 18px;">refresh</span>';try{let a=await k.own.bookmarks.adjustOffsets(c,t);if(!n())return;if(a>0){let i=t===0?e.t("bookmark_offset_cleared").replace("{count}",String(a)):e.t("bookmark_offset_applied").replace("{count}",String(a)).replace("{offset}",`${t>0?"+":""}${t}s`);n()&&e.toast(i,3e3),r();let s=document.querySelector(".sections.bookmarks");s&&b(()=>_(s),300)}else n()&&e.toast(e.t("bookmark_update_failed"),3e3),l.disabled=!1,m(l,"span:last-child").textContent=e.t("bookmark_apply_offset")}catch(a){console.error("Failed to apply offset:",a),n()&&e.toast(e.t("bookmark_offset_failed"),3e3),l.disabled=!1,m(l,"span:last-child").textContent=e.t("bookmark_apply_offset")}}),b(()=>o.style.opacity="1",10)}function $(f){let n=Object.create(null),c=[];for(let[o,r]of Object.entries(f)){let t=r.episodeNumber!=null?`:s${r.seasonNumber??"x"}e${r.episodeNumber}`:"",l=r.tmdbId?`tmdb:${r.tmdbId}${t}`:null,a=r.tvdbId?`tvdb:${r.tvdbId}${t}`:null;for(let i of[l,a].filter(s=>s!==null)){n[i]||(n[i]={});let s=n[i];if(!s)continue;(s[r.itemId]??(s[r.itemId]=[])).push({...r,id:o})}}for(let[o,r]of Object.entries(n))Object.keys(r).length>1&&c.push({providerKey:o,itemGroups:r,totalBookmarks:Object.values(r).flat().length,name:Object.values(r)[0]?.[0]?.name||"Unknown"});return c}function I(f){let n=d.current(),c=$(f);if(c.length===0){n()&&e.toast(e.t("bookmark_no_duplicates"),3e3);return}let o=document.createElement("div");o.className="je-bm-library-modal-overlay",o.style.cssText="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.85); z-index: 10000; display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.2s;",o.innerHTML=`
      <div class="je-bm-library-modal-container" style="max-width: 700px; background: #181818; border-radius: 12px; padding: 24px; position: relative; box-shadow: 0 8px 32px rgba(0,0,0,0.8); max-height: 85vh; overflow-y: auto;">
        <button class="je-bm-library-modal-close" style="position: absolute; top: 16px; right: 16px; background: transparent; border: none; color: #fff; font-size: 32px; cursor: pointer; width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; border-radius: 50%; transition: background 0.2s;">×</button>
        <div class="je-bm-library-modal-content">
          <div class="je-bookmarks-modal-header" style="display: flex; gap: 16px; align-items: flex-start; margin-bottom: 24px;">
            <span class="material-icons" aria-hidden="true" style="font-size: 48px; color: #ff9800; flex-shrink: 0;">merge</span>
            <div style="flex: 1;">
              <h2 style="margin: 0 0 8px 0; font-size: 24px; font-weight: 700; color: #fff;">${e.t("bookmark_duplicate_title")}</h2>
              <p style="margin: 0; font-size: 13px; color: #aaa;">${e.t("bookmark_duplicate_subtitle").replace("{count}",String(c.length))}</p>
            </div>
          </div>
          <div style="margin-top: 20px;">
            ${c.map((t,l)=>{let a=Object.keys(t.itemGroups);return`
                <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 16px; margin-bottom: 16px;">
                  <div style="font-weight: 600; margin-bottom: 12px; color: #ff9800;">${y(t.name)}</div>
                  <div style="font-size: 12px; color: #888; margin-bottom: 12px;">
                    ${e.t("bookmark_split_versions").replace("{count}",String(t.totalBookmarks)).replace("{versions}",String(a.length))}
                  </div>
                  ${a.map((i,s)=>{let u=t.itemGroups[i]??[];return`
                      <div style="background: rgba(255,255,255,0.02); border-left: 3px solid ${s===0?"#4caf50":"#ff9800"}; padding: 8px 12px; margin-bottom: 8px; border-radius: 4px;">
                        <div style="font-size: 11px; color: ${s===0?"#4caf50":"#ff9800"}; font-weight: 600; margin-bottom: 4px;">
                          ${s===0?e.t("bookmark_primary_version"):e.t("bookmark_old_version")}
                        </div>
                        <div style="font-size: 12px; color: #ccc; margin-bottom: 6px;">
                          ${e.t("bookmark_item_id")}: <code style="background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 3px; font-size: 11px;">${y(i.substring(0,16))}...</code>
                        </div>
                        <div style="font-size: 12px; color: #aaa; margin-bottom: 8px;">
                          ${e.t("bookmark_bookmark_count").replace("{count}",String(u.length))} ${u.map(p=>w(p.timestamp)).join(", ")}
                        </div>
                        <button class="je-btn" data-sync-from="${s}" data-dup-index="${l}" style="background: rgba(33, 150, 243, 0.15); border-color: #2196f3; color: #2196f3; font-size: 11px;">
                          <span class="material-icons" aria-hidden="true" style="font-size: 14px;">schedule</span>
                          <span>${e.t("bookmark_adjust_offset")}</span>
                        </button>
                      </div>
                    `}).join("")}
                  <button class="je-btn" data-dup-index="${l}" style="margin-top: 8px; background: rgba(255, 152, 0, 0.15); border-color: #ff9800; color: #ff9800;">
                    <span class="material-icons" aria-hidden="true" style="font-size: 16px;">merge</span>
                    <span>${e.t("bookmark_merge_primary")}</span>
                  </button>
                </div>
              `}).join("")}
          </div>
        </div>
        <div class="je-bookmark-modal-actions">
          <button class="je-bookmark-btn-cancel">
            <span class="material-icons" aria-hidden="true" style="font-size: 18px;">close</span>
            <span>Close</span>
          </button>
        </div>
      </div>
    `,document.body.appendChild(o);let r=d.modal(o);m(o,".je-bm-library-modal-close").addEventListener("click",r),m(o,".je-bookmark-btn-cancel").addEventListener("click",r),o.addEventListener("click",t=>{t.target===o&&r()}),o.querySelectorAll("[data-sync-from]").forEach(t=>{t.addEventListener("click",async()=>{if(!n())return;let l=Number(t.dataset.dupIndex),a=Number(t.dataset.syncFrom),i=c[l];if(!i)return;let u=Object.keys(i.itemGroups)[a];if(!u)return;let p=i.itemGroups[u]??[];r();let g={bookmarks:p,details:{name:i.name}};O(g)})}),o.querySelectorAll("button.je-btn:not([data-sync-from])").forEach(t=>{t.dataset.dupIndex&&t.addEventListener("click",async()=>{if(!n())return;let l=Number(t.dataset.dupIndex),a=c[l];if(!a)return;let i=Object.keys(a.itemGroups);if(i.length<2)return;let s=i[0],u=i.slice(1);if(!s)return;let p=a.itemGroups[s]?.[0];if(!p)return;let g=u.flatMap(x=>a.itemGroups[x]??[]);if(confirm(e.t("bookmark_merge_confirm").replace("{count}",String(g.length)))){t.disabled=!0,m(t,"span:last-child").innerHTML='<span class="material-icons" style="animation: spin 1s linear infinite; font-size: 18px;">refresh</span>';try{let x={itemId:s,tmdbId:p.tmdbId,tvdbId:p.tvdbId,mediaType:p.mediaType,name:p.name,seasonNumber:p.seasonNumber??null,episodeNumber:p.episodeNumber??null},T=await k.own.bookmarks.syncBookmarks(g,x,0);if(!n())return;n()&&e.toast(e.t("bookmark_merge_success").replace("{count}",String(T.length)),3e3),r();let M=document.querySelector(".sections.bookmarks");M&&b(()=>_(M),500)}catch(x){console.error("Merge failed:",x),n()&&e.toast(e.t("bookmark_merge_failed"),3e3),t.disabled=!1,m(t,"span:last-child").textContent=e.t("bookmark_merge_primary")}}})}),b(()=>o.style.opacity="1",10)}Object.assign(j,{showOffsetAdjustmentModal:O,showDuplicatesSyncModal:I})}H(k.core);})();
})();
