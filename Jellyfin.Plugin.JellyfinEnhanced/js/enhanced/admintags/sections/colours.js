/**
 * @file Media Tags admin tab, Colours tab: Tag Styles on or off, where the
 * colours apply, whether users may pick their own preset, and the full
 * colour editor (tag-styles-editor.js) with Reset all colours (undoable).
 * Saves TagStyleOverrides and TagStylePreset whenever the editor's document
 * changes. Each tag in the editor's tag list can also be hidden (Hidden tags,
 * #1043): TagHiddenValues, which applies whether tag colours are on or not.
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
        title: 'Tag colours and text',
        hint: 'Colours for quality, age rating, rating, genre, status, language, awards, logo and custom tags, and the words of quality, genre, status and awards tags.',
        writes: ['TagStyleOverrides', 'TagStylePreset', 'TagHiddenValues', 'TagTextOverrides'],
        fields: [
            { id: 'tagStylesEnabled', key: 'TagStylesEnabled', type: 'switch', label: 'Use tag colours', desc: 'Off shows the original colours (custom CSS keeps working). Your edits are kept. Hidden tags apply either way.', master: true },
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
            /**
             * Hidden tags: the page's TagHiddenValues, saved with its other edits. This dashboard's own
             * posters and previews follow at once (the public configuration they read is updated too).
             */
            const setHiddenDoc = (doc, ages) => {
                ctx.setMany({ TagHiddenValues: doc }, { redraw: false });
                if (JE.pluginConfig) Object.assign(JE.pluginConfig, { TagHiddenValues: doc, TagHiddenAgeRatings: ages });
                // Redraw every group's tags (a renderer that never registered has nothing drawn).
                for (const name of ['quality', 'genre', 'rating', 'agerating', 'status', 'language', 'awards', 'logos', 'custom']) JE.core?.tagRenderer?.reinitialize?.(name);
            };
            const hiddenStore = {
                get: () => ctx.config.TagHiddenValues || null,
                set(doc, ages, change) {
                    const before = ctx.config.TagHiddenValues || null;
                    const beforeAges = JE.pluginConfig?.TagHiddenAgeRatings || [];
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
            const readTexts = () => { try { return JSON.parse(ctx.config.TagTextOverrides || '{}') || {}; } catch { return {}; } };
            const setTextDoc = (docText) => {
                ctx.setMany({ TagTextOverrides: docText }, { redraw: false });
                if (JE.pluginConfig) Object.assign(JE.pluginConfig, { TagTextOverrides: docText });
                for (const name of ['quality', 'genre', 'status', 'awards']) JE.core?.tagRenderer?.reinitialize?.(name);
            };
            const textStore = {
                get: readTexts,
                set(group, label, text) {
                    const before = ctx.config.TagTextOverrides || null;
                    const doc = readTexts();
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
            editor = A.createTagStylesEditor(ctx.root, () => [...new Set((ctx.config.CustomTagRules || []).map((r) => r.Label || r.label).filter(Boolean))], () => ctx.isCurrent(), hiddenStore, textStore);
            ctx.root.addEventListener('je-custom-labels', () => { if (ctx.isCurrent()) editor.refreshLabels(); }, { signal: ctx.signal });
            // Groups tab pointers ("Hidden Genre tags (Colours and text)") open that group's tag list here.
            ctx.root.addEventListener('click', (e) => {
                const link = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest?.('[data-je-colours-group]'));
                if (link && ctx.isCurrent()) setTimeout(() => editor?.openGroup(link.dataset.jeColoursGroup || ''));
            }, { signal: ctx.signal });
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
            // The editor stays open with tag colours off: its tag list is also where tags are hidden.
            body?.querySelector('#tagStylesBody')?.classList.toggle('je-ts-colours-off', ctx.config.TagStylesEnabled !== true);
            editor?.setColoursOffNote(ctx.config.TagStylesEnabled !== true, () => {
                const input = /** @type {HTMLElement|null} */ (ctx.root.querySelector('#tagStylesEnabled'));
                input?.scrollIntoView?.({ block: 'center' });
                input?.focus();
            });
            editor?.refreshHidden();
        },
    });
})(window.JellyfinEnhanced);
