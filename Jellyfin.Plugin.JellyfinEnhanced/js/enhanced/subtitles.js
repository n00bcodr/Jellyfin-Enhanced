/**
 * @file Manages subtitle customization, including presets and style application.
 */
(function(JE) {
    'use strict';

    /**
     * Preset styles for subtitles.
     * @type {Array<object>}
     */
    JE.subtitlePresets = [
        { name: "Clean White", textColor: "#FFFFFFFF", bgColor: "transparent", textShadow: "-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000", previewText: "Aa" },
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

    /**
     * Applies subtitle styles by modifying the dedicated cue style element.
     * @param {string} textColor The color of the subtitle text.
     * @param {string} bgColor The background color of the subtitles.
     * @param {number} fontSize The font size in vw units.
     * @param {string} fontFamily The font family.
     */
    JE.applySubtitleStyles = (textColor, bgColor, fontSize, fontFamily, textShadow) => {
        const styleElement = document.getElementById('htmlvideoplayer-cuestyle');
        if (!styleElement) return;

        const sheet = styleElement.sheet;
        if (!sheet) return;

        try {
            // Clear existing rules to ensure a clean slate.
            while (sheet.cssRules.length > 0) {
                sheet.deleteRule(0);
            }

            // Create and insert the new rule with the dynamic styles.
            const newRule = `
                .htmlvideoplayer::cue {
                    background-color: ${bgColor} !important;
                    color: ${textColor} !important;
                    font-size: ${fontSize}vw !important;
                    font-family: ${fontFamily} !important;
                    text-shadow: ${textShadow || 'none'} !important;
                }
            `;
            sheet.insertRule(newRule, 0);

        } catch (e) {
            console.error("🪼 Jellyfin Enhanced: Failed to apply subtitle styles:", e);
        }
    };

    /**
     * Reads saved subtitle settings and applies them.
     */
    JE.applySavedStylesWhenReady = () => {
        const styleElement = document.getElementById('htmlvideoplayer-cuestyle');
        if (!styleElement) {
            // If the style element isn't ready, try again shortly.
            // This can happen during page transitions.
            setTimeout(JE.applySavedStylesWhenReady, 100);
            return;
        }
        const savedStyleIndex = JE.currentSettings.selectedStylePresetIndex ?? 0;
        const savedFontSizeIndex = JE.currentSettings.selectedFontSizePresetIndex ?? 2;
        const savedFontFamilyIndex = JE.currentSettings.selectedFontFamilyPresetIndex ?? 0;

        const stylePreset = JE.subtitlePresets[savedStyleIndex];
        const fontSizePreset = JE.fontSizePresets[savedFontSizeIndex];
        const fontFamilyPreset = JE.fontFamilyPresets[savedFontFamilyIndex];

        if (stylePreset && fontSizePreset && fontFamilyPreset) {
            JE.applySubtitleStyles(
                stylePreset.textColor,
                stylePreset.bgColor,
                fontSizePreset.size,
                fontFamilyPreset.family,
                stylePreset.textShadow
            );
        }
    };

})(window.JellyfinEnhanced);