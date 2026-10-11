// /js/tags/tag-styles.js
// Applies the admin's tag colour overrides (Configuration > Tag Styles) to the
// web overlays. The server only hands out overrides when the admin's target is
// "web" or "both"; the same JSON drives the poster images drawn for native
// clients, so both stay in step. Rules use a doubled/extra class so they beat
// the tag modules' own rules whatever order the stylesheets land in.
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Tag Styles:';
    const styleId = 'je-tag-style-overrides';

    // Values come from the server already validated as rgba() colours; this is
    // a second guard so nothing but a colour can ever reach the stylesheet.
    const COLOUR = /^rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*[\d.]+\s*\)$/;
    const decl = (prop, value) => (value && COLOUR.test(value) ? `${prop}: ${value} !important;` : '');
    const attr = (value) => String(value).replace(/["\\]/g, '\\$&');

    function box(c, withBorder) {
        return decl('background-color', c.background) + decl('color', c.color) + (withBorder ? decl('border-color', c.border) : '');
    }

    function buildCss(styles) {
        const rules = [];
        for (const [label, c] of Object.entries(styles.quality || {})) {
            rules.push(`.quality-overlay-container.quality-overlay-container .quality-overlay-label[data-quality="${attr(label)}"] { ${decl('background', c.background)}${decl('color', c.color)}${decl('border-color', c.border)} }`);
        }
        for (const [rating, c] of Object.entries(styles.age || {})) {
            rules.push(`.age-rating-overlay-container .age-rating-tag[rating="${attr(rating)}"] { ${box(c, true)} }`);
        }
        const chips = styles.rating || {};
        if (chips.community) {
            rules.push(`.rating-overlay-container .rating-tag.rating-tag-tmdb { ${box(chips.community, false)} }`);
            rules.push(`.rating-overlay-container .rating-tag.rating-tag-tmdb .rating-star-icon { ${decl('color', chips.community.color)} }`);
        }
        if (chips.critic) {
            rules.push(`.rating-overlay-container .rating-tag.rating-tag-critic { ${box(chips.critic, false)} }`);
        }
        if (styles.genre) {
            rules.push(`.genre-overlay-container .genre-tag { ${box(styles.genre, true)} }`);
        }
        return rules.join('\n');
    }

    JE.initializeTagStyles = async function() {
        try {
            const styles = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('JellyfinEnhanced/tag-styles'),
                dataType: 'json'
            });
            const css = buildCss(styles || {});
            if (css) JE.core.ui.injectCss(styleId, css);
            else JE.core.ui.removeCss(styleId);
        } catch (e) {
            console.warn(`${logPrefix} Could not load tag style overrides.`, e);
        }
    };
})(window.JellyfinEnhanced);
