// /js/enhanced/config.js
/**
 * @file Manages plugin configuration, user settings, and shared state.
 */
(function(JE) {
    'use strict';

    /**
     * Constants derived from the plugin configuration.
     * @type {object}
     */
    JE.CONFIG = {
        // Use getters so values always reflect the latest pluginConfig even if assigned later
        get TOAST_DURATION() { return (JE.pluginConfig && JE.pluginConfig.ToastDuration) || 1500; },
        get HELP_PANEL_AUTOCLOSE_DELAY() { return (JE.pluginConfig && JE.pluginConfig.HelpPanelAutocloseDelay) || 15000; }
    };

    /**
     * Shared state variables used across different components.
     * @type {object}
     */
    JE.state = JE.state || {
        activeShortcuts: {},
        // { itemId, surface: 'continuewatching'|'nextup'|null, ts } captured on a menu trigger.
        removeContext: null,
        pauseScreenClickTimer: null
    };

    // The store belongs to the identity session, never to a panel or its settings objects.
    // Every file has exactly one persisted document (the server's, as last read or as a save answered it: never the page's
    // own copy), ordered pending operations and a derived view. Writes are operations, never whole documents: the server
    // applies each to the document it holds then and answers it, so whatever another tab or device changed meanwhile stays
    // unless this one changed it too.
    const documents = new Map();
    // Module-lifetime views of a document (observeUserDocument): they follow it across sessions, unlike panel observers.
    const documentObservers = new Map();
    const panelScopes = new Set();
    // Every personal consent (UserConfigurationManager.PersonalConsents): only the consent operation changes one.
    const consentKeys = ['autoSeasonRequests', 'autoMovieRequests', 'listSwapIn'];
    // Consents where null is a choice (follow the administrator), not only "never chosen".
    const followConsentKeys = ['autoSeasonRequests', 'autoMovieRequests'];
    let identity, reloadRequest;
    JE.internals = JE.internals || {};

    /** Copy JSON settings so neither callers nor views can mutate the persisted baseline. */
    const copyDocument = value => JSON.parse(JSON.stringify(value || {}));
    const copyValue = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    /** A camelCase key as the server spells it (the same rule as JE.toPascalCase). */
    const pascal = key => typeof key === 'string' && key ? key.charAt(0).toUpperCase() + key.slice(1) : key;

    // How each per-user document is held (its keys as the boot read leaves them: plugin.js buildUserConfig) and written.
    //   fields  - fields are set (settings.json: camelCase here, PascalCase on the wire; elsewhere.json: as stored)
    //   records - records by key are added, replaced or removed (bookmark.json: bookmarks by id)
    //   keyed   - list entries by a key field are added, replaced or removed (shortcuts.json: Shortcuts by Name)
    //   items   - ids are added or removed (ddd-triggers.json: Triggers)
    //   hidden  - items by key are added, replaced or removed, and settings fields are set (hidden-content.json)
    // `view` names the JE.userConfig view the store keeps equal to its document. No other per-user file is written.
    const DOCUMENT_KINDS = {
        'settings.json': { kind: 'fields', camel: true, view: 'settings' },
        'elsewhere.json': { kind: 'fields', camel: false, view: 'elsewhere' },
        'bookmark.json': { kind: 'records', camel: true, view: 'bookmark', records: 'bookmarks' },
        'shortcuts.json': { kind: 'keyed', camel: false, view: 'shortcuts', list: 'Shortcuts', key: 'Name' },
        'ddd-triggers.json': { kind: 'items', camel: false, list: 'Triggers' },
        // Read camelCase (as the boot read leaves it) and sent as held: the server reads item and setting names in any case,
        // and item keys are ids, never re-cased.
        'hidden-content.json': { kind: 'hidden', camel: true, wireAsHeld: true, view: 'hiddenContent' }
    };
    const kindOf = fileName => DOCUMENT_KINDS[fileName];
    /** A document as this store holds it, from the server's spelling (the boot read's rule). */
    const holdDocument = (fileName, raw) => copyDocument(kindOf(fileName)?.camel === false || typeof JE.toCamelCase !== 'function' ? raw : JE.toCamelCase(raw));
    /** An item id as compared (the server stores ids dashed, cards carry them undashed). */
    const canonicalId = id => typeof id === 'string' || typeof id === 'number' ? String(id).replace(/-/g, '').toLowerCase() : '';

    // What each userConfig object held as the server handed it out. plugin.js records it with the read itself
    // (`readDocuments`, non-enumerable); for an object assigned by another host the record is taken as it is assigned, so a
    // change a module makes to the object later is an edit, never the document a save compares against.
    // With them, the revision the server named for each document (`readRevisions`, from the bootstrap), when it named one.
    const readRecords = new WeakMap();
    const readRevisionRecords = new WeakMap();
    const recordRead = userConfig => {
        if (!userConfig || typeof userConfig !== 'object' || readRecords.has(userConfig)) return;
        let record = userConfig.readDocuments;
        if (!record || typeof record !== 'object') {
            record = {};
            const unread = userConfig.unreadDocuments || [];
            for (const [fileName, kind] of Object.entries(DOCUMENT_KINDS)) {
                if (kind.view && userConfig[kind.view] !== undefined && !unread.includes(fileName)) record[fileName] = copyDocument(userConfig[kind.view]);
            }
        }
        readRecords.set(userConfig, record);
        const revisions = userConfig.readRevisions;
        readRevisionRecords.set(userConfig, revisions && typeof revisions === 'object' ? { ...revisions } : {});
    };
    {
        let userConfig = JE.userConfig;
        recordRead(userConfig);
        // A new userConfig object (a boot read) is adopted as it is assigned, through the same ordering as every other
        // document the store takes (adoptBootDocuments): a read that began before it can't be taken over it afterwards.
        Object.defineProperty(JE, 'userConfig', { configurable: true, enumerable: true,
            get: () => userConfig, set: value => { recordRead(value); userConfig = value; adoptBootDocuments(); } });
    }

    /**
     * Orders two server revisions of one document ("{incarnation}.{writes}": an incarnation sorts after the one before it,
     * then the writes count): true when `candidate` is newer than `held`, false when it is not, undefined when either is
     * unknown (an answer of a server that names none): the store then keeps to its own fences.
     */
    const newerRevision = (candidate, held) => {
        if (typeof candidate !== 'string' || typeof held !== 'string') return undefined;
        const [ci, cn] = candidate.split('.'), [hi, hn] = held.split('.');
        if (ci !== hi) return ci > hi;
        return Number(cn) > Number(hn);
    };
    /** The revision an answer names (a save's answer, a read with its revision), if any. */
    const answerRevision = response => {
        const revision = response?.revision ?? response?.Revision;
        return typeof revision === 'string' && revision ? revision : undefined;
    };

    /**
     * A document after one operation (pure). An operation is { set } (fields), { upsert, remove } (records, keyed),
     * { add, remove } (items), { upsert, remove, set } (hidden: items by key, settings by field) or { consentKey, value }
     * (a personal consent).
     */
    const applyOperation = (fileName, document, op) => {
        const doc = copyDocument(document);
        if (op.consentKey) { doc[op.consentKey] = op.value; return doc; }
        const kind = kindOf(fileName);
        const removed = op.remove || [];
        if (kind.kind === 'hidden') {
            // The server's rule: a removal also takes the same item stored under another spelling of its id.
            const items = doc.items = { ...(doc.items || {}) };
            for (const key of removed) {
                const wanted = canonicalId(key);
                for (const stored of Object.keys(items)) {
                    if (stored === key || (wanted && (canonicalId(stored) === wanted || canonicalId(items[stored]?.itemId) === wanted))) delete items[stored];
                }
            }
            for (const [key, item] of Object.entries(op.upsert || {})) items[key] = copyValue(item);
            doc.settings = { ...(doc.settings || {}), ...copyDocument(op.set) };
        } else if (kind.kind === 'fields') {
            for (const [key, value] of Object.entries(op.set || {})) doc[key] = copyValue(value);
        } else if (kind.kind === 'records') {
            const records = doc[kind.records] = { ...(doc[kind.records] || {}) };
            for (const key of removed) delete records[key];
            for (const [key, record] of Object.entries(op.upsert || {})) records[key] = copyValue(record);
        } else if (kind.kind === 'keyed') {
            const list = (Array.isArray(doc[kind.list]) ? doc[kind.list] : []).filter(item => !removed.includes(item?.[kind.key]));
            for (const [key, record] of Object.entries(op.upsert || {})) {
                const value = { ...copyValue(record), [kind.key]: key };
                const index = list.findIndex(item => item?.[kind.key] === key);
                if (index >= 0) list[index] = value; else list.push(value);
            }
            doc[kind.list] = list;
        } else {
            const list = (Array.isArray(doc[kind.list]) ? doc[kind.list] : []).filter(id => !removed.includes(id));
            for (const id of op.add || []) if (!list.includes(id)) list.push(id);
            doc[kind.list] = list;
        }
        return doc;
    };

    /** The operation that turns `before` into `after` (for callers that still hand over a whole document). */
    const operationBetween = (fileName, before, after) => {
        const kind = kindOf(fileName);
        if (kind.kind === 'hidden') {
            const was = before?.items || {}, now = after?.items || {};
            const upsert = {}, set = {};
            for (const [key, item] of Object.entries(now)) if (!sameValue(item, was[key])) upsert[key] = item;
            for (const [key, value] of Object.entries(after?.settings || {})) if (!sameValue(value, before?.settings?.[key])) set[key] = value;
            return { upsert, remove: Object.keys(was).filter(key => !Object.hasOwn(now, key)), set };
        }
        if (kind.kind === 'fields') {
            const set = {};
            for (const key of Object.keys(after || {})) {
                // A whole document never carries consent intent: only the consent operation changes one.
                if (fileName === 'settings.json' && consentKeys.includes(key)) continue;
                if (!sameValue(after[key], before?.[key])) set[key] = after[key];
            }
            return { set };
        }
        if (kind.kind === 'records') {
            const was = before?.[kind.records] || {}, now = after?.[kind.records] || {};
            const upsert = {};
            for (const [key, record] of Object.entries(now)) if (!sameValue(record, was[key])) upsert[key] = record;
            return { upsert, remove: Object.keys(was).filter(key => !Object.hasOwn(now, key)) };
        }
        if (kind.kind === 'keyed') {
            const byKey = list => new Map((Array.isArray(list) ? list : []).filter(x => x && x[kind.key] != null).map(x => [x[kind.key], x]));
            const was = byKey(before?.[kind.list]), now = byKey(after?.[kind.list]);
            const upsert = {};
            for (const [key, item] of now) if (!sameValue(item, was.get(key))) upsert[key] = item;
            return { upsert, remove: [...was.keys()].filter(key => !now.has(key)) };
        }
        const was = Array.isArray(before?.[kind.list]) ? before[kind.list] : [], now = Array.isArray(after?.[kind.list]) ? after[kind.list] : [];
        return { add: now.filter(id => !was.includes(id)), remove: was.filter(id => !now.includes(id)) };
    };

    const isEmptyOperation = op => !Object.keys(op.set || {}).length && !Object.keys(op.upsert || {}).length
        && !(op.remove || []).length && !(op.add || []).length;

    /** An operation as the server reads it (PATCH user-settings/{id}/{file}). */
    const wireOf = (fileName, op) => {
        const kind = kindOf(fileName);
        if (kind.kind === 'hidden') return { Upsert: copyDocument(op.upsert), Remove: op.remove || [], Set: copyDocument(op.set) };
        // The same spelling rule as the read's (holdDocument): camelCase here only where JE converts both ways.
        const camel = kind.camel && typeof JE.toPascalCase === 'function';
        const wireKey = key => camel ? pascal(key) : key;
        const wireValue = value => camel ? JE.toPascalCase(value) : value;
        if (kind.kind === 'fields') {
            const set = {};
            for (const [key, value] of Object.entries(op.set || {})) set[wireKey(key)] = wireValue(value);
            return { Set: set };
        }
        if (kind.kind === 'items') return { Add: op.add || [], Remove: op.remove || [] };
        const upsert = {};
        for (const [key, record] of Object.entries(op.upsert || {})) upsert[wireKey(key)] = wireValue(record);
        return { Upsert: upsert, Remove: (op.remove || []).map(wireKey) };
    };

    /** Capture identity even in hosts without the session module. */
    const currentIdentity = () => JSON.stringify([
        typeof ApiClient !== 'undefined' ? ApiClient.getCurrentUserId?.() : null,
        JE.session?.getServerId?.(), JE.session?.getEpoch?.()
    ]);

    /** Discard observers, deduplication and unsent work on logout, user or server change. */
    const clearDocuments = () => {
        for (const scope of panelScopes) scope.close();
        clearTimeout(reloadRequest?.timer);
        reloadRequest = undefined;
        documents.clear(); identity = undefined;
    };
    JE.session?.onUserChange?.('settings-store', clearDocuments);

    /** Capture the user/server/epoch for work that may finish after its panel closes. */
    JE.internals.settingsSessionScope = () => {
        const captured = currentIdentity();
        return { isCurrent: () => currentIdentity() === captured };
    };

    /**
     * Bind panel callbacks to their opening identity/epoch and lifetime. Closing cancels gestures
     * and removes every registered listener, including document/window callbacks and detached controls.
     * @param {object} ctx Panel context; panelCleanups is drained on every host close path.
     * @returns {object} View lifetime/listeners/cleanup plus a session scope for submitted save completions.
     */
    JE.internals.settingsPanelScope = ctx => {
        if (ctx.settingsScope) return ctx.settingsScope;
        settingsDocument('settings.json');
        const session = JE.internals.settingsSessionScope(), cleanups = [];
        let closed = false;
        const scope = {
            session,
            isCurrent: () => !closed && session.isCurrent(),
            onCleanup: cleanup => cleanups.push(cleanup),
            close: () => {
                if (closed) return;
                closed = true;
                while (cleanups.length) cleanups.pop()();
                panelScopes.delete(scope);
            },
            listen: (target, type, handler, options) => {
                if (!target || !scope.isCurrent()) return;
                const guarded = event => { if (scope.isCurrent()) return handler(event); };
                target.addEventListener(type, guarded, options);
                cleanups.push(() => target.removeEventListener(type, guarded, options));
            }
        };
        panelScopes.add(scope);
        (ctx.panelCleanups || (ctx.panelCleanups = [])).push(scope.close);
        ctx.settingsScope = scope;
        return scope;
    };

    /**
     * The document as the boot read handed it out (the userConfig object's read record, never the object as modules have
     * changed it since), and whether it was read: plugin.js leaves the documents it could not read out of the record.
     */
    const bootDocument = fileName => {
        recordRead(JE.userConfig);
        const record = JE.userConfig ? readRecords.get(JE.userConfig) : undefined;
        const read = !!record && Object.hasOwn(record, fileName);
        const revision = read ? readRevisionRecords.get(JE.userConfig)?.[fileName] : undefined;
        return { persisted: copyDocument(read ? record[fileName] : undefined), readOk: read, serverRevision: typeof revision === 'string' ? revision : undefined };
    };

    /**
     * The one way a document becomes what this session holds as persisted. Every change source goes through it (a read, a
     * save's answer, another route's write this page acknowledges, a boot read), and so does every queued operation's
     * revision step (queueOperation): the revision moves on with each, so a read that began before any of them is not
     * taken over it (readUserSettings, a handle's noteRead).
     * Every source but a queued operation's own answer counts as an outside change (`outsideTakes`): an answer that
     * arrives after one may be older than what the store holds, so it is ordered by the server's revisions (or, without
     * them, its operation is kept on top of the store's document) instead of being taken whole (see queueOperation).
     * @param {object} state Document state.
     * @param {object} document The document as held from now on.
     * @param {boolean} [readOk=true] Whether it is the server's document (false: a boot read could not read it).
     * @param {string} [serverRevision] The server's revision of that document, when known (undefined: not known).
     * @param {boolean} [outside=true] Whether it came from outside this document's queue (false: an operation's answer).
     * @param {boolean} [whole=true] Whether it is a whole document the server handed out (false: one this store built from
     *   an operation on top of the document held): only a whole one settles the operations whose outcome was uncertain.
     */
    const takeDocument = (state, document, readOk = true, serverRevision = undefined, outside = true, whole = true) => {
        // A document taken is what the store holds from now on: it isn't built from acknowledged changes (see
        // a handle's acknowledge) any more unless that sets it again.
        state.derived = undefined;
        // A whole server document says what is stored now: an operation whose outcome was uncertain is in it or not.
        if (whole) state.unconfirmed = [];
        state.persisted = document;
        state.readOk = readOk;
        state.serverRevision = serverRevision;
        state.revision++;
        if (outside) state.outsideTakes++;
    };

    /**
     * Adopts the documents of a userConfig object assigned in this session (a boot read), in the server's order: a
     * document whose revision is newer than the one the store holds is taken (operations still out stay on top of it); one
     * that is older is not. Without revisions, it is taken only while the store's document came from boot reads only and no
     * operation is out (a read, an answer or an acknowledged write since may be newer). Either way the revision moves on,
     * so a read that began before the assignment is not taken over it. The new object shows the store's document.
     */
    function adoptBootDocuments() {
        if (identity === undefined || identity !== currentIdentity()) return;
        for (const state of documents.values()) {
            if (state.userConfig === JE.userConfig) continue;
            const boot = bootDocument(state.fileName);
            const order = newerRevision(boot.serverRevision, state.serverRevision);
            // Without revisions, decided once the operations still out are answered (the object may not be this session's
            // documents at all: it is left alone meanwhile).
            if (order === undefined && state.pending.length) continue;
            state.userConfig = JE.userConfig;
            const take = order === undefined ? state.revision === state.bootRevision : order;
            const previousPersisted = state.persisted;
            if (take) {
                takeDocument(state, boot.persisted, boot.readOk, boot.serverRevision);
                state.bootRevision = state.revision;
            }
            // The new object's views are its boot documents already: re-derived only when the store holds something else
            // (its own document, or operations still out on top of the boot one). A boot document that brings a change
            // from elsewhere (another tab or device) is published as a read: its effects run (the display language is
            // mirrored, the cards follow).
            const changed = take && !sameValue(previousPersisted, state.persisted);
            if (take && !state.pending.length && !changed) state.shown = copyDocument(state.persisted);
            else publishDocument(state, previousPersisted, changed ? 'read' : 'settled');
        }
    }

    /** Get the active session's sole state for a file. Object replacement is just a new view. */
    const settingsDocument = fileName => {
        const now = currentIdentity();
        if (identity !== now) { clearDocuments(); identity = now; }
        let state = documents.get(fileName);
        // A userConfig object assigned before this session's states existed, or by a host that replaced the property: adopted
        // through the same rule as at assignment.
        if (state && state.userConfig !== JE.userConfig) adoptBootDocuments();
        if (!state) {
            // readOk: whether this session holds the document as the server last handed it out (the boot read or a later
            // read). Until then nothing is written to it: a read comes first. serverRevision: the server's revision of the
            // document held (undefined when the server named none). Writes go out on the document's one queue, bound to this
            // session (core/mutation-queue.js): checked right before each is sent, cancelled by an account switch.
            const { persisted, readOk, serverRevision } = bootDocument(fileName);
            state = { fileName, identity, userConfig: JE.userConfig, persisted, shown: copyDocument(persisted), pending: [], readOk,
                serverRevision, outsideTakes: 0, recovery: undefined, revision: 0, bootRevision: 0, readRevision: 0, observers: new Map(),
                effectWarnings: new Set(), mirroredLanguage: undefined, derived: undefined, routeWrites: 0, unconfirmed: [], reconciling: undefined };
            const created = state;
            state.queue = JE.core.mutationQueue(`settings:${fileName}`, { isCurrent: () => isActiveDocument(created) });
            documents.set(fileName, state);
        }
        return state;
    };

    /** True only while this document still belongs to the active identity/session. */
    const isActiveDocument = state => currentIdentity() === state.identity && documents.get(state.fileName) === state;

    /** True while any session document has unsent work, an in-flight transport or an unpublished result. */
    const hasPendingSettings = () => [...documents.values()].some(state => state.pending.length > 0 || state.routeWrites > 0);

    /** Re-check identity and all queues at the instant a destructive page effect would run. */
    const runScheduledReload = request => {
        if (reloadRequest !== request) return;
        request.timer = undefined;
        request.ready = true;
        if (!request.session.isCurrent()) { reloadRequest = undefined; return; }
        if (hasPendingSettings()) return; // Queue settlement wakes this request; never poll.
        reloadRequest = undefined;
        window.location.reload();
    };

    /** Wake a due reload after publication, allowing observers and promise completions to enqueue more work. */
    const resumeScheduledReload = () => {
        const request = reloadRequest;
        if (request?.ready && request.timer === undefined && !hasPendingSettings()) {
            request.timer = setTimeout(() => runScheduledReload(request), 0);
        }
    };

    /**
     * Coalesce settings-owned page reloads for the captured session. The initial delay is a minimum;
     * every per-user document queue must be idle before firing, including work queued during the delay.
     * @param {object} session Captured identity scope; panel close does not invalidate it.
     * @param {number} delay Minimum delay in milliseconds.
     */
    JE.internals.scheduleReloadWhenIdle = (session, delay = 1500) => {
        if (!session.isCurrent()) return;
        settingsDocument('settings.json');
        if (reloadRequest) return;
        const request = reloadRequest = { session, ready: false, timer: undefined };
        request.timer = setTimeout(() => runScheduledReload(request), delay);
    };

    /** Isolate one effect, including rejected async work; diagnostics cannot interrupt store settlement. */
    const runEffect = (state, kind, effect) => {
        /** Report each failing kind once in this document/session, retrying the effect on later publications. */
        const warn = error => {
            if (state.effectWarnings.has(kind)) return;
            state.effectWarnings.add(kind);
            try { console.warn(`🪼 Jellyfin Enhanced: Settings effect ${kind} failed; will retry.`, error); } catch { /* Best effort. */ }
        };
        try {
            const result = effect();
            if (result && typeof result.then === 'function') Promise.resolve(result).catch(warn);
        } catch (error) { warn(error); }
    };

    /** Replace a compatibility view in place, including deletion of fields absent from the document. */
    const replaceView = (view, document) => {
        for (const key of Object.keys(view)) if (!Object.hasOwn(document, key)) delete view[key];
        Object.assign(view, copyDocument(document));
    };

    /** Normalize a persisted display-language code for Jellyfin's per-user browser key. */
    const normalizeLanguage = code => {
        const parts = (code || '').split('-');
        return parts.length === 2 ? `${parts[0].toLowerCase()}-${parts[1].toUpperCase()}` : (code || '').toLowerCase();
    };

    // Every independently fallible publication effect has its own registration. Observers use the same isolation.
    // Kept under internals so additional settings surfaces can share the boundary instead of adding handler effects.
    const settingsEffects = JE.internals.settingsDocumentEffects = new Map();
    for (const [key, name, selectors, options] of [
        ['qualityTagsEnabled', 'Quality', '.quality-overlay-container', ['qualityTagsPosition', 'qualityTagsPreferredAudioLanguage',
            'showResolutionTag', 'showSourceTag', 'showDynamicRangeTag', 'showSpecialFormatTag', 'showVideoCodecTag', 'showAudioInfoTag',
            'resolutionTagOrder', 'sourceTagOrder', 'dynamicRangeTagOrder', 'specialFormatTagOrder', 'videoCodecTagOrder', 'audioInfoTagOrder']],
        ['genreTagsEnabled', 'Genre', '.genre-overlay-container', ['genreTagsPosition']],
        ['languageTagsEnabled', 'Language', '.language-overlay-container', ['languageTagsPosition']],
        ['ratingTagsEnabled', 'Rating', '.rating-overlay-container', ['ratingTagsPosition', 'ratingTagsOnMovies', 'ratingTagsOnSeries',
            'ratingTagsOnSeasons', 'ratingTagsOnEpisodes', 'ratingTagsOnContinueWatching', 'ratingTagsOnNextUp']],
        ['ageRatingTagsEnabled', 'AgeRating', '.age-rating-overlay-container', ['ageRatingTagsPosition']],
        ['peopleTagsEnabled', 'People', '.je-people-place-banner, .je-people-age-container', []]
    ]) {
        settingsEffects.set(`tags-${name}`, ({ before, after, changed }) => {
            if (before[key] !== after[key]) {
                if (after[key]) return JE[`initialize${name}Tags`]?.();
                document.querySelectorAll(selectors).forEach(el => el.remove());
                if (name === 'People') document.querySelectorAll('.je-deceased-poster').forEach(el => el.classList.remove('je-deceased-poster'));
            } else if (after[key] && changed(options)) return JE[`reinitialize${name}Tags`]?.();
        });
    }
    settingsEffects.set('tag-stacking', ({ state, before, after }) => {
        if (!['qualityTagsEnabled', 'genreTagsEnabled', 'languageTagsEnabled', 'ratingTagsEnabled', 'ageRatingTagsEnabled', 'peopleTagsEnabled']
            .some(key => before[key] && !after[key])) return;
        const hosts = new Set();
        document.querySelectorAll('[data-je-corner]').forEach(el => { if (el.parentElement) hosts.add(el.parentElement); });
        hosts.forEach(host => runEffect(state, 'tag-stacking-host', () => JE.core?.tagRenderer?.applyCornerStacking?.(host)));
    });
    settingsEffects.set('tag-hover', ({ after, changed }) => {
        if (changed(['tagsHideOnHover'])) document.body.classList.toggle('je-tags-hide-on-hover', !!after.tagsHideOnHover);
    });
    settingsEffects.set('random-button', ({ changed }) => { if (changed(['randomButtonEnabled'])) return JE.addRandomButton?.(); });
    for (const [key, selector] of [['showWatchProgress', '.mediaInfoItem-watchProgress'], ['showFileSizes', '.mediaInfoItem-fileSize'],
        ['showAudioLanguages', '.mediaInfoItem-audioLanguage']]) {
        settingsEffects.set(`details-${key}`, ({ after, changed }) => {
            if (changed([key]) && !after[key]) document.querySelectorAll(selector).forEach(el => el.remove());
        });
    }
    settingsEffects.set('details-refresh', ({ changed }) => {
        if (changed(['showWatchProgress', 'showFileSizes', 'showAudioLanguages', 'watchProgressMode', 'watchProgressTimeFormat'])) {
            return JE.internals.features?.refreshDetailsSettings?.();
        }
    });
    settingsEffects.set('pause-delay', ({ after }) => {
        if (JE.pauseScreenInstance) JE.pauseScreenInstance.pauseScreenDelayMs = after.pauseScreenDelaySeconds * 1000;
    });
    settingsEffects.set('subtitle-styles', ({ changed }) => {
        if (changed(['disableCustomSubtitleStyles', 'customSubtitleTextColor', 'customSubtitleBgColor', 'usingCustomColors',
            'selectedStylePresetIndex', 'selectedFontSizePresetIndex', 'selectedFontFamilyPresetIndex', 'selectedTextEffectPresetIndex'])) {
            return JE.applySavedStylesWhenReady?.();
        }
    });
    settingsEffects.set('subtitle-position', ({ changed }) => {
        if (changed(['subtitleHorizontalPosition', 'subtitleVerticalPosition', 'disableCustomSubtitleStyles'])) return JE.applySubtitlePosition?.();
    });
    settingsEffects.set('acquisition-cards', ({ state, previousShown, previousPersisted, reason }) => {
        // Hide is immediate. Show reads again after persistence; failures restore the surface too.
        const before = previousShown.acquisitionBadges, after = state.shown.acquisitionBadges;
        if ((reason === 'queued' ? after === false && before !== false : before !== after)
            || (reason === 'saved' && state.persisted.acquisitionBadges !== previousPersisted.acquisitionBadges
                && state.persisted.acquisitionBadges === after && after !== false)) return JE.internals.arrStatusCards?.reset?.();
    });
    settingsEffects.set('list-pages', ({ changed }) => {
        // Phase 4c3a: list pages follow a list preference change at once (drawn entries go when hidden).
        if (changed(['listPlaceholders', 'listStatus', 'listPlaylistUi', 'listCollectionUi'])) return JE.arrListPages?.settingsChanged?.();
    });
    settingsEffects.set('home-rows', ({ state, previousPersisted, reason }) => {
        // Phase 4d: the home page reads its rows again once a home-row choice is persisted.
        if (reason !== 'saved') return;
        if (['homeRowRequests', 'homeRowSoon', 'homeRowArrived', 'homeOpsStrip']
            .some(key => (previousPersisted[key] ?? null) !== (state.persisted[key] ?? null))) return JE.arrHome?.refresh?.({ fresh: true });
    });
    settingsEffects.set('language-mirror', ({ state, previousPersisted, reason }) => {
        if (reason !== 'saved' && reason !== 'read') return;
        // What the server stored is mirrored (a save's answer sets it as persisted; reads hand out the gated value). The
        // same rule again here: a stored "undefined" or "null", a malformed value or a language JE ships no bundle for
        // mirrors as Auto (''). Without the translations module's check nothing is written.
        if (typeof JE.supportedLanguageCode !== 'function') return;
        const language = JE.supportedLanguageCode(resolveSettings(state.persisted).displayLanguage);
        // Jellyfin's own Display settings write the same key: JE writes it only when its own display language differs from
        // the one it last mirrored (a save, or a read of another browser's change), so saving any other JE setting never
        // replaces the person's choice there. A failed write is retried at the next publication.
        if (state.mirroredLanguage === undefined) state.mirroredLanguage = JE.supportedLanguageCode(resolveSettings(previousPersisted).displayLanguage);
        if (language === state.mirroredLanguage) return;
        const key = `${ApiClient.getCurrentUserId()}-language`;
        if (localStorage.getItem(key) !== language) localStorage.setItem(key, language);
        state.mirroredLanguage = language;
    });
    for (const [kind, effect] of [
        ['language-toast', () => JE.toast?.(JE.t('toast_language_changed'))],
        ['language-reload', () => JE.internals.scheduleReloadWhenIdle(JE.internals.settingsSessionScope())]
    ]) {
        settingsEffects.set(kind, ({ state, previousPersisted, reason, savedKeys }) => {
            // This save's own language choice (another device's, arriving with an answer, waits for the next page load).
            if (reason === 'saved' && savedKeys.includes('displayLanguage') && normalizeLanguage(resolveSettings(state.persisted).displayLanguage)
                !== normalizeLanguage(resolveSettings(previousPersisted).displayLanguage)) return effect();
        });
    }
    for (const [keys, toastKey] of [
        [['acquisitionBadges', 'nativeAcquisitionStamps'], 'toast_badge_settings_saved'],
        [['listPlaceholders', 'listStatus', 'listSwapIn', 'listPlaylistUi', 'listCollectionUi'], 'toast_list_settings_saved'],
        [['useNativePosterTags'], 'toast_native_poster_tags_saved'],
        [['autoSeasonRequests', 'autoMovieRequests'], 'toast_auto_requests_saved'],
        [['homeRowRequests', 'homeRowSoon', 'homeRowArrived', 'homeOpsStrip'], 'panel_settings_home_saved']
    ]) {
        settingsEffects.set(toastKey, ({ state, previousPersisted, reason, savedKeys }) => {
            if (reason !== 'saved' || !keys.some(key => savedKeys.includes(key))) return;
            const before = resolveSettings(previousPersisted), after = resolveSettings(state.persisted);
            if (keys.some(key => (before[key] ?? null) !== (after[key] ?? null))) return JE.toast?.(JE.t(toastKey));
        });
    }

    /** Run effects only after the derived state and compatibility views agree; isolate every subscriber. */
    const runEffects = (state, previousShown, previousPersisted, reason, entry) => {
        if (state.fileName === 'settings.json') {
            const before = resolveSettings(previousShown), after = resolveSettings(state.shown);
            // The fields the settled save itself set (an answer also brings what other tabs or devices saved).
            const savedKeys = entry ? (entry.consentKey ? [entry.consentKey] : Object.keys(entry.set || {})) : [];
            const context = { state, previousShown, previousPersisted, reason, before, after, savedKeys,
                changed: keys => keys.some(key => before[key] !== after[key]) };
            for (const [kind, effect] of [...settingsEffects]) {
                if (!isActiveDocument(state)) break;
                runEffect(state, kind, () => effect(context));
            }
        }
        for (const [name, observer] of [...state.observers, ...(documentObservers.get(state.fileName) || [])]) {
            if (!isActiveDocument(state)) break;
            runEffect(state, `observer-${name}`, () => observer(copyDocument(state.shown), reason));
        }
        // Queue settlement must wake reloads even when every consumer fails. The timer rechecks identity/work.
        resumeScheduledReload();
    };

    /** Recompute from the persisted document + pending operations in order; views never supply rollback snapshots. */
    const publishDocument = (state, previousPersisted = state.persisted, reason = 'settled', entry = undefined) => {
        if (!isActiveDocument(state)) return;
        const previousShown = state.shown;
        // An operation whose outcome is uncertain stays shown (it may be stored) until a whole document of the server says.
        state.shown = [...state.unconfirmed, ...state.pending].reduce((doc, pending) => applyOperation(state.fileName, doc, pending), copyDocument(state.persisted));
        // Views belong to the userConfig object the document was read into: a replaced one (another boot) is not this one's.
        const view = JE.userConfig === state.userConfig ? kindOf(state.fileName)?.view : undefined;
        if (view) {
            JE.userConfig = JE.userConfig || {};
            if (!JE.userConfig[view] || typeof JE.userConfig[view] !== 'object') JE.userConfig[view] = {};
            replaceView(JE.userConfig[view], state.shown);
        }
        if (state.fileName === 'settings.json' && JE.userConfig === state.userConfig) {
            JE.currentSettings = JE.currentSettings || {};
            replaceView(JE.currentSettings, resolveSettings(state.shown));
        }
        runEffects(state, previousShown, previousPersisted, reason, entry);
    };

    /** Subscribe a named pure view; replacement panels replace their observer without replacing state. */
    JE.internals.observeSettingsDocument = (name, observer) => {
        const state = settingsDocument('settings.json');
        state.observers.set(name, observer);
        runEffect(state, `observer-${name}`, () => observer(copyDocument(state.shown)));
    };

    /**
     * Subscribe a named view of any per-user document (called now and after every publication of it, in this session and
     * the next person's).
     * @param {string} fileName Per-user document.
     * @param {string} name Observer name; a later registration under the same name replaces it.
     * @param {Function} observer Receives a copy of the document as shown, and why it was published.
     */
    JE.internals.observeUserDocument = (fileName, name, observer) => {
        const state = settingsDocument(fileName);
        if (!documentObservers.has(fileName)) documentObservers.set(fileName, new Map());
        documentObservers.get(fileName).set(name, observer);
        runEffect(state, `observer-${name}`, () => observer(copyDocument(state.shown), 'observed'));
    };

    /**
     * A per-user document as the store shows it (persisted + pending operations): the one source every caller reads.
     * @param {string} fileName Per-user document.
     * @returns {{document: object, read: boolean}} A copy, and whether this session has read it from the server.
     */
    JE.internals.userDocument = fileName => {
        const state = settingsDocument(fileName);
        return { document: copyDocument(state.shown), read: state.readOk };
    };

    /**
     * Read a server document with a revision fence. A response begun during/before a newer save
     * cannot replace that save's baseline, even if it arrives after the save completes.
     * @param {string} fileName Settings document to read.
     * @returns {Promise<boolean>} Whether the response belongs to the active session.
     */
    JE.readUserSettings = async fileName => {
        const state = settingsDocument(fileName);
        const revision = state.revision, readRevision = ++state.readRevision;
        const hadPending = state.pending.length > 0;
        const userId = ApiClient.getCurrentUserId();
        // With its revision (a server that names none answers the document alone).
        const response = await ApiClient.ajax({ type: 'GET',
            url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${userId}/${fileName}?withRevision=true&_=${Date.now()}`), dataType: 'json' });
        if (!isActiveDocument(state)) return false;
        const enveloped = response && typeof response === 'object' && answerRevision(response) !== undefined
            && (Object.hasOwn(response, 'document') || Object.hasOwn(response, 'Document'));
        const read = enveloped ? (response.document ?? response.Document) : response;
        const readServerRevision = enveloped ? answerRevision(response) : undefined;
        const previousPersisted = state.persisted;
        // Taken only if nothing changed the document since this read began (no operation queued or answered, no write
        // acknowledged, no other read taken), no newer read began, and it is not older than the document held (the server's
        // order): otherwise it may hold less than this page does.
        if (read && !hadPending && !state.pending.length && revision === state.revision && readRevision === state.readRevision
            && newerRevision(state.serverRevision, readServerRevision) !== true) {
            takeDocument(state, holdDocument(fileName, read), true, readServerRevision);
        }
        publishDocument(state, previousPersisted, 'read');
        return true;
    };

    /**
     * A document handle: the document of the session an action began in, taken when it begins (before any wait), with the
     * action's origin. Everything the action does with that document afterwards goes through the handle, never through a
     * file name looked up again later (a file name names whichever person is signed in by then):
     *  - send(transmit): a write of another route that changes the document (Hidden Content's home-row removal), on the
     *    document's queue: after every change of it queued before (answered first, so the server applies them before it),
     *    cancelled by an account switch, and sent through JE.core.userWrite with the action's origin;
     *  - acknowledge(operation, serverRevision): that route's answer becomes part of the persisted document, in the server's
     *    order; ignored once the handle's document or origin is not the signed-in session's (a late answer of the previous
     *    person changes nothing of the next person's: not their document, its revision, its views or its effects);
     *  - revision / noteRead(document, revision): a read of the document made outside readUserSettings is reported with the
     *    revision taken before its request (ignored while operations are pending or the document changed since);
     *  - document(): the document as the store shows it; isCurrent(): whether the handle still belongs to the signed-in
     *    session.
     * @param {string} fileName Per-user document.
     * @param {any} origin JE.core.userWrite.origin() when the person acted.
     * @returns {{fileName: string, origin: any, isCurrent: () => boolean, document: () => object, readonly revision: number,
     *   send: (transmit: (origin: any) => Promise<any>) => Promise<any>, acknowledge: (operation: object, serverRevision?: string) => boolean,
     *   noteRead: (document: object, revision: number) => boolean}}
     */
    JE.internals.userDocumentHandle = (fileName, origin) => {
        const state = settingsDocument(fileName);
        const isCurrent = () => !!origin && isActiveDocument(state) && JE.core.userWrite.isBound(origin);
        return Object.freeze({
            fileName,
            origin,
            isCurrent,
            document: () => copyDocument(state.shown),
            get revision() { return state.revision; },
            send(transmit) {
                state.revision++;
                // Out until answered: a page reload waits for it like for the document's own saves.
                state.routeWrites++;
                const settle = () => { state.routeWrites--; resumeScheduledReload(); };
                const sent = state.queue.send(transmit, origin);
                sent.then(settle, settle);
                return sent;
            },
            acknowledge(operation, serverRevision) {
                if (!isCurrent() || !state.readOk || !kindOf(fileName)) return false;
                // Older than the document the store holds (an answer of a later write was taken first): that document has it.
                if (newerRevision(serverRevision, state.serverRevision) === false) return false;
                const previousPersisted = state.persisted;
                // The document is the one held before plus the acknowledged changes, in the server's order: kept with it, so
                // an answer of a write that was out meanwhile (older than the acknowledgement) can be put under them.
                const known = typeof serverRevision === 'string';
                const derived = known ? state.derived || { base: previousPersisted, baseRevision: state.serverRevision, acks: [] } : undefined;
                // A change source like a save's answer: the revision moves on, so a read that began before it is not taken.
                takeDocument(state, applyOperation(fileName, previousPersisted, copyDocument(operation)), true, known ? serverRevision : undefined, true, false);
                if (derived) {
                    derived.acks.push({ operation: copyDocument(operation), revision: serverRevision });
                    state.derived = derived;
                }
                publishDocument(state, previousPersisted, 'saved');
                return true;
            },
            noteRead(document, revision) {
                if (!isCurrent() || state.pending.length || !document || typeof document !== 'object' || revision !== state.revision) return false;
                const previousPersisted = state.persisted;
                takeDocument(state, holdDocument(fileName, document));
                publishDocument(state, previousPersisted, 'read');
                return true;
            }
        });
    };

    /**
     * Settles once every operation queued on a document so far has been answered (whatever the outcome).
     * @param {string} fileName Per-user document.
     * @returns {Promise<void>}
     */
    JE.internals.userDocumentSettled = fileName => settingsDocument(fileName).queue.settled().then(() => {});

    /**
     * Refuse a write to a document this session could not read (the read started for the write failed too): what it would
     * send was decided against defaults. Views fall back to the persisted document and the person is told why.
     * @param {object} state Document state.
     * @returns {Error} The refusal, for callers that reject.
     */
    const refuseUnreadSave = state => {
        publishDocument(state, state.persisted, 'failed');
        // Long enough to read (the default toast is gone in 1.5 s).
        try { JE.toast?.(JE.t?.('settings_save_not_read') || 'Your settings couldn\'t be loaded, so this change wasn\'t saved. Try again in a moment, or reload the page.', 6000); } catch { /* Best effort. */ }
        const error = new Error(`${state.fileName} was not read in this session; nothing was saved`);
        error.settingsNotRead = true;
        error.writeOutcome = 'unsent';
        return error;
    };

    /** One read of an unread document, shared by every write waiting for it; it publishes the stored document. */
    const recoverRead = state => {
        if (!state.recovery) {
            state.recovery = JE.readUserSettings(state.fileName).catch(() => false).finally(() => { state.recovery = undefined; });
        }
        return state.recovery;
    };

    /**
     * The persisted document after a successful operation, in the server's order. The answer's document holds every
     * writer's changes up to this write, and is taken whole when nothing reached the store from outside since the write
     * was sent, or when its revision is newer than the document held. An answer the server's revisions show is not newer
     * than a document the server handed out whole since (a read or a boot read that came after this write) changes
     * nothing: that document already holds this operation's result, and whatever came after it, so neither the operation
     * nor the answer's fields are applied again; it stays the baseline (a later save of the value this operation set is a
     * change again). When the newer document is acknowledged changes of another route on top of an older one, the answer
     * (the server's document up to this write) goes under them. Without revisions on both sides (a server that names none)
     * the order is unknown: the operation is kept on top of the store's document, so it isn't lost.
     */
    const settleAnswer = (state, entry, previous) => {
        const response = entry.response;
        const revision = answerRevision(response);
        const answered = !entry.consentKey && (response?.document ?? response?.Document);
        const order = newerRevision(revision, state.serverRevision);
        if (order === false) {
            const derived = state.derived;
            if (derived && answered && typeof answered === 'object' && newerRevision(revision, derived.baseRevision) !== false) {
                // The newer document is only acknowledged changes on top of an older one (another route's writes, answered
                // while this one was out): the answer is the server's document up to this write, and the acknowledged
                // changes after it go on top of it again, in the server's order.
                const acks = derived.acks.filter(ack => newerRevision(ack.revision, revision) === true);
                const base = withAnswerFields(state, holdDocument(state.fileName, answered), response);
                const held = state.serverRevision;
                takeDocument(state, acks.reduce((doc, ack) => applyOperation(state.fileName, doc, ack.operation), base), true, held, false);
                if (acks.length) state.derived = { base, baseRevision: revision, acks };
                return;
            }
            // Older than a document the server handed out whole (a read, a boot read, another answer): that document holds
            // this write and whatever came after it. It stays as held (its revision too); only the store's revision moves on.
            takeDocument(state, previous, true, state.serverRevision, false, false);
            return;
        }
        const whole = answered && typeof answered === 'object' && (state.outsideTakes === entry.outsideAt || order === true);
        const next = whole ? holdDocument(state.fileName, answered) : applyOperation(state.fileName, previous, entry);
        // The server's revision of what the store now holds: the answer's when it is taken whole or known to be newer, else
        // unknown.
        const held = whole || order === true ? revision : undefined;
        takeDocument(state, withAnswerFields(state, next, response), true, held, false, !!whole);
    };

    /** The consents and display language an answer of settings.json carries, as the server stored them. */
    const withAnswerFields = (state, next, response) => {
        if (state.fileName === 'settings.json') {
            const consents = response?.consents || response?.Consents;
            for (const key of consentKeys) {
                const value = consents && Object.hasOwn(consents, pascal(key)) ? consents[pascal(key)] : consents?.[key];
                if (value !== undefined) next[key] = value;
            }
            // The display language as the server stored it (its gate's answer): what the shared key mirrors.
            const stored = response?.displayLanguage ?? response?.DisplayLanguage;
            if (typeof stored === 'string') next.displayLanguage = stored;
        }
        return next;
    };

    // How long one reconciliation read of an uncertain write may take before the outcome stays unknown.
    const RECONCILE_TIMEOUT_MS = 10000;

    /**
     * After a write whose outcome is uncertain (its attempt went out and its answer was lost), ONE read of the same document,
     * for the same origin, says what the server holds now: whether the operation is in it (stored) or not. It runs only
     * while the origin and the document are the signed-in session's (an account switch cancels it: nothing is read as the
     * next person, nothing kept of the previous one's credentials) and is never repeated or retried; the write itself is
     * never sent again. A read showing the change without it doesn't prove the write never landed (another writer may have
     * changed it since): the page then says it couldn't confirm the change, and shows what the server holds.
     * @param {object} state The originating document.
     * @param {object} entry The operation.
     * @param {any} origin The action's origin.
     */
    const reconcileUncertain = (state, entry, origin) => {
        const current = () => isActiveDocument(state) && JE.core.userWrite.isBound(origin);
        if (!current()) return;
        if (!state.reconciling) {
            let timer;
            const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(false), RECONCILE_TIMEOUT_MS); });
            state.reconciling = Promise.race([JE.readUserSettings(state.fileName).catch(() => false), timeout])
                .finally(() => { clearTimeout(timer); state.reconciling = undefined; });
        }
        state.reconciling.then(read => {
            if (!current()) return;
            if (read && !state.unconfirmed.includes(entry)) {
                const stored = entry.consentKey
                    ? sameValue(state.persisted[entry.consentKey], entry.value)
                    : sameValue(applyOperation(state.fileName, state.persisted, entry), state.persisted);
                JE.toast?.(stored
                    ? (JE.t?.('settings_save_confirmed') || 'Your change was saved.')
                    : (JE.t?.('settings_save_unconfirmed_read') || 'Couldn\'t confirm your change was saved. This page shows what the server holds now.'), 4000);
            }
        }).catch(() => { /* Best effort: the outcome stays unknown. */ });
    };

    /**
     * Queue one operation on a per-user document. Before anything is written to a document this session has not read, one
     * read publishes the stored document; if it fails the write is refused (and said so). Operations go one at a time and
     * in order; success makes the server's answer the persisted document. A write that ends:
     *  - refused or not sent (proven: the server refused it, or it was cancelled before any attempt went out): only this
     *    operation is dropped, and the page says it wasn't saved;
     *  - uncertain (an attempt went out and its answer was lost): the operation stays shown as unconfirmed, the page says it
     *    couldn't confirm the change (never that it wasn't saved), and one read of the same document says what is stored.
     * The action's origin (`options.origin`, JE.core.userWrite.origin() taken when the person acted): a caller that waited
     * before calling passes the one it took; only a direct call from the person's gesture may leave it out (then the
     * session at the call is its origin, taken before any wait of this function).
     * @param {string} fileName Per-user document.
     * @param {object} operation See applyOperation.
     * @param {{throwOnError?: boolean, consentKey?: string, reportsFailure?: boolean, origin?: any}} [options]
     * @returns {Promise<void>}
     */
    const queueOperation = async (fileName, operation, options = {}) => {
        try {
            if (typeof ApiClient === 'undefined' || !ApiClient.getCurrentUserId) throw Object.assign(new Error('ApiClient not available'), { writeOutcome: 'unsent' });
            // The session the person made this change in, taken by the caller when the person acted (before any wait): the
            // write is sent only while it is still the signed-in one (JE.core.userWrite.send checks it right before the
            // request is built), and its answers apply only to the document of that session.
            // An entry point: the origin its caller took (required after any wait), or the session of a direct call now.
            const origin = JE.core.userWrite.originOf(options.origin);
            if (!ApiClient.getCurrentUserId()) throw Object.assign(new Error('User ID not available'), { writeOutcome: 'unsent' });
            if (!JE.core.userWrite.isBound(origin)) {
                throw Object.assign(new Error(`${fileName}: the session changed; this write was not sent`), { sessionChanged: true, writeOutcome: 'unsent' });
            }
            const userId = origin.userId || ApiClient.getCurrentUserId();
            if (!userId) throw Object.assign(new Error('User ID not available'), { writeOutcome: 'unsent' });
            const state = settingsDocument(fileName);
            if (!options.consentKey && !state.readOk) {
                await recoverRead(state);
                if (!isActiveDocument(state)) throw Object.assign(new Error('Settings session changed'), { sessionChanged: true, writeOutcome: 'unsent' });
                if (!state.readOk) throw refuseUnreadSave(state);
            }
            const entry = { ...operation, consentKey: options.consentKey };
            if (!entry.consentKey && isEmptyOperation(entry)) return;
            const url = ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${userId}/${entry.consentKey ? 'consent' : fileName}`);
            const data = entry.consentKey ? { Field: pascal(entry.consentKey), Value: entry.value } : wireOf(fileName, entry);
            let succeeded = false, failure;
            try {
                state.revision++;
                state.pending.push(entry);
                // The document's one queue (an account switch cancels it unsent); at its turn it goes out through
                // JE.core.userWrite with the origin it was made in, checked right before the request is built.
                const save = state.queue.send(async bound => {
                    entry.outsideAt = state.outsideTakes;
                    entry.response = await JE.core.userWrite.ajax(bound, { type: 'PATCH', url, dataType: 'json',
                        data: JSON.stringify(data), contentType: 'application/json' });
                }, origin);
                publishDocument(state, state.persisted, 'queued');
                await save; succeeded = true;
            }
            catch (error) {
                failure = error;
                // A save refused by a server of another JE build: the page learns it must be reloaded (an answer of a write
                // is the server's now, never a kept copy).
                JE.core?.build?.noteAnswer?.(error, { fresh: true });
                throw error;
            }
            finally {
                const index = state.pending.indexOf(entry);
                if (index !== -1) state.pending.splice(index, 1);
                const previousPersisted = state.persisted;
                const uncertain = !succeeded && JE.core.userWrite.outcome(failure) === 'uncertain';
                // Uncertain: it may be stored, so it stays shown (unconfirmed) until a whole document of the server says.
                if (uncertain && isActiveDocument(state)) state.unconfirmed.push(entry);
                if (succeeded) settleAnswer(state, entry, previousPersisted);
                publishDocument(state, previousPersisted, succeeded ? 'saved' : uncertain ? 'unconfirmed' : 'failed', entry);
                if (uncertain && !failure?.sessionChanged) reconcileUncertain(state, entry, origin);
            }
        } catch (error) {
            // A change the page showed is shown as not saved only when that is proven, never only logged: an account change
            // says so once for all of them (JE.core.userWrite.notSent; "couldn't be confirmed" when an attempt went out), a
            // document that couldn't be read said so already, an uncertain write says it couldn't be confirmed, and any
            // other refusal says it wasn't saved (unless the caller shows its own message).
            const outcome = JE.core.userWrite.outcome(error);
            if (error?.sessionChanged) JE.core.userWrite.notSent(error);
            else if (!error?.settingsNotRead && options?.reportsFailure !== true) {
                if (outcome === 'uncertain') JE.core.userWrite.reportUncertain(error);
                else reportNotSaved();
            }
            if (options?.throwOnError === true) throw error;
            if (error?.settingsNotRead || error?.sessionChanged || outcome === 'uncertain') console.warn(`🪼 Jellyfin Enhanced: ${error.message}`);
            else console.error(`🪼 Jellyfin Enhanced: Failed to save ${fileName}:`, error);
        }
    };

    // When the last "not saved" notice was shown (several refusals in a row show one).
    let notSavedShownAt = 0;
    /** Tells the person that a change they made wasn't saved (the control shows the stored value again). */
    const reportNotSaved = () => {
        const now = Date.now();
        if (now - notSavedShownAt < 2000) return;
        notSavedShownAt = now;
        try {
            const text = JE.t?.('settings_not_saved');
            JE.toast?.(text && text !== 'settings_not_saved' ? text : 'Your change wasn\'t saved. Try again in a moment.', 5000);
        } catch { /* Best effort. */ }
    };

    /** Save the given settings fields (and only those). `options.origin`: JE.core.userWrite.origin() when the person acted. */
    JE.updateSettings = (patch, options) => {
        const set = {};
        for (const [key, value] of Object.entries(patch || {})) if (!consentKeys.includes(key)) set[key] = value;
        return queueOperation('settings.json', { set: copyDocument(set) }, options);
    };

    /**
     * Change records or items of a per-user document: { set } (settings.json, elsewhere.json), { upsert, remove }
     * (bookmark.json by id, shortcuts.json by Name), { add, remove } (ddd-triggers.json), { upsert, remove, set }
     * (hidden-content.json: items by key, settings by field). Nothing else in it is sent.
     * @param {string} fileName Per-user document.
     * @param {object} operation The changes.
     * @param {{throwOnError?: boolean, origin?: any}} [options] Reject failures for callers that request it; origin: the
     *   action's (JE.core.userWrite.origin() when the person acted; required after any wait).
     * @returns {Promise<void>}
     */
    JE.patchUserSettings = (fileName, operation, options) => {
        if (!kindOf(fileName)) return Promise.reject(new Error(`${fileName} has no operations`));
        return queueOperation(fileName, copyDocument(operation), options);
    };

    /** Queue one explicit personal-consent choice; no display document is sent to the server. */
    JE.setPersonalConsent = (field, value, options = {}) => {
        const valid = typeof value === 'boolean' || (value === null && followConsentKeys.includes(field));
        if (!consentKeys.includes(field) || !valid) return Promise.reject(new Error('Invalid personal consent'));
        return queueOperation('settings.json', { value }, { ...options, consentKey: field });
    };

    /**
     * Save a per-user document a caller changed as a whole: only what differs from the document as the store shows it is
     * sent (as operations). No per-user document is written whole.
     * @param {string} fileName Per-user settings file.
     * @param {object} settings The changed document (for settings.json: resolved settings such as JE.currentSettings).
     * @param {{throwOnError?: boolean, origin?: any}} [options] Reject failures for callers that request it; origin: the
     *   action's (JE.core.userWrite.origin() when the person acted; required after any wait).
     * @returns {Promise<void>}
     */
    JE.saveUserSettings = (fileName, settings, options = {}) => {
        if (options.consentKey) return JE.setPersonalConsent(options.consentKey, settings?.[options.consentKey], options);
        if (!kindOf(fileName)) return Promise.reject(new Error(`${fileName} has no operations`));
        // What the caller changed, against what it was shown (taken now: a read that comes first must not turn the rest of
        // what it saw into changes).
        const state = settingsDocument(fileName);
        const before = fileName === 'settings.json' ? resolveSettings(state.shown) : state.shown;
        return queueOperation(fileName, operationBetween(fileName, before, copyDocument(settings)), options);
    };

    /**
     * Loads and merges settings from user config, plugin defaults, and hardcoded fallbacks.
     */
    const resolveSettings = userSettings => {
        const pluginDefaults = JE.pluginConfig || {};

        const hardcodedDefaults = {
            autoPauseEnabled: true, autoResumeEnabled: false, autoPipEnabled: false,
            autoSkipIntro: false, autoSkipOutro: false,
            selectedStylePresetIndex: 0, selectedFontSizePresetIndex: 2, selectedFontFamilyPresetIndex: 0, selectedTextEffectPresetIndex: 0,
            customSubtitleTextColor: '#FFFFFFFF', customSubtitleBgColor: '#00000000',
            usingCustomColors: false,
            disableCustomSubtitleStyles: false,
            subtitleVerticalPosition: 95, subtitleHorizontalPosition: 50,
            randomButtonEnabled: true,
            randomIncludeMovies: true, randomIncludeShows: true, randomUnwatchedOnly: false,
            randomScopeCurrentContainer: false, randomSourceId: '',
            showWatchProgress: false, showFileSizes: false, showAudioLanguages: true, removeContinueWatchingEnabled: false,
            watchProgressMode: 'percentage',
            watchProgressTimeFormat: 'hours',
            pauseScreenEnabled: true,
            pauseScreenDelaySeconds: 5,
            useNativePosterTags: true,
            qualityTagsEnabled: false, genreTagsEnabled: false, languageTagsEnabled: false, ratingTagsEnabled: false, ageRatingTagsEnabled: false, peopleTagsEnabled: false, tagsHideOnHover: false,
            showResolutionTag: true, showSourceTag: true, showDynamicRangeTag: true, showSpecialFormatTag: true, showVideoCodecTag: true, showAudioInfoTag: true,
            resolutionTagOrder: 1, sourceTagOrder: 2, dynamicRangeTagOrder: 3, specialFormatTagOrder: 4, videoCodecTagOrder: 5, audioInfoTagOrder: 6,
            qualityTagsPosition: 'top-left', genreTagsPosition: 'top-right', languageTagsPosition: 'bottom-left', ratingTagsPosition: 'bottom-right', ageRatingTagsPosition: 'bottom-right',
            ratingTagsOnMovies: true, ratingTagsOnSeries: true, ratingTagsOnSeasons: true, ratingTagsOnEpisodes: true, ratingTagsOnContinueWatching: true, ratingTagsOnNextUp: true,
            qualityTagsPreferredAudioLanguage: '',
            showRatingInPlayer: true,
            reviewsExpandedByDefault: false,
            displayLanguage: '',
            calendarDisplayMode: 'list',
            calendarDefaultViewMode: 'agenda',
            disableAllShortcuts: false, longPress2xEnabled: false, lastOpenedTab: 'shortcuts'
        };

        // Aliases mapping camelCase client settings keys to potential server plugin default keys
        const pluginDefaultAliases = {
            selectedStylePresetIndex: ['DefaultSubtitleStyle', 'SelectedStylePresetIndex'],
            selectedFontSizePresetIndex: ['DefaultSubtitleSize', 'SelectedFontSizePresetIndex'],
            selectedFontFamilyPresetIndex: ['DefaultSubtitleFont', 'SelectedFontFamilyPresetIndex'],
            displayLanguage: ['DefaultLanguage', 'DisplayLanguage'],
            watchProgressMode: ['WatchProgressDefaultMode', 'WatchProgressMode'],
            watchProgressTimeFormat: ['WatchProgressTimeFormat'],
            pauseScreenDelaySeconds: ['PauseScreenDelaySeconds']
        };

        /**
         * Resolves a default value from pluginDefaults for a given camelCase key.
         */
        const getPluginDefault = (key) => {
            const aliases = pluginDefaultAliases[key] || [];
            const candidates = [
                key,
                key.charAt(0).toUpperCase() + key.slice(1),
                ...aliases
            ];

            for (const candidate of candidates) {
                const value = pluginDefaults[candidate];
                if (value !== null && value !== undefined) {
                    return value;
                }
            }

            return undefined;
        };

        const mergedSettings = {};
        // Seed with all keys from the stored user settings so that any field not
        // listed in hardcodedDefaults (e.g. fields added in newer plugin versions,
        // or fields the frontend doesn't actively manage) is preserved as-is and
        // not silently dropped when currentSettings is written back to the server.
        for (const key in userSettings) {
            mergedSettings[key] = userSettings[key];
        }
        for (const key in hardcodedDefaults) {
            if (Object.prototype.hasOwnProperty.call(userSettings, key) && userSettings[key] !== null && userSettings[key] !== undefined) {
                // Detect corrupted values (empty arrays or unexpected objects)
                if (typeof userSettings[key] === 'object' && Array.isArray(userSettings[key]) && userSettings[key].length === 0) {
                    const fallback = getPluginDefault(key);
                    mergedSettings[key] = fallback !== undefined ? fallback : hardcodedDefaults[key];
                } else if (typeof userSettings[key] === 'object' && userSettings[key] !== null && !Array.isArray(userSettings[key])) {
                    const fallback = getPluginDefault(key);
                    mergedSettings[key] = fallback !== undefined ? fallback : hardcodedDefaults[key];
                } else {
                    mergedSettings[key] = userSettings[key];
                }
            } else {
                const pluginVal = getPluginDefault(key);
                if (pluginVal !== undefined) {
                    mergedSettings[key] = pluginVal;
                } else {
                    mergedSettings[key] = hardcodedDefaults[key];
                }
            }
        }

        mergedSettings.displayLanguage = Object.prototype.hasOwnProperty.call(userSettings, 'displayLanguage')
            && userSettings.displayLanguage !== null && userSettings.displayLanguage !== undefined
            ? userSettings.displayLanguage
            : (getPluginDefault('displayLanguage') || '');
        mergedSettings.lastOpenedTab = userSettings.lastOpenedTab || 'shortcuts';

        // Admin default → per-user default (handled by getPluginDefault above; preserved for backwards compatibility)
        if (!Object.prototype.hasOwnProperty.call(userSettings, 'removeContinueWatchingEnabled')
            && pluginDefaults.RemoveContinueWatchingEnabled === true) {
            mergedSettings.removeContinueWatchingEnabled = true;
        }

        return mergedSettings;
    };

    /** Derive resolved settings from the store, retaining pending choices across replacement views. */
    JE.loadSettings = () => {
        const state = settingsDocument('settings.json');
        JE.userConfig = JE.userConfig || {};
        JE.userConfig.settings = copyDocument(state.shown);
        return resolveSettings(state.shown);
    };

    /** Shortcut combo for a keydown, e.g. "Ctrl+Shift+A". Shift is dropped for shifted symbols ("+", not "Shift++"). */
    JE.keyCombo = function(e) {
        const key = e.key;
        const isLetter = /^[a-zA-Z]$/.test(key);
        const isShiftedSymbol = key.length === 1 && key !== ' ' && !isLetter;
        return (e.metaKey ? 'Meta+' : '') +
               (e.ctrlKey ? 'Ctrl+' : '') +
               (e.altKey ? 'Alt+' : '') +
               (e.shiftKey && !isShiftedSymbol ? 'Shift+' : '') +
               (isLetter ? key.toUpperCase() : key);
    };

    /** Converts bindings saved before the fix ("Shift++") to the current format. */
    JE.normalizeShortcutKey = function(key) {
        if (typeof key !== 'string') return key;
        return key.replace(/Shift\+([^A-Za-z0-9\s,./;'\[\]\\=`-])$/, '$1');
    };

    /**
     * Initializes keyboard shortcut mappings from plugin and user configurations.
     */
    JE.initializeShortcuts = function() {
        const pluginDefaults = JE.pluginConfig || {};
        const userShortcutsConfig = JE.userConfig?.shortcuts || {};

        const defaultShortcuts = Array.isArray(pluginDefaults.Shortcuts)
            ? pluginDefaults.Shortcuts.reduce((acc, s) => {
                if (s && s.Name && s.Key !== undefined) acc[s.Name] = s.Key;
                return acc;
              }, {})
            : {};

        const userShortcuts = Array.isArray(userShortcutsConfig.Shortcuts)
            ? userShortcutsConfig.Shortcuts.reduce((acc, s) => {
                if (s && s.Name && s.Key !== undefined) acc[s.Name] = s.Key;
                return acc;
              }, {})
            : {};

        JE.state.activeShortcuts = JE.state.activeShortcuts || {};
        Object.assign(JE.state.activeShortcuts, defaultShortcuts, userShortcuts);
        Object.keys(JE.state.activeShortcuts).forEach(function(name) {
            JE.state.activeShortcuts[name] = JE.normalizeShortcutKey(JE.state.activeShortcuts[name]);
        });
    };

})(window.JellyfinEnhanced);
