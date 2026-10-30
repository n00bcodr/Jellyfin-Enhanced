/**
 * @file Media Tags admin page, Colours tab: Tag Styles on or off, where the
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
        title: 'admin_tags_colours_title',
        hint: 'admin_tags_colours_desc',
        fields: [
            { id: 'tagStylesEnabled', key: 'TagStylesEnabled', type: 'switch', label: 'admin_tags_colours_enabled', desc: 'admin_tags_colours_enabled_desc' },
            { id: 'tagStyleTarget', key: 'TagStyleTarget', type: 'pills', label: 'admin_tags_colours_target', desc: 'admin_tags_colours_target_desc', options: [['web', 'admin_tags_style_target_web'], ['native', 'admin_tags_style_target_native'], ['both', 'admin_tags_style_target_both']], read: (v) => (['web', 'native', 'both'].includes(v) ? v : 'both'), when: (c) => c.TagStylesEnabled === true },
            { id: 'tagStylesAllowUserPreset', key: 'TagStylesAllowUserPreset', type: 'switch', label: 'admin_tags_colours_allow_preset', desc: 'admin_tags_colours_allow_preset_desc', break: true },
        ],
        render(ctx, body) {
            body.innerHTML = `<div id="tagStylesBody" style="margin-top:14px">${A.EDITOR_HTML}
                <div class="je-ta-actions"><button type="button" class="je-ta-button je-ta-button--danger" id="tagStyleResetAll"><span class="material-icons" aria-hidden="true">restart_alt</span>${ctx.tx('admin_tags_colours_reset')}</button></div></div>`;
            body.querySelector('#tagStylePresetLabel').textContent = JE.t('admin_tags_colours_preset');
            body.querySelector('#tagStyleTargetsLabel').textContent = JE.t('admin_tags_colours_editing');
            body.querySelector('#tagStylePreviewLabel').textContent = JE.t('admin_tags_colours_preview');
            body.querySelector('#tagStylePresets').textContent = JE.t('admin_tags_loading');
            body.querySelector('#tagStyleTabs').setAttribute('aria-label', JE.t('admin_tags_colours_group'));
            editor = A.createTagStylesEditor(ctx.root);
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
                const ok = await ctx.confirm(JE.t('admin_tags_colours_reset_confirm'), JE.t('admin_tags_colours_reset'));
                if (!ok) return;
                const before = { json: ctx.config.TagStyleOverrides || '', preset: ctx.config.TagStylePreset || 'default' };
                editor.load('', 'default');
                last = editor.snapshot();
                ctx.setMany({ TagStyleOverrides: '', TagStylePreset: 'default' }, { redraw: false });
                ctx.snack(JE.t('admin_tags_colours_reset_done'), () => {
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
