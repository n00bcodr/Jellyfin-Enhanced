(() => {
"use strict";(()=>{function R(e){let n=window.JellyfinEnhanced?.core?.sharedModules?.[e];if(!n)throw new Error(`${e} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return n}function f(e,n){return e[n]}var V=R("features/details-providers/host"),K=f(V,"api"),ie=f(V,"bridge");var le=f(V,"hasApi");var W=R("features/details-providers/page");var de=f(W,"hashItemId");var ce=f(W,"lookupDetailsItem");var pe=f(W,"visibleDetailPage");function ue(e,n){try{let r=new URL(e,n);return["http:","https:","mailto:","tel:","ftp:","blob:"].includes(r.protocol)?e:"#"}catch{return"#"}}function Re(e){return ue(e,window.location.href)}function G(e,n,r={}){let l=e?.createExternalLink;if(l)return l(n,r);let a=document.createElement("a");return a.setAttribute("is","emby-linkbutton"),a.href=Re(n),a.target="_blank",a.rel="noopener noreferrer",r.title&&(a.title=r.title),r.className&&(a.className=r.className),r.text&&(a.textContent=r.text),r.resetStyle&&(a.style.cssText="padding:0;background:none;border-radius:0;min-width:0;"),typeof r.setup=="function"&&r.setup(a),a}var A=R("features/details-providers/wire");var O=f(A,"field"),X=f(A,"int"),Z=f(A,"isRecord"),Q=f(A,"list"),Y=f(A,"num");var w=f(A,"str");function E(e){let n=[];if(!e)return n;for(let r of e.split(`
`)){let l=r.trim();if(!l)continue;let a=l.split("|").map(U=>U.trim()),[y,v]=a;a.length===2&&y&&v&&n.push({jellyfinUrl:y,arrUrl:v})}return n}function L(e,n,r){if(!n)return null;if(e.length===0)return n;let l=r.replace(/\/+$/,"").toLowerCase();for(let a of e)if(l===a.jellyfinUrl.replace(/\/+$/,"").toLowerCase())return a.arrUrl.replace(/\/$/,"");return n}function ee(e,n,r){return(e||[]).filter(l=>!!l&&l.Enabled!==!1).map(l=>({name:l.Name||n,url:L(E(l.UrlMappings||""),l.Url,r)})).filter(l=>!!l.url)}function D(e){return!e||e<=0?"":e<1073741824?(e/1048576).toFixed(0)+" MB":(e/1073741824).toFixed(1)+" GB"}function ge(e,n){return e===0?"missing":e>=n?"complete":"partial"}function re(e){let n=O(e,"errors");if(Array.isArray(n))return n.map(r=>({instanceName:w(O(r,"instanceName")),reason:w(O(r,"reason"))}))}function fe(e,n){return Q(O(e,"matches")).filter(Z).map(r=>({instanceName:w(r.instanceName),instanceUrl:L(E(w(r.urlMappings)||""),w(r.instanceUrl),n),titleSlug:w(r.titleSlug)??"",episodeFileCount:X(r.episodeFileCount)||0,episodeCount:X(r.episodeCount)||0,sizeOnDisk:Y(r.sizeOnDisk)||0,rootFolderPath:w(r.rootFolderPath)||""}))}function me(e,n){return Q(O(e,"matches")).filter(Z).map(r=>({name:w(r.instanceName),url:L(E(w(r.urlMappings)||""),w(r.instanceUrl),n),hasFile:r.hasFile===!0,sizeOnDisk:Y(r.sizeOnDisk)||0,rootFolderPath:w(r.rootFolderPath)||""}))}var he=e=>e.replace(/\/$/,"");function be(e){return`${he(e.instanceUrl)}/series/${e.titleSlug}`}function xe(e,n){return`${he(e.url)}/movie/${n}`}function we(e,n){let r=e.episodeFileCount>=0,l=D(e.sizeOnDisk),a=[e.instanceName??""];return r&&a.push(`${e.episodeFileCount}/${e.episodeCount} episodes`),l&&a.push(l),e.rootFolderPath&&a.push(e.rootFolderPath),{url:be(e),status:n&&r?ge(e.episodeFileCount,e.episodeCount):null,badge:n&&r?`${e.episodeFileCount}/${e.episodeCount}`:"",tip:a.join(`
`)}}function ke(e){return e.map(n=>{let r=n.episodeFileCount<0?null:ge(n.episodeFileCount,n.episodeCount),l=n.episodeFileCount<0?"":`${n.episodeFileCount}/${n.episodeCount}`,a=D(n.sizeOnDisk),y=[l?`${l} episodes`:null,a,n.rootFolderPath].filter(Boolean).join(" • ");return{name:n.instanceName??"",url:be(n),status:r,badge:l,size:a,tip:y}})}function ye(e,n,r){let l=e.hasFile?"complete":"missing",a=e.hasFile?"Downloaded":"Missing";return{url:xe(e,n),status:r?l:null,badge:r?a:"",tip:[e.name,a,D(e.sizeOnDisk),e.rootFolderPath].filter(Boolean).join(`
`)}}function Ce(e,n){return e.map(r=>{let l=r.hasFile?"complete":"missing",a=r.hasFile?"Downloaded":"Missing",y=D(r.sizeOnDisk);return{name:r.name??"",url:xe(r,n),status:l,badge:a,size:y,tip:[a,y,r.rootFolderPath].filter(Boolean).join(" • ")}})}function Se(e){let n={tmdb:null,hasTmdbLink:!1};for(let r of e)r.includes("themoviedb.org/movie/")?(n.tmdb=r.match(/\/movie\/(\d+)/)?.[1]??null,n.hasTmdbLink=!0):r.includes("themoviedb.org/tv/")&&(n.tmdb=r.match(/\/tv\/(\d+)/)?.[1]??null,n.hasTmdbLink=!0);return n}var s=ie("Arr links"),k="🪼 Jellyfin Enhanced: Arr Links:",ne=()=>le()&&typeof K().serverAddress=="function"?K().serverAddress?.()??window.location.origin:window.location.origin;s.initializeArrLinksScript=async function(){if(!s.pluginConfig.ArrLinksEnabled){console.log(`${k} Integration disabled in plugin settings.`);return}let n=s.session?s.session.getEpoch():0,r=()=>!s.session||s.session.isCurrent(n),l=s.helpers.isAdmin();if(console.log(`${k} Admin status: ${l}`),!l){console.log(`${k} User is not an administrator. Links will not be shown.`);return}console.log(`${k} Initializing...`),s.pluginConfig.SonarrInstancesCorrupt&&typeof s.toast=="function"&&(s.toast("⚠ Sonarr instance configuration is corrupt. Open the Jellyfin Enhanced config page to reset it."),console.error(`${k} SonarrInstances stored JSON is corrupt.`)),s.pluginConfig.RadarrInstancesCorrupt&&typeof s.toast=="function"&&(s.toast("⚠ Radarr instance configuration is corrupt. Open the Jellyfin Enhanced config page to reset it."),console.error(`${k} RadarrInstances stored JSON is corrupt.`));let a=!1,y=null,v=null,U=new Map,te=new Map;try{let B=function(t,i){if(!i||i.length===0){for(let o of[...M])o.startsWith(t+"|")&&M.delete(o);return}let d=new Set;for(let o of i){let p=`${t}|${o.instanceName}|${o.reason}`;d.add(p),!M.has(p)&&(M.add(p),typeof s.toast=="function"&&s.toast("⚠ "+P(t)+' instance "'+P(o.instanceName||"unknown")+'" failed: '+P(o.reason)),console.warn(`${k} ${t} instance "${o.instanceName}" error: ${o.reason}`))}for(let o of[...M])o.startsWith(t+"|")&&!d.has(o)&&M.delete(o)},_=function(t,i){let d=t==="Sonarr"?"sonarr":"radarr";F[d]||(F[d]=!0,typeof s.toast=="function"&&s.toast("⚠ "+P(t)+" lookup failed; links unavailable. See console for details."),console.warn(`${k} ${t} lookup backend failed:`,i))},J=function(t,i){let d=Object.prototype.hasOwnProperty.call(ae,t)?ae[t]:void 0;if(!d)return null;let o=document.createElement("img");o.src=d,o.alt=i,o.className="arr-link-img";let p=s.helpers.getExternalLinkIconSize();return o.style.width=`${p}px`,o.style.height=`${p}px`,o},N=function(t,i,d,o=null,p="",u=""){let g=o?` arr-link--${o}`:"",C=G(s.helpers,i,{title:u||t,className:`button-link emby-button arr-link${g}`});if(H()){if(C.textContent=t,p){let c=document.createElement("span");c.className=`arr-badge arr-badge--${o||"missing"}`,c.textContent=p,C.appendChild(c)}}else{let c=J(d,t);c&&C.appendChild(c)}return C},q=function(t,i,d){let o=document.createElement("span");o.className="arr-dropdown";let p=s.themer?.getThemeVariables?.()||{};o.style.setProperty("--arr-menu-bg",p.secondaryBg||"rgba(20,20,28,0.98)"),o.style.setProperty("--arr-menu-text",p.textColor||"#fff"),o.style.setProperty("--arr-menu-border","rgba(255,255,255,0.2)"),o.style.setProperty("--arr-menu-hover","rgba(255,255,255,0.1)"),o.style.setProperty("--arr-menu-muted","rgba(255,255,255,0.55)");let u=document.createElement("a");if(u.setAttribute("is","emby-linkbutton"),u.className="button-link emby-button arr-link",u.href="#",u.title=`${t} (${d.length} instances)`,H())u.textContent=t;else{let c=J(i,t);c&&u.appendChild(c)}let g=document.createElement("span");g.textContent="▾",g.style.cssText="font-size:0.8em; opacity:0.8; margin-left:2px; line-height:1; vertical-align:middle; color: white;",u.appendChild(g),u.addEventListener("click",c=>{c.preventDefault(),c.stopPropagation(),document.querySelectorAll(".arr-dropdown.open").forEach(m=>{m!==o&&m.classList.remove("open")}),o.classList.toggle("open")});let C=document.createElement("div");C.className="arr-dropdown-menu";for(let c of d){let m=G(s.helpers,c.url,{title:c.tip||c.name,className:"arr-dropdown-item"}),I=document.createElement("span");I.className=`arr-dropdown-dot arr-dropdown-dot--${c.status||"missing"}`,m.appendChild(I);let h=document.createElement("span");if(h.className="arr-dropdown-item-name",h.textContent=c.name,m.appendChild(h),c.badge){let b=document.createElement("span");b.className=`arr-badge arr-badge--${c.status||"missing"}`,b.textContent=c.badge,m.appendChild(b)}if(c.size){let b=document.createElement("span");b.className="arr-dropdown-item-stats",b.textContent=c.size,m.appendChild(b)}C.appendChild(m)}return o.append(u,C),o};var Oe=B,$e=_,Ue=J,Fe=N,Pe=q;let j=s.cdn.selfhst("svg/sonarr.svg"),ve=s.cdn.selfhst("svg/radarr-light-hybrid-light.svg"),Ie=s.cdn.selfhst("svg/bazarr.svg"),$=ne(),S=s.pluginConfig,T=ee(S.SonarrInstances,"Sonarr",$),z=ee(S.RadarrInstances,"Radarr",$);if(T.length===0&&S.SonarrUrl){let t=L(E(S.SonarrUrlMappings||""),S.SonarrUrl,$);t&&T.push({name:"Sonarr",url:t})}if(z.length===0&&S.RadarrUrl){let t=L(E(S.RadarrUrlMappings||""),S.RadarrUrl,$);t&&z.push({name:"Radarr",url:t})}let oe=L(E(S.BazarrUrlMappings||""),S.BazarrUrl,$),se="arr-links-styles";if(!document.getElementById(se)){let t=document.createElement("style");t.id=se,t.textContent=Ae,document.head.appendChild(t)}let F={sonarr:!1,radarr:!1},M=new Set,P=t=>{let i=s.helpers.escHtml;return i?i(t):String(t??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")};async function Ee(t){if(!t)return[];let i=U.get(t);if(i)return i;try{let d=await s.core.api.plugin(`/arr/series-slugs?tvdbId=${encodeURIComponent(t)}`);F.sonarr=!1,B("Sonarr",re(d));let o=fe(d,ne());return U.set(t,o),o}catch(d){return _("Sonarr",d),[]}}async function Le(t){if(!t)return[];let i=te.get(t);if(i)return i;try{let d=await s.core.api.plugin(`/arr/movie-instances?tmdbId=${encodeURIComponent(t)}`);F.radarr=!1,B("Radarr",re(d));let o=me(d,ne());return te.set(t,o),o}catch(d){return _("Radarr",d),[]}}let ae={"arr-link-sonarr":j,"arr-link-radarr":ve,"arr-link-bazarr":Ie},H=()=>!!s.pluginConfig.ShowArrLinksAsText;async function Me(){if(a)return;let t=pe();if(!t)return;let i=t.querySelector(".itemExternalLinks");if(document.querySelectorAll("#itemDetailPage.hide .arr-link").forEach(u=>{u.previousSibling?.nodeType===Node.TEXT_NODE&&u.previousSibling.remove(),u.remove()}),!i||i.querySelector(".arr-link"))return;let d=window.location.hash,o=()=>document.contains(i)&&!i.closest("#itemDetailPage.hide")&&window.location.hash===d&&r(),p=()=>i.appendChild(document.createTextNode(H()?", ":" "));a=!0;try{let u=de();if(!u)return;let g=await ce(s.helpers,u,!1);if(!o()||g?.Type!=="Movie"&&g?.Type!=="Series")return;let C=Se([...t.querySelectorAll(".itemExternalLinks a, .externalIdLinks a")].map(I=>I.href));if(!C.hasTmdbLink)return;let c=s.pluginConfig.ArrLinksShowStatusSingle===!0;if(g.Type==="Series"&&g.Name&&T.length>0){let I=await Ee(g.ProviderIds.Tvdb||"");if(!o())return;let h=I.filter(x=>!!x.instanceUrl),[b]=h;if(h.length===1&&b){let x=we(b,c);p(),i.appendChild(N("Sonarr",x.url,"arr-link-sonarr",x.status,x.badge,x.tip))}else h.length>1&&(p(),i.appendChild(q("Sonarr","arr-link-sonarr",ke(h))))}let m=C.tmdb;if(g.Type==="Movie"&&m&&z.length>0){let I=await Le(m);if(!o())return;let h=I.filter(x=>!!x.url),[b]=h;if(h.length===1&&b){let x=ye(b,m,c);p(),i.appendChild(N("Radarr",x.url,"arr-link-radarr",x.status,x.badge,x.tip))}else h.length>1&&(p(),i.appendChild(q("Radarr","arr-link-radarr",Ce(h,m))))}oe&&(g.Type==="Series"||g.Type==="Movie")&&(p(),i.appendChild(N("Bazarr",`${oe}/${g.Type==="Series"?"series":"movies"}/`,"arr-link-bazarr")))}finally{a=!1}}if(s._arrDropdownCloserInstalled||(s._arrDropdownCloserInstalled=!0,document.addEventListener("click",t=>{let i=t.target;(!(i instanceof Element)||!i.closest(".arr-dropdown"))&&document.querySelectorAll(".arr-dropdown.open").forEach(d=>d.classList.remove("open"))})),!r())return;v=s.helpers.createObserver("arr-links",()=>{if(s.session&&!s.session.isCurrent(n)){v&&(v.disconnect(),console.log(`${k} Observer disconnected — user changed`));return}if(!s.pluginConfig.ArrLinksEnabled){v&&(v.disconnect(),console.log(`${k} Observer disconnected — feature disabled`));return}y&&clearTimeout(y),y=setTimeout(()=>{Me()},100)},document.body,{childList:!0,subtree:!0})||null,s._arrLinksObserver=v,console.log(`${k} Initialized successfully`)}catch(j){console.error(`${k} Failed to initialize`,j)}};document.addEventListener("je:user-data-loaded",()=>{if(s.pluginConfig.ArrLinksEnabled){try{s._arrLinksObserver?.disconnect()}catch{}s.initializeArrLinksScript?.()}});var Ae=`
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
