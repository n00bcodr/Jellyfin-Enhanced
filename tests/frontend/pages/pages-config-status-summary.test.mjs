// D92: the two phase-1 status switches for the series-page summary chips and the administrators' Sonarr/Radarr line:
// real labels in the status block, off for a saved configuration that never had them, saved back as set, and shown
// under the status switch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness } from '../helpers/harness.mjs';
import { repositoryRoot } from '../helpers/discovery.mjs';

const page = readFileSync(resolve(repositoryRoot, 'Jellyfin.Plugin.JellyfinEnhanced/Configuration/configPage.html'), 'utf8');
function section(start, end) {
    const from = page.indexOf(start);
    const to = page.indexOf(end, from);
    assert.ok(from >= 0 && to > from, start);
    return page.slice(from, to);
}
const IDS = ['arrStatusSeasonSummaryEnabled', 'arrStatusAdminLineEnabled'];
const FIELDS = ['ArrStatusSeasonSummaryEnabled', 'ArrStatusAdminLineEnabled'];
const html = section('                            <div class="checkboxContainer"><label><input id="arrStatusPosterBadges"', '                            <div class="inputContainer">\n                                <label class="inputLabel" for="arrStatusLookingHours">');
const load = section("                document.querySelector('#arrStatusPosterBadges').checked", "                document.querySelector('#arrStatusLookingHours').value");
const save = section("            config.ArrStatusPosterBadges =", "            var __lookingHours =");
const parents = section('        var PARENT_DEPS = [', '        ];') + '        ];';

/** The status block's switches with the page's own load and save lines for them. */
function setup(t) {
    const h = createHarness({ html });
    t.after(() => h.close());
    h.window.eval(`window.load = function(config) { ${load} }; window.save = function(config) { ${save} }; ${parents} window.deps = PARENT_DEPS;`);
    return h;
}

test('D92: both switches sit in the status block after the poster badges, with real labels', t => {
    const h = setup(t);
    const labels = IDS.map(id => h.document.querySelector(`label:has(#${id}) span`)?.textContent);
    assert.deepEqual(labels, ['Show the season summary on series pages', 'Show the Sonarr/Radarr status line to admins']);
    for (const id of IDS) assert.ok(h.document.querySelector(`[data-desc-for="${id}"] .fieldDescription`).textContent.length > 40, id);
    assert.ok(!html.includes('${'), 'Jellyfin rewrites ${ in the config page');
});

test('D92: off for a configuration saved before they existed; saved back as set', t => {
    const h = setup(t);
    h.window.load({ ArrStatusPosterBadges: true });
    for (const id of IDS) assert.equal(h.document.getElementById(id).checked, false, id);
    let out = {};
    h.window.save(out);
    assert.deepEqual(FIELDS.map(f => out[f]), [false, false]);

    h.window.load({ ArrStatusPosterBadges: true, ArrStatusSeasonSummaryEnabled: true, ArrStatusAdminLineEnabled: false });
    out = {};
    h.window.save(out);
    assert.deepEqual(FIELDS.map(f => out[f]), [true, false]);
    h.document.getElementById('arrStatusAdminLineEnabled').checked = true;
    h.document.getElementById('arrStatusSeasonSummaryEnabled').checked = false;
    out = {};
    h.window.save(out);
    assert.deepEqual(FIELDS.map(f => out[f]), [false, true]);
});

test('D92: both switches are shown under the status switch', t => {
    const deps = setup(t).window.deps;
    for (const id of IDS) {
        assert.deepEqual(JSON.parse(JSON.stringify(deps.filter(d => d.children.includes(id)).map(d => d.parent))), ['arrPhase1Enabled'], id);
    }
});
