/** Native Dashboard user settings transport. Each read is independent of core GET deduplication. */
(function (JE) {
    'use strict';
    /** Call the administrator API without retaining private responses. */
    async function call(path, method, body, signal) {
        const epoch = JE.session?.getEpoch?.();
        // A write goes out through JE.core.userWrite with the session it was made in (never another person's).
        const binding = method === 'GET' ? null : JE.core.userWrite.bind();
        const transmit = () => fetch(ApiClient.getUrl('/JellyfinEnhanced/' + path), {
            method, cache: 'no-store', signal,
            headers: { Authorization: `MediaBrowser Token="${ApiClient.accessToken()}"`, Accept: 'application/json', 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const response = await (binding ? JE.core.userWrite.send(binding, transmit, path) : transmit());
        const value = await response.json();
        if (epoch !== JE.session?.getEpoch?.()) throw { stale: true };
        if (!response.ok) throw { status: response.status, reason: value.reason || value.code };
        return value;
    }
    JE.arrAdminUsersApi = {
        read: (id, signal) => call('arr/admin/users/' + encodeURIComponent(id), 'GET', undefined, signal),
        summary: signal => call('arr/admin/users/summary', 'GET', undefined, signal),
        patch: (id, group, body, signal) => call('arr/admin/users/' + encodeURIComponent(id) + '/' + group, 'PATCH', body, signal),
        assignTopic: (id, body, signal) => call('arr/admin/notify/users/' + encodeURIComponent(id), 'PUT', body, signal)
    };
})(window.JellyfinEnhanced);
