import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';

/** Configure centre anchors through the real hub and capture poster and editor evidence. */
export default async function ({page, settlePage}) {
  const out = '.notes/shots/centres';
  mkdirSync(out, {recursive: true});
  await page.evaluate(() => window.JellyfinEnhanced.showEnhancedPanel());
  await page.locator('#jellyfin-enhanced-panel').waitFor({state: 'visible'});
  await page.locator('.je-panel-nav-items [data-tab="media-tags"]').click();
  await page.locator('#jeMthTab-layout').click();
  await page.locator('input[name="jeTagLayout"][value="corners"]').check();
  await page.locator('#jeMthTab-badges').click();
  await page.locator('#statusTagsSeriesStatusToggle').check();
  await page.locator('#jeMthTab-groups').click();
  const choices = {quality: 'tc', status: 'mr', rating: 'bc', language: 'ml', genre: 'c'};
  for (const [group, slot] of Object.entries(choices)) {
    const row = page.locator(`.je-tge-row[data-group="${group}"]`);
    const toggle = row.locator('input[type="checkbox"]').first();
    await toggle.check();
    await row.locator('.je-tge-expand').click();
    await row.locator(`[data-slot="${slot}"]`).click();
    await row.locator('.je-tge-expand').click();
  }
  const row = page.locator('.je-tge-row[data-group="quality"]');
  await row.locator('.je-tge-expand').click();
  await page.waitForTimeout(1200);
  const slots = await row.locator('.je-tge-pill').evaluateAll(es => es.map(e => e.dataset.slot));
  assert.deepEqual(slots, ['tl','tc','tr','ml','c','mr','bl','bc','br','off']);
  const grid = await row.locator('.je-tge-pills').evaluate(el => ({display: getComputedStyle(el).display, cols: getComputedStyle(el).gridTemplateColumns}));
  assert.equal(grid.display, 'grid');
  console.log('PILLS', JSON.stringify(grid));
  await page.mouse.move(0, 0);
  await page.screenshot({path: `${out}/hub-groups-desktop.png`});
  await page.setViewportSize({width:420, height:900});
  await page.waitForTimeout(800);
  await page.screenshot({path: `${out}/hub-groups-phone.png`});
  await page.keyboard.press('Escape');
  const series = await page.evaluate(async () => (await ApiClient.getItems(ApiClient.getCurrentUserId(), {IncludeItemTypes:'Series', Recursive:true, Limit:1, SortBy:'SortName'})).Items[0]);
  console.log('SERIES', series.Id, series.Name);
  for (const width of [1400,420]) {
    await page.setViewportSize({width,height:900});
    for (const [name,route] of [['movies','#/movies'], ['series',`#/details?id=${series.Id}`]]) {
      await page.goto(`http://127.0.0.1:18537/web/index.html${route}`);
      await page.waitForTimeout(4000);
      await settlePage(page);
      await page.mouse.move(0,0);
      await page.screenshot({path:`${out}/${name}-${width}.png`});
      console.log('ANCHORS', name,width, await page.evaluate(() => JSON.stringify([...document.querySelectorAll('.je-tag-host > .je-tag-slot')].reduce((a,e)=>(a[e.dataset.jeSlot]=(a[e.dataset.jeSlot]||0)+1,a),{}))));
    }
  }
  // Reload proves the hub writes reached the server; switching users is
  // verified separately by the normal helper login as real-viewer.
  const saved = await page.evaluate(() => {
    const s = JellyfinEnhanced.currentSettings;
    return Object.fromEntries(['qualityTagsPosition','statusTagsPosition','ratingTagsPosition','languageTagsPosition','genreTagsPosition'].map(k=>[k,s[k]]));
  });
  assert.deepEqual(saved,{qualityTagsPosition:'top-center',statusTagsPosition:'center-right',ratingTagsPosition:'bottom-center',languageTagsPosition:'center-left',genreTagsPosition:'center'});
  console.log('SAVED',JSON.stringify(saved));
}
