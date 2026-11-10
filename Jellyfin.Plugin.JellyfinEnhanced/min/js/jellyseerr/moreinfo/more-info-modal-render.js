(() => {
"use strict";(()=>{function $(e,n,t){let r=n.core?.featureContext;if(typeof r!="function")throw new Error(`${e}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);return r(e,n,t)}function E(){let e=window;if(!e.JellyfinEnhanced)throw new Error("Seerr details loaded before Jellyfin Enhanced");return e.JellyfinEnhanced}var A=new WeakMap;function T(e){let n=A.get(e);return n||(n=$("seerr",e,{internalSlots:["moreInfoModal"],internalsObject:()=>e.internals??(e.internals={})}),A.set(e,n)),n}function D(e){let n=T(e).own;return n.moreInfoModal??(n.moreInfoModal={state:{currentModal:null}})}function y(e,n){let t=e[n];if(t===void 0)throw new Error(`More Info loader dependency missing: ${n}`);return t}function O(e){return(n,t="",r)=>(r?e.t?.(n,r):e.t?.(n))||t}function _(e){return n=>e.escapeHtml?e.escapeHtml(n):String(n??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;")}var re=/^\d{4}-\d{2}-\d{2}/,J={year:"numeric",month:"long",day:"numeric"};function F(e){return re.test(e)}function L(e){if(F(e))return Number(e.slice(0,4));let n=new Date(e).getFullYear();return Number.isNaN(n)?void 0:n}function N(e){let n=F(e),t=new Date(n?`${e.slice(0,10)}T00:00:00Z`:e);if(!Number.isNaN(t.getTime()))return t.toLocaleDateString("en-US",n?{...J,timeZone:"UTC"}:J)}function k(e){return typeof e=="object"&&e!==null&&!Array.isArray(e)}function g(e){return k(e)?e:null}function a(e){return typeof e=="string"?e:void 0}function m(e){return typeof e=="string"&&e.length>0?e:null}function j(e){return typeof e=="number"&&Number.isFinite(e)?e:void 0}function oe(e){return Array.isArray(e)?e:[]}function u(e){return oe(e).filter(k)}function h(e){return typeof e=="number"&&Number.isFinite(e)?String(e):m(e)}function U(e){if(typeof e!="string"||e.length===0)return null;try{let{protocol:n}=new URL(e);return n==="http:"||n==="https:"?e:null}catch{return null}}function ie(e){return e.replace(/[\s'"()\\<>]/g,n=>encodeURIComponent(n).replace(/[()']/g,t=>`%${t.charCodeAt(0).toString(16).toUpperCase()}`))}function x(e,n){let t=a(n);return t?`https://image.tmdb.org/t/p/${e}${ie(t)}`:""}function B(e,n){return a(n==="movie"?e.title:e.name)??""}function se(e,n){return e.find(t=>t.iso_3166_1===n)??e.find(t=>t.iso_3166_1==="US")??e[0]}function q(e,n){if(!Array.isArray(e.watchProviders))return[];let t=[],r=new Set;for(let i of u(se(u(e.watchProviders),n)?.flatrate))if(!r.has(i.id)&&(r.add(i.id),t.push(i),t.length>=6))break;return t}function ae(e){return`${e>=60?`${Math.floor(e/60)}h `:""}${e%60?`${e%60}m`:""}`.trim()}function H(e,n){if(n==="movie"){let r=j(e.runtime);return r?ae(r):"N/A"}let t=Array.isArray(e.episodeRunTime)?j(e.episodeRunTime[0]):void 0;return t!==void 0?`${t} min episodes`:"N/A"}function K(e,n){return h(e.jeYear)??(n?L(n)??"N/A":"N/A")}function z(e){let n=g(e.credits);if(!n||!Array.isArray(n.crew))return null;let t=u(n.crew);return{director:t.find(r=>r.job==="Director"),writers:t.filter(r=>r.job==="Screenplay"||r.job==="Writer"||r.job==="Story").slice(0,3)}}var p=E(),le=T(p),c=D(p),o=_(p),de=O(p),l=(e,n="")=>o(de(e,n));function f(e,n){return`
                <div class="je-more-info-stat-row">
                    <div class="je-more-info-stat-label">${e}</div>
                    <div class="je-more-info-stat-value">${n}</div>
                </div>
            `}function P(e,n){let t=m(n),r=t?N(t):void 0;return r?f(l(e),o(r)):""}function ce(e,n){let t=y(c,"getContentRating")(e,n);return p.pluginConfig?.ColoredRatingsEnabled&&t&&t!=="N/A"?`<span class="rating-badge mediaInfoOfficialRating" rating="${o(le.peer("normalizeOfficialRating")?.(t)||t)}">${o(t)}</span>`:`<span class="rating-badge">${o(t)}</span>`}function W(e,n,{budget:t,revenue:r,releaseDate:i,tmdbId:d}){let s=g(e)??{},S=u(s.productionCountries),M=u(s.productionCompanies),C=m(s.originalLanguage);return`
        <div class="je-more-info-right-panel">
            <div class="je-more-info-media-ratings" data-mount="ratings">
                ${s.ratings?y(c,"buildRatingLogos")(s.ratings,s,n,d):`
                    <div class="je-more-info-ratings-skeleton">
                        <span class="je-skel-badge"></span>
                        <span class="je-skel-badge" style="width:72px"></span>
                    </div>
                `}
            </div>
            ${n==="movie"&&s.collection?G(s.collection):""}
            <div class="je-more-info-stats-panel">
                ${f(l("jellyseerr_modal_status"),o(m(s.status)??"N/A"))}
                ${n==="tv"?`${P("jellyseerr_modal_first_air_date",s.firstAirDate)}${P("jellyseerr_modal_last_air_date",s.lastAirDate)}`:P("jellyseerr_modal_release_date",i)}
                ${r?f(l("jellyseerr_modal_revenue"),o(r)):""}
                ${t?f(l("jellyseerr_modal_budget"),o(t)):""}
                ${C?f(l("jellyseerr_modal_original_language"),o(C.toUpperCase())):""}
                ${S.length?f(l("jellyseerr_modal_production_country"),S.map(b=>{let v=a(b.name)??"",w=v==="United States of America"?"United States":v,R=p.cdn?.flagPng((a(b.iso_3166_1)??"").toLowerCase())??"";return`<div><img src="${o(R)}" alt="${o(w)}" title="${o(w)}" style="margin-right: 6px; vertical-align: middle;" /> ${o(w)}</div>`}).join("")):""}
                ${M.length?f(l("jellyseerr_modal_studios"),M.slice(0,3).map(b=>o(a(b.name))).join(", ")):""}
                ${Y(s)}
            </div>
            ${y(c,"buildMediaFacts")(s,n,d)}
        </div>
    `}function Y(e){if(!p.pluginConfig?.TmdbEnabled||!k(e))return"";let n=(p.userConfig?.elsewhere?.Region||p.pluginConfig?.DEFAULT_REGION||"US").toUpperCase(),t=q(e,n);return t.length?`
        <div class="je-more-info-stat-row">
            <div class="je-more-info-stat-label">${l("jellyseerr_modal_streaming")}</div>
            <div class="je-more-info-providers-list">
                ${t.map(r=>{let i=o(a(r.name));return`<img src="${o(x("w92",r.logoPath))}" alt="${i}" title="${i}" />`}).join("")}
            </div>
        </div>
    `:""}function G(e){let n=g(e);if(!n)return"";let t=o(a(n.name)),r=m(n.backdropPath),i=r?`https://image.tmdb.org/t/p/w1440_and_h320_multi_faces/${encodeURI(r)}`:"data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22400%22 height=%22200%22%3E%3Crect fill=%22%23374151%22 width=%22400%22 height=%22200%22/%3E%3C/svg%3E";return`
        <div class="je-collection-card">
            <div class="je-collection-card-backdrop">
                <img src="${o(i)}" alt="${t}" loading="lazy" />
                <div class="je-collection-card-overlay"></div>
            </div>
            <div class="je-collection-card-content">
                <div class="je-collection-card-title">${t}</div>
                <button class="je-collection-card-button" data-collection-id="${o(h(n.id))}" data-collection-name="${t}">
                    ${l("jellyseerr_btn_view_collection","View")}
                </button>
            </div>
        </div>
    `}function V(e){let n=u(g(e)?.keywords);return n.length?`
        <div class="keywords-section">
            <h3>${l("jellyseerr_modal_keywords","Keywords")}</h3>
            <div class="keywords-grid">
                ${n.slice(0,20).map(t=>`<span class="keyword">${o(a(t.name))}</span>`).join("")}
            </div>
        </div>
    `:""}function Q(e,n){return`
                <div class="crew-item">
                    <h4>${e}</h4>
                    <p>${n}</p>
                </div>
            `}function Z(e,n){let t=g(e)??{},r=u(t.createdBy);if(n==="tv"&&r.length)return`
            <div class="creators">
                <h4>${l("jellyseerr_modal_created_by","Created By")}</h4>
                <p>${r.map(s=>o(a(s.name))).join(", ")}</p>
            </div>
        `;let i=z(t);if(!i)return"";let d=[i.director?Q(l("jellyseerr_modal_director","Director"),o(a(i.director.name))):"",i.writers.length?Q(l("jellyseerr_modal_writers","Writers"),i.writers.map(s=>o(a(s.name))).join(", ")):""].join("");return d?`<div class="crew-section">${d}</div>`:""}function ue(e,n){let t=o(a(e.name)),r=e.site==="YouTube",i=m(e.key),d=r&&i?`https://img.youtube.com/vi/${encodeURIComponent(i)}/mqdefault.jpg`:"",s=r?`<img src="${o(p.cdn?.selfhst("png/youtube.png"))}" alt="YouTube" class="trailer-youtube-icon" />`:"";return`
                        <a is="emby-linkbutton" href="${o(n)}" target="_blank" rel="noopener noreferrer" title="${t}" class="trailer-item">
                            <div class="trailer-thumbnail">
                                ${d?`<img src="${o(d)}" alt="${t}" />`:""}
                                <div class="je-modal-play-button">
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M8 5v14l11-7z"/>
                                    </svg>
                                </div>
                                ${s}
                            </div>
                            <div class="trailer-info">
                                <div class="trailer-name">${t}</div>
                                <div class="trailer-type">${o(a(e.type))}</div>
                            </div>
                        </a>
                    `}function X(e){let n=u(g(e)?.relatedVideos).filter(t=>t.type==="Trailer"||t.type==="Teaser").slice(0,6).flatMap(t=>{let r=U(t.url);return r?[ue(t,r)]:[]});return n.length?`
        <div class="trailers-section">
            <h3>${l("jellyseerr_modal_trailers")}</h3>
            <div class="trailers-grid">
                ${n.join("")}
            </div>
        </div>
    `:""}function ee(){return`
        <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
            <rect width="100" height="100" fill="#2a2a2a"/>
            <circle cx="50" cy="40" r="15" fill="#555"/>
            <path d="M 25 75 Q 25 60, 50 60 Q 75 60, 75 75 L 75 100 L 25 100 Z" fill="#555"/>
        </svg>
    `}function ne(e){let n=u(g(g(e)?.credits)?.cast);return n.length?`
        <div class="cast-section">
            <h3>${l("jellyseerr_modal_cast")}</h3>
            <div class="cast-scroll">
                ${n.slice(0,20).map(t=>{let r=o(a(t.name)),i=o(a(t.character)??""),d=x("w185",t.profilePath);return`
                        <div class="cast-member">
                            <div class="person-avatar">
                                ${d?`<img src="${o(d)}" alt="${r}" />`:ee()}
                            </div>
                            <div class="person-name" title="${r}">${r}</div>
                            <div class="person-character" title="${i}">${i}</div>
                        </div>
                    `}).join("")}
            </div>
        </div>
    `:""}function ge(e,n){let t=g(e)??{},r=B(t,n),i=a(n==="movie"?t.releaseDate:t.firstAirDate),d=K(t,i),s=y(c,"formatCurrency"),S=t.budget?s(t.budget):null,M=t.revenue?s(t.revenue):null,C=x("original",t.backdropPath),I=x("w500",t.posterPath),b=u(t.genres).map(te=>o(a(te.name))).join(", ")||"N/A",v=m(t.tagline),w=m(t.overview),R=h(t.id)??"";return`
        <div class="modal-overlay">
            <div class="modal-container">
                <button class="modal-refresh" aria-label="Refresh" title="Refresh status">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="23 4 23 10 17 10"></polyline>
                        <polyline points="1 20 1 14 7 14"></polyline>
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36M20.49 15a9 9 0 0 1-14.85 3.36"></path>
                    </svg>
                </button>
                <button class="modal-close" aria-label="Close">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </button>

                <div class="modal-backdrop" style="background-image: url('${o(C)}');">
                    <div class="je-modal-backdrop-overlay"></div>
                </div>

                <div class="modal-content">
                    <div class="modal-main">
                        <div class="modal-left">
                            <div class="header-section">
                                <div class="header-poster">
                                    ${I?`<img src="${o(I)}" alt="${o(r)}" />`:""}
                                </div>
                                <div class="header-info">
                                    <div class="title-row">
                                    <h1 class="title">${o(r)} ${d?`<span class="year">(${o(d)})</span>`:""}</h1>
                                    <div class="title-chip" data-mount="je-status-chip"></div>
                                    </div>
                                    <div class="meta-info">
                                        ${ce(t,n)}
                                        <span class="runtime">${o(H(t,n))}</span>
                                        <span class="genres">${b}</span>
                                    </div>
                                    ${v?`<p class="tagline">${o(v)}</p>`:""}
                                    <div class="je-requested-by" data-mount="je-requested-by"></div>
                                    <div class="je-downloads" data-mount="je-downloads"></div>
                                    <div class="je-more-info-actions" data-mount="je-actions"></div>
                                    <div class="je-more-info-secondary-actions" data-mount="je-secondary-actions"></div>
                                </div>
                            </div>

                            ${w?`
                                <div class="overview-section">
                                    <h3>${l("jellyseerr_modal_overview","Overview")}</h3>
                                    <p>${o(w)}</p>
                                </div>
                            `:""}

                            ${Z(t,n)}

                            ${ne(t)}

                            ${X(t)}

                            ${V(t)}
                        </div>

                        <div class="modal-right">
                            ${W(t,n,{budget:S,revenue:M,releaseDate:i,tmdbId:R})}
                        </div>
                    </div>

                    ${n==="tv"?y(c,"buildSeasonsSection")(t):""}
                </div>
            </div>
        </div>
    `}c.buildModalContent=ge;c.buildRightPanel=W;c.buildStreamingProviders=Y;c.buildCollectionCard=G;c.buildKeywordsSection=V;c.buildCrewSection=Z;c.buildTrailersSection=X;c.buildCastSection=ne;c.buildPersonPlaceholder=ee;})();
})();
