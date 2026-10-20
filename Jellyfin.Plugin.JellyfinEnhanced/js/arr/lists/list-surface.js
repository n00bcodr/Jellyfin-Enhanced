/**
 * @file Requests & downloads, phase 4c3b: who owns a list authoring surface (a picker, a search, a note editor) and when
 * what it read may still be shown. Nothing runs on load.
 *
 * An **origin** ({@link origin}) is one opened surface: its explicit owner (an operation, or JE.NATIVE only at a
 * declared native root, never as a stand-in for a lost owner), the session it opened in (epoch, person, server), its
 * mount (still in the document) and a live check of the flags and access it needs (asked again at every decision).
 * Once any of these fails it has ended, for good: a person switching back, a re-added mount or a revived predicate
 * never revives it, and the document's pagehide/freeze end it too. It owns:
 * - a real paint ticket with no list (lp.gate.issue(null, ...)) whose Spoiler policy is the viewer's, read through the
 *   policy loader given (guard everything until it is read, or when there is none);
 * - per-channel newest-intent checks ({@link intent}): a newer query, season, reload or read of the same channel makes
 *   the older one's answer unpublishable; channels are independent;
 * - a **target** ({@link selectTarget}): the chosen list, with its own ticket (that list id) and generation. Choosing
 *   another list revokes the old target's ticket and its target-bound intents at once; the origin lives on. A list just
 *   created becomes the target the same way ({@link created}): its read-back runs under the same origin;
 * - {@link publish}/{@link paint}: non-DOM effects (cache, events, toasts, navigation, remembered choices) and DOM
 *   writes happen only for the current origin and the newest intent;
 * - {@link register}: a portal is registered with the shared surface registry (JE.openSurface, from the operation
 *   owner); where the registry isn't there the surface is unavailable and must not be shown;
 * - {@link handoff}: a replacement or a fallback reopen takes the owner captured BEFORE the old surface closes, and
 *   opens nothing if that owner ended meanwhile.
 * {@link inflight}: in-flight work keyed by owner and immutable input; a second press of the same owner joins nothing
 * new, another owner's identical press starts on its own, and a release only removes its own entry.
 *
 * Internal: lp.surface { origin, inflight }.
 */
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const lp = JE.internals.arrListPages = JE.internals.arrListPages || {};

    /** Most in-flight entries kept (the oldest is forgotten beyond it). */
    const MAX_INFLIGHT = 256;

    /**
     * An explicit owner (an operation: anything with current(); JE.NATIVE only at a declared native root). No owner is
     * a programming error: it throws where JE.strictOwners is set (tests), and is logged in production, where nothing
     * opens.
     * @param {*} owner Owner.
     * @param {boolean} nativeRoot The caller is a genuine native entry point.
     * @param {string} site Caller.
     * @returns {Object|null} Owner.
     */
    function requireOwner(owner, nativeRoot, site) {
        const native = owner && owner.native === true;
        if (native && !(nativeRoot === true && JE.NATIVE && owner === JE.NATIVE)) {
            const message = `Jellyfin Enhanced: ${site} was given a native owner outside a native root`;
            if (JE.strictOwners === true) throw new Error(message);
            console.error(message);
            return null;
        }
        if (owner && typeof owner === 'object' && typeof owner.current === 'function') return owner;
        const message = `Jellyfin Enhanced: ${site} was called without an owner`;
        if (JE.strictOwners === true) throw new Error(message);
        console.error(message);
        return null;
    }

    /** @returns {{epoch: number, user: (string|null), server: (string|null)}} The session now. */
    function sessionNow() {
        const s = JE.session;
        return { epoch: s?.getEpoch ? s.getEpoch() : 0, user: s?.getUserId ? s.getUserId() : null, server: s?.getServerId ? s.getServerId() : null };
    }

    /**
     * The viewer's Spoiler policy for a target (or none), or guard-everything.
     * @param {Function|undefined} loader The caller's loader.
     * @param {Object|null} target {listKind, listId} or null.
     * @returns {Object|function(): Promise<Object>} Policy or its loader (lp.gate.issue's argument).
     */
    function policyOf(loader, target) {
        if (typeof loader !== 'function') return lp.gate.GUARD_ALL;
        let value;
        try {
            value = loader(target);
        } catch (error) {
            return () => Promise.reject(error);
        }
        // Known at once (Spoiler Guard off): no wait; else the gate waits for it, guarding everything meanwhile.
        return typeof value === 'function' && value.resolved === true ? value : () => value;
    }

    /**
     * Opens an origin.
     * @param {{owner: Object, nativeRoot?: boolean, mount: Node, live: function(): boolean,
     *   policy?: function(Object|null): (Object|Promise<Object>), openSurface?: Function}} options Options.
     * @returns {Object|null} Origin (null: no owner, or the owner already ended).
     */
    function origin(options) {
        const owner = requireOwner(options?.owner, options?.nativeRoot, 'a list surface');
        if (!owner) return null;
        if (typeof options.live !== 'function') {
            const message = 'Jellyfin Enhanced: a list surface was opened without its live check';
            if (JE.strictOwners === true) throw new Error(message);
            console.error(message);
            return null;
        }
        if (owner.current() === false) return null;
        const { mount, live, policy } = options;
        const opened = sessionNow();
        let ended = false;
        const endListeners = new Set();
        const latest = new Map();
        let generation = 0;
        let target = null;

        /** Ends the origin (once): tickets revoked, listeners released. @param {string} [reason] Why. */
        const end = (reason) => {
            if (ended) return;
            ended = true;
            window.removeEventListener('pagehide', onHide);
            document.removeEventListener('freeze', onHide);
            target?.ticket.revoke();
            ticket.revoke();
            for (const fn of Array.from(endListeners)) {
                try {
                    fn(reason || 'ended');
                } catch (error) {
                    console.warn('🪼 Jellyfin Enhanced: Lists: a surface cleanup failed', error);
                }
            }
            endListeners.clear();
        };
        const onHide = () => end('pagehide');

        /** @returns {boolean} The origin still holds (and ends it for good when it doesn't). */
        const current = () => {
            if (ended) return false;
            const now = sessionNow();
            const ok = owner.current() !== false && now.epoch === opened.epoch && now.user === opened.user && now.server === opened.server
                && !!mount && mount.isConnected === true && live() === true;
            if (!ok) end('lost');
            return ok;
        };

        /** The owner a registered portal answers to: this origin, as long as it holds. */
        const surfaceOwner = Object.freeze({ current });
        const ticket = lp.gate.issue(null, current, policyOf(policy, null));
        window.addEventListener('pagehide', onHide);
        document.addEventListener('freeze', onHide);

        const self = {
            owner,
            ticket,
            current,
            end,
            get ended() {
                return ended || !current();
            },
            /**
             * A check that holds while this is the newest intent of its channel (and, for target-bound ones, the
             * target it began on) and the origin is current.
             * @param {string} channel Channel ('query', 'season', 'reload', 'details', ...).
             * @param {{target?: boolean}} [opts] Bound to the current target.
             * @returns {function(): boolean} Check.
             */
            intent(channel, opts = {}) {
                if (ended) return () => false;
                const mine = (latest.get(channel) || 0) + 1;
                latest.set(channel, mine);
                const gen = generation;
                const bound = opts.target === true;
                return () => latest.get(channel) === mine && (!bound || gen === generation) && current();
            },
            /**
             * Chooses the target list: a new ticket for that list and generation; the old target's is revoked.
             * @param {string} listId List id.
             * @param {{listKind?: string}} [opts] Its kind (for its Spoiler policy).
             * @returns {{listId: string, listKind: string, ticket: Object, generation: number, current: function(): boolean}|null} Target.
             */
            selectTarget(listId, opts = {}) {
                if (!current()) return null;
                target?.ticket.revoke();
                const gen = ++generation;
                const list = { listKind: opts.listKind || 'playlist', listId };
                const targetCurrent = () => gen === generation && current();
                target = { listId, listKind: list.listKind, generation: gen, current: targetCurrent, ticket: lp.gate.issue(listId, targetCurrent, policyOf(policy, list)) };
                return target;
            },
            /** @returns {Object|null} The current target. */
            target: () => (target && target.current() ? target : null),
            /**
             * A list this origin just created: its read-back target, under the same origin.
             * @param {string} listId The new list's id.
             * @param {{listKind?: string}} [opts] Kind.
             * @returns {Object|null} Target.
             */
            created(listId, opts) {
                return self.selectTarget(listId, opts);
            },
            /**
             * Runs a non-DOM effect (cache, event, toast, navigation, remembered choice) for the newest intent only.
             * @param {function(): boolean} check From {@link intent}.
             * @param {function(): void} fn Effect.
             * @returns {boolean} Ran.
             */
            publish(check, fn) {
                if (typeof check !== 'function' || check() !== true || !current()) return false;
                fn();
                return true;
            },
            /**
             * Paints through the gate for the newest intent only.
             * @param {function(): boolean|null} check From {@link intent} (null: no intent).
             * @param {Object} paintTicket This origin's or its target's ticket.
             * @param {function(): void} fn Writes.
             * @param {string} [key] Paint key.
             * @returns {boolean} Painted.
             */
            paint(check, paintTicket, fn, key) {
                if (check && check() !== true) return false;
                if (paintTicket !== ticket && paintTicket !== target?.ticket) return false;
                return lp.gate.paint(paintTicket, fn, key);
            },
            /** @returns {boolean} The shared surface registry is there. */
            registrable: () => typeof (options.openSurface || JE.openSurface) === 'function',
            /**
             * Registers a portal for this origin's owner with the shared registry; it closes when the owner ends.
             * @param {HTMLElement} root The portal.
             * @param {function(): void} close Closes it.
             * @returns {function(): void|null} Release for a normal close, or null: unavailable (don't show it).
             */
            register(root, close) {
                const openSurface = options.openSurface || JE.openSurface;
                if (typeof openSurface !== 'function' || !current()) return null;
                let closed = false;
                const once = () => {
                    if (closed) return;
                    closed = true;
                    close();
                };
                // The portal belongs to this origin: it ends with the owner, the session, the mount or the live check.
                const release = openSurface(root, once, owner === JE.NATIVE ? owner : surfaceOwner);
                endListeners.add(once);
                return () => {
                    closed = true;
                    endListeners.delete(once);
                    if (typeof release === 'function') release();
                };
            },
            /**
             * What a replacement or fallback needs to open for the same owner, taken before this one closes.
             * @returns {Object|null} Options for {@link origin} (null: this one already ended).
             */
            handoff() {
                if (!current()) return null;
                return { owner, nativeRoot: options.nativeRoot, mount, live, policy, openSurface: options.openSurface };
            },
            /**
             * Registers cleanup for when the origin ends; returns an unsubscribe function.
             * @param {function(string): void} fn Cleanup.
             * @returns {function(): void} Unsubscribe.
             */
            onEnd(fn) {
                if (ended) {
                    fn('ended');
                    return () => {};
                }
                endListeners.add(fn);
                return () => endListeners.delete(fn);
            },
            /**
             * Closes normally: focus goes back to the opener only when it is still connected and the origin was live.
             * @param {{opener?: HTMLElement}} [opts] Opener.
             */
            close(opts = {}) {
                const wasLive = current();
                end('closed');
                const opener = opts.opener;
                if (wasLive && opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
            }
        };
        return self;
    }

    /** @type {Map<string, {owner: Object, token: Object}>} in-flight work: key + owner → entry */
    const work = new Map();
    const ownerIds = new WeakMap();
    let ownerSeq = 0;

    /** @param {Object} owner Owner. @returns {number} A stable id for an owner object. */
    function ownerId(owner) {
        if (!ownerIds.has(owner)) ownerIds.set(owner, ++ownerSeq);
        return ownerIds.get(owner);
    }

    const inflight = Object.freeze({
        /**
         * Starts work for an owner and an immutable input key.
         * @param {string} key Input key.
         * @param {Object} owner Owner.
         * @returns {{release: function(): void}|null} The entry, or null: the owner ended or this owner's identical work runs.
         */
        claim(key, owner) {
            if (!owner || typeof owner.current !== 'function' || owner.current() === false) return null;
            const id = `${ownerId(owner)}\u0000${key}`;
            if (work.has(id)) return null;
            if (work.size >= MAX_INFLIGHT) work.delete(work.keys().next().value);
            const token = { release: () => { if (work.get(id)?.token === token) work.delete(id); } };
            work.set(id, { owner, token });
            return token;
        },
        /** @returns {boolean} This owner's work for the key runs. */
        active: (key, owner) => !!owner && work.has(`${ownerId(owner)}\u0000${key}`),
        size: () => work.size
    });

    lp.surface = Object.freeze({ origin, inflight, requireOwner });
})(window.JellyfinEnhanced);
