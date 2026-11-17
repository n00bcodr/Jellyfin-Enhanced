(() => {
"use strict";(()=>{function V(s){let r=window.JellyfinEnhanced?.core?.sharedModules?.[s];if(!r)throw new Error(`${s} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return r}function P(s,r){return s[r]}var Ye=V("features/details-providers/host"),Y=P(Ye,"api"),Ze=P(Ye,"bridge");var ye=V("features/details-providers/page");var ve=P(ye,"hashItemId");var Oe=P(ye,"lookupDetailsItem");var te=P(ye,"sessionLease"),je=P(ye,"visibleDetailPage");function De(s,r,u,c){let p=document.createElement("div");p.style.cssText="position: relative; margin-bottom: 6px;";let y,A=m=>{let v=m.toLowerCase();if(v.length===0){R.style.display="none";return}J(u.filter(M=>M.toLowerCase().includes(v)&&!c.includes(M)))},$=s.debounce,X="",oe=$?$.call(s,()=>A(X),300):null,_=document.createElement("input");_.type="text",_.placeholder=r,_.style.cssText=`
            width: 100%;
            padding: 10px;
            border: 1px solid #444;
            border-radius: 6px;
            box-sizing: border-box;
            background: #2a2a2a;
            color: #fff;
            font-size: 14px;
        `;let R=document.createElement("div");R.style.cssText=`
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
        `;let Q=document.createElement("div");Q.style.cssText=`
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-top: 6px;
        `;let T=-1,C=[];function U(){Q.replaceChildren();for(let m of c){let v=document.createElement("span");v.className="selected-tag",v.style.cssText=`
                    background: #0078d4;
                    color: white;
                    padding: 4px 10px;
                    border-radius: 16px;
                    font-size: 12px;
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                `,v.textContent=m,v.dataset.value=m;let M=document.createElement("span");M.textContent="×",M.style.cssText="cursor: pointer; font-weight: bold; font-size: 14px;",M.onclick=()=>{let E=c.indexOf(m);E>-1&&(c.splice(E,1),U())},v.appendChild(M),Q.appendChild(v)}}function J(m){R.replaceChildren(),R.style.display="block",C=m,T=-1,m.forEach((v,M)=>{let E=document.createElement("div");E.textContent=v,E.style.cssText=`
                    padding: 10px;
                    cursor: pointer;
                    border-bottom: 1px solid #333;
                    color: #fff;
                    font-size: 14px;
                `,E.dataset.index=String(M),E.onmouseenter=()=>{z(),E.style.background="#333",T=M},E.onmouseleave=()=>{E.style.background="#1a1a1a"},E.onclick=()=>B(v),R.appendChild(E)})}function z(){R.querySelectorAll("div").forEach(m=>{m.style.background="#1a1a1a"})}function se(){if(z(),T>=0&&T<C.length){let m=R.querySelector(`[data-index="${T}"]`);m&&(m.style.background="#333",m.scrollIntoView({block:"nearest"}))}}function B(m){c.includes(m)||(c.push(m),U()),_.value="",R.style.display="none",T=-1}return _.oninput=()=>{oe?(X=_.value,oe()):(clearTimeout(y),y=setTimeout(()=>A(_.value),300))},_.onkeydown=m=>{if(R.style.display!=="none")switch(m.key){case"ArrowDown":m.preventDefault(),T=Math.min(T+1,C.length-1),se();break;case"ArrowUp":m.preventDefault(),T=Math.max(T-1,-1),se();break;case"Enter":{m.preventDefault();let v=C[T];T>=0&&v!==void 0&&B(v);break}case"Escape":R.style.display="none",T=-1;break}},_.onblur=()=>{setTimeout(()=>{R.contains(document.activeElement)||(R.style.display="none")},200)},p.append(_,R,Q),U(),p}var Ae=V("features/details-providers/links"),Me=P(Ae,"externalLink");var ce=P(Ae,"pathSegment"),Ne=P(Ae,"safeHref");var ie=V("features/details-providers/wire");var h=P(ie,"field"),we=P(ie,"int"),Se=P(ie,"isRecord"),ne=P(ie,"list");var Z=P(ie,"str");var de=P(ie,"text");function Fe(s){return s?s.replace(/'/g,"").replace(/\n/g,",").split(",").map(r=>r.trim()).filter(r=>r):[]}function Et(s){if(!Se(s))return null;let r={provider_name:Z(s.provider_name)??"",logo_path:Z(s.logo_path)??""},u=we(s.provider_id);return u!==void 0&&(r.provider_id=u),r}function kt(s){let r={},u=de(h(s,"link"));u!==void 0&&(r.link=u);let c=h(s,"flatrate");return Array.isArray(c)&&(r.flatrate=c.map(Et).filter(p=>p!==null)),r}function Ce(s){let r={},u=h(s,"results");if(Se(u))for(let[c,p]of Object.entries(u))r[c]=kt(p);return{results:r}}function Xe(s){let r={};for(let u of ne(h(s,"watchProviders"))){let c=Z(h(u,"iso_3166_1"));!c||!/^[A-Z]{2}$/.test(c)||(r[c]={link:h(u,"link"),flatrate:ne(h(u,"flatrate")).filter(Se).map(p=>({provider_id:h(p,"id"),provider_name:h(p,"name"),logo_path:h(p,"logoPath")}))})}return Ce({results:r})}function re(s,r){return s&&Object.prototype.hasOwnProperty.call(s.results,r)?s.results[r]:void 0}function Qe(s,r,u){let c=s||[];if(r.defaults.length>0&&(c=c.filter(p=>r.defaults.includes(p.provider_name))),r.ignore.length>0)try{let p=r.ignore.map(y=>new RegExp(y,"i"));c=c.filter(y=>!p.some(A=>A.test(y.provider_name)))}catch(p){u(p)}return c}function et(s){let r=(s||"").toString().trim().toLowerCase();return r===""||r==="aired"||r==="airdate"||r==="default"}async function tt(s,r,u){let c=new Array(s.length),p=0,y=Array.from({length:Math.min(r,s.length)},async()=>{for(;p<s.length;){let A=p++,$=s[A];$!==void 0&&(c[A]=await u($))}});return await Promise.all(y),c}function nt(s){let r=s.filter(p=>p>0),u=[];for(let p=0;p<r.length;){let y=p;for(;y+1<r.length&&r[y+1]===(r[y]??NaN)+1;)y++;u.push(y>p?`${r[p]}–${r[y]}`:String(r[p])),p=y+1}let c=s.includes(0);return{single:u.length===1&&!c&&r.length===1?r[0]??null:null,specialsOnly:u.length===0&&c,ranges:u,hasSpecials:c}}function rt(s){let r=new Map;for(let c of s){let p=c.services.map(A=>A.provider_id??NaN).sort((A,$)=>A-$).join(","),y=r.get(p);y||r.set(p,y={services:c.services,numbers:[]}),y.numbers.push(c.number)}if(r.size<=1)return null;let u=[...r.values()].filter(c=>c.services.length>0);return u.length>0?u:null}function ot(s){return s.length===1?s[0]??"":s.length===2?s.join(" and "):`${s.slice(0,-1).join(", ")} and ${s[s.length-1]??""}`}function st(s){let r={};for(let u of s.trim().split(`
`)){if(u.startsWith("#"))continue;let[c,p]=u.split("	");c&&p&&(r[c]=p)}return r}function it(s){return s.trim().split(`
`).filter(r=>!r.startsWith("#")&&r.trim()!=="")}var at={US:"United States",GB:"United Kingdom",IN:"India",CA:"Canada",DE:"Germany",FR:"France",JP:"Japan",AU:"Australia",BR:"Brazil",MX:"Mexico",IE:"Ireland",IT:"Italy",ES:"Spain",NL:"Netherlands",SE:"Sweden",NO:"Norway",DK:"Denmark",FI:"Finland"},lt=["Netflix","Amazon Prime Video","Disney Plus","HBO Max","Hulu","Apple TV Plus","Paramount Plus","Peacock","JioCinema","Disney+ Hotstar","ZEE5","SonyLIV"];function ct(s){let r=Z(h(s,"message"))||"";return s instanceof TypeError&&r==="Failed to fetch"?"TMDB API is unreachable.":s instanceof SyntaxError?"Received an unexpected response from the server. Check your reverse proxy or Jellyfin configuration.":r.includes("401")?"Invalid TMDB API Key.":r.includes("404")?"The requested item could not be found on TMDB.":r.includes("429")?"Too many requests. Please wait a moment and try again.":r.startsWith("HTTP 5")?"The TMDB service is temporarily unavailable. Please try again later.":r||"An unknown error occurred"}function Ee(s,r){return{region:de(h(s,"Region"))||r,regions:Array.isArray(h(s,"Regions"))?ne(h(s,"Regions")).filter(u=>typeof u=="string"):[],services:Array.isArray(h(s,"Services"))?ne(h(s,"Services")).filter(u=>typeof u=="string"):[],seasonProviders:h(s,"SeasonProviders")!==!1}}var i=Ze("Jellyfin Elsewhere"),ke="🪼 Jellyfin Enhanced: 🎬 Jellyfin Elsewhere:";i.initializeElsewhereScript=function(){let r=i.pluginConfig;if(!r.ElsewhereEnabled){console.log(`${ke} Feature is disabled in plugin settings.`);return}let u=!!r.TmdbEnabled,c=r.DEFAULT_REGION||"US",p={defaults:Fe(r.DEFAULT_PROVIDERS),ignore:Fe(r.IGNORE_PROVIDERS)},y=r.ElsewhereCustomBrandingText||"",A=r.ElsewhereCustomBrandingImageUrl||"",$=!u&&!!r.JellyseerrEnabled,X=u&&r.ElsewhereSeasonProviders!==!1;if(!u&&!$){console.log(`${ke} Neither TMDB nor Seerr is configured, skipping initialization`);return}let oe=!!r.ElsewhereUseSeerrRegion&&!!r.JellyseerrEnabled,_=null,R=0,Q=()=>oe&&_!==null,T=e=>oe&&_||e,C=c,U=[],J=[],z={},se=[],B=!0,m=0,v=0,M=e=>Qe(e,p,t=>console.error(`${ke} Invalid regex in IGNORE_PROVIDERS.`,t)),E=e=>(Object.prototype.hasOwnProperty.call(z,e)?z[e]:void 0)||e;console.log("🪼 Jellyfin Enhanced: 🎬 Jellyfin Elsewhere starting...");function dt(){fetch(i.cdn.url("elsewhere-res","regions.txt")).then(e=>e.ok?e.text():Promise.reject(new Error(`HTTP ${e.status}`))).then(e=>{z={...z,...st(e)}}).catch(()=>{z={...at}}),fetch(i.cdn.url("elsewhere-res","providers.txt")).then(e=>e.ok?e.text():Promise.reject(new Error(`HTTP ${e.status}`))).then(e=>{se=it(e)}).catch(()=>{se=[...lt]})}function ae(e,t="18px"){let n=document.createElement("span");return n.className="material-icons",n.textContent=e,n.style.fontSize=t,n.style.lineHeight="1",n}let Pe="streaming-settings-modal";function Be(){let e=document.getElementById(Pe);e instanceof HTMLElement&&(e.style.display="none",e.replaceChildren())}function He(){let e=document.getElementById(Pe);if(e instanceof HTMLDivElement)return e;let t=document.createElement("div");return t.id=Pe,t.style.cssText=`
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
            `,t.onclick=n=>{n.target===t&&(t.style.display="none")},document.body.appendChild(t),t}function d(e,t,n){let o=document.createElement(e);return o.style.cssText=t,n!==void 0&&(o.textContent=n),o}function pt(e,t){let n=te(i.session),o=m,a=()=>n()&&o===m,l=!1,f=d("div",`
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
            `);f.appendChild(d("h3","margin-top: 0; margin-bottom: 16px; color: #fff; font-size: 18px; font-weight: bolder;",i.t("elsewhere_settings_title")));let x=d("div","margin-bottom: 16px;"),b=d("div","display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;");b.appendChild(d("label","font-weight: 600; color: #ccc;",i.t("elsewhere_settings_country")));let g=d("button","display: flex; align-items: center; justify-content: center; background: transparent; border: none; color: #999; cursor: pointer; padding: 2px; border-radius: 4px;");g.type="button",g.id="reset-region-btn",g.title="Reset to plugin default",g.appendChild(ae("restart_alt","16px")),b.appendChild(g),x.appendChild(b);let q=Q(),N=d("div","display: none; margin-bottom: 6px; font-size: 12px; color: #999;");N.id="seerr-region-note",q&&_&&(N.textContent=i.t("elsewhere_settings_seerr_region",{region:E(_)}),N.style.display=""),x.appendChild(N);let I=d("select","width: 100%; padding: 12px; border: 1px solid #444; border-radius: 6px; background: #2a2a2a; color: #fff; font-size: 14px;");I.id="region-select";for(let[k,O]of Object.entries(z)){let F=document.createElement("option");F.value=k,F.textContent=O,k===C&&(F.selected=!0),I.appendChild(F)}for(let k of new Set([C,c])){if(Array.from(I.options).some(F=>F.value===k))continue;let O=document.createElement("option");O.value=k,O.textContent=k,I.appendChild(O)}I.value=C,I.disabled=q,x.appendChild(I),f.appendChild(x);let w=d("div","margin-bottom: 16px;");w.appendChild(d("label","display: block; margin-bottom: 5px; font-weight: 600; color: #ccc;",i.t("elsewhere_settings_other_countries")));let ee=document.createElement("div");ee.id="regions-autocomplete",w.appendChild(ee),q&&(w.style.display="none"),f.appendChild(w);let L=d("div","margin-bottom: 16px;");L.appendChild(d("label","display: block; margin-bottom: 6px; font-weight: 600; color: #ccc;",i.t("elsewhere_settings_providers")));let G=document.createElement("div");G.id="services-autocomplete",L.appendChild(G),f.appendChild(L);let j=null;if(X){let k=d("label","display: flex; align-items: center; gap: 8px; margin-bottom: 16px; color: #ccc; cursor: pointer;");j=d("input","width: 16px; height: 16px; cursor: pointer;"),j.type="checkbox",j.id="season-providers-checkbox",j.checked=B,k.append(j,d("span","",i.t("elsewhere_settings_season_providers"))),f.appendChild(k)}let S=d("div","display: flex; gap: 12px; justify-content: flex-end;"),D=d("button","padding: 10px 18px; border: 1px solid #444; background: #2a2a2a; color: #fff; border-radius: 6px; cursor: pointer; font-size: 14px;",i.t("elsewhere_settings_cancel"));D.id="cancel-settings";let H=d("button","padding: 10px 18px; border: none; background: #0078d4; color: white; border-radius: 6px; cursor: pointer; font-size: 14px;",i.t("elsewhere_settings_save"));H.id="save-settings",S.append(D,H),f.appendChild(S),g.onmouseenter=()=>{g.style.color="#fff"},g.onmouseleave=()=>{g.style.color="#999"},g.onclick=()=>{I.value=c};let Le=Object.entries(z).map(([k,O])=>`${O} (${k})`);ee.appendChild(De(i.helpers,i.t("elsewhere_settings_add_countries_placeholder"),Le,U.map(k=>`${E(k)} (${k})`))),G.appendChild(De(i.helpers,i.t("elsewhere_settings_add_providers_placeholder"),se,J.slice())),D.onclick=()=>{e.style.display="none"},H.onclick=async()=>{if(l||!a()||!e.isConnected||e.style.display==="none")return;l=!0,H.disabled=!0;let k=I.value,O=[];ee.querySelectorAll(".selected-tag").forEach(W=>{let K=(W.dataset.value??"").match(/\(([A-Z]{2})\)$/);K?.[1]&&O.push(K[1])});let F=O,xe=[];G.querySelectorAll(".selected-tag").forEach(W=>{xe.push((W.dataset.value??"").trim())});let Ve=xe,le=j?.checked??B,be={...t,Region:q?de(h(t,"Region"))??"":k,Regions:F,Services:Ve,SeasonProviders:le};try{if(await i.saveUserSettings("elsewhere.json",be,{throwOnError:!0,isCurrent:a}),!a())return;i.userConfig.elsewhere=be,ue()}catch{if(a()&&e.isConnected){let K=f.querySelector(".je-elsewhere-save-error");K||(K=document.createElement("p"),K.className="je-elsewhere-save-error",K.setAttribute("role","alert"),S.before(K)),K.textContent=pe("elsewhere_settings_save_failed","Could not save your choices. Try again.")}}finally{l=!1,a()&&(H.disabled=!1)}},e.replaceChildren(f)}function ut(e){if(e===null||typeof e!="object"||Array.isArray(e))return!1;let t=h(e,"Region"),n=h(e,"Regions"),o=h(e,"Services"),a=h(e,"SeasonProviders");return(t==null||typeof t=="string")&&(n==null||Array.isArray(n)&&n.every(l=>typeof l=="string"))&&(o==null||Array.isArray(o)&&o.every(l=>typeof l=="string"))&&(a==null||typeof a=="boolean")}function pe(e,t){let n=i.t(e);return n&&n!==e?n:t}function $e(){let e=He(),t=++v,n=te(i.session),o=()=>t===v&&n()&&e.isConnected&&e.style.display!=="none";e.replaceChildren(d("p","color: #fff;",pe("elsewhere_settings_loading","Loading your settings…"))),e.style.display="flex";let a=Y(),l=a.getCurrentUserId();Promise.resolve().then(()=>{if(!o()||!l)throw new Error("Settings opening cancelled");return a.ajax({type:"GET",url:a.getUrl(`/JellyfinEnhanced/user-settings/${l}/elsewhere.json?_=${Date.now()}`),dataType:"json"})}).then(f=>{if(!o())return;if(!ut(f))throw new Error("Invalid Elsewhere settings document");let x=Ee(f,c);C=T(x.region),U=x.regions,J=x.services,B=x.seasonProviders,_e(),pt(e,f),he()}).catch(()=>{if(!o())return;let f=d("div","padding: 24px; background: #181818; color: #fff;",pe("elsewhere_settings_load_failed","Your settings could not be loaded. No changes were saved.")),x=d("button","",pe("elsewhere_settings_retry","Retry"));x.type="button",x.onclick=$e;let b=d("button","",i.t("elsewhere_settings_cancel"));b.type="button",b.onclick=()=>{e.style.display="none",v++},f.append(x,b),e.replaceChildren(f)})}function _e(){m++,document.querySelectorAll(".streaming-lookup-container").forEach(e=>e.remove()),fe.clear(),ge.clear(),me.clear()}function ue(e=!0){let t=Ee(i.userConfig.elsewhere,c);C=T(t.region),U=t.regions,J=t.services,B=t.seasonProviders,e&&(v++,Be(),_e(),e&&he())}function Ue(){if(!oe)return;let e=++R,t=te(i.session);i.core.api.fetch(Y().getUrl("/JellyfinEnhanced/jellyseerr/streaming-region")).then(n=>Z(h(n,"region"))??null,()=>null).then(n=>{e!==R||!t()||(_=n!==null&&/^[A-Z]{2}$/.test(n)?n:null,T(Ee(i.userConfig.elsewhere,c).region)!==C&&ue())})}document.addEventListener("je:user-data-loaded",()=>{ue(),Ue()}),i.session?.onUserChange("elsewhere",()=>{_=null,R++,C=c,U=[],J=[],B=!0,v++,Be(),_e()});function Re(e){let t=d("div",`
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
            `,n.onerror=()=>{n.style.display="none"},t.appendChild(n);let o=document.createElement("span");return o.textContent=e.provider_name,t.appendChild(o),t.onmouseenter=()=>{t.style.transform="translateY(-2px)",t.style.background="rgba(255, 255, 255, 0.2)",t.style.boxShadow="0 4px 12px rgba(0, 0, 0, 0.3)"},t.onmouseleave=()=>{t.style.transform="translateY(0)",t.style.background="rgba(255, 255, 255, 0.1)",t.style.boxShadow="none"},t}function Je(e,t,n){let o=te(i.session),a=m,l=()=>o()&&a===m;if($){let b=Y().getUrl(`/JellyfinEnhanced/jellyseerr/${t}/${ce(e)}`);i.core.api.fetch(b,{cacheKey:`seerr-providers:${t}:${e}`}).then(g=>{l()&&n(null,Xe(g))}).catch(g=>{l()&&n(Z(h(g,"message"))||"Could not load streaming info from Seerr.",null)});return}let f=`/${t}/${ce(e)}/watch/providers`,x=Y().getUrl(`/JellyfinEnhanced/tmdb${f}`);i.core.api.fetch(x,{cacheKey:`tmdb:${f}`}).then(b=>{l()&&n(null,Ce(b))}).catch(b=>{l()&&n(ct(b),null)})}let ft=4,fe=new Map,ge=new Map;function gt(e,t){let n=`${e}:${t}`,o=fe.get(n);if(!o){let a=Y().getUrl(`/JellyfinEnhanced/tmdb/tv/${ce(e)}/season/${t}/watch/providers`);o=i.core.api.fetch(a).then(Ce).catch(()=>(fe.delete(n),null)),fe.set(n,o)}return o}function mt(e){let t=ge.get(e);if(!t){let n=Y().getUrl(`/JellyfinEnhanced/tmdb/tv/${ce(e)}`);t=i.core.api.fetch(n).then(o=>{let a=h(o,"seasons");return Array.isArray(a)?new Set(a.map(l=>we(h(l,"season_number"))).filter(l=>l!==void 0)):null}).catch(()=>(ge.delete(e),null)),ge.set(e,t)}return t}async function ht(e){let t=Y(),n=t.getUrl(`Shows/${e}/Seasons`,{userId:t.getCurrentUserId()??""}),o=await i.core.api.fetch(n);return ne(h(o,"Items")).map(a=>h(a,"IndexNumber")).filter(a=>Number.isInteger(a)).sort((a,l)=>a-l)}async function ze(e){if(!X||!B)return null;let t=ve();if(!t)return null;let n=await Oe(i.helpers,t,!1);if(!n)return null;let o,a=null;if(n.Type==="Series")o=n;else if(n.Type==="Season"&&n.SeriesId&&Number.isInteger(n.IndexNumber))o=await Oe(i.helpers,n.SeriesId,!1),a=n.IndexNumber??null;else return null;if(!o||!o.Id||!et(o.DisplayOrder))return null;let l=o.ProviderIds.Tmdb;return!l||e&&l!==e?null:{kind:a===null?"series":"season",seriesId:o.Id,tmdbId:l,seasonNumber:a}}function xt(e){let t=nt(e);if(t.single!==null)return i.t("elsewhere_season_label",{number:t.single});if(t.specialsOnly)return i.t("jellyseerr_season_specials");let n=[...t.ranges];return t.hasSpecials&&n.push(i.t("jellyseerr_season_specials")),i.t("elsewhere_seasons_label",{range:n.join(", ")})}async function bt(e,t){let n=M(re(t,C)?.flatrate),o=await mt(e.tmdbId),a=e.kind==="season"&&e.seasonNumber!==null?[e.seasonNumber]:await ht(e.seriesId);if(a.length===0)return null;let f=(await tt(a,ft,async g=>{let N=!o||o.has(g)?await gt(e.tmdbId,g):null,I=M(re(N,C)?.flatrate);return I.length>0?{number:g,services:I,link:re(N,C)?.link}:g===0?null:{number:g,services:n,link:void 0}})).filter(g=>!!g),[x]=f;if(!x)return null;if(e.kind==="season")return{servicesOverride:x.services,link:x.link};let b=rt(f);return b?{groups:b.map(g=>({label:xt(g.numbers),services:g.services}))}:null}function qe(e,t,n){let o=document.createElement("button");return o.className=e,o.appendChild(ae(t,"16px")),o.style.cssText=n,o.onmouseenter=()=>{o.style.background="rgba(255, 255, 255, 0.2)"},o.onmouseleave=()=>{o.style.background="rgba(255, 255, 255, 0.1)"},o}function We(e){let t=document.createElement("button");return t.appendChild(ae("close","16px")),t.style.cssText=`
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
            `,t.onmouseenter=()=>{t.style.background="rgba(255, 0, 0, 0.2)",t.style.borderColor="rgba(255, 0, 0, 0.3)"},t.onmouseleave=()=>{t.style.background="rgba(255, 255, 255, 0.1)",t.style.borderColor="rgba(255, 255, 255, 0.2)"},t.onclick=()=>e.remove(),t}function yt(e,t,n,o={}){let a=re(e,C),l=d("div",`
                margin: 10px 0;
                padding: 12px;
                background: rgba(0, 0, 0, 0.2);
                border-radius: 8px;
                border: 1px solid rgba(255, 255, 255, 0.1);
                backdrop-filter: blur(10px);
                position: relative;
            `),f=d("div",`
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 10px;
            `),x=!!a?.flatrate&&a.flatrate.length>0,b=x?M(a?.flatrate):[];o.servicesOverride&&(b=o.servicesOverride);let g=o.groups||null,q=o.link||a?.link||"",N=!!g||b.length>0,I=!N&&!!y,w=Me(i.helpers,N&&q?q:"#",{title:"JustWatch"});if(N)w.textContent=i.t("elsewhere_panel_available_in",{region:E(C)});else if(y){if(w.textContent=y,w.classList.add("elsewhere-custom-branding"),w.style.cursor="default",A){w.style.display="flex",w.style.alignItems="center",w.style.gap="8px";let S=document.createElement("img");S.src=A,S.alt="Custom Branding",S.className="elsewhere-custom-branding-icon",S.style.cssText=`
                        width: 24px;
                        height: 24px;
                        object-fit: contain;
                        margin-left: 4px;
                    `,S.onerror=()=>{S.style.display="none"},w.appendChild(S)}}else w.textContent=i.t("elsewhere_panel_not_available_in",{region:E(C)});w.style.cssText=`
                font-weight: 600;
                font-size: 14px;
                text-decoration: none;
                cursor: pointer;
                color: #fff;
                flex: 1;
                text-align: left;
                display: flex;
                align-items: flex-end;
            `,N&&q?(w.classList.add("elsewhere-link-reset"),w.href=Ne(q),w.style.padding="0",w.style.margin="0"):I&&(w.style.cursor="default");let ee=d("div",`
                display: flex;
                gap: 8px;
                align-items: center;
            `),L=qe("elsewhere-search-button","search",`
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
                opacity: ${I?"0":"1"};
            `);L.appendChild(document.createTextNode(""));let G=qe("elsewhere-settings-button","settings",`
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
                opacity: ${I?"0":"1"};
            `);if(G.onclick=()=>$e(),ee.append(L,G),f.append(w,ee),l.appendChild(f),I&&(l.onmouseenter=()=>{L.style.opacity="1",G.style.opacity="1"},l.onmouseleave=()=>{L.style.opacity="0",G.style.opacity="0"}),x||N)if(g)for(let S of g){l.appendChild(d("div","font-size: 12px; font-weight: 600; color: #aaa; margin: 4px 0 2px;",S.label));let D=d("div","display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px;");for(let H of S.services)D.appendChild(Re(H));l.appendChild(D)}else if(N){let S=d("div","display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 12px;");for(let D of b)S.appendChild(Re(D));l.appendChild(S)}else p.defaults.length>0&&l.appendChild(d("div","color: #999; font-size: 13px; margin-bottom: 12px;",i.t("elsewhere_panel_no_configured_services")));let j=document.createElement("div");return j.id="streaming-result-container",l.appendChild(j),L.onclick=()=>{L.disabled=!0,L.replaceChildren();let S=ae("refresh","16px");if(S.style.animation="spin 1s linear infinite",L.append(S,document.createTextNode(" "+i.t("elsewhere_panel_search_button"))),L.style.opacity="0.7",j.replaceChildren(),!document.querySelector("style[data-jellyfin-elsewhere]")){let D=document.createElement("style");D.textContent=`
                    @keyframes spin {
                        0% { transform: rotate(0deg); }
                        100% { transform: rotate(360deg); }
                    }
                `,D.setAttribute("data-jellyfin-elsewhere","true"),document.head.appendChild(D)}Je(t,n,(D,H)=>{if(L.disabled=!1,L.replaceChildren(ae("search","16px"),document.createTextNode("")),L.style.opacity="1",D||!H){j.replaceChildren(d("div","color: #ff6b6b; font-size: 13px; margin-top: 8px;",i.t("elsewhere_panel_error",{error:D??""})));return}let Le=!Q()&&U.length>0?U:[C],k=!1,O=[];Le.forEach((F,xe)=>{let le=re(H,F)?.flatrate??[],be=J.length>0?le.filter(W=>J.includes(W.provider_name)):le;if(le.length>0&&be.length>0){k=!0;let W=wt(H,F);W&&((xe>0||O.length>0)&&(W.style.marginTop="6px"),j.appendChild(W))}else O.push(F)}),O.length>0&&j.insertBefore(vt(O),j.firstChild),!k&&O.length===0&&j.appendChild(d("div","color: #6c757d; font-size: 13px; margin-top: 8px;",i.t("elsewhere_panel_no_services_in_regions")))})},l}function vt(e){let t=d("div",`
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
            `),o=d("div",`
                font-weight: 600;
                font-size: 14px;
                color: rgb(255, 20, 20);
                flex: 1;
            `,i.t("elsewhere_panel_not_available_in_regions",{regions:ot(e.map(E))})),a=We(t);return a.title="Close",n.append(o,a),t.appendChild(n),t}function wt(e,t){let n=re(e,t);if(!n?.flatrate)return null;let o=n.flatrate.filter(b=>J.length===0||J.includes(b.provider_name));if(o.length===0)return null;let a=d("div",`
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
            `),f=Me(i.helpers,n.link||"#",{title:"JustWatch"});f.textContent=i.t("elsewhere_panel_available_in_region",{region:E(t)}),f.style.cssText=`
                font-weight: 600;
                font-size: 14px;
                text-decoration: none;
                cursor: pointer;
                color: #fff;
                flex: 1;
                text-align: left;
            `,n.link&&(f.classList.add("elsewhere-link-reset"),f.href=Ne(n.link),f.style.padding="0",f.style.margin="0"),l.append(f,We(a)),a.appendChild(l);let x=d("div","display: flex; flex-wrap: wrap; gap: 3px;");for(let b of o)x.appendChild(Re(b));return a.appendChild(x),a}function St(e,t,n){let o=te(i.session),a=m,l=()=>o()&&a===m&&n.isConnected;Je(e,t,async(f,x)=>{if(!l())return;if(f||!x){n.appendChild(d("div","font-size: 13px; margin-top: 8px; color: #ff6b6b;",i.t("elsewhere_panel_error",{error:f??""})));return}let b={};if(t==="tv"&&X&&B)try{let g=await ze(e);if(!l())return;g&&(b=await bt(g,x)||{})}catch(g){console.warn(`${ke} Per-season providers unavailable, using series providers.`,g)}l()&&n.appendChild(yt(x,e,t,b))})}function Ge(e,t,n){let o=document.createElement("div");o.className="streaming-lookup-container",o.style.cssText="margin: 16px 0;",St(t,n,o);let a=e.querySelector(".itemExternalLinks");a?.parentNode?a.parentNode.insertBefore(o,a.nextSibling):e.appendChild(o)}let me=new Set;function Ct(e){if(!X||!B)return;let t=e.closest("#itemDetailPage")??document;if(t!==document&&t!==je()||t.querySelector(".streaming-lookup-container")||e!==t.querySelector(".detailSectionContent"))return;let n=ve();if(!n||me.has(n))return;me.add(n);let o=te(i.session),a=m;ze().then(l=>{!o()||a!==m||!l||l.kind!=="season"||!e.isConnected||ve()!==n||t.querySelector(".streaming-lookup-container")||Ge(e,l.tmdbId,"tv")}).catch(()=>{}).finally(()=>me.delete(n))}function he(){document.querySelectorAll(".detailSectionContent").forEach(e=>{let t=e.closest("#itemDetailPage");if(t&&t!==je()||e.querySelector(".streaming-lookup-container"))return;let n=e.querySelector('a[href*="themoviedb.org"]');if(!n){Ct(e);return}let o=n.href.match(/themoviedb\.org\/(movie|tv)\/(\d+)/);!o?.[1]||!o[2]||Ge(e,o[2],o[1])})}dt(),ue(!1),Ue();let Te=(e,t,n)=>{typeof requestIdleCallback<"u"?requestIdleCallback(e,{timeout:t}):setTimeout(e,n)};Te(()=>{He()},2e3,2e3);let Ie=!1,Ke=()=>{Ie||(Ie=!0,Te(()=>{he(),Ie=!1},500,100))};i.helpers.createObserver("elsewhere",Ke,document.body,{childList:!0,subtree:!0}),i.helpers.onViewPage(Ke),Te(()=>he(),1e3,1e3),console.log("🪼 Jellyfin Enhanced: 🎬 Jellyfin Elsewhere loaded!")};})();
})();
