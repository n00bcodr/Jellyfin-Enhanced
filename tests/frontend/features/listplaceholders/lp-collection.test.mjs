import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, ph, view, tick, COLLECTION } from './lp-harness.mjs';

const ITEM = { Id: COLLECTION, Name: 'Cars Collection', Type: 'BoxSet' };
const PAGE = '<div class="itemDetailPage page"><div class="detailSection"><div class="collectionItems"><div class="verticalSection"><div class="itemsContainer collectionItemsContainer"></div></div></div><div class="nextUpSection"></div></div></div>';

function fakeCard(document) {
  return (item) => {
    const card = document.createElement('div');
    card.className = 'card overflowPortraitCard jellyseerr-card';
    card.innerHTML = `<div class="cardBox"><div class="cardScalable"><div class="cardImageContainer"></div><div class="jellyseerr-overview"><button class="jellyseerr-request-button jellyseerr-button-tv" data-tmdb-id="${item.id}" data-media-type="${item.mediaType}"></button><div class="jellyseerr-4k-popup"><button class="jellyseerr-4k-popup-item" data-action="request4k"></button></div></div></div><div class="jellyseerr-meta"><bdi>y</bdi></div></div>`;
    card.__item = item;
    return card;
  };
}

async function mount(t, placeholders, extra = {}, { api = {}, userStatus } = {}) {
  const modals = [];
  const cardArgs = [];
  const requests = [];
  let current = view({ listId: COLLECTION, listKind: 'collection', order: null, placeholders, ...extra });
  let doc;
  const h = setup(t, {
    html: PAGE,
    plugin: async () => current,
    jellyseerrAPI: {
      ...(userStatus ? { checkUserStatus: userStatus } : {}),
      requestMedia: async (...args) => {
        requests.push(args);
        if (api.requestError) throw api.requestError;
        doc.dispatchEvent(new doc.defaultView.CustomEvent('jellyseerr-media-requested', { detail: { tmdbId: String(args[0]), mediaType: args[1] } }));
        return { id: 1 };
      }
    },
    jellyseerrUI: {
      createJellyseerrCard: (...args) => { cardArgs.push(args.slice(1)); return fakeCard(doc)(...args); },
      showSeasonSelectionModal: async (...args) => { modals.push(args); },
      showMovieRequestModal: async (...args) => { modals.push(['movie', ...args]); }
    }
  });
  doc = h.document;
  h.JE.initializeListPlaceholders();
  const page = h.document.querySelector('.itemDetailPage');
  const ctrl = h.lp.collection.attach(page, ITEM);
  await tick(); await tick(); await tick();
  const ids = () => [...page.querySelectorAll('.je-lp-card')].map(c => c.getAttribute('data-je-lp-id'));
  return { ...h, page, ctrl, modals, ids, cardArgs, requests, setView(v) { current = v; } };
}

test('the section sits right after .collectionItems with cards by release date, TBA last', async t => {
  const h = await mount(t, [
    ph('tba', { releaseDate: null, released: false, title: 'A' }),
    ph('late', { releaseDate: '2014-07-17', title: 'Late' }),
    ph('early', { releaseDate: '2013-08-09', title: 'Early' }),
    ph('custom', { kind: 'custom', tmdbId: null, releaseDate: null, title: 'B' })
  ]);
  const section = h.page.querySelector('.collectionItems').nextElementSibling;
  assert.ok(section.classList.contains('je-lp-collection-section'));
  assert.deepEqual(h.ids(), ['early', 'late', 'tba', 'custom']);
  assert.equal(h.page.querySelector('.je-lp-section-head h2').hidden, false);
  assert.ok(section.querySelector('.je-lp-toolbar'));
  // a re-render of .collectionItems keeps the sibling section
  h.page.querySelector('.collectionItems').innerHTML = '';
  assert.ok(h.page.querySelector('.je-lp-collection-section'));
});

test('TV request buttons on placeholder cards open the season modal and never reach the global handler', async t => {
  const h = await mount(t, [ph('s', { kind: 'season', mediaType: 'tv', tmdbId: 114502, seasonNumber: 1, title: 'Cars on the Road' })]);
  let global = 0;
  h.document.body.addEventListener('click', () => global++);
  h.page.querySelector('.je-lp-card .jellyseerr-request-button').click();
  assert.equal(global, 0);
  assert.equal(h.modals.length, 1);
  assert.deepEqual([h.modals[0][0], h.modals[0][1], h.modals[0][2], h.modals[0][4]], [114502, 'tv', 'Cars on the Road', false]);
  assert.deepEqual([...h.modals[0][5].preselectedSeasons], [1]);
  // the 4K popup item asks for a 4K season request
  h.page.querySelector('.je-lp-card .jellyseerr-4k-popup-item').click();
  assert.equal(h.modals[1][4], true);
  assert.equal(global, 0);
});

test('viewers get read-only cards and no toolbar; an empty list renders nothing for them', async t => {
  const viewer = await mount(t, [ph('m')], { canEdit: false, nativeCanEdit: false });
  assert.equal(viewer.page.querySelector('.je-lp-toolbar'), null);
  assert.equal(viewer.page.querySelector('.je-lp-menu-btn'), null);
  const empty = await mount(t, [], { canEdit: false });
  assert.equal(empty.page.querySelector('.je-lp-collection-section'), null);
  const editorEmpty = await mount(t, []);
  assert.ok(editorEmpty.page.querySelector('.je-lp-collection-section .je-lp-toolbar'));
  assert.equal(editorEmpty.page.querySelector('.je-lp-section-head h2').hidden, true);
});

test('a new revision re-renders; a requested event rebuilds only the matching cards', async t => {
  const h = await mount(t, [ph('a', { tmdbId: 1 }), ph('b', { tmdbId: 2 })]);
  const cardB = h.page.querySelector('.je-lp-card[data-je-lp-id="b"]');
  h.document.dispatchEvent(new h.window.CustomEvent('jellyseerr-media-requested', { detail: { tmdbId: '1', mediaType: 'movie' } }));
  const cardA = h.page.querySelector('.je-lp-card[data-je-lp-id="a"]');
  assert.equal(cardA.__item.mediaInfo.status, 3);
  assert.equal(h.page.querySelector('.je-lp-card[data-je-lp-id="b"]'), cardB);
  h.setView(view({ listId: COLLECTION, listKind: 'collection', rev: 2, order: null, placeholders: [ph('b', { tmdbId: 2 })] }));
  await h.ctrl.load();
  assert.deepEqual(h.ids(), ['b']);
});

test('placeholder TMDB ids for the "Missing from" discovery share one GET', async t => {
  const h = await mount(t, [ph('a', { tmdbId: 10 }), ph('b', { tmdbId: 11, mediaType: 'tv', kind: 'series' })]);
  const before = h.calls.length;
  const ids = await h.JE.listPlaceholders.getPlaceholderTmdbIds(COLLECTION, 'movie');
  assert.deepEqual([...ids], [10]);
  assert.equal(h.calls.length, before, 'reuses the view the section just loaded');
});

test('many placeholders are built in slices', async t => {
  const many = Array.from({ length: 60 }, (_, i) => ph(`m${i}`, { tmdbId: i + 1, releaseDate: `2000-01-${String((i % 28) + 1).padStart(2, '0')}` }));
  const h = await mount(t, many);
  h.ctrl.render();
  const first = h.page.querySelectorAll('.je-lp-card').length;
  assert.ok(first > 0 && first < 60, `first slice only (${first})`);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(h.page.querySelectorAll('.je-lp-card').length, 60);
});

test('the first placeholder added to an empty collection gets working request buttons (Seerr user loaded)', async t => {
  let statusCalls = 0;
  const h = await mount(t, [], {}, { userStatus: async () => { statusCalls++; return { active: true, userFound: true }; } });
  assert.equal(statusCalls, 0, 'no placeholders yet: no user lookup');
  h.lp.api.publish(view({ listId: COLLECTION, listKind: 'collection', rev: 2, order: null, placeholders: [ph('m', { tmdbId: 1 })] }));
  await tick(); await tick(); await tick();
  assert.equal(statusCalls, 1);
  assert.equal(h.ctrl.user.active, true);
  assert.deepEqual(h.cardArgs.at(-1), [true, true], 'cards rebuilt with the user status (no "Offline" button)');
  assert.deepEqual(h.ids(), ['m']);
});

test('movie request buttons on placeholder cards use the placeholder flow: a 409 marks the card requested', async t => {
  const h = await mount(t, [ph('m', { tmdbId: 7, title: 'Cars 4' })], {}, { api: { requestError: Object.assign(new Error('HTTP 409'), { status: 409 }) } });
  const button = h.page.querySelector('.je-lp-card .jellyseerr-request-button');
  let ownHandler = 0;
  button.addEventListener('click', () => ownHandler++);
  button.click();
  await tick(); await tick(); await tick();
  assert.equal(ownHandler, 0, "the card button's own handler never runs");
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0][0], 7);
  const card = h.page.querySelector('.je-lp-card[data-je-lp-id="m"]');
  assert.equal(card.__item.mediaInfo.status, 3, 'rebuilt as requested');
  assert.equal(h.toasts.length, 0);
});

test('collection editors see the auto-request hint next to Add title while the list has placeholders', async t => {
  const h = await mount(t, [ph('a'), ph('b')]);
  const bar = h.page.querySelector('.je-lp-collection-section .je-lp-toolbar');
  assert.equal(bar.querySelector('.je-lp-toolbar-auto'), null); // setting off by default
  h.JE.pluginConfig.ListPlaceholdersAutoRequestEnabled = true;
  h.JE.pluginConfig.ListPlaceholdersAutoRequestCount = 4;
  h.ctrl.render();
  assert.equal(bar.querySelector('.je-lp-toolbar-auto').textContent, 'listPlaceholders_auto_request_hint{"count":4}');
  assert.equal(bar.querySelector('.je-lp-toolbar-label').textContent, ''); // the section title already says it
  h.ctrl.view = { ...h.ctrl.view, placeholders: [] };
  h.ctrl.render();
  assert.equal(bar.querySelector('.je-lp-toolbar-auto'), null);
});
