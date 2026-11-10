/**
 * @file The Tag Styles editor of the Media Tags admin tab (Colours tab):
 * preset tiles, group tabs, editing targets, Background/Border/Text rows,
 * the contrast badge and a live preview. It builds over EDITOR_HTML inside the
 * page and looks its elements up there. Apply to (TagStyleTarget) is a field of
 * the Colours section (sections/colours.js), which also owns the switches
 * around the editor, Reset all colours and saving.
 *
 * Editor state mirrors the stored document
 * { v: 2, preset, groupPresets?, groups?: {group: {background, border, text}}, labels?: {'group:label': {...}} }
 * (normalised rgba() strings, only what the admin set). The catalog brings every
 * preset's palette resolved per label, so each chip is drawn in its effective
 * colours: label override, else group override, else the preset.
 */
import type { JsonValue } from '../../../contracts/generated';
import { adminBridge, apiClient, cdnUrl } from './host';
import type { RatingSourceId } from '../types/ratings/rating-data';
import { allAs, activeElement, find, findAs } from './dom';
import { fmt } from './format';
import { contrastLevel, contrastRatio, compositeOver, luminance, rgbaOf, type Rgba } from './tag-style-contrast';
import { decodeCatalog, emptyState, ownOf, type Catalog, type ColourField, type Colours, type Label, type StyleState } from './tag-styles-model';
import type { CreateTagStylesEditor, TagStylesEditor } from './types';

const T = fmt;
const JE = adminBridge();

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
                <input id="tagStyleTargetFilter" class="je-ts-target-filter" type="search" autocomplete="off" hidden>
                <div id="tagStyleTargets" class="je-ts-targets" role="radiogroup" aria-labelledby="tagStyleTargetsLabel"></div>
                </div>
                <div id="tagStyleGroupNote" class="je-ts-note"></div>
                <div id="tagStyleRows" class="je-ts-rows"></div>
            </div>
            <button type="button" class="je-ts-preview-toggle" id="tagStylePreviewToggle" aria-expanded="false" aria-controls="tagStylePreview" data-je-info><span class="je-ts-section-label" id="tagStylePreviewLabel"></span><span class="je-ts-preview-toggle-name"></span><span class="material-icons" aria-hidden="true">expand_more</span></button>
            <div id="tagStylePreview" class="je-ts-preview" aria-hidden="true" hidden></div>
        </div>`;

const GROUPS: ReadonlyArray<{ key: string; title: string }> = [
    { key: 'quality', title: T('Quality') }, { key: 'ageRating', title: T('Age Rating') }, { key: 'rating', title: T('Rating') },
    { key: 'genre', title: T('Genre') }, { key: 'status', title: T('Status') }, { key: 'language', title: T('Language') }, { key: 'awards', title: T('Awards') },
    { key: 'logos', title: T('Logos') },
    { key: 'custom', title: T('Custom') },
];
const PRESET_TITLES: Readonly<Record<string, string>> = {
    default: T('Default'), glass: T('Glass'), outline: T('Outline'), dark: T('Dark'), light: T('Light'), mono: T('Mono'), poster: T('Poster'),
};
const FIELDS: ReadonlyArray<readonly [ColourField, string]> = [['background', T('Background')], ['border', T('Border')], ['text', T('Text')]];
// The same names inside a sentence ("Reset border"), as the language writes them there.
const IN_SENTENCE: Readonly<Record<string, string>> = { background: T('background'), border: T('border'), text: T('text'), icon: T('icon') };
const SWATCHES = ['#1e88e5', '#ef6c00', '#2e7d32', '#546e7a', '#8e24aa', '#ffd166', '#ff6b6b', '#111111', '#ffffff', '#e0e0e0'];
const OPACITIES = [40, 60, 80, 100];
const POSTER_NOTE = T('Poster: each tag takes its background from the artwork it sits on (white or black text, whichever reads better). Colours set here stay on top; Default falls back to the artwork. The preview shows a red poster.');
const NOTES: Readonly<Record<string, string>> = {
    genre: 'Each genre has its own colours (spellings and translations of a genre share them); Text colours the icon. Genres without an icon of their own use Other.',
    status: 'Status badges use the same colours on web cards and native posters.',
    language: 'Language chips use Background, Border and Text, including per-language colours and Dual/Multi. Flag images keep only their border ring; partial flags keep their dashed outline.',
    logos: 'Colours the pill behind a logo, or the name chip a logo without an image shows (Text colours the name).',
    custom: 'One target per label of the Custom tag rules above (labels shared by several rules share their colours). The icon takes the text colour.',
};
const LOGO_SAMPLES: Readonly<Record<string, string>> = { provider: T('Stream'), company: T('Studio'), text: 'HBO' };
const RATING_SAMPLES: Readonly<Record<string, readonly [string | null, string]>> = { community: ['star', '8.1'], critic: [null, '85%'], userReview: ['favorite', '9'], imdb: [null, '8.1'], tmdb: [null, '81%'], rtCritic: [null, '92%'], rtAudience: [null, '88%'], metacritic: [null, '74'], letterboxd: [null, '4.1'], trakt: [null, '85%'] };
const STATUS_SAMPLES: Readonly<Record<string, string>> = { added: T('Just Added'), newMovie: T('New Movie'), newSeries: T('New Series'), newEpisode: T('New Episode'), trending: T('#{rank} Today', { rank: 3 }) };
const RATING_IDS: readonly RatingSourceId[] = ['community', 'critic', 'imdb', 'tmdb', 'rtCritic', 'rtAudience', 'metacritic', 'letterboxd', 'trakt'];
const ALL = '*';
// The one genre label documents held before each genre had its own.
const LEGACY_GENRE = 'genre:genre';
// Groups whose labels are icon tiles with their names, and how many labels bring a filter box.
const TILE_GROUPS = ['genre'];
const FILTER_MIN = 12;
// Preview samples: a few genres in their own colours.
const GENRE_SAMPLES = { movie: ['horror', 'comedy'], episode: ['animation'] };
// The container class each group's chips sit in on a poster.
const CONTAINERS: Readonly<Record<string, string>> = {
    quality: 'quality-overlay-container', ageRating: 'age-rating-overlay-container', rating: 'rating-overlay-container',
    genre: 'genre-overlay-container', status: 'status-overlay-container', language: 'language-overlay-container', awards: 'awards-overlay-container', logos: 'logo-overlay-container', custom: 'custom-overlay-container',
};

const toHex = (c: Rgba): string => '#' + [c.r, c.g, c.b].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('');
const toCss = (c: Rgba): string => 'rgba(' + Math.round(c.r) + ', ' + Math.round(c.g) + ', ' + Math.round(c.b) + ', ' + (Math.round(c.a * 1000) / 1000) + ')';

/**
 * Creates an element with an optional class and text.
 * @param tag
 * @param cls
 * @param text
 * @returns {HTMLElement}
 */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
}

/**
 * Build the Tag Styles editor over its markup (EDITOR_HTML) inside `root`.
 * @param root - Holds the editor markup.
 * @param customLabels - The Custom rules table's labels (unsaved edits included).
 * @param isCurrent - Whether the page that built it is still the live one.
 */
const createTagStylesEditor: CreateTagStylesEditor = (root, customLabels = () => [], isCurrent = () => true): TagStylesEditor => {
    let cat: Catalog | null = null;
    let state: StyleState = emptyState();
    let current = 'quality';
    let target = ALL;
    // The label filter's text (tile groups with many labels); cleared on a group change.
    let filter = '';
    /** The colour property whose palette is open (one at a time), or null. */
    let openField: ColourField | null = null;
    /** Whether the tag list (pick one tag of the group) is open. */
    let targetsOpen = false;
    let previewOpen = false;
    let canvas: CanvasRenderingContext2D | null = null;
    // A version 1 document waiting for the catalog (its built-in colours) to be migrated.
    let legacy: { json: string; doc: Record<string, unknown> } | null = null;
    // A document migrated since load: the snapshots before (from) and after (to).
    let migrated: { from: string; to: string } | null = null;

    const canvasContext = (): CanvasRenderingContext2D | null => {
        canvas = canvas || document.createElement('canvas').getContext('2d');
        return canvas;
    };
    /** Any CSS colour to {r,g,b,a} through the canvas parser. */
    function parse(css: unknown): Rgba {
        const direct = rgbaOf(css);
        if (direct) return direct;
        const ctx = canvasContext();
        if (!ctx) return { r: 0, g: 0, b: 0, a: 1 };
        ctx.fillStyle = '#000000';
        ctx.fillStyle = String(css);
        return rgbaOf(ctx.fillStyle) || { r: 0, g: 0, b: 0, a: 1 };
    }
    /**
     * Like parse, but null for anything that is not a colour (the canvas keeps its previous
     * fill for an invalid one, so it is tried over two different fills).
     */
    function parseColour(css: unknown): Rgba | null {
        const direct = rgbaOf(css);
        if (direct) return direct;
        const ctx = canvasContext();
        if (!ctx || typeof css !== 'string' || !css.trim()) return null;
        ctx.fillStyle = '#000000';
        ctx.fillStyle = css;
        const overBlack = ctx.fillStyle;
        ctx.fillStyle = '#ffffff';
        ctx.fillStyle = css;
        return overBlack === ctx.fillStyle ? rgbaOf(overBlack) : null;
    }
    const norm = (css: unknown): string => toCss(parse(css));

    /** A genre label's glyph (the catalog's; the default glyph when it has none). */
    const genreIcon = (l: string): string => (cat ? ownOf(cat.genreIcons, l) : undefined) || 'theaters';
    /** A genre chip's glyph element, in the bundled symbols font the genre tags use. */
    const genreGlyph = (l: string): HTMLElement => el('i', 'je-ts-genre-glyph', genreIcon(l));

    // Custom labels are the rules table's, unsaved edits included.
    const labelsOf = (g: string): Label[] => {
        if (g === 'custom') return customLabels().map((l) => ({ key: l, name: l }));
        const labels = ((cat ? ownOf(cat.groups, g) : undefined) || []).slice();
        if (g === 'language') {
            for (const key of Object.keys(state.labels).filter((k) => k.startsWith('language:')).map((k) => k.slice(9))) {
                if (!labels.some((l) => l.key === key)) labels.push({ key, name: key.toUpperCase() });
            }
        }
        return labels;
    };
    const labelKey = (g: string, l: string): string => g + ':' + l;
    const fieldsOf = (g: string) => (g === 'language' && target === 'flag' ? FIELDS.filter(([f]) => f === 'border') : FIELDS);
    const labelColours = (key: string): Colours | undefined => ownOf(state.labels, key);
    const groupColours = (g: string): Colours | undefined => ownOf(state.groups, g);

    /** The preset one group uses: its own when it has one, else the design's. */
    const presetOf = (g: string): string => ownOf(state.groupPresets, g) || state.preset;

    /** A preset's colours for one label, as {background, border, text}. */
    function palette(preset: string, g: string, l: string): Colours {
        const pal = (cat ? ownOf(cat.palettes, preset) : undefined) || {};
        // Every custom chip takes the group's palette colours.
        const p = ownOf(pal, labelKey(g, l)) || (g === 'custom' ? ownOf(pal, labelKey(g, ALL)) : undefined) || {};
        const out: Colours = {};
        if (p.background !== undefined) out.background = p.background;
        if (p.border !== undefined) out.border = p.border;
        if (p.color !== undefined) out.text = p.color;
        return out;
    }

    /** The colours a label shows: label override, group override, then preset. */
    function effective(g: string, l: string): Colours {
        const own = labelColours(labelKey(g, l)) || {};
        const shared = groupColours(g) || {};
        const kind = g === 'language' && !['flag', 'code', 'subtitles', 'countBadge'].includes(l)
            ? labelColours(labelKey(g, ['dual', 'multi'].includes(l) ? 'countBadge' : 'code')) || {} : {};
        const pal = palette(presetOf(g), g, l);
        const out: Colours = {};
        FIELDS.forEach(([f]) => { const v = own[f] || kind[f] || shared[f] || pal[f]; if (v) out[f] = v; });
        return out;
    }

    /**
     * The colours the current editing target shows. For the whole group a field is the
     * group override, else the preset colour when every label shares it, else missing (varies).
     */
    function targetColours(): Colours {
        if (target !== ALL) return effective(current, target);
        const shared = groupColours(current) || {};
        const out: Colours = {};
        FIELDS.forEach(([f]) => {
            const values = new Set(labelsOf(current).map((l) => palette(presetOf(current), current, l.key)[f]));
            const only = values.size === 1 ? [...values][0] : undefined;
            const v = shared[f] || only;
            if (v) out[f] = v;
        });
        return out;
    }

    /** The override bag the editing target writes to. */
    const targetEntry = (): Colours => (target === ALL ? groupColours(current) : labelColours(labelKey(current, target))) || {};

    /** Sets (or with null clears) one field of the editing target, then redraws. */
    function setField(field: ColourField, css: string | null, live = false): void {
        const bag = target === ALL ? state.groups : state.labels;
        const key = target === ALL ? current : labelKey(current, target);
        const o: Colours = Object.assign({}, ownOf(bag, key) || {});
        if (css) o[field] = norm(css); else delete o[field];
        if (Object.keys(o).length) bag[key] = o; else delete bag[key];
        // While a colour picker is dragged its rows stay as they are (rebuilding them
        // would replace the picker's input); they are redrawn when the pick is done.
        if (live) { renderTargets(); renderContrast(); } else renderGroup();
        renderPreview();
    }

    /**
     * Rebuild a strip of controls, keeping keyboard focus on the control with the same
     * data-ts-key (or `fallback`'s choice when it is gone or disabled): a click that
     * redraws its own strip must not drop focus to the page.
     */
    function rebuildKeepingFocus(box: Element, build: () => void, fallback?: (key: string) => HTMLElement | null): void {
        const active = activeElement();
        const key = active && box.contains(active) ? active.dataset.tsKey : null;
        build();
        if (!key) return;
        const again = allAs(box, '[data-ts-key]', HTMLElement).find((n) => n.dataset.tsKey === key);
        const next = again && !(again instanceof HTMLButtonElement && again.disabled) ? again : fallback ? fallback(key) : null;
        if (next) next.focus({ preventScroll: true });
    }

    /**
     * Paints a chip in the given colours. Rating chips and flags have no border of their
     * own: theirs is an inner ring, as on the web and native posters.
     */
    function paint<N extends HTMLElement>(n: N, g: string, c: Colours): N {
        if (g !== 'language' || !n.matches('img.language-flag')) {
            n.style.background = c.background || '';
            n.style.color = c.text || '';
        }
        if (g === 'rating' || (g === 'language' && n.matches('img.language-flag'))) {
            const ring = !!c.border && parse(c.border).a > 0;
            n.style.outline = ring ? '1px solid ' + c.border : '';
            n.style.outlineOffset = ring ? '-1px' : '';
        } else {
            n.style.borderColor = c.border || '';
        }
        return n;
    }

    /** A real language-chip class and style label for one colour-editor sample. */
    function languageSample(label: Label): HTMLElement {
        const count = ['dual', 'multi', 'countBadge'].includes(label.key);
        const sample = label.key === 'subtitles' ? 'CC EN' : count ? label.key === 'dual' ? T('Dual') : T('Multi') : label.key === 'code' ? 'EN' : label.key.toUpperCase();
        const n = el('span', 'je-ts-chip language-chip ' + (count ? 'language-count-badge' : 'language-code'), sample);
        n.dataset.jeLanguage = count ? 'countBadge' : label.key === 'subtitles' ? 'subtitles' : 'flag';
        n.dataset.jeLanguageLabel = count ? label.key === 'dual' ? 'dual' : 'multi' : label.key === 'code' || label.key === 'subtitles' ? 'en' : label.key;
        return n;
    }

    /** A named source sample using the bundled client logo, or its catalog name on a dashboard without the bundle. */
    function sourceRatingChip(label: Label): HTMLElement {
        const sample = (ownOf(RATING_SAMPLES, label.key) || [null, ''])[1];
        const id = RATING_IDS.find((r) => r === label.key);
        let n: HTMLElement | null = id ? JE.ratingSources?.chip({ id, value: parseFloat(sample), text: sample, color: null }) ?? null : null;
        if (!n) {
            n = el('span', 'rating-tag rating-tag--source');
            n.dataset.jeRatingSource = label.key;
            n.append(el('span', 'je-ts-source-name', label.name), el('span', 'rating-text', sample));
        }
        n.classList.add('je-ts-chip', 'je-ts-rate');
        return n;
    }

    /** A flag image chip. */
    function flagChip(cls: string): HTMLImageElement {
        const n = el('img', cls);
        n.src = cdnUrl('flag-icons/flags/4x3/gb.svg');
        n.alt = '';
        return n;
    }

    /** A sample chip for a label, with the real chip classes. */
    function chip(g: string, label: Label, c: Colours): HTMLElement {
        let n: HTMLElement;
        if (g === 'quality') {
            n = el('span', 'je-ts-chip je-ts-q quality-overlay-label', label.name);
        } else if (g === 'ageRating') {
            n = el('span', 'je-ts-chip je-ts-age age-rating-tag', label.name);
        } else if (g === 'rating' && !['community', 'critic', 'userReview'].includes(label.key)) {
            n = sourceRatingChip(label);
        } else if (g === 'rating') {
            const [icon, sample] = ownOf(RATING_SAMPLES, label.key) || ['star', '8.1'];
            n = el('span', 'je-ts-chip je-ts-rate rating-tag');
            n.appendChild(icon ? el('i', 'material-icons je-ts-rate-icon', icon) : el('i', 'je-ts-tomato'));
            n.appendChild(document.createTextNode(sample));
        } else if (g === 'awards') {
            n = el('div', 'awards-tag je-ts-chip je-ts-rate', label.name.includes('250') ? T('Top 250') : label.name);
            n.dataset.jeAward = label.key;
        } else if (g === 'genre') {
            n = el('span', 'je-ts-chip je-ts-genre genre-tag');
            n.appendChild(genreGlyph(label.key));
        } else if (g === 'status') {
            n = el('span', 'je-ts-chip je-ts-status status-tag', ownOf(STATUS_SAMPLES, label.key) || label.name);
        } else if (g === 'logos') {
            n = el('span', 'je-ts-chip je-ts-status je-logo-chip', ownOf(LOGO_SAMPLES, label.key) || label.name);
            n.dataset.jeLogoStyle = label.key;
        } else if (g === 'custom') {
            n = el('span', 'je-ts-chip je-ts-custom custom-tag', label.name);
        } else if (g === 'language' && label.key !== 'flag') {
            n = languageSample(label);
        } else {
            n = flagChip('je-ts-chip je-ts-flag language-flag');
        }
        return paint(n, g, c);
    }

    /** A labelled pill/radio button. */
    function radio(cls: string, checked: boolean, onClick: () => void): HTMLButtonElement {
        const b = el('button', cls + (checked ? ' active' : ''));
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(checked));
        b.addEventListener('click', onClick);
        return b;
    }

    const need = (selector: string): HTMLElement | null => find(root, selector);

    function renderPresets(): void {
        const bar = need('#tagStylePresets');
        if (!bar) return;
        rebuildKeepingFocus(bar, () => buildPresets(bar));
        rove(bar, '.je-ts-preset', 'aria-checked');
        const now = need('#tagStylePresetNow');
        if (now) now.textContent = ownOf(PRESET_TITLES, state.preset) || state.preset || '';
        const previewToggle = need('#tagStylePreviewToggle');
        if (previewToggle && !previewToggle.onclick) {
            const name = previewToggle.querySelector('.je-ts-preview-toggle-name');
            if (name) name.textContent = T('Movie and episode samples');
            previewToggle.onclick = () => {
                previewOpen = !previewOpen;
                previewToggle.setAttribute('aria-expanded', String(previewOpen));
                const box = need('#tagStylePreview');
                if (box) box.hidden = !previewOpen;
            };
        }
    }

    /**
     * One Tab stop for a strip of choices (the selected one); arrow keys, Home and End
     * choose the next one, as the page's own tab bar does.
     */
    function rove(box: HTMLElement, selector: string, attr: string): void {
        const items = allAs(box, selector, HTMLElement);
        items.forEach((item) => { item.tabIndex = item.getAttribute(attr) === 'true' ? 0 : -1; });
        const first = items[0];
        if (first && !items.some((item) => item.tabIndex === 0)) first.tabIndex = 0;
        box.onkeydown = (e) => {
            const list = allAs(box, selector, HTMLElement);
            const from = e.target instanceof Element ? e.target.closest(selector) : null;
            const at = list.findIndex((n) => n === from);
            if (at < 0 || e.altKey || e.ctrlKey || e.metaKey) return;
            const back = getComputedStyle(box).direction === 'rtl' ? 1 : -1;
            const step = ownOf<number>({ ArrowLeft: back, ArrowRight: -back, ArrowUp: -1, ArrowDown: 1 }, e.key);
            const next = step ? list[(at + step + list.length) % list.length] : e.key === 'Home' ? list[0] : e.key === 'End' ? list[list.length - 1] : null;
            if (!next) return;
            e.preventDefault();
            const key = next.dataset.tsKey;
            next.click();
            // Choosing redraws the strip: focus the new choice there.
            const again = allAs(box, selector, HTMLElement).find((n) => n.dataset.tsKey === key);
            if (again) again.focus();
        };
    }

    function buildPresets(bar: HTMLElement): void {
        bar.textContent = '';
        if (!cat) return;
        const age = labelsOf('ageRating').find((l) => l.name === 'PG-13') || labelsOf('ageRating')[0];
        cat.presets.forEach((id) => {
            const tile = radio('je-ts-preset', state.preset === id, () => { state.preset = id; render(); });
            tile.dataset.preset = id;
            tile.dataset.tsKey = 'preset:' + id;
            tile.appendChild(el('span', 'je-ts-preset-title', ownOf(PRESET_TITLES, id) || id));
            const mini = el('span', 'je-ts-preset-chips');
            mini.appendChild(chip('quality', { key: '4K', name: '4K' }, palette(id, 'quality', '4K')));
            mini.appendChild(chip('rating', { key: 'community', name: T('Community') }, palette(id, 'rating', 'community')));
            if (age) mini.appendChild(chip('ageRating', age, palette(id, 'ageRating', age.key)));
            tile.appendChild(mini);
            bar.appendChild(tile);
        });
    }

    function renderTabs(): void {
        const tabs = need('#tagStyleTabs');
        if (!tabs) return;
        rebuildKeepingFocus(tabs, () => {
            tabs.textContent = '';
            GROUPS.forEach((g) => {
                const b = el('button', 'je-ts-tab' + (g.key === current ? ' active' : ''), g.title);
                b.type = 'button';
                b.setAttribute('role', 'tab');
                b.setAttribute('aria-selected', String(g.key === current));
                b.dataset.group = g.key;
                b.dataset.tsKey = 'tab:' + g.key;
                b.id = 'tagStyleTab-' + g.key;
                b.setAttribute('aria-controls', 'tagStyleGroupPanel');
                b.addEventListener('click', () => { current = g.key; target = ALL; filter = ''; renderTabs(); renderGroup(); });
                tabs.appendChild(b);
            });
        });
        rove(tabs, '.je-ts-tab', 'aria-selected');
        // A phone shows the groups as one select (the tabs wrap into rows there).
        const select = findAs(root, '#tagStyleGroupSelect', HTMLSelectElement);
        if (select) {
            select.innerHTML = GROUPS.map((g) => '<option value="' + g.key + '"' + (g.key === current ? ' selected' : '') + '>' + g.title + '</option>').join('');
            select.onchange = () => find(tabs, '.je-ts-tab[data-group="' + select.value + '"]')?.click();
            const label = need('#tagStyleGroupSelectLabel');
            if (label) label.textContent = T('Tag group');
        }
        need('#tagStyleGroupPanel')?.setAttribute('aria-labelledby', 'tagStyleTab-' + current);
    }

    /** Shows the label tiles whose name holds the filter text; Whole group and the label being edited always stay. */
    function applyFilter(): void {
        const needle = filter.trim().toLocaleLowerCase();
        allAs(root, '#tagStyleTargets .je-ts-target', HTMLElement).forEach((cell) => {
            const label = cell.dataset.label;
            const name = (cell.getAttribute('aria-label') || '').toLocaleLowerCase();
            cell.hidden = !!needle && label !== ALL && label !== target && !name.includes(needle);
        });
    }

    /**
     * Arrow keys move the selection along the visible tiles (wrapping), Home and End to
     * the first and last; selecting rebuilds the strip, which keeps focus on the selected tile.
     */
    function onTargetKey(e: KeyboardEvent): void {
        const box = e.currentTarget;
        if (!(box instanceof HTMLElement)) return;
        const cells = allAs(box, '.je-ts-target:not([hidden])', HTMLElement);
        const from = e.target instanceof Element ? e.target.closest('.je-ts-target') : null;
        const at = cells.findIndex((c) => c === from);
        if (at < 0 || e.altKey || e.ctrlKey || e.metaKey) return;
        const back = getComputedStyle(box).direction === 'rtl' ? 1 : -1;
        const step = ownOf<number>({ ArrowLeft: back, ArrowRight: -back, ArrowUp: -1, ArrowDown: 1 }, e.key);
        let next: HTMLElement | undefined;
        if (step) next = cells[(at + step + cells.length) % cells.length];
        else if (e.key === 'Home') next = cells[0];
        else if (e.key === 'End') next = cells[cells.length - 1];
        else return;
        e.preventDefault();
        next?.click();
    }

    function renderTargets(): void {
        const box = need('#tagStyleTargets');
        if (!box) return;
        // Rebuilding drops focus: a keyboard user keeps it on the selected tile.
        const focused = box.contains(document.activeElement);
        box.textContent = '';
        box.onkeydown = onTargetKey;
        const tiles = TILE_GROUPS.includes(current);
        box.classList.toggle('je-ts-targets-tiles', tiles);
        // The tag list opens on request: the colour rows stay next to what they edit.
        const toggle = need('#tagStyleTargetToggle');
        if (toggle) {
            toggle.hidden = false;
            toggle.textContent = targetsOpen ? T('Close tag list') : T('Choose a tag');
            toggle.setAttribute('aria-expanded', String(targetsOpen));
            toggle.onclick = () => { targetsOpen = !targetsOpen; renderTargets(); if (targetsOpen) find(root, '#tagStyleTargets .je-ts-target[tabindex="0"]')?.focus(); };
        }
        const targetBox = need('#tagStyleTargetBox');
        if (targetBox) targetBox.hidden = !targetsOpen;
        const hint = need('#tagStyleTargetHint');
        if (hint) hint.textContent = T('Choose a tag to change only its colours.');
        const search = findAs(root, '#tagStyleTargetFilter', HTMLInputElement);
        if (search) {
            // Any group with more labels than a glance takes gets the filter (genres name the box after themselves).
            search.hidden = labelsOf(current).length <= FILTER_MIN;
            const filterKey = current === 'genre' ? 'Find a genre' : 'Find a tag';
            search.placeholder = T(filterKey);
            search.setAttribute('aria-label', T(filterKey));
            search.value = search.hidden ? '' : filter;
            search.oninput = () => { filter = search.value; applyFilter(); };
        }
        // What the colour rows below change, named above the list.
        const now = need('#tagStyleEditingNow');
        if (now) {
            const groupTitle = GROUPS.find((g) => g.key === current)?.title || current;
            const label = target === ALL ? null : labelsOf(current).find((l) => l.key === target);
            // The group part is dropped on a phone, where the group select above names it.
            now.replaceChildren(el('span', 'je-ts-now-group', groupTitle + ' · '), document.createTextNode(label ? label.name : T('Whole group')));
        }
        const all = radio('je-ts-target je-ts-target-all' + (groupColours(current) ? ' changed' : ''), target === ALL, () => { target = ALL; renderGroup(); });
        all.textContent = T('Whole group');
        all.dataset.label = ALL;
        box.appendChild(all);
        labelsOf(current).forEach((label) => {
            const changed = !!labelColours(labelKey(current, label.key));
            const cell = radio('je-ts-target' + (changed ? ' changed' : ''), target === label.key, () => { target = label.key; renderGroup(); });
            cell.dataset.label = label.key;
            cell.title = current === 'ageRating'
                ? T('Applies to: {ratings}', { ratings: (cat?.age.find((a) => a.id === label.key)?.ratings || []).join(', ') })
                : label.name;
            cell.setAttribute('aria-label', current === 'ageRating' ? T('{name} board', { name: label.name }) : label.name);
            cell.appendChild(chip(current, label, effective(current, label.key)));
            // Tiles carry their name too (shown where there is room; the tooltip always has it).
            if (tiles) cell.appendChild(el('span', 'je-ts-target-name', label.name));
            box.appendChild(cell);
        });
        applyFilter();
        // One tab stop for the strip (the filter box is its own): the selected tile.
        let selected: HTMLElement | null = null;
        allAs(box, '.je-ts-target', HTMLElement).forEach((cell) => {
            const on = cell.getAttribute('aria-checked') === 'true';
            cell.tabIndex = on ? 0 : -1;
            if (on) selected = cell;
        });
        const chosen: HTMLElement | null = selected || find(box, '.je-ts-target');
        if (chosen) chosen.tabIndex = 0;
        if (focused && chosen) chosen.focus();
        // Say when the list scrolls inside its box.
        if (hint) {
            const count = labelsOf(current).length;
            hint.textContent = T('Choose a tag to change only its colours.') + (targetsOpen && box.scrollHeight > box.clientHeight + 2 ? ' ' + T('{count} tags; scroll for more.', { count: Number(count) }) : '');
        }
        // A long strip scrolls inside its box: keep the selected label in view there (never the page).
        if (chosen && box.scrollHeight > box.clientHeight) {
            const top = chosen.offsetTop - box.offsetTop;
            if (top < box.scrollTop || top + chosen.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = Math.max(0, top - 8);
        }
    }

    function renderRows(): void {
        const rows = need('#tagStyleRows');
        if (!rows) return;
        // A control drawn disabled (Default after a reset) hands focus to its row's first control.
        rebuildKeepingFocus(rows, () => buildRows(rows), (key) => {
            const field = key.split(':')[0];
            const row = allAs(rows, '.je-ts-field-row', HTMLElement).find((r) => r.dataset.field === field);
            return row ? find(row, 'button:not([disabled]), input') : null;
        });
    }

    function buildRows(rows: HTMLElement): void {
        rows.textContent = '';
        const colours = targetColours();
        const own = targetEntry();
        const shared = target === ALL ? {} : (groupColours(current) || {});
        fieldsOf(current).forEach(([field, name]) => {
            const shownColour = colours[field];
            const varies = !shownColour;
            const c = parse(shownColour || 'rgba(0, 0, 0, 0)');
            const alpha = c.a > 0 && !varies ? c.a : 1;
            const shownName = current === 'genre' && field === 'text' ? T('Icon') : name;
            const sentenceName = (current === 'genre' && field === 'text' ? IN_SENTENCE.icon : ownOf(IN_SENTENCE, field)) || '';
            const row = el('div', 'je-ts-field-row');
            row.dataset.field = field;
            // The row reads as its value: the colour, its opacity and where it comes from.
            const head = el('div', 'je-ts-field-head');
            head.appendChild(el('span', 'je-ts-row-name', shownName));
            const now = el('span', 'je-ts-swatch je-ts-swatch-current' + (varies ? ' je-ts-swatch-varies' : ''));
            if (shownColour) now.style.setProperty('--je-ts-swatch', shownColour);
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
                const ownColour = own[field];
                const picked = !!ownColour && toHex(parse(ownColour)) === hex;
                if (picked) b.classList.add('active');
                b.setAttribute('aria-pressed', String(picked));
                b.addEventListener('click', () => setField(field, toCss(Object.assign(parse(hex), { a: alpha }))));
                list.appendChild(b);
            });
            const any = el('input');
            any.type = 'color';
            any.className = 'je-ts-any';
            any.value = toHex(c);
            any.setAttribute('aria-label', T('Any {name} colour', { name: ownOf(IN_SENTENCE, field) || field }));
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
     * @returns Null when neither field comes from the artwork.
     */
    function posterContrast(label: { key: string }): number | null {
        if (presetOf(current) !== 'poster' || (current === 'language' && label.key === 'flag')) return null;
        const own = labelColours(labelKey(current, label.key)) || {};
        const shared = groupColours(current) || {};
        const text = own.text || shared.text;
        const background = own.background || shared.background;
        if (text && background) return null;
        if (!text && !background) return cat?.poster.worstContrast || 4.5;
        const normalise = JE.tagPosterColours?.normalise;
        if (typeof normalise !== 'function') return 1;
        let worst = 21;
        // Dominant colours around the hue circle, dark to light: every band colour a poster can give.
        for (let hue = 0; hue < 360; hue += 10) {
            for (const [s, l] of [[1, 0.15], [1, 0.3], [1, 0.5], [0.6, 0.7], [1, 0.85]] as const) {
                const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((hue / 60) % 2) - 1)), m = l - c / 2;
                const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
                const band = normalise([Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]);
                const css = (v: readonly number[]) => 'rgb(' + v.join(', ') + ')';
                const ratio = contrastRatio(text || css(band.text), background || css(band.background));
                if (ratio !== null) worst = Math.min(worst, ratio);
            }
        }
        return worst;
    }

    function renderContrast(): void {
        const box = need('#tagStyleContrast');
        if (!box) return;
        box.textContent = '';
        if (current === 'language' && target === 'flag') return;
        // One label: its own contrast. Whole group: the label that reads worst. Under Poster, a
        // label whose text or background comes from the artwork counts with its worst case over
        // any artwork, a label with both set here with its own colours.
        let worst: { ratio: number; name: string | undefined; key: string; poster: boolean } | null = null;
        let sampled = false;
        const candidates: Array<{ key: string; name?: string }> = target === ALL ? labelsOf(current) : [{ key: target }];
        for (const label of candidates) {
            let ratio = posterContrast(label);
            const poster = ratio !== null;
            if (poster) sampled = true;
            else {
                const c = effective(current, label.key);
                ratio = contrastRatio(c.text, c.background);
            }
            if (ratio !== null && (!worst || ratio < worst.ratio)) worst = { ratio, name: label.name, key: label.key, poster };
        }
        const found = worst;
        if (!found) return;
        const grade = contrastLevel(found.ratio);
        // Every group has a lowest tag, so the whole group only speaks up when one is hard to read. A single tag always shows its rating.
        if (target === ALL && grade.level !== 'low') return;
        // The ratio in the interface language's numbers (8,1:1 in German), as every other number the tab shows.
        let ratioText = found.ratio.toFixed(1);
        try { ratioText = new Intl.NumberFormat(JE.core?.mediaLanguage?.uiLocale?.() || undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(found.ratio); } catch { /* keep the plain form */ }
        const badge = el('span', 'je-ts-contrast-badge je-ts-contrast-' + grade.level, grade.label + ' · ' + ratioText + ':1');
        badge.dataset.level = grade.level;
        if (sampled) badge.dataset.poster = found.poster ? 'worst' : 'fixed';
        box.appendChild(badge);
        const hint = target === ALL ? T('Lowest in the group ({name}): text over background, on a dark poster', { name: String(found.name) }) : T('Text over background, on a dark poster');
        box.appendChild(el('span', 'je-ts-contrast-hint', !sampled ? hint
            : found.poster ? T('Worst case over any artwork: Poster takes each tag\'s colours from the poster it sits on, so this is the lowest contrast the poster colours can give')
                : T('{hint}. Its colours are all set here; tags without their own take them from the poster they sit on', { hint })));
        // Whole group: open the tag that reads worst (choosing it changes nothing).
        if (target === ALL && found.key) {
            const inspect = el('button', 'je-ts-inspect', T('Inspect {name}', { name: String(found.name) }));
            inspect.type = 'button';
            inspect.addEventListener('click', () => { target = found.key; targetsOpen = true; renderGroup(); find(root, '#tagStyleTargets .je-ts-target[tabindex="0"]')?.focus(); });
            box.appendChild(inspect);
        }
    }

    /** The tag being edited, drawn in its current colours next to its controls (Whole group: the tag that is hard to read, else the first). */
    function renderSample(): void {
        const box = need('#tagStyleSample');
        if (!box) return;
        box.textContent = '';
        const labels = labelsOf(current);
        let label = target === ALL ? undefined : labels.find((l) => l.key === target);
        let weak = false;
        if (!label) {
            let low: { ratio: number; l: Label } | null = null;
            for (const l of labels) {
                const c = effective(current, l.key);
                const ratio = contrastRatio(c.text, c.background);
                if (ratio !== null && (!low || ratio < low.ratio)) low = { ratio, l };
            }
            const lowest = low;
            weak = !!lowest && contrastLevel(lowest.ratio).level === 'low';
            // The first label is not the typical one (R18+ sits in the plain unrated colour group, 1080i comes before
            // 1080p), so the group sample shows PG-13 and 1080p.
            const typical = ownOf<string>({ ageRating: 'PG-13', quality: '1080p' }, current);
            label = weak && lowest ? lowest.l : (typical && labels.find((l) => l.name === typical)) || labels[0];
        }
        if (!label) return;
        box.appendChild(chip(current, label, effective(current, label.key)));
        box.appendChild(el('span', 'je-ts-sample-note', target !== ALL ? T('Editing this tag') : T(weak ? 'Lowest-contrast sample' : 'Sample tag')));
    }

    /** The select that gives the open group a preset of its own. */
    function renderGroupPreset(): void {
        const select = findAs(root, '#tagStyleGroupPreset', HTMLSelectElement);
        if (!select || !cat) return;
        const label = need('#tagStyleGroupPresetLabel');
        if (label) label.textContent = T('Preset for this group');
        select.setAttribute('aria-labelledby', 'tagStyleGroupPresetLabel');
        select.innerHTML = '<option value="">' + T('Same as the design ({name})', { name: ownOf(PRESET_TITLES, state.preset) || state.preset }) + '</option>'
            + cat.presets.map((id) => '<option value="' + id + '">' + (ownOf(PRESET_TITLES, id) || id) + '</option>').join('');
        select.value = ownOf(state.groupPresets, current) || '';
        select.onchange = () => {
            if (select.value) state.groupPresets[current] = select.value;
            else delete state.groupPresets[current];
            render();
        };
    }

    function renderGroup(): void {
        renderGroupPreset();
        renderTargets();
        const noteKey = ownOf(NOTES, current);
        const note = noteKey ? T(noteKey) : '';
        const noteBox = need('#tagStyleGroupNote');
        if (noteBox) noteBox.textContent = [presetOf(current) === 'poster' && (current !== 'language' || target !== 'flag') ? POSTER_NOTE : '', note].filter(Boolean).join(' ');
        renderRows();
        renderContrast();
        renderSample();
    }

    /** The editor's effective colours in the web model's shape (GET tag-styles), for the shared stylesheet generator. */
    function webModel(): Record<string, unknown> {
        const web = (c: Colours) => ({ background: c.background, border: c.border, color: c.text });
        const map = (g: string) => {
            const out: Record<string, unknown> = {};
            labelsOf(g).forEach((l) => { out[l.key] = web(effective(g, l.key)); });
            return out;
        };
        return {
            quality: map('quality'),
            age: labelsOf('ageRating').map((l) => Object.assign(
                { ratings: (cat?.age.find((a) => a.id === l.key)?.ratings || []).slice() },
                web(effective('ageRating', l.key)))),
            rating: map('rating'),
            genre: map('genre'),
            status: map('status'),
            awards: map('awards'),
            custom: Object.assign({ '*': web(effective('custom', ALL)) }, map('custom')),
            language: web(effective('language', 'code')),
            languageLabels: Object.fromEntries(labelsOf('language').map(({ key }) => [key, ['flag', 'code', 'subtitles', 'countBadge'].includes(key) ? web(effective('language', key)) : web(labelColours(labelKey('language', key)) || {})])),
            logos: map('logos'),
        };
    }

    /**
     * A chip as the tag modules draw it (their element, classes and attributes), plus the
     * editor's look classes. Its colours come from the preview stylesheet, or with `inline`
     * (no generator on this page) from inline styles.
     */
    function productionChip(g: string, label: Label, inline: boolean): HTMLElement {
        let n: HTMLElement;
        if (g === 'quality') {
            n = el('div', 'quality-overlay-label je-ts-chip je-ts-q', label.name);
            n.dataset.quality = label.key;
        } else if (g === 'ageRating') {
            n = el('div', 'age-rating-tag je-ts-chip je-ts-age', label.name);
            n.setAttribute('rating', label.name);
        } else if (g === 'rating' && !['community', 'critic', 'userReview'].includes(label.key)) {
            n = sourceRatingChip(label);
        } else if (g === 'rating') {
            const [icon, sample] = ownOf(RATING_SAMPLES, label.key) || ['star', '8.1'];
            const kind = ownOf<string>({ community: 'rating-tag-tmdb', critic: 'rating-tag-critic', userReview: 'rating-tag-userreview je-userreview-tag' }, label.key) || 'rating-tag--source';
            n = el('div', 'rating-tag ' + kind + ' je-ts-chip je-ts-rate');
            if (label.key === 'community') n.appendChild(el('i', 'material-icons rating-star-icon je-ts-rate-icon', icon ?? undefined));
            else if (label.key === 'userReview') {
                // The glyph sits inside: the review module's own icon rules set a font this page may not have.
                const wrap = el('span', 'je-userreview-icon je-ts-rate-icon');
                wrap.appendChild(el('i', 'material-icons je-ts-rate-icon', icon ?? undefined));
                n.appendChild(wrap);
            } else if (label.key === 'critic') n.appendChild(el('i', 'rating-tomato-icon fresh je-ts-tomato'));
            else { n.dataset.jeRatingSource = label.key; n.appendChild(el('span', 'je-rating-source-logo', label.name)); }
            n.appendChild(el('span', 'rating-text', sample));
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
                const [before = '', after = ''] = T('#{rank} Today', { rank: '\u0001' }).split('\u0001');
                const hash = before.endsWith('#') ? '#' : '';
                n.append(before.slice(0, before.length - hash.length), el('span', 'status-tag-rank', hash + '3'), after);
            } else n.textContent = ownOf(STATUS_SAMPLES, label.key) || label.name;
        } else if (g === 'logos') {
            n = el('span', 'je-logo-chip je-ts-chip je-ts-status', ownOf(LOGO_SAMPLES, label.key) || label.name);
            n.dataset.jeLogoStyle = label.key;
        } else if (g === 'custom') {
            n = el('div', 'custom-tag je-ts-chip je-ts-custom');
            n.dataset.jeCustom = label.key;
            n.appendChild(el('span', 'custom-tag-text', label.name));
        } else if (g === 'language' && label.key !== 'flag') {
            n = languageSample(label);
        } else {
            n = flagChip('language-flag je-ts-chip je-ts-flag');
            n.dataset.lang = 'gb';
        }
        return inline ? paint(n, g, effective(g, label.key)) : n;
    }

    /** Draws a synthetic card with chips in the default corners, each group in its production container. */
    function card(cls: string, title: string, corners: Record<string, ReadonlyArray<readonly [string, string]>>, inline: boolean): HTMLElement {
        const n = el('div', 'je-ts-card ' + cls);
        const art = el('div', 'je-ts-art');
        Object.keys(corners).forEach((corner) => {
            const stack = el('div', 'je-ts-corner je-ts-corner-' + corner);
            let box: HTMLElement | null = null;
            (ownOf(corners, corner) || []).forEach(([g, l]) => {
                const label = labelsOf(g).find((x) => x.key === l || x.name === l);
                if (!label) return;
                if (!box || box.dataset.group !== g) {
                    box = el('div', (ownOf(CONTAINERS, g) || 'undefined') + ' je-ts-corner-group');
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
     * generator (tag-styles.js), limited to the preview so unsaved colours never reach the
     * rest of the page. A broken production selector breaks the preview too.
     */
    function renderPreview(): void {
        const box = need('#tagStylePreview');
        if (!box) return;
        box.textContent = '';
        const build = JE.tagStyles?.buildCss;
        const generate = typeof build === 'function' ? build : null;
        box.dataset.styles = generate ? 'generated' : 'inline';
        if (generate) {
            const sheet = el('style');
            sheet.id = 'tagStylePreviewCss';
            sheet.textContent = generate(webModel(), '#tagStylePreview');
            box.appendChild(sheet);
        }
        type Pick2 = readonly [string, string];
        const custom: Pick2[] = labelsOf('custom').slice(0, 2).map((l): Pick2 => ['custom', l.key]);
        const genres = (list: readonly string[]): Pick2[] => list.map((l): Pick2 => ['genre', l]);
        const movieQuality: Pick2[] = [['quality', '4K'], ['quality', 'Dolby Vision'], ['quality', 'ATMOS']];
        const movieStatus: Pick2[] = [['status', 'trending']];
        const episodeStatus: Pick2[] = [['status', 'newEpisode']];
        box.appendChild(card('je-ts-card-movie', T('Movie'), {
            tl: movieQuality.concat(custom),
            tr: movieStatus.concat(genres(GENRE_SAMPLES.movie)),
            bl: [['language', 'flag']],
            br: [['rating', 'critic'], ['rating', 'community'], ['ageRating', 'PG-13']],
        }, !generate));
        box.appendChild(card('je-ts-card-episode', T('Episode'), {
            tl: [['quality', '1080p'], ['quality', 'HEVC']],
            tr: episodeStatus.concat(genres(GENRE_SAMPLES.episode)),
            bl: [['language', 'flag']],
            br: [['rating', 'userReview'], ['ageRating', 'R']],
        }, !generate));
    }

    function render(): void {
        if (!cat) return;
        renderPresets();
        renderTabs();
        renderGroup();
        renderPreview();
    }

    /** Reads a stored colour object into {background, border, text}, normalised ('text' in version 2, 'color' in version 1). */
    function readColours(o: unknown, textKey: 'text' | 'color'): Colours | null {
        if (!o || typeof o !== 'object') return null;
        const out: Colours = {};
        for (const [f, k] of [['background', 'background'], ['border', 'border'], ['text', textKey]] as const) {
            const v: unknown = Reflect.get(o, k);
            if (typeof v === 'string' && v) out[f] = norm(v);
        }
        return Object.keys(out).length ? out : null;
    }

    /**
     * Migrates a version 1 document as the server does (TagStyleSet.ReadV1). The old editor stored
     * only differences from the built-in colours, with its presets baked in, and the web drew the
     * stored field, else the built-in one (rating chips had no border). Each stored catalog label
     * becomes exactly those colours and the preset becomes Default, so nothing is recoloured.
     */
    function migrateV1(doc: Record<string, unknown>): void {
        state = emptyState();
        for (const [section, g] of [['quality', 'quality'], ['age', 'ageRating'], ['rating', 'rating'], ['genre', 'genre']] as const) {
            const entries: unknown = section === 'genre' ? { genre: doc.genre } : doc[section];
            if (!entries || typeof entries !== 'object') continue;
            for (const [l, o] of Object.entries(entries)) {
                // Of the rating chips version 1 only styled community and critic.
                if ((section !== 'genre' && !labelsOf(g).some((x) => x.key === l)) || !labelsOf(g).length || (g === 'rating' && l === 'userReview') || !o || typeof o !== 'object') continue;
                const stored: Colours = {};
                for (const [f, k] of [['background', 'background'], ['border', 'border'], ['text', 'color']] as const) {
                    const raw: unknown = Reflect.get(o, k);
                    const c = (g !== 'rating' || f !== 'border') && typeof raw === 'string' ? parseColour(raw) : null;
                    if (c) stored[f] = toCss(c);
                }
                if (!Object.keys(stored).length) continue;
                const builtin = palette('default', g, section === 'genre' ? (labelsOf(g)[0]?.key ?? '') : l);
                const out: Colours = {};
                fieldsOf(g).forEach(([f]) => {
                    if (g === 'rating' && f === 'border') return;
                    const v = stored[f] || builtin[f];
                    if (v) out[f] = v;
                });
                // Version 1 coloured every genre chip alike: that is the genre group now.
                if (section === 'genre') state.groups.genre = out;
                else state.labels[labelKey(g, l)] = out;
            }
        }
    }

    /** Migrates the loaded version 1 document, remembering both snapshots (see snapshot()). */
    function migrateLoaded(json: string, doc: Record<string, unknown>): void {
        migrateV1(doc);
        migrated = { from: json + '|default', to: serialize() + '|' + state.preset };
    }

    /**
     * Loads the stored document (version 1 or 2) and preset. A version 1 document is migrated
     * once the catalog is in; until then serialize() hands it back untouched (the server
     * migrates it the same way).
     */
    function load(jsonValue: JsonValue | undefined, presetValue: JsonValue | undefined): void {
        const json = jsonValue ? String(jsonValue) : '';
        const preset = typeof presetValue === 'string' ? presetValue : String(presetValue ?? '');
        state = emptyState(ownOf(PRESET_TITLES, preset) ? preset : 'default');
        // The group and label being edited stay when the page loads the stored document again
        // (after a save the server normalised, or the page shown again).
        if (!GROUPS.some((g) => g.key === current)) current = 'quality';
        if (target !== ALL && !labelsOf(current).some((l) => l.key === target)) target = ALL;
        legacy = null;
        migrated = null;
        try {
            const p: unknown = json ? JSON.parse(json) : {};
            if (p && typeof p === 'object' && Reflect.get(p, 'v') === 2) {
                const groupPresets: unknown = Reflect.get(p, 'groupPresets');
                for (const [g, value] of Object.entries(groupPresets && typeof groupPresets === 'object' ? groupPresets : {})) {
                    if (GROUPS.some((x) => x.key === g) && typeof value === 'string' && ownOf(PRESET_TITLES, value)) state.groupPresets[g] = value;
                }
                const groups: unknown = Reflect.get(p, 'groups');
                for (const [g, value] of Object.entries(groups && typeof groups === 'object' ? groups : {})) { const c = readColours(value, 'text'); if (c) state.groups[g] = c; }
                const labels: unknown = Reflect.get(p, 'labels');
                for (const [k, value] of Object.entries(labels && typeof labels === 'object' ? labels : {})) { const c = readColours(value, 'text'); if (c) state.labels[k] = c; }
                // The one genre label older documents held coloured every genre: fold it onto the
                // group, as the server reads it; the fold alone is no unsaved change.
                const legacyGenre = labelColours(LEGACY_GENRE);
                if (legacyGenre) {
                    delete state.labels[LEGACY_GENRE];
                    state.groups.genre = Object.assign({}, groupColours('genre'), legacyGenre);
                    migrated = { from: json + '|' + state.preset, to: serialize() + '|' + state.preset };
                }
            } else if (p && typeof p === 'object' && !Array.isArray(p) && Object.keys(p).length) {
                const doc: Record<string, unknown> = Object.fromEntries(Object.entries(p));
                state.preset = 'default';
                if (cat) migrateLoaded(json, doc); else legacy = { json, doc };
            }
        } catch { /* unreadable value: start clean */ }
        if (!cat) {
            const client = apiClient();
            client.ajax({ type: 'GET', url: client.getUrl('JellyfinEnhanced/tag-styles/catalog'), dataType: 'json' }).then((answer) => {
                if (!isCurrent()) return;
                const decoded = decodeCatalog(answer);
                if (!decoded) throw new TypeError('The Tag Styles catalog is not an object');
                cat = decoded;
                if (legacy) { const l = legacy; legacy = null; migrateLoaded(l.json, l.doc); }
                render();
            }).catch(() => {
                if (!isCurrent()) return;
                const presets = need('#tagStylePresets');
                if (presets) presets.textContent = T('Could not load the tag list.');
            });
        }
        render();
    }

    /**
     * What the unsaved-changes check compares: the stored document and the preset. A version 1
     * document migrated on load still reads as loaded, so the migration alone is no change.
     */
    function snapshot(): string {
        const now = serialize() + '|' + state.preset;
        return migrated && now === migrated.to ? migrated.from : now;
    }

    /**
     * Entries in the order the server stores them (TagStyleSet.Serialize: keys in ordinal order, fields
     * background, border, text), so a save comes back unchanged instead of reading as a server-side
     * normalisation, which redraws the page (and this editor) from the stored value.
     */
    function canonical(map: Record<string, Colours>): Record<string, Colours> {
        const out: Record<string, Colours> = {};
        Object.keys(map).sort().forEach((key) => {
            const c: Colours = {};
            const entry = ownOf(map, key) || {};
            FIELDS.forEach(([f]) => { const v = entry[f]; if (v) c[f] = v; });
            out[key] = c;
        });
        return out;
    }

    /** The stored document, or '' when nothing is overridden. */
    function serialize(): string {
        if (legacy) return legacy.json;
        if (!Object.keys(state.groupPresets).length && !Object.keys(state.groups).length && !Object.keys(state.labels).length) return '';
        const out: Record<string, unknown> = { v: 2, preset: state.preset };
        if (Object.keys(state.groupPresets).length) out.groupPresets = Object.fromEntries(Object.keys(state.groupPresets).sort().map((g) => [g, state.groupPresets[g]]));
        if (Object.keys(state.groups).length) out.groups = canonical(state.groups);
        if (Object.keys(state.labels).length) out.labels = canonical(state.labels);
        return JSON.stringify(out);
    }

    return {
        load, serialize, snapshot,
        settings: () => ({ preset: state.preset }),
        refreshLabels() { if (current === 'custom' && target !== ALL && !labelsOf('custom').some((l) => l.key === target)) target = ALL; render(); },
    };
};

const A = JE.adminTags = JE.adminTags || {};
A.EDITOR_HTML = EDITOR_HTML;
A.createTagStylesEditor = createTagStylesEditor;
// The pure contrast helpers (tests run them on their own).
A.tagStyleContrast = { rgbaOf, compositeOver, luminance, contrastRatio, contrastLevel };
