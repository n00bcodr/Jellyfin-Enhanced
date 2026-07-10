(function (JE) {
    'use strict';

    var logPrefix = '🪼 Jellyfin Enhanced [SpoilerBlur]:';

    // In-memory cache of series IDs the current user has Spoiler Guard enabled
    // for. The image filter runs on the server, so already-displayed cards
    // re-fetch on next navigation; this cache only drives the toggle button UI.
    var enabledSeries = new Set();
    var enabledMovies = new Set();
    var enabledCollections = new Set();
    // Pre-acquisition pending entries — keys "tv:{tmdbId}" / "movie:{tmdbId}".
    // Used by the Seerr more-info modal to show toggle state for titles
    // not yet in the library. Promoted to Series/Movies server-side on
    // ItemAdded (see SpoilerSeerrPendingPromoter).
    var enabledPendingTmdb = new Set();
    // Per-user override prefs (mirrors C# SpoilerBlurUserPrefs). Each strip
    // toggle is nullable bool: null = inherit admin, false = user opted out.
    var userPrefs = {};
    var loaded = false;
    // Did the initial GET succeed? Distinct from `loaded`: `loaded=true` means
    // the GET ATTEMPT finished (success or failure), so consumers awaiting
    // whenLoaded() unblock either way. `loadOk=true` additionally means the
    // in-memory cache (userPrefs / enabledSeries / etc.) is authoritative.
    // Callers that would otherwise clobber persisted state if the cache is
    // empty (saveSbPrefs in particular) MUST check loadOk before writing.
    var loadOk = false;
    // Tracks the in-flight loadState() promise so consumers
    // (reviews.js, etc.) can await initial state without racing.
    var statePromise = null;

    /**
     * Normalize a series ID to "N" format (no dashes, lowercase).
     * Server stores keys this way for deterministic comparison.
     */
    function normalizeId(id) {
        if (!id) return '';
        return String(id).replace(/-/g, '').toLowerCase();
    }

    /** Fetch the user's enabled-series list from the server. */
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
            userPrefs = (data && data.Prefs) ? data.Prefs : {};
            loaded = true;
            loadOk = true;
        }).catch(function (err) {
            // Mark `loaded` so whenLoaded() unblocks, but DON'T set loadOk:
            // the cache is unreliable. Save/strip callers must fail-closed
            // rather than treating the empty cache as authoritative.
            console.error(logPrefix, 'Failed to load spoiler-blur state; downstream consumers will fail-closed:', err);
            loaded = true;
            loadOk = false;
        });
        return statePromise;
    }

    /**
     * Returns true when the initial GET /spoiler-blur/series resolved
     * successfully and the in-memory cache (userPrefs, enabled* sets) is
     * authoritative. Returns false either before the GET completes or after
     * it failed. Callers that would otherwise overwrite server state from
     * an empty cache MUST short-circuit on `false`.
     */
    function isLoadOk() {
        return loadOk;
    }

    /**
     * Resolves once the initial Spoiler Guard state has loaded.
     * Consumers that need an authoritative isEnabledFor answer on a
     * cold page load (reviews suppression, etc.) await this.
     *
     * When the admin master switch is off, this short-circuits with a
     * resolved Promise without hitting the network. Without this guard,
     * a future consumer that forgot to gate on SpoilerBlurEnabled before
     * calling whenLoaded() could trigger a 403/empty-response GET when
     * the plugin's spoiler-blur feature is disabled.
     */
    function whenLoaded() {
        if (JE.pluginConfig && JE.pluginConfig.SpoilerBlurEnabled !== true) return Promise.resolve();
        if (loaded) return Promise.resolve();
        return statePromise || loadState();
    }

    /** Returns true when the current user has Spoiler Guard enabled for this series. */
    function isEnabledFor(seriesId) {
        return enabledSeries.has(normalizeId(seriesId));
    }

    /** Enable Spoiler Guard for a series. */
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

    /** Disable Spoiler Guard for a series. */
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
     * Returns true when the user has Spoiler Guard enabled for the given
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
     * Enable Spoiler Guard for a TMDB id (modal-driven). Server promotes
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

    // (Chapter-image preloader removed: it fetched Chapter images with URL
    // params the player never uses, so it could not warm the timeline-hover
    // cache it existed for. The player's own on-demand chapter request is
    // still intercepted and blurred by the server-side image filter.)

    // Maps a Jellyfin item type to the Spoiler Guard "kind" (movie / collection / series).
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

    /**
     * Inserts a "Spoiler Guard" toggle button into a Series / Movie / Collection
     * detail page's action button row. Idempotent: re-running on the same page
     * reuses the existing button and just refreshes its state.
     */
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
            placeButton(existing, container);
            // Read itemId/kind live from data-attrs, not closure. Jellyfin
            // reuses the #itemDetailPage element across SPA navigations, so
            // an existing button can be re-used for a different item;
            // closure-captured values would fire toggles against the
            // previous item.
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

        // Keep the button positioned just BEFORE the More-commands menu
        // button. Idempotent — only moves the node when it's actually out
        // of place, so the body MutationObserver re-runs don't cause
        // pointless DOM churn.
        placeButton(existing, container);

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
        // unbounded loop.
        var stateChanged = existing.getAttribute('data-je-spoiler-state') !== newState;
        var identityChanged = prevId !== itemId || prevKind !== kind;
        if (stateChanged || identityChanged) {
            existing.setAttribute('data-je-spoiler-state', newState);
            renderButton(existing, enabled);
        }
    }

    /**
     * Render the button content + tooltip for the given enabled state.
     * Icon-only — the label rides on the button's `title` (hover tooltip)
     * and `aria-label` (screen readers) so the row stays compact.
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

        button.appendChild(content);
    }

    // Place the Spoiler Guard button just before Jellyfin's More-commands
    // (...) menu button when one exists in the row — otherwise append at
    // the end. Idempotent: only mutates the DOM when the button is
    // actually out of position, so the body MutationObserver dispatching
    // handleItemDetails on every fired mutation doesn't churn.
    function placeButton(button, container) {
        var menuBtn = container.querySelector('.btnMoreCommands');
        if (menuBtn) {
            if (button.nextElementSibling !== menuBtn) {
                container.insertBefore(button, menuBtn);
            }
        } else if (button.parentNode !== container) {
            container.appendChild(button);
        }
    }

    // Schedules a full page reload to refresh DTO-derived text (Overview,
    // episode names, ratings) after the spoiler state changes. Only used when
    // the admin enabled Strict refresh mode: the image-URL refresh handles the
    // visual layer in-place, but title/overview/ratings come from a DTO the
    // page rendered ONCE on initial load and don't reactively update when the
    // server-side strip changes. Coalesced + debounced so successive
    // watched-marks (marking a season's worth of episodes one after another)
    // only trigger one reload.
    var pendingReload = null;
    function scheduleFullReload() {
        if (pendingReload) clearTimeout(pendingReload);
        pendingReload = setTimeout(function () {
            pendingReload = null;
            try { location.reload(); }
            catch (e) { console.warn(logPrefix, 'reload failed:', e); }
        }, 600);
    }

    // In-place refresh of every Jellyfin item-image URL on the page.
    // Triggered after a Spoiler Guard toggle so the visible state flips
    // without an F5. Appends `_sbcb=<timestamp>` to bust the browser HTTP
    // cache; the server image filter then re-runs against the user's
    // current state and returns the right bytes (blurred / clear /
    // hide-mode placeholder).
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
     * disabling Spoiler Guard. The dialog embeds a "Don't ask again for
     * 15 minutes" checkbox; if checked when the user confirms, the
     * snooze is persisted via localStorage. Returns true if the user
     * confirmed, false if they cancelled. When already snoozed, resolves
     * true immediately without showing a dialog.
     */
    function confirmDisableSpoiler() {
        // Persistent user pref takes precedence over the per-browser
        // localStorage snooze. Set via the user-settings panel.
        // Await the initial load so that a user who opted into
        // SkipDisableConfirm doesn't get the dialog during the cold-load
        // window before loadState() resolves.
        return whenLoaded().then(function () {
            if (userPrefs && userPrefs.SkipDisableConfirm) return true;
            if (isDisableSnoozed()) return true;
            return showConfirmDialog();
        });
    }

    // The actual dialog body lives in its own function so confirmDisableSpoiler
    // can short-circuit before opening it without duplicating the Dashboard
    // / fallback handling code.
    function showConfirmDialog() {
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

    /**
     * Click handler for the detail-page toggle: flips Spoiler Guard on/off for
     * this Series / Movie / Collection, shows a confirm dialog on disable
     * (unless snoozed / SkipDisableConfirm), toasts the result, and refreshes
     * thumbnails in place (plus a full reload when Strict refresh mode is on).
     */
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
            // Keep separate per-kind keys so translators can tailor the
            // wording later; all enabled messages are deliberately
            // mode-neutral because images may be hidden or blurred.
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
            // Also remove any reviews section currently rendered for THIS
            // detail page — works for both Series and Movie pages (movies
            // were previously gated out and stayed visible until
            // navigation/refresh after enabling Spoiler Guard).
            //
            // Mirror reviews.js's shouldSuppressForSpoilerMode exactly: the
            // admin toggle enables suppression, but a per-user override
            // (HideReviews === false = "show me reviews even with Spoiler
            // Guard on") wins. Without honoring it here, the toggle would
            // yank a panel the user explicitly opted to keep, until they
            // navigate and reviews.js re-renders it — an inconsistent flash.
            try {
                var reviewsOptOut = getUserPrefs().HideReviews === false;
                if (willBeEnabled
                    && JE.pluginConfig?.SpoilerStripReviews !== false
                    && !reviewsOptOut) {
                    var existingReviews = document.querySelector('#itemDetailPage:not(.hide) .tmdb-reviews-section')
                        || document.querySelector('.tmdb-reviews-section');
                    if (existingReviews && existingReviews.parentNode) {
                        existingReviews.parentNode.removeChild(existingReviews);
                    }
                }
            } catch (e) {
                console.warn(logPrefix, 'reviews section cleanup failed:', e);
            }
            // Refresh all <img> + background-image URLs immediately for
            // snappy visual feedback. The DOM text (Overview, titles,
            // ratings) only re-renders on the user's next navigation
            // unless the admin opted into Strict refresh mode, in which
            // case we also schedule a full page reload.
            try {
                refreshSpoilerableImages();
            } catch (e) {
                console.warn(logPrefix, 'refreshSpoilerableImages failed:', e);
            }
            if (JE.pluginConfig?.SpoilerBlurStrictRefresh === true) {
                scheduleFullReload();
            }
        }).catch(function (err) {
            console.error(logPrefix, 'Toggle failed:', err);
            if (JE.toast) JE.toast(JE.t('spoiler_blur_error_toast'));
        }).finally(function () {
            button.disabled = false;
        });
    }

    // Intercept watched-state mutations (mark played / unplayed) so we
    // can auto-refresh thumbnails afterwards. Without this, the
    // currently-rendered <img> URLs still have the OLD cache-bust prefix
    // and the user keeps seeing the stale (blurred / clear) state until
    // page refresh.
    //
    // Jellyfin's web client marks watched via one of two route shapes:
    //   POST/DELETE /Users/{uid}/PlayedItems/{itemId}   (legacy apiclient)
    //   POST/DELETE /UserPlayedItems/{itemId}           (modern React/SDK)
    // Match BOTH so a watched-state change refreshes thumbnails no
    // matter which client path fired it. Requests go through window.fetch in
    // modern Jellyfin and XMLHttpRequest in older ApiClient paths — patch both.
    var PLAYED_RE = /\/(?:Users\/[a-f0-9-]+\/PlayedItems|UserPlayedItems)\/[a-f0-9-]+/i;

    function maybeRefreshAfterMutation(method, urlStr) {
        if (typeof urlStr !== 'string') return;
        if (!PLAYED_RE.test(urlStr)) return;
        if (method !== 'POST' && method !== 'DELETE') return;
        // Bail if the user has no Spoiler Guard state.
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

    /**
     * Writes a per-browser identity cookie (je-spoiler-uid=<currentUserId>) so
     * the server-side image filter can attribute anonymous <img>/CSS-background
     * image requests to the right user.
     *
     * Why a cookie and not a URL param: on Jellyfin 12 the image endpoint no
     * longer accepts the api_key query param for USER identity (only an
     * Authorization header authenticates, and <img> tags can't send headers).
     * An earlier build globally rewrote HTMLImageElement.src to append api_key;
     * that both stopped working for identity on v12 AND, because it mutated URLs
     * after the browser had begun loading them, double-fetched every card image
     * (native → BlurHash → api_key → BlurHash) — a visible flicker on EVERY show.
     * A cookie rides along automatically with same-origin image requests without
     * touching the URL, so there is no re-fetch and no flicker.
     *
     * Trust model: this is an identity HINT, not an auth token — no secret rides
     * in it. The server (SpoilerUserResolver) trusts it ONLY to pick between
     * users that already have an active session from the request IP, so a
     * forged/stale value can't impersonate an absent user. Session-scoped
     * (clears on browser close) and refreshed on every load, so switching
     * accounts updates it. Do NOT reintroduce image-URL rewriting here.
     */
    function setIdentityCookie() {
        try {
            var uid = (typeof ApiClient !== 'undefined' && ApiClient.getCurrentUserId)
                ? ApiClient.getCurrentUserId() : null;
            if (uid) {
                document.cookie = 'je-spoiler-uid=' + encodeURIComponent(uid) + '; path=/; SameSite=Lax';
            }
        } catch (e) {
            console.warn(logPrefix, 'identity cookie set failed:', e);
        }
    }

    // Write the identity cookie as EARLY as possible — before init() (which runs
    // late in the plugin bootstrap, after loadScripts) and therefore before the
    // first wave of card <img> requests. The cookie persists across the SPA's
    // page reload, so after an in-browser account switch a stale previous-user
    // value would otherwise ride along with the new user's early image requests
    // (and mis-attribute their blur) until init() finally overwrites it. Setting
    // it here at module load — then retrying briefly until ApiClient reports a
    // user on a cold start — closes that window. Cheap: only reads
    // getCurrentUserId() and writes document.cookie.
    (function primeIdentityCookieEarly() {
        setIdentityCookie();
        var tries = 0;
        var iv;
        try {
            iv = setInterval(function () {
                var uid = (typeof ApiClient !== 'undefined' && ApiClient.getCurrentUserId)
                    ? ApiClient.getCurrentUserId() : null;
                if (uid) { setIdentityCookie(); clearInterval(iv); }
                else if (++tries >= 20) { clearInterval(iv); }
            }, 250);
        } catch (e) { /* setInterval unavailable — init() will still set it */ }
    })();

    function init() {
        if (!JE.pluginConfig || JE.pluginConfig.SpoilerBlurEnabled !== true) return;
        setIdentityCookie();
        try { installWatchedMutationHook(); }
        catch (e) { console.warn(logPrefix, 'watched-mutation hook install failed:', e); }
        loadState();
    }

    /**
     * Returns a copy of the current user's Spoiler Guard override prefs.
     * Empty object on first load.
     */
    function getUserPrefs() {
        return Object.assign({}, userPrefs);
    }

    /**
     * Persist updated override prefs server-side and update the local cache.
     * Caller passes the full prefs object; missing keys are treated as null
     * by the server (inherit admin). Returns the saved prefs on success.
     */
    function setUserPrefs(next) {
        var payload = next || {};
        return ApiClient.ajax({
            url: ApiClient.getUrl('JellyfinEnhanced/spoiler-blur/user-prefs'),
            type: 'POST',
            contentType: 'application/json',
            data: JSON.stringify(payload),
            dataType: 'json',
        }).then(function (res) {
            userPrefs = Object.assign({}, payload);
            return res && res.prefs ? res.prefs : userPrefs;
        }).catch(function (err) {
            // Always log with the logPrefix so the failure is greppable in
            // the console, even if every caller swallows the rejection.
            console.error(logPrefix, 'setUserPrefs failed:', err);
            throw err;
        });
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
        isLoadOk: isLoadOk,
        confirmDisableSpoiler: confirmDisableSpoiler,
        getUserPrefs: getUserPrefs,
        setUserPrefs: setUserPrefs,
    };
})(window.JellyfinEnhanced);
