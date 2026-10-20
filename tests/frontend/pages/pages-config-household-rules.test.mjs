import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness } from '../helpers/harness.mjs';
import { repositoryRoot } from '../helpers/discovery.mjs';

// Requests & downloads, phase 4b on the configuration page: the household rules, group quotas and Seerr request
// options switches (load, save, defaults, hierarchy) and the Household-tab settings a page save never overwrites.
const page = readFileSync(resolve(repositoryRoot, 'Jellyfin.Plugin.JellyfinEnhanced/Configuration/configPage.html'), 'utf8');
function section(start, end) {
    const from = page.indexOf(start);
    const to = page.indexOf(end, from);
    assert.ok(from >= 0 && to > from, start);
    return page.slice(from, to);
}
const html = section('                            <!-- Requests & downloads, phase 4b', '                            <!-- /Requests & downloads, phase 4b -->');
const functions = section('        // ==================== Requests & downloads, phase 4b', '        // ==================== /Requests & downloads, phase 4b');
const parents = section('        var PARENT_DEPS = [', '        ];') + '        ];';
const IDS = ['arrPhase4HouseholdRulesEnabled', 'arrPhase4GroupQuotasEnabled', 'arrPhase4SeerrRequestOptionsEnabled'];
const FIELDS = ['ArrPhase4HouseholdRulesEnabled', 'ArrPhase4GroupQuotasEnabled', 'ArrPhase4SeerrRequestOptionsEnabled'];

/**
 * A harness with the phase-4b block and its functions.
 * @returns {object} Harness.
 */
function setup() {
    const h = createHarness({ html });
    h.window.eval(`${functions} ${parents} window.load = jeLoadArrPhase4bSettings; window.save = jeSaveArrPhase4bSettings; window.deps = PARENT_DEPS;`);
    return h;
}

test('the phase-4b switches have real labels and help that says where the rules are edited and that they start off', t => {
    const h = setup();
    t.after(() => h.close());
    const label = id => h.document.querySelector(`label:has(#${id}) span`).textContent;
    assert.equal(label('arrPhase4HouseholdRulesEnabled'), 'Household rules: the Trusted role and fixed conditions per role');
    assert.equal(label('arrPhase4GroupQuotasEnabled'), 'Group quotas (shared request pools)');
    assert.equal(label('arrPhase4SeerrRequestOptionsEnabled'), "Administrators pick Seerr's server, profile and folder");
    const help = id => h.document.querySelector(`[data-desc-for="${id}"]`).textContent;
    assert.match(help('arrPhase4HouseholdRulesEnabled'), /Requests page under Household/);
    assert.match(help('arrPhase4HouseholdRulesEnabled'), /Jellyfin Enhanced handling requests/);
    assert.match(help('arrPhase4HouseholdRulesEnabled'), /Seerr's own rules apply/);
    for (const id of IDS) assert.match(help(id), /Off by default/, id);
});

test('phase-4b switches round trip; an older configuration loads them all off', t => {
    const h = setup();
    t.after(() => h.close());
    h.window.load({ ArrPhase4HouseholdRulesEnabled: true, ArrPhase4GroupQuotasEnabled: false, ArrPhase4SeerrRequestOptionsEnabled: true });
    assert.deepEqual(IDS.map(id => h.document.getElementById(id).checked), [true, false, true]);
    h.document.getElementById('arrPhase4GroupQuotasEnabled').checked = true;
    const out = {};
    h.window.save(out);
    assert.deepEqual(FIELDS.map(f => out[f]), [true, true, true]);
    h.window.load({});
    const off = {};
    h.window.save(off);
    assert.deepEqual(FIELDS.map(f => off[f]), [false, false, false]);
});

test('a page save never carries the Household-tab rules and pools (only the Household tab edits them)', t => {
    const h = setup();
    t.after(() => h.close());
    h.window.load({});
    const config = { ArrHouseholdRules: '{"roles":{"kid":{}}}', ArrHouseholdStreamingCountry: 'GB', ArrHouseholdStreamingServices: '8,9', ArrGroupQuotaPools: '[]' };
    h.window.save(config);
    // The form leaves them as they are (so a save's patch never names them) and writes no read marker.
    assert.equal(config.ArrHouseholdRules, '{"roles":{"kid":{}}}');
    assert.equal(config.ArrGroupQuotaPools, '[]');
    assert.equal(config.ArrServerOwnedSeen, undefined);
});

test('the switch hierarchy: all three under phase 4 and phase 3, group quotas under household rules', t => {
    const h = setup();
    t.after(() => h.close());
    const deps = h.window.deps;
    const child = (parent, id) => deps.find(d => d.parent === parent).children.includes(id);
    for (const id of IDS) {
        assert.ok(child('arrPhase4Enabled', id), id);
        assert.ok(child('arrPhase3Enabled', id), id);
    }
    assert.ok(child('arrPhase4HouseholdRulesEnabled', 'arrPhase4GroupQuotasEnabled'));
    assert.ok(!child('arrPhase4HouseholdRulesEnabled', 'arrPhase4SeerrRequestOptionsEnabled'));
});

test('the page loads and saves the phase-4b switches with the phase-4 automation settings', () => {
    assert.match(page, /jeLoadArrAutomationSettings\(config\);\n\s+jeLoadArrPhase4bSettings\(config\);/);
    assert.match(page, /jeSaveArrAutomationSettings\(config\);\n\s+jeSaveArrPhase4bSettings\(config\);/);
    // Inside the phase-4 block, after the automation settings.
    const phase4 = section('                            <!-- Requests & downloads, phase 4:', '                            <!-- /Requests & downloads, phase 4 -->');
    assert.ok(phase4.indexOf('arrAutomationStatusBtn') < phase4.indexOf('arrPhase4HouseholdRulesEnabled'));
});
