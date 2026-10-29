/**
 * @file Requests & downloads, phase 3: the Approvals tab of the Requests page (#/requests?tab=
 * approvals), for Managers and Admins. Phone-first cards from GET /JellyfinEnhanced/acquire/
 * requests/approvals: poster, title, who asked · how long ago · what (Movie, Season 2, S2E8), their
 * role and request use, a limited requester's rating line ("G · within Leo's limit"), who else wants
 * it, an over-quota chip and the size estimate. Approve / Decline (with a reason chip or a short
 * note), Change and approve (narrow seasons or episodes, switch Standard/4K when the approver may),
 * and bulk approve (up to 20, each one checked again; a 207 answer puts each card's own outcome on
 * it and the ones that failed stay). Swipe right to approve, left for the decline reasons, with the
 * buttons always there. Every outcome is said honestly. ?show=stuck lists only the stuck ones.
 * Phase 4b: the household rules' verdict in plain words, the rule and shared-allowance reasons, and
 * the requester's shared allowance (arr/household/household-rules.js words them).
 */
(function (JE) {
    'use strict';

    const H = (JE.internals = JE.internals || {}).arrHub = JE.internals.arrHub || {};
    const X = H.ext;
    const TAB = 'approvals';
    const ROUTE = '/acquire/requests/approvals';
    const MAX_BULK = 20;
    const NOTE_MAX = 200;
    const SWIPE_PX = 90;
    const REASONS = ['arr_approvals_reason_kids', 'arr_approvals_reason_similar', 'arr_approvals_reason_big', 'arr_approvals_reason_together'];
    const logPrefix = '🪼 Jellyfin Enhanced: Approvals:';

    const tokens = X.intent(TAB);
    const counts = X.intent('approvals-count');
    const state = {
        items: null,
        more: false,
        error: false,
        epoch: null,
        panel: null,
        shown: false,
        loading: null,
        unfollow: null,
        attention: null,
        attentionAsked: null,
        busy: new Set(),
        results: new Map(),
        reasons: new Set(),
        edits: new Map(),
        notes: new Map(),
        selecting: false,
        selected: new Set(),
        banner: null
    };

    /**
     * The filter named in the URL: 'stuck' (?show=stuck) or 'all'.
     * @returns {string} Filter.
     */
    function filter() {
        const hash = window.location.hash || '';
        const q = hash.indexOf('?');
        try {
            return q >= 0 && new URLSearchParams(hash.slice(q + 1)).get('show') === 'stuck' ? 'stuck' : 'all';
        } catch {
            return 'all';
        }
    }

    /**
     * Forgets everything read for another user.
     * @returns {void}
     */
    function resetForUser() {
        if (state.epoch === X.epoch()) return;
        state.epoch = X.epoch();
        state.items = null;
        state.more = false;
        state.error = false;
        state.attention = null;
        state.attentionAsked = null;
        state.busy.clear();
        state.results.clear();
        state.reasons.clear();
        state.edits.clear();
        state.notes.clear();
        state.selected.clear();
        state.selecting = false;
        state.banner = null;
        tokens.drop();
        counts.drop();
    }

    /**
     * Reads the cards under a fresh intent token; an answer is shown only if its token is still
     * the current one (a newer read, another filter or another user drops it).
     * @returns {Promise<void>}
     */
    async function load() {
        resetForUser();
        const token = tokens.next({ filter: filter() });
        const run = (async () => {
            const answer = await X.call(ROUTE);
            if (!tokens.isCurrent(token)) return;
            if (answer.status === 200 && Array.isArray(answer.body?.items)) {
                state.items = answer.body.items;
                state.more = answer.body.more === true;
                state.error = false;
                // Results of ids that are no longer listed are done with (the banner said how it went).
                const listed = new Set(state.items.map(i => i.id));
                for (const id of [...state.results.keys()]) if (!listed.has(id)) state.results.delete(id);
                for (const id of [...state.selected]) if (!listed.has(id)) state.selected.delete(id);
            } else {
                state.error = true;
                console.warn(`${logPrefix} could not load (${answer.status || 'no answer'})`);
            }
            if (state.loading === run) state.loading = null;
            draw();
            H.renderTabs?.();
        })();
        state.loading = run;
        return run;
    }

    /**
     * Reads the "need your OK" count for the tab label (once per user until the list is read).
     * @returns {void}
     */
    function loadCount() {
        resetForUser();
        if (state.attentionAsked === X.epoch()) return;
        state.attentionAsked = X.epoch();
        const token = counts.next();
        X.call('/acquire/requests/attention').then((answer) => {
            if (!counts.isCurrent(token) || answer.status !== 200) return;
            state.attention = { needOk: answer.body?.needOk | 0, stuck: answer.body?.stuck | 0 };
            H.renderTabs?.();
        });
    }

    /**
     * The tab label's count: cards waiting for this approver's OK (stuck ones not counted).
     * @returns {number|null} Count.
     */
    function count() {
        if (approverNow() !== true) return null;
        resetForUser();
        if (state.items) return state.items.filter(i => i.canApprove && !i.stuck).length;
        if (!state.shown) loadCount();
        return state.attention ? state.attention.needOk : null;
    }

    /**
     * Whether the tab is offered (Managers and Admins; 'pending' while that is being read).
     * @returns {boolean|string} Visibility.
     */
    function approverNow() {
        return X.approver();
    }

    /**
     * Shows the tab in the page's panel (called on every page render).
     * @param {HTMLElement} panel Panel.
     * @returns {void}
     */
    function render(panel) {
        resetForUser();
        H.injectExtraStyles?.();
        const first = !state.shown;
        state.panel = panel;
        state.shown = true;
        if (!state.unfollow) {
            const keys = ['req:state', X.userKey()].filter(Boolean);
            state.unfollow = X.follow(keys, () => {
                if (state.shown) load();
            });
        }
        draw();
        // Read on arrival, and again when the filter changed (a read under way for the same filter is shared).
        const current = tokens.current();
        const inFlight = state.loading && tokens.isCurrent(current) && current.filter === filter();
        if ((first || !state.items || current?.filter !== filter()) && !inFlight) load();
    }

    /**
     * The tab is no longer shown: stop following and forget the panel (what was read stays).
     * @returns {void}
     */
    function leave() {
        if (!state.shown) return;
        state.shown = false;
        state.panel = null;
        tokens.drop();
        state.loading = null;
        if (state.unfollow) state.unfollow();
        state.unfollow = null;
    }

    /**
     * The words for an approve/decline/bulk answer, honest about every outcome.
     * @param {string} action approve or decline.
     * @param {number} status HTTP status (0: no answer).
     * @param {Object|null} body Outcome body.
     * @returns {{text: string, tone: string, ok: boolean}} Result.
     */
    function describe(action, status, body) {
        const certainty = typeof body?.certainty === 'string' ? body.certainty : '';
        let key;
        let tone = 'attention';
        const ok = status >= 200 && status < 300;
        if (ok && certainty === 'Unknown') key = 'arr_approvals_result_unknown';
        else if (ok) {
            key = action === 'decline' ? 'arr_approvals_result_declined' : 'arr_approvals_result_approved';
            tone = 'done';
        } else if (status === 409 || status === 404) key = 'arr_approvals_result_changed';
        else if (status === 429) key = 'arr_approvals_result_quota';
        else if (status === 400) key = 'arr_approvals_result_invalid';
        else if (status === 403) key = 'arr_approvals_result_denied';
        else key = 'arr_approvals_result_failed';
        // Plain words on the card; the server's reason code goes to an administrator's Details only.
        const code = !ok && typeof body?.reason === 'string' && body.reason ? body.reason : null;
        return { text: X.tr(key), tone, ok, code };
    }

    /** Plain words for the reasons a request is held after its OK (Appendix A2), by reason code. */
    const STUCK_WORDS = {
        authorization_changed: 'arr_approvals_stuck_access',
        identity_changed: 'arr_approvals_stuck_identity',
        configuration_changed: 'arr_approvals_stuck_settings',
        instance_changed: 'arr_approvals_stuck_connection',
        seerr_whole_series_only: 'arr_approvals_stuck_whole_series',
        seerr_user_unlinked: 'arr_approvals_stuck_seerr_account',
        no_4k_instance: 'arr_approvals_stuck_no_4k',
        // F83: an episode asked by TMDB's numbering that has no Sonarr episode with its TVDB id (never matched by name).
        episode_identity_unresolved: 'arr_approvals_stuck_episode_identity',
        // Phase 4b: held by the household's rules or a group pool after it was queued, and administrator Seerr options.
        household_rule: 'arr_rules_stuck_household_rule',
        rule_review: 'arr_rules_stuck_rule_review',
        group_quota: 'arr_rules_stuck_group_quota',
        seerr_options_changed: 'arr_rules_stuck_seerr_options_changed',
        seerr_options_disabled: 'arr_rules_stuck_seerr_options_disabled',
        seerr_advanced_required: 'arr_rules_stuck_seerr_advanced_required',
        admin_required: 'arr_rules_stuck_admin_required'
    };

    /**
     * The stuck chip's words: why it is held, in plain words, when the card says (administrators),
     * else the neutral "Stuck · needs a look".
     * @param {Object} item Card.
     * @returns {string} Text.
     */
    function stuckText(item) {
        const key = X.isAdmin() && typeof item.admin?.reason === 'string' ? STUCK_WORDS[item.admin.reason] : null;
        return X.tr(key || 'arr_approvals_stuck');
    }

    /**
     * An administrator's Details under a card: the reason codes behind it (the card's own and the
     * last answer's), or null when there are none or the caller isn't an administrator.
     * @param {Object} item Card.
     * @param {{code?: string|null}|undefined} result Last answer on the card.
     * @returns {HTMLElement|null} Details.
     */
    function adminDetails(item, result) {
        if (!X.isAdmin()) return null;
        const lines = [];
        if (item.stuck && typeof item.admin?.reason === 'string' && item.admin.reason) lines.push(X.tr('arr_approvals_details_code', { code: item.admin.reason }));
        if (result?.code) lines.push(X.tr('arr_approvals_details_answer', { code: result.code }));
        if (!lines.length) return null;
        const details = X.el('details', 'je-approval-admin');
        const summary = X.el('summary', 'je-approval-admin-summary', X.tr('arr_approvals_details'));
        summary.dataset.jeFocus = `details:${item.id}`;
        details.appendChild(summary);
        for (const line of lines) details.appendChild(X.el('div', 'je-approval-admin-line', line));
        return details;
    }

    /**
     * Approves one card (optionally with edits) and shows its outcome on it.
     * @param {Object} item Card.
     * @param {Object} [input] Edited request input (approve with changes).
     * @returns {Promise<void>}
     */
    async function approve(item, input) {
        if (state.busy.has(item.id) || !item.canApprove) return;
        state.busy.add(item.id);
        state.results.delete(item.id);
        draw();
        // The answer belongs to this session: after a sign-out (the state is then the next
        // person's) it is dropped, not shown.
        const asked = X.epoch();
        const answer = await X.call(`/acquire/requests/${encodeURIComponent(item.id)}/approve`, { method: 'POST', body: input ? { input } : {} });
        if (asked !== X.epoch()) return;
        state.busy.delete(item.id);
        settle(item, describe('approve', answer.status, answer.body));
        if (state.results.get(item.id)?.ok) state.edits.delete(item.id);
        draw();
        JE.arrStatus?.refresh?.([item.key]);
        load();
    }

    /**
     * Declines one card with a reason (and an optional note) and shows its outcome on it.
     * @param {Object} item Card.
     * @param {string} reason The reason the requester sees.
     * @returns {Promise<void>}
     */
    async function decline(item, reason) {
        if (state.busy.has(item.id) || !item.canApprove) return;
        const text = String(reason || '').trim().slice(0, 500) || X.tr('arr_approvals_reason_default');
        state.busy.add(item.id);
        state.results.delete(item.id);
        draw();
        const asked = X.epoch();
        const answer = await X.call(`/acquire/requests/${encodeURIComponent(item.id)}/decline`, { method: 'POST', body: { reason: text } });
        if (asked !== X.epoch()) return;
        state.busy.delete(item.id);
        const result = describe('decline', answer.status, answer.body);
        settle(item, result);
        if (result.ok) {
            state.reasons.delete(item.id);
            state.notes.delete(item.id);
        }
        draw();
        JE.arrStatus?.refresh?.([item.key]);
        load();
    }

    /**
     * Shows a card's outcome on the card and, when it worked (the card then leaves the list), in the
     * banner above the cards with its title.
     * @param {Object} item Card.
     * @param {{text: string, tone: string, ok: boolean}} result Outcome words.
     * @returns {void}
     */
    function settle(item, result) {
        state.results.set(item.id, result);
        if (result.ok) state.banner = { text: X.tr('arr_approvals_result_with_title', { title: X.titleText(item), result: result.text }), tone: result.tone };
    }

    /**
     * The HTTP status a bulk item's outcome stands for (each item carries its outcome, not its status).
     * @param {Object} outcome Item outcome ({outcome, reason, certainty}).
     * @returns {number} Status.
     */
    function itemStatus(outcome) {
        const reason = outcome?.reason || '';
        switch (outcome?.outcome) {
            case 'quota_exceeded': return 429;
            case 'unavailable': return 503;
            case 'denied':
            case 'blocked':
                if (['request_changed', 'request_in_flight', 'not_found', 'idempotency_conflict', 'instance_changed'].includes(reason)) return 409;
                return /^invalid_/.test(reason) ? 400 : 403;
            default: return typeof outcome?.outcome === 'string' ? 200 : 0;
        }
    }

    /**
     * Approves the selected cards in one call (each is checked again by the server); a 207 answer
     * puts every card's own outcome on it.
     * @returns {Promise<void>}
     */
    async function bulkApprove() {
        const ids = [...state.selected].slice(0, MAX_BULK);
        if (!ids.length || state.busy.has('bulk')) return;
        state.busy.add('bulk');
        ids.forEach(id => state.busy.add(id));
        state.banner = null;
        draw();
        const asked = X.epoch();
        const answer = await X.call('/acquire/requests/bulk-approve', { method: 'POST', body: { ids } });
        if (asked !== X.epoch()) return;
        state.busy.delete('bulk');
        ids.forEach(id => state.busy.delete(id));
        const items = Array.isArray(answer.body?.items) ? answer.body.items : null;
        if ((answer.status === 200 || answer.status === 207) && items && items.length === ids.length) {
            let ok = 0;
            ids.forEach((id, i) => {
                const outcome = items[i] || {};
                const result = describe('approve', itemStatus(outcome), outcome);
                if (result.ok) ok++;
                state.results.set(id, result);
            });
            state.selected.clear();
            state.selecting = false;
            state.banner = { text: X.tr('arr_approvals_bulk_summary', { ok, failed: ids.length - ok }), tone: ok === ids.length ? 'done' : 'attention' };
        } else {
            state.banner = describe('approve', answer.status, answer.body);
        }
        draw();
        load();
    }

    /**
     * The request input for "approve with changes" from the card and its edit state.
     * @param {Object} item Card.
     * @param {Object} edit Edit state ({seasons: Set, episodes: Set, variant}).
     * @returns {Object|null} Input, or null when nothing is left picked.
     */
    function editedInput(item, edit) {
        const input = { key: item.key, scope: item.scope, variant: edit.variant, seasons: [...(item.seasons || [])], episodes: (item.episodes || []).map(e => ({ season: e.season, episode: e.episode })) };
        if (item.scope === 'seasons') input.seasons = input.seasons.filter(s => edit.seasons.has(s));
        if (item.scope === 'episodes') input.episodes = input.episodes.filter(e => edit.episodes.has(`${e.season}x${e.episode}`));
        if ((item.scope === 'seasons' && !input.seasons.length) || (item.scope === 'episodes' && !input.episodes.length)) return null;
        return input;
    }

    /**
     * True when a card can be approved with changes (several seasons or episodes to narrow, or the
     * other quality the approver may give).
     * @param {Object} item Card.
     * @returns {boolean} Editable.
     */
    function editable(item) {
        return item.canApprove && (item.canSwitchVariant
            || (item.scope === 'seasons' && (item.seasons || []).length > 1)
            || (item.scope === 'episodes' && (item.episodes || []).length > 1));
    }

    /**
     * Draws the tab from what is known, keeping focus on the same control.
     * @returns {void}
     */
    function draw() {
        const panel = state.panel;
        if (!panel || !state.shown || !panel.isConnected) return;
        const focus = X.focusedId(panel);
        panel.textContent = '';
        const box = X.el('div', 'je-approvals');
        // Darker greens and ambers on a light theme (readable at 4.5:1).
        if (JE.internals?.arrAskSheetStyles?.isLight?.()) box.classList.add('je-approvals-light');
        panel.appendChild(box);
        if (state.banner) {
            const banner = X.el('div', `je-hub-note je-approvals-banner je-approvals-tone-${state.banner.tone}`, state.banner.text);
            banner.setAttribute('role', 'status');
            box.appendChild(banner);
        }
        if (!state.items) {
            const empty = X.el('div', 'je-hub-empty', X.tr(state.error ? 'arr_approvals_error' : 'arr_approvals_loading'));
            if (state.error) {
                const retry = X.button('je-hub-btn', X.tr('arr_approvals_retry'), 'refresh', 'approvals:retry');
                retry.addEventListener('click', () => { state.error = false; draw(); load(); });
                empty.appendChild(retry);
            }
            box.appendChild(empty);
            X.restoreFocus(panel, focus, ['approvals:retry']);
            return;
        }
        if (state.error) {
            const note = X.el('div', 'je-hub-note je-hub-note-warn', X.tr('arr_approvals_error'));
            const retry = X.button('je-hub-btn', X.tr('arr_approvals_retry'), 'refresh', 'approvals:retry');
            retry.addEventListener('click', () => load());
            note.appendChild(retry);
            box.appendChild(note);
        }
        const stuckOnly = filter() === 'stuck';
        const items = state.items.filter(i => !stuckOnly || i.stuck);
        box.appendChild(toolbar(items, stuckOnly));
        if (state.more) box.appendChild(X.el('div', 'je-hub-note', X.tr('arr_approvals_more')));
        if (!items.length) {
            box.appendChild(X.el('div', 'je-hub-empty', X.tr(stuckOnly ? 'arr_approvals_empty_stuck' : 'arr_approvals_empty')));
        } else {
            const list = X.el('div', 'je-approvals-list');
            items.forEach(item => list.appendChild(card(item)));
            box.appendChild(list);
            if (hasTouch() && items.some(i => i.canApprove)) {
                const hint = X.el('div', 'je-approvals-hint');
                hint.appendChild(X.icon('touch_app'));
                hint.appendChild(document.createTextNode(X.tr('arr_approvals_swipe_hint')));
                box.appendChild(hint);
            }
        }
        // A card that left the list: focus its neighbour's Approve, else the tab.
        const fallbacks = items.map(i => `approve:${i.id}`);
        X.restoreFocus(panel, focus, fallbacks);
    }

    /**
     * True on touch screens (the swipe hint shows there).
     * @returns {boolean} Touch.
     */
    function hasTouch() {
        try {
            return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
        } catch {
            return false;
        }
    }

    /**
     * The bar above the cards: the stuck filter note, Select / Approve selected.
     * @param {Object[]} items Shown cards.
     * @param {boolean} stuckOnly Only stuck cards are shown.
     * @returns {HTMLElement} Toolbar.
     */
    function toolbar(items, stuckOnly) {
        const bar = X.el('div', 'je-approvals-toolbar');
        if (stuckOnly) {
            bar.appendChild(X.el('span', 'je-approvals-filter', X.tr('arr_approvals_showing_stuck')));
            const all = X.button('je-hub-btn', X.tr('arr_approvals_show_all'), null, 'approvals:all');
            all.addEventListener('click', () => {
                H.selectTab?.(TAB);
                draw();
            });
            bar.appendChild(all);
        }
        const approvable = items.filter(i => i.canApprove);
        if (approvable.length >= 2) {
            const select = X.button('je-hub-btn je-approvals-select', X.tr(state.selecting ? 'arr_approvals_select_done' : 'arr_approvals_select'), state.selecting ? 'done' : 'check_box', 'approvals:select');
            select.setAttribute('aria-pressed', String(state.selecting));
            select.addEventListener('click', () => {
                state.selecting = !state.selecting;
                if (!state.selecting) state.selected.clear();
                draw();
            });
            bar.appendChild(select);
        }
        if (state.selecting) {
            const n = state.selected.size;
            const bulk = X.button('je-hub-btn je-hub-btn-primary je-approvals-bulk', X.tr('arr_approvals_bulk', { count: n }), 'done_all', 'approvals:bulk');
            bulk.disabled = n === 0 || n > MAX_BULK;
            X.busy(bulk, state.busy.has('bulk'));
            bulk.addEventListener('click', () => bulkApprove());
            bar.appendChild(bulk);
            if (n >= MAX_BULK) bar.appendChild(X.el('span', 'je-approvals-limit', X.tr('arr_approvals_bulk_limit', { max: MAX_BULK })));
        }
        return bar;
    }

    /**
     * One approval card.
     * @param {Object} item Card from the server.
     * @returns {HTMLElement} Card.
     */
    function card(item) {
        const busy = state.busy.has(item.id);
        const node = X.el('article', `je-approval${item.stuck ? ' je-approval-stuck' : ''}${busy ? ' je-approval-busy' : ''}`);
        node.dataset.requestId = item.id;
        node.dataset.jeArrKey = item.key || '';
        node.setAttribute('aria-busy', String(busy));
        const name = X.titleText(item);
        node.setAttribute('aria-label', name);

        const top = X.el('div', 'je-approval-top');
        if (state.selecting && item.canApprove) {
            const label = X.el('label', 'je-approval-check');
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.checked = state.selected.has(item.id);
            box.disabled = !box.checked && state.selected.size >= MAX_BULK;
            X.busy(box, busy);
            box.dataset.jeFocus = `select:${item.id}`;
            box.setAttribute('aria-label', X.tr('arr_approvals_select_item', { title: name }));
            box.addEventListener('change', () => {
                if (box.checked) state.selected.add(item.id);
                else state.selected.delete(item.id);
                draw();
            });
            label.appendChild(box);
            top.appendChild(label);
        }
        top.appendChild(X.poster(item, 'je-approval-poster'));
        const body = X.el('div', 'je-approval-body');
        const title = X.el('h3', 'je-approval-title', name);
        if (item.variant === '4k') title.appendChild(X.el('span', 'je-hub-chip', X.tr('arr_approvals_4k')));
        body.appendChild(title);
        const who = item.requester?.name || X.tr('arr_approvals_someone');
        body.appendChild(X.el('div', 'je-approval-meta', [who, X.ago(item.createdAt), X.scopeText(item)].filter(Boolean).join(' · ')));
        const role = item.requester?.role ? (item.requester.role === 'trusted' ? X.tr('arr_rules_role_trusted') : X.tr(`arr_approvals_role_${item.requester.role}`)) : '';
        const quota = quotaText(item.requester?.quota);
        if (role || quota) body.appendChild(X.el('div', 'je-approval-meta je-approval-role', [role, quota].filter(Boolean).join(' · ')));
        // Phase 4b: the shared allowance their requests draw on, and why the household rules want a look.
        const pool = H.rules?.poolText?.(item.requester?.pool);
        if (pool) body.appendChild(X.el('div', 'je-approval-meta je-approval-pool', pool));
        const rating = ratingLine(item, who);
        if (rating) body.appendChild(rating);
        // A card still waits for an OK, so a verdict that would have let it go ahead (a Kid's, say) didn't decide it.
        const rules = item.rules?.verdict === 'approve' ? null : H.rules?.why?.(item.rules);
        if (rules) body.appendChild(rules);
        // The part asked for may already be on its way or here (someone else's request, an arr outside JE).
        // A request held after its OK: the stuck chip says why; "OK'd! Getting started" would contradict it.
        const heldAfterOk = item.okd === true && item.stuck === true && ['approved', 'asked'].includes(item.partStatus?.stage);
        const part = heldAfterOk ? null : X.partPill(item.partStatus);
        if (part) {
            part.classList.add('je-approval-part');
            body.appendChild(part);
        }
        if (Array.isArray(item.alsoWanted) && item.alsoWanted.length) {
            const also = X.el('div', 'je-approval-line je-approval-also');
            also.appendChild(X.icon('group'));
            also.appendChild(document.createTextNode(X.tr('arr_approvals_also_wanted', { names: item.alsoWanted.join(', ') })));
            body.appendChild(also);
        }
        const space = spaceText(item.space);
        if (space) {
            const line = X.el('div', 'je-approval-line je-approval-space');
            line.appendChild(X.icon('storage'));
            line.appendChild(document.createTextNode(space));
            body.appendChild(line);
        }
        if (item.already4k === true) {
            const line = X.el('div', 'je-approval-line je-approval-4k');
            line.appendChild(X.icon('4k'));
            line.appendChild(document.createTextNode(X.isAdmin() && item.already4kIn ? X.tr('arr_approvals_already_in', { name: item.already4kIn }) : X.tr('arr_approvals_already_4k')));
            body.appendChild(line);
        }
        const chips = X.el('div', 'je-approval-chips');
        if (item.overQuota) chips.appendChild(chip('je-approval-chip-quota', 'data_usage', X.tr('arr_approvals_over_quota')));
        if (item.reason === 'rule_review') chips.appendChild(chip('je-approval-chip-quota', 'rule', X.tr('arr_rules_chip_review')));
        else if (item.reason === 'group_quota') chips.appendChild(chip('je-approval-chip-quota', 'data_usage', X.tr('arr_rules_chip_pool')));
        else if (item.reason === 'household_rule') chips.appendChild(chip('je-approval-chip-stuck', 'block', X.tr('arr_rules_chip_refused')));
        if (typeof item.estimateGb === 'number' && item.estimateGb > 0) chips.appendChild(chip('je-approval-chip-estimate', 'storage', X.tr('arr_approvals_estimate', { gb: Math.round(item.estimateGb) })));
        if (item.stuck) chips.appendChild(chip('je-approval-chip-stuck', 'schedule', stuckText(item)));
        if (chips.childNodes.length) body.appendChild(chips);
        top.appendChild(body);
        node.appendChild(top);

        const result = state.results.get(item.id);
        if (result) {
            const line = X.el('div', `je-approval-result je-approvals-tone-${result.tone}`, result.text);
            line.setAttribute('role', 'status');
            node.appendChild(line);
        }
        const details = adminDetails(item, result);
        if (details) node.appendChild(details);
        if (busy) node.appendChild(X.el('div', 'je-approval-working', X.tr('arr_approvals_working')));

        if (!item.canApprove) {
            // Already OK'd and held (a 4K copy nothing can take now, say): nothing waits for anyone's OK.
            if (item.okd !== true) node.appendChild(X.el('div', 'je-approval-readonly', X.tr('arr_approvals_read_only', { contact: X.contact() })));
            return node;
        }
        const actions = X.el('div', 'je-approval-actions');
        const yes = X.button('je-approval-btn je-approval-approve', X.tr('arr_approvals_approve'), 'check', `approve:${item.id}`);
        yes.setAttribute('aria-label', X.tr('arr_approvals_approve_label', { title: name }));
        X.busy(yes, busy);
        yes.addEventListener('click', () => approve(item));
        const no = X.button('je-approval-btn je-approval-decline', X.tr('arr_approvals_decline'), 'close', `decline:${item.id}`);
        no.setAttribute('aria-label', X.tr('arr_approvals_decline_label', { title: name }));
        no.setAttribute('aria-expanded', String(state.reasons.has(item.id)));
        X.busy(no, busy);
        no.addEventListener('click', () => {
            if (state.reasons.has(item.id)) state.reasons.delete(item.id);
            else state.reasons.add(item.id);
            draw();
        });
        actions.appendChild(yes);
        actions.appendChild(no);
        node.appendChild(actions);
        if (editable(item)) {
            const edit = X.button('je-hub-btn je-approval-edit', X.tr('arr_approvals_edit'), 'tune', `edit:${item.id}`);
            edit.setAttribute('aria-expanded', String(state.edits.has(item.id)));
            X.busy(edit, busy);
            edit.addEventListener('click', () => {
                if (state.edits.has(item.id)) state.edits.delete(item.id);
                else state.edits.set(item.id, { seasons: new Set(item.seasons || []), episodes: new Set((item.episodes || []).map(e => `${e.season}x${e.episode}`)), variant: item.variant || 'standard' });
                draw();
            });
            node.appendChild(edit);
        }
        if (state.reasons.has(item.id)) node.appendChild(reasonsPanel(item, busy));
        if (state.edits.has(item.id)) node.appendChild(editSheet(item, busy));
        swipe(node, item);
        return node;
    }

    /**
     * A small chip with an icon.
     * @param {string} cls Class.
     * @param {string} iconName Icon.
     * @param {string} text Words.
     * @returns {HTMLElement} Chip.
     */
    function chip(cls, iconName, text) {
        const c = X.el('span', `je-approval-chip ${cls}`);
        c.appendChild(X.icon(iconName));
        c.appendChild(document.createTextNode(text));
        return c;
    }

    /**
     * Where the title would land: "Movies drive: 1.2 TB free" (a Jellyfin library name, never a
     * path), or just the free space when the folder maps to no single library ('' when unknown).
     * @param {{library?: string|null, freeGb: number}|null|undefined} space Space fact.
     * @returns {string} Text.
     */
    function spaceText(space) {
        if (!space || typeof space.freeGb !== 'number' || !(space.freeGb >= 0)) return '';
        const size = space.freeGb >= 1000
            ? X.tr('arr_size_tb', { n: (Math.round(space.freeGb / 100) / 10).toLocaleString() })
            : X.tr('arr_size_gb', { n: Math.round(space.freeGb).toLocaleString() });
        return space.library ? X.tr('arr_approvals_space_library', { library: space.library, size }) : X.tr('arr_approvals_space', { size });
    }

    /**
     * "3 of 7 used" / "2 used · no limit" ('' when unknown).
     * @param {{used: number, limit: number|null, available: boolean}|undefined} quota Quota.
     * @returns {string} Text.
     */
    function quotaText(quota) {
        if (!quota || quota.available === false || typeof quota.used !== 'number') return '';
        return typeof quota.limit === 'number' ? X.tr('arr_approvals_quota', { used: quota.used, limit: quota.limit }) : X.tr('arr_approvals_quota_unlimited', { used: quota.used });
    }

    /**
     * The rating line of a limited requester ("G · within Leo's limit"), or null.
     * @param {Object} item Card.
     * @param {string} who Requester's name (or the neutral words).
     * @returns {HTMLElement|null} Line.
     */
    function ratingLine(item, who) {
        if (!item.rating) return null;
        const within = item.rating.within === true;
        const label = typeof item.rating.label === 'string' && item.rating.label ? item.rating.label : '';
        const name = item.requester?.name || X.tr('arr_approvals_requester');
        const key = within ? (label ? 'arr_approvals_rating_within' : 'arr_approvals_rating_within_unrated') : (label ? 'arr_approvals_rating_outside' : 'arr_approvals_rating_outside_unrated');
        const line = X.el('div', `je-approval-rating ${within ? 'je-approval-rating-ok' : 'je-approval-rating-warn'}`);
        line.appendChild(X.icon(within ? 'verified_user' : 'warning'));
        line.appendChild(document.createTextNode(X.tr(key, { rating: label, name: name || who })));
        return line;
    }

    /**
     * The decline reasons: four chips, a short note (not on TV) and decline without a reason.
     * @param {Object} item Card.
     * @param {boolean} busy An action on the card is under way.
     * @returns {HTMLElement} Panel.
     */
    function reasonsPanel(item, busy) {
        const box = X.el('div', 'je-approval-reasons');
        box.appendChild(X.el('div', 'je-approval-reasons-title', X.tr('arr_approvals_decline_heading')));
        const chips = X.el('div', 'je-approval-reason-list');
        REASONS.forEach((key, i) => {
            const b = X.button('je-approval-reason', X.tr(key), null, `reason:${item.id}:${i}`);
            X.busy(b, busy);
            b.addEventListener('click', () => {
                if (state.busy.has(item.id)) return;
                const note = (state.notes.get(item.id) || '').trim();
                decline(item, note ? `${X.tr(key)} · ${note}` : X.tr(key));
            });
            chips.appendChild(b);
        });
        box.appendChild(chips);
        if (!X.isTv()) {
            const label = X.el('label', 'je-approval-note');
            label.appendChild(X.el('span', 'je-approval-note-label', X.tr('arr_approvals_note_label')));
            const input = document.createElement('input');
            input.type = 'text';
            input.maxLength = NOTE_MAX;
            input.value = state.notes.get(item.id) || '';
            input.dataset.jeFocus = `note:${item.id}`;
            input.addEventListener('input', () => state.notes.set(item.id, input.value.slice(0, NOTE_MAX)));
            label.appendChild(input);
            box.appendChild(label);
            const send = X.button('je-hub-btn je-approval-note-send', X.tr('arr_approvals_note_send'), 'send', `note-send:${item.id}`);
            X.busy(send, busy);
            send.addEventListener('click', () => {
                const note = (state.notes.get(item.id) || '').trim();
                decline(item, note || X.tr('arr_approvals_reason_default'));
            });
            box.appendChild(send);
        }
        const plain = X.button('je-hub-btn je-approval-plain', X.tr('arr_approvals_just_decline'), null, `plain:${item.id}`);
        X.busy(plain, busy);
        plain.addEventListener('click', () => decline(item, X.tr('arr_approvals_reason_default')));
        box.appendChild(plain);
        return box;
    }

    /**
     * The "approve with changes" sheet: narrow seasons or episodes, switch Standard/4K.
     * @param {Object} item Card.
     * @param {boolean} busy An action on the card is under way.
     * @returns {HTMLElement} Sheet.
     */
    function editSheet(item, busy) {
        const edit = state.edits.get(item.id);
        const sheet = X.el('div', 'je-approval-sheet');
        sheet.setAttribute('role', 'group');
        sheet.setAttribute('aria-label', X.tr('arr_approvals_edit_title'));
        sheet.appendChild(X.el('div', 'je-approval-reasons-title', X.tr('arr_approvals_edit_title')));
        const toggle = (legendKey, values, has, flip, labelOf, prefix) => {
            const set = X.el('fieldset', 'je-approval-fieldset');
            set.appendChild(X.el('legend', null, X.tr(legendKey)));
            values.forEach((value) => {
                const label = X.el('label', 'je-approval-option');
                const box = document.createElement('input');
                box.type = 'checkbox';
                box.checked = has(value);
                box.dataset.jeFocus = `${prefix}:${item.id}:${labelOf(value)}`;
                box.addEventListener('change', () => { flip(value, box.checked); draw(); });
                label.appendChild(box);
                label.appendChild(document.createTextNode(labelOf(value)));
                set.appendChild(label);
            });
            sheet.appendChild(set);
        };
        if (item.scope === 'seasons' && (item.seasons || []).length > 1) {
            toggle('arr_approvals_edit_seasons', item.seasons, s => edit.seasons.has(s), (s, on) => (on ? edit.seasons.add(s) : edit.seasons.delete(s)),
                s => X.tr('arr_hub_season', { list: s }), 'edit-season');
        }
        if (item.scope === 'episodes' && (item.episodes || []).length > 1) {
            toggle('arr_approvals_edit_episodes', item.episodes, e => edit.episodes.has(`${e.season}x${e.episode}`),
                (e, on) => (on ? edit.episodes.add(`${e.season}x${e.episode}`) : edit.episodes.delete(`${e.season}x${e.episode}`)),
                e => X.tr('arr_approvals_scope_episode', { season: e.season, episode: e.episode }), 'edit-episode');
        }
        if (item.canSwitchVariant) {
            const set = X.el('fieldset', 'je-approval-fieldset');
            set.appendChild(X.el('legend', null, X.tr('arr_approvals_edit_quality')));
            for (const variant of ['standard', '4k']) {
                const label = X.el('label', 'je-approval-option');
                const radio = document.createElement('input');
                radio.type = 'radio';
                radio.name = `je-approval-variant-${item.id}`;
                radio.value = variant;
                radio.checked = edit.variant === variant;
                radio.dataset.jeFocus = `edit-variant:${item.id}:${variant}`;
                radio.addEventListener('change', () => { if (radio.checked) { edit.variant = variant; draw(); } });
                label.appendChild(radio);
                label.appendChild(document.createTextNode(X.tr(variant === '4k' ? 'arr_approvals_edit_4k' : 'arr_approvals_edit_standard')));
                set.appendChild(label);
            }
            sheet.appendChild(set);
        }
        const input = editedInput(item, edit);
        if (!input) sheet.appendChild(X.el('div', 'je-approval-result je-approvals-tone-attention', X.tr('arr_approvals_edit_empty')));
        const row = X.el('div', 'je-approval-actions');
        const go = X.button('je-approval-btn je-approval-approve', X.tr('arr_approvals_edit_approve'), 'check', `edit-approve:${item.id}`);
        go.disabled = !input;
        X.busy(go, busy);
        go.addEventListener('click', () => { const next = editedInput(item, edit); if (next) approve(item, next); });
        const cancel = X.button('je-hub-btn', X.tr('arr_approvals_edit_cancel'), null, `edit-cancel:${item.id}`);
        cancel.addEventListener('click', () => { state.edits.delete(item.id); draw(); });
        row.appendChild(go);
        row.appendChild(cancel);
        sheet.appendChild(row);
        return sheet;
    }

    /**
     * Swipe on touch screens: right approves, left opens the decline reasons (the buttons stay).
     * @param {HTMLElement} node Card.
     * @param {Object} item Card data.
     * @returns {void}
     */
    function swipe(node, item) {
        let start = null;
        node.addEventListener('touchstart', (e) => {
            const t = e.touches?.[0];
            start = t && !e.target.closest?.('input, button, label') ? { x: t.clientX, y: t.clientY } : null;
        }, { passive: true });
        node.addEventListener('touchend', (e) => {
            const t = e.changedTouches?.[0];
            if (!start || !t) return;
            const dx = t.clientX - start.x;
            const dy = t.clientY - start.y;
            start = null;
            if (Math.abs(dx) < SWIPE_PX || Math.abs(dy) > Math.abs(dx) / 2) return;
            if (dx > 0) approve(item);
            else {
                state.reasons.add(item.id);
                draw();
                state.panel?.querySelector(`[data-je-focus="reason:${item.id}:0"]`)?.focus({ preventScroll: true });
            }
        });
    }

    // The page redraws for the new user once their capabilities are known; the tab reads then.
    JE.session?.onUserChange?.('arr-approvals', () => resetForUser());

    H.extraTabs = H.extraTabs || [];
    H.extraTabs.push({ id: TAB, label: 'arr_approvals_tab', visible: () => approverNow(), count, render, leave });
    H.approvals = { load, state, describe };
})(window.JellyfinEnhanced);
