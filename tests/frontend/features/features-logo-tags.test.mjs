import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain } from '../helpers/harness.mjs';

/**
 * The real Logos renderer (tags/logotags.js) over the real layout controller,
 * with the pipeline replaced by a registry so a test can hand it a server
 * cache entry or a batch item directly.
 */
function setup(t, settings = {}, plugin = {}) {
  const renderers = new Map();
  const h = createHarness({ html: '<div class="card" data-type="Movie"><div class="cardBox"><div class="cardScalable"><div class="cardImageContainer"></div><div class="je-tag-host"></div></div><div class="cardText">Title</div></div></div>',
    JE: { currentSettings: { logoTagsEnabled: true, ...settings }, pluginConfig: plugin, t: key => key,
      tagPipeline: { tagStripRevision: () => 'none', registerRenderer: (id, renderer) => renderers.set(id, renderer), getRenderer: id => renderers.get(id), clearProcessed() {}, scheduleScan() {} } },
    apiClient: { getUrl: path => `http://jf/${path}` } });
  t.after(() => h.close());
  for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/tag-layout-styles.js', 'tags/logotags.js']) h.load(file);
  h.JE.initializeLogoTags();
  const host = h.document.querySelector('.je-tag-host');
  return { ...h, host, renderer: () => renderers.get('logos'),
    render(entry) { renderers.get('logos').renderFromServerCache(host, entry, 'item'); h.JE.core.tagLayout.flushFit?.(); },
    chips: () => [...host.querySelectorAll('.je-tag-slot:not([data-je-slot="hover"]) .je-logo-chip')] };
}

const netflix = { kind: 'provider', name: 'Netflix', logo: '/pbpMk2JmcoNnQwx5JGpXngfoWtp.jpg' };

test('a provider logo is a proxied image on its pill with the name as alt and title, never a TMDB URL', t => {
  const h = setup(t);
  h.render({ Type: 'Movie', Logos: [netflix] });
  const [chip] = h.chips();
  assert.ok(chip, 'the chip is placed');
  assert.equal(chip.dataset.jeLogoKind, 'provider');
  assert.equal(chip.dataset.jeLogoStyle, 'provider');
  assert.equal(chip.title, 'Netflix');
  const img = chip.querySelector('img.je-logo-img');
  assert.equal(img.alt, 'Netflix');
  assert.equal(img.getAttribute('src'), 'http://jf/JellyfinEnhanced/logo/w92/pbpMk2JmcoNnQwx5JGpXngfoWtp.jpg');
  assert.doesNotMatch(h.host.innerHTML, /tmdb\.org/);
  assert.equal(chip.closest('.je-tag-slot').dataset.jeSlot, 'bl', 'the default corner is bottom left');
});

test('networks and studios sit on the light pill; names without a servable logo are text chips, long ones initials', t => {
  const h = setup(t);
  h.render({ Type: 'Series', Logos: [{ kind: 'network', name: 'Northwind', logo: '/nw.png' }, { kind: 'studio', name: 'Home Box Office' }] });
  const [image, text] = h.chips();
  assert.equal(image.dataset.jeLogoStyle, 'company');
  assert.equal(text.dataset.jeLogoStyle, 'text');
  assert.equal(text.textContent, 'HBO');
  assert.equal(text.title, 'Home Box Office');
  assert.equal(text.querySelector('img'), null);
  const L = h.JE.logoTags;
  assert.equal(L.shortName('Supercalifragilistic'), 'Supercalifr…');
  assert.equal(L.shortName('Paramount+ Premium'), 'PP');
  assert.equal(L.logoUrl('../etc/passwd'), null);
  assert.equal(L.logoUrl('/x.svg'), null);
});

test('invalid entries are dropped, at most two logos are read, and the user cap applies after that', t => {
  const h = setup(t, { tagLayoutSettingsVersion: 1, tagGroupCaps: { logos: 1 } });
  const logos = [{ kind: 'channel', name: 'Nope' }, { kind: 'studio', name: '  ' }, netflix, { kind: 'studio', name: 'A24' }, { kind: 'studio', name: 'Third' }];
  assert.deepEqual(plain(h.JE.logoTags.readLogos(logos)).map(l => l.name), ['Netflix', 'A24']);
  h.render({ Type: 'Movie', Logos: logos });
  assert.deepEqual(h.chips().map(c => c.title), ['Netflix']);
});

test('an image that fails to load becomes the name chip, also in the copies the layout placed', t => {
  const h = setup(t);
  h.render({ Type: 'Movie', Logos: [{ kind: 'network', name: 'Home Box Office', logo: '/broken.png' }] });
  const img = h.chips()[0].querySelector('img');
  img.dispatchEvent(new h.window.Event('error'));
  assert.equal(h.chips()[0].textContent, 'HBO');
  assert.equal(h.chips()[0].dataset.jeLogoStyle, 'text');
  // Later cards with the same image start as name chips.
  h.JE.core.tagLayout.clearCard(h.host);
  h.render({ Type: 'Movie', Logos: [{ kind: 'network', name: 'Home Box Office', logo: '/broken.png' }] });
  assert.equal(h.chips()[0].querySelector('img'), null);
});

test('batch lookups render and remember the logos, and a cached empty answer is still a hit', t => {
  const h = setup(t);
  h.renderer().render(h.host, { Id: 'item', Type: 'Movie', Logos: [netflix] }, { stripRevision: 'none' });
  assert.equal(h.chips().length, 1);
  h.JE.core.tagLayout.clearCard(h.host);
  delete h.host.dataset.jeLogoTagged;
  assert.equal(h.renderer().renderFromCache(h.host, 'item'), true);
  h.renderer().render(h.host, { Id: 'empty', Type: 'Movie' }, { stripRevision: 'none' });
  assert.equal(h.renderer().renderFromCache(h.host, 'empty'), true);
  const other = h.document.createElement('div');
  other.className = 'je-tag-host';
  assert.equal(h.renderer().renderFromCache(other, 'unknown'), false);
});

test('the group is off by default and nothing is drawn or styled for users who have not turned it on', t => {
  const h = setup(t, { logoTagsEnabled: false });
  assert.equal(h.renderer().isEnabled(), false);
  const fresh = createHarness({ JE: {} });
  t.after(() => fresh.close());
  fresh.load('enhanced/config.js');
  const defaults = fresh.JE.loadSettings ? fresh.JE.loadSettings() : {};
  assert.equal(defaults.logoTagsEnabled ?? false, false);
});

test('the summary pill names the first logo, and the layout knows the group, its container and defaults', t => {
  const h = setup(t, { tagLayoutSettingsVersion: 1, tagLayout: 'summary', tagGroupOrder: ['logos'],
    tagLayouts: { summary: { groups: [{ group: 'logos', slot: 'pill' }] } } });
  h.render({ Type: 'Movie', Logos: [netflix] });
  assert.match(h.host.querySelector('.je-tag-pill')?.textContent || '', /Netflix/);
  const L = h.JE.core.tagLayout;
  assert.ok(L.GROUPS.includes('logos'));
  assert.equal(L.CONTAINER_CLASS.logos, 'logo-overlay-container');
  assert.equal(L.DEFAULT_CAPS.logos, 0);
  assert.equal(L.DEFAULT_ORDER.at(-2), 'logos');
  assert.equal(L.DEFAULT_PROFILES.bands.logos, 'top');
});

test('Tag Styles colour each kind of logo pill', t => {
  const h = setup(t);
  h.load('tags/tag-styles.js');
  const css = h.JE.tagStyles.buildCss({ logos: { company: { background: 'rgba(1, 2, 3, 1)', color: null, border: null }, text: { color: 'rgba(9, 9, 9, 1)' } } });
  assert.match(css.replaceAll(':where(:not([data-je-tag-styles-scope] *))', ''), /\.logo-overlay-container \.je-logo-chip\[data-je-logo-style="company"\] \{ background-color: rgba\(1, 2, 3, 1\) !important;/);
  assert.match(css.replaceAll(':where(:not([data-je-tag-styles-scope] *))', ''), /\[data-je-logo-style="text"\] \{ color: rgba\(9, 9, 9, 1\) !important;/);
  assert.doesNotMatch(css, /data-je-logo-style="provider"/);
});

/**
 * Batch mode (server tag cache off) with the real Spoiler Guard state, tag
 * pipeline, renderer base and Logos renderer: the server strips Logos from a
 * guarded movie's batch item, as SpoilerTagDataStripper does.
 */
async function guardedBatch(t, { stored, guarded = false } = {}) {
  const idle = [], timers = new Map(), guard = { movies: new Set(guarded ? ['aabb'] : []) };
  let seq = 0, batches = 0;
  const h = createHarness({
    html: '<div class="card" data-id="AA-BB" data-type="Movie"><div class="cardScalable"><div class="cardImageContainer"></div><div class="cardOverlayContainer"></div></div></div>',
    globals: { requestIdleCallback: fn => idle.push(fn), setTimeout: (fn, ms) => { timers.set(++seq, { fn, ms }); return seq; }, clearTimeout: id => timers.delete(id) },
    apiClient: { ajax: async ({ url }) => {
      if (!url.includes('/tag-data/')) return {};
      batches++;
      return { StripRevision: guard.movies.has('aabb') ? 'g2:guarded' : 'none', Items: [{ Id: 'aabb', Type: 'Movie', Logos: guard.movies.has('aabb') ? null : [netflix] }] };
    } },
    JE: {
      pluginConfig: { TagCacheServerMode: false, SpoilerBlurEnabled: true, SpoilerStripTags: true },
      currentSettings: { logoTagsEnabled: true }, t: key => key,
      helpers: { onBodyMutation() {}, onNavigate() {}, addCSS() {} },
      session: { getUserId: () => 'user-a', getServerId: () => 'server-a', getEpoch: () => 0, isCurrent: () => true, onUserChange() {} },
      core: { api: { plugin: async (path, options) => {
        if (path === '/spoiler-blur/series') return { Movies: Object.fromEntries([...guard.movies].map(id => [id, {}])), Prefs: {} };
        const movie = path.match(/^\/spoiler-blur\/movies\/(\w+)$/)?.[1];
        if (movie && options?.method === 'POST') guard.movies.add(movie);
        if (movie && options?.method === 'DELETE') guard.movies.delete(movie);
        return {};
      } } },
    },
  });
  t.after(() => h.close());
  if (stored) {
    h.window.localStorage.setItem('JellyfinEnhanced-logoTagsCache', JSON.stringify({ aabb: stored }));
    h.window.localStorage.setItem('JellyfinEnhanced-logoTagsCache:identity-owner', 'server-a:user-a');
  }
  h.load('enhanced/spoilerguard/ids.js');
  h.load('enhanced/spoilerguard/state.js');
  Object.assign(h.JE.internals.spoilerGuard, { setIdentityCookie() {}, injectStyles() {}, installWatchedRefresh() {} });
  h.load('enhanced/spoilerguard/index.js');
  await h.JE.spoilerBlur.whenLoaded();
  for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/tag-layout-styles.js', 'tags/tag-pipeline.js', 'tags/logotags.js']) h.load(file);
  h.JE.tagPipeline.initialize();
  h.JE.initializeLogoTags();
  const flush = async () => {
    for (let n = 0; n < 5; n++) {
      while (idle.length) idle.shift()({ timeRemaining: () => 50 });
      for (const [id, timer] of [...timers]) if (timer.ms === 150) { timers.delete(id); timer.fn(); }
      await new Promise(resolve => setImmediate(resolve));
    }
  };
  /** What the detail page's Spoiler Guard button does after the server accepted the change. */
  const toggle = async enable => {
    await (enable ? h.JE.spoilerBlur.enableForMovie('aabb', 'Antz') : h.JE.spoilerBlur.disableForMovie('aabb'));
    await h.JE.tagPipeline.invalidateServerCache();
    await flush();
  };
  return { h, flush, toggle, batches: () => batches, chips: () => h.document.querySelectorAll('.je-logo-chip').length,
    remembered: () => h.JE._hotCache.logos.get('aabb') };
}

test('guarding a movie hides its cached logo at once, and unguarding brings it back from the next lookup', async t => {
  const g = await guardedBatch(t);
  await g.flush();
  assert.equal(g.batches(), 1);
  assert.equal(g.chips(), 1, 'the logo shows and is remembered');

  await g.toggle(true);
  assert.equal(g.chips(), 0, 'the remembered logo is not drawn under the new guard');
  assert.equal(g.batches(), 2, 'the server is asked again and strips it');

  await g.toggle(false);
  assert.equal(g.chips(), 1, 'the logo returns once the guard is gone');
  assert.equal(g.batches(), 3);

  // Same policy: the remembered answer is used again without a lookup.
  g.h.JE.tagPipeline.clearProcessed();
  g.h.JE.tagPipeline.scheduleScan();
  await g.flush();
  assert.equal(g.chips(), 1);
  assert.equal(g.batches(), 3);
});

for (const [label, stored] of [['from before stamping', { l: [netflix] }], ['stamped before the guard', { l: [netflix], g: 'off' }]]) {
  test(`a persisted logo ${label} is not drawn for a movie guarded since`, async t => {
    const g = await guardedBatch(t, { stored, guarded: true });
    await g.flush();
    assert.equal(g.chips(), 0);
    assert.equal(g.batches(), 1, 'the copy is a miss: the server decides');
    assert.deepEqual(plain(g.remembered().payload.l), [], 'the stripped answer replaces it');
    assert.match(g.remembered().stripRevision, /^g2:/);
  });
}

test('the fallback cache uses entries stamped under the current guard policy only, and asks again while it is unknown', t => {
  let revision = 'none';
  const h = setup(t, {}, { SpoilerBlurEnabled: true });
  h.JE.tagPipeline.tagStripRevision = () => revision;
  h.renderer().render(h.host, { Id: 'item', Type: 'Movie', Logos: [netflix] }, { stripRevision: 'none' });
  const again = () => {
    h.JE.core.tagLayout.clearCard(h.host);
    delete h.host.dataset.jeLogoTagged;
    return h.renderer().renderFromCache(h.host, 'item');
  };
  assert.equal(again(), true);
  revision = null;
  assert.equal(again(), false, 'state not loaded: a miss');
  revision = 'none';
  assert.equal(again(), true, 'an unknown policy keeps the entry');
  revision = 'g2:abc';
  assert.equal(again(), false, 'another policy: a miss');
  revision = 'none';
  assert.equal(again(), false, 'and the entry is gone');
  h.JE.pluginConfig.SpoilerBlurEnabled = false;
  h.JE.spoilerBlur = undefined;
  h.renderer().render(h.host, { Id: 'item', Type: 'Movie', Logos: [netflix] }, { stripRevision: 'none' });
  assert.equal(again(), true, 'the authoritative unstripped answer can be reused');
});
