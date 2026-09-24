// /js/tags/peopletags.js
// Jellyfin Enhanced People Tags - Show cast member information (birthplace, age, deceased status)
//
// NOTE: unlike the poster tag modules, this one is NOT a tag-pipeline
// renderer — it targets person cards on the item detail page with its own
// managed observer and batch backend endpoint (people/info), so the
// tag-renderer factory does not apply here.
(function(JE) {
    'use strict';

    JE.initializePeopleTags = function() {
        if (!JE.currentSettings.peopleTagsEnabled) {
            console.log('🪼 Jellyfin Enhanced: People Tags: Feature is disabled in settings.');
            return;
        }

        const logPrefix = '🪼 Jellyfin Enhanced: People Tags:';
        const CACHE_KEY = 'JellyfinEnhanced-peopleTagsCache';
        const CACHE_TIMESTAMP_KEY = 'JellyfinEnhanced-peopleTagsCacheTimestamp';
        const CACHE_TTL = (JE.pluginConfig?.TagsCacheTtlDays || 30) * 24 * 60 * 60 * 1000;
        // Must not exceed the server's people/info cap (MaxPeopleInfoBatchSize).
        const BATCH_SIZE = 100;
        // Follow-up batches for cards that mount while a batch is in flight.
        const MAX_PASSES = 5;

        // Country mapping dictionary
        const COUNTRY_MAP = {
            'United States': 'US', 'USA': 'US', 'America': 'US',
            'United Kingdom': 'GB', 'UK': 'GB', 'England': 'GB', 'Scotland': 'GB', 'Wales': 'GB',
            'Canada': 'CA', 'Australia': 'AU', 'New Zealand': 'NZ',
            'Germany': 'DE', 'France': 'FR', 'Italy': 'IT', 'Spain': 'ES',
            'Mexico': 'MX', 'Brazil': 'BR', 'Argentina': 'AR',
            'Japan': 'JP', 'South Korea': 'KR', 'China': 'CN',
            'India': 'IN', 'Russia': 'RU', 'Sweden': 'SE',
            'Norway': 'NO', 'Denmark': 'DK', 'Finland': 'FI',
            'Netherlands': 'NL', 'Belgium': 'BE', 'Austria': 'AT',
            'Switzerland': 'CH', 'Poland': 'PL', 'Czech Republic': 'CZ',
            'Czechia': 'CZ', 'Greece': 'GR', 'Portugal': 'PT',
            'Turkey': 'TR', 'Israel': 'IL', 'South Africa': 'ZA',
            'Chile': 'CL', 'Colombia': 'CO', 'Peru': 'PE',
            'Thailand': 'TH', 'Malaysia': 'MY', 'Singapore': 'SG',
            'Philippines': 'PH', 'Indonesia': 'ID', 'Vietnam': 'VN',
            'Ukraine': 'UA', 'Iran': 'IR', 'Ireland': 'IE',
            'Hungary': 'HU', 'Romania': 'RO', 'Bulgaria': 'BG',
            'Croatia': 'HR', 'Serbia': 'RS', 'Slovenia': 'SI',
            'Estonia': 'EE', 'Latvia': 'LV', 'Lithuania': 'LT', 'Iceland': 'IS',
            'Luxembourg': 'LU', 'Monaco': 'MC', 'Liechtenstein': 'LI',
            'Malta': 'MT', 'Cyprus': 'CY',
            'Slovakia': 'SK', 'Bosnia and Herzegovina': 'BA', 'Bosnia': 'BA',
            'North Macedonia': 'MK', 'Macedonia': 'MK', 'Albania': 'AL',
            'Montenegro': 'ME', 'Moldova': 'MD', 'Belarus': 'BY',
            'Kosovo': 'XK', 'Georgia': 'GE', 'Armenia': 'AM', 'Azerbaijan': 'AZ',
            'Saudi Arabia': 'SA', 'United Arab Emirates': 'AE', 'UAE': 'AE',
            'Qatar': 'QA', 'Kuwait': 'KW', 'Bahrain': 'BH', 'Oman': 'OM',
            'Jordan': 'JO', 'Lebanon': 'LB', 'Egypt': 'EG', 'Iraq': 'IQ',
            'Syria': 'SY', 'Yemen': 'YE', 'Palestine': 'PS',
            'Pakistan': 'PK', 'Bangladesh': 'BD', 'Sri Lanka': 'LK', 'Nepal': 'NP',
            'Taiwan': 'TW', 'Hong Kong': 'HK', 'Macau': 'MO',
            'Kazakhstan': 'KZ', 'Uzbekistan': 'UZ', 'Afghanistan': 'AF',
            'Mongolia': 'MN', 'Myanmar': 'MM', 'Cambodia': 'KH', 'Laos': 'LA',
            'Venezuela': 'VE', 'Ecuador': 'EC', 'Uruguay': 'UY', 'Paraguay': 'PY',
            'Bolivia': 'BO', 'Costa Rica': 'CR', 'Panama': 'PA', 'Nicaragua': 'NI',
            'Honduras': 'HN', 'El Salvador': 'SV', 'Guatemala': 'GT', 'Belize': 'BZ',
            'Cuba': 'CU', 'Jamaica': 'JM', 'Dominican Republic': 'DO',
            'Puerto Rico': 'PR', 'Trinidad and Tobago': 'TT', 'Barbados': 'BB',
            'Haiti': 'HT', 'Bahamas': 'BS', 'Guyana': 'GY', 'Suriname': 'SR',
            'Nigeria': 'NG', 'Kenya': 'KE', 'Ghana': 'GH', 'Ethiopia': 'ET',
            'Morocco': 'MA', 'Algeria': 'DZ', 'Tunisia': 'TN', 'Libya': 'LY',
            'Senegal': 'SN', 'Uganda': 'UG', 'Tanzania': 'TZ', 'Zimbabwe': 'ZW',
            'Zambia': 'ZM', 'Botswana': 'BW', 'Namibia': 'NA', 'Angola': 'AO',
            'Mozambique': 'MZ', 'Madagascar': 'MG', 'Cameroon': 'CM',
            'Ivory Coast': 'CI', "Côte d'Ivoire": 'CI', 'Mali': 'ML', 'Burkina Faso': 'BF',
            'Papua New Guinea': 'PG', 'Fiji': 'FJ', 'Samoa': 'WS', 'Tonga': 'TO'
        };

        // People metadata is fetched with the signed-in user's library access.
        // The cache key names are frozen, so ownership is tracked via a
        // sibling sentinel (same pattern as core/tag-renderer-base.js): a
        // payload written by a different server:user — or a legacy payload
        // with no sentinel — is dropped instead of being served cross-user.
        const OWNER_KEY = `${CACHE_KEY}IdentityOwner`;
        try {
            const owner = `${JE.session?.getServerId() || ''}:${JE.session?.getUserId() || ApiClient.getCurrentUserId() || ''}`;
            if (localStorage.getItem(OWNER_KEY) !== owner) {
                localStorage.removeItem(CACHE_KEY);
                localStorage.removeItem(CACHE_TIMESTAMP_KEY);
                localStorage.setItem(OWNER_KEY, owner);
            }
        } catch (e) {
            console.warn(`${logPrefix} cache ownership check failed`, e);
        }

        let peopleCache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
        let peopleCacheTimestamp = JSON.parse(localStorage.getItem(CACHE_TIMESTAMP_KEY) || '{}');
        const Hot = (JE._hotCache = JE._hotCache || { ttl: CACHE_TTL });
        Hot.peopleTags = Hot.peopleTags || new Map();

        // Full wipe on user switch; the new owner is stamped immediately so
        // the next boot doesn't wipe the new user's cache a second time.
        JE.session?.onUserChange('people-tags', (change) => {
            // In-flight batches belong to the previous user.
            resetBatchController();
            peopleCache = {};
            peopleCacheTimestamp = {};
            Hot.peopleTags.clear();
            try {
                localStorage.removeItem(CACHE_KEY);
                localStorage.removeItem(CACHE_TIMESTAMP_KEY);
                localStorage.setItem(OWNER_KEY, `${change.serverId || ''}:${change.userId || ''}`);
            } catch (e) {
                console.warn(`${logPrefix} cache clear on user switch failed`, e);
            }
        });

        let processedCastMembers = new WeakSet();
        let processedPersonIds = new Set();
        let lastProcessedItemId = null;
        let peopleTagsComplete = false; // Set true after all cast members tagged for current item
        let isProcessing = false;

        // One AbortController per detail item: aborted when the user navigates
        // to another item or switches account, so a late batch is discarded.
        // Re-init (settings toggle) aborts the previous instance's batch.
        const lifecycle = JE.core.lifecycle.register('people-tags');
        lifecycle.teardown();
        let batchController = null;
        function resetBatchController() {
            if (batchController) {
                batchController.abort();
                lifecycle.untrack(batchController);
            }
            batchController = lifecycle.track(new AbortController());
            return batchController;
        }

        // Styles for deceased indicators, overlay positioning, and material-symbols-rounded font
        JE.core.ui.injectCss('je-people-tags-styles', `
            @font-face {
                font-family: 'Material Symbols Rounded';
                font-style: normal;
                font-weight: 100 700;
                font-display: block;
                src: url(${JE.cdn.font('materialsymbolsrounded.woff2')}) format('woff2');
            }

            .material-symbols-rounded {
                font-family: 'Material Symbols Rounded';
                font-weight: normal;
                font-style: normal;
                font-size: 24px;
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

            /* Ensure cardScalable has position: relative for absolute positioned overlays */
            #castCollapsible .personCard .cardScalable {
                position: relative;
            }

            /* Deceased poster styling */
            .je-deceased-poster .cardImageContainer {
                filter: grayscale(100%) opacity(0.7);
            }

            .je-deceased-poster .cardScalable::after {
                content: "✝";
                position: absolute;
                top: 8px;
                right: 8px;
                z-index: 3;
                color: white;
                font-weight: bold;
                font-size: 2em;
                text-shadow: 0 0 4px black;
                pointer-events: none;
            }

            /* People tag banner styling */
            .je-people-tag-banner {
                max-width: 100%;
                box-sizing: border-box;
            }
        `);

        console.log(`${logPrefix} Initialized`);

        /**
         * Extract country code from birthplace string
         * @param {string} placeString - Full birthplace string like "London, England, UK"
         * @returns {string|null} - ISO 3166-1 alpha-2 country code or null
         */
        function getCountryCodeFromBirthPlace(placeString) {
            if (!placeString || typeof placeString !== 'string') return null;

            // Split by comma and take the last part (country is typically last)
            const parts = placeString.split(',').map(p => p.trim());
            if (parts.length === 0) return null;

            const lastPart = parts[parts.length - 1];

            // Check if it matches any country name (case-insensitive)
            for (const [countryName, code] of Object.entries(COUNTRY_MAP)) {
                if (countryName.toLowerCase() === lastPart.toLowerCase()) {
                    return code;
                }
            }

            return null;
        }

        /**
         * Canonical form of a person id (server keys use the 32-hex "N" form).
         * @param {string} id
         * @returns {string}
         */
        function normalizeId(id) {
            return String(id).toLowerCase().replace(/-/g, '');
        }

        /**
         * Hot/localStorage cache lookup for one person.
         * @param {string} cacheKey - `${personId}-${itemId}` (or personId)
         * @param {number} now
         * @returns {object|null}
         */
        function getCachedPersonInfo(cacheKey, now) {
            // Check in-memory cache first
            if (Hot.peopleTags.has(cacheKey)) {
                const cached = Hot.peopleTags.get(cacheKey);
                if (now - cached.timestamp < CACHE_TTL) {
                    return cached.data;
                }
            }

            // Check localStorage cache
            if (peopleCache[cacheKey] && peopleCacheTimestamp[cacheKey]) {
                if (now - peopleCacheTimestamp[cacheKey] < CACHE_TTL) {
                    const data = peopleCache[cacheKey];
                    Hot.peopleTags.set(cacheKey, { data, timestamp: now });
                    return data;
                }
            }

            return null;
        }

        /** Persist both cache maps (once per batch, not per person). */
        function persistPeopleCache() {
            try {
                localStorage.setItem(CACHE_KEY, JSON.stringify(peopleCache));
                localStorage.setItem(CACHE_TIMESTAMP_KEY, JSON.stringify(peopleCacheTimestamp));
            } catch (e) {
                console.warn(`${logPrefix} Failed to persist people cache`, e);
            }
        }

        /**
         * Fetch person info for many people in one request per BATCH_SIZE ids.
         * @param {string[]} personIds - Unique, uncached person ids
         * @param {string} itemId - Detail item (for age at release)
         * @param {AbortSignal} signal
         * @returns {Promise<Map<string, object>>} personId -> person info; ids the
         *   server did not return are absent. Empty when the response is stale.
         */
        async function fetchPeopleInfo(personIds, itemId, signal) {
            const results = new Map();
            if (personIds.length === 0) return results;

            // A response resolving after a user switch must not be written
            // under the NEW user's identity-owner sentinel or rendered.
            const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
            const chunks = [];
            for (let i = 0; i < personIds.length; i += BATCH_SIZE) {
                chunks.push(personIds.slice(i, i + BATCH_SIZE));
            }

            const responses = await Promise.all(chunks.map(async (chunk) => {
                const query = `ids=${chunk.map(encodeURIComponent).join(',')}&itemId=${encodeURIComponent(itemId)}`;
                try {
                    return await JE.core.api.plugin(`/people/info?${query}`, { signal });
                } catch (error) {
                    if (!signal.aborted) {
                        console.warn(`${logPrefix} Failed to fetch person info for ${chunk.length} people:`, error);
                    }
                    return null;
                }
            }));

            if (signal.aborted || (JE.session && !JE.session.isCurrent(requestEpoch))) {
                return new Map();
            }

            const now = Date.now();
            responses.forEach((response, index) => {
                const people = response && typeof response.people === 'object' && !Array.isArray(response.people)
                    ? response.people : null;
                if (!people) return;
                for (const personId of chunks[index]) {
                    const data = people[normalizeId(personId)];
                    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
                    const cacheKey = `${personId}-${itemId}`;
                    peopleCache[cacheKey] = data;
                    peopleCacheTimestamp[cacheKey] = now;
                    Hot.peopleTags.set(cacheKey, { data, timestamp: now });
                    results.set(personId, data);
                }
            });

            if (results.size > 0) persistPeopleCache();
            return results;
        }

        /**
         * Create one age chip (deceased / current / at-release share markup).
         * @param {string} variant - Suffix for the chip class (deceased|current|release)
         * @param {string} background - Chip background color
         * @param {string} iconName - Material Symbols icon name
         * @param {number} age - Age value to display
         * @returns {HTMLElement}
         */
        function createAgeChip(variant, background, iconName, age) {
            const ageChip = document.createElement('div');
            ageChip.className = `je-people-age-chip je-people-age-${variant}`;
            ageChip.style.cssText = `
                display: flex;
                align-items: center;
                gap: 4px;
                background: ${background};
                padding: 3px 8px;
                border-radius: 3px;
                font-size: 11px;
                font-weight: 500;
                color: white;
                box-shadow: 0 1px 3px rgba(0,0,0,0.3);
            `;

            const icon = document.createElement('span');
            icon.className = 'material-symbols-rounded je-people-age-icon';
            icon.textContent = iconName;
            icon.style.cssText = 'font-size: 13px;';
            ageChip.appendChild(icon);

            const text = document.createElement('span');
            text.className = 'je-people-age-text';
            text.textContent = `${age}y`;
            ageChip.appendChild(text);

            return ageChip;
        }

        /**
         * Create people tag chips in top-left corner and birthplace banner at bottom
         * @param {object} personData
         * @returns {object} Object with ageContainer and placeContainer elements
         */
        function createPeopleTag(personData) {
            // Age chips container (top-left)
            const ageContainer = document.createElement('div');
            ageContainer.className = 'je-people-age-container';
            ageContainer.style.cssText = `
                position: absolute;
                top: 8px;
                left: 8px;
                display: flex;
                flex-direction: column;
                gap: 4px;
                align-items: flex-start;
                z-index: 3;
                pointer-events: none;
            `;

            // Current age or age at death chip
            if (personData.isDeceased && personData.ageAtDeath !== null && personData.ageAtDeath !== undefined) {
                ageContainer.appendChild(createAgeChip('deceased', 'rgba(180, 50, 50, 0.85)', 'event_busy', personData.ageAtDeath));
            } else if (personData.currentAge !== null && personData.currentAge !== undefined) {
                ageContainer.appendChild(createAgeChip('current', 'rgba(100, 170, 100, 0.85)', 'cake', personData.currentAge));
            }

            // Age at item release chip
            if (personData.ageAtItemRelease !== null && personData.ageAtItemRelease !== undefined) {
                ageContainer.appendChild(createAgeChip('release', 'rgba(70, 130, 180, 0.85)', 'movie', personData.ageAtItemRelease));
            }

            // Birthplace banner (bottom of card)
            const placeContainer = document.createElement('div');
            placeContainer.className = 'je-people-place-banner';
            placeContainer.style.cssText = `
                position: absolute;
                bottom: 0;
                left: 0;
                right: 0;
                background: linear-gradient(to top, rgba(0,0,0,0.9), rgba(0,0,0,0.7), transparent);
                padding: 12px 8px 8px 8px;
                display: flex;
                align-items: center;
                gap: 6px;
                font-size: 11px;
                color: white;
                z-index: 1;
                pointer-events: none;
            `;

            if (personData.birthPlace) {
                // Extract country code from birthplace
                const countryCode = getCountryCodeFromBirthPlace(personData.birthPlace);

                // Use flagcdn for country flags
                if (countryCode) {
                    const flagImg = document.createElement('img');
                    flagImg.className = 'je-people-flag';
                    flagImg.src = JE.cdn.flagPng(countryCode);
                    flagImg.style.cssText = 'width: 16px; height: 12px; border-radius: 2px; object-fit: cover;';
                    flagImg.alt = countryCode;
                    placeContainer.appendChild(flagImg);
                }

                const locationIcon = document.createElement('span');
                locationIcon.className = 'material-symbols-rounded je-people-place-icon';
                locationIcon.textContent = 'place';
                locationIcon.style.cssText = 'font-size: 14px; opacity: 0.9;';
                placeContainer.appendChild(locationIcon);

                const placeText = document.createElement('span');
                placeText.className = 'je-people-place-text';
                placeText.textContent = personData.birthPlace;
                placeText.style.cssText = 'overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; opacity: 0.95;';
                placeText.title = personData.birthPlace;
                placeContainer.appendChild(placeText);
            }

            return { ageContainer, placeContainer };
        }

        /**
         * Decorate one cast card with the person's tags.
         * @param {Element} card
         * @param {string} personId
         * @param {object} personData
         */
        function renderPersonCard(card, personId, personData) {
            try {
                // Apply deceased styling to poster if applicable
                if (personData.isDeceased) {
                    card.classList.add('je-deceased-poster');
                    console.debug(`${logPrefix} Marked ${personId} as deceased`);
                }

                // Find the cardScalable element (image container with position: relative)
                const cardScalable = card.querySelector('.cardScalable');
                if (!cardScalable) {
                    console.warn(`${logPrefix} No cardScalable found for ${personId}`);
                    return;
                }

                // Remove existing tags if any
                const existingAgeContainer = cardScalable.querySelector('.je-people-age-container');
                if (existingAgeContainer) {
                    existingAgeContainer.remove();
                }
                const existingPlaceBanner = cardScalable.querySelector('.je-people-place-banner');
                if (existingPlaceBanner) {
                    existingPlaceBanner.remove();
                }

                // Create and append age chips (top-left) and place banner (bottom)
                const tags = createPeopleTag(personData);
                if (tags.ageContainer.children.length > 0) {
                    cardScalable.appendChild(tags.ageContainer);
                }
                if (tags.placeContainer.children.length > 0) {
                    cardScalable.appendChild(tags.placeContainer);
                }
            } catch (error) {
                console.warn(`${logPrefix} Error processing cast member ${personId}:`, error);
            }
        }

        /**
         * Collect not-yet-processed cards from the cast and guest cast
         * sections in one pass (one card per person id per item, as before).
         * @returns {Array<{card: Element, personId: string}>}
         */
        function collectPendingCards() {
            const pending = [];
            for (const collapsibleSelector of ['#castCollapsible', '#guestCastCollapsible']) {
                const collapsible = document.querySelector(`#itemDetailPage:not(.hide) ${collapsibleSelector}`);
                if (!collapsible) continue;

                const castCards = collapsible.querySelectorAll('.personCard');
                if (castCards.length === 0) continue;

                console.debug(`${logPrefix} Found ${castCards.length} cast members in ${collapsibleSelector}`);

                for (const card of castCards) {
                    if (processedCastMembers.has(card)) continue;
                    processedCastMembers.add(card);

                    const personId = card.getAttribute('data-id');
                    if (!personId) continue;

                    // Skip if we've already processed this person ID in this item
                    if (processedPersonIds.has(personId)) continue;

                    processedPersonIds.add(personId);
                    pending.push({ card, personId });
                }
            }
            return pending;
        }

        /**
         * Render cached cards immediately, fetch every miss in one batch,
         * then render the rest.
         * @param {Array<{card: Element, personId: string}>} pending
         * @param {string} currentItemId
         * @param {AbortSignal} signal
         */
        async function processPendingCards(pending, currentItemId, signal) {
            const now = Date.now();
            const misses = [];
            for (const entry of pending) {
                const cached = getCachedPersonInfo(`${entry.personId}-${currentItemId}`, now);
                if (cached) {
                    renderPersonCard(entry.card, entry.personId, cached);
                } else {
                    misses.push(entry);
                }
            }
            if (misses.length === 0) return;

            const fetched = await fetchPeopleInfo(misses.map(entry => entry.personId), currentItemId, signal);
            if (signal.aborted || lastProcessedItemId !== currentItemId) return;

            for (const entry of misses) {
                const personData = fetched.get(entry.personId);
                if (personData) renderPersonCard(entry.card, entry.personId, personData);
            }
        }

        /**
         * Process cast and guest cast members in the current view
         */
        async function processCastMembers() {
            if (isProcessing) return;
            isProcessing = true;

            try {
                // Get current item ID from URL
                const hash = window.location.hash;
                const params = new URLSearchParams(hash.split('?')[1]);
                const currentItemId = params.get('id');

                if (!currentItemId) {
                    console.debug(`${logPrefix} No item ID found in URL`);
                    return;
                }

                const signal = (batchController || resetBatchController()).signal;

                // Cast and guest cast share one batch; cards that mount while
                // a batch is in flight are picked up by a small follow-up batch.
                for (let pass = 0; pass < MAX_PASSES; pass++) {
                    const pending = collectPendingCards();
                    if (pending.length === 0) break;
                    await processPendingCards(pending, currentItemId, signal);
                    if (signal.aborted || lastProcessedItemId !== currentItemId) break;
                }

            } catch (error) {
                console.error(`${logPrefix} Error in processCastMembers:`, error);
            } finally {
                isProcessing = false;
            }
        }

        /**
         * Main initialization using proper page navigation hooks
         */
        function initialize() {
            console.debug(`${logPrefix} Initializing with managed observer pattern`);

            // Handle item details page display with debounced observer (same pattern as features.js)
            const handlePeopleTags = JE.helpers.debounce(() => {
                const castSection = document.querySelector('#itemDetailPage:not(.hide) #castCollapsible');
                const guestCastSection = document.querySelector('#itemDetailPage:not(.hide) #guestCastCollapsible');

                if (!castSection && !guestCastSection) return;

                try {
                    const itemId = new URLSearchParams(window.location.hash.split('?')[1]).get('id');
                    if (!itemId) return;

                    // Reset cache when navigating to a new item
                    if (lastProcessedItemId !== itemId) {
                        lastProcessedItemId = itemId;
                        resetBatchController();
                        processedCastMembers = new WeakSet();
                        processedPersonIds = new Set();
                        peopleTagsComplete = false;
                        console.debug(`${logPrefix} New item detected: ${itemId}`);
                    }

                    // Skip if already fully processed for this item
                    if (peopleTagsComplete || isProcessing) {
                        return;
                    }

                    // Process cast members for this item, then mark complete
                    // after a short delay to allow late-arriving DOM updates.
                    // Capture the itemId so stale completions from previous
                    // navigations don't mark the wrong item as done.
                    const processingItemId = itemId;
                    processCastMembers().then(() => {
                        // Another item arrived while this batch was in flight
                        // (its run was skipped by isProcessing): process it now.
                        if (lastProcessedItemId !== processingItemId) {
                            handlePeopleTags();
                            return;
                        }
                        setTimeout(() => {
                            if (lastProcessedItemId === processingItemId) {
                                peopleTagsComplete = true;
                            }
                        }, 2000);
                    });
                } catch (e) {
                    // Ignore errors (likely not on an item page)
                }
            }, 100);

            // Create managed observer for people tags.
            // Only watches childList (not attributes) to avoid firing on every hover
            // class/style change. Cast sections appear via childList mutations.
            JE.helpers.createObserver(
                'people-tags',
                (mutations) => {
                    if (!JE.currentSettings?.peopleTagsEnabled) return;

                    // Reset completion flag when navigating to a different item
                    // (must happen BEFORE the peopleTagsComplete check)
                    try {
                        const currentId = new URLSearchParams(window.location.hash.split('?')[1]).get('id');
                        if (currentId && currentId !== lastProcessedItemId) {
                            peopleTagsComplete = false;
                        }
                    } catch {}

                    if (peopleTagsComplete) return;

                    // Quick check: only process if we're on a detail page
                    if (!document.querySelector('#itemDetailPage:not(.hide)')) return;

                    // Only react to actual node additions, not attribute changes
                    let hasNewNodes = false;
                    for (const mutation of mutations) {
                        if (mutation.addedNodes.length > 0) {
                            hasNewNodes = true;
                            break;
                        }
                    }
                    if (!hasNewNodes) return;

                    const castSection = document.querySelector('#itemDetailPage:not(.hide) #castCollapsible');
                    const guestCastSection = document.querySelector('#itemDetailPage:not(.hide) #guestCastCollapsible');
                    if (!castSection && !guestCastSection) return;

                    handlePeopleTags();
                },
                document.body,
                {
                    childList: true,
                    subtree: true
                }
            );

            console.debug(`${logPrefix} Initialization complete`);
        }

        initialize();
    };

})(window.JellyfinEnhanced || (window.JellyfinEnhanced = {}));
