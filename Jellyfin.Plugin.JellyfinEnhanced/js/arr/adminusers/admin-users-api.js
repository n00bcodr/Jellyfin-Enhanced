/** Native Dashboard user settings transport. Each read is independent of core GET deduplication. */
(function (JE) {
    'use strict';
    /**
     * Call the administrator API without retaining private responses. A write takes its origin (`origin`, taken when the
     * administrator acted; a write without it is refused, never sent as whoever is signed in). Every answer is shown to
     * the build check before its body is read; a write's answer that can't be read may have been stored (uncertain).
     */
    async function call(path, method, body, signal, origin) {
        const epoch = JE.session?.getEpoch?.();
        // A write goes out through JE.core.userWrite with the origin it was made in (never another person's).
        const binding = method === 'GET' ? null : origin || null;
        if (method !== 'GET' && !binding) return JE.core.userWrite.send(null, () => Promise.resolve(), path);
        const transmit = () => fetch(ApiClient.getUrl('/JellyfinEnhanced/' + path), {
            method, cache: 'no-store', signal,
            headers: { Authorization: `MediaBrowser Token="${ApiClient.accessToken()}"`, Accept: 'application/json', 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        // Taken before the request: its answer's revisions are taken only while nothing newer was (core/access-revision.js).
        const observation = JE.core?.revision?.begin?.();
        const response = await (binding ? JE.core.userWrite.send(binding, transmit, path) : transmit());
        // Asked with no-store: the server's build now.
        JE.core.build?.noteAnswer?.(response, { fresh: true });
        // The answer carries the person's revisions (core/access-revision.js).
        JE.core?.revision?.noteResponse(response, observation);
        let value;
        try {
            value = await response.json();
        } catch (error) {
            if (!binding) throw error;
            // A write whose answer can't be read: stored if it was accepted, as far as anyone can tell; for a failed answer
            // its status says (a contractual refusal, or a server error after which it may have been stored).
            throw response.ok
                ? Object.assign(new Error(`${path}: the answer could not be read`), { writeOutcome: 'uncertain' })
                : JE.core.userWrite.classify({ status: response.status, reason: '' });
        }
        if (epoch !== JE.session?.getEpoch?.() || (binding && !JE.core.userWrite.isBound(binding))) throw { stale: true };
        if (!response.ok) {
            // A write's failure is classified by its status (RBS1-R13-5): a 4xx (but 408) or 503 is a refusal; a 5xx after
            // the attempt may have been stored (uncertain), never shown as not saved.
            const failure = { status: response.status, reason: value?.reason || value?.code };
            throw binding ? JE.core.userWrite.classify(failure) : failure;
        }
        return value;
    }
    JE.arrAdminUsersApi = {
        read: (id, signal) => call('arr/admin/users/' + encodeURIComponent(id), 'GET', undefined, signal),
        summary: signal => call('arr/admin/users/summary', 'GET', undefined, signal),
        patch: (id, group, body, signal, origin) => call('arr/admin/users/' + encodeURIComponent(id) + '/' + group, 'PATCH', body, signal, JE.core.userWrite.originOf(origin)),
        assignTopic: (id, body, signal, origin) => call('arr/admin/notify/users/' + encodeURIComponent(id), 'PUT', body, signal, JE.core.userWrite.originOf(origin))
    };
})(window.JellyfinEnhanced);
