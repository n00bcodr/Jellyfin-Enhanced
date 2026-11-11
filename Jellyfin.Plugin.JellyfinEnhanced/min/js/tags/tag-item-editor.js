(() => {
"use strict";(()=>{function ie(t){let P=window.JellyfinEnhanced?.core?.sharedModules?.[t];if(!P)throw new Error(`${t} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return P}function O(t,P){return t[P]}var Ze=ie("features/media-tags/host"),me=O(Ze,"apiClient");var At=O(Ze,"settingsUi"),It=O(Ze,"tagRuntimeHost");var Je=ie("features/media-tags/pipeline/dto");var Rt=O(Je,"isRecord");var N=O(Je,"own"),fe=O(Je,"record");var co=ie("features/media-tags/layout/layout-rules");var Pt=O(co,"normalizeLayout");var zt=`.je-tie-backdrop { position: fixed; inset: 0; z-index: 100000; display: flex; align-items: flex-start; justify-content: center; padding: 24px 12px; box-sizing: border-box; background: rgba(0,0,0,0.6); overflow-y: auto; }
.je-tie { width: min(880px, 100%); box-sizing: border-box; margin: auto 0; border-radius: 10px; border: 1px solid rgba(255,255,255,0.18); background: #1d2026; color: #fff; box-shadow: 0 10px 40px rgba(0,0,0,0.5); font-size: 14px; text-align: left; }
.je-tie:focus { outline: none; }
.je-tie-head { display: flex; align-items: center; gap: 12px; padding: 12px 14px 8px 16px; border-bottom: 1px solid rgba(255,255,255,0.08); }
.je-tie-title { flex: 1 1 auto; min-width: 0; margin: 0; font-size: 17px; font-weight: 600; overflow-wrap: anywhere; }
.je-tie-chip { display: inline-block; margin-left: 6px; padding: 1px 5px; border: 1px solid #ffb74d; border-radius: 4px; color: #ffb74d; font-size: 10px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; vertical-align: middle; }
.je-tie-close { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; flex: 0 0 auto; border: 0; border-radius: 6px; background: transparent; color: #fff; cursor: pointer; }
.je-tie-close:hover { background: rgba(255,255,255,0.08); }
.je-tie-jump { display: none; }
.je-tie-body { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 16px; padding: 14px 16px; }
.je-tie-side { position: sticky; top: 0; align-self: start; }
.je-tie-card { position: relative; width: 100%; }
.je-tie-card:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.je-tie-view { margin-top: 8px; }
.je-tie-view button { font: inherit; color: inherit; }
/* Resting / Hover: one joined control, as on the hub's and the admin page's previews. */
.je-tie-view.je-tie-pills { display: inline-flex; flex-wrap: nowrap; gap: 0; border: 1px solid rgba(255,255,255,0.22); border-radius: 999px; overflow: hidden; }
.je-tie-view .je-tie-pill { min-height: 32px; padding: 0 14px; border: 0; border-radius: 0; background: transparent; font-size: 13px; font-weight: 400; }
.je-tie-view .je-tie-pill[aria-pressed="true"] { background: rgba(255,255,255,0.16); color: #fff; font-weight: 600; }
.je-tie-view .je-tie-pill:disabled { opacity: 0.45; cursor: default; }
.je-tie-view .je-tie-pill:focus-visible { outline-offset: -3px; }
.je-tie-card .cardBox { margin: 0; }
.je-tie-scalable { position: relative; width: 100%; aspect-ratio: 2 / 3; border-radius: 6px; overflow: hidden; contain: paint; background: #2b303a center / cover no-repeat; }
.je-tie-card[data-je-shape="landscape"] .je-tie-scalable { aspect-ratio: 16 / 9; }
.je-tie-card .je-tag-host { position: absolute; inset: 0; pointer-events: none; container-type: inline-size; }
.je-tie-card-title { font-size: 12px; padding: 4px 2px 0; color: rgba(255,255,255,0.9); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.je-tie-source { margin: 10px 0 0; font-size: 13px; line-height: 1.45; color: rgba(255,255,255,0.7); }
.je-tie-source strong { color: #fff; font-weight: 600; }
.je-tie-note { margin: 6px 0 0; font-size: 13px; color: #ffd699; }
.je-tie-main { min-width: 0; display: flex; flex-direction: column; gap: 12px; }
.je-tie-box { margin: 0; padding: 12px 14px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.03); min-width: 0; }
.je-tie-box > legend, .je-tie-h { padding: 0; margin: 0 0 8px; font-size: 14px; font-weight: 600; }
/* A legend sits on the fieldset's border by default: float it into the box like the section headings. */
.je-tie-box > legend { float: left; width: 100%; }
.je-tie-box > legend + * { clear: both; }
.je-tie-hint { margin: 2px 0 0; font-size: 13px; line-height: 1.45; color: rgba(255,255,255,0.68); }
.je-tie input[type="radio"] { position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0; pointer-events: none; }
.je-tie-tiles { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 6px; }
.je-tie-tile, .je-tie-pill { position: relative; display: inline-flex; align-items: center; justify-content: center; min-height: 36px; padding: 4px 12px; box-sizing: border-box; border-radius: 999px; border: 1px solid rgba(255,255,255,0.46); background: transparent; cursor: pointer; font-size: 13px; font-weight: 400; text-align: center; }
.je-tie-tile { flex-direction: column; gap: 6px; padding: 10px 4px 8px; border-radius: 8px; border-color: rgba(255,255,255,0.46); background: rgba(0,0,0,0.2); font-weight: 600; }
.je-tie-tile:hover, .je-tie-pill:hover { background: rgba(255,255,255,0.06); }
.je-tie-pill:has(input:checked) { border-color: #0077a3; background: #0077a3; color: #fff; font-weight: 600; }
.je-tie-tile:has(input:checked) { border: 2px solid #00a4dc; padding: 9px 3px 7px; background: rgba(0,164,220,0.14); }
/* Without :has() (Chrome before 105, Firefox before 121) the chosen label carries je-tie-checked instead. */
@supports not selector(:has(*)) {
    .je-tie-pill.je-tie-checked { border-color: #0077a3; background: #0077a3; color: #fff; font-weight: 600; }
    .je-tie-tile.je-tie-checked { border: 2px solid #00a4dc; padding: 9px 3px 7px; background: rgba(0,164,220,0.14); }
}
/* The hub's layout pictures (ui-panel-media-tags.js, admin-tags.css). */
.je-tie-art { position: relative; width: 22px; height: 32px; border-radius: 3px; background: #4a5160; }
.je-tie-art i { position: absolute; display: none; height: 4px; border-radius: 1px; }
.je-tie-art[data-layout="corners"] i { display: block; width: 7px; }
.je-tie-art[data-layout="corners"] i:nth-child(1) { left: 2px; top: 2px; background: #42a5f5; }
.je-tie-art[data-layout="corners"] i:nth-child(2) { right: 2px; top: 2px; background: #ef5350; }
.je-tie-art[data-layout="corners"] i:nth-child(3) { left: 2px; bottom: 2px; background: #ab47bc; }
.je-tie-art[data-layout="corners"] i:nth-child(4) { right: 2px; bottom: 2px; background: #ffca28; }
.je-tie-art[data-layout="bands"] { width: 26px; height: 26px; margin: 3px 0; }
.je-tie-art[data-layout="bands"] i:nth-child(-n+4) { display: block; width: 6px; }
.je-tie-art[data-layout="bands"] i:nth-child(1) { left: 2px; top: -6px; background: #ef5350; }
.je-tie-art[data-layout="bands"] i:nth-child(2) { left: 9px; top: -6px; background: #42a5f5; }
.je-tie-art[data-layout="bands"] i:nth-child(3) { left: 2px; bottom: -6px; background: #ffca28; }
.je-tie-art[data-layout="bands"] i:nth-child(4) { left: 9px; bottom: -6px; background: #66bb6a; }
.je-tie-art[data-layout="caption"] { height: 26px; margin-bottom: 6px; }
.je-tie-art[data-layout="caption"] i:nth-child(1) { display: block; right: 2px; top: 2px; width: 7px; background: #ef5350; }
.je-tie-art[data-layout="caption"] i:nth-child(2) { display: block; left: 0; bottom: -7px; width: 7px; background: #42a5f5; }
.je-tie-art[data-layout="caption"] i:nth-child(3) { display: block; left: 8px; bottom: -7px; width: 7px; background: #ffca28; }
.je-tie-art[data-layout="caption"] i:nth-child(4) { display: block; left: 16px; bottom: -7px; width: 6px; background: #66bb6a; }
.je-tie-art[data-layout="summary"] i:nth-child(1) { display: block; left: 3px; right: 3px; bottom: 3px; height: 5px; border-radius: 3px; background: #111; box-shadow: inset 0 0 0 1px #ffca28; }
.je-tie-art[data-layout="minimal"] i:nth-child(1) { display: block; right: 2px; top: 2px; width: 7px; background: #ef5350; }
.je-tie-art[data-layout="minimal"] i:nth-child(2) { display: block; left: 3px; bottom: 3px; width: 4px; height: 4px; border-radius: 50%; background: #42a5f5; }
.je-tie-art[data-layout="minimal"] i:nth-child(3) { display: block; left: 9px; bottom: 3px; width: 4px; height: 4px; border-radius: 50%; background: #66bb6a; }
.je-tie-tile:has(input:focus-visible), .je-tie-pill:has(input:focus-visible) { outline: 2px solid #fff; outline-offset: 2px; }
@supports not selector(:has(*)) {
    .je-tie-tile:focus-within, .je-tie-pill:focus-within { outline: 2px solid #fff; outline-offset: 2px; }
}
.je-tie-pills { display: flex; flex-wrap: wrap; gap: 6px; }
.je-tie-scope { display: flex; flex-direction: column; gap: 6px; }
.je-tie-scope .je-tie-pill { justify-content: flex-start; text-align: left; }
.je-tie-groups-hint { margin: -2px 0 10px; }
.je-tie-under { margin-top: 8px; }
.je-tie-hidden { margin-top: 12px; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; }
.je-tie-hidden-toggle { display: flex; align-items: center; gap: 6px; min-height: 44px; padding: 0 12px 0 8px; list-style: none; cursor: pointer; font-size: 14px; font-weight: 600; border-radius: 8px; }
.je-tie-hidden-toggle::-webkit-details-marker { display: none; }
.je-tie-hidden-toggle:hover { background: rgba(255,255,255,0.05); }
.je-tie-hidden-toggle:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.je-tie-hidden-toggle .material-icons { font-size: 20px; transition: transform 0.2s ease; }
.je-tie-hidden[open] > .je-tie-hidden-toggle .material-icons { transform: rotate(180deg); }
.je-tie-hidden > .je-tie-hint { margin: 0 12px 10px; }
.je-tie-hidden > .je-tie-groups { padding: 0 8px 8px; }
.je-tie-groups { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.je-tie-group { display: grid; grid-template-columns: minmax(120px, 160px) minmax(0, 1fr) auto; align-items: center; gap: 8px 12px; min-height: 56px; box-sizing: border-box; padding: 8px 10px 8px 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.08); background: rgba(0,0,0,0.16); }
.je-tie-group[data-open="1"] { border-color: rgba(255,255,255,0.2); background: rgba(255,255,255,0.03); }
.je-tie-gsum { min-width: 0; font-size: 13px; color: rgba(255,255,255,0.72); }
.je-tie-group[data-on="0"] .je-tie-gsum { color: rgba(255,255,255,0.5); }
.je-tie-gopen { display: inline-flex; align-items: center; gap: 2px; min-height: 36px; padding: 0 8px 0 12px; font: inherit; font-size: 13px; font-weight: 600; color: #fff; background: transparent; border: 1px solid rgba(255,255,255,0.46); border-radius: 6px; cursor: pointer; }
.je-tie-gopen:hover { background: rgba(255,255,255,0.06); }
.je-tie-gopen:disabled { opacity: 0.4; cursor: default; }
.je-tie-gopen .material-icons { font-size: 20px; transition: transform 0.2s ease; }
.je-tie-gopen[aria-expanded="true"] .material-icons { transform: rotate(180deg); }
.je-tie-detail { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 16px; padding: 10px 0 2px; border-top: 1px solid rgba(255,255,255,0.08); }
.je-tie-detail[hidden] { display: none; }
.je-tie-detail .je-tie-where { flex: 1 1 280px; }
.je-tie-group[data-on="0"] .je-tie-where, .je-tie-group[data-on="0"] .je-tie-cap { opacity: 0.4; }
.je-tie-gname { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.je-tie-gname small { padding-left: 26px; font-size: 12px; color: rgba(255,255,255,0.62); font-weight: 400; }
.je-tie-switch { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; font-size: 14px; font-weight: 600; min-height: 36px; }
.je-tie-switch input { width: 18px; height: 18px; margin: 0; flex: 0 0 auto; accent-color: #00a4dc; cursor: pointer; }
.je-tie-where .je-tie-pill { min-height: 30px; padding: 2px 8px; font-size: 12px; }
/* Corners positions by name in a 3 × 3 grid, as on the hub and the admin page. */
.je-tie-anchors { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; max-width: 420px; }
.je-tie-anchor { position: relative; display: flex; align-items: center; justify-content: center; min-height: 36px; padding: 2px 6px; box-sizing: border-box; border-radius: 8px; border: 1px solid rgba(255,255,255,0.46); background: transparent; cursor: pointer; font-size: 13px; line-height: 1.2; text-align: center; }
.je-tie-anchor:hover { background: rgba(255,255,255,0.06); }
.je-tie-anchor:has(input:checked) { border-color: #0077a3; background: #0077a3; color: #fff; font-weight: 600; }
.je-tie-group[data-on="0"] :is(.je-tie-anchor, .je-tie-pill) { cursor: default; }
.je-tie-anchor:has(input:focus-visible) { outline: 2px solid #fff; outline-offset: 1px; }
@supports not selector(:has(*)) {
    .je-tie-anchor.je-tie-checked { border-color: #0077a3; background: #0077a3; color: #fff; font-weight: 600; }
    .je-tie-anchor:focus-within { outline: 2px solid #fff; outline-offset: 1px; }
}
.je-tie-cap { display: inline-flex; align-items: center; justify-content: flex-end; gap: 6px; font-size: 13px; white-space: nowrap; }
.je-tie-cap button, .je-tie-foot button, .je-tie-toast button { font: inherit; color: #fff; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.46); border-radius: 6px; min-height: 32px; cursor: pointer; font-weight: 600; }
.je-tie-cap button { width: 36px; min-height: 36px; padding: 0; }
.je-tie-cap button:disabled { opacity: 0.35; cursor: default; }
.je-tie-cap output { min-width: 26px; text-align: center; font-weight: 600; }
/* Size and spacing: one row each, label left and the whole choice readable on the right. */
.je-tie-row3 { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
.je-tie-row3 label { display: grid; grid-template-columns: minmax(100px, 1fr) minmax(220px, 1.6fr); align-items: center; gap: 12px; font-size: 14px; font-weight: 600; min-width: 0; }
.je-tie select { font: inherit; font-size: 13px; color: #fff; background: #12141a; border: 1px solid #80868f; border-radius: 6px; padding: 6px; min-height: 36px; min-width: 0; }
.je-tie select option { background: #222; color: #fff; }
/* Where Save keeps the look: first in the form, so the choice comes before the edits. */
.je-tie-keeps { display: flex; flex-direction: column; gap: 8px; }
.je-tie-keep { border-color: rgba(0,164,220,0.45); }
.je-tie-keep[data-everyone] { border-color: rgba(255,183,77,0.5); }
.je-tie-keep .je-tie-hint { padding-left: 26px; }
.je-tie-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; padding: 10px 16px 14px; border-top: 1px solid rgba(255,255,255,0.08); }
.je-tie-foot .je-tie-status { flex: 1 1 200px; margin: 0; font-size: 13px; color: #ffd699; }
.je-tie-foot .je-tie-status:empty { display: none; }
.je-tie-foot button { padding: 0 16px; min-height: 40px; }
.je-tie-foot .je-tie-save { background: #0077a3; border-color: #0077a3; }
.je-tie button:focus-visible, .je-tie select:focus-visible, .je-tie-switch input:focus-visible, .je-tie-toast button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.je-tie-toast { position: fixed; left: 50%; bottom: 24px; z-index: 100001; transform: translateX(-50%); display: flex; align-items: center; gap: 12px; max-width: calc(100vw - 32px); box-sizing: border-box; padding: 10px 12px 10px 16px; border-radius: 8px; background: #2b2f38; color: #fff; box-shadow: 0 6px 24px rgba(0,0,0,0.5); font-size: 14px; }
.je-tie-toast button { padding: 0 12px; color: #7fd3ff; }
/* Desktop: title and actions stay in view; the form scrolls between them. */
@media (min-width: 641px) {
    .je-tie { display: flex; flex-direction: column; max-height: calc(100vh - 48px); max-height: calc(100dvh - 48px); overflow: hidden; }
    .je-tie-head, .je-tie-foot { flex-shrink: 0; }
    .je-tie-body { min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
    .je-tie-foot { min-height: 64px; box-sizing: border-box; padding: 12px 16px; }
    .je-tie-foot button { min-height: 44px; }
}
@media (max-width: 640px) {
    .je-tie-backdrop { padding: 0; }
    .je-tie-row3 label { grid-template-columns: minmax(0, 1fr); gap: 6px; }
    .je-tie-close { width: 44px; height: 44px; }
    .je-tie { border-radius: 0; min-height: 100%; border: 0; }
    .je-tie-body { grid-template-columns: minmax(0, 1fr); padding: 10px 12px; }
    .je-tie-side { position: static; display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 4px 12px; align-items: start; }
    .je-tie-card[data-je-shape="landscape"] { grid-column: 1 / -1; max-width: 260px; }
    .je-tie-tiles { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .je-tie-anchors { max-width: none; }
    .je-tie-cap button, .je-tie-pill, .je-tie-anchor { min-height: 44px; }
    .je-tie-cap button { width: 44px; }
    .je-tie-group { grid-template-columns: minmax(0, 1fr) auto; }
    .je-tie-gsum { grid-column: 1; grid-row: 2; padding-left: 26px; }
    .je-tie-gopen { grid-column: 2; grid-row: 1 / span 2; min-height: 44px; }
    .je-tie-row3 { grid-template-columns: minmax(0, 1fr); }
    .je-tie-foot { position: sticky; bottom: 0; background: #1d2026; }
    .je-tie-head { position: sticky; top: 0; z-index: 3; background: #1d2026; }
    /* Keyboard scrolling keeps focus clear of the sticky title and footer. */
    .je-tie-backdrop { scroll-padding: 76px 0 84px; }
    .je-tie-hint, .je-tie-gsum { font-size: 14px; line-height: 1.45; }
    .je-tie-jump:not([hidden]) { display: inline-flex; align-items: center; gap: 8px; flex: 0 0 auto; min-height: 44px; padding: 0 12px 0 6px; border: 1px solid rgba(255,255,255,0.22); border-radius: 8px; background: transparent; color: #fff; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
    .je-tie-jump-thumb { width: 22px; height: 33px; border-radius: 3px; background: #2b303a center / cover no-repeat; }
    .je-tie-foot button, .je-tie-gopen, .je-tie select, .je-tie-view .je-tie-pill { min-height: 44px; }
}
`;function $(t){if(!t)throw new Error("Item editor markup is incomplete");return t}function Gt(t){let P="🪼 Jellyfin Enhanced [TagLook]:",et=new Set(["Movie","Series","Season","Episode","BoxSet","Video"]),tt=["corners","bands","caption","summary","minimal"],qt=["smaller","default","larger","largest"],Ft=["tight","default","roomy"],Dt=["default","tight","flush"],ot=10,Nt=8e3,W={status:{setting:"statusTagsEnabled",nameKey:"panel_settings_ui_tag_group_status",capFixed:!0},quality:{setting:"qualityTagsEnabled",nameKey:"panel_settings_ui_tag_group_quality",capAll:!0},rating:{setting:"ratingTagsEnabled",nameKey:"panel_settings_ui_tag_group_rating",capAll:!0},ageRating:{setting:"ageRatingTagsEnabled",nameKey:"panel_settings_ui_tag_group_age_rating",capFixed:!0},language:{setting:"languageTagsEnabled",nameKey:"panel_settings_ui_tag_group_language"},genre:{setting:"genreTagsEnabled",nameKey:"common_genre"},awards:{setting:"awardsTagsEnabled",nameKey:"awards_label",capAll:!0},logos:{setting:"logoTagsEnabled",nameKey:"common_logos",capAll:!0},custom:{setting:"customTagsEnabled",nameKey:"common_custom"}},Kt=["tl","tc","tr","ml","c","mr","bl","bc","br"],ne=null,Ut=0,Te=0,X=0;function xe(){Te++,Ee(X)}function Ee(i){!X||X!==i||(X=0,window.removeEventListener("hashchange",xe))}let y=i=>t.escapeHtml(String(i??"")),n=(i,a)=>y(t.t(i,a)),he=()=>t.core?.tagLayout||null,it=()=>t.core?.tagLook||null,ae=(i,a)=>he()?.VOCABULARY_KEYS[i][a]??"";function be(i,a){return a==="off"?t.t("panel_settings_ui_tag_slot_off"):t.t(ae("slot",`${i}_${a}`))}function nt(i,a){return(N(he()?.LAYOUT_SLOTS??{},i)||[]).filter(c=>c!=="off"&&(c!=="dots"||a==="quality"))}function ye(i,a,c){return c.capFixed?null:a<0?i===0?ot:i>1?i-1:null:i===0?null:i<ot?i+1:c.capAll?0:null}function Bt(){let i=t.currentSettings;return Object.values(W).some(a=>i?.[a.setting]===!0)}function Oe(i){if(i==="awards"&&t.pluginConfig?.AwardsTagsEnabled===!1)return!1;let a=N(W,i);return!!a&&t.currentSettings?.[a.setting]===!0}function at(i,a){return{layout:i.layout,density:i.density,slots:{...i.slots[i.layout]},caps:Object.keys(i.caps).length?{...i.caps}:null,tagScale:i.tagScale,tagGap:i.tagGap,edge:i.edge,scope:a}}function Yt(i,a){switch(i.source){case"lock":return t.t(a?"tag_item_editor_source_lock_series":"tag_item_editor_source_lock");case"override":return t.t(a?"tag_item_editor_source_override_series":"tag_item_editor_source_override");case"rule":return t.t("panel_media_tags_preview_source_rule",{n:i.index+1});case"shape":return t.t("tag_item_editor_source_shape");default:return t.t("tag_item_editor_source_default")}}function rt(i,a,c){let h=it()?.captureSession()??(()=>!1);document.querySelectorAll(".je-tie-toast").forEach(m=>m.remove());let r=document.createElement("div");r.className="je-tie-toast",r.setAttribute("role","status");let f=document.createElement("span");f.textContent=i;let C=document.createElement("button");C.type="button",C.textContent=t.t("hidden_content_undo");let b=setTimeout(()=>r.remove(),Nt);C.addEventListener("click",()=>{clearTimeout(b),r.remove(),h()&&a()}),r.append(f,C),(c&&c.isConnected?c:document.body).appendChild(r)}function Vt(i,a,c,h=null){let r=he();if(!r)return!1;let f=t.tagPipeline;r.ensureHost(i),c&&r.setCardContext(i,c,a);for(let b of document.querySelectorAll(".je-tag-host")){if(i.contains(b)||r.cardIdentity(b)!==a)continue;let m=0;for(let M of r.GROUPS){let K=r.getGroup(b,M)?.cloneNode(!0);K instanceof HTMLElement&&(r.commitGroup(i,M,K),m++)}if(m)return!0}if(!f?.getRenderer)return!1;let C=["status","quality","genre","rating","agerating","custom","userreview","language","awards","logos"];for(let b of C){let m=f.getRenderer(b);if(!(!m||!m.isEnabled?.()))try{c&&m.renderFromServerCache?m.renderFromServerCache(i,c,a):h&&m.render?m.render(i,h,{renderTarget:i,stripRevision:f.tagStripRevision?.()??null}):m.renderFromCache&&m.renderFromCache(i,a)}catch(M){console.warn(`${P} the item editor's sample could not draw ${b}:`,M)}}return[...r.GROUPS].some(b=>r.hasGroup(i,b))}async function Wt(i){try{let a=await me().getItem(me().getCurrentUserId(),i);return Rt(a)?a:null}catch(a){return console.warn(`${P} could not read item ${i}:`,a),null}}async function Xt(){try{let i=await me().getCurrentUser();return fe(fe(i).Policy).IsAdministrator===!0}catch{return!1}}async function Qt(i,a={}){let c=he(),h=it(),r=h?.normalizeId(String(i||""));if(!c||!h||!r)return!1;let f=a.mode==="server",C=document.activeElement,b=a.opener||(C instanceof HTMLElement?C:null),m=h.captureSession();xe();let M=Te;X=M,window.addEventListener("hashchange",xe);let Me=()=>m()&&M===Te,K=()=>(Ee(M),!1),z,dt;try{[z,dt]=await Promise.all([a.item?Promise.resolve(a.item):Wt(r),f?Promise.resolve(!0):Xt()])}catch(e){throw K(),e}if(!Me())return K();if(!z||typeof z.Type!="string"||!et.has(z.Type))return t.toast?.(t.t("tag_item_editor_unsupported")),K();Ce(),t.core.ui?.injectCss?.("je-tag-item-editor",zt);let j=String(z.Type),_e=String(z.Name||""),G=j==="Season"||j==="Episode"?h.normalizeId(String(z.SeriesId||"")):null,ct=j==="Series"||!!G,pt=j==="Series"?r:G,U=h.read(),H=U.locks.get(r)||null,je=G&&U.locks.get(G)||null,He=U.overrides.get(r)||null,Ae=G&&U.overrides.get(G)||null,Ie=t.tagPipeline?.peekServerEntry?.(r)||null,B=Ie;if(!B){try{B=await t.tagPipeline?.itemLookFacts?.(r)??null}catch{B=null}if(!Me())return K();Ce()}Ee(M);let ut=b?.closest?.(".card")||document.querySelector(`.card[data-id="${r}"]`),Q=ut?c.shapeOf(ut):j==="Episode"?"landscape":"portrait",gt={...B||{},Id:r,Type:j,SeriesId:G||B?.SeriesId,itemId:r,cardType:j,shape:Q},Re=c.lookSource(gt),A=c.normalizeSettings(),Zt=c.resolveLayout(gt),mt=e=>e&&(e!==je||e.scope!=="item"),Pe=e=>N(A.caps,e)??0,Z=f?a.look?h.normalizeLock(a.look):null:H||(mt(je)?je:null)||He||(Ae&&Ae.scope!=="item"?Ae:null),L=Zt;if(f&&Z){let e=document.createElement("div");e.dataset.jeShape=Q,c.setPreviewLook(e,Z),L=c.resolveLayout(e),c.setPreviewLook(e,null)}let ft=L.layout,ze=e=>{let o=c.normalizeGroup(e);return!!o&&c.singleChipGroup(o)},u={layout:ft,density:L.density,slots:{},caps:{...Object.fromEntries(Object.entries(L.caps).filter(([e,o])=>o!==Pe(e))),...Object.fromEntries(Object.entries({...Z?.caps||{},...(Q==="landscape"||Q==="list"?Z?.shapes?.[Q]?.caps:null)||{}}).filter(([e])=>ze(e)))},tagScale:L.tagScale===A.tagScale?null:L.tagScale,tagGap:L.tagGap===A.tagGap?null:L.tagGap,edge:L.edge===A.edge?null:L.edge};for(let e of tt)u.slots[e]={...A.profiles[e]};let Ge=null,xt=!1,qe={};u.slots[ft]={...L.slots};let re=ct?H?j==="Series"&&H.scope!=="item"?"series":"item":mt(je)||j==="Series"?"series":"item":"item";f&&j==="Series"&&Z&&(re=Z.scope==="item"?"item":"series");let ve=e=>e&&U.locks.get(e)||null,we=e=>e&&U.overrides.get(e)||null,J=()=>re==="series"&&pt?pt:r,ht=()=>j==="Series"&&re==="item"?"item":null,E=!!ve(J()),q=!!we(J()),d=`jeTie${++Ut}`,v=document.createElement("div");v.className="je-tie-backdrop",b?.closest?.(".je-ta-light")&&v.classList.add("je-tie-light");let ke=t.t(ae("type",j.toLowerCase())),Jt=f?"tag_item_editor_title_server":"tag_item_editor_title";v.innerHTML=`<div class="je-tie" role="dialog" aria-modal="true" aria-labelledby="${d}Title" tabindex="-1">
            <div class="je-tie-head"><h3 class="je-tie-title" id="${d}Title"><span data-tie-title></span>${f?`<span class="je-tie-chip">${n("common_admin")}</span>`:""}</h3>
                <button type="button" class="je-tie-jump" data-tie-jump hidden aria-label="${n("tag_item_editor_show_preview")}"><span class="je-tie-jump-thumb" aria-hidden="true"></span>${n("common_preview")}</button>
                <button type="button" class="je-tie-close" data-tie-close aria-label="${n("awards_close")}"><span class="material-icons" aria-hidden="true">close</span></button></div>
            <div class="je-tie-body">
                <div class="je-tie-side">
                    <div class="je-tie-card" data-je-shape="${y(Q)}" data-id="${y(r)}" data-type="${y(j)}" tabindex="0" aria-label="${n("panel_media_tags_preview")}: ${y(_e||ke)}"><div class="cardBox"><div class="je-tie-scalable cardScalable"></div><div class="cardText je-tie-card-title">${y(_e)}</div></div></div>
                    <div><div class="je-tie-view je-tie-pills" role="group" aria-label="${n("panel_media_tags_preview_view")}">
                        <button type="button" class="je-tie-pill" data-view="rest" aria-pressed="true">${n("panel_settings_ui_tag_editor_preview_resting")}</button>
                        <button type="button" class="je-tie-pill" data-view="hover" aria-pressed="false">${n("panel_settings_ui_tag_editor_preview_hover")}</button></div>
                        <p class="je-tie-note" data-tie-hover-note hidden>${n("panel_media_tags_preview_hover_hidden")}</p>
                        <p class="je-tie-source" data-tie-source></p><p class="je-tie-note" data-tie-note hidden></p></div>
                </div>
                <div class="je-tie-main">
                    ${f?`<p class="je-tie-box je-tie-keep je-tie-hint" data-everyone>${n("tag_item_editor_server_hint")}</p>`:`<div class="je-tie-keeps"><div class="je-tie-box je-tie-keep">
                        <label class="je-tie-switch"><input type="checkbox" data-tie-keep aria-describedby="${d}KeepHint">${n("tag_item_editor_keep")}</label>
                        <p class="je-tie-hint" id="${d}KeepHint">${n("tag_item_editor_keep_hint")}</p></div>
                    ${dt?`<div class="je-tie-box je-tie-keep" data-everyone>
                        <label class="je-tie-switch"><input type="checkbox" data-tie-everyone aria-describedby="${d}EveryoneHint">${n("tag_item_editor_everyone")}<span class="je-tie-chip">${n("common_admin")}</span></label>
                        <p class="je-tie-hint" id="${d}EveryoneHint">${n("tag_item_editor_everyone_hint")}</p></div>`:""}</div>`}
                    ${ct?`<fieldset class="je-tie-box"><legend>${n("tag_item_editor_scope")}</legend><div class="je-tie-scope" role="radiogroup">
                        <label class="je-tie-pill"><input type="radio" name="${d}Scope" value="item">${n(j==="Series"?"tag_item_editor_scope_series_only":"tag_item_editor_scope_item",{type:ke})}</label>
                        <label class="je-tie-pill"><input type="radio" name="${d}Scope" value="series">${n("tag_item_editor_scope_series")}</label></div></fieldset>`:""}
                    <fieldset class="je-tie-box" aria-describedby="${d}LayoutDesc"><legend>${n("common_layout")}</legend><div class="je-tie-tiles">
                        ${tt.map(e=>`<label class="je-tie-tile"><input type="radio" name="${d}Layout" value="${e}"><span class="je-tie-art" data-layout="${e}" aria-hidden="true"><i></i><i></i><i></i><i></i></span>${n(ae("layout",e))}</label>`).join("")}</div><p class="je-tie-hint je-tie-under" id="${d}LayoutDesc" aria-live="polite"></p></fieldset>
                    <fieldset class="je-tie-box" aria-describedby="${d}DensityDesc"><legend>${n("panel_settings_ui_tag_density")}</legend><div class="je-tie-pills">
                        ${["full","compact"].map(e=>`<label class="je-tie-pill"><input type="radio" name="${d}Density" value="${e}">${n(`panel_settings_ui_tag_density_${e}`)}</label>`).join("")}</div><p class="je-tie-hint je-tie-under" id="${d}DensityDesc">${n("panel_settings_ui_tag_density_desc")}</p></fieldset>
                    <section class="je-tie-box" aria-labelledby="${d}Groups" aria-describedby="${d}GroupsHint"><h4 class="je-tie-h" id="${d}Groups">${n("tag_item_editor_groups_title")}</h4><p class="je-tie-hint je-tie-groups-hint" id="${d}GroupsHint">${n(f?"tag_item_editor_groups_hint_server":"tag_item_editor_groups_hint")}</p><div data-tie-groups></div></section>
                    <fieldset class="je-tie-box"><legend>${n("tag_item_editor_spacing")}</legend><div class="je-tie-row3">
                        <label>${n("tag_scale_label")}<select data-tie-select="tagScale"></select></label>
                        <label>${n("tag_gap_label")}<select data-tie-select="tagGap"></select></label>
                        <label>${n("panel_settings_ui_tag_edge")}<select data-tie-select="edge"></select></label></div></fieldset>
                </div>
            </div>
            <div class="je-tie-foot"><p class="je-tie-status" data-tie-status role="status" aria-live="polite"></p>
                <button type="button" data-tie-close>${n("jellyseerr_modal_cancel")}</button>
                <button type="button" class="je-tie-save" data-tie-save>${n("elsewhere_settings_save")}</button></div>
        </div>`,$(v.querySelector("[data-tie-title]")).textContent=t.t(Jt,{name:_e||ke}),(a.host&&a.host.isConnected?a.host:document.body).appendChild(v);let l=$(v.querySelector(".je-tie")),se=$(l.querySelector(".je-tie-scalable")),le=$(l.querySelector("[data-tie-groups]")),Fe=$(l.querySelector("[data-tie-source]")),bt=$(l.querySelector("[data-tie-note]")),yt=$(l.querySelector("[data-tie-status]")),de=$(l.querySelector("[data-tie-save]")),Se=l.querySelector("[data-tie-keep]"),ee=l.querySelector("[data-tie-everyone]"),eo=$(l.querySelector(".je-tie-side")),to=$(l.querySelector("[data-tie-hover-note]")),oo=At(t)?.bindTagPreviewInteraction([l.querySelector(".je-tie-card")],l.querySelector(".je-tie-view"),{change:e=>{let o=!!t.currentSettings?.tagsHideOnHover;eo.dataset.jeHideOnHover=String(o),to.hidden=!(e&&o)}}),_t=fe(z.ImageTags).Primary,$e=_t?me().getScaledImageUrl(r,{type:"Primary",maxHeight:480,tag:String(_t)}):"";$e&&(se.style.backgroundImage=`url("${$e}")`);let De=$(l.querySelector("[data-tie-jump]"));$e&&($(De.querySelector(".je-tie-jump-thumb")).style.backgroundImage=`url("${$e}")`),De.addEventListener("click",()=>{l.querySelector(".je-tie-side")?.scrollIntoView?.({block:"start"}),l.querySelector(".je-tie-card")?.focus({preventScroll:!0})});let Ne=typeof IntersectionObserver=="function"?new IntersectionObserver(([e])=>{De.hidden=!!e?.isIntersecting},{root:v,threshold:0}):null,jt=l.querySelector(".je-tie-side");Ne&&jt&&Ne.observe(jt);let Ke=Vt(se,r,Ie,Ie?null:B);bt.hidden=Ke,bt.textContent=Ke?"":t.t("tag_item_editor_no_tags"),Ke||l.querySelectorAll(".je-tie-view button").forEach(e=>{e.disabled=!0});let ce=null,Y=!1,vt=()=>{c.setPreviewLook(se,{...at(u,ht()),locked:E});let e=Re.source==="lock"&&!H||Re.source==="override"&&!He,o=!B&&(U.rules.length>0||!!G);f?Fe.replaceChildren(document.createTextNode(`${t.t("tag_item_editor_editing")} `),Object.assign(document.createElement("strong"),{textContent:t.t("tag_item_editor_editing_server")})):Fe.replaceChildren(document.createTextNode(`${t.t("tag_item_editor_now")} `),Object.assign(document.createElement("strong"),{textContent:o?t.t("tag_item_editor_source_unknown"):Yt(Re,!!e)})),Y&&Fe.append(document.createElement("br"),document.createTextNode(t.t("tag_item_editor_draft"))),wt()},Ue="",wt=()=>{yt.textContent=Ue||(Be()==="tag_item_editor_lock_save"?t.t("tag_item_editor_lock_save_hint"):""),de.textContent=t.t(Be())},Be=()=>{if(f)return"tag_item_editor_save_server";if(E&&q)return"tag_item_editor_save_both";if(E)return"tag_item_editor_save_mine";if(q)return"tag_item_editor_save_everyone";let e=J();return!!ve(e)||e!==r&&!!H||!!ee&&!!we(e)?"elsewhere_settings_save":Y?"tag_item_editor_lock_save":"tag_item_editor_done"},Ye=()=>{ce||(ce=setTimeout(()=>{ce=null,v.isConnected&&vt()},0))},Ve=()=>{var e,o;return(e=u.slots)[o=u.layout]??(e[o]={})},kt=()=>l.querySelectorAll("label.je-tie-pill, label.je-tie-tile, label.je-tie-anchor").forEach(e=>e.classList.toggle("je-tie-checked",!!e.querySelector("input:checked"))),pe=()=>{let e=document.activeElement,o=e instanceof HTMLElement&&e.dataset.tieKey||null,p=o&&e?.closest("[data-group]")?.dataset.group||null,g=Ve(),w=A.order||c.DEFAULT_ORDER,k=[...w.filter(s=>Oe(s)),...w.filter(s=>!Oe(s))],x=s=>!f&&!Oe(s),S=s=>{let oe=N(W,s);if(!oe)return"";let Le=g[s]||"off",I=Le!=="off",D=t.t(oe.nameKey),Ot=nt(u.layout,s),Ct=I?Le:qe[`${u.layout}:${s}`]||Ot[0]||"",Mt=I?"":"disabled",ao=u.layout==="corners"?`<div class="je-tie-anchors" role="radiogroup" aria-label="${n("tag_item_editor_position",{group:D})}">${Kt.map(R=>`<label class="je-tie-anchor"><input type="radio" name="${d}-${s}" value="${R}" data-tie-key="${s}-${R}" ${R===Ct?"checked":""} ${Mt}>${y(be("corners",R))}</label>`).join("")}</div>`:`<div class="je-tie-pills" role="radiogroup" aria-label="${n("tag_item_editor_position",{group:D})}">${Ot.map(R=>`<label class="je-tie-pill"><input type="radio" name="${d}-${s}" value="${R}" data-tie-key="${s}-${R}" ${R===Ct?"checked":""} ${Mt}>${y(be(u.layout,R))}</label>`).join("")}</div>`,Xe=ze(s),ge=Xe?1:u.caps[s]??Pe(s),Ht=ge===0?t.t("panel_settings_ui_tag_editor_cap_all"):String(ge),ro=Xe?`<p class="je-tie-hint" data-je-limit-na="${s}">${n("tag_limit_single")}</p>`:`<div class="je-tie-cap" role="group" aria-label="${n("tag_item_editor_cap_named",{group:D})}">
                    <span>${n("panel_settings_ui_tag_editor_show_up_to")}</span>
                    <button type="button" data-tie-step="-1" data-tie-key="${s}-down" aria-label="${n("tag_item_editor_cap_fewer",{group:D})}" ${!I||ye(ge,-1,oe)===null?"disabled":""}>−</button>
                    <output aria-live="polite">${y(Ht)}</output>
                    <button type="button" data-tie-step="1" data-tie-key="${s}-up" aria-label="${n("tag_item_editor_cap_more",{group:D})}" ${!I||ye(ge,1,oe)===null?"disabled":""}>+</button></div>`,Qe=Ge===s,so=I?Xe?be(u.layout,Le):t.t(ge===0?"tag_item_editor_group_summary_all":"tag_item_editor_group_summary",{where:be(u.layout,Le),cap:Ht}):t.t("panel_settings_ui_tag_slot_off"),lo=x(s);return`<li class="je-tie-group" data-group="${s}" data-on="${I?1:0}" data-open="${Qe?1:0}">
                    <div class="je-tie-gname"><label class="je-tie-switch"><input type="checkbox" data-tie-on data-tie-key="${s}-on" ${I?"checked":""} aria-label="${n("tag_item_editor_include_group",{group:D})}"${lo?` aria-describedby="${d}HiddenHint"`:""}>${y(D)}</label></div>
                    <span class="je-tie-gsum">${y(so)}</span>
                    <button type="button" class="je-tie-gopen" data-tie-open data-tie-key="${s}-open" aria-expanded="${Qe}" aria-controls="${d}-${s}-detail" aria-label="${n("tag_item_editor_group_edit",{group:D})}" ${I?"":"disabled"}>${n("tag_shapes_edit")}<span class="material-icons" aria-hidden="true">expand_more</span></button>
                    <div class="je-tie-detail" id="${d}-${s}-detail" ${Qe&&I?"":"hidden"}><div class="je-tie-where">${ao}</div>${ro}</div></li>`},We=k.filter(s=>N(W,s)&&!x(s)),ue=k.filter(s=>N(W,s)&&x(s)),_=t.core.tagSettingsMatrix?.offers("itemEditor","quality","scopes");if(le.innerHTML=`<ul class="je-tie-groups">${We.map(S).join("")}</ul>`+(typeof _=="string"?`<p class="je-tie-hint" data-je-scope-na="itemEditor">${n(_)}</p>`:"")+(ue.length?`<details class="je-tie-hidden" data-tie-hidden ${xt?"open":""}><summary class="je-tie-hidden-toggle"><span class="material-icons" aria-hidden="true">expand_more</span>${n("tag_item_editor_hidden_groups",{n:ue.length})}</summary><p class="je-tie-hint" id="${d}HiddenHint">${n("tag_item_editor_hidden_groups_hint")}</p><ul class="je-tie-groups">${ue.map(S).join("")}</ul></details>`:""),kt(),!o)return;let T=s=>!!s&&!s.matches(":disabled")&&!s.closest("[hidden]"),V=le.querySelector(`[data-tie-key="${o}"]`);if(!T(V)){let s=p?le.querySelector(`[data-group="${p}"]`):null;V=["[data-tie-step]","[data-tie-open]","[data-tie-on]"].map(oe=>Array.from(s?.querySelectorAll(oe)||[]).find(T)).find(Boolean)||null}(T(V)?V:l).focus({preventScroll:!0})},St=()=>{let e=l.querySelector(`#${d}LayoutDesc`);e&&(e.textContent=t.t(`panel_settings_ui_tag_layout_${u.layout}`))},$t=()=>{St(),l.querySelectorAll(`input[name="${d}Layout"]`).forEach(e=>{e.checked=e.value===u.layout}),l.querySelectorAll(`input[name="${d}Density"]`).forEach(e=>{e.checked=e.value===u.density}),l.querySelectorAll(`input[name="${d}Scope"]`).forEach(e=>{e.checked=e.value===re}),Se&&(Se.checked=E),ee&&(ee.checked=q),pe()},io={tagScale:{values:qt,label:e=>c.sizeLabel("scale",e),base:A.tagScale},tagGap:{values:Ft,label:e=>t.t(ae("gap",e)),base:A.tagGap},edge:{values:Dt,label:e=>t.t(ae("edge",e)),base:A.edge}};for(let e of["tagScale","tagGap","edge"]){let o=io[e],p=$(l.querySelector(`[data-tie-select="${e}"]`));p.innerHTML=`<option value="">${f?n("tag_item_editor_same_as_user"):n("tag_item_editor_same_as_default",{value:o.label(o.base)})}</option>`+o.values.map(g=>`<option value="${g}">${y(o.label(g))}</option>`).join(""),p.value=u[e]||"",p.addEventListener("change",()=>{u[e]=p.value||null,Y=!0,Ye()})}l.addEventListener("change",e=>{let o=e.target;if(o instanceof HTMLInputElement){if(o.type==="radio"&&kt(),o.name===`${d}Layout`)u.layout=Pt(o.value),St(),pe();else if(o.name===`${d}Density`)u.density=o.value;else if(o.name===`${d}Scope`)re=o.value==="series"?"series":"item",E=E||!!ve(J()),ee&&(q=q||!!we(J())),$t();else if(o.matches("[data-tie-keep]"))E=o.checked;else if(o.matches("[data-tie-everyone]"))q=o.checked;else if(o.matches("[data-tie-on]")){let p=o.closest("[data-group]")?.dataset.group||"",g=Ve(),w=`${u.layout}:${p}`,k=g[p];o.checked?g[p]=qe[w]||nt(u.layout,p)[0]||"off":(k&&k!=="off"&&(qe[w]=k),g[p]="off"),pe()}else if(o.type==="radio"&&o.closest("[data-group]")){let p=o.closest("[data-group]")?.dataset.group||"";Ve()[p]=o.value}else return;Y=Y||!o.matches("[data-tie-keep], [data-tie-everyone]"),Ue="",Ye()}}),le.addEventListener("toggle",e=>{e.target instanceof HTMLDetailsElement&&e.target.matches("[data-tie-hidden]")&&(xt=e.target.open)},!0),le.addEventListener("click",e=>{if(!(e.target instanceof Element))return;let o=e.target.closest("[data-tie-open]");if(o&&!o.disabled){let S=o.closest("[data-group]")?.dataset.group||"";Ge=Ge===S?null:S,pe();return}let p=e.target.closest("[data-tie-step]");if(!p||p.disabled)return;let g=p.closest("[data-group]")?.dataset.group||"",w=N(W,g);if(!w||ze(g))return;let k=u.caps[g]??Pe(g),x=ye(k,Number(p.dataset.tieStep),w);x!==null&&(u.caps[g]=x,Y=!0,pe(),Ye())});let no=()=>Array.from(l.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex="0"]')).filter(e=>!e.closest("[hidden]")&&!(e.tagName!=="SUMMARY"&&e.closest("details:not([open])"))&&e.tabIndex>=0&&!(e instanceof HTMLInputElement&&e.type==="radio"&&!e.checked&&l.querySelector(`input[name="${e.name}"]:checked`))),Lt=e=>{v.isConnected&&!(e.target instanceof Node&&v.contains(e.target))&&l.focus({preventScroll:!0})},Tt=()=>te(),Et=!1,te=()=>{if(Et)return;Et=!0,ce&&clearTimeout(ce),document.removeEventListener("focusin",Lt,!0),window.removeEventListener("hashchange",Tt),oo?.dispose(),Ne?.disconnect(),c.setPreviewLook(se,null),c.clearCard(se),v.remove(),ne?.backdrop===v&&(ne=null);let e=b?.dataset?.jeFocusKey;(a.returnFocus?.()||(b?.isConnected?b:e?Array.from(document.querySelectorAll("[data-je-focus-key]")).find(p=>p.dataset.jeFocusKey===e):null))?.focus({preventScroll:!0})};ne={close:te,backdrop:v},l.addEventListener("keydown",e=>{if(e.key==="Escape"){e.preventDefault(),e.stopPropagation(),te();return}if(e.key!=="Tab")return;let o=no();if(!o.length)return;e.stopPropagation();let p=document.activeElement,g=p instanceof HTMLElement?o.indexOf(p):-1;e.shiftKey&&g<=0?(e.preventDefault(),o[o.length-1]?.focus()):!e.shiftKey&&g===o.length-1&&(e.preventDefault(),o[0]?.focus())}),v.addEventListener("click",e=>{e.target instanceof Element&&e.target.closest("[data-tie-close]")&&te()}),document.addEventListener("focusin",Lt,!0),window.addEventListener("hashchange",Tt);let F={key:"",scopes:new Set};return de.addEventListener("click",async()=>{if(de.disabled||!m())return;let e=J(),o=at(u,ht());if(f){a.onSave?.(o,e),te();return}Be()==="tag_item_editor_lock_save"&&(E=!0,Se&&(Se.checked=!0));let p=JSON.stringify([e,o,E,ee?q:null]);F.key!==p&&(F.key=p,F.scopes.clear()),de.disabled=!0,yt.textContent=t.t("hidden_content_admin_loading");let g=_e||ke,w=[],k=(x,S)=>{w.push({scope:x,ok:S}),S&&F.scopes.add(x)};try{let x=[e,...H?[r]:[]],S=fe(t.currentSettings?.tagLayoutLocks),We=Object.fromEntries(x.filter(_=>S[_]).map(_=>[_,JSON.parse(JSON.stringify(S[_]))])),ue=!!ve(e)||e!==r&&!!H;if(!F.scopes.has("personal")){if(E){let _=e!==r&&H?[r]:[],T=await h.editLocks({[e]:o},_);if(!m())return;k("personal",T),T&&t.toast?.(y(t.t("tag_item_editor_kept",{name:g})))}else if(ue){let _=await h.editLocks({},[e,...H?[r]:[]]);if(!m())return;k("personal",_),_&&rt(t.t("tag_item_editor_unlocked",{name:g}),()=>h.restoreLocks(We),a.host)}}if(ee&&!F.scopes.has("everyone")){let _=we(e);if(q){let T=await h.saveItemOverride(e,o,{remove:e!==r&&He?[r]:[]});if(!m())return;k("everyone",T),T&&t.toast?.(y(t.t("tag_item_editor_everyone_saved",{name:g})))}else if(_){let T={..._},V=await h.saveItemOverride(e,null);if(!m())return;k("everyone",V),V&&rt(t.t("tag_item_editor_everyone_removed",{name:g}),()=>{h.saveItemOverride(e,T,{restoreOnly:!0})},a.host)}}}catch(x){if(!m())return;console.warn(`${P} saving the item look failed:`,x),w.push({scope:"",ok:!1})}if(w.some(x=>!x.ok)){de.disabled=!1;let x=w.find(S=>!S.ok)?.scope;Ue=x==="everyone"&&F.scopes.has("personal")?t.t("tag_item_editor_error_everyone_only"):x==="personal"&&F.scopes.has("everyone")?t.t("tag_item_editor_error_personal_only"):t.t("tag_item_editor_error"),wt();return}!w.length&&Y&&t.toast?.(y(t.t("tag_item_editor_nothing_kept"))),te()}),$t(),vt(),l.focus({preventScroll:!0}),(l.querySelector("input:checked")||l.querySelector("input"))?.focus({preventScroll:!0}),!0}function Ce(){ne?.close()}function st(){xe(),Ce()}t.session?.onUserChange?.("tag-item-editor",()=>{st(),document.querySelectorAll(".je-tie-toast").forEach(i=>i.remove())});let lt={open:Qt,close:st,isOpen:()=>!!ne,isOpening:()=>!!X,anyTagsOn:Bt,TYPES:et,stepCap:ye};return t.tagItemEditor=lt,lt}Gt(It());})();
})();
