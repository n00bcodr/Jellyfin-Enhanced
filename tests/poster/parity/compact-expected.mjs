// Literal codec expectations exercise the production compact formatter on both sides.
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createHarness } from '../../frontend/helpers/harness.mjs';
const cases = JSON.parse(readFileSync(new URL('../../fixtures/quality-compact.json', import.meta.url)));
const h = createHarness();
h.load('core/tag-layout.js');
for (const [full, compact] of cases) assert.equal(h.JE.core.tagLayout.compactQualityLabel(full), compact, full);
h.close();
writeFileSync(new URL('data/compact-expected.json', import.meta.url), JSON.stringify(cases));
