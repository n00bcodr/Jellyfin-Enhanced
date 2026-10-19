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
        const current = () => ApiClient.getCurrentUserId() === user && serverId() === server &&
            ApiClient.accessToken() === token && JE.session?.isCurrent?.(epoch) !== false &&
            (!operation || operation.current() !== false);
        return {
            current,
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
