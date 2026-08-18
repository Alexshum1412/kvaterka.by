/**
 * Demo seed data.
 *
 * Used by the zero-setup development mode (`DATABASE_URL=pglite`) and by
 * `npm run db:seed`. Everything here goes through the ordinary schema and the
 * ordinary constraints — these are real rows, not fixtures that bypass
 * validation.
 */

import { uuidv7 } from '../../lib/id.ts';
import { publicLocationFor } from '../domain/geo.ts';
import { hashPassword } from '../auth/credentials.ts';
import type { Db } from './sql.ts';

const AMENITIES: [string, string, string, string, string, number][] = [
  ['WIFI', 'ESSENTIALS', 'Wi-Fi', 'Wi-Fi', 'Wi-Fi', 10],
  ['HEATING', 'ESSENTIALS', 'Отопление', 'Ацяпленне', 'Heating', 20],
  ['AIR_CONDITIONING', 'ESSENTIALS', 'Кондиционер', 'Кандыцыянер', 'Air conditioning', 30],
  ['KITCHEN', 'KITCHEN', 'Кухня', 'Кухня', 'Kitchen', 110],
  ['DISHWASHER', 'KITCHEN', 'Посудомоечная машина', 'Посудамыйная машына', 'Dishwasher', 160],
  ['WASHING_MACHINE', 'BATHROOM', 'Стиральная машина', 'Пральная машына', 'Washing machine', 210],
  ['WORKSPACE', 'WORK', 'Рабочее место', 'Працоўнае месца', 'Workspace', 310],
  ['TV', 'WORK', 'Телевизор', 'Тэлевізар', 'TV', 320],
  ['ELEVATOR', 'BUILDING', 'Лифт', 'Ліфт', 'Elevator', 410],
  ['PARKING_FREE', 'BUILDING', 'Бесплатная парковка', 'Бясплатная паркоўка', 'Free parking', 420],
  ['BALCONY', 'BUILDING', 'Балкон', 'Балкон', 'Balcony', 440],
  ['CRIB', 'FAMILY', 'Детская кроватка', 'Дзіцячы ложачак', 'Baby crib', 510],
];

interface DemoListing {
  title: string;
  description: string;
  type: string;
  city: string;
  district: string;
  lat: number;
  lng: number;
  rooms: number;
  area: number;
  floor: number;
  totalFloors: number;
  beds: number;
  guests: number;
  priceMinor: number;
  unit: 'NIGHT' | 'MONTH';
  cleaning: number;
  deposit: number;
  minNights: number;
  maxNights: number;
  mode: string;
  pets: string;
  smoking: string;
  amenities: string[];
  utilities: string;
  utilitiesFixed: number;
}

const LISTINGS: DemoListing[] = [
  {
    title: 'Светлая двушка у метро Немига',
    description:
      'Тихая квартира в центре с окнами во двор. Полностью оборудованная кухня, быстрый интернет, ' +
      'удобное рабочее место у окна. До метро 6 минут пешком.',
    type: 'APARTMENT', city: 'Минск', district: 'Центральный',
    lat: 53.9045, lng: 27.5615, rooms: 2, area: 54, floor: 4, totalFloors: 9, beds: 3, guests: 4,
    priceMinor: 9000, unit: 'NIGHT', cleaning: 3000, deposit: 30000,
    minNights: 2, maxNights: 90, mode: 'INSTANT_AND_REQUEST',
    pets: 'ON_REQUEST', smoking: 'PROHIBITED',
    amenities: ['WIFI', 'KITCHEN', 'WASHING_MACHINE', 'WORKSPACE', 'ELEVATOR', 'BALCONY', 'TV'],
    utilities: 'INCLUDED', utilitiesFixed: 0,
  },
  {
    title: 'Просторная квартира на длительный срок, Уручье',
    description:
      'Сдаётся на срок от трёх месяцев. Спальный район, рядом школа и парк. Коммунальные платежи ' +
      'по счётчику оплачиваются отдельно.',
    type: 'APARTMENT', city: 'Минск', district: 'Первомайский',
    lat: 53.9520, lng: 27.6800, rooms: 3, area: 78, floor: 7, totalFloors: 12, beds: 4, guests: 5,
    priceMinor: 190000, unit: 'MONTH', cleaning: 0, deposit: 190000,
    minNights: 90, maxNights: 730, mode: 'REQUEST',
    pets: 'ALLOWED', smoking: 'BALCONY_ONLY',
    amenities: ['WIFI', 'KITCHEN', 'WASHING_MACHINE', 'DISHWASHER', 'ELEVATOR', 'PARKING_FREE', 'CRIB'],
    utilities: 'VARIABLE_METERED', utilitiesFixed: 0,
  },
  {
    title: 'Студия для командировки, Октябрьская',
    description: 'Компактная студия рядом с деловым центром. Заезд в любое время, бесконтактное заселение.',
    type: 'STUDIO', city: 'Минск', district: 'Партизанский',
    lat: 53.8950, lng: 27.5900, rooms: 1, area: 28, floor: 2, totalFloors: 5, beds: 1, guests: 2,
    priceMinor: 6500, unit: 'NIGHT', cleaning: 2000, deposit: 15000,
    minNights: 1, maxNights: 30, mode: 'INSTANT',
    pets: 'PROHIBITED', smoking: 'PROHIBITED',
    amenities: ['WIFI', 'KITCHEN', 'WORKSPACE', 'AIR_CONDITIONING', 'TV'],
    utilities: 'INCLUDED', utilitiesFixed: 0,
  },
  {
    title: 'Квартира в старом городе, Гродно',
    description: 'Историческая часть города, вид на костёл. Высокие потолки, свежий ремонт.',
    type: 'APARTMENT', city: 'Гродно', district: 'Центр',
    lat: 53.6778, lng: 23.8295, rooms: 2, area: 61, floor: 3, totalFloors: 4, beds: 3, guests: 4,
    priceMinor: 7500, unit: 'NIGHT', cleaning: 2500, deposit: 20000,
    minNights: 2, maxNights: 60, mode: 'INSTANT_AND_REQUEST',
    pets: 'PROHIBITED', smoking: 'PROHIBITED',
    amenities: ['WIFI', 'KITCHEN', 'WASHING_MACHINE', 'BALCONY', 'TV'],
    utilities: 'FIXED_EXTRA', utilitiesFixed: 4500,
  },
  {
    title: 'Дом с участком под Брестом',
    description: 'Отдельный дом с двором и мангалом. Подходит для семьи или компании. Парковка на участке.',
    type: 'HOUSE', city: 'Брест', district: 'Пригород',
    lat: 52.0976, lng: 23.7341, rooms: 4, area: 120, floor: 1, totalFloors: 2, beds: 6, guests: 8,
    priceMinor: 16000, unit: 'NIGHT', cleaning: 5000, deposit: 40000,
    minNights: 2, maxNights: 45, mode: 'REQUEST',
    pets: 'ALLOWED', smoking: 'BALCONY_ONLY',
    amenities: ['WIFI', 'KITCHEN', 'WASHING_MACHINE', 'PARKING_FREE', 'HEATING', 'TV'],
    utilities: 'VARIABLE_METERED', utilitiesFixed: 0,
  },
  {
    title: 'Комната в центре Витебска',
    description: 'Отдельная комната в квартире хозяина. Тихие соседи, всё в пешей доступности.',
    type: 'ROOM', city: 'Витебск', district: 'Центр',
    lat: 55.1904, lng: 30.2049, rooms: 1, area: 18, floor: 5, totalFloors: 9, beds: 1, guests: 2,
    priceMinor: 4000, unit: 'NIGHT', cleaning: 1500, deposit: 10000,
    minNights: 1, maxNights: 120, mode: 'REQUEST',
    pets: 'PROHIBITED', smoking: 'PROHIBITED',
    amenities: ['WIFI', 'KITCHEN', 'ELEVATOR'],
    utilities: 'INCLUDED', utilitiesFixed: 0,
  },
];

export async function seedDemoData(db: Db): Promise<{ listings: number }> {
  const existing = await db.query<{ c: string }>(`SELECT count(*)::text AS c FROM property`);
  if (Number(existing.rows[0]!.c) > 0) return { listings: 0 };

  for (const [code, category, ru, be, en, order] of AMENITIES) {
    await db.query(
      `INSERT INTO amenity (code, category, name_ru, name_be, name_en, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (code) DO NOTHING`,
      [code, category, ru, be, en, order],
    );
  }

  for (const [key, enabled, description, legal] of [
    ['rewards.lottery', false, 'Prize draw. Requires LEGAL-012.', true],
    ['fee.enforcement', true, 'Service fee accrues as payable debt. LEGAL-016 unverified.', true],
    ['verification.identity_documents', false, 'Identity document collection. Requires LEGAL-004.', true],
    ['notifications.telegram', true, 'Telegram channel, opt-in per user.', false],
  ] as const) {
    await db.query(
      `INSERT INTO feature_flag (key, enabled, description, requires_legal_approval)
       VALUES ($1,$2,$3,$4) ON CONFLICT (key) DO NOTHING`,
      [key, enabled, description, legal],
    );
  }

  // Runs through the real password policy, which is why it cannot contain the
  // product name — the banned-substring rule catches it.
  const password = await hashPassword('sonca-nad-nemanam-2026');

  const landlords: string[] = [];
  for (const [index, name] of ['Алесь Кавалёк', 'Ірына Сурмач', 'МінскРэнт'].entries()) {
    const id = uuidv7();
    await db.query(
      `INSERT INTO app_user (id, email, display_name, password_hash, account_kind, company_name,
          email_verified_at, verification_level, completed_rentals_as_landlord)
       VALUES ($1,$2,$3,$4,$5,$6, now(), $7, $8)`,
      [
        id,
        `landlord${index + 1}@demo.kvaterka.by`,
        name,
        password,
        index === 2 ? 'COMPANY' : 'PRIVATE',
        index === 2 ? 'ООО «МінскРэнт»' : null,
        index === 0 ? 2 : 1,
        index === 0 ? 12 : index === 1 ? 4 : 31,
      ],
    );
    await db.query(`INSERT INTO user_role (user_id, role) VALUES ($1,'LANDLORD'), ($1,'TENANT')`, [id]);
    landlords.push(id);
  }

  const tenantId = uuidv7();
  await db.query(
    `INSERT INTO app_user (id, email, display_name, password_hash, email_verified_at,
        verification_level, completed_rentals_as_tenant)
     VALUES ($1,'tenant@demo.kvaterka.by','Дзмітрый Ляшчэня',$2, now(), 1, 3)`,
    [tenantId, password],
  );
  await db.query(`INSERT INTO user_role (user_id, role) VALUES ($1,'TENANT')`, [tenantId]);

  /* A moderator, so the moderation console is reachable in development.
     MODERATOR only — deliberately not VERIFIER, because the whole point of
     that split is that reviewing a listing and reading somebody's passport
     are different jobs held by different people (rbac.ts). */
  const moderatorId = uuidv7();
  await db.query(
    `INSERT INTO app_user (id, email, display_name, password_hash, email_verified_at, verification_level)
     VALUES ($1,'moderator@demo.kvaterka.by','Ганна Мадэратар',$2, now(), 2)`,
    [moderatorId, password],
  );
  await db.query(`INSERT INTO user_role (user_id, role) VALUES ($1,'MODERATOR')`, [moderatorId]);

  /* A support agent and an administrator, so the operations console can be
     walked end to end in development.

     Without these the console's two most consequential paths — deciding a case
     and deciding the disputed booking behind it — cannot be exercised by
     clicking at all, only by a test. That is the wrong way round for the part
     of the product that moves somebody's money.

     These are safe to seed because `seedDemoData` is only ever called from the
     `DATABASE_URL=pglite` branch of the runtime, and pglite throws outright
     when NODE_ENV is production. A demo administrator cannot reach a
     production database through this path.

     SUPPORT deliberately gets `case.handle` without `case.resolve`, which is
     what makes the split visible while developing: log in as support and the
     resolve buttons are simply not there. */
  const supportId = uuidv7();
  await db.query(
    `INSERT INTO app_user (id, email, display_name, password_hash, email_verified_at, verification_level)
     VALUES ($1,'support@demo.kvaterka.by','Марына Падтрымка',$2, now(), 1)`,
    [supportId, password],
  );
  await db.query(`INSERT INTO user_role (user_id, role) VALUES ($1,'SUPPORT')`, [supportId]);

  const adminId = uuidv7();
  await db.query(
    `INSERT INTO app_user (id, email, display_name, password_hash, email_verified_at, verification_level)
     VALUES ($1,'admin@demo.kvaterka.by','Сяргей Адміністратар',$2, now(), 2)`,
    [adminId, password],
  );
  // ADMIN, and still not VERIFIER: reading somebody's passport stays a
  // separate grant even for the demo administrator (rbac.ts).
  await db.query(`INSERT INTO user_role (user_id, role) VALUES ($1,'ADMIN')`, [adminId]);

  /* A verifier, because otherwise the one role whose entire job is a staff
     screen has no account that can open it. VERIFIER holds `document.read`,
     which ADMIN deliberately does not, so signing in as each of them is how the
     split becomes visible while developing: the administrator can work the
     verification queue and refuse a request, and simply has no approve button.

     Safe for the same reason as the other staff fixtures: `seedDemoData` runs
     only from the `DATABASE_URL=pglite` branch, and pglite throws outright when
     NODE_ENV is production.

     Note that this account still cannot open a document today — the
     `verification.identity_documents` flag is off pending LEGAL-004, and the
     route refuses regardless of role. That is the point. */
  const verifierId = uuidv7();
  await db.query(
    `INSERT INTO app_user (id, email, display_name, password_hash, email_verified_at, verification_level)
     VALUES ($1,'verifier@demo.kvaterka.by','Кацярына Праверка',$2, now(), 2)`,
    [verifierId, password],
  );
  await db.query(`INSERT INTO user_role (user_id, role) VALUES ($1,'VERIFIER')`, [verifierId]);

  /* One pending request, so the queue is not empty on a fresh database and the
     console can be looked at without first pretending to be a landlord. */
  const pendingVerificationId = uuidv7();
  await db.query(
    `INSERT INTO verification_request (id, user_id, kind, target_level, status, declared, submitted_at)
     VALUES ($1,$2,'IDENTITY',1,'SUBMITTED','{}'::jsonb, now() - interval '20 hours')`,
    [pendingVerificationId, landlords[0]],
  );
  await db.query(
    `INSERT INTO verification_event (request_id, actor_user_id, actor_role, event_type, visibility)
     VALUES ($1,$2,'APPLICANT','SUBMITTED','APPLICANT')`,
    [pendingVerificationId, landlords[0]],
  );

  for (const [index, listing] of LISTINGS.entries()) {
    const id = uuidv7();
    const owner = landlords[index % landlords.length]!;
    const publicPoint = publicLocationFor(id, { latitude: listing.lat, longitude: listing.lng });

    await db.query(
      `INSERT INTO property (
         id, owner_id, status, title, description, property_type, region, city, district,
         street, house_number, latitude, longitude, location_precision,
         public_latitude, public_longitude, rooms, area_sqm, floor, total_floors, beds, bathrooms,
         max_guests, smoking_policy, pets_policy, children_allowed, parties_allowed,
         min_nights, max_nights, base_price_minor, price_unit, cleaning_fee_minor,
         utilities_mode, utilities_fixed_minor, deposit_minor, booking_mode, negotiation_enabled,
         published_at, property_verified_at)
       VALUES ($1,$2,'PUBLISHED',$3,$4,$5,$6,$7,$8,
         $9,$10,$11,$12,'APPROXIMATE',$13,$14,$15,$16,$17,$18,$19,1,
         $20,$21,$22,true,false,
         $23,$24,$25,$26,$27,$28,$29,$30,$31,$32,
         now() - ($33 || ' days')::interval, $34)`,
      [
        id, owner, listing.title, listing.description, listing.type,
        'Минская область', listing.city, listing.district,
        'ул. Демонстрационная', String(10 + index),
        listing.lat, listing.lng, publicPoint.latitude, publicPoint.longitude,
        listing.rooms, listing.area, listing.floor, listing.totalFloors, listing.beds,
        listing.guests, listing.smoking, listing.pets,
        listing.minNights, listing.maxNights, String(listing.priceMinor), listing.unit,
        String(listing.cleaning), listing.utilities, String(listing.utilitiesFixed),
        String(listing.deposit), listing.mode, index % 2 === 0,
        String(index * 3), index === 0 ? new Date().toISOString() : null,
      ],
    );

    for (const [order, code] of listing.amenities.entries()) {
      await db.query(
        `INSERT INTO property_amenity (property_id, amenity_code) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [id, code],
      );
      void order;
    }

    for (let photo = 0; photo < 3; photo += 1) {
      await db.query(
        `INSERT INTO property_photo (id, property_id, storage_key, width, height, sort_order, is_cover)
         VALUES ($1,$2,$3,1600,1200,$4,$5)`,
        [uuidv7(), id, `demo/${id}/${photo + 1}.jpg`, photo, photo === 0],
      );
    }

    // A tiered discount on the two longer-stay listings, so the pricing engine
    // has something real to exercise in the demo.
    if (listing.unit === 'NIGHT' && listing.maxNights >= 60) {
      await db.query(
        `INSERT INTO pricing_rule (id, property_id, kind, min_nights, max_nights, price_minor, price_unit, priority)
         VALUES ($1,$2,'LENGTH_OF_STAY',7,30,$3,'NIGHT',10)`,
        [uuidv7(), id, String(Math.round(listing.priceMinor * 0.85))],
      );
    }
  }

  return { listings: LISTINGS.length };
}
