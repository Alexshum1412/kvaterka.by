/**
 * Data lifecycle: what may be kept, what must go, and what stops it going.
 *
 * Pure — no I/O, no clock beyond what the caller passes in.
 *
 * FIVE THINGS THIS MODULE ASSERTS, AND ONE IT REFUSES TO.
 *
 * 1. RETENTION STATE IS DERIVED, NEVER STORED.
 *    Two of its four inputs change with nobody writing anything: a `purge_after`
 *    date passes, and a legal hold lands on another table entirely. A stored
 *    `ELIGIBLE_FOR_PURGE` column would be a cached permission to destroy data —
 *    written before the hold arrived, still true afterwards, and acted on by a
 *    job that is correct according to its own stale state. Derived state asks
 *    at decision time, every time. This is DEC-041's reasoning about dispute
 *    priority applied where the stakes are higher: the cost of a stale priority
 *    is a badly sorted queue, and the cost of a stale eligibility is a destroyed
 *    passport scan that somebody had ordered kept.
 *
 * 2. PURGING IS AN UPDATE, NOT A DELETE.
 *    Nine tables are append-only, and five of them sit behind an `ON DELETE
 *    CASCADE` from a parent. Deleting such a parent does not quietly erase the
 *    history — the row trigger fires during the cascade and aborts the whole
 *    statement with `restrict_violation`. So a delete-based purge would fail on
 *    exactly the records that matter most (a document somebody opened, a request
 *    somebody decided). It would also be the wrong thing even if it worked:
 *    `verification_document` already carries `purged_at`, and a row that records
 *    its own purge cannot be a row that was removed. We destroy the bytes and
 *    keep the tombstone.
 *
 * 3. NO RETENTION PERIOD IS DEFINED IN THIS FILE, OR ANYWHERE IN THE CODEBASE.
 *    Not one. Every window below is either derived from a technical fact the
 *    schema already stores (a session that has expired is expired), or it is
 *    UNKNOWN and names the LEGAL-xxx that would settle it. `purge_after IS NULL`
 *    therefore means «срок не установлен» and yields NOT eligible — the absence
 *    of a policy can never be read as permission to destroy.
 *
 * 4. A HOLD ONLY EVER PREVENTS DESTRUCTION.
 *    Which is why it can ship before any legal question is answered: no answer
 *    can make keeping data more wrong than destroying it by mistake.
 *
 * 5. THE CATALOGUE MUST COVER EVERY TABLE.
 *    `RETENTION_CATALOGUE` names all of them, and a test compares it against
 *    `information_schema`. Adding a table in a future migration without saying
 *    what happens to its data fails that test. This is the only mechanism here
 *    that will still be doing useful work in two years.
 *
 * WHAT IT REFUSES TO ASSERT: any Belarusian legal requirement. This file
 * contains no legal conclusion, and the reason codes below describe why *we* are
 * holding something, never a statutory basis.
 */

/* ================================================================== *
 * Classification
 * ================================================================== */

export const DATA_CLASSES = [
  /** Identifies a person directly, or is free text they wrote. */
  'PERSONAL',
  /** About a person but not readable as them — hashes, counters, keys. */
  'PSEUDONYMOUS',
  /** How the product ran. Little value once the thing it describes is gone. */
  'OPERATIONAL',
  /** Money owed, charged, waived. Correctness outlives everybody's convenience. */
  'FINANCIAL',
  /** Who did what. Its worth is precisely that it cannot be edited afterwards. */
  'AUDIT',
  /** Shared vocabulary — amenities, flags. Belongs to no user. */
  'REFERENCE',
] as const;

export type DataClass = (typeof DATA_CLASSES)[number];

export const DATA_CLASS_LABEL: Record<DataClass, string> = {
  PERSONAL: 'Персональные данные',
  PSEUDONYMOUS: 'Псевдонимизированные',
  OPERATIONAL: 'Операционные',
  FINANCIAL: 'Финансовые',
  AUDIT: 'Аудит',
  REFERENCE: 'Справочные',
};

/** What happens to a table's rows when the person they concern is erased. */
export const DISPOSITIONS = [
  /** Kept, unchanged. The row does not describe a person. */
  'KEEP',
  /** Kept because removing it would break money or accountability. */
  'KEEP_AS_AUDIT',
  /** Kept, but the personal fields are overwritten in place. */
  'ANONYMISE',
  /** The bytes behind it are destroyed; the row survives as a tombstone. */
  'PURGE_CONTENT',
  /** Marked deleted, still present. */
  'SOFT_DELETE',
  /** Genuinely removed. Only for rows with no audit or financial value. */
  'HARD_DELETE',
  /** Goes when its parent goes, by cascade. Never on its own. */
  'CASCADE_WITH_PARENT',
] as const;

export type Disposition = (typeof DISPOSITIONS)[number];

export const DISPOSITION_LABEL: Record<Disposition, string> = {
  KEEP: 'Сохраняется',
  KEEP_AS_AUDIT: 'Сохраняется как аудит',
  ANONYMISE: 'Обезличивается',
  PURGE_CONTENT: 'Содержимое уничтожается, запись остаётся',
  SOFT_DELETE: 'Помечается удалённой',
  HARD_DELETE: 'Удаляется физически',
  CASCADE_WITH_PARENT: 'Удаляется вместе с родителем',
};

/**
 * How long something is kept.
 *
 * `TECHNICAL` is the only kind that carries a number, and only where the schema
 * already decided it: a session past `expires_at` is expired by its own
 * definition, not by anyone's policy judgement. Everything a lawyer would have
 * an opinion about is UNKNOWN and says whose opinion is missing.
 */
export type RetentionWindow =
  | { readonly kind: 'TECHNICAL'; readonly why: string }
  | { readonly kind: 'PER_ROW'; readonly column: string; readonly why: string }
  | { readonly kind: 'UNKNOWN'; readonly blockedBy: string; readonly why: string }
  | { readonly kind: 'INDEFINITE'; readonly why: string };

export interface TablePolicy {
  readonly table: string;
  readonly dataClass: DataClass;
  /** The column naming the person this row is about, if there is one. */
  readonly subject: string | null;
  readonly purpose: string;
  readonly onErasure: Disposition;
  readonly window: RetentionWindow;
  /** True where a `forbid_mutation()`-style trigger refuses UPDATE and DELETE. */
  readonly appendOnly?: boolean;
  /** Implemented by the purge job today, as opposed to merely described. */
  readonly enforced?: boolean;
  readonly note?: string;
}

const LEGAL_003 = 'LEGAL-003';
const LEGAL_004 = 'LEGAL-004';
const LEGAL_009 = 'LEGAL-009';
const LEGAL_010 = 'LEGAL-010';
const LEGAL_011 = 'LEGAL-011';
const LEGAL_017 = 'LEGAL-017';

/**
 * Every table, and what happens to it.
 *
 * Read this as the product's data-protection posture in one place. A row that
 * says UNKNOWN is not an oversight — it is the honest state of a question
 * nobody has answered, and the job will not act on it.
 */
export const RETENTION_CATALOGUE: readonly TablePolicy[] = [
  /* -- identity ---------------------------------------------------- */
  {
    table: 'app_user',
    dataClass: 'PERSONAL',
    subject: 'id',
    purpose: 'Учётная запись: как человека узнают и как с ним связаться',
    onErasure: 'ANONYMISE',
    window: { kind: 'UNKNOWN', blockedBy: LEGAL_003, why: 'Срок хранения после закрытия счёта не определён' },
    note: 'Пятнадцать внешних ключей RESTRICT: строку нельзя удалить физически, и это правильно — на ней держатся бронирования, отзывы и долги.',
  },
  {
    table: 'user_role',
    dataClass: 'OPERATIONAL',
    subject: 'user_id',
    purpose: 'Служебные права',
    onErasure: 'HARD_DELETE',
    window: { kind: 'TECHNICAL', why: 'Права не переживают учётную запись' },
  },
  {
    table: 'user_session',
    dataClass: 'PSEUDONYMOUS',
    subject: 'user_id',
    purpose: 'Активные входы',
    onErasure: 'HARD_DELETE',
    window: { kind: 'TECHNICAL', why: 'Истёкшая сессия истекла по собственному определению' },
    enforced: true,
  },
  {
    table: 'auth_token',
    dataClass: 'PSEUDONYMOUS',
    subject: 'user_id',
    purpose: 'Одноразовые ссылки: подтверждение почты, сброс пароля',
    onErasure: 'HARD_DELETE',
    window: { kind: 'TECHNICAL', why: 'Использованный или истёкший токен бесполезен' },
    enforced: true,
  },
  {
    table: 'audit_log',
    dataClass: 'AUDIT',
    subject: 'actor_user_id',
    purpose: 'Кто что сделал',
    onErasure: 'KEEP_AS_AUDIT',
    window: { kind: 'UNKNOWN', blockedBy: LEGAL_011, why: 'Срок хранения журналов не определён' },
    appendOnly: true,
    note: 'actor_user_id — SET NULL, поэтому обезличивание автора не ломает строку.',
  },

  /* -- listings ---------------------------------------------------- */
  {
    table: 'property',
    dataClass: 'PERSONAL',
    subject: 'owner_id',
    purpose: 'Объявление: адрес, описание, координаты',
    onErasure: 'SOFT_DELETE',
    window: { kind: 'UNKNOWN', blockedBy: LEGAL_003, why: 'Срок хранения снятого объявления не определён' },
  },
  {
    table: 'property_photo',
    dataClass: 'PERSONAL',
    subject: null,
    purpose: 'Фотографии жилья',
    onErasure: 'CASCADE_WITH_PARENT',
    window: { kind: 'UNKNOWN', blockedBy: LEGAL_003, why: 'Зависит от срока хранения объявления' },
    note: 'removePhoto удаляет строку, но не байты: объекты остаются в хранилище навсегда.',
  },
  { table: 'amenity', dataClass: 'REFERENCE', subject: null, purpose: 'Справочник удобств', onErasure: 'KEEP', window: { kind: 'INDEFINITE', why: 'Общий словарь, ничей' } },
  { table: 'property_amenity', dataClass: 'REFERENCE', subject: null, purpose: 'Удобства объявления', onErasure: 'CASCADE_WITH_PARENT', window: { kind: 'TECHNICAL', why: 'Живёт ровно столько, сколько объявление' } },
  { table: 'pricing_rule', dataClass: 'OPERATIONAL', subject: null, purpose: 'Правила цены', onErasure: 'CASCADE_WITH_PARENT', window: { kind: 'TECHNICAL', why: 'Живёт ровно столько, сколько объявление' } },
  { table: 'calendar_block', dataClass: 'OPERATIONAL', subject: null, purpose: 'Занятость календаря', onErasure: 'CASCADE_WITH_PARENT', window: { kind: 'TECHNICAL', why: 'Живёт ровно столько, сколько объявление' } },

  /* -- bookings ---------------------------------------------------- */
  {
    table: 'listing_snapshot',
    dataClass: 'PERSONAL',
    subject: null,
    purpose: 'Условия объявления, замороженные на момент брони — доказательство в споре',
    onErasure: 'KEEP_AS_AUDIT',
    window: { kind: 'UNKNOWN', blockedBy: LEGAL_011, why: 'Срок хранения доказательств не определён' },
    appendOnly: true,
    note: 'Единый JSON-блоб: обезличить нечего — отдельных колонок с персональными данными в нём нет. Самое дорогое место, если право на удаление окажется применимым.',
  },
  {
    table: 'booking',
    dataClass: 'FINANCIAL',
    subject: 'tenant_id',
    purpose: 'Сделка: сроки, суммы, статус',
    onErasure: 'KEEP',
    window: { kind: 'UNKNOWN', blockedBy: 'LEGAL-002', why: 'Срок хранения финансовых записей не определён' },
  },
  { table: 'booking_offer', dataClass: 'FINANCIAL', subject: 'proposed_by_user_id', purpose: 'Встречные предложения по цене', onErasure: 'KEEP', window: { kind: 'UNKNOWN', blockedBy: 'LEGAL-002', why: 'Часть финансовой истории сделки' } },
  { table: 'booking_event', dataClass: 'AUDIT', subject: 'actor_user_id', purpose: 'История переходов брони', onErasure: 'KEEP_AS_AUDIT', window: { kind: 'UNKNOWN', blockedBy: LEGAL_011, why: 'Срок хранения журналов не определён' }, appendOnly: true },
  { table: 'stay_event', dataClass: 'PERSONAL', subject: 'reported_by_user_id', purpose: 'Заезд, выезд, состояние жилья', onErasure: 'KEEP_AS_AUDIT', window: { kind: 'UNKNOWN', blockedBy: LEGAL_011, why: 'Доказательство в споре' } },
  {
    table: 'stay_photo',
    dataClass: 'PERSONAL',
    subject: null,
    purpose: 'Фотографии при заезде и выезде',
    onErasure: 'PURGE_CONTENT',
    window: { kind: 'UNKNOWN', blockedBy: LEGAL_011, why: 'Срок хранения фотодоказательств не определён' },
    note: 'Ни один LEGAL-пункт этого прямо не покрывает — вынесено в LEGAL-018.',
  },

  /* -- messaging --------------------------------------------------- */
  { table: 'conversation', dataClass: 'OPERATIONAL', subject: 'tenant_id', purpose: 'Переписка по объявлению', onErasure: 'KEEP', window: { kind: 'UNKNOWN', blockedBy: LEGAL_010, why: 'Зависит от срока хранения сообщений' } },
  {
    table: 'message',
    dataClass: 'PERSONAL',
    subject: 'sender_id',
    purpose: 'Сообщения между сторонами; body_original хранит текст до фильтрации',
    onErasure: 'ANONYMISE',
    window: { kind: 'UNKNOWN', blockedBy: LEGAL_010, why: 'Срок хранения переписки и оригиналов не определён' },
    note: 'body_original — цена антифрод-фильтра, названная в PRIVACY.md. Ей нужен свой срок.',
  },
  { table: 'message_moderation_event', dataClass: 'AUDIT', subject: null, purpose: 'Какие детекторы сработали и где', onErasure: 'KEEP_AS_AUDIT', window: { kind: 'UNKNOWN', blockedBy: LEGAL_010, why: 'Срок хранения не определён' }, appendOnly: true },

  /* -- trust and money --------------------------------------------- */
  {
    table: 'review',
    dataClass: 'PERSONAL',
    subject: 'author_id',
    purpose: 'Отзывы о завершённых сделках',
    onErasure: 'KEEP',
    window: { kind: 'UNKNOWN', blockedBy: LEGAL_009, why: 'Обязанность удалять или исправлять отзывы не выяснена' },
    note: 'Автор обезличивается через app_user; сам отзыв остаётся, иначе рейтинг второй стороны перепишется задним числом.',
  },
  { table: 'service_fee', dataClass: 'FINANCIAL', subject: 'landlord_id', purpose: 'Начисленная комиссия 5%', onErasure: 'KEEP', window: { kind: 'UNKNOWN', blockedBy: 'LEGAL-002', why: 'Срок хранения финансовых записей не определён' } },
  { table: 'ledger_entry', dataClass: 'FINANCIAL', subject: 'landlord_id', purpose: 'Книга начислений и списаний', onErasure: 'KEEP_AS_AUDIT', window: { kind: 'UNKNOWN', blockedBy: 'LEGAL-002', why: 'Финансовая история; удалению не подлежит' }, appendOnly: true },

  /* -- verification ------------------------------------------------ */
  {
    table: 'verification_request',
    dataClass: 'PERSONAL',
    subject: 'user_id',
    purpose: 'Заявка на подтверждение личности или права сдавать',
    onErasure: 'KEEP_AS_AUDIT',
    window: { kind: 'UNKNOWN', blockedBy: LEGAL_004, why: 'Срок хранения заявок не определён' },
    note: 'Уничтожаются документы, а не заявки: заявка — это запись о решении.',
  },
  {
    table: 'verification_document',
    dataClass: 'PERSONAL',
    subject: null,
    purpose: 'Паспорт, селфи, документ на жильё — самое чувствительное в продукте',
    onErasure: 'PURGE_CONTENT',
    window: { kind: 'PER_ROW', column: 'purge_after', why: 'Срок хранится в самой строке; NULL значит «не установлен» и запрещает уничтожение' },
    enforced: true,
    note: 'Строка остаётся навсегда: на неё ссылается журнал доступа, и она — единственное доказательство того, какой объект был уничтожен.',
  },
  {
    table: 'document_access_log',
    dataClass: 'AUDIT',
    subject: 'actor_user_id',
    purpose: 'Кто открывал чужой паспорт',
    onErasure: 'KEEP_AS_AUDIT',
    window: { kind: 'INDEFINITE', why: 'Смысл таблицы в том, что её нельзя переписать' },
    appendOnly: true,
    note: 'Переживает уничтожение самого документа. Иначе один запрос стирал бы и паспорт, и след того, кто его смотрел.',
  },
  { table: 'verification_event', dataClass: 'PERSONAL', subject: 'actor_user_id', purpose: 'История заявки', onErasure: 'KEEP_AS_AUDIT', window: { kind: 'UNKNOWN', blockedBy: LEGAL_004, why: 'Срок хранения не определён' }, appendOnly: true },

  /* -- cases ------------------------------------------------------- */
  {
    table: 'dispute_case',
    dataClass: 'PERSONAL',
    subject: 'opened_by',
    purpose: 'Обращение одной стороны по поводу другой',
    onErasure: 'KEEP_AS_AUDIT',
    window: { kind: 'UNKNOWN', blockedBy: LEGAL_017, why: 'Что можно хранить и сколько — не выяснено' },
    note: 'Содержит утверждения одного человека о другом. Ни строки не уничтожается, пока LEGAL-017 открыт.',
  },
  { table: 'case_event', dataClass: 'PERSONAL', subject: 'actor_user_id', purpose: 'Ход рассмотрения, включая внутренние заметки', onErasure: 'KEEP_AS_AUDIT', window: { kind: 'UNKNOWN', blockedBy: LEGAL_017, why: 'Срок хранения не определён' }, appendOnly: true },
  {
    table: 'fraud_signal',
    dataClass: 'PSEUDONYMOUS',
    subject: 'user_id',
    purpose: 'Сигналы антифрода',
    onErasure: 'KEEP_AS_AUDIT',
    window: { kind: 'UNKNOWN', blockedBy: LEGAL_003, why: 'Срок хранения сигналов не определён' },
    note: 'До 0013 ключи были CASCADE без защиты: удаление учётной записи стирало обвинение вместе с обвиняемым.',
  },
  { table: 'report', dataClass: 'PERSONAL', subject: 'reporter_id', purpose: 'Жалобы на объявления и пользователей', onErasure: 'KEEP_AS_AUDIT', window: { kind: 'UNKNOWN', blockedBy: LEGAL_017, why: 'Срок хранения не определён' } },

  /* -- notifications and preferences -------------------------------- */
  {
    table: 'notification',
    dataClass: 'PSEUDONYMOUS',
    subject: 'user_id',
    purpose: 'Очередь уведомлений',
    onErasure: 'HARD_DELETE',
    window: { kind: 'UNKNOWN', blockedBy: LEGAL_003, why: 'payload может содержать персональные данные; срок не определён' },
  },
  { table: 'notification_preference', dataClass: 'OPERATIONAL', subject: 'user_id', purpose: 'Настройки каналов', onErasure: 'HARD_DELETE', window: { kind: 'TECHNICAL', why: 'Настройка не переживает учётную запись' } },
  { table: 'telegram_connection', dataClass: 'PERSONAL', subject: 'user_id', purpose: 'Привязка Telegram', onErasure: 'HARD_DELETE', window: { kind: 'UNKNOWN', blockedBy: 'LEGAL-015', why: 'Отвязка оставляет строку; срок её хранения не определён' } },

  /* -- convenience -------------------------------------------------- */
  { table: 'favorite', dataClass: 'OPERATIONAL', subject: 'user_id', purpose: 'Избранное', onErasure: 'HARD_DELETE', window: { kind: 'TECHNICAL', why: 'Не переживает учётную запись' } },
  { table: 'saved_search', dataClass: 'OPERATIONAL', subject: 'user_id', purpose: 'Сохранённые поиски', onErasure: 'HARD_DELETE', window: { kind: 'TECHNICAL', why: 'Не переживает учётную запись' } },

  /* -- platform ----------------------------------------------------- */
  { table: 'feature_flag', dataClass: 'REFERENCE', subject: null, purpose: 'Переключатели, часть из них — юридические', onErasure: 'KEEP', window: { kind: 'INDEFINITE', why: 'Ничей' } },
  { table: 'listing_moderation_review', dataClass: 'PERSONAL', subject: 'moderator_id', purpose: 'Решения модерации по объявлению', onErasure: 'CASCADE_WITH_PARENT', window: { kind: 'UNKNOWN', blockedBy: LEGAL_011, why: 'Срок хранения не определён' }, appendOnly: true, note: 'DEC-031: удаляется только вместе с объявлением, никогда отдельно.' },
  {
    table: 'legal_hold',
    dataClass: 'AUDIT',
    subject: 'placed_by',
    purpose: 'Причина, по которой данные нельзя уничтожать, и кто её назвал',
    onErasure: 'KEEP_AS_AUDIT',
    window: { kind: 'INDEFINITE', why: 'Запись об удержании переживает само удержание — иначе не видно, почему данные хранились' },
    note: 'Внешних ключей на объект удержания нет: удержание не должно исчезать вместе с тем, что оно защищает.',
  },
  {
    table: 'job_run',
    dataClass: 'OPERATIONAL',
    subject: null,
    purpose: 'Когда и что делало фоновое задание',
    onErasure: 'KEEP',
    window: { kind: 'UNKNOWN', blockedBy: LEGAL_011, why: 'Срок хранения журналов выполнения не определён' },
    note: 'Содержит только счётчики и идентификаторы — ни ключей хранилища, ни персональных данных.',
  },
  { table: 'idempotency_record', dataClass: 'OPERATIONAL', subject: 'user_id', purpose: 'Защита от повторов; хранит копию ответа', onErasure: 'HARD_DELETE', window: { kind: 'TECHNICAL', why: 'Есть expires_at' }, enforced: true },
  { table: 'rate_limit_counter', dataClass: 'OPERATIONAL', subject: null, purpose: 'Счётчики ограничений', onErasure: 'HARD_DELETE', window: { kind: 'TECHNICAL', why: 'Окно закрылось' }, enforced: true },
];

const BY_TABLE = new Map(RETENTION_CATALOGUE.map((p) => [p.table, p]));

export const policyFor = (table: string): TablePolicy | undefined => BY_TABLE.get(table);

/** Tables the purge job actually acts on today, as opposed to merely describes. */
export const ENFORCED_TABLES: readonly string[] = RETENTION_CATALOGUE.filter((p) => p.enforced).map((p) => p.table);

/** Every distinct legal question standing between the catalogue and a policy. */
export const OPEN_LEGAL_DEPENDENCIES: readonly string[] = [
  ...new Set(RETENTION_CATALOGUE.flatMap((p) => (p.window.kind === 'UNKNOWN' ? [p.window.blockedBy] : []))),
].sort();

/* ================================================================== *
 * Legal hold
 * ================================================================== */

/** What a hold can be placed on. Mirrors the `legal_hold.target_type` CHECK. */
export const HOLD_TARGET_TYPES = [
  'user',
  'property',
  'booking',
  'dispute_case',
  'verification_request',
  'verification_document',
  'conversation',
] as const;

export type HoldTargetType = (typeof HOLD_TARGET_TYPES)[number];

export const HOLD_TARGET_LABEL: Record<HoldTargetType, string> = {
  user: 'Пользователь',
  property: 'Объявление',
  booking: 'Бронирование',
  dispute_case: 'Обращение',
  verification_request: 'Заявка на проверку',
  verification_document: 'Документ',
  conversation: 'Переписка',
};

/**
 * Why we are holding. Mirrors the `legal_hold.reason_code` CHECK.
 *
 * These describe the platform's own operational reason. None of them asserts a
 * Belarusian legal requirement, and none should be added that does:
 * `LEGAL_QUESTION_UNRESOLVED` is how you say "an open question forbids us from
 * acting", with the number itself written into the free-text reason.
 */
export const HOLD_REASON_CODES = [
  'DISPUTE_OPEN',
  'FRAUD_INVESTIGATION',
  'MODERATION_INVESTIGATION',
  'FINANCIAL_RECONCILIATION',
  'SECURITY_INVESTIGATION',
  'OFFICIAL_REQUEST',
  'LEGAL_QUESTION_UNRESOLVED',
  'USER_REQUEST',
  'OTHER',
] as const;

export type HoldReasonCode = (typeof HOLD_REASON_CODES)[number];

export const HOLD_REASON_LABEL: Record<HoldReasonCode, string> = {
  DISPUTE_OPEN: 'Открыто обращение',
  FRAUD_INVESTIGATION: 'Проверка на мошенничество',
  MODERATION_INVESTIGATION: 'Проверка модерации',
  FINANCIAL_RECONCILIATION: 'Финансовая сверка не закончена',
  SECURITY_INVESTIGATION: 'Расследование инцидента безопасности',
  OFFICIAL_REQUEST: 'Официальный запрос',
  LEGAL_QUESTION_UNRESOLVED: 'Не решён юридический вопрос',
  USER_REQUEST: 'Просьба пользователя',
  OTHER: 'Другое',
};

/**
 * How long a hold may sit before somebody has to look at it again.
 *
 * Not an expiry. A hold that released itself would not be a hold — the whole
 * point is that it survives the job that wants to delete. But an indefinite
 * hold nobody revisits is how "we hold what we must" quietly becomes "we keep
 * everything for ever", which is the failure mode the brief warned about. So a
 * hold has a review date, passing it changes nothing about the hold, and the
 * console shows it as overdue until a person deals with it.
 *
 * Ninety days is an operational cadence for staff review, not a retention
 * period for anybody's data — it decides how often we look, never how long we
 * keep. That is why it can be a number here when no retention window can be.
 */
export const HOLD_REVIEW_DAYS = 90;

export interface HoldRef {
  readonly id: string;
  readonly targetType: HoldTargetType;
  readonly reasonCode: HoldReasonCode;
  readonly placedAt: Date;
}

export const holdReviewOverdue = (hold: { placedAt: Date }, now: Date): boolean =>
  now.getTime() - hold.placedAt.getTime() >= HOLD_REVIEW_DAYS * 86_400_000;

/* ================================================================== *
 * Retention state
 * ================================================================== */

export const RETENTION_STATES = [
  /** In use. Nothing has asked for it to go. */
  'ACTIVE',
  /** Marked deleted; still present, still within whatever window applies. */
  'SOFT_DELETED',
  /** Its time has not come, or no window was ever set. */
  'RETAINED',
  /** Due, and nothing is stopping it. */
  'ELIGIBLE_FOR_PURGE',
  /** Due, but a hold says no. */
  'HELD',
  /** Content destroyed. Terminal. */
  'PURGED',
] as const;

export type RetentionState = (typeof RETENTION_STATES)[number];

export const RETENTION_STATE_LABEL: Record<RetentionState, string> = {
  ACTIVE: 'Активна',
  SOFT_DELETED: 'Помечена удалённой',
  RETAINED: 'Хранится',
  ELIGIBLE_FOR_PURGE: 'Можно уничтожить',
  HELD: 'Удержание',
  PURGED: 'Уничтожена',
};

export const isTerminalRetention = (s: RetentionState): boolean => s === 'PURGED';

/** The four facts the state is computed from. Nothing else is consulted. */
export interface RetentionRow {
  readonly deletedAt: Date | null;
  readonly purgeAfter: Date | null;
  readonly purgedAt: Date | null;
  readonly held: boolean;
}

/**
 * Precedence matters, and it is worth reading in order.
 *
 * PURGED first, because a destroyed thing cannot be anything else. HELD before
 * eligibility, because that is the entire purpose of a hold — if these two
 * swapped, a held row would report itself purgeable and the console would offer
 * a button that must not exist.
 *
 * Then the window, before `deletedAt`. A row that is both soft-deleted and on a
 * retention clock is better described by the clock: an operator wants to know
 * when it goes, not merely that somebody marked it. That leaves SOFT_DELETED
 * meaning something precise and worth seeing — marked for deletion and governed
 * by no window at all, which is a row stuck in limbo rather than a row in
 * progress. The distinction only exists because the states were separated this
 * way round; the other ordering collapses both into one uninformative label.
 *
 * And a missing `purgeAfter` can never reach ELIGIBLE, which is the fail-closed
 * rule the whole module rests on: the absence of a policy is not permission.
 */
export function retentionStateOf(row: RetentionRow, now: Date): RetentionState {
  if (row.purgedAt) return 'PURGED';
  if (row.held) return 'HELD';
  if (row.purgeAfter) return row.purgeAfter <= now ? 'ELIGIBLE_FOR_PURGE' : 'RETAINED';
  if (row.deletedAt) return 'SOFT_DELETED';
  return 'ACTIVE';
}

/**
 * The same rule in SQL, for ordering and paginating the console queue.
 *
 * Expects `d.deleted_at`, `d.purge_after`, `d.purged_at` and a boolean `held`
 * in scope. Written twice on purpose (DEC-041), which is only defensible
 * because `retention.integration.test.ts` runs every combination through both
 * and asserts they agree. If you change one branch here, change the other and
 * watch that test fail first.
 */
export const RETENTION_STATE_SQL = `
  CASE
    WHEN d.purged_at IS NOT NULL THEN 'PURGED'
    WHEN held THEN 'HELD'
    WHEN d.purge_after IS NOT NULL AND d.purge_after <= $now THEN 'ELIGIBLE_FOR_PURGE'
    WHEN d.purge_after IS NOT NULL THEN 'RETAINED'
    WHEN d.deleted_at IS NOT NULL THEN 'SOFT_DELETED'
    ELSE 'ACTIVE'
  END`;

/** Ordering weight: what needs a person's attention first. */
export const RETENTION_RANK_SQL = `
  CASE ${RETENTION_STATE_SQL}
    WHEN 'ELIGIBLE_FOR_PURGE' THEN 0 WHEN 'HELD' THEN 1 WHEN 'SOFT_DELETED' THEN 2
    WHEN 'RETAINED' THEN 3 WHEN 'ACTIVE' THEN 4 ELSE 5
  END`;

/* ================================================================== *
 * Eligibility
 * ================================================================== */

/**
 * Why something was not purged.
 *
 * A bare boolean would be unreadable in a console: «нельзя» with no reason is
 * indistinguishable from a bug. Same shape as `evidenceSufficiency()` in the
 * verification domain, for the same reason.
 */
export const PURGE_BLOCKERS = [
  'ALREADY_PURGED',
  'NO_RETENTION_POLICY',
  'NOT_DUE',
  'LEGAL_HOLD',
  'STORAGE_UNAVAILABLE',
] as const;

export type PurgeBlocker = (typeof PURGE_BLOCKERS)[number];

export const PURGE_BLOCKER_LABEL: Record<PurgeBlocker, string> = {
  ALREADY_PURGED: 'Уже уничтожено',
  NO_RETENTION_POLICY: 'Срок хранения не установлен',
  NOT_DUE: 'Срок ещё не наступил',
  LEGAL_HOLD: 'Действует удержание',
  STORAGE_UNAVAILABLE: 'Хранилище недоступно',
};

export interface PurgeEligibility {
  readonly eligible: boolean;
  readonly blockers: readonly PurgeBlocker[];
  readonly explanation: string;
}

const BLOCKER_EXPLANATION: Record<PurgeBlocker, string> = {
  ALREADY_PURGED: 'Содержимое уже уничтожено, повторять нечего.',
  NO_RETENTION_POLICY:
    'Срок хранения не установлен. Пока LEGAL-004 не решён, платформа не выбирает срок сама — ' +
    'запись хранится, а не уничтожается по догадке.',
  NOT_DUE: 'Срок хранения ещё не истёк.',
  LEGAL_HOLD: 'Действует удержание: данные нужны для разбирательства и не могут быть уничтожены.',
  STORAGE_UNAVAILABLE:
    'Приватное хранилище не настроено, поэтому платформа не может подтвердить, что файл действительно удалён. ' +
    'Отметка об уничтожении не ставится, пока уничтожение не подтверждено.',
};

/**
 * All blockers, not the first one.
 *
 * A verifier looking at a stuck row needs the whole answer: knowing only that a
 * hold applies, then fixing that, then discovering the window has not passed
 * either, is two trips for information we already had.
 */
export function purgeEligibility(
  row: RetentionRow,
  now: Date,
  opts: { storageConfigured: boolean } = { storageConfigured: false },
): PurgeEligibility {
  const blockers: PurgeBlocker[] = [];
  if (row.purgedAt) blockers.push('ALREADY_PURGED');
  if (row.held) blockers.push('LEGAL_HOLD');
  if (!row.purgeAfter) blockers.push('NO_RETENTION_POLICY');
  else if (row.purgeAfter > now) blockers.push('NOT_DUE');
  if (!opts.storageConfigured) blockers.push('STORAGE_UNAVAILABLE');

  return {
    eligible: blockers.length === 0,
    blockers,
    explanation: blockers.length === 0
      ? 'Срок истёк, удержаний нет, хранилище доступно — можно уничтожать.'
      : blockers.map((b) => BLOCKER_EXPLANATION[b]).join(' '),
  };
}

/* ================================================================== *
 * Account erasure
 * ================================================================== */

/**
 * The order an account is taken apart in, and what each step is allowed to do.
 *
 * Declared here rather than living as the shape of a function body, so that the
 * steps that are NOT built are as visible as the ones that are. Everything
 * below `REVOKE_ACCESS` requires LEGAL-003, and the service refuses to run any
 * of it. That refusal is the feature: a half-built erasure that removes a name
 * but leaves the chat history is worse than one that has not started, because
 * it looks finished.
 */
export const ERASURE_STEPS = [
  {
    step: 'REVOKE_SESSIONS',
    what: 'Все активные сессии и одноразовые токены аннулируются',
    built: true,
    blockedBy: null,
  },
  {
    step: 'CLOSE_ACCOUNT',
    what: 'status=DELETED, deleted_at проставлен: вход невозможен, профиль скрыт',
    built: true,
    blockedBy: null,
  },
  {
    step: 'STOP_ACTIVITY',
    what: 'Объявления снимаются с публикации; новые брони невозможны',
    built: true,
    blockedBy: null,
  },
  {
    step: 'PRESERVE_REQUIRED',
    what: 'Финансовые и аудиторские записи сохраняются нетронутыми',
    built: true,
    blockedBy: null,
  },
  {
    step: 'ANONYMISE_PROFILE',
    what: 'Имя, почта, телефон заменяются на обезличенные значения',
    built: false,
    blockedBy: LEGAL_003,
  },
  {
    step: 'REDACT_CONTENT',
    what: 'Сообщения и оригиналы текстов до фильтрации',
    built: false,
    blockedBy: LEGAL_010,
  },
  {
    step: 'PURGE_MEDIA',
    what: 'Фотографии объявлений и заездов',
    built: false,
    blockedBy: LEGAL_003,
  },
  {
    step: 'PURGE_DOCUMENTS',
    what: 'Документы, удостоверяющие личность',
    built: false,
    blockedBy: LEGAL_004,
  },
] as const;

export type ErasureStep = (typeof ERASURE_STEPS)[number]['step'];

/** What the product can honestly promise a person asking to be forgotten. */
export const ERASURE_BUILT_STEPS = ERASURE_STEPS.filter((s) => s.built).map((s) => s.step);
export const ERASURE_BLOCKED_STEPS = ERASURE_STEPS.filter((s) => !s.built);

/**
 * Conditions under which closing an account must be refused outright.
 *
 * Not a legal judgement — a product one. Closing an account mid-stay strands
 * the other party in a booking with a counterparty who no longer exists, and no
 * data-protection answer makes that acceptable.
 */
export const ERASURE_BLOCKERS = ['ACTIVE_BOOKING', 'OPEN_DISPUTE', 'LEGAL_HOLD'] as const;

export type ErasureBlocker = (typeof ERASURE_BLOCKERS)[number];

export const ERASURE_BLOCKER_LABEL: Record<ErasureBlocker, string> = {
  ACTIVE_BOOKING: 'Есть активное бронирование',
  OPEN_DISPUTE: 'Есть открытое обращение',
  LEGAL_HOLD: 'Действует удержание',
};

export const ERASURE_BLOCKER_EXPLANATION: Record<ErasureBlocker, string> = {
  ACTIVE_BOOKING:
    'Пока идёт бронирование, закрыть учётную запись нельзя: вторая сторона осталась бы со сделкой без собеседника.',
  OPEN_DISPUTE:
    'Пока обращение не рассмотрено, закрытие учётной записи остановит разбирательство на полпути.',
  LEGAL_HOLD:
    'На учётную запись наложено удержание. Снять его может только администратор, указав причину.',
};

/**
 * An outstanding debt is deliberately NOT a blocker.
 *
 * It is the obvious candidate and it is the wrong call. Refusing to let
 * somebody close their account until they have paid uses a data-protection
 * mechanism as leverage over money, and it is unnecessary: the debt does not
 * depend on the account being open. Every financial foreign key is RESTRICT
 * precisely so that closing an account cannot take a fee with it, so the ledger
 * is exactly as correct afterwards as before.
 *
 * What the person is owed instead is a plain statement of what survives, shown
 * beside the closure form rather than used as a refusal.
 */
export const CLOSURE_SURVIVES: readonly string[] = [
  'Начисленная комиссия и задолженность: закрытие счёта их не отменяет.',
  'Завершённые бронирования и финансовые записи по ним.',
  'Отзывы, которые вы оставили: они остаются у второй стороны, иначе её рейтинг изменился бы задним числом.',
  'Журналы аудита: кто и что делал на площадке.',
];
