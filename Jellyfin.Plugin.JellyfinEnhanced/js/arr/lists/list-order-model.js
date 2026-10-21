/**
 * @file Requests & downloads, phase 4c3b: the playlist order model of list authoring. Pure: no network, DOM, listener
 * or timer, here or on load.
 *
 * A list view's `order` is the caller's projection: `e:<itemId>:<k>` (the k-th copy of a library item) and `p:<entryId>`
 * (a JE entry). Slots the caller can't see are kept by the server and never appear in it. One move is ONE logical
 * reorder ({@link plan}): the projection with one token taken out and put back elsewhere, naming the library row that
 * moved (`moved`) only when the library rows change order. The server alone moves Jellyfin's rows: none for an
 * entry-only move, one or two for a library row (so hidden rows keep their slots). A later copy of a duplicated item
 * can't be moved (Jellyfin always moves the first copy); its first copy and every other row can.
 *
 * - {@link settle} reads the answer: applied (the server's projection is the one asked for), canonical (show the
 *   server's view as it is), a typed conflict with its fresh view, denied, refused or uncertain. It never resends:
 *   a definite conflict waits for the person's next press on the fresh view.
 * - {@link capture} takes a drag's owner, list revision and live check at gesture start; {@link drop} plans it only
 *   while all three still hold, once. An ended drag writes nothing.
 * - {@link dropOwner}: a drop on a list showing JE entries is JE's (the host's own Move is suppressed, so there is one
 *   writer); a drop among Jellyfin rows only stays the host's.
 *
 * Internal: lp.order { parse, plan, sameProjection, settle, capture, drop, cancel, dropOwner }.
 */
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const lp = JE.internals.arrListPages = JE.internals.arrListPages || {};

    const REAL_RE = /^e:([0-9a-f]{32}):(\d{1,6})$/;
    const ENTRY_RE = /^p:([0-9a-f]{32})$/;
    /** Definite answers of PUT /order that carry the list as it is now. */
    const CONFLICTS = new Set(['rev_conflict', 'not_permutation', 'moved_invalid', 'real_order_changed', 'duplicate_copy', 'move_unsupported', 'move_failed', 'owner_missing']);

    /**
     * A token of the projected order, or null.
     * @param {*} token Token.
     * @returns {{kind: 'real', id: string, k: number}|{kind: 'entry', id: string}|null} Parsed token.
     */
    function parse(token) {
        if (typeof token !== 'string') return null;
        let m = REAL_RE.exec(token);
        if (m) return { kind: 'real', id: m[1], k: Number(m[2]) };
        m = ENTRY_RE.exec(token);
        return m ? { kind: 'entry', id: m[1] } : null;
    }

    /** @param {string} token Token. @returns {boolean} A library row's token. */
    const isReal = token => parse(token)?.kind === 'real';

    /**
     * The order's shape for comparing answers: library rows by item (the server renumbers copies after a move).
     * @param {string[]} order Order.
     * @returns {string} Shape.
     */
    function shape(order) {
        return order.map(t => { const p = parse(t); return p?.kind === 'real' ? 'e:' + p.id : t; }).join(',');
    }

    /** @param {string[]} order Order. @returns {string} The library rows' order by item. */
    const realShape = order => shape(order.filter(isReal));

    /**
     * Whether the server lets this person reorder this list (its actions; a saved canEdit is not the action).
     * @param {Object} view View.
     * @returns {boolean} May reorder.
     */
    function mayReorder(view) {
        return view.listKind !== 'collection' && view.canEdit === true && Array.isArray(view.actions) && view.actions.includes('reorder');
    }

    /** @param {string} reason Why. @returns {{ok: false, reason: string}} Refusal. */
    const refuse = reason => ({ ok: false, reason });

    /**
     * Whether the rows shown are the view's projection (a refresh of Jellyfin's rows without a list revision makes
     * them differ; nothing may be sent until the view is read again).
     * @param {Object} view View.
     * @param {string[]} shown Tokens of the rows shown, in order.
     * @returns {boolean} Same.
     */
    function sameProjection(view, shown) {
        return Array.isArray(view?.order) && Array.isArray(shown) && view.order.length === shown.length && view.order.every((t, i) => t === shown[i]);
    }

    /**
     * One logical reorder: a token moved to `to`, or one slot (`delta` ±1). The body has no request id: the person's
     * confirmation adds it (lp.authoring).
     * @param {Object} view The view shown ({listId, listKind, rev, canEdit, actions, order}).
     * @param {{token: string, to?: number, delta?: number, shown?: string[]}} command The move (and the rows shown).
     * @returns {{ok: true, listId: string, token: string, from: number, to: number, before: string[],
     *   native: 'none'|'server', body: {rev: number, order: string[], moved: (string|null)}}|{ok: false, reason: string}} Plan.
     */
    function plan(view, command) {
        if (!view || !Array.isArray(view.order) || !Number.isInteger(view.rev)) return refuse('invalid');
        const order = view.order;
        if (!order.every(t => parse(t)) || new Set(order).size !== order.length) return refuse('invalid');
        if (!mayReorder(view)) return refuse('not_editable');
        if (command?.shown !== undefined && !sameProjection(view, command.shown)) return refuse('stale_view');
        const token = command?.token;
        const from = order.indexOf(token);
        if (from < 0) return refuse('unknown_token');
        const to = Number.isInteger(command.to) ? command.to : Number.isInteger(command.delta) ? from + command.delta : NaN;
        if (!Number.isInteger(to) || to < 0 || to >= order.length) return refuse('out_of_range');
        if (to === from) return refuse('noop');
        const parsed = parse(token);
        if (parsed.kind === 'real' && parsed.k > 0) return refuse('duplicate_copy');
        const next = order.slice();
        next.splice(from, 1);
        next.splice(to, 0, token);
        // The server compares the library rows' copy tokens: any change of their order names the moved row (moving a
        // first copy past its own later copy too, which Jellyfin itself needs no move for).
        const realMoved = order.filter(isReal).join(',') !== next.filter(isReal).join(',');
        return {
            ok: true,
            listId: view.listId,
            token,
            from,
            to,
            before: order.slice(),
            native: realMoved ? 'server' : 'none',
            body: { rev: view.rev, order: next, moved: realMoved ? token : null }
        };
    }

    /**
     * Reads the answer of a planned reorder. Never asks for a resend: `resubmits` is always 0.
     * @param {Object} planned A plan from {@link plan}.
     * @param {{status: number, body: Object|null}|null} answer The answer (null: none arrived).
     * @returns {{outcome: 'applied'|'canonical'|'conflict'|'denied'|'refused'|'uncertain', reason?: string,
     *   view: Object|null, reload: boolean, resubmits: 0}} Outcome.
     */
    function settle(planned, answer) {
        const status = Number(answer?.status) || 0;
        const body = answer?.body || null;
        const done = (outcome, reason, view, reload) => ({ outcome, reason, view: view || null, reload, resubmits: 0 });
        if (status >= 200 && status < 300) {
            const view = body && Array.isArray(body.order) ? body : null;
            if (!view) return done('canonical', 'no_view', null, true);
            if (shape(view.order) === shape(planned.body.order)) return done('applied', undefined, view, false);
            // An entry-only move answered with Jellyfin's rows in another order: shown as the server has it.
            if (planned.native === 'none' && realShape(view.order) !== realShape(planned.before)) return done('canonical', 'native_moved', view, false);
            return done('canonical', 'other_order', view, false);
        }
        if (status === 409) {
            const code = typeof body?.code === 'string' ? body.code : 'conflict';
            const view = body?.view && Array.isArray(body.view.order) ? body.view : null;
            return done('conflict', CONFLICTS.has(code) ? code : 'conflict', view, !view);
        }
        if (status === 401 || status === 403 || status === 404) return done('denied', String(status), null, true);
        if (status >= 400 && status < 500) return done('refused', typeof body?.code === 'string' ? body.code : String(status), null, true);
        return done('uncertain', status ? String(status) : 'no_answer', null, true);
    }

    /**
     * An owner as the operation contract has it (anything with current()). No owner is a programming error: it throws
     * where JE.strictOwners is set (tests) and is logged in production, where nothing proceeds.
     * @param {*} owner Owner.
     * @param {string} site Caller.
     * @returns {Object|null} Owner.
     */
    function requireOwner(owner, site) {
        if (owner && typeof owner === 'object' && typeof owner.current === 'function') return owner;
        const message = `Jellyfin Enhanced: ${site} was called without an owner`;
        if (JE.strictOwners === true) throw new Error(message);
        console.error(message);
        return null;
    }

    /**
     * A drag, taken at gesture start: its owner, the list and revision it began on, the token and the live check
     * (flags, access, mount) asked again at drop.
     * @param {{owner: Object, view: Object, token: string, live: function(): boolean}} start Gesture start.
     * @returns {Object|null} Drag (null: no owner).
     */
    function capture(start) {
        const owner = requireOwner(start?.owner, 'list drag');
        if (!owner) return null;
        return { owner, listId: start.view?.listId, rev: start.view?.rev, token: start.token, live: typeof start.live === 'function' ? start.live : () => false, ended: false };
    }

    /**
     * The drop of a captured drag: planned only while its owner is current, the live check holds and the view is
     * the revision it began on. Used once; an ended drag stays ended.
     * @param {Object} drag From {@link capture}.
     * @param {{to: number, view: Object, shown?: string[]}} drop The drop.
     * @returns {Object} A plan, or a refusal.
     */
    function drop(drag, { to, view, shown } = {}) {
        if (!drag || drag.ended) return refuse('ended');
        drag.ended = true;
        if (drag.owner.current() === false || drag.live() !== true) return refuse('ended');
        if (!view || view.rev !== drag.rev || view.listId !== drag.listId) return refuse('stale_view');
        return plan(view, { token: drag.token, to, shown });
    }

    /** @param {Object} drag A drag: it ends without a write. */
    function cancel(drag) {
        if (drag) drag.ended = true;
    }

    /**
     * Who owns a drop on a playlist page.
     * @param {{entriesShown: boolean, draggedEntry: boolean}} info Whether JE entries are drawn, whether one is dragged.
     * @returns {{owner: 'je'|'host', suppressHost: boolean}} Owner.
     */
    function dropOwner({ entriesShown, draggedEntry }) {
        return entriesShown === true || draggedEntry === true ? { owner: 'je', suppressHost: true } : { owner: 'host', suppressHost: false };
    }

    lp.order = Object.freeze({ parse, plan, sameProjection, settle, capture, drop, cancel, dropOwner, requireOwner });
})(window.JellyfinEnhanced);
