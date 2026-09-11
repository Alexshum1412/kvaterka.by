import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { LoginForm } from '@/ui/login-form.tsx';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Login');
  return { title: t('meta.title'), robots: { index: false, follow: false } };
}

/**
 * `next` is attacker-controllable and ends up in `location.assign()`, so
 * it is constrained to a path on this site. A protocol-relative value
 * like `//evil.example` is a URL, not a path, and is the case a naive
 * `startsWith('/')` check lets through.
 */
function safeNext(value: string | undefined): string {
  if (!value) return '/dashboard';
  if (!value.startsWith('/') || value.startsWith('//')) return '/dashboard';
  return value;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = typeof params.next === 'string' ? params.next : undefined;
  const googleError = typeof params.error === 'string' ? params.error : undefined;

  return (
    <div className="login-page">
      <LoginForm next={safeNext(raw)} googleError={googleError} />

      <style>{`
        /* One column, one decision. The page ground carries the screen and
           the only drawn surface is the form itself. */
        .login-page {
          width: 100%;
          max-width: 26rem;
          margin-inline: auto;
          padding: clamp(2rem, 6vh, 3.5rem) 1rem var(--space-7);
        }
      `}</style>
    </div>
  );
}
