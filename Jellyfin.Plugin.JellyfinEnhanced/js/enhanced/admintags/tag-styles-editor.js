/**
 * @file The Tag Styles editor of the Media Tags admin page (Colours tab):
 * preset tiles, group tabs, editing targets, Background/Border/Text rows,
 * the contrast badge and a live preview. Moved from the main configuration
 * page with its behaviour unchanged; it now builds over EDITOR_HTML inside
 * the page and looks its elements up there. Apply to (TagStyleTarget) is a
 * field of the Colours section (sections/colours.js), which also owns the
 * switches around the editor, Reset all colours and saving.
 */
(function(JE) {
    'use strict';

    /** The editor's markup (the old configuration page's, without the controls the Colours section owns). */
    const EDITOR_HTML = `
        <div id="tagStyleEditor" class="je-ts-editor">
            <div class="je-ts-section-label" id="tagStylePresetLabel"></div>
            <div id="tagStylePresets" class="je-ts-presets" role="radiogroup" aria-labelledby="tagStylePresetLabel"><div class="je-ta-hint"></div></div>
            <div id="tagStyleTabs" class="je-ts-tabs" role="tablist"></div>
            <div id="tagStyleGroupPanel" class="je-ts-group-panel" role="tabpanel">
                <div class="je-ts-section-label" id="tagStyleTargetsLabel"></div>
                <div id="tagStyleTargets" class="je-ts-targets" role="radiogroup" aria-labelledby="tagStyleTargetsLabel"></div>
                <div id="tagStyleGroupNote" class="je-ts-note"></div>
                <div id="tagStyleRows" class="je-ts-rows"></div>
                <div id="tagStyleContrast" class="je-ts-contrast" role="status" aria-live="polite"></div>
            </div>
            <div class="je-ts-section-label" id="tagStylePreviewLabel"></div>
            <div id="tagStylePreview" class="je-ts-preview" aria-hidden="true"></div>
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
    function createTagStylesEditor(root, customLabels = () => [], isCurrent = () => true) {

        const GROUPS = [
            { key: 'quality', title: 'Quality' }, { key: 'ageRating', title: 'Age' }, { key: 'rating', title: 'Rating' },
            { key: 'genre', title: 'Genre' }, { key: 'status', title: 'Status' }, { key: 'language', title: 'Language' }, { key: 'awards', title: 'Awards' },
            { key: 'logos', title: 'Logos' },
            { key: 'custom', title: 'Custom' }
        ];
        const PRESET_TITLES = { default: 'Default', glass: 'Glass', outline: 'Outline', dark: 'Dark', light: 'Light', mono: 'Mono', poster: 'Poster' };
        const FIELDS = [['background', 'Background'], ['border', 'Border'], ['text', 'Text']];
        const SWATCHES = ['#1e88e5', '#ef6c00', '#2e7d32', '#546e7a', '#8e24aa', '#ffd166', '#ff6b6b', '#111111', '#ffffff', '#e0e0e0'];
        const OPACITIES = [40, 60, 80, 100];
        const POSTER_NOTE = 'Poster: each tag takes its background from the artwork it sits on (white or black text, whichever reads better). Colours set here stay on top; Default falls back to the artwork. The preview shows a red poster.';
        const NOTES = {
            genre: 'Text colours the genre icon.',
            status: 'Status badges use the same colours on web cards and native posters.',
            language: 'Flags are images, so only the border ring can be coloured. Partial dubs keep their dashed outline.',
            logos: 'Colours the pill behind a logo, or the name chip a logo without an image shows (Text colours the name).',
            custom: 'One target per label of the Custom tag rules above (labels shared by several rules share their colours). The icon takes the text colour.'
        };
        const LOGO_SAMPLES = { provider: 'Stream', company: 'Studio', text: 'HBO' };
        const RATING_SAMPLES = { community: ['star', '8.1'], critic: [null, '85%'], userReview: ['favorite', '9'], imdb: [null, '8.1'], tmdb: [null, '81%'], rtCritic: [null, '92%'], rtAudience: [null, '88%'], metacritic: [null, '74'], letterboxd: [null, '4.1'], trakt: [null, '85%'] };
        const STATUS_SAMPLES = { added: 'Just Added', newMovie: 'New Movie', newSeries: 'New Series', newEpisode: 'New Episode', trending: '#3 Today' };
        const ALL = '*';

        let cat = null;
        let state = { preset: 'default', groups: {}, labels: {} };
        let current = 'quality';
        let target = ALL;
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
            if (ratio >= 3) return { level: 'large', label: 'AA large only' };
            return { level: 'low', label: 'Low contrast' };
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

        // Custom labels are the rules table's, unsaved edits included.
        const labelsOf = (g) => (g === 'custom'
            ? customLabels().map((l) => ({ key: l, name: l }))
            : (cat && cat.groups[g]) || []);
        const labelKey = (g, l) => g + ':' + l;
        const fieldsOf = (g) => (g === 'language' ? FIELDS.filter(([f]) => f === 'border') : FIELDS);

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
            const pal = palette(state.preset, g, l);
            const out = {};
            FIELDS.forEach(([f]) => { out[f] = own[f] || shared[f] || pal[f]; });
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
                const values = new Set(labelsOf(current).map((l) => palette(state.preset, current, l.key)[f]));
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
        function setField(field, css) {
            const bag = target === ALL ? state.groups : state.labels;
            const key = target === ALL ? current : labelKey(current, target);
            const o = Object.assign({}, bag[key] || {});
            if (css) o[field] = norm(css); else delete o[field];
            if (Object.keys(o).length) bag[key] = o; else delete bag[key];
            renderGroup();
            renderPreview();
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
            if (g !== 'language') {
                n.style.background = c.background || '';
                n.style.color = c.text || '';
            }
            if (g === 'rating' || g === 'language') {
                const ring = c.border && parse(c.border).a > 0;
                n.style.outline = ring ? '1px solid ' + c.border : '';
                n.style.outlineOffset = ring ? '-1px' : '';
            } else {
                n.style.borderColor = c.border || '';
            }
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
                n = el('div', 'awards-tag je-ts-chip je-ts-rate', label.name.includes('250') ? 'Top 250' : label.name);
                n.dataset.jeAward = label.key;
            } else if (g === 'genre') {
                n = el('span', 'je-ts-chip je-ts-genre genre-tag');
                n.appendChild(el('i', 'material-icons', 'theaters'));
            } else if (g === 'status') {
                n = el('span', 'je-ts-chip je-ts-status status-tag', STATUS_SAMPLES[label.key] || label.name);
            } else if (g === 'logos') {
                n = el('span', 'je-ts-chip je-ts-status je-logo-chip', LOGO_SAMPLES[label.key] || label.name);
                n.dataset.jeLogoStyle = label.key;
            } else if (g === 'custom') {
                n = el('span', 'je-ts-chip je-ts-custom custom-tag', label.name);
            } else if (label.key === 'countBadge' || label.key === 'subtitles') {
                n = el('span', 'je-ts-chip language-chip', label.key === 'subtitles' ? 'CC EN' : 'Multi');
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
            bar.textContent = '';
            const age = labelsOf('ageRating').find((l) => l.name === 'PG-13') || labelsOf('ageRating')[0];
            cat.presets.forEach((id) => {
                const tile = radio('je-ts-preset', state.preset === id, () => { state.preset = id; render(); });
                tile.dataset.preset = id;
                tile.appendChild(el('span', 'je-ts-preset-title', PRESET_TITLES[id] || id));
                const mini = el('span', 'je-ts-preset-chips');
                mini.appendChild(chip('quality', { key: '4K', name: '4K' }, palette(id, 'quality', '4K')));
                mini.appendChild(chip('rating', { key: 'community', name: 'Community' }, palette(id, 'rating', 'community')));
                if (age) mini.appendChild(chip('ageRating', age, palette(id, 'ageRating', age.key)));
                tile.appendChild(mini);
                bar.appendChild(tile);
            });
        }

        /** @returns {void} */
        function renderTabs() {
            const tabs = root.querySelector('#tagStyleTabs');
            tabs.textContent = '';
            GROUPS.forEach((g) => {
                const b = el('button', 'je-ts-tab' + (g.key === current ? ' active' : ''), g.title);
                b.type = 'button';
                b.setAttribute('role', 'tab');
                b.setAttribute('aria-selected', String(g.key === current));
                b.dataset.group = g.key;
                b.addEventListener('click', () => { current = g.key; target = ALL; renderTabs(); renderGroup(); });
                tabs.appendChild(b);
            });
        }

        /** @returns {void} */
        function renderTargets() {
            const box = root.querySelector('#tagStyleTargets');
            box.textContent = '';
            const all = radio('je-ts-target je-ts-target-all' + (state.groups[current] ? ' changed' : ''), target === ALL, () => { target = ALL; renderGroup(); });
            all.textContent = 'Whole group';
            all.dataset.label = ALL;
            box.appendChild(all);
            labelsOf(current).forEach((label) => {
                const changed = !!state.labels[labelKey(current, label.key)];
                const cell = radio('je-ts-target' + (changed ? ' changed' : ''), target === label.key, () => { target = label.key; renderGroup(); });
                cell.dataset.label = label.key;
                cell.title = current === 'ageRating'
                    ? 'Applies to: ' + ((cat.age.find((a) => a.id === label.key) || {}).ratings || []).join(', ')
                    : label.name;
                cell.setAttribute('aria-label', current === 'ageRating' ? label.name + ' board' : label.name);
                cell.appendChild(chip(current, label, effective(current, label.key)));
                box.appendChild(cell);
            });
        }

        /** @returns {void} */
        function renderRows() {
            const rows = root.querySelector('#tagStyleRows');
            rows.textContent = '';
            const colours = targetColours();
            const own = targetEntry();
            fieldsOf(current).forEach(([field, name]) => {
                const varies = !colours[field];
                const c = parse(colours[field] || 'rgba(0, 0, 0, 0)');
                const alpha = c.a > 0 && !varies ? c.a : 1;
                const row = el('div', 'je-ts-field-row');
                row.dataset.field = field;
                row.appendChild(el('span', 'je-ts-row-name', current === 'genre' && field === 'text' ? 'Icon' : name));
                const now = el('span', 'je-ts-swatch je-ts-swatch-current' + (varies ? ' je-ts-swatch-varies' : ''));
                if (!varies) now.style.setProperty('--je-ts-swatch', colours[field]);
                now.title = varies ? 'Varies by label' : 'Now: ' + colours[field];
                row.appendChild(now);
                const list = el('div', 'je-ts-swatches');
                SWATCHES.forEach((hex) => {
                    const b = el('button', 'je-ts-swatch');
                    b.type = 'button';
                    b.style.setProperty('--je-ts-swatch', hex);
                    b.setAttribute('aria-label', name + ' ' + hex);
                    b.title = hex;
                    if (own[field] && toHex(parse(own[field])) === hex) b.classList.add('active');
                    b.addEventListener('click', () => setField(field, toCss(Object.assign(parse(hex), { a: alpha }))));
                    list.appendChild(b);
                });
                const any = document.createElement('input');
                any.type = 'color';
                any.className = 'je-ts-any';
                any.value = toHex(c);
                any.setAttribute('aria-label', 'Any ' + name.toLowerCase() + ' colour');
                any.addEventListener('input', () => setField(field, toCss(Object.assign(parse(any.value), { a: alpha }))));
                list.appendChild(any);
                row.appendChild(list);
                const opacity = el('div', 'je-ts-opacity');
                opacity.setAttribute('role', 'group');
                opacity.setAttribute('aria-label', name + ' opacity');
                OPACITIES.forEach((pct) => {
                    const on = !varies && Math.round(c.a * 100) === pct;
                    const b = el('button', 'je-ts-pill je-ts-opacity-pill' + (on ? ' active' : ''), pct + '%');
                    b.type = 'button';
                    b.setAttribute('aria-pressed', String(on));
                    // A colour that varies by label has no single value to fade: pick one first.
                    b.disabled = varies;
                    if (varies) b.title = 'Pick a colour first';
                    b.addEventListener('click', () => setField(field, toCss(Object.assign({}, c, { a: pct / 100 }))));
                    opacity.appendChild(b);
                });
                row.appendChild(opacity);
                const reset = el('button', 'je-ts-reset', 'Default');
                reset.type = 'button';
                reset.disabled = !own[field];
                reset.title = target === ALL ? 'Back to the preset colour' : 'Back to the group or preset colour';
                reset.addEventListener('click', () => setField(field, null));
                row.appendChild(reset);
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
            if (state.preset !== 'poster' || current === 'language') return null;
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
            if (current === 'language') return;
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
                if (ratio !== null && (!worst || ratio < worst.ratio)) worst = { ratio, name: label.name, poster };
            });
            if (!worst) return;
            const grade = contrastLevel(worst.ratio);
            const badge = el('span', 'je-ts-contrast-badge je-ts-contrast-' + grade.level, grade.label + ' · ' + worst.ratio.toFixed(1) + ':1');
            badge.dataset.level = grade.level;
            if (sampled) badge.dataset.poster = worst.poster ? 'worst' : 'fixed';
            box.appendChild(badge);
            const hint = target === ALL
                ? 'Lowest in the group (' + worst.name + '): text over background, on a dark poster'
                : 'Text over background, on a dark poster';
            const artwork = 'Poster takes each tag\'s colours from the poster it sits on, so this is the lowest contrast the poster colours can give';
            box.appendChild(el('span', 'je-ts-contrast-hint', !sampled ? hint
                : worst.poster ? 'Worst case over any artwork: ' + artwork
                : hint + '. Its colours are all set here; tags without their own take them from the poster they sit on'));
        }

        /** @returns {void} */
        function renderGroup() {
            renderTargets();
            root.querySelector('#tagStyleGroupNote').textContent = [state.preset === 'poster' && current !== 'language' ? POSTER_NOTE : '', NOTES[current] || ''].filter(Boolean).join(' ');
            renderRows();
            renderContrast();
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
                genre: web(effective('genre', 'genre')),
                status: map('status'),
                awards: map('awards'),
                custom: Object.assign({ '*': web(effective('custom', ALL)) }, map('custom')),
                language: { border: effective('language', 'flag').border },
                languageLabels: Object.fromEntries(['flag', 'subtitles', 'countBadge'].map(key => [key, { border: effective('language', key).border }])),
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
                n = el('div', 'awards-tag je-ts-chip je-ts-rate', label.name.includes('250') ? 'Top 250' : label.name);
                n.dataset.jeAward = label.key;
            } else if (g === 'genre') {
                n = el('div', 'genre-tag je-ts-chip je-ts-genre');
                n.appendChild(el('i', 'material-icons', 'theaters'));
            } else if (g === 'status') {
                n = el('div', 'status-tag status-tag--' + label.key + ' je-ts-chip je-ts-status');
                n.dataset.jeStatus = label.key;
                if (label.key === 'trending') n.append(el('span', 'status-tag-rank', '#3'), ' Today');
                else n.textContent = STATUS_SAMPLES[label.key] || label.name;
            } else if (g === 'logos') {
                n = el('span', 'je-logo-chip je-ts-chip je-ts-status', LOGO_SAMPLES[label.key] || label.name);
                n.dataset.jeLogoStyle = label.key;
            } else if (g === 'custom') {
                n = el('div', 'custom-tag je-ts-chip je-ts-custom');
                n.dataset.jeCustom = label.key;
                n.appendChild(el('span', 'custom-tag-text', label.name));
            } else if (label.key === 'countBadge' || label.key === 'subtitles') {
                n = el('span', 'language-chip je-ts-chip', label.key === 'subtitles' ? 'CC EN' : 'Multi');
                n.dataset.jeLanguage = label.key;
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
        function card(cls, title, corners, inline) {
            const n = el('div', 'je-ts-card ' + cls);
            const art = el('div', 'je-ts-art');
            Object.keys(corners).forEach((corner) => {
                const stack = el('div', 'je-ts-corner je-ts-corner-' + corner);
                let box = null;
                corners[corner].forEach(([g, l]) => {
                    const label = labelsOf(g).find((x) => x.key === l || x.name === l);
                    if (!label) return;
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
            box.appendChild(card('je-ts-card-movie', 'Movie', {
                tl: [['quality', '4K'], ['quality', 'Dolby Vision'], ['quality', 'ATMOS']].concat(custom),
                tr: [['status', 'trending'], ['genre', 'genre']],
                bl: [['language', 'flag']],
                br: [['rating', 'critic'], ['rating', 'community'], ['ageRating', 'PG-13']]
            }, !generate));
            box.appendChild(card('je-ts-card-episode', 'Episode', {
                tl: [['quality', '1080p'], ['quality', 'HEVC']],
                tr: [['status', 'newEpisode']],
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
            state = { preset: 'default', groups: {}, labels: {} };
            [['quality', 'quality'], ['age', 'ageRating'], ['rating', 'rating'], ['genre', 'genre']].forEach(([section, g]) => {
                const entries = section === 'genre' ? { genre: doc.genre } : doc[section];
                if (!entries || typeof entries !== 'object') return;
                Object.keys(entries).forEach((l) => {
                    const o = entries[l];
                    // Of the rating chips version 1 only styled community and critic.
                    if (!labelsOf(g).some((x) => x.key === l) || (g === 'rating' && l === 'userReview') || !o || typeof o !== 'object') return;
                    const stored = {};
                    [['background', 'background'], ['border', 'border'], ['text', 'color']].forEach(([f, k]) => {
                        const c = (g !== 'rating' || f !== 'border') && typeof o[k] === 'string' ? parseColour(o[k]) : null;
                        if (c) stored[f] = toCss(c);
                    });
                    if (!Object.keys(stored).length) return;
                    const builtin = palette('default', g, l);
                    const out = {};
                    fieldsOf(g).forEach(([f]) => {
                        if (g === 'rating' && f === 'border') return;
                        const v = stored[f] || builtin[f];
                        if (v) out[f] = v;
                    });
                    state.labels[labelKey(g, l)] = out;
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
            state = { preset: PRESET_TITLES[preset] ? preset : 'default', groups: {}, labels: {} };
            current = 'quality';
            target = ALL;
            legacy = null;
            migrated = null;
            try {
                const p = json ? JSON.parse(json) : {};
                if (p && p.v === 2) {
                    Object.keys(p.groups || {}).forEach((g) => { const c = readColours(p.groups[g], 'text'); if (c) state.groups[g] = c; });
                    Object.keys(p.labels || {}).forEach((k) => { const c = readColours(p.labels[k], 'text'); if (c) state.labels[k] = c; });
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
                    root.querySelector('#tagStylePresets').textContent = 'Could not load the tag list.';
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

        /** @returns {string} The stored document, or '' when nothing is overridden. */
        function serialize() {
            if (legacy) return legacy.json;
            if (!Object.keys(state.groups).length && !Object.keys(state.labels).length) return '';
            const out = { v: 2, preset: state.preset };
            if (Object.keys(state.groups).length) out.groups = state.groups;
            if (Object.keys(state.labels).length) out.labels = state.labels;
            return JSON.stringify(out);
        }

        const settings = () => ({ preset: state.preset });

        return { load, serialize, settings, snapshot, refreshLabels() { if (current === 'custom' && target !== ALL && !labelsOf('custom').some((l) => l.key === target)) target = ALL; render(); } };
    }

    JE.adminTags = JE.adminTags || {};
    JE.adminTags.EDITOR_HTML = EDITOR_HTML;
    JE.adminTags.createTagStylesEditor = createTagStylesEditor;
})(window.JellyfinEnhanced);
