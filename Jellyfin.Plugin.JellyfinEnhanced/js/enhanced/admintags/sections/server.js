/**
 * @file Media Tags admin page, Server tab: the server tag cache (on/off,
 * excluded libraries, rebuild, the browser fallback cache and its
 * lifetime, clearing every browser's cache) and Native Poster Tags.
 */
(function(JE) {
    'use strict';

    const A = JE.adminTags;
    if (!A) return;

    /** @type {Array<{ItemId: string, Name: string}>|null} null until the library list is in */
    let folders = null;

    /** @param {*} id @returns {string} A library id as TagCacheExcludedLibraryIds stores it. */
    const normId = (id) => String(id).replace(/-/g, '').toLowerCase();

    A.registerSection({
        id: 'server-cache',
        tab: 'server',
        order: 10,
        title: 'admin_tags_server_cache',
        hint: 'admin_tags_server_cache_desc',
        fields: [
            { id: 'tagCacheServerMode', key: 'TagCacheServerMode', type: 'switch', label: 'admin_tags_server_cache_on', desc: 'admin_tags_server_cache_on_desc', read: (v) => v !== false, onChange: (on) => (on ? {} : { EnableTagsLocalStorageFallback: true }) },
            { id: 'tagCacheExcludeLibraries', key: 'TagCacheExcludeLibraries', type: 'switch', label: 'admin_tags_server_exclude', desc: 'admin_tags_server_exclude_desc', when: (c) => c.TagCacheServerMode !== false },
            // Without the server cache the browser fallback cache is always used (as on the old page).
            { id: 'enableTagsLocalStorageFallback', key: 'EnableTagsLocalStorageFallback', type: 'switch', label: 'admin_tags_server_fallback', desc: 'admin_tags_server_fallback_desc', visible: (c) => c.TagCacheServerMode === false, when: () => false, read: () => true },
            { id: 'tagsCacheTtlDays', key: 'TagsCacheTtlDays', type: 'number', min: 1, max: 365, fallback: 30, unit: 'admin_tags_days', label: 'admin_tags_server_ttl', desc: 'admin_tags_server_ttl_desc', read: (v) => Number(v) || 30 },
        ],
        render(ctx, body) {
            body.innerHTML = `<div class="je-ta-libs" data-libs role="group" aria-label="${ctx.tx('admin_tags_server_exclude_list')}"><p class="je-ta-hint">${ctx.tx('admin_tags_loading')}</p></div>
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
                ctx.snack(JE.t(await ctx.flush() ? 'admin_tags_server_clear_done' : 'admin_tags_server_clear_failed'));
            });
            const libs = /** @type {HTMLElement} */ (body.querySelector('[data-libs]'));
            libs.addEventListener('change', () => {
                const ids = Array.from(libs.querySelectorAll('input:checked')).map((el) => /** @type {HTMLElement} */ (el).dataset.libraryId || '');
                ctx.set('TagCacheExcludedLibraryIds', ids.join(','));
            });
            ApiClient.getJSON(ApiClient.getUrl('Library/VirtualFolders')).then((list) => {
                folders = (list || []).filter((f) => f.ItemId);
                ctx.refresh({ controls: false });
            }).catch(() => {
                // Until the list is in, nothing is written: the stored selection stays as it is.
                libs.innerHTML = `<p class="je-ta-hint">${ctx.tx('admin_tags_server_libraries_failed')}</p>`;
            });
        },
        refresh(ctx, body) {
            if (!body) return;
            const c = ctx.config;
            const cacheOn = c.TagCacheServerMode !== false;
            const libs = /** @type {HTMLElement} */ (body.querySelector('[data-libs]'));
            libs.hidden = !(cacheOn && c.TagCacheExcludeLibraries === true);
            if (folders && !libs.contains(document.activeElement)) {
                const selected = String(c.TagCacheExcludedLibraryIds || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
                libs.innerHTML = folders.map((f) => `<label><input type="checkbox" data-library-id="${ctx.esc(normId(f.ItemId))}" ${selected.includes(normId(f.ItemId)) ? 'checked' : ''}>${ctx.esc(f.Name)}</label>`).join('');
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
        title: 'admin_tags_server_native',
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
