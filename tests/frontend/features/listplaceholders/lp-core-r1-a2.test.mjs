import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './lp-harness.mjs';

test('api: a reorder Jellyfin cannot make gets its own message instead of the generic one', t => {
  const h = setup(t);
  assert.equal(h.lp.errorMessage({ status: 409, responseJSON: { code: 'move_unsupported' } }), 'listPlaceholders_err_move_unsupported');
  assert.equal(h.lp.errorMessage({ status: 409, responseJSON: { code: 'move_mismatch' } }), 'listPlaceholders_err_changed');
});
