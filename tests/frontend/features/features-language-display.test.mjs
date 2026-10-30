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
      _cacheManager: { register() {}, markDirty() {} }, tagPipeline: { registerRenderer: (key, value) => registrations.set(key, value), clearProcessed() {}, scheduleScan() {} } } });
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
  assert.equal(chips[0].title, 'English');
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

test('hoverable language chips retain Jellyfin link clicks and modifier keys', t => {
  const h = setup(t, { languageTagsShowSubtitles: true });
  const overlay = h.document.createElement('div'); overlay.className = 'cardOverlayContainer';
  const link = h.document.createElement('a'); link.className = 'cardImageContainer'; link.href = '#/details?id=a';
  overlay.append(link); h.target.append(overlay);
  const received = [];
  link.addEventListener('click', event => { received.push(event.ctrlKey); event.preventDefault(); });
  h.renderer.renderFromServerCache(h.target, { AudioLanguages: ['en'], SubtitleLanguages: ['fr'] });
  h.target.querySelector('.language-subtitle').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, ctrlKey: true }));
  assert.deepEqual(received, [true]);
  h.renderer.injectCss();
  assert.match(h.document.getElementById('language-tags-styles').textContent, /\.je-tag-host:has\(\.language-overlay-container\) \{ z-index: 2;/);
});

test('container batch fallback reads subtitle facts from the projected first episode', t => {
  const h = setup(t, { languageTagsShowSubtitles: true, languageTagsStyle: 'codes' });
  h.renderer.render(h.target, { Id: 'a', Type: 'Series', SubtitleLanguages: null }, {
    firstEpisode: { Id: 'episode', Type: 'Episode', SubtitleLanguages: ['fr'], MediaStreams: [{ Type: 'Audio', Language: 'en' }] }
  });
  assert.deepEqual(h.chips().map(el => el.textContent), ['EN', 'CCFR']);
});
