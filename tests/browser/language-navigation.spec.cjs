const { test, expect } = require('@playwright/test');
const path = require('node:path');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js');
const english = require('../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json');
const lab = process.env.JE_LANGUAGE_LAB_URL;

/** Exercise native browser navigation using production language groups and layout clones. */
async function prepare(page, style, slot) {
  if (lab) {
    await page.goto(`${lab}/web/index.html#/login`);
    await page.getByText('Manual Login', { exact: true }).click();
    await page.locator('#txtManualName').fill(process.env.JE_LANGUAGE_LAB_USER || 'real-admin');
    await page.locator('#txtManualPassword').fill(process.env.JE_LANGUAGE_LAB_PASSWORD);
    await page.locator('#txtManualPassword').press('Enter');
    await page.waitForFunction(() => window.ApiClient?.getCurrentUserId());
    await page.goto(`${lab}/web/index.html#/home`);
    await page.waitForFunction(() => window.JellyfinEnhanced?.initialized && window.JellyfinEnhanced?.core?.languageTags);
    await page.waitForSelector('.card[data-type="Movie"] a.cardImageContainer[href]');
  } else {
    await page.goto('/');
    await page.setContent(`<style>
      .card { width:180px; margin:20px; } .cardScalable { position:relative; height:270px; background:#234; }
      .cardOverlayContainer { position:absolute; inset:0; z-index:1; } .cardImageContainer { position:absolute; inset:0; }
      .je-tag-host { position:absolute; inset:0; pointer-events:none; }
      </style><div class="card" data-id="language-proof"><div class="cardBox"><div class="cardScalable">
      <div class="je-tag-host"></div><div class="cardOverlayContainer"><a class="cardImageContainer" href="#language-details">Item</a></div>
      </div><div class="cardText">Title</div></div></div>`);
    await page.evaluate(en => {
      window.JellyfinEnhanced = {
        currentSettings: { languageTagsEnabled: true }, pluginConfig: {},
        t: (key, params = {}) => Object.entries(params).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), en[key] || key),
        cdn: { flagSvg: () => 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><path fill="red" d="M0 0h32v24H0z"/></svg>') },
        session: { getUserId: () => 'browser', getServerId: () => 'test', onUserChange() {} },
        tagPipeline: { registerRenderer(name, renderer) { this[name] = renderer; }, getRenderer(name) { return this[name]; }, clearProcessed() {}, scheduleScan() {} },
      };
    }, english);
    for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/tag-layout-styles.js', 'core/media-language.js', 'tags/languagetags.js']) {
      await page.addScriptTag({ path: path.join(root, file) });
    }
    await page.evaluate(() => { window.JellyfinEnhanced.initializeLanguageTags(); window.JellyfinEnhanced.tagPipeline.getRenderer('language').injectCss(); });
  }
  await page.evaluate(async ({ style, slot, isLab }) => {
    const JE = window.JellyfinEnhanced;
    // This navigation fixture owns its two language facts. Saved lab priorities
    // can remove Japanese, and unrelated groups can fill Caption's two rows.
    // Keep those policies out of the fixture without saving any preferences.
    JE.pluginConfig = { ...JE.pluginConfig, LanguageTagsPriority: '', LanguageTagsPriorityStrict: false, LanguageTagsMergeRegions: false };
    JE.currentSettings = { ...JE.currentSettings, languageTagsEnabled: true, languageTagsShowAudio: style !== 'subtitles', languageTagsShowSubtitles: style === 'subtitles',
      languageTagsStyle: style === 'codes' ? 'codes' : 'flags', languageTagsCountBadge: style === 'badge' ? 'only' : 'off', tagsHideOnHover: false,
      qualityTagsEnabled: false, genreTagsEnabled: false, ratingTagsEnabled: false, ageRatingTagsEnabled: false, statusTagsEnabled: false,
      tagGroupOrder: ['language'], tagGroupCaps: { language: 0 }, tagLookRules: [], tagLayoutLocks: {}, tagShapeOverrides: { landscape: null, list: null },
      tagLayout: slot === 'pill' ? 'summary' : slot === 'caption' ? 'caption' : 'corners', tagLayoutSettingsVersion: 1,
      tagLayouts: { summary: { groups: [{ group: 'language', slot: 'pill' }] } } };
    if (isLab) {
      JE.initializeLanguageTags();
      JE.tagPipeline.getRenderer('language').injectCss();
    }
    await JE.core.tagLayout.reinitialize();
  }, { style, slot, isLab: !!lab });
  // A production-tagged card and the narrow cache wait establish readiness, not pipeline idleness.
  // Renderer injection marks the card tagged; its guards protect the facts from later same-card renders.
  await page.waitForFunction(async isLab => {
    const JE = window.JellyfinEnhanced;
    if (isLab) await JE.tagPipeline.getReviewRatings();
    const card = [...document.querySelectorAll('.card[data-id]')].find(c => (!isLab || c.dataset.type === 'Movie')
      && c.querySelector('a.cardImageContainer[href]') && c.getBoundingClientRect().width > 100
      && (!isLab || JE.core.tagLayout.hasGroup(c.querySelector('.cardScalable'), 'language')));
    if (card) card.id = 'language-navigation-proof';
    return !!card;
  }, !!lab);
  return page.evaluate(async ({ style, isLab }) => {
    const JE = window.JellyfinEnhanced;
    if (isLab) await JE.tagPipeline.getReviewRatings();
    const card = document.getElementById('language-navigation-proof');
    const host = JE.core.tagLayout.ensureHost(card.querySelector('.cardScalable'));
    for (const group of JE.core.tagLayout.GROUPS) JE.core.tagLayout.removeGroup(host, group);
    // Through the registered renderer, as the pipeline renders a server-cache entry: it marks the
    // card tagged, so a later scan or batch render leaves these facts in place.
    const audio = style === 'badge' ? ['en', 'ja'] : ['en'];
    JE.tagPipeline.getRenderer('language').renderFromServerCache(host, { AudioLanguages: audio, SubtitleLanguages: ['en'] });
    JE.core.tagLayout.flushFit();
    return card.querySelector('a.cardImageContainer[href]').href;
  }, { style, isLab: !!lab });
}

/** Tab (or Shift+Tab) from a sentinel before (after) the proof card to one after (before) it; returns the focus stops between. */
async function keyboardStops(page, reverse) {
  await page.evaluate(() => {
    const card = document.getElementById('language-navigation-proof');
    for (const [id, where] of [['language-tab-before', 'before'], ['language-tab-after', 'after']]) {
      if (document.getElementById(id)) continue;
      const button = document.createElement('button');
      button.id = id;
      button.textContent = id;
      card[where](button);
    }
  });
  const [start, end] = reverse ? ['#language-tab-after', '#language-tab-before'] : ['#language-tab-before', '#language-tab-after'];
  await page.locator(start).focus();
  const stops = [];
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press(reverse ? 'Shift+Tab' : 'Tab');
    const stop = await page.evaluate(endId => {
      const el = document.activeElement;
      const card = document.getElementById('language-navigation-proof');
      if (el?.id === endId) return null;
      return { inCard: card.contains(el), cardLink: el === card.querySelector('a.cardImageContainer[href]'),
        overlay: !!el?.closest('.language-link, .je-tag-pill, .je-tag-host, .je-tag-caption'), label: `${el?.tagName}.${el?.classList[0] || ''}[${el?.dataset.action || ''}]` };
    }, end.slice(1));
    if (!stop) return stops;
    stops.push(stop);
  }
  throw new Error(`focus never reached ${end}: ${JSON.stringify(stops)}`);
}

for (const [style, slot] of [['flags', 'corner'], ['subtitles', 'caption'], ['subtitles', 'pill']]) {
  test(`${style} in ${slot}: keyboard focus skips language links`, async ({ page }) => {
    test.setTimeout(lab ? 90000 : 30000);
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error' && /Jellyfin Enhanced|\bJE\b/.test(m.text())) errors.push(m.text()); });
    await prepare(page, style, slot);
    const overlay = page.locator(slot === 'pill' ? '#language-navigation-proof a.je-tag-pill' : '#language-navigation-proof a.language-link');
    await expect(overlay.first()).toHaveAttribute('tabindex', '-1');
    await expect(overlay.first()).toHaveAttribute('title', style === 'subtitles' ? /Subtitles: English/ : /English/);
    const forward = await keyboardStops(page, false);
    const backward = await keyboardStops(page, true);
    const inCard = stops => stops.filter(s => s.inCard);
    // The card's own link is the first stop inside it; the next stops leave the card (or, on a live
    // Jellyfin card, visit only its native controls) without touching a language link or pill.
    expect(inCard(forward)[0]?.cardLink).toBe(true);
    expect(forward.filter(s => s.overlay)).toEqual([]);
    expect(backward.filter(s => s.overlay)).toEqual([]);
    expect(inCard(backward).map(s => s.label).reverse()).toEqual(inCard(forward).map(s => s.label));
    if (!lab) expect(forward.map(s => s.label)).toEqual(['A.cardImageContainer[]']);
    expect(errors).toEqual([]);
  });
}

for (const [style, slot] of [['flags', 'corner'], ['codes', 'corner'], ['subtitles', 'caption'], ['subtitles', 'pill'], ['badge', 'corner']]) {
  test(`${style} in ${slot}: native left, modifier and middle navigation`, async ({ page, context }) => {
    test.setTimeout(lab ? 90000 : 30000);
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error' && /Jellyfin Enhanced|\bJE\b/.test(m.text())) errors.push(m.text()); });
    const destination = await prepare(page, style, slot);
    const chip = page.locator(slot === 'pill' ? '#language-navigation-proof .je-tag-pill' : '#language-navigation-proof .language-link').first();
    await expect(chip).toHaveAttribute('href', /.+/);
    await expect(chip).toHaveAttribute('title', style === 'subtitles' ? /Subtitles: English/ : style === 'badge' ? /2 audio languages/ : /English/);
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
    expect(errors).toEqual([]);
  });
}
