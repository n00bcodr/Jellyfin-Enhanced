// Phase 4e (D29): the configuration page's acquisition-badge block: two switches (web badges, native-poster stamps)
// and two lifetimes (1–30 days, 7 by default), loaded and saved with the phase-4 settings, and their parents (the
// badges under phase 4; native stamps under the badges and Native Poster Tags; the lifetimes under the badges).
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
const html = section('                            <!-- Requests & downloads, phase 4', '                            <!-- /Requests & downloads, phase 4 -->');
const functions = section('        /** The automation recipes the page lists', '        async function jeArrMigrationError(e) {');
const createEl = section('        function createEl(tag, attrs, children) {', '        // ==================== Stored credentials');
const parents = section('        var PARENT_DEPS = [', '        ];') + '        ];';

/** The phase-4 section and its load/save functions in a harness. */
function setup(t) {
    const h = createHarness({ html });
    t.after(() => h.close());
    h.window.ApiClient = { getUrl: path => path, ajax: async () => ({}) };
    h.window.eval(`${createEl} ${functions} ${parents} window.load = jeLoadArrAutomationSettings; window.save = jeSaveArrAutomationSettings; window.deps = PARENT_DEPS;`);
    return h;
}

test('the block sits right after the lists block, with real labels for every setting', t => {
    const block = section('<!-- Phase 4e: acquisition badges -->', '<!-- /Phase 4e: acquisition badges -->');
    assert.ok(page.indexOf('<!-- /Phase 4c1: lists -->') < page.indexOf('<!-- Phase 4e: acquisition badges -->'));
    assert.match(page, /<!-- \/Phase 4c1: lists -->\s*(?:<!-- Phase 4c3a: list pages -->[\s\S]*?<!-- \/Phase 4c3a: list pages -->\s*)?<!-- Phase 4e: acquisition badges -->/);
    const h = setup(t);
    for (const id of ['arrPhase4AcquisitionBadgesEnabled', 'arrPhase4NativeStampsEnabled', 'arrAcquisitionNewDays', 'arrAcquisitionUpgradedDays']) {
        assert.ok(block.includes(`id="${id}"`), id);
        const input = h.document.getElementById(id);
        const label = input.closest('label')?.querySelector('span') || h.document.querySelector(`label[for="${id}"]`);
        assert.ok(label && label.textContent.trim().length > 5, `${id} has a label`);
    }
    for (const id of ['arrAcquisitionNewDays', 'arrAcquisitionUpgradedDays']) {
        const input = h.document.getElementById(id);
        assert.deepEqual([input.type, input.min, input.max], ['number', '1', '30']);
    }
    assert.ok(!block.includes('${'), 'Jellyfin rewrites ${ in the config page');
});

test('acquisition settings round trip; the lifetimes are clamped to 1–30 and default to 7', t => {
    const h = setup(t);
    h.window.load({ ArrPhase4AcquisitionBadgesEnabled: true, ArrPhase4NativeStampsEnabled: true, ArrAcquisitionNewDays: 3, ArrAcquisitionUpgradedDays: 21 });
    assert.equal(h.document.getElementById('arrPhase4AcquisitionBadgesEnabled').checked, true);
    assert.equal(h.document.getElementById('arrPhase4NativeStampsEnabled').checked, true);
    let out = {};
    h.window.save(out);
    assert.deepEqual([out.ArrPhase4AcquisitionBadgesEnabled, out.ArrPhase4NativeStampsEnabled, out.ArrAcquisitionNewDays, out.ArrAcquisitionUpgradedDays], [true, true, 3, 21]);

    for (const [typed, want] of [['0', 1], ['-5', 1], ['31', 30], ['999', 30], ['', 7], ['abc', 7], ['12', 12], ['1', 1], ['30', 30]]) {
        h.document.getElementById('arrAcquisitionNewDays').value = typed;
        h.document.getElementById('arrAcquisitionUpgradedDays').value = typed;
        out = {};
        h.window.save(out);
        assert.deepEqual([out.ArrAcquisitionNewDays, out.ArrAcquisitionUpgradedDays], [want, want], JSON.stringify(typed));
    }

    // An older saved configuration: both switches off, 7 days each.
    h.window.load({});
    out = {};
    h.window.save(out);
    assert.deepEqual([out.ArrPhase4AcquisitionBadgesEnabled, out.ArrPhase4NativeStampsEnabled, out.ArrAcquisitionNewDays, out.ArrAcquisitionUpgradedDays], [false, false, 7, 7]);
});

test('the switch hierarchy: badges under phase 4; native stamps under the badges and Native Poster Tags; lifetimes under the badges', t => {
    const deps = setup(t).window.deps;
    const parentsOf = id => JSON.parse(JSON.stringify(deps.filter(d => d.children.includes(id)).map(d => d.parent).sort()));
    assert.deepEqual(parentsOf('arrPhase4AcquisitionBadgesEnabled'), ['arrPhase4Enabled']);
    assert.deepEqual(parentsOf('arrPhase4NativeStampsEnabled'), ['arrPhase4AcquisitionBadgesEnabled', 'nativePosterTagsEnabled']);
    assert.deepEqual(parentsOf('arrAcquisitionNewDays'), ['arrPhase4AcquisitionBadgesEnabled']);
    assert.deepEqual(parentsOf('arrAcquisitionUpgradedDays'), ['arrPhase4AcquisitionBadgesEnabled']);
    // The Native Poster Tags switch the stamps depend on exists on the page.
    assert.match(page, /<input id="nativePosterTagsEnabled" is="emby-checkbox" type="checkbox"\/>/);
});
