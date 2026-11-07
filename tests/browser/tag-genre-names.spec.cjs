const { test, expect } = require('@playwright/test');
const s = require('./helpers/settings-surfaces.cjs');

// Standing guard (improvements review, rounds 1 and 2): a revealed card's genre names stay beside their icons, inside
// the card and clear of every other chip, and its "+N" names tip takes a band no chip or name touches
// (core/tag-layout.js fitReveal). Reviewers found "Science Fiction" over the 4K chip, names cut by the card edge,
// names cut to three letters, and "More tags: …" over the quality chips.

/** Every shown genre name of the revealed cards: inside its card, over no other chip or name. */
const collisions = (page) => page.evaluate(() => {
  const out = [];
  const shown = (el) => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
  for (const host of document.querySelectorAll('.je-tag-host')) {
    const card = host.getBoundingClientRect();
    if (!card.width) continue;
    const chips = Array.from(host.querySelectorAll(':scope > .je-tag-slot:not([data-je-slot="hover"]) > [data-je-group] > *')).map((el) => ({ el, r: el.getBoundingClientRect() })).filter(({ r }) => r.width > 0);
    const names = Array.from(host.querySelectorAll(':scope > .je-tag-slot:not([data-je-slot="hover"]) .genre-tag > .genre-text')).filter(shown);
    for (const name of names) {
      const r = name.getBoundingClientRect();
      const label = `${name.textContent} (${name.dataset.jeGenreFit || 'unbounded'})`;
      if (r.left < card.left - 0.5 || r.right > card.right + 0.5 || r.top < card.top - 0.5 || r.bottom > card.bottom + 0.5) out.push(`${label} leaves its card`);
      for (const { el, r: c } of chips) {
        if (el === name.parentElement) continue;
        if (r.left < c.right - 0.5 && r.right > c.left + 0.5 && r.top < c.bottom - 0.5 && r.bottom > c.top + 0.5) out.push(`${label} covers ${el.className.split(' ')[0]}`);
      }
      for (const other of names) {
        if (other === name) continue;
        const o = other.getBoundingClientRect();
        if (r.left < o.right - 0.5 && r.right > o.left + 0.5 && r.top < o.bottom - 0.5 && r.bottom > o.top + 0.5) out.push(`${label} covers the name ${other.textContent}`);
      }
      if (name.scrollWidth > name.clientWidth + 1 && getComputedStyle(name).textOverflow !== 'ellipsis') out.push(`${label} is cut without an ellipsis`);
      if (name.dataset.jeGenreFit === 'side' && r.width < Math.min(name.scrollWidth, Math.max(24, 0.6 * name.scrollWidth)) - 1) out.push(`${label} shows under 60% of itself`);
    }
    const tip = host.querySelector(':scope > .je-tag-more-tip');
    if (tip && getComputedStyle(tip).display !== 'none') {
      const r = tip.getBoundingClientRect();
      if (r.top < card.top - 0.5 || r.bottom > card.bottom + 0.5) out.push('the +N tip leaves its card');
      for (const { el, r: c } of chips) if (r.left < c.right - 0.5 && r.right > c.left + 0.5 && r.top < c.bottom - 0.5 && r.bottom > c.top + 0.5) out.push(`the +N tip covers ${el.className.split(' ')[0]}`);
      for (const n of names) { const o = n.getBoundingClientRect(); if (r.left < o.right - 0.5 && r.right > o.left + 0.5 && r.top < o.bottom - 0.5 && r.bottom > o.top + 0.5) out.push(`the +N tip covers the name ${n.textContent}`); }
    }
  }
  return out;
});

/**
 * A card with genre icons in one slot (a row at top or bottom centre, or a column at a corner) and, optionally,
 * another chip on the same line, laid out by fixed CSS as the layout stylesheet places them.
 */
async function syntheticCard(page, { slot, chip = null, names = ['Science Fiction', 'Thriller', 'Drama'], width = 240, css = '', tip = '', height = 360 }) {
  await s.base(page);
  await s.load(page, ['core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js']);
  await page.evaluate(({ slot, chip, names, width, css, tip, height }) => {
    const row = slot === 'tc' || slot === 'bc';
    const place = { tc: 'top:6px;left:0;right:0;justify-content:center', bc: 'bottom:6px;left:0;right:0;justify-content:center', tr: 'top:6px;right:6px', tl: 'top:6px;left:6px' }[slot];
    // As the stylesheets place them (genretags.js, tag-layout-styles.js): the bound only ever sets inline styles.
    const float = slot === 'tl' ? 'left:calc(100% + 4px)' : 'right:calc(100% + 4px)';
    const style = `<style>.genre-tag{position:relative;display:inline-flex;width:26px;height:26px;box-sizing:border-box;border:1px solid #888;border-radius:50%;background:#222}
      .genre-tag .genre-text{position:absolute;${float};top:50%;transform:translateY(-50%);white-space:nowrap;font:500 11px sans-serif;padding:2px 6px;box-sizing:border-box;overflow:hidden;text-overflow:ellipsis;background:#111;color:#eee}
      .genre-tag .genre-text[data-je-genre-fit="hidden"]{display:none}
      .je-tag-host > .je-tag-more-tip{position:absolute;top:6px;left:50%;transform:translateX(-50%);width:max-content;max-width:calc(100% - 12px);box-sizing:border-box;padding:3px 7px;font:600 11px/1.25 sans-serif;background:#111;color:#fff}
      .je-tag-host > .je-tag-more-tip[data-je-tip-fit="hidden"]{display:none}${css}</style>`;
    const tag = (name) => `<span class="genre-tag" title="${name}"><span class="genre-text">${name}</span></span>`;
    const other = chip ? `<div class="je-tag-slot" data-je-slot="${chip.slot}" style="position:absolute;display:flex;${chip.css}"><div data-je-group="quality"><span class="quality-overlay-label" style="display:inline-block;padding:2px 6px;font:700 11px sans-serif;background:#1e88e5;color:#fff">${chip.text}</span></div></div>` : '';
    document.body.innerHTML = style + `<div class="card je-tag-reveal" style="position:relative;width:${width}px;height:${height}px;margin:40px;background:#345">
      <div class="je-tag-host" style="position:absolute;inset:0">
        <div class="je-tag-slot" data-je-slot="${slot}" style="position:absolute;display:flex;${place}"><div data-je-group="genre" style="display:flex;flex-direction:${row ? 'row' : 'column'};gap:4px">${names.map(tag).join('')}</div></div>
        ${other}
        ${tip ? `<span class="je-tag-more-tip" aria-hidden="true">${tip}</span>` : ''}
      </div></div>`;
    window.JellyfinEnhanced.core.tagLayout.fitReveal(document.querySelector('.je-tag-host'));
  }, { slot, chip, names, width, css, tip, height });
}

const modes = (page) => page.$$eval('.genre-text', (els) => els.map((el) => `${el.textContent}:${el.dataset.jeGenreFit}`));

test('a row of icons lists its names under the row (top centre) or over it (bottom centre), a line each, inside the card', async ({ page }) => {
  for (const slot of ['tc', 'bc']) {
    await syntheticCard(page, { slot });
    expect(await modes(page)).toEqual(['Science Fiction:list', 'Thriller:list', 'Drama:list']);
    expect(await collisions(page)).toEqual([]);
    const tops = await page.$$eval('.genre-text', (els) => els.map((el) => el.getBoundingClientRect().top));
    const icon = await page.$eval('.genre-tag', (el) => el.getBoundingClientRect());
    if (slot === 'tc') expect(tops[0]).toBeGreaterThan(icon.bottom);
    else expect(tops[2] + 10).toBeLessThan(icon.top + 1);
    expect(tops[1]).toBeGreaterThan(tops[0]);
  }
});

test('a column icon\'s name stops a gap before a chip on its line, and is hidden (title kept) where no room is left', async ({ page }) => {
  // Quality at top left with a short chip: Science Fiction fits beside the top-right genre column.
  await syntheticCard(page, { slot: 'tr', chip: { slot: 'tl', css: 'top:6px;left:6px', text: '4K' } });
  expect(await modes(page)).toEqual(['Science Fiction:side', 'Thriller:side', 'Drama:side']);
  expect(await collisions(page)).toEqual([]);
  // A wide quality chip on the first icon's line: the name is ellipsized at the room left, or hidden.
  await syntheticCard(page, { slot: 'tr', chip: { slot: 'tl', css: 'top:6px;left:6px', text: 'DOLBY VISION HDR10+ ATMOS' }, width: 200 });
  const first = (await modes(page))[0];
  expect(['Science Fiction:side', 'Science Fiction:hidden']).toContain(first);
  expect(await collisions(page)).toEqual([]);
  expect(await page.$eval('.genre-tag', (el) => el.title)).toBe('Science Fiction');
  // A chip reaching under the icon leaves the name no room on its line.
  await syntheticCard(page, { slot: 'tr', chip: { slot: 'tr2', css: 'top:8px;right:4px', text: 'WIDE CHIP UNDER THE ICON' } });
  expect((await modes(page))[0]).toBe('Science Fiction:hidden');
  expect(await collisions(page)).toEqual([]);
});

test('a name with room for under 60% of itself is left out rather than cut to a few letters', async ({ page }) => {
  // A card where about half of "Science Fiction" fits beside its icon: more than the 24px floor, less than 60%.
  await syntheticCard(page, { slot: 'tr', chip: { slot: 'tl', css: 'top:6px;left:6px', text: 'DOLBY VISION' }, width: 183 });
  const room = await page.evaluate(() => document.querySelector('.genre-tag').getBoundingClientRect().left - 4 - (document.querySelector('.quality-overlay-label').getBoundingClientRect().right + 4));
  const natural = await page.evaluate(() => { const probe = document.createElement('span'); probe.style.cssText = 'position:absolute;white-space:nowrap;font:500 11px sans-serif;padding:2px 6px'; probe.textContent = 'Science Fiction'; document.body.append(probe); const w = probe.getBoundingClientRect().width; probe.remove(); return w; });
  expect(room).toBeGreaterThan(24);
  expect(room).toBeLessThan(0.6 * natural);
  const [first] = await modes(page);
  expect(first).toBe('Science Fiction:hidden');
  expect(await collisions(page)).toEqual([]);
});

test('the "+N" names tip takes the first band across the card no chip touches, or is left out', async ({ page }) => {
  // Quality top left and genre top right: the tip moves below them instead of covering them.
  await syntheticCard(page, { slot: 'tr', names: ['Drama', 'Thriller'], chip: { slot: 'tl', css: 'top:6px;left:6px', text: 'DD+ ATMOS 5.1' }, tip: 'More tags: Adventure, Fantasy' });
  expect(await page.$eval('.je-tag-more-tip', (el) => el.dataset.jeTipFit)).toBe('placed');
  expect(await collisions(page)).toEqual([]);
  const [tipTop, chipBottom] = await page.evaluate(() => [document.querySelector('.je-tag-more-tip').getBoundingClientRect().top, document.querySelector('.quality-overlay-label').getBoundingClientRect().bottom]);
  expect(tipTop).toBeGreaterThan(chipBottom);
  // A short card whose genre column fills it top to bottom: no free band, so no tip on the image.
  await syntheticCard(page, { slot: 'tr', names: ['Drama', 'Thriller', 'Mystery', 'Crime'], chip: { slot: 'tl', css: 'top:6px;bottom:6px;left:6px;right:6px;flex-direction:column', text: 'A VERY WIDE QUALITY CHIP THAT SPANS THE CARD' }, tip: 'More tags: Adventure, Fantasy', height: 120, width: 200 });
  expect(await page.$eval('.je-tag-more-tip', (el) => el.dataset.jeTipFit)).toBe('hidden');
});

test('names custom CSS shows inline (position: static) are never marked or moved', async ({ page }) => {
  await syntheticCard(page, { slot: 'tr', chip: { slot: 'tl', css: 'top:6px;left:6px', text: 'DOLBY VISION HDR10+ ATMOS' }, css: '.genre-tag .genre-text{position:static!important;transform:none!important}' });
  expect(await page.$$eval('.genre-text', (els) => els.map((el) => [el.dataset.jeGenreFit || '', el.getAttribute('style') || '']))).toEqual([['', ''], ['', ''], ['', '']]);
});

for (const surface of ['hub', 'adminPage']) for (const width of [1400, 420]) {
  test(`the ${surface} preview's Hover view: genre names never cover a chip or leave their card at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    if (surface === 'hub') await s.hub(page, { settings: { genreTagsEnabled: true } });
    else await s.adminPage(page, { plugin: { GenreTagsEnabled: true } });
    if (surface === 'adminPage') await page.evaluate(() => window.admin.openTab('layout'));
    const toggle = page.locator(surface === 'hub' ? '#jeMthStripToggle' : '.je-ta-preview-toggle');
    if (await toggle.isVisible()) await toggle.click();
    await page.locator('.je-mtp [data-view="hover"]').first().click();
    await page.waitForTimeout(500);
    const bounded = await page.$$eval('.je-mtp-card .je-tag-host .genre-text', (els) => els.filter((el) => el.dataset.jeGenreFit).length);
    expect(bounded).toBeGreaterThan(0);
    expect(await collisions(page)).toEqual([]);
  });
}
