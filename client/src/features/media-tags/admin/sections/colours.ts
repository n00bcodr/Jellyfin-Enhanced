/**
 * @file Media Tags admin tab, Colours tab: Tag Styles on or off, where the
 * colours apply, whether users may pick their own preset, and the full
 * colour editor (tag-styles-editor.js) with Reset all colours (undoable).
 * Saves TagStyleOverrides and TagStylePreset whenever the editor's document changes.
 */
/*! Lexical index of this module's declarations, in the order Shared/MediaTags/MediaTagsPageFields.cs (the field
 *  patch's allowlist), Features/Admin/Services/WhatsNewService.cs and scripts/generate_config_flag_groups.py read them
 *  from the generated file. Not code: tests/frontend/features/media-tags/admin/admin-tags-rewrite.test.mjs keeps it equal
 *  to the sections this module registers and to what those readers found in the JavaScript module.
registerSection({
    tab: 'colours',
    title: 'Tag colours',
    writes: ['TagStyleOverrides', 'TagStylePreset'],
        { id: 'tagStylesEnabled', key: 'TagStylesEnabled', type: 'switch', label: 'Use tag colours' },
        { id: 'tagStyleTarget', key: 'TagStyleTarget', type: 'pills', label: 'Apply to' },
        { id: 'tagStylesAllowUserPreset', key: 'TagStylesAllowUserPreset', type: 'switch', label: 'Let users pick their own preset' },
*/
import { find, findAs } from '../dom';
import { word } from '../format';
import type { PageContext, TagStylesEditor } from '../types';
import { installSection } from './install';

installSection((A) => {
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
        title: 'Tag colours',
        hint: 'Colours for quality, age rating, rating, genre, status, language, awards, logo and custom tags.',
        writes: ['TagStyleOverrides', 'TagStylePreset'],
        fields: [
            { id: 'tagStylesEnabled', key: 'TagStylesEnabled', type: 'switch', label: 'Use tag colours', desc: 'Off shows the original colours (custom CSS keeps working). Your edits are kept.', master: true },
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
            const own = create(ctx.root, customLabels, () => ctx.isCurrent());
            editor = own;
            ctx.root.addEventListener('je-custom-labels', () => { if (ctx.isCurrent()) own.refreshLabels(); }, { signal: ctx.signal });
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
            const box = find(body, '#tagStylesBody');
            if (box) box.style.display = ctx.config.TagStylesEnabled === true ? '' : 'none';
        },
    });
});
