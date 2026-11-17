// The Leaving soon card's "Copy KefinTweaks section" button (upstream 6c922d10) and its linked copy on the Services tab
// (whose click the engine forwards to the card's button): a click copies a KefinTweaks custom home section that reads
// GET /JellyfinEnhanced/leaving-soon/items, through the clipboard API or, without it, a hidden text area. Driven
// through the generated page, as the dashboard runs it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootGenerated, settle } from '../../helpers/admin-config-page.mjs';

const CARD = 'leavingSoonCopyKefinBtn';
const COPY = 'leavingSoonCopyKefinBtn--mirror';
const SECTION = {
  id: 'leaving-soon', type: 'home', name: 'Leaving Soon', enabled: true, order: 72, cardFormat: 'Poster', userConfigurable: true,
  queries: [{ path: '/JellyfinEnhanced/leaving-soon/items', queryOptions: { Limit: 20 } }],
};

async function boot(t, clipboard) {
  const h = bootGenerated({ saved: {} });
  t.after(() => h.close());
  await h.ready();
  h.show();
  await settle(h.window);
  Object.defineProperty(h.window.navigator, 'clipboard', { configurable: true, value: clipboard });
  const label = id => h.document.getElementById(id)?.querySelector('span')?.textContent;
  return { h, label };
}

test('Leaving soon: the card and its Services tab copy each copy the KefinTweaks section that reads leaving-soon/items', async t => {
  const copied = [];
  const { h, label } = await boot(t, { writeText: async text => { copied.push(text); } });
  assert.equal(label(CARD), 'Copy KefinTweaks section');
  assert.equal(label(COPY), 'Copy KefinTweaks section');
  for (const id of [CARD, COPY]) {
    h.document.getElementById(id).click();
    await settle(h.window);
    assert.equal(label(CARD), 'Copied', id);
  }
  assert.equal(copied.length, 2, 'one copy per click');
  for (const text of copied) assert.deepEqual(JSON.parse(text), SECTION);
});

test('Leaving soon: without the clipboard API the section goes through a hidden text area, and a refused copy says so', async t => {
  const { h, label } = await boot(t, undefined);
  const areas = () => h.document.querySelectorAll('textarea').length;
  const before = areas();
  const seen = [];
  let allowed = true;
  h.document.execCommand = command => {
    const area = h.document.body.lastElementChild;
    seen.push([command, area?.tagName, area?.value]);
    return allowed;
  };
  h.document.getElementById(CARD).click();
  await settle(h.window);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], 'copy');
  assert.equal(seen[0][1], 'TEXTAREA');
  assert.deepEqual(JSON.parse(seen[0][2]), SECTION);
  assert.equal(label(CARD), 'Copied');
  assert.equal(areas(), before, 'the text area is removed again');

  allowed = false;
  h.document.getElementById(COPY).click();
  await settle(h.window);
  assert.equal(label(CARD), 'Copy failed');
});
