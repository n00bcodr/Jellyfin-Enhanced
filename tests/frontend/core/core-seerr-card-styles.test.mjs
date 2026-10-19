import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

// Seerr discovery cards are 95-105 px wide on phones: their bottom rows must fit the card. Layout itself is
// measured in the browser (owner live check, 360 and 390 px); here the phone-width rules are pinned.

function phoneRules(t) {
  const h = createHarness();
  t.after(() => h.close());
  h.load('jellyseerr/ui/ui-styles.js');
  const sheet = h.document.getElementById('jellyseerr-styles').sheet;
  const rules = [];
  for (const rule of sheet.cssRules) {
    if (rule.media && /max-width:\s*480px/.test(rule.media.mediaText)) rules.push(...rule.cssRules);
  }
  return selector => rules.filter(r => r.selectorText === selector).map(r => name => r.style.getPropertyValue(name));
}

test('on phones the Seerr icon, year and rating row of a discovery card closes up to fit the card', t => {
  const rules = phoneRules(t);
  const meta = rules('.jellyseerr-meta');
  assert.ok(meta.some(s => s('gap') === '.35em' && s('padding') === '0'), 'a smaller gap and no side padding');
  assert.ok(rules('.jellyseerr-meta .jellyseerr-rating').some(s => s('gap') === '.15em'));
});

test('on phones the provider icons shrink to fit their card instead of spilling out of both sides', t => {
  const rules = phoneRules(t);
  assert.ok(rules('.jellyseerr-elsewhere-icons').some(s => s('gap') === '.3em'));
  const icons = rules('.jellyseerr-elsewhere-icons img');
  assert.ok(icons.some(s => s('min-width') === '0'), 'an icon may get narrower than its picture');
  assert.ok(icons.some(s => s('flex') === '0 1 1.8em'), 'and shrinks with the row');
});
