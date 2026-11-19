// Which direct-play cards are under the IntersectionObserver (upstream abcaa16d). A card is watched only while where it
// is can matter. Once its item has a fresh answer there is nothing to ask until that answer lapses, so the card is
// released from the observer (settle): a page of answered cards costs the browser no intersection work while it is
// scrolled. A released card is watched again when its answer lapses (its day is over, the profile or the bitrate
// changed, memory dropped it) or it is drawn for other media or another item.

/** What the watch reads from and does through tag-direct-play.ts. */
export interface CardWatchHost<Entry> {
    /** The tracked card's record (replaced wholesale by a reset, so read through here). */
    entry(card: HTMLElement): Entry | undefined;
    /** The tracked cards on screen. */
    visible: Set<HTMLElement>;
    /** The shared observer, created when first asked for; null without IntersectionObserver. */
    watcher(): IntersectionObserver | null;
    /** The shared observer if it exists, without creating it. */
    observer(): IntersectionObserver | null;
    /** When the card's fresh answer was given (ms since the epoch), or null when there is none to rest on. */
    answeredAt(entry: Entry): number | null;
    /** How long an answer stays fresh (ms). */
    ttlMs: number;
    /** Stop tracking a card that left the page. */
    untrack(card: HTMLElement): void;
}

/** @param host - What the watch reads from tag-direct-play.ts. */
export function createCardWatch<Entry>(host: CardWatchHost<Entry>) {
    /**
     * Tracked cards under the observer, on screen or not. Held weakly: the observer reports a
     * card that leaves the page only if it was on screen, so nothing else would let go of one
     * removed while off screen.
     */
    const watched = new Set<WeakRef<HTMLElement>>();
    /** A watched card → its entry in `watched`. */
    let watchedRef = new WeakMap<HTMLElement, WeakRef<HTMLElement>>();
    /** `watched` is cleared of collected cards when it has grown to this size. */
    let watchedSweepAt = 256;
    /**
     * Tracked cards released from the observer because their item has a fresh answer (see
     * settle). Held weakly: a released card is no longer reported when it leaves the page, so
     * nothing else would let go of it.
     */
    const settled = new Set<WeakRef<HTMLElement>>();
    /** A released card → its entry in `settled`. */
    let settledRef = new WeakMap<HTMLElement, WeakRef<HTMLElement>>();
    /**
     * Cards watched again because their answer lapsed. The observer's first report for them only
     * says where they are: a card that was on screen all along is asked about when it next comes
     * on screen or is drawn, as it would have been had it never been released.
     */
    let rewatched = new WeakSet<HTMLElement>();
    /** The timer for the earliest lapse among the released cards' answers, and when it fires (ms since the epoch). */
    let settledTimer: ReturnType<typeof setTimeout> | 0 = 0;
    let settledAt = 0;
    const hasWeakRef = () => typeof WeakRef === 'function';

    /** Put a tracked card under the observer. @returns False when there is no IntersectionObserver. */
    function watch(card: HTMLElement): boolean {
        const io = host.watcher();
        if (!io) return false;
        noteWatched(card);
        io.observe(card);
        return true;
    }

    /** Remember a card as watched. Without WeakRef nothing is remembered: stored answers then reach an off-screen card when it comes on screen. */
    function noteWatched(card: HTMLElement): void {
        if (watchedRef.has(card) || !hasWeakRef()) return;
        const ref = new WeakRef(card);
        watched.add(ref);
        watchedRef.set(card, ref);
        if (watched.size >= watchedSweepAt) {
            watchedCards();
            watchedSweepAt = Math.max(256, watched.size * 2);
        }
    }

    /** Forget a card as watched. */
    function dropWatched(card: HTMLElement): void {
        const ref = watchedRef.get(card);
        if (!ref) return;
        watched.delete(ref);
        watchedRef.delete(card);
    }

    /**
     * The watched cards still on the page. Cards the browser has collected are dropped from
     * `watched`, and ones removed from the page are untracked: no observer report came for them.
     */
    function watchedCards(): HTMLElement[] {
        const cards: HTMLElement[] = [];
        for (const ref of [...watched]) {
            const card = ref.deref();
            if (!card) watched.delete(ref);
            else if (!card.isConnected) host.untrack(card);
            else cards.push(card);
        }
        return cards;
    }

    /**
     * Release a tracked card from the observer when its item has a fresh answer: nothing is
     * asked until that answer lapses, so where the card is no longer matters. Cards stay watched
     * where released ones could not be found again (no WeakRef) or nothing watches (no
     * IntersectionObserver).
     * @returns Whether the card is released (now or already).
     */
    function settle(card: HTMLElement): boolean {
        if (settledRef.has(card)) return true;
        const entry = host.entry(card);
        const observer = host.observer();
        if (!entry || !observer || !hasWeakRef()) return false;
        const answeredAt = host.answeredAt(entry);
        if (answeredAt === null) return false;
        const ref = new WeakRef(card);
        settled.add(ref);
        settledRef.set(card, ref);
        host.visible.delete(card);
        rewatched.delete(card);
        dropWatched(card);
        observer.unobserve(card);
        armSettled(answeredAt + host.ttlMs);
        return true;
    }

    /**
     * Watch a released card again.
     * @param whereOnly - Its answer lapsed by itself: the first report only says where the card is
     *   (see `rewatched`). False when the card was drawn again: on screen, it is asked about.
     */
    function rewatch(card: HTMLElement, whereOnly: boolean): void {
        const ref = settledRef.get(card);
        if (!ref) return;
        settled.delete(ref);
        settledRef.delete(card);
        if (whereOnly) rewatched.add(card);
        else rewatched.delete(card);
        watch(card);
    }

    /**
     * Watch every released card again: their answers lapsed together (another profile or
     * bitrate). A card on screen is asked about at the observer's first report: nothing else
     * would bring it back while it stays there (a cached page shown again after the quality was changed).
     */
    function rewatchSettled(): void {
        for (const ref of [...settled]) {
            const card = ref.deref();
            if (card && host.entry(card)) rewatch(card, false);
            else settled.delete(ref);
        }
    }

    /** Check the released cards at this time at the latest (one timer, for the earliest lapse; ms since the epoch). */
    function armSettled(at: number): void {
        if (settledTimer && settledAt <= at) return;
        if (settledTimer) clearTimeout(settledTimer);
        settledAt = at;
        settledTimer = setTimeout(checkSettled, Math.max(0, at - Date.now()));
    }

    /**
     * Watch again the released cards whose answer has lapsed (a day old, or dropped from
     * memory), forget the ones that left the page, and arm the timer for the next lapse.
     */
    function checkSettled(): void {
        settledTimer = 0;
        settledAt = 0;
        let next = 0;
        for (const ref of [...settled]) {
            const card = ref.deref();
            const entry = card ? host.entry(card) : undefined;
            if (!card || !entry) { settled.delete(ref); continue; }
            if (!card.isConnected) { host.untrack(card); continue; }
            const answeredAt = host.answeredAt(entry);
            if (answeredAt === null) { rewatch(card, true); continue; }
            const at = answeredAt + host.ttlMs;
            if (!next || at < next) next = at;
        }
        if (next) armSettled(next);
    }

    /** Forget a card that is no longer tracked. */
    function forget(card: HTMLElement): void {
        const ref = settledRef.get(card);
        if (ref) { settled.delete(ref); settledRef.delete(card); }
        rewatched.delete(card);
        dropWatched(card);
    }

    /** Forget every card (a reset). */
    function reset(): void {
        watched.clear();
        watchedRef = new WeakMap();
        watchedSweepAt = 256;
        settled.clear();
        settledRef = new WeakMap();
        rewatched = new WeakSet();
        if (settledTimer) clearTimeout(settledTimer);
        settledTimer = 0;
        settledAt = 0;
    }

    return {
        watch, settle, rewatch, rewatchSettled, armSettled, watchedCards, forget, reset,
        /** Whether a card is released from the observer. */
        isSettled: (card: HTMLElement): boolean => settledRef.has(card),
        /** Whether a card was watched again by a lapse and not reported since (and forget that it was). */
        takeRewatched: (card: HTMLElement): boolean => rewatched.delete(card),
        /** Whether any card is watched or released (another profile or bitrate then matters). */
        busy: (): boolean => settled.size > 0 || watched.size > 0,
        /** How many cards are watched (still on the page) and released. */
        counts: () => ({ watching: [...watched].filter(ref => ref.deref()?.isConnected).length, settled: settled.size }),
        /** Whether a released card's answer may have gone (memory dropped one). */
        anySettled: (): boolean => settled.size > 0,
    };
}
