/** Deferred feature actions belong to the viewer and session that started them. */
(function (JE) {
    'use strict';
    const dismissals = new Set();
    let submitted = null;
    // Operation scopes (D46S2-R5): the UI each operation opened, and the operation each such surface belongs to.
    const scopes = new Map();
    const owners = new WeakMap();
    JE.session?.onUserChange?.('session-actions', () => {
        for (const dismiss of [...dismissals]) dismiss();
        dismissals.clear();
        JE.endScopes();
    });

    /** The operation whose registered surface `node` is in (or is), else null. */
    function scopeOf(node) {
        for (let n = node; n; n = n.parentNode || n.host) { const operation = owners.get(n); if (operation) return operation; }
        return null;
    }

    /**
     * The operation in progress: `explicit` (an operation, or a node inside UI an operation opened), else the press
     * being dispatched (JE.runSubmitted), else the surface the event being handled happened in. Null natively.
     */
    function resolve(explicit) {
        if (explicit && typeof explicit.current === 'function') return explicit;
        const node = explicit && typeof explicit.nodeType === 'number' ? scopeOf(explicit) : null;
        if (node) return node;
        if (submitted) return submitted;
        const event = window.event;
        const target = event?.composedPath?.()[0] || event?.target;
        return target && typeof target.nodeType === 'number' ? scopeOf(target) : null;
    }

    /**
     * Runs an owner's control on behalf of an operation a person submitted elsewhere (a title action
     * sheet or row). Only the synchronous run carries it; owners pick it up below.
     */
    JE.runSubmitted = function (operation, run) {
        const prior = submitted;
        submitted = operation || null;
        try { return run(); } finally { submitted = prior; }
    };

    /**
     * Takes the operation an owner was invoked for (`explicit`: an operation or a node inside UI it opened; else the
     * dispatched press or the surface the handled event is in) at its entry point, for work that continues after an
     * await. `current()` is true when invoked natively (none); `run(next)` hands it on to the next owner (a modal's
     * submit, the write it calls).
     */
    JE.captureSubmitted = function (explicit) {
        const operation = resolve(explicit);
        const session = operation ? JE.createSessionAction().session : null;
        return { operation, current: () => !operation || operation.current() !== false, run: next => JE.runSubmitted(operation, next),
            /**
             * The transport binding of a write this operation owns (core api-client `bound`): sent only while the
             * session at the entry point is the signed-in one, the operation is current and `owner()` (when given)
             * is true, checked right before the bytes go out. Natively (no operation) none: the call is unchanged.
             */
            bound: owner => operation ? { session, current: () => operation.current() !== false && (!owner || owner() === true) } : undefined };
    };

    /**
     * UI opened for an operation (a form, sheet, drawer or window) only closes once `ended()`: a click,
     * middle-click or form submission inside `root` is cancelled whole first, its default included (no
     * link opens, no form submits, no native control acts), and then `close()` runs.
     */
    JE.rejectEnded = function (root, ended, close) {
        const reject = event => {
            if (!ended()) return;
            event.preventDefault(); event.stopImmediatePropagation();
            close(event);
        };
        for (const type of ['click', 'auxclick', 'submit']) root.addEventListener(type, reject, true);
    };

    /**
     * Registers UI opened for an operation in its scope (D46S2-R5): a sheet, drawer, modal, popup portaled to the body or
     * a nested owner's modal. `operation`: the operation, or a node inside UI it opened; undefined takes the one in
     * progress; null (natively) registers nothing and changes nothing. Once the operation ends the surface takes no more
     * input (JE.rejectEnded) and `close()` runs at the next lifecycle step ({@link JE.endScopes}), so nothing outlives
     * its operation; opened after it ended, it closes at once. A press dispatched inside it for another, current
     * operation (an owned control of a closed sheet) is that operation's own. Returns release() for a normal close.
     */
    JE.openSurface = function (root, close, operation) {
        const owner = operation === null ? null : resolve(operation);
        if (!owner || !root) return () => {};
        owners.set(root, owner);
        let surfaces = scopes.get(owner);
        if (!surfaces) scopes.set(owner, surfaces = new Set());
        const entry = { close: null };
        const release = () => { surfaces.delete(entry); if (!surfaces.size && scopes.get(owner) === surfaces) scopes.delete(owner); };
        entry.close = () => { if (!surfaces.has(entry)) return; release(); close(); };
        surfaces.add(entry);
        JE.rejectEnded(root, () => owner.current() === false && !(submitted && submitted !== owner && submitted.current() !== false), entry.close);
        if (owner.current() === false) queueMicrotask(entry.close);
        return release;
    };

    /** Closes every registered surface whose operation has ended; each lifecycle step (route, user, document, mount) calls it. */
    JE.endScopes = function () {
        for (const [operation, surfaces] of [...scopes]) {
            if (operation.current() !== false) continue;
            for (const entry of [...surfaces]) { try { entry.close(); } catch (error) { console.error('Jellyfin Enhanced: closing an ended surface failed', error); } }
        }
    };

    /**
     * Captures identity before a gesture, confirmation, timer or asynchronous lookup. With
     * `{ submitted: true }`, an owner whose write follows a confirmation or an await also stays bound
     * to the operation in progress (the one that dispatched its control, or whose UI it was pressed in),
     * so its existing check before the write covers it.
     */
    JE.createSessionAction = function (options) {
        const operation = options?.submitted ? resolve() : null;
        const user = ApiClient.getCurrentUserId();
        const epoch = JE.session?.getEpoch?.();
        const serverId = () => typeof ApiClient.serverId === 'function' ? ApiClient.serverId() : ApiClient.serverId;
        const server = serverId();
        const token = ApiClient.accessToken();
        /** Checks both live identity and epoch, including hosts with delayed session detection. */
        const identity = () => ApiClient.getCurrentUserId() === user && serverId() === server &&
            ApiClient.accessToken() === token && JE.session?.isCurrent?.(epoch) !== false;
        const current = () => identity() && (!operation || operation.current() !== false);
        /** The captured session as the core transport's bound requests carry it (JE.core.api.session()'s shape). */
        const session = Object.freeze({ userId: user, serverId: server, token, epoch, current: identity });
        /**
         * The request binding for work this action owns: the transport sends it only while this session is the
         * signed-in one, the operation it is bound to (if any) is current and `owner()` (when given) is true,
         * checked immediately before the bytes go out.
         * @param {() => boolean} [owner]
         */
        const bound = owner => ({ session, current: () => (!operation || operation.current() !== false) && (!owner || owner() === true) });
        return {
            current,
            session,
            /** The operation this action is bound to (null natively). */
            operation,
            bound,
            /** `bound(owner)` for a write that belongs to a submitted operation; natively none (the call is unchanged). */
            operationBound: owner => operation ? bound(owner) : undefined,
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
