(() => {
"use strict";(()=>{function ye(r,n,u){let p=n.core?.featureContext;if(typeof p!="function")throw new Error(`${r}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);return p(r,n,u)}function Ye(){let r=window,n=r.JellyfinEnhanced??(r.JellyfinEnhanced={});return n.core??(n.core={}),n}function we(r=Ye()){return ye("media-tags",r,{internalSlots:["peopleTags"],internalsObject:()=>r.internals=r.internals||{}})}function q(){let r=window;if(!r.ApiClient)throw new Error("Jellyfin ApiClient unavailable");return r.ApiClient}var Ze=Object.freeze({});function M(r){return typeof r=="object"&&r!==null&&!Array.isArray(r)}function L(r){return M(r)?r:Ze}function Ce(r){return M(r)&&typeof r.status=="number"?r.status:0}var Pe={"United States":"US",USA:"US",America:"US","United Kingdom":"GB",UK:"GB",England:"GB",Scotland:"GB",Wales:"GB",Canada:"CA",Australia:"AU","New Zealand":"NZ",Germany:"DE",France:"FR",Italy:"IT",Spain:"ES",Mexico:"MX",Brazil:"BR",Argentina:"AR",Japan:"JP","South Korea":"KR",China:"CN",India:"IN",Russia:"RU",Sweden:"SE",Norway:"NO",Denmark:"DK",Finland:"FI",Netherlands:"NL",Belgium:"BE",Austria:"AT",Switzerland:"CH",Poland:"PL","Czech Republic":"CZ",Czechia:"CZ",Greece:"GR",Portugal:"PT",Turkey:"TR",Israel:"IL","South Africa":"ZA",Chile:"CL",Colombia:"CO",Peru:"PE",Thailand:"TH",Malaysia:"MY",Singapore:"SG",Philippines:"PH",Indonesia:"ID",Vietnam:"VN",Ukraine:"UA",Iran:"IR",Ireland:"IE",Hungary:"HU",Romania:"RO",Bulgaria:"BG",Croatia:"HR",Serbia:"RS",Slovenia:"SI",Estonia:"EE",Latvia:"LV",Lithuania:"LT",Iceland:"IS",Luxembourg:"LU",Monaco:"MC",Liechtenstein:"LI",Malta:"MT",Cyprus:"CY",Slovakia:"SK","Bosnia and Herzegovina":"BA",Bosnia:"BA","North Macedonia":"MK",Macedonia:"MK",Albania:"AL",Montenegro:"ME",Moldova:"MD",Belarus:"BY",Kosovo:"XK",Georgia:"GE",Armenia:"AM",Azerbaijan:"AZ","Saudi Arabia":"SA","United Arab Emirates":"AE",UAE:"AE",Qatar:"QA",Kuwait:"KW",Bahrain:"BH",Oman:"OM",Jordan:"JO",Lebanon:"LB",Egypt:"EG",Iraq:"IQ",Syria:"SY",Yemen:"YE",Palestine:"PS",Pakistan:"PK",Bangladesh:"BD","Sri Lanka":"LK",Nepal:"NP",Taiwan:"TW","Hong Kong":"HK",Macau:"MO",Kazakhstan:"KZ",Uzbekistan:"UZ",Afghanistan:"AF",Mongolia:"MN",Myanmar:"MM",Cambodia:"KH",Laos:"LA",Venezuela:"VE",Ecuador:"EC",Uruguay:"UY",Paraguay:"PY",Bolivia:"BO","Costa Rica":"CR",Panama:"PA",Nicaragua:"NI",Honduras:"HN","El Salvador":"SV",Guatemala:"GT",Belize:"BZ",Cuba:"CU",Jamaica:"JM","Dominican Republic":"DO","Puerto Rico":"PR","Trinidad and Tobago":"TT",Barbados:"BB",Haiti:"HT",Bahamas:"BS",Guyana:"GY",Suriname:"SR",Nigeria:"NG",Kenya:"KE",Ghana:"GH",Ethiopia:"ET",Morocco:"MA",Algeria:"DZ",Tunisia:"TN",Libya:"LY",Senegal:"SN",Uganda:"UG",Tanzania:"TZ",Zimbabwe:"ZW",Zambia:"ZM",Botswana:"BW",Namibia:"NA",Angola:"AO",Mozambique:"MZ",Madagascar:"MG",Cameroon:"CM","Ivory Coast":"CI","Côte d'Ivoire":"CI",Mali:"ML","Burkina Faso":"BF","Papua New Guinea":"PG",Fiji:"FJ",Samoa:"WS",Tonga:"TO"};var qe=/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/,Ve=/^[0-9a-f]{32}$/,Te=300;function Qe(r){return r%4===0&&r%100!==0||r%400===0}function xe(r,n){return n===2?Qe(r)?29:28:[31,28,31,30,31,30,31,31,30,31,30,31][n-1]??31}function N(r){if(typeof r!="string")return null;let n=qe.exec(r);if(!n)return null;let u=Number(n[1]),p=Number(n[2]),f=Number(n[3]);return u<1||p<1||p>12||f<1||f>xe(u,p)?null:{y:u,m:p,d:f}}function Se(r,n){return r.y-n.y||r.m-n.m||r.d-n.d}function ae(r,n){let u=n.y-r.y,p={y:n.y,m:r.m,d:Math.min(r.d,xe(n.y,r.m))};return Se(n,p)<0&&u--,Math.max(0,u)}function ve(r=new Date){return{y:r.getFullYear(),m:r.getMonth()+1,d:r.getDate()}}function Re(r){if(!M(r))return null;let n={};return N(r.birthDate)&&(n.birthDate=String(r.birthDate).slice(0,10)),N(r.deathDate)&&(n.deathDate=String(r.deathDate).slice(0,10)),typeof r.birthPlace=="string"&&r.birthPlace.trim()&&(n.birthPlace=r.birthPlace.trim().slice(0,Te)),n}function Ae(r,n,u){let p=N(r.birthDate),f=N(r.deathDate),P=!!f&&Se(f,u)<=0,x=null,w=null,A=null;return p&&(f&&P?w=ae(p,f):x=ae(p,u),n&&(A=ae(p,n))),{birthPlace:r.birthPlace||null,isDeceased:P,currentAge:x,ageAtDeath:w,ageAtItemRelease:A}}function Xe(r,n,u,p){if(!Ve.test(r)||!M(n))return null;let f=n.ts;if(typeof f!="number"||!Number.isFinite(f)||u-f>=p||f>u+864e5)return null;let P={ts:f};for(let x of["b","d"]){let w=n[x];if(w!==void 0){if(typeof w!="string"||w.length!==10||!N(w))return null;P[x]=w}}if(n.p!==void 0){if(typeof n.p!="string"||!n.p||n.p.length>Te)return null;P.p=n.p}return P}function V(r,n){if(r.size<=n)return!1;let u=[...r].sort((p,f)=>p[1].ts-f[1].ts);for(let[p]of u.slice(0,u.length-n))r.delete(p);return!0}function ke(r,n,u,p,f){let P=new Map;if(r==null)return{people:P,rewrite:!1};let x=null;try{x=JSON.parse(r)}catch{x=null}let w=L(x);if(w.v!==2||w.owner!==n||!M(w.people))return{people:P,rewrite:!0};let A=!1;for(let[B,Q]of Object.entries(w.people)){let X=Xe(B,Q,u,p);X?P.set(B,X):A=!0}return V(P,f)&&(A=!0),{people:P,rewrite:A}}function Ee(r,n){return JSON.stringify({v:2,owner:r,people:Object.fromEntries(n)})}function et(r){return M(r)&&M(r.data)&&typeof r.timestamp=="number"}function Me(r){let n=r.core;n.initializePeopleTags=function(){if(!n.currentSettings?.peopleTagsEnabled){console.log("🪼 Jellyfin Enhanced: People Tags: Feature is disabled in settings.");return}let u="🪼 Jellyfin Enhanced: People Tags:",p="JellyfinEnhanced-peopleTagsCache-v2",f=["JellyfinEnhanced-peopleTagsCache","JellyfinEnhanced-peopleTagsCacheTimestamp","JellyfinEnhanced-peopleTagsCacheIdentityOwner"],P=3e3,x=Number(n.pluginConfig?.TagsCacheTtlDays||30)*24*60*60*1e3,w=100,A=8,B=[1e3,3e3],Q=5,ee=`${n.session?.getServerId()||""}:${n.session?.getUserId()||q().getCurrentUserId()||""}`,v=new Map;try{for(let t of f)localStorage.removeItem(t);let e=ke(localStorage.getItem(p),ee,Date.now(),x,P);v=e.people,e.rewrite&&Z()}catch(e){console.warn(`${u} Could not read people cache`,e),v=new Map}let ie=n._hotCache=n._hotCache||{ttl:x},se=ie.peopleTags,U=typeof se=="object"?se:new Map;ie.peopleTags=U,n.session?.onUserChange("people-tags",e=>{ne();for(let t of[...R.keys()])Y(t);v=new Map,U.clear(),ee=`${e.serverId||""}:${e.userId||""}`,Z()});let H=new WeakSet,D=new WeakSet,W=new WeakSet,S=null,O=!1,J=!1,le=!1,$=!1,G=!1,I=n.core.lifecycle.register("people-tags");I.teardown();let F=null,te=new Set;function ne(){return Le(),F&&(F.abort(),I.untrack(F)),F=I.track(new AbortController),F}let R=new Map;function Y(e){let t=R.get(e);t&&(R.delete(e),t.ctl&&(t.ctl.abort(),I.untrack(t.ctl)))}n.core.ui.injectCss("je-people-tags-styles",`

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
        `),console.log(`${u} Initialized`);function Ie(e){if(!e||typeof e!="string")return null;let t=e.split(",").map(a=>a.trim());if(t.length===0)return null;let o=t[t.length-1]??"";for(let[a,i]of Object.entries(Pe))if(a.toLowerCase()===o.toLowerCase())return i;return null}function _(e){return String(e).toLowerCase().replace(/-/g,"")}function re(e,t){let o=U.get(e);if(et(o)&&t-o.timestamp<x)return o.data;let a=v.get(e);if(a&&t-a.ts<x){let i={birthDate:a.b,deathDate:a.d,birthPlace:a.p};return U.set(e,{data:i,timestamp:a.ts}),i}return null}function je(e,t,o){let a={ts:o};t.birthDate&&(a.b=t.birthDate),t.deathDate&&(a.d=t.deathDate),t.birthPlace&&(a.p=t.birthPlace),v.delete(e),v.set(e,a),U.set(e,{data:t,timestamp:o})}function Z(){V(v,P);for(let e=0;e<2;e++)try{localStorage.setItem(p,Ee(ee,v));return}catch(t){if(e===0&&v.size>0){V(v,Math.floor(v.size/2));continue}console.debug(`${u} People cache not persisted`,t);return}}function De(e){let t=typeof n.helpers?.getItemCached=="function"?n.helpers.getItemCached(e):q().getItem(q().getCurrentUserId(),e);return Promise.resolve(t).then(o=>N(L(o).PremiereDate)).catch(()=>null)}function ce(e){return`/people/info?ids=${e.map(encodeURIComponent).join(",")}`}function ue(e,t){let o=L(L(t).people),a=Date.now(),i=!1;return{facts:e.map(s=>{let c=Re(o[_(s)]);return c&&(je(_(s),c,a),i=!0),c}),cached:i}}function de(e){let t=[];if(e.length>0){t.push(e.slice(0,A));for(let o=A;o<e.length;o+=w)t.push(e.slice(o,o+w))}return t}function pe(e,t,o,a){let i=Ae(o,a,ve());for(let l of e)ze(l,t,i),D.delete(l),H.add(l)}function k(e){return!n.session||n.session.isCurrent(e)}function Oe(e){return new Promise(t=>{let o={timeoutId:0,cancel:()=>{}},a=i=>{te.delete(o)&&(I.untrack(o.cancel),t(i))};o.cancel=()=>{clearTimeout(o.timeoutId),a(!1)},o.timeoutId=setTimeout(()=>a(!0),e),te.add(o),I.track(o.cancel)})}function Le(){for(let e of[...te])e.cancel()}function E(e,t=!1){for(let[,o]of e)for(let a of o)D.delete(a),t&&W.add(a)}async function ge(e,t,o,a,i){let l=e.map(([C])=>C),s=ce(l),c=null;for(let C=0;;C++)try{c=await n.core.api.plugin(s,{signal:o,skipRetry:!0});break}catch(d){if(o.aborted)return E(e),!1;let y=Ce(d);if(!(!y||y>=500||y===408||y===429)||C>=B.length)return console.warn(`${u} Failed to fetch person info for ${l.length} people:`,d),E(e,!0),!1;let b=B[C]??0;if(console.debug(`${u} Person info request failed, retrying in ${b}ms`,d),!await Oe(b)||o.aborted)return E(e),!1}if(o.aborted||!k(a)||S!==t)return E(e),!1;let{facts:m,cached:g}=ue(l,c),h=e.map((C,d)=>[C,m[d]??null]),T=await i;return o.aborted||!k(a)||S!==t?(E(e),g):(fe(h,T),g)}function fe(e,t){let o=!!n.currentSettings?.peopleTagsEnabled;for(let[[a,i],l]of e)if(!o)E([[a,i]]);else if(l)pe(i,a,l,t);else for(let s of i)D.delete(s),H.add(s)}async function Ne(e,t,o,a,i,l){let s=await t,c=await l;return a.aborted||!k(i)||S!==o?(E(e),!1):s.status!=="answered"?ge(e,o,a,i,l):(fe(e.map(m=>[m,s.factsById.get(m[0])||null]),c),!1)}function oe(e,t,o,a){let i=document.createElement("div");i.className=`je-people-age-chip je-people-age-${e}`,i.style.cssText=`
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
            `;let l=document.createElement("span");l.className="je-msym-rounded je-people-age-icon",l.textContent=o,l.style.cssText="font-size: 13px;",i.appendChild(l);let s=document.createElement("span");s.className="je-people-age-text";let c=typeof n.t=="function"?n.t("tag_people_age_short",{age:a}):"tag_people_age_short";return s.textContent=c==="tag_people_age_short"?`${a}y`:c,i.appendChild(s),i}function Fe(e){let t=document.createElement("div");t.className="je-people-age-container",t.style.cssText=`
                position: absolute;
                top: 8px;
                left: 8px;
                display: flex;
                flex-direction: column;
                gap: 4px;
                align-items: flex-start;
                z-index: 3;
                pointer-events: none;
            `,e.isDeceased&&e.ageAtDeath!==null&&e.ageAtDeath!==void 0?t.appendChild(oe("deceased","rgba(180, 50, 50, 0.85)","event_busy",e.ageAtDeath)):e.currentAge!==null&&e.currentAge!==void 0&&t.appendChild(oe("current","rgba(100, 170, 100, 0.85)","cake",e.currentAge)),e.ageAtItemRelease!==null&&e.ageAtItemRelease!==void 0&&t.appendChild(oe("release","rgba(70, 130, 180, 0.85)","movie",e.ageAtItemRelease));let o=document.createElement("div");if(o.className="je-people-place-banner",o.style.cssText=`
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
            `,e.birthPlace){let a=Ie(e.birthPlace);if(a){let s=document.createElement("img");s.className="je-people-flag",s.src=n.cdn.flagPng(a),s.style.cssText="width: 16px; height: 12px; border-radius: 2px; object-fit: cover;",s.alt=a,o.appendChild(s)}let i=document.createElement("span");i.className="je-msym-rounded je-people-place-icon",i.textContent="place",i.style.cssText="font-size: 14px; opacity: 0.9;",o.appendChild(i);let l=document.createElement("span");l.className="je-people-place-text",l.textContent=e.birthPlace,l.style.cssText="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; opacity: 0.95;",l.title=e.birthPlace,o.appendChild(l)}return{ageContainer:t,placeContainer:o}}function ze(e,t,o){try{o.isDeceased&&(e.classList.add("je-deceased-poster"),console.debug(`${u} Marked ${t} as deceased`));let a=e.querySelector(".cardScalable");if(!a){console.warn(`${u} No cardScalable found for ${t}`);return}let i=getComputedStyle(a).borderRadius;e.classList.toggle("je-people-round",i.includes("%")&&parseFloat(i)>=40);let l=a.querySelector(".je-people-age-container");l&&l.remove();let s=a.querySelector(".je-people-place-banner");s&&s.remove();let c=Fe(o);c.ageContainer.children.length>0&&a.appendChild(c.ageContainer),c.placeContainer.children.length>0&&a.appendChild(c.placeContainer)}catch(a){console.warn(`${u} Error processing cast member ${t}:`,a)}}function me(e,t,o=!1){for(let a of["#castCollapsible","#guestCastCollapsible"]){let i=e?e.querySelector(a):document.querySelector(`#itemDetailPage:not(.hide) ${a}`);if(!i)continue;let l=i.querySelectorAll(".personCard");if(l.length!==0){o&&console.debug(`${u} Found ${l.length} cast members in ${a}`);for(let s of l)t(s)}}}function Be(){let e=new Map;return me(null,t=>{if(H.has(t)||D.has(t)||W.has(t))return;let o=t.getAttribute("data-id");if(!o)return;D.add(t),G=!0;let a=e.get(o);a?a.push(t):e.set(o,[t])},!0),e}async function Ue(e,t,o){let a=[...e];if(!n.currentSettings?.peopleTagsEnabled){E(a);return}let i=Date.now(),l=n.session?n.session.getEpoch():0,s=De(t),c=R.get(t)?.people,m=[],g=new Map,h=[];for(let d of a){let y=re(_(d[0]),i),j=y?null:c?.get(d[0]);if(y)m.push([d,y]);else if(j){let b=g.get(j);b?b.push(d):g.set(j,[d])}else h.push(d)}let T=de(h).map(d=>ge(d,t,o,l,s));for(let[d,y]of g)T.push(Ne(y,d,t,o,l,s));if(m.length>0){let d=await s;if(o.aborted||!k(l)||S!==t||!n.currentSettings?.peopleTagsEnabled)E(m.map(([y])=>y));else for(let[[y,j],b]of m)pe(j,y,b,d)}(await Promise.all(T)).some(Boolean)&&k(l)&&Z()}async function He(){if(!J){J=!0;try{let e=window.location.hash,o=new URLSearchParams(e.split("?")[1]).get("id");if(!o){console.debug(`${u} No item ID found in URL`);return}let a=(F||ne()).signal;for(let i=0;i<Q&&n.currentSettings?.peopleTagsEnabled;i++){let l=Be();if(l.size===0||(await Ue(l,o,a),a.aborted||S!==o))break}}catch(e){console.error(`${u} Error in processCastMembers:`,e)}finally{J=!1}}}function be(){try{return new URLSearchParams(window.location.hash.split("?")[1]).get("id")}catch{return null}}function Je(e){if(!Array.isArray(e?.People))return null;let t=[],o=[];for(let a of e.People){let i=L(a);if(typeof i.Id!="string"||!i.Id||i.Type==="Artist"||i.Type==="AlbumArtist")return null;(i.Type==="GuestStar"?o:t).push(i.Id)}return[...new Set([...t,...o])]}function $e(){console.debug(`${u} Initializing with managed observer pattern`);function e(s){if(!n.currentSettings?.peopleTagsEnabled)return;let c=document.querySelector("#itemDetailPage:not(.hide) #castCollapsible"),m=document.querySelector("#itemDetailPage:not(.hide) #guestCastCollapsible");if(!(!c&&!m))try{let g=new URLSearchParams(window.location.hash.split("?")[1]).get("id");if(!g)return;if(S!==g){S=g,ne(),H=new WeakSet,D=new WeakSet,W=new WeakSet,O=!1,$=!1,G=!1;for(let T of[...R.keys()])T!==g&&Y(T);console.debug(`${u} New item detected: ${g}`)}if(O)return;if(J){!s&&le&&($=!0);return}let h=g;le=s,He().then(()=>{if(S!==h){$=!1,o();return}if(s){$&&($=!1,o());return}setTimeout(()=>{S===h&&(G||!R.has(h))&&(O=!0)},2e3)})}catch{}}let t=n.helpers;if(!t)return;let o=t.debounce(()=>e(!1),100);function a(s=be()){let c=s?R.get(s):null;if(!c||!c.view||!k(c.epoch)||!n.currentSettings?.peopleTagsEnabled)return;let m=S===s;if(m&&(O||J)||document.querySelector("#itemDetailPage:not(.hide)")!==c.view)return;let g=Date.now(),h=0,T=!0;me(c.view,C=>{if(!T||m&&(H.has(C)||D.has(C)||W.has(C)))return;let d=C.getAttribute("data-id");d&&(h++,!c.people.has(d)&&!re(_(d),g)&&(T=!1))}),T&&h>0&&e(!0)}function i(s,c,m,g){if(!n.currentSettings?.peopleTagsEnabled||!k(g)||typeof n.core?.api?.plugin!="function"||!s||R.has(s)||S===s&&(G||O))return;let h=Je(c);if(!h||h.length===0)return;for(let b of[...R.keys()])b!==S&&Y(b);let T=Date.now(),C=h.filter(b=>!re(_(b),T)),d=C.length?I.track(new AbortController):null,y={ctl:d,view:m,epoch:g,people:new Map};R.set(s,y);let j=de(C).map(b=>{let z=d?.signal,he=n.core.api.plugin(ce(b),{...z?{signal:z}:{},skipRetry:!0}).then(K=>{if(z?.aborted||!k(g))return{status:"aborted"};let{facts:Ge,cached:_e}=ue(b,K);return{status:"answered",factsById:new Map(b.map((Ke,We)=>[Ke,Ge[We]??null])),cached:_e}}).catch(K=>(console.debug(`${u} Person info prefetch failed`,K),{status:z?.aborted?"aborted":"failed"}));for(let K of b)y.people.set(K,he);return he});d&&Promise.all(j).then(b=>{b.some(z=>z.cached)&&k(g)&&Z(),I.untrack(d)}),a()}function l(s){if(S!==s||!G){Y(s);return}let c=R.get(s);c&&(c.view=null)}t.createObserver?.("people-tags",s=>{if(!n.currentSettings?.peopleTagsEnabled)return;let c=be();if(c&&c!==S&&(O=!1),O||!document.querySelector("#itemDetailPage:not(.hide)"))return;let m=!1;for(let T of s)if(T.addedNodes.length>0){m=!0;break}if(!m)return;let g=document.querySelector("#itemDetailPage:not(.hide) #castCollapsible"),h=document.querySelector("#itemDetailPage:not(.hide) #guestCastCollapsible");!g&&!h||(a(c),o())},document.body,{childList:!0,subtree:!0}),o(),r.own.peopleTags=n.peopleTags={prefetch:i,leave:l},console.debug(`${u} Initialization complete`)}$e()}}Me(we());})();
})();
