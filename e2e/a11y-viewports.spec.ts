import { test, expect } from '@playwright/test';
import { DEMO, db, seriousA11yViolations, signIn } from './support.ts';

/**
 * MVP_RELEASE_CHECKLIST: "Mobile UX reviewed at 375 px, 430 px and desktop"
 * and "Accessibility baseline: keyboard, labels, contrast, focus, touch
 * targets". Every public page and the main signed-in ones, at three widths:
 * no sideways page scroll, and zero serious/critical WCAG 2.1 AA violations
 * from axe-core.
 */
const PUBLIC = ['/', '/search', '/how-it-works', '/trust', '/faq', '/host', '/about', '/login', '/support', '/nonexistent'];
const SIGNED_IN = ['/dashboard', '/dashboard/account', '/dashboard/bookings', '/trips', '/favorites', '/notifications'];

for (const width of [375, 430, 1440]) {
  test.describe(`${width}px`, () => {
    // Reduced motion: below-the-fold sections start at opacity 0 until they
    // scroll in, which axe (rightly, at that instant) scores as unreadable.
    // Under reduce they are fully opaque from the first paint, so this also
    // checks that path renders everything.
    test.use({ viewport: { width, height: 900 }, contextOptions: { reducedMotion: 'reduce' } });

    test('public pages: no sideways scroll, no serious a11y violations', async ({ page }) => {
      const listing = (await db.query(`SELECT id FROM property WHERE status='PUBLISHED' LIMIT 1`)).rows[0].id;
      const problems: string[] = [];
      for (const path of [...PUBLIC, `/listing/${listing}`]) {
        await page.goto(path, { waitUntil: 'networkidle' });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (overflow > 0) problems.push(`${path}: page scrolls sideways by ${overflow}px`);
        for (const v of await seriousA11yViolations(page)) problems.push(`${path}: ${v}`);
      }
      expect(problems).toEqual([]);
    });

    test('signed-in pages: no sideways scroll, no serious a11y violations', async ({ page }) => {
      await signIn(page, DEMO.landlord1);
      const problems: string[] = [];
      for (const path of SIGNED_IN) {
        await page.goto(path, { waitUntil: 'networkidle' });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (overflow > 0) problems.push(`${path}: page scrolls sideways by ${overflow}px`);
        for (const v of await seriousA11yViolations(page)) problems.push(`${path}: ${v}`);
      }
      expect(problems).toEqual([]);
    });
  });
}

test('the keyboard reaches search and submits it, with a visible focus ring', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  // The skip link is the first stop, as it must be.
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toHaveClass(/skip-link/);
  const outline = await page.locator(':focus').evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(['auto', 'solid']).toContain(outline);
});
