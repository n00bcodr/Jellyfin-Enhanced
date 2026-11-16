(() => {
"use strict";(()=>{function g(r){let a=window.JellyfinEnhanced?.core?.sharedModules?.[r];if(!a)throw new Error(`${r} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return a}function l(r,a){return r[a]}var h=g("features/media-tags/host"),b=l(h,"apiClient"),E=l(h,"hasApiClient");var O=l(h,"tagRuntimeHost");var S=g("features/media-tags/pipeline/dto");var F=l(S,"isRecord");var R=l(S,"record");function M(r){let a="🪼 Jellyfin Enhanced: Logos Tags:",u="logo-overlay-container",i="je-logo-chip",p="je-logo-img",P=new Set(["provider","network","studio"]),y=/^\/[A-Za-z0-9_-]{1,80}\.(?:png|jpe?g|webp)$/,c=new Map,A=300*1e3,$=500;function N(e){let t=c.get(e);return t===void 0?!1:Date.now()-t<A?!0:(c.delete(e),!1)}let w=!1;function j(e){let t=String(e||"").trim();if(t.length<=12)return t;let n=t.split(/[\s\-–—/&+]+/).filter(o=>/[\p{L}\p{N}]/u.test(o));return n.length>=2?n.slice(0,4).map(o=>(o.match(/[\p{L}\p{N}]/u)||[""])[0].toUpperCase()).join(""):`${t.slice(0,11)}…`}function C(e){if(typeof e!="string"||!y.test(e))return null;let t=`JellyfinEnhanced/logo/w92${e}`;return E()&&typeof b().getUrl=="function"?b().getUrl(t):`/${t}`}function v(e){if(!Array.isArray(e))return[];let t=[];for(let n of e){let o=R(n),s=String(o.kind??o.Kind??""),k=String(o.name??o.Name??"").trim();if(!P.has(s)||!k)continue;let x=o.logo??o.Logo;t.push({kind:s,name:k,logo:typeof x=="string"&&y.test(x)?x:null})}return t}function d(e){let t=n=>n.logo?n.kind==="provider"?"provider":"company":"text";return v(e).filter(n=>!r.core.tagHidden?.hides("logos",t(n))).slice(0,2)}function T(e,t){e.textContent=j(t),e.dataset.jeLogoStyle="text",e.classList.add("je-logo-text"),e.removeAttribute("role"),e.removeAttribute("aria-label")}function L(e,t){let n=document.createElement("span");n.className=i,n.dataset.jeLogoKind=e.kind,n.title=e.name;let o=t||C(e.logo);if(!o||N(o))return T(n,e.name),n;n.dataset.jeLogoStyle=e.kind==="provider"?"provider":"company";let s=document.createElement("img");return s.className=p,s.alt=e.name,s.decoding="async",s.draggable=!1,s.src=o,n.appendChild(s),n}function z(){w||typeof document.addEventListener!="function"||(w=!0,document.addEventListener("error",e=>{let t=e.target;if(!(t instanceof HTMLImageElement)||!t.classList.contains(p))return;let n=t.getAttribute("src")||"";c.delete(n),c.set(n,Date.now()),c.size>$&&c.delete(c.keys().next().value??"");let o=t.closest(`.${i}`);o&&T(o,t.alt)},!0))}function f(e,t,n){if(!n.length)return;e.removeExistingOverlay(t);let o=document.createElement("div");o.className=u;for(let s of n)o.appendChild(L(s));e.commitOverlay(t,o)}let m={logPrefix:a,settingKey:"logoTagsEnabled",containerClass:u,taggedAttr:"jeLogoTagged",styleId:"jellyfin-enhanced-logo-tags-css",position:{userKey:"logoTagsPosition",pluginKey:"LogoTagsPosition",fallback:"bottom-left"},cache:{key:"JellyfinEnhanced-logoTagsCache",legacyPrefix:"logoTagsCache",hotBucket:"logos",saveOnUnload:!1},buildCss(){return`
                .${u} {
                    display: flex;
                    flex-direction: column;
                    align-items: flex-start;
                    gap: calc(4px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                    z-index: 10;
                    pointer-events: none;
                    max-width: calc(100% - 12px);
                }

                .${i} {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    box-sizing: border-box;
                    height: calc(28px * var(--je-tag-scale, 1));
                    max-width: 100%;
                    padding: calc(3px * var(--je-tag-scale, 1)) calc(6px * var(--je-tag-scale, 1));
                    overflow: hidden;
                    background-color: rgba(0, 0, 0, 0.6);
                    color: #ffffff;
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    border-radius: 4px;
                    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
                    font-size: calc(12px * var(--je-tag-scale, 1));
                    font-weight: 700;
                    line-height: 1;
                    letter-spacing: 0.02em;
                    white-space: nowrap;
                    pointer-events: none;
                }

                .${i}[data-je-logo-style="provider"] { padding: calc(2px * var(--je-tag-scale, 1)); }

                .${i}[data-je-logo-style="company"] {
                    background-color: rgba(255, 255, 255, 0.9);
                    color: #111111;
                    border-color: rgba(0, 0, 0, 0.12);
                }

                .${i}[data-je-logo-style="text"] {
                    background-color: rgba(0, 0, 0, 0.75);
                    border-color: rgba(255, 255, 255, 0.25);
                    text-shadow: 0 0 2px rgba(0, 0, 0, 0.6);
                }

                .${p} {
                    display: block;
                    height: 100%;
                    width: auto;
                    max-width: calc(72px * var(--je-tag-scale, 1));
                    object-fit: contain;
                    border-radius: 3px;
                }

                /* Card-width sizing, like the age rating chip */
                @supports (container-type: inline-size) {
                    html:not(.layout-mobile) .je-tag-host .${i} {
                        height: calc(clamp(18px, 13cqw, 28px) * var(--je-tag-scale, 1));
                        font-size: calc(clamp(9px, 6.4cqw, 12px) * var(--je-tag-scale, 1));
                    }
                }

                .layout-mobile .${i} { height: calc(22px * var(--je-tag-scale, 1)); font-size: calc(10px * var(--je-tag-scale, 1)); }
            `},pipeline:{needsFirstEpisode:!1,needsParentSeries:!1,render(e,t,n){if(e.shouldIgnore(t)||e.isTagged(t)||t.closest(".je-hidden"))return;let o={l:v(n.Logos)};e.setPersistent(String(n.Id),o),e.hot?.set(String(n.Id),o),f(e,t,d(o.l))},renderFromCache(e,t,n){if(e.isTagged(t)||e.shouldIgnore(t)||t.closest(".je-hidden"))return!0;let o=e.getPersistent(n)??e.hot?.get(n);return!F(o)||!Array.isArray(o.l)?!1:(f(e,t,d(o.l)),!0)},renderFromServerCache(e,t,n){e.isTagged(t)||e.shouldIgnore(t)||f(e,t,d(n?.Logos))}}};r.initializeLogoTags=function(){console.log(`${a} Starting...`),z(),r.core.tagRenderer.register("logos",m).injectCss(),console.log(`${a} Initialized successfully.`)},r.reinitializeLogoTags=function(){r.core.tagRenderer.reinitialize("logos",m)},r.logoTags={buildChip:L,readLogos:d,shortName:j,logoUrl:C},r.core.tagRenderer.registerStyles(m)}M(O());})();
})();
