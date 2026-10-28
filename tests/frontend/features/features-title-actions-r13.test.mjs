import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, delivered, moreInfo } from '../helpers/title-actions-scopes.mjs';
import { hostInput, HOSTS } from '../helpers/host-input.mjs';

// D46 slice 2 review round 13: a delayed press keeps the card it was made on; a host dialog that arrived earlier is
// under a newer surface; a pending ask's retry id belongs to its own submission; a write's sent facts come from the
// transport's outcome and its business result from the answer, never from an error name or an account switch; a
// reconciliation pass mints at most one shared lifetime and releases what went; jellyfin-web's remote Back goes through
// the surface stack; a dialog is named by its own title; and Hide's Undo is reachable inside the window it came from.

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const askPosts = h => h.sent('POST', '/acquire/requests').filter(r => r[2] === '/acquire/requests');

/** A discovery card for `key` with a poster to long-press. */
function discoverCard(h, key, name) {
  const card = h.document.createElement('div'); card.className = 'je-discover-card';
  card.dataset.jeHideTitle = key; card.dataset.jeHideName = name;
  const poster = h.document.createElement('div'); poster.textContent = 'Poster'; card.append(poster);
  h.document.body.append(card);
  return { card, poster };
}
/** The viewer's touch goes down on `node` (a trusted pointerdown). */
function touchDown(h, node) {
  const event = new h.window.Event('pointerdown', { bubbles: true, cancelable: true });
  Object.defineProperties(event, { pointerType: { value: 'touch' }, clientX: { value: 10 }, clientY: { value: 10 } });
  h.trusted(node, event);
}
const lookups = (h, id) => h.requests.filter(r => r[2].startsWith(`/title-actions/movie/${id}`)).length;

// ------------------------------------------------------------------ R13-2: a long press keeps the card it was made on

test('R13-2: a long press on a card the host recycles to another title before the menu opens opens nothing', async t => {
  const h = setup(t, { asks: false });
  const { card, poster } = discoverCard(h, 'movie:tmdb:603', 'First title');
  h.a.initialize(); await delivered();
  touchDown(h, poster);
  card.dataset.jeHideTitle = 'movie:tmdb:604'; card.dataset.jeHideName = 'Second title'; h.a.scan();
  await wait(610); await delivered();
  assert.equal(h.document.querySelector('.je-actions-sheet'), null, 'the press on 603 opened the recycled card\'s menu');
  assert.equal(lookups(h, 604), 0);
  assert.equal(lookups(h, 603), 0);
});

test('R13-2: recycled away and back to the same title before the menu opens, the old press still opens nothing', async t => {
  const h = setup(t, { asks: false });
  const { card, poster } = discoverCard(h, 'movie:tmdb:603', 'First title');
  h.a.initialize(); await delivered();
  touchDown(h, poster);
  card.dataset.jeHideTitle = 'movie:tmdb:604'; h.a.scan();
  card.dataset.jeHideTitle = 'movie:tmdb:603'; h.a.scan();
  await wait(610); await delivered();
  assert.equal(h.document.querySelector('.je-actions-sheet'), null, 'a fresh mount of 603 took the old press');
  assert.equal(lookups(h, 603), 0);
});

test('R13-2: recycled with the reconciliation still pending when the timer fires, the old press opens nothing', async t => {
  const h = setup(t, { asks: false });
  const { card, poster } = discoverCard(h, 'movie:tmdb:603', 'First title');
  h.a.initialize(); await delivered();
  touchDown(h, poster);
  await wait(540);
  card.dataset.jeHideTitle = 'movie:tmdb:604'; card.dataset.jeHideName = 'Second title';
  await wait(40); await delivered();
  assert.equal(h.document.querySelector('.je-actions-sheet'), null);
  assert.equal(lookups(h, 604), 0);
});

test('R13-2: recycled away and back to the same title with the host\'s pass already done, the old press still opens nothing', async t => {
  const h = setup(t, { asks: false });
  const { card, poster } = discoverCard(h, 'movie:tmdb:603', 'First title');
  h.a.initialize(); await delivered();
  touchDown(h, poster);
  // Both changes in one task: the host's own pass sees the card showing 603 again and keeps its mount.
  card.dataset.jeHideTitle = 'movie:tmdb:604'; card.dataset.jeHideTitle = 'movie:tmdb:603';
  await wait(100); await delivered();
  assert.equal(card.querySelectorAll('.je-card-more').length, 1);
  await wait(510); await delivered();
  assert.equal(h.document.querySelector('.je-actions-sheet'), null, 'a press made before the card was recycled acted after it');
  assert.equal(lookups(h, 603), 0);
});

test('R13-2: a long press on an unchanged card opens its own menu, also after an unchanged reconciliation pass', async t => {
  const h = setup(t, { asks: false });
  const { poster } = discoverCard(h, 'movie:tmdb:603', 'First title');
  h.a.initialize(); await delivered();
  touchDown(h, poster);
  h.a.scan();
  await wait(610); await delivered();
  const sheet = h.document.querySelector('.je-actions-sheet');
  assert.ok(sheet, 'the press opened its card\'s menu');
  assert.ok(sheet.textContent.includes('First title'));
  assert.equal(lookups(h, 603), 1);
});

test('R13-2: a card the host removes while the press waits opens nothing', async t => {
  const h = setup(t, { asks: false });
  const { card, poster } = discoverCard(h, 'movie:tmdb:603', 'First title');
  h.a.initialize(); await delivered();
  touchDown(h, poster);
  card.remove(); h.a.scan();
  await wait(610); await delivered();
  assert.equal(h.document.querySelector('.je-actions-sheet'), null);
  assert.equal(lookups(h, 603), 0);
});

// ------------------------------------------------------------------ R13-3: host arrivals precede a newer surface

for (const version of HOSTS) {
  test(`R13-3: a host dialog that arrived while More Info was open is under a newer form opened in the same task (${version})`, async t => {
    const h = setup(t, { asks: false }); hostInput(h, version, { tv: true });
    await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE); await delivered();
    const owner = h.JE.scopeOf(moreInfo(h));
    const host = h.document.createElement('div'); host.className = 'dialogContainer'; host.innerHTML = '<button>Host OK</button>';
    h.document.body.append(host);
    const form = h.JE.jellyseerrModal.create({ title: 'Newest form', bodyHtml: '<input>', onSave() {}, operation: owner });
    form.show(); await delivered();
    assert.equal(h.JE.isTopmostSurface(form.modalElement), true, 'the newer form is topmost');
    assert.equal(h.JE.isTopmostSurface(host), false);
    assert.equal(form.modalElement.hasAttribute('inert'), false, 'the newer form takes input');
    assert.equal(h.JE.isCovered(form.modalElement.querySelector('input')), false);
    assert.equal(h.JE.isCovered(host.querySelector('button')), true, 'the older host dialog is covered');
    assert.equal(host.hasAttribute('inert'), true);
    // The host's dialog goes: the form stays topmost and live.
    host.remove(); await delivered();
    assert.equal(h.JE.isTopmostSurface(form.modalElement), true);
    assert.equal(form.modalElement.hasAttribute('inert'), false);
    form.close();
  });

  test(`R13-3: a host dialog that arrives after the form is above it, and the form is live again once it goes (${version})`, async t => {
    const h = setup(t, { asks: false }); hostInput(h, version, { tv: true });
    await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE); await delivered();
    const owner = h.JE.scopeOf(moreInfo(h));
    const form = h.JE.jellyseerrModal.create({ title: 'Form', bodyHtml: '<input>', onSave() {}, operation: owner });
    form.show(); await delivered();
    const host = h.document.createElement('div'); host.className = 'dialogContainer'; host.innerHTML = '<button>Host OK</button>';
    h.document.body.append(host); await delivered();
    assert.equal(h.JE.isTopmostSurface(host), true);
    assert.equal(form.modalElement.hasAttribute('inert'), true);
    host.remove(); await delivered();
    assert.equal(h.JE.isTopmostSurface(form.modalElement), true);
    assert.equal(form.modalElement.hasAttribute('inert'), false);
    form.close();
  });
}

test('R13-3: a rejected opening with a host arrival pending changes neither the stack nor inert state', async t => {
  const h = setup(t, { asks: false });
  await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE); await delivered();
  const info = moreInfo(h);
  const ended = h.a.generation(); ended.end();
  const host = h.document.createElement('div'); host.className = 'dialogContainer'; host.innerHTML = '<button>Host OK</button>';
  h.document.body.append(host);
  const form = h.JE.jellyseerrModal.create({ title: 'Form', bodyHtml: '<input>', onSave() {}, operation: ended });
  assert.equal(form.show(), false);
  await delivered();
  assert.equal(h.JE.isTopmostSurface(host), true, 'the host dialog that arrived is topmost');
  assert.equal(info.hasAttribute('inert'), true);
  host.remove(); await delivered();
  assert.equal(h.JE.isTopmostSurface(info), true);
  assert.equal(info.hasAttribute('inert'), false);
});

// ------------------------------------------------------------------ R13-4: pending retry ids belong to their submission

test('R13-4: A\'s late accepted answer leaves B\'s pending ask and its retry id alone', async t => {
  const h = setup(t); const input = h.JE.arrAsk.movieInput('movie:tmdb:603');
  const aGate = h.hold('POST', '/acquire/requests');
  const a = h.JE.arrAsk.ask(input, { bound: h.NATIVE.bound() });
  await delivered();
  h.switchUser(); await delivered();
  const bGate = h.hold('POST', '/acquire/requests');
  const b = h.JE.arrAsk.ask(input, { bound: h.NATIVE.bound() });
  await delivered();
  const bId = askPosts(h)[1][3].clientRequestId;
  aGate.resolve({ outcome: 'accepted', certainty: 'Succeeded', requestId: 'a'.repeat(32) });
  assert.equal((await a).sessionChanged, true);
  const retry = h.JE.arrAsk.ask(input, { bound: h.NATIVE.bound() });
  await delivered();
  assert.equal(askPosts(h)[2][3].clientRequestId, bId, 'B\'s retry is the same ask');
  assert.notEqual(askPosts(h)[0][3].clientRequestId, bId);
  bGate.resolve(); await b; await retry;
});

test('R13-4: an older same-session ask answered after a newer one replaced its entry leaves the newer retry id', async t => {
  const h = setup(t); const input = h.JE.arrAsk.movieInput('movie:tmdb:603');
  const first = 'b'.repeat(32); const second = 'c'.repeat(32);
  const oneGate = h.hold('POST', '/acquire/requests');
  const one = h.JE.arrAsk.ask(input, { bound: h.NATIVE.bound(), clientRequestId: first });
  await delivered();
  const twoGate = h.hold('POST', '/acquire/requests');
  const two = h.JE.arrAsk.ask(input, { bound: h.NATIVE.bound(), clientRequestId: second });
  await delivered();
  oneGate.resolve(); assert.equal((await one).ok, true);
  const retry = h.JE.arrAsk.ask(input, { bound: h.NATIVE.bound() });
  await delivered();
  assert.equal(askPosts(h)[2][3].clientRequestId, second, 'the newer ask\'s retry kept its id');
  twoGate.resolve(); await two; await retry;
});

test('R13-4: reversed completion: an old ask answered after a newer ask settled and a third started leaves the third\'s id', async t => {
  const h = setup(t); const input = h.JE.arrAsk.movieInput('movie:tmdb:603');
  const oneGate = h.hold('POST', '/acquire/requests');
  const one = h.JE.arrAsk.ask(input, { bound: h.NATIVE.bound(), clientRequestId: 'b'.repeat(32) });
  await delivered();
  const two = h.JE.arrAsk.ask(input, { bound: h.NATIVE.bound(), clientRequestId: 'c'.repeat(32) });
  assert.equal((await two).ok, true);
  const threeGate = h.hold('POST', '/acquire/requests');
  const three = h.JE.arrAsk.ask(input, { bound: h.NATIVE.bound() });
  await delivered();
  const thirdId = askPosts(h)[2][3].clientRequestId;
  oneGate.resolve(); await one;
  const retry = h.JE.arrAsk.ask(input, { bound: h.NATIVE.bound() });
  await delivered();
  assert.equal(askPosts(h)[3][3].clientRequestId, thirdId);
  threeGate.resolve(); await three; await retry;
});

test('R13-4: a 5xx keeps the ask\'s id for its retry; a definitive answer ends it', async t => {
  const h = setup(t); const input = h.JE.arrAsk.movieInput('movie:tmdb:603');
  h.respond('POST', '/acquire/requests', (path) => path === '/acquire/requests' ? [503, { outcome: 'failed' }] : null);
  await h.JE.arrAsk.ask(input, { bound: h.NATIVE.bound() });
  await h.JE.arrAsk.ask(input, { bound: h.NATIVE.bound() });
  const ids = askPosts(h).map(r => r[3].clientRequestId);
  assert.equal(new Set(ids).size, 1, 'the same ask after a server error');
  h.respond('POST', '/acquire/requests', (path) => path === '/acquire/requests' ? [201, { outcome: 'accepted', reason: 'looking', certainty: 'Succeeded', requestId: 'a'.repeat(32) }] : null);
  await h.JE.arrAsk.ask(input, { bound: h.NATIVE.bound() });
  await h.JE.arrAsk.ask(input, { bound: h.NATIVE.bound() });
  const after = askPosts(h).map(r => r[3].clientRequestId);
  assert.equal(after[2], ids[0]);
  assert.notEqual(after[3], ids[0], 'a definitive answer ended the ask');
});

// ------------------------------------------------------------------ R13-5: sent facts come from the transport's outcome

/** Fetch honouring the request's AbortSignal (the production transport passes its own). */
function abortableFetch(h) {
  const fetch = h.window.fetch;
  h.window.fetch = (url, options) => new Promise((resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    fetch(url, options).then(resolve, reject);
  });
}

test('R13-5: a sent ask whose answer is lost to an abort is uncertain, not an unsent cancellation, and its retry is the same ask', async t => {
  const h = setup(t); const gate = h.hold('POST', '/acquire/requests');
  abortableFetch(h);
  const controller = new h.window.AbortController();
  const input = h.JE.arrAsk.movieInput('movie:tmdb:603');
  const pending = h.JE.arrAsk.ask(input, { bound: h.NATIVE.bound(), signal: controller.signal });
  await delivered(); assert.equal(askPosts(h).length, 1);
  const error = new h.window.DOMException('Aborted after the POST was sent', 'AbortError');
  controller.abort(error);
  const result = await pending;
  assert.equal(h.JE.core.api.writeOutcome(error).outcome, 'failed');
  assert.equal(result.ok, false);
  assert.notEqual(result.reason, 'aborted');
  assert.notEqual(result.stale, true, 'a sent write is not reported as never sent');
  assert.equal(result.sent, true);
  // Explicitly unconfirmed (integration r12): a possible send is never reported as failed or unsent.
  assert.equal(result.state, 'unconfirmed');
  assert.equal(result.reason, 'unconfirmed');
  const retry = h.JE.arrAsk.ask(input, { bound: h.NATIVE.bound() });
  await delivered();
  assert.equal(askPosts(h)[1][3].clientRequestId, askPosts(h)[0][3].clientRequestId, 'the retry reuses the uncertain ask\'s id');
  gate.resolve(); await retry;
});

test('R13-5: an ask whose owner ended before the send is unsent: nothing went out and it says nothing', async t => {
  const h = setup(t);
  const token = h.a.generation(); token.end();
  const result = await h.JE.arrAsk.ask(h.JE.arrAsk.movieInput('movie:tmdb:603'), { bound: token.bound() });
  assert.equal(askPosts(h).length, 0);
  assert.equal(result.reason, 'aborted');
  assert.equal(result.stale, true);
});

/** The POSTs under `prefix` go out, and their answer is lost to an AbortError (the request was sent). */
function loseAnswers(h, prefix) {
  const fetch = h.window.fetch;
  h.window.fetch = (url, options = {}) => {
    const sent = fetch(url, options);
    if ((options.method || 'GET') !== 'POST' || !String(url).includes(prefix)) return sent;
    sent.catch(() => {});
    return Promise.reject(new h.window.DOMException('The answer was lost', 'AbortError'));
  };
}

for (const route of ['admin', 'family']) {
  test(`R13-5: a ${route} Search whose answer is lost after the send is a failure to report, not a never-sent abort`, async t => {
    const h = setup(t);
    loseAnswers(h, route === 'admin' ? '/arr/admin/manage/search' : '/acquire/requests/search');
    const search = route === 'admin' ? h.JE.arrAsk.adminSearch('movie:tmdb:603', 'radarr', { bound: h.NATIVE.bound() })
      : h.JE.arrAsk.familySearch('movie:tmdb:603', { bound: h.NATIVE.bound() });
    const result = await search.catch(error => ({ thrown: error.name }));
    assert.equal(h.sent('POST', route === 'admin' ? '/arr/admin/manage/search' : '/acquire/requests/search').length, 1);
    assert.equal(result?.thrown, undefined, 'a sent Search does not throw the never-sent abort');
    assert.notEqual(result, null, 'a sent family Search does not fall back to a new ask');
    // Explicitly unconfirmed (integration r12): it may have run, so it is neither a failure to retry nor a new ask.
    assert.equal(result.ok, false); assert.equal(result.state, 'unconfirmed'); assert.equal(result.sent, true);
  });
}

// ------------------------------------------------------------------ R13-6: the answer decides success, also after a switch

test('R13-6: a sent admin Search answered 403 Rejected after an account switch stays a failure, for the origin only', async t => {
  const h = setup(t); const gate = h.hold('POST', '/arr/admin/manage/search');
  const changes = []; h.JE.arrAsk.onChange(change => changes.push(change));
  const search = h.JE.arrAsk.adminSearch('movie:tmdb:603', 'radarr', { bound: h.NATIVE.bound() });
  await delivered(); assert.equal(h.sent('POST', '/arr/admin/manage/search').length, 1);
  h.switchUser();
  gate.resolve();
  h.respond('POST', '/arr/admin/manage/search', [403, { status: 'Rejected', code: 'not_allowed' }]);
  const result = await search;
  assert.equal(result.ok, false, 'an explicit 403 Rejected is not a success');
  assert.equal(result.state, 'failed');
  assert.equal(result.sessionChanged, true);
  assert.equal(result.stale, true);
  assert.deepEqual(changes, []);
});

test('R13-6: a sent admin Search answered 200 found after an account switch stays a success, published to no one', async t => {
  const h = setup(t); const gate = h.hold('POST', '/arr/admin/manage/search');
  const changes = []; h.JE.arrAsk.onChange(change => changes.push(change));
  const search = h.JE.arrAsk.adminSearch('movie:tmdb:603', 'radarr', { bound: h.NATIVE.bound() });
  await delivered();
  h.switchUser();
  gate.resolve();
  h.respond('POST', '/arr/admin/manage/search', [200, { status: 'Succeeded', found: true }]);
  const result = await search;
  assert.equal(result.ok, true); assert.equal(result.state, 'found'); assert.equal(result.sessionChanged, true);
  assert.deepEqual(changes, []);
  assert.deepEqual(h.toasts, []);
});

test('R13-6: a family Search answered 403 after an account switch is a stale failure, never null (which would ask in B)', async t => {
  const h = setup(t); const gate = h.hold('POST', '/acquire/requests/search');
  const search = h.JE.arrAsk.familySearch('movie:tmdb:603', { bound: h.NATIVE.bound() });
  await delivered(); assert.equal(h.sent('POST', '/acquire/requests/search').length, 1);
  h.switchUser();
  gate.resolve();
  h.respond('POST', '/acquire/requests/search', [403, { status: 'Rejected', reason: 'not_allowed' }]);
  const result = await search;
  assert.notEqual(result, null, 'an old answer does not start a fallback ask in the new session');
  assert.equal(result.ok, false);
  assert.equal(result.sessionChanged, true);
  assert.equal(result.stale, true);
});

test('R13-6: a family Search answered 200 found after an account switch stays a success, published to no one', async t => {
  const h = setup(t); const gate = h.hold('POST', '/acquire/requests/search');
  const changes = []; h.JE.arrAsk.onChange(change => changes.push(change));
  const search = h.JE.arrAsk.familySearch('movie:tmdb:603', { bound: h.NATIVE.bound() });
  await delivered();
  h.switchUser();
  gate.resolve();
  h.respond('POST', '/acquire/requests/search', [200, { found: true }]);
  const result = await search;
  assert.equal(result.ok, true); assert.equal(result.state, 'found'); assert.equal(result.sessionChanged, true);
  assert.deepEqual(changes, []);
});

test('R13-6: a family Search answered 503 after an account switch stays a failure', async t => {
  const h = setup(t); const gate = h.hold('POST', '/acquire/requests/search');
  const search = h.JE.arrAsk.familySearch('movie:tmdb:603', { bound: h.NATIVE.bound() });
  await delivered();
  h.switchUser();
  gate.resolve();
  h.respond('POST', '/acquire/requests/search', [503, {}]);
  const result = await search;
  assert.equal(result.ok, false); assert.equal(result.state, 'failed'); assert.equal(result.sessionChanged, true);
});

test('R13-6: a family Search with nothing to search, in the same session, still returns null so the caller asks instead', async t => {
  const h = setup(t);
  h.respond('POST', '/acquire/requests/search', [200, { outcome: 'skipped' }]);
  assert.equal(await h.JE.arrAsk.familySearch('movie:tmdb:603', { bound: h.NATIVE.bound() }), null);
});

// ------------------------------------------------------------------ R13-1: bounded reconciliation, prompt release

/** Counts shared lifetime mints during `fn` (title action generations and core operation tokens). */
function counting(h) {
  const counts = { generations: 0, operations: 0 };
  const generation = h.a.generation; const operation = h.JE.operation;
  h.a.generation = (...args) => { counts.generations++; return generation(...args); };
  h.JE.operation = (...args) => { counts.operations++; return operation(...args); };
  return counts;
}
function discoverCards(h, n, from = 603) {
  return Array.from({ length: n }, (_, i) => {
    const card = h.document.createElement('div'); card.className = 'je-discover-card';
    card.dataset.jeHideTitle = `movie:tmdb:${from + i}`; card.dataset.jeHideName = 'Movie';
    h.document.body.append(card); return card;
  });
}

test('R13-1: a pass over 40 new cards mints at most one shared lifetime; an unchanged pass mints none', async t => {
  const h = setup(t, { asks: false });
  const initial = h.a.registrySize();
  discoverCards(h, 40);
  const counts = counting(h);
  h.a.scan(); await delivered();
  assert.ok(counts.operations <= 1, `one pass minted ${counts.operations} operation tokens`);
  assert.ok(h.a.registrySize() - initial <= 1, 'the registry does not hold a token per card');
  assert.equal(h.document.querySelectorAll('.je-card-more').length, 40);
  counts.generations = counts.operations = 0;
  for (let i = 0; i < 200; i++) h.a.scan();
  await delivered();
  assert.equal(counts.operations, 0, '200 unchanged passes mint nothing');
  assert.equal(counts.generations, 0);
  assert.ok(h.a.registrySize() - initial <= 1);
});

test('R13-1: the last reconciliation after every card went releases what the cards held, without another mint', async t => {
  const h = setup(t, { asks: false });
  const initial = h.a.registrySize();
  const cards = discoverCards(h, 40);
  h.a.scan(); await delivered();
  const counts = counting(h);
  cards.forEach(card => card.remove()); h.a.scan(); await delivered();
  assert.equal(h.a.registrySize(), initial, 'the registry is back to its size without cards');
  assert.equal(counts.operations, 0, 'released by the reconciliation itself, not by a later mint');
});

/** Waits (bounded) until `n` cards show their More control: a long grid is reconciled a slice per frame. */
async function drawnCards(h, n) {
  for (let i = 0; i < 200 && h.document.querySelectorAll('.je-card-more').length < n; i++) await wait(20);
  await delivered();
}

test('R13-1: 500 more cards join 500 in one pass with at most one mint, and every card keeps its own title', async t => {
  const h = setup(t, { asks: false });
  discoverCards(h, 500);
  h.a.scan(); await drawnCards(h, 500);
  discoverCards(h, 500, 1103);
  const counts = counting(h);
  h.a.scan();
  assert.ok(h.document.querySelectorAll('.je-card-more').length < 1000, 'a long grid is reconciled over several frames');
  await drawnCards(h, 1000);
  assert.ok(counts.operations <= 1);
  const keys = [...h.document.querySelectorAll('.je-card-more')].map(n => n.dataset.jeActionKey);
  assert.equal(keys.length, 1000); assert.equal(new Set(keys).size, 1000);
});

test('R13-1: a card\'s menu still opens from a mount reconciled in a shared pass, and a recycled card\'s old mount has ended', async t => {
  const h = setup(t, { asks: false });
  const [card] = discoverCards(h, 1);
  h.a.scan(); await delivered();
  h.click(card.querySelector('.je-card-more')); await delivered();
  assert.ok(h.document.querySelector('.je-actions-sheet'), 'the More menu opens');
  h.a.close?.(false); await delivered();
  card.dataset.jeHideTitle = 'movie:tmdb:777'; h.a.scan(); await delivered();
  assert.equal(card.querySelectorAll('.je-card-more').length, 1);
  assert.equal(card.querySelector('.je-card-more').dataset.jeActionKey, 'movie:tmdb:777');
});

test('R13-1: a card recycled between two slices of a long pass is mounted for the title it shows when its slice comes', async t => {
  const h = setup(t, { asks: false });
  const cards = discoverCards(h, 450);
  h.a.scan();
  const last = cards.at(-1);
  assert.equal(last.querySelector('.je-card-more'), null, 'the last slice is still to come');
  last.dataset.jeHideTitle = 'movie:tmdb:999999';
  await drawnCards(h, 450);
  assert.equal(last.querySelector('.je-card-more').dataset.jeActionKey, 'movie:tmdb:999999');
});

test('R13-1: removing the cards while a long pass is still running releases them when the pass ends', async t => {
  const h = setup(t, { asks: false });
  const initial = h.a.registrySize();
  const cards = discoverCards(h, 450);
  h.a.scan();
  cards.forEach(card => card.remove());
  for (let i = 0; i < 50; i++) await wait(20);
  await delivered();
  assert.equal(h.a.registrySize(), initial);
  assert.equal(cards.some(card => card.querySelector('.je-card-more')), false);
});

// ------------------------------------------------------------------ R13-7: jellyfin-web's remote Back

for (const version of HOSTS) {
  for (const surface of ['more-info', 'more-sheet']) {
    test(`R13-7: another client's remote Back closes the top ${surface} only, then reaches the router once (${version})`, async t => {
      const h = setup(t, { asks: false, card: true });
      h.window.history.replaceState(null, '', '#/home'); h.window.history.pushState(null, '', '#/search?query=matrix'); await delivered();
      const input = hostInput(h, version, { tv: true }); const remote = await input.remote(); t.after(() => remote.close());
      h.a.initialize();
      if (surface === 'more-info') await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE);
      else h.click(h.document.querySelector('.je-card-more'));
      await delivered();
      const open = () => surface === 'more-info' ? !!moreInfo(h) : !!h.document.querySelector('.je-actions-backdrop');
      assert.ok(open());
      await remote.command('Back'); await wait(30); await delivered();
      assert.equal(open(), false, 'the top surface was dismissed');
      assert.equal(h.window.location.hash, '#/search?query=matrix', 'the route did not move');
      await remote.command('Back'); await wait(30); await delivered();
      assert.equal(h.window.location.hash, '#/home', 'with no surface the router went back');
    });
  }

  test(`R13-7: remote Back after remote Back: the More sheet, then More Info, then the router, in order (${version})`, async t => {
    const h = setup(t, { asks: false, card: true });
    h.window.history.replaceState(null, '', '#/home'); h.window.history.pushState(null, '', '#/search?query=matrix'); await delivered();
    const input = hostInput(h, version, { tv: true }); const remote = await input.remote(); t.after(() => remote.close());
    h.a.initialize();
    h.click(h.document.querySelector('.je-card-more')); await delivered();
    assert.ok(h.document.querySelector('.je-actions-backdrop'));
    await remote.command('Back'); await wait(30); await delivered();
    assert.equal(h.document.querySelector('.je-actions-backdrop'), null);
    await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE); await delivered();
    await remote.command('Back'); await wait(30); await delivered();
    assert.equal(moreInfo(h), null, 'the router\'s next Back was not left waiting on the first');
    assert.equal(h.window.location.hash, '#/search?query=matrix');
    await remote.command('Back'); await wait(30); await delivered();
    assert.equal(h.window.location.hash, '#/home');
    // The two consumed commands took no router step (round 14: decided before the router's gate); the third is the router's.
    assert.equal(input.back, 1);
  });

  test(`R13-7: remote Back closes a nested request form (its own history entry) and leaves More Info open (${version})`, async t => {
    const h = setup(t, { asks: false });
    h.window.history.replaceState(null, '', '#/home'); h.window.history.pushState(null, '', '#/search?query=matrix'); await delivered();
    const input = hostInput(h, version, { tv: true }); const remote = await input.remote(); t.after(() => remote.close());
    await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE); await delivered();
    const form = h.JE.jellyseerrModal.create({ title: 'Form', bodyHtml: '<input>', onSave() {}, operation: h.JE.scopeOf(moreInfo(h)) });
    form.show(); await delivered();
    await remote.command('Back'); await wait(30); await delivered();
    assert.equal(form.modalElement._isClosing, true, 'the form closed');
    assert.equal(h.window.history.state?.jeModal, undefined, 'the form\'s own history entry was the one left');
    assert.ok(moreInfo(h), 'More Info under it stays open');
    assert.equal(h.window.location.hash, '#/search?query=matrix');
    await remote.command('Back'); await wait(30); await delivered();
    assert.equal(moreInfo(h), null);
    assert.equal(h.window.location.hash, '#/search?query=matrix');
  });

  test(`R13-7: with a host dialog on top, remote Back is the host's (${version})`, async t => {
    const h = setup(t, { asks: false });
    h.window.history.replaceState(null, '', '#/home'); h.window.history.pushState(null, '', '#/search?query=matrix'); await delivered();
    const input = hostInput(h, version, { tv: true }); const remote = await input.remote(); t.after(() => remote.close());
    await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE); await delivered();
    // jellyfin-web's dialogHelper: its own history entry, and the dialog closes when that entry is left.
    const host = h.document.createElement('div'); host.className = 'dialogContainer'; host.innerHTML = '<div class="dialog opened"><button class="btnOption">Delete</button></div>';
    let pressed = 0; host.querySelector('button').addEventListener('click', () => { pressed++; host.remove(); });
    h.window.history.pushState({ dialogId: 'host' }, '', h.window.location.href);
    h.window.addEventListener('popstate', () => host.remove(), { once: true });
    h.document.body.append(host); await delivered();
    await remote.command('Back'); await wait(30); await delivered();
    assert.equal(host.isConnected, false, 'the host closed its dialog');
    assert.equal(pressed, 0, 'Back left the host dialog; none of its buttons was pressed');
    assert.ok(moreInfo(h), 'More Info under it stays');
    assert.equal(input.back, 1);
    assert.equal(h.window.location.hash, '#/search?query=matrix');
  });
}

test('R13-7: a script\'s history.back() outside a remote command is untouched while a surface is open', async t => {
  const h = setup(t, { asks: false });
  h.window.history.replaceState(null, '', '#/home'); h.window.history.pushState(null, '', '#/search?query=matrix'); await delivered();
  await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE); await delivered();
  h.window.history.back(); await wait(30); await delivered();
  assert.equal(h.window.location.hash, '#/home');
});

// ------------------------------------------------------------------ R13-8: a dialog is named by its own title

/** The text a node's aria-labelledby names (its referenced elements, in order), or null. */
const labelledText = (h, node) => {
  const ids = node.getAttribute('aria-labelledby');
  return ids ? ids.split(/\s+/).map(id => h.document.getElementById(id)?.textContent ?? '').join(' ').trim() : null;
};

test('R13-8: the movie request form\'s dialog is named by its title, not by its Advanced Options heading', async t => {
  const h = setup(t, { asks: false, advanced: true });
  await h.JE.jellyseerrUI.showMovieRequestModal(603, 'The Matrix', null, false, h.NATIVE); await delivered();
  const movie = h.document.querySelector('.jellyseerr-season-modal');
  const title = movie.querySelector('.jellyseerr-season-title');
  assert.equal(movie.getAttribute('role'), 'dialog');
  assert.equal(labelledText(h, movie), title.textContent);
  assert.notEqual(labelledText(h, movie), 'jellyseerr_advanced_options');
});

test('R13-8: the season request form\'s dialog is named by its title, with ids unique while two forms overlap', async t => {
  const h = setup(t, { asks: false });
  await h.JE.jellyseerrUI.showMovieRequestModal(603, 'The Matrix', null, false, h.NATIVE); await delivered();
  const movie = h.document.querySelector('.jellyseerr-season-modal');
  h.click(movie.querySelector('.jellyseerr-modal-button-secondary')); await delivered();
  // The movie form is still in the document for its exit animation while the season form opens.
  await h.JE.jellyseerrUI.showSeasonSelectionModal(1399, 'tv', 'Game of Thrones', null, false, h.NATIVE); await delivered();
  const season = [...h.document.querySelectorAll('.jellyseerr-season-modal')].find(m => !m._isClosing);
  assert.ok(season && movie.isConnected);
  assert.equal(labelledText(h, season), season.querySelector('.jellyseerr-season-title').textContent);
  assert.ok(labelledText(h, season));
  for (const id of [movie, season].map(m => m.getAttribute('aria-labelledby'))) assert.equal(h.document.querySelectorAll(`[id="${id}"]`).length, 1);
  assert.notEqual(movie.getAttribute('aria-labelledby'), season.getAttribute('aria-labelledby'));
});

test('R13-8: the report form (the same factory) is named by its title', async t => {
  const h = setup(t, { asks: false });
  const form = h.JE.jellyseerrModal.create({ title: 'Report a problem', subtitle: 'The Matrix', bodyHtml: '<h3>Problem</h3><input>', onSave() {}, operation: h.NATIVE });
  form.show(); await delivered();
  assert.equal(labelledText(h, form.modalElement), 'Report a problem');
  form.close();
});

// ------------------------------------------------------------------ R13-9: Undo belongs to the window it came from

function hideSetup(h) {
  h.JE.userConfig = { hiddenContent: { items: {}, settings: { enabled: true, showHideButtons: true, showButtonJellyseerr: true, showHideConfirmation: true } } };
  h.load('enhanced/hiddencontent/hidden-content-data.js'); h.load('enhanced/hiddencontent/hidden-content-dialogs.js');
  const hc = h.JE.internals.hiddenContent; hc.refreshNativeCardVisibility = () => {};
  return hc;
}

test('R13-9: Hide inside More Info offers an Undo that is live, focusable and pressable while the window stays open', async t => {
  const h = setup(t, { asks: false }); const hc = hideSetup(h);
  await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE); await delivered();
  const info = moreInfo(h);
  const control = hc.buildTitleControl({ mediaType: 'movie', tmdbId: 603, name: 'The Matrix' });
  info.querySelector('.modal-content').append(control);
  h.click(control); await delivered();
  h.click(h.document.querySelector('.je-hide-confirm-hide')); await delivered();
  assert.equal(h.sent('PUT', '/user-settings/').length, 1);
  const toast = h.document.querySelector('.je-undo-toast');
  const undo = toast.querySelector('button');
  assert.ok(moreInfo(h), 'More Info is still open');
  assert.equal(toast.closest('[inert]'), null, 'the Undo is not inert');
  assert.equal(h.JE.isCovered(undo), false, 'the Undo is not covered by its own window');
  undo.focus();
  assert.equal(h.document.activeElement, undo, 'the Undo takes focus');
  h.click(undo); await delivered();
  assert.equal(h.sent('DELETE', '/user-settings/').length, 1, 'the viewer\'s Undo unhid the title');
});

test('R13-9: a newer modal over More Info covers its Undo; the Undo is live again once it closes', async t => {
  const h = setup(t, { asks: false }); const hc = hideSetup(h);
  await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE); await delivered();
  const info = moreInfo(h);
  const control = hc.buildTitleControl({ mediaType: 'movie', tmdbId: 603, name: 'The Matrix' });
  info.querySelector('.modal-content').append(control);
  h.click(control); await delivered();
  h.click(h.document.querySelector('.je-hide-confirm-hide')); await delivered();
  const undo = h.document.querySelector('.je-undo-toast button');
  const form = h.JE.jellyseerrModal.create({ title: 'Form', bodyHtml: '<input>', onSave() {}, operation: h.JE.scopeOf(info) });
  form.show(); await delivered();
  assert.equal(h.JE.isCovered(undo), true, 'the newer form covers the Undo');
  h.click(undo); await delivered();
  assert.equal(h.sent('DELETE', '/user-settings/').length, 0, 'a covered Undo does nothing');
  form.close(); await delivered();
  assert.equal(h.JE.isCovered(undo), false);
});

test('R13-9: a Hide written for another owner while More Info is open is not put inside More Info', async t => {
  const h = setup(t, { asks: false }); const hc = hideSetup(h);
  await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE); await delivered();
  const other = h.a.generation();
  assert.notEqual(await hc.hideItem({ type: 'movie', tmdbId: 604, name: 'Other' }, other), false);
  await delivered();
  const toast = h.document.querySelector('.je-undo-toast');
  assert.ok(toast);
  assert.equal(toast.parentElement, h.document.body, 'feedback goes to its own owner\'s surface only');
});

test('R13-9: Hide outside every surface still shows its Undo on the page', async t => {
  const h = setup(t, { asks: false }); const hc = hideSetup(h);
  const control = hc.buildTitleControl({ mediaType: 'movie', tmdbId: 603, name: 'The Matrix' });
  h.document.body.append(control);
  h.click(control); await delivered();
  h.click(h.document.querySelector('.je-hide-confirm-hide')); await delivered();
  const toast = h.document.querySelector('.je-undo-toast');
  assert.equal(toast.parentElement, h.document.body);
  assert.equal(toast.closest('[inert]'), null);
});
