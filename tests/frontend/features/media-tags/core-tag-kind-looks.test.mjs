import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness } from '../../helpers/harness.mjs';
import { repositoryRoot } from '../../helpers/discovery.mjs';

// Per-tag-kind opacity and size (Media Tags request: "let me set the transparency and the size of each tag
// independently"). A kind is a quality category (resolution, HDR, sound, edition, source, …) or one of the other
// card tag groups (status, rating, age rating, language, genre, awards, logos, custom). Each kind has an opacity
// and a size in percent of today's look; 100/100 is today's look. The administrator sets defaults
// (TagKindLooks), a user's own value (tagKindLooks) wins per kind and per value.

const ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const card = (id = ID) => `<div class="card overflowPortraitCard" data-id="${id}" data-type="Movie"><div class="cardBox"><div class="cardScalable"><div class="cardImageContainer coveredImage cardContent"></div><div class="je-tag-host"></div><div class="cardOverlayContainer"></div></div><div class="cardText cardText-first">Title</div></div></div>`;

/** A tag-cache entry with quality (4K, HEVC, Atmos), ratings, an age rating and a language. */
const entry = () => ({
  Type: 'Movie', TmdbId: '42', Genres: ['Drama'], CommunityRating: 8.12, CriticRating: 91, OfficialRating: 'PG-13', AudioLanguages: ['en'],
  StreamData: {
    Streams: [{ Type: 'Video', Codec: 'hevc', Height: 2160, DisplayTitle: '4K HEVC' }, { Type: 'Audio', Codec: 'truehd', Profile: 'Dolby TrueHD + Dolby Atmos', Channels: 8, ChannelLayout: '7.1', DisplayTitle: 'TrueHD Atmos 7.1' }],
    Sources: [{ Path: 'Movie (2020).mkv', Name: 'Movie (2020)' }], ItemName: 'Movie', ItemPath: 'Movie (2020).mkv',
  },
});

/** The real renderers and layout controller over one card. */
function setup(t, { settings = {}, plugin = {} } = {}) {
  const renderers = new Map();
  const h = createHarness({
    html: card(),
    JE: {
      currentSettings: { qualityTagsEnabled: true, ratingTagsEnabled: true, ageRatingTagsEnabled: true, qualityTagsPreferredAudioLanguage: 'none', ...settings },
      pluginConfig: { TagCacheServerMode: true, ...plugin },
      t: key => key,
      cdn: { flagSvg: code => `http://jellyfin.test/flags/${code}.svg` },
      session: { getUserId: () => 'a', getServerId: () => 's', getEpoch: () => 0, isCurrent: () => true, onUserChange() {} },
      _cacheManager: { register() {}, markDirty() {} },
      tagPipeline: {
        registerRenderer: (name, r) => renderers.set(name, r), getRenderer: name => renderers.get(name), clearProcessed() {}, scheduleScan() {},
        peekReviewRatings: () => null, getReviewRatingsRequestedAt: () => 1, getReviewRatings: async () => null, onReviewRatingsChanged() {},
      },
    },
  });
  t.after(() => h.close());
  for (const file of ['core/ui-kit.js', 'core/media-language.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/tag-layout-styles.js',
    'tags/rating-sources.js', 'tags/qualitytags.js', 'tags/ratingtags.js', 'tags/ageratingtags.js']) h.load(file);
  const JE = h.JE;
  JE.initializeQualityTags(); JE.initializeRatingTags(); JE.initializeAgeRatingTags();
  const host = () => h.document.querySelector('.je-tag-host');
  return Object.assign(h, {
    JE, layout: JE.core.tagLayout, host,
    render() { for (const [, r] of renderers) if (r.isEnabled() && r.renderFromServerCache) r.renderFromServerCache(host(), entry(), ID); },
    async apply(changes) { Object.assign(JE.currentSettings, changes); await JE.reinitializeTagLayout(); },
    sheet: () => h.document.getElementById('je-tag-kind-looks')?.textContent || '',
  });
}

/** The quality category keys, read from the quality module's own table (not from the code under test). */
function qualityCategoryKeys() {
  const source = readFileSync(resolve(repositoryRoot, 'client/src/features/media-tags/types/quality/quality-data.ts'), 'utf8');
  const table = /export const CATEGORIES[^=]*=\s*\[([\s\S]*?)\n\];/.exec(source);
  assert.ok(table, 'quality-data.ts declares CATEGORIES');
  return [...table[1].matchAll(/\{\s*key:\s*'(\w+)'/g)].map(m => m[1]);
}

/** A value from the page's realm as plain data (deep equality compares prototypes). */
const data = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/** One kind's rule in the stylesheet (the declarations), or null. */
function ruleFor(css, selectorPart) {
  const rule = css.split('\n').find(line => line.includes(selectorPart) && line.includes('{'));
  return rule ? rule.slice(rule.indexOf('{') + 1, rule.lastIndexOf('}')).trim() : null;
}

test('every tag kind is covered by construction: each quality category and every other card tag group', t => {
  const h = setup(t);
  const kinds = h.layout.TAG_KINDS.map(k => k.id);
  const expected = [...qualityCategoryKeys(), ...h.layout.DEFAULT_ORDER.filter(g => g !== 'quality')];
  assert.deepEqual([...kinds].sort(), [...expected].sort());
  assert.equal(new Set(kinds).size, kinds.length, 'kind ids are unique');
  for (const kind of h.layout.TAG_KINDS) {
    assert.ok(h.layout.DEFAULT_ORDER.includes(kind.group), `${kind.id} belongs to a layout group`);
    if (kind.group !== 'quality') assert.equal(kind.id, kind.group);
  }
  // Every kind gets both controls: the stylesheet has a rule for each one set away from the default.
  const all = h.layout.TAG_KINDS.map(k => ({ kind: k.id, opacity: 50, scale: 150 }));
  const conf = h.layout.normalizeSettings({ tagLayoutSettingsVersion: 1, tagKindLooks: all }, {});
  assert.equal(Object.keys(conf.kindLooks).length, kinds.length);
  const css = h.layout.kindLooksCss(conf.kindLooks, '7');
  for (const kind of h.layout.TAG_KINDS) {
    const part = kind.group === 'quality' ? `[data-je-tag-kind="${kind.id}"]` : `[data-je-group="${kind.group}"] > *`;
    assert.equal(ruleFor(css, part), 'filter: opacity(0.5); --je-tag-scale: calc(var(--je-tag-base-scale, 1) * 1.5);', kind.id);
  }
});

test('defaults reproduce today\'s output: no marker, no stylesheet, the same chips', async t => {
  const plain = setup(t, { settings: { tagLayoutSettingsVersion: 1 } });
  plain.render();
  const before = plain.host().outerHTML;
  assert.ok(plain.host().querySelector('.quality-overlay-label'), 'quality chips drawn');
  assert.equal(plain.host().hasAttribute('data-je-kind-looks'), false);
  assert.equal(plain.sheet(), '');

  // Every kind explicitly at 100% opacity and 100% size draws exactly the same card.
  const explicit = setup(t, { settings: { tagLayoutSettingsVersion: 1, tagKindLooks: plain.layout.TAG_KINDS.map(k => ({ kind: k.id, opacity: 100, scale: 100 })) } });
  explicit.render();
  assert.equal(explicit.host().outerHTML, before);
  assert.equal(explicit.sheet(), '');
  assert.equal(explicit.layout.normalizeSettings().lookKey, plain.layout.normalizeSettings().lookKey);

  // A document saved before layouts keeps its look whatever the administrator set.
  const legacy = setup(t, { plugin: { TagKindLooks: [{ Kind: 'resolution', Opacity: 40, Scale: 180 }] } });
  legacy.render();
  assert.equal(legacy.host().hasAttribute('data-je-kind-looks'), false);
  assert.deepEqual(data(legacy.layout.normalizeSettings().kindLooks), {});
});

test('one kind\'s values never change another kind: independent rules per kind and per value', async t => {
  const h = setup(t, { settings: { tagLayoutSettingsVersion: 1 } });
  h.render();
  await h.apply({ tagKindLooks: [{ kind: 'resolution', scale: 150 }, { kind: 'language', opacity: 50, scale: 80 }] });
  const css = h.sheet();
  const id = h.host().dataset.jeKindLooks;
  assert.match(id, /^\d+$/);
  assert.equal(ruleFor(css, `[data-je-kind-looks="${id}"] > .je-tag-slot > [data-je-group="quality"] > [data-je-tag-kind="resolution"]`),
    '--je-tag-scale: calc(var(--je-tag-base-scale, 1) * 1.5);');
  assert.equal(ruleFor(css, `[data-je-kind-looks="${id}"] > .je-tag-slot > [data-je-group="language"] > *`),
    'filter: opacity(0.5); --je-tag-scale: calc(var(--je-tag-base-scale, 1) * 0.8);');
  for (const other of ['videoCodec', 'audio', 'dynamicRange', 'edition', 'source']) assert.equal(ruleFor(css, `[data-je-tag-kind="${other}"]`), null, other);
  for (const other of ['rating', 'ageRating', 'genre', 'status', 'awards', 'logos', 'custom']) assert.equal(ruleFor(css, `[data-je-group="${other}"] > *`), null, other);

  // Changing genre leaves the resolution and language rules exactly as they were.
  const resolutionRule = ruleFor(css, '[data-je-tag-kind="resolution"]');
  await h.apply({ tagKindLooks: [{ kind: 'resolution', scale: 150 }, { kind: 'language', opacity: 50, scale: 80 }, { kind: 'genre', opacity: 30 }] });
  const next = h.sheet();
  const nextId = h.host().dataset.jeKindLooks;
  assert.notEqual(nextId, id);
  assert.equal(ruleFor(next, `[data-je-kind-looks="${nextId}"] > .je-tag-slot > [data-je-group="quality"] > [data-je-tag-kind="resolution"]`), resolutionRule);
  assert.equal(ruleFor(next, `[data-je-kind-looks="${nextId}"] > .je-tag-slot > [data-je-group="genre"] > *`), 'filter: opacity(0.3);');
  // Opacity alone leaves the size alone, and the other way round.
  const conf = h.layout.normalizeSettings();
  assert.deepEqual(data(conf.kindLooks.resolution), { opacity: 100, scale: 150 });
  assert.deepEqual(data(conf.kindLooks.genre), { opacity: 30, scale: 100 });
  assert.equal(conf.kindLooks.videoCodec, undefined);
});

test('quality chips carry their category as their kind, so each category is styled on its own', t => {
  const h = setup(t, { settings: { tagLayoutSettingsVersion: 1 } });
  h.render();
  const kinds = new Map([...h.host().querySelectorAll('.quality-overlay-label')].map(chip => [chip.dataset.quality, chip.dataset.jeTagKind]));
  assert.equal(kinds.get('4K'), 'resolution');
  assert.equal(kinds.get('HEVC'), 'videoCodec');
  assert.ok([...kinds.values()].includes('audio'), `a sound chip is drawn: ${JSON.stringify([...kinds])}`);
});

test('values are numbers clamped to their range; anything else is ignored and never reaches the stylesheet', t => {
  const h = setup(t);
  const { opacity, scale } = h.layout.KIND_LOOK_LIMITS;
  assert.deepEqual(data(opacity), { min: 10, max: 100, step: 5, fallback: 100 });
  assert.deepEqual(data(scale), { min: 50, max: 200, step: 5, fallback: 100 });
  const read = h.layout.readKindLooks([
    { kind: 'resolution', opacity: 0, scale: 900 },
    { Kind: 'genre', Opacity: 250, Scale: 10 },
    { kind: 'rating', opacity: 55.4, scale: '150' },
    { kind: 'language', opacity: Number.NaN, scale: Infinity },
    { kind: 'status', opacity: null, scale: 120 },
    { kind: 'resolution', opacity: 70 },
    { kind: 'x"] { color: red } [y', opacity: 50 },
    { kind: 'constructor', opacity: 50 },
    { kind: '__proto__', scale: 150 },
    'genre', null, 42,
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(read)), {
    resolution: { opacity: 10, scale: 200 },
    genre: { opacity: 100, scale: 50 },
    rating: { opacity: 55 },
    status: { scale: 120 },
  });
  assert.deepEqual(data(h.layout.readKindLooks('resolution')), {});
  assert.deepEqual(data(h.layout.readKindLooks({ resolution: { opacity: 50 } })), {});
  const conf = h.layout.normalizeSettings({ tagLayoutSettingsVersion: 1, tagKindLooks: [{ kind: 'x"] { color: red } [y', opacity: 50 }, { kind: 'genre', opacity: 1e9, scale: 1e9 }] }, {});
  const css = h.layout.kindLooksCss(conf.kindLooks, '1');
  assert.equal(ruleFor(css, '[data-je-group="genre"] > *'), '--je-tag-scale: calc(var(--je-tag-base-scale, 1) * 2);');
  assert.doesNotMatch(css, /color: red|1e9|1000000000/);
  assert.match(css, /^[\w\s.:#>*()\[\]="',;{}-]+$/, 'only selectors of known kinds and numbers');
  // The ids the layout hands out are plain numbers; a hand-made id is refused.
  assert.throws(() => h.layout.kindLooksCss(conf.kindLooks, '1"] *'), /id/);
});

test('the administrator\'s values are defaults; a user\'s own value wins per kind and per value', t => {
  const h = setup(t);
  const admin = { TagKindLooks: [{ Kind: 'resolution', Opacity: 60, Scale: 150 }, { Kind: 'genre', Scale: 120 }] };
  const looks = settings => data(h.layout.normalizeSettings({ tagLayoutSettingsVersion: 1, ...settings }, admin).kindLooks);
  assert.deepEqual(looks({}), { resolution: { opacity: 60, scale: 150 }, genre: { opacity: 100, scale: 120 } });
  // Own opacity, the administrator's size.
  assert.deepEqual(looks({ tagKindLooks: [{ kind: 'resolution', opacity: 90 }] }).resolution, { opacity: 90, scale: 150 });
  // An explicit 100 is the user's choice, not "follow the administrator".
  assert.deepEqual(looks({ tagKindLooks: [{ kind: 'resolution', opacity: 100, scale: 100 }] }).resolution, undefined);
  // A user's value for one kind leaves the administrator's other kinds in place.
  assert.deepEqual(looks({ tagKindLooks: [{ kind: 'audio', opacity: 40 }] }), {
    resolution: { opacity: 60, scale: 150 }, genre: { opacity: 100, scale: 120 }, audio: { opacity: 40, scale: 100 },
  });
  // Round trip through the wire form the settings save.
  const wire = h.layout.kindLooksToWire({ audio: { opacity: 40 }, resolution: { scale: 150 }, genre: {} });
  assert.deepEqual(JSON.parse(JSON.stringify(wire)), [{ kind: 'resolution', scale: 150 }, { kind: 'audio', opacity: 40 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(h.layout.readKindLooks(wire))), { resolution: { scale: 150 }, audio: { opacity: 40 } });
});

test('promoting a legacy document keeps its look: the administrator\'s kinds are pinned at 100%', t => {
  const admin = { TagKindLooks: [{ Kind: 'resolution', Opacity: 60 }, { Kind: 'genre', Scale: 130 }] };
  const h = setup(t, { plugin: admin });
  const doc = {};
  // Like the size and edge spacing: promotion by another control does not opt the user into the administrator's looks.
  h.layout.promoteLegacySettings(doc);
  assert.deepEqual(JSON.parse(JSON.stringify(doc.tagKindLooks)), [{ kind: 'resolution', opacity: 100, scale: 100 }, { kind: 'genre', opacity: 100, scale: 100 }]);
  assert.deepEqual(data(h.layout.normalizeSettings(doc, admin).kindLooks), {});
  // A document's own values are kept; only the administrator's other kinds are pinned.
  const own = { tagKindLooks: [{ kind: 'audio', opacity: 50 }, { kind: 'genre', scale: 80 }] };
  h.layout.promoteLegacySettings(own);
  assert.deepEqual(JSON.parse(JSON.stringify(own.tagKindLooks)), [{ kind: 'audio', opacity: 50 }, { kind: 'genre', scale: 80 }, { kind: 'resolution', opacity: 100, scale: 100 }]);
  // Nothing set by the administrator: nothing pinned.
  const plain = setup(t);
  const bare = {};
  plain.layout.promoteLegacySettings(bare);
  assert.equal(bare.tagKindLooks ?? null, null);
});
