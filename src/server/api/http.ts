/**
 * HTTP layer primitives.
 *
 * The API is an ADAPTER over the domain services, not a second architecture.
 * Handlers translate HTTP into service calls and back; they contain no
 * business rules, no state machines and no SQL. If a handler starts making a
 * decision, that decision belongs in a service.
 *
 * Routes are declared as data rather than as framework callbacks so that the
 * same table drives dispatch, authorization, validation, rate limiting and the
 * generated OpenAPI document — one source of truth instead of four that drift.
 */

import type { z } from 'zod';
import type { Db } from '../db/sql.ts';
import type { Permission, Role } from '../auth/rbac.ts';
import type { Services } from '../services/container.ts';

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface ApiRequest {
  readonly method: Method;
  readonly path: string;
  readonly query: Record<string, string | string[]>;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
  /** Raw client address; hashed before it is ever stored. */
  readonly ip?: string | null;
}

export interface ApiResponse<T = unknown> {
  readonly status: number;
  readonly body: T;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface Caller {
  readonly userId: string;
  readonly sessionId: string;
  readonly roles: readonly Role[];
  readonly displayName: string;
  readonly emailVerified: boolean;
}

export interface RequestContext {
  readonly db: Db;
  readonly services: Services;
  /** Null for anonymous requests. */
  readonly caller: Caller | null;
  readonly correlationId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  /** Raw request headers, for the few handlers that need the session token itself. */
  readonly headers: Readonly<Record<string, string>>;
  readonly now: Date;
}

export interface HandlerInput<B = unknown, Q = unknown> {
  readonly body: B;
  readonly query: Q;
  readonly params: Readonly<Record<string, string>>;
  readonly ctx: RequestContext;
  /** Present only on routes that declare `auth: 'required'`. */
  readonly caller: Caller;
}

export interface RateLimitRule {
  readonly limit: number;
  readonly windowSeconds: number;
  /** Anonymous endpoints must limit by IP; authenticated ones by user. */
  readonly by: 'ip' | 'user';
  /** Distinct bucket name; defaults to the route id. */
  readonly bucket?: string;
}

export interface RouteDefinition<B = unknown, Q = unknown> {
  readonly method: Method;
  /** Path with `:param` segments, e.g. `/listings/:id`. */
  readonly path: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly auth: 'none' | 'optional' | 'required';
  /** Staff permission required in addition to authentication. */
  readonly permission?: Permission;
  // Input type is left open: query schemas legitimately transform (a
  // comma-separated string becoming an array, "true" becoming a boolean), so
  // the parsed output need not match the wire shape.
  readonly body?: z.ZodType<B, z.ZodTypeDef, any>;
  readonly query?: z.ZodType<Q, z.ZodTypeDef, any>;
  /** Documented success shape. Used for OpenAPI, not for runtime coercion. */
  readonly response?: z.ZodTypeAny;
  readonly successStatus?: number;
  /**
   * When true the route honours an `Idempotency-Key` header: a repeat with the
   * same key and the same payload replays the original response instead of
   * doing the work twice.
   */
  readonly idempotent?: boolean;
  readonly rateLimit?: RateLimitRule;
  /** Marks endpoints whose behaviour depends on an unresolved legal question. */
  readonly legalReview?: string;
  readonly handler: (input: HandlerInput<B, Q>) => Promise<ApiResponse | unknown>;
}

/** Erased form, so routes with different schemas can live in one array. */
export type AnyRoute = RouteDefinition<never, never>;

export function defineRoute<B, Q>(route: RouteDefinition<B, Q>): AnyRoute {
  return route as unknown as AnyRoute;
}

export const routeId = (route: { method: string; path: string }): string =>
  `${route.method} ${route.path}`;

export const ok = <T,>(body: T, status = 200, headers?: Record<string, string>): ApiResponse<T> => ({
  status,
  body,
  headers,
});

export const created = <T,>(body: T): ApiResponse<T> => ({ status: 201, body });
export const noContent = (): ApiResponse<null> => ({ status: 204, body: null });

export function isApiResponse(value: unknown): value is ApiResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    typeof (value as ApiResponse).status === 'number' &&
    'body' in value
  );
}
