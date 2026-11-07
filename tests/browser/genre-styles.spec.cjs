const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js');
// Shared with the backend (native pixels) and frontend suites.
const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../fixtures/genre-styles.json'), 'utf8'));

/** `rgba(r, g, b, a)` as a browser reports a computed colour. */
const rgb = (css) => {
  const [r, g, b, a] = css.match(/[\d.]+/g).map(Number);
  return a === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`;
};

test.beforeEach(async ({ page }) => {
  await page.setContent('<div id="cards"></div>');
  await page.evaluate(() => {
    window.JellyfinEnhanced = {
      currentSettings: { genreTagsEnabled: true }, pluginConfig: {}, t: key => key,
      tagPipeline: { registerRenderer(name, renderer) { this[name] = renderer; }, clearProcessed() {}, scheduleScan() {} }
    };
  });
  for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'tags/tag-styles.js', 'tags/genretags.js']) {
    await page.addScriptTag({ path: path.join(root, file) });
  }
  await page.evaluate((genres) => {
    const JE = window.JellyfinEnhanced;
    JE.initializeGenreTags();
    JE.tagPipeline.genre.injectCss();
    genres.forEach((genre, i) => {
      document.getElementById('cards').insertAdjacentHTML('beforeend', `<div class="card" style="width:180px;height:270px"><div class="cardScalable"><div class="je-tag-host" id="c${i}"></div></div></div>`);
      JE.tagPipeline.genre.renderFromServerCache(document.getElementById(`c${i}`), { Genres: [genre] });
    });
  }, fixture.cases.map(c => c.genre));
});

test('each genre chip draws the colours native posters resolve for its label', async ({ page }) => {
  await page.evaluate((web) => {
    const JE = window.JellyfinEnhanced;
    JE.core.ui.injectCss('je-tag-style-overrides', JE.tagStyles.buildCss({ genre: web }));
  }, fixture.web);
  for (const [i, c] of fixture.cases.entries()) {
    const chip = page.locator(`#c${i} .genre-tag`);
    await expect(chip).toHaveAttribute('data-je-genre', c.label);
    await expect(chip.locator('.je-msym-outlined')).toHaveText(c.icon);
    await expect(chip, c.genre).toHaveCSS('background-color', rgb(c.drawn.background));
    await expect(chip, c.genre).toHaveCSS('border-top-color', rgb(c.drawn.border));
    await expect(chip, c.genre).toHaveCSS('color', rgb(c.drawn.text));
  }
  // The name that floats out on hover takes the chip's colours when its genre has colours of its own.
  const horror = fixture.cases.findIndex(c => c.label === 'horror');
  const name = page.locator(`#c${horror} .genre-text`);
  await expect(name).toHaveCSS('background-color', rgb(fixture.cases[horror].drawn.background));
  await expect(name).toHaveCSS('color', rgb(fixture.cases[horror].drawn.text));
  // Science fiction has none: the every-genre border only, and its name as it always was.
  const scifi = page.locator(`#c${fixture.cases.findIndex(c => c.label === 'science fiction')} .genre-text`);
  await expect(scifi).toHaveCSS('background-color', 'rgba(10, 10, 10, 0.85)');
  await expect(scifi).toHaveCSS('color', 'rgb(224, 224, 224)');
});

test('whole-group genre colours and presets colour every chip but leave the names as they were', async ({ page }) => {
  for (const entry of fixture.legacy.filter(e => e.preset !== 'poster')) {
    // The chip colour as the browser rounds it (0.161 alpha reads back as 0.16).
    const background = await page.evaluate(({ preset, genre }) => {
      const JE = window.JellyfinEnhanced;
      JE.core.ui.injectCss('je-tag-style-overrides', JE.tagStyles.buildCss({ preset, genre }));
      const probe = document.createElement('i');
      probe.style.backgroundColor = genre['*'].background;
      document.body.appendChild(probe);
      const drawn = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return drawn;
    }, entry);
    for (const [i] of fixture.cases.entries()) {
      const chip = page.locator(`#c${i} .genre-tag`);
      await expect(chip, entry.name).toHaveCSS('background-color', background);
      await expect(chip.locator('.genre-text'), entry.name).toHaveCSS('color', 'rgb(224, 224, 224)');
      await expect(chip.locator('.genre-text'), entry.name).toHaveCSS('background-color', 'rgba(10, 10, 10, 0.85)');
    }
  }
});

test('without Tag Styles the genre chips keep their built-in colours', async ({ page }) => {
  for (const [i] of fixture.cases.entries()) {
    const chip = page.locator(`#c${i} .genre-tag`);
    await expect(chip).toHaveCSS('background-color', rgb(fixture.builtin.background));
    await expect(chip).toHaveCSS('color', rgb(fixture.builtin.text));
    await expect(chip.locator('.genre-text')).toHaveCSS('color', 'rgb(224, 224, 224)');
    await expect(chip.locator('.genre-text')).toHaveCSS('background-color', 'rgba(10, 10, 10, 0.85)');
  }
});

test('the hover reveal writes the name inline in the chip colour without its own background', async ({ page }) => {
  await page.evaluate((web) => {
    const JE = window.JellyfinEnhanced;
    JE.core.ui.injectCss('je-tag-style-overrides', JE.tagStyles.buildCss({ genre: web }));
    // A reveal slot as the layout controller builds it: a copy of the genre group.
    const master = document.querySelector('#c0 .genre-overlay-container');
    const slot = document.createElement('div');
    slot.className = 'je-tag-slot';
    slot.dataset.jeSlot = 'hover';
    slot.id = 'reveal';
    slot.appendChild(master.cloneNode(true));
    document.querySelector('#c0').appendChild(slot);
    JE.core.ui.injectCss('reveal-test', '.je-tag-slot[data-je-slot="hover"] .genre-tag .genre-text { position: static; opacity: 1; background: none; }');
  }, fixture.web);
  const name = page.locator('#reveal .genre-text');
  await expect(name).toHaveCSS('color', rgb(fixture.cases[0].drawn.text));
  await expect(name).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
});
