import { test, expect } from '@playwright/test';
import { db } from './support.ts';

/**
 * MVP_RELEASE_CHECKLIST: "Mobile viewport tests" — the phone-only affordances
 * (the list/map dock, the booking dock) and the 44px touch-target floor, on a
 * touch device at 375px (Pixel 7 profile, `mobile` project).
 */
test('search switches between list and map from the bottom dock', async ({ page }) => {
  await page.goto('/search', { waitUntil: 'networkidle' });
  const dock = page.getByRole('group', { name: 'Переключить вид' });
  await expect(dock).toBeVisible();
  await dock.getByRole('button', { name: 'Карта' }).click();
  await expect(page.locator('.srch__map')).toBeVisible();
  await expect(page.locator('.srch__results')).toBeHidden();
  await dock.getByRole('button', { name: 'Список' }).click();
  await expect(page.locator('.srch__results')).toBeVisible();
});

test('the listing page keeps a booking entry point under the thumb', async ({ page }) => {
  // Ordered: an unordered LIMIT 1 picked a request-mode listing in CI, whose
  // dock says «Отправить запрос». Either label is the entry point under test.
  const id = (await db.query(`SELECT id FROM property WHERE status='PUBLISHED' ORDER BY id LIMIT 1`)).rows[0].id;
  await page.goto(`/listing/${id}`, { waitUntil: 'networkidle' });
  const book = page.locator('.lst__dock').getByRole('link', { name: /^(Забронировать|Отправить запрос)$/ });
  await expect(book).toBeVisible();
  await book.click();
  await expect(page.locator('.bp__dates')).toBeInViewport();
});

test('every control on the main pages is at least 44px on a touchscreen', async ({ page }) => {
  const id = (await db.query(`SELECT id FROM property WHERE status='PUBLISHED' LIMIT 1`)).rows[0].id;
  const small: string[] = [];
  for (const path of ['/', '/search', `/listing/${id}`, '/login', '/faq']) {
    await page.goto(path, { waitUntil: 'networkidle' });
    small.push(
      ...(await page.evaluate(
        (p) =>
          [...document.querySelectorAll('button, [role=button], input:not([type=hidden]), select, a.btn, a.chip, .leaflet-bar a')]
            .filter((e) => {
              const r = e.getBoundingClientRect();
              return r.width > 0 && getComputedStyle(e).visibility !== 'hidden' && (r.width < 44 || r.height < 44);
            })
            .map((e) => {
              const r = e.getBoundingClientRect();
              return `${p}: ${e.getAttribute('aria-label') ?? e.textContent?.trim().slice(0, 30)} ${Math.round(r.width)}x${Math.round(r.height)}`;
            }),
        path,
      )),
    );
  }
  expect([...new Set(small)]).toEqual([]);
});
