(() => {
"use strict";(()=>{function pe(){let e=window;if(!e.JellyfinEnhanced)throw new TypeError("Jellyfin Enhanced must load before the settings panel");return e.JellyfinEnhanced}function de(){let e=U();if(!e)throw new ReferenceError("ApiClient is not defined");return e}function U(){return window.ApiClient}function ce(){return U()?.getCurrentUserId?.()||""}function Ee(e){return e.internals=e.internals||{},e.internals.enhancedUi=e.internals.enhancedUi||{}}function he(e){return e.target instanceof Element?e.target:null}function F(e,m){let f=he(e)?.closest(m);return f instanceof HTMLElement?f:null}function T(e,m){let f=e.querySelector(m);return f instanceof HTMLElement?f:null}function q(e,m){return Array.from(e.querySelectorAll(m)).filter(f=>f instanceof HTMLElement)}function ue(e){return e instanceof HTMLInputElement||e instanceof HTMLSelectElement||e instanceof HTMLTextAreaElement?e.value:void 0}function ge(e){return(e instanceof HTMLButtonElement||e instanceof HTMLInputElement||e instanceof HTMLSelectElement||e instanceof HTMLTextAreaElement||e instanceof HTMLFieldSetElement||e instanceof HTMLOptionElement)&&e.disabled}function He(e,m){(e instanceof HTMLElement||e instanceof SVGElement)&&e.focus(m)}function Y(e){return e===null||typeof e=="string"||typeof e=="boolean"?!0:typeof e=="number"?Number.isFinite(e):Array.isArray(e)?e.every(Y):typeof e=="object"?Object.values(e).every(Y):!1}var fe=["corners","bands","caption","summary","minimal"],Ve=e=>fe.some(m=>m===e),me=["default","glass","outline","dark","light","mono","poster"],Ue="Jellyfin Enhanced",Fe="media-tags",Ye="JE_mediaTagsTab:",Ce=[{key:"statusTagsJustAdded",id:"statusTagsJustAddedToggle",fallback:!0,nameKey:"status_tag_just_added",descKey:"panel_media_tags_badge_just_added_desc",chip:["added","added","status_tag_just_added"],windowKey:"panel_media_tags_badge_window_added",windowSetting:"StatusTagsJustAddedDays",windowFallback:7},{key:"statusTagsNewRelease",id:"statusTagsNewReleaseToggle",fallback:!0,nameKey:"panel_media_tags_badge_new_release",descKey:"panel_settings_ui_status_tags_new_release",chip:["new","newMovie","status_tag_new_movie"],windowKey:"panel_media_tags_badge_window_new",windowSetting:"StatusTagsNewReleaseDays",windowFallback:30},{key:"statusTagsTrending",id:"statusTagsTrendingToggle",fallback:!0,nameKey:"recommendations_trending",descKey:"panel_media_tags_badge_trending_desc",chip:["trending","trending","status_tag_trending_today"]},{key:"statusTagsSchedule",id:"statusTagsScheduleToggle",fallback:!0,nameKey:"panel_media_tags_badge_schedule",descKey:"panel_settings_ui_status_tags_schedule",chip:["schedule","airing_today","status_tag_airing_today"]},{key:"statusTagsMilestones",id:"statusTagsMilestonesToggle",fallback:!0,nameKey:"panel_media_tags_badge_milestones",descKey:"panel_settings_ui_status_tags_milestones",chip:["milestone","season_finale","status_tag_season_finale"]},{key:"statusTagsSeriesStatus",id:"statusTagsSeriesStatusToggle",fallback:!1,nameKey:"panel_media_tags_badge_series_status",descKey:"panel_settings_ui_status_tags_series_status",chip:["status","returning","status_tag_returning"]},{key:"statusTagsScenes",id:"statusTagsScenesToggle",fallback:!1,nameKey:"panel_media_tags_badge_scenes",descKey:"panel_settings_ui_status_tags_scenes",chip:["scenes","post_credits","status_tag_post_credits"]},{key:"statusTagsLeaving",id:"statusTagsLeavingToggle",fallback:!1,nameKey:"common_leaving_soon",descKey:"panel_media_tags_badge_leaving_desc",chip:["leaving","leaving","status_tag_leaving_days",{days:5}],requires:"LeavingSoonAvailable",requiresKey:"panel_media_tags_badge_leaving_unavailable"},{key:"statusTagsDirectPlay",id:"statusTagsDirectPlayToggle",fallback:!1,nameKey:"panel_media_tags_badge_direct_play",descKey:"panel_media_tags_badge_direct_play_desc",chip:["playback","direct_play","status_tag_transcode"]}],We=[{nameKey:"panel_media_tags_server_defaults",descKey:"panel_media_tags_server_defaults_desc",tab:"layout"},{nameKey:"panel_media_tags_server_colours",descKey:"panel_media_tags_server_colours_desc",tab:"colours"},{nameKey:"panel_media_tags_server_cache",descKey:"panel_media_tags_server_cache_desc",tab:"server"},{nameKey:"panel_media_tags_server_native",descKey:"panel_media_tags_server_native_desc",tab:"server"}],Xe=e=>e==="quality"||e==="status"||e==="rating"||e==="genre",Qe={quality:{background:"rgba(189, 5, 232, 0.95)",color:"#ffffff",border:"transparent"},status:{background:"rgba(15, 15, 15, 0.72)",color:"#ffffff",border:"rgba(255, 255, 255, 0.18)"},rating:{background:"rgba(0, 0, 0, 0.85)",color:"#ffc107",border:"transparent"},genre:{background:"rgba(10, 10, 10, 0.8)",color:"#E0E0E0",border:"rgba(255, 255, 255, 0.2)"}},te="drama",Ze={quality:[178,34,34],status:[30,60,140],rating:[20,120,130],genre:[96,40,128]},Je="https://n00bcodr.github.io/Jellyfin-Enhanced/enhanced/tags/",et={layout:"layouts",groups:"tag-groups-order-position-limits",badges:"badges-and-priority",rules:"rules-and-locked-items",colours:"tag-styles-and-css",server:"server-side-tag-cache"},tt=e=>new Map(Object.entries(et)).get(e),nt=["default","tight","flush"],at=["enabled","layout","density","tagScale","tagGap"],H=(e,m)=>e!==null&&typeof e=="object"?Reflect.get(e,m):void 0,it=e=>{let m={};for(let f of["background","color","border"]){let t=H(e,f);t&&(m[f]=String(t))}return m};function st(e){let m=R=>(R?.textContent||"").replace(/\s+/g," ").trim(),f=e.getAttribute("aria-label");if(f)return f.trim();let t=e.querySelector?.("[data-je-label]");if(t)return m(t);let A=e instanceof HTMLInputElement||e instanceof HTMLSelectElement||e instanceof HTMLButtonElement||e instanceof HTMLOutputElement||e instanceof HTMLTextAreaElement?e.labels?.[0]:void 0;if(A)return m(A.querySelector("[data-je-label]")||A);let I=e.getAttribute("aria-labelledby");return I?I.split(/\s+/).map(R=>m(document.getElementById(R))).join(" ").trim():m(e)}function lt(e){let m=Ee(e),f=i=>e.escapeHtml(String(i)),t=(i,a)=>f(e.t(i??"",a)),A=(i,a)=>e.t(i??"",a),I=()=>e.helpers?.isAdmin?e.helpers.isAdmin():e.currentSettings?.isAdmin===!0,R=()=>e.pluginConfig?.TagStylesAllowUserPreset===!0,W=()=>{let i=e.core?.tagLayout;if(!i)throw new TypeError("The tag layout controller is unavailable");return i},G=()=>W().VOCABULARY_KEYS;function Ae(){let i=[{id:"layout",nameKey:"common_layout",icon:"view_quilt"},{id:"groups",nameKey:"common_groups",icon:"label"},{id:"badges",nameKey:"panel_media_tags_tab_badges",shortKey:"common_badges",icon:"new_releases"},{id:"rules",nameKey:"panel_media_tags_tab_rules",shortKey:"common_rules",icon:"rule"}];return(R()||I())&&i.push({id:"colours",nameKey:"common_colours",icon:"palette"}),I()&&i.push({id:"server",nameKey:"common_server",admin:!0,icon:"dns"}),i}function Pe(i,a){let d=e.currentSettings?.[i];if(typeof d=="boolean")return d;let o=e.pluginConfig?.[i.charAt(0).toUpperCase()+i.slice(1)];return typeof o=="boolean"?o:a}function ne(i){return`${`${window.location.origin}${window.location.pathname}`}#/configurationpage?name=${encodeURIComponent(Ue)}&jeSection=${Fe}${i?`&tab=${encodeURIComponent(i)}`:""}`}function je(){let i=e.core?.tagLayout;return i?(i.invalidateSettings(),i.normalizeSettings()):{layout:"corners",density:"full",edge:"default"}}function ae(i,a,d,o){return`
            <label class="je-mth-switch">
                <input type="checkbox" id="${i}" ${a?"checked":""} aria-describedby="${i}Desc">
                <span class="je-mth-switch-text">
                    <span class="je-mth-switch-name" data-je-label>${t(d)}</span>
                    <span class="je-mth-switch-desc" id="${i}Desc">${t(o)}</span>
                </span>
            </label>`}let X=new Set,ie=(i,a)=>{let d=m.tagGroupEditorData;if(!d)throw new TypeError("The tag group editor is unavailable");return d.stepCap(i,a,{capAll:!0})};function Ke(i){let a=W(),d=a.normalizeSettings().shapes[i],o=a.resolveLayout({shape:i}),g=e.t(`tag_shapes_${i}`),y=[A(a.VOCABULARY_KEYS.layout[o.layout]),e.t(`panel_settings_ui_tag_density_${o.density}`),d?.tagScale?a.sizeLabel("scale",d.tagScale):""].filter(Boolean).join(" · "),h=(c,j)=>{let w=j==="scale"?"tagScale":"tagGap",M=j==="scale"?a.TAG_SCALES:a.TAG_GAPS,P=c[w];return`<label>${t(`tag_${j}_label`)}<select data-shape-action="${w}" aria-label="${f(g)}: ${t(`tag_${j}_label`)}">
                        <option value="" ${P?"":"selected"}>${t("tag_size_inherit")}</option>
                        ${Object.keys(M).map(O=>`<option value="${O}" ${P===O?"selected":""}>${f(a.sizeLabel(j,O))}</option>`).join("")}
                    </select></label>`},L=d?`
            <details class="je-mth-shape-more" data-shape-more ${X.has(i)?"open":""}>
            <summary class="je-mth-shape-summary"><span class="je-mth-shape-summary-text">${f(y)}</span><span class="je-mth-shape-summary-action">${t("tag_shapes_edit")}<span class="material-icons" aria-hidden="true">expand_more</span></span></summary>
            <div class="je-mth-shape-fields">
                <label>${t("panel_settings_ui_tag_layout")}<select data-shape-action="layout" aria-label="${t("tag_shapes_layout_for",{shape:g})}">
                    ${fe.map(c=>`<option value="${c}" ${o.layout===c?"selected":""}>${t(a.VOCABULARY_KEYS.layout[c])}</option>`).join("")}
                </select></label>
                <label>${t("panel_settings_ui_tag_density")}<select data-shape-action="density" aria-label="${t("tag_shapes_density_for",{shape:g})}">
                    ${["full","compact"].map(c=>`<option value="${c}" ${o.density===c?"selected":""}>${t(`panel_settings_ui_tag_density_${c}`)}</option>`).join("")}
                </select></label>
                ${h(d,"scale")}${h(d,"gap")}
                <button type="button" class="je-mth-button" data-shape-action="recommended">${t("tag_shapes_recommended")}</button>
            </div>
            <div class="je-mth-shape-groups">${a.DEFAULT_ORDER.map(c=>{let j=A(a.VOCABULARY_KEYS.group[`${c==="ageRating"?"age_rating":c}`]),w=o.caps[c];return`<div class="je-mth-shape-group" data-shape-group="${c}">
                    <span class="je-mth-label">${f(j)}</span>
                    <div class="je-mth-shape-positions" role="group" aria-label="${t("tag_shapes_position_for",{group:j,shape:g})}">
                        ${a.LAYOUT_SLOTS[o.layout].filter(M=>M!=="dots"||c==="quality").map(M=>`<button type="button" data-shape-action="slot" data-value="${M}" aria-pressed="${o.slots[c]===M}">${t(M==="off"?"panel_settings_ui_tag_slot_off":a.VOCABULARY_KEYS.slot[`${o.layout}_${M}`])}</button>`).join("")}
                    </div>
                    <div class="je-mth-shape-cap" data-je-cap-control ${a.singleChipGroup(c)?"hidden":""} role="group" aria-label="${t("tag_shapes_cap_for",{group:j,shape:g})}">
                        <button type="button" data-shape-action="cap" data-value="-1" ${ie(w,-1)===null?"disabled":""} aria-label="${t("tag_shapes_fewer",{group:j})}">−</button>
                        <output aria-live="polite">${w===0?t("panel_settings_ui_tag_editor_summary_all"):w}</output>
                        <button type="button" data-shape-action="cap" data-value="1" ${ie(w,1)===null?"disabled":""} aria-label="${t("tag_shapes_more",{group:j})}">+</button>
                    </div>
                </div>`}).join("")}</div>
            </details>`:"";return`<section class="je-mth-card je-mth-shape" data-shape="${i}" aria-labelledby="jeShape-${i}">
            <h4 class="je-mth-card-title" id="jeShape-${i}">${f(g)}</h4>
            <label class="je-mth-shape-toggle"><input type="checkbox" data-shape-action="enabled" ${d?"checked":""}>${t("tag_shapes_different")}</label>
            ${L}
        </section>`}function be(){return e.core?.tagLayout?e.core.tagLayout.SHAPES.map(Ke).join(""):""}function ye(i,a){let d=i==="scale"?"Scale":"Gap",o=W(),g=i==="scale"?o.TAG_SCALES:o.TAG_GAPS,y=i==="scale"?a.tagScale:a.tagGap;return`<div class="je-mth-density">
            <div class="je-mth-field-text">
                <span class="je-mth-label" id="jeMth${d}Label">${t(`tag_${i}_label`)}</span>
                <span class="je-mth-hint" id="jeMth${d}Desc">${t(`tag_${i}_desc`)}</span>
            </div>
            <div class="je-mth-pills" id="jeTag${d}Choice" role="radiogroup" aria-labelledby="jeMth${d}Label" aria-describedby="jeMth${d}Desc">
                ${Object.keys(g).map(h=>`<label class="je-mth-pill"><input type="radio" name="jeTag${d}" value="${h}" ${y===h?"checked":""}><span data-je-label>${f(o.sizeLabel(i,h))}</span></label>`).join("")}
            </div>
        </div>`}function ze(){let i=je(),a=fe.map(y=>`
            <label class="je-mth-tile">
                <input type="radio" name="jeTagLayout" value="${y}" ${i.layout===y?"checked":""}>
                <span class="je-mth-tile-art" data-layout="${y}" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
                <span class="je-mth-tile-name" data-je-label>${t(G().layout[y])}</span>
            </label>`).join(""),d=["full","compact"].map(y=>`
            <label class="je-mth-pill">
                <input type="radio" name="jeTagDensity" value="${y}" ${i.density===y?"checked":""}>
                <span data-je-label>${t(`panel_settings_ui_tag_density_${y}`)}</span>
            </label>`).join(""),o=nt.map(y=>`
            <label class="je-mth-pill">
                <input type="radio" name="jeTagEdge" value="${y}" ${i.edge===y?"checked":""}>
                <span data-je-label>${t(G().edge[y])}</span>
            </label>`).join(""),g=e.pluginConfig?.NativePosterTagsEnabled===!0?ae("nativePosterTagsToggle",e.currentSettings.useNativePosterTags!==!1,"panel_settings_ui_native_poster_tags","panel_settings_ui_native_poster_tags_desc"):"";return`
            <section class="je-mth-card" aria-labelledby="jeMthLayoutTitle">
                <div class="je-mth-card-head"><h4 class="je-mth-card-title" id="jeMthLayoutTitle">${t("common_layout")}</h4>
                    <button type="button" class="je-mth-button je-mth-jump" data-je-jump="jeMthPresetsTitle"><span class="material-icons" aria-hidden="true">auto_awesome</span>${t("panel_media_tags_browse_presets")}</button></div>
                <p class="je-mth-hint">${t("panel_media_tags_layout_desc")}</p>
                <div class="je-mth-tiles" id="jeTagLayoutChoice" role="radiogroup" aria-labelledby="jeMthLayoutTitle" aria-describedby="jeMthLayoutDesc">${a}</div>
                <p class="je-mth-desc" id="jeMthLayoutDesc" aria-live="polite">${t(`panel_settings_ui_tag_layout_${i.layout}`)}</p>
                <div class="je-mth-density">
                    <div class="je-mth-field-text">
                        <span class="je-mth-label" id="jeMthDensityLabel">${t("panel_settings_ui_tag_density")}</span>
                        <span class="je-mth-hint" id="jeMthDensityDesc">${t("panel_settings_ui_tag_density_desc")}</span>
                    </div>
                    <div class="je-mth-pills" id="jeTagDensityChoice" role="radiogroup" aria-labelledby="jeMthDensityLabel" aria-describedby="jeMthDensityDesc">${d}</div>
                </div>
                ${ye("scale",i)}
                ${ye("gap",i)}
                <div class="je-mth-density je-mth-edge">
                    <div class="je-mth-field-text">
                        <span class="je-mth-label" id="jeMthEdgeLabel">${t("panel_settings_ui_tag_edge")}</span>
                        <span class="je-mth-hint" id="jeMthEdgeDesc">${t("panel_settings_ui_tag_edge_desc")}</span>
                    </div>
                    <div class="je-mth-pills" id="jeTagEdgeChoice" role="radiogroup" aria-labelledby="jeMthEdgeLabel" aria-describedby="jeMthEdgeDesc">${o}</div>
                </div>
            </section>
            <div class="je-mth-shapes">${be()}</div>
            <p class="je-mth-hint je-mth-shapes-note">${t("tag_shapes_limitations")}</p>
            <section class="je-mth-card" aria-labelledby="jeMthSwitchesTitle">
                <h4 class="je-mth-card-title" id="jeMthSwitchesTitle">${t("panel_media_tags_switches_title")}</h4>
                <p class="je-mth-hint">${t("panel_media_tags_switches_desc")}</p>
                <div class="je-mth-switches">
                    ${ae("tagsHideOnHoverToggle",!!e.currentSettings.tagsHideOnHover,"panel_settings_ui_hide_tags_on_hover","panel_settings_ui_hide_tags_on_hover_desc")}
                    ${g}
                    ${ae("peopleTagsToggle",!!e.currentSettings.peopleTagsEnabled,"panel_settings_ui_people_tags","panel_settings_ui_people_tags_desc")}
                    <p class="je-mth-hint" data-je-scope-na="people">${t("tag_scope_people_na")}</p>
                </div>
            </section>
            ${m.buildTagPortableHtml?.()||""}`}function Ie([i,a,d,o]){if(i==="trending"){let[g="",y=""]=e.t(d,{rank:""}).split(""),h=g.endsWith("#")?"#":"";return`<span class="status-tag status-tag--${i}" data-je-status="${a}">${f(g.slice(0,g.length-h.length))}<span class="status-tag-rank">${h}1</span>${f(y)}</span>`}return`<span class="status-tag status-tag--${i}" data-je-status="${a}">${t(d,o)}</span>`}function Be(){let i=I(),a=Ce.map(o=>{let g=Number(o.windowSetting?e.pluginConfig?.[o.windowSetting]:void 0)||(o.windowFallback??NaN),y=o.windowKey?`<span class="je-mth-badge-window">${t(o.windowKey,{days:g})}</span>`:o.requires&&e.pluginConfig?.[o.requires]!==!0?`<span class="je-mth-badge-requires">${t(o.requiresKey)}</span>`:"";return`
                <div class="je-quality-cat-row je-mth-badge" data-cat-key="${o.key}">
                    <label class="je-mth-badge-main">
                        <input type="checkbox" id="${o.id}" ${Pe(o.key,o.fallback)?"checked":""} aria-describedby="${o.id}Desc">
                        <span class="je-mth-badge-text">
                            <span class="je-mth-badge-name" data-je-label>${t(o.nameKey)}</span>
                            <span class="je-mth-badge-desc" id="${o.id}Desc">${t(o.descKey)}${y?" · ":""}${y}</span>
                        </span>
                    </label>
                    <span class="je-mth-badge-sample" aria-hidden="true">${Ie(o.chip)}</span>
                </div>`}).join(""),d=i?`
            <a class="je-mth-link" href="${f(ne("badges"))}" data-je-config-link>${t("panel_media_tags_badge_windows_admin")}<span class="material-icons" aria-hidden="true">open_in_new</span></a>`:"";return`
            <section class="je-mth-card" aria-labelledby="jeMthBadgesTitle">
                <h4 class="je-mth-card-title" id="jeMthBadgesTitle" tabindex="-1">${t("panel_media_tags_tab_badges")}</h4>
                <p class="je-mth-hint">${t("panel_media_tags_badges_desc")}</p>
                <div class="je-mth-off je-mth-off--action" id="jeMthBadgesOff" ${e.currentSettings.statusTagsEnabled?"hidden":""}><span>${t("panel_media_tags_badges_off")}</span>
                    <button type="button" class="je-mth-button" data-je-goto="groups:status">${t("panel_media_tags_badges_turn_on")}<span class="material-icons" aria-hidden="true">arrow_forward</span></button></div>
                <div id="statusTagsSubToggles" class="je-mth-badges">${a}</div>
                <div class="je-mth-actions">
                    <button type="button" class="je-mth-button" data-je-goto="groups:status">${t("panel_media_tags_badges_to_groups")}<span class="material-icons" aria-hidden="true">arrow_forward</span></button>
                    ${d}
                </div>
            </section>`}function De(){return`
            <section class="je-mth-card" aria-labelledby="jeTagLooksTitle">
                <h4 class="je-mth-card-title" id="jeTagLooksTitle">${t("panel_media_tags_tab_rules")}</h4>
                <p class="je-mth-hint">${t("tag_looks_hub_desc")}</p>
                <div id="jeTagLooksMount"></div>
            </section>`}function qe(){let i=I(),a;if(R()){let o=e.currentSettings.tagStylePreset,g=e.pluginConfig.TagStylePreset,y=typeof o=="string"&&me.includes(o)?o:"",h=typeof g=="string"&&me.includes(g)?g:"default",L=(c,j,w="")=>`
                <label class="je-mth-preset">
                    <input type="radio" name="jeTagPreset" value="${c}" ${y===c?"checked":""}>
                    <span class="je-mth-preset-chips" data-preset="${c||"server"}" aria-hidden="true">
                        <span class="je-mth-chip" data-chip="quality">4K</span><span class="je-mth-chip" data-chip="status">${t("status_tag_compact_added")}</span><span class="je-mth-chip" data-chip="rating">★ 8.1</span><span class="je-mth-chip je-mth-chip-genre" data-chip="genre" data-je-genre="${te}"><i class="je-mth-chip-glyph">${f(e.genreTags?.iconFor?.(te)||"theater_comedy")}</i></span>
                    </span>
                    <span class="je-mth-preset-name" data-je-label>${f(j)}</span>${w?`<span class="je-mth-preset-sub">${f(w)}</span>`:""}
                </label>`;a=`
                <div class="je-mth-presets" id="jeTagPresetChoice" role="radiogroup" aria-labelledby="jeMthColoursTitle" aria-describedby="jeMthColoursDesc">
                    ${L("",e.t("panel_settings_ui_tag_style_preset_follow"),e.t("panel_settings_ui_tag_style_preset_server",{preset:A(G().preset[h])}))}
                    ${me.map(c=>L(c,A(G().preset[c]))).join("")}
                </div>`}else a=`<p class="je-mth-off">${t("panel_media_tags_colours_presets_off")}</p>`;let d=i?`
            <section class="je-mth-card je-mth-admin" aria-labelledby="jeMthColourEditorTitle">
                <div class="je-mth-pointer">
                    <div>
                        <h4 class="je-mth-card-title" id="jeMthColourEditorTitle">${t("panel_media_tags_server_colours")} <span class="je-mth-admin-chip">${t("common_admin")}</span></h4>
                        <p class="je-mth-hint">${t("panel_media_tags_server_colours_desc")}</p>
                    </div>
                    <a class="je-mth-button" href="${f(ne("colours"))}" data-je-config-link aria-label="${t("panel_media_tags_open_named",{name:e.t("panel_media_tags_server_colours")})}">${t("common_open")}<span class="material-icons" aria-hidden="true">open_in_new</span></a>
                </div>
            </section>`:"";return`
            <section class="je-mth-card" aria-labelledby="jeMthColoursTitle">
                <h4 class="je-mth-card-title" id="jeMthColoursTitle">${t("panel_settings_ui_tag_style_preset")}</h4>
                <p class="je-mth-hint" id="jeMthColoursDesc">${t("panel_settings_ui_tag_style_preset_desc")}</p>
                ${a}
            </section>
            ${d}`}function Re(){let i=We.map(a=>`
            <li class="je-mth-pointer">
                <div>
                    <div class="je-mth-pointer-name" data-je-label>${t(a.nameKey)}</div>
                    <div class="je-mth-hint">${t(a.descKey)}</div>
                </div>
                <a class="je-mth-button" href="${f(ne(a.tab))}" data-je-config-link aria-label="${t("panel_media_tags_open_named",{name:e.t(a.nameKey)})}">${t("common_open")}<span class="material-icons" aria-hidden="true">open_in_new</span></a>
            </li>`).join("");return`
            <section class="je-mth-card je-mth-admin" aria-labelledby="jeMthServerTitle">
                <h4 class="je-mth-card-title" id="jeMthServerTitle">${t("panel_media_tags_server_title")} <span class="je-mth-admin-chip">${t("common_admin")}</span></h4>
                <p class="je-mth-hint">${t("panel_media_tags_server_desc")}</p>
                <ul class="je-mth-pointers">${i}</ul>
            </section>`}m.buildMediaTagsHubHtml=function(i){let a=Ae(),d={layout:ze,groups:()=>m.buildTagGroupEditorHtml?.(i)||"",badges:Be,rules:De,colours:qe,server:Re},o=a.map((h,L)=>{let c=e.t(h.nameKey),j=h.shortKey?e.t(h.shortKey):c,w=h.admin?e.t("panel_media_tags_tab_server_name",{name:c}):c;return`<button type="button" role="tab" class="je-mth-tab${h.admin?" je-mth-tab--admin":""}" id="jeMthTab-${h.id}" data-tab="${h.id}" aria-controls="jeMthPanel-${h.id}" aria-selected="${L===0}" tabindex="${L===0?0:-1}" aria-label="${f(w)}"><span class="material-icons je-mth-tab-icon" aria-hidden="true">${h.icon}</span><span class="je-mth-tab-long">${f(c)}</span><span class="je-mth-tab-short" aria-hidden="true">${f(j)}</span>`+(h.admin?`<span class="je-mth-admin-chip" aria-hidden="true">${t("common_admin")}</span>`:"")+"</button>"}).join(""),g=h=>`<p class="je-mth-docs"><a href="${Je}#${tt(h.id)}" target="_blank" rel="noopener" aria-label="${t("media_tags_docs_link_label",{name:e.t(h.nameKey)})}"><span class="material-icons" aria-hidden="true">menu_book</span>${t("media_tags_docs_link")}</a></p>`,y=a.map((h,L)=>`
            <div class="je-mth-panel" role="tabpanel" id="jeMthPanel-${h.id}" data-tab="${h.id}" aria-labelledby="jeMthTab-${h.id}" ${L===0?"":"hidden"}>${d[h.id]?.()??""}${g(h)}</div>`).join("");return`
            <section class="je-pane" data-pane="media-tags">
                <div class="je-mth" id="jeMediaTagsHub" data-tab="${a[0]?.id}">
                    <div class="je-mth-top">
                        <h3 class="je-pane-title">${e.icon(e.IconName.TAG)} ${t("common_media_tags")}</h3>
                        <div class="je-mth-tabs" role="tablist" aria-label="${t("common_media_tags")}">${o}</div>
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
                        <div class="je-mth-panels">${y}</div>
                    </div>
                    <div class="je-mth-live" id="jeMthLive" role="status" aria-live="polite"></div>
                </div>
            </section>`};let Oe=`
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
    `;m.wireMediaTagsHub=function(i){m.mediaTagsHub?.dispose?.();let a=document.getElementById("jeMediaTagsHub");if(!a)return;e.core.ui?.injectCss?.("je-media-tags-hub",Oe),a.style.setProperty("--je-mth-accent",i.toggleAccentColor||"#00a4dc"),a.style.setProperty("--je-mth-box",i.presetBoxBackground||"rgba(255,255,255,0.04)");let d=()=>{try{i.resetAutoCloseTimer?.()}catch{}},o=T(a,'[role="tablist"]'),g=q(a,'[role="tab"]'),y=T(a,"#jeMthLive");if(!o||!y)throw new TypeError("The Media Tags hub markup is incomplete");let h=T(a,"#jeMthStripToggle"),L=`${Ye}${ce()}`,c=!1,j=null,w=null,M=!1,P=[],O=n=>{y.textContent="",setTimeout(()=>{c||(y.textContent=n)},30)},Ne=()=>a.dataset.tab||"layout",se=()=>{if(!j)return;let n=Ne(),s=null;if(n==="badges")s="status";else if(n==="groups"){let l=a.querySelector('.je-tge-row .je-tge-expand[aria-expanded="true"]')?.closest(".je-tge-row");s=l instanceof HTMLElement&&l.dataset.group||null}j.setSpotlight(s),j.follow(n==="rules"?"episode":"movie")},B=(n,s={})=>{let r=g.find(l=>l.dataset.tab===n);if(!r)return!1;for(let l of g){let p=l===r;l.setAttribute("aria-selected",String(p)),l.tabIndex=p?0:-1;let u=document.getElementById(`jeMthPanel-${l.dataset.tab}`);u&&(u.hidden=!p)}a.dataset.tab=n;try{window.localStorage.setItem(L,n)}catch{}if(n==="rules"&&m.tagLooksPanel?.show?.(),n==="colours"&&Ge(),se(),s.focusTab&&r.focus(),s.focus){let l=document.getElementById(`jeMthPanel-${n}`),p=l?T(l,".je-mth-card-title, .je-tge-title"):null;p&&(p.tabIndex=-1,p.focus())}return d(),!0};o.addEventListener("click",n=>{let s=F(n,'[role="tab"]');s&&B(s.dataset.tab||"layout")}),o.addEventListener("keydown",n=>{let s=g.findIndex(u=>u===document.activeElement);if(s<0)return;let r=-1,l=getComputedStyle(o).direction==="rtl"||o.closest("[dir]")?.getAttribute("dir")==="rtl"?-1:1;n.key==="ArrowRight"?r=(s+l+g.length)%g.length:n.key==="ArrowLeft"?r=(s-l+g.length)%g.length:n.key==="Home"?r=0:n.key==="End"&&(r=g.length-1);let p=g[r];r<0||!p||(n.preventDefault(),B(p.dataset.tab||"layout",{focusTab:!0}))});let Q=a.querySelector("#jeMthLayoutDesc"),V=(n,s)=>{a.querySelectorAll(`input[name="${n}"]`).forEach(r=>{r instanceof HTMLInputElement&&(r.checked=r.value===s)})},le=()=>{if(c)return;let n=je();V("jeTagLayout",n.layout),V("jeTagDensity",n.density),V("jeTagScale",n.tagScale),V("jeTagGap",n.tagGap),V("jeTagEdge",n.edge),Q&&(Q.textContent=e.t(`panel_settings_ui_tag_layout_${n.layout}`));let s=T(a,"#jeMthBadgesOff");s&&(s.hidden=!!e.currentSettings?.statusTagsEnabled)};document.addEventListener("je:tag-layout-changed",le),P.push(()=>document.removeEventListener("je:tag-layout-changed",le));let D=T(a,".je-mth-shapes"),xe=()=>{if(c||!D)return;let n=document.activeElement,s=n?.closest(".je-mth-shape"),r=s instanceof HTMLElement&&n instanceof HTMLElement?{shape:s.dataset.shape,action:n.dataset.shapeAction,group:Z(n,"[data-shape-group]","shapeGroup"),value:n.dataset.value}:null;if(D.innerHTML=be(),r){let l=`[data-shape="${r.shape}"] ${r.group?`[data-shape-group="${r.group}"] `:""}[data-shape-action="${r.action}"]${r.value?`[data-value="${r.value}"]`:""}`;He(D.querySelector(l),{preventScroll:!0})}};function Z(n,s,r){let l=n.closest(s);return l instanceof HTMLElement?l.dataset[r]:void 0}document.addEventListener("je:tag-layout-changed",xe),P.push(()=>document.removeEventListener("je:tag-layout-changed",xe));let _e=n=>{let s=F(n,"[data-shape-action]"),r=s?.closest("[data-shape]");if(!s||ge(s)||!(r instanceof HTMLElement)||!D?.contains(r))return;let l=s.dataset.shapeAction??"";if(n.type==="change"!==at.includes(l))return;let p=W(),u=r.dataset.shape;if(u!=="landscape"&&u!=="list")return;p.invalidateSettings();let _=p.readShapeOverrides(p.normalizeSettings().shapes);p.promoteLegacySettings(e.currentSettings);let b=_[u],$=ue(s)??"";if(l==="enabled"){let v=s instanceof HTMLInputElement&&s.checked;b=v?p.readShapeOverrides(p.RECOMMENDED_SHAPES)[u]:null,v&&X.add(u)}else if(l==="recommended")b=p.readShapeOverrides(p.RECOMMENDED_SHAPES)[u];else if(b){let v=Z(s,"[data-shape-group]","shapeGroup"),E=v&&p.normalizeGroup(v);if(l==="layout"&&Ve($)&&(b.layout=$,b.slots=null),l==="density"&&(b.density=$),(l==="tagScale"||l==="tagGap")&&($?b[l]=$:delete b[l]),l==="slot"&&E&&(b.slots={...b.slots||{},[E]:s.dataset.value??""}),l==="cap"&&E){let K=p.resolveLayout({shape:u}).caps[E],z=ie(K,Number(s.dataset.value));if(z===null)return;b.caps={...b.caps||{},[E]:z}}}_[u]=b;let k=p.shapesToWire(_);if(k&&!Y(k))throw new TypeError("Shape overrides are not JSON");e.currentSettings.tagShapeOverrides=k&&Y(k)?k:{landscape:null,list:null},p.invalidateSettings(),e.saveUserSettings("settings.json",e.currentSettings),e.reinitializeTagLayout?.(),j?.follow(u==="landscape"?"episode":"list"),j?.refresh(),d()};D?.addEventListener("toggle",n=>{let s=n.target;if(!(s instanceof HTMLDetailsElement)||!s.matches("[data-shape-more]"))return;let r=Z(s,"[data-shape]","shape");r&&(s.open?X.add(r):X.delete(r))},!0),D?.addEventListener("change",_e),D?.addEventListener("click",_e),a.addEventListener("change",n=>{let s=n.target;if(!(s instanceof Element))return;(s instanceof HTMLInputElement?s.name:"")==="jeTagLayout"&&Q&&(Q.textContent=e.t(`panel_settings_ui_tag_layout_${ue(s)}`)),s.id==="statusTagsToggle"&&le(),j?.refresh(),Ce.some(l=>l.id===s.id)&&j?.follow(["statusTagsScheduleToggle","statusTagsSeriesStatusToggle"].includes(s.id)?"series":s.id==="statusTagsMilestonesToggle"?"episode":"movie")}),a.addEventListener("click",n=>{let s=he(n);if(!s)return;let r=F(n,"[data-je-jump]");if(r){let u=T(a,`#${r.dataset.jeJump}`);u&&(u.tabIndex=-1,u.scrollIntoView?.({block:"start"}),u.focus({preventScroll:!0}));return}let p=F(n,"[data-je-goto]")?.dataset.jeGoto;if(p?.startsWith("groups:")){let u=p.slice(7);B("groups");let _=a.querySelector(`.je-tge-row[data-group="${u}"]`),b=_?T(_,".je-tge-expand"):null;b?.getAttribute("aria-expanded")!=="true"&&b?.click(),b?.focus(),b?.scrollIntoView?.({block:"nearest"});return}if(s.closest("[data-je-config-link]")){i.closePanel?.();return}s.closest(".je-tge-expand, .je-tge-move")&&se(),s.closest('button, input, [role="tab"]')&&j?.refresh()});let we=m.wireTagPortable?.(a,i,{announce:O});typeof we=="function"&&P.push(we),h?.addEventListener("click",()=>{let n=h.getAttribute("aria-expanded")!=="true";h.setAttribute("aria-expanded",String(n)),a.classList.toggle("je-mth-strip-open",n),d()});function Ge(){if(M||!a?.querySelector("#jeTagPresetChoice"))return;M=!0;let n=U();!n||!n.ajax||q(a,".je-mth-preset-chips").forEach(s=>{let r=s.dataset.preset,l=de();l.ajax({type:"GET",url:l.getUrl("JellyfinEnhanced/tag-styles",r&&r!=="server"?{preset:r}:void 0),dataType:"json"}).then(p=>{if(c||!s.isConnected)return;let u=H(p,"genre"),_=u!==null&&typeof u=="object"?u:{},b=Object.keys(_).find(S=>S!=="*"&&Reflect.get(_,S))||te,$=H(p,"quality"),k={quality:H($,"4K")||H($,"*"),status:H(H(p,"status"),"added"),rating:H(H(p,"rating"),"community"),genre:Reflect.get(_,b)||Reflect.get(_,"*")},v=s.querySelector('[data-chip="genre"]');if(v instanceof HTMLElement&&b!==te){v.dataset.jeGenre=b;let S=v.querySelector(".je-mth-chip-glyph");S&&(S.textContent=e.genreTags?.iconFor?.(b)||"theaters")}let E=H(p,"preset"),K=H(p,"posterGroups"),z=Array.isArray(K)?K:[],x=E==="poster"||z.length?e.tagPosterColours:null;q(s,"[data-chip]").forEach(S=>{let C=S.dataset.chip||"quality",N=Xe(C)?C:"quality",J=E==="poster"?null:z,ee=x&&(!J||J.includes(N))?x.normalise(Ze[N]):null,re={...x&&ee?{background:x.css(ee.background),color:x.css(ee.text),border:x.css(ee.border)}:Qe[N],...it(k[N])};S.style.setProperty("background",re.background,"important"),S.style.setProperty("color",re.color,"important"),S.style.setProperty("border-color",re.border||"transparent","important")})}).catch(p=>console.warn("🪼 Jellyfin Enhanced: could not load a tag colour preset for the panel",p))})}let oe=T(a,"#jeMthPreview"),ve=()=>{j||c||!oe||(j=m.createTagPreview?.(oe,{strip:T(a,"#jeMthStrip"),touch:d})||null,se())};oe&&typeof window.IntersectionObserver=="function"?(w=new window.IntersectionObserver(n=>{n.some(s=>s.isIntersecting)&&(w?.disconnect(),w=null,ve())}),w.observe(a)):ve();let Te=()=>{let n=[],s=new Set;for(let r of q(a,'[role="tabpanel"]')){let l=A(G().tab[`${r.dataset.tab}`]),p=q(r,'input:not([type="hidden"]), select, button, a[href], [role="group"][aria-labelledby], [role="radiogroup"][aria-labelledby]');for(let u of p){if(u.closest("datalist, [data-je-cap-control][hidden]"))continue;let _=st(u);if(!_)continue;let b=u.closest(".je-tge-row"),$=b?(b.querySelector(".je-tge-name")?.textContent||"").trim():"",k=[e.t("common_media_tags"),l,$].filter(Boolean).join(" › "),v=`${k}|${_}`;s.has(v)||(s.add(v),n.push({label:_,path:k,el:u}))}}return n},$e=n=>{let s=n.closest('[role="tabpanel"]'),r=s instanceof HTMLElement?s:null,l=r?.dataset.tab||"layout",p=n.dataset.jeFocusKey||"",u=n.id,_=Z(n,"[data-je-rule-id]","jeRuleId")||"",b=!!n.closest(".je-tag-looks-locks"),$=n.closest(".je-tge-body"),k=$ instanceof HTMLElement?$:null;if(r&&B(l),k?.hidden){let C=k.closest(".je-tge-row")?.querySelector(".je-tge-expand");C instanceof HTMLElement&&C.click()}let v=b?T(a,".je-tag-looks-locks-toggle"):null;v&&v.getAttribute("aria-expanded")==="false"&&v.offsetParent!==null&&v.click();let E=(C,N)=>q(a,`[${C}]`).find(J=>J.getAttribute(C)===N)||null,K=u?document.getElementById(u):null,z=document.getElementById(`jeMthPanel-${l}`),x=n.isConnected?n:p&&E("data-je-focus-key",p)||(K&&a.contains(K)?K:null)||_&&E("data-je-rule-id",_)||(z?T(z,".je-mth-card-title, .je-tge-title"):null)||g.find(C=>C.dataset.tab===l)||n,S=x.closest("details:not([open])");S instanceof HTMLDetailsElement&&(S.open=!0),x!==n&&!x.matches("button, input, select, a[href], [tabindex]")&&(x.tabIndex=-1),x.matches('[role="group"], [role="radiogroup"]')&&(x=T(x,"input:checked, button:not(:disabled), input:not(:disabled)")||x),ge(x)&&(x=(x.parentElement?T(x.parentElement,"button:not(:disabled), input:not(:disabled), select:not(:disabled)"):null)||x),x.scrollIntoView?.({block:"center"}),x.focus({preventScroll:!0})},ke=i.registerSearch?.({pane:"media-tags",search(n){let s=n.split(/\s+/).filter(Boolean);if(!s.length)return[];let r=[];for(let l of Te()){let p=l.label.toLowerCase(),u=`${l.path} ${l.label}`.toLowerCase();if(!s.every(b=>u.includes(b)))continue;let _=p.startsWith(n)?0:p.includes(n)?1:2;r.push({score:_,entry:l})}return r.sort((l,p)=>l.score-p.score),r.map(({entry:l})=>({label:l.label,path:l.path,run:()=>$e(l.el)}))}});typeof ke=="function"&&P.push(ke);let Se="layout";try{Se=window.localStorage.getItem(L)||"layout"}catch{}B(Se)||B("layout");let Le=()=>{if(!c){c=!0,w?.disconnect(),w=null,j?.dispose(),j=null;for(let n=P.pop();n;n=P.pop())n();m.mediaTagsHub===Me&&(m.mediaTagsHub=null)}},Me={openTab:(n,s)=>B(n,s),announce:O,refreshPreview:()=>j?.refresh(),hasPreview:()=>!!j,searchIndex:Te,reveal:$e,dispose:Le};m.mediaTagsHub=Me,i.onClose?.(Le)}}lt(pe());})();
})();
