#!/usr/bin/env node
// Lab browser helper: logs into a lab Jellyfin server via the web login form and lets you
// navigate, screenshot, evaluate JS and collect console errors.
// Usage:
//   node /home/jake/je-lab/browser.mjs --port 18501 [--user real-admin] [--pass ...]
//        [--goto '#/home.html'] [--wait 3000] [--shot /tmp/out.png] [--eval 'document.title']
//        [--full] [--width 1400 --height 900] [--firefox] [--clip x,y,w,h] [--selector 'css'] (element screenshot)
//        [--settle] (scroll everything into view, wait for all images to decode, report Spoiler Guard state)
//        [--user real-viewer] [--lang en] (forces the JE user language via localStorage before load)
// Prints console errors/warnings (prefixed CONSOLE) and page errors (PAGEERROR) to stdout.
import { chromium, firefox } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const a = Object.fromEntries(process.argv.slice(2).map((s, i, arr) => s.startsWith('--') ? [s.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : []).filter(Boolean));
if (a.port && String(a.port) !== '18537') throw new Error('Centres verification is restricted to port 18537');
const port = 18537, user = a.user || 'real-admin';
const pass = a.pass || (() => { const t = require('node:fs').readFileSync(require('node:os').homedir() + '/.config/je-lab/lab-accounts.env', 'utf8'); const g = k => (t.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1]; return user === 'real-admin' ? g('JE_LAB_ADMIN_PASS') : g('JE_LAB_VIEWER_PASS'); })();
const base = `http://127.0.0.1:${port}`;
const browser = await (a.firefox ? firefox : chromium).launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: +(a.width || 1400), height: +(a.height || 900) }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const seen = new Set();
page.on('response', r => { if (r.status() >= 400) console.log('HTTP', r.status(), new URL(r.url()).pathname); });
page.on('console', m => { if (['error', 'warning'].includes(m.type())) { const t = m.text().slice(0, 400); if (!seen.has(t)) { seen.add(t); console.log('CONSOLE', m.type(), t); } } });
page.on('pageerror', e => console.log('PAGEERROR', String(e).slice(0, 400)));
await page.goto(`${base}/web/index.html#/login.html`, { waitUntil: 'domcontentloaded' });
// Jellyfin shows either user cards (with a "Manual Login" button) or the manual form directly; wait for whichever appears.
const nameInput = page.locator('#txtManualName');
for (let i = 0; i < 40 && !(await nameInput.isVisible().catch(() => false)); i++) {
  const manual = page.locator('.btnManual, button:has-text("Manual Login")').filter({ visible: true }).first();
  if (await manual.isVisible().catch(() => false)) await manual.click().catch(() => {});
  await sleep(500);
}
await nameInput.waitFor({ state: 'visible', timeout: 10000 });
await page.fill('#txtManualName', user);
await page.fill('#txtManualPassword', pass);
await page.locator('#txtManualPassword').press('Enter');
await page.waitForURL(u => !String(u).includes('login.html'), { timeout: 20000 }).catch(() => console.log('WARN still on login page'));
await sleep(1500);
if (a.lang) {
  // JE reads `${userId}-language` from localStorage; set it for the logged-in user and reload so translations load in that language.
  await page.evaluate(l => { const id = window.ApiClient?.getCurrentUserId?.(); if (id) localStorage.setItem(`${id}-language`, l); }, String(a.lang));
  await page.reload({ waitUntil: 'domcontentloaded' }); await sleep(1500);
}
if (a.goto) { await page.goto(`${base}/web/index.html${a.goto}`, { waitUntil: 'domcontentloaded' }); }
await sleep(+(a.wait || 3000));
/**
 * --settle: make the page screenshot-stable. Scrolls the whole document (and horizontal scrollers)
 * so every lazy card image is requested, waits until each background-image URL has actually
 * decoded, waits for network idle, then scrolls back. Reports any Spoiler Guard state it sees so a
 * before/after pair can be checked for matching state.
 */
async function settlePage(page) {
  await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const H = document.documentElement.scrollHeight;
    for (let y = 0; y < H; y += Math.floor(innerHeight * 0.7)) { scrollTo(0, y); await wait(250); }
    for (const sc of document.querySelectorAll('.itemsContainer.scrollSlider, .emby-scroller')) {
      for (let x = 0; x < sc.scrollWidth; x += sc.clientWidth || 800) { sc.scrollLeft = x; await wait(120); }
      sc.scrollLeft = 0;
    }
    scrollTo(0, 0); await wait(400);
  });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  const pending = await page.evaluate(async () => {
    const urls = new Set();
    for (const el of document.querySelectorAll('[style*="background-image"]')) {
      const m = /url\(["']?([^"')]+)/.exec(el.style.backgroundImage || ''); if (m) urls.add(m[1]);
    }
    for (const img of document.querySelectorAll('img')) if (img.currentSrc || img.src) urls.add(img.currentSrc || img.src);
    let failed = 0;
    await Promise.all([...urls].map(u => new Promise(res => { const i = new Image(); i.onload = () => res(); i.onerror = () => { failed++; res(); }; i.src = u; })));
    return { images: urls.size, failed };
  });
  await page.waitForTimeout(1200);
  const spoiler = await page.evaluate(() => ({
    guardedImages: document.querySelectorAll('[style*="sb-"], img[src*="sb-"]').length,
    spoilerStates: [...document.querySelectorAll('[data-je-spoiler-state]')].map(e => e.getAttribute('data-je-spoiler-state')),
  }));
  console.log('SETTLE', JSON.stringify({ ...pending, ...spoiler }));
}
if (a.settle) await settlePage(page);
if (a.script) { const steps = await import(a.script); await steps.default({ page, ctx, settlePage }); }
if (a.eval) { const r = await page.evaluate(a.eval); console.log('EVAL', typeof r === 'string' ? r : JSON.stringify(r, null, 1)); }
if (a.shot) {
  await page.mouse.move(0, 0); await page.waitForTimeout(300); // no hover overlays in captures
  const clip = a.clip ? (() => { const [x, y, width, height] = String(a.clip).split(',').map(Number); return { x, y, width, height }; })() : undefined;
  const sel = a.selector ? page.locator(String(a.selector)).filter({ visible: true }).first() : null;
  if (sel) { await sel.scrollIntoViewIfNeeded().catch(() => {}); await page.mouse.move(0, 0); await page.waitForTimeout(2000); await sel.screenshot({ path: a.shot, animations: "disabled" }); }
  else await page.screenshot({ path: a.shot, fullPage: !!a.full, clip });
  console.log('SHOT', a.shot);
}
console.log('URL', page.url());
await browser.close();
