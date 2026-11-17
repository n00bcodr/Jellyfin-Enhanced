// /js/jellyseerr/discovery/discovery-address.js
// What a page's address says of its Seerr filters, so a link, a reload, Back and Forward show what was
// set: All / Movies / Series (`jeType`), the order (`jeSort`), and the further filters (`jeReleased`,
// `jeScore`, `jeVotes`, `jeRuntime`, `jeRole`, `jeGenres`, `jeLanguage`, `jeRating`, `jeServices`,
// `jeKeywords`, `jeWithout`), with the lists matched otherwise than by default (`jeAny=genres,keywords`,
// `jeAll=services`). The discovery sections ("More from", "More tagged", a genre's, studio's or
// network's page) keep theirs in their own page's address; the Recommendations page keeps its in Home's
// address (or its own page's), with the category page open over it (`jeCategory`).
//
// Pairs are written only while something is set, after the host's own pairs, which stay as they are.
// A change replaces the history entry (Back takes no step per filter) and is not a navigation for the
// rest of the plugin (JE.core.navigation.setAddressQuietly). Anything in an address that is not of its
// filter's shape is left out, so a hand-made or cut-off link narrows by what it says well and by nothing else.
//
// Public surface: JE.discoveryAddress.
(function (JE) {
    'use strict';

    const TYPE_PARAM = 'jeType';
    const SORT_PARAM = 'jeSort';
    const CATEGORY_PARAM = 'jeCategory';
    /** A range is `from..to`, either side left empty ("7.." for 7 and up). */
    const RANGE_PARAMS = [['year', 'jeReleased'], ['score', 'jeScore'], ['votes', 'jeVotes'], ['runtime', 'jeRuntime']];
    /**
     * A list is its ids, by commas: [filter, pair, an id's shape, whether an entry carries its name]. Where the
     * id alone can't give the name back (a genre, a service, a keyword) an entry is `id:name`; a role and a
     * language are named here, and a content rating is its own name.
     */
    const LIST_PARAMS = [
        ['role', 'jeRole', /^(?:cast|[A-Z][A-Za-z]{0,20}(?:[ &-]{1,3}[A-Za-z]{1,20}){0,3})$/, false],
        ['genres', 'jeGenres', /^(?:\d{1,9}\/\d{0,9}|\/\d{1,9})$/, true],
        ['language', 'jeLanguage', /^[a-z]{2}$/, false],
        ['rating', 'jeRating', /^(?:movie|tv):[A-Z]{2}:[A-Za-z0-9+\- ]{1,12}$/, false],
        ['services', 'jeServices', /^\d{1,9}$/, true],
        ['keywords', 'jeKeywords', /^\d{1,9}$/, true],
        ['without', 'jeWithout', /^\d{1,9}$/, true]
    ];
    /** The lists matched by any of what is ticked, and by all of it, where that is not their default. */
    const ANY_PARAM = 'jeAny';
    const ALL_PARAM = 'jeAll';
    /** The lists a match can be chosen for, in the order they are written. */
    const MATCHED = ['genres', 'keywords', 'services'];
    /** A list's own match when none is chosen (as discovery-filters.js MATCH_DEFAULTS). */
    const matchDefault = id => JE.discoveryFilters?.MATCH_DEFAULTS?.[id] ?? (id === 'services' ? 'any' : 'all');
    const MAX_LIST = 50;
    const MAX_NAME = 80;
    const MAX_BOUND = 10;
    /** Every pair of the address that is this module's; the rest are the host's, kept as they are. */
    const OWN_PARAMS = new Set([TYPE_PARAM, SORT_PARAM, CATEGORY_PARAM, ANY_PARAM, ALL_PARAM,
        ...RANGE_PARAMS.map(entry => entry[1]), ...LIST_PARAMS.map(entry => entry[1])]);
    /** The Home route, with or without its query (the tabs' `?tab=N&jeTab=…`). */
    const HOME_HASH = /^(?:#\/home(?:\.html)?(?:\?.*)?)?$/;
    /** The Recommendations page of its own (the sidebar link), with or without a query. */
    const PAGE_HASH = /^#\/recommendations(?:\?.*)?$/;
    /** What a category key may be (see the catalogue's resolveCategory): anything else in an address is ignored. */
    const CATEGORY_KEY = /^(?:[a-z]+(?:-[a-z]+)?|(?:studio|network)-\d{1,9}|genre-(?:movie|tv)-\d{1,9})$/;

    /**
     * A translated string, in English where the key has no translation.
     * @param {string} key - Locale key
     * @param {string} fallback - English text
     * @returns {string}
     */
    function label(key, fallback) {
        const text = typeof JE.t === 'function' ? JE.t(key) : '';
        return text && text !== key ? text : fallback;
    }

    /**
     * A hash's route and its query's pairs, each as written.
     * @param {string} hash - An address's hash (`#/route?a=1&b=2`)
     * @returns {{route: string, pairs: string[]}}
     */
    function split(hash) {
        const text = String(hash || '');
        const at = text.indexOf('?');
        return { route: at < 0 ? text : text.slice(0, at), pairs: at < 0 ? [] : text.slice(at + 1).split('&').filter(Boolean) };
    }
    /**
     * A pair's name.
     * @param {string} pair - `name=value`
     * @returns {string}
     */
    const nameOf = pair => pair.split('=')[0] || '';
    /**
     * Decodes what an address holds, or keeps it as written when it is not well encoded.
     * @param {string} raw
     * @returns {string}
     */
    const decode = raw => { try { return decodeURIComponent(raw); } catch (_) { return raw; } };
    /**
     * A pair's value as written (still encoded), or null when there is none.
     * @param {string[]} pairs
     * @param {string} name
     * @returns {string|null}
     */
    const rawOf = (pairs, name) => {
        const pair = pairs.find(entry => nameOf(entry) === name);
        return pair === undefined ? null : pair.slice(name.length + 1);
    };
    /**
     * A pair's value, decoded, or null when there is none.
     * @param {string[]} pairs
     * @param {string} name
     * @returns {string|null}
     */
    const valueOf = (pairs, name) => {
        const raw = rawOf(pairs, name);
        return raw === null ? null : decode(raw);
    };
    /**
     * An id or a bound as the address writes it: encoded, its slash and colons left readable.
     * @param {string} text
     * @returns {string}
     */
    const readable = text => encodeURIComponent(text).replace(/%2F/gi, '/').replace(/%3A/gi, ':');
    /**
     * Whether what is typed for a bound can be used (see discovery-filters.js).
     * @param {string} id - The range filter
     * @param {string} text - The bound as typed
     * @param {boolean} upper - The upper bound (else the lower)
     * @returns {boolean}
     */
    const isBound = (id, text, upper) => typeof JE.discoveryFilters?.isBound === 'function'
        ? JE.discoveryFilters.isBound(id, text, upper) : String(text ?? '').trim() === '';
    /** The order values the sort offers. */
    const sortValues = () => (JE.discoveryFilter?.SORT_OPTIONS ?? []).map(option => option.value);

    /**
     * Whether an address is Home's (where the Recommendations tab is).
     * @param {string} hash
     * @returns {boolean}
     */
    const isHomeHash = hash => HOME_HASH.test(String(hash ?? ''));
    /**
     * Whether an address is one the Recommendations page shows on: Home (its tab) or its own page.
     * @param {string} hash
     * @returns {boolean}
     */
    const isRecommendationsHash = hash => isHomeHash(hash) || PAGE_HASH.test(String(hash ?? ''));

    /**
     * A role's name, as the Role list gives it.
     * @param {string} id - `cast`, or a crew department by TMDB's name
     * @returns {string}
     */
    function roleName(id) {
        return id === 'cast' ? label('discovery_role_acting', 'Acting')
            : label(`discovery_role_${id.toLowerCase().replace(/[^a-z]+/g, '_')}`, id);
    }

    /**
     * What an address says of the filters. Anything not of its filter's shape is left out.
     * @param {string} hash - The address's hash
     * @param {string} [locale] - The page's language, to name languages in
     * @returns {{mode: string, selection: object, sort: string}}
     */
    function filtersOfHash(hash, locale) {
        const { pairs } = split(hash);
        const type = valueOf(pairs, TYPE_PARAM);
        const mode = type === 'movies' ? 'movies' : type === 'series' ? 'tv' : 'mixed';
        const selection = {};
        for (const [id, param] of RANGE_PARAMS) {
            const value = valueOf(pairs, param);
            const at = value ? value.indexOf('..') : -1;
            if (!value || at < 0) continue;
            const [from, to] = [value.slice(0, at).trim(), value.slice(at + 2).trim()]
                .map((bound, index) => bound.length <= MAX_BOUND && isBound(id, bound, index === 1) ? bound : '');
            if (from || to) selection[id] = [from, to];
        }
        let names = null;
        try { names = new Intl.DisplayNames([locale || document.documentElement.lang || 'en'], { type: 'language' }); } catch (_) { names = null; }
        for (const [id, param, shape, named] of LIST_PARAMS) {
            const raw = rawOf(pairs, param);
            if (!raw) continue;
            const items = [];
            for (const entry of raw.split(',').slice(0, MAX_LIST)) {
                const at = named ? entry.indexOf(':') : -1;
                const itemId = decode(at < 0 ? entry : entry.slice(0, at)).trim();
                if (!shape.test(itemId) || items.some(item => item.id === itemId)) continue;
                let name = at < 0 ? '' : decode(entry.slice(at + 1)).trim().slice(0, MAX_NAME);
                if (id === 'role') name = roleName(itemId);
                if (id === 'rating') name = itemId.split(':')[2] || itemId;
                if (id === 'language') { try { name = names?.of(itemId) || ''; } catch (_) { name = ''; } }
                items.push({ id: itemId, name: name || itemId });
            }
            if (items.length > 0) selection[id] = items;
        }
        const match = {};
        for (const [param, value] of [[ANY_PARAM, 'any'], [ALL_PARAM, 'all']]) {
            for (const id of (valueOf(pairs, param) || '').split(',')) {
                if (MATCHED.includes(id) && selection[id] && value !== matchDefault(id)) match[id] = value;
            }
        }
        if (Object.keys(match).length > 0) selection.match = match;
        const sort = valueOf(pairs, SORT_PARAM) || '';
        return { mode, selection, sort: sort && sortValues().includes(sort) ? sort : '' };
    }

    /**
     * The filters' pairs, in one order, so two sets of filters compare as their pairs do.
     * @param {{mode: string, selection: object, sort: string}} filters
     * @param {boolean} withSort - The order is written too
     * @returns {string[]}
     */
    function filterPairs(filters, withSort) {
        const pairs = [];
        const selection = filters.selection || {};
        if (filters.mode === 'movies' || filters.mode === 'tv') pairs.push(`${TYPE_PARAM}=${filters.mode === 'tv' ? 'series' : 'movies'}`);
        for (const [id, param] of RANGE_PARAMS) {
            const range = selection[id];
            // (A bound that can't be used narrows nothing, and is not written.)
            const [from, to] = [String(range?.[0] ?? '').trim(), String(range?.[1] ?? '').trim()]
                .map((bound, index) => isBound(id, bound, index === 1) ? bound : '');
            if (from || to) pairs.push(`${param}=${readable(from)}..${readable(to)}`);
        }
        for (const [id, param, , named] of LIST_PARAMS) {
            const items = selection[id] || [];
            if (items.length === 0) continue;
            pairs.push(`${param}=${items.map(item => named
                ? `${readable(String(item.id))}:${encodeURIComponent(String(item.name ?? ''))}` : readable(String(item.id))).join(',')}`);
        }
        // (A list on its default match, or with nothing ticked, says nothing of it.)
        const matched = value => MATCHED.filter(id => (selection[id] || []).length > 0 && value !== matchDefault(id)
            && (selection.match?.[id] ?? matchDefault(id)) === value);
        for (const [param, value] of [[ANY_PARAM, 'any'], [ALL_PARAM, 'all']]) {
            const ids = matched(value);
            if (ids.length > 0) pairs.push(`${param}=${ids.join(',')}`);
        }
        if (withSort && filters.sort) pairs.push(`${SORT_PARAM}=${encodeURIComponent(filters.sort)}`);
        return pairs;
    }

    /**
     * The category the Recommendations page's address names (`jeCategory`), or null.
     * @param {string} hash
     * @returns {string|null}
     */
    function categoryOfHash(hash) {
        if (!isRecommendationsHash(hash)) return null;
        const key = valueOf(split(hash).pairs, CATEGORY_PARAM);
        return key && CATEGORY_KEY.test(key) ? key : null;
    }

    /**
     * The address with this module's pairs in place of those it had: a category (or none), and the
     * filters (with the order where `withSort`), after the host's own pairs.
     * @param {string} hash - The address now
     * @param {string|null} category - The category page to name (Recommendations only)
     * @param {{mode: string, selection: object, sort: string}} filters
     * @param {boolean} withSort - The order is written too
     * @returns {string}
     */
    function addressWith(hash, category, filters, withSort) {
        const { route, pairs } = split(hash);
        const own = category ? [`${CATEGORY_PARAM}=${encodeURIComponent(category)}`] : [];
        own.push(...filterPairs(filters, withSort));
        const all = [...pairs.filter(pair => !OWN_PARAMS.has(nameOf(pair))), ...own];
        if (all.length === 0) return route;
        return `${route || '#/home'}?${all.join('&')}`;
    }

    /**
     * The address without anything of this module's: the host's own pairs only. What a page is, as
     * opposed to what it shows (a page's identity for the code that keeps one per page).
     * @param {string} hash
     * @returns {string}
     */
    function withoutOwn(hash) {
        const { route, pairs } = split(hash);
        const kept = pairs.filter(pair => !OWN_PARAMS.has(nameOf(pair)));
        return kept.length > 0 ? `${route}?${kept.join('&')}` : route;
    }

    /**
     * What is set in a module, with the order of an order's module where it has one.
     * @param {string} filterModule - The module All / Movies / Series and the further filters are kept under
     * @param {string|null} sortModule - The module the order is kept under (null: none)
     * @returns {{mode: string, selection: object, sort: string}}
     */
    function current(filterModule, sortModule) {
        const filter = JE.discoveryFilter;
        return {
            mode: filter?.getFilterMode?.(filterModule) || 'mixed',
            selection: JE.discoveryFilters?.selectionOf?.(filterModule) || {},
            sort: sortModule ? (filter?.getSortMode?.(sortModule) || '') : ''
        };
    }

    /**
     * Makes what the address says the module's: true when that changed anything. Only the filters the
     * page offers are taken: those of its scope that the admin has not turned off.
     * @param {string} filterModule - Where All / Movies / Series and the further filters are kept
     * @param {string|null} sortModule - Where the order is kept (null: none)
     * @param {{withType?: boolean, withSort?: boolean, scope?: string}} [options] - `withType`: All / Movies / Series
     *   is offered (else it stays as it is); `withSort`: the order is read too; `scope`: which filters the page
     *   offers ('feed', the default, 'person' or 'loaded', see discovery-filters.js)
     * @returns {boolean}
     */
    function adopt(filterModule, sortModule, options = {}) {
        const withType = options.withType !== false;
        const withSort = options.withSort ?? !!sortModule;
        const now = current(filterModule, withSort ? sortModule : null);
        const said = filtersOfHash(window.location.hash);
        const offered = JE.discoveryFilters?.offeredFilters?.(options.scope || 'feed', JE.pluginConfig) ?? [];
        const selection = Object.fromEntries(Object.entries(said.selection).filter(([id]) => offered.includes(id)));
        const match = Object.fromEntries(Object.entries(said.selection.match || {}).filter(([id]) => offered.includes(id)));
        if (Object.keys(match).length > 0) selection.match = match;
        const wanted = { mode: withType ? said.mode : now.mode, selection, sort: withSort ? said.sort : '' };
        if (filterPairs(wanted, withSort).join('&') === filterPairs(now, withSort).join('&')) return false;
        JE.discoveryFilter?.setFilterMode?.(filterModule, wanted.mode);
        JE.discoveryFilters?.setSelection?.(filterModule, wanted.selection);
        if (withSort && sortModule) {
            if (wanted.sort) JE.discoveryFilter?.setSortMode?.(sortModule, wanted.sort);
            else JE.discoveryFilter?.resetSortMode?.(sortModule);
        }
        return true;
    }

    /**
     * Changes the address in place: no history entry, and no navigation for the rest of the plugin.
     * @param {string} hash - The new hash
     * @param {{push?: boolean, state?: *}} [options] - `push`: add a history entry instead; `state`: the
     *   entry's state (default: none for a new entry, the current one's when replacing)
     */
    function go(hash, options = {}) {
        const url = `${window.location.pathname}${window.location.search}${hash}`;
        const push = options.push === true;
        const state = 'state' in options ? options.state : push ? null : history.state;
        if (typeof JE.core?.navigation?.setAddressQuietly === 'function') JE.core.navigation.setAddressQuietly(state, url, push);
        else if (push) history.pushState(state, '', url);
        else history.replaceState(state, '', url);
    }

    /**
     * Writes what is set in a module into the address of the page in view, keeping the category it names.
     * @param {string} filterModule - Where All / Movies / Series and the further filters are kept
     * @param {string|null} sortModule - Where the order is kept (null: none)
     * @param {boolean} [withSort] - The order is written too (default: when there is an order's module)
     */
    function write(filterModule, sortModule, withSort = !!sortModule) {
        const hash = window.location.hash;
        const next = addressWith(hash, categoryOfHash(hash), current(filterModule, withSort ? sortModule : null), withSort);
        if (next !== hash) go(next);
    }

    JE.discoveryAddress = {
        OWN_PARAMS,
        isHomeHash,
        isRecommendationsHash,
        filtersOfHash,
        filterPairs,
        categoryOfHash,
        addressWith,
        withoutOwn,
        current,
        adopt,
        write,
        go
    };

})(window.JellyfinEnhanced || (window.JellyfinEnhanced = {}));
