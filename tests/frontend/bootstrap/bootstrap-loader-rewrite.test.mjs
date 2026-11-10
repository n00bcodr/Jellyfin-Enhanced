import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHarness, deferred, plain } from '../helpers/harness.mjs';
import { bootstrapFixture } from '../contracts/fixtures.mjs';

const USER_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', USER_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const payload = (extra = {}) => bootstrapFixture({ ComponentScripts: ['core/session.js', 'enhanced/config.js'], ...extra });
async function until(predicate, label = 'expected state') {
    const deadline = performance.now() + 3000;
    while (performance.now() < deadline) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.fail(`boot did not reach ${label}`);
}
const later = () => new Promise(resolve => setTimeout(resolve, 5));

/** The actual emitted plugin.js and validator. Only script transport is simulated. */
function boot(t, { ajax, data = payload(), hostUser, bundle = 'ok', modules, contract = 'real', html = '', storage = {}, idle, expectedConsoleErrors = [], server = 'server-a', fast = false } = {}) {
    const session = { userId: USER_A, serverId: server, token: 'token-a' };
    const calls = [], scripts = [];
    const h = createHarness({ expectedConsoleErrors,
        html: `<script plugin="Jellyfin Enhanced" version="1.2.3-build123"></script>${html}`,
        apiClient: {
            serverId: () => session.serverId, getCurrentUserId: () => session.userId, accessToken: () => session.token,
            getCurrentUser: async () => hostUser ? hostUser(session) : ({ Id: session.userId, Policy: { IsAdministrator: false } }),
            ajax: async request => {
                const path = new URL(request.url).pathname;
                calls.push(path);
                if (ajax) return ajax(path, request, session);
                if (path.endsWith('/bootstrap')) return typeof data === 'function' ? data(session) : data;
                throw new Error(`Unexpected endpoint ${path}`);
            }
        } });
    t.after(() => { h.errors.length = 0; h.close(); });
    for (const [key, value] of Object.entries(storage)) h.window.localStorage.setItem(key, value);
    h.window.requestIdleCallback = idle ?? (callback => { queueMicrotask(() => callback({ didTimeout: false, timeRemaining: () => 100 })); return 1; });
    if (fast) { const native = h.window.setTimeout.bind(h.window); h.window.setTimeout = callback => native(callback, 0); }
    const append = h.document.head.appendChild.bind(h.document.head);
    h.document.head.appendChild = node => {
        const result = append(node);
        if (node.tagName !== 'SCRIPT') return result;
        scripts.push(node);
        queueMicrotask(() => {
            const path = new URL(node.src).pathname;
            if (path.endsWith('/translations.js')) h.window.JellyfinEnhanced.loadTranslations = async () => ({ greeting: 'Hello' });
            else if (path.endsWith('/contracts/bootstrap.js')) {
                if (contract === 'fail') { node.onerror(new Error('blocked')); return; }
                if (contract === 'real') h.load('contracts/bootstrap.js');
                else h.window.__JE_BOOTSTRAP_CONTRACT__ = contract;
            } else if (path.endsWith('/bundle.js')) {
                if (bundle === 'error') { node.onerror(); return; }
                if (bundle === 'ok') {
                    const list = modules ?? [() => h.load('core/navigation.js'), () => h.load('core/session.js'), () => h.load('enhanced/config.js')];
                    h.window.__JE_BUNDLE_TOTAL = list.length;
                    h.window.__JE_BUNDLE_MODULES = list;
                }
                if (Array.isArray(bundle)) { h.window.__JE_BUNDLE_TOTAL = bundle.length; h.window.__JE_BUNDLE_MODULES = bundle; }
            } else {
                const name = path.split('/js/')[1];
                if (['core/navigation.js', 'core/session.js', 'enhanced/config.js'].includes(name)) h.load(name);
            }
            node.onload?.();
        });
        return result;
    };
    h.load('plugin.js');
    return { ...h, calls, scripts, session, get JE() { return h.window.JellyfinEnhanced; } };
}
const fallbackEndpoints = async (path, _request, session) => {
    if (path.endsWith('/bootstrap')) return payload({ UserId: session.userId });
    if (path.endsWith('/public-config')) return { fromFallback: true };
    if (path.endsWith('/version')) return '9.9.9';
    if (path.endsWith('/private-config') || path === '/Plugins' || path.includes('/user-settings/')) throw new Error('offline');
    if (path.endsWith('/component-scripts.json')) return ['core/navigation.js', 'core/session.js', 'enhanced/config.js'];
    throw new Error(`Unexpected endpoint ${path}`);
};

for (const [label, contract] of [['a blocked validator script', 'fail'], ['a validator with a missing parser', { parseBootstrap: value => value, parseSettingsDocument: value => value }]]) {
    test(`${label} falls back per endpoint and never trusts the bootstrap body`, async t => {
        const h = boot(t, { contract, ajax: fallbackEndpoints });
        await until(() => h.JE.initialized);
        assert.equal(h.JE.pluginConfig.fromFallback, true);
        assert.equal(h.JE.pluginVersion, '9.9.9');
        assert.equal(h.calls.filter(path => path.includes('/user-settings/')).length, 5);
    });
}

test('the validator loads once, versioned, and a failed load is retried rather than cached', async t => {
    const loaded = boot(t, { ajax: fallbackEndpoints });
    await until(() => loaded.JE.initialized);
    assert.equal(loaded.scripts.filter(script => script.src.includes('/contracts/bootstrap.js?v=1.2.3-build123')).length, 1);
    const failed = boot(t, { contract: 'fail', ajax: (path, request, session) => path.endsWith('-document') ? {} : fallbackEndpoints(path, request, session) });
    await until(() => failed.JE.initialized);
    assert.ok(failed.scripts.filter(script => script.src.includes('/contracts/bootstrap.js')).length > 1);
});

for (const [label, hostUser] of [
    ['a host user without a boolean policy', session => ({ Id: session.userId, Policy: {} })],
    ['a host user for someone else', () => ({ Id: USER_B, Policy: { IsAdministrator: true } })],
    ['no host user', async () => { throw new Error('unavailable'); }]
]) {
    test(`${label} rejects the whole bootstrap`, async t => {
        const h = boot(t, { hostUser, ajax: fallbackEndpoints });
        await until(() => h.JE.initialized);
        assert.equal(h.JE.pluginConfig.fromFallback, true);
        assert.equal(h.JE.pluginConfig.SonarrUrl, undefined);
    });
}

test('private config for a host-confirmed non-administrator is rejected before it reaches any global', async t => {
    const h = boot(t, { ajax: async (path, request, session) => path.endsWith('/bootstrap')
        ? payload({ UserId: session.userId, PrivateConfig: { SonarrUrl: 'secret' } }) : fallbackEndpoints(path, request, session) });
    await until(() => h.JE.initialized);
    assert.equal(h.JE.pluginConfig.SonarrUrl, undefined);
    assert.equal(h.JE.pluginConfig.fromFallback, true);
});

for (const [label, mutate] of [
    ['same account on another server', session => { session.serverId = 'server-b'; }],
    ['same account with a new token', session => { session.token = 'token-b'; }]
]) {
    test(`a bootstrap in flight is discarded for ${label}`, async t => {
        const first = deferred();
        let requests = 0;
        const h = boot(t, { ajax: async (path, _request, session) => {
            if (!path.endsWith('/bootstrap')) throw new Error(`Unexpected ${path}`);
            return ++requests === 1 ? first.promise : payload({ UserId: session.userId, PublicConfig: { MaintenanceModeMessage: 'current' } });
        } });
        await until(() => requests === 1);
        mutate(h.session);
        first.resolve(payload({ PublicConfig: { MaintenanceModeMessage: 'stale' } }));
        await until(() => h.JE.initialized);
        assert.equal(h.JE.pluginConfig.MaintenanceModeMessage, 'current');
    });
}

test('prefetched answers from a discarded bootstrap never reach the new session', async t => {
    const first = deferred();
    let requests = 0;
    // The new session's own bootstrap fails, so nothing replaces what the stale one left behind.
    const h = boot(t, { ajax: async (path, request, session) => {
        if (path.endsWith('/bootstrap') && ++requests === 1) return first.promise;
        if (path.endsWith('/bootstrap')) throw new Error('offline');
        return fallbackEndpoints(path, request, session);
    } });
    await until(() => requests === 1);
    h.session.token = 'token-b';
    const stale = payload();
    stale.Prefetched = { ...stale.Prefetched, SeerrStatus: { owner: 'previous session' } };
    first.resolve(stale);
    await until(() => h.JE.initialized);
    assert.equal(h.JE.takePrefetched('SeerrStatus'), undefined);
});

test('a fallback private config answered for the previous session is dropped', async t => {
    const answer = deferred();
    let seen = false;
    const h = boot(t, { contract: 'fail', ajax: async (path, request, session) => {
        if (path.endsWith('/private-config') && !seen) { seen = true; return answer.promise; }
        return fallbackEndpoints(path, request, session);
    } });
    await until(() => seen);
    h.session.userId = USER_B;
    answer.resolve({ SonarrUrl: 'secret' });
    await later();
    assert.equal(h.JE.pluginConfig.SonarrUrl, undefined);
});

test('a logout during component loading keeps none of that user\'s data', async t => {
    const h = boot(t, { data: payload({ PublicConfig: { TagLookItemOverrides: [] }, UserSettings: { Settings: { QualityTagsEnabled: true } } }), hostUser: session => ({ Id: session.userId, Policy: { IsAdministrator: true } }),
        modules: [() => { h.load('core/navigation.js'); }, () => { h.load('core/session.js'); }, () => { h.load('enhanced/config.js'); }, () => { h.session.userId = null; }] });
    await until(() => h.JE.initialized);
    assert.deepEqual(plain(h.JE.userConfig.settings), {});
    assert.equal(h.JE.pluginConfig.TagLookItemOverrides, null);
});

test('a server change during component loading reloads for the live session', async t => {
    let bootstraps = 0;
    const h = boot(t, { ajax: async (path, _request, session) => {
        if (path.endsWith('/bootstrap')) { bootstraps++; return payload({ UserId: session.userId, UserSettings: { Settings: { QualityTagsEnabled: session.serverId === 'server-b' } } }); }
        throw new Error(`Unexpected ${path}`);
    }, modules: [() => { h.load('core/navigation.js'); }, () => { h.load('core/session.js'); }, () => { h.load('enhanced/config.js'); }, () => { h.session.serverId = 'server-b'; }] });
    await until(() => h.JE.initialized);
    assert.equal(bootstraps, 2);
    assert.equal(h.JE.currentSettings.qualityTagsEnabled, true);
});

test('stale credentials stop the retry loop and release the splash screen', async t => {
    let hidden = 0;
    const h = boot(t, { fast: true, storage: { jellyfin_credentials: JSON.stringify({ Servers: [{ Id: 'other-server' }] }) },
        ajax: async path => path.endsWith('/public-config') ? {} : Promise.reject(new Error('unused')) });
    h.JE.hideSplashScreen = () => { hidden++; };
    await until(() => hidden > 0, 'splash release');
    assert.equal(hidden, 1);
    assert.equal(h.calls.includes('/JellyfinEnhanced/bootstrap'), false);
});

test('modules run in order; one that throws is reported and the run continues', async t => {
    const ran = [];
    const h = boot(t, { expectedConsoleErrors: ["Module 'core/session.js' threw"], data: payload({ ComponentScripts: ['one.js', 'core/session.js', 'enhanced/config.js'] }),
        modules: [() => { ran.push(1); h.load('core/navigation.js'); }, () => { ran.push(2); h.load('core/session.js'); throw new Error('load-time failure'); }, () => { ran.push(3); h.load('enhanced/config.js'); }] });
    await until(() => h.JE.initialized);
    assert.deepEqual(ran, [1, 2, 3]);
    assert.equal(h.window.__JE_BUNDLE_PROGRESS, 3);
    assert.equal(h.window.__JE_BUNDLE_MODULES, undefined);
    await later();
    assert.ok(h.errors.some(error => /load-time failure/.test(error?.message ?? error)), 'the failure still surfaces as an uncaught error');
});

for (const [label, bundle] of [['a non-function entry', [() => {}, 'not-a-module']], ['an empty list', []]]) {
    test(`${label} is a malformed bundle and falls back to ordered files`, async t => {
        const h = boot(t, { bundle });
        await until(() => h.JE.initialized);
        const files = h.scripts.filter(script => /core\/session\.js|enhanced\/config\.js/.test(script.src));
        assert.equal(files.length, 2);
        assert.ok(files.every(script => script.async === false));
    });
}

test('the bundle waits for idle time and slices yield once the idle period is spent', async t => {
    const idleCalls = [];
    const ran = [];
    let idleLeft = 100;
    const idle = (callback, options) => { idleCalls.push({ callback, options }); return idleCalls.length; };
    const h = boot(t, { idle, modules: [() => { ran.push(1); idleLeft = 0; h.load('core/navigation.js'); }, () => { ran.push(2); h.load('core/session.js'); }, () => { ran.push(3); h.load('enhanced/config.js'); }] });
    // The loader's clock stands still, so only the idle period ends a slice. On the wall clock a loaded machine can
    // spend the 10 ms run budget inside one module; the slice then waits for an idle callback this test never gives.
    h.window.performance.now = () => 0;
    const release = () => idleCalls.shift().callback({ didTimeout: false, timeRemaining: () => idleLeft });
    await until(() => idleCalls.length === 1, 'the idle wait before the bundle');
    assert.equal(h.scripts.some(script => script.src.includes('/bundle.js')), false, 'nothing is fetched before idle');
    assert.equal(idleCalls[0].options.timeout, 100);
    release();
    await until(() => h.scripts.some(script => script.src.includes('/bundle.js')) && idleCalls.length === 1, 'the idle wait before modules');
    assert.equal(h.scripts.find(script => script.src.includes('/bundle.js')).getAttribute('fetchpriority'), 'low');
    assert.deepEqual(ran, []);
    release();
    await until(() => ran.length === 1 && idleCalls.length === 1, 'the slice boundary');
    assert.deepEqual(ran, [1]);
    idleLeft = 100;
    release();
    await until(() => h.JE.initialized);
    assert.deepEqual(ran, [1, 2, 3]);
});

test('prefetched answers go out once, to the session that received them, while fresh', async t => {
    const data = payload();
    data.Prefetched = { ...data.Prefetched, SeerrStatus: { active: true }, SeerrUserStatus: { allowed: true }, ActiveStreamSessions: [{ Id: 'a' }] };
    const h = boot(t, { data });
    await until(() => h.JE.initialized);
    assert.deepEqual(plain(h.JE.takePrefetched('SeerrStatus')), { active: true });
    assert.equal(h.JE.takePrefetched('SeerrStatus'), undefined);
    assert.equal(h.JE.takePrefetched('Unknown'), undefined);
    assert.equal(h.JE.takePrefetched('ActiveStreamSessions', -1), undefined);
    h.session.token = 'token-b';
    assert.equal(h.JE.takePrefetched('SeerrUserStatus'), undefined, 'another session');
});

test('key conversion keeps stored data as data', async t => {
    const h = boot(t);
    await until(() => h.JE.initialized);
    const parse = h.window.JSON.parse;
    const value = h.JE.toCamelCase(parse('{"__proto__":{"Polluted":true},"KeyOne":{"Inner":[{"Kept":1}]}}'));
    assert.equal(value.polluted, undefined);
    assert.ok(Object.keys(value).includes('__proto__'));
    assert.deepEqual(plain(value.keyOne), { inner: [{ Kept: 1 }] });
    assert.deepEqual(plain(h.JE.toPascalCase({ keyOne: { inner: 1 } })), { KeyOne: { Inner: 1 } });
    assert.equal(h.JE.toCamelCase(null), null);
});

test('the namespace exists before the host client and serves the same local routes', async t => {
    const h = boot(t);
    const { JE } = h;
    await until(() => JE.initialized);
    assert.equal(h.window.JellyfinEnhanced, JE);
    assert.ok(JE.cdn.selfhst('svg/x.svg').endsWith('/JellyfinEnhanced/cdn/selfhst/svg/x.svg'));
    assert.ok(JE.cdn.flagPng('AU').endsWith('/JellyfinEnhanced/cdn/flagcdn/w20/au.png'));
    assert.ok(JE.cdn.flagSvg('AU').endsWith('/JellyfinEnhanced/cdn/flag-icons/flags/4x3/au.svg'));
    assert.ok(JE.cdn.url('x', '//a/b').endsWith('/JellyfinEnhanced/cdn/x/a/b'));
    assert.ok(JE.cdn.font('sym.woff2').endsWith('/JellyfinEnhanced/fonts/sym.woff2?v=1.2.3-build123'));
    assert.equal(JE.icon('x'), '{{ICON_PENDING:x}}');
    assert.equal(JE.escapeHtml(`<a&"'>`), '&lt;a&amp;&quot;&#039;&gt;');
    assert.equal(JE.escapeHtml(null), '');
});

test('the cache manager saves once per dirty mark and survives a failing callback', async t => {
    const h = boot(t, { expectedConsoleErrors: ['Cache save error:'] });
    await until(() => h.JE.initialized);
    const saved = [];
    const manager = h.JE._cacheManager;
    const callback = () => saved.push('ok');
    manager.register(() => { throw new Error('quota'); });
    manager.register(callback);
    manager.forceSave();
    assert.deepEqual(saved, ['ok']);
    manager.unregister(callback);
    manager.forceSave();
    assert.deepEqual(saved, ['ok']);
    manager.markDirty();
    assert.equal(manager.dirty, true);
});

const translator = (t, scope) => {
    const h = boot(t);
    Object.assign(h.JE, scope);
    return { t: h.JE.t, h };
};
const en = JSON.parse(readFileSync(new URL('../../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json', import.meta.url), 'utf8'));

test('emitted JE.t: plural forms, placeholders and icons', t => {
    const { t: tr, h } = translator(t, { translations: en, translationsLang: 'en' });
    assert.equal(tr('panel_media_tags_badge_window_added', { days: 1 }), 'within 1 day of being added');
    assert.equal(tr('panel_media_tags_badge_window_added', { days: 14 }), 'within 14 days of being added');
    assert.equal(tr('language_tags_count_tooltip', { count: 1 }), '1 audio language');
    assert.equal(tr('language_tags_count_tooltip', { count: 3 }), '3 audio languages');
    assert.equal(tr('missing_key'), 'missing_key');
    h.JE.translations = { named: 'Rule: {rule}', two: '{a} and {a}', tok: 'x {{icon:starFilled}}' };
    assert.equal(tr('named', { rule: 'Cost $& more $$ and $1' }), 'Rule: Cost $& more $$ and $1');
    assert.equal(tr('two', { a: "$'" }), "$' and $'");
    assert.equal(tr('tok'), 'x {{icon:starFilled}}', 'the placeholder stays until icons load');
    h.JE.IconName = { STAR_FILLED: 'star' };
    assert.equal(tr('tok'), 'x {{icon:starFilled}}', 'and until the icon system is ready');
    h.JE.icon = name => `<i>${name}</i>`;
    assert.equal(tr('tok'), 'x <i>star</i>');
    assert.equal(tr('named', null), 'Rule: {rule}');
});

test('emitted JE.t: a locale keeps its own language for every count', t => {
    const { t: tr } = translator(t, { translationsLang: 'ru', translationsFromEnglish: new Set(['k_one']), translations: { k: 'база {count}', k_one: '{count} English', k_few: '{count} мало', k_other: '{count} много' } });
    assert.equal(tr('k', { count: 3 }), '3 мало');
    assert.equal(tr('k', { count: 21 }), '21 база'.replace('база', 'много'));
});

test('feature initializers run in order and only when enabled', async t => {
    const stage = ['PluginRevisions', 'EnhancedScript', 'ElsewhereScript', 'JellyseerrScript', 'PauseScreen', 'Bookmarks', 'QualityTags', 'GenreTags', 'RatingTags', 'AgeRatingTags', 'StatusTags', 'AwardsTags', 'CustomTags', 'TagStyles', 'UserReviewTags',
        'ArrLinksScript', 'ArrTagLinksScript', 'SeerrDetailLinkScript', 'LetterboxdLinksScript', 'ReviewsScript', 'AwardsScript', 'DoesTheDogDieScript', 'MdblistRatingsScript', 'LanguageTags', 'LogoTags', 'PeopleTags', 'OsdRating', 'PlaybackRatingBadge', 'HiddenContent',
        'ColoredRatings', 'ThemeSelector', 'ActivityIcons', 'PluginIcons', 'DownloadsPage', 'CalendarPage', 'HiddenContentPage'];
    const flags = ['ElsewhereEnabled', 'JellyseerrEnabled', 'JellyseerrShowSearchResults', 'JellyseerrShowReportButton', 'TagStyleWebActive', 'ShowUserReviews', 'ShowUserRatingOnPosters', 'ArrLinksEnabled', 'ArrTagsShowAsLinks', 'JellyseerrShowDetailPageLink', 'LetterboxdEnabled', 'ShowAwards', 'DoesTheDogDieEnabled', 'MdblistRatingsEnabled', 'MdblistRatingsShowOnItemDetails', 'ShowPlaybackRatingBadge', 'HiddenContentEnabled', 'SpoilerBlurEnabled', 'ColoredRatingsEnabled', 'ThemeSelectorEnabled', 'ColoredActivityIconsEnabled', 'PluginIconsEnabled', 'ActiveStreamsEnabled', 'DownloadsPageEnabled', 'CalendarPageEnabled'];
    const settings = ['QualityTagsEnabled', 'GenreTagsEnabled', 'RatingTagsEnabled', 'AgeRatingTagsEnabled', 'StatusTagsEnabled', 'AwardsTagsEnabled', 'CustomTagsEnabled', 'LanguageTagsEnabled', 'LogoTagsEnabled', 'PeopleTagsEnabled'];
    const run = async (t, on) => {
        const initialized = [];
        const value = list => Object.fromEntries(list.map(name => [name, on]));
        const h = boot(t, { data: payload({ PublicConfig: { ...value(flags), ...value(settings) }, UserSettings: { Settings: value(settings) } }), modules: [
            () => h.load('core/navigation.js'), () => h.load('core/session.js'), () => h.load('enhanced/config.js'), () => {
                for (const name of stage) h.JE[`initialize${name}`] = () => initialized.push(name);
                h.JE.tagPipeline = { initialize: () => initialized.push('tagPipeline') };
                h.JE.spoilerBlur = { init: () => initialized.push('spoilerBlur') };
                h.JE.activeStreams = { initialize: () => initialized.push('activeStreams') };
                h.JE.jellyseerrIssueReporter = { initialize: () => initialized.push('issueReporter') };
                h.JE.themer = { init: () => initialized.push('themer') };
            }] });
        await until(() => h.JE.initialized);
        return initialized;
    };
    assert.deepEqual(await run(t, true), ['themer', 'PluginRevisions', 'EnhancedScript', 'ElsewhereScript', 'JellyseerrScript', 'issueReporter', 'PauseScreen', 'Bookmarks', 'QualityTags', 'GenreTags', 'RatingTags', 'AgeRatingTags', 'StatusTags', 'AwardsTags', 'CustomTags', 'TagStyles', 'UserReviewTags',
        'ArrLinksScript', 'ArrTagLinksScript', 'SeerrDetailLinkScript', 'LetterboxdLinksScript', 'ReviewsScript', 'AwardsScript', 'DoesTheDogDieScript', 'MdblistRatingsScript', 'LanguageTags', 'LogoTags', 'PeopleTags', 'tagPipeline', 'OsdRating', 'PlaybackRatingBadge', 'HiddenContent', 'spoilerBlur',
        'ColoredRatings', 'ThemeSelector', 'ActivityIcons', 'PluginIcons', 'activeStreams', 'DownloadsPage', 'CalendarPage', 'HiddenContentPage']);
    assert.deepEqual(await run(t, false), ['themer', 'PluginRevisions', 'EnhancedScript', 'PauseScreen', 'Bookmarks', 'tagPipeline', 'OsdRating']);
});
