/**
 * @file Requests & downloads, phase 4c3b: list authoring input and the identity of a write. Pure: no network, DOM,
 * listener or timer, here or on load.
 *
 * - Validation as the server does it (ListRules): titles 1–200 characters, notes up to 300, a custom entry's type
 *   (movie or show), year (1870–2100) and release date (a real yyyy-MM-dd day), at most 100 distinct episodes of ONE
 *   season (duplicates collapsed first: the server bounds the raw input). Text is cleaned as the server cleans it.
 * - Rights come from the server's actions for this person: editing (the list's `edit`, the entry's `note`/`remove`/
 *   `link`) and asking (the entry's `request`) are separate; a saved canEdit alone grants nothing.
 * - A confirmation ({@link intents}) is one person's decision to send one body: it gets its own request id. Only the
 *   exact confirmation whose answer was lost (uncertain) is sent again, with the same body and id; while it is
 *   uncertain, a different body for the same thing is refused rather than sent beside it (so an uncertain create is
 *   never made twice), unless the person deliberately starts a new one. A definite answer (including a conflict)
 *   ends the confirmation: nothing is resent automatically; the next press is a new confirmation on the fresh view.
 * - {@link submit} sends a confirmation once through the caller's transport and reads the answer under the surface it
 *   was confirmed on (nothing is settled for a surface that ended meanwhile).
 *
 * Internal: lp.authoring { LIMITS, clean, validateNote, validateCustom, validateEpisodes, linkTarget, capabilities,
 * toPlaceholder, present, classify, intents, submit, guarded }.
 */
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const lp = JE.internals.arrListPages = JE.internals.arrListPages || {};

    const LIMITS = Object.freeze({ title: 200, note: 300, episodes: 100, yearMin: 1870, yearMax: 2100 });
    const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
    const POSTER_RE = /^\/[A-Za-z0-9_-]+\.(jpg|png)$/;
    /** Definite 409 answers that carry the list as it is now. */
    const CONFLICTS = new Set(['rev_conflict', 'not_permutation', 'moved_invalid', 'real_order_changed', 'duplicate_copy', 'move_unsupported', 'move_failed', 'owner_missing', 'conflict', 'changed']);

    /**
     * Text as the server keeps it: tabs and line breaks become spaces, other control and format characters go, trimmed.
     * @param {*} value Text.
     * @returns {string} Clean text.
     */
    function clean(value) {
        return String(value ?? '').replace(/[\n\t]/g, ' ').replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
    }

    /** @param {string} field Field. @param {string} key Words. @returns {{ok: false, field: string, key: string}} Error. */
    const fieldError = (field, key) => ({ ok: false, field, key });

    /**
     * A real calendar day in yyyy-MM-dd, or null.
     * @param {*} value Text.
     * @returns {string|null} Date.
     */
    function day(value) {
        const m = DATE_RE.exec(String(value ?? '').trim());
        if (!m) return null;
        const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
        return date.getUTCFullYear() === Number(m[1]) && date.getUTCMonth() === Number(m[2]) - 1 && date.getUTCDate() === Number(m[3]) ? m[0] : null;
    }

    /**
     * A note (empty clears it).
     * @param {*} text Text.
     * @returns {{ok: true, note: string}|{ok: false, field: string, key: string}} Result.
     */
    function validateNote(text) {
        const note = clean(text);
        return note.length > LIMITS.note ? fieldError('note', 'arr_lists_author_err_note') : { ok: true, note };
    }

    /**
     * A custom entry from its form.
     * @param {{type?: string, title?: string, year?: string|number, date?: string, note?: string}} input Form values.
     * @returns {{ok: true, dto: Object}|{ok: false, field: string, key: string}} Result.
     */
    function validateCustom(input) {
        const type = input?.type ?? 'movie';
        if (type !== 'movie' && type !== 'tv') return fieldError('type', 'arr_lists_author_err_type');
        const title = clean(input?.title);
        if (!title.length || title.length > LIMITS.title) return fieldError('title', 'arr_lists_author_err_title');
        const dto = { kind: 'custom', mediaType: type, title };
        const yearText = String(input?.year ?? '').trim();
        if (yearText) {
            const year = /^\d{4}$/.test(yearText) ? Number(yearText) : NaN;
            if (!(year >= LIMITS.yearMin && year <= LIMITS.yearMax)) return fieldError('year', 'arr_lists_author_err_year');
            dto.year = year;
        }
        const dateText = String(input?.date ?? '').trim();
        if (dateText) {
            const date = day(dateText);
            if (!date) return fieldError('date', 'arr_lists_author_err_date');
            dto.releaseDate = date;
            if (dto.year === undefined) dto.year = Number(date.slice(0, 4));
        }
        const note = validateNote(input?.note);
        if (!note.ok) return note;
        if (note.note) dto.note = note.note;
        return { ok: true, dto };
    }

    /**
     * Episodes of one season: distinct, sorted, at most 100.
     * @param {number} seasonNumber Season (0 = specials).
     * @param {Array<{s: number, e: number}>} episodes Picks.
     * @returns {{ok: true, episodes: Array<{s: number, e: number}>}|{ok: false, reason: string}} Result.
     */
    function validateEpisodes(seasonNumber, episodes) {
        if (!Number.isInteger(seasonNumber) || seasonNumber < 0 || seasonNumber > 200) return { ok: false, reason: 'invalid' };
        if (!Array.isArray(episodes) || !episodes.length) return { ok: false, reason: 'empty' };
        const numbers = new Set();
        for (const ep of episodes) {
            if (!ep || !Number.isInteger(ep.s) || !Number.isInteger(ep.e) || ep.e < 0 || ep.e > 9999) return { ok: false, reason: 'invalid' };
            if (ep.s !== seasonNumber) return { ok: false, reason: 'mixed_season' };
            numbers.add(ep.e);
        }
        if (numbers.size > LIMITS.episodes) return { ok: false, reason: 'too_many' };
        return { ok: true, episodes: Array.from(numbers).sort((a, b) => a - b).map(e => ({ s: seasonNumber, e })) };
    }

    /**
     * The title data of a typed candidate (lp.metadata), or null when it has no usable identity.
     * @param {Object} candidate Candidate.
     * @returns {Object|null} Base fields.
     */
    function baseOf(candidate) {
        const id = candidate?.identity;
        if (!id || (id.mediaType !== 'movie' && id.mediaType !== 'tv') || !(Number.isInteger(id.tmdbId) && id.tmdbId > 0)) return null;
        const base = { mediaType: id.mediaType, tmdbId: id.tmdbId, title: clean(candidate.title).slice(0, LIMITS.title) };
        if (!base.title) return null;
        if (Number.isInteger(candidate.year) && candidate.year >= LIMITS.yearMin && candidate.year <= LIMITS.yearMax) base.year = candidate.year;
        const date = day(candidate.releaseDate);
        if (date) base.releaseDate = date;
        if (typeof candidate.posterPath === 'string' && POSTER_RE.test(candidate.posterPath)) base.posterPath = candidate.posterPath;
        if (id.mediaType === 'tv' && Number.isInteger(id.tvdbId) && id.tvdbId > 0) base.tvdbId = id.tvdbId;
        return base;
    }

    /**
     * What a custom entry may be linked to: a candidate with a real identity the person can use.
     * @param {Object} entry The custom entry (as drawn).
     * @param {Object} candidate A typed candidate.
     * @returns {{ok: true, link: Object}|{ok: false, reason: string}} Result.
     */
    function linkTarget(entry, candidate) {
        if (entry?.kind !== 'custom' || !(entry.actions || []).includes('link')) return { ok: false, reason: 'not_custom' };
        if (!candidate || candidate.inert === true) return { ok: false, reason: 'inert' };
        const base = baseOf(candidate);
        if (!base) return { ok: false, reason: 'no_identity' };
        if (candidate.accessible === false) return { ok: false, reason: 'inaccessible' };
        return { ok: true, link: { kind: base.mediaType === 'movie' ? 'movie' : 'series', ...base } };
    }

    /**
     * What this person may do with an entry, from the server's actions.
     * @param {Object} view The list view.
     * @param {Object} entry The entry.
     * @returns {{edit: boolean, reorder: boolean, note: boolean, link: boolean, remove: boolean, request: boolean}} Rights.
     */
    function capabilities(view, entry) {
        const list = Array.isArray(view?.actions) ? view.actions : [];
        const own = Array.isArray(entry?.actions) ? entry.actions : [];
        const edit = view?.canEdit === true && list.includes('edit');
        return {
            edit,
            reorder: edit && view.listKind !== 'collection' && list.includes('reorder'),
            note: edit && own.includes('note'),
            link: edit && own.includes('link') && entry.kind === 'custom',
            remove: edit && own.includes('remove'),
            request: own.includes('request')
        };
    }

    /**
     * The entry to store for a candidate and a scope selection (lp.granularity), or null when incomplete.
     * @param {Object} candidate A typed candidate with an identity.
     * @param {{kind: string, seasonNumber?: number, episodes?: Array, edition?: string}|null} selection Scope.
     * @param {{episodes?: Array<{e: number, title?: string, airDate?: string|null}>}} [facts] Episode facts of the season.
     * @returns {Object|null} NewPlaceholderDto.
     */
    function toPlaceholder(candidate, selection, facts) {
        const base = baseOf(candidate);
        if (!base || !selection) return null;
        const edition = selection.edition === '4k' ? { edition: '4k' } : {};
        if (base.mediaType === 'movie') return selection.kind === 'movie' ? { ...base, kind: 'movie', ...edition } : null;
        if (selection.kind === 'series') return { ...base, kind: 'series', ...edition };
        if (selection.kind === 'season' && Number.isInteger(selection.seasonNumber)) return { ...base, kind: 'season', seasonNumber: selection.seasonNumber, ...edition };
        if (selection.kind !== 'episodes') return null;
        const checked = validateEpisodes(selection.seasonNumber, selection.episodes);
        if (!checked.ok) return null;
        const known = new Map((facts?.episodes || []).map(f => [f.e, f]));
        const episodes = checked.episodes.map(ep => {
            const fact = known.get(ep.e);
            return {
                s: ep.s,
                e: ep.e,
                ...(fact?.title ? { title: clean(fact.title).slice(0, LIMITS.title) } : {}),
                ...(day(fact?.airDate) ? { airDate: day(fact.airDate) } : {})
            };
        });
        return { ...base, kind: 'episodes', seasonNumber: selection.seasonNumber, episodes, ...edition };
    }

    /**
     * Whether a view still holds an entry.
     * @param {Object} view View.
     * @param {string} id Entry id.
     * @returns {boolean} Present.
     */
    function present(view, id) {
        return Array.isArray(view?.placeholders) && view.placeholders.some(p => p?.id === id);
    }

    /**
     * What an answer means for its confirmation.
     * @param {{status: number, body: Object|null}|null} answer Answer.
     * @returns {'ok'|'conflict'|'uncertain_create'|'refused'|'denied'|'uncertain'} Class.
     */
    function classify(answer) {
        const status = Number(answer?.status) || 0;
        const code = answer?.body?.code;
        if (status >= 200 && status < 300) return 'ok';
        if (status === 409) return code === 'create_uncertain' ? 'uncertain_create' : CONFLICTS.has(code) ? 'conflict' : 'refused';
        if (status === 401 || status === 403 || status === 404) return 'denied';
        if (status >= 400 && status < 500) return 'refused';
        return 'uncertain';
    }

    /** @param {Object} value Value. @returns {Object} The value, frozen all the way down. */
    function deepFreeze(value) {
        if (value && typeof value === 'object' && !Object.isFrozen(value)) {
            Object.freeze(value);
            for (const key of Object.keys(value)) deepFreeze(value[key]);
        }
        return value;
    }

    /** @returns {string} A new request id. */
    function newId() {
        if (typeof JE.arrLists?.newRequestId === 'function') return JE.arrLists.newRequestId();
        const random = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
        return 'l' + random.replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
    }

    /** Confirmations kept per surface at most (an uncertain one each; definite ones are dropped). */
    const MAX_PENDING = 32;

    /**
     * The confirmations of one surface.
     * @returns {{confirm: Function, replay: Function, settled: Function}} Tracker.
     */
    function intents() {
        /** @type {Map<string, {conf: Object, fingerprint: string}>} uncertain confirmations by what they are about */
        const pending = new Map();
        const fingerprints = new WeakMap();
        return {
            /**
             * A person's confirmation of one body.
             * @param {string} kind What it does ('create', 'add', 'note', 'remove', 'link', 'reorder', 'request', ...).
             * @param {string|null} listId The list (null: a new list).
             * @param {Object} body The body without its id.
             * @param {{entry?: string, fresh?: boolean}} [options] The entry it is about; fresh: a deliberate new one.
             * @returns {Object} The confirmation ({ok: true, kind, listId, entry, key, body}), or {ok: false, reason}.
             */
            confirm(kind, listId, body, options = {}) {
                const key = `${kind}|${listId ?? ''}|${options.entry ?? ''}`;
                const fingerprint = JSON.stringify(body ?? {});
                const held = pending.get(key);
                if (held && options.fresh !== true) return held.fingerprint === fingerprint ? held.conf : { ok: false, reason: 'uncertain_pending' };
                if (held) pending.delete(key);
                const idField = kind === 'request' ? 'clientId' : 'requestId';
                const conf = deepFreeze({ ok: true, kind, listId: listId ?? null, entry: options.entry ?? null, key, body: { ...JSON.parse(fingerprint), [idField]: newId() } });
                fingerprints.set(conf, fingerprint);
                return conf;
            },
            /**
             * The same confirmation again, only while its answer is uncertain.
             * @param {Object} conf Confirmation.
             * @returns {Object|null} It, or null.
             */
            replay(conf) {
                return conf && pending.get(conf.key)?.conf === conf ? conf : null;
            },
            /**
             * Records how a confirmation's send ended.
             * @param {Object} conf Confirmation.
             * @param {string} outcome Class ({@link classify}, or 'stale').
             */
            settled(conf, outcome) {
                if (!conf?.key) return;
                if (outcome === 'uncertain' || outcome === 'uncertain_create') {
                    if (!pending.has(conf.key) && pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
                    pending.set(conf.key, { conf, fingerprint: fingerprints.get(conf) });
                } else if (pending.get(conf.key)?.conf === conf) {
                    pending.delete(conf.key);
                }
            }
        };
    }

    /**
     * Sends a confirmation once and reads the answer under the surface it was confirmed on. Never sends again by itself.
     * The answer is read through the surface's checked step (lp.surface effects/origin task): when the owner, session,
     * lifecycle or surface ended meanwhile, nothing is settled or reported ('stale'); without a surface nothing is sent.
     * @param {Object} tracker From {@link intents}.
     * @param {Object} conf A confirmation.
     * @param {function(Object): Promise<{status: number, body: Object|null}>} send The caller's transport call.
     * @param {{task: Function}} bound The surface (an origin or its effects).
     * @returns {Promise<{outcome: string, answer?: Object, view?: Object|null, entryGone?: boolean, resubmits: 0}>} Outcome.
     */
    function submit(tracker, conf, send, bound) {
        if (!conf || conf.ok !== true) return Promise.resolve({ outcome: 'refused', reason: conf?.reason || 'invalid', resubmits: 0 });
        if (!bound || typeof bound.task !== 'function') return Promise.resolve({ outcome: 'refused', reason: 'unbound', resubmits: 0 });
        return bound.task(null, async (step) => {
            const sent = await step(() => send(conf));
            if (!sent.ok) {
                // The rule refused the answer (another person, or the owner ended): the confirmation is over for them.
                const outcome = sent.error?.stale === true ? 'stale' : 'uncertain';
                tracker.settled(conf, outcome);
                return { outcome, resubmits: 0 };
            }
            const answer = sent.value;
            const outcome = classify(answer);
            tracker.settled(conf, outcome);
            const body = answer?.body || null;
            const view = body?.view || body?.result?.view || (body?.listId && Array.isArray(body?.placeholders) ? body : null);
            const result = { outcome, answer, view, resubmits: 0 };
            if (conf.entry && view) result.entryGone = !present(view, conf.entry);
            return result;
        }, { outcome: 'stale', resubmits: 0 });
    }

    /**
     * Whether a ticket's Spoiler policy guards an entry (fail closed: no ticket or no policy guards it).
     * @param {Object|null} ticket Paint ticket.
     * @param {Object} entry Entry or title.
     * @returns {boolean} Guarded.
     */
    function guarded(ticket, entry) {
        const policy = ticket?.policy;
        if (typeof policy !== 'function') return true;
        try {
            return policy(entry) !== false;
        } catch {
            return true;
        }
    }

    lp.authoring = Object.freeze({
        LIMITS, clean, validateNote, validateCustom, validateEpisodes, linkTarget, capabilities, toPlaceholder, present,
        classify, intents, submit, guarded, day
    });
})(window.JellyfinEnhanced);
