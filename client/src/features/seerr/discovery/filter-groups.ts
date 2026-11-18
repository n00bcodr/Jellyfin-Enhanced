// The Filters menu's groups: for each filter a section offers, the row that says what is set and
// the body it opens to. A range is two fields to type in; a list is the whole list to tick, with a
// field to narrow it when it is long; keywords are searched for. What is set takes effect at once.
// Also what is set, in words, one piece per thing that can be taken away again (the line of
// filters under a section's header).
import type { SeerrDiscoveryHost } from '../host-discovery';
import { isBound, isRangeId, isReversed, MATCH_DEFAULTS, matchOf } from './filters';
import type {
    FilterId, FilterMenuOptions, FilterSelection, FilterToken, GroupHandle, ListId, MatchId, MenuGroup, Picked, Range, RangeId, Say,
    UndoWordsOptions
} from './types';

/** How long after the last key a typed bound is taken (Enter, or leaving the field, takes it at once). */
const TYPING_MS = 700;
const SEARCH_MS = 350;
/** A list longer than this gets a field to narrow it. */
const SEARCHABLE_FROM = 15;
const KEYWORD_RESULTS = 8;
let hints = 0;

export const NAMES: Readonly<Record<FilterId, readonly [string, string]>> = Object.freeze({
    role: ['discovery_filter_role', 'Role'], year: ['discovery_filter_released', 'Released'], score: ['discovery_filter_score', 'Score'],
    votes: ['discovery_filter_votes', 'Votes'], runtime: ['discovery_filter_runtime', 'Runtime'], genres: ['discovery_filter_genres', 'Genres'],
    language: ['discovery_filter_language', 'Original language'], rating: ['discovery_filter_rating', 'Content rating'],
    services: ['discovery_filter_services', 'Streaming services'], keywords: ['discovery_filter_keywords', 'Keywords'],
    without: ['discovery_filter_without', 'Without keywords'], withoutGenres: ['discovery_filter_without_genres', 'Without genres'],
    withoutLanguage: ['discovery_filter_without_language', 'Without language']
});
/** What a range's fields take, said under them; and what is said there when what is typed cannot be used. */
const HINTS: Readonly<Record<RangeId, readonly [string, string, string, string]>> = Object.freeze({
    // (The example dates are written with the hyphen and the space that do not break, so a date is never split, nor left alone on a line.)
    year: ['discovery_filter_year_hint', 'A year, a\u00a0month\u00a0(2015‑06) or a\u00a0day\u00a0(2015‑06‑30).', 'discovery_filter_year_error', 'Type a\u00a0year\u00a0(2015), a\u00a0month\u00a0(2015‑06) or a\u00a0day\u00a0(2015‑06‑30).'],
    score: ['discovery_filter_score_range_hint', '0 to 10, one decimal at most (7.5).', 'discovery_filter_score_error', 'Type a score from 0 to 10, such as 7.5.'],
    votes: ['discovery_filter_votes_hint', 'How many people have scored it: a whole number.', 'discovery_filter_number_error', 'Type a whole number, such as 500.'],
    runtime: ['discovery_filter_runtime_hint', 'In whole minutes.', 'discovery_filter_number_error', 'Type a whole number, such as 500.']
});
/** How several ticks in one list count, said under the list: Seerr's own rule for each. */
const RULES: Readonly<Record<ListId, readonly [string, string]>> = Object.freeze({
    role: ['discovery_filter_rule_role', 'Any of the roles ticked.'], genres: ['discovery_filter_rule_genres', 'All of the genres ticked.'],
    language: ['discovery_filter_rule_language', 'Any of the languages ticked.'], rating: ['discovery_filter_rule_rating', 'Any of the ratings ticked.'],
    services: ['discovery_filter_rule_services', 'Any of the services ticked.'], keywords: ['discovery_filter_rule_keywords', 'All of the keywords ticked.'],
    without: ['discovery_filter_rule_without', 'None of the keywords ticked.'],
    withoutGenres: ['discovery_filter_rule_without_genres', 'None of the genres ticked.'],
    withoutLanguage: ['discovery_filter_rule_without_language', 'None of the languages ticked.']
});
/** The lists matched by any of what is ticked, with no choice (Seerr's own rule for them). */
const ANY_OF: ReadonlySet<ListId> = new Set(['role', 'language', 'rating']);
/** The lists a title must have none of. */
const NONE_OF: ReadonlySet<ListId> = new Set(['without', 'withoutGenres', 'withoutLanguage']);
/** A list and the one that leaves the same things out: a thing is in one of them at most. */
const PARTNERS: Readonly<Partial<Record<ListId, ListId>>> = Object.freeze({
    genres: 'withoutGenres', withoutGenres: 'genres', language: 'withoutLanguage', withoutLanguage: 'language', keywords: 'without', without: 'keywords'
});
/** Whether a list is one where the viewer chooses all of what is ticked or any. */
const isMatchId = (id: string): id is MatchId => Object.prototype.hasOwnProperty.call(MATCH_DEFAULTS, id);
/**
 * How several ticks in a list count: 'all', 'any' (chosen, or Seerr's own rule for the list), or 'none' (the Without
 * lists: a title has none of them).
 */
const listRule = (selection: FilterSelection, id: ListId): 'all' | 'any' | 'none' | '' => isMatchId(id) ? matchOf(selection, id)
    : ANY_OF.has(id) ? 'any' : NONE_OF.has(id) ? 'none' : '';

/** The bounds that can be used, the lower first: a range typed the wrong way round ("2010" to "1990") has one meaning, and is read so. */
function usable(id: RangeId, range: Range | undefined): Range {
    return !range ? ['', '']
        : isReversed(id, range) ? [range[1].trim(), range[0].trim()]
            : [isBound(id, range[0], false) ? range[0].trim() : '', isBound(id, range[1], true) ? range[1].trim() : ''];
}
/** A typed bound as it is said: votes and minutes in the viewer's way of writing numbers; a date or a score as typed. */
function sayBound(id: RangeId, text: string, locale: string): string {
    if (id !== 'votes' && id !== 'runtime') return text;
    try { return new Intl.NumberFormat(locale || undefined).format(Number(text)); } catch { return text; }
}
const without = (selection: FilterSelection, id: FilterId): FilterSelection => ({ ...selection, [id]: undefined });
const withList = (selection: FilterSelection, id: ListId, list: readonly Picked[]): FilterSelection =>
    ({ ...selection, [id]: list.length > 0 ? list : undefined });

/**
 * What is set, piece by piece, in the order the menu has it: a range is one piece, a list one piece per thing ticked
 * (`join`: said after "and" or "or", the rule of its list; `list`: the list it is in). `ownGenre`: on a genre's page,
 * that genre's name (always applied, so outside an "or").
 */
export function filterTokens({ offered, label: say, locale, selection, ownGenre }: {
    readonly offered: readonly FilterId[]; readonly label: Say; readonly locale: string; readonly selection: FilterSelection;
    readonly ownGenre?: string | undefined;
}): FilterToken[] {
    const tokens: FilterToken[] = [];
    for (const id of offered) {
        if (isRangeId(id)) {
            const [from, to] = usable(id, selection[id]);
            if (!from && !to) continue;
            const unit = id === 'runtime' ? ` ${say('discovery_filter_minutes', 'min')}` : '';
            const values = { name: say(NAMES[id][0], NAMES[id][1]), from: `${sayBound(id, from, locale)}${unit}`, to: `${sayBound(id, to, locale)}${unit}` };
            const words = from && to ? say('discovery_filter_set_range', '{name} {from} to {to}', { ...values, from: sayBound(id, from, locale) })
                : from ? say('discovery_filter_set_from', '{name} from {from}', values) : say('discovery_filter_set_to', '{name} up to {to}', values);
            tokens.push({ words, without: now => without(now, id) });
            continue;
        }
        // (A list of several says its rule between them, as its group's row does: "Action and Comedy" for all of them,
        // "Family or Kids" for any.)
        const rule = listRule(selection, id);
        const own = id === 'genres' ? ownGenre?.trim().toLocaleLowerCase() ?? '' : '';
        const isOwn = (item: Picked): boolean => own !== '' && item.name.toLocaleLowerCase() === own;
        // (The page's own genre is in its heading: the line says only what was chosen beside it.)
        const items = (selection[id] ?? []).filter(item => !isOwn(item));
        /**
         * A thing ticked, said on its own: a keyword and a language need a word to be read alone ("With robot",
         * "Originally in Japanese"), a Without list says what it leaves out ("Without gore", "Not Horror"), services are
         * what titles are on ("On Netflix", as the menu's "Titles on"); a genre, a rating and a role say what they are.
         */
        const alone = (item: Picked): string => id === 'without' ? say('discovery_filter_set_without', 'Without {name}', { name: item.name })
            : id === 'withoutGenres' ? say('discovery_filter_set_not', 'Not {name}', { name: item.name })
                : id === 'withoutLanguage' ? say('discovery_filter_set_not_language', 'Not originally in {name}', { name: item.name })
                    : id === 'keywords' ? say('discovery_filter_set_with', 'With {name}', { name: item.name })
                        : id === 'language' ? say('discovery_filter_set_language', 'Originally in {name}', { name: item.name })
                            : id === 'services' ? say('discovery_filter_set_on', 'On {name}', { name: item.name }) : item.name;
        /** A left-out thing after the first, its own negative in lower case: "not Thriller", "without horror". */
        const more = (item: Picked): string => id === 'without' ? say('discovery_filter_set_without_more', 'without {name}', { name: item.name })
            : id === 'withoutLanguage' ? say('discovery_filter_set_not_language_more', 'not originally in {name}', { name: item.name })
                : say('discovery_filter_set_not_more', 'not {name}', { name: item.name });
        for (const [index, item] of items.entries()) {
            // ("and" for all of them, "or" for any; for none of them "and", each piece said whole: "Not Horror and not
            // Thriller", a piece never read as wanted.)
            const join = rule !== '' && index > 0 ? (rule === 'any' ? 'or' : 'and') : undefined;
            tokens.push({
                join,
                or: join === 'or',
                list: id,
                // (After the word joining it to the one before, its own name is enough: "With bear or dragon". `alone`:
                // as it is said by itself, for what names one piece: Undo.)
                words: !join ? alone(item) : rule === 'none' ? more(item) : item.name,
                alone: alone(item),
                without: now => withList(now, id, (now[id] ?? []).filter(entry => entry.id !== item.id))
            });
        }
    }
    return tokens;
}

/** The Filters menu's groups, in the shape of JE.discoveryMenu's MenuGroup. */
export function filterMenuGroups(JE: SeerrDiscoveryHost, options: FilterMenuOptions): MenuGroup[] {
    const { label: say, data, locale } = options;
    const any = say('discovery_filter_any', 'Any');
    /** What a group's row says with nothing set: "Any", and for a Without list "None" (it leaves nothing out). */
    const anyOf = (id: ListId): string => NONE_OF.has(id) ? say('discovery_filter_none', 'None') : any;
    /** A filter's name for the eye. */
    const nameOf = (id: FilterId): string => say(NAMES[id][0], NAMES[id][1]);
    /** A row in Jellyfin's own item markup (JE.discoveryMenu's). */
    const menuRow = (name: string, iconName: string, iconHidden: boolean) => {
        const menu = JE.discoveryMenu;
        if (!menu) throw new Error('Discovery menu is not loaded');
        return menu.menuRow(name, iconName, iconHidden);
    };

    /** A field to type in, in the menu's own style; `mode` is the keyboard a touch screen shows. */
    const field = (group: string, placeholder: string, mode: 'numeric' | 'decimal' | 'search'): HTMLInputElement => {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'jellyseerr-menu-input';
        input.inputMode = mode;
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.placeholder = placeholder;
        input.setAttribute('aria-label', `${group}: ${placeholder}`);
        return input;
    };
    /** A quiet line of words under a group's row. (Its words keep their own direction where they are in another language than the page's.) */
    const note = (words: string): HTMLElement => {
        const line = document.createElement('div');
        line.className = 'jellyseerr-menu-note';
        const text = document.createElement('bdi');
        text.textContent = words;
        line.appendChild(text);
        return line;
    };
    /** Puts new words in a note (only when they differ, so a live region is not read again). */
    const sayIn = (line: HTMLElement, words: string): void => {
        const text = line.firstElementChild ?? line;
        if (text.textContent !== words) text.textContent = words;
    };

    // ---- A range: two fields ----------------------------------------------------------------
    /** What a usable range says on its group's row. */
    const sayRange = (id: RangeId, [from, to]: Range): string => {
        const unit = id === 'runtime' ? ` ${say('discovery_filter_minutes', 'min')}` : '';
        const [low, high] = [sayBound(id, from, locale), sayBound(id, to, locale)];
        if (from && to) return `${say('discovery_filter_range', '{from} to {to}', { from: low, to: high })}${unit}`;
        return `${from ? say('discovery_filter_from_value', 'From {from}', { from: low }) : say('discovery_filter_to_value', 'Up to {to}', { to: high })}${unit}`;
    };
    /** A range filter's group: two fields, and under them what they take. */
    function rangeGroup(id: RangeId): MenuGroup {
        const set = usable(id, options.selection()[id]);
        return {
            id, name: nameOf(id), any, set: set[0] !== '' || set[1] !== '', value: sayRange(id, set),
            describe() { const now = usable(id, options.selection()[id]); return { value: sayRange(id, now), set: now[0] !== '' || now[1] !== '' }; },
            build(host: HTMLElement, handle: GroupHandle) {
                const row = document.createElement('div');
                row.className = 'jellyseerr-menu-range';
                const mode = id === 'score' ? 'decimal' : 'numeric';
                const from = field(nameOf(id), say('discovery_filter_from', 'From'), mode);
                const to = field(nameOf(id), say('discovery_filter_to', 'To'), mode);
                const now = options.selection()[id];
                from.value = now?.[0] ?? '';
                to.value = now?.[1] ?? '';
                const dash = document.createElement('span');
                dash.setAttribute('aria-hidden', 'true');
                dash.textContent = '–';
                row.append(from, dash, to);
                // Over the fields, their labels, in sight once a field is typed in too (a placeholder goes then): a row
                // of their own, so the fields and the dash between them stand as they did.
                const labels = document.createElement('div');
                labels.className = 'jellyseerr-menu-range jellyseerr-menu-range-labels';
                const spacer = document.createElement('span');
                spacer.className = 'jellyseerr-menu-range-spacer';
                spacer.setAttribute('aria-hidden', 'true');
                spacer.textContent = '–';
                const labelFor = (input: HTMLInputElement, words: string): HTMLLabelElement => {
                    input.id = `jellyseerr-menu-bound-${++hints}`;
                    input.placeholder = '';
                    const text = document.createElement('label');
                    text.className = 'jellyseerr-menu-bound';
                    text.htmlFor = input.id;
                    text.textContent = words;
                    return text;
                };
                labels.append(labelFor(from, say('discovery_filter_from', 'From')), spacer, labelFor(to, say('discovery_filter_to', 'To')));
                host.appendChild(labels);
                // Under the fields: what they take. While what is typed cannot be used, that is said there instead, in words.
                const [hintKey, hintWords, errorKey, errorWords] = HINTS[id];
                const hint = note(say(hintKey, hintWords));
                hint.id = `jellyseerr-menu-hint-${++hints}`;
                hint.setAttribute('aria-live', 'polite');
                for (const input of [from, to]) input.setAttribute('aria-describedby', hint.id);
                host.append(row, hint);
                let timer = 0;
                /** Takes what is typed: marks what cannot be used, says the range on the group's row, and changes the selection. */
                const take = (): void => {
                    window.clearTimeout(timer);
                    const typed: Range = [from.value, to.value];
                    // A bound that cannot be used is marked and left out; the other still counts.
                    const bad = [!isBound(id, typed[0], false), !isBound(id, typed[1], true)] as const;
                    [from, to].forEach((input, index) => {
                        if (bad[index]) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
                    });
                    sayIn(hint, bad[0] || bad[1] ? say(errorKey, errorWords) : say(hintKey, hintWords));
                    hint.toggleAttribute('data-error', bad[0] || bad[1]);
                    const next = usable(id, typed);
                    const before = usable(id, options.selection()[id]);
                    if (next[0] === before[0] && next[1] === before[1]) return;
                    const isSet = next[0] !== '' || next[1] !== '';
                    handle.say(isSet ? sayRange(id, next) : '', isSet);
                    options.change({ ...options.selection(), [id]: isSet ? next : undefined });
                };
                /** The page in view, as its address names it (not the filters it shows). */
                const pageNow = (): string => {
                    const hash = window.location.hash;
                    return `${JE.discoveryAddress?.withoutOwn?.(hash) ?? hash}|${JE.discoveryAddress?.categoryOfHash?.(hash) ?? ''}`;
                };
                for (const input of [from, to]) {
                    input.addEventListener('input', () => {
                        window.clearTimeout(timer);
                        // (Taken once typing pauses, on the page it was typed on: not after leaving it.)
                        const page = pageNow();
                        timer = window.setTimeout(() => { if (pageNow() === page) take(); }, TYPING_MS);
                    });
                    input.addEventListener('change', take);
                    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); take(); } });
                }
            }
        };
    }

    // ---- A list to tick ---------------------------------------------------------------------
    /** The ticks the row speaks of: on a genre's page its own genre is always applied, so what is said is about the others. */
    const othersOf = (ticked: readonly Picked[], id: ListId): readonly Picked[] => {
        const own = id === 'genres' ? options.ownGenre?.trim().toLocaleLowerCase() ?? '' : '';
        return own && ticked.length > 1 ? ticked.filter(item => item.name.toLocaleLowerCase() !== own) : ticked;
    };
    /**
     * What a list's ticks say on its group's row. A list of all or any of its ticks says which, the names joined as the
     * page's language joins them: "Action, Comedy and Animation", "Family or Kids", "French or Japanese". (Where they
     * don't fit, the row says it short: see shortList.)
     */
    const sayList = (ticked: readonly Picked[], id: ListId): string => {
        const picked = othersOf(ticked, id);
        const rule = listRule(options.selection(), id);
        if (picked.length >= 2 && rule !== '') {
            // (None of them is said as "or" under its Without heading: "gore or horror".)
            const anyRule = rule !== 'all';
            const names = picked.map(item => item.name);
            let joined: string | null = null;
            try {
                joined = new Intl.ListFormat(locale || 'en', { style: 'long', type: anyRule ? 'disjunction' : 'conjunction' }).format(names);
            } catch { joined = null; }
            if (joined) return joined;
            if (picked.length > 2 && rule === 'none') return say('discovery_filter_none_of', 'None of {count}', { count: picked.length });
            if (picked.length > 2) return anyRule ? say('discovery_filter_any_of', 'Any of {count}', { count: picked.length })
                : say('discovery_filter_all_of', 'All of {count}', { count: picked.length });
            const two = { first: names[0] ?? '', second: names[1] ?? '' };
            return anyRule ? say('discovery_filter_either', '{first} or {second}', two) : say('discovery_filter_both', '{first} and {second}', two);
        }
        return picked.map(item => item.name).join(', ');
    };
    /** The same, short, for a row too narrow for the names: "Any of 2", "2 chosen" (none for a single tick). */
    const shortList = (ticked: readonly Picked[], id: ListId): string | undefined => {
        const picked = othersOf(ticked, id);
        if (picked.length < 2) return undefined;
        const rule = listRule(options.selection(), id);
        if (rule === '') return say('discovery_filter_count', '{count} chosen', { count: picked.length });
        if (rule === 'none') return say('discovery_filter_none_of', 'None of {count}', { count: picked.length });
        return rule === 'any' ? say('discovery_filter_any_of', 'Any of {count}', { count: picked.length })
            : say('discovery_filter_all_of', 'All of {count}', { count: picked.length });
    };
    /** What is ticked in a list now. */
    const pickedOf = (id: ListId): readonly Picked[] => options.selection()[id] ?? [];
    /** What a long list's search field says it searches. */
    const searchWord = (id: ListId): string => id === 'genres' || id === 'withoutGenres' ? say('discovery_filter_search_genres', 'Search genres')
        : id === 'services' ? say('discovery_filter_search_services', 'Search services')
            : id === 'language' || id === 'withoutLanguage' ? say('discovery_filter_search_languages', 'Search languages') : say('discovery_filter_search', 'Search');
    /** Whether the viewer chooses how several ticks in a list count (not where the page names that list). */
    const matchable = (id: ListId): id is MatchId => isMatchId(id) && !(options.fixedAll ?? []).includes(id);
    // Each list's all / any choice, to be marked idle while fewer than two are ticked (it changes nothing then).
    const matchLines = new Map<ListId, HTMLElement>();
    /** Marks a list's choice idle or not, by its ticks now (on a genre's page, not counting its own genre). */
    const markIdle = (id: ListId, ticked: readonly Picked[]): void => {
        const own = id === 'genres' ? options.ownGenre?.trim().toLocaleLowerCase() ?? '' : '';
        const count = own ? ticked.filter(item => item.name.toLocaleLowerCase() !== own).length : ticked.length;
        matchLines.get(id)?.toggleAttribute('data-idle', count < 2);
    };
    /**
     * How several ticks in a list count, said under the list. Where a title can have several of them, a choice: all of
     * the ones ticked, or any of them (each said as Seerr's own rule where it can't be chosen). `handle`: the group's,
     * to say the list again in the choice's words.
     */
    const ruleOf = (id: ListId, handle?: GroupHandle): HTMLElement => {
        if (!matchable(id)) return note(say(RULES[id][0], RULES[id][1]));
        const line = document.createElement('div');
        line.className = 'jellyseerr-menu-note jellyseerr-menu-match';
        const lead = document.createElement('span');
        lead.className = 'jellyseerr-menu-match-lead';
        // (Read as the choice's name, below: not twice.)
        lead.setAttribute('aria-hidden', 'true');
        // (On a genre's page its genre is always applied: the choice is about the others. Titles are on a service, not with it.)
        lead.textContent = id === 'genres' && options.ownGenre
            ? say('discovery_filter_match_given', 'Titles in {genre} and', { genre: options.ownGenre })
            : id === 'services' ? say('discovery_filter_match_on', 'Titles on') : say('discovery_filter_match', 'Titles with');
        // One segmented control, as All / Movies / Series is: a radio group, one stop for the keys.
        const track = document.createElement('div');
        track.className = 'jellyseerr-menu-match-track';
        track.setAttribute('role', 'radiogroup');
        // (Named with its list, for a reader that comes to it on its own: "Genres: Titles with".)
        track.setAttribute('aria-label', say('discovery_filter_match_label', '{filter}: {rule}', { filter: nameOf(id), rule: lead.textContent }));
        line.append(lead, track);
        const halves: ReadonlyArray<readonly ['all' | 'any', string]> = [
            ['all', say('discovery_filter_match_all', 'all ticked')], ['any', say('discovery_filter_match_any', 'any ticked')]
        ];
        const buttons = halves.map(([value, words]) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'jellyseerr-menu-match-btn';
            button.setAttribute('role', 'radio');
            button.dataset.match = value;
            // (Under its words, the same words as the half in use has them, out of sight: each half is as wide as it is
            // when chosen, so choosing, or ticking a second, never moves the choice or the list under it.)
            const reserve = document.createElement('span');
            reserve.className = 'jellyseerr-menu-match-reserve';
            reserve.setAttribute('aria-hidden', 'true');
            reserve.textContent = words;
            button.append(words, reserve);
            button.addEventListener('click', () => {
                const now = options.selection();
                if (matchOf(now, id) === value) return;
                // (The default is not kept: a list on its default is said as nothing in the address.)
                const match: { [K in MatchId]?: 'all' | 'any' | undefined } = { ...(now.match ?? {}), [id]: value };
                if (value === MATCH_DEFAULTS[id]) delete match[id];
                paint(value);
                const picked = pickedOf(id);
                options.change({ ...now, match: Object.keys(match).length > 0 ? match : undefined });
                handle?.say(sayList(picked, id), picked.length > 0, shortList(picked, id));
            });
            return button;
        });
        /** Marks the choice in use; only it takes the keys' stop. */
        const paint = (value: string): void => buttons.forEach(button => {
            const on = button.dataset.match === value;
            button.setAttribute('aria-checked', String(on));
            button.tabIndex = on ? 0 : -1;
        });
        paint(matchOf(options.selection(), id));
        matchLines.set(id, line);
        markIdle(id, pickedOf(id));
        // Left and right move between the two and choose, as in any radio group (up and down are the menu's rows); on a
        // TV they only move, and OK chooses, so passing over the choice never reloads the list.
        track.addEventListener('keydown', event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            const focused = document.activeElement;
            const at = focused instanceof HTMLButtonElement ? buttons.indexOf(focused) : -1;
            const forward = (event.key === 'ArrowRight') !== (getComputedStyle(track).direction === 'rtl');
            const next = buttons[at + (forward ? 1 : -1)];
            if (at < 0 || !next) return;
            event.preventDefault();
            event.stopPropagation();
            // (The choice is held in sight over the list: the list stays where it is.)
            next.focus({ preventScroll: true });
            if (!document.documentElement.classList.contains('layout-tv')) next.click();
        });
        track.append(...buttons);
        return line;
    };
    /**
     * A row that is ticked or not; pressing it changes that and the selection. Its mark is a box,
     * empty or ticked (several of a list can be), where a list of which one is chosen has a tick.
     * `given`: ticked whatever is pressed (every title has it already), and said so.
     */
    function tickRow(id: ListId, item: Picked, handle: GroupHandle, onToggle?: (chosen: boolean, row: HTMLElement) => void, given = false): HTMLElement {
        const chosenNow = given || pickedOf(id).some(entry => entry.id === item.id);
        /** The row's mark: a box, ticked or empty. */
        const box = (chosen: boolean): string => chosen ? 'check_box' : 'check_box_outline_blank';
        const { item: row } = menuRow(item.name, box(chosenNow), false);
        row.classList.add('jellyseerr-menu-tick');
        row.setAttribute('role', 'checkbox');
        row.setAttribute('aria-checked', String(chosenNow));
        // (Ticked in its partner list, "Ticked under Original language": ticking it here moves it.)
        const partner = PARTNERS[id];
        if (!given && !chosenNow && partner && pickedOf(partner).some(entry => entry.id === item.id)) {
            const elsewhere = document.createElement('div');
            elsewhere.className = 'listItemBodyText secondary jellyseerr-menu-given jellyseerr-menu-elsewhere';
            elsewhere.textContent = say('discovery_filter_ticked_under', 'Ticked under {list}', { list: nameOf(partner) });
            row.querySelector('.actionsheetListItemBody')?.appendChild(elsewhere);
        }
        if (given) {
            row.setAttribute('aria-disabled', 'true');
            // (Ticked by the page itself, which the row says under its name: why it can't be unticked here, and why any of
            // the others still means titles in it.)
            const why = document.createElement('div');
            why.className = 'listItemBodyText secondary jellyseerr-menu-given';
            why.textContent = say('discovery_filter_given', 'Included by this page');
            row.querySelector('.actionsheetListItemBody')?.appendChild(why);
            return row;
        }
        row.addEventListener('click', () => {
            const before = pickedOf(id);
            const chosen = !before.some(entry => entry.id === item.id);
            row.querySelector('.jellyseerr-menu-elsewhere')?.remove();
            const next = chosen ? [...before, item] : before.filter(entry => entry.id !== item.id);
            row.setAttribute('aria-checked', String(chosen));
            const tick = row.querySelector('.actionsheetMenuItemIcon');
            if (tick) { tick.classList.remove(box(!chosen)); tick.classList.add(box(chosen)); }
            handle.say(sayList(next, id), next.length > 0, shortList(next, id));
            markIdle(id, next);
            let selection = withList(options.selection(), id, next);
            // (A genre wanted is not left out too, nor the other way round: ticked here, it leaves the partner list.)
            const other = partner ? pickedOf(partner) : [];
            if (partner && chosen && other.some(entry => entry.id === item.id)) {
                const rest = other.filter(entry => entry.id !== item.id);
                selection = withList(selection, partner, rest);
                handle.other?.(partner, sayList(rest, partner), rest.length > 0, shortList(rest, partner));
            }
            options.change(selection);
            onToggle?.(chosen, row);
        });
        return row;
    }
    /** A row's name with the letters a search found shown stronger; the whole name again for no search (`at` -1). */
    function showFound(row: HTMLElement, name: string, at: number, length: number): void {
        const text = row.querySelector('.actionSheetItemText');
        if (!text) return;
        if (at < 0 || length === 0) { text.textContent = name; return; }
        const found = document.createElement('span');
        found.className = 'jellyseerr-menu-found';
        found.textContent = name.slice(at, at + length);
        // (In one run of text, so a space beside the found letters is kept: "WWE Network".)
        const whole = document.createElement('span');
        whole.append(name.slice(0, at), found, name.slice(at + length));
        text.replaceChildren(whole);
    }
    /**
     * A list filter's group: the whole list to tick. `first`: the ids put at the head of a long list
     * (with what is ticked already), the rest in the list's own order after a line.
     */
    function listGroup(id: ListId, load: () => Promise<Array<{ label?: string | undefined; items: readonly Picked[] }>>,
        first: readonly string[] = [], given: (item: Picked) => boolean = () => false): MenuGroup {
        const picked = pickedOf(id);
        return {
            id, name: nameOf(id), any: anyOf(id), set: picked.length > 0, value: sayList(picked, id), short: shortList(picked, id),
            describe() { const now = pickedOf(id); return { value: sayList(now, id), set: now.length > 0, short: shortList(now, id) }; },
            build(host: HTMLElement, handle: GroupHandle) {
                const waiting = note(say('discovery_filter_loading', 'Loading…'));
                host.appendChild(waiting);
                load().then(sections => {
                    if (!host.isConnected) return;
                    waiting.remove();
                    const list = document.createElement('div');
                    list.className = 'jellyseerr-menu-list';
                    const none = note(say('discovery_filter_no_match', 'No match.'));
                    none.hidden = true;
                    const long = sections.reduce((count, section) => count + section.items.length, 0) > SEARCHABLE_FROM;
                    const rows: Array<{ row: HTMLElement; name: string }> = [];
                    /** Adds a row to the list, and to the rows a search goes through. */
                    const add = (item: Picked): void => {
                        const row = tickRow(id, item, handle, undefined, given(item));
                        rows.push({ row, name: item.name });
                        list.appendChild(row);
                    };
                    // What is ticked but not in the list (an address can name it) is at its head, ticked, so it can be seen and unticked.
                    const listed = new Set(sections.flatMap(section => section.items.map(item => item.id)));
                    for (const item of pickedOf(id)) if (!listed.has(item.id)) add(item);
                    // A long list opens with what is ticked in it, and what is likeliest wanted, at its head.
                    const lifted = new Set(long && sections.length === 1 ? [...pickedOf(id).map(item => item.id), ...first] : []);
                    for (const section of sections) {
                        if (section.label) {
                            const heading = document.createElement('div');
                            heading.className = 'jellyseerr-menu-label';
                            heading.textContent = section.label;
                            list.appendChild(heading);
                        }
                        // (In the order they were ticked, as the group's row and the page's line say them.)
                        const head = [...lifted].map(wanted => section.items.find(item => item.id === wanted))
                            .filter((item): item is Picked => item !== undefined);
                        for (const item of head) add(item);
                        if (head.length > 0 && head.length < section.items.length) {
                            const rule = document.createElement('div');
                            rule.className = 'jellyseerr-menu-list-rule';
                            rule.setAttribute('role', 'separator');
                            list.appendChild(rule);
                        }
                        for (const item of section.items) if (!lifted.has(item.id)) add(item);
                    }
                    const rule = ruleOf(id, handle);
                    if (long) {
                        // The list is in the menu's one scroll, under its group's row and this field, which stay in sight
                        // (with how several ticks count, so it can be read whatever part of the list is in view).
                        const whole = Array.from(list.children);
                        const search = field(nameOf(id), searchWord(id), 'search');
                        search.classList.add('jellyseerr-menu-search');
                        const bar = document.createElement('div');
                        bar.className = 'jellyseerr-menu-searchbar';
                        bar.appendChild(search);
                        search.addEventListener('input', () => {
                            const wanted = search.value.trim().toLocaleLowerCase();
                            if (wanted === '') {
                                for (const entry of rows) showFound(entry.row, entry.name, -1, 0);
                                list.replaceChildren(...whole);
                                none.hidden = true;
                                handle.placed();
                                return;
                            }
                            // Nearest first: a name that begins with it, then a word of the name that does, then anywhere in it.
                            const found = rows.map((entry, index) => {
                                const at = entry.name.toLocaleLowerCase().indexOf(wanted);
                                const rank = at < 0 ? -1 : at === 0 ? 0 : /[\p{L}\p{N}]/u.test(entry.name[at - 1] ?? '') ? 2 : 1;
                                return { ...entry, index, at, rank };
                            }).filter(entry => entry.rank >= 0).sort((a, b) => a.rank - b.rank || a.index - b.index);
                            for (const entry of found) showFound(entry.row, entry.name, entry.at, wanted.length);
                            // (A list's own headings and its line mean nothing over part of it.)
                            list.replaceChildren(...found.map(entry => entry.row));
                            none.hidden = found.length > 0;
                            handle.placed();
                        });
                        bar.appendChild(rule);
                        host.appendChild(bar);
                    } else host.appendChild(rule);
                    host.append(list, none);
                    handle.placed();
                }).catch(() => {
                    sayIn(waiting, say('discovery_filter_unavailable', 'Could not load these.'));
                });
            }
        };
    }

    // ---- Keywords: searched for ---------------------------------------------------------------
    /** A keyword filter's group: the keywords chosen, and a field to search for more. */
    function keywordGroup(id: 'keywords' | 'without'): MenuGroup {
        const picked = pickedOf(id);
        return {
            id, name: nameOf(id), any: anyOf(id), set: picked.length > 0, value: sayList(picked, id), short: shortList(picked, id),
            describe() { const now = pickedOf(id); return { value: sayList(now, id), set: now.length > 0, short: shortList(now, id) }; },
            build(host: HTMLElement, handle: GroupHandle) {
                // The keywords chosen stay listed (ticked) above the field; what the search finds comes under it.
                const chosen = document.createElement('div');
                chosen.className = 'jellyseerr-menu-list';
                const rule = ruleOf(id, handle);
                const found = document.createElement('div');
                found.className = 'jellyseerr-menu-list';
                /** Lists a chosen keyword above the field, ticked; taken away when it is pressed again. */
                const keep = (item: Picked): void => {
                    chosen.appendChild(tickRow(id, item, handle, (isChosen, row) => {
                        if (!isChosen) {
                            // (Taken away with the keys on it, they go to the next one kept, else the one before, else the
                            // field: where they were, not back to the top of the menu.)
                            const held = row.contains(document.activeElement);
                            const sibling = row.nextElementSibling ?? row.previousElementSibling;
                            const next = sibling instanceof HTMLElement ? sibling : null;
                            row.remove();
                            if (held) (next ?? search).focus();
                        }
                        rule.hidden = chosen.childElementCount === 0;
                        if (!isChosen && search.value.trim() === '') sayStatus(resting());
                        handle.placed();
                    }));
                };
                const search = field(nameOf(id), say('discovery_filter_search_keywords', 'Search keywords'), 'search');
                search.classList.add('jellyseerr-menu-search');
                const bar = document.createElement('div');
                bar.className = 'jellyseerr-menu-searchbar';
                bar.appendChild(search);
                // (How several count sits with the keywords chosen: it shows once there is one.)
                rule.hidden = chosen.childElementCount === 0;
                const status = note('');
                status.hidden = true;
                status.setAttribute('aria-live', 'polite');
                let timer = 0;
                let asking: AbortController | null = null;
                /** Says how the search went under the field ('' hides the line). */
                const sayStatus = (words: string): void => { sayIn(status, words); status.hidden = words === ''; };
                // (At rest, with nothing chosen and nothing typed, the line says what a keyword is.)
                const hint = id === 'without' ? say('discovery_filter_without_hint', 'Titles tagged with these words are left out.')
                    : say('discovery_filter_keywords_hint', 'Words a title is tagged with, such as “heist” or “time travel”.');
                /** What the line says with no search under way. */
                const resting = (): string => search.value.trim().length === 1 ? say('discovery_filter_two_letters', 'Type two letters or more.')
                    : search.value.trim() === '' && chosen.childElementCount === 0 ? hint : '';
                for (const item of pickedOf(id)) keep(item);
                rule.hidden = chosen.childElementCount === 0;
                /** Searches for what is typed (two letters at least), dropping a search still running. */
                const look = (): void => {
                    asking?.abort();
                    const wanted = search.value.trim();
                    found.replaceChildren();
                    if (wanted.length < 2) { sayStatus(resting()); handle.placed(); return; }
                    const request = new AbortController();
                    asking = request;
                    sayStatus(say('discovery_filter_loading', 'Loading…'));
                    data.searchKeywords(wanted, request.signal).then(results => {
                        if (request.signal.aborted || !host.isConnected) return;
                        const fresh = results.filter(item => !pickedOf(id).some(entry => entry.id === item.id)).slice(0, KEYWORD_RESULTS);
                        for (const item of fresh) {
                            const row = found.appendChild(tickRow(id, item, handle, (isChosen, pressed) => {
                                // Chosen: it joins the ones kept above the field, and the field is ready for the next.
                                if (isChosen) {
                                    pressed.remove();
                                    keep(item);
                                    window.clearTimeout(timer);
                                    asking?.abort();
                                    search.value = '';
                                    found.replaceChildren();
                                    sayStatus(resting());
                                    search.focus();
                                }
                                rule.hidden = chosen.childElementCount === 0;
                                handle.placed();
                            }));
                            showFound(row, item.name, item.name.toLocaleLowerCase().indexOf(wanted.toLocaleLowerCase()), wanted.length);
                        }
                        rule.hidden = chosen.childElementCount === 0;
                        sayStatus(fresh.length === 0 ? say('discovery_filter_no_match', 'No match.') : '');
                        handle.placed();
                    }).catch(() => {
                        if (!request.signal.aborted) sayStatus(say('discovery_filter_unavailable', 'Could not load these.'));
                    });
                };
                search.addEventListener('input', () => { window.clearTimeout(timer); timer = window.setTimeout(look, SEARCH_MS); });
                search.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); window.clearTimeout(timer); look(); } });
                // How several count sits with the keywords chosen, above the field and what it finds.
                host.append(chosen, rule, bar, found, status);
                sayStatus(resting());
            }
        };
    }

    const groups: MenuGroup[] = [];
    for (const id of options.offered) {
        if (isRangeId(id)) groups.push(rangeGroup(id));
        else if (id === 'role') groups.push(listGroup(id, async () => [{ items: options.roles?.() ?? [] }]));
        else if (id === 'genres') {
            const own = options.ownGenre?.trim().toLocaleLowerCase() ?? '';
            groups.push(listGroup(id, async () => [{ items: await data.genres() }], [], item => own !== '' && item.name.toLocaleLowerCase() === own));
        }
        // A genre's page can't leave out its own genre: it is not offered there.
        else if (id === 'withoutGenres') {
            const own = options.ownGenre?.trim().toLocaleLowerCase() ?? '';
            groups.push(listGroup(id, async () => [{ items: (await data.genres()).filter(item => own === '' || item.name.toLocaleLowerCase() !== own) }]));
        }
        // The viewer's own language is the likeliest one wanted.
        else if (id === 'language' || id === 'withoutLanguage') {
            groups.push(listGroup(id, async () => [{ items: await data.languages(locale) }], [locale.split('-')[0]?.toLowerCase() ?? '']));
        } else if (id === 'services') groups.push(listGroup(id, async () => [{ items: await data.services() }]));
        else if (id === 'rating') {
            // (Only the page's kinds; one of another kind ticked still shows, at the head, to be unticked.)
            groups.push(listGroup(id, async () => {
                const lists = (await data.ratings()).filter(list => !options.kinds || options.kinds.includes(list.kind));
                // (A kind's heading only where two are listed: over the only block it says nothing.)
                return lists.map(list => ({
                    label: lists.length < 2 ? undefined : list.kind === 'movie' ? say('jellyseerr_quota_label_movie', 'Movies') : say('jellyseerr_quota_label_tv', 'Series'),
                    items: list.ratings
                }));
            }));
        } else groups.push(keywordGroup(id));
    }
    return groups;
}


/**
 * What Undo says it undoes, from what was set before the last change and what is set now: the first piece it set, as
 * said alone ("Undo “With dragon”"); else a rule it switched ("Undo “all ticked” in Keywords"); else a piece it took
 * away ("Put back “Not Thriller”"); else "Undo".
 */
export function undoWords({ offered, label: say, locale, ownGenre, before, now }: UndoWordsOptions): string {
    const words = (selection: FilterSelection): string[] =>
        filterTokens({ offered, label: say, locale, selection, ownGenre }).map(token => token.alone ?? token.words);
    const had = new Set(words(before));
    const added = words(now).find(word => !had.has(word));
    if (added) return say('discovery_filters_undo_what', 'Undo “{change}”', { change: added });
    const ruled = (Object.keys(MATCH_DEFAULTS) as MatchId[]).find(id => matchOf(before, id) !== matchOf(now, id));
    if (ruled) {
        const rule = matchOf(now, ruled) === 'any' ? say('discovery_filter_match_any', 'any ticked') : say('discovery_filter_match_all', 'all ticked');
        return say('discovery_filters_undo_rule', 'Undo “{rule}” in {filter}', { rule, filter: say(NAMES[ruled][0], NAMES[ruled][1]) });
    }
    const has = new Set(words(now));
    const removed = words(before).find(word => !has.has(word));
    return removed ? say('discovery_filters_undo_back', 'Put back “{piece}”', { piece: removed }) : say('discovery_filters_undo', 'Undo');
}
