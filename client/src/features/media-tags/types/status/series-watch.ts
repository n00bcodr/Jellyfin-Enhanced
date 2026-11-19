// The viewport observer of the Status cards that read their series' TMDB schedule (moved here from statustags.ts),
// and their rests (upstream abcaa16d): a card rests off the observer while nothing can be asked for it, so a page of
// answered cards costs the browser no intersection work while it is scrolled.

/** What the watch reads from and does through statustags.ts. */
export interface SeriesWatchHost<Ctx, Card> {
    /** The card's live record (statustags.ts liveCards). */
    card(el: HTMLElement): Card | undefined;
    /** Whether the record still belongs to the card element (its identity is unchanged). */
    current(el: HTMLElement, card: Card | undefined): boolean;
    /** Whether a card on screen needs its series asked for now (eligibleSeriesCard). */
    eligible(el: HTMLElement, card: Card | undefined): boolean;
    /** Ask for the card's series (and arm the shared retry when `retry`). */
    request(ctx: Ctx, card: Card, retry: boolean): void;
    /** Until when nothing can be asked for the card (ms since the epoch), or 0 when something can now. */
    restUntil(card: Card | undefined): number;
    /** Forget a removed or recycled card's live data (after it is unobserved). */
    forgetLive(el: HTMLElement): void;
}

/**
 * Which schedule-reading cards are under the one viewport observer, and the rests. statustags.ts creates the
 * observer (adopt) and its removal/identity watcher, whose records it hands to sweep.
 * @param host - What the watch reads from statustags.ts.
 */
export function createSeriesWatch<Ctx, Card>(host: SeriesWatchHost<Ctx, Card>) {
    let seriesObserver: IntersectionObserver | null = null;
    /** Cards currently intersecting the viewport. */
    let intersectingCards = new WeakSet<HTMLElement>();
    /** Targets explicitly released when removed or recycled. */
    const observedSeriesCards = new Set<HTMLElement>();
    /**
     * Schedule-reading cards taken off the viewport observer while nothing can be asked for
     * them (rest): they stay in observedSeriesCards, are in no intersection set, and go back
     * under the observer when that ends.
     */
    let restingSeriesCards = new WeakSet<HTMLElement>();
    /**
     * Cards put back under the observer because their rest ended by itself. The observer's
     * first report for them only says where they are: a card that was on screen all along asks
     * when it next comes on screen or is drawn, as it would have had it never rested.
     */
    let resumedSeriesCards = new WeakSet<HTMLElement>();
    /** One timer for the earliest end of a rest, and when it fires (ms since the epoch), or 0. */
    let seriesRestTimer: ReturnType<typeof setTimeout> | null = null;
    let seriesRestAt = 0;

    /** The observer's reports (its callback): a report from an observer since released is dropped. */
    function report(ctx: Ctx, observer: IntersectionObserver, entries: IntersectionObserverEntry[]): void {
        if (seriesObserver !== observer) return; // A queued callback from before cleanup.
        for (const { target, isIntersecting } of entries) {
            if (!(target instanceof HTMLElement)) continue;
            const watched = target;
            if (!observedSeriesCards.has(watched)) continue;
            const card = host.card(watched);
            if (!watched.isConnected || !host.current(watched, card)) {
                forget(watched);
                continue;
            }
            // A report queued before the card was taken off the observer.
            if (restingSeriesCards.has(watched)) continue;
            const whereOnly = resumedSeriesCards.delete(watched);
            if (isIntersecting) intersectingCards.add(watched);
            else intersectingCards.delete(watched);
            if (isIntersecting && !whereOnly && card && host.eligible(watched, card)) host.request(ctx, card, true);
            rest(ctx, watched);
        }
    }

    /** Forget the watched cards that left the page or show another item now (the removal watcher's records). */
    function sweep(): void {
        for (const watched of observedSeriesCards) {
            const card = host.card(watched);
            if (!watched.isConnected || !host.current(watched, card)) forget(watched);
        }
    }

    /** Watch a schedule reader through the adopted viewport observer, retaining identity guards. */
    function observe(ctx: Ctx, el: HTMLElement): void {
        if (seriesObserver && !observedSeriesCards.has(el)) {
            observedSeriesCards.add(el);
            // Nothing to ask for it (a page drawn again within the hour): never watched at all.
            if (!rest(ctx, el)) seriesObserver.observe(el);
        } else if (restingSeriesCards.has(el)) {
            // Drawn again while resting: watched once more as soon as something can be asked for it.
            if (!host.restUntil(host.card(el))) resume(el, false);
        } else {
            // Put back a moment ago and not reported yet: that report asks, as this draw would have.
            resumedSeriesCards.delete(el);
        }
        const card = host.card(el);
        if (card && host.eligible(el, card)) host.request(ctx, card, false);
    }

    /** Release a target and its previous visibility. */
    function unobserve(el: HTMLElement): void {
        seriesObserver?.unobserve(el);
        observedSeriesCards.delete(el);
        intersectingCards.delete(el);
        restingSeriesCards.delete(el);
        resumedSeriesCards.delete(el);
    }

    /** Forget a removed or recycled card's live data. */
    function forget(el: HTMLElement): void {
        unobserve(el);
        host.forgetLive(el);
    }

    /** Release all targets and the observer; the next schedule render creates one again. */
    function release(): void {
        for (const el of observedSeriesCards) forget(el);
        seriesObserver?.disconnect();
        seriesObserver = null;
        intersectingCards = new WeakSet();
        restingSeriesCards = new WeakSet();
        resumedSeriesCards = new WeakSet();
    }

    /**
     * Take a schedule-reading card off the viewport observer while nothing can be asked for it
     * (restUntil): where it is then decides nothing. One timer puts the cards back when the
     * earliest rest ends.
     * @returns Whether the card rests (now or already).
     */
    function rest(ctx: Ctx, el: HTMLElement): boolean {
        if (restingSeriesCards.has(el)) return true;
        if (!seriesObserver || !observedSeriesCards.has(el)) return false;
        const until = host.restUntil(host.card(el));
        if (!until) return false;
        restingSeriesCards.add(el);
        resumedSeriesCards.delete(el);
        intersectingCards.delete(el);
        seriesObserver.unobserve(el);
        armRest(ctx, until);
        return true;
    }

    /**
     * Put a resting card back under the viewport observer.
     * @param whereOnly - Its rest ended by itself: the first report only says where the card is
     *   (see resumedSeriesCards). False when the card was drawn again or the tab came back: on screen, it asks.
     */
    function resume(el: HTMLElement, whereOnly: boolean): void {
        if (!restingSeriesCards.delete(el)) return;
        if (whereOnly) resumedSeriesCards.add(el);
        else resumedSeriesCards.delete(el);
        seriesObserver?.observe(el);
    }

    /**
     * Put back every resting card for which something can be asked again, and arm the timer for
     * the next end of a rest.
     * @param whereOnly - See resume.
     */
    function check(ctx: Ctx, whereOnly = true): void {
        if (seriesRestTimer !== null) clearTimeout(seriesRestTimer);
        seriesRestTimer = null;
        seriesRestAt = 0;
        let next = 0;
        for (const el of observedSeriesCards) {
            if (!restingSeriesCards.has(el)) continue;
            const until = host.restUntil(host.card(el));
            if (!until) resume(el, whereOnly);
            else if (!next || until < next) next = until;
        }
        if (next) armRest(ctx, next);
    }

    /** Check the resting cards at this time at the latest (ms since the epoch). */
    function armRest(ctx: Ctx, at: number): void {
        if (seriesRestTimer !== null && seriesRestAt <= at) return;
        if (seriesRestTimer !== null) clearTimeout(seriesRestTimer);
        seriesRestAt = at;
        seriesRestTimer = setTimeout(() => {
            seriesRestTimer = null;
            seriesRestAt = 0;
            check(ctx);
        }, Math.max(0, at - Date.now()));
    }

    /** Rest every watched card whose series was just answered. */
    function restAnswered(ctx: Ctx): void {
        for (const el of observedSeriesCards) rest(ctx, el);
    }

    /**
     * A tab back from the background: rests that ended while it slept (its timers and the
     * observer's reports wait for it) end, and the cards on screen ask when they are reported.
     */
    function wake(ctx: Ctx): void {
        for (const el of observedSeriesCards) resumedSeriesCards.delete(el);
        check(ctx, false);
    }

    /** Cancel the rest timer (the cards stay as they are until release). */
    function stop(): void {
        if (seriesRestTimer !== null) clearTimeout(seriesRestTimer);
        seriesRestTimer = null;
        seriesRestAt = 0;
    }

    return {
        report, sweep, observe, unobserve,
        /** Take the viewport observer statustags.ts created (it calls report). */
        adopt: (observer: IntersectionObserver): void => { seriesObserver = observer; },
        /** Whether there is a viewport observer. */
        adopted: (): boolean => seriesObserver !== null, forget, release, check, restAnswered, wake, stop,
        /** Whether the card is on screen as far as the observer last said. */
        intersecting: (el: HTMLElement): boolean => intersectingCards.has(el),
        /** The observed cards, resting ones included. */
        observed: (): Iterable<HTMLElement> => observedSeriesCards,
    };
}
