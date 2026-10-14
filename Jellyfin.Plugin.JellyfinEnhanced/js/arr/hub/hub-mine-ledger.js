/**
 * @file Requests & downloads, phase 3: the request ledger in My requests. Reads the caller's own
 * requests (GET /JellyfinEnhanced/acquire/requests/mine) under an intent token and merges them with
 * the page's existing entries, one row per title (a title the page already lists keeps its row and
 * status; the ledger adds what is missing): waiting for an OK, on the way, said no. Rows of requests
 * not sent yet get **Cancel** (JE.arrAsk.cancel), with the honest outcome in a toast. Cancelled and
 * finished ones are left to the existing groups. Re-reads when the caller's request list changes
 * on the feed, or after an ask or cancel on this page.
 */
(function (JE) {
    'use strict';

    const H = (JE.internals = JE.internals || {}).arrHub = JE.internals.arrHub || {};
    const X = H.ext;
    const ROUTE = '/acquire/requests/mine';
    const ORDER = { needsOk: 0, onTheWay: 1, declined: 2 };
    const logPrefix = '🪼 Jellyfin Enhanced: My requests:';

    const tokens = X.intent('mine');
    const state = {
        items: null,
        epoch: null,
        loading: null,
        stale: true,
        unfollow: null,
        busy: new Set(),
        listening: false,
        scheduled: false,
        visit: null
    };

    /**
     * Forgets everything read for another user.
     * @returns {void}
     */
    function resetForUser() {
        if (state.epoch === X.epoch()) return;
        state.epoch = X.epoch();
        state.items = null;
        state.stale = true;
        state.busy.clear();
        tokens.drop();
        if (state.unfollow) state.unfollow();
        state.unfollow = null;
    }

    /**
     * True when the ledger rows apply (phase 3 request controls on).
     * @returns {boolean} On.
     */
    function on() {
        return JE.arrAsk?.enabled?.() === true;
    }

    /**
     * Reads the caller's ledger requests under a fresh intent token; the page redraws when the
     * answer is still current.
     * @returns {Promise<void>}
     */
    async function load() {
        resetForUser();
        state.stale = false;
        state.visit = H.state?.generation ?? null;
        const token = tokens.next();
        const run = (async () => {
            const answer = await X.call(ROUTE);
            if (!tokens.isCurrent(token)) return;
            if (state.loading === run) state.loading = null;
            if (answer.status === 200 && Array.isArray(answer.body?.items)) {
                state.items = answer.body.items;
            } else {
                // What was shown stays; the next change on the feed (or the next visit) reads again.
                console.warn(`${logPrefix} could not load (${answer.status || 'no answer'})`);
            }
            if (H.state?.visible) H.render?.();
        })();
        state.loading = run;
        return run;
    }

    /**
     * Starts following the caller's request list while the page shows (stops on its own when the
     * page is no longer shown).
     * @returns {void}
     */
    function follow() {
        if (state.unfollow) return;
        const keys = [X.userKey(), 'req:state'].filter(Boolean);
        state.unfollow = X.follow(keys, () => {
            if (!H.state?.visible) {
                state.stale = true;
                if (state.unfollow) state.unfollow();
                state.unfollow = null;
                return;
            }
            load();
        });
        if (!state.listening && JE.arrAsk?.onChange) {
            state.listening = true;
            JE.arrAsk.onChange(() => {
                state.stale = true;
                if (H.state?.visible) load();
            });
        }
    }

    /**
     * The status pill a ledger request shows (the family words of its state).
     * @param {Object} item Ledger request.
     * @returns {Object} Status.
     */
    function statusOf(item) {
        if (item.group === 'needsOk') return { key: item.key, kind: item.kind, stage: 'asked', reason: { code: 'awaiting_approval' }, quiet: false, actions: [] };
        if (item.group === 'declined') return { key: item.key, kind: item.kind, stage: 'notHere', reason: { code: 'declined' }, quiet: false, actions: [] };
        return { key: item.key, kind: item.kind, stage: 'approved', reason: { code: 'approved' }, quiet: false, actions: [] };
    }

    /**
     * My requests with the ledger's requests added: one entry per title key. An entry the page
     * already has keeps its row (and gains Cancel for the ledger's unsent requests); a title only the
     * ledger knows gets a row of its own. Starts a read when there is nothing current.
     * @param {Object} view The page's visible data.
     * @returns {Object} The view with the merged My requests.
     */
    function merge(view) {
        if (!on()) return view;
        resetForUser();
        if (H.state?.visible) follow();
        // Read once per visit to the page, and again after a change.
        if (state.visit !== (H.state?.generation ?? null)) state.stale = true;
        if (state.stale && !state.scheduled && !(state.loading && tokens.isCurrent(tokens.current()))) {
            // One read for the burst of renders that asked (the tab strip and the panel both merge).
            state.scheduled = true;
            Promise.resolve().then(() => {
                state.scheduled = false;
                load();
            });
        }
        if (!Array.isArray(state.items) || !state.items.length) return view;
        const byKey = new Map();
        for (const item of state.items) {
            if (!(item.group in ORDER)) continue;
            if (!byKey.has(item.key)) byKey.set(item.key, []);
            byKey.get(item.key).push(item);
        }
        const mine = [];
        const seen = new Set();
        for (const entry of view.mine || []) {
            const own = byKey.get(entry.key);
            seen.add(entry.key);
            mine.push(own ? { ...entry, ledger: ledgerOf(own) } : entry);
        }
        for (const [key, own] of byKey) {
            if (seen.has(key)) continue;
            // The most open state of the title's requests leads (waiting before on the way before said no).
            const lead = [...own].sort((a, b) => ORDER[a.group] - ORDER[b.group])[0];
            const seasons = [...new Set(own.flatMap(i => i.seasons || []))].sort((a, b) => a - b);
            mine.push({
                key,
                kind: lead.kind,
                title: lead.title || '',
                year: lead.year,
                poster: lead.poster,
                itemId: lead.itemId,
                is4k: own.every(i => i.variant === '4k'),
                seasons: lead.kind === 'tv' && seasons.length ? seasons : null,
                askedAt: own.map(i => i.createdAt).sort()[0],
                group: lead.group,
                status: statusOf(lead),
                ledger: ledgerOf(own)
            });
        }
        mine.sort((a, b) => (ORDER[a.group] ?? 3) - (ORDER[b.group] ?? 3) || String(b.askedAt || '').localeCompare(String(a.askedAt || '')));
        return { ...view, mine };
    }

    /**
     * The ledger part of a row: the ids that can still be cancelled.
     * @param {Object[]} own The title's ledger requests.
     * @returns {{cancel: string[]}} Ledger part.
     */
    function ledgerOf(own) {
        return { cancel: own.filter(i => i.canCancel && typeof i.id === 'string').map(i => i.id) };
    }

    /**
     * Adds Cancel to a My requests row whose ledger requests haven't been sent yet.
     * @param {Object} entry Row entry.
     * @param {HTMLElement} buttons The row's button box.
     * @returns {void}
     */
    function rowExtras(entry, buttons) {
        const ids = entry?.ledger?.cancel;
        if (!Array.isArray(ids) || !ids.length || !on()) return;
        const busy = ids.some(id => state.busy.has(id));
        const cancel = X.button('je-hub-btn je-hub-cancel', X.tr(busy ? 'arr_mine_cancelling' : 'arr_mine_cancel'), 'cancel', `cancel:${entry.key || ''}`);
        cancel.setAttribute('aria-label', X.tr('arr_mine_cancel_label', { title: X.titleText(entry) }));
        X.busy(cancel, busy);
        cancel.addEventListener('click', (e) => {
            e.stopPropagation();
            cancelAll(ids);
        });
        cancel.addEventListener('keydown', e => e.stopPropagation());
        buttons.appendChild(cancel);
    }

    /**
     * Cancels the caller's unsent requests of one title and says how it went.
     * @param {string[]} ids Request ids.
     * @returns {Promise<void>}
     */
    async function cancelAll(ids) {
        if (ids.some(id => state.busy.has(id))) return;
        ids.forEach(id => state.busy.add(id));
        if (H.state?.visible) H.render?.();
        const asked = X.epoch();
        let last = null;
        for (const id of ids) {
            last = await JE.arrAsk.cancel(id);
            if (!last.ok) break;
        }
        ids.forEach(id => state.busy.delete(id));
        if (asked !== X.epoch()) return;
        if (last) JE.arrAsk.toast(JE.arrAsk.describe(last, await JE.arrAsk.me()).text);
        state.stale = true;
        if (H.state?.visible) {
            load();
            H.load?.();
        }
    }

    JE.session?.onUserChange?.('arr-mine-ledger', () => resetForUser());

    H.mineLedger = { merge, load, state };
    H.rowExtras = rowExtras;
})(window.JellyfinEnhanced);
