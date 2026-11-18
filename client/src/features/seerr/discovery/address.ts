// What a page's address says of its Seerr filters, so a link, a reload, Back and Forward show what was set: All /
// Movies / Series (`jeType`), the order (`jeSort`), and the further filters (`jeReleased`, `jeScore`, `jeVotes`,
// `jeRuntime`, `jeRole`, `jeGenres`, `jeLanguage`, `jeRating`, `jeServices`, `jeKeywords`, `jeWithout`,
// `jeWithoutGenres`, `jeWithoutLanguage`), with the lists matched otherwise than by default (`jeAny=genres,keywords`,
// `jeAll=services`). The discovery sections ("More from", "More tagged", a genre's, studio's or network's page) keep
// theirs in their own page's address; the Recommendations page keeps its in Home's address (or its own page's), with
// the category page open over it (`jeCategory`).
//
// Pairs are written only while something is set, in a fragment of their own after the host's route and query
// (`#/details?id=…&serverId=…#jeType=movies&jeScore=7..`), which stay exactly as they are: jellyfin-web's router keys
// its views on the route and query, and a change there that it did not make itself has it build the page anew on the
// next Back (a dialog's or More Info's included), and its dialogs write back the query it last saw. The fragment it
// keeps apart, unread. An address with the pairs in its query (a link written so) is read as well; once a change is
// written, the fragment's pairs are the ones that count. A change replaces the history entry (Back takes no step per
// filter) and is not a navigation for the rest of the plugin (JE.core.navigation.setAddressQuietly). Anything in an
// address that is not of its filter's shape is left out, so a hand-made or cut-off link narrows by what it says well and
// by nothing else. Published as JE.discoveryAddress.
import type { SeerrDiscoveryHost } from '../host-discovery';
import { MATCH_DEFAULTS } from './filters';
import type { AddressFilters, FilterMode, FilterScope, FilterSelection, ListId, Match, MatchId, Picked, Range, RangeId } from './types';

const TYPE_PARAM = 'jeType';
const SORT_PARAM = 'jeSort';
const CATEGORY_PARAM = 'jeCategory';
/** A range is `from..to`, either side left empty ("7.." for 7 and up). */
const RANGE_PARAMS: ReadonlyArray<readonly [RangeId, string]> = [['year', 'jeReleased'], ['score', 'jeScore'], ['votes', 'jeVotes'], ['runtime', 'jeRuntime']];
/**
 * A list is its ids, by commas: [filter, pair, an id's shape, whether an entry carries its name]. Where the id alone
 * can't give the name back (a genre, a service, a keyword) an entry is `id:name`; a role and a language are named here,
 * and a content rating is its own name.
 */
const LIST_PARAMS: ReadonlyArray<readonly [ListId, string, RegExp, boolean]> = [
    ['role', 'jeRole', /^(?:cast|[A-Z][A-Za-z]{0,20}(?:[ &-]{1,3}[A-Za-z]{1,20}){0,3})$/, false],
    ['genres', 'jeGenres', /^(?:\d{1,9}\/\d{0,9}|\/\d{1,9})$/, true],
    ['withoutGenres', 'jeWithoutGenres', /^(?:\d{1,9}\/\d{0,9}|\/\d{1,9})$/, true],
    ['language', 'jeLanguage', /^[a-z]{2}$/, false],
    ['withoutLanguage', 'jeWithoutLanguage', /^[a-z]{2}$/, false],
    ['rating', 'jeRating', /^(?:movie|tv):[A-Z]{2}:[A-Za-z0-9+\- ]{1,12}$/, false],
    ['services', 'jeServices', /^\d{1,9}$/, true],
    ['keywords', 'jeKeywords', /^\d{1,9}$/, true],
    ['without', 'jeWithout', /^\d{1,9}$/, true]
];
/** The lists matched by any of what is ticked, and by all of it, where that is not their default. */
const ANY_PARAM = 'jeAny';
const ALL_PARAM = 'jeAll';
/** The lists a match can be chosen for, in the order they are written. */
const MATCHED: readonly MatchId[] = ['genres', 'keywords', 'services'];
const MAX_LIST = 50;
const MAX_NAME = 80;
const MAX_BOUND = 10;
/** Every pair of the address that is this module's; the rest are the host's, kept as they are. */
const OWN_PARAMS: ReadonlySet<string> = new Set([TYPE_PARAM, SORT_PARAM, CATEGORY_PARAM, ANY_PARAM, ALL_PARAM,
    ...RANGE_PARAMS.map(entry => entry[1]), ...LIST_PARAMS.map(entry => entry[1])]);
/** The Home route, with or without its query (the tabs' `?tab=N&jeTab=…`) and this module's fragment. */
const HOME_HASH = /^(?:#\/home(?:\.html)?(?:\?[^#]*)?(?:#.*)?)?$/;
/** The Recommendations page of its own (the sidebar link), with or without a query and this module's fragment. */
const PAGE_HASH = /^#\/recommendations(?:\?[^#]*)?(?:#.*)?$/;
/** What a category key may be (see the catalogue's resolveCategory): anything else in an address is ignored. */
const CATEGORY_KEY = /^(?:[a-z]+(?:-[a-z]+)?|(?:studio|network)-\d{1,9}|genre-(?:movie|tv)-\d{1,9})$/;

/** A hash's parts, each pair as written: the router's part (route and query), the route, the query's pairs, and the pairs of the fragment after it (null when there is none; an empty fragment is []). */
function split(hash: string): { head: string; route: string; pairs: string[]; fragment: string[] | null } {
    const text = String(hash || '');
    const mark = text.indexOf('#', 1);
    const head = mark < 0 ? text : text.slice(0, mark);
    const at = head.indexOf('?');
    return {
        head,
        route: at < 0 ? head : head.slice(0, at),
        pairs: at < 0 ? [] : head.slice(at + 1).split('&').filter(Boolean),
        fragment: mark < 0 ? null : text.slice(mark + 1).split('&').filter(Boolean)
    };
}
/** A pair's name. */
const nameOf = (pair: string): string => pair.split('=')[0] || '';
/** This module's pairs in an address: its fragment's once it has one, else those in its query (a link written with them there). */
function ownPairs(hash: string): string[] {
    const { pairs, fragment } = split(hash);
    return (fragment ?? pairs).filter(pair => OWN_PARAMS.has(nameOf(pair)));
}
/** Decodes what an address holds, or keeps it as written when it is not well encoded. */
const decode = (raw: string): string => { try { return decodeURIComponent(raw); } catch { return raw; } };
/** A pair's value as written (still encoded), or null when there is none. */
const rawOf = (pairs: readonly string[], name: string): string | null => {
    const pair = pairs.find(entry => nameOf(entry) === name);
    return pair === undefined ? null : pair.slice(name.length + 1);
};
/** A pair's value, decoded, or null when there is none. */
const valueOf = (pairs: readonly string[], name: string): string | null => {
    const raw = rawOf(pairs, name);
    return raw === null ? null : decode(raw);
};
/** An id or a bound as the address writes it: encoded, its slash and colons left readable. */
const readable = (text: string): string => encodeURIComponent(text).replace(/%2F/gi, '/').replace(/%3A/gi, ':');
/** Whether an address is Home's (where the Recommendations tab is). */
export const isHomeHash = (hash: string): boolean => HOME_HASH.test(String(hash ?? ''));
/** Whether an address is one the Recommendations page shows on: Home (its tab) or its own page. */
export const isRecommendationsHash = (hash: string): boolean => isHomeHash(hash) || PAGE_HASH.test(String(hash ?? ''));

export function createDiscoveryAddress(JE: SeerrDiscoveryHost) {
    /** A translated string, in English where the key has no translation. */
    const label = (key: string, fallback: string): string => {
        const text = typeof JE.t === 'function' ? JE.t(key) : '';
        return text && text !== key ? text : fallback;
    };
    /** A list's own match when none is chosen. */
    const matchDefault = (id: MatchId): Match => JE.discoveryFilters?.MATCH_DEFAULTS?.[id] ?? MATCH_DEFAULTS[id];
    /** Whether what is typed for a bound can be used (see filters.ts). */
    const isBound = (id: RangeId, text: string, upper: boolean): boolean => typeof JE.discoveryFilters?.isBound === 'function'
        ? JE.discoveryFilters.isBound(id, text, upper) : String(text ?? '').trim() === '';
    /** The order values the sort offers. */
    const sortValues = (): string[] => (JE.discoveryFilter?.SORT_OPTIONS ?? []).map(option => option.value);
    /** A role's name, as the Role list gives it (`cast`, or a crew department by TMDB's name). */
    const roleName = (id: string): string => id === 'cast' ? label('discovery_role_acting', 'Acting')
        : label(`discovery_role_${id.toLowerCase().replace(/[^a-z]+/g, '_')}`, id);

    /** What an address says of the filters, languages named in `locale`. Anything not of its filter's shape is left out. */
    function filtersOfHash(hash: string, locale?: string): AddressFilters {
        const pairs = ownPairs(hash);
        const type = valueOf(pairs, TYPE_PARAM);
        const mode: FilterMode = type === 'movies' ? 'movies' : type === 'series' ? 'tv' : 'mixed';
        const selection: { -readonly [K in keyof FilterSelection]: FilterSelection[K] } = {};
        for (const [id, param] of RANGE_PARAMS) {
            const value = valueOf(pairs, param);
            const at = value ? value.indexOf('..') : -1;
            if (!value || at < 0) continue;
            const bounds = [value.slice(0, at).trim(), value.slice(at + 2).trim()]
                .map((bound, index) => bound.length <= MAX_BOUND && isBound(id, bound, index === 1) ? bound : '');
            const range: Range = [bounds[0] ?? '', bounds[1] ?? ''];
            if (range[0] || range[1]) selection[id] = range;
        }
        let names: Intl.DisplayNames | null = null;
        try { names = new Intl.DisplayNames([locale || document.documentElement.lang || 'en'], { type: 'language' }); } catch { names = null; }
        for (const [id, param, shape, named] of LIST_PARAMS) {
            const raw = rawOf(pairs, param);
            if (!raw) continue;
            const items: Picked[] = [];
            for (const entry of raw.split(',').slice(0, MAX_LIST)) {
                const at = named ? entry.indexOf(':') : -1;
                const itemId = decode(at < 0 ? entry : entry.slice(0, at)).trim();
                if (!shape.test(itemId) || items.some(item => item.id === itemId)) continue;
                let name = at < 0 ? '' : decode(entry.slice(at + 1)).trim().slice(0, MAX_NAME);
                if (id === 'role') name = roleName(itemId);
                if (id === 'rating') name = itemId.split(':')[2] || itemId;
                if (id === 'language' || id === 'withoutLanguage') { try { name = names?.of(itemId) || ''; } catch { name = ''; } }
                items.push({ id: itemId, name: name || itemId });
            }
            if (items.length > 0) selection[id] = items;
        }
        const match: { [K in MatchId]?: Match } = {};
        for (const [param, value] of [[ANY_PARAM, 'any'], [ALL_PARAM, 'all']] as const) {
            for (const id of (valueOf(pairs, param) || '').split(',')) {
                const matched = MATCHED.find(entry => entry === id);
                if (matched && selection[matched] && value !== matchDefault(matched)) match[matched] = value;
            }
        }
        if (Object.keys(match).length > 0) selection.match = match;
        const sort = valueOf(pairs, SORT_PARAM) || '';
        return { mode, selection, sort: sort && sortValues().includes(sort) ? sort : '' };
    }

    /** The filters' pairs, in one order, so two sets of filters compare as their pairs do (`withSort`: the order is written too). */
    function filterPairs(filters: AddressFilters, withSort: boolean): string[] {
        const pairs: string[] = [];
        const selection = filters.selection || {};
        if (filters.mode === 'movies' || filters.mode === 'tv') pairs.push(`${TYPE_PARAM}=${filters.mode === 'tv' ? 'series' : 'movies'}`);
        for (const [id, param] of RANGE_PARAMS) {
            const range = selection[id];
            // (A bound that can't be used narrows nothing, and is not written.)
            const [from = '', to = ''] = [String(range?.[0] ?? '').trim(), String(range?.[1] ?? '').trim()]
                .map((bound, index) => isBound(id, bound, index === 1) ? bound : '');
            if (from || to) pairs.push(`${param}=${readable(from)}..${readable(to)}`);
        }
        for (const [id, param, , named] of LIST_PARAMS) {
            const items = selection[id] ?? [];
            if (items.length === 0) continue;
            pairs.push(`${param}=${items.map(item => named
                ? `${readable(String(item.id))}:${encodeURIComponent(String(item.name ?? ''))}` : readable(String(item.id))).join(',')}`);
        }
        // (A list on its default match, or with nothing ticked, says nothing of it.)
        const matched = (value: Match): MatchId[] => MATCHED.filter(id => (selection[id] ?? []).length > 0 && value !== matchDefault(id)
            && (selection.match?.[id] ?? matchDefault(id)) === value);
        for (const [param, value] of [[ANY_PARAM, 'any'], [ALL_PARAM, 'all']] as const) {
            const ids = matched(value);
            if (ids.length > 0) pairs.push(`${param}=${ids.join(',')}`);
        }
        if (withSort && filters.sort) pairs.push(`${SORT_PARAM}=${encodeURIComponent(filters.sort)}`);
        return pairs;
    }

    /** The category the Recommendations page's address names (`jeCategory`), or null. */
    function categoryOfHash(hash: string): string | null {
        if (!isRecommendationsHash(hash)) return null;
        const key = valueOf(ownPairs(hash), CATEGORY_PARAM);
        return key && CATEGORY_KEY.test(key) ? key : null;
    }

    /**
     * The address with this module's pairs in place of those it had: a category (or none), and the filters (with the
     * order where `withSort`), in the fragment after the router's part, which stays as it is. An address whose query
     * already says just that (a link) is left as it is; one whose query says something else gets the fragment, empty
     * where nothing is set.
     */
    function addressWith(hash: string, category: string | null, filters: AddressFilters, withSort: boolean): string {
        const { head, pairs, fragment } = split(hash);
        const own = category ? [`${CATEGORY_PARAM}=${encodeURIComponent(category)}`] : [];
        own.push(...filterPairs(filters, withSort));
        const inQuery = pairs.filter(pair => OWN_PARAMS.has(nameOf(pair)));
        if (fragment === null && own.join('&') === inQuery.join('&')) return hash;
        if (own.length === 0 && inQuery.length === 0) return head;
        return `${head || '#/home'}#${own.join('&')}`;
    }

    /**
     * The address without anything of this module's: the host's own pairs only. What a page is, as opposed to what it
     * shows (a page's identity for the code that keeps one per page).
     */
    function withoutOwn(hash: string): string {
        const { route, pairs } = split(hash);
        const kept = pairs.filter(pair => !OWN_PARAMS.has(nameOf(pair)));
        return kept.length > 0 ? `${route}?${kept.join('&')}` : route;
    }

    /** What is set in a module, with the order of an order's module where it has one (`sortModule` null: none). */
    function current(filterModule: string, sortModule: string | null): AddressFilters {
        const filter = JE.discoveryFilter;
        return {
            mode: filter?.getFilterMode?.(filterModule) || 'mixed',
            selection: JE.discoveryFilters?.selectionOf?.(filterModule) || {},
            sort: sortModule ? (filter?.getSortMode?.(sortModule) || '') : ''
        };
    }

    /**
     * Filters in the address form (a page's own pairs, or a saved profile's), as a page takes them: only the filters it
     * offers (those of its scope that the admin has not turned off), and their lists' match. A whole hash is read as an address.
     */
    function filtersOf(text: string, scope: FilterScope = 'feed'): AddressFilters {
        const source = String(text ?? '');
        const said = filtersOfHash(source.startsWith('#') || source.includes('?') ? source : `#?${source}`);
        const offered: readonly string[] = JE.discoveryFilters?.offeredFilters?.(scope, JE.pluginConfig) ?? [];
        const selection: { -readonly [K in keyof FilterSelection]: FilterSelection[K] } = {};
        for (const [id, range] of RANGE_PARAMS.map(([id]) => [id, said.selection[id]] as const)) {
            if (range && offered.includes(id)) selection[id] = range;
        }
        for (const [id] of LIST_PARAMS) {
            const list = said.selection[id];
            if (list && offered.includes(id)) selection[id] = list;
        }
        const match: { [K in MatchId]?: Match } = {};
        for (const id of MATCHED) {
            const value = said.selection.match?.[id];
            if (value && offered.includes(id)) match[id] = value;
        }
        if (Object.keys(match).length > 0) selection.match = match;
        return { mode: said.mode, selection, sort: said.sort };
    }

    /**
     * Makes what the address says the module's: true when that changed anything. Only the filters the page offers are
     * taken: those of its scope that the admin has not turned off. `withType`: All / Movies / Series is offered (else it
     * stays as it is); `withSort`: the order is read too; `scope`: which filters the page offers.
     */
    function adopt(filterModule: string, sortModule: string | null,
        options: { readonly withType?: boolean; readonly withSort?: boolean; readonly scope?: FilterScope } = {}): boolean {
        const withType = options.withType !== false;
        const withSort = options.withSort ?? !!sortModule;
        const now = current(filterModule, withSort ? sortModule : null);
        const said = filtersOf(window.location.hash, options.scope || 'feed');
        const wanted: AddressFilters = { mode: withType ? said.mode : now.mode, selection: said.selection, sort: withSort ? said.sort : '' };
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
     * Changes the address in place: no history entry, and no navigation for the rest of the plugin. `push`: add a history
     * entry instead; `state`: the entry's state (default: none for a new entry, the current one's when replacing).
     */
    function go(hash: string, options: { readonly push?: boolean; readonly state?: unknown } = {}): void {
        const url = `${window.location.pathname}${window.location.search}${hash}`;
        const push = options.push === true;
        const state: unknown = 'state' in options ? options.state : push ? null : history.state;
        const navigation = JE.core?.navigation;
        if (typeof navigation?.setAddressQuietly === 'function') navigation.setAddressQuietly(state, url, push);
        else if (push) history.pushState(state, '', url);
        else history.replaceState(state, '', url);
    }

    /** Writes what is set in a module into the address of the page in view, keeping the category it names (`withSort`: the order too). */
    function write(filterModule: string, sortModule: string | null, withSort = !!sortModule): void {
        const hash = window.location.hash;
        const next = addressWith(hash, categoryOfHash(hash), current(filterModule, withSort ? sortModule : null), withSort);
        if (next !== hash) go(next);
    }

    return {
        OWN_PARAMS, isHomeHash, isRecommendationsHash, filtersOfHash, filtersOf, filterPairs, categoryOfHash, addressWith,
        withoutOwn, current, adopt, write, go
    };
}
