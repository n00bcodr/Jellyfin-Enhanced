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
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: process.env.JE_CHROMIUM_PATH ? { executablePath: process.env.JE_CHROMIUM_PATH } : {} } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'], launchOptions: process.env.JE_CHROMIUM_PATH ? { executablePath: process.env.JE_CHROMIUM_PATH } : {} } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } }
  ],
  webServer: { command: 'node tests/browser/server.cjs', cwd: root, url: origin, env: { ...process.env, JE_BROWSER_PORT: String(port) }, reuseExistingServer: false },
});
