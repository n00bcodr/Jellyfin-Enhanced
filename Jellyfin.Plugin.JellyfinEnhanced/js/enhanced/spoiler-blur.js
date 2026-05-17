(function (JE) {
    'use strict';

    var logPrefix = '🪼 Jellyfin Enhanced [SpoilerBlur]:';

    // In-memory cache of series IDs the current user has spoiler mode enabled for.
    // Populated once on init from the server's spoilerblur.json. The image filter
    // runs on the server so cards that are already displayed will be re-fetched
    // on next navigation; this cache only drives the per-show toggle button UI.
    var enabledSeries = new Set();
    var enabledMovies = new Set();
    var enabledCollections = new Set();
    // Pre-acquisition pending entries — keys "tv:{tmdbId}" / "movie:{tmdbId}".
    // Used by the Seerr more-info modal to show toggle state for titles
    // not yet in the library. Promoted to Series/Movies server-side on
    // ItemAdded (see SpoilerSeerrPendingPromoter).
    var enabledPendingTmdb = new Set();
    var loaded = false;
    // Tracks the in-flight loadState() promise so consumers
    // (reviews.js, etc.) can await initial state without racing.
    var statePromise = null;

    /**
     * Normalize a series ID to "N" format (no dashes, lowercase).
     * Server stores keys this way for deterministic comparison.
     * @param {string} id
     * @returns {string}
     */
    function normalizeId(id) {
        if (!id) return '';
        return String(id).replace(/-/g, '').toLowerCase();
    }

    /**
     * Fetch the user's enabled-series list from the server.
     * @returns {Promise<void>}
     */
    function loadState() {
        statePromise = ApiClient.ajax({
            url: ApiClient.getUrl('JellyfinEnhanced/spoiler-blur/series'),
            type: 'GET',
            dataType: 'json',
        }).then(function (data) {
            enabledSeries.clear();
            enabledMovies.clear();
            enabledCollections.clear();
            enabledPendingTmdb.clear();
            if (data && data.Series) {
                Object.keys(data.Series).forEach(function (key) {
                    enabledSeries.add(normalizeId(key));
                });
            }
            if (data && data.Movies) {
                Object.keys(data.Movies).forEach(function (key) {
                    enabledMovies.add(normalizeId(key));
                });
            }
            if (data && data.Collections) {
                Object.keys(data.Collections).forEach(function (key) {
                    enabledCollections.add(normalizeId(key));
                });
            }
            if (data && data.PendingTmdb) {
                Object.keys(data.PendingTmdb).forEach(function (key) {
                    // Keys are lowercase "tv:{tmdb}" / "movie:{tmdb}" — preserve casing of the prefix.
                    enabledPendingTmdb.add(String(key).toLowerCase());
                });
            }
            loaded = true;
        }).catch(function (err) {
            console.warn(logPrefix, 'Failed to load spoiler-blur state:', err);
            loaded = true;
        });
        return statePromise;
    }

    /**
     * Resolves once the initial spoiler-blur state has loaded.
     * Consumers that need an authoritative isEnabledFor answer on a
     * cold page load (reviews suppression, etc.) await this.
     * @returns {Promise<void>}
     */
    function whenLoaded() {
        if (loaded) return Promise.resolve();
        return statePromise || loadState();
    }

    /**
     * Returns true when the current user has spoiler mode enabled for this series.
     * @param {string} seriesId
     * @returns {boolean}
     */
    function isEnabledFor(seriesId) {
        return enabledSeries.has(normalizeId(seriesId));
    }

    /**
     * Enable spoiler mode for a series.
     * @param {string} seriesId
     * @returns {Promise<void>}
     */
    function enableForSeries(seriesId) {
        var normalized = normalizeId(seriesId);
        return ApiClient.ajax({
            url: ApiClient.getUrl('JellyfinEnhanced/spoiler-blur/series/' + encodeURIComponent(normalized)),
            type: 'POST',
            dataType: 'json',
        }).then(function () {
            enabledSeries.add(normalized);
        });
    }

    /**
     * Disable spoiler mode for a series.
     * @param {string} seriesId
     * @returns {Promise<void>}
     */
    function disableForSeries(seriesId) {
        var normalized = normalizeId(seriesId);
        return ApiClient.ajax({
            url: ApiClient.getUrl('JellyfinEnhanced/spoiler-blur/series/' + encodeURIComponent(normalized)),
            type: 'DELETE',
            dataType: 'json',
        }).then(function () {
            enabledSeries.delete(normalized);
        });
    }

    function isMovieEnabledFor(movieId) {
        return enabledMovies.has(normalizeId(movieId));
    }

    function enableForMovie(movieId, movieName) {
        var normalized = normalizeId(movieId);
        return ApiClient.ajax({
            url: ApiClient.getUrl('JellyfinEnhanced/spoiler-blur/movies/' + encodeURIComponent(normalized)),
            type: 'POST',
            dataType: 'json',
            data: JSON.stringify({ MovieName: movieName || '' }),
            contentType: 'application/json',
        }).then(function () {
            enabledMovies.add(normalized);
        });
    }

    function disableForMovie(movieId) {
        var normalized = normalizeId(movieId);
        return ApiClient.ajax({
            url: ApiClient.getUrl('JellyfinEnhanced/spoiler-blur/movies/' + encodeURIComponent(normalized)),
            type: 'DELETE',
            dataType: 'json',
        }).then(function () {
            enabledMovies.delete(normalized);
        });
    }

    function isCollectionEnabledFor(collectionId) {
        return enabledCollections.has(normalizeId(collectionId));
    }

    function enableForCollection(collectionId, collectionName) {
        var normalized = normalizeId(collectionId);
        return ApiClient.ajax({
            url: ApiClient.getUrl('JellyfinEnhanced/spoiler-blur/collections/' + encodeURIComponent(normalized)),
            type: 'POST',
            dataType: 'json',
            data: JSON.stringify({ CollectionName: collectionName || '' }),
            contentType: 'application/json',
        }).then(function () {
            enabledCollections.add(normalized);
        });
    }

    function disableForCollection(collectionId) {
        var normalized = normalizeId(collectionId);
        return ApiClient.ajax({
            url: ApiClient.getUrl('JellyfinEnhanced/spoiler-blur/collections/' + encodeURIComponent(normalized)),
            type: 'DELETE',
            dataType: 'json',
        }).then(function () {
            enabledCollections.delete(normalized);
        });
    }

    /**
     * Normalize a media-type-prefixed TMDB key to "tv:123" / "movie:123".
     * Both halves are lowercased so server keys (stored lowercase) and
     * client lookups match regardless of caller casing.
     */
    function pendingKey(mediaType, tmdbId) {
        var t = String(mediaType || '').toLowerCase();
        var i = String(tmdbId || '').trim();
        if (!i || (t !== 'tv' && t !== 'movie')) return '';
        return t + ':' + i;
    }

    /**
     * Returns true when the user has spoiler mode enabled for the given
     * TMDB id, regardless of whether it lives in PendingTmdb (not in
     * library yet) or in Series/Movies (already in library and promoted).
     * jellyfinMediaId is optional — when supplied, we also check the
     * Series/Movies set so the modal reflects active state for titles
     * already in the library.
     */
    function isTmdbEnabled(mediaType, tmdbId, jellyfinMediaId) {
        var k = pendingKey(mediaType, tmdbId);
        if (k && enabledPendingTmdb.has(k)) return true;
        if (!jellyfinMediaId) return false;
        if (mediaType === 'movie') return isMovieEnabledFor(jellyfinMediaId);
        if (mediaType === 'tv') return isEnabledFor(jellyfinMediaId);
        return false;
    }

    /**
     * Enable spoiler mode for a TMDB id (modal-driven). Server promotes
     * to Series/Movies if the library has a match, else records pending.
     * On success, refresh local caches so the modal reflects the new
     * state without another network round-trip.
     */
    function enableForTmdb(mediaType, tmdbId, displayName) {
        var t = String(mediaType || '').toLowerCase();
        var i = String(tmdbId || '').trim();
        if (!i || (t !== 'tv' && t !== 'movie')) {
            return Promise.reject(new Error('invalid mediaType/tmdbId'));
        }
        var query = displayName ? '?displayName=' + encodeURIComponent(displayName) : '';
        return ApiClient.ajax({
            url: ApiClient.getUrl('JellyfinEnhanced/spoiler-blur/pending/' + t + '/' + encodeURIComponent(i) + query),
            type: 'POST',
            dataType: 'json',
        }).then(function (resp) {
            var k = pendingKey(t, i);
            if (resp && resp.promoted === 'pending') {
                if (k) enabledPendingTmdb.add(k);
            } else if (resp && resp.promoted === 'series' && resp.jellyfinId) {
                enabledSeries.add(normalizeId(resp.jellyfinId));
                if (k) enabledPendingTmdb.delete(k);
            } else if (resp && resp.promoted === 'movie' && resp.jellyfinId) {
                enabledMovies.add(normalizeId(resp.jellyfinId));
                if (k) enabledPendingTmdb.delete(k);
            }
            return resp;
        });
    }

    function disableForTmdb(mediaType, tmdbId) {
        var t = String(mediaType || '').toLowerCase();
        var i = String(tmdbId || '').trim();
        if (!i || (t !== 'tv' && t !== 'movie')) {
            return Promise.reject(new Error('invalid mediaType/tmdbId'));
        }
        return ApiClient.ajax({
            url: ApiClient.getUrl('JellyfinEnhanced/spoiler-blur/pending/' + t + '/' + encodeURIComponent(i)),
            type: 'DELETE',
            dataType: 'json',
        }).then(function (resp) {
            var k = pendingKey(t, i);
            if (k) enabledPendingTmdb.delete(k);
            if (resp && resp.removedFrom === 'series' && resp.jellyfinId) {
                enabledSeries.delete(normalizeId(resp.jellyfinId));
            } else if (resp && resp.removedFrom === 'movie' && resp.jellyfinId) {
                enabledMovies.delete(normalizeId(resp.jellyfinId));
            }
            return resp;
        });
    }

    // Tracks items whose chapter images we've already preloaded this
    // session so navigating back to the same detail page doesn't
    // re-fetch every chapter every visit.
    var preloadedChapterItems = new Set();
    // Holds the AbortController for the in-flight preload run so a new
    // detail-page navigation OR playback start can cancel any
    // remaining requests immediately. Keeps slow-connection users from
    // having chapter preloads compete with the video manifest /
    // segments at the moment they click Play.
    var activePreloadAbort = null;
    var hashChangeListener = null;

    /**
     * Network-friendly chapter image preloader.
     *
     * What it does: for items the user has spoiler mode enabled for,
     * fetch every chapter image at fillWidth=320 so the browser HTTP
     * cache is warm by the time the player's timeline-hover tooltip
     * tries to render one (eliminates the "gray box → image swap" jank
     * on the first hover for each chapter).
     *
     * Why it's careful about bandwidth:
     *   1. requestIdleCallback defers work until the browser reports
     *      it's idle (or 1.5 s elapses, whichever first).
     *   2. Sequential fetch (concurrency = 1) so we never spawn 30
     *      parallel requests at once.
     *   3. fetch() with `priority: 'low'` (Chrome / Edge — ignored on
     *      browsers that don't support it) so even on a busy network
     *      the chapter requests yield to higher-priority traffic.
     *   4. ~80 ms gap between requests so the network always has
     *      headroom for a foreground request to interrupt.
     *   5. Hashchange listener — the moment the user clicks Play
     *      (which navigates to the player URL) or browses elsewhere,
     *      remaining preloads abort.
     *
     * @param {string} itemId
     * @param {string} itemType  'Movie' | 'Episode' | 'Series'
     */
    async function preloadChapterImages(itemId, itemType) {
        try {
            if (!itemId || !ApiClient || !ApiClient.getUrl) return;
            if (itemType !== 'Movie' && itemType !== 'Episode') return;
            await whenLoaded();

            var userId = ApiClient.getCurrentUserId && ApiClient.getCurrentUserId();
            if (!userId) return;

            // Eligibility — fetch item now to resolve SeriesId for episodes.
            var item;
            try {
                if (JE.helpers && typeof JE.helpers.getItemCached === 'function') {
                    item = await JE.helpers.getItemCached(itemId, { userId: userId });
                } else {
                    item = await ApiClient.getItem(userId, itemId);
                }
            } catch (e) {
                return;
            }
            if (!item) return;

            var eligible = false;
            if (itemType === 'Movie') eligible = isMovieEnabledFor(itemId);
            else if (itemType === 'Episode') {
                eligible = !!(item.SeriesId && isEnabledFor(item.SeriesId));
            }
            if (!eligible) return;

            var chapters = item.Chapters || [];
            if (!Array.isArray(chapters) || chapters.length === 0) return;

            var dedupKey = itemId + ':' + chapters.length;
            if (preloadedChapterItems.has(dedupKey)) return;
            preloadedChapterItems.add(dedupKey);

            // Cancel any prior in-flight preload before starting this one
            // (e.g. user navigated to a new item before the previous one
            // finished). Also wires the hashchange abort.
            cancelActivePreload();
            var ctl = new AbortController();
            activePreloadAbort = ctl;
            hashChangeListener = function () { ctl.abort(); };
            window.addEventListener('hashchange', hashChangeListener);

            // Defer the actual work to an idle window so we don't compete
            // with the detail-page render's own fetches. 1500 ms timeout
            // ceiling so a permanently-busy main thread doesn't block us
            // forever.
            await idleDelay(1500);
            if (ctl.signal.aborted) { unwirePreload(); return; }

            var token = (ApiClient.accessToken && ApiClient.accessToken()) || '';
            var didError = false;
            for (var i = 0; i < chapters.length; i++) {
                if (ctl.signal.aborted) break;
                var u = ApiClient.getUrl('Items/' + itemId + '/Images/Chapter/' + i)
                    + '?fillWidth=320'
                    + (token ? '&api_key=' + encodeURIComponent(token) : '');
                try {
                    // priority: 'low' is a hint to Chromium-based
                    // browsers to schedule the request behind any
                    // higher-priority traffic. Ignored elsewhere — the
                    // sequential + delayed pacing is the real throttle.
                    await fetch(u, {
                        signal: ctl.signal,
                        priority: 'low',
                        credentials: 'include',
                        cache: 'force-cache',
                    });
                } catch (e) {
                    if (e && e.name === 'AbortError') break;
                    // A single chapter that fails to preload (404 on a
                    // missing image, network blip) shouldn't kill the
                    // rest. Stash a flag so we DON'T mark the dedup
                    // key complete if a real error stream is happening
                    // — re-attempt on next navigation.
                    didError = true;
                }
                // Breathing gap between requests. Skip after the last
                // chapter — no point waiting before unwiring.
                if (i + 1 < chapters.length && !ctl.signal.aborted) {
                    await sleep(80);
                }
            }
            if (didError && ctl.signal.aborted === false) {
                preloadedChapterItems.delete(dedupKey);
            }
            unwirePreload();
        } catch (e) {
            console.warn(logPrefix, 'preloadChapterImages failed:', e);
        }
    }

    function cancelActivePreload() {
        if (activePreloadAbort) {
            try { activePreloadAbort.abort(); } catch (_) {}
            activePreloadAbort = null;
        }
        if (hashChangeListener) {
            try { window.removeEventListener('hashchange', hashChangeListener); } catch (_) {}
            hashChangeListener = null;
        }
    }
    function unwirePreload() {
        if (hashChangeListener) {
            try { window.removeEventListener('hashchange', hashChangeListener); } catch (_) {}
            hashChangeListener = null;
        }
        activePreloadAbort = null;
    }
    function idleDelay(timeoutMs) {
        return new Promise(function (resolve) {
            if (typeof window.requestIdleCallback === 'function') {
                window.requestIdleCallback(function () { resolve(); }, { timeout: timeoutMs });
            } else {
                setTimeout(resolve, Math.min(1000, timeoutMs));
            }
        });
    }
    function sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    /**
     * Inserts a "Spoiler Mode" toggle button into a series detail page's
     * action button row. Idempotent: re-running on the same page reuses the
     * existing button and just refreshes its state.
     * @param {string} itemId Series ID.
     * @param {HTMLElement} visiblePage The visible #itemDetailPage element.
     */
    function kindOf(itemType) {
        if (itemType === 'Movie') return 'movie';
        if (itemType === 'BoxSet') return 'collection';
        return 'series';
    }

    function isEnabledForKind(kind, id) {
        if (kind === 'movie') return isMovieEnabledFor(id);
        if (kind === 'collection') return isCollectionEnabledFor(id);
        return isEnabledFor(id);
    }

    function addSpoilerBlurButton(itemId, visiblePage, itemType) {
        // Admin-level kill switch.
        if (!JE.pluginConfig || JE.pluginConfig.SpoilerBlurEnabled !== true) return;
        if (!itemId || !visiblePage) return;
        if (!loaded) return;

        var kind = kindOf(itemType);

        var existing = visiblePage.querySelector('.je-spoiler-blur-btn');

        var selectors = [
            '.detailButtons',
            '.itemActionsBottom',
            '.mainDetailButtons',
            '.detailButtonsContainer',
        ];
        var container = null;
        for (var i = 0; i < selectors.length; i++) {
            var found = visiblePage.querySelector(selectors[i]);
            if (found) { container = found; break; }
        }
        if (!container) return;

        var enabled = isEnabledForKind(kind, itemId);
        var newState = enabled ? 'on' : 'off';

        if (!existing) {
            existing = document.createElement('button');
            existing.setAttribute('is', 'emby-button');
            existing.className = 'button-flat detailButton emby-button je-spoiler-blur-btn';
            existing.type = 'button';
            container.appendChild(existing);
            // R22-H3: read itemId/kind live from data-attrs, not closure.
            // Jellyfin reuses the #itemDetailPage element across SPA
            // navigations, so an existing button can be re-used for a
            // different item; closure-captured values would fire toggles
            // against the previous item.
            existing.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                var liveId = existing.getAttribute('data-je-item-id') || '';
                var liveKind = existing.getAttribute('data-je-spoiler-kind') || 'series';
                var livePage = existing.closest('#itemDetailPage:not(.hide)') || visiblePage;
                onToggleClicked(existing, liveId, liveKind, livePage);
            });
            existing.setAttribute('data-je-item-id', itemId);
            existing.setAttribute('data-je-spoiler-state', newState);
            existing.setAttribute('data-je-spoiler-kind', kind);
            renderButton(existing, enabled);
            return;
        }

        // Always refresh data-attrs (cheap) so a button reused across SPA
        // detail-page navigations targets the CURRENT item / kind.
        var prevId = existing.getAttribute('data-je-item-id');
        var prevKind = existing.getAttribute('data-je-spoiler-kind');
        if (prevId !== itemId) existing.setAttribute('data-je-item-id', itemId);
        if (prevKind !== kind) existing.setAttribute('data-je-spoiler-kind', kind);

        // Re-render when state OR identity changed. Otherwise skip the
        // DOM mutation — the body MutationObserver retriggers
        // handleItemDetails on every fired mutation, which re-enters
        // this function; an unconditional render would produce an
        // unbounded loop. (See series-page network spam reproduced via
        // Playwright on 2026-05-06.)
        var stateChanged = existing.getAttribute('data-je-spoiler-state') !== newState;
        var identityChanged = prevId !== itemId || prevKind !== kind;
        if (stateChanged || identityChanged) {
            existing.setAttribute('data-je-spoiler-state', newState);
            renderButton(existing, enabled);
        }
    }

    /**
     * Render the button content + tooltip for the given enabled state.
     * @param {HTMLButtonElement} button
     * @param {boolean} enabled
     */
    function renderButton(button, enabled) {
        var label = enabled
            ? JE.t('spoiler_blur_button_on')
            : JE.t('spoiler_blur_button_off');

        button.classList.toggle('je-spoiler-blur-on', enabled);
        button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
        button.title = label;
        button.setAttribute('aria-label', label);

        button.replaceChildren();
        var content = document.createElement('div');
        content.className = 'detailButton-content';

        var icon = document.createElement('span');
        icon.className = 'material-icons detailButton-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = enabled ? 'blur_on' : 'blur_off';
        content.appendChild(icon);

        var textSpan = document.createElement('span');
        textSpan.className = 'detailButton-icon-text';
        textSpan.textContent = label;
        content.appendChild(textSpan);

        button.appendChild(content);
    }

    /**
     * Click handler: flips spoiler mode for the series and refreshes the button.
     * Toasts on success/failure. We deliberately do NOT force a page reload —
     * users will see the blur next time they navigate to or refresh the show,
     * which is what Jellyfin's image cache requires anyway.
     * @param {HTMLButtonElement} button
     * @param {string} seriesId
     */
    // R24: full page reload to refresh DTO-derived text (Overview,
    // episode names, ratings). The image-URL refresh handles the visual
    // layer in-place, but title/overview/ratings come from a DTO the
    // page rendered ONCE on initial load — they don't reactively update
    // when the server-side strip changes between requests. Coalesced +
    // debounced so successive watched-marks (mark a season's worth of
    // episodes one after another) only trigger one reload.
    var pendingReload = null;
    function scheduleFullReload() {
        if (pendingReload) clearTimeout(pendingReload);
        pendingReload = setTimeout(function () {
            pendingReload = null;
            try { location.reload(); }
            catch (e) { console.warn(logPrefix, 'reload failed:', e); }
        }, 600);
    }

    // R24: in-place refresh of every Jellyfin item-image URL on the page.
    // Triggered after a spoiler-mode toggle so the visible state flips
    // without an F5. Walks <img src>, srcset, and inline
    // style.backgroundImage; appends `_sbcb=<timestamp>` to bust the
    // browser HTTP cache. The image filter on the server re-runs against
    // the user's current state and returns the right bytes (blurred /
    // clear / hide-mode placeholder).
    function refreshSpoilerableImages() {
        var IMG_PATH_RE = /\/Items\/[a-f0-9-]+\/Images\//i;
        var cb = '_sbcb=' + Date.now();

        function bust(url) {
            if (typeof url !== 'string' || !url) return url;
            if (!IMG_PATH_RE.test(url)) return url;
            // Strip any prior _sbcb param so successive toggles don't grow
            // the query string unbounded.
            var cleaned = url.replace(/([?&])_sbcb=\d+&?/g, '$1').replace(/[?&]$/, '');
            return cleaned + (cleaned.indexOf('?') === -1 ? '?' : '&') + cb;
        }

        // <img src>
        var imgs = document.querySelectorAll('img[src*="/Items/"]');
        for (var i = 0; i < imgs.length; i++) {
            var img = imgs[i];
            var orig = img.getAttribute('src') || '';
            if (IMG_PATH_RE.test(orig)) img.setAttribute('src', bust(orig));
            var ss = img.getAttribute('srcset');
            if (ss && IMG_PATH_RE.test(ss)) {
                img.setAttribute('srcset', ss.replace(/([^\s,]+)(?=\s*[\d.]+x|\s*,|\s*$)/g, function (u) {
                    return IMG_PATH_RE.test(u) ? bust(u) : u;
                }));
            }
        }

        // <source srcset> inside <picture>
        var sources = document.querySelectorAll('source[srcset*="/Items/"]');
        for (var j = 0; j < sources.length; j++) {
            var s = sources[j];
            var sss = s.getAttribute('srcset') || '';
            if (IMG_PATH_RE.test(sss)) {
                s.setAttribute('srcset', sss.replace(/([^\s,]+)(?=\s*[\d.]+x|\s*,|\s*$)/g, function (u) {
                    return IMG_PATH_RE.test(u) ? bust(u) : u;
                }));
            }
        }

        // background-image on inline styles. Walk only nodes whose style
        // attribute references /Items/ to avoid scanning the whole DOM.
        var bgEls = document.querySelectorAll('[style*="/Items/"]');
        for (var k = 0; k < bgEls.length; k++) {
            var el = bgEls[k];
            var st = el.getAttribute('style') || '';
            if (IMG_PATH_RE.test(st)) {
                var newSt = st.replace(/url\((["']?)([^"')]+)\1\)/gi, function (m, q, u) {
                    return 'url(' + q + bust(u) + q + ')';
                });
                if (newSt !== st) el.setAttribute('style', newSt);
            }
        }
    }

    // Disable-confirm snooze: when the user opts in via the checkbox in
    // the confirm dialog, skip the dialog for 15 minutes. Scoped per
    // Jellyfin user so multi-user clients don't share the suppression —
    // when the user id is unavailable (pre-init, post-logout transient),
    // we treat the request as "never snoozed; never persist" rather than
    // collapsing into a shared empty-uid bucket.
    var SNOOZE_MS = 15 * 60 * 1000;
    var MAX_SNOOZE_FUTURE_MS = 24 * 60 * 60 * 1000;  // sanity cap for parsed values
    var _emptyUidWarned = false;
    function snoozeUid() {
        try {
            if (window.ApiClient && typeof ApiClient.getCurrentUserId === 'function') {
                var uid = ApiClient.getCurrentUserId();
                if (typeof uid === 'string' && uid.length > 0) return uid;
            }
        } catch (e) {}
        if (!_emptyUidWarned) {
            _emptyUidWarned = true;
            console.warn(logPrefix, 'snooze: user id unavailable, snooze disabled this call');
        }
        return null;
    }
    function snoozeStorageKey(uid) { return 'je-spoiler-disable-snooze:' + uid; }
    function isDisableSnoozed() {
        var uid = snoozeUid();
        if (!uid) return false;
        var key = snoozeStorageKey(uid);
        try {
            var raw = localStorage.getItem(key);
            if (!raw) return false;
            var expiry = Number(raw);
            if (!Number.isFinite(expiry) || expiry <= 0) return false;
            // Reject absurd future expiries (corruption or clock skew);
            // anything beyond 24h is out of contract.
            if (expiry > Date.now() + MAX_SNOOZE_FUTURE_MS) {
                localStorage.removeItem(key);
                return false;
            }
            if (Date.now() < expiry) return true;
            localStorage.removeItem(key);
        } catch (e) {
            console.warn(logPrefix, 'snooze read failed:', e);
        }
        return false;
    }
    function setDisableSnooze() {
        var uid = snoozeUid();
        if (!uid) return;
        try { localStorage.setItem(snoozeStorageKey(uid), String(Date.now() + SNOOZE_MS)); }
        catch (e) { console.warn(logPrefix, 'snooze persist failed:', e); }
    }

    /**
     * Show a Jellyfin-native confirm dialog asking the user to confirm
     * disabling spoiler mode. The dialog embeds a "Don't ask again for
     * 15 minutes" checkbox; if checked when the user confirms, the
     * snooze is persisted via localStorage. Returns true if the user
     * confirmed, false if they cancelled. When already snoozed, resolves
     * true immediately without showing a dialog.
     * @returns {Promise<boolean>}
     */
    function confirmDisableSpoiler() {
        if (isDisableSnoozed()) return Promise.resolve(true);
        var title = JE.t('spoiler_disable_confirm_title');
        var body = JE.t('spoiler_disable_confirm_body');
        var snoozeLabel = JE.t('spoiler_disable_confirm_snooze');
        var marker = 'je-sb-snooze-' + Date.now() + '-' + Math.floor(Math.random() * 100000);
        var esc = (typeof JE.escapeHtml === 'function') ? JE.escapeHtml : function (s) { return String(s); };
        // Dashboard.confirm renders `text` as HTML via DOMPurify. Body
        // and snooze label come from Weblate-sourced translations, so
        // they're escaped before interpolation in case a translator
        // ever introduces stray markup.
        var html = '<div>' + esc(body) + '</div>'
            + '<label class="' + marker + '" style="display:flex;align-items:center;gap:.5em;margin-top:1em;cursor:pointer;">'
            + '<input type="checkbox" />'
            + '<span>' + esc(snoozeLabel) + '</span>'
            + '</label>';
        return new Promise(function (resolve) {
            if (!window.Dashboard || typeof window.Dashboard.confirm !== 'function') {
                // No Dashboard surface (rare). Fall back to native
                // confirm without the snooze option — UX degrades but
                // the disable still works.
                console.warn(logPrefix, 'Dashboard.confirm unavailable; snooze checkbox unreachable on this surface');
                resolve(window.confirm(title + '\n\n' + body));
                return;
            }
            // Read the checkbox state via two independent paths to
            // avoid the fast-click race that loses the snooze:
            //  1. Capture-phase delegated change listener registered
            //     BEFORE the dialog mounts — catches the checkbox's
            //     change event regardless of when the input appears in
            //     the DOM. Survives a tab-then-Enter user.
            //  2. Defensive synchronous read inside the Dashboard.confirm
            //     callback (if the dialog DOM is still present). Last
            //     write wins.
            var snoozeChecked = false;
            function captureChange(e) {
                try {
                    var t = e.target;
                    if (t && t.tagName === 'INPUT' && t.type === 'checkbox') {
                        var label = t.closest('.' + marker);
                        if (label) snoozeChecked = !!t.checked;
                    }
                } catch (err) { /* defensive; never let a stray DOM call abort */ }
            }
            document.addEventListener('change', captureChange, true);
            function cleanup() {
                try { document.removeEventListener('change', captureChange, true); } catch (e) {}
            }
            try {
                window.Dashboard.confirm(html, title, function (ok) {
                    // Defensive second read — dialog DOM may still be
                    // present here depending on Jellyfin version.
                    try {
                        var cb = document.querySelector('.' + marker + ' input[type="checkbox"]');
                        if (cb) snoozeChecked = !!cb.checked;
                    } catch (e) {}
                    cleanup();
                    var confirmed = !!ok;
                    if (confirmed && snoozeChecked) setDisableSnooze();
                    resolve(confirmed);
                });
            } catch (err) {
                cleanup();
                console.warn(logPrefix, 'Dashboard.confirm threw, falling back:', err);
                resolve(window.confirm(title + '\n\n' + body));
            }
        });
    }

    function onToggleClicked(button, itemId, kind, visiblePage) {
        if (button.disabled) return;  // ignore re-entrant clicks
        var willBeEnabled = !isEnabledForKind(kind, itemId);
        // Disable the button up-front so the user can't stack confirm
        // dialogs or queue duplicate toggles via rapid double-clicks.
        // performToggle will keep it disabled for its async lifecycle;
        // we re-enable on the cancel/error paths here.
        button.disabled = true;
        if (!willBeEnabled) {
            // Disabling — prompt once (unless snoozed) before mutating
            // server state. Re-enabling does not prompt.
            confirmDisableSpoiler().then(function (proceed) {
                if (proceed) {
                    performToggle(button, itemId, kind, visiblePage, willBeEnabled);
                } else {
                    button.disabled = false;
                }
            }, function (err) {
                console.warn(logPrefix, 'confirmDisableSpoiler rejected:', err);
                button.disabled = false;
            });
            return;
        }
        performToggle(button, itemId, kind, visiblePage, willBeEnabled);
    }

    function performToggle(button, itemId, kind, visiblePage, willBeEnabled) {
        // button.disabled is already true (set by onToggleClicked).
        var displayName = '';
        if ((kind === 'movie' || kind === 'collection') && visiblePage) {
            try {
                var titleEl = visiblePage.querySelector('h1.itemName-name, h1.itemName, .itemName, h2.itemName-name');
                if (titleEl && titleEl.textContent) displayName = titleEl.textContent.trim();
            } catch (e) {
                console.warn(logPrefix, kind + ' title scrape failed; falling back to server lookup:', e);
            }
        }
        var promise;
        if (kind === 'movie') {
            promise = willBeEnabled ? enableForMovie(itemId, displayName) : disableForMovie(itemId);
        } else if (kind === 'collection') {
            promise = willBeEnabled ? enableForCollection(itemId, displayName) : disableForCollection(itemId);
        } else {
            promise = willBeEnabled ? enableForSeries(itemId) : disableForSeries(itemId);
        }
        promise.then(function () {
            renderButton(button, willBeEnabled);
            button.setAttribute('data-je-spoiler-state', willBeEnabled ? 'on' : 'off');
            // Per-kind toast wording: series mentions "unwatched
            // episodes"; movie/collection don't fit that phrasing.
            var msg;
            if (willBeEnabled) {
                if (kind === 'movie') msg = JE.t('spoiler_blur_enabled_movie_toast');
                else if (kind === 'collection') msg = JE.t('spoiler_blur_enabled_collection_toast');
                else msg = JE.t('spoiler_blur_enabled_toast');
            } else {
                if (kind === 'movie') msg = JE.t('spoiler_blur_disabled_movie_toast');
                else if (kind === 'collection') msg = JE.t('spoiler_blur_disabled_collection_toast');
                else msg = JE.t('spoiler_blur_disabled_toast');
            }
            if (JE.toast) JE.toast(msg);
            // Bust the JE tag-pipeline server cache so freshly-eligible
            // items lose their pre-toggle (unstripped) tag overlays
            // immediately, instead of persisting until the next page
            // reload. Without this, NextUp / home-rail cards show
            // genre/quality/rating overlays for unwatched episodes of
            // the just-enabled spoiler series until the user F5s.
            try {
                if (JE.tagPipeline && typeof JE.tagPipeline.invalidateServerCache === 'function') {
                    JE.tagPipeline.invalidateServerCache();
                }
            } catch (e) {
                console.warn(logPrefix, 'invalidateServerCache failed:', e);
            }
            // R14-M1: also remove any reviews section currently rendered
            // for THIS detail page — works for both Series and Movie pages
            // (movies were previously gated out and stayed visible until
            // navigation/refresh after enabling spoiler mode).
            try {
                if (willBeEnabled && JE.pluginConfig?.SpoilerStripReviews !== false) {
                    var existingReviews = document.querySelector('#itemDetailPage:not(.hide) .tmdb-reviews-section')
                        || document.querySelector('.tmdb-reviews-section');
                    if (existingReviews && existingReviews.parentNode) {
                        existingReviews.parentNode.removeChild(existingReviews);
                    }
                }
            } catch (e) {
                console.warn(logPrefix, 'reviews section cleanup failed:', e);
            }
            // R24: refresh all <img> + background-image URLs immediately
            // for snappy visual feedback, then schedule a full page
            // reload so DOM text (Overview, titles, ratings) also picks
            // up the new server-side strip state.
            try {
                refreshSpoilerableImages();
            } catch (e) {
                console.warn(logPrefix, 'refreshSpoilerableImages failed:', e);
            }
            scheduleFullReload();
        }).catch(function (err) {
            console.error(logPrefix, 'Toggle failed:', err);
            if (JE.toast) JE.toast(JE.t('spoiler_blur_error_toast'));
        }).finally(function () {
            button.disabled = false;
        });
    }

    /**
     * Patches the SRC / backgroundImage setters globally so every image URL
     * that points at Jellyfin's /Items/{id}/Images/{type} endpoint gets an
     * `api_key=<accessToken>` query param appended. Without this, browser
     * <img> requests are anonymous (Jellyfin's image endpoint is public-
     * accessible by design) and the server-side spoiler-blur action filter
     * has no way to identify which user is requesting the image, so it can't
     * decide whether to blur. Adding api_key flips those requests into
     * authenticated ones and the filter starts firing.
     *
     * Idempotent — calling this twice is harmless.
     */
    function patchImageUrlsForAuth() {
        if (window.__je_spoilerBlurUrlPatchInstalled) return;
        window.__je_spoilerBlurUrlPatchInstalled = true;

        // Path-shape regex. Used as a cheap pre-filter before the costlier
        // origin check in safelyPatchUrl().
        var IMAGE_PATH_RE = /\/Items\/[a-f0-9-]+\/Images\//i;
        var HAS_KEY_RE = /[?&](api_key|ApiKey)=/i;

        // Capture the Jellyfin origin once at install time. Compared against
        // every candidate URL — H1: never append api_key to a non-Jellyfin
        // origin even if the path happens to match /Items/.../Images/.
        // Tolerates Jellyfin reverse-proxy mounts (BaseUrl) by letting any
        // path on the same origin through.
        var jfOrigin = (function () {
            try {
                if (typeof ApiClient !== 'undefined' && typeof ApiClient.serverAddress === 'function') {
                    var addr = ApiClient.serverAddress();
                    if (addr) return new URL(addr, location.href).origin;
                }
            } catch (e) {
                // R2-L1: surface — same-origin fallback might be wrong on a
                // BaseUrl-mounted reverse-proxy install.
                console.warn(logPrefix, 'ApiClient.serverAddress() failed; falling back to location.origin:', e);
            }
            return location.origin;
        })();

        function getToken() {
            try {
                if (typeof ApiClient !== 'undefined' && typeof ApiClient.accessToken === 'function') {
                    return ApiClient.accessToken() || '';
                }
            } catch (e) {
                // R2-L1: surface — without a token we won't append api_key
                // and the web client will see unblurred images.
                console.warn(logPrefix, 'ApiClient.accessToken() failed:', e);
            }
            return '';
        }

        // Returns true when the URL is for the same Jellyfin origin AND
        // matches the /Items/.../Images/ path shape AND doesn't already
        // carry api_key. Anchored on origin to prevent token leakage to
        // attacker-controlled hosts (security findings H1 + H3).
        function shouldPatchUrl(url) {
            if (typeof url !== 'string' || !url) return false;
            if (!IMAGE_PATH_RE.test(url)) return false;
            if (HAS_KEY_RE.test(url)) return false;
            try {
                var parsed = new URL(url, location.href);
                if (parsed.origin !== jfOrigin) return false;
            } catch (e) {
                return false;
            }
            return true;
        }

        function patchUrl(url) {
            if (!shouldPatchUrl(url)) return url;
            var token = getToken();
            if (!token) return url;
            return url + (url.indexOf('?') === -1 ? '?' : '&') + 'api_key=' + encodeURIComponent(token);
        }

        // Patch HTMLImageElement.src — covers <img> tags everywhere.
        var imgDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
        if (imgDesc && imgDesc.set) {
            Object.defineProperty(HTMLImageElement.prototype, 'src', {
                configurable: true,
                enumerable: imgDesc.enumerable,
                get: imgDesc.get,
                set: function (value) { return imgDesc.set.call(this, patchUrl(value)); },
            });
        }

        // CSS properties on CSSStyleDeclaration are NOT regular accessor
        // properties on the prototype — they're handled via WebIDL bindings
        // and `Object.getOwnPropertyDescriptor(prototype, 'backgroundImage')`
        // returns undefined in Chrome/Firefox. Patch `setProperty` (the
        // underlying API for CSS property writes) AND use a MutationObserver
        // on style-attribute changes as a backstop for `el.style.background-
        // Image = ...` writes that bypass setProperty.
        var origSetProp = CSSStyleDeclaration.prototype.setProperty;
        CSSStyleDeclaration.prototype.setProperty = function (name, value, priority) {
            if (typeof value === 'string'
                && (name === 'background-image' || name === 'background')
                && value.indexOf('/Items/') !== -1) {
                value = value.replace(/url\((["']?)([^"')]+)\1\)/gi, function (m, q, u) {
                    return 'url(' + q + patchUrl(u) + q + ')';
                });
            }
            return origSetProp.call(this, name, value, priority);
        };

        // MutationObserver: when an element's style attribute changes and
        // contains an unpatched /Items/.../Images/ url(...), rewrite it.
        // Catches `el.style.backgroundImage = "url(...)"` (which goes through
        // a non-public WebIDL setter that we cannot intercept directly).
        function rewriteStyleBgIfNeeded(el) {
            try {
                var bg = el.style && el.style.backgroundImage;
                if (!bg || bg.indexOf('/Items/') === -1) return;
                var rewritten = bg.replace(/url\((["']?)([^"')]+)\1\)/gi, function (m, q, u) {
                    return 'url(' + q + patchUrl(u) + q + ')';
                });
                if (rewritten !== bg) {
                    // Use the original setter to bypass our setProperty patch
                    // so we don't double-process.
                    origSetProp.call(el.style, 'background-image', rewritten);
                }
            } catch (e) {
                // H5: surface failures so we don't silently fall back to
                // unblurred (which would mean every user sees every spoiler
                // with no console signal). Rate-limited per element so a
                // persistently-broken element doesn't spam the console.
                if (!el.__jeSpoilerWarned) {
                    el.__jeSpoilerWarned = true;
                    console.warn(logPrefix, 'rewriteStyleBgIfNeeded failed:', e, el);
                }
            }
        }

        // Initial pass over already-rendered cards.
        var existingCards = document.querySelectorAll('[style*="/Items/"]');
        for (var i = 0; i < existingCards.length; i++) rewriteStyleBgIfNeeded(existingCards[i]);

        var styleObserver = new MutationObserver(function (mutations) {
            for (var i = 0; i < mutations.length; i++) {
                var mut = mutations[i];
                if (mut.type === 'attributes' && mut.attributeName === 'style') {
                    rewriteStyleBgIfNeeded(mut.target);
                } else if (mut.type === 'childList') {
                    // New nodes may have inline style with unpatched URLs.
                    for (var j = 0; j < mut.addedNodes.length; j++) {
                        var node = mut.addedNodes[j];
                        if (node.nodeType !== 1) continue;
                        if (node.style) rewriteStyleBgIfNeeded(node);
                        // descendants
                        if (node.querySelectorAll) {
                            var descs = node.querySelectorAll('[style*="/Items/"]');
                            for (var k = 0; k < descs.length; k++) rewriteStyleBgIfNeeded(descs[k]);
                        }
                    }
                }
            }
        });
        styleObserver.observe(document.documentElement || document.body, {
            attributes: true,
            attributeFilter: ['style'],
            childList: true,
            subtree: true,
        });

        // Also rewrite static `src` / `style="background-image: ..."` attribute
        // setters (some code uses setAttribute/style.cssText, which bypasses
        // the property setters above). M4: early-out when the value can't
        // possibly be a Jellyfin image URL — runs on every setAttribute call
        // across the whole app, so the pre-filter matters.
        var origSetAttr = Element.prototype.setAttribute;
        Element.prototype.setAttribute = function (name, value) {
            if (typeof value === 'string') {
                if (this.tagName === 'IMG' && name === 'src') {
                    value = patchUrl(value);
                } else if (name === 'style' && value.indexOf('/Items/') !== -1) {
                    value = value.replace(/url\((["']?)([^"')]+)\1\)/gi, function (m, q, u) {
                        return 'url(' + q + patchUrl(u) + q + ')';
                    });
                }
            }
            return origSetAttr.call(this, name, value);
        };
    }

    /**
     * Module init. Loads server state, then exposes toggle APIs.
     */
    // R24: intercept watched-state mutations (mark played / unplayed) so
    // we can auto-refresh thumbnails afterwards. Without this, the
    // currently-rendered <img> URLs still have the OLD cache-bust prefix
    // and the user keeps seeing the stale (blurred / clear) state until
    // page refresh.
    //
    // Jellyfin's web client marks watched via:
    //   POST   /Users/{uid}/PlayedItems/{itemId}      (mark played)
    //   DELETE /Users/{uid}/PlayedItems/{itemId}      (mark unplayed)
    // Both go through window.fetch in modern Jellyfin and through
    // XMLHttpRequest in older ApiClient paths. Patch both.
    var PLAYED_RE = /\/(?:Users\/[a-f0-9-]+|UserItems)\/PlayedItems\/[a-f0-9-]+/i;

    function maybeRefreshAfterMutation(method, urlStr) {
        if (typeof urlStr !== 'string') return;
        if (!PLAYED_RE.test(urlStr)) return;
        if (method !== 'POST' && method !== 'DELETE') return;
        // Bail if the user has no spoiler-blur state.
        if (loaded && enabledSeries.size === 0 && enabledMovies.size === 0 && enabledCollections.size === 0) return;
        // Refresh image URLs in-place. DOM text fields (Overview,
        // episode names, ratings) won't auto-update from this — they
        // were rendered from the DTO once on navigation and Jellyfin's
        // web client doesn't anticipate user-data → DTO-content
        // transitions. We deliberately do NOT trigger a full page
        // reload here: a watched/unwatched mark can fire from many
        // contexts (auto-mark on playback end, batch-mark from a UI,
        // sync from another client) and a reload mid-flow is jarring.
        // The text will refresh on the user's next navigation.
        setTimeout(function () {
            try { refreshSpoilerableImages(); }
            catch (e) { console.warn(logPrefix, 'auto-refresh after watched-flip failed:', e); }
        }, 200);
    }

    function installWatchedMutationHook() {
        if (window.__je_spoilerBlurWatchedHookInstalled) return;
        window.__je_spoilerBlurWatchedHookInstalled = true;

        // fetch
        try {
            var origFetch = window.fetch;
            if (typeof origFetch === 'function') {
                window.fetch = function (input, init) {
                    var url = typeof input === 'string' ? input : (input && input.url) || '';
                    var method = (init && init.method) || (input && input.method) || 'GET';
                    var p = origFetch.apply(this, arguments);
                    if (PLAYED_RE.test(url)) {
                        p.then(function (resp) {
                            if (resp && resp.ok) maybeRefreshAfterMutation(method.toUpperCase(), url);
                        }).catch(function () {});
                    }
                    return p;
                };
            }
        } catch (e) {
            console.warn(logPrefix, 'fetch hook install failed:', e);
        }

        // XMLHttpRequest
        try {
            var origOpen = XMLHttpRequest.prototype.open;
            var origSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.open = function (method, url) {
                this.__je_method = (method || '').toUpperCase();
                this.__je_url = typeof url === 'string' ? url : '';
                return origOpen.apply(this, arguments);
            };
            XMLHttpRequest.prototype.send = function () {
                var xhr = this;
                var method = xhr.__je_method;
                var url = xhr.__je_url;
                if (url && PLAYED_RE.test(url) && (method === 'POST' || method === 'DELETE')) {
                    xhr.addEventListener('loadend', function () {
                        if (xhr.status >= 200 && xhr.status < 300) {
                            maybeRefreshAfterMutation(method, url);
                        }
                    });
                }
                return origSend.apply(this, arguments);
            };
        } catch (e) {
            console.warn(logPrefix, 'XHR hook install failed:', e);
        }
    }

    function init() {
        if (!JE.pluginConfig || JE.pluginConfig.SpoilerBlurEnabled !== true) return;
        // Install the URL patcher BEFORE loading state. We want any image
        // request that fires while we're still loading state to already be
        // authenticated; otherwise the filter sees `userId=null` and the
        // image is permanently cached as pass-through in the browser.
        try {
            patchImageUrlsForAuth();
        } catch (e) {
            console.error(logPrefix, 'URL patcher install failed — web client will see unblurred images:', e);
            if (JE.toast) {
                JE.toast(JE.t('spoiler_blur_patcher_failed_toast'), 5000);
            }
        }
        try { installWatchedMutationHook(); }
        catch (e) { console.warn(logPrefix, 'watched-mutation hook install failed:', e); }
        loadState();
    }

    JE.spoilerBlur = {
        init: init,
        addSpoilerBlurButton: addSpoilerBlurButton,
        isEnabledFor: isEnabledFor,
        isMovieEnabledFor: isMovieEnabledFor,
        isCollectionEnabledFor: isCollectionEnabledFor,
        enableForSeries: enableForSeries,
        disableForSeries: disableForSeries,
        enableForMovie: enableForMovie,
        disableForMovie: disableForMovie,
        enableForCollection: enableForCollection,
        disableForCollection: disableForCollection,
        isTmdbEnabled: isTmdbEnabled,
        enableForTmdb: enableForTmdb,
        disableForTmdb: disableForTmdb,
        whenLoaded: whenLoaded,
        preloadChapterImages: preloadChapterImages,
        confirmDisableSpoiler: confirmDisableSpoiler,
    };
})(window.JellyfinEnhanced);
