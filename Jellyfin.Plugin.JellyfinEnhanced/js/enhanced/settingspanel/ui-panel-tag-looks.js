// @ts-check
/**
 * @file The Rules & locks tab of the settings panel's Media Tags hub: the
 * tag look rules (ordered, first match wins, each with move buttons, an
 * On/Off switch, Edit and Delete), the "Otherwise" row (the default layout)
 * and the locked items (titles loaded once the tab shows, Unlock, Unlock
 * all) on the left; the add/edit rule form, always open, on the right (below
 * on a narrow pane, where the locks fold into a "Locked items · N" line).
 * Data and saving live in core/tag-look.js; every change re-presents the
 * cards through JE.reinitializeTagLayout() without a refetch.
 *
 * Rows are keyed by rule and item id and updated in place, so a change never
 * rebuilds the form under the user's hands, and focus is put back on purpose
 * after every change: the moved rule's button, the next row after a delete
 * or unlock, the list's empty state when nothing is left, the new rule after
 * Add rule. Everything is built with DOM APIs (textContent), never innerHTML.
 */
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.enhancedUi = JE.internals.enhancedUi || {};

    const LAYOUTS = ['corners', 'bands', 'caption', 'summary', 'minimal'];
    const TITLE_BATCH = 50;
    const CONFIRM_MS = 4000;
    /** @type {(() => void)|null} Cleanup for the open panel's layout listener. */
    let unwatchLayout = null;

    const PANEL_CSS = `
        .je-tag-looks { margin: 0; }
        .je-tag-looks-cols { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 12px; align-items: start; }
        .je-tag-looks-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin: 0 0 6px; }
        .je-tag-looks-heading { margin: 0; font-size: 14px; font-weight: 600; color: #fff; }
        .je-tag-looks-count { display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 20px; padding: 0 6px; box-sizing: border-box; border-radius: 10px; background: rgba(255,255,255,0.12); font-size: 13px; font-weight: 600; }
        .je-tag-looks-sub { font-size: 13px; color: rgba(255,255,255,0.6); }
        .je-tag-looks-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
        .je-tag-looks-row { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.18); }
        .je-tag-looks-row[data-off="1"] .je-tag-looks-text { opacity: 0.55; }
        .je-tag-looks-row:focus { outline: none; }
        .je-tag-looks-text { min-width: 0; font-size: 13px; line-height: 1.4; overflow-wrap: anywhere; }
        .je-tag-looks-outcome { color: #7fd3ff; font-weight: 600; }
        .je-tag-looks-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
        .je-tag-looks-empty { margin: 0; padding: 8px 10px; border-radius: 8px; border: 1px dashed rgba(255,255,255,0.18); font-size: 13px; color: rgba(255,255,255,0.65); }
        .je-tag-looks-empty:focus { outline: none; }
        .je-tag-looks-empty:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
        .je-tag-looks-otherwise { margin-top: 8px; border-style: dashed; }
        .je-tag-looks-otherwise .je-tag-looks-text { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
        .je-tag-looks button, .je-tag-looks select, .je-tag-looks input {
            font: inherit; font-size: 13px; color: #fff; background: rgba(255,255,255,0.08);
            border: 1px solid rgba(255,255,255,0.46); border-radius: 6px; padding: 4px 8px; min-height: 36px; box-sizing: border-box;
        }
        .je-tag-looks button { cursor: pointer; font-weight: 600; }
        .je-tag-looks button:hover:not(:disabled) { background: rgba(255,255,255,0.16); }
        .je-tag-looks button:disabled { opacity: 0.4; cursor: default; }
        .je-tag-looks button:focus-visible, .je-tag-looks select:focus-visible, .je-tag-looks input:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }
        .je-tag-looks select option { background: #222; color: #fff; }
        .je-tag-looks-move { width: 36px; padding: 0 !important; display: inline-flex; align-items: center; justify-content: center; }
        .je-tag-looks-move .material-icons { font-size: 16px; }
        .je-tag-looks-pill[aria-pressed="true"] { background: rgba(76,175,80,0.35); border-color: rgba(76,175,80,0.8); }
        .je-tag-looks-danger { color: #ff8a80 !important; }
        .je-tag-looks-locks { margin-top: 14px; }
        .je-tag-looks-locks-toggle { display: none; }
        .je-tag-looks [hidden] { display: none !important; }
        .je-tag-looks-locks-head .je-tag-looks-unlock-all { margin-left: auto; }
        .je-tag-looks-locked-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 240px; overflow: auto; }
        .je-tag-looks-locked-list li { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.08); background: rgba(0,0,0,0.18); }
        .je-tag-looks-locked-list li > span { flex: 1 1 auto; min-width: 0; font-size: 13px; line-height: 1.35; overflow-wrap: anywhere; }
        .je-tag-looks-locked-list li strong { display: block; font-size: 13px; color: #fff; }
        .je-tag-looks-locked-list li > .je-tag-looks-actions { flex: 0 0 auto; flex-wrap: nowrap; }
        .je-tag-looks-form { padding: 12px; border-radius: 8px; border: 1px solid rgba(0,164,220,0.45); background: rgba(0,164,220,0.06); display: flex; flex-direction: column; gap: 10px; }
        .je-tag-looks-form-title { margin: 0; font-size: 14px; font-weight: 600; }
        .je-tag-looks-form-hint { margin: -6px 0 0; font-size: 13px; color: rgba(255,255,255,0.6); }
        .je-tag-looks-form fieldset { border: 0; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
        .je-tag-looks-form legend { font-size: 13px; font-weight: 600; padding: 0; margin-bottom: 4px; }
        /* Condition N / [field] [✕] / is [value]: two lines, so both selects keep their width. */
        .je-tag-looks-cond { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 4px 6px; align-items: center; }
        .je-tag-looks-cond-label { grid-column: 1 / -1; grid-row: 1; font-size: 13px; color: rgba(255,255,255,0.7); }
        .je-tag-looks-cond > [data-je-cond-field] { grid-column: 1 / 3; grid-row: 2; }
        .je-tag-looks-cond > [data-je-cond-remove] { grid-column: 3; grid-row: 2; }
        .je-tag-looks-cond-is { grid-column: 1; grid-row: 3; font-size: 13px; color: rgba(255,255,255,0.7); }
        .je-tag-looks-cond > [data-je-cond-value] { grid-column: 2 / 4; grid-row: 3; }
        .je-tag-looks-cond > select, .je-tag-looks-cond > input { min-width: 0; width: 100%; }
        .je-tag-looks-cond + .je-tag-looks-cond { margin-top: 6px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.08); }
        /* A wide enough form (the phone's full width) puts each condition on one line. */
        .je-tag-looks-side { container: je-looks-form / inline-size; }
        @container je-looks-form (min-width: 300px) {
            .je-tag-looks-cond { grid-template-columns: minmax(0, 2fr) auto minmax(0, 3fr) auto; }
            .je-tag-looks-cond > [data-je-cond-field] { grid-column: 1; grid-row: 2; }
            .je-tag-looks-cond-is { grid-column: 2; grid-row: 2; }
            .je-tag-looks-cond > [data-je-cond-value] { grid-column: 3; grid-row: 2; }
            .je-tag-looks-cond > [data-je-cond-remove] { grid-column: 4; grid-row: 2; }
        }
        .je-tag-looks-cond [aria-invalid="true"] { border-color: #ff8a80; }
        .je-tag-looks-add-cond { display: flex; align-items: center; gap: 8px; font-size: 13px; color: rgba(255,255,255,0.6); }
        .je-tag-looks-outcome-row { display: flex; flex-wrap: wrap; gap: 8px; }
        .je-tag-looks-outcome-row label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; flex: 1 1 120px; min-width: 0; }
        .je-tag-looks-error { color: #ff8a80; font-size: 13px; }
        .je-tag-looks-error:empty { display: none; }
        .je-tag-looks-buttons { position: static; bottom: 0; z-index: 2; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 -12px -12px; padding: 10px 12px calc(10px + env(safe-area-inset-bottom, 0px)); border-top: 1px solid rgba(255,255,255,0.1); border-radius: 0 0 8px 8px; background: rgb(22, 30, 34); }
        .je-tag-looks-form.je-form-visible .je-tag-looks-buttons { position: sticky; }
        .je-tag-looks-buttons .je-tag-looks-save { background: #0077a3; border-color: #0077a3; min-height: 36px; padding: 0 14px; font-size: 13px; }
        .je-tag-looks-buttons-hint { font-size: 13px; color: rgba(255,255,255,0.6); }
        .je-tag-looks-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
        /* The settings column of the hub (not the whole pane): too narrow for the rule list beside the form. */
        @container je-mth-panels (max-width: 560px) {
            .je-tag-looks-cols { grid-template-columns: minmax(0, 1fr); }
        }
        @container je-mth (max-width: 679px) {
            .je-tag-looks-cols { grid-template-columns: minmax(0, 1fr); }
            .je-tag-looks button, .je-tag-looks select, .je-tag-looks input { min-height: 44px; }
            .je-tag-looks-move { width: 44px; }
            .je-tag-looks-locks-toggle { display: inline-flex; margin-left: auto; }
            .je-tag-looks-locks:not(.je-open) .je-tag-looks-locks-body { display: none; }
            .je-tag-looks-locks-head .je-tag-looks-unlock-all { margin-left: 0; }
            .je-tag-looks-locks-head { flex-wrap: nowrap; }
        }
    `;

    /**
     * Shared lookups for one panel instance (fetched lazily, once).
     * @typedef {Object} LooksState
     * @property {Map<string, string>|null} libraries - library id → name.
     * @property {string[]|null} genres - null until loaded; [] when the request failed.
     * @property {Map<string, {name: string, type: string}>} titles - item id → title and type.
     * @property {boolean} lockedOpen - The locked items list is unfolded (narrow panes only fold it).
     * @property {boolean} shown - The tab has been shown: the locked items' titles may load.
     * @property {string} editing - Rule id the form edits, '' for a new rule.
     */

    /**
     * Create an element with a class and optional text.
     * @param {string} tag
     * @param {string} [className]
     * @param {string} [text]
     * @returns {HTMLElement}
     */
    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    /**
     * A plain button.
     * @param {string} label
     * @param {() => void} onClick
     * @param {string} [ariaLabel]
     * @returns {HTMLButtonElement}
     */
    function button(label, onClick, ariaLabel) {
        const b = /** @type {HTMLButtonElement} */ (el('button', '', label));
        b.type = 'button';
        if (ariaLabel) b.setAttribute('aria-label', ariaLabel);
        b.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
        return b;
    }

    /**
     * A select with options [value, label].
     * @param {Array<[string, string]>} options
     * @param {string} value
     * @returns {HTMLSelectElement}
     */
    function select(options, value) {
        const s = /** @type {HTMLSelectElement} */ (el('select'));
        for (const [v, label] of options) {
            const o = /** @type {HTMLOptionElement} */ (el('option', '', label));
            o.value = v;
            if (v === value) o.selected = true;
            s.appendChild(o);
        }
        return s;
    }

    /** @param {string} layout @returns {string} */
    const layoutName = (layout) => JE.t(JE.core.tagLayout.VOCABULARY_KEYS.layout[layout]);
    /** @param {string} density @returns {string} */
    const densityName = (density) => JE.t(density === 'compact' ? 'panel_settings_ui_tag_density_compact' : 'panel_settings_ui_tag_density_full');
    /** @param {{layout: string, density: string}} look @returns {string} */
    const outcomeText = (look) => JE.t('tag_looks_outcome', { layout: layoutName(look.layout), density: densityName(look.density) });
    /** @param {string} type @returns {string} */
    const typeName = (type) => JE.t(JE.core.tagLayout.VOCABULARY_KEYS.type[type.toLowerCase()]);

    /**
     * "When library is Kids and type is Episode".
     * @param {Array<{field: string, value: string}>} when
     * @param {LooksState} state
     * @returns {string}
     */
    function conditionText(when, state) {
        const parts = when.map((cond) => {
            let value = cond.value;
            if (cond.field === 'library') value = state.libraries?.get(cond.value) || JE.t('tag_looks_unknown_library');
            else if (cond.field === 'type') value = typeName(cond.value);
            return JE.t(`tag_looks_cond_${cond.field.toLowerCase()}`, { value });
        });
        return JE.t('tag_looks_when', { conditions: parts.join(JE.t('tag_looks_and')) });
    }

    /**
     * The current user's id.
     * @returns {string}
     */
    function userId() {
        return (typeof ApiClient !== 'undefined' && ApiClient.getCurrentUserId?.()) || '';
    }

    /**
     * GET a JSON endpoint through ApiClient.
     * @param {string} path
     * @param {Object} [query]
     * @returns {Promise<any>}
     */
    function getJson(path, query) {
        return ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl(path, query), dataType: 'json' });
    }

    /**
     * Load the user's libraries (id → name) once.
     * @param {LooksState} state
     * @returns {Promise<void>}
     */
    async function loadLibraries(state) {
        if (state.libraries) return;
        const map = new Map();
        try {
            const resp = await getJson('UserViews', { userId: userId() });
            for (const view of resp?.Items || []) {
                const id = JE.core.tagLook.normalizeId(String(view?.Id || ''));
                if (id) map.set(id, String(view.Name || id));
            }
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: could not load libraries for tag look rules', err);
        }
        state.libraries = map;
    }

    /**
     * Load the genre names once ([] when the request fails: the form then
     * offers a text box).
     * @param {LooksState} state
     * @returns {Promise<void>}
     */
    async function loadGenres(state) {
        if (state.genres) return;
        try {
            const resp = await getJson('Genres', { userId: userId(), SortBy: 'SortName', SortOrder: 'Ascending', Recursive: true, EnableImages: false, EnableTotalRecordCount: false });
            const names = new Set();
            for (const g of resp?.Items || []) if (g?.Name) names.add(String(g.Name));
            state.genres = Array.from(names);
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: could not load genres for tag look rules', err);
            state.genres = [];
        }
    }

    /**
     * Age ratings present in the server tag cache already in memory,
     * normalised the way the age rating tags show them.
     * @returns {string[]}
     */
    function knownRatings() {
        const seen = new Set();
        try {
            for (const entry of JE.tagPipeline?.serverEntries?.() || []) {
                const raw = entry?.OfficialRating;
                if (!raw) continue;
                const text = String(raw).replace(/\s+/g, ' ').trim();
                const shown = typeof JE.normalizeOfficialRating === 'function' ? (JE.normalizeOfficialRating(text) || text) : text;
                seen.add(shown);
                if (seen.size >= 200) break;
            }
        } catch { /* the list is only a convenience */ }
        return Array.from(seen).sort();
    }

    /**
     * Fetch titles for locked items not known yet, 50 ids per request.
     * @param {LooksState} state
     * @param {string[]} ids
     * @returns {Promise<void>}
     */
    async function loadTitles(state, ids) {
        const missing = ids.filter((id) => !state.titles.has(id));
        for (let i = 0; i < missing.length; i += TITLE_BATCH) {
            const batch = missing.slice(i, i + TITLE_BATCH);
            try {
                const resp = await getJson(`Users/${userId()}/Items`, { Ids: batch.join(','), EnableImages: false, EnableUserData: false });
                for (const item of resp?.Items || []) {
                    const id = JE.core.tagLook.normalizeId(String(item?.Id || ''));
                    if (id) state.titles.set(id, { name: String(item.Name || id), type: String(item.Type || '') });
                }
            } catch (err) {
                console.warn('🪼 Jellyfin Enhanced: could not load locked item titles', err);
            }
            // Ids the server didn't return (deleted, or no longer visible) keep their id as the title.
            for (const id of batch) if (!state.titles.has(id)) state.titles.set(id, { name: '', type: '' });
        }
    }

    /**
     * A small icon button (move up/down).
     * @param {string} icon - Material icon name.
     * @param {() => void} onClick
     * @param {string} ariaLabel
     * @returns {HTMLButtonElement}
     */
    function iconButton(icon, onClick, ariaLabel) {
        const b = button('', onClick, ariaLabel);
        b.className = 'je-tag-looks-move';
        const glyph = el('span', 'material-icons', icon);
        glyph.setAttribute('aria-hidden', 'true');
        b.appendChild(glyph);
        return b;
    }

    /**
     * Focus an element without scrolling the panel past it.
     * @param {Element|null|undefined} node
     */
    function focusOn(node) {
        const target = /** @type {HTMLElement|null|undefined} */ (node);
        if (!target || !target.isConnected) return;
        target.focus({ preventScroll: true });
        target.scrollIntoView?.({ block: 'nearest' });
    }

    /**
     * The section's lasting DOM: built once per panel, then updated in place.
     * @typedef {Object} LooksView
     * @property {HTMLElement} root
     * @property {HTMLElement} rulesCount
     * @property {HTMLElement} list - The rules <ol>.
     * @property {HTMLElement} empty - Shown (and focusable) when there are no rules.
     * @property {HTMLElement} otherwiseOutcome
     * @property {HTMLElement} locks
     * @property {HTMLElement} locksCount
     * @property {HTMLButtonElement} locksToggle
     * @property {HTMLButtonElement} unlockAll
     * @property {HTMLElement} lockedList
     * @property {HTMLElement} locksEmpty
     * @property {HTMLElement} side - Holds the form.
     * @property {Map<string, Object>} rows - Rule id → its row and controls.
     * @property {(message: string) => void} announce
     */

    /**
     * Build the section skeleton into its mount.
     * @param {HTMLElement} mount
     * @param {LooksState} state
     * @param {() => void} touch
     * @param {() => void} renderAll
     * @returns {LooksView}
     */
    function buildView(mount, state, touch, renderAll) {
        const root = el('section', 'je-tag-looks');
        root.setAttribute('aria-label', JE.t('tag_looks_title'));
        const cols = el('div', 'je-tag-looks-cols');
        const main = el('div', 'je-tag-looks-main');
        const side = el('div', 'je-tag-looks-side');

        const head = el('div', 'je-tag-looks-head');
        const heading = el('h5', 'je-tag-looks-heading', JE.t('common_rules'));
        heading.id = 'jeTagLooksRulesTitle';
        const rulesCount = el('span', 'je-tag-looks-count');
        head.append(heading, rulesCount, el('span', 'je-tag-looks-sub', JE.t('tag_looks_first_match')));
        const list = el('ol', 'je-tag-looks-list');
        list.setAttribute('aria-labelledby', heading.id);
        const empty = el('p', 'je-tag-looks-empty', JE.t('tag_looks_no_rules'));
        empty.tabIndex = -1;

        const otherwise = el('div', 'je-tag-looks-row je-tag-looks-otherwise');
        otherwise.dataset.jeRow = 'otherwise';
        const otherText = el('div', 'je-tag-looks-text');
        const otherwiseOutcome = el('span', 'je-tag-looks-outcome');
        otherText.append(el('span', '', JE.t('tag_looks_otherwise')), otherwiseOutcome);
        const change = button(JE.t('tag_looks_change_default'), () => {
            touch();
            // The default layout is the hub's Layout tab; without the hub, the tiles wherever they are.
            internal.mediaTagsHub?.openTab?.('layout');
            const tile = document.querySelector('input[name="jeTagLayout"]:checked') || document.querySelector('input[name="jeTagLayout"]');
            focusOn(tile);
        }, JE.t('tag_looks_change_default_named'));
        otherText.appendChild(change);
        otherwise.appendChild(otherText);

        // Locked items: always win. A narrow pane folds them into one line.
        const locks = el('div', 'je-tag-looks-locks');
        locks.dataset.jeRow = 'locked';
        const locksHead = el('div', 'je-tag-looks-head je-tag-looks-locks-head');
        const locksTitle = el('h5', 'je-tag-looks-heading', JE.t('tag_looks_locked_heading'));
        locksTitle.id = 'jeTagLooksLocksTitle';
        const locksCount = el('span', 'je-tag-looks-count');
        const locksToggle = button(JE.t('tag_looks_show'), () => {
            state.lockedOpen = !state.lockedOpen;
            touch();
            renderAll();
        });
        locksToggle.classList.add('je-tag-looks-locks-toggle');
        locksToggle.setAttribute('aria-controls', 'jeTagLooksLocksBody');
        const unlockAll = button(JE.t('tag_looks_unlock_all'), () => {
            touch();
            if (unlockAll.dataset.confirm !== '1') {
                unlockAll.dataset.confirm = '1';
                unlockAll.textContent = JE.t('tag_looks_unlock_all_confirm');
                setTimeout(() => {
                    if (!unlockAll.isConnected) return;
                    delete unlockAll.dataset.confirm;
                    unlockAll.textContent = JE.t('tag_looks_unlock_all');
                }, CONFIRM_MS);
                return;
            }
            delete unlockAll.dataset.confirm;
            unlockAll.textContent = JE.t('tag_looks_unlock_all');
            view.settle(JE.core.tagLook.unlockItems(), 'tag_looks_unlocked_all_toast');
            renderAll();
            view.announce(JE.t('tag_looks_unlocked_all_toast'));
            focusOn(locksEmpty);
        });
        unlockAll.classList.add('je-tag-looks-unlock-all');
        locksHead.append(locksTitle, locksCount, locksToggle);
        const body = el('div', 'je-tag-looks-locks-body');
        body.id = 'jeTagLooksLocksBody';
        const bodyHead = el('div', 'je-tag-looks-head je-tag-looks-locks-head');
        bodyHead.append(el('span', 'je-tag-looks-sub', JE.t('tag_looks_locked_desc')), unlockAll);
        const lockedList = el('ul', 'je-tag-looks-locked-list');
        lockedList.id = 'jeTagLooksLockedList';
        lockedList.setAttribute('aria-labelledby', locksTitle.id);
        const locksEmpty = el('p', 'je-tag-looks-empty', JE.t('tag_looks_no_locks'));
        locksEmpty.tabIndex = -1;
        body.append(bodyHead, lockedList, locksEmpty);
        locks.append(locksHead, body);

        main.append(head, list, empty, otherwise, locks);
        cols.append(main, side);
        root.appendChild(cols);
        mount.replaceChildren(root);

        const live = el('div', 'je-tag-looks-sr');
        live.setAttribute('role', 'status');
        live.setAttribute('aria-live', 'polite');
        root.appendChild(live);

        /** @type {LooksView & {settle: (saving: Promise<boolean>, doneKey?: string) => void}} */
        const view = {
            root, rulesCount, list, empty, otherwiseOutcome, locks, locksCount, locksToggle, unlockAll, lockedList, locksEmpty, side,
            rows: new Map(),
            announce: (message) => {
                live.textContent = '';
                setTimeout(() => { if (live.isConnected) live.textContent = message; }, 30);
            },
            // Changes show at once; a failed save puts the previous rules or
            // locks back (core/tag-look.js), says so and redraws the lists.
            settle: (saving, doneKey) => {
                saving.then((saved) => {
                    if (saved) {
                        if (doneKey) JE.toast?.(JE.t(doneKey));
                        return;
                    }
                    JE.toast?.(JE.t('tag_looks_save_failed_toast'));
                    if (mount.isConnected) renderAll();
                });
            },
        };
        return view;
    }

    /**
     * Bring the rule rows in step with the rules: rows are reused by rule
     * id and moved (not rebuilt), texts and button states updated.
     * @param {LooksView & {settle: Function}} view
     * @param {LooksState} state
     * @param {Array<Object>} rules
     * @param {() => void} touch
     * @param {(next: Array<Object>, doneKey?: string) => void} saveRules
     * @param {() => void} openForm - Rebuild the form (state.editing changed).
     */
    function renderRules(view, state, rules, touch, saveRules, openForm) {
        const look = JE.core.tagLook;
        const focused = /** @type {HTMLElement|null} */ (document.activeElement);
        const ids = new Set(rules.map((r) => r.id));
        for (const [id, row] of view.rows) {
            if (!ids.has(id)) { row.li.remove(); view.rows.delete(id); }
        }
        rules.forEach((rule, index) => {
            let row = view.rows.get(rule.id);
            if (!row) {
                row = { li: el('li', 'je-tag-looks-row'), text: el('div', 'je-tag-looks-text') };
                row.li.dataset.jeRow = 'rule';
                row.li.dataset.jeRuleId = rule.id;
                row.li.tabIndex = -1;
                const id = rule.id;
                /** The rule as it is now (the row outlives the rules array it was built from). */
                const now = () => {
                    const all = look.read().rules;
                    return { all, index: all.findIndex((r) => r.id === id) };
                };
                const move = (delta) => {
                    const { all, index: at } = now();
                    if (at < 0 || at + delta < 0 || at + delta >= all.length) return;
                    const next = all.slice();
                    const [moved] = next.splice(at, 1);
                    next.splice(at + delta, 0, moved);
                    const pressed = delta < 0 ? row.up : row.down;
                    saveRules(next);
                    // Keep focus on the moved rule: the same button, or at an end its other one.
                    focusOn(pressed.disabled ? (delta < 0 ? row.down : row.up) : pressed);
                    view.announce(JE.t('tag_looks_rule_moved', { rule: conditionText(moved.when, state), n: String(at + delta + 1) }));
                };
                row.up = iconButton('arrow_upward', () => move(-1), '');
                row.down = iconButton('arrow_downward', () => move(1), '');
                row.pill = button('', () => {
                    const { all } = now();
                    saveRules(all.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)));
                });
                row.pill.className = 'je-tag-looks-pill';
                row.edit = button(JE.t('reviews_edit'), () => {
                    state.editing = id;
                    touch();
                    openForm();
                });
                        row.del = button(JE.t('reviews_delete'), () => {
                    const { all, index: at } = now();
                    if (at < 0) return;
                    // Focus goes to the next rule's Delete, else the previous one's, else the empty list.
                    const neighbour = all[at + 1] || all[at - 1] || null;
                    if (state.editing === id) {
                        state.editing = '';
                        openForm();
                    }
                    saveRules(all.filter((r) => r.id !== id));
                    focusOn(neighbour ? view.rows.get(neighbour.id)?.del : view.empty);
                    view.announce(JE.t('tag_looks_rule_deleted', { rule: conditionText(all[at].when, state) }));
                });
                row.del.classList.add('je-tag-looks-danger');
                const actions = el('div', 'je-tag-looks-actions');
                actions.append(row.up, row.down, row.pill, row.edit, row.del);
                row.li.append(row.text, actions);
                view.rows.set(rule.id, row);
            }
            const condition = conditionText(rule.when, state);
            row.text.replaceChildren(el('span', '', `${index + 1}. ${condition} `), el('span', 'je-tag-looks-outcome', `→ ${outcomeText(rule)}`));
            if (rule.enabled) delete row.li.dataset.off;
            else row.li.dataset.off = '1';
            row.up.disabled = index === 0;
            row.down.disabled = index === rules.length - 1;
            row.up.setAttribute('aria-label', JE.t('tag_looks_move_up', { rule: condition }));
            row.down.setAttribute('aria-label', JE.t('tag_looks_move_down', { rule: condition }));
            row.pill.textContent = JE.t(rule.enabled ? 'common_on' : 'track_off');
            row.pill.setAttribute('aria-pressed', rule.enabled ? 'true' : 'false');
            row.pill.setAttribute('aria-label', JE.t('tag_looks_enabled_named', { rule: condition }));
            row.edit.setAttribute('aria-label', JE.t('tag_looks_edit_named', { rule: condition }));
            row.del.setAttribute('aria-label', JE.t('tag_looks_delete_named', { rule: condition }));
            // appendChild moves an existing row into place (and drops its focus; put back below).
            if (view.list.children[index] !== row.li) view.list.insertBefore(row.li, view.list.children[index] || null);
        });
        if (focused && focused.isConnected && document.activeElement !== focused && view.list.contains(focused)) focused.focus({ preventScroll: true });
        view.rulesCount.textContent = String(rules.length);
        view.empty.hidden = rules.length > 0;
    }

    /**
     * Rebuild the locked items list (keyed focus is restored by data-je-focus-key).
     * @param {LooksView & {settle: Function}} view
     * @param {LooksState} state
     * @param {() => void} touch
     * @param {() => void} renderAll
     */
    function renderLocks(view, state, touch, renderAll) {
        const look = JE.core.tagLook;
        const locks = look.normalizeLocks(JE.currentSettings.tagLayoutLocks);
        const focusKey = /** @type {HTMLElement|null} */ (document.activeElement)?.dataset?.jeFocusKey || null;
        const hadFocus = view.lockedList.contains(document.activeElement);
        view.locksCount.textContent = String(locks.size);
        view.locks.classList.toggle('je-open', state.lockedOpen);
        view.locksToggle.textContent = JE.t(state.lockedOpen ? 'hidden_content_hide_button' : 'tag_looks_show');
        view.locksToggle.setAttribute('aria-expanded', state.lockedOpen ? 'true' : 'false');
        view.locksToggle.setAttribute('aria-label', JE.t(state.lockedOpen ? 'tag_looks_locks_hide' : 'tag_looks_locks_show', { count: String(locks.size) }));
        view.unlockAll.disabled = locks.size === 0;
        // Nothing to unfold without locks (a narrow pane shows only the count then).
        view.locksToggle.hidden = locks.size === 0;
        view.locksEmpty.hidden = locks.size > 0;
        const ordered = Array.from(locks.entries()).sort((a, b) => b[1].lockedAt - a[1].lockedAt);
        const pending = [];
        const items = ordered.map(([id, lock], index) => {
            const info = state.titles.get(id);
            if (!info) pending.push(id);
            const li = el('li');
            const name = info ? (info.name || JE.t('tag_looks_unknown_item')) : JE.t('hidden_content_admin_loading');
            const type = info?.type ? `${typeName(info.type)} → ` : '→ ';
            const text = el('span');
            text.append(el('strong', '', name), document.createTextNode(`${type}${outcomeText(lock)}`));
            const unlock = button(JE.t('tag_looks_unlock'), () => {
                touch();
                // Focus goes to the next item's Unlock, else the previous one's, else the empty list.
                const neighbour = ordered[index + 1]?.[0] || ordered[index - 1]?.[0] || null;
                view.settle(look.unlockItems([id]), 'tag_look_unlocked_toast');
                renderAll();
                focusOn(neighbour ? view.lockedList.querySelector(`[data-je-focus-key="unlock-${neighbour}"]`) : view.locksEmpty);
                view.announce(JE.t('tag_looks_unlocked_named', { name: info?.name || id }));
            }, JE.t('tag_looks_unlock_named', { name: info?.name || id }));
            unlock.dataset.jeFocusKey = `unlock-${id}`;
            // Edit opens the item's Media Tags editor (tags/tag-item-editor.js) on this lock.
            const edit = button(JE.t('reviews_edit'), () => {
                touch();
                JE.tagItemEditor?.open(id, { opener: edit, host: /** @type {HTMLElement|undefined} */ (view.root.closest('#jellyfin-enhanced-panel') || undefined) });
            }, JE.t('tag_looks_edit_lock_named', { name: info?.name || id }));
            edit.dataset.jeFocusKey = `edit-${id}`;
            const tools = el('span', 'je-tag-looks-actions');
            tools.append(edit, unlock);
            li.append(text, tools);
            return li;
        });
        view.lockedList.replaceChildren(...items);
        if (hadFocus && focusKey) {
            const again = view.lockedList.querySelector(`[data-je-focus-key="${focusKey}"]`);
            if (again) /** @type {HTMLElement} */ (again).focus({ preventScroll: true });
        }
        // Titles load once the tab has been shown, 50 ids per request.
        if (state.shown && pending.length) loadTitles(state, pending).then(() => { if (view.root.isConnected) renderLocks(view, state, touch, renderAll); });
    }

    /**
     * The add/edit rule form (always open). New rules default to Caption and
     * Compact; every condition needs a value; at most five conditions.
     * @param {LooksState} state
     * @param {Array<Object>} rules
     * @param {() => void} touch
     * @param {(rules: Array<Object>, doneKey?: string) => string|void} saveRules
     * @param {(savedId: string, added: boolean) => void} onSaved - Reset the form and focus the rule.
     * @param {() => void} onCancel
     * @returns {{form: HTMLElement, syncCapacity: () => void}} The form, and a
     *   re-check of the rule limit for after a change made outside it.
     */
    function buildForm(state, rules, touch, saveRules, onSaved, onCancel) {
        const look = JE.core.tagLook;
        const existing = (state.editing && rules.find((r) => r.id === state.editing)) || null;
        const form = /** @type {HTMLFormElement} */ (el('form', 'je-tag-looks-form'));
        const title = el('h5', 'je-tag-looks-form-title', JE.t(existing ? 'tag_looks_edit_rule' : 'tag_looks_add_a_rule'));
        title.id = 'jeTagLooksFormTitle';
        form.setAttribute('aria-labelledby', title.id);
        form.noValidate = true;
        form.append(title, el('p', 'je-tag-looks-form-hint', JE.t('tag_looks_conditions')));

        const errorId = 'jeTagLooksError';
        const conditions = el('fieldset');
        conditions.appendChild(el('legend', 'je-tag-looks-sr', JE.t('tag_looks_conditions')));
        const condList = el('div');
        conditions.appendChild(condList);
        form.appendChild(conditions);

        let rowSeq = 0;
        /**
         * The value control for a field: a select of libraries, types or
         * genres, or a text box (age rating, or genres that failed to load).
         * @param {string} field
         * @param {string} value
         * @param {string} id
         * @returns {HTMLSelectElement|HTMLInputElement}
         */
        const valueControl = (field, value, id) => {
            /** @type {HTMLSelectElement|HTMLInputElement} */
            let control;
            if (field === 'library') {
                const options = Array.from(state.libraries || new Map()).map(([libId, name]) => /** @type {[string, string]} */ ([libId, name]));
                if (value && !options.some(([v]) => v === value)) options.push([value, JE.t('tag_looks_unknown_library')]);
                control = select([['', JE.t('tag_looks_choose')], ...options], value);
            } else if (field === 'type') {
                control = select([['', JE.t('tag_looks_choose')], ...look.TYPES.map((t) => /** @type {[string, string]} */ ([t, typeName(t)]))], value);
            } else if (field === 'genre' && state.genres && state.genres.length) {
                const options = state.genres.map((g) => /** @type {[string, string]} */ ([g, g]));
                const match = state.genres.find((g) => g.toLowerCase() === value.toLowerCase());
                if (value && !match) options.push([value, value]);
                control = select([['', JE.t('tag_looks_choose')], ...options], match || value);
            } else {
                const input = /** @type {HTMLInputElement} */ (el('input'));
                input.type = 'text';
                input.maxLength = 100;
                input.value = value;
                if (field === 'ageRating') {
                    const ratings = knownRatings();
                    if (ratings.length) {
                        const listId = `${id}-ratings`;
                        const datalist = el('datalist');
                        datalist.id = listId;
                        for (const r of ratings) { const o = /** @type {HTMLOptionElement} */ (el('option')); o.value = r; datalist.appendChild(o); }
                        input.setAttribute('list', listId);
                        queueMicrotask(() => input.after(datalist));
                    }
                }
                control = input;
            }
            control.id = id;
            control.dataset.jeCondValue = '1';
            control.setAttribute('aria-required', 'true');
            control.addEventListener('change', () => clearError(control));
            return control;
        };

        /** @param {Element} control - Drop a value's invalid mark once it changes. */
        const clearError = (control) => {
            control.removeAttribute('aria-invalid');
            control.removeAttribute('aria-describedby');
        };

        /** Renumber the condition rows' labels and enable "+ Condition" / remove for the row count. */
        const syncRows = () => {
            const rows = Array.from(condList.querySelectorAll('[data-je-cond]'));
            rows.forEach((r, i) => {
                const n = String(i + 1);
                /** @type {HTMLElement} */ (r.querySelector('.je-tag-looks-cond-label')).textContent = JE.t('tag_looks_condition', { n });
                /** @type {HTMLElement} */ (r.querySelector('[data-je-field-label]')).textContent = JE.t('tag_looks_condition_field', { n });
                /** @type {HTMLElement} */ (r.querySelector('[data-je-value-label]')).textContent = JE.t('tag_looks_condition_value', { n });
                const remove = /** @type {HTMLButtonElement} */ (r.querySelector('[data-je-cond-remove]'));
                remove.disabled = rows.length <= 1;
                remove.setAttribute('aria-label', JE.t('tag_looks_remove_condition_named', { n }));
            });
            addCondition.disabled = rows.length >= look.MAX_CONDITIONS;
            condCount.textContent = JE.t('tag_looks_condition_count', { count: String(rows.length), max: String(look.MAX_CONDITIONS) });
        };

        /**
         * Add one condition row: "Condition N", the field, "is", the value, ✕.
         * @param {{field: string, value: string}} cond
         */
        const addRow = (cond) => {
            const n = ++rowSeq;
            const row = el('div', 'je-tag-looks-cond');
            row.dataset.jeCond = '1';
            const fieldId = `jeTagLooksField${n}`;
            const valueId = `jeTagLooksValue${n}`;
            const fieldLabel = el('label', 'je-tag-looks-sr');
            fieldLabel.dataset.jeFieldLabel = '1';
            fieldLabel.setAttribute('for', fieldId);
            const fieldSelect = select(look.FIELDS.map((f) => /** @type {[string, string]} */ ([f, JE.t(JE.core.tagLayout.VOCABULARY_KEYS.field[`${f.toLowerCase()}`])])), cond.field);
            fieldSelect.id = fieldId;
            fieldSelect.dataset.jeCondField = '1';
            const valueLabel = el('label', 'je-tag-looks-sr');
            valueLabel.dataset.jeValueLabel = '1';
            valueLabel.setAttribute('for', valueId);
            let control = valueControl(cond.field, cond.value, valueId);
            fieldSelect.addEventListener('change', () => {
                touch();
                const next = valueControl(fieldSelect.value, '', valueId);
                control.nextElementSibling?.tagName === 'DATALIST' && control.nextElementSibling.remove();
                control.replaceWith(next);
                control = next;
            });
            const remove = button('✕', () => {
                touch();
                const rows = Array.from(condList.querySelectorAll('[data-je-cond]'));
                const at = rows.indexOf(row);
                row.remove();
                syncRows();
                // Focus the field of the row that took its place, else the one before it.
                const left = condList.querySelectorAll('[data-je-cond-field]');
                focusOn(left[Math.min(at, left.length - 1)]);
            });
            remove.dataset.jeCondRemove = '1';
            row.append(el('span', 'je-tag-looks-cond-label'), fieldLabel, fieldSelect, el('span', 'je-tag-looks-cond-is', JE.t('tag_looks_is')), valueLabel, control, remove);
            const is = row.querySelector('.je-tag-looks-cond-is');
            is?.setAttribute('aria-hidden', 'true');
            condList.appendChild(row);
        };

        const addLine = el('div', 'je-tag-looks-add-cond');
        const addCondition = button(JE.t('tag_looks_add_condition'), () => {
            touch();
            addRow({ field: 'type', value: '' });
            syncRows();
            focusOn(condList.lastElementChild?.querySelector('[data-je-cond-field]'));
        });
        const condCount = el('span');
        addLine.append(addCondition, condCount);
        conditions.appendChild(addLine);

        for (const cond of existing?.when?.length ? existing.when : [{ field: 'library', value: '' }]) addRow(cond);
        syncRows();

        const outcome = el('fieldset');
        outcome.appendChild(el('legend', '', JE.t('tag_looks_use_look')));
        const outcomeRow = el('div', 'je-tag-looks-outcome-row');
        const layoutLabel = el('label', '', JE.t('panel_settings_ui_tag_layout'));
        const layoutSelect = select(LAYOUTS.map((l) => /** @type {[string, string]} */ ([l, layoutName(l)])), existing?.layout || 'caption');
        layoutSelect.dataset.jeRuleLayout = '1';
        layoutLabel.appendChild(layoutSelect);
        const densityLabel = el('label', '', JE.t('panel_settings_ui_tag_density'));
        const densitySelect = select([['full', densityName('full')], ['compact', densityName('compact')]], existing?.density || 'compact');
        densitySelect.dataset.jeRuleDensity = '1';
        densityLabel.appendChild(densitySelect);
        outcomeRow.append(layoutLabel, densityLabel);
        outcome.appendChild(outcomeRow);
        form.appendChild(outcome);

        const error = el('div', 'je-tag-looks-error');
        error.id = errorId;
        error.setAttribute('role', 'alert');
        form.appendChild(error);

        const buttons = el('div', 'je-tag-looks-buttons');
        const save = /** @type {HTMLButtonElement} */ (el('button', 'je-tag-looks-save', JE.t(existing ? 'tag_looks_save' : 'tag_looks_add_rule')));
        save.type = 'submit';
        buttons.appendChild(save);
        if (existing) buttons.appendChild(button(JE.t('jellyseerr_modal_cancel'), () => { touch(); onCancel(); }));
        const hint = el('span', 'je-tag-looks-buttons-hint');
        buttons.appendChild(hint);
        form.appendChild(buttons);

        /**
         * A new rule can be added only below the limit: re-read the rules
         * now (a delete or a failed save changes the count under the form,
         * which keeps what was typed).
         * @returns {boolean} The limit is reached.
         */
        const syncCapacity = () => {
            const full = !existing && look.read().rules.length >= look.MAX_RULES;
            save.disabled = full;
            hint.textContent = JE.t(full ? 'tag_looks_limit' : existing ? 'tag_looks_edit_hint' : 'tag_looks_add_hint', { count: String(look.MAX_RULES) });
            return full;
        };
        syncCapacity();

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            touch();
            if (syncCapacity()) return;
            const when = [];
            for (const row of condList.querySelectorAll('[data-je-cond]')) {
                const field = /** @type {HTMLSelectElement} */ (row.querySelector('[data-je-cond-field]')).value;
                const control = /** @type {HTMLInputElement} */ (row.querySelector('[data-je-cond-value]'));
                const value = control.value.trim();
                if (!value) {
                    error.textContent = JE.t('tag_looks_error_value');
                    control.setAttribute('aria-invalid', 'true');
                    control.setAttribute('aria-describedby', errorId);
                    control.focus();
                    return;
                }
                when.push({ field, value });
            }
            const current = look.read().rules;
            const still = existing ? current.find((r) => r.id === existing.id) : null;
            // The rule being edited was deleted meanwhile: this would add one.
            if (!still && current.length >= look.MAX_RULES) {
                error.textContent = JE.t('tag_looks_limit', { count: String(look.MAX_RULES) });
                return;
            }
            // Editing keeps the rule's On/Off state (a switched-off rule stays off).
            const candidate = { id: still?.id || look.newRuleId(new Set(current.map((r) => r.id))), enabled: still ? still.enabled : true,
                when, layout: layoutSelect.value, density: densitySelect.value, colourPreset: still?.colourPreset || null, slots: still?.slots || null, shapes: still?.shapes || null };
            if (look.normalizeRules([candidate]).length !== 1) {
                error.textContent = JE.t('tag_looks_error_value');
                return;
            }
            error.textContent = '';
            const next = still ? current.map((r) => (r.id === still.id ? candidate : r)) : current.concat([candidate]);
            saveRules(next, 'tag_looks_saved_toast');
            onSaved(candidate.id, !still);
        });
        return { form, syncCapacity };
    }

    /** @type {{show: () => void}|null} The open panel's section, for the hub's tab switch. */
    let active = null;

    /**
     * Wire the section into the open settings panel (the template renders
     * an empty #jeTagLooksMount). Libraries and genres load in the
     * background; the lists render first and again once they arrive.
     * @param {{resetAutoCloseTimer?: () => void, onClose?: (fn: () => void) => void}} ctx Shared panel context.
     */
    internal.wireTagLooks = function (ctx) {
        unwatchLayout?.();
        const mount = document.getElementById('jeTagLooksMount');
        if (!mount || !JE.core?.tagLook || !JE.core?.tagLayout) return;
        JE.core.ui?.injectCss?.('je-tag-looks-panel', PANEL_CSS);
        /** @type {LooksState} */
        const state = { libraries: null, genres: null, titles: new Map(), lockedOpen: false, shown: false, editing: '' };
        const touch = () => { try { ctx?.resetAutoCloseTimer?.(); } catch { /* panel closing */ } };
        const look = JE.core.tagLook;
        /** @type {(() => void)|null} The open form's rule-limit check. */
        let syncFormCapacity = null;

        /** Save the rules (shown at once, put back on failure) and redraw the lists. */
        const saveRules = (next, doneKey) => {
            touch();
            view.settle(look.saveRules(next), doneKey);
            renderLists();
        };
        const renderOtherwise = () => {
            view.otherwiseOutcome.textContent = `→ ${outcomeText(JE.core.tagLayout.normalizeSettings())}`;
        };
        const renderLists = () => {
            if (!mount.isConnected) return;
            const rules = look.read().rules;
            renderRules(view, state, rules, touch, saveRules, openForm);
            renderLocks(view, state, touch, renderLists);
            renderOtherwise();
            // Every change to the rules goes through here: Add rule follows the count.
            syncFormCapacity?.();
        };
        /** (Re)build the form for state.editing; focus its first field when asked. */
        const openForm = (focus = true) => {
            const rules = look.read().rules;
            if (state.editing && !rules.some((r) => r.id === state.editing)) state.editing = '';
            const { form, syncCapacity } = buildForm(state, rules, touch, saveRules, (savedId, added) => {
                state.editing = '';
                openForm(false);
                const row = view.rows.get(savedId);
                focusOn(row?.edit);
                const index = look.read().rules.findIndex((r) => r.id === savedId);
                const rule = look.read().rules[index];
                if (rule) view.announce(JE.t(added ? 'tag_looks_rule_added' : 'tag_looks_rule_saved', { n: String(index + 1), rule: conditionText(rule.when, state) }));
            }, () => {
                const was = state.editing;
                state.editing = '';
                openForm(false);
                focusOn(view.rows.get(was)?.edit);
            });
            view.side.replaceChildren(form);
            syncFormCapacity = syncCapacity;
            formObserver?.disconnect();
            formObserver?.observe(form);
            if (scroller) formObserver?.observe(scroller);
            scheduleActions();
            if (focus) focusOn(form.querySelector('[data-je-cond-field]'));
        };

        const view = buildView(mount, state, touch, renderLists);
        const scroller = mount.closest('.je-panel-main');
        let frame = 0;
        /** Keep actions in flow until the whole form fits inside its scroller. */
        const syncActions = () => {
            frame = 0;
            const form = view.side.querySelector('form');
            if (!form || !scroller) return;
            const rect = form.getBoundingClientRect();
            const viewport = scroller.getBoundingClientRect();
            form.classList.toggle('je-form-visible', rect.height > 0 && rect.top >= Math.max(0, viewport.top)
                && rect.bottom <= Math.min(window.innerHeight, viewport.bottom));
        };
        /** Batch layout reads after scrolling, resizing or rebuilding the form. */
        const scheduleActions = () => { if (!frame) frame = requestAnimationFrame(syncActions); };
        const formObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleActions) : null;

        renderLists();
        openForm(false);
        const phone = window.matchMedia?.('(max-width: 760px)');
        /** Put the editable form first on phones, regardless of saved-rule count. */
        const orderPhoneForm = () => {
            const cols = view.side.parentElement;
            const focused = document.activeElement;
            if (phone?.matches) cols.prepend(view.side);
            else cols.append(view.side);
            if (focused instanceof HTMLElement && focused.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
            scheduleActions();
        };
        orderPhoneForm();
        phone?.addEventListener('change', orderPhoneForm);
        scroller?.addEventListener('scroll', scheduleActions, { passive: true });
        window.addEventListener('resize', scheduleActions);
        Promise.all([loadLibraries(state), loadGenres(state)]).then(() => {
            if (!mount.isConnected) return;
            renderLists();
            // Rebuild the form for the lists unless the user started on it.
            if (!view.side.contains(document.activeElement)) openForm(false);
        });
        active = {
            /** The tab is on screen: load the locked items' titles. */
            show() {
                if (state.shown || !mount.isConnected) return;
                state.shown = true;
                renderLists();
            },
        };
        // Reinitialization also covers Reset and programmatic changes (the
        // item editor keeping or releasing a look). Update the Otherwise
        // outcome and the locked items (focus kept by key), never the form,
        // so it keeps its input and focus.
        const refreshDefault = () => {
            if (!mount.isConnected) return;
            renderOtherwise();
            renderLocks(view, state, touch, renderLists);
        };
        document.addEventListener('je:tag-layout-changed', refreshDefault);
        const stopWatching = () => {
            document.removeEventListener('je:tag-layout-changed', refreshDefault);
            phone?.removeEventListener('change', orderPhoneForm);
            scroller?.removeEventListener('scroll', scheduleActions);
            window.removeEventListener('resize', scheduleActions);
            formObserver?.disconnect();
            if (frame) cancelAnimationFrame(frame);
            if (unwatchLayout === stopWatching) unwatchLayout = null;
            active = null;
        };
        unwatchLayout = stopWatching;
        ctx?.onClose?.(stopWatching);
    };

    // The hub tells the open section when its tab shows; tests use the rest.
    internal.tagLooksPanel = { show: () => active?.show(), conditionText, loadTitles };
})(window.JellyfinEnhanced);
