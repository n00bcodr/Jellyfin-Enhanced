const { test, expect } = require('@playwright/test');
const path = require('node:path');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js');
const english = require('../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json');

// Standing guard (round 21): in every layout with a wrapping slot (caption strip, bottom band, hover
// reveal, centre rows), turning a group off or removing one chip never hides MORE of the other chips nor
// gives a slot fewer rows while chips are still hidden, and turning it back on restores the exact DOM.
// The admin preview once collapsed the Caption strip to one row when Age rating was switched off.
const GROUPS = { quality: 'qualityTagsEnabled', rating: 'ratingTagsEnabled', ageRating: 'ageRatingTagsEnabled', language: 'languageTagsEnabled',
  genre: 'genreTagsEnabled', status: 'statusTagsEnabled', awards: 'awardsTagsEnabled', logos: 'logoTagsEnabled' };
// Chip-level removals inside a group.
const CHIPS = { 'quality: sound': 'showAudioInfoTag', 'quality: HDR': 'showDynamicRangeTag', 'language: subtitles': 'languageTagsShowSubtitles' };
const BASE = { tagLayoutSettingsVersion: 1, statusTagsTrending: true, statusTagsSchedule: true, languageTagsShowSubtitles: true, showAudioInfoTag: true, showDynamicRangeTag: true,
  ...Object.fromEntries(Object.values(GROUPS).map((key) => [key, true])) };

async function setup(page) {
  await page.setContent('<style>body{margin:0;padding:8px}</style><div id="jellyfin-enhanced-panel"><div id="preview" style="width:550px"></div></div>');
  await page.evaluate(({ english, base }) => {
    window.JellyfinEnhanced = { core: {}, helpers: {}, pluginConfig: { AwardsTagsEnabled: true }, currentSettings: { ...base },
      t: (key, params = {}) => Object.entries(params).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), english[key] || key),
      tagPipeline: { registerRenderer() {}, clearProcessed() {}, scheduleScan() {} } };
  }, { english, base: BASE });
  for (const file of ['core/ui-kit.js', 'core/media-language.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'core/tag-look.js', 'tags/tag-layout-styles.js',
    'tags/rating-sources.js', 'tags/status-vocabulary.js', 'tags/statustags.js', 'tags/qualitytags.js', 'tags/ratingtags.js', 'tags/ageratingtags.js', 'tags/languagetags.js',
    'tags/genretags.js', 'tags/logotags.js', 'tags/awardstags.js', 'enhanced/settingspanel/ui-panel-tag-editor.js', 'enhanced/settingspanel/ui-panel-tag-preview.js']) {
    await page.addScriptTag({ path: path.join(root, file) });
  }
  await page.evaluate(() => { window.preview = JellyfinEnhanced.internals.enhancedUi.createTagPreview(document.querySelector('#preview'), {}); });
}

/** Apply settings, redraw the preview, settle the fitting pass, and read every wrapping slot. */
function snapshot(page, settings, view) {
  return page.evaluate(async ({ settings, view }) => {
    const JE = window.JellyfinEnhanced;
    Object.assign(JE.currentSettings, settings);
    window.preview.refresh();
    if (view) document.querySelector(`.je-mtp-view [data-view="${view}"]`)?.click();
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      JE.core.tagLayout.flushFit();
    }
    const wrapping = '.je-tag-caption, .je-tag-slot[data-je-slot="bottom"], .je-tag-slot[data-je-slot="hover"], .je-tag-slot[data-je-slot="tc"], .je-tag-slot[data-je-slot="bc"]';
    const slots = Array.from(document.querySelectorAll(wrapping)).map((slot) => {
      const chips = Array.from(slot.querySelectorAll(':scope > [data-je-group] > *')).filter((c) => !c.classList.contains('je-tag-more'));
      // Shown: not marked overflowing, laid out, and inside the slot's box (the caption strip clips the rest).
      const box = slot.getBoundingClientRect();
      const clips = getComputedStyle(slot).overflow !== 'visible';
      const shown = chips.filter((c) => {
        const r = c.getBoundingClientRect();
        return !c.closest('[data-je-overflow]') && r.height > 0 && (!clips || (r.bottom <= box.bottom + 0.5 && r.top >= box.top - 0.5));
      });
      // Rows: chips overlap vertically within a row (chips of different heights are centred in it).
      let rows = 0;
      let rowBottom = -Infinity;
      for (const r of shown.map((c) => c.getBoundingClientRect()).sort((a, b) => a.top - b.top)) {
        if (r.top >= rowBottom - 1) { rows++; rowBottom = r.bottom; } else rowBottom = Math.max(rowBottom, r.bottom);
      }
      return { key: `${slot.closest('[data-sample]')?.dataset.sample}/${slot.dataset.jeSlot}`,
        ids: shown.map((c) => `${c.closest('[data-je-group]').dataset.jeGroup}:${c.textContent.trim()}`),
        hidden: chips.length - shown.length, rows };
    });
    return { slots, html: document.querySelector('#preview').innerHTML.replace(/ id="je-tag-more-\d+"| aria-describedby="je-tag-more-\d+"| data-je-owner="\d+"/g, '') };
  }, { settings, view });
}

const LAYOUTS = [['caption', null], ['bands', null], ['summary', 'hover'], ['minimal', 'hover'], ['corners', null]];
for (const [layout, view] of LAYOUTS) test(`removing a group or a chip never hides more chips in ${layout}${view ? ' (hover reveal)' : ''}`, async ({ page }) => {
  test.setTimeout(240000);
  await setup(page);
  const failures = [];
  for (const width of [262, 550]) {
    await page.evaluate((w) => { document.querySelector('#preview').style.width = `${w}px`; }, width);
    for (const tagScale of ['default', 'larger']) for (const tagLabelDensity of ['full', 'compact']) {
      const look = { ...BASE, tagLayout: layout, tagScale, tagLabelDensity };
      const before = await snapshot(page, look, view);
      for (const [name, key] of Object.entries({ ...GROUPS, ...CHIPS })) {
        const after = await snapshot(page, { ...look, [key]: false }, view);
        for (const slot of after.slots) {
          const was = before.slots.find((s) => s.key === slot.key);
          if (!was) continue;
          const where = `${width}px ${tagScale}/${tagLabelDensity} ${slot.key} without ${name}`;
          // The chips of the removed group or category no longer exist: compare the others.
          if (slot.hidden > was.hidden) failures.push(`${where}: ${slot.hidden} hidden, was ${was.hidden}`);
          if (slot.hidden > 0 && slot.rows < was.rows) failures.push(`${where}: ${slot.rows} rows with chips hidden, was ${was.rows}`);
          const lost = was.ids.filter((id) => !slot.ids.includes(id) && !id.startsWith(`${name.split(':')[0]}:`));
          if (!name.includes(':') && lost.length) failures.push(`${where}: lost ${lost.join(', ')}`);
        }
        const again = await snapshot(page, look, view);
        if (again.html !== before.html) {
          let i = 0; while (i < again.html.length && again.html[i] === before.html[i]) i++;
          failures.push(`${width}px ${tagScale}/${tagLabelDensity}: turning ${name} off and on again changed the preview at …${before.html.slice(Math.max(0, i - 120), i + 80)} ⇒ ${again.html.slice(i, i + 80)}`);
        }
      }
    }
  }
  expect(failures).toEqual([]);
});
