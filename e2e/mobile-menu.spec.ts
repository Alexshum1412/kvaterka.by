import { test, expect, type Page } from '@playwright/test';
import { DEMO, signIn } from './support.ts';

/**
 * The header's menu panel and the touch-target floor around it, on a phone
 * (Pixel 7 profile at 375px, the `mobile` project). Signed out, so nothing
 * here depends on a session except the last test.
 */
const toggle = (page: Page) => page.locator('.sh__menuBtn');
const panelState = (page: Page) => page.locator('.sh__mobileNav');

// A tap that lands before hydration does nothing, so tap again until the panel is open.
async function openMenu(page: Page) {
  await expect(async () => {
    if ((await panelState(page).getAttribute('data-open')) !== 'true') await toggle(page).click();
    await expect(panelState(page)).toHaveAttribute('data-open', 'true', { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

test('the language can be changed from the menu, where the bar has no room for the pills', async ({
  page,
}) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  // At this width the bar's own switcher is display:none and the footer offers none.
  await expect(page.locator('.sh__prefs .lsw')).toBeHidden();
  await openMenu(page);

  const pills = page.locator('#sh-mobile-nav .lsw__pill');
  await expect(pills).toHaveCount(3);
  // A 44px box at Pixel 7's fractional device scale is measured as 43.99998 (CI
  // failed on exactly that), and it is still a 44px target: compare rounded sizes.
  for (const pill of await pills.all()) {
    const box = (await pill.boundingBox())!;
    expect(Math.round(box.height)).toBeGreaterThanOrEqual(44);
    expect(Math.round(box.width)).toBeGreaterThanOrEqual(44);
  }

  await pills.filter({ hasText: 'EN' }).click();
  await expect(page).toHaveURL(/\/en\/?$/);
  await expect(panelState(page)).toHaveAttribute('data-open', 'false');
});

test('Escape closes the menu and puts focus back on its button', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await openMenu(page);
  await page.locator('#sh-mobile-nav a').first().focus();
  await page.keyboard.press('Escape');
  await expect(panelState(page)).toHaveAttribute('data-open', 'false');
  await expect(toggle(page)).toBeFocused();
});

test('a tap on the link to the page already open closes the menu', async ({ page }) => {
  // The panel used to close only when the pathname changed, so this link left
  // it, and its scrim, standing over the page the visitor had just asked for.
  await page.goto('/search', { waitUntil: 'networkidle' });
  await openMenu(page);
  await page.locator('#sh-mobile-nav a[href="/search"]').click();
  await expect(panelState(page)).toHaveAttribute('data-open', 'false');
});

test('the language pills in the bar have a 44px touch area without widening the bar', async ({ page }) => {
  // Above 560px the pills are back in the bar, beside the theme toggle.
  await page.setViewportSize({ width: 600, height: 812 });
  await page.goto('/', { waitUntil: 'networkidle' });
  const pills = page.locator('.sh__prefs .lsw__pill');
  await expect(pills).toHaveCount(3);
  for (const pill of await pills.all()) {
    expect(Math.round((await pill.boundingBox())!.height)).toBeGreaterThanOrEqual(44);
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
  ).toBe(true);
});

test('text links in the page body and footer are at least 44px tall on a touchscreen', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  const small = await page.evaluate(() =>
    [...document.querySelectorAll('.home-more, .ftr__link')]
      .filter((e) => Math.round(e.getBoundingClientRect().height) < 44)
      .map((e) => `${e.textContent?.trim().slice(0, 30)} ${Math.round(e.getBoundingClientRect().height)}`),
  );
  expect(small).toEqual([]);
});

test('the dashboard section links are at least 44px tall on a touchscreen', async ({ page }) => {
  await signIn(page, DEMO.tenant);
  await page.goto('/dashboard', { waitUntil: 'networkidle' });
  const small = await page.evaluate(() =>
    [...document.querySelectorAll('.dsh__navLink')]
      .filter((e) => Math.round(e.getBoundingClientRect().height) < 44)
      .map((e) => `${e.textContent?.trim()} ${Math.round(e.getBoundingClientRect().height)}`),
  );
  expect(small).toEqual([]);
});
