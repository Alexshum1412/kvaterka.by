import { createHash } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { db } from './support.ts';

/**
 * Registration is two steps, and the emailed code alone must not finish it:
 * whoever submits an address first chooses the password, so confirming also
 * takes the password from that first step. The in-page code step already holds
 * it and sends it unasked; the emailed link has to ask.
 */
const PASSWORD = 'ochen-dlinnaya-parol-e2e-1';
const CODE = '424242';

async function clearAuthLimits(): Promise<void> {
  // Every browser here comes from 127.0.0.1 and registering is 5 per IP per hour.
  await db.query(`DELETE FROM rate_limit_counter WHERE bucket LIKE 'auth:%'`);
}

/** The real code is mailed and stored only as a hash, so swap in one the test knows. */
async function useKnownCode(email: string): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE pending_registration SET code_hash=$1 WHERE lower(email)=lower($2)`,
    [createHash('sha256').update(CODE).digest(), email],
  );
  expect(rowCount).toBe(1);
}

async function accountExists(email: string): Promise<boolean> {
  const { rows } = await db.query(`SELECT 1 FROM app_user WHERE lower(email)=lower($1)`, [email]);
  return rows.length === 1;
}

/** Fill the sign-up form and land on the code step, with a pending row that has a known code. */
async function register(page: Page, email: string): Promise<void> {
  await clearAuthLimits();
  await page.goto('/login', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await page.getByLabel('Как вас зовут').fill('Регистрация Тест');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Повторите пароль').fill(PASSWORD);
  await page.locator('form.lf__form').getByRole('button', { name: 'Создать аккаунт' }).click();
  await expect(page.getByRole('heading', { name: 'Подтвердите почту' })).toBeVisible();
  await useKnownCode(email);
}

test('the in-page code step confirms with the password typed at sign-up, asking for nothing more', async ({
  page,
}) => {
  const email = `reg-inpage-${Date.now()}@example.by`;
  await register(page, email);

  await page.getByLabel('Код из письма').fill(CODE);
  await page.getByRole('button', { name: 'Подтвердить', exact: true }).click();

  await expect(page).toHaveURL(/\/dashboard/);
  expect(await accountExists(email)).toBe(true);
});

test('the emailed link asks for the password, sends nothing before it, and rejects one the registrant did not choose', async ({
  page,
}) => {
  const email = `reg-link-${Date.now()}@example.by`;
  await register(page, email);

  const confirmRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/auth/register/confirm')) confirmRequests.push(request.postData() ?? '');
  });

  // networkidle: typing before hydration is swallowed and the field comes back empty.
  await page.goto(`/verify-email?identifier=${encodeURIComponent(email)}&code=${CODE}`, {
    waitUntil: 'networkidle',
  });
  const password = page.getByLabel('Пароль, указанный при регистрации');
  await expect(password).toBeVisible();
  expect(confirmRequests).toEqual([]);

  // Somebody who received the mail but never chose the password.
  await password.fill('not-the-password-they-chose');
  await page.getByRole('button', { name: 'Подтвердить почту' }).click();
  await expect(page.getByText('Пароль не совпадает с указанным при регистрации.')).toBeVisible();
  expect(await accountExists(email)).toBe(false);
  expect(confirmRequests).toHaveLength(1);

  await password.fill(PASSWORD);
  await page.getByRole('button', { name: 'Подтвердить почту' }).click();
  await expect(page.getByText('Почта подтверждена')).toBeVisible();
  expect(await accountExists(email)).toBe(true);
  expect(JSON.parse(confirmRequests[1]!)).toMatchObject({
    identifier: email,
    code: CODE,
    password: PASSWORD,
  });

  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard/);
});
