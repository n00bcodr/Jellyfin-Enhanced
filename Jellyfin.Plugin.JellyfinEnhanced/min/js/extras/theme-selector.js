(() => {
"use strict";(()=>{function R(o,r,d){let l=r.core?.featureContext;if(typeof l!="function")throw new Error(`${o}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);return l(o,r,d)}function N(o,r){return R("chrome",o,{facades:r})}function L(){return window.ApiClient}function A(){return window.JellyfinEnhanced}var h=Object.freeze({Default:"",Aurora:"aurora.css",Banana:"banana.css",Coal:"coal.css",Coral:"coral.css",Forest:"forest.css",Grass:"grass.css",Jellyblue:"jellyblue.css",Jellyflix:"jellyflix.css",Jellypurple:"jellypurple.css",Lavender:"lavender.css","Liquid Glass":"liquidglass.css",Midnight:"midnight.css",Mint:"mint.css",Ocean:"ocean.css",Peach:"peach.css",Watermelon:"watermelon.css"}),a="🪼 Jellyfin Enhanced: Jellyfish Theme Selector:",U="jellyfin-theme-selector-css",y="jellyfin-theme-selector",ee=250,te=1e3,ne=100,f=300,w="jellyfin-theme-applied";function _(o,r){return r?`@import url("${o}${r}");`:""}function J(o,r){for(let[d,l]of Object.entries(h))if(_(o,l)===r)return d;return"Default"}var v="/* Jellyfin Enhanced theme selector: start */",E="/* Jellyfin Enhanced theme selector: end */";function H(o,r){let d=r.indexOf(v),l=d<0?-1:r.indexOf(E,d);if(l>=0)return{theme:J(o,r.slice(d+v.length,l).trim()),rest:r.slice(0,d)+r.slice(l+E.length).replace(/^\n/,"")};let u=r.indexOf(`
`),m=J(o,(u<0?r:r.slice(0,u)).trim());return{theme:m,rest:m==="Default"?r:u<0?"":r.slice(u+1)}}function re(o,r){return!r||!o?r||o:`${v}
${r}
${E}
${o}`}function oe(o){return o.toISOString().split("T")[0]??""}function z(o,r){let d=o.cdn.url("jellyfish","colors/"),l=null,u,m=!1,b=(e,n)=>`${e}-${n}`;function g(e,n,t=null){try{let i=localStorage.getItem(b(e,n));return i===null?t:i}catch(i){return console.error("🪼 Jellyfin Enhanced: Theme selector storage read error",i),t}}function C(e,n,t){try{return localStorage.setItem(b(e,n),t),!0}catch(i){return console.error("🪼 Jellyfin Enhanced: Theme selector storage write error",i),!1}}function W(e,n){try{return localStorage.removeItem(b(e,n)),!0}catch(t){return console.error(`${a} localStorage remove error:`,t),!1}}let x=e=>g(e,"randomThemeEnabled")==="true";function T(){try{let e=r()?.getCurrentUserId?.();if(typeof e=="string"&&e.trim()!=="")return e}catch(e){console.error(`${a} Error extracting user ID:`,e)}return console.error(`${a} Could not extract user ID`),null}function I(e){try{return r()?.getCurrentUserId?.()===e}catch{return!1}}function k(e,n,t="Default"){let i=re(H(d,g(e,"customCss","")??"").rest,_(d,n));i?C(e,"customCss",i):W(e,"customCss"),console.log(n?`${a} Theme set to: ${t}`:`${a} Theme cleared (default)`)}function j(e){let n=window;try{n.Dashboard?.alert?n.Dashboard.alert(e):n.require?n.require(["toast"],t=>t(e)):console.log(`${a} Notification: ${e}`)}catch(t){console.error(`${a} Failed to show notification:`,t)}}function q(){try{let e=sessionStorage.getItem(w);e&&(sessionStorage.removeItem(w),setTimeout(()=>j(`Theme applied: ${e}`),te))}catch(e){console.error(`${a} Session storage error:`,e)}}function O(e,n){try{sessionStorage.setItem(w,e)}catch(t){console.error(`${a} ${n}`,t)}}function B(){let e=T();if(!e||!x(e))return;let n=oe(new Date);if(n===g(e,"lastRandomThemeDate")){console.log(`${a} Random theme already applied for today.`);return}console.log(`${a} New day detected! Applying a random theme.`);let t=Object.keys(h).filter(c=>c!=="Default"),i=t[Math.floor(Math.random()*t.length)]??"Default";k(e,h[i]??"",i),C(e,"lastRandomThemeDate",n),O(`Random Daily (${i})`,"Could not set session storage:"),window.location.reload()}function K(){if(document.getElementById(U))return;let e=document.createElement("style");e.id=U,e.textContent=`
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
        `,document.head.appendChild(e),console.log(`${a} Custom CSS injected`)}function $(e,n="material-icons"){let t=document.createElement("span");return t.className=n,t.textContent=e,t.setAttribute("aria-hidden","true"),t}function P(e,n){return I(e)?!0:(console.warn(`${a} Signed-in user changed; discarding the previous user's selector.`),n.remove(),p(),!1)}function Y(e,n){let t=document.createElement("select");t.setAttribute("is","emby-select"),t.className="emby-select-withcolor emby-select",t.id="theme-selector-select",t.setAttribute("aria-label","Select theme"),t.removeAttribute("label");let i=H(d,g(e,"customCss","")??"").theme;for(let c of Object.keys(h)){let s=document.createElement("option");s.value=c,s.textContent=c,c===i&&(s.selected=!0),t.appendChild(s)}return t.addEventListener("change",c=>{if(c.preventDefault(),c.stopPropagation(),!P(e,n))return;let s=t.value,F=h[s];if(F===void 0)return;t.disabled=!0;let M=document.getElementById("random-theme-button");M instanceof HTMLButtonElement&&(M.disabled=!0),document.body.classList.add("theme-applying"),k(e,F,s),O(s,"Session storage error:"),setTimeout(()=>{console.log(`${a} Reloading to apply theme: ${s}`),window.location.reload()},f)}),t}function G(e,n){let t=document.createElement("button");t.setAttribute("is","emby-button"),t.className="emby-button",t.id="random-theme-button",t.setAttribute("aria-label","Toggle random daily theme"),t.setAttribute("title","Random daily theme");let i=document.createElement("span");i.style.fontSize="0.85em";let c=()=>{let s=x(e);t.classList.toggle("active",s),i.textContent=s?"Daily":"",t.setAttribute("aria-pressed",s.toString())};return t.appendChild($("shuffle")),t.appendChild(i),c(),t.addEventListener("click",()=>{if(!P(e,n))return;let s=!x(e);C(e,"randomThemeEnabled",String(s)),j(`Random daily theme turned ${s?"ON":"OFF"}.`),console.log(`${a} Random daily theme set to: ${s}`),c(),s&&B()}),t}function V(e){let n=document.createElement("div");n.className="theme-selector-container listItem-border",n.id=y,n.dataset.jeThemeUser=e;let t=document.createElement("div");t.className="listItem",t.id="theme-selector-item";let i=$("palette","material-icons listItemIcon listItemIcon-transparent");i.id="theme-selector-icon";let c=document.createElement("div");c.className="listItemBody",c.id="theme-selector-body";let s=document.createElement("div");return s.className="listItemBodyText",s.id="theme-selector-label",s.textContent="Theme",c.appendChild(s),c.appendChild(G(e,n)),c.appendChild(Y(e,n)),t.appendChild(i),t.appendChild(c),n.appendChild(t),n}function Q(){try{let n=document.querySelector(".verticalSection .headerUsername")?.closest(".verticalSection");if(!n)return!1;let t=T();return t?(console.log(`${a} Creating theme selector element...`),n.appendChild(V(t)),console.log(`${a} Successfully injected!`),!0):!1}catch(e){return console.error(`${a} Injection error:`,e),!1}}let X=()=>!!(document.querySelector(".headerUsername")&&document.querySelector(".lnkUserProfile"));function Z(){let e=document.getElementById(y);e&&e instanceof HTMLElement&&e.dataset.jeThemeUser&&!I(e.dataset.jeThemeUser)&&e.remove(),X()&&!document.getElementById(y)&&(console.log(`${a} Preferences page detected and selector is missing. Injecting...`),Q())}function p(){clearTimeout(u),u=setTimeout(Z,ne)}function D(){let e=r();if(!e||typeof e.getCurrentUserId!="function"){console.log(`${a} Waiting for ApiClient...`),setTimeout(D,ee);return}if(console.log(`${a} ApiClient is available. Starting persistent element monitoring.`),B(),K(),q(),l&&(l.unsubscribe(),l=null),o.helpers?.onBodyMutation)l=o.helpers.onBodyMutation("theme-selector",p);else{let n=new MutationObserver(p);n.observe(document.body,{childList:!0,subtree:!0}),l={unsubscribe:()=>n.disconnect()}}!m&&o.session&&(m=!0,o.session.onUserChange("theme-selector",()=>{document.getElementById(y)?.remove(),p()}))}return{initialize:D}}var S=A();S&&(N(S,["initializeThemeSelector"]).own.initializeThemeSelector=z(S,()=>L()).initialize);})();
})();
