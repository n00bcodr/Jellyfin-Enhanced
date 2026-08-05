/**
 * @file Details-page media-info chips: watch progress, file size and audio languages.
 * Split from features.js (code motion; bodies verbatim).
 */
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.features = JE.internals.features || {};

    // In-memory cache to avoid repeated fetches when data is unavailable or unchanged
    const WATCHPROGRESS_CACHE_TTL = 60 * 60 * 1000; // 1 hour
    const FILESIZE_CACHE_TTL = 60 * 60 * 1000; // 1 hour
    const LANGUAGE_CACHE_TTL = 60 * 60 * 1000; // 1 hour
    const watchProgressCache = new Map(); // Map<itemId, { progress: number, totalPlaybackTicks: number, totalRuntimeTicks: number, ts: number }>
    const fileSizeCache = new Map(); // Map<itemId, { size: number|null, unavailable: boolean, ts: number }>
    const audioLanguageCache = new Map(); // Map<itemId, { languages: Array, unavailable: boolean, ts: number }>

    // Watch progress is per-user (and item metadata is fetched with the
    // signed-in user's access) — never carry it across a user switch.
    JE.session?.onUserChange('details-media-info', () => {
        watchProgressCache.clear();
        fileSizeCache.clear();
        audioLanguageCache.clear();
    });

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

            // Watch progress is per-user: a response resolving after a user
            // switch must not repopulate the cache that was just reset.
            const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
            const isCurrent = () => !JE.session || JE.session.isCurrent(requestEpoch);
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
                // A stale response must neither render (the DOM now belongs
                // to the new user's session) nor be cached.
                if (!isCurrent()) return;
                placeholder.innerHTML = getIconSpan(watchProgress.progress);
                placeholder.appendChild(getWatchProgressValue(watchProgress));

                watchProgressCache.set(itemId, watchProgress);
            } catch (error) {
                console.error('🪼 Jellyfin Enhanced: Error fetching watch progress for ID %s:', itemId, error);
                if (!isCurrent()) return;
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
                    flag.src = JE.cdn.flagSvg(countryCode);
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

    // Shared with the details-page dispatcher (features-details-page.js).
    internal.displayWatchProgress = displayWatchProgress;
    internal.displayItemSize = displayItemSize;
    internal.displayAudioLanguages = displayAudioLanguages;

})(window.JellyfinEnhanced);
