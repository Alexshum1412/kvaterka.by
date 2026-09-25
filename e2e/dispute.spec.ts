import { test, expect } from '@playwright/test';
import { DEMO, db, freshStay, signIn, signInStaff } from './support.ts';

/**
 * MVP_RELEASE_CHECKLIST: "Admin: … resolve a dispute". A tenant books an
 * instant listing, checks out, says something went wrong and opens a case; an
 * administrator takes it and records a decision.
 */
test('a tenant opens a dispute and an administrator resolves it', async ({ browser }) => {
  const tenant = await (await browser.newContext()).newPage();
  await signIn(tenant, DEMO.tenant);

  const { rows } = await db.query(`SELECT id FROM property WHERE booking_mode='INSTANT' AND status='PUBLISHED' LIMIT 1`);
  await tenant.goto(`/listing/${rows[0].id}`);
  const stay = freshStay(2);
  const dates = tenant.locator('.bp__dates input[type="date"]');
  await dates.nth(0).fill(stay.from);
  await dates.nth(1).fill(stay.to);
  await tenant.locator('.bp__actions').getByRole('button', { name: 'Забронировать сразу' }).click();
  await tenant.locator('.bp__confirm').getByRole('button', { name: 'Подтвердить бронирование' }).click();
  await expect(tenant.getByText('Бронирование подтверждено')).toBeVisible();
  await tenant.locator('.bp--done a[href*="/bookings/"]').click();
  await expect(tenant).toHaveURL(/\/bookings\/[0-9a-f-]{36}/);
  const bookingId = new URL(tenant.url()).pathname.split('/').pop()!;

  await tenant.getByRole('button', { name: 'Подтвердить заселение' }).click();
  tenant.once('dialog', (dialog) => void dialog.accept());
  await tenant.getByRole('button', { name: 'Проживание закончилось' }).click();
  await tenant.getByRole('button', { name: 'Возникла проблема' }).click();
  await tenant.getByRole('button', { name: new RegExp('Аренда была, но возникла проблема') }).click();
  await tenant.getByLabel('Что случилось').selectOption({ index: 1 });
  await tenant.locator('textarea').last().fill('Горячей воды не было все двое суток, хозяин не отвечал на сообщения.');
  await tenant.getByRole('button', { name: 'Отправить обращение' }).click();
  await expect
    .poll(async () => (await db.query(`SELECT count(*)::int AS c FROM dispute_case WHERE booking_id=$1`, [bookingId])).rows[0].c)
    .toBe(1);

  const admin = await (await browser.newContext()).newPage();
  await signInStaff(admin, DEMO.admin);
  const caseId = (await db.query(`SELECT id FROM dispute_case WHERE booking_id=$1`, [bookingId])).rows[0].id;
  await admin.goto(`/staff/disputes/${caseId}`);
  await admin.getByRole('button', { name: 'Взять в работу' }).click();
  await admin.getByRole('button', { name: 'Принять решение' }).click();
  await admin.getByLabel('Решение по обращению').fill('Проверили переписку: неисправность подтверждена, аренда не засчитывается.');
  await admin.getByRole('button', { name: /Подтвердить|Принять решение|Сохранить/ }).last().click();
  await expect
    .poll(async () => (await db.query(`SELECT status FROM dispute_case WHERE id=$1`, [caseId])).rows[0].status)
    .toBe('RESOLVED');
});
