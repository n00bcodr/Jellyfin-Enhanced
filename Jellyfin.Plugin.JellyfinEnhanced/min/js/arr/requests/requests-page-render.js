(() => {
"use strict";(()=>{function j(m){let s=window.JellyfinEnhanced?.core?.sharedModules?.[m];if(!s)throw new Error(`${m} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return s}function q(m,s){return m[s]}var X=j("features/downloads/host"),D=q(X,"downloadsHost");var Y=j("features/downloads/runtime"),I=q(Y,"runtime");function H(m){let{JE:s,P:i,host:w,ctx:C,getApi:Z}=m,P=I(m);if(P.installed.has("render"))return;P.installed.add("render");let e=i.state,E=i.translateStatus,M=i.getDownloadStatuses,L=i.getFilteredDownloads,F=i.groupDownloads,J=i.renderDownloadCard,N=i.renderRequestCard,B=i.renderIssueCard,V=i.renderHistoryCard,G=i.renderSeasonPackCard,U=i.clearAvatarObjectUrlCache,x=i.hydrateAvatarImages,_=i.hydrateExternalLinks,K=i.loadAllData,S=i.handleRequestAction;function $(){let t="";if(s.pluginConfig?.JellyseerrEnabled){t+='<div class="je-downloads-section je-requests-section">';let a=s.t&&s.t("requests_requests")||"Requests";t+=`<h2><span class="je-msym-rounded je-section-icon" aria-hidden="true">playlist_add_check</span>${a}</h2>`;let n=s.t&&s.t("jellyseerr_discover_all")||"All",y=s.t&&s.t("jellyseerr_btn_pending")||"Pending Approval",c=s.t&&s.t("jellyseerr_btn_processing")||"Processing",A=s.t&&s.t("jellyseerr_btn_available")||"Available",h=s.t&&s.t("requests_coming_soon")||"Coming Soon";if(t+=`
            <div class="je-requests-tabs">
              <button is="emby-button" type="button" class="je-requests-tab emby-button ${e.requestsFilter==="all"?"active":""}" onclick="window.JellyfinEnhanced.downloadsPage.filterRequests('all')">${n}</button>
              <button is="emby-button" type="button" class="je-requests-tab emby-button ${e.requestsFilter==="pending"?"active":""}" onclick="window.JellyfinEnhanced.downloadsPage.filterRequests('pending')">${y}</button>
              <button is="emby-button" type="button" class="je-requests-tab emby-button ${e.requestsFilter==="processing"?"active":""}" onclick="window.JellyfinEnhanced.downloadsPage.filterRequests('processing')">${c}</button>
              <button is="emby-button" type="button" class="je-requests-tab emby-button ${e.requestsFilter==="comingsoon"?"active":""}" onclick="window.JellyfinEnhanced.downloadsPage.filterRequests('comingsoon')">${h}</button>
              <button is="emby-button" type="button" class="je-requests-tab emby-button ${e.requestsFilter==="available"?"active":""}" onclick="window.JellyfinEnhanced.downloadsPage.filterRequests('available')">${A}</button>
            </div>
          `,e.isLoading&&e.requests.length===0)t+=s.core.ui.skeletonGridHtml(6);else if(e.requestsError)t+='<div class="je-empty-state">Unable to load requests</div>';else if(e.requests.length===0)t+=`
                    <div class="je-empty-state">
                        <div>${s.t?.("requests_no_requests_found")||"No requests found"}</div>
                    </div>
                `;else{let b=e.requests,o=C.peer("hiddenContent");o&&(b=o.filterRequestItems(b)),e.requestsFilter==="processing"&&(b=b.filter(r=>r.mediaStatus!=="Partially Available")),b.length===0?t+=`
                    <div class="je-empty-state">
                        <div>${s.t?.("requests_no_requests_found")||"No requests found"}</div>
                    </div>
                `:(t+='<div class="je-downloads-grid je-requests-grid">',b.forEach(r=>{t+=N(r)}),t+="</div>",e.requestsTotalPages>1&&(t+=`
                        <div class="je-pagination">
                            <button is="emby-button" type="button" class="emby-button" onclick="window.JellyfinEnhanced.downloadsPage.prevPage()" ${e.requestsPage<=1?"disabled":""}><span class="material-icons">chevron_left</span></button>
                            <span>${e.requestsPage} / ${e.requestsTotalPages}</span>
                            <button is="emby-button" type="button" class="emby-button" onclick="window.JellyfinEnhanced.downloadsPage.nextPage()" ${e.requestsPage>=e.requestsTotalPages?"disabled":""}><span class="material-icons">chevron_right</span></button>
                        </div>
                    `))}t+="</div>"}return t}function k(){let t="";if(s.pluginConfig?.JellyseerrEnabled&&s.pluginConfig?.DownloadsPageShowIssues){t+='<div class="je-downloads-section je-issues-section">';let a=s.t&&s.t("jellyseerr_existing_issues")||"Issues";t+=`<h2><span class="je-msym-rounded je-section-icon" aria-hidden="true">warning</span>${a}</h2>`;let n=s.t&&s.t("jellyseerr_issue_open")||"Open",y=s.t&&s.t("jellyseerr_issue_resolved")||"Resolved";t+=`
        <div class="je-issues-tabs">
          <button is="emby-button" type="button" class="je-issues-tab emby-button ${e.issuesFilter==="open"?"active":""}" onclick="window.JellyfinEnhanced.downloadsPage.filterIssues('open')">${n}</button>
          <button is="emby-button" type="button" class="je-issues-tab emby-button ${e.issuesFilter==="resolved"?"active":""}" onclick="window.JellyfinEnhanced.downloadsPage.filterIssues('resolved')">${y}</button>
        </div>
      `,e.isLoading&&e.issues.length===0?t+=s.core.ui.skeletonGridHtml(6):e.issuesError?t+=`
          <div class="je-empty-state">
            <div>${s.t?.("jellyseerr_load_issues_error")||"Unable to load issues"}</div>
          </div>
        `:e.issues.length===0?t+=`
          <div class="je-empty-state">
            <div>${s.t?.("jellyseerr_no_issues_yet")||"No issues found"}</div>
          </div>
        `:(t+='<div class="je-downloads-grid je-issues-grid">',e.issues.forEach(c=>{t+=B(c)}),t+="</div>",e.issuesTotalPages>1&&(t+=`
            <div class="je-pagination">
              <button is="emby-button" type="button" class="emby-button" onclick="window.JellyfinEnhanced.downloadsPage.prevIssuesPage()" ${e.issuesPage<=1?"disabled":""}><span class="material-icons">chevron_left</span></button>
              <span>${e.issuesPage} / ${e.issuesTotalPages}</span>
              <button is="emby-button" type="button" class="emby-button" onclick="window.JellyfinEnhanced.downloadsPage.nextIssuesPage()" ${e.issuesPage>=e.issuesTotalPages?"disabled":""}><span class="material-icons">chevron_right</span></button>
            </div>
          `)),t+="</div>"}return t}function T(){let t="";if(s.pluginConfig?.ShowDownloadsInRequests!==!1&&s.pluginConfig?.DownloadsShowHistory!==!1&&e.historyVisible!==!1){t+='<div class="je-downloads-section je-history-section">';let a=s.t&&s.t("requests_history")||"History";if(t+=`<h2><span class="je-msym-rounded je-section-icon" aria-hidden="true">history</span>${a}</h2>`,e.isLoading&&e.history.length===0)t+=s.core.ui.skeletonGridHtml(6);else if(e.historyError)t+='<div class="je-empty-state">Unable to load history</div>';else if(e.history.length===0){let n=s.t&&s.t("requests_no_history_found")||"No history found";t+=`
          <div class="je-empty-state">
            <div>${n}</div>
          </div>
        `}else t+='<div class="je-downloads-grid je-history-grid">',e.history.forEach(n=>{t+=V(n)}),t+="</div>",e.historyTotalPages>1&&(t+=`
            <div class="je-pagination">
              <button is="emby-button" type="button" class="emby-button" onclick="window.JellyfinEnhanced.downloadsPage.prevHistoryPage()" ${e.historyPage<=1?"disabled":""}><span class="material-icons">chevron_left</span></button>
              <span>${e.historyPage} / ${e.historyTotalPages}</span>
              <button is="emby-button" type="button" class="emby-button" onclick="window.JellyfinEnhanced.downloadsPage.nextHistoryPage()" ${e.historyPage>=e.historyTotalPages?"disabled":""}><span class="material-icons">chevron_right</span></button>
            </div>
          `);t+="</div>"}return t}function g(t){let a;if(t)e._customTabContainer=t,a=t;else if(e._customTabContainer&&document.contains(e._customTabContainer)&&window.location.hash.indexOf("userpluginsettings")===-1)a=e._customTabContainer;else if(e._customTabContainer=null,a=document.getElementById("je-downloads-container"),!a)return;let n="";if(s.pluginConfig?.ShowDownloadsInRequests!==!1){n+='<div class="je-downloads-section je-active-downloads-section" style="margin-top: 2em;">';let o=s.t&&s.t("requests_downloads")||"Downloads";if(n+=`
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 1em;">
        <h2 style="margin: 0.5em 0 0 0;"><span class="je-msym-rounded je-section-icon" aria-hidden="true">download</span>${o}</h2>
        <button class="je-refresh-btn emby-button" style="background: transparent; border: 1px solid rgba(255,255,255,0.3); color: inherit; padding: 0.5em; border-radius: 10px; cursor: pointer; display: flex; align-items: center; gap: 0.5em; opacity: 0.8; transition: all 0.2s;">
          <span class="material-icons" style="font-size: 18px;">refresh</span>
        </button>
      </div>
    `,e.isLoading&&e.downloads.length===0)n+=s.core.ui.skeletonGridHtml(6);else if(e.downloadsError)n+='<div class="je-empty-state">Unable to load downloads</div>';else if(e.downloads.length===0){let r=s.t&&s.t("requests_no_active_downloads")||"No active downloads";n+=`
        <div class="je-empty-state">
          <div>${r}</div>
        </div>
      `}else{let r=M(),p=e.downloads.length>0;if(r.length>1||p){if(n+='<div class="je-downloads-controls">',r.length>0){let d=r.reduce((l,[u,v])=>l+v,0);n+='<div class="je-downloads-tabs">',n+=`<button is="emby-button" type="button" class="je-downloads-tab emby-button ${e.downloadsActiveTab==="all"?"active":""}" data-tab="all">
            <span>${E("All")}</span>
            <span class="je-downloads-tab-count">${d}</span>
          </button>`;for(let[l,u]of r)n+=`<button is="emby-button" type="button" class="je-downloads-tab emby-button ${e.downloadsActiveTab===l?"active":""}" data-tab="${s.escapeHtml(l)}">
              <span>${s.escapeHtml(E(l))}</span>
              <span class="je-downloads-tab-count">${u}</span>
            </button>`;p&&(n+=`<button class="je-downloads-search-toggle ${e.downloadsSearchVisible?"active":""}">
              <span class="material-icons">search</span>
            </button>`),n+="</div>"}p&&e.downloadsSearchVisible&&(n+=`<div class="je-downloads-search-container">
            <span class="material-icons je-downloads-search-icon">search</span>
            <input type="text" class="je-downloads-search-input" value="${s.escapeHtml(e.downloadsSearchQuery)}" autofocus>
          </div>`),n+="</div>"}let f=L();if(f.length===0){let d=s.t&&s.t("requests_no_downloads_found")||"No downloads found";n+=`
          <div class="je-empty-state">
            <div>${d}</div>
          </div>
        `}else{let d=F(f);n+='<div class="je-downloads-grid">';for(let l of d)l.type==="seasonPack"?n+=G(l):n+=J(l.item);n+="</div>"}}n+="</div>"}n+=$(),n+=k(),n+=T(),U(),a.innerHTML=n,x(a),_(a);let c=a.querySelector(".je-refresh-btn");c&&c.addEventListener("click",o=>{o.preventDefault();let r=c.querySelector(".material-icons");r&&(r.style.animation="spin 1s linear",setTimeout(()=>{r.style.animation=""},1e3)),K()}),a.querySelectorAll(".je-downloads-tab").forEach(o=>{o.addEventListener("click",r=>{r.preventDefault();let p=o.getAttribute("data-tab");e.downloadsActiveTab=p||"all",g()})});let h=a.querySelector(".je-downloads-search-toggle");h&&h.addEventListener("click",o=>{o.preventDefault(),e.downloadsSearchVisible=!e.downloadsSearchVisible,e.downloadsSearchVisible||(e.downloadsSearchQuery=""),g()});let b=a.querySelector(".je-downloads-search-input");b&&b.addEventListener("input",o=>{let r=P.capture(),p=b.value;e.downloadsSearchQuery=p,e.searchDebounceTimer&&clearTimeout(e.searchDebounceTimer),e.searchDebounceTimer=setTimeout(()=>{if(!r.current())return;let f=document.querySelector(".je-downloads-search-input"),d=f?f.selectionStart:0;g();let l=document.querySelector(".je-downloads-search-input");l&&(l.focus(),l.setSelectionRange(d,d))},300)}),a.dataset.jeRequestsActionsBound||(a.dataset.jeRequestsActionsBound="true",a.addEventListener("click",o=>{if(!(o.target instanceof Element))return;let r=o.target.closest(".je-request-watch-btn");if(r){o.preventDefault(),o.stopPropagation();let u=r.getAttribute("data-media-id");u&&w.Emby?.Page?.showItem&&w.Emby.Page.showItem(u);return}let p=o.target.closest(".je-request-approve-btn");if(p){o.preventDefault(),o.stopPropagation(),S(p,"approve");return}let f=o.target.closest(".je-request-decline-btn");if(f){o.preventDefault(),o.stopPropagation(),S(f,"decline");return}let d=o.target.closest(".je-issue-view-btn");if(d&&!d.classList.contains("is-disabled")){o.preventDefault(),o.stopPropagation();let u=d.getAttribute("data-issue-tmdb-id"),v=d.getAttribute("data-issue-media-type"),W=d.getAttribute("data-issue-title")||"",O=C.peer("jellyseerrIssueReporter");u&&v&&O?.showReportModal&&O.showReportModal(u,W,v,null,null);return}let l=o.target.closest(".je-download-card, .je-request-card, .je-issue-card");if(l){let u=l.getAttribute("data-media-id");u&&w.Emby?.Page?.showItem&&w.Emby.Page.showItem(u)}}))}function Q(){let t=document.getElementById("je-downloads-page");if(!t){t=document.createElement("div"),t.id="je-downloads-page",t.className="page type-interior mainAnimatedPage hide",t.setAttribute("data-title",s.t?.("requests_requests")||"Requests"),t.setAttribute("data-backbutton","true"),t.setAttribute("data-url","#/downloads"),t.setAttribute("data-type","custom"),t.innerHTML=`
        <div data-role="content">
          <div class="content-primary je-downloads-page">
            <div id="je-downloads-container" style="padding-top: 5em;"></div>
          </div>
        </div>
      `;let a=document.querySelector(".mainAnimatedPages");a?a.appendChild(t):document.body.appendChild(t)}return t}let R={requests:{selector:".je-requests-section",build:$},issues:{selector:".je-issues-section",build:k},history:{selector:".je-history-section",build:T}};function z(t){let n=(e._customTabContainer&&document.contains(e._customTabContainer)&&window.location.hash.indexOf("userpluginsettings")===-1?e._customTabContainer:document.getElementById("je-downloads-container"))?.querySelector(R[t].selector);if(!n){g();return}let y=document.createElement("template");y.innerHTML=R[t].build();let c=y.content.firstElementChild;if(!c){n.remove();return}n.replaceWith(c),x(c),_(c)}i.renderPage=g,i.renderSection=z,i.createPageContainer=Q}H(D());})();
})();
