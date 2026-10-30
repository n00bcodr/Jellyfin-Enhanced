import assert from 'node:assert/strict';

/** Check real season cards at both widths, then toggle the feature off and restore it. */
export default async function ({page,settlePage}) {
  for (const width of [1400,420]) {
    await page.setViewportSize({width,height:900});
    await page.reload();
    await page.waitForTimeout(3500);
    await settlePage(page);
    const types = await page.locator('.card').evaluateAll(es=>es.reduce((a,e)=>(a[e.dataset.type]=(a[e.dataset.type]||0)+1,a),{}));
    console.log('CARD_TYPES',width,JSON.stringify(types));
    const overlaps = await page.locator('.card[data-type="Season"] .cardScalable').evaluateAll(cards => cards.flatMap(card => {
      const indicator = card.querySelector('.countIndicator, .playedIndicator');
      if (!indicator) return [];
      const b = indicator.getBoundingClientRect();
      return [...card.querySelectorAll('.je-tag-slot[data-je-slot="tc"] [data-je-group] > *, .je-tag-slot[data-je-slot="tc"] > .je-tag-more')].filter(chip => {
        if (!chip.getClientRects().length) return false;
        const a = chip.getBoundingClientRect();
        return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      }).map(chip => chip.textContent);
    }));
    assert.deepEqual(overlaps, []);
    console.log('INDICATOR_OVERLAPS',width,overlaps.length);
    const season = page.locator('.card[data-type="Season"]').first();
    assert.ok(await season.locator('.je-tag-slot[data-je-slot="tc"]:not([data-je-overflow])').count());
    await season.scrollIntoViewIfNeeded();
    await page.waitForTimeout(2500);
    await page.mouse.move(0,0);
    await page.screenshot({path:`.notes/shots/centres/series-seasons-${width}.png`});
  }
  await page.setViewportSize({width:1400,height:900});
  await page.evaluate(()=>JellyfinEnhanced.showEnhancedPanel());
  await page.locator('.je-panel-nav-items [data-tab="media-tags"]').click();
  await page.locator('#jeMthTab-groups').click();
  const enabled = [];
  for (const group of ['quality','genre','language','rating','ageRating','status']) {
    const toggle = page.locator(`.je-tge-row[data-group="${group}"] input[type="checkbox"]`).first();
    if (await toggle.isChecked()) {enabled.push(group);await toggle.uncheck();}
  }
  await page.waitForTimeout(800);
  assert.equal(await page.locator('.card .je-tag-host [data-je-group]').count(),0);
  console.log('FEATURE_OFF','zero card tag groups');
  for (const group of enabled) await page.locator(`.je-tge-row[data-group="${group}"] input[type="checkbox"]`).first().check();
  await page.keyboard.press('Escape');
  await page.reload();
  await page.waitForTimeout(3500);
  const slots = await page.locator('.card .je-tag-slot').evaluateAll(es=>[...new Set(es.map(e=>e.dataset.jeSlot))]);
  for (const slot of ['tc','bc','ml','mr','c']) assert.ok(slots.includes(slot));
  console.log('RELOAD_RESTORE',JSON.stringify(slots));
}
