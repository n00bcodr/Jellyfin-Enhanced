// Upstream 1952fa31 on the generated configuration page: the sidebar hides the link to a group its card hides (main
// toggle off, or a showIf condition false), and the settings search waits for 3 characters and 300 ms of quiet.
// The page runs as the host runs it (bootGenerated): engine, sections, page script.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootGenerated, config, settle } from '../../helpers/admin-config-page.mjs';

const tabButton = (document, id) => document.querySelector(`.jea-nav .jellyfin-tab-button[data-tab="${id}"]`);
/** The group links under one card of a tab's sidebar tree, by text, with whether each is hidden. */
function groupLinks(document, tab, card) {
  const leaf = [...tabButton(document, tab).nextElementSibling.querySelectorAll(':scope > .jea-nav-leaf')].find(a => a.textContent === card);
  assert.ok(leaf, `${tab} › ${card} is in the sidebar`);
  const sub = leaf.nextElementSibling;
  assert.ok(sub?.classList.contains('jea-nav-subtree'), `${card} lists its groups`);
  return Object.fromEntries([...sub.querySelectorAll('.jea-nav-sub')].map(a => [a.textContent, a.hidden]));
}
async function flip(h, id, on) {
  const control = h.document.getElementById(id);
  control.checked = on;
  control.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await settle(h.window);
}
async function loaded() {
  const h = bootGenerated();
  await h.ready();
  h.show();
  for (let i = 0; i < 200 && !h.calls.gets; i++) await new Promise(r => setTimeout(r, 5));
  await settle(h.window);
  return h;
}

test('a card whose main toggle is off hides its group links in the sidebar, and shows them again when it is on', async t => {
  const h = await loaded();
  t.after(h.close);
  await flip(h, 'spoilerBlurEnabled', true);
  const shown = groupLinks(h.document, 'display', 'Spoiler Guard');
  assert.ok(Object.keys(shown).length >= 2);
  assert.ok(Object.values(shown).every(hidden => hidden === false), JSON.stringify(shown));
  await flip(h, 'spoilerBlurEnabled', false);
  const off = groupLinks(h.document, 'display', 'Spoiler Guard');
  assert.ok(Object.values(off).every(hidden => hidden === true), JSON.stringify(off));
  await flip(h, 'spoilerBlurEnabled', true);
  assert.deepEqual(groupLinks(h.document, 'display', 'Spoiler Guard'), shown);
});

test('a group hidden by its showIf condition loses its sidebar link; the other groups of the card keep theirs', async t => {
  const h = await loaded();
  t.after(h.close);
  await flip(h, 'maintenanceModeEnabled', false);
  assert.deepEqual(groupLinks(h.document, 'admin', 'Maintenance Mode'),
    { Messages: true, Action: true, 'Affected users': false, 'Daily schedule': false });
  await flip(h, 'maintenanceModeEnabled', true);
  assert.deepEqual(groupLinks(h.document, 'admin', 'Maintenance Mode'),
    { Messages: false, Action: false, 'Affected users': false, 'Daily schedule': false });
});

test('the search starts at 3 characters, 300 ms after the last keystroke', async t => {
  const h = bootGenerated();
  t.after(h.close);
  await h.ready();
  const { document, window } = h;
  const delays = [];
  const original = window.setTimeout;
  window.setTimeout = (fn, ms, ...rest) => { delays.push(ms); return original.call(window, fn, ms, ...rest); };
  const input = document.getElementById('settingsSearchInput');
  const form = document.getElementById('JellyfinEnhancedForm');
  const count = document.getElementById('settingsSearchCount');
  const type = async value => {
    delays.length = 0;
    input.value = value;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    const debounce = delays[0];
    await new Promise(r => setTimeout(r, debounce + 100));
    await settle(window);
    return debounce;
  };
  assert.equal(await type('re'), 300);
  assert.equal(form.classList.contains('je-search-mode'), false, 'two letters match most of the page: no search');
  assert.equal(count.textContent, 'Type 3+ characters to search');
  assert.equal(form.querySelectorAll('.je-search-match').length, 0);
  assert.equal(await type('ret'), 300);
  assert.equal(form.classList.contains('je-search-mode'), true);
  assert.ok(form.querySelectorAll('.je-search-match').length > 0);
  await type('re');
  assert.equal(form.classList.contains('je-search-mode'), false, 'back to two letters: the search ends');
  assert.equal(form.querySelectorAll('.je-search-match').length, 0);
});

test('the stylesheet hides a hidden sidebar link, spaces the cards in search mode, and lets a New badge wrap on a phone', () => {
  const css = readFileSync(join(config, 'jeAdmin.css'), 'utf8');
  // .jea-nav-leaf is display: block, which would show it despite the hidden attribute without this rule.
  assert.match(css, /\.jea-nav-leaf\[hidden\]\s*\{\s*display:\s*none;?\s*\}/);
  assert.match(css, /#JellyfinEnhancedForm\.je-search-mode\s*>\s*\.jellyfin-tab-content\s*>\s*fieldset\s*\{\s*margin:\s*0 0 20px !important;?\s*\}/);
  const phone = /@media \(max-width: 600px\)\s*\{([^}]*\}[^}]*\}[^}]*\})\s*\}/.exec(css.slice(css.indexOf('.je-new-badge .material-icons')));
  assert.ok(phone, 'a phone-width block after the badge rules');
  assert.match(phone[1], /\.jea-toggle\s*\{\s*flex-wrap:\s*wrap;\s*\}/);
  assert.match(phone[1], /\.jea-toggle > \.je-new-badge\s*\{[^}]*margin-left:\s*0/);
});
