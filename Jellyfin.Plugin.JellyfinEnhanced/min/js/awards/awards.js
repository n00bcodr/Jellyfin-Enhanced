(() => {
"use strict";(()=>{function m(e){let r=window.JellyfinEnhanced?.core?.sharedModules?.[e];if(!r)throw new Error(`${e} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return r}function d(e,r){return e[r]}var C=m("features/details-providers/host");var I=d(C,"bridge");var A=d(C,"currentUserId");var x=m("features/details-providers/page"),D=d(x,"detailPageHook"),R=d(x,"detailsLease");var H=d(x,"hashItemId");var j=d(x,"lookupDetailsItem");var N=d(x,"removeFirst");function $(e){return encodeURIComponent(e)}var f=m("features/details-providers/wire");var O=d(f,"field");var S=d(f,"isRecord"),P=d(f,"list"),h=d(f,"num");var M=d(f,"str"),k=d(f,"stringList");async function F(e,r,a){let l=e?.Type;if(!e)return{target:null,unsupported:!0};if(l==="Movie")return{target:L(e.ProviderIds.Tmdb,"movie"),unsupported:!1};if(l==="Person"&&r)return{target:L(e.ProviderIds.Tmdb,"person"),unsupported:!1};if(l==="Series"||l==="Season"||l==="Episode"){let c;if(l==="Series")c=e.ProviderIds.Tmdb;else if(e.SeriesId)try{c=(await a(e.SeriesId))?.ProviderIds.Tmdb}catch{}return{target:L(c,"tv"),unsupported:!1}}return{target:null,unsupported:!0}}function L(e,r){return e?{tmdbId:e,mediaType:r}:null}function B(e){return O(e,"Confirmed")===!1}function _(e){return S(e)?{found:!!e.Found,wins:h(e.Wins)||0,nominations:h(e.Nominations)||0,awards:P(e.Awards).filter(S).map(r=>({name:M(r.Name)??"",result:M(r.Result)??"",year:h(r.Year),recipients:k(r.Recipients),works:k(r.Works)}))}:null}function q(e){return[...e].sort((r,a)=>{let l=(a.year||0)-(r.year||0);return l!==0?l:(r.result==="Won"?0:1)-(a.result==="Won"?0:1)})}var J=[["Academy Award","oscar"],["Golden Globe Award","golden-globe"],["BAFTA Award","bafta"],["Primetime Emmy Award","emmy"],["Daytime Emmy Award","emmy"],["Screen Actors Guild Award","sag"],["Critics' Choice","critics-choice"],["National Board of Review","national-board-of-review"],["Saturn Award","saturn",!0],["Kids' Choice Award","kids-choice"],["Toronto Film Critics Association Award","toronto-critics",!0],["Palme d'Or","cannes"],["Cannes Film Festival Award","cannes"]];function U(e){let r=J.find(([a])=>e.startsWith(a));return r?{file:r[1],invert:!!r[2]}:null}function z(){let e=(l,c,b,y,T="")=>`<svg class="${T}" viewBox="0 0 24 24" width="${b}" height="${b}" style="left:${l}%; top:${c}%; opacity:${y};">
                    <path d="M12 0 L14 10 L24 12 L14 14 L12 24 L10 14 L0 12 L10 10 Z"/>
                </svg>`,r=e(38,18,8,.4)+e(50,68,12,.3)+e(28,65,7,.35),a=e(70,20,10,.5,"je-spark-wide")+e(80,60,16,.35,"je-spark-wide")+e(90,25,22,.9,"je-spark-wide");return r+a}var i=I("Awards");i.initializeAwardsScript=function(){if(!i.pluginConfig?.ShowAwards){console.log("🪼 Jellyfin Enhanced: Awards feature disabled.");return}let r="🪼 Jellyfin Enhanced: Awards:",a=t=>typeof i.escapeHtml=="function"?i.escapeHtml(t):String(t);function l(){let t="je-awards-styles";if(document.getElementById(t))return;let n=document.createElement("style");n.id=t,n.textContent=K,document.head.appendChild(n)}function c(t){try{N(t,".je-awards-section")}catch(n){console.warn(`${r} removeAwardsSection failed:`,n)}}async function b(t,n){try{let o=`awards:/${n}/${t}`,s=await i.core.api.plugin(`/awards/${n}/${$(t)}`,{cacheKey:o});return B(s)&&i.core.api.manager.clearCacheMatching(o),_(s)}catch(o){return console.warn(`${r} Failed to fetch awards.`,o),null}}function y(t){let n=document.createElement("div");n.className="je-awards-list";for(let o of q(t.awards)){let s=document.createElement("div");s.className="je-awards-row";let u=o.result==="Won",g=u?"je-awards-badge-won":"je-awards-badge-nominated",E=u?i.t("awards_won"):i.t("awards_nominated"),w="";o.recipients.length?w=`<div class="je-awards-recipients">${a(o.recipients.join(", "))}</div>`:o.works.length&&(w=`<div class="je-awards-recipients">${a(i.t("awards_for_work",{work:o.works.join(", ")}))}</div>`);let v=U(o.name);if(s.innerHTML=`
                    <div class="je-awards-row-main">
                        <span class="je-awards-badge ${g}">${a(E)}</span>
                        <div>
                            <div class="je-awards-row-name">${a(o.name)}</div>
                            ${w}
                        </div>
                    </div>
                    <div class="je-awards-row-side">
                        ${o.year?`<span class="je-awards-row-year">${a(String(o.year))}</span>`:""}
                    </div>
                `,v){let p=document.createElement("img");p.className=`je-awards-body-icon${v.invert?" je-awards-body-icon-invert":""}`,p.src=i.cdn.url("award-logos",v.file),p.alt="",p.loading="lazy",p.onerror=()=>p.remove(),s.querySelector(".je-awards-row-side")?.prepend(p)}n.appendChild(s)}return n}function T(t){let n=document.createElement("details");n.className="detailSection je-awards-section";let o=[];t.wins>0&&o.push(i.t("awards_wins_count",{count:t.wins})),t.nominations>0&&o.push(i.t("awards_nominations_count",{count:t.nominations}));let s=document.createElement("summary");return s.className="je-awards-summary",s.innerHTML=`
                <div class="je-awards-sparkles" aria-hidden="true">${z()}</div>
                <div class="je-awards-label">
                    <span class="je-msym-rounded je-awards-star" aria-hidden="true">auto_awesome</span>
                    <span class="je-awards-wordmark">${a(i.t("awards_label"))}</span>
                </div>
                <div class="je-awards-divider"></div>
                <div class="je-awards-stats">${o.map(a).join(" &nbsp;|&nbsp; ")}</div>
                <i class="material-icons expand-icon" aria-hidden="true">expand_more</i>
            `,n.appendChild(s),n.appendChild(y(t)),n}function V(t,n){if(c(t),!n||!n.found||n.wins===0&&n.nominations===0)return;let o=T(n),s=t.querySelector(".tmdb-reviews-section")||t.querySelector(".streaming-lookup-container")||t.querySelector(".itemExternalLinks")||t.querySelector(".tagline");if(s?.parentNode){s.parentNode.insertBefore(o,s.nextSibling);return}let u=t.querySelector("#similarCollapsible");if(u?.parentNode){u.parentNode.insertBefore(o,u);return}console.error(`${r} Could not find a suitable anchor to insert the awards banner. contextPage:`,t)}async function W(t){if(!i.pluginConfig?.ShowAwards){c(t);return}try{let n=H(),o=A();if(!n||!o)return;let s=R(i.session,n,t),u=await j(i.helpers,n,!0,o),{target:g}=await F(u,!0,w=>j(i.helpers,w,!0,o));if(!s.current())return;if(!g){s.current()&&c(t);return}let E=await b(g.tmdbId,g.mediaType);s.current()&&V(t,E)}catch(n){console.error(`${r} Error processing page:`,n)}}l();let G=i.helpers.onViewPage(D(()=>!!i.pluginConfig?.ShowAwards,()=>G?.(),t=>{W(t)},!0),{pages:null,fetchItem:!1,immediate:!0})};var K=`
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
