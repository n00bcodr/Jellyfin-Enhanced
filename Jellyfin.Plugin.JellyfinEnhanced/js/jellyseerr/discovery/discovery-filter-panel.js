// /js/jellyseerr/discovery/discovery-filter-panel.js
// The Filters menu's groups: for each filter a section offers, the row that says what is set and
// the body it opens to. A range is two fields to type in; a list is the whole list to tick, with a
// field to narrow it when it is long; keywords are searched for. What is set takes effect at once.
// Also what is set, in words, one piece per thing that can be taken away again (the line of
// filters under a section's header).
//
// And the section's side of it: the Filters button beside the sort, its menu, the line of what is
// set, the note when nothing matches, and the further-filter selection and the person's titles
// seen, per section (by module name). The pure logic and the lists are in discovery-filters.js.
(function(JE) {
    'use strict';

    /** How long after the last key a typed bound is taken (Enter, or leaving the field, takes it at once). */
    const TYPING_MS = 700;
    const SEARCH_MS = 350;
    /** A list longer than this gets a field to narrow it. */
    const SEARCHABLE_FROM = 15;
    const KEYWORD_RESULTS = 8;
    let hints = 0;

    const NAMES = Object.freeze({
        role: ['discovery_filter_role', 'Role'], year: ['discovery_filter_released', 'Released'], score: ['discovery_filter_score', 'Score'],
        votes: ['discovery_filter_votes', 'Votes'], runtime: ['discovery_filter_runtime', 'Runtime'], genres: ['discovery_filter_genres', 'Genres'],
        language: ['discovery_filter_language', 'Original language'], rating: ['discovery_filter_rating', 'Content rating'],
        services: ['discovery_filter_services', 'Streaming services'], keywords: ['discovery_filter_keywords', 'Keywords'],
        without: ['discovery_filter_without', 'Without keywords']
    });
    /** What a range's fields take, said under them; and what is said there when what is typed cannot be used. */
    const HINTS = Object.freeze({
        // (The example dates are written with the hyphen and the space that do not break, so a date is never split, nor left alone on a line.)
        year: ['discovery_filter_year_hint', 'A year, a month (2015‑06) or a day (2015‑06‑30).', 'discovery_filter_year_error', 'Type a year (2015), a month (2015‑06) or a day (2015‑06‑30).'],
        score: ['discovery_filter_score_hint', 'From 0 to 10; one decimal, such as 7.5.', 'discovery_filter_score_error', 'Type a score from 0 to 10, such as 7.5.'],
        votes: ['discovery_filter_votes_hint', 'How many people have scored it: a whole number.', 'discovery_filter_number_error', 'Type a whole number, such as 500.'],
        runtime: ['discovery_filter_runtime_hint', 'In whole minutes.', 'discovery_filter_number_error', 'Type a whole number, such as 500.']
    });
    /** How several ticks in one list count, said under the list: Seerr's own rule for each. */
    const RULES = Object.freeze({
        role: ['discovery_filter_rule_any', 'Titles with any of the ones ticked.'], genres: ['discovery_filter_rule_all', 'Titles with all of the ones ticked.'],
        language: ['discovery_filter_rule_any', 'Titles with any of the ones ticked.'], rating: ['discovery_filter_rule_any', 'Titles with any of the ones ticked.'],
        services: ['discovery_filter_rule_any', 'Titles with any of the ones ticked.'], keywords: ['discovery_filter_rule_all', 'Titles with all of the ones ticked.'],
        without: ['discovery_filter_rule_none', 'Titles with none of the ones ticked.']
    });
    /** Whether a filter is a typed range (else a list). */
    const isRangeId = id => id === 'year' || id === 'score' || id === 'votes' || id === 'runtime';

    /** The pure logic (discovery-filters.js), read at call time. */
    const logic = () => JE.discoveryFilters || {};

    /**
     * A string in the viewer's language, or the source's English where there is none, with its values put in.
     * @param {string} key - The translation key
     * @param {string} fallback - The English words
     * @param {object} [values] - Values for `{name}` placeholders
     * @returns {string}
     */
    function label(key, fallback, values) {
        const text = typeof JE.t === 'function' ? JE.t(key, values) : '';
        let said = text && text !== key ? text : fallback;
        for (const [name, value] of Object.entries(values ?? {})) said = said.replace(`{${name}}`, String(value));
        return said;
    }

    /**
     * The bounds that can be used, the lower first: a range typed the wrong way round ("2010" to "1990") has one meaning, and is read so.
     * @param {string} id - The range filter
     * @param {string[]|undefined} range - [from, to] as typed
     * @returns {string[]} [from, to] that can be used ('' for none)
     */
    function usable(id, range) {
        const { isReversed, isBound } = logic();
        return !range ? ['', '']
            : isReversed(id, range) ? [range[1].trim(), range[0].trim()]
                : [isBound(id, range[0], false) ? range[0].trim() : '', isBound(id, range[1], true) ? range[1].trim() : ''];
    }
    /**
     * A typed bound as it is said: votes and minutes in the viewer's way of writing numbers; a date or a score as typed.
     * @param {string} id - The range filter
     * @param {string} text - A usable bound
     * @param {string} locale - The page's language
     * @returns {string}
     */
    function sayBound(id, text, locale) {
        if (id !== 'votes' && id !== 'runtime') return text;
        try { return new Intl.NumberFormat(locale || undefined).format(Number(text)); } catch (_) { return text; }
    }

    /**
     * What is set, piece by piece, in the order the menu has it: a range is one piece, a list one piece per thing ticked.
     * @param {object} options
     * @param {string[]} options.offered - The filters the section offers
     * @param {Function} options.label - The string lookup
     * @param {string} options.locale - The page's language
     * @param {object} options.selection - The section's FilterSelection
     * @returns {{words: string, without: (selection: object) => object}[]} Each thing set, in words, and the selection without it
     */
    function filterTokens({ offered, label: say, locale, selection }) {
        const tokens = [];
        for (const id of offered) {
            if (isRangeId(id)) {
                const [from, to] = usable(id, selection[id]);
                if (!from && !to) continue;
                const unit = id === 'runtime' ? ` ${say('discovery_filter_minutes', 'min')}` : '';
                const values = { name: say(NAMES[id][0], NAMES[id][1]), from: `${sayBound(id, from, locale)}${unit}`, to: `${sayBound(id, to, locale)}${unit}` };
                const words = from && to ? say('discovery_filter_set_range', '{name} {from} to {to}', { ...values, from: sayBound(id, from, locale) })
                    : from ? say('discovery_filter_set_from', '{name} from {from}', values) : say('discovery_filter_set_to', '{name} up to {to}', values);
                tokens.push({ words, without: now => ({ ...now, [id]: undefined }) });
                continue;
            }
            for (const item of selection[id] ?? []) {
                tokens.push({
                    // A keyword and a language need a word to be read on their own ("With robot", "Originally in Japanese"); a genre, a rating, a service and a role say what they are.
                    words: id === 'without' ? say('discovery_filter_set_without', 'Without {name}', { name: item.name })
                        : id === 'keywords' ? say('discovery_filter_set_with', 'With {name}', { name: item.name })
                            : id === 'language' ? say('discovery_filter_set_language', 'Originally in {name}', { name: item.name }) : item.name,
                    without(now) {
                        const left = (now[id] ?? []).filter(entry => entry.id !== item.id);
                        return { ...now, [id]: left.length > 0 ? left : undefined };
                    }
                });
            }
        }
        return tokens;
    }

    /**
     * The Filters menu's groups, in the shape of JE.discoveryMenu's MenuGroup.
     * @param {object} options
     * @param {string[]} options.offered - The filters the section offers
     * @param {object} options.data - The lists (createFilterData)
     * @param {string} options.locale - The page's language
     * @param {Function} options.label - The string lookup
     * @param {() => object} options.selection - The section's FilterSelection now
     * @param {(next: object) => void} options.change - Takes the new selection and reloads the list
     * @param {() => object[]} [options.roles] - On a person's page: what that person did across the titles, the most credits first
     * @param {string} [options.ownGenre] - On a genre's page: that genre's name. Every title of the list is in it already, so its row says so and cannot be changed
     * @returns {object[]} The groups
     */
    function filterMenuGroups(options) {
        const { label: say, data, locale } = options;
        const any = say('discovery_filter_any', 'Any');
        /** A filter's name for the eye. */
        const nameOf = id => say(NAMES[id][0], NAMES[id][1]);
        /** A row in Jellyfin's own item markup (JE.discoveryMenu's). */
        const menuRow = (...args) => JE.discoveryMenu.menuRow(...args);

        /**
         * A field to type in, in the menu's own style.
         * @param {string} group - The group's name
         * @param {string} placeholder - What the field takes
         * @param {'numeric'|'decimal'|'search'} mode - The keyboard a touch screen shows
         * @returns {HTMLInputElement}
         */
        const field = (group, placeholder, mode) => {
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
        // (A line's words keep their own direction where they are in another language than the page's.)
        /**
         * A quiet line of words under a group's row.
         * @param {string} words
         * @returns {HTMLElement}
         */
        const note = words => {
            const line = document.createElement('div');
            line.className = 'jellyseerr-menu-note';
            const text = document.createElement('bdi');
            text.textContent = words;
            line.appendChild(text);
            return line;
        };
        /**
         * Puts new words in a note (only when they differ, so a live region is not read again).
         * @param {HTMLElement} line - The note
         * @param {string} words
         */
        const sayIn = (line, words) => {
            const text = line.firstElementChild ?? line;
            if (text.textContent !== words) text.textContent = words;
        };

        // ---- A range: two fields ----------------------------------------------------------------
        /**
         * What a usable range says on its group's row.
         * @param {string} id - The range filter
         * @param {string[]} range - [from, to] that can be used
         * @returns {string}
         */
        const sayRange = (id, [from, to]) => {
            const unit = id === 'runtime' ? ` ${say('discovery_filter_minutes', 'min')}` : '';
            const [low, high] = [sayBound(id, from, locale), sayBound(id, to, locale)];
            if (from && to) return `${say('discovery_filter_range', '{from} to {to}', { from: low, to: high })}${unit}`;
            return `${from ? say('discovery_filter_from_value', 'From {from}', { from: low }) : say('discovery_filter_to_value', 'Up to {to}', { to: high })}${unit}`;
        };
        /**
         * A range filter's group: two fields, and under them what they take.
         * @param {string} id - The range filter
         * @returns {object} The group
         */
        function rangeGroup(id) {
            const set = usable(id, options.selection()[id]);
            return {
                id, name: nameOf(id), any, set: set[0] !== '' || set[1] !== '', value: sayRange(id, set),
                build(host, handle) {
                    const { isBound } = logic();
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
                    const take = () => {
                        window.clearTimeout(timer);
                        const typed = [from.value, to.value];
                        // A bound that cannot be used is marked and left out; the other still counts.
                        const bad = [!isBound(id, typed[0], false), !isBound(id, typed[1], true)];
                        [from, to].forEach((input, index) => {
                            if (bad[index]) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
                        });
                        sayIn(hint, bad[0] || bad[1] ? say(errorKey, errorWords) : say(hintKey, hintWords));
                        hint.toggleAttribute('data-error', bad[0] === true || bad[1] === true);
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
        /**
         * What a list's ticks say on its group's row.
         * @param {object[]} picked
         * @returns {string}
         */
        const sayList = picked => picked.length <= 2
            ? picked.map(item => item.name).join(', ')
            : say('discovery_filter_count', '{count} chosen', { count: picked.length });
        /** What is ticked in a list now. */
        const pickedOf = id => options.selection()[id] ?? [];
        /** The note that says how several ticks in a list count. */
        const ruleOf = id => note(say(RULES[id][0], RULES[id][1]));
        /**
         * A row that is ticked or not; pressing it changes that and the selection. Its mark is a box,
         * empty or ticked (several of a list can be), where a list of which one is chosen has a tick.
         * `given`: ticked whatever is pressed (every title has it already), and said so.
         * @param {string} id - The list filter
         * @param {{id: string, name: string}} item - The thing to tick
         * @param {{say: Function, placed: Function}} handle - The group's handle
         * @param {(chosen: boolean, row: HTMLElement) => void} [onToggle] - After a press
         * @param {boolean} [given] - Ticked by the page itself
         * @returns {HTMLElement} The row
         */
        function tickRow(id, item, handle, onToggle, given = false) {
            const chosenNow = given || pickedOf(id).some(entry => entry.id === item.id);
            /** The row's mark: a box, ticked or empty. */
            const box = chosen => chosen ? 'check_box' : 'check_box_outline_blank';
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
                options.change({ ...options.selection(), [id]: next.length > 0 ? next : undefined });
                onToggle?.(chosen, row);
            });
            return row;
        }
        /**
         * A row's name with the letters a search found shown stronger; the whole name again for no search.
         * @param {HTMLElement} row
         * @param {string} name - The row's whole name
         * @param {number} at - Where the found letters start (-1 for no search)
         * @param {number} length - How many letters were found
         */
        function showFound(row, name, at, length) {
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
         * A list filter's group: the whole list to tick.
         * `first`: the ids put at the head of a long list (with what is ticked already), the rest in
         * the list's own order after a line.
         * @param {string} id - The list filter (not the keyword ones)
         * @param {() => Promise<{label?: string, items: object[]}[]>} load - The list, in sections
         * @param {string[]} [first] - Ids put at the head of a long list
         * @param {(item: object) => boolean} [given] - Ticked by the page itself
         * @returns {object} The group
         */
        function listGroup(id, load, first = [], given = () => false) {
            const picked = pickedOf(id);
            return {
                id, name: nameOf(id), any, set: picked.length > 0, value: sayList(picked),
                build(host, handle) {
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
                        const rows = [];
                        /** Adds a row to the list, and to the rows a search goes through. */
                        const add = item => { const row = tickRow(id, item, handle, undefined, given(item)); rows.push({ row, name: item.name }); list.appendChild(row); };
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
        /**
         * A keyword filter's group: the keywords chosen, and a field to search for more.
         * @param {'keywords'|'without'} id - The keyword filter
         * @returns {object} The group
         */
        function keywordGroup(id) {
            const picked = pickedOf(id);
            return {
                id, name: nameOf(id), any, set: picked.length > 0, value: sayList(picked),
                build(host, handle) {
                    // The keywords chosen stay listed (ticked) above the field; what the search finds comes under it.
                    const chosen = document.createElement('div');
                    chosen.className = 'jellyseerr-menu-list';
                    const rule = ruleOf(id);
                    const found = document.createElement('div');
                    found.className = 'jellyseerr-menu-list';
                    /** Lists a chosen keyword above the field, ticked; taken away when it is pressed again. */
                    const keep = item => chosen.appendChild(tickRow(id, item, handle, (isChosen, row) => {
                        if (!isChosen) row.remove();
                        rule.hidden = chosen.childElementCount + found.childElementCount === 0;
                        handle.placed();
                    }));
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
                    let asking = null;
                    /** Says how the search went under the field ('' hides the line). */
                    const sayStatus = words => { sayIn(status, words); status.hidden = words === ''; };
                    /** Searches for what is typed (two letters at least), dropping a search still running. */
                    const look = () => {
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

        const groups = [];
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

    // ---- A section's further filters ------------------------------------------------------------

    // The further filters set in a section (see discovery-filters.js), by module name.
    const moreFilters = new Map();
    /**
     * The section's selection (empty when nothing is set).
     * @param {string} name - The module name
     * @returns {object}
     */
    const selectionOf = name => moreFilters.get(name) ?? {};
    // A person's titles as last given to be filtered: what the Role list is made of.
    const credits = new Map();
    // Per header: redraws its Filters button, and reloads its list after a change made outside the menu.
    // (`paint(at)`: the keys were on what is being taken away; they go on to the piece at that place, or to the Filters button.)
    const wiring = new WeakMap();
    let filterData = null;

    /**
     * The region whose services and ratings are offered: the user's Seerr streaming region when the
     * admin option is on (once known), else the admin's default region, else the US.
     * @returns {string}
     */
    function adminRegion() {
        if (JE.pluginConfig?.ElsewhereUseSeerrRegion && JE.pluginConfig?.JellyseerrEnabled) {
            JE.jellyseerrAPI?.getStreamingRegion?.();
            const seerrRegion = JE.jellyseerrAPI?.streamingRegion;
            if (seerrRegion) return seerrRegion;
        }
        const region = String(JE.pluginConfig?.DEFAULT_REGION ?? '').trim().toUpperCase();
        return /^[A-Z]{2}$/.test(region) ? region : 'US';
    }
    /**
     * The lists the filters offer, kept for the visit (made anew only should the admin's region change).
     * @returns {object} createFilterData's lists
     */
    function dataOf() {
        const region = adminRegion();
        if (!filterData || filterData.region !== region) {
            filterData = logic().createFilterData({
                region,
                // The lists the further filters offer are asked for like every other lookup of these sections.
                fetch: (path, options) => JE.discoveryFilter?.fetchWithManagedRequest
                    ? JE.discoveryFilter.fetchWithManagedRequest(path, 'filters', options)
                    : Promise.reject(new Error('Discovery requests are not available')),
                fetchGenres: kind => JE.discoveryFilter?.fetchTmdbGenreList
                    ? JE.discoveryFilter.fetchTmdbGenreList(kind)
                    : Promise.reject(new Error('Discovery requests are not available'))
            });
        }
        return filterData;
    }
    /** The All choice of All / Movies / Series. */
    const MIXED = () => JE.discoveryFilter?.MODES?.MIXED ?? 'mixed';
    /**
     * The section's All / Movies / Series choice.
     * @param {string} name - The module name
     * @returns {string}
     */
    const filterModeOf = name => JE.discoveryFilter?.getFilterMode?.(name) ?? MIXED();
    /**
     * Whether an id is one of All / Movies / Series.
     * @param {string} id
     * @returns {boolean}
     */
    const isFilterMode = id => Object.values(JE.discoveryFilter?.MODES ?? { MIXED: 'mixed', MOVIES: 'movies', TV: 'tv' }).includes(id);

    /**
     * Where the page stands when a section's header is held at the top of the screen, just so.
     * @param {HTMLElement} section
     * @param {HTMLElement} header
     * @returns {number}
     */
    function heldAt(section, header) {
        if (typeof JE.discoveryBusy?.heldAt === 'function') return JE.discoveryBusy.heldAt(section, header);
        const bar = parseFloat(section.style.getPropertyValue('--jellyseerr-sticky-top')) || 0;
        const tuck = parseFloat(header.style.getPropertyValue('--jellyseerr-header-tuck')) || 0;
        return section.getBoundingClientRect().top + window.scrollY - bar + tuck + 2;
    }

    /**
     * While the Filters menu is open its section is at least as tall as the screen under Jellyfin's
     * bar. The menu hangs from the section's header: a list a filter has made short (or empty) would
     * otherwise let the page fall back under the open menu and take the header, and the menu, down
     * the screen. So the header can always be brought to the top, and stays where it is.
     * @param {HTMLElement|null} section
     * @param {HTMLElement} header
     * @param {boolean} open - The menu is opening (else closed)
     */
    function roomUnderMenu(section, header, open) {
        if (!section) return;
        const bar = parseFloat(section.style.getPropertyValue('--jellyseerr-sticky-top')) || 0;
        const tuck = parseFloat(header.style.getPropertyValue('--jellyseerr-header-tuck')) || 0;
        section.style.minHeight = open ? `${Math.ceil(window.innerHeight - bar + tuck + 4)}px` : '';
    }

    /**
     * The Filters button: Jellyfin's own filter icon, beside the sort. Its menu holds the section's
     * further filters as groups (see filterMenuGroups), less the ones the admin turned off, and
     * All / Movies / Series too where the tabs are out of sight. While anything it holds is narrowing
     * the list it is in the accent with a dot (as Jellyfin marks its own filter button), and what is
     * set is said in words on a line under the header, each piece with the way to take it away.
     * @param {HTMLElement} header - The section's header
     * @param {string} moduleName - The section's module name
     * @param {'feed'|'person'} scope - A list page's section, or a person's titles
     * @param {() => void} onChange - Reloads the list
     * @param {string} [ownGenre] - On a genre's page: that genre's name
     * @returns {HTMLButtonElement}
     */
    function createFiltersControl(header, moduleName, scope, onChange, ownGenre) {
        injectStyles();
        const { offeredFilters, activeFilterCount, rolesOf } = logic();
        const filtersLabel = label('discovery_filters', 'Filters');
        const clearLabel = label('discovery_filters_clear', 'Clear filters');
        /** The page's language. */
        const localeOf = () => document.documentElement.lang || 'en';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'jellyseerr-filters-btn emby-tab-button emby-button';
        button.setAttribute('aria-haspopup', 'dialog');
        button.setAttribute('aria-expanded', 'false');
        const icon = document.createElement('span');
        icon.className = 'material-icons filter_alt';
        icon.setAttribute('aria-hidden', 'true');
        // On a phone, held, the tabs are out of sight: a choice other than All is then said beside the icon ("Movies").
        const typeWord = document.createElement('span');
        typeWord.className = 'jellyseerr-filters-type';
        // The button's name is what it holds: its own name (out of sight; the icon says it to the eye), with how many
        // filters are set, and the type's word where that shows. So what a screen reader hears is what is seen.
        const name = document.createElement('span');
        name.className = 'jellyseerr-filters-name';
        // (A space between the two, for a reader that would run them together; it takes no room in the button.)
        button.append(icon, name, ' ', typeWord);
        const offered = offeredFilters(scope, JE.pluginConfig);
        /** Whether the section offers any further filter. */
        const offersMore = () => offered.length > 0;
        /** The header's All / Movies / Series picker, where the header has the tabs. */
        const typeOf = () => {
            const tabs = header.querySelector('[data-type-group]');
            return tabs ? JE.discoveryFilter?.typePickerOf?.(tabs) : undefined;
        };
        /**
         * The line of what is set, under the header (it is not held with it): made, redrawn, or taken away.
         * @param {number} [focusAt] - Where the keys go after a piece is taken away (-1: they stay)
         */
        const paintSet = (focusAt = -1) => {
            const section = header.closest('.jellyseerr-discovery-section');
            let line = section?.querySelector('.jellyseerr-filters-set') ?? null;
            const tokens = filterTokens({ offered, label, locale: localeOf(), selection: selectionOf(moduleName) });
            // (Redrawn with the keys on one of its buttons, as after the list it narrowed is in: they stay at that place.)
            const keyedAt = line && focusAt < 0 ? Array.from(line.querySelectorAll('button')).indexOf(document.activeElement) : -1;
            if (!section || tokens.length === 0) {
                line?.remove();
                if (focusAt >= 0 || keyedAt >= 0) button.focus();
                return;
            }
            if (!line) {
                line = document.createElement('div');
                line.className = 'jellyseerr-filters-set';
                line.setAttribute('role', 'group');
                line.setAttribute('aria-label', filtersLabel);
                header.after(line);
            }
            const removes = [];
            const pieces = tokens.map((token, index) => {
                const piece = document.createElement('span');
                piece.className = 'jellyseerr-filters-token';
                const words = document.createElement('span');
                words.dir = 'auto';
                words.textContent = token.words;
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'jellyseerr-filters-remove';
                const removeLabel = label('discovery_filter_remove', 'Remove: {filter}', { filter: token.words });
                remove.setAttribute('aria-label', removeLabel);
                remove.title = removeLabel;
                const cross = document.createElement('span');
                cross.className = 'material-icons close';
                cross.setAttribute('aria-hidden', 'true');
                remove.appendChild(cross);
                // (Taken away with the keys, the next piece's own button has them; with none left, the Filters button.)
                remove.addEventListener('click', () => change(token.without(selectionOf(moduleName)), document.activeElement === remove ? index : -1));
                removes.push(remove);
                piece.append(words, remove);
                return piece;
            });
            if (tokens.length > 1) {
                const all = document.createElement('button');
                all.type = 'button';
                all.className = 'jellyseerr-filters-clear';
                all.textContent = clearLabel;
                all.addEventListener('click', () => change({}, document.activeElement === all ? 0 : -1));
                pieces.push(all);
            }
            line.replaceChildren(...pieces);
            if (focusAt >= 0) (removes[Math.min(focusAt, removes.length - 1)] ?? button).focus();
            else if (keyedAt >= 0) {
                const again = line.querySelectorAll('button');
                (again[Math.min(keyedAt, again.length - 1)] ?? button).focus();
            }
        };
        /**
         * Redraws the button, the role lines it steers, and the line of what is set.
         * @param {number} [focusAt] - Where the keys go after a piece is taken away (-1: they stay)
         */
        const paint = (focusAt = -1) => {
            const set = activeFilterCount(selectionOf(moduleName));
            const typed = filterModeOf(moduleName) === MIXED() ? 0 : 1;
            button.toggleAttribute('data-on', set > 0);
            // (All / Movies / Series shows on the button only where the tabs are out of sight: the stylesheet's part.)
            button.toggleAttribute('data-type-on', typed > 0);
            typeWord.textContent = typed > 0 ? typeOf()?.groupOf().choices?.find(choice => choice.selected)?.name ?? '' : '';
            // With nothing of its own to offer it is only for the place where the tabs are out of sight.
            button.toggleAttribute('data-type-only', !offersMore());
            name.textContent = set > 0 ? `${filtersLabel}: ${set}` : filtersLabel;
            // Asked for by a job (Directing) and not for acting, a title's jobs come before its part on the card.
            const roles = selectionOf(moduleName).role ?? [];
            const section = header.closest('.jellyseerr-discovery-section');
            JE.discoveryBusy?.mark?.(section);
            section?.toggleAttribute('data-jobs-first', roles.length > 0 && !roles.some(role => role.id === 'cast'));
            // And among the jobs, the ones asked for lead ("Director, Writer" for Directing): a line that does not fit loses jobs from its end.
            if (section) {
                section.setAttribute(JE.discoveryRoles?.ROLE_ASKED ?? 'data-role-asked', roles.map(role => role.id).join('|'));
                JE.discoveryRoles?.fitRoleLines?.(section);
            }
            paintSet(focusAt);
        };
        wiring.set(header, { paint: (at = -1) => paint(at), reload: onChange });
        paint();
        /**
         * Takes a new selection: redraws, keeps the list's place while it is rebuilt, and reloads it.
         * @param {object} next - The new FilterSelection
         * @param {number} [focusAt] - Where the keys go after a piece is taken away (-1: they stay)
         */
        function change(next, focusAt = -1) {
            if (activeFilterCount(next) > 0) moreFilters.set(moduleName, next); else moreFilters.delete(moduleName);
            paint(focusAt);
            JE.discoveryBusy?.hold?.(button);
            onChange();
        }
        /** The section the header is in. */
        const sectionOf = () => header.closest('.jellyseerr-discovery-section');
        /** Opens the Filters menu under the button. */
        const open = () => {
            const menu = JE.discoveryMenu;
            const type = typeOf();
            const typeInMenu = !!type && !type.tabsShowing();
            // Where the tabs are out of sight the viewer may have come for them: that group is open.
            const groups = type && typeInMenu ? [{ ...type.groupOf(), open: true }] : [];
            groups.push(...filterMenuGroups({
                offered, data: dataOf(), locale: localeOf(), label,
                selection: () => selectionOf(moduleName), change, ...(ownGenre ? { ownGenre } : {}),
                roles: () => rolesOf(credits.get(moduleName) ?? [], label('discovery_role_acting', 'Acting'),
                    department => label(`discovery_role_${department.toLowerCase().replace(/[^a-z]+/g, '_')}`, department))
            }));
            if (groups.length === 0 || typeof menu?.openMenu !== 'function') { roomUnderMenu(sectionOf(), header, false); return; }
            button.setAttribute('aria-expanded', 'true');
            menu.openMenu({
                anchor: button, title: filtersLabel, groups, clearLabel, doneLabel: label('discovery_filters_done', 'Done'),
                onClose: () => { button.setAttribute('aria-expanded', 'false'); roomUnderMenu(sectionOf(), header, false); },
                // The groups that are a list of choices; the others set themselves (filterMenuGroups).
                onPick(id, groupId) {
                    if (groupId === 'type' && isFilterMode(id)) type?.choose(id);
                },
                onClear() {
                    if (typeInMenu) type?.choose(MIXED());
                    if (activeFilterCount(selectionOf(moduleName)) > 0) change({});
                }
            });
        };
        button.addEventListener('click', () => {
            // The menu hangs from this button and is as tall as the room under it. With too little
            // room there (the section begins low on the screen), the section's header is first
            // brought to the top of the screen, where it is held: the menu then has the screen's height.
            const section = sectionOf();
            const tv = document.documentElement.classList.contains('layout-tv');
            if (!tv) roomUnderMenu(section, header, true);
            const room = window.innerHeight - button.getBoundingClientRect().bottom - 12;
            const wanted = JE.discoveryMenu?.groupedMenuRoom?.(offered.length + 1) ?? 0;
            const to = section && !tv && room < wanted ? Math.round(heldAt(section, header)) : 0;
            if (to <= window.scrollY + 1) { open(); return; }
            const before = window.scrollY;
            window.scrollTo({ top: to });
            if (Math.abs(window.scrollY - before) < 1) { open(); return; }
            // (The join sees the header held on the next frame: only then is it known whether the tabs are in sight.)
            requestAnimationFrame(() => requestAnimationFrame(open));
        });
        return button;
    }

    /**
     * Says so when the further filters leave a section's list empty, with the way out. (Without it
     * the header would stand over nothing.) `hasMore`: Seerr has more to look through, so not yet.
     * @param {string} moduleName - The section's module name
     * @param {HTMLElement} container - The section's list (`.itemsContainer`)
     * @param {boolean} hasMore - Seerr has more pages to look through
     */
    function noteIfEmpty(moduleName, container, hasMore) {
        if (!container) return;
        const section = container.closest('.jellyseerr-discovery-section');
        JE.discoveryBusy?.release?.(container);
        // (The line of what is set needs the section on the page: a header made with filters set gets its line here.)
        wiring.get(section?.querySelector('.jellyseerr-discovery-header') ?? container)?.paint();
        section?.querySelector('.jellyseerr-filters-none')?.remove();
        if (hasMore || logic().activeFilterCount(selectionOf(moduleName)) === 0 || container.querySelector('.card')) return;
        const buildMessageRow = JE.discoverySection?.buildMessageRow;
        if (typeof buildMessageRow !== 'function') return;
        const note = buildMessageRow({
            message: label('discovery_filters_none', 'Nothing matches these filters.'),
            actionLabel: label('discovery_filters_clear', 'Clear filters'),
            onAction() {
                const wired = wiring.get(section?.querySelector('.jellyseerr-discovery-header') ?? container);
                // (This line goes when the new list is in, and its button with it: keys that were on it go to the Filters button now.)
                const keyed = note.contains(document.activeElement);
                moreFilters.delete(moduleName);
                wired?.paint(keyed ? 0 : -1);
                wired?.reload();
            }
        });
        note.classList.add('jellyseerr-filters-none');
        container.after(note);
    }

    // ---- Styles: the Filters button, the line of what is set, the groups' bodies -------------------

    const STYLE_ID = 'jellyseerr-discovery-filter-panel-styles';
    /** Puts this module's stylesheet in the page once. */
    function injectStyles() {
        if (typeof document === 'undefined' || !document.head || document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            /* The Filters button: Jellyfin's filter icon alone, as wide to press as Jellyfin's own toolbar icons,
               in the accent while anything in its menu is narrowing the list. */
            .jellyseerr-discovery-header .jellyseerr-filters-btn.emby-tab-button { margin-inline: 0; padding-inline: .3em; }
            .jellyseerr-filters-btn .material-icons { margin-inline-end: 0; }
            .jellyseerr-filters-btn::after { inset-inline: -.45em; }
            /* On: the accent, kept under the pointer and the keys, and a dot at the icon's corner (as Jellyfin marks
               its own filter button), so it is not told by colour alone. */
            .jellyseerr-filters-btn .material-icons { position: relative; }
            .jellyseerr-filters-btn.emby-tab-button[data-on], .jellyseerr-filters-btn.emby-tab-button[data-on]:hover, .jellyseerr-filters-btn.emby-tab-button[data-on]:focus-visible, .layout-tv .jellyseerr-filters-btn.emby-tab-button[data-on]:focus { color: var(--jellyseerr-accent); }
            .jellyseerr-filters-btn[data-on] .material-icons::after { content: ''; position: absolute; inset-block-start: -.06em; inset-inline-end: -.24em; width: .36em; height: .36em; border-radius: 50%; background: currentColor; }
            .jellyseerr-filters-btn[data-type-only] { display: none; }
            .jellyseerr-filters-type { display: none; white-space: nowrap; font-weight: 400; }
            /* The button's name, for a screen reader (the icon says it to the eye): out of sight, never out of the page. */
            .jellyseerr-filters-name { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
            /* What is set, in words, on a line under the header (it is not held with it): each piece with the way to
               take it away. The page's quiet text, no boxes; a press area of 44px each. */
            .jellyseerr-filters-set { --jellyseerr-accent: var(--jf-palette-primary-main, #00a4dc); display: flex; flex-wrap: wrap; align-items: center; gap: .15em 1.2em; margin: .4em 0 .7em; color: var(--jf-palette-text-secondary, rgba(255,255,255,.7)); }
            .jellyseerr-filters-token { display: inline-flex; align-items: center; min-width: 0; max-width: 100%; }
            .jellyseerr-filters-token > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .jellyseerr-filters-remove, .jellyseerr-filters-clear { position: relative; flex: none; margin: 0; border: 0; border-radius: .3em; background: none; color: inherit; font: inherit; cursor: pointer; }
            .jellyseerr-filters-remove { display: inline-flex; padding: .2em; margin-inline-start: .15em; }
            .jellyseerr-filters-remove .material-icons { font-size: 1.1em; line-height: 1; }
            /* ("Clear filters" is no heavier and no brighter than the filters it clears: it comes last and needs no pull.) */
            .jellyseerr-filters-clear { padding: .2em 0; }
            /* (Where the section says nothing matches, the way out is offered there.) */
            .jellyseerr-discovery-section:has(.jellyseerr-filters-none) .jellyseerr-filters-clear { display: none; }
            /* (On a TV the remote is on the whole piece, words and ×: its ground covers both.) */
            .layout-tv .jellyseerr-filters-remove:focus { outline: none; box-shadow: none; color: var(--jf-palette-text-primary, #fff); }
            .layout-tv .jellyseerr-filters-token:focus-within { color: var(--jf-palette-text-primary, #fff); }
            .jellyseerr-filters-remove::after, .jellyseerr-filters-clear::after { content: ''; position: absolute; inset: 50% -.55em auto; height: 44px; transform: translateY(-50%); }
            .jellyseerr-filters-clear::after { inset-inline: 0; }
            .jellyseerr-filters-remove:hover, .jellyseerr-filters-remove:focus-visible, .jellyseerr-filters-clear:hover, .jellyseerr-filters-clear:focus-visible { color: var(--jf-palette-text-primary, #fff); }
            .jellyseerr-filters-clear:hover { text-decoration: underline; text-underline-offset: .2em; }
            .jellyseerr-filters-remove:focus-visible, .jellyseerr-filters-clear:focus-visible { outline: none; box-shadow: 0 0 0 .14em var(--jellyseerr-accent); }
            /* A group's own body: two fields to type a range in; a whole list to tick, with a field to narrow
               a long one; a search. The fields are the menu's own ground a shade lighter, ringed in the
               theme's colour while typed in and in its error colour while what is typed cannot be used. */
            .jellyseerr-menu-range { display: flex; align-items: center; gap: .5em; padding: 4px 16px 8px 32px; }
            .jellyseerr-menu-input { box-sizing: border-box; flex: 1 1 0; width: 100%; min-width: 0; padding: 6px 10px; border: 1px solid var(--jf-palette-divider, rgba(255,255,255,.12)); border-radius: var(--jf-shape-borderRadius, 4px); background: var(--jf-palette-action-hover, rgba(255,255,255,.08)); color: inherit; font: inherit; }
            .jellyseerr-menu-input::placeholder { color: var(--jf-palette-text-secondary, rgba(255,255,255,.7)); opacity: 1; }
            .jellyseerr-menu-input:focus { outline: none; border-color: var(--jf-palette-primary-main, #00a4dc); box-shadow: 0 0 0 1px var(--jf-palette-primary-main, #00a4dc); }
            .jellyseerr-sort-menu { --jellyseerr-error: var(--jf-palette-error-light, #e57373); }
            @supports (color: color-mix(in oklab, red 60%, blue)) { .jellyseerr-sort-menu { --jellyseerr-error: color-mix(in oklab, var(--jf-palette-error-main, #f44336) 52%, var(--jf-palette-text-primary, #fff)); } }
            .jellyseerr-menu-input[aria-invalid="true"] { border-color: var(--jellyseerr-error); box-shadow: 0 0 0 1px var(--jellyseerr-error); }
            /* What cannot be used is also said in words, where the hint was. */
            .jellyseerr-menu-note[data-error] { color: var(--jellyseerr-error); }
            /* A list's search field stays in sight under its group's row while the list scrolls. */
            .jellyseerr-menu-searchbar { position: sticky; top: calc(var(--jellyseerr-menu-head, 36px) - 1px); z-index: 1; padding: 5px 16px 6px 32px; background-color: var(--jellyseerr-menu-ground); background-image: var(--jellyseerr-menu-shade); }
            .jellyseerr-menu-search { display: block; width: 100%; }
            /* A row to tick has a box, empty until it is ticked (then in the accent); one given by the page itself is dim and cannot be pressed. */
            .jellyseerr-sort-menu .jellyseerr-menu-tick .actionsheetMenuItemIcon { color: var(--jf-palette-text-secondary, rgba(255,255,255,.7)); }
            .jellyseerr-sort-menu .jellyseerr-menu-tick[aria-checked="true"] .actionsheetMenuItemIcon { color: var(--jellyseerr-accent); }
            html .jellyseerr-sort-menu .actionSheetMenuItem.jellyseerr-menu-tick[aria-disabled="true"] { color: var(--jf-palette-text-disabled, rgba(255,255,255,.5)); cursor: default; background: none !important; }
            .jellyseerr-sort-menu .jellyseerr-menu-tick[aria-disabled="true"] .actionsheetMenuItemIcon { color: inherit; }
            /* A long name in a list takes a second line: its end is often what tells two entries apart ("… Amazon Channel"). (Its box stays in the row's middle, as on any list of two-line items.) */
            html .jellyseerr-sort-menu .jellyseerr-menu-list .actionSheetItemText { min-width: 0; white-space: normal; overflow-wrap: anywhere; }
            /* The letters a search found in a name. */
            .jellyseerr-menu-found { font-weight: 700; }
            /* Under what is ticked or likeliest wanted at a long list's head, before the rest of it. */
            .jellyseerr-menu-list-rule { height: 1px; margin: 4px 16px 4px 32px; background: var(--jf-palette-divider, rgba(255,255,255,.12)); }
            .jellyseerr-menu-note, .jellyseerr-menu-label { color: var(--jf-palette-text-secondary, rgba(255,255,255,.7)); }
            .jellyseerr-menu-note { padding: 2px 16px 8px 32px; font-size: .86em; line-height: 1.4; }
            /* What a search has narrowed away is gone (a row's own display would otherwise keep it). */
            .jellyseerr-sort-menu .actionSheetMenuItem[hidden], .jellyseerr-menu-note[hidden], .jellyseerr-menu-label[hidden] { display: none !important; }
            .jellyseerr-menu-label { padding: 8px 16px 2px 32px; font-size: .86em; }
            .jellyseerr-menu-list:empty { display: none; }
            /* (A phone's browser zooms into a field whose type is under 16px.) */
            @media (max-width: 600px) { .jellyseerr-menu-input { font-size: max(1em, 16px); min-height: 44px; } }
            .jellyseerr-menu-group .listItemBody { display: flex; flex-direction: row; align-items: baseline; justify-content: space-between; gap: 1.5em; }
            .jellyseerr-menu-group .actionSheetItemText { flex: 0 1 auto; }
            .jellyseerr-menu-group-value { color: var(--jf-palette-text-secondary, rgba(255,255,255,.7)); white-space: nowrap; }
            .jellyseerr-menu-group[data-set] .jellyseerr-menu-group-value { color: var(--jellyseerr-accent); }
            .jellyseerr-menu-group .actionsheetMenuItemIcon { transition: transform .15s; }
            .jellyseerr-menu-group[aria-expanded="true"] .actionsheetMenuItemIcon { transform: rotate(180deg); }
            html:not(.layout-tv) .jellyseerr-sort-menu .jellyseerr-menu-group .actionsheetMenuItemIcon { margin-inline-start: .6em !important; }
            html:not(.layout-tv) .jellyseerr-sort-menu .jellyseerr-menu-choices .actionSheetMenuItem { padding-inline-start: 32px; }
            /* "Clear filters" is the menu's foot, always in reach; at full strength only while something is set. */
            html:not(.layout-tv) .jellyseerr-sort-menu .jellyseerr-menu-foot { margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--jf-palette-divider, rgba(255,255,255,.12)); }
            html:not(.layout-tv) .jellyseerr-sort-menu .jellyseerr-menu-foot { display: flex; }
            html:not(.layout-tv) .jellyseerr-sort-menu .jellyseerr-menu-foot > .actionSheetMenuItem { width: auto; }
            html:not(.layout-tv) .jellyseerr-sort-menu .jellyseerr-menu-clear { flex: 1 1 auto; }
            /* On a touch screen the menu can fill the screen: its foot then ends with the way out, said (nothing waits for it; what is set has taken effect). */
            .jellyseerr-sort-menu .jellyseerr-menu-done { display: none !important; flex: none; }
            .jellyseerr-sort-menu .jellyseerr-menu-done .actionsheetMenuItemIcon { display: none; }
            @media (pointer: coarse) { html:not(.layout-tv) .jellyseerr-sort-menu .jellyseerr-menu-done { display: flex !important; } }
        `;
        document.head.appendChild(style);
    }

    injectStyles();

    JE.discoveryFilters = Object.assign(JE.discoveryFilters || {}, {
        createFiltersControl,
        /**
         * What a feed's request carries for the section's further filters (the sort is the caller's).
         * @param {string} name - The module name
         * @param {'movie'|'tv'} kind - The feed's kind
         * @returns {string}
         */
        feedQuery: (name, kind) => logic().feedFilterQuery(selectionOf(name), kind, adminRegion()),
        /**
         * A person's titles the section's filters keep; the titles are also kept as what the Role list is made of.
         * @param {string} name - The module name
         * @param {object[]} results - The person's titles
         * @returns {object[]}
         */
        keep(name, results) {
            credits.set(name, results);
            return logic().keepByFilters(results, selectionOf(name));
        },
        /**
         * Whether any further filter is narrowing the section's list.
         * @param {string} name - The module name
         * @returns {boolean}
         */
        active: name => logic().activeFilterCount(selectionOf(name)) > 0,
        /**
         * A section starts with nothing narrowing it: its further filters and the titles seen go.
         * @param {string} name - The module name
         */
        reset(name) {
            moreFilters.delete(name);
            credits.delete(name);
        },
        /**
         * Redraws a header's Filters button (after All / Movies / Series changed).
         * @param {Element|null} element - The header, or anything inside it
         */
        repaint(element) {
            if (!element) return;
            wiring.get(element.closest?.('.jellyseerr-discovery-header') ?? element)?.paint();
        },
        noteIfEmpty,
        roomUnderMenu,
        filterMenuGroups,
        filterTokens,
        /**
         * The section's selection, for tests and the facade.
         * @param {string} name - The module name
         * @returns {object}
         */
        selectionOf
    });

})(window.JellyfinEnhanced || (window.JellyfinEnhanced = {}));
