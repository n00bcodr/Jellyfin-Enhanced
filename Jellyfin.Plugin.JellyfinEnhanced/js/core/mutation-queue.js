// @ts-check
// /js/core/mutation-queue.js
//
// One queue of writes to one server document, bound to the signed-in session (js/core/session.js).
//
// A document the page changes by sending requests (the per-user settings documents, Spoiler Guard's preferences, the
// notification preferences) has exactly one queue. Its writes go out one at a time, in the order they were made, so an
// answer can never overtake the write before it. Each write belongs to the session that queued it: the session is
// checked immediately before the write is sent (never only after it was answered), and a switch of account cancels every
// write the previous person queued and not yet sent; the next person's writes don't wait behind them. The queue's
// revision moves on with every write queued, every answer and every cancellation, so a read of the document that began
// before one of them can tell it may hold less than the page does (see `revision`).
//
// Public surface: JE.core.mutationQueue(name, options) → { send(transmit), revision, pending, touch(), settled() }.
(function(JE) {
    'use strict';

    JE.core = JE.core || {};

    /**
     * Creates (or, for a name already in use, replaces) a document's queue.
     * @param {string} name - The document (unique per document; a later queue of the same name takes over its reset).
     * @param {{isCurrent?: () => boolean}} [options] - isCurrent: an extra check of the owner's own, made with the session
     *   check right before each send (false: the write is cancelled).
     * @returns {{send: (transmit: () => Promise<any>) => Promise<any>, readonly revision: number, readonly pending: number,
     *   touch: () => void, settled: () => Promise<void>}}
     */
    JE.core.mutationQueue = function mutationQueue(name, options = {}) {
        let chain = Promise.resolve();
        // Moves on with each account switch: a write queued before one is never sent.
        let generation = 0;
        let revision = 0;
        let pending = 0;

        /** @returns {number|undefined} The session's epoch now (undefined in a host without the session module). */
        const epochNow = () => (JE.session && typeof JE.session.getEpoch === 'function' ? JE.session.getEpoch() : undefined);

        const queue = {
            /**
             * Sends one write after every earlier write of this queue was answered (whatever the outcome), only while the
             * session that queued it is still the signed-in one. A cancelled write is never sent: it rejects with an error
             * whose `sessionChanged` is true.
             * @param {() => Promise<any>} transmit - Sends the write (called at most once, at its turn).
             * @returns {Promise<any>} The answer.
             */
            send(transmit) {
                const epoch = epochNow();
                const queuedIn = generation;
                revision++;
                pending++;
                const current = () => queuedIn === generation
                    && (epoch === undefined || !JE.session || typeof JE.session.isCurrent !== 'function' || JE.session.isCurrent(epoch))
                    && (typeof options.isCurrent !== 'function' || options.isCurrent());
                const run = chain.then(() => {
                    if (!current()) {
                        const error = /** @type {any} */ (new Error(`${name}: the session changed; this write was not sent`));
                        error.sessionChanged = true;
                        throw error;
                    }
                    return transmit();
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
