(() => {
"use strict";(()=>{function D(o,r,d){let c=r.core?.featureContext;if(typeof c!="function")throw new Error(`${o}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);return c(o,r,d)}function F(o,r){return D("chrome",o,{facades:r})}function A(){return window.ApiClient}function R(){return window.JellyfinEnhanced}function C(o,r){let c=document.createElement.call(document,o,r);return c.getAttribute("is")!==r&&c.setAttribute("is",r),c}var p=Object.freeze({Default:"",Aurora:"aurora.css",Banana:"banana.css",Coal:"coal.css",Coral:"coral.css",Forest:"forest.css",Grass:"grass.css",Jellyblue:"jellyblue.css",Jellyflix:"jellyflix.css",Jellypurple:"jellypurple.css",Lavender:"lavender.css","Liquid Glass":"liquidglass.css",Midnight:"midnight.css",Mint:"mint.css",Ocean:"ocean.css",Peach:"peach.css",Watermelon:"watermelon.css"}),l="🪼 Jellyfin Enhanced: Jellyfish Theme Selector:",U="jellyfin-theme-selector-css",y="jellyfin-theme-selector",te=250,ne=1e3,re=100,f=300,T="jellyfin-theme-applied";function _(o,r){return r?`@import url("${o}${r}");`:""}function q(o,r){for(let[d,c]of Object.entries(p))if(_(o,c)===r)return d;return"Default"}var w="/* Jellyfin Enhanced theme selector: start */",v="/* Jellyfin Enhanced theme selector: end */";function J(o,r){let d=r.indexOf(w),c=d<0?-1:r.indexOf(v,d);if(c>=0)return{theme:q(o,r.slice(d+w.length,c).trim()),rest:r.slice(0,d)+r.slice(c+v.length).replace(/^\n/,"")};let u=r.indexOf(`
`),m=q(o,(u<0?r:r.slice(0,u)).trim());return{theme:m,rest:m==="Default"?r:u<0?"":r.slice(u+1)}}function oe(o,r){return!r||!o?r||o:`${w}
${r}
${v}
${o}`}function ie(o){return o.toISOString().split("T")[0]??""}function K(o,r){let d=o.cdn.url("jellyfish","colors/"),c=null,u,m=!1,b=(e,n)=>`${e}-${n}`;function g(e,n,t=null){try{let s=localStorage.getItem(b(e,n));return s===null?t:s}catch(s){return console.error("🪼 Jellyfin Enhanced: Theme selector storage read error",s),t}}function x(e,n,t){try{return localStorage.setItem(b(e,n),t),!0}catch(s){return console.error("🪼 Jellyfin Enhanced: Theme selector storage write error",s),!1}}function W(e,n){try{return localStorage.removeItem(b(e,n)),!0}catch(t){return console.error(`${l} localStorage remove error:`,t),!1}}let E=e=>g(e,"randomThemeEnabled")==="true";function I(){try{let e=r()?.getCurrentUserId?.();if(typeof e=="string"&&e.trim()!=="")return e}catch(e){console.error(`${l} Error extracting user ID:`,e)}return console.error(`${l} Could not extract user ID`),null}function M(e){try{return r()?.getCurrentUserId?.()===e}catch{return!1}}function k(e,n,t="Default"){let s=oe(J(d,g(e,"customCss","")??"").rest,_(d,n));s?x(e,"customCss",s):W(e,"customCss"),console.log(n?`${l} Theme set to: ${t}`:`${l} Theme cleared (default)`)}function L(e){let n=window;try{n.Dashboard?.alert?n.Dashboard.alert(e):n.require?n.require(["toast"],t=>t(e)):console.log(`${l} Notification: ${e}`)}catch(t){console.error(`${l} Failed to show notification:`,t)}}function z(){try{let e=sessionStorage.getItem(T);e&&(sessionStorage.removeItem(T),setTimeout(()=>L(`Theme applied: ${e}`),ne))}catch(e){console.error(`${l} Session storage error:`,e)}}function B(e,n){try{sessionStorage.setItem(T,e)}catch(t){console.error(`${l} ${n}`,t)}}function j(){let e=I();if(!e||!E(e))return;let n=ie(new Date);if(n===g(e,"lastRandomThemeDate")){console.log(`${l} Random theme already applied for today.`);return}console.log(`${l} New day detected! Applying a random theme.`);let t=Object.keys(p).filter(a=>a!=="Default"),s=t[Math.floor(Math.random()*t.length)]??"Default";k(e,p[s]??"",s),x(e,"lastRandomThemeDate",n),B(`Random Daily (${s})`,"Could not set session storage:"),window.location.reload()}function Y(){if(document.getElementById(U))return;let e=document.createElement("style");e.id=U,e.textContent=`
            #theme-selector-body {
                display: flex !important;
                align-items: center;
                justify-content: flex-start;
                flex-direction: row;
                flex-wrap: wrap;
                gap: 1em;
                padding: .4em .75em;
            }
            #theme-selector-select {
                max-width: 200px !important;
                min-width: 150px !important;
                transition: opacity ${f}ms ease;
            }
            #theme-selector-select:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }
            #random-theme-button {
                padding: 0.5em 0.5em !important;
                height: auto !important;
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                gap: 0.3em;
                background-color: transparent;
                border-radius: 10px;
                transition: background-color 0.3s ease, opacity ${f}ms ease;
            }
            #random-theme-button:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }
            #random-theme-button.active {
                background-color: #4CAF50;
                color: white;
            }
            .theme-applying {
                opacity: 0;
                transition: opacity ${f}ms ease;
            }
            .theme-applied {
                opacity: 1;
                transition: opacity ${f}ms ease;
            }
        `,document.head.appendChild(e),console.log(`${l} Custom CSS injected`)}function O(e,n="material-icons"){let t=document.createElement("span");return t.className=n,t.textContent=e,t.setAttribute("aria-hidden","true"),t}function H(e,n){return M(e)?!0:(console.warn(`${l} Signed-in user changed; discarding the previous user's selector.`),n.remove(),h(),!1)}function G(e,n){let t=C("select","emby-select");t.classList.add("emby-select-withcolor","emby-select"),t.id="theme-selector-select",t.setAttribute("aria-label","Select theme"),t.removeAttribute("label");let s=J(d,g(e,"customCss","")??"").theme;for(let a of Object.keys(p)){let i=document.createElement("option");i.value=a,i.textContent=a,a===s&&(i.selected=!0),t.appendChild(i)}return t.addEventListener("change",a=>{if(a.preventDefault(),a.stopPropagation(),!H(e,n))return;let i=t.value,P=p[i];if(P===void 0)return;t.disabled=!0;let N=document.getElementById("random-theme-button");N instanceof HTMLButtonElement&&(N.disabled=!0),document.body.classList.add("theme-applying"),k(e,P,i),B(i,"Session storage error:"),setTimeout(()=>{console.log(`${l} Reloading to apply theme: ${i}`),window.location.reload()},f)}),t}function V(e,n){let t=C("button","emby-button");t.className="emby-button",t.id="random-theme-button",t.setAttribute("aria-label","Toggle random daily theme"),t.setAttribute("title","Random daily theme");let s=document.createElement("span");s.style.fontSize="0.85em";let a=()=>{let i=E(e);t.classList.toggle("active",i),s.textContent=i?"Daily":"",t.setAttribute("aria-pressed",i.toString())};return t.appendChild(O("shuffle")),t.appendChild(s),a(),t.addEventListener("click",()=>{if(!H(e,n))return;let i=!E(e);x(e,"randomThemeEnabled",String(i)),L(`Random daily theme turned ${i?"ON":"OFF"}.`),console.log(`${l} Random daily theme set to: ${i}`),a(),i&&j()}),t}function Q(e){let n=document.createElement("div");n.className="theme-selector-container listItem-border",n.id=y,n.dataset.jeThemeUser=e;let t=document.createElement("div");t.className="listItem",t.id="theme-selector-item";let s=O("palette","material-icons listItemIcon listItemIcon-transparent");s.id="theme-selector-icon";let a=document.createElement("div");a.className="listItemBody",a.id="theme-selector-body";let i=document.createElement("div");return i.className="listItemBodyText",i.id="theme-selector-label",i.textContent="Theme",a.appendChild(i),a.appendChild(V(e,n)),a.appendChild(G(e,n)),t.appendChild(s),t.appendChild(a),n.appendChild(t),n}function X(){try{let n=document.querySelector(".verticalSection .headerUsername")?.closest(".verticalSection");if(!n)return!1;let t=I();return t?(console.log(`${l} Creating theme selector element...`),n.appendChild(Q(t)),console.log(`${l} Successfully injected!`),!0):!1}catch(e){return console.error(`${l} Injection error:`,e),!1}}let Z=()=>!!(document.querySelector(".headerUsername")&&document.querySelector(".lnkUserProfile"));function ee(){let e=document.getElementById(y);e&&e instanceof HTMLElement&&e.dataset.jeThemeUser&&!M(e.dataset.jeThemeUser)&&e.remove(),Z()&&!document.getElementById(y)&&(console.log(`${l} Preferences page detected and selector is missing. Injecting...`),X())}function h(){clearTimeout(u),u=setTimeout(ee,re)}function $(){let e=r();if(!e||typeof e.getCurrentUserId!="function"){console.log(`${l} Waiting for ApiClient...`),setTimeout($,te);return}if(console.log(`${l} ApiClient is available. Starting persistent element monitoring.`),j(),Y(),z(),c&&(c.unsubscribe(),c=null),o.helpers?.onBodyMutation)c=o.helpers.onBodyMutation("theme-selector",h);else{let n=new MutationObserver(h);n.observe(document.body,{childList:!0,subtree:!0}),c={unsubscribe:()=>n.disconnect()}}!m&&o.session&&(m=!0,o.session.onUserChange("theme-selector",()=>{document.getElementById(y)?.remove(),h()}))}return{initialize:$}}var S=R();S&&(F(S,["initializeThemeSelector"]).own.initializeThemeSelector=K(S,()=>A()).initialize);})();
})();
