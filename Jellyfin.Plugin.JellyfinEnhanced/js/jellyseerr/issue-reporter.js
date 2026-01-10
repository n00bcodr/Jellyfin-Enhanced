// /js/jellyseerr/issue-reporter.js
(function (JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Issue Reporter:';
    const issueReporter = {};
    const escapeHtml = (str) => {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    };

    // Cache for user permission to report
    let cachedUserCanReport = null;

    /**
     * Issue type definitions matching Jellyseerr's 4 core issue types
     * Jellyseerr uses: VIDEO (1), AUDIO (2), SUBTITLES (3), OTHER (4)
     */
    const getIssueTypes = () => [
        { value: '1', label: JE.t('jellyseerr_report_issue_type_video'), icon: JE.icon(JE.IconName.VIDEO) },
        { value: '2', label: JE.t('jellyseerr_report_issue_type_audio'), icon: JE.icon(JE.IconName.AUDIO) },
        { value: '3', label: JE.t('jellyseerr_report_issue_type_subtitles'), icon: JE.icon(JE.IconName.SUBTITLES) },
        { value: '4', label: JE.t('jellyseerr_report_issue_type_other'), icon: JE.icon(JE.IconName.QUESTION) }
    ];

    /**
     * Checks if issue reporting is available (item has TMDB ID and Jellyseerr configured)
     * Caches the result to avoid repeated checks.
     * Returns: 'available', 'no-tmdb', or 'no-jellyseerr'
     * @returns {Promise<string>}
     */
    issueReporter.checkReportingAvailability = async function (item) {
        try {
            // Check if item has TMDB ID
            const hasTmdbId = item && (item.ProviderIds?.Tmdb || item.ProviderIds?.['Tmdb']);

            // Check Jellyseerr status
            const statusUrl = ApiClient.getUrl('/JellyfinEnhanced/jellyseerr/status');
            const statusRes = await ApiClient.ajax({
                type: 'GET',
                url: statusUrl,
                dataType: 'json'
            });

            const jellyseerrActive = statusRes && statusRes.active === true;

            // Determine availability
            if (!hasTmdbId && !jellyseerrActive) {
                return 'no-both';
            } else if (!hasTmdbId) {
                return 'no-tmdb';
            } else if (!jellyseerrActive) {
                return 'no-jellyseerr';
            }

            // Both available
            return 'available';
        } catch (error) {
            console.debug(`${logPrefix} Error checking reporting availability:`, error);
            // On error, assume available and let the actual request fail if needed
            cachedUserCanReport = 'available';
            return 'available';
        }
    };

    /**
     * Shows the issue report modal for the given media item
     * @param {string} tmdbId - TMDB ID of the media
     * @param {string} itemName - Name of the media item
     * @param {string} mediaType - 'movie' or 'tv'
     * @param {string} backdropUrl - Optional backdrop image URL (full URL from Jellyfin or TMDB)
     */
    issueReporter.showReportModal = function (tmdbId, itemName, mediaType, backdropUrl = null, item = null) {
        // Create the form HTML
        const ISSUE_TYPES = getIssueTypes();
        const formHtml = `
            <style>
                .jellyseerr-issues-container { margin-top: 12px; }
                .jellyseerr-issues-header { font-weight: 700; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; font-size: 12px; color: #888; }
                .jellyseerr-issue-section { margin-bottom: 14px; }
                .jellyseerr-issue-section-title { display: inline-block; padding: 4px 12px; border-radius: 999px; background: rgba(100, 100, 255, 0.2); color: #b0b0ff; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; margin: 0 0 10px; }
                .jellyseerr-issue-card { border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.03); border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; }
                .jellyseerr-issue-summary { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-weight: 600; color: #e6e6e6; }
                .jellyseerr-issue-reporter { color: #9aa; font-weight: 500; }
                .jellyseerr-issue-date { color: #9aa; font-size: 12px; }
                .jellyseerr-pill { display: inline-block; padding: 2px 8px; border-radius: 999px; background: rgba(0, 150, 255, 0.15); color: #8fd1ff; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.3px; }
                .pill-number-open { background: rgba(0, 150, 255, 0.15); color: #8fd1ff; }
                .pill-status-open { background: rgba(255, 200, 0, 0.18); color: #ffd666; }
                .pill-number-resolved, .pill-status-resolved { background: rgba(0, 180, 60, 0.18); color: #8dffb0; }
                .jellyseerr-issue-message { margin-top: 6px; color: #ddd; white-space: pre-wrap; }
                .jellyseerr-issue-comments { margin-top: 8px; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 6px; display: grid; gap: 6px; }
                .jellyseerr-issue-comment { padding: 6px 8px; border-radius: 6px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); }
                .jellyseerr-issue-comment-meta { font-size: 12px; color: #9aa; margin-bottom: 2px; }
                .jellyseerr-issue-comment-body { color: #eaeaea; font-size: 14px; white-space: pre-wrap; }
                .jellyseerr-issues-empty { color: #9aa; padding: 8px 0; }
            </style>
            <div class="jellyseerr-issue-form">
                <div class="jellyseerr-form-group">
                    <label>${JE.t('jellyseerr_report_issue_type')}</label>
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
                    <label for="issue-message">${JE.t('jellyseerr_report_issue_message')}</label>
                    <textarea
                        id="issue-message"
                        class="jellyseerr-issue-textarea"
                        placeholder="${JE.t('jellyseerr_report_issue_message_placeholder')}"
                        rows="4"
                    ></textarea>
                </div>
                <div id="jellyseerr-tv-controls-placeholder"></div>
                <div class="jellyseerr-issues-container" id="jellyseerr-issues-container">
                    <div class="jellyseerr-issues-header">${JE.t('jellyseerr_existing_issues')}</div>
                    <div class="jellyseerr-issues-body" id="jellyseerr-issues-body">
                        <div class="jellyseerr-issues-loading" id="jellyseerr-issues-loading">${JE.t('jellyseerr_loading_issues')}</div>
                    </div>
                </div>
            </div>
        `;

        // Create modal using the existing modal system
        const { modalElement, show, close } = JE.jellyseerrModal.create({
            title: JE.t('jellyseerr_report_issue_title'),
            subtitle: itemName,
            bodyHtml: formHtml,
            backdropUrl: backdropUrl,
            buttonText: JE.t('jellyseerr_report_issue_submit'),
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
                    button.textContent = JE.t('jellyseerr_report_issue_submitting');

                    // Pass only the contents of the description box to the API
                    const result = await JE.jellyseerrAPI.reportIssue(tmdbId, mediaType, issueType, message, problemSeason, problemEpisode);

                    if (result) {
                        JE.toast(JE.t('jellyseerr_report_issue_success'), 3000);
                        console.log(`${logPrefix} Issue successfully reported for ${itemName}`);
                        closeModal();
                    } else {
                        throw new Error('No response from API');
                    }
                } catch (error) {
                    console.error(`${logPrefix} Error reporting issue:`, error);
                    // Check if error is due to Jellyseerr being unavailable
                    const errorMsg = error?.message || error?.toString() || '';
                    if (errorMsg.toLowerCase().includes('jellyseerr') || errorMsg.toLowerCase().includes('unavailable') || error?.status === 503 || error?.status === 0) {
                        JE.toast('Jellyseerr is not available', 4000);
                    } else {
                        JE.toast(JE.t('jellyseerr_report_issue_error'), 4000);
                    }
                    button.disabled = false;
                    button.textContent = JE.t('jellyseerr_report_issue_submit');
                }
            }
        });

        show();

        // Load existing issues/comments for this item
        (async () => {
            const bodyEl = modalElement.querySelector('#jellyseerr-issues-body');
            const loadingEl = modalElement.querySelector('#jellyseerr-issues-loading');

            const renderEmpty = (msg = JE.t('jellyseerr_no_issues_yet')) => {
                if (bodyEl) bodyEl.innerHTML = `<div class="jellyseerr-issues-empty">${msg}</div>`;
            };

            const issueTypeLabels = {
                1: 'Video',
                2: 'Audio',
                3: 'Subtitles',
                4: 'Other'
            };

            const statusLabels = {
                1: 'Open',
                2: 'Resolved'
            };

            const fmtDate = (iso) => {
                if (!iso) return '';
                const d = new Date(iso);
                const day = String(d.getDate()).padStart(2, '0');
                const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                const mon = monthNames[d.getMonth()];
                const year = d.getFullYear();
                const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
                return `${day}-${mon}-${year} ${time}`;
            };

            try {
                if (loadingEl) loadingEl.textContent = JE.t('jellyseerr_loading_issues');
                const res = await JE.jellyseerrAPI.fetchIssuesForMedia(tmdbId, mediaType, { take: 50, filter: 'all' });
                let issues = res?.results || [];

                if (!issues.length) {
                    renderEmpty();
                    return;
                }

                const enriched = await Promise.all(issues.map(async (issue) => {
                    try {
                        const full = await JE.jellyseerrAPI.fetchIssueById(issue.id);
                        return full || issue;
                    } catch (_) { return issue; }
                }));

                issues = enriched;

                // Group by type to separate the four issue categories
                const grouped = issues.reduce((acc, issue) => {
                    const key = issue.issueType || issue.problemType || 'unknown';
                    acc[key] = acc[key] || [];
                    acc[key].push(issue);
                    return acc;
                }, {});

                const typeOrder = [1, 2, 3, 4, 'unknown'];

                const sections = typeOrder
                    .filter(key => grouped[key] && grouped[key].length)
                    .map(key => {
                        const label = issueTypeLabels[key] || 'Other';
                        const cards = grouped[key]
                            .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
                            .map(issue => {
                                const status = issue.status;
                                const typeLabel = issueTypeLabels[issue.issueType] || 'Other';
                                const createdBy = escapeHtml(
                                    issue.createdBy?.jellyfinUsername ||
                                    issue.createdBy?.displayName ||
                                    issue.createdBy?.username ||
                                    issue.createdBy?.email ||
                                    'Someone'
                                );
                                const createdAt = fmtDate(issue.createdAt);
                                const comments = Array.isArray(issue.comments) ? issue.comments : [];

                                // Use first comment as description when no issue.message
                                const [firstComment, ...restComments] = comments;

                                const commentHtml = restComments.map(c => {
                                    const who = escapeHtml(
                                        c.user?.jellyfinUsername ||
                                        c.user?.displayName ||
                                        c.user?.username ||
                                        c.user?.email ||
                                        ''
                                    );
                                    const when = fmtDate(c.createdAt);
                                    const msg = escapeHtml(c.message || '');
                                    const meta = `${when}${who ? ' • ' + who : ''}`;
                                    return `<div class="jellyseerr-issue-comment"><div class="jellyseerr-issue-comment-meta">${meta}</div><div class="jellyseerr-issue-comment-body">${msg}</div></div>`;
                                }).join('');

                                const mainMessage = escapeHtml(issue.message || (firstComment?.message || '(No description)'));
                                const statusText = statusLabels[status] || '';
                                const isResolved = String(status) === '2' || String(status).toLowerCase() === 'resolved';
                                const numberClass = isResolved ? 'pill-number-resolved' : 'pill-number-open';
                                const statusClass = isResolved ? 'pill-status-resolved' : 'pill-status-open';
                                const summary = `<span class="jellyseerr-pill ${numberClass}">#${escapeHtml(String(issue.id))}</span><span class="jellyseerr-pill ${statusClass}">${escapeHtml(statusText || (isResolved ? 'Resolved' : 'Open'))}</span>${createdAt ? ` <span class="jellyseerr-issue-date">${createdAt}</span>` : ''}`;
                                return `
                                    <div class="jellyseerr-issue-card">
                                        <div class="jellyseerr-issue-summary">${summary}<span class="jellyseerr-issue-reporter"> — ${createdBy}</span></div>
                                        <div class="jellyseerr-issue-message">${mainMessage}</div>
                                        ${commentHtml ? `<div class="jellyseerr-issue-comments">${commentHtml}</div>` : ''}
                                    </div>
                                `;
                            }).join('');

                        return `
                            <div class="jellyseerr-issue-section">
                                <div class="jellyseerr-issue-section-title">${label}</div>
                                ${cards}
                            </div>
                        `;
                    }).join('');

                if (bodyEl) bodyEl.innerHTML = sections;

            } catch (err) {
                console.error(`${logPrefix} Failed to load existing issues:`, err);
                renderEmpty(JE.t('jellyseerr_load_issues_error'));
            }
        })();

        // If this is a TV item, augment the modal with season/episode selectors
        if (mediaType === 'tv') {
            (async () => {
                try {
                    const placeholder = modalElement.querySelector('#jellyseerr-tv-controls-placeholder');
                    if (!placeholder) return;

                    // Build the container for season/episode controls
                    const controlsHtml = `
                        <div class="jellyseerr-form-group">
                            <label for="issue-season">${JE.t('jellyseerr_report_issue_season')}</label>
                            <select id="issue-season" class="jellyseerr-select"></select>
                        </div>
                        <div class="jellyseerr-form-group">
                            <label for="issue-episode">${JE.t('jellyseerr_report_issue_episode')}</label>
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
     * @param {string} backdropUrl - Optional backdrop image URL
     */
    issueReporter.createReportButton = function (container, tmdbId, itemName, mediaType, backdropUrl = null, item = null) {
        if (!container) {
            console.warn(`${logPrefix} Container not found for report button`);
            return null;
        }

        const button = document.createElement('button');
        button.setAttribute('is', 'emby-button');
        button.className = 'button-flat detailButton emby-button jellyseerr-report-issue-icon';
        button.type = 'button';
        button.setAttribute('aria-label', JE.t('jellyseerr_report_issue_button'));
        button.title = JE.t('jellyseerr_report_issue_button');
        button.innerHTML = `
            <div class="detailButton-content">
                <span class="material-icons detailButton-icon warning" aria-hidden="true"></span>
            </div>
        `;

        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            issueReporter.showReportModal(tmdbId, itemName, mediaType, backdropUrl, item);
        });

        return button;
    };

    /**
     * Create a disabled "unavailable" button to show when reporting isn't possible
     * @param {HTMLElement} container
     * @param {string} itemName
     * @param {string} mediaType
     */
    issueReporter.createUnavailableButton = function (container, itemName, mediaType, reason = 'unavailable') {
        if (!container) return null;

        const button = document.createElement('button');
        button.setAttribute('is', 'emby-button');
        button.className = 'button-flat detailButton emby-button jellyseerr-report-unavailable-icon';
        button.type = 'button';

        let ariaLabel = JE.t('jellyseerr_report_unavailable_button');
        let title = JE.t('jellyseerr_report_unavailable_button');

        if (reason === 'no-tmdb') {
            ariaLabel = 'TMDB ID not found';
            title = 'TMDB ID not found for this item';
        } else if (reason === 'no-jellyseerr') {
            ariaLabel = 'Jellyseerr unavailable';
            title = 'Jellyseerr is not available';
        } else if (reason === 'no-both') {
            ariaLabel = 'Reporting services unavailable';
            title = 'TMDB ID not found and Jellyseerr is not available';
        } else if (reason === 'no-permissions') {
            ariaLabel = 'Not enough permissions';
            title = 'Not enough permissions to report';
        }

        button.setAttribute('aria-label', ariaLabel);
        button.title = title;
        button.disabled = true;
        button.innerHTML = `
            <div class="detailButton-content">
                <span class="material-icons detailButton-icon" aria-hidden="true">warning_off</span>
            </div>
        `;

        // Still allow click to show a helpful toast explaining why
        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (reason === 'no-tmdb') {
                JE.toast('TMDB ID not found for this item', 4000);
            } else if (reason === 'no-jellyseerr') {
                JE.toast('Jellyseerr is not available', 4000);
            } else if (reason === 'no-both') {
                JE.toast('TMDB ID not found and Jellyseerr is not available', 4000);
            } else if (reason === 'no-permissions') {
                JE.toast('You do not have permissions to report issues', 4000);
            } else {
                JE.toast(JE.t('jellyseerr_report_unavailable_toast'), 4000);
            }
        });

        return button;
    };

    /**
     * Attempts to fetch TMDB ID from external sources as a fallback
     * Uses OMDB API or other methods to find TMDB ID
     */
    issueReporter.getTmdbIdFallback = async function (itemName, mediaType, item) {
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
                    const year = item.ProductionYear || (item.PremiereDate ? item.PremiereDate.substring(0, 4) : null) || '';
                    const titleQuery = `${item.Name}${year ? ' ' + year : ''}`;
                    console.debug(`${logPrefix} Trying Jellyseerr search by title: "${titleQuery}"`);
                    const res2 = await JE.jellyseerrAPI.search(titleQuery);
                    if (res2 && Array.isArray(res2.results) && res2.results.length > 0) {
                        // Try to find best match: exact title and same year
                        const exact = res2.results.find(r => {
                            const rTitle = (r.title || r.name || '').toString().toLowerCase();
                            const itemTitle = (item.Name || '').toString().toLowerCase();
                            const rYear = (r.releaseDate || r.firstAirDate || '').toString().substring(0, 4) || '';
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
    issueReporter.tryAddButton = async function () {
        const itemDetailPage = document.querySelector('#itemDetailPage:not(.hide)');
        if (!itemDetailPage) {
            return false;
        }
        // Don't add if plugin or report-button feature is disabled
        if (!JE.pluginConfig?.JellyseerrEnabled || !JE.pluginConfig?.JellyseerrShowReportButton) {
            console.debug(`${logPrefix} Jellyseerr or report button disabled, skipping`);
            return false;
        }

        // Check if we already added the button (either active or unavailable)
        if (itemDetailPage.querySelector('.jellyseerr-report-issue-icon, .jellyseerr-report-unavailable-icon')) {
            console.debug(`${logPrefix} Report button already exists`);
            return true;
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

            // Check if reporting is available (item has TMDB ID and Jellyseerr configured)
            const availability = await issueReporter.checkReportingAvailability(item);

            // If services not available, show unavailable button
            if (availability !== 'available') {
                console.debug(`${logPrefix} Reporting not available: ${availability}`);

                // Try to add an unavailable button
                let buttonContainerUnavail = null;
                const selectorsUnavail = [
                    '.detailButtons',
                    '.itemActionsBottom',
                    '[class*="ActionButtons"]',
                    '.mainDetailButtons',
                    '.detailButtonsContainer',
                    '[class*="primaryActions"]',
                    '.topBarSecondaryMenus + *'
                ];

                for (const sel of selectorsUnavail) {
                    const found = itemDetailPage.querySelector(sel);
                    if (found) {
                        buttonContainerUnavail = found;
                        break;
                    }
                }

                if (!buttonContainerUnavail) {
                    const allButtons = itemDetailPage.querySelectorAll('button');
                    if (allButtons.length > 0) {
                        buttonContainerUnavail = allButtons[allButtons.length - 1].parentElement;
                    }
                }

                if (buttonContainerUnavail) {
                    const unavailButton = issueReporter.createUnavailableButton(buttonContainerUnavail, '', '', availability);
                    if (unavailButton) {
                        const moreButton = buttonContainerUnavail.querySelector('.btnMoreCommands');
                        if (moreButton) {
                            buttonContainerUnavail.insertBefore(unavailButton, moreButton);
                        } else {
                            buttonContainerUnavail.appendChild(unavailButton);
                        }
                        console.log(`${logPrefix} Added unavailable report button (${availability})`);
                        return true;
                    }
                }
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
                        const unavailableButton = issueReporter.createUnavailableButton(buttonContainerFallback, item.Name, mediaType, 'no-tmdb');
                        if (unavailableButton) {
                            const moreButton = buttonContainerFallback.querySelector('.btnMoreCommands');
                            if (moreButton) {
                                buttonContainerFallback.insertBefore(unavailableButton, moreButton);
                            } else {
                                buttonContainerFallback.appendChild(unavailableButton);
                            }
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

            // Extract backdrop URL from Jellyfin item
            let backdropUrl = null;
            if (item.BackdropImageTags && item.BackdropImageTags.length > 0) {
                const tag = item.BackdropImageTags[0];
                backdropUrl = ApiClient.getUrl(`Items/${item.Id}/Images/Backdrop`, { tag: tag, quality: 40 });
            } else if (item.ParentBackdropImageTags && item.ParentBackdropImageTags.length > 0) {
                const tag = item.ParentBackdropImageTags[0];
                const parentId = item.ParentBackdropItemId || item.ParentId || item.SeriesId;
                if (parentId) {
                    backdropUrl = ApiClient.getUrl(`Items/${parentId}/Images/Backdrop`, { tag: tag, quality: 40 });
                }
            }
            const button = issueReporter.createReportButton(
                buttonContainer,
                tmdbId,
                item.Name,
                mediaType,
                backdropUrl,
                item
            );

            if (button) {
                // Try to insert before btnMoreCommands, otherwise append
                const moreButton = buttonContainer.querySelector('.btnMoreCommands');
                if (moreButton) {
                    buttonContainer.insertBefore(button, moreButton);
                } else {
                    buttonContainer.appendChild(button);
                }
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
    issueReporter.initialize = async function () {
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

        const handleViewShow = async () => {
            try {
                // Small delay to ensure DOM is ready
                setTimeout(async () => {
                    await issueReporter.tryAddButton();
                }, 100);
            } catch (error) {
                console.warn(`${logPrefix} Error in viewShow handler:`, error);
            }
        };

        // Listen for Jellyfin's page navigation events
        document.addEventListener('viewshow', handleViewShow);

        // Also try on initial load
        setTimeout(handleViewShow, 500);

        console.log(`${logPrefix} ✓ Initialized issue reporter with viewshow listener`);
    };

    // Expose the module on the global JE object
    JE.jellyseerrIssueReporter = issueReporter;

})(window.JellyfinEnhanced);
