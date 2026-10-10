// /js/jellyseerr/listplaceholders/listplaceholders-source.js
// Import entry points and the linked-source UI (B9):
// - the toolbar "Import list" button (editors, playlist + collection pages);
// - the toolbar source chip of a list linked to MDBList/TMDB/Trakt/IMDb: last sync and its
//   result or the pause reason, with Sync now, Keep in sync, Remove entries that leave the
//   list, Open the list's page and Unlink in its menu;
// - the global "Import list…" button next to "New Playlist" on the Playlists library view.
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const lp = JE.internals.listPlaceholders = JE.internals.listPlaceholders || {};

    /** Re-fetches after Sync now answered "still running" (the server already waited ~25 s), until the sync is recorded. */
    const SYNC_RECHECK_MS = [5000, 10000, 20000, 40000, 60000, 60000];
    const LIBRARY_WAIT_TRIES = 24;
    const LIBRARY_WAIT_MS = 250;
    const PAUSE_KEYS = {
        linker_missing: 'listPlaceholders_sourcePausedLinkerMissing',
        linker_cannot_edit: 'listPlaceholders_sourcePausedLinkerCannotEdit',
        linker_cannot_see: 'listPlaceholders_sourcePausedLinkerCannotSee',
        url_unsupported: 'listPlaceholders_sourcePausedUrlUnsupported'
    };
    const SITE_NAMES = { mdblist: 'MDBList', tmdb: 'TMDB', trakt: 'Trakt', imdb: 'IMDb', chronolists: 'chronolists.com' };
    /** Sync-only failure codes (fetch codes are shared with the importer's messages). */
    const SYNC_FAILURE_KEYS = {
        seerr_unavailable: 'listPlaceholders_import_err_seerr',
        source_changed: 'listPlaceholders_sourceFailedChanged',
        apply_failed: 'listPlaceholders_sourceFailedApply',
        cancelled: 'listPlaceholders_sourceSyncInterrupted'
    };

    /** App bars that already watch for the library toolbar (header element → MutationObserver). */
    const libraryObservers = new WeakMap();

    /**
     * Whether the import can be offered (feature on and Seerr configured).
     * @returns {boolean}
     */
    function canImport() {
        return lp.isEnabled() && JE.pluginConfig?.JellyseerrEnabled === true;
    }

    /**
     * Short local date/time of an ISO timestamp.
     * @param {string} iso
     * @returns {string}
     */
    function formatTime(iso) {
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return '';
        try {
            return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
        } catch (_) {
            return date.toLocaleString();
        }
    }

    /**
     * The name shown for a linked source: its title, else the site name.
     * @param {Object} source - ListSourceDto.
     * @returns {string}
     */
    function sourceName(source) {
        return source?.title || SITE_NAMES[source?.kind] || source?.kind || '';
    }

    /**
     * Why a sync failed, in words: a known code's message, else the server's text, never a bare code.
     * @param {string|undefined} code - Failure code (SourceSyncSummary.code / SourceSyncResultDto.code).
     * @param {string|undefined} fallback - The server's English message.
     * @returns {string}
     */
    function failureReason(code, fallback) {
        if (code && SYNC_FAILURE_KEYS[code]) return JE.t(SYNC_FAILURE_KEYS[code]);
        const key = lp.importer?.sourceErrorKey?.(code);
        if (key) return JE.t(key);
        return fallback || JE.t('listPlaceholders_err_generic');
    }

    /**
     * Result of the last sync in words (from the structured summary, falling back to the server's English text).
     * Callers who don't see every entry get no counts (source.countsHidden): only the time and the outcome.
     * @param {Object} source - ListSourceDto.
     * @returns {string}
     */
    function lastSyncText(source) {
        const last = source?.lastSync;
        let result;
        if (last?.state === 'failed') {
            result = JE.t('listPlaceholders_sourceSyncFailed', { reason: failureReason(last.code, source.lastSyncResult) });
        } else if (source?.countsHidden) {
            result = last?.partial ? JE.t('listPlaceholders_sourceSyncPartial') : '';
            if (source.lastSyncAt && !result) return JE.t('listPlaceholders_sourceLastSyncAt', { time: formatTime(source.lastSyncAt) });
        } else if (last) {
            const parts = [JE.t('listPlaceholders_sourceSyncStats', { added: last.added || 0, removed: last.removed || 0, kept: last.kept || 0, unresolved: last.unresolved || 0 })];
            if (last.listFull) parts.push(JE.t('listPlaceholders_skip_list_full'));
            if (last.partial) parts.push(JE.t('listPlaceholders_sourceSyncPartial'));
            result = parts.join(' ');
        } else {
            result = source?.lastSyncResult || '';
        }
        if (!source?.lastSyncAt) return result || JE.t('listPlaceholders_source_never_synced');
        return JE.t('listPlaceholders_sourceLastSync', { time: formatTime(source.lastSyncAt), result });
    }

    /**
     * Why syncing is paused, or '' when it isn't.
     * @param {Object} source - ListSourceDto.
     * @returns {string}
     */
    function pausedText(source) {
        if (source?.pausedCode && PAUSE_KEYS[source.pausedCode]) return JE.t(PAUSE_KEYS[source.pausedCode]);
        if (source?.pausedReason) return JE.t('listPlaceholders_sourcePaused', { reason: source.pausedReason });
        if (source?.pausedCode) return JE.t('listPlaceholders_sourcePaused', { reason: source.pausedCode });
        return '';
    }

    /**
     * The source's page, when it is a plain https URL.
     * @param {Object} source
     * @returns {string|null}
     */
    function safeUrl(source) {
        try {
            const url = new URL(String(source?.url || ''));
            return url.protocol === 'https:' ? url.href : null;
        } catch (_) {
            return null;
        }
    }

    /**
     * The toolbar's "Import list" button.
     * @param {Object} ctrl - Page controller.
     * @returns {HTMLButtonElement}
     */
    function createImportButton(ctrl) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'je-lp-toolbar-btn je-lp-import-btn';
        const icon = document.createElement('span');
        icon.className = 'material-icons';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = 'playlist_add';
        const text = document.createElement('span');
        text.textContent = JE.t('listPlaceholders_import_button');
        button.append(icon, text);
        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            lp.importer?.open({ ctrl });
        });
        return button;
    }

    /**
     * Adds the import button to a toolbar (once) and keeps the source chip current.
     * @param {HTMLElement} bar - The toolbar (listplaceholders-search.js).
     * @param {Object} ctrl - Page controller.
     */
    function decorateToolbar(bar, ctrl) {
        if (!bar || !ctrl) return;
        if (canImport() && lp.importer && !bar.querySelector('.je-lp-import-btn')) {
            const addButton = bar.querySelector('.je-lp-toolbar-btn');
            const button = createImportButton(ctrl);
            if (addButton) addButton.after(button); else bar.appendChild(button);
        }
        renderChip(bar, ctrl);
    }

    /**
     * Renders (or removes) the source chip from the controller's view.
     * @param {HTMLElement} bar
     * @param {Object} ctrl
     */
    function renderChip(bar, ctrl) {
        const source = ctrl.view?.source;
        let chip = bar.querySelector('.je-lp-source-chip');
        if (!source) {
            chip?.remove();
            return;
        }
        const paused = pausedText(source);
        const status = paused || lastSyncText(source);
        const signature = JSON.stringify([source.url, source.title, source.syncEnabled, source.removeDropped, status]);
        if (chip && chip.dataset.signature === signature) return;
        if (!chip) {
            chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'je-lp-source-chip';
            chip.setAttribute('aria-haspopup', 'menu');
            chip.setAttribute('aria-expanded', 'false');
            chip.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                showMenu(ctrl, chip);
            });
            const label = bar.querySelector('.je-lp-toolbar-label');
            if (label) label.after(chip); else bar.prepend(chip);
        }
        chip.dataset.signature = signature;
        chip.classList.toggle('je-lp-source-paused', !!paused);
        chip.classList.toggle('je-lp-source-off', !source.syncEnabled);
        const esc = lp.render.esc;
        const icon = paused ? 'pause_circle' : source.syncEnabled ? 'sync' : 'sync_disabled';
        const name = JE.t('listPlaceholders_source_linked', { name: sourceName(source) });
        chip.innerHTML = `<span class="material-icons" aria-hidden="true">${icon}</span>`
            + `<span class="je-lp-source-text"><span class="je-lp-source-name">${esc(name)}</span><span class="je-lp-source-status">${esc(status)}</span></span>`;
        chip.title = `${name} — ${status}`;
        chip.setAttribute('aria-label', `${name}. ${status}`);
    }

    /**
     * The chip's menu.
     * @param {Object} ctrl
     * @param {HTMLElement} anchor
     */
    function showMenu(ctrl, anchor) {
        const source = ctrl.view?.source;
        if (!source || !ctrl.view?.canEdit) return;
        const items = [
            { icon: 'sync', label: JE.t('listPlaceholders_sourceSyncNow'), onClick: () => syncNow(ctrl, anchor) },
            {
                icon: source.syncEnabled ? 'check_box' : 'check_box_outline_blank',
                label: JE.t('listPlaceholders_sourceKeepInSync'),
                onClick: () => setOptions(ctrl, { syncEnabled: !source.syncEnabled })
            },
            {
                icon: source.removeDropped ? 'check_box' : 'check_box_outline_blank',
                label: JE.t('listPlaceholders_sourceRemoveDropped'),
                onClick: () => setOptions(ctrl, { removeDropped: !source.removeDropped })
            }
        ];
        const url = safeUrl(source);
        if (url) items.push({ icon: 'open_in_new', label: JE.t('listPlaceholders_source_open'), onClick: () => window.open(url, '_blank', 'noopener,noreferrer') });
        items.push({ icon: 'link_off', label: JE.t('listPlaceholders_sourceUnlink'), danger: true, onClick: () => unlink(ctrl) });
        lp.actions.openMenu(anchor, items);
    }

    /**
     * "Sync now": 200 → the fresh view is published and the result toasted; 202 → the sync is still running on the
     * server, so the view is re-fetched with backoff (the chip stays busy) until the sync's result is recorded.
     * @param {Object} ctrl
     * @param {HTMLElement} [chip] - The chip (shows a busy state).
     * @returns {Promise<void>}
     */
    async function syncNow(ctrl, chip) {
        const esc = lp.render.esc;
        const before = ctrl.view?.source?.lastSyncAt || null;
        const epoch = lp.epochNow();
        chip?.classList.add('je-lp-source-busy');
        JE.toast(esc(JE.t('listPlaceholders_sourceSyncRunning')), 2000);
        try {
            const result = await lp.api.syncSource(ctrl.listId);
            if (result?.state === 'running') {
                if (result.code === 'cancelled') {
                    JE.toast(esc(failureReason(result.code, result.message)), 6000);
                    return;
                }
                const source = await waitForSync(ctrl, before, epoch);
                if (source && lp.isCurrentEpoch(epoch)) JE.toast(esc(pausedText(source) || lastSyncText(source)), 6000);
                return;
            }
            if (result?.state === 'paused') {
                JE.toast(esc(pausedText({ pausedCode: result.code, pausedReason: result.message }) || result.message || ''), 6000);
            } else if (result?.state === 'failed') {
                JE.toast(esc(JE.t('listPlaceholders_sourceSyncFailed', { reason: failureReason(result.code, result.message) })), 6000);
            } else if (result?.countsHidden) {
                JE.toast(esc(JE.t('listPlaceholders_sourceSynced')), 5000);
            } else {
                JE.toast(esc(JE.t('listPlaceholders_sourceSyncStats', { added: result?.added || 0, removed: result?.removed || 0, kept: result?.kept || 0, unresolved: result?.unresolved || 0 })), 5000);
            }
            if ((result?.added || result?.countsHidden) && ctrl.listKind === 'collection') ctrl.afterRealItemsAdded?.();
        } catch (error) {
            lp.toastError(error);
        } finally {
            chip?.classList.remove('je-lp-source-busy');
        }
    }

    /**
     * Re-fetches the view with backoff until the running sync recorded its result (lastSyncAt changed) or the
     * schedule ends. Stops when the page goes away, the user switches or another Sync now takes over.
     * @param {Object} ctrl - Page controller (load, view, isAlive).
     * @param {string|null} before - lastSyncAt before Sync now.
     * @param {number} epoch - Identity epoch of the Sync now.
     * @returns {Promise<Object|null>} The source with the new result, or null.
     */
    async function waitForSync(ctrl, before, epoch) {
        const token = {};
        ctrl.syncWait = token;
        const current = () => ctrl.syncWait === token && lp.isCurrentEpoch(epoch) && ctrl.isAlive?.() !== false;
        for (const delay of SYNC_RECHECK_MS) {
            await new Promise(resolve => setTimeout(resolve, delay));
            if (!current()) return null;
            await ctrl.load?.();
            if (!current()) return null;
            const source = ctrl.view?.source;
            if (!source) return null; // unlinked meanwhile
            if ((source.lastSyncAt || null) !== before) {
                if ((source.lastSync?.added || source.countsHidden) && ctrl.listKind === 'collection') ctrl.afterRealItemsAdded?.();
                return source;
            }
        }
        return null;
    }

    /**
     * Changes "Keep in sync" / "Remove entries that leave the list" (PUT /source with the same URL).
     * @param {Object} ctrl
     * @param {{syncEnabled?: boolean, removeDropped?: boolean}} change
     * @returns {Promise<void>}
     */
    async function setOptions(ctrl, change) {
        const source = ctrl.view?.source;
        if (!source) return;
        try {
            await lp.api.linkSource(ctrl.listId, {
                url: source.url,
                syncEnabled: change.syncEnabled ?? source.syncEnabled,
                removeDropped: change.removeDropped ?? source.removeDropped
            });
        } catch (error) {
            if (lp.isStaleIdentityError(error)) return;
            const code = error?.responseJSON?.code;
            if (code && lp.importer?.sourceErrorText && code !== 'forbidden' && error.status !== 404) JE.toast(lp.render.esc(lp.importer.sourceErrorText(error)), 5000);
            else lp.toastError(error);
        }
    }

    /**
     * Unlinks the source (the list keeps its entries).
     * @param {Object} ctrl
     * @returns {Promise<void>}
     */
    async function unlink(ctrl) {
        try {
            await lp.api.unlinkSource(ctrl.listId);
            JE.toast(lp.render.esc(JE.t('listPlaceholders_source_unlinked')), 3000);
        } catch (error) {
            lp.toastError(error);
        }
    }

    // ── Playlists library view: global "Import list…" (new playlist) ──

    /**
     * Whether a route is the Playlists library view.
     * @param {string} hash
     * @returns {boolean}
     */
    function isPlaylistsView(hash) {
        const value = String(hash || '');
        return /^#\/playlists(?:\.html)?(?:\?|$)/i.test(value) || /collectionType=playlists/i.test(value);
    }

    /**
     * The library toolbar's "New Playlist" button. jellyfin-web 12 renders it in the app bar (outside the page
     * element), and MUI gives its icon data-testid="PlaylistAddIcon".
     * @returns {HTMLElement|null}
     */
    function findNewPlaylistButton() {
        const icon = document.querySelector('header button svg[data-testid="PlaylistAddIcon"], .libraryPage:not(.hide) button svg[data-testid="PlaylistAddIcon"]');
        return icon ? icon.closest('button') : null;
    }

    /**
     * Inserts the global button next to "New Playlist" (idempotent).
     * @returns {boolean} Whether the button is (now) present.
     */
    function ensureLibraryButton() {
        const anchor = findNewPlaylistButton();
        if (!anchor) return false;
        if (anchor.parentElement?.querySelector(':scope > .je-lp-import-global')) return true;
        document.querySelectorAll('.je-lp-import-global').forEach(old => old.remove());
        lp.ensureStyles?.();
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'je-lp-import-global';
        const label = JE.t('listPlaceholders_import_global');
        button.title = label;
        button.setAttribute('aria-label', label);
        const icon = document.createElement('span');
        icon.className = 'material-icons';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = 'format_list_numbered';
        const text = document.createElement('span');
        text.className = 'je-lp-import-global-text';
        text.textContent = label;
        button.append(icon, text);
        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            lp.importer?.open({ mode: 'new' });
        });
        anchor.after(button);
        return true;
    }

    /** Removes the global button (another view is showing). */
    function removeLibraryButton() {
        document.querySelectorAll('.je-lp-import-global').forEach(button => button.remove());
    }

    /**
     * Shows the global button on the Playlists library view (and removes it elsewhere). React renders the toolbar
     * after the route changes and may re-render it: a light observer on the app bar puts the button back.
     * @param {HTMLElement|null} element - The page from the view-show hook (null for React routes).
     * @param {string} hash
     */
    function onViewShow(element, hash) {
        if (!canImport() || !isPlaylistsView(hash)) {
            removeLibraryButton();
            return;
        }
        let tries = 0;
        /** Waits for React to render the toolbar. */
        const attempt = () => {
            if (!isPlaylistsView(window.location.hash)) return;
            if (ensureLibraryButton()) {
                watchAppBar(findNewPlaylistButton()?.closest('header'));
                return;
            }
            if (++tries < LIBRARY_WAIT_TRIES) setTimeout(attempt, LIBRARY_WAIT_MS);
        };
        attempt();
    }

    /**
     * Re-adds the button after React re-renders the toolbar (rAF-debounced; only on the Playlists view).
     * @param {HTMLElement|null|undefined} header - The app bar.
     */
    function watchAppBar(header) {
        if (!header || libraryObservers.has(header) || typeof MutationObserver === 'undefined') return;
        let scheduled = false;
        const observer = new MutationObserver(() => {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(() => {
                scheduled = false;
                if (!header.isConnected) {
                    observer.disconnect();
                    libraryObservers.delete(header);
                    return;
                }
                if (isPlaylistsView(window.location.hash) && canImport()) ensureLibraryButton();
                else removeLibraryButton();
            });
        });
        observer.observe(header, { childList: true, subtree: true });
        libraryObservers.set(header, observer);
    }

    lp.sourceUi = {
        canImport,
        decorateToolbar,
        renderChip,
        lastSyncText,
        failureReason,
        pausedText,
        sourceName,
        syncNow,
        setOptions,
        unlink,
        isPlaylistsView,
        ensureLibraryButton,
        onViewShow
    };

})(window.JellyfinEnhanced);
