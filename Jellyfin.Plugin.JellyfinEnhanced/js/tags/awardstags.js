/** @file Cached Awards/chart chips shared by posters and the settings preview. */
(function(JE) {
    'use strict';
    const LOGOS = {"imdbTop250":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 16\"><path fill=\"#f5c518\" d=\"M1 2H23V14H1Z\"/><path fill=\"#151515\" d=\"M3 4H5V12H3ZM7 4H10L11 8L12 4H15V12H13V7L12 12H10L9 7V12H7ZM17 4H20L22 6V10L20 12H17ZM19 6V10H20V6Z\"/></svg>","certifiedFresh":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#ef4135\" d=\"M4 7C1 17 9 23 15 20C23 18 23 7 16 6C12 3 7 3 4 7Z\"/><path fill=\"#48a848\" d=\"M12 8L6 2L11 4L14 0L15 5L21 3L17 8Z\"/></svg>","oscar":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#d7ae52\" d=\"M10 1H14L15 5L13 8L15 17H18V20H20V23H4V20H6V17H9L11 8L9 5Z\"/></svg>","emmy":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#d7ae52\" d=\"M2 3L9 7L12 2L15 7L22 3L19 12L14 14L15 20H19V23H5V20H9L10 14L5 12ZM9 9L12 12L15 9L12 6Z\"/></svg>","letterboxdTop250":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#ff8000\" d=\"M0 12A5 5 0 1 0 10 12A5 5 0 1 0 0 12\"/><path fill=\"#00e054\" d=\"M7 12A5 5 0 1 0 17 12A5 5 0 1 0 7 12\"/><path fill=\"#40bcf4\" d=\"M14 12A5 5 0 1 0 24 12A5 5 0 1 0 14 12\"/></svg>"};
    const LABELS = { imdbTop250: 'Top 250', certifiedFresh: 'Certified Fresh', oscar: 'Oscar winner', emmy: 'Emmy winner', letterboxdTop250: 'Top 250' };
    const IDS = Object.keys(LABELS);
    const CSS = `
        .awards-overlay-container { display:flex; flex-direction:column; gap:4px; pointer-events:none; max-width:100%; }
        /* Only chip anchors intercept hover; empty poster space still reaches Jellyfin. */
        .je-tag-host:has(.awards-overlay-container) { z-index:2; }
        .awards-link { display:inline-flex; color:inherit; text-decoration:none; pointer-events:auto; }
        .je-tag-pill[href] { pointer-events:auto; text-decoration:none; }
        .awards-tag { display:inline-flex; align-items:center; gap:4px; padding:4px 8px; background:rgba(15,15,15,.85); color:#fff; border-radius:4px; font-size:13px; font-weight:700; line-height:1; white-space:nowrap; box-shadow:0 2px 4px rgba(0,0,0,.3); }
        .awards-tag-logo { display:inline-flex; width:14px; height:14px; flex:0 0 14px; }
        .awards-tag-logo svg { width:100%; height:100%; }
        @supports (container-type:inline-size) { html:not(.layout-mobile) .je-tag-host .awards-tag { font-size:clamp(9px,6.8cqw,13px); padding:clamp(2px,2cqw,4px) clamp(4px,4.5cqw,8px); } }
        .layout-mobile .awards-tag { font-size:11px; padding:2px 6px; }
        @media(max-width:480px) { .awards-tag { font-size:11px; padding:2px 4px; } }
    `;
    /** Read cache or batch facts, accepting either DTO key casing. */
    function read(facts, key) { return facts?.[key] ?? facts?.[key[0].toUpperCase() + key.slice(1)]; }
    /** Resolve only provider-confirmed facts; settings switches may remove individual ribbons. */
    function resolve(facts) {
        if (!facts || JE.pluginConfig?.AwardsTagsEnabled === false) return [];
        const out = [];
        const admin = JE.pluginConfig || {};
        const push = (id, flag, rank, year) => { if (flag && (rank === undefined || (Number.isInteger(rank) && rank > 0 && rank <= 250))) out.push({ id, rank, year }); };
        const imdb = read(facts, 'imdbRank'), letterboxd = read(facts, 'letterboxdRank');
        push('imdbTop250', admin.AwardsTagsImdb !== false && imdb != null, imdb);
        push('certifiedFresh', admin.AwardsTagsCertifiedFresh !== false && read(facts, 'certifiedFresh') === true);
        push('oscar', admin.AwardsTagsOscar !== false && read(facts, 'oscarWinner') === true, undefined, read(facts, 'oscarYear'));
        push('emmy', admin.AwardsTagsEmmy !== false && read(facts, 'emmyWinner') === true, undefined, read(facts, 'emmyYear'));
        push('letterboxdTop250', admin.AwardsTagsLetterboxd !== false && letterboxd != null, letterboxd);
        return out;
    }
    /** Build an escaped text chip around trusted, bundled decorative logo artwork. */
    function chip(fact) {
        const el = document.createElement('div');
        el.className = 'awards-tag';
        el.dataset.jeAward = fact.id;
        const name = JE.t('awards_tags_' + fact.id);
        el.title = name + (fact.rank ? ' · ' + JE.t('awards_tags_rank', { rank: fact.rank }) : '') + (Number.isInteger(fact.year) ? ' · ' + fact.year : '');
        el.setAttribute('aria-label', el.title);
        const logo = document.createElement('span');
        logo.className = 'awards-tag-logo';
        logo.setAttribute('aria-hidden', 'true');
        logo.innerHTML = LOGOS[fact.id] || '';
        const text = document.createElement('span');
        text.textContent = JE.t('awards_tags_label_' + fact.id);
        el.append(logo, text);
        return el;
    }
    /** Render already filtered facts through the shared placement and caps controller. */
    function render(ctx, el, facts) {
        if (ctx.shouldIgnore(el) || el.closest('.je-hidden')) return;
        ctx.removeExistingOverlay(el);
        const wrapper = document.createElement('div');
        wrapper.className = 'awards-overlay-container';
        for (const fact of resolve(facts)) wrapper.appendChild(chip(fact));
        ctx.commitOverlay(el, wrapper);
    }
    const spec = {
        logPrefix: '[AwardsTags]', settingKey: 'awardsTagsEnabled', containerClass: 'awards-overlay-container', taggedAttr: 'jeAwardsTagged',
        styleId: 'je-awards-tags-css', buildCss: () => CSS,
        position: { userKey: 'awardsTagsPosition', pluginKey: 'AwardsTagsPosition', fallback: 'top-left' },
        pipeline: {
            needsFirstEpisode: false, needsParentSeries: false,
            render(ctx, el, item) { render(ctx, el, item.Awards); },
            renderFromServerCache(ctx, el, entry) { render(ctx, el, entry.Awards); },
        },
    };
    /** Register Awards when enabled; no upstream or per-card network lookups. */
    JE.initializeAwardsTags = function() { JE.core.tagRenderer.register('awards', spec).injectCss(); };
    /** Re-register and clear old chips after a personal switch changes. */
    JE.reinitializeAwardsTags = function() { JE.core.tagRenderer.reinitialize('awards', spec); };
    JE.awardsTags = { IDS, LABELS, resolve, chip, CSS };
})(window.JellyfinEnhanced);
