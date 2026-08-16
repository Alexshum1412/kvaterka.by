/**
 * One error format for the whole API.
 *
 * Internal exception messages, stack traces and driver errors never reach a
 * client (spec §66). Anything that is not a recognised DomainError becomes a
 * generic 500 carrying only a correlation id, which is also written to the log
 * — so a user can quote one short string and support can find the exact request.
 */

import { ZodError } from 'zod';
import { DomainError, type ErrorCode } from '../services/errors.ts';
import { isPgError } from '../db/sql.ts';
import { WeakPasswordError } from '../auth/credentials.ts';
import { IllegalTransitionError } from '../domain/booking/states.ts';
import { PricingError } from '../domain/pricing.ts';
import { MoneyError } from '../domain/money.ts';
import type { ApiResponse } from './http.ts';

export interface ProblemBody {
  readonly error: {
    readonly code: ErrorCode | 'INTERNAL';
    readonly message: string;
    readonly details?: unknown;
    readonly correlationId: string;
  };
}

export function problem(
  code: ErrorCode | 'INTERNAL',
  status: number,
  message: string,
  correlationId: string,
  details?: unknown,
): ApiResponse<ProblemBody> {
  return {
    status,
    body: { error: { code, message, correlationId, ...(details === undefined ? {} : { details }) } },
  };
}

/** Field-level validation detail, shaped so a form can highlight inputs. */
function zodDetails(error: ZodError): { field: string; message: string }[] {
  return error.issues.map((i) => ({
    field: i.path.length > 0 ? i.path.join('.') : '_',
    message: i.message,
  }));
}

export interface ErrorLogEntry {
  readonly correlationId: string;
  readonly error: unknown;
  readonly unexpected: boolean;
}

/**
 * Translate any thrown value into a client-safe response.
 *
 * `onUnexpected` receives everything that was not a recognised domain failure,
 * so the caller can log it with the same correlation id the user is shown.
 */
export function toProblem(
  error: unknown,
  correlationId: string,
  onUnexpected?: (entry: ErrorLogEntry) => void,
): ApiResponse<ProblemBody> {
  if (error instanceof DomainError) {
    return problem(error.code, error.status, error.message, correlationId, error.details);
  }

  if (error instanceof ZodError) {
    return problem('VALIDATION_FAILED', 422, 'Проверьте правильность заполнения полей', correlationId, {
      fields: zodDetails(error),
    });
  }

  if (error instanceof WeakPasswordError) {
    return problem('VALIDATION_FAILED', 422, error.reason, correlationId, {
      fields: [{ field: 'password', message: error.reason }],
    });
  }

  // Domain guards that reached the boundary without a service translating them.
  // Their messages are written for developers, so only a generic message goes out.
  if (error instanceof IllegalTransitionError) {
    return problem('ILLEGAL_TRANSITION', 409, 'Это действие сейчас недоступно', correlationId);
  }
  if (error instanceof PricingError) {
    return problem('VALIDATION_FAILED', 422, 'Некорректные даты или цена', correlationId);
  }
  if (error instanceof MoneyError) {
    return problem('VALIDATION_FAILED', 422, 'Некорректная сумма', correlationId);
  }

  // A database error that no service translated is a bug on our side. It must
  // never be surfaced: constraint names and column names are internal detail.
  if (isPgError(error)) {
    onUnexpected?.({ correlationId, error, unexpected: true });
    return problem('INTERNAL', 500, 'Внутренняя ошибка сервера', correlationId);
  }

  onUnexpected?.({ correlationId, error, unexpected: true });
  return problem('INTERNAL', 500, 'Внутренняя ошибка сервера', correlationId);
}

/** Assertion used by tests and review: no response body may leak internals. */
export function looksLikeLeak(body: unknown): boolean {
  const text = JSON.stringify(body ?? '');
  return /(\bat \w+ \()|(\/src\/)|(node_modules)|(SQLSTATE)|(pg_|relation ")|(violates .* constraint)|(\bERROR:\s)/i.test(
    text,
  );
}
