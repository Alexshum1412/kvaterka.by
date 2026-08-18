import Link from 'next/link';
import { CornflowerMark } from './brand.tsx';
import { Icon } from './icons.tsx';
import { currentUser } from '@/server/session.ts';
import { can } from '@/server/auth/rbac.ts';

/**
 * The site header.
 *
 * A marketplace header should be the quietest thing on the page: what the
 * visitor came for is the inventory. So the bar is white on the blue-white
 * ground with one hairline under it, navigation is text rather than a row of
 * buttons, and exactly one element is blue — the action not yet taken.
 *
 * The session is read here instead of being threaded through every page, so
 * no screen has to carry auth plumbing just to draw its own chrome. Signed
 * out, `currentUser` returns before it touches the database.
 *
 * Mobile is a different composition, not a squeezed desktop one: the text
 * navigation is replaced by a single labelled search control, because a
 * second sticky row of links would push listings off the first screen.
 */
export async function SiteHeader() {
  const user = await currentUser();
  const initial = Array.from(user?.displayName.trim() ?? '')[0]?.toUpperCase() ?? '';

  return (
    <header className="sh">
      <div className="container sh__bar">
        <Link href="/" className="sh__brand" aria-label="Кватэрка.by, на главную">
          <CornflowerMark size={26} className="sh__mark" />
          <span className="sh__word">
            Кватэрка<span className="sh__tld">.by</span>
          </span>
        </Link>

        <nav className="sh__nav" aria-label="Основная навигация">
          <Link href="/search" className="sh__link">
            Найти жильё
          </Link>
          {user ? (
            <>
              <Link href="/trips" className="sh__link">
                Мои поездки
              </Link>
              <Link href="/dashboard" className="sh__link">
                Мои квартиры
              </Link>
              <Link href="/favorites" className="sh__link">
                Избранное
              </Link>
              <Link href="/dashboard/chat" className="sh__link">
                Сообщения
              </Link>
              {/* Staff only, and one entry rather than one per console. An
                  ordinary account gets a 404 from the page itself, so this
                  link is the only thing that reveals the console exists — and
                  only to someone holding a permission that opens it.

                  `case.view` lands on the operations overview; a moderator
                  without it still reaches their own queue. */}
              {can(user.roles, 'case.view') ? (
                <Link href="/staff" className="sh__link sh__link--staff">
                  Операции
                </Link>
              ) : can(user.roles, 'listing.moderate') ? (
                <Link href="/moderation" className="sh__link sh__link--staff">
                  Модерация
                </Link>
              ) : (
                /* VERIFIER holds neither `case.view` nor `listing.moderate`, so
                   before this they had no way into the console at all — the one
                   role whose entire job is a staff screen could not reach one. */
                can(user.roles, 'verification.review') && (
                  <Link href="/staff/verification" className="sh__link sh__link--staff">
                    Верификация
                  </Link>
                )
              )}
            </>
          ) : (
            <>
              <Link href="/dashboard/listings/new" className="sh__link">
                Сдать квартиру
              </Link>
              {/* Signed out this leads to sign-in, which is the honest answer:
                  a shortlist has to belong to somebody. */}
              <Link href="/favorites" className="sh__link">
                Избранное
              </Link>
            </>
          )}
        </nav>

        <div className="sh__end">
          <Link href="/search" className="sh__icon-link" aria-label="Найти жильё">
            <Icon name="search" size={20} />
          </Link>

          {user ? (
            <Link
              href="/dashboard"
              className="sh__me"
              aria-label={`${user.displayName} — личный кабинет`}
            >
              <span className="sh__monogram" aria-hidden="true">
                {initial === '' ? <Icon name="users" size={16} /> : initial}
              </span>
              <span className="sh__name truncate">{user.displayName}</span>
            </Link>
          ) : (
            <Link href="/login" className="btn btn-primary sh__cta">
              Войти
            </Link>
          )}
        </div>
      </div>

      <style>{`
        .sh {
          position: sticky;
          top: 0;
          z-index: 40;
          background: var(--surface);
          border-bottom: 1px solid var(--border);
        }
        .sh__bar {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          min-height: 3.5rem;
        }

        .sh__brand {
          display: inline-flex;
          align-items: center;
          flex: 0 0 auto;
          gap: 0.5rem;
          min-height: 2.75rem;
          padding-right: var(--space-2);
        }
        .sh__mark { color: var(--primary); }
        .sh__word {
          font-size: var(--text-lg);
          font-weight: 700;
          letter-spacing: -0.02em;
          color: var(--text-primary);
          white-space: nowrap;
        }
        /* The domain is not part of the spoken name; at equal weight the
           wordmark reads as a URL instead of as a brand. */
        .sh__tld { font-weight: 500; color: var(--text-secondary); }

        .sh__nav { display: none; }
        .sh__link--staff { color: var(--primary); font-weight: 600; }
        .sh__link {
          display: inline-flex;
          align-items: center;
          min-height: 2.75rem;
          font-size: var(--text-sm);
          font-weight: 500;
          color: var(--text-secondary);
          white-space: nowrap;
          transition: color 140ms ease;
        }
        .sh__link:hover { color: var(--text-primary); }

        /* The identity block is the only part allowed to give up width, and
           it gives it up by truncating a name rather than by overflowing. */
        .sh__end {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          flex: 1 1 auto;
          min-width: 0;
          gap: var(--space-2);
        }

        .sh__icon-link {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 2.75rem;
          height: 2.75rem;
          border-radius: var(--radius-sm);
          color: var(--text-secondary);
          transition: color 140ms ease;
        }
        .sh__icon-link:hover { color: var(--text-primary); }

        /* 40px, not the default 44: a full-height button in a 56px bar makes
           the chrome the loudest thing on a phone. */
        .sh .sh__cta { min-height: 2.5rem; padding-inline: 1rem; }

        .sh__me {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          min-width: 0;
          min-height: 2.75rem;
          padding-inline: 0.25rem;
          border-radius: var(--radius-full);
          color: var(--text-secondary);
        }
        .sh__monogram {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex: 0 0 auto;
          width: 2rem;
          height: 2rem;
          border-radius: var(--radius-full);
          background: var(--primary-soft);
          color: var(--primary);
          font-size: var(--text-sm);
          font-weight: 600;
          line-height: 1;
          transition: background-color 140ms ease;
        }
        .sh__me:hover .sh__monogram { background: var(--primary-soft-hover); }
        .sh__me:hover .sh__name { color: var(--text-primary); }
        .sh__name {
          display: none;
          max-width: 9rem;
          font-size: var(--text-sm);
          font-weight: 500;
          transition: color 140ms ease;
        }

        @media (min-width: 640px) {
          .sh__name { display: block; }
        }
        @media (min-width: 768px) {
          .sh__bar { min-height: var(--header-height); gap: var(--space-4); }
        }

        /* The text nav appears at 900, not 768.
         *
         * Measured rather than chosen: the nav is flex 0 0 auto over nowrap
         * links, so it cannot give width back. A staff account carries six
         * links — 489px of text plus gaps, 571px in all — and with the brand
         * (142) and the identity chip there is no arrangement that fits inside
         * 768. It was set to 768 when the widest account had five links, and
         * adding the operations entry put every staff user's page into
         * sideways scroll.
         *
         * Between 768 and 900 the compact icon bar carries the same
         * destinations, which is the behaviour phones already had.
         *
         * (No backticks in this block: it lives inside a template literal.) */
        @media (min-width: 900px) {
          .sh__nav {
            display: flex;
            align-items: center;
            flex: 0 0 auto;
            gap: var(--space-4);
            margin-inline-start: var(--space-4);
          }
          .sh__icon-link { display: none; }
          /* The identity block gives up width by dropping the name rather than
             by squeezing it to a clipped stub next to the monogram. */
          .sh__name { display: none; }
        }
        @media (min-width: 1080px) {
          .sh__nav { gap: var(--space-5); }
          .sh__name { display: block; }
        }
      `}</style>
    </header>
  );
}
