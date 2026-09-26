import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { safeNextPath } from '@/lib/safe-next.ts';
import { LoginForm } from '@/ui/login-form.tsx';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Login');
  return { title: t('meta.title'), robots: { index: false, follow: false } };
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
      {/* `next` ends up in location.assign(): see lib/safe-next.ts for what it refuses. */}
      <LoginForm next={safeNextPath(raw)} googleError={googleError} />

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
