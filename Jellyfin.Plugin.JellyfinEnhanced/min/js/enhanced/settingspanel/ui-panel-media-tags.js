(() => {
"use strict";(()=>{function ge(){let e=window;if(!e.JellyfinEnhanced)throw new TypeError("Jellyfin Enhanced must load before the settings panel");return e.JellyfinEnhanced}function me(){let e=Q();if(!e)throw new ReferenceError("ApiClient is not defined");return e}function Q(){return window.ApiClient}function fe(){return Q()?.getCurrentUserId?.()||""}var be=["opacity","scale"],le="data-je-kind-field";function Ie(e,n,a,t,h,j){let{min:y,max:w,step:S}=e.KIND_LOOK_LIMITS[n];return`<span class="je-kind-looks-value"><input type="number" inputmode="numeric" min="${Number(y)}" max="${Number(w)}" step="${Number(S)}" value="${Math.round(a)}" ${j}="${n}" aria-label="${h(t)}"><span aria-hidden="true">%</span></span>`}function Je(e,n,a,t){let h=e.TAG_KINDS.map(y=>{let w=n.name(y),S=t(y.id);return`<tr data-je-kind="${a(y.id)}"><th scope="row">${a(w)}</th>${be.map(H=>`<td>${Ie(e,H,S[H],n.field(w,H),a,le)}</td>`).join("")}
            <td><button type="button" class="je-kind-looks-reset" data-je-kind-act="reset" aria-label="${a(n.reset(w))}" title="${a(n.reset(w))}"><span class="material-icons" aria-hidden="true">restart_alt</span></button></td></tr>`}).join(""),j=be.map(y=>`<td>${Ie(e,y,e.KIND_LOOK_LIMITS[y].fallback,n.field(n.all,y),a,"data-je-kind-all")}</td>`).join("");return`<table class="je-kind-looks-table" data-je-kind-looks>
        <caption class="je-kind-looks-caption">${a(n.caption)}</caption>
        <thead><tr><th scope="col">${a(n.kind)}</th><th scope="col">${a(n.opacity)}</th><th scope="col">${a(n.size)}</th><td></td></tr></thead>
        <tbody>${h}</tbody>
        <tfoot><tr><th scope="row">${a(n.all)}</th>${j}<td></td></tr>
        <tr><td colspan="4"><span class="je-kind-looks-actions"><button type="button" data-je-kind-act="apply">${a(n.apply)}</button><button type="button" data-je-kind-act="reset-all">${a(n.resetAll)}</button></span></td></tr></tfoot>
    </table>`}var et=`
    .je-kind-looks-table { width: 100%; border-collapse: collapse; font-size: 0.9em; }
    .je-kind-looks-caption { caption-side: top; text-align: start; padding-bottom: 6px; opacity: 0.8; }
    .je-kind-looks-table th, .je-kind-looks-table td { padding: 3px 4px; text-align: start; vertical-align: middle; font-weight: normal; }
    .je-kind-looks-table thead th { font-weight: 600; opacity: 0.85; }
    .je-kind-looks-table tbody tr + tr { border-top: 1px solid rgba(255, 255, 255, 0.06); }
    .je-kind-looks-table tfoot tr:first-child { border-top: 1px solid rgba(255, 255, 255, 0.18); }
    .je-kind-looks-table tfoot th { font-weight: 600; }
    .je-kind-looks-value { display: inline-flex; align-items: center; gap: 2px; white-space: nowrap; }
    .je-kind-looks-value input { width: 4.2em; padding: 2px 4px; box-sizing: border-box; font: inherit; color: inherit; background: rgba(0, 0, 0, 0.25); border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 4px; }
    .je-kind-looks-reset { background: none; border: 0; color: inherit; cursor: pointer; opacity: 0.7; padding: 2px; line-height: 1; }
    .je-kind-looks-reset:hover, .je-kind-looks-reset:focus-visible { opacity: 1; }
    .je-kind-looks-reset .material-icons { font-size: 18px; }
    .je-kind-looks-actions { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 6px; }
    .je-kind-looks-actions button { font: inherit; color: inherit; cursor: pointer; padding: 4px 10px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.25); background: rgba(255, 255, 255, 0.06); }
`;function ze(e,n,a){let t=n.valueAsNumber;if(!Number.isFinite(t))return;let{min:h,max:j}=e.KIND_LOOK_LIMITS[a];return Math.min(j,Math.max(h,Math.round(t)))}var De=e=>e==="opacity"||e==="scale";function tt(e,n,a){let t=y=>y?.closest("[data-je-kind-looks]")??null,h=y=>{let w=y.target;if(!(w instanceof HTMLInputElement)||!t(w))return;let S=w.getAttribute(le),H=w.closest("tr")?.getAttribute("data-je-kind");if(!De(S)||!H)return;let P=ze(n,w,S);if(P===void 0)return;let E=y.type==="change";E&&String(P)!==w.value&&(w.value=String(P)),a(O=>({...O,[H]:{...O[H],[S]:P}}),E)},j=y=>{let w=y.target instanceof Element?y.target.closest("button[data-je-kind-act]"):null,S=t(w);if(!w||!S)return;let H=w.getAttribute("data-je-kind-act");if(H==="reset"){let P=w.closest("tr")?.getAttribute("data-je-kind");P&&a(E=>Object.fromEntries(Object.entries(E).filter(([O])=>O!==P)),!0)}else if(H==="reset-all")a(()=>({}),!0);else if(H==="apply"){let P={};for(let E of be){let O=S.querySelector(`input[data-je-kind-all="${E}"]`),Y=O instanceof HTMLInputElement?ze(n,O,E):void 0;Y!==void 0&&(P[E]=Y)}a(()=>Object.fromEntries(n.TAG_KINDS.map(E=>[E.id,{...P}])),!0)}};return e.addEventListener("input",h),e.addEventListener("change",h),e.addEventListener("click",j),()=>{e.removeEventListener("input",h),e.removeEventListener("change",h),e.removeEventListener("click",j)}}function nt(e,n){e.querySelectorAll("[data-je-kind-looks] tr[data-je-kind]").forEach(a=>{let t=n(a.getAttribute("data-je-kind")||"");a.querySelectorAll(`input[${le}]`).forEach(h=>{let j=h.getAttribute(le);h instanceof HTMLInputElement&&De(j)&&h!==document.activeElement&&(h.value=String(t[j]))})})}function oe(e){let n=e.core?.tagLayout;if(!n)throw new TypeError("core/tag-layout.js must load before the Media Tags hub");return n}function at(e){let n=oe(e),a=(h,j)=>e.t(h,j),t=h=>h.replace(/([a-z])([A-Z])/g,"$1 $2").replace(/^./,j=>j.toUpperCase());return{caption:a("tag_kind_looks_desc"),kind:a("tag_kind_looks_kind"),opacity:a("tag_kind_looks_opacity"),size:a("tag_kind_looks_size"),all:a("tag_kind_looks_all"),apply:a("tag_kind_looks_apply_all"),resetAll:a("tag_kind_looks_reset_all"),name(h){let j=h.setting?`panel_settings_ui_quality_tags_${h.setting.replace(/^show|Tag$/g,"").replace(/([a-z])([A-Z])/g,"$1_$2").toLowerCase()}`:n.VOCABULARY_KEYS.group[h.group==="ageRating"?"age_rating":h.group],y=j?a(j):"";return y&&y!==j?y:t(h.id)},field:(h,j)=>a(j==="opacity"?"tag_kind_looks_opacity_for":"tag_kind_looks_size_for",{kind:h}),reset:h=>a("tag_kind_looks_reset",{kind:h})}}function Re(e){let n=oe(e);n.invalidateSettings();let a=n.normalizeSettings().kindLooks;return t=>a[t]??{opacity:n.KIND_LOOK_LIMITS.opacity.fallback,scale:n.KIND_LOOK_LIMITS.scale.fallback}}function it(e){let n=oe(e),a=t=>e.escapeHtml(t);return e.core?.ui?.injectCss?.("je-kind-looks",et),`<section class="je-mth-card je-mth-kind-looks" aria-labelledby="jeMthKindLooksTitle">
        <h4 class="je-mth-card-title" id="jeMthKindLooksTitle">${a(e.t("tag_kind_looks_title"))}</h4>
        ${Je(n,at(e),a,Re(e))}
    </section>`}function je(e,n){let a=oe(n),t=e.querySelector("[data-je-kind-looks-mount]");t&&(t.innerHTML=it(n));let h=()=>nt(e,Re(n)),j=tt(e,a,(y,w)=>{a.promoteLegacySettings(n.currentSettings),n.currentSettings.tagKindLooks=a.kindLooksToWire(y(a.readKindLooks(n.currentSettings.tagKindLooks))),n.currentSettings.tagLayoutSettingsVersion=1,a.invalidateSettings(),n.reinitializeTagLayout?.(),w&&(n.saveUserSettings("settings.json",n.currentSettings),h())});return document.addEventListener("je:tag-layout-changed",h),()=>{j(),document.removeEventListener("je:tag-layout-changed",h)}}function Oe(e){return e.internals=e.internals||{},e.internals.enhancedUi=e.internals.enhancedUi||{}}function ye(e){return e.target instanceof Element?e.target:null}function J(e,n){let a=ye(e)?.closest(n);return a instanceof HTMLElement?a:null}function M(e,n){let a=e.querySelector(n);return a instanceof HTMLElement?a:null}function U(e,n){return Array.from(e.querySelectorAll(n)).filter(a=>a instanceof HTMLElement)}function xe(e){return e instanceof HTMLInputElement||e instanceof HTMLSelectElement||e instanceof HTMLTextAreaElement?e.value:void 0}function _e(e){return(e instanceof HTMLButtonElement||e instanceof HTMLInputElement||e instanceof HTMLSelectElement||e instanceof HTMLTextAreaElement||e instanceof HTMLFieldSetElement||e instanceof HTMLOptionElement)&&e.disabled}function Be(e,n){(e instanceof HTMLElement||e instanceof SVGElement)&&e.focus(n)}function ee(e){return e===null||typeof e=="string"||typeof e=="boolean"?!0:typeof e=="number"?Number.isFinite(e):Array.isArray(e)?e.every(ee):typeof e=="object"?Object.values(e).every(ee):!1}var we=["corners","bands","caption","summary","minimal"],st=e=>we.some(n=>n===e),ke=["default","glass","outline","dark","light","mono","poster"],lt="Jellyfin Enhanced",ot="media-tags",rt="JE_mediaTagsTab:",Ne=[{key:"statusTagsJustAdded",id:"statusTagsJustAddedToggle",fallback:!0,nameKey:"status_tag_just_added",descKey:"panel_media_tags_badge_just_added_desc",chip:["added","added","status_tag_just_added"],windowKey:"panel_media_tags_badge_window_added",windowSetting:"StatusTagsJustAddedDays",windowFallback:7},{key:"statusTagsNewRelease",id:"statusTagsNewReleaseToggle",fallback:!0,nameKey:"panel_media_tags_badge_new_release",descKey:"panel_settings_ui_status_tags_new_release",chip:["new","newMovie","status_tag_new_movie"],windowKey:"panel_media_tags_badge_window_new",windowSetting:"StatusTagsNewReleaseDays",windowFallback:30},{key:"statusTagsTrending",id:"statusTagsTrendingToggle",fallback:!0,nameKey:"recommendations_trending",descKey:"panel_media_tags_badge_trending_desc",chip:["trending","trending","status_tag_trending_today"]},{key:"statusTagsSchedule",id:"statusTagsScheduleToggle",fallback:!0,nameKey:"panel_media_tags_badge_schedule",descKey:"panel_settings_ui_status_tags_schedule",chip:["schedule","airing_today","status_tag_airing_today"]},{key:"statusTagsMilestones",id:"statusTagsMilestonesToggle",fallback:!0,nameKey:"panel_media_tags_badge_milestones",descKey:"panel_settings_ui_status_tags_milestones",chip:["milestone","season_finale","status_tag_season_finale"]},{key:"statusTagsSeriesStatus",id:"statusTagsSeriesStatusToggle",fallback:!1,nameKey:"panel_media_tags_badge_series_status",descKey:"panel_settings_ui_status_tags_series_status",chip:["status","returning","status_tag_returning"]},{key:"statusTagsScenes",id:"statusTagsScenesToggle",fallback:!1,nameKey:"panel_media_tags_badge_scenes",descKey:"panel_settings_ui_status_tags_scenes",chip:["scenes","post_credits","status_tag_post_credits"]},{key:"statusTagsLeaving",id:"statusTagsLeavingToggle",fallback:!1,nameKey:"common_leaving_soon",descKey:"panel_media_tags_badge_leaving_desc",chip:["leaving","leaving","status_tag_leaving_days",{days:5}],requires:"LeavingSoonAvailable",requiresKey:"panel_media_tags_badge_leaving_unavailable"},{key:"statusTagsDirectPlay",id:"statusTagsDirectPlayToggle",fallback:!1,nameKey:"panel_media_tags_badge_direct_play",descKey:"panel_media_tags_badge_direct_play_desc",chip:["playback","direct_play","status_tag_transcode"]}],dt=[{nameKey:"panel_media_tags_server_defaults",descKey:"panel_media_tags_server_defaults_desc",tab:"layout"},{nameKey:"panel_media_tags_server_colours",descKey:"panel_media_tags_server_colours_desc",tab:"colours"},{nameKey:"panel_media_tags_server_cache",descKey:"panel_media_tags_server_cache_desc",tab:"server"},{nameKey:"panel_media_tags_server_native",descKey:"panel_media_tags_server_native_desc",tab:"server"}],pt=e=>e==="quality"||e==="status"||e==="rating"||e==="genre",ct={quality:{background:"rgba(189, 5, 232, 0.95)",color:"#ffffff",border:"transparent"},status:{background:"rgba(15, 15, 15, 0.72)",color:"#ffffff",border:"rgba(255, 255, 255, 0.18)"},rating:{background:"rgba(0, 0, 0, 0.85)",color:"#ffc107",border:"transparent"},genre:{background:"rgba(10, 10, 10, 0.8)",color:"#E0E0E0",border:"rgba(255, 255, 255, 0.2)"}},re="drama",ht={quality:[178,34,34],status:[30,60,140],rating:[20,120,130],genre:[96,40,128]},ut="https://n00bcodr.github.io/Jellyfin-Enhanced/enhanced/tags/",gt={layout:"layouts",groups:"tag-groups-order-position-limits",badges:"badges-and-priority",rules:"rules-and-locked-items",colours:"tag-styles-and-css",server:"server-side-tag-cache"},mt=e=>new Map(Object.entries(gt)).get(e),ft=["default","tight","flush"],bt=["enabled","layout","density","tagScale","tagGap"],R=(e,n)=>e!==null&&typeof e=="object"?Reflect.get(e,n):void 0,jt=e=>{let n={};for(let a of["background","color","border"]){let t=R(e,a);t&&(n[a]=String(t))}return n};function yt(e){let n=y=>(y?.textContent||"").replace(/\s+/g," ").trim(),a=e.getAttribute("aria-label");if(a)return a.trim();let t=e.querySelector?.("[data-je-label]");if(t)return n(t);let h=e instanceof HTMLInputElement||e instanceof HTMLSelectElement||e instanceof HTMLButtonElement||e instanceof HTMLOutputElement||e instanceof HTMLTextAreaElement?e.labels?.[0]:void 0;if(h)return n(h.querySelector("[data-je-label]")||h);let j=e.getAttribute("aria-labelledby");return j?j.split(/\s+/).map(y=>n(document.getElementById(y))).join(" ").trim():n(e)}function xt(e){let n=Oe(e),a=l=>e.escapeHtml(String(l)),t=(l,s)=>a(e.t(l??"",s)),h=(l,s)=>e.t(l??"",s),j=()=>e.helpers?.isAdmin?e.helpers.isAdmin():e.currentSettings?.isAdmin===!0,y=()=>e.pluginConfig?.TagStylesAllowUserPreset===!0,w=()=>{let l=e.core?.tagLayout;if(!l)throw new TypeError("The tag layout controller is unavailable");return l},S=()=>w().VOCABULARY_KEYS;function H(){let l=[{id:"layout",nameKey:"common_layout",icon:"view_quilt"},{id:"groups",nameKey:"common_groups",icon:"label"},{id:"badges",nameKey:"panel_media_tags_tab_badges",shortKey:"common_badges",icon:"new_releases"},{id:"rules",nameKey:"panel_media_tags_tab_rules",shortKey:"common_rules",icon:"rule"}];return(y()||j())&&l.push({id:"colours",nameKey:"common_colours",icon:"palette"}),j()&&l.push({id:"server",nameKey:"common_server",admin:!0,icon:"dns"}),l}function P(l,s){let u=e.currentSettings?.[l];if(typeof u=="boolean")return u;let d=e.pluginConfig?.[l.charAt(0).toUpperCase()+l.slice(1)];return typeof d=="boolean"?d:s}function E(l){return`${`${window.location.origin}${window.location.pathname}`}#/configurationpage?name=${encodeURIComponent(lt)}&jeSection=${ot}${l?`&tab=${encodeURIComponent(l)}`:""}`}function O(){let l=e.core?.tagLayout;return l?(l.invalidateSettings(),l.normalizeSettings()):{layout:"corners",density:"full",edge:"default"}}function Y(l,s,u,d){return`
            <label class="je-mth-switch">
                <input type="checkbox" id="${l}" ${s?"checked":""} aria-describedby="${l}Desc">
                <span class="je-mth-switch-text">
                    <span class="je-mth-switch-name" data-je-label>${t(u)}</span>
                    <span class="je-mth-switch-desc" id="${l}Desc">${t(d)}</span>
                </span>
            </label>`}let te=new Set,de=(l,s)=>{let u=n.tagGroupEditorData;if(!u)throw new TypeError("The tag group editor is unavailable");return u.stepCap(l,s,{capAll:!0})};function qe(l){let s=w(),u=s.normalizeSettings().shapes[l],d=s.resolveLayout({shape:l}),b=e.t(`tag_shapes_${l}`),k=[h(s.VOCABULARY_KEYS.layout[d.layout]),e.t(`panel_settings_ui_tag_density_${d.density}`),u?.tagScale?s.sizeLabel("scale",u.tagScale):""].filter(Boolean).join(" · "),m=(g,x)=>{let $=x==="scale"?"tagScale":"tagGap",z=x==="scale"?s.TAG_SCALES:s.TAG_GAPS,N=g[$];return`<label>${t(`tag_${x}_label`)}<select data-shape-action="${$}" aria-label="${a(b)}: ${t(`tag_${x}_label`)}">
                        <option value="" ${N?"":"selected"}>${t("tag_size_inherit")}</option>
                        ${Object.keys(z).map(W=>`<option value="${W}" ${N===W?"selected":""}>${a(s.sizeLabel(x,W))}</option>`).join("")}
                    </select></label>`},I=u?`
            <details class="je-mth-shape-more" data-shape-more ${te.has(l)?"open":""}>
            <summary class="je-mth-shape-summary"><span class="je-mth-shape-summary-text">${a(k)}</span><span class="je-mth-shape-summary-action">${t("tag_shapes_edit")}<span class="material-icons" aria-hidden="true">expand_more</span></span></summary>
            <div class="je-mth-shape-fields">
                <label>${t("panel_settings_ui_tag_layout")}<select data-shape-action="layout" aria-label="${t("tag_shapes_layout_for",{shape:b})}">
                    ${we.map(g=>`<option value="${g}" ${d.layout===g?"selected":""}>${t(s.VOCABULARY_KEYS.layout[g])}</option>`).join("")}
                </select></label>
                <label>${t("panel_settings_ui_tag_density")}<select data-shape-action="density" aria-label="${t("tag_shapes_density_for",{shape:b})}">
                    ${["full","compact"].map(g=>`<option value="${g}" ${d.density===g?"selected":""}>${t(`panel_settings_ui_tag_density_${g}`)}</option>`).join("")}
                </select></label>
                ${m(u,"scale")}${m(u,"gap")}
                <button type="button" class="je-mth-button" data-shape-action="recommended">${t("tag_shapes_recommended")}</button>
            </div>
            <div class="je-mth-shape-groups">${s.DEFAULT_ORDER.map(g=>{let x=h(s.VOCABULARY_KEYS.group[`${g==="ageRating"?"age_rating":g}`]),$=d.caps[g];return`<div class="je-mth-shape-group" data-shape-group="${g}">
                    <span class="je-mth-label">${a(x)}</span>
                    <div class="je-mth-shape-positions" role="group" aria-label="${t("tag_shapes_position_for",{group:x,shape:b})}">
                        ${s.LAYOUT_SLOTS[d.layout].filter(z=>z!=="dots"||g==="quality").map(z=>`<button type="button" data-shape-action="slot" data-value="${z}" aria-pressed="${d.slots[g]===z}">${t(z==="off"?"panel_settings_ui_tag_slot_off":s.VOCABULARY_KEYS.slot[`${d.layout}_${z}`])}</button>`).join("")}
                    </div>
                    <div class="je-mth-shape-cap" data-je-cap-control ${s.singleChipGroup(g)?"hidden":""} role="group" aria-label="${t("tag_shapes_cap_for",{group:x,shape:b})}">
                        <button type="button" data-shape-action="cap" data-value="-1" ${de($,-1)===null?"disabled":""} aria-label="${t("tag_shapes_fewer",{group:x})}">−</button>
                        <output aria-live="polite">${$===0?t("panel_settings_ui_tag_editor_summary_all"):$}</output>
                        <button type="button" data-shape-action="cap" data-value="1" ${de($,1)===null?"disabled":""} aria-label="${t("tag_shapes_more",{group:x})}">+</button>
                    </div>
                </div>`}).join("")}</div>
            </details>`:"";return`<section class="je-mth-card je-mth-shape" data-shape="${l}" aria-labelledby="jeShape-${l}">
            <h4 class="je-mth-card-title" id="jeShape-${l}">${a(b)}</h4>
            <label class="je-mth-shape-toggle"><input type="checkbox" data-shape-action="enabled" ${u?"checked":""}>${t("tag_shapes_different")}</label>
            ${I}
        </section>`}function ve(){return e.core?.tagLayout?e.core.tagLayout.SHAPES.map(qe).join(""):""}function Te(l,s){let u=l==="scale"?"Scale":"Gap",d=w(),b=l==="scale"?d.TAG_SCALES:d.TAG_GAPS,k=l==="scale"?s.tagScale:s.tagGap;return`<div class="je-mth-density">
            <div class="je-mth-field-text">
                <span class="je-mth-label" id="jeMth${u}Label">${t(`tag_${l}_label`)}</span>
                <span class="je-mth-hint" id="jeMth${u}Desc">${t(`tag_${l}_desc`)}</span>
            </div>
            <div class="je-mth-pills" id="jeTag${u}Choice" role="radiogroup" aria-labelledby="jeMth${u}Label" aria-describedby="jeMth${u}Desc">
                ${Object.keys(b).map(m=>`<label class="je-mth-pill"><input type="radio" name="jeTag${u}" value="${m}" ${k===m?"checked":""}><span data-je-label>${a(d.sizeLabel(l,m))}</span></label>`).join("")}
            </div>
        </div>`}function Fe(){let l=O(),s=we.map(k=>`
            <label class="je-mth-tile">
                <input type="radio" name="jeTagLayout" value="${k}" ${l.layout===k?"checked":""}>
                <span class="je-mth-tile-art" data-layout="${k}" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
                <span class="je-mth-tile-name" data-je-label>${t(S().layout[k])}</span>
            </label>`).join(""),u=["full","compact"].map(k=>`
            <label class="je-mth-pill">
                <input type="radio" name="jeTagDensity" value="${k}" ${l.density===k?"checked":""}>
                <span data-je-label>${t(`panel_settings_ui_tag_density_${k}`)}</span>
            </label>`).join(""),d=ft.map(k=>`
            <label class="je-mth-pill">
                <input type="radio" name="jeTagEdge" value="${k}" ${l.edge===k?"checked":""}>
                <span data-je-label>${t(S().edge[k])}</span>
            </label>`).join(""),b=e.pluginConfig?.NativePosterTagsEnabled===!0?Y("nativePosterTagsToggle",e.currentSettings.useNativePosterTags!==!1,"panel_settings_ui_native_poster_tags","panel_settings_ui_native_poster_tags_desc"):"";return`
            <section class="je-mth-card" aria-labelledby="jeMthLayoutTitle">
                <div class="je-mth-card-head"><h4 class="je-mth-card-title" id="jeMthLayoutTitle">${t("common_layout")}</h4>
                    <button type="button" class="je-mth-button je-mth-jump" data-je-jump="jeMthPresetsTitle"><span class="material-icons" aria-hidden="true">auto_awesome</span>${t("panel_media_tags_browse_presets")}</button></div>
                <p class="je-mth-hint">${t("panel_media_tags_layout_desc")}</p>
                <div class="je-mth-tiles" id="jeTagLayoutChoice" role="radiogroup" aria-labelledby="jeMthLayoutTitle" aria-describedby="jeMthLayoutDesc">${s}</div>
                <p class="je-mth-desc" id="jeMthLayoutDesc" aria-live="polite">${t(`panel_settings_ui_tag_layout_${l.layout}`)}</p>
                <div class="je-mth-density">
                    <div class="je-mth-field-text">
                        <span class="je-mth-label" id="jeMthDensityLabel">${t("panel_settings_ui_tag_density")}</span>
                        <span class="je-mth-hint" id="jeMthDensityDesc">${t("panel_settings_ui_tag_density_desc")}</span>
                    </div>
                    <div class="je-mth-pills" id="jeTagDensityChoice" role="radiogroup" aria-labelledby="jeMthDensityLabel" aria-describedby="jeMthDensityDesc">${u}</div>
                </div>
                ${Te("scale",l)}
                ${Te("gap",l)}
                <div class="je-mth-density je-mth-edge">
                    <div class="je-mth-field-text">
                        <span class="je-mth-label" id="jeMthEdgeLabel">${t("panel_settings_ui_tag_edge")}</span>
                        <span class="je-mth-hint" id="jeMthEdgeDesc">${t("panel_settings_ui_tag_edge_desc")}</span>
                    </div>
                    <div class="je-mth-pills" id="jeTagEdgeChoice" role="radiogroup" aria-labelledby="jeMthEdgeLabel" aria-describedby="jeMthEdgeDesc">${d}</div>
                </div>
            </section>
            <div data-je-kind-looks-mount></div><div class="je-mth-shapes">${ve()}</div>
            <p class="je-mth-hint je-mth-shapes-note">${t("tag_shapes_limitations")}</p>
            <section class="je-mth-card" aria-labelledby="jeMthSwitchesTitle">
                <h4 class="je-mth-card-title" id="jeMthSwitchesTitle">${t("panel_media_tags_switches_title")}</h4>
                <p class="je-mth-hint">${t("panel_media_tags_switches_desc")}</p>
                <div class="je-mth-switches">
                    ${Y("tagsHideOnHoverToggle",!!e.currentSettings.tagsHideOnHover,"panel_settings_ui_hide_tags_on_hover","panel_settings_ui_hide_tags_on_hover_desc")}
                    ${b}
                    ${Y("peopleTagsToggle",!!e.currentSettings.peopleTagsEnabled,"panel_settings_ui_people_tags","panel_settings_ui_people_tags_desc")}
                    <p class="je-mth-hint" data-je-scope-na="people">${t("tag_scope_people_na")}</p>
                </div>
            </section>
            ${n.buildTagPortableHtml?.()||""}`}function Ge([l,s,u,d]){if(l==="trending"){let[b="",k=""]=e.t(u,{rank:""}).split(""),m=b.endsWith("#")?"#":"";return`<span class="status-tag status-tag--${l}" data-je-status="${s}">${a(b.slice(0,b.length-m.length))}<span class="status-tag-rank">${m}1</span>${a(k)}</span>`}return`<span class="status-tag status-tag--${l}" data-je-status="${s}">${t(u,d)}</span>`}function Ve(){let l=j(),s=Ne.map(d=>{let b=Number(d.windowSetting?e.pluginConfig?.[d.windowSetting]:void 0)||(d.windowFallback??NaN),k=d.windowKey?`<span class="je-mth-badge-window">${t(d.windowKey,{days:b})}</span>`:d.requires&&e.pluginConfig?.[d.requires]!==!0?`<span class="je-mth-badge-requires">${t(d.requiresKey)}</span>`:"";return`
                <div class="je-quality-cat-row je-mth-badge" data-cat-key="${d.key}">
                    <label class="je-mth-badge-main">
                        <input type="checkbox" id="${d.id}" ${P(d.key,d.fallback)?"checked":""} aria-describedby="${d.id}Desc">
                        <span class="je-mth-badge-text">
                            <span class="je-mth-badge-name" data-je-label>${t(d.nameKey)}</span>
                            <span class="je-mth-badge-desc" id="${d.id}Desc">${t(d.descKey)}${k?" · ":""}${k}</span>
                        </span>
                    </label>
                    <span class="je-mth-badge-sample" aria-hidden="true">${Ge(d.chip)}</span>
                </div>`}).join(""),u=l?`
            <a class="je-mth-link" href="${a(E("badges"))}" data-je-config-link>${t("panel_media_tags_badge_windows_admin")}<span class="material-icons" aria-hidden="true">open_in_new</span></a>`:"";return`
            <section class="je-mth-card" aria-labelledby="jeMthBadgesTitle">
                <h4 class="je-mth-card-title" id="jeMthBadgesTitle" tabindex="-1">${t("panel_media_tags_tab_badges")}</h4>
                <p class="je-mth-hint">${t("panel_media_tags_badges_desc")}</p>
                <div class="je-mth-off je-mth-off--action" id="jeMthBadgesOff" ${e.currentSettings.statusTagsEnabled?"hidden":""}><span>${t("panel_media_tags_badges_off")}</span>
                    <button type="button" class="je-mth-button" data-je-goto="groups:status">${t("panel_media_tags_badges_turn_on")}<span class="material-icons" aria-hidden="true">arrow_forward</span></button></div>
                <div id="statusTagsSubToggles" class="je-mth-badges">${s}</div>
                <div class="je-mth-actions">
                    <button type="button" class="je-mth-button" data-je-goto="groups:status">${t("panel_media_tags_badges_to_groups")}<span class="material-icons" aria-hidden="true">arrow_forward</span></button>
                    ${u}
                </div>
            </section>`}function Ue(){return`
            <section class="je-mth-card" aria-labelledby="jeTagLooksTitle">
                <h4 class="je-mth-card-title" id="jeTagLooksTitle">${t("panel_media_tags_tab_rules")}</h4>
                <p class="je-mth-hint">${t("tag_looks_hub_desc")}</p>
                <div id="jeTagLooksMount"></div>
            </section>`}function Ye(){let l=j(),s;if(y()){let d=e.currentSettings.tagStylePreset,b=e.pluginConfig.TagStylePreset,k=typeof d=="string"&&ke.includes(d)?d:"",m=typeof b=="string"&&ke.includes(b)?b:"default",I=(g,x,$="")=>`
                <label class="je-mth-preset">
                    <input type="radio" name="jeTagPreset" value="${g}" ${k===g?"checked":""}>
                    <span class="je-mth-preset-chips" data-preset="${g||"server"}" aria-hidden="true">
                        <span class="je-mth-chip" data-chip="quality">4K</span><span class="je-mth-chip" data-chip="status">${t("status_tag_compact_added")}</span><span class="je-mth-chip" data-chip="rating">★ 8.1</span><span class="je-mth-chip je-mth-chip-genre" data-chip="genre" data-je-genre="${re}"><i class="je-mth-chip-glyph">${a(e.genreTags?.iconFor?.(re)||"theater_comedy")}</i></span>
                    </span>
                    <span class="je-mth-preset-name" data-je-label>${a(x)}</span>${$?`<span class="je-mth-preset-sub">${a($)}</span>`:""}
                </label>`;s=`
                <div class="je-mth-presets" id="jeTagPresetChoice" role="radiogroup" aria-labelledby="jeMthColoursTitle" aria-describedby="jeMthColoursDesc">
                    ${I("",e.t("panel_settings_ui_tag_style_preset_follow"),e.t("panel_settings_ui_tag_style_preset_server",{preset:h(S().preset[m])}))}
                    ${ke.map(g=>I(g,h(S().preset[g]))).join("")}
                </div>`}else s=`<p class="je-mth-off">${t("panel_media_tags_colours_presets_off")}</p>`;let u=l?`
            <section class="je-mth-card je-mth-admin" aria-labelledby="jeMthColourEditorTitle">
                <div class="je-mth-pointer">
                    <div>
                        <h4 class="je-mth-card-title" id="jeMthColourEditorTitle">${t("panel_media_tags_server_colours")} <span class="je-mth-admin-chip">${t("common_admin")}</span></h4>
                        <p class="je-mth-hint">${t("panel_media_tags_server_colours_desc")}</p>
                    </div>
                    <a class="je-mth-button" href="${a(E("colours"))}" data-je-config-link aria-label="${t("panel_media_tags_open_named",{name:e.t("panel_media_tags_server_colours")})}">${t("common_open")}<span class="material-icons" aria-hidden="true">open_in_new</span></a>
                </div>
            </section>`:"";return`
            <section class="je-mth-card" aria-labelledby="jeMthColoursTitle">
                <h4 class="je-mth-card-title" id="jeMthColoursTitle">${t("panel_settings_ui_tag_style_preset")}</h4>
                <p class="je-mth-hint" id="jeMthColoursDesc">${t("panel_settings_ui_tag_style_preset_desc")}</p>
                ${s}
            </section>
            ${u}`}function We(){let l=dt.map(s=>`
            <li class="je-mth-pointer">
                <div>
                    <div class="je-mth-pointer-name" data-je-label>${t(s.nameKey)}</div>
                    <div class="je-mth-hint">${t(s.descKey)}</div>
                </div>
                <a class="je-mth-button" href="${a(E(s.tab))}" data-je-config-link aria-label="${t("panel_media_tags_open_named",{name:e.t(s.nameKey)})}">${t("common_open")}<span class="material-icons" aria-hidden="true">open_in_new</span></a>
            </li>`).join("");return`
            <section class="je-mth-card je-mth-admin" aria-labelledby="jeMthServerTitle">
                <h4 class="je-mth-card-title" id="jeMthServerTitle">${t("panel_media_tags_server_title")} <span class="je-mth-admin-chip">${t("common_admin")}</span></h4>
                <p class="je-mth-hint">${t("panel_media_tags_server_desc")}</p>
                <ul class="je-mth-pointers">${l}</ul>
            </section>`}n.buildMediaTagsHubHtml=function(l){let s=H(),u={layout:Fe,groups:()=>n.buildTagGroupEditorHtml?.(l)||"",badges:Ve,rules:Ue,colours:Ye,server:We},d=s.map((m,I)=>{let g=e.t(m.nameKey),x=m.shortKey?e.t(m.shortKey):g,$=m.admin?e.t("panel_media_tags_tab_server_name",{name:g}):g;return`<button type="button" role="tab" class="je-mth-tab${m.admin?" je-mth-tab--admin":""}" id="jeMthTab-${m.id}" data-tab="${m.id}" aria-controls="jeMthPanel-${m.id}" aria-selected="${I===0}" tabindex="${I===0?0:-1}" aria-label="${a($)}"><span class="material-icons je-mth-tab-icon" aria-hidden="true">${m.icon}</span><span class="je-mth-tab-long">${a(g)}</span><span class="je-mth-tab-short" aria-hidden="true">${a(x)}</span>`+(m.admin?`<span class="je-mth-admin-chip" aria-hidden="true">${t("common_admin")}</span>`:"")+"</button>"}).join(""),b=m=>`<p class="je-mth-docs"><a href="${ut}#${mt(m.id)}" target="_blank" rel="noopener" aria-label="${t("media_tags_docs_link_label",{name:e.t(m.nameKey)})}"><span class="material-icons" aria-hidden="true">menu_book</span>${t("media_tags_docs_link")}</a></p>`,k=s.map((m,I)=>`
            <div class="je-mth-panel" role="tabpanel" id="jeMthPanel-${m.id}" data-tab="${m.id}" aria-labelledby="jeMthTab-${m.id}" ${I===0?"":"hidden"}>${u[m.id]?.()??""}${b(m)}</div>`).join("");return`
            <section class="je-pane" data-pane="media-tags">
                <div class="je-mth" id="jeMediaTagsHub" data-tab="${s[0]?.id}">
                    <div class="je-mth-top">
                        <h3 class="je-pane-title">${e.icon(e.IconName.TAG)} ${t("common_media_tags")}</h3>
                        <div class="je-mth-tabs" role="tablist" aria-label="${t("common_media_tags")}">${d}</div>
                        <span class="je-mth-autosave"><span class="material-icons" aria-hidden="true">cloud_done</span>${t("panel_media_tags_autosave")}</span>
                    </div>
                    <div class="je-mth-strip" id="jeMthStrip">
                        <button type="button" class="je-mth-strip-toggle" id="jeMthStripToggle" aria-expanded="false" aria-controls="jeMthPreview">${t("common_preview")}<span class="material-icons" aria-hidden="true">expand_more</span></button>
                        <div class="je-mth-strip-thumb" aria-hidden="true"></div>
                        <div class="je-mth-strip-info">
                            <div class="je-mth-strip-text"></div>
                            <div class="je-mth-strip-chips"></div>
                        </div>
                        <span class="material-icons je-mth-strip-saved" role="img" aria-label="${t("panel_media_tags_autosave")}" title="${t("panel_media_tags_autosave")}">cloud_done</span>
                    </div>
                    <div class="je-mth-body">
                        <aside class="je-mth-preview" id="jeMthPreview" aria-label="${t("panel_media_tags_preview")}"></aside>
                        <div class="je-mth-panels">${k}</div>
                    </div>
                    <div class="je-mth-live" id="jeMthLive" role="status" aria-live="polite"></div>
                </div>
            </section>`};let Ze=`
        #jellyfin-enhanced-panel .je-mth { container: je-mth / inline-size; padding-bottom: 8px; --je-mth-sel: color-mix(in srgb, var(--je-mth-accent) 72%, #000); }
        #jellyfin-enhanced-panel .je-mth-top { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 0 20px; border-bottom: 1px solid rgba(255,255,255,0.12); margin-bottom: 12px; }
        #jellyfin-enhanced-panel .je-mth-top .je-pane-title { margin: 14px 0 10px; }
        #jellyfin-enhanced-panel .je-mth-tabs { display: flex; gap: 2px; min-width: 0; }
        #jellyfin-enhanced-panel .je-mth-docs { margin: 16px 0 0; font-size: 13px; }
        #jellyfin-enhanced-panel .je-mth-docs a { display: inline-flex; align-items: center; gap: 6px; color: rgba(255,255,255,0.72); }
        #jellyfin-enhanced-panel .je-mth-docs .material-icons { font-size: 16px; }
        #jellyfin-enhanced-panel .je-mth-tab { position: relative; display: inline-flex; align-items: center; gap: 6px; padding: 10px 10px 11px; min-height: 40px; background: transparent; border: 0; color: rgba(255,255,255,0.72); font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; white-space: nowrap; border-radius: 6px 6px 0 0; }
        #jellyfin-enhanced-panel .je-mth-tab:hover { color: #fff; background: rgba(255,255,255,0.05); }
        #jellyfin-enhanced-panel .je-mth-tab[aria-selected="true"] { color: var(--je-mth-accent); }
        #jellyfin-enhanced-panel .je-mth-tab[aria-selected="true"]::after { content: ''; position: absolute; left: 6px; right: 6px; bottom: -1px; height: 3px; border-radius: 3px; background: var(--je-mth-accent); }
        #jellyfin-enhanced-panel .je-mth-tab:focus-visible { outline: 2px solid #fff; outline-offset: -2px; }
        #jellyfin-enhanced-panel .je-mth-tab-short { display: none; }
        #jellyfin-enhanced-panel .je-mth-tab-icon { font-size: 18px; }
        #jellyfin-enhanced-panel .je-mth-strip-saved { display: none; }
        #jellyfin-enhanced-panel .je-mth-autosave { display: inline-flex; align-items: center; gap: 4px; margin: 0 0 12px auto; font-size: 12px; color: rgba(255,255,255,0.62); white-space: nowrap; }
        #jellyfin-enhanced-panel .je-mth-autosave .material-icons { font-size: 16px; }

        #jellyfin-enhanced-panel .je-mth-admin-chip { display: inline-block; padding: 1px 5px; border: 1px solid #ffb74d; border-radius: 4px; color: #ffb74d; font-size: 10px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; vertical-align: middle; }
        #jellyfin-enhanced-panel .je-mth-body { display: grid; grid-template-columns: minmax(0, 1fr) clamp(288px, 30cqi, 400px); gap: 16px; align-items: start; }
        #jellyfin-enhanced-panel .je-mth-panels { grid-column: 1; grid-row: 1; min-width: 0; container: je-mth-panels / inline-size; }
        #jellyfin-enhanced-panel .je-mth-preview { grid-column: 2; grid-row: 1; position: sticky; top: 8px; padding: 12px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.03); }
        #jellyfin-enhanced-panel .je-mth[data-tab="server"] .je-mth-body { grid-template-columns: minmax(0, 1fr); }
        #jellyfin-enhanced-panel .je-mth[data-tab="server"] :is(.je-mth-preview, .je-mth-strip) { display: none !important; }
        #jellyfin-enhanced-panel .je-mth-panel[hidden] { display: none; }
        #jellyfin-enhanced-panel .je-mth-card { margin: 0 0 12px; padding: 12px 14px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.1); background: var(--je-mth-box); }
        #jellyfin-enhanced-panel .je-mth-card .je-tge { margin: 0; padding: 0; background: none; border: 0; }
        #jellyfin-enhanced-panel .je-mth-card-title { margin: 0 0 4px; font-size: 16px; font-weight: 600; color: #fff; }
        #jellyfin-enhanced-panel .je-mth-card-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
        #jellyfin-enhanced-panel .je-mth-jump { min-height: 32px; padding: 0 10px; font-size: 13px; }
        #jellyfin-enhanced-panel #jeMthPresetsTitle { scroll-margin-top: 72px; }
        #jellyfin-enhanced-panel .je-mth-card-title:focus { outline: none; }
        #jellyfin-enhanced-panel .je-mth-card-title:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
        #jellyfin-enhanced-panel .je-mth-hint { margin: 0 0 8px; font-size: 13px; line-height: 1.45; color: rgba(255,255,255,0.68); }
        #jellyfin-enhanced-panel .je-mth-desc { margin: 8px 0 4px; font-size: 13px; color: rgba(255,255,255,0.85); }
        #jellyfin-enhanced-panel .je-mth-label { font-size: 14px; font-weight: 600; }
        #jellyfin-enhanced-panel .je-mth-off { margin: 4px 0 10px; padding: 8px 10px; border-radius: 6px; background: rgba(255,183,77,0.12); color: #ffd699; font-size: 12px; }
        #jellyfin-enhanced-panel .je-mth-off[hidden] { display: none; }
        #jellyfin-enhanced-panel .je-mth-off--action { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; font-size: 13px; }
        #jellyfin-enhanced-panel .je-mth-off--action .je-mth-button { min-height: 40px; }
        #jellyfin-enhanced-panel .je-mth-off--action[hidden] { display: none; }
        #jellyfin-enhanced-panel .je-mth input[type="radio"] { position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0; pointer-events: none; }
        #jellyfin-enhanced-panel .je-mth-tiles { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; margin-top: 6px; }
        #jellyfin-enhanced-panel .je-mth-tile { position: relative; display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 10px 4px 8px; min-height: 40px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.46); background: rgba(0,0,0,0.2); cursor: pointer; text-align: center; }
        #jellyfin-enhanced-panel .je-mth-tile:hover { background: rgba(255,255,255,0.06); }
        #jellyfin-enhanced-panel .je-mth-tile:has(input:checked) { border: 2px solid var(--je-mth-accent); padding: 9px 3px 7px; background: color-mix(in srgb, var(--je-mth-accent) 16%, transparent); }
        #jellyfin-enhanced-panel :is(.je-mth-tile, .je-mth-pill, .je-mth-preset):has(input:focus-visible) { outline: 2px solid #fff; outline-offset: 2px; }
        #jellyfin-enhanced-panel .je-mth-tile-name { font-size: 13px; font-weight: 600; line-height: 1.2; }
        #jellyfin-enhanced-panel .je-mth-tile-art { position: relative; width: 26px; height: 38px; border-radius: 3px; background: #4a5160; }
        #jellyfin-enhanced-panel .je-mth-tile-art i { position: absolute; display: none; height: 4px; border-radius: 1px; }
        #jellyfin-enhanced-panel [data-layout="corners"] i { display: block; width: 8px; }
        #jellyfin-enhanced-panel [data-layout="corners"] i:nth-child(1) { left: 2px; top: 2px; background: #42a5f5; }
        #jellyfin-enhanced-panel [data-layout="corners"] i:nth-child(2) { right: 2px; top: 2px; background: #ef5350; }
        #jellyfin-enhanced-panel [data-layout="corners"] i:nth-child(3) { left: 2px; bottom: 2px; background: #ab47bc; }
        #jellyfin-enhanced-panel [data-layout="corners"] i:nth-child(4) { right: 2px; bottom: 2px; background: #ffca28; }
        #jellyfin-enhanced-panel [data-layout="bands"] { width: 30px; height: 30px; margin: 4px 0; }
        #jellyfin-enhanced-panel [data-layout="bands"] i:nth-child(-n+4) { display: block; width: 7px; }
        #jellyfin-enhanced-panel [data-layout="bands"] i:nth-child(1) { left: 2px; top: -6px; background: #ef5350; }
        #jellyfin-enhanced-panel [data-layout="bands"] i:nth-child(2) { left: 10px; top: -6px; background: #42a5f5; }
        #jellyfin-enhanced-panel [data-layout="bands"] i:nth-child(3) { left: 2px; bottom: -6px; background: #ffca28; }
        #jellyfin-enhanced-panel [data-layout="bands"] i:nth-child(4) { left: 10px; bottom: -6px; background: #66bb6a; }
        #jellyfin-enhanced-panel [data-layout="caption"] { height: 32px; margin-bottom: 6px; }
        #jellyfin-enhanced-panel [data-layout="caption"] i:nth-child(1) { display: block; right: 2px; top: 2px; width: 8px; background: #ef5350; }
        #jellyfin-enhanced-panel [data-layout="caption"] i:nth-child(2) { display: block; left: 0; bottom: -7px; width: 8px; background: #42a5f5; }
        #jellyfin-enhanced-panel [data-layout="caption"] i:nth-child(3) { display: block; left: 9px; bottom: -7px; width: 8px; background: #ffca28; }
        #jellyfin-enhanced-panel [data-layout="caption"] i:nth-child(4) { display: block; left: 18px; bottom: -7px; width: 8px; background: #66bb6a; }
        #jellyfin-enhanced-panel [data-layout="summary"] i:nth-child(1) { display: block; left: 4px; right: 4px; bottom: 4px; height: 6px; border-radius: 3px; background: #111; box-shadow: inset 0 0 0 1px #ffca28; }
        #jellyfin-enhanced-panel [data-layout="minimal"] i:nth-child(1) { display: block; right: 2px; top: 2px; width: 8px; background: #ef5350; }
        #jellyfin-enhanced-panel [data-layout="minimal"] i:nth-child(2) { display: block; left: 3px; bottom: 3px; width: 4px; height: 4px; border-radius: 50%; background: #42a5f5; }
        #jellyfin-enhanced-panel [data-layout="minimal"] i:nth-child(3) { display: block; left: 9px; bottom: 3px; width: 4px; height: 4px; border-radius: 50%; background: #66bb6a; }
        #jellyfin-enhanced-panel .je-mth-shape-toggle { display: flex; align-items: center; gap: 10px; min-height: 40px; font-size: 14px; cursor: pointer; }
        #jellyfin-enhanced-panel .je-mth-shape-toggle input { width: 18px; height: 18px; margin: 0; accent-color: var(--je-mth-accent); }
        #jellyfin-enhanced-panel .je-mth-shape-more { margin-top: 6px; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; }
        #jellyfin-enhanced-panel .je-mth-shape-summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 48px; padding: 0 10px 0 12px; list-style: none; cursor: pointer; border-radius: 8px; }
        #jellyfin-enhanced-panel .je-mth-shape-summary::-webkit-details-marker { display: none; }
        #jellyfin-enhanced-panel .je-mth-shape-summary:hover { background: rgba(255,255,255,0.05); }
        #jellyfin-enhanced-panel .je-mth-shape-summary:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
        #jellyfin-enhanced-panel .je-mth-shape-summary-text { font-size: 14px; font-weight: 600; }
        #jellyfin-enhanced-panel .je-mth-shape-summary-action { display: inline-flex; align-items: center; gap: 2px; font-size: 13px; color: rgba(255,255,255,0.75); }
        #jellyfin-enhanced-panel .je-mth-shape-summary-action .material-icons { font-size: 20px; transition: transform 0.2s ease; }
        #jellyfin-enhanced-panel .je-mth-shape-more[open] .je-mth-shape-summary-action .material-icons { transform: rotate(180deg); }
        #jellyfin-enhanced-panel .je-mth-shape-more > :not(summary) { margin-left: 12px; margin-right: 12px; }
        #jellyfin-enhanced-panel .je-mth-shape-more[open] > summary { border-bottom: 1px solid rgba(255,255,255,0.08); border-radius: 8px 8px 0 0; }
        #jellyfin-enhanced-panel .je-mth-shapes-note { margin: -2px 2px 12px; }
        #jellyfin-enhanced-panel .je-mth-shape-fields { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; margin: 8px 0; }
        #jellyfin-enhanced-panel .je-mth-shape-fields label { display: flex; flex-direction: column; gap: 4px; flex: 1 1 120px; font-size: 12px; }
        #jellyfin-enhanced-panel .je-mth-shape-fields select { min-height: 36px; width: 100%; border: 1px solid #666; border-radius: 5px; background: #20242b; color: #fff; font: inherit; padding: 4px; }
        #jellyfin-enhanced-panel .je-mth-shape-group { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 8px 0; border-top: 1px solid rgba(255,255,255,0.1); }
        #jellyfin-enhanced-panel .je-mth-shape-group > .je-mth-label { flex: 1 0 100%; }
        #jellyfin-enhanced-panel .je-mth-shape-positions { display: flex; flex-wrap: wrap; gap: 4px; flex: 1 1 180px; }
        #jellyfin-enhanced-panel .je-mth-shape :is(button, input):focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
        #jellyfin-enhanced-panel .je-mth-shape-positions button, #jellyfin-enhanced-panel .je-mth-shape-cap button { min-height: 32px; padding: 3px 8px; background: rgba(255,255,255,0.06); color: #fff; border: 1px solid #666; border-radius: 16px; font: inherit; font-size: 12px; cursor: pointer; }
        #jellyfin-enhanced-panel .je-mth-shape-positions [aria-pressed="true"] { background: var(--je-mth-sel); border-color: var(--je-mth-sel); font-weight: 600; }
        #jellyfin-enhanced-panel .je-mth-shape-cap { display: flex; align-items: center; gap: 6px; font-size: 12px; }
        #jellyfin-enhanced-panel .je-mth-shape-cap output { min-width: 24px; text-align: center; }
        #jellyfin-enhanced-panel .je-mth-shape-cap button:disabled { opacity: 0.35; cursor: default; }
        /* A field row: label and its help on the left, the choice on the right (below on a narrow pane). */
        #jellyfin-enhanced-panel .je-mth-density { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 12px 0; border-top: 1px solid rgba(255,255,255,0.08); }
        #jellyfin-enhanced-panel .je-mth-desc + .je-mth-density { margin-top: 8px; }
        #jellyfin-enhanced-panel .je-mth-density:last-child { padding-bottom: 2px; }
        #jellyfin-enhanced-panel .je-mth-field-text { display: flex; flex-direction: column; gap: 2px; flex: 1 1 240px; min-width: 0; }
        #jellyfin-enhanced-panel .je-mth-field-text .je-mth-hint { margin: 0; }
        #jellyfin-enhanced-panel .je-mth-density > .je-mth-pills { margin-left: auto; }
        #jellyfin-enhanced-panel .je-mth-pills { display: inline-flex; flex-wrap: wrap; gap: 6px; }
        #jellyfin-enhanced-panel .je-mth-pill { position: relative; display: inline-flex; align-items: center; min-height: 36px; padding: 0 16px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.46); font-size: 13px; cursor: pointer; }
        #jellyfin-enhanced-panel .je-mth-pill:hover { background: rgba(255,255,255,0.06); }
        #jellyfin-enhanced-panel .je-mth-pill:has(input:checked) { background: var(--je-mth-sel); border-color: var(--je-mth-sel); color: #fff; font-weight: 600; }
        #jellyfin-enhanced-panel .je-mth-switches { border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; overflow: hidden; }
        #jellyfin-enhanced-panel .je-mth-switch { display: flex; align-items: flex-start; gap: 12px; padding: 8px 12px; min-height: 40px; box-sizing: border-box; cursor: pointer; }
        #jellyfin-enhanced-panel .je-mth-switch + .je-mth-switch { border-top: 1px solid rgba(255,255,255,0.08); }
        #jellyfin-enhanced-panel .je-mth-switch input { width: 18px; height: 18px; margin: 2px 0 0; flex-shrink: 0; accent-color: var(--je-mth-accent); cursor: pointer; }
        #jellyfin-enhanced-panel .je-mth-switch-text, #jellyfin-enhanced-panel .je-mth-badge-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
        #jellyfin-enhanced-panel .je-mth-switch-name, #jellyfin-enhanced-panel .je-mth-badge-name { font-size: 14px; font-weight: 500; }
        #jellyfin-enhanced-panel .je-mth-switch-desc, #jellyfin-enhanced-panel .je-mth-badge-desc { font-size: 13px; color: rgba(255,255,255,0.66); line-height: 1.4; min-width: 0; }
        /* Two lines at rest; the row never changes height under the pointer. */
        #jellyfin-enhanced-panel .je-mth-switch-desc { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        #jellyfin-enhanced-panel .je-mth-badges { display: flex; flex-direction: column; gap: 6px; }
        #jellyfin-enhanced-panel .je-mth-badge { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.18); }
        #jellyfin-enhanced-panel .je-mth-badge-main { display: flex; align-items: flex-start; gap: 12px; min-width: 0; cursor: pointer; flex: 1; }
        #jellyfin-enhanced-panel .je-mth-badge-main input { width: 18px; height: 18px; margin: 2px 0 0; flex-shrink: 0; accent-color: var(--je-mth-accent); cursor: pointer; }
        #jellyfin-enhanced-panel .je-mth-badge-window { white-space: nowrap; }
        /* Not a .status-overlay-container: the status module removes every one of those when it re-initialises. */
        #jellyfin-enhanced-panel .je-mth-badge-sample { display: inline-flex; flex-shrink: 0; max-width: 45%; }
        #jellyfin-enhanced-panel .je-mth-badge:not(:has(input:checked)) .je-mth-badge-sample { opacity: 0.35; filter: grayscale(1); }
        /* The samples keep a chip shape even while the Status module (and its stylesheet) is off; dimmed then. */
        #jellyfin-enhanced-panel .je-mth-panel:has(#jeMthBadgesOff:not([hidden])) .je-mth-badge-sample .status-tag { display: inline-flex; gap: 0.3em; align-items: center; padding: 3px 8px; border-radius: 6px; background: #2b2f38; color: #fff; font-size: 12px; font-weight: 700; line-height: 1.2; white-space: nowrap; }
        #jellyfin-enhanced-panel .je-mth-panel:has(#jeMthBadgesOff:not([hidden])) .je-mth-badge-sample { opacity: 0.35; filter: grayscale(1); }
        #jellyfin-enhanced-panel .je-mth-actions { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; margin-top: 10px; }
        #jellyfin-enhanced-panel .je-mth-button { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 12px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.46); background: rgba(255,255,255,0.06); color: #fff; font: inherit; font-size: 13px; font-weight: 600; text-decoration: none; cursor: pointer; white-space: nowrap; }
        #jellyfin-enhanced-panel .je-mth-button:hover { background: rgba(255,255,255,0.12); }
        #jellyfin-enhanced-panel :is(.je-mth-button, .je-mth-link, .je-mth-strip-toggle):focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
        #jellyfin-enhanced-panel .je-mth-button .material-icons, #jellyfin-enhanced-panel .je-mth-link .material-icons { font-size: 16px; }
        #jellyfin-enhanced-panel .je-mth-link { display: inline-flex; align-items: center; gap: 4px; min-height: 36px; color: #7fd3ff; font-size: 13px; }
        #jellyfin-enhanced-panel .je-mth-presets { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 8px; margin-top: 6px; }
        #jellyfin-enhanced-panel .je-mth-preset { position: relative; display: flex; flex-direction: column; gap: 8px; padding: 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.46); background: rgba(0,0,0,0.25); cursor: pointer; }
        #jellyfin-enhanced-panel .je-mth-preset:has(input:checked) { border: 2px solid var(--je-mth-accent); padding: 9px; }
        #jellyfin-enhanced-panel .je-mth-preset-chips { display: flex; flex-wrap: wrap; gap: 3px; min-height: 22px; padding: 6px 5px; border-radius: 4px; background: linear-gradient(135deg, #39424f, #1b1f26); overflow: hidden; }
        #jellyfin-enhanced-panel .je-mth-chip { display: inline-flex; align-items: center; padding: 2px 4px; border-radius: 4px; border: 1px solid transparent; font-size: 10px; font-weight: 700; line-height: 1.2; white-space: nowrap; }
        /* The genre circle sits at the right, as on a poster; in a narrow tile it takes a row of its own. */
        #jellyfin-enhanced-panel .je-mth-chip-genre { justify-content: center; flex-shrink: 0; width: 18px; height: 18px; margin-left: auto; padding: 0; border-radius: 50%; box-sizing: border-box; }
        #jellyfin-enhanced-panel .je-mth-chip-glyph { font-family: 'JE Material Symbols Outlined'; font-style: normal; font-weight: normal; font-size: 12px; line-height: 1; letter-spacing: normal; text-transform: none; direction: ltr; font-feature-settings: 'liga'; -webkit-font-smoothing: antialiased; }
        #jellyfin-enhanced-panel .je-mth-preset-name { font-size: 13px; font-weight: 600; }
        #jellyfin-enhanced-panel .je-mth-preset-sub { margin-top: -6px; font-size: 12px; color: rgba(255,255,255,0.68); }
        #jellyfin-enhanced-panel .je-mth-admin { background: rgba(255,183,77,0.05); border-color: rgba(255,183,77,0.25); }
        #jellyfin-enhanced-panel .je-mth-pointers { list-style: none; margin: 0; padding: 0; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; }
        #jellyfin-enhanced-panel .je-mth-pointer { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
        #jellyfin-enhanced-panel .je-mth-pointers .je-mth-pointer { padding: 10px 12px; }
        #jellyfin-enhanced-panel .je-mth-pointers .je-mth-pointer + .je-mth-pointer { border-top: 1px solid rgba(255,255,255,0.08); }
        #jellyfin-enhanced-panel .je-mth-pointer .je-mth-hint { margin: 2px 0 0; }
        #jellyfin-enhanced-panel .je-mth-pointer-name { font-size: 14px; font-weight: 600; }
        #jellyfin-enhanced-panel .je-mth-strip { display: none; }
        /* The strip thumbnail: one mark per group where the followed sample shows it. */
        #jellyfin-enhanced-panel .je-mth-strip-thumb i { position: absolute; width: 8px; height: 4px; border-radius: 1px; background: #ccc; }
        #jellyfin-enhanced-panel .je-mth-strip-thumb i[data-group="status"] { background: #ef5350; }
        #jellyfin-enhanced-panel .je-mth-strip-thumb i[data-group="quality"] { background: #42a5f5; }
        #jellyfin-enhanced-panel .je-mth-strip-thumb i[data-group="rating"] { background: #ffca28; }
        #jellyfin-enhanced-panel .je-mth-strip-thumb i[data-group="ageRating"] { background: #ab47bc; }
        #jellyfin-enhanced-panel .je-mth-strip-thumb i[data-group="language"] { background: #66bb6a; }
        #jellyfin-enhanced-panel .je-mth-strip-thumb i[data-group="genre"] { background: #26a69a; }
        #jellyfin-enhanced-panel .je-mth-strip-thumb i[data-group="custom"] { background: #90a4ae; }
        #jellyfin-enhanced-panel .je-mth-strip-thumb i:is([data-slot="tl"], [data-slot="top"]) { left: 2px; top: calc(2px + var(--je-mtp-n) * 5px); }
        #jellyfin-enhanced-panel .je-mth-strip-thumb[data-layout="bands"] i[data-slot="top"] { left: calc(2px + var(--je-mtp-n) * 9px); top: 2px; }
        #jellyfin-enhanced-panel .je-mth-strip-thumb[data-layout="minimal"] i[data-slot="top"], #jellyfin-enhanced-panel .je-mth-strip-thumb i:is([data-slot="tr"], [data-slot="poster"]) { left: auto; right: 2px; top: calc(2px + var(--je-mtp-n) * 5px); }
        #jellyfin-enhanced-panel .je-mth-strip-thumb i[data-slot="bl"] { left: 2px; bottom: calc(2px + var(--je-mtp-n) * 5px); }
        #jellyfin-enhanced-panel .je-mth-strip-thumb i:is([data-slot="br"], [data-slot="corner"]) { right: 2px; bottom: calc(2px + var(--je-mtp-n) * 5px); }
        #jellyfin-enhanced-panel .je-mth-strip-thumb i[data-slot="bottom"] { left: calc(2px + var(--je-mtp-n) * 9px); bottom: 2px; }
        #jellyfin-enhanced-panel .je-mth-strip-thumb i[data-slot="caption"] { left: calc(var(--je-mtp-n) * 9px); bottom: -6px; }
        #jellyfin-enhanced-panel .je-mth-strip-thumb i[data-slot="pill"] { left: calc(50% - 7px + (var(--je-mtp-n) - 1) * 4px); bottom: 3px; width: 6px; height: 6px; border-radius: 3px; }
        #jellyfin-enhanced-panel .je-mth-strip-thumb i[data-slot="dots"] { left: 3px; bottom: 3px; width: 4px; height: 4px; border-radius: 50%; }
        /* Keyboard focus never lands under the rule form's sticky Add rule bar. */
        #jellyfin-enhanced-panel .je-panel-main:has(.je-mth[data-tab="rules"]) { scroll-padding-bottom: 72px; }
        #jellyfin-enhanced-panel .je-mth-live { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
        /* Narrow pane (phone, or a small window): one column, the preview
           collapses into a one-line strip under the tabs that expands on tap. */
        /* Phone: the panel's Back button sits on the Media Tags title row instead of a row of its own. */
        @media (max-width: 760px) {
            #jellyfin-enhanced-panel .je-panel-main:has(.je-pane.active[data-pane="media-tags"], .je-pane[data-pane="media-tags"].active) > .je-pane-back { position: sticky; top: 6px; z-index: 6; float: left; width: 40px; height: 40px; margin: 6px 0 -46px 0; }
            /* The section select above already names Media Tags: the title stays for screen readers; the tabs sit beside Back. */
            #jellyfin-enhanced-panel .je-pane[data-pane="media-tags"] .je-mth-top .je-pane-title { position: absolute; width: 1px; height: 1px; margin: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
            #jellyfin-enhanced-panel .je-pane[data-pane="media-tags"] .je-mth-tabs { margin-left: 50px; min-height: 44px; }
            /* The tab row stays at the top while a long tab scrolls; the preview strip sits under it. */
            #jellyfin-enhanced-panel .je-pane[data-pane="media-tags"] .je-mth-top { position: sticky; top: 0; z-index: 5; background: rgb(24, 24, 24); }
            #jellyfin-enhanced-panel .je-pane[data-pane="media-tags"] .je-mth-strip { top: 58px; }
            #jellyfin-enhanced-panel .je-pane[data-pane="media-tags"] .je-mth-autosave { display: none; }
            #jellyfin-enhanced-panel .je-pane[data-pane="media-tags"] .je-mth-strip-saved { display: inline-block; flex-shrink: 0; margin-left: auto; font-size: 20px; color: rgba(255,255,255,0.6); }
        }
        @container je-mth (max-width: 679px) {
            #jellyfin-enhanced-panel .je-mth-top { gap: 0; }
            #jellyfin-enhanced-panel .je-mth-top .je-pane-title { margin: 2px 0 8px; font-size: 16px; }
            #jellyfin-enhanced-panel .je-mth-tabs { flex: 1 1 100%; display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 2px; }
            #jellyfin-enhanced-panel .je-mth-tab { justify-content: center; min-height: 44px; padding: 8px 2px 9px; font-size: 13px; min-width: 0; }
            #jellyfin-enhanced-panel .je-mth-tab-long, #jellyfin-enhanced-panel .je-mth-tab .je-mth-admin-chip { display: none; }
            #jellyfin-enhanced-panel .je-mth-tab-short { display: inline; overflow: hidden; text-overflow: ellipsis; }
            /* Icon over a short label; the admin section's icon is amber (its name says admin to screen readers). */
            #jellyfin-enhanced-panel .je-mth-tab { flex-direction: column; gap: 2px; padding: 6px 1px 8px; font-size: 12px; }
            #jellyfin-enhanced-panel .je-mth-tab-icon { font-size: 20px; }
            #jellyfin-enhanced-panel .je-mth-tab--admin .je-mth-tab-icon { color: #ffb74d; }
            #jellyfin-enhanced-panel .je-mth-body { grid-template-columns: minmax(0, 1fr); gap: 10px; }
            #jellyfin-enhanced-panel .je-mth-preview { grid-column: 1; grid-row: auto; position: static; display: none; }
            #jellyfin-enhanced-panel .je-mth-panels { grid-row: auto; }
            #jellyfin-enhanced-panel .je-mth.je-mth-strip-open .je-mth-preview { display: block; }
            #jellyfin-enhanced-panel .je-mth-strip { position: sticky; top: 0; z-index: 3; display: flex; align-items: center; gap: 10px; margin: 0 0 10px; padding: 4px 8px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); background: rgb(28, 28, 28); }
            #jellyfin-enhanced-panel .je-mth-strip-toggle { display: inline-flex; align-items: center; gap: 2px; flex-shrink: 0; min-height: 40px; padding: 0 8px 0 12px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.22); background: rgba(255,255,255,0.06); color: #fff; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
            #jellyfin-enhanced-panel .je-mth-strip-toggle[aria-expanded="true"] .material-icons { transform: rotate(180deg); }
            #jellyfin-enhanced-panel .je-mth-strip-thumb { position: relative; flex-shrink: 0; width: 28px; height: 42px; border-radius: 3px; background: #4a5160; }
            #jellyfin-enhanced-panel .je-mth-strip-thumb[data-shape="thumb"] { width: 48px; height: 27px; }
            #jellyfin-enhanced-panel .je-mth-strip-info { min-width: 0; flex: 1; font-size: 12px; line-height: 1.35; }
            #jellyfin-enhanced-panel .je-mth-strip-text { color: #fff; font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            #jellyfin-enhanced-panel .je-mth-strip-chips { color: rgba(255,255,255,0.75); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            #jellyfin-enhanced-panel .je-mth-tiles { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
            #jellyfin-enhanced-panel .je-mth-tile { padding: 8px 2px 6px; }
            #jellyfin-enhanced-panel .je-mth-tile-name { font-size: 13px; }
            #jellyfin-enhanced-panel .je-mtp-view button { min-height: 44px; }
            #jellyfin-enhanced-panel .je-mth-switch-desc { -webkit-line-clamp: 3; }
            /* Phone reading size for help and descriptions (preview metadata stays small). */
            #jellyfin-enhanced-panel :is(.je-mth-hint, .je-mth-switch-desc, .je-mth-badge-desc, .je-tge-hint, .je-tge-summary) { font-size: 14px; line-height: 1.45; }
            #jellyfin-enhanced-panel .je-mth-presets { grid-template-columns: repeat(2, minmax(0, 1fr)); }
            #jellyfin-enhanced-panel .je-mth-pill, #jellyfin-enhanced-panel .je-mth-button, #jellyfin-enhanced-panel .je-mth-strip-toggle { min-height: 44px; }
            #jellyfin-enhanced-panel .je-mtp .je-mtp-view button { min-height: 44px; font-size: 13px; }
            #jellyfin-enhanced-panel .je-mth-density > .je-mth-pills { margin-left: 0; }
            #jellyfin-enhanced-panel .je-mth-pointer { flex-wrap: wrap; }
            #jellyfin-enhanced-panel .je-mth-badge { position: relative; display: block; }
            #jellyfin-enhanced-panel .je-mth-badge-sample { position: absolute; top: 10px; right: 12px; max-width: 40%; }
            #jellyfin-enhanced-panel .je-mth-badge-name { display: block; min-height: 22px; padding-right: 40%; }
            #jellyfin-enhanced-panel .je-mth-autosave { order: 1; flex: 0 1 auto; align-self: center; margin: 0 0 4px auto; color: rgba(255,255,255,0.7); }
            #jellyfin-enhanced-panel .je-mth-tabs { order: 2; }
        }
    `;n.wireMediaTagsHub=function(l){n.mediaTagsHub?.dispose?.();let s=document.getElementById("jeMediaTagsHub");if(!s)return;e.core.ui?.injectCss?.("je-media-tags-hub",Ze),s.style.setProperty("--je-mth-accent",l.toggleAccentColor||"#00a4dc"),s.style.setProperty("--je-mth-box",l.presetBoxBackground||"rgba(255,255,255,0.04)");let u=()=>{try{l.resetAutoCloseTimer?.()}catch{}},d=M(s,'[role="tablist"]'),b=U(s,'[role="tab"]'),k=M(s,"#jeMthLive");if(!d||!k)throw new TypeError("The Media Tags hub markup is incomplete");let m=M(s,"#jeMthStripToggle"),I=`${rt}${fe()}`,g=!1,x=null,$=null,z=!1,N=[je(s,e)],W=i=>{k.textContent="",setTimeout(()=>{g||(k.textContent=i)},30)},Xe=()=>s.dataset.tab||"layout",pe=()=>{if(!x)return;let i=Xe(),o=null;if(i==="badges")o="status";else if(i==="groups"){let r=s.querySelector('.je-tge-row .je-tge-expand[aria-expanded="true"]')?.closest(".je-tge-row");o=r instanceof HTMLElement&&r.dataset.group||null}x.setSpotlight(o),x.follow(i==="rules"?"episode":"movie")},G=(i,o={})=>{let p=b.find(r=>r.dataset.tab===i);if(!p)return!1;for(let r of b){let c=r===p;r.setAttribute("aria-selected",String(c)),r.tabIndex=c?0:-1;let f=document.getElementById(`jeMthPanel-${r.dataset.tab}`);f&&(f.hidden=!c)}s.dataset.tab=i;try{window.localStorage.setItem(I,i)}catch{}if(i==="rules"&&n.tagLooksPanel?.show?.(),i==="colours"&&Qe(),pe(),o.focusTab&&p.focus(),o.focus){let r=document.getElementById(`jeMthPanel-${i}`),c=r?M(r,".je-mth-card-title, .je-tge-title"):null;c&&(c.tabIndex=-1,c.focus())}return u(),!0};d.addEventListener("click",i=>{let o=J(i,'[role="tab"]');o&&G(o.dataset.tab||"layout")}),d.addEventListener("keydown",i=>{let o=b.findIndex(f=>f===document.activeElement);if(o<0)return;let p=-1,r=getComputedStyle(d).direction==="rtl"||d.closest("[dir]")?.getAttribute("dir")==="rtl"?-1:1;i.key==="ArrowRight"?p=(o+r+b.length)%b.length:i.key==="ArrowLeft"?p=(o-r+b.length)%b.length:i.key==="Home"?p=0:i.key==="End"&&(p=b.length-1);let c=b[p];p<0||!c||(i.preventDefault(),G(c.dataset.tab||"layout",{focusTab:!0}))});let ne=s.querySelector("#jeMthLayoutDesc"),X=(i,o)=>{s.querySelectorAll(`input[name="${i}"]`).forEach(p=>{p instanceof HTMLInputElement&&(p.checked=p.value===o)})},ce=()=>{if(g)return;let i=O();X("jeTagLayout",i.layout),X("jeTagDensity",i.density),X("jeTagScale",i.tagScale),X("jeTagGap",i.tagGap),X("jeTagEdge",i.edge),ne&&(ne.textContent=e.t(`panel_settings_ui_tag_layout_${i.layout}`));let o=M(s,"#jeMthBadgesOff");o&&(o.hidden=!!e.currentSettings?.statusTagsEnabled)};document.addEventListener("je:tag-layout-changed",ce),N.push(()=>document.removeEventListener("je:tag-layout-changed",ce));let V=M(s,".je-mth-shapes"),$e=()=>{if(g||!V)return;let i=document.activeElement,o=i?.closest(".je-mth-shape"),p=o instanceof HTMLElement&&i instanceof HTMLElement?{shape:o.dataset.shape,action:i.dataset.shapeAction,group:ae(i,"[data-shape-group]","shapeGroup"),value:i.dataset.value}:null;if(V.innerHTML=ve(),p){let r=`[data-shape="${p.shape}"] ${p.group?`[data-shape-group="${p.group}"] `:""}[data-shape-action="${p.action}"]${p.value?`[data-value="${p.value}"]`:""}`;Be(V.querySelector(r),{preventScroll:!0})}};function ae(i,o,p){let r=i.closest(o);return r instanceof HTMLElement?r.dataset[p]:void 0}document.addEventListener("je:tag-layout-changed",$e),N.push(()=>document.removeEventListener("je:tag-layout-changed",$e));let Le=i=>{let o=J(i,"[data-shape-action]"),p=o?.closest("[data-shape]");if(!o||_e(o)||!(p instanceof HTMLElement)||!V?.contains(p))return;let r=o.dataset.shapeAction??"";if(i.type==="change"!==bt.includes(r))return;let c=w(),f=p.dataset.shape;if(f!=="landscape"&&f!=="list")return;c.invalidateSettings();let T=c.readShapeOverrides(c.normalizeSettings().shapes);c.promoteLegacySettings(e.currentSettings);let _=T[f],K=xe(o)??"";if(r==="enabled"){let L=o instanceof HTMLInputElement&&o.checked;_=L?c.readShapeOverrides(c.RECOMMENDED_SHAPES)[f]:null,L&&te.add(f)}else if(r==="recommended")_=c.readShapeOverrides(c.RECOMMENDED_SHAPES)[f];else if(_){let L=ae(o,"[data-shape-group]","shapeGroup"),D=L&&c.normalizeGroup(L);if(r==="layout"&&st(K)&&(_.layout=K,_.slots=null),r==="density"&&(_.density=K),(r==="tagScale"||r==="tagGap")&&(K?_[r]=K:delete _[r]),r==="slot"&&D&&(_.slots={..._.slots||{},[D]:o.dataset.value??""}),r==="cap"&&D){let q=c.resolveLayout({shape:f}).caps[D],F=de(q,Number(o.dataset.value));if(F===null)return;_.caps={..._.caps||{},[D]:F}}}T[f]=_;let A=c.shapesToWire(T);if(A&&!ee(A))throw new TypeError("Shape overrides are not JSON");e.currentSettings.tagShapeOverrides=A&&ee(A)?A:{landscape:null,list:null},c.invalidateSettings(),e.saveUserSettings("settings.json",e.currentSettings),e.reinitializeTagLayout?.(),x?.follow(f==="landscape"?"episode":"list"),x?.refresh(),u()};V?.addEventListener("toggle",i=>{let o=i.target;if(!(o instanceof HTMLDetailsElement)||!o.matches("[data-shape-more]"))return;let p=ae(o,"[data-shape]","shape");p&&(o.open?te.add(p):te.delete(p))},!0),V?.addEventListener("change",Le),V?.addEventListener("click",Le),s.addEventListener("change",i=>{let o=i.target;if(!(o instanceof Element))return;(o instanceof HTMLInputElement?o.name:"")==="jeTagLayout"&&ne&&(ne.textContent=e.t(`panel_settings_ui_tag_layout_${xe(o)}`)),o.id==="statusTagsToggle"&&ce(),x?.refresh(),Ne.some(r=>r.id===o.id)&&x?.follow(["statusTagsScheduleToggle","statusTagsSeriesStatusToggle"].includes(o.id)?"series":o.id==="statusTagsMilestonesToggle"?"episode":"movie")}),s.addEventListener("click",i=>{let o=ye(i);if(!o)return;let p=J(i,"[data-je-jump]");if(p){let f=M(s,`#${p.dataset.jeJump}`);f&&(f.tabIndex=-1,f.scrollIntoView?.({block:"start"}),f.focus({preventScroll:!0}));return}let c=J(i,"[data-je-goto]")?.dataset.jeGoto;if(c?.startsWith("groups:")){let f=c.slice(7);G("groups");let T=s.querySelector(`.je-tge-row[data-group="${f}"]`),_=T?M(T,".je-tge-expand"):null;_?.getAttribute("aria-expanded")!=="true"&&_?.click(),_?.focus(),_?.scrollIntoView?.({block:"nearest"});return}if(o.closest("[data-je-config-link]")){l.closePanel?.();return}o.closest(".je-tge-expand, .je-tge-move")&&pe(),o.closest('button, input, [role="tab"]')&&x?.refresh()});let Se=n.wireTagPortable?.(s,l,{announce:W});typeof Se=="function"&&N.push(Se),m?.addEventListener("click",()=>{let i=m.getAttribute("aria-expanded")!=="true";m.setAttribute("aria-expanded",String(i)),s.classList.toggle("je-mth-strip-open",i),u()});function Qe(){if(z||!s?.querySelector("#jeTagPresetChoice"))return;z=!0;let i=Q();!i||!i.ajax||U(s,".je-mth-preset-chips").forEach(o=>{let p=o.dataset.preset,r=me();r.ajax({type:"GET",url:r.getUrl("JellyfinEnhanced/tag-styles",p&&p!=="server"?{preset:p}:void 0),dataType:"json"}).then(c=>{if(g||!o.isConnected)return;let f=R(c,"genre"),T=f!==null&&typeof f=="object"?f:{},_=Object.keys(T).find(C=>C!=="*"&&Reflect.get(T,C))||re,K=R(c,"quality"),A={quality:R(K,"4K")||R(K,"*"),status:R(R(c,"status"),"added"),rating:R(R(c,"rating"),"community"),genre:Reflect.get(T,_)||Reflect.get(T,"*")},L=o.querySelector('[data-chip="genre"]');if(L instanceof HTMLElement&&_!==re){L.dataset.jeGenre=_;let C=L.querySelector(".je-mth-chip-glyph");C&&(C.textContent=e.genreTags?.iconFor?.(_)||"theaters")}let D=R(c,"preset"),q=R(c,"posterGroups"),F=Array.isArray(q)?q:[],v=D==="poster"||F.length?e.tagPosterColours:null;U(o,"[data-chip]").forEach(C=>{let B=C.dataset.chip||"quality",Z=pt(B)?B:"quality",ie=D==="poster"?null:F,se=v&&(!ie||ie.includes(Z))?v.normalise(ht[Z]):null,ue={...v&&se?{background:v.css(se.background),color:v.css(se.text),border:v.css(se.border)}:ct[Z],...jt(A[Z])};C.style.setProperty("background",ue.background,"important"),C.style.setProperty("color",ue.color,"important"),C.style.setProperty("border-color",ue.border||"transparent","important")})}).catch(c=>console.warn("🪼 Jellyfin Enhanced: could not load a tag colour preset for the panel",c))})}let he=M(s,"#jeMthPreview"),Me=()=>{x||g||!he||(x=n.createTagPreview?.(he,{strip:M(s,"#jeMthStrip"),touch:u})||null,pe())};he&&typeof window.IntersectionObserver=="function"?($=new window.IntersectionObserver(i=>{i.some(o=>o.isIntersecting)&&($?.disconnect(),$=null,Me())}),$.observe(s)):Me();let Ee=()=>{let i=[],o=new Set;for(let p of U(s,'[role="tabpanel"]')){let r=h(S().tab[`${p.dataset.tab}`]),c=U(p,'input:not([type="hidden"]), select, button, a[href], [role="group"][aria-labelledby], [role="radiogroup"][aria-labelledby]');for(let f of c){if(f.closest("datalist, [data-je-cap-control][hidden]"))continue;let T=yt(f);if(!T)continue;let _=f.closest(".je-tge-row"),K=_?(_.querySelector(".je-tge-name")?.textContent||"").trim():"",A=[e.t("common_media_tags"),r,K].filter(Boolean).join(" › "),L=`${A}|${T}`;o.has(L)||(o.add(L),i.push({label:T,path:A,el:f}))}}return i},He=i=>{let o=i.closest('[role="tabpanel"]'),p=o instanceof HTMLElement?o:null,r=p?.dataset.tab||"layout",c=i.dataset.jeFocusKey||"",f=i.id,T=ae(i,"[data-je-rule-id]","jeRuleId")||"",_=!!i.closest(".je-tag-looks-locks"),K=i.closest(".je-tge-body"),A=K instanceof HTMLElement?K:null;if(p&&G(r),A?.hidden){let B=A.closest(".je-tge-row")?.querySelector(".je-tge-expand");B instanceof HTMLElement&&B.click()}let L=_?M(s,".je-tag-looks-locks-toggle"):null;L&&L.getAttribute("aria-expanded")==="false"&&L.offsetParent!==null&&L.click();let D=(B,Z)=>U(s,`[${B}]`).find(ie=>ie.getAttribute(B)===Z)||null,q=f?document.getElementById(f):null,F=document.getElementById(`jeMthPanel-${r}`),v=i.isConnected?i:c&&D("data-je-focus-key",c)||(q&&s.contains(q)?q:null)||T&&D("data-je-rule-id",T)||(F?M(F,".je-mth-card-title, .je-tge-title"):null)||b.find(B=>B.dataset.tab===r)||i,C=v.closest("details:not([open])");C instanceof HTMLDetailsElement&&(C.open=!0),v!==i&&!v.matches("button, input, select, a[href], [tabindex]")&&(v.tabIndex=-1),v.matches('[role="group"], [role="radiogroup"]')&&(v=M(v,"input:checked, button:not(:disabled), input:not(:disabled)")||v),_e(v)&&(v=(v.parentElement?M(v.parentElement,"button:not(:disabled), input:not(:disabled), select:not(:disabled)"):null)||v),v.scrollIntoView?.({block:"center"}),v.focus({preventScroll:!0})},Ke=l.registerSearch?.({pane:"media-tags",search(i){let o=i.split(/\s+/).filter(Boolean);if(!o.length)return[];let p=[];for(let r of Ee()){let c=r.label.toLowerCase(),f=`${r.path} ${r.label}`.toLowerCase();if(!o.every(_=>f.includes(_)))continue;let T=c.startsWith(i)?0:c.includes(i)?1:2;p.push({score:T,entry:r})}return p.sort((r,c)=>r.score-c.score),p.map(({entry:r})=>({label:r.label,path:r.path,run:()=>He(r.el)}))}});typeof Ke=="function"&&N.push(Ke);let Ae="layout";try{Ae=window.localStorage.getItem(I)||"layout"}catch{}G(Ae)||G("layout");let Ce=()=>{if(!g){g=!0,$?.disconnect(),$=null,x?.dispose(),x=null;for(let i=N.pop();i;i=N.pop())i();n.mediaTagsHub===Pe&&(n.mediaTagsHub=null)}},Pe={openTab:(i,o)=>G(i,o),announce:W,refreshPreview:()=>x?.refresh(),hasPreview:()=>!!x,searchIndex:Ee,reveal:He,dispose:Ce};n.mediaTagsHub=Pe,l.onClose?.(Ce)}}xt(ge());})();
})();
