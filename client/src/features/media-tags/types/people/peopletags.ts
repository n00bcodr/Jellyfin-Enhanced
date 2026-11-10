import { apiClient, type MediaTagsContext } from '../../host';
import { errorStatus, isRecord, record, type JsonRecord } from '../../pipeline/dto';
import { COUNTRY_MAP } from './people-countries';
import { describePerson, evictOldest, factsFromResponse, loadPeopleStore, parseCalendarDate, serializePeopleStore, todayDate, type CalendarDate, type PersonFacts, type PersonView, type StoredPerson } from './people-model';

type PersonEntry = [string, Element[]];
type Answered = [PersonEntry, PersonFacts | null];
type PrefetchOutcome = { status: 'answered'; factsById: Map<string, PersonFacts | null>; cached: boolean } | { status: 'failed' | 'aborted'; cached?: undefined };
interface Prefetch { ctl: AbortController | null; view: Element | null; epoch: number; people: Map<string, Promise<PrefetchOutcome>> }
interface RetryWait { timeoutId: number; cancel(): void }
interface HotPerson { data: PersonFacts; timestamp: number }
function isHotPerson(value: unknown): value is HotPerson { return isRecord(value) && isRecord(value.data) && typeof value.timestamp === 'number'; }
// /js/tags/peopletags.js
// Jellyfin Enhanced People Tags - Show cast member information (birthplace, age, deceased status)
//
// NOTE: unlike the poster tag modules, this one is NOT a tag-pipeline
// renderer — it targets person cards on the item detail page with its own
// managed observer and batch backend endpoint (people/info), so the
// tag-renderer factory does not apply here. Facts are cached per person and
// ages are derived locally, so episodes of a series share their cast.
export function createPeopleTags(ctx: MediaTagsContext) {
    const JE = ctx.core;

    JE.initializePeopleTags = function() {
        if (!JE.currentSettings?.peopleTagsEnabled) {
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
        const CACHE_TTL = Number(JE.pluginConfig?.TagsCacheTtlDays || 30) * 24 * 60 * 60 * 1000;
        // Must not exceed the server's people/info cap (MaxPeopleInfoBatchSize).
        const BATCH_SIZE = 100;
        // The start of the cast row (what is on screen) is requested on its own
        // so those cards are tagged without waiting for the rest of the cast.
        const FIRST_CHUNK_SIZE = 8;
        // Extra attempts for a chunk that failed after the transport's retries.
        const RETRY_DELAYS_MS = [1000, 3000];
        // Follow-up batches for cards that mount while a batch is in flight.
        const MAX_PASSES = 5;


        // People metadata is fetched with the signed-in user's library access,
        // so the store is scoped to server:user (owner inside the payload): a
        // payload written for anyone else is dropped instead of served.
        const currentOwner = () => `${JE.session?.getServerId() || ''}:${JE.session?.getUserId() || apiClient().getCurrentUserId() || ''}`;
        let storeOwner = currentOwner();

        let peopleStore = new Map<string, StoredPerson>();
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
        const sharedHot = Hot.peopleTags;
        const hotPeople: Map<string, unknown> = typeof sharedHot === 'object' ? sharedHot : new Map();
        Hot.peopleTags = hotPeople;

        // Full wipe on user switch; the new owner is stamped immediately.
        JE.session?.onUserChange('people-tags', (change) => {
            // In-flight batches and prefetches belong to the previous user.
            resetBatchController();
            for (const itemId of [...prefetches.keys()]) dropPrefetch(itemId);
            peopleStore = new Map();
            hotPeople.clear();
            storeOwner = `${change.serverId || ''}:${change.userId || ''}`;
            persistPeopleStore();
        });

        // Cards that are done (rendered, or the server answered without that
        // person) and cards claimed by an in-flight request.
        let processedCastMembers = new WeakSet();
        let pendingCards = new WeakSet();
        // Cards whose request failed for good: not retried again this visit.
        let failedCards = new WeakSet();
        let lastProcessedItemId: string | null = null;
        let peopleTagsComplete = false; // Set true after all cast members tagged for current item
        let isProcessing = false;
        // Whether the running pass is a fast one (see tryFastPath), and whether
        // a debounced run was skipped while it ran: that run is the one that
        // arms the completion latch, so it runs once the fast pass is done.
        let processingFast = false;
        let debouncedSkipped = false;
        // Whether a card pass has claimed a card of lastProcessedItemId: a
        // quiet run over the template's still-empty cast section takes the
        // item with none, and leaves the visit's prefetch free to start (and
        // its completion latch waits while that prefetch has no card yet).
        let cardsClaimed = false;

        // One AbortController per detail item: aborted when the user navigates
        // to another item or switches account, so a late batch is discarded.
        // Re-init (settings toggle) aborts the previous instance's batch.
        const lifecycle = JE.core.lifecycle.register('people-tags');
        lifecycle.teardown();
        let batchController: AbortController | null = null;
        // Retry waits are lifecycle-owned and cancelled with the batch.
        const retryWaits = new Set<RetryWait>();
        function resetBatchController() {
            cancelRetryWaits();
            if (batchController) {
                batchController.abort();
                lifecycle.untrack(batchController);
            }
            batchController = lifecycle.track(new AbortController());
            return batchController;
        }

        // People-info requests a details visit started before the cast cards
        // were on the page (see prefetch), by item id:
        // { ctl, view, epoch, people: Map<personId, Promise<outcome>> }, where
        // an outcome is { status: 'answered', factsById, cached } or
        // { status: 'failed' | 'aborted' } and every person of one request
        // shares its promise. At most the visit's item and the item a card
        // pass owns.
        const prefetches = new Map<string, Prefetch>();
        function dropPrefetch(itemId: string): void {
            const entry = prefetches.get(itemId);
            if (!entry) return;
            prefetches.delete(itemId);
            if (entry.ctl) {
                entry.ctl.abort();
                lifecycle.untrack(entry.ctl);
            }
        }

        // Styles for deceased indicators, overlay positioning, and je-msym-rounded font
        JE.core.ui.injectCss('je-people-tags-styles', `

            .je-msym-rounded {
                font-family: 'JE Material Symbols Rounded';
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
                /* Not in Jellyfin's web fonts: name the generic family directly so
                   the first cross does not walk the CJK families of the body
                   stack (a ~500 ms one-off layout stall on Linux, see icons.js). */
                font-family: sans-serif;
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

            /* Round portraits: themes clip the whole .cardScalable to a circle, which
               crops corner-anchored tags. Clip the image instead so age badges can
               overlap the edge, and inset the birthplace pill. */
            .je-people-round .cardScalable {
                overflow: visible !important;
                aspect-ratio: 1 / 1;
            }
            .je-people-round .cardPadder {
                display: none !important;
            }
            .je-people-round .cardImageContainer,
            .je-people-round .cardOverlayContainer {
                bottom: auto !important;
                height: auto !important;
                aspect-ratio: 1 / 1;
                border-radius: 50% !important;
                overflow: hidden;
            }
            .je-people-round .je-people-age-container {
                top: 2% !important;
                left: -6% !important;
                gap: 3px !important;
            }
            .je-people-round .je-people-age-chip {
                padding: 2px 6px !important;
                font-size: 11px !important;
                border-radius: 999px !important;
                box-shadow: 0 1px 4px rgba(0, 0, 0, 0.6) !important;
            }
            .je-people-round .je-people-place-banner {
                left: 12% !important;
                right: 12% !important;
                bottom: 9% !important;
                padding: 3px 8px !important;
                justify-content: center;
                border-radius: 999px;
                background: rgba(0, 0, 0, 0.7) !important;
            }
            .je-people-round .je-people-place-text {
                flex: 0 1 auto !important;
            }
        `);

        console.log(`${logPrefix} Initialized`);

        /**
         * Extract country code from birthplace string
         * @param placeString - Full birthplace string like "London, England, UK"
         * @returns - ISO 3166-1 alpha-2 country code or null
         */
        function getCountryCodeFromBirthPlace(placeString: string): string|null {
            if (!placeString || typeof placeString !== 'string') return null;

            // Split by comma and take the last part (country is typically last)
            const parts = placeString.split(',').map(p => p.trim());
            if (parts.length === 0) return null;

            const lastPart = parts[parts.length - 1] ?? '';

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
         * */
        function normalizeId(id: string): string {
            return String(id).toLowerCase().replace(/-/g, '');
        }

        /**
         * Cached facts for one person (hot map first, then the persisted store).
         * @param personKey - Normalized person id
         * */
        function getCachedFacts(personKey: string, now: number): PersonFacts | null {
            const hot = hotPeople.get(personKey);
            if (isHotPerson(hot) && now - hot.timestamp < CACHE_TTL) return hot.data;

            const entry = peopleStore.get(personKey);
            if (entry && now - entry.ts < CACHE_TTL) {
                const data = { birthDate: entry.b, deathDate: entry.d, birthPlace: entry.p };
                hotPeople.set(personKey, { data, timestamp: entry.ts });
                return data;
            }
            return null;
        }

        function rememberFacts(personKey: string, facts: PersonFacts, now: number): void {
            const entry: StoredPerson = { ts: now };
            if (facts.birthDate) entry.b = facts.birthDate;
            if (facts.deathDate) entry.d = facts.deathDate;
            if (facts.birthPlace) entry.p = facts.birthPlace;
            peopleStore.delete(personKey); // re-insert as newest
            peopleStore.set(personKey, entry);
            hotPeople.set(personKey, { data: facts, timestamp: now });
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
         * */
        function getItemPremiereDate(itemId: string): Promise<CalendarDate | null> {
            const load = typeof JE.helpers?.getItemCached === 'function'
                ? JE.helpers.getItemCached(itemId)
                : apiClient().getItem(apiClient().getCurrentUserId(), itemId);
            return Promise.resolve(load)
                .then(item => parseCalendarDate(record(item).PremiereDate))
                .catch(() => null);
        }

        /**
         * @param ids - Person ids as the cards carry them
         * @returns The people/info path for them.
         */
        function peopleInfoPath(ids: string[]): string {
            // Person facts are item-independent: no itemId, so the answer is
            // cached per person and shared by every item (episode) they are in.
            return `/people/info?ids=${ids.map(encodeURIComponent).join(',')}`;
        }

        /**
         * Cache the facts a people/info response holds for the requested people.
         * @param ids - The requested person ids
         * @returns Facts per id in
         *   order (null: answered without that person), and whether any was cached.
         */
        function rememberResponse(ids: readonly string[], response: unknown): { facts: Array<PersonFacts | null>; cached: boolean } {
            const people = record(record(response).people);
            const now = Date.now();
            let cached = false;
            const facts = ids.map((id) => {
                const personFacts = factsFromResponse(people[normalizeId(id)]);
                if (personFacts) {
                    rememberFacts(normalizeId(id), personFacts, now);
                    cached = true;
                }
                return personFacts;
            });
            return { facts, cached };
        }

        /**
         * The requests for people without cached facts: the first
         * FIRST_CHUNK_SIZE (start of the row) on their own, then BATCH_SIZE chunks.
         * @template T
         * */
        function chunkMisses<T>(list: readonly T[]): T[][] {
            const chunks: T[][] = [];
            if (list.length > 0) {
                chunks.push(list.slice(0, FIRST_CHUNK_SIZE));
                for (let i = FIRST_CHUNK_SIZE; i < list.length; i += BATCH_SIZE) {
                    chunks.push(list.slice(i, i + BATCH_SIZE));
                }
            }
            return chunks;
        }

        /**
         * Paint every card of a person from the cached facts.
         */
        function paintPerson(cards: readonly Element[], personId: string, facts: PersonFacts, premiere: CalendarDate | null): void {
            const view = describePerson(facts, premiere, todayDate());
            for (const card of cards) {
                renderPersonCard(card, personId, view);
                pendingCards.delete(card);
                processedCastMembers.add(card);
            }
        }

        /**
         * @returns True while the identity that started a request is current.
         */
        function isCurrentEpoch(epoch: number): boolean {
            return !JE.session || JE.session.isCurrent(epoch);
        }

        /**
         * Wait before retrying a chunk. Resolves false if the batch is reset
         * (navigation to another item, user switch) or the feature is torn down.
         * */
        function waitForRetry(ms: number): Promise<boolean> {
            return new Promise((resolve) => {
                const wait: RetryWait = { timeoutId: 0, cancel: () => {} };
                const finish = (proceed: boolean) => {
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
         * @param [failed=false] - Request gave up: skip for the rest of this visit.
         */
        function releaseCards(entries: readonly PersonEntry[], failed: boolean = false): void {
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
         * @param chunk - [personId, cards] pairs
         * @param itemId - Detail item being painted
         * @param premierePromise - Item premiere date (for age at release)
         * @returns True when new data was cached.
         */
        async function fetchAndRenderChunk(chunk: PersonEntry[], itemId: string, signal: AbortSignal, requestEpoch: number, premierePromise: Promise<CalendarDate | null>): Promise<boolean> {
            const ids = chunk.map(([personId]) => personId);
            const path = peopleInfoPath(ids);

            let response: unknown = null;
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
                    const status = errorStatus(error);
                    const retryable = !status || status >= 500 || status === 408 || status === 429;
                    if (!retryable || attempt >= RETRY_DELAYS_MS.length) {
                        console.warn(`${logPrefix} Failed to fetch person info for ${ids.length} people:`, error);
                        releaseCards(chunk, true);
                        return false;
                    }
                    const retryDelay = RETRY_DELAYS_MS[attempt] ?? 0;
                    console.debug(`${logPrefix} Person info request failed, retrying in ${retryDelay}ms`, error);
                    if (!(await waitForRetry(retryDelay)) || signal.aborted) {
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

            const { facts, cached } = rememberResponse(ids, response);
            const answered = chunk.map((entry, i): Answered => [entry, facts[i] ?? null]);

            const premiere = await premierePromise;
            if (signal.aborted || !isCurrentEpoch(requestEpoch) || lastProcessedItemId !== itemId) {
                releaseCards(chunk);
                return cached;
            }
            applyAnswers(answered, premiere);
            return cached;
        }

        /**
         * Paint the cards of answered people (current pass only).
         * @param answered - Each
         *   [personId, cards] entry with its facts (null: answered without them)
         */
        function applyAnswers(answered: readonly Answered[], premiere: CalendarDate | null): void {
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
        }

        /**
         * Paint cards whose people a details visit's prefetch requested (one of
         * its requests), with the same guards as fetchAndRenderChunk. A failed
         * prefetch is never shown: those people are requested here instead, as
         * the one chunk the prefetch sent, with the usual retries.
         * @param chunk - [personId, cards] pairs
         * @param outcomePromise - The prefetch request's outcome
         * @returns True when the fallback request cached new data.
         */
        async function joinPrefetchedChunk(chunk: PersonEntry[], outcomePromise: Promise<PrefetchOutcome>, itemId: string, signal: AbortSignal, requestEpoch: number, premierePromise: Promise<CalendarDate | null>): Promise<boolean> {
            const outcome = await outcomePromise;
            const premiere = await premierePromise;
            if (signal.aborted || !isCurrentEpoch(requestEpoch) || lastProcessedItemId !== itemId) {
                releaseCards(chunk);
                return false;
            }
            if (outcome.status !== 'answered') {
                return fetchAndRenderChunk(chunk, itemId, signal, requestEpoch, premierePromise);
            }
            applyAnswers(chunk.map((entry): Answered => [entry, outcome.factsById.get(entry[0]) || null]), premiere);
            return false;
        }

        /**
         * Create one age chip (deceased / current / at-release share markup).
         * @param variant - Suffix for the chip class (deceased|current|release)
         * @param background - Chip background color
         * @param iconName - Material Symbols icon name
         * @param age - Age value to display
         * */
        function createAgeChip(variant: string, background: string, iconName: string, age: number): HTMLElement {
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
            icon.className = 'je-msym-rounded je-people-age-icon';
            icon.textContent = iconName;
            icon.style.cssText = 'font-size: 13px;';
            ageChip.appendChild(icon);

            const text = document.createElement('span');
            text.className = 'je-people-age-text';
            // "42y" in the user's language: the short age unit comes from the locale files.
            const short = typeof JE.t === 'function' ? JE.t('tag_people_age_short', { age }) : 'tag_people_age_short';
            text.textContent = short === 'tag_people_age_short' ? `${age}y` : short;
            ageChip.appendChild(text);

            return ageChip;
        }

        /**
         * Create people tag chips in top-left corner and birthplace banner at bottom
         * @returns Object with ageContainer and placeContainer elements
         */
        function createPeopleTag(personData: PersonView): { ageContainer: HTMLElement; placeContainer: HTMLElement } {
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
                locationIcon.className = 'je-msym-rounded je-people-place-icon';
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
         */
        function renderPersonCard(card: Element, personId: string, personData: PersonView): void {
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

                // Flag circular portraits so their tags use the round layout.
                const radius = getComputedStyle(cardScalable).borderRadius;
                card.classList.toggle('je-people-round', radius.includes('%') && parseFloat(radius) >= 40);

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
         * Visit the person cards of the cast, then the guest cast section, in
         * DOM order.
         * @param page - The details view to look in; null for
         *   the first visible one holding each section.
         * @param [log=false] - Log each section's card count.
         */
        function forEachCandidateCard(page: Element|null, fn: (card: Element) => void, log: boolean = false) {
            for (const collapsibleSelector of ['#castCollapsible', '#guestCastCollapsible']) {
                const collapsible = page
                    ? page.querySelector(collapsibleSelector)
                    : document.querySelector(`#itemDetailPage:not(.hide) ${collapsibleSelector}`);
                if (!collapsible) continue;

                const castCards = collapsible.querySelectorAll('.personCard');
                if (castCards.length === 0) continue;

                if (log) console.debug(`${logPrefix} Found ${castCards.length} cast members in ${collapsibleSelector}`);

                for (const card of castCards) fn(card);
            }
        }

        /**
         * Claim not-yet-processed cards from the cast and guest cast sections
         * in one pass, grouped by person (a person can have several cards,
         * e.g. actor and director, or cast and guest cast). DOM order is kept.
         * */
        function collectPendingCards(): Map<string, Element[]> {
            const groups = new Map<string, Element[]>();
            forEachCandidateCard(null, (card) => {
                if (processedCastMembers.has(card) || pendingCards.has(card) || failedCards.has(card)) return;

                const personId = card.getAttribute('data-id');
                if (!personId) return;

                pendingCards.add(card);
                cardsClaimed = true;
                const cards = groups.get(personId);
                if (cards) cards.push(card);
                else groups.set(personId, [card]);
            }, true);
            return groups;
        }

        /**
         * Render cached people immediately, then fetch the misses: the first
         * FIRST_CHUNK_SIZE people (start of the row) and the rest (in
         * BATCH_SIZE chunks) in parallel, rendering each chunk as it returns.
         */
        async function processPendingCards(groups: Map<string, Element[]>, currentItemId: string, signal: AbortSignal): Promise<void> {
            const entries = [...groups];
            // Feature switched off: paint nothing.
            if (!JE.currentSettings?.peopleTagsEnabled) {
                releaseCards(entries);
                return;
            }

            const now = Date.now();
            const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
            const premierePromise = getItemPremiereDate(currentItemId);
            // People a details visit's prefetch already requested join its
            // requests (grouped per request) instead of asking again.
            const prefetched = prefetches.get(currentItemId)?.people;
            const hits: Array<[PersonEntry, PersonFacts]> = [];
            const joined = new Map<Promise<PrefetchOutcome>, PersonEntry[]>();
            const misses: PersonEntry[] = [];
            for (const entry of entries) {
                const facts = getCachedFacts(normalizeId(entry[0]), now);
                const outcome = facts ? null : prefetched?.get(entry[0]);
                if (facts) {
                    hits.push([entry, facts]);
                } else if (outcome) {
                    const waiting = joined.get(outcome);
                    if (waiting) waiting.push(entry);
                    else joined.set(outcome, [entry]);
                } else {
                    misses.push(entry);
                }
            }

            const pendingChunks = chunkMisses(misses).map(chunk => fetchAndRenderChunk(chunk, currentItemId, signal, requestEpoch, premierePromise));
            for (const [outcome, chunk] of joined) {
                pendingChunks.push(joinPrefetchedChunk(chunk, outcome, currentItemId, signal, requestEpoch, premierePromise));
            }

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
         * @returns The item id in the URL.
         */
        function currentHashItemId(): string|null {
            try {
                return new URLSearchParams(window.location.hash.split('?')[1]).get('id');
            } catch {
                return null;
            }
        }

        /**
         * The cast's person ids in the order the card pass groups them (cast,
         * then guest stars, each person once), or null when the cards may not
         * follow item.People (Jellyfin 12 leaves artists out; a person without
         * an id).
         * */
        function castOrderPersonIds(item: JsonRecord): string[] | null {
            if (!Array.isArray(item?.People)) return null;
            const cast: string[] = [];
            const guestStars: string[] = [];
            for (const entry of item.People) {
                const person = record(entry);
                if (typeof person.Id !== 'string' || !person.Id) return null;
                if (person.Type === 'Artist' || person.Type === 'AlbumArtist') return null;
                (person.Type === 'GuestStar' ? guestStars : cast).push(person.Id);
            }
            return [...new Set([...cast, ...guestStars])];
        }

        /**
         * Main initialization using proper page navigation hooks
         */
        function initialize() {
            console.debug(`${logPrefix} Initializing with managed observer pattern`);

            /**
             * Tag the cast of the details item in the URL.
             * @param fast - Started by tryFastPath, without waiting for
             *   the page's mutations to go quiet. Only the debounced (quiet) run
             *   arms the completion latch, as before.
             */
            function runPeopleTags(fast: boolean) {
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
                        debouncedSkipped = false;
                        cardsClaimed = false;
                        for (const key of [...prefetches.keys()]) {
                            if (key !== itemId) dropPrefetch(key);
                        }
                        console.debug(`${logPrefix} New item detected: ${itemId}`);
                    }

                    // Skip if already fully processed for this item
                    if (peopleTagsComplete) {
                        return;
                    }
                    if (isProcessing) {
                        // A quiet run skipped by a fast pass runs once that is done.
                        if (!fast && processingFast) debouncedSkipped = true;
                        return;
                    }

                    // Process cast members for this item, then mark complete
                    // after a short delay to allow late-arriving DOM updates.
                    // Capture the itemId so stale completions from previous
                    // navigations don't mark the wrong item as done.
                    const processingItemId = itemId;
                    processingFast = fast;
                    processCastMembers().then(() => {
                        // Another item arrived while this batch was in flight
                        // (its run was skipped by isProcessing): process it now.
                        if (lastProcessedItemId !== processingItemId) {
                            debouncedSkipped = false;
                            handlePeopleTags();
                            return;
                        }
                        if (fast) {
                            // The quiet-point run came while this one painted.
                            if (debouncedSkipped) {
                                debouncedSkipped = false;
                                handlePeopleTags();
                            }
                            return;
                        }
                        setTimeout(() => {
                            // A pass that claimed no card does not end an item
                            // whose prefetch waits for its cards: the cards
                            // take it over, and the quiet run after they mount
                            // arms the latch again.
                            if (lastProcessedItemId === processingItemId
                                && (cardsClaimed || !prefetches.has(processingItemId))) {
                                peopleTagsComplete = true;
                            }
                        }, 2000);
                    });
                } catch (e) {
                    // Ignore errors (likely not on an item page)
                }
            }

            // Handle item details page display with debounced observer (same pattern as features.js)
            const helpers = JE.helpers;
            if (!helpers) return;
            const handlePeopleTags = helpers.debounce(() => runPeopleTags(false), 100);

            /**
             * Paint at once, instead of after 100 ms without mutations, when the
             * visit's prefetch covers every card still to tag: those people are
             * cached or already requested, so the pass makes no people/info
             * request. Only on the view the visit was started for, so another
             * item's cards are never painted with this item's premiere date.
             * @param [hashId] - The item id in the URL.
             */
            function tryFastPath(hashId: string|null = currentHashItemId()) {
                const entry = hashId ? prefetches.get(hashId) : null;
                if (!entry || !entry.view || !isCurrentEpoch(entry.epoch) || !JE.currentSettings?.peopleTagsEnabled) return;
                const sameItem = lastProcessedItemId === hashId;
                if (sameItem && (peopleTagsComplete || isProcessing)) return;
                if (document.querySelector('#itemDetailPage:not(.hide)') !== entry.view) return;

                const now = Date.now();
                let unclaimed = 0;
                let covered = true;
                forEachCandidateCard(entry.view, (card) => {
                    if (!covered) return;
                    // A new item's pass starts with no card claimed.
                    if (sameItem && (processedCastMembers.has(card) || pendingCards.has(card) || failedCards.has(card))) return;
                    const personId = card.getAttribute('data-id');
                    if (!personId) return;
                    unclaimed++;
                    if (!entry.people.has(personId) && !getCachedFacts(normalizeId(personId), now)) covered = false;
                });
                if (covered && unclaimed > 0) runPeopleTags(true);
            }

            /**
             * Start the people/info requests for a details item's cast before its
             * cards are on the page (features-details-page.js calls this once
             * Jellyfin has filled the item's info row): the same requests the card
             * pass would make, without retries. The card pass takes the answers
             * over (joinPrefetchedChunk).
             * @param item - The item, with People
             * @param view - The details view the visit belongs to
             * @param epoch - The identity epoch of the visit
             */
            function prefetch(itemId: string, item: JsonRecord, view: Element, epoch: number) {
                if (!JE.currentSettings?.peopleTagsEnabled || !isCurrentEpoch(epoch) || typeof JE.core?.api?.plugin !== 'function') return;
                // A card pass already owns this item: it requests what it needs
                // (or the item is done). A pass that claimed no card owns nothing.
                if (!itemId || prefetches.has(itemId)) return;
                if (lastProcessedItemId === itemId && (cardsClaimed || peopleTagsComplete)) return;
                const ids = castOrderPersonIds(item);
                if (!ids || ids.length === 0) return;
                for (const key of [...prefetches.keys()]) {
                    if (key !== lastProcessedItemId) dropPrefetch(key);
                }

                const now = Date.now();
                const misses = ids.filter(id => !getCachedFacts(normalizeId(id), now));
                const ctl = misses.length ? lifecycle.track(new AbortController()) : null;
                const entry = { ctl, view, epoch, people: new Map() };
                prefetches.set(itemId, entry);
                const outcomes = chunkMisses(misses).map((chunk) => {
                    const signal = ctl?.signal;
                    const outcome: Promise<PrefetchOutcome> = JE.core.api.plugin(peopleInfoPath(chunk), { ...(signal ? { signal } : {}), skipRetry: true })
                        .then((response): PrefetchOutcome => {
                            // Left, or another user: nothing is kept.
                            if (signal?.aborted || !isCurrentEpoch(epoch)) return { status: 'aborted' };
                            const { facts, cached } = rememberResponse(chunk, response);
                            return { status: 'answered', factsById: new Map(chunk.map((id, i): [string, PersonFacts | null] => [id, facts[i] ?? null])), cached };
                        })
                        .catch((error: unknown): PrefetchOutcome => {
                            console.debug(`${logPrefix} Person info prefetch failed`, error);
                            return { status: signal?.aborted ? 'aborted' : 'failed' };
                        });
                    for (const id of chunk) entry.people.set(id, outcome);
                    return outcome;
                });
                if (ctl) {
                    Promise.all(outcomes).then((settled) => {
                        if (settled.some(outcome => outcome.cached) && isCurrentEpoch(epoch)) persistPeopleStore();
                        lifecycle.untrack(ctl);
                    });
                }
                tryFastPath();
            }

            /**
             * The visit of a details item ended: drop its prefetch unless a card
             * pass took it over (that pass ends with its item, as before). A
             * kept one lets go of the visit's view, which only the fast path
             * used, so a view Jellyfin evicts is not held until the next item.
             */
            function leave(itemId: string) {
                if (lastProcessedItemId !== itemId || !cardsClaimed) {
                    dropPrefetch(itemId);
                    return;
                }
                const entry = prefetches.get(itemId);
                if (entry) entry.view = null;
            }

            // Create managed observer for people tags.
            // Only watches childList (not attributes) to avoid firing on every hover
            // class/style change. Cast sections appear via childList mutations.
            helpers.createObserver?.(
                'people-tags',
                (mutations) => {
                    if (!JE.currentSettings?.peopleTagsEnabled) return;

                    // Reset completion flag when navigating to a different item
                    // (must happen BEFORE the peopleTagsComplete check)
                    const hashId = currentHashItemId();
                    if (hashId && hashId !== lastProcessedItemId) {
                        peopleTagsComplete = false;
                    }

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

                    tryFastPath(hashId);
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

            // For the details page's visits (features-details-page.js), also as the facade it reads (step C4);
            // a re-init replaces the previous instance's.
            ctx.own.peopleTags = JE.peopleTags = { prefetch, leave };

            console.debug(`${logPrefix} Initialization complete`);
        }

        initialize();
    };
}
