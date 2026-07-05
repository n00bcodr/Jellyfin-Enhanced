/**
 * @file Implements core, non-playback features for Jellyfin Enhanced.
 */
(function(JE) {
    'use strict';

    // In-memory cache to avoid repeated fetches when data is unavailable or unchanged
    const WATCHPROGRESS_CACHE_TTL = 60 * 60 * 1000; // 1 hour
    const FILESIZE_CACHE_TTL = 60 * 60 * 1000; // 1 hour
    const LANGUAGE_CACHE_TTL = 60 * 60 * 1000; // 1 hour
    const RELEASEDATE_CACHE_TTL = 60 * 60 * 1000; // 1 hour
    const watchProgressCache = new Map(); // Map<itemId, { progress: number, totalPlaybackTicks: number, totalRuntimeTicks: number, ts: number }>
    const fileSizeCache = new Map(); // Map<itemId, { size: number|null, unavailable: boolean, ts: number }>
    const audioLanguageCache = new Map(); // Map<itemId, { languages: Array, unavailable: boolean, ts: number }>
    const releaseDateCache = new Map(); // Map<itemId, { infos: Array<{date, icon, titleKey}>, ts: number }>

    /**
     * Converts bytes into a human-readable format (e.g., KB, MB, GB).
     * @param {number} bytes The size in bytes.
     * @returns {string} The human-readable file size.
     */
    function formatSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        const formattedSize = parseFloat((bytes / Math.pow(k, i)).toFixed(2));
        return `${formattedSize} ${sizes[i]}`;
    }

    /**
     * Shows notifications using Jellyfin's built-in notification system.
     * @param {string} message The message to display.
     * @param {string} [type='info'] The type of notification ('info', 'error', 'success').
     */
    const showNotification = (message, type = 'info') => {
        try {
            if (window.Dashboard?.alert) {
                window.Dashboard.alert(message);
            } else if (window.Emby?.Notifications) {
                window.Emby.Notifications.show({ title: message, type: type, timeout: 3000 });
            } else {
                console.log(`🪼 Jellyfin Enhanced: Notification (${type}): ${message}`);
            }
        } catch (e) {
            console.error("🪼 Jellyfin Enhanced: Failed to show notification", e);
        }
    };

    /**
     * Fetches a random item (Movie or Series) from the user's library.
     * @returns {Promise<object|null>} A promise that resolves to a random item or null.
     */
    async function getRandomItem() {
        const userId = ApiClient.getCurrentUserId();
        if (!userId) {
            console.error("🪼 Jellyfin Enhanced: User not logged in.");
            return null;
        }

        const itemTypes = [];
        if (JE.currentSettings.randomIncludeMovies) itemTypes.push('Movie');
        if (JE.currentSettings.randomIncludeShows) itemTypes.push('Series');
        const includeItemTypes = itemTypes.join(',');

        let apiUrl = ApiClient.getUrl(`/Users/${userId}/Items?IncludeItemTypes=${includeItemTypes}&Recursive=true&SortBy=Random&Limit=100&Fields=ExternalUrls`);

        try {
            const response = await ApiClient.ajax({ type: 'GET', url: apiUrl, dataType: 'json' });
            if (response && response.Items && response.Items.length > 0) {
                let items = response.Items;

                if (JE.currentSettings.randomUnwatchedOnly) {
                    items = items.filter(item => {
                        // For movies: check if not played
                        if (item.Type === 'Movie') {
                            return !item.UserData?.Played;
                        }
                        // For series: check if there are unplayed episodes
                        if (item.Type === 'Series') {
                            return item.UserData?.UnplayedItemCount > 0;
                        }
                        return false;
                    });
                    // If no unwatched items found, show error
                    if (items.length === 0) {
                        throw new Error('No unwatched items found in selected libraries.');
                    }
                }

                const randomIndex = Math.floor(Math.random() * items.length);
                return items[randomIndex];
            }
            throw new Error('No items found in selected libraries.');
        } catch (error) {
            console.error('🪼 Jellyfin Enhanced: Error fetching random item:', error);
            JE.toast(`${JE.icon(JE.IconName.ERROR)} ${error.message || 'Unknown error'}`, 2000);
            return null;
        }
    }

    /**
     * Navigates the browser to the details page of the given item.
     * @param {object} item The item to navigate to.
     */
    function navigateToItem(item) {
        if (item && item.Id) {
            if (window.Emby && window.Emby.Page && typeof window.Emby.Page.show === 'function') {
                const serverId = ApiClient.serverId();
                window.Emby.Page.show(`/details?id=${item.Id}${serverId ? `&serverId=${serverId}` : ''}`);
            } else if (window.Dashboard && typeof window.Dashboard.navigate === 'function') {
                window.Dashboard.navigate(`details.html?id=${item.Id}`);
            } else {
                // Fallback to hash navigation for older versions
                const serverId = ApiClient.serverId();
                const itemUrl = `#!/details?id=${item.Id}${serverId ? `&serverId=${serverId}` : ''}`;
                window.location.hash = itemUrl;
            }
            JE.toast(JE.t('toast_random_item_loaded'), 2000);
        } else {
            console.error('🪼 Jellyfin Enhanced: Invalid item object or ID:', item);
            JE.toast(JE.t('toast_generic_error'), 2000);
        }
    }

    /**
     * Creates and injects the "Random" button into the page header if enabled.
     */
    JE.addRandomButton = () => {
        if (!JE.currentSettings.randomButtonEnabled) {
            document.getElementById('randomItemButtonContainer')?.remove();
            return;
        }

        if (document.getElementById('randomItemButton')) return;

        const buttonContainer = document.createElement('div');
        buttonContainer.id = 'randomItemButtonContainer';

        const randomButton = document.createElement('button');
        randomButton.id = 'randomItemButton';
        randomButton.setAttribute('is', 'paper-icon-button-light');
        randomButton.className = 'headerButton headerButtonRight paper-icon-button-light';
        randomButton.title = JE.t('random_button_tooltip');
        randomButton.innerHTML = `<i class="material-icons">casino</i>`;

        randomButton.addEventListener('click', async () => {
            randomButton.disabled = true;
            randomButton.classList.add('loading');
            randomButton.innerHTML = '<i class="material-icons">hourglass_empty</i>';

            try {
                const item = await getRandomItem();
                if (item) {
                    navigateToItem(item);
                }
            } finally {
                setTimeout(() => {
                    if (document.getElementById(randomButton.id)) {
                        randomButton.disabled = false;
                        randomButton.classList.remove('loading');
                        randomButton.innerHTML = `<i class="material-icons">casino</i>`;
                    }
                }, 500);
            }
        });

        buttonContainer.appendChild(randomButton);
        const headerRight = JE.helpers.getHeaderRightContainer();
        headerRight?.prepend(buttonContainer);
    };



    /**
     * Shows the total watch progress (in %) of an item (and its children) on its details page.
     * @param {string} itemId The ID of the item.
     * @param {HTMLElement} container The DOM element to append the info to.
     */
    async function displayWatchProgress(itemId, container) {
        // show itemMiscInfo if hidden like on season pages
        if (container.classList.contains('hide')) {
            container.classList.remove('hide')
        }

        const existing = container.querySelector('.mediaInfoItem-watchProgress');
        if (existing) {
            // If already rendered for this itemId, do nothing
            if (existing.dataset.itemId === itemId) return;
            // Different item now; replace the element
            existing.remove();
        }

        // Check cache first to avoid repeated network calls
        const now = Date.now();
        const cached = watchProgressCache.get(itemId);

        const placeholder = document.createElement('div');
        placeholder.className = 'mediaInfoItem mediaInfoItem-watchProgress';
        placeholder.dataset.itemId = itemId;
        placeholder.title = JE.t('watch_progress_tooltip');
        placeholder.style.display = 'flex';
        placeholder.style.verticalAlign = 'middle';
        placeholder.style.alignItems = 'center';
        placeholder.style.margin = '0 1em 0 0 !important';
        placeholder.style.cursor = 'pointer';
        const getWatchProgressDisplay = (watchProgress, mode) => {
            const safeTotal = Math.max(0, watchProgress.totalRuntimeTicks || 0);
            const safePlayed = Math.max(0, Math.min(safeTotal, watchProgress.totalPlaybackTicks || 0));

            if (mode === 'time') {
                return `${getTimeString(safePlayed)} / ${getTimeString(safeTotal)}`;
            }

            if (mode === 'remaining') {
                const remaining = Math.max(0, safeTotal - safePlayed);
                return `-${getTimeString(remaining)} / ${getTimeString(safeTotal)}`;
            }

            return `${watchProgress.progress}%`;
        };

        const persistWatchProgressMode = (mode) => {
            if (!window.JellyfinEnhanced) return;
            window.JellyfinEnhanced.currentSettings = window.JellyfinEnhanced.currentSettings || {};
            window.JellyfinEnhanced.currentSettings.watchProgressMode = mode;
            if (typeof window.JellyfinEnhanced.saveUserSettings === 'function') {
                window.JellyfinEnhanced.saveUserSettings('settings.json', window.JellyfinEnhanced.currentSettings);
            }
        };

        const nextWatchProgressMode = (currentMode) => {
            if (currentMode === 'percentage') return 'time';
            if (currentMode === 'time') return 'remaining';
            return 'percentage';
        };

        // onClick handler to toggle between percentage and time-based display
        placeholder.addEventListener('click', () => {
            const watchProgress = watchProgressCache.get(itemId);
            if (!watchProgress) return;

            const div = document.querySelector(`.mediaInfoItem-watchProgress[data-item-id="${itemId}"]`)
                .querySelector('.mediaInfoItem-watchProgress-value');
            if (!div) return;

            const currentMode = div.dataset.type || 'percentage';
            const newMode = nextWatchProgressMode(currentMode);
            div.dataset.type = newMode;
            div.innerHTML = getWatchProgressDisplay(watchProgress, newMode);
            persistWatchProgressMode(newMode);
        });
        // Show loading indicator
        placeholder.innerHTML = `<span class="material-icons" style="font-size: inherit; margin-right: 0.3em;">hourglass_empty</span> ...`;
        // Insert first so subsequent observer runs are triggered
        container.appendChild(placeholder);

        const getIconSpan = (progress) => {
            const circumference = 2 * Math.PI * 8; // radius = 8
            const offset = circumference - (progress / 100) * circumference;

            if (progress >= 100) {
                // Check circle for fully completed items
                return `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" style="margin-right: 0.3em; display: inline-block; vertical-align: middle;">
                    <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/>
                    <path d="M9.5 15.5l-3-3 1.4-1.4L9.5 12.7l5.6-5.6 1.4 1.4z" fill="currentColor"/>
                </svg>`;
            }

            // For all other progress values (0-99%), use custom SVG
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" style="margin-right: 0.3em; display: inline-block; vertical-align: middle;">
                <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2" opacity="0.2"/>
                <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"
                    style="stroke-dasharray: ${circumference}; stroke-dashoffset: ${offset}; transform: rotate(-90deg); transform-origin: 50% 50%; transition: stroke-dashoffset 0.3s ease;"/>
            </svg>`;
            return `${svg}`;
        }

        // Helper to get time string from ticks
        const getTimeString = (ticks) => {
            const seconds = ticks / 10_000_000;
            const totalMinutes = Math.floor(seconds / 60);
            const totalHours = Math.floor(totalMinutes / 60);
            const totalDays = Math.floor(totalHours / 24);
            const totalMonths = Math.floor(totalDays / 30);
            const totalYears = Math.floor(totalDays / 365);

            let result = '';
            const format = (window.JellyfinEnhanced?.currentSettings?.watchProgressTimeFormat || 'hours');
            if (format === 'hours') {
                // Show hours and minutes (or just minutes if under an hour)
                if (totalHours >= 1) {
                    result += `${totalHours}h`;
                    const minutes = totalMinutes % 60;
                    if (minutes > 0) result += ` ${minutes}m`;
                } else if (totalMinutes > 0) {
                    result = `${totalMinutes}m`;
                } else {
                    result = '0m';
                }
            } else {
                if (totalYears >= 1) {
                    result += `${totalYears}y`;
                    const months = Math.floor((totalDays % 365) / 30);
                    if (months > 0) result += ` ${months}mo`;
                } else if (totalMonths >= 1) {
                    result += `${totalMonths}mo`;
                    const days = totalDays % 30;
                    if (days > 0) result += ` ${days}d`;
                } else if (totalDays >= 1) {
                    result += `${totalDays}d`;
                    const hours = totalHours % 24;
                    if (hours > 0) result += ` ${hours}h`;
                } else if (totalHours >= 1) {
                    result += `${totalHours}h`;
                    const minutes = totalMinutes % 60;
                    if (minutes > 0) result += ` ${minutes}m`;
                } else if (totalMinutes > 0) {
                    result = `${totalMinutes}m`;
                } else {
                    result = '0m';
                }
            }

            return result;
        }

        const getWatchProgressValue = (watchProgress) => {
            const valueDiv = document.createElement('div');
            valueDiv.className = 'mediaInfoItem-watchProgress-value';
            const defaultMode = (window.JellyfinEnhanced?.currentSettings?.watchProgressMode || 'percentage');
            const resolvedMode = (defaultMode === 'time' || defaultMode === 'remaining') ? defaultMode : 'percentage';
            valueDiv.dataset.type = resolvedMode;
            valueDiv.innerHTML = getWatchProgressDisplay(watchProgress, resolvedMode);

            return valueDiv;
        }

        // Helper to render the 0 state
        const renderUnavailable = () => {
            placeholder.innerHTML = getIconSpan(0);
            placeholder.appendChild(getWatchProgressValue({ progress: 0, totalPlaybackTicks: 0, totalRuntimeTicks: 0 }));
        };

        // Use requestIdleCallback to defer the work and not block page rendering
        const performFetch = async () => {
            if (cached && (now - cached.ts) < WATCHPROGRESS_CACHE_TTL) {
                if (!cached.progress) {
                    renderUnavailable();
                    return;
                }
                placeholder.innerHTML = getIconSpan(cached.progress);
                placeholder.appendChild(getWatchProgressValue(cached));
                return;
            }

            try {
                const itemResult = await ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl(`/JellyfinEnhanced/watch-progress/${ApiClient.getCurrentUserId()}/${itemId}`),
                    dataType: 'json'
                });

                const watchProgress = {
                    progress: itemResult?.progress ?? 0,
                    totalPlaybackTicks: itemResult?.totalPlaybackTicks ?? 0,
                    totalRuntimeTicks: itemResult?.totalRuntimeTicks ?? 0,
                    ts: now
                };
                placeholder.innerHTML = getIconSpan(watchProgress.progress);
                placeholder.appendChild(getWatchProgressValue(watchProgress));

                watchProgressCache.set(itemId, watchProgress);
            } catch (error) {
                console.error('🪼 Jellyfin Enhanced: Error fetching watch progress for ID %s:', itemId, error);
                // Keep placeholder with 0 to prevent repeated calls
                renderUnavailable();
                watchProgressCache.set(itemId, { progress: 0, totalPlaybackTicks: 0, totalRuntimeTicks: 0, ts: now });
            }
        };

        // Defer to allow page to render first
        if (typeof requestIdleCallback !== 'undefined') {
            requestIdleCallback(() => performFetch(), { timeout: 2000 });
        } else {
            setTimeout(() => performFetch(), 0);
        }
    }

    /**
     * Shows the total file size of an item on its details page.
     * @param {string} itemId The ID of the item.
     * @param {HTMLElement} container The DOM element to append the info to.
     */
    async function displayItemSize(itemId, container) {
        const existing = container.querySelector('.mediaInfoItem-fileSize');
        if (existing) {
            // If already rendered for this itemId, do nothing
            if (existing.dataset.itemId === itemId) return;
            // Different item now; replace the element
            existing.remove();
        }

        // Check cache first to avoid repeated network calls
        const now = Date.now();
        const cached = fileSizeCache.get(itemId);

        const placeholder = document.createElement('div');
        placeholder.className = 'mediaInfoItem mediaInfoItem-fileSize';
        placeholder.dataset.itemId = itemId;
        placeholder.title = JE.t('file_size_tooltip');
        placeholder.style.display = 'flex';
        placeholder.style.alignItems = 'center';
        placeholder.style.margin = '0 1em 0 0 !important';
        // Show loading indicator
        placeholder.innerHTML = `<span class="material-icons" style="font-size: inherit; margin-right: 0.3em;">hourglass_empty</span> ...`;
        // Insert first so subsequent observer runs are triggered
        container.appendChild(placeholder);

        // Helper to render a dash (no data) but keep the element
        const renderUnavailable = () => {
            placeholder.innerHTML = `<span class="material-icons" style="font-size: inherit; margin-right: 0.3em;">save</span> -`;
        };

        // Use requestIdleCallback to defer the work and not block page rendering
        const performFetch = async () => {
            if (cached && (now - cached.ts) < FILESIZE_CACHE_TTL) {
                if (cached.unavailable || !cached.size) {
                    renderUnavailable();
                    return;
                }
                placeholder.style.verticalAlign = 'middle';
                placeholder.innerHTML = `<span class="material-icons" style="font-size: inherit; margin-right: 0.3em;">save</span>${formatSize(cached.size)}`;
                return;
            }

            try {
                const itemResult = await ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl(`/JellyfinEnhanced/file-size/${ApiClient.getCurrentUserId()}/${itemId}`),
                    dataType: 'json'
                });
                const totalSize = itemResult?.size ?? 0;

                if (totalSize > 0) {
                    placeholder.style.verticalAlign = 'middle';
                    placeholder.innerHTML = `<span class="material-icons" style="font-size: inherit; margin-right: 0.3em;">save</span>${formatSize(totalSize)}`;
                    fileSizeCache.set(itemId, { size: totalSize, unavailable: false, ts: now });
                } else {
                    renderUnavailable();
                    fileSizeCache.set(itemId, { size: null, unavailable: true, ts: now });
                }
            } catch (error) {
                console.error('🪼 Jellyfin Enhanced: Error fetching item size for ID %s:', itemId, error);
                // Keep placeholder with dash to prevent repeated calls
                renderUnavailable();
                fileSizeCache.set(itemId, { size: null, unavailable: true, ts: now });
            }
        };

        // Defer to allow page to render first
        if (typeof requestIdleCallback !== 'undefined') {
            requestIdleCallback(() => performFetch(), { timeout: 2000 });
        } else {
            setTimeout(() => performFetch(), 0);
        }
    }

    /**
     * A map of language names/codes to country codes for flag display.
     */
    const languageToCountryMap={English:"gb",eng:"gb",Japanese:"jp",jpn:"jp",Spanish:"es",spa:"es",French:"fr",fre:"fr",fra:"fr",German:"de",ger:"de",deu:"de",Italian:"it",ita:"it",Korean:"kr",kor:"kr",
                                Chinese:"cn",chi:"cn",zho:"cn",Russian:"ru",rus:"ru",Portuguese:"pt",por:"pt",Hindi:"in",hin:"in",Dutch:"nl",dut:"nl",nld:"nl",Arabic:"sa",ara:"sa",Bengali:"in",ben:"in",
                                Czech:"cz",ces:"cz",Danish:"dk",dan:"dk",Greek:"gr",ell:"gr",Finnish:"fi",fin:"fi",Hebrew:"il",heb:"il",Hungarian:"hu",hun:"hu",Indonesian:"id",ind:"id",Norwegian:"no",nor:"no",
                                Polish:"pl",pol:"pl",Persian:"ir",per:"ir",fas:"ir",Romanian:"ro",ron:"ro",rum:"ro",Swedish:"se",swe:"se",Thai:"th",tha:"th",Turkish:"tr",tur:"tr",Ukrainian:"ua",ukr:"ua",
                                Vietnamese:"vn",vie:"vn",Malay:"my",msa:"my",may:"my",Swahili:"ke",swa:"ke",Tagalog:"ph",tgl:"ph",Filipino:"ph",Tamil:"in",tam:"in",Telugu:"in",tel:"in",Marathi:"in",mar:"in",
                                Punjabi:"in",pan:"in",Urdu:"pk",urd:"pk",Gujarati:"in",guj:"in",Kannada:"in",kan:"in",Malayalam:"in",mal:"in",Sinhala:"lk",sin:"lk",Nepali:"np",nep:"np",Pashto:"af",pus:"af",
                                Kurdish:"iq",kur:"iq",Slovak:"sk",slk:"sk",Slovenian:"si",slv:"si",Serbian:"rs",srp:"rs",Croatian:"hr",hrv:"hr",Bulgarian:"bg",bul:"bg",Macedonian:"mk",mkd:"mk",Albanian:"al",
                                sqi:"al",Estonian:"ee",est:"ee",Latvian:"lv",lav:"lv",Lithuanian:"lt",lit:"lt",Icelandic:"is",isl:"is",Georgian:"ge",kat:"ge",Armenian:"am",hye:"am",Mongolian:"mn",mon:"mn",
                                Kazakh:"kz",kaz:"kz",Uzbek:"uz",uzb:"uz",Azerbaijani:"az",aze:"az",Belarusian:"by",bel:"by",Amharic:"et",amh:"et",Zulu:"za",zul:"za",Afrikaans:"za",afr:"za",Hausa:"ng",hau:"ng",
                                Yoruba:"ng",yor:"ng",Igbo:"ng",ibo:"ng",Brazilian:"br",bra:"br",Catalan:"es-ct",cat:"es-ct",ca:"es-ct",Galician:"es-ga",glg:"es-ga",gl:"es-ga",Basque:"es-pv",eus:"es-pv",baq:"es-pv",eu:"es-pv"};

    /**
     * Fetches the first episode of a series or season for language detection.
     * @param {string} userId The user ID.
     * @param {string} parentId The series or season ID.
     * @returns {Promise<object|null>} The first episode item or null.
     */
    async function fetchFirstEpisodeForLanguage(userId, parentId) {
        try {
            const response = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/Items', {
                    ParentId: parentId,
                    IncludeItemTypes: 'Episode',
                    Recursive: true,
                    SortBy: 'PremiereDate',
                    SortOrder: 'Ascending',
                    Limit: 1,
                    Fields: 'MediaStreams,MediaSources',
                    userId: userId
                }),
                dataType: 'json'
            });
            return response.Items?.[0] || null;
        } catch {
            return null;
        }
    }

    /**
     * Displays the audio languages of an item (and its children) on its details page.
     * @param {string} itemId The ID of the item.
     * @param {HTMLElement} container The DOM element to append the info to.
     */
    async function displayAudioLanguages(itemId, container) {
        // show itemMiscInfo if hidden like on season pages
        if (container.classList.contains('hide')) {
            container.classList.remove('hide')
        }

        const existing = container.querySelector('.mediaInfoItem-audioLanguage');
        if (existing) {
            // If already rendered for this itemId, do nothing
            if (existing.dataset.itemId === itemId) return;
            // Different item now, replace the element
            existing.remove();
        }

        const placeholder = document.createElement('div');
        placeholder.className = 'mediaInfoItem mediaInfoItem-audioLanguage';
        placeholder.dataset.itemId = itemId;
        placeholder.title = JE.t('audio_language_tooltip');
        placeholder.style.display = 'flex';
        placeholder.style.verticalAlign = 'middle';
        placeholder.style.alignItems = 'center';
        placeholder.style.margin = '0 1em 0 0 !important';
        // Show loading indicator
        placeholder.innerHTML = `<span class="material-icons" style="font-size: inherit; margin-right: 0.3em;">hourglass_empty</span> ...`;
        container.appendChild(placeholder);

        const applyLangStyles = (el) => {
            el.title = JE.t('audio_language_tooltip');
            el.style.display = 'flex';
            el.style.verticalAlign = 'middle';
            el.style.alignItems = 'center';
            el.style.flexDirection = 'row';
            el.style.justifyContent = 'center';
            el.style.flexWrap = 'wrap';
            el.style.textAlign = 'center';
            el.style.gap = '0.1em';
            try { el.style.setProperty('white-space', 'normal', 'important'); } catch (_) { el.style.whiteSpace = 'normal'; }
        };

        // Helper to render unavailable/no data with dash
        const renderUnavailable = () => {
            applyLangStyles(placeholder);
            placeholder.innerHTML = `<span class="material-icons" style="font-size: inherit; margin-right: 0.3em;">translate</span> -`;
        };

        // Helper to render language items with proper DOM elements
        const renderLanguages = (languages) => {
            // Clear the loading indicator
            placeholder.innerHTML = '';
            placeholder.style.display = 'flex';
            placeholder.style.alignItems = 'center';
            placeholder.style.gap = '0.5em';
            placeholder.title = JE.t('audio_language_tooltip');

            // Add icon
            const icon = document.createElement('span');
            icon.className = 'material-icons';
            icon.style.fontSize = 'inherit';
            icon.style.flexShrink = '0';
            icon.textContent = 'translate';
            placeholder.appendChild(icon);

            const scrollContainer = document.createElement('div');
            scrollContainer.className = 'audio-languages-container';
            scrollContainer.style.display = 'flex';
            scrollContainer.style.flexWrap = 'nowrap';
            scrollContainer.style.gap = '0.1em';
            scrollContainer.style.alignItems = 'center';
            scrollContainer.style.overflowY = 'hidden';

            if (languages.length > 3) { //if there are more than 3 languages, make it scrollable
                scrollContainer.style.overflowX = 'auto';
                scrollContainer.style.scrollBehavior = 'smooth';
                scrollContainer.style.whiteSpace = 'nowrap';
                scrollContainer.style.maxWidth = '20em';
                scrollContainer.style.paddingBottom = '2px';
                scrollContainer.style.touchAction = 'pan-x';
                scrollContainer.style.webkitOverflowScrolling = 'touch';

                // Hide scrollbar
                scrollContainer.style.scrollbarWidth = 'none';
                scrollContainer.style.msOverflowStyle = 'none';
                scrollContainer.style.overflowY = 'hidden';
                scrollContainer.addEventListener('wheel', (e) => {
                    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                        scrollContainer.scrollLeft += e.deltaY;
                        e.preventDefault();
                    }
                }, { passive: false });
                // Inject inline webkit scrollbar hide
                scrollContainer.style.setProperty('::-webkit-scrollbar', 'display: none');

                // Add indicator showing scrollable content
                const indicator = document.createElement('span');
                indicator.className = 'scroll-indicator';
                indicator.style.display = 'inline-block';
                indicator.style.opacity = '0.7';
                indicator.style.fontSize = '0.9em';
                indicator.textContent = '⇆';
                placeholder.appendChild(indicator);
            }

            languages.forEach((lang, index) => {
                // Create container span with data-lang attribute
                const langSpan = document.createElement('span');
                langSpan.className = 'audio-language-item';
                langSpan.dataset.lang = lang.code;
                langSpan.dataset.langName = lang.name;
                langSpan.style.whiteSpace = 'nowrap';

                const countryCode = languageToCountryMap[lang.name] || languageToCountryMap[lang.code];
                if (countryCode) {
                    const flag = document.createElement('img');
                    flag.src = `https://cdnjs.cloudflare.com/ajax/libs/flag-icons/7.2.1/flags/4x3/${countryCode.toLowerCase()}.svg`;
                    flag.alt = `${lang.name} flag`;
                    flag.style.width = '18px';
                    flag.style.marginRight = '0.3em';
                    flag.style.borderRadius = '2px';
                    langSpan.appendChild(flag);
                }

                const text = document.createTextNode(lang.name);
                langSpan.appendChild(text);

                scrollContainer.appendChild(langSpan);

                if (index < languages.length - 1) {
                    const separator = document.createElement('span');
                    separator.style.margin = '0 0.25em';
                    separator.textContent = ', ';
                    separator.style.whiteSpace = 'nowrap';
                    scrollContainer.appendChild(separator);
                }
            });

            placeholder.appendChild(scrollContainer);
        };

        // Use requestIdleCallback to defer the work and not block page rendering
        const performFetch = async () => {
            // Check cache first
            const now = Date.now();
            const cached = audioLanguageCache.get(itemId);
            if (cached && (now - cached.ts) < LANGUAGE_CACHE_TTL) {
                if (cached.unavailable || !cached.languages || cached.languages.length === 0) {
                    renderUnavailable();
                    return;
                }
                // Render from cache
                renderLanguages(cached.languages);
                return;
            }

            try {
                const userId = ApiClient.getCurrentUserId();
                const item = JE.helpers?.getItemCached
                    ? await JE.helpers.getItemCached(itemId, { userId })
                    : await ApiClient.getItem(userId, itemId);

                let sourceItem = item;

                // For Series/Season, fetch the first episode to get language info
                if (item.Type === 'Series' || item.Type === 'Season') {
                    const episode = await fetchFirstEpisodeForLanguage(userId, item.Id);
                    if (episode) {
                        sourceItem = episode;
                    } else {
                        // No episodes found
                        renderUnavailable();
                        audioLanguageCache.set(itemId, { languages: [], unavailable: true, ts: Date.now() });
                        return;
                    }
                }

                const languages = new Set();
                sourceItem?.MediaSources?.forEach(source => {
                    source.MediaStreams?.filter(stream => stream.Type === 'Audio').forEach(stream => {
                        const langCode = stream.Language;
                        if (langCode && !['und', 'root'].includes(langCode.toLowerCase())) {
                            try {
                                const langName = new Intl.DisplayNames(['en'], { type: 'language' }).of(langCode);
                                languages.add(JSON.stringify({ name: langName, code: langCode }));
                            } catch (e) {
                                languages.add(JSON.stringify({ name: langCode.toUpperCase(), code: langCode }));
                            }
                        }
                    });
                });

                const uniqueLanguages = Array.from(languages).map(JSON.parse);
                if (uniqueLanguages.length > 0) {
                    renderLanguages(uniqueLanguages);
                    // Cache the successful result
                    audioLanguageCache.set(itemId, { languages: uniqueLanguages, unavailable: false, ts: Date.now() });
                } else {
                    renderUnavailable();
                    audioLanguageCache.set(itemId, { languages: [], unavailable: true, ts: Date.now() });
                }
            } catch (error) {
                console.error('🪼 Jellyfin Enhanced: Error fetching audio languages for %s:', itemId, error);
                renderUnavailable();
                audioLanguageCache.set(itemId, { languages: [], unavailable: true, ts: Date.now() });
            }
        };

        // Defer to allow page to render first
        if (typeof requestIdleCallback !== 'undefined') {
            requestIdleCallback(() => performFetch(), { timeout: 2000 });
        } else {
            setTimeout(() => performFetch(), 0);
        }
    }

    /**
     * Fetches a path from TMDB via the plugin's proxy endpoint.
     * @param {string} path TMDB API path, e.g. `/movie/{id}/release_dates`.
     * @returns {Promise<object|null>}
     */
    function tmdbGet(path) {
        const url = ApiClient.getUrl(`/JellyfinEnhanced/tmdb${path}`);
        // Jellyfin 12 authenticates from the Authorization header; the legacy
        // X-Emby-Token is kept for 10.11 back-compat.
        return fetch(url, { headers: { "Authorization": `MediaBrowser Token="${ApiClient.accessToken()}"`, "X-Emby-Token": ApiClient.accessToken() } })
            .then(r => r.ok ? r.json() : Promise.reject(`API Error: ${r.status}`))
            .catch(error => {
                console.error(`🪼 Jellyfin Enhanced: Release Date: TMDB request failed for ${path}`, error);
                return null;
            });
    }

    function todayIso() {
        return new Date().toISOString().slice(0, 10);
    }

    function formatReleaseDate(dateStr) {
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return dateStr;
        return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    }

    // TMDB /movie/{id}/release_dates `type` values, bucketed into the three
    // distinct release moments we show, in chronological display order.
    // Theatrical premiere(1)/limited(2)/wide(3) collapse into one "cinema"
    // bucket (earliest of the three) so a movie doesn't show three near-
    // identical theatrical chips; digital(4) and physical(5) stay separate.
    const MOVIE_RELEASE_BUCKETS = [
        { types: [1, 2, 3], icon: 'local_movies', titleKey: 'calendar_cinema_release' },
        { types: [4], icon: 'ondemand_video', titleKey: 'calendar_digital_release' },
        { types: [5], icon: 'album', titleKey: 'calendar_physical_release' },
    ];

    /** Returns the earliest `release_date` among entries of the given bucket's types, or null. */
    function earliestOfBucket(releaseDates, bucket) {
        const matches = (releaseDates || []).filter(d => bucket.types.includes(d.type) && d.release_date);
        if (matches.length === 0) return null;
        return matches.reduce((a, b) => (a.release_date < b.release_date ? a : b));
    }

    /**
     * Resolves every known release date for a movie (cinema/digital/physical,
     * whichever TMDB has). Each bucket is resolved independently, cascading
     * through the configured region, then US, then any region at all that
     * has that type. This matters because most countries only ever record a
     * single release type (often just theatrical) — locking the whole movie
     * to one region's entry would silently drop digital/physical dates that
     * TMDB has recorded under a different country.
     * @returns {Promise<Array<{date: string, icon: string, titleKey: string}>>}
     */
    async function getMovieReleaseInfo(tmdbId) {
        const data = await tmdbGet(`/movie/${tmdbId}/release_dates`);
        const results = data?.results;
        if (!Array.isArray(results) || results.length === 0) return [];

        const region = (JE.pluginConfig?.DEFAULT_REGION || 'US').toUpperCase();
        const preferredOrder = [region, 'US'].filter((iso, i, arr) => iso && arr.indexOf(iso) === i);

        const infos = [];
        for (const bucket of MOVIE_RELEASE_BUCKETS) {
            let earliest = null;
            for (const iso of preferredOrder) {
                const entry = results.find(r => r.iso_3166_1 === iso);
                earliest = entry && earliestOfBucket(entry.release_dates, bucket);
                if (earliest) break;
            }
            if (!earliest) {
                for (const entry of results) {
                    earliest = earliestOfBucket(entry.release_dates, bucket);
                    if (earliest) break;
                }
            }
            if (earliest) infos.push({ date: earliest.release_date, icon: bucket.icon, titleKey: bucket.titleKey });
        }
        return infos;
    }

    /** Resolves the next (or, if none, most recent) episode air date for a series. */
    async function getSeriesReleaseInfo(tmdbId) {
        const data = await tmdbGet(`/tv/${tmdbId}`);
        const date = data?.next_episode_to_air?.air_date || data?.last_episode_to_air?.air_date;
        return date ? [{ date, icon: 'tv_guide', titleKey: 'calendar_episode' }] : [];
    }

    /** Resolves the next (or, if none, most recent) episode air date within a season. */
    async function getSeasonReleaseInfo(tmdbId, seasonNumber) {
        const data = await tmdbGet(`/tv/${tmdbId}/season/${seasonNumber}`);
        const episodes = data?.episodes;
        if (!Array.isArray(episodes) || episodes.length === 0) return [];

        const withDates = episodes.filter(e => e.air_date);
        if (withDates.length === 0) return [];

        const today = todayIso();
        const upcoming = withDates.find(e => e.air_date >= today);
        const date = (upcoming || withDates[withDates.length - 1]).air_date;
        return [{ date, icon: 'tv_guide', titleKey: 'calendar_episode' }];
    }

    /** Resolves a single episode's air date. */
    async function getEpisodeReleaseInfo(tmdbId, seasonNumber, episodeNumber) {
        const data = await tmdbGet(`/tv/${tmdbId}/season/${seasonNumber}/episode/${episodeNumber}`);
        return data?.air_date ? [{ date: data.air_date, icon: 'tv_guide', titleKey: 'calendar_episode' }] : [];
    }

    /**
     * Resolves release/air date info for an item, branching on Jellyfin item
     * type. Season/Episode look up the series' TMDB ID (preferring
     * SeriesProviderIds, falling back to fetching the series item) the same
     * way reviews.js does for TMDB reviews.
     * @returns {Promise<Array<{date: string, icon: string, titleKey: string}>>}
     */
    async function resolveReleaseInfo(item, userId) {
        const mediaType = item?.Type;

        if (mediaType === 'Movie') {
            const tmdbId = item?.ProviderIds?.Tmdb;
            return tmdbId ? getMovieReleaseInfo(tmdbId) : [];
        }

        if (mediaType === 'Series') {
            const tmdbId = item?.ProviderIds?.Tmdb;
            return tmdbId ? getSeriesReleaseInfo(tmdbId) : [];
        }

        if (mediaType === 'Season' || mediaType === 'Episode') {
            let seriesTmdbId = item?.SeriesProviderIds?.Tmdb;
            if (!seriesTmdbId && item?.SeriesId) {
                try {
                    const series = await ApiClient.getItem(userId, item.SeriesId);
                    seriesTmdbId = series?.ProviderIds?.Tmdb;
                } catch (_) { /* fall through to empty below */ }
            }
            if (!seriesTmdbId) return [];

            if (mediaType === 'Season') {
                return item?.IndexNumber != null ? getSeasonReleaseInfo(seriesTmdbId, item.IndexNumber) : [];
            }
            return (item?.ParentIndexNumber != null && item?.IndexNumber != null)
                ? getEpisodeReleaseInfo(seriesTmdbId, item.ParentIndexNumber, item.IndexNumber)
                : [];
        }

        return [];
    }

    /**
     * Shows a release/air date chip (icon + date per known release type) on
     * an item's details page. Unlike file size / audio language, there's no
     * "unavailable" dash state: most back-catalog items genuinely have no
     * digital/physical release date recorded on TMDB, so the chip is skipped
     * entirely rather than always rendering a placeholder.
     *
     * A placeholder element (with dataset.itemId set) is inserted
     * synchronously, before the async TMDB fetch starts. This is required for
     * the dedup check above to work: the shared MutationObserver re-invokes
     * handleItemDetails() several times in quick succession (debounced, but
     * still well within the requestIdleCallback window of a slow TMDB
     * round-trip), and without an early placeholder each of those calls would
     * independently fetch and append its own chip for the same item.
     * @param {string} itemId The ID of the item.
     * @param {HTMLElement} container The DOM element to append the chip to.
     */
    async function displayReleaseDate(itemId, container) {
        const existing = container.querySelector('.mediaInfoItem-releaseDate');
        if (existing) {
            // Already rendered (or in flight) for this itemId — nothing to do.
            if (existing.dataset.itemId === itemId) return;
            existing.remove();
        }

        const now = Date.now();
        const cached = releaseDateCache.get(itemId);
        if (cached && (now - cached.ts) < RELEASEDATE_CACHE_TTL) {
            if (cached.infos.length > 0) renderReleaseDateChip(container, itemId, cached.infos);
            return;
        }

        const placeholder = document.createElement('div');
        placeholder.className = 'mediaInfoItem mediaInfoItem-releaseDate';
        placeholder.dataset.itemId = itemId;
        placeholder.style.display = 'none';
        container.appendChild(placeholder);

        const performFetch = async () => {
            try {
                const userId = ApiClient.getCurrentUserId();
                const item = JE.helpers?.getItemCached
                    ? await JE.helpers.getItemCached(itemId, { userId })
                    : await ApiClient.getItem(userId, itemId);
                const infos = await resolveReleaseInfo(item, userId);
                releaseDateCache.set(itemId, { infos, ts: now });
                // The user may have navigated away while this was in flight.
                if (!placeholder.isConnected) return;
                if (infos.length > 0) {
                    fillReleaseDateChip(placeholder, infos);
                } else {
                    placeholder.remove();
                }
            } catch (error) {
                console.error(`🪼 Jellyfin Enhanced: Release Date: Error fetching release info for ${itemId}:`, error);
                releaseDateCache.set(itemId, { infos: [], ts: now });
                placeholder.remove();
            }
        };

        if (typeof requestIdleCallback !== 'undefined') {
            requestIdleCallback(() => performFetch(), { timeout: 2000 });
        } else {
            setTimeout(() => performFetch(), 0);
        }
    }

    let releaseDateIconFontInjected = false;
    function ensureReleaseDateIconFont() {
        if (releaseDateIconFontInjected) return;
        releaseDateIconFontInjected = true;
        JE.helpers.addCSS('je-release-date-symbols', `
            @font-face {
                font-family: 'Material Symbols Rounded';
                font-style: normal;
                font-weight: 100 700;
                font-display: block;
                src: url(https://fonts.gstatic.com/s/materialsymbolsrounded/v258/syl0-zNym6YjUruM-QrEh7-nyTnjDwKNJ_190FjpZIvDmUSVOK7BDB_Qb9vUSzq3wzLK-P0J-V_Zs-QtQth3-jOcbTCVpeRL2w5rwZu2rIelXxc.woff2) format('woff2');
            }
            .je-release-date-icon {
                font-family: 'Material Symbols Rounded';
                font-weight: normal;
                font-style: normal;
                line-height: 1;
                letter-spacing: normal;
                text-transform: none;
                display: inline-block;
                white-space: nowrap;
                word-wrap: normal;
                direction: ltr;
                -webkit-font-feature-settings: 'liga';
                -moz-font-feature-settings: 'liga';
                font-feature-settings: 'liga';
                -webkit-font-smoothing: antialiased;
            }
        `);
    }

    /** Fills an existing release-date placeholder element with one icon+date pair per known release type. */
    function fillReleaseDateChip(chip, infos) {
        ensureReleaseDateIconFont();
        chip.title = JE.t('release_date_tooltip');
        chip.style.display = 'flex';
        chip.style.alignItems = 'center';
        chip.style.gap = '0.6em';
        chip.style.margin = '0 1em 0 0 !important';
        chip.innerHTML = infos.map(info => `<span style="display: inline-flex; align-items: center;"><span class="je-release-date-icon" style="font-size: inherit; margin-right: 0.3em;" title="${JE.t(info.titleKey)}">${info.icon}</span>${formatReleaseDate(info.date)}</span>`).join('');
    }

    /** Creates and appends a fresh release-date chip (cache-hit path, where there's no placeholder to fill). */
    function renderReleaseDateChip(container, itemId, infos) {
        const chip = document.createElement('div');
        chip.className = 'mediaInfoItem mediaInfoItem-releaseDate';
        chip.dataset.itemId = itemId;
        fillReleaseDateChip(chip, infos);
        container.appendChild(chip);
    }

    /**
     * Handle item details page display with debounced observer
     */
    // Cache the last item id and type to avoid repeated ApiClient calls
    let lastDetailsItemId = null;
    let lastDetailsItemType = null;
    let itemTypeFetchInProgress = null;

    // Types that support file size and watch progress
    const FEATURES_SUPPORTED_TYPES = ['Episode', 'Season', 'Series', 'Movie', 'BoxSet', 'Playlist'];
    // Types that support audio languages (excludes BoxSet and Playlist)
    const AUDIO_LANGUAGES_SUPPORTED_TYPES = ['Episode', 'Season', 'Series', 'Movie'];

    // Types that support hiding
    const HIDE_SUPPORTED_TYPES = ['Movie', 'Series', 'Episode', 'Season'];

    /**
     * Adds a "Hide" button to the item detail page action buttons area.
     * Supports Movies, Series, Episodes, and Seasons.
     * For Episodes: shows a choice dialog between hiding the episode or the entire show.
     * @param {string} itemId The item's Jellyfin ID.
     * @param {HTMLElement} visiblePage The visible detail page element.
     */
    function addHideContentButton(itemId, visiblePage) {
        if (!JE.hiddenContent) return;
        const settings = JE.hiddenContent.getSettings();
        if (!settings.enabled || !settings.showHideButtons) return;
        const isPerson = lastDetailsItemType === 'Person';
        if (isPerson) {
            if (!settings.showButtonCast) return;
        } else {
            if (settings.showButtonDetails === false) return;
            if (!HIDE_SUPPORTED_TYPES.includes(lastDetailsItemType)) return;
        }

        // Don't add duplicate
        if (visiblePage.querySelector('.je-detail-hide-btn')) return;

        const selectors = [
            '.detailButtons',
            '.itemActionsBottom',
            '.mainDetailButtons',
            '.detailButtonsContainer'
        ];
        let buttonContainer = null;
        for (const sel of selectors) {
            const found = visiblePage.querySelector(sel);
            if (found) {
                buttonContainer = found;
                break;
            }
        }
        if (!buttonContainer) return;

        const button = document.createElement('button');
        button.setAttribute('is', 'emby-button');
        button.className = 'button-flat detailButton emby-button je-detail-hide-btn';
        button.type = 'button';

        const hideLabel = JE.t('hidden_content_hide_button') !== 'hidden_content_hide_button'
            ? JE.t('hidden_content_hide_button')
            : 'Hide';
        const hiddenLabel = JE.t('hidden_content_already_hidden') !== 'hidden_content_already_hidden'
            ? JE.t('hidden_content_already_hidden')
            : 'Hidden';
        const unhideLabel = JE.t('hidden_content_unhide') !== 'hidden_content_unhide'
            ? JE.t('hidden_content_unhide')
            : 'Unhide';

        const content = document.createElement('div');
        content.className = 'detailButton-content';
        button.appendChild(content);

        function renderContent(text, iconName) {
            content.replaceChildren();
            const icon = document.createElement('span');
            icon.className = 'material-icons detailButton-icon';
            icon.setAttribute('aria-hidden', 'true');
            icon.textContent = iconName || 'visibility';
            content.appendChild(icon);
            if (text) {
                const textSpan = document.createElement('span');
                textSpan.className = 'detailButton-icon-text';
                textSpan.textContent = text;
                content.appendChild(textSpan);
            }
        }

        function setHiddenState() {
            button.classList.add('je-already-hidden');
            button.setAttribute('aria-label', hiddenLabel);
            button.title = hiddenLabel;
            renderContent('', 'visibility_off');

            button.onmouseenter = () => {
                button.title = unhideLabel;
            };
            button.onmouseleave = () => {
                button.title = hiddenLabel;
            };
            button.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                JE.hiddenContent.unhideItem(itemId);
                setHideState();
            };
        }

        function setHideState() {
            button.classList.remove('je-already-hidden');
            button.setAttribute('aria-label', hideLabel);
            button.title = hideLabel;
            renderContent('', 'visibility');
            button.onmouseenter = null;
            button.onmouseleave = null;
            button.onclick = async (e) => {
                e.preventDefault();
                e.stopPropagation();

                // Get item name from the page title
                const nameEl = visiblePage.querySelector('.itemName, h1, h2, [class*="itemName"]');
                const itemName = nameEl?.textContent?.trim() || 'Unknown';

                // Fetch full item data for TMDb ID and episode/series metadata
                let tmdbId = '';
                let seriesId = '';
                let seriesName = '';
                let seasonNumber = null;
                let episodeNumber = null;
                try {
                    const userId = ApiClient.getCurrentUserId();
                    const item = JE.helpers?.getItemCached
                        ? await JE.helpers.getItemCached(itemId, { userId })
                        : await ApiClient.getItem(userId, itemId);
                    tmdbId = item?.ProviderIds?.Tmdb || '';
                    seriesId = item?.SeriesId || '';
                    seriesName = item?.SeriesName || '';
                    seasonNumber = item?.ParentIndexNumber != null ? item.ParentIndexNumber : null;
                    episodeNumber = item?.IndexNumber != null ? item.IndexNumber : null;
                } catch (err) {
                    console.warn('🪼 Jellyfin Enhanced: Could not fetch item metadata for hide button', err);
                }

                const isEpisode = lastDetailsItemType === 'Episode';
                const isSeason = lastDetailsItemType === 'Season';

                // Build base item data
                const baseItemData = {
                    itemId,
                    name: itemName,
                    type: lastDetailsItemType,
                    tmdbId,
                    seriesId,
                    seriesName,
                    seasonNumber,
                    episodeNumber
                };

                if (isEpisode && seriesId) {
                    // Episode on a detail page: show choice dialog
                    JE.hiddenContent.confirmAndHide(baseItemData, () => {
                        setHiddenState();
                    }, {
                        showEpisodeChoice: true,
                        onChooseShow: async () => {
                            // User chose to hide the entire show
                            let seriesTmdbId = '';
                            try {
                                const userId = ApiClient.getCurrentUserId();
                                const series = await ApiClient.getItem(userId, seriesId);
                                seriesTmdbId = series?.ProviderIds?.Tmdb || '';
                            } catch (err) {
                                console.warn('🪼 Jellyfin Enhanced: Could not fetch series metadata for hide-show action', err);
                            }
                            JE.hiddenContent.hideItem({
                                itemId: seriesId,
                                name: seriesName || itemName,
                                type: 'Series',
                                tmdbId: seriesTmdbId,
                                posterPath: ''
                            });
                            setHiddenState();
                        }
                    });
                } else if (isSeason && seriesId) {
                    // Season: hide with series metadata
                    JE.hiddenContent.confirmAndHide(baseItemData, () => {
                        setHiddenState();
                    });
                } else {
                    // Movie or Series: standard hide
                    JE.hiddenContent.confirmAndHide(baseItemData, () => {
                        setHiddenState();
                    });
                }
            };
        }

        if (JE.hiddenContent.isHidden(itemId)) {
            setHiddenState();
        } else {
            setHideState();
        }

        // Keep Jellyfin's overflow menu (three-dots) as the last action button.
        const moreButton = buttonContainer.querySelector('.btnMoreCommands');
        if (moreButton) {
            buttonContainer.insertBefore(button, moreButton);
        } else {
            buttonContainer.appendChild(button);
        }
    }

    const handleItemDetails = JE.helpers.debounce(() => {
        const visiblePage = document.querySelector('#itemDetailPage:not(.hide)');
        if (!visiblePage) return;

        const container = visiblePage.querySelector('.itemMiscInfo.itemMiscInfo-primary');
        if (!container) return;

        try {
            const itemId = new URLSearchParams(window.location.hash.split('?')[1]).get('id');
            if (!itemId) return;

            // Reset cache when navigating to a new item
            if (lastDetailsItemId !== itemId) {
                lastDetailsItemId = itemId;
                lastDetailsItemType = null;
            }

            // Fetch item type once per item to decide applicability
            if (!lastDetailsItemType) {
                if (!itemTypeFetchInProgress) {
                    const userId = ApiClient.getCurrentUserId();
                    itemTypeFetchInProgress = (JE.helpers?.getItemCached
                        ? JE.helpers.getItemCached(itemId, { userId })
                        : ApiClient.getItem(userId, itemId))
                        .then(item => {
                            lastDetailsItemType = item?.Type || null;
                            itemTypeFetchInProgress = null;
                            // Re-run once type is known to render features
                            handleItemDetails();
                        })
                        .catch(() => { itemTypeFetchInProgress = null; });
                }
                return;
            }

            // Add hide content button on detail pages (including Person pages)
            if (JE.hiddenContent) {
                addHideContentButton(itemId, visiblePage);
            }

            // Spoiler Guard toggle on Series (blurs all unwatched episode images
            // via the server filter), Movie (blurs the movie's own poster/backdrop
            // until marked Played), and Collection/BoxSet (protects every movie
            // inside; the collection's own art stays clear) detail pages.
            if ((lastDetailsItemType === 'Series' || lastDetailsItemType === 'Movie' || lastDetailsItemType === 'BoxSet')
                && JE.spoilerBlur
                && typeof JE.spoilerBlur.addSpoilerBlurButton === 'function') {
                JE.spoilerBlur.addSpoilerBlurButton(itemId, visiblePage, lastDetailsItemType);
            }

            // Skip unsupported item types for media features
            if (!FEATURES_SUPPORTED_TYPES.includes(lastDetailsItemType)) {
                return;
            }

            if (JE?.currentSettings?.showWatchProgress) {
                displayWatchProgress(itemId, container);
            }
            if (JE?.currentSettings?.showFileSizes) {
                displayItemSize(itemId, container);
            }
            if (JE?.currentSettings?.showAudioLanguages && AUDIO_LANGUAGES_SUPPORTED_TYPES.includes(lastDetailsItemType)) {
                displayAudioLanguages(itemId, container);
            }
            if (JE.pluginConfig?.ShowReleaseDates && JE.pluginConfig?.TmdbEnabled && AUDIO_LANGUAGES_SUPPORTED_TYPES.includes(lastDetailsItemType)) {
                displayReleaseDate(itemId, container);
            }
        } catch (e) {
        console.warn('🪼 Jellyfin Enhanced: Error in item details handler', e);
    }
    }, 100);

    // Create managed observer for item details
    JE.helpers.createObserver(
        'item-details-info',
        (mutations) => {
            for (const mutation of mutations) {
                if (mutation.type === 'childList' || mutation.type === 'attributes') {
                    handleItemDetails();
                }
            }
        },
        document.body,
        {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style']
        }
    );

    // The two home-screen surfaces the Remove feature can act on. Each maps to a server
    // hide endpoint, the action-sheet label, and the HideScope persisted in hidden-content.json.
    const REMOVE_SURFACES = {
        continuewatching: { path: 'continue-watching', labelKey: 'remove_from_continue_watching', nameKey: 'remove_surface_continue_watching', successKey: 'remove_continue_watching_success' },
        nextup: { path: 'next-up', labelKey: 'remove_from_next_up', nameKey: 'remove_surface_next_up', successKey: 'remove_next_up_success' }
    };

    /**
     * Builds a menu item that matches the native action-sheet items in the given sheet. It
     * copies a sibling item's class list (so font size, borders and focus scaling match the
     * current sheet and device — Jellyfin adds `actionsheet-xlargeFont` on mobile, etc.) and
     * uses Jellyfin's own item structure: a class-based Material icon on an empty span plus
     * `listItemBody`/`actionSheetItemText`. It is parsed via innerHTML so the `is="emby-button"`
     * custom element upgrades (ripple) exactly like a native item.
     * @param {HTMLElement} scroller The `.actionSheetScroller` the item will live in.
     * @param {{dataId: string, icon: string, text: string}} opts
     * @returns {HTMLElement}
     */
    function buildNativeActionSheetItem(scroller, opts) {
        const ref = scroller.querySelector('.actionSheetMenuItem');
        // Mirror a real item's classes (minus any transient selection state) so sizing is identical.
        const itemClass = (ref ? ref.getAttribute('class') : 'listItem listItem-button actionSheetMenuItem')
            .replace(/\bselected\b/g, '').replace(/\s+/g, ' ').trim();
        const tmp = document.createElement('div');
        tmp.innerHTML =
            `<button is="emby-button" type="button" class="${itemClass}" data-id="${opts.dataId}">`
            + `<span class="actionsheetMenuItemIcon listItemIcon listItemIcon-transparent material-icons ${opts.icon}" aria-hidden="true"></span>`
            + `<div class="listItemBody actionsheetListItemBody"><div class="listItemBodyText actionSheetItemText"></div></div>`
            + `</button>`;
        const button = tmp.firstElementChild;
        // textContent (never innerHTML) for the label — matches native escapeHtml and is injection-safe.
        button.querySelector('.actionSheetItemText').textContent = opts.text;
        return button;
    }

    /** Swaps a native action-sheet item's Material icon (class-based, like Jellyfin's own items). */
    function setActionSheetItemIcon(button, iconName) {
        const span = button.querySelector('.actionsheetMenuItemIcon');
        if (span) {
            span.className = `actionsheetMenuItemIcon listItemIcon listItemIcon-transparent material-icons ${iconName}`;
        }
    }

    /**
     * Keeps the Remove item one line and on-screen. Our "Remove from …" label is wider than the
     * sheet's native items, but Jellyfin sized + positioned the sheet (a `position:fixed` dialog
     * with an inline `left`) for its content BEFORE we added our item, so the now-wider sheet can
     * spill past the right edge. We re-run Jellyfin's own overflow correction: if the sheet still
     * fits the viewport, nudge it left so the whole one-line label shows; only if the label is
     * wider than the entire screen do we wrap it. Reads offsetWidth / inline left (both unaffected
     * by the open animation's transform). Call AFTER inserting the item.
     * @param {HTMLElement} button The already-inserted item.
     * @param {HTMLElement} scroller The action-sheet scroller.
     */
    function fitRemoveItemToMenu(button, scroller) {
        try {
            const dlg = scroller.closest('.dialog, .actionSheet');
            const viewportW = document.documentElement.clientWidth || window.innerWidth || 0;
            if (!dlg || !viewportW) return;

            const left = parseFloat(dlg.style.left);
            // Only positioned (corner-anchored) sheets have an inline left; centered / full-width
            // sheets need no help — a long label just wraps within their width.
            if (!Number.isFinite(left)) return;

            const width = dlg.offsetWidth;
            if (width <= viewportW - 20) {
                // Fits on screen at one line — shift it left if it currently spills past the edge.
                if (left + width > viewportW - 10) {
                    dlg.style.left = Math.max(10, viewportW - width - 10) + 'px';
                }
            } else {
                // Too wide for the screen even pinned to the edge → wrap the label to fit.
                dlg.style.left = '10px';
                button.style.maxWidth = (viewportW - 24) + 'px';
                const text = button.querySelector('.actionSheetItemText');
                if (text) text.style.whiteSpace = 'normal';
            }
        } catch (e) { /* leave native sizing */ }
    }

    // How long a captured menu context stays valid. The action-sheet observer fires within
    // ~150ms of a menu opening; this bounds how stale a context can be before we ignore it.
    const REMOVE_CONTEXT_TTL_MS = 5000;

    /**
     * Determines which home-screen surface a card belongs to, using locale-independent
     * signals so detection survives translated section titles and custom themes:
     *   • Next Up — the section title is a link to the Next Up list (`?type=nextup`).
     *   • Continue Watching — resume cards carry a `data-positionticks` playback position.
     * A localized section-title text check is kept as a last-resort fallback.
     * @param {Element} el A `.card` element, or any element inside/representing one.
     * @returns {'continuewatching'|'nextup'|null}
     */
    JE.detectCardSurface = function(el) {
        if (!el) return null;
        const card = (typeof el.closest === 'function' ? el.closest('.card') : null) || el;
        const section = typeof card.closest === 'function'
            ? card.closest('.section, .verticalSection, .homeSection')
            : null;

        // Next Up: the section title links to the Next Up list — present regardless of locale.
        if (section && section.querySelector('a[href*="type=nextup"]')) return 'nextup';

        // Continue Watching: only resume cards expose a playback position.
        const ticks = (card.getAttribute && card.getAttribute('data-positionticks'))
            || (el.getAttribute && el.getAttribute('data-positionticks'));
        if (ticks) return 'continuewatching';

        // Fallback for markup/themes without the link or ticks: localized section title text.
        if (section) {
            const title = (section.querySelector('.sectionTitle, h2, .headerText, .sectionTitle-sectionTitle')?.textContent || '')
                .toLowerCase().trim();
            if (title.includes('next up')) return 'nextup';
            if (title.includes('continue watching')) return 'continuewatching';
        }
        return null;
    };

    /**
     * Optimistically hides the just-removed card. Prefers hiding the exact card the user
     * acted on (so the same item shown in another row is never blanked); if that element is
     * gone, falls back to cards whose detected surface matches the one removed from.
     * @param {string} itemId Jellyfin item ID.
     * @param {string} surface 'continuewatching' | 'nextup'.
     * @param {Element} [card] The specific card element the action was triggered from.
     */
    function optimisticHideRemovedCard(itemId, surface, card) {
        try {
            if (card && card.isConnected) {
                card.style.display = 'none';
                return;
            }
            // Fallback (card re-rendered/detached): hide matching cards on the same surface only.
            document.querySelectorAll(`.card[data-id="${CSS.escape(itemId)}"]`).forEach(c => {
                if (JE.detectCardSurface(c) === surface) {
                    c.style.display = 'none';
                }
            });
        } catch (e) {
            console.warn('🪼 Jellyfin Enhanced: optimistic DOM-hide failed', e);
        }
    }

    /**
     * Non-destructive removal from a home surface (Continue Watching / Next Up):
     * server POST + scoped optimistic DOM hide. Playback position is always preserved.
     * @param {string} itemId Jellyfin item ID.
     * @param {string} surface 'continuewatching' | 'nextup'.
     * @param {Element} [card] The specific card element the action was triggered from.
     * @returns {Promise<boolean>}
     */
    async function removeFromHomeSurface(itemId, surface, card) {
        const config = REMOVE_SURFACES[surface];
        const userId = ApiClient.getCurrentUserId();
        if (!userId || !itemId || !config) {
            showNotification(JE.t('remove_continue_watching_error'), "error");
            return false;
        }

        // Flush pending HC save BEFORE the POST so a later debounce can't clobber the just-written entry.
        // If the flush fails the debounce is rescheduled inside flushPendingSave; abort the write so we
        // don't proceed on top of stale server state.
        try {
            await JE.hiddenContent?.flushPendingSave?.();
        } catch (e) {
            showNotification(JE.t('remove_continue_watching_error_api', { error: e?.statusText || JE.t('unknown_error') }), "error");
            return false;
        }

        try {
            await ApiClient.ajax({
                type: 'POST',
                url: ApiClient.getUrl(`/JellyfinEnhanced/${config.path}/hide/${itemId}`),
                data: '{}',
                contentType: 'application/json',
                dataType: 'json',
                headers: { 'Content-Type': 'application/json' }
            });

            optimisticHideRemovedCard(itemId, surface, card);

            // Local-cache mirror only — server already wrote the canonical entry; a refetch would risk a clobber.
            try {
                JE.hiddenContent?.markScopedHidden?.(itemId, surface);
            } catch (e) {
                console.warn('🪼 Jellyfin Enhanced: markScopedHidden mirror failed', e);
            }
            return true;
        } catch (error) {
            const errorMessage = error.responseJSON?.message
                || error.responseJSON?.Message
                || error.statusText
                || JE.t('unknown_error');
            showNotification(JE.t('remove_continue_watching_error_api', { error: errorMessage }), "error");
            return false;
        }
    }

    // Closes any open action sheet via dialog.close() / Escape; never synthetic mouse events (they reopen the sheet).
    function closeOpenActionSheet() {
        try {
            const dialogs = document.querySelectorAll('dialog[open]');
            let dispatched = false;
            for (const dlg of dialogs) {
                if (typeof dlg.close === 'function') {
                    try { dlg.close(); dispatched = true; } catch (e) { /* not a real dialog */ }
                }
            }
            if (dispatched) return true;

            // Escape-keydown fallback targets the sheet directly — dispatching on `document` is
            // intercepted by JE's global shortcuts. Jellyfin leaves dismissed sheets in the DOM,
            // so target the VISIBLE one (newest), not the first (possibly stale/hidden) match.
            const sheets = [...document.querySelectorAll('.actionSheet, .actionsheet, .dialogContainer .dialog, .dialog.opened')];
            const sheet = sheets.reverse().find(s => s.offsetParent !== null) || sheets[0];
            if (sheet) {
                sheet.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'Escape', code: 'Escape', keyCode: 27, which: 27,
                    bubbles: true, cancelable: true
                }));
            }
            return true;
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: action sheet close failed', err);
            return false;
        }
    }

    /** Hides Continue Watching / Next Up rows whose visible-card count is zero so the title doesn't linger. */
    function hideEmptyHomeSections() {
        try {
            const sections = document.querySelectorAll('.verticalSection, .section, .homeSection');
            for (const section of sections) {
                const titleEl = section.querySelector('.sectionTitle, h2, .headerText, .sectionTitle-sectionTitle');
                const title = (titleEl?.textContent || '').toLowerCase().trim();
                const isCW = title.startsWith('continue watching');
                const isNextUp = title.startsWith('next up');
                if (!isCW && !isNextUp) continue;

                const cards = section.querySelectorAll('.card[data-positionticks], .card[data-id]');
                let visibleCount = 0;
                for (const card of cards) {
                    if (card.classList.contains('je-hidden')) continue;
                    if (card.style.display === 'none') continue;
                    visibleCount++;
                }
                if (visibleCount === 0) section.style.display = 'none';
            }
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: hideEmptyHomeSections failed', err);
        }
    }
    JE.hideEmptyHomeSections = hideEmptyHomeSections;

    /**
     * Creates the surface-specific "Remove from …" button for the per-item action sheet,
     * rendered to match the sheet's native items. The bound item + surface are stamped onto
     * the element so a reused action sheet can tell whether an existing button still matches.
     * @param {HTMLElement} scroller The action-sheet scroller it will be inserted into.
     * @param {string} itemId The ID of the item.
     * @param {string} surface 'continuewatching' | 'nextup'.
     * @param {Element} [card] The source card element, for a precise optimistic hide.
     * @returns {HTMLElement} The created button element.
     */
    function createRemoveButton(scroller, itemId, surface, card) {
        const config = REMOVE_SURFACES[surface] || REMOVE_SURFACES.continuewatching;
        const button = buildNativeActionSheetItem(scroller, {
            dataId: 'remove-continue-watching',
            icon: 'visibility_off',
            text: JE.t(config.labelKey)
        });
        button.dataset.jeItemId = itemId;
        button.dataset.jeSurface = surface;
        const textEl = button.querySelector('.actionSheetItemText');

        button.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            const originalText = textEl.textContent;
            button.disabled = true;
            textEl.textContent = JE.t('remove_button_removing');
            setActionSheetItemIcon(button, 'hourglass_empty');

            const success = await removeFromHomeSurface(itemId, surface, card);

            // Restore visuals BEFORE close — a stuck sheet under odd themes is better than a stuck "Removing…" label.
            button.disabled = false;
            textEl.textContent = originalText;
            setActionSheetItemIcon(button, 'visibility_off');

            if (success) {
                const closed = closeOpenActionSheet();
                showNotification(JE.t(config.successKey), closed ? "success" : "info");
                hideEmptyHomeSections();
            }
        });

        return button;
    }

    /**
     * Returns the scroller of the action sheet that is actually on screen. Jellyfin leaves
     * dismissed action-sheet DOM behind, so the first `.actionSheetScroller` in the document
     * can be a stale/hidden one — pick the newest visible scroller instead.
     * @returns {HTMLElement|null}
     */
    function getActiveActionSheetScroller() {
        const scrollers = document.querySelectorAll('.actionSheetScroller');
        for (let i = scrollers.length - 1; i >= 0; i--) {
            if (scrollers[i].offsetParent !== null) return scrollers[i];
        }
        return scrollers.length ? scrollers[scrollers.length - 1] : null;
    }

    /**
     * Adds the Remove button to the per-item action sheet for the item whose menu was just
     * opened. The action sheet content element is reused across opens, so a Remove button
     * from a previous item can linger; this reconciles the button against the freshly-captured
     * context (set on the menu mousedown / right-click) and removes any stale one.
     *
     * Two guards keep the button from leaking onto an unrelated sheet:
     *   • it only acts on a recent trigger (REMOVE_CONTEXT_TTL_MS), and
     *   • it only injects into a sheet that carries a media-item action (resume/play), so
     *     non-item sheets (sort menus, OSD audio/subtitle pickers, multi-select) are skipped.
     * The context is consumed once handled so a later sheet can't reuse it.
     */
    JE.addRemoveButton = () => {
        if (!JE.currentSettings.removeContinueWatchingEnabled) return;

        const scroller = getActiveActionSheetScroller();
        if (!scroller) return;

        const existing = scroller.querySelector('[data-id="remove-continue-watching"]');
        // Only a media-item action sheet exposes play/resume; anything else isn't an item menu.
        const insertionPoint = scroller.querySelector('[data-id="playallfromhere"]')
            || scroller.querySelector('[data-id="resume"]')
            || scroller.querySelector('[data-id="play"]');

        // Non-item sheet (sort/OSD/multi-select). It must never host the per-item Remove button,
        // so strip one that leaked in via a reused scroller — even with no fresh context — then bail.
        if (!insertionPoint) { if (existing) existing.remove(); return; }

        const ctx = JE.state.removeContext;
        // Media-item sheet but no recent trigger: leave any existing button untouched (don't strip
        // a still-valid button while its sheet is open; a fresh trigger reconciles it).
        if (!ctx || !ctx.itemId || (Date.now() - (ctx.ts || 0)) > REMOVE_CONTEXT_TTL_MS) return;

        const wantSurface = REMOVE_SURFACES[ctx.surface] ? ctx.surface : null;
        if (existing) {
            // Keep an already-correct button (avoids flicker on repeated observer fires).
            if (wantSurface && existing.dataset.jeItemId === ctx.itemId && existing.dataset.jeSurface === wantSurface) {
                JE.state.removeContext = null;
                return;
            }
            existing.remove();
        }
        if (!wantSurface) { JE.state.removeContext = null; return; }

        const removeButton = createRemoveButton(scroller, ctx.itemId, wantSurface, ctx.card);
        insertionPoint.after(removeButton);
        fitRemoveItemToMenu(removeButton, scroller);
        // Consume the context: one menu-open yields one button; later observer fires (or an
        // unrelated sheet opened within the TTL) must not re-inject from this same context.
        JE.state.removeContext = null;
    };

    // ── Multi-select / long-press menu ───────────────────────────────────────────
    // Touch devices have no per-item "…" button; a long-press opens Jellyfin's multi-select
    // menu (Select All, Mark played, …) acting on the selected cards. We add a Remove option
    // there for any selected cards that live in Continue Watching / Next Up.

    /**
     * Collects the currently selected cards that sit in a removable home surface.
     * @returns {Array<{itemId: string, surface: string, card: Element, name: string}>}
     */
    function collectSelectedRemovableCards() {
        const out = [];
        const seen = new Set();
        document.querySelectorAll('.chkItemSelect').forEach(chk => {
            if (!chk.checked) return;
            const card = chk.closest('.card[data-id]') || chk.closest('[data-id]');
            const itemId = card && card.getAttribute('data-id');
            if (!itemId || seen.has(itemId)) return;
            const surface = JE.detectCardSurface(card);
            if (surface === 'continuewatching' || surface === 'nextup') {
                seen.add(itemId);
                const name = (card.querySelector('.cardText-first, .cardText')?.textContent || '').trim();
                out.push({ itemId, surface, card, name });
            }
        });
        return out;
    }

    /** Leaves Jellyfin's multi-select mode by clicking its close control (best-effort). */
    function exitSelectionMode() {
        try { document.querySelector('.btnCloseSelectionPanel')?.click(); }
        catch (e) { /* best-effort */ }
    }

    // Close handler of the currently-open bulk-remove confirm dialog (if any), so a second
    // open can resolve/clean up the first instead of orphaning its Promise + keydown listener.
    let activeConfirmClose = null;

    /**
     * Self-contained confirmation dialog for a bulk Remove. Lists each item and which home
     * surface it will be removed from. Inline-styled so it works even when the Hidden Content
     * module (and its dialog CSS) isn't active. Resolves true to proceed, false to cancel.
     * @param {Array<{name: string, surface: string}>} targets
     * @returns {Promise<boolean>}
     */
    function confirmMultiRemove(targets) {
        return new Promise((resolve) => {
            // Cleanly tear down any confirm still open (resolve its promise + drop its listener)
            // before opening a new one, so we never orphan a pending Promise / keydown handler.
            if (activeConfirmClose) activeConfirmClose(false);

            const overlay = document.createElement('div');
            overlay.className = 'je-remove-confirm-overlay';
            // Above Jellyfin's action sheet / dialog (z-index 999999) so it's never behind a closing menu.
            overlay.style.cssText = 'position:fixed;inset:0;z-index:1000001;background:rgba(0,0,0,0.75);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:16px;';

            const dialog = document.createElement('div');
            dialog.style.cssText = 'background:linear-gradient(135deg,rgba(30,30,35,0.98),rgba(20,20,25,0.98));border:1px solid rgba(255,255,255,0.12);border-radius:12px;padding:24px;max-width:460px;width:100%;color:#fff;max-height:80vh;display:flex;flex-direction:column;';

            const title = document.createElement('h3');
            title.textContent = JE.t('remove_confirm_title');
            title.style.cssText = 'margin:0 0 16px 0;font-size:18px;font-weight:600;';
            dialog.appendChild(title);

            const list = document.createElement('div');
            list.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin:0 0 20px 0;overflow-y:auto;';
            targets.forEach(t => {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:14px;padding:8px 12px;background:rgba(255,255,255,0.05);border-radius:6px;';
                const name = document.createElement('span');
                name.textContent = t.name || '';
                name.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
                const from = document.createElement('span');
                from.textContent = JE.t(REMOVE_SURFACES[t.surface].nameKey);
                from.style.cssText = 'flex:0 0 auto;font-size:12px;color:rgba(255,255,255,0.65);background:rgba(255,255,255,0.08);padding:3px 9px;border-radius:10px;white-space:nowrap;';
                row.appendChild(name);
                row.appendChild(from);
                list.appendChild(row);
            });
            dialog.appendChild(list);

            const buttons = document.createElement('div');
            buttons.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;';
            const cancel = document.createElement('button');
            cancel.setAttribute('is', 'emby-button');
            cancel.type = 'button';
            cancel.textContent = JE.t('remove_confirm_cancel');
            cancel.style.cssText = 'background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.15);color:#fff;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:14px;font-weight:500;';
            const ok = document.createElement('button');
            ok.setAttribute('is', 'emby-button');
            ok.type = 'button';
            ok.textContent = JE.t('remove_button_text');
            ok.style.cssText = 'background:rgba(220,50,50,0.65);border:1px solid rgba(220,50,50,0.7);color:#fff;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600;';
            buttons.appendChild(cancel);
            buttons.appendChild(ok);
            dialog.appendChild(buttons);

            const close = (result) => {
                if (activeConfirmClose === close) activeConfirmClose = null;
                overlay.remove();
                document.removeEventListener('keydown', escHandler);
                resolve(result);
            };
            activeConfirmClose = close;
            const escHandler = (e) => { if (e.key === 'Escape') close(false); };
            cancel.addEventListener('click', () => close(false));
            ok.addEventListener('click', () => close(true));
            overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
            document.addEventListener('keydown', escHandler);

            overlay.appendChild(dialog);
            document.body.appendChild(overlay);
            ok.focus();
        });
    }

    /**
     * Removes every target from its surface, then tears down the multi-select menu/selection
     * and notifies — but only if at least one removal succeeded (so a total failure leaves the
     * selection intact for a retry).
     * @param {Array<{itemId: string, surface: string, card: Element}>} targets
     * @returns {Promise<number>} how many were removed.
     */
    async function performMultiRemove(targets) {
        let removed = 0;
        for (const t of targets) {
            // Sequential — selections are small and this keeps the HC store writes ordered.
            if (await removeFromHomeSurface(t.itemId, t.surface, t.card)) removed++;
        }
        if (removed > 0) {
            closeOpenActionSheet();
            exitSelectionMode();
            showNotification(JE.t('remove_items_success'), 'success');
            hideEmptyHomeSections();
        }
        return removed;
    }

    /**
     * Label for the multi-select Remove item: the specific "Remove from …" wording when every
     * selected removable card shares one surface, or the generic "Remove" when the selection
     * mixes Continue Watching and Next Up.
     * @param {Array<{surface: string}>} targets
     * @returns {string}
     */
    function multiSelectRemoveLabel(targets) {
        const surfaces = new Set(targets.map(t => t.surface));
        if (surfaces.size === 1 && REMOVE_SURFACES[targets[0].surface]) {
            return JE.t(REMOVE_SURFACES[targets[0].surface].labelKey);
        }
        return JE.t('remove_button_text');
    }

    /**
     * Builds the Remove menu item for the multi-select menu, matching the menu's native items.
     * Removes every selected Continue Watching / Next Up card from its own surface.
     * @param {HTMLElement} scroller The multi-select menu's scroller.
     * @param {Array<{itemId: string, surface: string, card: Element}>} targets
     * @returns {HTMLElement}
     */
    function createMultiSelectRemoveButton(scroller, targets) {
        const button = buildNativeActionSheetItem(scroller, {
            dataId: 'je-multiselect-remove',
            icon: 'visibility_off',
            text: multiSelectRemoveLabel(targets)
        });
        const textEl = button.querySelector('.actionSheetItemText');

        button.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            // Recollect the selection at click time, not from the build-time closure: if the
            // sheet was reused after the selection changed, act on the CURRENT selection.
            const current = collectSelectedRemovableCards();
            if (!current.length) { closeOpenActionSheet(); exitSelectionMode(); return; }

            // Bulk removal (more than one item): close the menu and confirm first, listing each
            // item and the surface it'll be removed from, so the action is never a surprise.
            if (current.length > 1) {
                closeOpenActionSheet();
                const confirmed = await confirmMultiRemove(current);
                if (!confirmed) return; // selection kept so the user can adjust
                await performMultiRemove(current);
                return;
            }

            // Single item: remove directly with in-menu progress feedback.
            const originalText = textEl.textContent;
            button.disabled = true;
            textEl.textContent = JE.t('remove_button_removing');
            setActionSheetItemIcon(button, 'hourglass_empty');

            await performMultiRemove(current);

            button.disabled = false;
            textEl.textContent = originalText;
            setActionSheetItemIcon(button, 'visibility_off');
        });

        return button;
    }

    /**
     * Adds the Remove option to the multi-select / long-press menu when it is open and at
     * least one selected card is in Continue Watching or Next Up. Idempotent per menu.
     */
    JE.addMultiSelectRemoveButton = () => {
        if (!JE.currentSettings.removeContinueWatchingEnabled) return;

        const scroller = getActiveActionSheetScroller();
        if (!scroller) return;
        // "Select All" is unique to Jellyfin's multi-select menu — use it as the marker.
        if (!scroller.querySelector('[data-id="selectall"]')) return;
        if (scroller.querySelector('[data-id="je-multiselect-remove"]')) return;

        const targets = collectSelectedRemovableCards();
        if (!targets.length) return;

        const removeButton = createMultiSelectRemoveButton(scroller, targets);
        const anchor = scroller.querySelector('[data-id="refresh"]')
            || scroller.querySelector('[data-id="markunplayed"]')
            || scroller.querySelector('[data-id="markplayed"]');
        if (anchor) {
            anchor.after(removeButton);
        } else {
            scroller.appendChild(removeButton);
        }
        fitRemoveItemToMenu(removeButton, scroller);
    };

})(window.JellyfinEnhanced);
