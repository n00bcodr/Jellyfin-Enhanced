// The Filters menu's groups: for each filter a section offers, the row that says what is set and
// the body it opens to. A range is two fields to type in; a list is the whole list to tick, with a
// field to narrow it when it is long; keywords are searched for. What is set takes effect at once.
// Also what is set, in words, one piece per thing that can be taken away again (the line of
// filters under a section's header).
import type { SeerrDiscoveryHost } from '../host-discovery';
import { isBound, isRangeId, isReversed } from './filters';
import type {
    FilterId, FilterMenuOptions, FilterSelection, FilterToken, GroupHandle, ListId, MenuGroup, Picked, Range, RangeId, Say
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
    without: ['discovery_filter_without', 'Without keywords']
});
/** What a range's fields take, said under them; and what is said there when what is typed cannot be used. */
const HINTS: Readonly<Record<RangeId, readonly [string, string, string, string]>> = Object.freeze({
    // (The example dates are written with the hyphen and the space that do not break, so a date is never split, nor left alone on a line.)
    year: ['discovery_filter_year_hint', 'A year, a\u00a0month\u00a0(2015‑06) or a\u00a0day\u00a0(2015‑06‑30).', 'discovery_filter_year_error', 'Type a\u00a0year\u00a0(2015), a\u00a0month\u00a0(2015‑06) or a\u00a0day\u00a0(2015‑06‑30).'],
    score: ['discovery_filter_score_hint', 'From 0 to 10; one decimal, such as 7.5.', 'discovery_filter_score_error', 'Type a score from 0 to 10, such as 7.5.'],
    votes: ['discovery_filter_votes_hint', 'How many people have scored it: a whole number.', 'discovery_filter_number_error', 'Type a whole number, such as 500.'],
    runtime: ['discovery_filter_runtime_hint', 'In whole minutes.', 'discovery_filter_number_error', 'Type a whole number, such as 500.']
});
/** How several ticks in one list count, said under the list: Seerr's own rule for each. */
const RULES: Readonly<Record<ListId, readonly [string, string]>> = Object.freeze({
    role: ['discovery_filter_rule_any', 'Titles with any of the ones ticked.'], genres: ['discovery_filter_rule_all', 'Titles with all of the ones ticked.'],
    language: ['discovery_filter_rule_any', 'Titles with any of the ones ticked.'], rating: ['discovery_filter_rule_any', 'Titles with any of the ones ticked.'],
    services: ['discovery_filter_rule_any', 'Titles with any of the ones ticked.'], keywords: ['discovery_filter_rule_all', 'Titles with all of the ones ticked.'],
    without: ['discovery_filter_rule_none', 'Titles with none of the ones ticked.']
});

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

/** What is set, piece by piece, in the order the menu has it: a range is one piece, a list one piece per thing ticked. */
export function filterTokens({ offered, label: say, locale, selection }: {
    readonly offered: readonly FilterId[]; readonly label: Say; readonly locale: string; readonly selection: FilterSelection;
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
        for (const item of selection[id] ?? []) {
            tokens.push({
                // A keyword and a language need a word to be read on their own ("With robot", "Originally in Japanese"); a genre, a rating, a service and a role say what they are.
                words: id === 'without' ? say('discovery_filter_set_without', 'Without {name}', { name: item.name })
                    : id === 'keywords' ? say('discovery_filter_set_with', 'With {name}', { name: item.name })
                        : id === 'language' ? say('discovery_filter_set_language', 'Originally in {name}', { name: item.name }) : item.name,
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
                for (const input of [from, to]) {
                    input.addEventListener('input', () => { window.clearTimeout(timer); timer = window.setTimeout(take, TYPING_MS); });
                    input.addEventListener('change', take);
                    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); take(); } });
                }
            }
        };
    }

    // ---- A list to tick ---------------------------------------------------------------------
    /** What a list's ticks say on its group's row. */
    const sayList = (picked: readonly Picked[]): string => picked.length <= 2
        ? picked.map(item => item.name).join(', ')
        : say('discovery_filter_count', '{count} chosen', { count: picked.length });
    /** What is ticked in a list now. */
    const pickedOf = (id: ListId): readonly Picked[] => options.selection()[id] ?? [];
    /** The note that says how several ticks in a list count. */
    const ruleOf = (id: ListId): HTMLElement => note(say(RULES[id][0], RULES[id][1]));
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
        if (given) { row.setAttribute('aria-disabled', 'true'); return row; }
        row.addEventListener('click', () => {
            const before = pickedOf(id);
            const chosen = !before.some(entry => entry.id === item.id);
            const next = chosen ? [...before, item] : before.filter(entry => entry.id !== item.id);
            row.setAttribute('aria-checked', String(chosen));
            const tick = row.querySelector('.actionsheetMenuItemIcon');
            if (tick) { tick.classList.remove(box(!chosen)); tick.classList.add(box(chosen)); }
            handle.say(sayList(next), next.length > 0);
            options.change(withList(options.selection(), id, next));
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
    function listGroup(id: ListId, load: () => Promise<Array<{ label?: string; items: readonly Picked[] }>>,
        first: readonly string[] = [], given: (item: Picked) => boolean = () => false): MenuGroup {
        const picked = pickedOf(id);
        return {
            id, name: nameOf(id), any, set: picked.length > 0, value: sayList(picked),
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
                    // A long list opens with what is ticked in it, and what is likeliest wanted, at its head.
                    const lifted = new Set(long && sections.length === 1 ? [...pickedOf(id).map(item => item.id), ...first] : []);
                    for (const section of sections) {
                        if (section.label) {
                            const heading = document.createElement('div');
                            heading.className = 'jellyseerr-menu-label';
                            heading.textContent = section.label;
                            list.appendChild(heading);
                        }
                        const head = section.items.filter(item => lifted.has(item.id));
                        for (const item of head) add(item);
                        if (head.length > 0 && head.length < section.items.length) {
                            const rule = document.createElement('div');
                            rule.className = 'jellyseerr-menu-list-rule';
                            rule.setAttribute('role', 'separator');
                            list.appendChild(rule);
                        }
                        for (const item of section.items) if (!lifted.has(item.id)) add(item);
                    }
                    if (long) {
                        // The list is in the menu's one scroll, under its group's row and this field, which stay in sight.
                        const whole = Array.from(list.children);
                        const search = field(nameOf(id), say('discovery_filter_search', 'Search'), 'search');
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
                        host.appendChild(bar);
                    }
                    host.append(ruleOf(id), list, none);
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
            id, name: nameOf(id), any, set: picked.length > 0, value: sayList(picked),
            build(host: HTMLElement, handle: GroupHandle) {
                // The keywords chosen stay listed (ticked) above the field; what the search finds comes under it.
                const chosen = document.createElement('div');
                chosen.className = 'jellyseerr-menu-list';
                const rule = ruleOf(id);
                const found = document.createElement('div');
                found.className = 'jellyseerr-menu-list';
                /** Lists a chosen keyword above the field, ticked; taken away when it is pressed again. */
                const keep = (item: Picked): void => {
                    chosen.appendChild(tickRow(id, item, handle, (isChosen, row) => {
                        if (!isChosen) row.remove();
                        rule.hidden = chosen.childElementCount + found.childElementCount === 0;
                        handle.placed();
                    }));
                };
                const search = field(nameOf(id), say('discovery_filter_search_keywords', 'Search keywords'), 'search');
                search.classList.add('jellyseerr-menu-search');
                const bar = document.createElement('div');
                bar.className = 'jellyseerr-menu-searchbar';
                bar.appendChild(search);
                for (const item of pickedOf(id)) keep(item);
                // (How several count is said once there is one to tick.)
                rule.hidden = chosen.childElementCount === 0;
                const status = note('');
                status.hidden = true;
                status.setAttribute('aria-live', 'polite');
                let timer = 0;
                let asking: AbortController | null = null;
                /** Says how the search went under the field ('' hides the line). */
                const sayStatus = (words: string): void => { sayIn(status, words); status.hidden = words === ''; };
                /** Searches for what is typed (two letters at least), dropping a search still running. */
                const look = (): void => {
                    asking?.abort();
                    const wanted = search.value.trim();
                    found.replaceChildren();
                    if (wanted.length < 2) { sayStatus(''); handle.placed(); return; }
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
                                    sayStatus('');
                                    search.focus();
                                }
                                rule.hidden = chosen.childElementCount + found.childElementCount === 0;
                                handle.placed();
                            }));
                            showFound(row, item.name, item.name.toLocaleLowerCase().indexOf(wanted.toLocaleLowerCase()), wanted.length);
                        }
                        rule.hidden = chosen.childElementCount + found.childElementCount === 0;
                        sayStatus(fresh.length === 0 ? say('discovery_filter_no_match', 'No match.') : '');
                        handle.placed();
                    }).catch(() => {
                        if (!request.signal.aborted) sayStatus(say('discovery_filter_unavailable', 'Could not load these.'));
                    });
                };
                search.addEventListener('input', () => { window.clearTimeout(timer); timer = window.setTimeout(look, SEARCH_MS); });
                search.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); window.clearTimeout(timer); look(); } });
                host.append(chosen, bar, rule, found, status);
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
        // The viewer's own language is the likeliest one wanted.
        else if (id === 'language') groups.push(listGroup(id, async () => [{ items: await data.languages(locale) }], [locale.split('-')[0]?.toLowerCase() ?? '']));
        else if (id === 'services') groups.push(listGroup(id, async () => [{ items: await data.services() }]));
        else if (id === 'rating') {
            groups.push(listGroup(id, async () => (await data.ratings()).map(list => ({
                label: list.kind === 'movie' ? say('jellyseerr_quota_label_movie', 'Movies') : say('jellyseerr_quota_label_tv', 'Series'),
                items: list.ratings
            }))));
        } else groups.push(keywordGroup(id));
    }
    return groups;
}

