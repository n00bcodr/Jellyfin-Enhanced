#!/usr/bin/env node
// Computes, for every parity profile and tag-cache entry, the tag containers the
// web would render, by running the REAL JE modules (js/core/media-language.js,
// js/core/tag-renderer-base.js, js/core/tag-layout.js, js/enhanced/config.js, js/tags/*.js,
// js/extras/colored-ratings.js) in a VM with a minimal DOM and JE stubs.
//
// Per profile it boots the modules the way plugin.js does (JE.loadSettings,
// then the Stage 6 initializers in plugin.js order), then renders each entry
// exactly like the pipeline's server-cache path (tag-pipeline.js processChunk:
// every enabled renderer's renderFromServerCache into one tag host, in
// registration order), waits for the async user-review chips, and reads the
// resulting groups from the layout controller in arrival order (their corner
// slot and the displayed, capped chips). The top-right indicator offset comes
// from the real slot and (settings saved before layouts) container rules
// tags/tag-layout-styles.js builds, applied when jellyfin-web would show a
// played / unplayed-count indicator.
//
// Output: data/out/web-<profile>.json
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const jsRoot = join(here, '..', '..', '..', 'Jellyfin.Plugin.JellyfinEnhanced', 'js');
const dataDir = join(here, 'data');
const outDir = join(dataDir, 'out');
mkdirSync(outDir, { recursive: true });
const readData = (...p) => JSON.parse(readFileSync(join(dataDir, ...p), 'utf8'));

const SCRIPTS = [
    'core/media-language.js',
    'core/tag-renderer-base.js',
    'core/tag-layout.js',
    'tags/rating-sources.js', 'enhanced/config.js',
    'tags/tag-pipeline.js',
    'tags/tag-layout-styles.js',
    'tags/genretags.js',
    'tags/languagetags.js',
    'tags/qualitytags.js',
    'tags/ratingtags.js',
    'tags/ageratingtags.js',
    'tags/awardstags.js',
    'tags/logotags.js',
    'tags/customtags.js',
    'tags/userreviewtags.js',
    'extras/colored-ratings.js',
];
const sources = Object.fromEntries(SCRIPTS.map((s) => [s, readFileSync(join(jsRoot, s), 'utf8')]));

const english = JSON.parse(readFileSync(join(jsRoot, 'locales/en.json'), 'utf8'));

// Quality category arrays, read from qualitytags.js itself (only to label categories).
const qualitySource = sources['tags/qualitytags.js'];
const qualityArrays = {};
for (const name of ['resolutionOrder', 'sourceOrder', 'dynamicRangeOrder', 'specialFormatOrder', 'codecOrder', 'audioOrder']) {
    const m = qualitySource.match(new RegExp(`const ${name} = (\\[[^\\]]*\\]);`));
    qualityArrays[name] = JSON.parse(m[1].replace(/'/g, '"'));
}
const CATEGORY_OF_ARRAY = { resolutionOrder: 'resolution', sourceOrder: 'source', dynamicRangeOrder: 'dynamicRange', specialFormatOrder: 'specialFormat', codecOrder: 'videoCodec', audioOrder: 'audioInfo' };
function qualityCategory(normalized, label) {
    for (const [name, items] of Object.entries(qualityArrays)) if (items.includes(normalized)) return CATEGORY_OF_ARRAY[name];
    return /^\d+\.\d+$/.test(label) ? 'audioInfo' : 'other';
}

// plugin.js toCamelCase (PascalCase settings.json keys -> camelCase), copied verbatim.
function toCamelCase(obj) {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return obj;
    const camelCased = {};
    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            camelCased[key.charAt(0).toLowerCase() + key.slice(1)] = toCamelCase(obj[key]);
        }
    }
    return camelCased;
}

// ── Minimal DOM ────────────────────────────────────────────────────────────
class ClassList {
    constructor(el) { this.el = el; }
    _list() { return this.el.className ? this.el.className.split(/\s+/).filter(Boolean) : []; }
    add(...names) { const l = this._list(); for (const n of names) if (!l.includes(n)) l.push(n); this.el.className = l.join(' '); }
    remove(...names) { this.el.className = this._list().filter((c) => !names.includes(c)).join(' '); }
    contains(name) { return this._list().includes(name); }
    toggle(name, force) { const has = this.contains(name); const want = force === undefined ? !has : force; if (want) this.add(name); else this.remove(name); return want; }
}
class Element {
    constructor(tag) {
        this.tagName = tag.toUpperCase();
        this.className = '';
        this.children = [];
        this.parentElement = null;
        this.dataset = {};
        this.style = { setProperty(name, value) { this[name] = value; }, removeProperty(name) { const old = this[name] || ""; delete this[name]; return old; } };
        this.attributes = {};
        this._text = '';
        this.classList = new ClassList(this);
    }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    get firstElementChild() { return this.children[0] || null; }
    get lastElementChild() { return this.children[this.children.length - 1] || null; }
    get childElementCount() { return this.children.length; }
    cloneNode(deep) {
        // Own properties (title, src, alt, dataset, attributes ...) are copied;
        // the layout controller presents copies of each committed group.
        const copy = new Element(this.tagName);
        for (const [key, value] of Object.entries(this)) {
            if (key === 'children' || key === 'parentElement' || key === 'classList') continue;
            copy[key] = Array.isArray(value) ? value.slice() : (value && typeof value === 'object' ? { ...value } : value);
        }
        if (deep) for (const child of this.children) copy.appendChild(child.cloneNode(true));
        return copy;
    }
    append(...nodes) { for (const node of nodes) this.appendChild(node); }
    replaceChildren(...nodes) { this.children = []; for (const n of nodes) this.appendChild(n); }
    set textContent(v) { this._text = String(v); this.children = []; }
    get parentNode() { return this.parentElement; }
    appendChild(child) { if (child.parentElement) child.remove(); child.parentElement = this; this.children.push(child); return child; }
    insertBefore(child, ref) { if (child.parentElement) child.remove(); child.parentElement = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(child); else this.children.splice(i, 0, child); return child; }
    removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) this.children.splice(i, 1); child.parentElement = null; return child; }
    remove() { if (this.parentElement) this.parentElement.removeChild(this); }
    setAttribute(n, v) { this.attributes[n] = String(v); }
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attributes, n) ? this.attributes[n] : null; }
    removeAttribute(n) { delete this.attributes[n]; }
    _matches(selector) {
        // Only the simple ".a" / ".a.b" class selectors the tag modules query with.
        const parts = selector.trim().split('.').filter(Boolean);
        return selector.trim().startsWith('.') && parts.every((p) => this.classList.contains(p));
    }
    matches() { return false; }
    closest() { return null; }
    querySelector(selector) {
        for (const sel of selector.split(',')) {
            const found = this._find(sel.trim());
            if (found) return found;
        }
        return null;
    }
    _find(sel) {
        for (const child of this.children) {
            if (child._matches(sel)) return child;
            const deep = child._find(sel);
            if (deep) return deep;
        }
        return null;
    }
    querySelectorAll(selector) {
        const out = [];
        const visit = el => { for (const child of el.children) { if (selector.split(',').some(sel => child._matches(sel.trim()))) out.push(child); visit(child); } };
        visit(this);
        return out;
    }
    addEventListener() {}
    removeEventListener() {}
    getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; }
}

function createSandbox(profile, pluginConfig, webSettings, reviews) {
    const css = {};
    const document = {
        createElement: (tag) => new Element(tag),
        createTextNode: (text) => { const node = new Element('#text'); node.textContent = text; return node; },
        querySelector: () => null,
        querySelectorAll: () => [],
        getElementById: () => null,
        addEventListener() {},
        removeEventListener() {},
        contains: () => true,
        body: new Element('body'),
        head: new Element('head'),
        documentElement: new Element('html'),
        visibilityState: 'visible',
    };
    const currentUserId = profile.user;
    const ApiClient = {
        getCurrentUserId: () => currentUserId,
        getUrl: (p) => p,
        // qualitytags.js primeJellyfinAudioPreference -> the user's Jellyfin audio language.
        getUser: async () => ({ Configuration: { AudioLanguagePreference: profile.jellyfinAudioPreference } }),
        ajax: async () => { throw new Error('no network in parity harness'); },
        getItem: async () => null,
    };
    const JE = {
        pluginConfig: pluginConfig,
        userConfig: { settings: toCamelCase(webSettings) },
        t: (k) => english[k] || k,
        cdn: {
            url: (a, b) => `cdn/${a}/${b}`,
            font: (f) => `cdn/font/${f}`,
            flagSvg(code) { return this.url('flag-icons', `flags/4x3/${String(code).toLowerCase()}.svg`); },
        },
        helpers: {
            onBodyMutation() { return () => {}; },
            onNavigate() {},
            addCSS(id, text) { css[id] = text; },
        },
        core: {
            ui: { injectCss(id, text) { css[id] = text; } },
            navigation: { onNavigate() {} },
            api: {
                // userreviewtags.js batch: GET /reviews/ratings?keys=movie:1,tv:2 -> fixture.
                async plugin(path) {
                    const keys = decodeURIComponent(path.split('keys=')[1] || '').split(',').filter(Boolean);
                    const ratings = {};
                    for (const k of keys) ratings[k] = Object.prototype.hasOwnProperty.call(reviews, k) ? reviews[k] : null;
                    return { ratings };
                },
            },
        },
    };
    const quietConsole = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
    const context = {
        console: quietConsole,
        document,
        ApiClient,
        JellyfinEnhanced: JE,
        location: { href: 'http://localhost/web/#/home.html' },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 },
        MutationObserver: class { observe() {} disconnect() {} },
        fetch: async () => { throw new Error('no network'); },
        setTimeout, clearTimeout, setInterval, clearInterval, Promise, Intl, Map, Set, WeakSet, WeakMap, JSON, Math, Date, Object, Array, String, Number, RegExp, Error,
        encodeURIComponent, decodeURIComponent, AbortController, URL, URLSearchParams,
        addEventListener() {},
        removeEventListener() {},
    };
    context.window = context;
    context.globalThis = context;
    vm.createContext(context);
    for (const script of SCRIPTS) vm.runInContext(sources[script], context, { filename: script });
    return { context, JE, css };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// jellyfin-web indicators.getPlayedIndicatorHtml (every tagged type can be marked played).
function showsIndicator(ud) {
    if (!ud) return false;
    if (ud.UnplayedItemCount) return true;
    return !!((ud.PlayedPercentage && ud.PlayedPercentage >= 100) || ud.Played);
}

const CONTAINERS = {
    'quality-overlay-container': 'Quality',
    'genre-overlay-container': 'Genre',
    'rating-overlay-container': 'Rating',
    'age-rating-overlay-container': 'AgeRating',
    'language-overlay-container': 'Language',
    'awards-overlay-container': 'Awards',
    'logo-overlay-container': 'Logos',
    'custom-overlay-container': 'Custom',
};
const cornerOf = (pos) => {
    const centre = { 'top-center': 'TopCenter', 'bottom-center': 'BottomCenter', 'center-left': 'CenterLeft', 'center-right': 'CenterRight', center: 'Center' };
    if (centre[pos]) return centre[pos];
    const isTop = pos.includes('top');
    const isLeft = pos.includes('left');
    return isTop ? (isLeft ? 'TopLeft' : 'TopRight') : (isLeft ? 'BottomLeft' : 'BottomRight');
};

function readTags(group, container) {
    const tags = [];
    for (const child of container.children) {
        switch (group) {
            case 'Quality':
                tags.push(`${child.textContent}|${child.dataset.jeQualityCategory || (child.dataset.jeEdition ? 'edition' : qualityCategory(child.dataset.quality, child.textContent))}`);
                break;
            case 'Genre': {
                const icon = child.querySelector('.je-msym-outlined');
                // name|glyph|Tag Styles label (the canonical genre the chip is coloured by).
                tags.push(`${child.title}|${icon ? icon.textContent : ''}|${child.dataset.jeGenre ?? ''}`);
                break;
            }
            case 'Rating': {
                const text = child.querySelector('.rating-text')?.textContent ?? '';
                if (child.classList.contains('je-userreview-tag')) tags.push(`UserReview|${text}`);
                else if (child.classList.contains('rating-tag-critic')) tags.push(`Critic|${text}|${child.querySelector('.rating-tomato-icon')?.classList.contains('fresh') ? 'fresh' : 'rotten'}`);
                else if (child.classList.contains('rating-tag--source')) tags.push(`${child.dataset.jeRatingSource}|${text}`);
                else tags.push(`Community|${text}`);
                break;
            }
            case 'Awards':
                tags.push(`${child.dataset.jeAward}|${child.textContent}`);
                break;
            case 'AgeRating':
                tags.push(`${child.textContent.toUpperCase()}|${child.getAttribute('rating')}`);
                break;
            case 'Logos': {
                // kind|name|logo path|name chip text (empty for an image chip).
                const img = child.querySelector('.je-logo-img');
                const path = img ? decodeURIComponent(String(img.src).replace(/^.*\/logo\/w92/, '')) : '';
                tags.push(`${child.dataset.jeLogoKind}|${child.title}|${path}|${img ? '' : child.textContent}`);
                break;
            }
            case 'Custom':
                tags.push(`${child.dataset.jeCustom}|${child.querySelector('.custom-tag-icon')?.textContent ?? ''}`);
                break;
            case 'Language': {
                const flag = child.dataset.lang === 'zxx' ? 'no-dialogue' : child.dataset.lang;
                if (child.classList.contains('language-count-badge')) tags.push(`badge|${child.textContent}`);
                else if (child.classList.contains('language-code')) tags.push(`code|${child.dataset.lang.toUpperCase()}|${child.dataset.langName}|${child.dataset.partial === 'true'}|${child.dataset.jeLanguage === 'subtitles'}${child.dataset.jeSdh ? '|sdh' : ''}`);
                else tags.push(`${flag}|${child.dataset.langName}|${child.dataset.partial === 'true'}${child.dataset.jeLanguage === 'subtitles' ? '|true' : ''}${child.dataset.jeSdh ? '|sdh' : ''}`);
                break;
            }
        }
    }
    return tags;
}

async function runProfile(profile) {
    const publicConfig = readData('inputs', 'public-config.json');
    const pluginConfig = { ...publicConfig, ...profile.pluginOverrides };
    const entries = { ...readData('inputs', `tagcache-${profile.user}.json`), ...(profile.synthetic ? readData('synthetic', 'entries.json') : {}) };
    const userData = { ...readData('inputs', `userdata-${profile.user}.json`), ...(profile.synthetic ? readData('synthetic', 'userdata.json') : {}) };
    const reviews = profile.reviews === 'synthetic' ? readData('synthetic', 'reviews.json') : readData('inputs', `reviews-${profile.user}.json`);

    const { JE, css } = createSandbox(profile, pluginConfig, profile.settingsWeb, reviews);

    // plugin.js Stage 4 + Stage 6 (tag-related initializers, same order and conditions).
    JE.currentSettings = JE.loadSettings();
    // Bands is composited natively; title/hover layouts retain the Corners profile.
    const nativeBands = Number(JE.currentSettings.tagLayoutSettingsVersion) >= 1 && JE.currentSettings.tagLayout === 'bands';
    JE.currentSettings.tagLayout = nativeBands ? 'bands' : 'corners';
    if (!nativeBands) JE.currentSettings.tagLabelDensity = 'full';
    JE.core.tagLayout.invalidateSettings();
    const order = new Map();
    const realRegister = JE.tagPipeline.registerRenderer;
    JE.tagPipeline.registerRenderer = function (name, config) {
        order.set(name, config);
        return realRegister.call(this, name, config);
    };
    const s = JE.currentSettings;
    if (s?.qualityTagsEnabled) JE.initializeQualityTags();
    if (s?.genreTagsEnabled) JE.initializeGenreTags();
    if (s?.ratingTagsEnabled) JE.initializeRatingTags();
    if (s?.ageRatingTagsEnabled) JE.initializeAgeRatingTags();
    if (s?.customTagsEnabled) JE.initializeCustomTags();
    if (JE.pluginConfig?.ShowUserReviews && JE.pluginConfig?.ShowUserRatingOnPosters && s?.ratingTagsEnabled) JE.initializeUserReviewTags();
    if (s?.languageTagsEnabled) JE.initializeLanguageTags();
    if (s?.awardsTagsEnabled && JE.pluginConfig.AwardsTagsEnabled !== false) JE.initializeAwardsTags();
    if (s?.logoTagsEnabled) JE.initializeLogoTags();
    JE.tagPipeline.initialize();
    await sleep(20); // quality waits for the Jellyfin audio preference before registering

    // Corner slots that earn the indicator offset, from the real layout CSS:
    // the whole slot on a host the controller marks data-je-indicator-gap, or
    // (settings saved before layouts) the containers it marks there. That
    // rule must reach every marked container wherever it sits in the stack
    // (no :first-child or other position filter after the marker), as each
    // one set to exactly top-right cleared the indicator before layouts.
    const layoutCss = JE.core.tagLayout.buildStyles();
    const offsetSlots = new Set([...layoutCss.matchAll(/:has\(\.countIndicator, \.playedIndicator\) > \.je-tag-host\[data-je-indicator-gap\] > \.je-tag-slot\[data-je-slot="([a-z]+)"\]/g)].map((m) => m[1]));
    // Edge spacing: the inset each marker declares (--je-edge) and the slots
    // whose edge rules use it; a host without the marker keeps the 6px default.
    const edgeInsets = Object.fromEntries([...layoutCss.matchAll(/\[data-je-edge="([a-z]+)"\] \{\s*--je-edge: (\d+(?:\.\d+)?)px;/g)].map((m) => [m[1], Number(m[2])]));
    const edgeSlots = new Set([...layoutCss.matchAll(/\[data-je-edge\] > \.je-tag-slot(?::is\(([^)]*)\)|\[data-je-slot="([a-z]+)"\])/g)]
        .flatMap((m) => (m[1] ? [...m[1].matchAll(/data-je-slot="([a-z]+)"/g)].map((s) => s[1]) : [m[2]])));
    const legacyOffsetSlots = new Set([...layoutCss.matchAll(/:has\(\.countIndicator, \.playedIndicator\) > \.je-tag-host\[data-je-legacy\] > \.je-tag-slot\[data-je-slot="([a-z]+)"\] > \[data-je-indicator-gap\](?=\s*[,{])/g)].map((m) => m[1]));

    const hosts = [];
    for (const [id, entry] of Object.entries(entries)) {
        const host = new Element('div');
        host.className = 'je-tag-host';
        for (const [, renderer] of order) {
            if (!renderer.isEnabled()) continue;
            if (renderer.renderFromServerCache) {
                try { renderer.renderFromServerCache(host, entry, id); } catch { /* the pipeline swallows renderer errors */ }
            }
        }
        hosts.push([id, host]);
    }
    await sleep(120); // user-review batches (30 ms window) settle and append their chips

    // Groups in stacking order: arrival order, or the explicit priority order
    // when the layout has one (a stable sort keeps arrival order otherwise).
    const layoutConf = JE.core.tagLayout.resolveLayout(null);
    const rank = (d) => (layoutConf.order ? layoutConf.order.indexOf(d.group) : 0);
    const items = {};
    for (const [id, host] of hosts) {
        const indicator = showsIndicator(userData[id]);
        items[id] = JE.core.tagLayout.describe(host)
            .sort((a, b) => rank(a) - rank(b))
            .filter((d) => d.element && CONTAINERS[d.element.className.split(' ')[0]])
            .map((d) => {
                const group = CONTAINERS[d.element.className.split(' ')[0]];
                const offset = (host.dataset.jeIndicatorGap === '1' && offsetSlots.has(d.slot))
                    || (d.element.dataset.jeIndicatorGap === '1' && legacyOffsetSlots.has(d.slot));
                const placed = { g: group, c: nativeBands ? (d.slot === 'top' ? 'TopLeft' : 'BottomLeft') : cornerOf(d.element.dataset.jeCorner || ''), o: indicator && !nativeBands && offset, t: readTags(group, d.element) };
                // Only a non-default edge spacing adds the inset, so other profiles' expectations stay as they were.
                const edge = host.dataset.jeEdge;
                if (!nativeBands && edge) placed.e = edgeSlots.has(d.slot) && edge in edgeInsets ? edgeInsets[edge] : 6;
                return placed;
            })
            .filter((g) => g.t.length > 0);
    }

    // The corners profile's slot (a corner, or "off") wins over the position setting.
    const SLOT_POS = { tl: 'top-left', tr: 'top-right', bl: 'bottom-left', br: 'bottom-right', tc: 'top-center', bc: 'bottom-center', ml: 'center-left', mr: 'center-right', c: 'center' };
    const groupOf = { qualityTagsPosition: 'quality', genreTagsPosition: 'genre', languageTagsPosition: 'language', ratingTagsPosition: 'rating', ageRatingTagsPosition: 'ageRating', logoTagsPosition: 'logos', customTagsPosition: 'custom' };
    const ownCorner = (u) => {
        if (nativeBands) return layoutConf.slots[groupOf[u]] === 'top' ? 'top-left' : layoutConf.slots[groupOf[u]] === 'bottom' ? 'bottom-left' : undefined;
        const groups = s.tagLayouts?.corners?.groups ?? s.tagLayouts?.Corners?.Groups;
        // Array items keep their PascalCase keys (toCamelCase does not recurse into arrays).
        const entry = Array.isArray(groups) ? groups.find((g) => JE.core.tagLayout.normalizeGroup(g?.group ?? g?.Group) === groupOf[u]) : null;
        const slot = entry ? String(entry.slot ?? entry.Slot ?? '').toLowerCase() : null;
        return SLOT_POS[slot] || null;
    };
    const pos = (u, p, f) => ownCorner(u) || JE.core.tagRenderer.resolvePosition(u, p, f).pos;
    const offGroups = ['quality', 'genre', 'rating', 'ageRating', 'language', 'awards', 'status', 'logos', 'custom'].filter((g) => layoutConf.slots[g] === 'off');
    const readInt = (k, d) => (Number.isFinite(s[k]) ? s[k] : d);
    const scope = (u, p) => (typeof s[u] === 'boolean' ? s[u] : (typeof pluginConfig[p] === 'boolean' ? pluginConfig[p] : true));
    const settings = {
        tagScale: layoutConf.tagScale, tagGap: layoutConf.tagGap,
        qualityTagsEnabled: !!s.qualityTagsEnabled, genreTagsEnabled: !!s.genreTagsEnabled, languageTagsEnabled: !!s.languageTagsEnabled,
        ratingTagsEnabled: !!s.ratingTagsEnabled, ageRatingTagsEnabled: !!s.ageRatingTagsEnabled,
        awardsTagsEnabled: !!s.awardsTagsEnabled && JE.pluginConfig.AwardsTagsEnabled === true,
        qualityTagsPosition: pos('qualityTagsPosition', 'QualityTagsPosition', 'top-left'),
        genreTagsPosition: pos('genreTagsPosition', 'GenreTagsPosition', 'top-right'),
        languageTagsPosition: pos('languageTagsPosition', 'LanguageTagsPosition', 'bottom-left'),
        languageTagsShowAudio: s.languageTagsShowAudio, languageTagsShowSubtitles: s.languageTagsShowSubtitles,
        languageTagsStyle: s.languageTagsStyle, languageTagsCountBadge: s.languageTagsCountBadge,
        languagePriorityTerms: JE.core.mediaLanguage.priorityPolicy().terms.join(','),
        languagePriorityStrict: JE.core.mediaLanguage.priorityPolicy().strict,
        languagePriorityIsPersonal: JE.core.mediaLanguage.priorityPolicy().personal,
        ratingTagsPosition: pos('ratingTagsPosition', 'RatingTagsPosition', 'bottom-right'),
        ageRatingTagsPosition: pos('ageRatingTagsPosition', 'AgeRatingTagsPosition', 'bottom-right'),
        logoTagsEnabled: !!s.logoTagsEnabled,
        logoTagsPosition: pos('logoTagsPosition', 'LogoTagsPosition', 'bottom-left'),
        customTagsEnabled: !!s.customTagsEnabled,
        customTagsPosition: pos('customTagsPosition', 'CustomTagsPosition', 'top-left'),
        showResolutionTag: typeof s.showResolutionTag === 'boolean' ? s.showResolutionTag : true,
        showSourceTag: typeof s.showSourceTag === 'boolean' ? s.showSourceTag : true,
        showEditionTag: typeof s.showEditionTag === 'boolean' ? s.showEditionTag : (pluginConfig.ShowEditionTag ?? true),
        showLowQualitySourceTag: typeof s.showLowQualitySourceTag === 'boolean' ? s.showLowQualitySourceTag : (pluginConfig.ShowLowQualitySourceTag ?? false),
        editionTagOrder: readInt('editionTagOrder', pluginConfig.EditionTagOrder ?? 7),
        showFrameRateTag: typeof s.showFrameRateTag === 'boolean' ? s.showFrameRateTag : (pluginConfig.ShowFrameRateTag ?? false),
        frameRateTagOrder: readInt('frameRateTagOrder', pluginConfig.FrameRateTagOrder ?? 10),
        showAspectRatioTag: typeof s.showAspectRatioTag === 'boolean' ? s.showAspectRatioTag : (pluginConfig.ShowAspectRatioTag ?? false),
        aspectRatioTagOrder: readInt('aspectRatioTagOrder', pluginConfig.AspectRatioTagOrder ?? 9),
        showRuntimeTag: typeof s.showRuntimeTag === 'boolean' ? s.showRuntimeTag : (pluginConfig.ShowRuntimeTag ?? false),
        runtimeTagOrder: readInt('runtimeTagOrder', pluginConfig.RuntimeTagOrder ?? 8),
        showDynamicRangeTag: typeof s.showDynamicRangeTag === 'boolean' ? s.showDynamicRangeTag : true,
        showSpecialFormatTag: typeof s.showSpecialFormatTag === 'boolean' ? s.showSpecialFormatTag : true,
        showVideoCodecTag: typeof s.showVideoCodecTag === 'boolean' ? s.showVideoCodecTag : true,
        showAudioInfoTag: typeof s.showAudioInfoTag === 'boolean' ? s.showAudioInfoTag : true,
        resolutionTagOrder: readInt('resolutionTagOrder', 1), sourceTagOrder: readInt('sourceTagOrder', 2),
        dynamicRangeTagOrder: readInt('dynamicRangeTagOrder', 3), specialFormatTagOrder: readInt('specialFormatTagOrder', 4),
        videoCodecTagOrder: readInt('videoCodecTagOrder', 5), audioInfoTagOrder: readInt('audioInfoTagOrder', 6),
        ratingTagsOnMovies: scope('ratingTagsOnMovies', 'RatingTagsOnMovies'), ratingTagsOnSeries: scope('ratingTagsOnSeries', 'RatingTagsOnSeries'),
        ratingTagsOnSeasons: scope('ratingTagsOnSeasons', 'RatingTagsOnSeasons'), ratingTagsOnEpisodes: scope('ratingTagsOnEpisodes', 'RatingTagsOnEpisodes'),
        qualityTagsPreferredAudioLanguage: String(s.qualityTagsPreferredAudioLanguage ?? ''),
        seriesQualityAggregation: ['latest', 'best', 'shared', 'mixed'].includes(s.seriesQualityAggregation ?? pluginConfig.SeriesQualityAggregation) ? (s.seriesQualityAggregation ?? pluginConfig.SeriesQualityAggregation) : 'representative',
        // The panel checkbox and the server both read "anything but false" as on.
        useNativePosterTags: s.useNativePosterTags !== false,
        nativeEnabled: pluginConfig.NativePosterTagsEnabled === true && s.useNativePosterTags !== false,
        groupOrder: [...order.keys()].join(','),
        ratingTagsShowCommunity: scope('ratingTagsShowCommunity', 'RatingTagsShowCommunity'),
        ratingTagsShowCritic: scope('ratingTagsShowCritic', 'RatingTagsShowCritic'),
        ratingTagsSources: JE.ratingSources.normalizeSources(s.ratingTagsSources)?.join(',') ?? null,
        ratingTagsMinScore: JE.ratingSources.settings().minimum,
        ratingTagsColorByScore: JE.ratingSources.settings().color,
        layoutOrder: layoutConf.order ? layoutConf.order.join(',') : null,
        layoutOff: offGroups.join(','),
        layoutCaps: ['quality', 'genre', 'language', 'rating', 'ageRating', 'awards', 'logos', 'custom'].map((g) => `${g}=${layoutConf.caps[g]}`).join(','),
        edgeSpacing: layoutConf.edge,
    };

    writeFileSync(join(outDir, `web-${profile.name}.json`), JSON.stringify({ settings, items }));
    return Object.keys(items).length;
}

const onlyProfile = process.argv[2];
const profiles = readData('profiles.json').filter((p) => !onlyProfile || p.name === onlyProfile);
for (const profile of profiles) {
    if (profile.settingsWeb === null) {
        throw new Error(`profile ${profile.name} has no web view of its settings yet (run the C# 'prepare' step first)`);
    }
    const count = await runProfile(profile);
    console.log(`web ${profile.name}: ${count} items`);
}
