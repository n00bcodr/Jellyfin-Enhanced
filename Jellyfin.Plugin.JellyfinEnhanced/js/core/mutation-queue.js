// @ts-check
// /js/core/mutation-queue.js
//
// Writes on the person's behalf, bound to the signed-in session (js/core/session.js).
//
// Every write JE sends for the signed-in person (their settings documents, Spoiler Guard and notification preferences,
// Hidden Content, a home-row removal, requests and every other POST/PUT/PATCH/DELETE) goes out through ONE function,
// JE.core.userWrite.send(binding, transmit). The binding is the session the change was made in (JE.session.bind(), taken
// when the person acts); send checks it again immediately before transmit builds the request's headers, after every wait
// the write went through (a queue, the API limiter, an await), and refuses the write when the session changed meanwhile:
// a change one person made never goes out with the next person's credentials. core/api-client.js sends its writes through
// it after the limiter has granted their slot (and again before each retry); JE.core.userWrite.ajax is the same for
// Jellyfin's ApiClient.ajax. A write refused that way rejects with `sessionChanged` and the page shows, once per account
// change, that a change made before it wasn't saved (never only a console line).
//
// A document the page changes by sending requests (the per-user settings documents, Spoiler Guard's preferences, the
// notification preferences) has exactly one queue. Its writes go out one at a time, in the order they were made, so an
// answer can never overtake the write before it. Each write belongs to the session that queued it: a switch of account
// cancels every write the previous person queued and not yet sent; the next person's writes don't wait behind them. The
// queue hands each write its binding, and the write is sent through userWrite.send with it. The queue's revision moves on
// with every write queued, every answer and every cancellation, so a read of the document that began before one of them
// can tell it may hold less than the page does (see `revision`).
//
// Public surface: JE.core.userWrite { bind(), isBound(binding), send(binding, transmit, name), ajax(binding, request),
// notSent(error) }; JE.core.mutationQueue(name, options) → { send(transmit, binding), revision, pending, touch(), settled() }.
(function(JE) {
    'use strict';

    JE.core = JE.core || {};

    const logPrefix = '🪼 Jellyfin Enhanced:';

    /** The signed-in user per the host's ApiClient, now. */
    const liveUser = () => (typeof ApiClient !== 'undefined' ? ApiClient.getCurrentUserId?.() || null : null);
    /** The session's epoch now, when a session module tells it. */
    const liveEpoch = () => (JE.session && typeof JE.session.getEpoch === 'function' ? JE.session.getEpoch() : undefined);

    /** The session now (a host without the full session module: the user id and any epoch it tells). */
    const bindNow = () => (JE.session && typeof JE.session.bind === 'function'
        ? JE.session.bind()
        : Object.freeze({ epoch: liveEpoch(), userId: liveUser() }));

    /** Whether a binding is still the signed-in session, read now. */
    const isBound = binding => {
        if (!binding) return false;
        if (JE.session && typeof JE.session.isBound === 'function') return JE.session.isBound(binding);
        return !!binding.userId && binding.userId === liveUser() && binding.epoch === liveEpoch();
    };

    // The account change whose "not saved" notice was shown (one notice per change, however many writes it cancelled).
    let noticedEpoch;

    /**
     * Tells the person that a change made before the account changed wasn't saved (once per account change).
     * @param {*} [error] - The cancellation (logged).
     */
    const notSent = error => {
        const epoch = JE.session && typeof JE.session.getEpoch === 'function' ? JE.session.getEpoch() : 0;
        if (error) console.warn(`${logPrefix} a change made before the account changed was not sent.`, error?.message || error);
        if (noticedEpoch === epoch) return;
        noticedEpoch = epoch;
        try {
            const text = typeof JE.t === 'function' ? JE.t('settings_not_saved_account_changed') : '';
            JE.toast?.(text && text !== 'settings_not_saved_account_changed' ? text
                : 'A change made before the account changed wasn\'t saved.', 5000);
        } catch { /* Best effort. */ }
    };

    /** The refusal of a write whose session changed before it was sent. */
    const cancelled = name => {
        const error = /** @type {any} */ (new Error(`${name}: the session changed; this write was not sent`));
        error.sessionChanged = true;
        return error;
    };

    JE.core.userWrite = {
        /** The session a change is made in (take it when the person acts, before any wait). */
        bind: bindNow,
        isBound,
        /**
         * THE send of a write on the person's behalf: checks the binding immediately before `transmit`, which must build
         * the request's headers and send it in the same step (synchronously up to the network call).
         * @param {{epoch: number|undefined, userId: string|null}} binding - JE.core.userWrite.bind() when the change was made.
         * @param {() => Promise<any>} transmit - Builds and sends the request.
         * @param {string} [name] - What is written (for the refusal's message).
         * @returns {Promise<any>}
         */
        send(binding, transmit, name = 'write') {
            if (!isBound(binding)) {
                const error = cancelled(name);
                notSent(error);
                return Promise.reject(error);
            }
            return transmit();
        },
        /**
         * Jellyfin's ApiClient.ajax for a write, sent through `send`.
         * @param {{epoch: number|undefined, userId: string|null}} binding
         * @param {object} request - ApiClient.ajax's request.
         * @returns {Promise<any>}
         */
        ajax(binding, request) {
            return JE.core.userWrite.send(binding, () => ApiClient.ajax(request), request?.url);
        },
        notSent
    };

    /**
     * Creates (or, for a name already in use, replaces) a document's queue.
     * @param {string} name - The document (unique per document; a later queue of the same name takes over its reset).
     * @param {{isCurrent?: () => boolean}} [options] - isCurrent: an extra check of the owner's own, made with the session
     *   check right before each send (false: the write is cancelled).
     * @returns {{send: (transmit: (binding: any) => Promise<any>, binding?: any) => Promise<any>, readonly revision: number,
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
             * session that queued it is still the signed-in one. A cancelled write is never sent: it rejects with an error
             * whose `sessionChanged` is true.
             * @param {(binding: any) => Promise<any>} transmit - Sends the write through JE.core.userWrite with the binding
             *   it is handed (called at most once, at its turn).
             * @param {any} [binding] - The session the change was made in (default: now).
             * @returns {Promise<any>} The answer.
             */
            send(transmit, binding = bindNow()) {
                const queuedIn = generation;
                revision++;
                pending++;
                const current = () => queuedIn === generation && isBound(binding)
                    && (typeof options.isCurrent !== 'function' || options.isCurrent());
                const run = chain.then(() => {
                    if (!current()) {
                        const error = cancelled(name);
                        notSent(error);
                        throw error;
                    }
                    return transmit(binding);
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
