import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred } from '../helpers/harness.mjs';
import { sessionFixture } from '../helpers/seerr-details.mjs';

// seerr-detail-link.js and hss-discovery-handler.js: the two ways into the more-info modal
// from pages Jellyfin and other plugins render.
const links = (href = 'https://www.themoviedb.org/movie/603') => `<div class="itemExternalLinks"><a href="${href}">TMDB</a></div>`;
const view = (id, hidden, inner) => `<div id="itemDetailPage" data-view="${id}" class="${hidden ? 'hide' : ''}">${inner}</div>`;

function detailLink(t, { html = view('a', false, links()), config = {}, item = async () => ({ Type: 'Movie' }), base = 'https://home.test/seerr', tv = false, url = 'http://jellyfin.test/web/index.html#!/details?id=a', helpers = {} } = {}) {
  const { session, switchUser } = sessionFixture();
  let observed = null;
  const opened = [];
  const disconnects = [];
  const h = createHarness({ html, url, JE: {
    pluginConfig: { JellyseerrEnabled: true, JellyseerrShowDetailPageLink: true, ...config }, t: key => key, session,
    cdn: { selfhst: path => `/cdn/${path}` }, core: { ui: { isTvLayout: () => tv } },
    jellyseerrAPI: { resolveJellyseerrBaseUrl: () => base }, jellyseerrMoreInfo: { open: async (...args) => opened.push(args) },
    helpers: { getItemCached: item, getExternalLinkIconSize: () => 21, createObserver: (id, callback) => { observed = callback; return { disconnect: () => disconnects.push(id) }; }, ...helpers }
  } });
  t.after(() => h.close());
  h.load('jellyseerr/seerr-detail-link.js');
  return { ...h, opened, disconnects, switchUser, link: () => h.document.querySelector('.seerr-link'), init: () => h.JE.initializeSeerrDetailLinkScript(),
    async mutate() { observed(); await new Promise(resolve => setTimeout(resolve, 130)); for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); } };
}

test('with the modal off the link goes to the title on Seerr, keeping the base sub-path', async t => {
  const h = detailLink(t);
  h.init();
  await h.mutate();
  const link = h.link();
  assert.equal(link.getAttribute('href'), 'https://home.test/seerr/movie/603');
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.equal(link.querySelector('img').style.width, '21px');
  assert.equal(link.title, 'jellyseerr_card_view_on_jellyseerr');
  assert.equal(link.previousSibling.textContent, ' ');
});

test('with the modal on, or on a TV, the link opens the modal in place', async t => {
  for (const options of [{ config: { JellyseerrUseMoreInfoModal: true } }, { tv: true }]) {
    const h = detailLink(t, options);
    h.init();
    await h.mutate();
    assert.equal(h.link().getAttribute('href'), '#');
    h.link().click();
    assert.deepEqual([...h.opened[0]], ['603', 'movie']);
  }
});

test('a series links as TV, and the text form reads Seerr after a comma', async t => {
  const h = detailLink(t, { html: view('a', false, links('https://www.themoviedb.org/tv/1399')), item: async () => ({ Type: 'Series' }), config: { JellyseerrShowDetailPageLinkAsText: true } });
  h.init();
  await h.mutate();
  assert.equal(h.link().getAttribute('href'), 'https://home.test/seerr/tv/1399');
  assert.equal(h.link().textContent, 'Seerr');
  assert.equal(h.link().previousSibling.textContent, ', ');
});

test('no base and no modal: nothing to link to', async t => {
  const h = detailLink(t, { base: '' });
  h.init();
  await h.mutate();
  assert.equal(h.link(), null);
});

test('only movies and series with a TMDB link get one, once', async t => {
  const episode = detailLink(t, { item: async () => ({ Type: 'Episode' }) });
  episode.init();
  await episode.mutate();
  assert.equal(episode.link(), null);
  const noId = detailLink(t, { html: view('a', false, links('https://www.imdb.com/title/tt1')) });
  noId.init();
  await noId.mutate();
  assert.equal(noId.link(), null);
  const twice = detailLink(t);
  twice.init();
  await twice.mutate();
  await twice.mutate();
  assert.equal(twice.document.querySelectorAll('.seerr-link').length, 1);
});

test('a link on a hidden view leaves with its separator', async t => {
  const h = detailLink(t, { html: view('a', true, `<div class="itemExternalLinks"><a href="x">x</a> <a class="seerr-link">s</a></div>`) + view('b', false, links()) });
  h.init();
  await h.mutate();
  assert.equal(h.document.querySelector('[data-view="a"] .seerr-link'), null);
  assert.equal(h.document.querySelector('[data-view="a"] .itemExternalLinks').textContent, 'x');
  assert.ok(h.document.querySelector('[data-view="b"] .seerr-link'));
});

test('a lookup outlived by its page adds nothing there, and the page that replaced it still gets its link', async t => {
  const lookups = [deferred(), deferred()];
  let calls = 0;
  const h = detailLink(t, { html: view('a', false, links()) + view('b', true, links('https://www.themoviedb.org/movie/7')), item: () => lookups[calls++].promise });
  h.init();
  await h.mutate();
  h.document.querySelector('[data-view="a"]').classList.add('hide');
  h.document.querySelector('[data-view="b"]').classList.remove('hide');
  h.window.history.pushState(null, '', '#!/details?id=b');
  // The new page's last mutation lands while the old lookup still holds the lock.
  await h.mutate();
  lookups[0].resolve({ Type: 'Movie' });
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
  lookups[1].resolve({ Type: 'Movie' });
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.document.querySelector('[data-view="a"] .seerr-link'), null);
  assert.equal(h.document.querySelector('[data-view="b"] .seerr-link').getAttribute('href'), 'https://home.test/seerr/movie/7');
});

test('a lookup that ends after an account change adds nothing', async t => {
  const lookup = deferred();
  const h = detailLink(t, { item: () => lookup.promise });
  h.init();
  await h.mutate();
  h.switchUser();
  lookup.resolve({ Type: 'Movie' });
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.link(), null);
});

test('turned off, it installs nothing; turned off later, it stops watching', async t => {
  const off = detailLink(t, { config: { JellyseerrShowDetailPageLink: false } });
  off.init();
  assert.equal(off.document.getElementById('seerr-detail-link-styles'), null);
  const h = detailLink(t);
  h.init();
  h.JE.pluginConfig.JellyseerrShowDetailPageLink = false;
  await h.mutate();
  assert.deepEqual(h.disconnects, ['seerr-detail-link']);
  assert.equal(h.link(), null);
});

function hss(t, { je = {}, html } = {}) {
  const opened = [];
  const h = createHarness({ html: html ?? '<div class="discover-card" data-tmdb-id="603" data-media-type="movie"><img class="poster"><button class="discover-requestbutton"><span class="inner"></span></button></div>',
    JE: { jellyseerrMoreInfo: { open: async (...args) => opened.push(args) }, ...je } });
  t.after(() => h.close());
  h.load('jellyseerr/hss-discovery-handler.js');
  return { ...h, opened };
}

test('a discover card opens the modal before anything else sees the click', t => {
  const h = hss(t);
  let reached = false;
  h.document.querySelector('.discover-card').addEventListener('click', () => { reached = true; });
  const click = new h.window.MouseEvent('click', { bubbles: true, cancelable: true });
  h.document.querySelector('.poster').dispatchEvent(click);
  assert.deepEqual([...h.opened[0]], ['603', 'movie']);
  assert.equal(click.defaultPrevented, true);
  assert.equal(reached, false);
});

test('the request button keeps its own click', t => {
  const h = hss(t);
  const click = new h.window.MouseEvent('click', { bubbles: true, cancelable: true });
  h.document.querySelector('.inner').dispatchEvent(click);
  assert.equal(h.opened.length, 0);
  assert.equal(click.defaultPrevented, false);
});

for (const [name, card] of [
  ['no id', '<div class="discover-card" data-media-type="movie"><i></i></div>'],
  ['no type', '<div class="discover-card" data-tmdb-id="1"><i></i></div>'],
  ['a type Seerr details do not have', '<div class="discover-card" data-tmdb-id="1" data-media-type="person"><i></i></div>'],
  ['an id that is not an id', '<div class="discover-card" data-tmdb-id="../admin" data-media-type="movie"><i></i></div>']
]) test(`a card with ${name} is left to its own link`, t => {
  const h = hss(t, { html: card });
  const click = new h.window.MouseEvent('click', { bubbles: true, cancelable: true });
  h.document.querySelector('i').dispatchEvent(click);
  assert.equal(h.opened.length, 0);
  assert.equal(click.defaultPrevented, false);
});

test('before the modal has loaded, a card keeps working as a link', t => {
  const h = hss(t, { je: { jellyseerrMoreInfo: undefined } });
  const click = new h.window.MouseEvent('click', { bubbles: true, cancelable: true });
  h.document.querySelector('.poster').dispatchEvent(click);
  assert.equal(click.defaultPrevented, false);
});
