import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './lp-harness.mjs';

// Review round 1, track d1 (F29): the per-user fetch limit of POST /source/fetch has its own message, not the
// "the list site is limiting requests" one.
test('a per-user fetch limit (fetch_limited) is explained as such', t => {
  const h = setup(t, { plugin: async () => ({}) });
  const imp = h.lp.importer;
  assert.equal(imp.sourceErrorKey('fetch_limited'), 'listPlaceholders_import_err_fetch_limited');
  const error = { status: 429, responseJSON: { code: 'fetch_limited', message: 'server text' } };
  assert.equal(imp.sourceErrorText(error), h.JE.t('listPlaceholders_import_err_fetch_limited'));
  assert.notEqual(imp.sourceErrorText(error), h.JE.t('listPlaceholders_import_err_rate_limited'));
});
