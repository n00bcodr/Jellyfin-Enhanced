/**
 * @file Media Tags admin page, Groups › Rating: where rating tags show, which
 * scores they include and in what order, the minimum score, colour by score,
 * the rating in the video player, and the state of MDBList (its own settings
 * stay with the MDBList Ratings feature on the main configuration page).
 */
(function(JE) {
    'use strict';

    const A = JE.adminTags;
    if (!A) return;

    /** Every poster rating source, in the built-in order. */
    const SOURCES = ['community', 'critic', 'imdb', 'tmdb', 'rtCritic', 'rtAudience', 'metacritic', 'letterboxd', 'trakt'];

    /**
     * The chosen sources: the explicit list, else the two legacy switches.
     * @param {Object} c
     * @returns {string[]}
     */
    function selectedSources(c) {
        return Array.isArray(c.RatingTagsSources) ? c.RatingTagsSources.filter((id, i, all) => SOURCES.includes(id) && all.indexOf(id) === i)
            : ['community', 'critic'].filter((id) => c[id === 'community' ? 'RatingTagsShowCommunity' : 'RatingTagsShowCritic'] !== false);
    }

    /**
     * The source rows: chosen ones first (in their order), then the rest.
     * @param {Object} ctx
     * @param {string[]} order - Row order.
     * @param {string[]} selected
     * @returns {string}
     */
    function rowsHtml(ctx, order, selected) {
        return order.map((id, i) => {
            const name = JE.t(`rating_source_${id}`);
            return `<li data-source="${id}"><span class="je-ta-rank" aria-hidden="true">${i + 1}</span>`
                + `<label><input type="checkbox" ${selected.includes(id) ? 'checked' : ''}><span class="je-ta-order-name">${ctx.esc(name)}</span></label>`
                + `<button type="button" class="je-ta-icon-btn" data-step="-1" aria-label="${ctx.esc(JE.t('rating_sources_up', { source: name }))}" ${i === 0 ? 'disabled' : ''}><span class="material-icons" aria-hidden="true">arrow_upward</span></button>`
                + `<button type="button" class="je-ta-icon-btn" data-step="1" aria-label="${ctx.esc(JE.t('rating_sources_down', { source: name }))}" ${i === order.length - 1 ? 'disabled' : ''}><span class="material-icons" aria-hidden="true">arrow_downward</span></button></li>`;
        }).join('');
    }

    /**
     * Collect the checked sources in row order (an empty list is a choice too).
     * @param {HTMLElement} list
     * @returns {string[]}
     */
    function collect(list) {
        return Array.from(list.querySelectorAll('[data-source]')).filter((row) => /** @type {HTMLInputElement} */ (row.querySelector('input')).checked).map((row) => /** @type {HTMLElement} */ (row).dataset.source || '');
    }

    A.registerSection({
        id: 'group-rating',
        tab: 'groups',
        order: 40,
        title: 'panel_settings_ui_tag_group_rating',
        hint: 'admin_tags_rating_desc',
        group: {
            id: 'rating',
            summary(ctx) {
                const c = ctx.config;
                const sources = selectedSources(c).map((id) => JE.t(`rating_source_${id}`));
                const types = ['Movies', 'Series', 'Seasons', 'Episodes'].filter((t) => c[`RatingTagsOn${t}`] !== false).length;
                return [sources.length ? sources.join(', ') : JE.t('admin_tags_none'), types === 4 ? JE.t('admin_tags_rating_every_type') : JE.t('admin_tags_rating_types', { n: types })].join(' · ');
            },
            sample: () => [['rating', '★ 8.1'], ['rating', '92%']],
        },
        fields: [
            { id: 'ratingTagsEnabled', key: 'RatingTagsEnabled', type: 'enable', label: 'admin_tags_rating_enabled' },
            { id: 'ratingTagsOnMovies', key: 'RatingTagsOnMovies', type: 'switch', label: 'admin_tags_rating_on_movies' },
            { id: 'ratingTagsOnSeries', key: 'RatingTagsOnSeries', type: 'switch', label: 'admin_tags_rating_on_series' },
            { id: 'ratingTagsOnSeasons', key: 'RatingTagsOnSeasons', type: 'switch', label: 'admin_tags_rating_on_seasons' },
            { id: 'ratingTagsOnEpisodes', key: 'RatingTagsOnEpisodes', type: 'switch', label: 'admin_tags_rating_on_episodes', desc: 'admin_tags_rating_on_episodes_desc' },
            { id: 'ratingTagsOnContinueWatching', key: 'RatingTagsOnContinueWatching', type: 'switch', label: 'admin_tags_rating_on_continue' },
            { id: 'ratingTagsOnNextUp', key: 'RatingTagsOnNextUp', type: 'switch', label: 'admin_tags_rating_on_next_up' },
            { id: 'ratingTagsSources', key: 'RatingTagsSources', type: 'custom', label: 'rating_sources_label' },
            { id: 'ratingTagsMinScore', key: 'RatingTagsMinScore', type: 'select', label: 'rating_sources_minimum', desc: 'admin_tags_rating_min_desc', options: [['0', 'rating_sources_off'], ['5', '=5'], ['6', '=6'], ['7', '=7'], ['8', '=8']], read: (v) => String(Number(v) || 0), write: (v) => Number(v) },
            { id: 'ratingTagsColorByScore', key: 'RatingTagsColorByScore', type: 'switch', label: 'rating_sources_color', break: true },
            { id: 'showRatingInPlayer', key: 'ShowRatingInPlayer', type: 'switch', label: 'admin_tags_rating_in_player', desc: 'admin_tags_rating_in_player_desc' },
        ],
        render(ctx, body) {
            body.innerHTML = `<h4 class="je-ta-sub" id="ratingTagsSourcesLabel">${ctx.tx('rating_sources_label')}</h4>
                <p class="je-ta-hint">${ctx.tx('rating_sources_help')}</p>
                <ol class="je-ta-order" id="ratingTagsSourceRows" aria-labelledby="ratingTagsSourcesLabel"></ol>
                <h4 class="je-ta-sub">${ctx.tx('admin_tags_mdblist')}</h4>
                <div class="je-ta-card" style="margin:0" data-mdblist></div>`;
            const list = /** @type {HTMLElement} */ (body.querySelector('#ratingTagsSourceRows'));
            list.addEventListener('change', () => ctx.set('RatingTagsSources', collect(list)));
            list.addEventListener('click', (e) => {
                const button = /** @type {HTMLButtonElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-step]'));
                if (!button || button.disabled) return;
                const row = /** @type {HTMLElement} */ (button.closest('[data-source]'));
                const next = Number(button.dataset.step) < 0 ? row.previousElementSibling : row.nextElementSibling;
                if (!next) return;
                if (Number(button.dataset.step) < 0) next.before(row); else next.after(row);
                const id = row.dataset.source;
                ctx.set('RatingTagsSources', collect(list));
                const again = /** @type {HTMLButtonElement|null} */ (list.querySelector(`[data-source="${id}"] [data-step="${button.dataset.step}"]`));
                (again && !again.disabled ? again : list.querySelector(`[data-source="${id}"] input`))?.focus();
            });
            this.load(ctx, body);
        },
        /** Rebuild the source rows from the configuration (first draw and page shown again). */
        load(ctx, body) {
            const list = body?.querySelector('#ratingTagsSourceRows');
            if (!list) return;
            const selected = selectedSources(ctx.config);
            list.innerHTML = rowsHtml(ctx, [...new Set(selected.concat(SOURCES))], selected);
        },
        refresh(ctx, body) {
            const list = body?.querySelector('#ratingTagsSourceRows');
            if (list) {
                // Keep the rows (and their order) while editing; only renumber and fix the ends.
                Array.from(list.children).forEach((row, i) => {
                    const rank = row.querySelector('.je-ta-rank');
                    if (rank) rank.textContent = String(i + 1);
                    row.querySelector('[data-step="-1"]')?.toggleAttribute('disabled', i === 0);
                    row.querySelector('[data-step="1"]')?.toggleAttribute('disabled', i === list.children.length - 1);
                });
            }
            const box = body?.querySelector('[data-mdblist]');
            if (!box) return;
            const c = ctx.config;
            const key = String(c.MdblistApiKey || '').trim() !== '';
            const on = c.MdblistRatingsEnabled === true;
            box.innerHTML = `<div class="je-ta-card-head"><span class="je-ta-state" data-state="${on && key ? 'on' : on ? 'warn' : 'off'}">${ctx.tx(on ? (key ? 'admin_tags_mdblist_on' : 'admin_tags_mdblist_no_key') : 'admin_tags_mdblist_off')}</span></div>`
                + `<p class="je-ta-hint">${ctx.tx('admin_tags_mdblist_desc')}${on && key ? ` ${ctx.tx(c.MdblistRatingsFetchEnabled === true ? 'admin_tags_mdblist_fetch_on' : 'admin_tags_mdblist_fetch_off')}` : ''}</p>`
                + `<a class="je-ta-link" href="${ctx.esc(ctx.mainPageUrl('mdblistRatingsEnabled'))}">${ctx.tx('admin_tags_mdblist_open')}<span class="material-icons" aria-hidden="true">open_in_new</span></a>`;
        },
    });

    // Exposed for tests.
    A.ratingData = { SOURCES, selectedSources };
})(window.JellyfinEnhanced);
