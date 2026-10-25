/**
 * @file Hidden Content — data store, lookup sets, and the public data API.
 * Split from hidden-content.js (code motion; bodies verbatim). Owns the
 * hiddenData closure variable and the ID lookup Sets; every other
 * hidden-content-* module reads state through the functions exported here.
 */
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.hiddenContent = JE.internals.hiddenContent || {};

    // Late-bound cross-module references (defined in the later-loaded
    // hidden-content-save/dialogs/filter modules).
    const persist = (...args) => internal.persist(...args);
    const showUndoToast = (...args) => internal.showUndoToast(...args);
    const refreshNativeCardVisibility = (...args) => internal.refreshNativeCardVisibility(...args);

    // ============================================================
    // State
    // ============================================================

    const hiddenIdSet = new Set();
    const hiddenTmdbIdSet = new Set();
    const knownTitles = new Map();
    let hiddenData = null;
    let rulesGeneration = 0;
    // The document revision (core/access-revision.js) the rules were read under, taken BEFORE the read; null: unknown.
    // Another tab or device saving the rules moves it: the rules are read again, in place.
    let loadedRevision = null;
    // A newer revision was seen while the rules couldn't be read again (a save of this tab pending, a read running).
    let revisionPending = false;
    /** @type {Promise<boolean>|null} */
    let revalidating = null;

    // ============================================================
    // Internal helpers
    // ============================================================

    /**
     * Canonicalises a Jellyfin item ID for comparison.
     *
     * Item IDs reach this module in two shapes: the server writes GUIDs dashed
     * ("N" vs "D" format) into hidden-content.json, while cards carry them
     * undashed in `data-id`. Comparing the raw strings silently never matches,
     * so every lookup key and every ID read off the DOM goes through here.
     * @param {*} id Raw ID from the store, an API payload, or a DOM attribute.
     * @returns {string} Lowercase, dash-free ID, or '' when there is nothing usable.
     */
    function normalizeId(id) {
        if (!id) return '';
        if (typeof id !== 'string' && typeof id !== 'number' && typeof id !== 'bigint') return '';
        return String(id).replace(/-/g, '').toLowerCase();
    }

    /** Canonical typed title identity. Ambiguous legacy metadata never spans movie and TV. */
    function titleKey(type, tmdbId) {
        const kind = String(type || '').toLowerCase();
        const id = Number(tmdbId);
        if (!Number.isInteger(id) || id <= 0 || id > 0x7fffffff) return '';
        return (kind === 'movie' ? 'movie' : kind === 'tv' || kind === 'series' ? 'tv' : '') &&
            `${kind === 'movie' ? 'movie' : 'tv'}:tmdb:${id}`;
    }

    /** Gets provider metadata from a known card or a checksum-validated native page identity. */
    function titleData(data) {
        const parts = JE.titleDetails?.parse?.(data.itemId || data.Id || data.id);
        if (parts && !['movie', 'series', 'season', 'episode'].includes(parts.kind)) return null;
        const itemId = data.itemId || data.Id;
        const known = knownTitles.get(normalizeId(itemId));
        const key = titleKey(parts?.kind === 'movie' ? 'movie' : ['series', 'season', 'episode'].includes(parts?.kind) ? 'tv' : data.mediaType || data.kind || data.type || data.Type,
            parts?.tmdbId || data.tmdbId || data.ProviderIds?.Tmdb || (data.mediaType ? data.id : null)) || known;
        if (!key) return null;
        if (itemId && !parts) {
            knownTitles.set(normalizeId(itemId), key);
            if (knownTitles.size > 1024) knownTitles.delete(knownTitles.keys().next().value);
        }
        return { ...data, itemId: '', seriesId: '', type: key.startsWith('movie:') ? 'Movie' : 'Series',
            tmdbId: key.split(':')[2], hideScope: 'global', key };
    }

    let persistence = Promise.resolve();
    /** Serializes bulk and atomic writes in this tab; each task validates its captured viewer. */
    function enqueuePersistence(work) {
        const next = persistence.catch(() => {}).then(work);
        persistence = next;
        return next;
    }
    const ruleWrites = new Map();
    /**
     * Saves a single provider rule. No optimistic success, stale-user writes or full-document replacement. `owner`: the
     * owner token a title action (or the viewer's own press) wrote it for (it must still be current right before the
     * write), or the node or press it comes from; none (null): the library's own hide controls outside every title
     * action, a session-bound write with no authority of its own (refused inside an operation, D46S2-R10-1).
     */
    function saveTitleRule(data, hidden, owner) {
        const title = titleData(data);
        if (!title) return Promise.resolve(false);
        const user = ApiClient.getCurrentUserId();
        const action = JE.createSessionAction();
        const submitted = owner ? JE.createSessionAction({ owner }) : JE.createSessionAction();
        const previous = ruleWrites.get(title.key) || Promise.resolve();
        // Queue the pending debounce before the atomic write; its acknowledgement is our rule base.
        const flushed = internal.flushPendingSave?.() || Promise.resolve();
        const task = flushed.then(() => previous.catch(() => {})).then(() => enqueuePersistence(async () => {
            if (!action.current() || !submitted.writable()) return false;
            const beforeRules = JSON.parse(JSON.stringify(getHiddenData().items || {}));
            const item = { itemId: '', seriesId: '', type: title.type, tmdbId: title.tmdbId,
                name: title.name || title.title || '', posterPath: title.posterPath || '', hideScope: 'global', hiddenAt: new Date().toISOString() };
            // The transport checks the operation (if any) again right before the bytes go out. Three outcomes (D46S2-R11-9):
            // never sent → nothing changed; answered after its owner ended (accepted) → this session's rules are
            // reconciled from the answer with no page effect; answered → as below.
            let reply;
            let accepted = false;
            try {
                reply = await JE.core.api.ajax({ type: hidden ? 'PUT' : 'DELETE', dataType: 'json', bound: submitted.operationBound(),
                    url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${user}/hidden-content/rule/${encodeURIComponent(title.key)}`),
                    ...(hidden ? { data: JSON.stringify(item), contentType: 'application/json' } : {}) });
            } catch (err) {
                const written = JE.core.api.writeOutcome?.(err);
                if (written?.outcome === 'accepted' && !written.sessionChanged) { reply = written.answer; accepted = true; }
                // Taken after another account signed in (D46S2-R12-4): the origin's rule changed on the server; the new
                // account's rules and page are not touched.
                else if (written?.outcome === 'accepted') return false;
                // Never sent (D46S2-R13-5: the transport's outcome decides, never the error's name): nothing changed.
                else if (written?.outcome === 'unsent') return false;
                else throw err;
            }
            if (!action.current()) return false;
            const current = getHiddenData();
            const authoritative = reply?.items || reply?.Items;
            const items = authoritative ? (typeof JE.toCamelCase === 'function' ? JE.toCamelCase(authoritative) : authoritative) : { ...current.items };
            // A revision describes its complete rule base. Preserve edits made locally while this write awaited.
            if (authoritative) for (const key of new Set([...Object.keys(beforeRules), ...Object.keys(current.items || {})])) {
                if (JSON.stringify(beforeRules[key]) === JSON.stringify(current.items?.[key])) continue;
                if (current.items?.[key]) items[key] = current.items[key];
                else delete items[key];
            }
            for (const key of Object.keys(items)) {
                if (titleKey(items[key].type, items[key].tmdbId) === title.key && (items[key].hideScope || 'global') === 'global') delete items[key];
            }
            if (hidden) items[title.key] = typeof JE.toCamelCase === 'function' ? JE.toCamelCase(reply?.item || reply?.Item || item) : item;
            const next = { ...current, items, revision: authoritative ? reply?.revision || reply?.Revision || current.revision : current.revision };
            JE.userConfig.hiddenContent = next;
            // Taken as a publication of the document (the copy, the lookup sets, the page), as the store's are.
            followStore(next, 'rule');
            // The settings store holds the person's document too (its next publication replaces this copy): it takes what
            // the answer established, the server's rule base (when the route answered it) with this rule applied, so a
            // later item change doesn't show the title again until its own answer arrives.
            if (typeof JE.internals?.acknowledgeUserDocumentChange === 'function') {
                const sameTitle = (key, value) => titleKey(value?.type, value?.tmdbId) === title.key && (value?.hideScope || 'global') === 'global';
                const established = {};
                const removed = new Set();
                if (authoritative) {
                    const base = typeof JE.toCamelCase === 'function' ? JE.toCamelCase(authoritative) : authoritative;
                    for (const [key, value] of Object.entries(base)) if (!sameTitle(key, value)) established[key] = value;
                    for (const key of Object.keys(beforeRules)) if (!(key in base)) removed.add(key);
                }
                for (const [key, value] of Object.entries(beforeRules)) if (sameTitle(key, value)) removed.add(key);
                if (hidden) established[title.key] = items[title.key];
                for (const key of Object.keys(established)) removed.delete(key);
                JE.internals.acknowledgeUserDocumentChange('hidden-content.json', { upsert: established, remove: [...removed] },
                    authoritative ? (reply?.revision || reply?.Revision || undefined) : undefined);
            }
            if (hidden) showUndoToast(item.name, title.key);
            if (accepted) return false;
            return true;
        }));
        ruleWrites.set(title.key, task);
        task.finally(() => { if (ruleWrites.get(title.key) === task) ruleWrites.delete(title.key); readAfterSave(); }).catch(() => {});
        return task;
    }

    /** A JE-rendered card (discover, Seerr, hub, request row): native cards are decided only by the filter. */
    function jeOwnedCard(card) {
        return card && !internal.isNativeNode?.(card) ? card : null;
    }

    /** Shared control host for native pages/cards, modal and future list/home renderers. */
    function buildTitleControl(data, options = {}) {
        const title = titleData(data);
        const settings = getSettings();
        if (!title || JE.pluginConfig?.HiddenContentEnabled === false || !settings.enabled || !settings.showHideButtons ||
            (options.detail ? settings.showButtonDetails === false : settings.showButtonJellyseerr === false)) return null;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = options.detail ? 'button-flat detailButton emby-button je-detail-hide-btn' : 'je-hide-btn';
        button.dataset.jeTitleKey = title.key;
        // Drawn for this session, route and document: a press after any of them changed is no one's (D46S2-R11-1).
        JE.mountControl?.(button);
        /** Repaints only changed attributes so mutation observers settle. */
        function paint() {
            const hidden = hiddenTmdbIdSet.has(title.key);
            const label = JE.t(hidden ? 'hidden_content_unhide' : 'hidden_content_hide_button');
            const card = options.card || button.closest('.je-discover-card, .jellyseerr-card, .card, .je-hub-entry, [data-je-hide-title]');
            const surface = typeof options.surface === 'function' ? options.surface() : options.surface || 'recommendations';
            // A native card's visibility has one writer using every rule; the repaint only asks it to decide again.
            if (internal.isNativeNode?.(card)) internal.requestNativeDecision?.();
            jeOwnedCard(card)?.classList.toggle('je-hidden', hidden && shouldFilterSurface(surface));
            button.classList.toggle('je-already-hidden', hidden);
            const iconName = hidden ? 'visibility_off' : 'visibility';
            if (button.dataset.jeHideIcon !== iconName) {
                const content = document.createElement('span');
                content.className = options.detail ? 'detailButton-content' : '';
                const icon = document.createElement('span');
                icon.className = options.detail ? 'material-icons detailButton-icon' : 'material-icons';
                icon.setAttribute('aria-hidden', 'true'); icon.textContent = iconName;
                content.appendChild(icon); button.replaceChildren(content); button.dataset.jeHideIcon = iconName;
            }
            if (button.title !== label) button.title = label;
            if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
        }
        paint();
        button.onclick = async e => {
            e.preventDefault(); e.stopPropagation();
            // The press's owner (D46S2-R6): a press dispatched for a title action stays bound to that operation up to the write.
            // A title's Hide control acts only for a current owner (D46S2-R11-4): the viewer's own press or a title action's;
            // a script's click names none and hides nothing (the library's own owner-less path is saveTitleRule(…, null)).
            const owner = JE.ownerOf(e);
            if (!owner || !JE.effectOwner(owner, 'the Hide control')) return;
            if (!hiddenTmdbIdSet.has(title.key) && internal.showHideConfirmation && !internal.isConfirmationSuppressed()) {
                internal.showHideConfirmation(title.name || title.title || '', () => run(owner), { owner });
                return;
            }
            return run(owner);
        };
        /** Persists before acknowledging the action and leaves a retryable failure on the control. */
        async function run(owner) {
            // Disabled while it saves, a focused control drops the browser's focus to the page (a confirmation that just
            // closed gave it back to this control, D46S2-R14-1): once the save settles the control takes it back, for a
            // press whose owner is still current, unless the viewer moved it meanwhile or the control has gone or is covered.
            const focused = document.activeElement === button;
            button.disabled = true;
            try {
                const hidden = !hiddenTmdbIdSet.has(title.key);
                if (await saveTitleRule(title, hidden, owner)) options.onChanged?.(hidden);
                paint();
            } catch (_) {
                delete button.dataset.jeHideIcon;
                button.textContent = JE.t('hidden_content_save_failed_persistent');
                button.setAttribute('aria-label', button.textContent);
            } finally {
                button.disabled = false;
                const active = document.activeElement;
                if (focused && button.isConnected && (!active || active === document.body) && !JE.isCovered?.(button) &&
                    JE.effectOwner(owner, 'the Hide control\'s focus')) {
                    try { button.focus({ preventScroll: true }); } catch (_) { /* not focusable */ }
                }
            }
        }
        // The owner remounts copied nodes; this property never survives cloneNode.
        button.jeHiddenPaint = paint;
        button.jeHideButtonLive = true;
        return button;
    }
    /** A hidden-content document with both of its parts. */
    const withParts = doc => ({ ...(doc || {}), items: { ...((doc && doc.items) || {}) }, settings: { ...((doc && doc.settings) || {}) } });

    /**
     * The person's hidden-content.json as the settings store shows it (the server's document as last read or answered,
     * plus this page's queued changes). Every change this module makes is an item or settings operation on it
     * (see persist); this copy and the lookup sets follow each publication of the document (followStore).
     * @returns {{ items: Object, settings: Object }}
     */
    function getHiddenData() {
        if (!hiddenData) {
            hiddenData = withParts(JE.internals.userDocument ? JE.internals.userDocument('hidden-content.json').document : JE.userConfig?.hiddenContent);
        }
        return hiddenData;
    }

    /**
     * Takes a publication of the store's document: the copy, the lookup sets, the page (cards no longer hidden come back;
     * newly hidden ones go) and the management views.
     * @param {Object} doc The document as the store shows it now.
     * @param {string} [reason] Why it was published ('observed' for the registration itself).
     */
    function followStore(doc, reason) {
        hiddenData = withParts(doc);
        rebuildSets();
        if (reason === 'observed') return;
        emitChange();
        // D46: one full re-decision of the native cards shows every card the new rules no longer hide.
        refreshNativeCardVisibility();
    }

    /**
     * Returns the merged settings object (defaults + user overrides).
     * @returns {Object} Merged settings with boolean flags for every filter surface.
     */
    function getSettings() {
        const data = getHiddenData();
        return {
            enabled: true,
            filterLibrary: true,
            filterDiscovery: true,
            filterUpcoming: true,
            filterCalendar: true,
            filterSearch: false,
            filterRecommendations: true,
            filterRequests: true,
            filterNextUp: true,
            filterContinueWatching: true,
            showHideConfirmation: true,
            showHideButtons: true,
            showButtonJellyseerr: true,
            showButtonLibrary: false,
            showButtonDetails: true,
            showButtonCast: false,
            experimentalHideCollections: false,
            ...data.settings
        };
    }

    /**
     * Rebuilds the in-memory ID Sets from the current hidden-data items map.
     * Must be called after any mutation to `hiddenData.items`.
     */
    function rebuildSets() {
        rulesGeneration++;
        hiddenIdSet.clear();
        hiddenTmdbIdSet.clear();
        const data = getHiddenData();
        const items = data.items || {};
        for (const key of Object.keys(items)) {
            const item = items[key];
            const scope = item.hideScope || 'global';
            if (scope !== 'global') continue;
            if (item.itemId) hiddenIdSet.add(normalizeId(item.itemId));
            const typed = titleKey(item.type, item.tmdbId);
            if (typed) hiddenTmdbIdSet.add(typed);
        }
    }

    /**
     * Checks whether filtering is enabled for a given surface.
     * @param {string} surface One of 'library', 'details', 'discovery', 'search',
     *   'upcoming', 'calendar', 'recommendations', 'requests', 'nextup',
     *   'continuewatching'.
     * @returns {boolean} `true` if hidden items should be filtered on this surface.
     */
    function shouldFilterSurface(surface) {
        const settings = getSettings();
        if (!settings.enabled) return false;
        switch (surface) {
            case 'details': return settings.filterLibrary;
            case 'library': return settings.filterLibrary;
            case 'discovery': return settings.filterDiscovery;
            case 'search': return settings.filterSearch;
            case 'upcoming': return settings.filterUpcoming;
            case 'calendar': return settings.filterCalendar;
            case 'recommendations': return settings.filterRecommendations;
            case 'requests': return settings.filterRequests;
            case 'nextup': return settings.filterNextUp;
            case 'continuewatching': return settings.filterContinueWatching;
            default: return true;
        }
    }

    // ============================================================
    // Event emission
    // ============================================================

    /**
     * Dispatches a `je-hidden-content-changed` CustomEvent on `window`.
     * Other modules (e.g. the management page) listen for this to re-render.
     */
    function emitChange() {
        try {
            document.querySelectorAll('[data-je-title-key], .je-detail-hide-btn, .je-hide-btn').forEach(node => node.jeHiddenPaint?.());
            window.dispatchEvent(new CustomEvent('je-hidden-content-changed'));
        } catch (e) {
            console.warn('🪼 Jellyfin Enhanced: Failed to emit hidden-content-changed event', e);
        }
    }

    // Reads the document again through the store (its answer publishes it; one queued change of this page keeps it).
    async function refresh() {
        try {
            return await JE.readUserSettings('hidden-content.json');
        } catch (e) {
            console.warn('🪼 Jellyfin Enhanced: Failed to refresh hidden-content', e);
            return false;
        }
    }

    // Client-side mirror of MergeHomeScope in HiddenContentController.cs (scoped home-row hide write).
    function mergeCwScope(existing, incoming) {
        const ex = (existing || '').toLowerCase();
        const inc = (incoming || 'continuewatching').toLowerCase();
        if (!ex) return inc;
        if (ex === 'global' || ex === 'homesections') return ex;
        if (ex === inc) return ex;
        return 'homesections';
    }

    // Rank-based widest-scope mirror of server's WiderScope — commutative max function for use in folds.
    // Disjoint rank-2 scopes (continuewatching ⊕ nextup) compose to homesections.
    const SCOPE_RANK = { global: 4, homesections: 3, continuewatching: 2, nextup: 2 };
    function widestScope(a, b) {
        if (!a) return b || '';
        if (!b) return a;
        const la = a.toLowerCase();
        const lb = b.toLowerCase();
        const ra = SCOPE_RANK[la] ?? 1;
        const rb = SCOPE_RANK[lb] ?? 1;
        if (ra === 2 && rb === 2 && la !== lb) return 'homesections';
        return ra >= rb ? la : lb;
    }

    // The answer of a server-side hide write (the home-row removal) as part of the store's document — preserves existing
    // metadata + merges scopes via mergeCwScope, as the server did. Looks up under hyphenated AND N-format keys (server
    // canonical is hyphenated; some callers pass N-format from data-id). `revision`: the document's revision the route
    // answered (the store orders it with its own saves' answers).
    function markScopedHidden(itemId, scope, revision) {
        if (!itemId) return;
        const _scope = (scope || 'continuewatching').toLowerCase();
        const data = getHiddenData();
        const items = (data.items) || {};
        const noHyphen = itemId.replace(/-/g, '');
        const hyphenated = noHyphen.length === 32
            ? `${noHyphen.slice(0, 8)}-${noHyphen.slice(8, 12)}-${noHyphen.slice(12, 16)}-${noHyphen.slice(16, 20)}-${noHyphen.slice(20)}`
            : itemId;
        // Collect every variant present, fold the widest scope across all of them so duplicate keys with
        // disjoint scopes (e.g. nextup + continuewatching = homesections) don't durably narrow on collapse.
        // Uses widestScope (rank-based, commutative) for the fold so result is order-independent;
        // mergeCwScope is asymmetric and biased to existing — wrong choice for a max-fold.
        const variants = [items[itemId], items[hyphenated], items[noHyphen]].filter(Boolean);
        const widestExisting = variants.reduce((acc, e) => widestScope(acc, e.hideScope), '');
        const finalScope = mergeCwScope(widestExisting, _scope);
        const existing = variants[0] || null;
        const altPresent = (hyphenated !== itemId && items[hyphenated]) || (noHyphen !== itemId && items[noHyphen]);
        if (items[itemId] && items[itemId].hideScope === finalScope && !altPresent) return;
        // Pick the earliest hiddenAt across variants so re-affirming doesn't reset history.
        let earliestHiddenAt = '';
        for (const v of variants) {
            if (!v?.hiddenAt) continue;
            if (!earliestHiddenAt || v.hiddenAt < earliestHiddenAt) earliestHiddenAt = v.hiddenAt;
        }
        const merged = {
            itemId,
            name: existing?.name || '',
            type: existing?.type || '',
            tmdbId: existing?.tmdbId || '',
            hiddenAt: earliestHiddenAt || new Date().toISOString(),
            posterPath: existing?.posterPath || '',
            seriesId: existing?.seriesId || '',
            seriesName: existing?.seriesName || '',
            seasonNumber: existing?.seasonNumber ?? null,
            episodeNumber: existing?.episodeNumber ?? null,
            hideScope: finalScope,
        };
        const remove = [hyphenated, noHyphen].filter(key => key !== itemId && items[key]);
        JE.internals.acknowledgeUserDocumentChange('hidden-content.json', { upsert: { [itemId]: merged }, remove }, revision);
    }

    // ============================================================
    // Public API
    // ============================================================

    /**
     * Checks an item's Jellyfin ID and any already-known typed provider identity.
     * @param {string} jellyfinItemId The Jellyfin item ID.
     * @param {Object} [metadata] Existing library DTO or card metadata; never fetched here.
     * @returns {boolean} `true` if the item is hidden.
     */
    function isHidden(jellyfinItemId, metadata) {
        if (!jellyfinItemId) return false;
        const settings = getSettings();
        if (!settings.enabled) return false;
        const title = titleData({ ...metadata, itemId: jellyfinItemId });
        return hiddenIdSet.has(normalizeId(jellyfinItemId)) || !!title && hiddenTmdbIdSet.has(title.key);
    }

    /**
     * Checks if an item is hidden by its TMDB ID.
     * @param {string|number} tmdbId The TMDB ID.
     * @returns {boolean} `true` if the item is hidden.
     */
    function isHiddenByTmdbId(tmdbId, type) {
        if (!tmdbId) return false;
        const settings = getSettings();
        if (!settings.enabled) return false;
        return hiddenTmdbIdSet.has(titleKey(type, tmdbId));
    }

    /**
     * Hides an item by adding it to the hidden-content data store.
     * Rebuilds lookup sets, schedules a save, emits a change event,
     * shows an undo toast, and refreshes native card visibility.
     * @param {Object} params Item data to hide.
     * @param {string} [params.itemId] Jellyfin item ID.
     * @param {string} [params.name] Display name.
     * @param {string} [params.type] Item type (Movie, Series, Episode, etc.).
     * @param {string|number} [params.tmdbId] TMDB ID.
     * @param {string} [params.posterPath] TMDB poster path.
     * @param {string} [params.seriesId] Parent series Jellyfin ID.
     * @param {string} [params.seriesName] Parent series name.
     * @param {number|null} [params.seasonNumber] Season number.
     * @param {number|null} [params.episodeNumber] Episode number.
     * @param {string} [params.hideScope] Scope: 'global', 'nextup', 'continuewatching', or 'homesections'.
     * @param {Object} [owner] The owner of a provider-rule write (confirmAndHide passes its confirmation's); none for the
     *     library's own hide controls and panels (see saveTitleRule).
     */
    function hideItem({ itemId, name, type, tmdbId, posterPath, seriesId, seriesName, seasonNumber, episodeNumber, hideScope }, owner = null) {
        const provider = titleData({ itemId, name, type, tmdbId, posterPath });
        if ((!itemId || JE.titleDetails?.isSynthetic?.(itemId)) && provider) return saveTitleRule(provider, true, owner).catch(() => false);
        // Synthetic ids (titles not in the library, shown on a native details page) are never stored.
        if (JE.titleDetails?.isSynthetic?.(itemId) || JE.titleDetails?.isSynthetic?.(seriesId)) return;
        const key = itemId || `tmdb-${tmdbId}`;
        const newItem = {
            itemId: itemId || '',
            name: name || '',
            type: type || '',
            tmdbId: tmdbId ? String(tmdbId) : '',
            hiddenAt: new Date().toISOString(),
            posterPath: posterPath || '',
            seriesId: seriesId || '',
            seriesName: seriesName || '',
            seasonNumber: seasonNumber != null ? seasonNumber : null,
            episodeNumber: episodeNumber != null ? episodeNumber : null,
            hideScope: hideScope || 'global'
        };

        persist({ upsert: { [key]: newItem } });
        showUndoToast(name || 'Item', key);
    }

    /**
     * Unhides an item by removing it from the hidden-content data store.
     * Restores visibility for the item's native cards.
     * @param {string} itemId The storage key or Jellyfin item ID to unhide.
     * @param {Object} [metadata] Existing library DTO or card metadata for provider-rule removal.
     * @param {Object} [owner] The owner of a provider-rule write; none for the library's own unhide controls and panels.
     */
    function unhideItem(itemId, metadata, owner = null) {
        if (/^(movie|tv):tmdb:[1-9][0-9]*$/.test(itemId)) {
            const [type, , tmdbId] = itemId.split(':');
            return saveTitleRule({ type, tmdbId }, false, owner).catch(() => false);
        }
        const data = getHiddenData();
        const entry = data.items?.[itemId] || Object.values(data.items || {}).find(item =>
            item.itemId && normalizeId(item.itemId) === normalizeId(itemId));
        const title = titleData({ ...(metadata || entry), itemId });
        if (title && hiddenTmdbIdSet.has(title.key)) {
            // Old detail hides sometimes stored only the Jellyfin id. Remove those exact-item
            // global aliases (one PATCH on the document queue) before the atomic provider delete.
            const wanted = normalizeId(metadata?.Id || metadata?.itemId || entry?.itemId || itemId);
            const aliases = Object.keys(data.items || {}).filter(key => data.items[key].itemId && normalizeId(data.items[key].itemId) === wanted &&
                (data.items[key].hideScope || 'global') === 'global' && !titleKey(data.items[key].type, data.items[key].tmdbId));
            if (aliases.length) persist({ remove: aliases });
            return saveTitleRule(title, false, owner).catch(() => false);
        }
        const items = getHiddenData().items;
        // Try direct key match first (covers storage keys like "tmdb-12345")
        let key = items[itemId] ? itemId : undefined;
        if (!key) {
            // Fallback: itemId might be a Jellyfin ID — find the matching storage key.
            // Compared canonically: the caller usually has an undashed ID off a card, while a
            // server-written entry stores it dashed, and a raw comparison would silently no-op.
            // Guarded against an empty/unusable argument, which would otherwise normalise to ''
            // and match the first TMDB-only entry (those carry no itemId).
            const wanted = normalizeId(itemId);
            key = wanted ? Object.keys(items).find(k => normalizeId(items[k].itemId) === wanted) : undefined;
        }
        // The server also removes the same item stored under another spelling of its id (another tab may have hidden it so).
        persist({ remove: [key || itemId].filter(Boolean) });
        // Cards of a scoped hide (not in the global lookup set) come back too: every native card is decided again.
        refreshNativeCardVisibility();
    }

    /**
     * Resolves an unhide to its confirmed outcome. A provider-rule write resolves false on failure;
     * a local-store edit (no promise) is owned by the debounced save and its retry ladder.
     * @param {*} result Value returned by {@link unhideItem}.
     * @returns {Promise<boolean>}
     */
    function unhideConfirmed(result) {
        return Promise.resolve(result).then(saved => saved !== false, () => false);
    }

    /**
     * Restores a manager entry whose unhide failed and turns its control into a visible retry.
     * @param {HTMLElement|null} entry Card or row that was fading out.
     * @param {HTMLButtonElement|null} button The entry's unhide control.
     */
    function showUnhideFailed(entry, button) {
        if (entry) {
            entry.classList.remove('je-hidden-item-removing');
            entry.style.opacity = '';
        }
        if (!button) return;
        const label = JE.t('hidden_content_unhide_failed_retry');
        button.textContent = label;
        button.title = label;
        button.disabled = false;
    }

    /**
     * Merges partial settings into the hidden-content settings.
     * Triggers a save, change event, and native card re-filter.
     * @param {Object} partial Key-value pairs to merge into settings.
     */
    function updateSettings(partial) {
        rulesGeneration++;
        persist({ set: { ...partial } });
    }

    /**
     * Returns all hidden items as an array with `_key` attached.
     * @returns {Array<Object>} Array of hidden item objects.
     */
    function getAllHiddenItems() {
        const data = getHiddenData();
        const items = data.items || {};
        return Object.entries(items).map(([key, item]) => ({ ...item, _key: key }));
    }

    /**
     * Returns the number of hidden items.
     * @returns {number} Count of hidden items.
     */
    function getHiddenCount() {
        const data = getHiddenData();
        return Object.keys(data.items || {}).length;
    }

    /**
     * Filters Jellyseerr discovery/search results, removing hidden items by TMDB ID.
     * @param {Array} results Array of Jellyseerr result objects.
     * @param {string} surface The surface name (e.g. 'discovery', 'search').
     * @returns {Array} Filtered array.
     */
    function filterJellyseerrResults(results, surface) {
        if (!shouldFilterSurface(surface)) return results;
        if (!Array.isArray(results)) return results;
        return results.filter((item) => {
            const tmdbId = item.id || item.tmdbId;
            return !hiddenTmdbIdSet.has(titleKey(item.mediaType || item.kind || item.type, tmdbId));
        });
    }

    /**
     * Filters calendar events, removing hidden items by TMDB ID, Jellyfin ID,
     * or normalised name match (for Sonarr events without TMDB IDs).
     * @param {Array} events Array of calendar event objects.
     * @returns {Array} Filtered array.
     */
    function filterCalendarEvents(events) {
        if (!shouldFilterSurface('calendar')) return events;
        if (!Array.isArray(events)) return events;

        // Build a set of normalised hidden-item names for fuzzy matching
        const hiddenNames = new Set();
        const items = (getHiddenData().items) || {};
        for (const key of Object.keys(items)) {
            const name = items[key].name;
            if (name) {
                const lower = name.toLowerCase();
                hiddenNames.add(lower);
                // Also store without trailing parenthetical qualifier
                // so "Hell's Kitchen (US)" matches "Hell's Kitchen" and vice-versa.
                const stripped = lower.replace(/\s*\([^)]*\)\s*$/, '');
                if (stripped !== lower) hiddenNames.add(stripped);
            }
        }

        return events.filter((event) => {
            if (event.tmdbId && hiddenTmdbIdSet.has(titleKey(event.mediaType || event.kind || event.type, event.tmdbId))) return false;
            if (event.itemId && hiddenIdSet.has(normalizeId(event.itemId))) return false;
            if (event.title && hiddenNames.has(event.title.toLowerCase())) return false;
            return true;
        });
    }

    /**
     * Filters request items, removing hidden items by TMDB ID or Jellyfin media ID.
     * @param {Array} items Array of request item objects.
     * @returns {Array} Filtered array.
     */
    function filterRequestItems(items) {
        if (!shouldFilterSurface('requests')) return items;
        if (!Array.isArray(items)) return items;
        return items.filter((item) => {
            const tmdbId = item.tmdbId || item.id;
            if (tmdbId && hiddenTmdbIdSet.has(titleKey(item.mediaType || item.kind || item.type, tmdbId))) return false;
            if (item.jellyfinMediaId && hiddenIdSet.has(normalizeId(item.jellyfinMediaId))) return false;
            return true;
        });
    }

    /**
     * Unhides every item this page shows (an item another tab or device hid since its answer stays hidden).
     */
    function unhideAll() {
        const keys = Object.keys(getHiddenData().items);
        if (keys.length) persist({ remove: keys });
    }

    /**
     * Takes the store's document again (initialization, a new person's data) and follows its publications from here on.
     */
    function resetFromUserConfig() {
        hiddenData = null;
        getHiddenData();
        // The page-load documents were read under the bootstrap's revision (the core holds it from then).
        loadedRevision = JE.core?.revision?.document?.('hidden-content') ?? null;
        revisionPending = false;
        rebuildSets();
        JE.internals.observeUserDocument?.('hidden-content.json', 'hidden-content-data', followStore);
    }

    /**
     * The rules' document moved on the server (another tab or device saved them): read them again and bring this tab
     * in line in place: only what changed is hidden or shown again, nothing is cleared first. Not while a save of this
     * tab is pending (its own change is not overwritten; the next revision after it reads again), and a change made here
     * while the read runs keeps the read from being taken (read again later).
     * @returns {Promise<boolean>} True when the rules are the server's as of a known revision.
     */
    function revalidate() {
        if (revalidating) { revisionPending = true; return revalidating; }
        // A change of this tab still out (an item change in the store's queue, or a title rule's write): read after it.
        if (internal.hasPendingSave?.() || ruleWrites.size > 0) { revisionPending = true; return Promise.resolve(false); }
        revisionPending = false;
        const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
        // Taken before the read: the rules as read are at least this new.
        const revision = JE.core?.revision?.document?.('hidden-content') ?? null;
        const before = getHiddenData();
        revalidating = (async () => {
            try {
                const userId = ApiClient.getCurrentUserId();
                if (!userId) return false;
                const fresh = await ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${userId}/hidden-content.json?_=${Date.now()}`),
                    dataType: 'json'
                });
                if (JE.session && !JE.session.isCurrent(requestEpoch)) return false;
                // Changed here meanwhile, or a save started: this tab's change wins; read again after it.
                if (hiddenData !== before || internal.hasPendingSave?.() || ruleWrites.size > 0) { revisionPending = true; return false; }
                const next = (typeof JE.toCamelCase === 'function' ? JE.toCamelCase(fresh) : fresh) || { items: {}, settings: {} };
                const after = JE.core?.revision?.document?.('hidden-content') ?? null;
                loadedRevision = after === revision ? revision : null;
                if (after !== revision) revisionPending = true;
                if (JSON.stringify(next) === JSON.stringify(before)) return true;
                JE.userConfig = JE.userConfig || {};
                JE.userConfig.hiddenContent = next;
                // Taken as a publication of the document (the copy, the lookup sets, the page), as the store's are.
                followStore(next, 'revalidated');
                return true;
            } catch (e) {
                console.warn('🪼 Jellyfin Enhanced: Failed to read hidden-content again after a revision', e);
                revisionPending = true;
                return false;
            } finally {
                revalidating = null;
                if (revisionPending && (JE.core?.revision?.document?.('hidden-content') ?? null) !== loadedRevision) {
                    revisionPending = false;
                    // A newer revision came while this ran: once more (each run is caused by a real move).
                    setTimeout(() => { if (!JE.session || JE.session.isCurrent(requestEpoch)) revalidate(); }, 0);
                }
            }
        })();
        return revalidating;
    }

    /**
     * Once this tab's changes are all answered (the store's queue and the title rule writes), a revision seen while they
     * were out is read now (it was held back so a read could not be taken over them).
     */
    function readAfterSave() {
        if (!revisionPending || revalidating || internal.hasPendingSave?.() || ruleWrites.size > 0) return;
        if ((JE.core?.revision?.document?.('hidden-content') ?? null) === loadedRevision) return;
        void revalidate();
    }

    document.addEventListener('je-document-revision', (e) => {
        const detail = /** @type {CustomEvent} */ (e).detail || {};
        if (detail.document !== 'hidden-content' || detail.revision === loadedRevision) return;
        // Nothing read yet: the first read takes the current rules anyway.
        if (!hiddenData) return;
        revalidate();
    });

    // Hidden-content data is per-user. Clear the local mirror the moment the
    // identity changes (don't read JE.userConfig here — reset handlers run in
    // registration order and the globals may not be wiped yet), then rebuild
    // from the incoming user's config once the re-bootstrap has loaded it.
    JE.session?.onUserChange('hidden-content-data', () => {
        hiddenData = null;
        loadedRevision = null;
        revisionPending = false;
        hiddenIdSet.clear();
        hiddenTmdbIdSet.clear();
        knownTitles.clear();
        document.querySelectorAll('[data-je-title-key], .je-hide-btn, .je-detail-hide-btn').forEach(button => {
            // Native cards are re-decided by the filter's own session pass.
            jeOwnedCard(button.closest('[data-je-hide-title], .je-discover-card, .jellyseerr-card, .card, .je-hub-entry'))?.classList.remove('je-hidden');
            button.remove();
        });
    });
    document.addEventListener('je:user-data-loaded', () => {
        resetFromUserConfig();
        internal.addLibraryHideButtons?.();
        emitChange();
        // Re-apply the incoming user's policy to whatever is on screen (the
        // filter reset stripped the previous user's hide marks and verdicts).
        refreshNativeCardVisibility();
    });

    Object.assign(internal, {
        hiddenIdSet,
        getRulesGeneration: () => rulesGeneration,
        hasProviderRules: () => hiddenTmdbIdSet.size > 0,
        titleKey, titleData, saveTitleRule, buildTitleControl, enqueuePersistence,
        normalizeId,
        getHiddenData,
        getSettings,
        rebuildSets,
        shouldFilterSurface,
        emitChange,
        refresh,
        markScopedHidden,
        isHidden,
        isHiddenByTmdbId,
        hideItem,
        unhideItem,
        unhideConfirmed,
        showUnhideFailed,
        updateSettings,
        getAllHiddenItems,
        getHiddenCount,
        filterJellyseerrResults,
        filterCalendarEvents,
        filterRequestItems,
        unhideAll,
        resetFromUserConfig,
        revalidate,
        readAfterSave,
        /** @returns {boolean} A newer revision of the rules is waiting to be read (after this tab's pending save). */
        hasRevisionPending: () => revisionPending,
    });

})(window.JellyfinEnhanced);
