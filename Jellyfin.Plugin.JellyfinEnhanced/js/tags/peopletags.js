// /js/tags/peopletags.js
// Jellyfin Enhanced People Tags - Show cast member information (birthplace, age, deceased status)
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
        const CACHE_TTL = (JE.pluginConfig?.PeopleTagsCacheTtlDays || 30) * 24 * 60 * 60 * 1000;

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

        let peopleCache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
        let peopleCacheTimestamp = JSON.parse(localStorage.getItem(CACHE_TIMESTAMP_KEY) || '{}');
        const Hot = (JE._hotCache = JE._hotCache || { ttl: CACHE_TTL });
        Hot.peopleTags = Hot.peopleTags || new Map();

        let processedCastMembers = new WeakSet();
        let processedPersonIds = new Set();
        let lastProcessedItemId = null;
        let isProcessing = false;

        // Inject styles for deceased indicators, overlay positioning, and material-symbols-rounded font
        function injectDeceasedStyles() {
            if (document.getElementById('je-people-tags-styles')) return;

            const style = document.createElement('style');
            style.id = 'je-people-tags-styles';
            style.textContent = `
                @import url('https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200');

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
            `;
            document.head.appendChild(style);
        }

        injectDeceasedStyles();

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
         * Fetch person info with caching
         * @param {string} personId
         * @param {string} itemId (optional, for calculating age at release)
         * @returns {Promise<object|null>}
         */
        async function getPersonInfo(personId, itemId = null) {
            const cacheKey = itemId ? `${personId}-${itemId}` : personId;
            const now = Date.now();

            // Check in-memory cache first
            if (Hot.peopleTags.has(cacheKey)) {
                const cached = Hot.peopleTags.get(cacheKey);
                if (now - cached.timestamp < CACHE_TTL) {
                    // console.debug(`${logPrefix} Using in-memory cache for person ${personId}`);
                    return cached.data;
                }
            }

            // Check localStorage cache
            if (peopleCache[cacheKey] && peopleCacheTimestamp[cacheKey]) {
                if (now - peopleCacheTimestamp[cacheKey] < CACHE_TTL) {
                    // console.debug(`${logPrefix} Using localStorage cache for person ${personId}`);
                    const data = peopleCache[cacheKey];
                    Hot.peopleTags.set(cacheKey, { data, timestamp: now });
                    return data;
                }
            }

            // Fetch from backend
            try {
                const queryString = itemId ? `?itemId=${itemId}` : '';
                const url = ApiClient.getUrl(`/JellyfinEnhanced/person/${personId}${queryString}`);
                const data = await ApiClient.ajax({
                    type: 'GET',
                    url: url,
                    dataType: 'json'
                });

                if (data) {
                    // Cache it
                    peopleCache[cacheKey] = data;
                    peopleCacheTimestamp[cacheKey] = now;
                    Hot.peopleTags.set(cacheKey, { data, timestamp: now });

                    localStorage.setItem(CACHE_KEY, JSON.stringify(peopleCache));
                    localStorage.setItem(CACHE_TIMESTAMP_KEY, JSON.stringify(peopleCacheTimestamp));

                    return data;
                }
            } catch (error) {
                console.warn(`${logPrefix} Failed to fetch person info for ${personId}:`, error);
            }

            return null;
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
                const ageChip = document.createElement('div');
                ageChip.className = 'je-people-age-chip je-people-age-deceased';
                ageChip.style.cssText = `
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    background: rgba(180, 50, 50, 0.85);
                    padding: 3px 8px;
                    border-radius: 3px;
                    font-size: 11px;
                    font-weight: 500;
                    color: white;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.3);
                `;

                const icon = document.createElement('span');
                icon.className = 'material-symbols-rounded je-people-age-icon';
                icon.textContent = 'event_busy';
                icon.style.cssText = 'font-size: 13px;';
                ageChip.appendChild(icon);

                const text = document.createElement('span');
                text.className = 'je-people-age-text';
                text.textContent = `${personData.ageAtDeath}y`;
                ageChip.appendChild(text);

                ageContainer.appendChild(ageChip);
            } else if (personData.currentAge !== null && personData.currentAge !== undefined) {
                const ageChip = document.createElement('div');
                ageChip.className = 'je-people-age-chip je-people-age-current';
                ageChip.style.cssText = `
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    background: rgba(100, 170, 100, 0.85);
                    padding: 3px 8px;
                    border-radius: 3px;
                    font-size: 11px;
                    font-weight: 500;
                    color: white;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.3);
                `;

                const icon = document.createElement('span');
                icon.className = 'material-symbols-rounded je-people-age-icon';
                icon.textContent = 'cake';
                icon.style.cssText = 'font-size: 13px;';
                ageChip.appendChild(icon);

                const text = document.createElement('span');
                text.className = 'je-people-age-text';
                text.textContent = `${personData.currentAge}y`;
                ageChip.appendChild(text);

                ageContainer.appendChild(ageChip);
            }

            // Age at item release chip
            if (personData.ageAtItemRelease !== null && personData.ageAtItemRelease !== undefined) {
                const releaseChip = document.createElement('div');
                releaseChip.className = 'je-people-age-chip je-people-age-release';
                releaseChip.style.cssText = `
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    background: rgba(70, 130, 180, 0.85);
                    padding: 3px 8px;
                    border-radius: 3px;
                    font-size: 11px;
                    font-weight: 500;
                    color: white;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.3);
                `;

                const icon = document.createElement('span');
                icon.className = 'material-symbols-rounded je-people-age-icon';
                icon.textContent = 'movie';
                icon.style.cssText = 'font-size: 13px;';
                releaseChip.appendChild(icon);

                const text = document.createElement('span');
                text.className = 'je-people-age-text';
                text.textContent = `${personData.ageAtItemRelease}y`;
                releaseChip.appendChild(text);

                ageContainer.appendChild(releaseChip);
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
                    flagImg.src = `https://flagcdn.com/w20/${countryCode.toLowerCase()}.png`;
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
         * Process a single cast/guest cast collapsible section
         * @param {string} collapsibleSelector - CSS selector for the collapsible (e.g., '#castCollapsible' or '#guestCastCollapsible')
         * @param {string} currentItemId - Current item ID from URL
         */
        async function processSingleCollapsible(collapsibleSelector, currentItemId) {
            const collapsible = document.querySelector(`#itemDetailPage:not(.hide) ${collapsibleSelector}`);
            if (!collapsible) return;

            const castCards = collapsible.querySelectorAll('.personCard');
            if (castCards.length === 0) return;

            console.debug(`${logPrefix} Found ${castCards.length} cast members in ${collapsibleSelector}`);

            for (const card of castCards) {
                if (processedCastMembers.has(card)) continue;
                processedCastMembers.add(card);

                const personId = card.getAttribute('data-id');
                if (!personId) continue;

                // Skip if we've already processed this person ID in this item
                if (processedPersonIds.has(personId)) continue;

                processedPersonIds.add(personId);

                try {
                    const personData = await getPersonInfo(personId, currentItemId);
                    if (!personData) {
                        continue;
                    }

                    // Apply deceased styling to poster if applicable
                    if (personData.isDeceased) {
                        card.classList.add('je-deceased-poster');
                        console.debug(`${logPrefix} Marked ${personId} as deceased`);
                    }

                    // Find the cardScalable element (image container with position: relative)
                    const cardScalable = card.querySelector('.cardScalable');
                    if (!cardScalable) {
                        console.warn(`${logPrefix} No cardScalable found for ${personId}`);
                        continue;
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

                // Process both cast and guest cast sections
                await processSingleCollapsible('#castCollapsible', currentItemId);
                await processSingleCollapsible('#guestCastCollapsible', currentItemId);

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
                        processedCastMembers = new WeakSet();
                        processedPersonIds = new Set();
                        console.debug(`${logPrefix} New item detected: ${itemId}`);
                    }

                    // Skip if already processing
                    if (isProcessing) {
                        return;
                    }

                    // Check if visible castCollapsible already has tags
                    if (castSection?.querySelector('.je-people-age-container, .je-people-place-banner') &&
                        guestCastSection?.querySelector('.je-people-age-container, .je-people-place-banner')) {
                        return;
                    }

                    // Process cast members for this item
                    processCastMembers();
                } catch (e) {
                    // Ignore errors (likely not on an item page)
                }
            }, 100);

            // Create managed observer for people tags (same pattern as features.js)
            JE.helpers.createObserver(
                'people-tags',
                (mutations) => {
                    if (!JE.currentSettings?.peopleTagsEnabled) return;

                    const castSection = document.querySelector('#itemDetailPage:not(.hide) #castCollapsible');
                    const guestCastSection = document.querySelector('#itemDetailPage:not(.hide) #guestCastCollapsible');

                    if (!castSection && !guestCastSection) return;

                    for (const mutation of mutations) {
                        if (mutation.type === 'childList' || mutation.type === 'attributes') {
                            handlePeopleTags();
                            break;
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

            console.debug(`${logPrefix} Initialization complete`);
        }

        initialize();
    };

})(window.JellyfinEnhanced || (window.JellyfinEnhanced = {}));
