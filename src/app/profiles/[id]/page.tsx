import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ready, readyServices } from '@/server/runtime.ts';
import { ListingCard, type ListingCardData } from '@/ui/listing-card.tsx';
import { Icon } from '@/ui/icons.tsx';
import { plural } from '@/ui/primitives.tsx';
import { LEVEL_CLAIM, LEVEL_LABEL } from '@/server/domain/verification.ts';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  try {
    const profile = await (await readyServices()).trust.profile(id);
    return {
      title: `${profile.displayName} — профиль`,
      description: `Профиль на Кватэрка.by: подтверждения, отзывы и объявления.`,
      // A person's page is not SEO inventory.
      robots: { index: false, follow: false },
    };
  } catch {
    return { title: 'Профиль не найден', robots: { index: false, follow: false } };
  }
}

const BAND_LABEL: Record<string, string> = {
  NEW: 'Новый участник',
  DEVELOPING: 'Набирает опыт',
  ESTABLISHED: 'Опытный участник',
  HIGH: 'Высокий уровень доверия',
};

function memberSince(value: string): string {
  const iso = new Date(value).toISOString();
  const MONTHS = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
  ];
  const [y, m] = iso.slice(0, 10).split('-');
  return `${MONTHS[Number(m) - 1]} ${y}`;
}

/**
 * The public profile, for both sides.
 *
 * Everything here comes from `TrustService.profile`, which is the existing
 * public trust projection — no fraud signals, no moderation notes, no
 * verification internals, no contact details. That service already returns
 * `null` for a rate it cannot compute from real data, and this page omits
 * the row entirely rather than printing a fabricated "100%" or "—" that
 * reads like a score.
 *
 * The trust SCORE and its component breakdown are deliberately not shown.
 * They are an internal ranking input; exposing the arithmetic would tell
 * anyone how to farm it.
 */
export default async function ProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const services = await readyServices();

  let profile: Awaited<ReturnType<typeof services.trust.profile>>;
  try {
    profile = await services.trust.profile(id);
  } catch {
    notFound();
  }

  const database = await ready();

  // Only PUBLISHED listings, and only when this person is a landlord.
  const listings =
    profile.activeListings > 0
      ? await services.search.search({ limit: 12, sort: 'NEWEST' }).then((r) => r.items)
      : [];
  const theirs = listings.filter(
    (l) => (l as unknown as { owner: { id: string } }).owner.id === id,
  );

  const reviews = await database.query<Record<string, any>>(
    `SELECT r.id, r.overall, r.body, r.published_at, r.author_role,
            u.display_name AS author_name,
            b.nights
       FROM review r
       JOIN app_user u ON u.id = r.author_id
       JOIN booking b ON b.id = r.booking_id
      WHERE r.subject_id = $1 AND r.status = 'PUBLISHED'
      ORDER BY r.published_at DESC
      LIMIT 8`,
    [id],
  );

  const isCompany = profile.accountKind === 'COMPANY';

  return (
    <div className="container pf">
      <header className="pf__head">
        <span className="pf__avatar" aria-hidden="true">
          {profile.displayName.trim().charAt(0).toUpperCase()}
        </span>
        <div className="pf__who">
          <h1 className="pf__name">{profile.displayName}</h1>
          <p className="pf__kind">
            {isCompany ? 'Компания' : 'Частное лицо'} · на Кватэрке с {memberSince(profile.memberSince)}
          </p>
          <div className="pf__marks">
            {/* The verification level, worded as what the platform actually did.
                Never «юридически подтверждено»: Кватэрка.by looked at documents
                somebody supplied, it did not perform a title search, and it
                guarantees nothing. LEVEL_LABEL / LEVEL_CLAIM are the single
                source of that wording, shared with the console so the badge a
                verifier grants and the badge a tenant reads cannot diverge. */}
            {profile.verificationLevel >= 1 ? (
              <span
                className={profile.verificationLevel >= 2 ? 'badge badge-verified' : 'badge badge-info'}
                title={LEVEL_CLAIM[profile.verificationLevel as 1 | 2]}
              >
                <Icon name={profile.verificationLevel >= 2 ? 'shieldCheck' : 'checkCircle'} size={13} />
                {LEVEL_LABEL[profile.verificationLevel as 1 | 2]}
              </span>
            ) : (
              <span className="badge badge-solid-neutral">{LEVEL_LABEL[0]}</span>
            )}
            <span className="badge badge-primary">{BAND_LABEL[profile.trustBand] ?? ''}</span>
          </div>
          {/* The claim in words, under the badge, so a tenant reads what the
              badge means rather than inferring it. */}
          <p className="pf__claim">{LEVEL_CLAIM[profile.verificationLevel as 0 | 1 | 2]}</p>
        </div>
      </header>

      <section className="pf__stats" aria-label="Показатели">
        {profile.rating !== null && (
          <Stat
            icon="star"
            value={profile.rating.toFixed(1)}
            label={`${profile.reviewCount} ${plural(profile.reviewCount, 'отзыв', 'отзыва', 'отзывов')}`}
          />
        )}
        {profile.completedRentalsAsLandlord > 0 && (
          <Stat
            icon="home"
            value={String(profile.completedRentalsAsLandlord)}
            label={plural(profile.completedRentalsAsLandlord, 'сдача жилья', 'сдачи жилья', 'сдач жилья')}
          />
        )}
        {profile.completedRentalsAsTenant > 0 && (
          <Stat
            icon="key"
            value={String(profile.completedRentalsAsTenant)}
            label={plural(profile.completedRentalsAsTenant, 'аренда', 'аренды', 'аренд')}
          />
        )}
        {profile.activeListings > 0 && (
          <Stat
            icon="list"
            value={String(profile.activeListings)}
            label={plural(profile.activeListings, 'объявление', 'объявления', 'объявлений')}
          />
        )}
        {/* Rendered only when the service could actually compute it from
            real requests — never as a placeholder. */}
        {profile.responseRate !== null && (
          <Stat
            icon="message"
            value={`${Math.round(profile.responseRate * 100)}%`}
            label="ответов на заявки"
          />
        )}
      </section>

      {profile.rating === null &&
        profile.completedRentalsAsLandlord === 0 &&
        profile.completedRentalsAsTenant === 0 && (
          <p className="pf__fresh">
            <Icon name="info" size={16} />
            Пока нет завершённых сделок и отзывов. Это не значит, что что-то не так — просто
            история ещё не набралась.
          </p>
        )}

      {theirs.length > 0 && (
        <section className="pf__section">
          <h2 className="pf__h2">Объявления</h2>
          <div className="pf__grid">
            {theirs.map((l) => (
              <ListingCard key={l.id} listing={l as unknown as ListingCardData} />
            ))}
          </div>
        </section>
      )}

      <section className="pf__section">
        <h2 className="pf__h2">
          Отзывы{profile.reviewCount > 0 ? ` · ${profile.reviewCount}` : ''}
        </h2>
        {reviews.rows.length === 0 ? (
          <p className="text-sm muted">
            Отзывов пока нет. Их можно оставить только после завершённой аренды, поэтому здесь не
            бывает случайных оценок.
          </p>
        ) : (
          <ul className="pf__reviews">
            {reviews.rows.map((r) => (
              <li key={r.id} className="pf__review">
                <div className="pf__reviewHead">
                  <strong className="pf__reviewAuthor">{r.author_name}</strong>
                  <span className="pf__reviewScore numeric">
                    <Icon name="star" size={13} solid />
                    {r.overall}
                  </span>
                  <span className="pf__reviewRole">
                    {r.author_role === 'TENANT' ? 'как арендатор' : 'как хозяин'}
                  </span>
                </div>
                {r.body && <p className="pf__reviewBody">{r.body}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="hint pf__privacy">
        Телефон, email и точный адрес не публикуются. Контактами стороны обмениваются после
        подтверждённого бронирования.
      </p>

      <Link href="/search" className="link pf__back">
        <Icon name="arrowLeft" size={15} />
        К поиску жилья
      </Link>

      <style>{`
        .pf { padding-block: var(--space-5) var(--space-8); max-width: 56rem; }
        .pf__head { display: flex; align-items: center; gap: var(--space-4); margin-bottom: var(--space-5); }
        .pf__avatar {
          display: grid; place-items: center; flex: 0 0 auto;
          width: 4rem; height: 4rem; border-radius: var(--radius-full);
          background: var(--primary-soft); color: var(--primary);
          font-size: var(--text-2xl); font-weight: 600;
        }
        .pf__who { display: grid; gap: 0.25rem; min-width: 0; }
        .pf__name { font-size: var(--text-2xl); font-weight: 650; letter-spacing: -0.022em; }
        .pf__kind { font-size: var(--text-sm); color: var(--text-secondary); }
        .pf__marks { display: flex; gap: var(--space-2); flex-wrap: wrap; margin-top: 0.15rem; }
        .pf__claim { font-size: var(--text-xs); color: var(--text-tertiary); margin-top: 0.2rem; }

        .pf__stats {
          display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
          gap: var(--space-4);
          padding-block: var(--space-4);
          border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
        }
        .pf__stat { display: grid; gap: 0.1rem; }
        .pf__stat > svg { color: var(--text-tertiary); margin-bottom: 0.15rem; }
        .pf__statValue { font-size: var(--text-xl); font-weight: 650; letter-spacing: -0.02em; }
        .pf__statLabel { font-size: var(--text-xs); color: var(--text-tertiary); }

        .pf__fresh {
          display: flex; align-items: flex-start; gap: 0.5rem;
          margin-top: var(--space-4); padding: var(--space-3) var(--space-4);
          background: var(--surface-sunken); border-radius: var(--radius-sm);
          font-size: var(--text-sm); color: var(--text-secondary);
        }
        .pf__fresh > svg { color: var(--primary); flex: 0 0 auto; margin-top: 0.1rem; }

        .pf__section { padding-block: var(--space-6); }
        .pf__section + .pf__section { border-top: 1px solid var(--border); }
        .pf__h2 { font-size: var(--text-lg); font-weight: 600; margin-bottom: var(--space-4); }
        .pf__grid { display: grid; gap: var(--space-5) var(--space-4); grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }
        @media (max-width: 560px) { .pf__grid { grid-template-columns: 1fr; } }

        .pf__reviews { display: grid; gap: var(--space-5); margin: 0; padding: 0; list-style: none; }
        .pf__review { display: grid; gap: 0.3rem; }
        .pf__reviewHead { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
        .pf__reviewAuthor { font-size: var(--text-sm); }
        .pf__reviewScore { display: inline-flex; align-items: center; gap: 0.25rem; font-size: var(--text-sm); font-weight: 600; }
        .pf__reviewRole { font-size: var(--text-xs); color: var(--text-tertiary); }
        .pf__reviewBody { font-size: var(--text-sm); line-height: 1.6; color: var(--text-secondary); }

        .pf__privacy { border-top: 1px solid var(--border); padding-top: var(--space-4); max-width: 60ch; }
        .pf__back { margin-top: var(--space-5); }
      `}</style>
    </div>
  );
}

function Stat({
  icon,
  value,
  label,
}: {
  icon: 'star' | 'home' | 'key' | 'list' | 'message';
  value: string;
  label: string;
}) {
  return (
    <div className="pf__stat">
      <Icon name={icon} size={18} solid={icon === 'star'} />
      <span className="pf__statValue numeric">{value}</span>
      <span className="pf__statLabel">{label}</span>
    </div>
  );
}
