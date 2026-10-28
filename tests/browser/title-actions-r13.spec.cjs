// D46 slice 2 review round 13, in Chromium: a reconciliation pass over a long grid stays under the 50 ms long-task
// budget (cold 1000 cards, 500 → 1000, an unchanged pass, the host's own mutation-driven pass, removal) and releases what
// the removed cards held without another mint; the Seerr request forms are dialogs named by their own title in
// Chromium's accessibility tree; Hide inside More Info offers an Undo the viewer can reach, focus and press while the
// window stays open; and another Jellyfin client's remote Back (jellyfin-web's real server-message → input-manager →
// router path, on a real WebSocket) closes only the top JE surface, then reaches the router. Offline: only the server
// (fetch) is scripted; the remote server is a loopback WebSocket in this process.
const { writeFileSync } = require('node:fs');
const { test, expect } = require('@playwright/test');
const { read, boot, press, loadHost, remoteServer } = require('./title-actions-host.cjs');

test.skip(({ browserName }) => browserName !== 'chromium', 'checked with Chromium\'s own input, long-task timing and accessibility tree');

const BUDGET_MS = 50;

/** Starts recording long tasks and long animation frames (before any pass is measured). */
const observeTasks = page => page.evaluate(() => {
  window.perf = { tasks: [], frames: [] };
  new PerformanceObserver(list => { for (const e of list.getEntries()) window.perf.tasks.push({ start: e.startTime, duration: e.duration }); }).observe({ type: 'longtask' });
  new PerformanceObserver(list => {
    for (const e of list.getEntries()) window.perf.frames.push({ start: e.startTime, duration: e.duration, scripts: (e.scripts || []).map(s => ({ invoker: s.invoker, duration: s.duration })) });
  }).observe({ type: 'long-animation-frame' });
});
/** Adds `n` discovery cards (titles from `from`) to the grid in one task; the host's observer schedules its own pass. */
const addCards = (page, n, from) => page.evaluate(({ n, from }) => {
  let grid = document.getElementById('grid');
  if (!grid) { grid = document.createElement('div'); grid.id = 'grid'; document.body.append(grid); }
  const html = [];
  for (let i = 0; i < n; i++) html.push(`<div class="je-discover-card" style="display:inline-block;width:96px;height:144px;margin:4px;position:relative" data-je-hide-title="movie:tmdb:${from + i}" data-je-hide-name="Movie ${from + i}"><div class="je-discover-poster-box">Poster</div></div>`);
  performance.mark('cards-added');
  grid.insertAdjacentHTML('beforeend', html.join(''));
}, { n, from });
const drawnCount = page => page.evaluate(() => document.querySelectorAll('#grid .je-card-more').length);
/** Waits for two rendered frames (the host's own pass runs in the first). */
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50)))));
/** Long tasks and long animation frames that started at or after `since` (a performance.now() reading). */
const slowSince = (page, since) => page.evaluate(since => ({ tasks: window.perf.tasks.filter(t => t.start >= since), frames: window.perf.frames.filter(f => f.start + f.duration >= since) }), since);
/**
 * One explicit reconciliation pass: its first slice is timed synchronously, and the long tasks from its start to two
 * frames after it (its later slices) are returned.
 */
async function timedPass(page) {
  const { since, firstSliceMs } = await page.evaluate(() => {
    const since = performance.now(); window.JellyfinEnhanced.titleActions.scan(); return { since, firstSliceMs: performance.now() - since };
  });
  await frames(page);
  const slow = await slowSince(page, since);
  return { firstSliceMs, longest: Math.max(0, ...slow.tasks.map(t => t.duration)), longTasks: slow.tasks };
}

test('a long grid: every reconciliation pass stays under the 50 ms long-task budget, and removal releases its records at once', async ({ page }, info) => {
  const host = await boot(page);
  await observeTasks(page);
  const evidence = { browser: info.project.name, budgetMs: BUDGET_MS, passes: [] };
  const baseline = await page.evaluate(() => window.JellyfinEnhanced.titleActions.registrySize());
  // Control: the same 1000 cards with the action bar off — what the host's grid itself costs to render (recorded, so
  // a slow frame is attributed to the host's own insertion and layout rather than to a pass).
  {
    const since = await page.evaluate(() => { window.JellyfinEnhanced.pluginConfig.NativeAbsentDetailsEnabled = false; return performance.now(); });
    await addCards(page, 1000, 900000);
    await frames(page);
    const slow = await slowSince(page, since);
    evidence.passes.push({ name: 'control: 1000 cards, action bar off', cards: 1000, longTasks: slow.tasks, longFrames: slow.frames });
    await page.evaluate(() => { document.getElementById('grid').remove(); window.JellyfinEnhanced.pluginConfig.NativeAbsentDetailsEnabled = true; });
    await frames(page);
  }
  /** Records the host's own (mutation-driven) pass after `add`, with the slow tasks/frames from its start. */
  async function hostPass(name, add, expected) {
    const since = await page.evaluate(() => performance.now());
    await add();
    await expect.poll(() => drawnCount(page)).toBe(expected);
    await frames(page);
    const slow = await slowSince(page, since);
    const longest = Math.max(0, ...slow.tasks.map(t => t.duration));
    const rafScripts = slow.frames.flatMap(f => f.scripts).filter(s => s.invoker === 'FrameRequestCallback').map(s => s.duration);
    evidence.passes.push({ name, cards: expected, longTasks: slow.tasks, longFrames: slow.frames, longestTaskMs: longest, frameCallbackMs: rafScripts });
    return { longest, rafScripts };
  }
  // Cold: 1000 cards arrive at once; the host's observer reconciles them in its next frame.
  let pass = await hostPass('cold 1000 (host pass)', () => addCards(page, 1000, 100000), 1000);
  expect(pass.longest).toBeLessThan(BUDGET_MS);
  expect(Math.max(0, ...pass.rafScripts)).toBeLessThan(BUDGET_MS);
  // An unchanged pass over the 1000.
  const unchanged = await timedPass(page);
  evidence.passes.push({ name: 'unchanged 1000 (explicit pass)', cards: 1000, ...unchanged });
  expect(unchanged.firstSliceMs).toBeLessThan(BUDGET_MS);
  expect(unchanged.longest).toBeLessThan(BUDGET_MS);
  // Removal: every card goes; the host's pass releases what they held, with no other mint.
  const since = await page.evaluate(() => performance.now());
  await page.evaluate(() => document.getElementById('grid').remove());
  await frames(page);
  const removal = await slowSince(page, since);
  const after = await page.evaluate(() => window.JellyfinEnhanced.titleActions.registrySize());
  evidence.passes.push({ name: 'removal of 1000 (host pass)', cards: 0, longTasks: removal.tasks, registryAfter: after, registryBaseline: baseline });
  expect(Math.max(0, ...removal.tasks.map(t => t.duration))).toBeLessThan(BUDGET_MS);
  expect(after).toBe(baseline);
  // 500 → 1000: 500 cards, then 500 more join them.
  await hostPass('first 500 (host pass)', () => addCards(page, 500, 200000), 500);
  pass = await hostPass('500 → 1000 (host pass)', () => addCards(page, 500, 300000), 1000);
  expect(pass.longest).toBeLessThan(BUDGET_MS);
  expect(Math.max(0, ...pass.rafScripts)).toBeLessThan(BUDGET_MS);
  const explicit = await timedPass(page);
  evidence.passes.push({ name: 'unchanged 1000 after 500 → 1000 (explicit pass)', cards: 1000, ...explicit });
  expect(explicit.firstSliceMs).toBeLessThan(BUDGET_MS);
  expect(explicit.longest).toBeLessThan(BUDGET_MS);
  // Every card still names its own title.
  const keys = await page.evaluate(() => [...document.querySelectorAll('#grid .je-card-more')].map(n => n.dataset.jeActionKey));
  expect(new Set(keys).size).toBe(1000);
  if (process.env.JE_GRID_EVIDENCE) writeFileSync(`${process.env.JE_GRID_EVIDENCE}-${info.project.name}.json`, JSON.stringify(evidence, null, 1));
  expect(host.errors).toEqual([]);
});

/** Chromium's accessibility tree: the names of the dialogs in it, and whether a button named `button` is in it. */
async function axDialogs(page, button) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    const live = nodes.filter(n => !n.ignored);
    return { dialogs: live.filter(n => n.role?.value === 'dialog').map(n => n.name?.value || ''),
      button: button ? live.some(n => n.role?.value === 'button' && n.name?.value === button) : null };
  } finally { await cdp.detach(); }
}

/** Openers for the Seerr request forms (a viewer's press opens each), and the server's answers they read. */
async function requestForms(page) {
  await page.evaluate(() => {
    const JE = window.JellyfinEnhanced;
    JE.pluginConfig.JellyseerrShowAdvanced = true;
    const fetch = window.fetch;
    window.fetch = async (url, options = {}) => {
      const p = String(url).replace(location.origin, '').replace('/JellyfinEnhanced', '');
      const json = data => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (p.startsWith('/jellyseerr/tv/1399')) return json({ id: 1399, name: 'Show 1399', mediaInfo: { status: 1, status4k: 1 }, seasons: [{ seasonNumber: 1, episodeCount: 10, airDate: '2011-04-17' }] });
      if (p === '/jellyseerr/radarr' || p === '/jellyseerr/sonarr') return json([{ id: 1, name: 'Arr', isDefault: true, is4k: false }]);
      if (/^\/jellyseerr\/(radarr|sonarr)\/1/.test(p)) return json({ profiles: [{ id: 4, name: 'HD' }], rootFolders: [{ id: 1, path: '/media' }] });
      return fetch(url, options);
    };
    for (const [id, open] of [['openMovie', e => JE.jellyseerrUI.showMovieRequestModal(603, 'Movie 603', null, false, JE.ownerOf(e))],
      ['openSeason', e => JE.jellyseerrUI.showSeasonSelectionModal(1399, 'tv', 'Show 1399', null, false, JE.ownerOf(e))]]) {
      const b = document.createElement('button'); b.id = id; b.textContent = id; b.onclick = open; document.body.append(b);
    }
  });
}

for (const form of ['movie', 'season']) {
  test(`the ${form} request form is a dialog named by its own title in Chromium's accessibility tree`, async ({ page, isMobile }) => {
    const host = await boot(page);
    await requestForms(page);
    await press(page, page.locator(form === 'movie' ? '#openMovie' : '#openSeason'), isMobile);
    const modal = page.locator('.jellyseerr-season-modal.show');
    await modal.waitFor();
    const title = (await modal.locator('.jellyseerr-season-title').textContent()).trim();
    expect(title).not.toBe('');
    const ax = await axDialogs(page);
    // Chromium names it from the rendered text (the title is styled upper-case).
    expect(ax.dialogs.map(name => name.toLowerCase())).toEqual([title.toLowerCase()]);
    if (form === 'movie') expect(await modal.locator('h3').count()).toBeGreaterThan(0);
    expect(host.errors).toEqual([]);
  });
}

test('Hide inside More Info: its Undo is in the accessibility tree, takes focus and the viewer\'s press undoes it while the window stays open', async ({ page, isMobile }) => {
  const host = await boot(page);
  await page.evaluate(() => { window.JellyfinEnhanced.userConfig = { hiddenContent: { items: {}, settings: { enabled: true, showHideButtons: true, showButtonJellyseerr: true, showHideConfirmation: true } } }; });
  for (const file of ['enhanced/hiddencontent/hidden-content-data.js', 'enhanced/hiddencontent/hidden-content-dialogs.js']) await page.addScriptTag({ content: read('Jellyfin.Plugin.JellyfinEnhanced/js/' + file) });
  await press(page, page.locator('#openInfo'), isMobile);
  await page.locator('.je-more-info-modal.active').waitFor();
  await page.evaluate(() => {
    const hc = window.JellyfinEnhanced.internals.hiddenContent; hc.refreshNativeCardVisibility = () => {};
    const control = hc.buildTitleControl({ mediaType: 'movie', tmdbId: 603, name: 'Movie 603' }); control.id = 'hideInInfo';
    document.querySelector('.je-more-info-modal .modal-content').append(control);
  });
  await press(page, page.locator('#hideInInfo'), isMobile);
  await press(page, page.locator('.je-hide-confirm-hide'), isMobile);
  const undo = page.locator('.je-undo-toast .je-undo-btn');
  await undo.waitFor();
  const label = (await undo.textContent()).trim();
  expect(await page.evaluate(() => !!document.querySelector('.je-more-info-modal.active') && !document.querySelector('.je-undo-toast').closest('[inert]'))).toBe(true);
  expect((await axDialogs(page, label)).button).toBe(true);
  await undo.focus();
  expect(await page.evaluate(() => document.activeElement?.classList.contains('je-undo-btn'))).toBe(true);
  const deletes = () => page.evaluate(() => window.sent.filter(([m, p]) => m === 'DELETE' && p.includes('/hidden-content/rule/')).length);
  await press(page, undo, isMobile);
  await expect.poll(deletes).toBe(1);
  expect(await page.evaluate(() => !!document.querySelector('.je-more-info-modal.active'))).toBe(true);
  expect(host.errors).toEqual([]);
});

for (const version of ['12.2', '10.11.11']) {
  for (const surface of ['More Info', 'More sheet']) {
    test(`another client's remote Back (jellyfin-web ${version}) closes only the top ${surface}, then the router goes back`, async ({ page, isMobile }) => {
      const host = await boot(page, { layout: 'tv' });
      await page.evaluate(() => { history.replaceState(null, '', '#/home'); history.pushState(null, '', '#/search?query=matrix'); });
      const server = await remoteServer();
      try {
        await loadHost(page, version, { tv: true, remote: server.url, history: true });
        if (surface === 'More Info') { await press(page, page.locator('#openInfo'), isMobile); await page.locator('.je-more-info-modal.active').waitFor(); }
        else { await press(page, page.locator('#card603 .je-card-more'), isMobile); await page.locator('.je-actions-backdrop').waitFor(); }
        const open = () => page.evaluate(s => s === 'More Info' ? !!document.querySelector('.je-more-info-modal.active:not([inert])') : !!document.querySelector('.je-actions-backdrop'), surface);
        server.command('Back');
        await expect.poll(() => page.evaluate(() => window.remoteMessages)).toBe(1);
        await expect.poll(open).toBe(false);
        await page.waitForTimeout(100);
        expect(await page.evaluate(() => location.hash)).toBe('#/search?query=matrix');
        server.command('Back');
        await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/home');
        // The first command was consumed before the router's gate and took no router step (round 14); the second is
        // the router's own, and it completes.
        expect(await page.evaluate(() => window.backs)).toBe(1);
        expect(host.errors).toEqual([]);
      } finally { await server.close(); }
    });
  }
}
