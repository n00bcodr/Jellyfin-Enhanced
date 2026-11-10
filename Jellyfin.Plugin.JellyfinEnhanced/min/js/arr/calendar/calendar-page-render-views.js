(() => {
"use strict";(()=>{function _(t){if(/^\d{4}-\d{2}-\d{2}$/.test(t)){let[y=0,o=0,e=0]=t.split("-").map(Number),f=new Date(y,o-1,e);return f.getFullYear()!==y||f.getMonth()!==o-1||f.getDate()!==e?new Date(NaN):f}return new Date(t)}function F(t){let y=window.JellyfinEnhanced?.core?.sharedModules?.[t];if(!y)throw new Error(`${t} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return y}function A(t,y){return t[y]}var ae=F("features/calendar/host"),O=A(ae,"calendarHost");(function(){"use strict";let{JE:t,ctx:y,P:o}=O(),e=o.state,f=o.STATUS_COLORS,j=o.filterEvents,$=o.groupEventsByDate,R=o.getRangeForView,L=o.getDaysInMonth,J=o.getFirstDayOfMonth,x=o.isTodayDate,q=o.formatRangeLabel,N=o.formatHourLabel,E=o.renderEvent,H=o.renderAgendaEvent,b=o.renderCardItems,C=o.compareEventsWithinDay,k=o.collapseEpisodes;function P(){return window.matchMedia?window.matchMedia("(max-width: 768px)").matches:!1}function D(){let n=document.querySelector(".je-calendar-sidebar"),a=document.querySelector(".je-calendar-sidebar-toggle");!n||!a||(n.classList.toggle("is-collapsed",!!e.sidebarCollapsed),a.setAttribute("aria-expanded",e.sidebarCollapsed?"false":"true"))}function W(n){e.sidebarCollapsed=!!n,D()}function z(){typeof e.sidebarCollapsed!="boolean"&&(e.sidebarCollapsed=P()),W(!e.sidebarCollapsed)}function V(){document.querySelectorAll(".je-calendar-mode-btn").forEach(a=>{let c=a.dataset.mode;a.classList.toggle("active",c===e.settings.displayMode)})}function U(){let n=new Date(e.currentDate);n.setHours(0,0,0,0),n.setDate(1);let a=L(n),c=J(n),p=j(e.events),v=y.peer("hiddenContent");v&&(p=v.filterCalendarEvents(p));let u=$(p);if(p.length===0)return`<div class="je-calendar-empty">${t.t("calendar_no_releases")}</div>`;let d=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"],i=d.indexOf(e.settings.firstDayOfWeek),m=[...d.slice(i),...d.slice(0,i)],r='<div class="je-calendar-month">';r+='<div class="je-calendar-weekdays">',m.forEach(s=>{r+=`<div class="je-calendar-weekday">${s.substring(0,3)}</div>`}),r+="</div>",r+='<div class="je-calendar-month-grid">';for(let s=0;s<c;s++)r+='<div class="je-calendar-day je-calendar-day-placeholder" style="opacity: 0.3;"></div>';for(let s=1;s<=a;s++){let g=n.getFullYear(),l=String(n.getMonth()+1).padStart(2,"0"),h=String(s).padStart(2,"0"),M=`${g}-${l}-${h}`,w=u[M]||[];w.sort(C),w=k(w);let T=new Date(g,n.getMonth(),s),Z=x(T)?" je-calendar-today":"",ee=(d[T.getDay()]||"").substring(0,3);r+=`
        <div class="je-calendar-day${Z}">
          <div class="je-calendar-day-header">
            <span class="je-calendar-day-number">${s}</span>
            <span class="je-calendar-month-day-name">${ee}</span>
          </div>
          <div class="${e.settings.displayMode==="cards"?"je-calendar-day-cards":"je-calendar-events-list"}">
            ${e.settings.displayMode==="cards"?b(w):w.map(ne=>E(ne)).join("")}
          </div>
        </div>
      `}return r+="</div></div>",r}function B(){let{start:n}=R(e.currentDate,"week"),a=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"],c=j(e.events),p=y.peer("hiddenContent");p&&(c=p.filterCalendarEvents(c));let v=$(c);if(c.length===0)return`<div class="je-calendar-empty">${t.t("calendar_no_releases")}</div>`;let u='<div class="je-calendar-grid">';for(let d=0;d<7;d++){let i=new Date(n);i.setDate(n.getDate()+d);let m=i.getFullYear(),r=String(i.getMonth()+1).padStart(2,"0"),s=String(i.getDate()).padStart(2,"0"),g=`${m}-${r}-${s}`,l=v[g]||[];l.sort(C),l=k(l);let h=x(i)?" je-calendar-today":"";u+=`
        <div class="je-calendar-day${h}">
          <div class="je-calendar-day-header">
            <span class="je-calendar-day-number">${i.getDate()}</span>
            <span class="je-calendar-day-name">${(a[i.getDay()]||"").substring(0,3)}</span>
          </div>
          <div class="${e.settings.displayMode==="cards"?"je-calendar-day-cards":"je-calendar-events-list"}">
            ${e.settings.displayMode==="cards"?b(l):l.map(M=>E(M)).join("")}
          </div>
        </div>
      `}return u+="</div>",u}function K(){let n=j(e.events),a=y.peer("hiddenContent");a&&(n=a.filterCalendarEvents(n));let c=$(n),p=Object.keys(c).sort();if(p.length===0)return`<div class="je-calendar-empty">${t.t("calendar_no_releases")}</div>`;let v='<div class="je-calendar-agenda">';return p.forEach(u=>{let[d="0",i="1",m="1"]=u.split("-"),r=new Date(parseInt(d),parseInt(i)-1,parseInt(m)),s=r.toLocaleDateString(void 0,{weekday:"short"}),g=r.toLocaleDateString(void 0,{month:"short",day:"numeric"}),l=c[u]||[];l.sort(C),l=k(l),v+=`
        <div class="je-calendar-agenda-row">
          <div class="je-calendar-agenda-date">
            <div>${s}, ${g}</div>
          </div>
          <div class="je-calendar-agenda-events">
            ${l.map(h=>H(h)).join("")}
          </div>
        </div>
      `}),v+="</div>",v}function Y(){let n=j(e.events),a=y.peer("hiddenContent");a&&(n=a.filterCalendarEvents(n));let c=$(n),p=new Date(e.currentDate),v=`${p.getFullYear()}-${String(p.getMonth()+1).padStart(2,"0")}-${String(p.getDate()).padStart(2,"0")}`,u=c[v]||[];if(u.sort(C),u=k(u),u.length===0)return`<div class="je-calendar-empty">${t.t("calendar_no_releases")}</div>`;if(e.settings.displayMode==="cards")return`
        <div class="je-calendar-dayline je-calendar-day-cards">
          ${b(u)}
        </div>
      `;let d={allDay:[],hours:new Map};u.forEach(r=>{let s=_(r.releaseDate);if(Number.isNaN(s.getTime())){d.allDay.push(r);return}if(!!(s.getHours()===0&&s.getMinutes()===0)){d.allDay.push(r);return}let l=s.getHours();d.hours.has(l)||d.hours.set(l,[]),d.hours.get(l)?.push(r)});let i='<div class="je-calendar-day-hours">';for(let r=0;r<24;r+=1){let s=d.hours.get(r);if(!s||s.length===0)continue;let g=e.settings.displayMode==="cards"?"je-calendar-hour-events je-calendar-day-cards":"je-calendar-hour-events";i+=`
        <div class="je-calendar-hour-row">
          <div class="je-calendar-hour-label">${N(r)}</div>
          <div class="${g}">
            ${e.settings.displayMode==="cards"?b(s):s.map(l=>E(l)).join("")}
          </div>
        </div>
      `}let m=t.t?.("calendar_all_day")||"All day";if(d.allDay.length){let r=d.allDay,s=e.settings.displayMode==="cards"?"je-calendar-hour-events je-calendar-day-cards":"je-calendar-hour-events";i+=`
        <div class="je-calendar-hour-row">
          <div class="je-calendar-hour-label">${m}</div>
          <div class="${s}">
            ${e.settings.displayMode==="cards"?b(r):r.map(g=>E(g)).join("")}
          </div>
        </div>
      `}return i+="</div>",i}function G(){return e.error&&!e.events.length||e.requestError&&(e.settings.forceOnlyRequested||e.activeFilters.has("Requests"))?`<div class="je-calendar-error" role="alert">${t.escapeHtml(e.error||e.requestError||"")}<button onclick="window.JellyfinEnhanced.calendarPage.refresh()">Retry</button></div>`:e.viewMode==="week"?B():e.viewMode==="agenda"?K():e.viewMode==="day"?Y():U()}function Q(){let n=e.activeFilters.size>0,a=l=>n?e.activeFilters.has(l)?"active":"inactive":"",c=!!t.pluginConfig?.JellyseerrEnabled&&!e.settings.forceOnlyRequested,p=t.t?.("requests_requests")||"Requests",v=c?`<div class="je-calendar-legend-item ${a("Requests")}" onclick="window.JellyfinEnhanced.calendarPage.toggleFilter('Requests'); event.stopPropagation();">
          <span class="je-msym-rounded" style="color: #6f63f2; font-size: 18px;">download</span>
          <span>${p}</span>
        </div>`:"",u=e.settings.highlightFavorites?`<div class="je-calendar-legend-item ${a("Watchlist")}" onclick="window.JellyfinEnhanced.calendarPage.toggleFilter('Watchlist'); event.stopPropagation();">
          <span class="je-msym-rounded" style="color: #ffd700; font-size: 18px; font-variation-settings: 'FILL' 1;">bookmark</span>
          <span>${t.t("calendar_watchlist")}</span>
        </div>`:"",d=e.settings.highlightWatchedSeries?`<div class="je-calendar-legend-item ${a("Watched")}" onclick="window.JellyfinEnhanced.calendarPage.toggleFilter('Watched'); event.stopPropagation();">
          <span class="je-msym-rounded" style="color: #64b5f6; font-size: 18px;">visibility</span>
          <span>${t.t("calendar_watched")}</span>
        </div>`:"",i=e.activeFilters.size>=2,m=`<div class="je-calendar-legend-item je-calendar-unmonitored-toggle ${e.settings.showUnmonitored?"active":n?"inactive":""}" onclick="window.JellyfinEnhanced.calendarPage.toggleShowUnmonitored(); event.stopPropagation();" style="cursor: pointer;">
        <span class="je-msym-rounded" style="color: #ff9800; font-size: 18px;">${e.settings.showUnmonitored?"visibility":"visibility_off"}</span>
        <span>${t.t?.("calendar_include_unmonitored")||"Unmonitored"}</span>
      </div>`,r=`<div class="je-calendar-legend-item ${e.settings.collapseEpisodes?"active":""}" onclick="window.JellyfinEnhanced.calendarPage.toggleCollapseEpisodes(); event.stopPropagation();" style="cursor: pointer;">
        <span class="je-msym-rounded" style="font-size: 18px;">${e.settings.collapseEpisodes?"unfold_less":"unfold_more"}</span>
        <span>${t.t("calendar_collapse_episodes")}</span>
      </div>`,s=`
      <div class="je-calendar-filter-controls">
        <div class="je-calendar-filter-toggle ${i?"":"is-disabled"}" role="group" aria-label="Filter mode">
          <button type="button" class="je-calendar-filter-btn ${e.filterMatchMode==="any"?"active":""}" data-filter-mode="any" ${i?"":'disabled aria-disabled="true"'}>OR</button>
          <button type="button" class="je-calendar-filter-btn ${e.filterMatchMode==="all"?"active":""}" data-filter-mode="all" ${i?"":'disabled aria-disabled="true"'}>AND</button>
        </div>
        <button type="button" class="je-calendar-filter-invert ${e.filterInvert?"active":""} ${n?"":"is-disabled"}" data-filter-invert="true" ${n?"":'disabled aria-disabled="true"'}>NOT</button>
      </div>`,g=t.pluginConfig?.ShokoConfigured?`<div class="je-calendar-legend-item ${a("Anime")}" onclick="window.JellyfinEnhanced.calendarPage.toggleFilter('Anime'); event.stopPropagation();">
          <span class="je-msym-rounded" style="color: ${f.Anime}; font-size: 18px;">animation</span>
          <span>${t.t("calendar_anime")}</span>
        </div>`:"";return`
      <div class="je-calendar-legend">
        ${s}
        <div class="je-calendar-legend-item ${a("CinemaRelease")}" onclick="window.JellyfinEnhanced.calendarPage.toggleFilter('CinemaRelease'); event.stopPropagation();">
          <span class="je-msym-rounded" style="color: ${f.CinemaRelease}; font-size: 18px;">local_movies</span>
          <span>${t.t("calendar_cinema_release")}</span>
        </div>
        <div class="je-calendar-legend-item ${a("DigitalRelease")}" onclick="window.JellyfinEnhanced.calendarPage.toggleFilter('DigitalRelease'); event.stopPropagation();">
          <span class="je-msym-rounded" style="color: ${f.DigitalRelease}; font-size: 18px;">ondemand_video</span>
          <span>${t.t("calendar_digital_release")}</span>
        </div>
        <div class="je-calendar-legend-item ${a("PhysicalRelease")}" onclick="window.JellyfinEnhanced.calendarPage.toggleFilter('PhysicalRelease'); event.stopPropagation();">
          <span class="je-msym-rounded" style="color: ${f.PhysicalRelease}; font-size: 18px;">album</span>
          <span>${t.t("calendar_physical_release")}</span>
        </div>
        <div class="je-calendar-legend-item ${a("Episode")}" onclick="window.JellyfinEnhanced.calendarPage.toggleFilter('Episode'); event.stopPropagation();">
          <span class="je-msym-rounded" style="color: ${f.Episode}; font-size: 18px;">tv_guide</span>
          <span>${t.t("calendar_episode")}</span>
        </div>
        ${g}
        <div class="je-calendar-legend-item ${a("Available")}" onclick="window.JellyfinEnhanced.calendarPage.toggleFilter('Available'); event.stopPropagation();">
          <span class="je-msym-rounded" style="color: #4caf50; font-size: 18px;">check_circle</span>
          <span>${t.t?.("jellyseerr_btn_available")||"Available"}</span>
        </div>
        ${v}
        ${u}
        ${d}
        ${m}
        ${r}
      </div>
    `}function S(){let n=document.getElementById("je-calendar-page");if(!n){n=document.createElement("div"),n.id="je-calendar-page",n.className="page type-interior mainAnimatedPage hide",n.setAttribute("data-title","Calendar"),n.setAttribute("data-backbutton","true"),n.setAttribute("data-url","#/calendar"),n.setAttribute("data-type","custom"),n.innerHTML=`
        <div data-role="content">
          <div class="content-primary je-calendar-page">
            <div id="je-calendar-container" style="padding-top: 5em; padding-left: 0.5em; padding-right: 0.5em;"></div>
          </div>
        </div>
      `;let a=document.querySelector(".mainAnimatedPages");a?a.appendChild(n):document.body.appendChild(n)}return n}function X(n){I();let a;if(n)e._customTabContainer=n,a=n;else if(e._customTabContainer&&document.contains(e._customTabContainer)&&window.location.hash.indexOf("userpluginsettings")===-1)a=e._customTabContainer;else{e._customTabContainer=null;let c=S();if(a=document.getElementById("je-calendar-container"),!c||!a)return}typeof e.sidebarCollapsed!="boolean"&&(e.sidebarCollapsed=P()),a.innerHTML=`
      <div class="je-calendar-header">
        <h1 class="je-calendar-title">${q()}</h1>
        <div class="je-calendar-actions je-calendar-actions-center">
          <div class="je-calendar-nav">
            <div class="je-calendar-nav-group">
              <button class="je-calendar-nav-btn" onclick="window.JellyfinEnhanced.calendarPage.shiftPeriod('prev'); event.stopPropagation();" aria-label="${t.t?.("prev")||"Previous"}">‹</button>
              <button class="je-calendar-nav-btn je-calendar-nav-today" onclick="window.JellyfinEnhanced.calendarPage.goToday(); event.stopPropagation();">${t.t("calendar_today")}</button>
              <button class="je-calendar-nav-btn" onclick="window.JellyfinEnhanced.calendarPage.shiftPeriod('next'); event.stopPropagation();" aria-label="${t.t?.("next")||"Next"}">›</button>
            </div>
          </div>
        </div>
        <div class="je-calendar-actions je-calendar-actions-right">
          <div class="je-calendar-nav">
            <button class="je-calendar-view-btn ${e.viewMode==="day"?"active":""}" onclick="window.JellyfinEnhanced.calendarPage.setViewMode('day'); event.stopPropagation();">${t.t?.("calendar_day")||"Day"}</button>
            <button class="je-calendar-view-btn ${e.viewMode==="week"?"active":""}" onclick="window.JellyfinEnhanced.calendarPage.setViewMode('week'); event.stopPropagation();">${t.t("calendar_week")}</button>
            <button class="je-calendar-view-btn ${e.viewMode==="month"?"active":""}" onclick="window.JellyfinEnhanced.calendarPage.setViewMode('month'); event.stopPropagation();">${t.t("calendar_month")}</button>
            <button class="je-calendar-view-btn ${e.viewMode==="agenda"?"active":""}" onclick="window.JellyfinEnhanced.calendarPage.setViewMode('agenda'); event.stopPropagation();">${t.t("calendar_agenda")}</button>
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

      ${e.isLoading?t.core.ui.skeletonGridHtml(7,{minWidth:"9em",height:"6em",label:t.t("calendar_loading")}):""}

        <div class="je-calendar-layout">
          <div class="je-calendar-main">
            ${e.isLoading?"":G()}
          </div>
          <aside class="je-calendar-sidebar${e.sidebarCollapsed?" is-collapsed":""}">
            <button type="button" class="je-calendar-sidebar-toggle" aria-expanded="${e.sidebarCollapsed?"false":"true"}" aria-controls="je-calendar-sidebar-content">
              <span class="material-icons je-calendar-sidebar-toggle-icon">expand_more</span>
            </button>
            <div class="je-calendar-sidebar-content" id="je-calendar-sidebar-content">
              ${Q().replace('je-calendar-legend"','je-calendar-legend je-calendar-legend-vertical"')}
            </div>
          </aside>
        </div>

      
    `,D()}function I(){let n=document.querySelectorAll(".je-calendar-page, .content-primary.je-calendar-page");n.length&&n.forEach(a=>{a.classList.remove("je-view-day","je-view-week","je-view-month","je-view-agenda"),a.classList.remove("je-display-list","je-display-backdrop","je-display-cards"),e.viewMode&&a.classList.add(`je-view-${e.viewMode}`),e.settings.displayMode&&a.classList.add(`je-display-${e.settings.displayMode}`)})}o.updateDisplayModeButtons=V,o.toggleSidebarCollapsed=z,o.renderPage=X,o.syncPageModeClasses=I,o.createPageContainer=S})();})();
})();
