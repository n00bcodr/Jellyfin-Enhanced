import { clickAsViewer } from '../helpers/harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness, jsRoot, deferred } from '../helpers/harness.mjs';
const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
const topic = 'A major character dies';
const entry = { Found: true, Confirmed: true, ItemId: 123, Topics: [{ Id: 1, Name: topic, Yes: 9, No: 1 }] };
const stub = revision => ({ Guarded: true, PolicyRevision: revision, Topics: [] });
async function setup(t, { id = 'library-movie', guarded = true, ajax = async () => ({ Triggers: [] }), firstRender = true } = {}) {
  let view, switched, user = 'viewer-a';
  const calls = [], pending = [];
  let policy = 'p1';
  const h = createHarness({ html: '<div id="itemDetailPage"><div class="itemExternalLinks"></div></div>',
    url: `http://jellyfin.test/web/index.html#/details?id=${id}`,
    apiClient: { getCurrentUserId: () => user, getItem: async () => ({ Type: 'Movie', ProviderIds: { Tmdb: '123' } }), ajax },
    JE: { pluginConfig: { DoesTheDogDieEnabled: true, SpoilerBlurEnabled: true }, t: key => en[key] || key,
      helpers: { onViewPage: cb => { view = cb; return () => {}; } },
      session: { getEpoch: () => user, isCurrent: epoch => epoch === user, onUserChange: (key, cb) => { switched = cb; } },
      core: { api: { manager: { clearCacheMatching() {} }, plugin: async (path, options) => {
        calls.push({ path, options });
        if (path.includes('reveal=true')) {
          if (pending.length) await pending.shift().promise;
          return { ...entry, Guarded: guarded, PolicyRevision: policy };
        }
        return guarded ? stub(policy) : { ...entry, Guarded: false, PolicyRevision: policy };
      } } }
    } });
  // The settings store first, as in production: the picks are its ddd-triggers.json document.
  t.after(() => h.close()); h.load('core/mutation-queue.js'); h.load('enhanced/config.js'); h.load('others/doesthedogdie.js'); h.JE.initializeDoesTheDogDieScript();
  const render = async () => { await view(null, h.document.getElementById('itemDetailPage'), h.window.location.hash); await new Promise(r => setTimeout(r, 30)); };
  if (firstRender) await render();
  return { ...h, calls, render, pending, change: () => { policy = 'p2'; guarded = true; h.window.dispatchEvent(new h.window.Event('je:spoiler-changed')); },
    switchUser: () => { user = 'viewer-b'; switched?.(); } };
}
for (const id of ['library-movie', '4a45ad110017d47e000000007a4c25fc']) test(`DDD ${id}: guarded topics enter the DOM only after explicit Show`, async t => {
  const h = await setup(t, { id });
  const section = h.document.querySelector('.je-ddd-section');
  assert.ok(section, 'a guarded title keeps a neutral warning control'); assert.equal(section.open, false);
  assert.match(section.textContent, /Content warnings.*hidden by Spoiler Guard.*Show/);
  assert.ok(!h.document.body.textContent.includes(topic));
  clickAsViewer(section.querySelector('summary')); await new Promise(r => setTimeout(r, 30));
  assert.match(h.document.body.textContent, /A major character dies/);
  assert.ok(h.calls.some(c => c.path.includes('reveal=true') && c.path.includes('policyRevision=p1')));
});
test('DDD unguarded topics stay expanded, and a policy change removes them without reusing the reply', async t => {
  const h = await setup(t, { guarded: false });
  assert.equal(h.document.querySelector('.je-ddd-section').open, true);
  assert.match(h.document.body.textContent, /A major character dies/);
  h.change(); await new Promise(r => setTimeout(r, 30));
  assert.ok(!h.document.body.textContent.includes(topic));
  assert.equal(h.document.querySelector('.je-ddd-section').open, false);
  assert.ok(h.calls.filter(c => !c.path.includes('reveal=true')).length >= 2);
  assert.ok(h.calls.every(c => !c.options?.cacheKey), 'viewer projections are never kept in the shared browser cache');
});
test('DDD a reveal request in flight cannot render for the incoming viewer', async t => {
  const h = await setup(t); const gate = deferred(); h.pending.push(gate);
  const show = h.document.querySelector('.je-ddd-section summary'); assert.ok(show, 'a real reveal control must exist');
  clickAsViewer(show); assert.ok(h.calls.at(-1).path.includes('reveal=true'), 'the reveal is actually in flight');
  h.switchUser(); gate.resolve();
  await new Promise(r => setTimeout(r, 30)); assert.ok(!h.document.body.textContent.includes(topic));
});
test('DDD the outgoing viewer\'s trigger picks, read late, never become the incoming viewer\'s', async t => {
  const outgoing = deferred(), reads = [];
  const ajax = async ({ url }) => { reads.push(url); return url.includes('/viewer-a/') ? outgoing.promise : { Triggers: [] }; };
  const h = await setup(t, { guarded: false, ajax, firstRender: false });
  h.render(); // viewer A's page waits on A's trigger read
  for (let i = 0; i < 100 && !reads.some(u => u.includes('/viewer-a/')); i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(reads.some(u => u.includes('/viewer-a/')), "A's trigger read is in flight");
  h.switchUser(); await h.render();
  const summary = () => h.document.querySelector('.je-ddd-sum')?.textContent;
  assert.equal(summary(), en.ddd_summary_all, 'B has no picks');
  outgoing.resolve({ Triggers: [1] }); await new Promise(r => setTimeout(r, 30));
  await h.render();
  assert.equal(summary(), en.ddd_summary_all, "A's picks stay A's after B's page is drawn again");
});
// Other locales come from Weblate; the per-key English fallback (translations.js) covers keys they don't have yet.
test('every key the DDD module and the one-season toast use exists in English', () => {
  const source = readFileSync(resolve(jsRoot, 'others/doesthedogdie.js'), 'utf8');
  const keys = [...new Set([...source.matchAll(/JE\.t\('([a-z0-9_]+)'/g)].map(m => m[1]))];
  assert.ok(keys.includes('ddd_guarded_show'), 'the guarded reveal control is translated');
  for (const key of [...keys, 'arr_ask_toast_single_season']) assert.equal(typeof en[key], 'string', key);
});

test('DDD navigation to a guarded title removes revealed topics from retained Jellyfin page DOM', async t => {
  const h = await setup(t, { guarded: false });
  const old = h.document.getElementById('itemDetailPage'); old.classList.add('hide'); old.id = 'previousDetails';
  const next = h.document.createElement('div'); next.id = 'itemDetailPage'; next.innerHTML = '<div class="itemExternalLinks"></div>'; h.document.body.appendChild(next);
  h.change(); await h.render();
  assert.ok(!h.document.body.textContent.includes(topic), 'retained outgoing pages must not hold revealed warning content');
});
