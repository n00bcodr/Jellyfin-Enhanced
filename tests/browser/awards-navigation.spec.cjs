const { test, expect } = require('@playwright/test');
const path = require('node:path');
const { mkdirSync } = require('node:fs');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js');
const english = require('../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json');
const lab = process.env.JE_AWARDS_LAB_URL;
const facts = { ImdbRank: 12, OscarWinner: true, OscarYear: 2024 };
if (process.env.JE_AWARDS_WIDTH) test.use({ viewport: { width: Number(process.env.JE_AWARDS_WIDTH), height: 900 } });

/** Render synthetic award facts with production scripts, optionally on an actual Jellyfin card. */
async function prepare(page, layout) {
  if (lab) {
    // Inject facts into this browser's cache response only. No server metadata or preferences change.
    await page.route('**/JellyfinEnhanced/tag-cache/**', async route => {
      const response = await route.fetch();
      if (!response.ok()) return route.fulfill({ response });
      const json = await response.json();
      for (const entry of Object.values(json.items || {})) if (entry.Type === 'Movie') entry.Awards = facts;
      await route.fulfill({ response, json });
    });
    await page.goto(`${lab}/web/index.html#/login`);
    const name = page.locator('#txtManualName');
    await expect(async () => {
      if (!(await name.isVisible())) await page.getByText('Manual Login', { exact: true }).click();
      await expect(name).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 30000 });
    await name.fill(process.env.JE_AWARDS_LAB_USER || 'real-admin');
    await page.locator('#txtManualPassword').fill(process.env.JE_AWARDS_LAB_PASSWORD);
    await page.locator('#txtManualPassword').press('Enter');
    await page.waitForFunction(() => window.ApiClient?.getCurrentUserId());
    await page.goto(`${lab}/web/index.html#/movies`);
    // Some disposable labs omit middleware injection; load the deployed bootstrap, never checkout scripts.
    if (!(await page.evaluate(() => !!window.JellyfinEnhanced))) await page.addScriptTag({ url: `${lab}/JellyfinEnhanced/script` });
    await page.waitForFunction(() => window.JellyfinEnhanced?.initialized && window.JellyfinEnhanced?.awardsTags);
    await page.waitForSelector('.card[data-type="Movie"] a.cardImageContainer[href]');
    await page.waitForFunction(() => [...window.JellyfinEnhanced.tagPipeline.serverEntries()].some(e => e.Awards?.ImdbRank === 12));
  } else {
    await page.goto('/');
    await page.setContent(`<style>
      .card { width:180px; margin:20px; } .cardScalable { position:relative; height:270px; background:#234; }
      .cardOverlayContainer { position:absolute; inset:0; z-index:1; } .cardImageContainer { position:absolute; inset:0; }
      .je-tag-host { position:absolute; inset:0; pointer-events:none; }
      </style><div class="card" data-id="awards-proof" data-type="Movie"><div class="cardBox"><div class="cardScalable">
      <div class="je-tag-host"></div><div class="cardOverlayContainer"><a class="cardImageContainer" href="#awards-details">Item</a></div>
      </div><div class="cardText">Title</div></div></div>`);
    await page.evaluate(en => {
      window.JellyfinEnhanced = {
        currentSettings: {}, pluginConfig: {},
        t: (key, params = {}) => Object.entries(params).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), en[key] || key),
        session: { getUserId: () => 'browser', getServerId: () => 'test', onUserChange() {} },
        tagPipeline: { registerRenderer(name, renderer) { this[name] = renderer; }, getRenderer(name) { return this[name]; }, clearProcessed() {}, scheduleScan() {} },
      };
    }, english);
    for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/tag-layout-styles.js', 'tags/awardstags.js']) {
      await page.addScriptTag({ path: path.join(root, file) });
    }
  }
  await page.evaluate(async layout => {
    const JE = window.JellyfinEnhanced;
    JE.pluginConfig = { ...JE.pluginConfig, AwardsTagsEnabled: true };
    JE.currentSettings = { ...JE.currentSettings, awardsTagsEnabled: true, tagsHideOnHover: false,
      qualityTagsEnabled: false, genreTagsEnabled: false, ratingTagsEnabled: false, ageRatingTagsEnabled: false,
      languageTagsEnabled: false, statusTagsEnabled: false, tagLayout: layout, tagLayoutSettingsVersion: 1,
      tagGroupOrder: ['awards'], tagGroupCaps: { awards: 2 }, tagLookRules: [], tagLayoutLocks: {},
      tagShapeOverrides: { landscape: null, list: null }, tagLayouts: { summary: { groups: [{ group: 'awards', slot: 'pill' }] } } };
    JE.initializeAwardsTags();
    await JE.core.tagLayout.reinitialize();
  }, layout);
  if (lab) {
    await page.waitForSelector('.card[data-type="Movie"] .awards-tag');
  }
  return page.evaluate(({ facts, isLab }) => {
    const JE = window.JellyfinEnhanced;
    const card = [...document.querySelectorAll('.card[data-type="Movie"]')].find(c => c.querySelector('a.cardImageContainer[href]')
      && c.getBoundingClientRect().width > 100 && (!isLab || c.querySelector('.awards-tag')));
    card.id = 'awards-navigation-proof';
    if (!isLab) {
      const host = JE.core.tagLayout.ensureHost(card.querySelector('.cardScalable'));
      JE.tagPipeline.getRenderer('awards').renderFromServerCache(host, { Awards: facts });
      JE.core.tagLayout.flushFit();
    }
    return card.querySelector('a.cardImageContainer[href]').href;
  }, { facts, isLab: !!lab });
}

for (const layout of ['corners', 'caption', 'summary']) {
  test(`${layout}: award rank/year hover reaches an anchor without adding tab stops`, async ({ page }, info) => {
    test.setTimeout(lab ? 90000 : 30000);
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await prepare(page, layout);
    const links = page.locator('#awards-navigation-proof a.awards-link');
    for (const [index, title] of ['IMDb Top 250 · Rank #12', 'Oscar winner · 2024'].entries()) {
      const link = links.nth(index);
      await expect(link).toHaveAttribute('title', title);
      await expect(link).toHaveAttribute('tabindex', '-1');
      if (layout === 'summary') await page.locator('#awards-navigation-proof').hover();
      await link.hover();
      // A title attribute alone passed the old regression: verify real browser hit testing at hover.
      expect(await link.evaluate(el => {
        const r = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      })).toBe(true);
    }
    const pill = page.locator('#awards-navigation-proof a.je-tag-pill');
    if (layout === 'summary') {
      await expect(pill).toHaveAttribute('title', 'IMDb Top 250 · Rank #12');
      await expect(pill).toHaveAttribute('tabindex', '-1');
    }
    expect(await links.evaluateAll(list => list.every(a => a.tabIndex === -1))).toBe(true);
    expect(errors).toEqual([]);
    if (process.env.JE_AWARDS_SHOTS) {
      mkdirSync(process.env.JE_AWARDS_SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.JE_AWARDS_SHOTS, `${info.project.name}-${process.env.JE_AWARDS_WIDTH || 'desktop'}-${layout}-hover.png`) });
    }
  });

  test(`${layout}: left, modifier and middle award clicks follow the poster`, async ({ page, context }) => {
    test.setTimeout(lab ? 90000 : 30000);
    const destination = await prepare(page, layout);
    if (layout === 'summary') await page.locator('#awards-navigation-proof').hover();
    const chip = page.locator('#awards-navigation-proof a.awards-link').first();
    expect(await chip.evaluate(el => el.href)).toBe(destination);
    for (const action of [{ modifiers: ['ControlOrMeta'] }, { button: 'middle' }]) {
      const opened = context.waitForEvent('page');
      await chip.click(action);
      const tab = await opened;
      await expect(tab).toHaveURL(destination);
      await tab.close();
      await expect(page).not.toHaveURL(destination);
    }
    await chip.click();
    await expect(page).toHaveURL(destination);
  });
}


for (const reveal of ['hover', 'focus', 'forced']) {
  test(`mixed Summary: ${reveal} disables the hidden pill and exposes both award links`, async ({ page }, info) => {
    const destination = await prepare(page, 'summary');
    await page.evaluate(async () => {
      const JE = window.JellyfinEnhanced;
      const groups = ['language', 'quality', 'rating', 'awards'];
      Object.assign(JE.currentSettings, { languageTagsEnabled: true, qualityTagsEnabled: true, ratingTagsEnabled: true,
        tagGroupOrder: groups, tagGroupCaps: { language: 1, quality: 1, rating: 1, awards: 2 },
        tagLayouts: { summary: { groups: groups.map(group => ({ group, slot: 'pill' })) } } });
      await JE.core.tagLayout.reinitialize();
      const host = JE.core.tagLayout.ensureHost(document.querySelector('#awards-navigation-proof .cardScalable'));
      for (const [group, html] of [
        ['language', '<span class="language-code" title="English">EN</span>'],
        ['quality', '<span class="quality-overlay-label resolution">4K</span>'],
        ['rating', '<span class="rating-tag rating-tag-tmdb"><span class="rating-text">8</span></span>'],
      ]) {
        const wrap = document.createElement('div');
        wrap.innerHTML = html;
        JE.core.tagLayout.commitGroup(host, group, wrap);
      }
      JE.core.tagLayout.flushFit();
    });
    const card = page.locator('#awards-navigation-proof');
    const pill = card.locator('a.je-tag-pill');
    const slot = card.locator('[data-je-slot="pill"]');
    await expect(pill.locator('.je-tag-pill-fact')).toHaveCount(3);
    expect(await pill.locator('.je-tag-pill-fact').evaluateAll(list => list.map(el => el.dataset.jeGroup)))
      .toEqual(['language', 'quality', 'rating']);
    await expect(pill).toHaveCSS('pointer-events', 'auto');
    if (reveal === 'hover') await card.hover();
    else if (reveal === 'focus') await card.locator('a.cardImageContainer').focus();
    else await card.evaluate(el => el.classList.add('je-tag-reveal'));
    await expect(slot).toHaveCSS('opacity', '0');
    const links = card.locator('a.awards-link');
    // Test hit targets before hovering a chip: forced reveal must work without :hover as well.
    for (const link of await links.all()) {
      expect(await link.evaluate(el => {
        const r = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      })).toBe(true);
    }
    await expect(pill).toHaveCSS('pointer-events', 'none');
    for (const [index, title] of ['IMDb Top 250 · Rank #12', 'Oscar winner · 2024'].entries()) {
      await expect(links.nth(index)).toHaveAttribute('title', title);
      await links.nth(index).hover();
    }
    if (process.env.JE_AWARDS_SHOTS) {
      mkdirSync(process.env.JE_AWARDS_SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.JE_AWARDS_SHOTS, `${info.project.name}-mixed-summary-${reveal}.png`) });
    }
    await page.mouse.move(0, 0);
    await card.evaluate(el => { el.classList.remove('je-tag-reveal'); document.activeElement?.blur(); });
    await expect(slot).toHaveCSS('opacity', '1');
    await expect(pill).toHaveCSS('pointer-events', 'auto');
    await card.hover();
    await links.nth(1).click();
    await expect(page).toHaveURL(destination);
  });
}
