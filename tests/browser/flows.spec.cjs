const { test: base, expect } = require('@playwright/test');
const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await page.goto('/');
    await use(page);
    expect(errors, 'unexpected browser errors').toEqual([]);
  }
});
// Freezes the page's timers so only clock.runFor advances them and a slow runner cannot fire
// one early. The pause point is far past install so a stall between the calls cannot put it
// in the past.
async function pauseClock(page) {
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(60_000);
}
test('modal primary button invokes callback with selected fixture season once', async ({ page }) => {
  await page.getByRole('button', { name: 'Open request' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByLabel('Season', { exact: true }).selectOption('2');
  await page.getByRole('button', { name: 'Request', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#output')).toHaveText('Requested season 2');
  expect(await page.evaluate(() => [saved, closeCount])).toEqual([1, 1]);
});
test('keyboard focus stays within modal and Escape cleans up across repeated opens', async ({ page }) => {
  for (let i = 1; i <= 3; i++) {
    await page.locator('#open').click();
    await expect(page.locator('#season')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('button', { name: 'Request', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#season')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await page.evaluate(() => closeCount)).toBe(i);
    await expect(page.locator('body')).not.toHaveClass(/jellyseerr-modal-is-open/);
  }
});
test('cancel and browser Back close without submitting', async ({ page }) => {
  await page.locator('#open').click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.locator('#open').click();
  await page.goBack();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => [saved, closeCount])).toEqual([0, 2]);
});
test('untrusted modal subtitles render as text', async ({ page }) => {
  const hostile = '<img src=x onerror="window.compromised=true"> & 日本語';
  await page.evaluate(text => openRequest(text), hostile);
  await expect(page.locator('.jellyseerr-season-subtitle')).toHaveText(hostile);
  await expect(page.locator('.jellyseerr-season-subtitle img')).toHaveCount(0);
  expect(await page.evaluate(() => window.compromised)).toBeUndefined();
});
test('modal fits viewport and has labelled controls @visual', async ({ page }) => {
  await page.evaluate(() => openRequest('Synthetic Series'));
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('#season')).toBeFocused();
  const bounds = await page.locator('.jellyseerr-season-content').boundingBox();
  const viewport = page.viewportSize();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
  await expect(page).toHaveScreenshot('request-modal.png', { animations: 'disabled', maxDiffPixelRatio: 0.002 });
});
test('SPA navigation deduplicates push/replace/hash events and unsubscribes', async ({ page }) => {
  const result = await page.evaluate(() => {
    const urls=[]; const unsubscribe=JellyfinEnhanced.core.navigation.onNavigate(()=>urls.push(location.hash));
    history.pushState({}, '', '#/home');
    history.pushState({}, '', '#/home');
    history.replaceState({}, '', '#/details?id=one');
    window.dispatchEvent(new PopStateEvent('popstate'));
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    unsubscribe(); history.pushState({}, '', '#/search');
    return urls;
  });
  expect(result).toEqual(['#/home', '#/details?id=one']);
});
test('style injection replaces stale rules without duplicates and removes cleanly', async ({ page }) => {
  await page.evaluate(() => {
    JellyfinEnhanced.core.ui.injectCss('regression-style', '#output { color: red }');
    JellyfinEnhanced.core.ui.injectCss('regression-style', '#output { color: rgb(0, 128, 0) }');
    JellyfinEnhanced.jellyseerrUI.addMainStyles();
    JellyfinEnhanced.jellyseerrUI.addSeasonModalStyles();
  });
  await expect(page.locator('#regression-style')).toHaveCount(1);
  await expect(page.locator('#jellyseerr-styles')).toHaveCount(1);
  await expect(page.locator('#output')).toHaveCSS('color', 'rgb(0, 128, 0)');
  expect(await page.evaluate(() => [JellyfinEnhanced.core.ui.removeCss('regression-style'), JellyfinEnhanced.core.ui.removeCss('regression-style')])).toEqual([true,false]);
});
test('toast displays escaped content and expires under controlled time', async ({ page }) => {
  await pauseClock(page);
  await page.evaluate(() => JellyfinEnhanced.toast(JellyfinEnhanced.escapeHtml('<script>unsafe</script>'), 1000));
  await page.clock.runFor(20);
  await expect(page.locator('.jellyfin-enhanced-toast')).toHaveText('<script>unsafe</script>');
  await expect(page.locator('.jellyfin-enhanced-toast script')).toHaveCount(0);
  // It slides out at 1000 ms and is removed 300 ms later.
  await page.clock.runFor(1270);
  await expect(page.locator('.jellyfin-enhanced-toast')).toHaveCount(1);
  await page.clock.runFor(20);
  await expect(page.locator('.jellyfin-enhanced-toast')).toHaveCount(0);
});

async function languagePanel(page, { saved = 'zh-hk', user = 'user-a', fail = false } = {}) {
  await page.route('https://api.github.com/**', route => route.fulfill({ json: [] }));
  await page.route('**/JellyfinEnhanced/locales', route => route.fulfill({ json: ['en-US','zh-HK','de','pr'] }));
  await page.route('**/Localization/Cultures', route => route.fulfill({ json: [{ TwoLetterISOLanguageName: 'de', DisplayName: 'Deutsch' }] }));
  await page.evaluate(({saved,user,fail}) => {
    document.querySelector('main').innerHTML = '<label for="displayLanguageSelect">Display language</label><select id="displayLanguageSelect"><option value="">Auto</option></select><button id="clearTranslationCacheButton">Clear translations</button>';
    JellyfinEnhanced.currentSettings = { displayLanguage: saved };
    window.ApiClient = { getCurrentUserId:()=>user, getUrl:path=>path, ajax: ({url}) => fail ? Promise.reject(new Error('fixture unavailable')) : fetch(url).then(r=>r.json()) };
    window.savedSettings=[];
    JellyfinEnhanced.saveUserSettings = async (file,settings)=>savedSettings.push({file,settings:{...settings}});
  }, {saved,user,fail});
  await page.addScriptTag({url:'/Jellyfin.Plugin.JellyfinEnhanced/js/enhanced/settingspanel/ui-panel-language.js'});
  await page.evaluate(() => JellyfinEnhanced.internals.enhancedUi.wireLanguageControls({resetAutoCloseTimer:()=>{}}));
}
test('language selector normalizes persisted region and saves only current user', async ({ page }) => {
  await languagePanel(page);
  await expect(page.getByLabel('Display language')).toHaveValue('zh-HK');
  await expect(page.getByRole('option', {name:'Chinese (Hong Kong)'})).toHaveCount(1);
  await page.clock.install();
  await page.evaluate(()=>localStorage.setItem('user-b-language','pr'));
  await page.getByLabel('Display language').selectOption('de');
  expect(await page.evaluate(()=>({settings:savedSettings, a:localStorage.getItem('user-a-language'),b:localStorage.getItem('user-b-language')}))).toEqual({settings:[{file:'settings.json',settings:{displayLanguage:'de'}}],a:'de',b:'pr'});
});
test('automatic language clears override and cache clearing preserves unrelated settings', async ({ page }) => {
  await languagePanel(page);
  await expect(page.getByLabel('Display language')).toHaveValue('zh-HK');
  await page.clock.install();
  await page.getByLabel('Display language').selectOption('');
  await page.evaluate(()=>{localStorage.setItem('JE_translation_de','{}');localStorage.setItem('JE_translation_ts_de','123');localStorage.setItem('bookmarks','keep');});
  await page.getByRole('button',{name:'Clear translations'}).click();
  expect(await page.evaluate(()=>({language:localStorage.getItem('user-a-language'),translations:localStorage.getItem('JE_translation_de'),timestamp:localStorage.getItem('JE_translation_ts_de'),bookmarks:localStorage.getItem('bookmarks')}))).toEqual({language:'',translations:null,timestamp:null,bookmarks:'keep'});
});
test('locale enumeration failure leaves automatic language usable', async ({ page }) => {
  await languagePanel(page,{saved:'',fail:true});
  await expect(page.getByLabel('Display language')).toHaveValue('');
  await expect(page.getByRole('option')).toHaveCount(1);
  await expect(page.getByLabel('Display language')).toBeEnabled();
});

for (const is4k of [false, true]) {
  test(`advanced request options select matching ${is4k ? '4K' : 'regular'} default and refresh dependent fields`, async ({ page }) => {
    await page.evaluate(is4k => {
      const api = JellyfinEnhanced.jellyseerrModal;
      const request = api.create({ title: 'Advanced request', subtitle: 'Fixture API data', bodyHtml: api.createAdvancedOptionsHTML('movie'), onSave:()=>{} });
      request.show();
      api.populateAdvancedOptions(request.modalElement, {servers:[
        {id:2,name:'Zulu 4K',isDefault:true,is4k:true,activeProfileId:20,activeDirectory:'/4k',qualityProfiles:[{id:20,name:'Ultra HD'}],rootFolders:[{path:'/4k',freeSpace:1073741824}]},
        {id:1,name:'Alpha regular',isDefault:true,is4k:false,activeProfileId:10,activeDirectory:'/movies',qualityProfiles:[{id:10,name:'HD'}],rootFolders:[{path:'/movies',freeSpace:0}]}
      ]}, 'movie', is4k);
    }, is4k);
    await expect(page.locator('#movie-server')).toHaveValue(is4k ? '2' : '1');
    await expect(page.locator('#movie-quality')).toHaveValue(is4k ? '20' : '10');
    await expect(page.locator('#movie-folder')).toHaveValue(is4k ? '/4k' : '/movies');
    await expect(page.locator('#movie-server option')).toHaveText(['Select Server...', 'Alpha regular', 'Zulu 4K']);
    await page.locator('#movie-server').selectOption(is4k ? '1' : '2');
    await expect(page.locator('#movie-quality option')).toHaveText(['Select Quality...', is4k ? 'HD' : 'Ultra HD']);
    await expect(page.locator('#movie-folder option')).toHaveText(['Select Folder...', is4k ? '/movies (0 Bytes)' : '/4k (1 GB)']);
    await page.locator('#movie-server').selectOption('');
    await expect(page.locator('#movie-quality option')).toHaveCount(1);
    await expect(page.locator('#movie-folder option')).toHaveCount(1);
  });
}
