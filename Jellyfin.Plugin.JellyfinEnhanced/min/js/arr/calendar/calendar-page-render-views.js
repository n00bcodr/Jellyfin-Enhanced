(() => {
"use strict";(()=>{function A(a){if(/^\d{4}-\d{2}-\d{2}$/.test(a)){let[y=0,o=0,e=0]=a.split("-").map(Number),f=new Date(y,o-1,e);return f.getFullYear()!==y||f.getMonth()!==o-1||f.getDate()!==e?new Date(NaN):f}return new Date(a)}function O(a){let y=window.JellyfinEnhanced?.core?.sharedModules?.[a];if(!y)throw new Error(`${a} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return y}function R(a,y){return a[y]}var re=O("features/calendar/host"),L=R(re,"calendarHost");(function(){"use strict";let{JE:a,ctx:y,P:o}=L(),e=o.state,f=o.STATUS_COLORS,j=o.filterEvents,$=o.groupEventsByDate,J=o.getRangeForView,q=o.getDaysInMonth,N=o.getFirstDayOfMonth,P=o.isTodayDate,H=o.formatRangeLabel,W=o.formatHourLabel,M=o.locale,x=n=>new Date(2026,1,1+n).toLocaleDateString(M(),{weekday:"short"}),E=o.renderEvent,z=o.renderAgendaEvent,b=o.renderCardItems,C=o.compareEventsWithinDay,k=o.collapseEpisodes;function S(){return window.matchMedia?window.matchMedia("(max-width: 768px)").matches:!1}function I(){let n=document.querySelector(".je-calendar-sidebar"),t=document.querySelector(".je-calendar-sidebar-toggle");!n||!t||(n.classList.toggle("is-collapsed",!!e.sidebarCollapsed),t.setAttribute("aria-expanded",e.sidebarCollapsed?"false":"true"))}function V(n){e.sidebarCollapsed=!!n,I()}function U(){typeof e.sidebarCollapsed!="boolean"&&(e.sidebarCollapsed=S()),V(!e.sidebarCollapsed)}function B(){document.querySelectorAll(".je-calendar-mode-btn").forEach(t=>{let c=t.dataset.mode;t.classList.toggle("active",c===e.settings.displayMode)})}function K(){let n=new Date(e.currentDate);n.setHours(0,0,0,0),n.setDate(1);let t=q(n),c=N(n),p=j(e.events),v=y.peer("hiddenContent");v&&(p=v.filterCalendarEvents(p));let u=$(p);if(p.length===0)return`<div class="je-calendar-empty">${a.t("calendar_no_releases")}</div>`;let d=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"],i=d.indexOf(e.settings.firstDayOfWeek),m=[...d.slice(i),...d.slice(0,i)],r='<div class="je-calendar-month">';r+='<div class="je-calendar-weekdays">',m.forEach(s=>{r+=`<div class="je-calendar-weekday">${x(d.indexOf(s))}</div>`}),r+="</div>",r+='<div class="je-calendar-month-grid">';for(let s=0;s<c;s++)r+='<div class="je-calendar-day je-calendar-day-placeholder" style="opacity: 0.3;"></div>';for(let s=1;s<=t;s++){let g=n.getFullYear(),l=String(n.getMonth()+1).padStart(2,"0"),h=String(s).padStart(2,"0"),D=`${g}-${l}-${h}`,w=u[D]||[];w.sort(C),w=k(w);let F=new Date(g,n.getMonth(),s),ne=P(F)?" je-calendar-today":"",ae=x(F.getDay());r+=`
        <div class="je-calendar-day${ne}">
          <div class="je-calendar-day-header">
            <span class="je-calendar-day-number">${s}</span>
            <span class="je-calendar-month-day-name">${ae}</span>
          </div>
          <div class="${e.settings.displayMode==="cards"?"je-calendar-day-cards":"je-calendar-events-list"}">
            ${e.settings.displayMode==="cards"?b(w):w.map(te=>E(te)).join("")}
          </div>
        </div>
      `}return r+="</div></div>",r}function Y(){let{start:n}=J(e.currentDate,"week"),t=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"],c=j(e.events),p=y.peer("hiddenContent");p&&(c=p.filterCalendarEvents(c));let v=$(c);if(c.length===0)return`<div class="je-calendar-empty">${a.t("calendar_no_releases")}</div>`;let u='<div class="je-calendar-grid">';for(let d=0;d<7;d++){let i=new Date(n);i.setDate(n.getDate()+d);let m=i.getFullYear(),r=String(i.getMonth()+1).padStart(2,"0"),s=String(i.getDate()).padStart(2,"0"),g=`${m}-${r}-${s}`,l=v[g]||[];l.sort(C),l=k(l);let h=P(i)?" je-calendar-today":"";u+=`
        <div class="je-calendar-day${h}">
          <div class="je-calendar-day-header">
            <span class="je-calendar-day-number">${i.getDate()}</span>
            <span class="je-calendar-day-name">${x(i.getDay())}</span>
          </div>
          <div class="${e.settings.displayMode==="cards"?"je-calendar-day-cards":"je-calendar-events-list"}">
            ${e.settings.displayMode==="cards"?b(l):l.map(D=>E(D)).join("")}
          </div>
        </div>
      `}return u+="</div>",u}function G(){let n=j(e.events),t=y.peer("hiddenContent");t&&(n=t.filterCalendarEvents(n));let c=$(n),p=Object.keys(c).sort();if(p.length===0)return`<div class="je-calendar-empty">${a.t("calendar_no_releases")}</div>`;let v='<div class="je-calendar-agenda">';return p.forEach(u=>{let[d="0",i="1",m="1"]=u.split("-"),r=new Date(parseInt(d),parseInt(i)-1,parseInt(m)),s=r.toLocaleDateString(M(),{weekday:"short"}),g=r.toLocaleDateString(M(),{month:"short",day:"numeric"}),l=c[u]||[];l.sort(C),l=k(l),v+=`
        <div class="je-calendar-agenda-row">
          <div class="je-calendar-agenda-date">
            <div>${s}, ${g}</div>
          </div>
          <div class="je-calendar-agenda-events">
            ${l.map(h=>z(h)).join("")}
          </div>
        </div>
      `}),v+="</div>",v}function Q(){let n=j(e.events),t=y.peer("hiddenContent");t&&(n=t.filterCalendarEvents(n));let c=$(n),p=new Date(e.currentDate),v=`${p.getFullYear()}-${String(p.getMonth()+1).padStart(2,"0")}-${String(p.getDate()).padStart(2,"0")}`,u=c[v]||[];if(u.sort(C),u=k(u),u.length===0)return`<div class="je-calendar-empty">${a.t("calendar_no_releases")}</div>`;if(e.settings.displayMode==="cards")return`
        <div class="je-calendar-dayline je-calendar-day-cards">
          ${b(u)}
        </div>
      `;let d={allDay:[],hours:new Map};u.forEach(r=>{let s=A(r.releaseDate);if(Number.isNaN(s.getTime())){d.allDay.push(r);return}if(!!(s.getHours()===0&&s.getMinutes()===0)){d.allDay.push(r);return}let l=s.getHours();d.hours.has(l)||d.hours.set(l,[]),d.hours.get(l)?.push(r)});let i='<div class="je-calendar-day-hours">';for(let r=0;r<24;r+=1){let s=d.hours.get(r);if(!s||s.length===0)continue;let g=e.settings.displayMode==="cards"?"je-calendar-hour-events je-calendar-day-cards":"je-calendar-hour-events";i+=`
        <div class="je-calendar-hour-row">
          <div class="je-calendar-hour-label">${W(r)}</div>
          <div class="${g}">
            ${e.settings.displayMode==="cards"?b(s):s.map(l=>E(l)).join("")}
          </div>
        </div>
      `}let m=a.t?.("calendar_all_day")||"All day";if(d.allDay.length){let r=d.allDay,s=e.settings.displayMode==="cards"?"je-calendar-hour-events je-calendar-day-cards":"je-calendar-hour-events";i+=`
        <div class="je-calendar-hour-row">
          <div class="je-calendar-hour-label">${m}</div>
          <div class="${s}">
            ${e.settings.displayMode==="cards"?b(r):r.map(g=>E(g)).join("")}
          </div>
        </div>
      `}return i+="</div>",i}function X(){return e.error&&!e.events.length||e.requestError&&(e.settings.forceOnlyRequested||e.activeFilters.has("Requests"))?`<div class="je-calendar-error" role="alert">${a.escapeHtml(e.error||e.requestError||"")}<button onclick="window.JellyfinEnhanced.calendarPage.refresh()">${a.t("calendar_retry")}</button></div>`:e.viewMode==="week"?Y():e.viewMode==="agenda"?G():e.viewMode==="day"?Q():K()}function Z(){let n=e.activeFilters.size>0,t=l=>n?e.activeFilters.has(l)?"active":"inactive":"",c=!!a.pluginConfig?.JellyseerrEnabled&&!e.settings.forceOnlyRequested,p=a.t?.("requests_requests")||"Requests",v=c?`<div class="je-calendar-legend-item ${t("Requests")}" onclick="window.JellyfinEnhanced.calendarPage.toggleFilter('Requests'); event.stopPropagation();">
          <span class="je-msym-rounded" style="color: #6f63f2; font-size: 18px;">download</span>
          <span>${p}</span>
        </div>`:"",u=e.settings.highlightFavorites?`<div class="je-calendar-legend-item ${t("Watchlist")}" onclick="window.JellyfinEnhanced.calendarPage.toggleFilter('Watchlist'); event.stopPropagation();">
          <span class="je-msym-rounded" style="color: #ffd700; font-size: 18px; font-variation-settings: 'FILL' 1;">bookmark</span>
          <span>${a.t("calendar_watchlist")}</span>
        </div>`:"",d=e.settings.highlightWatchedSeries?`<div class="je-calendar-legend-item ${t("Watched")}" onclick="window.JellyfinEnhanced.calendarPage.toggleFilter('Watched'); event.stopPropagation();">
          <span class="je-msym-rounded" style="color: #64b5f6; font-size: 18px;">visibility</span>
          <span>${a.t("calendar_watched")}</span>
        </div>`:"",i=e.activeFilters.size>=2,m=`<div class="je-calendar-legend-item je-calendar-unmonitored-toggle ${e.settings.showUnmonitored?"active":n?"inactive":""}" onclick="window.JellyfinEnhanced.calendarPage.toggleShowUnmonitored(); event.stopPropagation();" style="cursor: pointer;">
        <span class="je-msym-rounded" style="color: #ff9800; font-size: 18px;">${e.settings.showUnmonitored?"visibility":"visibility_off"}</span>
        <span>${a.t?.("calendar_include_unmonitored")||"Unmonitored"}</span>
      </div>`,r=`<div class="je-calendar-legend-item ${e.settings.collapseEpisodes?"active":""}" onclick="window.JellyfinEnhanced.calendarPage.toggleCollapseEpisodes(); event.stopPropagation();" style="cursor: pointer;">
        <span class="je-msym-rounded" style="font-size: 18px;">${e.settings.collapseEpisodes?"unfold_less":"unfold_more"}</span>
        <span>${a.t("calendar_collapse_episodes")}</span>
      </div>`,s=`
      <div class="je-calendar-filter-controls">
        <div class="je-calendar-filter-toggle ${i?"":"is-disabled"}" role="group" aria-label="Filter mode">
          <button type="button" class="je-calendar-filter-btn ${e.filterMatchMode==="any"?"active":""}" data-filter-mode="any" ${i?"":'disabled aria-disabled="true"'}>${a.t("calendar_filter_any")}</button>
          <button type="button" class="je-calendar-filter-btn ${e.filterMatchMode==="all"?"active":""}" data-filter-mode="all" ${i?"":'disabled aria-disabled="true"'}>${a.t("calendar_filter_all")}</button>
        </div>
        <button type="button" class="je-calendar-filter-invert ${e.filterInvert?"active":""} ${n?"":"is-disabled"}" data-filter-invert="true" ${n?"":'disabled aria-disabled="true"'}>${a.t("calendar_filter_not")}</button>
      </div>`,g=a.pluginConfig?.ShokoConfigured?`<div class="je-calendar-legend-item ${t("Anime")}" onclick="window.JellyfinEnhanced.calendarPage.toggleFilter('Anime'); event.stopPropagation();">
          <span class="je-msym-rounded" style="color: ${f.Anime}; font-size: 18px;">animation</span>
          <span>${a.t("calendar_anime")}</span>
        </div>`:"";return`
      <div class="je-calendar-legend">
        ${s}
        <div class="je-calendar-legend-item ${t("CinemaRelease")}" onclick="window.JellyfinEnhanced.calendarPage.toggleFilter('CinemaRelease'); event.stopPropagation();">
          <span class="je-msym-rounded" style="color: ${f.CinemaRelease}; font-size: 18px;">local_movies</span>
          <span>${a.t("calendar_cinema_release")}</span>
        </div>
        <div class="je-calendar-legend-item ${t("DigitalRelease")}" onclick="window.JellyfinEnhanced.calendarPage.toggleFilter('DigitalRelease'); event.stopPropagation();">
          <span class="je-msym-rounded" style="color: ${f.DigitalRelease}; font-size: 18px;">ondemand_video</span>
          <span>${a.t("calendar_digital_release")}</span>
        </div>
        <div class="je-calendar-legend-item ${t("PhysicalRelease")}" onclick="window.JellyfinEnhanced.calendarPage.toggleFilter('PhysicalRelease'); event.stopPropagation();">
          <span class="je-msym-rounded" style="color: ${f.PhysicalRelease}; font-size: 18px;">album</span>
          <span>${a.t("calendar_physical_release")}</span>
        </div>
        <div class="je-calendar-legend-item ${t("Episode")}" onclick="window.JellyfinEnhanced.calendarPage.toggleFilter('Episode'); event.stopPropagation();">
          <span class="je-msym-rounded" style="color: ${f.Episode}; font-size: 18px;">tv_guide</span>
          <span>${a.t("calendar_episode")}</span>
        </div>
        ${g}
        <div class="je-calendar-legend-item ${t("Available")}" onclick="window.JellyfinEnhanced.calendarPage.toggleFilter('Available'); event.stopPropagation();">
          <span class="je-msym-rounded" style="color: #4caf50; font-size: 18px;">check_circle</span>
          <span>${a.t?.("jellyseerr_btn_available")||"Available"}</span>
        </div>
        ${v}
        ${u}
        ${d}
        ${m}
        ${r}
      </div>
    `}function _(){let n=document.getElementById("je-calendar-page");if(!n){n=document.createElement("div"),n.id="je-calendar-page",n.className="page type-interior mainAnimatedPage hide",n.setAttribute("data-title","Calendar"),n.setAttribute("data-backbutton","true"),n.setAttribute("data-url","#/calendar"),n.setAttribute("data-type","custom"),n.innerHTML=`
        <div data-role="content">
          <div class="content-primary je-calendar-page">
            <div id="je-calendar-container" style="padding-top: 5em; padding-left: 0.5em; padding-right: 0.5em;"></div>
          </div>
        </div>
      `;let t=document.querySelector(".mainAnimatedPages");t?t.appendChild(n):document.body.appendChild(n)}return n}function ee(n){T();let t;if(n)e._customTabContainer=n,t=n;else if(e._customTabContainer&&document.contains(e._customTabContainer)&&window.location.hash.indexOf("userpluginsettings")===-1)t=e._customTabContainer;else{e._customTabContainer=null;let c=_();if(t=document.getElementById("je-calendar-container"),!c||!t)return}typeof e.sidebarCollapsed!="boolean"&&(e.sidebarCollapsed=S()),t.innerHTML=`
      <div class="je-calendar-header">
        <h1 class="je-calendar-title">${H()}</h1>
        <div class="je-calendar-actions je-calendar-actions-center">
          <div class="je-calendar-nav">
            <div class="je-calendar-nav-group">
              <button class="je-calendar-nav-btn" onclick="window.JellyfinEnhanced.calendarPage.shiftPeriod('prev'); event.stopPropagation();" aria-label="${a.t?.("prev")||"Previous"}">‹</button>
              <button class="je-calendar-nav-btn je-calendar-nav-today" onclick="window.JellyfinEnhanced.calendarPage.goToday(); event.stopPropagation();">${a.t("calendar_today")}</button>
              <button class="je-calendar-nav-btn" onclick="window.JellyfinEnhanced.calendarPage.shiftPeriod('next'); event.stopPropagation();" aria-label="${a.t?.("next")||"Next"}">›</button>
            </div>
          </div>
        </div>
        <div class="je-calendar-actions je-calendar-actions-right">
          <div class="je-calendar-nav">
            <button class="je-calendar-view-btn ${e.viewMode==="day"?"active":""}" onclick="window.JellyfinEnhanced.calendarPage.setViewMode('day'); event.stopPropagation();">${a.t?.("calendar_day")||"Day"}</button>
            <button class="je-calendar-view-btn ${e.viewMode==="week"?"active":""}" onclick="window.JellyfinEnhanced.calendarPage.setViewMode('week'); event.stopPropagation();">${a.t("calendar_week")}</button>
            <button class="je-calendar-view-btn ${e.viewMode==="month"?"active":""}" onclick="window.JellyfinEnhanced.calendarPage.setViewMode('month'); event.stopPropagation();">${a.t("calendar_month")}</button>
            <button class="je-calendar-view-btn ${e.viewMode==="agenda"?"active":""}" onclick="window.JellyfinEnhanced.calendarPage.setViewMode('agenda'); event.stopPropagation();">${a.t("calendar_agenda")}</button>
            <div class="je-calendar-mode-toggle ${e.viewMode==="agenda"?"is-disabled":""}" role="group" aria-label="Display mode">
              <button type="button" class="je-calendar-mode-btn ${e.settings.displayMode==="list"?"active":""}" title="List" aria-label="List" data-mode="list" ${e.viewMode==="agenda"?'disabled aria-disabled="true"':""}>
                <span class="material-icons">view_list</span>
              </button>
              <button type="button" class="je-calendar-mode-btn ${e.settings.displayMode==="backdrop"?"active":""}" title="Backdrop" aria-label="Backdrop" data-mode="backdrop" ${e.viewMode==="agenda"?'disabled aria-disabled="true"':""}>
                <span class="material-icons">image</span>
              </button>
              <button type="button" class="je-calendar-mode-btn ${e.settings.displayMode==="cards"?"active":""}" title="Cards" aria-label="Cards" data-mode="cards" ${e.viewMode==="agenda"?'disabled aria-disabled="true"':""}>
                <span class="material-icons">view_module</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      ${e.isLoading?a.core.ui.skeletonGridHtml(7,{minWidth:"9em",height:"6em",label:a.t("calendar_loading")}):""}

        <div class="je-calendar-layout">
          <div class="je-calendar-main">
            ${e.isLoading?"":X()}
          </div>
          <aside class="je-calendar-sidebar${e.sidebarCollapsed?" is-collapsed":""}">
            <button type="button" class="je-calendar-sidebar-toggle" aria-expanded="${e.sidebarCollapsed?"false":"true"}" aria-controls="je-calendar-sidebar-content">
              <span class="material-icons je-calendar-sidebar-toggle-icon">expand_more</span>
            </button>
            <div class="je-calendar-sidebar-content" id="je-calendar-sidebar-content">
              ${Z().replace('je-calendar-legend"','je-calendar-legend je-calendar-legend-vertical"')}
            </div>
          </aside>
        </div>

      
    `,I()}function T(){let n=document.querySelectorAll(".je-calendar-page, .content-primary.je-calendar-page");n.length&&n.forEach(t=>{t.classList.remove("je-view-day","je-view-week","je-view-month","je-view-agenda"),t.classList.remove("je-display-list","je-display-backdrop","je-display-cards"),e.viewMode&&t.classList.add(`je-view-${e.viewMode}`),e.settings.displayMode&&t.classList.add(`je-display-${e.settings.displayMode}`)})}o.updateDisplayModeButtons=B,o.toggleSidebarCollapsed=U,o.renderPage=ee,o.syncPageModeClasses=T,o.createPageContainer=_})();})();
})();
