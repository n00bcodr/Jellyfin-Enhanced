import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHarness, plain } from '../helpers/harness.mjs';
const settle = async () => { await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); };
const wait = (h, ms = 40) => new Promise(r => h.window.setTimeout(r, ms));
function load(h, file) {
    if (process.env.SEERR_R2_JS) h.window.eval(readFileSync(join(process.env.SEERR_R2_JS, 'jellyseerr', file), 'utf8'));
    else h.load('jellyseerr/' + file);
}
function details(requestStatus, mode, has4k = true) {
    return { seasons: [{ seasonNumber: 1, episodeCount: 10, airDate: '2020-01-01' }], externalIds: { tvdbId: 123 },
        mediaInfo: { jellyfinMediaId: 'regular-series', ...(has4k ? { jellyfinMediaId4k: 'fourk-series' } : {}),
            seasons: [{ seasonNumber: 1, status: 5, status4k: 5 }],
            requests: requestStatus === null ? [] : [{ is4k: mode, seasons: [{ seasonNumber: 1, status: requestStatus }] }] } };
}
function seasonHarness(t, data, present = () => false) {
    const posts = [], lookups = [];
    const h = createHarness({
        apiClient: {
            getUrl: (path, params) => 'http://jellyfin.test' + path + (params ? '?' + new URLSearchParams(params) : ''),
            ajax: async request => { lookups.push(request.url); return { Items: present(request.url) ? [{ IndexNumber: 1 }] : [] }; },
        },
        JE: { t: k => k, escapeHtml: v => String(v ?? ''), toast() {}, pluginConfig: { JellyseerrEnabled: true },
            core: { ui: { isTvLayout: () => false }, api: {
                fetch: async url => url.endsWith('/settings/partial-requests') ? { partialRequestsEnabled: true } : url.includes('/tv/') ? data : {},
                plugin: async (path, request) => { posts.push({ path, body: plain(request.body) }); return { id: 7 }; },
            } },
        },
    });
    t.after(() => h.close());
    for (const file of ['seerr-status.js', 'api.js', 'ui/ui-icons.js', 'ui/ui-results.js', 'ui/ui-quota.js', 'modal.js', 'ui/ui-season-modal.js']) load(h, file);
    return { ...h, posts, lookups };
}
for (const mode of [false, true]) for (const request of [1, 2]) {
    test('R2 active season request blocks duplicate submission after missing library season: ' + request + ' 4K=' + mode, async t => {
        const h = seasonHarness(t, details(request, mode));
        await h.JE.jellyseerrUI.showSeasonSelectionModal(42, 'tv', 'Show', null, mode);
        const box = h.document.querySelector('.jellyseerr-season-item input');
        assert.equal(box.disabled, true);
        box.checked = true; // Defensive submit boundary must also reject a stale selection.
        h.document.querySelector('.jellyseerr-modal-button-primary').click(); await settle();
        assert.deepEqual(h.posts, []);
    });
}
for (const mode of [false, true]) for (const request of [3, 4, 5]) {
    test('R2 historical request does not block missing season: ' + request + ' 4K=' + mode, async t => {
        const h = seasonHarness(t, details(request, mode));
        await h.JE.jellyseerrUI.showSeasonSelectionModal(42, 'tv', 'Show', null, mode);
        const box = h.document.querySelector('.jellyseerr-season-item input');
        assert.equal(box.disabled, false); box.checked = true;
        h.document.querySelector('.jellyseerr-modal-button-primary').click(); await settle();
        assert.equal(h.posts.length, 1); assert.deepEqual(h.posts[0].body.seasons, [1]);
        assert.equal(h.posts[0].body.is4k, mode ? true : undefined); // Normal requests preserve the omitted wire field.
    });
}
for (const mode of [false, true]) test('R2 present library season remains available: 4K=' + mode, async t => {
    const h = seasonHarness(t, details(1, mode), () => true);
    await h.JE.jellyseerrUI.showSeasonSelectionModal(42, 'tv', 'Show', null, mode);
    assert.equal(h.document.querySelector('.jellyseerr-season-item input').disabled, true);
    assert.match(h.document.querySelector('.jellyseerr-season-item').textContent, /jellyseerr_season_status_available/);
});
for (const mode of [false, true]) test('R2 season presence queries selected quality only: 4K=' + mode, async t => {
    const h = seasonHarness(t, details(null, mode), url => url.includes('regular-series'));
    await h.JE.jellyseerrUI.showSeasonSelectionModal(42, 'tv', 'Show', null, mode);
    assert.equal(h.lookups.length, 1);
    assert.match(h.lookups[0], mode ? /fourk-series/ : /regular-series/);
    assert.equal(h.document.querySelector('.jellyseerr-season-item input').disabled, !mode);
});
test('R2 missing 4K series id never falls back to regular series presence', async t => {
    const h = seasonHarness(t, details(null, true, false), () => true);
    await h.JE.jellyseerrUI.showSeasonSelectionModal(42, 'tv', 'Show', null, true);
    assert.deepEqual(h.lookups, []);
    assert.equal(h.document.querySelector('.jellyseerr-season-item input').disabled, false);
});
function modalHarness(t, tv = false) {
    const h = createHarness({ JE: { t: k => k, core: { ui: { isTvLayout: () => tv } } } });
    t.after(() => h.close()); load(h, 'modal.js');
    h.window.history.replaceState({ route: 'host' }, '', '#/host');
    const make = (onClose = () => {}, bodyHtml = '') => h.JE.jellyseerrModal.create({ title: 'T', subtitle: 'S', bodyHtml, onSave() {}, onClose });
    return { ...h, make };
}
test('R2 modal close cannot undo a route created by onClose', async t => {
    const h = modalHarness(t);
    const first = h.make(() => h.window.history.pushState({ route: 'next' }, '', '#/next'));
    first.show(); first.close(); await wait(h);
    assert.equal(h.window.location.hash, '#/next');
    assert.deepEqual(plain(h.window.history.state), { route: 'next' });
});
test('R2 replacement modal keeps history ownership through reentrant close', async t => {
    const h = modalHarness(t); let next;
    const first = h.make(() => { next = h.make(); next.show(); });
    first.show(); first.close(); await wait(h);
    assert.equal(next.modalElement.getAttribute('aria-hidden'), null);
    next.close(); await wait(h, 80);
    assert.deepEqual(plain(h.window.history.state), { route: 'host' });
});
for (const dismissal of ['close', 'back']) test('R2 disposed TV picker leaves next dialog Escape and focus intact: ' + dismissal, async t => {
    const h = modalHarness(t, true);
    const first = h.make(() => {}, '<select><option>One</option><option>Two</option></select>');
    first.show(); first.modalElement.querySelector('select').click();
    assert.ok(h.document.querySelector('.jellyseerr-tv-picker'));
    if (dismissal === 'back') h.window.history.back(); else first.close();
    await wait(h, 350); assert.equal(first.modalElement.isConnected, false);
    const next = h.make(); next.show(); await wait(h);
    const event = new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    h.document.dispatchEvent(event); await wait(h);
    assert.equal(next.modalElement.getAttribute('aria-hidden'), 'true');
    assert.equal(h.document.querySelector('.jellyseerr-tv-picker'), null);
    assert.equal(first.modalElement.contains(h.document.activeElement), false);
});
for (const mode of [false, true]) test('R2 request event keeps normal and 4K controls independent: 4K=' + mode, t => {
    const h = createHarness({ JE: { t: k => k } }); t.after(() => h.close());
    for (const file of ['seerr-status.js', 'ui/ui-icons.js', 'ui/ui-results.js']) load(h, file);
    const card = (id, type) => '<div class="jellyseerr-card"><span class="jellyseerr-status-badge">original</span><div class="jellyseerr-button-group"><button class="jellyseerr-request-button jellyseerr-split-main jellyseerr-button-request" data-tmdb-id="' + id + '" data-media-type="' + type + '">Request</button><button class="jellyseerr-split-arrow"></button></div></div>';
    h.document.body.innerHTML = card(42, 'movie') + card(42, 'tv') + card(43, 'movie');
    h.document.dispatchEvent(new h.window.CustomEvent('jellyseerr-media-requested', { detail: { tmdbId: 42, mediaType: 'movie', is4k: mode } }));
    const cards = [...h.document.querySelectorAll('.jellyseerr-card')];
    assert.equal(cards[0].querySelector('.jellyseerr-split-main').disabled, !mode);
    assert.equal(cards[0].querySelector('.jellyseerr-split-arrow').disabled, mode);
    if (mode) assert.equal(cards[0].querySelector('.jellyseerr-status-badge').textContent, 'original');
    else assert.match(cards[0].querySelector('.jellyseerr-status-badge').className, /status-requested/);
    for (const other of cards.slice(1)) {
        assert.equal(other.querySelector('.jellyseerr-split-main').disabled, false);
        assert.equal(other.querySelector('.jellyseerr-split-arrow').disabled, false);
        assert.equal(other.querySelector('.jellyseerr-status-badge').textContent, 'original');
    }
});
