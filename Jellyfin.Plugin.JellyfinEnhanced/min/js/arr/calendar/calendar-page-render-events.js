(() => {
"use strict";(()=>{function $(s){if(/^\d{4}-\d{2}-\d{2}$/.test(s)){let[f=0,u=0,d=0]=s.split("-").map(Number),b=new Date(f,u-1,d);return b.getFullYear()!==f||b.getMonth()!==u-1||b.getDate()!==d?new Date(NaN):b}return new Date(s)}function U(s){let f=$(s);return`${f.getFullYear()}-${String(f.getMonth()+1).padStart(2,"0")}-${String(f.getDate()).padStart(2,"0")}`}function P(s){let f=window.JellyfinEnhanced?.core?.sharedModules?.[s];if(!f)throw new Error(`${s} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return f}function H(s,f){return s[f]}var ce=P("features/calendar/host"),W=H(ce,"calendarHost");(function(){"use strict";let{JE:s,host:f,P:u}=W(),d=u.state,b=u.STATUS_COLORS,i=s.escapeHtml,C=s.cdn.selfhst("svg/sonarr.svg"),v=s.cdn.selfhst("svg/radarr-light-hybrid-light.svg"),I=s.cdn.selfhst("svg/shoko-server.svg");function K(e,r){let t=new Date(e.getFullYear(),e.getMonth(),e.getDate(),0,0,0,0);if(r==="month"){t.setDate(1);let a=new Date(t.getFullYear(),t.getMonth()+1,0,23,59,59,999);return{start:t,end:a}}if(r==="week"){let o=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"].indexOf(d.settings.firstDayOfWeek),p=(t.getDay()-o+7)%7;t.setDate(t.getDate()-p);let c=new Date(t);return c.setDate(t.getDate()+6),c.setHours(23,59,59,999),{start:t,end:c}}if(r==="day"){let a=new Date(t);return a.setHours(23,59,59,999),{start:t,end:a}}let n=new Date(t);return n.setDate(t.getDate()+29),n.setHours(23,59,59,999),{start:t,end:n}}function Y(e){return new Date(e.getFullYear(),e.getMonth()+1,0).getDate()}function q(e){let t=new Date(e.getFullYear(),e.getMonth(),1).getDay(),a=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"].indexOf(d.settings.firstDayOfWeek);return(t-a+7)%7}function J(e){let r=new Date;return e.getFullYear()===r.getFullYear()&&e.getMonth()===r.getMonth()&&e.getDate()===r.getDate()}function S(e){let r={CinemaRelease:b.CinemaRelease,DigitalRelease:b.DigitalRelease,PhysicalRelease:b.PhysicalRelease,Episode:b.Episode,Anime:b.Anime},n=(s.themer?.getThemeVariables()||{}).primaryAccent||"#00a4dc";return r[e.releaseType]||n}function T(e){return e.releaseType==="CinemaRelease"?s.t("calendar_cinema_release"):e.releaseType==="DigitalRelease"?s.t("calendar_digital_release"):e.releaseType==="PhysicalRelease"?s.t("calendar_physical_release"):e.releaseType==="Episode"?s.t("calendar_episode"):e.releaseType==="Anime"?s.t("calendar_anime"):"Release"}function E(e){if(!e)return null;let r=$(e);if(Number.isNaN(r.getTime())||r.getHours()===0&&r.getMinutes()===0)return null;let t=d.settings.timeFormat==="5pm/5:30pm";return r.toLocaleTimeString([],{hour:"numeric",minute:"2-digit",hour12:t})}function V(){if(!d.rangeStart||!d.rangeEnd)return new Date(d.currentDate).toLocaleDateString(void 0,{month:"long",year:"numeric"});if(d.viewMode==="month")return new Date(d.currentDate).toLocaleDateString(void 0,{month:"long",year:"numeric"});let e=d.rangeStart.toLocaleDateString(void 0,{month:"short",day:"numeric"}),r=d.rangeEnd.toLocaleDateString(void 0,{month:"short",day:"numeric"});if(d.viewMode==="week")return`${e} - ${r}`;if(d.viewMode==="day"){let t=s.t?.("calendar_day")||"Day",n=z(d.rangeStart);return`${t} • ${n}`}return`${s.t("calendar_agenda")} • ${e} → ${r}`}function z(e){let r=new Date(e),t=new Date,n=new Date(t.getFullYear(),t.getMonth(),t.getDate()),a=new Date(r.getFullYear(),r.getMonth(),r.getDate()),o=Math.round((a.getTime()-n.getTime())/864e5);return o===0?s.t?.("calendar_today"):o===-1?s.t?.("calendar_yesterday"):o===1?s.t?.("calendar_tomorrow"):a.toLocaleDateString(void 0,{month:"short",day:"numeric"})}function B(e){let r=d.settings.timeFormat==="5pm/5:30pm";return new Date(2e3,0,1,e,0,0,0).toLocaleTimeString([],{hour:"numeric",minute:"2-digit",hour12:r})}function G(e){let r=e.title;return e.type==="Series"&&e.subtitle&&(r+=` ${e.subtitle}`),r}function x(e){let r=d.userDataMap?.get(e.id),t=s.t?.("calendar_watchlist")||"Watchlist",n=s.t?.("calendar_watched")||"Watched",a=[];return d.settings.highlightFavorites&&r?.isFavorite&&a.push(`<span class="je-calendar-status-icon je-status-watchlist je-msym-rounded" title="${t}" aria-label="${t}">bookmark</span>`),d.settings.highlightWatchedSeries&&r?.isWatched&&a.push(`<span class="je-calendar-status-icon je-status-watched je-msym-rounded" title="${n}" aria-label="${n}">visibility</span>`),a.length?`<span class="je-calendar-status-icons">${a.join("")}</span>`:""}function R(e){let r=e.instanceName||e.source;return!Array.isArray(e.alsoInInstances)||e.alsoInInstances.length===0?r:[r,...e.alsoInInstances].join(", ")}function Q(e){let r=E(e.releaseDate);if(!r)return"";let t=e.releaseDate?$(e.releaseDate):null,n=t&&!Number.isNaN(t.getTime())?t.getTime():null,a=Date.now(),o=n!==null&&n<=a,l=n!==null&&a-n>=1440*60*1e3,p=e.hasFile?"je-calendar-card-time is-available":l?"je-calendar-card-time is-late is-unavailable":o?"je-calendar-card-time is-past is-unavailable":"je-calendar-card-time is-unavailable",c=r?`<span class="je-calendar-card-time-label">${i(r)}</span>`:"";return`<div class="${p}">${c}</div>`}function X(e){let r=E(e.releaseDate);return r?`<span style="opacity: 0.85; font-size: 1em;">${i(r)}</span>`:""}function M(e){return encodeURI(e).replace(/'/g,"%27")}function Z(e){let r=[];return e&&e.split(`
`).forEach(t=>{let n=t.trim();if(!n)return;let a=n.split("|").map(o=>o.trim());a.length===2&&a[0]&&a[1]&&r.push({jellyfinUrl:a[0],arrUrl:a[1]})}),r}function ee(e,r){let t=f.ApiClient;if(!r)return null;if(!e||e.length===0)return r.replace(/\/$/,"");let a=(typeof t<"u"&&t.serverAddress?t.serverAddress():window.location.origin).replace(/\/+$/,"").toLowerCase();for(let o of e){let l=o.jellyfinUrl.replace(/\/+$/,"").toLowerCase();if(a===l)return o.arrUrl.replace(/\/$/,"")}return r.replace(/\/$/,"")}function re(e){if(e.source!=="Shoko"||!e.shokoSeriesId)return null;let r=ee(Z(s.pluginConfig?.ShokoUrlMappings||""),s.pluginConfig?.ShokoUrl);return r?`${r}/webui/collection/series/${e.shokoSeriesId}`:null}function k(e,r,t){let n=`<img src="${r}" alt="${i(e.type)}" class="${t}" />`,a=re(e);if(!a)return n;let o=s.t?.("calendar_open_in_shoko")||"Open in Shoko";return`<a href="${i(a)}" target="_blank" rel="noopener noreferrer" class="je-calendar-shoko-link" title="${i(o)}" aria-label="${i(o)}" onclick="event.stopPropagation();">${n}</a>`}function L(e){let r=f.ApiClient;if(e.source!=="Shoko"||typeof r>"u")return null;let t=e.itemId||e.itemEpisodeId;return t?r.getImageUrl(t,{type:"Primary",quality:90}):null}function N(e){return e.posterUrl||e.backdropUrl||L(e)}function O(e){return!!E(e.releaseDate)}function te(e,r){let t=O(e),n=O(r);return t!==n?t?-1:1:$(e.releaseDate).getTime()-$(r.releaseDate).getTime()}function ne(e,r){if(d.settings.displayMode!=="backdrop")return`background: ${r}20;`;let t=e.backdropUrl||L(e)||e.posterUrl;if(!t)return`background: ${r}20;`;let n="rgba(0, 0, 0, 0.6)",a=M(t);return`background-image: linear-gradient(${n}, ${n}), url('${a}'); background-size: cover; background-position: center; background-repeat: no-repeat;`}function ae(e){if(!d.settings.collapseEpisodes)return e;let r=o=>o.type==="Series"&&o.seasonNumber!=null&&o.episodeNumber!=null?`${o.title}|${o.seasonNumber}|${U(o.releaseDate)}`:null,t=new Map;e.forEach(o=>{let l=r(o);l&&t.set(l,[...t.get(l)||[],o])});let n=[],a=new Set;return e.forEach(o=>{let l=r(o),p=l&&t.get(l);if(!p||p.length<2){n.push(o);return}if(a.has(l))return;a.add(l);let c=[...p].sort((g,m)=>(g.episodeNumber??0)-(m.episodeNumber??0));if(d.expandedGroups.has(l))c.forEach((g,m)=>n.push(m===c.length-1?{...g,groupKey:l,groupExpanded:!0}:g));else{let g=c[0];g&&n.push({...g,groupKey:l,groupMembers:c})}}),n}function se(e){let r=t=>t.finaleType==="season"||t.finaleType==="series";return r(e)||!!e.groupMembers?.some(r)}function F(e,r){if(!se(e))return r;let t=s.t("calendar_finale");return r?`${r} • ${t}`:t}function A(e){let r=e.groupMembers;if(!r?.length)return e.subtitle||"";let t=n=>String(n).padStart(2,"0");return`S${t(e.seasonNumber)}E${t(r[0]?.episodeNumber)}-${t(r[r.length-1]?.episodeNumber)}`}function _(e){if(!e.groupKey)return"";let r=!!e.groupExpanded;return`<button class="je-calendar-group-toggle" data-group-key="${i(e.groupKey)}" aria-expanded="${r}"><span class="material-icons">${r?"expand_less":"expand_more"}</span></button>`}function oe(e){let r=S(e),t=T(e),n=e.source==="Shoko"?I:e.type==="Series"?C:v,a=R(e),o=i(a),l=e.source==="Sonarr"?"je-calendar-sonarr-icon":e.source==="Shoko"?"je-calendar-shoko-icon":"je-calendar-radarr-icon",p=F(e,e.groupMembers?A(e):e.subtitle),c=p?`<span class="je-calendar-event-subtitle">${i(p)}</span>`:"",g=e.hasFile?" je-has-file":"",m=G(e),h=d.settings.displayMode==="backdrop"&&N(e)?" je-has-backdrop":"",y=x(e),j=y?`<div class="je-calendar-event-status-top">${y}</div>`:"",w=X(e),D=e.hasFile&&!e.groupMembers?`<button class="je-calendar-play-btn" title="${s.t?.("jellyseerr_btn_available")}" aria-label="${s.t?.("jellyseerr_btn_available")}" data-event-id="${i(e.id)}"><span class="material-icons">play_arrow</span></button>`:"",de=ne(e,r);return`
      <div class="je-calendar-event${g}${h}" style="border-left-color: ${r}; ${de}" title="${i(m)}" data-event-id="${i(e.id)}">
        ${j}
        <span class="je-calendar-event-title">${i(e.title)}</span>
        ${c}
        <div class="je-calendar-event-type">
          ${k(e,n,l)}
          <span>${t} • <span class="je-arr-badge" title="${o}">${o}</span></span>
          ${w?` • ${w}`:""}${D}
        </div>
        ${_(e)}
      </div>
    `}function ie(e){let r=S(e),t=T(e),n=e.source==="Shoko"?I:e.type==="Series"?C:v,a=R(e),o=i(a),l=e.source==="Sonarr"?"je-sonarr-icon":e.source==="Shoko"?"je-shoko-icon":"je-radarr-icon",p=F(e,e.groupMembers?A(e):e.subtitle||""),c=E(e.releaseDate),g=e.hasFile?" je-has-file":"",m=[];e.hasFile&&!e.groupMembers&&m.push(`<button class="je-calendar-play-btn" title="${s.t("jellyseerr_btn_available")}" aria-label="${s.t("jellyseerr_btn_available")}" data-event-id="${i(e.id)}"><span class="material-icons">play_arrow</span></button>`);let h=x(e);h&&m.push(h);let y="movie";e.releaseType==="CinemaRelease"?y="local_movies":e.releaseType==="DigitalRelease"?y="ondemand_video":e.releaseType==="PhysicalRelease"?y="album":e.releaseType==="Episode"?y="tv_guide":e.releaseType==="Anime"&&(y="animation");let j=p?`<span class="je-calendar-agenda-subtitle">${i(p)}</span>`:"";return`
      <div class="je-calendar-agenda-event${g}" data-event-id="${i(e.id)}">
        <div class="je-calendar-agenda-indicators">
          ${m.join("")}
        </div>
        <span class="je-msym-rounded" style="font-size: 20px;">${y}</span>
        <div class="je-calendar-agenda-event-marker" style="background: ${r};"></div>
        <div class="je-calendar-agenda-event-content">
          <div class="je-calendar-agenda-event-title">
            <span class="je-calendar-agenda-title-text">${i(e.title)}</span>
            ${j}
          </div>
          <div class="je-calendar-agenda-event-meta">
            ${k(e,n,l)}
            <span>${t}</span>
            <span>•</span>
            <span class="je-arr-badge" title="${o}">${o}</span>
            ${c?`<span>• ${i(c)}</span>`:""}
          </div>
        </div>
        ${_(e)}
      </div>
    `}function le(e){return e.length?e.map(r=>{let t=N(r),n=T(r),a=r.source==="Shoko"?I:r.type==="Series"?C:v,o=R(r),l=i(o),p=r.source==="Sonarr"?"je-calendar-sonarr-icon":r.source==="Shoko"?"je-calendar-shoko-icon":"je-calendar-radarr-icon",c=x(r),g=Q(r),m=r.hasFile&&!r.groupMembers?`<button class="je-calendar-play-btn je-calendar-play-btn-card" title="${s.t?.("jellyseerr_btn_available")}" aria-label="${s.t?.("jellyseerr_btn_available")}" data-event-id="${i(r.id)}"><span class="material-icons">play_arrow</span></button>`:"",h=g||m?`<div class="je-calendar-card-time-row">${g}${m}</div>`:"",y=c?`<div class="je-calendar-card-status-top">${c}</div>`:"",j=S(r),w=F(r,r.groupMembers?A(r):r.subtitle),D=_(r);return t?`
          <div class="je-calendar-card" data-event-id="${i(r.id)}" style="border-bottom-color: ${j};">
            <div class="je-calendar-card-image-wrap">
              <img src="${M(t)}" alt="" class="je-calendar-card-image">
              ${y}
              ${D}
              <div class="je-calendar-card-overlay">
                ${h}
                <div class="je-calendar-card-title">
                  <span class="je-calendar-card-title-text">${i(r.title)}</span>
                </div>
                ${w?`<div class="je-calendar-card-subtitle">${i(w)}</div>`:'<div class="je-calendar-card-subtitle"></div>'}
                <div class="je-calendar-card-meta">
                  ${k(r,a,p)}
                  <span>${n}</span>
                  <span>•</span>
                  <span class="je-arr-badge" title="${l}">${l}</span>
                </div>
              </div>
            </div>
          </div>
        `:`
        <div class="je-calendar-card" data-event-id="${i(r.id)}" style="border-bottom-color: ${j};">
          ${y}
          ${D}
          ${h}
          <div class="je-calendar-card-title">
            <span class="je-calendar-card-title-text">${i(r.title)}</span>
          </div>
          ${w?`<div class="je-calendar-card-subtitle">${i(w)}</div>`:'<div class="je-calendar-card-subtitle"></div>'}
          <div class="je-calendar-card-meta">
            ${k(r,a,p)}
            <span>${n}</span>
            <span>•</span>
            <span class="je-arr-badge" title="${l}">${l}</span>
          </div>
        </div>
      `}).join(""):""}u.getRangeForView=K,u.getDaysInMonth=Y,u.getFirstDayOfMonth=q,u.isTodayDate=J,u.formatRangeLabel=V,u.formatHourLabel=B,u.renderEvent=oe,u.renderAgendaEvent=ie,u.renderCardItems=le,u.collapseEpisodes=ae,u.eventHasTime=O,u.compareEventsWithinDay=te})();})();
})();
