(() => {
"use strict";(()=>{function M(e){let r=window.JellyfinEnhanced?.core?.sharedModules?.[e];if(!r)throw new Error(`${e} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return r}function g(e,r){return e[r]}var V=M("features/details-providers/host"),K=g(V,"api"),ie=g(V,"bridge");var le=g(V,"hasApi");var W=M("features/details-providers/page");var de=g(W,"hashItemId");var ce=g(W,"lookupDetailsItem");var pe=g(W,"visibleDetailPage");var Le=M("features/details-providers/links"),G=g(Le,"externalLink");var A=M("features/details-providers/wire");var O=g(A,"field"),X=g(A,"int"),Z=g(A,"isRecord"),Q=g(A,"list"),Y=g(A,"num");var w=g(A,"str");function R(e){let r=[];if(!e)return r;for(let t of e.split(`
`)){let i=t.trim();if(!i)continue;let c=i.split("|").map(F=>F.trim()),[y,v]=c;c.length===2&&y&&v&&r.push({jellyfinUrl:y,arrUrl:v})}return r}function L(e,r,t){if(!r)return null;if(e.length===0)return r;let i=t.replace(/\/+$/,"").toLowerCase();for(let c of e)if(i===c.jellyfinUrl.replace(/\/+$/,"").toLowerCase())return c.arrUrl.replace(/\/$/,"");return r}function ee(e,r,t){return(e||[]).filter(i=>!!i&&i.Enabled!==!1).map(i=>({name:i.Name||r,url:L(R(i.UrlMappings||""),i.Url,t)})).filter(i=>!!i.url)}function D(e){return!e||e<=0?"":e<1073741824?(e/1048576).toFixed(0)+" MB":(e/1073741824).toFixed(1)+" GB"}function ue(e,r){return e===0?"missing":e>=r?"complete":"partial"}function re(e){let r=O(e,"errors");if(Array.isArray(r))return r.map(t=>({instanceName:w(O(t,"instanceName")),reason:w(O(t,"reason"))}))}function ge(e,r){return Q(O(e,"matches")).filter(Z).map(t=>({instanceName:w(t.instanceName),instanceUrl:L(R(w(t.urlMappings)||""),w(t.instanceUrl),r),titleSlug:w(t.titleSlug)??"",episodeFileCount:X(t.episodeFileCount)||0,episodeCount:X(t.episodeCount)||0,sizeOnDisk:Y(t.sizeOnDisk)||0,rootFolderPath:w(t.rootFolderPath)||""}))}function fe(e,r){return Q(O(e,"matches")).filter(Z).map(t=>({name:w(t.instanceName),url:L(R(w(t.urlMappings)||""),w(t.instanceUrl),r),hasFile:t.hasFile===!0,sizeOnDisk:Y(t.sizeOnDisk)||0,rootFolderPath:w(t.rootFolderPath)||""}))}var me=e=>e.replace(/\/$/,"");function he(e){return`${me(e.instanceUrl)}/series/${e.titleSlug}`}function be(e,r){return`${me(e.url)}/movie/${r}`}function xe(e,r){let t=e.episodeFileCount>=0,i=D(e.sizeOnDisk),c=[e.instanceName??""];return t&&c.push(`${e.episodeFileCount}/${e.episodeCount} episodes`),i&&c.push(i),e.rootFolderPath&&c.push(e.rootFolderPath),{url:he(e),status:r&&t?ue(e.episodeFileCount,e.episodeCount):null,badge:r&&t?`${e.episodeFileCount}/${e.episodeCount}`:"",tip:c.join(`
`)}}function we(e){return e.map(r=>{let t=r.episodeFileCount<0?null:ue(r.episodeFileCount,r.episodeCount),i=r.episodeFileCount<0?"":`${r.episodeFileCount}/${r.episodeCount}`,c=D(r.sizeOnDisk),y=[i?`${i} episodes`:null,c,r.rootFolderPath].filter(Boolean).join(" • ");return{name:r.instanceName??"",url:he(r),status:t,badge:i,size:c,tip:y}})}function ke(e,r,t){let i=e.hasFile?"complete":"missing",c=e.hasFile?"Downloaded":"Missing";return{url:be(e,r),status:t?i:null,badge:t?c:"",tip:[e.name,c,D(e.sizeOnDisk),e.rootFolderPath].filter(Boolean).join(`
`)}}function ye(e,r){return e.map(t=>{let i=t.hasFile?"complete":"missing",c=t.hasFile?"Downloaded":"Missing",y=D(t.sizeOnDisk);return{name:t.name??"",url:be(t,r),status:i,badge:c,size:y,tip:[c,y,t.rootFolderPath].filter(Boolean).join(" • ")}})}function Ce(e){let r={tmdb:null,hasTmdbLink:!1};for(let t of e)t.includes("themoviedb.org/movie/")?(r.tmdb=t.match(/\/movie\/(\d+)/)?.[1]??null,r.hasTmdbLink=!0):t.includes("themoviedb.org/tv/")&&(r.tmdb=t.match(/\/tv\/(\d+)/)?.[1]??null,r.hasTmdbLink=!0);return r}var s=ie("Arr links"),k="🪼 Jellyfin Enhanced: Arr Links:",ne=()=>le()&&typeof K().serverAddress=="function"?K().serverAddress?.()??window.location.origin:window.location.origin;s.initializeArrLinksScript=async function(){if(!s.pluginConfig.ArrLinksEnabled){console.log(`${k} Integration disabled in plugin settings.`);return}let r=s.session?s.session.getEpoch():0,t=()=>!s.session||s.session.isCurrent(r),i=s.helpers.isAdmin();if(console.log(`${k} Admin status: ${i}`),!i){console.log(`${k} User is not an administrator. Links will not be shown.`);return}console.log(`${k} Initializing...`),s.pluginConfig.SonarrInstancesCorrupt&&typeof s.toast=="function"&&(s.toast("⚠ Sonarr instance configuration is corrupt. Open the Jellyfin Enhanced config page to reset it."),console.error(`${k} SonarrInstances stored JSON is corrupt.`)),s.pluginConfig.RadarrInstancesCorrupt&&typeof s.toast=="function"&&(s.toast("⚠ Radarr instance configuration is corrupt. Open the Jellyfin Enhanced config page to reset it."),console.error(`${k} RadarrInstances stored JSON is corrupt.`));let c=!1,y=null,v=null,F=new Map,te=new Map;try{let B=function(n,a){if(!a||a.length===0){for(let o of[...E])o.startsWith(n+"|")&&E.delete(o);return}let l=new Set;for(let o of a){let p=`${n}|${o.instanceName}|${o.reason}`;l.add(p),!E.has(p)&&(E.add(p),typeof s.toast=="function"&&s.toast("⚠ "+U(n)+' instance "'+U(o.instanceName||"unknown")+'" failed: '+U(o.reason)),console.warn(`${k} ${n} instance "${o.instanceName}" error: ${o.reason}`))}for(let o of[...E])o.startsWith(n+"|")&&!l.has(o)&&E.delete(o)},_=function(n,a){let l=n==="Sonarr"?"sonarr":"radarr";P[l]||(P[l]=!0,typeof s.toast=="function"&&s.toast("⚠ "+U(n)+" lookup failed; links unavailable. See console for details."),console.warn(`${k} ${n} lookup backend failed:`,a))},J=function(n,a){let l=Object.prototype.hasOwnProperty.call(ae,n)?ae[n]:void 0;if(!l)return null;let o=document.createElement("img");o.src=l,o.alt=a,o.className="arr-link-img";let p=s.helpers.getExternalLinkIconSize();return o.style.width=`${p}px`,o.style.height=`${p}px`,o},N=function(n,a,l,o=null,p="",u=""){let f=o?` arr-link--${o}`:"",C=G(s.helpers,a,{title:u||n,className:`button-link emby-button arr-link${f}`});if(H()){if(C.textContent=n,p){let d=document.createElement("span");d.className=`arr-badge arr-badge--${o||"missing"}`,d.textContent=p,C.appendChild(d)}}else{let d=J(l,n);d&&C.appendChild(d)}return C},q=function(n,a,l){let o=document.createElement("span");o.className="arr-dropdown";let p=s.themer?.getThemeVariables?.()||{};o.style.setProperty("--arr-menu-bg",p.secondaryBg||"rgba(20,20,28,0.98)"),o.style.setProperty("--arr-menu-text",p.textColor||"#fff"),o.style.setProperty("--arr-menu-border","rgba(255,255,255,0.2)"),o.style.setProperty("--arr-menu-hover","rgba(255,255,255,0.1)"),o.style.setProperty("--arr-menu-muted","rgba(255,255,255,0.55)");let u=document.createElement("a");if(u.setAttribute("is","emby-linkbutton"),u.className="button-link emby-button arr-link",u.href="#",u.title=`${n} (${l.length} instances)`,H())u.textContent=n;else{let d=J(a,n);d&&u.appendChild(d)}let f=document.createElement("span");f.textContent="▾",f.style.cssText="font-size:0.8em; opacity:0.8; margin-left:2px; line-height:1; vertical-align:middle; color: white;",u.appendChild(f),u.addEventListener("click",d=>{d.preventDefault(),d.stopPropagation(),document.querySelectorAll(".arr-dropdown.open").forEach(m=>{m!==o&&m.classList.remove("open")}),o.classList.toggle("open")});let C=document.createElement("div");C.className="arr-dropdown-menu";for(let d of l){let m=G(s.helpers,d.url,{title:d.tip||d.name,className:"arr-dropdown-item"}),I=document.createElement("span");I.className=`arr-dropdown-dot arr-dropdown-dot--${d.status||"missing"}`,m.appendChild(I);let h=document.createElement("span");if(h.className="arr-dropdown-item-name",h.textContent=d.name,m.appendChild(h),d.badge){let b=document.createElement("span");b.className=`arr-badge arr-badge--${d.status||"missing"}`,b.textContent=d.badge,m.appendChild(b)}if(d.size){let b=document.createElement("span");b.className="arr-dropdown-item-stats",b.textContent=d.size,m.appendChild(b)}C.appendChild(m)}return o.append(u,C),o};var Ae=B,Oe=_,$e=J,Fe=N,Pe=q;let j=s.cdn.selfhst("svg/sonarr.svg"),Se=s.cdn.selfhst("svg/radarr-light-hybrid-light.svg"),ve=s.cdn.selfhst("svg/bazarr.svg"),$=ne(),S=s.pluginConfig,z=ee(S.SonarrInstances,"Sonarr",$),T=ee(S.RadarrInstances,"Radarr",$);if(z.length===0&&S.SonarrUrl){let n=L(R(S.SonarrUrlMappings||""),S.SonarrUrl,$);n&&z.push({name:"Sonarr",url:n})}if(T.length===0&&S.RadarrUrl){let n=L(R(S.RadarrUrlMappings||""),S.RadarrUrl,$);n&&T.push({name:"Radarr",url:n})}let oe=L(R(S.BazarrUrlMappings||""),S.BazarrUrl,$),se="arr-links-styles";if(!document.getElementById(se)){let n=document.createElement("style");n.id=se,n.textContent=Ee,document.head.appendChild(n)}let P={sonarr:!1,radarr:!1},E=new Set,U=n=>{let a=s.helpers.escHtml;return a?a(n):String(n??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")};async function Ie(n){if(!n)return[];let a=F.get(n);if(a)return a;try{let l=await s.core.api.plugin(`/arr/series-slugs?tvdbId=${encodeURIComponent(n)}`);P.sonarr=!1,B("Sonarr",re(l));let o=ge(l,ne());return F.set(n,o),o}catch(l){return _("Sonarr",l),[]}}async function Me(n){if(!n)return[];let a=te.get(n);if(a)return a;try{let l=await s.core.api.plugin(`/arr/movie-instances?tmdbId=${encodeURIComponent(n)}`);P.radarr=!1,B("Radarr",re(l));let o=fe(l,ne());return te.set(n,o),o}catch(l){return _("Radarr",l),[]}}let ae={"arr-link-sonarr":j,"arr-link-radarr":Se,"arr-link-bazarr":ve},H=()=>!!s.pluginConfig.ShowArrLinksAsText;async function Re(){if(c)return;let n=pe();if(!n)return;let a=n.querySelector(".itemExternalLinks");if(document.querySelectorAll("#itemDetailPage.hide .arr-link").forEach(u=>{u.previousSibling?.nodeType===Node.TEXT_NODE&&u.previousSibling.remove(),u.remove()}),!a||a.querySelector(".arr-link"))return;let l=window.location.hash,o=()=>document.contains(a)&&!a.closest("#itemDetailPage.hide")&&window.location.hash===l&&t(),p=()=>a.appendChild(document.createTextNode(H()?", ":" "));c=!0;try{let u=de();if(!u)return;let f=await ce(s.helpers,u,!1);if(!o()||f?.Type!=="Movie"&&f?.Type!=="Series")return;let C=Ce([...n.querySelectorAll(".itemExternalLinks a, .externalIdLinks a")].map(I=>I.href));if(!C.hasTmdbLink)return;let d=s.pluginConfig.ArrLinksShowStatusSingle===!0;if(f.Type==="Series"&&f.Name&&z.length>0){let I=await Ie(f.ProviderIds.Tvdb||"");if(!o())return;let h=I.filter(x=>!!x.instanceUrl),[b]=h;if(h.length===1&&b){let x=xe(b,d);p(),a.appendChild(N("Sonarr",x.url,"arr-link-sonarr",x.status,x.badge,x.tip))}else h.length>1&&(p(),a.appendChild(q("Sonarr","arr-link-sonarr",we(h))))}let m=C.tmdb;if(f.Type==="Movie"&&m&&T.length>0){let I=await Me(m);if(!o())return;let h=I.filter(x=>!!x.url),[b]=h;if(h.length===1&&b){let x=ke(b,m,d);p(),a.appendChild(N("Radarr",x.url,"arr-link-radarr",x.status,x.badge,x.tip))}else h.length>1&&(p(),a.appendChild(q("Radarr","arr-link-radarr",ye(h,m))))}oe&&(f.Type==="Series"||f.Type==="Movie")&&(p(),a.appendChild(N("Bazarr",`${oe}/${f.Type==="Series"?"series":"movies"}/`,"arr-link-bazarr")))}finally{c=!1}}if(s._arrDropdownCloserInstalled||(s._arrDropdownCloserInstalled=!0,document.addEventListener("click",n=>{let a=n.target;(!(a instanceof Element)||!a.closest(".arr-dropdown"))&&document.querySelectorAll(".arr-dropdown.open").forEach(l=>l.classList.remove("open"))})),!t())return;v=s.helpers.createObserver("arr-links",()=>{if(s.session&&!s.session.isCurrent(r)){v&&(v.disconnect(),console.log(`${k} Observer disconnected — user changed`));return}if(!s.pluginConfig.ArrLinksEnabled){v&&(v.disconnect(),console.log(`${k} Observer disconnected — feature disabled`));return}y&&clearTimeout(y),y=setTimeout(()=>{Re()},100)},document.body,{childList:!0,subtree:!0})||null,s._arrLinksObserver=v,console.log(`${k} Initialized successfully`)}catch(j){console.error(`${k} Failed to initialize`,j)}};document.addEventListener("je:user-data-loaded",()=>{if(s.pluginConfig.ArrLinksEnabled){try{s._arrLinksObserver?.disconnect()}catch{}s.initializeArrLinksScript?.()}});var Ee=`
                    /* Status colors on the link button border */
                    .arr-link--complete { border-left: 3px solid #52b54b !important; }
                    .arr-link--partial  { border-left: 3px solid #e5a00d !important; }
                    .arr-link--missing  { border-left: 3px solid #666 !important; opacity: 0.7; }

                    /* Icon image inside the button */
                    .arr-link-img {
                        width: 25px;
                        height: 25px;
                        display: block;
                        object-fit: contain;
                    }

                    /* Status badge (text-mode only) */
                    .arr-badge {
                        font-size: 0.75em;
                        padding: 1px 5px;
                        border-radius: 3px;
                        margin-left: 6px;
                        vertical-align: middle;
                        font-weight: 600;
                    }
                    .arr-badge--complete { background: rgba(82,181,75,0.2); color: #52b54b; }
                    .arr-badge--partial  { background: rgba(229,160,13,0.2); color: #e5a00d; }
                    .arr-badge--missing  { background: rgba(102,102,102,0.2); color: #999; }

                    /* Dropdown wrapper — sits inline with sibling link buttons */
                    .arr-dropdown {
                        position: relative;
                        display: inline-block;
                    }

                    /* Dropdown menu — colours injected as CSS vars at render time */
                    .arr-dropdown-menu {
                        display: none;
                        position: absolute;
                        top: calc(100% + 6px);
                        left: 0;
                        z-index: 9999;
                        min-width: 240px;
                        background: var(--arr-menu-bg, rgba(20,20,28,0.98));
                        color: var(--arr-menu-text, #fff);
                        border: 1px solid var(--arr-menu-border, rgba(255,255,255,0.2));
                        border-radius: 8px;
                        box-shadow: 0 12px 32px rgba(0,0,0,0.6);
                        padding: 4px 0;
                        backdrop-filter: blur(12px);
                        -webkit-backdrop-filter: blur(12px);
                    }
                    .arr-dropdown.open .arr-dropdown-menu { display: block; }

                    .arr-dropdown-item {
                        display: flex;
                        align-items: center;
                        gap: 10px;
                        padding: 9px 14px;
                        color: var(--arr-menu-text, #fff);
                        text-decoration: none;
                        font-size: 0.9em;
                        white-space: nowrap;
                        transition: background 0.12s;
                    }
                    .arr-dropdown-item:hover {
                        background: var(--arr-menu-hover, rgba(255,255,255,0.1));
                        color: var(--arr-menu-text, #fff);
                    }
                    .arr-dropdown-item-name { flex: 1; font-weight: 500; }
                    .arr-dropdown-item-stats {
                        color: var(--arr-menu-muted, rgba(255,255,255,0.55));
                        font-size: 0.85em;
                    }
                    .arr-dropdown-dot {
                        width: 8px;
                        height: 8px;
                        border-radius: 50%;
                        flex-shrink: 0;
                    }
                    .arr-dropdown-dot--complete { background: #52b54b; }
                    .arr-dropdown-dot--partial  { background: #e5a00d; }
                    .arr-dropdown-dot--missing  { background: #888; }

                    /* Progress bar */
                    .arr-progress {
                        display: block;
                        height: 2px;
                        margin-top: 2px;
                        border-radius: 1px;
                        background: rgba(255,255,255,0.1);
                        overflow: hidden;
                    }
                    .arr-progress-fill { height: 100%; border-radius: 1px; transition: width 0.3s; }
                    .arr-progress-fill--complete { background: #52b54b; }
                    .arr-progress-fill--partial  { background: #e5a00d; }
                    .arr-progress-fill--missing  { background: #666; }
                `;})();
})();
