(() => {
"use strict";(()=>{function A(d){let s=window.JellyfinEnhanced?.core?.sharedModules?.[d];if(!s)throw new Error(`${d} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return s}function M(d,s){return d[s]}var ge=A("features/downloads/host"),F=M(ge,"downloadsHost");function be(d){return typeof d=="object"&&d!==null&&!Array.isArray(d)}function U(d){if(!be(d))throw new Error("Invalid downloads response");return d}function N(d){if(d!=null){if(typeof d!="string")throw new Error("Invalid text");return d}}function J(d){let s=U(d),c={};for(let m of["movies","series"]){if(s[m]==null)continue;let I=U(s[m]),k={};for(let[E,q]of Object.entries(I)){let S=U(q);k[E]={matches:Array.isArray(S.matches)?S.matches.map(C=>{let R=U(C);return{urlMappings:N(R.urlMappings)||"",instanceUrl:N(R.instanceUrl)||"",titleSlug:N(R.titleSlug)||""}}):[]}}c[m]=k}return c}function L(d,s){if(!d)return"";try{let c=new URL(d,s);return c.protocol==="http:"||c.protocol==="https:"?c.href:""}catch{return""}}function O(d,s,c){let m=L(d,c);if(!m)return"";let I=new URL(m);return I.pathname=I.pathname.replace(/\/+$/,"")+"/"+s,I.href}var ve=A("features/downloads/runtime"),K=M(ve,"runtime");function V(d){let{JE:s,P:c,host:m,ctx:I}=d,k=K(d);if(k.installed.has("render-cards"))return;k.installed.add("render-cards");let E=c.state,q=c.getStatusColors,S=c.formatTimeRemaining,C=c.formatRelativeDate,R=c.getReleaseDateLabel,P=c.formatDownloadStats,G=c.resolveRequestStatus,W=c.getIssueMediaType,X=c.getIssueTmdbId,D=c.translateStatus,t=s.escapeHtml,x=s.cdn.selfhst("svg/sonarr.svg"),T=s.cdn.selfhst("svg/radarr-light-hybrid-light.svg"),Y=s.cdn.selfhst("svg/seerr.svg");function Q(e){let n=q(),r=n[(e.status||"unknown").toLowerCase()]||n.unknown,a=e.source==="Sonarr"?x:T,o=t(e.instanceName||e.source),u=e.posterUrl?`<img class="je-download-poster" src="${t(e.posterUrl)}" alt="" loading="lazy" onerror="this.style.display='none'">`:'<div class="je-download-poster placeholder"></div>',y=`
      <div class="je-download-progress-container">
        <div class="je-download-progress">
          <div class="je-download-progress-bar" style="width: ${Math.max(0,Math.min(100,e.progress||0))}%; background: ${r}"></div>
        </div>
        <div class="je-download-stats">
          <span>${Math.max(0,Math.min(100,e.progress||0))}%</span>
          ${e.timeRemaining?`<span>ETA: ${t(S(e.timeRemaining))}</span>`:""}
          ${e.totalSize?`<span>${P(e.totalSize,e.sizeRemaining)}</span>`:""}
        </div>
      </div>
    `;return`
      <div class="je-download-card" ${e.jellyfinMediaId?`data-media-id="${t(e.jellyfinMediaId)}"`:""}>
        <div class="je-download-card-content">
          ${u}
          <div class="je-download-info">
            <div class="je-download-title" title="${t(e.title||"")}">${t(e.title||s.t?.("requests_unknown")||"Unknown")}</div>
            ${e.subtitle?`<div class="je-download-subtitle" title="${t(e.subtitle)}">${t(e.subtitle)}</div>`:""}
            <div class="je-download-meta">
                <span class="je-download-badge je-arr-badge" title="${o}"><img src="${a}" alt="${o}" loading="lazy"></span>
              <span class="je-download-badge" style="background: ${r}">${t(D(e.status))}</span>
            </div>
          </div>
        </div>
        ${y}
      </div>
    `}function Z(e){let n=G(e.mediaStatus,e),r=R(e),a="";e.posterUrl?a=`<img class="je-request-poster" src="${t(e.posterUrl)}" alt="" loading="lazy">`:a='<div class="je-request-poster placeholder"></div>';let o="";e.requestedByAvatar&&(o=`<img class="je-request-avatar" data-avatar-src="${t(e.requestedByAvatar)}" alt="" loading="lazy" style="display:none" onerror="this.style.display='none'">`);let u="";if(e.jellyfinMediaId&&(e.mediaStatus==="Available"||e.mediaStatus==="Partially Available")){let i=s.t?.("jellyseerr_btn_available")||"Available";u=`<button class="je-request-watch-btn" title="${t(i)}" aria-label="${t(i)}" data-media-id="${t(e.jellyfinMediaId)}"><span class="material-icons">play_arrow</span></button>`}let y="";E.canApproveRequests&&e.requestStatus===1&&e.id&&(y=`
        <button class="je-request-approve-btn" data-request-id="${t(String(e.id))}" title="Approve"><span class="material-icons">check</span></button>
        <button class="je-request-decline-btn" data-request-id="${t(String(e.id))}" title="Decline"><span class="material-icons">close</span></button>
      `);let g="";if(e.canRemove===!0&&e.id){let i=s.t?.("requests_remove_request")||"Remove request";g=`<button class="je-request-remove-btn" data-request-id="${t(String(e.id))}" data-request-title="${t(e.title||"")}" title="${t(i)}" aria-label="${t(i)}"><span class="material-icons">delete</span></button>`}let w="";if(r){let i=typeof r=="object"?r.label:r;w=`<span class="je-release-date-chip">${typeof r=="object"&&r.icon?`<span class="material-icons je-release-date-icon">${t(r.icon)}</span>`:""}${typeof i=="object"?i.text||"":t(i)}</span>`}let b="",$=s.pluginConfig?.JellyseerrEnabled!==!1&&s.pluginConfig?.JellyseerrShowDetailPageLink!==!1,j=L(I.peer("jellyseerrAPI")?.resolveJellyseerrBaseUrl?.()||"",m.location.href);if(e.tmdbId&&$&&j){let i=e.type==="tv"?"tv":"movie",p=s.t?.("jellyseerr_card_view_on_jellyseerr")||"View on Seerr";b=`<a is="emby-linkbutton" class="je-request-external-link" href="${t(O(j,`${i}/${e.tmdbId}`,m.location.href))}" target="_blank" rel="noopener noreferrer" title="${t(p)}" aria-label="${t(p)}"><img src="${Y}" alt="Seerr"></a>`}let l="";e.tmdbId&&(l=`<div class="je-request-external-links" data-tmdb-id="${t(String(e.tmdbId))}" data-tvdb-id="${t(String(e.tvdbId||""))}" data-media-type="${t(e.type||"")}">${b}</div>`);let v=e.jellyfinMediaId?` data-media-id="${t(e.jellyfinMediaId)}"`:"",h=e.jellyfinMediaId?"je-request-title je-request-title-link":"je-request-title";return`
            <div class="je-request-card${e.isOrphaned?" je-request-card-orphaned":""}">
                <div class="je-request-poster-col">
                    ${a}
                    ${l}
                </div>
                <div class="je-request-info">
                    <div class="je-request-header">
                      <div>
                        <div class="je-request-title-row">
                          <div class="${h}"${v}>${t(e.title||"Unknown")}</div>
                          ${e.year?`<span class="je-request-year">(${t(e.year)})</span>`:""}
                        </div>
                        <span class="je-requests-status-chip ${t(n.className)}">${t(n.label)}</span>${w}
                      </div>
                    </div>
                    <div class="je-request-meta">
                      <div class="je-request-meta-left">
                        ${o}
                        <span>${t(e.requestedBy||"Unknown")}</span>
                        ${e.createdAt?`<span>&#8226;</span><span>${t(C(e.createdAt))}</span>`:""}
                      </div>
                    </div>
                    ${u||y||g?`<div class="je-request-actions">${u}${y}${g}</div>`:""}
                </div>
            </div>
        `}function ee(e){return{1:s.t?.("jellyseerr_report_issue_type_video")||"Video",2:s.t?.("jellyseerr_report_issue_type_audio")||"Audio",3:s.t?.("jellyseerr_report_issue_type_subtitles")||"Subtitles",4:s.t?.("jellyseerr_report_issue_type_other")||"Other"}[e||4]||"Other"}function te(e){let n=String(e||"").toLowerCase(),r=s.t?.("jellyseerr_issue_resolved")||"Resolved",a=s.t?.("jellyseerr_issue_open")||"Open";return n==="2"||n==="resolved"?{label:r,className:"je-issue-status-resolved"}:{label:a,className:"je-issue-status-open"}}function ne(e){let n=e?.media||{};return n.title||n.name||n.originalTitle||n.originalName||"Unknown"}function se(e){let n=e?.media||{},r=n.releaseDate||n.firstAirDate||"";return!r||r.length<4?"":r.substring(0,4)}function re(e){let n=e?.media||{};return n.mediaInfo?.posterPath?`https://image.tmdb.org/t/p/w300${n.mediaInfo.posterPath}`:n.mediaInfo?.poster_path?`https://image.tmdb.org/t/p/w300${n.mediaInfo.poster_path}`:n.posterUrl?n.posterUrl:n.posterPath?`https://image.tmdb.org/t/p/w300${n.posterPath}`:""}function ae(e){let n=e?.media||{};return n.jellyfinMediaId||n.mediaInfo?.jellyfinMediaId||n.mediaInfo?.jellyfinMediaId4k||n.mediaInfo?.jellyfinMediaId4K||null}function oe(e){let n=e?.createdBy||{};return n.jellyfinUsername||n.displayName||n.username||n.email||"Unknown"}function ie(e){let n=e?.createdBy?.avatar;return n?n.startsWith("/")?`/JellyfinEnhanced/proxy/avatar?path=${encodeURIComponent(n)}`:n:""}function le(e){return e?.message?e.message:(Array.isArray(e?.comments)?e.comments[0]:null)?.message||""}function de(e){let n=re(e),r=ne(e),a=se(e),o=ee(e?.issueType||e?.problemType),u=te(e?.status),y=oe(e),g=ie(e),w=le(e),b=W(e),$=X(e),j=!!($&&b),l=ae(e),v=n?`<img class="je-request-poster" src="${t(n)}" alt="" loading="lazy" onerror="this.style.display='none'">`:'<div class="je-request-poster placeholder"></div>',h=g?`<img class="je-request-avatar" data-avatar-src="${t(g)}" alt="" loading="lazy" style="display:none" onerror="this.style.display='none'">`:"";return`
      <div class="je-issue-card" ${l?`data-media-id="${t(l)}"`:""}>
        ${v}
        <div class="je-issue-info">
          <div class="je-issue-title-row">
            <div class="je-issue-title">${t(r)}${a?` <span class="je-request-year">(${t(a)})</span>`:""}</div>
            <span class="je-issue-status-chip ${u.className}">${t(u.label)}</span>
            <span class="je-issue-type-chip">${t(o)}</span>
          </div>
          ${w?`<div class="je-issue-message">${t(w)}</div>`:""}
          <div class="je-issue-summary">
            ${h}
            <span>${t(y)}</span>
            ${e?.createdAt?`<span>&#8226;</span><span>${t(C(e.createdAt))}</span>`:""}
            <button class="je-issue-view-btn ${j?"":"is-disabled"}" type="button" aria-label="View issue" ${j?`data-issue-tmdb-id="${t($)}" data-issue-media-type="${t(b)}" data-issue-title="${t(r)}"`:"disabled"}>
              <span class="material-icons">visibility</span>
            </button>
          </div>
        </div>
      </div>
    `}function ce(e){let n=e.source==="Sonarr"?x:T,r=t(e.instanceName||e.source),a=e.eventType==="partial",o=e.eventType==="imported",u=a?s.t?.("downloads_history_partial")||"Partially Imported":o?s.t?.("downloads_history_imported")||"Imported":s.t?.("downloads_history_failed")||"Import Failed",y=a?"je-chip-partial":o?"je-chip-available":"je-chip-declined",g=e.episodeCount?(s.t?.("downloads_history_partial_summary")||"{imported}/{total} episodes imported").replace("{imported}",String(e.importedCount??0)).replace("{total}",String(e.episodeCount)):null;return`
      <div class="je-request-card">
        ${e.posterUrl?`<img class="je-request-poster" src="${t(e.posterUrl)}" alt="" loading="lazy" onerror="this.style.display='none'">`:'<div class="je-request-poster placeholder"></div>'}
        <div class="je-request-info">
          <div class="je-request-header">
            <div>
              <div class="je-request-title-row">
                <div class="je-request-title">${t(e.title||s.t?.("requests_unknown")||"Unknown")}</div>
                ${e.subtitle?`<span class="je-request-year">${t(e.subtitle)}</span>`:""}
              </div>
              <span class="je-requests-status-chip ${y}">${t(u)}</span>
              ${g?`<span class="je-download-subtitle">${t(g)}</span>`:""}
            </div>
          </div>
          <div class="je-request-meta">
            <div class="je-request-meta-left">
              <span class="je-download-badge je-arr-badge" title="${r}"><img src="${n}" alt="${r}" loading="lazy"></span>
              <span>${t(r)}</span>
              ${e.date?`<span>&#8226;</span><span>${t(C(e.date))}</span>`:""}
            </div>
          </div>
        </div>
      </div>
    `}function ue(e){let n=q(),r=e.item,a=n[(r.status||"unknown").toLowerCase()]||n.unknown,o=r.posterUrl?`<img class="je-download-poster" src="${t(r.posterUrl)}" alt="" loading="lazy" onerror="this.style.display='none'">`:'<div class="je-download-poster placeholder"></div>',u=e.episodes[0]?.totalSize||0,y=e.episodes[0]?.sizeRemaining||0,g=e.episodes.every(j=>j.totalSize===u&&j.sizeRemaining===y),w=g?u:e.episodes.reduce((j,l)=>j+(l.totalSize||0),0),b=g?y:e.episodes.reduce((j,l)=>j+(l.sizeRemaining||0),0),$=`
      <div class="je-download-progress-container">
        <div class="je-download-progress">
          <div class="je-download-progress-bar" style="width: ${Math.max(0,Math.min(100,r.progress||0))}%; background: ${a}"></div>
        </div>
        <div class="je-download-stats">
          <span>${Math.max(0,Math.min(100,r.progress||0))}%</span>
          ${r.timeRemaining?`<span>ETA: ${t(S(r.timeRemaining))}</span>`:""}
          ${w?`<span>${P(w,b)}</span>`:""}
        </div>
      </div>
    `;return`
      <div class="je-download-card je-season-pack" ${r.jellyfinMediaId?`data-media-id="${t(r.jellyfinMediaId)}"`:""}>
        <div class="je-download-card-content">
          ${o}
          <div class="je-download-info">
            <div class="je-download-title" title="${t(r.title||"")}">${t(r.title||s.t?.("requests_unknown")||"Unknown")}</div>
            <div class="je-download-subtitle">${s.t?.("requests_season")||"Season"} ${r.seasonNumber} (${e.episodeCount} ${s.t?.("requests_episodes")||"episodes"})</div>
            <div class="je-download-meta">
              <span class="je-download-badge je-arr-badge" title="Sonarr"><img src="${x}" alt="Sonarr" loading="lazy"></span>
              <span class="je-download-badge" style="background: ${a}">${t(D(r.status))}</span>
              <span class="je-download-badge" style="background: rgba(128,128,128,0.4)">${e.episodeRange}</span>
            </div>
          </div>
        </div>
        ${$}
      </div>
    `}function pe(e){let n=[];return e&&e.split(`
`).forEach(r=>{let a=r.trim();if(!a)return;let o=a.split("|").map(u=>u.trim());o.length===2&&o[0]&&o[1]&&n.push({jellyfinUrl:o[0],arrUrl:o[1]})}),n}function fe(e,n){if(!n)return null;if(!e||e.length===0)return n;let a=(m.ApiClient?.serverAddress?.()||window.location.origin).replace(/\/+$/,"").toLowerCase();for(let o of e){let u=o.jellyfinUrl.replace(/\/+$/,"").toLowerCase();if(a===u)return o.arrUrl.replace(/\/$/,"")}return n.replace(/\/$/,"")}let z=100,H=6,_=null;function me(e,n,r){let a=(r?.matches||[])[0],o=a?fe(pe(a.urlMappings||""),a.instanceUrl):null,u=L(o||"",m.location.href);return e==="movie"?u?`<a is="emby-linkbutton" class="je-request-external-link" href="${t(O(u,`movie/${encodeURIComponent(n)}`,m.location.href))}" target="_blank" rel="noopener noreferrer" title="Open in Radarr" aria-label="Open in Radarr"><img src="${T}" alt="Radarr"></a>`:null:!u||!a?.titleSlug?null:`<a is="emby-linkbutton" class="je-request-external-link" href="${t(O(u,`series/${encodeURIComponent(a.titleSlug)}`,m.location.href))}" target="_blank" rel="noopener noreferrer" title="Open in Sonarr" aria-label="Open in Sonarr"><img src="${x}" alt="Sonarr"></a>`}async function ye(e){let n=k.capture();if(!n.current()||!(s.pluginConfig?.ArrLinksEnabled===!0)||!s.helpers.isAdmin())return;let a=e.querySelectorAll(".je-request-external-links[data-tmdb-id]");if(!a.length)return;let o=[];if(a.forEach(l=>{let v=l.getAttribute("data-tmdb-id"),h=l.getAttribute("data-tvdb-id"),i=l.getAttribute("data-media-type")==="tv"?"tv":"movie";if(!v)return;let p=(i==="movie"?v:h||"").trim();!/^\d+$/.test(p)||!(Number(p)>0)||Number(p)>2147483647||o.push({slot:l,mediaType:i,tmdbId:v,id:String(Number(p))})}),!o.length)return;let u=[],y=[];for(let[l,v,h]of[["movie","tmdbIds","movies"],["tv","tvdbIds","series"]]){let i=[...new Set(o.filter(f=>f.mediaType===l).map(f=>f.id))],p=f=>({param:v,field:h,query:`${v}=${f.join(",")}`});if(i.length){u.push(p(i.slice(0,H)));for(let f=H;f<i.length;f+=z)y.push(p(i.slice(f,f+z)))}}let g=[...u,...y],w=JSON.stringify([s.session?.getEpoch(),m.ApiClient?.getCurrentUserId(),m.ApiClient?.serverAddress?.(),g.map(l=>l.query)]),b=_;if(!b||b.key!==w||b.controller.signal.aborted){b&&b.controller.abort();let l=new AbortController,v=s.core.lifecycle?.register("arr-requests-page");v?.track(l);let h=g.map(p=>({field:p.field,promise:s.core.api.plugin(`/arr/links?${p.query}`,{signal:l.signal,priority:"low"}).then(J).catch(()=>null)})),i={key:w,controller:l,chunks:h};Promise.all(h.map(p=>p.promise)).then(()=>{v?.untrack(l),_===i&&(_=null)}),b=i,_=i}let{controller:$,chunks:j}=b;await Promise.all(j.map(async({field:l,promise:v})=>{let i=(await v)?.[l];if(!n.current()||!s.helpers.isAdmin()||s.pluginConfig?.ArrLinksEnabled!==!0||$.signal.aborted||!i||typeof i!="object")return;let p=l==="movies"?"movie":"tv";for(let f of o){if(f.mediaType!==p||!f.slot.isConnected||!Object.prototype.hasOwnProperty.call(i,f.id))continue;let B=me(p,f.tmdbId,i[f.id]);B&&f.slot.insertAdjacentHTML("beforeend",B)}}))}c.renderDownloadCard=Q,c.renderRequestCard=Z,c.hydrateExternalLinks=ye,c.renderIssueCard=de,c.renderHistoryCard=ce,c.renderSeasonPackCard=ue}V(F());})();
})();
