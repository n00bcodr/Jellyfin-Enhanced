import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHarness, plain } from '../helpers/harness.mjs';

// Hidden tags (#1043): the administrator hides Tag Styles labels (tiles of the Colours tag list) in
// TagHiddenValues; the web drops exactly the chips each label colours, where native posters do
// (TagHiddenRules / PosterTagResolver, tests/backend/Core/CoreTagHiddenValuesTests.cs).

const labels = JSON.parse(readFileSync(new URL('../../fixtures/hidden-tag-labels.json', import.meta.url)));
const en = JSON.parse(readFileSync(new URL('../../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json', import.meta.url)));
const CARD = '<div class="card" data-type="Movie" data-id="a"><div class="cardBox"><div class="cardScalable"><div class="cardImageContainer"></div><div class="je-tag-host"></div></div><div class="cardText">Title</div></div></div>';

/**
 * The real renderer modules over the real layout controller, with the pipeline replaced by a registry.
 * @param {*} t
 * @param {{settings?: Object, hidden?: Object|null, ages?: string[], plugin?: Object, files?: string[]}} [options]
 */
function setup(t, { settings = {}, hidden = null, ages = [], plugin = {}, files = [] } = {}) {
  const renderers = new Map();
  const h = createHarness({ html: CARD,
    JE: { currentSettings: { tagLayoutSettingsVersion: 1, ...settings }, pluginConfig: { TagHiddenValues: hidden, TagHiddenAgeRatings: ages, ...plugin },
      t: (key, params = {}) => Object.entries(params).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), en[key] || key),
      session: { getUserId: () => 'a', getServerId: () => 's', onUserChange() {} },
      _cacheManager: { register() {}, markDirty() {} }, cdn: { url: (a, b) => `http://jf/${a}/${b}`, flagSvg: () => 'data:,' },
      tagPipeline: { tagStripRevision: () => 'none', registerRenderer: (id, renderer) => renderers.set(id, renderer), getRenderer: (id) => renderers.get(id), clearProcessed() {}, scheduleScan() {} } },
    apiClient: { getUrl: (path) => `http://jf/${path}` },
    // The age rating colours stylesheet; its rules do not matter here.
    fetch: async () => ({ ok: true, text: async () => '.mediaInfoOfficialRating[rating="NR"] { color: red; }' }) });
  t.after(() => h.close());
  for (const file of ['core/ui-kit.js', 'core/media-language.js', 'extras/colored-ratings.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/tag-layout-styles.js', ...files]) h.load(file);
  const host = h.document.querySelector('.je-tag-host');
  return { ...h, host, renderer: (id) => renderers.get(id),
    render(id, entry) { renderers.get(id).renderFromServerCache(host, entry, 'a'); h.JE.core.tagLayout.flushFit?.(); },
    shown: (selector) => [...host.querySelectorAll(`.je-tag-slot:not([data-je-slot="hover"]) ${selector}`)] };
}

test('chips take the label the shared fixture names (native posters read the same rows)', t => {
  const h = setup(t, { files: ['tags/genretags.js'] });
  const M = h.JE.core.mediaLanguage;
  for (const [group, value, label] of labels.cases) {
    if (group === 'genre') assert.equal(h.JE.genreTags.labelFor(value), label, value);
    if (group === 'language') assert.equal(M.canonicalBase(M.parseLanguageTag(value).base), label, value);
  }
});

test('the lists come from the public configuration, either key case, and a replaced configuration is read again', t => {
  const h = setup(t, { hidden: { Genre: ['drama'], logos: ['provider'] }, ages: ['PG-13'] });
  const H = h.JE.core.tagHidden;
  assert.equal(H.hides('genre', 'drama'), true);
  assert.equal(H.hides('genre', 'Drama'), false, 'labels are exact');
  assert.equal(H.hides('logos', 'provider'), true);
  assert.equal(H.hidesAgeRating('PG-13'), true);
  assert.equal(H.any('agerating'), true, 'the renderer name is the same group');
  h.JE.pluginConfig.TagHiddenValues = null;
  h.JE.pluginConfig.TagHiddenAgeRatings = [];
  assert.equal(H.hides('genre', 'drama'), false);
  assert.equal(H.hidesAgeRating('PG-13'), false);
});

test('a hidden genre label hides every spelling before the limit, so the next genres take their places', t => {
  const h = setup(t, { settings: { genreTagsEnabled: true }, hidden: { Genre: ['drama', 'comedy'] }, files: ['tags/genretags.js'] });
  h.JE.initializeGenreTags();
  h.render('genre', { Type: 'Movie', Genres: ['Fantasy', 'Drame', 'Comedy', 'Family'] });
  assert.deepEqual(h.shown('.genre-tag').map((g) => g.title), ['Fantasy', 'Family']);
});

test('quality hides by colour label (audio without its channels) after the best resolution is chosen', t => {
  const h = setup(t, { settings: { qualityTagsEnabled: true, qualityTagsPreferredAudioLanguage: 'none', tagGroupCaps: { quality: 0 } }, files: ['tags/qualitytags.js'] });
  h.JE.initializeQualityTags();
  const entry = { Type: 'Movie', StreamData: { Sources: [{ Id: 'a' }, { Id: 'b' }], Streams: [{ Type: 'Video', Codec: 'hevc', Width: 3840, Height: 2160, SourceId: 'a' },
    { Type: 'Video', Codec: 'h264', Width: 1920, Height: 1080, SourceId: 'b' }, { Type: 'Audio', Codec: 'eac3', Channels: 6, SourceId: 'a' }] } };
  const quality = () => h.shown('.quality-overlay-label').map((l) => l.dataset.quality);
  h.render('quality', entry);
  const before = quality();
  assert.ok(before.includes('4K') && before.includes('HEVC') && before.includes('Dolby Digital+'), `control: ${before}`);
  h.JE.pluginConfig.TagHiddenValues = { Quality: ['4K', 'HEVC', 'Dolby Digital+'] };
  h.JE.reinitializeQualityTags();
  h.render('quality', entry);
  const after = quality();
  assert.ok(!after.includes('4K') && !after.includes('1080p'), `hiding 4K never promotes 1080p: ${after}`);
  assert.ok(!after.includes('HEVC') && !after.includes('Dolby Digital+'), `${after}`);
});

test('a hidden language leaves the flags, the Dual badge still counts it; Subtitles and Dual hide by kind', t => {
  const h = setup(t, { settings: { languageTagsEnabled: true, languageTagsCountBadge: 'both', languageTagsShowSubtitles: true }, hidden: { Language: ['en'] }, files: ['tags/languagetags.js'] });
  const group = h.JE.core.languageTags.buildGroup({ audio: [{ code: 'eng', name: 'English' }, { code: 'jpn', name: 'Japanese' }], subtitles: [{ code: 'fre', name: 'French' }] }, 0, () => 'data:,');
  assert.deepEqual([...group.children].map((c) => c.dataset.jeLanguage === 'countBadge' ? 'badge' : c.dataset.lang), ['badge', 'jp', 'fr']);
  // Subtitles and Dual/Multi are dropped where every group's chips are, before the limit.
  h.JE.initializeLanguageTags();
  h.JE.pluginConfig.TagHiddenValues = { Language: ['en', 'subtitles', 'dual'] };
  h.JE.reinitializeLanguageTags();
  h.render('language', { Type: 'Movie', AudioLanguages: ['eng', 'jpn'], SubtitleLanguages: ['fre'] });
  assert.deepEqual(h.shown('[data-je-language]').map((c) => c.dataset.jeLanguage), ['flag']);
});

test('age rating boards, awards, logos and Custom chips hide by their label', t => {
  const h = setup(t, {
    settings: { ageRatingTagsEnabled: true, logoTagsEnabled: true, awardsTagsEnabled: true, customTagsEnabled: true },
    hidden: { Logos: ['company'], Awards: ['oscar'], Custom: ['Kids'] }, ages: ['NR'],
    plugin: { LogoTagsMaxLogos: 2, AwardsTagsEnabled: true, CustomTagRules: [{ Id: 'tag:1', Label: 'Kids' }, { Id: 'tag:2', Label: 'Classic' }] },
    files: ['tags/ageratingtags.js', 'tags/logotags.js', 'tags/awardstags.js', 'tags/customtags.js'],
  });
  h.JE.initializeAgeRatingTags();
  h.render('agerating', { Type: 'Movie', OfficialRating: 'Not Rated' });
  assert.deepEqual(h.shown('.age-rating-tag'), [], '"Not Rated" shows as NR, on a hidden board');
  const logos = [{ kind: 'network', name: 'HBO', logo: '/hbo.png' }, { kind: 'provider', name: 'Netflix', logo: '/n.png' }, { kind: 'studio', name: 'A24', logo: '/a.png' }, { kind: 'provider', name: 'Max', logo: '/m.png' }];
  assert.deepEqual(plain(h.JE.logoTags.readLogos(logos)).map((l) => l.name), ['Netflix', 'Max'], 'hidden company logos leave before the two-logo limit');
  h.JE.initializeAwardsTags();
  h.render('awards', { Type: 'Movie', Awards: { oscarWinner: true, emmyWinner: true } });
  assert.deepEqual(h.shown('.awards-tag').map((a) => a.dataset.jeAward), ['emmy']);
  h.JE.initializeCustomTags();
  h.render('custom', { Type: 'Movie', CustomTags: ['tag:1', 'tag:2'] });
  assert.deepEqual(h.shown('[data-je-custom]').map((c) => c.dataset.jeCustom), ['Classic']);
});

test('the logo renderer caches every logo, so showing a hidden kind again needs no refetch', t => {
  const h = setup(t, { settings: { logoTagsEnabled: true }, hidden: { Logos: ['company'] }, plugin: { LogoTagsMaxLogos: 2 }, files: ['tags/logotags.js'] });
  h.JE.initializeLogoTags();
  const chips = () => h.shown('.je-logo-chip').map((c) => c.title);
  h.renderer('logos').render(h.host, { Id: 'a', Type: 'Movie', Logos: [{ kind: 'network', name: 'HBO', logo: '/hbo.png' }, { kind: 'provider', name: 'Netflix', logo: '/n.png' }] }, { stripRevision: 'none' });
  h.JE.core.tagLayout.flushFit?.();
  assert.deepEqual(chips(), ['Netflix']);
  h.JE.pluginConfig.TagHiddenValues = null;
  h.JE.reinitializeLogoTags();
  assert.equal(h.renderer('logos').renderFromCache(h.host, 'a'), true, 'answered from the card cache');
  h.JE.core.tagLayout.flushFit?.();
  assert.deepEqual(chips(), ['HBO', 'Netflix']);
});
