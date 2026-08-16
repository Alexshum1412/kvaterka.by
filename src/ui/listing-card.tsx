import Link from 'next/link';
import { Money, PROPERTY_TYPE_LABEL, plural } from './primitives.tsx';

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
 * Redesign rationale (UI_UX_AUDIT §3): the previous card gave the photo 44% of
 * its height inside a bordered, shadowed box with a row of badges — which is
 * exactly how a classifieds record looks. Housing is chosen visually, so the
 * photograph now carries roughly 60% of the card at 3:2, the box is gone, and
 * elevation appears only on hover to signal that the whole card is a link.
 *
 * Two badges maximum, and only ones that change a decision: "проверено" and
 * "мгновенно". Everything else is a fact, and facts belong in the meta line.
 */
export function ListingCard({ listing, nights }: { listing: ListingCardData; nights?: number }) {
  const cover = listing.photos.find((p) => p.isCover) ?? listing.photos[0];
  const instant = listing.bookingMode !== 'REQUEST';

  const meta = [
    listing.rooms !== null && `${listing.rooms}${' '}${plural(listing.rooms, 'комната', 'комнаты', 'комнат')}`,
    listing.areaSqm && `${Math.round(Number(listing.areaSqm))}${' '}м²`,
    listing.floor !== null && listing.totalFloors !== null && `${listing.floor}/${listing.totalFloors}${' '}эт.`,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <article className="lc">
      <Link href={`/listing/${listing.id}`} className="lc__link">
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
            <div className="lc__nophoto" aria-hidden="true" />
          )}

          {(listing.propertyVerified || instant) && (
            <div className="lc__flags">
              {listing.propertyVerified && (
                <span className="lc__flag" title="Платформа проверила право сдавать этот объект">
                  Проверено
                </span>
              )}
              {instant && !listing.propertyVerified && <span className="lc__flag">Мгновенно</span>}
            </div>
          )}
        </div>

        <div className="lc__body">
          <div className="lc__head">
            <h3 className="lc__title">{listing.title}</h3>
            {listing.rating !== null && (
              <span className="lc__rating numeric" aria-label={`Рейтинг ${listing.rating.toFixed(1)} из 5`}>
                <Star /> {listing.rating.toFixed(1)}
              </span>
            )}
          </div>

          <p className="lc__place">
            {listing.district ? `${listing.city}, ${listing.district}` : listing.city}
            {listing.distanceMeters !== undefined &&
              ` · ${listing.distanceMeters < 1000 ? `${listing.distanceMeters} м` : `${(listing.distanceMeters / 1000).toFixed(1)} км`}`}
          </p>

          {meta && <p className="lc__meta">{meta}</p>}

          <p className="lc__price">
            {/* With dates chosen the card shows the real total for those dates,
                not a headline nightly rate nobody actually pays. */}
            {listing.stayTotalMinor ? (
              <>
                <strong>
                  <Money minor={listing.stayTotalMinor} />
                </strong>
                <span className="lc__priceNote">
                  за {nights ?? 0} {plural(nights ?? 0, 'ночь', 'ночи', 'ночей')}, всё включено
                </span>
              </>
            ) : (
              <>
                <strong>
                  <Money minor={listing.basePriceMinor} />
                </strong>
                <span className="lc__priceNote">{listing.priceUnit === 'MONTH' ? 'в месяц' : 'за ночь'}</span>
              </>
            )}
          </p>
        </div>
      </Link>

      <style>{`
        .lc {
          border-radius: var(--radius-md);
          background: var(--surface-raised);
          box-shadow: var(--shadow-subtle);
          overflow: hidden;
          transition: box-shadow 180ms ease, transform 180ms ease;
        }
        .lc:hover { box-shadow: var(--shadow-raised); transform: translateY(-2px); }
        .lc:active { transform: translateY(0); }
        .lc__link { display: flex; flex-direction: column; height: 100%; }

        /* 3:2 — the ratio phone cameras and estate photography actually use.
           4:3 crops interiors awkwardly. */
        .lc__media { position: relative; aspect-ratio: 3 / 2; background: var(--surface-sunken); }
        .lc__media img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .lc__nophoto {
          width: 100%; height: 100%;
          background: linear-gradient(135deg, var(--surface-sunken), var(--secondary));
        }

        .lc__flags { position: absolute; left: var(--space-2); top: var(--space-2); display: flex; gap: var(--space-1); }
        .lc__flag {
          /* Sits on a photograph, so it needs its own opaque ground rather
             than a translucent tint that fails over a light image. */
          background: var(--surface-raised);
          color: var(--text-primary);
          font-size: var(--text-2xs);
          font-weight: 650;
          padding: 0.2rem 0.5rem;
          border-radius: var(--radius-sm);
          box-shadow: var(--shadow-subtle);
        }

        .lc__body {
          display: flex; flex-direction: column; gap: 0.15rem;
          padding: var(--space-3) var(--space-3) var(--space-4);
        }
        .lc__head { display: flex; gap: var(--space-2); align-items: baseline; justify-content: space-between; }
        .lc__title {
          font-size: var(--text-base);
          font-weight: 600;
          letter-spacing: -0.015em;
          line-height: 1.3;
          display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
        }
        .lc__rating {
          display: inline-flex; align-items: center; gap: 0.15rem;
          font-size: var(--text-sm); font-weight: 600; flex: 0 0 auto;
        }
        .lc__place { font-size: var(--text-sm); color: var(--text-secondary); }
        .lc__meta { font-size: var(--text-xs); color: var(--text-tertiary); }
        .lc__price {
          margin-top: auto; padding-top: var(--space-3);
          display: flex; align-items: baseline; gap: 0.35rem; flex-wrap: wrap;
        }
        .lc__price strong { font-size: var(--text-lg); font-weight: 650; letter-spacing: -0.02em; }
        .lc__priceNote { font-size: var(--text-xs); color: var(--text-secondary); }
      `}</style>
    </article>
  );
}

function Star() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M8 1.6l1.85 3.9 4.15.6-3 3 .71 4.3L8 11.4l-3.71 2 .71-4.3-3-3 4.15-.6z" />
    </svg>
  );
}
