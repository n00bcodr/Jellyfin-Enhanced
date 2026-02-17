import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for Jellyfin Enhanced spoiler mode E2E tests.
 *
 * These tests run against a local Jellyfin dev server at http://localhost:8097
 * and verify that the spoiler mode feature correctly protects unwatched
 * episode content across home, season, and series detail pages.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['list'],
  ],
  timeout: 90_000,
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL: 'http://localhost:8097',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
