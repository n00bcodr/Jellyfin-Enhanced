/**
 * @file Media Tags admin page, Server tab: export and import of the
 * server-wide Media Tags settings, and the presets offered to users.
 *
 * Export is the server's document (GET admin/media-tags/export: every field
 * this page writes, never an API key or the custom rule key). Import saves
 * the page's pending edits, asks the server what a document would change
 * (POST admin/media-tags/preview, the field patch's own checks), and after a
 * confirmation writes the changed
 * fields through the page's working copy, so they are saved by the locked
 * field patch with the values this page read: a field another administrator
 * changed meanwhile is refused and waits for Keep mine / Take theirs, like
 * any edit on this page. The offered presets
 * are one field (TagOfferedPresets, a JSON array, at most 20) that the server
 * validates like every other. The dialogs and file helpers are the settings
 * panel's (settingspanel/ui-panel-tag-portable.js).
 */
(function(JE) {
    'use strict';

    const A = JE.adminTags;
    if (!A) return;

    const MAX_OFFERED = 20;
    const MAX_NAME = 60;
    const MAX_DESCRIPTION = 240;

    /** @returns {Object|null} The shared dialogs and helpers. */
    const tools = () => JE.internals?.enhancedUi?.tagPortable || null;

    /**
     * The offered presets the configuration holds.
     * @param {Object} config
     * @returns {Array<Object>}
     */
    function offered(config) {
        try {
            const list = JSON.parse(String(config.TagOfferedPresets || '') || '[]');
            return Array.isArray(list) ? list.filter((p) => p && typeof p === 'object') : [];
        } catch {
            return [];
        }
    }

    /**
     * A new preset id from its name: lower-case letters, digits and hyphens, unique in the list.
     * @param {string} name
     * @param {Array<Object>} list
     * @returns {string}
     */
    function presetId(name, list) {
        const base = String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28) || 'preset';
        let id;
        do id = `${base}-${Math.random().toString(36).slice(2, 8)}`; while (list.some((p) => p.id === id));
        return id;
    }

    /**
     * A JSON request to the server.
     * @param {string} type
     * @param {string} path - Under JellyfinEnhanced/.
     * @param {Object} [body]
     * @returns {Promise<any>}
     */
    const request = (type, path, body) => ApiClient.ajax({
        type,
        url: ApiClient.getUrl(`/JellyfinEnhanced/${path}`),
        dataType: 'json',
        ...(body ? { data: JSON.stringify(body), contentType: 'application/json' } : {}),
    });

    /**
     * Say in a dialog why nothing is shown: its loading line is hidden and,
     * with `retry`, Retry is offered (the same button when there is one, so a
     * focused Retry keeps focus; busy buttons are aria-disabled, not replaced).
     * @param {Object} d - A dialog from openDialog.
     * @param {string} message
     * @param {boolean} [retry]
     */
    function failed(d, message, retry = false) {
        const P = tools();
        const line = /** @type {HTMLElement|null} */ (d.body.querySelector('[data-pt-loading]'));
        if (line) line.hidden = true;
        d.status(message, 'error');
        if (!retry || !P) return;
        const again = d.foot.querySelector('[data-pt-action="retry"]');
        if (again) { again.removeAttribute('aria-disabled'); return; }
        const close = d.foot.querySelector('[data-pt-action="close"]') ? P.buttonHtml('close', 'awards_close') : P.buttonHtml('cancel', 'jellyseerr_modal_cancel');
        d.foot.innerHTML = close + P.buttonHtml('retry', 'admin_tags_retry', { primary: true });
        /** @type {HTMLElement|null} */ (d.foot.querySelector('[data-pt-action="retry"]'))?.focus();
    }

    /**
     * Start a Retry once: false while one is already working.
     * @param {HTMLElement|null} button
     * @returns {boolean}
     */
    function startRetry(button) {
        if (!button || button.getAttribute('aria-disabled') === 'true') return false;
        button.setAttribute('aria-disabled', 'true');
        return true;
    }

    A.registerSection({
        id: 'server-portable',
        tab: 'server',
        order: 30,
        title: 'tag_portable_title',
        hint: 'admin_tags_portable_desc',
        render(ctx, body) {
            const P = tools();
            body.innerHTML = `<div class="je-ta-actions">
                    <button type="button" class="je-ta-button" id="jeTaExport"><span class="material-icons" aria-hidden="true">download</span>${ctx.tx('admin_tags_portable_export')}</button>
                    <button type="button" class="je-ta-button" id="jeTaImport"><span class="material-icons" aria-hidden="true">upload</span>${ctx.tx('admin_tags_portable_import')}</button>
                </div>
                <p class="je-ta-hint">${ctx.tx('admin_tags_portable_secrets')}</p>`;
            if (!P) return;
            P.injectDialogCss();
            /** @type {ReturnType<typeof P.openDialog>|null} */
            let dialog = null;
            const show = (titleKey) => {
                dialog?.close();
                dialog = P.openDialog({ host: ctx.root, title: JE.t(titleKey), onClose: () => { dialog = null; } });
                return dialog;
            };
            ctx.signal.addEventListener('abort', () => dialog?.close());

            body.querySelector('#jeTaExport')?.addEventListener('click', async () => {
                const d = show('admin_tags_portable_export_title');
                d.body.innerHTML = `<p class="je-pt-hint">${ctx.tx('admin_tags_portable_export_desc')}</p><p class="je-pt-hint" data-pt-loading>${ctx.tx('hidden_content_admin_loading')}</p>`;
                d.foot.innerHTML = P.buttonHtml('close', 'awards_close');
                d.foot.onclick = (e) => {
                    const button = /** @type {HTMLElement} */ (e.target).closest('[data-pt-action]');
                    const action = button?.getAttribute('data-pt-action');
                    if (action === 'close') d.close();
                    else if (action === 'retry' && startRetry(button)) {
                        /** @type {HTMLElement} */ (d.body.querySelector('[data-pt-loading]')).hidden = false;
                        d.status(JE.t('tag_portable_checking'));
                        load();
                    }
                };
                d.focusFirst();
                const load = async () => {
                    let document;
                    try {
                        // Edits not saved yet belong in the export: a save that failed or is
                        // refused (Keep mine / Take theirs) would export the stored settings
                        // instead of the ones this page shows.
                        const saved = await ctx.flush();
                        if (!ctx.isCurrent() || d.closed()) return;
                        if (!saved) {
                            failed(d, JE.t('admin_tags_portable_export_unsaved'), true);
                            return;
                        }
                        document = await request('GET', 'admin/media-tags/export');
                    } catch (err) {
                        if (!ctx.isCurrent() || d.closed()) return;
                        console.warn('🪼 Jellyfin Enhanced: could not export the Media Tags settings', err);
                        failed(d, JE.t('tag_portable_export_failed'), true);
                        return;
                    }
                    if (!ctx.isCurrent() || d.closed()) return;
                    d.status('');
                    showExport(d, document);
                };
                await load();
            }, { signal: ctx.signal });

            /**
             * The export step: the document with Download and Copy.
             * @param {ReturnType<typeof P.openDialog>} d
             * @param {Object} document
             */
            const showExport = (d, document) => {
                const text = JSON.stringify(document, null, 2);
                d.body.innerHTML = `<p class="je-pt-hint">${ctx.tx('admin_tags_portable_export_desc')}</p>
                    <label class="je-pt-label" for="jeTaExportText">${ctx.tx('tag_portable_export_document', { count: Object.keys(document?.settings || {}).length })}</label>
                    <textarea id="jeTaExportText" class="je-pt-text" rows="12" readonly spellcheck="false">${ctx.esc(text)}</textarea>`;
                d.foot.innerHTML = P.buttonHtml('download', 'tag_portable_download', { icon: 'download', primary: true }) + P.buttonHtml('copy', 'tag_portable_copy', { icon: 'content_copy' }) + P.buttonHtml('close', 'awards_close');
                d.foot.onclick = async (e) => {
                    const action = /** @type {HTMLElement} */ (e.target).closest('[data-pt-action]')?.getAttribute('data-pt-action');
                    if (action === 'download') {
                        P.download(document, `jellyfin-media-tags-server-${P.stamp()}`);
                        d.status(JE.t('tag_portable_downloaded'));
                    } else if (action === 'copy') d.status(JE.t(await P.copyText(text, /** @type {HTMLTextAreaElement} */ (d.body.querySelector('textarea'))) ? 'tag_portable_copied' : 'tag_portable_copy_failed'));
                    else if (action === 'close') d.close();
                };
                /** @type {HTMLElement|null} */ (d.foot.querySelector('[data-pt-action="download"]'))?.focus();
            };

            /**
             * Write a preview's changes through the page and offer Undo.
             * @param {ReturnType<typeof P.openDialog>} d
             * @param {Array<{field: string, from: *, to: *}>} changes
             */
            const apply = async (d, changes) => {
                // What the server held when the preview compared it (the page read it
                // again just before): Undo puts it back, never an older copy of the page.
                const before = Object.fromEntries(changes.map((c) => [c.field, JSON.parse(JSON.stringify(c.from ?? null))]));
                // Written against that value too: a listed change is sent (Expected = what the
                // preview compared) even if this page's copy of the field already equals it.
                ctx.setMany(Object.fromEntries(changes.map((c) => [c.field, c.to])), { base: before });
                const saved = await ctx.flush();
                if (!ctx.isCurrent()) return;
                if (!saved) {
                    // A field another administrator changed meanwhile (or a failed save): the save indicator offers the choice.
                    d.status(JE.t('admin_tags_portable_apply_refused'), 'error');
                    return;
                }
                d.close();
                await reloadPage(ctx);
                ctx.snack(JE.t('admin_tags_portable_applied', { count: changes.length }), () => {
                    ctx.setMany(before);
                    ctx.flush().then((ok) => (ok ? reloadPage(ctx) : null));
                });
            };

            body.querySelector('#jeTaImport')?.addEventListener('click', () => {
                const d = show('admin_tags_portable_import_title');
                /**
                 * Ask the server what the document changes, compared with what this page
                 * shows: edits not saved yet (on their way, failed or refused) are saved
                 * first, else the server would compare with settings the page no longer
                 * shows and leave out a field the page changed.
                 * @param {Object} document - The parsed document.
                 * @param {string} [note] - Status shown with the preview.
                 */
                const preview = async (document, note) => {
                    d.status(JE.t('tag_portable_checking'));
                    const saved = await ctx.flush();
                    if (!ctx.isCurrent() || d.closed()) return;
                    if (!saved) { d.status(JE.t('admin_tags_portable_import_unsaved'), 'error'); return; }
                    // A field this page never edited can be older here than on the server
                    // (another administrator or tab saved it since): read the settings again,
                    // so the page and the preview compare the same values and Apply writes
                    // every listed change with the value the preview started from.
                    let fresh = null;
                    try {
                        fresh = await ApiClient.getPluginConfiguration(A.PLUGIN_ID);
                    } catch (err) {
                        if (!ctx.isCurrent() || d.closed()) return;
                        console.warn('🪼 Jellyfin Enhanced: could not read the configuration before the import preview', err);
                    }
                    if (!ctx.isCurrent() || d.closed()) return;
                    if (!fresh) { d.status(JE.t('tag_portable_export_failed'), 'error'); return; }
                    ctx.reload(fresh);
                    let answer;
                    try {
                        answer = await request('POST', 'admin/media-tags/preview', document);
                    } catch (err) {
                        if (!ctx.isCurrent() || d.closed()) return;
                        d.status(P.errorText((await P.errorOf(err)).code), 'error');
                        return;
                    }
                    if (!ctx.isCurrent() || d.closed()) return;
                    d.status(note || '');
                    const changes = answer?.changes || [];
                    // The page's values of every field the document sets, as the preview compared them.
                    const fields = new Set([...Object.keys(answer?.imported || {}), ...changes.map((c) => c.field)]);
                    const snapshot = () => JSON.stringify(Array.from(fields, (f) => ctx.config[f] ?? null));
                    const compared = snapshot();
                    d.body.innerHTML = P.previewHtml(answer || {});
                    d.foot.innerHTML = P.buttonHtml('back', 'tag_portable_back') + P.buttonHtml('cancel', 'jellyseerr_modal_cancel')
                        + (changes.length ? P.buttonHtml('apply', 'tag_portable_apply_count', { primary: true, params: { count: changes.length } }) : '');
                    d.foot.onclick = async (ev) => {
                        const button = /** @type {HTMLButtonElement|null} */ (/** @type {HTMLElement} */ (ev.target).closest('[data-pt-action]'));
                        const next = button?.dataset.ptAction;
                        if (next === 'back') { d.status(''); step(); d.focusFirst(); }
                        else if (next === 'cancel') d.close();
                        else if (next === 'apply' && button) {
                            const ok = await ctx.confirm(JE.t('admin_tags_portable_apply_confirm', { count: changes.length }), JE.t('admin_tags_portable_import_title'));
                            if (!ok || d.closed()) return;
                            button.disabled = true;
                            // Edited on this page since the preview: it no longer says what Apply changes.
                            const settled = await ctx.flush();
                            if (!ctx.isCurrent() || d.closed()) return;
                            if (!settled) { button.disabled = false; d.status(JE.t('admin_tags_portable_import_unsaved'), 'error'); return; }
                            if (snapshot() !== compared) { await preview(document, JE.t('admin_tags_portable_import_changed')); return; }
                            await apply(d, changes);
                            if (!d.closed()) button.disabled = false;
                        }
                    };
                    /** @type {HTMLElement|null} */ (d.foot.querySelector('[data-pt-action="apply"]') || d.foot.querySelector('[data-pt-action="cancel"]'))?.focus();
                };
                const step = () => {
                    d.body.innerHTML = P.sourceHtml('admin_tags_portable_import_desc');
                    d.foot.innerHTML = P.buttonHtml('cancel', 'jellyseerr_modal_cancel') + P.buttonHtml('next', 'tag_portable_preview', { primary: true });
                    P.wireSource(d);
                    d.foot.onclick = async (e) => {
                        const action = /** @type {HTMLElement} */ (e.target).closest('[data-pt-action]')?.getAttribute('data-pt-action');
                        if (action === 'cancel') { d.close(); return; }
                        if (action !== 'next') return;
                        const parsed = P.parseDocument(/** @type {HTMLTextAreaElement} */ (d.body.querySelector('[data-pt-paste]')).value);
                        if (parsed.error) { d.status(P.errorText(parsed.error), 'error'); return; }
                        await preview(/** @type {Object} */ (parsed.document));
                    };
                    d.focusFirst();
                };
                step();
            }, { signal: ctx.signal });
        },
    });

    /**
     * Read the configuration again after an import: every editor shows what was stored.
     * @param {Object} ctx
     */
    async function reloadPage(ctx) {
        try {
            const fresh = await ApiClient.getPluginConfiguration(A.PLUGIN_ID);
            if (ctx.isCurrent() && fresh) ctx.reload(fresh);
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: could not reload the configuration', err);
        }
    }

    A.registerSection({
        id: 'server-presets',
        tab: 'server',
        order: 40,
        title: 'admin_tags_presets_title',
        hint: 'admin_tags_presets_desc',
        fields: [
            { id: 'tagOfferedPresets', key: 'TagOfferedPresets', type: 'custom', label: 'admin_tags_presets_title' },
        ],
        render(ctx, body) {
            const P = tools();
            body.innerHTML = `<div class="je-ta-offered" data-offered aria-live="polite"></div>
                <div class="je-ta-actions">
                    <button type="button" class="je-ta-button" id="jeTaOfferMine"><span class="material-icons" aria-hidden="true">person</span>${ctx.tx('admin_tags_presets_add_mine')}</button>
                    <button type="button" class="je-ta-button" id="jeTaOfferImport"><span class="material-icons" aria-hidden="true">file_open</span>${ctx.tx('admin_tags_presets_add_import')}</button>
                </div>`;
            if (!P) return;
            P.injectDialogCss();
            /** @type {ReturnType<typeof P.openDialog>|null} */
            let dialog = null;
            const show = (titleKey) => {
                dialog?.close();
                dialog = P.openDialog({ host: ctx.root, title: JE.t(titleKey), onClose: () => { dialog = null; } });
                return dialog;
            };
            ctx.signal.addEventListener('abort', () => dialog?.close());

            /**
             * Name a checked preset and offer it.
             * @param {ReturnType<typeof P.openDialog>} d
             * @param {{name?: string, description?: string, imported: Object, skipped: Array<Object>}} checked
             */
            const nameStep = (d, checked) => {
                d.body.innerHTML = `<p class="je-pt-hint">${ctx.tx('admin_tags_presets_name_desc', { count: Object.keys(checked.imported).length })}</p>
                    <label class="je-pt-label" for="jeTaOfferName">${ctx.tx('tag_presets_name')}</label>
                    <input id="jeTaOfferName" class="je-pt-input" type="text" maxlength="${MAX_NAME}" value="${ctx.esc(checked.name || '')}" data-pt-autofocus>
                    <label class="je-pt-label" for="jeTaOfferDesc">${ctx.tx('tag_presets_description')}</label>
                    <textarea id="jeTaOfferDesc" class="je-pt-input" rows="2" maxlength="${MAX_DESCRIPTION}">${ctx.esc(checked.description || '')}</textarea>
                    ${checked.skipped.length ? P.previewHtml({ skipped: checked.skipped }, { summary: false }) : ''}`;
                d.foot.innerHTML = P.buttonHtml('cancel', 'jellyseerr_modal_cancel') + P.buttonHtml('offer', 'admin_tags_presets_offer', { primary: true });
                // This dialog's preset, once offered: a retry after a failed or refused
                // save replaces it instead of adding another copy.
                let offeredId = '';
                d.foot.onclick = async (e) => {
                    const button = /** @type {HTMLButtonElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-pt-action]'));
                    if (button?.dataset.ptAction === 'cancel') { d.close(); return; }
                    if (button?.dataset.ptAction !== 'offer') return;
                    const name = /** @type {HTMLInputElement} */ (d.body.querySelector('#jeTaOfferName')).value.trim();
                    const description = /** @type {HTMLTextAreaElement} */ (d.body.querySelector('#jeTaOfferDesc')).value.trim();
                    if (!name) { d.status(P.errorText('name'), 'error'); /** @type {HTMLElement} */ (d.body.querySelector('#jeTaOfferName')).focus(); return; }
                    const list = offered(ctx.config);
                    const again = offeredId ? list.findIndex((p) => p.id === offeredId) : -1;
                    if (again < 0 && list.length >= MAX_OFFERED) { d.status(JE.t('admin_tags_presets_full', { max: MAX_OFFERED }), 'error'); return; }
                    if (again < 0 && !offeredId) offeredId = presetId(name, list);
                    const preset = { v: 1, kind: 'je-media-tags-preset', id: offeredId, name, description, settings: checked.imported };
                    if (again < 0) list.push(preset);
                    else list[again] = preset;
                    button.disabled = true;
                    ctx.set('TagOfferedPresets', JSON.stringify(list));
                    const saved = await ctx.flush();
                    if (!ctx.isCurrent() || d.closed()) return;
                    if (!saved) { button.disabled = false; d.status(JE.t('admin_tags_presets_save_failed'), 'error'); return; }
                    d.close();
                    ctx.snack(JE.t('admin_tags_presets_offered', { name }));
                };
                d.focusFirst();
            };

            /**
             * Check a document as a preset (the user preview endpoint: the settings save path's validators).
             * @param {ReturnType<typeof P.openDialog>} d
             * @param {Object} document
             * @param {boolean} [retry] - Offer Retry when it fails (no source step to check again from).
             */
            const check = async (d, document, retry = false) => {
                d.status(JE.t('tag_portable_checking'));
                let preview;
                try {
                    preview = await request('POST', `user-settings/${ApiClient.getCurrentUserId()}/media-tags/preview`, document);
                } catch (err) {
                    if (!ctx.isCurrent() || d.closed()) return;
                    const { code } = await P.errorOf(err);
                    if (!ctx.isCurrent() || d.closed()) return;
                    failed(d, P.errorText(code), retry);
                    return;
                }
                if (!ctx.isCurrent() || d.closed()) return;
                d.status('');
                if (!preview?.imported || !Object.keys(preview.imported).length) {
                    d.body.innerHTML = P.previewHtml({ skipped: preview?.skipped || [] }, { summary: false });
                    d.status(P.errorText('empty'), 'error');
                    return;
                }
                nameStep(d, { name: preview.name || document.name, description: preview.description || document.description, imported: preview.imported, skipped: preview.skipped || [] });
            };

            body.querySelector('#jeTaOfferMine')?.addEventListener('click', async () => {
                const d = show('admin_tags_presets_add_title');
                d.body.innerHTML = `<p class="je-pt-hint" data-pt-loading>${ctx.tx('hidden_content_admin_loading')}</p>`;
                d.foot.innerHTML = P.buttonHtml('cancel', 'jellyseerr_modal_cancel');
                d.foot.onclick = (e) => {
                    const button = /** @type {HTMLElement} */ (e.target).closest('[data-pt-action]');
                    const action = button?.getAttribute('data-pt-action');
                    if (action === 'cancel') d.close();
                    else if (action === 'retry' && startRetry(button)) {
                        /** @type {HTMLElement} */ (d.body.querySelector('[data-pt-loading]')).hidden = false;
                        load();
                    }
                };
                d.focusFirst();
                const load = async () => {
                    d.status(JE.t('tag_portable_checking'));
                    try {
                        // The export reads the stored settings: a change of the administrator's
                        // own settings that failed to save would offer older ones instead.
                        try {
                            await JE.saveUserSettings?.('settings.json', JE.currentSettings, { throwOnError: true, isCurrent: ctx.isCurrent });
                        } catch (err) {
                            if (!ctx.isCurrent() || d.closed()) return;
                            console.warn('🪼 Jellyfin Enhanced: your own Media Tags settings are not saved yet', err);
                            failed(d, JE.t('admin_tags_presets_mine_unsaved'), true);
                            return;
                        }
                        if (!ctx.isCurrent() || d.closed()) return;
                        const mine = await request('GET', `user-settings/${ApiClient.getCurrentUserId()}/media-tags/export`);
                        if (!ctx.isCurrent() || d.closed()) return;
                        await check(d, mine, true);
                    } catch (err) {
                        if (!ctx.isCurrent() || d.closed()) return;
                        console.warn('🪼 Jellyfin Enhanced: could not read your Media Tags settings', err);
                        failed(d, JE.t('tag_portable_export_failed'), true);
                    }
                };
                await load();
            }, { signal: ctx.signal });

            body.querySelector('#jeTaOfferImport')?.addEventListener('click', () => {
                const d = show('admin_tags_presets_add_title');
                d.body.innerHTML = P.sourceHtml('admin_tags_presets_import_desc');
                d.foot.innerHTML = P.buttonHtml('cancel', 'jellyseerr_modal_cancel') + P.buttonHtml('next', 'tag_portable_preview', { primary: true });
                P.wireSource(d);
                d.foot.onclick = (e) => {
                    const action = /** @type {HTMLElement} */ (e.target).closest('[data-pt-action]')?.getAttribute('data-pt-action');
                    if (action === 'cancel') { d.close(); return; }
                    if (action !== 'next') return;
                    const parsed = P.parseDocument(/** @type {HTMLTextAreaElement} */ (d.body.querySelector('[data-pt-paste]')).value);
                    if (parsed.error) { d.status(P.errorText(parsed.error), 'error'); return; }
                    check(d, /** @type {Object} */ (parsed.document));
                };
                d.focusFirst();
            }, { signal: ctx.signal });

            body.querySelector('[data-offered]')?.addEventListener('click', async (e) => {
                const button = /** @type {HTMLButtonElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-offer-action]'));
                const item = button?.closest('[data-offer-id]');
                if (!button || !item) return;
                const list = offered(ctx.config);
                const preset = list.find((p) => p.id === item.getAttribute('data-offer-id'));
                if (!preset) return;
                if (button.dataset.offerAction === 'share') {
                    const copied = await P.copyText(JSON.stringify(preset, null, 2));
                    ctx.snack(JE.t(copied ? 'tag_presets_shared' : 'tag_portable_copy_failed', { name: preset.name }));
                    return;
                }
                const ok = await ctx.confirm(JE.t('admin_tags_presets_remove_confirm', { name: preset.name }), JE.t('remove_button_text'));
                if (!ok) return;
                const rest = list.filter((p) => p !== preset);
                ctx.set('TagOfferedPresets', rest.length ? JSON.stringify(rest) : '');
                // The row is gone: focus the list's first action instead.
                /** @type {HTMLElement|null} */ (body.querySelector('#jeTaOfferMine'))?.focus();
                ctx.snack(JE.t('admin_tags_presets_removed', { name: preset.name }), () => ctx.set('TagOfferedPresets', JSON.stringify(list)));
            }, { signal: ctx.signal });
        },
        refresh(ctx, body) {
            const box = /** @type {HTMLElement|null} */ (body?.querySelector('[data-offered]'));
            if (!box) return;
            const list = offered(ctx.config);
            const count = `<p class="je-ta-hint">${ctx.tx('admin_tags_presets_count', { count: list.length, max: MAX_OFFERED })}</p>`;
            // Redrawn by other views' saves and the library list answer too: keep focus on the same preset's button.
            A.redrawList(box, count + (list.length ? `<ul class="je-ta-list je-ta-offered-list">${list.map((p) => `<li data-offer-id="${ctx.esc(p.id)}">
                    <span class="je-ta-offered-text"><strong>${ctx.esc(p.name)}</strong>${p.description ? `<span class="je-ta-hint">${ctx.esc(p.description)}</span>` : ''}</span>
                    <span class="je-ta-offered-buttons">
                        <button type="button" class="je-ta-button" data-offer-action="share" aria-label="${ctx.tx('tag_presets_share_named', { name: p.name })}">${ctx.tx('tag_presets_share')}</button>
                        <button type="button" class="je-ta-button" data-offer-action="remove" aria-label="${ctx.tx('admin_tags_presets_remove_named', { name: p.name })}">${ctx.tx('remove_button_text')}</button>
                    </span></li>`).join('')}</ul>` : `<p class="je-ta-hint">${ctx.tx('admin_tags_presets_none')}</p>`), (el) => {
                const id = el.closest('[data-offer-id]')?.getAttribute('data-offer-id');
                const act = el.dataset.offerAction;
                return id && act ? `[data-offer-id="${id.replace(/["\\]/g, '\\$&')}"] [data-offer-action="${act}"]` : null;
            });
            const full = list.length >= MAX_OFFERED;
            for (const id of ['#jeTaOfferMine', '#jeTaOfferImport']) {
                const button = /** @type {HTMLButtonElement|null} */ (body.querySelector(id));
                if (button) button.disabled = full;
            }
        },
    });
})(window.JellyfinEnhanced);
