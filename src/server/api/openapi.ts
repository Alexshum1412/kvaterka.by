/**
 * OpenAPI generated from the route table.
 *
 * The point is that it cannot drift: paths, methods, auth, permissions, request
 * schemas and rate limits are read from the same objects the dispatcher uses,
 * so a hand-maintained document going stale is not a possible failure mode
 * (spec §22 of the phase brief).
 */

import { z } from 'zod';
import { routeId, type AnyRoute } from './http.ts';
import { requiresReason } from '../auth/rbac.ts';

interface JsonSchema {
  [key: string]: unknown;
}

/**
 * Minimal Zod → JSON Schema conversion covering the constructs this API uses.
 * A general converter is a library-sized problem; this stays small and honest,
 * degrading to `{}` for anything it does not recognise rather than lying.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const def = (schema as unknown as { _def: Record<string, any> })._def;
  const typeName = def?.typeName as string | undefined;

  switch (typeName) {
    case 'ZodString': {
      const out: JsonSchema = { type: 'string' };
      for (const check of def.checks ?? []) {
        if (check.kind === 'min') out.minLength = check.value;
        if (check.kind === 'max') out.maxLength = check.value;
        if (check.kind === 'email') out.format = 'email';
        if (check.kind === 'uuid') out.format = 'uuid';
        if (check.kind === 'datetime') out.format = 'date-time';
        if (check.kind === 'regex') out.pattern = String(check.regex).replace(/^\/|\/[gimsuy]*$/g, '');
      }
      return out;
    }
    case 'ZodNumber': {
      const out: JsonSchema = { type: def.checks?.some((c: any) => c.kind === 'int') ? 'integer' : 'number' };
      for (const check of def.checks ?? []) {
        if (check.kind === 'min') out.minimum = check.value;
        if (check.kind === 'max') out.maximum = check.value;
      }
      return out;
    }
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodLiteral':
      return { const: def.value };
    case 'ZodEnum':
      return { type: 'string', enum: def.values };
    case 'ZodNativeEnum':
      return { type: 'string', enum: Object.values(def.values ?? {}) };
    case 'ZodArray':
      return {
        type: 'array',
        items: zodToJsonSchema(def.type),
        ...(def.maxLength?.value !== undefined ? { maxItems: def.maxLength.value } : {}),
      };
    case 'ZodObject': {
      const shape = def.shape();
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        const field = value as z.ZodTypeAny;
        properties[key] = zodToJsonSchema(field);
        if (!field.isOptional()) required.push(key);
      }
      return { type: 'object', properties, ...(required.length ? { required } : {}) };
    }
    case 'ZodRecord':
      return { type: 'object', additionalProperties: zodToJsonSchema(def.valueType) };
    case 'ZodUnion':
      return { oneOf: (def.options as z.ZodTypeAny[]).map(zodToJsonSchema) };
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
      return zodToJsonSchema(def.innerType);
    case 'ZodEffects':
      return zodToJsonSchema(def.schema);
    case 'ZodPipeline':
      return zodToJsonSchema(def.out);
    default:
      return {};
  }
}

const ERROR_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: {},
        correlationId: { type: 'string', format: 'uuid' },
      },
      required: ['code', 'message', 'correlationId'],
    },
  },
  required: ['error'],
};

export interface OpenApiOptions {
  readonly title?: string;
  readonly version?: string;
  readonly serverUrl?: string;
}

export function generateOpenApi(routes: readonly AnyRoute[], opts: OpenApiOptions = {}): JsonSchema {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of routes) {
    // OpenAPI uses {param}; the router uses :param.
    const path = route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const pathParams = [...route.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!);

    const parameters: JsonSchema[] = pathParams.map((name) => ({
      name,
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));

    if (route.query) {
      const querySchema = zodToJsonSchema(route.query);
      const properties = (querySchema.properties ?? {}) as Record<string, JsonSchema>;
      const required = (querySchema.required ?? []) as string[];
      for (const [name, schema] of Object.entries(properties)) {
        parameters.push({ name, in: 'query', required: required.includes(name), schema });
      }
    }

    if (route.idempotent) {
      parameters.push({
        name: 'Idempotency-Key',
        in: 'header',
        required: false,
        schema: { type: 'string', maxLength: 200 },
        description: 'Repeat with the same key and payload replays the original response.',
      });
    }

    const responses: Record<string, unknown> = {
      [String(route.successStatus ?? 200)]: {
        description: 'Success',
        ...(route.response
          ? { content: { 'application/json': { schema: zodToJsonSchema(route.response) } } }
          : {}),
      },
      '422': { description: 'Validation failed', content: { 'application/json': { schema: ERROR_SCHEMA } } },
      '500': { description: 'Internal error', content: { 'application/json': { schema: ERROR_SCHEMA } } },
    };
    if (route.auth === 'required') {
      responses['401'] = {
        description: 'Authentication required',
        content: { 'application/json': { schema: ERROR_SCHEMA } },
      };
    }
    if (route.permission) {
      responses['403'] = {
        description: 'Insufficient permission',
        content: { 'application/json': { schema: ERROR_SCHEMA } },
      };
    }
    if (route.rateLimit) {
      responses['429'] = {
        description: 'Rate limited',
        content: { 'application/json': { schema: ERROR_SCHEMA } },
      };
    }

    const description = [
      route.permission ? `**Requires permission:** \`${route.permission}\`` : null,
      route.permission && requiresReason(route.permission)
        ? '**A written reason is required and is stored in the audit log.**'
        : null,
      route.rateLimit
        ? `**Rate limit:** ${route.rateLimit.limit} per ${route.rateLimit.windowSeconds}s per ${route.rateLimit.by}.`
        : null,
      route.idempotent ? '**Idempotent:** honours `Idempotency-Key`.' : null,
      route.legalReview ? `⚠️ **Legal review required:** ${route.legalReview}` : null,
    ]
      .filter(Boolean)
      .join('\n\n');

    (paths[path] ??= {})[route.method.toLowerCase()] = {
      operationId: routeId(route)
        .replace(/[^A-Za-z0-9]+/g, '_')
        .replace(/^_|_$/g, ''),
      summary: route.summary,
      ...(description ? { description } : {}),
      tags: [...route.tags],
      ...(parameters.length ? { parameters } : {}),
      ...(route.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: zodToJsonSchema(route.body) } },
            },
          }
        : {}),
      ...(route.auth === 'required' ? { security: [{ sessionCookie: [] }, { bearerAuth: [] }] } : {}),
      responses,
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: opts.title ?? 'Kvaterka API',
      version: opts.version ?? '0.1.0',
      description:
        'Belarusian rental marketplace API. Money is always expressed in integer minor units ' +
        '(kopecks) as decimal strings — never as JSON numbers, which cannot represent them exactly.',
    },
    servers: [{ url: opts.serverUrl ?? '/api' }],
    components: {
      securitySchemes: {
        sessionCookie: { type: 'apiKey', in: 'cookie', name: 'kv_session' },
        bearerAuth: { type: 'http', scheme: 'bearer' },
      },
      schemas: { Error: ERROR_SCHEMA },
    },
    paths,
  };
}
