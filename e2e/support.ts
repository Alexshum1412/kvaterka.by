import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import pg from 'pg';
import { expect, type Page } from '@playwright/test';

/** The demo fixtures' shared password — public in src/server/db/seed.ts, local/CI only. */
export const DEMO_PASSWORD = process.env.E2E_DEMO_PASSWORD ?? 'sonca-nad-nemanam-2026';

export const DEMO = {
  tenant: 'tenant@demo.kvaterka.by',
  landlord1: 'landlord1@demo.kvaterka.by',
  landlord2: 'landlord2@demo.kvaterka.by',
  admin: 'admin@demo.kvaterka.by',
} as const;

/** Direct database access for the few things a browser cannot do: read a secret, move a clock. */
export const db = new pg.Pool({
  connectionString: process.env.E2E_DATABASE_URL ?? 'postgres://kvaterka:kvaterka@localhost:55432/kvaterka_e2e',
  max: 2,
});

export async function signIn(page: Page, email: string): Promise<void> {
  // Every browser here signs in from 127.0.0.1, and the login limit is 10 per
  // IP per 15 minutes — working as intended, and in the way of a test suite.
  await db.query(`DELETE FROM rate_limit_counter WHERE bucket LIKE 'auth:%'`);
  await page.goto('/login');
  await page.getByLabel('Email или телефон').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Войти', exact: true }).last().click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** A stay far enough out, and random enough, that reruns never collide on the calendar. */
export function freshStay(nights = 3): { from: string; to: string } {
  const start = new Date(Date.now() + (40 + Math.floor(Math.random() * 600)) * 86_400_000);
  const end = new Date(start.getTime() + nights * 86_400_000);
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) — what an authenticator app computes. */
export function totp(base32: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of base32.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1]! & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

/** WCAG 2.1 A/AA violations axe rates serious or critical, as "rule: target" lines. */
export async function seriousA11yViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ content: axeSource });
  const violations = await page.evaluate(async () => {
    // @ts-expect-error injected above
    const result = await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] });
    return result.violations as { id: string; impact: string; nodes: { target: string[] }[] }[];
  });
  return violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
}

/**
 * Sign a staff member in the way a fresh deployment's first one would: any
 * earlier enrolment is cleared, then the second factor is enrolled through
 * /staff/security with a code computed from the secret the page shows.
 * Staff roles are withheld until this is done (DEC-04x), so every staff flow
 * starts here.
 */
export async function signInStaff(page: Page, email: string): Promise<void> {
  const user = `(SELECT id FROM app_user WHERE email=$1)`;
  await db.query(`DELETE FROM two_factor_recovery_code WHERE user_id=${user}`, [email]);
  await db.query(`DELETE FROM user_totp WHERE user_id=${user}`, [email]);
  await signIn(page, email);
  await page.goto('/staff/security');
  await page.getByLabel('Подтвердите паролем').fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Настроить' }).click();
  const secret = (await page.locator('.tfa__secret').innerText()).replace(/\s+/g, '');
  await page.locator('.tfa__code').first().fill(totp(secret));
  await page.getByRole('button', { name: /Подтвердить|Включить/ }).first().click();
  await expect(page.getByText(/резервн|коды восстановления/i).first()).toBeVisible();
}
