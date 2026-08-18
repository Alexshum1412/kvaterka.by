/**
 * Verification: levels, the request lifecycle, rejection vocabulary, and the
 * rule that decides whether a level may be granted at all.
 *
 * Pure — no I/O, no clock beyond what the caller passes in.
 *
 * THE RULE THAT MATTERS MOST IS `evidenceSufficiency()`.
 *
 * Before this module the decision endpoint would happily move a request from
 * SUBMITTED to APPROVED and raise `app_user.verification_level`, with no check
 * that anything had been submitted. Combined with the fact that no submission
 * path existed and `verification.identity_documents` is off, that meant the
 * badge «Личность подтверждена» could be granted on the strength of nothing
 * whatsoever — to a tenant deciding whether to trust a stranger with a deposit.
 *
 * A badge is a claim the platform makes to third parties. If there is nothing
 * behind it, it is worse than absent, because absent is honest.
 */

/* ------------------------------------------------------------------ *
 * Levels
 * ------------------------------------------------------------------ */

export const VERIFICATION_LEVELS = [0, 1, 2] as const;
export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];

/**
 * What each level means, in words that describe what the platform actually did.
 *
 * Deliberately NOT «юридически подтверждено». The platform looked at documents
 * a person supplied and formed a view; it did not perform a title search, it
 * does not guarantee ownership, and it cannot promise anybody's safety. The
 * wording says «проверены платформой» because that is the true and complete
 * claim. See LEGAL-004 and LEGAL-017.
 */
export const LEVEL_LABEL: Record<VerificationLevel, string> = {
  0: 'Новичок',
  1: 'Личность подтверждена',
  2: 'Verified',
};

export const LEVEL_CLAIM: Record<VerificationLevel, string> = {
  0: 'Подтверждены телефон и email',
  1: 'Личность подтверждена платформой',
  2: 'Личность и право сдавать жильё проверены платформой',
};

/** The longer form, for a profile or a decision letter. Still not a guarantee. */
export const LEVEL_EXPLANATION: Record<VerificationLevel, string> = {
  0: 'Аккаунт подтвердил телефон и email. Личность платформа не проверяла.',
  1: 'Платформа проверила документы, удостоверяющие личность. Это не юридическая экспертиза и не гарантия — это проверка, которую провела Кватэрка.by.',
  2: 'Платформа проверила документы, удостоверяющие личность, и документы, подтверждающие право сдавать это жильё. Кватэрка.by не проводит проверку прав на недвижимость и не гарантирует их — проверены представленные документы.',
};

export const KINDS = ['IDENTITY', 'PROPERTY_OWNERSHIP'] as const;
export type VerificationKind = (typeof KINDS)[number];

/** Which kind a target level requires. Level 2 needs both, in order. */
export function kindForLevel(level: 1 | 2): VerificationKind {
  return level === 1 ? 'IDENTITY' : 'PROPERTY_OWNERSHIP';
}

/* ------------------------------------------------------------------ *
 * Statuses
 * ------------------------------------------------------------------ */

/**
 * SUBMITTED, IN_REVIEW, APPROVED, REJECTED and EXPIRED already existed in the
 * `verification_request` CHECK. NEEDS_INFO is added (0012) because rejecting a
 * request that is merely incomplete destroys work the applicant already did and
 * teaches them nothing — the moderation flow learned this already (DEC-030).
 */
export const VERIFICATION_STATUSES = [
  'SUBMITTED',
  'IN_REVIEW',
  'NEEDS_INFO',
  'APPROVED',
  'REJECTED',
  'EXPIRED',
] as const;

export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const TERMINAL_STATUSES: readonly VerificationStatus[] = ['APPROVED', 'REJECTED', 'EXPIRED'];
export const isTerminalVerification = (s: VerificationStatus): boolean => TERMINAL_STATUSES.includes(s);

/** Statuses in which the applicant still has the ball. */
export const AWAITING_APPLICANT: readonly VerificationStatus[] = ['NEEDS_INFO'];

export const STATUS_LABEL: Record<VerificationStatus, string> = {
  SUBMITTED: 'Отправлена',
  IN_REVIEW: 'На проверке',
  NEEDS_INFO: 'Нужны уточнения',
  APPROVED: 'Подтверждено',
  REJECTED: 'Отклонено',
  EXPIRED: 'Истекла',
};

/* ------------------------------------------------------------------ *
 * Transitions
 * ------------------------------------------------------------------ */

export const VERIFICATION_ACTIONS = ['TAKE', 'REQUEST_INFO', 'APPROVE', 'REJECT', 'EXPIRE'] as const;
export type VerificationAction = (typeof VERIFICATION_ACTIONS)[number];

/**
 * The permission a move costs.
 *
 * `verification.review` lets somebody work the queue. `verification.decide`
 * lets them end a request. `document.read` is the third and narrowest, and is
 * required only for APPROVE — see `requiresDocumentAccess` below.
 */
export type VerificationPermission = 'verification.review' | 'verification.decide';

export interface VerificationTransition {
  readonly from: VerificationStatus;
  readonly action: VerificationAction;
  readonly to: VerificationStatus;
  readonly permission: VerificationPermission;
  readonly requiresReason: boolean;
  /**
   * True when the actor must ALSO hold `document.read`.
   *
   * Only APPROVE. Granting a badge means asserting that somebody looked at the
   * evidence, and a role that cannot open the evidence cannot honestly assert
   * it. ADMIN holds `verification.decide` and deliberately does NOT hold
   * `document.read` (rbac.ts), so before this rule an administrator could hand
   * out «личность подтверждена» while being structurally forbidden from
   * examining the passport behind it. Rejecting needs no such access: you can
   * refuse an application for being incomplete, inconsistent or stale without
   * opening a document.
   */
  readonly requiresDocumentAccess: boolean;
  readonly note?: string;
}

export const VERIFICATION_TRANSITIONS: readonly VerificationTransition[] = [
  { from: 'SUBMITTED', action: 'TAKE', to: 'IN_REVIEW', permission: 'verification.review', requiresReason: false, requiresDocumentAccess: false },
  { from: 'SUBMITTED', action: 'REQUEST_INFO', to: 'NEEDS_INFO', permission: 'verification.review', requiresReason: true, requiresDocumentAccess: false, note: 'The reason is what the applicant is told to fix.' },
  { from: 'SUBMITTED', action: 'REJECT', to: 'REJECTED', permission: 'verification.decide', requiresReason: true, requiresDocumentAccess: false },
  { from: 'SUBMITTED', action: 'EXPIRE', to: 'EXPIRED', permission: 'verification.review', requiresReason: false, requiresDocumentAccess: false },

  { from: 'IN_REVIEW', action: 'REQUEST_INFO', to: 'NEEDS_INFO', permission: 'verification.review', requiresReason: true, requiresDocumentAccess: false },
  { from: 'IN_REVIEW', action: 'APPROVE', to: 'APPROVED', permission: 'verification.decide', requiresReason: false, requiresDocumentAccess: true },
  { from: 'IN_REVIEW', action: 'REJECT', to: 'REJECTED', permission: 'verification.decide', requiresReason: true, requiresDocumentAccess: false },
  { from: 'IN_REVIEW', action: 'EXPIRE', to: 'EXPIRED', permission: 'verification.review', requiresReason: false, requiresDocumentAccess: false },

  // NEEDS_INFO waits on the applicant. Staff may still reject or expire it, but
  // approving from here would mean approving the version they already said was
  // insufficient: the applicant resubmits, which creates a fresh request.
  { from: 'NEEDS_INFO', action: 'REJECT', to: 'REJECTED', permission: 'verification.decide', requiresReason: true, requiresDocumentAccess: false },
  { from: 'NEEDS_INFO', action: 'EXPIRE', to: 'EXPIRED', permission: 'verification.review', requiresReason: false, requiresDocumentAccess: false },
  { from: 'NEEDS_INFO', action: 'TAKE', to: 'IN_REVIEW', permission: 'verification.review', requiresReason: false, requiresDocumentAccess: false, note: 'The applicant answered in the thread rather than resubmitting.' },
];

export class IllegalVerificationTransitionError extends Error {
  constructor(
    readonly from: VerificationStatus,
    readonly action: VerificationAction,
    readonly reason:
      | 'NO_SUCH_TRANSITION'
      | 'REASON_REQUIRED'
      | 'DOCUMENT_ACCESS_REQUIRED'
      | 'INSUFFICIENT_EVIDENCE',
  ) {
    super(`Illegal verification transition: ${from} --${action}-->: ${reason}`);
    this.name = 'IllegalVerificationTransitionError';
  }
}

export interface ActorCapabilities {
  readonly canReview: boolean;
  readonly canDecide: boolean;
  readonly canReadDocuments: boolean;
}

/**
 * Resolve a transition, or explain precisely why not.
 *
 * `evidence` is only consulted for APPROVE. The order of the checks is
 * deliberate: the shape of the move first, then the reason, then whether this
 * actor may make it, then whether the facts support it.
 */
export function applyVerificationAction(
  from: VerificationStatus,
  action: VerificationAction,
  opts: {
    hasReason: boolean;
    actor: ActorCapabilities;
    evidence?: EvidenceInputs;
  },
): VerificationTransition {
  const match = VERIFICATION_TRANSITIONS.find((t) => t.from === from && t.action === action);
  if (!match) throw new IllegalVerificationTransitionError(from, action, 'NO_SUCH_TRANSITION');

  if (match.requiresReason && !opts.hasReason) {
    throw new IllegalVerificationTransitionError(from, action, 'REASON_REQUIRED');
  }
  if (match.requiresDocumentAccess && !opts.actor.canReadDocuments) {
    throw new IllegalVerificationTransitionError(from, action, 'DOCUMENT_ACCESS_REQUIRED');
  }
  if (action === 'APPROVE') {
    const sufficiency = evidenceSufficiency(opts.evidence ?? EMPTY_EVIDENCE);
    if (!sufficiency.sufficient) {
      throw new IllegalVerificationTransitionError(from, action, 'INSUFFICIENT_EVIDENCE');
    }
  }
  return match;
}

/** Every action available from a status to an actor with these capabilities. */
export function availableVerificationActions(
  from: VerificationStatus,
  actor: ActorCapabilities,
): readonly VerificationTransition[] {
  return VERIFICATION_TRANSITIONS.filter((t) => {
    if (t.permission === 'verification.decide' ? !actor.canDecide : !actor.canReview) return false;
    if (t.requiresDocumentAccess && !actor.canReadDocuments) return false;
    return t.from === from;
  });
}

/* ------------------------------------------------------------------ *
 * Evidence sufficiency
 * ------------------------------------------------------------------ */

export interface EvidenceInputs {
  readonly kind: VerificationKind;
  /** Identity documents currently attached and not purged. */
  readonly identityDocumentCount: number;
  /** A face image to compare against the document. */
  readonly hasSelfie: boolean;
  /** Ownership / authority documents attached and not purged. */
  readonly propertyDocumentCount: number;
  /** Whether the applicant stated a basis for their right to let the property. */
  readonly hasDeclaredBasis: boolean;
  /**
   * Whether the platform is permitted to hold identity documents at all.
   * `verification.identity_documents`, off pending LEGAL-004.
   */
  readonly documentCollectionEnabled: boolean;
}

const EMPTY_EVIDENCE: EvidenceInputs = {
  kind: 'IDENTITY',
  identityDocumentCount: 0,
  hasSelfie: false,
  propertyDocumentCount: 0,
  hasDeclaredBasis: false,
  documentCollectionEnabled: false,
};

export type InsufficiencyReason =
  /** The platform may not hold identity documents yet, so no level can be granted. */
  | 'DOCUMENT_COLLECTION_DISABLED'
  | 'NO_IDENTITY_DOCUMENT'
  | 'NO_SELFIE'
  | 'NO_PROPERTY_DOCUMENT'
  | 'NO_DECLARED_BASIS';

export interface Sufficiency {
  readonly sufficient: boolean;
  readonly missing: readonly InsufficiencyReason[];
  /** Plain-language explanation for the console. */
  readonly explanation: string;
}

/**
 * Is there enough here to grant the level?
 *
 * This is the fail-closed heart of the slice. Two independent gates have to be
 * open before any level can be granted, and today the first one is shut:
 *
 *   1. The platform must be permitted to collect identity documents at all.
 *      `verification.identity_documents` is off pending LEGAL-004, so this
 *      function currently refuses every approval, and the console says why.
 *      That is the correct behaviour: the alternative is issuing trust badges
 *      backed by nothing.
 *
 *   2. The specific evidence for the kind must actually be present.
 *
 * Enabling the flag without configuring private storage changes nothing,
 * because documents cannot be attached without somewhere to put them — the two
 * dependencies fail closed independently.
 */
export function evidenceSufficiency(e: EvidenceInputs): Sufficiency {
  const missing: InsufficiencyReason[] = [];

  if (!e.documentCollectionEnabled) {
    return {
      sufficient: false,
      missing: ['DOCUMENT_COLLECTION_DISABLED'],
      explanation:
        'Сбор документов, удостоверяющих личность, отключён до юридического заключения (LEGAL-004). ' +
        'Пока он отключён, уровень доверия не выдаётся — иначе бы значок стоял ни на чём.',
    };
  }

  if (e.identityDocumentCount === 0) missing.push('NO_IDENTITY_DOCUMENT');
  if (!e.hasSelfie) missing.push('NO_SELFIE');

  if (e.kind === 'PROPERTY_OWNERSHIP') {
    if (e.propertyDocumentCount === 0) missing.push('NO_PROPERTY_DOCUMENT');
    if (!e.hasDeclaredBasis) missing.push('NO_DECLARED_BASIS');
  }

  return {
    sufficient: missing.length === 0,
    missing,
    explanation:
      missing.length === 0
        ? 'Представленных материалов достаточно для решения.'
        : `Не хватает: ${missing.map((m) => INSUFFICIENCY_LABEL[m]).join(', ')}.`,
  };
}

export const INSUFFICIENCY_LABEL: Record<InsufficiencyReason, string> = {
  DOCUMENT_COLLECTION_DISABLED: 'сбор документов отключён юридическим стопом',
  NO_IDENTITY_DOCUMENT: 'документ, удостоверяющий личность',
  NO_SELFIE: 'селфи для сверки с документом',
  NO_PROPERTY_DOCUMENT: 'документ о праве сдавать жильё',
  NO_DECLARED_BASIS: 'указанное основание права сдавать',
};

/* ------------------------------------------------------------------ *
 * Rejection vocabulary
 * ------------------------------------------------------------------ */

export const VERIFICATION_REASON_CODES = [
  'IDENTITY_DOCUMENT_UNREADABLE',
  'IDENTITY_DATA_MISMATCH',
  'SELFIE_MISMATCH',
  'DOCUMENT_EXPIRED',
  'DOCUMENT_MISSING',
  'RIGHT_TO_RENT_NOT_CONFIRMED',
  'PROPERTY_DOCUMENT_INSUFFICIENT',
  'INFORMATION_INCONSISTENT',
  'SUSPICIOUS_ACTIVITY',
  'OTHER',
] as const;

export type VerificationReasonCode = (typeof VERIFICATION_REASON_CODES)[number];

/** Short label for the verifier's own chip list. */
export const REASON_SHORT: Record<VerificationReasonCode, string> = {
  IDENTITY_DOCUMENT_UNREADABLE: 'Документ не читается',
  IDENTITY_DATA_MISMATCH: 'Данные не совпадают',
  SELFIE_MISMATCH: 'Селфи не совпадает',
  DOCUMENT_EXPIRED: 'Документ просрочен',
  DOCUMENT_MISSING: 'Документа нет',
  RIGHT_TO_RENT_NOT_CONFIRMED: 'Право сдавать не подтверждено',
  PROPERTY_DOCUMENT_INSUFFICIENT: 'Документа на жильё недостаточно',
  INFORMATION_INCONSISTENT: 'Противоречия в данных',
  SUSPICIOUS_ACTIVITY: 'Подозрительная активность',
  OTHER: 'Другое',
};

/**
 * What the APPLICANT is told, per code.
 *
 * Separate from the code and from the verifier's internal note, because those
 * three audiences need different things. In particular `SUSPICIOUS_ACTIVITY`
 * says nothing about what was noticed: telling somebody which signal fired is
 * telling them what to avoid next time, and the fraud signals behind it are
 * internal by design (trust-service.ts).
 */
export const REASON_FOR_APPLICANT: Record<VerificationReasonCode, string> = {
  IDENTITY_DOCUMENT_UNREADABLE:
    'На фотографии документа не удалось разобрать данные. Сфотографируйте документ целиком, при хорошем освещении, без блика и обрезанных краёв.',
  IDENTITY_DATA_MISMATCH:
    'Данные в профиле не совпадают с данными в документе. Проверьте имя и фамилию в профиле.',
  SELFIE_MISMATCH:
    'Селфи не удалось сопоставить с фотографией в документе. Сделайте новое селфи при хорошем освещении, лицо целиком, без головного убора и очков.',
  DOCUMENT_EXPIRED: 'Срок действия документа истёк. Приложите действующий документ.',
  DOCUMENT_MISSING: 'Не хватает одного из необходимых документов.',
  RIGHT_TO_RENT_NOT_CONFIRMED:
    'Представленные документы не подтверждают право сдавать это жильё. Подойдёт свидетельство о праве собственности, договор или доверенность с правом сдачи в аренду.',
  PROPERTY_DOCUMENT_INSUFFICIENT:
    'Документа на жильё недостаточно: на нём не видно адреса, сторон или права сдавать. Приложите документ полностью.',
  INFORMATION_INCONSISTENT:
    'В заявке есть противоречия — например, адрес в документе и в объявлении различаются. Проверьте данные и отправьте заявку заново.',
  // Deliberately uninformative about the signal itself.
  SUSPICIOUS_ACTIVITY:
    'Заявку не удалось подтвердить автоматически. Напишите в поддержку — мы разберёмся вручную.',
  OTHER: 'Заявку не удалось подтвердить. Подробности — в комментарии ниже.',
};

/**
 * Where the applicant should be sent to fix it.
 *
 * The same idea as `MODERATION_REASON_STEP` for listings (DEC-030): a rejection
 * that does not say where to go is a dead end, and re-entering an application
 * from the top is how people give up.
 */
export type VerificationFixTarget = 'PROFILE_NAME' | 'IDENTITY_DOCUMENTS' | 'SELFIE' | 'PROPERTY_DOCUMENTS' | 'SUPPORT';

export const REASON_FIX_TARGET: Record<VerificationReasonCode, VerificationFixTarget> = {
  IDENTITY_DOCUMENT_UNREADABLE: 'IDENTITY_DOCUMENTS',
  IDENTITY_DATA_MISMATCH: 'PROFILE_NAME',
  SELFIE_MISMATCH: 'SELFIE',
  DOCUMENT_EXPIRED: 'IDENTITY_DOCUMENTS',
  DOCUMENT_MISSING: 'IDENTITY_DOCUMENTS',
  RIGHT_TO_RENT_NOT_CONFIRMED: 'PROPERTY_DOCUMENTS',
  PROPERTY_DOCUMENT_INSUFFICIENT: 'PROPERTY_DOCUMENTS',
  INFORMATION_INCONSISTENT: 'PROFILE_NAME',
  SUSPICIOUS_ACTIVITY: 'SUPPORT',
  OTHER: 'SUPPORT',
};

/** The first thing to fix, so the resubmit button can point somewhere precise. */
export function firstFixTarget(codes: readonly VerificationReasonCode[]): VerificationFixTarget | null {
  const ORDER: readonly VerificationFixTarget[] = [
    'PROFILE_NAME',
    'IDENTITY_DOCUMENTS',
    'SELFIE',
    'PROPERTY_DOCUMENTS',
    'SUPPORT',
  ];
  const targets = new Set(codes.map((c) => REASON_FIX_TARGET[c]));
  return ORDER.find((t) => targets.has(t)) ?? null;
}

/** The applicant-facing letter: one paragraph per code, in a stable order. */
export function applicantExplanation(codes: readonly VerificationReasonCode[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const code of VERIFICATION_REASON_CODES) {
    if (codes.includes(code) && !seen.has(code)) {
      seen.add(code);
      out.push(REASON_FOR_APPLICANT[code]);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Ownership basis — structured, not a document
 * ------------------------------------------------------------------ */

/**
 * What the applicant declares about their right to let the property.
 *
 * A declaration is not evidence and is never treated as any: `evidenceSufficiency`
 * requires a document as well. It exists so a verifier knows what they are
 * looking for before they open anything, and so the applicant can be told which
 * document is expected.
 */
export const OWNERSHIP_BASES = ['SOLE_OWNER', 'CO_OWNER', 'POWER_OF_ATTORNEY', 'MANAGEMENT_CONTRACT', 'OTHER'] as const;
export type OwnershipBasis = (typeof OWNERSHIP_BASES)[number];

export const OWNERSHIP_BASIS_LABEL: Record<OwnershipBasis, string> = {
  SOLE_OWNER: 'Я единственный собственник',
  CO_OWNER: 'Я один из собственников',
  POWER_OF_ATTORNEY: 'Действую по доверенности',
  MANAGEMENT_CONTRACT: 'Управляю жильём по договору',
  OTHER: 'Другое основание',
};

/** Which document the basis calls for. Shown to the applicant before they upload. */
export const BASIS_EXPECTED_DOCUMENT: Record<OwnershipBasis, string> = {
  SOLE_OWNER: 'Свидетельство о государственной регистрации или выписка из ЕГРНИ',
  CO_OWNER: 'Свидетельство о регистрации и согласие остальных собственников',
  POWER_OF_ATTORNEY: 'Доверенность с прямо указанным правом сдавать жильё в аренду',
  MANAGEMENT_CONTRACT: 'Договор управления или доверительного управления',
  OTHER: 'Документ, из которого видно ваше право сдавать это жильё',
};

/* ------------------------------------------------------------------ *
 * Queue priority
 * ------------------------------------------------------------------ */

export const VERIFICATION_PRIORITIES = ['LOW', 'NORMAL', 'HIGH'] as const;
export type VerificationPriority = (typeof VERIFICATION_PRIORITIES)[number];

/** Hours after which a waiting applicant is being kept waiting too long. */
export const VERIFICATION_SLA_HOURS: Record<VerificationPriority, number> = {
  HIGH: 24,
  NORMAL: 72,
  LOW: 168,
};

export interface VerificationPriorityInputs {
  readonly kind: VerificationKind;
  /** The applicant has a published listing that people can already book. */
  readonly hasPublishedListing: boolean;
  readonly hasFraudSignal: boolean;
  readonly ageHours: number;
}

/**
 * Derived, like dispute priority (DEC-041), and for the same reasons: no column
 * to go stale, and nothing an applicant can set.
 *
 * The signal that matters here is a live listing. Somebody whose flat is
 * already bookable is being chosen by tenants right now on the strength of a
 * Level 0 profile; making them wait a week is a worse outcome than making
 * somebody wait who has not published anything yet.
 */
export function verificationPriorityOf(input: VerificationPriorityInputs): VerificationPriority {
  if (input.hasFraudSignal) return 'HIGH';
  if (input.hasPublishedListing) return 'HIGH';
  if (input.ageHours >= VERIFICATION_SLA_HOURS.NORMAL) return 'HIGH';
  if (input.kind === 'PROPERTY_OWNERSHIP') return 'NORMAL';
  return 'NORMAL';
}

export function isVerificationOverdue(priority: VerificationPriority, ageHours: number): boolean {
  return ageHours > VERIFICATION_SLA_HOURS[priority];
}

/**
 * The same rule in SQL, so the queue can order and paginate in the database.
 *
 * Expects `vr` (verification_request), a boolean `pl.has_published` and a
 * boolean `fs.has_signal` in scope. A test runs the whole matrix through both
 * this and `verificationPriorityOf()` and asserts they agree — two copies of
 * one rule drift otherwise.
 */
export const VERIFICATION_PRIORITY_SQL = `
  CASE
    WHEN fs.has_signal THEN 'HIGH'
    WHEN pl.has_published THEN 'HIGH'
    WHEN EXTRACT(EPOCH FROM (now() - vr.created_at)) / 3600 >= ${VERIFICATION_SLA_HOURS.NORMAL} THEN 'HIGH'
    ELSE 'NORMAL'
  END`;

export const VERIFICATION_PRIORITY_RANK_SQL = `
  CASE ${VERIFICATION_PRIORITY_SQL} WHEN 'HIGH' THEN 0 WHEN 'NORMAL' THEN 1 ELSE 2 END`;
