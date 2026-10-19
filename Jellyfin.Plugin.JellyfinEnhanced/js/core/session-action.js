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
        const serverId = () => typeof ApiClient.serverId === 'function' ? ApiClient.serverId() : ApiClient.serverId;
        const server = serverId();
        const token = ApiClient.accessToken();
        /** Checks both live identity and epoch, including hosts with delayed session detection. */
        const current = () => ApiClient.getCurrentUserId() === user && serverId() === server &&
            ApiClient.accessToken() === token && JE.session?.isCurrent?.(epoch) !== false;
        /** The captured session as the core transport's bound requests carry it (JE.core.api.session()'s shape). */
        const session = Object.freeze({ userId: user, serverId: server, token, epoch, current });
        return {
            current,
            session,
            /**
             * The request binding for work this action owns: the transport sends it only while this session is the
             * signed-in one and `owner()` (when given) is true, checked immediately before the bytes go out.
             * @param {() => boolean} [owner]
             */
            bound: owner => ({ session, current: owner ? () => owner() === true : undefined }),
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
