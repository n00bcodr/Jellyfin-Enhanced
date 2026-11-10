/**
 * @file One view of the Media Tags tab: its markup, the declared fields'
 * wiring, the tabs and group rows, the preview, the save indicator and the
 * snackbars. The edits themselves live in the document-wide save store.
 */
import type { JsonValue } from '../../../contracts/generated';
import { apiClient, cdnUrl, settingsUi, type AdminTagsBridge } from './host';
import type { TagPreview } from '../settings/ui-panel-tag-preview';
import { activeElement, all, allAs, closest, find, focus, isDisabled, must, targetOf } from './dom';
import { controlValue, fieldValue, fieldsHtml, type TextKit } from './fields';
import { fmt, word, WORDS } from './format';
import type { SaveStore, StoreEvent } from './save-store';
import type { OpenTabOptions, PageApi, PageContext, PageOptions, SampleChip, SectionDef, SetOptions, TabDef, Target } from './types';
import { copy, own, sameValue, type Config } from './values';

export interface PageDeps {
    JE(): AdminTagsBridge;
    kit: TextKit;
    saves: SaveStore;
    sections: SectionDef[];
    tabs: readonly TabDef[];
    seededKeys: readonly string[];
    sectionScopes: Readonly<Record<string, 'new' | 'all'>>;
    sectionIcons: Readonly<Record<string, string>>;
    docsUrl: string;
    docsAnchors: Readonly<Record<string, string>>;
    pluginId: string;
    pageFields(): Set<string>;
    seedUser(config: Config): Config;
    pageUrl(tab?: string | null, group?: string | null): string;
    mainPageUrl(section?: string | null, tab?: string | null): string;
    freshTarget(): Target;
    askConfirm(text: string, title: string): Promise<boolean>;
    undoMs: number;
    tabStoreKey: string;
    previewStyleId: string;
}

/**
 * A field's name for the save indicator: its control's label, else the field name spelled out.
 * @param sections
 * @param key - PluginConfiguration field.
 * @returns {string}
 */
export function fieldName(sections: readonly SectionDef[], key: string): string {
    for (const s of sections) {
        for (const f of s.fields || []) {
            if (f.key === key || f.orderKey === key) return fmt(f.label);
        }
    }
    return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

/**
 * A field's value as its control shows it: the option's text, On/Off for a switch, else the value itself.
 * @param key - PluginConfiguration field.
 * @param value
 * @returns {string}
 */
export function valueLabel(key: string, value: JsonValue | undefined): string {
    const control = all(document, '.je-tag-admin [data-je-field]').find((el) => el.getAttribute('data-je-field') === key) || null;
    if (typeof value === 'boolean' || (control instanceof HTMLInputElement && control.type === 'checkbox')) return fmt(value ? 'On' : 'Off');
    if (control instanceof HTMLSelectElement) {
        const option = Array.from(control.options).find((o) => o.value === String(value ?? ''));
        if (option) return option.textContent || String(value);
    }
    // Pills: the chosen option's own label.
    const radio = control ? allAs(control, 'input[type="radio"]', HTMLInputElement).find((r) => r.value === String(value ?? '')) : null;
    if (radio) return radio.closest('label')?.textContent?.trim() || String(value);
    return value === null || value === undefined || value === '' ? fmt('Server default') : String(typeof value === 'object' ? JSON.stringify(value) : value);
}

const SCOPE_LABELS: Readonly<Record<string, string>> = {
    movies: 'Movies', series: 'Series', seasons: 'Seasons', episodes: 'Episodes', continueWatching: 'Continue Watching row', nextUp: 'Next Up row',
};
const pascal = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Build the page into its root and wire it.
 * @param deps
 * @param root - The .je-tag-admin element.
 * @param initial - The plugin configuration (copied into the page's working copy).
 * @param options - target: the section to open (default: the one the URL asks
 *   for, else the last one shown). Host hooks (tests): api, confirm.
 * @returns {PageContext}
 */
export function createPage(deps: PageDeps, root: HTMLElement, initial: Config, options: PageOptions = {}): PageContext {
    const { kit, saves, sections, tabs: TABS } = deps;
    const { esc, tx, perUserMark } = kit;
    const store = saves.store;
    const JE = deps.JE;
    const host: PageApi = options.api || {
        get: () => apiClient().getPluginConfiguration(deps.pluginId),
        patch: (changes, expected) => apiClient().ajax({
            type: 'POST',
            url: apiClient().getUrl('/JellyfinEnhanced/admin/configuration'),
            data: JSON.stringify({ Changes: changes, Expected: expected }),
            contentType: 'application/json',
            dataType: 'json',
        }),
    };
    const config: Config = { ...initial };
    for (const section of sections) for (const field of section.fields || []) if (field.secret) delete config[field.key];
    saves.checkSession();
    store.host = host;
    const contextMark = saves.sessionMark();
    // Edits a failed save left behind (another view's) show here too.
    for (const [key, value] of store.values) config[key] = value;
    let disposed = false;
    // Jellyfin keeps the root when it keeps the view: every listener on it
    // goes with this page's lifetime, so a rebuilt page never doubles them.
    const lifetime = new AbortController();
    const { signal } = lifetime;
    let preview: TagPreview | null = null;
    let snackTimer: ReturnType<typeof setTimeout> | null = null;
    /** open state of each group row */
    const openGroups = new Map<string, boolean>();

    root.classList.add('je-tag-admin');
    const groupSections = sections.filter((s) => s.tab === 'groups' && s.group);
    const docsLink = (tab: TabDef): string => `<a class="je-ta-docs" href="${deps.docsUrl}#${own(deps.docsAnchors, tab.id)}" target="_blank" rel="noopener" aria-label="${tx('Learn more about {name} in the documentation (opens in a new tab)', { name: fmt(tab.nameKey) })}">${tx('Learn more')}</a>`;
    // A narrow page shows every tab as an icon over a short label (the accessible name stays the full one).
    const tabButtons = TABS.map((tab, i) => `<button type="button" role="tab" class="je-ta-tab" id="jeTaTab-${tab.id}" data-tab="${tab.id}" aria-controls="jeTaPanel-${tab.id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}"${tab.shortKey ? ` aria-label="${tx(tab.nameKey)}"` : ''}><span class="material-icons" aria-hidden="true">${tab.icon}</span><span class="je-ta-tab-long">${tx(tab.nameKey)}</span>${tab.shortKey ? `<span class="je-ta-tab-short" aria-hidden="true">${tx(tab.shortKey)}</span>` : ''}</button>`).join('');
    const panels = TABS.map((tab, i) => {
        const ownSections = sections.filter((s) => s.tab === tab.id && !s.group);
        // Groups: one card holding the group rows (the page's sub-panels inside a card).
        const rows = tab.id === 'groups' ? `<section class="je-ta-card je-ta-grows-card" aria-labelledby="jeTaSec-groups-all"><h3 class="je-ta-card-title" id="jeTaSec-groups-all"><span class="material-icons je-ta-card-icon" aria-hidden="true">label</span>${tx('Tag groups')}</h3><p class="je-ta-hint">${tx(tab.descKey)} ${docsLink(tab)}</p><div class="je-ta-grows">${groupSections.map((s) => groupRowHtml(s)).join('')}</div></section>` : '';
        // A section that opens with its cards starts at the first card, as the page's sections do; its heading stays for screen readers.
        return `<div class="je-ta-panel" role="tabpanel" id="jeTaPanel-${tab.id}" data-tab="${tab.id}"${tab.lead ? ` data-lead="${tab.lead}"` : ''} aria-labelledby="jeTaPanelTitle-${tab.id}" ${i === 0 ? '' : 'hidden'}>`
            + `<div class="je-ta-panel-head"><h2 tabindex="-1" id="jeTaPanelTitle-${tab.id}">${tx(tab.nameKey)}</h2></div><p class="je-ta-hint">${tx(tab.descKey)} ${docsLink(tab)}</p>`
            + ownSections.map((s) => sectionHtml(s)).join('') + rows + '</div>';
    }).join('');
    root.innerHTML = `
            <div class="je-ta-intro je-tab-intro"><span class="material-icons" aria-hidden="true">info</span><p>${tx('Changes save automatically. These are the defaults new users start with and the settings everyone shares; existing users keep theirs, and anyone can change their own look in their Media Tags settings.')}</p></div>
            <div class="je-ta-sections"><div class="je-ta-tabs" role="tablist" aria-label="${tx('Media Tags')}">${tabButtons}</div></div>
            <span class="je-ta-saved" id="jeTaSaved" data-state="saved" role="status" aria-live="polite" tabindex="-1"><span class="je-ta-saved-long">${tx('All changes saved')}</span><span class="je-ta-saved-short" aria-hidden="true">${tx('Saved')}</span></span>
            <div class="je-ta-unsaved" data-je-unsaved hidden><span class="material-icons" aria-hidden="true">sync_problem</span><span data-je-unsaved-text></span><button type="button" class="je-ta-button" data-je-review>${tx('Review')}</button></div>
            <div class="je-ta-body">
                <aside class="je-ta-preview" id="jeTaPreview" aria-label="${tx('Preview: a new user\'s cards')}">
                    <button type="button" class="je-ta-preview-toggle" aria-expanded="false" aria-controls="jeTaPreviewBody" data-je-info>${tx('Preview: a new user\'s cards')}<span class="material-icons" aria-hidden="true">expand_more</span></button>
                    <div class="je-ta-preview-body" id="jeTaPreviewBody"><div class="je-ta-preview-mount"></div><details class="je-ta-preview-why" data-je-info><summary>${tx('How looks are chosen')}</summary><p class="je-ta-preview-note">${tx('Locked looks come first, then server-wide item looks, then the first matching rule, then episode and list-row looks, then the default.')}</p></details><p class="je-ta-native" id="jeTaNative"></p></div>
                </aside>
                <div class="je-ta-panels">${panels}</div>
            </div>
            <div class="je-ta-live" role="status" aria-live="polite"></div>`;

    /** A section card. */
    function sectionHtml(s: SectionDef): string {
        // Who a card's settings reach: users hold a personal copy of 'new' cards; shared settings have no marker.
        const scope = own(deps.sectionScopes, s.id);
        // A card whose settings reach different people (no scope of its own): each per-user setting is marked.
        if (!scope && s.tab !== 'groups') for (const f of s.fields || []) if (f.key && f.type !== 'custom' && !f.scope) f.scope = deps.seededKeys.includes(f.key) ? 'new' : 'all';
        const chip = scope === 'new' ? ` ${perUserMark()}` : '';
        // A note (an explanation with nothing to set): a closed disclosure after the cards, not a card of its own,
        // marked as help text (data-je-info) for the settings guards.
        if (s.note) {
            return `<details class="je-ta-more je-ta-note" data-section="${esc(s.id)}" data-je-info><summary class="je-ta-more-toggle" id="jeTaSec-${esc(s.id)}"><span class="material-icons" aria-hidden="true">expand_more</span>${tx(s.noteLabel || s.title)}</summary>`
                + `<div class="je-ta-more-body">${s.hint ? `<p class="je-ta-hint">${tx(s.hint)}</p>` : ''}${fieldsHtml(kit, s.fields, config)}<div class="je-ta-section-body"></div></div></details>`;
        }
        const iconName = own(deps.sectionIcons, s.id);
        // `img:<cdn path>` draws a service logo from the CDN instead of a Material icon.
        const icon = !iconName ? '' : iconName.startsWith('img:')
            ? `<span class="je-ta-card-icon je-ta-card-icon-img" aria-hidden="true"><img alt="" src="${esc(cdnUrl(iconName.slice(4)))}"></span>`
            : `<span class="material-icons je-ta-card-icon" aria-hidden="true">${iconName}</span>`;
        return `<section class="je-ta-card${s.note ? ' je-ta-card--note' : ''}" data-section="${esc(s.id)}" aria-labelledby="jeTaSec-${esc(s.id)}">`
            + `<h3 class="je-ta-card-title" id="jeTaSec-${esc(s.id)}">${icon}${tx(s.title)}${chip}</h3>${s.hint ? `<p class="je-ta-hint">${tx(s.hint)}</p>` : ''}`
            + fieldsHtml(kit, s.fields, config) + '<div class="je-ta-section-body"></div></section>';
    }

    /** A Groups tab row (head + closed panel). */
    function groupRowHtml(s: SectionDef): string {
        const groupId = s.group ? s.group.id : '';
        // Fields the server keeps for everyone (not copied into a new user's settings) are marked so.
        for (const f of s.fields || []) if (f.key && f.type !== 'enable' && f.type !== 'custom' && !deps.seededKeys.includes(f.key)) f.scope = 'all';
        const enable = (s.fields || []).find((f) => f.type === 'enable');
        const on = enable ? config[enable.key] === true : true;
        const name = fmt(s.title);
        // Edit only opens something worth opening: a group with settings of its own. Otherwise the
        // row's description and its position-and-limit link sit in the row itself.
        const ownControls = hasOwnControls(s, groupId);
        const placement = JE().core?.tagLayout?.GROUPS?.some((g) => g === groupId)
            ? `<a class="je-ta-link je-ta-crosslink" href="#" data-je-goto="layout:placement-${esc(groupId)}"><span class="je-ta-link-text">${tx('{group} position and limit (Layout defaults)', { group: name })}</span><span class="material-icons" aria-hidden="true">arrow_forward</span></a>` : '';
        const mark = enable ? ` ${perUserMark()}` : '';
        if (!ownControls) {
            // As every row: name first, the sample, then the switch on the right.
            return `<div class="je-ta-grow" data-group="${esc(groupId)}" data-section="${esc(s.id)}" data-enabled="${on}" data-open="false" data-je-static>`
                + '<div class="je-ta-grow-head">'
                + `<div class="je-ta-grow-text"><span class="je-ta-grow-name" id="jeTaSec-${esc(s.id)}">${esc(name)}${mark}</span><span class="je-ta-grow-sum"></span>`
                + `${scopesHtml(groupId)}${placement}</div>`
                + '<span class="je-ta-grow-sample" aria-hidden="true"></span>'
                + (enable ? `<label class="je-ta-grow-check"><input type="checkbox" id="${esc(enable.id)}" data-je-field="${esc(enable.key)}" data-je-setting-id="${esc(enable.id)}" ${on ? 'checked' : ''} aria-label="${tx(enable.label)}"></label>` : '')
                + '</div></div>';
        }
        return `<div class="je-ta-grow" data-group="${esc(groupId)}" data-section="${esc(s.id)}" data-enabled="${on}" data-open="false">`
            + '<div class="je-ta-grow-head">'
            // Turning a group on or off sets new users' default; say so beside it.
            + `<div class="je-ta-grow-text"><span class="je-ta-grow-name" id="jeTaSec-${esc(s.id)}">${esc(name)}${mark}</span><span class="je-ta-grow-sum" id="jeTaSum-${esc(s.id)}"></span></div>`
            + '<span class="je-ta-grow-sample" aria-hidden="true"></span>'
            // Name first, controls on the right (the page's setting rows): the switch, with its own 44px target, only turns the group on or off.
            + (enable ? `<label class="je-ta-grow-check"><input type="checkbox" id="${esc(enable.id)}" data-je-field="${esc(enable.key)}" data-je-setting-id="${esc(enable.id)}" ${on ? 'checked' : ''} aria-labelledby="jeTaSec-${esc(s.id)}" aria-describedby="jeTaSum-${esc(s.id)}"></label>` : '')
            + `<button type="button" class="je-ta-expand" aria-expanded="false" aria-controls="jeTaGroup-${esc(groupId)}" aria-label="${tx('Edit {name} settings', { name })}"><span class="je-ta-expand-text">${tx('Edit')}</span><span class="material-icons" aria-hidden="true">expand_more</span></button>`
            + '</div>'
            + `<div class="je-ta-grow-body" id="jeTaGroup-${esc(groupId)}" role="region" aria-labelledby="jeTaSec-${esc(s.id)}" hidden>${s.hint ? `<p class="je-ta-hint">${tx(s.hint)}</p>` : ''}`
            // Where it goes and how many show live on Layout defaults: say so, and go there.
            + placement
            + `${fieldsHtml(kit, s.fields, config)}${scopesHtml(groupId)}<div class="je-ta-section-body"></div></div></div>`;
    }

    /**
     * Whether a group row has settings of its own: a declared control beyond its on/off switch, the
     * "Where to show" switches, or a body its section draws.
     */
    function hasOwnControls(s: SectionDef, group: string): boolean {
        const core = JE().core;
        const S = core.tagScopes;
        return (s.fields || []).some((f) => f.type !== 'enable' && f.type !== 'custom')
            || typeof s.render === 'function'
            || (!!S && core.tagSettingsMatrix?.offers('admin', group, 'scopes') === true && (group === 'rating' || S.SCOPED_GROUPS.includes(group)));
    }

    /**
     * "Where to show" for a group row: the same six switches on every card group (Rating writes its own
     * RatingTagsOn… fields, the others TagGroupScopes); People Tags say why they have none.
     */
    function scopesHtml(group: string): string {
        const core = JE().core;
        const S = core.tagScopes;
        if (!S) return '';
        const offered = core.tagSettingsMatrix?.offers('admin', group, 'scopes') ?? true;
        if (offered !== true) return `<p class="je-ta-hint" data-je-scope-na="${esc(group)}">${tx(word(WORDS.reason, offered) || offered)}</p>`;
        if (group !== 'rating' && !S.SCOPED_GROUPS.includes(group)) return '';
        return `<fieldset class="je-ta-scopes" data-je-scope-block="${esc(group)}"><legend class="je-ta-sub">${tx('Where to show')}</legend>`
            + `<p class="je-ta-hint">${tx('New users start with these choices, and users who have not changed theirs follow them.')}</p>`
            + S.SCOPE_IDS.map((scope) => {
                const ratingId = `ratingTagsOn${pascal(scope)}`;
                return `<label class="je-ta-switch"><input type="checkbox" id="${group === 'rating' ? ratingId : `jeTaScope-${esc(group)}-${scope}`}"${group === 'rating' ? ` data-je-setting-id="${ratingId}" data-je-field="RatingTagsOn${pascal(scope)}"` : ''} data-je-scope-admin="${esc(group)}" data-je-scope="${scope}" ${S.scopeDefault(group, scope, config) ? 'checked' : ''}><span class="je-ta-switch-text"><span class="je-ta-switch-name">${tx(own(SCOPE_LABELS, scope))}</span></span></label>`;
            }).join('')
            + `<p class="je-ta-hint">${tx('Item types apply everywhere, native posters included. The Continue Watching and Next Up rows apply on the web. Collections and other videos always show the group.')}</p></fieldset>`;
    }

    const tabs = all(root, '[role="tab"]');
    const live = must(root, '.je-ta-live');
    const savedChip = must(root, '#jeTaSaved');

    // ── Saving (the edits live in the document-wide store) ──
    let savedHtml = savedChip.innerHTML;
    // A refused or conflicting save stays in view under the sticky tabs once the banner has scrolled away.
    const unsaved = must(root, '[data-je-unsaved]');
    let chipInView = true;
    const drawUnsaved = (): void => {
        const open = (store.state === 'conflict' || store.state === 'error') && !chipInView;
        unsaved.hidden = !open;
        // The sticky preview moves down while the row is shown, so neither covers the other.
        root.classList.toggle('je-ta-unsaved-on', open);
        if (open) must(unsaved, '[data-je-unsaved-text]').textContent = fmt('Unsaved changes: {count}', { count: Math.max(1, store.conflicts.size || store.failed.length || store.values.size) });
    };
    if (typeof IntersectionObserver === 'function') {
        const watch = new IntersectionObserver(([entry]) => { chipInView = !!entry?.isIntersecting; drawUnsaved(); });
        watch.observe(savedChip);
        signal.addEventListener('abort', () => watch.disconnect());
    }
    unsaved.querySelector('[data-je-review]')?.addEventListener('click', () => {
        savedChip.scrollIntoView?.({ block: 'center' });
        (find(savedChip, 'button') || savedChip).focus({ preventScroll: true });
    }, { signal });
    /**
     * Draw the save indicator from the store: saved, saving, or not saved with
     * the fields and Retry. Keyboard focus inside it stays there, on the same
     * button if it is drawn again, else the first one, else the indicator itself.
     */
    const drawSaveState = (): void => {
        const state = store.state;
        queueMicrotask(drawUnsaved);
        savedChip.dataset.state = state;
        const names = (keys: string[]) => Array.from(new Set(keys.map((k) => fieldName(sections, k)))).join(', ');
        let html: string;
        if (state === 'conflict') {
            const keys = Array.from(store.conflicts.keys());
            const first = keys[0];
            // One field: say what each side holds, so Keep mine / Take theirs is an informed choice.
            const one = keys.length === 1 && first !== undefined && store.values.has(first);
            const theirs = one ? valueLabel(first, store.conflicts.get(first)) : '';
            const mine = one ? valueLabel(first, store.values.get(first)) : '';
            // Several: each field with both values, so the bulk choice is still an informed one.
            const pairs = () => keys.map((k) => (store.values.has(k)
                ? fmt('{field} (yours: {mine}, saved elsewhere: {theirs})', { field: fieldName(sections, k), theirs: valueLabel(k, store.conflicts.get(k)), mine: valueLabel(k, store.values.get(k)) })
                : fieldName(sections, k))).join('; ');
            html = `<span>${one
                ? tx('{field} was changed elsewhere to {theirs} (yours: {mine})', { field: fieldName(sections, first), theirs, mine })
                : esc(fmt('Changed elsewhere: {fields}', { fields: pairs() }))}</span>`
                // One field: each button names the value it keeps.
                + `<button type="button" data-je-keep>${one ? tx('Keep {value}', { value: mine }) : tx('Keep mine')}</button>`
                + `<button type="button" data-je-theirs>${one ? tx('Use {value}', { value: theirs }) : tx('Take theirs')}</button>`;
        } else if (state === 'error') {
            const fields = names(store.failed.length ? store.failed : Array.from(store.values.keys()));
            html = `<span>${fields ? tx('Not saved: {fields}', { fields }) : tx('Not saved')}</span><button type="button" data-je-retry>${tx('Retry')}</button>`;
        } else html = `<span class="je-ta-saved-long">${tx(state === 'saving' ? 'Saving…' : 'All changes saved')}</span><span class="je-ta-saved-short" aria-hidden="true">${tx(state === 'saving' ? 'Saving…' : 'Saved')}</span>`;
        if (html === savedHtml) return;
        savedHtml = html;
        const focused = activeElement();
        const inside = !!focused && savedChip.contains(focused);
        const key = inside && focused ? ['data-je-retry', 'data-je-keep', 'data-je-theirs'].find((a) => focused.hasAttribute(a)) : null;
        savedChip.innerHTML = html;
        // The bar floats over the bottom of the window: a field being edited there is scrolled clear of it (focus stays).
        if (state === 'conflict' || state === 'error') requestAnimationFrame(() => {
            const now = activeElement();
            if (!now || !root.contains(now) || savedChip.contains(now)) return;
            const row = now.closest('[data-field-row], .je-ta-field, .je-ta-switch') || now;
            const bar = savedChip.getBoundingClientRect();
            if (!bar.height) return; // not laid out (the bar is hidden, or there is no layout)
            const over = row.getBoundingClientRect().bottom - (bar.top - 16);
            if (over > 0) document.scrollingElement?.scrollBy?.({ top: over, behavior: 'smooth' });
        });
        if (!inside) return;
        const again = (key && find(savedChip, `[${key}]`)) || find(savedChip, 'button');
        (again || savedChip).focus({ preventScroll: true });
    };
    savedChip.addEventListener('click', (e) => {
        const target = targetOf(e);
        if (!target) return;
        if (target.closest('[data-je-retry]')) void flush();
        else if (target.closest('[data-je-keep]')) void saves.resolveConflicts(true);
        else if (target.closest('[data-je-theirs]')) void saves.resolveConflicts(false);
    }, { signal });
    /** Whether everything pending is saved. */
    const flush = (): Promise<boolean> => (!disposed && saves.sameSession(contextMark) ? saves.flush() : Promise.resolve(false));
    /**
     * The store changed state, or a save went through: redraw the indicator;
     * after a save, take the stored values into this view. The preview's styles
     * are fetched again after a Tag Styles save, or when another administrator's values were taken.
     */
    const onStore = (event: StoreEvent): void => {
        if (disposed) return;
        let moved = false;
        if (event.type === 'saved' && event.values) {
            for (const [key, value] of Object.entries(event.values)) {
                const shown = store.values.has(key) && key === 'TagLookItemOverrides' ? store.values.get(key) : value;
                if ((store.values.has(key) && key !== 'TagLookItemOverrides') || sameValue(config[key], shown)) continue;
                // The server stored something else (it normalised the value, or theirs was taken).
                config[key] = copy(shown);
                moved = true;
            }
        }
        if (moved) {
            for (const s of sections) s.load?.(ctx, bodyOf(s));
            refresh();
        }
        if (event.type === 'saved' && (event.theirs || (event.values && Object.keys(event.values).some((key) => key.startsWith('TagStyle'))))) void loadPreviewStyles();
        drawSaveState();
    };
    store.views.add(onStore);

    /** The fields this page may write (the server accepts no others). */
    const owned = deps.pageFields();
    /**
     * Write configuration fields, save them and redraw what depends on them.
     * @param values - Field → value.
     * @param opts - itemEdit captures per-entry intent; otherwise this is a replacement. base: what the server
     *   held for these fields (an import preview's from), compared and sent as Expected instead of this page's copy.
     */
    function setMany(values: Config, opts: SetOptions = {}): void {
        // A late callback of a page that is gone must not save anything.
        if (disposed) return;
        let edited = false;
        for (const [key, raw] of Object.entries(values)) {
            if (!owned.has(key)) {
                // The server refuses it anyway: a section writing an undeclared field is a bug.
                console.error(`🪼 Jellyfin Enhanced: the Media Tags tab does not declare ${key}; not saved`);
                continue;
            }
            // An undefined value is no value: it saves as null, as JSON writes it.
            const value: JsonValue = raw === undefined ? null : raw;
            // Editors hand back whole documents (the layout writes its order, caps and
            // profiles together): a field that did not change is not an edit, so it
            // neither saves nor can conflict with another administrator's change.
            const known = opts.base && Object.prototype.hasOwnProperty.call(opts.base, key) ? opts.base[key] : config[key];
            if (!store.values.has(key) && sameValue(known, value)) continue;
            // What the server should still hold when this edit is saved.
            if (!store.values.has(key) && !store.base.has(key)) store.base.set(key, copy(known));
            if (key === 'TagLookItemOverrides') saves.recordItemEdit(config[key], value, !!opts.itemEdit);
            config[key] = value;
            store.values.set(key, value);
            edited = true;
        }
        if (edited) saves.schedule();
        refresh(opts.redraw === false ? { controls: false } : {});
    }

    // ── Field wiring ──
    const allFields = sections.flatMap((s) => (s.fields || []).map((f) => ({ f, s })));
    const fieldById = new Map(allFields.map(({ f, s }) => [f.id, { f, s }]));

    /** The scope a "Where to show" switch names, when it is one. */
    const scopeOf = (raw: string | undefined) => JE().core.tagScopes?.SCOPE_IDS.find((id) => id === raw);

    /** Push the configuration into every declared control (fields changed elsewhere). */
    function syncControls(): void {
        const S = JE().core.tagScopes;
        allAs(root, '[data-je-scope-admin]', HTMLInputElement).forEach((el) => {
            const scope = scopeOf(el.dataset.jeScope);
            if (el !== document.activeElement && S && scope) el.checked = S.scopeDefault(el.dataset.jeScopeAdmin || '', scope, config);
        });
        for (const { f } of allFields) {
            if (f.type === 'custom') continue;
            const el = find(root, `[data-je-setting-id="${f.id}"]`);
            if (!el || el === document.activeElement) continue;
            const value = fieldValue(f, config);
            if (f.type === 'switch' || f.type === 'enable' || f.type === 'ordered') { if (el instanceof HTMLInputElement) el.checked = !!value; }
            else if (f.type === 'pills') allAs(el, 'input', HTMLInputElement).forEach((r) => { r.checked = r.value === String(value); });
            else if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) el.value = String(value ?? '');
        }
    }

    /** Disable fields whose `when` does not hold; hide those whose `visible` does not. */
    function syncAvailability(): void {
        for (const { f } of allFields) {
            if (f.visible) {
                const row = find(root, `[data-field-row="${f.id}"]`);
                if (row) row.hidden = !f.visible(config);
            }
            if (!f.when) continue;
            const el = root.querySelector(`[data-je-setting-id="${f.id}"]`);
            const row = find(root, `[data-field-row="${f.id}"]`);
            const on = !!f.when(config);
            if (f.hideWhenOff && row) row.hidden = !on;
            if (el) {
                if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) el.disabled = !on;
                else allAs(el, 'input', HTMLInputElement).forEach((i) => { i.disabled = !on; });
            }
        }
    }

    // "Where to show": Rating's switches are fields of their own; the other groups share TagGroupScopes,
    // which keeps only the switches turned off (on is the default).
    root.addEventListener('change', (e) => {
        const input = e.target;
        if (!(input instanceof HTMLInputElement)) return;
        const group = input.dataset.jeScopeAdmin;
        if (!group) return;
        const scope = input.dataset.jeScope || '';
        if (group === 'rating') { setMany({ [`RatingTagsOn${pascal(scope)}`]: input.checked }, { redraw: false }); return; }
        const stored = copy(config.TagGroupScopes || {});
        const scopes: { [key: string]: JsonValue } = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
        const previous = scopes[pascal(group)];
        const set: { [key: string]: JsonValue } = { ...(previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}) };
        if (input.checked) delete set[pascal(scope)]; else set[pascal(scope)] = false;
        if (Object.keys(set).length) scopes[pascal(group)] = set; else delete scopes[pascal(group)];
        setMany({ TagGroupScopes: Object.keys(scopes).length ? scopes : null }, { redraw: false });
    }, { signal });

    root.addEventListener('change', (e) => {
        const target = targetOf(e);
        const holder = target ? target.closest('[data-je-setting-id]') : null;
        const entry = holder instanceof HTMLElement ? fieldById.get(holder.dataset.jeSettingId || '') : undefined;
        if (!holder || !entry || entry.f.type === 'custom') return;
        const value = controlValue(entry.f, holder, config);
        const extra = entry.f.onChange ? entry.f.onChange(value, config) || {} : {};
        setMany({ [entry.f.key]: value, ...extra }, { redraw: false });
        if (entry.f.type === 'number' || entry.f.type === 'text') syncControls();
        if (entry.f.type === 'enable') {
            const row = holder.closest('.je-ta-grow');
            if (row instanceof HTMLElement) row.dataset.enabled = String(value);
        }
    }, { signal });

    // Ordered lists on a phone: reorder mode shows the ranks and order buttons.
    root.addEventListener('click', (e) => {
        const toggle = closest(e, '[data-order-reorder]');
        if (!toggle) return;
        const on = toggle.getAttribute('aria-pressed') !== 'true';
        toggle.setAttribute('aria-pressed', String(on));
        if (toggle.lastElementChild) toggle.lastElementChild.textContent = fmt(on ? 'Finish reordering' : 'Reorder categories');
        toggle.focus({ preventScroll: true });
    }, { signal });

    // Ordered lists: a move swaps two rows and writes every order key by position.
    root.addEventListener('click', (e) => {
        const button = closest(e, '[data-move]');
        if (!button || isDisabled(button)) return;
        const li = button.closest('li[data-ordered]');
        const list = li?.parentElement;
        if (!(li instanceof HTMLElement) || !list) return;
        const dir = Number(button.dataset.move);
        const sibling = dir < 0 ? li.previousElementSibling : li.nextElementSibling;
        if (!sibling) return;
        if (dir < 0) list.insertBefore(li, sibling); else list.insertBefore(sibling, li);
        const values: Config = {};
        Array.from(list.children).forEach((row, i) => {
            const f = row instanceof HTMLElement ? fieldById.get(row.dataset.ordered || '')?.f : undefined;
            if (f?.orderKey) values[f.orderKey] = i + 1;
            const rank = row.querySelector('.je-ta-rank');
            if (rank) rank.textContent = String(i + 1);
            row.querySelector('[data-move="-1"]')?.toggleAttribute('disabled', i === 0);
            row.querySelector('[data-move="1"]')?.toggleAttribute('disabled', i === list.children.length - 1);
        });
        setMany(values, { redraw: false });
        const again = find(li, `[data-move="${dir}"]`);
        focus(again && !isDisabled(again) ? again : li.querySelector('[data-move]:not([disabled])') || li.querySelector('input'));
        announce(fmt('{name} moved to position {n}', { name: li.querySelector('.je-ta-order-name')?.textContent || '', n: Array.from(list.children).indexOf(li) + 1 }));
    }, { signal });

    // ── Tabs ──
    const current = (): string => root.dataset.tab || 'overview';
    /**
     * The save status sits beside the open section's heading; where the page lists the sections as chips (a phone),
     * at the end of that row instead, so it takes no line of its own. A refused save floats as a bar either way.
     */
    const phone = typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 900px)') : null;
    /** Where keyboard focus lands in a section: its heading, or (a section that starts at its first card) that card's title. */
    function focusTarget(id: string): HTMLElement | null {
        const panel = find(root, `#jeTaPanel-${id}`);
        if (!panel) return null;
        const card = panel.dataset.lead === 'card' ? find(panel, '.je-ta-card-title') : null;
        if (card) { card.tabIndex = -1; return card; }
        return find(panel, `#jeTaPanelTitle-${id}`);
    }
    function placeSaved(): void {
        const target = phone?.matches ? root.querySelector('.je-ta-sections') : root.querySelector(`#jeTaPanel-${root.dataset.tab || 'overview'} > .je-ta-panel-head`);
        if (!target || savedChip.parentElement === target) return;
        const hadFocus = savedChip.contains(document.activeElement);
        target.append(savedChip);
        if (hadFocus) (find(savedChip, 'button') || savedChip).focus({ preventScroll: true });
    }
    phone?.addEventListener?.('change', placeSaved, { signal });

    /** Show a tab, optionally a group's panel on the Groups tab. */
    function openTab(id: string, opts: OpenTabOptions = {}): boolean {
        const tab = tabs.find((t) => t.dataset.tab === id);
        if (!tab) return false;
        for (const t of tabs) {
            const on = t === tab;
            t.setAttribute('aria-selected', String(on));
            t.tabIndex = on ? 0 : -1;
            const panel = find(root, `#jeTaPanel-${t.dataset.tab}`);
            if (panel) panel.hidden = !on;
        }
        root.dataset.tab = id;
        try { window.sessionStorage.setItem(deps.tabStoreKey, id); } catch { /* storage unavailable */ }
        for (const s of sections) if (s.tab === id && s.show) s.show(ctx, bodyOf(s));
        if (opts.group) setGroupOpen(opts.group, true, { focus: opts.focus });
        placeSaved();
        if (!opts.group && opts.focus) focusTarget(id)?.focus();
        if (opts.focusTab) tab.focus();
        tab.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        syncSpotlight();
        // The configuration page's sidebar marks the section shown.
        root.dispatchEvent(new CustomEvent('je-media-tags-section', { bubbles: true, detail: { section: id } }));
        return true;
    }
    const tablist = must(root, '[role="tablist"]');
    tablist.addEventListener('click', (e) => {
        const tab = closest(e, '[role="tab"]');
        if (tab) openTab(tab.dataset.tab || 'overview');
    }, { signal });
    // Roving focus with automatic activation (WAI tabs pattern).
    tablist.addEventListener('keydown', (e) => {
        const focused = activeElement();
        const index = focused ? tabs.indexOf(focused) : -1;
        if (index < 0) return;
        let next = -1;
        // In a right-to-left interface the tabs run from the right: ArrowLeft goes to the next one.
        const step = getComputedStyle(tablist).direction === 'rtl' || tablist.closest('[dir]')?.getAttribute('dir') === 'rtl' ? -1 : 1;
        if (e.key === 'ArrowRight') next = (index + step + tabs.length) % tabs.length;
        else if (e.key === 'ArrowLeft') next = (index - step + tabs.length) % tabs.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = tabs.length - 1;
        if (next < 0) return;
        e.preventDefault();
        openTab(tabs[next]?.dataset.tab || 'overview', { focusTab: true });
    }, { signal });
    // Any element with data-je-goto="tab[:group]" opens it.
    root.addEventListener('click', (e) => {
        const goto = closest(e, '[data-je-goto]');
        if (!goto) return;
        e.preventDefault();
        const [tab = '', group] = String(goto.dataset.jeGoto).split(':');
        openTab(tab, { group: group || null, focus: true });
    }, { signal });

    // ── Group rows ──
    /** Open or close a group's panel. */
    function setGroupOpen(group: string, open: boolean, opts: { focus?: boolean | undefined } = {}): void {
        const row = find(root, `.je-ta-grow[data-group="${group}"]`);
        if (!row) {
            // Not a group: a section marked data-je-anchor (e.g. layout:apply, layout:placement-quality).
            let anchor = find(root, `[data-je-anchor="${group}"]`);
            if (anchor && opts.focus) {
                // A collapsed placement row opens first (it is drawn again when it does).
                const opener = find(anchor, '[data-act="open"][aria-expanded="false"]');
                if (opener) { opener.click(); anchor = find(root, `[data-je-anchor="${group}"]`) || anchor; }
                anchor.scrollIntoView?.({ block: 'start' });
                find(anchor, '[data-act="open"], button, input, select')?.focus({ preventScroll: true });
            }
            return;
        }
        const body = must(row, '.je-ta-grow-body');
        const button = must(row, '.je-ta-expand');
        openGroups.set(group, open);
        row.dataset.open = String(open);
        body.hidden = !open;
        button.setAttribute('aria-expanded', String(open));
        const label = button.querySelector('.je-ta-expand-text');
        // "Edit" as on every other group row; the chevron and aria-expanded carry open / closed.
        if (label) label.textContent = fmt('Edit');
        const s = sections.find((x) => x.group?.id === group);
        if (open && s?.show) s.show(ctx, bodyOf(s));
        if (open && opts.focus) {
            row.scrollIntoView?.({ block: 'start' });
            (find(body, 'input, select, textarea, button') || button).focus({ preventScroll: true });
        }
        syncSpotlight();
    }
    root.querySelector('.je-ta-grows')?.addEventListener('click', (e) => {
        const button = closest(e, '.je-ta-expand');
        const row = button?.closest('.je-ta-grow');
        if (row instanceof HTMLElement) setGroupOpen(row.dataset.group || '', button?.getAttribute('aria-expanded') !== 'true');
    }, { signal });

    /** The section's custom-content element. */
    function bodyOf(s: SectionDef): HTMLElement | null {
        return find(root, `[data-section="${s.id}"] .je-ta-section-body`);
    }

    /**
     * One sample chip. `flag` draws a country flag (text is the flag-icons code), `icon` a Material
     * Symbol (text is the icon name); anything else is plain text.
     */
    function sampleChip([kind, value]: SampleChip): string {
        if (kind === 'flag') return `<img class="je-ta-chip je-ta-chip-flag" data-kind="lang" alt="" src="${esc(cdnUrl('flag-icons/flags/4x3/' + value + '.svg'))}">`;
        if (kind === 'icon') return `<span class="je-ta-chip" data-kind="genre"><i class="je-ts-genre-glyph" aria-hidden="true">${esc(value)}</i></span>`;
        return `<span class="je-ta-chip" data-kind="${esc(kind)}">${esc(value)}</span>`;
    }

    /** Rewrite each group row's summary and sample chips. */
    function syncGroupRows(): void {
        for (const s of groupSections) {
            if (!s.group) continue;
            const row = find(root, `.je-ta-grow[data-group="${s.group.id}"]`);
            if (!row) continue;
            const enable = (s.fields || []).find((f) => f.type === 'enable');
            row.dataset.enabled = String(enable ? config[enable.key] === true : true);
            const sum = row.querySelector('.je-ta-grow-sum');
            if (sum) sum.textContent = s.group.summary ? s.group.summary(ctx) : '';
            const sample = row.querySelector('.je-ta-grow-sample');
            if (sample) sample.innerHTML = (s.group.sample ? s.group.sample(ctx) : []).map(sampleChip).join('');
        }
    }

    // ── Preview ──
    const previewBox = must(root, '#jeTaPreview');
    const previewToggle = must(root, '.je-ta-preview-toggle');
    previewToggle.addEventListener('click', () => {
        const open = previewToggle.getAttribute('aria-expanded') !== 'true';
        previewToggle.setAttribute('aria-expanded', String(open));
        previewBox.classList.toggle('je-ta-preview-open', open);
    }, { signal });
    const mount = must(root, '.je-ta-preview-mount');
    const createPreview = settingsUi(JE())?.createTagPreview;
    if (typeof createPreview === 'function') {
        preview = createPreview(mount, { source: () => ({ settings: deps.seedUser(config), plugin: config }) });
        // The preview's explanation and the native poster line join "How looks are chosen", so the samples and that one
        // disclosure fit beside the settings without a second scroll (the preview updates both in place).
        const why = find(root, '.je-ta-preview-why');
        const foot = mount.querySelector('.je-mtp-foot');
        if (why && foot) why.insertBefore(foot, why.querySelector('.je-ta-preview-note'));
        const nativeLine = root.querySelector('#jeTaNative');
        if (why && nativeLine) why.append(nativeLine);
    }
    // Tag Styles: the preview shows the saved server styles (what a new user gets), scoped to it; the
    // signed-in user's page-wide styles leave it alone (tag-styles.js skips marked elements).
    const previewBody = must(root, '#jeTaPreviewBody');
    previewBody.setAttribute(JE().tagStyles?.SCOPE_ATTR || 'data-je-tag-styles-scope', '');
    let stylesSeq = 0;
    /** Fetch the server's effective web Tag Styles (GET tag-styles without a preset: the administrator's) and style the preview with them. */
    async function loadPreviewStyles(): Promise<void> {
        const seq = ++stylesSeq;
        const mark = saves.sessionMark();
        let styles: unknown;
        try {
            const client = apiClient();
            styles = await client.ajax({ type: 'GET', url: client.getUrl('/JellyfinEnhanced/tag-styles'), dataType: 'json' });
        } catch (err) {
            if (!disposed && saves.sameSession(mark)) console.warn('🪼 Jellyfin Enhanced: could not load the Tag Styles for the preview', err);
            return;
        }
        // Another session's styles (a server switch resets the session and disposes this view first).
        if (!saves.sameSession(mark) || disposed || seq !== stylesSeq) return;
        const bridge = JE();
        const build = bridge.tagStyles?.buildCss;
        const css = typeof build === 'function' ? build(styles || {}, '#jeTaPreviewBody') : '';
        if (css) bridge.core.ui.injectCss(deps.previewStyleId, css);
        else bridge.core.ui.removeCss(deps.previewStyleId);
    }
    /** Outline the group being edited in the preview. */
    function syncSpotlight(): void {
        if (!preview) return;
        const open = current() === 'groups' ? Array.from(openGroups.keys()).find((g) => openGroups.get(g)) : null;
        const spot = current() === 'badges' ? 'status' : (open && open !== 'people' ? open : null);
        preview.setSpotlight(spot);
    }
    /** The native poster line under the preview. */
    function syncNative(): void {
        const line = root.querySelector('#jeTaNative');
        if (!line) return;
        const on = config.NativePosterTagsEnabled === true;
        const colours = config.TagStylesEnabled === true && ['native', 'both'].includes(String(config.TagStyleTarget || 'both'));
        // The look new users' native posters get: Corners and Bands as set, the title and hover layouts as Corners
        // with full labels (Shared/MediaTags/PosterTags/PosterTagSettings.cs).
        const names = WORDS.layout;
        const layout = String(config.TagLayout || 'corners').toLowerCase();
        const name = (l: string) => fmt(word(names, l) || word(names, 'corners') || 'Corners');
        const look = ['corners', 'bands'].includes(layout)
            ? fmt('{layout} · {density}', { layout: name(layout), density: fmt(config.TagLabelDensity === 'compact' ? 'Compact' : 'Full') })
            : fmt('{corners} · {full} ({layout} is drawn as {corners})', { corners: name('corners'), full: fmt('Full'), layout: name(layout) });
        line.innerHTML = `<strong>${tx('Native posters:')}</strong> ${on ? tx(colours ? 'on, with your tag colours. Apps such as Android TV get these tags drawn into the poster, as {look}.' : 'on. Apps such as Android TV get these tags drawn into the poster, as {look}.', { look }) : tx('off. Apps such as Android TV show untagged posters.')}`;
    }

    // ── Feedback ──
    /** Said by screen readers (polite). */
    function announce(message: string): void {
        live.textContent = '';
        setTimeout(() => { if (!disposed) live.textContent = message; }, 30);
    }

    /**
     * Ask before a destructive action. A "yes" given after the administrator
     * signed out, another one signed in or the view was torn down is a "no":
     * the action would otherwise run with the next session's credentials.
     */
    async function confirmAction(question: string, title: string): Promise<boolean> {
        const mark = saves.sessionMark();
        const ok = options.confirm ? await options.confirm(question, title) : await deps.askConfirm(question, title);
        return !!ok && !disposed && saves.sameSession(mark);
    }

    /** Where focus goes when each snackbar leaves. */
    const snackOrigins = new WeakMap<Element, () => HTMLElement | null>();

    /**
     * Remove a snackbar (activated, replaced or expired). Keyboard focus in it moves to its origin
     * on the page, else to the tab shown now; focus the user moved elsewhere stays where it is.
     */
    function removeSnack(bar: Element | null): void {
        if (!bar) return;
        const focused = bar.contains(document.activeElement);
        bar.remove();
        if (!focused || disposed) return;
        // The control it came from, else the section's own focus point (the section tabs are hidden on a desktop).
        (snackOrigins.get(bar)?.() || (phone?.matches ? find(root, '[role="tab"][aria-selected="true"]') : focusTarget(root.dataset.tab || 'overview')))?.focus();
    }

    /**
     * A short message at the bottom of the page, with an Undo button when `undo` is given.
     * @param message
     * @param undo
     * @param origin - The control focus goes back to when the bar leaves while it holds focus
     *   (else the control focused when it showed).
     */
    function snack(message: string, undo?: (() => void) | null, origin?: () => Element | null | undefined): void {
        removeSnack(root.querySelector('.je-ta-snack'));
        if (snackTimer !== null) clearTimeout(snackTimer);
        const opener = document.activeElement;
        const bar = document.createElement('div');
        snackOrigins.set(bar, () => {
            for (const el of [origin?.(), opener]) {
                if (el instanceof HTMLElement && el.isConnected && root.contains(el) && !el.closest('[hidden]') && !isDisabled(el)) return el;
            }
            return null;
        });
        bar.className = 'je-ta-snack';
        bar.setAttribute('role', 'status');
        const label = document.createElement('span');
        label.textContent = message;
        bar.appendChild(label);
        if (undo) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'je-ta-button';
            button.textContent = fmt('Undo');
            button.addEventListener('click', () => { removeSnack(bar); undo(); announce(fmt('Undone')); });
            bar.appendChild(button);
        }
        root.appendChild(bar);
        snackTimer = setTimeout(() => removeSnack(bar), undo ? deps.undoMs : 4000);
        announce(message);
    }

    // ── Refresh ──
    /** Redraw everything that depends on the configuration (controls: false keeps the controls as they are). */
    function refresh(opts: { controls?: boolean } = {}): void {
        if (disposed) return;
        if (opts.controls !== false) syncControls();
        syncAvailability();
        syncGroupRows();
        for (const s of sections) if (s.refresh) s.refresh(ctx, bodyOf(s));
        syncNative();
        preview?.refresh();
    }

    /** Tear the page down: the preview and its timers. Pending edits stay in the store. */
    function dispose(): void {
        if (disposed) return;
        disposed = true;
        lifetime.abort();
        store.views.delete(onStore);
        if (snackTimer !== null) clearTimeout(snackTimer);
        preview?.dispose();
        preview = null;
        JE().core.ui.removeCss(deps.previewStyleId);
        for (const s of sections) s.dispose?.(ctx);
    }

    /**
     * Replace the working copy with a fresh configuration (page shown again). Fields with unsaved
     * edits keep the edited values. The preview's styles are fetched again too: Tag Styles may have
     * been saved elsewhere (the main page, another administrator, the API).
     */
    function reload(fresh: Config): void {
        if (disposed) return;
        const keep = saves.protectedFields();
        for (const key of Object.keys(fresh)) if (!keep.has(key)) config[key] = fresh[key];
        // The configuration API omits null values: a page field missing from a
        // full configuration is null on the server (another administrator cleared it).
        for (const key of owned) if (!(key in fresh) && !keep.has(key)) config[key] = null;
        for (const { f } of allFields) if (f.secret && !keep.has(f.key)) delete config[f.key];
        for (const s of sections) s.load?.(ctx, bodyOf(s));
        refresh();
        void loadPreviewStyles();
    }

    const ctx: PageContext = {
        perUserMark,
        root, config, t: fmt, tx, esc,
        set: (key, value) => setMany({ [key]: value }, { itemEdit: true }),
        isCurrent: () => !disposed && saves.sameSession(contextMark),
        setMany, flush, refresh, reload, openTab, setGroupOpen, confirm: confirmAction, snack, announce, dispose,
        pageUrl: deps.pageUrl, mainPageUrl: deps.mainPageUrl,
        /** The tab shown now. */
        currentTab: current,
        /** Whether some change is not saved yet. */
        pending: saves.hasPending,
        /** Whether the page was torn down (late asynchronous answers are dropped). */
        get disposed() { return disposed; },
        /** Aborted when the page is torn down: pass it to listeners on elements that outlive the page. */
        signal,
        get preview() { return preview; },
        layout: JE().core?.tagLayout || null,
        fieldValue,
    };

    for (const s of sections) {
        const body = bodyOf(s);
        if (s.render && body) s.render(ctx, body);
    }
    refresh({ controls: false });
    drawSaveState();
    void loadPreviewStyles();
    let start = options.target || deps.freshTarget();
    if (!start.tab || !TABS.some((t) => t.id === start.tab)) {
        let saved: string | null = null;
        try { saved = window.sessionStorage.getItem(deps.tabStoreKey); } catch { /* storage unavailable */ }
        start = { tab: TABS.some((t) => t.id === saved) ? saved : 'overview', group: null };
    }
    openTab(start.tab || 'overview', { group: start.group });
    return ctx;
}

