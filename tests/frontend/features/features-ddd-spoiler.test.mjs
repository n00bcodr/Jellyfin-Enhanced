import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness, jsRoot, deferred } from '../helpers/harness.mjs';
const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
const topic = 'A major character dies';
const entry = { Found: true, Confirmed: true, ItemId: 123, Topics: [{ Id: 1, Name: topic, Yes: 9, No: 1 }] };
const stub = revision => ({ Guarded: true, PolicyRevision: revision, Topics: [] });
async function setup(t, { id = 'library-movie', guarded = true } = {}) {
  let view, switched, user = 'viewer-a';
  const calls = [], pending = [];
  let policy = 'p1';
  const h = createHarness({ html: '<div id="itemDetailPage"><div class="itemExternalLinks"></div></div>',
    url: `http://jellyfin.test/web/index.html#/details?id=${id}`,
    apiClient: { getCurrentUserId: () => user, getItem: async () => ({ Type: 'Movie', ProviderIds: { Tmdb: '123' } }), ajax: async () => ({ Triggers: [] }) },
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
  t.after(() => h.close()); h.load('others/doesthedogdie.js'); h.JE.initializeDoesTheDogDieScript();
  const render = async () => { await view(null, h.document.getElementById('itemDetailPage'), h.window.location.hash); await new Promise(r => setTimeout(r, 30)); };
  await render();
  return { ...h, calls, render, pending, change: () => { policy = 'p2'; guarded = true; h.window.dispatchEvent(new h.window.Event('je:spoiler-changed')); },
    switchUser: () => { user = 'viewer-b'; switched?.(); } };
}
for (const id of ['library-movie', '4a45ad110017d47e000000007a4c25fc']) test(`DDD ${id}: guarded topics enter the DOM only after explicit Show`, async t => {
  const h = await setup(t, { id });
  const section = h.document.querySelector('.je-ddd-section');
  assert.ok(section, 'a guarded title keeps a neutral warning control'); assert.equal(section.open, false);
  assert.match(section.textContent, /Content warnings.*hidden by Spoiler Guard.*Show/);
  assert.ok(!h.document.body.textContent.includes(topic));
  section.querySelector('summary').click(); await new Promise(r => setTimeout(r, 30));
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
  show.click(); assert.ok(h.calls.at(-1).path.includes('reveal=true'), 'the reveal is actually in flight');
  h.switchUser(); gate.resolve();
  await new Promise(r => setTimeout(r, 30)); assert.ok(!h.document.body.textContent.includes(topic));
});
test('all 33 locales have the same keys as English', () => {
  const files = readdirSync(resolve(jsRoot, 'locales')).filter(f => f.endsWith('.json'));
  assert.equal(files.length, 33); const keys = Object.keys(en).sort();
  for (const file of files) assert.deepEqual(Object.keys(JSON.parse(readFileSync(resolve(jsRoot, 'locales', file), 'utf8'))).sort(), keys, file);
});

test('DDD navigation to a guarded title removes revealed topics from retained Jellyfin page DOM', async t => {
  const h = await setup(t, { guarded: false });
  const old = h.document.getElementById('itemDetailPage'); old.classList.add('hide'); old.id = 'previousDetails';
  const next = h.document.createElement('div'); next.id = 'itemDetailPage'; next.innerHTML = '<div class="itemExternalLinks"></div>'; h.document.body.appendChild(next);
  h.change(); await h.render();
  assert.ok(!h.document.body.textContent.includes(topic), 'retained outgoing pages must not hold revealed warning content');
});
