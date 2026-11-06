/**
 * @file Media Tags admin tab, Overview tab: what new users start with, the
 * server tag cache (with Rebuild), native poster tags and tag colours at a
 * glance, and quick links. Read-only apart from Rebuild; also provides the
 * shared cache helpers (A.cacheSummary, A.rebuildCache) the Server tab uses.
 */
(function(JE) {
    'use strict';

    const A = JE.adminTags;
    if (!A) return;

    /** The groups and the switch that turns each on for new users. */
    const GROUPS = [
        ['quality', 'QualityTagsEnabled', 'Quality'],
        ['genre', 'GenreTagsEnabled', 'Genre'],
        ['language', 'LanguageTagsEnabled', 'Language'],
        ['rating', 'RatingTagsEnabled', 'Rating'],
        ['ageRating', 'AgeRatingTagsEnabled', 'Age Rating'],
        ['status', 'StatusTagsEnabled', 'Status'],
        ['awards', 'AwardsTagsEnabled', 'Awards'],
        ['logos', 'LogoTagsEnabled', 'Logos'],
        ['custom', 'CustomTagsEnabled', 'Custom'],
        ['people', 'PeopleTagsEnabled', 'People'],
    ];
    A.GROUP_SWITCHES = GROUPS;

    /**
     * Each page view's cache summary: a new view (after a sign-in, or on another
     * server) shows "…" until its own answer, never an earlier view's counts.
     * seq numbers the requests: only the newest answer counts, and a page torn
     * down (dispose bumps it) ignores answers still on their way.
     * @type {WeakMap<Object, {summary: {enabled: boolean, entries: number, lastModified: number, rebuilding: boolean}|null, error: boolean, seq: number, timer: ReturnType<typeof setTimeout>|null}>}
     */
    const summaries = new WeakMap();

    /** @param {Object} ctx @returns {{summary: Object|null, error: boolean, seq: number, timer: ReturnType<typeof setTimeout>|null}} */
    const summaryOf = (ctx) => {
        let state = summaries.get(ctx);
        if (!state) summaries.set(ctx, state = { summary: null, error: false, seq: 0, timer: null, wasRebuilding: false });
        return state;
    };

    /**
     * Read the server tag cache state (GET tag-cache/summary).
     * @param {Object} ctx
     * @returns {Promise<void>}
     */
    A.cacheSummary = async function(ctx) {
        const state = summaryOf(ctx);
        const seq = ++state.seq;
        clearTimeout(state.timer);
        state.timer = null;
        let next = state.summary;
        let failed = false;
        try {
            next = await ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('/JellyfinEnhanced/tag-cache/summary'), dataType: 'json' });
        } catch (err) {
            failed = true;
            if (seq === state.seq && ctx.isCurrent()) console.warn('🪼 Jellyfin Enhanced: could not read the tag cache summary', err);
        }
        if (seq !== state.seq || !ctx.isCurrent()) return;
        const finished = state.wasRebuilding && next?.rebuilding === false && !failed;
        state.wasRebuilding = next?.rebuilding === true;
        state.summary = next;
        state.error = failed;
        // Only the cache card shows the summary: a poll redraws nothing else (the
        // other tabs' editors keep their controls and keyboard focus).
        drawCache(ctx);
        // Follow a rebuild until it finishes, then say so.
        if (state.summary?.rebuilding) state.timer = setTimeout(() => A.cacheSummary(ctx), 3000);
        if (finished) ctx.snack(A.fmt('Tag cache rebuilt: {count} {count|item|items} cached.', { count: state.summary.entries }));
    };

    /**
     * Rebuild the server tag cache, after a confirmation (POST tag-cache/rebuild).
     * Saves pending changes first, so turning the cache on and rebuilding works.
     * While a change is not saved (a failed save, or a conflict waiting for Keep
     * mine / Take theirs) it rebuilds nothing and says so, before and after asking.
     * @param {Object} ctx
     * @returns {Promise<void>}
     */
    A.rebuildCache = async function(ctx) {
        const unsaved = () => { if (ctx.isCurrent()) ctx.snack(A.fmt('Not rebuilt: changes on this page are not saved yet. Retry the save, or choose Keep mine or Take theirs, then rebuild again.')); };
        if (!(await ctx.flush())) { unsaved(); return; }
        if (!ctx.isCurrent()) return;
        const ok = await ctx.confirm(A.fmt('This re-scans the whole library in the background and may take a few minutes. Tags keep serving from the existing cache until the rebuild is done.'), A.fmt('Rebuild the server tag cache?'));
        if (!ok) return;
        if (!(await ctx.flush())) { unsaved(); return; }
        if (!ctx.isCurrent()) return;
        try {
            const res = await ApiClient.ajax({ type: 'POST', url: ApiClient.getUrl('/JellyfinEnhanced/tag-cache/rebuild'), dataType: 'json' });
            if (!ctx.isCurrent()) return;
            ctx.snack((res && res.message) || A.fmt('Rebuilding the tag cache in the background.'));
        } catch (err) {
            if (!ctx.isCurrent()) return;
            const status = err && err.status;
            ctx.snack(A.fmt(status === 409 ? 'A tag cache rebuild is already in progress.' : status === 400 ? 'Turn on the server tag cache first.' : 'The rebuild could not start. Check the server log.'));
            if (status !== 409 && status !== 400) console.error('🪼 Jellyfin Enhanced: tag cache rebuild failed to start', err);
        }
        A.cacheSummary(ctx);
    };

    /**
     * "4 minutes ago" for a Unix ms time.
     * @param {number} ms
     * @returns {string}
     */
    function ago(ms) {
        if (!ms) return A.fmt('Never');
        const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
        try {
            // In Jellyfin Enhanced's interface language, as every other date and count it shows.
            const rtf = new Intl.RelativeTimeFormat(uiLocale(), { numeric: 'auto' });
            if (seconds < 60) return rtf.format(-seconds, 'second');
            if (seconds < 3600) return rtf.format(-Math.round(seconds / 60), 'minute');
            if (seconds < 86400) return rtf.format(-Math.round(seconds / 3600), 'hour');
            return rtf.format(-Math.round(seconds / 86400), 'day');
        } catch {
            return new Date(ms).toLocaleString(uiLocale());
        }
    }

    /** @returns {string|undefined} The interface language (core/media-language.js), else the browser's. */
    const uiLocale = () => JE.core?.mediaLanguage?.uiLocale?.() || undefined;

    /**
     * The Overview's cache card: on/off/rebuilding, the summary and Rebuild.
     * @param {Object} ctx
     */
    function drawCache(ctx) {
        const grid = ctx.root.querySelector('.je-ta-ov[data-section="overview"]');
        if (!grid) return;
        const c = ctx.config;
        const t = (key, params) => A.fmt(key, params);
        const cacheOn = c.TagCacheServerMode !== false;
        const { summary, error: summaryError } = summaryOf(ctx);
        const state = /** @type {HTMLElement|null} */ (grid.querySelector('[data-ov="cache-state"]'));
        if (state) {
            state.dataset.state = cacheOn ? (summary?.rebuilding ? 'warn' : 'on') : 'off';
            state.textContent = t(cacheOn ? (summary?.rebuilding ? 'Rebuilding' : 'On') : 'Off');
        }
        const excluded = c.TagCacheExcludeLibraries === true ? String(c.TagCacheExcludedLibraryIds || '').split(',').filter(Boolean).length : 0;
        const body = grid.querySelector('[data-ov="cache"]');
        if (body) body.innerHTML = !cacheOn ? `<p class="je-ta-hint">${ctx.tx('Off: browsers fetch tag data page by page and keep their own copy.')}</p>`
            : summaryError ? `<p class="je-ta-hint">${ctx.tx('The cache state could not be read. Check the server log.')}</p>`
            : `<div class="je-ta-stat"><strong>${ctx.esc(summary ? Number(summary.entries).toLocaleString(uiLocale()) : '…')}</strong><span>${ctx.tx('items cached')}</span></div>`
                + `<dl class="je-ta-ov-dl"><dt>${ctx.tx('Last change')}</dt><dd>${ctx.esc(summary ? ago(summary.lastModified) : '…')}</dd>`
                + `<dt>${ctx.tx('Excluded')}</dt><dd>${ctx.esc(excluded ? t('{n} {n|library|libraries}', { n: excluded }) : t('None'))}</dd></dl>`;
        const rebuild = /** @type {HTMLButtonElement|null} */ (grid.querySelector('[data-ov="rebuild"]'));
        if (rebuild) rebuild.disabled = !cacheOn || !!summary?.rebuilding;
    }

    A.registerSection({
        id: 'overview',
        tab: 'overview',
        order: 10,
        title: 'Tag group defaults',
        render(ctx, body) {
            const card = body.closest('.je-ta-card');
            // The Overview is a grid of cards, not one card.
            card.outerHTML = `<div class="je-ta-ov" data-section="overview">
                <section class="je-ta-card je-ta-ov-wide"><h3 class="je-ta-card-title"><span class="material-icons je-ta-card-icon" aria-hidden="true">label</span>${ctx.tx('Tag group defaults')} ${ctx.perUserMark()}</h3><p class="je-ta-hint">${ctx.tx('Open a group to change its settings.')}</p><div class="je-ta-ov-groups" data-ov="groups"></div></section>
                <section class="je-ta-card je-ta-ov-wide"><h3 class="je-ta-card-title"><span class="material-icons je-ta-card-icon" aria-hidden="true">view_quilt</span>${ctx.tx('Default look')} ${ctx.perUserMark()}</h3><dl class="je-ta-ov-dl" data-ov="look"></dl><div class="je-ta-actions"><a class="je-ta-link" href="#" data-je-goto="layout"><span class="je-ta-link-text">${ctx.tx('Change layout defaults')}</span><span class="material-icons" aria-hidden="true">arrow_forward</span></a></div></section>
                <section class="je-ta-card"><div class="je-ta-card-head"><h3 class="je-ta-card-title"><span class="material-icons je-ta-card-icon" aria-hidden="true">storage</span>${ctx.tx('Server tag cache')}</h3><span class="je-ta-state" data-ov="cache-state"></span></div><div data-ov="cache"></div><div class="je-ta-actions"><button type="button" class="je-ta-button" data-ov="rebuild"><span class="material-icons" aria-hidden="true">refresh</span>${ctx.tx('Rebuild cache')}</button></div></section>
                <section class="je-ta-card"><div class="je-ta-card-head"><h3 class="je-ta-card-title"><span class="material-icons je-ta-card-icon" aria-hidden="true">devices</span>${ctx.tx('Native poster tags')}</h3><span class="je-ta-state" data-ov="native-state"></span></div><p class="je-ta-hint">${ctx.tx('Draws tags into poster images for apps that can\'t show the web overlays, such as Android TV.')}</p><div class="je-ta-actions"><a class="je-ta-link" href="#" data-je-goto="server"><span class="je-ta-link-text">${ctx.tx('Server settings')}</span><span class="material-icons" aria-hidden="true">arrow_forward</span></a></div></section>
                <section class="je-ta-card"><div class="je-ta-card-head"><h3 class="je-ta-card-title"><span class="material-icons je-ta-card-icon" aria-hidden="true">palette</span>${ctx.tx('Tag colours')}</h3><span class="je-ta-state" data-ov="colours-state"></span></div><dl class="je-ta-ov-dl" data-ov="colours"></dl><div class="je-ta-actions"><a class="je-ta-link" href="#" data-je-goto="colours"><span class="je-ta-link-text">${ctx.tx('Edit colours')}</span><span class="material-icons" aria-hidden="true">arrow_forward</span></a></div></section>
                <section class="je-ta-card" data-je-anchor="apply"><div class="je-ta-card-head"><h3 class="je-ta-card-title"><span class="material-icons je-ta-card-icon" aria-hidden="true">group</span>${ctx.tx('Apply defaults to all users')}</h3></div><p class="je-ta-hint">${ctx.tx('Copies the saved Jellyfin Enhanced defaults into every user\'s settings, replacing what they chose themselves.')}</p><div class="je-ta-actions"><button type="button" class="je-ta-button je-ta-button--danger" id="jeTaApplyAll"><span class="material-icons" aria-hidden="true">group</span>${ctx.tx('Apply defaults to all users')}</button></div></section>
            </div>`;
            const grid = /** @type {HTMLElement} */ (ctx.root.querySelector('.je-ta-ov[data-section="overview"]'));
            grid.querySelector('[data-ov="rebuild"]')?.addEventListener('click', () => A.rebuildCache(ctx));
            grid.querySelector('#jeTaApplyAll')?.addEventListener('click', async () => {
                const ok = await ctx.confirm(A.fmt('Every user\'s Jellyfin Enhanced settings (all of them, not only Media Tags) are replaced with the saved defaults. This cannot be undone; users would have to set their own preferences again.'), A.fmt('Apply defaults to all users'));
                if (!ok) return;
                const saved = await ctx.flush();
                if (!ctx.isCurrent()) return;
                if (!saved) { ctx.snack(A.fmt('The defaults could not be applied. Check the server log.')); return; }
                try {
                    await ApiClient.ajax({ type: 'POST', url: ApiClient.getUrl('/JellyfinEnhanced/reset-all-users-settings'), dataType: 'json' });
                    if (!ctx.isCurrent()) return;
                    ctx.snack(A.fmt('The defaults now apply to every user. They take effect after users reload.'));
                } catch (err) {
                    if (!ctx.isCurrent()) return;
                    console.error('🪼 Jellyfin Enhanced: applying the defaults to all users failed', err);
                    ctx.snack(A.fmt('The defaults could not be applied. Check the server log.'));
                }
            });
            grid.querySelector('[data-ov="groups"]')?.addEventListener('click', (e) => {
                const button = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-group]'));
                if (button) ctx.openTab('groups', { group: button.dataset.group, focus: true });
            });
        },
        show(ctx) {
            A.cacheSummary(ctx);
        },
        refresh(ctx) {
            const grid = ctx.root.querySelector('.je-ta-ov[data-section="overview"]');
            if (!grid) return;
            const c = ctx.config;
            const t = (key, params) => A.fmt(key, params);
            const set = (name, html) => { const el = grid.querySelector(`[data-ov="${name}"]`); if (el) el.innerHTML = html; };
            const state = (name, on, text) => {
                const el = /** @type {HTMLElement|null} */ (grid.querySelector(`[data-ov="${name}"]`));
                if (el) { el.dataset.state = on; el.textContent = text; }
            };
            const groups = grid.querySelector('[data-ov="groups"]');
            // Redrawn by other views' saves and the library list answer too: keep focus on the same group.
            if (groups) A.redrawList(groups, GROUPS.map(([id, key, name]) => `<button type="button" class="je-ta-ov-group" data-group="${id}" data-on="${c[key] === true}" aria-label="${ctx.esc(t('{name}: {state}. Open its settings', { name: t(name), state: t(c[key] === true ? 'On' : 'Off') }))}">${ctx.esc(t(name))}<span class="je-ta-ov-state" aria-hidden="true">· ${ctx.esc(t(c[key] === true ? 'On' : 'Off'))}</span><span class="material-icons" aria-hidden="true">chevron_right</span></button>`).join(''),
                (el) => (el.dataset.group ? `[data-group="${el.dataset.group}"]` : null));
            const L = ctx.layout;
            const conf = L ? L.normalizeSettings(A.seedUser(c), c) : null;
            const order = conf?.order || L?.DEFAULT_ORDER || [];
            const groupName = (g) => t(A.WORDS.group[`${g === 'ageRating' ? 'age_rating' : g}`]);
            const rules = Array.isArray(c.TagLookRules) ? c.TagLookRules.length : 0;
            set('look', [
                [t('Layout'), t(A.WORDS.layout[conf?.layout || 'corners'])],
                [t('Labels'), t(A.WORDS.density[conf?.density || 'full'])],
                [t('Group order'), order.map(groupName).join(', ')],
                [t('Rules'), rules ? t('{n} {n|rule|rules}', { n: rules }) : t('None')],
            ].map(([k, v]) => `<dt>${ctx.esc(k)}</dt><dd>${ctx.esc(v)}</dd>`).join(''));
            drawCache(ctx);
            state('native-state', c.NativePosterTagsEnabled === true ? 'on' : 'off', t(c.NativePosterTagsEnabled === true ? 'On' : 'Off'));
            const styles = c.TagStylesEnabled === true;
            state('colours-state', styles ? 'on' : 'off', t(styles ? 'On' : 'Off'));
            const target = ['web', 'native', 'both'].includes(c.TagStyleTarget) ? c.TagStyleTarget : 'both';
            set('colours', [
                [t('Preset'), t(A.WORDS.preset[c.TagStylePreset || 'default'])],
                [t('Applies to'), t(A.WORDS.styleTarget[target])],
                [t('Users pick a preset'), t(c.TagStylesAllowUserPreset === true ? 'Allowed' : 'Not allowed')],
            ].map(([k, v]) => `<dt>${ctx.esc(k)}</dt><dd>${ctx.esc(v)}</dd>`).join(''));
        },
        dispose(ctx) {
            const state = summaryOf(ctx);
            state.seq++;
            clearTimeout(state.timer);
            state.timer = null;
        },
    });
})(window.JellyfinEnhanced);
