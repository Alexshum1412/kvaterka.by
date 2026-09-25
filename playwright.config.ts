import { defineConfig, devices } from '@playwright/test';

/**
 * Browser end-to-end suite (DEC-086).
 *
 * Runs against a PRODUCTION build (`next start`) on a real PostgreSQL seeded
 * with the demo fixtures (`npm run db:seed`) — never against a live site.
 * The server is started by the caller (CI's `e2e` job, or by hand):
 *
 *   npm run build
 *   DATABASE_URL=… PUBLIC_BASE_URL=http://localhost:3100 npx next start -p 3100
 *   E2E_DATABASE_URL=… npm run e2e
 *
 * One worker: every flow mutates the same seeded database, and the flows are
 * the point, not their parallel speed.
 */
export default defineConfig({
  testDir: './e2e',
  workers: 1,
  fullyParallel: false,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3100',
    locale: 'ru-RU',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: process.env.PW_CHROMIUM_PATH
      ? { executablePath: process.env.PW_CHROMIUM_PATH }
      : undefined,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, testIgnore: /mobile/ },
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 375, height: 812 } }, testMatch: /mobile/ },
  ],
});
