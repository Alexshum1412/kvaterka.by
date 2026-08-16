-- 0006_api_support.sql
-- Infrastructure the HTTP layer needs: idempotency records, rate limiting,
-- and the standardised amenity/tag vocabulary.

/* ==================================================================== *
 * Idempotency
 *
 * A retried POST must not create a second booking, a second review or a
 * second fee. The booking table already has its own idempotency column for
 * the domain-level guarantee; this table generalises it to any endpoint and
 * additionally lets a retry replay the ORIGINAL response instead of doing
 * the work again.
 * ==================================================================== */

CREATE TABLE idempotency_record (
  id            bigserial PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  scope         text NOT NULL,          -- e.g. 'POST /bookings'
  key           text NOT NULL,
  -- Guards against key reuse with a different payload: replaying a stored
  -- response for a request that asked for something else would be a silent
  -- correctness bug, and a way to probe another request's result.
  request_hash  bytea NOT NULL,
  state         text NOT NULL DEFAULT 'IN_PROGRESS'
                  CHECK (state IN ('IN_PROGRESS', 'COMPLETED')),
  status_code   integer,
  response_body jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '24 hours',

  CONSTRAINT idempotency_unique UNIQUE (user_id, scope, key),
  CONSTRAINT idempotency_completed_has_response CHECK (
    state <> 'COMPLETED' OR (status_code IS NOT NULL AND completed_at IS NOT NULL))
);

CREATE INDEX idempotency_expiry_idx ON idempotency_record (expires_at);

/* ==================================================================== *
 * Rate limiting
 *
 * Fixed-window counters in the database rather than in process memory, so the
 * limit holds across instances. Redis would be faster; at MVP volume the
 * correctness of a shared counter matters more than the microseconds
 * (DEC-019).
 * ==================================================================== */

CREATE TABLE rate_limit_counter (
  bucket       text NOT NULL,        -- 'login:<hashed-ip>' / 'message:<user-id>'
  window_start timestamptz NOT NULL,
  hits         integer NOT NULL DEFAULT 0 CHECK (hits >= 0),
  PRIMARY KEY (bucket, window_start)
);

CREATE INDEX rate_limit_window_idx ON rate_limit_counter (window_start);

/* ==================================================================== *
 * Amenity / tag vocabulary (spec §22)
 *
 * Structured and normalised, never free text: these are filter criteria, and
 * a filter cannot be built over arbitrary strings. House *policies* (smoking,
 * pets, children) stay as enum columns on property because they are
 * single-valued and mutually exclusive; amenities are many-to-many.
 * ==================================================================== */

INSERT INTO amenity (code, category, name_ru, name_be, name_en, icon, sort_order) VALUES
  -- Essentials
  ('WIFI',              'ESSENTIALS', 'Wi-Fi',                    'Wi-Fi',                      'Wi-Fi',              'wifi',        10),
  ('HEATING',           'ESSENTIALS', 'Отопление',                'Ацяпленне',                  'Heating',            'heater',      20),
  ('AIR_CONDITIONING',  'ESSENTIALS', 'Кондиционер',              'Кандыцыянер',                'Air conditioning',   'snowflake',   30),
  ('HOT_WATER',         'ESSENTIALS', 'Горячая вода',             'Гарачая вада',               'Hot water',          'droplet',     40),
  ('UNDERFLOOR_HEATING','ESSENTIALS', 'Тёплый пол',               'Цёплая падлога',             'Underfloor heating', 'flame',       50),

  -- Kitchen
  ('KITCHEN',           'KITCHEN',    'Кухня',                    'Кухня',                      'Kitchen',            'chef-hat',   110),
  ('FRIDGE',            'KITCHEN',    'Холодильник',              'Халадзільнік',               'Refrigerator',       'box',        120),
  ('STOVE',             'KITCHEN',    'Плита',                    'Пліта',                      'Stove',              'flame',      130),
  ('OVEN',              'KITCHEN',    'Духовка',                  'Духоўка',                    'Oven',               'oven',       140),
  ('MICROWAVE',         'KITCHEN',    'Микроволновка',            'Мікрахвалёўка',              'Microwave',          'box',        150),
  ('DISHWASHER',        'KITCHEN',    'Посудомоечная машина',     'Посудамыйная машына',        'Dishwasher',         'dishes',     160),
  ('KETTLE',            'KITCHEN',    'Чайник',                   'Чайнік',                     'Kettle',             'cup',        170),
  ('COFFEE_MACHINE',    'KITCHEN',    'Кофеварка',                'Кававарка',                  'Coffee machine',     'coffee',     180),

  -- Laundry & bathroom
  ('WASHING_MACHINE',   'BATHROOM',   'Стиральная машина',        'Пральная машына',            'Washing machine',    'washer',     210),
  ('DRYER',             'BATHROOM',   'Сушильная машина',         'Сушыльная машына',           'Dryer',              'wind',       220),
  ('BATHTUB',           'BATHROOM',   'Ванна',                    'Ванна',                      'Bathtub',            'bath',       230),
  ('SHOWER',            'BATHROOM',   'Душ',                      'Душ',                        'Shower',             'shower',     240),
  ('TOILETRIES',        'BATHROOM',   'Средства гигиены',         'Сродкі гігіены',             'Toiletries',         'soap',       250),
  ('TOWELS',            'BATHROOM',   'Полотенца',                'Ручнікі',                    'Towels',             'towel',      260),

  -- Work & entertainment
  ('WORKSPACE',         'WORK',       'Рабочее место',            'Працоўнае месца',            'Workspace',          'desk',       310),
  ('TV',                'WORK',       'Телевизор',                'Тэлевізар',                  'TV',                 'tv',         320),
  ('FAST_WIFI',         'WORK',       'Быстрый интернет',         'Хуткі інтэрнэт',             'Fast internet',      'gauge',      330),

  -- Building & access
  ('ELEVATOR',          'BUILDING',   'Лифт',                     'Ліфт',                       'Elevator',           'elevator',   410),
  ('PARKING_FREE',      'BUILDING',   'Бесплатная парковка',      'Бясплатная паркоўка',        'Free parking',       'car',        420),
  ('PARKING_PAID',      'BUILDING',   'Платная парковка',         'Платная паркоўка',           'Paid parking',       'car',        430),
  ('BALCONY',           'BUILDING',   'Балкон',                   'Балкон',                     'Balcony',            'balcony',    440),
  ('INTERCOM',          'BUILDING',   'Домофон',                  'Дамафон',                    'Intercom',           'phone',      450),
  ('SECURITY',          'BUILDING',   'Охрана / консьерж',        'Ахова / кансьерж',           'Security',           'shield',     460),
  ('SEPARATE_ENTRANCE', 'BUILDING',   'Отдельный вход',           'Асобны ўваход',              'Separate entrance',  'door',       470),

  -- Family
  ('CRIB',              'FAMILY',     'Детская кроватка',         'Дзіцячы ложачак',            'Baby crib',          'baby',       510),
  ('HIGH_CHAIR',        'FAMILY',     'Стульчик для кормления',   'Крэсліца для кармлення',     'High chair',         'baby',       520),
  ('EXTRA_BED',         'FAMILY',     'Дополнительное спальное место','Дадатковае спальнае месца','Extra bed',        'bed',        530),

  -- Accessibility
  ('STEP_FREE_ACCESS',  'ACCESSIBILITY','Вход без ступеней',      'Уваход без прыступак',       'Step-free access',   'accessible', 610),
  ('WIDE_DOORWAYS',     'ACCESSIBILITY','Широкие дверные проёмы', 'Шырокія дзвярныя праёмы',    'Wide doorways',      'accessible', 620),
  ('ACCESSIBLE_BATHROOM','ACCESSIBILITY','Доступная ванная',      'Даступная ванная',           'Accessible bathroom','accessible', 630),

  -- Safety
  ('SMOKE_DETECTOR',    'SAFETY',     'Датчик дыма',              'Датчык дыму',                'Smoke detector',     'alarm',      710),
  ('FIRE_EXTINGUISHER', 'SAFETY',     'Огнетушитель',             'Вогнетушыльнік',             'Fire extinguisher',  'extinguisher',720),
  ('FIRST_AID_KIT',     'SAFETY',     'Аптечка',                  'Аптэчка',                    'First aid kit',      'kit',        730)
ON CONFLICT (code) DO NOTHING;

/* ==================================================================== *
 * Review publication window
 *
 * Reviews publish when both sides have submitted, or when the window closes —
 * whichever comes first. Storing the deadline on the booking makes the job
 * that publishes them a simple indexed scan (spec §28).
 * ==================================================================== */

ALTER TABLE booking ADD COLUMN review_deadline_at timestamptz;

CREATE INDEX booking_review_due_idx ON booking (review_deadline_at)
  WHERE status = 'COMPLETED' AND review_deadline_at IS NOT NULL;

/* Feature flags whose default state is a deliberate legal decision. */
INSERT INTO feature_flag (key, enabled, description, requires_legal_approval) VALUES
  ('rewards.lottery', false,
   'Prize draw for completed rentals. Requires Belarusian lottery/gambling analysis (LEGAL-012).', true),
  ('rewards.points', false,
   'Loyalty points with monetary-equivalent value. Requires legal review (LEGAL-012).', true),
  ('fee.enforcement', true,
   'Whether the 5% service fee accrues as a payable debt. Fee ENFORCEABILITY is unverified (LEGAL-016); '
   'disabling records the fee as informational only.', true),
  ('verification.identity_documents', false,
   'Collection of passport/ID images. Requires data-protection analysis (LEGAL-004).', true),
  ('notifications.telegram', true,
   'Telegram notification channel. Opt-in per user; cross-border transfer question is LEGAL-015.', false),
  ('search.natural_language', false,
   'Natural-language query parsing. Post-MVP.', false)
ON CONFLICT (key) DO NOTHING;
