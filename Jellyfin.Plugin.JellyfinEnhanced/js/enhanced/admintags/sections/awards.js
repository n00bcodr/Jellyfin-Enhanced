(function(JE) {
    'use strict';
    const A = JE.adminTags;
    if (!A) return;
    A.registerSection({
        id: 'group-awards',
        tab: 'groups',
        order: 65,
        title: 'Awards', hint: 'Ribbons from ratings and award sources. MDBList credentials stay on the main settings page. Failed lookups retry after an hour.',
        group: {
            id: 'awards',
            // The current choice, short (the description stays inside the group).
            summary: (ctx) => A.fmt('{n} of {total} sources · refreshed every {hours} h', { n: ['AwardsTagsImdb', 'AwardsTagsCertifiedFresh', 'AwardsTagsOscar', 'AwardsTagsEmmy', 'AwardsTagsLetterboxd'].filter((k) => ctx.config[k] === true).length, total: 5, hours: Number(ctx.config.AwardsTagsRefreshHours) || 24 }), sample: () => [['status', A.fmt('Awards')]] },
        // "Where to show" (drawn for every group row by admin-tags.js).
        writes: ['TagGroupScopes'],
        fields: [
            { id: 'awardsTagsEnabled', key: 'AwardsTagsEnabled', type: 'enable', label: 'Awards ribbons for new users' },
            { id: 'awardsTagsImdb', key: 'AwardsTagsImdb', type: 'switch', label: 'IMDb Top 250' },
            { id: 'awardsTagsCertifiedFresh', key: 'AwardsTagsCertifiedFresh', type: 'switch', label: 'Certified Fresh' },
            { id: 'awardsTagsOscar', key: 'AwardsTagsOscar', type: 'switch', label: 'Oscar winners' },
            { id: 'awardsTagsEmmy', key: 'AwardsTagsEmmy', type: 'switch', label: 'Emmy winners' },
            { id: 'awardsTagsLetterboxd', key: 'AwardsTagsLetterboxd', type: 'switch', label: 'Letterboxd Top 250' },
            { id: 'awardsTagsImdbList', key: 'AwardsTagsImdbList', type: 'text', pattern: '(?:[1-9][0-9]{0,17}|[a-zA-Z0-9_\\-]{1,80}/[a-zA-Z0-9_\\-]{1,160})', label: 'IMDb list (numeric id or owner/slug)' },
            { id: 'awardsTagsLetterboxdList', key: 'AwardsTagsLetterboxdList', type: 'text', pattern: '(?:[1-9][0-9]{0,17}|[a-zA-Z0-9_\\-]{1,80}/[a-zA-Z0-9_\\-]{1,160})', label: 'Letterboxd list (numeric id or owner/slug)' },
            { id: 'awardsTagsRefreshHours', key: 'AwardsTagsRefreshHours', type: 'number', label: 'Refresh cadence (hours)', min: 1, max: 168, fallback: 24 },
        ],
        // What the group depends on, and whether it has been fetched yet (nothing shows until the first refresh has run).
        render(ctx, body) {
            body.innerHTML = `<h4 class="je-ta-sub">${ctx.tx('What it needs')}</h4>
                <div class="je-ta-card" style="margin:0" data-awards-needs>
                    <div class="je-ta-card-head"><span class="je-ta-state" data-awards-key></span></div>
                    <p class="je-ta-hint">${ctx.tx('IMDb Top 250, Letterboxd Top 250 and Certified Fresh come from MDBList and need its API key. Oscar and Emmy wins come from Wikidata and need no key.')}</p>
                    <p class="je-ta-hint" data-awards-run></p>
                    <a class="je-ta-link" href="${ctx.esc(ctx.mainPageUrl('mdblistRatingsEnabled'))}"><span class="je-ta-link-text">${ctx.tx('MDBList settings')}</span><span class="material-icons" aria-hidden="true">open_in_new</span></a>
                </div>`;
        },
        refresh(ctx, body) {
            const box = body?.querySelector('[data-awards-needs]');
            if (!box) return;
            const key = String(ctx.config.MdblistApiKey || '').trim() !== '';
            const state = /** @type {HTMLElement} */ (box.querySelector('[data-awards-key]'));
            state.dataset.state = key ? 'on' : 'warn';
            state.textContent = A.fmt(key ? 'MDBList key set' : 'No MDBList key: the charts and Certified Fresh stay empty');
            // The nightly task fetches everything; ask the server when it last ran (once per view).
            const run = /** @type {HTMLElement} */ (box.querySelector('[data-awards-run]'));
            if (box.dataset.runLoaded) return;
            box.dataset.runLoaded = '1';
            const base = A.fmt('The Refresh Awards Tags task (Dashboard › Scheduled Tasks) fetches the facts, nightly at 04:00 and once when Awards is first turned on. Nothing shows until it has run.');
            run.textContent = base;
            ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('ScheduledTasks'), dataType: 'json' }).then((tasks) => {
                if (!ctx.isCurrent() || !Array.isArray(tasks)) return;
                const task = tasks.find((t) => t.Key === 'JellyfinEnhancedRefreshAwardTags');
                if (!task) return;
                const last = task.LastExecutionResult?.EndTimeUtc ? Date.parse(task.LastExecutionResult.EndTimeUtc) : 0;
                let when = A.fmt('never');
                if (last) {
                    const minutes = Math.max(0, Math.round((Date.now() - last) / 60000));
                    try { when = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(minutes < 120 ? -minutes : -Math.round(minutes / 60), minutes < 120 ? 'minute' : 'hour'); } catch { when = new Date(last).toLocaleString(); }
                }
                run.textContent = `${base} ${A.fmt(task.State === 'Running' ? 'It is running now.' : 'Last run: {when}.', { when })}`;
            }).catch(() => { /* the task list is a courtesy: keep the plain text */ });
        },
    });
})(window.JellyfinEnhanced);
