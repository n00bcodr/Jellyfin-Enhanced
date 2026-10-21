// @ts-check
// /js/core/access-revision.js
//
// Single owner of "is what this tab kept still for the person's current access?".
//
// Every answer of JE's API carries the signed-in person's revisions in its X-JE-Revision header
// (`a=<access>;hc=<hidden content>;sg=<spoiler guard>`): a digest of their access (libraries, parental
// limits, permissions) and the revisions of the documents a tab mirrors, taken by the server BEFORE it
// read anything for that answer. This module reads it from every answer that passes through JE's clients
// (noteResponse), from the page-load bootstrap (noteRevision), and asks for it on every navigation and
// when the tab comes back into view (GET /JellyfinEnhanced/revision), so it reaches the tab whatever
// features are on (poster tags off included) and even when every answer on a page comes from a cache.
//
// When the access part moves, 'je-access-revision' ({before, revision}) is dispatched on document: a cache
// of an answer the server projected for the person (statuses, badges, capabilities, title checks, list
// counts, a client-paged Discover list, Discover's prefetched pages) re-reads it. When a document's part
// moves, 'je-document-revision' ({document: 'hidden-content'|'spoiler-guard', before, revision}): its
// mirror reads it again (another tab or device saved it). The first revision a person's tab sees is the
// baseline (nothing is announced for it). A user switch starts over (session.js resets per-user caches).
//
// Observations are ordered: a read takes an observation (begin(): the sign-in's session epoch and a number that only
// grows) BEFORE it is sent, and its answer's revision is taken only while that sign-in is current and nothing asked for
// later has been taken yet. An answer asked for before a newer one, or before a sign-in, is superseded: it can't roll
// the tab back (the digests are opaque, so they are never compared for order). A revision handed in without an
// observation (the tests, a value known to be current) is taken as observed now.
//
// Public surface: JE.core.revision { access(), document(name), current(), begin(), isCurrent(observation),
// accessOf(response), noteResponse(response, observation), noteRevision(text, observation?), probe(reason) }.
(function(JE) {
    'use strict';

    JE.core = JE.core || {};

    const logPrefix = '🪼 Jellyfin Enhanced: Revision:';
    const HEADER = 'X-JE-Revision';
    const DOCUMENTS = Object.freeze({ hc: 'hidden-content', sg: 'spoiler-guard' });
    // Navigation bursts (a redirect, a tab switch) ask once.
    const PROBE_GAP_MS = 1000;

    /** @type {string|null} */
    let access = null;
    /** @type {Record<string, string|null>} */
    const documents = { 'hidden-content': null, 'spoiler-guard': null };
    /** @type {Promise<string|null>|null} */
    let probing = null;
    let lastProbeAt = 0;
    // A probe that started before a user switch says nothing about the new person.
    let probeEpoch = 0;
    // Observations handed out (begin) and the newest one whose revision was taken.
    let issued = 0;
    let taken = 0;

    /** @typedef {{epoch: number, order: number}} Observation */

    /** @returns {number} The sign-in's session epoch now. */
    const sessionEpoch = () => (JE.session ? JE.session.getEpoch() : 0);

    /**
     * An observation for a read about to be sent: take it BEFORE the request goes out (each retry takes its own).
     * @returns {Observation}
     */
    function begin() {
        return { epoch: sessionEpoch(), order: ++issued };
    }

    /**
     * Whether an answer to a read that took this observation may still be taken: the same sign-in, and nothing asked
     * for after it has been taken already.
     * @param {Observation|null|undefined} observation
     * @returns {boolean}
     */
    function isCurrent(observation) {
        if (!observation || typeof observation.order !== 'number') return false;
        return observation.epoch === sessionEpoch() && observation.order > taken;
    }

    /**
     * Parse `a=…;hc=…;sg=…`.
     * @param {string} text
     * @returns {{access: string|null, documents: Record<string, string>}|null}
     */
    function parse(text) {
        if (typeof text !== 'string' || !text) return null;
        /** @type {Record<string, string>} */
        const parts = {};
        for (const pair of text.split(';')) {
            const at = pair.indexOf('=');
            if (at > 0) parts[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
        }
        if (!parts.a) return null;
        /** @type {Record<string, string>} */
        const docs = {};
        for (const [short, name] of Object.entries(DOCUMENTS)) if (parts[short]) docs[name] = parts[short];
        return { access: parts.a, documents: docs };
    }

    /**
     * @param {string} type
     * @param {object} detail
     */
    function announce(type, detail) {
        try {
            document.dispatchEvent(new CustomEvent(type, { detail }));
        } catch (err) {
            console.warn(`${logPrefix} ${type} listeners failed:`, err);
        }
    }

    /**
     * Take a revision the server sent (a header value or the bootstrap's Revision), observed by `observation` (taken
     * before its read was sent; none: observed now). A superseded one is refused. Moves are announced.
     * @param {string|null|undefined} text
     * @param {Observation} [observation]
     * @returns {boolean} True when it was a revision and was taken.
     */
    function noteRevision(text, observation) {
        const parsed = parse(text || '');
        if (!parsed) return false;
        const seen = observation === undefined ? begin() : observation;
        if (!isCurrent(seen)) return false;
        taken = seen.order;
        for (const [name, revision] of Object.entries(parsed.documents)) {
            const before = documents[name];
            if (before === revision) continue;
            documents[name] = revision;
            if (before !== null) announce('je-document-revision', { document: name, before, revision });
        }
        if (parsed.access !== access) {
            const before = access;
            access = parsed.access;
            if (before !== null) announce('je-access-revision', { before, revision: access });
        }
        return true;
    }

    /**
     * Take the revision an answer of JE's API carried (any Response-like object with headers.get), observed by the
     * observation its read took before it was sent (begin()). An answer without one is never taken.
     * @param {any} response
     * @param {Observation|null|undefined} observation
     * @returns {boolean} True when its revision was taken.
     */
    function noteResponse(response, observation) {
        try {
            const value = response?.headers?.get?.(HEADER);
            if (value && observation) return noteRevision(value, observation);
        } catch (_) { /* a response without readable headers carries nothing */ }
        return false;
    }

    /**
     * The access part of the revision an answer carried (what it was worked out for), or null when it carries none.
     * @param {any} response
     * @returns {string|null}
     */
    function accessOf(response) {
        try {
            return parse(response?.headers?.get?.(HEADER) || '')?.access ?? null;
        } catch (_) {
            return null;
        }
    }

    /**
     * Ask the server for the person's revisions now (navigation, the tab coming back into view). One at a time,
     * at most once a second unless forced.
     * @param {string} [reason]
     * @param {boolean} [force]
     * @returns {Promise<string|null>} The access revision afterwards.
     */
    function probe(reason, force = false) {
        if (probing) return probing;
        if (typeof ApiClient === 'undefined' || !ApiClient?.getCurrentUserId?.() || typeof fetch !== 'function') return Promise.resolve(access);
        const now = Date.now();
        if (!force && now - lastProbeAt < PROBE_GAP_MS) return Promise.resolve(access);
        lastProbeAt = now;
        const epoch = sessionEpoch();
        probeEpoch = epoch;
        const observation = begin();
        probing = (async () => {
            try {
                const response = await fetch(ApiClient.getUrl('/JellyfinEnhanced/revision'), {
                    headers: { 'Authorization': `MediaBrowser Token="${ApiClient.accessToken()}"`, 'Accept': 'application/json' },
                    cache: 'no-store'
                });
                if (!isCurrent(observation)) return access;
                if (!response.ok) return access;
                if (noteResponse(response, observation)) return access;
                const body = await response.json().catch(() => null);
                if (body && typeof body.revision === 'string') noteRevision(body.revision, observation);
            } catch (err) {
                console.debug(`${logPrefix} probe (${reason || 'asked'}) failed:`, err);
            } finally {
                if (probeEpoch === epoch) probing = null;
            }
            return access;
        })();
        return probing;
    }

    JE.session?.onUserChange('access-revision', () => {
        access = null;
        for (const name of Object.keys(documents)) documents[name] = null;
        probing = null;
        lastProbeAt = 0;
        // Every observation of the previous sign-in is superseded (its epoch moved); the order goes on growing.
        taken = issued;
    });

    // Every navigation, and the tab coming back into view: kept answers follow a change made meanwhile.
    try {
        JE.core.navigation?.onNavigate?.(() => { probe('navigation'); });
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') probe('visible');
        });
    } catch (err) {
        console.warn(`${logPrefix} could not follow navigation:`, err);
    }

    // The page-load bootstrap's revisions (taken before it read the documents it carries), when it was for the person
    // signed in now: the mirrors loaded from it are kept under them.
    try {
        const boot = JE.bootstrapRevision;
        const signedIn = typeof ApiClient !== 'undefined' ? String(ApiClient?.getCurrentUserId?.() || '').replace(/-/g, '').toLowerCase() : '';
        if (boot && typeof boot.revision === 'string' && signedIn && String(boot.userId || '').replace(/-/g, '').toLowerCase() === signedIn) noteRevision(boot.revision);
    } catch (_) { /* no bootstrap: the first answer is the baseline */ }

    JE.core.revision = Object.freeze({
        HEADER,
        /** @returns {string|null} The person's access revision as last seen. */
        access: () => access,
        /** @param {string} name 'hidden-content' | 'spoiler-guard' @returns {string|null} */
        document: (name) => documents[name] ?? null,
        /** @returns {{access: string|null, documents: Record<string, string|null>}} */
        current: () => ({ access, documents: { ...documents } }),
        begin,
        isCurrent,
        accessOf,
        noteResponse,
        noteRevision,
        probe
    });
})(window.JellyfinEnhanced);
