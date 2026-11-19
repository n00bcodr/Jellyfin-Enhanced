(() => {
"use strict";(()=>{function m(e){let n=window.JellyfinEnhanced?.core?.sharedModules?.[e];if(!n)throw new Error(`${e} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return n}function d(e,n){return e[n]}var E=m("features/details-providers/host");var R=d(E,"bridge");var D=d(E,"currentUserId");var x=m("features/details-providers/page"),M=d(x,"detailPageHook"),L=d(x,"detailsLease");var $=d(x,"hashItemId");var C=d(x,"lookupDetailsItem");var O=d(x,"removeFirst");function P(e){return encodeURIComponent(e)}var f=m("features/details-providers/wire");var N=d(f,"field");var S=d(f,"isRecord"),F=d(f,"list"),h=d(f,"num");var T=d(f,"str"),I=d(f,"stringList");async function _(e,n,i){let l=e?.Type;if(!e)return{target:null,unsupported:!0};if(l==="Movie")return{target:A(e.ProviderIds.Tmdb,"movie"),unsupported:!1};if(l==="Person"&&n)return{target:A(e.ProviderIds.Tmdb,"person"),unsupported:!1};if(l==="Series"||l==="Season"||l==="Episode"){let c;if(l==="Series")c=e.ProviderIds.Tmdb;else if(e.SeriesId)try{c=(await i(e.SeriesId))?.ProviderIds.Tmdb}catch{}return{target:A(c,"tv"),unsupported:!1}}return{target:null,unsupported:!0}}function A(e,n){return e?{tmdbId:e,mediaType:n}:null}function B(e){return N(e,"Confirmed")===!1}function U(e){return S(e)?{found:!!e.Found,wins:h(e.Wins)||0,nominations:h(e.Nominations)||0,awards:F(e.Awards).filter(S).map(n=>({name:T(n.Name)??"",result:T(n.Result)??"",year:h(n.Year),recipients:I(n.Recipients),works:I(n.Works)}))}:null}function z(e){return[...e].sort((n,i)=>{let l=(i.year||0)-(n.year||0);return l!==0?l:(n.result==="Won"?0:1)-(i.result==="Won"?0:1)})}var q=[["Academy Award","oscar"],["Golden Globe Award","golden-globe"],["BAFTA Award","bafta"],["Primetime Emmy Award","emmy"],["Daytime Emmy Award","emmy"],["Screen Actors Guild Award","sag"],["Critics' Choice","critics-choice"],["National Board of Review","national-board-of-review"],["Saturn Award","saturn",!0],["Kids' Choice Award","kids-choice"],["Toronto Film Critics Association Award","toronto-critics",!0],["Palme d'Or","cannes"],["Cannes Film Festival Award","cannes"]];function V(e){let n=q.find(([i])=>e.startsWith(i));return n?{file:n[1],invert:!!n[2]}:null}function H(){let e=(l,c,b,y,v="")=>`<svg class="${v}" viewBox="0 0 24 24" width="${b}" height="${b}" style="left:${l}%; top:${c}%; opacity:${y};">
                    <path d="M12 0 L14 10 L24 12 L14 14 L12 24 L10 14 L0 12 L10 10 Z"/>
                </svg>`,n=e(38,18,8,.4)+e(50,68,12,.3)+e(28,65,7,.35),i=e(70,20,10,.5,"je-spark-wide")+e(80,60,16,.35,"je-spark-wide")+e(90,25,22,.9,"je-spark-wide");return n+i}var a=R("Awards");a.initializeAwardsScript=function(){if(!a.pluginConfig?.ShowAwards){console.log("🪼 Jellyfin Enhanced: Awards feature disabled.");return}let n="🪼 Jellyfin Enhanced: Awards:",i=t=>typeof a.escapeHtml=="function"?a.escapeHtml(t):String(t);function l(){let t="je-awards-styles";if(document.getElementById(t))return;let r=document.createElement("style");r.id=t,r.textContent=Y,document.head.appendChild(r)}function c(t){try{O(t,".je-awards-section")}catch(r){console.warn(`${n} removeAwardsSection failed:`,r)}}async function b(t,r){try{let o=`awards:/${r}/${t}`,s=await a.core.api.plugin(`/awards/${r}/${P(t)}`,{cacheKey:o});return B(s)&&a.core.api.manager.clearCacheMatching(o),U(s)}catch(o){return console.warn(`${n} Failed to fetch awards.`,o),null}}function y(t){let r=document.createElement("div");r.className="je-awards-list";for(let o of z(t.awards)){let s=document.createElement("div");s.className="je-awards-row";let u=o.result==="Won",g=u?"je-awards-badge-won":"je-awards-badge-nominated",j=u?a.t("awards_won"):a.t("awards_nominated"),w="";o.recipients.length?w=`<div class="je-awards-recipients">${i(o.recipients.join(", "))}</div>`:o.works.length&&(w=`<div class="je-awards-recipients">${i(a.t("awards_for_work",{work:o.works.join(", ")}))}</div>`);let k=V(o.name);if(s.innerHTML=`
                    <div class="je-awards-row-main">
                        <span class="je-awards-badge ${g}">${i(j)}</span>
                        <div>
                            <div class="je-awards-row-name">${i(o.name)}</div>
                            ${w}
                        </div>
                    </div>
                    <div class="je-awards-row-side">
                        ${o.year?`<span class="je-awards-row-year">${i(String(o.year))}</span>`:""}
                    </div>
                `,k){let p=document.createElement("img");p.className=`je-awards-body-icon${k.invert?" je-awards-body-icon-invert":""}`,p.src=a.cdn.url("award-logos",k.file),p.alt="",p.loading="lazy",p.onerror=()=>p.remove(),s.querySelector(".je-awards-row-side")?.prepend(p)}r.appendChild(s)}return r}function v(t){let r=document.createElement("details");r.className="detailSection je-awards-section";let o=[];t.wins>0&&o.push(a.t("awards_wins_count",{count:t.wins})),t.nominations>0&&o.push(a.t("awards_nominations_count",{count:t.nominations}));let s=document.createElement("summary");return s.className="je-awards-summary",s.innerHTML=`
                <div class="je-awards-sparkles" aria-hidden="true">${H()}</div>
                <div class="je-awards-label">
                    <span class="je-msym-rounded je-awards-star" aria-hidden="true">auto_awesome</span>
                    <span class="je-awards-wordmark">${i(a.t("awards_label"))}</span>
                </div>
                <div class="je-awards-divider"></div>
                <div class="je-awards-stats">${o.map(i).join(" &nbsp;|&nbsp; ")}</div>
                <i class="material-icons expand-icon" aria-hidden="true">expand_more</i>
            `,r.appendChild(s),r.appendChild(y(t)),r}function G(t,r){if(c(t),!r||!r.found||r.wins===0&&r.nominations===0)return;let o=v(r),s=t.querySelector(".tmdb-reviews-section")||t.querySelector(".streaming-lookup-container")||t.querySelector(".itemExternalLinks")||t.querySelector(".tagline");if(s?.parentNode){s.parentNode.insertBefore(o,s.nextSibling);return}let u=t.querySelector("#similarCollapsible");if(u?.parentNode){u.parentNode.insertBefore(o,u);return}console.error(`${n} Could not find a suitable anchor to insert the awards banner. contextPage:`,t)}async function J(t){if(!a.pluginConfig?.ShowAwards){c(t);return}try{let r=$(),o=D();if(!r||!o)return;let s=L(a.session,r,t),u=await C(a.helpers,r,!0,o),{target:g}=await _(u,!0,w=>C(a.helpers,w,!0,o));if(!s.current())return;if(!g){s.current()&&c(t);return}let j=await b(g.tmdbId,g.mediaType);s.current()&&G(t,j)}catch(r){console.error(`${n} Error processing page:`,r)}}l();let W=a.helpers.onViewPage(M(()=>!!a.pluginConfig?.ShowAwards,()=>W?.(),t=>{J(t)},!0),{pages:null,fetchItem:!1,immediate:!0})};var Y=`
                .je-awards-label .je-msym-rounded {
                    font-family: 'JE Material Symbols Rounded';
                    font-weight: normal;
                    font-style: normal;
                    line-height: 1;
                    letter-spacing: normal;
                    text-transform: none;
                    display: inline-block;
                    white-space: nowrap;
                    word-wrap: normal;
                    direction: ltr;
                    -webkit-font-feature-settings: 'liga';
                    font-feature-settings: 'liga';
                }
                .je-awards-section {
                    /* Some themes (e.g. ElegantFin) style .detailSection as a
                       grid, which blows this <details> out to a huge width —
                       force flex like reviews.js's .tmdb-reviews-section. */
                    display: flex !important;
                    flex-direction: column;
                    width: 100%;
                    min-width: 0;
                    row-gap: 0px !important;
                    position: relative;
                    overflow: hidden;
                    margin: 1em 0;
                    border-radius: 10px;
                    color: #fff;
                    background: linear-gradient(115deg, #0d2b3a 0%, #113a4d 45%, #0f4a63 100%);
                    box-shadow: inset 0 0 0 1px rgba(255,255,255,0.08);
                }
                .je-awards-summary {
                    position: relative;
                    display: flex;
                    align-items: center;
                    gap: 14px;
                    padding: 14px 20px;
                    cursor: pointer;
                    list-style: none;
                }
                .je-awards-summary::-webkit-details-marker {
                    display: none;
                }
                .je-awards-summary .je-awards-sparkles {
                    position: absolute;
                    inset: 0;
                    pointer-events: none;
                    opacity: 0.55;
                }
                .je-awards-summary .je-awards-sparkles svg {
                    position: absolute;
                    fill: #fff;
                }
                @media (max-width: 480px) {
                    .je-awards-summary .je-awards-sparkles .je-spark-wide {
                        display: none;
                    }
                }
                .je-awards-label {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    z-index: 1;
                    white-space: nowrap;
                    line-height: 1;
                }
                .je-awards-label .je-awards-star {
                    font-size: 20px;
                    color: #ffd76b;
                }
                .je-awards-wordmark {
                    font-family: Georgia, 'Times New Roman', serif;
                    letter-spacing: 0.12em;
                    font-size: 18px;
                    font-weight: 600;
                    text-transform: uppercase;
                    line-height: 1;
                }
                .je-awards-divider {
                    z-index: 1;
                    width: 1px;
                    align-self: stretch;
                    background: rgba(255,255,255,0.25);
                }
                .je-awards-stats {
                    z-index: 1;
                    font-size: 13px;
                    font-weight: 500;
                    color: rgba(255,255,255,0.92);
                    white-space: nowrap;
                    line-height: 1;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .je-awards-summary .expand-icon {
                    z-index: 1;
                    margin-left: auto;
                    opacity: 0.75;
                    transition: transform 0.2s ease-in-out;
                }
                .je-awards-section[open] .je-awards-summary .expand-icon {
                    transform: rotate(180deg);
                }

                .je-awards-list {
                    padding: 4px 12px 14px;
                }
                .je-awards-row {
                    display: flex;
                    align-items: flex-start;
                    justify-content: space-between;
                    gap: 12px;
                    padding: 10px 8px;
                    border-top: 1px solid rgba(255,255,255,0.08);
                }
                .je-awards-row-main {
                    display: flex;
                    align-items: flex-start;
                    gap: 10px;
                    min-width: 0;
                }
                .je-awards-row-side {
                    flex: none;
                    display: flex;
                    align-items: center;
                    gap: 6px;
                }
                .je-awards-body-icon {
                    flex: none;
                    width: 25px;
                    height: 25px;
                    object-fit: contain;
                }
                .je-awards-body-icon-invert {
                    /* Flat black silhouette on transparent, e.g. Saturn Award —
                       force white so it reads against the dark banner instead
                       of nearly disappearing. */
                    filter: brightness(0) invert(1);
                }
                .je-awards-badge {
                    flex: none;
                    margin-top: 1px;
                    padding: 2px 8px;
                    border-radius: 20px;
                    font-size: 11px;
                    font-weight: 700;
                    text-transform: uppercase;
                    letter-spacing: 0.03em;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    min-width: 88px;
                    text-align: center;
                }
                @media (max-width: 480px) {
                    .je-awards-badge {
                        min-width: 58px;
                        padding: 2px 6px;
                        font-size: 9px;
                    }
                }
                .je-awards-badge-won {
                    background: rgba(255,215,107,0.18);
                    color: #ffd76b;
                }
                .je-awards-badge-nominated {
                    background: rgba(255,255,255,0.1);
                    color: rgba(255,255,255,0.75);
                }
                .je-awards-row-name {
                    font-size: 13.5px;
                    font-weight: 500;
                    line-height: 1.35;
                    color: #fff;
                }
                .je-awards-recipients {
                    margin-top: 2px;
                    font-size: 12px;
                    color: rgba(255,255,255,0.6);
                    line-height: 1.35;
                }
                .je-awards-row-year {
                    flex: none;
                    font-size: 12px;
                    color: rgba(255,255,255,0.5);
                }
            `;})();
})();
