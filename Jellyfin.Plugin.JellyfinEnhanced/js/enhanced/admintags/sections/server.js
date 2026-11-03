/**
 * @file Media Tags admin page, Server tab: the server tag cache (on/off,
 * excluded libraries, rebuild, the browser fallback cache and its
 * lifetime, clearing every browser's cache) and Native Poster Tags.
 */
(function(JE) {
    'use strict';

    const A = JE.adminTags;
    if (!A) return;

    /**
     * Each page view's library list: null until that view's own request
     * answers (a list from an earlier view, or another server's, is never
     * shown or written), failed when it could not be read.
     * @type {WeakMap<Object, {folders: Array<{ItemId: string, Name: string}>|null, failed: boolean}>}
     */
    const libraryState = new WeakMap();

    /** @param {Object} ctx @returns {{folders: Array<{ItemId: string, Name: string}>|null, failed: boolean}} */
    const librariesOf = (ctx) => {
        let state = libraryState.get(ctx);
        if (!state) libraryState.set(ctx, state = { folders: null, failed: false });
        return state;
    };

    /** @param {*} id @returns {string} A library id as TagCacheExcludedLibraryIds stores it. */
    const normId = (id) => String(id).replace(/-/g, '').toLowerCase();

    /** @param {*} value @returns {string[]} The stored excluded ids, as stored. */
    const excludedIds = (value) => String(value || '').split(',').map((s) => s.trim()).filter(Boolean);

    A.registerSection({
        id: 'server-cache',
        tab: 'server',
        order: 10,
        title: 'admin_tags_overview_cache',
        hint: 'admin_tags_server_cache_desc',
        writes: ['ClearLocalStorageTimestamp', 'TagCacheExcludedLibraryIds'],
        fields: [
            { id: 'tagCacheServerMode', key: 'TagCacheServerMode', type: 'switch', label: 'admin_tags_server_cache_on', desc: 'admin_tags_server_cache_on_desc', read: (v) => v !== false, onChange: (on) => (on ? {} : { EnableTagsLocalStorageFallback: true }) },
            { id: 'tagCacheExcludeLibraries', key: 'TagCacheExcludeLibraries', type: 'switch', label: 'admin_tags_server_exclude', desc: 'admin_tags_server_exclude_desc', when: (c) => c.TagCacheServerMode !== false },
            // Without the server cache the browser fallback cache is always used (as on the old page).
            { id: 'enableTagsLocalStorageFallback', key: 'EnableTagsLocalStorageFallback', type: 'switch', label: 'admin_tags_server_fallback', desc: 'admin_tags_server_fallback_desc', visible: (c) => c.TagCacheServerMode === false, when: () => false, read: () => true },
            { id: 'tagsCacheTtlDays', key: 'TagsCacheTtlDays', type: 'number', min: 1, max: 365, fallback: 30, unit: 'admin_tags_days', label: 'admin_tags_server_ttl', desc: 'admin_tags_server_ttl_desc', read: (v) => Number(v) || 30 },
        ],
        render(ctx, body) {
            body.innerHTML = `<div class="je-ta-libs" data-libs role="group" aria-label="${ctx.tx('admin_tags_server_exclude_list')}"><p class="je-ta-hint">${ctx.tx('hidden_content_admin_loading')}</p></div>
                <div class="je-ta-actions">
                    <button type="button" class="je-ta-button" id="rebuildTagCacheBtn"><span class="material-icons" aria-hidden="true">refresh</span>${ctx.tx('admin_tags_rebuild')}</button>
                    <button type="button" class="je-ta-button" id="clearTagsCacheBtn"><span class="material-icons" aria-hidden="true">delete_sweep</span>${ctx.tx('admin_tags_server_clear')}</button>
                </div>
                <p class="je-ta-hint" data-cache-help></p>`;
            body.querySelector('#rebuildTagCacheBtn')?.addEventListener('click', () => A.rebuildCache(ctx));
            body.querySelector('#clearTagsCacheBtn')?.addEventListener('click', async () => {
                const ok = await ctx.confirm(JE.t('admin_tags_server_clear_confirm'), JE.t('admin_tags_server_clear'));
                if (!ok) return;
                ctx.set('ClearLocalStorageTimestamp', Date.now());
                const saved = await ctx.flush();
                if (ctx.isCurrent()) ctx.snack(JE.t(saved ? 'admin_tags_server_clear_done' : 'admin_tags_server_clear_failed'));
            });
            const libs = /** @type {HTMLElement} */ (body.querySelector('[data-libs]'));
            libs.addEventListener('change', (e) => {
                const box = /** @type {HTMLInputElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('input[data-library-id]'));
                if (!box || !librariesOf(ctx).folders) return;
                // Only the clicked library's membership changes: every other stored id
                // (a library this list does not show, too) is kept as it is.
                const id = box.dataset.libraryId || '';
                const ids = excludedIds(ctx.config.TagCacheExcludedLibraryIds).filter((x) => normId(x) !== id);
                if (box.checked) ids.push(id);
                ctx.set('TagCacheExcludedLibraryIds', ids.join(','));
            });
            const state = librariesOf(ctx);
            ApiClient.getJSON(ApiClient.getUrl('Library/VirtualFolders')).then((list) => {
                if (!ctx.isCurrent()) return;
                state.folders = (list || []).filter((f) => f.ItemId);
                state.failed = false;
                ctx.refresh({ controls: false });
            }).catch(() => {
                // Until the list is in, nothing is written: the stored selection stays as it is.
                if (!ctx.isCurrent()) return;
                state.failed = true;
                ctx.refresh({ controls: false });
            });
        },
        refresh(ctx, body) {
            if (!body) return;
            const c = ctx.config;
            const cacheOn = c.TagCacheServerMode !== false;
            const libs = /** @type {HTMLElement} */ (body.querySelector('[data-libs]'));
            libs.hidden = !(cacheOn && c.TagCacheExcludeLibraries === true);
            if (!ctx.isCurrent()) return;
            const { folders, failed } = librariesOf(ctx);
            if (!folders) {
                const key = failed ? 'admin_tags_server_libraries_failed' : 'hidden_content_admin_loading';
                if (libs.dataset.libsState !== key) {
                    libs.dataset.libsState = key;
                    libs.innerHTML = `<p class="je-ta-hint">${ctx.tx(key)}</p>`;
                }
            } else {
                const selected = excludedIds(c.TagCacheExcludedLibraryIds).map(normId);
                const ids = folders.map((f) => normId(f.ItemId));
                const rows = /** @type {HTMLInputElement[]} */ (Array.from(libs.querySelectorAll('input[data-library-id]')));
                if (libs.dataset.libsState === 'list' && rows.length === ids.length && rows.every((r, i) => r.dataset.libraryId === ids[i])) {
                    // The same libraries: update in place (a focused box keeps focus).
                    rows.forEach((r, i) => {
                        r.checked = selected.includes(ids[i]);
                        const name = /** @type {HTMLElement} */ (r.nextElementSibling);
                        if (name && name.textContent !== folders[i].Name) name.textContent = folders[i].Name;
                    });
                } else {
                    libs.dataset.libsState = 'list';
                    A.redrawList(libs, folders.map((f, i) => `<label><input type="checkbox" data-library-id="${ctx.esc(ids[i])}" ${selected.includes(ids[i]) ? 'checked' : ''}><span>${ctx.esc(f.Name)}</span></label>`).join(''),
                        (el) => (el.dataset.libraryId ? `[data-library-id="${el.dataset.libraryId}"]` : null));
                }
            }
            /** @type {HTMLButtonElement} */ (body.querySelector('#rebuildTagCacheBtn')).hidden = !cacheOn;
            /** @type {HTMLButtonElement} */ (body.querySelector('#clearTagsCacheBtn')).hidden = cacheOn;
            const help = body.querySelector('[data-cache-help]');
            if (help) help.textContent = JE.t(cacheOn ? 'admin_tags_server_rebuild_desc' : 'admin_tags_server_clear_desc');
        },
    });

    A.registerSection({
        id: 'server-native',
        tab: 'server',
        order: 20,
        title: 'panel_media_tags_server_native',
        hint: 'admin_tags_server_native_desc',
        fields: [
            { id: 'nativePosterTagsEnabled', key: 'NativePosterTagsEnabled', type: 'switch', label: 'admin_tags_server_native_on', desc: 'admin_tags_server_native_on_desc' },
            { id: 'nativePosterTagsWebClientNames', key: 'NativePosterTagsWebClientNames', type: 'textarea', label: 'admin_tags_server_native_clients', desc: 'admin_tags_server_native_clients_desc', placeholder: 'admin_tags_server_native_clients_placeholder', when: (c) => c.NativePosterTagsEnabled === true },
        ],
        render(ctx, body) {
            body.innerHTML = `<ul class="je-ta-list">${['admin_tags_server_native_note_1', 'admin_tags_server_native_note_2', 'admin_tags_server_native_note_3', 'admin_tags_server_native_note_4'].map((k) => `<li>${ctx.tx(k)}</li>`).join('')}</ul>`;
        },
    });
})(window.JellyfinEnhanced);
