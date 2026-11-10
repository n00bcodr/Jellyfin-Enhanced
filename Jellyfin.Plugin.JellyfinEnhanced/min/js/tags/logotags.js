(() => {
"use strict";(()=>{function g(s){let a=window.JellyfinEnhanced?.core?.sharedModules?.[s];if(!a)throw new Error(`${s} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return a}function l(s,a){return s[a]}var h=g("features/media-tags/host"),b=l(h,"apiClient"),k=l(h,"hasApiClient");var E=l(h,"tagRuntimeHost");var O=g("features/media-tags/pipeline/dto");var S=l(O,"isRecord");var R=l(O,"record");function F(s){let a="🪼 Jellyfin Enhanced: Logos Tags:",u="logo-overlay-container",i="je-logo-chip",p="je-logo-img",M=new Set(["provider","network","studio"]),y=/^\/[A-Za-z0-9_-]{1,80}\.(?:png|jpe?g|webp)$/,c=new Map,P=300*1e3,A=500;function $(e){let t=c.get(e);return t===void 0?!1:Date.now()-t<P?!0:(c.delete(e),!1)}let w=!1;function j(e){let t=String(e||"").trim();if(t.length<=12)return t;let n=t.split(/[\s\-–—/&+]+/).filter(o=>/[\p{L}\p{N}]/u.test(o));return n.length>=2?n.slice(0,4).map(o=>(o.match(/[\p{L}\p{N}]/u)||[""])[0].toUpperCase()).join(""):`${t.slice(0,11)}…`}function C(e){if(typeof e!="string"||!y.test(e))return null;let t=`JellyfinEnhanced/logo/w92${e}`;return k()&&typeof b().getUrl=="function"?b().getUrl(t):`/${t}`}function d(e){if(!Array.isArray(e))return[];let t=[];for(let n of e){let o=R(n),r=String(o.kind??o.Kind??""),L=String(o.name??o.Name??"").trim();if(!M.has(r)||!L)continue;let x=o.logo??o.Logo;if(t.push({kind:r,name:L,logo:typeof x=="string"&&y.test(x)?x:null}),t.length===2)break}return t}function T(e,t){e.textContent=j(t),e.dataset.jeLogoStyle="text",e.classList.add("je-logo-text"),e.removeAttribute("role"),e.removeAttribute("aria-label")}function v(e,t){let n=document.createElement("span");n.className=i,n.dataset.jeLogoKind=e.kind,n.title=e.name;let o=t||C(e.logo);if(!o||$(o))return T(n,e.name),n;n.dataset.jeLogoStyle=e.kind==="provider"?"provider":"company";let r=document.createElement("img");return r.className=p,r.alt=e.name,r.decoding="async",r.draggable=!1,r.src=o,n.appendChild(r),n}function N(){w||typeof document.addEventListener!="function"||(w=!0,document.addEventListener("error",e=>{let t=e.target;if(!(t instanceof HTMLImageElement)||!t.classList.contains(p))return;let n=t.getAttribute("src")||"";c.delete(n),c.set(n,Date.now()),c.size>A&&c.delete(c.keys().next().value??"");let o=t.closest(`.${i}`);o&&T(o,t.alt)},!0))}function f(e,t,n){if(!n.length)return;e.removeExistingOverlay(t);let o=document.createElement("div");o.className=u;for(let r of n)o.appendChild(v(r));e.commitOverlay(t,o)}let m={logPrefix:a,settingKey:"logoTagsEnabled",containerClass:u,taggedAttr:"jeLogoTagged",styleId:"jellyfin-enhanced-logo-tags-css",position:{userKey:"logoTagsPosition",pluginKey:"LogoTagsPosition",fallback:"bottom-left"},cache:{key:"JellyfinEnhanced-logoTagsCache",legacyPrefix:"logoTagsCache",hotBucket:"logos",saveOnUnload:!1},buildCss(){return`
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
            `},pipeline:{needsFirstEpisode:!1,needsParentSeries:!1,render(e,t,n){if(e.shouldIgnore(t)||e.isTagged(t)||t.closest(".je-hidden"))return;let o=d(n.Logos),r={l:o};e.setPersistent(String(n.Id),r),e.hot?.set(String(n.Id),r),f(e,t,o)},renderFromCache(e,t,n){if(e.isTagged(t)||e.shouldIgnore(t)||t.closest(".je-hidden"))return!0;let o=e.getPersistent(n)??e.hot?.get(n);return!S(o)||!Array.isArray(o.l)?!1:(f(e,t,d(o.l)),!0)},renderFromServerCache(e,t,n){e.isTagged(t)||e.shouldIgnore(t)||f(e,t,d(n?.Logos))}}};s.initializeLogoTags=function(){console.log(`${a} Starting...`),N(),s.core.tagRenderer.register("logos",m).injectCss(),console.log(`${a} Initialized successfully.`)},s.reinitializeLogoTags=function(){s.core.tagRenderer.reinitialize("logos",m)},s.logoTags={buildChip:v,readLogos:d,shortName:j,logoUrl:C},s.core.tagRenderer.registerStyles(m)}F(E());})();
})();
