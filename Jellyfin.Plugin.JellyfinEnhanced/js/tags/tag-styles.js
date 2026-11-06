// /js/tags/tag-styles.js
// Applies Tag Styles (Configuration > Tag Styles) to the web overlays. The
// server resolves every chip's colours (preset palette, then group override,
// then label override) and only hands them out when the admin's target is
// "web" or "both"; the same resolution drives the poster images drawn for
// native clients, so both stay in step. When the admin lets users pick their
// own preset, the user's choice (settings panel) is sent along and the admin's
// group and label overrides stay on top. Rules use a doubled/extra class so
// they beat the tag modules' own rules whatever order the stylesheets land in.
// Under the Poster preset the server lists only the overrides; the colours
// underneath come from each card's artwork (tags/tag-poster-colours.js), set
// as custom properties on the card, and posterRules() below paints them: each
// rule matches its group's override selectors in specificity and comes first,
// so a tag or group colour the admin set wins field by field.
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Tag Styles:';
    const styleId = 'je-tag-style-overrides';
    const PRESETS = ['default', 'glass', 'outline', 'dark', 'light', 'mono', 'poster'];
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
        return border && COLOUR.test(border) ? `outline: 1px solid ${border} !important; outline-offset: -1px !important; --je-tag-ring-color: ${border} !important; outline-color: var(--je-tag-ring-outline, ${border}) !important;` : '';
    }

    /**
     * Pushes `selector { body }` when the body is not empty.
     * @param {string[]} rules
     * @param {string} selector
     * @param {string} body
     * @returns {void}
     */
    // One element id, as `#tagStylePreview`: no combinators, lists or braces.
    const SCOPE_ID = /^#[A-Za-z_][A-Za-z0-9_-]*$/;
    // Page-wide rules leave out chips inside an element with this attribute:
    // a preview that draws other styles with its own scoped sheet (the Media
    // Tags admin page draws the server defaults, not the signed-in user's).
    // :where() adds no specificity, so every other chip matches as before.
    const SCOPE_ATTR = 'data-je-tag-styles-scope';
    const OUTSIDE_SCOPES = `:where(:not([${SCOPE_ATTR}] *))`;

    function push(rules, selector, body) {
        if (body) rules.push(`${selector} { ${body} }`);
    }

    // A genre name that floats beside its chip on hover, not one written
    // inline in the hover reveal (which keeps the chip's own background).
    const GENRE_NAME_FLOATS = ':not([data-je-slot="hover"] *)';

    /**
     * The genre colours keyed by label: `*` (every genre chip), then the
     * canonical genres (data-je-genre). An older single colour object counts
     * as `*`.
     * @param {Object|undefined} genre
     * @returns {Object<string, Object>}
     */
    function genreMap(genre) {
        if (!genre || typeof genre !== 'object') return {};
        return ['background', 'border', 'color'].some((f) => typeof genre[f] === 'string') ? { '*': genre } : genre;
    }

    /**
     * The Poster preset's static rules: chips on a card marked
     * data-je-poster-colour take its --je-tag-bg / --je-tag-border /
     * --je-tag-fg. Each selector has the specificity of the override rules
     * of its group (buildCss), so those, coming later, win field by field;
     * !important beats the tag modules' own colours. Flags keep theirs.
     * @param {string} P - Scope prefix ('' or '#id ').
     * @returns {string[]}
     */
    function posterRules(P) {
        const M = `${P}[data-je-poster-colour]`;
        const fill = 'background: var(--je-tag-bg) !important; color: var(--je-tag-fg) !important;';
        const edge = 'border-color: var(--je-tag-border) !important;';
        const ringed = 'outline: 1px solid var(--je-tag-border) !important; outline-offset: -1px !important; --je-tag-ring-color: var(--je-tag-border) !important; outline-color: var(--je-tag-ring-outline, var(--je-tag-border)) !important;';
        return [
            // (0,4,0): over the quality module's !important label rules, level with the "*" override.
            `${M} .quality-overlay-container.quality-overlay-container .quality-overlay-label { ${fill} ${edge} }`,
            `${M} .age-rating-overlay-container .age-rating-tag { background-color: var(--je-tag-bg) !important; color: var(--je-tag-fg) !important; ${edge} }`,
            `${M} .rating-overlay-container .rating-tag { ${fill} ${ringed} }`,
            `${M} .rating-overlay-container .rating-tag :is(.rating-star-icon, .je-userreview-icon) { color: var(--je-tag-fg) !important; }`,
            `${M} .awards-overlay-container .awards-tag { ${fill} ${ringed} }`,
            `${M} .logo-overlay-container .je-logo-chip[data-je-logo-style] { ${fill} ${edge} }`,
            `${M} .custom-overlay-container.custom-overlay-container .custom-tag { ${fill} ${edge} }`,
            `${M} .genre-tag { background-color: var(--je-tag-bg) !important; color: var(--je-tag-fg) !important; ${edge} }`,
            `${M} .language-overlay-container .language-chip { ${fill} ${edge} }`,
            `${M} .status-overlay-container .status-tag { background-color: var(--je-tag-bg) !important; color: var(--je-tag-fg) !important; ${edge} }`,
            `${M} .status-overlay-container .status-tag .status-tag-rank { color: var(--je-tag-fg) !important; }`,
            `${M} .je-tag-pill { background: var(--je-tag-bg); border-color: var(--je-tag-border); color: var(--je-tag-fg); }`,
            `${M} .je-tag-pill .je-tag-pill-glyph { color: inherit; }`,
        ];
    }

    /**
     * Builds the stylesheet from the server's web model (GET tag-styles).
     * @param {Object} styles - `{quality, age, ageDefault, rating, genre, status, language, awards, logos, custom}`
     *   (`genre` is keyed by label like `quality`: `*`, then canonical genres).
     * @param {string} [scope] - The id selector of one element every rule is
     *   limited to (`#tagStylePreview` for the config page's live preview);
     *   omitted, the rules style the whole page. Anything but a single `#id`
     *   is refused, so a caller can never widen the rules to other elements.
     *   Unscoped rules skip chips inside `[data-je-tag-styles-scope]`.
     * @returns {string} The CSS, empty when nothing is styled.
     */
    function buildCss(styles, scope) {
        const rules = [];
        if (scope !== undefined && scope !== null && scope !== '' && !SCOPE_ID.test(scope)) {
            throw new Error('tag-styles: scope must be a single #id selector');
        }
        const P = scope ? `${scope} ` : '';
        /**
         * Pushes one rule for these selectors (the page-wide sheet guards each one's subject).
         * @param {string|string[]} selectors
         * @param {string} body
         */
        const add = (selectors, body) => push(rules, [].concat(selectors).map((sel) => (scope ? sel : sel + OUTSIDE_SCOPES)).join(', '), body);
        // Poster preset: the artwork's colours first, every override after them.
        if (styles.preset === 'poster') rules.push(...posterRules(P).map((rule) => scope ? rule : rule.replace(/ (\{)/, OUTSIDE_SCOPES + ' $1')));
        const quality = styles.quality || {};
        // Beat category rules (including editions) regardless of reinjection order.
        const Q = `${P}.quality-overlay-container.quality-overlay-container.quality-overlay-container .quality-overlay-label`;
        // The "*" rule covers labels outside the catalog; per-label rules win on specificity.
        if (quality['*']) add(Q, `${decl('background', quality['*'].background)}${decl('color', quality['*'].color)}${decl('border-color', quality['*'].border)}`);
        for (const [label, c] of Object.entries(quality)) {
            if (label === '*' || !c) continue;
            add(`${Q}[data-quality="${attr(label)}"]`, `${decl('background', c.background)}${decl('color', c.color)}${decl('border-color', c.border)}`);
        }

        const A = `${P}.age-rating-overlay-container .age-rating-tag`;
        if (styles.ageDefault) add(`${P}.age-rating-overlay-container.age-rating-overlay-container .age-rating-tag`, box(styles.ageDefault));
        for (const board of Array.isArray(styles.age) ? styles.age : []) {
            const ratings = Array.isArray(board?.ratings) ? board.ratings : [];
            if (!ratings.length) continue;
            add(ratings.map((r) => `${A}[rating="${attr(r)}"]`), box(board));
        }

        const chips = styles.rating || {};
        const R = `${P}.rating-overlay-container .rating-tag`;
        if (chips.community) {
            add(`${R}.rating-tag-tmdb`, decl('background', chips.community.background) + decl('color', chips.community.color) + ring(chips.community.border));
            add(`${R}.rating-tag-tmdb .rating-star-icon`, decl('color', chips.community.color));
        }
        if (chips.critic) {
            add(`${R}.rating-tag-critic`, decl('background', chips.critic.background) + decl('color', chips.critic.color) + ring(chips.critic.border));
        }
        if (chips.userReview) {
            add(`${R}.rating-tag-userreview`, decl('background', chips.userReview.background) + decl('color', chips.userReview.color) + ring(chips.userReview.border));
            add(`${R}.rating-tag-userreview .je-userreview-icon`, decl('color', chips.userReview.color));
        }

        for (const [id, c] of Object.entries(chips)) {
            if (!c || ['community', 'critic', 'userReview'].includes(id)) continue;
            add(`${R}[data-je-rating-source="${attr(id)}"]`, decl('background', c.background) + decl('color', c.color) + ring(c.border));
        }

        // Genre: "*" is every chip, then each genre label (data-je-genre). Only a
        // genre with colours of its own colours its name (hover float, caption
        // strip, Summary/Minimal reveal): group and preset colours leave the
        // names as they always were, so existing documents draw unchanged.
        const genre = genreMap(styles.genre);
        const G = `${P}.genre-overlay-container .genre-tag`;
        if (genre['*']) add(G, box(genre['*']));
        for (const [label, c] of Object.entries(genre)) {
            if (label === '*' || !c) continue;
            const L = `[data-je-genre="${attr(label)}"]`;
            add(`${G}${L}`, box(c));
            // Under Poster the name first takes the artwork colours its chip
            // has (same specificity as the rules below, which win field by field).
            if (styles.preset === 'poster') {
                add(`${P}[data-je-poster-colour] .genre-tag${L} .genre-text`, 'color: var(--je-tag-fg) !important;');
                add(`${P}[data-je-poster-colour] .genre-tag${L} .genre-text${GENRE_NAME_FLOATS}`, 'background-color: var(--je-tag-bg) !important;');
            }
            add(`${G}${L} .genre-text`, decl('color', c.color));
            add(`${G}${L} .genre-text${GENRE_NAME_FLOATS}`, decl('background-color', c.background));
        }

        for (const [id, color] of Object.entries(styles.awards || {})) {
            if (color) add(`${P}.awards-overlay-container .awards-tag[data-je-award="${attr(id)}"]`, decl('background', color.background) + decl('color', color.color) + ring(color.border));
        }

        const status = styles.status || {};
        for (const key of STATUS_LABELS) {
            const c = status[key];
            if (!c) continue;
            const S = `${P}.status-overlay-container .status-tag[data-je-status="${key}"]`;
            add(S, box(c));
            // The rank ("#3") keeps its accent unless the text colour is styled.
            if (key === 'trending') add(`${S} .status-tag-rank`, decl('color', c.color));
        }

        // Custom chips: "*" is every chip of the group, then each rule label.
        const custom = styles.custom || {};
        const C = `${P}.custom-overlay-container.custom-overlay-container .custom-tag`;
        if (custom['*']) add(C, box(custom['*']));
        for (const [label, c] of Object.entries(custom)) {
            if (label === '*' || !c) continue;
            add(`${C}[data-je-custom="${attr(label)}"]`, box(c));
        }

        if (styles.language) {
            add(`${P}.language-overlay-container .language-chip`, box(styles.language));
        }
        // Only flag images keep their inner ring; chip borders use the shared box treatment.
        const flagColours = styles.languageLabels?.flag || styles.language;
        if (flagColours) add(`${P}.language-overlay-container .language-flag:not(.language-flag-partial)`, ring(flagColours.border));
        for (const [label, color] of Object.entries(styles.languageLabels || {})) {
            if (!color) continue;
            if (['subtitles', 'countBadge', 'code'].includes(label)) {
                const kind = label === 'code' ? '.language-code' : `[data-je-language="${label}"]`;
                add(`${P}.language-overlay-container.language-overlay-container .language-chip${kind}`, box(color));
            } else if (label !== 'flag') {
                add(`${P}.language-overlay-container.language-overlay-container.language-overlay-container .language-chip[data-je-language-label="${attr(label)}"]`, box(color));
            }
        }
        // Logos: the pill behind a logo or name; text colours the name chip.
        const logos = styles.logos || {};
        for (const key of ['provider', 'company', 'text']) {
            const c = logos[key];
            if (c) add(`${P}.logo-overlay-container .je-logo-chip[data-je-logo-style="${key}"]`, box(c));
        }
        if (scope && rules.length && JE.core?.tagLayout?.buildFlushStyles) rules.push(JE.core.tagLayout.buildFlushStyles(scope));
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
     * Removes the stylesheet and invalidates every request in flight, so a
     * slower answer cannot bring the styles back. Synchronous on purpose.
     * @returns {void}
     */
    function deactivate() {
        requestSeq++;
        JE.core?.ui?.removeCss(styleId);
        JE.tagPosterColours?.setActive(false);
    }

    // On a user switch or logout the previous user's styles (their preset) go
    // at once; je:user-data-loaded re-applies them for the incoming user.
    JE.session?.onUserChange('tag-styles', deactivate);

    /**
     * Fetches the effective styles and (re)injects the stylesheet. Overlapping
     * calls (a quick preset change, a user switch) keep only the latest answer,
     * and an answer is dropped once the styles were deactivated or the
     * signed-in user changed while it was on its way.
     * @returns {Promise<void>}
     */
    JE.initializeTagStyles = async function() {
        if (!listening) {
            listening = true;
            // The incoming user's settings (and preset) are loaded by then.
            document.addEventListener('je:user-data-loaded', () => {
                if (JE.pluginConfig?.TagStyleWebActive) JE.initializeTagStyles();
                else deactivate();
            });
        }
        if (!JE.pluginConfig?.TagStyleWebActive) {
            deactivate();
            return;
        }
        const seq = ++requestSeq;
        const epoch = JE.session ? JE.session.getEpoch() : 0;
        try {
            const preset = userPreset();
            const styles = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('JellyfinEnhanced/tag-styles', preset ? { preset } : undefined),
                dataType: 'json'
            });
            if (seq !== requestSeq || (JE.session && !JE.session.isCurrent(epoch)) || !JE.pluginConfig?.TagStyleWebActive) return;
            const css = buildCss(styles || {});
            if (css) JE.core.ui.injectCss(styleId, css);
            else JE.core.ui.removeCss(styleId);
            // Poster preset: cards take their artwork's colours from here on.
            JE.tagPosterColours?.setActive(styles?.preset === 'poster');
        } catch (e) {
            console.warn(`${logPrefix} Could not load tag style overrides.`, e);
        }
    };

    JE.tagStyles = { PRESETS, SCOPE_ATTR, buildCss, deactivate };
})(window.JellyfinEnhanced);
