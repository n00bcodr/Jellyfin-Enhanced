// /js/arr/arr-links.js
(function (JE) {
    'use strict';

    JE.initializeArrLinksScript = async function () {
        const logPrefix = '🪼 Jellyfin Enhanced: Arr Links:';

        if (!JE?.pluginConfig?.ArrLinksEnabled) {
            console.log(`${logPrefix} Integration disabled in plugin settings.`);
            return;
        }

        // Check admin status on every script initialization
        let isAdmin = false;

        try {
            // Use the user object pre-fetched during plugin.js init (Stage 2) when available.
            // Falls back to a short direct fetch so the module isn't blocked for up to 10 s.
            let user = JE.currentUser || null;
            if (!user) {
                for (let i = 0; i < 5; i++) {  // shortened retry window (~2.5s)
                    try {
                        user = await ApiClient.getCurrentUser();
                        if (user) break;
                    } catch (e) {
                        // swallow error, retry
                    }
                    await new Promise(r => setTimeout(r, 500));
                }
            }

            if (!user) {
                console.error(`${logPrefix} Could not get current user after retries.`);
                return;
            }

            isAdmin = user?.Policy?.IsAdministrator === true;

            // Update settings.json if the value changed
            if (JE?.currentSettings && JE.currentSettings.isAdmin !== isAdmin && typeof JE.saveUserSettings === 'function') {
                JE.currentSettings.isAdmin = isAdmin;
                await JE.saveUserSettings('settings.json', JE.currentSettings);
                console.log(`${logPrefix} Updated admin status in settings.json: ${isAdmin}`);
            } else if (JE?.currentSettings) {
                JE.currentSettings.isAdmin = isAdmin;
                console.log(`${logPrefix} Admin status: ${isAdmin}`);
            }
        } catch (err) {
            console.error(`${logPrefix} Error checking admin status:`, err);
            return;
        }

        if (!isAdmin) {
            console.log(`${logPrefix} User is not an administrator. Links will not be shown.`);
            return;
        }

        console.log(`${logPrefix} Initializing...`);

        // Surface stored-config corruption to the admin on first init rather than waiting for
        // an action endpoint. The backend ships boolean flags in /private-config so the frontend
        // can toast without round-tripping an action call.
        if (JE?.pluginConfig?.SonarrInstancesCorrupt && typeof JE.toast === 'function') {
            JE.toast('⚠ Sonarr instance configuration is corrupt. Open the Jellyfin Enhanced config page to reset it.');
            console.error(`${logPrefix} SonarrInstances stored JSON is corrupt.`);
        }
        if (JE?.pluginConfig?.RadarrInstancesCorrupt && typeof JE.toast === 'function') {
            JE.toast('⚠ Radarr instance configuration is corrupt. Open the Jellyfin Enhanced config page to reset it.');
            console.error(`${logPrefix} RadarrInstances stored JSON is corrupt.`);
        }

        let isAddingLinks = false; // Lock to prevent concurrent runs
        let debounceTimer = null;
        let observer = null;
        // Cache Sonarr titleSlugs + Radarr instance matches by ID. Per-session only;
        // admin must hard-reload the web client after changing instance config for
        // this cache to drop (same constraint every other JE module has today).
        const slugCache = new Map();

        // Parse URL mappings from config
        function parseUrlMappings(mappingsString) {
            const mappings = [];
            if (!mappingsString) return mappings;

            mappingsString.split('\n').forEach(line => {
                const trimmed = line.trim();
                if (!trimmed) return;

                const parts = trimmed.split('|').map(p => p.trim());
                if (parts.length === 2 && parts[0] && parts[1]) {
                    mappings.push({
                        jellyfinUrl: parts[0],
                        arrUrl: parts[1]
                    });
                }
            });

            return mappings;
        }

        // Get the appropriate *arr URL based on how Jellyfin is being accessed
        function getMappedUrl(urlMappings, defaultUrl) {
            if (!defaultUrl) {
                return null;
            }

            if (!urlMappings || urlMappings.length === 0) {
                return defaultUrl;
            }

            const serverAddress = (typeof ApiClient !== 'undefined' && ApiClient.serverAddress)
                ? ApiClient.serverAddress()
                : window.location.origin;

            const currentUrl = serverAddress.replace(/\/+$/, '').toLowerCase();

            // Check if current Jellyfin URL matches any mapping
            for (const mapping of urlMappings) {
                const normalizedJellyfinUrl = mapping.jellyfinUrl.replace(/\/+$/, '').toLowerCase();

                if (currentUrl === normalizedJellyfinUrl) {
                    return mapping.arrUrl.replace(/\/$/, '');
                }
            }

            // No mapping matched, return default URL
            return defaultUrl;
        }

        try {
            const SONARR_ICON_URL = 'https://cdn.jsdelivr.net/gh/selfhst/icons/svg/sonarr.svg';
            const RADARR_ICON_URL = 'https://cdn.jsdelivr.net/gh/selfhst/icons/svg/radarr-light-hybrid-light.svg';
            const BAZARR_ICON_URL = 'https://cdn.jsdelivr.net/gh/selfhst/icons/svg/bazarr.svg';

            // Multi-instance support: read instance arrays from private-config, drop disabled
            // entries so the dropdown never offers a link to an instance the admin has toggled
            // off. Backend fan-out already skips disabled instances, so no match would appear
            // for them anyway — but this keeps the dropdown tidy when only disabled instances
            // would otherwise show for a given item. Falls back to legacy single fields below.
            const sonarrInstances = (JE.pluginConfig.SonarrInstances || [])
                .filter(i => i && i.Enabled !== false)
                .map(i => ({
                    name: i.Name || 'Sonarr',
                    url: getMappedUrl(parseUrlMappings(i.UrlMappings || ''), i.Url),
                    rawUrl: i.Url,
                    urlMappings: i.UrlMappings || ''
                })).filter(i => i.url);

            const radarrInstances = (JE.pluginConfig.RadarrInstances || [])
                .filter(i => i && i.Enabled !== false)
                .map(i => ({
                    name: i.Name || 'Radarr',
                    url: getMappedUrl(parseUrlMappings(i.UrlMappings || ''), i.Url),
                    rawUrl: i.Url,
                    urlMappings: i.UrlMappings || ''
                })).filter(i => i.url);

            // Fall back to legacy single-instance config if no instances available
            if (sonarrInstances.length === 0 && JE.pluginConfig.SonarrUrl) {
                const legacyMappings = parseUrlMappings(JE.pluginConfig.SonarrUrlMappings || '');
                const legacyUrl = getMappedUrl(legacyMappings, JE.pluginConfig.SonarrUrl);
                if (legacyUrl) {
                    sonarrInstances.push({ name: 'Sonarr', url: legacyUrl, rawUrl: JE.pluginConfig.SonarrUrl, urlMappings: '' });
                }
            }
            if (radarrInstances.length === 0 && JE.pluginConfig.RadarrUrl) {
                const legacyMappings = parseUrlMappings(JE.pluginConfig.RadarrUrlMappings || '');
                const legacyUrl = getMappedUrl(legacyMappings, JE.pluginConfig.RadarrUrl);
                if (legacyUrl) {
                    radarrInstances.push({ name: 'Radarr', url: legacyUrl, rawUrl: JE.pluginConfig.RadarrUrl, urlMappings: '' });
                }
            }

            const bazarrMappings = parseUrlMappings(JE.pluginConfig.BazarrUrlMappings || '');
            const bazarrUrl = getMappedUrl(bazarrMappings, JE.pluginConfig.BazarrUrl);

            const styleId = 'arr-links-styles';
            if (!document.getElementById(styleId)) {
                const style = document.createElement('style');
                style.id = styleId;
                style.textContent = `
                    /* Status colors on the link button border */
                    .arr-link--complete { border-left: 3px solid #52b54b !important; }
                    .arr-link--partial  { border-left: 3px solid #e5a00d !important; }
                    .arr-link--missing  { border-left: 3px solid #666 !important; opacity: 0.7; }

                    /* Icon image inside the button */
                    .arr-link-img {
                        width: 25px;
                        height: 25px;
                        display: block;
                        object-fit: contain;
                    }

                    /* Status badge (text-mode only) */
                    .arr-badge {
                        font-size: 0.75em;
                        padding: 1px 5px;
                        border-radius: 3px;
                        margin-left: 6px;
                        vertical-align: middle;
                        font-weight: 600;
                    }
                    .arr-badge--complete { background: rgba(82,181,75,0.2); color: #52b54b; }
                    .arr-badge--partial  { background: rgba(229,160,13,0.2); color: #e5a00d; }
                    .arr-badge--missing  { background: rgba(102,102,102,0.2); color: #999; }

                    /* Dropdown wrapper — sits inline with sibling link buttons */
                    .arr-dropdown {
                        position: relative;
                        display: inline-block;
                    }

                    /* Dropdown menu — colours injected as CSS vars at render time */
                    .arr-dropdown-menu {
                        display: none;
                        position: absolute;
                        top: calc(100% + 6px);
                        left: 0;
                        z-index: 9999;
                        min-width: 240px;
                        background: var(--arr-menu-bg, rgba(20,20,28,0.98));
                        color: var(--arr-menu-text, #fff);
                        border: 1px solid var(--arr-menu-border, rgba(255,255,255,0.2));
                        border-radius: 8px;
                        box-shadow: 0 12px 32px rgba(0,0,0,0.6);
                        padding: 4px 0;
                        backdrop-filter: blur(12px);
                        -webkit-backdrop-filter: blur(12px);
                    }
                    .arr-dropdown.open .arr-dropdown-menu { display: block; }

                    .arr-dropdown-item {
                        display: flex;
                        align-items: center;
                        gap: 10px;
                        padding: 9px 14px;
                        color: var(--arr-menu-text, #fff);
                        text-decoration: none;
                        font-size: 0.9em;
                        white-space: nowrap;
                        transition: background 0.12s;
                    }
                    .arr-dropdown-item:hover {
                        background: var(--arr-menu-hover, rgba(255,255,255,0.1));
                        color: var(--arr-menu-text, #fff);
                    }
                    .arr-dropdown-item-name { flex: 1; font-weight: 500; }
                    .arr-dropdown-item-stats {
                        color: var(--arr-menu-muted, rgba(255,255,255,0.55));
                        font-size: 0.85em;
                    }
                    .arr-dropdown-dot {
                        width: 8px;
                        height: 8px;
                        border-radius: 50%;
                        flex-shrink: 0;
                    }
                    .arr-dropdown-dot--complete { background: #52b54b; }
                    .arr-dropdown-dot--partial  { background: #e5a00d; }
                    .arr-dropdown-dot--missing  { background: #888; }

                    /* Progress bar */
                    .arr-progress {
                        display: block;
                        height: 2px;
                        margin-top: 2px;
                        border-radius: 1px;
                        background: rgba(255,255,255,0.1);
                        overflow: hidden;
                    }
                    .arr-progress-fill { height: 100%; border-radius: 1px; transition: width 0.3s; }
                    .arr-progress-fill--complete { background: #52b54b; }
                    .arr-progress-fill--partial  { background: #e5a00d; }
                    .arr-progress-fill--missing  { background: #666; }
                `;
                document.head.appendChild(style);
            }

            function formatBytes(bytes) {
                if (!bytes || bytes <= 0) return '';
                if (bytes < 1073741824) return (bytes / 1048576).toFixed(0) + ' MB';
                return (bytes / 1073741824).toFixed(1) + ' GB';
            }

            function getStatus(episodeFileCount, episodeCount) {
                if (episodeFileCount === 0) return 'missing';
                if (episodeFileCount >= episodeCount) return 'complete';
                return 'partial';
            }

            function getExternalIds(context) {
                const ids = { tmdb: null, hasTmdbLink: false };
                const links = context.querySelectorAll('.itemExternalLinks a, .externalIdLinks a');
                links.forEach(link => {
                    const href = link.href;
                    if (href.includes('themoviedb.org/movie/')) {
                        ids.tmdb = href.match(/\/movie\/(\d+)/)?.[1];
                        ids.hasTmdbLink = true;
                    } else if (href.includes('themoviedb.org/tv/')) {
                        ids.tmdb = href.match(/\/tv\/(\d+)/)?.[1];
                        ids.hasTmdbLink = true;
                    }
                });
                return ids;
            }

            // Track whether we've already toasted about a backend fetch failure in this session —
            // otherwise every card render on the item page would re-toast. Also track already-toasted
            // per-instance errors so a misconfigured instance doesn't flood the user with toasts.
            const _toastedGlobalFailure = { sonarr: false, radarr: false };
            const _toastedInstanceErrors = new Set();

            // Alias the shared helper so the toast concatenations read short. JE.toast renders
            // via innerHTML, so any caller-controlled field (admin-set instance name, upstream
            // error reason) must pass through escape() to prevent stored XSS.
            // The inline fallback is a real escaper so XSS is blocked even if helpers.js
            // hasn't loaded yet (e.g. a load-order race on first init).
            const esc = (s) => {
                if (JE.helpers?.escHtml) return JE.helpers.escHtml(s);
                return String(s == null ? '' : s)
                    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
            };

            function surfaceInstanceErrors(kind, errors) {
                if (!Array.isArray(errors) || errors.length === 0) {
                    // Empty-errors fetch means everything that was failing has recovered. Drop any
                    // memo entries whose kind matches so the same error can re-toast if it returns.
                    Array.from(_toastedInstanceErrors).forEach(function(k) {
                        if (k.startsWith(kind + '|')) _toastedInstanceErrors.delete(k);
                    });
                    return;
                }
                const seenThisTick = new Set();
                errors.forEach(function(err) {
                    const key = kind + '|' + err.instanceName + '|' + err.reason;
                    seenThisTick.add(key);
                    if (_toastedInstanceErrors.has(key)) return;
                    _toastedInstanceErrors.add(key);
                    if (typeof JE.toast === 'function') {
                        JE.toast('⚠ ' + esc(kind) + ' instance "' + esc(err.instanceName || 'unknown') + '" failed: ' + esc(err.reason));
                    }
                    console.warn(`${logPrefix} ${kind} instance "${err.instanceName}" error: ${err.reason}`);
                });
                // Self-heal: drop memo entries for errors that didn't reappear this tick.
                Array.from(_toastedInstanceErrors).forEach(function(k) {
                    if (k.startsWith(kind + '|') && !seenThisTick.has(k)) _toastedInstanceErrors.delete(k);
                });
            }

            function surfaceGlobalFailure(kind, detail) {
                if (_toastedGlobalFailure[kind.toLowerCase()]) return;
                _toastedGlobalFailure[kind.toLowerCase()] = true;
                if (typeof JE.toast === 'function') {
                    JE.toast('⚠ ' + esc(kind) + ' lookup failed; links unavailable. See console for details.');
                }
                console.warn(`${logPrefix} ${kind} lookup backend failed:`, detail);
            }

            /**
             * Resolves the Sonarr URL slugs across all configured instances.
             * On backend failure, returns an empty array (no links) and surfaces a toast — never
             * fabricates per-instance entries with guessed slugs, which would produce dropdown links
             * pointing at instances that may not contain the series at all (H3).
             * @param {Object} item - Jellyfin item object with Name, OriginalTitle, and ProviderIds
             * @returns {Promise<Array>} Array of { instanceName, instanceUrl, titleSlug, ... } matches
             */
            async function getSonarrSlugs(item) {
                const tvdbId = String(item.ProviderIds?.Tvdb || '');
                const cacheKey = `slugs-${tvdbId}`;

                if (tvdbId && slugCache.has(cacheKey)) {
                    return slugCache.get(cacheKey);
                }

                if (!tvdbId) {
                    // Without a TVDB ID the multi-instance lookup would fail anyway — return empty
                    // so we render no link instead of guessing which instance has the series.
                    return [];
                }

                try {
                    const resp = await fetch(ApiClient.getUrl(`/JellyfinEnhanced/arr/series-slugs?tvdbId=${encodeURIComponent(tvdbId)}`), {
                        headers: { 'X-MediaBrowser-Token': ApiClient.accessToken() }
                    });
                    if (!resp.ok) {
                        surfaceGlobalFailure('Sonarr', `HTTP ${resp.status}`);
                        return [];
                    }
                    const data = await resp.json();
                    // Reset the once-per-session toast guards on successful fetch so a transient
                    // failure that has since cleared up isn't permanently silenced for real
                    // future failures.
                    _toastedGlobalFailure.sonarr = false;
                    surfaceInstanceErrors('Sonarr', data.errors);
                    const matches = Array.isArray(data.matches) ? data.matches : [];
                    const results = matches.map(m => ({
                        instanceName: m.instanceName,
                        instanceUrl: getMappedUrl(parseUrlMappings(m.urlMappings || ''), m.instanceUrl),
                        titleSlug: m.titleSlug,
                        episodeFileCount: m.episodeFileCount || 0,
                        episodeCount: m.episodeCount || 0,
                        sizeOnDisk: m.sizeOnDisk || 0,
                        rootFolderPath: m.rootFolderPath || ''
                    }));
                    slugCache.set(cacheKey, results);
                    return results;
                } catch (e) {
                    surfaceGlobalFailure('Sonarr', e);
                    return [];
                }
            }

            /**
             * Looks up which Radarr instances have a given movie by TMDB ID.
             * On backend failure, returns an empty array and surfaces a toast — never fabricates a
             * fake "all instances have it" result, which would render dropdown links pointing at
             * instances that don't actually contain the movie (H3).
             * @param {string} tmdbId - TMDB ID of the movie
             * @returns {Promise<Array>} Array of matching instances
             */
            async function getRadarrInstances(tmdbId) {
                if (!tmdbId) return [];

                const cacheKey = `radarr-${tmdbId}`;
                if (slugCache.has(cacheKey)) {
                    return slugCache.get(cacheKey);
                }

                try {
                    const resp = await fetch(ApiClient.getUrl(`/JellyfinEnhanced/arr/movie-instances?tmdbId=${encodeURIComponent(tmdbId)}`), {
                        headers: { 'X-MediaBrowser-Token': ApiClient.accessToken() }
                    });
                    if (!resp.ok) {
                        surfaceGlobalFailure('Radarr', `HTTP ${resp.status}`);
                        return [];
                    }
                    const data = await resp.json();
                    _toastedGlobalFailure.radarr = false;  // reset on success; see Sonarr version above
                    surfaceInstanceErrors('Radarr', data.errors);
                    const matches = Array.isArray(data.matches) ? data.matches : [];
                    const results = matches.map(m => ({
                        name: m.instanceName,
                        url: getMappedUrl(parseUrlMappings(m.urlMappings || ''), m.instanceUrl),
                        hasFile: m.hasFile || false,
                        sizeOnDisk: m.sizeOnDisk || 0,
                        rootFolderPath: m.rootFolderPath || ''
                    }));
                    slugCache.set(cacheKey, results);
                    return results;
                } catch (e) {
                    surfaceGlobalFailure('Radarr', e);
                    return [];
                }
            }

            async function addArrLinks() {
                if (isAddingLinks) {
                    return;
                }

                const visiblePage = document.querySelector('#itemDetailPage:not(.hide)');
                if (!visiblePage) return;

                const anchorElement = visiblePage.querySelector('.itemExternalLinks');

                // Cleanup stale links from any non-visible pages to prevent future conflicts
                document.querySelectorAll('#itemDetailPage.hide .arr-link').forEach(staleLink => {
                    if (staleLink.previousSibling && staleLink.previousSibling.nodeType === Node.TEXT_NODE) {
                       staleLink.previousSibling.remove();
                    }
                    staleLink.remove();
                });

                if (!anchorElement || anchorElement.querySelector('.arr-link')) {
                    return;
                }

                // Capture the hash and item id at entry. Three awaits (getItemCached +
                // getSonarrSlugs + getRadarrInstances) can span several seconds on a slow
                // connection, during which the user may navigate away. After each await we
                // re-check that (a) the anchor is still in the DOM, (b) the same detail page
                // is still visible, (c) the hash still points at the same item, and bail out
                // if any of those changed (H6). This stops us from appending links to a page
                // the user already left or to a different item.
                const hashAtStart = window.location.hash;
                const isStillValidTarget = () =>
                    document.contains(anchorElement)
                    && !anchorElement.closest('#itemDetailPage.hide')
                    && window.location.hash === hashAtStart;

                isAddingLinks = true;
                try {
                    const itemId = new URLSearchParams(window.location.hash.split('?')[1]).get('id');
                    if (!itemId) return;

                    const item = JE.helpers?.getItemCached
                        ? await JE.helpers.getItemCached(itemId)
                        : await ApiClient.getItem(ApiClient.getCurrentUserId(), itemId);

                    if (!isStillValidTarget()) return;

                    // Only process movies and TV shows
                    if (item?.Type !== 'Movie' && item?.Type !== 'Series') return;

                    const ids = getExternalIds(visiblePage);

                    // Only add ARR links if we find a themoviedb link
                    if (!ids.hasTmdbLink) {
                        return;
                    }

                    // When only one instance matches, collapsing the episode count + status
                    // border to a plain link keeps the detail page tidy. Multi-instance dropdowns
                    // always show status because distinguishing between instances is their whole
                    // purpose. Admin can opt in to always-show via ArrLinksShowStatusSingle.
                    const showStatusOnSingle = JE?.pluginConfig?.ArrLinksShowStatusSingle === true;

                    if (item.Type === 'Series' && item.Name && sonarrInstances.length > 0) {
                        const slugMatches = await getSonarrSlugs(item);
                        if (!isStillValidTarget()) return;
                        const validMatches = slugMatches.filter(m => m.instanceUrl);
                        if (validMatches.length === 1) {
                            const m = validMatches[0];
                            const url = `${m.instanceUrl.replace(/\/$/, '')}/series/${m.titleSlug}`;
                            const haveStats = m.episodeFileCount >= 0;
                            const status = showStatusOnSingle && haveStats ? getStatus(m.episodeFileCount, m.episodeCount) : null;
                            const badge = showStatusOnSingle && haveStats ? `${m.episodeFileCount}/${m.episodeCount}` : '';
                            const size = formatBytes(m.sizeOnDisk);
                            // Tooltip still surfaces the detail — hiding the badge doesn't mean
                            // hiding information, just decluttering the pill itself.
                            const tipParts = [m.instanceName];
                            if (haveStats) tipParts.push(`${m.episodeFileCount}/${m.episodeCount} episodes`);
                            if (size) tipParts.push(size);
                            if (m.rootFolderPath) tipParts.push(m.rootFolderPath);
                            const tip = tipParts.join('\n');
                            anchorElement.appendChild(document.createTextNode(' '));
                            anchorElement.appendChild(createLinkButton('Sonarr', url, 'arr-link-sonarr', status, badge, tip));
                        } else if (validMatches.length > 1) {
                            const items = validMatches.map(m => {
                                const status = m.episodeFileCount < 0 ? null : getStatus(m.episodeFileCount, m.episodeCount);
                                const badge = m.episodeFileCount < 0 ? '' : `${m.episodeFileCount}/${m.episodeCount}`;
                                const size = formatBytes(m.sizeOnDisk);
                                const tip = [badge ? `${badge} episodes` : null, size, m.rootFolderPath].filter(Boolean).join(' \u2022 ');
                                return {
                                    name: m.instanceName,
                                    url: `${m.instanceUrl.replace(/\/$/, '')}/series/${m.titleSlug}`,
                                    status, badge, size, tip
                                };
                            });
                            anchorElement.appendChild(document.createTextNode(' '));
                            anchorElement.appendChild(createDropdown('Sonarr', 'arr-link-sonarr', items));
                        }
                    }

                    if (item.Type === 'Movie' && ids.tmdb && radarrInstances.length > 0) {
                        const matchingRadarrs = await getRadarrInstances(ids.tmdb);
                        if (!isStillValidTarget()) return;
                        const validMatches = matchingRadarrs.filter(m => m.url);
                        if (validMatches.length === 1) {
                            const m = validMatches[0];
                            const url = `${m.url.replace(/\/$/, '')}/movie/${ids.tmdb}`;
                            const statusValue = m.hasFile ? 'complete' : 'missing';
                            const badgeValue = m.hasFile ? 'Downloaded' : 'Missing';
                            const status = showStatusOnSingle ? statusValue : null;
                            const badge = showStatusOnSingle ? badgeValue : '';
                            const size = formatBytes(m.sizeOnDisk);
                            // Tooltip keeps the "Downloaded/Missing" detail regardless, so info
                            // isn't lost when the visible badge is suppressed.
                            const tip = [m.name, badgeValue, size, m.rootFolderPath].filter(Boolean).join('\n');
                            anchorElement.appendChild(document.createTextNode(' '));
                            anchorElement.appendChild(createLinkButton('Radarr', url, 'arr-link-radarr', status, badge, tip));
                        } else if (validMatches.length > 1) {
                            const items = validMatches.map(m => {
                                const status = m.hasFile ? 'complete' : 'missing';
                                const badge = m.hasFile ? 'Downloaded' : 'Missing';
                                const size = formatBytes(m.sizeOnDisk);
                                const tip = [badge, size, m.rootFolderPath].filter(Boolean).join(' \u2022 ');
                                return {
                                    name: m.name,
                                    url: `${m.url.replace(/\/$/, '')}/movie/${ids.tmdb}`,
                                    status, badge, size, tip
                                };
                            });
                            anchorElement.appendChild(document.createTextNode(' '));
                            anchorElement.appendChild(createDropdown('Radarr', 'arr-link-radarr', items));
                        }
                    }

                    if (item.Type === 'Series' && bazarrUrl) {
                        const url = `${bazarrUrl}/series/`;
                        anchorElement.appendChild(document.createTextNode(' '));
                        anchorElement.appendChild(createLinkButton("Bazarr", url, "arr-link-bazarr"));
                    } else if (item.Type === 'Movie' && bazarrUrl) {
                        const url = `${bazarrUrl}/movies/`;
                        anchorElement.appendChild(document.createTextNode(' '));
                        anchorElement.appendChild(createLinkButton("Bazarr", url, "arr-link-bazarr"));
                    }
                } finally {
                    isAddingLinks = false;
                }
            }

            // Map iconClass → icon URL for <img>-based rendering
            const ICON_URLS = {
                'arr-link-sonarr': SONARR_ICON_URL,
                'arr-link-radarr': RADARR_ICON_URL,
                'arr-link-bazarr': BAZARR_ICON_URL,
            };

            function createLinkButton(text, url, iconClass, status, badge, tooltip) {
                const button = document.createElement('a');
                button.setAttribute('is', 'emby-linkbutton');
                const statusClass = status ? ` arr-link--${status}` : '';
                if (JE.pluginConfig.ShowArrLinksAsText) {
                    button.className = `button-link emby-button arr-link${statusClass}`;
                    button.textContent = text;
                    // Badge in text-mode so users have visible status without hovering
                    if (badge) {
                        const badgeEl = document.createElement('span');
                        badgeEl.className = `arr-badge arr-badge--${status || 'missing'}`;
                        badgeEl.textContent = badge;
                        button.appendChild(badgeEl);
                    }
                } else {
                    button.className = `button-link emby-button arr-link${statusClass}`;
                    // Use <img> so the icon sits inline exactly like Jellyfin's own external link icons
                    const iconUrl = ICON_URLS[iconClass];
                    if (iconUrl) {
                        const img = document.createElement('img');
                        img.src = iconUrl;
                        img.alt = text;
                        img.className = 'arr-link-img';
                        button.appendChild(img);
                    }
                }
                button.href = url;
                button.target = '_blank';
                button.rel = 'noopener noreferrer';
                button.title = tooltip || text;
                return button;
            }

            function createDropdown(label, iconClass, items) {
                const wrapper = document.createElement('span');
                wrapper.className = 'arr-dropdown';

                // Inject theme-aware CSS variables onto the menu at creation time
                // so the dropdown colours match whatever theme is active
                const themeVars = JE.themer?.getThemeVariables?.() || {};
                const secondaryBg   = themeVars.secondaryBg   || 'rgba(20,20,28,0.98)';
                const textColor = themeVars.textColor  || '#fff';
                // Derive a slightly lighter surface from panelBg for the menu
                wrapper.style.setProperty('--arr-menu-bg',     secondaryBg);
                wrapper.style.setProperty('--arr-menu-text',   textColor);
                wrapper.style.setProperty('--arr-menu-border', 'rgba(255,255,255,0.2)');
                wrapper.style.setProperty('--arr-menu-hover',  'rgba(255,255,255,0.1)');
                wrapper.style.setProperty('--arr-menu-muted',  'rgba(255,255,255,0.55)');

                // Toggle button — <img> icon + ▾ arrow as a text node
                const toggle = document.createElement('a');
                toggle.setAttribute('is', 'emby-linkbutton');
                toggle.className = 'button-link emby-button arr-link';
                toggle.href = '#';
                toggle.title = `${label} (${items.length} instances)`;

                if (JE.pluginConfig.ShowArrLinksAsText) {
                    toggle.textContent = label;
                } else {
                    const iconUrl = ICON_URLS[iconClass];
                    if (iconUrl) {
                        const img = document.createElement('img');
                        img.src = iconUrl;
                        img.alt = label;
                        img.className = 'arr-link-img';
                        toggle.appendChild(img);
                    }
                }
                // Visible ▾ arrow appended as a text node — no pseudo-element needed
                const arrow = document.createElement('span');
                arrow.textContent = '▾';
                arrow.style.cssText = 'font-size:0.8em; opacity:0.8; margin-left:2px; line-height:1; vertical-align:middle; color: white;';
                toggle.appendChild(arrow);

                toggle.addEventListener('click', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    document.querySelectorAll('.arr-dropdown.open').forEach(d => {
                        if (d !== wrapper) d.classList.remove('open');
                    });
                    wrapper.classList.toggle('open');
                });

                // Menu
                const menu = document.createElement('div');
                menu.className = 'arr-dropdown-menu';

                items.forEach(function(item) {
                    const link = document.createElement('a');
                    link.className = 'arr-dropdown-item';
                    link.href = item.url;
                    link.target = '_blank';
                    link.rel = 'noopener noreferrer';
                    link.title = item.tip || item.name;

                    const dot = document.createElement('span');
                    dot.className = `arr-dropdown-dot arr-dropdown-dot--${item.status || 'missing'}`;
                    link.appendChild(dot);

                    const nameSpan = document.createElement('span');
                    nameSpan.className = 'arr-dropdown-item-name';
                    nameSpan.textContent = item.name;
                    link.appendChild(nameSpan);

                    if (item.badge) {
                        const badgeSpan = document.createElement('span');
                        badgeSpan.className = `arr-badge arr-badge--${item.status || 'missing'}`;
                        badgeSpan.textContent = item.badge;
                        link.appendChild(badgeSpan);
                    }

                    if (item.size) {
                        const sizeSpan = document.createElement('span');
                        sizeSpan.className = 'arr-dropdown-item-stats';
                        sizeSpan.textContent = item.size;
                        link.appendChild(sizeSpan);
                    }

                    menu.appendChild(link);
                });

                wrapper.appendChild(toggle);
                wrapper.appendChild(menu);

                return wrapper;
            }

            // Single delegated listener for closing all arr dropdowns on outside click.
            document.addEventListener('click', function(e) {
                if (!e.target.closest('.arr-dropdown')) {
                    document.querySelectorAll('.arr-dropdown.open').forEach(d => d.classList.remove('open'));
                }
            });

            observer = JE.helpers.createObserver('arr-links', () => {
                if (!JE?.pluginConfig?.ArrLinksEnabled) {
                    if (observer) {
                        observer.disconnect();
                        console.log(`${logPrefix} Observer disconnected — feature disabled`);
                    }
                    return;
                }

                // Debounce to avoid excessive processing on rapid DOM changes
                if (debounceTimer) {
                    clearTimeout(debounceTimer);
                }

                debounceTimer = setTimeout(() => {
                    addArrLinks();
                }, 100); // Wait 100ms after last mutation before processing
            }, document.body, {
                // childList + subtree is enough — Jellyfin re-renders the detail page children
                // on SPA navigation. The shared body observer's fast-path drops attribute-only
                // batches (see CLAUDE.md "Observer Multiplexer" notes), so attributeFilter
                // would be inert here.
                childList: true,
                subtree: true,
            });

            // Store observer reference for potential cleanup
            JE._arrLinksObserver = observer;

            console.log(`${logPrefix} Initialized successfully`);
        } catch (err) {
            console.error(`${logPrefix} Failed to initialize`, err);
        }
    };
})(window.JellyfinEnhanced);
