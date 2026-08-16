/**
 * Next.js adapter.
 *
 * Deliberately thin: it converts a Web `Request` into the framework-independent
 * `ApiRequest` the dispatcher understands, and converts the result back. All
 * routing, authentication, authorization, validation, rate limiting and
 * idempotency live in `src/server/api`, which is why the whole API is testable
 * without starting a server.
 */

import { dispatch } from '../../../server/api/router.ts';
import type { ApiRequest, Method } from '../../../server/api/http.ts';
import { ready, readyServices, router } from '../../../server/runtime.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const query: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    query[key] = values.length > 1 ? values : values[0]!;
  }

  let body: unknown = undefined;
  if (request.method !== 'GET' && request.method !== 'DELETE') {
    const contentType = headers['content-type'] ?? '';
    if (contentType.includes('application/json')) {
      const raw = await request.text();
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          return json(
            { error: { code: 'VALIDATION_FAILED', message: 'Некорректный JSON', correlationId: 'n/a' } },
            422,
          );
        }
      }
    }
  }

  const apiRequest: ApiRequest = {
    method: request.method as Method,
    // The catch-all lives under /api, which is not part of the route table.
    path: url.pathname.replace(/^\/api/, '') || '/',
    query,
    body,
    headers,
    // Trusting a proxy header is only safe behind a proxy that overwrites it;
    // deployment must guarantee that before this value is used for limiting.
    ip: headers['x-real-ip'] ?? headers['x-forwarded-for']?.split(',')[0]?.trim() ?? null,
  };

  const response = await dispatch(router(), apiRequest, {
    db: await ready(),
    services: await readyServices(),
    onError: ({ correlationId, error }) => {
      console.error(
        JSON.stringify({
          level: 'error',
          correlationId,
          path: apiRequest.path,
          method: apiRequest.method,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        }),
      );
    },
  });

  return json(response.body, response.status, response.headers);
}

function json(body: unknown, status: number, headers?: Readonly<Record<string, string>>): Response {
  if (status === 204 || body === null) {
    return new Response(null, { status, headers: headers as HeadersInit });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Nothing from this API should ever be cached by a shared cache: almost
      // every response is scoped to one authenticated user.
      'cache-control': 'no-store',
      ...(headers ?? {}),
    },
  });
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
