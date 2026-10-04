#!/usr/bin/env node
// Computes, for every parity profile and tag-cache entry, the tag containers the
// web would render, by running the REAL JE modules (js/core/media-language.js,
// js/core/tag-renderer-base.js, js/enhanced/config.js, js/tags/*.js,
// js/extras/colored-ratings.js) in a VM with a minimal DOM and JE stubs.
//
// Per profile it boots the modules the way plugin.js does (JE.loadSettings,
// then the Stage 6 initializers in plugin.js order), then renders each entry
// exactly like the pipeline's server-cache path (tag-pipeline.js processChunk:
// every enabled renderer's renderFromServerCache into one tag host, in
// registration order), waits for the async user-review chips, and reads the
// resulting containers. The top-right indicator offset comes from the real
// CSS rules tag-pipeline.js builds, applied when jellyfin-web would show a
// played / unplayed-count indicator.
//
// Output: data/out/web-<profile>.json
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const jsRoot = join(here, '..', '..', 'Jellyfin.Plugin.JellyfinEnhanced', 'js');
const dataDir = join(here, 'data');
const outDir = join(dataDir, 'out');
mkdirSync(outDir, { recursive: true });
const readData = (...p) => JSON.parse(readFileSync(join(dataDir, ...p), 'utf8'));

const SCRIPTS = [
    'core/media-language.js',
    'core/tag-renderer-base.js',
    'enhanced/config.js',
    'tags/tag-pipeline.js',
    'tags/genretags.js',
    'tags/languagetags.js',
    'tags/qualitytags.js',
    'tags/ratingtags.js',
    'tags/ageratingtags.js',
    'tags/userreviewtags.js',
    'extras/colored-ratings.js',
];
const sources = Object.fromEntries(SCRIPTS.map((s) => [s, readFileSync(join(jsRoot, s), 'utf8')]));

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
        this.style = {};
        this.attributes = {};
        this._text = '';
        this.classList = new ClassList(this);
    }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this._text = String(v); this.children = []; }
    get parentNode() { return this.parentElement; }
    appendChild(child) { if (child.parentElement) child.remove(); child.parentElement = this; this.children.push(child); return child; }
    insertBefore(child, ref) { child.parentElement = this; const i = this.children.indexOf(ref); if (i < 0) this.children.push(child); else this.children.splice(i, 0, child); return child; }
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
    querySelectorAll() { return []; }
    addEventListener() {}
    removeEventListener() {}
    getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; }
}

function createSandbox(profile, pluginConfig, webSettings, reviews) {
    const css = {};
    const document = {
        createElement: (tag) => new Element(tag),
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
        t: (k) => k,
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
        encodeURIComponent, decodeURIComponent, AbortController,
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
};
const cornerOf = (pos) => {
    const isTop = pos.includes('top');
    const isLeft = pos.includes('left');
    return isTop ? (isLeft ? 'TopLeft' : 'TopRight') : (isLeft ? 'BottomLeft' : 'BottomRight');
};

function readTags(group, container) {
    const tags = [];
    for (const child of container.children) {
        switch (group) {
            case 'Quality':
                tags.push(`${child.textContent}|${qualityCategory(child.dataset.quality, child.textContent)}`);
                break;
            case 'Genre': {
                const icon = child.querySelector('.je-msym-outlined');
                tags.push(`${child.title}|${icon ? icon.textContent : ''}`);
                break;
            }
            case 'Rating': {
                const text = child.querySelector('.rating-text')?.textContent ?? '';
                if (child.classList.contains('je-userreview-tag')) tags.push(`UserReview|${text}`);
                else if (child.classList.contains('rating-tag-critic')) tags.push(`Critic|${text}|${child.querySelector('.rating-tomato-icon')?.classList.contains('fresh') ? 'fresh' : 'rotten'}`);
                else tags.push(`Community|${text}`);
                break;
            }
            case 'AgeRating':
                tags.push(`${child.textContent.toUpperCase()}|${child.getAttribute('rating')}`);
                break;
            case 'Language': {
                const flag = child.dataset.lang === 'zxx' ? 'no-dialogue' : child.dataset.lang;
                tags.push(`${flag}|${child.dataset.langName}|${child.dataset.partial === 'true'}`);
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
    if (JE.pluginConfig?.ShowUserReviews && JE.pluginConfig?.ShowUserRatingOnPosters && s?.ratingTagsEnabled) JE.initializeUserReviewTags();
    if (s?.languageTagsEnabled) JE.initializeLanguageTags();
    JE.tagPipeline.initialize();
    await sleep(20); // quality waits for the Jellyfin audio preference before registering

    // Containers whose position earns the indicator offset, from the real pipeline CSS.
    const offsetClasses = new Set([...(css['je-tag-pipeline-perf'] || '').matchAll(/> \.je-tag-host > \.([a-z-]+-overlay-container)/g)].map((m) => m[1]));

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

    const items = {};
    for (const [id, host] of hosts) {
        const indicator = showsIndicator(userData[id]);
        items[id] = host.children
            .filter((c) => CONTAINERS[c.className.split(' ')[0]])
            .map((c) => {
                const cls = c.className.split(' ')[0];
                const group = CONTAINERS[cls];
                return { g: group, c: cornerOf(c.dataset.jeCorner || ''), o: indicator && offsetClasses.has(cls), t: readTags(group, c) };
            })
            .filter((g) => g.t.length > 0);
    }

    const pos = (u, p, f) => JE.core.tagRenderer.resolvePosition(u, p, f).pos;
    const readInt = (k, d) => (Number.isFinite(s[k]) ? s[k] : d);
    const scope = (u, p) => (typeof s[u] === 'boolean' ? s[u] : (typeof pluginConfig[p] === 'boolean' ? pluginConfig[p] : true));
    const settings = {
        qualityTagsEnabled: !!s.qualityTagsEnabled, genreTagsEnabled: !!s.genreTagsEnabled, languageTagsEnabled: !!s.languageTagsEnabled,
        ratingTagsEnabled: !!s.ratingTagsEnabled, ageRatingTagsEnabled: !!s.ageRatingTagsEnabled,
        qualityTagsPosition: pos('qualityTagsPosition', 'QualityTagsPosition', 'top-left'),
        genreTagsPosition: pos('genreTagsPosition', 'GenreTagsPosition', 'top-right'),
        languageTagsPosition: pos('languageTagsPosition', 'LanguageTagsPosition', 'bottom-left'),
        ratingTagsPosition: pos('ratingTagsPosition', 'RatingTagsPosition', 'bottom-right'),
        ageRatingTagsPosition: pos('ageRatingTagsPosition', 'AgeRatingTagsPosition', 'bottom-right'),
        showResolutionTag: typeof s.showResolutionTag === 'boolean' ? s.showResolutionTag : true,
        showSourceTag: typeof s.showSourceTag === 'boolean' ? s.showSourceTag : true,
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
        // The panel checkbox and the server both read "anything but false" as on.
        useNativePosterTags: s.useNativePosterTags !== false,
        nativeEnabled: pluginConfig.NativePosterTagsEnabled === true && s.useNativePosterTags !== false,
        groupOrder: [...order.keys()].join(','),
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
