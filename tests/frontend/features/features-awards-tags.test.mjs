import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain } from '../helpers/harness.mjs';

/** Render through the real factory/controller using both cache and fallback DTOs. */
function setup(t, settings = {}, plugin = {}) {
    const renderers = new Map();
    const h = createHarness({ html: '<div class="card" data-id="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" data-type="Movie"><div class="cardBox"><div class="cardScalable"><div class="cardImageContainer"></div><div class="je-tag-host"></div></div><div class="cardText">Title</div></div></div>',
        JE: { currentSettings: { awardsTagsEnabled: true, tagLayoutSettingsVersion: 1, ...settings }, pluginConfig: { AwardsTagsEnabled: true, ...plugin },
            t: (key, params) => key + (params?.rank ? ':' + params.rank : ''),
            tagPipeline: { registerRenderer: (id, renderer) => renderers.set(id, renderer), getRenderer: id => renderers.get(id), clearProcessed() {}, scheduleScan() {} } } });
    t.after(() => h.close());
    for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/awardstags.js', 'tags/tag-styles.js']) h.load(file);
    h.JE.initializeAwardsTags();
    const host = h.document.querySelector('.je-tag-host');
    return { ...h, host, render: facts => renderers.get('awards').renderFromServerCache(host, { Awards: facts }, 'item'),
        batch: facts => renderers.get('awards').render(host, { Id: 'item', Type: 'Movie', Awards: facts }, {}),
        chips: () => [...h.document.querySelectorAll('.awards-tag')] };
}
const facts = { ImdbRank: 12, CertifiedFresh: true, OscarWinner: true, OscarYear: 2024, EmmyWinner: true, EmmyYear: 2023, LetterboxdRank: 24 };

test('Awards uses bounded real membership facts and the same five decorative logos for cache and batch', t => {
    const h = setup(t, { tagGroupCaps: { awards: 0 } });
    h.render(facts);
    assert.deepEqual(h.chips().map(el => el.dataset.jeAward), ['imdbTop250', 'certifiedFresh', 'oscar', 'emmy', 'letterboxdTop250']);
    for (const chip of h.chips()) { assert.ok(chip.querySelector('svg path')); assert.equal(chip.querySelector('img'), null); }
    assert.match(h.chips()[0].title, /12/); assert.match(h.chips()[2].title, /2024/);
    h.batch(facts);
    assert.equal(h.chips().length, 5);
    h.render({ ImdbRank: 251, LetterboxdRank: -1, CertifiedFresh: false, OscarWinner: false });
    assert.equal(h.chips().length, 0);
});

test('Awards honors personal caps, off slots, administrator ribbon gates, and default-off master', t => {
    const h = setup(t);
    h.render(facts); assert.equal(h.chips().length, 2);
    h.JE.pluginConfig.AwardsTagsImdb = false;
    h.render(facts); assert.equal(h.chips()[0].dataset.jeAward, 'certifiedFresh');
    h.JE.pluginConfig.AwardsTagsEnabled = false;
    h.render(facts); assert.equal(h.chips().length, 0);
    assert.equal(h.JE.core.tagLayout.normalizeGroup('awards'), 'awards');
    assert.equal(h.JE.core.tagLayout.normalizeSettings().caps.awards, 2);
});

test('Awards participates in Caption, Summary, cleanup and group/per-label style selectors', t => {
    const h = setup(t, { tagLayout: 'caption' });
    h.render(facts);
    assert.equal(h.document.querySelectorAll('.je-tag-caption .awards-tag').length, 2);
    h.JE.core.tagLayout.removeGroupEverywhere('awards');
    assert.equal(h.chips().length, 0);
    const css = h.JE.tagStyles.buildCss({ awards: { oscar: { background: 'rgba(18, 52, 86, 1)', color: 'rgba(255, 255, 255, 1)', border: 'rgba(171, 205, 239, 1)' } } });
    assert.match(css, /awards-overlay-container .*data-je-award="oscar"/);
    assert.match(css, /18, 52, 86/); assert.match(css, /outline/);
    assert.deepEqual(plain(h.JE.awardsTags.resolve(null)), []);
});

test('a disabled Awards group adds no legacy DOM or caption reservation even when its catalog profile exists', t => {
    const h = setup(t, { awardsTagsEnabled: false, tagLayoutSettingsVersion: 0 });
    const before = h.host.outerHTML;
    // The pipeline only calls enabled renderers; registering the new group must be inert.
    h.JE.reinitializeAwardsTags();
    assert.equal(h.host.outerHTML, before);
    assert.equal(h.document.querySelector('.je-tag-caption'), null);
    assert.equal(h.document.querySelector('.awards-tag'), null);
});
