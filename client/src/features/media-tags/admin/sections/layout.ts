/**
 * @file Media Tags admin tab, Layout defaults tab: the layout and label
 * density new users start with, each group's priority order, limit and
 * position (nine anchors for corners, the layout's slots otherwise), the
 * looks of episode thumbnails and list rows, and two display switches.
 *
 * Writes the same fields the main configuration page wrote: TagLayout,
 * TagLabelDensity, TagGroupOrder (only once reordered), TagGroupCaps and
 * TagLayouts (explicit values only, so new users keep inheriting the
 * built-in ones), the *TagsPosition settings (the corners profile is the
 * position settings; TagLayouts.Corners only stores "Hidden") and
 * TagShapeOverrides. The layout vocabulary comes from core/tag-layout.js.
 */
/*! Lexical index of this module's declarations, in the order Shared/MediaTags/MediaTagsPageFields.cs (the field
 *  patch's allowlist), Features/Admin/Services/WhatsNewService.cs and scripts/generate_config_flag_groups.py read them
 *  from the generated file. Not code: tests/frontend/features/media-tags/admin/admin-tags-rewrite.test.mjs keeps it equal
 *  to the sections this module registers and to what those readers found in the JavaScript module.
registerSection({
    tab: 'layout',
    title: 'Default look',
        { id: 'tagLayout', key: 'TagLayout', type: 'custom', label: 'Default layout' },
        { id: 'tagLabelDensity', key: 'TagLabelDensity', type: 'pills', label: 'Label density' },
        { id: 'tagScale', key: 'TagScale', type: 'pills', label: 'Tag size' },
        { id: 'tagGap', key: 'TagGap', type: 'pills', label: 'Gap' },
        { id: 'tagEdgeSpacing', key: 'TagEdgeSpacing', type: 'pills', label: 'Edge spacing' },
    tab: 'layout',
    title: 'Group placement',
    writes: ['TagLayouts', 'TagGroupOrder', 'TagGroupCaps'],
        { id: 'qualityTagsPosition', key: 'QualityTagsPosition', type: 'custom', label: 'Quality position' },
        { id: 'genreTagsPosition', key: 'GenreTagsPosition', type: 'custom', label: 'Genre position' },
        { id: 'languageTagsPosition', key: 'LanguageTagsPosition', type: 'custom', label: 'Language position' },
        { id: 'ratingTagsPosition', key: 'RatingTagsPosition', type: 'custom', label: 'Rating position' },
        { id: 'ageRatingTagsPosition', key: 'AgeRatingTagsPosition', type: 'custom', label: 'Age rating position' },
        { id: 'statusTagsPosition', key: 'StatusTagsPosition', type: 'custom', label: 'Status position' },
        { id: 'awardsTagsPosition', key: 'AwardsTagsPosition', type: 'custom', label: 'Awards position' },
        { id: 'logoTagsPosition', key: 'LogoTagsPosition', type: 'custom', label: 'Logos position' },
        { id: 'customTagsPosition', key: 'CustomTagsPosition', type: 'custom', label: 'Custom position' },
registerSection({
registerSection({
    tab: 'layout',
    title: 'Card shapes',
        { id: 'tagShapeLandscapeDefault', key: 'TagShapeOverrides', type: 'custom', label: 'Episode thumbnails' },
        { id: 'tagShapeListDefault', key: 'TagShapeOverrides', type: 'custom', label: 'List rows' },
registerSection({
    tab: 'layout',
    title: 'Display',
        { id: 'tagsHideOnHover', key: 'TagsHideOnHover', type: 'switch', label: 'Hide tags on hover' },
        { id: 'disableTagsOnSearchPage', key: 'DisableTagsOnSearchPage', type: 'switch', label: 'No tags on the search page' },
*/
import type { JsonValue } from '../../../../contracts/generated';
import { settingsUi, type AdminTagLayout } from '../host';
import type { Group, Layout, Shape } from '../../layout/layout-rules';
import { allAs, closest, find, findAs, focus, isDisabled } from '../dom';
import { word } from '../format';
import type { PageContext, SectionDef } from '../types';
import { list, own, pick, type Config, type JsonObject } from '../values';
import { installSection } from './install';

const LAYOUTS: readonly Layout[] = ['corners', 'bands', 'caption', 'summary', 'minimal'];
/** The nine corner anchors, row by row (slot ids of core/tag-layout.js). */
const ANCHORS = ['tl', 'tc', 'tr', 'ml', 'c', 'mr', 'bl', 'bc', 'br'];
const pascal = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const layoutOf = (value: string): Layout | undefined => LAYOUTS.find((l) => l === value);

/** The administrator's explicit layout defaults. */
interface LayoutState {
    layout: Layout;
    order: Group[] | null;
    caps: Partial<Record<Group, number>>;
    profiles: Record<Layout, Partial<Record<Group, string>>>;
}

/**
 * Card shape defaults: each shape keeps the default look, takes the
 * recommended look, or keeps a custom look saved elsewhere untouched.
 */
const SHAPE_FIELDS: ReadonlyArray<readonly [Shape, string]> = [['landscape', 'tagShapeLandscapeDefault'], ['list', 'tagShapeListDefault']];

installSection((A, JE) => {
    /** The layout controller (core/tag-layout.js loads before this tab). */
    const L = (): AdminTagLayout => {
        const layout = JE.core.tagLayout;
        if (!layout) throw new TypeError('core/tag-layout.js must load before the Media Tags tab');
        return layout;
    };
    /** The settings panel editor's cap rules (stepCap, GROUP_META). */
    const editorData = () => settingsUi(JE)?.tagGroupEditorData || null;
    const groupName = (g: string): string => A.fmt(word(A.WORDS.group, `${g === 'ageRating' ? 'age_rating' : g}`));
    /** The group's enable setting. */
    const enabledKey = (g: string): string => `${g === 'logos' ? 'Logo' : pascal(g)}TagsEnabled`;
    const slotWord = (layout: string, slot: string): string => A.fmt(slot === 'off' ? 'Hidden' : word(A.WORDS.slot, `${layout}_${slot}`));

    /** The administrator's explicit layout defaults, read from the configuration. */
    function readState(c: Config): LayoutState {
        const layout = layoutOf(String(c.TagLayout || '').toLowerCase()) || 'corners';
        const groups = L().DEFAULT_ORDER;
        let order: Group[] | null = null;
        if (Array.isArray(c.TagGroupOrder)) {
            const seen: Group[] = [];
            for (const g of c.TagGroupOrder) { const id = L().normalizeGroup(g); if (id && !seen.includes(id)) seen.push(id); }
            if (seen.length) order = seen.concat(groups.filter((g) => !seen.includes(g)));
        }
        const caps: Partial<Record<Group, number>> = {};
        for (const g of groups) {
            const raw = pick(c.TagGroupCaps, g);
            const n = Number(raw);
            if (raw !== undefined && Number.isFinite(n)) caps[g] = Math.max(0, Math.min(L().MAX_CAP, Math.round(n)));
        }
        const profiles: Record<Layout, Partial<Record<Group, string>>> = { corners: {}, bands: {}, caption: {}, summary: {}, minimal: {} };
        for (const name of LAYOUTS) {
            const profile: Partial<Record<Group, string>> = {};
            const entries = pick(pick(c.TagLayouts, name), 'groups');
            for (const entry of list(entries)) {
                const g = L().normalizeGroup(pick(entry, 'group'));
                const slot = String(pick(entry, 'slot') || '').toLowerCase();
                if (!g || profile[g] || !L().LAYOUT_SLOTS[name].includes(slot) || (slot === 'dots' && g !== 'quality')) continue;
                // Corners keeps only "Hidden"; corner picks live in the position settings.
                if (name === 'corners' && slot !== 'off') continue;
                profile[g] = slot;
            }
            profiles[name] = profile;
        }
        return { layout, order, caps, profiles };
    }

    /** The configuration fields for a state (null where nothing is explicit). */
    function writeState(state: LayoutState): { TagGroupOrder: JsonValue; TagGroupCaps: JsonValue; TagLayouts: JsonValue } {
        const caps: JsonObject = {};
        for (const [g, n] of Object.entries(state.caps)) if (n !== undefined) caps[pascal(g)] = n;
        const layouts: JsonObject = {};
        let anyProfile = false;
        for (const name of LAYOUTS) {
            const groups = Object.entries(state.profiles[name]).filter((e): e is [string, string] => e[1] !== undefined).map(([g, slot]) => ({ Group: g, Slot: slot }));
            layouts[pascal(name)] = groups.length ? { Groups: groups } : null;
            if (groups.length) anyProfile = true;
        }
        return {
            TagGroupOrder: state.order ? state.order.slice() : null,
            TagGroupCaps: Object.keys(caps).length ? caps : null,
            TagLayouts: anyProfile ? layouts : null,
        };
    }

    /** The slot a group shows in a layout: explicit pick, else the position setting (corners) or the built-in profile. */
    function slotOf(c: Config, state: LayoutState, name: Layout, g: Group): string {
        const picked = state.profiles[name][g];
        if (picked) return picked;
        if (name === 'corners') return own(L().POSITION_TO_SLOT, String(c[L().POSITION_SETTINGS[g].pluginKey])) || 'tl';
        return L().DEFAULT_PROFILES[name][g] || '';
    }

    /** The limit a group shows. */
    function capOf(g: Group, state: LayoutState, config: Config): number {
        if (L().singleChipGroup(g, config)) return 1;
        const cap = state.caps[g];
        return cap !== undefined && Number.isFinite(cap) ? cap : L().DEFAULT_CAPS[g];
    }

    /** Per page view: the group row whose controls are open. */
    const openGroups = new WeakMap<PageContext, string | null>();

    /** The link from a placement row to the group's own settings on the Groups tab. */
    const groupSettingsLink = (ctx: PageContext, g: string, name: string): string =>
        `<a class="je-ta-link je-ta-crosslink" href="#" data-je-goto="groups:${g}"><span class="je-ta-link-text">${ctx.esc(A.fmt('{group} settings (Groups)', { group: name }))}</span><span class="material-icons" aria-hidden="true">arrow_forward</span></a>`;

    /** One group row: move buttons, name, limit stepper and position control. */
    function rowHtml(ctx: PageContext, state: LayoutState, g: Group, index: number, count: number): string {
        const c = ctx.config;
        const name = groupName(g);
        const data = editorData();
        const meta = data?.GROUP_META[g] || {};
        const stepCap = data ? data.stepCap : () => null;
        const cap = capOf(g, state, c);
        const slot = slotOf(c, state, state.layout, g);
        const off = c[enabledKey(g)] !== true;
        let slots: string;
        if (state.layout === 'corners') {
            const anchors = ANCHORS.map((a) => {
                const label = A.fmt(word(A.WORDS.slot, `corners_${a}`));
                return `<button type="button" class="je-ta-anchor" data-slot="${a}" aria-pressed="${slot === a}" tabindex="${slot === a ? 0 : -1}" aria-label="${ctx.esc(A.fmt('{group}: {slot}', { group: name, slot: label }))}">${ctx.esc(label)}</button>`;
            }).join('');
            // The nine positions by name, as on the hub and in the item editor; Hidden spans the row under them.
            slots = `<span class="je-ta-anchors" role="group" id="${L().POSITION_SETTINGS[g].userKey}" aria-label="${ctx.esc(A.fmt('{group} position', { group: name }))}">${anchors}`
                + `<button type="button" class="je-ta-pill je-ta-anchor-off" data-slot="off" aria-pressed="${slot === 'off'}" tabindex="${slot === 'off' ? 0 : -1}">${ctx.tx('Hidden')}</button></span>`;
        } else {
            slots = `<span class="je-ta-pills" role="group" aria-label="${ctx.esc(A.fmt('{group} position', { group: name }))}">${L().LAYOUT_SLOTS[state.layout].filter((s) => s !== 'dots' || g === 'quality').map((s) => {
                const label = slotWord(state.layout, s);
                return `<button type="button" class="je-ta-pill" data-slot="${s}" aria-pressed="${slot === s}">${ctx.esc(label)}</button>`;
            }).join('')}</span>`;
        }
        const fixed = L().singleChipGroup(g, c);
        const where = slotWord(state.layout, slot);
        const capText = cap === 0 ? A.fmt('All') : String(cap);
        const summary = slot === 'off' || fixed ? where : A.fmt(cap === 0 ? '{where} · all tags' : '{where} · up to {cap}', { where, cap: capText });
        // Collapsed, a row says where the group goes and its limit; one row's controls open at a time.
        const open = openGroups.get(ctx) === g;
        return `<li class="je-ta-lrow" data-group="${g}" data-off="${off}" data-open="${open}" data-je-anchor="placement-${g}">
            <span class="je-ta-lrow-move">
                <button type="button" class="je-ta-icon-btn" data-act="move" data-dir="-1" aria-label="${ctx.esc(A.fmt('Move {name} up', { name }))}" ${index === 0 ? 'disabled' : ''}><span class="material-icons" aria-hidden="true">arrow_upward</span></button>
                <button type="button" class="je-ta-icon-btn" data-act="move" data-dir="1" aria-label="${ctx.esc(A.fmt('Move {name} down', { name }))}" ${index === count - 1 ? 'disabled' : ''}><span class="material-icons" aria-hidden="true">arrow_downward</span></button>
            </span>
            <span class="je-ta-lrow-name">${ctx.esc(name)}${off ? `<small>${ctx.tx('Off for new users')}</small>` : ''}</span>
            <span class="je-ta-lrow-sum">${ctx.esc(summary)}</span>
            <button type="button" class="je-ta-button je-ta-lrow-open" data-act="open" data-dir="0" aria-expanded="${open}" aria-controls="jeTaLrow-${g}" aria-label="${ctx.esc(A.fmt('Edit {group} position and limit', { group: name }))}">${ctx.tx('Edit')}<span class="material-icons" aria-hidden="true">expand_more</span></button>
            <span class="je-ta-lrow-detail" id="jeTaLrow-${g}" ${open ? '' : 'hidden'}>
            <span class="je-ta-lrow-slots">${slots}</span>
            ${fixed ? '' : `<span class="je-ta-lrow-cap" role="group" aria-label="${ctx.esc(A.fmt('{group} limit', { group: name }))}">${ctx.tx('Show up to')}
                <button type="button" class="je-ta-icon-btn" data-act="cap" data-dir="-1" aria-label="${ctx.esc(A.fmt('Fewer {group} tags', { group: name }))}" ${stepCap(cap, -1, meta) === null ? 'disabled' : ''}><span class="material-icons" aria-hidden="true">remove</span></button>
                <output aria-live="polite">${cap === 0 ? ctx.tx('All') : cap}</output>
                <button type="button" class="je-ta-icon-btn" data-act="cap" data-dir="1" aria-label="${ctx.esc(A.fmt('More {group} tags', { group: name }))}" ${stepCap(cap, 1, meta) === null ? 'disabled' : ''}><span class="material-icons" aria-hidden="true">add</span></button>
            </span>`}
            ${groupSettingsLink(ctx, g, name)}
            </span>
        </li>`;
    }

    A.registerSection({
        id: 'layout-look',
        tab: 'layout',
        order: 10,
        title: 'Default look',
        hint: 'Where the tags sit on a poster, and how long their labels are.',
        fields: [
            { id: 'tagLayout', key: 'TagLayout', type: 'custom', label: 'Default layout' },
            { id: 'tagLabelDensity', key: 'TagLabelDensity', type: 'pills', label: 'Label density', desc: 'Compact shortens quality labels (DV, Atmos) and hides the critic score next to a community score.', options: [['full', 'Full'], ['compact', 'Compact']], read: (v) => (String(v || '').toLowerCase() === 'compact' ? 'compact' : 'full') },
            // Size, gap and edge as the hub shows them: a row of choices with its help line.
            { id: 'tagScale', key: 'TagScale', type: 'pills', label: 'Tag size', desc: 'Scale tag text, icons and padding on web and native posters.', options: [['smaller', '=85%'], ['default', '=100%'], ['larger', '=115%'], ['largest', '=130%']] },
            { id: 'tagGap', key: 'TagGap', type: 'pills', label: 'Gap', desc: 'Adjust spacing between tags in stacks, rows, bands and captions.', options: [['tight', '=Tight'], ['default', '=Default'], ['roomy', '=Roomy']] },
            { id: 'tagEdgeSpacing', key: 'TagEdgeSpacing', type: 'pills', label: 'Edge spacing', desc: 'How close the Corners layout puts tags to the poster edge. Flush tags touch the edge and follow the poster\'s rounded corners.', options: [['default', '=Default'], ['tight', '=Tight'], ['flush', '=Flush']] },
        ],
        render(ctx, body) {
            const card = body.closest('.je-ta-card');
            const tiles = document.createElement('div');
            tiles.innerHTML = `<span class="je-ta-label" id="tagLayoutLabel">${ctx.tx('Default layout')}</span>
                <div class="je-ta-tiles" role="radiogroup" id="tagLayout" data-je-setting-id="tagLayout" aria-labelledby="tagLayoutLabel" aria-describedby="tagLayoutDesc">${LAYOUTS.map((id) => `
                    <label class="je-ta-tile"><input type="radio" name="jeTaLayout" value="${id}"><span class="je-ta-tile-art" data-layout="${id}" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span class="je-ta-tile-name">${ctx.tx(word(A.WORDS.layout, id))}</span></label>`).join('')}</div>
                <p class="je-ta-hint" id="tagLayoutDesc" aria-live="polite" style="margin-top:8px"></p>`;
            card?.querySelector('.je-ta-hint')?.after(tiles);
            tiles.addEventListener('change', (e) => {
                const input = e.target;
                if (input instanceof HTMLInputElement && input.name === 'jeTaLayout') ctx.set('TagLayout', input.value);
            });
        },
        refresh(ctx) {
            const layout = readState(ctx.config).layout;
            allAs(ctx.root, 'input[name="jeTaLayout"]', HTMLInputElement).forEach((r) => { r.checked = r.value === layout; });
            const desc = ctx.root.querySelector('#tagLayoutDesc');
            if (desc) desc.textContent = word(A.WORDS.layoutName, layout) ?? '';
        },
    });

    /** The selector of a focused group row control, to focus it again after a redraw. */
    function focusSelector(el: HTMLElement): string | null {
        const row = el.closest('.je-ta-lrow');
        const g = row instanceof HTMLElement ? row.dataset.group : undefined;
        if (!g) return null;
        const ownSelector = el.dataset.slot ? `[data-slot="${el.dataset.slot}"]` : el.dataset.act ? `[data-act="${el.dataset.act}"][data-dir="${el.dataset.dir}"]` : null;
        return ownSelector && `.je-ta-lrow[data-group="${g}"] ${ownSelector}`;
    }

    const groupsSection: SectionDef = {
        id: 'layout-groups',
        tab: 'layout',
        order: 20,
        title: 'Group placement',
        hint: 'Higher groups win when space is short and stack nearest the edge. The limit is how many chips a group shows.',
        writes: ['TagLayouts', 'TagGroupOrder', 'TagGroupCaps'],
        fields: [
            { id: 'qualityTagsPosition', key: 'QualityTagsPosition', type: 'custom', label: 'Quality position' },
            { id: 'genreTagsPosition', key: 'GenreTagsPosition', type: 'custom', label: 'Genre position' },
            { id: 'languageTagsPosition', key: 'LanguageTagsPosition', type: 'custom', label: 'Language position' },
            { id: 'ratingTagsPosition', key: 'RatingTagsPosition', type: 'custom', label: 'Rating position' },
            { id: 'ageRatingTagsPosition', key: 'AgeRatingTagsPosition', type: 'custom', label: 'Age rating position' },
            { id: 'statusTagsPosition', key: 'StatusTagsPosition', type: 'custom', label: 'Status position' },
            { id: 'awardsTagsPosition', key: 'AwardsTagsPosition', type: 'custom', label: 'Awards position' },
            { id: 'logoTagsPosition', key: 'LogoTagsPosition', type: 'custom', label: 'Logos position' },
            { id: 'customTagsPosition', key: 'CustomTagsPosition', type: 'custom', label: 'Custom position' },
        ],
        render(ctx, body) {
            body.innerHTML = `<p class="je-ta-hint" data-layout-note></p><button type="button" class="je-ta-button je-ta-reorder" data-reorder aria-pressed="false"><span class="material-icons" aria-hidden="true">swap_vert</span><span>${ctx.tx('Reorder groups')}</span></button><ol class="je-ta-lrows" id="tagGroupAdminRows"></ol>`;
            // Phone: the order buttons show only in reorder mode.
            const reorder = find(body, '[data-reorder]');
            reorder?.addEventListener('click', () => {
                const on = !body.classList.contains('je-ta-reordering');
                body.classList.toggle('je-ta-reordering', on);
                reorder.setAttribute('aria-pressed', String(on));
                if (reorder.lastElementChild) reorder.lastElementChild.textContent = A.fmt(on ? 'Finish reordering' : 'Reorder groups');
            });
            // One Tab stop per position picker; arrow keys, Home and End move along it (Enter or Space picks).
            body.addEventListener('keydown', (e) => {
                const cell = closest(e, '.je-ta-anchors [data-slot]');
                if (!cell || e.altKey || e.ctrlKey || e.metaKey) return;
                const cells = allAs(cell.closest('.je-ta-anchors'), '[data-slot]', HTMLElement);
                const at = cells.indexOf(cell);
                const step = own<number>({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 }, e.key);
                const next = step ? cells[Math.min(cells.length - 1, Math.max(0, at + step))] : e.key === 'Home' ? cells[0] : e.key === 'End' ? cells[cells.length - 1] : null;
                if (!next) return;
                e.preventDefault();
                cells.forEach((c) => { c.tabIndex = c === next ? 0 : -1; });
                next.focus();
            });
            body.addEventListener('click', (e) => {
                const button = closest(e, 'button');
                const row = button?.closest('.je-ta-lrow');
                if (!button || !(row instanceof HTMLElement) || isDisabled(button)) return;
                const g = L().normalizeGroup(row.dataset.group || '');
                if (!g) return;
                const c = ctx.config;
                const state = readState(c);
                const values: Config = {};
                let keep = '';
                if (button.dataset.act === 'open') {
                    openGroups.set(ctx, openGroups.get(ctx) === g ? null : g);
                    groupsSection.refresh?.(ctx, body);
                    find(ctx.root, `#tagGroupAdminRows .je-ta-lrow[data-group="${g}"] [data-act="open"]`)?.focus();
                    return;
                }
                if (button.dataset.act === 'move') {
                    const order = state.order ? state.order.slice() : L().DEFAULT_ORDER.slice();
                    const from = order.indexOf(g);
                    const to = from + Number(button.dataset.dir);
                    if (to < 0 || to >= order.length) return;
                    order.splice(to, 0, ...order.splice(from, 1));
                    state.order = order;
                    keep = `[data-act="move"][data-dir="${button.dataset.dir}"]`;
                    ctx.announce(A.fmt('{name} moved to position {n}', { name: groupName(g), n: to + 1 }));
                } else if (button.dataset.act === 'cap') {
                    const data = editorData();
                    const next = data?.stepCap(capOf(g, state, ctx.config), Number(button.dataset.dir), data.GROUP_META[g] || {});
                    if (next === null || next === undefined) return;
                    state.caps[g] = next;
                    keep = `[data-act="cap"][data-dir="${button.dataset.dir}"]`;
                    // The redrawn row's <output> arrives already filled, which screen readers do not read out.
                    ctx.announce(A.fmt('{group} limit: {n}', { group: groupName(g), n: next === 0 ? A.fmt('all tags') : next }));
                } else if (button.dataset.slot) {
                    const slot = button.dataset.slot;
                    if (state.layout === 'corners') {
                        if (slot === 'off') state.profiles.corners[g] = 'off';
                        else {
                            delete state.profiles.corners[g];
                            values[L().POSITION_SETTINGS[g].pluginKey] = own(L().SLOT_TO_POSITION, slot) ?? null;
                        }
                    } else {
                        state.profiles[state.layout][g] = slot;
                    }
                    keep = `[data-slot="${slot}"]`;
                } else return;
                // Only what this click changed: the stored order, caps and profiles come in the
                // server's own shape ([] for no order, members omitted, its key order), which
                // never matches writeState's text, so an untouched one would be resent and could
                // conflict with (and on Keep mine undo) another administrator's change.
                const before = writeState(readState(c));
                const after = writeState(state);
                for (const key of ['TagGroupOrder', 'TagGroupCaps', 'TagLayouts'] as const) if (JSON.stringify(after[key]) !== JSON.stringify(before[key])) values[key] = after[key];
                if (!Object.keys(values).length) return;
                ctx.setMany(values);
                // Keep keyboard focus on the same control of the (redrawn) row.
                const again = find(ctx.root, `#tagGroupAdminRows .je-ta-lrow[data-group="${g}"] ${keep}`);
                const fallback = ctx.root.querySelector(`#tagGroupAdminRows .je-ta-lrow[data-group="${g}"] button:not([disabled])`);
                focus(again && !isDisabled(again) ? again : fallback);
            });
        },
        refresh(ctx, body) {
            const rows = find(body, '#tagGroupAdminRows');
            if (!rows || !body) return;
            const state = readState(ctx.config);
            const order = state.order || L().DEFAULT_ORDER;
            A.redrawList(rows, order.map((g, i) => rowHtml(ctx, state, g, i, order.length)).join(''), focusSelector);
            const note = body.querySelector('[data-layout-note]');
            if (note) note.textContent = A.fmt('Positions for the {layout} layout. Pick another layout above to set its positions.', { layout: A.fmt(word(A.WORDS.layout, state.layout)) });
        },
    };
    A.registerSection(groupsSection);

    /** A recommended look in the server's wire form (PascalCase objects, camelCase array items), as the main page wrote it. */
    function recommendedWire(shape: Shape): JsonObject {
        const look = L().RECOMMENDED_SHAPES[shape];
        const caps: JsonObject | null = look.caps ? Object.fromEntries(Object.entries(look.caps).map(([g, n]) => [pascal(g), n])) : null;
        return { Layout: look.layout, Density: look.density, Slots: Object.entries(look.slots).map(([group, slot]) => ({ group, slot })), Caps: caps };
    }

    /** Whether a stored look is exactly the recommended one. */
    function isRecommended(shape: Shape, look: JsonValue): boolean {
        const want = L().readShapeOverrides({ [shape]: L().RECOMMENDED_SHAPES[shape] })[shape];
        const have = L().readShapeOverrides({ [shape]: look })[shape];
        return JSON.stringify(want) === JSON.stringify(have);
    }

    /** Which choice a shape shows: inherit, recommended or custom. */
    function shapeChoice(c: Config, shape: Shape): 'inherit' | 'recommended' | 'custom' {
        const look = pick(c.TagShapeOverrides, shape) || null;
        return !look ? 'inherit' : (isRecommended(shape, look) ? 'recommended' : 'custom');
    }

    A.registerSection({
        id: 'layout-shapes',
        tab: 'layout',
        order: 30,
        title: 'Card shapes',
        hint: 'Episode thumbnails and list rows have less room than a poster: give them their own look or keep the default one. Native Poster Tags draw on posters only and ignore these.',
        fields: [
            { id: 'tagShapeLandscapeDefault', key: 'TagShapeOverrides', type: 'custom', label: 'Episode thumbnails' },
            { id: 'tagShapeListDefault', key: 'TagShapeOverrides', type: 'custom', label: 'List rows' },
        ],
        render(ctx, body) {
            body.innerHTML = `<div class="je-ta-fields">${SHAPE_FIELDS.map(([shape, id]) => `
                <div class="je-ta-field"><span class="je-ta-switch-text"><label class="je-ta-switch-name" for="${id}">${ctx.tx(word(A.WORDS.shape, shape))}</label></span>
                <span class="je-ta-field-control"><select id="${id}" data-shape="${shape}">
                    <option value="inherit">${ctx.tx('Same look as posters')}</option>
                    <option value="recommended">${ctx.tx(word(A.WORDS.shapeRecommended, shape))}</option>
                    <option value="custom">${ctx.tx('Custom (kept as saved)')}</option>
                </select></span></div>`).join('')}</div>`;
            body.addEventListener('change', (e) => {
                const select = e.target;
                if (!(select instanceof HTMLSelectElement)) return;
                const shape = SHAPE_FIELDS.find(([s]) => s === select.dataset.shape)?.[0];
                if (!shape) return;
                const out: JsonObject = {};
                for (const [s] of SHAPE_FIELDS) {
                    const choice = s === shape ? select.value : shapeChoice(ctx.config, s);
                    out[pascal(s)] = choice === 'recommended' ? recommendedWire(s) : choice === 'custom' ? (pick(ctx.config.TagShapeOverrides, s) || null) : null;
                }
                ctx.set('TagShapeOverrides', Object.values(out).some(Boolean) ? out : null);
            });
        },
        refresh(ctx, body) {
            for (const [shape, id] of SHAPE_FIELDS) {
                const select = findAs(body, `#${id}`, HTMLSelectElement);
                if (!select) continue;
                const choice = shapeChoice(ctx.config, shape);
                const custom = findAs(select, 'option[value="custom"]', HTMLOptionElement);
                if (custom) {
                    custom.hidden = choice !== 'custom';
                    custom.disabled = choice !== 'custom';
                }
                if (document.activeElement !== select) select.value = choice;
            }
        },
    });

    A.registerSection({
        id: 'layout-display',
        tab: 'layout',
        order: 40,
        title: 'Display',
        fields: [
            { id: 'tagsHideOnHover', key: 'TagsHideOnHover', type: 'switch', label: 'Hide tags on hover', desc: 'Tags fade out while the pointer is over a card. Users can change this.' },
            { id: 'disableTagsOnSearchPage', key: 'DisableTagsOnSearchPage', type: 'switch', label: 'No tags on the search page', desc: 'Keeps quality, language, genre and rating tags off search results. Recommended with the Gelato plugin.' },
        ],
    });

    // Exposed for tests.
    A.layoutData = { readState, writeState, slotOf, capOf, shapeChoice, recommendedWire };
});
