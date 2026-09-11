import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from '@/i18n/navigation.ts';
import { currentUser, signInUrl } from '@/server/session.ts';
import { CornflowerMark } from '@/ui/brand.tsx';
import { PhoneVerify } from '@/ui/phone-verify.tsx';
import type { AppLocale } from '@/i18n/routing.ts';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('VerifyPhone');
  return { title: t('meta.title'), robots: { index: false, follow: false } };
}

/**
 * The mandatory stop between "email confirmed" and everywhere else (0018).
 *
 * `dashboard/layout.tsx` is what actually sends people here — this page just
 * has to handle being opened directly too (a bookmark, a reload) the same
 * way: bounce an anonymous visitor to sign in, and an already-verified one
 * straight past this screen, so it is never a dead end.
 */
export default async function VerifyPhonePage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const user = await currentUser();
  const locale = (await getLocale()) as AppLocale;
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';

  if (!user) redirect({ href: signInUrl('/verify-phone'), locale });
  if (user!.phoneVerified) redirect({ href: safeNext, locale });

  const t = await getTranslations('VerifyPhone');

  return (
    <div className="container vp">
      <header className="vp__head">
        <span className="vp__mark">
          <CornflowerMark size={44} />
        </span>
        <h1>{t('heading')}</h1>
      </header>

      <section className="card vp__card">
        <PhoneVerify next={safeNext} />
      </section>

      <style>{`
        .vp { max-width: 28rem; padding-block: clamp(2rem, 6vh, 3.5rem) var(--space-8); }

        .vp__head {
          display: flex; flex-direction: column; align-items: center;
          gap: 0.5rem; text-align: center;
          margin-bottom: var(--space-5);
        }
        .vp__mark { display: inline-flex; color: var(--primary); }
        .vp__head h1 { font-size: var(--text-2xl); font-weight: 600; }

        .vp__card {
          padding: var(--space-5);
          border-radius: var(--radius-lg);
          box-shadow: var(--shadow-raised);
        }
        @media (min-width: 480px) { .vp__card { padding: var(--space-6); } }
      `}</style>
    </div>
  );
}
