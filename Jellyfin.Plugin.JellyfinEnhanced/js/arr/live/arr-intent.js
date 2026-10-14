// /js/arr/live/arr-intent.js
//
// Intent tokens for remote lists and searches ("Requests & downloads"). A list that reads from the
// server takes a token when a read starts and publishes the answer (or its error) only while that
// token is still current: it is the newest read of the list, the signed-in user is the same
// (JE.session epoch) and what the page asks the list for (tab, query, filter, page, …) hasn't
// changed since the read started. A 30-second poll still reading page 1 then can't overwrite the
// page 2 the user just opened, a late answer for an old search can't land under a new one, and a
// late failure can't empty newer rows.
//
//     const intent = JE.arrIntent.create('history', { intent: () => ({ q: state.q, page: state.page }) });
//     const token = intent.next();            // a read starts (parts from the intent function)
//     const data = await read();
//     if (!intent.current(token)) return;     // stale: publish nothing
//
// Public surface: JE.arrIntent.create(name, options) → { next(parts), current(token), invalidate(),
// key(parts) }. Nothing here touches the network or the page.
(function (JE) {
    'use strict';

    /**
     * A stable text for the parts of an intent: plain values compared by value, object keys in
     * sorted order (so { page: 2, q: 'x' } and { q: 'x', page: 2 } are the same intent).
     * @param {*} parts Plain value, array or object (null/undefined: no parts).
     * @returns {string} Key.
     */
    function key(parts) {
        if (parts === undefined || parts === null) return '';
        const norm = (value) => {
            if (Array.isArray(value)) return value.map(norm);
            if (value && typeof value === 'object') {
                const out = {};
                for (const k of Object.keys(value).sort()) {
                    if (value[k] !== undefined) out[k] = norm(value[k]);
                }
                return out;
            }
            return value === undefined ? null : value;
        };
        return JSON.stringify(norm(parts));
    }

    /**
     * The signed-in user's epoch now (0 without a session module).
     * @returns {number} Epoch.
     */
    function epochNow() {
        return JE.session && typeof JE.session.getEpoch === 'function' ? JE.session.getEpoch() : 0;
    }

    /**
     * True while the epoch a token was taken in is still the signed-in user's.
     * @param {number} epoch Epoch of the token.
     * @returns {boolean} Same user.
     */
    function epochCurrent(epoch) {
        if (!JE.session) return true;
        if (typeof JE.session.isCurrent === 'function') return JE.session.isCurrent(epoch);
        return typeof JE.session.getEpoch === 'function' ? JE.session.getEpoch() === epoch : true;
    }

    /**
     * Creates the intent fence of one list.
     * @param {string} name The list (diagnostics only; e.g. 'admin:activity').
     * @param {{intent?: function(): *}} [options] <code>intent</code>: what the page asks the list
     *   for right now (tab, query, filter, page, page size, …). When given, a token also goes stale
     *   as soon as that answer differs from the one at <code>next()</code>, even with no newer read.
     * @returns {{next: function(*=): Object, current: function(Object): boolean, invalidate: function(): void, key: function(*): string}}
     *   <code>next(parts)</code> starts a read and returns its token (parts default to
     *   <code>options.intent()</code>); <code>current(token)</code> says whether that read may still
     *   publish its outcome; <code>invalidate()</code> makes every outstanding token stale (the
     *   list was switched off, left or reset).
     */
    function create(name, options) {
        const intentOf = typeof options?.intent === 'function' ? options.intent : null;
        let seq = 0;
        return {
            next(parts) {
                const p = parts !== undefined ? parts : (intentOf ? intentOf() : undefined);
                seq += 1;
                return Object.freeze({ name: String(name || ''), seq, epoch: epochNow(), key: key(p), parts: p });
            },
            current(token) {
                if (!token || token.seq !== seq || !epochCurrent(token.epoch)) return false;
                return !intentOf || key(intentOf()) === token.key;
            },
            invalidate() {
                seq += 1;
            },
            key
        };
    }

    JE.arrIntent = { create, key };
})(window.JellyfinEnhanced);
