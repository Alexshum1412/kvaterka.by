'use client';

import { useEffect } from 'react';
import { reportClientError } from '@/lib/report-error.ts';

/**
 * The boundary above the one in `[locale]/error.tsx`.
 *
 * That boundary cannot catch a throw from `[locale]/layout.tsx` itself —
 * Next.js never lets an error.tsx catch its own parent layout's error, only
 * its siblings and children. `[locale]/layout.tsx` calls `currentUser()` on
 * every single request, which opens a real Postgres connection; without
 * this file, a transient DB hiccup there fell through to Next's unstyled
 * generic crash screen on literally any route, including the homepage.
 *
 * This file replaces the *entire* document (Next's own convention: a
 * global-error must render its own <html>/<body>) precisely because the
 * layout that would normally provide them is what failed. Nothing here can
 * depend on next-intl, the i18n-aware Link, or globals.css's custom
 * properties resolving — any of those could be downstream of the same
 * failure. Text is hardcoded Russian (the site's primary and only fully
 * designed language, DEC-023) rather than locale-detected, for the same
 * reason `[locale]/error.tsx` shows only `error.digest` and nothing else
 * about the failure: this is the one place a locale lookup itself might be
 * the thing that just failed.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => reportClientError(error), [error]);

  return (
    <html lang="ru">
      <body
        style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#f7f9fc', color: '#0b2545' }}
      >
        <div style={{ maxWidth: '32rem', margin: '0 auto', padding: '4rem 1rem', textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 600 }}>Что-то пошло не так</h1>
          <p style={{ fontSize: '0.875rem', color: '#4a5a75', lineHeight: 1.6, marginTop: '0.75rem' }}>
            Страницу не удалось загрузить. Попробуйте ещё раз через минуту.
          </p>
          {error.digest && (
            <code
              style={{
                display: 'inline-block',
                marginTop: '0.75rem',
                padding: '0.5rem 0.75rem',
                background: '#f1f5fb',
                borderRadius: '0.5rem',
                fontFamily: 'ui-monospace, monospace',
                fontSize: '0.75rem',
                overflowWrap: 'anywhere',
              }}
            >
              {error.digest}
            </code>
          )}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '0.75rem',
              justifyContent: 'center',
              marginTop: '1.5rem',
            }}
          >
            <button
              type="button"
              onClick={reset}
              style={{
                minHeight: '2.75rem',
                padding: '0.625rem 1.125rem',
                border: 0,
                borderRadius: '0.5rem',
                background: '#216aca',
                color: '#fff',
                font: 'inherit',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Попробовать снова
            </button>
            <a
              href="/"
              style={{
                minHeight: '2.75rem',
                display: 'inline-flex',
                alignItems: 'center',
                padding: '0.625rem 1.125rem',
                borderRadius: '0.5rem',
                background: '#f1f5fb',
                color: '#0b2545',
                fontWeight: 600,
                textDecoration: 'none',
              }}
            >
              На главную
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
