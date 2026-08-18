/**
 * Role-based access control.
 *
 * Permissions are granted to roles explicitly. There is no wildcard and no
 * "admin can do anything" shortcut, because the single most valuable property
 * of this table is that `SUPPORT` provably cannot read an identity document —
 * a property that a wildcard would quietly destroy the first time somebody
 * granted ADMIN to a support lead.
 */

export const ROLES = [
  'TENANT',
  'LANDLORD',
  'SUPPORT',
  'MODERATOR',
  'VERIFIER',
  'FINANCE',
  'ADMIN',
] as const;

export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  // content moderation
  'listing.moderate',
  'review.moderate',
  'message.review',
  // identity
  'verification.review',
  'verification.decide',
  /** Opening the actual passport image. Deliberately narrow. */
  'document.read',
  // money
  'fee.waive',
  'ledger.adjust',
  'debt.view',
  // people
  'user.view',
  'user.restrict',
  'user.suspend',
  // cases
  'case.view',
  'case.handle',
  'case.resolve',
  // platform
  'audit.read',
  'feature_flag.write',
  'role.grant',
  /**
   * Running the scheduled lifecycle sweep (stay ends, completion deadlines,
   * review publication). Separate from the rest because it is a machine
   * credential in practice: a cron calls it, and it can move money-bearing
   * state, so it must not ride along on a human support permission.
   */
  'lifecycle.run',
  /**
   * Freezing data so a retention job cannot destroy it. Deliberately wider
   * than most staff permissions: a hold only ever PREVENTS destruction, so the
   * people who first hear "there is a problem with this account" must be able
   * to stop the clock without escalating first.
   */
  'retention.hold',
  /**
   * Running the retention purge. A machine credential like `lifecycle.run`,
   * and kept separate from it because this job reads document storage keys.
   */
  'retention.run',
  /**
   * Draining the notification outbox. A machine credential like the other two
   * job permissions, and separate from them because a delivery run reaches
   * outside the platform — it hands addresses and subject lines to a third
   * party — while the other jobs never leave the database.
   */
  'notifications.run',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Staff permissions. TENANT and LANDLORD hold none of these — their access to
 * their own bookings, listings and conversations is ownership-based and is
 * decided per row, not by role.
 */
const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  TENANT: [],
  LANDLORD: [],

  // First-line support: read enough to help, change nothing sensitive, and no
  // path whatsoever to identity documents (spec §17).
  SUPPORT: ['user.view', 'case.view', 'case.handle', 'debt.view', 'retention.hold'],

  MODERATOR: [
    'listing.moderate',
    'review.moderate',
    'message.review',
    'user.view',
    'case.view',
    'case.handle',
    'retention.hold',
  ],

  // The only role that may open an identity document, and every read is logged.
  VERIFIER: ['verification.review', 'verification.decide', 'document.read', 'user.view'],

  FINANCE: ['fee.waive', 'ledger.adjust', 'debt.view', 'user.view', 'audit.read'],

  ADMIN: [
    'listing.moderate',
    'review.moderate',
    'message.review',
    'verification.review',
    'verification.decide',
    'fee.waive',
    'ledger.adjust',
    'debt.view',
    'user.view',
    'user.restrict',
    'user.suspend',
    'case.view',
    'case.handle',
    'case.resolve',
    'audit.read',
    'feature_flag.write',
    'role.grant',
    'lifecycle.run',
    'retention.hold',
    'retention.run',
    'notifications.run',
  ],
};

/**
 * ADMIN deliberately does NOT include `document.read`.
 *
 * Reading somebody's passport is a distinct act from administering the
 * platform, so it requires the VERIFIER grant specifically — held by few people
 * and always logged. An administrator who genuinely needs it can be granted
 * VERIFIER, and that grant is itself an audited event. This is the difference
 * between "we restrict access to identity documents" being a policy and being
 * a fact.
 */

export function permissionsFor(roles: readonly Role[]): Set<Permission> {
  const out = new Set<Permission>();
  for (const role of roles) for (const p of ROLE_PERMISSIONS[role] ?? []) out.add(p);
  return out;
}

export function can(roles: readonly Role[], permission: Permission): boolean {
  return roles.some((r) => ROLE_PERMISSIONS[r]?.includes(permission));
}

export const isStaff = (roles: readonly Role[]): boolean =>
  roles.some((r) => r !== 'TENANT' && r !== 'LANDLORD');

/** Staff roles must authenticate with a second factor (spec §48, §65). */
export const requiresTwoFactor = (roles: readonly Role[]): boolean => isStaff(roles);

/**
 * Sensitive actions must carry a written reason, which is stored on the audit
 * row. "Why did you suspend this account?" must always have an answer.
 */
const REASON_REQUIRED: readonly Permission[] = [
  'user.restrict',
  'user.suspend',
  'fee.waive',
  'ledger.adjust',
  'document.read',
  'feature_flag.write',
  'role.grant',
  'retention.hold',
];

export const requiresReason = (permission: Permission): boolean => REASON_REQUIRED.includes(permission);
