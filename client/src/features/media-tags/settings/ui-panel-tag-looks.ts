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
import type { Layout } from '../layout/layout-rules';
import type { LookRule } from '../layout/tag-look';
import { apiClient, optionalApiClient, panelHost, registry, type PanelBridge } from './host';
import type { PanelContext } from '../../settings-panel/public-api';
import { focusElement, queryElements, querySelect } from '../../shared/dom';

type Deps = Pick<PanelBridge, 'internals' | 'core' | 'session' | 'currentSettings' | 't' | 'toast' | 'tagPipeline' | 'normalizeOfficialRating' | 'tagItemEditor'>;
type TagLookApi = NonNullable<PanelBridge['core']['tagLook']>;
type Condition = LookRule['when'][number];

const LAYOUTS: readonly Layout[] = ['corners', 'bands', 'caption', 'summary', 'minimal'];
const TITLE_BATCH = 50;
const CONFIRM_MS = 4000;

/** Shared lookups for one panel instance (fetched lazily, once). */
export interface LooksState {
    /** library id → name. */
    libraries: Map<string, string> | null;
    /** null until loaded; [] when the request failed. */
    genres: string[] | null;
    /** item id → title and type. */
    titles: Map<string, { name: string; type: string }>;
    /** The locked items list is unfolded (narrow panes only fold it). */
    lockedOpen: boolean;
    /** The tab has been shown: the locked items' titles may load. */
    shown: boolean;
    /** Rule id the form edits, '' for a new rule. */
    editing: string;
}
/** One rule's row and its controls (rows outlive the rules array they were built from). */
interface RuleRow { li: HTMLElement; text: HTMLElement; up: HTMLButtonElement; down: HTMLButtonElement; pill: HTMLButtonElement; edit: HTMLButtonElement; del: HTMLButtonElement }
/** The section's lasting DOM: built once per panel, then updated in place. */
interface LooksView {
    root: HTMLElement; rulesCount: HTMLElement; list: HTMLElement; empty: HTMLElement; otherwiseOutcome: HTMLElement;
    locks: HTMLElement; locksCount: HTMLElement; locksToggle: HTMLButtonElement; unlockAll: HTMLButtonElement;
    lockedList: HTMLElement; locksEmpty: HTMLElement; side: HTMLElement;
    rows: Map<string, RuleRow>;
    announce(message: string): void;
    settle(saving: Promise<boolean>, doneKey?: string): void;
}
type SaveRules = (next: LookRule[], doneKey?: string) => void;
/** What the hub and tests read (internal.tagLooksPanel). */
export interface TagLooksPanel {
    show(): void;
    conditionText(when: readonly Condition[], state: Pick<LooksState, 'libraries'>): string;
    loadTitles(state: LooksState, ids: string[]): Promise<void>;
}

/** A field of an untrusted API object. */
const field = (value: unknown, key: string): unknown => value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined;
/** The Items array of a Jellyfin list response (untrusted). */
const itemsOf = (response: unknown): unknown[] => { const items = field(response, 'Items'); return Array.isArray(items) ? items : []; };

/** Create an element with a class and optional text. */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/** A plain button. */
function button(label: string, onClick: () => void, ariaLabel?: string): HTMLButtonElement {
    const b = el('button', '', label);
    b.type = 'button';
    if (ariaLabel) b.setAttribute('aria-label', ariaLabel);
    b.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
    return b;
}

/** A select with options [value, label]. */
function select(options: ReadonlyArray<readonly [string, string]>, value: string): HTMLSelectElement {
    const s = el('select');
    for (const [v, label] of options) {
        const o = el('option', '', label);
        o.value = v;
        if (v === value) o.selected = true;
        s.appendChild(o);
    }
    return s;
}

/** A small icon button (move up/down). */
function iconButton(icon: string, onClick: () => void, ariaLabel: string): HTMLButtonElement {
    const b = button('', onClick, ariaLabel);
    b.className = 'je-tag-looks-move';
    const glyph = el('span', 'material-icons', icon);
    glyph.setAttribute('aria-hidden', 'true');
    b.appendChild(glyph);
    return b;
}

/** Focus an element without scrolling the panel past it. */
function focusOn(node: Element | null | undefined): void {
    if (!(node instanceof HTMLElement) || !node.isConnected) return;
    node.focus({ preventScroll: true });
    node.scrollIntoView?.({ block: 'nearest' });
}

export function installUiPanelTagLooks(JE: Deps): void {
    const internal = registry(JE);
    /** Cleanup for the open panel's layout listener. */
    let unwatchLayout: (() => void) | null = null;
    let identityEpoch = 0;
    document.addEventListener('je:user-changed', () => { identityEpoch++; });
    const titleOwners = new WeakMap<LooksState, { client: ReturnType<typeof apiClient>; user: string; current(): boolean }>();
    function titleOwner(state: LooksState) {
        const existing = titleOwners.get(state);
        if (existing) return existing;
        const client = apiClient();
        const user = client.getCurrentUserId() || '';
        const root = client.getUrl('/');
        const token = client.accessToken?.();
        const serverId = () => typeof client.serverId === 'function' ? client.serverId() : client.serverId;
        const server = serverId();
        const epoch = identityEpoch;
        const sessionEpoch = JE.session?.getEpoch();
        const owner = { client, user, current: () => Boolean(user) && apiClient() === client
            && client.getCurrentUserId() === user && client.getUrl('/') === root
            && client.accessToken?.() === token && serverId() === server
            && identityEpoch === epoch && JE.session?.getEpoch() === sessionEpoch };
        titleOwners.set(state, owner);
        return owner;
    }

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

    const t = (key: string | undefined, params?: Record<string, string | number>) => JE.t(key ?? '', params);
    /** The look-rule store (legacy dereferenced it once the section is wired). */
    const tagLook = (): TagLookApi => {
        const look = JE.core.tagLook;
        if (!look) throw new TypeError('Tag look rules are unavailable');
        return look;
    };
    const vocabulary = () => {
        const L = JE.core.tagLayout;
        if (!L) throw new TypeError('The tag layout controller is unavailable');
        return L.VOCABULARY_KEYS;
    };
    const layoutName = (layoutId: string) => t(vocabulary().layout[layoutId]);
    const densityName = (density: string) => JE.t(density === 'compact' ? 'panel_settings_ui_tag_density_compact' : 'panel_settings_ui_tag_density_full');
    const outcomeText = (look: { layout: string; density: string }) => JE.t('tag_looks_outcome', { layout: layoutName(look.layout), density: densityName(look.density) });
    const typeName = (type: string) => t(vocabulary().type[type.toLowerCase()]);

    /** "When library is Kids and type is Episode". */
    function conditionText(when: readonly Condition[], state: Pick<LooksState, 'libraries'>): string {
        const parts = when.map((cond) => {
            let value = cond.value;
            if (cond.field === 'library') value = state.libraries?.get(cond.value) || JE.t('tag_looks_unknown_library');
            else if (cond.field === 'type') value = typeName(cond.value);
            return JE.t(`tag_looks_cond_${cond.field.toLowerCase()}`, { value });
        });
        return JE.t('tag_looks_when', { conditions: parts.join(JE.t('tag_looks_and')) });
    }

    /** The current user's id. */
    const userId = (): string => optionalApiClient()?.getCurrentUserId?.() || '';

    /** GET a JSON endpoint through ApiClient. */
    function getJson(path: string, query?: Record<string, string | number | boolean>): Promise<unknown> {
        const client = apiClient();
        return client.ajax({ type: 'GET', url: client.getUrl(path, query), dataType: 'json' });
    }

    /** Load the user's libraries (id → name) once. */
    async function loadLibraries(state: LooksState): Promise<void> {
        if (state.libraries) return;
        const map = new Map<string, string>();
        try {
            const resp = await getJson('UserViews', { userId: userId() });
            for (const view of itemsOf(resp)) {
                const id = tagLook().normalizeId(String(field(view, 'Id') || ''));
                if (id) map.set(id, String(field(view, 'Name') || id));
            }
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: could not load libraries for tag look rules', err);
        }
        state.libraries = map;
    }

    /** Load the genre names once ([] when the request fails: the form then offers a text box). */
    async function loadGenres(state: LooksState): Promise<void> {
        if (state.genres) return;
        try {
            const resp = await getJson('Genres', { userId: userId(), SortBy: 'SortName', SortOrder: 'Ascending', Recursive: true, EnableImages: false, EnableTotalRecordCount: false });
            const names = new Set<string>();
            for (const g of itemsOf(resp)) { const name = field(g, 'Name'); if (name) names.add(String(name)); }
            state.genres = Array.from(names);
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: could not load genres for tag look rules', err);
            state.genres = [];
        }
    }

    /** Age ratings present in the server tag cache already in memory, normalised the way the age rating tags show them. */
    function knownRatings(): string[] {
        const seen = new Set<string>();
        try {
            for (const entry of JE.tagPipeline?.serverEntries?.() || []) {
                const raw = field(entry, 'OfficialRating');
                if (!raw) continue;
                const text = String(raw).replace(/\s+/g, ' ').trim();
                const normalized = typeof JE.normalizeOfficialRating === 'function' ? JE.normalizeOfficialRating(text) : null;
                seen.add(normalized ? String(normalized) : text);
                if (seen.size >= 200) break;
            }
        } catch { /* the list is only a convenience */ }
        return Array.from(seen).sort();
    }

    /** Fetch titles for locked items not known yet, 50 ids per request. */
    async function loadTitles(state: LooksState, ids: string[]): Promise<void> {
        const owner = titleOwner(state);
        const missing = ids.filter((id) => !state.titles.has(id));
        for (let i = 0; i < missing.length; i += TITLE_BATCH) {
            if (!owner.current()) return;
            const batch = missing.slice(i, i + TITLE_BATCH);
            try {
                const resp = await owner.client.ajax({ type: 'GET',
                    url: owner.client.getUrl(`Users/${owner.user}/Items`, { Ids: batch.join(','), EnableImages: false, EnableUserData: false }), dataType: 'json' });
                if (!owner.current()) return;
                for (const item of itemsOf(resp)) {
                    const id = tagLook().normalizeId(String(field(item, 'Id') || ''));
                    if (id) state.titles.set(id, { name: String(field(item, 'Name') || id), type: String(field(item, 'Type') || '') });
                }
            } catch (err) {
                if (!owner.current()) return;
                console.warn('🪼 Jellyfin Enhanced: could not load locked item titles', err);
            }
            // Ids the server didn't return (deleted, or no longer visible) keep their id as the title.
            for (const id of batch) if (!state.titles.has(id)) state.titles.set(id, { name: '', type: '' });
        }
    }

    /** Build the section skeleton into its mount. */
    function buildView(mount: HTMLElement, state: LooksState, touch: () => void, renderAll: () => void): LooksView {
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
        const locksEmpty = el('p', 'je-tag-looks-empty', JE.t('tag_looks_no_locks'));
        locksEmpty.tabIndex = -1;
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
            view.settle(tagLook().unlockItems(), 'tag_looks_unlocked_all_toast');
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

        const view: LooksView = {
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
     */
    function renderRules(view: LooksView, state: LooksState, rules: readonly LookRule[], touch: () => void, saveRules: SaveRules, openForm: () => void) {
        const look = tagLook();
        const focused = document.activeElement;
        const ids = new Set(rules.map((r) => r.id));
        for (const [id, row] of view.rows) {
            if (!ids.has(id)) { row.li.remove(); view.rows.delete(id); }
        }
        rules.forEach((rule, index) => {
            let row = view.rows.get(rule.id);
            if (!row) {
                const id = rule.id;
                /** The rule as it is now (the row outlives the rules array it was built from). */
                const now = () => {
                    const all = look.read().rules;
                    return { all, index: all.findIndex((r) => r.id === id) };
                };
                const move = (delta: number) => {
                    const { all, index: at } = now();
                    if (at < 0 || at + delta < 0 || at + delta >= all.length) return;
                    const next = all.slice();
                    const [moved] = next.splice(at, 1);
                    if (!moved || !built) return;
                    next.splice(at + delta, 0, moved);
                    const pressed = delta < 0 ? built.up : built.down;
                    saveRules(next);
                    // Keep focus on the moved rule: the same button, or at an end its other one.
                    focusOn(pressed.disabled ? (delta < 0 ? built.down : built.up) : pressed);
                    view.announce(JE.t('tag_looks_rule_moved', { rule: conditionText(moved.when, state), n: at + delta + 1 }));
                };
                const pill = button('', () => {
                    const { all } = now();
                    saveRules(all.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)));
                });
                pill.className = 'je-tag-looks-pill';
                const edit = button(JE.t('reviews_edit'), () => {
                    state.editing = id;
                    touch();
                    openForm();
                });
                const del = button(JE.t('reviews_delete'), () => {
                    const { all, index: at } = now();
                    const removed = all[at];
                    if (at < 0 || !removed) return;
                    // Focus goes to the next rule's Delete, else the previous one's, else the empty list.
                    const neighbour = all[at + 1] || all[at - 1] || null;
                    if (state.editing === id) {
                        state.editing = '';
                        openForm();
                    }
                    saveRules(all.filter((r) => r.id !== id));
                    focusOn(neighbour ? view.rows.get(neighbour.id)?.del : view.empty);
                    view.announce(JE.t('tag_looks_rule_deleted', { rule: conditionText(removed.when, state) }));
                });
                del.classList.add('je-tag-looks-danger');
                const built: RuleRow = {
                    li: el('li', 'je-tag-looks-row'), text: el('div', 'je-tag-looks-text'),
                    up: iconButton('arrow_upward', () => move(-1), ''), down: iconButton('arrow_downward', () => move(1), ''),
                    pill, edit, del
                };
                built.li.dataset.jeRow = 'rule';
                built.li.dataset.jeRuleId = rule.id;
                built.li.tabIndex = -1;
                const actions = el('div', 'je-tag-looks-actions');
                actions.append(built.up, built.down, built.pill, built.edit, built.del);
                built.li.append(built.text, actions);
                view.rows.set(rule.id, built);
                row = built;
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
        if (focused instanceof HTMLElement && focused.isConnected && document.activeElement !== focused && view.list.contains(focused)) focused.focus({ preventScroll: true });
        view.rulesCount.textContent = String(rules.length);
        view.empty.hidden = rules.length > 0;
    }

    /** Rebuild the locked items list (keyed focus is restored by data-je-focus-key). */
    function renderLocks(view: LooksView, state: LooksState, touch: () => void, renderAll: () => void) {
        const look = tagLook();
        const locks = look.normalizeLocks(JE.currentSettings.tagLayoutLocks);
        const active = document.activeElement;
        const focusKey = active instanceof HTMLElement ? active.dataset?.jeFocusKey || null : null;
        const hadFocus = view.lockedList.contains(active);
        view.locksCount.textContent = String(locks.size);
        view.locks.classList.toggle('je-open', state.lockedOpen);
        view.locksToggle.textContent = JE.t(state.lockedOpen ? 'hidden_content_hide_button' : 'tag_looks_show');
        view.locksToggle.setAttribute('aria-expanded', state.lockedOpen ? 'true' : 'false');
        view.locksToggle.setAttribute('aria-label', JE.t(state.lockedOpen ? 'tag_looks_locks_hide' : 'tag_looks_locks_show', { count: locks.size }));
        view.unlockAll.disabled = locks.size === 0;
        // Nothing to unfold without locks (a narrow pane shows only the count then).
        view.locksToggle.hidden = locks.size === 0;
        view.locksEmpty.hidden = locks.size > 0;
        const ordered = Array.from(locks.entries()).sort((a, b) => b[1].lockedAt - a[1].lockedAt);
        const pending: string[] = [];
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
                const host = view.root.closest('#jellyfin-enhanced-panel');
                JE.tagItemEditor?.open(id, { opener: edit, host: host instanceof HTMLElement ? host : undefined });
            }, JE.t('tag_looks_edit_lock_named', { name: info?.name || id }));
            edit.dataset.jeFocusKey = `edit-${id}`;
            const tools = el('span', 'je-tag-looks-actions');
            tools.append(edit, unlock);
            li.append(text, tools);
            return li;
        });
        view.lockedList.replaceChildren(...items);
        if (hadFocus && focusKey) focusElement(view.lockedList.querySelector(`[data-je-focus-key="${focusKey}"]`), { preventScroll: true });
        // Titles load once the tab has been shown, 50 ids per request.
        if (state.shown && pending.length) loadTitles(state, pending).then(() => { if (view.root.isConnected && titleOwner(state).current()) renderLocks(view, state, touch, renderAll); });
    }

    /**
     * The add/edit rule form (always open). New rules default to Caption and
     * Compact; every condition needs a value; at most five conditions.
     * Returns the form and a re-check of the rule limit for after a change
     * made outside it.
     */
    function buildForm(state: LooksState, rules: readonly LookRule[], touch: () => void, saveRules: SaveRules,
        onSaved: (savedId: string, added: boolean) => void, onCancel: () => void): { form: HTMLFormElement; syncCapacity: () => boolean } {
        const look = tagLook();
        const existing = (state.editing && rules.find((r) => r.id === state.editing)) || null;
        const form = el('form', 'je-tag-looks-form');
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
        /** Drop a value's invalid mark once it changes. */
        const clearError = (control: Element) => {
            control.removeAttribute('aria-invalid');
            control.removeAttribute('aria-describedby');
        };
        /**
         * The value control for a field: a select of libraries, types or
         * genres, or a text box (age rating, or genres that failed to load).
         */
        const valueControl = (fieldName: string, value: string, id: string): HTMLSelectElement | HTMLInputElement => {
            let control: HTMLSelectElement | HTMLInputElement;
            if (fieldName === 'library') {
                const options: Array<readonly [string, string]> = Array.from(state.libraries || new Map<string, string>());
                if (value && !options.some(([v]) => v === value)) options.push([value, JE.t('tag_looks_unknown_library')]);
                control = select([['', JE.t('tag_looks_choose')], ...options], value);
            } else if (fieldName === 'type') {
                control = select([['', JE.t('tag_looks_choose')], ...look.TYPES.map((type): readonly [string, string] => [type, typeName(type)])], value);
            } else if (fieldName === 'genre' && state.genres && state.genres.length) {
                const options: Array<readonly [string, string]> = state.genres.map((g) => [g, g]);
                const match = state.genres.find((g) => g.toLowerCase() === value.toLowerCase());
                if (value && !match) options.push([value, value]);
                control = select([['', JE.t('tag_looks_choose')], ...options], match || value);
            } else {
                const input = el('input');
                input.type = 'text';
                input.maxLength = 100;
                input.value = value;
                if (fieldName === 'ageRating') {
                    const ratings = knownRatings();
                    if (ratings.length) {
                        const listId = `${id}-ratings`;
                        const datalist = el('datalist');
                        datalist.id = listId;
                        for (const r of ratings) { const o = el('option'); o.value = r; datalist.appendChild(o); }
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

        const addLine = el('div', 'je-tag-looks-add-cond');
        const condCount = el('span');
        /** Renumber the condition rows' labels and enable "+ Condition" / remove for the row count. */
        const syncRows = () => {
            const rows = queryElements(condList, '[data-je-cond]');
            rows.forEach((r, i) => {
                const n = String(i + 1);
                const label = r.querySelector('.je-tag-looks-cond-label');
                if (label) label.textContent = JE.t('tag_looks_condition', { n });
                const fieldLabel = r.querySelector('[data-je-field-label]');
                if (fieldLabel) fieldLabel.textContent = JE.t('tag_looks_condition_field', { n });
                const valueLabel = r.querySelector('[data-je-value-label]');
                if (valueLabel) valueLabel.textContent = JE.t('tag_looks_condition_value', { n });
                const remove = r.querySelector('[data-je-cond-remove]');
                if (remove instanceof HTMLButtonElement) {
                    remove.disabled = rows.length <= 1;
                    remove.setAttribute('aria-label', JE.t('tag_looks_remove_condition_named', { n }));
                }
            });
            addCondition.disabled = rows.length >= look.MAX_CONDITIONS;
            condCount.textContent = JE.t('tag_looks_condition_count', { count: rows.length, max: look.MAX_CONDITIONS });
        };

        /** Add one condition row: "Condition N", the field, "is", the value, ✕. */
        const addRow = (cond: { field: string; value: string }) => {
            const n = ++rowSeq;
            const row = el('div', 'je-tag-looks-cond');
            row.dataset.jeCond = '1';
            const fieldId = `jeTagLooksField${n}`;
            const valueId = `jeTagLooksValue${n}`;
            const fieldLabel = el('label', 'je-tag-looks-sr');
            fieldLabel.dataset.jeFieldLabel = '1';
            fieldLabel.setAttribute('for', fieldId);
            const fieldSelect = select(look.FIELDS.map((f): readonly [string, string] => [f, t(vocabulary().field[`${f.toLowerCase()}`])]), cond.field);
            fieldSelect.id = fieldId;
            fieldSelect.dataset.jeCondField = '1';
            const valueLabel = el('label', 'je-tag-looks-sr');
            valueLabel.dataset.jeValueLabel = '1';
            valueLabel.setAttribute('for', valueId);
            let control = valueControl(cond.field, cond.value, valueId);
            fieldSelect.addEventListener('change', () => {
                touch();
                const next = valueControl(fieldSelect.value, '', valueId);
                if (control.nextElementSibling?.tagName === 'DATALIST') control.nextElementSibling.remove();
                control.replaceWith(next);
                control = next;
            });
            const remove = button('✕', () => {
                touch();
                const rows = queryElements(condList, '[data-je-cond]');
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

        const addCondition = button(JE.t('tag_looks_add_condition'), () => {
            touch();
            addRow({ field: 'type', value: '' });
            syncRows();
            focusOn(condList.lastElementChild?.querySelector('[data-je-cond-field]'));
        });
        addLine.append(addCondition, condCount);
        conditions.appendChild(addLine);

        for (const cond of existing?.when?.length ? existing.when : [{ field: 'library', value: '' }]) addRow(cond);
        syncRows();

        const outcome = el('fieldset');
        outcome.appendChild(el('legend', '', JE.t('tag_looks_use_look')));
        const outcomeRow = el('div', 'je-tag-looks-outcome-row');
        const layoutLabel = el('label', '', JE.t('panel_settings_ui_tag_layout'));
        const layoutSelect = select(LAYOUTS.map((l): readonly [string, string] => [l, layoutName(l)]), existing?.layout || 'caption');
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
        const save = el('button', 'je-tag-looks-save', JE.t(existing ? 'tag_looks_save' : 'tag_looks_add_rule'));
        save.type = 'submit';
        buttons.appendChild(save);
        if (existing) buttons.appendChild(button(JE.t('jellyseerr_modal_cancel'), () => { touch(); onCancel(); }));
        const hint = el('span', 'je-tag-looks-buttons-hint');
        buttons.appendChild(hint);
        form.appendChild(buttons);

        /**
         * A new rule can be added only below the limit: re-read the rules
         * now (a delete or a failed save changes the count under the form,
         * which keeps what was typed). Returns whether the limit is reached.
         */
        const syncCapacity = () => {
            const full = !existing && look.read().rules.length >= look.MAX_RULES;
            save.disabled = full;
            hint.textContent = JE.t(full ? 'tag_looks_limit' : existing ? 'tag_looks_edit_hint' : 'tag_looks_add_hint', { count: look.MAX_RULES });
            return full;
        };
        syncCapacity();

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            touch();
            if (syncCapacity()) return;
            const when: Array<{ field: string; value: string }> = [];
            for (const row of queryElements(condList, '[data-je-cond]')) {
                const fieldName = querySelect(row, '[data-je-cond-field]')?.value ?? '';
                const control = row.querySelector('[data-je-cond-value]');
                if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement)) continue;
                const value = control.value.trim();
                if (!value) {
                    error.textContent = JE.t('tag_looks_error_value');
                    control.setAttribute('aria-invalid', 'true');
                    control.setAttribute('aria-describedby', errorId);
                    control.focus();
                    return;
                }
                when.push({ field: fieldName, value });
            }
            const current = look.read().rules;
            const still = existing ? current.find((r) => r.id === existing.id) : null;
            // The rule being edited was deleted meanwhile: this would add one.
            if (!still && current.length >= look.MAX_RULES) {
                error.textContent = JE.t('tag_looks_limit', { count: look.MAX_RULES });
                return;
            }
            // Editing keeps the rule's On/Off state (a switched-off rule stays off).
            const draft = { id: still?.id || look.newRuleId(new Set(current.map((r) => r.id))), enabled: still ? still.enabled : true,
                when, layout: layoutSelect.value, density: densitySelect.value, colourPreset: still?.colourPreset || null, slots: still?.slots || null, shapes: still?.shapes || null };
            // The store's own normalizer validates the candidate (fields, values, layout) before it is saved.
            const [candidate, ...extra] = look.normalizeRules([draft]);
            if (!candidate || extra.length) {
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

    /** The open panel's section, for the hub's tab switch. */
    let active: { show(): void } | null = null;

    /**
     * Wire the section into the open settings panel (the template renders
     * an empty #jeTagLooksMount). Libraries and genres load in the
     * background; the lists render first and again once they arrive.
     */
    internal.wireTagLooks = function (ctx: Partial<Pick<PanelContext, 'resetAutoCloseTimer' | 'onClose'>> | undefined) {
        unwatchLayout?.();
        const mount = document.getElementById('jeTagLooksMount');
        const look = JE.core?.tagLook;
        if (!mount || !look || !JE.core?.tagLayout) return;
        JE.core.ui?.injectCss?.('je-tag-looks-panel', PANEL_CSS);
        const state: LooksState = { libraries: null, genres: null, titles: new Map(), lockedOpen: false, shown: false, editing: '' };
        const owner = titleOwner(state);
        let closed = false;
        titleOwners.set(state, { ...owner, current: () => !closed && mount.isConnected && owner.current() });
        const touch = () => { try { ctx?.resetAutoCloseTimer?.(); } catch { /* panel closing */ } };
        /** The open form's rule-limit check. */
        let syncFormCapacity: (() => boolean) | null = null;

        /** Save the rules (shown at once, put back on failure) and redraw the lists. */
        const saveRules: SaveRules = (next, doneKey) => {
            touch();
            view.settle(look.saveRules(next), doneKey);
            renderLists();
        };
        const renderOtherwise = () => {
            const L = JE.core.tagLayout;
            if (L) view.otherwiseOutcome.textContent = `→ ${outcomeText(L.normalizeSettings())}`;
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
                if (rule) view.announce(JE.t(added ? 'tag_looks_rule_added' : 'tag_looks_rule_saved', { n: index + 1, rule: conditionText(rule.when, state) }));
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
        const phone = typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 760px)') : undefined;
        /** Put the editable form first on phones, regardless of saved-rule count. */
        const orderPhoneForm = () => {
            const cols = view.side.parentElement;
            if (!cols) return;
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
            closed = true;
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
    const panel: TagLooksPanel = { show: () => active?.show(), conditionText, loadTitles };
    internal.tagLooksPanel = panel;
}

installUiPanelTagLooks(panelHost());
