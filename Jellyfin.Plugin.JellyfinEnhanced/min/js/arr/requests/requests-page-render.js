(() => {
"use strict";(()=>{function C(f){let s=window.JellyfinEnhanced?.core?.sharedModules?.[f];if(!s)throw new Error(`${f} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return s}function E(f,s){return f[s]}var ne=C("features/downloads/host"),F=E(ne,"downloadsHost");var oe=C("features/downloads/runtime"),J=E(oe,"runtime");function N(f){let{JE:s,P:r,host:P,ctx:$,getApi:ae}=f,_=J(f);if(_.installed.has("render"))return;_.installed.add("render");let e=r.state,k=r.translateStatus,B=r.getDownloadStatuses,V=r.getFilteredDownloads,G=r.groupDownloads,U=r.renderDownloadCard,K=r.renderRequestCard,Q=r.renderIssueCard,z=r.renderHistoryCard,W=r.renderSeasonPackCard,X=r.clearAvatarObjectUrlCache,T=r.hydrateAvatarImages,R=r.hydrateExternalLinks,Y=r.loadAllData,A=r.handleRequestAction,Z=r.handleRemoveRequest;function D(){let t="";if(s.pluginConfig?.JellyseerrEnabled){t+='<div class="je-downloads-section je-requests-section">';let o=s.t&&s.t("requests_requests")||"Requests";t+=`<h2><span class="je-msym-rounded je-section-icon" aria-hidden="true">playlist_add_check</span>${o}</h2>`;let n=s.t&&s.t("jellyseerr_discover_all")||"All",m=s.t&&s.t("jellyseerr_btn_pending")||"Pending Approval",d=s.t&&s.t("jellyseerr_btn_processing")||"Processing",g=s.t&&s.t("jellyseerr_btn_available")||"Available",v=s.t&&s.t("requests_coming_soon")||"Coming Soon";if(t+=`
            <div class="je-requests-tabs">
              <button is="emby-button" type="button" class="je-requests-tab emby-button ${e.requestsFilter==="all"?"active":""}" onclick="window.JellyfinEnhanced.downloadsPage.filterRequests('all')">${n}</button>
              <button is="emby-button" type="button" class="je-requests-tab emby-button ${e.requestsFilter==="pending"?"active":""}" onclick="window.JellyfinEnhanced.downloadsPage.filterRequests('pending')">${m}</button>
              <button is="emby-button" type="button" class="je-requests-tab emby-button ${e.requestsFilter==="processing"?"active":""}" onclick="window.JellyfinEnhanced.downloadsPage.filterRequests('processing')">${d}</button>
              <button is="emby-button" type="button" class="je-requests-tab emby-button ${e.requestsFilter==="comingsoon"?"active":""}" onclick="window.JellyfinEnhanced.downloadsPage.filterRequests('comingsoon')">${v}</button>
              <button is="emby-button" type="button" class="je-requests-tab emby-button ${e.requestsFilter==="available"?"active":""}" onclick="window.JellyfinEnhanced.downloadsPage.filterRequests('available')">${g}</button>
            </div>
          `,e.isLoading&&e.requests.length===0)t+=s.core.ui.skeletonGridHtml(6);else if(e.requestsError)t+=`<div class="je-empty-state">${s.t?.("requests_requests_load_failed")||"Unable to load requests"}</div>`;else if(e.requests.length===0)t+=`
                    <div class="je-empty-state">
                        <div>${s.t?.("requests_no_requests_found")||"No requests found"}</div>
                    </div>
                `;else{let c=e.requests,x=$.peer("hiddenContent");x&&(c=x.filterRequestItems(c)),e.requestsFilter==="processing"&&(c=c.filter(h=>h.mediaStatus!=="Partially Available")),c.length===0?t+=`
                    <div class="je-empty-state">
                        <div>${s.t?.("requests_no_requests_found")||"No requests found"}</div>
                    </div>
                `:(t+='<div class="je-downloads-grid je-requests-grid">',c.forEach(h=>{t+=K(h)}),t+="</div>",e.requestsTotalPages>1&&(t+=`
                        <div class="je-pagination">
                            <button is="emby-button" type="button" class="emby-button" onclick="window.JellyfinEnhanced.downloadsPage.prevPage()" ${e.requestsPage<=1?"disabled":""}><span class="material-icons">chevron_left</span></button>
                            <span>${e.requestsPage} / ${e.requestsTotalPages}</span>
                            <button is="emby-button" type="button" class="emby-button" onclick="window.JellyfinEnhanced.downloadsPage.nextPage()" ${e.requestsPage>=e.requestsTotalPages?"disabled":""}><span class="material-icons">chevron_right</span></button>
                        </div>
                    `))}t+="</div>"}return t}function O(){let t="";if(s.pluginConfig?.JellyseerrEnabled&&s.pluginConfig?.DownloadsPageShowIssues){t+='<div class="je-downloads-section je-issues-section">';let o=s.t&&s.t("jellyseerr_existing_issues")||"Issues";t+=`<h2><span class="je-msym-rounded je-section-icon" aria-hidden="true">warning</span>${o}</h2>`;let n=s.t&&s.t("jellyseerr_issue_open")||"Open",m=s.t&&s.t("jellyseerr_issue_resolved")||"Resolved";t+=`
        <div class="je-issues-tabs">
          <button is="emby-button" type="button" class="je-issues-tab emby-button ${e.issuesFilter==="open"?"active":""}" onclick="window.JellyfinEnhanced.downloadsPage.filterIssues('open')">${n}</button>
          <button is="emby-button" type="button" class="je-issues-tab emby-button ${e.issuesFilter==="resolved"?"active":""}" onclick="window.JellyfinEnhanced.downloadsPage.filterIssues('resolved')">${m}</button>
        </div>
      `,e.isLoading&&e.issues.length===0?t+=s.core.ui.skeletonGridHtml(6):e.issuesError?t+=`
          <div class="je-empty-state">
            <div>${s.t?.("jellyseerr_load_issues_error")||"Unable to load issues"}</div>
          </div>
        `:e.issues.length===0?t+=`
          <div class="je-empty-state">
            <div>${s.t?.("jellyseerr_no_issues_yet")||"No issues found"}</div>
          </div>
        `:(t+='<div class="je-downloads-grid je-issues-grid">',e.issues.forEach(d=>{t+=Q(d)}),t+="</div>",e.issuesTotalPages>1&&(t+=`
            <div class="je-pagination">
              <button is="emby-button" type="button" class="emby-button" onclick="window.JellyfinEnhanced.downloadsPage.prevIssuesPage()" ${e.issuesPage<=1?"disabled":""}><span class="material-icons">chevron_left</span></button>
              <span>${e.issuesPage} / ${e.issuesTotalPages}</span>
              <button is="emby-button" type="button" class="emby-button" onclick="window.JellyfinEnhanced.downloadsPage.nextIssuesPage()" ${e.issuesPage>=e.issuesTotalPages?"disabled":""}><span class="material-icons">chevron_right</span></button>
            </div>
          `)),t+="</div>"}return t}function H(){let t="";if(s.pluginConfig?.ShowDownloadsInRequests!==!1&&s.pluginConfig?.DownloadsShowHistory!==!1&&e.historyVisible!==!1){t+='<div class="je-downloads-section je-history-section">';let o=s.t&&s.t("requests_history")||"History";if(t+=`<h2><span class="je-msym-rounded je-section-icon" aria-hidden="true">history</span>${o}</h2>`,e.isLoading&&e.history.length===0)t+=s.core.ui.skeletonGridHtml(6);else if(e.historyError)t+=`<div class="je-empty-state">${s.t?.("requests_history_load_failed")||"Unable to load history"}</div>`;else if(e.history.length===0){let n=s.t&&s.t("requests_no_history_found")||"No history found";t+=`
          <div class="je-empty-state">
            <div>${n}</div>
          </div>
        `}else t+='<div class="je-downloads-grid je-history-grid">',e.history.forEach(n=>{t+=z(n)}),t+="</div>",e.historyTotalPages>1&&(t+=`
            <div class="je-pagination">
              <button is="emby-button" type="button" class="emby-button" onclick="window.JellyfinEnhanced.downloadsPage.prevHistoryPage()" ${e.historyPage<=1?"disabled":""}><span class="material-icons">chevron_left</span></button>
              <span>${e.historyPage} / ${e.historyTotalPages}</span>
              <button is="emby-button" type="button" class="emby-button" onclick="window.JellyfinEnhanced.downloadsPage.nextHistoryPage()" ${e.historyPage>=e.historyTotalPages?"disabled":""}><span class="material-icons">chevron_right</span></button>
            </div>
          `);t+="</div>"}return t}let y=null;function w(t){let o;if(t)e._customTabContainer=t,o=t;else if(e._customTabContainer&&document.contains(e._customTabContainer)&&window.location.hash.indexOf("userpluginsettings")===-1)o=e._customTabContainer;else if(e._customTabContainer=null,o=document.getElementById("je-downloads-container"),!o)return;let n="";if(s.pluginConfig?.ShowDownloadsInRequests!==!1){n+='<div class="je-downloads-section je-active-downloads-section" style="margin-top: 2em;">';let a=s.t&&s.t("requests_downloads")||"Downloads";if(n+=`
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 1em;">
        <h2 style="margin: 0.5em 0 0 0;"><span class="je-msym-rounded je-section-icon" aria-hidden="true">download</span>${a}</h2>
        <button class="je-refresh-btn emby-button" style="background: transparent; border: 1px solid rgba(255,255,255,0.3); color: inherit; padding: 0.5em; border-radius: 10px; cursor: pointer; display: flex; align-items: center; gap: 0.5em; opacity: 0.8; transition: all 0.2s;">
          <span class="material-icons" style="font-size: 18px;">refresh</span>
        </button>
      </div>
    `,e.isLoading&&e.downloads.length===0)n+=s.core.ui.skeletonGridHtml(6);else if(e.downloadsError)n+=`<div class="je-empty-state">${s.t?.("requests_downloads_load_failed")||"Unable to load downloads"}</div>`;else if(e.downloads.length===0){let i=s.t&&s.t("requests_no_active_downloads")||"No active downloads";n+=`
        <div class="je-empty-state">
          <div>${i}</div>
        </div>
      `}else{let i=B(),u=e.downloads.length>0;if(i.length>1||u){if(n+='<div class="je-downloads-controls">',i.length>0){let p=i.reduce((l,[q,b])=>l+b,0);n+='<div class="je-downloads-tabs">',n+=`<button is="emby-button" type="button" class="je-downloads-tab emby-button ${e.downloadsActiveTab==="all"?"active":""}" data-tab="all">
            <span>${k("All")}</span>
            <span class="je-downloads-tab-count">${p}</span>
          </button>`;for(let[l,q]of i)n+=`<button is="emby-button" type="button" class="je-downloads-tab emby-button ${e.downloadsActiveTab===l?"active":""}" data-tab="${s.escapeHtml(l)}">
              <span>${s.escapeHtml(k(l))}</span>
              <span class="je-downloads-tab-count">${q}</span>
            </button>`;u&&(n+=`<button class="je-downloads-search-toggle ${e.downloadsSearchVisible?"active":""}">
              <span class="material-icons">search</span>
            </button>`),n+="</div>"}u&&e.downloadsSearchVisible&&(n+=`<div class="je-downloads-search-container">
            <span class="material-icons je-downloads-search-icon">search</span>
            <input type="text" class="je-downloads-search-input" value="${s.escapeHtml(e.downloadsSearchQuery)}" autofocus>
          </div>`),n+="</div>"}let j=V();if(j.length===0){let p=s.t&&s.t("requests_no_downloads_found")||"No downloads found";n+=`
          <div class="je-empty-state">
            <div>${p}</div>
          </div>
        `}else{let p=G(j);n+='<div class="je-downloads-grid">';for(let l of p)l.type==="seasonPack"?n+=W(l):n+=U(l.item);n+="</div>"}}n+="</div>"}if(n+=D(),n+=O(),n+=H(),y&&y.container===o&&y.html===n&&y.first&&o.firstChild===y.first)return;let d=document.activeElement,g=d instanceof HTMLInputElement&&d.classList.contains("je-downloads-search-input")&&o.contains(d)?[d.selectionStart,d.selectionEnd]:null;X(),o.innerHTML=n,y={container:o,html:n,first:o.firstChild},T(o),R(o);let v=g?o.querySelector(".je-downloads-search-input"):null;v&&g&&(v.focus(),v.setSelectionRange(g[0],g[1]));let c=o.querySelector(".je-refresh-btn");c&&c.addEventListener("click",a=>{a.preventDefault();let i=c.querySelector(".material-icons");i&&(i.style.animation="spin 1s linear",setTimeout(()=>{i.style.animation=""},1e3)),Y()}),o.querySelectorAll(".je-downloads-tab").forEach(a=>{a.addEventListener("click",i=>{i.preventDefault();let u=a.getAttribute("data-tab");e.downloadsActiveTab=u||"all",w()})});let h=o.querySelector(".je-downloads-search-toggle");h&&h.addEventListener("click",a=>{a.preventDefault(),e.downloadsSearchVisible=!e.downloadsSearchVisible,e.downloadsSearchVisible||(e.downloadsSearchQuery=""),w()});let S=o.querySelector(".je-downloads-search-input");S&&S.addEventListener("input",a=>{let i=_.capture(),u=S.value;e.downloadsSearchQuery=u,e.searchDebounceTimer&&clearTimeout(e.searchDebounceTimer),e.searchDebounceTimer=setTimeout(()=>{i.current()&&w()},300)}),o.dataset.jeRequestsActionsBound||(o.dataset.jeRequestsActionsBound="true",o.addEventListener("click",a=>{if(!(a.target instanceof Element))return;let i=a.target.closest(".je-request-watch-btn");if(i){a.preventDefault(),a.stopPropagation();let b=i.getAttribute("data-media-id");b&&P.Emby?.Page?.showItem&&P.Emby.Page.showItem(b);return}let u=a.target.closest(".je-request-approve-btn");if(u){a.preventDefault(),a.stopPropagation(),A(u,"approve");return}let j=a.target.closest(".je-request-decline-btn");if(j){a.preventDefault(),a.stopPropagation(),A(j,"decline");return}let p=a.target.closest(".je-request-remove-btn");if(p){a.preventDefault(),a.stopPropagation(),Z(p);return}let l=a.target.closest(".je-issue-view-btn");if(l&&!l.classList.contains("is-disabled")){a.preventDefault(),a.stopPropagation();let b=l.getAttribute("data-issue-tmdb-id"),L=l.getAttribute("data-issue-media-type"),se=l.getAttribute("data-issue-title")||"",M=$.peer("jellyseerrIssueReporter");b&&L&&M?.showReportModal&&M.showReportModal(b,se,L,null,null);return}let q=a.target.closest(".je-download-card, .je-request-card, .je-issue-card");if(q){let b=q.getAttribute("data-media-id");b&&P.Emby?.Page?.showItem&&P.Emby.Page.showItem(b)}}))}function ee(){let t=document.getElementById("je-downloads-page");if(!t){t=document.createElement("div"),t.id="je-downloads-page",t.className="page type-interior mainAnimatedPage hide",t.setAttribute("data-title",s.t?.("requests_requests")||"Requests"),t.setAttribute("data-backbutton","true"),t.setAttribute("data-url","#/downloads"),t.setAttribute("data-type","custom"),t.innerHTML=`
        <div data-role="content">
          <div class="content-primary je-downloads-page">
            <div id="je-downloads-container" style="padding-top: 5em;"></div>
          </div>
        </div>
      `;let o=document.querySelector(".mainAnimatedPages");o?o.appendChild(t):document.body.appendChild(t)}return t}let I={requests:{selector:".je-requests-section",build:D},issues:{selector:".je-issues-section",build:O},history:{selector:".je-history-section",build:H}};function te(t){let n=(e._customTabContainer&&document.contains(e._customTabContainer)&&window.location.hash.indexOf("userpluginsettings")===-1?e._customTabContainer:document.getElementById("je-downloads-container"))?.querySelector(I[t].selector);if(!n){w();return}let m=document.createElement("template");m.innerHTML=I[t].build();let d=m.content.firstElementChild;if(!d){n.remove();return}n.replaceWith(d),T(d),R(d)}r.renderPage=w,r.renderSection=te,r.createPageContainer=ee}N(F());})();
})();
