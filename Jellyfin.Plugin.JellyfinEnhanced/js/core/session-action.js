/** Deferred feature actions belong to the viewer and session that started them. */
(function (JE) {
    'use strict';
    const dismissals = new Set();
    // Operation scopes (D46S2-R5): the UI each operation opened, and the owner each such surface belongs to.
    const scopes = new Map();
    const owners = new WeakMap();
    // Presses dispatched for an operation (a title action pressing an owner's control): event → operation.
    const presses = new WeakMap();
    JE.session?.onUserChange?.('session-actions', () => {
        for (const dismiss of [...dismissals]) dismiss();
        dismissals.clear();
        JE.endScopes();
    });

    /**
     * The owner of work started at a genuine native entry point (no title action): never ends, binds nothing (D46S2-R6).
     * Every opener and owned write takes an owner explicitly: an operation, this, or a node / press it derives from.
     */
    const NATIVE = Object.freeze({ native: true, current: () => true });

    // Effect contexts (D46S2-R9-1, R9-4): who is acting right now, known at run time. A press dispatched for an operation
    // ({@link JE.press}) and the checked runners ({@link JE.runAs}, {@link JE.later}) push their owner while their code
    // runs; otherwise an event being dispatched (a viewer's gesture, a host event) is a native context, and anything else
    // (a raw timer or promise continuation) has none.
    const contexts = [];
    function context() {
        if (contexts.length) return contexts[contexts.length - 1];
        const event = window.event;
        return event && typeof event === 'object' ? (presses.get(event) || NATIVE) : null;
    }
    /** True while an operation (not native) is acting: inside its press or its runner. */
    const inOperation = () => { const acting = context(); return !!acting && acting !== NATIVE; };

    /**
     * A dropped or unprovable owner at an effect: a programming error. Throws in tests (JE.strictOwners); else it is
     * logged and refused (null). A test observing the production behaviour sets JE.strictOwners = 'record': refused,
     * and the message kept in JE.refusals.
     */
    function refused(why) {
        const message = `Jellyfin Enhanced: ${why}`;
        if (JE.strictOwners === true) throw new Error(message);
        if (JE.strictOwners === 'record') (JE.refusals = JE.refusals || []).push(message);
        else console.error(message);
        return null;
    }

    /**
     * JE.NATIVE (D46S2-R9-4): named only where a native context is acting now (a viewer's gesture or host event being
     * dispatched, or a native runner), never inside an operation's press or runner (that operation's owner would be
     * dropped) nor in a raw timer or continuation (who acts there cannot be known: capture it at the gesture, or
     * continue through {@link JE.later} / {@link JE.runAs}). Elsewhere it throws in tests and is null in production, so
     * whatever it was meant to open opens nothing.
     */
    Object.defineProperty(JE, 'NATIVE', { configurable: true, enumerable: true, get() {
        const acting = context();
        if (acting === NATIVE) return NATIVE;
        return refused(acting ? 'JE.NATIVE was named inside an operation (its owner was dropped)'
            : 'JE.NATIVE was named outside a native context (a raw timer or continuation)');
    } });

    /** The owner of the registered surface `node` is in (or is), else null. */
    function scopeOf(node) {
        for (let n = node; n; n = n.parentNode || n.host) { const owner = owners.get(n); if (owner) return owner; }
        return null;
    }

    /**
     * Resolves an explicit owner (D46S2-R6: nothing is inferred from an ambient press or event). `x`: an operation
     * (anything with current()); JE.NATIVE; a node: the owner of the registered surface it is in, else NATIVE when it is
     * on the page (every surface opened for an operation is registered, so the page itself is native) and null when it
     * is detached; an event: the operation it was dispatched for ({@link JE.press}), else its target's. Null: unknown.
     */
    function ownerOf(x) {
        if (x === NATIVE) return NATIVE;
        if (!x || typeof x !== 'object') return null;
        if (typeof x.current === 'function') return x;
        if (typeof x.nodeType === 'number') return scopeOf(x) || (x.isConnected ? NATIVE : null);
        if (typeof x.type === 'string' && 'target' in x) return presses.get(x) || ownerOf(x.composedPath?.()[0] || x.target);
        return null;
    }

    /**
     * An owner-taking call (an opener, an owned write) made without one: a programming error. Tests set
     * JE.strictOwners and it throws there; in production it is logged and the call opens and sends nothing.
     */
    function missing(site) {
        const message = `Jellyfin Enhanced: ${site} was called without an owner`;
        if (JE.strictOwners === true) throw new Error(message);
        console.error(message);
        return null;
    }

    JE.ownerOf = ownerOf;
    /**
     * The owner `x` names (see ownerOf), or null after {@link missing} when it names none. Every owner-taking call (an
     * opener, an owned write, a publication, a runner) resolves its owner here, so a native owner named while an
     * operation is acting (its press or runner) is refused at run time (D46S2-R9-4): that operation's owner was dropped.
     */
    JE.requireOwner = (x, site) => {
        const owner = ownerOf(x) || missing(site || 'an owner-taking call');
        return owner === NATIVE && inOperation() ? refused(`${site || 'an owner-taking call'} took a native owner inside an operation (its owner was dropped)`) : owner;
    };
    /**
     * The owner an effect acts for, checked at the moment of the effect (D46S2-R9-1: opening a window, sheet or dialog,
     * navigating, publishing, a delayed refresh): resolved as {@link JE.requireOwner} does and current now. Null: the
     * effect does not happen.
     */
    JE.effectOwner = (x, site) => {
        const owner = JE.requireOwner(x, site);
        return owner && owner.current() !== false ? owner : null;
    };
    /**
     * The checked runner (D46S2-R9-1): runs `fn` as `owner` (an operation, a publication or JE.NATIVE) only while it is
     * current now, with that owner acting (see JE.NATIVE); else nothing runs. Continuations and timers of owned work
     * run through here or {@link JE.later}.
     */
    JE.runAs = function (owner, fn) {
        const resolved = JE.effectOwner(owner, 'runAs');
        if (!resolved) return undefined;
        // A publication (or action) of a native owner acts natively; anything else acts as itself.
        contexts.push(resolved.owner === NATIVE ? NATIVE : resolved);
        try { return fn(); } finally { contexts.pop(); }
    };
    /** A timer through the checked runner: `fn` runs after `ms` only if `owner` is current then. Returns cancel(). */
    JE.later = function (owner, fn, ms) {
        const resolved = JE.requireOwner(owner, 'later');
        if (!resolved) return () => {};
        const timer = setTimeout(() => JE.runAs(resolved, fn), ms);
        return () => clearTimeout(timer);
    };
    /**
     * A genuine native root that runs without a gesture (a page's own lifecycle, a default for callers outside every
     * title action): JE.NATIVE, unless an operation is acting now (refused: see JE.requireOwner). `reason` says why.
     */
    /**
     * The surface a completion's answer goes to (D46S2-R9-2): a connected node, resolved before anything it came from
     * goes. None (unknown, e.g. a portaled popup whose source was lost) fails closed: an error (throws in tests), and
     * the caller opens and sends nothing; one that left the page is null without an error.
     */
    JE.requireOrigin = (node, site) => !node || node.nodeType !== 1 ? refused(`${site} has no origin (nothing opens or is sent)`) : node.isConnected ? node : null;
    /**
     * A write sent without its binding (the transport asks, D46S2-R9-4): true (refused) while an operation is acting (its
     * press or runner), which dropped that operation's owner; it throws in tests. Natively the write is unchanged.
     */
    JE.refuseUnboundWrite = what => inOperation() && refused(`${what} was sent without its binding inside an operation (its owner was dropped)`) === null;
    JE.nativeRoot = reason => inOperation() ? refused(`a native root (${reason}) inside an operation (its owner was dropped)`) : NATIVE;
    /** The operation an owner stands for (null for NATIVE or none). */
    const operationOf = owner => owner && owner !== NATIVE ? owner : null;
    JE.scopeOf = scopeOf;

    /**
     * Presses `source` for `owner` (a title action pressing an owner's control, D46S2-R6): a fresh click event that
     * carries its owner, which the control's handler reads explicitly ({@link JE.ownerOf}(event)). Like click(), a
     * disabled control is not pressed.
     */
    JE.press = function (source, owner) {
        if (!source || source.disabled) return false;
        const event = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
        const resolved = owner ? JE.requireOwner(owner, 'press') : null;
        if (owner && !resolved) return false;
        if (resolved && resolved !== NATIVE) presses.set(event, resolved);
        // The operation acts while its press is dispatched (D46S2-R9-4): whatever its handlers name natively is refused.
        if (resolved && resolved !== NATIVE) contexts.push(resolved);
        try { return source.dispatchEvent(event); } finally { if (resolved && resolved !== NATIVE) contexts.pop(); }
    };

    /**
     * Takes the owner an owner was invoked for (`owner`: an operation, JE.NATIVE, a node inside UI it opened or the press
     * event; required) at its entry point, for work that continues after an await. `current()` is true natively;
     * `bound()` is the transport binding (none natively). Without an owner (see missing) nothing it guards proceeds.
     */
    JE.captureSubmitted = function (owner) {
        const resolved = JE.requireOwner(owner, 'captureSubmitted');
        const operation = operationOf(resolved);
        const session = operation || !resolved ? JE.createSessionAction().session : null;
        const current = () => !!resolved && (!operation || operation.current() !== false);
        return { owner: resolved, operation, current,
            /**
             * The transport binding of a write this operation owns (core api-client `bound`): sent only while the
             * session at the entry point is the signed-in one, the operation is current and `check()` (when given)
             * is true, checked right before the bytes go out. Natively none: the call is unchanged. Unknown owner: never sent.
             */
            bound: check => !resolved ? { session, current: () => false }
                : operation ? { session, current: () => operation.current() !== false && (!check || check() === true) } : undefined };
    };

    /**
     * UI opened for an operation (a form, sheet, drawer or window) only closes once `ended(event)`: a click,
     * middle-click or form submission inside `root` is cancelled whole first, its default included (no
     * link opens, no form submits, no native control acts), and then `close()` runs.
     */
    JE.rejectEnded = function (root, ended, close) {
        const reject = event => {
            if (!ended(event)) return;
            event.preventDefault(); event.stopImmediatePropagation();
            close(event);
        };
        for (const type of ['click', 'auxclick', 'submit']) root.addEventListener(type, reject, true);
    };

    /**
     * Registers UI opened for an owner (D46S2-R5/R6): a sheet, drawer, modal, popup portaled to the body or a nested
     * owner's modal. `owner` is required (see JE.ownerOf); NATIVE registers the surface as native, so what opens from
     * inside it is native too. Once an operation ends its surfaces take no more input (JE.rejectEnded) and `close()`
     * runs at the next lifecycle step ({@link JE.endScopes}); opened after it ended, or without an owner, a surface
     * closes at once. A press dispatched inside it for another, current operation (an owned control of a closed sheet)
     * is that operation's own. Returns release() for a normal close.
     */
    JE.openSurface = function (root, close, owner) {
        const resolved = JE.requireOwner(owner, 'openSurface');
        if (!root) return () => {};
        if (!resolved) { queueMicrotask(close); return () => {}; }
        owners.set(root, resolved);
        if (resolved === NATIVE) return () => {};
        let surfaces = scopes.get(resolved);
        if (!surfaces) scopes.set(resolved, surfaces = new Set());
        const entry = { close: null };
        const release = () => { surfaces.delete(entry); if (!surfaces.size && scopes.get(resolved) === surfaces) scopes.delete(resolved); };
        entry.close = () => { if (!surfaces.has(entry)) return; release(); close(); };
        surfaces.add(entry);
        JE.rejectEnded(root, event => {
            if (resolved.current() !== false) return false;
            const pressed = event && presses.get(event);
            return !(pressed && pressed !== resolved && pressed.current() !== false);
        }, entry.close);
        if (resolved.current() === false) queueMicrotask(entry.close);
        return release;
    };

    /** Closes every registered surface whose operation has ended; each lifecycle step (route, user, document, mount) calls it. */
    JE.endScopes = function () {
        for (const [operation, surfaces] of [...scopes]) {
            if (operation.current() !== false) continue;
            for (const entry of [...surfaces]) { try { entry.close(); } catch (error) { console.error('Jellyfin Enhanced: closing an ended surface failed', error); } }
        }
    };

    // jellyfin-web's dialogs (Dashboard.alert, Dashboard.confirm): each opens in its own container on the body.
    const HOST_DIALOG = '.dialogContainer';
    /** Dismisses a host dialog the way its viewer would: its first button, else the container goes. */
    function dismissHostDialog(node) {
        if (!node.isConnected) return;
        const button = node.querySelector('.btnOption, .formDialogFooterItem, button');
        if (button) button.click(); else node.remove();
    }

    // Host dialog openings waiting for their container (D46S2-R9-6): one per open() call, native ones included. The host
    // returns no handle and adds the container a moment later (12.2: ~12 ms, 10.11.11: ~16 ms), so each container that
    // joins the body is claimed by exactly one opening: the oldest one whose words it shows, else the oldest one (the host
    // adds them in call order). One opening, one container.
    const openings = [];
    const claimed = new WeakSet();
    let hostObserver = null;
    function hostArrived(records) {
        for (const record of records) for (const node of record.addedNodes) {
            if (node.nodeType !== 1 || !node.matches(HOST_DIALOG) || claimed.has(node) || !openings.length) continue;
            const text = node.textContent || '';
            let index = openings.findIndex(o => o.words && text.includes(o.words));
            if (index < 0) index = 0;
            const [opening] = openings.splice(index, 1);
            claimed.add(node);
            opening.arrive(node);
        }
        if (!openings.length && hostObserver) { hostObserver.disconnect(); hostObserver = null; }
    }
    function waitForContainer(opening) {
        openings.push(opening);
        if (!hostObserver) { hostObserver = new MutationObserver(hostArrived); hostObserver.observe(document.body, { childList: true }); }
        // A container later than 5 s after the call is not this opening's.
        setTimeout(() => { const index = openings.indexOf(opening); if (index >= 0) openings.splice(index, 1); hostArrived([]); }, 5000);
    }

    /**
     * Opens a host dialog (jellyfin-web's Dashboard.alert or confirm) for `owner` (required, D46S2-R7-4), an opener like
     * every other: nothing opens unless the owner is current at the call ({@link JE.effectOwner}), and the dialog it opened
     * for an operation is dismissed once that operation ends, at the next lifecycle step ({@link JE.endScopes}). The
     * opening claims the one container the host adds for it (`words`, when given: text the dialog shows, so overlapping
     * openings each find their own; D46S2-R9-6); one that attaches after its operation ended is dismissed as it arrives
     * (D46S2-R8-4). Returns the host's result, or null when nothing opened.
     */
    JE.openHostDialog = function (open, owner, words) {
        const resolved = JE.effectOwner(owner, 'openHostDialog');
        if (!resolved) return null;
        const operation = operationOf(resolved);
        const opening = { words: words ? String(words) : '', node: null, ended: false,
            arrive(node) {
                opening.node = node;
                if (operation && (opening.ended || operation.current() === false)) dismissHostDialog(node);
            } };
        waitForContainer(opening);
        if (!operation) { const result = open(); if (hostObserver) hostArrived(hostObserver.takeRecords()); return result; }
        let surfaces = scopes.get(operation);
        if (!surfaces) scopes.set(operation, surfaces = new Set());
        const release = () => { surfaces.delete(entry); if (!surfaces.size && scopes.get(operation) === surfaces) scopes.delete(operation); };
        // Ended before its dialog arrived: the opening keeps waiting (up to its 5 s) and dismisses it on arrival.
        const entry = { close: () => { opening.ended = true; release(); if (opening.node) dismissHostDialog(opening.node); } };
        surfaces.add(entry);
        const result = open();
        if (hostObserver) hostArrived(hostObserver.takeRecords());
        if (operation.current() === false) queueMicrotask(entry.close);
        return result;
    };

    // Each surface's intents (D46S2-R8-2, R9-3): its reads, and the writes that answer into it, one slot per write identity.
    const intents = new WeakMap();
    /**
     * Starts an intent of `surface` (a window, a card, a form's opener) and returns its check, also false once `owner`
     * (when given) ends. A read (no `key`: a Refresh, a redraw) holds while no later intent of the surface has started;
     * a write (`key`: its identity, see {@link JE.publication}) holds while no later read of the surface and no later
     * write of the same identity has started, so a standard and a 4K request answer independently (D46S2-R9-3) while a
     * Refresh or a replacement still supersedes both.
     */
    JE.surfaceIntent = function (surface, owner, key) {
        let slot = intents.get(surface);
        if (!slot) intents.set(surface, slot = { all: 0, reads: 0, writes: new Map() });
        const mine = ++slot.all;
        const live = () => !owner || owner.current() !== false;
        if (key == null) { slot.reads = mine; return () => slot.all === mine && live(); }
        const reads = slot.reads;
        slot.writes.set(key, mine);
        return () => slot.reads === reads && slot.writes.get(key) === mine && live();
    };

    // Nodes naming a title, and the surfaces that draw what they show from their own reads (they take only their own
    // publications; a card elsewhere follows any publication of its title).
    const NAMED = '[data-tmdb-id][data-media-type]';
    const SELF_DRAWN = '.je-more-info-modal';
    /**
     * The title a node shows: {tmdbId, mediaType, edition}. A control (a button) shows one edition (data-je-edition,
     * a 4K toggle, arrow or popup item: '4k'; else 'standard'); a surface (a window, a card) shows both (null). What the
     * node does not name comes from the nearest ancestor that names a title; null when there is none.
     */
    function identityOf(node) {
        if (!node || node.nodeType !== 1) return null;
        const named = node.matches(NAMED) ? node : node.closest(NAMED);
        const tmdbId = node.dataset.tmdbId || named?.dataset.tmdbId;
        const mediaType = node.dataset.mediaType || named?.dataset.mediaType;
        if (!tmdbId || !mediaType) return null;
        const edition = !node.matches('button, [role="button"]') ? null
            : node.dataset.jeEdition === '4k' || node.dataset.toggle4k === 'true' || node.matches('.jellyseerr-split-arrow, .je-4k-popup-item, .jellyseerr-4k-popup-item') ? '4k' : 'standard';
        return { tmdbId: String(tmdbId), mediaType: String(mediaType).toLowerCase(), edition };
    }
    JE.identityOf = identityOf;

    // The surfaces that follow publications (D46S2-R9-5): a window, the search and discovery cards.
    const followers = new Set();
    /**
     * Follows the publications of completions (D46S2-R9-5): `apply(node, answer, publication)` runs for each node of
     * `candidates()` that a publication reaches ({@link JE.publication} reaches()), at the moment it is published, and
     * never otherwise: there is no event to listen to and no test to get wrong. `answer`: the detail it was published
     * with plus {tmdbId, mediaType, is4k, variant}. Returns unfollow().
     */
    JE.followPublications = function (candidates, apply) {
        const follower = { candidates, apply };
        followers.add(follower);
        return () => followers.delete(follower);
    };

    /**
     * The publication of a completion (D46S2-R8-2, R8-6, R9-5), taken before the write's await: the only handle that
     * may change UI for its answer (chips, labels, the cards that follow the title, a refusal's dialog). `owner`
     * (required): the press's; `surface`: the window, card or form opener the write started in, shown while connected
     * and not closing; its newest intent for this identity starts here (a later read of the surface, or a later write
     * of the same identity, supersedes it: {@link JE.surfaceIntent}); `identity`: {tmdbId, mediaType, is4k, variant}
     * (title, media type, edition and an optional variant such as a season set: `key`).
     * `current()` holds while all four do, so a publication is an owner too: a dialog opened for it opens only while it
     * holds and closes with it. Its effects check it at the moment they happen, so no caller decides:
     * `run(fn)`: fn() now, only while current (its own surface's labels, its toast); `apply(node, fn)`: fn(node) only
     * while it reaches `node`; `publish(detail)`: the followers' apply for every node it reaches ({@link
     * JE.followPublications}). `reaches(node)`: current, and `node` shows this title and media type (a control: this
     * edition) inside the surface, or outside every window (a card following the title elsewhere).
     */
    JE.publication = function ({ owner, surface, identity }) {
        const resolved = JE.requireOwner(owner, 'publication');
        const id = identity ? { tmdbId: String(identity.tmdbId), mediaType: String(identity.mediaType || '').toLowerCase(), edition: identity.is4k ? '4k' : 'standard',
            variant: identity.variant == null ? '' : String(identity.variant) } : null;
        const key = id ? `${id.tmdbId}|${id.mediaType}|${id.edition}|${id.variant}` : '';
        const newest = surface && resolved ? JE.surfaceIntent(surface, resolved, key) : () => false;
        const current = () => !!resolved && !!surface && surface.isConnected === true && !surface._isClosing && newest();
        const self = {
            owner: resolved, surface, identity: id, key, current,
            reaches(node) {
                if (!id || !node || !current()) return false;
                const shows = identityOf(node);
                // Its own surface, even one that names no title (an opener drawn without its ids).
                if (!shows) return node === surface;
                if (shows.tmdbId !== id.tmdbId || shows.mediaType !== id.mediaType || (shows.edition && shows.edition !== id.edition)) return false;
                return node === surface || surface.contains(node) || !node.closest(SELF_DRAWN);
            },
            run(fn) {
                if (!current()) return false;
                fn();
                return true;
            },
            apply(node, fn) {
                if (!self.reaches(node)) return false;
                fn(node);
                return true;
            },
            publish(detail = {}) {
                if (!id || !current()) return false;
                const answer = Object.freeze({ ...detail, tmdbId: id.tmdbId, mediaType: id.mediaType, is4k: id.edition === '4k', variant: id.variant });
                for (const follower of [...followers]) {
                    try {
                        for (const node of [...follower.candidates()]) if (self.reaches(node)) follower.apply(node, answer, self);
                    } catch (error) {
                        if (JE.strictOwners === true && /^Jellyfin Enhanced: /.test(error?.message || '')) throw error;
                        console.error('Jellyfin Enhanced: a publication follower failed', error);
                    }
                }
                return true;
            },
        };
        return self;
    };

    /**
     * Publication for the newest intent of one surface (D46S2-R6 shape 3): each call starts an intent and returns its
     * check, true only while no later intent of the same surface has started and `owner` (when given) is current. A
     * read's answer renders only while its check holds, so an older, slower answer never replaces a newer one.
     */
    JE.latestIntent = function () {
        let latest = 0;
        return owner => { const mine = ++latest; return () => mine === latest && (!owner || owner.current() !== false); };
    };

    /**
     * Captures identity before a gesture, confirmation, timer or asynchronous lookup. With `{ owner }` (required
     * whenever the work belongs to whoever invoked it: an operation, JE.NATIVE, a node or the press event), an owner
     * whose write follows a confirmation or an await also stays bound to that operation, so its existing check before
     * the write covers it. Nothing is inferred (D46S2-R6): `{ submitted: true }` is refused like a missing owner.
     */
    JE.createSessionAction = function (options) {
        const owned = !!options && ('owner' in options || 'submitted' in options);
        const resolved = owned ? ('owner' in options ? JE.requireOwner(options.owner, 'createSessionAction') : missing('createSessionAction({ submitted })')) : NATIVE;
        const operation = operationOf(resolved);
        const user = ApiClient.getCurrentUserId();
        const epoch = JE.session?.getEpoch?.();
        const serverId = () => typeof ApiClient.serverId === 'function' ? ApiClient.serverId() : ApiClient.serverId;
        const server = serverId();
        const token = ApiClient.accessToken();
        /** Checks both live identity and epoch, including hosts with delayed session detection. */
        const identity = () => ApiClient.getCurrentUserId() === user && serverId() === server &&
            ApiClient.accessToken() === token && JE.session?.isCurrent?.(epoch) !== false;
        const current = () => !!resolved && identity() && (!operation || operation.current() !== false);
        /** The captured session as the core transport's bound requests carry it (JE.core.api.session()'s shape). */
        const session = Object.freeze({ userId: user, serverId: server, token, epoch, current: identity });
        /**
         * The request binding for work this action owns: the transport sends it only while this session is the
         * signed-in one, the operation it is bound to (if any) is current and `owner()` (when given) is true,
         * checked immediately before the bytes go out.
         * @param {() => boolean} [owner]
         */
        const bound = owner => ({ session, current: () => !!resolved && (!operation || operation.current() !== false) && (!owner || owner() === true) });
        return {
            current,
            session,
            /** The operation this action is bound to (null natively). */
            operation,
            /** Its owner: the operation, JE.NATIVE, or null when an owner-taking call named none. */
            owner: resolved,
            bound,
            /** `bound(owner)` for a write that belongs to an operation; natively none (the call is unchanged); no owner: never sent. */
            operationBound: owner => operation || !resolved ? bound(owner) : undefined,
            /** Rejects a deferred callback after either identity or epoch changes. */
            bind: callback => (...args) => current() ? callback(...args) : false,
            /** Registers owned UI cleanup; returns a release function for normal dismissal. */
            onCancel: dismiss => {
                dismissals.add(dismiss);
                return () => dismissals.delete(dismiss);
            }
        };
    };
})(window.JellyfinEnhanced);
