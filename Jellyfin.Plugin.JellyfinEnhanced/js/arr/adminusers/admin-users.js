/** Jellyfin-owned Users routes, JE-owned native tab and card footers (12.2 and 10.11). */
(function (JE) {
    'use strict';
    const tabs = ['profile', 'access', 'parentalcontrol', 'password'];
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
            return { kind: 'editor', id: idOf(parts[3]), tab: parts[4], family: '12', enhanced: url.searchParams.get('jeTab') === 'jellyfinenhanced' };
        if (parts.length === 4 && parts[1] === 'dashboard' && parts[2] === 'users' && tabs.includes(parts[3]) && idOf(url.searchParams.get('userId')))
            return { kind: 'editor', id: idOf(url.searchParams.get('userId')), tab: parts[3], family: '10', enhanced: url.searchParams.get('jeTab') === 'jellyfinenhanced' };
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
        let toastTimer = 0;
        const drafts = new Map();
        const api = JE.arrAdminUsersApi;
        const nativeTabs = JE.arrAdminUserTabs.create(schedule);
        const style = el('style');
        style.textContent = '[data-je-user-tabs] .MuiTabs-scroller{overflow-x:auto!important;scrollbar-width:none}.je-admin-user{min-width:0}.je-admin-user [data-group]{margin-bottom:2em}.je-admin-user [data-group]>h2{margin-top:0}.je-admin-user .fieldDescription{overflow-wrap:anywhere}.je-admin-user [data-group=safety] .button-link{display:block;margin:.5em 0}.je-admin-user details{margin:1em 0}.je-admin-user details>summary{cursor:pointer}.je-admin-user details p{margin:.35em 0}.je-admin-user [role=status]:empty{display:none}.je-admin-user .je-save-error{color:var(--error-color,#e57373)}.je-user-chip{display:block;font-size:.8em;padding:.3em;pointer-events:none}';
        document.head.appendChild(style);
        /** Remove private DOM and cancel pending work. Identity changes clear all drafts. */
        function clear(identity, keepSummary = false) {
            generation++;
            nativeTabs.reset();
            clearTimeout(toastTimer); document.querySelectorAll('[data-je-user-toast]').forEach(n => n.remove());
            request?.abort(); request = null;
            document.querySelectorAll('[data-je-admin-user],[data-je-user-chip]').forEach(n => n.remove());
            if (!keepSummary) summary = null;
            summaryStarted = false;
            if (identity) { drafts.clear(); authorized = false; authorization = null; routeKey = ''; }
        }
        /** An async answer must belong to this epoch, route generation and current caller. */
        function current(gen, epoch, id) {
            return !stopped && authorized && generation === gen && JE.session?.getEpoch?.() === epoch && (!id || route?.id === id);
        }
        /** Check native admin authority at navigation, outside observer-driven scans. */
        async function authorize() {
            authorized = false;
            clear(false, true);
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
        function line(parent, label, value) {
            const primary = ['backend', 'effectiveRole', 'quota', 'effectivePool', 'sharedUsage', 'emailVerified', 'autoMovieRequests', 'autoSeasonRequests', 'listSwapIn', 'linkState'];
            if (parent.tagName !== 'DETAILS' && !primary.includes(label)) {
                let details = parent.querySelector(':scope > details');
                if (!details) { details = el('details', undefined, parent); el('summary', t('showDetails'), details); }
                parent = details;
            }
            const row = el('p', t(label) + ': ' + (value == null ? t('unknown') : typeof value === 'boolean' ? t(value ? 'yes' : 'no') : String(value)), parent);
            row.className = 'fieldDescription'; return row;
        }
        /** Render native explanatory text. */
        function help(parent, key) { const node = el('div', t(key), parent); node.className = 'fieldDescription'; return node; }
        /** A draft is owned by the person and survives every disposable React root. */
        function stateFor(data) {
            let state = drafts.get(data.id);
            if (!state) {
                state = { data, changes: {}, messages: {}, submitted: {}, busy: new Set() };
                drafts.set(data.id, state);
                if (drafts.size > 30) drafts.delete(drafts.keys().next().value);
            }
            return state;
        }
        /** Add a native section heading and an inline status directly below it. */
        function group(section, label, name, state) {
            const fieldset = el('section', undefined, section); fieldset.dataset.group = name;
            const heading = el('h2', t(label), fieldset); heading.id = 'je-user-heading-' + name;
            fieldset.setAttribute('aria-labelledby', heading.id);
            const status = el('p', state.messages[name] || (state.changes[name] ? t('unsaved') : ''), fieldset);
            status.setAttribute('role', 'status'); status.className = 'fieldDescription';
            if ([t('conflict'), t('saveError')].includes(state.messages[name])) status.classList.add('je-save-error');
            fieldset._status = status; return fieldset;
        }
        /** Read a persisted field from its group's server snapshot. */
        function storedValue(data, groupName, name) {
            return groupName === 'pool-membership' ? data.pools.explicit
                : groupName === 'seerr-import' ? data.seerr.blocked
                : groupName === 'notifications' ? (data.notifications.topic || '')
                : data[groupName]?.stored?.[name];
        }
        /** Remove desired fields only when they match persistence and no queued submission can change it. */
        function reconcile(state, name) {
            if (state.submitted[name]) return;
            const remaining = Object.fromEntries(Object.entries(state.changes[name] || {}).filter(([field, value]) =>
                JSON.stringify(value) !== JSON.stringify(storedValue(state.data, name, field))));
            if (Object.keys(remaining).length) state.changes[name] = remaining; else delete state.changes[name];
        }
        /** Keep the desired value independent of every queued/in-flight submission, including reversions. */
        function changed(state, groupName, name, value, fieldset) {
            // This UI-only choice is translated to fourKInstances by its own listener.
            if (name === 'fourKMode') return;
            state.changes[groupName] = { ...(state.changes[groupName] || {}), [name]: value };
            reconcile(state, groupName);
            state.messages[groupName] = state.changes[groupName] ? t('unsaved') : '';
            fieldset._status.textContent = state.messages[groupName]; fieldset._status.classList.remove('je-save-error');
        }
        /** Choose a draft value without losing false, null or an empty array. */
        function value(state, name, field, stored) { return Object.hasOwn(state.changes[name] || {}, field) ? state.changes[name][field] : stored; }
        /** Render an editable choice with safely constructed options. */
        function select(parent, state, groupName, field, label, stored, options, disabled) {
            const wrapper = el('div', undefined, parent); wrapper.className = 'selectContainer';
            const caption = el('label', t(label), wrapper); caption.className = 'selectLabel';
            const input = el('select', undefined, wrapper); input.className = 'emby-select emby-select-withcolor'; input.setAttribute('is', 'emby-select');
            input.id = 'je-user-' + groupName + '-' + field; caption.htmlFor = input.id;
            const arrow = el('div', undefined, wrapper); arrow.className = 'selectArrowContainer'; arrow.setAttribute('aria-hidden', 'true');
            el('span', 'expand_more', arrow).className = 'selectArrow material-icons';
            input.dataset.field = field; input.disabled = !!disabled;
            for (const [v, text] of options) { const option = el('option', text, input); option.value = v == null ? '' : String(v); }
            input.value = String(value(state, groupName, field, stored) ?? '');
            input.addEventListener('change', () => changed(state, groupName, field, input.value === '' ? null : input.value, parent));
            return input;
        }
        /** Numeric overrides use blank for inheritance and reject invalid numbers before writing. */
        function number(parent, state, name, field, label, stored, disabled, min) {
            const wrapper = el('div', undefined, parent); wrapper.className = 'inputContainer';
            const caption = el('label', t(label), wrapper); caption.className = 'inputLabel inputLabelUnfocused';
            const input = el('input', undefined, wrapper); input.className = 'emby-input'; input.labelElement = caption; input.setAttribute('is', 'emby-input');
            input.id = 'je-user-' + name + '-' + field; caption.htmlFor = input.id;
            input.type = 'number'; input.min = String(min); input.step = field === 'quotaGb' ? 'any' : '1'; input.disabled = !!disabled;
            input.dataset.field = field; input.value = value(state, name, field, stored) ?? '';
            input.addEventListener('change', () => changed(state, name, field, input.value === '' ? null : Number(input.value), parent));
        }
        /** Links retain native routing ownership. */
        function link(parent, label, href) { const a = el('a', t(label), parent); a.href = href; a.className = 'button-link'; return a; }
        /** Native user tab links depend on the route family, never on translated labels. */
        function tabLink(tab, id) { return JE.arrAdminUserTabs.href(route.family, id, tab); }
        /** Render one vertical form in the native tab's content container. */
        function render(state) {
            if (!route?.enhanced || route.id !== state.data.id || !authorized) return;
            const parent = nativeTabs.update(route);
            if (!parent) return;
            const previous = document.querySelector('[data-je-admin-user]');
            const focused = previous?.contains(document.activeElement) ? document.activeElement.dataset.field : null;
            const detailsOpen = new Set(Array.from(previous?.querySelectorAll('details[open]') || []).map(n => n.closest('[data-group]').dataset.group));
            previous?.remove();
            const d = state.data, section = el('form', undefined, parent);
            section.className = 'je-admin-user'; section.dataset.jeAdminUser = d.id; section.id = 'je-admin-user-panel';
            section.setAttribute('role', 'tabpanel'); section.setAttribute('aria-labelledby', 'je-admin-user-tab');
            section.addEventListener('submit', event => { event.preventDefault(); event.stopPropagation(); saveAll(state); });
            if (d.disabled) help(section, 'disabled');
            const groups = section;
            const policy = group(groups, 'requests', 'policy', state);
            if (!d.policy.available) el('p', t('unavailable'), policy);
            else {
                const stored = d.policy.stored || {}, effective = d.policy.effective || {};
                line(policy, 'backend', d.policy.backend == null ? null : t('backend_' + d.policy.backend));
                line(policy, 'effectiveRole', effective.role == null ? null : t('role_' + effective.role.toLowerCase()));
                if (d.jellyfinAdmin) el('p', t('adminLocked'), policy);
                select(policy, state, 'policy', 'role', 'role', stored.role, [[null, t('defaultRole')], ...(d.policy.roles || []).map(r => [r, t('role_' + r.toLowerCase())])], d.jellyfinAdmin);
                number(policy, state, 'policy', 'quotaLimit', 'count', stored.quotaLimit, d.policy.backend !== 'je', -1);
                number(policy, state, 'policy', 'quotaGb', 'gb', stored.quotaGb, d.policy.backend !== 'je', 0);
                help(policy, 'quotaHelp');
                line(policy, 'effectiveLimit', d.policy.backend === 'je' && d.policy.limit === null ? t('unlimited') : d.policy.limit); line(policy, 'effectiveGb', d.policy.gbLimit);
                line(policy, 'source', d.policy.sources ? [d.policy.sources.count, d.policy.sources.gb].map(s=>t('source_' + s)).join(' / ') : null);
                line(policy, 'movieRights', effective.canRequestMovies); line(policy, 'seriesRights', effective.canRequestSeries); line(policy, 'approvalRights', effective.canApprove);
                line(policy, 'fourKMovies', effective.can4kMovies); line(policy, 'fourKSeries', effective.can4kSeries);
                for (const [label, reason] of [['fourKMoviesBlocking', d.policy.fourKMoviesReason], ['fourKSeriesBlocking', d.policy.fourKSeriesReason]]) {
                    if (reason) line(policy, label, t('restriction_' + (['requests_4k_required', 'feature_disabled', 'not_visible_to_user', 'user_required', 'instance_changed'].includes(reason) ? reason : 'other')));
                }
                if (d.usage.quota?.available) { line(policy, 'quota', `${d.usage.quota.used} / ${d.usage.quota.limit ?? t('unlimited')}`); line(policy, 'estimate', d.usage.quota.usedGb); line(policy, 'nextSlot', d.usage.quota.nextSlotAt); }
                else line(policy, 'quota', null);
                const grants = select(policy, state, 'policy', 'fourKMode', 'fourK', value(state, 'policy', 'fourKInstances', stored.fourKInstances) == null ? null : 'explicit', [[null, t('inherit')], ['explicit', t('explicit')]], d.policy.backend !== 'je');
                grants.addEventListener('change', () => {
                    changed(state, 'policy', 'fourKInstances', grants.value === '' ? null : [], policy);
                    render(state);
                });
                if (value(state, 'policy', 'fourKInstances', stored.fourKInstances) != null) {
                    const list = el('div', undefined, policy); list.className = 'checkboxList paperList'; list.style.padding = '.5em 1em';
                    for (const instance of d.policy.instances || []) {
                        const label = el('label', undefined, list); label.className = 'checkboxContainer emby-checkbox-label';
                        const check = el('input', undefined, label); check.type = 'checkbox'; check.className = 'emby-checkbox'; check.setAttribute('is', 'emby-checkbox'); check.setAttribute('data-embycheckbox', 'true');
                        el('span', instance.name, label).className = 'checkboxLabel';
                        const outline = el('span', undefined, label); outline.className = 'checkboxOutline'; outline.setAttribute('aria-hidden', 'true');
                        el('span', 'check', outline).className = 'material-icons checkboxIcon checkboxIcon-checked';
                        el('span', '', outline).className = 'material-icons checkboxIcon checkboxIcon-unchecked'; check.disabled = d.policy.backend !== 'je';
                        check.checked = value(state, 'policy', 'fourKInstances', stored.fourKInstances).includes(instance.id);
                        check.addEventListener('change', () => {
                            const ids = new Set(value(state, 'policy', 'fourKInstances', stored.fourKInstances));
                            if (check.checked) ids.add(instance.id); else ids.delete(instance.id);
                            changed(state, 'policy', 'fourKInstances', [...ids], policy);
                        });
                    }
                }
            }
            const pool = group(groups, 'pools', 'pool-membership', state);
            if (d.pools.available) {
                select(pool, state, 'pool-membership', 'poolId', 'pool', d.pools.explicit, [[null, t('roleFallback')], ...d.pools.choices.map(p => [p.id, p.name])], d.policy.backend !== 'je');
                line(pool, 'effectivePool', d.pools.effective?.name); help(pool, 'poolHelp');
                if (d.pools.poolUse?.quota) line(pool, 'sharedUsage', `${d.pools.poolUse.quota.used} / ${d.pools.poolUse.quota.limit ?? t('unlimited')}`);
            } else el('p', t('unavailable'), pool);
            const safety = group(groups, 'safety', 'safety', state);
            if (d.safety.alwaysApproval) help(safety, 'kidApproval');
            help(safety, 'safetyHelp');
            link(safety, 'access', tabLink('access', d.id)); link(safety, 'parental', tabLink('parentalcontrol', d.id)); link(safety, 'sharedRules', '#/requests?tab=household');
            if (d.safety.rulesEnabled) help(safety, 'inheritedRules');
            const notify = group(groups, 'notifications', 'notifications', state);
            if (d.notifications.available) {
                line(notify, 'emailVerified', d.notifications.emailVerified); help(notify, 'emailHelp');
                line(notify, 'privacy', d.notifications.hideTitles); line(notify, 'quietHours', d.notifications.quietHours ? `${d.notifications.quietFrom}–${d.notifications.quietTo}` : false);
                const wrapper = el('div', undefined, notify); wrapper.className = 'inputContainer';
                const label = el('label', t('topic'), wrapper); label.className = 'inputLabel inputLabelUnfocused'; label.htmlFor = 'je-user-topic';
                const topic = el('input', undefined, wrapper); topic.id = label.htmlFor; topic.className = 'emby-input'; topic.labelElement = label; topic.setAttribute('is', 'emby-input'); topic.dataset.field = 'topic'; topic.value = value(state, 'notifications', 'topic', d.notifications.topic) || '';
                topic.addEventListener('change', () => changed(state, 'notifications', 'topic', topic.value, notify));
                help(notify, 'topicHelp');
            } else el('p', t('unavailable'), notify);
            const consents = group(groups, 'automation', 'consents', state);
            el('p', t('personalOnly') + ' ' + d.name, consents);
            if (d.consents.available) for (const [field, stored] of Object.entries(d.consents.stored || {})) line(consents, field, stored === null ? t(field === 'listSwapIn' ? 'no' : 'inherit') : t(stored ? 'yes' : 'no'));
            else el('p', t('unavailable'), consents);
            line(consents, 'eligible', d.consents.eligible);
            for (const recipe of d.consents.recipes || []) line(consents, 'recipe_' + recipe.recipe, t(recipe.control.legacy ? 'legacy' : 'mode_' + (recipe.control.effective || 'off')) + (recipe.control.reason ? ' · ' + t('reason_' + recipe.control.reason) : ''));
            if (d.consents.grant) line(consents, 'grant', `${d.consents.grant.source} · ${d.consents.grant.grantedAt}`);
            if (d.consents.lists?.available) line(consents, 'listAttribution', d.consents.lists.items.length);
            // Phase 4f: the person's Ready playlist and TV messages, read-only (only the person turns them on or off).
            const ready = group(groups, 'ready', 'ready', state);
            if (d.ready?.available) {
                el('p', t('readyHelp'), ready);
                line(ready, 'readyPlaylistGate', d.ready.playlistGate); line(ready, 'readyPlaylistStored', d.ready.playlistStored); line(ready, 'readyPlaylistEffective', d.ready.playlistEffective);
                line(ready, 'readyState', t('readyState_' + (['active', 'off', 'deleted', 'removed', 'renew', 'privacy', 'lost'].includes(d.ready.state) ? d.ready.state : 'off')));
                if (d.ready.playlistEffective) line(ready, 'readyEntries', d.ready.entries);
                line(ready, 'readyMessagesGate', d.ready.messagesGate); line(ready, 'readyMessagesStored', d.ready.messagesStored); line(ready, 'readyMessagesEffective', d.ready.messagesEffective);
            } else el('p', t('unavailable'), ready);
            const display = group(groups, 'display', 'display', state);
            if (d.display.available) for (const field of Object.keys(d.display.stored || {})) {
                const input = select(display, state, 'display', field, field, d.display.stored[field] === false ? 'false' : d.display.stored[field] === true ? 'true' : null, [[null, t('inherit')], ['true', t('show')], ['false', t('hide')]], false);
                input.addEventListener('change', () => changed(state, 'display', field, input.value === '' ? null : input.value === 'true', display));
                const details = el('details', undefined, input.closest('.selectContainer')); el('summary', t('showDetails'), details);
                line(details, 'serverGate', d.display.gates?.[field]); line(details, 'effectiveDisplay', d.display.effective?.[field]);
            } else el('p', t('unavailable'), display);
            const seerr = group(groups, 'seerr', 'seerr-import', state);
            line(seerr, 'linkState', t('state_' + d.seerr.state)); line(seerr, 'account', d.seerr.account);
            line(seerr, 'quotaSource', d.seerr.quotaSource == null ? null : t('backend_' + d.seerr.quotaSource));
            const block = select(seerr, state, 'seerr-import', 'blocked', 'blocked', d.seerr.blocked ? 'true' : 'false', [['false', t('no')], ['true', t('yes')]], false);
            block.addEventListener('change', () => changed(state, 'seerr-import', 'blocked', block.value === 'true', seerr));
            help(seerr, 'importHelp');
            if (d.seerr.adminUrl) { const adminLink = link(seerr, 'seerrAdmin', d.seerr.adminUrl); adminLink.target = '_blank'; adminLink.rel = 'noopener noreferrer'; }
            else link(seerr, 'seerrAdmin', '#/configurationpage?name=Jellyfin%20Enhanced');
            for (const details of section.querySelectorAll('details')) if (detailsOpen.has(details.closest('[data-group]').dataset.group)) details.open = true;
            const actions = el('div', undefined, section);
            const save = el('button', t('nativeSave'), actions); save.type = 'submit'; save.className = 'emby-button raised button-submit block'; save.setAttribute('is', 'emby-button'); save.dataset.jeUserSave = '';
            save.disabled = !!state.saving;
            if (focused) Array.from(section.querySelectorAll('[data-field]')).find(n => n.dataset.field === focused)?.focus();

        }
        /** Refresh clean groups and proven own-write transitions; preserve other drafts' conflict baselines. */
        function mergeFresh(state, data, written) {
            const revisions = { ...data.revisions };
            const previous = state.data;
            for (const name of Object.keys(state.changes)) {
                const ownWrite = name === written || (written && Object.hasOwn(data.previousRevisions || {}, name)
                    && data.previousRevisions[name] === previous.revisions[name]);
                if (ownWrite) continue;
                revisions[name] = previous.revisions[name];
                // Keep persisted values paired with their original revision, separate from desired drafts.
                if (name === 'pool-membership') data = { ...data, pools: { ...data.pools, explicit: previous.pools.explicit } };
                else if (name === 'seerr-import') data = { ...data, seerr: { ...data.seerr, blocked: previous.seerr.blocked } };
                else if (name === 'notifications') data = { ...data, notifications: previous.notifications };
                else data = { ...data, [name]: { ...data[name], stored: previous[name].stored } };
            }
            state.data = { ...data, revisions };
        }
        /** Save one draft. Conflicts retain it until reload; other groups stay dirty. */
        async function saveGroup(name, state, changes) {
            if (!authorized || !changes || state.busy.has(name)) return false;
            const gen = generation, epoch = JE.session?.getEpoch?.(), id = state.data.id;
            const revision = state.data.revisions[name];
            state.busy.add(name); state.messages[name] = t('saving'); render(state);
            try {
                const result = name === 'notifications' ? await api.assignTopic(id, changes, request?.signal)
                    : await api.patch(id, name, { revision, ...changes }, request?.signal);
                if (!current(gen, epoch, id)) return;
                if (name === 'notifications') state.data = { ...state.data, notifications: {
                    ...state.data.notifications, ...result, topic: result.topic ?? null, assigned: !!result.topic
                } };
                else {
                    mergeFresh(state, result, name);
                    // Persist the submitted patch; desired fields remain independent until reconciliation.
                    if (name === 'pool-membership') state.data.pools = { ...state.data.pools, explicit: changes.poolId };
                    else if (name === 'seerr-import') state.data.seerr = { ...state.data.seerr, blocked: changes.blocked };
                    else state.data[name] = { ...state.data[name], stored: { ...state.data[name].stored, ...changes } };
                }
                delete state.submitted[name]; reconcile(state, name);
                state.messages[name] = t(state.changes[name] ? 'unsaved' : 'saved');
                return true;
            } catch (error) {
                if (!current(gen, epoch, id)) return;
                if (error.status === 403 || error.status === 401) { clear(true); return; }
                state.messages[name] = t(error.status === 409 ? 'conflict' : 'saveError');
                return false;
            } finally {
                delete state.submitted[name]; reconcile(state, name); state.busy.delete(name);
                if (current(gen, epoch, id)) render(state);
            }
        }
        /** Use Jellyfin's toast service where exported, otherwise its native toast markup and styles. */
        function nativeToast(success, gen, epoch, id) {
            if (typeof window.require === 'function') {
                window.require(['toast', 'globalize'], (toast, globalize) => {
                    if (current(gen, epoch, id)) toast(success ? globalize.translate('SettingsSaved') : t('saveError'));
                });
                return;
            }
            clearTimeout(toastTimer); document.querySelectorAll('[data-je-user-toast]').forEach(n => n.remove());
            const container = el('div', undefined, document.body); container.className = 'toastContainer'; container.dataset.jeUserToast = '';
            const toast = el('div', t(success ? 'settingsSaved' : 'saveError'), container); toast.className = 'toast toastVisible'; toast.setAttribute('role', success ? 'status' : 'alert');
            toastTimer = setTimeout(() => container.remove(), 3300);
        }
        /** Save the submitted drafts sequentially, retaining independent errors and edits made in flight. */
        async function saveAll(state) {
            if (!authorized || state.saving || !Object.keys(state.changes).length) return;
            const submitted = structuredClone(state.changes), gen = generation, epoch = JE.session?.getEpoch?.(), id = state.data.id;
            state.submitted = submitted;
            state.saving = true; let success = true;
            render(state);
            try {
                for (const name of ['policy', 'pool-membership', 'notifications', 'display', 'seerr-import']) {
                    if (!current(gen, epoch, id)) return;
                    if (submitted[name]) success = await saveGroup(name, state, submitted[name]) && success;
                }
                if (!current(gen, epoch, id)) return;
                nativeToast(success, gen, epoch, id);
            } finally {
                state.submitted = {};
                for (const name of Object.keys(state.changes)) reconcile(state, name);
                state.saving = false; if (current(gen, epoch, id)) render(state);
            }
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
                const entry = el('a', t('tab'), chip);
                entry.style.pointerEvents = 'auto';
                entry.style.display = 'block'; entry.style.color = 'inherit'; entry.style.marginTop = '.25em';
                const nativeLink = card.querySelector('a[href*="dashboard/users"]');
                const legacy = typeof ApiClient.serverVersion === 'function' && parseInt(ApiClient.serverVersion(), 10) < 12;
                entry.href = JE.arrAdminUserTabs.href(legacy || /users\/profile\?/.test(nativeLink?.getAttribute('href') || '') ? '10' : '12', id, 'jellyfinenhanced');
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
            nativeTabs.update(route);
            if (!route.enhanced) return;
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
        life.track(() => { stopped = true; cancelAnimationFrame(frame); clear(true); nativeTabs.dispose(); style.remove(); });
        navigate();
    };
    JE.arrAdminUsers = { parseRoute };
})(window.JellyfinEnhanced);
