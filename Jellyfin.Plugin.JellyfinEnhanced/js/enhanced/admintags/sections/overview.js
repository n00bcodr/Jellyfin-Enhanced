/**
 * @file Media Tags admin page, Overview tab: what new users start with, the
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
        ['quality', 'QualityTagsEnabled', 'panel_settings_ui_tag_group_quality'],
        ['genre', 'GenreTagsEnabled', 'common_genre'],
        ['language', 'LanguageTagsEnabled', 'panel_settings_ui_tag_group_language'],
        ['rating', 'RatingTagsEnabled', 'panel_settings_ui_tag_group_rating'],
        ['ageRating', 'AgeRatingTagsEnabled', 'panel_settings_ui_tag_group_age_rating'],
        ['status', 'StatusTagsEnabled', 'panel_settings_ui_tag_group_status'],
        ['awards', 'AwardsTagsEnabled', 'awards_label'],
        ['logos', 'LogoTagsEnabled', 'common_logos'],
        ['custom', 'CustomTagsEnabled', 'common_custom'],
        ['people', 'PeopleTagsEnabled', 'admin_tags_group_people'],
    ];
    A.GROUP_SWITCHES = GROUPS;

    /** @type {{enabled: boolean, entries: number, lastModified: number, rebuilding: boolean}|null} */
    let summary = null;
    let summaryError = false;
    let pollTimer = null;
    // Each request's number: only the newest answer counts, and a page torn
    // down (dispose bumps it) ignores answers still on their way.
    let summarySeq = 0;

    /**
     * Read the server tag cache state (GET tag-cache/summary).
     * @param {Object} ctx
     * @returns {Promise<void>}
     */
    A.cacheSummary = async function(ctx) {
        const seq = ++summarySeq;
        clearTimeout(pollTimer);
        pollTimer = null;
        let next = summary;
        let failed = false;
        try {
            next = await ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('/JellyfinEnhanced/tag-cache/summary'), dataType: 'json' });
        } catch (err) {
            failed = true;
            if (seq === summarySeq && ctx.isCurrent()) console.warn('🪼 Jellyfin Enhanced: could not read the tag cache summary', err);
        }
        if (seq !== summarySeq || !ctx.isCurrent()) return;
        summary = next;
        summaryError = failed;
        // Only the cache card shows the summary: a poll redraws nothing else (the
        // other tabs' editors keep their controls and keyboard focus).
        drawCache(ctx);
        // Follow a rebuild until it finishes.
        if (summary?.rebuilding) pollTimer = setTimeout(() => A.cacheSummary(ctx), 3000);
    };

    /**
     * Rebuild the server tag cache, after a confirmation (POST tag-cache/rebuild).
     * Saves pending changes first, so turning the cache on and rebuilding works.
     * @param {Object} ctx
     * @returns {Promise<void>}
     */
    A.rebuildCache = async function(ctx) {
        const ok = await ctx.confirm(JE.t('admin_tags_rebuild_confirm'), JE.t('admin_tags_rebuild_title'));
        if (!ok) return;
        if (!(await ctx.flush()) || !ctx.isCurrent()) return;
        try {
            const res = await ApiClient.ajax({ type: 'POST', url: ApiClient.getUrl('/JellyfinEnhanced/tag-cache/rebuild'), dataType: 'json' });
            if (!ctx.isCurrent()) return;
            ctx.snack((res && res.message) || JE.t('admin_tags_rebuild_started'));
        } catch (err) {
            if (!ctx.isCurrent()) return;
            const status = err && err.status;
            ctx.snack(JE.t(status === 409 ? 'admin_tags_rebuild_running' : status === 400 ? 'admin_tags_rebuild_cache_off' : 'admin_tags_rebuild_failed'));
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
        if (!ms) return JE.t('admin_tags_never');
        const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
        try {
            const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
            if (seconds < 60) return rtf.format(-seconds, 'second');
            if (seconds < 3600) return rtf.format(-Math.round(seconds / 60), 'minute');
            if (seconds < 86400) return rtf.format(-Math.round(seconds / 3600), 'hour');
            return rtf.format(-Math.round(seconds / 86400), 'day');
        } catch {
            return new Date(ms).toLocaleString();
        }
    }

    /**
     * The Overview's cache card: on/off/rebuilding, the summary and Rebuild.
     * @param {Object} ctx
     */
    function drawCache(ctx) {
        const grid = ctx.root.querySelector('.je-ta-ov[data-section="overview"]');
        if (!grid) return;
        const c = ctx.config;
        const t = (key, params) => JE.t(key, params);
        const cacheOn = c.TagCacheServerMode !== false;
        const state = /** @type {HTMLElement|null} */ (grid.querySelector('[data-ov="cache-state"]'));
        if (state) {
            state.dataset.state = cacheOn ? (summary?.rebuilding ? 'warn' : 'on') : 'off';
            state.textContent = t(cacheOn ? (summary?.rebuilding ? 'admin_tags_rebuilding' : 'common_on') : 'track_off');
        }
        const excluded = c.TagCacheExcludeLibraries === true ? String(c.TagCacheExcludedLibraryIds || '').split(',').filter(Boolean).length : 0;
        const body = grid.querySelector('[data-ov="cache"]');
        if (body) body.innerHTML = !cacheOn ? `<p class="je-ta-hint">${ctx.tx('admin_tags_overview_cache_off')}</p>`
            : summaryError ? `<p class="je-ta-hint">${ctx.tx('admin_tags_overview_cache_unknown')}</p>`
            : `<div class="je-ta-stat"><strong>${ctx.esc(summary ? Number(summary.entries).toLocaleString() : '…')}</strong><span>${ctx.tx('admin_tags_overview_cached')}</span></div>`
                + `<dl class="je-ta-ov-dl"><dt>${ctx.tx('admin_tags_overview_last_change')}</dt><dd>${ctx.esc(summary ? ago(summary.lastModified) : '…')}</dd>`
                + `<dt>${ctx.tx('admin_tags_overview_excluded')}</dt><dd>${ctx.esc(excluded ? t('admin_tags_overview_excluded_n', { n: excluded }) : t('admin_tags_none'))}</dd></dl>`;
        const rebuild = /** @type {HTMLButtonElement|null} */ (grid.querySelector('[data-ov="rebuild"]'));
        if (rebuild) rebuild.disabled = !cacheOn || !!summary?.rebuilding;
    }

    A.registerSection({
        id: 'overview',
        tab: 'overview',
        order: 10,
        title: 'admin_tags_overview_groups',
        render(ctx, body) {
            const card = body.closest('.je-ta-card');
            // The Overview is a grid of cards, not one card.
            card.outerHTML = `<div class="je-ta-ov" data-section="overview">
                <section class="je-ta-card je-ta-ov-wide"><h3 class="je-ta-card-title">${ctx.tx('admin_tags_overview_groups')}</h3><p class="je-ta-hint">${ctx.tx('admin_tags_overview_groups_desc')}</p><div class="je-ta-ov-groups" data-ov="groups"></div></section>
                <section class="je-ta-card"><h3 class="je-ta-card-title">${ctx.tx('admin_tags_overview_look')}</h3><dl class="je-ta-ov-dl" data-ov="look"></dl><div class="je-ta-actions"><a class="je-ta-link" href="#" data-je-goto="layout">${ctx.tx('admin_tags_overview_change_layout')}<span class="material-icons" aria-hidden="true">arrow_forward</span></a></div></section>
                <section class="je-ta-card"><div class="je-ta-card-head"><h3 class="je-ta-card-title">${ctx.tx('admin_tags_overview_cache')}</h3><span class="je-ta-state" data-ov="cache-state"></span></div><div data-ov="cache"></div><div class="je-ta-actions"><button type="button" class="je-ta-button" data-ov="rebuild"><span class="material-icons" aria-hidden="true">refresh</span>${ctx.tx('admin_tags_rebuild')}</button></div></section>
                <section class="je-ta-card"><div class="je-ta-card-head"><h3 class="je-ta-card-title">${ctx.tx('panel_media_tags_server_native')}</h3><span class="je-ta-state" data-ov="native-state"></span></div><p class="je-ta-hint">${ctx.tx('admin_tags_overview_native_desc')}</p><div class="je-ta-actions"><a class="je-ta-link" href="#" data-je-goto="server">${ctx.tx('panel_media_tags_server_title')}<span class="material-icons" aria-hidden="true">arrow_forward</span></a></div></section>
                <section class="je-ta-card"><div class="je-ta-card-head"><h3 class="je-ta-card-title">${ctx.tx('admin_tags_overview_colours')}</h3><span class="je-ta-state" data-ov="colours-state"></span></div><dl class="je-ta-ov-dl" data-ov="colours"></dl><div class="je-ta-actions"><a class="je-ta-link" href="#" data-je-goto="colours">${ctx.tx('admin_tags_overview_edit_colours')}<span class="material-icons" aria-hidden="true">arrow_forward</span></a></div></section>
                <section class="je-ta-card je-ta-ov-wide"><h3 class="je-ta-card-title">${ctx.tx('admin_tags_overview_quick')}</h3><div class="je-ta-quick">
                    <button type="button" class="je-ta-button" data-je-goto="layout"><span class="material-icons" aria-hidden="true">view_quilt</span>${ctx.tx('admin_tags_quick_layout')}</button>
                    <button type="button" class="je-ta-button" data-je-goto="rules"><span class="material-icons" aria-hidden="true">rule</span>${ctx.tx('admin_tags_quick_rules')}</button>
                    <button type="button" class="je-ta-button" data-je-goto="badges"><span class="material-icons" aria-hidden="true">new_releases</span>${ctx.tx('panel_media_tags_tab_badges')}</button>
                    <button type="button" class="je-ta-button" data-je-goto="layout:apply"><span class="material-icons" aria-hidden="true">group</span>${ctx.tx('admin_tags_apply_all')}</button>
                </div></section>
            </div>`;
            const grid = /** @type {HTMLElement} */ (ctx.root.querySelector('.je-ta-ov[data-section="overview"]'));
            grid.querySelector('[data-ov="rebuild"]')?.addEventListener('click', () => A.rebuildCache(ctx));
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
            const t = (key, params) => JE.t(key, params);
            const set = (name, html) => { const el = grid.querySelector(`[data-ov="${name}"]`); if (el) el.innerHTML = html; };
            const state = (name, on, text) => {
                const el = /** @type {HTMLElement|null} */ (grid.querySelector(`[data-ov="${name}"]`));
                if (el) { el.dataset.state = on; el.textContent = text; }
            };
            set('groups', GROUPS.map(([id, key, name]) => `<button type="button" class="je-ta-ov-group" data-group="${id}" data-on="${c[key] === true}" aria-label="${ctx.esc(t('admin_tags_overview_group_aria', { name: t(name), state: t(c[key] === true ? 'common_on' : 'track_off') }))}">${ctx.esc(t(name))}</button>`).join(''));
            const L = ctx.layout;
            const conf = L ? L.normalizeSettings(A.seedUser(c), c) : null;
            const order = conf?.order || L?.DEFAULT_ORDER || [];
            const groupName = (g) => t(JE.core.tagLayout.VOCABULARY_KEYS.group[`${g === 'ageRating' ? 'age_rating' : g}`]);
            const rules = Array.isArray(c.TagLookRules) ? c.TagLookRules.length : 0;
            set('look', [
                [t('common_layout'), t(JE.core.tagLayout.VOCABULARY_KEYS.layout[conf?.layout || 'corners'])],
                [t('admin_tags_overview_labels'), t(`panel_settings_ui_tag_density_${conf?.density || 'full'}`)],
                [t('admin_tags_overview_order'), order.map(groupName).join(', ')],
                [t('common_rules'), rules ? t('admin_tags_overview_rules_n', { n: rules }) : t('admin_tags_none')],
            ].map(([k, v]) => `<dt>${ctx.esc(k)}</dt><dd>${ctx.esc(v)}</dd>`).join(''));
            drawCache(ctx);
            state('native-state', c.NativePosterTagsEnabled === true ? 'on' : 'off', t(c.NativePosterTagsEnabled === true ? 'common_on' : 'track_off'));
            const styles = c.TagStylesEnabled === true;
            state('colours-state', styles ? 'on' : 'off', t(styles ? 'common_on' : 'track_off'));
            const target = ['web', 'native', 'both'].includes(c.TagStyleTarget) ? c.TagStyleTarget : 'both';
            set('colours', [
                [t('admin_tags_overview_preset'), t(JE.core.tagLayout.VOCABULARY_KEYS.preset[c.TagStylePreset || 'default'])],
                [t('admin_tags_overview_applies'), t(`admin_tags_style_target_${target}`)],
                [t('admin_tags_overview_users_pick'), t(c.TagStylesAllowUserPreset === true ? 'admin_tags_allowed' : 'admin_tags_not_allowed')],
            ].map(([k, v]) => `<dt>${ctx.esc(k)}</dt><dd>${ctx.esc(v)}</dd>`).join(''));
        },
        dispose() {
            summarySeq++;
            clearTimeout(pollTimer);
            pollTimer = null;
        },
    });
})(window.JellyfinEnhanced);
