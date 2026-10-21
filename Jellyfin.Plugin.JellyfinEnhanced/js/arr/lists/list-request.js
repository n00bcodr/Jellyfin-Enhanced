/**
 * @file Requests & downloads, phase 4c3a: Request on one list entry. The list's own request route, never a generic
 * ask: the entry's exact scope and edition, the list as the origin, and the household's usual rules (allowance,
 * approval, 4K permission, Seerr or JE handling). Request rights are separate from edit rights: a person who may only
 * look at a list can ask (when their role may), an editor whose role may not ask can't.
 *
 * Flow: the list's preview for this one entry (nothing is written) → if it can be asked for, the shared request sheet
 * in its fixed mode (no scope cards, the preview's cost and what it would do) → one confirmation id per opened sheet,
 * reused only when the same confirmation is sent again after a lost answer → the shared wording for the result.
 * Answers go through the one acceptance rule: the preview only opens the sheet while the page it was asked from is
 * still the one shown (session, page show, route, list); the confirmation's outcome only while the session is the same.
 * What it draws (the button's busy state, toasts, the sheet) goes through the paint gate with the page's ticket; the
 * button is enabled again through erase (it only gives back what JE took).
 * A press owns what it holds (its in-flight entry and the button it disabled) for its page show only: when that ticket
 * ends (the page is left, or the whole document is: a pagehide) the press gives both back at once, so Back on the page
 * jellyfin-web kept, or the browser restoring the document, can press again while the old preview is still on its way;
 * a later press starts its own, and the old one's cleanup only ever removes what is still its own.
 */
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const lp = JE.internals.arrListPages = JE.internals.arrListPages || {};

    /**
     * "listId|placeholderId" → the press preparing that ask ({rule}: its page's ticket). A second tap on the same page
     * show does nothing; a press whose page show is over holds nothing.
     * @type {Map<string, {rule: Object}>}
     */
    const busy = new Map();
    /** @type {WeakMap<HTMLElement, Object>} Request button → the press that disabled it (only that press enables it). */
    let holders = new WeakMap();

    /**
     * The words for a preview that can't be asked for here.
     * @param {string|null|undefined} reason Preview reason.
     * @returns {string} Text.
     */
    function skipText(reason) {
        const tr = lp.render.tr;
        switch (reason) {
            case 'custom': return tr('arr_lists_skip_custom');
            case 'not_released': return tr('arr_lists_skip_not_released');
            case 'in_library': return tr('arr_lists_skip_in_library');
            case 'scope_unknown': return tr('arr_lists_skip_unknown_scope');
            // A request refusal (e.g. a decline cool-down, storage full): the shared words for it.
            default: return JE.arrAsk?.describe ? JE.arrAsk.describe(JE.arrAsk.interpret(403, { outcome: 'blocked', reason: reason || '' })).text : tr('arr_ask_toast_blocked');
        }
    }

    /**
     * What the sheet says the ask would do (from the preview), or null for a plain new request.
     * @param {Object} item Preview item.
     * @returns {string|null} Text.
     */
    function previewNote(item) {
        const tr = lp.render.tr;
        if (item.outcome === 'follow') return tr('arr_lists_preview_follow');
        if (item.outcome === 'approval') return tr('arr_lists_preview_approval');
        if (Number.isInteger(item.cost) && item.cost > 0) return lp.render.tn('arr_lists_preview_cost', { count: item.cost });
        return null;
    }

    /**
     * The HTTP status a per-entry outcome of a confirmation stands for (the shared outcome carries its outcome,
     * reason and certainty, not the status), so it reads exactly like any other ask.
     * @param {Object|null} result The entry's outcome.
     * @returns {number} Status.
     */
    function statusOf(result) {
        if (!result || typeof result !== 'object') return 0;
        if (result.certainty === 'Unknown' || result.outcome === 'maybe_sent') return 202;
        if (result.outcome === 'quota_exceeded') return 429;
        if (result.certainty === 'Failed') return 503;
        if (result.outcome === 'denied' || result.outcome === 'blocked' || result.outcome === 'refused') {
            return result.reason === 'not_found' ? 404 : 403;
        }
        if (result.outcome === 'conflict') return 409;
        return 201;
    }

    /**
     * Sends the confirmation for one entry and reads its outcome as a JE.arrAsk result.
     * @param {string} listId List id.
     * @param {string} placeholderId Entry id.
     * @param {string} clientId The confirmation id (kept for a retry of this same confirmation).
     * @returns {Promise<Object>} Result.
     */
    async function send(listId, placeholderId, clientId) {
        const interpret = JE.arrAsk.interpret;
        const rule = JE.arrLists.ticket(listId);
        let answer;
        try {
            answer = await JE.arrLists.requestEntries(listId, { clientId, placeholderIds: [placeholderId] });
            if (!rule.current()) return { ok: false, stale: true, state: 'failed', status: 0 };
        } catch (err) {
            if (err?.stale) return { ok: false, stale: true, state: 'failed', status: 0 };
            throw err;
        }
        if (answer.status === 200) {
            const entry = (answer.body?.results || []).find(r => r?.placeholderId === placeholderId);
            const result = entry?.result || null;
            if (!result) return interpret(409, { reason: 'changed' });
            return interpret(statusOf(result), result);
        }
        return interpret(answer.status, { reason: answer.body?.code || '' });
    }

    /**
     * Request on an entry: preview, then the shared sheet in its fixed mode.
     * @param {{listId: string, ticket: function(): Object, onDone?: function(): void}} list The list (its page's
     *   ticket, taken when Request is pressed).
     * @param {Object} ph The entry (as drawn).
     * @param {HTMLElement|null} opener The button (focus returns to it).
     * @returns {Promise<Object|null>} The result, or null when nothing was sent.
     */
    async function open(list, ph, opener) {
        const tr = lp.render.tr;
        const key = `${list.listId}|${ph.id}`;
        if (!JE.arrLists || !JE.arrAskSheet?.open || !JE.arrAsk?.interpret) return null;
        // The page's ticket (session, page show, route, list) for the preview and what it draws; the session's for
        // the outcome.
        const rule = typeof list.ticket === 'function' ? list.ticket() : null;
        if (busy.get(key)?.rule.current()) return null;
        const session = JE.arrLists.ticket(list.listId);
        if (!lp.gate.paint(rule, () => { if (opener) opener.disabled = true; }, 'request')) return null;
        const mine = { rule };
        busy.set(key, mine);
        if (opener) holders.set(opener, mine);
        /** Enables the button again while this press still holds it. */
        const giveBack = () => {
            if (!opener || holders.get(opener) !== mine) return;
            holders.delete(opener);
            lp.gate.erase(() => { opener.disabled = false; });
        };
        /** Gives back everything this press still holds (its in-flight entry and its button), nothing else. */
        const release = () => {
            if (busy.get(key) === mine) busy.delete(key);
            giveBack();
        };
        // Leaving the page ends this press's hold at once, while its preview may still be on its way.
        const off = typeof rule.onRevoke === 'function' ? rule.onRevoke(release) : null;
        /** @param {string} text Toast words (drawn only for the page's current ticket). */
        const toast = text => lp.gate.paint(rule, () => JE.arrAsk.toast?.(text), 'toast');
        try {
            let preview;
            try {
                preview = await JE.arrLists.previewRequests(list.listId, { placeholderIds: [ph.id] });
                if (!rule.current()) return null;
            } catch (err) {
                if (err?.stale) return null;
                toast(tr('arr_ask_toast_failed'));
                return null;
            }
            if (preview.status !== 200) {
                toast(JE.arrAsk.describe(JE.arrAsk.interpret(preview.status, { reason: preview.body?.code || '' })).text);
                if (preview.status === 404 || preview.status === 409) list.onDone?.();
                return null;
            }
            const item = (preview.body?.items || []).find(i => i?.placeholderId === ph.id);
            if (!item) {
                toast(tr('arr_ask_toast_changed'));
                list.onDone?.();
                return null;
            }
            if (item.outcome === 'already') {
                toast(tr('arr_lists_already'));
                return null;
            }
            if (item.outcome === 'skip') {
                toast(skipText(item.reason));
                return null;
            }
            const clientId = JE.arrLists.newRequestId();
            const fourK = ph.edition === '4k';
            const title = {
                key: ph.titleKey,
                kind: ph.mediaType === 'movie' ? 'movie' : 'series',
                name: ph.title || '',
                year: Number.isInteger(ph.year) ? ph.year : undefined,
                poster: typeof ph.posterPath === 'string' ? ph.posterPath : undefined
            };
            giveBack();
            let sheet = null;
            lp.gate.paint(rule, () => {
                sheet = JE.arrAskSheet.open(title, {
                    opener,
                    // A list page is a native entry point (D46S2-R6: the sheet takes its owner explicitly); the list
                    // ticket ends the sheet when the page moves on.
                    operation: JE.NATIVE,
                    listTicket: rule,
                    variant: fourK ? '4k' : 'standard',
                    fixed: {
                        scope: lp.render.kindLabel(ph) + (fourK ? ' · 4K' : ''),
                        input: { scope: 'list', placeholderId: ph.id },
                        cost: Number.isInteger(item.cost) ? item.cost : 0,
                        note: previewNote(item),
                        send: () => send(list.listId, ph.id, clientId)
                    }
                });
            }, 'sheet');
            if (!sheet) return null;
            const result = await sheet;
            if (!session.current()) return null;
            if (result) list.onDone?.();
            return result;
        } finally {
            off?.();
            release();
        }
    }

    JE.session?.onUserChange?.('arr-list-request', () => {
        busy.clear();
        holders = new WeakMap();
        JE.arrAskSheet?.close?.();
    });

    lp.request = { open, send, statusOf, skipText, previewNote };
})(window.JellyfinEnhanced);
