/**
 * Domain errors.
 *
 * Every failure a user can trigger gets a stable code, a message safe to show,
 * and an HTTP status. Nothing else is ever surfaced: an unexpected exception
 * becomes a generic 500 with a correlation id, so internals never leak (spec §66).
 */

export type ErrorCode =
  | 'NOT_FOUND'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'VALIDATION_FAILED'
  | 'DATES_UNAVAILABLE'
  | 'ILLEGAL_TRANSITION'
  | 'DURATION_OUT_OF_RANGE'
  | 'LISTING_NOT_BOOKABLE'
  | 'SELF_BOOKING'
  | 'ALREADY_EXISTS'
  | 'RATE_LIMITED'
  | 'ACCOUNT_RESTRICTED'
  | 'CONFLICT';

const STATUS: Record<ErrorCode, number> = {
  NOT_FOUND: 404,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  VALIDATION_FAILED: 422,
  DATES_UNAVAILABLE: 409,
  ILLEGAL_TRANSITION: 409,
  DURATION_OUT_OF_RANGE: 422,
  LISTING_NOT_BOOKABLE: 409,
  SELF_BOOKING: 422,
  ALREADY_EXISTS: 409,
  RATE_LIMITED: 429,
  ACCOUNT_RESTRICTED: 403,
  CONFLICT: 409,
};

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = STATUS[code];
    if (details) this.details = details;
  }
}

export const notFound = (what: string) => new DomainError('NOT_FOUND', `${what} не найден`);
export const forbidden = (why = 'Недостаточно прав') => new DomainError('FORBIDDEN', why);
export const invalid = (why: string, details?: Record<string, unknown>) =>
  new DomainError('VALIDATION_FAILED', why, details);
