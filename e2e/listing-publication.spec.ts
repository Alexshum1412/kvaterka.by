import { test, expect, type Page } from '@playwright/test';
import { deflateSync } from 'node:zlib';
import { DEMO, db, signIn, signInStaff } from './support.ts';

/**
 * MVP_RELEASE_CHECKLIST: "Landlord: create → moderated → published" and
 * "Admin: moderate … view audit". A new listing goes through all nine wizard
 * steps with a real photo upload, is submitted, approved by an administrator
 * who first enrols a second factor exactly as a real one would, and then shows
 * up in public search.
 */

/** A small real PNG — the upload route sniffs magic bytes, so it must be one. */
function png(width = 64, height = 48): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x6a)])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const next = (page: Page) => page.getByRole('button', { name: 'Далее' }).click();

test('a landlord publishes a new listing through moderation, and a visitor finds it', async ({ browser }) => {
  // Precondition a browser cannot produce: a verified +375 number (DEC-076;
  // verification itself happens in Telegram).
  await db.query(
    `UPDATE app_user SET phone='+375291234567', phone_verified_at=now() WHERE email=$1`,
    [DEMO.landlord1],
  );
  const title = `Тихая квартира у парка ${Date.now().toString(36)}`;

  const landlord = await (await browser.newContext()).newPage();
  await signIn(landlord, DEMO.landlord1);
  await landlord.goto('/dashboard/listings/new', { waitUntil: 'networkidle' });

  await landlord.getByRole('button', { name: /Квартира/ }).first().click();
  await expect(landlord.getByText('Где находится жильё?')).toBeVisible();
  await landlord.getByLabel('Город').fill('Минск');
  await next(landlord);

  await landlord.locator('input[type="file"]').setInputFiles({ name: 'room.png', mimeType: 'image/png', buffer: png() });
  await expect(landlord.getByRole('img', { name: /Фото 1 из 1/ })).toBeVisible();
  await next(landlord);

  await landlord.getByLabel('Название объявления').fill(title);
  await landlord.getByLabel('Описание').fill('Две комнаты, окна во двор, рядом парк и остановка. Всё для жизни.');
  await next(landlord);
  await next(landlord); // amenities
  await next(landlord); // rules
  await landlord.getByRole('button', { name: 'Только посуточно' }).click();
  await next(landlord);
  await landlord.getByLabel('Цена за ночь, Br').fill('85');
  await next(landlord);

  await landlord.getByRole('button', { name: 'Отправить на проверку' }).click();
  await expect
    .poll(async () => (await db.query(`SELECT status FROM property WHERE title=$1`, [title])).rows[0]?.status)
    .toBe('PENDING_MODERATION');

  // Administrator: second factor first — staff roles are withheld until then.
  const admin = await (await browser.newContext()).newPage();
  await signInStaff(admin, DEMO.admin);

  const { rows } = await db.query(`SELECT id FROM property WHERE title=$1`, [title]);
  await admin.goto(`/moderation/${rows[0].id}`, { waitUntil: 'networkidle' });
  await admin.getByRole('button', { name: /Одобрить|Опубликовать/ }).first().click();
  await expect
    .poll(async () => (await db.query(`SELECT status FROM property WHERE title=$1`, [title])).rows[0]?.status)
    .toBe('PUBLISHED');

  // The audit trail recorded it, and the staff audit screen shows it.
  await admin.goto('/staff/audit', { waitUntil: 'networkidle' });
  await expect(admin.getByText('listing.moderate').first()).toBeVisible();

  // Anyone can now find it.
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto('/search?city=Минск', { waitUntil: 'networkidle' });
  await expect(visitor.getByRole('link', { name: new RegExp(title) }).first()).toBeVisible();
});
