/** Deferred feature actions belong to the viewer and session that started them. */
(function (JE) {
    'use strict';
    const dismissals = new Set();
    JE.session?.onUserChange?.('session-actions', () => {
        for (const dismiss of [...dismissals]) dismiss();
        dismissals.clear();
    });

    /** Captures identity before a gesture, confirmation, timer or asynchronous lookup. */
    JE.createSessionAction = function () {
        const user = ApiClient.getCurrentUserId();
        const epoch = JE.session?.getEpoch?.();
        /** Checks both live identity and epoch, including hosts with delayed session detection. */
        const current = () => ApiClient.getCurrentUserId() === user &&
            JE.session?.isCurrent?.(epoch) !== false;
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
