(() => {
"use strict";(()=>{function _(i){let r=window.JellyfinEnhanced?.core?.sharedModules?.[i];if(!r)throw new Error(`${i} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return r}function M(i,r){return i[r]}var be=_("features/downloads/host"),F=M(be,"downloadsHost");function ve(i){return typeof i=="object"&&i!==null&&!Array.isArray(i)}function U(i){if(!ve(i))throw new Error("Invalid downloads response");return i}function N(i){if(i!=null){if(typeof i!="string")throw new Error("Invalid text");return i}}function J(i){let r=U(i),l={};for(let m of["movies","series"]){if(r[m]==null)continue;let I=U(r[m]),x={};for(let[S,E]of Object.entries(I)){let C=U(E);x[S]={matches:Array.isArray(C.matches)?C.matches.map(R=>{let k=U(R);return{urlMappings:N(k.urlMappings)||"",instanceUrl:N(k.instanceUrl)||"",titleSlug:N(k.titleSlug)||""}}):[]}}l[m]=x}return l}function O(i,r){if(!i)return"";try{let l=new URL(i,r);return l.protocol==="http:"||l.protocol==="https:"?l.href:""}catch{return""}}function L(i,r,l){let m=O(i,l);if(!m)return"";let I=new URL(m);return I.pathname=I.pathname.replace(/\/+$/,"")+"/"+r,I.href}var je=_("features/downloads/runtime"),K=M(je,"runtime");function V(i){let{JE:r,P:l,host:m,ctx:I,getApi:x}=i,S=K(i);if(S.installed.has("render-cards"))return;S.installed.add("render-cards");let E=l.state,C=l.getStatusColors,R=l.formatTimeRemaining,k=l.formatRelativeDate,G=l.getReleaseDateLabel,P=l.formatDownloadStats,W=l.resolveRequestStatus,X=l.getIssueMediaType,Y=l.getIssueTmdbId,D=l.translateStatus,n=r.escapeHtml,q=r.cdn.selfhst("svg/sonarr.svg"),T=r.cdn.selfhst("svg/radarr-light-hybrid-light.svg"),Q=r.cdn.selfhst("svg/seerr.svg");function Z(e){let t=C(),s=t[(e.status||"unknown").toLowerCase()]||t.unknown,a=e.source==="Sonarr"?q:T,o=n(e.instanceName||e.source),d=e.posterUrl?`<img class="je-download-poster" src="${n(e.posterUrl)}" alt="" loading="lazy" onerror="this.style.display='none'">`:'<div class="je-download-poster placeholder"></div>',y=`
      <div class="je-download-progress-container">
        <div class="je-download-progress">
          <div class="je-download-progress-bar" style="width: ${Math.max(0,Math.min(100,e.progress||0))}%; background: ${s}"></div>
        </div>
        <div class="je-download-stats">
          <span>${Math.max(0,Math.min(100,e.progress||0))}%</span>
          ${e.timeRemaining?`<span>ETA: ${n(R(e.timeRemaining))}</span>`:""}
          ${e.totalSize?`<span>${P(e.totalSize,e.sizeRemaining)}</span>`:""}
        </div>
      </div>
    `;return`
      <div class="je-download-card" ${e.jellyfinMediaId?`data-media-id="${n(e.jellyfinMediaId)}"`:""}>
        <div class="je-download-card-content">
          ${d}
          <div class="je-download-info">
            <div class="je-download-title" title="${n(e.title||"")}">${n(e.title||r.t?.("requests_unknown")||"Unknown")}</div>
            ${e.subtitle?`<div class="je-download-subtitle" title="${n(e.subtitle)}">${n(e.subtitle)}</div>`:""}
            <div class="je-download-meta">
                <span class="je-download-badge je-arr-badge" title="${o}"><img src="${a}" alt="${o}" loading="lazy"></span>
              <span class="je-download-badge" style="background: ${s}">${n(D(e.status))}</span>
            </div>
          </div>
        </div>
        ${y}
      </div>
    `}function ee(e){let t=W(e.mediaStatus,e),s=G(e),a="";e.posterUrl?a=`<img class="je-request-poster" src="${n(e.posterUrl)}" alt="" loading="lazy">`:a='<div class="je-request-poster placeholder"></div>';let o="";e.requestedByAvatar&&(o=`<img class="je-request-avatar" data-avatar-src="${n(e.requestedByAvatar)}" alt="" loading="lazy" style="display:none" onerror="this.style.display='none'">`);let d="";if(e.jellyfinMediaId&&(e.mediaStatus==="Available"||e.mediaStatus==="Partially Available")){let p=r.t?.("jellyseerr_btn_available")||"Available";d=`<button class="je-request-watch-btn" title="${n(p)}" aria-label="${n(p)}" data-media-id="${n(e.jellyfinMediaId)}"><span class="material-icons">play_arrow</span></button>`}let y="";E.canApproveRequests&&e.requestStatus===1&&e.id&&(y=`
        <button class="je-request-approve-btn" data-request-id="${n(String(e.id))}" title="Approve"><span class="material-icons">check</span></button>
        <button class="je-request-decline-btn" data-request-id="${n(String(e.id))}" title="Decline"><span class="material-icons">close</span></button>
      `);let v="";if(s){let p=typeof s=="object"?s.label:s;v=`<span class="je-release-date-chip">${typeof s=="object"&&s.icon?`<span class="material-icons je-release-date-icon">${n(s.icon)}</span>`:""}${typeof p=="object"?p.text||"":n(p)}</span>`}let h="",j=r.pluginConfig?.JellyseerrEnabled!==!1&&r.pluginConfig?.JellyseerrShowDetailPageLink!==!1,$=O(I.peer("jellyseerrAPI")?.resolveJellyseerrBaseUrl?.()||"",m.location.href);if(e.tmdbId&&j&&$){let p=e.type==="tv"?"tv":"movie",u=r.t?.("jellyseerr_card_view_on_jellyseerr")||"View on Seerr";h=`<a is="emby-linkbutton" class="je-request-external-link" href="${n(L($,`${p}/${e.tmdbId}`,m.location.href))}" target="_blank" rel="noopener noreferrer" title="${n(u)}" aria-label="${n(u)}"><img src="${Q}" alt="Seerr"></a>`}let w="";e.tmdbId&&(w=`<div class="je-request-external-links" data-tmdb-id="${n(String(e.tmdbId))}" data-tvdb-id="${n(String(e.tvdbId||""))}" data-media-type="${n(e.type||"")}">${h}</div>`);let c=e.jellyfinMediaId?` data-media-id="${n(e.jellyfinMediaId)}"`:"",g=e.jellyfinMediaId?"je-request-title je-request-title-link":"je-request-title";return`
            <div class="je-request-card${e.isOrphaned?" je-request-card-orphaned":""}">
                <div class="je-request-poster-col">
                    ${a}
                    ${w}
                </div>
                <div class="je-request-info">
                    <div class="je-request-header">
                      <div>
                        <div class="je-request-title-row">
                          <div class="${g}"${c}>${n(e.title||"Unknown")}</div>
                          ${e.year?`<span class="je-request-year">(${n(e.year)})</span>`:""}
                        </div>
                        <span class="je-requests-status-chip ${n(t.className)}">${n(t.label)}</span>${v}
                      </div>
                    </div>
                    <div class="je-request-meta">
                      <div class="je-request-meta-left">
                        ${o}
                        <span>${n(e.requestedBy||"Unknown")}</span>
                        ${e.createdAt?`<span>&#8226;</span><span>${n(k(e.createdAt))}</span>`:""}
                      </div>
                    </div>
                    ${d||y?`<div class="je-request-actions">${d}${y}</div>`:""}
                </div>
            </div>
        `}function te(e){return{1:r.t?.("jellyseerr_report_issue_type_video")||"Video",2:r.t?.("jellyseerr_report_issue_type_audio")||"Audio",3:r.t?.("jellyseerr_report_issue_type_subtitles")||"Subtitles",4:r.t?.("jellyseerr_report_issue_type_other")||"Other"}[e||4]||"Other"}function ne(e){let t=String(e||"").toLowerCase(),s=r.t?.("jellyseerr_issue_resolved")||"Resolved",a=r.t?.("jellyseerr_issue_open")||"Open";return t==="2"||t==="resolved"?{label:s,className:"je-issue-status-resolved"}:{label:a,className:"je-issue-status-open"}}function se(e){let t=e?.media||{};return t.title||t.name||t.originalTitle||t.originalName||"Unknown"}function re(e){let t=e?.media||{},s=t.releaseDate||t.firstAirDate||"";return!s||s.length<4?"":s.substring(0,4)}function ae(e){let t=e?.media||{};return t.mediaInfo?.posterPath?`https://image.tmdb.org/t/p/w300${t.mediaInfo.posterPath}`:t.mediaInfo?.poster_path?`https://image.tmdb.org/t/p/w300${t.mediaInfo.poster_path}`:t.posterUrl?t.posterUrl:t.posterPath?`https://image.tmdb.org/t/p/w300${t.posterPath}`:""}function oe(e){let t=e?.media||{};return t.jellyfinMediaId||t.mediaInfo?.jellyfinMediaId||t.mediaInfo?.jellyfinMediaId4k||t.mediaInfo?.jellyfinMediaId4K||null}function ie(e){let t=e?.createdBy||{};return t.jellyfinUsername||t.displayName||t.username||t.email||"Unknown"}function le(e){let t=e?.createdBy?.avatar;return t?t.startsWith("/")?x().getUrl("/JellyfinEnhanced/proxy/avatar",{path:t}):t:""}function de(e){return e?.message?e.message:(Array.isArray(e?.comments)?e.comments[0]:null)?.message||""}function ce(e){let t=ae(e),s=se(e),a=re(e),o=te(e?.issueType||e?.problemType),d=ne(e?.status),y=ie(e),v=le(e),h=de(e),j=X(e),$=Y(e),w=!!($&&j),c=oe(e),g=t?`<img class="je-request-poster" src="${n(t)}" alt="" loading="lazy" onerror="this.style.display='none'">`:'<div class="je-request-poster placeholder"></div>',p=v?`<img class="je-request-avatar" data-avatar-src="${n(v)}" alt="" loading="lazy" style="display:none" onerror="this.style.display='none'">`:"";return`
      <div class="je-issue-card" ${c?`data-media-id="${n(c)}"`:""}>
        ${g}
        <div class="je-issue-info">
          <div class="je-issue-title-row">
            <div class="je-issue-title">${n(s)}${a?` <span class="je-request-year">(${n(a)})</span>`:""}</div>
            <span class="je-issue-status-chip ${d.className}">${n(d.label)}</span>
            <span class="je-issue-type-chip">${n(o)}</span>
          </div>
          ${h?`<div class="je-issue-message">${n(h)}</div>`:""}
          <div class="je-issue-summary">
            ${p}
            <span>${n(y)}</span>
            ${e?.createdAt?`<span>&#8226;</span><span>${n(k(e.createdAt))}</span>`:""}
            <button class="je-issue-view-btn ${w?"":"is-disabled"}" type="button" aria-label="View issue" ${w?`data-issue-tmdb-id="${n($)}" data-issue-media-type="${n(j)}" data-issue-title="${n(s)}"`:"disabled"}>
              <span class="material-icons">visibility</span>
            </button>
          </div>
        </div>
      </div>
    `}function ue(e){let t=e.source==="Sonarr"?q:T,s=n(e.instanceName||e.source),a=e.eventType==="partial",o=e.eventType==="imported",d=a?r.t?.("downloads_history_partial")||"Partially Imported":o?r.t?.("downloads_history_imported")||"Imported":r.t?.("downloads_history_failed")||"Import Failed",y=a?"je-chip-partial":o?"je-chip-available":"je-chip-declined",v=e.episodeCount?(r.t?.("downloads_history_partial_summary")||"{imported}/{total} episodes imported").replace("{imported}",String(e.importedCount??0)).replace("{total}",String(e.episodeCount)):null;return`
      <div class="je-request-card">
        ${e.posterUrl?`<img class="je-request-poster" src="${n(e.posterUrl)}" alt="" loading="lazy" onerror="this.style.display='none'">`:'<div class="je-request-poster placeholder"></div>'}
        <div class="je-request-info">
          <div class="je-request-header">
            <div>
              <div class="je-request-title-row">
                <div class="je-request-title">${n(e.title||r.t?.("requests_unknown")||"Unknown")}</div>
                ${e.subtitle?`<span class="je-request-year">${n(e.subtitle)}</span>`:""}
              </div>
              <span class="je-requests-status-chip ${y}">${n(d)}</span>
              ${v?`<span class="je-download-subtitle">${n(v)}</span>`:""}
            </div>
          </div>
          <div class="je-request-meta">
            <div class="je-request-meta-left">
              <span class="je-download-badge je-arr-badge" title="${s}"><img src="${t}" alt="${s}" loading="lazy"></span>
              <span>${n(s)}</span>
              ${e.date?`<span>&#8226;</span><span>${n(k(e.date))}</span>`:""}
            </div>
          </div>
        </div>
      </div>
    `}function pe(e){let t=C(),s=e.item,a=t[(s.status||"unknown").toLowerCase()]||t.unknown,o=s.posterUrl?`<img class="je-download-poster" src="${n(s.posterUrl)}" alt="" loading="lazy" onerror="this.style.display='none'">`:'<div class="je-download-poster placeholder"></div>',d=e.episodes[0]?.totalSize||0,y=e.episodes[0]?.sizeRemaining||0,v=e.episodes.every(w=>w.totalSize===d&&w.sizeRemaining===y),h=v?d:e.episodes.reduce((w,c)=>w+(c.totalSize||0),0),j=v?y:e.episodes.reduce((w,c)=>w+(c.sizeRemaining||0),0),$=`
      <div class="je-download-progress-container">
        <div class="je-download-progress">
          <div class="je-download-progress-bar" style="width: ${Math.max(0,Math.min(100,s.progress||0))}%; background: ${a}"></div>
        </div>
        <div class="je-download-stats">
          <span>${Math.max(0,Math.min(100,s.progress||0))}%</span>
          ${s.timeRemaining?`<span>ETA: ${n(R(s.timeRemaining))}</span>`:""}
          ${h?`<span>${P(h,j)}</span>`:""}
        </div>
      </div>
    `;return`
      <div class="je-download-card je-season-pack" ${s.jellyfinMediaId?`data-media-id="${n(s.jellyfinMediaId)}"`:""}>
        <div class="je-download-card-content">
          ${o}
          <div class="je-download-info">
            <div class="je-download-title" title="${n(s.title||"")}">${n(s.title||r.t?.("requests_unknown")||"Unknown")}</div>
            <div class="je-download-subtitle">${r.t?.("requests_season")||"Season"} ${s.seasonNumber} (${e.episodeCount} ${r.t?.("requests_episodes")||"episodes"})</div>
            <div class="je-download-meta">
              <span class="je-download-badge je-arr-badge" title="Sonarr"><img src="${q}" alt="Sonarr" loading="lazy"></span>
              <span class="je-download-badge" style="background: ${a}">${n(D(s.status))}</span>
              <span class="je-download-badge" style="background: rgba(128,128,128,0.4)">${e.episodeRange}</span>
            </div>
          </div>
        </div>
        ${$}
      </div>
    `}function fe(e){let t=[];return e&&e.split(`
`).forEach(s=>{let a=s.trim();if(!a)return;let o=a.split("|").map(d=>d.trim());o.length===2&&o[0]&&o[1]&&t.push({jellyfinUrl:o[0],arrUrl:o[1]})}),t}function me(e,t){if(!t)return null;if(!e||e.length===0)return t;let a=(m.ApiClient?.serverAddress?.()||window.location.origin).replace(/\/+$/,"").toLowerCase();for(let o of e){let d=o.jellyfinUrl.replace(/\/+$/,"").toLowerCase();if(a===d)return o.arrUrl.replace(/\/$/,"")}return t.replace(/\/$/,"")}let z=100,H=6,A=null;function ye(e,t,s){let a=(s?.matches||[])[0],o=a?me(fe(a.urlMappings||""),a.instanceUrl):null,d=O(o||"",m.location.href);return e==="movie"?d?`<a is="emby-linkbutton" class="je-request-external-link" href="${n(L(d,`movie/${encodeURIComponent(t)}`,m.location.href))}" target="_blank" rel="noopener noreferrer" title="Open in Radarr" aria-label="Open in Radarr"><img src="${T}" alt="Radarr"></a>`:null:!d||!a?.titleSlug?null:`<a is="emby-linkbutton" class="je-request-external-link" href="${n(L(d,`series/${encodeURIComponent(a.titleSlug)}`,m.location.href))}" target="_blank" rel="noopener noreferrer" title="Open in Sonarr" aria-label="Open in Sonarr"><img src="${q}" alt="Sonarr"></a>`}async function ge(e){let t=S.capture();if(!t.current()||!(r.pluginConfig?.ArrLinksEnabled===!0)||!r.helpers.isAdmin())return;let a=e.querySelectorAll(".je-request-external-links[data-tmdb-id]");if(!a.length)return;let o=[];if(a.forEach(c=>{let g=c.getAttribute("data-tmdb-id"),p=c.getAttribute("data-tvdb-id"),u=c.getAttribute("data-media-type")==="tv"?"tv":"movie";if(!g)return;let b=(u==="movie"?g:p||"").trim();!/^\d+$/.test(b)||!(Number(b)>0)||Number(b)>2147483647||o.push({slot:c,mediaType:u,tmdbId:g,id:String(Number(b))})}),!o.length)return;let d=[],y=[];for(let[c,g,p]of[["movie","tmdbIds","movies"],["tv","tvdbIds","series"]]){let u=[...new Set(o.filter(f=>f.mediaType===c).map(f=>f.id))],b=f=>({param:g,field:p,query:`${g}=${f.join(",")}`});if(u.length){d.push(b(u.slice(0,H)));for(let f=H;f<u.length;f+=z)y.push(b(u.slice(f,f+z)))}}let v=[...d,...y],h=JSON.stringify([r.session?.getEpoch(),m.ApiClient?.getCurrentUserId(),m.ApiClient?.serverAddress?.(),v.map(c=>c.query)]),j=A;if(!j||j.key!==h||j.controller.signal.aborted){j&&j.controller.abort();let c=new AbortController,g=r.core.lifecycle?.register("arr-requests-page");g?.track(c);let p=v.map(b=>({field:b.field,promise:r.core.api.plugin(`/arr/links?${b.query}`,{signal:c.signal,priority:"low"}).then(J).catch(()=>null)})),u={key:h,controller:c,chunks:p};Promise.all(p.map(b=>b.promise)).then(()=>{g?.untrack(c),A===u&&(A=null)}),j=u,A=u}let{controller:$,chunks:w}=j;await Promise.all(w.map(async({field:c,promise:g})=>{let u=(await g)?.[c];if(!t.current()||!r.helpers.isAdmin()||r.pluginConfig?.ArrLinksEnabled!==!0||$.signal.aborted||!u||typeof u!="object")return;let b=c==="movies"?"movie":"tv";for(let f of o){if(f.mediaType!==b||!f.slot.isConnected||!Object.prototype.hasOwnProperty.call(u,f.id))continue;let B=ye(b,f.tmdbId,u[f.id]);B&&f.slot.insertAdjacentHTML("beforeend",B)}}))}l.renderDownloadCard=Z,l.renderRequestCard=ee,l.hydrateExternalLinks=ge,l.renderIssueCard=ce,l.renderHistoryCard=ue,l.renderSeasonPackCard=pe}V(F());})();
})();
