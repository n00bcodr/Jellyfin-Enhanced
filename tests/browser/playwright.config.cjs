const { defineConfig, devices } = require('@playwright/test');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
// One port for the fixture server, its readiness probe and every test URL.
const port = Number(process.env.JE_BROWSER_PORT || 4179);
const origin = `http://127.0.0.1:${port}`;
// Reuse an explicitly selected lab for geometry specs without starting a fixture server.
const labOrigin = process.env.JE_BROWSER_LAB_URL;
// scripts/restructure-gates.sh browser can run the suite as two Playwright runs at once: JE_BROWSER_PART=long runs only
// the spec files named in JE_BROWSER_LONG (comma-separated; specs whose single tests run for half a minute), and
// JE_BROWSER_PART=rest runs every other file, so the long tests start at once instead of last in the queue. Each part
// has its own port, results and reports. Unset, this is the whole suite in one run, as always.
const part = process.env.JE_BROWSER_PART || '';
const longFiles = (process.env.JE_BROWSER_LONG || '').split(',').map(name => name.trim()).filter(Boolean);
if (part && !['long', 'rest'].includes(part)) throw new Error(`JE_BROWSER_PART must be long or rest, not ${part}`);
if (part && !longFiles.length) throw new Error('JE_BROWSER_PART needs JE_BROWSER_LONG');
const longMatch = longFiles.map(name => path.join(__dirname, name));
const suffix = part ? `-${part}` : '';
module.exports = defineConfig({
  testDir: __dirname, fullyParallel: true, forbidOnly: !!process.env.CI,
  ...(part === 'long' ? { testMatch: longMatch } : part === 'rest' ? { testIgnore: longMatch } : {}),
  retries: 0, workers: process.env.JE_BROWSER_WORKERS ? Number(process.env.JE_BROWSER_WORKERS) : process.env.CI ? 2 : 3, timeout: 15000,
  reporter: [['list'], ['html', { outputFolder: path.join(root, `artifacts/browser/report${suffix}`), open: 'never' }], ['junit', { outputFile: path.join(root, `artifacts/browser/results${suffix}.xml`) }]],
  outputDir: path.join(root, `artifacts/browser/results${suffix}`),
  use: { baseURL: labOrigin || origin, locale: 'en-US', timezoneId: 'UTC', colorScheme: 'dark', reducedMotion: 'reduce', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: process.env.JE_CHROMIUM_PATH ? { executablePath: process.env.JE_CHROMIUM_PATH } : {} } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'], launchOptions: process.env.JE_CHROMIUM_PATH ? { executablePath: process.env.JE_CHROMIUM_PATH } : {} } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } }
  ],
  webServer: labOrigin ? undefined : { command: 'node tests/browser/server.cjs', cwd: root, url: origin, env: { ...process.env, JE_BROWSER_PORT: String(port) }, reuseExistingServer: false },
});
