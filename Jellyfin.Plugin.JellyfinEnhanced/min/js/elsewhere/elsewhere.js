(() => {
"use strict";(()=>{function U(s){let o=window.JellyfinEnhanced?.core?.sharedModules?.[s];if(!o)throw new Error(`${s} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return o}function T(s,o){return s[o]}var Ue=U("features/details-providers/host"),W=T(Ue,"api"),ze=T(Ue,"bridge");var ie=U("features/details-providers/page");var ae=T(ie,"hashItemId");var Se=T(ie,"lookupDetailsItem");var G=T(ie,"sessionLease"),Ce=T(ie,"visibleDetailPage");var Ee=U("features/details-providers/links"),ke=T(Ee,"externalLink");var le=T(Ee,"pathSegment"),Pe=T(Ee,"safeHref");var K=U("features/details-providers/wire");var _=T(K,"field"),ce=T(K,"int"),_e=T(K,"isRecord"),ee=T(K,"list");var de=T(K,"str");var Te=T(K,"text");function Re(s){return s?s.replace(/'/g,"").replace(/\n/g,",").split(",").map(o=>o.trim()).filter(o=>o):[]}function mt(s){if(!_e(s))return null;let o={provider_name:de(s.provider_name)??"",logo_path:de(s.logo_path)??""},x=ce(s.provider_id);return x!==void 0&&(o.provider_id=x),o}function ht(s){let o={},x=Te(_(s,"link"));x!==void 0&&(o.link=x);let g=_(s,"flatrate");return Array.isArray(g)&&(o.flatrate=g.map(mt).filter(h=>h!==null)),o}function Ie(s){let o={},x=_(s,"results");if(_e(x))for(let[g,h]of Object.entries(x))o[g]=ht(h);return{results:o}}function J(s,o){return s&&Object.prototype.hasOwnProperty.call(s.results,o)?s.results[o]:void 0}function Je(s,o,x){let g=s||[];if(o.defaults.length>0&&(g=g.filter(h=>o.defaults.includes(h.provider_name))),o.ignore.length>0)try{let h=o.ignore.map(k=>new RegExp(k,"i"));g=g.filter(k=>!h.some(O=>O.test(k.provider_name)))}catch(h){x(h)}return g}function qe(s){let o=(s||"").toString().trim().toLowerCase();return o===""||o==="aired"||o==="airdate"||o==="default"}async function We(s,o,x){let g=new Array(s.length),h=0,k=Array.from({length:Math.min(o,s.length)},async()=>{for(;h<s.length;){let O=h++,A=s[O];A!==void 0&&(g[O]=await x(A))}});return await Promise.all(k),g}function Ge(s){let o=s.filter(h=>h>0),x=[];for(let h=0;h<o.length;){let k=h;for(;k+1<o.length&&o[k+1]===(o[k]??NaN)+1;)k++;x.push(k>h?`${o[h]}–${o[k]}`:String(o[h])),h=k+1}let g=s.includes(0);return{single:x.length===1&&!g&&o.length===1?o[0]??null:null,specialsOnly:x.length===0&&g,ranges:x,hasSpecials:g}}function Ke(s){let o=new Map;for(let g of s){let h=g.services.map(O=>O.provider_id??NaN).sort((O,A)=>O-A).join(","),k=o.get(h);k||o.set(h,k={services:g.services,numbers:[]}),k.numbers.push(g.number)}if(o.size<=1)return null;let x=[...o.values()].filter(g=>g.services.length>0);return x.length>0?x:null}function Ve(s){return s.length===1?s[0]??"":s.length===2?s.join(" and "):`${s.slice(0,-1).join(", ")} and ${s[s.length-1]??""}`}function Ye(s){let o={};for(let x of s.trim().split(`
`)){if(x.startsWith("#"))continue;let[g,h]=x.split("	");g&&h&&(o[g]=h)}return o}function Xe(s){return s.trim().split(`
`).filter(o=>!o.startsWith("#")&&o.trim()!=="")}var Ze={US:"United States",GB:"United Kingdom",IN:"India",CA:"Canada",DE:"Germany",FR:"France",JP:"Japan",AU:"Australia",BR:"Brazil",MX:"Mexico",IE:"Ireland",IT:"Italy",ES:"Spain",NL:"Netherlands",SE:"Sweden",NO:"Norway",DK:"Denmark",FI:"Finland"},Qe=["Netflix","Amazon Prime Video","Disney Plus","HBO Max","Hulu","Apple TV Plus","Paramount Plus","Peacock","JioCinema","Disney+ Hotstar","ZEE5","SonyLIV"];function et(s){let o=de(_(s,"message"))||"";return s instanceof TypeError&&o==="Failed to fetch"?"TMDB API is unreachable.":s instanceof SyntaxError?"Received an unexpected response from the server. Check your reverse proxy or Jellyfin configuration.":o.includes("401")?"Invalid TMDB API Key.":o.includes("404")?"The requested item could not be found on TMDB.":o.includes("429")?"Too many requests. Please wait a moment and try again.":o.startsWith("HTTP 5")?"The TMDB service is temporarily unavailable. Please try again later.":o||"An unknown error occurred"}function Le(s,o){return{region:Te(_(s,"Region"))||o,regions:Array.isArray(_(s,"Regions"))?ee(_(s,"Regions")).filter(x=>typeof x=="string"):[],services:Array.isArray(_(s,"Services"))?ee(_(s,"Services")).filter(x=>typeof x=="string"):[],seasonProviders:_(s,"SeasonProviders")!==!1}}var a=ze("Jellyfin Elsewhere"),pe="🪼 Jellyfin Enhanced: 🎬 Jellyfin Elsewhere:";a.initializeElsewhereScript=function(){let o=a.pluginConfig;if(!o.ElsewhereEnabled){console.log(`${pe} Feature is disabled in plugin settings.`);return}let x=!!o.TmdbEnabled,g=o.DEFAULT_REGION||"US",h={defaults:Re(o.DEFAULT_PROVIDERS),ignore:Re(o.IGNORE_PROVIDERS)},k=o.ElsewhereCustomBrandingText||"",O=o.ElsewhereCustomBrandingImageUrl||"",A=o.ElsewhereSeasonProviders!==!1;if(!x){console.log(`${pe} TMDB is not configured, skipping initialization`);return}let L=g,q=[],B=[],z={},ue=[],F=!0,N=0,V=0,fe=e=>Je(e,h,t=>console.error(`${pe} Invalid regex in IGNORE_PROVIDERS.`,t)),Y=e=>(Object.prototype.hasOwnProperty.call(z,e)?z[e]:void 0)||e;console.log("🪼 Jellyfin Enhanced: 🎬 Jellyfin Elsewhere starting...");function tt(){fetch(a.cdn.url("elsewhere-res","regions.txt")).then(e=>e.ok?e.text():Promise.reject(new Error(`HTTP ${e.status}`))).then(e=>{z={...z,...Ye(e)}}).catch(()=>{z={...Ze}}),fetch(a.cdn.url("elsewhere-res","providers.txt")).then(e=>e.ok?e.text():Promise.reject(new Error(`HTTP ${e.status}`))).then(e=>{ue=Xe(e)}).catch(()=>{ue=[...Qe]})}function X(e,t="18px"){let n=document.createElement("span");return n.className="material-icons",n.textContent=e,n.style.fontSize=t,n.style.lineHeight="1",n}function Oe(e,t,n){let r=document.createElement("div");r.style.cssText="position: relative; margin-bottom: 6px;";let i,l=f=>{let u=f.toLowerCase();if(u.length===0){y.style.display="none";return}P(t.filter(E=>E.toLowerCase().includes(u)&&!n.includes(E)))},p=a.helpers.debounce,m="",b=p?p.call(a.helpers,()=>l(m),300):null,c=document.createElement("input");c.type="text",c.placeholder=e,c.style.cssText=`
                width: 100%;
                padding: 10px;
                border: 1px solid #444;
                border-radius: 6px;
                box-sizing: border-box;
                background: #2a2a2a;
                color: #fff;
                font-size: 14px;
            `;let y=document.createElement("div");y.style.cssText=`
                position: absolute;
                top: 100%;
                left: 0;
                right: 0;
                background: #1a1a1a;
                border: 1px solid #444;
                border-top: none;
                border-radius: 6px;
                max-height: 200px;
                overflow-y: auto;
                display: none;
                z-index: 1000;
            `;let R=document.createElement("div");R.style.cssText=`
                display: flex;
                flex-wrap: wrap;
                gap: 6px;
                margin-top: 6px;
            `;let v=-1,w=[];function j(){R.replaceChildren();for(let f of n){let u=document.createElement("span");u.className="selected-tag",u.style.cssText=`
                        background: #0078d4;
                        color: white;
                        padding: 4px 10px;
                        border-radius: 16px;
                        font-size: 12px;
                        display: inline-flex;
                        align-items: center;
                        gap: 6px;
                    `,u.textContent=f,u.dataset.value=f;let E=document.createElement("span");E.textContent="×",E.style.cssText="cursor: pointer; font-weight: bold; font-size: 14px;",E.onclick=()=>{let C=n.indexOf(f);C>-1&&(n.splice(C,1),j())},u.appendChild(E),R.appendChild(u)}}function P(f){y.replaceChildren(),y.style.display="block",w=f,v=-1,f.forEach((u,E)=>{let C=document.createElement("div");C.textContent=u,C.style.cssText=`
                        padding: 10px;
                        cursor: pointer;
                        border-bottom: 1px solid #333;
                        color: #fff;
                        font-size: 14px;
                    `,C.dataset.index=String(E),C.onmouseenter=()=>{D(),C.style.background="#333",v=E},C.onmouseleave=()=>{C.style.background="#1a1a1a"},C.onclick=()=>S(u),y.appendChild(C)})}function D(){y.querySelectorAll("div").forEach(f=>{f.style.background="#1a1a1a"})}function I(){if(D(),v>=0&&v<w.length){let f=y.querySelector(`[data-index="${v}"]`);f&&(f.style.background="#333",f.scrollIntoView({block:"nearest"}))}}function S(f){n.includes(f)||(n.push(f),j()),c.value="",y.style.display="none",v=-1}return c.oninput=()=>{b?(m=c.value,b()):(clearTimeout(i),i=setTimeout(()=>l(c.value),300))},c.onkeydown=f=>{if(y.style.display!=="none")switch(f.key){case"ArrowDown":f.preventDefault(),v=Math.min(v+1,w.length-1),I();break;case"ArrowUp":f.preventDefault(),v=Math.max(v-1,-1),I();break;case"Enter":{f.preventDefault();let u=w[v];v>=0&&u!==void 0&&S(u);break}case"Escape":y.style.display="none",v=-1;break}},c.onblur=()=>{setTimeout(()=>{y.contains(document.activeElement)||(y.style.display="none")},200)},r.append(c,y,R),j(),r}let ge="streaming-settings-modal";function je(){let e=document.getElementById(ge);e instanceof HTMLElement&&(e.style.display="none",e.replaceChildren())}function De(){let e=document.getElementById(ge);if(e instanceof HTMLDivElement)return e;let t=document.createElement("div");return t.id=ge,t.style.cssText=`
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0,0,0,0.85);
                display: none;
                z-index: 10000;
                align-items: center;
                justify-content: center;
            `,t.onclick=n=>{n.target===t&&(t.style.display="none")},document.body.appendChild(t),t}function d(e,t,n){let r=document.createElement(e);return r.style.cssText=t,n!==void 0&&(r.textContent=n),r}function nt(e,t){let n=G(a.session),r=N,i=()=>n()&&r===N,l=!1,p=d("div",`
                background: #181818;
                padding: 20px;
                border-radius: 8px;
                max-width: 500px;
                width: 90%;
                max-height: 80vh;
                overflow-y: auto;
                color: #fff;
                border: 1px solid #333;
                box-shadow: 0 8px 32px rgba(0,0,0,0.5);
            `);p.appendChild(d("h3","margin-top: 0; margin-bottom: 16px; color: #fff; font-size: 18px; font-weight: bolder;",a.t("elsewhere_settings_title")));let m=d("div","margin-bottom: 16px;"),b=d("div","display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;");b.appendChild(d("label","font-weight: 600; color: #ccc;",a.t("elsewhere_settings_country")));let c=d("button","display: flex; align-items: center; justify-content: center; background: transparent; border: none; color: #999; cursor: pointer; padding: 2px; border-radius: 4px;");c.type="button",c.id="reset-region-btn",c.title="Reset to plugin default",c.appendChild(X("restart_alt","16px")),b.appendChild(c),m.appendChild(b);let y=d("select","width: 100%; padding: 12px; border: 1px solid #444; border-radius: 6px; background: #2a2a2a; color: #fff; font-size: 14px;");y.id="region-select";for(let[u,E]of Object.entries(z)){let C=document.createElement("option");C.value=u,C.textContent=E,u===L&&(C.selected=!0),y.appendChild(C)}for(let u of new Set([L,g])){if(Array.from(y.options).some(C=>C.value===u))continue;let E=document.createElement("option");E.value=u,E.textContent=u,y.appendChild(E)}y.value=L,m.appendChild(y),p.appendChild(m);let R=d("div","margin-bottom: 16px;");R.appendChild(d("label","display: block; margin-bottom: 5px; font-weight: 600; color: #ccc;",a.t("elsewhere_settings_other_countries")));let v=document.createElement("div");v.id="regions-autocomplete",R.appendChild(v),p.appendChild(R);let w=d("div","margin-bottom: 16px;");w.appendChild(d("label","display: block; margin-bottom: 6px; font-weight: 600; color: #ccc;",a.t("elsewhere_settings_providers")));let j=document.createElement("div");j.id="services-autocomplete",w.appendChild(j),p.appendChild(w);let P=null;if(A){let u=d("label","display: flex; align-items: center; gap: 8px; margin-bottom: 16px; color: #ccc; cursor: pointer;");P=d("input","width: 16px; height: 16px; cursor: pointer;"),P.type="checkbox",P.id="season-providers-checkbox",P.checked=F,u.append(P,d("span","",a.t("elsewhere_settings_season_providers"))),p.appendChild(u)}let D=d("div","display: flex; gap: 12px; justify-content: flex-end;"),I=d("button","padding: 10px 18px; border: 1px solid #444; background: #2a2a2a; color: #fff; border-radius: 6px; cursor: pointer; font-size: 14px;",a.t("elsewhere_settings_cancel"));I.id="cancel-settings";let S=d("button","padding: 10px 18px; border: none; background: #0078d4; color: white; border-radius: 6px; cursor: pointer; font-size: 14px;",a.t("elsewhere_settings_save"));S.id="save-settings",D.append(I,S),p.appendChild(D),c.onmouseenter=()=>{c.style.color="#fff"},c.onmouseleave=()=>{c.style.color="#999"},c.onclick=()=>{y.value=g};let f=Object.entries(z).map(([u,E])=>`${E} (${u})`);v.appendChild(Oe(a.t("elsewhere_settings_add_countries_placeholder"),f,q.map(u=>`${Y(u)} (${u})`))),j.appendChild(Oe(a.t("elsewhere_settings_add_providers_placeholder"),ue,B.slice())),I.onclick=()=>{e.style.display="none"},S.onclick=async()=>{if(l||!i()||!e.isConnected||e.style.display==="none")return;l=!0,S.disabled=!0;let u=y.value,E=[];v.querySelectorAll(".selected-tag").forEach($=>{let M=($.dataset.value??"").match(/\(([A-Z]{2})\)$/);M?.[1]&&E.push(M[1])});let C=E,H=[];j.querySelectorAll(".selected-tag").forEach($=>{H.push(($.dataset.value??"").trim())});let Z=H,ve=P?.checked??F,we={...t,Region:u,Regions:C,Services:Z,SeasonProviders:ve};try{if(await a.saveUserSettings("elsewhere.json",we,{throwOnError:!0,isCurrent:i}),!i())return;a.userConfig.elsewhere=we,he()}catch{if(i()&&e.isConnected){let M=p.querySelector(".je-elsewhere-save-error");M||(M=document.createElement("p"),M.className="je-elsewhere-save-error",M.setAttribute("role","alert"),D.before(M)),M.textContent=te("elsewhere_settings_save_failed","Could not save your choices. Try again.")}}finally{l=!1,i()&&(S.disabled=!1)}},e.replaceChildren(p)}function rt(e){if(e===null||typeof e!="object"||Array.isArray(e))return!1;let t=_(e,"Region"),n=_(e,"Regions"),r=_(e,"Services"),i=_(e,"SeasonProviders");return(t==null||typeof t=="string")&&(n==null||Array.isArray(n)&&n.every(l=>typeof l=="string"))&&(r==null||Array.isArray(r)&&r.every(l=>typeof l=="string"))&&(i==null||typeof i=="boolean")}function te(e,t){let n=a.t(e);return n&&n!==e?n:t}function Me(){let e=De(),t=++V,n=G(a.session),r=()=>t===V&&n()&&e.isConnected&&e.style.display!=="none";e.replaceChildren(d("p","color: #fff;",te("elsewhere_settings_loading","Loading your settings…"))),e.style.display="flex";let i=W(),l=i.getCurrentUserId();Promise.resolve().then(()=>{if(!r()||!l)throw new Error("Settings opening cancelled");return i.ajax({type:"GET",url:i.getUrl(`/JellyfinEnhanced/user-settings/${l}/elsewhere.json?_=${Date.now()}`),dataType:"json"})}).then(p=>{if(!r())return;if(!rt(p))throw new Error("Invalid Elsewhere settings document");let m=Le(p,g);L=m.region,q=m.regions,B=m.services,F=m.seasonProviders,me(),nt(e,p),se()}).catch(()=>{if(!r())return;let p=d("div","padding: 24px; background: #181818; color: #fff;",te("elsewhere_settings_load_failed","Your settings could not be loaded. No changes were saved.")),m=d("button","",te("elsewhere_settings_retry","Retry"));m.type="button",m.onclick=Me;let b=d("button","",a.t("elsewhere_settings_cancel"));b.type="button",b.onclick=()=>{e.style.display="none",V++},p.append(m,b),e.replaceChildren(p)})}function me(){N++,document.querySelectorAll(".streaming-lookup-container").forEach(e=>e.remove()),ne.clear(),re.clear(),oe.clear()}function he(e=!0){let t=Le(a.userConfig.elsewhere,g);L=t.region,q=t.regions,B=t.services,F=t.seasonProviders,e&&(V++,je(),me(),e&&se())}document.addEventListener("je:user-data-loaded",()=>he()),a.session?.onUserChange("elsewhere",()=>{L=g,q=[],B=[],F=!0,V++,je(),me()});function xe(e){let t=d("div",`
                display: inline-flex;
                align-items: center;
                padding: 6px 10px;
                margin: 3px 5px 3px 0;
                border-radius: 8px;
                font-size: 13px;
                font-weight: 500;
                color: #fff;
                white-space: nowrap;
                transition: all 500ms ease;
                background: rgba(255, 255, 255, 0.1);
                border: 1px solid rgba(255, 255, 255, 0.2);
                backdrop-filter: blur(10px);
            `),n=document.createElement("img");n.src=`https://image.tmdb.org/t/p/w92${e.logo_path}`,n.alt=e.provider_name,n.style.cssText=`
                width: 20px;
                height: 20px;
                margin-right: 8px;
                object-fit: contain;
                border-radius: 4px;
            `,n.onerror=()=>{n.style.display="none"},t.appendChild(n);let r=document.createElement("span");return r.textContent=e.provider_name,t.appendChild(r),t.onmouseenter=()=>{t.style.transform="translateY(-2px)",t.style.background="rgba(255, 255, 255, 0.2)",t.style.boxShadow="0 4px 12px rgba(0, 0, 0, 0.3)"},t.onmouseleave=()=>{t.style.transform="translateY(0)",t.style.background="rgba(255, 255, 255, 0.1)",t.style.boxShadow="none"},t}function Ae(e,t,n){let r=G(a.session),i=N,l=()=>r()&&i===N,p=`/${t}/${le(e)}/watch/providers`,m=W().getUrl(`/JellyfinEnhanced/tmdb${p}`);a.core.api.fetch(m,{cacheKey:`tmdb:${p}`}).then(b=>{l()&&n(null,Ie(b))}).catch(b=>{l()&&n(et(b),null)})}let ot=4,ne=new Map,re=new Map;function st(e,t){let n=`${e}:${t}`,r=ne.get(n);if(!r){let i=W().getUrl(`/JellyfinEnhanced/tmdb/tv/${le(e)}/season/${t}/watch/providers`);r=a.core.api.fetch(i).then(Ie).catch(()=>(ne.delete(n),null)),ne.set(n,r)}return r}function it(e){let t=re.get(e);if(!t){let n=W().getUrl(`/JellyfinEnhanced/tmdb/tv/${le(e)}`);t=a.core.api.fetch(n).then(r=>{let i=_(r,"seasons");return Array.isArray(i)?new Set(i.map(l=>ce(_(l,"season_number"))).filter(l=>l!==void 0)):null}).catch(()=>(re.delete(e),null)),re.set(e,t)}return t}async function at(e){let t=W(),n=t.getUrl(`Shows/${e}/Seasons`,{userId:t.getCurrentUserId()??""}),r=await a.core.api.fetch(n);return ee(_(r,"Items")).map(i=>_(i,"IndexNumber")).filter(i=>Number.isInteger(i)).sort((i,l)=>i-l)}async function Ne(e){if(!A||!F)return null;let t=ae();if(!t)return null;let n=await Se(a.helpers,t,!1);if(!n)return null;let r,i=null;if(n.Type==="Series")r=n;else if(n.Type==="Season"&&n.SeriesId&&Number.isInteger(n.IndexNumber))r=await Se(a.helpers,n.SeriesId,!1),i=n.IndexNumber??null;else return null;if(!r||!r.Id||!qe(r.DisplayOrder))return null;let l=r.ProviderIds.Tmdb;return!l||e&&l!==e?null:{kind:i===null?"series":"season",seriesId:r.Id,tmdbId:l,seasonNumber:i}}function lt(e){let t=Ge(e);if(t.single!==null)return a.t("elsewhere_season_label",{number:t.single});if(t.specialsOnly)return a.t("jellyseerr_season_specials");let n=[...t.ranges];return t.hasSpecials&&n.push(a.t("jellyseerr_season_specials")),a.t("elsewhere_seasons_label",{range:n.join(", ")})}async function ct(e,t){let n=fe(J(t,L)?.flatrate),r=await it(e.tmdbId),i=e.kind==="season"&&e.seasonNumber!==null?[e.seasonNumber]:await at(e.seriesId);if(i.length===0)return null;let p=(await We(i,ot,async c=>{let R=!r||r.has(c)?await st(e.tmdbId,c):null,v=fe(J(R,L)?.flatrate);return v.length>0?{number:c,services:v,link:J(R,L)?.link}:c===0?null:{number:c,services:n,link:void 0}})).filter(c=>!!c),[m]=p;if(!m)return null;if(e.kind==="season")return{servicesOverride:m.services,link:m.link};let b=Ke(p);return b?{groups:b.map(c=>({label:lt(c.numbers),services:c.services}))}:null}function Be(e,t,n){let r=document.createElement("button");return r.className=e,r.appendChild(X(t,"16px")),r.style.cssText=n,r.onmouseenter=()=>{r.style.background="rgba(255, 255, 255, 0.2)"},r.onmouseleave=()=>{r.style.background="rgba(255, 255, 255, 0.1)"},r}function Fe(e){let t=document.createElement("button");return t.appendChild(X("close","16px")),t.style.cssText=`
                display: flex;
                align-items: center;
                justify-content: center;
                background: rgba(255, 255, 255, 0.1);
                color: #fff;
                border: 1px solid rgba(255, 255, 255, 0.2);
                padding: 6px;
                border-radius: 4px;
                cursor: pointer;
                transition: all 500ms ease;
                width: 28px;
                height: 28px;
            `,t.onmouseenter=()=>{t.style.background="rgba(255, 0, 0, 0.2)",t.style.borderColor="rgba(255, 0, 0, 0.3)"},t.onmouseleave=()=>{t.style.background="rgba(255, 255, 255, 0.1)",t.style.borderColor="rgba(255, 255, 255, 0.2)"},t.onclick=()=>e.remove(),t}function dt(e,t,n,r={}){let i=J(e,L),l=d("div",`
                margin: 10px 0;
                padding: 12px;
                background: rgba(0, 0, 0, 0.2);
                border-radius: 8px;
                border: 1px solid rgba(255, 255, 255, 0.1);
                backdrop-filter: blur(10px);
                position: relative;
            `),p=d("div",`
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 10px;
            `),m=!!i?.flatrate&&i.flatrate.length>0,b=m?fe(i?.flatrate):[];r.servicesOverride&&(b=r.servicesOverride);let c=r.groups||null,y=r.link||i?.link||"",R=!!c||b.length>0,v=!R&&!!k,w=ke(a.helpers,R&&y?y:"#",{title:"JustWatch"});if(R)w.textContent=a.t("elsewhere_panel_available_in",{region:Y(L)});else if(k){if(w.textContent=k,w.classList.add("elsewhere-custom-branding"),w.style.cursor="default",O){w.style.display="flex",w.style.alignItems="center",w.style.gap="8px";let S=document.createElement("img");S.src=O,S.alt="Custom Branding",S.className="elsewhere-custom-branding-icon",S.style.cssText=`
                        width: 24px;
                        height: 24px;
                        object-fit: contain;
                        margin-left: 4px;
                    `,S.onerror=()=>{S.style.display="none"},w.appendChild(S)}}else w.textContent=a.t("elsewhere_panel_not_available_in",{region:Y(L)});w.style.cssText=`
                font-weight: 600;
                font-size: 14px;
                text-decoration: none;
                cursor: pointer;
                color: #fff;
                flex: 1;
                text-align: left;
                display: flex;
                align-items: flex-end;
            `,R&&y?(w.classList.add("elsewhere-link-reset"),w.href=Pe(y),w.style.padding="0",w.style.margin="0"):v&&(w.style.cursor="default");let j=d("div",`
                display: flex;
                gap: 8px;
                align-items: center;
            `),P=Be("elsewhere-search-button","search",`
                display: flex;
                align-items: center;
                gap: 6px;
                background: rgba(255, 255, 255, 0.1);
                color: #fff;
                border: 1px solid rgba(255, 255, 255, 0.2);
                padding: 6px 12px;
                border-radius: 4px;
                font-size: 12px;
                font-weight: 500;
                cursor: pointer;
                transition: all 500ms ease;
                opacity: ${v?"0":"1"};
            `);P.appendChild(document.createTextNode(""));let D=Be("elsewhere-settings-button","settings",`
                display: flex;
                align-items: center;
                justify-content: center;
                background: rgba(255, 255, 255, 0.1);
                color: #fff;
                border: 1px solid rgba(255, 255, 255, 0.2);
                padding: 6px;
                border-radius: 4px;
                cursor: pointer;
                transition: all 500ms ease;
                width: 28px;
                height: 28px;
                opacity: ${v?"0":"1"};
            `);if(D.onclick=()=>Me(),j.append(P,D),p.append(w,j),l.appendChild(p),v&&(l.onmouseenter=()=>{P.style.opacity="1",D.style.opacity="1"},l.onmouseleave=()=>{P.style.opacity="0",D.style.opacity="0"}),m||R)if(c)for(let S of c){l.appendChild(d("div","font-size: 12px; font-weight: 600; color: #aaa; margin: 4px 0 2px;",S.label));let f=d("div","display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px;");for(let u of S.services)f.appendChild(xe(u));l.appendChild(f)}else if(R){let S=d("div","display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 12px;");for(let f of b)S.appendChild(xe(f));l.appendChild(S)}else h.defaults.length>0&&l.appendChild(d("div","color: #999; font-size: 13px; margin-bottom: 12px;",a.t("elsewhere_panel_no_configured_services")));let I=document.createElement("div");return I.id="streaming-result-container",l.appendChild(I),P.onclick=()=>{P.disabled=!0,P.replaceChildren();let S=X("refresh","16px");if(S.style.animation="spin 1s linear infinite",P.append(S,document.createTextNode(" "+a.t("elsewhere_panel_search_button"))),P.style.opacity="0.7",I.replaceChildren(),!document.querySelector("style[data-jellyfin-elsewhere]")){let f=document.createElement("style");f.textContent=`
                    @keyframes spin {
                        0% { transform: rotate(0deg); }
                        100% { transform: rotate(360deg); }
                    }
                `,f.setAttribute("data-jellyfin-elsewhere","true"),document.head.appendChild(f)}Ae(t,n,(f,u)=>{if(P.disabled=!1,P.replaceChildren(X("search","16px"),document.createTextNode("")),P.style.opacity="1",f||!u){I.replaceChildren(d("div","color: #ff6b6b; font-size: 13px; margin-top: 8px;",a.t("elsewhere_panel_error",{error:f??""})));return}let E=q.length>0?q:[L],C=!1,H=[];E.forEach((Z,ve)=>{let $=J(u,Z)?.flatrate??[],M=B.length>0?$.filter(Q=>B.includes(Q.provider_name)):$;if($.length>0&&M.length>0){C=!0;let Q=ut(u,Z);Q&&((ve>0||H.length>0)&&(Q.style.marginTop="6px"),I.appendChild(Q))}else H.push(Z)}),H.length>0&&I.insertBefore(pt(H),I.firstChild),!C&&H.length===0&&I.appendChild(d("div","color: #6c757d; font-size: 13px; margin-top: 8px;",a.t("elsewhere_panel_no_services_in_regions")))})},l}function pt(e){let t=d("div",`
                margin: 0 0 6px 0;
                padding: 12px;
                border-radius: 8px;
                border: 1px solid rgba(139, 19, 19, 0.6);
                background: rgba(139, 19, 19, 0.3);
                backdrop-filter: blur(10px);
                position: relative;
            `),n=d("div",`
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 0;
            `),r=d("div",`
                font-weight: 600;
                font-size: 14px;
                color: rgb(255, 20, 20);
                flex: 1;
            `,a.t("elsewhere_panel_not_available_in_regions",{regions:Ve(e.map(Y))})),i=Fe(t);return i.title="Close",n.append(r,i),t.appendChild(n),t}function ut(e,t){let n=J(e,t);if(!n?.flatrate)return null;let r=n.flatrate.filter(b=>B.length===0||B.includes(b.provider_name));if(r.length===0)return null;let i=d("div",`
                margin: 10px 0 0 0;
                padding: 12px;
                background: rgba(0, 0, 0, 0.3);
                border-radius: 8px;
                border: 1px solid rgba(255, 255, 255, 0.1);
                backdrop-filter: blur(10px);
                position: relative;
            `),l=d("div",`
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 10px;
            `),p=ke(a.helpers,n.link||"#",{title:"JustWatch"});p.textContent=a.t("elsewhere_panel_available_in_region",{region:Y(t)}),p.style.cssText=`
                font-weight: 600;
                font-size: 14px;
                text-decoration: none;
                cursor: pointer;
                color: #fff;
                flex: 1;
                text-align: left;
            `,n.link&&(p.classList.add("elsewhere-link-reset"),p.href=Pe(n.link),p.style.padding="0",p.style.margin="0"),l.append(p,Fe(i)),i.appendChild(l);let m=d("div","display: flex; flex-wrap: wrap; gap: 3px;");for(let b of r)m.appendChild(xe(b));return i.appendChild(m),i}function ft(e,t,n){let r=G(a.session),i=N,l=()=>r()&&i===N&&n.isConnected;Ae(e,t,async(p,m)=>{if(!l())return;if(p||!m){n.appendChild(d("div","font-size: 13px; margin-top: 8px; color: #ff6b6b;",a.t("elsewhere_panel_error",{error:p??""})));return}let b={};if(t==="tv"&&A&&F)try{let c=await Ne(e);if(!l())return;c&&(b=await ct(c,m)||{})}catch(c){console.warn(`${pe} Per-season providers unavailable, using series providers.`,c)}l()&&n.appendChild(dt(m,e,t,b))})}function He(e,t,n){let r=document.createElement("div");r.className="streaming-lookup-container",r.style.cssText="margin: 16px 0;",ft(t,n,r);let i=e.querySelector(".itemExternalLinks");i?.parentNode?i.parentNode.insertBefore(r,i.nextSibling):e.appendChild(r)}let oe=new Set;function gt(e){if(!A||!F)return;let t=e.closest("#itemDetailPage")??document;if(t!==document&&t!==Ce()||t.querySelector(".streaming-lookup-container")||e!==t.querySelector(".detailSectionContent"))return;let n=ae();if(!n||oe.has(n))return;oe.add(n);let r=G(a.session),i=N;Ne().then(l=>{!r()||i!==N||!l||l.kind!=="season"||!e.isConnected||ae()!==n||t.querySelector(".streaming-lookup-container")||He(e,l.tmdbId,"tv")}).catch(()=>{}).finally(()=>oe.delete(n))}function se(){document.querySelectorAll(".detailSectionContent").forEach(e=>{let t=e.closest("#itemDetailPage");if(t&&t!==Ce()||e.querySelector(".streaming-lookup-container"))return;let n=e.querySelector('a[href*="themoviedb.org"]');if(!n){gt(e);return}let r=n.href.match(/themoviedb\.org\/(movie|tv)\/(\d+)/);!r?.[1]||!r[2]||He(e,r[2],r[1])})}tt(),he(!1);let be=(e,t,n)=>{typeof requestIdleCallback<"u"?requestIdleCallback(e,{timeout:t}):setTimeout(e,n)};be(()=>{De()},2e3,2e3);let ye=!1,$e=()=>{ye||(ye=!0,be(()=>{se(),ye=!1},500,100))};a.helpers.createObserver("elsewhere",$e,document.body,{childList:!0,subtree:!0}),a.helpers.onViewPage($e),be(()=>se(),1e3,1e3),console.log("🪼 Jellyfin Enhanced: 🎬 Jellyfin Elsewhere loaded!")};})();
})();
