(() => {
"use strict";(()=>{function V(a){let n=window.JellyfinEnhanced?.core?.sharedModules?.[a];if(!n)throw new Error(`${a} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return n}function O(a,n){return a[n]}var Pe=V("features/media-tags/host"),X=O(Pe,"apiClient");var xe=O(Pe,"mediaTagsContext");var ie=V("features/media-tags/pipeline/dto");var Se=O(ie,"errorStatus");var N=O(ie,"isRecord");var F=O(ie,"record");var Ee={"United States":"US",USA:"US",America:"US","United Kingdom":"GB",UK:"GB",England:"GB",Scotland:"GB",Wales:"GB",Canada:"CA",Australia:"AU","New Zealand":"NZ",Germany:"DE",France:"FR",Italy:"IT",Spain:"ES",Mexico:"MX",Brazil:"BR",Argentina:"AR",Japan:"JP","South Korea":"KR",China:"CN",India:"IN",Russia:"RU",Sweden:"SE",Norway:"NO",Denmark:"DK",Finland:"FI",Netherlands:"NL",Belgium:"BE",Austria:"AT",Switzerland:"CH",Poland:"PL","Czech Republic":"CZ",Czechia:"CZ",Greece:"GR",Portugal:"PT",Turkey:"TR",Israel:"IL","South Africa":"ZA",Chile:"CL",Colombia:"CO",Peru:"PE",Thailand:"TH",Malaysia:"MY",Singapore:"SG",Philippines:"PH",Indonesia:"ID",Vietnam:"VN",Ukraine:"UA",Iran:"IR",Ireland:"IE",Hungary:"HU",Romania:"RO",Bulgaria:"BG",Croatia:"HR",Serbia:"RS",Slovenia:"SI",Estonia:"EE",Latvia:"LV",Lithuania:"LT",Iceland:"IS",Luxembourg:"LU",Monaco:"MC",Liechtenstein:"LI",Malta:"MT",Cyprus:"CY",Slovakia:"SK","Bosnia and Herzegovina":"BA",Bosnia:"BA","North Macedonia":"MK",Macedonia:"MK",Albania:"AL",Montenegro:"ME",Moldova:"MD",Belarus:"BY",Kosovo:"XK",Georgia:"GE",Armenia:"AM",Azerbaijan:"AZ","Saudi Arabia":"SA","United Arab Emirates":"AE",UAE:"AE",Qatar:"QA",Kuwait:"KW",Bahrain:"BH",Oman:"OM",Jordan:"JO",Lebanon:"LB",Egypt:"EG",Iraq:"IQ",Syria:"SY",Yemen:"YE",Palestine:"PS",Pakistan:"PK",Bangladesh:"BD","Sri Lanka":"LK",Nepal:"NP",Taiwan:"TW","Hong Kong":"HK",Macau:"MO",Kazakhstan:"KZ",Uzbekistan:"UZ",Afghanistan:"AF",Mongolia:"MN",Myanmar:"MM",Cambodia:"KH",Laos:"LA",Venezuela:"VE",Ecuador:"EC",Uruguay:"UY",Paraguay:"PY",Bolivia:"BO","Costa Rica":"CR",Panama:"PA",Nicaragua:"NI",Honduras:"HN","El Salvador":"SV",Guatemala:"GT",Belize:"BZ",Cuba:"CU",Jamaica:"JM","Dominican Republic":"DO","Puerto Rico":"PR","Trinidad and Tobago":"TT",Barbados:"BB",Haiti:"HT",Bahamas:"BS",Guyana:"GY",Suriname:"SR",Nigeria:"NG",Kenya:"KE",Ghana:"GH",Ethiopia:"ET",Morocco:"MA",Algeria:"DZ",Tunisia:"TN",Libya:"LY",Senegal:"SN",Uganda:"UG",Tanzania:"TZ",Zimbabwe:"ZW",Zambia:"ZM",Botswana:"BW",Namibia:"NA",Angola:"AO",Mozambique:"MZ",Madagascar:"MG",Cameroon:"CM","Ivory Coast":"CI","Côte d'Ivoire":"CI",Mali:"ML","Burkina Faso":"BF","Papua New Guinea":"PG",Fiji:"FJ",Samoa:"WS",Tonga:"TO"};var Ve=/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/,Xe=/^[0-9a-f]{32}$/,Te=300;function Qe(a){return a%4===0&&a%100!==0||a%400===0}function Ae(a,n){return n===2?Qe(a)?29:28:[31,28,31,30,31,30,31,31,30,31,30,31][n-1]??31}function L(a){if(typeof a!="string")return null;let n=Ve.exec(a);if(!n)return null;let u=Number(n[1]),f=Number(n[2]),g=Number(n[3]);return u<1||f<1||f>12||g<1||g>Ae(u,f)?null:{y:u,m:f,d:g}}function Me(a,n){return a.y-n.y||a.m-n.m||a.d-n.d}function le(a,n){let u=n.y-a.y,f={y:n.y,m:a.m,d:Math.min(a.d,Ae(n.y,a.m))};return Me(n,f)<0&&u--,Math.max(0,u)}function Re(a=new Date){return{y:a.getFullYear(),m:a.getMonth()+1,d:a.getDate()}}function ve(a){if(!N(a))return null;let n={};return L(a.birthDate)&&(n.birthDate=String(a.birthDate).slice(0,10)),L(a.deathDate)&&(n.deathDate=String(a.deathDate).slice(0,10)),typeof a.birthPlace=="string"&&a.birthPlace.trim()&&(n.birthPlace=a.birthPlace.trim().slice(0,Te)),n}function je(a,n,u){let f=L(a.birthDate),g=L(a.deathDate),P=!!g&&Me(g,u)<=0,S=null,C=null,M=null;return f&&(g&&P?C=le(f,g):S=le(f,u),n&&(M=le(f,n))),{birthPlace:a.birthPlace||null,isDeceased:P,currentAge:S,ageAtDeath:C,ageAtItemRelease:M}}function et(a,n,u,f){if(!Xe.test(a)||!N(n))return null;let g=n.ts;if(typeof g!="number"||!Number.isFinite(g)||u-g>=f||g>u+864e5)return null;let P={ts:g};for(let S of["b","d"]){let C=n[S];if(C!==void 0){if(typeof C!="string"||C.length!==10||!L(C))return null;P[S]=C}}if(n.p!==void 0){if(typeof n.p!="string"||!n.p||n.p.length>Te)return null;P.p=n.p}return P}function Q(a,n){if(a.size<=n)return!1;let u=[...a].sort((f,g)=>f[1].ts-g[1].ts);for(let[f]of u.slice(0,u.length-n))a.delete(f);return!0}function Ie(a,n,u,f,g){let P=new Map;if(a==null)return{people:P,rewrite:!1};let S=null;try{S=JSON.parse(a)}catch{S=null}let C=F(S);if(C.v!==2||C.owner!==n||!N(C.people))return{people:P,rewrite:!0};let M=!1;for(let[$,ee]of Object.entries(C.people)){let te=et($,ee,u,f);te?P.set($,te):M=!0}return Q(P,g)&&(M=!0),{people:P,rewrite:M}}function ke(a,n){return JSON.stringify({v:2,owner:a,people:Object.fromEntries(n)})}function tt(a){return N(a)&&N(a.data)&&typeof a.timestamp=="number"}function De(a){let n=a.core;n.initializePeopleTags=function(){if(!n.currentSettings?.peopleTagsEnabled){console.log("🪼 Jellyfin Enhanced: People Tags: Feature is disabled in settings.");return}let u="🪼 Jellyfin Enhanced: People Tags:",f="JellyfinEnhanced-peopleTagsCache-v2",g=["JellyfinEnhanced-peopleTagsCache","JellyfinEnhanced-peopleTagsCacheTimestamp","JellyfinEnhanced-peopleTagsCacheIdentityOwner"],P=3e3,S=Number(n.pluginConfig?.TagsCacheTtlDays||30)*24*60*60*1e3,C=100,M=8,$=[1e3,3e3],ee=5,ne=`${n.session?.getServerId()||""}:${n.session?.getUserId()||X().getCurrentUserId()||""}`,T=new Map;try{for(let t of g)localStorage.removeItem(t);let e=Ie(localStorage.getItem(f),ne,Date.now(),S,P);T=e.people,e.rewrite&&q()}catch(e){console.warn(`${u} Could not read people cache`,e),T=new Map}let ce=n._hotCache=n._hotCache||{ttl:S},ue=ce.peopleTags,U=typeof ue=="object"?ue:new Map;ce.peopleTags=U,n.session?.onUserChange("people-tags",e=>{oe();for(let t of[...A.keys()])W(t);T=new Map,U.clear(),ne=`${e.serverId||""}:${e.userId||""}`,q()});let H=new WeakSet,k=new WeakSet,Z=new WeakSet,E=null,D=!1,_=!1,de=!1,J=!1,G=!1,j=n.core.lifecycle.register("people-tags");j.teardown();let B=null,re=new Set;function oe(){return Be(),B&&(B.abort(),j.untrack(B)),B=j.track(new AbortController),B}let A=new Map;function W(e){let t=A.get(e);t&&(A.delete(e),t.ctl&&(t.ctl.abort(),j.untrack(t.ctl)))}n.core.ui.injectCss("je-people-tags-styles",`

            .je-msym-rounded {
                font-family: 'JE Material Symbols Rounded';
                font-weight: normal;
                font-style: normal;
                font-size: 24px;
                line-height: 1;
                letter-spacing: normal;
                text-transform: none;
                display: inline-block;
                white-space: nowrap;
                word-wrap: normal;
                direction: ltr;
                -webkit-font-feature-settings: 'liga';
                -moz-font-feature-settings: 'liga';
                font-feature-settings: 'liga';
                -webkit-font-smoothing: antialiased;
            }

            /* Ensure cardScalable has position: relative for absolute positioned overlays */
            #castCollapsible .personCard .cardScalable {
                position: relative;
            }

            /* Deceased poster styling */
            .je-deceased-poster .cardImageContainer {
                filter: grayscale(100%) opacity(0.7);
            }

            .je-deceased-poster .cardScalable::after {
                content: "✝";
                /* Not in Jellyfin's web fonts: name the generic family directly so
                   the first cross does not walk the CJK families of the body
                   stack (a ~500 ms one-off layout stall on Linux, see icons.js). */
                font-family: sans-serif;
                position: absolute;
                top: 8px;
                right: 8px;
                z-index: 3;
                color: white;
                font-weight: bold;
                font-size: 2em;
                text-shadow: 0 0 4px black;
                pointer-events: none;
            }

            /* People tag banner styling */
            .je-people-tag-banner {
                max-width: 100%;
                box-sizing: border-box;
            }

            /* Round portraits: themes clip the whole .cardScalable to a circle, which
               crops corner-anchored tags. Clip the image instead so age badges can
               overlap the edge, and inset the birthplace pill. */
            .je-people-round .cardScalable {
                overflow: visible !important;
                aspect-ratio: 1 / 1;
            }
            .je-people-round .cardPadder {
                display: none !important;
            }
            .je-people-round .cardImageContainer,
            .je-people-round .cardOverlayContainer {
                bottom: auto !important;
                height: auto !important;
                aspect-ratio: 1 / 1;
                border-radius: 50% !important;
                overflow: hidden;
            }
            .je-people-round .je-people-age-container {
                top: 2% !important;
                left: -6% !important;
                gap: 3px !important;
            }
            .je-people-round .je-people-age-chip {
                padding: 2px 6px !important;
                font-size: 11px !important;
                border-radius: 999px !important;
                box-shadow: 0 1px 4px rgba(0, 0, 0, 0.6) !important;
            }
            .je-people-round .je-people-place-banner {
                left: 12% !important;
                right: 12% !important;
                bottom: 9% !important;
                padding: 3px 8px !important;
                justify-content: center;
                border-radius: 999px;
                background: rgba(0, 0, 0, 0.7) !important;
            }
            .je-people-round .je-people-place-text {
                flex: 0 1 auto !important;
            }
        `),console.log(`${u} Initialized`);function Oe(e){if(!e||typeof e!="string")return null;let t=e.split(",").map(o=>o.trim());if(t.length===0)return null;let r=t[t.length-1]??"";for(let[o,s]of Object.entries(Ee))if(o.toLowerCase()===r.toLowerCase())return s;return null}function K(e){return String(e).toLowerCase().replace(/-/g,"")}function ae(e,t){let r=U.get(e);if(tt(r)&&t-r.timestamp<S)return r.data;let o=T.get(e);if(o&&t-o.ts<S){let s={birthDate:o.b,deathDate:o.d,birthPlace:o.p};return U.set(e,{data:s,timestamp:o.ts}),s}return null}function Ne(e,t,r){let o={ts:r};t.birthDate&&(o.b=t.birthDate),t.deathDate&&(o.d=t.deathDate),t.birthPlace&&(o.p=t.birthPlace),T.delete(e),T.set(e,o),U.set(e,{data:t,timestamp:r})}function q(){Q(T,P);for(let e=0;e<2;e++)try{localStorage.setItem(f,ke(ne,T));return}catch(t){if(e===0&&T.size>0){Q(T,Math.floor(T.size/2));continue}console.debug(`${u} People cache not persisted`,t);return}}function Fe(e){let t=typeof n.helpers?.getItemCached=="function"?n.helpers.getItemCached(e):X().getItem(X().getCurrentUserId(),e);return Promise.resolve(t).then(r=>L(F(r).PremiereDate)).catch(()=>null)}function pe(e){return`/people/info?ids=${e.map(encodeURIComponent).join(",")}`}function fe(e,t){let r=F(F(t).people),o=Date.now(),s=!1;return{facts:e.map(i=>{let c=ve(r[K(i)]);return c&&(Ne(K(i),c,o),s=!0),c}),cached:s}}function ge(e){let t=[];if(e.length>0){t.push(e.slice(0,M));for(let r=M;r<e.length;r+=C)t.push(e.slice(r,r+C))}return t}function me(e,t,r,o){let s=je(r,o,Re());for(let l of e)Ue(l,t,s),k.delete(l),H.add(l)}function R(e){return!n.session||n.session.isCurrent(e)}function Le(e){return new Promise(t=>{let r={timeoutId:0,cancel:()=>{}},o=s=>{re.delete(r)&&(j.untrack(r.cancel),t(s))};r.cancel=()=>{clearTimeout(r.timeoutId),o(!1)},r.timeoutId=setTimeout(()=>o(!0),e),re.add(r),j.track(r.cancel)})}function Be(){for(let e of[...re])e.cancel()}function v(e,t=!1){for(let[,r]of e)for(let o of r)k.delete(o),t&&Z.add(o)}async function he(e,t,r,o,s){let l=e.map(([w])=>w),i=pe(l),c=null;for(let w=0;;w++)try{c=await n.core.api.plugin(i,{signal:r,skipRetry:!0});break}catch(d){if(r.aborted)return v(e),!1;let y=Se(d);if(!(!y||y>=500||y===408||y===429)||w>=$.length)return console.warn(`${u} Failed to fetch person info for ${l.length} people:`,d),v(e,!0),!1;let h=$[w]??0;if(console.debug(`${u} Person info request failed, retrying in ${h}ms`,d),!await Le(h)||r.aborted)return v(e),!1}if(r.aborted||!R(o)||E!==t)return v(e),!1;let{facts:m,cached:p}=fe(l,c),b=e.map((w,d)=>[w,m[d]??null]),x=await s;return r.aborted||!R(o)||E!==t?(v(e),p):(be(b,x),p)}function be(e,t){let r=!!n.currentSettings?.peopleTagsEnabled;for(let[[o,s],l]of e)if(!r)v([[o,s]]);else if(l)me(s,o,l,t);else for(let i of s)k.delete(i),H.add(i)}async function ze(e,t,r,o,s,l){let i=await t,c=await l;return o.aborted||!R(s)||E!==r?(v(e),!1):i.status!=="answered"?he(e,r,o,s,l):(be(e.map(m=>[m,i.factsById.get(m[0])||null]),c),!1)}function se(e,t,r,o){let s=document.createElement("div");s.className=`je-people-age-chip je-people-age-${e}`,s.style.cssText=`
                display: flex;
                align-items: center;
                gap: 4px;
                background: ${t};
                padding: 3px 8px;
                border-radius: 3px;
                font-size: 11px;
                font-weight: 500;
                color: white;
                box-shadow: 0 1px 3px rgba(0,0,0,0.3);
            `;let l=document.createElement("span");l.className="je-msym-rounded je-people-age-icon",l.textContent=r,l.style.cssText="font-size: 13px;",s.appendChild(l);let i=document.createElement("span");i.className="je-people-age-text";let c=typeof n.t=="function"?n.t("tag_people_age_short",{age:o}):"tag_people_age_short";return i.textContent=c==="tag_people_age_short"?`${o}y`:c,s.appendChild(i),s}function $e(e){let t=document.createElement("div");t.className="je-people-age-container",t.style.cssText=`
                position: absolute;
                top: 8px;
                left: 8px;
                display: flex;
                flex-direction: column;
                gap: 4px;
                align-items: flex-start;
                z-index: 3;
                pointer-events: none;
            `,e.isDeceased&&e.ageAtDeath!==null&&e.ageAtDeath!==void 0?t.appendChild(se("deceased","rgba(180, 50, 50, 0.85)","event_busy",e.ageAtDeath)):e.currentAge!==null&&e.currentAge!==void 0&&t.appendChild(se("current","rgba(100, 170, 100, 0.85)","cake",e.currentAge)),e.ageAtItemRelease!==null&&e.ageAtItemRelease!==void 0&&t.appendChild(se("release","rgba(70, 130, 180, 0.85)","movie",e.ageAtItemRelease));let r=document.createElement("div");if(r.className="je-people-place-banner",r.style.cssText=`
                position: absolute;
                bottom: 0;
                left: 0;
                right: 0;
                background: linear-gradient(to top, rgba(0,0,0,0.9), rgba(0,0,0,0.7), transparent);
                padding: 12px 8px 8px 8px;
                display: flex;
                align-items: center;
                gap: 6px;
                font-size: 11px;
                color: white;
                z-index: 1;
                pointer-events: none;
            `,e.birthPlace){let o=Oe(e.birthPlace);if(o){let i=document.createElement("img");i.className="je-people-flag",i.src=n.cdn.flagPng(o),i.style.cssText="width: 16px; height: 12px; border-radius: 2px; object-fit: cover;",i.alt=o,r.appendChild(i)}let s=document.createElement("span");s.className="je-msym-rounded je-people-place-icon",s.textContent="place",s.style.cssText="font-size: 14px; opacity: 0.9;",r.appendChild(s);let l=document.createElement("span");l.className="je-people-place-text",l.textContent=e.birthPlace,l.style.cssText="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; opacity: 0.95;",l.title=e.birthPlace,r.appendChild(l)}return{ageContainer:t,placeContainer:r}}function Ue(e,t,r){try{r.isDeceased&&(e.classList.add("je-deceased-poster"),console.debug(`${u} Marked ${t} as deceased`));let o=e.querySelector(".cardScalable");if(!o){console.warn(`${u} No cardScalable found for ${t}`);return}let s=getComputedStyle(o).borderRadius;e.classList.toggle("je-people-round",s.includes("%")&&parseFloat(s)>=40);let l=o.querySelector(".je-people-age-container");l&&l.remove();let i=o.querySelector(".je-people-place-banner");i&&i.remove();let c=$e(r);c.ageContainer.children.length>0&&o.appendChild(c.ageContainer),c.placeContainer.children.length>0&&o.appendChild(c.placeContainer)}catch(o){console.warn(`${u} Error processing cast member ${t}:`,o)}}function ye(e,t,r=!1){for(let o of["#castCollapsible","#guestCastCollapsible"]){let s=e?e.querySelector(o):document.querySelector(`#itemDetailPage:not(.hide) ${o}`);if(!s)continue;let l=s.querySelectorAll(".personCard");if(l.length!==0){r&&console.debug(`${u} Found ${l.length} cast members in ${o}`);for(let i of l)t(i)}}}function He(){let e=new Map;return ye(null,t=>{if(H.has(t)||k.has(t)||Z.has(t))return;let r=t.getAttribute("data-id");if(!r)return;k.add(t),G=!0;let o=e.get(r);o?o.push(t):e.set(r,[t])},!0),e}async function _e(e,t,r){let o=[...e];if(!n.currentSettings?.peopleTagsEnabled){v(o);return}let s=Date.now(),l=n.session?n.session.getEpoch():0,i=Fe(t),c=A.get(t)?.people,m=[],p=new Map,b=[];for(let d of o){let y=ae(K(d[0]),s),I=y?null:c?.get(d[0]);if(y)m.push([d,y]);else if(I){let h=p.get(I);h?h.push(d):p.set(I,[d])}else b.push(d)}let x=ge(b).map(d=>he(d,t,r,l,i));for(let[d,y]of p)x.push(ze(y,d,t,r,l,i));if(m.length>0){let d=await i;if(r.aborted||!R(l)||E!==t||!n.currentSettings?.peopleTagsEnabled)v(m.map(([y])=>y));else for(let[[y,I],h]of m)me(I,y,h,d)}(await Promise.all(x)).some(Boolean)&&R(l)&&q()}async function Je(){if(!_){_=!0;try{let e=window.location.hash,r=new URLSearchParams(e.split("?")[1]).get("id");if(!r){console.debug(`${u} No item ID found in URL`);return}let o=(B||oe()).signal;for(let s=0;s<ee&&n.currentSettings?.peopleTagsEnabled;s++){let l=He();if(l.size===0||(await _e(l,r,o),o.aborted||E!==r))break}}catch(e){console.error(`${u} Error in processCastMembers:`,e)}finally{_=!1}}}function Ce(){try{return new URLSearchParams(window.location.hash.split("?")[1]).get("id")}catch{return null}}function Ge(e){if(!Array.isArray(e?.People))return null;let t=[],r=[];for(let o of e.People){let s=F(o);if(typeof s.Id!="string"||!s.Id||s.Type==="Artist"||s.Type==="AlbumArtist")return null;(s.Type==="GuestStar"?r:t).push(s.Id)}return[...new Set([...t,...r])]}function Ke(){console.debug(`${u} Initializing with managed observer pattern`);function e(i){if(!n.currentSettings?.peopleTagsEnabled)return;let c=document.querySelector("#itemDetailPage:not(.hide) #castCollapsible"),m=document.querySelector("#itemDetailPage:not(.hide) #guestCastCollapsible");if(!(!c&&!m))try{let p=new URLSearchParams(window.location.hash.split("?")[1]).get("id");if(!p)return;if(E!==p){E=p,oe(),H=new WeakSet,k=new WeakSet,Z=new WeakSet,D=!1,J=!1,G=!1;for(let x of[...A.keys()])x!==p&&W(x);console.debug(`${u} New item detected: ${p}`)}if(D)return;if(_){!i&&de&&(J=!0);return}let b=p;de=i,Je().then(()=>{if(E!==b){J=!1,r();return}if(i){J&&(J=!1,r());return}setTimeout(()=>{E===b&&(G||!A.has(b))&&(D=!0)},2e3)})}catch{}}let t=n.helpers;if(!t)return;let r=t.debounce(()=>e(!1),100);function o(i=Ce()){let c=i?A.get(i):null;if(!c||!c.view||!R(c.epoch)||!n.currentSettings?.peopleTagsEnabled)return;let m=E===i;if(m&&(D||_)||document.querySelector("#itemDetailPage:not(.hide)")!==c.view)return;let p=Date.now(),b=0,x=!0;ye(c.view,w=>{if(!x||m&&(H.has(w)||k.has(w)||Z.has(w)))return;let d=w.getAttribute("data-id");d&&(b++,!c.people.has(d)&&!ae(K(d),p)&&(x=!1))}),x&&b>0&&e(!0)}function s(i,c,m,p){if(!n.currentSettings?.peopleTagsEnabled||!R(p)||typeof n.core?.api?.plugin!="function"||!i||A.has(i)||E===i&&(G||D))return;let b=Ge(c);if(!b||b.length===0)return;for(let h of[...A.keys()])h!==E&&W(h);let x=Date.now(),w=b.filter(h=>!ae(K(h),x)),d=w.length?j.track(new AbortController):null,y={ctl:d,view:m,epoch:p,people:new Map};A.set(i,y);let I=ge(w).map(h=>{let z=d?.signal,we=n.core.api.plugin(pe(h),{...z?{signal:z}:{},skipRetry:!0}).then(Y=>{if(z?.aborted||!R(p))return{status:"aborted"};let{facts:Ye,cached:Ze}=fe(h,Y);return{status:"answered",factsById:new Map(h.map((We,qe)=>[We,Ye[qe]??null])),cached:Ze}}).catch(Y=>(console.debug(`${u} Person info prefetch failed`,Y),{status:z?.aborted?"aborted":"failed"}));for(let Y of h)y.people.set(Y,we);return we});d&&Promise.all(I).then(h=>{h.some(z=>z.cached)&&R(p)&&q(),j.untrack(d)}),o()}function l(i){if(E!==i||!G){W(i);return}let c=A.get(i);c&&(c.view=null)}t.createObserver?.("people-tags",i=>{if(!n.currentSettings?.peopleTagsEnabled)return;let c=Ce();if(c&&c!==E&&(D=!1),D||!document.querySelector("#itemDetailPage:not(.hide)"))return;let m=!1;for(let x of i)if(x.addedNodes.length>0){m=!0;break}if(!m)return;let p=document.querySelector("#itemDetailPage:not(.hide) #castCollapsible"),b=document.querySelector("#itemDetailPage:not(.hide) #guestCastCollapsible");!p&&!b||(o(c),r())},document.body,{childList:!0,subtree:!0}),r(),a.own.peopleTags=n.peopleTags={prefetch:s,leave:l},console.debug(`${u} Initialization complete`)}Ke()}}De(xe());})();
})();
