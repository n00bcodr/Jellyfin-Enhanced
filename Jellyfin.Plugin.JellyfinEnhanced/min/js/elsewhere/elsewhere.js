(() => {
"use strict";(()=>{function se(o){let n=window.JellyfinEnhanced?.core?.sharedModules?.[o];if(!n)throw new Error(`${o} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return n}function H(o,n){return o[n]}var Ye=se("features/details-providers/host"),z=H(Ye,"api"),Ze=H(Ye,"bridge");var ve=se("features/details-providers/page");var we=H(ve,"hashItemId");var Oe=H(ve,"lookupDetailsItem");var ee=H(ve,"sessionLease"),Ne=H(ve,"visibleDetailPage");function Ae(o,n,i,a){let l=document.createElement("div");l.style.cssText="position: relative; margin-bottom: 6px;";let y,A=m=>{let v=m.toLowerCase();if(v.length===0){E.style.display="none";return}Y(i.filter(P=>P.toLowerCase().includes(v)&&!a.includes(P)))},$=o.debounce,ae="",X=$?$.call(o,()=>A(ae),300):null,O=document.createElement("input");O.type="text",O.placeholder=n,O.style.cssText=`
            width: 100%;
            padding: 10px;
            border: 1px solid #444;
            border-radius: 6px;
            box-sizing: border-box;
            background: #2a2a2a;
            color: #fff;
            font-size: 14px;
        `;let E=document.createElement("div");E.style.cssText=`
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
        `;let T=-1,V=[];function C(){K.replaceChildren();for(let m of a){let v=document.createElement("span");v.className="selected-tag",v.style.cssText=`
                    background: #0078d4;
                    color: white;
                    padding: 4px 10px;
                    border-radius: 16px;
                    font-size: 12px;
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                `,v.textContent=m,v.dataset.value=m;let P=document.createElement("span");P.textContent="×",P.style.cssText="cursor: pointer; font-weight: bold; font-size: 14px;",P.onclick=()=>{let _=a.indexOf(m);_>-1&&(a.splice(_,1),C())},v.appendChild(P),K.appendChild(v)}}function Y(m){E.replaceChildren(),E.style.display="block",V=m,T=-1,m.forEach((v,P)=>{let _=document.createElement("div");_.textContent=v,_.style.cssText=`
                    padding: 10px;
                    cursor: pointer;
                    border-bottom: 1px solid #333;
                    color: #fff;
                    font-size: 14px;
                `,_.dataset.index=String(P),_.onmouseenter=()=>{B(),_.style.background="#333",T=P},_.onmouseleave=()=>{_.style.background="#1a1a1a"},_.onclick=()=>re(v),E.appendChild(_)})}function B(){E.querySelectorAll("div").forEach(m=>{m.style.background="#1a1a1a"})}function U(){if(B(),T>=0&&T<V.length){let m=E.querySelector(`[data-index="${T}"]`);m&&(m.style.background="#333",m.scrollIntoView({block:"nearest"}))}}function re(m){a.includes(m)||(a.push(m),C()),O.value="",E.style.display="none",T=-1}return O.oninput=()=>{X?(ae=O.value,X()):(clearTimeout(y),y=setTimeout(()=>A(O.value),300))},O.onkeydown=m=>{if(E.style.display!=="none")switch(m.key){case"ArrowDown":m.preventDefault(),T=Math.min(T+1,V.length-1),U();break;case"ArrowUp":m.preventDefault(),T=Math.max(T-1,-1),U();break;case"Enter":{m.preventDefault();let v=V[T];T>=0&&v!==void 0&&re(v);break}case"Escape":E.style.display="none",T=-1;break}},O.onblur=()=>{setTimeout(()=>{E.contains(document.activeElement)||(E.style.display="none")},200)},l.append(O,E,K),C(),l}function Xe(o,n){try{let i=new URL(o,n);return["http:","https:","mailto:","tel:","ftp:","blob:"].includes(i.protocol)?o:"#"}catch{return"#"}}function Qe(o,n){let a=document.createElement.call(document,o,n);return a.getAttribute("is")!==n&&a.setAttribute("is",n),a}function Ee(o){return Xe(o,window.location.href)}function je(o,n,i={}){let a=o?.createExternalLink;if(a)return a(n,i);let l=Qe("a","emby-linkbutton");return l.href=Ee(n),l.target="_blank",l.rel="noopener noreferrer",i.title&&(l.title=i.title),i.className&&(l.className=[l.className,i.className].filter(Boolean).join(" ")),i.text&&(l.textContent=i.text),i.resetStyle&&(l.style.cssText="padding:0;background:none;border-radius:0;min-width:0;"),typeof i.setup=="function"&&i.setup(l),l}function de(o){return encodeURIComponent(o)}function et(o,n){let i=(l,y)=>{try{return z().getUrl(l,y)}catch{return null}};if(n){let l=i("/JellyfinEnhanced/ElsewhereBrandingIcon",{v:n});if(l)return l}let a=String(o||"").trim();return/^\/(web|JellyfinEnhanced)\//i.test(a)&&i(a)||a}function tt(o,n){let i=document.createElement("img");return i.src=o,i.alt="Custom Branding",i.className="elsewhere-custom-branding-icon",i.style.cssText=`
                        width: 24px;
                        height: 24px;
                        object-fit: contain;
                        margin-left: 4px;
                    `,i.onerror=()=>{i.style.display="none",console.warn(n?`🪼 Jellyfin Enhanced: the uploaded Elsewhere custom branding icon failed to load from "${o}". Re-upload it in the plugin settings.`:`🪼 Jellyfin Enhanced: Elsewhere custom branding icon failed to load from "${o}". It must be a web address the browser can open, not a server file path.`)},i}var ie=se("features/details-providers/wire");var h=H(ie,"field"),Se=H(ie,"int"),Ce=H(ie,"isRecord"),te=H(ie,"list");var Z=H(ie,"str");var ue=H(ie,"text");function De(o){return o?o.replace(/'/g,"").replace(/\n/g,",").split(",").map(n=>n.trim()).filter(n=>n):[]}function _t(o){if(!Ce(o))return null;let n={provider_name:Z(o.provider_name)??"",logo_path:Z(o.logo_path)??""},i=Se(o.provider_id);return i!==void 0&&(n.provider_id=i),n}function Lt(o){let n={},i=ue(h(o,"link"));i!==void 0&&(n.link=i);let a=h(o,"flatrate");return Array.isArray(a)&&(n.flatrate=a.map(_t).filter(l=>l!==null)),n}function ke(o){let n={},i=h(o,"results");if(Ce(i))for(let[a,l]of Object.entries(i))n[a]=Lt(l);return{results:n}}function nt(o){let n={};for(let i of te(h(o,"watchProviders"))){let a=Z(h(i,"iso_3166_1"));!a||!/^[A-Z]{2}$/.test(a)||(n[a]={link:h(i,"link"),flatrate:te(h(i,"flatrate")).filter(Ce).map(l=>({provider_id:h(l,"id"),provider_name:h(l,"name"),logo_path:h(l,"logoPath")}))})}return ke({results:n})}function ne(o,n){return o&&Object.prototype.hasOwnProperty.call(o.results,n)?o.results[n]:void 0}function rt(o,n,i){let a=o||[];if(n.defaults.length>0&&(a=a.filter(l=>n.defaults.includes(l.provider_name))),n.ignore.length>0)try{let l=n.ignore.map(y=>new RegExp(y,"i"));a=a.filter(y=>!l.some(A=>A.test(y.provider_name)))}catch(l){i(l)}return a}function ot(o){let n=(o||"").toString().trim().toLowerCase();return n===""||n==="aired"||n==="airdate"||n==="default"}async function st(o,n,i){let a=new Array(o.length),l=0,y=Array.from({length:Math.min(n,o.length)},async()=>{for(;l<o.length;){let A=l++,$=o[A];$!==void 0&&(a[A]=await i($))}});return await Promise.all(y),a}function it(o){let n=o.filter(l=>l>0),i=[];for(let l=0;l<n.length;){let y=l;for(;y+1<n.length&&n[y+1]===(n[y]??NaN)+1;)y++;i.push(y>l?`${n[l]}–${n[y]}`:String(n[l])),l=y+1}let a=o.includes(0);return{single:i.length===1&&!a&&n.length===1?n[0]??null:null,specialsOnly:i.length===0&&a,ranges:i,hasSpecials:a}}function at(o){let n=new Map;for(let a of o){let l=a.services.map(A=>A.provider_id??NaN).sort((A,$)=>A-$).join(","),y=n.get(l);y||n.set(l,y={services:a.services,numbers:[]}),y.numbers.push(a.number)}if(n.size<=1)return null;let i=[...n.values()].filter(a=>a.services.length>0);return i.length>0?i:null}function lt(o){return o.length===1?o[0]??"":o.length===2?o.join(" and "):`${o.slice(0,-1).join(", ")} and ${o[o.length-1]??""}`}function ct(o){let n={};for(let i of o.trim().split(`
`)){if(i.startsWith("#"))continue;let[a,l]=i.split("	");a&&l&&(n[a]=l)}return n}function dt(o){return o.trim().split(`
`).filter(n=>!n.startsWith("#")&&n.trim()!=="")}var ut={US:"United States",GB:"United Kingdom",IN:"India",CA:"Canada",DE:"Germany",FR:"France",JP:"Japan",AU:"Australia",BR:"Brazil",MX:"Mexico",IE:"Ireland",IT:"Italy",ES:"Spain",NL:"Netherlands",SE:"Sweden",NO:"Norway",DK:"Denmark",FI:"Finland"},pt=["Netflix","Amazon Prime Video","Disney Plus","HBO Max","Hulu","Apple TV Plus","Paramount Plus","Peacock","JioCinema","Disney+ Hotstar","ZEE5","SonyLIV"];function ft(o){let n=Z(h(o,"message"))||"";return o instanceof TypeError&&n==="Failed to fetch"?"TMDB API is unreachable.":o instanceof SyntaxError?"Received an unexpected response from the server. Check your reverse proxy or Jellyfin configuration.":n.includes("401")?"Invalid TMDB API Key.":n.includes("404")?"The requested item could not be found on TMDB.":n.includes("429")?"Too many requests. Please wait a moment and try again.":n.startsWith("HTTP 5")?"The TMDB service is temporarily unavailable. Please try again later.":n||"An unknown error occurred"}function Te(o,n){return{region:ue(h(o,"Region"))||n,regions:Array.isArray(h(o,"Regions"))?te(h(o,"Regions")).filter(i=>typeof i=="string"):[],services:Array.isArray(h(o,"Services"))?te(h(o,"Services")).filter(i=>typeof i=="string"):[],seasonProviders:h(o,"SeasonProviders")!==!1}}var c=Ze("Jellyfin Elsewhere"),Pe="🪼 Jellyfin Enhanced: 🎬 Jellyfin Elsewhere:";c.initializeElsewhereScript=function(){let n=c.pluginConfig;if(!n.ElsewhereEnabled){console.log(`${Pe} Feature is disabled in plugin settings.`);return}let i=!!n.TmdbEnabled,a=n.DEFAULT_REGION||"US",l={defaults:De(n.DEFAULT_PROVIDERS),ignore:De(n.IGNORE_PROVIDERS)},y=n.ElsewhereCustomBrandingText||"",A=!!n.ElsewhereCustomBrandingIconVersion,$=et(n.ElsewhereCustomBrandingImageUrl,n.ElsewhereCustomBrandingIconVersion),ae=!i&&!!n.JellyseerrEnabled,X=i&&n.ElsewhereSeasonProviders!==!1;if(!i&&!ae){console.log(`${Pe} Neither TMDB nor Seerr is configured, skipping initialization`);return}let O=!!n.ElsewhereUseSeerrRegion&&!!n.JellyseerrEnabled,E=null,K=0,T=()=>O&&E!==null,V=e=>O&&E||e,C=a,Y=[],B=[],U={},re=[],m=!0,v=0,P=0,_=e=>rt(e,l,t=>console.error(`${Pe} Invalid regex in IGNORE_PROVIDERS.`,t)),oe=e=>(Object.prototype.hasOwnProperty.call(U,e)?U[e]:void 0)||e;console.log("🪼 Jellyfin Enhanced: 🎬 Jellyfin Elsewhere starting...");function gt(){fetch(c.cdn.url("elsewhere-res","regions.txt")).then(e=>e.ok?e.text():Promise.reject(new Error(`HTTP ${e.status}`))).then(e=>{U={...U,...ct(e)}}).catch(()=>{U={...ut}}),fetch(c.cdn.url("elsewhere-res","providers.txt")).then(e=>e.ok?e.text():Promise.reject(new Error(`HTTP ${e.status}`))).then(e=>{re=dt(e)}).catch(()=>{re=[...pt]})}function le(e,t="18px"){let r=document.createElement("span");return r.className="material-icons",r.textContent=e,r.style.fontSize=t,r.style.lineHeight="1",r}let _e="streaming-settings-modal";function Be(){let e=document.getElementById(_e);e instanceof HTMLElement&&(e.style.display="none",e.replaceChildren())}function Fe(){let e=document.getElementById(_e);if(e instanceof HTMLDivElement)return e;let t=document.createElement("div");return t.id=_e,t.style.cssText=`
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
            `,t.onclick=r=>{r.target===t&&(t.style.display="none")},document.body.appendChild(t),t}function p(e,t,r){let s=document.createElement(e);return s.style.cssText=t,r!==void 0&&(s.textContent=r),s}function mt(e,t){let r=ee(c.session),s=v,d=()=>r()&&s===v,u=!1,f=p("div",`
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
            `);f.appendChild(p("h3","margin-top: 0; margin-bottom: 16px; color: #fff; font-size: 18px; font-weight: bolder;",c.t("elsewhere_settings_title")));let x=p("div","margin-bottom: 16px;"),b=p("div","display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;");b.appendChild(p("label","font-weight: 600; color: #ccc;",c.t("elsewhere_settings_country")));let g=p("button","display: flex; align-items: center; justify-content: center; background: transparent; border: none; color: #999; cursor: pointer; padding: 2px; border-radius: 4px;");g.type="button",g.id="reset-region-btn",g.title="Reset to plugin default",g.appendChild(le("restart_alt","16px")),b.appendChild(g),x.appendChild(b);let q=T(),N=p("div","display: none; margin-bottom: 6px; font-size: 12px; color: #999;");N.id="seerr-region-note",q&&E&&(N.textContent=c.t("elsewhere_settings_seerr_region",{region:oe(E)}),N.style.display=""),x.appendChild(N);let k=p("select","width: 100%; padding: 12px; border: 1px solid #444; border-radius: 6px; background: #2a2a2a; color: #fff; font-size: 14px;");k.id="region-select";for(let[S,I]of Object.entries(U)){let D=document.createElement("option");D.value=S,D.textContent=I,S===C&&(D.selected=!0),k.appendChild(D)}for(let S of new Set([C,a])){if(Array.from(k.options).some(D=>D.value===S))continue;let I=document.createElement("option");I.value=S,I.textContent=S,k.appendChild(I)}k.value=C,k.disabled=q,x.appendChild(k),f.appendChild(x);let w=p("div","margin-bottom: 16px;");w.appendChild(p("label","display: block; margin-bottom: 5px; font-weight: 600; color: #ccc;",c.t("elsewhere_settings_other_countries")));let Q=document.createElement("div");Q.id="regions-autocomplete",w.appendChild(Q),q&&(w.style.display="none"),f.appendChild(w);let L=p("div","margin-bottom: 16px;");L.appendChild(p("label","display: block; margin-bottom: 6px; font-weight: 600; color: #ccc;",c.t("elsewhere_settings_providers")));let W=document.createElement("div");W.id="services-autocomplete",L.appendChild(W),f.appendChild(L);let M=null;if(X){let S=p("label","display: flex; align-items: center; gap: 8px; margin-bottom: 16px; color: #ccc; cursor: pointer;");M=p("input","width: 16px; height: 16px; cursor: pointer;"),M.type="checkbox",M.id="season-providers-checkbox",M.checked=m,S.append(M,p("span","",c.t("elsewhere_settings_season_providers"))),f.appendChild(S)}let j=p("div","display: flex; gap: 12px; justify-content: flex-end;"),R=p("button","padding: 10px 18px; border: 1px solid #444; background: #2a2a2a; color: #fff; border-radius: 6px; cursor: pointer; font-size: 14px;",c.t("elsewhere_settings_cancel"));R.id="cancel-settings";let F=p("button","padding: 10px 18px; border: none; background: #0078d4; color: white; border-radius: 6px; cursor: pointer; font-size: 14px;",c.t("elsewhere_settings_save"));F.id="save-settings",j.append(R,F),f.appendChild(j),g.onmouseenter=()=>{g.style.color="#fff"},g.onmouseleave=()=>{g.style.color="#999"},g.onclick=()=>{k.value=a};let He=Object.entries(U).map(([S,I])=>`${I} (${S})`);Q.appendChild(Ae(c.helpers,c.t("elsewhere_settings_add_countries_placeholder"),He,Y.map(S=>`${oe(S)} (${S})`))),W.appendChild(Ae(c.helpers,c.t("elsewhere_settings_add_providers_placeholder"),re,B.slice())),R.onclick=()=>{e.style.display="none"},F.onclick=async()=>{if(u||!d()||!e.isConnected||e.style.display==="none")return;u=!0,F.disabled=!0;let S=k.value,I=[];Q.querySelectorAll(".selected-tag").forEach(J=>{let G=(J.dataset.value??"").match(/\(([A-Z]{2})\)$/);G?.[1]&&I.push(G[1])});let D=I,be=[];W.querySelectorAll(".selected-tag").forEach(J=>{be.push((J.dataset.value??"").trim())});let Ve=be,ce=M?.checked??m,ye={...t,Region:q?ue(h(t,"Region"))??"":S,Regions:D,Services:Ve,SeasonProviders:ce};try{if(await c.saveUserSettings("elsewhere.json",ye,{throwOnError:!0,isCurrent:d}),!d())return;c.userConfig.elsewhere=ye,fe()}catch{if(d()&&e.isConnected){let G=f.querySelector(".je-elsewhere-save-error");G||(G=document.createElement("p"),G.className="je-elsewhere-save-error",G.setAttribute("role","alert"),j.before(G)),G.textContent=pe("elsewhere_settings_save_failed","Could not save your choices. Try again.")}}finally{u=!1,d()&&(F.disabled=!1)}},e.replaceChildren(f)}function ht(e){if(e===null||typeof e!="object"||Array.isArray(e))return!1;let t=h(e,"Region"),r=h(e,"Regions"),s=h(e,"Services"),d=h(e,"SeasonProviders");return(t==null||typeof t=="string")&&(r==null||Array.isArray(r)&&r.every(u=>typeof u=="string"))&&(s==null||Array.isArray(s)&&s.every(u=>typeof u=="string"))&&(d==null||typeof d=="boolean")}function pe(e,t){let r=c.t(e);return r&&r!==e?r:t}function $e(){let e=Fe(),t=++P,r=ee(c.session),s=()=>t===P&&r()&&e.isConnected&&e.style.display!=="none";e.replaceChildren(p("p","color: #fff;",pe("elsewhere_settings_loading","Loading your settings…"))),e.style.display="flex";let d=z(),u=d.getCurrentUserId();Promise.resolve().then(()=>{if(!s()||!u)throw new Error("Settings opening cancelled");return d.ajax({type:"GET",url:d.getUrl(`/JellyfinEnhanced/user-settings/${u}/elsewhere.json?_=${Date.now()}`),dataType:"json"})}).then(f=>{if(!s())return;if(!ht(f))throw new Error("Invalid Elsewhere settings document");let x=Te(f,a);C=V(x.region),Y=x.regions,B=x.services,m=x.seasonProviders,Le(),mt(e,f),xe()}).catch(()=>{if(!s())return;let f=p("div","padding: 24px; background: #181818; color: #fff;",pe("elsewhere_settings_load_failed","Your settings could not be loaded. No changes were saved.")),x=p("button","",pe("elsewhere_settings_retry","Retry"));x.type="button",x.onclick=$e;let b=p("button","",c.t("elsewhere_settings_cancel"));b.type="button",b.onclick=()=>{e.style.display="none",P++},f.append(x,b),e.replaceChildren(f)})}function Le(){v++,document.querySelectorAll(".streaming-lookup-container").forEach(e=>e.remove()),ge.clear(),me.clear(),he.clear()}function fe(e=!0){let t=Te(c.userConfig.elsewhere,a);C=V(t.region),Y=t.regions,B=t.services,m=t.seasonProviders,e&&(P++,Be(),Le(),e&&xe())}function Ue(){if(!O)return;let e=++K,t=ee(c.session);c.core.api.fetch(z().getUrl("/JellyfinEnhanced/jellyseerr/streaming-region")).then(r=>Z(h(r,"region"))??null,()=>null).then(r=>{e!==K||!t()||(E=r!==null&&/^[A-Z]{2}$/.test(r)?r:null,V(Te(c.userConfig.elsewhere,a).region)!==C&&fe())})}document.addEventListener("je:user-data-loaded",()=>{fe(),Ue()}),c.session?.onUserChange("elsewhere",()=>{E=null,K++,C=a,Y=[],B=[],m=!0,P++,Be(),Le()});function Ie(e){let t=p("div",`
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
            `,r.onerror=()=>{r.style.display="none"},t.appendChild(r);let s=document.createElement("span");return s.textContent=e.provider_name,t.appendChild(s),t.onmouseenter=()=>{t.style.transform="translateY(-2px)",t.style.background="rgba(255, 255, 255, 0.2)",t.style.boxShadow="0 4px 12px rgba(0, 0, 0, 0.3)"},t.onmouseleave=()=>{t.style.transform="translateY(0)",t.style.background="rgba(255, 255, 255, 0.1)",t.style.boxShadow="none"},t}function qe(e,t,r){let s=ee(c.session),d=v,u=()=>s()&&d===v;if(ae){let b=z().getUrl(`/JellyfinEnhanced/jellyseerr/${t}/${de(e)}`);c.core.api.fetch(b,{cacheKey:`seerr-providers:${t}:${e}`}).then(g=>{u()&&r(null,nt(g))}).catch(g=>{u()&&r(Z(h(g,"message"))||"Could not load streaming info from Seerr.",null)});return}let f=`/${t}/${de(e)}/watch/providers`,x=z().getUrl(`/JellyfinEnhanced/tmdb${f}`);c.core.api.fetch(x,{cacheKey:`tmdb:${f}`}).then(b=>{u()&&r(null,ke(b))}).catch(b=>{u()&&r(ft(b),null)})}let xt=4,ge=new Map,me=new Map;function bt(e,t){let r=`${e}:${t}`,s=ge.get(r);if(!s){let d=z().getUrl(`/JellyfinEnhanced/tmdb/tv/${de(e)}/season/${t}/watch/providers`);s=c.core.api.fetch(d).then(ke).catch(()=>(ge.delete(r),null)),ge.set(r,s)}return s}function yt(e){let t=me.get(e);if(!t){let r=z().getUrl(`/JellyfinEnhanced/tmdb/tv/${de(e)}`);t=c.core.api.fetch(r).then(s=>{let d=h(s,"seasons");return Array.isArray(d)?new Set(d.map(u=>Se(h(u,"season_number"))).filter(u=>u!==void 0)):null}).catch(()=>(me.delete(e),null)),me.set(e,t)}return t}async function vt(e){let t=z(),r=t.getUrl(`Shows/${e}/Seasons`,{userId:t.getCurrentUserId()??""}),s=await c.core.api.fetch(r);return te(h(s,"Items")).map(d=>h(d,"IndexNumber")).filter(d=>Number.isInteger(d)).sort((d,u)=>d-u)}async function Je(e){if(!X||!m)return null;let t=we();if(!t)return null;let r=await Oe(c.helpers,t,!1);if(!r)return null;let s,d=null;if(r.Type==="Series")s=r;else if(r.Type==="Season"&&r.SeriesId&&Number.isInteger(r.IndexNumber))s=await Oe(c.helpers,r.SeriesId,!1),d=r.IndexNumber??null;else return null;if(!s||!s.Id||!ot(s.DisplayOrder))return null;let u=s.ProviderIds.Tmdb;return!u||e&&u!==e?null:{kind:d===null?"series":"season",seriesId:s.Id,tmdbId:u,seasonNumber:d}}function wt(e){let t=it(e);if(t.single!==null)return c.t("elsewhere_season_label",{number:t.single});if(t.specialsOnly)return c.t("jellyseerr_season_specials");let r=[...t.ranges];return t.hasSpecials&&r.push(c.t("jellyseerr_season_specials")),c.t("elsewhere_seasons_label",{range:r.join(", ")})}async function Et(e,t){let r=_(ne(t,C)?.flatrate),s=await yt(e.tmdbId),d=e.kind==="season"&&e.seasonNumber!==null?[e.seasonNumber]:await vt(e.seriesId);if(d.length===0)return null;let f=(await st(d,xt,async g=>{let N=!s||s.has(g)?await bt(e.tmdbId,g):null,k=_(ne(N,C)?.flatrate);return k.length>0?{number:g,services:k,link:ne(N,C)?.link}:g===0?null:{number:g,services:r,link:void 0}})).filter(g=>!!g),[x]=f;if(!x)return null;if(e.kind==="season")return{servicesOverride:x.services,link:x.link};let b=at(f);return b?{groups:b.map(g=>({label:wt(g.numbers),services:g.services}))}:null}function ze(e,t,r){let s=document.createElement("button");return s.className=e,s.appendChild(le(t,"16px")),s.style.cssText=r,s.onmouseenter=()=>{s.style.background="rgba(255, 255, 255, 0.2)"},s.onmouseleave=()=>{s.style.background="rgba(255, 255, 255, 0.1)"},s}function We(e){let t=document.createElement("button");return t.appendChild(le("close","16px")),t.style.cssText=`
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
            `,t.onmouseenter=()=>{t.style.background="rgba(255, 0, 0, 0.2)",t.style.borderColor="rgba(255, 0, 0, 0.3)"},t.onmouseleave=()=>{t.style.background="rgba(255, 255, 255, 0.1)",t.style.borderColor="rgba(255, 255, 255, 0.2)"},t.onclick=()=>e.remove(),t}function St(e,t,r,s={}){let d=ne(e,C),u=p("div",`
                margin: 10px 0;
                padding: 12px;
                background: rgba(0, 0, 0, 0.2);
                border-radius: 8px;
                border: 1px solid rgba(255, 255, 255, 0.1);
                backdrop-filter: blur(10px);
                position: relative;
            `),f=p("div",`
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 10px;
            `),x=!!d?.flatrate&&d.flatrate.length>0,b=x?_(d?.flatrate):[];s.servicesOverride&&(b=s.servicesOverride);let g=s.groups||null,q=s.link||d?.link||"",N=!!g||b.length>0,k=!N&&!!y,w=je(c.helpers,N&&q?q:"#",{title:"JustWatch"});N?w.textContent=c.t("elsewhere_panel_available_in",{region:oe(C)}):y?(w.textContent=y,w.classList.add("elsewhere-custom-branding"),w.style.cursor="default",$&&w.appendChild(tt($,A))):w.textContent=c.t("elsewhere_panel_not_available_in",{region:oe(C)}),w.style.cssText=`
                font-weight: 600;
                font-size: 14px;
                text-decoration: none;
                cursor: pointer;
                color: #fff;
                flex: 1;
                text-align: left;
                display: flex;
                align-items: flex-end;
            `,w.querySelector(".elsewhere-custom-branding-icon")&&(w.style.alignItems="center",w.style.gap="8px"),N&&q?(w.classList.add("elsewhere-link-reset"),w.href=Ee(q),w.style.padding="0",w.style.margin="0"):k&&(w.style.cursor="default");let Q=p("div",`
                display: flex;
                gap: 8px;
                align-items: center;
            `),L=ze("elsewhere-search-button","search",`
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
            `);L.appendChild(document.createTextNode(""));let W=ze("elsewhere-settings-button","settings",`
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
            `);if(W.onclick=()=>$e(),Q.append(L,W),f.append(w,Q),u.appendChild(f),k&&(u.onmouseenter=()=>{L.style.opacity="1",W.style.opacity="1"},u.onmouseleave=()=>{L.style.opacity="0",W.style.opacity="0"}),x||N)if(g)for(let j of g){u.appendChild(p("div","font-size: 12px; font-weight: 600; color: #aaa; margin: 4px 0 2px;",j.label));let R=p("div","display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px;");for(let F of j.services)R.appendChild(Ie(F));u.appendChild(R)}else if(N){let j=p("div","display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 12px;");for(let R of b)j.appendChild(Ie(R));u.appendChild(j)}else l.defaults.length>0&&u.appendChild(p("div","color: #999; font-size: 13px; margin-bottom: 12px;",c.t("elsewhere_panel_no_configured_services")));let M=document.createElement("div");return M.id="streaming-result-container",u.appendChild(M),L.onclick=()=>{L.disabled=!0,L.replaceChildren();let j=le("refresh","16px");if(j.style.animation="spin 1s linear infinite",L.append(j,document.createTextNode(" "+c.t("elsewhere_panel_search_button"))),L.style.opacity="0.7",M.replaceChildren(),!document.querySelector("style[data-jellyfin-elsewhere]")){let R=document.createElement("style");R.textContent=`
                    @keyframes spin {
                        0% { transform: rotate(0deg); }
                        100% { transform: rotate(360deg); }
                    }
                `,R.setAttribute("data-jellyfin-elsewhere","true"),document.head.appendChild(R)}qe(t,r,(R,F)=>{if(L.disabled=!1,L.replaceChildren(le("search","16px"),document.createTextNode("")),L.style.opacity="1",R||!F){M.replaceChildren(p("div","color: #ff6b6b; font-size: 13px; margin-top: 8px;",c.t("elsewhere_panel_error",{error:R??""})));return}let He=!T()&&Y.length>0?Y:[C],S=!1,I=[];He.forEach((D,be)=>{let ce=ne(F,D)?.flatrate??[],ye=B.length>0?ce.filter(J=>B.includes(J.provider_name)):ce;if(ce.length>0&&ye.length>0){S=!0;let J=kt(F,D);J&&((be>0||I.length>0)&&(J.style.marginTop="6px"),M.appendChild(J))}else I.push(D)}),I.length>0&&M.insertBefore(Ct(I),M.firstChild),!S&&I.length===0&&M.appendChild(p("div","color: #6c757d; font-size: 13px; margin-top: 8px;",c.t("elsewhere_panel_no_services_in_regions")))})},u}function Ct(e){let t=p("div",`
                margin: 0 0 6px 0;
                padding: 12px;
                border-radius: 8px;
                border: 1px solid rgba(139, 19, 19, 0.6);
                background: rgba(139, 19, 19, 0.3);
                backdrop-filter: blur(10px);
                position: relative;
            `),r=p("div",`
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 0;
            `),s=p("div",`
                font-weight: 600;
                font-size: 14px;
                color: rgb(255, 20, 20);
                flex: 1;
            `,c.t("elsewhere_panel_not_available_in_regions",{regions:lt(e.map(oe))})),d=We(t);return d.title="Close",r.append(s,d),t.appendChild(r),t}function kt(e,t){let r=ne(e,t);if(!r?.flatrate)return null;let s=r.flatrate.filter(b=>B.length===0||B.includes(b.provider_name));if(s.length===0)return null;let d=p("div",`
                margin: 10px 0 0 0;
                padding: 12px;
                background: rgba(0, 0, 0, 0.3);
                border-radius: 8px;
                border: 1px solid rgba(255, 255, 255, 0.1);
                backdrop-filter: blur(10px);
                position: relative;
            `),u=p("div",`
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 10px;
            `),f=je(c.helpers,r.link||"#",{title:"JustWatch"});f.textContent=c.t("elsewhere_panel_available_in_region",{region:oe(t)}),f.style.cssText=`
                font-weight: 600;
                font-size: 14px;
                text-decoration: none;
                cursor: pointer;
                color: #fff;
                flex: 1;
                text-align: left;
            `,r.link&&(f.classList.add("elsewhere-link-reset"),f.href=Ee(r.link),f.style.padding="0",f.style.margin="0"),u.append(f,We(d)),d.appendChild(u);let x=p("div","display: flex; flex-wrap: wrap; gap: 3px;");for(let b of s)x.appendChild(Ie(b));return d.appendChild(x),d}function Tt(e,t,r){let s=ee(c.session),d=v,u=()=>s()&&d===v&&r.isConnected;qe(e,t,async(f,x)=>{if(!u())return;if(f||!x){r.appendChild(p("div","font-size: 13px; margin-top: 8px; color: #ff6b6b;",c.t("elsewhere_panel_error",{error:f??""})));return}let b={};if(t==="tv"&&X&&m)try{let g=await Je(e);if(!u())return;g&&(b=await Et(g,x)||{})}catch(g){console.warn(`${Pe} Per-season providers unavailable, using series providers.`,g)}u()&&r.appendChild(St(x,e,t,b))})}function Ge(e,t,r){let s=document.createElement("div");s.className="streaming-lookup-container",s.style.cssText="margin: 16px 0;",Tt(t,r,s);let d=e.querySelector(".itemExternalLinks");d?.parentNode?d.parentNode.insertBefore(s,d.nextSibling):e.appendChild(s)}let he=new Set;function Pt(e){if(!X||!m)return;let t=e.closest("#itemDetailPage")??document;if(t!==document&&t!==Ne()||t.querySelector(".streaming-lookup-container")||e!==t.querySelector(".detailSectionContent"))return;let r=we();if(!r||he.has(r))return;he.add(r);let s=ee(c.session),d=v;Je().then(u=>{!s()||d!==v||!u||u.kind!=="season"||!e.isConnected||we()!==r||t.querySelector(".streaming-lookup-container")||Ge(e,u.tmdbId,"tv")}).catch(()=>{}).finally(()=>he.delete(r))}function xe(){document.querySelectorAll(".detailSectionContent").forEach(e=>{let t=e.closest("#itemDetailPage");if(t&&t!==Ne()||e.querySelector(".streaming-lookup-container"))return;let r=e.querySelector('a[href*="themoviedb.org"]');if(!r){Pt(e);return}let s=r.href.match(/themoviedb\.org\/(movie|tv)\/(\d+)/);!s?.[1]||!s[2]||Ge(e,s[2],s[1])})}gt(),fe(!1),Ue();let Me=(e,t,r)=>{typeof requestIdleCallback<"u"?requestIdleCallback(e,{timeout:t}):setTimeout(e,r)};Me(()=>{Fe()},2e3,2e3);let Re=!1,Ke=()=>{Re||(Re=!0,Me(()=>{xe(),Re=!1},500,100))};c.helpers.createObserver("elsewhere",Ke,document.body,{childList:!0,subtree:!0}),c.helpers.onViewPage(Ke),Me(()=>xe(),1e3,1e3),console.log("🪼 Jellyfin Enhanced: 🎬 Jellyfin Elsewhere loaded!")};})();
})();
