// /js/jellyseerr/issue-reporter.js
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Issue Reporter:';
    const issueReporter = {};

    /**
     * Issue type definitions matching Jellyseerr's 4 core issue types
     * Jellyseerr uses: VIDEO (1), AUDIO (2), SUBTITLES (3), OTHER (4)
     */
    const ISSUE_TYPES = [
        { value: '1', label: 'VIDEO', icon: '🎬' },
        { value: '2', label: 'AUDIO', icon: '🎵' },
        { value: '3', label: 'SUBTITLES', icon: '📝' },
        { value: '4', label: 'OTHER', icon: '❓' }
    ];

    /**
     * Shows the issue report modal for the given media item
     * @param {string} tmdbId - TMDB ID of the media
     * @param {string} itemName - Name of the media item
     * @param {string} mediaType - 'movie' or 'tv'
     * @param {string} backdropPath - Optional TMDB backdrop image path
     */
    issueReporter.showReportModal = function(tmdbId, itemName, mediaType, backdropPath = null, item = null) {
        // Create the form HTML
        const formHtml = `
            <div class="jellyseerr-issue-form">
                <div class="jellyseerr-form-group">
                    <label>Issue Type</label>
                    <div class="jellyseerr-issue-radio-group">
                        ${ISSUE_TYPES.map(type => `
                            <label class="jellyseerr-radio-label">
                                <input type="radio" name="issue-type" value="${type.value}" class="jellyseerr-radio-input" required>
                                <span class="jellyseerr-radio-option">${type.icon} ${type.label}</span>
                            </label>
                        `).join('')}
                    </div>
                </div>
                <div class="jellyseerr-form-group">
                    <label for="issue-message">Description (Optional)</label>
                    <textarea 
                        id="issue-message" 
                        class="jellyseerr-issue-textarea"
                        placeholder="Describe the issue in detail..."
                        rows="4"
                    ></textarea>
                </div>
                <div id="jellyseerr-tv-controls-placeholder"></div>
            </div>
        `;

        // Create modal using the existing modal system
        const { modalElement, show, close } = JE.jellyseerrModal.create({
            title: 'Report Issue',
            subtitle: itemName,
            bodyHtml: formHtml,
            backdropPath: backdropPath,
            buttonText: 'Submit',
            onSave: async (modalEl, button, closeModal) => {
                const issueType = modalEl.querySelector('input[name="issue-type"]:checked')?.value;
                const message = modalEl.querySelector('#issue-message').value;

                // Read TV season/episode selections if present
                let problemSeason = 0;
                let problemEpisode = 0;
                const seasonEl = modalEl.querySelector('#issue-season');
                const episodeEl = modalEl.querySelector('#issue-episode');
                if (seasonEl) {
                    problemSeason = parseInt(seasonEl.value) || 0;
                }
                // Always read the episode value if the element exists (even when disabled/preset on episode pages)
                if (episodeEl) {
                    problemEpisode = parseInt(episodeEl.value) || 0;
                }

                if (!issueType) {
                    JE.toast('Issue Type is required', 3000);
                    return;
                }

                try {
                    button.disabled = true;
                    button.textContent = 'Submitting...';

                    // Pass only the contents of the description box to the API
                    const result = await JE.jellyseerrAPI.reportIssue(tmdbId, mediaType, issueType, message, problemSeason, problemEpisode);

                    if (result) {
                        JE.toast('✅ Issue reported successfully!', 3000);
                        console.log(`${logPrefix} Issue successfully reported for ${itemName}`);
                        closeModal();
                    } else {
                        throw new Error('No response from API');
                    }
                } catch (error) {
                    console.error(`${logPrefix} Error reporting issue:`, error);
                    JE.toast('❌ Failed to report issue', 4000);
                    button.disabled = false;
                    button.textContent = 'Submit Report';
                }
            }
        });

        show();

        // If this is a TV item, augment the modal with season/episode selectors
        if (mediaType === 'tv') {
            (async () => {
                try {
                    const placeholder = modalElement.querySelector('#jellyseerr-tv-controls-placeholder');
                    if (!placeholder) return;

                    // Build the container for season/episode controls
                    const controlsHtml = `
                        <div class="jellyseerr-form-group">
                            <label for="issue-season">Season</label>
                            <select id="issue-season" class="jellyseerr-select"></select>
                        </div>
                        <div class="jellyseerr-form-group">
                            <label for="issue-episode">Episode</label>
                            <select id="issue-episode" class="jellyseerr-select"></select>
                        </div>
                    `;

                    placeholder.innerHTML = controlsHtml;

                    const seasonSelect = modalElement.querySelector('#issue-season');
                    const episodeSelect = modalElement.querySelector('#issue-episode');

                    // Helper to clear and set options
                    const setOptions = (selectEl, options) => {
                        selectEl.innerHTML = '';
                        for (const opt of options) {
                            const o = document.createElement('option');
                            o.value = String(opt.value);
                            o.textContent = opt.label;
                            selectEl.appendChild(o);
                        }
                    };

                    // Default state: disable controls until we populate
                    seasonSelect.disabled = true;
                    episodeSelect.disabled = true;

                    // Prefer to query the local Jellyfin server for available seasons/episodes
                    let normalized = [];
                    try {
                        // Determine the seriesId to query for seasons
                        let seriesId = null;
                        if (item?.Type === 'Series') seriesId = item.Id;
                        else if (item?.Type === 'Season' || item?.Type === 'Episode') seriesId = item.SeriesId || item.ParentId || (item.Series && item.Series.Id) || null;

                        if (seriesId) {
                            // Fetch seasons present on the Jellyfin server
                            const userId = ApiClient.getCurrentUserId();
                            const seasonsRes = await ApiClient.ajax({
                                type: 'GET',
                                url: ApiClient.getUrl('/Items', {
                                    ParentId: seriesId,
                                    IncludeItemTypes: 'Season',
                                    SortBy: 'IndexNumber',
                                    SortOrder: 'Ascending',
                                    Fields: 'IndexNumber,SeasonNumber',
                                    userId: userId
                                }),
                                dataType: 'json'
                            });

                            const seasonsList = seasonsRes?.Items || [];
                            normalized = seasonsList.map(s => ({
                                seasonNumber: parseInt(s.IndexNumber || s.SeasonNumber || s.ParentIndexNumber || 0) || 0,
                                id: s.Id,
                                episodes: []
                            })).filter(s => s.seasonNumber > 0);

                            // For each season, fetch episodes (only titles and numbers)
                            for (const s of normalized) {
                                try {
                                    const epsRes = await ApiClient.ajax({
                                        type: 'GET',
                                        url: ApiClient.getUrl('/Items', {
                                            ParentId: s.id,
                                            IncludeItemTypes: 'Episode',
                                            SortBy: 'IndexNumber',
                                            SortOrder: 'Ascending',
                                            Fields: 'IndexNumber,Name',
                                            userId: ApiClient.getCurrentUserId()
                                        }),
                                        dataType: 'json'
                                    });
                                    const eps = epsRes?.Items || [];
                                    s.episodes = eps.map(ep => ({ episodeNumber: parseInt(ep.IndexNumber || ep.ParentIndexNumber || ep.Index || 0) || 0, title: ep.Name || ep.Title || '' }));
                                } catch (e) {
                                    console.debug(`${logPrefix} Failed to fetch episodes for season ${s.seasonNumber}:`, e);
                                    s.episodes = [];
                                }
                            }
                        }
                    } catch (e) {
                        console.debug(`${logPrefix} Error fetching seasons/episodes from Jellyfin:`, e);
                        normalized = [];
                    }

                    // If no seasons found on server, fallback to minimal inference
                    if (!normalized || normalized.length === 0) {
                        const seasonCount = item?.SeasonCount || (item && item.Seasons && item.Seasons.length) || 0;
                        if (seasonCount && seasonCount > 0) {
                            for (let i = 1; i <= seasonCount; i++) normalized.push({ seasonNumber: i, episodes: [] });
                        }
                    }

                    // If still no seasons discovered, show a single 'All seasons' option and disable episode selector
                    if (!normalized || normalized.length === 0) {
                        setOptions(seasonSelect, [{ value: 0, label: 'All seasons' }]);
                        seasonSelect.disabled = true;
                        setOptions(episodeSelect, [{ value: 0, label: 'All episodes' }]);
                        episodeSelect.disabled = true;
                        return;
                    }

                    // Build season options
                    const seasonOptions = [];
                    // If more than one season, add 'All seasons'
                    if (normalized.length > 1) {
                        seasonOptions.push({ value: 0, label: 'All seasons' });
                    }
                    for (const s of normalized) {
                        seasonOptions.push({ value: s.seasonNumber, label: `Season ${s.seasonNumber}` });
                    }

                    setOptions(seasonSelect, seasonOptions);
                    seasonSelect.disabled = false;

                    // Helper to populate episodes for a season
                    const populateEpisodesForSeason = (seasonNum) => {
                        const s = normalized.find(x => x.seasonNumber === parseInt(seasonNum));
                        if (!s) {
                            setOptions(episodeSelect, [{ value: 0, label: 'All episodes' }]);
                            episodeSelect.disabled = true;
                            return;
                        }
                        const eps = s.episodes && s.episodes.length > 0 ? s.episodes : [];
                        const epOptions = [{ value: 0, label: 'All episodes' }];
                        if (eps.length > 0) {
                            for (const ep of eps) epOptions.push({ value: ep.episodeNumber, label: `Episode ${ep.episodeNumber}${ep.title ? ' — ' + ep.title : ''}` });
                        }
                        setOptions(episodeSelect, epOptions);
                        episodeSelect.disabled = false;
                    };

                    // If we are on a Season or Episode detail, try to preselect
                    const curType = item?.Type;
                    let curSeasonNum = null;
                    let curEpisodeNum = null;
                    if (curType === 'Season') {
                        curSeasonNum = item?.IndexNumber || item?.SeasonNumber || null;
                    } else if (curType === 'Episode') {
                        // Many Episode items have ParentIndexNumber for season and IndexNumber for episode
                        curSeasonNum = item?.ParentIndexNumber || item?.SeasonIndex || item?.ParentIndex || item?.SeasonNumber || null;
                        curEpisodeNum = item?.IndexNumber || item?.EpisodeNumber || null;
                    }

                    // Preselect logic
                    if (curSeasonNum) {
                        // If season options include the season, set select
                        const valToSet = String(curSeasonNum);
                        const opt = Array.from(seasonSelect.options).find(o => o.value === valToSet);
                        if (opt) seasonSelect.value = valToSet;
                        // If this is a Season detail, and only one season or user likely doesn't need to change, disable changing seasons
                        if (curType === 'Season') {
                            seasonSelect.disabled = true;
                        }
                        // populate episodes for that season
                        populateEpisodesForSeason(curSeasonNum);
                        if (curEpisodeNum) {
                            // try to set episode value and disable modification for episode detail
                            const epOpt = Array.from(episodeSelect.options).find(o => o.value === String(curEpisodeNum));
                            if (epOpt) episodeSelect.value = String(curEpisodeNum);
                            if (curType === 'Episode') {
                                episodeSelect.disabled = true;
                                seasonSelect.disabled = true;
                            }
                        }
                    } else {
                        // Default: set to 'All seasons' if present, and disable episode select
                        if (normalized.length > 1) {
                            seasonSelect.value = '0';
                            // Ensure the episode select shows the 'All episodes' option when defaulting
                            setOptions(episodeSelect, [{ value: 0, label: 'All episodes' }]);
                            episodeSelect.disabled = true;
                        } else {
                            // Single season - select it
                            seasonSelect.value = String(normalized[0].seasonNumber);
                            populateEpisodesForSeason(normalized[0].seasonNumber);
                        }
                    }

                    // When season changes, update episodes
                    seasonSelect.addEventListener('change', () => {
                        const val = seasonSelect.value;
                        if (!val || val === '0') {
                            // All seasons => show a single "All episodes" option to avoid blank UI and disable selection
                            setOptions(episodeSelect, [{ value: 0, label: 'All episodes' }]);
                            episodeSelect.disabled = true;
                        } else {
                            populateEpisodesForSeason(parseInt(val));
                        }
                    });

                } catch (err) {
                    console.debug(`${logPrefix} Error building tv controls:`, err);
                }
            })();
        }
    };

    /**
     * Adds a report issue button to the item detail page
     * @param {HTMLElement} container - Container to append the button to
     * @param {string} tmdbId - TMDB ID of the media
     * @param {string} itemName - Name of the media item
     * @param {string} mediaType - 'movie' or 'tv'
     * @param {string} backdropPath - Optional TMDB backdrop image path
     */
    issueReporter.createReportButton = function(container, tmdbId, itemName, mediaType, backdropPath = null, item = null) {
        if (!container) {
            console.warn(`${logPrefix} Container not found for report button`);
            return null;
        }

        const button = document.createElement('button');
        // Use a minimal/icon-only class so server CSS can style it like other action icons
        button.className = 'jellyseerr-report-issue-icon';
        button.type = 'button';
        button.setAttribute('aria-label', 'Report issue');
        button.title = 'Report issue';
        // Use an inline SVG: outlined triangle with solid exclamation (transparent fill)
        button.innerHTML = `
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" role="img" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 3L2 20h20L12 3z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
                <rect x="11" y="8" width="2" height="6" fill="currentColor" />
                <rect x="11" y="16" width="2" height="2" fill="currentColor" />
            </svg>
        `;

        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            issueReporter.showReportModal(tmdbId, itemName, mediaType, backdropPath, item);
        });

        return button;
    };

    /**
     * Create a disabled "unavailable" button to show when reporting isn't possible
     * @param {HTMLElement} container
     * @param {string} itemName
     * @param {string} mediaType
     */
    issueReporter.createUnavailableButton = function(container, itemName, mediaType) {
        if (!container) return null;

        const button = document.createElement('button');
        button.className = 'jellyseerr-report-unavailable-icon';
        button.type = 'button';
        button.setAttribute('aria-label', 'Reporting unavailable');
        button.title = 'Reporting unavailable';
        button.disabled = true;
        button.innerHTML = `
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" role="img" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 3L2 20h20L12 3z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
                <rect x="11" y="8" width="2" height="6" fill="currentColor" />
                <rect x="11" y="16" width="2" height="2" fill="currentColor" />
            </svg>
        `;

        // Still allow click to show a helpful toast explaining why
        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            JE.toast('Reporting is unavailable for this item (no TMDB match)', 4000);
        });

        return button;
    };

    /**
     * Attempts to fetch TMDB ID from external sources as a fallback
     * Uses OMDB API or other methods to find TMDB ID
     */
    issueReporter.getTmdbIdFallback = async function(itemName, mediaType, item) {
        try {
            console.debug(`${logPrefix} Attempting fallback TMDB lookup for ${itemName}`);
            
            // Check other provider IDs that might help
            if (item.ProviderIds?.Imdb) {
                console.debug(`${logPrefix} Found IMDB ID: ${item.ProviderIds.Imdb}, could use for lookup`);
            }
            
            // Try to use External URLs which might contain TMDB link
            if (item.ExternalUrls) {
                // Normalize to array of values (ExternalUrls may be an array or an object/map)
                const rawUrls = Array.isArray(item.ExternalUrls) ? item.ExternalUrls : Object.values(item.ExternalUrls || {});

                for (const entry of rawUrls) {
                    try {
                        let urlStr = null;

                        if (typeof entry === 'string') {
                            urlStr = entry;
                        } else if (entry && typeof entry === 'object') {
                            // Common properties that might contain the URL
                            urlStr = entry.Url || entry.url || entry.Value || entry.value || entry.Href || entry.href || entry.Link || entry.link || entry.Path || entry.path || null;

                            // Fallback: scan object's string values for a tmdb link
                            if (!urlStr) {
                                for (const v of Object.values(entry)) {
                                    if (typeof v === 'string' && v.includes('tmdb')) {
                                        urlStr = v;
                                        break;
                                    }
                                }
                            }
                        }

                        if (typeof urlStr === 'string' && urlStr.includes('tmdb')) {
                            const match = urlStr.match(/\/(\d+)/);
                            if (match) {
                                return match[1];
                            }
                        }
                    } catch (e) {
                        // Continue to next entry if any unexpected structure is encountered
                        console.debug(`${logPrefix} Skipping ExternalUrls entry due to error:`, e);
                        continue;
                    }
                }
            }

            // Second-level fallback: query Jellyseerr search by IMDB ID or by title+year
            try {
                if (JE && JE.jellyseerrAPI && typeof JE.jellyseerrAPI.search === 'function') {
                    // Prefer IMDB lookup when available
                    const imdbId = item.ProviderIds?.Imdb;
                    if (imdbId) {
                        console.debug(`${logPrefix} Trying Jellyseerr search by IMDB ID: ${imdbId}`);
                        const res = await JE.jellyseerrAPI.search(imdbId);
                        if (res && Array.isArray(res.results) && res.results.length > 0) {
                            // Prefer a result with matching mediaType
                            const match = res.results.find(r => (r.mediaType === mediaType || (mediaType === 'tv' && r.mediaType === 'tv') || (mediaType === 'movie' && r.mediaType === 'movie')) && r.id);
                            if (match && match.id) {
                                console.log(`${logPrefix} Found TMDB ID via Jellyseerr search (IMDB): ${match.id}`);
                                return String(match.id);
                            }
                            // Otherwise pick first with an id
                            if (res.results[0].id) {
                                console.log(`${logPrefix} Found TMDB ID via Jellyseerr search (IMDB fallback): ${res.results[0].id}`);
                                return String(res.results[0].id);
                            }
                        }
                    }

                    // Try name + year search
                    const year = item.ProductionYear || (item.PremiereDate ? item.PremiereDate.substring(0,4) : null) || '';
                    const titleQuery = `${item.Name}${year ? ' ' + year : ''}`;
                    console.debug(`${logPrefix} Trying Jellyseerr search by title: "${titleQuery}"`);
                    const res2 = await JE.jellyseerrAPI.search(titleQuery);
                    if (res2 && Array.isArray(res2.results) && res2.results.length > 0) {
                        // Try to find best match: exact title and same year
                        const exact = res2.results.find(r => {
                            const rTitle = (r.title || r.name || '').toString().toLowerCase();
                            const itemTitle = (item.Name || '').toString().toLowerCase();
                            const rYear = (r.releaseDate || r.firstAirDate || '').toString().substring(0,4) || '';
                            return rTitle === itemTitle && (year === '' || rYear === '' || rYear === String(year));
                        });
                        if (exact && exact.id) {
                            console.log(`${logPrefix} Found TMDB ID via Jellyseerr search (exact title): ${exact.id}`);
                            return String(exact.id);
                        }

                        // Fallback to first result with matching mediaType
                        const byType = res2.results.find(r => (r.mediaType === mediaType || (!r.mediaType && r.id)) && r.id);
                        if (byType && byType.id) {
                            console.log(`${logPrefix} Found TMDB ID via Jellyseerr search (title fallback): ${byType.id}`);
                            return String(byType.id);
                        }
                    }
                }
            } catch (error) {
                console.debug(`${logPrefix} Jellyseerr search fallback failed:`, error);
            }
            
            return null;
        } catch (error) {
            console.debug(`${logPrefix} Fallback lookup failed:`, error);
            return null;
        }
    };

    /**
     * Attempts to add the report issue button to the current detail page
     */
    issueReporter.tryAddButton = async function() {
        const itemDetailPage = document.querySelector('#itemDetailPage:not(.hide)');
        if (!itemDetailPage) {
            return false;
        }
        // Don't add if plugin or report-button feature is disabled
        if (!JE.pluginConfig?.JellyseerrEnabled || !JE.pluginConfig?.JellyseerrShowReportButton) {
            console.debug(`${logPrefix} Jellyseerr or report button disabled, skipping`);
            return false;
        }

        // Check if we already added the button
        if (itemDetailPage.querySelector('.jellyseerr-report-issue-icon')) {
            return false;
        }

        try {
            // Get item ID from URL hash (same way as reviews.js)
            const itemId = new URLSearchParams(window.location.hash.split('?')[1]).get('id');
            if (!itemId) {
                console.debug(`${logPrefix} No item ID in URL`);
                return false;
            }

            // Fetch item data from Jellyfin API (same way as reviews.js)
            const userId = ApiClient.getCurrentUserId();
            if (!userId) {
                console.debug(`${logPrefix} No user ID found`);
                return false;
            }

            const item = await ApiClient.getItem(userId, itemId);
            if (!item) {
                console.debug(`${logPrefix} Could not fetch item data`);
                return false;
            }

            // Determine media type. Treat Series, Season, Episode as 'tv'
            let tmdbId = item.ProviderIds?.Tmdb;
            const isTvLike = ['Series', 'Season', 'Episode'].includes(item.Type);
            const isMovie = item.Type === 'Movie';

            // Do not display report button for non-media collection pages (collections/boxsets/etc.)
            if (!isTvLike && !isMovie) {
                console.debug(`${logPrefix} Skipping ${item.Name}: unsupported item type (${item.Type}) — likely a collection/boxset`);
                return false;
            }

            const mediaType = isTvLike ? 'tv' : 'movie';

            console.debug(`${logPrefix} Checking item: ${item.Name} (type=${item.Type}, mediaType=${mediaType}, TMDB: ${tmdbId})`);

            // Remove report button for special seasons (season 0) and special episodes (season 0)
            try {
                if (item.Type === 'Season') {
                    const seasonNumber = parseInt(item.IndexNumber || item.SeasonNumber || item.Index || 0) || 0;
                    if (seasonNumber === 0) {
                        console.debug(`${logPrefix} Skipping ${item.Name}: special season (season 0)`);
                        return false;
                    }
                }

                if (item.Type === 'Episode') {
                    // Episode items often contain the season number in ParentIndexNumber or SeasonNumber
                    const parentSeason = parseInt(item.ParentIndexNumber || item.SeasonIndex || item.ParentIndex || item.SeasonNumber || 0) || 0;
                    if (parentSeason === 0) {
                        console.debug(`${logPrefix} Skipping ${item.Name}: special episode (season 0)`);
                        return false;
                    }
                }
            } catch (e) {
                // If any unexpected shape, don't block the flow; just continue
                console.debug(`${logPrefix} Could not determine season index for special detection:`, e);
            }

            // If no TMDB ID, and this is a Season/Episode, try to fetch parent/series TMDB ID first
            if (!tmdbId && (item.Type === 'Season' || item.Type === 'Episode')) {
                try {
                    // Common fields that may point to the series/parent item
                    const parentId = item.SeriesId || item.ParentId || item.ParentId || (item.Parent && item.Parent.Id) || (item.Series && item.Series.Id) || null;
                    if (parentId) {
                        console.debug(`${logPrefix} Found parentId ${parentId} for ${item.Name}, fetching parent item`);
                        const userId2 = ApiClient.getCurrentUserId();
                        if (userId2) {
                            const parentItem = await ApiClient.getItem(userId2, parentId);
                            if (parentItem) {
                                const parentTmdb = parentItem.ProviderIds?.Tmdb;
                                if (parentTmdb) {
                                    tmdbId = parentTmdb;
                                    console.log(`${logPrefix} Found TMDB ID on parent: ${tmdbId} (parent ${parentItem.Name})`);
                                }
                            }
                        }
                    }
                } catch (err) {
                    console.debug(`${logPrefix} Error fetching parent item for TMDB lookup:`, err);
                }
            }

            // If still no TMDB ID, try the general fallback lookup (may inspect names/urls)
            if (!tmdbId) {
                console.debug(`${logPrefix} No direct TMDB ID found for ${item.Name}, trying fallback...`);
                tmdbId = await issueReporter.getTmdbIdFallback(item.Name, mediaType, item);

                if (!tmdbId) {
                    console.debug(`${logPrefix} No TMDB ID could be resolved for ${item.Name} (fallback also failed)`);

                    // Try to add a disabled 'unavailable' button in-place to inform the user
                    let buttonContainerFallback = null;
                    const selectorsFallback = [
                        '.detailButtons',
                        '.itemActionsBottom',
                        '[class*="ActionButtons"]',
                        '.mainDetailButtons',
                        '.detailButtonsContainer',
                        '[class*="primaryActions"]',
                        '.topBarSecondaryMenus + *'
                    ];

                    for (const sel of selectorsFallback) {
                        const found = itemDetailPage.querySelector(sel);
                        if (found) {
                            buttonContainerFallback = found;
                            break;
                        }
                    }

                    if (!buttonContainerFallback) {
                        const allButtons = itemDetailPage.querySelectorAll('button');
                        if (allButtons.length > 0) {
                            buttonContainerFallback = allButtons[allButtons.length - 1].parentElement;
                        }
                    }

                    if (buttonContainerFallback) {
                        const unavailableButton = issueReporter.createUnavailableButton(buttonContainerFallback, item.Name, mediaType);
                        if (unavailableButton) {
                            buttonContainerFallback.appendChild(unavailableButton);
                            console.log(`${logPrefix} Added unavailable report button for ${item.Name}`);
                            return true;
                        }
                    }

                    return false;
                } else {
                    console.log(`${logPrefix} Found TMDB ID via fallback: ${tmdbId}`);
                }
            }

            if (mediaType !== 'tv' && mediaType !== 'movie') {
                console.debug(`${logPrefix} Skipping ${item.Name}: invalid type (${mediaType})`);
                return false;
            }

            // Find the appropriate container for the button - check multiple locations
            let buttonContainer = null;
            
            // Try specific button container selectors
            const selectors = [
                '.detailButtons',
                '.itemActionsBottom', 
                '[class*="ActionButtons"]',
                '.mainDetailButtons',
                '.detailButtonsContainer',
                '[class*="primaryActions"]',
                '.topBarSecondaryMenus + *'  // Element after topBarSecondaryMenus
            ];

            for (const selector of selectors) {
                const found = itemDetailPage.querySelector(selector);
                if (found) {
                    buttonContainer = found;
                    console.debug(`${logPrefix} Found button container with selector: ${selector}`);
                    break;
                }
            }

            // If still not found, look for any container with buttons
            if (!buttonContainer) {
                const allButtons = itemDetailPage.querySelectorAll('button');
                if (allButtons.length > 0) {
                    buttonContainer = allButtons[allButtons.length - 1].parentElement;
                    console.debug(`${logPrefix} Using parent of last button as container`);
                }
            }

            if (!buttonContainer) {
                console.debug(`${logPrefix} Could not find button container for ${item.Name}`);
                return false;
            }

            const button = issueReporter.createReportButton(
                buttonContainer,
                tmdbId,
                item.Name,
                mediaType,
                null,
                item
            );

            if (button) {
                buttonContainer.appendChild(button);
                console.log(`${logPrefix} ✓ Report issue button added to ${item.Name} (${mediaType}, TMDB: ${tmdbId})`);
                return true;
            }
        } catch (error) {
            console.warn(`${logPrefix} Error adding button:`, error);
        }

        return false;
    };

    /**
     * Initializes issue reporter on item detail pages
     */
    issueReporter.initialize = async function() {
        if (!JE.pluginConfig?.JellyseerrEnabled || !JE.pluginConfig?.JellyseerrShowReportButton) {
            console.debug(`${logPrefix} Jellyseerr or report-button feature disabled, skipping initialization`);
            return;
        }

        console.log(`${logPrefix} Initializing... (verifying Jellyseerr status)`);

        // Verify Jellyseerr is reachable and active via the server-side status endpoint
        try {
            const statusUrl = ApiClient.getUrl('/JellyfinEnhanced/jellyseerr/status');
            const statusRes = await ApiClient.ajax({ type: 'GET', url: statusUrl, dataType: 'json' });
            if (!statusRes || !statusRes.active) {
                console.debug(`${logPrefix} Jellyseerr status check returned inactive, skipping reporter init`);
                return;
            }
        } catch (e) {
            console.warn(`${logPrefix} Failed to verify Jellyseerr status, skipping reporter init:`, e);
            return;
        }

        let lastProcessedItemId = null;
        let processingTimeout = null;

        const processDetail = async () => {
            try {
                // Get item ID from URL (same way as reviews.js)
                const itemId = new URLSearchParams(window.location.hash.split('?')[1]).get('id');
                
                // Only process if item ID changed
                if (itemId && itemId !== lastProcessedItemId) {
                    lastProcessedItemId = itemId;
                    console.debug(`${logPrefix} Processing item ID: ${itemId}`);
                    await issueReporter.tryAddButton();
                }
            } catch (error) {
                console.warn(`${logPrefix} Error processing detail:`, error);
            }
        };

        // Try initial load with delay to ensure page is ready
        setTimeout(processDetail, 500);

        // Use a more aggressive listener for hash changes (direct navigation)
        const originalPushState = history.pushState;
        const originalReplaceState = history.replaceState;

        history.pushState = function(...args) {
            originalPushState.apply(this, args);
            setTimeout(processDetail, 300);
        };

        history.replaceState = function(...args) {
            originalReplaceState.apply(this, args);
            setTimeout(processDetail, 300);
        };

        // Listen for hash changes (browser back/forward)
        window.addEventListener('hashchange', () => {
            setTimeout(processDetail, 300);
        });

        // Listen for DOM mutations as fallback
        const observer = new MutationObserver((mutations) => {
            clearTimeout(processingTimeout);
            processingTimeout = setTimeout(processDetail, 300);
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'href']
        });

        console.log(`${logPrefix} ✓ Initialized issue reporter with observer`);
    };

    // Expose the module on the global JE object
    JE.jellyseerrIssueReporter = issueReporter;

})(window.JellyfinEnhanced);
