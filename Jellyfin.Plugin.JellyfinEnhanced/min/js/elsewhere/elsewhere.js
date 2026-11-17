(() => {
"use strict";(()=>{function Z(s){let r=window.JellyfinEnhanced?.core?.sharedModules?.[s];if(!r)throw new Error(`${s} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return r}function C(s,r){return s[r]}var Ze=Z("features/details-providers/host"),q=C(Ze,"api"),Xe=C(Ze,"bridge");var ve=Z("features/details-providers/page");var we=C(ve,"hashItemId");var je=C(ve,"lookupDetailsItem");var te=C(ve,"sessionLease"),De=C(ve,"visibleDetailPage");function Ae(s,r,c,l){let p=document.createElement("div");p.style.cssText="position: relative; margin-bottom: 6px;";let y,M=m=>{let v=m.toLowerCase();if(v.length===0){S.style.display="none";return}Y(c.filter(R=>R.toLowerCase().includes(v)&&!l.includes(R)))},H=s.debounce,ae="",Q=H?H.call(s,()=>M(ae),300):null,D=document.createElement("input");D.type="text",D.placeholder=r,D.style.cssText=`
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
        `;let P=-1,V=[];function k(){K.replaceChildren();for(let m of l){let v=document.createElement("span");v.className="selected-tag",v.style.cssText=`
                    background: #0078d4;
                    color: white;
                    padding: 4px 10px;
                    border-radius: 16px;
                    font-size: 12px;
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                `,v.textContent=m,v.dataset.value=m;let R=document.createElement("span");R.textContent="×",R.style.cssText="cursor: pointer; font-weight: bold; font-size: 14px;",R.onclick=()=>{let I=l.indexOf(m);I>-1&&(l.splice(I,1),k())},v.appendChild(R),K.appendChild(v)}}function Y(m){S.replaceChildren(),S.style.display="block",V=m,P=-1,m.forEach((v,R)=>{let I=document.createElement("div");I.textContent=v,I.style.cssText=`
                    padding: 10px;
                    cursor: pointer;
                    border-bottom: 1px solid #333;
                    color: #fff;
                    font-size: 14px;
                `,I.dataset.index=String(R),I.onmouseenter=()=>{F(),I.style.background="#333",P=R},I.onmouseleave=()=>{I.style.background="#1a1a1a"},I.onclick=()=>oe(v),S.appendChild(I)})}function F(){S.querySelectorAll("div").forEach(m=>{m.style.background="#1a1a1a"})}function U(){if(F(),P>=0&&P<V.length){let m=S.querySelector(`[data-index="${P}"]`);m&&(m.style.background="#333",m.scrollIntoView({block:"nearest"}))}}function oe(m){l.includes(m)||(l.push(m),k()),D.value="",S.style.display="none",P=-1}return D.oninput=()=>{Q?(ae=D.value,Q()):(clearTimeout(y),y=setTimeout(()=>M(D.value),300))},D.onkeydown=m=>{if(S.style.display!=="none")switch(m.key){case"ArrowDown":m.preventDefault(),P=Math.min(P+1,V.length-1),U();break;case"ArrowUp":m.preventDefault(),P=Math.max(P-1,-1),U();break;case"Enter":{m.preventDefault();let v=V[P];P>=0&&v!==void 0&&oe(v);break}case"Escape":S.style.display="none",P=-1;break}},D.onblur=()=>{setTimeout(()=>{S.contains(document.activeElement)||(S.style.display="none")},200)},p.append(D,S,K),k(),p}var Me=Z("features/details-providers/links"),Ne=C(Me,"externalLink");var de=C(Me,"pathSegment"),Be=C(Me,"safeHref");function Qe(s,r){let c=(p,y)=>{try{return q().getUrl(p,y)}catch{return null}};if(r){let p=c("/JellyfinEnhanced/ElsewhereBrandingIcon",{v:r});if(p)return p}let l=String(s||"").trim();return/^\/(web|JellyfinEnhanced)\//i.test(l)&&c(l)||l}function et(s,r){let c=document.createElement("img");return c.src=s,c.alt="Custom Branding",c.className="elsewhere-custom-branding-icon",c.style.cssText=`
                        width: 24px;
                        height: 24px;
                        object-fit: contain;
                        margin-left: 4px;
                    `,c.onerror=()=>{c.style.display="none",console.warn(r?`🪼 Jellyfin Enhanced: the uploaded Elsewhere custom branding icon failed to load from "${s}". Re-upload it in the plugin settings.`:`🪼 Jellyfin Enhanced: Elsewhere custom branding icon failed to load from "${s}". It must be a web address the browser can open, not a server file path.`)},c}var ie=Z("features/details-providers/wire");var h=C(ie,"field"),Se=C(ie,"int"),Ee=C(ie,"isRecord"),ne=C(ie,"list");var X=C(ie,"str");var pe=C(ie,"text");function Fe(s){return s?s.replace(/'/g,"").replace(/\n/g,",").split(",").map(r=>r.trim()).filter(r=>r):[]}function Pt(s){if(!Ee(s))return null;let r={provider_name:X(s.provider_name)??"",logo_path:X(s.logo_path)??""},c=Se(s.provider_id);return c!==void 0&&(r.provider_id=c),r}function Rt(s){let r={},c=pe(h(s,"link"));c!==void 0&&(r.link=c);let l=h(s,"flatrate");return Array.isArray(l)&&(r.flatrate=l.map(Pt).filter(p=>p!==null)),r}function Ce(s){let r={},c=h(s,"results");if(Ee(c))for(let[l,p]of Object.entries(c))r[l]=Rt(p);return{results:r}}function tt(s){let r={};for(let c of ne(h(s,"watchProviders"))){let l=X(h(c,"iso_3166_1"));!l||!/^[A-Z]{2}$/.test(l)||(r[l]={link:h(c,"link"),flatrate:ne(h(c,"flatrate")).filter(Ee).map(p=>({provider_id:h(p,"id"),provider_name:h(p,"name"),logo_path:h(p,"logoPath")}))})}return Ce({results:r})}function re(s,r){return s&&Object.prototype.hasOwnProperty.call(s.results,r)?s.results[r]:void 0}function nt(s,r,c){let l=s||[];if(r.defaults.length>0&&(l=l.filter(p=>r.defaults.includes(p.provider_name))),r.ignore.length>0)try{let p=r.ignore.map(y=>new RegExp(y,"i"));l=l.filter(y=>!p.some(M=>M.test(y.provider_name)))}catch(p){c(p)}return l}function rt(s){let r=(s||"").toString().trim().toLowerCase();return r===""||r==="aired"||r==="airdate"||r==="default"}async function ot(s,r,c){let l=new Array(s.length),p=0,y=Array.from({length:Math.min(r,s.length)},async()=>{for(;p<s.length;){let M=p++,H=s[M];H!==void 0&&(l[M]=await c(H))}});return await Promise.all(y),l}function st(s){let r=s.filter(p=>p>0),c=[];for(let p=0;p<r.length;){let y=p;for(;y+1<r.length&&r[y+1]===(r[y]??NaN)+1;)y++;c.push(y>p?`${r[p]}–${r[y]}`:String(r[p])),p=y+1}let l=s.includes(0);return{single:c.length===1&&!l&&r.length===1?r[0]??null:null,specialsOnly:c.length===0&&l,ranges:c,hasSpecials:l}}function it(s){let r=new Map;for(let l of s){let p=l.services.map(M=>M.provider_id??NaN).sort((M,H)=>M-H).join(","),y=r.get(p);y||r.set(p,y={services:l.services,numbers:[]}),y.numbers.push(l.number)}if(r.size<=1)return null;let c=[...r.values()].filter(l=>l.services.length>0);return c.length>0?c:null}function at(s){return s.length===1?s[0]??"":s.length===2?s.join(" and "):`${s.slice(0,-1).join(", ")} and ${s[s.length-1]??""}`}function lt(s){let r={};for(let c of s.trim().split(`
`)){if(c.startsWith("#"))continue;let[l,p]=c.split("	");l&&p&&(r[l]=p)}return r}function ct(s){return s.trim().split(`
`).filter(r=>!r.startsWith("#")&&r.trim()!=="")}var dt={US:"United States",GB:"United Kingdom",IN:"India",CA:"Canada",DE:"Germany",FR:"France",JP:"Japan",AU:"Australia",BR:"Brazil",MX:"Mexico",IE:"Ireland",IT:"Italy",ES:"Spain",NL:"Netherlands",SE:"Sweden",NO:"Norway",DK:"Denmark",FI:"Finland"},pt=["Netflix","Amazon Prime Video","Disney Plus","HBO Max","Hulu","Apple TV Plus","Paramount Plus","Peacock","JioCinema","Disney+ Hotstar","ZEE5","SonyLIV"];function ut(s){let r=X(h(s,"message"))||"";return s instanceof TypeError&&r==="Failed to fetch"?"TMDB API is unreachable.":s instanceof SyntaxError?"Received an unexpected response from the server. Check your reverse proxy or Jellyfin configuration.":r.includes("401")?"Invalid TMDB API Key.":r.includes("404")?"The requested item could not be found on TMDB.":r.includes("429")?"Too many requests. Please wait a moment and try again.":r.startsWith("HTTP 5")?"The TMDB service is temporarily unavailable. Please try again later.":r||"An unknown error occurred"}function ke(s,r){return{region:pe(h(s,"Region"))||r,regions:Array.isArray(h(s,"Regions"))?ne(h(s,"Regions")).filter(c=>typeof c=="string"):[],services:Array.isArray(h(s,"Services"))?ne(h(s,"Services")).filter(c=>typeof c=="string"):[],seasonProviders:h(s,"SeasonProviders")!==!1}}var i=Xe("Jellyfin Elsewhere"),_e="🪼 Jellyfin Enhanced: 🎬 Jellyfin Elsewhere:";i.initializeElsewhereScript=function(){let r=i.pluginConfig;if(!r.ElsewhereEnabled){console.log(`${_e} Feature is disabled in plugin settings.`);return}let c=!!r.TmdbEnabled,l=r.DEFAULT_REGION||"US",p={defaults:Fe(r.DEFAULT_PROVIDERS),ignore:Fe(r.IGNORE_PROVIDERS)},y=r.ElsewhereCustomBrandingText||"",M=!!r.ElsewhereCustomBrandingIconVersion,H=Qe(r.ElsewhereCustomBrandingImageUrl,r.ElsewhereCustomBrandingIconVersion),ae=!c&&!!r.JellyseerrEnabled,Q=c&&r.ElsewhereSeasonProviders!==!1;if(!c&&!ae){console.log(`${_e} Neither TMDB nor Seerr is configured, skipping initialization`);return}let D=!!r.ElsewhereUseSeerrRegion&&!!r.JellyseerrEnabled,S=null,K=0,P=()=>D&&S!==null,V=e=>D&&S||e,k=l,Y=[],F=[],U={},oe=[],m=!0,v=0,R=0,I=e=>nt(e,p,t=>console.error(`${_e} Invalid regex in IGNORE_PROVIDERS.`,t)),se=e=>(Object.prototype.hasOwnProperty.call(U,e)?U[e]:void 0)||e;console.log("🪼 Jellyfin Enhanced: 🎬 Jellyfin Elsewhere starting...");function ft(){fetch(i.cdn.url("elsewhere-res","regions.txt")).then(e=>e.ok?e.text():Promise.reject(new Error(`HTTP ${e.status}`))).then(e=>{U={...U,...lt(e)}}).catch(()=>{U={...dt}}),fetch(i.cdn.url("elsewhere-res","providers.txt")).then(e=>e.ok?e.text():Promise.reject(new Error(`HTTP ${e.status}`))).then(e=>{oe=ct(e)}).catch(()=>{oe=[...pt]})}function le(e,t="18px"){let n=document.createElement("span");return n.className="material-icons",n.textContent=e,n.style.fontSize=t,n.style.lineHeight="1",n}let Pe="streaming-settings-modal";function $e(){let e=document.getElementById(Pe);e instanceof HTMLElement&&(e.style.display="none",e.replaceChildren())}function He(){let e=document.getElementById(Pe);if(e instanceof HTMLDivElement)return e;let t=document.createElement("div");return t.id=Pe,t.style.cssText=`
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
            `,t.onclick=n=>{n.target===t&&(t.style.display="none")},document.body.appendChild(t),t}function u(e,t,n){let o=document.createElement(e);return o.style.cssText=t,n!==void 0&&(o.textContent=n),o}function gt(e,t){let n=te(i.session),o=v,a=()=>n()&&o===v,d=!1,f=u("div",`
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
            `);f.appendChild(u("h3","margin-top: 0; margin-bottom: 16px; color: #fff; font-size: 18px; font-weight: bolder;",i.t("elsewhere_settings_title")));let x=u("div","margin-bottom: 16px;"),b=u("div","display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;");b.appendChild(u("label","font-weight: 600; color: #ccc;",i.t("elsewhere_settings_country")));let g=u("button","display: flex; align-items: center; justify-content: center; background: transparent; border: none; color: #999; cursor: pointer; padding: 2px; border-radius: 4px;");g.type="button",g.id="reset-region-btn",g.title="Reset to plugin default",g.appendChild(le("restart_alt","16px")),b.appendChild(g),x.appendChild(b);let J=P(),A=u("div","display: none; margin-bottom: 6px; font-size: 12px; color: #999;");A.id="seerr-region-note",J&&S&&(A.textContent=i.t("elsewhere_settings_seerr_region",{region:se(S)}),A.style.display=""),x.appendChild(A);let _=u("select","width: 100%; padding: 12px; border: 1px solid #444; border-radius: 6px; background: #2a2a2a; color: #fff; font-size: 14px;");_.id="region-select";for(let[E,L]of Object.entries(U)){let B=document.createElement("option");B.value=E,B.textContent=L,E===k&&(B.selected=!0),_.appendChild(B)}for(let E of new Set([k,l])){if(Array.from(_.options).some(B=>B.value===E))continue;let L=document.createElement("option");L.value=E,L.textContent=E,_.appendChild(L)}_.value=k,_.disabled=J,x.appendChild(_),f.appendChild(x);let w=u("div","margin-bottom: 16px;");w.appendChild(u("label","display: block; margin-bottom: 5px; font-weight: 600; color: #ccc;",i.t("elsewhere_settings_other_countries")));let ee=document.createElement("div");ee.id="regions-autocomplete",w.appendChild(ee),J&&(w.style.display="none"),f.appendChild(w);let T=u("div","margin-bottom: 16px;");T.appendChild(u("label","display: block; margin-bottom: 6px; font-weight: 600; color: #ccc;",i.t("elsewhere_settings_providers")));let W=document.createElement("div");W.id="services-autocomplete",T.appendChild(W),f.appendChild(T);let O=null;if(Q){let E=u("label","display: flex; align-items: center; gap: 8px; margin-bottom: 16px; color: #ccc; cursor: pointer;");O=u("input","width: 16px; height: 16px; cursor: pointer;"),O.type="checkbox",O.id="season-providers-checkbox",O.checked=m,E.append(O,u("span","",i.t("elsewhere_settings_season_providers"))),f.appendChild(E)}let N=u("div","display: flex; gap: 12px; justify-content: flex-end;"),j=u("button","padding: 10px 18px; border: 1px solid #444; background: #2a2a2a; color: #fff; border-radius: 6px; cursor: pointer; font-size: 14px;",i.t("elsewhere_settings_cancel"));j.id="cancel-settings";let $=u("button","padding: 10px 18px; border: none; background: #0078d4; color: white; border-radius: 6px; cursor: pointer; font-size: 14px;",i.t("elsewhere_settings_save"));$.id="save-settings",N.append(j,$),f.appendChild(N),g.onmouseenter=()=>{g.style.color="#fff"},g.onmouseleave=()=>{g.style.color="#999"},g.onclick=()=>{_.value=l};let Oe=Object.entries(U).map(([E,L])=>`${L} (${E})`);ee.appendChild(Ae(i.helpers,i.t("elsewhere_settings_add_countries_placeholder"),Oe,Y.map(E=>`${se(E)} (${E})`))),W.appendChild(Ae(i.helpers,i.t("elsewhere_settings_add_providers_placeholder"),oe,F.slice())),j.onclick=()=>{e.style.display="none"},$.onclick=async()=>{if(d||!a()||!e.isConnected||e.style.display==="none")return;d=!0,$.disabled=!0;let E=_.value,L=[];ee.querySelectorAll(".selected-tag").forEach(z=>{let G=(z.dataset.value??"").match(/\(([A-Z]{2})\)$/);G?.[1]&&L.push(G[1])});let B=L,be=[];W.querySelectorAll(".selected-tag").forEach(z=>{be.push((z.dataset.value??"").trim())});let Ye=be,ce=O?.checked??m,ye={...t,Region:J?pe(h(t,"Region"))??"":E,Regions:B,Services:Ye,SeasonProviders:ce};try{if(await i.saveUserSettings("elsewhere.json",ye,{throwOnError:!0,isCurrent:a}),!a())return;i.userConfig.elsewhere=ye,fe()}catch{if(a()&&e.isConnected){let G=f.querySelector(".je-elsewhere-save-error");G||(G=document.createElement("p"),G.className="je-elsewhere-save-error",G.setAttribute("role","alert"),N.before(G)),G.textContent=ue("elsewhere_settings_save_failed","Could not save your choices. Try again.")}}finally{d=!1,a()&&($.disabled=!1)}},e.replaceChildren(f)}function mt(e){if(e===null||typeof e!="object"||Array.isArray(e))return!1;let t=h(e,"Region"),n=h(e,"Regions"),o=h(e,"Services"),a=h(e,"SeasonProviders");return(t==null||typeof t=="string")&&(n==null||Array.isArray(n)&&n.every(d=>typeof d=="string"))&&(o==null||Array.isArray(o)&&o.every(d=>typeof d=="string"))&&(a==null||typeof a=="boolean")}function ue(e,t){let n=i.t(e);return n&&n!==e?n:t}function Ue(){let e=He(),t=++R,n=te(i.session),o=()=>t===R&&n()&&e.isConnected&&e.style.display!=="none";e.replaceChildren(u("p","color: #fff;",ue("elsewhere_settings_loading","Loading your settings…"))),e.style.display="flex";let a=q(),d=a.getCurrentUserId();Promise.resolve().then(()=>{if(!o()||!d)throw new Error("Settings opening cancelled");return a.ajax({type:"GET",url:a.getUrl(`/JellyfinEnhanced/user-settings/${d}/elsewhere.json?_=${Date.now()}`),dataType:"json"})}).then(f=>{if(!o())return;if(!mt(f))throw new Error("Invalid Elsewhere settings document");let x=ke(f,l);k=V(x.region),Y=x.regions,F=x.services,m=x.seasonProviders,Re(),gt(e,f),xe()}).catch(()=>{if(!o())return;let f=u("div","padding: 24px; background: #181818; color: #fff;",ue("elsewhere_settings_load_failed","Your settings could not be loaded. No changes were saved.")),x=u("button","",ue("elsewhere_settings_retry","Retry"));x.type="button",x.onclick=Ue;let b=u("button","",i.t("elsewhere_settings_cancel"));b.type="button",b.onclick=()=>{e.style.display="none",R++},f.append(x,b),e.replaceChildren(f)})}function Re(){v++,document.querySelectorAll(".streaming-lookup-container").forEach(e=>e.remove()),ge.clear(),me.clear(),he.clear()}function fe(e=!0){let t=ke(i.userConfig.elsewhere,l);k=V(t.region),Y=t.regions,F=t.services,m=t.seasonProviders,e&&(R++,$e(),Re(),e&&xe())}function Je(){if(!D)return;let e=++K,t=te(i.session);i.core.api.fetch(q().getUrl("/JellyfinEnhanced/jellyseerr/streaming-region")).then(n=>X(h(n,"region"))??null,()=>null).then(n=>{e!==K||!t()||(S=n!==null&&/^[A-Z]{2}$/.test(n)?n:null,V(ke(i.userConfig.elsewhere,l).region)!==k&&fe())})}document.addEventListener("je:user-data-loaded",()=>{fe(),Je()}),i.session?.onUserChange("elsewhere",()=>{S=null,K++,k=l,Y=[],F=[],m=!0,R++,$e(),Re()});function Ie(e){let t=u("div",`
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
            `,n.onerror=()=>{n.style.display="none"},t.appendChild(n);let o=document.createElement("span");return o.textContent=e.provider_name,t.appendChild(o),t.onmouseenter=()=>{t.style.transform="translateY(-2px)",t.style.background="rgba(255, 255, 255, 0.2)",t.style.boxShadow="0 4px 12px rgba(0, 0, 0, 0.3)"},t.onmouseleave=()=>{t.style.transform="translateY(0)",t.style.background="rgba(255, 255, 255, 0.1)",t.style.boxShadow="none"},t}function ze(e,t,n){let o=te(i.session),a=v,d=()=>o()&&a===v;if(ae){let b=q().getUrl(`/JellyfinEnhanced/jellyseerr/${t}/${de(e)}`);i.core.api.fetch(b,{cacheKey:`seerr-providers:${t}:${e}`}).then(g=>{d()&&n(null,tt(g))}).catch(g=>{d()&&n(X(h(g,"message"))||"Could not load streaming info from Seerr.",null)});return}let f=`/${t}/${de(e)}/watch/providers`,x=q().getUrl(`/JellyfinEnhanced/tmdb${f}`);i.core.api.fetch(x,{cacheKey:`tmdb:${f}`}).then(b=>{d()&&n(null,Ce(b))}).catch(b=>{d()&&n(ut(b),null)})}let ht=4,ge=new Map,me=new Map;function xt(e,t){let n=`${e}:${t}`,o=ge.get(n);if(!o){let a=q().getUrl(`/JellyfinEnhanced/tmdb/tv/${de(e)}/season/${t}/watch/providers`);o=i.core.api.fetch(a).then(Ce).catch(()=>(ge.delete(n),null)),ge.set(n,o)}return o}function bt(e){let t=me.get(e);if(!t){let n=q().getUrl(`/JellyfinEnhanced/tmdb/tv/${de(e)}`);t=i.core.api.fetch(n).then(o=>{let a=h(o,"seasons");return Array.isArray(a)?new Set(a.map(d=>Se(h(d,"season_number"))).filter(d=>d!==void 0)):null}).catch(()=>(me.delete(e),null)),me.set(e,t)}return t}async function yt(e){let t=q(),n=t.getUrl(`Shows/${e}/Seasons`,{userId:t.getCurrentUserId()??""}),o=await i.core.api.fetch(n);return ne(h(o,"Items")).map(a=>h(a,"IndexNumber")).filter(a=>Number.isInteger(a)).sort((a,d)=>a-d)}async function qe(e){if(!Q||!m)return null;let t=we();if(!t)return null;let n=await je(i.helpers,t,!1);if(!n)return null;let o,a=null;if(n.Type==="Series")o=n;else if(n.Type==="Season"&&n.SeriesId&&Number.isInteger(n.IndexNumber))o=await je(i.helpers,n.SeriesId,!1),a=n.IndexNumber??null;else return null;if(!o||!o.Id||!rt(o.DisplayOrder))return null;let d=o.ProviderIds.Tmdb;return!d||e&&d!==e?null:{kind:a===null?"series":"season",seriesId:o.Id,tmdbId:d,seasonNumber:a}}function vt(e){let t=st(e);if(t.single!==null)return i.t("elsewhere_season_label",{number:t.single});if(t.specialsOnly)return i.t("jellyseerr_season_specials");let n=[...t.ranges];return t.hasSpecials&&n.push(i.t("jellyseerr_season_specials")),i.t("elsewhere_seasons_label",{range:n.join(", ")})}async function wt(e,t){let n=I(re(t,k)?.flatrate),o=await bt(e.tmdbId),a=e.kind==="season"&&e.seasonNumber!==null?[e.seasonNumber]:await yt(e.seriesId);if(a.length===0)return null;let f=(await ot(a,ht,async g=>{let A=!o||o.has(g)?await xt(e.tmdbId,g):null,_=I(re(A,k)?.flatrate);return _.length>0?{number:g,services:_,link:re(A,k)?.link}:g===0?null:{number:g,services:n,link:void 0}})).filter(g=>!!g),[x]=f;if(!x)return null;if(e.kind==="season")return{servicesOverride:x.services,link:x.link};let b=it(f);return b?{groups:b.map(g=>({label:vt(g.numbers),services:g.services}))}:null}function We(e,t,n){let o=document.createElement("button");return o.className=e,o.appendChild(le(t,"16px")),o.style.cssText=n,o.onmouseenter=()=>{o.style.background="rgba(255, 255, 255, 0.2)"},o.onmouseleave=()=>{o.style.background="rgba(255, 255, 255, 0.1)"},o}function Ge(e){let t=document.createElement("button");return t.appendChild(le("close","16px")),t.style.cssText=`
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
            `,t.onmouseenter=()=>{t.style.background="rgba(255, 0, 0, 0.2)",t.style.borderColor="rgba(255, 0, 0, 0.3)"},t.onmouseleave=()=>{t.style.background="rgba(255, 255, 255, 0.1)",t.style.borderColor="rgba(255, 255, 255, 0.2)"},t.onclick=()=>e.remove(),t}function St(e,t,n,o={}){let a=re(e,k),d=u("div",`
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
            `),x=!!a?.flatrate&&a.flatrate.length>0,b=x?I(a?.flatrate):[];o.servicesOverride&&(b=o.servicesOverride);let g=o.groups||null,J=o.link||a?.link||"",A=!!g||b.length>0,_=!A&&!!y,w=Ne(i.helpers,A&&J?J:"#",{title:"JustWatch"});A?w.textContent=i.t("elsewhere_panel_available_in",{region:se(k)}):y?(w.textContent=y,w.classList.add("elsewhere-custom-branding"),w.style.cursor="default",H&&w.appendChild(et(H,M))):w.textContent=i.t("elsewhere_panel_not_available_in",{region:se(k)}),w.style.cssText=`
                font-weight: 600;
                font-size: 14px;
                text-decoration: none;
                cursor: pointer;
                color: #fff;
                flex: 1;
                text-align: left;
                display: flex;
                align-items: flex-end;
            `,w.querySelector(".elsewhere-custom-branding-icon")&&(w.style.alignItems="center",w.style.gap="8px"),A&&J?(w.classList.add("elsewhere-link-reset"),w.href=Be(J),w.style.padding="0",w.style.margin="0"):_&&(w.style.cursor="default");let ee=u("div",`
                display: flex;
                gap: 8px;
                align-items: center;
            `),T=We("elsewhere-search-button","search",`
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
                opacity: ${_?"0":"1"};
            `);T.appendChild(document.createTextNode(""));let W=We("elsewhere-settings-button","settings",`
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
                opacity: ${_?"0":"1"};
            `);if(W.onclick=()=>Ue(),ee.append(T,W),f.append(w,ee),d.appendChild(f),_&&(d.onmouseenter=()=>{T.style.opacity="1",W.style.opacity="1"},d.onmouseleave=()=>{T.style.opacity="0",W.style.opacity="0"}),x||A)if(g)for(let N of g){d.appendChild(u("div","font-size: 12px; font-weight: 600; color: #aaa; margin: 4px 0 2px;",N.label));let j=u("div","display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px;");for(let $ of N.services)j.appendChild(Ie($));d.appendChild(j)}else if(A){let N=u("div","display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 12px;");for(let j of b)N.appendChild(Ie(j));d.appendChild(N)}else p.defaults.length>0&&d.appendChild(u("div","color: #999; font-size: 13px; margin-bottom: 12px;",i.t("elsewhere_panel_no_configured_services")));let O=document.createElement("div");return O.id="streaming-result-container",d.appendChild(O),T.onclick=()=>{T.disabled=!0,T.replaceChildren();let N=le("refresh","16px");if(N.style.animation="spin 1s linear infinite",T.append(N,document.createTextNode(" "+i.t("elsewhere_panel_search_button"))),T.style.opacity="0.7",O.replaceChildren(),!document.querySelector("style[data-jellyfin-elsewhere]")){let j=document.createElement("style");j.textContent=`
                    @keyframes spin {
                        0% { transform: rotate(0deg); }
                        100% { transform: rotate(360deg); }
                    }
                `,j.setAttribute("data-jellyfin-elsewhere","true"),document.head.appendChild(j)}ze(t,n,(j,$)=>{if(T.disabled=!1,T.replaceChildren(le("search","16px"),document.createTextNode("")),T.style.opacity="1",j||!$){O.replaceChildren(u("div","color: #ff6b6b; font-size: 13px; margin-top: 8px;",i.t("elsewhere_panel_error",{error:j??""})));return}let Oe=!P()&&Y.length>0?Y:[k],E=!1,L=[];Oe.forEach((B,be)=>{let ce=re($,B)?.flatrate??[],ye=F.length>0?ce.filter(z=>F.includes(z.provider_name)):ce;if(ce.length>0&&ye.length>0){E=!0;let z=Ct($,B);z&&((be>0||L.length>0)&&(z.style.marginTop="6px"),O.appendChild(z))}else L.push(B)}),L.length>0&&O.insertBefore(Et(L),O.firstChild),!E&&L.length===0&&O.appendChild(u("div","color: #6c757d; font-size: 13px; margin-top: 8px;",i.t("elsewhere_panel_no_services_in_regions")))})},d}function Et(e){let t=u("div",`
                margin: 0 0 6px 0;
                padding: 12px;
                border-radius: 8px;
                border: 1px solid rgba(139, 19, 19, 0.6);
                background: rgba(139, 19, 19, 0.3);
                backdrop-filter: blur(10px);
                position: relative;
            `),n=u("div",`
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 0;
            `),o=u("div",`
                font-weight: 600;
                font-size: 14px;
                color: rgb(255, 20, 20);
                flex: 1;
            `,i.t("elsewhere_panel_not_available_in_regions",{regions:at(e.map(se))})),a=Ge(t);return a.title="Close",n.append(o,a),t.appendChild(n),t}function Ct(e,t){let n=re(e,t);if(!n?.flatrate)return null;let o=n.flatrate.filter(b=>F.length===0||F.includes(b.provider_name));if(o.length===0)return null;let a=u("div",`
                margin: 10px 0 0 0;
                padding: 12px;
                background: rgba(0, 0, 0, 0.3);
                border-radius: 8px;
                border: 1px solid rgba(255, 255, 255, 0.1);
                backdrop-filter: blur(10px);
                position: relative;
            `),d=u("div",`
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 10px;
            `),f=Ne(i.helpers,n.link||"#",{title:"JustWatch"});f.textContent=i.t("elsewhere_panel_available_in_region",{region:se(t)}),f.style.cssText=`
                font-weight: 600;
                font-size: 14px;
                text-decoration: none;
                cursor: pointer;
                color: #fff;
                flex: 1;
                text-align: left;
            `,n.link&&(f.classList.add("elsewhere-link-reset"),f.href=Be(n.link),f.style.padding="0",f.style.margin="0"),d.append(f,Ge(a)),a.appendChild(d);let x=u("div","display: flex; flex-wrap: wrap; gap: 3px;");for(let b of o)x.appendChild(Ie(b));return a.appendChild(x),a}function kt(e,t,n){let o=te(i.session),a=v,d=()=>o()&&a===v&&n.isConnected;ze(e,t,async(f,x)=>{if(!d())return;if(f||!x){n.appendChild(u("div","font-size: 13px; margin-top: 8px; color: #ff6b6b;",i.t("elsewhere_panel_error",{error:f??""})));return}let b={};if(t==="tv"&&Q&&m)try{let g=await qe(e);if(!d())return;g&&(b=await wt(g,x)||{})}catch(g){console.warn(`${_e} Per-season providers unavailable, using series providers.`,g)}d()&&n.appendChild(St(x,e,t,b))})}function Ke(e,t,n){let o=document.createElement("div");o.className="streaming-lookup-container",o.style.cssText="margin: 16px 0;",kt(t,n,o);let a=e.querySelector(".itemExternalLinks");a?.parentNode?a.parentNode.insertBefore(o,a.nextSibling):e.appendChild(o)}let he=new Set;function _t(e){if(!Q||!m)return;let t=e.closest("#itemDetailPage")??document;if(t!==document&&t!==De()||t.querySelector(".streaming-lookup-container")||e!==t.querySelector(".detailSectionContent"))return;let n=we();if(!n||he.has(n))return;he.add(n);let o=te(i.session),a=v;qe().then(d=>{!o()||a!==v||!d||d.kind!=="season"||!e.isConnected||we()!==n||t.querySelector(".streaming-lookup-container")||Ke(e,d.tmdbId,"tv")}).catch(()=>{}).finally(()=>he.delete(n))}function xe(){document.querySelectorAll(".detailSectionContent").forEach(e=>{let t=e.closest("#itemDetailPage");if(t&&t!==De()||e.querySelector(".streaming-lookup-container"))return;let n=e.querySelector('a[href*="themoviedb.org"]');if(!n){_t(e);return}let o=n.href.match(/themoviedb\.org\/(movie|tv)\/(\d+)/);!o?.[1]||!o[2]||Ke(e,o[2],o[1])})}ft(),fe(!1),Je();let Te=(e,t,n)=>{typeof requestIdleCallback<"u"?requestIdleCallback(e,{timeout:t}):setTimeout(e,n)};Te(()=>{He()},2e3,2e3);let Le=!1,Ve=()=>{Le||(Le=!0,Te(()=>{xe(),Le=!1},500,100))};i.helpers.createObserver("elsewhere",Ve,document.body,{childList:!0,subtree:!0}),i.helpers.onViewPage(Ve),Te(()=>xe(),1e3,1e3),console.log("🪼 Jellyfin Enhanced: 🎬 Jellyfin Elsewhere loaded!")};})();
})();
