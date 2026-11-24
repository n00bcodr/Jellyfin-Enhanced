(() => {
"use strict";(()=>{function T(e){let r=window.JellyfinEnhanced?.core?.sharedModules?.[e];if(!r)throw new Error(`${e} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return r}function g(e,r){return e[r]}var K=T("features/details-providers/host"),W=g(K,"api"),le=g(K,"bridge");var ce=g(K,"hasApi");var G=T("features/details-providers/page");var de=g(G,"hashItemId");var ue=g(G,"lookupDetailsItem");var pe=g(G,"visibleDetailPage");function fe(e,r){try{let n=new URL(e,r);return["http:","https:","mailto:","tel:","ftp:","blob:"].includes(n.protocol)?e:"#"}catch{return"#"}}function H(e,r){let a=document.createElement.call(document,e,r);return a.getAttribute("is")!==r&&a.setAttribute("is",r),a}function Ae(e){return fe(e,window.location.href)}function X(e,r,n={}){let a=e?.createExternalLink;if(a)return a(r,n);let i=H("a","emby-linkbutton");return i.href=Ae(r),i.target="_blank",i.rel="noopener noreferrer",n.title&&(i.title=n.title),n.className&&(i.className=[i.className,n.className].filter(Boolean).join(" ")),n.text&&(i.textContent=n.text),n.resetStyle&&(i.style.cssText="padding:0;background:none;border-radius:0;min-width:0;"),typeof n.setup=="function"&&n.setup(i),i}var A=T("features/details-providers/wire");var R=g(A,"field"),Z=g(A,"int"),Q=g(A,"isRecord"),Y=g(A,"list"),ee=g(A,"num");var y=g(A,"str");function M(e){let r=[];if(!e)return r;for(let n of e.split(`
`)){let a=n.trim();if(!a)continue;let i=a.split("|").map($=>$.trim()),[k,S]=i;i.length===2&&k&&S&&r.push({jellyfinUrl:k,arrUrl:S})}return r}function v(e,r,n){if(!r)return null;if(e.length===0)return r;let a=n.replace(/\/+$/,"").toLowerCase();for(let i of e)if(a===i.jellyfinUrl.replace(/\/+$/,"").toLowerCase())return i.arrUrl.replace(/\/$/,"");return r}function ne(e,r,n){return(e||[]).filter(a=>!!a&&a.Enabled!==!1).map(a=>({name:a.Name||r,url:v(M(a.UrlMappings||""),a.Url,n)})).filter(a=>!!a.url)}function U(e){return!e||e<=0?"":e<1073741824?(e/1048576).toFixed(0)+" MB":(e/1073741824).toFixed(1)+" GB"}function ge(e,r){return e===0?"missing":e>=r?"complete":"partial"}function re(e){let r=R(e,"errors");if(Array.isArray(r))return r.map(n=>({instanceName:y(R(n,"instanceName")),reason:y(R(n,"reason"))}))}function me(e,r){return Y(R(e,"matches")).filter(Q).map(n=>({instanceName:y(n.instanceName),instanceUrl:v(M(y(n.urlMappings)||""),y(n.instanceUrl),r),titleSlug:y(n.titleSlug)??"",episodeFileCount:Z(n.episodeFileCount)||0,episodeCount:Z(n.episodeCount)||0,sizeOnDisk:ee(n.sizeOnDisk)||0,rootFolderPath:y(n.rootFolderPath)||""}))}function he(e,r){return Y(R(e,"matches")).filter(Q).map(n=>({name:y(n.instanceName),url:v(M(y(n.urlMappings)||""),y(n.instanceUrl),r),hasFile:n.hasFile===!0,sizeOnDisk:ee(n.sizeOnDisk)||0,rootFolderPath:y(n.rootFolderPath)||""}))}var be=e=>e.replace(/\/$/,"");function xe(e){return`${be(e.instanceUrl)}/series/${e.titleSlug}`}function ye(e,r){return`${be(e.url)}/movie/${r}`}function we(e,r){let n=e.episodeFileCount>=0,a=U(e.sizeOnDisk),i=[e.instanceName??""];return n&&i.push(`${e.episodeFileCount}/${e.episodeCount} episodes`),a&&i.push(a),e.rootFolderPath&&i.push(e.rootFolderPath),{url:xe(e),status:r&&n?ge(e.episodeFileCount,e.episodeCount):null,badge:r&&n?`${e.episodeFileCount}/${e.episodeCount}`:"",tip:i.join(`
`)}}function ke(e){return e.map(r=>{let n=r.episodeFileCount<0?null:ge(r.episodeFileCount,r.episodeCount),a=r.episodeFileCount<0?"":`${r.episodeFileCount}/${r.episodeCount}`,i=U(r.sizeOnDisk),k=[a?`${a} episodes`:null,i,r.rootFolderPath].filter(Boolean).join(" • ");return{name:r.instanceName??"",url:xe(r),status:n,badge:a,size:i,tip:k}})}function Ee(e,r,n){let a=e.hasFile?"complete":"missing",i=e.hasFile?"Downloaded":"Missing";return{url:ye(e,r),status:n?a:null,badge:n?i:"",tip:[e.name,i,U(e.sizeOnDisk),e.rootFolderPath].filter(Boolean).join(`
`)}}function Ce(e,r){return e.map(n=>{let a=n.hasFile?"complete":"missing",i=n.hasFile?"Downloaded":"Missing",k=U(n.sizeOnDisk);return{name:n.name??"",url:ye(n,r),status:a,badge:i,size:k,tip:[i,k,n.rootFolderPath].filter(Boolean).join(" • ")}})}function Se(e){let r={tmdb:null,hasTmdbLink:!1};for(let n of e)n.includes("themoviedb.org/movie/")?(r.tmdb=n.match(/\/movie\/(\d+)/)?.[1]??null,r.hasTmdbLink=!0):n.includes("themoviedb.org/tv/")&&(r.tmdb=n.match(/\/tv\/(\d+)/)?.[1]??null,r.hasTmdbLink=!0);return r}var s=le("Arr links"),w="🪼 Jellyfin Enhanced: Arr Links:",te=()=>ce()&&typeof W().serverAddress=="function"?W().serverAddress?.()??window.location.origin:window.location.origin;s.initializeArrLinksScript=async function(){if(!s.pluginConfig.ArrLinksEnabled){console.log(`${w} Integration disabled in plugin settings.`);return}let r=s.session?s.session.getEpoch():0,n=()=>!s.session||s.session.isCurrent(r),a=s.helpers.isAdmin();if(console.log(`${w} Admin status: ${a}`),!a){console.log(`${w} User is not an administrator. Links will not be shown.`);return}console.log(`${w} Initializing...`),s.pluginConfig.SonarrInstancesCorrupt&&typeof s.toast=="function"&&(s.toast("⚠ Sonarr instance configuration is corrupt. Open the Jellyfin Enhanced config page to reset it."),console.error(`${w} SonarrInstances stored JSON is corrupt.`)),s.pluginConfig.RadarrInstancesCorrupt&&typeof s.toast=="function"&&(s.toast("⚠ Radarr instance configuration is corrupt. Open the Jellyfin Enhanced config page to reset it."),console.error(`${w} RadarrInstances stored JSON is corrupt.`));let i=!1,k=null,S=null,$=new Map,oe=new Map;try{let B=function(t,l){if(!l||l.length===0){for(let o of[...I])o.startsWith(t+"|")&&I.delete(o);return}let c=new Set;for(let o of l){let u=`${t}|${o.instanceName}|${o.reason}`;c.add(u),!I.has(u)&&(I.add(u),typeof s.toast=="function"&&s.toast("⚠ "+P(t)+' instance "'+P(o.instanceName||"unknown")+'" failed: '+P(o.reason)),console.warn(`${w} ${t} instance "${o.instanceName}" error: ${o.reason}`))}for(let o of[...I])o.startsWith(t+"|")&&!c.has(o)&&I.delete(o)},q=function(t,l){let c=t==="Sonarr"?"sonarr":"radarr";N[c]||(N[c]=!0,typeof s.toast=="function"&&s.toast("⚠ "+P(t)+" lookup failed; links unavailable. See console for details."),console.warn(`${w} ${t} lookup backend failed:`,l))},J=function(t,l){let c=Object.prototype.hasOwnProperty.call(ie,t)?ie[t]:void 0;if(!c)return null;let o=document.createElement("img");o.src=c,o.alt=l,o.className="arr-link-img";let u=s.helpers.getExternalLinkIconSize();return o.style.width=`${u}px`,o.style.height=`${u}px`,o},F=function(t,l,c,o=null,u="",p=""){let f=o?` arr-link--${o}`:"",E=X(s.helpers,l,{title:p||t,className:`button-link emby-button arr-link${f}`});if(_()){if(E.textContent=t,u){let d=document.createElement("span");d.className=`arr-badge arr-badge--${o||"missing"}`,d.textContent=u,E.appendChild(d)}}else{let d=J(c,t);d&&E.appendChild(d)}return E},V=function(t,l,c){let o=document.createElement("span");o.className="arr-dropdown";let u=s.themer?.getThemeVariables?.()||{};o.style.setProperty("--arr-menu-bg",u.secondaryBg||"rgba(20,20,28,0.98)"),o.style.setProperty("--arr-menu-text",u.textColor||"#fff"),o.style.setProperty("--arr-menu-border","rgba(255,255,255,0.2)"),o.style.setProperty("--arr-menu-hover","rgba(255,255,255,0.1)"),o.style.setProperty("--arr-menu-muted","rgba(255,255,255,0.55)");let p=H("a","emby-linkbutton");if(p.className="button-link emby-button arr-link",p.href="#",p.title=`${t} (${c.length} instances)`,_())p.textContent=t;else{let d=J(l,t);d&&p.appendChild(d)}let f=document.createElement("span");f.textContent="▾",f.style.cssText="font-size:0.8em; opacity:0.8; margin-left:2px; line-height:1; vertical-align:middle; color: white;",p.appendChild(f),p.addEventListener("click",d=>{d.preventDefault(),d.stopPropagation(),document.querySelectorAll(".arr-dropdown.open").forEach(m=>{m!==o&&m.classList.remove("open")}),o.classList.toggle("open")});let E=document.createElement("div");E.className="arr-dropdown-menu";for(let d of c){let m=X(s.helpers,d.url,{title:d.tip||d.name,className:"arr-dropdown-item"}),L=document.createElement("span");L.className=`arr-dropdown-dot arr-dropdown-dot--${d.status||"missing"}`,m.appendChild(L);let h=document.createElement("span");if(h.className="arr-dropdown-item-name",h.textContent=d.name,m.appendChild(h),d.badge){let b=document.createElement("span");b.className=`arr-badge arr-badge--${d.status||"missing"}`,b.textContent=d.badge,m.appendChild(b)}if(d.size){let b=document.createElement("span");b.className="arr-dropdown-item-stats",b.textContent=d.size,m.appendChild(b)}E.appendChild(m)}return o.append(p,E),o};var Oe=B,$e=q,Ne=J,Pe=F,Fe=V;let D=s.cdn.selfhst("svg/sonarr.svg"),Le=s.cdn.selfhst("svg/radarr-light-hybrid-light.svg"),Me=s.cdn.selfhst("svg/bazarr.svg"),O=te(),C=s.pluginConfig,j=ne(C.SonarrInstances,"Sonarr",O),z=ne(C.RadarrInstances,"Radarr",O);if(j.length===0&&C.SonarrUrl){let t=v(M(C.SonarrUrlMappings||""),C.SonarrUrl,O);t&&j.push({name:"Sonarr",url:t})}if(z.length===0&&C.RadarrUrl){let t=v(M(C.RadarrUrlMappings||""),C.RadarrUrl,O);t&&z.push({name:"Radarr",url:t})}let se=v(M(C.BazarrUrlMappings||""),C.BazarrUrl,O),ae="arr-links-styles";if(!document.getElementById(ae)){let t=document.createElement("style");t.id=ae,t.textContent=Re,document.head.appendChild(t)}let N={sonarr:!1,radarr:!1},I=new Set,P=t=>{let l=s.helpers.escHtml;return l?l(t):String(t??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")};async function ve(t){if(!t)return[];let l=$.get(t);if(l)return l;try{let c=await s.core.api.plugin(`/arr/series-slugs?tvdbId=${encodeURIComponent(t)}`);N.sonarr=!1,B("Sonarr",re(c));let o=me(c,te());return $.set(t,o),o}catch(c){return q("Sonarr",c),[]}}async function Ie(t){if(!t)return[];let l=oe.get(t);if(l)return l;try{let c=await s.core.api.plugin(`/arr/movie-instances?tmdbId=${encodeURIComponent(t)}`);N.radarr=!1,B("Radarr",re(c));let o=he(c,te());return oe.set(t,o),o}catch(c){return q("Radarr",c),[]}}let ie={"arr-link-sonarr":D,"arr-link-radarr":Le,"arr-link-bazarr":Me},_=()=>!!s.pluginConfig.ShowArrLinksAsText;async function Te(){if(i)return;let t=pe();if(!t)return;let l=t.querySelector(".itemExternalLinks");if(document.querySelectorAll("#itemDetailPage.hide .arr-link").forEach(p=>{p.previousSibling?.nodeType===Node.TEXT_NODE&&p.previousSibling.remove(),p.remove()}),!l||l.querySelector(".arr-link"))return;let c=window.location.hash,o=()=>document.contains(l)&&!l.closest("#itemDetailPage.hide")&&window.location.hash===c&&n(),u=()=>l.appendChild(document.createTextNode(_()?", ":" "));i=!0;try{let p=de();if(!p)return;let f=await ue(s.helpers,p,!1);if(!o()||f?.Type!=="Movie"&&f?.Type!=="Series")return;let E=Se([...t.querySelectorAll(".itemExternalLinks a, .externalIdLinks a")].map(L=>L.href));if(!E.hasTmdbLink)return;let d=s.pluginConfig.ArrLinksShowStatusSingle===!0;if(f.Type==="Series"&&f.Name&&j.length>0){let L=await ve(f.ProviderIds.Tvdb||"");if(!o())return;let h=L.filter(x=>!!x.instanceUrl),[b]=h;if(h.length===1&&b){let x=we(b,d);u(),l.appendChild(F("Sonarr",x.url,"arr-link-sonarr",x.status,x.badge,x.tip))}else h.length>1&&(u(),l.appendChild(V("Sonarr","arr-link-sonarr",ke(h))))}let m=E.tmdb;if(f.Type==="Movie"&&m&&z.length>0){let L=await Ie(m);if(!o())return;let h=L.filter(x=>!!x.url),[b]=h;if(h.length===1&&b){let x=Ee(b,m,d);u(),l.appendChild(F("Radarr",x.url,"arr-link-radarr",x.status,x.badge,x.tip))}else h.length>1&&(u(),l.appendChild(V("Radarr","arr-link-radarr",Ce(h,m))))}se&&(f.Type==="Series"||f.Type==="Movie")&&(u(),l.appendChild(F("Bazarr",`${se}/${f.Type==="Series"?"series":"movies"}/`,"arr-link-bazarr")))}finally{i=!1}}if(s._arrDropdownCloserInstalled||(s._arrDropdownCloserInstalled=!0,document.addEventListener("click",t=>{let l=t.target;(!(l instanceof Element)||!l.closest(".arr-dropdown"))&&document.querySelectorAll(".arr-dropdown.open").forEach(c=>c.classList.remove("open"))})),!n())return;S=s.helpers.createObserver("arr-links",()=>{if(s.session&&!s.session.isCurrent(r)){S&&(S.disconnect(),console.log(`${w} Observer disconnected — user changed`));return}if(!s.pluginConfig.ArrLinksEnabled){S&&(S.disconnect(),console.log(`${w} Observer disconnected — feature disabled`));return}k&&clearTimeout(k),k=setTimeout(()=>{Te()},100)},document.body,{childList:!0,subtree:!0})||null,s._arrLinksObserver=S,console.log(`${w} Initialized successfully`)}catch(D){console.error(`${w} Failed to initialize`,D)}};document.addEventListener("je:user-data-loaded",()=>{if(s.pluginConfig.ArrLinksEnabled){try{s._arrLinksObserver?.disconnect()}catch{}s.initializeArrLinksScript?.()}});var Re=`
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
