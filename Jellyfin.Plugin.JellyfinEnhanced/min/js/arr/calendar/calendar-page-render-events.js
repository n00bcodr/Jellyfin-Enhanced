(() => {
"use strict";(()=>{function j(s){if(/^\d{4}-\d{2}-\d{2}$/.test(s)){let[f=0,d=0,c=0]=s.split("-").map(Number),b=new Date(f,d-1,c);return b.getFullYear()!==f||b.getMonth()!==d-1||b.getDate()!==c?new Date(NaN):b}return new Date(s)}function P(s){let f=j(s);return`${f.getFullYear()}-${String(f.getMonth()+1).padStart(2,"0")}-${String(f.getDate()).padStart(2,"0")}`}function H(s){let f=window.JellyfinEnhanced?.core?.sharedModules?.[s];if(!f)throw new Error(`${s} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return f}function W(s,f){return s[f]}var ue=H("features/calendar/host"),K=W(ue,"calendarHost");(function(){"use strict";let{JE:s,host:f,P:d}=K(),c=d.state,b=d.STATUS_COLORS,i=s.escapeHtml,h=()=>s.core.mediaLanguage?.uiLocale?.()||void 0,v=s.cdn.selfhst("svg/sonarr.svg"),I=s.cdn.selfhst("svg/radarr-light-hybrid-light.svg"),S=s.cdn.selfhst("svg/shoko-server.svg");function Y(e,r){let t=new Date(e.getFullYear(),e.getMonth(),e.getDate(),0,0,0,0);if(r==="month"){t.setDate(1);let a=new Date(t.getFullYear(),t.getMonth()+1,0,23,59,59,999);return{start:t,end:a}}if(r==="week"){let o=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"].indexOf(c.settings.firstDayOfWeek),p=(t.getDay()-o+7)%7;t.setDate(t.getDate()-p);let u=new Date(t);return u.setDate(t.getDate()+6),u.setHours(23,59,59,999),{start:t,end:u}}if(r==="day"){let a=new Date(t);return a.setHours(23,59,59,999),{start:t,end:a}}let n=new Date(t);return n.setDate(t.getDate()+29),n.setHours(23,59,59,999),{start:t,end:n}}function q(e){return new Date(e.getFullYear(),e.getMonth()+1,0).getDate()}function J(e){let t=new Date(e.getFullYear(),e.getMonth(),1).getDay(),a=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"].indexOf(c.settings.firstDayOfWeek);return(t-a+7)%7}function V(e){let r=new Date;return e.getFullYear()===r.getFullYear()&&e.getMonth()===r.getMonth()&&e.getDate()===r.getDate()}function T(e){let r={CinemaRelease:b.CinemaRelease,DigitalRelease:b.DigitalRelease,PhysicalRelease:b.PhysicalRelease,Episode:b.Episode,Anime:b.Anime},n=(s.themer?.getThemeVariables()||{}).primaryAccent||"#00a4dc";return r[e.releaseType]||n}function x(e){return e.releaseType==="CinemaRelease"?s.t("calendar_cinema_release"):e.releaseType==="DigitalRelease"?s.t("calendar_digital_release"):e.releaseType==="PhysicalRelease"?s.t("calendar_physical_release"):e.releaseType==="Episode"?s.t("calendar_episode"):e.releaseType==="Anime"?s.t("calendar_anime"):"Release"}function k(e){if(!e)return null;let r=j(e);if(Number.isNaN(r.getTime())||r.getHours()===0&&r.getMinutes()===0)return null;let t=c.settings.timeFormat==="5pm/5:30pm";return r.toLocaleTimeString(h(),{hour:"numeric",minute:"2-digit",hour12:t})}function z(){if(!c.rangeStart||!c.rangeEnd)return new Date(c.currentDate).toLocaleDateString(h(),{month:"long",year:"numeric"});if(c.viewMode==="month")return new Date(c.currentDate).toLocaleDateString(h(),{month:"long",year:"numeric"});let e=c.rangeStart.toLocaleDateString(h(),{month:"short",day:"numeric"}),r=c.rangeEnd.toLocaleDateString(h(),{month:"short",day:"numeric"});if(c.viewMode==="week")return`${e} - ${r}`;if(c.viewMode==="day"){let t=s.t?.("calendar_day")||"Day",n=B(c.rangeStart);return`${t} • ${n}`}return`${s.t("calendar_agenda")} • ${e} → ${r}`}function B(e){let r=new Date(e),t=new Date,n=new Date(t.getFullYear(),t.getMonth(),t.getDate()),a=new Date(r.getFullYear(),r.getMonth(),r.getDate()),o=Math.round((a.getTime()-n.getTime())/864e5);return o===0?s.t?.("calendar_today"):o===-1?s.t?.("calendar_yesterday"):o===1?s.t?.("calendar_tomorrow"):a.toLocaleDateString(h(),{month:"short",day:"numeric"})}function G(e){let r=c.settings.timeFormat==="5pm/5:30pm";return new Date(2e3,0,1,e,0,0,0).toLocaleTimeString(h(),{hour:"numeric",minute:"2-digit",hour12:r})}function Q(e){let r=e.title;return e.type==="Series"&&e.subtitle&&(r+=` ${e.subtitle}`),r}function R(e){let r=c.userDataMap?.get(e.id),t=s.t?.("calendar_watchlist")||"Watchlist",n=s.t?.("calendar_watched")||"Watched",a=[];return c.settings.highlightFavorites&&r?.isFavorite&&a.push(`<span class="je-calendar-status-icon je-status-watchlist je-msym-rounded" title="${t}" aria-label="${t}">bookmark</span>`),c.settings.highlightWatchedSeries&&r?.isWatched&&a.push(`<span class="je-calendar-status-icon je-status-watched je-msym-rounded" title="${n}" aria-label="${n}">visibility</span>`),a.length?`<span class="je-calendar-status-icons">${a.join("")}</span>`:""}function O(e){let r=e.instanceName||e.source;return!Array.isArray(e.alsoInInstances)||e.alsoInInstances.length===0?r:[r,...e.alsoInInstances].join(", ")}function X(e){let r=k(e.releaseDate);if(!r)return"";let t=e.releaseDate?j(e.releaseDate):null,n=t&&!Number.isNaN(t.getTime())?t.getTime():null,a=Date.now(),o=n!==null&&n<=a,l=n!==null&&a-n>=1440*60*1e3,p=e.hasFile?"je-calendar-card-time is-available":l?"je-calendar-card-time is-late is-unavailable":o?"je-calendar-card-time is-past is-unavailable":"je-calendar-card-time is-unavailable",u=r?`<span class="je-calendar-card-time-label">${i(r)}</span>`:"";return`<div class="${p}">${u}</div>`}function Z(e){let r=k(e.releaseDate);return r?`<span style="opacity: 0.85; font-size: 1em;">${i(r)}</span>`:""}function L(e){return encodeURI(e).replace(/'/g,"%27")}function ee(e){let r=[];return e&&e.split(`
`).forEach(t=>{let n=t.trim();if(!n)return;let a=n.split("|").map(o=>o.trim());a.length===2&&a[0]&&a[1]&&r.push({jellyfinUrl:a[0],arrUrl:a[1]})}),r}function re(e,r){let t=f.ApiClient;if(!r)return null;if(!e||e.length===0)return r.replace(/\/$/,"");let a=(typeof t<"u"&&t.serverAddress?t.serverAddress():window.location.origin).replace(/\/+$/,"").toLowerCase();for(let o of e){let l=o.jellyfinUrl.replace(/\/+$/,"").toLowerCase();if(a===l)return o.arrUrl.replace(/\/$/,"")}return r.replace(/\/$/,"")}function te(e){if(e.source!=="Shoko"||!e.shokoSeriesId)return null;let r=re(ee(s.pluginConfig?.ShokoUrlMappings||""),s.pluginConfig?.ShokoUrl);return r?`${r}/webui/collection/series/${e.shokoSeriesId}`:null}function D(e,r,t){let n=`<img src="${r}" alt="${i(e.type)}" class="${t}" />`,a=te(e);if(!a)return n;let o=s.t?.("calendar_open_in_shoko")||"Open in Shoko";return`<a href="${i(a)}" target="_blank" rel="noopener noreferrer" class="je-calendar-shoko-link" title="${i(o)}" aria-label="${i(o)}" onclick="event.stopPropagation();">${n}</a>`}function N(e){let r=f.ApiClient;if(e.source!=="Shoko"||typeof r>"u")return null;let t=e.itemId||e.itemEpisodeId;return t?r.getImageUrl(t,{type:"Primary",quality:90}):null}function U(e){return e.posterUrl||e.backdropUrl||N(e)}function F(e){return!!k(e.releaseDate)}function ne(e,r){let t=F(e),n=F(r);return t!==n?t?-1:1:j(e.releaseDate).getTime()-j(r.releaseDate).getTime()}function ae(e,r){if(c.settings.displayMode!=="backdrop")return`background: ${r}20;`;let t=e.backdropUrl||N(e)||e.posterUrl;if(!t)return`background: ${r}20;`;let n="rgba(0, 0, 0, 0.6)",a=L(t);return`background-image: linear-gradient(${n}, ${n}), url('${a}'); background-size: cover; background-position: center; background-repeat: no-repeat;`}function se(e){if(!c.settings.collapseEpisodes)return e;let r=o=>o.type==="Series"&&o.seasonNumber!=null&&o.episodeNumber!=null?`${o.title}|${o.seasonNumber}|${P(o.releaseDate)}`:null,t=new Map;e.forEach(o=>{let l=r(o);l&&t.set(l,[...t.get(l)||[],o])});let n=[],a=new Set;return e.forEach(o=>{let l=r(o),p=l&&t.get(l);if(!p||p.length<2){n.push(o);return}if(a.has(l))return;a.add(l);let u=[...p].sort((g,m)=>(g.episodeNumber??0)-(m.episodeNumber??0));if(c.expandedGroups.has(l))u.forEach((g,m)=>n.push(m===u.length-1?{...g,groupKey:l,groupExpanded:!0}:g));else{let g=u[0];g&&n.push({...g,groupKey:l,groupMembers:u})}}),n}function oe(e){let r=t=>t.finaleType==="season"||t.finaleType==="series";return r(e)||!!e.groupMembers?.some(r)}function A(e,r){if(!oe(e))return r;let t=s.t("calendar_finale");return r?`${r} • ${t}`:t}function _(e){let r=e.groupMembers;if(!r?.length)return e.subtitle||"";let t=n=>String(n).padStart(2,"0");return`S${t(e.seasonNumber)}E${t(r[0]?.episodeNumber)}-${t(r[r.length-1]?.episodeNumber)}`}function M(e){if(!e.groupKey)return"";let r=!!e.groupExpanded;return`<button class="je-calendar-group-toggle" data-group-key="${i(e.groupKey)}" aria-expanded="${r}"><span class="material-icons">${r?"expand_less":"expand_more"}</span></button>`}function ie(e){let r=T(e),t=x(e),n=e.source==="Shoko"?S:e.type==="Series"?v:I,a=O(e),o=i(a),l=e.source==="Sonarr"?"je-calendar-sonarr-icon":e.source==="Shoko"?"je-calendar-shoko-icon":"je-calendar-radarr-icon",p=A(e,e.groupMembers?_(e):e.subtitle),u=p?`<span class="je-calendar-event-subtitle">${i(p)}</span>`:"",g=e.hasFile?" je-has-file":"",m=Q(e),w=c.settings.displayMode==="backdrop"&&U(e)?" je-has-backdrop":"",y=R(e),E=y?`<div class="je-calendar-event-status-top">${y}</div>`:"",$=Z(e),C=e.hasFile&&!e.groupMembers?`<button class="je-calendar-play-btn" title="${s.t?.("jellyseerr_btn_available")}" aria-label="${s.t?.("jellyseerr_btn_available")}" data-event-id="${i(e.id)}"><span class="material-icons">play_arrow</span></button>`:"",de=ae(e,r);return`
      <div class="je-calendar-event${g}${w}" style="border-left-color: ${r}; ${de}" title="${i(m)}" data-event-id="${i(e.id)}">
        ${E}
        <span class="je-calendar-event-title">${i(e.title)}</span>
        ${u}
        <div class="je-calendar-event-type">
          ${D(e,n,l)}
          <span>${t} • <span class="je-arr-badge" title="${o}">${o}</span></span>
          ${$?` • ${$}`:""}${C}
        </div>
        ${M(e)}
      </div>
    `}function le(e){let r=T(e),t=x(e),n=e.source==="Shoko"?S:e.type==="Series"?v:I,a=O(e),o=i(a),l=e.source==="Sonarr"?"je-sonarr-icon":e.source==="Shoko"?"je-shoko-icon":"je-radarr-icon",p=A(e,e.groupMembers?_(e):e.subtitle||""),u=k(e.releaseDate),g=e.hasFile?" je-has-file":"",m=[];e.hasFile&&!e.groupMembers&&m.push(`<button class="je-calendar-play-btn" title="${s.t("jellyseerr_btn_available")}" aria-label="${s.t("jellyseerr_btn_available")}" data-event-id="${i(e.id)}"><span class="material-icons">play_arrow</span></button>`);let w=R(e);w&&m.push(w);let y="movie";e.releaseType==="CinemaRelease"?y="local_movies":e.releaseType==="DigitalRelease"?y="ondemand_video":e.releaseType==="PhysicalRelease"?y="album":e.releaseType==="Episode"?y="tv_guide":e.releaseType==="Anime"&&(y="animation");let E=p?`<span class="je-calendar-agenda-subtitle">${i(p)}</span>`:"";return`
      <div class="je-calendar-agenda-event${g}" data-event-id="${i(e.id)}">
        <div class="je-calendar-agenda-indicators">
          ${m.join("")}
        </div>
        <span class="je-msym-rounded" style="font-size: 20px;">${y}</span>
        <div class="je-calendar-agenda-event-marker" style="background: ${r};"></div>
        <div class="je-calendar-agenda-event-content">
          <div class="je-calendar-agenda-event-title">
            <span class="je-calendar-agenda-title-text">${i(e.title)}</span>
            ${E}
          </div>
          <div class="je-calendar-agenda-event-meta">
            ${D(e,n,l)}
            <span>${t}</span>
            <span>•</span>
            <span class="je-arr-badge" title="${o}">${o}</span>
            ${u?`<span>• ${i(u)}</span>`:""}
          </div>
        </div>
        ${M(e)}
      </div>
    `}function ce(e){return e.length?e.map(r=>{let t=U(r),n=x(r),a=r.source==="Shoko"?S:r.type==="Series"?v:I,o=O(r),l=i(o),p=r.source==="Sonarr"?"je-calendar-sonarr-icon":r.source==="Shoko"?"je-calendar-shoko-icon":"je-calendar-radarr-icon",u=R(r),g=X(r),m=r.hasFile&&!r.groupMembers?`<button class="je-calendar-play-btn je-calendar-play-btn-card" title="${s.t?.("jellyseerr_btn_available")}" aria-label="${s.t?.("jellyseerr_btn_available")}" data-event-id="${i(r.id)}"><span class="material-icons">play_arrow</span></button>`:"",w=g||m?`<div class="je-calendar-card-time-row">${g}${m}</div>`:"",y=u?`<div class="je-calendar-card-status-top">${u}</div>`:"",E=T(r),$=A(r,r.groupMembers?_(r):r.subtitle),C=M(r);return t?`
          <div class="je-calendar-card" data-event-id="${i(r.id)}" style="border-bottom-color: ${E};">
            <div class="je-calendar-card-image-wrap">
              <img src="${L(t)}" alt="" class="je-calendar-card-image">
              ${y}
              ${C}
              <div class="je-calendar-card-overlay">
                ${w}
                <div class="je-calendar-card-title">
                  <span class="je-calendar-card-title-text">${i(r.title)}</span>
                </div>
                ${$?`<div class="je-calendar-card-subtitle">${i($)}</div>`:'<div class="je-calendar-card-subtitle"></div>'}
                <div class="je-calendar-card-meta">
                  ${D(r,a,p)}
                  <span>${n}</span>
                  <span>•</span>
                  <span class="je-arr-badge" title="${l}">${l}</span>
                </div>
              </div>
            </div>
          </div>
        `:`
        <div class="je-calendar-card" data-event-id="${i(r.id)}" style="border-bottom-color: ${E};">
          ${y}
          ${C}
          ${w}
          <div class="je-calendar-card-title">
            <span class="je-calendar-card-title-text">${i(r.title)}</span>
          </div>
          ${$?`<div class="je-calendar-card-subtitle">${i($)}</div>`:'<div class="je-calendar-card-subtitle"></div>'}
          <div class="je-calendar-card-meta">
            ${D(r,a,p)}
            <span>${n}</span>
            <span>•</span>
            <span class="je-arr-badge" title="${l}">${l}</span>
          </div>
        </div>
      `}).join(""):""}d.getRangeForView=Y,d.getDaysInMonth=q,d.getFirstDayOfMonth=J,d.isTodayDate=V,d.formatRangeLabel=z,d.formatHourLabel=G,d.locale=h,d.renderEvent=ie,d.renderAgendaEvent=le,d.renderCardItems=ce,d.collapseEpisodes=se,d.eventHasTime=F,d.compareEventsWithinDay=ne})();})();
})();
