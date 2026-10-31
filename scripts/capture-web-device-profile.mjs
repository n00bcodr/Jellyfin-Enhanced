#!/usr/bin/env node
/**
 * Capture jellyfin-web's own browser device profile (its webpack module, called with the app host's
 * options for a video) in headless Chromium, with every canPlayType answer it read, in the format of
 * tests/fixtures/direct-play-web-12.1-chromium.json. The frontend suite replays those answers against
 * JE's ported profile (js/tags/tag-direct-play.js). Needs a Jellyfin test server you are authorised to
 * use, with this plugin installed; it changes only the signed-in browser's local settings.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';

const USAGE = `Usage: JE_CAPTURE_PASSWORD=... node scripts/capture-web-device-profile.mjs \\
  --server <url> --user <name> --out <file.json> [--case '<name>=<settings-json>']... [--cases-from <fixture.json>]

  --server      Jellyfin base URL (or JE_CAPTURE_SERVER)
  --user        account to sign in with (or JE_CAPTURE_USER); the password is read only from JE_CAPTURE_PASSWORD
  --out         fixture file to write
  --case        a named case of browser localStorage settings; a "USER-" key prefix stands for the user id
  --cases-from  reuse the case names and settings of an existing fixture
  Without cases, one "defaults" case with no settings is captured.

Regenerate the committed fixture:
  JE_CAPTURE_PASSWORD=... node scripts/capture-web-device-profile.mjs --server <url> --user <name> \\
    --cases-from tests/fixtures/direct-play-web-12.1-chromium.json --out tests/fixtures/direct-play-web-12.1-chromium.json`;

const { values } = parseArgs({
    options: {
        server: { type: 'string' }, user: { type: 'string' }, out: { type: 'string' },
        case: { type: 'string', multiple: true }, 'cases-from': { type: 'string' }, help: { type: 'boolean', short: 'h' },
    },
});
if (values.help) {
    console.log(USAGE);
    process.exit(0);
}
const server = (values.server || process.env.JE_CAPTURE_SERVER || '').replace(/\/+$/, '');
const user = values.user || process.env.JE_CAPTURE_USER;
const password = process.env.JE_CAPTURE_PASSWORD;
const missing = [!server && '--server (or JE_CAPTURE_SERVER)', !user && '--user (or JE_CAPTURE_USER)', !password && 'JE_CAPTURE_PASSWORD', !values.out && '--out'].filter(Boolean);
if (missing.length) {
    console.error(`Missing ${missing.join(', ')}\n\n${USAGE}`);
    process.exit(2);
}
const cases = values['cases-from'] ? JSON.parse(readFileSync(values['cases-from'], 'utf8')).cases.map(({ name, settings }) => ({ name, settings })) : [];
for (const arg of values.case || []) {
    const at = arg.indexOf('=');
    if (at < 1) throw new Error(`--case expects <name>=<settings-json>: ${arg}`);
    cases.push({ name: arg.slice(0, at), settings: JSON.parse(arg.slice(at + 1)) });
}
if (!cases.length) cases.push({ name: 'defaults', settings: {} });

// jellyfin-web's getBaseProfileOptions for a video with hls.js (Chromium), as the ported baseOptions() derives it.
const OPTIONS = { enableMkvProgressive: false, disableHlsVideoAudioCodecs: ['ac3', 'eac3'] };

/** Sign in on a fresh context so no earlier case's settings leak into the next one. */
async function signIn(browser) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
    page.on('pageerror', e => errors.push(`pageerror ${String(e).slice(0, 300)}`));
    await page.addInitScript(() => {
        const answers = {};
        const real = HTMLMediaElement.prototype.canPlayType;
        HTMLMediaElement.prototype.canPlayType = function (type) {
            const answer = real.call(this, type);
            answers[(this instanceof HTMLAudioElement ? 'audio|' : 'video|') + type] = answer;
            return answer;
        };
        window.__jeCanPlay = answers;
    });
    await page.goto(`${server}/web/index.html#/login.html`);
    const name = page.locator('#txtManualName');
    // The login page can render its Manual Login button before the handler is attached.
    for (let i = 0; i < 40 && !(await name.isVisible().catch(() => false)); i++) {
        const manual = page.locator('.btnManual, button:has-text("Manual Login")').filter({ visible: true }).first();
        if (await manual.isVisible().catch(() => false)) await manual.click().catch(() => {});
        await page.waitForTimeout(500);
    }
    await name.fill(user);
    await page.fill('#txtManualPassword', password);
    await page.locator('#txtManualPassword').press('Enter');
    await page.waitForURL(u => !String(u).includes('login.html'), { timeout: 20000 });
    await page.waitForFunction(() => window.JellyfinEnhanced?.tagDirectPlay && window.ApiClient?.getCurrentUserId?.(), null, { timeout: 30000 });
    return { context, page, errors };
}

const browser = await chromium.launch({ headless: true });
const fixture = { source: '', userAgent: '', maxTouchPoints: 0, env: {}, cases: [] };
let failed = false;
try {
    for (const kase of cases) {
        const { context, page, errors } = await signIn(browser);
        const result = await page.evaluate(async ({ settings, options }) => {
            const uid = ApiClient.getCurrentUserId();
            for (const [key, value] of Object.entries(settings)) localStorage.setItem(key.replace(/^USER-/, `${uid}-`), value);
            const chunkName = Object.keys(window).find(k => k.startsWith('webpackChunk'));
            let req;
            window[chunkName].push([[Symbol('je-capture')], {}, r => { req = r; }]);
            const ids = Object.keys(req.m).filter(id => { const src = String(req.m[id]); return src.includes('MaxStaticBitrate') && src.includes('SubtitleProfiles') && src.includes('DirectPlayProfiles'); });
            const builders = ids.map(id => Object.values(req(id)).find(f => typeof f === 'function' && f.length <= 1 && /DirectPlayProfiles/.test(String(f)))).filter(Boolean);
            for (const key of Object.keys(window.__jeCanPlay)) delete window.__jeCanPlay[key];
            const profile = builders[0]?.(options);
            const canPlayType = { ...window.__jeCanPlay };
            const dp = JellyfinEnhanced.tagDirectPlay;
            dp.setProfile(null);
            const ported = dp.webProfile(options);
            const inUse = dp.profile();
            let speakers = -1;
            try { const c = new AudioContext(); speakers = c.destination.maxChannelCount; c.close(); } catch { /* no audio output */ }
            const v = document.createElement('video');
            const info = await fetch(ApiClient.getUrl('System/Info/Public')).then(r => r.json()).catch(() => ({}));
            return {
                moduleIds: ids, builders: builders.length, serverVersion: info.Version || 'unknown', webVersion: ApiClient.appVersion?.() || 'unknown',
                userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints,
                env: { speakers, audioTracks: !!v.audioTracks, textTracks: v.textTracks != null, mediaSource: window.MediaSource != null, devicePixelRatio, screen: { width: screen.width, height: screen.height } },
                canPlayType, bitrate: dp.bitrate(), profile,
                equal: JSON.stringify(profile) === JSON.stringify(ported), inUseEqual: JSON.stringify(profile) === JSON.stringify(inUse),
            };
        }, { settings: kase.settings, options: OPTIONS });
        await context.close();
        if (result.builders !== 1) {
            console.error(`${kase.name}: expected one profile builder in the web bundle, found ${result.builders} (modules ${result.moduleIds.join(', ') || 'none'})`);
            failed = true;
        }
        Object.assign(fixture, { userAgent: result.userAgent, maxTouchPoints: result.maxTouchPoints, env: result.env });
        fixture.source = `jellyfin-web ${result.webVersion} (Jellyfin server ${result.serverVersion}) webpack module ${result.moduleIds.join(', ')} (browserDeviceProfile) called in headless Chromium ${browser.version()} with the app host options for a video; canPlayType answers recorded per element type during that call. Regenerate with scripts/capture-web-device-profile.mjs --cases-from this file (see its --help).`;
        fixture.cases.push({ name: kase.name, settings: kase.settings, options: OPTIONS, canPlayType: result.canPlayType, bitrate: result.bitrate, profile: result.profile });
        console.log(JSON.stringify({ case: kase.name, moduleIds: result.moduleIds, equal: result.equal, inUseEqual: result.inUseEqual, bitrate: result.bitrate, consoleErrors: errors.length }));
    }
} finally {
    await browser.close();
}
if (failed) process.exit(1);
writeFileSync(values.out, `${JSON.stringify(fixture, null, 2)}\n`);
