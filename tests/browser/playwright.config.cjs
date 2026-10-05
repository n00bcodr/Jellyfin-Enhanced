const { defineConfig, devices } = require('@playwright/test');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
module.exports = defineConfig({
  testDir: __dirname, fullyParallel: true, forbidOnly: !!process.env.CI,
  retries: 0, workers: process.env.CI ? 2 : 3, timeout: 15000,
  reporter: [['list'], ['html', { outputFolder: path.join(root, 'artifacts/browser/report'), open: 'never' }], ['junit', { outputFile: path.join(root, 'artifacts/browser/results.xml') }]],
  outputDir: path.join(root, 'artifacts/browser/results'),
  use: { baseURL: 'http://127.0.0.1:4179', locale: 'en-US', timezoneId: 'UTC', colorScheme: 'dark', reducedMotion: 'reduce', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: process.env.JE_CHROMIUM_PATH ? { executablePath: process.env.JE_CHROMIUM_PATH } : {} } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'], launchOptions: process.env.JE_CHROMIUM_PATH ? { executablePath: process.env.JE_CHROMIUM_PATH } : {} } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } }
  ],
  webServer: { command: 'node tests/browser/server.cjs', cwd: root, url: 'http://127.0.0.1:4179', reuseExistingServer: false },
});
