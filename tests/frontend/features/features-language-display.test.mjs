import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHarness } from '../helpers/harness.mjs';
const en = JSON.parse(readFileSync(new URL('../../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json', import.meta.url)));
const translate = (key, params = {}) => Object.entries(params).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), en[key] || key);

/** Real renderer factory and layout controller, with captured pipeline registration. */
function setup(t, settings = {}, plugin = {}) {
  const registrations = new Map();
  const h = createHarness({ html: '<div class="card" data-id="a"><div class="cardBox"><div class="cardScalable"><div class="cardImageContainer"></div></div><div class="cardText">Title</div></div></div>',
    JE: { currentSettings: { languageTagsEnabled: true, ...settings }, pluginConfig: { TagCacheServerMode: false, ...plugin }, t: translate,
      cdn: { flagSvg: code => `/flags/${code}.svg` }, session: { getUserId: () => 'a', getServerId: () => 's', onUserChange() {} },
      _cacheManager: { register() {}, markDirty() {} }, tagPipeline: { tagStripRevision: () => 'none', registerRenderer: (key, value) => registrations.set(key, { ...value, render: (el, item, extras = {}) => value.render(el, item, { stripRevision: 'none', ...extras }) }), clearProcessed() {}, scheduleScan() {} } } });
  t.after(() => h.close());
  for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'core/media-language.js', 'tags/languagetags.js']) h.load(file);
  h.JE.initializeLanguageTags();
  h.target = h.document.querySelector('.cardScalable');
  h.renderer = registrations.get('language');
  h.chips = () => [...h.target.querySelector('.language-overlay-container')?.children || []].filter(el => !el.hidden && el.style.display !== 'none' && !el.classList.contains('je-tag-more'));
  return h;
}

test('CC subtitles follow audio under one cap; tooltips retain full names', t => {
  const h = setup(t, { languageTagsShowSubtitles: true });
  h.renderer.renderFromServerCache(h.target, { AudioLanguages: ['en', 'fr'], SubtitleLanguages: ['ja', 'ja', 'de'] });
  const chips = h.chips();
  assert.equal(chips.length, 3);
  assert.deepEqual(chips.map(el => el.dataset.jeLanguage), ['flag', 'flag', 'subtitles']);
  assert.equal(chips[2].querySelector('.language-cc').textContent, 'CC');
  assert.match(chips[2].title, /Subtitles: Japanese/);
  assert.equal(chips[0].title, 'Audio: English');
});

test('Codes use canonical ISO codes, keep partial treatment and three-letter fallbacks', t => {
  const h = setup(t, { languageTagsStyle: 'codes', languageTagsShowSubtitles: true, tagGroupCaps: { language: 0 }, tagLayoutSettingsVersion: 1 });
  h.renderer.renderFromServerCache(h.target, { AudioLanguages: ['eng', 'en', 'jpn', 'ast'], PartialAudioLanguages: ['jpn'], SubtitleLanguages: ['fre', 'fra'] });
  const chips = h.chips();
  assert.deepEqual(chips.map(el => el.textContent), ['EN', 'AST', 'JA', 'CCFR']);
  assert.equal(chips[2].dataset.partial, 'true');
  assert.ok(chips[2].classList.contains('language-flag-partial'));
  assert.match(chips[2].title, /Japanese.*not on all episodes/);
  assert.equal(chips[3].querySelector('.language-cc').textContent, 'CC');
});

for (const [audio, expected] of [[['en'], null], [['eng', 'en'], null], [['en', 'ja'], 'Dual'], [['hi', 'ta', 'te'], 'Multi'], [['en-US', 'en-GB', 'zxx'], null]]) {
  test(`badge threshold after language dedupe: ${audio.join(',')}`, t => {
    const h = setup(t, { languageTagsCountBadge: 'both' });
    h.renderer.renderFromServerCache(h.target, { AudioLanguages: audio });
    assert.equal(h.target.querySelector('.language-count-badge')?.textContent || null, expected);
  });
}

test('badge only replaces audio when it qualifies and keeps selected subtitles', t => {
  const h = setup(t, { languageTagsCountBadge: 'only', languageTagsShowSubtitles: true });
  h.renderer.renderFromServerCache(h.target, { AudioLanguages: ['en', 'ja'], SubtitleLanguages: ['de'] });
  assert.deepEqual(h.chips().map(el => el.dataset.jeLanguage), ['countBadge', 'subtitles']);
});

test('subtitle-only mode works with empty audio and respects admin priority and regions', t => {
  const h = setup(t, { languageTagsShowAudio: false, languageTagsShowSubtitles: true }, { LanguageTagsPriority: 'pt, Japanese', LanguageTagsPriorityStrict: true });
  h.renderer.renderFromServerCache(h.target, { AudioLanguages: [], SubtitleLanguages: ['en', 'ja', 'pt-br'] });
  assert.deepEqual(h.chips().map(el => el.dataset.lang), ['br', 'jp']);
});

test('batch renderer retains subtitle facts through local cache and setting reinitialization', t => {
  const h = setup(t, { languageTagsShowSubtitles: true });
  const item = { Id: 'a', Type: 'Movie', SubtitleLanguages: ['fr'], MediaStreams: [{ Type: 'Audio', Language: 'en' }] };
  h.renderer.render(h.target, item, {});
  assert.equal(h.chips()[1].title, 'Subtitles: French');
  h.JE.currentSettings.languageTagsStyle = 'codes';
  h.JE.reinitializeLanguageTags();
  h.renderer.renderFromCache(h.target, 'a');
  assert.deepEqual(h.chips().map(el => el.textContent), ['EN', 'CCFR']);
});

test('feature defaults preserve audio flags and invalid display enums normalize on load', t => {
  const h = setup(t);
  h.JE.userConfig = { settings: { languageTagsStyle: 'invalid', languageTagsCountBadge: 'invalid' } };
  h.load('enhanced/config.js');
  const conf = h.JE.loadSettings();
  assert.equal(conf.languageTagsStyle, 'flags');
  assert.equal(conf.languageTagsCountBadge, 'off');
  h.renderer.renderFromServerCache(h.target, { AudioLanguages: ['en'], SubtitleLanguages: ['de'] });
  assert.equal(h.chips().length, 1);
  assert.ok(h.chips()[0].matches('img.language-flag'));
});

test('a language code or count badge remains visible as a Summary pill fact', t => {
  const h = setup(t, { tagLayout: 'summary', tagLayoutSettingsVersion: 1, tagLayouts: { summary: { groups: [{ group: 'language', slot: 'pill' }] } }, languageTagsStyle: 'codes' });
  h.renderer.renderFromServerCache(h.target, { AudioLanguages: ['en'] });
  assert.match(h.target.querySelector('.je-tag-pill').textContent, /EN/);
});

test('hoverable language chips use unfocusable native anchors through clones and caption moves', async t => {
  const h = setup(t, { languageTagsShowSubtitles: true });
  const overlay = h.document.createElement('div'); overlay.className = 'cardOverlayContainer';
  const link = h.document.createElement('a'); link.className = 'cardImageContainer'; link.href = '#/details?id=a';
  overlay.append(link); h.target.append(overlay);
  h.renderer.renderFromServerCache(h.target, { AudioLanguages: ['en'], SubtitleLanguages: ['fr'] });
  const anchors = h.target.querySelectorAll('a.language-link');
  assert.equal(anchors.length, 2);
  for (const a of anchors) {
    assert.equal(a.getAttribute('href'), '#/details?id=a');
    assert.equal(a.getAttribute('tabindex'), '-1');
  }
  assert.equal(anchors[0].title, 'Audio: English');
  assert.equal(anchors[1].title, 'Subtitles: French');
  assert.ok(anchors[0].querySelector('img.language-flag'));
  assert.ok(anchors[1].querySelector('.language-cc'));
  h.JE.currentSettings.tagLayout = 'caption';
  h.JE.currentSettings.tagLayoutSettingsVersion = 1;
  await h.JE.core.tagLayout.reinitialize();
  const captioned = h.document.querySelectorAll('.je-tag-caption a.language-link');
  assert.equal(captioned.length, 2);
  for (const a of captioned) assert.equal(a.getAttribute('tabindex'), '-1');
  h.JE.currentSettings.tagLayout = 'summary';
  h.JE.currentSettings.tagLayouts = { summary: { groups: [{ group: 'language', slot: 'pill' }] } };
  await h.JE.core.tagLayout.reinitialize();
  assert.equal(h.target.querySelector('a.je-tag-pill').getAttribute('href'), '#/details?id=a');
  assert.equal(h.target.querySelector('a.je-tag-pill').getAttribute('tabindex'), '-1');
  const hovered = h.target.querySelectorAll('[data-je-slot="hover"] a.language-link');
  assert.equal(hovered.length, 2);
  for (const a of hovered) assert.equal(a.getAttribute('tabindex'), '-1');
  assert.equal(link.hasAttribute('tabindex'), false);
});

test('container batch fallback reads subtitle facts from the projected first episode', t => {
  const h = setup(t, { languageTagsShowSubtitles: true, languageTagsStyle: 'codes' });
  h.renderer.render(h.target, { Id: 'a', Type: 'Series', SubtitleLanguages: null }, {
    firstEpisode: { Id: 'episode', Type: 'Episode', SubtitleLanguages: ['fr'], MediaStreams: [{ Type: 'Audio', Language: 'en' }] }
  });
  assert.deepEqual(h.chips().map(el => el.textContent), ['EN', 'CCFR']);
});

for (const [input, expected] of [['tl', 'TL'], ['tgl', 'TL'], ['nb', 'NB'], ['nob', 'NB'], ['nn', 'NN'], ['nno', 'NN'], ['fil', 'FIL'], ['srd', 'SC'], ['cmn', 'CMN']]) {
  test(`ISO display code is independent of audio equivalence: ${input}`, t => {
    const h = setup(t, { languageTagsStyle: 'codes', languageTagsShowSubtitles: true });
    h.renderer.renderFromServerCache(h.target, { AudioLanguages: [input], SubtitleLanguages: [input] });
    assert.deepEqual(h.chips().map(el => el.textContent), [expected, `CC${expected}`]);
    assert.equal(h.JE.core.mediaLanguage.displayCode(input.toUpperCase() + '-PH'), expected);
  });
}

for (const audio of [['tgl', 'tl', 'fil'], ['nob', 'nb', 'nno', 'nn', 'nor']]) {
  test(`audio-equivalent codes still dedupe and count once: ${audio}`, t => {
    const h = setup(t, { languageTagsStyle: 'codes', languageTagsCountBadge: 'both' });
    h.renderer.renderFromServerCache(h.target, { AudioLanguages: audio });
    assert.equal(h.chips().length, 1);
    assert.equal(h.target.querySelector('.language-count-badge'), null);
    assert.equal(h.chips()[0].textContent, audio[0] === 'tgl' ? 'TL' : 'NB');
    assert.ok(h.JE.core.mediaLanguage.matchesLanguage(audio[0], audio.at(-1)));
  });
}

for (const style of ['flags', 'codes']) {
  test(`Summary subtitle ${style} keeps CC and full-name title`, t => {
    const h = setup(t, { languageTagsShowAudio: false, languageTagsShowSubtitles: true, languageTagsStyle: style,
      tagLayout: 'summary', tagLayoutSettingsVersion: 1, tagLayouts: { summary: { groups: [{ group: 'language', slot: 'pill' }] } } });
    h.renderer.renderFromServerCache(h.target, { SubtitleLanguages: ['en'] });
    const pill = h.target.querySelector('.je-tag-pill');
    assert.equal(pill.querySelector('.language-cc').textContent, 'CC');
    assert.equal(pill.title, 'Subtitles: English');
    assert.equal(pill.getAttribute('aria-label'), 'Subtitles: English');
    assert.equal(pill.querySelector('.je-tag-pill-fact').title, 'Subtitles: English');
    if (style === 'flags') assert.ok(pill.querySelector('img.je-tag-pill-flag'));
    else assert.equal(pill.textContent, 'CC EN');
  });
}

for (const [audio, text, title] of [[['en'], 'EN', 'Audio: English'], [['en', 'ja'], 'Dual', '2 audio languages: English, Japanese'], [['en', 'ja', 'fr'], 'Multi', '3 audio languages: English, Japanese, French']]) {
  test(`Summary keeps the original title for ${text}`, t => {
    const h = setup(t, { languageTagsStyle: 'codes', languageTagsCountBadge: 'both',
      tagLayout: 'summary', tagLayoutSettingsVersion: 1, tagLayouts: { summary: { groups: [{ group: 'language', slot: 'pill' }] } } });
    h.renderer.renderFromServerCache(h.target, { AudioLanguages: audio });
    const pill = h.target.querySelector('.je-tag-pill');
    assert.equal(pill.textContent, text);
    assert.equal(pill.title, title);
    assert.equal(pill.getAttribute('aria-label'), title);
  });
}

for (const style of ['flags', 'codes']) {
  test(`personal priorities override admin order with canonical ISO matching: ${style}`, t => {
    const h = setup(t, { languageTagsStyle: style, languageTagsPriority: ['jpn', 'eng'] }, { LanguageTagsPriority: 'French', LanguageTagsPriorityStrict: true });
    h.renderer.renderFromServerCache(h.target, { AudioLanguages: ['fra', 'eng', 'jpn'], PartialAudioLanguages: ['jpn'] });
    assert.deepEqual(h.chips().map(el => el.dataset.lang), style === 'flags' ? ['jp', 'gb'] : ['ja', 'en']);
    assert.match(h.chips()[0].title, /Audio: Japanese.*not on all episodes/);
  });
}

for (const strict of [null, true, false]) {
  test(`strict inheritance and personal override ${strict}`, t => {
    const h = setup(t, { languageTagsPriority: ['ja'], languageTagsPriorityStrict: strict }, { LanguageTagsPriority: 'French', LanguageTagsPriorityStrict: true });
    h.renderer.renderFromServerCache(h.target, { AudioLanguages: ['eng', 'jpn', 'fra'] });
    assert.deepEqual(h.chips().map(el => el.dataset.lang), strict === false ? ['jp', 'gb', 'fr'] : ['jp']);
  });
}

test('personal code matches every language sharing a flag and preserves region merging', t => {
  const h = setup(t, { languageTagsPriority: ['tam', 'por'], languageTagsPriorityStrict: true });
  h.renderer.renderFromServerCache(h.target, { AudioLanguages: ['hin', 'tam', 'pt-BR', 'por'] });
  assert.deepEqual(h.chips().map(el => el.dataset.lang), ['in', 'br', 'pt']);
  assert.match(h.chips()[0].title, /Hindi, Tamil/);
  h.JE.pluginConfig.LanguageTagsMergeRegions = true;
  h.JE.reinitializeLanguageTags();
  h.renderer.renderFromServerCache(h.target, { AudioLanguages: ['hin', 'tam', 'pt-BR', 'por'] });
  assert.deepEqual(h.chips().map(el => el.dataset.lang), ['in', 'pt']);
});

test('empty personal priority opts out of admin strict filtering; null returns to live policy', t => {
  const h = setup(t, { languageTagsPriority: [] }, { LanguageTagsPriority: 'French', LanguageTagsPriorityStrict: true });
  h.renderer.renderFromServerCache(h.target, { AudioLanguages: ['eng', 'jpn', 'fra'] });
  assert.deepEqual(h.chips().map(el => el.dataset.lang), ['gb', 'jp', 'fr']);
  h.JE.currentSettings.languageTagsPriority = null;
  h.JE.reinitializeLanguageTags();
  h.renderer.renderFromServerCache(h.target, { AudioLanguages: ['eng', 'jpn', 'fra'] });
  assert.deepEqual(h.chips().map(el => el.dataset.lang), ['fr']);
});

test('personal list orders subtitle chips, count tooltip names and Summary fact together', async t => {
  const h = setup(t, { languageTagsPriority: ['ja', 'en'], languageTagsPriorityStrict: true,
    languageTagsShowSubtitles: true, languageTagsCountBadge: 'only', tagLayoutSettingsVersion: 1,
    tagLayout: 'summary', tagLayouts: { summary: { groups: [{ group: 'language', slot: 'pill' }] } } });
  h.renderer.renderFromServerCache(h.target, { AudioLanguages: ['fra', 'eng', 'jpn'], PartialAudioLanguages: ['eng'], SubtitleLanguages: ['eng', 'fra', 'jpn'] });
  const pill = h.target.querySelector('.je-tag-pill');
  assert.equal(pill.textContent, 'Dual');
  assert.match(pill.title, /^2 audio languages: Japanese, English.*not on all episodes/);
  const chips = h.target.querySelector('[data-je-slot="hover"] .language-overlay-container').children;
  assert.equal(chips[1].title, 'Subtitles: Japanese');
  assert.equal(chips[2].title, 'Subtitles: English');
  assert.equal(chips[1].getAttribute('aria-label'), chips[1].title);
  h.JE.currentSettings.languageTagsCountBadge = 'off';
  h.JE.reinitializeLanguageTags();
  h.renderer.renderFromServerCache(h.target, { AudioLanguages: ['eng', 'jpn'], PartialAudioLanguages: ['jpn'] });
  assert.match(h.target.querySelector('.je-tag-pill').title, /Audio: Japanese.*not on all episodes/);
});

test('settings preserve nullable inheritance, empty list and canonical values across unrelated saves', async t => {
  const h = setup(t);
  const writes = [];
  h.window.ApiClient.ajax = async req => writes.push(JSON.parse(req.data));
  h.load('enhanced/config.js');
  for (const [stored, list, strict] of [
    [{}, null, null],
    [{ languageTagsPriority: [], languageTagsPriorityStrict: false }, [], false],
    [{ languageTagsPriority: ['jpn', 'eng', 'en'] }, ['ja', 'en'], null],
    [{ languageTagsPriority: ['Japanese'] }, null, null],
  ]) {
    h.JE.userConfig = { settings: stored };
    h.JE.currentSettings = h.JE.loadSettings();
    h.JE.currentSettings.showFileSizes = true;
    await h.JE.saveUserSettings('settings.json', h.JE.currentSettings);
    assert.deepEqual(writes.at(-1).languageTagsPriority, list);
    assert.equal(writes.at(-1).languageTagsPriorityStrict, strict);
  }
});

test('personal ISO choices validate, deduplicate audio equivalences and support name/code search inputs', t => {
  const h = setup(t);
  const M = h.JE.core.mediaLanguage;
  assert.deepEqual(Array.from(M.priorityList(['eng', 'en', 'ger', 'deu', 'tgl', 'tl', 'fil', 'nob', 'nno'])), ['en', 'de', 'fil', 'no']);
  for (const raw of ['English', 'pt-BR', 'xx', 'xxx', 'und', 'mul', 'pob', '__proto__']) assert.equal(M.priorityCode(raw), null);
  assert.equal(M.priorityList(Array(13).fill('en')), null);
  const choices = M.priorityChoices();
  const french = choices.find(c => c.code === 'fr');
  assert.equal(french.name, 'French');
  assert.ok(french.aliases.includes('fre') && french.aliases.includes('fra'));
  assert.equal(new Set(choices.map(c => c.code)).size, choices.length);
});

test('user switch reuses raw cached facts under the incoming policy without inheriting another users priorities', t => {
  const h = setup(t, { languageTagsPriority: ['ja'] });
  const item = { Id: 'a', Type: 'Movie', MediaStreams: [{ Type: 'Audio', Language: 'en' }, { Type: 'Audio', Language: 'ja' }] };
  h.renderer.render(h.target, item, {});
  assert.deepEqual(h.chips().map(el => el.dataset.lang), ['jp', 'gb']);
  h.JE.currentSettings = { languageTagsEnabled: true, languageTagsPriority: null };
  h.JE.reinitializeLanguageTags();
  h.renderer.renderFromCache(h.target, 'a');
  assert.deepEqual(h.chips().map(el => el.dataset.lang), ['gb', 'jp']);
});

test('language editor searches equivalent names and keeps full ISO names on browsers with small ICU tables', t => {
  const h = setup(t);
  const original = h.window.Intl.DisplayNames;
  h.window.Intl.DisplayNames = class { of(code) { return code; } };
  try {
    const choices = h.JE.core.mediaLanguage.priorityChoices();
    assert.equal(choices.find(c => c.code === 'aa').name, 'Afar');
    const filipino = choices.find(c => c.code === 'fil');
    assert.ok(filipino.aliases.some(name => name.includes('Tagalog')));
    assert.ok(filipino.aliases.some(name => name.includes('Filipino')));
    const norwegian = choices.find(c => c.code === 'no');
    assert.ok(norwegian.aliases.some(name => name.includes('Bokmål')));
    assert.ok(norwegian.aliases.some(name => name.includes('Nynorsk')));
  } finally { h.window.Intl.DisplayNames = original; }
});
