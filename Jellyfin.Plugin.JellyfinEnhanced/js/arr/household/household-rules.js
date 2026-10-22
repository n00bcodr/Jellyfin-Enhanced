/**
 * @file Requests & downloads, phase 4b: household rules on the Requests page. The administrators' editor the
 * Household tab mounts below its house rules (GET/POST /JellyfinEnhanced/acquire/household/rules): per ruled role
 * (Kid, Member, Trusted) and fixed condition (rating, genre, original language, size estimate, streaming) the
 * condition's parameter and what happens when the title matches it and otherwise; the household streaming country
 * and services (GET .../household/streaming-services); and shared allowances (group pools: name, limit, roles,
 * people, precedence), each with its use in the household window. Save asks for a confirmation, then POSTs only
 * the parts that changed and says how it went. In Seerr mode a read-only panel of Seerr's own rules. Also the
 * plain words of a rule verdict ("Needs a look: rated R (limit PG-13)"), of the rule reasons and of a shared
 * allowance's use, for the Approvals cards, My requests and the request controls. Cards, no wide tables; every
 * control is a real, focusable input, select or button (TV and 420 px friendly). Exposes JE.internals.arrHub.rules.
 */
(function (JE) {
    'use strict';

    const H = (JE.internals = JE.internals || {}).arrHub = JE.internals.arrHub || {};
    const X = H.ext;
    const ROUTE = '/acquire/household/rules';
    const SERVICES = '/acquire/household/streaming-services';
    const ROLES = ['kid', 'member', 'trusted'];
    const CONDITIONS = ['rating', 'genre', 'language', 'size', 'streaming'];
    const ACTIONS = ['none', 'approve', 'review', 'deny'];
    const POOL_ROLES = ['*', 'kid', 'member', 'trusted', 'manager'];
    const COUNTRY = /^[A-Z]{2}$/;
    const LANGUAGE = /^[a-z]{2,3}$/;
    const logPrefix = '🪼 Jellyfin Enhanced: Household rules:';
    /** TMDB's movie and series genres (the server's list), for rule verdicts read without the editor's choices. */
    const GENRES = {
        28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime', 99: 'Documentary', 18: 'Drama', 10751: 'Family',
        14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance', 878: 'Science Fiction',
        10770: 'TV Movie', 53: 'Thriller', 10752: 'War', 37: 'Western', 10759: 'Action & Adventure', 10762: 'Kids', 10763: 'News',
        10764: 'Reality', 10765: 'Sci-Fi & Fantasy', 10766: 'Soap', 10767: 'Talk', 10768: 'War & Politics'
    };

    const tokens = X.intent('household-rules');
    const serviceTokens = X.intent('household-services');
    const state = {
        data: null,
        error: false,
        epoch: null,
        loading: null,
        draft: null,
        open: new Map(),
        confirming: false,
        saving: false,
        result: null,
        stale: false,
        list: { country: '', items: null, status: 'idle' },
        redraw: null,
        people: []
    };

    /**
     * Forgets everything read or edited for another user.
     * @returns {void}
     */
    function resetForUser() {
        if (state.epoch === X.epoch()) return;
        state.epoch = X.epoch();
        state.data = null;
        state.error = false;
        state.loading = null;
        state.draft = null;
        state.open.clear();
        state.confirming = false;
        state.result = null;
        state.stale = false;
        state.list = { country: '', items: null, status: 'idle' };
        tokens.drop();
        serviceTokens.drop();
    }

    /**
     * Asks the Household tab to draw again (it draws this section inside it).
     * @returns {void}
     */
    function redraw() {
        if (typeof state.redraw === 'function') state.redraw();
    }

    /**
     * One condition as the editor holds it: both actions and its parameter, with defaults for what isn't stored.
     * @param {string} condition rating, genre, language, size or streaming.
     * @param {Object|null|undefined} stored Stored condition.
     * @returns {Object} Condition.
     */
    function normalizeCondition(condition, stored) {
        const s = stored && typeof stored === 'object' ? stored : {};
        const out = { match: ACTIONS.includes(s.match) ? s.match : 'none', otherwise: ACTIONS.includes(s.otherwise) ? s.otherwise : 'none' };
        if (condition === 'rating') {
            out.max = typeof s.max === 'string' ? s.max : '';
            out.country = typeof s.country === 'string' && s.country ? s.country.toUpperCase() : 'US';
        } else if (condition === 'genre') {
            out.ids = [...new Set((Array.isArray(s.ids) ? s.ids : []).filter(Number.isInteger))].sort((a, b) => a - b);
        } else if (condition === 'language') {
            out.codes = [...new Set((Array.isArray(s.codes) ? s.codes : []).filter(c => typeof c === 'string').map(c => c.toLowerCase()))].sort();
        } else if (condition === 'size') {
            out.maxGb = typeof s.maxGb === 'number' && Number.isFinite(s.maxGb) ? s.maxGb : 0;
        }
        return out;
    }

    /**
     * The served rules, shaped for editing and comparing: every ruled role with every condition.
     * @param {Object} data Served rules.
     * @returns {Object} Roles.
     */
    function normalizeRoles(data) {
        const served = data?.rules?.roles && typeof data.rules.roles === 'object' ? data.rules.roles : {};
        const lower = {};
        for (const [role, rules] of Object.entries(served)) lower[String(role).toLowerCase()] = rules;
        const roles = {};
        for (const role of ruledRoles(data)) {
            roles[role] = {};
            for (const condition of CONDITIONS) roles[role][condition] = normalizeCondition(condition, lower[role]?.[condition]);
        }
        return roles;
    }

    /**
     * One pool as the editor holds it (roles lower case, people sorted).
     * @param {Object} pool Stored pool.
     * @returns {Object} Pool.
     */
    function normalizePool(pool) {
        return {
            id: String(pool?.id || ''),
            name: typeof pool?.name === 'string' ? pool.name : '',
            limit: Number.isInteger(pool?.limit) ? pool.limit : 1,
            roles: [...new Set((Array.isArray(pool?.roles) ? pool.roles : []).map(r => String(r).toLowerCase()))].sort(),
            users: [...new Set((Array.isArray(pool?.users) ? pool.users : []).map(u => String(u).replace(/-/g, '').toLowerCase()))].sort()
        };
    }

    /**
     * Everything an administrator edits, from what was served.
     * @param {Object} data Served rules.
     * @returns {{roles: Object, country: string, services: number[], pools: Object[]}} Draft.
     */
    function fromServed(data) {
        return {
            roles: normalizeRoles(data),
            country: typeof data?.streamingCountry === 'string' ? data.streamingCountry.toUpperCase() : '',
            services: [...new Set((Array.isArray(data?.streamingServices) ? data.streamingServices : []).filter(Number.isInteger))].sort((a, b) => a - b),
            pools: (Array.isArray(data?.pools) ? data.pools : []).map(normalizePool)
        };
    }

    /**
     * The roles the conditions apply to (the server's list, else Kid, Member and Trusted).
     * @param {Object|null} data Served rules.
     * @returns {string[]} Roles.
     */
    function ruledRoles(data) {
        const listed = Array.isArray(data?.choices?.roles) ? data.choices.roles.map(r => String(r).toLowerCase()).filter(r => ROLES.includes(r)) : [];
        return listed.length ? listed : ROLES;
    }

    /**
     * The parts that differ from what was served (null when nothing does).
     * @returns {{rules: boolean, country: boolean, services: boolean, pools: boolean}|null} Changed parts.
     */
    function changes() {
        if (!state.data || !state.draft) return null;
        const served = fromServed(state.data);
        const d = state.draft;
        const pools = d.pools.map(p => ({ ...p, roles: [...p.roles].sort(), users: [...p.users].sort() }));
        const changed = {
            rules: JSON.stringify(d.roles) !== JSON.stringify(served.roles),
            country: d.country.trim().toUpperCase() !== served.country,
            services: JSON.stringify([...d.services].sort((a, b) => a - b)) !== JSON.stringify(served.services),
            pools: JSON.stringify(pools) !== JSON.stringify(served.pools)
        };
        return Object.values(changed).some(Boolean) ? changed : null;
    }

    /**
     * True when there are unsaved edits.
     * @returns {boolean} Dirty.
     */
    function dirty() {
        return changes() !== null;
    }

    /**
     * Drops unsaved edits.
     * @returns {void}
     */
    function discard() {
        state.draft = state.data ? fromServed(state.data) : null;
        state.confirming = false;
    }

    /**
     * Reads the rules under a fresh intent token (only the current token's answer is shown).
     * @returns {Promise<void>}
     */
    function load() {
        resetForUser();
        const token = tokens.next();
        const run = (async () => {
            const answer = await X.call(ROUTE);
            if (!tokens.isCurrent(token)) return;
            if (state.loading === run) state.loading = null;
            if (answer.status === 200 && answer.body && typeof answer.body === 'object') {
                state.data = answer.body;
                state.error = false;
                state.stale = false;
                state.draft = fromServed(answer.body);
                state.confirming = false;
            } else {
                state.error = true;
                console.warn(`${logPrefix} could not load (${answer.status || 'no answer'})`);
            }
            redraw();
        })();
        state.loading = run;
        return run;
    }

    /**
     * The household changed on the server: read again, unless an administrator is editing (then say so instead).
     * @returns {void}
     */
    function changed() {
        resetForUser();
        if (!state.data && !state.loading) return;
        if (dirty() || state.saving) {
            state.stale = true;
            return;
        }
        load();
    }

    /**
     * An edit happened: any earlier confirmation or outcome no longer applies.
     * @param {boolean} [draw] Draw again now.
     * @returns {void}
     */
    function edited(draw) {
        state.confirming = false;
        state.result = null;
        if (draw) redraw();
    }

    /**
     * A labelled field (words above the control).
     * @param {string} text Label words.
     * @param {HTMLElement} control Control.
     * @returns {HTMLElement} Field.
     */
    function field(text, control) {
        const label = X.el('label', 'je-household-field');
        label.appendChild(X.el('span', 'je-household-field-label', text));
        label.appendChild(control);
        return label;
    }

    /**
     * A select from fixed choices.
     * @param {Array<[string, string]>} choices Value and words.
     * @param {string} value Current value.
     * @param {string} focusId Focus id.
     * @param {string} label Accessible label.
     * @param {function(string): void} onChange Called with the new value.
     * @returns {HTMLSelectElement} Select.
     */
    function select(choices, value, focusId, label, onChange) {
        const node = document.createElement('select');
        node.className = 'je-household-select';
        node.dataset.jeFocus = focusId;
        node.setAttribute('aria-label', label);
        for (const [v, text] of choices) {
            const option = document.createElement('option');
            option.value = v;
            option.textContent = text;
            node.appendChild(option);
        }
        node.value = value;
        node.addEventListener('change', () => onChange(node.value));
        return node;
    }

    /**
     * A text or number input. Typing updates the draft without a redraw (the caret stays); leaving it (change) draws.
     * @param {string} type text or number.
     * @param {string} value Current value.
     * @param {string} focusId Focus id.
     * @param {string} label Accessible label.
     * @param {function(string): void} onInput Called with the typed value.
     * @param {Object} [attrs] Extra attributes (maxlength, min, max, step, inputmode).
     * @returns {HTMLInputElement} Input.
     */
    function input(type, value, focusId, label, onInput, attrs) {
        const node = document.createElement('input');
        node.type = type;
        node.className = 'je-rules-input';
        node.value = value;
        node.dataset.jeFocus = focusId;
        node.setAttribute('aria-label', label);
        for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, String(v));
        node.addEventListener('input', () => {
            onInput(node.value);
            edited(false);
        });
        node.addEventListener('change', () => redraw());
        // Keys typed here are for the field, not the page's shortcuts.
        node.addEventListener('keydown', e => e.stopPropagation());
        return node;
    }

    /**
     * A checkbox with its words.
     * @param {string} text Words.
     * @param {boolean} checked Checked.
     * @param {string} focusId Focus id.
     * @param {function(boolean): void} onChange Called with the new state.
     * @returns {HTMLLabelElement} Labelled checkbox.
     */
    function checkbox(text, checked, focusId, onChange) {
        const label = X.el('label', 'je-rules-check');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = checked;
        box.dataset.jeFocus = focusId;
        box.addEventListener('change', () => {
            onChange(box.checked);
            edited(true);
        });
        label.appendChild(box);
        label.appendChild(X.el('span', null, text));
        return label;
    }

    /**
     * A role's words.
     * @param {string} role kid, member, trusted, manager or *.
     * @returns {string} Text.
     */
    function roleText(role) {
        if (role === 'trusted') return X.tr('arr_rules_role_trusted');
        if (role === '*') return X.tr('arr_rules_pool_everyone');
        return X.tr(`arr_approvals_role_${['kid', 'member', 'manager', 'watcher', 'admin'].includes(role) ? role : 'member'}`);
    }

    /**
     * The genre choices: the server's (id, name), else the built-in list.
     * @returns {Array<{id: number, name: string}>} Genres.
     */
    function genreChoices() {
        const served = Array.isArray(state.data?.choices?.genres) ? state.data.choices.genres.filter(g => Number.isInteger(g?.id)) : [];
        if (served.length) return served.map(g => ({ id: g.id, name: String(g.name || g.id) }));
        return Object.entries(GENRES).map(([id, name]) => ({ id: Number(id), name })).sort((a, b) => a.name.localeCompare(b.name));
    }

    /**
     * A genre's name by TMDB id.
     * @param {number|string} id Genre id.
     * @returns {string} Name.
     */
    function genreName(id) {
        const n = Number(id);
        const served = Array.isArray(state.data?.choices?.genres) ? state.data.choices.genres.find(g => g?.id === n) : null;
        return served?.name ? String(served.name) : GENRES[n] || String(id);
    }

    /**
     * A language's name in the reader's language ("French"), else its code.
     * @param {string} code ISO 639-1 code.
     * @returns {string} Name.
     */
    function languageName(code) {
        const value = String(code || '').trim();
        if (!value) return '';
        try {
            const locale = (typeof document !== 'undefined' && document.documentElement.lang) || (typeof navigator !== 'undefined' && navigator.language) || 'en';
            const name = typeof Intl !== 'undefined' && Intl.DisplayNames ? new Intl.DisplayNames([locale], { type: 'language' }).of(value) : '';
            return name && name !== value ? name : value;
        } catch {
            return value;
        }
    }

    /**
     * One condition's editor: its parameter, the two actions and what matching means.
     * @param {string} role Ruled role.
     * @param {string} condition Condition.
     * @returns {HTMLElement} Fieldset.
     */
    function conditionEditor(role, condition) {
        const rule = state.draft.roles[role][condition];
        const box = X.el('fieldset', 'je-rules-cond');
        box.dataset.condition = condition;
        const name = X.tr(`arr_rules_cond_${condition}`);
        box.appendChild(X.el('legend', 'je-rules-cond-title', name));
        box.appendChild(X.el('div', 'je-household-help', X.tr(`arr_rules_cond_${condition}_help`)));
        const id = `rules:${role}:${condition}`;
        const words = text => X.tr('arr_rules_field_for', { role: roleText(role), condition: name, field: text });
        const params = X.el('div', 'je-rules-params');
        if (condition === 'rating') {
            params.appendChild(field(X.tr('arr_rules_rating_max'), input('text', rule.max, `${id}:max`, words(X.tr('arr_rules_rating_max')), (v) => { rule.max = v.trim(); }, { maxlength: 20, autocomplete: 'off' })));
            params.appendChild(field(X.tr('arr_rules_rating_country'), input('text', rule.country, `${id}:country`, words(X.tr('arr_rules_rating_country')), (v) => { rule.country = v.trim().toUpperCase(); }, { maxlength: 2, autocomplete: 'off', size: 4 })));
        } else if (condition === 'genre') {
            const list = X.el('div', 'je-rules-checks');
            list.setAttribute('role', 'group');
            list.setAttribute('aria-label', words(X.tr('arr_rules_genres')));
            for (const genre of genreChoices()) {
                list.appendChild(checkbox(genre.name, rule.ids.includes(genre.id), `${id}:g${genre.id}`, (on) => {
                    rule.ids = on ? [...new Set([...rule.ids, genre.id])].sort((a, b) => a - b) : rule.ids.filter(g => g !== genre.id);
                }));
            }
            params.appendChild(list);
        } else if (condition === 'language') {
            params.appendChild(field(X.tr('arr_rules_languages'), input('text', rule.codes.join(', '), `${id}:codes`, words(X.tr('arr_rules_languages')), (v) => {
                rule.codes = [...new Set(v.toLowerCase().split(/[\s,;]+/).filter(c => LANGUAGE.test(c)))].sort();
            }, { autocomplete: 'off' })));
        } else if (condition === 'size') {
            params.appendChild(field(X.tr('arr_rules_size_max'), input('number', rule.maxGb ? String(rule.maxGb) : '', `${id}:gb`, words(X.tr('arr_rules_size_max')), (v) => {
                const n = parseFloat(v);
                rule.maxGb = Number.isFinite(n) ? n : 0;
            }, { min: 0.1, max: 100000, step: 0.1, inputmode: 'decimal' })));
        }
        if (params.childNodes.length) box.appendChild(params);
        const actions = X.el('div', 'je-rules-actions');
        const choices = ACTIONS.map(a => [a, X.tr(`arr_rules_action_${a}`)]);
        for (const [part, key] of [['match', 'arr_rules_when_match'], ['otherwise', 'arr_rules_otherwise']]) {
            actions.appendChild(field(X.tr(key), select(choices, rule[part], `${id}:${part}`, words(X.tr(key)), (v) => {
                rule[part] = v;
                edited(true);
            })));
        }
        box.appendChild(actions);
        return box;
    }

    /**
     * How many of a role's conditions do something.
     * @param {Object} conditions The role's conditions.
     * @returns {number} Count.
     */
    function activeCount(conditions) {
        return CONDITIONS.filter(c => conditions[c].match !== 'none' || conditions[c].otherwise !== 'none').length;
    }

    /**
     * One ruled role: a disclosure with its conditions (open when one of them does something, or as left).
     * @param {string} role Ruled role.
     * @returns {HTMLElement} Details.
     */
    function roleEditor(role) {
        const conditions = state.draft.roles[role];
        const details = X.el('details', 'je-rules-role');
        details.dataset.role = role;
        const n = activeCount(conditions);
        details.open = state.open.has(role) ? state.open.get(role) : n > 0;
        const summary = X.el('summary', 'je-rules-role-summary', n ? X.tr('arr_rules_role_summary', { role: roleText(role), n }) : X.tr('arr_rules_role_summary_none', { role: roleText(role) }));
        summary.dataset.jeFocus = `rules:${role}:open`;
        details.appendChild(summary);
        details.addEventListener('toggle', () => state.open.set(role, details.open));
        for (const condition of CONDITIONS) details.appendChild(conditionEditor(role, condition));
        return details;
    }

    /**
     * Reads the streaming services TMDB lists for the country typed in.
     * @returns {Promise<void>}
     */
    async function loadServices() {
        const country = state.draft.country.trim().toUpperCase();
        if (!COUNTRY.test(country)) {
            state.list = { country, items: null, status: 'invalid' };
            redraw();
            return;
        }
        const token = serviceTokens.next({ query: country });
        state.list = { country, items: null, status: 'loading' };
        redraw();
        const answer = await X.call(`${SERVICES}?country=${encodeURIComponent(country)}`);
        if (!serviceTokens.isCurrent(token)) return;
        const items = answer.status === 200 && Array.isArray(answer.body?.services)
            ? answer.body.services.filter(s => Number.isInteger(s?.id) && s.id > 0).map(s => ({ id: s.id, name: String(s.name || s.id) }))
            : null;
        state.list = { country, items, status: items ? 'done' : 'failed' };
        redraw();
    }

    /**
     * The household streaming country and services.
     * @returns {HTMLElement} Section.
     */
    function streamingEditor() {
        const d = state.draft;
        const section = X.el('section', 'je-rules-block je-rules-streaming');
        section.appendChild(X.el('h3', 'je-rules-block-title', X.tr('arr_rules_streaming_title')));
        section.appendChild(X.el('div', 'je-household-help', X.tr('arr_rules_streaming_help')));
        const row = X.el('div', 'je-rules-params');
        row.appendChild(field(X.tr('arr_rules_streaming_country'), input('text', d.country, 'rules:streaming:country', X.tr('arr_rules_streaming_country'), (v) => { d.country = v.trim().toUpperCase(); }, { maxlength: 2, autocomplete: 'off', size: 4 })));
        const load = X.button('je-hub-btn je-rules-load', X.tr(state.list.status === 'loading' ? 'arr_rules_streaming_loading' : 'arr_rules_streaming_load'), 'refresh', 'rules:streaming:load');
        X.busy(load, state.list.status === 'loading');
        load.addEventListener('click', () => { if (state.list.status !== 'loading') loadServices(); });
        row.appendChild(load);
        section.appendChild(row);
        const shown = state.list.status === 'done' && state.list.country === d.country.trim().toUpperCase() ? state.list.items : null;
        if (state.list.status === 'invalid') section.appendChild(X.el('div', 'je-hub-note je-hub-note-warn', X.tr('arr_rules_streaming_invalid_country')));
        else if (state.list.status === 'failed') section.appendChild(X.el('div', 'je-hub-note je-hub-note-warn', X.tr('arr_rules_streaming_failed')));
        if (shown) {
            if (!shown.length && !d.services.length) section.appendChild(X.el('div', 'je-household-help', X.tr('arr_rules_streaming_none')));
            const list = X.el('div', 'je-rules-checks');
            list.setAttribute('role', 'group');
            list.setAttribute('aria-label', X.tr('arr_rules_streaming_title'));
            // Chosen services the list doesn't name any more stay listed, so they can be unticked.
            const all = [...shown, ...d.services.filter(id => !shown.some(s => s.id === id)).map(id => ({ id, name: X.tr('arr_rules_streaming_unknown', { id }) }))];
            for (const service of all) {
                list.appendChild(checkbox(service.name, d.services.includes(service.id), `rules:streaming:s${service.id}`, (on) => {
                    d.services = on ? [...new Set([...d.services, service.id])].sort((a, b) => a - b) : d.services.filter(s => s !== service.id);
                }));
            }
            section.appendChild(list);
        } else if (d.services.length) {
            section.appendChild(X.el('div', 'je-household-help', X.tr('arr_rules_streaming_chosen', { n: d.services.length })));
        }
        return section;
    }

    /**
     * A new pool id the list doesn't use yet.
     * @returns {string} Id.
     */
    function newPoolId() {
        const used = new Set(state.draft.pools.map(p => p.id.toLowerCase()));
        let id;
        do {
            id = `pool-${Math.random().toString(36).slice(2, 10)}`;
        } while (used.has(id));
        return id;
    }

    /**
     * One shared allowance's card: name, limit, use, roles, people, precedence and Remove.
     * @param {Object} pool Pool (draft).
     * @param {number} index Its place in the list.
     * @param {number} count How many pools there are.
     * @returns {HTMLElement} Card.
     */
    function poolEditor(pool, index, count) {
        const d = state.draft;
        const days = state.data?.windowDays || 7;
        const card = X.el('article', 'je-rules-pool');
        card.dataset.poolId = pool.id;
        const name = pool.name.trim() || X.tr('arr_rules_pool_default_name', { n: index + 1 });
        const named = what => X.tr('arr_rules_pool_label', { name, what });
        const id = `rules:pool:${pool.id}`;
        const head = X.el('div', 'je-rules-params');
        head.appendChild(field(X.tr('arr_rules_pool_name'), input('text', pool.name, `${id}:name`, named(X.tr('arr_rules_pool_name')), (v) => { pool.name = v; }, { maxlength: 60, autocomplete: 'off' })));
        head.appendChild(field(X.tr('arr_rules_pool_limit', { days }), input('number', String(pool.limit), `${id}:limit`, named(X.tr('arr_rules_pool_limit', { days })), (v) => {
            const n = parseInt(v, 10);
            pool.limit = Number.isFinite(n) ? n : 0;
        }, { min: 1, max: 10000, step: 1, inputmode: 'numeric' })));
        card.appendChild(head);
        const served = Array.isArray(state.data?.pools) ? state.data.pools.find(p => p?.id === pool.id) : null;
        const use = served && typeof served.used === 'number'
            ? X.tr('arr_rules_pool_used', { used: served.used, limit: pool.limit, days })
            : served ? '' : X.tr('arr_rules_pool_new');
        if (use) card.appendChild(X.el('div', 'je-approval-meta je-rules-pool-use', use));

        const roles = X.el('fieldset', 'je-rules-cond');
        roles.appendChild(X.el('legend', 'je-rules-cond-title', X.tr('arr_rules_pool_roles')));
        const roleList = X.el('div', 'je-rules-checks');
        const poolRoles = Array.isArray(state.data?.choices?.poolRoles) && state.data.choices.poolRoles.length
            ? state.data.choices.poolRoles.map(r => String(r).toLowerCase()).filter(r => POOL_ROLES.includes(r)) : POOL_ROLES;
        for (const role of poolRoles) {
            roleList.appendChild(checkbox(roleText(role), pool.roles.includes(role), `${id}:role:${role}`, (on) => {
                pool.roles = on ? [...new Set([...pool.roles, role])].sort() : pool.roles.filter(r => r !== role);
            }));
        }
        roles.appendChild(roleList);
        card.appendChild(roles);

        const people = X.el('fieldset', 'je-rules-cond');
        people.appendChild(X.el('legend', 'je-rules-cond-title', X.tr('arr_rules_pool_people')));
        const pickable = state.people.filter(p => p && typeof p.id === 'string' && p.role !== 'admin' && !p.admin?.jellyfinAdmin);
        const personList = X.el('div', 'je-rules-checks');
        for (const person of pickable) {
            const key = person.id.toLowerCase();
            personList.appendChild(checkbox(person.name || X.tr('arr_approvals_someone'), pool.users.includes(key), `${id}:user:${key}`, (on) => {
                pool.users = on ? [...new Set([...pool.users, key])].sort() : pool.users.filter(u => u !== key);
            }));
        }
        people.appendChild(personList);
        const others = pool.users.filter(u => !pickable.some(p => p.id.toLowerCase() === u)).length;
        if (others) people.appendChild(X.el('div', 'je-household-help', X.tr('arr_rules_pool_others', { n: others })));
        card.appendChild(people);

        const actions = X.el('div', 'je-rules-pool-actions');
        const move = (delta) => {
            const at = d.pools.indexOf(pool);
            const to = at + delta;
            if (at < 0 || to < 0 || to >= d.pools.length) return;
            d.pools.splice(at, 1);
            d.pools.splice(to, 0, pool);
            edited(true);
        };
        if (index > 0) {
            const up = X.button('je-hub-btn', X.tr('arr_rules_pool_up'), 'arrow_upward', `${id}:up`);
            up.setAttribute('aria-label', named(X.tr('arr_rules_pool_up')));
            up.addEventListener('click', () => move(-1));
            actions.appendChild(up);
        }
        if (index < count - 1) {
            const down = X.button('je-hub-btn', X.tr('arr_rules_pool_down'), 'arrow_downward', `${id}:down`);
            down.setAttribute('aria-label', named(X.tr('arr_rules_pool_down')));
            down.addEventListener('click', () => move(1));
            actions.appendChild(down);
        }
        const remove = X.button('je-hub-btn je-hub-cancel', X.tr('arr_rules_pool_remove'), 'delete', `${id}:remove`);
        remove.setAttribute('aria-label', named(X.tr('arr_rules_pool_remove')));
        remove.addEventListener('click', () => {
            d.pools = d.pools.filter(p => p !== pool);
            edited(true);
            // The card is gone: focus goes to Add (the tab drew again right away).
            document.querySelector('[data-je-focus="rules:pool:add"]')?.focus();
        });
        actions.appendChild(remove);
        card.appendChild(actions);
        return card;
    }

    /**
     * The shared allowances (only while group quotas are on).
     * @returns {HTMLElement} Section.
     */
    function poolsEditor() {
        const d = state.draft;
        const section = X.el('section', 'je-rules-block je-rules-pools');
        section.appendChild(X.el('h3', 'je-rules-block-title', X.tr('arr_rules_pools_title')));
        section.appendChild(X.el('div', 'je-household-help', X.tr('arr_rules_pools_help')));
        if (!d.pools.length) section.appendChild(X.el('div', 'je-household-help', X.tr('arr_rules_pools_empty')));
        const list = X.el('div', 'je-rules-pool-list');
        d.pools.forEach((pool, i) => list.appendChild(poolEditor(pool, i, d.pools.length)));
        section.appendChild(list);
        if (d.pools.length < 20) {
            const add = X.button('je-hub-btn', X.tr('arr_rules_pool_add'), 'add', 'rules:pool:add');
            add.addEventListener('click', () => {
                const id = newPoolId();
                d.pools.push({ id, name: X.tr('arr_rules_pool_default_name', { n: d.pools.length + 1 }), limit: 7, roles: [], users: [] });
                edited(true);
                // The tab drew again right away: focus moves to the new pool's name.
                document.querySelector(`[data-je-focus="rules:pool:${id}:name"]`)?.focus();
            });
            section.appendChild(add);
        }
        return section;
    }

    /**
     * The conditions of one role as the server stores them: the conditions that do something or have a parameter.
     * @param {Object} conditions The role's draft conditions.
     * @returns {Object|null} Stored conditions (null: none).
     */
    function storedRole(conditions) {
        const out = {};
        for (const condition of CONDITIONS) {
            const rule = conditions[condition];
            const active = rule.match !== 'none' || rule.otherwise !== 'none';
            const param = condition === 'rating' ? !!rule.max : condition === 'genre' ? rule.ids.length > 0 : condition === 'language' ? rule.codes.length > 0 : condition === 'size' ? rule.maxGb > 0 : false;
            if (!active && !param) continue;
            const stored = { match: rule.match, otherwise: rule.otherwise };
            if (condition === 'rating') Object.assign(stored, { max: rule.max, country: rule.country });
            else if (condition === 'genre') stored.ids = [...rule.ids];
            else if (condition === 'language') stored.codes = [...rule.codes];
            else if (condition === 'size') stored.maxGb = rule.maxGb;
            out[condition] = stored;
        }
        return Object.keys(out).length ? out : null;
    }

    /**
     * The save body: only the parts that changed (the rules and the pools as whole lists, as the server replaces them).
     * @returns {Object} Body.
     */
    function saveBody() {
        const parts = changes();
        const body = {};
        if (!parts) return body;
        const d = state.draft;
        if (parts.rules) {
            const roles = {};
            for (const role of Object.keys(d.roles)) {
                const stored = storedRole(d.roles[role]);
                if (stored) roles[role] = stored;
            }
            body.rules = { roles };
        }
        if (parts.country) body.streamingCountry = d.country.trim().toUpperCase();
        if (parts.services) body.streamingServices = [...d.services];
        if (parts.pools) body.pools = d.pools.map(p => ({ id: p.id, name: p.name.trim(), limit: p.limit, roles: [...p.roles], users: [...p.users] }));
        return body;
    }

    /**
     * Why the draft can't be saved as it is (an invalid_* code like the server's), or null.
     * @returns {string|null} Code.
     */
    function problem() {
        const d = state.draft;
        for (const conditions of Object.values(d.roles)) {
            for (const condition of CONDITIONS) {
                const rule = conditions[condition];
                if (rule.match === 'none' && rule.otherwise === 'none') continue;
                if (condition === 'rating' && (!rule.max.trim() || !COUNTRY.test(rule.country))) return 'invalid_rating';
                if (condition === 'genre' && !rule.ids.length) return 'invalid_genre';
                if (condition === 'language' && !rule.codes.length) return 'invalid_language';
                if (condition === 'size' && !(rule.maxGb >= 0.1 && rule.maxGb <= 100000)) return 'invalid_size';
            }
        }
        if (d.country.trim() && !COUNTRY.test(d.country.trim().toUpperCase())) return 'invalid_country';
        for (const pool of d.pools) {
            if (!pool.name.trim() || pool.name.trim().length > 60) return 'invalid_pool_name';
            if (!(Number.isInteger(pool.limit) && pool.limit >= 1 && pool.limit <= 10000)) return 'invalid_pool_limit';
            if (!pool.roles.length && !pool.users.length) return 'invalid_pool_members';
        }
        return null;
    }

    /** Refusal codes with words of their own. */
    const INVALID = new Set(['invalid_rating', 'invalid_genre', 'invalid_language', 'invalid_size', 'invalid_country', 'invalid_pool_name', 'invalid_pool_limit', 'invalid_pool_members']);

    /**
     * Saves the changes (after the confirmation) and says how it went; reads the rules again.
     * @returns {Promise<void>}
     */
    async function save(origin) {
        // The save's origin (the confirming click): sent, and its answer shown, in that session only.
        origin = JE.core.userWrite.originOf(origin);
        if (state.saving || !dirty()) return;
        const local = problem();
        if (local) {
            state.result = { text: X.tr(`arr_rules_${local}`), tone: 'attention' };
            state.confirming = false;
            redraw();
            return;
        }
        const body = saveBody();
        state.saving = true;
        redraw();
        const answer = await X.call(ROUTE, { method: 'POST', body, session: origin });
        state.saving = false;
        if (!JE.core.userWrite.isBound(origin)) return;
        const ok = answer.status === 200;
        const code = typeof answer.body?.reason === 'string' ? answer.body.reason : '';
        let text;
        if (ok) text = X.tr('arr_rules_saved');
        else if (X.unconfirmed(answer)) text = X.tr('arr_write_unconfirmed');
        else if (answer.status === 400) text = INVALID.has(code) ? X.tr(`arr_rules_${code}`) : X.tr('arr_rules_invalid');
        else if (answer.status === 409 && code === 'rules_seerr_owned') text = X.tr('arr_rules_save_seerr');
        else if (answer.status === 403 && code === 'feature_disabled' && body.pools) text = X.tr('arr_rules_save_pools_off');
        else if (answer.status === 403) text = X.tr('arr_rules_save_denied');
        else text = X.tr('arr_rules_save_failed');
        if (!ok && code) text = X.tr('arr_approvals_result_code', { text, code });
        state.result = { text, tone: ok ? 'done' : 'attention' };
        state.confirming = false;
        redraw();
        if (ok) load();
    }

    /**
     * The save bar (unsaved edits, or a save outcome to show).
     * @returns {HTMLElement|null} Bar.
     */
    function saveBar() {
        const isDirty = dirty();
        if (!isDirty && !state.result) return null;
        const bar = X.el('div', 'je-household-save je-rules-save');
        bar.setAttribute('role', 'region');
        bar.setAttribute('aria-label', X.tr('arr_rules_save'));
        if (state.result) {
            const line = X.el('div', `je-approval-result je-approvals-tone-${state.result.tone}`, state.result.text);
            line.setAttribute('role', 'status');
            bar.appendChild(line);
        }
        if (!isDirty) return bar;
        if (state.confirming) {
            bar.appendChild(X.el('div', 'je-household-confirm', X.tr('arr_rules_confirm')));
            const yes = X.button('je-approval-btn je-approval-approve', X.tr('arr_rules_confirm_yes'), 'check', 'rules:confirm');
            X.busy(yes, state.saving);
            yes.addEventListener('click', () => save());
            const back = X.button('je-hub-btn', X.tr('arr_rules_confirm_no'), null, 'rules:keep-editing');
            X.busy(back, state.saving);
            back.addEventListener('click', () => { if (!state.saving) { state.confirming = false; redraw(); } });
            bar.appendChild(yes);
            bar.appendChild(back);
        } else {
            const saveButton = X.button('je-approval-btn je-approval-approve', X.tr('arr_rules_save'), 'save', 'rules:save');
            saveButton.addEventListener('click', () => { state.confirming = true; state.result = null; redraw(); });
            const reset = X.button('je-hub-btn', X.tr('arr_rules_discard'), 'undo', 'rules:discard');
            reset.addEventListener('click', () => {
                discard();
                state.result = null;
                if (state.stale) load();
                else redraw();
            });
            bar.appendChild(saveButton);
            bar.appendChild(reset);
        }
        return bar;
    }

    /**
     * A comma list from a Seerr value (a "1,2" string or an array), each item through `name`.
     * @param {*} value Value.
     * @param {function(string): string} [name] Turns an item into words.
     * @returns {string} List ('' when empty).
     */
    function seerrList(value, name) {
        const items = (Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,|]/) : typeof value === 'number' ? [value] : [])
            .map(v => String(v).trim()).filter(Boolean).slice(0, 30);
        return items.map(v => (name ? name(v) : v)).join(', ');
    }

    /**
     * One Seerr override rule in words: what it applies to and what it sets.
     * @param {Object} rule Seerr's rule object (as Seerr describes it).
     * @param {number} n Its number.
     * @returns {HTMLElement} Item.
     */
    function seerrRule(rule, n) {
        const item = X.el('li', 'je-rules-seerr-rule');
        item.appendChild(X.el('div', 'je-rules-seerr-rule-title', X.tr('arr_rules_seerr_rule', { n })));
        const r = rule && typeof rule === 'object' ? rule : {};
        const matches = [];
        const genres = seerrList(r.genre, genreName);
        if (genres) matches.push(X.tr('arr_rules_seerr_part_genre', { list: genres }));
        const languages = seerrList(r.language, languageName);
        if (languages) matches.push(X.tr('arr_rules_seerr_part_language', { list: languages }));
        const keywords = seerrList(r.keywords);
        if (keywords) matches.push(X.tr('arr_rules_seerr_part_keywords', { list: keywords }));
        const users = seerrList(r.users);
        if (users) matches.push(X.tr('arr_rules_seerr_part_users', { list: users }));
        item.appendChild(X.el('div', 'je-approval-meta', matches.length ? X.tr('arr_rules_seerr_rule_matches', { list: matches.join(' · ') }) : X.tr('arr_rules_seerr_rule_any')));
        const sets = [];
        const scalar = v => (typeof v === 'number' || (typeof v === 'string' && v.trim()) ? String(v).trim() : '');
        if (scalar(r.radarrServiceId)) sets.push(X.tr('arr_rules_seerr_part_radarr', { value: scalar(r.radarrServiceId) }));
        if (scalar(r.sonarrServiceId)) sets.push(X.tr('arr_rules_seerr_part_sonarr', { value: scalar(r.sonarrServiceId) }));
        if (scalar(r.profileId)) sets.push(X.tr('arr_rules_seerr_part_profile', { value: scalar(r.profileId) }));
        if (scalar(r.rootFolder)) sets.push(X.tr('arr_rules_seerr_part_folder', { value: scalar(r.rootFolder) }));
        const tags = seerrList(r.tags);
        if (tags) sets.push(X.tr('arr_rules_seerr_part_tags', { list: tags }));
        item.appendChild(X.el('div', 'je-approval-meta', sets.length ? X.tr('arr_rules_seerr_rule_sets', { list: sets.join(' · ') }) : X.tr('arr_rules_seerr_rule_sets_nothing')));
        return item;
    }

    /**
     * A Seerr default quota in words ("5 every 7 days", "No limit", "Not known").
     * @param {{limit: number|null, days: number|null}|null|undefined} quota Quota.
     * @returns {string} Text.
     */
    function seerrQuota(quota) {
        if (!quota || typeof quota !== 'object') return X.tr('arr_rules_unknown');
        if (!(typeof quota.limit === 'number' && quota.limit > 0)) return X.tr('arr_rules_seerr_quota_none');
        return X.tr('arr_rules_seerr_quota_value', { limit: quota.limit, days: typeof quota.days === 'number' && quota.days > 0 ? quota.days : '?' });
    }

    /**
     * Seerr mode: Seerr's own rules, read-only (override rules summarized; what isn't known says so).
     * @param {Object|null} seerr Served Seerr part.
     * @returns {HTMLElement} Section.
     */
    function seerrPanel(seerr) {
        const section = X.el('section', 'je-rules-block je-rules-seerr');
        section.appendChild(X.el('h3', 'je-rules-block-title', X.tr('arr_rules_seerr_title')));
        section.appendChild(X.el('div', 'je-household-help', X.tr('arr_rules_seerr_intro')));
        if (!seerr || seerr.available !== true) {
            section.appendChild(X.el('div', 'je-hub-note je-hub-note-warn', X.tr('arr_rules_seerr_unavailable')));
            return section;
        }
        const auto = seerr.autoApprove === true ? X.tr('arr_rules_yes') : seerr.autoApprove === false ? X.tr('arr_rules_no') : X.tr('arr_rules_unknown');
        section.appendChild(X.el('div', 'je-approval-meta', X.tr('arr_rules_seerr_auto', { value: auto })));
        section.appendChild(X.el('div', 'je-approval-meta', X.tr('arr_rules_seerr_movie_quota', { value: seerrQuota(seerr.movieQuota) })));
        section.appendChild(X.el('div', 'je-approval-meta', X.tr('arr_rules_seerr_tv_quota', { value: seerrQuota(seerr.tvQuota) })));
        section.appendChild(X.el('h4', 'je-rules-cond-title', X.tr('arr_rules_seerr_overrides')));
        if (!Array.isArray(seerr.overrideRules)) section.appendChild(X.el('div', 'je-household-help', X.tr('arr_rules_seerr_overrides_unknown')));
        else if (!seerr.overrideRules.length) section.appendChild(X.el('div', 'je-household-help', X.tr('arr_rules_seerr_overrides_none')));
        else {
            const list = X.el('ul', 'je-rules-seerr-list');
            seerr.overrideRules.forEach((rule, i) => list.appendChild(seerrRule(rule, i + 1)));
            section.appendChild(list);
        }
        return section;
    }

    /**
     * The section the Household tab shows administrators below its house rules while household rules are on: the
     * editor (Jellyfin Enhanced handling), Seerr's rules read-only (Seerr handling), or a line saying they don't apply.
     * @param {{people?: Object[], redraw?: Function}} context The household's people and how to draw the tab again.
     * @returns {HTMLElement} Section.
     */
    function section(context) {
        resetForUser();
        injectStyles();
        state.redraw = context?.redraw || null;
        state.people = Array.isArray(context?.people) ? context.people : [];
        const box = X.el('section', 'je-household-rules je-rules');
        box.appendChild(X.el('h2', 'je-hub-group-title', X.tr('arr_rules_title')));
        if (!state.data) {
            if (!state.loading && !state.error) load();
            const empty = X.el('div', 'je-hub-empty', X.tr(state.error ? 'arr_rules_error' : 'arr_rules_loading'));
            if (state.error) {
                const retry = X.button('je-hub-btn', X.tr('arr_approvals_retry'), 'refresh', 'rules:retry');
                retry.addEventListener('click', () => { state.error = false; load(); redraw(); });
                empty.appendChild(retry);
            }
            box.appendChild(empty);
            return box;
        }
        const data = state.data;
        if (state.error) box.appendChild(X.el('div', 'je-hub-note je-hub-note-warn', X.tr('arr_rules_error')));
        if (data.editable !== true) {
            if (data.backend === 'seerr') box.appendChild(seerrPanel(data.seerr || null));
            else box.appendChild(X.el('div', 'je-household-help', X.tr('arr_rules_not_applied')));
            return box;
        }
        if (state.stale) box.appendChild(X.el('div', 'je-hub-note je-hub-note-warn', X.tr('arr_rules_changed')));
        if (!state.draft) state.draft = fromServed(data);
        box.appendChild(X.el('div', 'je-household-help', X.tr('arr_rules_intro')));
        box.appendChild(X.el('div', 'je-household-help', X.tr('arr_rules_precedence')));
        const roles = X.el('div', 'je-rules-roles');
        for (const role of Object.keys(state.draft.roles)) roles.appendChild(roleEditor(role));
        box.appendChild(roles);
        box.appendChild(streamingEditor());
        if (data.poolsEnabled === true) box.appendChild(poolsEditor());
        const bar = saveBar();
        if (bar) box.appendChild(bar);
        return box;
    }

    // ---- Rule verdicts in words (Approvals, My requests, the request controls) ----

    /**
     * The hits of a verdict that decided it: those taking the verdict's action (and facts not known, for a look).
     * @param {Object|null|undefined} rules Verdict ({verdict, hits}).
     * @returns {Object[]} Hits.
     */
    function decisive(rules) {
        const verdict = rules?.verdict;
        if (!['approve', 'review', 'deny'].includes(verdict) || !Array.isArray(rules.hits)) return [];
        return rules.hits.filter(h => h && typeof h === 'object' && CONDITIONS.includes(h.condition)
            && (h.action === verdict || (verdict === 'review' && h.matched == null)));
    }

    /**
     * One hit's fact in words: "rated R (limit PG-13)", "genre Horror", "about 60 GB, over the 40 GB limit".
     * @param {Object} hit Hit ({condition, matched, value, limit}).
     * @returns {string} Fact.
     */
    function factText(hit) {
        const value = typeof hit.value === 'string' ? hit.value : hit.value == null ? '' : String(hit.value);
        const limit = typeof hit.limit === 'string' ? hit.limit : hit.limit == null ? '' : String(hit.limit);
        const matched = hit.matched === true;
        switch (hit.condition) {
            case 'rating': return X.tr('arr_rules_fact_rating', { value: value || '?', limit: limit || '?' });
            case 'genre': return matched ? X.tr('arr_rules_fact_genre', { value: seerrList(value, genreName) }) : X.tr('arr_rules_fact_genre_not');
            case 'language': return X.tr(matched ? 'arr_rules_fact_language' : 'arr_rules_fact_language_not', { value: languageName(value) || '?' });
            case 'size': return X.tr(matched ? 'arr_rules_fact_size' : 'arr_rules_fact_size_not', { value: value || '?', limit: limit || '?' });
            default: return matched ? X.tr('arr_rules_fact_streaming', { value }) : X.tr('arr_rules_fact_streaming_not');
        }
    }

    /**
     * The lines of a verdict: "Needs a look: rated R (limit PG-13)", "Not known: rating",
     * "Approved by the household's rules: streams on Netflix", "Refused by the household's rules: genre Horror".
     * @param {Object|null|undefined} rules Verdict.
     * @returns {Array<{action: string, text: string, unknown: boolean}>} Lines.
     */
    function lines(rules) {
        return decisive(rules).map((hit) => {
            if (hit.matched == null) return { action: 'review', unknown: true, text: X.tr('arr_rules_hit_unknown', { what: X.tr(`arr_rules_what_${hit.condition}`) }) };
            return { action: hit.action, unknown: false, text: X.tr(`arr_rules_hit_${hit.action}`, { fact: factText(hit) }) };
        });
    }

    /**
     * The facts behind a verdict, short, for a toast ("rated R (limit PG-13); rating not known").
     * @param {Object|null|undefined} rules Verdict.
     * @returns {string} Text ('' when none).
     */
    function whyText(rules) {
        return decisive(rules).map(hit => (hit.matched == null ? X.tr('arr_rules_why_unknown', { what: X.tr(`arr_rules_what_${hit.condition}`) }) : factText(hit))).join('; ');
    }

    /**
     * The words of a rule reason (rule_review, group_quota, household_rule), or ''.
     * @param {string} reason Reason code.
     * @returns {string} Text.
     */
    function reasonText(reason) {
        return ['rule_review', 'group_quota', 'household_rule'].includes(reason) ? X.tr(`arr_rules_reason_${reason}`) : '';
    }

    /**
     * A shared allowance's use: "Kids: 7 of 7 used (shared) · next frees up Tue 21 Oct" ('' when unknown).
     * @param {{name: string, used: number, limit: number, remaining?: number, nextSlotAt?: string}|null|undefined} pool Pool.
     * @returns {string} Text.
     */
    function poolText(pool) {
        if (!pool || typeof pool.used !== 'number' || typeof pool.limit !== 'number') return '';
        const name = typeof pool.name === 'string' && pool.name.trim() ? pool.name.trim() : X.tr('arr_rules_pools_title');
        const day = pool.used >= pool.limit && pool.nextSlotAt && JE.arrStatus?.formatDate ? JE.arrStatus.formatDate(pool.nextSlotAt) : '';
        return day ? X.tr('arr_rules_pool_line_next', { name, used: pool.used, limit: pool.limit, day }) : X.tr('arr_rules_pool_line', { name, used: pool.used, limit: pool.limit });
    }

    /**
     * The rationale block of a request: the rule reason's sentence and the verdict's lines, each with an icon
     * (text through textContent only). Null when there is nothing to say.
     * @param {Object|null|undefined} rules Verdict.
     * @param {string} [reason] The request's reason code.
     * @returns {HTMLElement|null} Block.
     */
    function why(rules, reason) {
        const said = reasonText(reason);
        const list = lines(rules);
        if (!said && !list.length) return null;
        injectStyles();
        const box = X.el('div', 'je-rules-why');
        if (said) {
            const line = X.el('div', 'je-approval-line je-rules-why-reason');
            line.appendChild(X.icon(reason === 'group_quota' ? 'data_usage' : reason === 'household_rule' ? 'block' : 'rule'));
            line.appendChild(document.createTextNode(said));
            box.appendChild(line);
        }
        for (const item of list) {
            const line = X.el('div', `je-approval-line je-rules-why-line je-rules-why-${item.unknown ? 'unknown' : item.action}`);
            line.appendChild(X.icon(item.unknown ? 'help' : item.action === 'deny' ? 'block' : item.action === 'approve' ? 'check_circle' : 'visibility'));
            line.appendChild(document.createTextNode(item.text));
            box.appendChild(line);
        }
        return box;
    }

    const CSS = `
.je-rules { gap: 0.8em; }
.je-rules-roles, .je-rules-pool-list { display: flex; flex-direction: column; gap: 0.6em; }
.je-rules-role { border-radius: 10px; border: 1px solid rgba(128,128,128,0.28); border: 1px solid color-mix(in srgb, currentColor 14%, transparent); padding: 0 0.8em; }
.je-rules-role[open] { padding-bottom: 0.8em; }
.je-rules-role-summary { cursor: pointer; font-weight: 600; min-height: 44px; line-height: 44px; }
.je-rules-role > .je-rules-cond { margin-top: 0.6em; }
.je-rules-cond { border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 10px; padding: 0.4em 0.8em 0.7em; margin: 0;
  display: flex; flex-direction: column; gap: 0.5em; min-width: 0; }
.je-rules-cond-title { font-weight: 600; padding: 0 0.3em; margin: 0; font-size: 1em; }
.je-rules-params, .je-rules-actions { display: flex; flex-wrap: wrap; gap: 0.6em 1.2em; align-items: flex-end; }
.je-rules-checks { display: flex; flex-wrap: wrap; gap: 0.2em 1em; }
.je-rules-check { display: inline-flex; align-items: center; gap: 0.4em; min-height: 2.6em; cursor: pointer; }
.je-rules-check input { width: 1.3em; height: 1.3em; }
.je-rules-input { font: inherit; min-height: 2.6em; padding: 0.2em 0.6em; border-radius: 8px; color: inherit; background: transparent; max-width: 100%;
  border: 1px solid rgba(128,128,128,0.4); border: 1px solid color-mix(in srgb, currentColor 30%, transparent); box-sizing: border-box; }
.je-rules-block { display: flex; flex-direction: column; gap: 0.5em; }
.je-rules-block-title { margin: 0.4em 0 0; font-size: 1.05em; font-weight: 600; }
.je-rules-pool { padding: 0.8em; border-radius: 10px; display: flex; flex-direction: column; gap: 0.6em;
  border: 1px solid rgba(128,128,128,0.28); border: 1px solid color-mix(in srgb, currentColor 14%, transparent); }
.je-rules-pool-actions { display: flex; flex-wrap: wrap; gap: 0.5em; }
.je-rules-seerr-list { margin: 0; padding-left: 1.2em; display: flex; flex-direction: column; gap: 0.5em; }
.je-rules-seerr-rule-title { font-weight: 600; }
.je-rules-why { display: flex; flex-direction: column; gap: 0.25em; }
.je-rules-why-deny { color: #e53935; }
.je-rules-why-approve { color: #2e9d4f; }
.je-rules-why-review, .je-rules-why-unknown, .je-rules-why-reason { color: #d97706; }
.je-approvals-light .je-rules-why-deny { color: #b71c1c; }
.je-approvals-light .je-rules-why-approve { color: #1a7431; }
.je-approvals-light .je-rules-why-review, .je-approvals-light .je-rules-why-unknown, .je-approvals-light .je-rules-why-reason { color: #9a4d00; }
.je-rules-input:focus-visible, .je-rules-check input:focus-visible, .je-rules-role-summary:focus-visible,
.layout-tv .je-rules-input:focus, .layout-tv .je-rules-check input:focus, .layout-tv .je-rules-role-summary:focus { outline: 3px solid currentColor; outline-offset: 2px; }
@media (max-width: 600px) {
  .je-rules-input, .je-rules-check, .je-rules-pool-actions .je-hub-btn, .je-rules-load { min-height: 44px; min-width: 44px; }
  .je-rules-params .je-household-field, .je-rules-actions .je-household-field, .je-rules-input { width: 100%; }
  .je-rules-role { padding: 0 0.6em; }
  .je-rules-cond { padding: 0.4em 0.6em 0.6em; }
}
.layout-tv .je-rules-input, .layout-tv .je-rules-check, .layout-tv .je-rules-role-summary, .layout-tv .je-rules-pool-actions .je-hub-btn { min-height: 48px; font-size: 1.05em; }
`;

    /**
     * Adds the styles once.
     * @returns {void}
     */
    function injectStyles() {
        if (document.getElementById('je-arr-rules-styles')) return;
        const style = document.createElement('style');
        style.id = 'je-arr-rules-styles';
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    JE.session?.onUserChange?.('arr-household-rules', () => resetForUser());

    H.rules = { section, load, changed, dirty, saveBody, state, lines, whyText, reasonText, poolText, why, roleText };
})(window.JellyfinEnhanced);
