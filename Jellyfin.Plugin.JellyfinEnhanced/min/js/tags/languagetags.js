(() => {
"use strict";(()=>{function j(i){let C=window.JellyfinEnhanced?.core?.sharedModules?.[i];if(!C)throw new Error(`${i} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return C}function b(i,C){return i[C]}var Q=j("features/media-tags/host");var H=b(Q,"tagRuntimeHost");var w=j("features/media-tags/pipeline/dto");var U=b(w,"isRecord"),$=b(w,"memberRecord"),K=b(w,"memberText"),h=b(w,"members");var T=b(w,"record");function W(i){return i.tagName==="IMG"}function E(i){let C="🪼 Jellyfin Enhanced: Language Tags:",y="language-overlay-container",x="language-flag",k="language-flag-partial",G=new Intl.DisplayNames(["en"],{type:"language"}),A=new Map;function L(e){let a=A.get(e);if(a===void 0){try{a=G.of(e)||e.toUpperCase()}catch{a=e.toUpperCase()}A.set(e,a)}return a}function F(e,a="Audio"){if(!e)return[];let r=new Set,t=function(n){h(n).map($).filter(function(o){return o.Type===a&&!(a==="Audio"?i.core.mediaLanguage.isSecondaryAudio(o):o.IsForced===!0)}).forEach(function(o){let s=o.Language;typeof s=="string"&&s&&!i.core.mediaLanguage.isLanguageless(s)&&r.add(JSON.stringify({name:L(s),code:s,sdh:a==="Subtitle"&&(o.IsHearingImpaired===!0||/\b(SDH|CC)\b/i.test(`${String(o.Title||"")} ${String(o.DisplayTitle||"")}`))}))})};return h(e.MediaSources).forEach(function(n){t($(n).MediaStreams)}),t(e.MediaStreams),P(Array.from(r,n=>JSON.parse(n)))}function q(e,a){let r=F(e,"Subtitle"),t=e.SubtitleLanguages||a.SubtitleLanguages;if(!t)return r;let n=h(e.SdhSubtitleLanguages||a.SdhSubtitleLanguages||r.filter(o=>o.sdh).map(o=>o.code));return h(t).map(o=>({code:o,sdh:n.some(s=>i.core.mediaLanguage.matchesLanguage(o,s,{requireRegion:!0}))}))}function P(e){if(!Array.isArray(e))return[];let a=[],r=new Set;for(let t of e){let n=null;if(!t)continue;if(typeof t=="string"){let s=t.toLowerCase();n={name:L(s),code:s}}else if(U(t)){let s=String(t.code||t.Code||""),c=String(t.name||t.Name||"")||null;s&&(n={name:c||L(s),code:s},t.partial&&(n.partial=!0),t.sdh&&(n.sdh=!0))}if(!n)continue;let o=`${n.code.toLowerCase()}|${(n.name||"").toLowerCase()}`;if(!r.has(o))r.add(o),a.push(n);else if(n.sdh){let s=a.find(c=>`${c.code.toLowerCase()}|${(c.name||"").toLowerCase()}`===o);s&&(s.sdh=!0)}}return a}function _(e){let a=e.code&&i.core.mediaLanguage?.localName?.(e.code)||e.name;return e.partial?`${a} (${i.t("language_tags_partial_tooltip")})`:a}function V(e){let a=i.core.mediaLanguage.priorityPolicy(),r=a.terms;if(!r.length)return e;let t=i.core.mediaLanguage.matchesLanguage,n=o=>{let s=(o.code||"").toLowerCase(),c=a.personal?o.allCodes.map(g=>O(g)):[s,s.split("-")[0],...o.allLanguages.map(g=>g.toLowerCase())],d=a.personal?[]:o.allCodes,p=-1;for(let g=0;g<r.length&&!(p!==-1&&g>=p);g++){let m=r[g];(c.includes(m)||d.some(D=>t(D,m)))&&(p=g)}return p};return e.map((o,s)=>({flag:o,i:s,rank:n(o)})).filter(o=>!a.strict||o.rank!==-1).sort((o,s)=>{let c=o.rank===-1?r.length:o.rank,d=s.rank===-1?r.length:s.rank;return c-d||o.i-s.i}).map(o=>o.flag)}function I(){let e=(t,n)=>i.currentSettings?.[t]??i.pluginConfig?.[t.charAt(0).toUpperCase()+t.slice(1)]??n,a=String(e("languageTagsStyle","flags")).trim().toLowerCase(),r=String(e("languageTagsCountBadge","off")).trim().toLowerCase();return{audio:e("languageTagsShowAudio",!0)!==!1,subtitles:e("languageTagsShowSubtitles",!1)===!0,style:a==="codes"?"codes":"flags",badge:["only","both"].includes(r)?r:"off"}}function O(e){return i.core.mediaLanguage.canonicalBase(i.core.mediaLanguage.parseLanguageTag(e)?.base??"")}function Y(e){let a=i.core.mediaLanguage.resolveFlag(e);if(a!=null)return a;let r=[e.name,e.code].find(t=>t in Object.prototype);return r===void 0?a:{unrenderable:r}}function R(e,a){let r=new Map;for(let t of P(e)){let n=Y(t),o=i.core.mediaLanguage.displayCode(t.code),s=i.core.mediaLanguage.parseLanguageTag(t.code),c=a==="codes"||n==null,d=c?"code:"+i.core.mediaLanguage.canonicalBase(s?.base??"")+(i.pluginConfig?.LanguageTagsMergeRegions?"":":"+(s?.region||s?.script||"")):typeof n=="object"&&n?`unrenderable:${n.unrenderable}`:n;if(!d||c&&!o)continue;let p=t.name||t.code.toUpperCase(),g=r.get(d);if(!g)r.set(d,{countryCode:n,asCode:c,code:t.code,text:o,partial:!!t.partial,sdh:!!t.sdh,allCodes:[t.code],allLanguages:[p],labels:[_({name:p,code:t.code,partial:t.partial})]});else{g.partial=g.partial&&!!t.partial,g.sdh||(g.sdh=!!t.sdh),g.allCodes.includes(t.code)||g.allCodes.push(t.code),g.allLanguages.includes(p)||g.allLanguages.push(p);let m=_({name:p,code:t.code,partial:t.partial});g.labels.includes(m)||g.labels.push(m)}}return V(Array.from(r.values()).sort((t,n)=>Number(t.partial)-Number(n.partial)))}function B(e,a=3,r=i.core.mediaLanguage.flagSrc){let t=Array.isArray(e)?{audio:e}:T(e),n=I(),o=n.audio?R(t.audio,n.style):[],s=n.subtitles?R(t.subtitles,n.style):[],c=n.audio&&n.badge!=="off"?R(t.audio,"codes").filter(l=>O(l.code)!=="zxx"):[],d=new Set(c.map(l=>O(l.code))).size,p=n.badge!=="off"&&d>=2,g=[];p&&g.push({badge:d===2?"dual":"multi"}),(!p||n.badge!=="only")&&g.push(...o),g.push(...s.map(l=>({...l,subtitle:!0})));let m=document.createElement("div");if(m.className=y,(a>0?g.slice(0,a):g).some(l=>!l.badge&&!l.asCode&&typeof l.countryCode!="string"))return m;for(let l of g){if(!l.badge&&!l.asCode&&typeof l.countryCode!="string")continue;let S=!l.badge&&l.asCode,u=document.createElement(l.badge||l.subtitle||S?"span":"img");if(u.className=l.badge?"language-count-badge language-chip":S?"language-code language-chip":l.subtitle?"language-subtitle language-chip":x,l.partial&&(u.classList.add(k),u.dataset.partial="true"),u.dataset.jeLanguage=l.badge?"countBadge":l.subtitle?"subtitles":"flag",u.tagName!=="IMG"&&(u.dataset.jeLanguageLabel=l.badge||l.text.toLowerCase()),l.badge)u.textContent=i.t(i.core.tagLayout?.VOCABULARY_KEYS.language[`${l.badge}`]??""),u.title=`${i.t("language_tags_count_tooltip",{count:d})}: ${c.flatMap(M=>M.labels).join(", ")}`;else{let M=l.labels.join(", ");u.title=`${i.t(l.subtitle?l.sdh?"language_tags_subtitles_sdh":"jellyseerr_report_issue_type_subtitles":"jellyseerr_report_issue_type_audio")}: ${M}`,u.dataset.langName=l.allLanguages.join(", ");let z=typeof l.countryCode=="string"?l.countryCode:"";if(u.dataset.lang=S?l.text.toLowerCase():z.toLowerCase(),l.subtitle){let f=document.createElement("span");f.className="language-cc",f.textContent=l.sdh?"SDH":"CC",l.sdh&&(u.dataset.jeSdh="true"),f.setAttribute("aria-hidden","true"),u.appendChild(f)}if(S)u.appendChild(document.createTextNode(l.text));else{let f=W(u)?u:document.createElement("img");f.src=r(z),f.className=l.subtitle?x:u.className,f.alt=u.title,f.loading="lazy",f.onerror=()=>u.remove(),l.subtitle&&u.appendChild(f)}}u.tagName!=="IMG"&&u.setAttribute("role","img"),u.setAttribute("aria-label",u.title),m.appendChild(u)}return m}function v(e,a,r){if(!a||e.isTagged(a))return;e.removeExistingOverlay(a),a.style.position!=="relative"&&(a.style.position="relative");let t=i.core.tagLayout?i.core.tagLayout.resolveLayout(a).caps.language:3;e.commitOverlay(a,B(r,t))}i.core.languageTags={readSettings:I,buildGroup:B};let N={logPrefix:C,settingKey:"languageTagsEnabled",containerClass:y,taggedAttr:"jeLanguageTagged",styleId:"language-tags-styles",position:{userKey:"languageTagsPosition",pluginKey:"LanguageTagsPosition",fallback:"bottom-left"},cache:{key:"JellyfinEnhanced-languageTagsCache-v4",legacyPrefix:["JellyfinEnhanced-languageTagsCache-v3","JellyfinEnhanced-languageTagsCache-v2","JellyfinEnhanced-languageTagsCache","languageTagsCache"],hotBucket:"language"},buildCss(){return i.core.tagRenderer.chipBaseCss(".language-chip")+i.core.tagRenderer.chipBaseCss('.language-code:not([data-je-language="subtitles"])',!0)+`
                .${y} {
                    display: flex;
                    flex-direction: column;
                    gap: calc(3px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                    z-index: 101;
                    pointer-events: none;
                    max-height: 90%;
                    overflow: hidden;
                }
                .${x} {
                    width: calc(clamp(24px, 6vw, 32px) * var(--je-tag-scale, 1));
                    height: auto;
                    border-radius: 2px;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.4);
                    flex-shrink: 0;
                    object-fit: cover;
                }
                /* The host is otherwise below Jellyfin's full-card image link.
                   Its empty space remains pointer-transparent; only language
                   chips receive hover through native anchors supplied by the layout. */
                .je-tag-host:has(.${y}) { z-index: 2; }
                .${y} > * { pointer-events: auto; }
                .language-link { display: inline-flex; color: inherit; text-decoration: none; }
                .je-tag-pill[href] { pointer-events: auto; text-decoration: none; }
                .language-chip {
                    display: inline-flex; align-items: center; gap: calc(3px * var(--je-tag-scale, 1));
                    align-self: flex-start; flex-shrink: 0; width: max-content;
                    background: rgba(15,15,15,0.72); color: #fff;
                    font-family: inherit;
                }
                .language-cc { font-size: inherit; }
                .language-subtitle .language-flag { box-shadow: none; }
                /* Dub that doesn't cover every episode: dimmed, washed out and
                   dash-outlined so it reads as "incomplete" next to a full flag.
                   The dark ring keeps the white dashes (and a white flag's edge)
                   visible on light posters. */
                .${k} { opacity: 0.55; }
                img.${k} {
                    opacity: 0.55;
                    filter: saturate(0.5);
                    outline: 1px dashed rgba(255, 255, 255, 0.95);
                    outline-offset: -1px;
                    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6);
                }
                .layout-mobile .${x} {
                    width: calc(clamp(20px, 5vw, 26px) * var(--je-tag-scale, 1));
                }
                .layout-mobile .${y} { gap: calc(2px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1)); }
                @media (max-width: 768px) {
                    .${x} {
                        width: calc(clamp(20px, 5vw, 26px) * var(--je-tag-scale, 1));
                        gap: calc(2px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                    }
                }
                @media (max-width: 480px) {
                    .${x} {
                        width: calc(clamp(16px, 4vw, 20px) * var(--je-tag-scale, 1));
                    }
                    .${y} {
                        gap: calc(2px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                    }
                }
            `},pipeline:{needsFirstEpisode:!0,needsParentSeries:!1,render(e,a,r,t){if(e.shouldIgnore(a)||e.isTagged(a)||a.closest(".je-hidden"))return;let n=String(r.Id),o=T(e.hot?.get(n));if(typeof o.timestamp=="number"&&Date.now()-o.timestamp<e.cacheTtl){o.value&&v(e,a,o.value);return}let s=r;if(r.Type==="Series"||r.Type==="Season")if(t.firstEpisode)s=t.firstEpisode;else return;let c={audio:F(s),subtitles:q(s,r)};e.setPersistent(n,c),e.hot?.set(n,{value:c,timestamp:Date.now()}),v(e,a,c)},renderFromCache(e,a,r){if(e.isTagged(a)||e.shouldIgnore(a)||a.closest(".je-hidden"))return!0;let n=e.hot?.get(r)||e.getPersistent(r);if(n){let o=T(n),s=Array.isArray(n)?n:o.value||o.languages||n;if(s&&!Array.isArray(s))return v(e,a,s),!0}return!1},renderFromServerCache(e,a,r){if(e.isTagged(a)||e.shouldIgnore(a))return;let t=h(r.AudioLanguages),n=new Set(h(r.PartialAudioLanguages)),o=t.map(function(c){let d=K(c);return{name:L(d),code:d,partial:n.has(d)}}),s=h(r.SdhSubtitleLanguages);v(e,a,{audio:o,subtitles:h(r.SubtitleLanguages).map(c=>({code:c,sdh:s.some(d=>i.core.mediaLanguage.matchesLanguage(c,d,{requireRegion:!0}))}))})}}};i.initializeLanguageTags=function(){i.core.tagRenderer.register("language",N)},i.reinitializeLanguageTags=function(){i.core.tagRenderer.reinitialize("language",N)},i.core.tagRenderer.registerStyles(N)}E(H());})();
})();
