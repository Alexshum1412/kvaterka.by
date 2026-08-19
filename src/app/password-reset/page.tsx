import type { Metadata } from 'next';
import Link from 'next/link';
import { readyServices } from '@/server/runtime.ts';
import { PasswordResetConfirm, PasswordResetRequest } from '@/ui/password-reset.tsx';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Смена пароля',
  // A reset page has nothing to index and everything to keep out of search.
  robots: { index: false, follow: false },
};

/**
 * The page the login form has always linked to and which did not exist.
 *
 * Two states, decided by whether a token is present. A token arrives in the
 * link from the message; it is a single-use credential, so the page renders
 * the form and nothing else — no account name, no address, no confirmation of
 * whose account it belongs to, because that is exactly what somebody who
 * intercepted the link would want to learn.
 */
export default async function PasswordResetPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  // Whether a reset message can physically be delivered in this deployment.
  // The request endpoint enqueues on the EMAIL channel only, so with no email
  // transport the code reaches nobody — and the page says so rather than
  // sending a person to wait for a message that will never arrive.
  const services = await readyServices();
  const deliverable = services.delivery.liveChannels().includes('EMAIL');

  return (
    <div className="container pr">
      <header className="pr__head">
        <h1>{token ? 'Новый пароль' : 'Забыли пароль?'}</h1>
        <p className="pr__lede">
          {token
            ? 'Придумайте новый пароль. После сохранения все открытые сеансы будут завершены.'
            : 'Укажите почту или телефон, и мы пришлём ссылку для смены пароля.'}
        </p>
      </header>

      <section className="card">
        {token ? <PasswordResetConfirm token={token} /> : <PasswordResetRequest deliverable={deliverable} />}
      </section>

      {!token && (
        <p className="pr__foot">
          Нет учётной записи?{' '}
          <Link href="/login" className="link">
            Зарегистрироваться
          </Link>
        </p>
      )}

      <style>{`
        .pr { max-width: 26rem; padding-block: var(--space-6) var(--space-8); }
        .pr__head { margin-bottom: var(--space-4); }
        .pr__head h1 { font-size: var(--text-2xl); font-weight: 600; }
        .pr__lede { font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.6; margin-top: var(--space-2); }
        .pr__foot { font-size: var(--text-sm); color: var(--text-secondary); margin-top: var(--space-4); }
      `}</style>
    </div>
  );
}
