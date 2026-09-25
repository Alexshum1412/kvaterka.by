import { test, expect } from '@playwright/test';
import { DEMO, db, freshStay, signIn } from './support.ts';

/**
 * MVP_RELEASE_CHECKLIST: "Tenant: search → listing → request → confirmed →
 * check-in → completion → review" and the landlord's half of it: "accept →
 * completion → fee → debt visible". Two browsers, two people, one booking,
 * every step a click on the real production build.
 */
test('a request booking goes all the way to a review and a fee', async ({ browser }) => {
  const tenant = await (await browser.newContext()).newPage();
  const landlord = await (await browser.newContext()).newPage();
  await signIn(tenant, DEMO.tenant);
  await signIn(landlord, DEMO.landlord2);

  // Tenant: search → listing
  await tenant.goto('/search?city=Брест');
  await tenant.getByRole('link', { name: /Дом с участком под Брестом/ }).first().click();
  await expect(tenant.getByRole('heading', { level: 1, name: /Дом с участком/ })).toBeVisible();

  // → request
  const stay = freshStay(3);
  const dates = tenant.locator('.bp__dates input[type="date"]');
  await dates.nth(0).fill(stay.from);
  await dates.nth(1).fill(stay.to);
  await tenant.locator('.bp__actions').getByRole('button', { name: 'Отправить заявку' }).click();
  await tenant.locator('.bp__confirm').getByRole('button', { name: 'Отправить заявку' }).click();
  await expect(tenant.getByText('Запрос отправлен')).toBeVisible();
  await tenant.locator('.bp--done a[href*="/bookings/"]').click();
  await expect(tenant).toHaveURL(/\/bookings\/[0-9a-f-]{36}/);
  const bookingPath = new URL(tenant.url()).pathname;

  // Landlord: accept
  await landlord.goto(bookingPath);
  await landlord.getByRole('button', { name: 'Принять заявку' }).click();
  // Not "the button is gone": while the request is in flight it relabels to
  // "Отправляем…", which satisfies that before anything is committed.
  const bookingId = bookingPath.split('/').pop()!;
  await expect
    .poll(async () => (await db.query(`SELECT status FROM booking WHERE id=$1`, [bookingId])).rows[0].status)
    .toBe('CONFIRMED');

  // Tenant: check-in, check-out
  await tenant.reload();
  await tenant.getByRole('button', { name: 'Подтвердить заселение' }).click();
  // The check-out asks through the browser's own confirm() dialog.
  tenant.once('dialog', (dialog) => void dialog.accept());
  await tenant.getByRole('button', { name: 'Проживание закончилось' }).click();

  // Both sides: it took place
  await tenant.getByRole('button', { name: 'Да, всё состоялось' }).click();
  await expect(tenant.getByText('Вы подтвердили, что аренда состоялась.')).toBeVisible();
  await landlord.reload();
  await landlord.getByRole('button', { name: 'Да, всё состоялось' }).click();

  // The fee exists, exactly once, and the landlord can see what they owe.
  await expect
    .poll(async () => (await db.query(`SELECT count(*)::int AS c FROM service_fee WHERE booking_id=$1`, [bookingId])).rows[0].c)
    .toBe(1);
  await landlord.goto('/dashboard/finance');
  await expect(landlord.getByText(/Br/).first()).toBeVisible();
  const { rows } = await db.query(`SELECT status FROM booking WHERE id=$1`, [bookingId]);
  expect(rows[0].status).toBe('COMPLETED');

  // Tenant: review
  await tenant.goto(`${bookingPath}/review`);
  // Every rating a real guest is asked for, then the text and the recommendation.
  for (const star of await tenant.getByRole('button', { name: /: 5 из 5$/ }).all()) await star.click();
  await tenant.getByRole('textbox').last().fill('Тёплый дом, хозяин на связи, всё как в объявлении.');
  await tenant.getByRole('button', { name: 'Да', exact: true }).click();
  await tenant.getByRole('button', { name: 'Отправить отзыв' }).click();
  await expect
    .poll(async () => (await db.query(`SELECT count(*)::int AS c FROM review WHERE booking_id=$1`, [bookingId])).rows[0].c)
    .toBe(1);
});
