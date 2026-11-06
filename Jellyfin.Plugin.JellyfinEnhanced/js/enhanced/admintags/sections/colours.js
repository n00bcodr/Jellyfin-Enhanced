/**
 * @file Media Tags admin tab, Colours tab: Tag Styles on or off, where the
 * colours apply, whether users may pick their own preset, and the full
 * colour editor (tag-styles-editor.js) with Reset all colours (undoable).
 * Saves TagStyleOverrides and TagStylePreset whenever the editor's document
 * changes.
 */
(function(JE) {
    'use strict';

    const A = JE.adminTags;
    if (!A) return;

    /** @type {ReturnType<typeof A.createTagStylesEditor>|null} */
    let editor = null;
    let last = '';

    A.registerSection({
        id: 'colours',
        tab: 'colours',
        order: 10,
        title: 'Tag colours',
        hint: 'Colours for quality, age rating, rating, genre, status, language, awards, logo and custom tags.',
        writes: ['TagStyleOverrides', 'TagStylePreset'],
        fields: [
            { id: 'tagStylesEnabled', key: 'TagStylesEnabled', type: 'switch', label: 'Use tag colours', desc: 'Off shows the original colours (custom CSS keeps working). Your edits are kept.', master: true },
            { id: 'tagStyleTarget', key: 'TagStyleTarget', type: 'pills', label: 'Apply to', desc: 'Web recolours the overlays and wins over custom CSS colours. Native posters draws the colours into the posters of apps such as Android TV (needs Native Poster Tags; status tags are not drawn there).', options: [['web', 'Web'], ['native', 'Native posters'], ['both', 'Both']], read: (v) => (['web', 'native', 'both'].includes(v) ? v : 'both'), when: (c) => c.TagStylesEnabled === true },
            { id: 'tagStylesAllowUserPreset', key: 'TagStylesAllowUserPreset', type: 'switch', label: 'Let users pick their own preset', desc: 'Shows a colour preset choice in each user\'s Media Tags settings. Your group and label colours stay on top of their preset.', break: true },
        ],
        render(ctx, body) {
            body.innerHTML = `<div id="tagStylesBody" style="margin-top:14px">${A.EDITOR_HTML}
                <div class="je-ta-actions"><button type="button" class="je-ta-button je-ta-button--danger" id="tagStyleResetAll"><span class="material-icons" aria-hidden="true">restart_alt</span>${ctx.tx('Reset all colours')}</button></div></div>`;
            body.querySelector('#tagStylePresetLabel').textContent = A.fmt('Preset');
            body.querySelector('#tagStyleTargetsLabel').textContent = A.fmt('Editing');
            body.querySelector('#tagStylePreviewLabel').textContent = A.fmt('Preview');
            body.querySelector('#tagStylePresets').textContent = A.fmt('Loading…');
            body.querySelector('#tagStyleTabs').setAttribute('aria-label', A.fmt('Tag group'));
            // Apply to and the user-preset switch are options most visits never change: one closed row.
            const section = body.closest('[data-section]');
            const wraps = ['tagStyleTarget', 'tagStylesAllowUserPreset'].map((id) => section?.querySelector(`[data-field-row="${id}"]`)?.parentElement).filter(Boolean);
            if (wraps.length && !section.querySelector('.je-ta-more')) {
                const more = document.createElement('details');
                more.className = 'je-ta-more';
                more.innerHTML = '<summary class="je-ta-more-toggle"><span class="material-icons" aria-hidden="true">expand_more</span><span data-more-text></span></summary>';
                wraps[0].before(more);
                wraps.forEach((w) => more.appendChild(w));
                const sum = () => {
                    const target = /** @type {HTMLInputElement|null} */ (more.querySelector('[name="tagStyleTarget"]:checked'));
                    const allow = /** @type {HTMLInputElement|null} */ (more.querySelector('#tagStylesAllowUserPreset'));
                    const parts = [A.fmt('Options')];
                    // Apply to counts while tag colours are on (its row is shown then).
                    if (target && ctx.config.TagStylesEnabled === true) parts.push(A.WORDS.colourTarget[['web', 'native', 'both'].includes(target.value) ? target.value : 'both']);
                    if (allow) parts.push(A.fmt(allow.checked ? 'User presets allowed' : 'No user presets'));
                    /** @type {HTMLElement} */ (more.querySelector('[data-more-text]')).textContent = parts.filter(Boolean).join(' · ');
                };
                sum();
                section.addEventListener('change', () => setTimeout(sum), { signal: ctx.signal });
            }
            editor = A.createTagStylesEditor(ctx.root, () => [...new Set((ctx.config.CustomTagRules || []).map((r) => r.Label || r.label).filter(Boolean))], () => ctx.isCurrent());
            ctx.root.addEventListener('je-custom-labels', () => { if (ctx.isCurrent()) editor.refreshLabels(); }, { signal: ctx.signal });
            /** Save the editor's document when an edit changed it. */
            const changed = () => {
                const now = editor.snapshot();
                if (now === last) return;
                last = now;
                ctx.setMany({ TagStyleOverrides: editor.serialize(), TagStylePreset: editor.settings().preset }, { redraw: false });
            };
            const editorEl = /** @type {HTMLElement} */ (body.querySelector('#tagStyleEditor'));
            editorEl.addEventListener('click', changed);
            editorEl.addEventListener('input', changed);
            body.querySelector('#tagStyleResetAll')?.addEventListener('click', async () => {
                const ok = await ctx.confirm(A.fmt('Every group and label colour goes back to the Default preset.'), A.fmt('Reset all colours'));
                if (!ok) return;
                const before = { json: ctx.config.TagStyleOverrides || '', preset: ctx.config.TagStylePreset || 'default' };
                editor.load('', 'default');
                last = editor.snapshot();
                ctx.setMany({ TagStyleOverrides: '', TagStylePreset: 'default' }, { redraw: false });
                ctx.snack(A.fmt('All colours reset'), () => {
                    editor.load(before.json, before.preset);
                    last = editor.snapshot();
                    ctx.setMany({ TagStyleOverrides: before.json, TagStylePreset: before.preset }, { redraw: false });
                });
            });
            this.load(ctx);
        },
        /** Load the stored document into the editor (first draw and page shown again). */
        load(ctx) {
            if (!editor) return;
            editor.load(ctx.config.TagStyleOverrides, ctx.config.TagStylePreset);
            last = editor.snapshot();
        },
        refresh(ctx, body) {
            const box = /** @type {HTMLElement|null} */ (body?.querySelector('#tagStylesBody'));
            if (box) box.style.display = ctx.config.TagStylesEnabled === true ? '' : 'none';
        },
    });
})(window.JellyfinEnhanced);
