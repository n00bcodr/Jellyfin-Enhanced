// /js/tags/tag-styles.js
// Applies Tag Styles (Configuration > Tag Styles) to the web overlays. The
// server resolves every chip's colours (preset palette, then group override,
// then label override) and only hands them out when the admin's target is
// "web" or "both"; the same resolution drives the poster images drawn for
// native clients, so both stay in step. When the admin lets users pick their
// own preset, the user's choice (settings panel) is sent along and the admin's
// group and label overrides stay on top. Rules use a doubled/extra class so
// they beat the tag modules' own rules whatever order the stylesheets land in.
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Tag Styles:';
    const styleId = 'je-tag-style-overrides';
    const PRESETS = ['default', 'glass', 'outline', 'dark', 'light', 'mono'];
    const STATUS_LABELS = ['added', 'newMovie', 'newSeries', 'newEpisode', 'trending'];

    // Values come from the server already validated as rgba() colours; this is
    // a second guard so nothing but a colour can ever reach the stylesheet.
    const COLOUR = /^rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*[\d.]+\s*\)$/;
    const decl = (prop, value) => (value && COLOUR.test(value) ? `${prop}: ${value} !important;` : '');
    /** Escapes a value for a double-quoted CSS attribute selector. */
    const attr = (value) => String(value).replace(/["\\]/g, '\\$&').replace(/[\n\r\f]/g, '\\a ');

    let requestSeq = 0;
    let listening = false;

    /**
     * Background, text and border declarations for a chip that has a border.
     * @param {{background?: string, border?: string, color?: string}} c
     * @returns {string}
     */
    function box(c) {
        return decl('background-color', c.background) + decl('color', c.color) + decl('border-color', c.border);
    }

    /**
     * Declarations for a chip without a border of its own (rating chips, flags):
     * the Tag Styles border is an inner 1px ring, so the chip keeps its size
     * and native posters draw the same pixels.
     * @param {string|undefined} border
     * @returns {string}
     */
    function ring(border) {
        return border && COLOUR.test(border) ? `outline: 1px solid ${border} !important; outline-offset: -1px !important;` : '';
    }

    /**
     * Pushes `selector { body }` when the body is not empty.
     * @param {string[]} rules
     * @param {string} selector
     * @param {string} body
     * @returns {void}
     */
    function push(rules, selector, body) {
        if (body) rules.push(`${selector} { ${body} }`);
    }

    /**
     * Builds the stylesheet from the server's web model (GET tag-styles).
     * @param {Object} styles - `{quality, age, ageDefault, rating, genre, status, language}`.
     * @returns {string} The CSS, empty when nothing is styled.
     */
    function buildCss(styles) {
        const rules = [];
        const quality = styles.quality || {};
        const Q = '.quality-overlay-container.quality-overlay-container .quality-overlay-label';
        // The "*" rule covers labels outside the catalog; per-label rules win on specificity.
        if (quality['*']) push(rules, Q, `${decl('background', quality['*'].background)}${decl('color', quality['*'].color)}${decl('border-color', quality['*'].border)}`);
        for (const [label, c] of Object.entries(quality)) {
            if (label === '*' || !c) continue;
            push(rules, `${Q}[data-quality="${attr(label)}"]`, `${decl('background', c.background)}${decl('color', c.color)}${decl('border-color', c.border)}`);
        }

        const A = '.age-rating-overlay-container .age-rating-tag';
        if (styles.ageDefault) push(rules, `.age-rating-overlay-container${A}`, box(styles.ageDefault));
        for (const board of Array.isArray(styles.age) ? styles.age : []) {
            const ratings = Array.isArray(board?.ratings) ? board.ratings : [];
            if (!ratings.length) continue;
            push(rules, ratings.map((r) => `${A}[rating="${attr(r)}"]`).join(', '), box(board));
        }

        const chips = styles.rating || {};
        const R = '.rating-overlay-container .rating-tag';
        if (chips.community) {
            push(rules, `${R}.rating-tag-tmdb`, decl('background', chips.community.background) + decl('color', chips.community.color) + ring(chips.community.border));
            push(rules, `${R}.rating-tag-tmdb .rating-star-icon`, decl('color', chips.community.color));
        }
        if (chips.critic) {
            push(rules, `${R}.rating-tag-critic`, decl('background', chips.critic.background) + decl('color', chips.critic.color) + ring(chips.critic.border));
        }
        if (chips.userReview) {
            push(rules, `${R}.rating-tag-userreview`, decl('background', chips.userReview.background) + decl('color', chips.userReview.color) + ring(chips.userReview.border));
            push(rules, `${R}.rating-tag-userreview .je-userreview-icon`, decl('color', chips.userReview.color));
        }

        if (styles.genre) push(rules, '.genre-overlay-container .genre-tag', box(styles.genre));

        const status = styles.status || {};
        for (const key of STATUS_LABELS) {
            const c = status[key];
            if (!c) continue;
            const S = `.status-overlay-container .status-tag[data-je-status="${key}"]`;
            push(rules, S, box(c));
            // The rank ("#3") keeps its accent unless the text colour is styled.
            if (key === 'trending') push(rules, `${S} .status-tag-rank`, decl('color', c.color));
        }

        if (styles.language) {
            push(rules, '.language-overlay-container .language-flag:not(.language-flag-partial)', ring(styles.language.border));
        }
        return rules.join('\n');
    }

    /**
     * The preset to request: the user's own pick when the admin allows it.
     * @returns {string|null}
     */
    function userPreset() {
        if (!JE.pluginConfig?.TagStylesAllowUserPreset) return null;
        const preset = JE.currentSettings?.tagStylePreset;
        return typeof preset === 'string' && PRESETS.includes(preset) ? preset : null;
    }

    /**
     * Fetches the effective styles and (re)injects the stylesheet. Overlapping
     * calls (a quick preset change, a user switch) keep only the latest answer.
     * @returns {Promise<void>}
     */
    JE.initializeTagStyles = async function() {
        if (!listening) {
            listening = true;
            // The incoming user's settings (and preset) are loaded by then.
            document.addEventListener('je:user-data-loaded', () => {
                if (JE.pluginConfig?.TagStyleWebActive) JE.initializeTagStyles();
                else JE.core.ui.removeCss(styleId);
            });
        }
        const seq = ++requestSeq;
        try {
            const preset = userPreset();
            const styles = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('JellyfinEnhanced/tag-styles', preset ? { preset } : undefined),
                dataType: 'json'
            });
            if (seq !== requestSeq) return;
            const css = buildCss(styles || {});
            if (css) JE.core.ui.injectCss(styleId, css);
            else JE.core.ui.removeCss(styleId);
        } catch (e) {
            console.warn(`${logPrefix} Could not load tag style overrides.`, e);
        }
    };

    JE.tagStyles = { PRESETS, buildCss };
})(window.JellyfinEnhanced);
