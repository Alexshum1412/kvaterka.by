/**
 * Object storage.
 *
 * Listing photographs and identity documents live outside the database, in two
 * separate buckets (spec §54, and the split `runtime.ts` refuses to start
 * without in production). This module is the only thing that knows whether
 * either bucket exists.
 *
 * WHY `delete()` THROWS RATHER THAN DOING NOTHING
 *
 * There is no bucket configured anywhere yet. A `delete()` that quietly
 * returned success would let the retention job write `purged_at` — a column
 * whose entire meaning is «эти байты уничтожены» — over a document still
 * sitting in storage. The job would then never look at that row again, because
 * the purge scan filters on `purged_at IS NULL`. One silent no-op turns a
 * privacy guarantee into a false record that nothing can correct.
 *
 * So an unconfigured store refuses, loudly, every time. The job runs, reports
 * every candidate as a failure with a stated reason, and destroys nothing. That
 * is not the job being broken; that is the job being honest about the fact that
 * this deployment has nowhere to delete from.
 *
 * The same posture as `POST /api/uploads`, which returns 501 rather than
 * pretend a photograph was stored, and `attachDocument`, which refuses rather
 * than accept a passport it has nowhere to put.
 *
 * If you are here because the retention job's failure list is full of
 * NOT_IMPLEMENTED and you want it to stop: the fix is to implement a store, not
 * to make this one lie.
 */

import { DomainError } from '../services/errors.ts';
import type { Env } from '../runtime.ts';

export interface ObjectStore {
  /** Which bucket, for diagnostics and for the console. Never a credential. */
  readonly describe: () => string;
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  /**
   * Remove an object.
   *
   * MUST be idempotent: deleting a key that is already gone is success, because
   * a retry after a crash between the delete and its confirmation must be able
   * to complete. MUST throw on any other failure — including "not configured".
   */
  delete(key: string): Promise<void>;
  /** Whether this store can actually reach storage. False fails purges closed. */
  readonly configured: boolean;
}

/**
 * The only implementation that ships today.
 *
 * Named for what it is. A reader who sees `unconfiguredObjectStore()` wired
 * into the container knows immediately that nothing is stored or destroyed.
 */
export function unconfiguredObjectStore(bucket: string, why = 'не настроено'): ObjectStore {
  const refuse = (verb: string): never => {
    throw new DomainError(
      'NOT_IMPLEMENTED',
      `Хранилище «${bucket}»: ${why}, поэтому ${verb} невозможно. ` +
        'Пока хранилища нет, платформа не может подтвердить, что файл действительно удалён.',
    );
  };
  return {
    configured: false,
    describe: () => `${bucket} — ${why}`,
    async put() {
      refuse('сохранение');
    },
    async delete() {
      refuse('удаление');
    },
  };
}

/**
 * The one name in the codebase for the private document bucket.
 *
 * Typed as `keyof Env`, so if `runtime.ts` ever renames or drops the variable
 * this stops compiling. That is the protection that was missing: the previous
 * reader spelled it `VERIFICATION_DOCUMENT_BUCKET_URL` while the schema and
 * `.env.example` both said `DOCUMENTS_BUCKET_URL`, and nothing anywhere noticed.
 * Provisioning the documented variable would have left the gate reading
 * `undefined` for ever — failing closed, so nothing was ever unsafe, but for
 * the wrong reason and in a way that would have been very hard to diagnose.
 *
 * Read from `process.env` rather than through `env()` deliberately. `env()`
 * validates the entire environment and throws when, say, `DATABASE_URL` is
 * absent — which is the normal state under the in-process test database. A
 * storage gate that answered 500 "invalid environment" instead of 501 "no
 * storage configured" would tell the operator the wrong thing, and turn a
 * deliberate refusal into what looks like a bug.
 */
const DOCUMENTS_BUCKET: keyof Env = 'DOCUMENTS_BUCKET_URL';

/** Resolve the document store from the environment. */
export function documentStore(): ObjectStore {
  const bucket = 'приватные документы';
  if (!process.env[DOCUMENTS_BUCKET]) return unconfiguredObjectStore(bucket, 'адрес не задан');
  // The two refusals read differently on purpose. An operator who has set
  // DOCUMENTS_BUCKET_URL and still sees documents refused needs to know that
  // the address arrived and the client behind it does not exist yet — not to go
  // hunting for a typo in their configuration.
  return unconfiguredObjectStore(bucket, 'адрес задан, но клиент хранилища не реализован');
}
