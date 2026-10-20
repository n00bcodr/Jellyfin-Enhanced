/**
 * @file Requests & downloads, phase 4c3b: what part of a title a list entry holds. A presenter: it draws into a root its
 * caller owns, every write, awaited read and listener through its own effects on the caller's ticket (lp.surface:
 * checked again when they run), every word through the ticket's guarded words, and reads season and episode facts only
 * through the producer reads it is given (typed by lp.metadata; JE-only enumeration is a pending producer read). Nothing
 * runs on load.
 *
 * A movie is the movie. A show is the whole show, one season, or episodes of ONE season; specials are season 0, chosen
 * explicitly (listed last, never a default). Seasons load only when a season scope is asked for, episodes only for the
 * chosen season; a newer season choice wins over an older, slower load. At most 100 episodes: the 101st pick is refused
 * in words. The caller's exact scope (a season, episodes, the 4K edition) is preselected exactly; when the facts can't
 * be read, that scope never widens to the season or the show: nothing is chosen until the person chooses. Episode
 * titles and air dates of a title Spoiler Guard covers (by the ticket's policy) stay out of the text and labels.
 *
 * Internal: lp.granularity { KEYS, DEPENDS, create }.
 */
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const lp = JE.internals.arrListPages = JE.internals.arrListPages || {};

    const KEYS = Object.freeze([
        'arr_lists_gran_label', 'arr_lists_gran_movie', 'arr_lists_gran_series', 'arr_lists_gran_season', 'arr_lists_gran_episodes',
        'arr_lists_gran_specials', 'arr_lists_gran_season_n', 'arr_lists_gran_episode_n', 'arr_lists_gran_loading',
        'arr_lists_gran_unavailable', 'arr_lists_gran_partial', 'arr_lists_gran_limit', 'arr_lists_gran_scope_lost'
    ]);
    const MODES = ['series', 'season', 'episodes'];
    /**
     * What depends on what (upstream → dependents). A change of an upstream ends its dependents' work in flight and
     * resets them: any choice of the person ends the preselection (initialization is an intent too); a mode change drops
     * the episodes picked in the old mode; a season change drops the old season's episode facts, its episode load and its
     * picks, whatever the mode.
     */
    const DEPENDS = Object.freeze({
        user: Object.freeze(['preselect']),
        mode: Object.freeze(['selection']),
        season: Object.freeze(['episodes', 'selection'])
    });
    let instances = 0;

    /**
     * A scope picker for one title.
     * @param {{ticket: Object, root: HTMLElement, media: {mediaType: string, tmdbId: number, title?: string},
     *   initial?: {kind: string, seasonNumber?: number, episodes?: number[], edition?: string},
     *   seasons?: function(number, Object): Promise<{status: number, body: *}>,
     *   episodes?: function(number, number, Object): Promise<{status: number, body: *}>}} options Options.
     * @returns {Object} Picker.
     */
    function create({ ticket, root, media, initial, seasons, episodes }) {
        const put = lp.surface.put;
        const fx = lp.surface.effects({ ticket, depends: DEPENDS });
        const w = lp.surface.words(ticket);
        const max = lp.authoring.LIMITS.episodes;
        const edition = initial?.edition === '4k' ? '4k' : 'standard';
        const tv = media?.mediaType === 'tv';
        const uid = `je-list-gran-${++instances}`;
        const state = { mode: 'series', season: null, seasonFacts: null, episodeFacts: null, checked: new Set(), reason: null, pending: false };
        /** What Spoiler Guard is asked about: the title's episodes (fail closed until the policy is known). */
        const entry = { kind: 'episodes', mediaType: 'tv', tmdbId: media?.tmdbId };
        let seasonsLoad = null;
        let controller = null;

        fx.reset('preselect', () => {
            state.pending = false;
            state.reason = null;
        });
        fx.reset('selection', () => state.checked.clear());
        fx.reset('episodes', () => {
            controller?.abort();
            controller = null;
            state.episodeFacts = null;
        });

        const paint = (fn, key, check = null) => fx.paint(check, fn, key);
        const q = sel => root.querySelector(`.${uid} ${sel}`);

        paint(() => {
            const box = put.el('div', `je-list-gran ${uid}`);
            if (!tv) {
                box.appendChild(put.el('div', 'je-list-gran-movie', w.key('arr_lists_gran_movie')));
                root.appendChild(box);
                return;
            }
            const modes = put.el('div', 'je-list-gran-modes');
            modes.setAttribute('role', 'radiogroup');
            put.attr(modes, 'aria-label', w.key('arr_lists_gran_label'));
            for (const mode of MODES) {
                const label = put.el('label', 'je-list-gran-mode');
                const radio = document.createElement('input');
                radio.type = 'radio';
                radio.name = uid;
                put.data(radio, mode);
                radio.checked = mode === 'series';
                label.append(radio, put.el('span', '', w.key(`arr_lists_gran_${mode}`)));
                modes.appendChild(label);
            }
            const select = document.createElement('select');
            select.className = 'je-list-gran-season';
            select.hidden = true;
            put.attr(select, 'aria-label', w.key('arr_lists_gran_season'));
            const list = put.el('div', 'je-list-gran-episodes');
            list.hidden = true;
            const status = put.el('div', 'je-list-gran-status');
            status.setAttribute('aria-live', 'polite');
            box.append(modes, select, list, status);
            root.appendChild(box);
        }, 'gran');

        /** @param {Object} text Words in the status line. @param {function(): boolean|null} [check] Intent. */
        const say = (text, check = null) => paint(() => { const s = q('.je-list-gran-status'); if (s) put.text(s, text); }, 'gran-status', check);
        /** @returns {Object} The standing words of the status line. */
        const statusWords = () => (state.reason === 'scope_lost' ? w.key('arr_lists_gran_scope_lost')
            : state.seasonFacts?.state === 'unavailable' ? w.key('arr_lists_gran_unavailable')
                : state.seasonFacts?.state === 'partial' ? w.key('arr_lists_gran_partial') : w.none);

        /** Shows the controls of the mode and the season list. */
        function sync() {
            paint(() => {
                for (const radio of root.querySelectorAll(`.${uid} input[type="radio"]`)) radio.checked = radio.value === state.mode;
                const select = q('.je-list-gran-season');
                const list = q('.je-list-gran-episodes');
                const usable = state.seasonFacts && state.seasonFacts.state !== 'unavailable';
                for (const radio of root.querySelectorAll(`.${uid} input[type="radio"]:not([value="series"])`)) radio.disabled = state.seasonFacts?.state === 'unavailable';
                if (select) {
                    select.hidden = state.mode === 'series' || !usable;
                    if (usable && select.options.length !== state.seasonFacts.seasons.length) {
                        select.replaceChildren(...state.seasonFacts.seasons.map(s => {
                            const option = put.el('option', '', s.seasonNumber === 0 ? w.key('arr_lists_gran_specials') : w.key('arr_lists_gran_season_n', { number: s.seasonNumber }));
                            put.data(option, String(s.seasonNumber));
                            return option;
                        }));
                    }
                    if (usable) {
                        if (state.season === null) select.selectedIndex = -1;
                        else put.data(select, String(state.season));
                    }
                }
                if (list) list.hidden = state.mode !== 'episodes';
            }, 'gran-sync');
        }

        /**
         * Draws the episode checklist of the facts loaded (none while they load or after the season changed).
         * @param {function(): boolean|null} [check] The load's intent.
         */
        function drawEpisodes(check = null) {
            paint(() => {
                const list = q('.je-list-gran-episodes');
                if (!list) return;
                const facts = state.episodeFacts;
                list.replaceChildren(...(facts && facts.state !== 'unavailable' ? facts.episodes : []).map(ep => {
                    const label = put.el('label', 'je-list-gran-episode');
                    const box = document.createElement('input');
                    box.type = 'checkbox';
                    put.data(box, String(ep.e));
                    box.checked = state.checked.has(ep.e);
                    // Episode titles and air dates through the guarded words: out of the text while the title is guarded.
                    const words = w.join([w.key('arr_lists_gran_episode_n', { number: ep.e }), w.title(entry, ep.title || ''), ep.airDate ? w.date(entry, ep.airDate) : w.none], ' · ');
                    label.append(box, put.el('span', '', words));
                    return label;
                }));
            }, 'gran-episodes', check);
        }

        /** Loads the season facts once. @returns {Promise<Object|null>} Facts (null: the picker ended). */
        function loadSeasons() {
            if (!seasonsLoad) {
                say(w.key('arr_lists_gran_loading'));
                seasonsLoad = fx.task(fx.intent('seasons'), async (step) => {
                    const facts = lp.metadata.seasonsFrom(typeof seasons === 'function' ? await step(() => seasons(media.tmdbId, {})) : null);
                    state.seasonFacts = facts;
                    say(statusWords());
                    sync();
                    return facts;
                });
            }
            return seasonsLoad;
        }

        /**
         * Loads a season's episodes; only the newest load of the current season is used (a season change ends it).
         * @param {number} season Season.
         * @returns {Promise<Object|null>} Facts (null: superseded).
         */
        function loadEpisodes(season) {
            controller?.abort();
            const check = fx.intent('episodes');
            const local = typeof AbortController === 'function' ? new AbortController() : null;
            controller = local;
            state.episodeFacts = null;
            drawEpisodes();
            return fx.task(check, async (step) => {
                const read = typeof episodes === 'function' ? await step(() => episodes(media.tmdbId, season, { signal: local?.signal })) : null;
                const facts = lp.metadata.episodesFrom(read);
                // Facts of another season are not this season's.
                state.episodeFacts = facts.state !== 'unavailable' && facts.seasonNumber !== season ? { state: 'unavailable', reason: 'mismatch' } : facts;
                if (controller === local) controller = null;
                drawEpisodes(check);
                return state.episodeFacts;
            });
        }

        const picker = {
            ready: Promise.resolve(),
            /** @returns {string|null} Why nothing is chosen ('scope_lost'), or null. */
            reason: () => state.reason,
            /**
             * The current choice, or null while incomplete (or while the caller's scope is still being preselected).
             * @returns {Object|null} Selection.
             */
            selection() {
                if (!tv) return { kind: 'movie', edition };
                if (state.pending || state.reason === 'scope_lost') return null;
                if (state.mode === 'series') return { kind: 'series', edition };
                const usable = state.seasonFacts && state.seasonFacts.state !== 'unavailable';
                if (!usable || state.season === null || !state.seasonFacts.seasons.some(s => s.seasonNumber === state.season)) return null;
                if (state.mode === 'season') return { kind: 'season', seasonNumber: state.season, edition };
                if (!state.checked.size) return null;
                return { kind: 'episodes', seasonNumber: state.season, episodes: Array.from(state.checked).sort((a, b) => a - b).map(e => ({ s: state.season, e })), edition };
            },
            /**
             * The person chooses a scope (it supersedes the preselection; a changed mode drops the old picks).
             * @param {'series'|'season'|'episodes'} mode Mode.
             * @returns {Promise<void>}
             */
            setMode(mode) {
                if (!tv || !MODES.includes(mode) || fx.destroyed) return Promise.resolve();
                const check = fx.intent('user');
                if (mode !== state.mode) {
                    fx.change('mode');
                    state.mode = mode;
                }
                sync();
                drawEpisodes();
                say(statusWords());
                if (mode === 'series') return Promise.resolve();
                return fx.task(check, async (step) => {
                    await step(loadSeasons());
                    if (state.mode === 'episodes' && state.season !== null && state.episodeFacts === null) await step(loadEpisodes(state.season));
                });
            },
            /**
             * The person chooses a season (it supersedes the preselection; a changed season drops the old season's
             * episodes, their load and the picks, whatever the mode).
             * @param {number} season Season (0 = specials).
             * @returns {Promise<void>}
             */
            setSeason(season) {
                if (!tv || !Number.isInteger(season) || fx.destroyed) return Promise.resolve();
                const check = fx.intent('user');
                if (season !== state.season) {
                    fx.change('season');
                    state.season = season;
                }
                sync();
                drawEpisodes();
                say(statusWords());
                if (state.mode !== 'episodes' || state.episodeFacts !== null) return Promise.resolve();
                return fx.task(check, async (step) => {
                    await step(loadEpisodes(season));
                });
            },
            /**
             * Ticks or unticks an episode (the person's choice: it supersedes the preselection).
             * @param {number} e Episode.
             * @param {boolean} on Ticked.
             * @returns {boolean} Done (false: the 101st pick, or not an episode of the season).
             */
            toggleEpisode(e, on) {
                if (fx.destroyed) return false;
                fx.intent('user');
                const facts = state.episodeFacts;
                const known = facts && facts.state !== 'unavailable' && facts.episodes.some(ep => ep.e === e);
                let ok = true;
                if (!on) state.checked.delete(e);
                else if (!known) ok = false;
                else if (!state.checked.has(e) && state.checked.size >= max) ok = false;
                else state.checked.add(e);
                paint(() => {
                    const box = q(`input[type="checkbox"][value="${e}"]`);
                    if (box) box.checked = state.checked.has(e);
                }, `gran-box-${e}`);
                if (!ok && known) say(w.key('arr_lists_gran_limit', { count: max }));
                else if (state.checked.size < max) say(statusWords());
                return ok;
            },
            /** Stops loads and takes the picker away, for good. */
            destroy() {
                fx.destroy();
                controller?.abort();
                lp.gate.erase(() => root.querySelectorAll(`.${uid}`).forEach(n => n.remove()));
            }
        };

        /** Follows the person's choices in the controls. @param {Event} e Change. */
        fx.on(root, 'change', (e) => {
            const target = e.target;
            if (!target || !root.contains(target) || !target.closest?.(`.${uid}`)) return;
            if (target.type === 'radio' && target.name === uid) picker.setMode(target.value);
            else if (target.matches?.('select.je-list-gran-season')) picker.setSeason(Number(target.value));
            else if (target.type === 'checkbox') picker.toggleEpisode(Number(target.value), target.checked);
        });

        // The caller's exact scope, preselected once its facts are known, as an intent of its own: any choice of the
        // person supersedes it (it then changes nothing and says nothing), and it never widens when the facts can't be read.
        if (tv && initial && (initial.kind === 'season' || initial.kind === 'episodes') && Number.isInteger(initial.seasonNumber)) {
            const check = fx.intent('preselect');
            state.pending = true;
            /** Nothing is chosen: the person chooses (a later valid choice of theirs is never blocked). */
            const lost = () => {
                state.pending = false;
                state.reason = 'scope_lost';
                say(statusWords(), check);
            };
            picker.ready = fx.task(check, async (step) => {
                const facts = (await step(loadSeasons())).value;
                if (!facts || facts.state === 'unavailable' || !facts.seasons.some(s => s.seasonNumber === initial.seasonNumber)) return lost();
                if (state.mode !== initial.kind) {
                    fx.change('mode');
                    state.mode = initial.kind;
                }
                if (state.season !== initial.seasonNumber) {
                    fx.change('season');
                    state.season = initial.seasonNumber;
                }
                if (initial.kind === 'episodes') {
                    const loaded = (await step(loadEpisodes(initial.seasonNumber))).value;
                    const wanted = (initial.episodes || []).filter(e => loaded?.episodes?.some(ep => ep.e === e));
                    if (!wanted.length || wanted.length !== (initial.episodes || []).length) return lost();
                    for (const e of wanted.slice(0, max)) state.checked.add(e);
                    drawEpisodes(check);
                }
                state.pending = false;
                sync();
                say(statusWords(), check);
                return undefined;
            });
        }
        return picker;
    }

    lp.granularity = Object.freeze({ KEYS, DEPENDS, create });
})(window.JellyfinEnhanced);
