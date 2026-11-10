import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';
import { bootstrapFixture, contractValue, USER_A, USER_B } from './fixtures.mjs';

function parser(t) {
  const h = createHarness();
  t.after(() => h.close());
  h.load('contracts/bootstrap.js');
  return h.window.__JE_BOOTSTRAP_CONTRACT__.parseBootstrap;
}

for (const [name, mutate] of [
  ['missing user', p => { delete p.UserId; }],
  ['missing version', p => { delete p.Version; }],
  ['empty version', p => { p.Version = ' '; }],
  ['numeric user', p => { p.UserId = 123; }],
  ['invalid user', p => { p.UserId = 'not-a-guid'; }],
  ['other user', p => { p.UserId = USER_B; }],
  ['missing document envelope', p => { delete p.UserSettings; }],
  ['missing failed document', p => { delete p.UserSettings.Bookmark; }],
  ['bad nested bookmark', p => { p.UserSettings.Bookmark = { Bookmarks: { key: { Name: 'incomplete' } } }; }],
  ['missing delivery flag', p => { delete p.HasCustomTabs; }],
  ['coerced boolean', p => { p.HasCustomTabs = 'false'; }],
  ['malformed script list', p => { p.ComponentScripts = ['core/session.js', null]; }],
  ['admin-only private payload', p => { p.PrivateConfig = contractValue('BootstrapPrivateConfig'); }],
  ['forged admin document', p => { p.UserSettings.Settings = contractValue('BootstrapSettings', { IsAdmin: true }); }],
  ['private field smuggled into public projection', p => { p.PublicConfig.SonarrApiKey = 'secret'; }],
  ['non-JSON opaque extension', p => { p.Prefetched.SeerrUserStatus = { function: () => true }; }],
]) test(`bootstrap contract rejects ${name}`, t => {
  const parse = parser(t), payload = bootstrapFixture();
  mutate(payload);
  assert.throws(() => parse(payload, USER_A, false));
});

test('null failures and opaque cached JSON are preserved without coercion or defaults', t => {
  const parse = parser(t);
  const payload = bootstrapFixture({ Prefetched: { SeerrUserStatus: { arbitrary: ['value', 3, null, false] } } });
  assert.equal(parse(payload, USER_A.toUpperCase(), false), payload);
  assert.equal(parse(payload, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false), payload);
  assert.equal(payload.UserSettings.Settings, null);
  assert.equal(payload.UserSettings.Bookmark, null);
  assert.deepEqual(payload.Prefetched.SeerrUserStatus, { arbitrary: ['value', 3, null, false] });
});

test('private payload requires independently established administrator status', t => {
  const parse = parser(t);
  const payload = bootstrapFixture({ PrivateConfig: { SonarrUrl: 'private' }, UserSettings: { Settings: { IsAdmin: true } } });
  assert.throws(() => parse(payload, USER_A, false));
  assert.equal(parse(payload, USER_A, true), payload);
  payload.UserSettings.Settings.IsAdmin = false;
  assert.throws(() => parse(payload, USER_A, true));
});
