/**
 * @file Roulette mode for the Random button: instead of silently jumping to a
 * random library item, cycle a highlight across the item cards rendered on the
 * current page (a library view, a collection, a genre, a person page…), slow
 * down, and land on one. Also owns the "autoplay the pick" delivery, which
 * starts playback in this browser session through the Sessions API rather than
 * opening the details page.
 *
 * Consumed by features-random-button.js via JE.internals.randomRoulette. Both
 * behaviours are opt-in per user (randomRouletteEnabled / randomAutoplay) so
 * the default Random button keeps working exactly as before.
 */
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};

    const logPrefix = '🪼 Jellyfin Enhanced: Random Roulette:';
    const STYLE_ID = 'je-random-roulette-styles';
    const ACTIVE_CLASS = 'je-roulette-active';
    const WINNER_CLASS = 'je-roulette-winner';

    // Cards Jellyfin renders for browsable items. Folder cards (libraries,
    // collections-as-folders) are excluded: they are containers, not picks.
    const CARD_SELECTOR = '.card[data-id][data-type]:not([data-isfolder="true"])';

    // Timing of one spin. The interval between highlight steps eases from
    // FAST_MS up to SLOW_MS over the last SLOWDOWN_STEPS so the wheel visibly
    // decelerates before it stops.
    const FAST_MS = 80;
    const SLOW_MS = 480;
    const SLOWDOWN_STEPS = 10;
    const MIN_STEPS = 30;
    const EXTRA_STEPS_MAX = 14;
    const WINNER_HOLD_MS = 1100;

    /** Injects the highlight CSS once. */
    function ensureStyles() {
        if (document.getElementById(STYLE_ID)) return;
        JE.core.ui.injectCss(STYLE_ID, `
            .${ACTIVE_CLASS} .cardBox,
            .${WINNER_CLASS} .cardBox {
                position: relative;
                z-index: 2;
                transform: scale(1.05);
                transition: transform 60ms ease-out;
                box-shadow: 0 0 28px 10px rgba(0, 164, 220, 0.75);
            }
            /* The selector frame is drawn INSIDE the card as an overlay, so it
               is never clipped by the grid's edges the way an outline would be. */
            .${ACTIVE_CLASS} .cardBox::after,
            .${WINNER_CLASS} .cardBox::after {
                content: '';
                position: absolute;
                inset: 0;
                border: 4px solid var(--je-roulette-color, #00a4dc);
                outline: 2px solid rgba(255, 255, 255, 0.95);
                outline-offset: -6px;
                border-radius: 4px;
                pointer-events: none;
                z-index: 10;
            }
            .${WINNER_CLASS} .cardBox {
                animation: je-roulette-winner-pulse 0.55s ease-in-out 2;
            }
            @keyframes je-roulette-winner-pulse {
                0%, 100% { transform: scale(1.05); }
                50% { transform: scale(1.12); }
            }
        `);
    }

    /**
     * Item types the user has opted into for the Random button.
     * @returns {Set<string>}
     */
    function allowedTypes() {
        const types = new Set();
        if (JE.currentSettings.randomIncludeMovies) types.add('Movie');
        if (JE.currentSettings.randomIncludeShows) types.add('Series');
        return types;
    }

    /**
     * Collects the item cards rendered on the page the user is looking at,
     * filtered to the Random button's item types and deduplicated by item id
     * (Jellyfin can render the same item in several sections of one view).
     * @returns {HTMLElement[]} Cards in DOM order; empty when the page has none.
     */
    function collectPageCards() {
        const types = allowedTypes();
        const seen = new Set();
        const cards = [];
        document.querySelectorAll(CARD_SELECTOR).forEach(card => {
            // Skip cards inside hidden views (Jellyfin keeps previous pages in the DOM).
            if (card.closest('.hide') || card.offsetParent === null) return;
            const id = card.dataset.id;
            if (!id || seen.has(id) || !types.has(card.dataset.type)) return;
            seen.add(id);
            cards.push(card);
        });
        return cards;
    }

    /**
     * Drops cards whose item the user has already watched. Fetches user data
     * in batches so a large page does not build an oversized query string.
     * @param {HTMLElement[]} cards
     * @returns {Promise<HTMLElement[]>}
     */
    async function filterUnwatched(cards) {
        const userId = ApiClient.getCurrentUserId();
        if (!userId || cards.length === 0) return cards;
        const byId = new Map(cards.map(card => [card.dataset.id, card]));
        const ids = Array.from(byId.keys());
        const unwatched = [];
        const BATCH = 100;
        for (let i = 0; i < ids.length; i += BATCH) {
            const batch = ids.slice(i, i + BATCH);
            const url = ApiClient.getUrl(`/Users/${userId}/Items?Ids=${batch.join(',')}&Fields=UserData`);
            const response = await ApiClient.ajax({ type: 'GET', url, dataType: 'json' });
            (response?.Items || []).forEach(item => {
                const played = item.Type === 'Series'
                    ? !(item.UserData?.UnplayedItemCount > 0)
                    : !!item.UserData?.Played;
                if (!played && byId.has(item.Id)) unwatched.push(byId.get(item.Id));
            });
        }
        // Keep DOM order so the highlight travels across the grid predictably.
        const keep = new Set(unwatched);
        return cards.filter(card => keep.has(card));
    }

    /**
     * Returns the candidate cards for a roulette spin on the current page:
     * the rendered cards, minus watched items when "unwatched only" is on.
     * @returns {Promise<HTMLElement[]>}
     */
    async function getPageCandidates() {
        let cards = collectPageCards();
        if (cards.length && JE.currentSettings.randomUnwatchedOnly) {
            try {
                cards = await filterUnwatched(cards);
            } catch (error) {
                console.warn(`${logPrefix} unwatched filter failed, spinning over every card`, error);
            }
        }
        return cards;
    }

    /** @param {number} ms */
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Interval before step `stepsLeft`-from-the-end: constant while far from
     * the end, then eased up to SLOW_MS over the final SLOWDOWN_STEPS.
     * @param {number} stepsLeft Steps remaining after this one.
     * @returns {number} Milliseconds.
     */
    function stepDelay(stepsLeft) {
        if (stepsLeft >= SLOWDOWN_STEPS) return FAST_MS;
        const t = 1 - stepsLeft / SLOWDOWN_STEPS; // 0 → 1 as we approach the end
        return FAST_MS + (SLOW_MS - FAST_MS) * (t * t);
    }

    /**
     * True when the whole card is inside the viewport. Partial visibility is
     * not enough: a card half under the header or half below the fold still
     * needs a scroll before the user can see the frame land on it.
     * @param {HTMLElement} card
     */
    function isFullyVisible(card) {
        const r = card.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight;
    }

    /**
     * Runs the roulette animation over `cards` and resolves with the winner.
     * The winner is chosen up front; the animation is presentation only, so a
     * page re-render mid-spin cannot change the outcome. Cards off screen are
     * only scrolled to during the slow tail, so the fast phase does not thrash
     * the scroll position on a big grid.
     * @param {HTMLElement[]} cards At least one card.
     * @returns {Promise<HTMLElement>} The card the highlight stopped on.
     */
    async function spin(cards) {
        ensureStyles();
        const winnerIndex = Math.floor(Math.random() * cards.length);
        const totalSteps = MIN_STEPS + Math.floor(Math.random() * EXTRA_STEPS_MAX);
        // Walk the cards in DOM order so the highlight arrives at the winner on
        // the final step no matter how many laps that takes.
        let index = ((winnerIndex - totalSteps) % cards.length + cards.length) % cards.length;
        let current = null;

        for (let step = 0; step < totalSteps; step++) {
            const stepsLeft = totalSteps - 1 - step;
            index = (index + 1) % cards.length;
            const card = cards[index];
            current?.classList.remove(ACTIVE_CLASS);
            card.classList.add(ACTIVE_CLASS);
            current = card;
            if (stepsLeft < SLOWDOWN_STEPS && !isFullyVisible(card)) {
                card.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }
            await sleep(stepDelay(stepsLeft));
        }

        const winner = cards[winnerIndex];
        current?.classList.remove(ACTIVE_CLASS);
        winner.classList.add(WINNER_CLASS);
        if (!isFullyVisible(winner)) winner.scrollIntoView({ block: 'center', behavior: 'smooth' });
        await sleep(WINNER_HOLD_MS);
        winner.classList.remove(WINNER_CLASS);
        return winner;
    }

    /**
     * Starts playback of an item in this browser's own Jellyfin session via
     * the Sessions API. Works for movies, episodes and series alike (the
     * server expands a series into its episodes).
     * @param {string} itemId
     * @returns {Promise<boolean>} True when the play command was accepted.
     */
    async function playItem(itemId) {
        const apiClient = window.ApiClient;
        if (!apiClient) {
            JE.toast(JE.t('toast_api_client_unavailable'), 3000);
            return false;
        }
        try {
            const userId = apiClient.getCurrentUserId();
            const deviceId = typeof apiClient.deviceId === 'function' ? apiClient.deviceId() : apiClient._deviceId;
            const sessions = await apiClient.ajax({
                type: 'GET',
                url: apiClient.getUrl(`/Sessions?ControllableByUserId=${encodeURIComponent(userId)}`),
                dataType: 'json'
            });
            const session = Array.isArray(sessions) ? sessions.find(s => s.DeviceId === deviceId) : null;
            if (!session) {
                JE.toast(JE.t('toast_session_not_found'), 3000);
                return false;
            }
            await apiClient.ajax({
                type: 'POST',
                url: apiClient.getUrl(`/Sessions/${encodeURIComponent(session.Id)}/Playing?playCommand=PlayNow&itemIds=${encodeURIComponent(itemId)}`)
            });
            JE.toast(JE.t('toast_playing'), 2000);
            return true;
        } catch (error) {
            console.error(`${logPrefix} playback failed`, error);
            JE.toast(JE.t('toast_playback_failed').replace('{error}', error.message || 'Unknown error'), 3000);
            return false;
        }
    }

    JE.internals.randomRoulette = Object.freeze({ getPageCandidates, spin, playItem });
})(window.JellyfinEnhanced);
