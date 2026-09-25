// /js/tags/peopletags.js
// Jellyfin Enhanced People Tags - Show cast member information (birthplace, age, deceased status)
//
// NOTE: unlike the poster tag modules, this one is NOT a tag-pipeline
// renderer — it targets person cards on the item detail page with its own
// managed observer and batch backend endpoint (people/info), so the
// tag-renderer factory does not apply here. Facts are cached per person and
// ages are derived locally, so episodes of a series share their cast.
(function(JE) {
    'use strict';

    // ── Person facts model (pure) ──────────────────────────────────────────
    // The cache holds item-independent facts per person; every age is
    // derived at render time with the server's CalculateAge semantics, so a
    // series' recurring cast is fetched once and shared by all episodes.
    // "Today" is the browser's local date (the server used its own clock), so
    // values can differ by a day around midnight across timezones; that is
    // acceptable, and more current than the previous 30-day cached value.

    const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/;
    const PERSON_ID_PATTERN = /^[0-9a-f]{32}$/;
    const MAX_BIRTHPLACE_LENGTH = 300;

    function isLeapYear(year) {
        return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    }

    function daysInMonth(year, month) {
        return month === 2 ? (isLeapYear(year) ? 29 : 28) : [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    }

    /**
     * Parse the calendar date of 'yyyy-MM-dd' (optionally followed by a time
     * part, e.g. a Jellyfin PremiereDate) without any timezone conversion.
     * @param {*} value
     * @returns {{y: number, m: number, d: number}|null}
     */
    function parseCalendarDate(value) {
        if (typeof value !== 'string') return null;
        const match = DATE_PATTERN.exec(value);
        if (!match) return null;
        const y = Number(match[1]);
        const m = Number(match[2]);
        const d = Number(match[3]);
        if (y < 1 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
        return { y, m, d };
    }

    function compareDates(a, b) {
        return (a.y - b.y) || (a.m - b.m) || (a.d - b.d);
    }

    /**
     * Same result as the server's CalculateAge(birthDate, referenceDate):
     * year difference, minus one if the reference falls before that year's
     * anniversary (DateTime.AddYears moves Feb 29 to Feb 28 in non-leap
     * years), never below zero.
     * @param {{y: number, m: number, d: number}} birth
     * @param {{y: number, m: number, d: number}} reference
     * @returns {number}
     */
    function calculateAge(birth, reference) {
        let age = reference.y - birth.y;
        const anniversary = { y: reference.y, m: birth.m, d: Math.min(birth.d, daysInMonth(reference.y, birth.m)) };
        if (compareDates(reference, anniversary) < 0) age--;
        return Math.max(0, age);
    }

    /**
     * @param {Date} [now]
     * @returns {{y: number, m: number, d: number}} Local calendar date.
     */
    function todayDate(now = new Date()) {
        return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
    }

    /**
     * Item-independent facts from a people/info (or person/{id}) response.
     * @param {*} data
     * @returns {{birthDate?: string, deathDate?: string, birthPlace?: string}|null}
     */
    function factsFromResponse(data) {
        if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
        const facts = {};
        if (parseCalendarDate(data.birthDate)) facts.birthDate = data.birthDate.slice(0, 10);
        if (parseCalendarDate(data.deathDate)) facts.deathDate = data.deathDate.slice(0, 10);
        if (typeof data.birthPlace === 'string' && data.birthPlace.trim()) {
            facts.birthPlace = data.birthPlace.trim().slice(0, MAX_BIRTHPLACE_LENGTH);
        }
        return facts;
    }

    /**
     * Derive what a card shows, mirroring the server's person response.
     * @param {{birthDate?: string, deathDate?: string, birthPlace?: string}} facts
     * @param {{y: number, m: number, d: number}|null} premiere - Item premiere date (visible items only)
     * @param {{y: number, m: number, d: number}} today
     */
    function describePerson(facts, premiere, today) {
        const birth = parseCalendarDate(facts.birthDate);
        const death = parseCalendarDate(facts.deathDate);
        // Server: EndDate < DateTime.Now, i.e. the death date is today or earlier.
        const isDeceased = !!death && compareDates(death, today) <= 0;
        let currentAge = null;
        let ageAtDeath = null;
        let ageAtItemRelease = null;
        if (birth) {
            if (isDeceased) ageAtDeath = calculateAge(birth, death);
            else currentAge = calculateAge(birth, today);
            if (premiere) ageAtItemRelease = calculateAge(birth, premiere);
        }
        return { birthPlace: facts.birthPlace || null, isDeceased, currentAge, ageAtDeath, ageAtItemRelease };
    }

    /**
     * Validate one persisted entry { b, d, p, ts }; null if invalid/expired.
     */
    function sanitizeEntry(id, entry, now, ttlMs) {
        if (!PERSON_ID_PATTERN.test(id) || !entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
        const ts = entry.ts;
        if (typeof ts !== 'number' || !Number.isFinite(ts) || now - ts >= ttlMs || ts > now + 86400000) return null;
        const clean = { ts };
        for (const field of ['b', 'd']) {
            if (entry[field] === undefined) continue;
            if (typeof entry[field] !== 'string' || entry[field].length !== 10 || !parseCalendarDate(entry[field])) return null;
            clean[field] = entry[field];
        }
        if (entry.p !== undefined) {
            if (typeof entry.p !== 'string' || !entry.p || entry.p.length > MAX_BIRTHPLACE_LENGTH) return null;
            clean.p = entry.p;
        }
        return clean;
    }

    /**
     * Keep at most maxEntries, dropping the oldest (by fetch time).
     * @param {Map<string, {ts: number}>} people
     * @returns {boolean} True if anything was evicted.
     */
    function evictOldest(people, maxEntries) {
        if (people.size <= maxEntries) return false;
        const oldestFirst = [...people].sort((a, b) => a[1].ts - b[1].ts);
        for (let i = 0; i < oldestFirst.length - maxEntries; i++) people.delete(oldestFirst[i][0]);
        return true;
    }

    /**
     * Parse and validate the persisted v2 store. A payload with another
     * owner, another version or a corrupt shape yields an empty store;
     * expired/invalid entries are dropped and the size is capped.
     * @returns {{people: Map<string, object>, rewrite: boolean}}
     */
    function loadPeopleStore(raw, owner, now, ttlMs, maxEntries) {
        const people = new Map();
        if (raw === null || raw === undefined) return { people, rewrite: false };
        let parsed = null;
        try {
            parsed = JSON.parse(raw);
        } catch {
            parsed = null;
        }
        if (!parsed || typeof parsed !== 'object' || parsed.v !== 2 || parsed.owner !== owner
            || !parsed.people || typeof parsed.people !== 'object' || Array.isArray(parsed.people)) {
            return { people, rewrite: true };
        }
        let rewrite = false;
        for (const [id, entry] of Object.entries(parsed.people)) {
            const clean = sanitizeEntry(id, entry, now, ttlMs);
            if (clean) people.set(id, clean);
            else rewrite = true;
        }
        if (evictOldest(people, maxEntries)) rewrite = true;
        return { people, rewrite };
    }

    function serializePeopleStore(owner, people) {
        return JSON.stringify({ v: 2, owner, people: Object.fromEntries(people) });
    }

    JE.initializePeopleTags = function() {
        if (!JE.currentSettings.peopleTagsEnabled) {
            console.log('🪼 Jellyfin Enhanced: People Tags: Feature is disabled in settings.');
            return;
        }

        const logPrefix = '🪼 Jellyfin Enhanced: People Tags:';
        // Per-person facts: { v: 2, owner: 'serverId:userId', people: { id: { b, d, p, ts } } }.
        const CACHE_KEY = 'JellyfinEnhanced-peopleTagsCache-v2';
        // Item-keyed v1 cache (one entry per person per item): removed on load.
        const LEGACY_KEYS = [
            'JellyfinEnhanced-peopleTagsCache',
            'JellyfinEnhanced-peopleTagsCacheTimestamp',
            'JellyfinEnhanced-peopleTagsCacheIdentityOwner'
        ];
        const MAX_CACHED_PEOPLE = 3000;
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

        // People metadata is fetched with the signed-in user's library access,
        // so the store is scoped to server:user (owner inside the payload): a
        // payload written for anyone else is dropped instead of served.
        const currentOwner = () => `${JE.session?.getServerId() || ''}:${JE.session?.getUserId() || ApiClient.getCurrentUserId() || ''}`;
        let storeOwner = currentOwner();

        /**
         * @param {*} value
         * @returns {boolean}
         */
        function isPlainObject(value) {
            return !!value && typeof value === 'object' && !Array.isArray(value);
        }

        /** @type {Map<string, {b?: string, d?: string, p?: string, ts: number}>} */
        let peopleStore = new Map();
        try {
            for (const key of LEGACY_KEYS) localStorage.removeItem(key);
            const loaded = loadPeopleStore(localStorage.getItem(CACHE_KEY), storeOwner, Date.now(), CACHE_TTL, MAX_CACHED_PEOPLE);
            peopleStore = loaded.people;
            if (loaded.rewrite) persistPeopleStore();
        } catch (e) {
            console.warn(`${logPrefix} Could not read people cache`, e);
            peopleStore = new Map();
        }
        const Hot = (JE._hotCache = JE._hotCache || { ttl: CACHE_TTL });
        Hot.peopleTags = Hot.peopleTags || new Map();

        // Full wipe on user switch; the new owner is stamped immediately.
        JE.session?.onUserChange('people-tags', (change) => {
            // In-flight batches belong to the previous user.
            resetBatchController();
            peopleStore = new Map();
            Hot.peopleTags.clear();
            storeOwner = `${change.serverId || ''}:${change.userId || ''}`;
            persistPeopleStore();
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
         * Cached facts for one person (hot map first, then the persisted store).
         * @param {string} personKey - Normalized person id
         * @param {number} now
         * @returns {object|null}
         */
        function getCachedFacts(personKey, now) {
            const hot = Hot.peopleTags.get(personKey);
            if (hot && now - hot.timestamp < CACHE_TTL) return hot.data;

            const entry = peopleStore.get(personKey);
            if (entry && now - entry.ts < CACHE_TTL) {
                const data = { birthDate: entry.b, deathDate: entry.d, birthPlace: entry.p };
                Hot.peopleTags.set(personKey, { data, timestamp: entry.ts });
                return data;
            }
            return null;
        }

        function rememberFacts(personKey, facts, now) {
            const entry = { ts: now };
            if (facts.birthDate) entry.b = facts.birthDate;
            if (facts.deathDate) entry.d = facts.deathDate;
            if (facts.birthPlace) entry.p = facts.birthPlace;
            peopleStore.delete(personKey); // re-insert as newest
            peopleStore.set(personKey, entry);
            Hot.peopleTags.set(personKey, { data: facts, timestamp: now });
        }

        /**
         * Persist the store (once per batch). Bounded; on a quota error the
         * oldest half is evicted and the write retried once, then given up.
         */
        function persistPeopleStore() {
            evictOldest(peopleStore, MAX_CACHED_PEOPLE);
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    localStorage.setItem(CACHE_KEY, serializePeopleStore(storeOwner, peopleStore));
                    return;
                } catch (e) {
                    if (attempt === 0 && peopleStore.size > 0) {
                        evictOldest(peopleStore, Math.floor(peopleStore.size / 2));
                        continue;
                    }
                    console.debug(`${logPrefix} People cache not persisted`, e);
                    return;
                }
            }
        }

        /**
         * Premiere date of the detail item, read through the shared per-user
         * item cache (Jellyfin only returns items the user can see; others
         * yield null, so no age-at-release is shown). Never rejects.
         * @param {string} itemId
         * @returns {Promise<{y: number, m: number, d: number}|null>}
         */
        function getItemPremiereDate(itemId) {
            const load = typeof JE.helpers?.getItemCached === 'function'
                ? JE.helpers.getItemCached(itemId)
                : ApiClient.getItem(ApiClient.getCurrentUserId(), itemId);
            return Promise.resolve(load)
                .then(item => parseCalendarDate(item?.PremiereDate))
                .catch(() => null);
        }

        /**
         * Paint every card of a person from the cached facts.
         * @param {Element[]} cards
         * @param {string} personId
         * @param {object} facts
         * @param {{y: number, m: number, d: number}|null} premiere
         */
        function paintPerson(cards, personId, facts, premiere) {
            const view = describePerson(facts, premiere, todayDate());
            for (const card of cards) {
                renderPersonCard(card, personId, view);
                pendingCards.delete(card);
                processedCastMembers.add(card);
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
         * @param {string} itemId - Detail item being painted
         * @param {AbortSignal} signal
         * @param {number} requestEpoch
         * @param {Promise<object|null>} premierePromise - Item premiere date (for age at release)
         * @returns {Promise<boolean>} True when new data was cached.
         */
        async function fetchAndRenderChunk(chunk, itemId, signal, requestEpoch, premierePromise) {
            const ids = chunk.map(([personId]) => personId);
            // Person facts are item-independent: no itemId, so the answer is
            // cached per person and shared by every item (episode) they are in.
            const path = `/people/info?ids=${ids.map(encodeURIComponent).join(',')}`;

            let response = null;
            for (let attempt = 0; ; attempt++) {
                try {
                    // Single transport attempt: this loop owns the retries, so a
                    // failing chunk costs at most 1 + RETRY_DELAYS_MS.length requests.
                    response = await JE.core.api.plugin(path, { signal, skipRetry: true });
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
            const now = Date.now();
            let cached = false;
            const answered = [];
            for (const entry of chunk) {
                const facts = factsFromResponse(people[normalizeId(entry[0])]);
                if (facts) {
                    rememberFacts(normalizeId(entry[0]), facts, now);
                    cached = true;
                }
                answered.push([entry, facts]);
            }

            const premiere = await premierePromise;
            if (signal.aborted || !isCurrentEpoch(requestEpoch) || lastProcessedItemId !== itemId) {
                releaseCards(chunk);
                return cached;
            }
            const paint = !!JE.currentSettings?.peopleTagsEnabled;
            for (const [[personId, cards], facts] of answered) {
                if (!paint) {
                    releaseCards([[personId, cards]]);
                } else if (facts) {
                    paintPerson(cards, personId, facts, premiere);
                } else {
                    // Answered without this person: nothing to show, done.
                    for (const card of cards) {
                        pendingCards.delete(card);
                        processedCastMembers.add(card);
                    }
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
            const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
            const premierePromise = getItemPremiereDate(currentItemId);
            const hits = [];
            const misses = [];
            for (const entry of entries) {
                const facts = getCachedFacts(normalizeId(entry[0]), now);
                if (facts) hits.push([entry, facts]);
                else misses.push(entry);
            }

            const chunks = [];
            if (misses.length > 0) {
                chunks.push(misses.slice(0, FIRST_CHUNK_SIZE));
                for (let i = FIRST_CHUNK_SIZE; i < misses.length; i += BATCH_SIZE) {
                    chunks.push(misses.slice(i, i + BATCH_SIZE));
                }
            }
            const pendingChunks = chunks.map(chunk => fetchAndRenderChunk(chunk, currentItemId, signal, requestEpoch, premierePromise));

            // Cached people only need the item's premiere date.
            if (hits.length > 0) {
                const premiere = await premierePromise;
                if (signal.aborted || !isCurrentEpoch(requestEpoch) || lastProcessedItemId !== currentItemId
                    || !JE.currentSettings?.peopleTagsEnabled) {
                    releaseCards(hits.map(([entry]) => entry));
                } else {
                    for (const [[personId, cards], facts] of hits) paintPerson(cards, personId, facts, premiere);
                }
            }

            const results = await Promise.all(pendingChunks);
            // One localStorage write per batch, once every chunk has settled.
            if (results.some(Boolean) && isCurrentEpoch(requestEpoch)) persistPeopleStore();
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
