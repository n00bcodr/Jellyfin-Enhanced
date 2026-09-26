/**
 * @file Manages subtitle customization, including presets and style application.
 */
(function(JE) {
    'use strict';

    let subtitleObserver = null;
    let currentSubtitleStyle = {};

    // Marks elements this module has styled. Jellyfin's own Custom subtitle mode writes
    // the same inline properties, so cleanup must only touch marked elements, and puts
    // back the inline style Jellyfin had set before this module overwrote it.
    const STYLED_ATTR = 'data-je-subtitle-styled';
    const ORIGINAL_STYLE_ATTR = 'data-je-original-style';

    // Jellyfin renders a secondary subtitle track in its own sibling element inside .videoSubtitles.
    const TEXT_SELECTOR = '.videoSubtitlesInner, .videoSecondarySubtitlesInner';

    function markStyled(el) {
        if (el.hasAttribute(STYLED_ATTR)) return;
        el.setAttribute(ORIGINAL_STYLE_ATTR, el.getAttribute('style') || '');
        el.setAttribute(STYLED_ATTR, '');
    }

    function restoreOriginalStyle(el) {
        const original = el.getAttribute(ORIGINAL_STYLE_ATTR);
        el.removeAttribute(STYLED_ATTR);
        el.removeAttribute(ORIGINAL_STYLE_ATTR);
        if (original) el.setAttribute('style', original);
        else el.removeAttribute('style');
    }

    /**
     * Preset styles for subtitles.
     * @type {Array<object>}
     */
    JE.subtitlePresets = [
        { name: "Clean White", textColor: "#FFFFFFFF", bgColor: "transparent", previewText: "Aa" },
        { name: "Classic Black Box", textColor: "#FFFFFFFF", bgColor: "#000000FF", previewText: "Aa" },
        { name: "Netflix Style", textColor: "#FFFFFFFF", bgColor: "#000000B2", previewText: "Aa" },
        { name: "Cinema Yellow", textColor: "#FFFF00FF", bgColor: "#000000B2", previewText: "Aa" },
        { name: "Soft Gray", textColor: "#FFFFFFFF", bgColor: "#444444B2", previewText: "Aa" },
        { name: "High Contrast", textColor: "#000000FF", bgColor: "#FFFFFFFF", previewText: "Aa" }
    ];

    /**
     * Preset font sizes for subtitles.
     * @type {Array<object>}
     */
    JE.fontSizePresets = [
        { name: "Tiny", size: 0.8, previewText: "Aa" },
        { name: "Small", size: 1, previewText: "Aa" },
        { name: "Normal", size: 1.2, previewText: "Aa" },
        { name: "Large", size: 1.8, previewText: "Aa" },
        { name: "Extra Large", size: 2, previewText: "Aa" },
        { name: "Gigantic", size: 3, previewText: "Aa" }
    ];

    /**
     * Preset font families for subtitles.
     * @type {Array<object>}
     */
    JE.fontFamilyPresets = [
        { name: "Default", family: "inherit", previewText: "AaBb" },
        { name: "Noto Sans", family: "Noto Sans,sans-serif", previewText: "AaBb" },
        { name: "Sans Serif", family: "Arial,Helvetica,sans-serif", previewText: "AaBb" },
        { name: "Typewriter", family: "Courier New,Courier,monospace", previewText: "AaBb" },
        { name: "Roboto", family: "Roboto Mono,monospace", previewText: "AaBb" }
    ];

    // The soft glow used since #47 when text sits directly on the video with no
    // background box. Also what the "Auto" text effect resolves to in that case.
    const AUTO_SHADOW = '0 0 4px #000, 0 0 8px #000, 1px 1px 2px #000';

    /**
     * Builds an outline as a ring of hard (zero-blur) text-shadows. A dense ring
     * reads as a solid stroke; the four-corner version this module used to ship
     * left visible gaps at the cardinal points (#205). em units keep the stroke
     * proportional to whatever font size preset is active. Layered text-shadow is
     * used instead of -webkit-text-stroke because it is honoured by ::cue and
     * paints behind the glyph rather than eating into it.
     * @param {number} width Stroke radius in em.
     * @param {string} color CSS color of the stroke.
     * @returns {string} A text-shadow value.
     */
    function outlineShadow(width, color) {
        const steps = 16;
        const parts = [];
        for (let i = 0; i < steps; i++) {
            const angle = (Math.PI * 2 * i) / steps;
            const x = (Math.cos(angle) * width).toFixed(3);
            const y = (Math.sin(angle) * width).toFixed(3);
            parts.push(`${x}em ${y}em 0 ${color}`);
        }
        return parts.join(', ');
    }

    /**
     * Preset text effects for subtitles. `shadow` is the CSS text-shadow to apply;
     * `null` marks the "Auto" preset, which keeps the historical behaviour (soft
     * shadow on a transparent background, nothing on a solid one) and is the
     * default so existing users see no change.
     * @type {Array<object>}
     */
    JE.subtitleTextEffectPresets = [
        { name: "Auto", shadow: null, previewText: "Aa" },
        { name: "None", shadow: "none", previewText: "Aa" },
        { name: "Shadow", shadow: AUTO_SHADOW, previewText: "Aa" },
        { name: "Outline", shadow: outlineShadow(0.08, '#000'), previewText: "Aa" },
        { name: "Outline + Shadow", shadow: `${outlineShadow(0.08, '#000')}, 0.12em 0.12em 0.2em rgba(0,0,0,0.85)`, previewText: "Aa" }
    ];

    /**
     * Resolves the text-shadow for the user's selected text effect preset.
     * @param {string} bgColor The subtitle background color in effect; only the
     *   "Auto" preset looks at it (shadow when transparent, none otherwise).
     * @param {number} [presetIndex] Text effect preset to resolve; defaults to
     *   the saved selection.
     * @returns {string} A CSS text-shadow value.
     */
    JE.getSubtitleTextShadow = (bgColor, presetIndex) => {
        const index = presetIndex ?? JE.currentSettings.selectedTextEffectPresetIndex ?? 0;
        const preset = JE.subtitleTextEffectPresets[index] || JE.subtitleTextEffectPresets[0];
        if (preset.shadow !== null) return preset.shadow;
        return bgColor === 'transparent' || bgColor === '#00000000' ? AUTO_SHADOW : 'none';
    };

    /**
     * Splits a stored subtitle color into a swatch (for <input type="color">)
     * and a 0-255 alpha slider value. Not every stored value is 8-digit hex —
     * the "Clean White" preset stores the bare word `transparent` — and a
     * blind substring slice on a word like that hands the alpha input a
     * non-numeric fragment, which parseInt turns into NaN; browsers then
     * silently render the slider at its midpoint instead of 0.
     * @param {string} input Stored value: #RRGGBB, #RRGGBBAA, or `transparent`.
     * @param {{fallbackSwatch: string, fallbackAlphaValue: number}} fallback
     *   Used verbatim when input can't be decoded.
     * @returns {{swatch: string, alphaValue: number}}
     */
    JE.decodeSubtitleColor = (input, fallback) => {
        if (input === 'transparent') return { swatch: fallback.fallbackSwatch, alphaValue: 0 };
        const isHex = typeof input === 'string' && input.charCodeAt(0) === 35 /* '#' */
            && (input.length === 7 || input.length === 9);
        if (!isHex) return { swatch: fallback.fallbackSwatch, alphaValue: fallback.fallbackAlphaValue };

        const swatch = input.slice(0, 7);
        // A 6-digit hex has no alpha byte at all, which is opaque CSS — default
        // to 255 there rather than reusing the caller's "unusable input" fallback.
        const alphaValue = input.length === 9 ? parseInt(input.slice(7, 9), 16) : 255;
        return { swatch, alphaValue: Number.isNaN(alphaValue) ? fallback.fallbackAlphaValue : alphaValue };
    };

    /**
     * Applies subtitle position to the .videoSubtitles container element.
     * xPct is the horizontal center; yPct is the bottom edge, anchored via
     * `bottom` so extra lines grow upward instead of shifting the bottom margin.
     * When disableCustomSubtitleStyles is true, removes JE position overrides entirely.
     */
    function applySubtitlePosition() {
        const containers = document.querySelectorAll('.videoSubtitles');
        if (!containers.length) return;

        const disabled = JE.currentSettings.disableCustomSubtitleStyles;

        containers.forEach(container => {
            if (disabled) {
                if (container.hasAttribute(STYLED_ATTR)) restoreOriginalStyle(container);
            } else {
                markStyled(container);
                const xPct = JE.currentSettings.subtitleHorizontalPosition ?? 50;
                const yPct = JE.currentSettings.subtitleVerticalPosition ?? 95;
                container.style.setProperty('position', 'absolute', 'important');
                container.style.setProperty('left', `${xPct}%`, 'important');
                container.style.setProperty('top', 'auto', 'important');
                container.style.setProperty('bottom', `${100 - yPct}%`, 'important');
                container.style.setProperty('transform', 'translateX(-50%)', 'important');
                container.style.setProperty('text-align', 'center', 'important');
                container.style.setProperty('width', '100%', 'important');
                container.style.setProperty('max-width', 'none', 'important');
                // Gap between simultaneous cue boxes so backgrounds don't touch/overlap.
                container.style.setProperty('gap', '0.25em', 'important');
            }
        });
    }

    /**
     * Removes JE-injected subtitle styles from the elements this module styled.
     * Called when the user disables custom subtitle styles. Elements it never
     * styled are left alone so Jellyfin's own subtitle appearance stays intact.
     */
    function removeInjectedStyles() {
        document.querySelectorAll(`.videoSubtitlesInner[${STYLED_ATTR}], .videoSecondarySubtitlesInner[${STYLED_ATTR}], .videoSubtitles[${STYLED_ATTR}]`)
            .forEach(restoreOriginalStyle);
        // Remove legacy ::cue overrides
        const styleElement = document.getElementById('je-html-videoplayer-cuestyle');
        if (styleElement?.sheet) {
            try {
                while (styleElement.sheet.cssRules.length > 0) styleElement.sheet.deleteRule(0);
            } catch (e) { /* ignore */ }
        }
        // Stop the observer — no point watching when styles are disabled
        if (subtitleObserver) {
            subtitleObserver.unsubscribe();
            subtitleObserver = null;
        }
    }

    // Expose so the position observer (started in startSubtitleObserver) can reapply on new containers
    JE.applySubtitlePosition = applySubtitlePosition;

    /**
     * Directly modifies the inline style of a subtitle element to ensure overrides.
     * This function is the core of the fix for Jellyfin 10.11+.
     */
    function forceApplyInlineStyles(element) {
        if (!element || JE.currentSettings.disableCustomSubtitleStyles) return;
        markStyled(element);

        // Apply all custom styles directly to videoSubtitlesInner
        element.style.setProperty('background-color', currentSubtitleStyle.bgColor, 'important');
        element.style.setProperty('color', currentSubtitleStyle.textColor, 'important');
        element.style.setProperty('font-size', `${currentSubtitleStyle.fontSize}vw`, 'important');
        element.style.setProperty('font-family', currentSubtitleStyle.fontFamily, 'important');
        element.style.setProperty('text-shadow', currentSubtitleStyle.textShadow || 'none', 'important');

        // Border radius, not configurable in the UI ***
        element.style.setProperty('border-radius', '5px', 'important');

        // Some padding when a background is visible to prevent text touching the edges
        if (currentSubtitleStyle.bgColor && currentSubtitleStyle.bgColor !== 'transparent') {
            element.style.setProperty('padding', '0.2em 0.4em', 'important');
        } else {
            element.style.setProperty('padding', '0', 'important');
        }

        // Explicitly reset vanilla Jellyfin properties that could conflict with our styling
        element.style.setProperty('font-weight', 'normal', 'important');
        element.style.setProperty('font-style', 'normal', 'important');
        element.style.setProperty('font-variant', 'normal', 'important');

        // The secondary element keeps Jellyfin's own spacing (margins are set by its
        // stylesheet), which is what separates it from the primary line.
        if (element.classList.contains('videoSecondarySubtitlesInner')) return;

        // Vanilla Jellyfin's own subtitle-position slider writes its offset as a
        // margin directly on this same element, independent of anything JE sets.
        // Left alone it stacks on top of our container-level positioning, so the
        // subtitle lands somewhere other than what the JE position grid shows.
        element.style.setProperty('margin-top', '0', 'important');
        element.style.setProperty('margin-bottom', '0', 'important');
    }

    /**
     * Watches for subtitle elements and applies styles to them as they appear.
     */
    function startSubtitleObserver() {
        if (subtitleObserver) subtitleObserver.unsubscribe();
        subtitleObserver = JE.helpers.onBodyMutation('subtitles', (mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === 1) {
                        if (node.matches(TEXT_SELECTOR)) {
                            forceApplyInlineStyles(node);
                        } else if (node.querySelectorAll) {
                            node.querySelectorAll(TEXT_SELECTOR).forEach(forceApplyInlineStyles);
                        }
                        // Also reapply position whenever a subtitle container appears
                        if (node.classList.contains('videoSubtitles') || node.querySelector?.('.videoSubtitles')) {
                            applySubtitlePosition();
                        }
                    }
                }
            }
        });
    }

    /**
     * Main function to apply styles. It sets the desired style and starts the process.
     */
    JE.applySubtitleStyles = (textColor, bgColor, fontSize, fontFamily, textShadow) => {
        // Store the chosen style globally for the observer to use
        currentSubtitleStyle = { textColor, bgColor, fontSize, fontFamily, textShadow };

        // Force-apply to any subtitle elements that might already exist
        document.querySelectorAll(TEXT_SELECTOR).forEach(forceApplyInlineStyles);

        // Apply position to the container
        applySubtitlePosition();

        // Start the observer to catch any new subtitle elements
        startSubtitleObserver();

        // Also apply styles to ::cue, the native browser rendering path Jellyfin
        // uses when its own subtitle style isn't set to "Custom" (in that mode text
        // cues never pass through .videoSubtitlesInner, so forceApplyInlineStyles
        // above never touches them). Color/font/size/shadow carry over here; the
        // .videoSubtitlesInner-only properties (border-radius, padding) and the
        // position override do not, since ::cue's allowed property set excludes
        // them and there's no repositionable container to move.
        const oldStyleElement = document.getElementById('htmlvideoplayer-cuestyle');
        if (oldStyleElement?.sheet) {
            let styleElement = document.getElementById('je-html-videoplayer-cuestyle');
            if (!styleElement?.sheet) {
                styleElement = document.createElement('style');
                styleElement.id = 'je-html-videoplayer-cuestyle'
                document.head.appendChild(styleElement)
            }

            try {
                while (styleElement.sheet.cssRules.length > 0) styleElement.sheet.deleteRule(0);
                if (JE.currentSettings.disableCustomSubtitleStyles) return;
                const cueRule = `
                video.htmlvideoplayer::cue {
                    background-color: ${bgColor} !important;
                    color: ${textColor} !important;
                    font-size: ${fontSize}vw !important;
                    font-family: ${fontFamily} !important;
                    text-shadow: ${textShadow || 'none'} !important;
                }`;
                styleElement.sheet.insertRule(cueRule, 0);
            } catch (e) {
                console.error("🪼 Jellyfin Enhanced: Failed to apply ::cue styles:", e);
            }
        }
    };

    /**
     * Loads saved settings and triggers the style application.
     * When custom styles are disabled, removes all JE-injected styles cleanly.
     */
    JE.applySavedStylesWhenReady = () => {
        if (!document.querySelector('video')) {
            if (subtitleObserver) {
                subtitleObserver.unsubscribe();
                subtitleObserver = null;
            }
            return;
        }

        if (JE.currentSettings.disableCustomSubtitleStyles) {
            removeInjectedStyles();
            return;
        }

        const textColor = JE.currentSettings.customSubtitleTextColor || '#FFFFFFFF';
        const bgColor = JE.currentSettings.customSubtitleBgColor || '#00000000';
        const textShadow = JE.getSubtitleTextShadow(bgColor);

        const fontSizePreset = JE.fontSizePresets[JE.currentSettings.selectedFontSizePresetIndex ?? 2];
        const fontFamilyPreset = JE.fontFamilyPresets[JE.currentSettings.selectedFontFamilyPresetIndex ?? 0];

        if (fontSizePreset && fontFamilyPreset) {
            JE.applySubtitleStyles(
                textColor,
                bgColor,
                fontSizePreset.size,
                fontFamilyPreset.family,
                textShadow
            );
        }
    };

})(window.JellyfinEnhanced);