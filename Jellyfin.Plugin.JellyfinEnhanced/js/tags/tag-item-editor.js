(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function sharedModule(id) {
    const namespace = window.JellyfinEnhanced?.core?.sharedModules?.[id];
    if (!namespace) throw new Error(`${id} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);
    return namespace;
  }
  function sharedExport(namespace, name) {
    return namespace[name];
  }

  // client/generated-shared/stub/client/src/features/media-tags/host.ts
  var shared = /* @__PURE__ */ sharedModule("features/media-tags/host");
  var export0 = /* @__PURE__ */ sharedExport(shared, "apiClient");
  var export3 = /* @__PURE__ */ sharedExport(shared, "settingsUi");
  var export4 = /* @__PURE__ */ sharedExport(shared, "tagRuntimeHost");

  // client/generated-shared/stub/client/src/features/media-tags/pipeline/dto.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/media-tags/pipeline/dto");
  var export42 = /* @__PURE__ */ sharedExport(shared2, "isRecord");
  var export9 = /* @__PURE__ */ sharedExport(shared2, "own");
  var export10 = /* @__PURE__ */ sharedExport(shared2, "record");

  // client/generated-shared/stub/client/src/features/media-tags/layout/layout-rules.ts
  var shared3 = /* @__PURE__ */ sharedModule("features/media-tags/layout/layout-rules");
  var export23 = /* @__PURE__ */ sharedExport(shared3, "normalizeLayout");

  // client/src/features/media-tags/editor/tag-item-editor.ts
  function must(value) {
    if (!value) throw new Error("Item editor markup is incomplete");
    return value;
  }
  function createItemEditor(JE) {
    const logPrefix = "🪼 Jellyfin Enhanced [TagLook]:";
    const TYPES = /* @__PURE__ */ new Set(["Movie", "Series", "Season", "Episode", "BoxSet", "Video"]);
    const LAYOUTS = ["corners", "bands", "caption", "summary", "minimal"];
    const SCALES = ["smaller", "default", "larger", "largest"];
    const GAPS = ["tight", "default", "roomy"];
    const EDGES = ["default", "tight", "flush"];
    const MAX_CAP = 10;
    const UNDO_MS = 8e3;
    const GROUPS = {
      status: { setting: "statusTagsEnabled", nameKey: "panel_settings_ui_tag_group_status", capFixed: true },
      quality: { setting: "qualityTagsEnabled", nameKey: "panel_settings_ui_tag_group_quality", capAll: true },
      rating: { setting: "ratingTagsEnabled", nameKey: "panel_settings_ui_tag_group_rating", capAll: true },
      ageRating: { setting: "ageRatingTagsEnabled", nameKey: "panel_settings_ui_tag_group_age_rating", capFixed: true },
      language: { setting: "languageTagsEnabled", nameKey: "panel_settings_ui_tag_group_language" },
      genre: { setting: "genreTagsEnabled", nameKey: "common_genre" },
      awards: { setting: "awardsTagsEnabled", nameKey: "awards_label", capAll: true },
      logos: { setting: "logoTagsEnabled", nameKey: "common_logos", capAll: true },
      custom: { setting: "customTagsEnabled", nameKey: "common_custom" }
    };
    const ANCHORS = ["tl", "tc", "tr", "ml", "c", "mr", "bl", "bc", "br"];
    const CSS = `
        .je-tie-backdrop { position: fixed; inset: 0; z-index: 100000; display: flex; align-items: flex-start; justify-content: center; padding: 24px 12px; box-sizing: border-box; background: rgba(0,0,0,0.6); overflow-y: auto; }
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
            .je-tie { display: flex; flex-direction: column; max-height: calc(100dvh - 48px); overflow: hidden; }
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
    `;
    let current = null;
    let sequence = 0;
    let openGeneration = 0;
    let pendingOpen = 0;
    function cancelPending() {
      openGeneration++;
      settlePending(pendingOpen);
    }
    function settlePending(generation) {
      if (!pendingOpen || pendingOpen !== generation) return;
      pendingOpen = 0;
      window.removeEventListener("hashchange", cancelPending);
    }
    const esc = (value) => JE.escapeHtml(String(value ?? ""));
    const tx = (key, params) => esc(JE.t(key, params));
    const layoutApi = () => JE.core?.tagLayout || null;
    const lookApi = () => JE.core?.tagLook || null;
    const vocabularyKey = (section, id) => layoutApi()?.VOCABULARY_KEYS[section][id] ?? "";
    function slotLabel(layout, slot) {
      return slot === "off" ? JE.t("panel_settings_ui_tag_slot_off") : JE.t(vocabularyKey("slot", `${layout}_${slot}`));
    }
    function positionsFor(layout, group) {
      return (export9(layoutApi()?.LAYOUT_SLOTS ?? {}, layout) || []).filter((slot) => slot !== "off" && (slot !== "dots" || group === "quality"));
    }
    function stepCap(cap, dir, meta) {
      if (meta.capFixed) return null;
      if (dir < 0) {
        if (cap === 0) return MAX_CAP;
        return cap > 1 ? cap - 1 : null;
      }
      if (cap === 0) return null;
      if (cap < MAX_CAP) return cap + 1;
      return meta.capAll ? 0 : null;
    }
    function anyTagsOn() {
      const s = JE.currentSettings;
      return Object.values(GROUPS).some((g) => s?.[g.setting] === true);
    }
    function groupOn(group) {
      if (group === "awards" && JE.pluginConfig?.AwardsTagsEnabled === false) return false;
      const meta = export9(GROUPS, group);
      return !!meta && JE.currentSettings?.[meta.setting] === true;
    }
    function lookOf(draft, scope) {
      return {
        layout: draft.layout,
        density: draft.density,
        slots: { ...draft.slots[draft.layout] },
        caps: Object.keys(draft.caps).length ? { ...draft.caps } : null,
        tagScale: draft.tagScale,
        tagGap: draft.tagGap,
        edge: draft.edge,
        scope
      };
    }
    function sourceText(source, inherited) {
      switch (source.source) {
        case "lock":
          return JE.t(inherited ? "tag_item_editor_source_lock_series" : "tag_item_editor_source_lock");
        case "override":
          return JE.t(inherited ? "tag_item_editor_source_override_series" : "tag_item_editor_source_override");
        case "rule":
          return JE.t("panel_media_tags_preview_source_rule", { n: source.index + 1 });
        case "shape":
          return JE.t("tag_item_editor_source_shape");
        default:
          return JE.t("tag_item_editor_source_default");
      }
    }
    function showUndo(message, undo, host) {
      const isCurrent = lookApi()?.captureSession() ?? (() => false);
      document.querySelectorAll(".je-tie-toast").forEach((el) => el.remove());
      const toast = document.createElement("div");
      toast.className = "je-tie-toast";
      toast.setAttribute("role", "status");
      const text = document.createElement("span");
      text.textContent = message;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = JE.t("hidden_content_undo");
      const timer = setTimeout(() => toast.remove(), UNDO_MS);
      button.addEventListener("click", () => {
        clearTimeout(timer);
        toast.remove();
        if (isCurrent()) undo();
      });
      toast.append(text, button);
      (host && host.isConnected ? host : document.body).appendChild(toast);
    }
    function drawTags(target, id, entry, item = null) {
      const L = layoutApi();
      if (!L) return false;
      const pipeline = JE.tagPipeline;
      L.ensureHost(target);
      if (entry) L.setCardContext(target, entry, id);
      for (const host of document.querySelectorAll(".je-tag-host")) {
        if (target.contains(host) || L.cardIdentity(host) !== id) continue;
        let copied = 0;
        for (const group of L.GROUPS) {
          const master = L.getGroup(host, group);
          const copy = master?.cloneNode(true);
          if (copy instanceof HTMLElement) {
            L.commitGroup(target, group, copy);
            copied++;
          }
        }
        if (copied) return true;
      }
      if (!pipeline?.getRenderer) return false;
      const names = ["status", "quality", "genre", "rating", "agerating", "custom", "userreview", "language", "awards", "logos"];
      for (const name of names) {
        const renderer = pipeline.getRenderer(name);
        if (!renderer || !renderer.isEnabled?.()) continue;
        try {
          if (entry && renderer.renderFromServerCache) renderer.renderFromServerCache(target, entry, id);
          else if (item && renderer.render) renderer.render(target, item, { renderTarget: target, stripRevision: pipeline.tagStripRevision?.() ?? null });
          else if (renderer.renderFromCache) renderer.renderFromCache(target, id);
        } catch (err) {
          console.warn(`${logPrefix} the item editor's sample could not draw ${name}:`, err);
        }
      }
      return [...L.GROUPS].some((group) => L.hasGroup(target, group));
    }
    async function fetchItem(id) {
      try {
        const item = await export0().getItem(export0().getCurrentUserId(), id);
        return export42(item) ? item : null;
      } catch (err) {
        console.warn(`${logPrefix} could not read item ${id}:`, err);
        return null;
      }
    }
    async function isAdministrator() {
      try {
        const user = await export0().getCurrentUser();
        return export10(export10(user).Policy).IsAdministrator === true;
      } catch {
        return false;
      }
    }
    async function open(itemId, options = {}) {
      const L = layoutApi();
      const look = lookApi();
      const id = look?.normalizeId(String(itemId || ""));
      if (!L || !look || !id) return false;
      const serverMode = options.mode === "server";
      const active = document.activeElement;
      const opener = options.opener || (active instanceof HTMLElement ? active : null);
      const isCurrent = look.captureSession();
      cancelPending();
      const generation = openGeneration;
      pendingOpen = generation;
      window.addEventListener("hashchange", cancelPending);
      const live = () => isCurrent() && generation === openGeneration;
      const abandon = () => {
        settlePending(generation);
        return false;
      };
      let item;
      let admin;
      try {
        [item, admin] = await Promise.all([options.item ? Promise.resolve(options.item) : fetchItem(id), serverMode ? Promise.resolve(true) : isAdministrator()]);
      } catch (err) {
        abandon();
        throw err;
      }
      if (!live()) return abandon();
      if (!item || typeof item.Type !== "string" || !TYPES.has(item.Type)) {
        JE.toast?.(JE.t("tag_item_editor_unsupported"));
        return abandon();
      }
      closeMounted();
      JE.core.ui?.injectCss?.("je-tag-item-editor", CSS);
      const type = String(item.Type);
      const name = String(item.Name || "");
      const seriesId = type === "Season" || type === "Episode" ? look.normalizeId(String(item.SeriesId || "")) : null;
      const hasSeries = type === "Series" || !!seriesId;
      const seriesTarget = type === "Series" ? id : seriesId;
      const read = look.read();
      const own = read.locks.get(id) || null;
      const seriesLock = seriesId ? read.locks.get(seriesId) || null : null;
      const ownOverride = read.overrides.get(id) || null;
      const seriesOverride = seriesId ? read.overrides.get(seriesId) || null : null;
      const serverEntry = JE.tagPipeline?.peekServerEntry?.(id) || null;
      let facts = serverEntry;
      if (!facts) {
        try {
          facts = await JE.tagPipeline?.itemLookFacts?.(id) ?? null;
        } catch {
          facts = null;
        }
        if (!live()) return abandon();
        closeMounted();
      }
      settlePending(generation);
      const itemCard = opener?.closest?.(".card") || document.querySelector(`.card[data-id="${id}"]`);
      const shape = itemCard ? L.shapeOf(itemCard) : type === "Episode" ? "landscape" : "portrait";
      const context = { ...facts || {}, Id: id, Type: type, SeriesId: seriesId || facts?.SeriesId, itemId: id, cardType: type, shape };
      const before = L.lookSource(context);
      const base = L.normalizeSettings();
      const conf = L.resolveLayout(context);
      const usable = (lock) => lock && (lock !== seriesLock || lock.scope !== "item");
      const baseCap = (group) => export9(base.caps, group) ?? 0;
      const startLock = serverMode ? options.look ? look.normalizeLock(options.look) : null : own || (usable(seriesLock) ? seriesLock : null) || ownOverride || (seriesOverride && seriesOverride.scope !== "item" ? seriesOverride : null);
      let effective = conf;
      if (serverMode && startLock) {
        const sample = document.createElement("div");
        sample.dataset.jeShape = shape;
        L.setPreviewLook(sample, startLock);
        effective = L.resolveLayout(sample);
        L.setPreviewLook(sample, null);
      }
      const startLayout = effective.layout;
      const singleChip = (name2) => {
        const group = L.normalizeGroup(name2);
        return !!group && L.singleChipGroup(group);
      };
      const draft = {
        layout: startLayout,
        density: effective.density,
        slots: {},
        caps: {
          ...Object.fromEntries(Object.entries(effective.caps).filter(([group, cap]) => cap !== baseCap(group))),
          // Presentation caps do not rewrite a saved single-chip cap when another field is edited.
          ...Object.fromEntries(Object.entries({ ...startLock?.caps || {}, ...(shape === "landscape" || shape === "list" ? startLock?.shapes?.[shape]?.caps : null) || {} }).filter(([group]) => singleChip(group)))
        },
        tagScale: effective.tagScale === base.tagScale ? null : effective.tagScale,
        tagGap: effective.tagGap === base.tagGap ? null : effective.tagGap,
        edge: effective.edge === base.edge ? null : effective.edge
      };
      for (const layout of LAYOUTS) draft.slots[layout] = { ...base.profiles[layout] };
      let openGroup = null;
      let hiddenOpen = false;
      const lastSlot = {};
      draft.slots[startLayout] = { ...effective.slots };
      let scope = !hasSeries ? "item" : own ? type === "Series" && own.scope !== "item" ? "series" : "item" : usable(seriesLock) ? "series" : type === "Series" ? "series" : "item";
      if (serverMode && type === "Series" && startLock) scope = startLock.scope === "item" ? "item" : "series";
      const keptAt = (target2) => target2 ? read.locks.get(target2) || null : null;
      const overrideAt = (target2) => target2 ? read.overrides.get(target2) || null : null;
      const targetOf = () => scope === "series" && seriesTarget ? seriesTarget : id;
      const scopeField = () => type === "Series" && scope === "item" ? "item" : null;
      let keep = !!keptAt(targetOf());
      let everyone = !!overrideAt(targetOf());
      const uid = `jeTie${++sequence}`;
      const backdrop = document.createElement("div");
      backdrop.className = "je-tie-backdrop";
      if (opener?.closest?.(".je-ta-light")) backdrop.classList.add("je-tie-light");
      const typeName = JE.t(vocabularyKey("type", type.toLowerCase()));
      const titleKey = serverMode ? "tag_item_editor_title_server" : "tag_item_editor_title";
      backdrop.innerHTML = `<div class="je-tie" role="dialog" aria-modal="true" aria-labelledby="${uid}Title" tabindex="-1">
            <div class="je-tie-head"><h3 class="je-tie-title" id="${uid}Title"><span data-tie-title></span>${serverMode ? `<span class="je-tie-chip">${tx("common_admin")}</span>` : ""}</h3>
                <button type="button" class="je-tie-jump" data-tie-jump hidden aria-label="${tx("tag_item_editor_show_preview")}"><span class="je-tie-jump-thumb" aria-hidden="true"></span>${tx("common_preview")}</button>
                <button type="button" class="je-tie-close" data-tie-close aria-label="${tx("awards_close")}"><span class="material-icons" aria-hidden="true">close</span></button></div>
            <div class="je-tie-body">
                <div class="je-tie-side">
                    <div class="je-tie-card" data-je-shape="${esc(shape)}" data-id="${esc(id)}" data-type="${esc(type)}" tabindex="0" aria-label="${tx("panel_media_tags_preview")}: ${esc(name || typeName)}"><div class="cardBox"><div class="je-tie-scalable cardScalable"></div><div class="cardText je-tie-card-title">${esc(name)}</div></div></div>
                    <div><div class="je-tie-view je-tie-pills" role="group" aria-label="${tx("panel_media_tags_preview_view")}">
                        <button type="button" class="je-tie-pill" data-view="rest" aria-pressed="true">${tx("panel_settings_ui_tag_editor_preview_resting")}</button>
                        <button type="button" class="je-tie-pill" data-view="hover" aria-pressed="false">${tx("panel_settings_ui_tag_editor_preview_hover")}</button></div>
                        <p class="je-tie-note" data-tie-hover-note hidden>${tx("panel_media_tags_preview_hover_hidden")}</p>
                        <p class="je-tie-source" data-tie-source></p><p class="je-tie-note" data-tie-note hidden></p></div>
                </div>
                <div class="je-tie-main">
                    ${serverMode ? `<p class="je-tie-box je-tie-keep je-tie-hint" data-everyone>${tx("tag_item_editor_server_hint")}</p>` : `<div class="je-tie-keeps"><div class="je-tie-box je-tie-keep">
                        <label class="je-tie-switch"><input type="checkbox" data-tie-keep aria-describedby="${uid}KeepHint">${tx("tag_item_editor_keep")}</label>
                        <p class="je-tie-hint" id="${uid}KeepHint">${tx("tag_item_editor_keep_hint")}</p></div>
                    ${admin ? `<div class="je-tie-box je-tie-keep" data-everyone>
                        <label class="je-tie-switch"><input type="checkbox" data-tie-everyone aria-describedby="${uid}EveryoneHint">${tx("tag_item_editor_everyone")}<span class="je-tie-chip">${tx("common_admin")}</span></label>
                        <p class="je-tie-hint" id="${uid}EveryoneHint">${tx("tag_item_editor_everyone_hint")}</p></div>` : ""}</div>`}
                    ${hasSeries ? `<fieldset class="je-tie-box"><legend>${tx("tag_item_editor_scope")}</legend><div class="je-tie-scope" role="radiogroup">
                        <label class="je-tie-pill"><input type="radio" name="${uid}Scope" value="item">${tx(type === "Series" ? "tag_item_editor_scope_series_only" : "tag_item_editor_scope_item", { type: typeName })}</label>
                        <label class="je-tie-pill"><input type="radio" name="${uid}Scope" value="series">${tx("tag_item_editor_scope_series")}</label></div></fieldset>` : ""}
                    <fieldset class="je-tie-box" aria-describedby="${uid}LayoutDesc"><legend>${tx("common_layout")}</legend><div class="je-tie-tiles">
                        ${LAYOUTS.map((l) => `<label class="je-tie-tile"><input type="radio" name="${uid}Layout" value="${l}"><span class="je-tie-art" data-layout="${l}" aria-hidden="true"><i></i><i></i><i></i><i></i></span>${tx(vocabularyKey("layout", l))}</label>`).join("")}</div><p class="je-tie-hint je-tie-under" id="${uid}LayoutDesc" aria-live="polite"></p></fieldset>
                    <fieldset class="je-tie-box" aria-describedby="${uid}DensityDesc"><legend>${tx("panel_settings_ui_tag_density")}</legend><div class="je-tie-pills">
                        ${["full", "compact"].map((d) => `<label class="je-tie-pill"><input type="radio" name="${uid}Density" value="${d}">${tx(`panel_settings_ui_tag_density_${d}`)}</label>`).join("")}</div><p class="je-tie-hint je-tie-under" id="${uid}DensityDesc">${tx("panel_settings_ui_tag_density_desc")}</p></fieldset>
                    <section class="je-tie-box" aria-labelledby="${uid}Groups" aria-describedby="${uid}GroupsHint"><h4 class="je-tie-h" id="${uid}Groups">${tx("tag_item_editor_groups_title")}</h4><p class="je-tie-hint je-tie-groups-hint" id="${uid}GroupsHint">${tx(serverMode ? "tag_item_editor_groups_hint_server" : "tag_item_editor_groups_hint")}</p><div data-tie-groups></div></section>
                    <fieldset class="je-tie-box"><legend>${tx("tag_item_editor_spacing")}</legend><div class="je-tie-row3">
                        <label>${tx("tag_scale_label")}<select data-tie-select="tagScale"></select></label>
                        <label>${tx("tag_gap_label")}<select data-tie-select="tagGap"></select></label>
                        <label>${tx("panel_settings_ui_tag_edge")}<select data-tie-select="edge"></select></label></div></fieldset>
                </div>
            </div>
            <div class="je-tie-foot"><p class="je-tie-status" data-tie-status role="status" aria-live="polite"></p>
                <button type="button" data-tie-close>${tx("jellyseerr_modal_cancel")}</button>
                <button type="button" class="je-tie-save" data-tie-save>${tx("elsewhere_settings_save")}</button></div>
        </div>`;
      must(backdrop.querySelector("[data-tie-title]")).textContent = JE.t(titleKey, { name: name || typeName });
      const host = options.host && options.host.isConnected ? options.host : document.body;
      host.appendChild(backdrop);
      const dialog = must(backdrop.querySelector(".je-tie"));
      const target = must(dialog.querySelector(".je-tie-scalable"));
      const groupsList = must(dialog.querySelector("[data-tie-groups]"));
      const sourceEl = must(dialog.querySelector("[data-tie-source]"));
      const noteEl = must(dialog.querySelector("[data-tie-note]"));
      const statusEl = must(dialog.querySelector("[data-tie-status]"));
      const saveButton = must(dialog.querySelector("[data-tie-save]"));
      const keepBox = dialog.querySelector("[data-tie-keep]");
      const everyoneBox = dialog.querySelector("[data-tie-everyone]");
      const previewSide = must(dialog.querySelector(".je-tie-side"));
      const hoverNote = must(dialog.querySelector("[data-tie-hover-note]"));
      const interaction = export3(JE)?.bindTagPreviewInteraction([dialog.querySelector(".je-tie-card")], dialog.querySelector(".je-tie-view"), {
        change: (active2) => {
          const hidden = !!JE.currentSettings?.tagsHideOnHover;
          previewSide.dataset.jeHideOnHover = String(hidden);
          hoverNote.hidden = !(active2 && hidden);
        }
      });
      const primaryTag = export10(item.ImageTags).Primary;
      const image = primaryTag ? export0().getScaledImageUrl(id, { type: "Primary", maxHeight: 480, tag: String(primaryTag) }) : "";
      if (image) target.style.backgroundImage = `url("${image}")`;
      const jump = must(dialog.querySelector("[data-tie-jump]"));
      if (image) must(jump.querySelector(".je-tie-jump-thumb")).style.backgroundImage = `url("${image}")`;
      jump.addEventListener("click", () => {
        dialog.querySelector(".je-tie-side")?.scrollIntoView?.({ block: "start" });
        dialog.querySelector(".je-tie-card")?.focus({ preventScroll: true });
      });
      const sideWatch = typeof IntersectionObserver === "function" ? new IntersectionObserver(([entry]) => {
        jump.hidden = !!entry?.isIntersecting;
      }, { root: backdrop, threshold: 0 }) : null;
      const side = dialog.querySelector(".je-tie-side");
      if (sideWatch && side) sideWatch.observe(side);
      const drawn = drawTags(target, id, serverEntry, serverEntry ? null : facts);
      noteEl.hidden = drawn;
      noteEl.textContent = drawn ? "" : JE.t("tag_item_editor_no_tags");
      if (!drawn) dialog.querySelectorAll(".je-tie-view button").forEach((b) => {
        b.disabled = true;
      });
      let presentTimer = null;
      let dirty = false;
      const present = () => {
        L.setPreviewLook(target, { ...lookOf(draft, scopeField()), locked: keep });
        const inherited = before.source === "lock" && !own || before.source === "override" && !ownOverride;
        const unknown = !facts && (read.rules.length > 0 || !!seriesId);
        if (serverMode) sourceEl.replaceChildren(document.createTextNode(`${JE.t("tag_item_editor_editing")} `), Object.assign(document.createElement("strong"), { textContent: JE.t("tag_item_editor_editing_server") }));
        else sourceEl.replaceChildren(document.createTextNode(`${JE.t("tag_item_editor_now")} `), Object.assign(document.createElement("strong"), { textContent: unknown ? JE.t("tag_item_editor_source_unknown") : sourceText(before, !!inherited) }));
        if (dirty) sourceEl.append(document.createElement("br"), document.createTextNode(JE.t("tag_item_editor_draft")));
        showStatus();
      };
      let saveError = "";
      const showStatus = () => {
        statusEl.textContent = saveError || (saveLabelKey() === "tag_item_editor_lock_save" ? JE.t("tag_item_editor_lock_save_hint") : "");
        saveButton.textContent = JE.t(saveLabelKey());
      };
      const saveLabelKey = () => {
        if (serverMode) return "tag_item_editor_save_server";
        if (keep && everyone) return "tag_item_editor_save_both";
        if (keep) return "tag_item_editor_save_mine";
        if (everyone) return "tag_item_editor_save_everyone";
        const target2 = targetOf();
        const removes = !!keptAt(target2) || target2 !== id && !!own || !!everyoneBox && !!overrideAt(target2);
        if (removes) return "elsewhere_settings_save";
        return dirty ? "tag_item_editor_lock_save" : "tag_item_editor_done";
      };
      const schedule = () => {
        if (presentTimer) return;
        presentTimer = setTimeout(() => {
          presentTimer = null;
          if (backdrop.isConnected) present();
        }, 0);
      };
      const layoutSlots = () => {
        var _a, _b;
        return (_a = draft.slots)[_b = draft.layout] ?? (_a[_b] = {});
      };
      const renderGroups = () => {
        const focused = document.activeElement;
        const focusKey = focused instanceof HTMLElement ? focused.dataset.tieKey || null : null;
        const focusGroup = focusKey ? focused?.closest("[data-group]")?.dataset.group || null : null;
        const slots = layoutSlots();
        const ordered = base.order || L.DEFAULT_ORDER;
        const order = [...ordered.filter((g) => groupOn(g)), ...ordered.filter((g) => !groupOn(g))];
        const tucked = (group) => !serverMode && !groupOn(group);
        const rowHtml = (group) => {
          const meta = export9(GROUPS, group);
          if (!meta) return "";
          const slot = slots[group] || "off";
          const on = slot !== "off";
          const gname = JE.t(meta.nameKey);
          const positions = positionsFor(draft.layout, group);
          const current2 = on ? slot : lastSlot[`${draft.layout}:${group}`] || positions[0] || "";
          const off = on ? "" : "disabled";
          const where = draft.layout === "corners" ? `<div class="je-tie-anchors" role="radiogroup" aria-label="${tx("tag_item_editor_position", { group: gname })}">${ANCHORS.map((a) => `<label class="je-tie-anchor"><input type="radio" name="${uid}-${group}" value="${a}" data-tie-key="${group}-${a}" ${a === current2 ? "checked" : ""} ${off}>${esc(slotLabel("corners", a))}</label>`).join("")}</div>` : `<div class="je-tie-pills" role="radiogroup" aria-label="${tx("tag_item_editor_position", { group: gname })}">${positions.map((p) => `<label class="je-tie-pill"><input type="radio" name="${uid}-${group}" value="${p}" data-tie-key="${group}-${p}" ${p === current2 ? "checked" : ""} ${off}>${esc(slotLabel(draft.layout, p))}</label>`).join("")}</div>`;
          const fixed = singleChip(group);
          const cap = fixed ? 1 : draft.caps[group] ?? baseCap(group);
          const capText = cap === 0 ? JE.t("panel_settings_ui_tag_editor_cap_all") : String(cap);
          const stepper = fixed ? `<p class="je-tie-hint" data-je-limit-na="${group}">${tx("tag_limit_single")}</p>` : `<div class="je-tie-cap" role="group" aria-label="${tx("tag_item_editor_cap_named", { group: gname })}">
                    <span>${tx("panel_settings_ui_tag_editor_show_up_to")}</span>
                    <button type="button" data-tie-step="-1" data-tie-key="${group}-down" aria-label="${tx("tag_item_editor_cap_fewer", { group: gname })}" ${!on || stepCap(cap, -1, meta) === null ? "disabled" : ""}>−</button>
                    <output aria-live="polite">${esc(capText)}</output>
                    <button type="button" data-tie-step="1" data-tie-key="${group}-up" aria-label="${tx("tag_item_editor_cap_more", { group: gname })}" ${!on || stepCap(cap, 1, meta) === null ? "disabled" : ""}>+</button></div>`;
          const open2 = openGroup === group;
          const summary = on ? fixed ? slotLabel(draft.layout, slot) : JE.t(cap === 0 ? "tag_item_editor_group_summary_all" : "tag_item_editor_group_summary", { where: slotLabel(draft.layout, slot), cap: capText }) : JE.t("panel_settings_ui_tag_slot_off");
          const offNote = tucked(group);
          return `<li class="je-tie-group" data-group="${group}" data-on="${on ? 1 : 0}" data-open="${open2 ? 1 : 0}">
                    <div class="je-tie-gname"><label class="je-tie-switch"><input type="checkbox" data-tie-on data-tie-key="${group}-on" ${on ? "checked" : ""} aria-label="${tx("tag_item_editor_include_group", { group: gname })}"${offNote ? ` aria-describedby="${uid}HiddenHint"` : ""}>${esc(gname)}</label></div>
                    <span class="je-tie-gsum">${esc(summary)}</span>
                    <button type="button" class="je-tie-gopen" data-tie-open data-tie-key="${group}-open" aria-expanded="${open2}" aria-controls="${uid}-${group}-detail" aria-label="${tx("tag_item_editor_group_edit", { group: gname })}" ${on ? "" : "disabled"}>${tx("tag_shapes_edit")}<span class="material-icons" aria-hidden="true">expand_more</span></button>
                    <div class="je-tie-detail" id="${uid}-${group}-detail" ${open2 && on ? "" : "hidden"}><div class="je-tie-where">${where}</div>${stepper}</div></li>`;
        };
        const shown = order.filter((g) => export9(GROUPS, g) && !tucked(g));
        const hidden = order.filter((g) => export9(GROUPS, g) && tucked(g));
        const scopeNote = JE.core.tagSettingsMatrix?.offers("itemEditor", "quality", "scopes");
        groupsList.innerHTML = `<ul class="je-tie-groups">${shown.map(rowHtml).join("")}</ul>` + (typeof scopeNote === "string" ? `<p class="je-tie-hint" data-je-scope-na="itemEditor">${tx(scopeNote)}</p>` : "") + (hidden.length ? `<details class="je-tie-hidden" data-tie-hidden ${hiddenOpen ? "open" : ""}><summary class="je-tie-hidden-toggle"><span class="material-icons" aria-hidden="true">expand_more</span>${tx("tag_item_editor_hidden_groups", { n: hidden.length })}</summary><p class="je-tie-hint" id="${uid}HiddenHint">${tx("tag_item_editor_hidden_groups_hint")}</p><ul class="je-tie-groups">${hidden.map(rowHtml).join("")}</ul></details>` : "");
        if (!focusKey) return;
        const canFocus = (el) => !!el && !el.matches(":disabled") && !el.closest("[hidden]");
        let next = groupsList.querySelector(`[data-tie-key="${focusKey}"]`);
        if (!canFocus(next)) {
          const row = focusGroup ? groupsList.querySelector(`[data-group="${focusGroup}"]`) : null;
          next = ["[data-tie-step]", "[data-tie-open]", "[data-tie-on]"].map((sel) => Array.from(row?.querySelectorAll(sel) || []).find(canFocus)).find(Boolean) || null;
        }
        (canFocus(next) ? next : dialog).focus({ preventScroll: true });
      };
      const describeLayout = () => {
        const desc = dialog.querySelector(`#${uid}LayoutDesc`);
        if (desc) desc.textContent = JE.t(`panel_settings_ui_tag_layout_${draft.layout}`);
      };
      const sync = () => {
        describeLayout();
        dialog.querySelectorAll(`input[name="${uid}Layout"]`).forEach((r) => {
          r.checked = r.value === draft.layout;
        });
        dialog.querySelectorAll(`input[name="${uid}Density"]`).forEach((r) => {
          r.checked = r.value === draft.density;
        });
        dialog.querySelectorAll(`input[name="${uid}Scope"]`).forEach((r) => {
          r.checked = r.value === scope;
        });
        if (keepBox) keepBox.checked = keep;
        if (everyoneBox) everyoneBox.checked = everyone;
        renderGroups();
      };
      const selectOptions = {
        tagScale: { values: SCALES, label: (v) => L.sizeLabel("scale", v), base: base.tagScale },
        tagGap: { values: GAPS, label: (v) => JE.t(vocabularyKey("gap", v)), base: base.tagGap },
        edge: { values: EDGES, label: (v) => JE.t(vocabularyKey("edge", v)), base: base.edge }
      };
      for (const key of ["tagScale", "tagGap", "edge"]) {
        const spec = selectOptions[key];
        const select = must(dialog.querySelector(`[data-tie-select="${key}"]`));
        select.innerHTML = `<option value="">${serverMode ? tx("tag_item_editor_same_as_user") : tx("tag_item_editor_same_as_default", { value: spec.label(spec.base) })}</option>` + spec.values.map((v) => `<option value="${v}">${esc(spec.label(v))}</option>`).join("");
        select.value = draft[key] || "";
        select.addEventListener("change", () => {
          draft[key] = select.value || null;
          dirty = true;
          schedule();
        });
      }
      dialog.addEventListener("change", (e) => {
        const input = e.target;
        if (!(input instanceof HTMLInputElement)) return;
        if (input.name === `${uid}Layout`) {
          draft.layout = export23(input.value);
          describeLayout();
          renderGroups();
        } else if (input.name === `${uid}Density`) {
          draft.density = input.value;
        } else if (input.name === `${uid}Scope`) {
          scope = input.value === "series" ? "series" : "item";
          keep = keep || !!keptAt(targetOf());
          if (everyoneBox) everyone = everyone || !!overrideAt(targetOf());
          sync();
        } else if (input.matches("[data-tie-keep]")) {
          keep = input.checked;
        } else if (input.matches("[data-tie-everyone]")) {
          everyone = input.checked;
        } else if (input.matches("[data-tie-on]")) {
          const group = input.closest("[data-group]")?.dataset.group || "";
          const slots = layoutSlots();
          const key = `${draft.layout}:${group}`;
          const held = slots[group];
          if (input.checked) slots[group] = lastSlot[key] || positionsFor(draft.layout, group)[0] || "off";
          else {
            if (held && held !== "off") lastSlot[key] = held;
            slots[group] = "off";
          }
          renderGroups();
        } else if (input.type === "radio" && input.closest("[data-group]")) {
          const group = input.closest("[data-group]")?.dataset.group || "";
          layoutSlots()[group] = input.value;
        } else {
          return;
        }
        dirty = dirty || !input.matches("[data-tie-keep], [data-tie-everyone]");
        saveError = "";
        schedule();
      });
      groupsList.addEventListener("toggle", (e) => {
        if (e.target instanceof HTMLDetailsElement && e.target.matches("[data-tie-hidden]")) hiddenOpen = e.target.open;
      }, true);
      groupsList.addEventListener("click", (e) => {
        if (!(e.target instanceof Element)) return;
        const opener2 = e.target.closest("[data-tie-open]");
        if (opener2 && !opener2.disabled) {
          const group2 = opener2.closest("[data-group]")?.dataset.group || "";
          openGroup = openGroup === group2 ? null : group2;
          renderGroups();
          return;
        }
        const button = e.target.closest("[data-tie-step]");
        if (!button || button.disabled) return;
        const group = button.closest("[data-group]")?.dataset.group || "";
        const meta = export9(GROUPS, group);
        if (!meta || singleChip(group)) return;
        const cap = draft.caps[group] ?? baseCap(group);
        const next = stepCap(cap, Number(button.dataset.tieStep), meta);
        if (next === null) return;
        draft.caps[group] = next;
        dirty = true;
        renderGroups();
        schedule();
      });
      const focusables = () => Array.from(dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex="0"]')).filter((el) => !el.closest("[hidden]") && !(el.tagName !== "SUMMARY" && el.closest("details:not([open])")) && el.tabIndex >= 0 && !(el instanceof HTMLInputElement && el.type === "radio" && !el.checked && dialog.querySelector(`input[name="${el.name}"]:checked`)));
      const onFocusIn = (e) => {
        if (backdrop.isConnected && !(e.target instanceof Node && backdrop.contains(e.target))) dialog.focus({ preventScroll: true });
      };
      const onNavigate = () => finish();
      let closed = false;
      const finish = () => {
        if (closed) return;
        closed = true;
        if (presentTimer) clearTimeout(presentTimer);
        document.removeEventListener("focusin", onFocusIn, true);
        window.removeEventListener("hashchange", onNavigate);
        interaction?.dispose();
        sideWatch?.disconnect();
        L.setPreviewLook(target, null);
        L.clearCard(target);
        backdrop.remove();
        if (current?.backdrop === backdrop) current = null;
        const key = opener?.dataset?.jeFocusKey;
        const back = options.returnFocus?.() || (opener?.isConnected ? opener : key ? Array.from(document.querySelectorAll("[data-je-focus-key]")).find((el) => el.dataset.jeFocusKey === key) : null);
        back?.focus({ preventScroll: true });
      };
      current = { close: finish, backdrop };
      dialog.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish();
          return;
        }
        if (e.key !== "Tab") return;
        const list = focusables();
        if (!list.length) return;
        e.stopPropagation();
        const focused = document.activeElement;
        const at = focused instanceof HTMLElement ? list.indexOf(focused) : -1;
        if (e.shiftKey && at <= 0) {
          e.preventDefault();
          list[list.length - 1]?.focus();
        } else if (!e.shiftKey && at === list.length - 1) {
          e.preventDefault();
          list[0]?.focus();
        }
      });
      backdrop.addEventListener("click", (e) => {
        if (e.target instanceof Element && e.target.closest("[data-tie-close]")) finish();
      });
      document.addEventListener("focusin", onFocusIn, true);
      window.addEventListener("hashchange", onNavigate);
      const saved = { key: "", scopes: /* @__PURE__ */ new Set() };
      saveButton.addEventListener("click", async () => {
        if (saveButton.disabled || !isCurrent()) return;
        const targetId = targetOf();
        const chosen = lookOf(draft, scopeField());
        if (serverMode) {
          options.onSave?.(chosen, targetId);
          finish();
          return;
        }
        if (saveLabelKey() === "tag_item_editor_lock_save") {
          keep = true;
          if (keepBox) keepBox.checked = true;
        }
        const changeKey = JSON.stringify([targetId, chosen, keep, everyoneBox ? everyone : null]);
        if (saved.key !== changeKey) {
          saved.key = changeKey;
          saved.scopes.clear();
        }
        saveButton.disabled = true;
        statusEl.textContent = JE.t("hidden_content_admin_loading");
        const label = name || typeName;
        const results = [];
        const note = (scope2, ok) => {
          results.push({ scope: scope2, ok });
          if (ok) saved.scopes.add(scope2);
        };
        try {
          const removedIds = [targetId, ...own ? [id] : []];
          const lockDocument = export10(JE.currentSettings?.tagLayoutLocks);
          const locksBefore = Object.fromEntries(removedIds.filter((key) => lockDocument[key]).map((key) => [key, JSON.parse(JSON.stringify(lockDocument[key]))]));
          const hadLock = !!keptAt(targetId) || targetId !== id && !!own;
          if (saved.scopes.has("personal")) {
          } else if (keep) {
            const remove = targetId !== id && own ? [id] : [];
            const ok = await look.editLocks({ [targetId]: chosen }, remove);
            if (!isCurrent()) return;
            note("personal", ok);
            if (ok) JE.toast?.(esc(JE.t("tag_item_editor_kept", { name: label })));
          } else if (hadLock) {
            const ok = await look.editLocks({}, [targetId, ...own ? [id] : []]);
            if (!isCurrent()) return;
            note("personal", ok);
            if (ok) showUndo(JE.t("tag_item_editor_unlocked", { name: label }), () => look.restoreLocks(locksBefore), options.host);
          }
          if (everyoneBox && !saved.scopes.has("everyone")) {
            const had = overrideAt(targetId);
            if (everyone) {
              const ok = await look.saveItemOverride(targetId, chosen, { remove: targetId !== id && ownOverride ? [id] : [] });
              if (!isCurrent()) return;
              note("everyone", ok);
              if (ok) JE.toast?.(esc(JE.t("tag_item_editor_everyone_saved", { name: label })));
            } else if (had) {
              const previous = { ...had };
              const ok = await look.saveItemOverride(targetId, null);
              if (!isCurrent()) return;
              note("everyone", ok);
              if (ok) showUndo(JE.t("tag_item_editor_everyone_removed", { name: label }), () => {
                look.saveItemOverride(targetId, previous, { restoreOnly: true });
              }, options.host);
            }
          }
        } catch (err) {
          if (!isCurrent()) return;
          console.warn(`${logPrefix} saving the item look failed:`, err);
          results.push({ scope: "", ok: false });
        }
        if (results.some((r) => !r.ok)) {
          saveButton.disabled = false;
          const failed = results.find((r) => !r.ok)?.scope;
          saveError = failed === "everyone" && saved.scopes.has("personal") ? JE.t("tag_item_editor_error_everyone_only") : failed === "personal" && saved.scopes.has("everyone") ? JE.t("tag_item_editor_error_personal_only") : JE.t("tag_item_editor_error");
          showStatus();
          return;
        }
        if (!results.length && dirty) JE.toast?.(esc(JE.t("tag_item_editor_nothing_kept")));
        finish();
      });
      sync();
      present();
      dialog.focus({ preventScroll: true });
      const first = dialog.querySelector("input:checked") || dialog.querySelector("input");
      first?.focus({ preventScroll: true });
      return true;
    }
    function closeMounted() {
      current?.close();
    }
    function close() {
      cancelPending();
      closeMounted();
    }
    JE.session?.onUserChange?.("tag-item-editor", () => {
      close();
      document.querySelectorAll(".je-tie-toast").forEach((el) => el.remove());
    });
    const api = {
      open,
      close,
      isOpen: () => !!current,
      /** @returns Whether an open is still waiting for its item data. */
      isOpening: () => !!pendingOpen,
      anyTagsOn,
      TYPES,
      // Exposed for tests.
      stepCap
    };
    JE.tagItemEditor = api;
    return api;
  }

  // client/src/features/media-tags/editor/tag-item-editor-entry.ts
  createItemEditor(export4());
})();
})();
//# sourceMappingURL=tag-item-editor.js.map
