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
        tagPipeline: { registerRenderer(name, renderer) { this[name] = renderer; }, clearProcessed() {}, scheduleScan() {} },
      };
    }, english);
    for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/tag-layout-styles.js', 'core/media-language.js', 'tags/languagetags.js']) {
      await page.addScriptTag({ path: path.join(root, file) });
    }
    await page.evaluate(() => { window.JellyfinEnhanced.initializeLanguageTags(); window.JellyfinEnhanced.tagPipeline.language.injectCss(); });
  }
  return page.evaluate(async ({ style, slot, isLab }) => {
    const JE = window.JellyfinEnhanced;
    JE.currentSettings = { ...JE.currentSettings, languageTagsEnabled: true, languageTagsShowAudio: style !== 'subtitles', languageTagsShowSubtitles: style === 'subtitles',
      languageTagsStyle: style === 'codes' ? 'codes' : 'flags', languageTagsCountBadge: style === 'badge' ? 'only' : 'off', tagsHideOnHover: false,
      tagLayout: slot === 'pill' ? 'summary' : slot === 'caption' ? 'caption' : 'corners', tagLayoutSettingsVersion: 1,
      tagLayouts: { summary: { groups: [{ group: 'language', slot: 'pill' }] } } };
    if (isLab) {
      JE.initializeLanguageTags();
      JE.tagPipeline.getRenderer('language').injectCss();
    }
    await JE.core.tagLayout.reinitialize();
    const card = [...document.querySelectorAll('.card[data-id]')].find(c => (!isLab || c.dataset.type === 'Movie') && c.querySelector('a.cardImageContainer[href]') && c.getBoundingClientRect().width > 100);
    card.id = 'language-navigation-proof';
    const host = JE.core.tagLayout.ensureHost(card.querySelector('.cardScalable'));
    for (const group of JE.core.tagLayout.GROUPS) JE.core.tagLayout.removeGroup(host, group);
    const facts = { audio: style === 'badge' ? ['en', 'ja'] : ['en'], subtitles: ['en'] };
    if (isLab) JE.core.tagLayout.commitGroup(host, 'language', JE.core.languageTags.buildGroup(facts));
    else JE.tagPipeline.language.renderFromServerCache(host, { AudioLanguages: facts.audio, SubtitleLanguages: facts.subtitles });
    JE.core.tagLayout.flushFit();
    return card.querySelector('a.cardImageContainer[href]').href;
  }, { style, slot, isLab: !!lab });
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
