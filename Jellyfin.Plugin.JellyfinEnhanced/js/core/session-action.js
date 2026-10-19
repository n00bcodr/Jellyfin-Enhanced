/** Deferred feature actions belong to the viewer and session that started them. */
(function (JE) {
    'use strict';
    const dismissals = new Set();
    let submitted = null;
    JE.session?.onUserChange?.('session-actions', () => {
        for (const dismiss of [...dismissals]) dismiss();
        dismissals.clear();
    });

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
     * Takes the operation an owner was invoked for (`explicit`, else the dispatched press) at its entry
     * point, for work that continues after an await. `current()` is true when invoked natively (none);
     * `run(next)` hands it on to the next owner (a modal's submit, the write it calls).
     */
    JE.captureSubmitted = function (explicit) {
        const operation = explicit || submitted;
        return { operation, current: () => !operation || operation.current() !== false, run: next => JE.runSubmitted(operation, next) };
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
     * Captures identity before a gesture, confirmation, timer or asynchronous lookup. With
     * `{ submitted: true }`, an owner whose write follows a confirmation or an await also stays bound
     * to the operation that dispatched its control, so its existing check before the write covers it.
     */
    JE.createSessionAction = function (options) {
        const operation = options?.submitted ? submitted : null;
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
        return {
            current,
            session,
            /**
             * The request binding for work this action owns: the transport sends it only while this session is the
             * signed-in one, the operation it is bound to (if any) is current and `owner()` (when given) is true,
             * checked immediately before the bytes go out.
             * @param {() => boolean} [owner]
             */
            bound: owner => ({ session, current: () => (!operation || operation.current() !== false) && (!owner || owner() === true) }),
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
