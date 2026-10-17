// Requests & downloads, phase 4b: household rules on the Requests page, rendered by the real modules from server
// answers. The Trusted role and a person's shared allowance on the Household tab, the administrators' request
// conditions editor (load, edits, streaming services, shared allowances, Save with a confirmation that sends only
// what changed, refusals said plainly), Seerr's rules read-only in Seerr mode, rule verdicts in plain words on the
// Approvals cards and My requests, and the request controls' words for a rule refusal or wait.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { jsRoot } from '../helpers/harness.mjs';
import { en, translate, until, setupHub } from '../helpers/arr-hub-extra.mjs';

const pid = n => String(n).padStart(32, 'c');
const person = (n, over = {}) => ({
  id: pid(n), name: `Person ${n}`, role: 'member', you: false, quota: { used: 1, limit: 7, available: true }, active: 0, waiting: 0, requests: [],
  admin: { jellyfinAdmin: false, roleOverride: null, quotaOverride: null, fourK: false, parentalLimit: false, pool: null }, ...over
});
const household = (people, settings) => ({ status: 200, body: { outcome: 'accepted', reason: 'household', certainty: 'Succeeded', canEdit: !!settings, people, settings } });
const settings = (over = {}) => ({ backend: 'je', preset: 'ask_first', defaultRole: 'member', quotaLimit: 0, windowDays: 7, roles: { watcher: {}, kid: {}, member: {}, manager: {} }, ...over });
const RULES_ON = { trusted: true, conditions: true, pools: true };
const choices = {
  roles: ['kid', 'member', 'trusted'], poolRoles: ['*', 'kid', 'member', 'trusted', 'manager'], actions: ['none', 'approve', 'review', 'deny'],
  genres: [{ id: 28, name: 'Action' }, { id: 35, name: 'Comedy' }, { id: 27, name: 'Horror' }]
};
const rulesBody = (over = {}) => ({
  status: 200,
  body: {
    outcome: 'accepted', reason: 'household_rules', certainty: 'Succeeded', backend: 'je', enabled: true, conditions: true, poolsEnabled: true, editable: true,
    rules: { roles: { kid: { rating: { max: 'PG', country: 'US', match: 'none', otherwise: 'review' } } } },
    streamingCountry: '', streamingServices: [], windowDays: 7,
    pools: [{ id: 'kids', name: 'Kids', limit: 7, roles: ['Kid'], users: [], used: 3 }],
    choices, ...over
  }
});
const saved = { status: 200, body: { outcome: 'accepted', reason: 'saved', certainty: 'Succeeded', message: 'Household rules saved.' } };

/** Sets a control's value and fires what a person's edit fires (input, then change). */
function edit(h, node, value) {
  node.focus();
  node.value = value;
  node.dispatchEvent(new h.window.Event('input'));
  node.dispatchEvent(new h.window.Event('change'));
}

/** Ticks or unticks a checkbox the way a click does. */
function tick(h, node, on) {
  node.checked = on;
  node.dispatchEvent(new h.window.Event('change'));
}

test('every key the household rules use exists in en.json, prefixed arr_rules_ in one contiguous run', () => {
  const source = ['arr/household/household-rules.js', 'arr/hub/hub-household.js', 'arr/hub/hub-approvals.js', 'arr/hub/hub-mine-ledger.js', 'arr/ask/ask-core.js', 'arr/ask/ask-sheet.js', 'arr/ask/ask-collection.js']
    .map(m => readFileSync(resolve(jsRoot, m), 'utf8')).join('\n');
  const keys = [...source.matchAll(/'(arr_rules_[a-z0-9_]+)'/g)].map(m => m[1]);
  assert.ok(keys.length > 60);
  for (const key of keys) assert.ok(key in en, key);
  for (const a of ['none', 'approve', 'review', 'deny']) assert.ok(`arr_rules_action_${a}` in en, a);
  for (const c of ['rating', 'genre', 'language', 'size', 'streaming']) {
    for (const k of [`arr_rules_cond_${c}`, `arr_rules_cond_${c}_help`, `arr_rules_what_${c}`]) assert.ok(k in en, k);
  }
  const all = Object.keys(en);
  const first = all.findIndex(k => k.startsWith('arr_rules_'));
  const run = all.slice(first).findIndex(k => !k.startsWith('arr_rules_'));
  assert.equal(all.filter(k => k.startsWith('arr_rules_')).length, run === -1 ? all.length - first : run, 'one contiguous block');
});

test('household rules off: no Trusted choice, no conditions section and no rules read', async t => {
  const h = setupHub(t, {
    hash: '#/requests?tab=household',
    me: { role: 'admin' },
    routes: (m, path) => (path === '/acquire/household' ? household([person(1)], settings()) : null)
  });
  h.JE.initializeArrStatus();
  const page = h.page();
  await until(() => page.querySelector(`[data-je-focus="household:role:${pid(1)}"]`));
  const values = sel => [...page.querySelector(`[data-je-focus="${sel}"]`).options].map(o => o.value);
  assert.ok(!values(`household:role:${pid(1)}`).includes('trusted'));
  assert.ok(!values('household:default-role').includes('trusted'));
  assert.equal(page.querySelector('.je-rules'), null);
  assert.equal(h.calls('GET', '/acquire/household/rules').length, 0);
});

test('household rules on: Trusted is a role and a default role (never a role limit), with its icon and the person\'s shared allowance', async t => {
  let posted = null;
  const h = setupHub(t, {
    hash: '#/requests?tab=household',
    me: { role: 'admin' },
    routes: (method, path, body) => {
      if (path === '/acquire/household/rules') return rulesBody();
      if (path !== '/acquire/household') return null;
      if (method === 'POST') { posted = body; return saved; }
      return household([
        person(1, { name: 'Leo', role: 'trusted', admin: { jellyfinAdmin: false, roleOverride: 'trusted', quotaOverride: null, fourK: false, parentalLimit: false, pool: 'Kids' } }),
        person(2, { name: 'Emma' })
      ], settings({ rules: RULES_ON }));
    }
  });
  h.JE.initializeArrStatus();
  const page = h.page();
  await until(() => page.querySelector('.je-rules .je-rules-role'));
  const [leo] = page.querySelectorAll('.je-household-person');
  assert.equal(leo.querySelector('.je-household-role').textContent, 'verified_userTrusted');
  assert.equal(leo.querySelector('.je-household-pool').textContent, 'Shared allowance: Kids');
  const leoRole = page.querySelector(`[data-je-focus="household:role:${pid(1)}"]`);
  assert.equal(leoRole.value, 'trusted');
  assert.ok([...page.querySelector('[data-je-focus="household:default-role"]').options].some(o => o.value === 'trusted' && o.textContent === 'Trusted'));
  assert.equal(page.querySelector('[data-je-focus="household:role-limit:trusted"]'), null, 'Trusted has no limit');
  edit(h, page.querySelector(`[data-je-focus="household:role:${pid(2)}"]`), 'trusted');
  edit(h, page.querySelector('[data-je-focus="household:default-role"]'), 'trusted');
  page.querySelector('[data-je-focus="household:save"]').click();
  page.querySelector('[data-je-focus="household:confirm"]').click();
  await until(() => posted !== null);
  assert.deepEqual(posted, { defaultRole: 'trusted', users: { [pid(2)]: { role: 'trusted', quotaLimit: null } } });
});

test('the conditions editor: edits per role, streaming services and shared allowances; Save confirms and sends only what changed', async t => {
  const posts = [];
  let reads = 0;
  const h = setupHub(t, {
    hash: '#/requests?tab=household',
    me: { role: 'admin' },
    routes: (method, path, body) => {
      if (path === '/acquire/household') return household([person(1, { name: 'Leo' }), person(2, { name: 'Jake', role: 'admin', admin: { jellyfinAdmin: true } })], settings({ rules: RULES_ON }));
      if (path === '/acquire/household/streaming-services?country=GB') return { status: 200, body: { country: 'GB', services: [{ id: 8, name: 'Netflix' }, { id: 9, name: 'Prime Video' }] } };
      if (path !== '/acquire/household/rules') return null;
      if (method === 'POST') { posts.push(body); return saved; }
      reads++;
      return rulesBody();
    }
  });
  h.JE.initializeArrStatus();
  const page = h.page();
  await until(() => page.querySelector('.je-rules .je-rules-role'));
  const q = focus => page.querySelector(`[data-je-focus="${focus}"]`);
  // One disclosure per ruled role; Kid's is open (a condition does something) and says so.
  assert.deepEqual([...page.querySelectorAll('.je-rules-role-summary')].map(s => s.textContent), ['Kid · 1 on', 'Member · no conditions', 'Trusted · no conditions']);
  assert.equal(page.querySelector('.je-rules-role[data-role="kid"]').open, true);
  assert.equal(q('rules:kid:rating:max').value, 'PG');
  assert.equal(q('rules:kid:rating:otherwise').value, 'review');
  assert.deepEqual([...q('rules:kid:rating:match').options].map(o => o.textContent), ['Nothing (the usual rules)', 'Goes ahead without an OK', 'Waits for an OK', 'Refused']);
  assert.equal(q('rules:kid:rating:match').getAttribute('aria-label'), 'Kid, Rating: When it matches');
  // The pool shows its use in the window; only non-administrators can be picked.
  assert.equal(page.querySelector('.je-rules-pool .je-rules-pool-use').textContent, '3 of 7 used in the last 7 days');
  assert.ok(q('rules:pool:kids:role:kid').checked);
  assert.ok(q(`rules:pool:kids:user:${pid(1)}`));
  assert.equal(q(`rules:pool:kids:user:${pid(2)}`), null);
  assert.equal(page.querySelector('.je-rules-save'), null);

  // Member: refuse Horror.
  tick(h, q('rules:member:genre:g27'), true);
  edit(h, q('rules:member:genre:match'), 'deny');
  // Focus stays on the select across the redraw.
  assert.equal(h.document.activeElement.dataset.jeFocus, 'rules:member:genre:match');
  // Streaming: country, load the services, pick one.
  edit(h, q('rules:streaming:country'), 'gb');
  q('rules:streaming:load').click();
  await until(() => q('rules:streaming:s8'));
  tick(h, q('rules:streaming:s8'), true);
  // Pools: add one for Members, move it first, rename the old one.
  q('rules:pool:add').click();
  const added = [...page.querySelectorAll('.je-rules-pool')].map(p => p.dataset.poolId).find(id => id !== 'kids');
  assert.match(added, /^pool-[a-z0-9]+$/);
  assert.equal(h.document.activeElement.dataset.jeFocus, `rules:pool:${added}:name`, 'focus moves to the new pool');
  assert.equal(page.querySelector(`[data-pool-id="${added}"] .je-rules-pool-use`).textContent, 'New: nothing used yet');
  tick(h, q(`rules:pool:${added}:role:member`), true);
  edit(h, q(`rules:pool:${added}:limit`), '12');
  q(`rules:pool:${added}:up`).click();
  assert.deepEqual([...page.querySelectorAll('.je-rules-pool')].map(p => p.dataset.poolId), [added, 'kids']);
  edit(h, q('rules:pool:kids:name'), 'Little ones');

  q('rules:save').click();
  assert.equal(page.querySelector('.je-rules-save .je-household-confirm').textContent, translate('arr_rules_confirm'));
  assert.equal(posts.length, 0, 'nothing is sent before the confirmation');
  q('rules:confirm').click();
  await until(() => posts.length === 1);
  assert.deepEqual(posts[0], {
    rules: { roles: {
      kid: { rating: { match: 'none', otherwise: 'review', max: 'PG', country: 'US' } },
      member: { genre: { match: 'deny', otherwise: 'none', ids: [27] } }
    } },
    streamingCountry: 'GB',
    streamingServices: [8],
    pools: [
      { id: added, name: 'Shared allowance 2', limit: 12, roles: ['member'], users: [] },
      { id: 'kids', name: 'Little ones', limit: 7, roles: ['kid'], users: [] }
    ]
  });
  await until(() => reads === 2);
  await until(() => page.querySelector('.je-rules-save .je-approval-result'));
  assert.equal(page.querySelector('.je-rules-save .je-approval-result').textContent, 'Saved.');
});

test('the conditions editor sends one changed part alone, refuses an incomplete condition before sending, and says a server refusal plainly', async t => {
  const posts = [];
  let answer = saved;
  const h = setupHub(t, {
    hash: '#/requests?tab=household',
    me: { role: 'admin' },
    routes: (method, path, body) => {
      if (path === '/acquire/household') return household([person(1)], settings({ rules: RULES_ON }));
      if (path !== '/acquire/household/rules') return null;
      if (method === 'POST') { posts.push(body); return answer; }
      return rulesBody({ poolsEnabled: false, pools: [] });
    }
  });
  h.JE.initializeArrStatus();
  const page = h.page();
  await until(() => page.querySelector('.je-rules .je-rules-role'));
  const q = focus => page.querySelector(`[data-je-focus="${focus}"]`);
  assert.equal(page.querySelector('.je-rules-pools'), null, 'no pools editor while group quotas are off');
  // A language condition that does something without a code: said before anything is sent.
  edit(h, q('rules:trusted:language:otherwise'), 'review');
  q('rules:save').click();
  q('rules:confirm').click();
  assert.equal(page.querySelector('.je-rules-save .je-approval-result').textContent, translate('arr_rules_invalid_language'));
  assert.equal(posts.length, 0);
  // Back as served: only the streaming country changes.
  edit(h, q('rules:trusted:language:otherwise'), 'none');
  assert.equal(page.querySelector('.je-rules-save [data-je-focus="rules:save"]'), null, 'no edits left');
  edit(h, q('rules:streaming:country'), 'us');
  answer = { status: 409, body: { outcome: 'denied', reason: 'rules_seerr_owned', certainty: 'Rejected' } };
  q('rules:save').click();
  q('rules:confirm').click();
  await until(() => posts.length === 1);
  assert.deepEqual(posts[0], { streamingCountry: 'US' });
  await until(() => page.querySelector('.je-rules-save .je-approval-result'));
  assert.equal(page.querySelector('.je-rules-save .je-approval-result').textContent, `${translate('arr_rules_save_seerr')} (rules_seerr_owned)`);
  assert.ok(q('rules:save'), 'the edits stay to fix or undo');
  // A country TMDB can't be asked about.
  edit(h, q('rules:streaming:country'), 'x');
  q('rules:streaming:load').click();
  assert.equal(page.querySelector('.je-rules-streaming .je-hub-note').textContent, translate('arr_rules_streaming_invalid_country'));
  q('rules:discard').click();
  assert.equal(q('rules:streaming:country').value, '');
});

test('Seerr mode: Seerr\'s own rules read-only (override rules summarized, unknown parts said), no controls', async t => {
  const seerr = {
    available: true, autoApprove: false, movieQuota: { limit: 5, days: 7 }, tvQuota: null,
    overrideRules: [{ id: 1, genre: '27,35', language: 'fr', users: '2', keywords: '', profileId: 4, rootFolder: '<img src=x onerror=alert(1)>', radarrServiceId: 0 }, { id: 2 }]
  };
  let body = rulesBody({ backend: 'seerr', editable: false, conditions: false, poolsEnabled: false, seerr });
  const h = setupHub(t, {
    hash: '#/requests?tab=household',
    me: { role: 'admin' },
    routes: (m, path) => (path === '/acquire/household' ? household([person(1)], settings({ backend: 'seerr', rules: { trusted: true, conditions: false, pools: false } }))
      : path === '/acquire/household/rules' ? body : null)
  });
  h.JE.initializeArrStatus();
  const page = h.page();
  await until(() => page.querySelector('.je-rules-seerr'));
  const panel = page.querySelector('.je-rules-seerr');
  const text = panel.textContent;
  assert.ok(text.includes(translate('arr_rules_seerr_intro')));
  assert.ok(text.includes('New users\' requests approved automatically: No'));
  assert.ok(text.includes('Default movie quota: 5 every 7 days'));
  assert.ok(text.includes('Default series quota: Not known'));
  const rules = [...panel.querySelectorAll('.je-rules-seerr-rule')].map(r => r.textContent);
  assert.match(rules[0], /Applies to: genres Horror, Comedy · languages French · users 2/);
  assert.match(rules[0], /Sets: Radarr server 0 · quality profile 4 · folder <img src=x onerror=alert\(1\)>/);
  assert.match(rules[1], /Applies to every request.*Sets nothing/);
  assert.equal(panel.querySelector('img'), null, 'Seerr\'s values are text');
  assert.equal(page.querySelectorAll('.je-rules input, .je-rules select').length, 0);
  // Seerr can't describe its rules: not known.
  body = rulesBody({ backend: 'seerr', editable: false, seerr: { ...seerr, overrideRules: null, autoApprove: null } });
  h.JE.internals.arrHub.rules.load();
  await until(() => page.querySelector('.je-rules-seerr')?.textContent.includes(translate('arr_rules_seerr_overrides_unknown')));
  assert.ok(page.querySelector('.je-rules-seerr').textContent.includes('approved automatically: Not known'));
});

test('status-only handling: the section says conditions apply only with Jellyfin Enhanced handling requests', async t => {
  const h = setupHub(t, {
    hash: '#/requests?tab=household',
    me: { role: 'admin' },
    routes: (m, path) => (path === '/acquire/household' ? household([person(1)], settings({ backend: 'status_only', rules: { trusted: true, conditions: false, pools: false } }))
      : path === '/acquire/household/rules' ? rulesBody({ backend: 'status_only', editable: false, seerr: null }) : null)
  });
  h.JE.initializeArrStatus();
  const page = h.page();
  await until(() => page.querySelector('.je-rules .je-household-help'));
  assert.equal(page.querySelector('.je-rules .je-household-help').textContent, translate('arr_rules_not_applied'));
});

test('Approvals cards say what the household rules found, a Trusted requester and their shared allowance', async t => {
  const card = (n, over) => ({
    id: String(n).padStart(32, 'a'), key: `movie:tmdb:${n}`, kind: 'movie', scope: 'movie', variant: 'standard', seasons: [], episodes: [], createdAt: new Date().toISOString(),
    reason: 'awaiting_approval', overQuota: false, stuck: false, cost: 1, title: `Film ${n}`, year: 2026, requester: { name: 'Leo', role: 'kid', quota: { used: 1, limit: 7, available: true } },
    alsoWanted: [], canApprove: true, canSwitchVariant: false, ...over
  });
  const h = setupHub(t, {
    hash: '#/requests?tab=approvals',
    routes: (m, path) => (path === '/acquire/requests/approvals' ? { status: 200, body: { outcome: 'accepted', reason: 'approvals', certainty: 'Succeeded', more: false, items: [
      card(1, {
        reason: 'rule_review',
        rules: { verdict: 'review', rules: 'v', facts: 'f', hits: [
          { condition: 'rating', action: 'review', matched: false, value: 'R', limit: 'PG-13' },
          { condition: 'language', action: 'review', matched: null, value: null, limit: 'en' },
          { condition: 'size', action: 'approve', matched: true, value: '7.6', limit: '40' }
        ] },
        requester: { name: 'Leo', role: 'kid', quota: { used: 1, limit: 7, available: true }, pool: { name: 'Kids', used: 7, limit: 7, remaining: 0, nextSlotAt: '2026-10-21T08:00:00Z' } }
      }),
      card(2, { reason: 'group_quota', requester: { name: 'Mia', role: 'trusted', quota: { used: 2, limit: null, available: true }, pool: { name: 'Everyone', used: 3, limit: 10, remaining: 7 } } }),
      card(3, { reason: 'household_rule', status: 'pending', stuck: true, rules: { verdict: 'deny', hits: [{ condition: 'genre', action: 'deny', matched: true, value: '27', limit: '27,53' }] } }),
      // A Kid's request the rules would have let go ahead still waits: that verdict didn't decide it.
      card(4, { rules: { verdict: 'approve', hits: [{ condition: 'streaming', action: 'approve', matched: true, value: 'Netflix', limit: 'GB' }] } })
    ] } } : null)
  });
  h.JE.initializeArrStatus();
  const page = h.page();
  await until(() => page.querySelectorAll('.je-approval').length === 4);
  const [one, two, three, four] = page.querySelectorAll('.je-approval');
  assert.equal(four.querySelector('.je-rules-why'), null);
  assert.deepEqual([...one.querySelectorAll('.je-rules-why-line')].map(l => l.textContent), ['visibilityNeeds a look: rated R (limit PG-13)', 'helpNot known: original language']);
  assert.ok([...one.querySelectorAll('.je-approval-chip')].some(c => c.textContent === 'ruleRules want a look'));
  assert.match(one.querySelector('.je-approval-pool').textContent, /^Kids: 7 of 7 used \(shared\) · next frees up /);
  assert.equal(two.querySelector('.je-approval-role').textContent, 'Trusted · 2 used · no limit');
  assert.equal(two.querySelector('.je-approval-pool').textContent, 'Everyone: 3 of 10 used (shared)');
  assert.ok([...two.querySelectorAll('.je-approval-chip')].some(c => c.textContent === 'data_usageShared allowance used up'));
  assert.equal(two.querySelector('.je-rules-why'), null);
  assert.equal(three.querySelector('.je-rules-why-line').textContent, "blockRefused by the household's rules: genre Horror");
  assert.ok([...three.querySelectorAll('.je-approval-chip')].some(c => c.textContent === 'blockRules now refuse it'));
});

test('My requests says why a request waits (household rules, shared allowance) and what the rules said', async t => {
  const own = (n, over) => ({
    id: String(n).padStart(32, 'd'), key: `movie:tmdb:${n}`, kind: 'movie', scope: 'movie', variant: 'standard', seasons: [], episodes: [],
    status: 'pending', reason: 'awaiting_approval', group: 'needsOk', createdAt: new Date(Date.now() - n * 60000).toISOString(), canCancel: true,
    title: `Own ${n}`, year: 2026, ...over
  });
  const h = setupHub(t, {
    me: { role: 'member', contact: 'Dad' },
    routes: (m, path) => (path === '/acquire/requests/mine' ? { status: 200, body: { outcome: 'accepted', reason: 'mine', certainty: 'Succeeded', items: [
      own(1, { reason: 'rule_review', rules: { verdict: 'review', hits: [{ condition: 'size', action: 'review', matched: false, value: '61.2', limit: '40' }] } }),
      own(2, { reason: 'group_quota' }),
      own(3, { status: 'queued', group: 'onTheWay', reason: 'queued_outage', canCancel: false, rules: { verdict: 'approve', hits: [{ condition: 'streaming', action: 'approve', matched: true, value: 'Netflix', limit: 'GB' }] } }),
      own(4),
      own(5, { rules: { verdict: 'approve', hits: [{ condition: 'streaming', action: 'approve', matched: true, value: 'Netflix', limit: 'GB' }] } })
    ] } } : null)
  });
  h.JE.initializeArrStatus();
  const page = h.page();
  await until(() => page.querySelectorAll('.je-hub-row').length === 5);
  const row = n => page.querySelector(`.je-hub-row[data-je-arr-key="movie:tmdb:${n}"]`);
  assert.deepEqual([...row(1).querySelectorAll('.je-rules-why .je-approval-line')].map(l => l.textContent),
    ["ruleWaiting for an OK: the household's rules want a look.", 'visibilityNeeds a look: about 61.2 GB, over the 40 GB limit']);
  assert.equal(row(2).querySelector('.je-rules-why').textContent, 'data_usageWaiting for an OK: the shared allowance is used up.');
  assert.equal(row(3).querySelector('.je-rules-why').textContent, "check_circleApproved by the household's rules: streams on Netflix");
  assert.equal(row(4).querySelector('.je-rules-why'), null);
  assert.equal(row(5).querySelector('.je-rules-why'), null, 'a go-ahead verdict on a request that still waits says nothing');
});

test('the request controls: a rule refusal and a rule or shared-allowance wait say why; the allowance carries the pool', async t => {
  const h = setupHub(t, {
    me: { role: 'kid', contact: 'Dad' },
    routes: (method, path) => {
      if (path === '/acquire/requests/quota?mediaType=movie') return { status: 200, body: { quota: { used: 1, limit: 5, remaining: 4 }, pool: { name: 'Kids', used: 7, limit: 7, remaining: 0 } } };
      if (path === '/acquire/requests' && method === 'POST') {
        return { status: 403, body: { outcome: 'denied', reason: 'household_rule', certainty: 'Rejected', rules: { verdict: 'deny', hits: [{ condition: 'genre', action: 'deny', matched: true, value: '27', limit: '27' }] } } };
      }
      return null;
    }
  });
  const A = h.JE.arrAsk;
  const caps = { contact: 'Dad' };
  const refused = A.interpret(403, { outcome: 'denied', reason: 'household_rule', rules: { verdict: 'deny', hits: [{ condition: 'rating', action: 'deny', matched: false, value: 'R', limit: 'PG-13' }] } });
  assert.equal(refused.state, 'ruled');
  assert.equal(A.describe(refused, caps).text, "The household's rules don't allow this one (rated R (limit PG-13)).");
  assert.equal(A.describe(refused, caps).chip, '');
  assert.equal(A.describe(A.interpret(403, { outcome: 'denied', reason: 'household_rule' }), caps).text, "The household's rules don't allow this one.");
  const review = A.interpret(201, { outcome: 'accepted', reason: 'rule_review', rules: { verdict: 'review', hits: [{ condition: 'rating', action: 'review', matched: null }] } });
  assert.equal(review.state, 'waiting');
  assert.equal(A.describe(review, caps).text, "Sent to Dad for an OK: the household's rules want a look (rating not known).");
  assert.equal(A.describe(review, caps).chip, 'Waiting for OK');
  const pool = A.interpret(201, { outcome: 'accepted', reason: 'group_quota' });
  assert.equal(pool.state, 'waiting');
  assert.equal(A.describe(pool, caps).text, 'Sent to Dad for an OK: the shared allowance is used up.');
  assert.deepEqual(JSON.parse(JSON.stringify(await A.quota('movie'))), { used: 1, limit: 5, remaining: 4, pool: { name: 'Kids', used: 7, limit: 7, remaining: 0 } });
  // A real ask through the client: the refusal and its verdict come back together.
  const result = await A.ask(A.movieInput('movie:tmdb:9'));
  assert.equal(result.state, 'ruled');
  assert.equal(A.describe(result, caps).text, "The household's rules don't allow this one (genre Horror).");
});

test('TV layout: the conditions editor is real focusable controls with 48 px targets; phones get 44 px and full-width fields', async t => {
  const h = setupHub(t, {
    hash: '#/requests?tab=household',
    me: { role: 'admin' },
    layoutTv: true,
    routes: (m, path) => (path === '/acquire/household' ? household([person(1)], settings({ rules: RULES_ON })) : path === '/acquire/household/rules' ? rulesBody() : null)
  });
  h.JE.initializeArrStatus();
  const page = h.page();
  await until(() => page.querySelector('.je-rules .je-rules-role'));
  const controls = [...page.querySelectorAll('.je-rules input, .je-rules select, .je-rules button, .je-rules summary')];
  assert.ok(controls.length > 40);
  for (const c of controls) assert.ok(c.dataset.jeFocus, `${c.outerHTML.slice(0, 80)} has a focus id`);
  assert.ok(controls.every(c => !c.disabled), 'nothing disabled (D-pad focus stays)');
  const css = h.document.getElementById('je-arr-rules-styles').textContent;
  assert.match(css, /\.layout-tv \.je-rules-input, \.layout-tv \.je-rules-check[^{]*\{ min-height: 48px/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*min-height: 44px/);
});

test('a household change re-reads clean conditions, keeps edited ones (saying they changed), and Undo reads the latest', async t => {
  let reads = 0;
  const h = setupHub(t, {
    hash: '#/requests?tab=household',
    me: { role: 'admin' },
    routes: (method, path) => {
      if (path === '/acquire/household') return household([person(1)], settings({ rules: RULES_ON }));
      if (path !== '/acquire/household/rules') return null;
      reads++;
      return rulesBody({ streamingCountry: reads > 1 ? 'GB' : '' });
    }
  });
  h.JE.initializeArrStatus();
  const page = h.page();
  await until(() => page.querySelector('.je-rules .je-rules-role'));
  const q = focus => page.querySelector(`[data-je-focus="${focus}"]`);
  h.bump('req:state');
  await until(() => reads === 2);
  await until(() => q('rules:streaming:country')?.value === 'GB');
  edit(h, q('rules:kid:size:gb'), '30');
  edit(h, q('rules:kid:size:match'), 'approve');
  h.bump('req:state');
  await until(() => page.querySelector('.je-rules .je-hub-note-warn'));
  assert.equal(page.querySelector('.je-rules .je-hub-note-warn').textContent, translate('arr_rules_changed'));
  assert.equal(reads, 2, 'edits are never thrown away by a re-read');
  assert.equal(q('rules:kid:size:gb').value, '30');
  q('rules:discard').click();
  await until(() => reads === 3);
  await until(() => !page.querySelector('.je-rules .je-hub-note-warn'));
  assert.equal(q('rules:kid:size:match').value, 'none');
});
