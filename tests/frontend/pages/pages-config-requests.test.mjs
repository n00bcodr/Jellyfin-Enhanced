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
    assert.ok(from >= 0 && to > from);
    return page.slice(from, to);
}
const html = section('                            <div class="checkboxContainer"><label><input id="arrPhase3Enabled"', '                            <div class="checkboxContainer"><label><input id="arrPhase2Enabled"');
const load = section("            document.querySelector('#arrPhase3Enabled').checked", "            document.querySelector('#arrPhase2Enabled').checked");
const save = section("            config.ArrPhase3Enabled =", "            config.ArrPhase2Enabled =");
const parents = section('        var PARENT_DEPS = [', '        ];') + '        ];';

test('durable request settings round trip through actual config-page wiring without load traffic', t => {
    const h = createHarness({ html });
    t.after(() => h.close());
    h.window.eval(`window.loadRequests = function(config) { ${load} }; window.saveRequests = function(config) { ${save} }; ${parents} window.requestParents = PARENT_DEPS;`);
    const config = {
        ArrPhase3Enabled: false, ArrRequestBackend: 'seerr', ArrRequest4kMoviesEnabled: false, ArrRequest4kSeriesEnabled: false, ArrRequestPreset: 'ask_first', ArrRequestDefaultRole: 'Watcher', ArrRequestUsers: '{}', ArrRequestRoles: '{}',
        ArrRequestQuotaLimit: 0, ArrRequestQuotaWindowDays: 7, ArrRequestSeriesThreshold: 4, ArrRequestDeclineCooldownDays: 7, ArrRequestPendingLimit: 10,
        ArrRequestQuotaGb: 0, ArrRequestStaleDays: 30, ArrRequestChargeFutureSeasons: true, ArrKidsHideSearch: false
    };
    h.window.loadRequests(config);
    const result = {};
    h.window.saveRequests(result);
    assert.deepEqual(result, config);
    h.document.getElementById('arrRequestUsers').value = '{"person":{"Role":"Manager","FourKInstances":["4k"]}}';
    h.document.getElementById('arrRequestBackend').value = 'je';
    h.document.getElementById('arrPhase3Enabled').checked = true;
    h.document.getElementById('arrRequestQuotaLimit').value = '3';
    h.document.getElementById('arrKidsHideSearch').checked = true;
    h.window.saveRequests(result);
    assert.equal(result.ArrKidsHideSearch, true);
    assert.match(h.document.querySelector('label:has(#arrKidsHideSearch) span').textContent, /^Hide free-text search from Kids$/);
    assert.equal(result.ArrRequestBackend, 'je');
    assert.equal(result.ArrRequestQuotaLimit, 3);
    assert.equal(result.ArrPhase3Enabled, true);
    assert.equal(JSON.parse(result.ArrRequestUsers).person.Role, 'Manager');
    const phase1 = h.window.requestParents.find(p => p.parent === 'arrPhase1Enabled');
    const phase3 = h.window.requestParents.find(p => p.parent === 'arrPhase3Enabled');
    assert.ok(phase1.children.includes('arrPhase3Enabled'));
    assert.equal(phase3.children.length, Object.keys(config).length - 1);
    assert.equal(h.document.querySelector('#arrRequestLabEnabled'), null);
});
