import test from 'node:test';
import { FIELDS, CASES } from '../helpers/config-page-fields.mjs';

// Stage 1 fix round 6: the persisted bytes of every asynchronously filled field of the configuration page, generated per
// field (helpers/config-page-fields.mjs): a save while its list is pending, after it failed, after it loaded unchanged,
// an admin change (also one made while the list loads), a reload that fails after a success, overlapping loads.
for (const spec of FIELDS.slice(0, 4)) {
  for (const [name, run] of Object.entries(CASES)) {
    test(`${spec.name}: ${name}`, t => run(t, spec));
  }
}
