import { apiClient, settingsUi, type TagRuntimeBridge } from '../host';
import { isRecord, own as tableEntry, record, type JsonRecord } from '../pipeline/dto';
import { normalizeLayout, type Layout } from '../layout/layout-rules';
import type { LayoutLock } from '../layout/tag-look';
import CSS from './tag-item-editor.css';

interface GroupMeta { setting: string; nameKey: string; capAll?: boolean; capFixed?: boolean }
/** The look being edited. */
interface Draft {
    layout: Layout;
    density: string;
    /** layout → group → slot (each layout remembered while switching). */
    slots: Record<string, Record<string, string>>;
    /** Only the groups given their own "Show up to". */
    caps: Record<string, number>;
    tagScale: string | null;
    tagGap: string | null;
    edge: string | null;
}
export interface ItemEditorOptions {
    /** Focus returns here on close. */
    opener?: HTMLElement | null;
    /** Replacement row or list heading after a scope move. */
    returnFocus?: () => HTMLElement | null;
    /** Where the dialog goes (default the page; the settings panel, which keeps everything outside it inert, passes itself). */
    host?: HTMLElement;
    /** The item, when the caller has it already. */
    item?: JsonRecord;
    /** 'server': edit the item's server-wide look only (the admin page), saved through onSave. */
    mode?: 'user' | 'server';
    /** Server mode: the look to start from. */
    look?: unknown;
    /** Server mode: keep the look. */
    onSave?: (look: JsonRecord, target: string) => void;
}
/** Markup this module wrote a moment ago; a missing node is a defect here, not bad data. */
function must<T extends Element>(value: T | null): T {
    if (!value) throw new Error('Item editor markup is incomplete');
    return value;
}
// /js/tags/tag-item-editor.js
//
// The per-item Media Tags editor: a dialog (opened from the item's ⋮ menu by
// tags/tag-item-menu.js, from Edit on the hub's locked items and, in its
// server mode, from the Media Tags admin tab) that shows the item's poster
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
export function createItemEditor(JE: TagRuntimeBridge) {

    const logPrefix = '🪼 Jellyfin Enhanced [TagLook]:';
    const TYPES = new Set(['Movie', 'Series', 'Season', 'Episode', 'BoxSet', 'Video']);
    const LAYOUTS: Layout[] = ['corners', 'bands', 'caption', 'summary', 'minimal'];
    const SCALES = ['smaller', 'default', 'larger', 'largest'];
    const GAPS = ['tight', 'default', 'roomy'];
    const EDGES = ['default', 'tight', 'flush'];
    const MAX_CAP = 10;
    const UNDO_MS = 8000;

    /**
     * Per group: its enable setting, name string, and cap rule (the hub's:
     * `capAll` groups may show every tag, `capFixed` groups always show one).
     */
    const GROUPS: Readonly<Record<string, GroupMeta>> = {
        status: { setting: 'statusTagsEnabled', nameKey: 'panel_settings_ui_tag_group_status', capFixed: true },
        quality: { setting: 'qualityTagsEnabled', nameKey: 'panel_settings_ui_tag_group_quality', capAll: true },
        rating: { setting: 'ratingTagsEnabled', nameKey: 'panel_settings_ui_tag_group_rating', capAll: true },
        ageRating: { setting: 'ageRatingTagsEnabled', nameKey: 'panel_settings_ui_tag_group_age_rating', capFixed: true },
        language: { setting: 'languageTagsEnabled', nameKey: 'panel_settings_ui_tag_group_language' },
        genre: { setting: 'genreTagsEnabled', nameKey: 'common_genre' },
        awards: { setting: 'awardsTagsEnabled', nameKey: 'awards_label', capAll: true },
        logos: { setting: 'logoTagsEnabled', nameKey: 'common_logos', capAll: true },
        custom: { setting: 'customTagsEnabled', nameKey: 'common_custom' },
    };

    /** Corners anchors in reading order (the 3 × 3 grid). */
    const ANCHORS = ['tl', 'tc', 'tr', 'ml', 'c', 'mr', 'bl', 'bc', 'br'];

    /** the open editor */
    let current: { close: () => void; backdrop: HTMLElement } | null = null;
    let sequence = 0;
    /** Identity of the latest open attempt; another open, close(), navigation or a session reset moves it on. */
    let openGeneration = 0;
    /** generation of the open still waiting for its item data (0: none) */
    let pendingOpen: number = 0;

    /** Cancel the open still waiting for its item data, if any. */
    function cancelPending() {
        openGeneration++;
        settlePending(pendingOpen);
    }

    /**
     * An open attempt settled (mounted, failed or cancelled): stop watching
     * navigation for it.
     */
    function settlePending(generation: number) {
        if (!pendingOpen || pendingOpen !== generation) return;
        pendingOpen = 0;
        window.removeEventListener('hashchange', cancelPending);
    }

    const esc = (value: unknown) => JE.escapeHtml(String(value ?? ''));
    const tx = (key: string, params?: Readonly<Record<string, unknown>>) => esc(JE.t(key, params));
    const layoutApi = () => JE.core?.tagLayout || null;
    const lookApi = () => JE.core?.tagLook || null;
    /** The layout vocabulary's translation key for one option. */
    const vocabularyKey = (section: 'type' | 'layout' | 'gap' | 'edge' | 'slot', id: string): string => layoutApi()?.VOCABULARY_KEYS[section][id] ?? '';

    /**
     * Label of a slot in a layout ("Bottom row"), or "Hidden" for off.
     * */
    function slotLabel(layout: string, slot: string): string {
        return slot === 'off' ? JE.t('panel_settings_ui_tag_slot_off') : JE.t(vocabularyKey('slot', `${layout}_${slot}`));
    }

    /**
     * The positions a group can take in a layout (no "off": the switch hides it).
     * */
    function positionsFor(layout: string, group: string): string[] {
        return (tableEntry<readonly string[]>(layoutApi()?.LAYOUT_SLOTS ?? {}, layout) || []).filter((slot) => slot !== 'off' && (slot !== 'dots' || group === 'quality'));
    }

    /**
     * The next "Show up to" value for a stepper press, or null when the
     * group cannot go further (the hub's policy: 1..10, then All for groups
     * that may show every tag).
     * @param cap - 0 = all.
     * */
    function stepCap(cap: number, dir: number, meta: {capAll?: boolean, capFixed?: boolean}): number|null {
        if (meta.capFixed) return null;
        if (dir < 0) {
            if (cap === 0) return MAX_CAP;
            return cap > 1 ? cap - 1 : null;
        }
        if (cap === 0) return null;
        if (cap < MAX_CAP) return cap + 1;
        return meta.capAll ? 0 : null;
    }

    /** @returns The signed-in user sees some poster tag group. */
    function anyTagsOn(): boolean {
        const s = JE.currentSettings;
        return Object.values(GROUPS).some((g) => s?.[g.setting] === true);
    }

    /**
     * Whether a group can draw for this user (its switch, and Awards also the
     * administrator's).
     * */
    function groupOn(group: string): boolean {
        if (group === 'awards' && JE.pluginConfig?.AwardsTagsEnabled === false) return false;
        const meta = tableEntry(GROUPS, group);
        return !!meta && JE.currentSettings?.[meta.setting] === true;
    }

    /**
     * The draft as a lock document for the chosen layout.
     * */
    function lookOf(draft: Draft, scope: 'item' | null) {
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
     * @param inherited - The lock or item look is its series'.
     * */
    function sourceText(source: {source: string, index: number}, inherited: boolean): string {
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
     * @param [host] - Where it goes (the settings panel keeps the page behind inert).
     */
    function showUndo(message: string, undo: () => void, host?: HTMLElement) {
        const isCurrent = lookApi()?.captureSession() ?? (() => false);
        document.querySelectorAll('.je-tie-toast').forEach((el) => el.remove());
        const toast = document.createElement('div');
        toast.className = 'je-tie-toast';
        toast.setAttribute('role', 'status');
        const text = document.createElement('span');
        text.textContent = message;
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = JE.t('hidden_content_undo');
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
     * @param target - The sample's render target.
     * @param entry - The server tag-cache entry, or null.
     * @param [item] - The item's /tag-data answer, drawn when there is no entry or card
     *   (the admin page shows no cards of the item).
     * @returns Whether any group was drawn.
     */
    function drawTags(target: HTMLElement, id: string, entry: JsonRecord | null, item: JsonRecord | null = null): boolean {
        const L = layoutApi();
        if (!L) return false;
        const pipeline = JE.tagPipeline;
        L.ensureHost(target);
        if (entry) L.setCardContext(target, entry, id);
        // A card of the item on the page carries exactly the tags the user sees.
        for (const host of document.querySelectorAll<HTMLElement>('.je-tag-host')) {
            if (target.contains(host) || L.cardIdentity(host) !== id) continue;
            let copied = 0;
            for (const group of L.GROUPS) {
                const master = L.getGroup(host, group);
                const copy = master?.cloneNode(true);
                if (copy instanceof HTMLElement) { L.commitGroup(target, group, copy); copied++; }
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
                else if (item && renderer.render) renderer.render(target, item, { renderTarget: target, stripRevision: pipeline.tagStripRevision?.() ?? null });
                else if (renderer.renderFromCache) renderer.renderFromCache(target, id);
            } catch (err) {
                console.warn(`${logPrefix} the item editor's sample could not draw ${name}:`, err);
            }
        }
        return [...L.GROUPS].some((group) => L.hasGroup(target, group));
    }

    /**
     * The item, read once for the editor: its name, type, series and image.
     * */
    async function fetchItem(id: string): Promise<JsonRecord | null> {
        try {
            const item = await apiClient().getItem(apiClient().getCurrentUserId(), id);
            return isRecord(item) ? item : null;
        } catch (err) {
            console.warn(`${logPrefix} could not read item ${id}:`, err);
            return null;
        }
    }

    /** @returns The signed-in user is an administrator. */
    async function isAdministrator(): Promise<boolean> {
        try {
            const user = await apiClient().getCurrentUser();
            return record(record(user).Policy).IsAdministrator === true;
        } catch {
            return false;
        }
    }

    /**
     * Open the editor for an item. A second open replaces the first.
     * @returns False when the item cannot be edited.
     */
    async function open(itemId: unknown, options: ItemEditorOptions = {}): Promise<boolean> {
        const L = layoutApi();
        const look = lookApi();
        const id = look?.normalizeId(String(itemId || ''));
        if (!L || !look || !id) return false;
        const serverMode = options.mode === 'server';
        const active = document.activeElement;
        const opener = options.opener || (active instanceof HTMLElement ? active : null);
        const isCurrent = look.captureSession();
        // This attempt replaces any still waiting; it ends with another open,
        // close(), a navigation or a session reset before it mounts.
        cancelPending();
        const generation = openGeneration;
        pendingOpen = generation;
        window.addEventListener('hashchange', cancelPending);
        const live = () => isCurrent() && generation === openGeneration;
        const abandon = () => { settlePending(generation); return false; };

        let item: JsonRecord | null;
        let admin: boolean;
        try {
            [item, admin] = await Promise.all([options.item ? Promise.resolve(options.item) : fetchItem(id), serverMode ? Promise.resolve(true) : isAdministrator()]);
        } catch (err) {
            abandon();
            throw err;
        }
        if (!live()) return abandon();
        if (!item || typeof item.Type !== 'string' || !TYPES.has(item.Type)) {
            JE.toast?.(JE.t('tag_item_editor_unsupported'));
            return abandon();
        }
        closeMounted();
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
        let facts: JsonRecord | null = serverEntry;
        // The server-wide editor opens from the admin page, where no card of the item
        // was drawn: its /tag-data answer is what the preview draws.
        if (!facts) {
            try { facts = await JE.tagPipeline?.itemLookFacts?.(id) ?? null; } catch { facts = null; }
            if (!live()) return abandon();
            // An editor another open mounted meanwhile is replaced.
            closeMounted();
        }
        settlePending(generation);
        const itemCard = opener?.closest?.<HTMLElement>('.card') || document.querySelector<HTMLElement>(`.card[data-id="${id}"]`);
        const shape = itemCard ? L.shapeOf(itemCard) : (type === 'Episode' ? 'landscape' : 'portrait');
        const context = { ...(facts || {}), Id: id, Type: type, SeriesId: seriesId || facts?.SeriesId, itemId: id, cardType: type, shape };
        const before = L.lookSource(context);
        const base = L.normalizeSettings();
        const conf = L.resolveLayout(context);

        // Start from the look the item keeps (its own, else its series'), else
        // the look its cards have now.
        const usable = (lock: LayoutLock | null) => lock && (lock !== seriesLock || lock.scope !== 'item');
        const baseCap = (group: string): number => tableEntry(base.caps, group) ?? 0;
        const startLock: LayoutLock | null = serverMode ? (options.look ? look.normalizeLock(options.look) : null)
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
        const singleChip = (name: string): boolean => {
            const group = L.normalizeGroup(name);
            return !!group && L.singleChipGroup(group);
        };
        const draft: Draft = {
            layout: startLayout,
            density: effective.density,
            slots: {},
            caps: {
                ...Object.fromEntries(Object.entries(effective.caps).filter(([group, cap]) => cap !== baseCap(group))),
                // Presentation caps do not rewrite a saved single-chip cap when another field is edited.
                ...Object.fromEntries(Object.entries({ ...(startLock?.caps || {}), ...((shape === 'landscape' || shape === 'list' ? startLock?.shapes?.[shape]?.caps : null) || {}) })
                    .filter(([group]) => singleChip(group))),
            },
            tagScale: effective.tagScale === base.tagScale ? null : effective.tagScale,
            tagGap: effective.tagGap === base.tagGap ? null : effective.tagGap,
            edge: effective.edge === base.edge ? null : effective.edge,
        };
        for (const layout of LAYOUTS) draft.slots[layout] = { ...base.profiles[layout] };
        /** the group row whose position and limit are open (one at a time) */
        let openGroup: string | null = null;
        /** Whether the list of groups the user's settings hide is open. */
        let hiddenOpen = false;
        /** "layout:group" → the position a group had before it was switched off */
        const lastSlot: Record<string, string> = {};
        draft.slots[startLayout] = { ...effective.slots };
        let scope: 'item'|'series' = !hasSeries ? 'item'
            : own ? (type === 'Series' && own.scope !== 'item' ? 'series' : 'item')
            : (usable(seriesLock) ? 'series' : (type === 'Series' ? 'series' : 'item'));
        if (serverMode && type === 'Series' && startLock) scope = startLock.scope === 'item' ? 'item' : 'series';
        const keptAt = (target: string | null) => (target ? read.locks.get(target) || null : null);
        const overrideAt = (target: string | null) => (target ? read.overrides.get(target) || null : null);
        const targetOf = (): string => (scope === 'series' && seriesTarget ? seriesTarget : id);
        const scopeField = (): 'item' | null => (type === 'Series' && scope === 'item' ? 'item' : null);
        let keep = !!keptAt(targetOf());
        let everyone = !!overrideAt(targetOf());

        // ── Markup ──
        const uid = `jeTie${++sequence}`;
        const backdrop = document.createElement('div');
        backdrop.className = 'je-tie-backdrop';
        // Opened from the admin page on a light dashboard: the dialog follows it (admin-tags.css).
        if (opener?.closest?.('.je-ta-light')) backdrop.classList.add('je-tie-light');
        const typeName = JE.t(vocabularyKey('type', type.toLowerCase()));
        const titleKey = serverMode ? 'tag_item_editor_title_server' : 'tag_item_editor_title';
        backdrop.innerHTML = `<div class="je-tie" role="dialog" aria-modal="true" aria-labelledby="${uid}Title" tabindex="-1">
            <div class="je-tie-head"><h3 class="je-tie-title" id="${uid}Title"><span data-tie-title></span>${serverMode ? `<span class="je-tie-chip">${tx('common_admin')}</span>` : ''}</h3>
                <button type="button" class="je-tie-jump" data-tie-jump hidden aria-label="${tx('tag_item_editor_show_preview')}"><span class="je-tie-jump-thumb" aria-hidden="true"></span>${tx('common_preview')}</button>
                <button type="button" class="je-tie-close" data-tie-close aria-label="${tx('awards_close')}"><span class="material-icons" aria-hidden="true">close</span></button></div>
            <div class="je-tie-body">
                <div class="je-tie-side">
                    <div class="je-tie-card" data-je-shape="${esc(shape)}" data-id="${esc(id)}" data-type="${esc(type)}" tabindex="0" aria-label="${tx('panel_media_tags_preview')}: ${esc(name || typeName)}"><div class="cardBox"><div class="je-tie-scalable cardScalable"></div><div class="cardText je-tie-card-title">${esc(name)}</div></div></div>
                    <div><div class="je-tie-view je-tie-pills" role="group" aria-label="${tx('panel_media_tags_preview_view')}">
                        <button type="button" class="je-tie-pill" data-view="rest" aria-pressed="true">${tx('panel_settings_ui_tag_editor_preview_resting')}</button>
                        <button type="button" class="je-tie-pill" data-view="hover" aria-pressed="false">${tx('panel_settings_ui_tag_editor_preview_hover')}</button></div>
                        <p class="je-tie-note" data-tie-hover-note hidden>${tx('panel_media_tags_preview_hover_hidden')}</p>
                        <p class="je-tie-source" data-tie-source></p><p class="je-tie-note" data-tie-note hidden></p></div>
                </div>
                <div class="je-tie-main">
                    ${serverMode ? `<p class="je-tie-box je-tie-keep je-tie-hint" data-everyone>${tx('tag_item_editor_server_hint')}</p>` : `<div class="je-tie-keeps"><div class="je-tie-box je-tie-keep">
                        <label class="je-tie-switch"><input type="checkbox" data-tie-keep aria-describedby="${uid}KeepHint">${tx('tag_item_editor_keep')}</label>
                        <p class="je-tie-hint" id="${uid}KeepHint">${tx('tag_item_editor_keep_hint')}</p></div>
                    ${admin ? `<div class="je-tie-box je-tie-keep" data-everyone>
                        <label class="je-tie-switch"><input type="checkbox" data-tie-everyone aria-describedby="${uid}EveryoneHint">${tx('tag_item_editor_everyone')}<span class="je-tie-chip">${tx('common_admin')}</span></label>
                        <p class="je-tie-hint" id="${uid}EveryoneHint">${tx('tag_item_editor_everyone_hint')}</p></div>` : ''}</div>`}
                    ${hasSeries ? `<fieldset class="je-tie-box"><legend>${tx('tag_item_editor_scope')}</legend><div class="je-tie-scope" role="radiogroup">
                        <label class="je-tie-pill"><input type="radio" name="${uid}Scope" value="item">${tx(type === 'Series' ? 'tag_item_editor_scope_series_only' : 'tag_item_editor_scope_item', { type: typeName })}</label>
                        <label class="je-tie-pill"><input type="radio" name="${uid}Scope" value="series">${tx('tag_item_editor_scope_series')}</label></div></fieldset>` : ''}
                    <fieldset class="je-tie-box" aria-describedby="${uid}LayoutDesc"><legend>${tx('common_layout')}</legend><div class="je-tie-tiles">
                        ${LAYOUTS.map((l) => `<label class="je-tie-tile"><input type="radio" name="${uid}Layout" value="${l}"><span class="je-tie-art" data-layout="${l}" aria-hidden="true"><i></i><i></i><i></i><i></i></span>${tx(vocabularyKey('layout', l))}</label>`).join('')}</div><p class="je-tie-hint je-tie-under" id="${uid}LayoutDesc" aria-live="polite"></p></fieldset>
                    <fieldset class="je-tie-box" aria-describedby="${uid}DensityDesc"><legend>${tx('panel_settings_ui_tag_density')}</legend><div class="je-tie-pills">
                        ${['full', 'compact'].map((d) => `<label class="je-tie-pill"><input type="radio" name="${uid}Density" value="${d}">${tx(`panel_settings_ui_tag_density_${d}`)}</label>`).join('')}</div><p class="je-tie-hint je-tie-under" id="${uid}DensityDesc">${tx('panel_settings_ui_tag_density_desc')}</p></fieldset>
                    <section class="je-tie-box" aria-labelledby="${uid}Groups" aria-describedby="${uid}GroupsHint"><h4 class="je-tie-h" id="${uid}Groups">${tx('tag_item_editor_groups_title')}</h4><p class="je-tie-hint je-tie-groups-hint" id="${uid}GroupsHint">${tx(serverMode ? 'tag_item_editor_groups_hint_server' : 'tag_item_editor_groups_hint')}</p><div data-tie-groups></div></section>
                    <fieldset class="je-tie-box"><legend>${tx('tag_item_editor_spacing')}</legend><div class="je-tie-row3">
                        <label>${tx('tag_scale_label')}<select data-tie-select="tagScale"></select></label>
                        <label>${tx('tag_gap_label')}<select data-tie-select="tagGap"></select></label>
                        <label>${tx('panel_settings_ui_tag_edge')}<select data-tie-select="edge"></select></label></div></fieldset>
                </div>
            </div>
            <div class="je-tie-foot"><p class="je-tie-status" data-tie-status role="status" aria-live="polite"></p>
                <button type="button" data-tie-close>${tx('jellyseerr_modal_cancel')}</button>
                <button type="button" class="je-tie-save" data-tie-save>${tx('elsewhere_settings_save')}</button></div>
        </div>`;
        // Item names and translated substitutions are text, including hostile markup.
        must(backdrop.querySelector('[data-tie-title]')).textContent = JE.t(titleKey, { name: name || typeName });
        const host = options.host && options.host.isConnected ? options.host : document.body;
        host.appendChild(backdrop);
        const dialog = must(backdrop.querySelector<HTMLElement>('.je-tie'));
        const target = must(dialog.querySelector<HTMLElement>('.je-tie-scalable'));
        const groupsList = must(dialog.querySelector<HTMLElement>('[data-tie-groups]'));
        const sourceEl = must(dialog.querySelector<HTMLElement>('[data-tie-source]'));
        const noteEl = must(dialog.querySelector<HTMLElement>('[data-tie-note]'));
        const statusEl = must(dialog.querySelector<HTMLElement>('[data-tie-status]'));
        const saveButton = must(dialog.querySelector<HTMLButtonElement>('[data-tie-save]'));
        const keepBox = dialog.querySelector<HTMLInputElement>('[data-tie-keep]');
        const everyoneBox = dialog.querySelector<HTMLInputElement>('[data-tie-everyone]');

        const previewSide = must(dialog.querySelector<HTMLElement>('.je-tie-side'));
        const hoverNote = must(dialog.querySelector<HTMLElement>('[data-tie-hover-note]'));
        const interaction = settingsUi(JE)?.bindTagPreviewInteraction([dialog.querySelector('.je-tie-card')], dialog.querySelector('.je-tie-view'), {
            change: active => {
                const hidden = !!JE.currentSettings?.tagsHideOnHover;
                previewSide.dataset.jeHideOnHover = String(hidden);
                hoverNote.hidden = !(active && hidden);
            },
        });

        // The poster (the episode's still) under the tags.
        const primaryTag = record(item.ImageTags).Primary;
        const image = primaryTag ? apiClient().getScaledImageUrl(id, { type: 'Primary', maxHeight: 480, tag: String(primaryTag) }) : '';
        if (image) target.style.backgroundImage = `url("${image}")`;
        // Phone: once the preview scrolls away, the sticky title row offers a way back to it.
        const jump = must(dialog.querySelector<HTMLButtonElement>('[data-tie-jump]'));
        if (image) must(jump.querySelector<HTMLElement>('.je-tie-jump-thumb')).style.backgroundImage = `url("${image}")`;
        jump.addEventListener('click', () => {
            dialog.querySelector('.je-tie-side')?.scrollIntoView?.({ block: 'start' });
            dialog.querySelector<HTMLElement>('.je-tie-card')?.focus({ preventScroll: true });
        });
        const sideWatch = typeof IntersectionObserver === 'function'
            ? new IntersectionObserver(([entry]) => { jump.hidden = !!entry?.isIntersecting; }, { root: backdrop, threshold: 0 })
            : null;
        const side = dialog.querySelector('.je-tie-side');
        if (sideWatch && side) sideWatch.observe(side);
        const drawn = drawTags(target, id, serverEntry, serverEntry ? null : facts);
        noteEl.hidden = drawn;
        noteEl.textContent = drawn ? '' : JE.t('tag_item_editor_no_tags');
        // Nothing to show at rest or on hover: the switch would only look useful.
        if (!drawn) dialog.querySelectorAll<HTMLButtonElement>('.je-tie-view button').forEach((b) => { b.disabled = true; });
        let presentTimer: ReturnType<typeof setTimeout> | null = null;
        let dirty = false;
        /** Show the draft on the sample and say what will happen on Save. */
        const present = () => {
            L.setPreviewLook(target, { ...lookOf(draft, scopeField()), locked: keep });
            // A lock or item look the item does not hold itself is its series'.
            const inherited = (before.source === 'lock' && !own) || (before.source === 'override' && !ownOverride);
            // Without the item's data a rule or series look could not be matched: say so rather than guess.
            const unknown = !facts && (read.rules.length > 0 || !!seriesId);
            if (serverMode) sourceEl.replaceChildren(document.createTextNode(`${JE.t('tag_item_editor_editing')} `), Object.assign(document.createElement('strong'), { textContent: JE.t('tag_item_editor_editing_server') }));
            else sourceEl.replaceChildren(document.createTextNode(`${JE.t('tag_item_editor_now')} `), Object.assign(document.createElement('strong'), { textContent: unknown ? JE.t('tag_item_editor_source_unknown') : sourceText(before, !!inherited) }));
            if (dirty) sourceEl.append(document.createElement('br'), document.createTextNode(JE.t('tag_item_editor_draft')));
            showStatus();
        };
        /** a failed save's message, shown until the next change */
        let saveError: string = '';
        /** The footer line: a failed save, else what Save will do with an edit nothing keeps yet. */
        const showStatus = () => {
            statusEl.textContent = saveError || (saveLabelKey() === 'tag_item_editor_lock_save' ? JE.t('tag_item_editor_lock_save_hint') : '');
            saveButton.textContent = JE.t(saveLabelKey());
        };
        /** @returns Save's label: where the look goes, a removal, or that nothing is kept. */
        const saveLabelKey = (): string => {
            if (serverMode) return 'tag_item_editor_save_server';
            if (keep && everyone) return 'tag_item_editor_save_both';
            if (keep) return 'tag_item_editor_save_mine';
            if (everyone) return 'tag_item_editor_save_everyone';
            const target = targetOf();
            const removes = !!keptAt(target) || (target !== id && !!own) || (!!everyoneBox && !!overrideAt(target));
            if (removes) return 'elsewhere_settings_save';
            // An edit with nowhere to go yet: Save locks it for this user (the button says so).
            return dirty ? 'tag_item_editor_lock_save' : 'tag_item_editor_done';
        };
        /** Coalesce bursts of changes (a stepper held down) into one re-present. */
        const schedule = () => {
            if (presentTimer) return;
            presentTimer = setTimeout(() => { presentTimer = null; if (backdrop.isConnected) present(); }, 0);
        };

        /**
         * Rebuild the group rows for the draft's layout (focus kept by key). A
         * keyed control drawn disabled (a stepper at the end of its range) hands
         * focus to its row's other step button or switch, so it never leaves the editor.
         */
        const layoutSlots = (): Record<string, string> => (draft.slots[draft.layout] ??= {});
        /** Mark each chosen option's label, for browsers whose CSS cannot select it by its checked radio. */
        const markChecked = () => dialog.querySelectorAll<HTMLElement>('label.je-tie-pill, label.je-tie-tile, label.je-tie-anchor')
            .forEach((label) => label.classList.toggle('je-tie-checked', !!label.querySelector('input:checked')));
        const renderGroups = () => {
            const focused = document.activeElement;
            const focusKey = focused instanceof HTMLElement ? focused.dataset.tieKey || null : null;
            const focusGroup = focusKey ? focused?.closest<HTMLElement>('[data-group]')?.dataset.group || null : null;
            const slots = layoutSlots();
            // The groups that draw for this user first, the ones switched off in their settings after.
            const ordered = base.order || L.DEFAULT_ORDER;
            const order = [...ordered.filter((g) => groupOn(g)), ...ordered.filter((g) => !groupOn(g))];
            // Personal editor: groups the user's settings hide go in their own closed list.
            const tucked = (group: string) => !serverMode && !groupOn(group);
            const rowHtml = (group: string) => {
                const meta = tableEntry(GROUPS, group);
                if (!meta) return '';
                const slot = slots[group] || 'off';
                const on = slot !== 'off';
                const gname = JE.t(meta.nameKey);
                const positions = positionsFor(draft.layout, group);
                const current = on ? slot : (lastSlot[`${draft.layout}:${group}`] || positions[0] || '');
                // An off group's controls are shown dimmed and are not operable (the keyboard skips them too).
                const off = on ? '' : 'disabled';
                const where = draft.layout === 'corners'
                    ? `<div class="je-tie-anchors" role="radiogroup" aria-label="${tx('tag_item_editor_position', { group: gname })}">${ANCHORS.map((a) => `<label class="je-tie-anchor"><input type="radio" name="${uid}-${group}" value="${a}" data-tie-key="${group}-${a}" ${a === current ? 'checked' : ''} ${off}>${esc(slotLabel('corners', a))}</label>`).join('')}</div>`
                    : `<div class="je-tie-pills" role="radiogroup" aria-label="${tx('tag_item_editor_position', { group: gname })}">${positions.map((p) => `<label class="je-tie-pill"><input type="radio" name="${uid}-${group}" value="${p}" data-tie-key="${group}-${p}" ${p === current ? 'checked' : ''} ${off}>${esc(slotLabel(draft.layout, p))}</label>`).join('')}</div>`;
                const fixed = singleChip(group);
                const cap = fixed ? 1 : (draft.caps[group] ?? baseCap(group));
                const capText = cap === 0 ? JE.t('panel_settings_ui_tag_editor_cap_all') : String(cap);
                const stepper = fixed ? `<p class="je-tie-hint" data-je-limit-na="${group}">${tx('tag_limit_single')}</p>` : `<div class="je-tie-cap" role="group" aria-label="${tx('tag_item_editor_cap_named', { group: gname })}">
                    <span>${tx('panel_settings_ui_tag_editor_show_up_to')}</span>
                    <button type="button" data-tie-step="-1" data-tie-key="${group}-down" aria-label="${tx('tag_item_editor_cap_fewer', { group: gname })}" ${!on || stepCap(cap, -1, meta) === null ? 'disabled' : ''}>−</button>
                    <output aria-live="polite">${esc(capText)}</output>
                    <button type="button" data-tie-step="1" data-tie-key="${group}-up" aria-label="${tx('tag_item_editor_cap_more', { group: gname })}" ${!on || stepCap(cap, 1, meta) === null ? 'disabled' : ''}>+</button></div>`;
                // Collapsed, a row says where the group goes and how many it shows; one row opens at a time.
                const open = openGroup === group;
                const summary = on ? (fixed ? slotLabel(draft.layout, slot)
                    : JE.t(cap === 0 ? 'tag_item_editor_group_summary_all' : 'tag_item_editor_group_summary', { where: slotLabel(draft.layout, slot), cap: capText }))
                    : JE.t('panel_settings_ui_tag_slot_off');
                // The server-wide look's rows describe the draft; the admin's own switches are not the point there.
                const offNote = tucked(group);
                return `<li class="je-tie-group" data-group="${group}" data-on="${on ? 1 : 0}" data-open="${open ? 1 : 0}">
                    <div class="je-tie-gname"><label class="je-tie-switch"><input type="checkbox" data-tie-on data-tie-key="${group}-on" ${on ? 'checked' : ''} aria-label="${tx('tag_item_editor_include_group', { group: gname })}"${offNote ? ` aria-describedby="${uid}HiddenHint"` : ''}>${esc(gname)}</label></div>
                    <span class="je-tie-gsum">${esc(summary)}</span>
                    <button type="button" class="je-tie-gopen" data-tie-open data-tie-key="${group}-open" aria-expanded="${open}" aria-controls="${uid}-${group}-detail" aria-label="${tx('tag_item_editor_group_edit', { group: gname })}" ${on ? '' : 'disabled'}>${tx('tag_shapes_edit')}<span class="material-icons" aria-hidden="true">expand_more</span></button>
                    <div class="je-tie-detail" id="${uid}-${group}-detail" ${open && on ? '' : 'hidden'}><div class="je-tie-where">${where}</div>${stepper}</div></li>`;
            };
            const shown = order.filter((g) => tableEntry(GROUPS, g) && !tucked(g));
            const hidden = order.filter((g) => tableEntry(GROUPS, g) && tucked(g));
            // "Where to show" is a group-wide choice (item types, home rows): the editor says where it is set.
            const scopeNote = JE.core.tagSettingsMatrix?.offers('itemEditor', 'quality', 'scopes');
            groupsList.innerHTML = `<ul class="je-tie-groups">${shown.map(rowHtml).join('')}</ul>`
                + (typeof scopeNote === 'string' ? `<p class="je-tie-hint" data-je-scope-na="itemEditor">${tx(scopeNote)}</p>` : '')
                + (hidden.length ? `<details class="je-tie-hidden" data-tie-hidden ${hiddenOpen ? 'open' : ''}><summary class="je-tie-hidden-toggle"><span class="material-icons" aria-hidden="true">expand_more</span>${tx('tag_item_editor_hidden_groups', { n: hidden.length })}</summary>`
                    + `<p class="je-tie-hint" id="${uid}HiddenHint">${tx('tag_item_editor_hidden_groups_hint')}</p><ul class="je-tie-groups">${hidden.map(rowHtml).join('')}</ul></details>` : '');
            markChecked();
            if (!focusKey) return;
            const canFocus = (el: HTMLElement | null | undefined): el is HTMLElement => !!el && !el.matches(':disabled') && !el.closest('[hidden]');
            let next = groupsList.querySelector<HTMLElement>(`[data-tie-key="${focusKey}"]`);
            if (!canFocus(next)) {
                const row = focusGroup ? groupsList.querySelector(`[data-group="${focusGroup}"]`) : null;
                // The row's other step button, else its Edit button, else its switch.
                next = ['[data-tie-step]', '[data-tie-open]', '[data-tie-on]'].map((sel) => Array.from(row?.querySelectorAll<HTMLElement>(sel) || []).find(canFocus)).find(Boolean) || null;
            }
            (canFocus(next) ? next : dialog).focus({ preventScroll: true });
        };

        /** The chosen layout in words, under the layout tiles. */
        const describeLayout = () => {
            const desc = dialog.querySelector(`#${uid}LayoutDesc`);
            if (desc) desc.textContent = JE.t(`panel_settings_ui_tag_layout_${draft.layout}`);
        };
        /** Put every control in step with the draft. */
        const sync = () => {
            describeLayout();
            dialog.querySelectorAll<HTMLInputElement>(`input[name="${uid}Layout"]`).forEach((r) => { r.checked = r.value === draft.layout; });
            dialog.querySelectorAll<HTMLInputElement>(`input[name="${uid}Density"]`).forEach((r) => { r.checked = r.value === draft.density; });
            dialog.querySelectorAll<HTMLInputElement>(`input[name="${uid}Scope"]`).forEach((r) => { r.checked = r.value === scope; });
            if (keepBox) keepBox.checked = keep;
            if (everyoneBox) everyoneBox.checked = everyone;
            renderGroups();
        };

        // Size, gap and edge: "Same as default (…)" keeps the user's.
        const selectOptions = {
            tagScale: { values: SCALES, label: (v: string) => L.sizeLabel('scale', v), base: base.tagScale },
            tagGap: { values: GAPS, label: (v: string) => JE.t(vocabularyKey('gap', v)), base: base.tagGap },
            edge: { values: EDGES, label: (v: string) => JE.t(vocabularyKey('edge', v)), base: base.edge },
        };
        for (const key of ['tagScale', 'tagGap', 'edge'] as const) {
            const spec = selectOptions[key];
            const select = must(dialog.querySelector<HTMLSelectElement>(`[data-tie-select="${key}"]`));
            // Inherited: the viewer's own value; for the server-wide look each user keeps theirs.
            select.innerHTML = `<option value="">${serverMode ? tx('tag_item_editor_same_as_user') : tx('tag_item_editor_same_as_default', { value: spec.label(spec.base) })}</option>`
                + spec.values.map((v) => `<option value="${v}">${esc(spec.label(v))}</option>`).join('');
            select.value = draft[key] || '';
            select.addEventListener('change', () => {
                draft[key] = select.value || null;
                dirty = true;
                schedule();
            });
        }

        dialog.addEventListener('change', (e) => {
            const input = e.target;
            if (!(input instanceof HTMLInputElement)) return;
            if (input.type === 'radio') markChecked();
            if (input.name === `${uid}Layout`) {
                draft.layout = normalizeLayout(input.value);
                describeLayout();
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
                const group = input.closest<HTMLElement>('[data-group]')?.dataset.group || '';
                const slots = layoutSlots();
                const key = `${draft.layout}:${group}`;
                const held = slots[group];
                if (input.checked) slots[group] = lastSlot[key] || positionsFor(draft.layout, group)[0] || 'off';
                else { if (held && held !== 'off') lastSlot[key] = held; slots[group] = 'off'; }
                renderGroups();
            } else if (input.type === 'radio' && input.closest('[data-group]')) {
                const group = input.closest<HTMLElement>('[data-group]')?.dataset.group || '';
                layoutSlots()[group] = input.value;
            } else {
                return;
            }
            dirty = dirty || !input.matches('[data-tie-keep], [data-tie-everyone]');
            saveError = '';
            schedule();
        });
        groupsList.addEventListener('toggle', (e) => {
            if (e.target instanceof HTMLDetailsElement && e.target.matches('[data-tie-hidden]')) hiddenOpen = e.target.open;
        }, true);
        groupsList.addEventListener('click', (e) => {
            if (!(e.target instanceof Element)) return;
            const opener = e.target.closest<HTMLButtonElement>('[data-tie-open]');
            if (opener && !opener.disabled) {
                const group = opener.closest<HTMLElement>('[data-group]')?.dataset.group || '';
                openGroup = openGroup === group ? null : group;
                renderGroups();
                return;
            }
            const button = e.target.closest<HTMLButtonElement>('[data-tie-step]');
            if (!button || button.disabled) return;
            const group = button.closest<HTMLElement>('[data-group]')?.dataset.group || '';
            const meta = tableEntry(GROUPS, group);
            if (!meta || singleChip(group)) return;
            const cap = draft.caps[group] ?? baseCap(group);
            const next = stepCap(cap, Number(button.dataset.tieStep), meta);
            if (next === null) return;
            draft.caps[group] = next;
            dirty = true;
            renderGroups();
            schedule();
        });

        // ── Closing, focus, saving ──
        // Tab order: disclosure rows included; nothing inside a closed disclosure, hidden, disabled or taken out of it.
        const focusables = () => Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex="0"]'))
            .filter((el) => !el.closest('[hidden]') && !(el.tagName !== 'SUMMARY' && el.closest('details:not([open])')) && el.tabIndex >= 0 && !(el instanceof HTMLInputElement && el.type === 'radio' && !el.checked && dialog.querySelector(`input[name="${el.name}"]:checked`)));
        const onFocusIn = (e: FocusEvent) => {
            // Jellyfin's closing action sheet hands focus back to its button: keep it here.
            if (backdrop.isConnected && !(e.target instanceof Node && backdrop.contains(e.target))) dialog.focus({ preventScroll: true });
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
            interaction?.dispose();
            sideWatch?.disconnect();
            L.setPreviewLook(target, null);
            L.clearCard(target);
            backdrop.remove();
            if (current?.backdrop === backdrop) current = null;
            // A list redrawn meanwhile (the hub's locked items) has a new button with the opener's focus key.
            const key = opener?.dataset?.jeFocusKey;
            const back = options.returnFocus?.() || (opener?.isConnected ? opener
                : (key ? Array.from(document.querySelectorAll<HTMLElement>('[data-je-focus-key]')).find((el) => el.dataset.jeFocusKey === key) : null));
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
            const focused = document.activeElement;
            const at = focused instanceof HTMLElement ? list.indexOf(focused) : -1;
            if (e.shiftKey && at <= 0) { e.preventDefault(); list[list.length - 1]?.focus(); }
            else if (!e.shiftKey && at === list.length - 1) { e.preventDefault(); list[0]?.focus(); }
        });
        backdrop.addEventListener('click', (e) => {
            if (e.target instanceof Element && e.target.closest('[data-tie-close]')) finish();
        });
        document.addEventListener('focusin', onFocusIn, true);
        window.addEventListener('hashchange', onNavigate);

        /**
         * The scopes a save already wrote for one exact change (the item it targets and the look), so Try again after
         * a save that half-succeeded writes only what is missing; any other change starts again.
         * 
         */
        const saved: { key: string; scopes: Set<string> } = { key: '', scopes: new Set() };
        saveButton.addEventListener('click', async () => {
            if (saveButton.disabled || !isCurrent()) return;
            const targetId = targetOf();
            const chosen = lookOf(draft, scopeField());
            if (serverMode) {
                options.onSave?.(chosen, targetId);
                finish();
                return;
            }
            // "Lock & save for me": the edit is kept as this user's lock.
            if (saveLabelKey() === 'tag_item_editor_lock_save') {
                keep = true;
                if (keepBox) keepBox.checked = true;
            }
            const changeKey = JSON.stringify([targetId, chosen, keep, everyoneBox ? everyone : null]);
            if (saved.key !== changeKey) { saved.key = changeKey; saved.scopes.clear(); }
            saveButton.disabled = true;
            statusEl.textContent = JE.t('hidden_content_admin_loading');
            const label = name || typeName;
            const results: Array<{ scope: string; ok: boolean }> = [];
            /** @param scope @param {boolean} ok */
            const note = (scope: string, ok: boolean) => { results.push({ scope, ok }); if (ok) saved.scopes.add(scope); };
            try {
                // Personal lock: one save for the whole change (the series lock
                // replaces a season's or episode's own lock).
                const removedIds = [targetId, ...(own ? [id] : [])];
                const lockDocument = record(JE.currentSettings?.tagLayoutLocks);
                const locksBefore: JsonRecord = Object.fromEntries(removedIds.filter((key) => lockDocument[key]).map((key) => [key, JSON.parse(JSON.stringify(lockDocument[key]))]));
                const hadLock = !!keptAt(targetId) || (targetId !== id && !!own);
                if (saved.scopes.has('personal')) {
                    // Written by the earlier try of this same change.
                } else if (keep) {
                    const remove = targetId !== id && own ? [id] : [];
                    const ok = await look.editLocks({ [targetId]: chosen }, remove);
                    if (!isCurrent()) return;
                    note('personal', ok);
                    if (ok) JE.toast?.(esc(JE.t('tag_item_editor_kept', { name: label })));
                } else if (hadLock) {
                    const ok = await look.editLocks({}, [targetId, ...(own ? [id] : [])]);
                    if (!isCurrent()) return;
                    note('personal', ok);
                    if (ok) showUndo(JE.t('tag_item_editor_unlocked', { name: label }), () => look.restoreLocks(locksBefore), options.host);
                }
                if (everyoneBox && !saved.scopes.has('everyone')) {
                    const had = overrideAt(targetId);
                    if (everyone) {
                        const ok = await look.saveItemOverride(targetId, chosen, { remove: targetId !== id && ownOverride ? [id] : [] });
                        if (!isCurrent()) return;
                        note('everyone', ok);
                        if (ok) JE.toast?.(esc(JE.t('tag_item_editor_everyone_saved', { name: label })));
                    } else if (had) {
                        const previous = { ...had };
                        const ok = await look.saveItemOverride(targetId, null);
                        if (!isCurrent()) return;
                        note('everyone', ok);
                        if (ok) showUndo(JE.t('tag_item_editor_everyone_removed', { name: label }), () => { look.saveItemOverride(targetId, previous, { restoreOnly: true }); }, options.host);
                    }
                }
            } catch (err) {
                if (!isCurrent()) return;
                console.warn(`${logPrefix} saving the item look failed:`, err);
                results.push({ scope: '', ok: false });
            }
            if (results.some((r) => !r.ok)) {
                saveButton.disabled = false;
                // Half saved: say which part is written (it stays, also if the editor is closed) and which is not;
                // Try again writes only the missing part while the change stays the same.
                const failed = results.find((r) => !r.ok)?.scope;
                saveError = failed === 'everyone' && saved.scopes.has('personal') ? JE.t('tag_item_editor_error_everyone_only')
                    : failed === 'personal' && saved.scopes.has('everyone') ? JE.t('tag_item_editor_error_personal_only')
                        : JE.t('tag_item_editor_error');
                showStatus();
                return;
            }
            if (!results.length && dirty) JE.toast?.(esc(JE.t('tag_item_editor_nothing_kept')));
            finish();
        });

        sync();
        present();
        dialog.focus({ preventScroll: true });
        const first = dialog.querySelector<HTMLElement>('input:checked') || dialog.querySelector('input');
        first?.focus({ preventScroll: true });
        return true;
    }

    /** Close the mounted editor without saving. */
    function closeMounted() {
        current?.close();
    }

    /** Close the open editor without saving; an open still waiting for its item data never shows. */
    function close() {
        cancelPending();
        closeMounted();
    }

    // A user switch closes the editor: its drafts belong to the outgoing user.
    JE.session?.onUserChange?.('tag-item-editor', () => {
        close();
        document.querySelectorAll('.je-tie-toast').forEach((el) => el.remove());
    });

    const api = {
        open,
        close,
        isOpen: (): boolean => !!current,
        /** @returns Whether an open is still waiting for its item data. */
        isOpening: (): boolean => !!pendingOpen,
        anyTagsOn,
        TYPES,
        // Exposed for tests.
        stepCap,
    };
    JE.tagItemEditor = api;
    return api;
}
export type ItemEditor = ReturnType<typeof createItemEditor>;
