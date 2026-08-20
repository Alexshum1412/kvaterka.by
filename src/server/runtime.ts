/**
 * Process-wide runtime: validated configuration and the shared singletons.
 *
 * Configuration is validated once, at startup, and a bad value stops the
 * process rather than surfacing later as a mysterious runtime error.
 */

import path from 'node:path';
import { z } from 'zod';
import { createPostgresDb } from './db/postgres.ts';
import type { Db } from './db/sql.ts';
import { createServices, type Services } from './services/container.ts';
import { Router } from './api/router.ts';
import { MIN_JOB_TOKEN_LENGTH } from './api/machine.ts';
import { allRoutes } from './api/routes/index.ts';

/**
 * `DATABASE_URL=pglite` runs the app against an in-process PostgreSQL with no
 * server to install — the same engine the tests use. It exists so that
 * `npm run dev` works on a fresh checkout, which is worth a great deal for
 * onboarding and for demonstrating the product. It is refused in production
 * below: the data lives in memory and disappears with the process.
 */
export const PGLITE_URL = 'pglite';

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
  /**
   * Whether search engines may index this deployment.
   *
   * Defaults to FALSE, and stays false for every staging deployment. The first
   * deployment of this platform lands on the real domain while the product is
   * still closed; a crawler that finds it puts demonstration flats and seeded
   * people into search results, and removing them again is somebody's week.
   * Opening it is a deliberate act performed once, at launch.
   */
  SITE_INDEXABLE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  SMTP_URL: z.string().optional(),
  /**
   * Shared secret a scheduler presents to run the three background jobs.
   *
   * Optional, and absent means there is no machine principal at all — the jobs
   * stay reachable only by a human with the permission, which is what the
   * product did before. Validated here rather than at first use so a weak
   * token stops a deployment instead of surfacing at 03:00 when the sweep runs.
   */
  JOB_RUNNER_TOKEN: z
    .string()
    .min(MIN_JOB_TOKEN_LENGTH, `JOB_RUNNER_TOKEN must be at least ${MIN_JOB_TOKEN_LENGTH} characters`)
    .optional(),
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
let devDbPromise: Promise<Db> | null = null;

export function db(): Db {
  if (!cachedDb) {
    const config = env();
    if (config.DATABASE_URL === PGLITE_URL) {
      throw new Error(
        'DATABASE_URL=pglite requires the async initialiser. Call `await ready()` before `db()`.',
      );
    }
    cachedDb = createPostgresDb({
      connectionString: config.DATABASE_URL,
      max: config.DATABASE_POOL_MAX,
      ssl: config.DATABASE_SSL,
    });
  }
  return cachedDb;
}

/**
 * Resolve the database, bringing up the in-process engine when the developer
 * mode is selected. Page and route handlers await this instead of `db()`.
 */
export async function ready(): Promise<Db> {
  const config = env();
  if (config.DATABASE_URL !== PGLITE_URL) return db();

  if (config.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL=pglite is a development convenience and cannot be used in production');
  }

  devDbPromise ??= (async () => {
    const [{ createPgliteDb }, { migrate }, { seedDemoData }] = await Promise.all([
      import('./db/pglite.ts'),
      import('./db/migrator.ts'),
      import('./db/seed.ts'),
    ]);
    // Persisted under .pgdata so a hot reload does not wipe the database and
    // invalidate every id the developer currently has open.
    const instance = await createPgliteDb(path.join(process.cwd(), '.pgdata'));
    await migrate(instance);
    await seedDemoData(instance);
    cachedDb = instance;
    cachedServices = createServices(instance);
    return instance;
  })();

  return devDbPromise;
}

export function services(): Services {
  cachedServices ??= createServices(db());
  return cachedServices;
}

export async function readyServices(): Promise<Services> {
  await ready();
  cachedServices ??= createServices(cachedDb!);
  return cachedServices;
}

export function router(): Router {
  cachedRouter ??= new Router(allRoutes);
  return cachedRouter;
}
