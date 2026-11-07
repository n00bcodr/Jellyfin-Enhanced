const { test, expect } = require('@playwright/test');
const s = require('./helpers/settings-surfaces.cjs');

// Standing guards (round 21): the settings surfaces offer every tag group the same common controls, as
// declared once in JE.core.tagSettingsMatrix (core/tag-renderer-base.js), with the declared reason shown
// where one does not apply; a disclosure opens only something with a control in it; every in-page link
// and data-je-goto target exists. Found in a demo review: Genre, People and Status opened an "Edit" that
// held only a description and a link.

/** The matrix and the English reasons, from the page. */
const matrixOf = (page) => page.evaluate(() => {
  const M = window.JellyfinEnhanced.core.tagSettingsMatrix;
  const offers = {};
  for (const surface of ['admin', 'hub', 'itemEditor']) for (const group of M.groups) for (const control of M.controls) {
    const value = M.offers(surface, group, control);
    offers[`${surface}/${group}/${control}`] = value === true ? true : window.JellyfinEnhanced.t(value);
  }
  return { groups: M.groups, controls: M.controls, offers };
});

/** Every disclosure on the page (except ones marked informational) controls something with a control in it. */
const emptyDisclosures = (page) => page.evaluate(() => {
  const interactive = 'input, select, textarea, button, a[href]';
  const empty = [];
  for (const opener of document.querySelectorAll('[aria-expanded][aria-controls]')) {
    // Help text and views (marked data-je-info) may open without a control; a control not offered yet is hidden.
    if (opener.closest('[data-je-info]') || opener.hasAttribute('data-je-info') || opener.hidden) continue;
    const region = document.getElementById(opener.getAttribute('aria-controls'));
    if (!region) { empty.push(`${opener.textContent.trim().slice(0, 40)}: controls a missing #${opener.getAttribute('aria-controls')}`); continue; }
    if (!region.querySelector(interactive)) empty.push(`${opener.getAttribute('aria-label') || opener.textContent.trim().slice(0, 40)}: opens nothing to change`);
  }
  for (const details of document.querySelectorAll('details')) {
    if (details.hasAttribute('data-je-info')) continue;
    const inside = Array.from(details.querySelectorAll(interactive)).filter((el) => !el.closest('summary'));
    if (!inside.length) empty.push(`details "${details.querySelector('summary')?.textContent.trim().slice(0, 40)}": opens nothing to change`);
  }
  return empty;
});

/** In-page links and data-je-goto targets that point nowhere. */
const deadLinks = (page, surface) => page.evaluate((surface) => {
  const dead = [];
  for (const a of document.querySelectorAll('a[href^="#"]')) {
    const href = a.getAttribute('href');
    if (href === '#' ? !a.hasAttribute('data-je-goto') : !document.getElementById(decodeURIComponent(href.slice(1))) && !href.startsWith('#/')) dead.push(`${a.textContent.trim().slice(0, 40)} → ${href}`);
  }
  for (const el of document.querySelectorAll('[data-je-goto]')) {
    const [tab, anchor] = el.dataset.jeGoto.split(':');
    const tabEl = document.querySelector(`[role="tab"][data-tab="${tab}"]`);
    if (!tabEl) { dead.push(`${el.textContent.trim().slice(0, 40)} → tab ${tab}`); continue; }
    if (!anchor) continue;
    const found = surface === 'admin'
      ? document.querySelector(`.je-ta-grow[data-group="${anchor}"], [data-je-anchor="${anchor}"]`)
      : document.querySelector(`.je-tge-row[data-group="${anchor}"]`);
    if (!found) dead.push(`${el.textContent.trim().slice(0, 40)} → ${el.dataset.jeGoto}`);
  }
  return dead;
}, surface);

test('admin page: every group offers the matrix controls, Edit only with settings inside, no dead links or empty disclosures', async ({ page }) => {
  test.setTimeout(90000);
  await s.adminPage(page);
  const M = await matrixOf(page);
  const failures = [];
  // Every tab's panel and every row's region are in the page from the start (hidden until opened).
  failures.push(...await emptyDisclosures(page));
  failures.push(...await deadLinks(page, 'admin'));
  const rows = await page.$$eval('.je-ta-grow[data-group]', (rows) => rows.map((r) => ({
    group: r.dataset.group,
    enable: !!r.querySelector('.je-ta-grow-head input[type="checkbox"]'),
    placement: !!r.querySelector(`[data-je-goto="layout:placement-${r.dataset.group}"]`),
    scopes: r.querySelectorAll(`[data-je-scope-block="${r.dataset.group}"] input[type="checkbox"]`).length,
    text: r.textContent,
    edit: !!r.querySelector('.je-ta-expand'),
    inside: (r.querySelector('.je-ta-grow-body')?.querySelectorAll('input, select, textarea, button').length || 0),
  })));
  expect(rows.map((r) => r.group).sort()).toEqual([...M.groups].sort());
  for (const r of rows) {
    const offer = (control) => M.offers[`admin/${r.group}/${control}`];
    if (offer('enable') === true && !r.enable) failures.push(`${r.group}: no on/off switch`);
    // The admin page sets position and limit on Layout defaults: a group row links there.
    for (const control of ['position', 'limit']) {
      if (offer(control) === true ? !r.placement : !(r.text.includes(offer(control)) || r.placement)) failures.push(`${r.group}: ${control} ${offer(control) === true ? 'link missing' : 'reason missing'}`);
    }
    if (offer('scopes') === true ? r.scopes !== 6 : !r.text.includes(offer('scopes'))) failures.push(`${r.group}: Where to show ${offer('scopes') === true ? `has ${r.scopes} switches` : 'reason missing'}`);
    if (r.edit !== (r.inside > 0)) failures.push(`${r.group}: Edit ${r.edit ? 'opens no setting' : 'missing although it has settings'}`);
  }
  expect(failures).toEqual([]);
});

test('personal hub: every group offers the matrix controls, no dead links or empty disclosures', async ({ page }) => {
  test.setTimeout(90000);
  await s.hub(page);
  const M = await matrixOf(page);
  const failures = [];
  failures.push(...await emptyDisclosures(page));
  failures.push(...await deadLinks(page, 'hub'));
  const rows = await page.$$eval('.je-tge-row[data-group]', (rows) => rows.map((r) => ({
    group: r.dataset.group,
    enable: !!r.querySelector('input[type="checkbox"][id$="TagsToggle"]'),
    position: !!r.querySelector('.je-tge-pills input, .je-tge-pills button, .je-tge-pills select'),
    limit: !!r.querySelector('[data-je-cap-control]:not([hidden]) .je-tge-step'),
    limitNote: (r.querySelector('[data-je-cap-note]:not([hidden]) [data-je-limit-na]')?.textContent || ''),
    scopes: r.querySelectorAll(`[data-je-scope-block="${r.dataset.group}"] input[type="checkbox"]`).length,
    text: r.textContent,
  })));
  for (const group of M.groups) {
    const r = rows.find((row) => row.group === group);
    const offer = (control) => M.offers[`hub/${group}/${control}`];
    if (!r) {
      // A group without a row in the group editor (People Tags) has its switch on the hub and states the rest.
      if (offer('enable') === true && !(await page.locator(`#${group}TagsToggle`).count())) failures.push(`${group}: no on/off switch on the hub`);
      for (const control of ['position', 'limit', 'scopes']) {
        if (offer(control) === true) failures.push(`${group}: ${control} offered but the group has no row`);
        else if (!(await page.locator(`[data-je-scope-na="${group}"]`).textContent().catch(() => '')).includes(offer(control))) failures.push(`${group}: ${control} reason not shown`);
      }
      continue;
    }
    if (offer('enable') === true && !r.enable) failures.push(`${group}: no on/off switch`);
    if (offer('position') === true && !r.position) failures.push(`${group}: no position`);
    if (offer('limit') === true ? !r.limit : !r.limitNote.includes(offer('limit'))) failures.push(`${group}: limit ${offer('limit') === true ? 'missing' : 'reason missing'}`);
    if (offer('scopes') === true ? r.scopes !== 6 : !r.text.includes(offer('scopes'))) failures.push(`${group}: Where to show has ${r.scopes} switches`);
  }
  // Follow server means the same for every group: a personal switch, then Follow server, leaves the
  // group following (no personal switch left) and says so; a later administrator change reaches it.
  const follow = await page.evaluate(async () => {
    const JE = window.JellyfinEnhanced;
    const S = JE.core.tagScopes;
    const wrong = [];
    for (const block of document.querySelectorAll('[data-je-scope-block]')) {
      const group = block.dataset.jeScopeBlock;
      const input = block.querySelector('input[data-je-scope="episodes"]');
      input.checked = !input.checked;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      if (S.scopeOwn(group, 'episodes') === null) wrong.push(`${group}: a switch did not become personal`);
      document.querySelector(`[data-je-scope-follow="${group}"]`).click();
      if (S.SCOPE_IDS.some((scope) => S.scopeOwn(group, scope) !== null)) wrong.push(`${group}: Follow server left a personal switch`);
      const button = document.querySelector(`[data-je-scope-follow="${group}"]`);
      if (!button.disabled) wrong.push(`${group}: Follow server not shown as following`);
      const key = group === 'rating' ? 'RatingTagsOnEpisodes' : null;
      if (key) { JE.pluginConfig[key] = false; if (S.allows('rating', 'episodes')) wrong.push('rating: a later administrator change did not reach a following user'); JE.pluginConfig[key] = true; }
      else {
        const pascal = group.charAt(0).toUpperCase() + group.slice(1);
        JE.pluginConfig.TagGroupScopes = { [pascal]: { Episodes: false } };
        if (S.allows(group, 'episodes')) wrong.push(`${group}: a later administrator change did not reach a following user`);
        JE.pluginConfig.TagGroupScopes = null;
      }
    }
    return wrong;
  });
  failures.push(...follow);
  expect(failures).toEqual([]);
});

test('item editor: every group row offers the matrix controls and states where the rest are set', async ({ page }) => {
  await s.itemEditor(page);
  const M = await matrixOf(page);
  const failures = [];
  failures.push(...await emptyDisclosures(page));
  const rows = await page.$$eval('.je-tie-groups [data-group]', (rows) => rows.map((r) => ({
    group: r.dataset.group, enable: !!r.querySelector('input[data-tie-on]'), position: !!r.querySelector('.je-tie-where input[type="radio"]'),
    limit: !!r.querySelector('.je-tie-cap button'), limitNote: r.querySelector('[data-je-limit-na]')?.textContent || '',
  })));
  const note = await page.locator('[data-je-scope-na="itemEditor"]').textContent().catch(() => '');
  for (const r of rows) {
    const offer = (control) => M.offers[`itemEditor/${r.group}/${control}`];
    if (offer('enable') === true && !r.enable) failures.push(`${r.group}: no include switch`);
    if (offer('position') === true && !r.position) failures.push(`${r.group}: no position`);
    if (offer('limit') === true ? !r.limit : !r.limitNote.includes(offer('limit'))) failures.push(`${r.group}: limit ${offer('limit') === true ? 'missing' : 'reason missing'}`);
    if (offer('scopes') !== true && !note.includes(offer('scopes'))) failures.push(`${r.group}: Where to show reason missing`);
  }
  expect(rows.length).toBeGreaterThan(0);
  expect(failures).toEqual([]);
});

test('admin page: a link with an arrow or external-link icon underlines its words, never the icon beside them', async ({ page }) => {
  await s.adminPage(page);
  const links = await page.evaluate(() => Array.from(document.querySelectorAll('.je-tag-admin a.je-ta-link')).filter((a) => a.querySelector(':scope > .material-icons')).map((a) => ({
    text: a.textContent.trim().slice(0, 50),
    link: getComputedStyle(a).textDecorationLine,
    words: a.querySelector(':scope > .je-ta-link-text') ? getComputedStyle(a.querySelector(':scope > .je-ta-link-text')).textDecorationLine : 'missing',
  })));
  expect(links.length).toBeGreaterThan(5);
  expect(links.filter((l) => l.link !== 'none' || l.words !== 'underline')).toEqual([]);
});
