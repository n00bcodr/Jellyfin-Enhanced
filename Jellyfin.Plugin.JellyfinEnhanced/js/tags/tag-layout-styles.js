// /js/tags/tag-layout-styles.js
// The one stylesheet for every poster tag layout (core/tag-layout.js). It
// keys only off stable hooks — .je-tag-host[data-je-layout], .je-tag-slot
// [data-je-slot] and the caption outlet — so nothing here depends on the
// user's settings and it is injected once, when the first card gets a host.
// Group wrappers keep their own classes and chip styles (each tag module's
// stylesheet); this sheet only places them.
(function (JE) {
    'use strict';

    const SLOT = '.je-tag-host > .je-tag-slot';
    const host = (layout) => `.je-tag-host[data-je-layout="${layout}"] > .je-tag-slot`;
    const INDICATORS = '.cardScalable:has(.countIndicator, .playedIndicator) > .je-tag-host';
    const INDICATOR_OFFSET = 'clamp(20px, 3vw, 30px)';
    const CORNER = `${SLOT}:is([data-je-slot="tl"], [data-je-slot="tr"], [data-je-slot="bl"], [data-je-slot="br"])`;
    /** Groups whose containers had 4px phone edge offsets before layouts existed. */
    const LEGACY_MOBILE_GROUPS = ':is([data-je-group="rating"], [data-je-group="ageRating"], [data-je-group="status"])';
    const LEGACY_EDGE = (slot) => `.je-tag-host[data-je-legacy] > .je-tag-slot[data-je-slot="${slot}"] > ${LEGACY_MOBILE_GROUPS}`;

    /**
     * Build the shared layout stylesheet.
     * @returns {string} CSS text.
     */
    function buildStyles() {
        return `
            ${SLOT} {
                position: absolute;
                display: flex;
                gap: 4px;
                box-sizing: border-box;
                pointer-events: none;
                transition: opacity 0.15s ease;
            }
            ${SLOT} > [data-je-group] {
                position: relative;
                flex-shrink: 0;
                top: auto; right: auto; bottom: auto; left: auto;
                margin: 0;
            }

            /* corners: one stack per corner, first priority at the corner edge */
            ${SLOT}[data-je-slot="tl"], ${SLOT}[data-je-slot="tr"],
            ${SLOT}[data-je-slot="bl"], ${SLOT}[data-je-slot="br"] {
                inset: 6px;
                flex-direction: column;
            }
            ${SLOT}[data-je-slot="tl"] { align-items: flex-start; }
            ${SLOT}[data-je-slot="tr"] { align-items: flex-end; }
            ${SLOT}[data-je-slot="bl"] { flex-direction: column-reverse; align-items: flex-start; }
            ${SLOT}[data-je-slot="br"] { flex-direction: column-reverse; align-items: flex-end; }
            ${SLOT}:is([data-je-slot="tl"], [data-je-slot="bl"]) > [data-je-group] { align-items: flex-start; }
            ${SLOT}:is([data-je-slot="tr"], [data-je-slot="br"]) > [data-je-group] { align-items: flex-end; }
            /* The containers' own size limits were written against the whole card
               (a 100% that a corner slot, inset 6px, makes 12px smaller): restate
               them so narrow cards clip chips exactly where they always did. */
            ${CORNER} > :is(.quality-overlay-container, .rating-overlay-container, .age-rating-overlay-container, .status-overlay-container) {
                max-width: 100%;
            }
            ${CORNER} > :is(.quality-overlay-container, .language-overlay-container, .genre-overlay-container) {
                max-height: calc(90% + 10.8px);
            }
            @media (max-width: 480px) {
                ${CORNER} > :is(.quality-overlay-container, .genre-overlay-container) { max-height: calc(85% + 10.2px); }
            }
            /* Centre anchors only: leave the original four corner rules untouched.
               Measured reserves keep rows between corner stacks and columns
               between the top and bottom stacks, even on episode thumbnails. */
            ${host('corners')}:is([data-je-slot="tc"], [data-je-slot="bc"], [data-je-slot="c"]) {
                left: 50%; transform: translateX(-50%);
                width: max(0px, calc(100% - 2 * var(--je-anchor-reserve, 6px)));
                max-height: calc(100% / 3);
                overflow: hidden;
                flex-direction: row; flex-wrap: wrap;
                justify-content: center; align-items: center; align-content: center;
                gap: 4px;
            }
            ${host('corners')}[data-je-slot="tc"] { top: var(--je-anchor-top, 6px); }
            ${host('corners')}[data-je-slot="bc"] { bottom: var(--je-anchor-bottom, 6px); }
            ${host('corners')}[data-je-slot="c"] { top: 50%; transform: translate(-50%, -50%); max-width: calc(100% - 12px); }
            ${host('corners')}:is([data-je-slot="tc"], [data-je-slot="bc"], [data-je-slot="c"]) > [data-je-group] { display: contents; }
            ${host('corners')}:is([data-je-slot="ml"], [data-je-slot="mr"]) {
                top: 50%; transform: translateY(-50%);
                max-height: max(0px, calc(100% - 2 * var(--je-anchor-reserve, 6px)));
                max-width: calc(50% - 6px);
                flex-direction: column; overflow: hidden;
            }
            ${host('corners')}[data-je-slot="ml"] { left: 6px; align-items: flex-start; }
            ${host('corners')}[data-je-slot="mr"] { right: 6px; align-items: flex-end; }
            ${host('corners')}[data-je-slot="ml"] > [data-je-group] { align-items: flex-start; }
            ${host('corners')}[data-je-slot="mr"] > [data-je-group] { align-items: flex-end; }
            ${host('corners')}:is([data-je-slot="ml"], [data-je-slot="mr"]) > [data-je-group] { display: contents; }
            /* Keep chips at their intrinsic width for measureFit's batched reads.
               Fitting hides oversized chips whole instead of clipping their text. */
            ${host('corners')}:is([data-je-slot="tc"], [data-je-slot="bc"], [data-je-slot="ml"], [data-je-slot="mr"], [data-je-slot="c"]) > [data-je-group] > * { max-width: none; box-sizing: border-box; flex-shrink: 0; }

            /* Jellyfin's played / unplayed-count indicator sits top-right; a card
               with a group set to top-right moves that stack below it. */
            ${INDICATORS}[data-je-indicator-gap] > .je-tag-slot[data-je-slot="tr"],
            .cardIndicators ~ .je-tag-host[data-je-indicator-gap] > .je-tag-slot[data-je-slot="tr"] {
                top: calc(6px + ${INDICATOR_OFFSET});
            }
            /* Settings saved before layouts (data-je-legacy) keep the original
               web geometry: only a container set to exactly top-right clears the
               indicator, each one sitting at least the offset down or right below
               the container before it, whichever is lower. --je-indicator-before
               is how far down the slot a container would sit without the margin:
               0 for the first, measured by the fitting pass for the others (until
               then they just follow the one before, as they do once measured
               whenever that one already cleared the indicator), ... */
            .je-tag-host[data-je-legacy] > .je-tag-slot[data-je-slot="tr"] > [data-je-indicator-gap]:not(:first-child) {
                --je-indicator-before: 9999px;
            }
            ${INDICATORS}[data-je-legacy] > .je-tag-slot[data-je-slot="tr"] > [data-je-indicator-gap],
            .cardIndicators ~ .je-tag-host[data-je-legacy] > .je-tag-slot[data-je-slot="tr"] > [data-je-indicator-gap] {
                margin-top: max(0px, ${INDICATOR_OFFSET} - var(--je-indicator-before, 0px));
            }
            /* ... and on phones the rating, age rating and status containers sit
               4px from the card edges instead of 6px. */
            @media (max-width: 480px) {
                ${LEGACY_EDGE('tl')} { margin-left: -2px; }
                ${LEGACY_EDGE('bl')} { margin-left: -2px; }
                ${LEGACY_EDGE('tr')} { margin-right: -2px; }
                ${LEGACY_EDGE('br')} { margin-right: -2px; }
                ${LEGACY_EDGE('tl')}:first-child, ${LEGACY_EDGE('tr')}:first-child { margin-top: -2px; }
                ${LEGACY_EDGE('bl')}:first-child, ${LEGACY_EDGE('br')}:first-child { margin-bottom: -2px; }
                ${INDICATORS}[data-je-legacy] > .je-tag-slot[data-je-slot="tr"] > ${LEGACY_MOBILE_GROUPS}[data-je-indicator-gap],
                .cardIndicators ~ .je-tag-host[data-je-legacy] > .je-tag-slot[data-je-slot="tr"] > ${LEGACY_MOBILE_GROUPS}[data-je-indicator-gap] {
                    margin-top: max(0px, ${INDICATOR_OFFSET} - 2px - var(--je-indicator-before, 0px));
                }
            }

            /* Genre names float toward the inside of the card. */
            .je-tag-slot:is([data-je-slot="tl"], [data-je-slot="bl"], [data-je-slot="ml"], [data-je-slot="poster"], [data-je-slot="top"]) .genre-tag .genre-text {
                left: calc(100% + 4px);
                right: auto;
            }
            .je-tag-slot:is([data-je-slot="tr"], [data-je-slot="br"], [data-je-slot="mr"], [data-je-slot="corner"]) .genre-tag .genre-text {
                right: calc(100% + 4px);
                left: auto;
            }

            /* bands: first top group left, the rest right; whole groups wrap
               when long milestone labels and age ratings cannot share a row. */
            ${host('bands')}[data-je-slot="top"] {
                top: 0; left: 0; right: 0;
                padding: 6px 6px 16px;
                flex-direction: row;
                flex-wrap: wrap;
                align-items: flex-start;
                background: linear-gradient(to bottom, rgba(0, 0, 0, 0.62), rgba(0, 0, 0, 0));
            }
            ${host('bands')}[data-je-slot="top"] > [data-je-group] {
                flex-direction: row;
                flex-wrap: wrap;
                justify-content: flex-end;
                align-items: flex-start;
                gap: 3px;
                flex-shrink: 0;
                min-width: 0;
                max-width: 100%;
            }
            ${host('bands')}[data-je-slot="top"] > [data-je-group] > * {
                box-sizing: border-box;
                min-width: 0;
                max-width: 100%;
            }
            ${host('bands')}[data-je-slot="top"] > [data-je-group] + [data-je-group] {
                margin-left: auto;
            }
            ${host('bands')}[data-je-slot="top"] > [data-je-group]:first-child {
                justify-content: flex-start;
                margin-right: auto;
            }
            ${INDICATORS}[data-je-layout="bands"] > .je-tag-slot[data-je-slot="top"] {
                padding-right: calc(10px + ${INDICATOR_OFFSET});
            }
            /* At most two rows; the fitting pass hides the rest behind "+N", and
               cards under 160px wide get compact labels. */
            ${host('bands')}[data-je-slot="bottom"] {
                bottom: 0; left: 0; right: 0;
                padding: 16px 6px 6px;
                flex-direction: row;
                flex-wrap: wrap;
                align-items: flex-end;
                gap: 3px;
                background: linear-gradient(to top, rgba(0, 0, 0, 0.68), rgba(0, 0, 0, 0));
            }

            /* Flattened slots: chips of every group flow in one row. */
            ${host('bands')}[data-je-slot="bottom"] > [data-je-group],
            ${SLOT}[data-je-slot="hover"] > [data-je-group],
            .je-tag-caption > [data-je-group] {
                display: contents;
            }
            /* Genre names: on the poster they float out on hover unless Hide Tags
               on Hover is on (it fades the poster slots instead); the caption
               strip, which stays readable, shows them on hover either way; the
               summary / minimal reveal shows them inline (below). */
            ${host('bands')}[data-je-slot="top"] > [data-je-group]:not(:first-child) .genre-tag .genre-text,
            ${host('bands')}[data-je-slot="bottom"] .genre-tag .genre-text {
                right: calc(100% + 4px);
                left: auto;
            }
            .je-tag-caption .genre-tag .genre-text {
                left: calc(100% + 4px);
                right: auto;
            }
            body.je-tags-hide-on-hover .je-tag-host > .je-tag-slot:not([data-je-slot="hover"]) .genre-text {
                display: none;
            }

            /* caption: a small poster stack, and a strip below the image */
            ${SLOT}[data-je-slot="poster"] {
                top: 6px; left: 6px;
                max-width: calc(100% - 12px);
                flex-direction: column;
                align-items: flex-start;
            }
            ${SLOT}[data-je-slot="poster"] > [data-je-group] { align-items: flex-start; }
            .je-tag-caption {
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                align-content: flex-start;
                gap: 3px;
                box-sizing: content-box;
                /* Fixed two-row budget, reserved before the chips arrive, so every
                   card in a row keeps the same height: the fitting pass hides chips
                   that would wrap to a third row, lowest priority first, behind a
                   "+N" chip. */
                height: 43px;
                margin: 5px 0 1px;
                padding: 0 2px;
                overflow: hidden;
                pointer-events: none;
                container-type: inline-size;
            }
            .je-tag-caption .quality-overlay-label,
            .je-tag-caption .rating-tag,
            .je-tag-caption .age-rating-tag,
            .je-tag-caption .status-tag {
                font-size: clamp(9px, 6.4cqw, 11.5px);
                line-height: 1.15;
                padding: 2px 5px;
                border-radius: 3px;
                box-shadow: none;
                gap: 3px;
            }
            .je-tag-caption .rating-star-icon { font-size: clamp(9px, 6.8cqw, 12px) !important; }
            .je-tag-caption .rating-tomato-icon { width: clamp(9px, 6.8cqw, 12px); height: clamp(9px, 6.8cqw, 12px); }
            .je-tag-caption .language-flag { width: 20px; box-shadow: none; }
            .je-tag-caption .genre-tag { width: 20px; height: 20px; min-width: 20px; box-shadow: none; }
            .je-tag-caption .genre-tag .je-msym-outlined { font-size: 13px; }

            /* "+N": the chips a wrapping slot had no room for. It never takes a
               pointer or focus; the card link's description and the tooltip
               below name them. */
            .je-tag-more {
                display: inline-flex;
                align-items: center;
                flex-shrink: 0;
                box-sizing: border-box;
                padding: 2px 5px;
                border-radius: 3px;
                border: 1px solid rgba(255, 255, 255, 0.22);
                background: rgba(0, 0, 0, 0.72);
                color: #fff;
                font-size: 11px;
                font-weight: 700;
                line-height: 1.15;
                white-space: nowrap;
                pointer-events: none;
            }
            .je-tag-caption .je-tag-more {
                font-size: clamp(9px, 6.4cqw, 11.5px);
                background: rgba(255, 255, 255, 0.12);
            }
            /* The names behind a card's "+N" chips, at the top of the image while
               the card is hovered or focused (never interactive). */
            .je-tag-host > .je-tag-more-tip {
                position: absolute;
                top: 6px;
                left: 50%;
                transform: translateX(-50%);
                width: max-content;
                max-width: calc(100% - 12px);
                box-sizing: border-box;
                padding: 3px 7px;
                border-radius: 4px;
                background: rgba(12, 12, 12, 0.88);
                border: 1px solid rgba(255, 255, 255, 0.14);
                color: #fff;
                font-size: 11px;
                font-weight: 600;
                line-height: 1.25;
                text-align: center;
                overflow-wrap: anywhere;
                pointer-events: none;
                opacity: 0;
                visibility: hidden;
                transition: opacity 0.15s ease, visibility 0.15s;
            }
            :is(.card, .listItem):is(:hover, :focus-within) .je-tag-host > .je-tag-more-tip {
                opacity: 1;
                visibility: visible;
            }

            /* summary: one fact pill; full chips on hover / focus */
            ${SLOT}[data-je-slot="pill"] {
                left: 0; right: 0; bottom: 8px;
                justify-content: center;
            }
            /* One text run, so the ellipsis can apply; facts that would not fit
               are dropped whole by the fitting pass (data-je-overflow). */
            .je-tag-pill {
                display: block;
                min-width: 0;
                max-width: calc(100% - 16px);
                box-sizing: border-box;
                padding: 3px 10px;
                border-radius: 999px;
                background: rgba(12, 12, 12, 0.8);
                border: 1px solid rgba(255, 255, 255, 0.14);
                box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35);
                color: #fff;
                font-size: 12px;
                font-weight: 600;
                line-height: 1.2;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            @supports (container-type: inline-size) {
                html:not(.layout-mobile) .je-tag-pill { font-size: clamp(9px, 6.6cqw, 12.5px); padding: clamp(2px, 1.6cqw, 3px) clamp(6px, 5cqw, 10px); }
            }
            .je-tag-pill-fact { display: inline; }
            .je-tag-pill-glyph { color: #ffc107; margin-right: 0.2em; }
            .je-tag-pill-sep { opacity: 0.55; padding: 0 0.35em; }
            .je-tag-pill-flag { display: inline; width: 1.45em; height: auto; border-radius: 2px; vertical-align: -0.2em; }
            .je-tag-host [data-je-overflow], .je-tag-caption [data-je-overflow] { display: none !important; }

            /* The reveal keeps to the bottom of the card (two rows of compact
               chips, then "+N"; the fitting pass keeps fewer whole rows when 40%
               of a short card has room for less), clear of the centre play
               button; Jellyfin's overlay buttons stay above it and clickable. */
            ${SLOT}[data-je-slot="hover"] {
                left: 0; right: 0; bottom: 0;
                max-height: 40%;
                overflow: hidden;
                padding: 18px 6px 6px;
                flex-direction: row;
                flex-wrap: wrap;
                align-items: flex-end;
                align-content: flex-end;
                gap: 3px;
                background: linear-gradient(to top, rgba(0, 0, 0, 0.86), rgba(0, 0, 0, 0.55) 62%, rgba(0, 0, 0, 0));
                opacity: 0;
            }
            /* Cards, and list rows (a season's episodes) whose image holds the tags. */
            :is(.card, .listItem):is(:hover, :focus-within) .je-tag-host > .je-tag-slot[data-je-slot="hover"] { opacity: 1; }
            /* The summaries give way to the reveal, unless it had no room for a row. */
            :is(.card, .listItem):is(:hover, :focus-within) .je-tag-host:not(:has(> .je-tag-slot[data-je-slot="hover"][data-je-overflow])) > .je-tag-slot:is([data-je-slot="pill"], [data-je-slot="dots"], [data-je-slot="corner"]) { opacity: 0; }
            /* The hover state on demand (the settings panel's preview card). */
            .je-tag-reveal .je-tag-host > .je-tag-slot[data-je-slot="hover"] { opacity: 1; }
            .je-tag-reveal .je-tag-host > .je-tag-slot:is([data-je-slot="pill"], [data-je-slot="dots"], [data-je-slot="corner"]) { opacity: 0; }
            html .je-tag-host > .je-tag-slot[data-je-slot="hover"] .genre-tag {
                width: auto; min-width: 0; height: auto;
                padding: 2px 7px 2px 4px;
                gap: 3px;
                border-radius: 999px;
            }
            html .je-tag-host > .je-tag-slot[data-je-slot="hover"] .genre-tag .je-msym-outlined { font-size: 1.05em; }
            .je-tag-slot[data-je-slot="hover"] .genre-tag .genre-text {
                position: static;
                opacity: 1;
                transform: none;
                padding: 0;
                background: none;
                font-size: 11px;
            }

            /* minimal: status top, quality dots, rating corner */
            ${host('minimal')}[data-je-slot="top"] {
                top: 6px; left: 6px;
                max-width: calc(100% - 12px);
                flex-direction: column;
                align-items: flex-start;
            }
            ${SLOT}[data-je-slot="dots"] { left: 7px; bottom: 7px; }
            .je-tag-dots {
                display: flex;
                align-items: center;
                gap: 4px;
                padding: 4px 6px;
                border-radius: 999px;
                background: rgba(0, 0, 0, 0.55);
            }
            .je-tag-dot {
                width: 8px; height: 8px;
                border-radius: 50%;
                box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
                background: #546e7a;
            }
            .je-tag-dot[data-je-dot="resolution"] { background: #1e88e5; }
            .je-tag-dot[data-je-dot="range"] { background: #ef6c00; }
            .je-tag-dot[data-je-dot="audio"] { background: #2e7d32; }
            .je-tag-dot[data-je-dot="codec"] { background: #546e7a; }
            ${SLOT}[data-je-slot="corner"] {
                right: 6px; bottom: 6px;
                flex-direction: column-reverse;
                align-items: flex-end;
            }
            ${SLOT}[data-je-slot="corner"] > [data-je-group] { align-items: flex-end; gap: 2px; }
            html .je-tag-host > .je-tag-slot[data-je-slot="corner"] :is(.rating-tag, .quality-overlay-label, .age-rating-tag, .status-tag) {
                font-size: 11px;
                padding: 2px 5px;
                gap: 3px;
            }
            html .je-tag-host > .je-tag-slot[data-je-slot="corner"] .rating-star-icon { font-size: 11px !important; }

            /* Hide Tags on Hover: everything but the summary / minimal reveal. */
            body.je-tags-hide-on-hover .card:hover .je-tag-host > .je-tag-slot:not([data-je-slot="hover"]),
            body.je-tags-hide-on-hover .card:hover .je-tag-host:not([data-je-layout="summary"], [data-je-layout="minimal"]) > .je-tag-more-tip {
                opacity: 0 !important;
            }

            @media (prefers-reduced-motion: reduce) {
                ${SLOT}, .je-tag-host > .je-tag-more-tip { transition: none; }
            }
        `;
    }

    if (JE.core?.tagLayout) JE.core.tagLayout.buildStyles = buildStyles;

})(window.JellyfinEnhanced);
