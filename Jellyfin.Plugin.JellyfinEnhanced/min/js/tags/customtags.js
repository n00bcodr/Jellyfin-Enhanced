(() => {
"use strict";(()=>{function x(o){let i=window.JellyfinEnhanced?.core?.sharedModules?.[o];if(!i)throw new Error(`${o} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return i}function h(o,i){return o[i]}var P=x("features/media-tags/host");var R=h(P,"tagRuntimeHost");var $=x("features/media-tags/pipeline/dto");var b=h($,"isRecord");function S(o){let i="🪼 Jellyfin Enhanced: Custom Tags:",m="custom-overlay-container",a="custom-tag",y=["theaters","sports_martial_arts","explore","animation","mood","local_police","article","theater_comedy","family_restroom","auto_awesome","history_edu","skull","music_note","psychology_alt","favorite","science","tv","psychology","military_tech","landscape","domino_mask","music_video","menu_book","sports_soccer","quiz","live_tv"];function d(e,t){if(!b(e))return;if(e[t]!==void 0&&e[t]!==null)return e[t];let n=t.charAt(0).toUpperCase()+t.slice(1);return e[n]??void 0}let l=null;function f(){let e=o.pluginConfig?.CustomTagRules,t=o.pluginConfig?.CustomTagRuleSources;if(l&&l.source===e&&l.sources===t)return l;let n=new Map;for(let s of Array.isArray(t)?t:[]){let c=String(d(s,"id")||""),g=String(d(s,"match")||"").toLowerCase(),p=String(d(s,"value")||"").trim();c&&(g==="tag"||g==="collection")&&p&&n.set(c,{match:g,value:p})}let r=new Map;for(let s of Array.isArray(e)?e:[]){let c=String(d(s,"id")||""),g=String(d(s,"label")||"").trim();if(!c||!g||r.has(c))continue;let p=String(d(s,"icon")||"").toLowerCase(),T=n.get(c);r.set(c,{id:c,label:g,icon:y.includes(p)?p:null,match:T?.match??null,value:T?.value??null})}let u=[...r.keys()].sort().join(`
`);return l={source:e,sources:t,rules:r,key:u},l}function v(e){if(!Array.isArray(e)||e.length===0)return[];let t=new Set(e.map(String)),n=[];for(let[r,u]of f().rules)t.has(r)&&n.push(u);return n}function k(e){if(!e.match||!e.value)return e.label;let t=o.t(e.match==="collection"?"custom_tags_source_collection":"custom_tags_source_tag",{name:e.value});return`${e.label}
${t}`}function j(e){let t=document.createElement("div");if(t.className=e.icon?`${a} ${a}--icon`:a,t.dataset.jeCustom=e.label,t.dataset.jeCustomRule=e.id,t.title=k(e),e.icon){let r=document.createElement("span");r.className=`${a}-icon`,r.setAttribute("aria-hidden","true"),r.textContent=e.icon,t.appendChild(r)}let n=document.createElement("span");return n.className=`${a}-text`,n.textContent=e.label,t.appendChild(n),t}function C(e,t,n){let r=v(n);if(r.length===0)return;e.removeExistingOverlay(t);let u=document.createElement("div");u.className=m;for(let s of r)u.appendChild(j(s));e.commitOverlay(t,u)}function O(e,t){let n=e.hot?.get(t)??e.getPersistent(t);return b(n)&&n.r===f().key&&Array.isArray(n.ids)?n.ids.map(String):(n!==void 0&&e.deletePersistent(t),null)}function M(e,t,n){e.setPersistent(t,{ids:Array.isArray(n)?n.map(String):[],r:f().key,timestamp:Date.now()})}let w={logPrefix:i,settingKey:"customTagsEnabled",containerClass:m,taggedAttr:"jeCustomTagged",styleId:"jellyfin-enhanced-custom-tags-css",position:{userKey:"customTagsPosition",pluginKey:"CustomTagsPosition",fallback:"top-left"},cache:{key:"JellyfinEnhanced-customTagsCache",legacyPrefix:"customTagsCache",hotBucket:"custom",pruneOnSave:!0,saveOnUnload:!1},buildCss(){return`
                .${m} {
                    display: flex;
                    flex-direction: column;
                    align-items: flex-start;
                    gap: calc(3px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                    z-index: 10;
                    pointer-events: none;
                    max-width: calc(100% - 12px);
                }
                .je-tag-slot > .${m} { max-width: 100%; }

                .${a} {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.3em;
                    box-sizing: border-box;
                    padding: calc(4px * var(--je-tag-scale, 1)) calc(8px * var(--je-tag-scale, 1));
                    background-color: rgba(38, 50, 56, 0.88);
                    color: #ffffff;
                    border: 1px solid rgba(255, 255, 255, 0.22);
                    border-radius: 4px;
                    font-size: calc(13px * var(--je-tag-scale, 1));
                    font-weight: 600;
                    line-height: 1.15;
                    letter-spacing: 0.01em;
                    text-transform: none;
                    text-shadow: 0 0 2px rgba(0, 0, 0, 0.6);
                    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    max-width: 100%;
                    pointer-events: none;
                }
                .${a}-text { overflow: hidden; text-overflow: ellipsis; }
                .${a}-icon {
                    font-family: 'JE Material Symbols Outlined';
                    font-weight: normal;
                    font-style: normal;
                    font-size: 1.2em;
                    line-height: 1;
                    letter-spacing: normal;
                    text-transform: none;
                    flex-shrink: 0;
                    white-space: nowrap;
                    word-wrap: normal;
                    direction: ltr;
                    -webkit-font-feature-settings: 'liga';
                    -webkit-font-smoothing: antialiased;
                }

                /* Card-width sizing, matching the age rating and status chips. */
                @supports (container-type: inline-size) {
                    html:not(.layout-mobile) .je-tag-host .${a} {
                        font-size: calc(clamp(9px, 6.8cqw, 13px) * var(--je-tag-scale, 1));
                        padding: calc(clamp(2px, 2cqw, 4px) * var(--je-tag-scale, 1)) calc(clamp(4px, 4.5cqw, 8px) * var(--je-tag-scale, 1));
                    }
                }
                .layout-mobile .${a} { padding: calc(2px * var(--je-tag-scale, 1)) calc(6px * var(--je-tag-scale, 1)); font-size: calc(11px * var(--je-tag-scale, 1)); border-radius: 3px; }
                @media (max-width: 768px) {
                    .${a} { padding: calc(3px * var(--je-tag-scale, 1)) calc(6px * var(--je-tag-scale, 1)); font-size: calc(12px * var(--je-tag-scale, 1)); }
                }
                @media (max-width: 480px) {
                    .${a} { padding: calc(2px * var(--je-tag-scale, 1)) calc(4px * var(--je-tag-scale, 1)); font-size: calc(clamp(10px, 2vw, 11px) * var(--je-tag-scale, 1)); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4); }
                }

                /* Caption strip and the minimal corner: the other chips' smaller size. */
                .je-tag-caption .${a} {
                    font-size: calc(clamp(9px, 6.4cqw, 11.5px) * var(--je-tag-scale, 1));
                    padding: calc(2px * var(--je-tag-scale, 1)) calc(5px * var(--je-tag-scale, 1));
                    border-radius: 3px;
                    box-shadow: none;
                }
                html .je-tag-host > .je-tag-slot[data-je-slot="corner"] .${a} { font-size: calc(11px * var(--je-tag-scale, 1)); padding: calc(2px * var(--je-tag-scale, 1)) calc(5px * var(--je-tag-scale, 1)); }
            `},pipeline:{needsFirstEpisode:!1,needsParentSeries:!1,render(e,t,n){e.shouldIgnore(t)||e.isTagged(t)||t.closest(".je-hidden")||(M(e,String(n.Id),n.CustomTags),C(e,t,n.CustomTags))},renderFromCache(e,t,n){if(e.isTagged(t)||e.shouldIgnore(t)||t.closest(".je-hidden"))return!0;let r=O(e,n);return r?(C(e,t,r),!0):!1},renderFromServerCache(e,t,n){e.isTagged(t)||e.shouldIgnore(t)||C(e,t,n.CustomTags)},onServerCacheRefresh(e,t){if(!t){e.clearPersistent(),e.hot?.clear();return}for(let n of t)e.deletePersistent(String(n)),e.hot?.delete(String(n))}}};o.initializeCustomTags=function(){console.log(`${i} Starting...`),o.core.tagRenderer.register("custom",w).injectCss(),console.log(`${i} Initialized successfully.`)},o.reinitializeCustomTags=function(){l=null,o.core.tagRenderer.reinitialize("custom",w)},o.customTags={ICONS:y,rulesFor:v,currentRules:f,buildChip:j},o.core.tagRenderer.registerStyles(w)}S(R());})();
})();
