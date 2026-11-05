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
    if (offer('placement') === true ? !r.placement : !r.text.includes(offer('placement'))) failures.push(`${r.group}: placement ${offer('placement') === true ? 'link missing' : 'reason missing'}`);
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
    placement: !!r.querySelector('select, [role="radiogroup"], .je-tge-step'),
    scopes: r.querySelectorAll(`[data-je-scope-block="${r.dataset.group}"] input[type="checkbox"]`).length,
    text: r.textContent,
  })));
  for (const group of M.groups) {
    const r = rows.find((row) => row.group === group);
    const offer = (control) => M.offers[`hub/${group}/${control}`];
    if (!r) {
      // A group without a row in the group editor (People Tags) has its switch on the hub and states the rest.
      if (offer('enable') === true && !(await page.locator(`#${group}TagsToggle`).count())) failures.push(`${group}: no on/off switch on the hub`);
      for (const control of ['placement', 'scopes']) if (offer(control) === true) failures.push(`${group}: ${control} offered but the group has no row`);
      continue;
    }
    if (offer('enable') === true && !r.enable) failures.push(`${group}: no on/off switch`);
    if (offer('placement') === true && !r.placement) failures.push(`${group}: no position or limit`);
    if (offer('scopes') === true ? r.scopes !== 6 : !r.text.includes(offer('scopes'))) failures.push(`${group}: Where to show has ${r.scopes} switches`);
  }
  expect(failures).toEqual([]);
});

test('item editor: every group row offers the matrix controls and states where the rest are set', async ({ page }) => {
  await s.itemEditor(page);
  const M = await matrixOf(page);
  const failures = [];
  failures.push(...await emptyDisclosures(page));
  const rows = await page.$$eval('.je-tie-groups [data-group]', (rows) => rows.map((r) => ({
    group: r.dataset.group, enable: !!r.querySelector('input[data-tie-on]'), placement: !!r.querySelector('.je-tie-where input[type="radio"]'),
  })));
  const note = await page.locator('[data-je-scope-na="itemEditor"]').textContent().catch(() => '');
  for (const r of rows) {
    const offer = (control) => M.offers[`itemEditor/${r.group}/${control}`];
    if (offer('enable') === true && !r.enable) failures.push(`${r.group}: no include switch`);
    if (offer('placement') === true && !r.placement) failures.push(`${r.group}: no position`);
    if (offer('scopes') !== true && !note.includes(offer('scopes'))) failures.push(`${r.group}: Where to show reason missing`);
  }
  expect(rows.length).toBeGreaterThan(0);
  expect(failures).toEqual([]);
});
