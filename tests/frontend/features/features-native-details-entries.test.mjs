// Native details for titles that aren't in the library: the entry points that used to open the
// More Info modal go through the navigator (JE.titleDetails), and keep the modal when it isn't offered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness, jsRoot } from '../helpers/harness.mjs';

const wait = ms => new Promise(r => setTimeout(r, ms));

/**
 * A realm with a recording navigator and modal.
 * @param {object} t Test context.
 * @param {object} options Options.
 * @returns {object} Harness and probes.
 */
function realm(t, { native = true, html = '', JE = {} } = {}) {
  const shown = [], modal = [];
  const h = createHarness({
    html,
    JE: {
      t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
      escapeHtml: text => String(text).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`),
      pluginConfig: {},
      jellyseerrMoreInfo: { open: (...args) => modal.push(args) },
      titleDetails: {
        available: () => native,
        show: (id, type, scope) => { if (native) shown.push([Number(id), type, scope || null]); else modal.push([Number(id), type]); return true; },
        open: (id, type) => { if (!native) return false; shown.push([Number(id), type, null]); return true; },
      },
      ...JE,
    },
  });
  t.after(() => h.close());
  return { ...h, shown, modal };
}

for (const native of [true, false]) {
  test(`Home Screen Sections discover cards: ${native ? 'the native page' : 'the modal'}; the request button is left alone`, t => {
    const h = realm(t, { native, html: '<div class="discover-card" data-tmdb-id="83867" data-media-type="tv"><span class="title">Andor</span><button class="discover-requestbutton">Request</button></div>' });
    h.load('jellyseerr/hss-discovery-handler.js');
    const click = el => { const e = new h.window.MouseEvent('click', { bubbles: true, cancelable: true }); el.dispatchEvent(e); return e.defaultPrevented; };
    assert.equal(click(h.document.querySelector('.title')), true);
    assert.equal(click(h.document.querySelector('.discover-requestbutton')), false);
    if (native) assert.deepEqual(h.shown, [[83867, 'tv', null]]);
    else assert.deepEqual(h.modal, [[83867, 'tv']]);
  });
}

test('Home Screen Sections without JE\'s modal or native details keep their own link', t => {
  const h = realm(t, { native: false, JE: { jellyseerrMoreInfo: undefined } });
  h.document.body.innerHTML = '<a class="discover-card" data-tmdb-id="1" data-media-type="movie" href="#x">x</a>';
  h.load('jellyseerr/hss-discovery-handler.js');
  const e = new h.window.MouseEvent('click', { bubbles: true, cancelable: true });
  h.document.querySelector('a').dispatchEvent(e);
  assert.equal(e.defaultPrevented, false);
});

test('Hidden Content: a hidden title with no Jellyfin page opens through the navigator', t => {
  const stub = () => '';
  const h = realm(t, { JE: { internals: { hiddenContentPage: { scopeBadgeText: stub, scopeUnhideText: () => 'Unhide', showUnhideConfirmation: stub, formatHiddenDate: stub, POSTER_MAX_WIDTH: 300 } } } });
  h.load('enhanced/hiddencontent/hidden-content-page-cards.js');
  const card = h.JE.internals.hiddenContentPage.createGroupCard({ seriesId: null, seriesName: 'Andor', items: [{ type: 'Series', tmdbId: '83867', name: 'Andor', itemId: 'x' }] });
  h.document.body.appendChild(card);
  card.querySelector('.je-hidden-group-poster-link').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.deepEqual(h.shown, [[83867, 'tv', null]]);
  assert.deepEqual(h.modal, []);
});

test('the legacy Requests page links a title without a copy to its native page only when it is offered', t => {
  for (const native of [true, false]) {
    const h = realm(t, { native, JE: { cdn: { selfhst: p => `https://cdn.test/${p}` }, internals: { requestsPage: { state: {} } } } });
    h.load('arr/requests/requests-page-render-helpers.js');
    h.load('arr/requests/requests-page-render-cards.js');
    const html = h.JE.internals.requestsPage.renderRequestCard({ id: 1, type: 'movie', title: 'Dune', tmdbId: 693134, mediaStatus: 'Pending', requestedBy: 'x' });
    h.document.body.innerHTML = html;
    const title = h.document.querySelector('.je-request-title');
    assert.equal(title.classList.contains('je-request-title-link'), native);
    assert.equal(title.getAttribute('data-tmdb-id'), native ? '693134' : null);
  }
});

test('nothing here reaches the network while loading', async t => {
  const h = realm(t);
  h.load('jellyseerr/hss-discovery-handler.js');
  h.load('enhanced/hiddencontent/hidden-content-page-cards.js');
  await wait(20);
});

test('the navigator loads before every module that asks it about an id (a cold deep link runs some of them at load time)', () => {
  const order = JSON.parse(readFileSync(resolve(jsRoot, 'component-scripts.json'), 'utf8')).filter(e => !e.startsWith('//'));
  const at = order.indexOf('jellyseerr/nativedetails/native-details.js');
  assert.ok(at >= 0);
  for (const name of ['core/navigation.js', 'core/session.js', 'core/lifecycle.js']) assert.ok(order.indexOf(name) < at, `${name} loads first`);
  const readers = order.filter(f => f !== 'jellyseerr/nativedetails/native-details.js' && /JE\.titleDetails/.test(readFileSync(resolve(jsRoot, f), 'utf8')));
  assert.ok(readers.includes('jellyseerr/item-details.js') && readers.includes('jellyseerr/seerr-detail-link.js'));
  for (const f of readers) assert.ok(order.indexOf(f) > at, `${f} loads after native-details.js`);
});
