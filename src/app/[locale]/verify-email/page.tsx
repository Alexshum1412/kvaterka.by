import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation.ts';
import { VerifyEmail } from '@/ui/verify-email.tsx';
import { parseVerifyLink } from '@/lib/verify-link.ts';
import { CornflowerMark } from '@/ui/brand.tsx';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('VerifyEmail');
  return {
    title: t('meta.title'),
    // A token-bearing page has nothing to index and everything to keep out of search.
    robots: { index: false, follow: false },
  };
}

/**
 * Where the link in the "confirm your email" message lands.
 *
 * The link proves the reader can open the inbox, not that they chose the
 * password, so the form asks for it before anything is sent. See
 * ui/verify-email.tsx.
 */
export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ identifier?: string | string[]; code?: string | string[] }>;
}) {
  const { identifier, code } = await searchParams;
  const link = parseVerifyLink(identifier, code);
  const t = await getTranslations('VerifyEmail');

  return (
    <div className="container ve">
      <header className="ve__head">
        <span className="ve__mark">
          <CornflowerMark size={44} />
        </span>
        <h1>{t('heading')}</h1>
      </header>

      <section className="card ve__card">
        {link ? (
          <VerifyEmail identifier={link.identifier} code={link.code} />
        ) : (
          <div className="ve__missing">
            <p>{t('missingToken')}</p>
            <p className="ve__links">
              <Link href="/login" className="link">
                {t('backToLogin')}
              </Link>
            </p>
          </div>
        )}
      </section>

      <style>{`
        .ve { max-width: 26rem; padding-block: clamp(2rem, 6vh, 3.5rem) var(--space-8); }

        .ve__head {
          display: flex; flex-direction: column; align-items: center;
          gap: 0.5rem; text-align: center;
          margin-bottom: var(--space-5);
        }
        .ve__mark { display: inline-flex; color: var(--primary); }
        .ve__head h1 { font-size: var(--text-2xl); font-weight: 600; }

        /* Same elevation as the login and password-reset cards, so the three
           screens read as one flow rather than three different experiments. */
        .ve__card {
          padding: var(--space-5);
          border-radius: var(--radius-lg);
          box-shadow: var(--shadow-raised);
        }
        @media (min-width: 480px) { .ve__card { padding: var(--space-6); } }

        .ve__missing p { font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.6; }
        .ve__links { margin-top: var(--space-3); }
      `}</style>
    </div>
  );
}
