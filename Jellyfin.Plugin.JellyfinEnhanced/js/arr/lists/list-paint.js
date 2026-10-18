/**
 * @file Requests & downloads, phase 4c3a: the paint gate. Every DOM write the list modules make goes through it.
 *
 * - A **ticket** ({@link issue}) belongs to one controller showing one list. It holds the session epoch, the page show
 *   (generation) and route (the caller's scope), and the list id, through the transport's rule (JE.arrLists.ticket).
 *   It also holds that page's Spoiler Guard policy. Pausing, disposing or another list on the page revokes it at once.
 * - {@link paint}(ticket, fn) runs fn now, synchronously, only while the ticket is current AND its Spoiler policy is
 *   resolved. Otherwise nothing is written. A paint dropped only because the policy is still loading is kept, the newest
 *   per key, and run once when the policy resolves, if the ticket is still current then. A resolved ticket never queues,
 *   so nothing can re-queue itself.
 * - Until it resolves, a ticket's policy is {@link FAIL_CLOSED}: everything guarded, air dates hidden. A policy that
 *   fails to load resolves to that guard-everything policy.
 * - {@link erase}(fn) is for taking things away (rows, sections, marks, JE's header label). It needs no ticket: removing
 *   what JE drew is always safe. It must never put anything in; the frontend tests' DOM-write spy checks both.
 *
 * Internal: lp.gate { issue, paint, erase, policy, scope, FAIL_CLOSED }.
 */
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const lp = JE.internals.arrListPages = JE.internals.arrListPages || {};

    /** Most paints kept per ticket while its policy loads (one per key; keys are a handful per controller). */
    const MAX_QUEUED = 16;
    /** Marks the tickets made here (a transport ticket alone has no policy and never paints). */
    const GATE = Symbol('je-list-gate');
    /** What runs now: 'paint', 'erase' or nothing (for the tests' DOM-write spy). */
    const scopes = [];

    /**
     * A resolved Spoiler policy: a guard test with whether guarded entries lose their air dates.
     * @param {function(Object): boolean} test guarded(entry).
     * @param {boolean} airDates Guarded entries lose their air dates.
     * @returns {function(Object): boolean & {airDates: boolean, resolved: boolean}} Policy.
     */
    function policy(test, airDates) {
        const guarded = (ph) => test(ph) === true;
        guarded.airDates = airDates === true;
        guarded.resolved = true;
        return Object.freeze(guarded);
    }

    /** The policy before it is known: every entry guarded (no episode titles, notes or air dates). Never paints. */
    const FAIL_CLOSED = (() => {
        const guarded = () => true;
        guarded.airDates = true;
        guarded.resolved = false;
        return Object.freeze(guarded);
    })();

    /** What a policy that can't be read resolves to: the same, but resolved. */
    const GUARD_ALL = policy(() => true, true);

    /**
     * Runs fn in a scope.
     * @param {'paint'|'erase'} name Scope.
     * @param {function(): void} fn Writes.
     */
    function within(name, fn) {
        scopes.push(name);
        try {
            fn();
        } finally {
            scopes.pop();
        }
    }

    /**
     * A ticket for one controller's page.
     * @param {string} listId List id.
     * @param {function(): boolean} scope The page's part (page show, route, page shown, controller not paused).
     * @param {Object|function(): Promise<Object>} spoiler A resolved policy, or what loads it (once, now).
     * @returns {{epoch: number, listId: string, current: function(): boolean, accepts: function(Object=): boolean,
     *   revoke: function(): void, policy: Object, ready: Promise<Object>}} Ticket.
     */
    function issue(listId, scope, spoiler) {
        let revoked = false;
        let resolved = null;
        /** @type {Map<string, function(): void>} paints waiting for the policy (newest per key) */
        const queue = new Map();
        const rule = JE.arrLists.ticket(listId, () => !revoked && (typeof scope !== 'function' || scope() === true));
        const ticket = {
            [GATE]: true,
            epoch: rule.epoch,
            listId: rule.listId,
            current: rule.current,
            accepts: rule.accepts,
            /** Ends the ticket: nothing it would paint is painted, now or later. */
            revoke: () => {
                revoked = true;
                queue.clear();
            },
            /** @returns {Object} The resolved policy, or FAIL_CLOSED while it loads. */
            get policy() {
                return resolved || FAIL_CLOSED;
            },
            /**
             * Keeps a paint for when the policy resolves (only before it does).
             * @param {string} key Key (a newer paint of the same key replaces it).
             * @param {function(): void} fn Writes.
             */
            hold: (key, fn) => {
                if (resolved || revoked) return;
                if (!queue.has(key) && queue.size >= MAX_QUEUED) return;
                queue.delete(key);
                queue.set(key, fn);
            },
            ready: null
        };
        /**
         * The policy is known: run what was held, once, while the ticket is still current.
         * @param {Object} value Policy.
         */
        const settle = (value) => {
            if (resolved) return;
            resolved = value && value.resolved === true && typeof value === 'function' ? value : GUARD_ALL;
            const held = Array.from(queue.values());
            queue.clear();
            for (const fn of held) paint(ticket, fn);
        };
        if (typeof spoiler === 'function' && spoiler.resolved !== true) {
            let loading;
            try {
                loading = Promise.resolve(spoiler());
            } catch (err) {
                loading = Promise.reject(err);
            }
            ticket.ready = loading.then(settle, () => settle(GUARD_ALL)).then(() => ticket.policy);
        } else {
            settle(spoiler);
            ticket.ready = Promise.resolve(ticket.policy);
        }
        return ticket;
    }

    /**
     * Runs fn now if the ticket is current and its Spoiler policy resolved; else drops it (held for the policy, newest
     * per key, when only the policy is missing).
     * @param {Object|null} ticket A ticket from {@link issue}.
     * @param {function(): void} fn The DOM writes.
     * @param {string} [key] What it draws (a newer held paint of the same key replaces an older one).
     * @returns {boolean} Painted now.
     */
    function paint(ticket, fn, key = 'paint') {
        if (!ticket || ticket[GATE] !== true || typeof fn !== 'function' || !ticket.current()) return false;
        if (ticket.policy.resolved !== true) {
            ticket.hold(key, fn);
            return false;
        }
        within('paint', fn);
        return true;
    }

    /**
     * Takes away what JE drew (always allowed; never puts anything in).
     * @param {function(): void} fn Removals.
     */
    function erase(fn) {
        if (typeof fn === 'function') within('erase', fn);
    }

    /** @returns {string} The scope running now ('paint', 'erase' or ''). */
    function scope() {
        return scopes.length ? scopes[scopes.length - 1] : '';
    }

    lp.gate = { issue, paint, erase, policy, scope, FAIL_CLOSED, GUARD_ALL };
})(window.JellyfinEnhanced);
