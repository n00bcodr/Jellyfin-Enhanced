const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const config = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/Configuration');
const read = file => fs.readFileSync(path.join(config, file), 'utf8');
const served = ext => [read('jeAdmin' + ext), ...fs.readdirSync(path.join(config, 'admin')).filter(f => f.endsWith(ext)).sort().map(f => read('admin/' + f))].join('\n');
const SAVED = { ShowFileSizes: false, TMDB_API_KEY: 'stored-key', JellyseerrUrls: '', JellyseerrApiKey: '', FutureSetting: { kept: true } };

/** The Jellyfin host, as far as this page uses it: ApiClient, Dashboard and a server holding one configuration. */
function hostScript(saved) {
  window.__saved = saved;
  window.__calls = { puts: [], posts: [] };
  window.__failConfig = false;
  window.Dashboard = { showLoadingMsg() {}, hideLoadingMsg() {}, processPluginConfigurationUpdateResult() {}, alert() {}, confirm() {} };
  window.ApiClient = {
    getUrl: (p, q) => location.origin + '/' + p.replace(/^\//, '') + (q ? '?' + new URLSearchParams(q) : ''),
    getPluginConfiguration: async () => { if (window.__failConfig) throw new Error('offline'); return JSON.parse(JSON.stringify(window.__saved)); },
    updatePluginConfiguration: async (id, body) => { window.__calls.puts.push(JSON.parse(JSON.stringify(body))); window.__saved = JSON.parse(JSON.stringify(body)); return {}; },
    ajax: async request => {
      if (request.type === 'POST') window.__calls.posts.push({ url: request.url, data: request.data });
      if (/apply-user-settings/.test(request.url)) return { applied: 1, userCount: 2, unsupported: [] };
      return request.type === 'GET' || !request.type ? [] : {};
    },
    getJSON: async () => [], fetch: async () => ({}), getUsers: async () => [], accessToken: () => 't', serverVersion: () => '12.0.0',
  };
}

/** jellyfin-web inserts the view, then runs its scripts in order, then shows it. */
async function insertView(page, html) {
  await page.evaluate(markup => {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = markup;
    const view = wrapper.querySelector('div[data-role="page"]');
    document.body.appendChild(view);
    view.querySelectorAll('script').forEach(original => {
      const script = document.createElement('script');
      script.text = original.text;
      document.head.appendChild(script).remove();
    });
    view.dispatchEvent(new Event('pageshow'));
  }, html);
}

async function open(page, { engine = () => served('.js'), hash = '#/configurationpage?name=Jellyfin%20Enhanced', saved = SAVED, status = 200, failRead = false } = {}) {
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/JellyfinEnhanced/Configuration/jeAdmin.js*', route => (typeof status === 'function' ? status() : status) === 200
    ? route.fulfill({ status: 200, contentType: 'application/javascript', body: engine() })
    : route.fulfill({ status: 404, body: 'gone' }));
  await page.route('**/JellyfinEnhanced/Configuration/jeAdmin.css*', route => route.fulfill({ status: 200, contentType: 'text/css', body: served('.css') }));
  await page.route('**/JellyfinEnhanced/{cdn,fonts}/**', route => route.fulfill({ status: 204, body: '' }));
  await page.goto('/' + hash);
  await page.evaluate(hostScript, saved);
  if (failRead) await page.evaluate(() => { window.__failConfig = true; });
  await insertView(page, read('configPage.html'));
  return errors;
}

/** The page records what it loaded 500 ms after loading, once late lists have settled. */
const settled = page => page.waitForTimeout(650);
const tab = (page, id) => page.locator(`.jellyfin-tab-button[data-tab="${id}"]`);
const clickTab = async (page, id) => {
  // The phone layout keeps the tabs in its drawer.
  if (await page.locator('.jea-nav-toggle').isVisible()) await page.locator('.jea-nav-toggle').click();
  await tab(page, id).click();
};

test.describe('admin configuration page', () => {
  test('loads over a real script element, draws every tab and keeps the stored values', async ({ page }) => {
    const errors = await open(page);
    await expect(page.locator('.jea-layout')).toBeVisible();
    await expect(page.locator('[data-je-section]')).toHaveCount(0);
    await expect(page.locator('#JellyfinEnhancedPage')).not.toHaveAttribute('aria-busy', 'true');
    await clickTab(page, 'elsewhere');
    await expect(page.locator('#TMDB_API_KEY')).toHaveValue('stored-key');
    await clickTab(page, 'keyboard');
    await expect(page.locator('#shortcut-grid .je-sc-row').first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('an edit shows as unsaved, saves, and keeps fields this page does not know', async ({ page }) => {
    await open(page);
    await settled(page);
    await clickTab(page, 'display');
    await page.locator('#showFileSizes').evaluate(control => control.click());
    await expect(page.locator('.je-save-dock')).toHaveClass(/je-dirty/);
    await page.locator('.je-save-dock-btn').click();
    await expect.poll(() => page.evaluate(() => window.__calls.puts.length)).toBe(1);
    const put = await page.evaluate(() => window.__calls.puts[0]);
    expect(put.ShowFileSizes).toBe(true);
    expect(put.FutureSetting).toEqual({ kept: true });
    expect(put.TMDB_API_KEY).toBe('stored-key');
    await expect(page.locator('.je-save-dock')).not.toHaveClass(/je-dirty/);
  });

  test('a changed per-user setting offers Apply the above, which posts just that setting', async ({ page }) => {
    await open(page);
    await settled(page);
    await clickTab(page, 'display');
    await page.locator('#showFileSizes').evaluate(control => control.click());
    const banner = page.locator('fieldset:has(#showFileSizes) .jea-apply');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Show file sizes');
    await banner.locator('.jea-apply-sel').click();
    await page.locator('.jea-dialog [data-r="1"]').click();
    await expect.poll(() => page.evaluate(() => window.__calls.posts.find(p => /apply-user-settings/.test(p.url))?.data)).toBe(JSON.stringify({ properties: ['ShowFileSizes'] }));
    await expect(banner).toBeHidden();
  });

  test('search finds a setting on another tab and leaving search restores the page', async ({ page }) => {
    await open(page);
    await page.locator('#settingsSearchInput').fill('tmdb api key');
    await expect(page.locator('#JellyfinEnhancedForm mark.je-search-match').first()).toBeVisible();
    await expect(page.locator('#settingsSearchCount')).toContainText('of');
    await page.locator('#settingsSearchClear').click();
    await expect(page.locator('#JellyfinEnhancedForm')).not.toHaveClass(/je-search-mode/);
    await expect(page.locator('mark.je-search-match')).toHaveCount(0);
  });

  test('a deep link opens its tab', async ({ page }) => {
    await open(page, { hash: '#/configurationpage?name=Jellyfin%20Enhanced&tab=seerr' });
    await expect(page.locator('#seerr')).toHaveClass(/active/);
    await expect(tab(page, 'seerr')).toHaveClass(/active/);
  });

  test('a new Sonarr instance is saved as an instance document', async ({ page }) => {
    await open(page);
    await clickTab(page, 'arr');
    await page.locator('#addSonarrInstance').click();
    const card = page.locator('#sonarrInstancesList .arr-instance-card').first();
    await card.locator('.arr-instance-url').fill('http://sonarr.test:8989');
    await card.locator('.arr-instance-apikey').fill('abc');
    await page.locator('.je-save-dock-btn').click();
    await expect.poll(() => page.evaluate(() => window.__calls.puts.length)).toBe(1);
    const stored = JSON.parse((await page.evaluate(() => window.__calls.puts[0])).SonarrInstances);
    expect(stored[0]).toMatchObject({ Url: 'http://sonarr.test:8989', ApiKey: 'abc' });
  });

  test('a recorded key replaces a shortcut and a player key is refused', async ({ page }) => {
    await open(page);
    await clickTab(page, 'keyboard');
    const row = page.locator('#shortcut-grid .je-sc-row', { hasText: 'Show Playback Info' });
    await row.locator('.je-sc-key').focus();
    await page.keyboard.press('k');
    await expect(page.locator('#shortcut-error-comment')).toContainText('already used by the Jellyfin player');
    await row.locator('.je-sc-key').focus();
    await page.keyboard.press('y');
    await expect(page.locator('#shortcut-grid .je-sc-row', { hasText: 'Show Playback Info' }).locator('.je-sc-key')).toHaveText('Y');
  });

  for (const [name, options] of [
    ['a failed request', { status: 404 }],
    ['an empty answer', { engine: () => '' }],
    ['a page that is not the engine', { engine: () => '<!doctype html>' }],
  ]) {
    test(`${name} for the engine leaves a Retry that works`, async ({ page }) => {
      let working = false;
      const current = {
        status: () => (working || !options.status ? 200 : options.status),
        engine: () => (working ? served('.js') : options.engine ? options.engine() : ''),
      };
      await open(page, current);
      const alert = page.locator('.je-admin-load-error');
      await expect(alert).toBeVisible();
      await expect(alert).toContainText('Saved settings are not affected');
      expect(await page.evaluate(() => window.__calls.puts.length)).toBe(0);
      working = true;
      await alert.locator('button').click();
      await expect(page.locator('.jea-layout')).toBeVisible();
      await clickTab(page, 'elsewhere');
      await expect(page.locator('#TMDB_API_KEY')).toHaveValue('stored-key');
    });
  }

  test('a failed read of the settings refuses to save over them, and Retry recovers', async ({ page }) => {
    await open(page, { failRead: true });
    await expect(page.locator('#je-probe-warning')).toBeVisible();
    await expect(page.locator('#je-probe-warning-msg')).toContainText('saving is disabled');
    await page.locator('.je-save-dock-btn').click();
    await expect(page.locator('.jea-dialog')).toContainText('nothing was saved');
    await page.locator('.jea-dialog [data-r="1"]').click();
    expect(await page.evaluate(() => window.__calls.puts.length)).toBe(0);
    await page.evaluate(() => { window.__failConfig = false; });
    await page.locator('#je-probe-retry-btn').click();
    await expect(page.locator('#je-probe-warning')).toBeHidden();
    await clickTab(page, 'elsewhere');
    await expect(page.locator('#TMDB_API_KEY')).toHaveValue('stored-key');
  });

  for (const [name, change] of [['a changed token', () => { const read = window.ApiClient.accessToken; window.ApiClient.accessToken = () => read() + '-b'; }], ['a replaced client', () => { window.ApiClient = { ...window.ApiClient }; }]]) {
    test(`ATB-R2-001: confirming Apply all plugin settings after ${name} sends nothing and shows nothing`, async ({ page }) => {
      await open(page);
      await settled(page);
      await page.locator('#resetAllUserSettingsBtn').evaluate(button => button.click());
      const dialog = page.locator('.jea-dialog');
      await expect(dialog).toContainText('Are you sure');
      await page.evaluate(change);
      await dialog.locator('[data-r="1"]').click();
      await page.waitForTimeout(150);
      expect(await page.evaluate(() => window.__calls)).toEqual({ puts: [], posts: [] });
      await expect(page.locator('.jea-dialog')).toHaveCount(0);
    });
  }

  test('ATB-R2-001 control: the same account confirming Apply all plugin settings saves and resets', async ({ page }) => {
    await open(page);
    await settled(page);
    await page.locator('#resetAllUserSettingsBtn').evaluate(button => button.click());
    await page.locator('.jea-dialog [data-r="1"]').click();
    await expect(page.locator('.jea-dialog')).toContainText('saved and applied to all users successfully');
    const calls = await page.evaluate(() => window.__calls);
    expect(calls.puts).toHaveLength(1);
    expect(calls.posts.map(post => new URL(post.url).pathname)).toContain('/JellyfinEnhanced/reset-all-users-settings');
  });

  test('the older Media Tags address forwards to the tab', async ({ page }) => {
    await page.goto('/#/configurationpage?name=JellyfinEnhancedMediaTags&tab=groups&group=rating');
    await page.evaluate(html => {
      const wrapper = document.createElement('div');
      wrapper.innerHTML = html;
      const script = document.createElement('script');
      script.text = wrapper.querySelector('script').text;
      document.head.appendChild(script).remove();
    }, read('mediaTagsPage.html'));
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/configurationpage?name=Jellyfin%20Enhanced&jeSection=media-tags&tab=groups&group=rating');
  });

  test('the phone menu opens, moves between tabs and closes', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile-chromium', 'phone layout');
    await open(page);
    const toggle = page.locator('.jea-nav-toggle');
    await toggle.click();
    await expect(page.locator('.jea-nav')).toHaveClass(/jea-open/);
    await tab(page, 'playback').click();
    await expect(page.locator('.jea-nav')).not.toHaveClass(/jea-open/);
    await expect(toggle).toContainText('Playback');
    await expect(page.locator('#playback')).toHaveClass(/active/);
  });
});
