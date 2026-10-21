/** Native Dashboard user settings transport. Each read is independent of core GET deduplication. */
(function (JE) {
    'use strict';
    /** Call the administrator API without retaining private responses. */
    async function call(path, method, body, signal) {
        const epoch = JE.session?.getEpoch?.();
        const observation = JE.core?.revision?.begin?.();
        const response = await fetch(ApiClient.getUrl('/JellyfinEnhanced/' + path), {
            method, cache: 'no-store', signal,
            headers: { Authorization: `MediaBrowser Token="${ApiClient.accessToken()}"`, Accept: 'application/json', 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        JE.core?.revision?.noteResponse(response, observation);
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
