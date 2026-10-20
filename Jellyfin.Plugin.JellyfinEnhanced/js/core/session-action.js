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
    const NATIVE = JE.NATIVE = Object.freeze({ native: true, current: () => true });

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
    /** The owner `x` names (see ownerOf), or null after {@link missing} when it names none. */
    JE.requireOwner = (x, site) => ownerOf(x) || missing(site || 'an owner-taking call');
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
        if (owner && owner !== NATIVE) presses.set(event, owner);
        return source.dispatchEvent(event);
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

    /**
     * Opens a host dialog (jellyfin-web's Dashboard.alert or confirm) for `owner` (required, D46S2-R7-4), an opener like
     * every other: nothing opens unless the owner is current, and the dialog it opened for an operation is dismissed once
     * that operation ends, at the next lifecycle step ({@link JE.endScopes}). The host returns no handle (12.2's alert
     * returns nothing) and may add its container a moment later, so the containers added to the body after `open()`
     * are the dialog's. Returns the host's result, or null when nothing opened.
     */
    JE.openHostDialog = function (open, owner) {
        const resolved = JE.requireOwner(owner, 'openHostDialog');
        if (!resolved || resolved.current() === false) return null;
        const operation = operationOf(resolved);
        if (!operation) return open();
        const mine = new Set();
        const observer = new MutationObserver(records => {
            for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1 && node.matches(HOST_DIALOG)) mine.add(node);
            if (mine.size) observer.disconnect();
        });
        observer.observe(document.body, { childList: true });
        setTimeout(() => observer.disconnect(), 5000);
        let surfaces = scopes.get(operation);
        if (!surfaces) scopes.set(operation, surfaces = new Set());
        const release = () => { surfaces.delete(entry); if (!surfaces.size && scopes.get(operation) === surfaces) scopes.delete(operation); };
        const entry = { close: () => { release(); observer.disconnect(); mine.forEach(dismissHostDialog); } };
        surfaces.add(entry);
        const result = open();
        for (const record of observer.takeRecords()) for (const node of record.addedNodes) if (node.nodeType === 1 && node.matches(HOST_DIALOG)) mine.add(node);
        if (mine.size) observer.disconnect();
        if (operation.current() === false) queueMicrotask(entry.close);
        return result;
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
