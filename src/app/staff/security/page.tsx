import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { currentUser, signInUrl } from '@/server/session.ts';
import { readyServices } from '@/server/runtime.ts';
import { Icon } from '@/ui/icons.tsx';
import { TwoFactorChallenge, TwoFactorSetup } from '@/ui/two-factor.tsx';
import { requiresTwoFactor } from '@/server/domain/two-factor.ts';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Безопасность',
  robots: { index: false, follow: false },
};

/**
 * Enrolment and challenge, on one page.
 *
 * DELIBERATELY NOT BEHIND A PERMISSION. Every other staff screen 404s for a
 * caller without the role, and this one must not — a staff member whose roles
 * are withheld because they have not enrolled would otherwise be locked out of
 * the only page that resolves that state. `auth: 'required'` and nothing more
 * is the correct bar for proving possession of your own authenticator.
 *
 * The page decides between three states from the session alone: enrol, answer a
 * challenge, or already done. It says what is unavailable and why, in plain
 * words, because «404» to somebody who genuinely holds the role reads as the
 * product being broken.
 */
export default async function SecurityPage() {
  const user = await currentUser();
  if (!user) redirect(signInUrl('/staff/security'));

  const services = await readyServices();
  const granted = await services.auth.grantedRoles(user.userId);
  const staff = requiresTwoFactor(granted);
  const withheld = user.withheldRoles;

  return (
    <div className="container tfa">
      <header className="tfa__head">
        <h1>Безопасность</h1>
        <p className="tfa__lede">
          {staff
            ? 'У вас есть служебный доступ. Он открывается только после второго фактора — пароля недостаточно.'
            : 'Дополнительная защита вашей учётной записи.'}
        </p>
      </header>

      {withheld.length > 0 && (
        <section className="card tfa__withheld">
          <Icon name="shield" size={20} />
          <div>
            <h2>Служебные разделы сейчас закрыты</h2>
            <p>
              {user.twoFactorEnrolled
                ? 'Подтвердите вход кодом из приложения — и разделы снова откроются в этой же сессии.'
                : 'Пока второй фактор не настроен, служебные разделы недоступны. Ваш обычный аккаунт — поездки, объявления, сообщения — работает как обычно.'}
            </p>
          </div>
        </section>
      )}

      {user.twoFactorEnrolled && withheld.length > 0 ? (
        <TwoFactorChallenge next="/staff" />
      ) : (
        <TwoFactorSetup enrolled={user.twoFactorEnrolled} required={staff} />
      )}

      <style>{`
        .tfa { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-4); max-width: 34rem; padding-block: var(--space-6) var(--space-8); min-width: 0; }
        .tfa__head h1 { font-size: var(--text-2xl); font-weight: 600; }
        .tfa__lede { font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.6; margin-top: var(--space-2); }
        .tfa__h2 { font-size: var(--text-base); font-weight: 600; margin-bottom: var(--space-3); }
        .tfa__muted { font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.6; margin-bottom: var(--space-4); }

        .tfa__withheld { display: flex; align-items: flex-start; gap: var(--space-3); border-left: 3px solid var(--warning); }
        .tfa__withheld > svg { color: var(--warning); flex: 0 0 auto; margin-top: 0.15rem; }
        .tfa__withheld h2 { font-size: var(--text-base); font-weight: 600; }
        .tfa__withheld p { font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.55; margin-top: 0.25rem; }

        .tfa__done { display: flex; align-items: flex-start; gap: var(--space-3); }
        .tfa__done > svg { color: var(--success); flex: 0 0 auto; margin-top: 0.15rem; }
        .tfa__done h2 { font-size: var(--text-base); font-weight: 600; }
        .tfa__done p { font-size: var(--text-sm); color: var(--text-secondary); margin-top: 0.25rem; }

        .tfa__scan { display: grid; justify-items: center; gap: var(--space-3); margin-bottom: var(--space-4); }
        .tfa__qr { border-radius: var(--radius-sm); max-width: 100%; height: auto; }
        .tfa__manual { font-size: var(--text-sm); color: var(--text-secondary); width: 100%; }
        .tfa__manual p { margin-bottom: 0.35rem; }
        /* A base32 secret is one unbreakable token; without this it sets the
           page width on a phone. */
        .tfa__secret { font-family: ui-monospace, monospace; font-size: var(--text-sm); overflow-wrap: anywhere; display: block; padding: var(--space-2); background: var(--surface-sunken); border-radius: var(--radius-sm); }

        .tfa__form { display: grid; gap: var(--space-3); justify-items: start; }
        .tfa__code { font-family: ui-monospace, monospace; font-size: var(--text-lg); letter-spacing: 0.2em; max-width: 9rem; }
        .tfa__error { font-size: var(--text-sm); color: var(--error); }

        .tfa__warn { display: flex; align-items: flex-start; gap: 0.45rem; padding: var(--space-3); background: var(--warning-soft); border-radius: var(--radius-sm); font-size: var(--text-sm); line-height: 1.55; margin-bottom: var(--space-3); }
        .tfa__warn > svg { flex: 0 0 auto; margin-top: 0.15rem; color: var(--warning); }
        .tfa__codeList { display: grid; grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr)); gap: var(--space-2); margin: 0 0 var(--space-3); padding: 0; list-style: none; }
        .tfa__codeList code { font-family: ui-monospace, monospace; font-size: var(--text-sm); padding: var(--space-2); background: var(--surface-sunken); border-radius: var(--radius-sm); display: block; text-align: center; }
        .tfa__confirmSaved { display: flex; align-items: center; gap: 0.5rem; font-size: var(--text-sm); margin-bottom: var(--space-3); min-height: 2.5rem; }
      `}</style>
    </div>
  );
}
