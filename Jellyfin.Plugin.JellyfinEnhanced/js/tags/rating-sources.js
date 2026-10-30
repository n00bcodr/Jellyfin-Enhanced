/** @file Source rating formats, preferences and bundled logo sprites. */
(function(JE) {
    'use strict';
    const IDS = ['community', 'critic', 'imdb', 'tmdb', 'rtCritic', 'rtAudience', 'metacritic', 'letterboxd', 'trakt'];
    const COLORS = { community: '#ffc107', critic: '#ef4135', imdb: '#f5c518', tmdb: '#01b4a4', rtCritic: '#ef4135', rtAudience: '#ffeab0', metacritic: '#ffcc33', letterboxd: '#00e054', trakt: '#ed1c24' };
    const LOGOS = {"imdb":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 16\"><path fill=\"#f5c518\" d=\"M1 2H23V14H1Z\"/><path fill=\"#151515\" d=\"M3 4H5V12H3ZM7 4H10L11 8L12 4H15V12H13V7L12 12H10L9 7V12H7ZM17 4H20L22 6V10L20 12H17ZM19 6V10H20V6Z\"/></svg>","tmdb":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#01b4a4\" d=\"M1 3H15V7H1ZM9 9H23V13H9Z\"/></svg>","rtCritic":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#ef4135\" d=\"M4 7C1 17 9 23 15 20C23 18 23 7 16 6C12 3 7 3 4 7Z\"/><path fill=\"#48a848\" d=\"M12 8L6 2L11 4L14 0L15 5L21 3L17 8Z\"/></svg>","rtAudience":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#ffeab0\" d=\"M4 9C0 6 3 2 6 4C5 0 10 0 12 3C15 0 20 1 18 5C23 4 25 9 20 11Z\"/><path fill=\"#e64b40\" d=\"M4 10H21L18 23H7ZM8 11L10 21H12L11 11ZM15 11L14 21H16L18 11Z\"/></svg>","metacritic":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#ffcc33\" d=\"M1 1H23V23H1Z\"/><path fill=\"#202020\" d=\"M4 7H7V9C9 6 12 6 14 9C18 5 21 7 21 11V18H18V11C18 9 15 9 15 12V18H12V11C12 9 8 9 8 12V18H4Z\"/></svg>","letterboxd":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#ff8000\" d=\"M0 12A5 5 0 1 0 10 12A5 5 0 1 0 0 12\"/><path fill=\"#00e054\" d=\"M7 12A5 5 0 1 0 17 12A5 5 0 1 0 7 12\"/><path fill=\"#40bcf4\" d=\"M14 12A5 5 0 1 0 24 12A5 5 0 1 0 14 12\"/></svg>","trakt":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#ed1c24\" d=\"M1 12A11 11 0 1 0 23 12A11 11 0 1 0 1 12\"/><path fill=\"#ffffff\" d=\"M4 13L10 7L12 9L6 15ZM8 17L15 10L17 12L10 19ZM13 18L18 13L20 15L15 20Z\"/></svg>"};
    /** Keep distinct known source ids, preserving order and intentional empty lists. */
    function normalizeSources(value) {
        return Array.isArray(value) ? [...new Set(value.filter(id => IDS.includes(id)))] : null;
    }
    /** Resolve personal choices; old documents retain their include switches. */
    function settings(user = JE.currentSettings || {}, admin = JE.pluginConfig || {}) {
        const sources = normalizeSources(user.ratingTagsSources);
        const enabled = (key) => typeof user[key] === 'boolean' ? user[key] : admin[key[0].toUpperCase() + key.slice(1)] !== false;
        const minimum = Number(user.ratingTagsMinScore ?? admin.RatingTagsMinScore ?? 0);
        return {
            sources: sources ?? ['critic', 'community'].filter(id => enabled(id === 'community' ? 'ratingTagsShowCommunity' : 'ratingTagsShowCritic')),
            minimum: Number.isFinite(minimum) ? Math.max(0, Math.min(10, minimum)) : 0,
            color: (user.ratingTagsColorByScore ?? admin.RatingTagsColorByScore) === true
        };
    }
    /** Read a native-unit score, accepting cache and batch DTO casing. */
    function valueOf(ratings, id) {
        return ratings?.[id] ?? ratings?.[id[0].toUpperCase() + id.slice(1)] ?? null;
    }
    /** Source-native maximum, used only to compare scores on a common scale. */
    function maximum(id) { return id === 'community' || id === 'imdb' ? 10 : id === 'letterboxd' ? 5 : 100; }
    /** Score colour: red below five, amber to green at 7.5, then green. */
    function scoreColor(score) {
        if (score < 5) return '#ef5350';
        if (score >= 7.5) return '#66bb6a';
        const t = (score - 5) / 2.5;
        return '#' + [255 + (102 - 255) * t, 179 + (187 - 179) * t, 0 + 106 * t].map(n => Math.round(n).toString(16).padStart(2, '0')).join('');
    }
    /** Build ordered semantic scores before caps/density are applied by the layout controller. */
    function resolve(community, critic, ratings, conf = settings()) {
        return conf.sources.flatMap(id => {
            const raw = id === 'community' ? community : id === 'critic' ? critic : valueOf(ratings, id);
            if (raw === null || raw === undefined || raw === '' || !Number.isFinite(Number(raw))) return [];
            const value = Math.max(0, Math.min(maximum(id), Number(raw)));
            const score = value * 10 / maximum(id);
            if (score < conf.minimum) return [];
            const text = id === 'community' && value === 0 ? '—'
                : maximum(id) <= 10 ? value.toFixed(1)
                : Math.round(value) + (id === 'metacritic' ? '' : '%');
            return [{ id, value, text, color: conf.color ? scoreColor(score) : null }];
        });
    }
    /** Create one decorative SVG sprite without fetching remote assets. */
    function logo(id) {
        const el = document.createElement('span');
        el.className = 'je-rating-source-logo';
        el.setAttribute('aria-hidden', 'true');
        el.innerHTML = LOGOS[id] || '';
        return el;
    }
    /** Render the same chip for posters and the settings hub preview. */
    function chip(fact) {
        const el = document.createElement('div');
        const legacy = fact.id === 'community' ? ' rating-tag-tmdb' : fact.id === 'critic' ? ' rating-tag-critic' : ' rating-tag--source';
        el.className = 'rating-tag' + legacy;
        el.dataset.jeRatingSource = fact.id;
        el.style.setProperty('--je-rating-source-color', COLORS[fact.id]);
        if (fact.color) el.style.color = fact.color;
        el.title = JE.t('rating_source_' + fact.id) + ': ' + fact.text;
        el.setAttribute('aria-label', el.title);
        const icon = fact.id === 'community' || fact.id === 'critic' ? document.createElement('span') : logo(fact.id);
        if (fact.id === 'community') { icon.className = 'material-icons rating-star-icon'; icon.textContent = 'star'; }
        if (fact.id === 'critic') icon.className = 'rating-tomato-icon ' + (fact.value < 60 ? 'rotten' : 'fresh');
        icon.setAttribute('aria-hidden', 'true');
        const text = document.createElement('span');
        text.className = 'rating-text';
        text.textContent = fact.text;
        el.append(icon, text);
        return el;
    }
    JE.ratingSources = { IDS, COLORS, normalizeSources, settings, resolve, chip, scoreColor };
})(window.JellyfinEnhanced);
