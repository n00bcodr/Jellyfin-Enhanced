// /js/tags/tag-layout-styles.js
// The one stylesheet for every poster tag layout (core/tag-layout.js). It
// keys only off stable hooks — .je-tag-host[data-je-layout], .je-tag-slot
// [data-je-slot] and the caption outlet — so nothing here depends on the
// user's settings and it is injected once, when the first card gets a host.
// Group wrappers keep their own classes and chip styles (each tag module's
// stylesheet); this sheet only places them.
(function (JE) {
    'use strict';

    // Reveals keep the existing library interaction and add the preview hook.
    const ACTIVE_CARD = ':is(:is(.card, .listItem):is(:hover, :focus-within), .je-tag-reveal)';
    const HIDE_ACTIVE = 'body.je-tags-hide-on-hover .card:hover';
    const PREVIEW_HIDE = ':is(.je-mtp, .je-tie-side)[data-je-hide-on-hover="true"] .je-tag-reveal';
    const SLOT = '.je-tag-host > .je-tag-slot';
    const host = (layout) => `.je-tag-host[data-je-layout="${layout}"] > .je-tag-slot`;
    const INDICATORS = '.cardScalable:has(.countIndicator, .playedIndicator) > .je-tag-host';
    const LEGACY_INDICATOR_OFFSET = 'clamp(20px, 3vw, 30px)';
    const INDICATOR_OFFSET = 'calc(clamp(20px, 3vw, 30px) * var(--je-tag-scale, 1))';
    const CORNER = `${SLOT}:is([data-je-slot="tl"], [data-je-slot="tr"], [data-je-slot="bl"], [data-je-slot="br"])`;
    /** Groups whose containers had 4px phone edge offsets before layouts existed. */
    const LEGACY_MOBILE_GROUPS = ':is([data-je-group="rating"], [data-je-group="ageRating"], [data-je-group="status"])';
    const LEGACY_EDGE = (slot) => `.je-tag-host[data-je-legacy] > .je-tag-slot[data-je-slot="${slot}"] > ${LEGACY_MOBILE_GROUPS}`;
    /** Corners slots of a card with a non-default edge spacing (data-je-edge, set by core/tag-layout.js). */
    const EDGE = '.je-tag-host[data-je-layout="corners"][data-je-edge] > .je-tag-slot';
    const FLUSH = '.je-tag-host[data-je-layout="corners"][data-je-edge="flush"] > .je-tag-slot';
    /** Chips with a box of their own (not the genre circle or a flag image). */
    const BOX_CHIP = ':is(.quality-overlay-label, .rating-tag, .age-rating-tag, .status-tag, .awards-tag, .je-logo-chip, .custom-tag, .language-chip)';

    /** Transparent links pass sizing and Flush paint through to the chip. */
    const CHIP_LINK = ':is(.awards-link, .language-link)';

    /** Minimal's and Caption's column stacks: their oversized chips are fitted (core/tag-layout.js STACK_SLOTS). */
    const STACK = `:is(${SLOT}[data-je-slot="poster"], ${SLOT}[data-je-slot="corner"], .je-tag-host[data-je-layout="minimal"] > .je-tag-slot[data-je-slot="top"])`;

    /** Group chips and the slot's direct overflow chip share Flush paint. */
    const FLUSH_CHIP = `:is([data-je-group] > ${BOX_CHIP}, [data-je-group] > ${CHIP_LINK} > ${BOX_CHIP}, .je-tag-more)`;

    /**
     * Flush paint rules, repeated in scoped Tag Styles so their !important
     * colours cannot restore a touching border in the admin preview.
     * @param {string} [scope] Validated Tag Styles scope prefix.
     * @returns {string} CSS text.
     */
    function buildFlushStyles(scope = '') {
        const F = scope ? `${scope} ${FLUSH}` : FLUSH;
        return `
            /* Flush removes the visible edge seam while preserving the chip's
               border-box metrics. Clip only the touching sides of its shadow;
               the inward sides keep the group's original border and shadow. */
            ${F} ${FLUSH_CHIP} {
                --je-flush-clip-top: -12px; --je-flush-clip-right: -12px;
                --je-flush-clip-bottom: -12px; --je-flush-clip-left: -12px;
                clip-path: inset(var(--je-flush-clip-top) var(--je-flush-clip-right) var(--je-flush-clip-bottom) var(--je-flush-clip-left));
            }
            ${F}:is([data-je-slot="tl"], [data-je-slot="bl"], [data-je-slot="ml"]) ${FLUSH_CHIP} {
                border-left-color: transparent !important; --je-flush-clip-left: 0px;
                --je-flush-ring-left: 0px; --je-flush-ring-content: ''; --je-tag-ring-outline: transparent;
                border-top-left-radius: 0; border-bottom-left-radius: 0;
            }
            ${F}:is([data-je-slot="tr"], [data-je-slot="br"], [data-je-slot="mr"]) ${FLUSH_CHIP} {
                border-right-color: transparent !important; --je-flush-clip-right: 0px;
                --je-flush-ring-right: 0px; --je-flush-ring-content: ''; --je-tag-ring-outline: transparent;
                border-top-right-radius: 0; border-bottom-right-radius: 0;
            }
            ${F}:is([data-je-slot="tl"], [data-je-slot="tr"]):not(.cardScalable:has(.countIndicator, .playedIndicator) > .je-tag-host[data-je-indicator-gap] > [data-je-slot="tr"], .cardIndicators ~ .je-tag-host[data-je-indicator-gap] > [data-je-slot="tr"]) > [data-je-group]:first-child > ${BOX_CHIP}:first-child,
            ${F}:is([data-je-slot="tl"], [data-je-slot="tr"]):not(.cardScalable:has(.countIndicator, .playedIndicator) > .je-tag-host[data-je-indicator-gap] > [data-je-slot="tr"], .cardIndicators ~ .je-tag-host[data-je-indicator-gap] > [data-je-slot="tr"]) > [data-je-group]:first-child > ${CHIP_LINK}:first-child > ${BOX_CHIP},
            ${F}[data-je-slot="tc"] ${FLUSH_CHIP}[data-je-flush-top],
            ${F}[data-je-slot="tc"] ${CHIP_LINK}[data-je-flush-top] > ${BOX_CHIP},
            ${F}:is([data-je-slot="tl"], [data-je-slot="tr"]) > .je-tag-more:only-child {
                border-top-color: transparent !important; --je-flush-clip-top: 0px;
                --je-flush-ring-top: 0px; --je-flush-ring-content: ''; --je-tag-ring-outline: transparent;
                border-top-left-radius: 0; border-top-right-radius: 0;
            }
            ${F}:is([data-je-slot="bl"], [data-je-slot="br"]) > [data-je-group]:first-child > ${BOX_CHIP}:last-child,
            ${F}:is([data-je-slot="bl"], [data-je-slot="br"]) > [data-je-group]:first-child > ${CHIP_LINK}:last-child > ${BOX_CHIP},
            ${F}[data-je-slot="bc"] ${FLUSH_CHIP}[data-je-flush-bottom],
            ${F}[data-je-slot="bc"] ${CHIP_LINK}[data-je-flush-bottom] > ${BOX_CHIP},
            ${F}:is([data-je-slot="bl"], [data-je-slot="br"]) > .je-tag-more:only-child {
                border-bottom-color: transparent !important; --je-flush-clip-bottom: 0px;
                --je-flush-ring-bottom: 0px; --je-flush-ring-content: ''; --je-tag-ring-outline: transparent;
                border-bottom-left-radius: 0; border-bottom-right-radius: 0;
            }
            /* Ringed chips keep their inner -1px outline off an edge. At an
               edge, paint the same inner ring with independent border sides;
               the chip's background, box metrics and outer shadow stay intact. */
            ${F} :is(.rating-tag, .awards-tag, .language-chip) { position: relative; }
            ${F} :is(.rating-tag, .awards-tag, .language-chip)::after {
                content: var(--je-flush-ring-content, none);
                position: absolute; inset: 0; box-sizing: border-box;
                border-radius: inherit; pointer-events: none;
                border: 1px solid var(--je-tag-ring-color, transparent);
                border-width: var(--je-flush-ring-top, 1px) var(--je-flush-ring-right, 1px) var(--je-flush-ring-bottom, 1px) var(--je-flush-ring-left, 1px);
            }
        `;
    }

    /**
     * Build the shared layout stylesheet.
     * @returns {string} CSS text.
     */
    function buildStyles() {
        const css = `
            ${SLOT} {
                position: absolute;
                display: flex;
                gap: calc(4px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
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
            /* The containers' own width limits were written against the whole card.
               In a slot that 100% is the slot: a corner slot, inset 6px, is the old
               limit (narrow cards clip chips exactly where they always did), and a
               slot sized to its chips must never be 12px narrower than they are. */
            ${SLOT} > :is(.quality-overlay-container, .rating-overlay-container, .age-rating-overlay-container, .status-overlay-container, .logo-overlay-container) {
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
                gap: calc(4px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
            }
            ${host('corners')}[data-je-slot="tc"] { top: var(--je-anchor-top, 6px); }
            ${host('corners')}[data-je-slot="bc"] { bottom: var(--je-anchor-bottom, 6px); }
            ${host('corners')}[data-je-slot="c"] { top: 50%; transform: translate(-50%, -50%); max-width: calc(100% - 12px); }
            ${host('corners')}:is([data-je-slot="tc"], [data-je-slot="bc"], [data-je-slot="c"]) > [data-je-group] { display: contents; }
            ${host('corners')}:is([data-je-slot="ml"], [data-je-slot="mr"]) {
                top: 50%; transform: translateY(-50%);
                max-height: max(0px, calc(100% - 2 * var(--je-anchor-reserve, 6px)));
                max-width: var(--je-anchor-width, calc(100% - 12px));
                /* Fitting hides excess chips explicitly; hover names must be
                   able to extend from the icon toward the card's centre. */
                flex-direction: column; overflow: visible;
            }
            ${host('corners')}[data-je-slot="ml"] { left: 6px; align-items: flex-start; }
            ${host('corners')}[data-je-slot="mr"] { right: 6px; align-items: flex-end; }
            ${host('corners')}[data-je-slot="ml"] > [data-je-group] { align-items: flex-start; }
            ${host('corners')}[data-je-slot="mr"] > [data-je-group] { align-items: flex-end; }
            ${host('corners')}:is([data-je-slot="ml"], [data-je-slot="mr"]) > [data-je-group] { display: contents; }
            /* Measure intrinsic chip widths before constraining the first label. */
            ${host('corners')}:is([data-je-slot="tc"], [data-je-slot="bc"], [data-je-slot="ml"], [data-je-slot="mr"], [data-je-slot="c"]) > [data-je-group] > * { max-width: none; box-sizing: border-box; flex-shrink: 0; }

            ${host('corners')}:is([data-je-slot="ml"], [data-je-slot="mr"]) .genre-text {
                box-sizing: border-box;
                max-width: max(0px, calc(var(--je-anchor-width, 0px) - 100% - 6px));
                overflow: hidden; text-overflow: ellipsis;
            }
            ${host('corners')} > [data-je-group] > [data-je-fit-width] {
                max-width: var(--je-chip-fit-width); min-width: 0;
                overflow: visible;
            }
            /* Truncate only the shrinking label, retaining flex height and
               icon alignment as measured before the constraint was applied. */
            ${host('corners')} [data-je-fit-width] :is(.je-tag-fit-text, .custom-tag-text, .rating-text),
            ${host('corners')} [data-je-fit-width].awards-tag > span:last-child {
                display: block; min-width: 0;
                overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            }

            /* A link is transparent to chip sizing and paint: clip the label,
               not the rounded chip or its inward border/ring/shadow. */
            ${host('corners')} > [data-je-group] > ${CHIP_LINK}[data-je-fit-width] {
                display: inline-flex; overflow: visible;
            }
            ${host('corners')} ${CHIP_LINK}[data-je-fit-width] > ${BOX_CHIP} {
                max-width: var(--je-chip-fit-width); min-width: 0; box-sizing: border-box;
            }
            ${host('corners')} ${CHIP_LINK}[data-je-fit-width] > .awards-tag > span:last-child,
            ${host('corners')} ${CHIP_LINK}[data-je-fit-width] > .language-chip > .je-tag-fit-text {
                min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            }
            /* A stack chip wider than the card keeps its whole box at the slot's
               inset and ellipsizes its label the same way. */
            ${STACK} > [data-je-group] > [data-je-fit-width],
            ${STACK} ${CHIP_LINK}[data-je-fit-width] > ${BOX_CHIP} {
                max-width: var(--je-chip-fit-width); min-width: 0; box-sizing: border-box;
            }
            ${STACK} > [data-je-group] > [data-je-fit-width] { overflow: visible; }
            ${STACK} > [data-je-group] > ${CHIP_LINK}[data-je-fit-width] { display: inline-flex; }
            ${STACK} [data-je-fit-width] :is(.je-tag-fit-text, .custom-tag-text, .rating-text),
            ${STACK} [data-je-fit-width].awards-tag > span:last-child,
            ${STACK} ${CHIP_LINK}[data-je-fit-width] > .awards-tag > span:last-child {
                display: block; min-width: 0;
                overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            }

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
                margin-top: max(0px, ${LEGACY_INDICATOR_OFFSET} - var(--je-indicator-before, 0px));
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
                    margin-top: max(0px, ${LEGACY_INDICATOR_OFFSET} - 2px - var(--je-indicator-before, 0px));
                }
            }

            /* Edge spacing (corners only): the default 6px inset above stays as it
               is; tight (3px) and flush (0px) restate every anchor's offset, the
               corner containers' size limits, the centre budgets' defaults and the
               indicator gap with the card's own inset. */
            .je-tag-host[data-je-layout="corners"][data-je-edge="tight"] { --je-edge: 3px; }
            /* Flush chips touch the card edge: the host clips to the artwork's
               rounded corners (radius measured by the fitting pass), so a chip in a
               corner takes the card's curve and none paints outside the card. */
            .je-tag-host[data-je-layout="corners"][data-je-edge="flush"] {
                --je-edge: 0px;
                overflow: hidden;
                border-radius: var(--je-card-radius, 0px);
            }
            ${EDGE}:is([data-je-slot="tl"], [data-je-slot="tr"], [data-je-slot="bl"], [data-je-slot="br"]) { inset: var(--je-edge); }
            ${EDGE}:is([data-je-slot="tl"], [data-je-slot="tr"], [data-je-slot="bl"], [data-je-slot="br"]) > :is(.quality-overlay-container, .language-overlay-container, .genre-overlay-container) {
                max-height: calc(90% + 1.8 * var(--je-edge));
            }
            @media (max-width: 480px) {
                ${EDGE}:is([data-je-slot="tl"], [data-je-slot="tr"], [data-je-slot="bl"], [data-je-slot="br"]) > :is(.quality-overlay-container, .genre-overlay-container) { max-height: calc(85% + 1.7 * var(--je-edge)); }
            }
            ${EDGE}:is([data-je-slot="tc"], [data-je-slot="bc"], [data-je-slot="c"]) {
                width: max(0px, calc(100% - 2 * var(--je-anchor-reserve, var(--je-edge))));
            }
            ${EDGE}[data-je-slot="tc"] { top: var(--je-anchor-top, var(--je-edge)); }
            ${EDGE}[data-je-slot="bc"] { bottom: var(--je-anchor-bottom, var(--je-edge)); }
            ${EDGE}[data-je-slot="c"] { max-width: calc(100% - 2 * var(--je-edge)); }
            ${EDGE}:is([data-je-slot="ml"], [data-je-slot="mr"]) {
                max-height: max(0px, calc(100% - 2 * var(--je-anchor-reserve, var(--je-edge))));
                max-width: calc(50% - var(--je-edge));
            }
            ${EDGE}[data-je-slot="ml"] { left: var(--je-edge); }
            ${EDGE}[data-je-slot="mr"] { right: var(--je-edge); }
            ${INDICATORS}[data-je-indicator-gap][data-je-edge] > .je-tag-slot[data-je-slot="tr"],
            .cardIndicators ~ .je-tag-host[data-je-indicator-gap][data-je-edge] > .je-tag-slot[data-je-slot="tr"] {
                top: calc(var(--je-edge) + ${INDICATOR_OFFSET});
            }
            ${buildFlushStyles()}
            ${FLUSH}[data-je-slot="tc"] { top: var(--je-anchor-top, 0px); align-items: flex-start; overflow: visible; }
            ${FLUSH}[data-je-slot="bc"] { bottom: var(--je-anchor-bottom, 0px); align-items: flex-end; overflow: visible; }

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
                gap: calc(3px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
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
                gap: calc(3px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
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
            .je-mtp[data-je-hide-on-hover="true"] .je-mtp-card .je-tag-host > .je-tag-slot:not([data-je-slot="hover"]) .genre-text {
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
                gap: calc(3px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                box-sizing: content-box;
                /* Fixed two-row budget, reserved before the chips arrive, so every
                   card in a row keeps the same height: the fitting pass hides chips
                   that would wrap to a third row, lowest priority first, behind a
                   "+N" chip. */
                height: calc((40px + 3px * var(--je-tag-gap, 1)) * var(--je-tag-scale, 1));
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
                font-size: calc(clamp(9px, 6.4cqw, 11.5px) * var(--je-tag-scale, 1));
                line-height: 1.15;
                padding: calc(2px * var(--je-tag-scale, 1)) calc(5px * var(--je-tag-scale, 1));
                border-radius: 3px;
                box-shadow: none;
                gap: calc(3px * var(--je-tag-scale, 1));
            }
            /* Language chips size themselves by the viewport (and the phone layout);
               in the strip they take the same box as its other chips, so two rows
               fit its reserved height. */
            html .je-tag-caption .language-chip {
                font-size: calc(clamp(9px, 6.4cqw, 11.5px) * var(--je-tag-scale, 1));
                line-height: 1.15;
                padding: calc(2px * var(--je-tag-scale, 1)) calc(5px * var(--je-tag-scale, 1));
                border-radius: 3px;
                box-shadow: none;
            }
            .je-tag-caption .rating-star-icon { font-size: calc(clamp(9px, 6.8cqw, 12px) * var(--je-tag-scale, 1)) !important; }
            .je-tag-caption .rating-tomato-icon { width: calc(clamp(9px, 6.8cqw, 12px) * var(--je-tag-scale, 1)); height: calc(clamp(9px, 6.8cqw, 12px) * var(--je-tag-scale, 1)); }
            .je-tag-caption .language-flag { width: calc(20px * var(--je-tag-scale, 1)); box-shadow: none; }
            .je-tag-caption .genre-tag { width: calc(20px * var(--je-tag-scale, 1)); height: calc(20px * var(--je-tag-scale, 1)); min-width: calc(20px * var(--je-tag-scale, 1)); box-shadow: none; }
            .je-tag-caption .genre-tag .je-msym-outlined { font-size: calc(13px * var(--je-tag-scale, 1)); }

            /* "+N": the chips a wrapping slot had no room for. It never takes a
               pointer or focus; the card link's description and the tooltip
               below name them. */
            .je-tag-more {
                display: inline-flex;
                align-items: center;
                flex-shrink: 0;
                box-sizing: border-box;
                padding: calc(2px * var(--je-tag-scale, 1)) calc(5px * var(--je-tag-scale, 1));
                border-radius: 3px;
                border: 1px solid rgba(255, 255, 255, 0.22);
                background: rgba(0, 0, 0, 0.72);
                color: #fff;
                font-size: calc(11px * var(--je-tag-scale, 1));
                font-weight: 700;
                line-height: 1.15;
                white-space: nowrap;
                pointer-events: none;
            }
            .je-tag-caption .je-tag-more {
                font-size: calc(clamp(9px, 6.4cqw, 11.5px) * var(--je-tag-scale, 1));
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
                font-size: calc(11px * var(--je-tag-scale, 1));
                font-weight: 600;
                line-height: 1.25;
                text-align: center;
                overflow-wrap: anywhere;
                pointer-events: none;
                opacity: 0;
                visibility: hidden;
                transition: opacity 0.15s ease, visibility 0.15s;
            }
            ${ACTIVE_CARD} .je-tag-host > .je-tag-more-tip {
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
                padding: calc(3px * var(--je-tag-scale, 1)) calc(10px * var(--je-tag-scale, 1));
                border-radius: 999px;
                background: rgba(12, 12, 12, 0.8);
                border: 1px solid rgba(255, 255, 255, 0.14);
                box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35);
                color: #fff;
                font-size: calc(12px * var(--je-tag-scale, 1));
                font-weight: 600;
                line-height: 1.2;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            @supports (container-type: inline-size) {
                html:not(.layout-mobile) .je-tag-pill { font-size: calc(clamp(9px, 6.6cqw, 12.5px) * var(--je-tag-scale, 1)); padding: calc(clamp(2px, 1.6cqw, 3px) * var(--je-tag-scale, 1)) calc(clamp(6px, 5cqw, 10px) * var(--je-tag-scale, 1)); }
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
                gap: calc(3px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                background: linear-gradient(to top, rgba(0, 0, 0, 0.86), rgba(0, 0, 0, 0.55) 62%, rgba(0, 0, 0, 0));
                opacity: 0;
            }
            /* Cards, and list rows (a season's episodes) whose image holds the tags. */
            ${ACTIVE_CARD} .je-tag-host > .je-tag-slot[data-je-slot="hover"] { opacity: 1; }
            /* The summaries give way to the reveal, unless it had no room for a row. */
            ${ACTIVE_CARD} .je-tag-host:not(:has(> .je-tag-slot[data-je-slot="hover"][data-je-overflow])) > .je-tag-slot:is([data-je-slot="pill"], [data-je-slot="dots"], [data-je-slot="corner"]) { opacity: 0; }
            /* Hidden linked summaries must not intercept the revealed chips, regardless of their groups. */
            ${ACTIVE_CARD} .je-tag-host:not(:has(> .je-tag-slot[data-je-slot="hover"][data-je-overflow])) > .je-tag-slot[data-je-slot="pill"] .je-tag-pill[href] { pointer-events: none; }
            html .je-tag-host > .je-tag-slot[data-je-slot="hover"] .genre-tag {
                width: auto; min-width: 0; height: auto;
                padding: calc(2px * var(--je-tag-scale, 1)) calc(7px * var(--je-tag-scale, 1)) calc(2px * var(--je-tag-scale, 1)) calc(4px * var(--je-tag-scale, 1));
                gap: calc(3px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                border-radius: 999px;
            }
            html .je-tag-host > .je-tag-slot[data-je-slot="hover"] .genre-tag .je-msym-outlined { font-size: calc(1.05em * var(--je-tag-scale, 1)); }
            .je-tag-slot[data-je-slot="hover"] .genre-tag .genre-text {
                position: static;
                opacity: 1;
                transform: none;
                padding: 0;
                background: none;
                font-size: calc(11px * var(--je-tag-scale, 1));
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
                gap: calc(4px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                padding: calc(4px * var(--je-tag-scale, 1)) calc(6px * var(--je-tag-scale, 1));
                border-radius: 999px;
                background: rgba(0, 0, 0, 0.55);
            }
            .je-tag-dot {
                width: calc(8px * var(--je-tag-scale, 1)); height: calc(8px * var(--je-tag-scale, 1));
                border-radius: 50%;
                box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
                background: #546e7a;
            }
            .je-tag-dot[data-je-dot="resolution"] { background: #1e88e5; }
            .je-tag-dot[data-je-dot="range"] { background: #ef6c00; }
            .je-tag-dot[data-je-dot="audio"] { background: #2e7d32; }
            .je-tag-dot[data-je-dot="codec"] { background: #546e7a; }
            /* The fitting pass lifts the stack clear of the dots on narrow cards. */
            ${SLOT}[data-je-slot="corner"] {
                right: 6px; bottom: calc(6px + var(--je-stack-lift, 0px));
                max-width: calc(100% - 12px);
                flex-direction: column-reverse;
                align-items: flex-end;
            }
            ${SLOT}[data-je-slot="corner"] > [data-je-group] { align-items: flex-end; gap: calc(2px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1)); }
            html .je-tag-host > .je-tag-slot[data-je-slot="corner"] :is(.rating-tag, .quality-overlay-label, .age-rating-tag, .status-tag) {
                font-size: calc(11px * var(--je-tag-scale, 1));
                padding: calc(2px * var(--je-tag-scale, 1)) calc(5px * var(--je-tag-scale, 1));
                gap: calc(3px * var(--je-tag-scale, 1));
            }
            html .je-tag-host > .je-tag-slot[data-je-slot="corner"] .rating-star-icon { font-size: calc(11px * var(--je-tag-scale, 1)) !important; }

            /* Hide Tags on Hover: everything but the summary / minimal reveal. */
            ${HIDE_ACTIVE} .je-tag-host > .je-tag-slot:not([data-je-slot="hover"]),
            ${HIDE_ACTIVE} .je-tag-host:not([data-je-layout="summary"], [data-je-layout="minimal"]) > .je-tag-more-tip,
            ${PREVIEW_HIDE} .je-tag-host > .je-tag-slot:not([data-je-slot="hover"]),
            ${PREVIEW_HIDE} .je-tag-host:not([data-je-layout="summary"], [data-je-layout="minimal"]) > .je-tag-more-tip {
                opacity: 0 !important;
            }

            @media (prefers-reduced-motion: reduce) {
                ${SLOT}, .je-tag-host > .je-tag-more-tip { transition: none; }
            }
        `;
        return JE.core.tagLayout?.preserveLegacySizing?.(css) || css;
    }

    if (JE.core?.tagLayout) {
        JE.core.tagLayout.buildStyles = buildStyles;
        JE.core.tagLayout.buildFlushStyles = buildFlushStyles;
    }

})(window.JellyfinEnhanced);
