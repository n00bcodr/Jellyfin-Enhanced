/**
 * @file Per-kind opacity and size controls (layout/kind-looks.ts): one compact table with a row per tag kind (each
 * quality category and every other tag group) holding an opacity and a size field, a reset per row, and "apply to
 * all" and "reset all" under it. The settings panel's Media Tags hub draws it on its Layout tab for the user's own
 * values (kindLooksHubHtml / bindKindLooksHub); the administrator's Media Tags tab draws the same table for the
 * defaults (admin/sections/layout.ts). Rows come from the layout's kind list, so a new kind gets its row by itself.
 */
import type { KindLook, KindLookField, TagKind } from '../layout/kind-looks';
import type { PanelBridge } from './host';

/** The layout members the table reads (core/tag-layout.js). */
export interface KindLooksLayout {
    TAG_KINDS: readonly TagKind[];
    KIND_LOOK_LIMITS: Readonly<Record<KindLookField, Readonly<{ min: number; max: number; step: number; fallback: number }>>>;
    readKindLooks(raw: unknown): Record<string, KindLook>;
}

/** The table's words, already in the reader's language; `name` names a kind. */
export interface KindLooksText {
    caption: string; kind: string; opacity: string; size: string; all: string; apply: string; resetAll: string;
    name(kind: TagKind): string;
    field(name: string, field: KindLookField): string;
    reset(name: string): string;
}

const FIELDS: readonly KindLookField[] = ['opacity', 'scale'];
const FIELD_ATTR = 'data-je-kind-field';

/** A field's input: a whole percent in its range and step. */
function inputHtml(L: KindLooksLayout, field: KindLookField, value: number, label: string, esc: (s: string) => string, attr: string): string {
    const { min, max, step } = L.KIND_LOOK_LIMITS[field];
    return `<span class="je-kind-looks-value"><input type="number" inputmode="numeric" min="${Number(min)}" max="${Number(max)}" step="${Number(step)}" value="${Math.round(value)}" ${attr}="${field}" aria-label="${esc(label)}"><span aria-hidden="true">%</span></span>`;
}

/**
 * The table.
 * @param shown - A kind's values as drawn now (its own over the defaults).
 */
export function kindLooksTableHtml(L: KindLooksLayout, text: KindLooksText, esc: (s: string) => string, shown: (kind: string) => Readonly<Record<KindLookField, number>>): string {
    const rows = L.TAG_KINDS.map((kind) => {
        const name = text.name(kind);
        const values = shown(kind.id);
        return `<tr data-je-kind="${esc(kind.id)}"><th scope="row">${esc(name)}</th>${FIELDS.map((field) => `<td>${inputHtml(L, field, values[field], text.field(name, field), esc, FIELD_ATTR)}</td>`).join('')}
            <td><button type="button" class="je-kind-looks-reset" data-je-kind-act="reset" aria-label="${esc(text.reset(name))}" title="${esc(text.reset(name))}"><span class="material-icons" aria-hidden="true">restart_alt</span></button></td></tr>`;
    }).join('');
    const all = FIELDS.map((field) => `<td>${inputHtml(L, field, L.KIND_LOOK_LIMITS[field].fallback, text.field(text.all, field), esc, 'data-je-kind-all')}</td>`).join('');
    return `<table class="je-kind-looks-table" data-je-kind-looks>
        <caption class="je-kind-looks-caption">${esc(text.caption)}</caption>
        <thead><tr><th scope="col">${esc(text.kind)}</th><th scope="col">${esc(text.opacity)}</th><th scope="col">${esc(text.size)}</th><td></td></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><th scope="row">${esc(text.all)}</th>${all}<td></td></tr>
        <tr><td colspan="4"><span class="je-kind-looks-actions"><button type="button" data-je-kind-act="apply">${esc(text.apply)}</button><button type="button" data-je-kind-act="reset-all">${esc(text.resetAll)}</button></span></td></tr></tfoot>
    </table>`;
}

/** Layout of the table (shared by the hub and the admin page; colours come from the page around it). */
export const KIND_LOOKS_CSS = `
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
`;

/** A field's typed value clamped to its range, or undefined while the field holds no number. */
function valueOf(L: KindLooksLayout, input: HTMLInputElement, field: KindLookField): number | undefined {
    const n = input.valueAsNumber;
    if (!Number.isFinite(n)) return undefined;
    const { min, max } = L.KIND_LOOK_LIMITS[field];
    return Math.min(max, Math.max(min, Math.round(n)));
}

const isField = (value: string | null | undefined): value is KindLookField => value === 'opacity' || value === 'scale';

/**
 * Edits from the table. Typing changes the look at once (`final` false); leaving a field, a stepper click and the
 * buttons save (`final` true).
 * @param update - Applies a change to the own values and saves; `final` says whether to store it.
 * @returns The listeners' removal.
 */
export function bindKindLooksTable(root: HTMLElement, L: KindLooksLayout,
    update: (change: (own: Record<string, KindLook>) => Record<string, KindLook>, final: boolean) => void): () => void {
    const tableOf = (el: Element | null) => el?.closest('[data-je-kind-looks]') ?? null;
    const edit = (e: Event) => {
        const input = e.target;
        if (!(input instanceof HTMLInputElement) || !tableOf(input)) return;
        const field = input.getAttribute(FIELD_ATTR);
        const kind = input.closest('tr')?.getAttribute('data-je-kind');
        if (!isField(field) || !kind) return;
        const value = valueOf(L, input, field);
        if (value === undefined) return;
        const final = e.type === 'change';
        if (final && String(value) !== input.value) input.value = String(value);
        update((own) => ({ ...own, [kind]: { ...own[kind], [field]: value } }), final);
    };
    const click = (e: Event) => {
        const button = e.target instanceof Element ? e.target.closest('button[data-je-kind-act]') : null;
        const table = tableOf(button);
        if (!button || !table) return;
        const act = button.getAttribute('data-je-kind-act');
        if (act === 'reset') {
            const kind = button.closest('tr')?.getAttribute('data-je-kind');
            if (kind) update((own) => Object.fromEntries(Object.entries(own).filter(([id]) => id !== kind)), true);
        } else if (act === 'reset-all') {
            update(() => ({}), true);
        } else if (act === 'apply') {
            const all: KindLook = {};
            for (const field of FIELDS) {
                const input = table.querySelector(`input[data-je-kind-all="${field}"]`);
                const value = input instanceof HTMLInputElement ? valueOf(L, input, field) : undefined;
                if (value !== undefined) all[field] = value;
            }
            update(() => Object.fromEntries(L.TAG_KINDS.map((kind) => [kind.id, { ...all }])), true);
        }
    };
    root.addEventListener('input', edit);
    root.addEventListener('change', edit);
    root.addEventListener('click', click);
    return () => {
        root.removeEventListener('input', edit);
        root.removeEventListener('change', edit);
        root.removeEventListener('click', click);
    };
}

/** Put the values drawn now into the table's fields (the one being typed in keeps its text). */
export function syncKindLooksTable(root: ParentNode, shown: (kind: string) => Readonly<Record<KindLookField, number>>): void {
    root.querySelectorAll('[data-je-kind-looks] tr[data-je-kind]').forEach((row) => {
        const values = shown(row.getAttribute('data-je-kind') || '');
        row.querySelectorAll(`input[${FIELD_ATTR}]`).forEach((input) => {
            const field = input.getAttribute(FIELD_ATTR);
            if (input instanceof HTMLInputElement && isField(field) && input !== document.activeElement) input.value = String(values[field]);
        });
    });
}

// ── The settings panel's Media Tags hub ───────────────────────────────

type HubDeps = Pick<PanelBridge, 'core' | 'currentSettings' | 'escapeHtml' | 't' | 'saveUserSettings' | 'reinitializeTagLayout'>;

/** The hub's layout controller, with the kind members (core/tag-layout.js). */
function hubLayout(JE: HubDeps) {
    const L = JE.core?.tagLayout;
    if (!L) throw new TypeError('core/tag-layout.js must load before the Media Tags hub');
    return L;
}

/** The user's words for the table: group names and the quality category names the group editor shows. */
function hubText(JE: HubDeps): KindLooksText {
    const L = hubLayout(JE);
    const say = (key: string, params?: Record<string, string>) => JE.t(key, params);
    const readable = (id: string) => id.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
    return {
        caption: say('tag_kind_looks_desc'), kind: say('tag_kind_looks_kind'), opacity: say('tag_kind_looks_opacity'), size: say('tag_kind_looks_size'),
        all: say('tag_kind_looks_all'), apply: say('tag_kind_looks_apply_all'), resetAll: say('tag_kind_looks_reset_all'),
        name(kind) {
            // showAudioInfoTag → panel_settings_ui_quality_tags_audio_info; a group → its vocabulary name.
            const key = kind.setting
                ? `panel_settings_ui_quality_tags_${kind.setting.replace(/^show|Tag$/g, '').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()}`
                : L.VOCABULARY_KEYS.group[kind.group === 'ageRating' ? 'age_rating' : kind.group];
            const name = key ? say(key) : '';
            return name && name !== key ? name : readable(kind.id);
        },
        field: (name, field) => say(field === 'opacity' ? 'tag_kind_looks_opacity_for' : 'tag_kind_looks_size_for', { kind: name }),
        reset: (name) => say('tag_kind_looks_reset', { kind: name }),
    };
}

/** A kind's values as the user's cards draw them (own over the administrator's, else 100). */
function hubShown(JE: HubDeps): (kind: string) => Readonly<Record<KindLookField, number>> {
    const L = hubLayout(JE);
    L.invalidateSettings();
    const looks = L.normalizeSettings().kindLooks;
    return (kind) => looks[kind] ?? { opacity: L.KIND_LOOK_LIMITS.opacity.fallback, scale: L.KIND_LOOK_LIMITS.scale.fallback };
}

/** The Layout tab's card. */
function kindLooksHubHtml(JE: HubDeps): string {
    const L = hubLayout(JE);
    const esc = (s: string) => JE.escapeHtml(s);
    JE.core?.ui?.injectCss?.('je-kind-looks', KIND_LOOKS_CSS);
    return `<section class="je-mth-card je-mth-kind-looks" aria-labelledby="jeMthKindLooksTitle">
        <h4 class="je-mth-card-title" id="jeMthKindLooksTitle">${esc(JE.t('tag_kind_looks_title'))}</h4>
        ${kindLooksTableHtml(L, hubText(JE), esc, hubShown(JE))}
    </section>`;
}

/**
 * The hub's edits: the user's own values (a document saved before layouts becomes a layout document first, like
 * the size control), every card and the preview redrawn as they type, stored when a field is left or a button used.
 * @returns The listeners' removal.
 */
export function bindKindLooksHub(hub: HTMLElement, JE: HubDeps): () => void {
    const L = hubLayout(JE);
    // The Layout tab holds the card's place (data-je-kind-looks-mount); the card is drawn here.
    const mount = hub.querySelector('[data-je-kind-looks-mount]');
    if (mount) mount.innerHTML = kindLooksHubHtml(JE);
    const sync = () => syncKindLooksTable(hub, hubShown(JE));
    const off = bindKindLooksTable(hub, L, (change, final) => {
        L.promoteLegacySettings(JE.currentSettings);
        JE.currentSettings.tagKindLooks = L.kindLooksToWire(change(L.readKindLooks(JE.currentSettings.tagKindLooks)));
        JE.currentSettings.tagLayoutSettingsVersion = 1;
        L.invalidateSettings();
        void JE.reinitializeTagLayout?.();
        if (final) {
            JE.saveUserSettings('settings.json', JE.currentSettings);
            sync();
        }
    });
    // Presets, imports and resets elsewhere in the hub change the values: show them.
    document.addEventListener('je:tag-layout-changed', sync);
    return () => {
        off();
        document.removeEventListener('je:tag-layout-changed', sync);
    };
}
