/** Jellyfin-owned Users routes, JE-owned sibling section and card footers (12.2 and 10.11). */
(function (JE) {
    'use strict';
    const tabs = ['profile', 'access', 'parentalcontrol', 'password'];
    const roots = { profile: 'editUserPage', access: 'userLibraryAccessPage', parentalcontrol: 'userParentalControlPage', password: 'userPasswordPage' };
    /** Normalize a GUID without accepting malformed hyphens or an empty GUID. */
    function idOf(raw) {
        if (!/^(?:[a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/i.test(raw || '')) return null;
        const id = raw.replace(/-/g, '').toLowerCase();
        return /^0{32}$/.test(id) ? null : id;
    }
    /** Parse both native route families, distinguishing list, add and invalid routes. */
    function parseRoute(hash) {
        const url = new URL((hash || '').replace(/^#!?/, ''), 'http://route.invalid');
        const path = url.pathname.replace(/\/+$/, '');
        if (path === '/dashboard/users') return { kind: 'list' };
        const parts = path.split('/');
        if (parts.length === 5 && parts[1] === 'dashboard' && parts[2] === 'users' && tabs.includes(parts[4]) && idOf(parts[3]))
            return { kind: 'editor', id: idOf(parts[3]), tab: parts[4], family: '12' };
        if (parts.length === 4 && parts[1] === 'dashboard' && parts[2] === 'users' && tabs.includes(parts[3]) && idOf(url.searchParams.get('userId')))
            return { kind: 'editor', id: idOf(url.searchParams.get('userId')), tab: parts[3], family: '10' };
        return null;
    }
    /** Translate every owned UI string through the locale bundle. */
    function t(key) { return JE.t('arr_user_' + key); }
    /** Create text-only DOM; names, topics and upstream strings never enter HTML. */
    function el(tag, text, parent) {
        const node = document.createElement(tag);
        if (text !== undefined) node.textContent = text;
        if (parent) parent.appendChild(node);
        return node;
    }
    /** Install one bounded adapter, using the shared observer and lifecycle. */
    JE.initializeArrAdminUsers = function () {
        const life = JE.core.lifecycle.register('arr-admin-users');
        life.teardown();
        let stopped = false, frame = 0, generation = 0, routeKey = '', route = null, authorized = false;
        let authorization = null, request = null, summary = null, summaryStarted = false;
        const drafts = new Map();
        const api = JE.arrAdminUsersApi;
        const style = el('style');
        style.textContent = '.je-admin-user{margin:1.5em 0;padding:1em;border:1px solid #7776;border-radius:.5em;max-width:62em}.je-admin-user summary{cursor:pointer;font-size:1.15em}.je-user-groups{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,24em),1fr));gap:1em}.je-admin-user fieldset{margin:.5em 0;padding:1em;border:1px solid #7776;border-radius:.4em}.je-admin-user label{display:block;margin:.65em 0}.je-admin-user input,.je-admin-user select{display:block;box-sizing:border-box;max-width:100%;padding:.45em;background:var(--background-paper,#222);color:inherit;border:1px solid #888;border-radius:.25em}.je-admin-user button{padding:.6em;margin:.5em .5em .5em 0;cursor:pointer}.je-admin-user p{overflow-wrap:anywhere;line-height:1.5}.je-admin-user a{color:inherit;text-decoration:underline;margin-right:1em}.je-user-chip{display:block;font-size:.8em;padding:.3em;pointer-events:none}.je-admin-user [role=status]{min-height:1.3em}@media(max-width:480px){.je-admin-user{padding:.6em}.je-admin-user fieldset{padding:.6em}}';
        document.head.appendChild(style);
        /** Remove private DOM and cancel pending work. Identity changes clear all drafts. */
        function clear(identity) {
            generation++;
            request?.abort(); request = null;
            document.querySelectorAll('[data-je-admin-user],[data-je-user-chip]').forEach(n => n.remove());
            summary = null; summaryStarted = false;
            if (identity) { drafts.clear(); authorized = false; authorization = null; routeKey = ''; }
        }
        /** An async answer must belong to this epoch, route generation and current caller. */
        function current(gen, epoch, id) {
            return !stopped && authorized && generation === gen && JE.session?.getEpoch?.() === epoch && (!id || route?.id === id);
        }
        /** Check native admin authority at navigation, outside observer-driven scans. */
        async function authorize() {
            const epoch = JE.session?.getEpoch?.();
            const ticket = {};
            authorization = ticket;
            try {
                // Jellyfin caches getCurrentUser; re-read native permissions on navigation.
                const user = await (typeof ApiClient.getUser === 'function'
                    ? ApiClient.getUser(ApiClient.getCurrentUserId()) : ApiClient.getCurrentUser());
                if (stopped || epoch !== JE.session?.getEpoch?.() || authorization !== ticket) return;
                authorized = user?.Policy?.IsAdministrator === true && !user.Policy.IsDisabled;
                if (!authorized) clear(true); else schedule();
            } catch (_) { if (authorization === ticket) clear(true); }
        }
        /** Batch DOM notifications into one paint; owned child changes settle without rescheduling themselves. */
        function schedule() { if (!stopped && !frame) frame = requestAnimationFrame(update); }
        /** Follow route changes even when React retains the editor root. */
        function navigate() {
            const next = parseRoute(location.hash);
            const key = next ? JSON.stringify(next) : '';
            if (key !== routeKey) { clear(false); route = next; routeKey = key; }
            if (route) authorize();
            schedule();
        }
        /** Map a stored tri-state to the display labels. */
        function preference(value) { return value === false ? t('hide') : value === true ? t('show') : t('inherit'); }
        /** Render a safe, compact read-only value. */
        function line(parent, label, value) { return el('p', t(label) + ': ' + (value == null ? t('unknown') : typeof value === 'boolean' ? t(value ? 'yes' : 'no') : String(value)), parent); }
        /** A draft is owned by the person and survives every disposable React root. */
        function stateFor(data) {
            let state = drafts.get(data.id);
            if (!state) {
                state = { data, changes: {}, messages: {}, open: false, busy: new Set() };
                drafts.set(data.id, state);
                if (drafts.size > 30) drafts.delete(drafts.keys().next().value);
            }
            return state;
        }
        /** Add one independent group; never create a nested form or an implicit submit button. */
        function group(section, label, name, state, editable) {
            const fieldset = el('fieldset', undefined, section);
            el('legend', t(label), fieldset);
            if (editable) {
                const actions = el('div', undefined, fieldset);
                const save = el('button', t('save'), actions); save.type = 'button'; save.dataset.save = name;
                save.disabled = state.busy.has(name);
                save.addEventListener('click', () => saveGroup(name, state));
                const cancel = el('button', t('cancel'), actions); cancel.type = 'button';
                cancel.addEventListener('click', () => { delete state.changes[name]; delete state.messages[name]; request?.abort(); request = null; state.refresh = true; schedule(); });
            }
            const status = el('p', state.messages[name] || (state.changes[name] ? t('unsaved') : ''), fieldset); status.setAttribute('role', 'status');
            fieldset._status = status;
            return fieldset;
        }
        /** Keep a named value separate from the server snapshot; absence remains absence in PATCH. */
        function changed(state, groupName, name, value, fieldset) {
            state.changes[groupName] = { ...(state.changes[groupName] || {}), [name]: value };
            state.messages[groupName] = t('unsaved'); fieldset._status.textContent = t('unsaved');
        }
        /** Choose a draft value without losing false, null or an empty array. */
        function value(state, name, field, stored) { return Object.hasOwn(state.changes[name] || {}, field) ? state.changes[name][field] : stored; }
        /** Render an editable choice with safely constructed options. */
        function select(parent, state, groupName, field, label, stored, options, disabled) {
            const wrapper = el('label', t(label), parent), input = el('select', undefined, wrapper);
            input.dataset.field = field; input.disabled = !!disabled;
            for (const [v, text] of options) { const option = el('option', text, input); option.value = v == null ? '' : String(v); }
            input.value = String(value(state, groupName, field, stored) ?? '');
            input.addEventListener('change', () => changed(state, groupName, field, input.value === '' ? null : input.value, parent));
            return input;
        }
        /** Numeric overrides use blank for inheritance and reject invalid numbers before writing. */
        function number(parent, state, name, field, label, stored, disabled, min) {
            const wrapper = el('label', t(label), parent), input = el('input', undefined, wrapper);
            input.type = 'number'; input.min = String(min); input.step = field === 'quotaGb' ? 'any' : '1'; input.disabled = !!disabled;
            input.dataset.field = field; input.value = value(state, name, field, stored) ?? '';
            input.addEventListener('change', () => changed(state, name, field, input.value === '' ? null : Number(input.value), parent));
        }
        /** Links retain native routing ownership. */
        function link(parent, label, href) { const a = el('a', t(label), parent); a.href = href; return a; }
        /** Native user tab links depend on the route family, never on translated labels. */
        function tabLink(tab, id) { return route.family === '12' ? `#/dashboard/users/${id}/${tab}` : `#/dashboard/users/${tab}?userId=${id}`; }
        /** Render the JE section as a sibling of the native form, leaving all native handlers untouched. */
        function render(state) {
            if (!route || route.id !== state.data.id || !authorized) return;
            const root = document.getElementById('usersEditPage') || document.getElementById(roots[route.tab]);
            let parent = root?.querySelector('.content-primary') || root;
            if (!parent) return;
            if (parent.closest('form')) parent = parent.closest('form').parentElement;
            document.querySelectorAll('[data-je-admin-user]').forEach(n => n.remove());
            const d = state.data, section = el('details', undefined, parent);
            section.className = 'je-admin-user'; section.dataset.jeAdminUser = d.id; section.open = state.open;
            section.addEventListener('toggle', () => { state.open = section.open; });
            el('summary', 'Jellyfin Enhanced', section);
            el('p', d.name, section);
            if (d.disabled) el('p', t('disabled'), section);
            const groups = el('div', undefined, section); groups.className = 'je-user-groups';
            const policy = group(groups, 'requests', 'policy', state, d.policy.available);
            if (!d.policy.available) el('p', t('unavailable'), policy);
            else {
                const stored = d.policy.stored || {}, effective = d.policy.effective || {};
                line(policy, 'backend', d.policy.backend); line(policy, 'effectiveRole', effective.role);
                if (d.jellyfinAdmin) el('p', t('adminLocked'), policy);
                select(policy, state, 'policy', 'role', 'role', stored.role, [[null, t('defaultRole')], ...(d.policy.roles || []).map(r => [r, t('role_' + r.toLowerCase())])], d.jellyfinAdmin);
                number(policy, state, 'policy', 'quotaLimit', 'count', stored.quotaLimit, d.policy.backend !== 'je', -1);
                number(policy, state, 'policy', 'quotaGb', 'gb', stored.quotaGb, d.policy.backend !== 'je', 0);
                el('p', t('quotaHelp'), policy);
                line(policy, 'effectiveLimit', d.policy.backend === 'je' && d.policy.limit === null ? t('unlimited') : d.policy.limit); line(policy, 'effectiveGb', d.policy.gbLimit);
                line(policy, 'source', d.policy.sources ? [d.policy.sources.count, d.policy.sources.gb].map(s=>t('source_' + s)).join(' / ') : null);
                line(policy, 'movieRights', effective.canRequestMovies); line(policy, 'seriesRights', effective.canRequestSeries); line(policy, 'approvalRights', effective.canApprove);
                line(policy, 'fourKMovies', effective.can4kMovies); line(policy, 'fourKSeries', effective.can4kSeries);
                line(policy, 'blocking', [...new Set([d.policy.fourKMoviesReason, d.policy.fourKSeriesReason].filter(Boolean))].map(reason => t('restriction_' + (['requests_4k_required', 'feature_disabled', 'not_visible_to_user', 'user_required', 'instance_changed'].includes(reason) ? reason : 'other'))).join(' / ') || t('none'));
                if (d.usage.quota?.available) { line(policy, 'quota', `${d.usage.quota.used} / ${d.usage.quota.limit ?? t('unlimited')}`); line(policy, 'estimate', d.usage.quota.usedGb); line(policy, 'nextSlot', d.usage.quota.nextSlotAt); }
                else line(policy, 'quota', null);
                const grants = select(policy, state, 'policy', 'fourKMode', 'fourK', value(state, 'policy', 'fourKInstances', stored.fourKInstances) == null ? null : 'explicit', [[null, t('inherit')], ['explicit', t('explicit')]], d.policy.backend !== 'je');
                grants.addEventListener('change', () => {
                    delete state.changes.policy.fourKMode;
                    changed(state, 'policy', 'fourKInstances', grants.value === '' ? null : [], policy);
                    render(state);
                });
                if (value(state, 'policy', 'fourKInstances', stored.fourKInstances) != null) {
                    for (const instance of d.policy.instances || []) {
                        const label = el('label', instance.name, policy), check = el('input', undefined, label); check.type = 'checkbox'; check.disabled = d.policy.backend !== 'je';
                        check.checked = value(state, 'policy', 'fourKInstances', stored.fourKInstances).includes(instance.id);
                        check.addEventListener('change', () => {
                            const ids = new Set(value(state, 'policy', 'fourKInstances', stored.fourKInstances));
                            if (check.checked) ids.add(instance.id); else ids.delete(instance.id);
                            changed(state, 'policy', 'fourKInstances', [...ids], policy);
                        });
                    }
                }
            }
            const pool = group(groups, 'pools', 'pool-membership', state, d.pools.available);
            if (d.pools.available) {
                select(pool, state, 'pool-membership', 'poolId', 'pool', d.pools.explicit, [[null, t('roleFallback')], ...d.pools.choices.map(p => [p.id, p.name])], d.policy.backend !== 'je');
                line(pool, 'effectivePool', d.pools.effective?.name); el('p', t('poolHelp'), pool);
                if (d.pools.poolUse?.quota) line(pool, 'sharedUsage', `${d.pools.poolUse.quota.used} / ${d.pools.poolUse.quota.limit ?? t('unlimited')}`);
            } else el('p', t('unavailable'), pool);
            const safety = group(groups, 'safety', 'safety', state, false);
            if (d.safety.alwaysApproval) el('p', t('kidApproval'), safety);
            el('p', t('safetyHelp'), safety);
            link(safety, 'access', tabLink('access', d.id)); link(safety, 'parental', tabLink('parentalcontrol', d.id)); link(safety, 'sharedRules', '#/requests?tab=household');
            if (d.safety.rulesEnabled) el('p', t('inheritedRules'), safety);
            const notify = group(groups, 'notifications', 'notifications', state, d.notifications.available);
            if (d.notifications.available) {
                line(notify, 'emailVerified', d.notifications.emailVerified); el('p', t('emailHelp'), notify);
                line(notify, 'privacy', d.notifications.hideTitles); line(notify, 'quietHours', d.notifications.quietHours ? `${d.notifications.quietFrom}–${d.notifications.quietTo}` : false);
                const label = el('label', t('topic'), notify), topic = el('input', undefined, label); topic.value = value(state, 'notifications', 'topic', d.notifications.topic) || '';
                topic.addEventListener('change', () => changed(state, 'notifications', 'topic', topic.value, notify));
                el('p', t('topicHelp'), notify);
            } else el('p', t('unavailable'), notify);
            const consents = group(groups, 'automation', 'consents', state, false);
            el('p', t('personalOnly') + ' ' + d.name, consents);
            if (d.consents.available) for (const [field, stored] of Object.entries(d.consents.stored || {})) line(consents, field, stored === null ? t(field === 'listSwapIn' ? 'no' : 'inherit') : t(stored ? 'yes' : 'no'));
            else el('p', t('unavailable'), consents);
            line(consents, 'eligible', d.consents.eligible);
            for (const recipe of d.consents.recipes || []) line(consents, 'recipe_' + recipe.recipe, t(recipe.control.legacy ? 'legacy' : 'mode_' + (recipe.control.effective || 'off')) + (recipe.control.reason ? ' · ' + t('reason_' + recipe.control.reason) : ''));
            if (d.consents.grant) line(consents, 'grant', `${d.consents.grant.source} · ${d.consents.grant.grantedAt}`);
            if (d.consents.lists?.available) line(consents, 'listAttribution', d.consents.lists.items.length);
            // Phase 4f: the person's Ready playlist and TV messages, read-only (only the person turns them on or off).
            const ready = group(groups, 'ready', 'ready', state, false);
            if (d.ready?.available) {
                el('p', t('readyHelp'), ready);
                line(ready, 'readyPlaylistGate', d.ready.playlistGate); line(ready, 'readyPlaylistStored', d.ready.playlistStored); line(ready, 'readyPlaylistEffective', d.ready.playlistEffective);
                line(ready, 'readyState', t('readyState_' + (['active', 'off', 'deleted', 'removed', 'renew', 'privacy', 'lost'].includes(d.ready.state) ? d.ready.state : 'off')));
                if (d.ready.playlistEffective) line(ready, 'readyEntries', d.ready.entries);
                line(ready, 'readyMessagesGate', d.ready.messagesGate); line(ready, 'readyMessagesStored', d.ready.messagesStored); line(ready, 'readyMessagesEffective', d.ready.messagesEffective);
            } else el('p', t('unavailable'), ready);
            const display = group(groups, 'display', 'display', state, d.display.available);
            if (d.display.available) for (const field of Object.keys(d.display.stored || {})) {
                const input = select(display, state, 'display', field, field, d.display.stored[field] === false ? 'false' : d.display.stored[field] === true ? 'true' : null, [[null, t('inherit')], ['true', t('show')], ['false', t('hide')]], false);
                input.addEventListener('change', () => changed(state, 'display', field, input.value === '' ? null : input.value === 'true', display));
                line(display, 'serverGate', d.display.gates?.[field]); line(display, 'effectiveDisplay', d.display.effective?.[field]);
            } else el('p', t('unavailable'), display);
            const seerr = group(groups, 'seerr', 'seerr-import', state, true);
            line(seerr, 'linkState', t('state_' + d.seerr.state)); line(seerr, 'account', d.seerr.account); line(seerr, 'quotaSource', d.seerr.quotaSource);
            const block = select(seerr, state, 'seerr-import', 'blocked', 'blocked', d.seerr.blocked ? 'true' : 'false', [['false', t('no')], ['true', t('yes')]], false);
            block.addEventListener('change', () => changed(state, 'seerr-import', 'blocked', block.value === 'true', seerr));
            el('p', t('importHelp'), seerr);
            if (d.seerr.adminUrl) { const adminLink = link(seerr, 'seerrAdmin', d.seerr.adminUrl); adminLink.target = '_blank'; adminLink.rel = 'noopener noreferrer'; }
            else link(seerr, 'seerrAdmin', '#/configurationpage?name=Jellyfin%20Enhanced');
        }
        /** Refresh clean groups while retaining dirty drafts and their original conflict revisions. */
        function mergeFresh(state, data) {
            const revisions = { ...data.revisions };
            for (const name of Object.keys(state.changes)) revisions[name] = state.data.revisions[name];
            state.data = { ...data, revisions };
        }
        /** Save one draft. Conflicts retain it until explicit Cancel/reload; other groups stay dirty. */
        async function saveGroup(name, state) {
            const changes = state.changes[name];
            if (!changes || state.busy.has(name)) return;
            const gen = generation, epoch = JE.session?.getEpoch?.(), id = state.data.id;
            const revision = state.data.revisions[name];
            state.busy.add(name); state.messages[name] = t('saving'); render(state);
            try {
                const result = name === 'notifications' ? await api.assignTopic(id, changes, request?.signal)
                    : await api.patch(id, name, { revision, ...changes }, request?.signal);
                if (!current(gen, epoch, id)) return;
                // Save completion never overwrites edits made after this request began.
                if (state.changes[name] === changes) delete state.changes[name];
                if (name === 'notifications') state.data = { ...state.data, notifications: {
                    ...state.data.notifications, ...result, topic: result.topic ?? null, assigned: !!result.topic
                } };
                else mergeFresh(state, result);
                state.messages[name] = t('saved');
            } catch (error) {
                if (!current(gen, epoch, id)) return;
                if (error.status === 403 || error.status === 401) { clear(true); return; }
                state.messages[name] = t(error.status === 409 ? 'conflict' : 'saveError');
            } finally { state.busy.delete(name); if (current(gen, epoch, id)) render(state); }
        }
        /** Decorate by user id once per actual card; never intercept native card or menu clicks. */
        function cards() {
            if (!summary) return;
            const byId = new Map(summary.people.map(p => [idOf(p.id), p]));
            for (const card of document.querySelectorAll('#userProfilesPage .localUsers .card[data-userid]')) {
                const id = idOf(card.dataset.userid), row = byId.get(id), footer = card.querySelector('.cardFooter');
                if (!row || !row.role || !footer || footer.querySelector('[data-je-user-chip]')) continue;
                const words = [t('role_' + row.role)];
                const usage = row.usage || row, quota = usage.quota;
                if (quota?.available && quota.limit != null) words.push(`${quota.used} / ${quota.limit}`);
                if (Number.isInteger(usage.pending)) words.push(String(usage.pending) + ' ' + t('pending'));
                const chip = el('span', words.join(' · '), footer); chip.className = 'je-user-chip'; chip.dataset.jeUserChip = id;
                const entry = el('a', 'Jellyfin Enhanced', chip);
                entry.style.pointerEvents = 'auto';
                entry.style.display = 'block'; entry.style.color = 'inherit'; entry.style.marginTop = '.25em';
                const nativeLink = card.querySelector('a[href*="dashboard/users"]');
                const legacy = typeof ApiClient.serverVersion === 'function' && parseInt(ApiClient.serverVersion(), 10) < 12;
                entry.href = nativeLink?.getAttribute('href') || (legacy ? `#/dashboard/users/profile?userId=${id}` : `#/dashboard/users/${id}/profile`);
                entry.setAttribute('aria-label', t('openSettings'));
                entry.addEventListener('click', event => event.stopPropagation());
            }
        }
        /** Fetch once per list visit or editor target; root replacements reattach the retained draft. */
        function update() {
            frame = 0;
            if (stopped || !authorized || !route) return;
            if (route.kind === 'list') {
                if (summary) { cards(); return; }
                if (summaryStarted) return;
                summaryStarted = true; request = new AbortController();
                const gen = generation, epoch = JE.session?.getEpoch?.();
                api.summary(request.signal).then(result => { if (current(gen, epoch)) { summary = result; cards(); } }).catch(error => { if (current(gen, epoch) && [401, 403].includes(error.status)) clear(true); });
                return;
            }
            const state = drafts.get(route.id);
            if (state && !state.refresh) {
                if (!document.querySelector('[data-je-admin-user]')) render(state);
                return;
            }
            if (request) return;
            request = new AbortController();
            const gen = generation, epoch = JE.session?.getEpoch?.(), id = route.id;
            api.read(id, request.signal).then(data => { if (current(gen, epoch, id) && idOf(data.id) === id) { const held = stateFor(data); if (held.refresh) { mergeFresh(held, data); held.refresh = false; } render(held); } }).catch(error => {
                if (current(gen, epoch, id) && [401, 403].includes(error.status)) clear(true);
            });
        }
        life.track(JE.core.dom.onBodyMutation('arr-admin-users', schedule));
        life.track(JE.core.navigation.onNavigate(navigate));
        life.track(JE.session.onUserChange('arr-admin-users', () => clear(true)));
        for (const event of ['viewshow', 'pageshow', 'je:user-data-loaded']) { document.addEventListener(event, navigate); life.track(() => document.removeEventListener(event, navigate)); }
        life.track(() => { stopped = true; cancelAnimationFrame(frame); clear(true); style.remove(); });
        navigate();
    };
    JE.arrAdminUsers = { parseRoute };
})(window.JellyfinEnhanced);
