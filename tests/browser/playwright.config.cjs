const { defineConfig, devices } = require('@playwright/test');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
// One port for the fixture server, its readiness probe and every test URL.
const port = Number(process.env.JE_BROWSER_PORT || 4179);
const origin = `http://127.0.0.1:${port}`;
module.exports = defineConfig({
  testDir: __dirname, fullyParallel: true, forbidOnly: !!process.env.CI,
  retries: 0, workers: process.env.CI ? 2 : 3, timeout: 15000,
  reporter: [['list'], ['html', { outputFolder: path.join(root, 'artifacts/browser/report'), open: 'never' }], ['junit', { outputFile: path.join(root, 'artifacts/browser/results.xml') }]],
  outputDir: path.join(root, 'artifacts/browser/results'),
  use: { baseURL: origin, locale: 'en-US', timezoneId: 'UTC', colorScheme: 'dark', reducedMotion: 'reduce', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  // @timing cases measure long tasks against a budget: they run after the Chromium projects, one browser at a time, and
  // Firefox runs after them, so the suite's own parallel workers are never what they measure (`--no-deps` runs one
  // project alone).
  projects: [
    { name: 'chromium', grepInvert: /@timing/, use: { ...devices['Desktop Chrome'], launchOptions: process.env.JE_CHROMIUM_PATH ? { executablePath: process.env.JE_CHROMIUM_PATH } : {} } },
    { name: 'mobile-chromium', grepInvert: /@timing/, use: { ...devices['Pixel 7'], launchOptions: process.env.JE_CHROMIUM_PATH ? { executablePath: process.env.JE_CHROMIUM_PATH } : {} } },
    { name: 'firefox', grepInvert: /@timing/, dependencies: ['mobile-chromium-timing'], use: { ...devices['Desktop Firefox'] } },
    { name: 'chromium-timing', grep: /@timing/, dependencies: ['chromium', 'mobile-chromium'], use: { ...devices['Desktop Chrome'], launchOptions: process.env.JE_CHROMIUM_PATH ? { executablePath: process.env.JE_CHROMIUM_PATH } : {} } },
    { name: 'mobile-chromium-timing', grep: /@timing/, dependencies: ['chromium-timing'], use: { ...devices['Pixel 7'], launchOptions: process.env.JE_CHROMIUM_PATH ? { executablePath: process.env.JE_CHROMIUM_PATH } : {} } }
  ],
  webServer: { command: 'node tests/browser/server.cjs', cwd: root, url: origin, env: { ...process.env, JE_BROWSER_PORT: String(port) }, reuseExistingServer: false },
});
