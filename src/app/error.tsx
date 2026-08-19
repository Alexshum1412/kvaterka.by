'use client';

import Link from 'next/link';
import { useEffect } from 'react';

/**
 * The last line before a blank screen.
 *
 * All 28 pages are `force-dynamic` and fetch per request, so any of them can
 * throw at render time — a database hiccup, a row that no longer exists, a
 * shape the page did not expect. Without this boundary that surfaced as the
 * framework's default error screen with a stack trace on it.
 *
 * It deliberately shows NOTHING about the failure. `error.digest` is the
 * server-side correlation id; it is the one thing worth surfacing, because it
 * lets somebody match a user's report to a log line without the message itself
 * ever reaching the browser.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // The server has already logged this with its stack. Repeating the message
    // into the browser console would put internals somewhere they need not be.
    console.error('render failed', error.digest ?? '');
  }, [error]);

  return (
    <div className="container err">
      <h1>Что-то пошло не так</h1>
      <p>
        Мы не смогли показать эту страницу. Ошибка записана — попробуйте обновить, а если повторится,
        сообщите нам код ниже.
      </p>
      {error.digest && <code className="err__code">{error.digest}</code>}
      <div className="err__actions">
        <button type="button" className="btn btn-primary" onClick={reset}>
          Попробовать снова
        </button>
        <Link href="/" className="btn btn-secondary">
          На главную
        </Link>
      </div>

      <style>{`
        .err { max-width: 32rem; padding-block: var(--space-8); text-align: center; }
        .err h1 { font-size: var(--text-2xl); font-weight: 600; }
        .err p { font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.6; margin-top: var(--space-3); }
        .err__code { display: inline-block; margin-top: var(--space-3); padding: var(--space-2) var(--space-3); background: var(--surface-sunken); border-radius: var(--radius-sm); font-family: ui-monospace, monospace; font-size: var(--text-xs); overflow-wrap: anywhere; }
        .err__actions { display: flex; flex-wrap: wrap; gap: var(--space-3); justify-content: center; margin-top: var(--space-5); }
      `}</style>
    </div>
  );
}
