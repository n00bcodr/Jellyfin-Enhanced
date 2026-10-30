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
      tagPipeline: { registerRenderer: (id, renderer) => renderers.set(id, renderer), getRenderer: id => renderers.get(id), clearProcessed() {}, scheduleScan() {} } },
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
  h.renderer().render(h.host, { Id: 'item', Type: 'Movie', Logos: [netflix] }, {});
  assert.equal(h.chips().length, 1);
  h.JE.core.tagLayout.clearCard(h.host);
  delete h.host.dataset.jeLogoTagged;
  assert.equal(h.renderer().renderFromCache(h.host, 'item'), true);
  h.renderer().render(h.host, { Id: 'empty', Type: 'Movie' }, {});
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
  assert.equal(L.DEFAULT_ORDER.at(-1), 'logos');
  assert.equal(L.DEFAULT_PROFILES.bands.logos, 'top');
});

test('Tag Styles colour each kind of logo pill', t => {
  const h = setup(t);
  h.load('tags/tag-styles.js');
  const css = h.JE.tagStyles.buildCss({ logos: { company: { background: 'rgba(1, 2, 3, 1)', color: null, border: null }, text: { color: 'rgba(9, 9, 9, 1)' } } });
  assert.match(css, /\.logo-overlay-container \.je-logo-chip\[data-je-logo-style="company"\] \{ background-color: rgba\(1, 2, 3, 1\) !important;/);
  assert.match(css, /\[data-je-logo-style="text"\] \{ color: rgba\(9, 9, 9, 1\) !important;/);
  assert.doesNotMatch(css, /data-je-logo-style="provider"/);
});
