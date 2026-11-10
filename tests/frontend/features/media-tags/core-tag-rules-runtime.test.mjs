import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHarness, plain, jsRoot } from '../../helpers/harness.mjs';

function setup(t) {
    const h = createHarness({JE: {currentSettings: {}, pluginConfig: {}, t: key => key,
        cdn: {flagSvg: code => `/flags/${code}.svg`}}});
    t.after(() => h.close());
    for (const file of ['core/media-language.js', 'core/tag-layout.js', 'core/tag-look.js', 'tags/rating-sources.js', 'tags/status-vocabulary.js', 'tags/tag-poster-colours.js']) h.load(file);
    return h;
}

test('emitted language rules reject prototype names without inventing flags or aliases', t => {
    const {JE} = setup(t);
    const language = JE.core.mediaLanguage;
    for (const input of ['constructor', '__proto__', 'toString', '', null, undefined, 37]) {
        assert.equal(language.resolveFlag(input), null);
        assert.equal(language.parseLanguageTag(input), null);
    }
    assert.equal(language.canonicalBase('constructor'), 'constructor');
    assert.equal(language.resolveFlag({code: 'pt-XA'}), 'pt');
    assert.equal(language.resolveFlag({code: 'zh-yue-HK'}), 'hk');
    assert.equal(language.resolveFlag('zxx-US'), 'zxx');
    assert.equal(language.priorityList(['en', 'bad-code']), null);
    assert.equal(language.priorityList(Array(13).fill('en')), null);
    assert.deepEqual(plain(language.priorityList(['eng', 'en', 'nno', 'nob'])), ['en', 'no']);
});

test('emitted locale numbers and compact labels match the native shared tables', t => {
    const {JE} = setup(t);
    const numbers = JSON.parse(readFileSync(join(jsRoot, 'tags/score-numbers.json'), 'utf8'));
    for (const locale of ['ar', 'ar-BH', 'ar-DZ', 'fa', 'de', 'fr', 'en', 'hi', 'zh-Hant']) {
        JE.currentSettings.displayLanguage = locale;
        const format = numbers.formats[numbers.locales[locale]] || {decimal: '.', digits: '0123456789'};
        const expected = '0123456789.5%'.replace(/[0-9.]/g, c => c === '.' ? format.decimal : format.digits[Number(c)]);
        assert.equal(JE.core.mediaLanguage.formatNumberText('0123456789.5%'), expected, locale);
    }
    const compact = JSON.parse(readFileSync(join(jsRoot, 'tags/quality-compact.json'), 'utf8'));
    for (const [label, [short, keep]] of Object.entries(compact)) {
        assert.equal(JE.core.tagLayout.compactQualityLabel(label), short, label);
        assert.equal(JE.core.tagLayout.compactQualityLabel(`${label} 7.1`), short + (keep ? ' 7.1' : ''), label);
    }
    assert.deepEqual(plain(JE.statusVocabulary), JSON.parse(readFileSync(join(jsRoot, 'tags/status-vocabulary.json'), 'utf8')));
});

test('emitted layout rules use the supplied draft logo policy and preserve nullable inheritance', t => {
    const {JE} = setup(t);
    JE.pluginConfig.LogoTagsMaxLogos = 1;
    const own = {tagLayoutSettingsVersion: 1, tagGroupCaps: {logos: 4}, tagScale: null, tagGap: null};
    const draft = JE.core.tagLayout.normalizeSettings(own, {LogoTagsMaxLogos: 5, TagScale: 'largest', TagGap: 'roomy'});
    assert.equal(draft.caps.logos, 4);
    assert.equal(draft.tagScale, 'largest');
    assert.equal(draft.tagGap, 'roomy');
    const invalid = JE.core.tagLayout.normalizeSettings({...own, tagScale: 'invalid', tagGap: ''}, {TagScale: 'largest', TagGap: 'roomy'});
    assert.equal(invalid.tagScale, 'default');
    assert.equal(invalid.tagGap, 'default');
    const legacy = JE.core.tagLayout.normalizeSettings({}, {TagScale: 'largest', TagGap: 'roomy', TagEdgeSpacing: 'flush'});
    assert.equal(legacy.tagScale, 'default');
    assert.equal(legacy.edge, 'default');
    assert.equal(JE.core.tagLook.normalizeLock({layout: 'bands', lockedAt: Infinity}).lockedAt, 0);
    assert.equal(JE.core.tagLook.normalizeLock({layout: 'bands', lockedAt: -200}).lockedAt, 0);
    assert.equal(JE.core.tagLook.normalizeLock({layout: 'bands', lockedAt: '120'}).lockedAt, 120);
});

test('emitted poster colours tolerate malformed artwork escapes and invalid pixel data', t => {
    const {JE} = setup(t);
    const colours = JE.tagPosterColours;
    const id = 'a'.repeat(32);
    assert.equal(colours.keyOf(`/Items/${id}/Images/Primary?tag=%E0%A4%A`), `${id}:primary:0:%E0%A4%A`);
    assert.equal(colours.keyOf(`/Items/${id}/Images/Primary?tag=hello%20world`), `${id}:primary:0:hello world`);
    for (const input of [null, [], [NaN, 0, 0], [Infinity, 10, 20], [-1, 10, 20], [256, 10, 20], 'red']) {
        assert.deepEqual(plain(colours.normalise(input)), plain(colours.NEUTRAL));
    }
    assert.equal(colours.dominant([NaN, 30, 40, 255], 1, 1), null);
    assert.equal(colours.dominant([], Infinity, Infinity), null);
    assert.deepEqual(plain(colours.dominant([200, 30, 30, 255], 1, 1)), [200, 30, 30]);
});

test('emitted rating rules keep missing, empty, zero, invalid and extreme scores distinct', t => {
    const {JE} = setup(t);
    const source = JE.ratingSources;
    assert.deepEqual(plain(source.normalizeSources(['imdb', null, 'imdb', 'constructor', 'tmdb'])), ['imdb', 'tmdb']);
    assert.deepEqual(plain(source.settings({ratingTagsSources: []}).sources), []);
    assert.deepEqual(plain(source.resolve(null, undefined, {Imdb: 1e100, Tmdb: -20, Trakt: 'NaN'}, {sources: ['imdb', 'tmdb', 'trakt'], minimum: 0, color: false})), [
        {id: 'imdb', value: 10, text: '10.0', color: null}, {id: 'tmdb', value: 0, text: '0%', color: null},
    ]);
    assert.deepEqual(plain(source.resolve(0, '', null, {sources: ['community', 'critic'], minimum: 0, color: false})), [
        {id: 'community', value: 0, text: '—', color: null},
    ]);
});

test('real loader order installs config after tag-look: save posts and rejected writes roll back', async t => {
    const h = setup(t);
    const before = [{id: 'original', when: [{field: 'type', value: 'Movie'}], layout: 'bands', density: 'full'}];
    h.JE.currentSettings.tagLookRules = before;
    assert.equal(typeof h.JE.saveUserSettings, 'undefined');
    assert.equal(await h.JE.core.tagLook.saveRules([]), false, 'unavailable persistence cannot claim success');
    assert.equal(h.JE.currentSettings.tagLookRules, before);
    h.JE.userConfig = {settingsRevision: 'revision-1', settings: {}};
    h.JE.toast = () => {};
    h.window.ApiClient.getCurrentUserId = () => 'user-a';
    h.window.ApiClient.serverId = () => 'server-a';
    h.window.ApiClient.getUrl = path => `http://jellyfin.test${path}`;
    let reject = false;
    const posts = [];
    h.window.ApiClient.ajax = async request => {
        posts.push(JSON.parse(request.data));
        assert.match(request.url, /\/user-settings\/user-a\/settings-document$/);
        if (reject) throw {status: 500};
        return {Revision: 'revision-2'};
    };
    h.load('enhanced/config.js');
    assert.equal(typeof h.JE.saveUserSettings, 'function');
    assert.equal(await h.JE.core.tagLook.saveRules(before), true);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].Revision, 'revision-1');
    assert.equal((posts[0].Settings.tagLookRules || posts[0].Settings.TagLookRules)[0].id, 'original');
    const saved = h.JE.currentSettings.tagLookRules;
    reject = true;
    assert.equal(await h.JE.core.tagLook.saveRules([]), false);
    assert.equal(posts.length, 2, 'second write reaches the transport');
    assert.equal(h.JE.currentSettings.tagLookRules, saved, 'rollback restores the saved rules');
});
