/**
 * Process-wide runtime: validated configuration and the shared singletons.
 *
 * Configuration is validated once, at startup, and a bad value stops the
 * process rather than surfacing later as a mysterious runtime error.
 */

import { z } from 'zod';
import { createPostgresDb } from './db/postgres.ts';
import type { Db } from './db/sql.ts';
import { createServices, type Services } from './services/container.ts';
import { Router } from './api/router.ts';
import { allRoutes } from './api/routes/index.ts';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Base URL used in emails and Telegram deep links. */
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  SMTP_URL: z.string().optional(),
  /** Object storage: listing media and identity documents live in SEPARATE buckets. */
  MEDIA_BUCKET_URL: z.string().optional(),
  DOCUMENTS_BUCKET_URL: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

export function env(): Env {
  if (cachedEnv) return cachedEnv;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  if (
    parsed.data.NODE_ENV === 'production' &&
    parsed.data.MEDIA_BUCKET_URL &&
    parsed.data.MEDIA_BUCKET_URL === parsed.data.DOCUMENTS_BUCKET_URL
  ) {
    // Identity documents must never share a bucket with public listing media
    // (spec §54). Refusing to start is the only reliable enforcement point.
    throw new Error('DOCUMENTS_BUCKET_URL must differ from MEDIA_BUCKET_URL');
  }
  cachedEnv = parsed.data;
  return cachedEnv;
}

let cachedDb: Db | null = null;
let cachedServices: Services | null = null;
let cachedRouter: Router | null = null;

export function db(): Db {
  if (!cachedDb) {
    const config = env();
    cachedDb = createPostgresDb({
      connectionString: config.DATABASE_URL,
      max: config.DATABASE_POOL_MAX,
      ssl: config.DATABASE_SSL,
    });
  }
  return cachedDb;
}

export function services(): Services {
  cachedServices ??= createServices(db());
  return cachedServices;
}

export function router(): Router {
  cachedRouter ??= new Router(allRoutes);
  return cachedRouter;
}
