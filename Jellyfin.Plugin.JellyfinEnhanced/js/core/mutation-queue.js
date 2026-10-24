// @ts-check
// /js/core/mutation-queue.js
//
// Writes on the person's behalf, bound to the session they were made in (js/core/session.js).
//
// ORIGIN. Every write JE sends for the signed-in person (their settings documents, Spoiler Guard and notification
// preferences, Hidden Content, a home-row removal, requests and every other POST/PUT/PATCH/DELETE) belongs to the session
// the person acted in. That session is taken ONCE, when the person acts (the click, the change, the key press), before
// anything the action waits for (a metadata read, a dialog, a debounce, a queue): `JE.core.userWrite.origin()`. The origin
// is carried through every wait, every URL and body built, every write and retry the action makes and every effect of its
// answers. The functions that send (`send`, `ajax`, the core fetch, a document queue) never take a session of their own:
// a write without its origin is refused, never bound afresh to whoever is signed in by then. A continuation that finds its
// origin stale is cancelled; it never becomes the next person's action. Only an entry point the person's gesture calls
// directly (before any await) mints an origin.
//
// THE SEND. `JE.core.userWrite.send(origin, transmit)` checks the origin again immediately before `transmit` builds the
// request's headers, after every wait the write went through (a queue, the API limiter, an await), and refuses the write
// when the session changed meanwhile: a change one person made never goes out with the next person's credentials.
//
// OUTCOMES. A write ends in one of three outcomes (`outcome(error)`): stored (it was answered), 'unsent' or 'refused'
// (proven not stored: it was cancelled before any attempt went out, or the server refused it with a contractual answer),
// or 'uncertain' (an attempt went out and may have been stored: its answer was lost, timed out, couldn't be read, or a
// later retry was cancelled). Once any attempt may have been stored, nothing downgrades it to unsent. An uncertain write
// is never shown as not saved; it is shown as not confirmed, and the owner of the document reads it again to find out.
//
// A document the page changes by sending requests (the per-user settings documents, Spoiler Guard's preferences, the
// notification preferences) has exactly one queue. Its writes go out one at a time, in the order they were made, so an
// answer can never overtake the write before it. Each write belongs to the origin it was queued with: a switch of account
// cancels every write the previous person queued and not yet sent; the next person's writes don't wait behind them. The
// queue's revision moves on with every write queued, every answer and every cancellation, so a read of the document that
// began before one of them can tell it may hold less than the page does (see `revision`).
//
// Public surface: JE.core.userWrite { origin(), bind() (= origin), originOf(given), isBound(origin), send(origin, transmit, name),
// ajax(origin, request), notSent(error), outcome(error), classify(error), reportUncertain(error) };
// JE.core.mutationQueue(name, options) → { send(transmit, origin), revision, pending, touch(), settled() }.
(function(JE) {
    'use strict';

    JE.core = JE.core || {};

    const logPrefix = '🪼 Jellyfin Enhanced:';

    /** The signed-in user per the host's ApiClient, now. */
    const liveUser = () => (typeof ApiClient !== 'undefined' ? ApiClient.getCurrentUserId?.() || null : null);
    /** The session's epoch now, when a session module tells it. */
    const liveEpoch = () => (JE.session && typeof JE.session.getEpoch === 'function' ? JE.session.getEpoch() : undefined);

    // Every origin minted here (an origin is an object this module handed out, never any value a caller passes along).
    const minted = new WeakSet();
    /** A new origin: the session now (a host without the full session module: the user id and any epoch it tells). */
    const mintOrigin = () => {
        const origin = JE.session && typeof JE.session.bind === 'function'
            ? JE.session.bind()
            : Object.freeze({ epoch: liveEpoch(), userId: liveUser(), serverId: null });
        if (origin && typeof origin === 'object') minted.add(origin);
        return origin;
    };
    /** Whether a value is an origin (minted here, or by the session module: { epoch, userId }). */
    const isOrigin = value => !!value && typeof value === 'object' && (minted.has(value) || ('epoch' in value && 'userId' in value));

    /** Whether an origin is still the signed-in session, read now. */
    const isBound = origin => {
        if (!origin) return false;
        if (JE.session && typeof JE.session.isBound === 'function') return JE.session.isBound(origin);
        return !!origin.userId && origin.userId === liveUser() && origin.epoch === liveEpoch();
    };

    /**
     * The outcome a failed write's error proves: 'unsent' (cancelled before any attempt went out), 'refused' (the server
     * answered that it did not store it), or 'uncertain' (an attempt went out and may have been stored). Every failure of
     * an attempt is classified where it is sent (send, the core fetch's retries); an error that carries no classification
     * never came from an attempt (a read or a check before the write failed), so nothing was sent.
     * @param {*} error
     * @returns {'unsent'|'refused'|'uncertain'}
     */
    const outcome = error => {
        if (error && typeof error === 'object' && typeof error.writeOutcome === 'string') return error.writeOutcome;
        if (error?.sessionChanged) return error.mayHaveCommitted ? 'uncertain' : 'unsent';
        return 'unsent';
    };

    /** The HTTP status an error or a rejected answer carries (a fetch Response, ApiClient.ajax's rejection), if any. */
    const statusOf = error => {
        const status = Number(error?.status ?? error?.statusCode);
        return Number.isFinite(status) && status > 0 ? status : undefined;
    };

    /**
     * Records on an error of a write whose attempt went out what it proves (writeOutcome). A contractual refusal is an
     * answer of the server that it did not store the write: 4xx (but 408, a timeout), and 503 (not processed). Everything
     * else (a lost connection, a timeout, an abort after sending, 5xx, an answer that couldn't be read) may have been stored.
     * @param {*} error
     * @returns {*} The error.
     */
    const classify = error => {
        if (!error || typeof error !== 'object' || typeof error.writeOutcome === 'string') return error;
        let value;
        if (error.sessionChanged) value = error.mayHaveCommitted ? 'uncertain' : 'unsent';
        else {
            const status = statusOf(error);
            value = status !== undefined && ((status >= 400 && status < 500 && status !== 408) || status === 503) ? 'refused' : 'uncertain';
        }
        try { Object.defineProperty(error, 'writeOutcome', { value, configurable: true, enumerable: false, writable: true }); }
        catch { /* A frozen error keeps its own classification: outcome() reads it as uncertain. */ }
        return error;
    };

    // The account change whose notice was shown, per wording (one notice per change, however many writes it touched).
    const noticedEpochs = { unsent: undefined, uncertain: undefined };

    /** A translated text, or its English fallback. */
    const text = (key, fallback) => {
        try {
            const value = typeof JE.t === 'function' ? JE.t(key) : '';
            return value && value !== key ? value : fallback;
        } catch { return fallback; }
    };

    /**
     * Tells the person that a change made before the account changed wasn't saved, or, when an attempt of it went out and
     * may have been stored, that it couldn't be confirmed (once per account change for each).
     * @param {*} [error] - The cancellation (logged).
     */
    const notSent = error => {
        const epoch = JE.session && typeof JE.session.getEpoch === 'function' ? JE.session.getEpoch() : 0;
        const uncertain = outcome(error) === 'uncertain' && !!error;
        if (error) console.warn(`${logPrefix} a change made before the account changed was ${uncertain ? 'not confirmed' : 'not sent'}.`, error?.message || error);
        const kind = uncertain ? 'uncertain' : 'unsent';
        if (noticedEpochs[kind] === epoch) return;
        noticedEpochs[kind] = epoch;
        try {
            JE.toast?.(uncertain
                ? text('settings_unconfirmed_account_changed', 'A change made before the account changed couldn\'t be confirmed as saved.')
                : text('settings_not_saved_account_changed', 'A change made before the account changed wasn\'t saved.'), 5000);
        } catch { /* Best effort. */ }
    };

    // When the last "couldn't confirm" notice was shown (several in a row show one).
    let uncertainShownAt = 0;
    /**
     * Tells the person that a change of theirs couldn't be confirmed as saved (its answer was lost): never that it wasn't.
     * @param {*} [error] - The failure (logged).
     */
    const reportUncertain = error => {
        if (error) console.warn(`${logPrefix} a change could not be confirmed as saved.`, error?.message || error);
        const now = Date.now();
        if (now - uncertainShownAt < 2000) return;
        uncertainShownAt = now;
        try { JE.toast?.(text('settings_save_unconfirmed', 'Couldn\'t confirm your change was saved. Checking what the server holds…'), 5000); }
        catch { /* Best effort. */ }
    };

    /** The refusal of a write whose origin is missing or no longer the signed-in session (nothing was sent). */
    const cancelled = (name, missing = false) => {
        const error = /** @type {any} */ (new Error(missing
            ? `${name}: no origin; this write was not sent`
            : `${name}: the session changed; this write was not sent`));
        error.sessionChanged = !missing;
        error.originMissing = missing;
        error.writeOutcome = 'unsent';
        return error;
    };

    JE.core.userWrite = {
        /** The session an action belongs to: take it when the person acts, before any wait, and carry it through. */
        origin: mintOrigin,
        /** The same as origin() (kept for its earlier callers). */
        bind: mintOrigin,
        /**
         * For an action's entry point (a function the person's gesture calls directly: the settings store's writers, a
         * hide, a request): the origin its caller took (`given`), or, when the gesture called it directly without one,
         * the session now. Only evaluated before the entry's first wait. A continuation that calls an entry point after
         * any wait passes the origin it took; the low-level senders (send, ajax, the core fetch, a document queue) never
         * take one of their own.
         * @param {*} [given]
         */
        originOf: given => (isOrigin(given) ? given : mintOrigin()),
        isBound,
        outcome,
        classify,
        reportUncertain,
        /**
         * THE send of a write on the person's behalf: checks the origin immediately before `transmit`, which must build
         * the request's headers and send it in the same step (synchronously up to the network call). A failure of the
         * attempt is classified (writeOutcome) before it reaches the caller.
         * @param {{epoch: number|undefined, userId: string|null}} origin - JE.core.userWrite.origin() when the person acted.
         * @param {() => Promise<any>} transmit - Builds and sends the request.
         * @param {string} [name] - What is written (for the refusal's message).
         * @returns {Promise<any>}
         */
        send(origin, transmit, name = 'write') {
            if (!origin) {
                const error = cancelled(name, true);
                console.error(`${logPrefix} ${error.message}`);
                return Promise.reject(error);
            }
            if (!isBound(origin)) {
                const error = cancelled(name);
                notSent(error);
                return Promise.reject(error);
            }
            let sent;
            try { sent = transmit(); }
            catch (error) { return Promise.reject(classify(error)); }
            return Promise.resolve(sent).catch(error => { throw classify(error); });
        },
        /**
         * Jellyfin's ApiClient.ajax for a write, sent through `send`.
         * @param {{epoch: number|undefined, userId: string|null}} origin
         * @param {object} request - ApiClient.ajax's request.
         * @returns {Promise<any>}
         */
        ajax(origin, request) {
            return JE.core.userWrite.send(origin, () => ApiClient.ajax(request), request?.url);
        },
        notSent
    };

    /**
     * Creates (or, for a name already in use, replaces) a document's queue.
     * @param {string} name - The document (unique per document; a later queue of the same name takes over its reset).
     * @param {{isCurrent?: () => boolean}} [options] - isCurrent: an extra check of the owner's own, made with the session
     *   check right before each send (false: the write is cancelled).
     * @returns {{send: (transmit: (origin: any) => Promise<any>, origin: any) => Promise<any>, readonly revision: number,
     *   readonly pending: number, touch: () => void, settled: () => Promise<void>}}
     */
    JE.core.mutationQueue = function mutationQueue(name, options = {}) {
        let chain = Promise.resolve();
        // Moves on with each account switch: a write queued before one is never sent.
        let generation = 0;
        let revision = 0;
        let pending = 0;

        const queue = {
            /**
             * Sends one write after every earlier write of this queue was answered (whatever the outcome), only while the
             * origin it was queued with is still the signed-in session. A cancelled write is never sent: it rejects with an
             * error whose `sessionChanged` is true. A write without an origin is refused at once.
             * @param {(origin: any) => Promise<any>} transmit - Sends the write through JE.core.userWrite with the origin
             *   it is handed (called at most once, at its turn).
             * @param {any} origin - The session the change was made in (JE.core.userWrite.origin() when the person acted).
             * @returns {Promise<any>} The answer.
             */
            send(transmit, origin) {
                if (!origin) {
                    const error = cancelled(name, true);
                    console.error(`${logPrefix} ${error.message}`);
                    return Promise.reject(error);
                }
                const queuedIn = generation;
                revision++;
                pending++;
                const current = () => queuedIn === generation && isBound(origin)
                    && (typeof options.isCurrent !== 'function' || options.isCurrent());
                const run = chain.then(() => {
                    if (!current()) {
                        const error = cancelled(name);
                        notSent(error);
                        throw error;
                    }
                    return transmit(origin);
                });
                const settled = run.then(() => {}, () => {}).then(() => {
                    if (queuedIn !== generation) return;
                    pending--;
                    revision++;
                });
                // The next write waits for this one's answer (and for its bookkeeping), never for its outcome.
                if (queuedIn === generation) chain = settled;
                return run;
            },
            /** Moves on with every write queued, answered or cancelled, and with every other change a reader must not miss. */
            get revision() { return revision; },
            /** Writes queued and not answered yet. */
            get pending() { return pending; },
            /** Another change of the document (one this queue didn't send) moves the revision on too. */
            touch() { revision++; },
            /** Settles once every write queued so far has been answered or cancelled. */
            settled() { return chain; }
        };

        if (JE.session && typeof JE.session.onUserChange === 'function') {
            JE.session.onUserChange(`mutation-queue:${name}`, () => {
                generation++;
                revision++;
                pending = 0;
                chain = Promise.resolve();
            });
        }
        return queue;
    };
})(window.JellyfinEnhanced);
