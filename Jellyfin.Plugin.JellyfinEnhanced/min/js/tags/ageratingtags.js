(() => {
"use strict";(()=>{function f(s){let o=window.JellyfinEnhanced?.core?.sharedModules?.[s];if(!o)throw new Error(`${s} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return o}function d(s,o){return s[o]}var z=f("features/media-tags/host");var j=d(z,"mediaTagsContext");var v=f("features/media-tags/pipeline/dto");var R=d(v,"isRecord");var p=d(v,"text");function O(s){let o=s.core,g="🪼 Jellyfin Enhanced: Age Rating Tags:",x="age-rating-overlay-container",i="age-rating-tag",y="jellyfin-enhanced-age-rating-colours-css",c=null;function m(e){if(e==null)return null;let t=String(e).replace(/\s+/g," ").trim();if(!t)return null;let n=o.normalizeOfficialRating;return p(typeof n=="function"?n(t):t)}function T(e){let t=e.replace(/\/\*[\s\S]*?\*\//g,""),n=[],r=/([^{}]+)\{([^{}]*)\}/g,a;for(;(a=r.exec(t))!==null;){let[,u="",P=""]=a,w=u.split(",").map(l=>l.trim()).filter(l=>l.startsWith(".mediaInfoOfficialRating[rating=")).map(l=>l.replace(".mediaInfoOfficialRating",`.${i}`));if(w.length===0)continue;let F=P.replace(/\s*!important/g,"").trim();n.push(`${w.join(`,
`)} { ${F} }`)}return n.join(`
`)}function C(){return c||(document.getElementById(y)?c=Promise.resolve():(c=(async()=>{try{let e=await fetch(o.cdn.url("je-css","ratings.css"));if(!e.ok)throw new Error(`HTTP ${e.status}`);let t=T(await e.text());if(!t)throw new Error("no [rating=] rules found");o.core.ui.injectCss(y,t)}catch(e){console.warn(`${g} Could not load rating colours, badges will use the default colour.`,e),c=null}})(),c))}function S(e){if(!e)return!1;try{let t=o.pluginConfig;if(!t||t.SpoilerBlurEnabled!==!0||t.SpoilerStripRatings===!1)return!1;let n=s.peer("spoilerBlur");return!n||typeof n.isEnabledFor!="function"||(typeof n.getUserPrefs=="function"&&n.getUserPrefs()||{}).HideRatings===!1?!1:typeof n.isLoadOk=="function"&&n.isLoadOk()!==!0?!0:n.isEnabledFor(e)===!0}catch{return!0}}function E(e,t){let n=e.getPersistent(t)??e.hot?.get(t);return R(n)?{rating:p(n.rating),seriesId:p(n.s)}:null}function k(e,t,n,r){let a=r?{rating:n,s:r}:{rating:n};e.setPersistent(t,a),e.hot?.set(t,a)}function h(e,t,n){if(!n)return;e.removeExistingOverlay(t);let r=document.createElement("div");r.className=x;let a=document.createElement("div");a.className=i,a.setAttribute("rating",n),a.textContent=n,r.appendChild(a),e.commitOverlay(t,r)}let b={logPrefix:g,settingKey:"ageRatingTagsEnabled",containerClass:x,taggedAttr:"jeAgeRatingTagged",styleId:"jellyfin-enhanced-age-rating-tags-css",position:{userKey:"ageRatingTagsPosition",pluginKey:"AgeRatingTagsPosition",fallback:"bottom-right"},cache:{key:"JellyfinEnhanced-ageRatingTagsCache",legacyPrefix:"ageRatingTagsCache",hotBucket:"ageRating",saveOnUnload:!1},buildCss(){return`
                .${x} {
                    display: flex;
                    flex-direction: column;
                    align-items: flex-end;
                    z-index: 10;
                    pointer-events: none;
                    max-width: calc(100% - 12px);
                }

                .${i} {
                    display: inline-flex;
                    align-items: center;
                    padding: calc(4px * var(--je-tag-scale, 1)) calc(8px * var(--je-tag-scale, 1));
                    /* Neutral fallback, same as the Colored Ratings default, until a
                       [rating=...] rule matches (or if the colour sheet fails to load). */
                    background-color: #607D8B;
                    color: #ffffff;
                    border: 1px solid rgba(255, 255, 255, 0.25);
                    border-radius: 4px;
                    font-size: calc(13px * var(--je-tag-scale, 1));
                    font-weight: 700;
                    line-height: 1;
                    letter-spacing: 0.02em;
                    text-transform: uppercase;
                    text-shadow: 0 0 2px rgba(0, 0, 0, 0.6);
                    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
                    white-space: nowrap;
                    pointer-events: none;
                }

                /* Card-width sizing, matching the rating tag rules in tag-pipeline.js */
                @supports (container-type: inline-size) {
                    html:not(.layout-mobile) .je-tag-host .${i} {
                        font-size: calc(clamp(9px, 6.8cqw, 13px) * var(--je-tag-scale, 1));
                        padding: calc(clamp(2px, 2cqw, 4px) * var(--je-tag-scale, 1)) calc(clamp(4px, 4.5cqw, 8px) * var(--je-tag-scale, 1));
                    }
                }

                .layout-mobile .${i} {
                    padding: calc(2px * var(--je-tag-scale, 1)) calc(6px * var(--je-tag-scale, 1));
                    font-size: calc(11px * var(--je-tag-scale, 1));
                    border-radius: 3px;
                }

                @media (max-width: 768px) {
                    .${i} { padding: calc(3px * var(--je-tag-scale, 1)) calc(6px * var(--je-tag-scale, 1)); font-size: calc(12px * var(--je-tag-scale, 1)); }
                }

                @media (max-width: 480px) {
                    .${i} { padding: calc(2px * var(--je-tag-scale, 1)) calc(4px * var(--je-tag-scale, 1)); font-size: calc(clamp(10px, 2vw, 11px) * var(--je-tag-scale, 1)); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4); }
                }
            `},pipeline:{needsFirstEpisode:!1,needsParentSeries:!1,render(e,t,n,r){if(e.shouldIgnore(t)||e.isTagged(t)||t.closest(".je-hidden"))return;let a=m(n.OfficialRating)??m(r?.parentSeries?.OfficialRating),u=n.Type==="Episode"||n.Type==="Season";(!u||n.SeriesId)&&k(e,String(n.Id),a,u?String(n.SeriesId):null),h(e,t,a)},renderFromCache(e,t,n){if(e.isTagged(t)||e.shouldIgnore(t)||t.closest(".je-hidden"))return!0;let r=E(e,n);return!r||S(r.seriesId)?!1:(h(e,t,r.rating),!0)},renderFromServerCache(e,t,n){e.isTagged(t)||e.shouldIgnore(t)||h(e,t,m(n.OfficialRating))}}};o.initializeAgeRatingTags=function(){console.log(`${g} Starting...`),o.core.tagRenderer.register("agerating",b).injectCss(),C(),console.log(`${g} Initialized successfully.`)},o.reinitializeAgeRatingTags=function(){o.core.tagRenderer.reinitialize("agerating",b),C()},o.core.tagRenderer.registerStyles(b)}O(j());})();
})();
