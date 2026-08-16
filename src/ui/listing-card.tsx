import Link from 'next/link';
import { Badge, Money, PROPERTY_TYPE_LABEL, formatNights, plural } from './primitives.tsx';

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

export function ListingCard({ listing, nights }: { listing: ListingCardData; nights?: number }) {
  const cover = listing.photos.find((p) => p.isCover) ?? listing.photos[0];
  const isCompany = listing.owner.accountKind === 'COMPANY';

  return (
    <article className="card listing-card">
      <Link href={`/listing/${listing.id}`} className="stack" style={{ height: '100%' }}>
        <div className="listing-card__media">
          {cover ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/media/${cover.storageKey}`}
              alt=""
              loading="lazy"
              decoding="async"
              width={400}
              height={300}
            />
          ) : (
            <div className="listing-card__placeholder" aria-hidden="true" />
          )}

          <div className="listing-card__tags">
            {listing.propertyVerified && <Badge tone="verified">Проверено</Badge>}
            {listing.bookingMode !== 'REQUEST' && <Badge tone="primary">Мгновенно</Badge>}
          </div>
        </div>

        <div className="stack" style={{ gap: '0.375rem', padding: '0.875rem' }}>
          <div className="row" style={{ gap: '0.5rem', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-subtle)' }}>
              {PROPERTY_TYPE_LABEL[listing.propertyType] ?? listing.propertyType}
              {listing.district ? ` · ${listing.district}` : ` · ${listing.city}`}
            </span>
            {listing.rating !== null && (
              <span className="numeric" style={{ fontSize: 'var(--text-xs)', fontWeight: 600 }}>
                ★ {listing.rating.toFixed(1)}
                <span style={{ color: 'var(--fg-subtle)', fontWeight: 400 }}> ({listing.reviewCount})</span>
              </span>
            )}
          </div>

          <h3 className="clamp-2" style={{ fontSize: 'var(--text-base)', fontWeight: 600 }}>
            {listing.title}
          </h3>

          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-muted)' }}>
            {[
              listing.rooms !== null && `${listing.rooms} ${plural(listing.rooms, 'комната', 'комнаты', 'комнат')}`,
              listing.areaSqm && `${Math.round(Number(listing.areaSqm))} м²`,
              listing.floor !== null &&
                listing.totalFloors !== null &&
                `${listing.floor}/${listing.totalFloors} этаж`,
              `до ${listing.maxGuests} ${plural(listing.maxGuests, 'гостя', 'гостей', 'гостей')}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>

          <div className="row" style={{ gap: '0.375rem', marginTop: 'auto', paddingTop: '0.375rem' }}>
            {/* When dates are chosen the card shows the REAL total for those
                dates, not a headline nightly rate the tenant will never pay. */}
            {listing.stayTotalMinor ? (
              <span className="stack" style={{ gap: 0 }}>
                <strong style={{ fontSize: 'var(--text-lg)' }}>
                  <Money minor={listing.stayTotalMinor} />
                </strong>
                <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--fg-subtle)' }}>
                  всего{nights ? ` за ${formatNights(nights)}` : ''}, включая обязательные сборы
                </span>
              </span>
            ) : (
              <span className="stack" style={{ gap: 0 }}>
                <strong style={{ fontSize: 'var(--text-lg)' }}>
                  <Money minor={listing.basePriceMinor} />
                </strong>
                <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--fg-subtle)' }}>
                  {listing.priceUnit === 'MONTH' ? 'в месяц' : 'за ночь'}
                </span>
              </span>
            )}

            {listing.distanceMeters !== undefined && (
              <span
                className="numeric"
                style={{ marginLeft: 'auto', fontSize: 'var(--text-xs)', color: 'var(--fg-subtle)' }}
              >
                {listing.distanceMeters < 1000
                  ? `${listing.distanceMeters} м`
                  : `${(listing.distanceMeters / 1000).toFixed(1)} км`}
              </span>
            )}
          </div>

          <p style={{ fontSize: 'var(--text-2xs)', color: 'var(--fg-subtle)' }}>
            {isCompany ? 'Компания' : 'Частный хозяин'} · {listing.owner.displayName}
            {listing.owner.verificationLevel >= 1 && ' · личность подтверждена'}
          </p>
        </div>
      </Link>

      <style>{`
        .listing-card { overflow: hidden; transition: box-shadow 140ms ease; }
        .listing-card:hover { box-shadow: var(--shadow-raised); }
        .listing-card__media { position: relative; aspect-ratio: 4 / 3; background: var(--bg-sunken); }
        .listing-card__media img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .listing-card__placeholder {
          width: 100%; height: 100%;
          background:
            repeating-linear-gradient(45deg, var(--bg-sunken) 0 12px, var(--border) 12px 24px);
          opacity: 0.55;
        }
        .listing-card__tags {
          position: absolute; left: 0.625rem; top: 0.625rem;
          display: flex; gap: 0.375rem; flex-wrap: wrap;
        }
      `}</style>
    </article>
  );
}
