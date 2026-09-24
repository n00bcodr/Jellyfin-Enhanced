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
        // The start of the cast row (what is on screen) is requested on its own
        // so those cards are tagged without waiting for the rest of the cast.
        const FIRST_CHUNK_SIZE = 8;
        // Extra attempts for a chunk that failed after the transport's retries.
        const RETRY_DELAYS_MS = [1000, 3000];
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

        /**
         * @param {*} value
         * @returns {boolean}
         */
        function isPlainObject(value) {
            return !!value && typeof value === 'object' && !Array.isArray(value);
        }

        /**
         * Read one persisted cache map. Missing -> {}; corrupt (unparseable or
         * not a plain object) throws so the caller can start clean.
         * @param {string} key
         * @returns {object}
         */
        function readPersistedMap(key) {
            const raw = localStorage.getItem(key);
            if (!raw) return {};
            const value = JSON.parse(raw);
            if (!isPlainObject(value)) throw new TypeError(`${key} is not an object`);
            return value;
        }

        let peopleCache = {};
        let peopleCacheTimestamp = {};
        try {
            peopleCache = readPersistedMap(CACHE_KEY);
            peopleCacheTimestamp = readPersistedMap(CACHE_TIMESTAMP_KEY);
        } catch (e) {
            console.warn(`${logPrefix} Discarding unreadable people cache`, e);
            peopleCache = {};
            peopleCacheTimestamp = {};
            try {
                localStorage.removeItem(CACHE_KEY);
                localStorage.removeItem(CACHE_TIMESTAMP_KEY);
            } catch (clearError) {
                console.warn(`${logPrefix} Failed to clear people cache`, clearError);
            }
        }
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

        // Cards that are done (rendered, or the server answered without that
        // person) and cards claimed by an in-flight request.
        let processedCastMembers = new WeakSet();
        let pendingCards = new WeakSet();
        // Cards whose request failed for good: not retried again this visit.
        let failedCards = new WeakSet();
        let lastProcessedItemId = null;
        let peopleTagsComplete = false; // Set true after all cast members tagged for current item
        let isProcessing = false;

        // One AbortController per detail item: aborted when the user navigates
        // to another item or switches account, so a late batch is discarded.
        // Re-init (settings toggle) aborts the previous instance's batch.
        const lifecycle = JE.core.lifecycle.register('people-tags');
        lifecycle.teardown();
        let batchController = null;
        // Retry waits are lifecycle-owned and cancelled with the batch.
        const retryWaits = new Set();
        function resetBatchController() {
            cancelRetryWaits();
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
            if (isPlainObject(peopleCache[cacheKey]) && typeof peopleCacheTimestamp[cacheKey] === 'number') {
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
         * @param {number} epoch
         * @returns {boolean} True while the identity that started a request is current.
         */
        function isCurrentEpoch(epoch) {
            return !JE.session || JE.session.isCurrent(epoch);
        }

        /**
         * Wait before retrying a chunk. Resolves false if the batch is reset
         * (navigation to another item, user switch) or the feature is torn down.
         * @param {number} ms
         * @returns {Promise<boolean>}
         */
        function waitForRetry(ms) {
            return new Promise((resolve) => {
                const wait = { timeoutId: 0, cancel: () => {} };
                const finish = (proceed) => {
                    if (!retryWaits.delete(wait)) return;
                    lifecycle.untrack(wait.cancel);
                    resolve(proceed);
                };
                wait.cancel = () => {
                    clearTimeout(wait.timeoutId);
                    finish(false);
                };
                wait.timeoutId = setTimeout(() => finish(true), ms);
                retryWaits.add(wait);
                lifecycle.track(wait.cancel);
            });
        }

        function cancelRetryWaits() {
            for (const wait of [...retryWaits]) wait.cancel();
        }

        /**
         * Release claimed cards without marking them done, so a later pass or
         * visit can pick them up again.
         * @param {Array<[string, Element[]]>} entries
         * @param {boolean} [failed=false] - Request gave up: skip for the rest of this visit.
         */
        function releaseCards(entries, failed = false) {
            for (const [, cards] of entries) {
                for (const card of cards) {
                    pendingCards.delete(card);
                    if (failed) failedCards.add(card);
                }
            }
        }

        /**
         * Fetch one chunk of people (retrying a failed request a bounded number
         * of times), cache the answers and render every card of each person.
         * @param {Array<[string, Element[]]>} chunk - [personId, cards] pairs
         * @param {string} itemId - Detail item (for age at release)
         * @param {AbortSignal} signal
         * @param {number} requestEpoch
         * @returns {Promise<boolean>} True when new data was cached.
         */
        async function fetchAndRenderChunk(chunk, itemId, signal, requestEpoch) {
            const ids = chunk.map(([personId]) => personId);
            const path = `/people/info?ids=${ids.map(encodeURIComponent).join(',')}&itemId=${encodeURIComponent(itemId)}`;

            let response = null;
            for (let attempt = 0; ; attempt++) {
                try {
                    response = await JE.core.api.plugin(path, { signal });
                    break;
                } catch (error) {
                    if (signal.aborted) {
                        releaseCards(chunk);
                        return false;
                    }
                    // A client error (bad request, auth) would fail the same way again.
                    const status = Number(error?.status) || 0;
                    const retryable = !status || status >= 500 || status === 408 || status === 429;
                    if (!retryable || attempt >= RETRY_DELAYS_MS.length) {
                        console.warn(`${logPrefix} Failed to fetch person info for ${ids.length} people:`, error);
                        releaseCards(chunk, true);
                        return false;
                    }
                    console.debug(`${logPrefix} Person info request failed, retrying in ${RETRY_DELAYS_MS[attempt]}ms`, error);
                    if (!(await waitForRetry(RETRY_DELAYS_MS[attempt])) || signal.aborted) {
                        releaseCards(chunk);
                        return false;
                    }
                }
            }

            // A response resolving after a user switch or navigation to another
            // item must not be cached under the new identity or rendered.
            if (signal.aborted || !isCurrentEpoch(requestEpoch) || lastProcessedItemId !== itemId) {
                releaseCards(chunk);
                return false;
            }

            const people = isPlainObject(response?.people) ? response.people : {};
            const paint = !!JE.currentSettings?.peopleTagsEnabled;
            const now = Date.now();
            let cached = false;
            for (const [personId, cards] of chunk) {
                const data = people[normalizeId(personId)];
                if (isPlainObject(data)) {
                    const cacheKey = `${personId}-${itemId}`;
                    peopleCache[cacheKey] = data;
                    peopleCacheTimestamp[cacheKey] = now;
                    Hot.peopleTags.set(cacheKey, { data, timestamp: now });
                    cached = true;
                }
                for (const card of cards) {
                    pendingCards.delete(card);
                    if (!paint) continue;
                    if (isPlainObject(data)) renderPersonCard(card, personId, data);
                    processedCastMembers.add(card);
                }
            }
            return cached;
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
         * Claim not-yet-processed cards from the cast and guest cast sections
         * in one pass, grouped by person (a person can have several cards,
         * e.g. actor and director, or cast and guest cast). DOM order is kept.
         * @returns {Map<string, Element[]>}
         */
        function collectPendingCards() {
            const groups = new Map();
            for (const collapsibleSelector of ['#castCollapsible', '#guestCastCollapsible']) {
                const collapsible = document.querySelector(`#itemDetailPage:not(.hide) ${collapsibleSelector}`);
                if (!collapsible) continue;

                const castCards = collapsible.querySelectorAll('.personCard');
                if (castCards.length === 0) continue;

                console.debug(`${logPrefix} Found ${castCards.length} cast members in ${collapsibleSelector}`);

                for (const card of castCards) {
                    if (processedCastMembers.has(card) || pendingCards.has(card) || failedCards.has(card)) continue;

                    const personId = card.getAttribute('data-id');
                    if (!personId) continue;

                    pendingCards.add(card);
                    const cards = groups.get(personId);
                    if (cards) cards.push(card);
                    else groups.set(personId, [card]);
                }
            }
            return groups;
        }

        /**
         * Render cached people immediately, then fetch the misses: the first
         * FIRST_CHUNK_SIZE people (start of the row) and the rest (in
         * BATCH_SIZE chunks) in parallel, rendering each chunk as it returns.
         * @param {Map<string, Element[]>} groups
         * @param {string} currentItemId
         * @param {AbortSignal} signal
         */
        async function processPendingCards(groups, currentItemId, signal) {
            const entries = [...groups];
            // Feature switched off: paint nothing.
            if (!JE.currentSettings?.peopleTagsEnabled) {
                releaseCards(entries);
                return;
            }

            const now = Date.now();
            const misses = [];
            for (const entry of entries) {
                const [personId, cards] = entry;
                const cached = getCachedPersonInfo(`${personId}-${currentItemId}`, now);
                if (!cached) {
                    misses.push(entry);
                    continue;
                }
                for (const card of cards) {
                    renderPersonCard(card, personId, cached);
                    pendingCards.delete(card);
                    processedCastMembers.add(card);
                }
            }
            if (misses.length === 0) return;

            const chunks = [misses.slice(0, FIRST_CHUNK_SIZE)];
            for (let i = FIRST_CHUNK_SIZE; i < misses.length; i += BATCH_SIZE) {
                chunks.push(misses.slice(i, i + BATCH_SIZE));
            }

            const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
            const results = await Promise.all(chunks.map(chunk => fetchAndRenderChunk(chunk, currentItemId, signal, requestEpoch)));
            // One localStorage write per batch, once every chunk has settled.
            if (results.some(Boolean) && isCurrentEpoch(requestEpoch)) persistPeopleCache();
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
                for (let pass = 0; pass < MAX_PASSES && JE.currentSettings?.peopleTagsEnabled; pass++) {
                    const pending = collectPendingCards();
                    if (pending.size === 0) break;
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
                if (!JE.currentSettings?.peopleTagsEnabled) return;
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
                        pendingCards = new WeakSet();
                        failedCards = new WeakSet();
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

            // The cast may already be on screen (feature enabled from the
            // settings panel, or JE loaded after the detail page rendered).
            handlePeopleTags();

            console.debug(`${logPrefix} Initialization complete`);
        }

        initialize();
    };

})(window.JellyfinEnhanced || (window.JellyfinEnhanced = {}));
