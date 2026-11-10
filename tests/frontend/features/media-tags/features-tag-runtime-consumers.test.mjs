import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHarness, jsRoot } from '../../helpers/harness.mjs';

// What the rest of the plugin relies on from the tag runtime: every public facade, loaded in the
// real manifest order, and lifetimes that do not stack up across repeated initialization.

const ordered = JSON.parse(readFileSync(`${jsRoot}/component-scripts.json`, 'utf8')).filter(line => !line.startsWith('//'));
const RUNTIME = ['core/tag-renderer-base.js', 'tags/tag-cache-store.js', 'tags/tag-pipeline.js', 'tags/tag-layout-styles.js', 'tags/genretags.js', 'tags/languagetags.js',
  'tags/peopletags.js', 'tags/qualitytags.js', 'tags/ratingtags.js', 'tags/ageratingtags.js', 'tags/awardstags.js', 'tags/tag-direct-play.js', 'tags/statustags.js',
  'tags/logotags.js', 'tags/customtags.js', 'tags/tag-styles.js', 'tags/userreviewtags.js', 'tags/tag-item-editor.js', 'tags/tag-item-menu.js'];
const SUPPORT = new Set(['core/media-language.js', 'core/tag-layout.js', 'core/tag-look.js', 'tags/rating-sources.js', 'tags/status-vocabulary.js', 'tags/tag-poster-colours.js']);

function runtime(t, overrides = {}) {
  const userHooks = new Map();
  const h = createHarness({
    JE: {
      currentSettings: {}, pluginConfig: { TagCacheServerMode: true }, t: key => key, escapeHtml: value => value,
      cdn: { url: (bucket, file) => `/${bucket}/${file}`, flagSvg: code => `/${code}.svg`, flagPng: code => `/${code}.png` },
      session: { getUserId: () => 'user-a', getServerId: () => 'server-a', getEpoch: () => 0, isCurrent: () => true, onUserChange: (name, fn) => userHooks.set(name, fn) },
      helpers: { onBodyMutation() {}, onNavigate() {}, addCSS() {} },
      core: {
        ui: { injectCss() {}, removeCss() {} }, dom: { onBodyMutation() {}, createObserver() {} }, api: { plugin: async () => ({}) },
        navigation: { onNavigate() {} }, lifecycle: { register: () => ({ teardown() {}, track: value => value, untrack() {} }) },
      },
      ...overrides,
    },
  });
  t.after(() => h.close());
  for (const file of ordered.filter(file => RUNTIME.includes(file) || SUPPORT.has(file))) h.load(file);
  return { ...h, userHooks };
}
const keys = value => Object.keys(value).sort();

test('the loader manifest keeps every tag runtime output, in its original relative order', () => {
  assert.deepEqual(ordered.filter(file => RUNTIME.includes(file)), RUNTIME);
});

test('the shared facades keep their complete public surface', t => {
  const { JE } = runtime(t);
  assert.deepEqual(keys(JE.core.tagRenderer), ['applyCornerStacking', 'chipBaseCss', 'ensureStyles', 'isIgnoredContext', 'register', 'registerStyles', 'reinitialize', 'releaseStyles', 'resolvePosition', 'scheduleCornerStacking']);
  assert.deepEqual(keys(JE.core.tagScopes), ['SCOPED_GROUPS', 'SCOPE_IDS', 'TYPE_SCOPES', 'allows', 'excludes', 'follow', 'scopeDefault', 'scopeOwn', 'setOwn']);
  assert.deepEqual(keys(JE.core.tagSettingsMatrix), ['controls', 'except', 'groups', 'offers', 'surfaces']);
  assert.deepEqual(keys(JE.tagCacheStore), ['ENTRY_SCHEMA', 'applyDelta', 'available', 'beginFullWrite', 'clearOtherScopes', 'clearScope', 'commitFullWrite', 'getDirectPlay', 'getMany', 'getMeta', 'getPosterColours', 'putDirectPlay', 'putManyIfOwner', 'putPosterColours', 'reconcileAccess']);
  assert.deepEqual(keys(JE.tagPipeline), ['clearProcessed', 'getFirstEpisode', 'getParentSeries', 'getRenderer', 'getReviewRatings', 'getReviewRatingsRequestedAt', 'initialize', 'invalidateServerCache', 'itemLookFacts', 'lookupItemFacts', 'lookupServerEntries', 'onReviewRatingsChanged', 'peekItemFacts', 'peekReviewRatings', 'peekSeasonFacts', 'peekServerEntry', 'registerRenderer', 'rememberItemFacts', 'scheduleScan', 'serverEntries', 'stopWaitingForServerCache', 'tagStripRevision', 'waitForServerCache']);
  assert.deepEqual(keys(JE.tagDirectPlay), ['INPUTS', 'bitrate', 'classify', 'describe', 'peek', 'profile', 'profileHash', 'reset', 'setProfile', 'stats', 'track', 'untrack', 'webProfile']);
  assert.deepEqual(keys(JE.tagItemEditor), ['TYPES', 'anyTagsOn', 'close', 'isOpen', 'isOpening', 'open', 'stepCap']);
  assert.deepEqual(keys(JE.tagItemMenu), ['DATA_ID', 'inject']);
  assert.deepEqual(keys(JE.tagStyles), ['PRESETS', 'SCOPE_ATTR', 'buildCss', 'deactivate']);
  assert.deepEqual(keys(JE.genreTags), ['iconFor', 'labelFor']);
  assert.deepEqual(keys(JE.logoTags), ['buildChip', 'logoUrl', 'readLogos', 'shortName']);
  assert.deepEqual(keys(JE.customTags), ['ICONS', 'buildChip', 'currentRules', 'rulesFor']);
  assert.deepEqual(keys(JE.awardsTags), ['CSS', 'IDS', 'LABELS', 'chip', 'resolve']);
  assert.deepEqual(keys(JE.core.languageTags), ['buildGroup', 'readSettings']);
  assert.equal(typeof JE.core.tagLayout.buildStyles, 'function');
  assert.equal(typeof JE.core.tagLayout.buildFlushStyles, 'function');
});

test('every group keeps its initialize and reinitialize entry points', t => {
  const { JE } = runtime(t);
  for (const group of ['Genre', 'Language', 'Quality', 'Rating', 'AgeRating', 'Awards', 'Status', 'Logo', 'Custom']) {
    assert.equal(typeof JE[`initialize${group}Tags`], 'function', group);
    assert.equal(typeof JE[`reinitialize${group}Tags`], 'function', group);
  }
  for (const name of ['initializePeopleTags', 'initializeUserReviewTags', 'initializeTagStyles', 'appendUserRatingToContainer', 'invalidateUserReviewTagCache',
    'isRatingTagExcludedByScope', 'selectedMediaSource', 'getStatusDateContext']) assert.equal(typeof JE[name], 'function', name);
});

test('repeated initialization does not stack page listeners', t => {
  const h = runtime(t, { currentSettings: { qualityTagsPreferredAudioLanguage: 'none', statusTagsEnabled: true, logoTagsEnabled: true } });
  const counts = new Map();
  for (const [name, target] of [['document', h.document], ['window', h.window]]) {
    const add = target.addEventListener.bind(target);
    target.addEventListener = (type, ...rest) => { counts.set(`${name}:${type}`, (counts.get(`${name}:${type}`) || 0) + 1); return add(type, ...rest); };
  }
  for (let i = 0; i < 3; i++) {
    h.JE.initializeQualityTags();
    h.JE.initializeStatusTags();
    h.JE.initializeLogoTags();
    h.JE.initializeTagStyles();
  }
  for (const [name, expected] of [['document:change', 1], ['document:viewshow', 1], ['document:visibilitychange', 1], ['document:je:user-data-loaded', 1], ['document:error', 1], ['window:focus', 1], ['window:pagehide', 1], ['window:pageshow', 1]]) {
    assert.equal(counts.get(name), expected, name);
  }
});

test('a settings document with a hostile group name stays a plain document', t => {
  const { JE } = runtime(t);
  const settings = { tagGroupScopes: JSON.parse('{"__proto__":{"movies":false},"Quality":{"Movies":false}}') };
  JE.core.tagScopes.setOwn('genre', 'series', false, settings);
  assert.deepEqual(Object.keys(settings.tagGroupScopes).sort(), ['__proto__', 'genre', 'quality']);
  assert.equal(settings.tagGroupScopes.genre.series, false);
  assert.equal({}.movies, undefined);
  assert.equal(Object.getPrototypeOf(Object.getPrototypeOf(settings.tagGroupScopes)), null, 'its prototype is still Object.prototype');
});

test('where-to-show keeps personal over administrator, for every casing a stored document used', t => {
  const { JE } = runtime(t, { pluginConfig: { TagCacheServerMode: true, TagGroupScopes: { Quality: { Movies: false } }, RatingTagsOnEpisodes: false } });
  const scopes = JE.core.tagScopes;
  assert.equal(scopes.allows('quality', 'movies', {}), false, 'the administrator decides an unset switch');
  assert.equal(scopes.allows('quality', 'movies', { tagGroupScopes: { quality: { movies: true } } }), true, 'the user wins');
  assert.equal(scopes.allows('quality', 'movies', { TagGroupScopes: { Quality: { Movies: true } } }), true, 'a PascalCase document still counts');
  assert.equal(scopes.allows('rating', 'episodes', {}), false);
  assert.equal(scopes.allows('rating', 'movies', { ratingTagsOnMovies: false }), false, "an older document's off is kept");
  assert.equal(scopes.allows('agerating', 'movies', { tagGroupScopes: { ageRating: { movies: false } } }), false, 'the renderer alias');
  assert.equal(scopes.allows('people', 'movies', { tagGroupScopes: { people: { movies: false } } }), true, 'People Tags have no switch');
});

test('rating clears through its plain switch and the old off stops counting', t => {
  const { JE } = runtime(t);
  const settings = { ratingTagsOnMovies: false };
  JE.core.tagScopes.setOwn('rating', 'movies', null, settings);
  assert.equal(settings.ratingTagsOnMovies, true);
  assert.equal(JE.core.tagScopes.scopeOwn('rating', 'movies', settings), null);
  assert.equal(settings.tagGroupScopes, null);
});

test('the settings matrix answers per surface', t => {
  const { JE } = runtime(t);
  const matrix = JE.core.tagSettingsMatrix;
  assert.equal(matrix.offers('hub', 'quality', 'limit'), true);
  assert.equal(matrix.offers('itemEditor', 'quality', 'scopes'), 'tag_item_editor_scope_note');
  assert.equal(matrix.offers('admin', 'people', 'position'), 'tag_scope_people_na');
  assert.equal(matrix.offers('hub', 'status', 'limit'), 'tag_limit_single');
});
