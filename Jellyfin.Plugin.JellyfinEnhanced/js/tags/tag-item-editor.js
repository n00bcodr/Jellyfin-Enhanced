// @ts-check
// /js/tags/tag-item-editor.js
//
// The per-item Media Tags editor: a dialog (opened from the item's ⋮ menu by
// tags/tag-item-menu.js, from Edit on the hub's locked items and, in its
// server mode, from the Media Tags admin page) that shows the item's poster
// with its real tags in a draft look and edits that look: layout, label
// density, each group's place (on/off, the layout's positions, nine anchors
// on Corners) and "Show up to", tag size, gap and edge spacing.
//
// Nothing is kept unless the look is locked: "Keep this look for this item"
// on saves it as the item's lock (core/tag-look.js tagLayoutLocks), off
// removes the lock and the item follows rules and the default again.
// Administrators also get "For everyone", which stores the same document as
// the item's server-wide look (TagLookItemOverrides). For a series, season or
// episode the look can be kept for the item only or for the series and its
// seasons and episodes (one lock on the series, which they inherit).
//
// The sample card is drawn with the tag renderers from the item's tag data
// (or copied from one of its cards on the page) and given the draft look
// through core/tag-layout.js setPreviewLook, so it uses the real layout code.
//
// Public surface: JE.tagItemEditor { open, close, isOpen }.
(function (JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced [TagLook]:';
    const TYPES = new Set(['Movie', 'Series', 'Season', 'Episode', 'BoxSet', 'Video']);
    const LAYOUTS = ['corners', 'bands', 'caption', 'summary', 'minimal'];
    const SCALES = ['smaller', 'default', 'larger', 'largest'];
    const GAPS = ['tight', 'default', 'roomy'];
    const EDGES = ['default', 'tight', 'flush'];
    const MAX_CAP = 10;
    const UNDO_MS = 8000;

    /**
     * Per group: its enable setting, name string, and cap rule (the hub's:
     * `capAll` groups may show every tag, `capFixed` groups always show one).
     */
    const GROUPS = {
        status: { setting: 'statusTagsEnabled', nameKey: 'panel_settings_ui_tag_group_status', capFixed: true },
        quality: { setting: 'qualityTagsEnabled', nameKey: 'panel_settings_ui_tag_group_quality', capAll: true },
        rating: { setting: 'ratingTagsEnabled', nameKey: 'panel_settings_ui_tag_group_rating', capAll: true },
        ageRating: { setting: 'ageRatingTagsEnabled', nameKey: 'panel_settings_ui_tag_group_age_rating', capFixed: true },
        language: { setting: 'languageTagsEnabled', nameKey: 'panel_settings_ui_tag_group_language' },
        genre: { setting: 'genreTagsEnabled', nameKey: 'panel_settings_ui_tag_group_genre' },
        awards: { setting: 'awardsTagsEnabled', nameKey: 'awards_tags_group', capAll: true },
        logos: { setting: 'logoTagsEnabled', nameKey: 'panel_settings_ui_tag_group_logos', capAll: true },
        custom: { setting: 'customTagsEnabled', nameKey: 'panel_settings_ui_tag_group_custom' },
    };

    /** Corners anchors in reading order (the 3 × 3 grid). */
    const ANCHORS = ['tl', 'tc', 'tr', 'ml', 'c', 'mr', 'bl', 'bc', 'br'];

    const CSS = `
        .je-tie-backdrop { position: fixed; inset: 0; z-index: 100000; display: flex; align-items: flex-start; justify-content: center; padding: 24px 12px; box-sizing: border-box; background: rgba(0,0,0,0.6); overflow-y: auto; }
        .je-tie { width: min(880px, 100%); box-sizing: border-box; margin: auto 0; border-radius: 10px; border: 1px solid rgba(255,255,255,0.18); background: #1d2026; color: #fff; box-shadow: 0 10px 40px rgba(0,0,0,0.5); font-size: 14px; text-align: left; }
        .je-tie:focus { outline: none; }
        .je-tie-head { display: flex; align-items: center; gap: 12px; padding: 12px 14px 8px 16px; border-bottom: 1px solid rgba(255,255,255,0.08); }
        .je-tie-title { flex: 1 1 auto; min-width: 0; margin: 0; font-size: 17px; font-weight: 600; overflow-wrap: anywhere; }
        .je-tie-chip { display: inline-block; margin-left: 6px; padding: 1px 5px; border: 1px solid #ffb74d; border-radius: 4px; color: #ffb74d; font-size: 10px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; vertical-align: middle; }
        .je-tie-close { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; flex: 0 0 auto; border: 0; border-radius: 6px; background: transparent; color: #fff; cursor: pointer; }
        .je-tie-close:hover { background: rgba(255,255,255,0.08); }
        .je-tie-body { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 16px; padding: 14px 16px; }
        .je-tie-side { position: sticky; top: 0; align-self: start; }
        .je-tie-card { position: relative; width: 100%; }
        .je-tie-card .cardBox { margin: 0; }
        .je-tie-scalable { position: relative; width: 100%; aspect-ratio: 2 / 3; border-radius: 6px; overflow: hidden; contain: paint; background: #2b303a center / cover no-repeat; }
        .je-tie-card[data-je-shape="landscape"] .je-tie-scalable { aspect-ratio: 16 / 9; }
        .je-tie-card .je-tag-host { position: absolute; inset: 0; pointer-events: none; container-type: inline-size; }
        .je-tie-card-title { font-size: 12px; padding: 4px 2px 0; color: rgba(255,255,255,0.9); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .je-tie-source { margin: 8px 0 0; font-size: 12px; line-height: 1.4; color: rgba(255,255,255,0.7); }
        .je-tie-source strong { color: #7fd3ff; }
        .je-tie-note { margin: 6px 0 0; font-size: 12px; color: #ffd699; }
        .je-tie-main { min-width: 0; display: flex; flex-direction: column; gap: 12px; }
        .je-tie-box { margin: 0; padding: 10px 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.03); min-width: 0; }
        .je-tie-box > legend, .je-tie-h { padding: 0; margin: 0 0 6px; font-size: 13px; font-weight: 600; }
        .je-tie-hint { margin: 2px 0 0; font-size: 12px; line-height: 1.4; color: rgba(255,255,255,0.65); }
        .je-tie input[type="radio"] { position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0; pointer-events: none; }
        .je-tie-tiles { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 6px; }
        .je-tie-tile, .je-tie-pill { position: relative; display: inline-flex; align-items: center; justify-content: center; min-height: 36px; padding: 4px 8px; box-sizing: border-box; border-radius: 8px; border: 1px solid rgba(255,255,255,0.16); background: rgba(0,0,0,0.2); cursor: pointer; font-size: 13px; font-weight: 600; text-align: center; }
        .je-tie-tile:hover, .je-tie-pill:hover { background: rgba(255,255,255,0.06); }
        .je-tie-tile:has(input:checked), .je-tie-pill:has(input:checked) { border-color: #00a4dc; background: rgba(0,164,220,0.18); box-shadow: inset 0 0 0 1px #00a4dc; }
        .je-tie-tile:has(input:focus-visible), .je-tie-pill:has(input:focus-visible) { outline: 2px solid #fff; outline-offset: 2px; }
        .je-tie-pills { display: flex; flex-wrap: wrap; gap: 6px; }
        .je-tie-scope { display: flex; flex-direction: column; gap: 6px; }
        .je-tie-scope .je-tie-pill { justify-content: flex-start; text-align: left; }
        .je-tie-groups { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
        .je-tie-group { display: grid; grid-template-columns: 150px minmax(0, 1fr) 176px; align-items: center; gap: 6px 10px; padding: 6px 8px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.08); background: rgba(0,0,0,0.16); }
        .je-tie-group[data-on="0"] .je-tie-where, .je-tie-group[data-on="0"] .je-tie-cap { opacity: 0.4; pointer-events: none; }
        .je-tie-gname { display: flex; flex-direction: column; min-width: 0; }
        .je-tie-gname small { font-size: 11px; color: #ffd699; font-weight: 400; }
        .je-tie-switch { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px; font-weight: 600; min-height: 32px; }
        .je-tie-switch input { width: 34px; height: 18px; margin: 0; flex: 0 0 auto; accent-color: #00a4dc; cursor: pointer; }
        .je-tie-where .je-tie-pill { min-height: 30px; padding: 2px 8px; font-size: 12px; }
        .je-tie-anchors { display: grid; grid-template-columns: repeat(3, 30px); grid-auto-rows: 22px; gap: 3px; }
        .je-tie-anchor { position: relative; display: block; border-radius: 4px; border: 1px solid rgba(255,255,255,0.22); background: rgba(0,0,0,0.25); cursor: pointer; }
        .je-tie-anchor::after { content: ''; position: absolute; inset: 6px 9px; border-radius: 2px; background: rgba(255,255,255,0.25); }
        .je-tie-anchor:has(input:checked) { border-color: #00a4dc; background: rgba(0,164,220,0.25); }
        .je-tie-anchor:has(input:checked)::after { background: #00a4dc; }
        .je-tie-anchor:has(input:focus-visible) { outline: 2px solid #fff; outline-offset: 1px; }
        .je-tie-cap { display: inline-flex; align-items: center; justify-content: flex-end; gap: 4px; font-size: 12px; white-space: nowrap; }
        .je-tie-cap button, .je-tie-foot button, .je-tie-toast button { font: inherit; color: #fff; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.2); border-radius: 6px; min-height: 32px; cursor: pointer; font-weight: 600; }
        .je-tie-cap button { width: 32px; padding: 0; }
        .je-tie-cap button:disabled { opacity: 0.35; cursor: default; }
        .je-tie-cap output { min-width: 26px; text-align: center; font-weight: 600; }
        .je-tie-row3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
        .je-tie-row3 label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; font-weight: 600; min-width: 0; }
        .je-tie select { font: inherit; font-size: 13px; color: #fff; background: #12141a; border: 1px solid #5a606b; border-radius: 6px; padding: 6px; min-height: 36px; min-width: 0; }
        .je-tie select option { background: #222; color: #fff; }
        .je-tie-keep { border-color: rgba(0,164,220,0.45); }
        .je-tie-keep[data-everyone] { border-color: rgba(255,183,77,0.5); }
        .je-tie-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; padding: 10px 16px 14px; border-top: 1px solid rgba(255,255,255,0.08); }
        .je-tie-foot .je-tie-status { flex: 1 1 200px; margin: 0; font-size: 12px; color: #ffd699; }
        .je-tie-foot button { padding: 0 16px; min-height: 40px; }
        .je-tie-foot .je-tie-save { background: #00a4dc; border-color: #00a4dc; }
        .je-tie button:focus-visible, .je-tie select:focus-visible, .je-tie-switch input:focus-visible, .je-tie-toast button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
        .je-tie-toast { position: fixed; left: 50%; bottom: 24px; z-index: 100001; transform: translateX(-50%); display: flex; align-items: center; gap: 12px; max-width: calc(100vw - 32px); box-sizing: border-box; padding: 10px 12px 10px 16px; border-radius: 8px; background: #2b2f38; color: #fff; box-shadow: 0 6px 24px rgba(0,0,0,0.5); font-size: 14px; }
        .je-tie-toast button { padding: 0 12px; color: #7fd3ff; }
        @media (max-width: 640px) {
            .je-tie-backdrop { padding: 0; }
            .je-tie { border-radius: 0; min-height: 100%; border: 0; }
            .je-tie-body { grid-template-columns: minmax(0, 1fr); padding: 10px 12px; }
            .je-tie-side { position: static; display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 4px 12px; align-items: start; }
            .je-tie-card[data-je-shape="landscape"] { grid-column: 1 / -1; max-width: 260px; }
            .je-tie-tiles { grid-template-columns: repeat(3, minmax(0, 1fr)); }
            .je-tie-group { grid-template-columns: minmax(0, 1fr) auto; }
            .je-tie-where { grid-column: 1 / -1; grid-row: 2; }
            .je-tie-row3 { grid-template-columns: minmax(0, 1fr); }
            .je-tie-foot { position: sticky; bottom: 0; background: #1d2026; }
        }
    `;

    /** @type {null|{close: (saved?: boolean) => void, backdrop: HTMLElement}} the open editor */
    let current = null;
    let sequence = 0;

    const esc = (value) => JE.escapeHtml(String(value ?? ''));
    const tx = (key, params) => esc(JE.t(key, params));
    /** @returns {any} */
    const layoutApi = () => JE.core?.tagLayout || null;
    /** @returns {any} */
    const lookApi = () => JE.core?.tagLook || null;

    /**
     * Label of a slot in a layout ("Bottom row"), or "Hidden" for off.
     * @param {string} layout
     * @param {string} slot
     * @returns {string}
     */
    function slotLabel(layout, slot) {
        return slot === 'off' ? JE.t('panel_settings_ui_tag_slot_off') : JE.t(`panel_settings_ui_tag_slot_${layout}_${slot}`);
    }

    /**
     * The positions a group can take in a layout (no "off": the switch hides it).
     * @param {string} layout
     * @param {string} group
     * @returns {string[]}
     */
    function positionsFor(layout, group) {
        return (layoutApi().LAYOUT_SLOTS[layout] || []).filter((slot) => slot !== 'off' && (slot !== 'dots' || group === 'quality'));
    }

    /**
     * The next "Show up to" value for a stepper press, or null when the
     * group cannot go further (the hub's policy: 1..10, then All for groups
     * that may show every tag).
     * @param {number} cap - 0 = all.
     * @param {number} dir
     * @param {{capAll?: boolean, capFixed?: boolean}} meta
     * @returns {number|null}
     */
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

    /** @returns {boolean} The signed-in user sees some poster tag group. */
    function anyTagsOn() {
        const s = JE.currentSettings || {};
        return Object.values(GROUPS).some((g) => s[g.setting] === true);
    }

    /**
     * Whether a group can draw for this user (its switch, and Awards also the
     * administrator's).
     * @param {string} group
     * @returns {boolean}
     */
    function groupOn(group) {
        if (group === 'awards' && JE.pluginConfig?.AwardsTagsEnabled === false) return false;
        return JE.currentSettings?.[GROUPS[group].setting] === true;
    }

    /**
     * @typedef {Object} Draft - The look being edited.
     * @property {string} layout
     * @property {string} density
     * @property {Object<string, Object<string, string>>} slots - layout → group → slot (each layout remembered while switching).
     * @property {Object<string, number>} caps - Only the groups given their own "Show up to".
     * @property {string|null} tagScale
     * @property {string|null} tagGap
     * @property {string|null} edge
     */

    /**
     * The draft as a lock document for the chosen layout.
     * @param {Draft} draft
     * @param {'item'|null} scope
     * @returns {Object}
     */
    function lookOf(draft, scope) {
        return {
            layout: draft.layout,
            density: draft.density,
            slots: { ...draft.slots[draft.layout] },
            caps: Object.keys(draft.caps).length ? { ...draft.caps } : null,
            tagScale: draft.tagScale,
            tagGap: draft.tagGap,
            edge: draft.edge,
            scope,
        };
    }

    /**
     * Where the look a card of the item has now comes from, in words.
     * @param {{source: string, index: number}} source
     * @param {boolean} inherited - The lock or item look is its series'.
     * @returns {string}
     */
    function sourceText(source, inherited) {
        switch (source.source) {
            case 'lock': return JE.t(inherited ? 'tag_item_editor_source_lock_series' : 'tag_item_editor_source_lock');
            case 'override': return JE.t(inherited ? 'tag_item_editor_source_override_series' : 'tag_item_editor_source_override');
            case 'rule': return JE.t('panel_media_tags_preview_source_rule', { n: source.index + 1 });
            case 'shape': return JE.t('tag_item_editor_source_shape');
            default: return JE.t('tag_item_editor_source_default');
        }
    }

    /**
     * A short-lived message with an Undo button (8 s).
     * @param {string} message
     * @param {() => void} undo
     * @param {HTMLElement} [host] - Where it goes (the settings panel keeps the page behind inert).
     */
    function showUndo(message, undo, host) {
        const isCurrent = lookApi().captureSession();
        document.querySelectorAll('.je-tie-toast').forEach((el) => el.remove());
        const toast = document.createElement('div');
        toast.className = 'je-tie-toast';
        toast.setAttribute('role', 'status');
        const text = document.createElement('span');
        text.textContent = message;
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = JE.t('tag_item_editor_undo');
        const timer = setTimeout(() => toast.remove(), UNDO_MS);
        button.addEventListener('click', () => {
            clearTimeout(timer);
            toast.remove();
            if (isCurrent()) undo();
        });
        toast.append(text, button);
        (host && host.isConnected ? host : document.body).appendChild(toast);
    }

    /**
     * Draw the item's tags onto the sample card: copied from one of the
     * item's cards on the page when there is one (what the user sees), else
     * drawn by each enabled renderer from the server tag-cache entry, else
     * from the browser's per-tag cache.
     * @param {HTMLElement} target - The sample's render target.
     * @param {string} id
     * @param {Object|null} entry - The server tag-cache entry, or null.
     * @returns {boolean} Whether any group was drawn.
     */
    function drawTags(target, id, entry) {
        const L = layoutApi();
        const pipeline = JE.tagPipeline;
        L.ensureHost(target);
        if (entry) L.setCardContext(target, entry, id);
        // A card of the item on the page carries exactly the tags the user sees.
        for (const host of document.querySelectorAll('.je-tag-host')) {
            if (target.contains(host) || L.cardIdentity(/** @type {HTMLElement} */ (host)) !== id) continue;
            let copied = 0;
            for (const group of L.GROUPS) {
                const master = L.getGroup(host, group);
                if (master) { L.commitGroup(target, group, master.cloneNode(true)); copied++; }
            }
            if (copied) return true;
        }
        if (!pipeline?.getRenderer) return false;
        const names = ['status', 'quality', 'genre', 'rating', 'agerating', 'custom', 'userreview', 'language', 'awards', 'logos'];
        for (const name of names) {
            const renderer = pipeline.getRenderer(name);
            if (!renderer || !renderer.isEnabled?.()) continue;
            try {
                if (entry && renderer.renderFromServerCache) renderer.renderFromServerCache(target, entry, id);
                else if (renderer.renderFromCache) renderer.renderFromCache(target, id);
            } catch (err) {
                console.warn(`${logPrefix} the item editor's sample could not draw ${name}:`, err);
            }
        }
        return L.GROUPS.some((group) => L.hasGroup(target, group));
    }

    /**
     * The item, read once for the editor: its name, type, series and image.
     * @param {string} id
     * @returns {Promise<Object|null>}
     */
    async function fetchItem(id) {
        try {
            return await ApiClient.getItem(ApiClient.getCurrentUserId(), id);
        } catch (err) {
            console.warn(`${logPrefix} could not read item ${id}:`, err);
            return null;
        }
    }

    /** @returns {Promise<boolean>} The signed-in user is an administrator. */
    async function isAdministrator() {
        try {
            const user = await ApiClient.getCurrentUser();
            return user?.Policy?.IsAdministrator === true;
        } catch {
            return false;
        }
    }

    /**
     * @typedef {Object} OpenOptions
     * @property {HTMLElement|null} [opener] - Focus returns here on close.
     * @property {() => HTMLElement|null} [returnFocus] - Replacement row or list heading after a scope move.
     * @property {HTMLElement} [host] - Where the dialog goes (default the page; the
     *   settings panel, which keeps everything outside it inert, passes itself).
     * @property {Object} [item] - The item, when the caller has it already.
     * @property {'user'|'server'} [mode] - 'server': edit the item's server-wide
     *   look only (the admin page), saved through onSave.
     * @property {Object|null} [look] - Server mode: the look to start from.
     * @property {(look: Object, target: string) => void} [onSave] - Server mode: keep the look.
     */

    /**
     * Open the editor for an item. A second open replaces the first.
     * @param {string} itemId
     * @param {OpenOptions} [options]
     * @returns {Promise<boolean>} False when the item cannot be edited.
     */
    async function open(itemId, options = {}) {
        const L = layoutApi();
        const look = lookApi();
        const id = look?.normalizeId(String(itemId || ''));
        if (!L || !look || !id) return false;
        const serverMode = options.mode === 'server';
        const opener = options.opener || /** @type {HTMLElement|null} */ (document.activeElement);
        const isCurrent = look.captureSession();

        const [item, admin] = await Promise.all([options.item ? Promise.resolve(options.item) : fetchItem(id), serverMode ? Promise.resolve(true) : isAdministrator()]);
        if (!isCurrent()) return false;
        if (!item || !TYPES.has(item.Type)) {
            JE.toast?.(JE.t('tag_item_editor_unsupported'));
            return false;
        }
        close();
        JE.core.ui?.injectCss?.('je-tag-item-editor', CSS);

        const type = String(item.Type);
        const name = String(item.Name || '');
        const seriesId = (type === 'Season' || type === 'Episode') ? look.normalizeId(String(item.SeriesId || '')) : null;
        const hasSeries = type === 'Series' || !!seriesId;
        const seriesTarget = type === 'Series' ? id : seriesId;
        const read = look.read();
        const own = read.locks.get(id) || null;
        const seriesLock = seriesId ? read.locks.get(seriesId) || null : null;
        const ownOverride = read.overrides.get(id) || null;
        const seriesOverride = seriesId ? read.overrides.get(seriesId) || null : null;

        // Where the item's look comes from now, and the look it has.
        const serverEntry = JE.tagPipeline?.peekServerEntry?.(id) || null;
        let facts = serverEntry;
        if (!facts && !serverMode) {
            try { facts = await JE.tagPipeline?.itemLookFacts?.(id); } catch { facts = null; }
            if (!isCurrent()) return false;
        }
        const itemCard = opener?.closest?.('.card') || document.querySelector(`.card[data-id="${id}"]`);
        const shape = itemCard ? L.shapeOf(itemCard) : (type === 'Episode' ? 'landscape' : 'portrait');
        const context = { ...(facts || {}), Id: id, Type: type, SeriesId: seriesId || facts?.SeriesId, itemId: id, cardType: type, shape };
        const before = L.lookSource(context);
        const base = L.normalizeSettings();
        const conf = L.resolveLayout(context);

        // Start from the look the item keeps (its own, else its series'), else
        // the look its cards have now.
        const usable = (lock) => lock && (lock !== seriesLock || lock.scope !== 'item');
        const startLock = serverMode ? (options.look ? look.normalizeLock(options.look) : null)
            : (own || (usable(seriesLock) ? seriesLock : null) || ownOverride || (seriesOverride && seriesOverride.scope !== 'item' ? seriesOverride : null));
        // Freeze the fully resolved appearance, including the active shape's
        // fields on a rule/lock/override. An inheritance marker is safe only
        // where the unshaped base resolves to the same value.
        let effective = conf;
        if (serverMode && startLock) {
            const sample = document.createElement('div');
            sample.dataset.jeShape = shape;
            L.setPreviewLook(sample, startLock);
            effective = L.resolveLayout(sample);
            L.setPreviewLook(sample, null);
        }
        const startLayout = effective.layout;
        /** @type {Draft} */
        const draft = {
            layout: startLayout,
            density: effective.density,
            slots: {},
            caps: {
                ...Object.fromEntries(Object.entries(effective.caps).filter(([group, cap]) => cap !== base.caps[group])),
                // Presentation caps do not rewrite a saved single-chip cap when another field is edited.
                ...Object.fromEntries(Object.entries({ ...(startLock?.caps || {}), ...(startLock?.shapes?.[shape]?.caps || {}) })
                    .filter(([group]) => L.singleChipGroup(group))),
            },
            tagScale: effective.tagScale === base.tagScale ? null : effective.tagScale,
            tagGap: effective.tagGap === base.tagGap ? null : effective.tagGap,
            edge: effective.edge === base.edge ? null : effective.edge,
        };
        for (const layout of LAYOUTS) draft.slots[layout] = { ...base.profiles[layout] };
        /** @type {Object<string, string>} "layout:group" → the position a group had before it was switched off */
        const lastSlot = {};
        draft.slots[startLayout] = { ...effective.slots };

        /** @type {'item'|'series'} */
        let scope = !hasSeries ? 'item'
            : own ? (type === 'Series' && own.scope !== 'item' ? 'series' : 'item')
            : (usable(seriesLock) ? 'series' : (type === 'Series' ? 'series' : 'item'));
        if (serverMode && type === 'Series' && startLock) scope = startLock.scope === 'item' ? 'item' : 'series';
        const keptAt = (target) => (target ? read.locks.get(target) || null : null);
        const overrideAt = (target) => (target ? read.overrides.get(target) || null : null);
        const targetOf = () => (scope === 'series' && seriesTarget ? seriesTarget : id);
        const scopeField = () => (type === 'Series' && scope === 'item' ? 'item' : null);
        let keep = !!keptAt(targetOf());
        let everyone = !!overrideAt(targetOf());

        // ── Markup ──
        const uid = `jeTie${++sequence}`;
        const backdrop = document.createElement('div');
        backdrop.className = 'je-tie-backdrop';
        const typeName = JE.t(`tag_looks_type_${type.toLowerCase()}`);
        const titleKey = serverMode ? 'tag_item_editor_title_server' : 'tag_item_editor_title';
        backdrop.innerHTML = `<div class="je-tie" role="dialog" aria-modal="true" aria-labelledby="${uid}Title" tabindex="-1">
            <div class="je-tie-head"><h3 class="je-tie-title" id="${uid}Title"><span data-tie-title></span>${serverMode ? `<span class="je-tie-chip">${tx('tag_item_editor_everyone_chip')}</span>` : ''}</h3>
                <button type="button" class="je-tie-close" data-tie-close aria-label="${tx('tag_item_editor_close')}"><span class="material-icons" aria-hidden="true">close</span></button></div>
            <div class="je-tie-body">
                <div class="je-tie-side">
                    <div class="je-tie-card" data-je-shape="${esc(shape)}" data-id="${esc(id)}" data-type="${esc(type)}" aria-hidden="true"><div class="cardBox"><div class="je-tie-scalable cardScalable"></div><div class="cardText je-tie-card-title">${esc(name)}</div></div></div>
                    <div><p class="je-tie-source" data-tie-source></p><p class="je-tie-note" data-tie-note hidden></p></div>
                </div>
                <div class="je-tie-main">
                    ${hasSeries ? `<fieldset class="je-tie-box"><legend>${tx('tag_item_editor_scope')}</legend><div class="je-tie-scope" role="radiogroup">
                        <label class="je-tie-pill"><input type="radio" name="${uid}Scope" value="item">${tx(type === 'Series' ? 'tag_item_editor_scope_series_only' : 'tag_item_editor_scope_item', { type: typeName })}</label>
                        <label class="je-tie-pill"><input type="radio" name="${uid}Scope" value="series">${tx('tag_item_editor_scope_series')}</label></div></fieldset>` : ''}
                    <fieldset class="je-tie-box"><legend>${tx('panel_media_tags_tab_layout')}</legend><div class="je-tie-tiles">
                        ${LAYOUTS.map((l) => `<label class="je-tie-tile"><input type="radio" name="${uid}Layout" value="${l}">${tx(`tag_looks_layout_${l}`)}</label>`).join('')}</div></fieldset>
                    <fieldset class="je-tie-box"><legend>${tx('panel_settings_ui_tag_density')}</legend><div class="je-tie-pills">
                        ${['full', 'compact'].map((d) => `<label class="je-tie-pill"><input type="radio" name="${uid}Density" value="${d}">${tx(`panel_settings_ui_tag_density_${d}`)}</label>`).join('')}</div></fieldset>
                    <section class="je-tie-box" aria-labelledby="${uid}Groups"><h4 class="je-tie-h" id="${uid}Groups">${tx('tag_item_editor_groups')}</h4><ul class="je-tie-groups" data-tie-groups></ul></section>
                    <fieldset class="je-tie-box"><legend>${tx('tag_item_editor_spacing')}</legend><div class="je-tie-row3">
                        <label>${tx('tag_scale_label')}<select data-tie-select="tagScale"></select></label>
                        <label>${tx('tag_gap_label')}<select data-tie-select="tagGap"></select></label>
                        <label>${tx('panel_settings_ui_tag_edge')}<select data-tie-select="edge"></select></label></div></fieldset>
                    ${serverMode ? `<p class="je-tie-hint">${tx('tag_item_editor_server_hint')}</p>` : `<div class="je-tie-box je-tie-keep">
                        <label class="je-tie-switch"><input type="checkbox" data-tie-keep aria-describedby="${uid}KeepHint">${tx('tag_item_editor_keep')}</label>
                        <p class="je-tie-hint" id="${uid}KeepHint">${tx('tag_item_editor_keep_hint')}</p></div>`}
                    ${!serverMode && admin ? `<div class="je-tie-box je-tie-keep" data-everyone>
                        <label class="je-tie-switch"><input type="checkbox" data-tie-everyone aria-describedby="${uid}EveryoneHint">${tx('tag_item_editor_everyone')}<span class="je-tie-chip">${tx('tag_item_editor_everyone_chip')}</span></label>
                        <p class="je-tie-hint" id="${uid}EveryoneHint">${tx('tag_item_editor_everyone_hint')}</p></div>` : ''}
                </div>
            </div>
            <div class="je-tie-foot"><p class="je-tie-status" data-tie-status role="status" aria-live="polite"></p>
                <button type="button" data-tie-close>${tx('tag_item_editor_cancel')}</button>
                <button type="button" class="je-tie-save" data-tie-save>${tx('tag_item_editor_save')}</button></div>
        </div>`;
        // Item names and translated substitutions are text, including hostile markup.
        backdrop.querySelector('[data-tie-title]').textContent = JE.t(titleKey, { name: name || typeName });
        const host = options.host && options.host.isConnected ? options.host : document.body;
        host.appendChild(backdrop);
        const dialog = /** @type {HTMLElement} */ (backdrop.firstElementChild);
        const target = /** @type {HTMLElement} */ (dialog.querySelector('.je-tie-scalable'));
        const groupsList = /** @type {HTMLElement} */ (dialog.querySelector('[data-tie-groups]'));
        const sourceEl = /** @type {HTMLElement} */ (dialog.querySelector('[data-tie-source]'));
        const noteEl = /** @type {HTMLElement} */ (dialog.querySelector('[data-tie-note]'));
        const statusEl = /** @type {HTMLElement} */ (dialog.querySelector('[data-tie-status]'));
        const keepBox = /** @type {HTMLInputElement|null} */ (dialog.querySelector('[data-tie-keep]'));
        const everyoneBox = /** @type {HTMLInputElement|null} */ (dialog.querySelector('[data-tie-everyone]'));

        // The poster (the episode's still) under the tags.
        const image = item.ImageTags?.Primary ? ApiClient.getScaledImageUrl(id, { type: 'Primary', maxHeight: 480, tag: item.ImageTags.Primary }) : '';
        if (image) target.style.backgroundImage = `url("${image}")`;
        const drawn = drawTags(target, id, serverEntry);
        noteEl.hidden = drawn;
        noteEl.textContent = drawn ? '' : JE.t('tag_item_editor_no_tags');

        /** @type {ReturnType<typeof setTimeout>|null} */
        let presentTimer = null;
        let dirty = false;
        /** Show the draft on the sample and say what will happen on Save. */
        const present = () => {
            L.setPreviewLook(target, { ...lookOf(draft, scopeField()), locked: keep });
            // A lock or item look the item does not hold itself is its series'.
            const inherited = (before.source === 'lock' && !own) || (before.source === 'override' && !ownOverride);
            // Without the item's data a rule or series look could not be matched: say so rather than guess.
            const unknown = !facts && (read.rules.length > 0 || !!seriesId);
            sourceEl.replaceChildren(document.createTextNode(`${JE.t('tag_item_editor_now')} `), Object.assign(document.createElement('strong'), { textContent: unknown ? JE.t('tag_item_editor_source_unknown') : sourceText(before, !!inherited) }));
            if (dirty) sourceEl.append(document.createElement('br'), document.createTextNode(JE.t('tag_item_editor_draft')));
            showStatus();
        };
        /** @type {string} a failed save's message, shown until the next change */
        let saveError = '';
        /** The footer line: a failed save, else whether the changes will stick. */
        const showStatus = () => {
            statusEl.textContent = saveError || (!serverMode && !keep && !everyone && dirty ? JE.t('tag_item_editor_not_kept') : '');
        };
        /** Coalesce bursts of changes (a stepper held down) into one re-present. */
        const schedule = () => {
            if (presentTimer) return;
            presentTimer = setTimeout(() => { presentTimer = null; if (backdrop.isConnected) present(); }, 0);
        };

        /** Rebuild the group rows for the draft's layout (focus kept by key). */
        const renderGroups = () => {
            const focusKey = /** @type {HTMLElement|null} */ (document.activeElement)?.dataset?.tieKey || null;
            const slots = draft.slots[draft.layout];
            // The groups that draw for this user first, the ones switched off in their settings after.
            const ordered = base.order || L.DEFAULT_ORDER;
            const order = [...ordered.filter((g) => groupOn(g)), ...ordered.filter((g) => !groupOn(g))];
            groupsList.innerHTML = order.map((group) => {
                const meta = GROUPS[group];
                if (!meta) return '';
                const slot = slots[group] || 'off';
                const on = slot !== 'off';
                const gname = JE.t(meta.nameKey);
                const positions = positionsFor(draft.layout, group);
                const current = on ? slot : (lastSlot[`${draft.layout}:${group}`] || positions[0]);
                const where = draft.layout === 'corners'
                    ? `<div class="je-tie-anchors" role="radiogroup" aria-label="${tx('tag_item_editor_position', { group: gname })}">${ANCHORS.map((a) => `<label class="je-tie-anchor" title="${tx(`panel_settings_ui_tag_slot_corners_${a}`)}"><input type="radio" name="${uid}-${group}" value="${a}" data-tie-key="${group}-${a}" aria-label="${esc(slotLabel('corners', a))}" ${a === current ? 'checked' : ''}></label>`).join('')}</div>`
                    : `<div class="je-tie-pills" role="radiogroup" aria-label="${tx('tag_item_editor_position', { group: gname })}">${positions.map((p) => `<label class="je-tie-pill"><input type="radio" name="${uid}-${group}" value="${p}" data-tie-key="${group}-${p}" ${p === current ? 'checked' : ''}>${esc(slotLabel(draft.layout, p))}</label>`).join('')}</div>`;
                const fixed = L.singleChipGroup(group);
                const cap = fixed ? 1 : (draft.caps[group] ?? base.caps[group]);
                const capText = cap === 0 ? JE.t('panel_settings_ui_tag_editor_cap_all') : String(cap);
                const stepper = fixed ? '' : `<div class="je-tie-cap" role="group" aria-label="${tx('tag_item_editor_cap_named', { group: gname })}">
                    <span>${tx('panel_settings_ui_tag_editor_show_up_to')}</span>
                    <button type="button" data-tie-step="-1" data-tie-key="${group}-down" aria-label="${tx('tag_item_editor_cap_fewer', { group: gname })}" ${stepCap(cap, -1, meta) === null ? 'disabled' : ''}>−</button>
                    <output aria-live="polite">${esc(capText)}</output>
                    <button type="button" data-tie-step="1" data-tie-key="${group}-up" aria-label="${tx('tag_item_editor_cap_more', { group: gname })}" ${stepCap(cap, 1, meta) === null ? 'disabled' : ''}>+</button></div>`;
                return `<li class="je-tie-group" data-group="${group}" data-on="${on ? 1 : 0}">
                    <div class="je-tie-gname"><label class="je-tie-switch"><input type="checkbox" data-tie-on data-tie-key="${group}-on" ${on ? 'checked' : ''}>${esc(gname)}</label>${groupOn(group) ? '' : `<small>${tx('tag_item_editor_group_off_for_you')}</small>`}</div>
                    <div class="je-tie-where">${where}</div>${stepper}</li>`;
            }).join('');
            if (focusKey) /** @type {HTMLElement|null} */ (groupsList.querySelector(`[data-tie-key="${focusKey}"]`))?.focus({ preventScroll: true });
        };

        /** Put every control in step with the draft. */
        const sync = () => {
            dialog.querySelectorAll(`input[name="${uid}Layout"]`).forEach((r) => { /** @type {HTMLInputElement} */ (r).checked = /** @type {HTMLInputElement} */ (r).value === draft.layout; });
            dialog.querySelectorAll(`input[name="${uid}Density"]`).forEach((r) => { /** @type {HTMLInputElement} */ (r).checked = /** @type {HTMLInputElement} */ (r).value === draft.density; });
            dialog.querySelectorAll(`input[name="${uid}Scope"]`).forEach((r) => { /** @type {HTMLInputElement} */ (r).checked = /** @type {HTMLInputElement} */ (r).value === scope; });
            if (keepBox) keepBox.checked = keep;
            if (everyoneBox) everyoneBox.checked = everyone;
            renderGroups();
        };

        // Size, gap and edge: "Same as default (…)" keeps the user's.
        const selectOptions = {
            tagScale: { values: SCALES, label: (v) => JE.t(`tag_scale_${v}`), base: base.tagScale },
            tagGap: { values: GAPS, label: (v) => JE.t(`tag_gap_${v}`), base: base.tagGap },
            edge: { values: EDGES, label: (v) => JE.t(`panel_settings_ui_tag_edge_${v}`), base: base.edge },
        };
        for (const [key, spec] of Object.entries(selectOptions)) {
            const select = /** @type {HTMLSelectElement} */ (dialog.querySelector(`[data-tie-select="${key}"]`));
            select.innerHTML = `<option value="">${tx('tag_item_editor_same_as_default', { value: spec.label(spec.base) })}</option>`
                + spec.values.map((v) => `<option value="${v}">${esc(spec.label(v))}</option>`).join('');
            select.value = draft[key] || '';
            select.addEventListener('change', () => {
                draft[key] = select.value || null;
                dirty = true;
                schedule();
            });
        }

        dialog.addEventListener('change', (e) => {
            const input = /** @type {HTMLInputElement} */ (e.target);
            if (input.name === `${uid}Layout`) {
                draft.layout = input.value;
                renderGroups();
            } else if (input.name === `${uid}Density`) {
                draft.density = input.value;
            } else if (input.name === `${uid}Scope`) {
                scope = input.value === 'series' ? 'series' : 'item';
                keep = keep || !!keptAt(targetOf());
                if (everyoneBox) everyone = everyone || !!overrideAt(targetOf());
                sync();
            } else if (input.matches('[data-tie-keep]')) {
                keep = input.checked;
            } else if (input.matches('[data-tie-everyone]')) {
                everyone = input.checked;
            } else if (input.matches('[data-tie-on]')) {
                const group = /** @type {HTMLElement} */ (input.closest('[data-group]')).dataset.group || '';
                const slots = draft.slots[draft.layout];
                const key = `${draft.layout}:${group}`;
                if (input.checked) slots[group] = lastSlot[key] || positionsFor(draft.layout, group)[0];
                else { if (slots[group] && slots[group] !== 'off') lastSlot[key] = slots[group]; slots[group] = 'off'; }
                renderGroups();
            } else if (input.type === 'radio' && input.closest('[data-group]')) {
                const group = /** @type {HTMLElement} */ (input.closest('[data-group]')).dataset.group || '';
                draft.slots[draft.layout][group] = input.value;
            } else {
                return;
            }
            dirty = dirty || !input.matches('[data-tie-keep], [data-tie-everyone]');
            saveError = '';
            schedule();
        });
        groupsList.addEventListener('click', (e) => {
            const button = /** @type {HTMLButtonElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-tie-step]'));
            if (!button || button.disabled) return;
            const group = /** @type {HTMLElement} */ (button.closest('[data-group]')).dataset.group || '';
            const meta = GROUPS[group];
            if (L.singleChipGroup(group)) return;
            const cap = draft.caps[group] ?? base.caps[group];
            const next = stepCap(cap, Number(button.dataset.tieStep), meta);
            if (next === null) return;
            draft.caps[group] = next;
            dirty = true;
            renderGroups();
            schedule();
        });

        // ── Closing, focus, saving ──
        const focusables = () => Array.from(dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled])'))
            .filter((el) => !el.closest('[hidden]') && !(/** @type {HTMLInputElement} */ (el).type === 'radio' && !/** @type {HTMLInputElement} */ (el).checked && dialog.querySelector(`input[name="${/** @type {HTMLInputElement} */ (el).name}"]:checked`)));
        const onFocusIn = (e) => {
            // Jellyfin's closing action sheet hands focus back to its button: keep it here.
            if (backdrop.isConnected && !backdrop.contains(/** @type {Node} */ (e.target))) dialog.focus({ preventScroll: true });
        };
        const onNavigate = () => finish();
        let closed = false;
        /** Tear the editor down (no save) and give focus back. */
        const finish = () => {
            if (closed) return;
            closed = true;
            if (presentTimer) clearTimeout(presentTimer);
            document.removeEventListener('focusin', onFocusIn, true);
            window.removeEventListener('hashchange', onNavigate);
            L.setPreviewLook(target, null);
            L.clearCard(target);
            backdrop.remove();
            if (current?.backdrop === backdrop) current = null;
            // A list redrawn meanwhile (the hub's locked items) has a new button with the opener's focus key.
            const key = opener?.dataset?.jeFocusKey;
            const back = options.returnFocus?.() || (opener?.isConnected ? opener
                : (key ? /** @type {HTMLElement|undefined} */ (Array.from(document.querySelectorAll('[data-je-focus-key]')).find((el) => /** @type {HTMLElement} */ (el).dataset.jeFocusKey === key)) : null));
            back?.focus({ preventScroll: true });
        };
        current = { close: finish, backdrop };
        dialog.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                finish();
                return;
            }
            if (e.key !== 'Tab') return;
            const list = focusables();
            if (!list.length) return;
            e.stopPropagation();
            const at = list.indexOf(/** @type {HTMLElement} */ (document.activeElement));
            if (e.shiftKey && at <= 0) { e.preventDefault(); list[list.length - 1].focus(); }
            else if (!e.shiftKey && at === list.length - 1) { e.preventDefault(); list[0].focus(); }
        });
        backdrop.addEventListener('click', (e) => {
            if (/** @type {HTMLElement} */ (e.target).closest('[data-tie-close]')) finish();
        });
        document.addEventListener('focusin', onFocusIn, true);
        window.addEventListener('hashchange', onNavigate);

        const saveButton = /** @type {HTMLButtonElement} */ (dialog.querySelector('[data-tie-save]'));
        saveButton.addEventListener('click', async () => {
            if (saveButton.disabled || !isCurrent()) return;
            const targetId = targetOf();
            const chosen = lookOf(draft, scopeField());
            if (serverMode) {
                options.onSave?.(chosen, targetId);
                finish();
                return;
            }
            saveButton.disabled = true;
            statusEl.textContent = JE.t('tag_looks_loading');
            const label = name || typeName;
            const results = [];
            try {
                // Personal lock: one save for the whole change (the series lock
                // replaces a season's or episode's own lock).
                const removedIds = [targetId, ...(own ? [id] : [])];
                const locksBefore = Object.fromEntries(removedIds.filter((key) => JE.currentSettings?.tagLayoutLocks?.[key]).map((key) => [key, JSON.parse(JSON.stringify(JE.currentSettings.tagLayoutLocks[key]))]));
                const hadLock = !!keptAt(targetId) || (targetId !== id && !!own);
                if (keep) {
                    const remove = targetId !== id && own ? [id] : [];
                    const ok = await look.editLocks({ [targetId]: chosen }, remove);
                    if (!isCurrent()) return;
                    results.push(ok);
                    if (ok) JE.toast?.(esc(JE.t('tag_item_editor_kept', { name: label })));
                } else if (hadLock) {
                    const ok = await look.editLocks({}, [targetId, ...(own ? [id] : [])]);
                    if (!isCurrent()) return;
                    results.push(ok);
                    if (ok) showUndo(JE.t('tag_item_editor_unlocked', { name: label }), () => look.restoreLocks(locksBefore), options.host);
                }
                if (everyoneBox) {
                    const had = overrideAt(targetId);
                    if (everyone) {
                        const ok = await look.saveItemOverride(targetId, chosen, { remove: targetId !== id && ownOverride ? [id] : [] });
                        if (!isCurrent()) return;
                        results.push(ok);
                        if (ok) JE.toast?.(esc(JE.t('tag_item_editor_everyone_saved', { name: label })));
                    } else if (had) {
                        const previous = { ...had };
                        const ok = await look.saveItemOverride(targetId, null);
                        if (!isCurrent()) return;
                        results.push(ok);
                        if (ok) showUndo(JE.t('tag_item_editor_everyone_removed', { name: label }), () => { look.saveItemOverride(targetId, previous, { restoreOnly: true }); }, options.host);
                    }
                }
            } catch (err) {
                if (!isCurrent()) return;
                console.warn(`${logPrefix} saving the item look failed:`, err);
                results.push(false);
            }
            if (results.includes(false)) {
                saveButton.disabled = false;
                saveError = JE.t('tag_item_editor_error');
                showStatus();
                return;
            }
            if (!results.length && dirty) JE.toast?.(esc(JE.t('tag_item_editor_nothing_kept')));
            finish();
        });

        sync();
        present();
        dialog.focus({ preventScroll: true });
        const first = /** @type {HTMLElement|null} */ (dialog.querySelector('input:checked') || dialog.querySelector('input'));
        first?.focus({ preventScroll: true });
        return true;
    }

    /** Close the open editor without saving. */
    function close() {
        current?.close();
    }

    // A user switch closes the editor: its drafts belong to the outgoing user.
    JE.session?.onUserChange?.('tag-item-editor', () => {
        close();
        document.querySelectorAll('.je-tie-toast').forEach((el) => el.remove());
    });

    JE.tagItemEditor = {
        open,
        close,
        /** @returns {boolean} */
        isOpen: () => !!current,
        anyTagsOn,
        TYPES,
        // Exposed for tests.
        stepCap,
    };
})(window.JellyfinEnhanced);
