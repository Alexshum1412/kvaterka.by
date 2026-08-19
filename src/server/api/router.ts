/**
 * Route matching and the request pipeline.
 *
 * Order matters and is deliberate:
 *
 *   match → rate limit → authenticate → authorize → validate → idempotency → handle
 *
 * Rate limiting runs before authentication so that an unauthenticated flood
 * cannot force an argon2 verification per request. Authorization runs before
 * validation so a caller without permission learns nothing about the expected
 * payload shape. Idempotency is claimed last, after every rejection that could
 * have happened, so a rejected request does not burn the caller's key.
 */

import { randomUUID } from 'node:crypto';
import type { Db } from '../db/sql.ts';
import { can } from '../auth/rbac.ts';
import { needsStepUp, stepUpSatisfied } from '../domain/two-factor.ts';
import { DomainError } from '../services/errors.ts';
import type { Services } from '../services/container.ts';
import {
  isApiResponse,
  routeId,
  type AnyRoute,
  type ApiRequest,
  type ApiResponse,
  type Caller,
  type RequestContext,
} from './http.ts';
import { machineCan, resolveMachine, type MachinePrincipal } from './machine.ts';
import { toProblem, type ErrorLogEntry } from './problem.ts';
import { bucketForIp, bucketForUser, checkRateLimit, rateLimitError } from './rate-limit.ts';
import { abandonIdempotent, beginIdempotent, completeIdempotent, IDEMPOTENCY_HEADER } from './idempotency.ts';

export const SESSION_COOKIE = 'kv_session';

interface CompiledRoute {
  readonly route: AnyRoute;
  readonly segments: readonly string[];
  readonly paramNames: readonly string[];
}

function compile(route: AnyRoute): CompiledRoute {
  const segments = route.path.split('/').filter((s) => s.length > 0);
  return {
    route,
    segments,
    paramNames: segments.filter((s) => s.startsWith(':')).map((s) => s.slice(1)),
  };
}

export interface MatchResult {
  readonly route: AnyRoute;
  readonly params: Record<string, string>;
}

export class Router {
  private readonly compiled: CompiledRoute[];

  constructor(routes: readonly AnyRoute[]) {
    const seen = new Set<string>();
    for (const r of routes) {
      const id = routeId(r);
      if (seen.has(id)) throw new Error(`Duplicate route: ${id}`);
      seen.add(id);
    }
    this.compiled = routes.map(compile);
  }

  get routes(): readonly AnyRoute[] {
    return this.compiled.map((c) => c.route);
  }

  match(method: string, path: string): MatchResult | null {
    const parts = path.split('?')[0]!.split('/').filter((s) => s.length > 0);
    let pathMatchedAnyMethod = false;

    // Candidates are collected rather than returned on first hit, because a
    // literal segment must beat a parameter: `/bookings/quote` has to reach the
    // quote route and not be swallowed by `/bookings/:id`. Declaration order is
    // a fragile way to express that, so specificity decides instead.
    let best: { route: AnyRoute; params: Record<string, string>; staticSegments: number } | null = null;

    for (const c of this.compiled) {
      if (c.segments.length !== parts.length) continue;

      const params: Record<string, string> = {};
      let matched = true;
      let staticSegments = 0;

      for (let i = 0; i < c.segments.length; i += 1) {
        const seg = c.segments[i]!;
        const part = parts[i]!;
        if (seg.startsWith(':')) {
          params[seg.slice(1)] = decodeURIComponent(part);
        } else if (seg === part) {
          staticSegments += 1;
        } else {
          matched = false;
          break;
        }
      }
      if (!matched) continue;

      pathMatchedAnyMethod = true;
      if (c.route.method !== method) continue;
      if (!best || staticSegments > best.staticSegments) best = { route: c.route, params, staticSegments };
    }

    if (best) return { route: best.route, params: best.params };

    if (pathMatchedAnyMethod) {
      throw new DomainError('VALIDATION_FAILED', 'Метод не поддерживается для этого адреса');
    }
    return null;
  }
}

export interface DispatchDeps {
  readonly db: Db;
  readonly services: Services;
  readonly onError?: (entry: ErrorLogEntry) => void;
  readonly now?: () => Date;
  /**
   * The scheduler's shared secret, from validated configuration. Undefined
   * means this deployment has no machine principal and the job routes stay
   * reachable only by a human holding the permission.
   */
  readonly jobToken?: string | undefined;
}

/** Extract the session token from a cookie, falling back to a bearer header. */
export function readSessionToken(headers: Readonly<Record<string, string>>): string | null {
  const cookie = headers['cookie'];
  if (cookie) {
    for (const part of cookie.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === SESSION_COOKIE && rest.length > 0) return decodeURIComponent(rest.join('='));
    }
  }
  const auth = headers['authorization'];
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return null;
}

export async function dispatch(
  router: Router,
  request: ApiRequest,
  deps: DispatchDeps,
): Promise<ApiResponse> {
  const correlationId = request.headers['x-correlation-id'] ?? randomUUID();
  const now = deps.now?.() ?? new Date();

  let claimedIdempotencyId: number | null = null;

  try {
    const matched = router.match(request.method, request.path);
    if (!matched) {
      throw new DomainError('NOT_FOUND', 'Адрес не найден');
    }
    const { route, params } = matched;

    /* ---- rate limit (before any expensive work) ---------------------- */
    if (route.rateLimit) {
      const name = route.rateLimit.bucket ?? routeId(route);
      // A user-scoped limit still falls back to IP for anonymous callers,
      // otherwise the limit would simply not apply to them.
      const preliminaryToken = readSessionToken(request.headers);
      let bucket = bucketForIp(name, request.ip ?? null);
      if (route.rateLimit.by === 'user' && preliminaryToken) {
        bucket = bucketForUser(name, hashForBucket(preliminaryToken));
      }
      const result = await checkRateLimit(
        deps.db,
        bucket,
        route.rateLimit.limit,
        route.rateLimit.windowSeconds,
        now,
      );
      if (!result.allowed) throw rateLimitError(result);
    }

    /* ---- authenticate ------------------------------------------------ */
    let caller: Caller | null = null;
    let machine: MachinePrincipal | null = null;
    if (route.auth !== 'none') {
      const token = readSessionToken(request.headers);
      if (token) {
        const session = await deps.services.auth.resolveSession(token);
        if (session) {
          caller = {
            userId: session.userId,
            sessionId: session.sessionId,
            roles: session.roles,
            displayName: session.displayName,
            emailVerified: session.emailVerified,
            withheldRoles: session.withheldRoles,
            stepUpAt: session.stepUpAt,
            twoFactorEnrolled: session.twoFactorEnrolled,
          };
        }
      }
      /* A scheduler, if it presented the job token and no session took
         precedence. A session always wins: a human debugging a job with both
         a cookie and the token in their client stays themselves in the audit
         trail rather than silently becoming "scheduler". */
      if (!caller) machine = resolveMachine(request.headers, deps.jobToken);

      if (route.auth === 'required' && !caller && !machine) {
        throw new DomainError('UNAUTHENTICATED', 'Требуется вход в аккаунт');
      }
    }

    /* ---- authorize --------------------------------------------------- */
    if (route.permission) {
      /* A machine is authorised from a hand-written list, never from a role.
         It holds the three job permissions and nothing else, so widening
         ADMIN — or any other role — can never widen what a scheduler may do.
         Step-up is skipped because it is unsatisfiable by a machine, and no
         machine permission is a step-up permission; a test asserts that those
         two sets stay disjoint rather than leaving it to be remembered. */
      if (machine) {
        if (!machineCan(route.permission)) {
          throw new DomainError('FORBIDDEN', 'Недостаточно прав');
        }
      } else {
        if (!caller) throw new DomainError('UNAUTHENTICATED', 'Требуется вход в аккаунт');
      if (!can(caller.roles, route.permission)) {
        // Deliberately identical to any other permission failure: the response
        // must not tell a prober which permission would have worked.
        //
        // NOTE that `caller.roles` are the EFFECTIVE roles: a staff member who
        // has not satisfied their second factor does not carry staff roles at
        // all (see AuthService.resolveSession), so 2FA is already enforced here
        // and on every page and service that reads the same roles. Nothing was
        // added to this block for that — which is the point, since a check
        // added here would have protected only the routed half of the product.
        throw new DomainError('FORBIDDEN', 'Недостаточно прав');
      }

      /* Step-up is the one thing this block does add. Some actions are too
         consequential to ride on a challenge passed hours ago — opening a
         passport, granting a badge, writing the ledger, taking an account
         away. Those need a confirmation within the last few minutes.

         It is safe for this to live in the router because step-up guards
         ACTIONS, and every action is a route. The console pages that bypass
         the router are reads. */
      if (needsStepUp(route.permission) && !stepUpSatisfied(caller.stepUpAt, now)) {
        throw new DomainError(
          'STEP_UP_REQUIRED',
          'Подтвердите вход кодом из приложения — это действие требует свежего подтверждения',
        );
      }
      }
    }

    /* ---- validate ---------------------------------------------------- */
    const body = route.body ? route.body.parse(request.body ?? {}) : (request.body as never);
    const query = route.query ? route.query.parse(request.query ?? {}) : (request.query as never);

    const ctx: RequestContext = {
      db: deps.db,
      services: deps.services,
      caller,
      machine,
      correlationId,
      ip: request.ip ?? null,
      userAgent: request.headers['user-agent'] ?? null,
      headers: request.headers,
      now,
    };

    /* ---- idempotency ------------------------------------------------- */
    const idempotencyKey = request.headers[IDEMPOTENCY_HEADER];
    if (route.idempotent && idempotencyKey && caller) {
      const lookup = await beginIdempotent(deps.db, caller.userId, routeId(route), idempotencyKey, request.body);
      if (lookup.kind === 'REPLAY') return withCorrelation(lookup.response, correlationId);
      claimedIdempotencyId = lookup.recordId;
    }

    /* ---- handle ------------------------------------------------------ */
    const result = await route.handler({
      body,
      query,
      params,
      ctx,
      caller: caller as Caller,
    });

    const response = isApiResponse(result)
      ? result
      : ({ status: route.successStatus ?? 200, body: result } satisfies ApiResponse);

    if (claimedIdempotencyId !== null) {
      if (response.status >= 200 && response.status < 300) {
        await completeIdempotent(deps.db, claimedIdempotencyId, response);
      } else {
        await abandonIdempotent(deps.db, claimedIdempotencyId);
      }
    }

    return withCorrelation(response, correlationId);
  } catch (error) {
    // A failed request must release its key so an honest retry can proceed.
    if (claimedIdempotencyId !== null) {
      await abandonIdempotent(deps.db, claimedIdempotencyId).catch(() => {});
    }
    return withCorrelation(toProblem(error, correlationId, deps.onError), correlationId);
  }
}

function withCorrelation(response: ApiResponse, correlationId: string): ApiResponse {
  return { ...response, headers: { ...(response.headers ?? {}), 'x-correlation-id': correlationId } };
}

/**
 * Bucket key for a not-yet-validated token. Hashed so a raw session token never
 * becomes part of a database key, even transiently.
 */
function hashForBucket(token: string): string {
  let h = 0;
  for (let i = 0; i < token.length; i += 1) h = (Math.imul(31, h) + token.charCodeAt(i)) | 0;
  return `t${(h >>> 0).toString(36)}`;
}
