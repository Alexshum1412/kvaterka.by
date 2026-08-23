/**
 * The narrow database interface the rest of the server codebase talks to.
 *
 * Two drivers implement it: node-postgres against a real server (production and
 * CI), and PGlite in-process (unit/integration tests on machines without
 * Docker). Both run genuine PostgreSQL, so a constraint that holds in a test
 * holds in production — this is not a mock or an in-memory imitation.
 */

export interface QueryResult<Row = Record<string, unknown>> {
  readonly rows: Row[];
  readonly rowCount: number;
}

export interface Sql {
  /** Parameterised query. Always use $1-style placeholders — never string concatenation. */
  query<Row = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<QueryResult<Row>>;
  /** Run a multi-statement script (migrations only). */
  execScript(text: string): Promise<void>;
}

export interface Db extends Sql {
  /**
   * Run `fn` inside a transaction. Commits on resolve, rolls back on throw.
   * Nested calls join the outer transaction via SAVEPOINT so that a service
   * calling another service cannot silently commit half its work.
   */
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** PostgreSQL error codes this codebase reacts to by name rather than by string matching. */
export const PG_ERROR = {
  UNIQUE_VIOLATION: '23505',
  EXCLUSION_VIOLATION: '23P01',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  RESTRICT_VIOLATION: '23001',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
  /** A value the client sent is not even parseable as its column type. */
  INVALID_TEXT_REPRESENTATION: '22P02',
} as const;

export interface PgError extends Error {
  code?: string;
  constraint?: string;
  detail?: string;
  table?: string;
}

export function isPgError(e: unknown): e is PgError {
  return e instanceof Error && typeof (e as PgError).code === 'string';
}

export function hasErrorCode(e: unknown, code: string): boolean {
  return isPgError(e) && e.code === code;
}

/**
 * The calendar guard firing — a night that was already spoken for.
 *
 * The guarantee lives in property_occupancy's primary key, but the error the
 * caller sees is still SQLSTATE 23P01 carrying one of these two names: the
 * triggers in 0003_bookings.sql re-raise it that way deliberately, so that
 * moving the mechanism did not move the contract. `undefined` is accepted
 * because PGlite does not always surface the constraint name.
 */
const OVERLAP_CONSTRAINTS = ['booking_no_overlap', 'calendar_block_no_overlap'] as const;

export function isOverlapViolation(e: unknown): boolean {
  if (!hasErrorCode(e, PG_ERROR.EXCLUSION_VIOLATION)) return false;
  const name = isPgError(e) ? e.constraint : undefined;
  return name === undefined || (OVERLAP_CONSTRAINTS as readonly string[]).includes(name);
}

/**
 * Narrower: the night is taken by a *booking* rather than by another block.
 *
 * Only the calendar service needs to tell these apart, and only so that a
 * landlord reads "these dates are already booked" instead of "already blocked".
 */
export function isBookedNightViolation(e: unknown): boolean {
  return (
    hasErrorCode(e, PG_ERROR.EXCLUSION_VIOLATION) &&
    isPgError(e) &&
    e.constraint === 'booking_no_overlap'
  );
}

export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  if (!hasErrorCode(e, PG_ERROR.UNIQUE_VIOLATION)) return false;
  return constraint === undefined || (isPgError(e) && e.constraint === constraint);
}

/** Transient failures that are safe to retry with the same inputs. */
export function isRetryable(e: unknown): boolean {
  return hasErrorCode(e, PG_ERROR.SERIALIZATION_FAILURE) || hasErrorCode(e, PG_ERROR.DEADLOCK_DETECTED);
}
