/**
 * @file Media Tags admin tab, Colours tab: Tag Styles on or off, where the
 * colours apply, whether users may pick their own preset, and the full
 * colour editor (tag-styles-editor.js) with Reset all colours (undoable).
 * Saves TagStyleOverrides and TagStylePreset whenever the editor's document changes. Each tag in the
 * editor's tag list can also be hidden (Hidden tags): TagHiddenValues, which applies whether tag colours are on or not,
 * and the tags that draw plain words can show other words (Tag text): TagTextOverrides.
 */
/*! Lexical index of this module's declarations, in the order Shared/MediaTags/MediaTagsPageFields.cs (the field
 *  patch's allowlist), Features/Admin/Services/WhatsNewService.cs and scripts/generate_config_flag_groups.py read them
 *  from the generated file. Not code: tests/frontend/features/media-tags/admin/admin-tags-rewrite.test.mjs keeps it equal
 *  to the sections this module registers and to what those readers found in the JavaScript module.
registerSection({
    tab: 'colours',
    title: 'Tag colours and text',
    writes: ['TagStyleOverrides', 'TagStylePreset', 'TagHiddenValues', 'TagTextOverrides'],
        { id: 'tagStylesEnabled', key: 'TagStylesEnabled', type: 'switch', label: 'Use tag colours' },
        { id: 'tagStyleTarget', key: 'TagStyleTarget', type: 'pills', label: 'Apply to' },
        { id: 'tagStylesAllowUserPreset', key: 'TagStylesAllowUserPreset', type: 'switch', label: 'Let users pick their own preset' },
*/
import { find, findAs } from '../dom';
import { word } from '../format';
import type { HiddenStore, PageContext, TagStylesEditor, TextStore } from '../types';
import { installSection } from './install';

// Every group's renderer, to redraw its tags after the hidden lists changed.
const RENDERERS = ['quality', 'genre', 'rating', 'agerating', 'status', 'language', 'awards', 'logos', 'custom'];

// The groups whose chips take a text: their renderers redraw after a text changed.
const TEXT_RENDERERS = ['quality', 'genre', 'status', 'awards'];

/** A stored TagTextOverrides as { group: { label: text } }; an unreadable document reads as none. */
function textDoc(value: unknown): Record<string, Record<string, string>> {
    const doc: Record<string, Record<string, string>> = {};
    let parsed: unknown = null;
    try { parsed = typeof value === 'string' && value ? JSON.parse(value) : null; } catch { return doc; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return doc;
    for (const [group, labels] of Object.entries(parsed)) {
        if (!labels || typeof labels !== 'object' || Array.isArray(labels)) continue;
        const texts: Record<string, string> = {};
        for (const [label, text] of Object.entries(labels)) if (typeof text === 'string') texts[label] = text;
        doc[group] = texts;
    }
    return doc;
}

/** A stored TagHiddenValues as the document the editor hands over (lists of labels per group), or null. */
function hiddenDoc(value: unknown): Record<string, string[]> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const doc: Record<string, string[]> = {};
    for (const [group, list] of Object.entries(value)) if (Array.isArray(list)) doc[group] = list.map(String);
    return doc;
}

installSection((A, JE) => {
    let editor: TagStylesEditor | null = null;
    let last = '';

    /** Load the stored document into the editor (first draw and page shown again). */
    function load(ctx: PageContext): void {
        if (!editor) return;
        editor.load(ctx.config.TagStyleOverrides, ctx.config.TagStylePreset);
        last = editor.snapshot();
    }

    A.registerSection({
        id: 'colours',
        tab: 'colours',
        order: 10,
        title: 'Tag colours and text',
        hint: 'Colours for quality, age rating, rating, genre, status, language, awards, logo and custom tags, and the words of quality, genre, status and awards tags.',
        writes: ['TagStyleOverrides', 'TagStylePreset', 'TagHiddenValues', 'TagTextOverrides'],
        fields: [
            { id: 'tagStylesEnabled', key: 'TagStylesEnabled', type: 'switch', label: 'Use tag colours', desc: 'Off shows the original colours (custom CSS keeps working). Your edits are kept. Hidden tags apply either way.', master: true },
            { id: 'tagStyleTarget', key: 'TagStyleTarget', type: 'pills', label: 'Apply to', desc: 'Web recolours the overlays and wins over custom CSS colours. Native posters draws the colours into the posters of apps such as Android TV (needs Native Poster Tags; status tags are not drawn there).', options: [['web', 'Web'], ['native', 'Native posters'], ['both', 'Both']], read: (v) => (typeof v === 'string' && ['web', 'native', 'both'].includes(v) ? v : 'both'), when: (c) => c.TagStylesEnabled === true },
            { id: 'tagStylesAllowUserPreset', key: 'TagStylesAllowUserPreset', type: 'switch', label: 'Let users pick their own preset', desc: 'Shows a colour preset choice in each user\'s Media Tags settings. Your group and label colours stay on top of their preset.', break: true },
        ],
        render(ctx, body) {
            body.innerHTML = `<div id="tagStylesBody" style="margin-top:14px">${A.EDITOR_HTML ?? ''}
                <div class="je-ta-actions"><button type="button" class="je-ta-button je-ta-button--danger" id="tagStyleResetAll"><span class="material-icons" aria-hidden="true">restart_alt</span>${ctx.tx('Reset all colours')}</button></div></div>`;
            const label = (selector: string, value: string) => { const el = body.querySelector(selector); if (el) el.textContent = value; };
            label('#tagStylePresetLabel', A.fmt('Preset'));
            label('#tagStyleTargetsLabel', A.fmt('Editing'));
            label('#tagStylePreviewLabel', A.fmt('Preview'));
            label('#tagStylePresets', A.fmt('Loading…'));
            body.querySelector('#tagStyleTabs')?.setAttribute('aria-label', A.fmt('Tag group'));
            // Apply to and the user-preset switch are options most visits never change: one closed row.
            const section = body.closest('[data-section]');
            const wraps = ['tagStyleTarget', 'tagStylesAllowUserPreset'].map((id) => section?.querySelector(`[data-field-row="${id}"]`)?.parentElement).filter((w): w is HTMLElement => !!w);
            const first = wraps[0];
            if (section && first && !section.querySelector('.je-ta-more')) {
                const more = document.createElement('details');
                more.className = 'je-ta-more';
                more.innerHTML = '<summary class="je-ta-more-toggle"><span class="material-icons" aria-hidden="true">expand_more</span><span data-more-text></span></summary>';
                first.before(more);
                wraps.forEach((w) => more.appendChild(w));
                const sum = (): void => {
                    const target = findAs(more, '[name="tagStyleTarget"]:checked', HTMLInputElement);
                    const allow = findAs(more, '#tagStylesAllowUserPreset', HTMLInputElement);
                    const parts = [A.fmt('Options')];
                    // Apply to counts while tag colours are on (its row is shown then).
                    if (target && ctx.config.TagStylesEnabled === true) parts.push(word(A.WORDS.colourTarget, ['web', 'native', 'both'].includes(target.value) ? target.value : 'both') || '');
                    if (allow) parts.push(A.fmt(allow.checked ? 'User presets allowed' : 'No user presets'));
                    const textEl = more.querySelector('[data-more-text]');
                    if (textEl) textEl.textContent = parts.filter(Boolean).join(' · ');
                };
                sum();
                section.addEventListener('change', () => setTimeout(sum), { signal: ctx.signal });
            }
            const create = A.createTagStylesEditor;
            if (!create) { editor = null; return; }
            const customLabels = (): string[] => {
                const rules = Array.isArray(ctx.config.CustomTagRules) ? ctx.config.CustomTagRules : [];
                const labels: string[] = [];
                for (const r of rules) {
                    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
                    const value = r.Label || r.label;
                    if (value) labels.push(String(value));
                }
                return [...new Set(labels)];
            };
            /**
             * Hidden tags: the page's TagHiddenValues, saved with its other edits. This dashboard's own posters
             * and previews follow at once (the public configuration they read is updated too).
             */
            const setHiddenDoc = (doc: Record<string, string[]> | null, ages: string[]): void => {
                ctx.setMany({ TagHiddenValues: doc }, { redraw: false });
                if (JE.pluginConfig) Object.assign(JE.pluginConfig, { TagHiddenValues: doc, TagHiddenAgeRatings: ages });
                // Redraw every group's tags (a renderer that never registered has nothing drawn).
                for (const name of RENDERERS) JE.core.tagRenderer?.reinitialize?.(name);
            };
            const hiddenStore: HiddenStore = {
                get: () => ctx.config.TagHiddenValues || null,
                set(doc, ages, change) {
                    const before = hiddenDoc(ctx.config.TagHiddenValues);
                    const beforeAges = Array.isArray(JE.pluginConfig?.TagHiddenAgeRatings) ? JE.pluginConfig.TagHiddenAgeRatings.map(String) : [];
                    setHiddenDoc(doc, ages);
                    // An age tile stands for every rating sharing its colour: the message counts them.
                    // A Custom label without a rule shows nowhere: it is just no longer hidden.
                    const message = change.orphan && !change.hidden ? A.fmt('{name} is no longer hidden', { name: change.label.key })
                        : change.count > 1
                            ? A.fmt(change.hidden ? '{count} ratings hidden' : '{count} ratings show again', { count: change.count })
                            : A.fmt(change.hidden ? '{name} hidden' : '{name} shown again', { name: change.noun || change.label.name });
                    ctx.snack(message, () => {
                        setHiddenDoc(before, beforeAges);
                        editor?.refreshHidden();
                    });
                },
            };
            /**
             * Tag text: the page's TagTextOverrides (a JSON document), saved with its other edits. The posters
             * and previews on this page follow at once through the public configuration.
             */
            const setTextDoc = (docText: string | null): void => {
                ctx.setMany({ TagTextOverrides: docText }, { redraw: false });
                if (JE.pluginConfig) Object.assign(JE.pluginConfig, { TagTextOverrides: docText });
                for (const name of TEXT_RENDERERS) JE.core.tagRenderer?.reinitialize?.(name);
            };
            const textStore: TextStore = {
                get: () => textDoc(ctx.config.TagTextOverrides),
                set(group, label, text) {
                    const before = typeof ctx.config.TagTextOverrides === 'string' && ctx.config.TagTextOverrides ? ctx.config.TagTextOverrides : null;
                    const doc = textDoc(before);
                    const labels = { ...(doc[group] || {}) };
                    if (text) labels[label.key] = text; else delete labels[label.key];
                    if (Object.keys(labels).length) doc[group] = labels; else delete doc[group];
                    setTextDoc(Object.keys(doc).length ? JSON.stringify(doc) : null);
                    ctx.snack(text ? A.fmt('{name} now reads "{text}"', { name: label.name, text }) : A.fmt('{name} shows its own text again', { name: label.name }), () => {
                        setTextDoc(before);
                        editor?.refreshHidden();
                    });
                },
            };
            const own = create(ctx.root, customLabels, () => ctx.isCurrent(), hiddenStore, textStore);
            editor = own;
            ctx.root.addEventListener('je-custom-labels', () => { if (ctx.isCurrent()) own.refreshLabels(); }, { signal: ctx.signal });
            // Groups tab pointers ("Hidden Genre tags (Colours and text)") open that group's tag list here.
            ctx.root.addEventListener('click', (e) => {
                const link = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-je-colours-group]') : null;
                if (link && ctx.isCurrent()) setTimeout(() => editor?.openGroup(link.dataset.jeColoursGroup || ''));
            }, { signal: ctx.signal });
            /** Save the editor's document when an edit changed it. */
            const changed = (): void => {
                const now = own.snapshot();
                if (now === last) return;
                last = now;
                ctx.setMany({ TagStyleOverrides: own.serialize(), TagStylePreset: own.settings().preset }, { redraw: false });
            };
            const editorEl = find(body, '#tagStyleEditor');
            editorEl?.addEventListener('click', changed);
            editorEl?.addEventListener('input', changed);
            body.querySelector('#tagStyleResetAll')?.addEventListener('click', async () => {
                const ok = await ctx.confirm(A.fmt('Every group and label colour goes back to the Default preset.'), A.fmt('Reset all colours'));
                if (!ok) return;
                const before = { json: ctx.config.TagStyleOverrides || '', preset: ctx.config.TagStylePreset || 'default' };
                own.load('', 'default');
                last = own.snapshot();
                ctx.setMany({ TagStyleOverrides: '', TagStylePreset: 'default' }, { redraw: false });
                ctx.snack(A.fmt('All colours reset'), () => {
                    own.load(before.json, before.preset);
                    last = own.snapshot();
                    ctx.setMany({ TagStyleOverrides: before.json, TagStylePreset: before.preset }, { redraw: false });
                });
            });
            load(ctx);
        },
        load,
        refresh(ctx, body) {
            // The editor stays open with tag colours off: its tag list is also where tags are hidden.
            find(body, '#tagStylesBody')?.classList.toggle('je-ts-colours-off', ctx.config.TagStylesEnabled !== true);
            editor?.setColoursOffNote(ctx.config.TagStylesEnabled !== true, () => {
                const input = find(ctx.root, '#tagStylesEnabled');
                input?.scrollIntoView?.({ block: 'center' });
                input?.focus();
            });
            editor?.refreshHidden();
        },
    });
});
