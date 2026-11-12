/**
 * @file The Tag Styles editor of the Media Tags admin tab (Colours tab):
 * preset tiles, group tabs, editing targets, Background/Border/Text rows,
 * the contrast badge and a live preview. Moved from the main configuration
 * page with its behaviour unchanged; it now builds over EDITOR_HTML inside
 * the page and looks its elements up there. Apply to (TagStyleTarget) is a
 * field of the Colours section (sections/colours.js), which also owns the
 * switches around the editor, Reset all colours and saving.
 */
(function(JE) {
    'use strict';
    // The editor's text is plain English (the configuration page is not translated).
    const fmt = (text, params) => {
        let out = String(text);
        if (params) {
            out = out.replace(/\{(\w+)\|([^|{}]*)\|([^|{}]*)\}/g, (m, name, one, many) => (Number(params[name]) === 1 ? one : many));
            for (const [name, value] of Object.entries(params)) out = out.split('{' + name + '}').join(String(value));
        }
        return out;
    };
    const T = fmt;

    /** The editor's markup (the old configuration page's, without the controls the Colours section owns). */
    const EDITOR_HTML = `
        <div id="tagStyleEditor" class="je-ts-editor">
            <div class="je-ts-editing-head je-ts-preset-head"><div class="je-ts-section-label" id="tagStylePresetLabel"></div><span class="je-ts-editing-now" id="tagStylePresetNow"></span></div>
            <div id="tagStylePresets" class="je-ts-presets" role="radiogroup" aria-labelledby="tagStylePresetLabel"><div class="je-ta-hint"></div></div>
            <div id="tagStyleTabs" class="je-ts-tabs" role="tablist"></div>
            <label class="je-ts-group-select"><span class="je-ts-section-label" id="tagStyleGroupSelectLabel"></span><select id="tagStyleGroupSelect"></select></label>
            <div id="tagStyleGroupPanel" class="je-ts-group-panel" role="tabpanel">
                <label class="je-ts-group-preset"><span class="je-ts-section-label" id="tagStyleGroupPresetLabel"></span><select id="tagStyleGroupPreset"></select></label>
                <div class="je-ts-editing-head"><div class="je-ts-section-label" id="tagStyleTargetsLabel"></div><span class="je-ts-editing-now" id="tagStyleEditingNow" aria-live="polite"></span>
                    <button type="button" class="je-ts-target-toggle" id="tagStyleTargetToggle" aria-expanded="false" aria-controls="tagStyleTargetBox" hidden></button></div>
                <div class="je-ts-sample" id="tagStyleSample" aria-hidden="true"></div>
                <div id="tagStyleContrast" class="je-ts-contrast" role="status" aria-live="polite"></div>
                <div class="je-ts-target-box" id="tagStyleTargetBox" hidden>
                <p class="je-ts-target-hint" id="tagStyleTargetHint"></p>
                <p class="je-ts-hidden-line" id="tagStyleHiddenLine" hidden></p>
                <input id="tagStyleTargetFilter" class="je-ts-target-filter" type="search" autocomplete="off" hidden>
                <div id="tagStyleTargets" class="je-ts-targets" role="radiogroup" aria-labelledby="tagStyleTargetsLabel"></div>
                </div>
                <div id="tagStyleHideRow" class="je-ts-hide-box"></div>
                <p id="tagStyleOffRowNote" class="je-ts-off-row" hidden></p>
                <div id="tagStyleGroupNote" class="je-ts-note"></div>
                <div id="tagStyleRows" class="je-ts-rows"></div>
            </div>
            <button type="button" class="je-ts-preview-toggle" id="tagStylePreviewToggle" aria-expanded="false" aria-controls="tagStylePreview" data-je-info><span class="je-ts-section-label" id="tagStylePreviewLabel"></span><span class="je-ts-preview-toggle-name"></span><span class="material-icons" aria-hidden="true">expand_more</span></button>
            <div id="tagStylePreview" class="je-ts-preview" aria-hidden="true" hidden></div>
        </div>`;

    // Tag Styles editor: preset → group → label. State mirrors the stored document
    // { v: 2, preset, groups: {group: {background, border, text}}, labels: {'group:label': {...}} }
    // (normalised rgba() strings, only what the admin set). The catalog brings every
    // preset's palette resolved per label, so each chip is drawn in its effective colours:
    // label override, else group override, else the preset (the order the server uses).
    /**
     * Build the Tag Styles editor over its markup (EDITOR_HTML) inside `root`.
     * @param {HTMLElement} root - Holds the editor markup (and #tagStylesEnabled).
     * @returns {{load: Function, serialize: Function, settings: Function, snapshot: Function}}
     */
    function createTagStylesEditor(root, customLabels = () => [], isCurrent = () => true, hiddenStore = null) {

        const GROUPS = [
            { key: 'quality', title: T('Quality') }, { key: 'ageRating', title: T('Age Rating') }, { key: 'rating', title: T('Rating') },
            { key: 'genre', title: T('Genre') }, { key: 'status', title: T('Status') }, { key: 'language', title: T('Language') }, { key: 'awards', title: T('Awards') },
            { key: 'logos', title: T('Logos') },
            { key: 'custom', title: T('Custom') }
        ];
        const PRESET_TITLES = { default: T('Default'), glass: T('Glass'), outline: T('Outline'), dark: T('Dark'),
            light: T('Light'), mono: T('Mono'), poster: T('Poster') };
        const FIELDS = [['background', T('Background')], ['border', T('Border')], ['text', T('Text')]];
        // The same names inside a sentence ("Reset border"), as the language writes them there.
        const IN_SENTENCE = { background: T('background'), border: T('border'),
            text: T('text'), icon: T('icon') };
        const SWATCHES = ['#1e88e5', '#ef6c00', '#2e7d32', '#546e7a', '#8e24aa', '#ffd166', '#ff6b6b', '#111111', '#ffffff', '#e0e0e0'];
        const OPACITIES = [40, 60, 80, 100];
        const POSTER_NOTE = T('Poster: each tag takes its background from the artwork it sits on (white or black text, whichever reads better). Colours set here stay on top; Default falls back to the artwork. The preview shows a red poster.');
        const NOTES = {
            genre: 'Each genre has its own colours (spellings and translations of a genre share them); Text colours the icon. Genres without an icon of their own use Other.',
            status: 'Status badges use the same colours on web cards and native posters.',
            language: 'Language chips use Background, Border and Text, including per-language colours and Dual/Multi. Flag images keep only their border ring; partial flags keep their dashed outline.',
            logos: 'Colours the pill behind a logo, or the name chip a logo without an image shows (Text colours the name).',
            custom: 'One target per label of the Custom tag rules above (labels shared by several rules share their colours). The icon takes the text colour.'
        };
        const LOGO_SAMPLES = { provider: T('Stream'), company: T('Studio'), text: 'HBO' };
        const RATING_SAMPLES = { community: ['star', '8.1'], critic: [null, '85%'], userReview: ['favorite', '9'], imdb: [null, '8.1'], tmdb: [null, '81%'], rtCritic: [null, '92%'], rtAudience: [null, '88%'], metacritic: [null, '74'], letterboxd: [null, '4.1'], trakt: [null, '85%'], myAnimeList: [null, '8.4'], aniList: [null, '82%'], metacriticUser: [null, '7.9'], rogerEbert: [null, '3.5'], mdblist: [null, '78%'] };
        const STATUS_SAMPLES = { added: T('Just Added'), newMovie: T('New Movie'), newSeries: T('New Series'), newEpisode: T('New Episode'), trending: T('#{rank} Today', { rank: 3 }) };
        const ALL = '*';
        // The one genre label documents held before each genre had its own.
        const LEGACY_GENRE = 'genre:genre';
        // Groups whose labels are icon tiles with their names, and how many labels bring a filter box.
        const TILE_GROUPS = ['genre'];
        const FILTER_MIN = 12;
        // Preview samples: a few genres in their own colours.
        const GENRE_SAMPLES = { movie: ['horror', 'comedy'], episode: ['animation'] };

        let cat = null;
        let state = { preset: 'default', groupPresets: {}, groups: {}, labels: {} };
        let current = 'quality';
        let target = ALL;
        // The label filter's text (tile groups with many labels); cleared on a group change.
        let filter = '';
        // Hidden tags: the list shows only the hidden tags of the group (cleared on a group change).
        let hiddenOnly = false;
        /** The colour property whose palette is open (one at a time), or null. */
        let openField = null;
        /** Whether the tag list (pick one tag of the group) is open. */
        let targetsOpen = false;
        let previewOpen = false;
        let canvas = null;
        // A version 1 document waiting for the catalog (its built-in colours) to be migrated: { json, doc }.
        let legacy = null;
        // A version 1 document migrated since load: the snapshots before (from) and after (to).
        let migrated = null;

        // <tag-style-contrast> pure helpers (tests/frontend extracts and runs this block)
        /**
         * Parses `rgba(r, g, b, a)`, `rgb(r, g, b)` or `#rrggbb`.
         * @param {string} css
         * @returns {{r: number, g: number, b: number, a: number}|null}
         */
        function rgbaOf(css) {
            const value = String(css || '').trim().toLowerCase();
            const hex = /^#([0-9a-f]{6})$/.exec(value);
            if (hex) return { r: parseInt(hex[1].slice(0, 2), 16), g: parseInt(hex[1].slice(2, 4), 16), b: parseInt(hex[1].slice(4, 6), 16), a: 1 };
            const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(value);
            if (!fn) return null;
            return { r: +fn[1], g: +fn[2], b: +fn[3], a: fn[4] === undefined ? 1 : +fn[4] };
        }

        /**
         * Paints `top` over the opaque colour `under`, rounding to whole channel values.
         * @param {{r: number, g: number, b: number, a: number}} top
         * @param {{r: number, g: number, b: number}} under
         * @returns {{r: number, g: number, b: number, a: number}}
         */
        function compositeOver(top, under) {
            const mix = (t, u) => Math.round(t * top.a + u * (1 - top.a));
            return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b), a: 1 };
        }

        /**
         * WCAG 2 relative luminance of an opaque colour.
         * @param {{r: number, g: number, b: number}} c
         * @returns {number}
         */
        function luminance(c) {
            const ch = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
            return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
        }

        /**
         * WCAG contrast of text over a chip background, both painted over a dark poster (#262626).
         * @param {string} text
         * @param {string} background
         * @returns {number|null} The ratio (1-21), or null when a colour does not parse.
         */
        function contrastRatio(text, background) {
            const t = rgbaOf(text), b = rgbaOf(background);
            if (!t || !b) return null;
            const bg = compositeOver(b, { r: 38, g: 38, b: 38 });
            const fg = compositeOver(t, bg);
            const l1 = luminance(fg), l2 = luminance(bg);
            return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        }

        /**
         * The contrast badge for a ratio: AA from 4.5, AA large only from 3, else low.
         * @param {number} ratio
         * @returns {{level: string, label: string}}
         */
        function contrastLevel(ratio) {
            if (ratio >= 4.5) return { level: 'aa', label: 'AA' };
            if (ratio >= 3) return { level: 'large', label: T('AA large only') };
            return { level: 'low', label: T('Low contrast') };
        }
        // </tag-style-contrast>

        /**
         * Any CSS colour to {r,g,b,a} through the canvas parser.
         * @param {string} css
         * @returns {{r: number, g: number, b: number, a: number}}
         */
        function parse(css) {
            const direct = rgbaOf(css);
            if (direct) return direct;
            canvas = canvas || document.createElement('canvas').getContext('2d');
            if (!canvas) return { r: 0, g: 0, b: 0, a: 1 };
            canvas.fillStyle = '#000000';
            canvas.fillStyle = css;
            return rgbaOf(canvas.fillStyle) || { r: 0, g: 0, b: 0, a: 1 };
        }
        /**
         * Like parse, but null for anything that is not a colour (the canvas keeps its previous
         * fill for an invalid one, so it is tried over two different fills).
         * @param {string} css
         * @returns {{r: number, g: number, b: number, a: number}|null}
         */
        function parseColour(css) {
            const direct = rgbaOf(css);
            if (direct) return direct;
            canvas = canvas || document.createElement('canvas').getContext('2d');
            if (!canvas || typeof css !== 'string' || !css.trim()) return null;
            canvas.fillStyle = '#000000';
            canvas.fillStyle = css;
            const overBlack = canvas.fillStyle;
            canvas.fillStyle = '#ffffff';
            canvas.fillStyle = css;
            return overBlack === canvas.fillStyle ? rgbaOf(overBlack) : null;
        }
        const toHex = (c) => '#' + [c.r, c.g, c.b].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('');
        const toCss = (c) => 'rgba(' + Math.round(c.r) + ', ' + Math.round(c.g) + ', ' + Math.round(c.b) + ', ' + (Math.round(c.a * 1000) / 1000) + ')';
        const norm = (css) => toCss(parse(css));

        /**
         * Creates an element with an optional class and text.
         * @param {string} tag
         * @param {string} [cls]
         * @param {string} [text]
         * @returns {HTMLElement}
         */
        function el(tag, cls, text) {
            const n = document.createElement(tag);
            if (cls) n.className = cls;
            if (text !== undefined) n.textContent = text;
            return n;
        }

        /**
         * A translated string (the key itself where no translator is loaded).
         * @param {string} key
         * @returns {string}
         */
        const tr = T;

        /**
         * A genre label's glyph (the catalog's; the default glyph when it has none).
         * @param {string} l - Genre label key.
         * @returns {string}
         */
        const genreIcon = (l) => (cat && cat.genreIcons && cat.genreIcons[l]) || 'theaters';

        /**
         * A genre chip's glyph element, in the bundled symbols font the genre tags use.
         * @param {string} l - Genre label key.
         * @returns {HTMLElement}
         */
        const genreGlyph = (l) => el('i', 'je-ts-genre-glyph', genreIcon(l));

        // Custom labels are the rules table's, unsaved edits included.
        const labelsOf = (g) => {
            if (g === 'custom') {
                const rules = customLabels().map(l => ({ key: l, name: l }));
                // A hidden label whose rule is gone keeps a tile, so it can be shown again (and does not silently hide a later rule).
                const orphans = hiddenStore ? hiddenList('custom').filter((l) => !rules.some((r) => r.key === l)).map((l) => ({ key: l, name: T('{name} (no rule)', { name: l }) })) : [];
                return rules.concat(orphans);
            }
            const labels = ((cat && cat.groups[g]) || []).slice();
            if (g === 'language') {
                for (const key of Object.keys(state.labels).filter(k => k.startsWith('language:')).map(k => k.slice(9))) {
                    if (!labels.some(l => l.key === key)) labels.push({ key, name: key.toUpperCase() });
                }
            }
            return labels;
        };
        const labelKey = (g, l) => g + ':' + l;
        const fieldsOf = (g) => (g === 'language' && target === 'flag' ? FIELDS.filter(([f]) => f === 'border') : FIELDS);

        /**
         * The preset one group uses: its own when it has one, else the design's.
         * @param {string} g
         * @returns {string}
         */
        function presetOf(g) {
            return state.groupPresets[g] || state.preset;
        }

        /**
         * A preset's colours for one label, as {background, border, text}.
         * @param {string} preset
         * @param {string} g - Group id.
         * @param {string} l - Label key.
         * @returns {{background: string, border: string, text: string}}
         */
        function palette(preset, g, l) {
            const pal = (cat && cat.palettes[preset]) || {};
            // Every custom chip takes the group's palette colours.
            const p = pal[labelKey(g, l)] || (g === 'custom' ? pal[labelKey(g, ALL)] : null) || {};
            return { background: p.background, border: p.border, text: p.color };
        }

        /**
         * The colours a label shows: label override, group override, then preset.
         * @param {string} g
         * @param {string} l
         * @returns {{background: string, border: string, text: string}}
         */
        function effective(g, l) {
            const own = state.labels[labelKey(g, l)] || {};
            const shared = state.groups[g] || {};
            const kind = g === 'language' && !['flag', 'code', 'subtitles', 'countBadge'].includes(l)
                ? state.labels[labelKey(g, ['dual', 'multi'].includes(l) ? 'countBadge' : 'code')] || {} : {};
            const pal = palette(presetOf(g), g, l);
            const out = {};
            FIELDS.forEach(([f]) => { out[f] = own[f] || kind[f] || shared[f] || pal[f]; });
            return out;
        }

        /**
         * The colours the current editing target shows. For the whole group a field is the
         * group override, else the preset colour when every label shares it, else null (varies).
         * @returns {{background: string|null, border: string|null, text: string|null}}
         */
        function targetColours() {
            if (target !== ALL) return effective(current, target);
            const shared = state.groups[current] || {};
            const out = {};
            FIELDS.forEach(([f]) => {
                const values = new Set(labelsOf(current).map((l) => palette(presetOf(current), current, l.key)[f]));
                out[f] = shared[f] || (values.size === 1 ? [...values][0] : null);
            });
            return out;
        }

        /** @returns {Object} The override bag the editing target writes to. */
        const targetEntry = () => (target === ALL ? state.groups[current] : state.labels[labelKey(current, target)]) || {};

        /**
         * Sets (or with null clears) one field of the editing target, then redraws.
         * @param {string} field
         * @param {string|null} css
         * @returns {void}
         */
        function setField(field, css, live) {
            const bag = target === ALL ? state.groups : state.labels;
            const key = target === ALL ? current : labelKey(current, target);
            const o = Object.assign({}, bag[key] || {});
            if (css) o[field] = norm(css); else delete o[field];
            if (Object.keys(o).length) bag[key] = o; else delete bag[key];
            // While a colour picker is dragged its rows stay as they are (rebuilding them
            // would replace the picker's input); they are redrawn when the pick is done.
            if (live) { renderTargets(); renderContrast(); } else renderGroup();
            renderPreview();
        }

        /**
         * Rebuild a strip of controls, keeping keyboard focus on the control with
         * the same data-ts-key (or `fallback`'s choice when it is gone or disabled):
         * a click that redraws its own strip must not drop focus to the page.
         * @param {Element} box
         * @param {() => void} build
         * @param {(key: string) => (HTMLElement|null)} [fallback]
         * @returns {void}
         */
        function rebuildKeepingFocus(box, build, fallback) {
            const active = document.activeElement;
            const key = active && box.contains(active) && active.dataset ? active.dataset.tsKey : null;
            build();
            if (!key) return;
            const again = Array.from(box.querySelectorAll('[data-ts-key]')).find((n) => n.dataset.tsKey === key);
            const next = again && !again.disabled ? again : fallback ? fallback(key) : null;
            if (next) next.focus({ preventScroll: true });
        }

        /**
         * Paints a chip in the given colours. Rating chips and flags have no border of
         * their own: theirs is an inner ring, as on the web and native posters.
         * @param {HTMLElement} n
         * @param {string} g
         * @param {{background: string, border: string, text: string}} c
         * @returns {HTMLElement} n
         */
        function paint(n, g, c) {
            if (g !== 'language' || !n.matches('img.language-flag')) {
                n.style.background = c.background || '';
                n.style.color = c.text || '';
            }
            if (g === 'rating' || (g === 'language' && n.matches('img.language-flag'))) {
                const ring = c.border && parse(c.border).a > 0;
                n.style.outline = ring ? '1px solid ' + c.border : '';
                n.style.outlineOffset = ring ? '-1px' : '';
            } else {
                n.style.borderColor = c.border || '';
            }
            return n;
        }

        /** A real language-chip class and style label for one colour-editor sample. */
        function languageSample(label) {
            const count = ['dual', 'multi', 'countBadge'].includes(label.key);
            // The style targets read as what they cover, so none looks like one language or the other badge.
            const text = label.key === 'subtitles' ? 'CC EN' : count ? label.key === 'dual' ? T('Dual') : label.key === 'multi' ? T('Multi') : T('Dual') + ' · ' + T('Multi') : label.key === 'code' ? 'ABC' : label.key.toUpperCase();
            const n = el('span', 'je-ts-chip language-chip ' + (count ? 'language-count-badge' : 'language-code'), text);
            n.dataset.jeLanguage = count ? 'countBadge' : label.key === 'subtitles' ? 'subtitles' : 'flag';
            n.dataset.jeLanguageLabel = count ? label.key === 'dual' ? 'dual' : 'multi' : label.key === 'code' || label.key === 'subtitles' ? 'en' : label.key;
            return n;
        }

        /**
         * A named source sample using the bundled client logo, or its catalog name on a dashboard without the bundle.
         * @param {{key: string, name: string}} label
         * @returns {HTMLElement}
         */
        function sourceRatingChip(label) {
            const text = (RATING_SAMPLES[label.key] || [null, ''])[1];
            let n = window.JellyfinEnhanced?.ratingSources?.chip({ id: label.key, value: parseFloat(text), text, color: null });
            if (!n) {
                n = el('span', 'rating-tag rating-tag--source');
                n.dataset.jeRatingSource = label.key;
                n.append(el('span', 'je-ts-source-name', label.name), el('span', 'rating-text', text));
            }
            n.classList.add('je-ts-chip', 'je-ts-rate');
            return n;
        }

        /**
         * A sample chip for a label, with the real chip classes.
         * @param {string} g
         * @param {{key: string, name: string}} label
         * @param {{background: string, border: string, text: string}} c
         * @returns {HTMLElement}
         */
        function chip(g, label, c) {
            let n;
            if (g === 'quality') {
                n = el('span', 'je-ts-chip je-ts-q quality-overlay-label', label.name);
            } else if (g === 'ageRating') {
                n = el('span', 'je-ts-chip je-ts-age age-rating-tag', label.name);
            } else if (g === 'rating' && !['community', 'critic', 'userReview'].includes(label.key)) {
                n = sourceRatingChip(label);
            } else if (g === 'rating') {
                const [icon, text] = RATING_SAMPLES[label.key] || ['star', '8.1'];
                n = el('span', 'je-ts-chip je-ts-rate rating-tag');
                n.appendChild(icon ? el('i', 'material-icons je-ts-rate-icon', icon) : el('i', 'je-ts-tomato'));
                n.appendChild(document.createTextNode(text));
            } else if (g === 'awards') {
                n = el('div', 'awards-tag je-ts-chip je-ts-rate', label.name.includes('250') ? T('Top 250') : label.name);
                n.dataset.jeAward = label.key;
            } else if (g === 'genre') {
                n = el('span', 'je-ts-chip je-ts-genre genre-tag');
                n.appendChild(genreGlyph(label.key));
            } else if (g === 'status') {
                n = el('span', 'je-ts-chip je-ts-status status-tag', STATUS_SAMPLES[label.key] || label.name);
            } else if (g === 'logos') {
                n = el('span', 'je-ts-chip je-ts-status je-logo-chip', LOGO_SAMPLES[label.key] || label.name);
                n.dataset.jeLogoStyle = label.key;
            } else if (g === 'custom') {
                n = el('span', 'je-ts-chip je-ts-custom custom-tag', label.name);
            } else if (g === 'language' && label.key !== 'flag') {
                n = languageSample(label);
            } else {
                n = el('img', 'je-ts-chip je-ts-flag language-flag');
                n.src = window.jeCdnUrl('flag-icons/flags/4x3/gb.svg');
                n.alt = '';
            }
            return paint(n, g, c);
        }

        /**
         * A labelled pill/radio button.
         * @param {string} cls
         * @param {boolean} checked
         * @param {Function} onClick
         * @returns {HTMLButtonElement}
         */
        function radio(cls, checked, onClick) {
            const b = el('button', cls + (checked ? ' active' : ''));
            b.type = 'button';
            b.setAttribute('role', 'radio');
            b.setAttribute('aria-checked', String(checked));
            b.addEventListener('click', onClick);
            return b;
        }

        /** @returns {void} */


        /** @returns {void} */
        function renderPresets() {
            const bar = root.querySelector('#tagStylePresets');
            rebuildKeepingFocus(bar, () => buildPresets(bar));
            rove(bar, '.je-ts-preset', 'aria-checked');
            const now = root.querySelector('#tagStylePresetNow');
            if (now) now.textContent = PRESET_TITLES[state.preset] || state.preset || '';
            const previewToggle = root.querySelector('#tagStylePreviewToggle');
            if (previewToggle && !previewToggle.onclick) {
                const name = previewToggle.querySelector('.je-ts-preview-toggle-name');
                if (name) name.textContent = tr('Movie and episode samples');
                previewToggle.onclick = () => {
                    previewOpen = !previewOpen;
                    previewToggle.setAttribute('aria-expanded', String(previewOpen));
                    root.querySelector('#tagStylePreview').hidden = !previewOpen;
                };
            }
        }

        /**
         * One Tab stop for a strip of choices (the selected one); arrow keys, Home and End
         * choose the next one, as the page's own tab bar does.
         * @param {Element} box
         * @param {string} selector
         * @param {string} attr - aria-checked or aria-selected.
         * @returns {void}
         */
        function rove(box, selector, attr) {
            const items = Array.from(box.querySelectorAll(selector));
            items.forEach((item) => { item.tabIndex = item.getAttribute(attr) === 'true' ? 0 : -1; });
            if (items.length && !items.some((item) => item.tabIndex === 0)) items[0].tabIndex = 0;
            box.onkeydown = (e) => {
                const list = Array.from(box.querySelectorAll(selector));
                const at = list.indexOf(e.target.closest(selector));
                if (at < 0 || e.altKey || e.ctrlKey || e.metaKey) return;
                const back = getComputedStyle(box).direction === 'rtl' ? 1 : -1;
                const step = { ArrowLeft: back, ArrowRight: -back, ArrowUp: -1, ArrowDown: 1 }[e.key];
                const next = step ? list[(at + step + list.length) % list.length] : e.key === 'Home' ? list[0] : e.key === 'End' ? list[list.length - 1] : null;
                if (!next) return;
                e.preventDefault();
                const key = next.dataset.tsKey;
                next.click();
                // Choosing redraws the strip: focus the new choice there.
                const again = Array.from(box.querySelectorAll(selector)).find((n) => n.dataset.tsKey === key);
                if (again) again.focus();
            };
        }

        /** @param {Element} bar @returns {void} */
        function buildPresets(bar) {
            bar.textContent = '';
            const age = labelsOf('ageRating').find((l) => l.name === 'PG-13') || labelsOf('ageRating')[0];
            cat.presets.forEach((id) => {
                const tile = radio('je-ts-preset', state.preset === id, () => { state.preset = id; render(); });
                tile.dataset.preset = id;
                tile.dataset.tsKey = 'preset:' + id;
                tile.appendChild(el('span', 'je-ts-preset-title', PRESET_TITLES[id] || id));
                const mini = el('span', 'je-ts-preset-chips');
                mini.appendChild(chip('quality', { key: '4K', name: '4K' }, palette(id, 'quality', '4K')));
                mini.appendChild(chip('rating', { key: 'community', name: T('Community') }, palette(id, 'rating', 'community')));
                if (age) mini.appendChild(chip('ageRating', age, palette(id, 'ageRating', age.key)));
                tile.appendChild(mini);
                bar.appendChild(tile);
            });
        }

        /** @returns {void} */
        function renderTabs() {
            const tabs = root.querySelector('#tagStyleTabs');
            rebuildKeepingFocus(tabs, () => {
                tabs.textContent = '';
                GROUPS.forEach((g) => {
                    const b = el('button', 'je-ts-tab' + (g.key === current ? ' active' : ''), g.title);
                    // A group that hides tags says so on its tab (hiding is silent for every user).
                    const hiddenHere = hiddenStore ? hiddenCountOf(g.key) : 0;
                    if (hiddenHere) {
                        const mark = el('span', 'je-ts-tab-hidden');
                        const icon = el('i', 'material-icons', 'visibility_off');
                        icon.setAttribute('aria-hidden', 'true');
                        mark.append(icon, String(hiddenHere));
                        b.appendChild(mark);
                        b.setAttribute('aria-label', T('{group}, {count} hidden', { group: g.title, count: hiddenHere }));
                    }
                    b.type = 'button';
                    b.setAttribute('role', 'tab');
                    b.setAttribute('aria-selected', String(g.key === current));
                    b.dataset.group = g.key;
                    b.dataset.tsKey = 'tab:' + g.key;
                    b.id = 'tagStyleTab-' + g.key;
                    b.setAttribute('aria-controls', 'tagStyleGroupPanel');
                    b.addEventListener('click', () => { current = g.key; target = ALL; filter = ''; hiddenOnly = false; renderTabs(); renderGroup(); });
                    tabs.appendChild(b);
                });
            });
            rove(tabs, '.je-ts-tab', 'aria-selected');
            // A phone shows the groups as one select (the tabs wrap into rows there).
            const select = root.querySelector('#tagStyleGroupSelect');
            if (select) {
                select.innerHTML = GROUPS.map((g) => {
                    const hiddenHere = hiddenStore ? hiddenCountOf(g.key) : 0;
                    return '<option value="' + g.key + '"' + (g.key === current ? ' selected' : '') + '>' + g.title + (hiddenHere ? ' ' + T('({count} hidden)', { count: hiddenHere }) : '') + '</option>';
                }).join('');
                select.onchange = () => tabs.querySelector('.je-ts-tab[data-group="' + select.value + '"]')?.click();
                const label = root.querySelector('#tagStyleGroupSelectLabel');
                if (label) label.textContent = tr('Tag group');
            }
            root.querySelector('#tagStyleGroupPanel')?.setAttribute('aria-labelledby', 'tagStyleTab-' + current);
        }

        /**
         * Shows the label tiles whose name holds the filter text; Whole group and the
         * label being edited always stay.
         * @returns {void}
         */
        function applyFilter() {
            const needle = filter.trim().toLocaleLowerCase();
            root.querySelectorAll('#tagStyleTargets .je-ts-target').forEach((cell) => {
                const label = cell.dataset.label;
                const name = (cell.getAttribute('aria-label') || '').toLocaleLowerCase();
                cell.hidden = (!!needle && label !== ALL && label !== target && !name.includes(needle))
                    || (hiddenOnly && label !== ALL && label !== target && !isHidden(current, label));
            });
        }

        /**
         * Arrow keys move the selection along the visible tiles (wrapping), Home and End
         * to the first and last; selecting rebuilds the strip, which keeps focus on the
         * selected tile.
         * @param {KeyboardEvent} e
         * @returns {void}
         */
        function onTargetKey(e) {
            const box = e.currentTarget;
            const cells = Array.from(box.querySelectorAll('.je-ts-target:not([hidden])'));
            const at = cells.indexOf(e.target.closest('.je-ts-target'));
            if (at < 0 || e.altKey || e.ctrlKey || e.metaKey) return;
            const back = getComputedStyle(box).direction === 'rtl' ? 1 : -1;
            const step = { ArrowLeft: back, ArrowRight: -back, ArrowUp: -1, ArrowDown: 1 }[e.key];
            let next;
            if (step) next = cells[(at + step + cells.length) % cells.length];
            else if (e.key === 'Home') next = cells[0];
            else if (e.key === 'End') next = cells[cells.length - 1];
            else return;
            e.preventDefault();
            next.click();
        }

        // ── Hidden tags (#1043) ──
        // Each tile can be hidden: its chips never draw (web and native posters). The lists live in
        // TagHiddenValues ({ Genre: ['drama'], … }), kept by the Colours section through hiddenStore
        // ({ get(): doc|null, set(doc, ageRatings, change) }). Flag and Language codes colour every flag or
        // code, so they are not tags to hide.
        const NOT_HIDEABLE = { language: ['flag', 'code'] };
        const pascal = (g) => g.charAt(0).toUpperCase() + g.slice(1);
        /** @param {string} g @param {string} l @returns {boolean} */
        const hideable = (g, l) => !!hiddenStore && l !== ALL && !(NOT_HIDEABLE[g] || []).includes(l);
        /** @param {string} g @returns {string[]} The group's hidden labels. */
        const hiddenList = (g) => {
            const doc = (hiddenStore && hiddenStore.get()) || {};
            const list = doc[pascal(g)] ?? doc[g];
            return Array.isArray(list) ? list.map(String) : [];
        };
        /** @param {string} g @param {string} l @returns {boolean} */
        const isHidden = (g, l) => hiddenList(g).includes(l);
        /** @param {string} g @param {string} l @returns {boolean} Whether a tile is hidden by another (Dual · Multi covers Dual and Multi). */
        const coveredBy = (g, l) => g === 'language' && (l === 'dual' || l === 'multi') && isHidden('language', 'countBadge');

        /**
         * Hide or show one tile's chips and hand the whole document to the store.
         * @param {string} g
         * @param {{key: string, name: string}} label
         * @param {boolean} on
         */
        function setHidden(g, label, on) {
            const doc = {};
            for (const { key } of GROUPS) {
                let list = hiddenList(key);
                if (key === g) list = on ? list.concat(list.includes(label.key) ? [] : [label.key]) : list.filter((l) => l !== label.key);
                if (list.length) doc[pascal(key)] = list;
            }
            const next = Object.keys(doc).length ? doc : null;
            // The web matches age rating badges by the ratings on a board.
            const ages = next && next.AgeRating ? (cat.age || []).filter((a) => next.AgeRating.includes(a.id)).flatMap((a) => a.ratings) : [];
            const count = g === 'ageRating' ? (((cat.age || []).find((a) => a.id === label.key) || {}).ratings || []).length : 1;
            // A Custom label whose rule is gone has a tile only while hidden: showing it again ends it.
            const orphan = g === 'custom' && !customLabels().includes(label.key);
            const noun = hideNoun(g, label);
            hiddenStore.set(next, ages, { group: g, label, hidden: on, count, orphan, noun: noun.charAt(0).toUpperCase() + noun.slice(1) });
            if (!on && orphan) {
                target = ALL;
                renderTabs();
                renderGroup();
                renderPreview();
                root.querySelector('#tagStyleTargets .je-ts-target-all')?.focus();
                return;
            }
            refreshHiddenViews();
        }

        /** Redraw what shows hidden state (the confirmation announces the change, so the header stays quiet). */
        function refreshHiddenViews() {
            const now = root.querySelector('#tagStyleEditingNow');
            now?.removeAttribute('aria-live');
            renderTabs();
            renderTargets();
            renderHideRow();
            renderSample();
            renderPreview();
            // Live again only after this change has been observed (not announced).
            setTimeout(() => now?.setAttribute('aria-live', 'polite'), 250);
        }

        /** @param {string} g @returns {number} How many of a group's tags are hidden. */
        function hiddenCountOf(g) {
            return labelsOf(g).filter((l) => isHidden(g, l.key)).length;
        }

        /**
         * A language tile's code with its English name ("EN (English)"), as the page is in English.
         * @param {{key: string, name: string}} label
         * @returns {string}
         */
        function languageName(label) {
            const code = label.name.toUpperCase();
            try {
                const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(label.key);
                return name && name.toLowerCase() !== label.key ? code + ' (' + name + ')' : code;
            } catch { return code; }
        }

        // A rating keeps its hyphen on one line ("TV-14", never "TV-" / "14").
        const nb = (text) => String(text).replace(/-/g, '\u2011');

        /**
         * The Hide switch's name: the tag it hides ("Hide Drama", "Hide PG-13 and 146 more ratings").
         * @param {string} g
         * @param {{key: string, name: string}} label
         * @returns {string}
         */
        function hideName(g, label) {
            return T('Hide {name}', { name: hideNoun(g, label) });
        }

        /**
         * What a tile hides, as the switch and the confirmation name it ("Other genres", "EN (English)",
         * "PG-13 and 146 more ratings").
         * @param {string} g
         * @param {{key: string, name: string}} label
         * @returns {string}
         */
        function hideNoun(g, label) {
            if (g === 'ageRating') {
                const ages = (((cat.age || []).find((a) => a.id === label.key) || {}).ratings || []).length;
                if (ages > 1) return T('{name} and {count} more ratings', { name: nb(label.name), count: ages - 1 });
            }
            if (g === 'genre' && label.key === 'other') return T('Other genres');
            if (g === 'logos') return ({ provider: T('provider logos'), company: T('network and studio logos'), text: T('name chips') })[label.key] || label.name;
            if (g === 'language') return ({ subtitles: T('subtitle chips'), countBadge: T('Dual and Multi badges'), dual: T('the Dual badge'), multi: T('the Multi badge') })[label.key]
                || languageName(label);
            return label.name;
        }

        /**
         * A hidden tile's name in the hidden line: age tiles carry how many ratings they stand for.
         * @param {string} g
         * @param {{key: string, name: string}} label
         * @returns {string}
         */
        function hiddenTileName(g, label) {
            if (g !== 'ageRating') return label.name;
            const ages = (((cat.age || []).find((a) => a.id === label.key) || {}).ratings || []).length;
            return ages > 1 ? nb(label.name) + ' (+' + (ages - 1) + ')' : nb(label.name);
        }

        /**
         * What hiding a tile does, in words.
         * @param {string} g
         * @param {{key: string, name: string}} label
         * @returns {string}
         */
        function hideDescription(g, label) {
            const name = label.name;
            if (g === 'genre') return label.key === 'other'
                ? T('Hides every genre without an icon of its own (Reality, Talk, Anime and the like) from posters. The next genres take their places.')
                : T('Hides {name} from posters, in every spelling and language. The next genres take its place.', { name });
            if (g === 'ageRating') {
                const ratings = ((cat.age || []).find((a) => a.id === label.key) || {}).ratings || [];
                const examples = ['G', 'PG', 'PG-13', 'R', 'NC-17', 'TV-14', 'TV-MA', '12A', '15', '18', 'NR'].filter((r) => ratings.includes(r)).concat(ratings).filter((r, i, a) => a.indexOf(r) === i).slice(0, 3);
                return ratings.length > 3
                    ? T('Hides every rating that shares these colours from posters, such as {examples}.', { examples: examples.map(nb).join(', ') })
                    : T('Hides these ratings from posters: {ratings}.', { ratings: ratings.map(nb).join(', ') });
            }
            if (g === 'logos') return ({ provider: T('Hides provider (streaming service) logos from posters. The next logos take their place.'),
                company: T('Hides network and studio logos from posters. The next logos take their place.'),
                text: T('Hides logos without an image (name chips) from posters. The next logos take their place.') })[label.key] || '';
            if (g === 'language') return ({ subtitles: T('Hides subtitle chips from posters.'), countBadge: T('Hides the Dual and Multi badges from posters.'),
                dual: T('Hides the Dual badge from posters.'), multi: T('Hides the Multi badge from posters.') })[label.key]
                || T('Hides {name} audio and subtitle chips from posters. The next languages take its place; the Dual and Multi badges still count it.', { name: languageName(label).replace(/^[A-Z]+ \((.+)\)$/, '$1') });
            return T('Hides {name} from posters, native posters included. The next tags take its place.', { name });
        }

        /** @returns {void} */
        function renderTargets() {
            // The hidden-only view ends with the group's last hidden tag (before the list is filtered by it).
            if (hiddenOnly && !(hiddenStore && labelsOf(current).some((l) => isHidden(current, l.key)))) hiddenOnly = false;
            const box = root.querySelector('#tagStyleTargets');
            // Rebuilding drops focus: a keyboard user keeps it on the selected tile.
            const focused = box.contains(document.activeElement);
            box.textContent = '';
            box.onkeydown = onTargetKey;
            const tiles = TILE_GROUPS.includes(current);
            box.classList.toggle('je-ts-targets-tiles', tiles);
            // The tag list opens on request: the colour rows stay next to what they edit.
            const toggle = root.querySelector('#tagStyleTargetToggle');
            if (toggle) {
                toggle.hidden = false;
                toggle.textContent = targetsOpen ? tr('Close tag list') : tr('Choose a tag');
                toggle.setAttribute('aria-expanded', String(targetsOpen));
                toggle.onclick = () => { targetsOpen = !targetsOpen; renderTargets(); if (targetsOpen) root.querySelector('#tagStyleTargets .je-ts-target[tabindex="0"]')?.focus(); };
            }
            const targetBox = root.querySelector('#tagStyleTargetBox');
            if (targetBox) targetBox.hidden = !targetsOpen;
            const hint = root.querySelector('#tagStyleTargetHint');
            if (hint) hint.textContent = tr(hiddenStore ? 'Choose a tag to change its colours or hide it.' : 'Choose a tag to change only its colours.');
            const search = root.querySelector('#tagStyleTargetFilter');
            if (search) {
                // Any group with more labels than a glance takes gets the filter (genres name the box after themselves).
                search.hidden = labelsOf(current).length <= FILTER_MIN;
                const filterKey = current === 'genre' ? 'Find a genre' : 'Find a tag';
                search.placeholder = tr(filterKey);
                search.setAttribute('aria-label', tr(filterKey));
                search.value = search.hidden ? '' : filter;
                search.oninput = () => { filter = search.value; applyFilter(); };
            }
            // What the colour rows below change, named above the list.
            const now = root.querySelector('#tagStyleEditingNow');
            if (now) {
                const groupTitle = (GROUPS.find((g) => g.key === current) || {}).title || current;
                const label = target === ALL ? null : labelsOf(current).find((l) => l.key === target);
                // The group part is dropped on a phone, where the group select above names it.
                now.replaceChildren(el('span', 'je-ts-now-group', groupTitle + ' · '), document.createTextNode(label ? label.name : T('Whole group')));
                if (label && (isHidden(current, label.key) || coveredBy(current, label.key))) {
                    const flag = el('span', 'je-ts-now-hidden');
                    const icon = el('i', 'material-icons', 'visibility_off');
                    icon.setAttribute('aria-hidden', 'true');
                    flag.append(' · ', icon, T('hidden'));
                    now.appendChild(flag);
                }
            }
            const all = radio('je-ts-target je-ts-target-all' + (state.groups[current] ? ' changed' : ''), target === ALL, () => { target = ALL; renderGroup(); });
            all.textContent = T('Whole group');
            all.dataset.label = ALL;
            box.appendChild(all);
            labelsOf(current).forEach((label) => {
                const changed = !!state.labels[labelKey(current, label.key)];
                const cell = radio('je-ts-target' + (changed ? ' changed' : ''), target === label.key, () => { target = label.key; renderGroup(); });
                cell.dataset.label = label.key;
                cell.title = current === 'ageRating'
                    ? T('Applies to: {ratings}', { ratings: ((cat.age.find((a) => a.id === label.key) || {}).ratings || []).join(', ') })
                    : label.name;
                const boardSize = current === 'ageRating' ? (((cat.age || []).find((a) => a.id === label.key) || {}).ratings || []).length : 0;
                cell.setAttribute('aria-label', boardSize > 1 ? T('{name} and {count} more ratings', { name: label.name, count: boardSize - 1 }) : label.name);
                // A hidden tile says so: dimmed, with the hidden mark on its chip's corner and in its name.
                const sample = chip(current, label, effective(current, label.key));
                if (isHidden(current, label.key) || coveredBy(current, label.key)) {
                    cell.classList.add('je-ts-target-hidden');
                    cell.setAttribute('aria-label', coveredBy(current, label.key) && !isHidden(current, label.key)
                        ? T('{name}, hidden by Dual and Multi badges', { name: cell.getAttribute('aria-label') })
                        : T('{name}, hidden', { name: cell.getAttribute('aria-label') }));
                    cell.title = T('{name} (hidden)', { name: cell.title });
                    const wrap = el('span', 'je-ts-chip-wrap');
                    wrap.appendChild(sample);
                    const mark = el('i', 'material-icons je-ts-hidden-mark', 'visibility_off');
                    mark.setAttribute('aria-hidden', 'true');
                    wrap.appendChild(mark);
                    cell.appendChild(wrap);
                } else cell.appendChild(sample);
                // Tiles carry their name too (shown where there is room; the tooltip always has it).
                if (tiles) cell.appendChild(el('span', 'je-ts-target-name', label.name));
                box.appendChild(cell);
            });
            applyFilter();
            // One tab stop for the strip (the filter box is its own): the selected tile.
            let selected = null;
            box.querySelectorAll('.je-ts-target').forEach((cell) => {
                const on = cell.getAttribute('aria-checked') === 'true';
                cell.tabIndex = on ? 0 : -1;
                if (on) selected = cell;
            });
            selected = selected || box.querySelector('.je-ts-target');
            if (selected) selected.tabIndex = 0;
            if (focused && selected) selected.focus();
            // Say when the list scrolls inside its box.
            if (hint) {
                const count = labelsOf(current).length;
                const scrolls = targetsOpen && box.scrollHeight > box.clientHeight + 2;
                const shownHidden = hiddenOnly ? labelsOf(current).filter((l) => isHidden(current, l.key)).length : 0;
                hint.textContent = tr(hiddenStore ? 'Choose a tag to change its colours or hide it.' : 'Choose a tag to change only its colours.')
                    + (hiddenOnly ? ' ' + T('Showing the {count} hidden tags only.', { count: shownHidden })
                        : scrolls ? ' ' + T('{count} tags; scroll for more.', { count: Number(count) }) : '');
            }
            // The hidden tags by name on their own line, each a way to its switch (a long list can scroll them
            // out of view); more than four: a view of the hidden tags only.
            const line = root.querySelector('#tagStyleHiddenLine');
            if (line) {
                const hiddenLabels = hiddenStore ? labelsOf(current).filter((l) => isHidden(current, l.key)) : [];
                line.hidden = !hiddenLabels.length;
                line.textContent = '';
                if (hiddenLabels.length) {
                    const icon = el('i', 'material-icons', 'visibility_off');
                    icon.setAttribute('aria-hidden', 'true');
                    line.append(icon, T('Hidden ({count}):', { count: hiddenLabels.length }) + ' ');
                    hiddenLabels.slice(0, 4).forEach((l, i) => {
                        if (i) line.append(', ');
                        const go = el('button', 'je-ts-hidden-pick', hiddenTileName(current, l));
                        go.type = 'button';
                        go.setAttribute('aria-label', T('{name}, hidden: go to its switch', { name: hiddenTileName(current, l) }));
                        go.addEventListener('click', () => { target = l.key; renderGroup(); (root.querySelector('#tagStyleHide') || root.querySelector('#tagStyleTargets .je-ts-target[tabindex="0"]'))?.focus(); });
                        line.appendChild(go);
                    });
                    if (hiddenLabels.length > 4) line.append(' ' + T('and {count} more', { count: hiddenLabels.length - 4 }));
                    if (hiddenLabels.length > 4 || hiddenOnly) {
                        // A view switch, set apart from the names (the hint says which view is on).
                        line.append(' · ');
                        const all = el('button', 'je-ts-hidden-view', hiddenOnly ? T('Show every tag') : T('Show only the hidden tags'));
                        all.type = 'button';
                        all.dataset.tsHiddenView = '';
                        all.addEventListener('click', () => { hiddenOnly = !hiddenOnly; renderTargets(); root.querySelector('[data-ts-hidden-view]')?.focus(); });
                        line.appendChild(all);
                    }
                }
            }
            // A long strip scrolls inside its box: keep the selected label in view there (never the page).
            if (selected && box.scrollHeight > box.clientHeight) {
                const top = selected.offsetTop - box.offsetTop;
                if (top < box.scrollTop || top + selected.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = Math.max(0, top - 8);
            }
        }

        /**
         * The picked tag's Hide switch, above the group note and the colour rows (it decides whether the tag
         * shows at all). Picks without one say why: Whole group, and the language styles that colour every
         * flag or code.
         * @returns {void}
         */
        function renderHideRow() {
            const box = root.querySelector('#tagStyleHideRow');
            if (!box || !hiddenStore) return;
            rebuildKeepingFocus(box, () => {
                box.textContent = '';
                const picked = target === ALL ? null : labelsOf(current).find((l) => l.key === target);
                if (!picked) {
                    // Whole group: hiding is per tag; the Groups tab (linked) turns a group off, for new users.
                    const groupTitle = (GROUPS.find((g) => g.key === current) || {}).title || current;
                    const line = el('p', 'je-ts-hide-none');
                    const back = el('a', 'je-ta-link je-ts-inline-link', T('Groups › {group}', { group: groupTitle }));
                    back.href = '#';
                    back.dataset.jeGoto = 'groups:' + current;
                    line.append(T('Hiding works per tag. To turn the whole group off for new users, see '), back, '.');
                    box.appendChild(line);
                    return;
                }
                // Hidden only through the Dual and Multi badges tag: a way to that tag's switch. (Hidden on its own
                // as well, it keeps its own switch, with the same line under it.)
                const coveredLine = () => {
                    const line = el('p', 'je-ts-hide-none');
                    const go = el('button', 'je-ts-hidden-pick', T('Dual and Multi badges'));
                    go.type = 'button';
                    go.addEventListener('click', () => { target = 'countBadge'; renderGroup(); root.querySelector('#tagStyleHide')?.focus(); });
                    line.append(isHidden(current, picked.key) ? T('Also hidden by ') : T('Hidden by '), go,
                        isHidden(current, picked.key) ? '.' : T('. Turn that off to show this badge again.'));
                    return line;
                };
                if (coveredBy(current, picked.key) && !isHidden(current, picked.key)) {
                    box.appendChild(coveredLine());
                    return;
                }
                if (!hideable(current, picked.key)) {
                    box.appendChild(el('p', 'je-ts-hide-none', picked.key === 'flag' ? T('This colours every flag. To hide one language, choose its code.')
                            : T('This colours every language code. To hide one language, choose its code.')));
                    return;
                }
                const sw = el('label', 'je-ta-switch je-ts-hide-switch');
                const input = document.createElement('input');
                input.type = 'checkbox';
                input.checked = isHidden(current, picked.key);
                input.dataset.tsKey = 'hide';
                input.id = 'tagStyleHide';
                // Named by its name alone; the scope sentence is its description (not read twice).
                input.setAttribute('aria-labelledby', 'tagStyleHideName');
                input.setAttribute('aria-describedby', 'tagStyleHideDesc');
                input.addEventListener('change', () => setHidden(current, picked, input.checked));
                const text = el('span', 'je-ta-switch-text');
                const nameEl = el('span', 'je-ta-switch-name', hideName(current, picked));
                nameEl.id = 'tagStyleHideName';
                text.appendChild(nameEl);
                // Scope, not help: it stays when the page hides descriptions.
                const desc = el('span', 'je-ts-hide-scope', hideDescription(current, picked));
                desc.id = 'tagStyleHideDesc';
                text.appendChild(desc);
                sw.appendChild(input);
                sw.appendChild(text);
                box.appendChild(sw);
                if (coveredBy(current, picked.key)) box.appendChild(coveredLine());
                // An age board's every rating, on request (the switch reads only the short sentence).
                const ratings = current === 'ageRating' ? (((cat.age || []).find((a) => a.id === picked.key) || {}).ratings || []) : [];
                if (ratings.length > 3) {
                    const more = el('details', 'je-ts-hide-ratings');
                    more.dataset.jeInfo = '';
                    const summary = el('summary');
                    const icon = el('i', 'material-icons', 'expand_more');
                    icon.setAttribute('aria-hidden', 'true');
                    summary.append(icon, T('Show all {count} ratings', { count: ratings.length }));
                    more.appendChild(summary);
                    more.appendChild(el('p', 'je-ts-hide-ratings-list', ratings.map(nb).join(', ')));
                    box.appendChild(more);
                }
            });
        }

        /** @returns {void} */
        function renderRows() {
            const rows = root.querySelector('#tagStyleRows');
            // A control drawn disabled (Default after a reset) hands focus to its row's first control.
            rebuildKeepingFocus(rows, () => buildRows(rows), (key) => {
                const field = key.split(':')[0];
                const row = Array.from(rows.querySelectorAll('.je-ts-field-row')).find((r) => r.dataset.field === field);
                return row ? row.querySelector('button:not([disabled]), input') : null;
            });
        }

        /** @param {Element} rows @returns {void} */
        function buildRows(rows) {
            rows.textContent = '';
            const colours = targetColours();
            const own = targetEntry();
            const shared = target === ALL ? {} : (state.groups[current] || {});
            fieldsOf(current).forEach(([field, name]) => {
                const varies = !colours[field];
                const c = parse(colours[field] || 'rgba(0, 0, 0, 0)');
                const alpha = c.a > 0 && !varies ? c.a : 1;
                const shownName = current === 'genre' && field === 'text' ? T('Icon') : name;
                const sentenceName = current === 'genre' && field === 'text' ? IN_SENTENCE.icon : IN_SENTENCE[field];
                const row = el('div', 'je-ts-field-row');
                row.dataset.field = field;
                // The row reads as its value: the colour, its opacity and where it comes from.
                const head = el('div', 'je-ts-field-head');
                head.appendChild(el('span', 'je-ts-row-name', shownName));
                const now = el('span', 'je-ts-swatch je-ts-swatch-current' + (varies ? ' je-ts-swatch-varies' : ''));
                if (!varies) now.style.setProperty('--je-ts-swatch', colours[field]);
                now.setAttribute('aria-hidden', 'true');
                head.appendChild(now);
                const from = own[field] ? T('set here') : shared[field] ? T('from the group') : T('from the preset');
                head.appendChild(el('span', 'je-ts-value', varies ? T('Varies by label') : T('{hex} · {percent}% · {from}', { hex: toHex(c), percent: Math.round(c.a * 100), from })));
                const open = openField === field;
                const bodyId = 'tagStyleField-' + field;
                const edit = el('button', 'je-ts-edit', open ? T('Done') : T('Change'));
                edit.type = 'button';
                edit.setAttribute('aria-expanded', String(open));
                edit.setAttribute('aria-controls', bodyId);
                edit.setAttribute('aria-label', T(open ? 'Done changing {name}' : 'Change {name}', { name: sentenceName }));
                edit.dataset.tsKey = field + ':edit';
                edit.addEventListener('click', () => { openField = open ? null : field; renderRows(); });
                head.appendChild(edit);
                const reset = el('button', 'je-ts-reset', T('Reset'));
                reset.type = 'button';
                reset.disabled = !own[field];
                reset.dataset.tsKey = field + ':reset';
                reset.setAttribute('aria-label', T('Reset {name}', { name: sentenceName }));
                reset.title = target === ALL ? T('Back to the preset colour') : T('Back to the group or preset colour');
                reset.addEventListener('click', () => setField(field, null));
                head.appendChild(reset);
                row.appendChild(head);
                // One property's palette open at a time.
                const body = el('div', 'je-ts-field-body');
                body.id = bodyId;
                body.hidden = !open;
                body.setAttribute('role', 'group');
                body.setAttribute('aria-label', shownName);
                const list = el('div', 'je-ts-swatches');
                SWATCHES.forEach((hex) => {
                    const b = el('button', 'je-ts-swatch');
                    b.type = 'button';
                    b.style.setProperty('--je-ts-swatch', hex);
                    b.setAttribute('aria-label', T('{name} {hex}', { name, hex }));
                    b.dataset.tsKey = field + ':swatch:' + hex;
                    b.title = hex;
                    const picked = !!own[field] && toHex(parse(own[field])) === hex;
                    if (picked) b.classList.add('active');
                    b.setAttribute('aria-pressed', String(picked));
                    b.addEventListener('click', () => setField(field, toCss(Object.assign(parse(hex), { a: alpha }))));
                    list.appendChild(b);
                });
                const any = document.createElement('input');
                any.type = 'color';
                any.className = 'je-ts-any';
                any.value = toHex(c);
                any.setAttribute('aria-label', T('Any {name} colour', { name: IN_SENTENCE[field] }));
                any.dataset.tsKey = field + ':any';
                any.addEventListener('input', () => setField(field, toCss(Object.assign(parse(any.value), { a: alpha })), true));
                any.addEventListener('change', () => setField(field, toCss(Object.assign(parse(any.value), { a: alpha }))));
                list.appendChild(any);
                body.appendChild(list);
                const opacityRow = el('div', 'je-ts-opacity-row');
                opacityRow.appendChild(el('span', 'je-ts-opacity-label', T('Opacity')));
                const opacity = el('div', 'je-ts-opacity');
                opacity.setAttribute('role', 'group');
                opacity.setAttribute('aria-label', T('{name} opacity', { name }));
                OPACITIES.forEach((pct) => {
                    const on = !varies && Math.round(c.a * 100) === pct;
                    const b = el('button', 'je-ts-pill je-ts-opacity-pill' + (on ? ' active' : ''), pct + '%');
                    b.type = 'button';
                    b.setAttribute('aria-pressed', String(on));
                    b.dataset.tsKey = field + ':opacity:' + pct;
                    // A colour that varies by label has no single value to fade: pick one first.
                    b.disabled = varies;
                    if (varies) b.title = T('Pick a colour first');
                    b.addEventListener('click', () => setField(field, toCss(Object.assign({}, c, { a: pct / 100 }))));
                    opacity.appendChild(b);
                });
                opacityRow.appendChild(opacity);
                body.appendChild(opacityRow);
                if (varies) body.appendChild(el('span', 'je-ts-opacity-note', T('Choose a colour to set its opacity')));
                row.appendChild(body);
                rows.appendChild(row);
            });
        }

        /**
         * Under the Poster preset, the contrast of a label whose text or background comes from
         * the artwork: the worst case over the normalisation band (the server's figure when both
         * come from it; with one field set here, the lowest over a sweep of the band's colours).
         * @param {{key: string}} label
         * @returns {number|null} Null when neither field comes from the artwork.
         */
        function posterContrast(label) {
            if (presetOf(current) !== 'poster' || (current === 'language' && label.key === 'flag')) return null;
            const own = state.labels[labelKey(current, label.key)] || {};
            const shared = state.groups[current] || {};
            const text = own.text || shared.text;
            const background = own.background || shared.background;
            if (text && background) return null;
            if (!text && !background) return (cat.poster && cat.poster.worstContrast) || 4.5;
            const je = window.JellyfinEnhanced;
            const normalise = je && je.tagPosterColours && je.tagPosterColours.normalise;
            if (typeof normalise !== 'function') return 1;
            let worst = 21;
            // Dominant colours around the hue circle, dark to light: every band colour a poster can give.
            for (let hue = 0; hue < 360; hue += 10) {
                for (const [s, l] of [[1, 0.15], [1, 0.3], [1, 0.5], [0.6, 0.7], [1, 0.85]]) {
                    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((hue / 60) % 2) - 1)), m = l - c / 2;
                    const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
                    const band = normalise([Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]);
                    const css = (v) => 'rgb(' + v.join(', ') + ')';
                    const ratio = contrastRatio(text || css(band.text), background || css(band.background));
                    if (ratio !== null) worst = Math.min(worst, ratio);
                }
            }
            return worst;
        }

        /** @returns {void} */
        function renderContrast() {
            const box = root.querySelector('#tagStyleContrast');
            box.textContent = '';
            if (current === 'language' && target === 'flag') return;
            // One label: its own contrast. Whole group: the label that reads worst. Under Poster, a
            // label whose text or background comes from the artwork counts with its worst case over
            // any artwork, a label with both set here with its own colours.
            let worst = null;
            let sampled = false;
            (target === ALL ? labelsOf(current) : [{ key: target }]).forEach((label) => {
                let ratio = posterContrast(label);
                const poster = ratio !== null;
                if (poster) sampled = true;
                else {
                    const c = effective(current, label.key);
                    ratio = contrastRatio(c.text, c.background);
                }
                if (ratio !== null && (!worst || ratio < worst.ratio)) worst = { ratio, name: label.name, key: label.key, poster };
            });
            if (!worst) return;
            const grade = contrastLevel(worst.ratio);
            // Every group has a lowest tag, so the whole group only speaks up when one is hard to read. A single tag always shows its rating.
            if (target === ALL && grade.level !== 'low') return;
            // The ratio in the interface language's numbers (8,1:1 in German), as every other number the tab shows.
            let ratioText = worst.ratio.toFixed(1);
            try { ratioText = new Intl.NumberFormat(JE.core?.mediaLanguage?.uiLocale?.() || undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(worst.ratio); } catch { /* keep the plain form */ }
            const badge = el('span', 'je-ts-contrast-badge je-ts-contrast-' + grade.level, grade.label + ' · ' + ratioText + ':1');
            badge.dataset.level = grade.level;
            if (sampled) badge.dataset.poster = worst.poster ? 'worst' : 'fixed';
            box.appendChild(badge);
            const hint = target === ALL ? T('Lowest in the group ({name}): text over background, on a dark poster', { name: worst.name }) : T('Text over background, on a dark poster');
            box.appendChild(el('span', 'je-ts-contrast-hint', !sampled ? hint
                : worst.poster ? T('Worst case over any artwork: Poster takes each tag\'s colours from the poster it sits on, so this is the lowest contrast the poster colours can give')
                : T('{hint}. Its colours are all set here; tags without their own take them from the poster they sit on', { hint })));
            // Whole group: open the tag that reads worst (choosing it changes nothing).
            if (target === ALL && worst.key) {
                const inspect = el('button', 'je-ts-inspect', T('Inspect {name}', { name: worst.name }));
                inspect.type = 'button';
                inspect.addEventListener('click', () => { target = worst.key; targetsOpen = true; renderGroup(); root.querySelector('#tagStyleTargets .je-ts-target[tabindex="0"]')?.focus(); });
                box.appendChild(inspect);
            }
        }

        /**
         * The tag being edited, drawn in its current colours next to its controls (Whole
         * group: the tag that is hard to read, else the first).
         * @returns {void}
         */
        function renderSample() {
            const box = root.querySelector('#tagStyleSample');
            if (!box) return;
            box.textContent = '';
            const labels = labelsOf(current);
            let label = target === ALL ? null : labels.find((l) => l.key === target);
            let weak = false;
            if (!label) {
                let low = null;
                labels.forEach((l) => {
                    const c = effective(current, l.key);
                    const ratio = contrastRatio(c.text, c.background);
                    if (ratio !== null && (!low || ratio < low.ratio)) low = { ratio, l };
                });
                weak = !!low && contrastLevel(low.ratio).level === 'low';
                // The first label is not the typical one (R18+ sits in the plain unrated colour group, 1080i comes before
                // 1080p), so the group sample shows PG-13 and 1080p.
                const typical = { ageRating: 'PG-13', quality: '1080p' }[current];
                const shown = labels.filter((l) => !isHidden(current, l.key));
                label = weak ? low.l : (typical && shown.find((l) => l.name === typical)) || shown[0] || labels[0];
            }
            if (!label) return;
            const hidden = target !== ALL && (isHidden(current, label.key) || coveredBy(current, label.key));
            const picked = target !== ALL && labels.some((l) => l.key === target);
            box.classList.toggle('je-ts-sample-hidden', hidden);
            box.appendChild(chip(current, label, effective(current, label.key)));
            box.appendChild(el('span', 'je-ts-sample-note', target !== ALL ? (picked ? T('Editing this tag') : T('Sample tag')) : T(weak ? 'Lowest-contrast sample' : 'Sample tag')));
        }

        /** The select that gives the open group a preset of its own. @returns {void} */
        function renderGroupPreset() {
            const select = /** @type {HTMLSelectElement|null} */ (root.querySelector('#tagStyleGroupPreset'));
            if (!select) return;
            const label = root.querySelector('#tagStyleGroupPresetLabel');
            if (label) label.textContent = T('Preset for this group');
            select.setAttribute('aria-labelledby', 'tagStyleGroupPresetLabel');
            select.innerHTML = '<option value="">' + T('Same as the design ({name})', { name: PRESET_TITLES[state.preset] || state.preset }) + '</option>'
                + cat.presets.map((id) => '<option value="' + id + '">' + (PRESET_TITLES[id] || id) + '</option>').join('');
            select.value = state.groupPresets[current] || '';
            select.onchange = () => {
                if (select.value) state.groupPresets[current] = select.value;
                else delete state.groupPresets[current];
                render();
            };
        }

        /** @returns {void} */
        function renderGroup() {
            renderGroupPreset();
            renderTargets();
            renderHideRow();
            const note = NOTES[current] ? T(NOTES[current]) : '';
            root.querySelector('#tagStyleGroupNote').textContent = [presetOf(current) === 'poster' && (current !== 'language' || target !== 'flag') ? POSTER_NOTE : '', note].filter(Boolean).join(' ');
            renderRows();
            renderContrast();
            renderSample();
        }

        /**
         * The editor's effective colours in the web model's shape (GET tag-styles), for the
         * shared stylesheet generator.
         * @returns {Object}
         */
        function webModel() {
            const web = (c) => ({ background: c.background, border: c.border, color: c.text });
            const map = (g) => {
                const out = {};
                labelsOf(g).forEach((l) => { out[l.key] = web(effective(g, l.key)); });
                return out;
            };
            return {
                quality: map('quality'),
                age: labelsOf('ageRating').map((l) => Object.assign(
                    { ratings: ((cat.age.find((a) => a.id === l.key) || {}).ratings || []).slice() },
                    web(effective('ageRating', l.key)))),
                rating: map('rating'),
                genre: map('genre'),
                status: map('status'),
                awards: map('awards'),
                custom: Object.assign({ '*': web(effective('custom', ALL)) }, map('custom')),
                language: web(effective('language', 'code')),
                languageLabels: Object.fromEntries(labelsOf('language').map(({ key }) => [key, ['flag', 'code', 'subtitles', 'countBadge'].includes(key) ? web(effective('language', key)) : web(state.labels[labelKey('language', key)] || {})])),
                logos: map('logos')
            };
        }

        /**
         * A chip as the tag modules draw it (their element, classes and attributes), plus the
         * editor's look classes. Its colours come from the preview stylesheet, or with
         * `inline` (no generator on this page) from inline styles.
         * @param {string} g
         * @param {{key: string, name: string}} label
         * @param {boolean} inline
         * @returns {HTMLElement}
         */
        function productionChip(g, label, inline) {
            let n;
            if (g === 'quality') {
                n = el('div', 'quality-overlay-label je-ts-chip je-ts-q', label.name);
                n.dataset.quality = label.key;
            } else if (g === 'ageRating') {
                n = el('div', 'age-rating-tag je-ts-chip je-ts-age', label.name);
                n.setAttribute('rating', label.name);
            } else if (g === 'rating' && !['community', 'critic', 'userReview'].includes(label.key)) {
                n = sourceRatingChip(label);
            } else if (g === 'rating') {
                const [icon, text] = RATING_SAMPLES[label.key] || ['star', '8.1'];
                const kind = { community: 'rating-tag-tmdb', critic: 'rating-tag-critic', userReview: 'rating-tag-userreview je-userreview-tag' }[label.key] || 'rating-tag--source';
                n = el('div', 'rating-tag ' + kind + ' je-ts-chip je-ts-rate');
                if (label.key === 'community') n.appendChild(el('i', 'material-icons rating-star-icon je-ts-rate-icon', icon));
                else if (label.key === 'userReview') {
                    // The glyph sits inside: the review module's own icon rules set a font this page may not have.
                    const wrap = el('span', 'je-userreview-icon je-ts-rate-icon');
                    wrap.appendChild(el('i', 'material-icons je-ts-rate-icon', icon));
                    n.appendChild(wrap);
                }
                else if (label.key === 'critic') n.appendChild(el('i', 'rating-tomato-icon fresh je-ts-tomato'));
                else { n.dataset.jeRatingSource = label.key; n.appendChild(el('span', 'je-rating-source-logo', label.name)); }
                n.appendChild(el('span', 'rating-text', text));
            } else if (g === 'awards') {
                n = el('div', 'awards-tag je-ts-chip je-ts-rate', label.name.includes('250') ? T('Top 250') : label.name);
                n.dataset.jeAward = label.key;
            } else if (g === 'genre') {
                n = el('div', 'genre-tag je-ts-chip je-ts-genre');
                n.dataset.jeGenre = label.key;
                n.title = label.name;
                n.appendChild(genreGlyph(label.key));
            } else if (g === 'status') {
                n = el('div', 'status-tag status-tag--' + label.key + ' je-ts-chip je-ts-status');
                n.dataset.jeStatus = label.key;
                if (label.key === 'trending') {
                    // "#{rank} Today" with the rank in its own span, as the status module draws it.
                    const [before, after = ''] = T('#{rank} Today', { rank: '\u0001' }).split('\u0001');
                    const hash = before.endsWith('#') ? '#' : '';
                    n.append(before.slice(0, before.length - hash.length), el('span', 'status-tag-rank', hash + '3'), after);
                }
                else n.textContent = STATUS_SAMPLES[label.key] || label.name;
            } else if (g === 'logos') {
                n = el('span', 'je-logo-chip je-ts-chip je-ts-status', LOGO_SAMPLES[label.key] || label.name);
                n.dataset.jeLogoStyle = label.key;
            } else if (g === 'custom') {
                n = el('div', 'custom-tag je-ts-chip je-ts-custom');
                n.dataset.jeCustom = label.key;
                n.appendChild(el('span', 'custom-tag-text', label.name));
            } else if (g === 'language' && label.key !== 'flag') {
                n = languageSample(label);
            } else {
                n = el('img', 'language-flag je-ts-chip je-ts-flag');
                n.src = window.jeCdnUrl('flag-icons/flags/4x3/gb.svg');
                n.alt = '';
                n.dataset.lang = 'gb';
            }
            return inline ? paint(n, g, effective(g, label.key)) : n;
        }

        // The container class each group's chips sit in on a poster.
        const CONTAINERS = {
            quality: 'quality-overlay-container', ageRating: 'age-rating-overlay-container', rating: 'rating-overlay-container',
            genre: 'genre-overlay-container', status: 'status-overlay-container', language: 'language-overlay-container', awards: 'awards-overlay-container', logos: 'logo-overlay-container', custom: 'custom-overlay-container'
        };

        /**
         * Draws a synthetic card with chips in the default corners, each group in its
         * production container.
         * @param {string} cls
         * @param {string} title
         * @param {Object<string, Array<[string, string]>>} corners - corner → [group, label] list.
         * @param {boolean} inline - Paint inline (no stylesheet generator).
         * @returns {HTMLElement}
         */
        /**
         * Whether the preview leaves a sample chip out (it is hidden).
         * @param {string} g
         * @param {{key: string, name: string}} label
         * @returns {boolean}
         */
        function previewHides(g, label) {
            if (!hiddenStore) return false;
            if (g === 'ageRating') return hiddenList('ageRating').some((id) => (((cat.age || []).find((a) => a.id === id) || {}).ratings || []).includes(label.name));
            // The preview's flag stands for English.
            if (g === 'language' && label.key === 'flag') return isHidden('language', 'en');
            return isHidden(g, label.key);
        }

        /**
         * Sample genres for a preview card: its own, with hidden ones replaced by the next genres that show.
         * @param {string[]} own
         * @returns {string[]}
         */
        function previewGenres(own) {
            const pool = own.concat(labelsOf('genre').map((l) => l.key)).filter((k, i, a) => a.indexOf(k) === i && !(hiddenStore && isHidden('genre', k)));
            return pool.slice(0, own.length);
        }

        function card(cls, title, corners, inline) {
            const n = el('div', 'je-ts-card ' + cls);
            const art = el('div', 'je-ts-art');
            Object.keys(corners).forEach((corner) => {
                const stack = el('div', 'je-ts-corner je-ts-corner-' + corner);
                let box = null;
                corners[corner].forEach(([g, l]) => {
                    const label = labelsOf(g).find((x) => x.key === l || x.name === l);
                    // Hidden tags never show on posters, the preview's included.
                    if (!label || previewHides(g, label)) return;
                    if (!box || box.dataset.group !== g) {
                        box = el('div', CONTAINERS[g] + ' je-ts-corner-group');
                        box.dataset.group = g;
                        stack.appendChild(box);
                    }
                    box.appendChild(productionChip(g, label, inline));
                });
                art.appendChild(stack);
            });
            n.appendChild(art);
            n.appendChild(el('div', 'je-ts-card-title', title));
            return n;
        }

        /**
         * Redraws the preview: production-shaped chips styled by the web's own stylesheet
         * generator (tag-styles.js), limited to the preview so unsaved colours never reach
         * the rest of the page. A broken production selector breaks the preview too.
         * @returns {void}
         */
        function renderPreview() {
            const box = root.querySelector('#tagStylePreview');
            box.textContent = '';
            const je = window.JellyfinEnhanced;
            const generate = je && je.tagStyles && typeof je.tagStyles.buildCss === 'function' ? je.tagStyles.buildCss : null;
            box.dataset.styles = generate ? 'generated' : 'inline';
            if (generate) {
                const sheet = el('style');
                sheet.id = 'tagStylePreviewCss';
                sheet.textContent = generate(webModel(), '#tagStylePreview');
                box.appendChild(sheet);
            }
            const custom = labelsOf('custom').slice(0, 2).map((l) => ['custom', l.key]);
            box.appendChild(card('je-ts-card-movie', T('Movie'), {
                tl: [['quality', '4K'], ['quality', 'Dolby Vision'], ['quality', 'ATMOS']].concat(custom),
                tr: [['status', 'trending']].concat(previewGenres(GENRE_SAMPLES.movie).map((l) => ['genre', l])),
                bl: [['language', 'flag']],
                br: [['rating', 'critic'], ['rating', 'community'], ['ageRating', 'PG-13']]
            }, !generate));
            box.appendChild(card('je-ts-card-episode', T('Episode'), {
                tl: [['quality', '1080p'], ['quality', 'HEVC']],
                tr: [['status', 'newEpisode']].concat(previewGenres(GENRE_SAMPLES.episode).map((l) => ['genre', l])),
                bl: [['language', 'flag']],
                br: [['rating', 'userReview'], ['ageRating', 'R']]
            }, !generate));
        }

        /** @returns {void} */
        function render() {
            if (!cat) return;

            renderPresets();
            renderTabs();
            renderGroup();
            renderPreview();
        }

        /**
         * Reads a stored colour object into {background, border, text}, normalised.
         * @param {Object} o
         * @param {string} textKey - 'text' (version 2) or 'color' (version 1).
         * @returns {Object|null}
         */
        function readColours(o, textKey) {
            if (!o || typeof o !== 'object') return null;
            const out = {};
            [['background', 'background'], ['border', 'border'], ['text', textKey]].forEach(([f, k]) => {
                if (typeof o[k] === 'string' && o[k]) out[f] = norm(o[k]);
            });
            return Object.keys(out).length ? out : null;
        }

        /**
         * Migrates a version 1 document as the server does (TagStyleSet.ReadV1). The old editor stored
         * only differences from the built-in colours, with its presets baked in, and the web drew the
         * stored field, else the built-in one (rating chips had no border). Each stored catalog label
         * becomes exactly those colours and the preset becomes Default, so nothing is recoloured.
         * @param {Object} doc - The parsed version 1 document.
         * @returns {void}
         */
        function migrateV1(doc) {
            state = { preset: 'default', groupPresets: {}, groups: {}, labels: {} };
            [['quality', 'quality'], ['age', 'ageRating'], ['rating', 'rating'], ['genre', 'genre']].forEach(([section, g]) => {
                const entries = section === 'genre' ? { genre: doc.genre } : doc[section];
                if (!entries || typeof entries !== 'object') return;
                Object.keys(entries).forEach((l) => {
                    const o = entries[l];
                    // Of the rating chips version 1 only styled community and critic.
                    if ((section !== 'genre' && !labelsOf(g).some((x) => x.key === l)) || !labelsOf(g).length || (g === 'rating' && l === 'userReview') || !o || typeof o !== 'object') return;
                    const stored = {};
                    [['background', 'background'], ['border', 'border'], ['text', 'color']].forEach(([f, k]) => {
                        const c = (g !== 'rating' || f !== 'border') && typeof o[k] === 'string' ? parseColour(o[k]) : null;
                        if (c) stored[f] = toCss(c);
                    });
                    if (!Object.keys(stored).length) return;
                    const builtin = palette('default', g, section === 'genre' ? labelsOf(g)[0].key : l);
                    const out = {};
                    fieldsOf(g).forEach(([f]) => {
                        if (g === 'rating' && f === 'border') return;
                        const v = stored[f] || builtin[f];
                        if (v) out[f] = v;
                    });
                    // Version 1 coloured every genre chip alike: that is the genre group now.
                    if (section === 'genre') state.groups.genre = out;
                    else state.labels[labelKey(g, l)] = out;
                });
            });
        }

        /**
         * Migrates the loaded version 1 document, remembering both snapshots (see snapshot()).
         * @param {string} json - The document as stored.
         * @param {Object} doc - The same, parsed.
         * @returns {void}
         */
        function migrateLoaded(json, doc) {
            migrateV1(doc);
            migrated = { from: json + '|default', to: serialize() + '|' + state.preset };
        }

        /**
         * Loads the stored document (version 1 or 2) and preset. A version 1 document is migrated
         * once the catalog is in; until then serialize() hands it back untouched (the server
         * migrates it the same way).
         * @param {string} json
         * @param {string} preset
         * @returns {void}
         */
        function load(json, preset) {
            state = { preset: PRESET_TITLES[preset] ? preset : 'default', groupPresets: {}, groups: {}, labels: {} };
            // The group and label being edited stay when the page loads the stored document again
            // (after a save the server normalised, or the page shown again).
            if (!GROUPS.some((g) => g.key === current)) current = 'quality';
            if (target !== ALL && !labelsOf(current).some((l) => l.key === target)) target = ALL;
            legacy = null;
            migrated = null;
            try {
                const p = json ? JSON.parse(json) : {};
                if (p && p.v === 2) {
                    Object.keys(p.groupPresets || {}).forEach((g) => { if (GROUPS.some((x) => x.key === g) && PRESET_TITLES[p.groupPresets[g]]) state.groupPresets[g] = p.groupPresets[g]; });
                    Object.keys(p.groups || {}).forEach((g) => { const c = readColours(p.groups[g], 'text'); if (c) state.groups[g] = c; });
                    Object.keys(p.labels || {}).forEach((k) => { const c = readColours(p.labels[k], 'text'); if (c) state.labels[k] = c; });
                    // The one genre label older documents held coloured every genre: fold it onto the
                    // group, as the server reads it; the fold alone is no unsaved change.
                    const legacyGenre = state.labels[LEGACY_GENRE];
                    if (legacyGenre) {
                        delete state.labels[LEGACY_GENRE];
                        state.groups.genre = Object.assign({}, state.groups.genre, legacyGenre);
                        migrated = { from: json + '|' + state.preset, to: serialize() + '|' + state.preset };
                    }
                } else if (p && typeof p === 'object' && !Array.isArray(p) && Object.keys(p).length) {
                    state.preset = 'default';
                    if (cat) migrateLoaded(json, p); else legacy = { json, doc: p };
                }
            } catch (e) { /* unreadable value: start clean */ }
            if (!cat) {
                ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('JellyfinEnhanced/tag-styles/catalog'), dataType: 'json' }).then((c) => {
                    if (!isCurrent()) return;
                    cat = c;
                    if (legacy) { const l = legacy; legacy = null; migrateLoaded(l.json, l.doc); }
                    render();
                }).catch(() => {
                    if (!isCurrent()) return;
                    root.querySelector('#tagStylePresets').textContent = T('Could not load the tag list.');
                });
            }
            render();
        }

        /**
         * What the unsaved-changes check compares: the stored document and the preset. A version 1
         * document migrated on load still reads as loaded, so the migration alone is no change.
         * @returns {string}
         */
        function snapshot() {
            const now = serialize() + '|' + state.preset;
            return migrated && now === migrated.to ? migrated.from : now;
        }

        /**
         * Entries in the order the server stores them (TagStyleSet.Serialize: keys in ordinal order, fields
         * background, border, text), so a save comes back unchanged instead of reading as a server-side
         * normalisation, which redraws the page (and this editor) from the stored value.
         * @param {Object} map - Group or label key → colours.
         * @returns {Object}
         */
        function canonical(map) {
            const out = {};
            Object.keys(map).sort().forEach((key) => {
                const c = {};
                FIELDS.forEach(([f]) => { if (map[key][f]) c[f] = map[key][f]; });
                out[key] = c;
            });
            return out;
        }

        /** @returns {string} The stored document, or '' when nothing is overridden. */
        function serialize() {
            if (legacy) return legacy.json;
            if (!Object.keys(state.groupPresets).length && !Object.keys(state.groups).length && !Object.keys(state.labels).length) return '';
            const out = { v: 2, preset: state.preset };
            if (Object.keys(state.groupPresets).length) out.groupPresets = Object.fromEntries(Object.keys(state.groupPresets).sort().map((g) => [g, state.groupPresets[g]]));
            if (Object.keys(state.groups).length) out.groups = canonical(state.groups);
            if (Object.keys(state.labels).length) out.labels = canonical(state.labels);
            return JSON.stringify(out);
        }

        const settings = () => ({ preset: state.preset });

        return { load, serialize, settings, snapshot,
            /** Redraw after the hidden lists changed elsewhere (another administrator, an import, Undo). */
            refreshHidden() { if (cat) refreshHiddenViews(); },
            /** Say, beside the colour rows, that tag colours are off (null hides the note). @param {string|null} text */
            setColoursOffNote(off, focusSwitch) {
                const note = root.querySelector('#tagStyleOffRowNote');
                if (!note) return;
                note.hidden = !off;
                if (!off) { note.textContent = ''; return; }
                // The switch's name is a way to it (it never turns colours on: that recolours every poster).
                const icon = el('i', 'material-icons', 'info');
                icon.setAttribute('aria-hidden', 'true');
                const go = el('a', 'je-ta-link je-ts-inline-link', T('Use tag colours'));
                go.href = '#tagStylesEnabled';
                go.addEventListener('click', (e) => { e.preventDefault(); focusSwitch?.(); });
                const text = el('span');
                text.append(T('Tag colours are off: these colours show once '), go, T(' is on.'));
                note.replaceChildren(icon, text);
            },
            /** Open a group with its tag list (Groups tab pointers). @param {string} group */
            openGroup(group) {
                if (!GROUPS.some((g) => g.key === group)) return;
                current = group; filter = ''; targetsOpen = true;
                // The link names hidden tags: land on the first one (its switch, on, right below), else Whole group.
                const first = hiddenStore ? labelsOf(group).find((l) => isHidden(group, l.key)) : null;
                target = first ? first.key : ALL;
                if (cat) { renderTabs(); renderGroup(); }
                // The group's tab row at the top, clear of the sticky header (the page's scroll margin); focus does not scroll again.
                const tab = root.querySelector('#tagStyleTab-' + group);
                const tabsRow = root.querySelector('#tagStyleTabs');
                (tab && tab.offsetParent ? tab : root.querySelector('#tagStyleGroupSelect') || tabsRow)?.scrollIntoView?.({ block: 'start' });
                (root.querySelector('#tagStyleTargets .je-ts-target[tabindex="0"]') || tab)?.focus?.({ preventScroll: true });
            },
            refreshLabels() { if (current === 'custom' && target !== ALL && !labelsOf('custom').some((l) => l.key === target)) target = ALL; render(); } };
    }

    JE.adminTags = JE.adminTags || {};
    JE.adminTags.EDITOR_HTML = EDITOR_HTML;
    JE.adminTags.createTagStylesEditor = createTagStylesEditor;
})(window.JellyfinEnhanced);
