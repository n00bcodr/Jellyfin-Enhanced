(() => {
"use strict";(()=>{function se(o){let n=window.JellyfinEnhanced?.core?.sharedModules?.[o];if(!n)throw new Error(`${o} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return n}function j(o,n){return o[n]}var Ye=se("features/details-providers/host"),q=j(Ye,"api"),Ze=j(Ye,"bridge");var ve=se("features/details-providers/page");var we=j(ve,"hashItemId");var Ae=j(ve,"lookupDetailsItem");var ee=j(ve,"sessionLease"),De=j(ve,"visibleDetailPage");function Ne(o,n,i,c){let a=document.createElement("div");a.style.cssText="position: relative; margin-bottom: 6px;";let y,N=m=>{let v=m.toLowerCase();if(v.length===0){S.style.display="none";return}Y(i.filter(P=>P.toLowerCase().includes(v)&&!c.includes(P)))},U=o.debounce,ae="",X=U?U.call(o,()=>N(ae),300):null,A=document.createElement("input");A.type="text",A.placeholder=n,A.style.cssText=`
            width: 100%;
            padding: 10px;
            border: 1px solid #444;
            border-radius: 6px;
            box-sizing: border-box;
            background: #2a2a2a;
            color: #fff;
            font-size: 14px;
        `;let S=document.createElement("div");S.style.cssText=`
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
        `;let K=document.createElement("div");K.style.cssText=`
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-top: 6px;
        `;let _=-1,V=[];function C(){K.replaceChildren();for(let m of c){let v=document.createElement("span");v.className="selected-tag",v.style.cssText=`
                    background: #0078d4;
                    color: white;
                    padding: 4px 10px;
                    border-radius: 16px;
                    font-size: 12px;
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                `,v.textContent=m,v.dataset.value=m;let P=document.createElement("span");P.textContent="×",P.style.cssText="cursor: pointer; font-weight: bold; font-size: 14px;",P.onclick=()=>{let R=c.indexOf(m);R>-1&&(c.splice(R,1),C())},v.appendChild(P),K.appendChild(v)}}function Y(m){S.replaceChildren(),S.style.display="block",V=m,_=-1,m.forEach((v,P)=>{let R=document.createElement("div");R.textContent=v,R.style.cssText=`
                    padding: 10px;
                    cursor: pointer;
                    border-bottom: 1px solid #333;
                    color: #fff;
                    font-size: 14px;
                `,R.dataset.index=String(P),R.onmouseenter=()=>{$(),R.style.background="#333",_=P},R.onmouseleave=()=>{R.style.background="#1a1a1a"},R.onclick=()=>re(v),S.appendChild(R)})}function $(){S.querySelectorAll("div").forEach(m=>{m.style.background="#1a1a1a"})}function H(){if($(),_>=0&&_<V.length){let m=S.querySelector(`[data-index="${_}"]`);m&&(m.style.background="#333",m.scrollIntoView({block:"nearest"}))}}function re(m){c.includes(m)||(c.push(m),C()),A.value="",S.style.display="none",_=-1}return A.oninput=()=>{X?(ae=A.value,X()):(clearTimeout(y),y=setTimeout(()=>N(A.value),300))},A.onkeydown=m=>{if(S.style.display!=="none")switch(m.key){case"ArrowDown":m.preventDefault(),_=Math.min(_+1,V.length-1),H();break;case"ArrowUp":m.preventDefault(),_=Math.max(_-1,-1),H();break;case"Enter":{m.preventDefault();let v=V[_];_>=0&&v!==void 0&&re(v);break}case"Escape":S.style.display="none",_=-1;break}},A.onblur=()=>{setTimeout(()=>{S.contains(document.activeElement)||(S.style.display="none")},200)},a.append(A,S,K),C(),a}function Xe(o,n){try{let i=new URL(o,n);return["http:","https:","mailto:","tel:","ftp:","blob:"].includes(i.protocol)?o:"#"}catch{return"#"}}function Se(o){return Xe(o,window.location.href)}function Me(o,n,i={}){let c=o?.createExternalLink;if(c)return c(n,i);let a=document.createElement("a");return a.setAttribute("is","emby-linkbutton"),a.href=Se(n),a.target="_blank",a.rel="noopener noreferrer",i.title&&(a.title=i.title),i.className&&(a.className=i.className),i.text&&(a.textContent=i.text),i.resetStyle&&(a.style.cssText="padding:0;background:none;border-radius:0;min-width:0;"),typeof i.setup=="function"&&i.setup(a),a}function de(o){return encodeURIComponent(o)}function Qe(o,n){let i=(a,y)=>{try{return q().getUrl(a,y)}catch{return null}};if(n){let a=i("/JellyfinEnhanced/ElsewhereBrandingIcon",{v:n});if(a)return a}let c=String(o||"").trim();return/^\/(web|JellyfinEnhanced)\//i.test(c)&&i(c)||c}function et(o,n){let i=document.createElement("img");return i.src=o,i.alt="Custom Branding",i.className="elsewhere-custom-branding-icon",i.style.cssText=`
                        width: 24px;
                        height: 24px;
                        object-fit: contain;
                        margin-left: 4px;
                    `,i.onerror=()=>{i.style.display="none",console.warn(n?`🪼 Jellyfin Enhanced: the uploaded Elsewhere custom branding icon failed to load from "${o}". Re-upload it in the plugin settings.`:`🪼 Jellyfin Enhanced: Elsewhere custom branding icon failed to load from "${o}". It must be a web address the browser can open, not a server file path.`)},i}var ie=se("features/details-providers/wire");var h=j(ie,"field"),Ee=j(ie,"int"),Ce=j(ie,"isRecord"),te=j(ie,"list");var Z=j(ie,"str");var pe=j(ie,"text");function Be(o){return o?o.replace(/'/g,"").replace(/\n/g,",").split(",").map(n=>n.trim()).filter(n=>n):[]}function Pt(o){if(!Ce(o))return null;let n={provider_name:Z(o.provider_name)??"",logo_path:Z(o.logo_path)??""},i=Ee(o.provider_id);return i!==void 0&&(n.provider_id=i),n}function Rt(o){let n={},i=pe(h(o,"link"));i!==void 0&&(n.link=i);let c=h(o,"flatrate");return Array.isArray(c)&&(n.flatrate=c.map(Pt).filter(a=>a!==null)),n}function ke(o){let n={},i=h(o,"results");if(Ce(i))for(let[c,a]of Object.entries(i))n[c]=Rt(a);return{results:n}}function tt(o){let n={};for(let i of te(h(o,"watchProviders"))){let c=Z(h(i,"iso_3166_1"));!c||!/^[A-Z]{2}$/.test(c)||(n[c]={link:h(i,"link"),flatrate:te(h(i,"flatrate")).filter(Ce).map(a=>({provider_id:h(a,"id"),provider_name:h(a,"name"),logo_path:h(a,"logoPath")}))})}return ke({results:n})}function ne(o,n){return o&&Object.prototype.hasOwnProperty.call(o.results,n)?o.results[n]:void 0}function nt(o,n,i){let c=o||[];if(n.defaults.length>0&&(c=c.filter(a=>n.defaults.includes(a.provider_name))),n.ignore.length>0)try{let a=n.ignore.map(y=>new RegExp(y,"i"));c=c.filter(y=>!a.some(N=>N.test(y.provider_name)))}catch(a){i(a)}return c}function rt(o){let n=(o||"").toString().trim().toLowerCase();return n===""||n==="aired"||n==="airdate"||n==="default"}async function ot(o,n,i){let c=new Array(o.length),a=0,y=Array.from({length:Math.min(n,o.length)},async()=>{for(;a<o.length;){let N=a++,U=o[N];U!==void 0&&(c[N]=await i(U))}});return await Promise.all(y),c}function st(o){let n=o.filter(a=>a>0),i=[];for(let a=0;a<n.length;){let y=a;for(;y+1<n.length&&n[y+1]===(n[y]??NaN)+1;)y++;i.push(y>a?`${n[a]}–${n[y]}`:String(n[a])),a=y+1}let c=o.includes(0);return{single:i.length===1&&!c&&n.length===1?n[0]??null:null,specialsOnly:i.length===0&&c,ranges:i,hasSpecials:c}}function it(o){let n=new Map;for(let c of o){let a=c.services.map(N=>N.provider_id??NaN).sort((N,U)=>N-U).join(","),y=n.get(a);y||n.set(a,y={services:c.services,numbers:[]}),y.numbers.push(c.number)}if(n.size<=1)return null;let i=[...n.values()].filter(c=>c.services.length>0);return i.length>0?i:null}function at(o){return o.length===1?o[0]??"":o.length===2?o.join(" and "):`${o.slice(0,-1).join(", ")} and ${o[o.length-1]??""}`}function lt(o){let n={};for(let i of o.trim().split(`
`)){if(i.startsWith("#"))continue;let[c,a]=i.split("	");c&&a&&(n[c]=a)}return n}function ct(o){return o.trim().split(`
`).filter(n=>!n.startsWith("#")&&n.trim()!=="")}var dt={US:"United States",GB:"United Kingdom",IN:"India",CA:"Canada",DE:"Germany",FR:"France",JP:"Japan",AU:"Australia",BR:"Brazil",MX:"Mexico",IE:"Ireland",IT:"Italy",ES:"Spain",NL:"Netherlands",SE:"Sweden",NO:"Norway",DK:"Denmark",FI:"Finland"},pt=["Netflix","Amazon Prime Video","Disney Plus","HBO Max","Hulu","Apple TV Plus","Paramount Plus","Peacock","JioCinema","Disney+ Hotstar","ZEE5","SonyLIV"];function ut(o){let n=Z(h(o,"message"))||"";return o instanceof TypeError&&n==="Failed to fetch"?"TMDB API is unreachable.":o instanceof SyntaxError?"Received an unexpected response from the server. Check your reverse proxy or Jellyfin configuration.":n.includes("401")?"Invalid TMDB API Key.":n.includes("404")?"The requested item could not be found on TMDB.":n.includes("429")?"Too many requests. Please wait a moment and try again.":n.startsWith("HTTP 5")?"The TMDB service is temporarily unavailable. Please try again later.":n||"An unknown error occurred"}function _e(o,n){return{region:pe(h(o,"Region"))||n,regions:Array.isArray(h(o,"Regions"))?te(h(o,"Regions")).filter(i=>typeof i=="string"):[],services:Array.isArray(h(o,"Services"))?te(h(o,"Services")).filter(i=>typeof i=="string"):[],seasonProviders:h(o,"SeasonProviders")!==!1}}var l=Ze("Jellyfin Elsewhere"),Pe="🪼 Jellyfin Enhanced: 🎬 Jellyfin Elsewhere:";l.initializeElsewhereScript=function(){let n=l.pluginConfig;if(!n.ElsewhereEnabled){console.log(`${Pe} Feature is disabled in plugin settings.`);return}let i=!!n.TmdbEnabled,c=n.DEFAULT_REGION||"US",a={defaults:Be(n.DEFAULT_PROVIDERS),ignore:Be(n.IGNORE_PROVIDERS)},y=n.ElsewhereCustomBrandingText||"",N=!!n.ElsewhereCustomBrandingIconVersion,U=Qe(n.ElsewhereCustomBrandingImageUrl,n.ElsewhereCustomBrandingIconVersion),ae=!i&&!!n.JellyseerrEnabled,X=i&&n.ElsewhereSeasonProviders!==!1;if(!i&&!ae){console.log(`${Pe} Neither TMDB nor Seerr is configured, skipping initialization`);return}let A=!!n.ElsewhereUseSeerrRegion&&!!n.JellyseerrEnabled,S=null,K=0,_=()=>A&&S!==null,V=e=>A&&S||e,C=c,Y=[],$=[],H={},re=[],m=!0,v=0,P=0,R=e=>nt(e,a,t=>console.error(`${Pe} Invalid regex in IGNORE_PROVIDERS.`,t)),oe=e=>(Object.prototype.hasOwnProperty.call(H,e)?H[e]:void 0)||e;console.log("🪼 Jellyfin Enhanced: 🎬 Jellyfin Elsewhere starting...");function ft(){fetch(l.cdn.url("elsewhere-res","regions.txt")).then(e=>e.ok?e.text():Promise.reject(new Error(`HTTP ${e.status}`))).then(e=>{H={...H,...lt(e)}}).catch(()=>{H={...dt}}),fetch(l.cdn.url("elsewhere-res","providers.txt")).then(e=>e.ok?e.text():Promise.reject(new Error(`HTTP ${e.status}`))).then(e=>{re=ct(e)}).catch(()=>{re=[...pt]})}function le(e,t="18px"){let r=document.createElement("span");return r.className="material-icons",r.textContent=e,r.style.fontSize=t,r.style.lineHeight="1",r}let Re="streaming-settings-modal";function $e(){let e=document.getElementById(Re);e instanceof HTMLElement&&(e.style.display="none",e.replaceChildren())}function Fe(){let e=document.getElementById(Re);if(e instanceof HTMLDivElement)return e;let t=document.createElement("div");return t.id=Re,t.style.cssText=`
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
            `,t.onclick=r=>{r.target===t&&(t.style.display="none")},document.body.appendChild(t),t}function u(e,t,r){let s=document.createElement(e);return s.style.cssText=t,r!==void 0&&(s.textContent=r),s}function gt(e,t){let r=ee(l.session),s=v,d=()=>r()&&s===v,p=!1,f=u("div",`
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
            `);f.appendChild(u("h3","margin-top: 0; margin-bottom: 16px; color: #fff; font-size: 18px; font-weight: bolder;",l.t("elsewhere_settings_title")));let x=u("div","margin-bottom: 16px;"),b=u("div","display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;");b.appendChild(u("label","font-weight: 600; color: #ccc;",l.t("elsewhere_settings_country")));let g=u("button","display: flex; align-items: center; justify-content: center; background: transparent; border: none; color: #999; cursor: pointer; padding: 2px; border-radius: 4px;");g.type="button",g.id="reset-region-btn",g.title="Reset to plugin default",g.appendChild(le("restart_alt","16px")),b.appendChild(g),x.appendChild(b);let J=_(),D=u("div","display: none; margin-bottom: 6px; font-size: 12px; color: #999;");D.id="seerr-region-note",J&&S&&(D.textContent=l.t("elsewhere_settings_seerr_region",{region:oe(S)}),D.style.display=""),x.appendChild(D);let k=u("select","width: 100%; padding: 12px; border: 1px solid #444; border-radius: 6px; background: #2a2a2a; color: #fff; font-size: 14px;");k.id="region-select";for(let[E,T]of Object.entries(H)){let B=document.createElement("option");B.value=E,B.textContent=T,E===C&&(B.selected=!0),k.appendChild(B)}for(let E of new Set([C,c])){if(Array.from(k.options).some(B=>B.value===E))continue;let T=document.createElement("option");T.value=E,T.textContent=E,k.appendChild(T)}k.value=C,k.disabled=J,x.appendChild(k),f.appendChild(x);let w=u("div","margin-bottom: 16px;");w.appendChild(u("label","display: block; margin-bottom: 5px; font-weight: 600; color: #ccc;",l.t("elsewhere_settings_other_countries")));let Q=document.createElement("div");Q.id="regions-autocomplete",w.appendChild(Q),J&&(w.style.display="none"),f.appendChild(w);let I=u("div","margin-bottom: 16px;");I.appendChild(u("label","display: block; margin-bottom: 6px; font-weight: 600; color: #ccc;",l.t("elsewhere_settings_providers")));let W=document.createElement("div");W.id="services-autocomplete",I.appendChild(W),f.appendChild(I);let L=null;if(X){let E=u("label","display: flex; align-items: center; gap: 8px; margin-bottom: 16px; color: #ccc; cursor: pointer;");L=u("input","width: 16px; height: 16px; cursor: pointer;"),L.type="checkbox",L.id="season-providers-checkbox",L.checked=m,E.append(L,u("span","",l.t("elsewhere_settings_season_providers"))),f.appendChild(E)}let M=u("div","display: flex; gap: 12px; justify-content: flex-end;"),O=u("button","padding: 10px 18px; border: 1px solid #444; background: #2a2a2a; color: #fff; border-radius: 6px; cursor: pointer; font-size: 14px;",l.t("elsewhere_settings_cancel"));O.id="cancel-settings";let F=u("button","padding: 10px 18px; border: none; background: #0078d4; color: white; border-radius: 6px; cursor: pointer; font-size: 14px;",l.t("elsewhere_settings_save"));F.id="save-settings",M.append(O,F),f.appendChild(M),g.onmouseenter=()=>{g.style.color="#fff"},g.onmouseleave=()=>{g.style.color="#999"},g.onclick=()=>{k.value=c};let je=Object.entries(H).map(([E,T])=>`${T} (${E})`);Q.appendChild(Ne(l.helpers,l.t("elsewhere_settings_add_countries_placeholder"),je,Y.map(E=>`${oe(E)} (${E})`))),W.appendChild(Ne(l.helpers,l.t("elsewhere_settings_add_providers_placeholder"),re,$.slice())),O.onclick=()=>{e.style.display="none"},F.onclick=async()=>{if(p||!d()||!e.isConnected||e.style.display==="none")return;p=!0,F.disabled=!0;let E=k.value,T=[];Q.querySelectorAll(".selected-tag").forEach(z=>{let G=(z.dataset.value??"").match(/\(([A-Z]{2})\)$/);G?.[1]&&T.push(G[1])});let B=T,be=[];W.querySelectorAll(".selected-tag").forEach(z=>{be.push((z.dataset.value??"").trim())});let Ve=be,ce=L?.checked??m,ye={...t,Region:J?pe(h(t,"Region"))??"":E,Regions:B,Services:Ve,SeasonProviders:ce};try{if(await l.saveUserSettings("elsewhere.json",ye,{throwOnError:!0,isCurrent:d}),!d())return;l.userConfig.elsewhere=ye,fe()}catch{if(d()&&e.isConnected){let G=f.querySelector(".je-elsewhere-save-error");G||(G=document.createElement("p"),G.className="je-elsewhere-save-error",G.setAttribute("role","alert"),M.before(G)),G.textContent=ue("elsewhere_settings_save_failed","Could not save your choices. Try again.")}}finally{p=!1,d()&&(F.disabled=!1)}},e.replaceChildren(f)}function mt(e){if(e===null||typeof e!="object"||Array.isArray(e))return!1;let t=h(e,"Region"),r=h(e,"Regions"),s=h(e,"Services"),d=h(e,"SeasonProviders");return(t==null||typeof t=="string")&&(r==null||Array.isArray(r)&&r.every(p=>typeof p=="string"))&&(s==null||Array.isArray(s)&&s.every(p=>typeof p=="string"))&&(d==null||typeof d=="boolean")}function ue(e,t){let r=l.t(e);return r&&r!==e?r:t}function Ue(){let e=Fe(),t=++P,r=ee(l.session),s=()=>t===P&&r()&&e.isConnected&&e.style.display!=="none";e.replaceChildren(u("p","color: #fff;",ue("elsewhere_settings_loading","Loading your settings…"))),e.style.display="flex";let d=q(),p=d.getCurrentUserId();Promise.resolve().then(()=>{if(!s()||!p)throw new Error("Settings opening cancelled");return d.ajax({type:"GET",url:d.getUrl(`/JellyfinEnhanced/user-settings/${p}/elsewhere.json?_=${Date.now()}`),dataType:"json"})}).then(f=>{if(!s())return;if(!mt(f))throw new Error("Invalid Elsewhere settings document");let x=_e(f,c);C=V(x.region),Y=x.regions,$=x.services,m=x.seasonProviders,Ie(),gt(e,f),xe()}).catch(()=>{if(!s())return;let f=u("div","padding: 24px; background: #181818; color: #fff;",ue("elsewhere_settings_load_failed","Your settings could not be loaded. No changes were saved.")),x=u("button","",ue("elsewhere_settings_retry","Retry"));x.type="button",x.onclick=Ue;let b=u("button","",l.t("elsewhere_settings_cancel"));b.type="button",b.onclick=()=>{e.style.display="none",P++},f.append(x,b),e.replaceChildren(f)})}function Ie(){v++,document.querySelectorAll(".streaming-lookup-container").forEach(e=>e.remove()),ge.clear(),me.clear(),he.clear()}function fe(e=!0){let t=_e(l.userConfig.elsewhere,c);C=V(t.region),Y=t.regions,$=t.services,m=t.seasonProviders,e&&(P++,$e(),Ie(),e&&xe())}function He(){if(!A)return;let e=++K,t=ee(l.session);l.core.api.fetch(q().getUrl("/JellyfinEnhanced/jellyseerr/streaming-region")).then(r=>Z(h(r,"region"))??null,()=>null).then(r=>{e!==K||!t()||(S=r!==null&&/^[A-Z]{2}$/.test(r)?r:null,V(_e(l.userConfig.elsewhere,c).region)!==C&&fe())})}document.addEventListener("je:user-data-loaded",()=>{fe(),He()}),l.session?.onUserChange("elsewhere",()=>{S=null,K++,C=c,Y=[],$=[],m=!0,P++,$e(),Ie()});function Te(e){let t=u("div",`
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
            `),r=document.createElement("img");r.src=`https://image.tmdb.org/t/p/w92${e.logo_path}`,r.alt=e.provider_name,r.style.cssText=`
                width: 20px;
                height: 20px;
                margin-right: 8px;
                object-fit: contain;
                border-radius: 4px;
            `,r.onerror=()=>{r.style.display="none"},t.appendChild(r);let s=document.createElement("span");return s.textContent=e.provider_name,t.appendChild(s),t.onmouseenter=()=>{t.style.transform="translateY(-2px)",t.style.background="rgba(255, 255, 255, 0.2)",t.style.boxShadow="0 4px 12px rgba(0, 0, 0, 0.3)"},t.onmouseleave=()=>{t.style.transform="translateY(0)",t.style.background="rgba(255, 255, 255, 0.1)",t.style.boxShadow="none"},t}function Je(e,t,r){let s=ee(l.session),d=v,p=()=>s()&&d===v;if(ae){let b=q().getUrl(`/JellyfinEnhanced/jellyseerr/${t}/${de(e)}`);l.core.api.fetch(b,{cacheKey:`seerr-providers:${t}:${e}`}).then(g=>{p()&&r(null,tt(g))}).catch(g=>{p()&&r(Z(h(g,"message"))||"Could not load streaming info from Seerr.",null)});return}let f=`/${t}/${de(e)}/watch/providers`,x=q().getUrl(`/JellyfinEnhanced/tmdb${f}`);l.core.api.fetch(x,{cacheKey:`tmdb:${f}`}).then(b=>{p()&&r(null,ke(b))}).catch(b=>{p()&&r(ut(b),null)})}let ht=4,ge=new Map,me=new Map;function xt(e,t){let r=`${e}:${t}`,s=ge.get(r);if(!s){let d=q().getUrl(`/JellyfinEnhanced/tmdb/tv/${de(e)}/season/${t}/watch/providers`);s=l.core.api.fetch(d).then(ke).catch(()=>(ge.delete(r),null)),ge.set(r,s)}return s}function bt(e){let t=me.get(e);if(!t){let r=q().getUrl(`/JellyfinEnhanced/tmdb/tv/${de(e)}`);t=l.core.api.fetch(r).then(s=>{let d=h(s,"seasons");return Array.isArray(d)?new Set(d.map(p=>Ee(h(p,"season_number"))).filter(p=>p!==void 0)):null}).catch(()=>(me.delete(e),null)),me.set(e,t)}return t}async function yt(e){let t=q(),r=t.getUrl(`Shows/${e}/Seasons`,{userId:t.getCurrentUserId()??""}),s=await l.core.api.fetch(r);return te(h(s,"Items")).map(d=>h(d,"IndexNumber")).filter(d=>Number.isInteger(d)).sort((d,p)=>d-p)}async function ze(e){if(!X||!m)return null;let t=we();if(!t)return null;let r=await Ae(l.helpers,t,!1);if(!r)return null;let s,d=null;if(r.Type==="Series")s=r;else if(r.Type==="Season"&&r.SeriesId&&Number.isInteger(r.IndexNumber))s=await Ae(l.helpers,r.SeriesId,!1),d=r.IndexNumber??null;else return null;if(!s||!s.Id||!rt(s.DisplayOrder))return null;let p=s.ProviderIds.Tmdb;return!p||e&&p!==e?null:{kind:d===null?"series":"season",seriesId:s.Id,tmdbId:p,seasonNumber:d}}function vt(e){let t=st(e);if(t.single!==null)return l.t("elsewhere_season_label",{number:t.single});if(t.specialsOnly)return l.t("jellyseerr_season_specials");let r=[...t.ranges];return t.hasSpecials&&r.push(l.t("jellyseerr_season_specials")),l.t("elsewhere_seasons_label",{range:r.join(", ")})}async function wt(e,t){let r=R(ne(t,C)?.flatrate),s=await bt(e.tmdbId),d=e.kind==="season"&&e.seasonNumber!==null?[e.seasonNumber]:await yt(e.seriesId);if(d.length===0)return null;let f=(await ot(d,ht,async g=>{let D=!s||s.has(g)?await xt(e.tmdbId,g):null,k=R(ne(D,C)?.flatrate);return k.length>0?{number:g,services:k,link:ne(D,C)?.link}:g===0?null:{number:g,services:r,link:void 0}})).filter(g=>!!g),[x]=f;if(!x)return null;if(e.kind==="season")return{servicesOverride:x.services,link:x.link};let b=it(f);return b?{groups:b.map(g=>({label:vt(g.numbers),services:g.services}))}:null}function qe(e,t,r){let s=document.createElement("button");return s.className=e,s.appendChild(le(t,"16px")),s.style.cssText=r,s.onmouseenter=()=>{s.style.background="rgba(255, 255, 255, 0.2)"},s.onmouseleave=()=>{s.style.background="rgba(255, 255, 255, 0.1)"},s}function We(e){let t=document.createElement("button");return t.appendChild(le("close","16px")),t.style.cssText=`
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
            `,t.onmouseenter=()=>{t.style.background="rgba(255, 0, 0, 0.2)",t.style.borderColor="rgba(255, 0, 0, 0.3)"},t.onmouseleave=()=>{t.style.background="rgba(255, 255, 255, 0.1)",t.style.borderColor="rgba(255, 255, 255, 0.2)"},t.onclick=()=>e.remove(),t}function St(e,t,r,s={}){let d=ne(e,C),p=u("div",`
                margin: 10px 0;
                padding: 12px;
                background: rgba(0, 0, 0, 0.2);
                border-radius: 8px;
                border: 1px solid rgba(255, 255, 255, 0.1);
                backdrop-filter: blur(10px);
                position: relative;
            `),f=u("div",`
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 10px;
            `),x=!!d?.flatrate&&d.flatrate.length>0,b=x?R(d?.flatrate):[];s.servicesOverride&&(b=s.servicesOverride);let g=s.groups||null,J=s.link||d?.link||"",D=!!g||b.length>0,k=!D&&!!y,w=Me(l.helpers,D&&J?J:"#",{title:"JustWatch"});D?w.textContent=l.t("elsewhere_panel_available_in",{region:oe(C)}):y?(w.textContent=y,w.classList.add("elsewhere-custom-branding"),w.style.cursor="default",U&&w.appendChild(et(U,N))):w.textContent=l.t("elsewhere_panel_not_available_in",{region:oe(C)}),w.style.cssText=`
                font-weight: 600;
                font-size: 14px;
                text-decoration: none;
                cursor: pointer;
                color: #fff;
                flex: 1;
                text-align: left;
                display: flex;
                align-items: flex-end;
            `,w.querySelector(".elsewhere-custom-branding-icon")&&(w.style.alignItems="center",w.style.gap="8px"),D&&J?(w.classList.add("elsewhere-link-reset"),w.href=Se(J),w.style.padding="0",w.style.margin="0"):k&&(w.style.cursor="default");let Q=u("div",`
                display: flex;
                gap: 8px;
                align-items: center;
            `),I=qe("elsewhere-search-button","search",`
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
                opacity: ${k?"0":"1"};
            `);I.appendChild(document.createTextNode(""));let W=qe("elsewhere-settings-button","settings",`
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
                opacity: ${k?"0":"1"};
            `);if(W.onclick=()=>Ue(),Q.append(I,W),f.append(w,Q),p.appendChild(f),k&&(p.onmouseenter=()=>{I.style.opacity="1",W.style.opacity="1"},p.onmouseleave=()=>{I.style.opacity="0",W.style.opacity="0"}),x||D)if(g)for(let M of g){p.appendChild(u("div","font-size: 12px; font-weight: 600; color: #aaa; margin: 4px 0 2px;",M.label));let O=u("div","display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px;");for(let F of M.services)O.appendChild(Te(F));p.appendChild(O)}else if(D){let M=u("div","display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 12px;");for(let O of b)M.appendChild(Te(O));p.appendChild(M)}else a.defaults.length>0&&p.appendChild(u("div","color: #999; font-size: 13px; margin-bottom: 12px;",l.t("elsewhere_panel_no_configured_services")));let L=document.createElement("div");return L.id="streaming-result-container",p.appendChild(L),I.onclick=()=>{I.disabled=!0,I.replaceChildren();let M=le("refresh","16px");if(M.style.animation="spin 1s linear infinite",I.append(M,document.createTextNode(" "+l.t("elsewhere_panel_search_button"))),I.style.opacity="0.7",L.replaceChildren(),!document.querySelector("style[data-jellyfin-elsewhere]")){let O=document.createElement("style");O.textContent=`
                    @keyframes spin {
                        0% { transform: rotate(0deg); }
                        100% { transform: rotate(360deg); }
                    }
                `,O.setAttribute("data-jellyfin-elsewhere","true"),document.head.appendChild(O)}Je(t,r,(O,F)=>{if(I.disabled=!1,I.replaceChildren(le("search","16px"),document.createTextNode("")),I.style.opacity="1",O||!F){L.replaceChildren(u("div","color: #ff6b6b; font-size: 13px; margin-top: 8px;",l.t("elsewhere_panel_error",{error:O??""})));return}let je=!_()&&Y.length>0?Y:[C],E=!1,T=[];je.forEach((B,be)=>{let ce=ne(F,B)?.flatrate??[],ye=$.length>0?ce.filter(z=>$.includes(z.provider_name)):ce;if(ce.length>0&&ye.length>0){E=!0;let z=Ct(F,B);z&&((be>0||T.length>0)&&(z.style.marginTop="6px"),L.appendChild(z))}else T.push(B)}),T.length>0&&L.insertBefore(Et(T),L.firstChild),!E&&T.length===0&&L.appendChild(u("div","color: #6c757d; font-size: 13px; margin-top: 8px;",l.t("elsewhere_panel_no_services_in_regions")))})},p}function Et(e){let t=u("div",`
                margin: 0 0 6px 0;
                padding: 12px;
                border-radius: 8px;
                border: 1px solid rgba(139, 19, 19, 0.6);
                background: rgba(139, 19, 19, 0.3);
                backdrop-filter: blur(10px);
                position: relative;
            `),r=u("div",`
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 0;
            `),s=u("div",`
                font-weight: 600;
                font-size: 14px;
                color: rgb(255, 20, 20);
                flex: 1;
            `,l.t("elsewhere_panel_not_available_in_regions",{regions:at(e.map(oe))})),d=We(t);return d.title="Close",r.append(s,d),t.appendChild(r),t}function Ct(e,t){let r=ne(e,t);if(!r?.flatrate)return null;let s=r.flatrate.filter(b=>$.length===0||$.includes(b.provider_name));if(s.length===0)return null;let d=u("div",`
                margin: 10px 0 0 0;
                padding: 12px;
                background: rgba(0, 0, 0, 0.3);
                border-radius: 8px;
                border: 1px solid rgba(255, 255, 255, 0.1);
                backdrop-filter: blur(10px);
                position: relative;
            `),p=u("div",`
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 10px;
            `),f=Me(l.helpers,r.link||"#",{title:"JustWatch"});f.textContent=l.t("elsewhere_panel_available_in_region",{region:oe(t)}),f.style.cssText=`
                font-weight: 600;
                font-size: 14px;
                text-decoration: none;
                cursor: pointer;
                color: #fff;
                flex: 1;
                text-align: left;
            `,r.link&&(f.classList.add("elsewhere-link-reset"),f.href=Se(r.link),f.style.padding="0",f.style.margin="0"),p.append(f,We(d)),d.appendChild(p);let x=u("div","display: flex; flex-wrap: wrap; gap: 3px;");for(let b of s)x.appendChild(Te(b));return d.appendChild(x),d}function kt(e,t,r){let s=ee(l.session),d=v,p=()=>s()&&d===v&&r.isConnected;Je(e,t,async(f,x)=>{if(!p())return;if(f||!x){r.appendChild(u("div","font-size: 13px; margin-top: 8px; color: #ff6b6b;",l.t("elsewhere_panel_error",{error:f??""})));return}let b={};if(t==="tv"&&X&&m)try{let g=await ze(e);if(!p())return;g&&(b=await wt(g,x)||{})}catch(g){console.warn(`${Pe} Per-season providers unavailable, using series providers.`,g)}p()&&r.appendChild(St(x,e,t,b))})}function Ge(e,t,r){let s=document.createElement("div");s.className="streaming-lookup-container",s.style.cssText="margin: 16px 0;",kt(t,r,s);let d=e.querySelector(".itemExternalLinks");d?.parentNode?d.parentNode.insertBefore(s,d.nextSibling):e.appendChild(s)}let he=new Set;function _t(e){if(!X||!m)return;let t=e.closest("#itemDetailPage")??document;if(t!==document&&t!==De()||t.querySelector(".streaming-lookup-container")||e!==t.querySelector(".detailSectionContent"))return;let r=we();if(!r||he.has(r))return;he.add(r);let s=ee(l.session),d=v;ze().then(p=>{!s()||d!==v||!p||p.kind!=="season"||!e.isConnected||we()!==r||t.querySelector(".streaming-lookup-container")||Ge(e,p.tmdbId,"tv")}).catch(()=>{}).finally(()=>he.delete(r))}function xe(){document.querySelectorAll(".detailSectionContent").forEach(e=>{let t=e.closest("#itemDetailPage");if(t&&t!==De()||e.querySelector(".streaming-lookup-container"))return;let r=e.querySelector('a[href*="themoviedb.org"]');if(!r){_t(e);return}let s=r.href.match(/themoviedb\.org\/(movie|tv)\/(\d+)/);!s?.[1]||!s[2]||Ge(e,s[2],s[1])})}ft(),fe(!1),He();let Le=(e,t,r)=>{typeof requestIdleCallback<"u"?requestIdleCallback(e,{timeout:t}):setTimeout(e,r)};Le(()=>{Fe()},2e3,2e3);let Oe=!1,Ke=()=>{Oe||(Oe=!0,Le(()=>{xe(),Oe=!1},500,100))};l.helpers.createObserver("elsewhere",Ke,document.body,{childList:!0,subtree:!0}),l.helpers.onViewPage(Ke),Le(()=>xe(),1e3,1e3),console.log("🪼 Jellyfin Enhanced: 🎬 Jellyfin Elsewhere loaded!")};})();
})();
