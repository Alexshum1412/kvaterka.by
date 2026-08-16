import Link from 'next/link';
import { Icon } from './icons.tsx';
import { FavouriteButton } from './favourite-button.tsx';
import { PROPERTY_TYPE_LABEL, formatNightsGenitive, plural } from './primitives.tsx';
import { formatMoney, fromStorage } from '@/server/domain/money.ts';

export interface ListingCardData {
  id: string;
  title: string;
  propertyType: string;
  city: string;
  district: string | null;
  rooms: number | null;
  areaSqm: string | null;
  maxGuests: number;
  floor: number | null;
  totalFloors: number | null;
  basePriceMinor: string;
  priceUnit: string;
  minNights: number;
  maxNights: number;
  bookingMode: string;
  photos: { id: string; storageKey: string; isCover: boolean }[];
  owner: { displayName: string; accountKind: string; verificationLevel: number };
  propertyVerified: boolean;
  rating: number | null;
  reviewCount: number;
  distanceMeters?: number;
  stayTotalMinor?: string;
}

/**
 * Listing card.
 *
 * Housing is chosen visually, so the photograph carries roughly three
 * fifths of the card at 3:2 and everything under it is set quietly: one
 * strong line (the price), then facts in descending order of how often a
 * tenant actually uses them. A card has two or three seconds of attention
 * and showing every attribute spends it.
 *
 * The whole card is a link, but the favourite control is a button, so the
 * two cannot nest. The link covers the card through a stretched ::after
 * and the button sits above it — one interactive element per hit area,
 * both reachable from the keyboard.
 */
export function ListingCard({
  listing,
  nights,
  initialFavourite,
}: {
  listing: ListingCardData;
  nights?: number;
  /**
   * Seeds the heart from the server so a page that already knows the
   * caller's shortlist does not make every card ask again.
   */
  initialFavourite?: boolean;
}) {
  const cover = listing.photos.find((p) => p.isCover) ?? listing.photos[0];
  const instant = listing.bookingMode !== 'REQUEST';

  const place = [
    listing.district ? `${listing.city} · ${listing.district}` : listing.city,
    listing.distanceMeters !== undefined &&
      (listing.distanceMeters < 1000
        ? `${listing.distanceMeters} м`
        : `${(listing.distanceMeters / 1000).toFixed(1)} км`),
  ]
    .filter(Boolean)
    .join(' · ');

  const basics = [
    listing.rooms !== null && `${listing.rooms} ${plural(listing.rooms, 'комната', 'комнаты', 'комнат')}`,
    listing.areaSqm && `${Math.round(Number(listing.areaSqm))} м²`,
    listing.floor !== null && listing.totalFloors !== null && `${listing.floor}/${listing.totalFloors} эт.`,
  ]
    .filter(Boolean)
    .join(' · ');

  const stayTotal = listing.stayTotalMinor;
  const stayNote =
    nights !== undefined && nights > 0
      ? `за ${nights} ${plural(nights, 'ночь', 'ночи', 'ночей')}, всё включено`
      : 'всё включено';

  return (
    <article className="lc">
      <div className="lc__media">
        {cover ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/media/${cover.storageKey}`}
            alt={`${PROPERTY_TYPE_LABEL[listing.propertyType] ?? 'Жильё'} — ${listing.title}`}
            loading="lazy"
            decoding="async"
            width={640}
            height={427}
          />
        ) : (
          <div className="lc__nophoto" aria-hidden="true">
            <Icon name="image" size={28} />
          </div>
        )}

        {/* One flag, and only for the fact that changes what happens next:
            verification is a claim about the object and stays with the
            facts below, where it can be worded precisely. */}
        {instant && <span className="lc__flag">Мгновенно</span>}
      </div>

      <FavouriteButton propertyId={listing.id} initial={initialFavourite} className="lc__fav" />

      <div className="lc__body">
        <h3 className="lc__title clamp-2">
          <Link href={`/listing/${listing.id}`} className="lc__link">
            {listing.title}
          </Link>
        </h3>

        <p className="lc__price">
          {/* With dates chosen the card shows the real total for those dates,
              not a headline rate nobody actually pays. */}
          {stayTotal ? (
            <>
              <span className="lc__amount numeric">{priceLabel(stayTotal)}</span>
              <span className="lc__per">{stayNote}</span>
            </>
          ) : (
            <>
              <span className="lc__amount numeric">{priceLabel(listing.basePriceMinor)}</span>
              <span className="lc__per">/ {listing.priceUnit === 'MONTH' ? 'месяц' : 'ночь'}</span>
              {listing.minNights > 1 && (
                <span className="lc__min">от {formatNightsGenitive(listing.minNights)}</span>
              )}
            </>
          )}
        </p>

        <p className="lc__place">{place}</p>

        <div className="lc__facts">
          {basics && <p className="lc__basics truncate">{basics}</p>}
          {listing.rating !== null && (
            <span className="lc__rating">
              <Icon name="star" size={14} solid />
              <span className="numeric">{listing.rating.toFixed(1)}</span>
              <span className="sr-only">из 5</span>
              {listing.reviewCount > 0 && (
                <>
                  <span className="lc__reviews numeric" aria-hidden="true">
                    ({listing.reviewCount})
                  </span>
                  <span className="sr-only">
                    , {listing.reviewCount} {plural(listing.reviewCount, 'отзыв', 'отзыва', 'отзывов')}
                  </span>
                </>
              )}
            </span>
          )}
        </div>

        {/* "Объект проверен" and "Личность подтверждена" are different
            claims (spec §16); the card carries only the one it can back. */}
        {listing.propertyVerified && (
          <p className="lc__verified">
            <Icon name="checkCircle" size={14} />
            Объект проверен
          </p>
        )}
      </div>

      <style>{`
        .lc {
          position: relative;
          display: flex;
          flex-direction: column;
          height: 100%;
          background: var(--surface);
          border-radius: var(--radius-md);
          transition: box-shadow 180ms ease, transform 180ms ease;
        }
        .lc:hover { box-shadow: var(--shadow-raised); transform: translateY(-2px); }
        .lc:focus-within { box-shadow: var(--shadow-raised); }
        .lc:active { transform: translateY(0); }

        /* 3:2 — the ratio phone cameras and estate photography actually use.
           4:3 crops interiors awkwardly. */
        .lc__media {
          position: relative;
          aspect-ratio: 3 / 2;
          border-radius: var(--radius-md) var(--radius-md) 0 0;
          overflow: hidden;
          background: var(--surface-sunken);
        }
        .lc__media img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .lc__nophoto {
          display: grid; place-items: center;
          width: 100%; height: 100%;
          color: var(--border-strong);
        }

        .lc__flag {
          position: absolute; top: var(--space-2); left: var(--space-2);
          /* Sits on a photograph, so it needs its own opaque ground rather
             than a tint that disappears over a pale interior. */
          background: var(--surface);
          color: var(--text-primary);
          font-size: var(--text-2xs);
          font-weight: 650;
          line-height: 1.4;
          padding: 0.25rem 0.5rem;
          border-radius: var(--radius-sm);
          box-shadow: var(--shadow-subtle);
        }

        /* Positioned from here; the control owns its own appearance. */
        .lc .lc__fav {
          position: absolute;
          top: var(--space-2);
          right: var(--space-2);
          z-index: 2;
        }

        .lc__body {
          flex: 1 1 auto;
          display: flex; flex-direction: column;
          gap: 0.25rem;
          padding: var(--space-3) var(--space-3) var(--space-4);
        }

        .lc__title {
          font-size: var(--text-base);
          font-weight: 600;
          letter-spacing: -0.015em;
          line-height: 1.4;
          overflow-wrap: anywhere;
          /* Clamping needs overflow:hidden, which would otherwise crop the
             focus ring of the link inside; the inset buys it room. */
          padding-inline: 3px;
          margin-inline: -3px;
        }
        /* The stretched link: the anchor stays inline so the heading can clamp,
           and its overlay — not the anchor — covers the card. */
        .lc__link::after {
          content: '';
          position: absolute;
          inset: 0;
          z-index: 1;
          border-radius: var(--radius-md);
        }

        .lc__price {
          margin-top: 0.125rem;
          display: flex; align-items: baseline; flex-wrap: wrap;
          gap: 0.1rem 0.4rem;
        }
        .lc__amount { font-size: var(--text-lg); font-weight: 650; letter-spacing: -0.02em; }
        .lc__per { font-size: var(--text-sm); color: var(--text-secondary); }
        .lc__min { font-size: var(--text-xs); color: var(--text-tertiary); }

        .lc__place { margin-top: 0.25rem; font-size: var(--text-sm); color: var(--text-secondary); }

        .lc__facts { display: flex; align-items: center; gap: var(--space-2); }
        .lc__basics { flex: 1 1 auto; font-size: var(--text-xs); color: var(--text-tertiary); }
        .lc__rating {
          flex: 0 0 auto; margin-left: auto;
          display: inline-flex; align-items: center; gap: 0.2rem;
          font-size: var(--text-sm); font-weight: 500;
          color: var(--text-primary);
        }
        .lc__reviews { color: var(--text-tertiary); font-weight: 400; }

        .lc__verified {
          margin-top: 0.375rem;
          display: inline-flex; align-items: center; gap: 0.3rem;
          font-size: var(--text-xs); font-weight: 500;
          color: var(--success);
        }
      `}</style>
    </article>
  );
}

/**
 * A rent is quoted in whole roubles, and ",00" at headline size is noise
 * the eye has to step over. The fraction is dropped only when it is
 * genuinely zero — an amount is never rounded for display.
 */
function priceLabel(minor: string): string {
  const amount = fromStorage(minor);
  const text = formatMoney(amount);
  return amount.amountMinor % 100n === 0n ? text.replace(',00', '') : text;
}
