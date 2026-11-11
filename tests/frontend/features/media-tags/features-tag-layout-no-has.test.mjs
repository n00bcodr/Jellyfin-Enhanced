import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../../helpers/harness.mjs';

// jellyfin-web 12.4 draws a card's played / unplayed-count indicator inside .cardContent, not beside JE's tag host,
// so only `.cardScalable:has(.countIndicator, .playedIndicator)` tells the stylesheet to move top-right tags below
// it. A browser without :has() (Chrome before 105, Firefox before 121) drops every rule whose selector list holds
// one, and its tags then sit on the indicator.

/** The layout stylesheet, as the tag runtime injects it. */
function layoutStylesheet(t) {
  const h = createHarness({ JE: { currentSettings: {}, pluginConfig: {}, t: k => k } });
  t.after(() => h.close());
  for (const file of ['core/ui-kit.js', 'core/media-language.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'core/tag-look.js', 'tags/tag-layout-styles.js']) h.load(file);
  return h.JE.core.tagLayout.buildStyles();
}

/** Style rules as [conditions, selector, declarations], conditions being the enclosing at-rule preludes. */
function rules(css, conditions = []) {
  const out = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const prelude = css.slice(i, open).trim();
    let depth = 1, j = open + 1;
    for (; j < css.length && depth; j++) depth += css[j] === '{' ? 1 : css[j] === '}' ? -1 : 0;
    const body = css.slice(open + 1, j - 1);
    if (prelude.startsWith('@')) out.push(...rules(body, [...conditions, prelude]));
    else out.push([conditions, prelude.replace(/\s+/g, ' '), body.replace(/\s+/g, ' ').trim()]);
    i = j;
  }
  return out;
}

/** What a browser without :has() applies: rules without it in their selector, including the no-:has() blocks. */
const withoutHas = all => all.filter(([conditions, selector]) => !selector.includes(':has(')
  && conditions.every(c => !c.startsWith('@supports') || c === '@supports not selector(:has(*))'));

test('without :has(), top-right tags still leave the played indicator room on every card', t => {
  const all = rules(layoutStylesheet(t).replace(/\/\*[\s\S]*?\*\//g, ''));
  const HAS_INDICATOR = '.cardScalable:has(.countIndicator, .playedIndicator) > .je-tag-host';
  const room = all.filter(([, selector]) => selector.startsWith(HAS_INDICATOR));
  assert.ok(room.length >= 5, `the indicator rules were found (${room.length})`);
  const old = withoutHas(all);
  for (const [conditions, selector, body] of room) {
    const media = conditions.filter(c => c.startsWith('@media'));
    const fallback = selector.split(HAS_INDICATOR).join('.cardScalable > .je-tag-host');
    assert.ok(old.some(([c, s, b]) => s === fallback && b === body && c.filter(x => x.startsWith('@media')).join() === media.join()),
      `a browser without :has() keeps: ${fallback} { ${body} }`);
  }
  // A browser with :has() never reads them.
  for (const [conditions, selector] of all.filter(([, s]) => s.startsWith('.cardScalable > .je-tag-host')))
    assert.ok(conditions.includes('@supports not selector(:has(*))'), selector);
});
