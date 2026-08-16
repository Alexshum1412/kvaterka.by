/**
 * Browser API client.
 *
 * The frontend contract (spec §23 of the phase brief): one place that knows the
 * base URL, sends the session cookie, unwraps the standard error envelope, and
 * turns a failure into an Error carrying the code and the user-safe message.
 *
 * No component parses a raw response, so no component can accidentally show a
 * user something the API meant for a log.
 */

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
    readonly correlationId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Field-level messages, shaped for form rendering. */
  get fieldErrors(): Record<string, string> {
    const fields = (this.details as { fields?: { field: string; message: string }[] } | undefined)?.fields;
    if (!fields) return {};
    return Object.fromEntries(fields.map((f) => [f.field, f.message]));
  }
}

export interface RequestOptions {
  /** Sent as Idempotency-Key; a repeat replays the original response. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

const BASE = '/api';

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: RequestOptions = {},
): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    // The session lives in an HttpOnly cookie; JavaScript never touches it.
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
      ...(opts.headers ?? {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  if (response.status === 204) return null as T;

  const text = await response.text();
  const payload: unknown = text.length > 0 ? safeParse(text) : null;

  if (!response.ok) {
    const envelope = (payload as { error?: { code?: string; message?: string; details?: unknown; correlationId?: string } })
      ?.error;
    throw new ApiError(
      envelope?.code ?? 'INTERNAL',
      envelope?.message ?? 'Что-то пошло не так. Попробуйте ещё раз.',
      response.status,
      envelope?.details,
      envelope?.correlationId,
    );
  }

  return payload as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const api = {
  get: <T,>(path: string, opts?: RequestOptions) => request<T>('GET', path, undefined, opts),
  post: <T,>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', path, body, opts),
  patch: <T,>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PATCH', path, body, opts),
  put: <T,>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PUT', path, body, opts),
  delete: <T,>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, undefined, opts),
};
