/**
 * In-process API client for tests.
 *
 * Exercises the real dispatcher — real routing, auth, RBAC, validation, rate
 * limiting and idempotency — without an HTTP server. Every assertion in the API
 * suite therefore tests the same code path production runs.
 */

import { Router, dispatch, SESSION_COOKIE } from '@/server/api/router.ts';
import { allRoutes } from '@/server/api/routes/index.ts';
import type { ApiResponse, Method } from '@/server/api/http.ts';
import { createServices } from '@/server/services/container.ts';
import type { TestDb } from '@/server/db/testing.ts';

export interface ClientResponse<T = any> extends ApiResponse<T> {
  readonly errorCode?: string;
}

export interface RequestOptions {
  readonly token?: string | null;
  readonly headers?: Record<string, string>;
  readonly ip?: string;
  readonly idempotencyKey?: string;
}

export class ApiTestClient {
  private readonly router = new Router(allRoutes);
  private readonly services;
  readonly errors: unknown[] = [];

  constructor(private readonly db: TestDb) {
    this.services = createServices(db);
  }

  async request<T = any>(
    method: Method,
    path: string,
    body?: unknown,
    opts: RequestOptions = {},
  ): Promise<ClientResponse<T>> {
    const [rawPath, queryString] = path.split('?');
    const query: Record<string, string | string[]> = {};
    if (queryString) {
      for (const [key, value] of new URLSearchParams(queryString)) query[key] = value;
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(opts.token ? { cookie: `${SESSION_COOKIE}=${encodeURIComponent(opts.token)}` } : {}),
      ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
      ...(opts.headers ?? {}),
    };

    const response = await dispatch(
      this.router,
      {
        method,
        path: rawPath!,
        query,
        body,
        headers,
        ip: opts.ip ?? '198.51.100.10',
      },
      {
        db: this.db,
        services: this.services,
        onError: (entry) => this.errors.push(entry.error),
      },
    );

    const errorCode = (response.body as { error?: { code?: string } })?.error?.code;
    return { ...response, ...(errorCode ? { errorCode } : {}) } as ClientResponse<T>;
  }

  get = <T = any>(path: string, opts?: RequestOptions) => this.request<T>('GET', path, undefined, opts);
  post = <T = any>(path: string, body?: unknown, opts?: RequestOptions) =>
    this.request<T>('POST', path, body, opts);
  patch = <T = any>(path: string, body?: unknown, opts?: RequestOptions) =>
    this.request<T>('PATCH', path, body, opts);
  put = <T = any>(path: string, body?: unknown, opts?: RequestOptions) =>
    this.request<T>('PUT', path, body, opts);
  delete = <T = any>(path: string, opts?: RequestOptions) => this.request<T>('DELETE', path, undefined, opts);

  /** Register and sign in, returning the session token. */
  async signUp(overrides: Record<string, unknown> = {}): Promise<{ token: string; userId: string; email: string }> {
    const email = `u-${Math.random().toString(36).slice(2)}-${Date.now()}@example.by`;
    const password = 'karotkaja-vulica-2026';
    // Distinct users come from distinct addresses. Sharing one IP across a
    // fixture would (correctly) trip the registration limiter and make tests
    // fail for a reason unrelated to what they assert.
    const ip = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;

    const registered = await this.post(
      '/auth/register',
      { email, password, displayName: 'Тэставы Карыстальнік', ...overrides },
      { ip },
    );
    if (registered.status !== 201) {
      throw new Error(`register failed: ${registered.status} ${JSON.stringify(registered.body)}`);
    }

    const loggedIn = await this.post('/auth/login', { identifier: email, password }, { ip });
    if (loggedIn.status !== 200) {
      throw new Error(`login failed: ${loggedIn.status} ${JSON.stringify(loggedIn.body)}`);
    }

    return {
      token: extractCookie(loggedIn.headers?.['set-cookie'] ?? ''),
      userId: registered.body.userId,
      email,
    };
  }

  /**
   * Make somebody a working staff member.
   *
   * Grants the role AND satisfies the second factor on their open sessions,
   * because since the 2FA slice those are two different things: a session that
   * has only presented a password carries none of its staff roles, so a bare
   * `INSERT INTO user_role` would produce an account that looks like staff in
   * the database and behaves like an ordinary user everywhere else.
   *
   * That is the enforcement working, and it is what almost every suite here
   * wants to skip past — these tests are about what a moderator may do, not
   * about how they logged in. The suites that DO test the withholding use
   * `grantRoleWithoutTwoFactor` below.
   */
  async grantRole(userId: string, role: string): Promise<void> {
    await this.grantRoleWithoutTwoFactor(userId, role);
    await this.satisfyTwoFactor(userId);
  }

  /** Grant a staff role and leave the session at password level. */
  async grantRoleWithoutTwoFactor(userId: string, role: string): Promise<void> {
    await this.db.query(`INSERT INTO user_role (user_id, role) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [
      userId,
      role,
    ]);
  }

  /** Mark every live session for this user as having passed a second factor. */
  async satisfyTwoFactor(userId: string): Promise<void> {
    await this.db.query(
      `UPDATE user_session SET auth_level='TWO_FACTOR', step_up_at=now()
        WHERE user_id=$1 AND revoked_at IS NULL`,
      [userId],
    );
  }

  /** Let a step-up confirmation go stale without touching the session level. */
  async expireStepUp(userId: string): Promise<void> {
    await this.db.query(
      `UPDATE user_session SET step_up_at = now() - interval '1 day'
        WHERE user_id=$1 AND revoked_at IS NULL`,
      [userId],
    );
  }

  /** Clear rate-limit state between tests that would otherwise trip each other. */
  async resetRateLimits(): Promise<void> {
    await this.db.query('DELETE FROM rate_limit_counter');
  }
}

function extractCookie(setCookie: string): string {
  const match = /kv_session=([^;]+)/.exec(setCookie);
  if (!match) throw new Error(`No session cookie in: ${setCookie}`);
  return decodeURIComponent(match[1]!);
}
