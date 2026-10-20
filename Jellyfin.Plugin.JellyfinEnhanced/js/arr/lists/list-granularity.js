/**
 * @file Requests & downloads, phase 4c3b: what part of a title a list entry holds. A presenter: it draws into a root its
 * caller owns, every write through the paint gate with the caller's ticket, and reads season and episode facts only
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
 * Internal: lp.granularity { KEYS, create }.
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
    let instances = 0;

    /** @param {string} key Key. @param {Object} [params] Parameters. @returns {string} Words. */
    const tr = (key, params) => lp.render.tr(key, params);

    /**
     * A scope picker for one title.
     * @param {{ticket: Object, root: HTMLElement, media: {mediaType: string, tmdbId: number, title?: string},
     *   initial?: {kind: string, seasonNumber?: number, episodes?: number[], edition?: string},
     *   seasons?: function(number, Object): Promise<{status: number, body: *}>,
     *   episodes?: function(number, number, Object): Promise<{status: number, body: *}>}} options Options.
     * @returns {Object} Picker.
     */
    function create({ ticket, root, media, initial, seasons, episodes }) {
        const el = lp.render.el;
        const max = lp.authoring.LIMITS.episodes;
        const edition = initial?.edition === '4k' ? '4k' : 'standard';
        const tv = media?.mediaType === 'tv';
        const uid = `je-list-gran-${++instances}`;
        const state = { mode: 'series', season: null, seasonFacts: null, episodeFacts: null, checked: new Set(), reason: null, destroyed: false };
        let seasonsLoad = null;
        let episodeSeq = 0;
        let controller = null;
        /** The guard asks about the title (fail closed: everything covered until the policy is known). */
        const covered = () => lp.authoring.guarded(ticket, { kind: 'episodes', mediaType: 'tv', tmdbId: media?.tmdbId });

        const paint = (fn, key) => !state.destroyed && lp.gate.paint(ticket, fn, key);
        const q = sel => root.querySelector(`.${uid} ${sel}`);

        paint(() => {
            const box = el('div', `je-list-gran ${uid}`);
            if (!tv) {
                box.appendChild(el('div', 'je-list-gran-movie', tr('arr_lists_gran_movie')));
                root.appendChild(box);
                return;
            }
            const modes = el('div', 'je-list-gran-modes');
            modes.setAttribute('role', 'radiogroup');
            modes.setAttribute('aria-label', tr('arr_lists_gran_label'));
            for (const mode of MODES) {
                const label = el('label', 'je-list-gran-mode');
                const radio = document.createElement('input');
                radio.type = 'radio';
                radio.name = uid;
                radio.value = mode;
                radio.checked = mode === 'series';
                label.append(radio, el('span', '', tr(`arr_lists_gran_${mode}`)));
                modes.appendChild(label);
            }
            const select = document.createElement('select');
            select.className = 'je-list-gran-season';
            select.hidden = true;
            select.setAttribute('aria-label', tr('arr_lists_gran_season'));
            const list = el('div', 'je-list-gran-episodes');
            list.hidden = true;
            const status = el('div', 'je-list-gran-status');
            status.setAttribute('aria-live', 'polite');
            box.append(modes, select, list, status);
            root.appendChild(box);
        }, 'gran');

        /** @param {string} text Words in the status line. */
        const say = text => paint(() => { const s = q('.je-list-gran-status'); if (s) s.textContent = text; }, 'gran-status');

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
                            const option = el('option', '', s.seasonNumber === 0 ? tr('arr_lists_gran_specials') : tr('arr_lists_gran_season_n', { number: s.seasonNumber }));
                            option.value = String(s.seasonNumber);
                            return option;
                        }));
                    }
                    if (usable) {
                        if (state.season === null) select.selectedIndex = -1;
                        else select.value = String(state.season);
                    }
                }
                if (list) list.hidden = state.mode !== 'episodes';
            }, 'gran-sync');
        }

        /** Loads the season facts once. @returns {Promise<Object>} Facts. */
        function loadSeasons() {
            if (!seasonsLoad) {
                say(tr('arr_lists_gran_loading'));
                seasonsLoad = lp.metadata.readSeasons(seasons, media.tmdbId, {}).then((facts) => {
                    state.seasonFacts = facts;
                    if (facts.state === 'unavailable') say(state.reason === 'scope_lost' ? tr('arr_lists_gran_scope_lost') : tr('arr_lists_gran_unavailable'));
                    else say(facts.state === 'partial' ? tr('arr_lists_gran_partial') : '');
                    sync();
                    return facts;
                });
            }
            return seasonsLoad;
        }

        /** Draws the episode checklist of the facts loaded. */
        function drawEpisodes() {
            paint(() => {
                const list = q('.je-list-gran-episodes');
                if (!list) return;
                const facts = state.episodeFacts;
                const hide = covered();
                list.replaceChildren(...(facts && facts.state !== 'unavailable' ? facts.episodes : []).map(ep => {
                    const label = el('label', 'je-list-gran-episode');
                    const box = document.createElement('input');
                    box.type = 'checkbox';
                    box.value = String(ep.e);
                    box.checked = state.checked.has(ep.e);
                    const words = [tr('arr_lists_gran_episode_n', { number: ep.e })];
                    if (!hide && ep.title) words.push(ep.title);
                    if (!hide && ep.airDate) words.push(lp.render.formatDate(ep.airDate));
                    label.append(box, el('span', '', words.join(' · ')));
                    return label;
                }));
            }, 'gran-episodes');
        }

        /**
         * Loads a season's episodes; only the newest season's answer is used.
         * @param {number} season Season.
         * @returns {Promise<void>}
         */
        async function loadEpisodes(season) {
            const mine = ++episodeSeq;
            controller?.abort();
            controller = typeof AbortController === 'function' ? new AbortController() : null;
            state.episodeFacts = null;
            drawEpisodes();
            let facts;
            try {
                facts = await lp.metadata.readEpisodes(episodes, media.tmdbId, season, { signal: controller?.signal });
            } catch {
                facts = { state: 'unavailable', reason: 'outage' };
            }
            if (mine !== episodeSeq || state.destroyed) return;
            // Facts of another season are not this season's.
            state.episodeFacts = facts.state !== 'unavailable' && facts.seasonNumber !== season ? { state: 'unavailable', reason: 'mismatch' } : facts;
            drawEpisodes();
        }

        /** Ticks/unticks from the checklist. @param {Event} e Change. */
        const onChange = (e) => {
            const target = e.target;
            if (!target || !root.contains(target) || !target.closest?.(`.${uid}`)) return;
            if (target.type === 'radio' && target.name === uid) picker.setMode(target.value);
            else if (target.matches?.('select.je-list-gran-season')) picker.setSeason(Number(target.value));
            else if (target.type === 'checkbox') picker.toggleEpisode(Number(target.value), target.checked);
        };
        root.addEventListener('change', onChange);

        const picker = {
            ready: Promise.resolve(),
            /** @returns {string|null} Why nothing is chosen ('scope_lost'), or null. */
            reason: () => state.reason,
            /**
             * The current choice, or null while incomplete.
             * @returns {Object|null} Selection.
             */
            selection() {
                if (!tv) return { kind: 'movie', edition };
                if (state.reason === 'scope_lost') return null;
                if (state.mode === 'series') return { kind: 'series', edition };
                const usable = state.seasonFacts && state.seasonFacts.state !== 'unavailable';
                if (!usable || state.season === null || !state.seasonFacts.seasons.some(s => s.seasonNumber === state.season)) return null;
                if (state.mode === 'season') return { kind: 'season', seasonNumber: state.season, edition };
                if (!state.checked.size) return null;
                return { kind: 'episodes', seasonNumber: state.season, episodes: Array.from(state.checked).sort((a, b) => a - b).map(e => ({ s: state.season, e })), edition };
            },
            /**
             * The person chooses a scope.
             * @param {'series'|'season'|'episodes'} mode Mode.
             * @returns {Promise<void>}
             */
            async setMode(mode) {
                if (!tv || !MODES.includes(mode) || state.destroyed) return;
                state.mode = mode;
                if (mode === 'series') {
                    state.reason = null;
                    sync();
                    return;
                }
                sync();
                await loadSeasons();
                if (mode === 'episodes' && state.season !== null && state.mode === 'episodes' && !state.episodeFacts) await loadEpisodes(state.season);
            },
            /**
             * The person chooses a season.
             * @param {number} season Season (0 = specials).
             * @returns {Promise<void>}
             */
            async setSeason(season) {
                if (!tv || !Number.isInteger(season) || state.destroyed) return;
                state.season = season;
                state.checked.clear();
                sync();
                if (state.mode === 'episodes') await loadEpisodes(season);
            },
            /**
             * Ticks or unticks an episode.
             * @param {number} e Episode.
             * @param {boolean} on Ticked.
             * @returns {boolean} Done (false: the 101st pick, or not an episode of the season).
             */
            toggleEpisode(e, on) {
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
                if (!ok && known) say(tr('arr_lists_gran_limit', { count: max }));
                else if (state.checked.size < max) say(state.seasonFacts?.state === 'partial' ? tr('arr_lists_gran_partial') : '');
                return ok;
            },
            /** Stops loads and takes the picker away. */
            destroy() {
                state.destroyed = true;
                controller?.abort();
                root.removeEventListener('change', onChange);
                lp.gate.erase(() => root.querySelectorAll(`.${uid}`).forEach(n => n.remove()));
            }
        };

        // The caller's exact scope: preselected once its facts are known; never widened when they aren't.
        if (tv && initial && (initial.kind === 'season' || initial.kind === 'episodes') && Number.isInteger(initial.seasonNumber)) {
            state.reason = 'scope_lost';
            picker.ready = (async () => {
                const facts = await loadSeasons();
                if (facts.state === 'unavailable' || !facts.seasons.some(s => s.seasonNumber === initial.seasonNumber) || state.destroyed) {
                    say(tr('arr_lists_gran_scope_lost'));
                    return;
                }
                state.mode = initial.kind;
                state.season = initial.seasonNumber;
                if (initial.kind === 'episodes') {
                    await loadEpisodes(initial.seasonNumber);
                    const wanted = (initial.episodes || []).filter(e => state.episodeFacts?.episodes?.some(ep => ep.e === e));
                    if (!wanted.length || wanted.length !== (initial.episodes || []).length) {
                        say(tr('arr_lists_gran_scope_lost'));
                        return;
                    }
                    for (const e of wanted.slice(0, max)) state.checked.add(e);
                    drawEpisodes();
                }
                state.reason = null;
                sync();
            })();
        }
        return picker;
    }

    lp.granularity = Object.freeze({ KEYS, create });
})(window.JellyfinEnhanced);
