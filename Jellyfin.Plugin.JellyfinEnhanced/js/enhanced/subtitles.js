/**
 * @file Manages subtitle customization, including presets and style application.
 */
(function(JE) {
    'use strict';

    let subtitleObserver = null;
    let currentSubtitleStyle = {};

    /**
     * Preset styles for subtitles.
     * @type {Array<object>}
     */
    JE.subtitlePresets = [
        { name: "Clean White", textColor: "#FFFFFFFF", bgColor: "transparent", textShadow: "0 0 4px #000, 0 0 8px #000, 1px 1px 2px #000", previewText: "Aa" },
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
     * Applies subtitle position to the .videoSubtitles container element.
     * xPct and yPct are percentages (0-100) representing the center anchor point
     * of the subtitle text within the video area.
     * Using top+transform(translate -50%,-50%) means the anchor is always the
     * center of the text, so font size changes don't shift the visual position.
     * When disableCustomSubtitleStyles is true, removes JE position overrides entirely.
     */
    function applySubtitlePosition() {
        const containers = document.querySelectorAll('.videoSubtitles');
        if (!containers.length) return;

        const disabled = JE.currentSettings.disableCustomSubtitleStyles;

        containers.forEach(container => {
            if (disabled) {
                // Remove JE overrides — let vanilla Jellyfin control position
                container.style.removeProperty('position');
                container.style.removeProperty('left');
                container.style.removeProperty('top');
                container.style.removeProperty('bottom');
                container.style.removeProperty('transform');
                container.style.removeProperty('width');
                container.style.removeProperty('text-align');
            } else {
                const xPct = JE.currentSettings.subtitleHorizontalPosition ?? 50;
                const yPct = JE.currentSettings.subtitleVerticalPosition ?? 85;
                // Position the container so its center sits at (xPct, yPct) of the video
                container.style.setProperty('position', 'absolute', 'important');
                container.style.setProperty('left', `${xPct}%`, 'important');
                container.style.setProperty('top', `${yPct}%`, 'important');
                container.style.setProperty('bottom', 'auto', 'important');
                container.style.setProperty('transform', 'translate(-50%, -50%)', 'important');
                container.style.setProperty('text-align', 'center', 'important');
            }
        });
    }

    /**
     * Removes all JE-injected subtitle styles from existing elements.
     * Called when the user disables custom subtitle styles.
     */
    function removeInjectedStyles() {
        document.querySelectorAll('.videoSubtitlesInner').forEach(el => {
            el.style.removeProperty('background-color');
            el.style.removeProperty('color');
            el.style.removeProperty('font-size');
            el.style.removeProperty('font-family');
            el.style.removeProperty('text-shadow');
            el.style.removeProperty('border-radius');
            el.style.removeProperty('padding');
            el.style.removeProperty('font-weight');
            el.style.removeProperty('font-style');
            el.style.removeProperty('font-variant');
        });
        document.querySelectorAll('.videoSubtitles').forEach(container => {
            container.style.removeProperty('position');
            container.style.removeProperty('left');
            container.style.removeProperty('top');
            container.style.removeProperty('bottom');
            container.style.removeProperty('transform');
            container.style.removeProperty('width');
            container.style.removeProperty('max-width');
            container.style.removeProperty('text-align');
        });
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
                        if (node.classList.contains('videoSubtitlesInner')) {
                            forceApplyInlineStyles(node);
                        } else if (node.querySelector) {
                            const inner = node.querySelector('.videoSubtitlesInner');
                            if (inner) forceApplyInlineStyles(inner);
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
        document.querySelectorAll('.videoSubtitlesInner').forEach(forceApplyInlineStyles);

        // Apply position to the container
        applySubtitlePosition();

        // Start the observer to catch any new subtitle elements
        startSubtitleObserver();

        // Also apply styles to the legacy ::cue for Jellyfin versions <10.11
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
                console.error("🪼 Jellyfin Enhanced: Failed to apply legacy ::cue styles:", e);
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
        const textShadow = bgColor === 'transparent' || bgColor === '#00000000'
            ? '0 0 4px #000, 0 0 8px #000, 1px 1px 2px #000'
            : 'none';

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