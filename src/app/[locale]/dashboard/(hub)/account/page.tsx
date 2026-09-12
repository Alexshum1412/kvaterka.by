import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from '@/i18n/navigation.ts';
import { currentUser, signInUrl } from '@/server/session.ts';
import { readyServices } from '@/server/runtime.ts';
import { Icon } from '@/ui/icons.tsx';
import { CloseAccount } from '@/ui/close-account.tsx';
import type { AppLocale } from '@/i18n/routing.ts';
import { ProfileSettings } from '@/ui/profile-settings.tsx';
import { SecuritySettings } from '@/ui/security-settings.tsx';
import { TwoFactorSetup } from '@/ui/two-factor.tsx';
import {
  NotificationPreferences,
  type ChannelInfo,
  type PreferenceRow,
} from '@/ui/notification-preferences.tsx';
import { TelegramLink } from '@/ui/telegram-link.tsx';
import {
  MANDATORY_IN_APP,
  NOTIFICATION_CATEGORIES,
  notificationCategoryTitle,
} from '@/server/services/notification-service.ts';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Account');
  return { title: t('meta.title'), robots: { index: false, follow: false } };
}

/**
 * Profile and security, in one hub.
 *
 * Four independent surfaces share this page — editing the profile, changing
 * the password, reviewing sessions and 2FA, and the two sections that were
 * already here — and each one owns its own data and its own failure mode.
 * `ProfileSettings` and `SecuritySettings` fetch their own starting state
 * client-side rather than the page pre-loading it, so one of them being slow
 * or erroring never blocks the others from rendering.
 *
 * Closing an account is honesty, not erasure.
 *
 * Somebody who clicks «закрыть» usually means «уничтожьте мои данные», and
 * that is not what happens: access ends, the profile disappears from the
 * site, and the records the platform is built on — completed bookings, the
 * fee ledger, reviews the person left about other people — stay exactly
 * where they are.
 *
 * So this page never uses the word «удалить» for what it does. It says
 * «закрыть», lists what survives before the button rather than after it, and
 * names the steps that are NOT built with the legal question each waits on. A
 * screen that quietly implied erasure would be the single most misleading
 * surface in the product.
 */

interface Status {
  status: string;
  closedAt: string | null;
  canClose: boolean;
  blockers: { code: string; explanation: string }[];
  steps: { step: string; what: string; built: boolean; blockedBy: string | null }[];
  survives: string[];
  outstandingBalanceMinor: string;
}

export default async function AccountPage() {
  const user = await currentUser();
  const locale = (await getLocale()) as AppLocale;
  // `redirect` above never returns, but next-intl's generic typing for it
  // doesn't narrow `user` for the type checker the way `next/navigation`'s
  // does.
  if (!user) redirect({ href: signInUrl('/dashboard/account'), locale });

  const t = await getTranslations('Account');

  const services = await readyServices();
  const status = (await services.retention.erasureStatus(user!.userId)) as unknown as Status;

  /* Preferences, and — just as important — which channels this deployment can
     actually reach. `describeChannels()` is the provider's own account of
     itself, so a toggle is never offered for a transport that would silently
     do nothing. IN_APP is always real: the row IS the message. */
  const preferences = await services.notifications.getPreferences(user!.userId);
  const describe = services.delivery.describeChannels();
  const configured = services.delivery.liveChannels();

  const preferenceRows: PreferenceRow[] = NOTIFICATION_CATEGORIES.map((category) => ({
    category,
    title: notificationCategoryTitle(category, locale) ?? category,
    mandatoryInApp: MANDATORY_IN_APP.includes(category),
    // Telegram defaults on (DEC-070) — this fallback only matters if a
    // category were ever missing from `getPreferences()`'s own defaults,
    // which would be a bug there, not a reason for this one to disagree
    // with it about what "no answer yet" means.
    channels: preferences[category] ?? { IN_APP: true, EMAIL: true, TELEGRAM: true },
  }));

  const channelInfo: ChannelInfo[] = [
    { channel: 'IN_APP', label: t('notifications.channelInApp') },
    { channel: 'EMAIL', label: t('notifications.channelEmail') },
    { channel: 'TELEGRAM', label: t('notifications.channelTelegram') },
  ].map((c) => ({
    channel: c.channel as ChannelInfo['channel'],
    label: c.label,
    available: configured.includes(c.channel as ChannelInfo['channel']),
    // Strip the channel prefix the provider puts in front of its own reason,
    // which is useful in a job report and redundant beside a column header.
    note: (describe[c.channel] ?? '').replace(new RegExp(`^${c.channel}:\\s*`), ''),
  }));

  const built = status.steps.filter((s) => s.built);
  const notBuilt = status.steps.filter((s) => !s.built);
  const owes = BigInt(status.outstandingBalanceMinor || '0') < 0n;

  return (
    <div className="container acc">
      <header className="acc__head">
        <h1>{t('header.title')}</h1>
        <p className="acc__lede">{t('header.lede')}</p>
      </header>

      <ProfileSettings roles={user!.roles} />

      <SecuritySettings />

      <TwoFactorSetup enrolled={user!.twoFactorEnrolled} required={false} />

      {!status.closedAt && (
        <section className="card">
          <NotificationPreferences rows={preferenceRows} channels={channelInfo} />
          <TelegramLink />
        </section>
      )}

      {status.closedAt ? (
        <section className="card acc__closed">
          <Icon name="checkCircle" size={20} />
          <div>
            <h2>{t('closure.closedTitle')}</h2>
            <p>{t('closure.closedBody')}</p>
          </div>
        </section>
      ) : (
        <>
          <section className="card">
            <h2 className="acc__h2">{t('closure.whatHappensTitle')}</h2>
            <ul className="acc__steps">
              {built.map((s) => (
                <li key={s.step} className="acc__step acc__step--yes">
                  <Icon name="check" size={16} />
                  {s.what}
                </li>
              ))}
            </ul>
          </section>

          {/* The half that does not happen, named rather than omitted. */}
          <section className="card acc__pending">
            <h2 className="acc__h2">{t('closure.whatDoesNotTitle')}</h2>
            <p className="acc__muted">{t('closure.whatDoesNotBody')}</p>
            <ul className="acc__steps">
              {notBuilt.map((s) => (
                <li key={s.step} className="acc__step acc__step--no">
                  <Icon name="close" size={16} />
                  <span>
                    {s.what}
                    <em className="acc__blocked">
                      {t('closure.blockedBySuffix', { reason: s.blockedBy ?? '' })}
                    </em>
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="card">
            <h2 className="acc__h2">{t('closure.whatRemainsTitle')}</h2>
            <ul className="acc__survives">
              {status.survives.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
            {owes && (
              <p className="acc__debt">
                <Icon name="alert" size={16} />
                {t('closure.debtWarning')}
              </p>
            )}
          </section>

          {status.canClose ? (
            <CloseAccount />
          ) : (
            <section className="card acc__blockers">
              <h2 className="acc__h2">{t('closure.cannotCloseTitle')}</h2>
              <ul>
                {status.blockers.map((b) => (
                  <li key={b.code}>{b.explanation}</li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <style>{`
        .acc { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-4); max-width: 44rem; padding-block: var(--space-6) var(--space-8); min-width: 0; }
        .acc__head h1 { font-size: var(--text-2xl); font-weight: 600; }
        .acc__lede { font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.6; margin-top: var(--space-2); }
        .acc__h2 { font-size: var(--text-base); font-weight: 600; margin-bottom: var(--space-3); }
        .acc__muted { font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.6; margin-bottom: var(--space-3); }

        .acc__steps { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
        .acc__step { display: flex; align-items: flex-start; gap: 0.45rem; font-size: var(--text-sm); line-height: 1.55; min-width: 0; }
        .acc__step > svg { flex: 0 0 auto; margin-top: 0.2rem; }
        .acc__step--yes > svg { color: var(--success); }
        .acc__step--no { color: var(--text-secondary); }
        .acc__step--no > svg { color: var(--text-tertiary); }
        .acc__blocked { font-style: normal; color: var(--text-tertiary); font-size: var(--text-xs); }

        .acc__pending { border-left: 3px solid var(--warning); }
        .acc__survives { display: grid; gap: var(--space-2); margin: 0; padding-left: 1.1rem; font-size: var(--text-sm); line-height: 1.55; }
        .acc__debt { display: flex; align-items: flex-start; gap: 0.45rem; margin-top: var(--space-3); padding: var(--space-3); background: var(--warning-soft); border-radius: var(--radius-sm); font-size: var(--text-xs); line-height: 1.55; }
        .acc__debt > svg { flex: 0 0 auto; margin-top: 0.15rem; color: var(--warning); }

        .acc__danger { border-left: 3px solid var(--error); }
        .acc__blockers { border-left: 3px solid var(--warning); }
        .acc__blockers ul { display: grid; gap: var(--space-2); margin: 0; padding-left: 1.1rem; font-size: var(--text-sm); line-height: 1.55; }
        .acc__actions { display: flex; gap: var(--space-2); flex-wrap: wrap; margin-top: var(--space-3); }
        .acc__error { display: flex; align-items: center; gap: 0.4rem; font-size: var(--text-sm); color: var(--error); margin-top: var(--space-2); }
        .acc__closed { display: flex; align-items: flex-start; gap: var(--space-3); }
        .acc__closed > svg { color: var(--success); flex: 0 0 auto; margin-top: 0.2rem; }
        .acc__closed h2 { font-size: var(--text-base); font-weight: 600; }
        .acc__closed p { font-size: var(--text-sm); color: var(--text-secondary); margin-top: 0.25rem; }
      `}</style>
    </div>
  );
}
