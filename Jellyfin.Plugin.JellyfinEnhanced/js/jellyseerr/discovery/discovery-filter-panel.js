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
        without: ['discovery_filter_without', 'Without keywords'], withoutGenres: ['discovery_filter_without_genres', 'Without genres'],
        withoutLanguage: ['discovery_filter_without_language', 'Without language']
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
        role: ['discovery_filter_rule_role', 'Any of the roles ticked.'], genres: ['discovery_filter_rule_genres', 'All of the genres ticked.'],
        language: ['discovery_filter_rule_language', 'Any of the languages ticked.'], rating: ['discovery_filter_rule_rating', 'Any of the ratings ticked.'],
        services: ['discovery_filter_rule_services', 'Any of the services ticked.'], keywords: ['discovery_filter_rule_keywords', 'All of the keywords ticked.'],
        without: ['discovery_filter_rule_without', 'None of the keywords ticked.'],
        withoutGenres: ['discovery_filter_rule_without_genres', 'None of the genres ticked.'],
        withoutLanguage: ['discovery_filter_rule_without_language', 'None of the languages ticked.']
    });
    /** The lists matched by any of what is ticked, with no choice (Seerr's own rule for them). */
    const ANY_OF = new Set(['role', 'language', 'rating']);
    /** The lists a title must have none of. */
    const NONE_OF = new Set(['without', 'withoutGenres', 'withoutLanguage']);
    /** A list and the one that leaves the same things out: a thing is in one of them at most. */
    const PARTNERS = Object.freeze({ genres: 'withoutGenres', withoutGenres: 'genres', language: 'withoutLanguage', withoutLanguage: 'language', keywords: 'without', without: 'keywords' });
    /**
     * How several ticks in a list count: 'all', 'any' (chosen, or Seerr's own rule for the list), or 'none' (the
     * Without lists: a title has none of them).
     * @param {object} selection - A FilterSelection
     * @param {string} id - The list filter
     * @returns {'all'|'any'|'none'|''}
     */
    const listRule = (selection, id) => logic().MATCH_DEFAULTS?.[id] !== undefined ? logic().matchOf(selection, id)
        : ANY_OF.has(id) ? 'any' : NONE_OF.has(id) ? 'none' : '';
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
     * @param {string} [options.ownGenre] - On a genre's page: that genre's name (always applied, so outside an "or")
     * @returns {{words: string, alone?: string, join?: 'and'|'or', or: boolean, list?: string, without: (selection: object) => object}[]} Each
     *   thing set, in words (`join`: said after "and" or "or", the rule of its list; `list`: the list it is in), and the
     *   selection without it
     */
    function filterTokens({ offered, label: say, locale, selection, ownGenre }) {
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
            // (A list of several says its rule between them, as its group's row does: "Action and Comedy" for all of
            // them, "Family or Kids" for any. Without keywords says each on its own: "Without gore", "Without robot".)
            const rule = listRule(selection, id);
            const own = id === 'genres' ? ownGenre?.trim().toLocaleLowerCase() ?? '' : '';
            const isOwn = item => own !== '' && item.name.toLocaleLowerCase() === own;
            // (The page's own genre is in its heading: the line says only what was chosen beside it.)
            const items = (selection[id] ?? []).filter(item => !isOwn(item));
            /**
             * A thing ticked, said on its own: a keyword and a language need a word to be read alone ("With robot",
             * "Originally in Japanese"), a Without list says what it leaves out ("Without gore", "Not Horror"), services
             * are what titles are on ("On Netflix", as the menu's "Titles on"); a genre, a rating and a role say what they are.
             * @param {{name: string}} item
             * @returns {string}
             */
            const alone = item => id === 'without' ? say('discovery_filter_set_without', 'Without {name}', { name: item.name })
                : id === 'withoutGenres' ? say('discovery_filter_set_not', 'Not {name}', { name: item.name })
                    : id === 'withoutLanguage' ? say('discovery_filter_set_not_language', 'Not originally in {name}', { name: item.name })
                        : id === 'keywords' ? say('discovery_filter_set_with', 'With {name}', { name: item.name })
                            : id === 'language' ? say('discovery_filter_set_language', 'Originally in {name}', { name: item.name })
                                : id === 'services' ? say('discovery_filter_set_on', 'On {name}', { name: item.name }) : item.name;
            for (const [index, item] of items.entries()) {
                // ("and" for all of them; "or" for any, and for none of them: "Without gore or horror".)
                const join = rule !== '' && index > 0 ? (rule === 'all' ? 'and' : 'or') : undefined;
                tokens.push({
                    join,
                    or: join === 'or',
                    list: id,
                    // (After the word joining it to the one before, its own name is enough: "With bear or dragon",
                    // "Not Horror or Thriller". `alone`: as it is said by itself, for what names one piece: Undo.)
                    words: join ? item.name : alone(item),
                    alone: alone(item),
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
        /** What a group's row says with nothing set: "Any", and for a Without list "None" (it leaves nothing out). */
        const anyOf = id => NONE_OF.has(id) ? say('discovery_filter_none', 'None') : any;
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
                describe() { const now = usable(id, options.selection()[id]); return { value: sayRange(id, now), set: now[0] !== '' || now[1] !== '' }; },
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
        const sayList = (ticked, id) => {
            // (On a genre's page its own genre is always applied: what is said is about the others.)
            const own = id === 'genres' ? options.ownGenre?.trim().toLocaleLowerCase() ?? '' : '';
            const picked = own && ticked.length > 1 ? ticked.filter(item => item.name.toLocaleLowerCase() !== own) : ticked;
            // A list of all or any of its ticks says which, the names joined as the page's language joins them:
            // "Action, Comedy and Animation", "Family or Kids", "French or Japanese". (Where they don't fit, the row says
            // it short: see shortList.)
            const rule = listRule(options.selection(), id);
            if (picked.length >= 2 && rule !== '') {
                // (None of them is said as "or" under its Without heading: "gore or horror".)
                const any = rule !== 'all';
                const names = picked.map(item => item.name);
                let joined = null;
                try { joined = new Intl.ListFormat(locale || 'en', { style: 'long', type: any ? 'disjunction' : 'conjunction' }).format(names); } catch (_) { joined = null; }
                if (joined) return joined;
                if (picked.length > 2 && rule === 'none') return say('discovery_filter_none_of', 'None of {count}', { count: picked.length });
                if (picked.length > 2) return any ? say('discovery_filter_any_of', 'Any of {count}', { count: picked.length })
                    : say('discovery_filter_all_of', 'All of {count}', { count: picked.length });
                const two = { first: names[0], second: names[1] };
                return any ? say('discovery_filter_either', '{first} or {second}', two) : say('discovery_filter_both', '{first} and {second}', two);
            }
            return picked.map(item => item.name).join(', ');
        };
        /**
         * The same, short, for a row too narrow for the names: "Any of 2", "2 chosen" (none for a single tick).
         * @param {object[]} ticked
         * @param {string} id - The list filter
         * @returns {string|undefined}
         */
        const shortList = (ticked, id) => {
            const own = id === 'genres' ? options.ownGenre?.trim().toLocaleLowerCase() ?? '' : '';
            const picked = own && ticked.length > 1 ? ticked.filter(item => item.name.toLocaleLowerCase() !== own) : ticked;
            if (picked.length < 2) return undefined;
            const rule = listRule(options.selection(), id);
            if (rule === '') return say('discovery_filter_count', '{count} chosen', { count: picked.length });
            if (rule === 'none') return say('discovery_filter_none_of', 'None of {count}', { count: picked.length });
            return rule === 'any' ? say('discovery_filter_any_of', 'Any of {count}', { count: picked.length })
                : say('discovery_filter_all_of', 'All of {count}', { count: picked.length });
        };
        /** What is ticked in a list now. */
        const pickedOf = id => options.selection()[id] ?? [];
        /**
         * What a long list's search field says it searches.
         * @param {string} id - The list filter
         * @returns {string}
         */
        const searchWord = id => id === 'genres' || id === 'withoutGenres' ? say('discovery_filter_search_genres', 'Search genres')
            : id === 'services' ? say('discovery_filter_search_services', 'Search services')
                : id === 'language' || id === 'withoutLanguage' ? say('discovery_filter_search_languages', 'Search languages') : say('discovery_filter_search', 'Search');
        /** Whether the viewer chooses how several ticks in a list count (not where the page names that list). */
        const matchable = id => logic().MATCH_DEFAULTS?.[id] !== undefined && !(options.fixedAll ?? []).includes(id);
        // Each list's all / any choice, to be marked idle while fewer than two are ticked (it changes nothing then).
        const matchLines = new Map();
        /**
         * How many of a list's ticks the choice is about (on a genre's page, not its own genre).
         * @param {object[]} ticked
         * @param {string} id
         * @returns {number}
         */
        const choiceCount = (ticked, id) => {
            const own = id === 'genres' ? options.ownGenre?.trim().toLocaleLowerCase() ?? '' : '';
            return own ? ticked.filter(item => item.name.toLocaleLowerCase() !== own).length : ticked.length;
        };
        /** Marks a list's choice idle or not, by its ticks now. */
        const markIdle = (id, ticked) => matchLines.get(id)?.toggleAttribute('data-idle', choiceCount(ticked, id) < 2);
        /**
         * How several ticks in a list count, said under the list. Where a title can have several of them, a
         * choice: all of the ones ticked, or any of them (each said as Seerr's own rule where it can't be chosen).
         * @param {string} id - The list filter
         * @param {{say: Function}} [handle] - The group's handle, to say the list again in the choice's words
         * @returns {HTMLElement}
         */
        const ruleOf = (id, handle) => {
            if (!matchable(id)) return note(say(RULES[id][0], RULES[id][1]));
            const line = document.createElement('div');
            line.className = 'jellyseerr-menu-note jellyseerr-menu-match';
            const lead = document.createElement('span');
            lead.className = 'jellyseerr-menu-match-lead';
            // (Read as the choice's name, below: not twice.)
            lead.setAttribute('aria-hidden', 'true');
            // (On a genre's page its genre is always applied: the choice is about the others.)
            // (Titles are on a service, not with it.)
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
            const buttons = [['all', say('discovery_filter_match_all', 'all ticked')], ['any', say('discovery_filter_match_any', 'any ticked')]].map(([value, words]) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'jellyseerr-menu-match-btn';
                button.setAttribute('role', 'radio');
                button.dataset.match = value;
                // (Under its words, the same words as the half in use has them, out of sight: each half is as wide as it
                // is when chosen, so choosing, or ticking a second, never moves the choice or the list under it.)
                const reserve = document.createElement('span');
                reserve.className = 'jellyseerr-menu-match-reserve';
                reserve.setAttribute('aria-hidden', 'true');
                reserve.textContent = words;
                button.append(words, reserve);
                button.addEventListener('click', () => {
                    const now = options.selection();
                    if (logic().matchOf(now, id) === value) return;
                    // (The default is not kept: a list on its default is said as nothing in the address.)
                    const match = { ...(now.match ?? {}), [id]: value };
                    if (value === logic().MATCH_DEFAULTS[id]) delete match[id];
                    paint(value);
                    const picked = pickedOf(id);
                    options.change({ ...now, match: Object.keys(match).length > 0 ? match : undefined });
                    handle?.say(sayList(picked, id), picked.length > 0, shortList(picked, id));
                });
                return button;
            });
            /** Marks the choice in use; only it takes the keys' stop. */
            const paint = value => buttons.forEach(button => {
                const on = button.dataset.match === value;
                button.setAttribute('aria-checked', String(on));
                button.tabIndex = on ? 0 : -1;
            });
            paint(logic().matchOf(options.selection(), id));
            matchLines.set(id, line);
            markIdle(id, pickedOf(id));
            // Left and right move between the two and choose, as in any radio group (up and down are the menu's rows);
            // on a TV they only move, and OK chooses, so passing over the choice never reloads the list.
            track.addEventListener('keydown', event => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                const at = buttons.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
                const forward = (event.key === 'ArrowRight') !== (getComputedStyle(track).direction === 'rtl');
                const next = buttons[at + (forward ? 1 : -1)];
                if (at < 0 || !next) return;
                event.preventDefault();
                event.stopPropagation();
                next.focus();
                if (!document.documentElement.classList.contains('layout-tv')) next.click();
            });
            track.append(...buttons);
            return line;
        };
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
                // (Ticked by the page itself, which the row says under its name: why it can't be unticked here, and why
                // any of the others still means titles in it.)
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
                let selection = { ...options.selection(), [id]: next.length > 0 ? next : undefined };
                // (A genre wanted is not left out too, nor the other way round: ticked here, it leaves the partner list.)
                const partner = PARTNERS[id];
                const other = partner ? pickedOf(partner) : [];
                if (chosen && other.some(entry => entry.id === item.id)) {
                    const rest = other.filter(entry => entry.id !== item.id);
                    selection = { ...selection, [partner]: rest.length > 0 ? rest : undefined };
                    handle.other?.(partner, sayList(rest, partner), rest.length > 0, shortList(rest, partner));
                }
                options.change(selection);
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
                id, name: nameOf(id), any: anyOf(id), set: picked.length > 0, value: sayList(picked, id), short: shortList(picked, id),
                describe() { const now = pickedOf(id); return { value: sayList(now, id), set: now.length > 0, short: shortList(now, id) }; },
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
                            const head = [...lifted].map(wanted => section.items.find(item => item.id === wanted)).filter(Boolean);
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
        /**
         * A keyword filter's group: the keywords chosen, and a field to search for more.
         * @param {'keywords'|'without'} id - The keyword filter
         * @returns {object} The group
         */
        function keywordGroup(id) {
            const picked = pickedOf(id);
            return {
                id, name: nameOf(id), any: anyOf(id), set: picked.length > 0, value: sayList(picked, id), short: shortList(picked, id),
                describe() { const now = pickedOf(id); return { value: sayList(now, id), set: now.length > 0, short: shortList(now, id) }; },
                build(host, handle) {
                    // The keywords chosen stay listed (ticked) above the field; what the search finds comes under it.
                    const chosen = document.createElement('div');
                    chosen.className = 'jellyseerr-menu-list';
                    const rule = ruleOf(id, handle);
                    const found = document.createElement('div');
                    found.className = 'jellyseerr-menu-list';
                    /** Lists a chosen keyword above the field, ticked; taken away when it is pressed again. */
                    const keep = item => chosen.appendChild(tickRow(id, item, handle, (isChosen, row) => {
                        if (!isChosen) {
                            // (Taken away with the keys on it, they go to the next one kept, else the one before, else
                            // the field: where they were, not back to the top of the menu.)
                            const held = row.contains(document.activeElement);
                            const next = /** @type {HTMLElement|null} */ (row.nextElementSibling ?? row.previousElementSibling);
                            row.remove();
                            if (held) (next ?? search).focus();
                        }
                        rule.hidden = chosen.childElementCount === 0;
                        if (!isChosen && search.value.trim() === '') sayStatus(resting());
                        handle.placed();
                    }));
                    const search = field(nameOf(id), say('discovery_filter_search_keywords', 'Search keywords'), 'search');
                    search.classList.add('jellyseerr-menu-search');
                    const bar = document.createElement('div');
                    bar.className = 'jellyseerr-menu-searchbar';
                    bar.appendChild(search);
                    for (const item of pickedOf(id)) keep(item);
                    // (How several count is said once there is one to tick.)
                    // (How several count sits with the keywords chosen: it shows once there is one.)
                    rule.hidden = chosen.childElementCount === 0;
                    const status = note('');
                    status.hidden = true;
                    status.setAttribute('aria-live', 'polite');
                    let timer = 0;
                    let asking = null;
                    /** Says how the search went under the field ('' hides the line). */
                    const sayStatus = words => { sayIn(status, words); status.hidden = words === ''; };
                    // (At rest, with nothing chosen and nothing typed, the line says what a keyword is.)
                    const hint = id === 'without' ? say('discovery_filter_without_hint', 'Titles tagged with these words are left out.')
                        : say('discovery_filter_keywords_hint', 'Words a title is tagged with, such as heist or time travel.');
                    /** What the line says with no search under way. */
                    const resting = () => search.value.trim().length === 1 ? say('discovery_filter_two_letters', 'Type two letters or more.')
                        : search.value.trim() === '' && chosen.childElementCount === 0 ? hint : '';
                    /** Searches for what is typed (two letters at least), dropping a search still running. */
                    const look = () => {
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

        const groups = [];
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
            else if (id === 'language') groups.push(listGroup(id, async () => [{ items: await data.languages(locale) }], [locale.split('-')[0]?.toLowerCase() ?? '']));
            else if (id === 'withoutLanguage') groups.push(listGroup(id, async () => [{ items: await data.languages(locale) }], [locale.split('-')[0]?.toLowerCase() ?? '']));
            else if (id === 'services') groups.push(listGroup(id, async () => [{ items: await data.services() }]));
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

    // ---- Saved filters (profiles) ------------------------------------------------------------------

    const PROFILES_API = 'discovery-filter-profiles';
    /** The user's profiles as last read, kept for the visit (per user): a request, or its answer. */
    let profilesOf = null;
    /** @returns {boolean} Whether this client can reach the user's saved filters. */
    const profilesReachable = () => typeof ApiClient?.ajax === 'function' && !!ApiClient.getCurrentUserId?.();
    /** @returns {string} The user's profiles' address. */
    const profilesUrl = (path = '') => ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${ApiClient.getCurrentUserId()}/${PROFILES_API}${path}`);
    /**
     * The user's saved filter profiles, asked of the server once per visit and user.
     * @returns {Promise<{max: number, profiles: {id: string, name: string, filters: string}[]}>}
     */
    function loadProfiles() {
        const user = ApiClient.getCurrentUserId();
        if (profilesOf?.user === user) return profilesOf.asked;
        const asked = ApiClient.ajax({ type: 'GET', url: profilesUrl(), dataType: 'json' })
            .then(answer => ({ max: Number(answer?.max) || 0, profiles: Array.isArray(answer?.profiles) ? answer.profiles.filter(p => p && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.filters === 'string') : [] }));
        const held = { user, asked, list: null, max: 0 };
        profilesOf = held;
        // (Kept as answered, so a menu opened later says at once which profile is set.)
        asked.then(answer => { held.list = answer.profiles; held.max = answer.max; }, () => {});
        asked.catch(() => { if (profilesOf?.asked === asked) profilesOf = null; });
        return asked;
    }
    /**
     * Saves the filters under a name (a profile of that name, in any case, takes them).
     * @param {string} name
     * @param {string} filters - In the address form
     * @returns {Promise<{id: string, name: string, filters: string}>}
     */
    async function saveProfile(name, filters) {
        const answer = await ApiClient.ajax({ type: 'POST', url: profilesUrl(), data: JSON.stringify({ name, filters }), contentType: 'application/json', dataType: 'json' });
        keepProfiles(list => withProfile(list, answer.profile));
        return answer.profile;
    }
    /**
     * A list of profiles with one saved: in its place where it was there (a name saved over), else last, as the server
     * keeps them.
     * @param {object[]} list
     * @param {{id: string}} saved
     * @returns {object[]}
     */
    function withProfile(list, saved) {
        const at = list.findIndex(p => p.id === saved.id);
        return at < 0 ? [...list, saved] : list.map((p, index) => index === at ? saved : p);
    }
    /**
     * The profiles kept for this visit, changed as the server's were (else asked again next time).
     * @param {function(object[]): object[]} change
     */
    function keepProfiles(change) {
        const held = profilesOf;
        if (!held || held.user !== ApiClient.getCurrentUserId() || !Array.isArray(held.list)) { profilesOf = null; return; }
        const list = change(held.list);
        profilesOf = { user: held.user, list, max: held.max, asked: Promise.resolve({ max: held.max, profiles: list }) };
    }
    /**
     * Deletes one of the user's profiles.
     * @param {string} id
     * @returns {Promise<void>}
     */
    async function deleteProfile(id) {
        await ApiClient.ajax({ type: 'DELETE', url: profilesUrl(`/${encodeURIComponent(id)}`) });
        keepProfiles(list => list.filter(p => p.id !== id));
    }
    JE.session?.onUserChange?.('discovery-filter-profiles', () => { profilesOf = null; });

    /**
     * The Saved filters group: the user's profiles, each applied by choosing it (the menu then closes, and the list
     * behind reloads with them), a way to delete one, and a field to save what is set under a name.
     * @param {object} options
     * @param {Function} options.label - The string lookup
     * @param {{read: function(): string, apply: function(string): void}} options.host - What is set now in the address
     *   form, and how a profile's filters are applied by the page they narrow
     * @returns {object} The group
     */
    function profilesGroup({ label: say, host, scope = 'feed', offered = [], locale = 'en' }) {
        const name = say('discovery_filter_profiles', 'Saved filters');
        const none = say('discovery_filter_profiles_none', 'None');
        /** What the row says: the profile that is what is set now, else how many there are. */
        /**
         * Filters in one written form, as this page takes them: a set saved elsewhere, or by an earlier version, with
         * its pairs in another order or another spelling, is still known as what is set.
         * @param {string} text
         * @returns {string}
         */
        const plain = text => {
            const address = JE.discoveryAddress;
            if (!address?.filtersOf || !address?.filterPairs) return text;
            try { return address.filterPairs(address.filtersOf(text, scope), true).join('&'); } catch (_) { return text; }
        };
        /** Whether a profile is what is set now. */
        const isNow = profile => plain(profile.filters) === plain(host.read());
        const sayRow = list => list.find(isNow)?.name
            ?? (list.length > 0 ? say('discovery_filter_profiles_count', '{count} saved', { count: list.length }) : none);
        // (The list as last answered, when there is one: the row then says which profile is set as the menu opens.)
        const known = profilesOf?.user === ApiClient.getCurrentUserId() ? profilesOf.list : null;
        const now = known ? known.find(isNow) : null;
        return {
            id: 'profiles', name, any: known ? sayRow(known) : none, set: !!now, value: now?.name ?? none,
            build(body, handle) {
                const rows = document.createElement('div');
                rows.className = 'jellyseerr-menu-list';
                const status = document.createElement('div');
                status.className = 'jellyseerr-menu-note';
                status.setAttribute('aria-live', 'polite');
                const sayStatus = (words, error = false) => { status.textContent = words; status.hidden = words === ''; status.toggleAttribute('data-error', error); };
                // The form: a name, and Save (what is set now, under that name).
                const form = document.createElement('div');
                form.className = 'jellyseerr-menu-range jellyseerr-menu-profile-form';
                const field = document.createElement('input');
                field.type = 'text';
                field.className = 'jellyseerr-menu-input';
                field.maxLength = 60;
                field.autocomplete = 'off';
                field.placeholder = say('discovery_filter_profile_name', 'Name these filters');
                field.setAttribute('aria-label', field.placeholder);
                const save = document.createElement('button');
                save.type = 'button';
                save.className = 'jellyseerr-menu-profile-save emby-button raised';
                save.textContent = say('discovery_filter_profile_save', 'Save');
                form.append(field, save);
                let list = [];
                /**
                 * What a profile sets, in one line, as this page would take it.
                 * @param {string} filters - The profile's filters, in the address form
                 * @returns {string}
                 */
                const summaryOf = filters => {
                    const read = JE.discoveryAddress?.filtersOf?.(filters, scope);
                    if (!read) return '';
                    // What tells sets apart first (the lists), then the ranges, the type and the order.
                    const lists = [];
                    const ranges = [];
                    for (const token of filterTokens({ offered, label: say, locale, selection: read.selection })) {
                        const into = token.list ? lists : ranges;
                        // (Several of a list stay together, said with their rule: "dragon or witch".)
                        if (token.join && into.length > 0) into[into.length - 1] += ` ${token.join === 'or' ? say('discovery_filter_or', 'or') : say('discovery_filter_and', 'and')} ${token.words}`;
                        else into.push(token.words);
                    }
                    const parts = [...lists, ...ranges];
                    if (read.mode === 'movies') parts.push(say('jellyseerr_quota_label_movie', 'Movies'));
                    else if (read.mode === 'tv') parts.push(say('jellyseerr_quota_label_tv', 'Series'));
                    const order = (JE.discoveryFilter?.SORT_OPTIONS ?? []).find(option => option.value !== '' && option.value === read.sort);
                    if (order) parts.push(say(order.labelKey, order.label));
                    return parts;
                };
                /**
                 * Says a profile was deleted, with the way back: Undo saves it again.
                 * @param {{name: string, filters: string}} profile
                 */
                const sayUndo = profile => {
                    const undo = document.createElement('button');
                    undo.type = 'button';
                    undo.className = 'jellyseerr-menu-profile-undo';
                    undo.textContent = say('discovery_filter_profile_undo', 'Undo');
                    undo.addEventListener('click', () => {
                        undo.disabled = true;
                        const keyed = document.activeElement === undo;
                        saveProfile(profile.name, profile.filters).then(saved => {
                            if (!body.isConnected) return;
                            list = withProfile(list, saved);
                            draw();
                            sayStatus(say('discovery_filter_profile_restored', 'Restored “{name}”.', { name: saved.name }));
                            if (keyed) /** @type {HTMLElement|null} */ (rows.querySelector('.jellyseerr-menu-profile-row:last-child .jellyseerr-menu-profile'))?.focus();
                            handle.say(sayRow(list), list.some(isNow));
                            handle.placed();
                        }).catch(() => { undo.disabled = false; sayStatus(say('discovery_filter_profile_error', 'Could not save that. Try again.'), true); });
                    });
                    status.replaceChildren(say('discovery_filter_profile_deleted', 'Deleted “{name}”.', { name: profile.name }), undo);
                    status.hidden = false;
                    status.removeAttribute('data-error');
                };
                /** Draws the profiles, the one that is what is set now ticked. */
                const draw = () => {
                    const now = host.read();
                    rows.replaceChildren(...list.map(profile => {
                        const current = isNow(profile);
                        const { item } = JE.discoveryMenu.menuRow(profile.name, 'check', !current);
                        item.classList.add('jellyseerr-menu-profile');
                        if (current) item.setAttribute('aria-current', 'true');
                        // Under its name, what it sets, in the page's words ("Movies · Score from 7 · Animation and Fantasy").
                        const says = summaryOf(profile.filters);
                        if (says.length > 0) {
                            const line = document.createElement('div');
                            line.className = 'listItemBodyText secondary jellyseerr-menu-profile-says';
                            // (Each part whole on a line where it fits: a line breaks between parts, never inside "dragon or witch".)
                            line.append(...says.flatMap((part, index) => {
                                const piece = document.createElement('span');
                                piece.className = 'jellyseerr-menu-profile-part';
                                piece.textContent = index < says.length - 1 ? `${part} ·` : part;
                                return index < says.length - 1 ? [piece, ' '] : [piece];
                            }));
                            item.querySelector('.actionsheetListItemBody')?.appendChild(line);
                        }
                        item.addEventListener('click', () => { handle.close?.(); host.apply(profile.filters); });
                        const remove = document.createElement('button');
                        remove.type = 'button';
                        remove.className = 'jellyseerr-menu-profile-delete';
                        const removeLabel = say('discovery_filter_profile_delete', 'Delete {name}', { name: profile.name });
                        remove.setAttribute('aria-label', removeLabel);
                        remove.title = removeLabel;
                        // (A bin, not the cross that takes a filter away on the page: this deletes what is kept.)
                        const bin = document.createElement('span');
                        bin.className = 'material-icons delete_outline';
                        bin.setAttribute('aria-hidden', 'true');
                        remove.appendChild(bin);
                        remove.addEventListener('click', event => {
                            event.stopPropagation();
                            remove.disabled = true;
                            const at = list.indexOf(profile);
                            const keyed = document.activeElement === remove;
                            deleteProfile(profile.id).then(() => {
                                list = list.filter(p => p.id !== profile.id);
                                draw();
                                // (Deleted with the keys on it, they go to the next one's delete, the one before, or the name field.)
                                if (keyed) {
                                    const deletes = rows.querySelectorAll('.jellyseerr-menu-profile-delete');
                                    const head = body.previousElementSibling instanceof HTMLElement ? body.previousElementSibling : null;
                                    (/** @type {HTMLElement|undefined} */ (deletes[Math.min(at, deletes.length - 1)]) ?? (field.disabled ? head : field))?.focus();
                                }
                                sayUndo(profile);
                                handle.say(sayRow(list), list.some(isNow));
                                handle.placed();
                            }).catch(() => { remove.disabled = false; sayStatus(say('discovery_filter_profile_error', 'Could not save that. Try again.'), true); });
                        });
                        const wrap = document.createElement('div');
                        wrap.className = 'jellyseerr-menu-profile-row';
                        wrap.append(item, remove);
                        return wrap;
                    }));
                    // (Nothing set: nothing to save.)
                    const empty = now === '';
                    field.disabled = empty;
                    canSave();
                    if (empty) sayStatus(say('discovery_filter_profile_nothing', 'Set a filter to save it here.'));
                };
                /** Save is there to press once there is something set and a name for it. */
                const canSave = () => { save.disabled = host.read() === '' || field.value.trim() === ''; };
                field.addEventListener('input', canSave);
                const store = async () => {
                    const words = field.value.trim();
                    if (!words) { field.focus(); return; }
                    save.disabled = true;
                    try {
                        const saved = await saveProfile(words, host.read());
                        list = withProfile(list, saved);
                        field.value = '';
                        draw();
                        sayStatus(say('discovery_filter_profile_saved', 'Saved as “{name}”.', { name: saved.name }));
                        handle.say(sayRow(list), true);
                    } catch (error) {
                        const reason = error?.responseJSON?.error ?? error?.error;
                        sayStatus(reason === 'full' ? say('discovery_filter_profile_full', 'Delete a saved one first: you have the most there can be.')
                            : say('discovery_filter_profile_error', 'Could not save that. Try again.'), true);
                    } finally {
                        canSave();
                        handle.placed();
                    }
                };
                save.addEventListener('click', store);
                field.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); store(); } });
                sayStatus(say('discovery_filter_loading', 'Loading…'));
                body.append(rows, form, status);
                loadProfiles().then(answer => {
                    if (!body.isConnected) return;
                    list = answer.profiles;
                    sayStatus('');
                    draw();
                    handle.say(sayRow(list), list.some(isNow));
                    handle.placed();
                }).catch(() => { sayStatus(say('discovery_filter_unavailable', 'Could not load these.'), true); handle.placed(); });
            }
        };
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
    /**
     * Whether a selection is kept: anything narrowing the list, or a list's all / any chosen before its ticks.
     * @param {object} selection
     * @returns {boolean}
     */
    const worthKeeping = selection => logic().activeFilterCount(selection) > 0 || Object.keys(selection?.match ?? {}).length > 0;
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
     * @param {'feed'|'person'|'loaded'} scope - A list page's section, a person's titles, or titles already loaded
     * @param {() => void} onChange - Reloads the list
     * @param {string} [ownGenre] - On a genre's page: that genre's name
     * @param {() => (HTMLElement|null)} [place] - What the button narrows where that is not the header's discovery
     *   section (a page of its own, such as the Recommendations page): it holds the line of what is set, after the header
     * @param {string[]} [fixedAll] - The lists matched by all of what is ticked, with no choice (a tag's page: keywords,
     *   which its own request names and a title can't be checked against)
     * @param {{read: function(): string, apply: function(string): void}} [profiles] - Offers the user's saved filters:
     *   what is set now in the address form, and how the page applies a profile's
     * @returns {HTMLButtonElement}
     */
    function createFiltersControl(header, moduleName, scope, onChange, ownGenre, place, fixedAll = [], profiles = null) {
        injectStyles();
        /** The section the header is in, or the page the button narrows. */
        const sectionOf = place ?? (() => header.closest('.jellyseerr-discovery-section'));
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
            const section = sectionOf();
            let line = section?.querySelector('.jellyseerr-filters-set') ?? null;
            const tokens = filterTokens({ offered, label, locale: localeOf(), selection: selectionOf(moduleName), ownGenre });
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
            const made = tokens.map((token, index) => {
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
                if (!token.join) return piece;
                // (Several of a list, joined by its rule: "With bear" or "dragon", "Action" and "Comedy". The word goes
                // with what follows it.)
                const joined = document.createElement('span');
                joined.className = 'jellyseerr-filters-join';
                joined.textContent = token.join === 'or' ? label('discovery_filter_or', 'or') : label('discovery_filter_and', 'and');
                // (The space is for a screen reader's words; the margin spaces it to the eye.)
                piece.prepend(joined, ' ');
                piece.dataset.join = token.join;
                return piece;
            });
            // A list's run joined by its word is one unit on the line: closer together, to the next line whole, and
            // named as its group is ("Genres"), so a reader that moves by group hears which list it is.
            const pieces = [];
            for (const [index, piece] of made.entries()) {
                if (piece.dataset.join === undefined) { pieces.push(piece); continue; }
                const before = pieces[pieces.length - 1];
                const run = before?.classList.contains('jellyseerr-filters-run') ? before : document.createElement('span');
                if (run !== before) {
                    run.className = 'jellyseerr-filters-run';
                    run.setAttribute('role', 'group');
                    const list = tokens[index].list;
                    if (list && NAMES[list]) run.setAttribute('aria-label', label(NAMES[list][0], NAMES[list][1]));
                    pieces.splice(pieces.length - 1, 1, run);
                    run.appendChild(before);
                }
                run.appendChild(piece);
            }
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
            const section = sectionOf();
            // (A page of its own shows its own placeholders while it reloads.)
            if (section?.classList.contains('jellyseerr-discovery-section')) JE.discoveryBusy?.mark?.(section);
            section?.toggleAttribute('data-jobs-first', roles.length > 0 && !roles.some(role => role.id === 'cast'));
            // And among the jobs, the ones asked for lead ("Director, Writer" for Directing): a line that does not fit loses jobs from its end.
            if (section) {
                section.setAttribute(JE.discoveryRoles?.ROLE_ASKED ?? 'data-role-asked', roles.map(role => role.id).join('|'));
                JE.discoveryRoles?.fitRoleLines?.(section);
            }
            paintSet(focusAt);
        };
        wiring.set(header, { paint: (at = -1) => paint(at), reload: onChange });
        // (Asked for once per visit, so the menu can name the profile that is set when it opens.)
        if (profiles && profilesReachable()) loadProfiles().catch(() => {});
        paint();
        // What was set before the last change: "Nothing matches" offers to go back to it.
        let undoTo = null;
        /**
         * Takes a new selection: redraws, keeps the list's place while it is rebuilt, and reloads it.
         * @param {object} next - The new FilterSelection
         * @param {number} [focusAt] - Where the keys go after a piece is taken away (-1: they stay)
         */
        function change(next, focusAt = -1) {
            undoTo = selectionOf(moduleName);
            if (worthKeeping(next)) moreFilters.set(moduleName, next); else moreFilters.delete(moduleName);
            paint(focusAt);
            JE.discoveryBusy?.hold?.(button);
            onChange();
        }
        /** Opens the Filters menu under the button. */
        const open = () => {
            const menu = JE.discoveryMenu;
            const type = typeOf();
            const typeInMenu = !!type && !type.tabsShowing();
            // Where the tabs are out of sight the viewer may have come for them: that group is open.
            const groups = type && typeInMenu ? [{ ...type.groupOf(), open: true }] : [];
            // The user's saved filters first, where the page can apply them.
            if (profiles && profilesReachable()) groups.push(profilesGroup({ label, host: profiles, scope, offered, locale: localeOf() }));
            // The kinds the page shows (its tabs' choice, else the kinds its feeds have): a content rating of another
            // kind can't narrow it.
            const mode = JE.discoveryFilter?.getFilterMode?.(moduleName);
            const pageKinds = (header.closest('[data-je-kinds]')?.getAttribute('data-je-kinds') ?? '').split(',').filter(Boolean);
            const kinds = mode === 'movies' ? ['movie'] : mode === 'tv' ? ['tv'] : pageKinds.length > 0 ? pageKinds : null;
            groups.push(...filterMenuGroups({
                offered, data: dataOf(), locale: localeOf(), label, kinds,
                selection: () => selectionOf(moduleName), change, fixedAll, ...(ownGenre ? { ownGenre } : {}),
                roles: () => rolesOf(credits.get(moduleName) ?? [], label('discovery_role_acting', 'Acting'),
                    department => label(`discovery_role_${department.toLowerCase().replace(/[^a-z]+/g, '_')}`, department))
            }));
            if (groups.length === 0 || typeof menu?.openMenu !== 'function') { roomUnderMenu(sectionOf(), header, false); return; }
            button.setAttribute('aria-expanded', 'true');
            menu.openMenu({
                anchor: button, title: filtersLabel, groups, clearLabel, doneLabel: label('discovery_filters_done', 'Done'),
                noneLabel: label('discovery_filters_none', 'Nothing matches these filters.'),
                undoLabel: () => {
                    // (What the last change set that was not set before: "Undo Score from 9.9".)
                    const words = selection => filterTokens({ offered, label, locale: localeOf(), selection, ownGenre }).map(token => token.alone ?? token.words);
                    const was = undoTo ?? {};
                    const now = selectionOf(moduleName);
                    const before = new Set(words(was));
                    const added = words(now).find(word => !before.has(word));
                    if (added) return label('discovery_filters_undo_what', 'Undo “{change}”', { change: added });
                    // (A rule switched: "Undo all ticked in Streaming services".)
                    const ruled = Object.keys(logic().MATCH_DEFAULTS ?? {}).find(id => logic().matchOf(was, id) !== logic().matchOf(now, id));
                    if (ruled) {
                        const rule = logic().matchOf(now, ruled) === 'any' ? label('discovery_filter_match_any', 'any ticked') : label('discovery_filter_match_all', 'all ticked');
                        return label('discovery_filters_undo_rule', 'Undo “{rule}” in {filter}', { rule, filter: label(NAMES[ruled][0], NAMES[ruled][1]) });
                    }
                    // (A piece taken away: "Put back Kids".)
                    const after = new Set(words(now));
                    const removed = words(was).find(word => !after.has(word));
                    return removed ? label('discovery_filters_undo_back', 'Put back “{piece}”', { piece: removed }) : label('discovery_filters_undo', 'Undo');
                },
                canUndo: () => undoTo !== null,
                // (Back to what was set before the last change; the menu then says every group again.)
                onUndo() {
                    if (!undoTo) return false;
                    const back = undoTo;
                    change(back);
                    undoTo = null;
                    return true;
                },
                onClose: () => { button.setAttribute('aria-expanded', 'false'); roomUnderMenu(sectionOf(), header, false); },
                // The groups that are a list of choices; the others set themselves (filterMenuGroups).
                onPick(id, groupId) {
                    if (groupId === 'type' && isFilterMode(id)) type?.choose(id);
                },
                onClear() {
                    if (typeInMenu) type?.choose(MIXED());
                    if (worthKeeping(selectionOf(moduleName))) change({});
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
            .jellyseerr-filters-set { --jellyseerr-accent: var(--jf-palette-primary-main, #00a4dc); display: flex; flex-wrap: wrap; align-items: center; gap: .25em 1.6em; margin: .4em 0 .7em; color: var(--jf-palette-text-secondary, rgba(255,255,255,.7)); }
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
            .jellyseerr-menu-input::placeholder { color: var(--jellyseerr-quiet, var(--jf-palette-text-secondary, rgba(255,255,255,.7))); opacity: 1; }
            .jellyseerr-menu-input:focus { outline: none; border-color: var(--jf-palette-primary-main, #00a4dc); box-shadow: 0 0 0 1px var(--jf-palette-primary-main, #00a4dc); }
            .jellyseerr-sort-menu { --jellyseerr-error: var(--jf-palette-error-light, #e57373); --jellyseerr-quiet: var(--jf-palette-text-secondary, rgba(255,255,255,.7)); }
            /* (Quiet on every theme: the text the theme draws, at 70%. A theme's secondary text can be as strong as its text.) */
            @supports (color: color-mix(in srgb, red, blue)) { .jellyseerr-sort-menu { --jellyseerr-quiet: color-mix(in srgb, currentColor 70%, transparent); } }
            @supports (color: color-mix(in oklab, red 60%, blue)) { .jellyseerr-sort-menu { --jellyseerr-error: color-mix(in oklab, var(--jf-palette-error-main, #f44336) 52%, var(--jf-palette-text-primary, #fff)); } }
            .jellyseerr-menu-input[aria-invalid="true"] { border-color: var(--jellyseerr-error); box-shadow: 0 0 0 1px var(--jellyseerr-error); }
            /* What cannot be used is also said in words, where the hint was. */
            .jellyseerr-menu-note[data-error] { color: var(--jellyseerr-error); }
            /* A list's search field stays in sight under its group's row while the list scrolls. */
            .jellyseerr-menu-searchbar { position: sticky; top: calc(var(--jellyseerr-menu-head, 36px) - 1px); z-index: 1; padding: 5px 16px 6px 32px; background-color: var(--jellyseerr-menu-ground); background-image: var(--jellyseerr-menu-shade); }
            .jellyseerr-menu-search { display: block; width: 100%; }
            /* A row to tick has a box, empty until it is ticked (then in the accent); one given by the page itself is dim and cannot be pressed. */
            .jellyseerr-sort-menu .jellyseerr-menu-tick .actionsheetMenuItemIcon { color: var(--jellyseerr-quiet, var(--jf-palette-text-secondary, rgba(255,255,255,.7))); }
            .jellyseerr-sort-menu .jellyseerr-menu-tick[aria-checked="true"] .actionsheetMenuItemIcon { color: var(--jellyseerr-accent); }
            html .jellyseerr-sort-menu .actionSheetMenuItem.jellyseerr-menu-tick[aria-disabled="true"] { color: var(--jellyseerr-quiet, rgba(255,255,255,.7)); cursor: default; background: none !important; }
            .jellyseerr-sort-menu .jellyseerr-menu-tick[aria-disabled="true"] .actionsheetMenuItemIcon { color: var(--jf-palette-text-disabled, rgba(255,255,255,.5)); }
            /* A long name in a list takes a second line: its end is often what tells two entries apart ("… Amazon Channel"). (Its box stays in the row's middle, as on any list of two-line items.) */
            html .jellyseerr-sort-menu .jellyseerr-menu-list .actionSheetItemText { min-width: 0; white-space: normal; overflow-wrap: anywhere; }
            /* The letters a search found in a name. */
            .jellyseerr-menu-found { font-weight: 700; }
            /* Under what is ticked or likeliest wanted at a long list's head, before the rest of it. */
            .jellyseerr-menu-list-rule { height: 1px; margin: 4px 16px 4px 32px; background: var(--jf-palette-divider, rgba(255,255,255,.12)); }
            .jellyseerr-menu-note, .jellyseerr-menu-label { color: var(--jellyseerr-quiet, var(--jf-palette-text-secondary, rgba(255,255,255,.7))); }
            .jellyseerr-menu-note { padding: 2px 16px 8px 32px; font-size: .86em; line-height: 1.4; }
            /* All of what is ticked, or any of it: two small choices on the rule's line, the one in use filled. */
            /* The theme's own grounds; the choice in use in the accent, as everything set in this menu is. */
            .jellyseerr-menu-match { display: flex; flex-flow: row wrap; align-items: center; gap: .35em .6em; }
            .jellyseerr-menu-searchbar .jellyseerr-menu-note { padding: 6px 0 0; }
            .jellyseerr-menu-match-track { display: inline-flex; gap: 2px; padding: 2px; border-radius: 999px; background: var(--jf-palette-action-hover, rgba(255,255,255,.08)); box-shadow: inset 0 0 0 1px var(--jf-palette-divider, rgba(255,255,255,.12)); }
            .jellyseerr-menu-match-btn { display: inline-flex; flex-direction: column; align-items: center; justify-content: center; font: inherit; color: inherit; white-space: nowrap; background: none; border: 0; border-radius: 999px; padding: .3em .65em; cursor: pointer; }
            /* The half in use on the sheet's own ground, in the accent with its ring (readable on any theme). */
            .jellyseerr-menu-match-btn[aria-checked="true"] { background-color: var(--jellyseerr-menu-ground, transparent); background-image: var(--jellyseerr-menu-shade, none); color: var(--jellyseerr-accent); box-shadow: inset 0 0 0 1px var(--jellyseerr-accent); font-weight: 600; }
            /* The other half can be pressed: it answers the pointer. */
            .jellyseerr-menu-match-btn:not([aria-checked="true"]):hover { background: var(--jf-palette-action-hover, rgba(255,255,255,.08)); color: var(--jf-palette-text-primary, #fff); }
            /* Below two ticks the choice changes nothing: shown, but not in the accent that says the list is narrowed. */
            .jellyseerr-menu-match[data-idle] .jellyseerr-menu-match-btn[aria-checked="true"] { color: var(--jf-palette-text-primary, #fff); box-shadow: inset 0 0 0 1px var(--jf-palette-text-disabled, rgba(255,255,255,.5)); box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 55%, transparent); font-weight: 500; }
            .jellyseerr-menu-match-btn:focus-visible { outline: 2px solid var(--jf-palette-text-primary, #fff); outline-offset: 1px; }
            /* (Two equal columns wherever there is room for both at the wider's width; never wider than the line, so the
               choice never moves the list.) */
            html:not(.layout-tv) .jellyseerr-menu-match-track { display: grid; grid-template-columns: 1fr 1fr; flex: 1 1 0; }
            .jellyseerr-menu-match-reserve { display: block; height: 0; overflow: hidden; visibility: hidden; font-weight: 600; }
            @media (forced-colors: active) {
                .jellyseerr-menu-match-track { outline: 1px solid CanvasText; outline-offset: -1px; }
                .jellyseerr-menu-list-rule { forced-color-adjust: none; background: CanvasText; }
                .jellyseerr-sort-menu .jellyseerr-menu-group[data-set] .jellyseerr-menu-group-value { forced-color-adjust: none; color: LinkText; }
                .jellyseerr-menu-match-btn[aria-checked="true"] { outline: 2px solid Highlight; outline-offset: -2px; }
                .jellyseerr-menu-match-btn:focus-visible { outline: 3px solid CanvasText; outline-offset: 1px; }
            }
            /* On a TV the half the remote is on is the inverted pill the Filters button uses; the half in use keeps its ring. */
            .layout-tv .jellyseerr-menu-match-btn:focus { outline: none; background: var(--jf-palette-text-primary, #fff); color: var(--jellyseerr-menu-ground, #101010); }
            /* Under the remote, the half in use keeps its mark: an accent ring outside the pill. */
            .layout-tv .jellyseerr-menu-match-btn[aria-checked="true"]:focus { box-shadow: 0 0 0 3px var(--jellyseerr-accent); }
            /* An open group's list sits in from its row on a TV too. */
            .layout-tv .jellyseerr-sort-menu .jellyseerr-menu-choices > .actionSheetMenuItem,
            .layout-tv .jellyseerr-sort-menu .jellyseerr-menu-choices .jellyseerr-menu-list > .actionSheetMenuItem { padding-inline-start: 3.5em; }
            .layout-tv .jellyseerr-menu-match { font-size: 1rem; }
            .layout-tv .jellyseerr-menu-match-btn { padding: .45em 1.1em; }
            /* On a touch screen, as wide as the search field above it and a finger's height. */
            @media (pointer: coarse), (max-width: 600px) {
                html:not(.layout-tv) .jellyseerr-menu-match-track { display: grid; grid-template-columns: 1fr 1fr; flex: 1 1 12em; }
                html:not(.layout-tv) .jellyseerr-menu-match-btn { flex: 1 1 0; min-height: 44px; }
            }
            /* Saved filters: each profile a row with its delete button at the end; the form a field and Save. */
            .jellyseerr-menu-profile-row { display: flex; align-items: center; }
            .jellyseerr-menu-profile-row > .actionSheetMenuItem { flex: 1 1 auto; min-width: 0; }
            .jellyseerr-menu-profile-delete { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; margin-inline-end: 2.5px; border: 0; border-radius: 50%; background: none; color: var(--jellyseerr-quiet, var(--jf-palette-text-secondary, rgba(255,255,255,.7))); cursor: pointer; }
            .jellyseerr-menu-profile-delete:hover, .jellyseerr-menu-profile-delete:focus-visible { background: var(--jf-palette-action-hover, rgba(255,255,255,.08)); color: var(--jf-palette-text-primary, #fff); outline: none; }
            /* The keys on it: ringed as the all / any choice is. */
            html:not(.layout-tv) .jellyseerr-menu-profile-delete:focus-visible { outline: 2px solid var(--jf-palette-text-primary, #fff); outline-offset: -2px; }
            @media (forced-colors: active) { .jellyseerr-menu-profile-delete:focus-visible { outline: 3px solid CanvasText; } }
            /* Saved filters stand apart from the filters under them: a quiet line between, open or not. */
            .jellyseerr-menu-group[data-toggle="profiles"][aria-expanded="false"] + .jellyseerr-menu-choices + .jellyseerr-menu-group { border-top: 1px solid var(--jf-palette-divider, rgba(255,255,255,.12)); }
            .layout-tv .jellyseerr-menu-profile-delete:focus { background: var(--jf-palette-text-primary, #fff); color: var(--jellyseerr-menu-ground, #101010); }
            .jellyseerr-menu-profile-save { flex: none; align-self: stretch; height: auto; min-height: 0; margin: 0; padding: 0 1em; }
            /* A profile not in use keeps no room for the tick it does not show (on a TV the tick is the row's first column: kept). */
            html:not(.layout-tv) .jellyseerr-menu-profile .actionsheetMenuItemIcon { display: none !important; }
            html:not(.layout-tv) .jellyseerr-menu-profile[aria-current] .actionSheetItemText { color: var(--jellyseerr-accent); font-weight: 500; }
            @media (forced-colors: active) {
                html:not(.layout-tv) .jellyseerr-menu-profile[aria-current] .actionSheetItemText { forced-color-adjust: none; color: LinkText; }
                html .jellyseerr-sort-menu .jellyseerr-menu-profile-save { border: 1px solid ButtonBorder; }
                html .jellyseerr-sort-menu .jellyseerr-menu-profile-save:disabled { opacity: 1; color: GrayText; border-color: GrayText; }
            }
            .jellyseerr-menu-profile-save:disabled { opacity: .45; cursor: default; box-shadow: none; }
            @media (pointer: coarse) { .jellyseerr-menu-profile-undo { min-height: 44px; padding-inline: .75em; } }
            html .jellyseerr-sort-menu .jellyseerr-menu-profile-says { font-size: .85em; line-height: 1.4; white-space: normal; overflow-wrap: anywhere; color: var(--jellyseerr-quiet, rgba(255,255,255,.7)) !important; opacity: 1; }
            .jellyseerr-menu-profile-part { display: inline-block; max-width: 100%; }
            .jellyseerr-menu-profile-undo { font: inherit; margin-inline-start: .5em; padding: .2em .5em; border: 0; border-radius: 4px; background: none; color: var(--jellyseerr-accent); text-decoration: underline; cursor: pointer; }
            .jellyseerr-menu-profile-undo:focus-visible { outline: 2px solid var(--jf-palette-text-primary, #fff); outline-offset: 1px; }
            .layout-tv .jellyseerr-menu-profile-undo:focus { outline: none; background: var(--jf-palette-text-primary, #fff); color: var(--jellyseerr-menu-ground, #101010); text-decoration: none; }
            .jellyseerr-filters-run { display: inline-flex; flex-wrap: wrap; align-items: center; gap: .15em .4em; max-width: 100%; }
            .jellyseerr-filters-token > .jellyseerr-filters-join { flex: none; overflow: visible; margin-inline-end: .35em; color: var(--jf-palette-text-secondary, rgba(255,255,255,.7)); }
            /* An open group's row reads as the heading of what is under it; a long value is cut with an ellipsis. */
            .jellyseerr-menu-group[aria-expanded="true"] .actionSheetItemText { font-weight: 500; }
            .jellyseerr-menu-group-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
            /* (The saved set in use is named whole: its name takes a second line on its row rather than being cut.) */
            html .jellyseerr-sort-menu .jellyseerr-menu-group[data-toggle="profiles"][data-set] .jellyseerr-menu-group-value { white-space: normal; text-align: end; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
            /* A value said short to the eye is said whole to a screen reader. */
            .jellyseerr-menu-whole { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
            /* Why the page's own genre is ticked and can't be unticked, under its name. */
            .jellyseerr-sort-menu .jellyseerr-menu-given { font-size: .85em; white-space: normal; color: inherit; opacity: 1; }
            html .jellyseerr-sort-menu .jellyseerr-menu-elsewhere { color: var(--jellyseerr-quiet, rgba(255,255,255,.7)); }
            html .jellyseerr-sort-menu .jellyseerr-menu-tick[aria-disabled="true"] .actionSheetItemText,
            html .jellyseerr-sort-menu .jellyseerr-menu-tick[aria-disabled="true"] .jellyseerr-menu-given { color: inherit !important; opacity: 1 !important; }
            /* The foot's line when nothing matches: over "Clear filters", the way out. */
            .jellyseerr-sort-menu .jellyseerr-menu-outcome { flex: 0 0 calc(100% - 16px); box-sizing: border-box; display: flex; align-items: center; justify-content: space-between; gap: .75em; margin: 8px 8px 4px; padding: 6px 6px 6px calc(var(--jellyseerr-menu-text, 16px) - 8px); border-radius: 8px; color: var(--jf-palette-text-primary, #fff); background: rgba(0,164,220,.14); background: color-mix(in srgb, var(--jellyseerr-accent, #00a4dc) 16%, transparent); }
            .jellyseerr-sort-menu .jellyseerr-menu-outcome[hidden] { display: none; }
            /* (Undo right after its sentence, as a deleted set's is: the band's words run on, and wrap as words do.) */
            .jellyseerr-sort-menu .jellyseerr-menu-outcome { display: block; }
            .jellyseerr-menu-outcome-undo { display: inline; margin-inline-start: .35em; font: inherit; padding: .3em .6em; border: 0; border-radius: 6px; background: none; color: var(--jellyseerr-accent); text-decoration: underline; cursor: pointer; }
            .jellyseerr-menu-outcome-undo:focus-visible { outline: 2px solid var(--jf-palette-text-primary, #fff); outline-offset: 1px; }
            .layout-tv .jellyseerr-menu-outcome-undo:focus { outline: none; background: var(--jf-palette-text-primary, #fff); color: var(--jellyseerr-menu-ground, #101010); text-decoration: none; }
            /* (On touch, a 44px target reaching past the band's words without making the band taller.) */
            @media (pointer: coarse) { .jellyseerr-menu-outcome-undo { display: inline-block; min-height: 44px; margin-block: -12px; vertical-align: middle; } }
            @media (forced-colors: active) { .jellyseerr-sort-menu .jellyseerr-menu-outcome { border: 1px solid CanvasText; } }
            /* What a search has narrowed away is gone (a row's own display would otherwise keep it). */
            .jellyseerr-sort-menu .actionSheetMenuItem[hidden], .jellyseerr-menu-note[hidden], .jellyseerr-menu-label[hidden] { display: none !important; }
            .jellyseerr-menu-label { padding: 8px 16px 2px 32px; font-size: .86em; }
            .jellyseerr-menu-list:empty { display: none; }
            /* (A phone's browser zooms into a field whose type is under 16px.) */
            @media (max-width: 600px) { .jellyseerr-menu-input { font-size: max(1em, 16px); min-height: 44px; } }
            .jellyseerr-menu-group .listItemBody { display: flex; flex-direction: row; align-items: baseline; justify-content: space-between; gap: 1.5em; }
            /* The filter's name is never cut: a long value gives way, with an ellipsis. */
            html .jellyseerr-sort-menu .jellyseerr-menu-group .actionSheetItemText { flex: 0 0 auto; }
            html .jellyseerr-sort-menu .jellyseerr-menu-group .jellyseerr-menu-group-value { flex: 0 1 auto; min-width: 0; }
            .jellyseerr-menu-group-value { color: var(--jellyseerr-quiet, var(--jf-palette-text-secondary, rgba(255,255,255,.7))); white-space: nowrap; }
            .jellyseerr-menu-group[data-set] .jellyseerr-menu-group-value { color: var(--jellyseerr-accent); }
            .jellyseerr-menu-group .actionsheetMenuItemIcon { transition: transform .15s; }
            .jellyseerr-menu-group[aria-expanded="true"] .actionsheetMenuItemIcon { transform: rotate(180deg); }
            html:not(.layout-tv) .jellyseerr-sort-menu .jellyseerr-menu-group .actionsheetMenuItemIcon { margin-inline-start: .6em !important; }
            html:not(.layout-tv) .jellyseerr-sort-menu .jellyseerr-menu-choices .actionSheetMenuItem { padding-inline-start: 32px; }
            /* "Clear filters" is the menu's foot, always in reach; at full strength only while something is set. */
            html:not(.layout-tv) .jellyseerr-sort-menu .jellyseerr-menu-foot { margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--jf-palette-divider, rgba(255,255,255,.12)); }
            html:not(.layout-tv) .jellyseerr-sort-menu .jellyseerr-menu-foot { display: flex; flex-wrap: wrap; }
            html:not(.layout-tv) .jellyseerr-sort-menu .jellyseerr-menu-foot > .actionSheetMenuItem { width: auto; }
            html:not(.layout-tv) .jellyseerr-sort-menu .jellyseerr-menu-clear { flex: 1 1 auto; }
            /* On a touch screen the menu can fill the screen: its foot then ends with the way out, said (nothing waits for it; what is set has taken effect). */
            .jellyseerr-sort-menu .jellyseerr-menu-done { display: none !important; flex: none; }
            .jellyseerr-sort-menu .jellyseerr-menu-done .actionsheetMenuItemIcon { display: none; }
            /* On a touch screen "Done" is the way back to the list: the foot's main action, "Clear filters" the quiet one. */
            .jellyseerr-sort-menu .jellyseerr-menu-done .actionSheetItemText { font-weight: 500; color: var(--jellyseerr-accent); }
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
         * Sets a module's further filters as a whole (from its page's address); the caller redraws and reloads.
         * @param {string} name - The module name
         * @param {object} selection - The FilterSelection
         */
        setSelection(name, selection) {
            if (worthKeeping(selection)) moreFilters.set(name, selection);
            else moreFilters.delete(name);
        },
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
