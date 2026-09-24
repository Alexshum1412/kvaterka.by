'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from '@/i18n/navigation.ts';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError } from '@/lib/api-client.ts';
import {
  Icon,
  AMENITY_CATEGORY,
  amenityCategoryLabel,
  amenityIcon,
  amenityName,
  type IconName,
} from '@/ui/icons.tsx';
import { LocationPicker } from '@/ui/location-picker.tsx';
import { formatNightsGenitiveLocalized } from '@/ui/primitives.tsx';
import {
  MODERATION_REASON_TEXT,
  firstStepForReasons,
  type ModerationReasonCode,
} from '@/server/domain/moderation.ts';
import type { AmenityOption } from '@/ui/search-filters.tsx';
import type { AppLocale } from '@/i18n/routing.ts';
import { currencySymbol } from '@/server/domain/money.ts';

/**
 * The listing wizard.
 *
 * Two design commitments run through it.
 *
 * NOTHING IS EVER LOST. The property row is created as soon as the first
 * question is answered (migration 0008 made a draft legal in the
 * database), and every change after that is a debounced PATCH to the
 * real listing. There is no localStorage copy and no client-only state
 * that matters — closing the tab loses at most the last second of typing.
 *
 * NOTHING IS ASKED TWICE, OR TOO EARLY. One question per screen, in the
 * order a landlord actually thinks about their flat, with the price
 * arriving long after the photographs. Validation is per-step and
 * phrased as an instruction, never as a complaint.
 */

/* ------------------------------------------------------------------ */

/** A plain call signature is enough for every `t()` call this file makes —
 * the real translator carries more (`.rich`, `.raw`…), and a variable with
 * extra members is assignable wherever only the call signature is used. */
type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * Every other server-side refusal in this wizard is shown verbatim via
 * `e.message` — that text is already "safe to show" Russian (errors.ts).
 * This one refusal (DEC-076) gets a translated message instead, keyed off
 * the stable `details.reason` it carries, so a be/en landlord reads it in
 * their own language rather than only in Russian like every other
 * server-side validation string in this file still does.
 */
function isPhoneCountryMismatch(e: unknown): boolean {
  return (
    e instanceof ApiError &&
    (e.details as { reason?: string } | undefined)?.reason === 'PHONE_COUNTRY_MISMATCH'
  );
}

/** Non-text metadata for property types — labels come from ListingWizard.propertyTypes.* via t(). */
const PROPERTY_TYPE_META: { value: string; icon: IconName }[] = [
  { value: 'APARTMENT', icon: 'home' },
  { value: 'ROOM', icon: 'door' },
  { value: 'STUDIO', icon: 'rooms' },
  { value: 'HOUSE', icon: 'home' },
  { value: 'COTTAGE', icon: 'home' },
  { value: 'TOWNHOUSE', icon: 'floors' },
];

/**
 * City centres, so a landlord gets a sensible point without a geocoder.
 *
 * `name` stays the Russian city name in every locale — it is the exact
 * string stored on the listing and matched by search-service.ts against
 * `p.city` (`lower(p.city) = lower(...)`). Only the visible option label,
 * looked up by `key` via ListingWizard.cities.*, is localized.
 */
const CITIES: { name: string; key: string; latitude: number; longitude: number }[] = [
  { name: 'Минск', key: 'minsk', latitude: 53.9023, longitude: 27.5619 },
  { name: 'Гомель', key: 'gomel', latitude: 52.4242, longitude: 31.0141 },
  { name: 'Могилёв', key: 'mogilev', latitude: 53.9006, longitude: 30.3313 },
  { name: 'Витебск', key: 'vitebsk', latitude: 55.1848, longitude: 30.2016 },
  { name: 'Гродно', key: 'grodno', latitude: 53.6694, longitude: 23.8131 },
  { name: 'Брест', key: 'brest', latitude: 52.0976, longitude: 23.7341 },
  { name: 'Бобруйск', key: 'bobruisk', latitude: 53.1384, longitude: 29.2214 },
  { name: 'Барановичи', key: 'baranovichi', latitude: 53.1327, longitude: 26.0139 },
  { name: 'Борисов', key: 'borisov', latitude: 54.2278, longitude: 28.5053 },
  { name: 'Пинск', key: 'pinsk', latitude: 52.1229, longitude: 26.0951 },
  { name: 'Орша', key: 'orsha', latitude: 54.5081, longitude: 30.4172 },
  { name: 'Мозырь', key: 'mozyr', latitude: 52.0495, longitude: 29.2456 },
  { name: 'Солигорск', key: 'soligorsk', latitude: 52.7876, longitude: 27.5416 },
  { name: 'Новополоцк', key: 'novopolotsk', latitude: 55.5322, longitude: 28.65 },
  { name: 'Лида', key: 'lida', latitude: 53.8886, longitude: 25.2994 },
  { name: 'Молодечно', key: 'molodechno', latitude: 54.3167, longitude: 26.85 },
];

const SMOKING_CODES = ['PROHIBITED', 'BALCONY_ONLY', 'ALLOWED'] as const;
const PETS_CODES = ['PROHIBITED', 'ON_REQUEST', 'SMALL_ONLY', 'ALLOWED'] as const;

/** Lengths a landlord actually thinks in, expressed in nights. Display text
 * (always the genitive-plural noun, e.g. "ночей") comes from
 * ListingWizard.durationUnits.* via t(). */
const DURATION_UNITS: { code: 'NIGHT' | 'WEEK' | 'MONTH' | 'YEAR'; nights: number }[] = [
  { code: 'NIGHT', nights: 1 },
  { code: 'WEEK', nights: 7 },
  { code: 'MONTH', nights: 30 },
  { code: 'YEAR', nights: 365 },
];

const BOOKING_MODE_CODES = ['REQUEST', 'INSTANT', 'INSTANT_AND_REQUEST'] as const;
const UTILITIES_CODES = ['INCLUDED', 'FIXED_EXTRA', 'VARIABLE_METERED'] as const;

/* ------------------------------------------------------------------ */

export interface WizardListing {
  id: string;
  status: string;
  rejectionReason: string | null;
  [key: string]: unknown;
}

type Draft = Record<string, any>;

/** Mirrors `GeocodeResult` from `src/app/api/geocode/route.ts` — kept as a
 *  separate local shape rather than an import so this client component never
 *  pulls in a Next.js route module (which assumes a server runtime). */
interface GeocodeResult {
  latitude: number;
  longitude: number;
  displayName: string;
}

interface Photo {
  id: string;
  storageKey: string;
  isCover: boolean;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const STEP_KEYS = [
  'type',
  'location',
  'photos',
  'details',
  'amenities',
  'rules',
  'duration',
  'price',
  'preview',
] as const;

export function ListingWizard({
  listing,
  amenities,
}: {
  listing: WizardListing | null;
  amenities: readonly AmenityOption[];
}) {
  const router = useRouter();
  const t = useTranslations('ListingWizard');
  const locale = useLocale() as AppLocale;
  const STEPS = useMemo(() => STEP_KEYS.map((key) => t(`steps.${key}`)), [t]);
  const SMOKING = useMemo(
    () => SMOKING_CODES.map((code) => ({ value: code, label: t(`smoking.${code}`) })),
    [t],
  );
  const PETS = useMemo(() => PETS_CODES.map((code) => ({ value: code, label: t(`pets.${code}`) })), [t]);
  const BOOKING_MODES = useMemo(
    () =>
      BOOKING_MODE_CODES.map((code) => ({
        value: code,
        label: t(`bookingModes.${code}.label`),
        hint: t(`bookingModes.${code}.hint`),
      })),
    [t],
  );
  const UTILITIES = useMemo(
    () => UTILITIES_CODES.map((code) => ({ value: code, label: t(`utilities.${code}`) })),
    [t],
  );
  const [id, setId] = useState<string | null>(listing?.id ?? null);
  const [draft, setDraft] = useState<Draft>(() => ({ ...(listing ?? {}) }));
  const [photos, setPhotos] = useState<Photo[]>(() =>
    ((listing?.photos as Photo[] | undefined) ?? []).map((p) => ({ ...p })),
  );
  const [step, setStep] = useState(() => {
    if (!listing) return 0;
    // A rejected listing opens on the step the moderator objected to, so
    // the landlord never has to hunt for what to change.
    const codes = (listing.rejectionCodes as string[] | undefined) ?? [];
    if (listing.status === 'REJECTED' && codes.length > 0) return firstStepForReasons(codes);
    return firstIncompleteStep(listing);
  });
  // Which way the step content should slide in from — read by
  // `.wz__section`'s `@starting-style` rule below.
  const [direction, setDirection] = useState<'forward' | 'back'>('forward');
  const [noticeOpen, setNoticeOpen] = useState(listing?.status === 'REJECTED');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const pending = useRef<Draft>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* --- persistence ------------------------------------------------- */

  const flush = useCallback(async () => {
    if (!id) return;
    const payload = pending.current;
    pending.current = {};
    if (Object.keys(payload).length === 0) return;

    setSaveState('saving');
    try {
      await api.patch(`/listings/${id}`, payload);
      setSaveState('saved');
    } catch (e) {
      // The edit stays in `pending` conceptually — it is still in `draft`,
      // so a later save carries it. The landlord is told, not ignored.
      setSaveState('error');
      setError(e instanceof ApiError ? e.message : t('errors.saveFailed'));
    }
  }, [id, t]);

  const patch = useCallback(
    (changes: Draft) => {
      setDraft((d) => ({ ...d, ...changes }));
      pending.current = { ...pending.current, ...changes };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), 800);
    },
    [flush],
  );

  // A landlord who closes the tab mid-sentence keeps the sentence.
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  /* --- geocoding (step 1's "Найти на карте") ------------------------ */

  // idle: nothing tried yet. loading: request in flight. found/empty/error
  // are the three ways it can settle — `found` is the only one that ever
  // moves the pin; the other two just explain, briefly, why nothing moved.
  const [geoStatus, setGeoStatus] = useState<'idle' | 'loading' | 'found' | 'empty' | 'error'>('idle');
  const [geoPlace, setGeoPlace] = useState<string | null>(null);

  /**
   * Geocoding only ever SETS A STARTING POINT for the pin — it never runs on
   * its own (no per-keystroke or debounced auto-search: this is the button's
   * click handler and nothing else calls it), and every outcome besides an
   * actual match falls back silently to the manual drag-and-drop flow that
   * already works end to end, because a listing needs SOME coordinate to
   * leave DRAFT regardless of how it got there.
   */
  async function findOnMap() {
    const city = String(draft.city ?? '').trim();
    if (!city) return;
    const street = [draft.street, draft.houseNumber].filter(Boolean).join(' ').trim();
    const district = String(draft.district ?? '').trim();
    const query = [street, district, city, 'Беларусь'].filter(Boolean).join(', ');

    setGeoStatus('loading');
    setGeoPlace(null);
    try {
      const { result } = await api.get<{ result: GeocodeResult | null }>(
        `/geocode?q=${encodeURIComponent(query)}`,
      );
      if (result) {
        // Still fully draggable afterward — this only pre-fills `onChange`'s
        // usual target, the same patch a manual drag already sends.
        patch({ latitude: result.latitude, longitude: result.longitude });
        setGeoPlace(result.displayName);
        setGeoStatus('found');
      } else {
        setGeoStatus('empty');
      }
    } catch {
      // Not signed in (should not happen this deep in the wizard), the query
      // was rejected, or something upstream broke in a way the route itself
      // could not already normalise to "nothing found". Either way: same
      // fallback message as `empty`, never a blocking error.
      setGeoStatus('error');
    }
  }

  /** Creates the row on the first answer, so everything after it autosaves. */
  async function start(propertyType: string) {
    setError(null);
    setSaveState('saving');
    try {
      const created = await api.post<{ id: string }>('/listings', { propertyType });
      setId(created.id);
      setDraft((d) => ({ ...d, propertyType }));
      setSaveState('saved');
      // Replace so "back" does not return to an empty wizard that would
      // create a second draft.
      window.history.replaceState(null, '', `/dashboard/listings/${created.id}/edit`);
      setDirection('forward');
      setStep(1);
    } catch (e) {
      setSaveState('error');
      setError(
        isPhoneCountryMismatch(e)
          ? t('errors.phoneCountryMismatch')
          : e instanceof ApiError
            ? e.message
            : t('errors.draftFailed'),
      );
    }
  }

  async function go(next: number) {
    const problem = validate(step, draft, photos, t);
    if (problem && next > step) {
      setError(problem);
      return;
    }
    setError(null);
    await flush();
    const clamped = Math.max(0, Math.min(STEPS.length - 1, next));
    setDirection(clamped >= step ? 'forward' : 'back');
    setStep(clamped);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function saveAndExit() {
    await flush();
    router.push('/dashboard');
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    await flush();
    try {
      await api.post(`/listings/${id}/submit`, {});
      router.push('/dashboard?submitted=1');
    } catch (e) {
      setError(
        isPhoneCountryMismatch(e)
          ? t('errors.phoneCountryMismatch')
          : e instanceof ApiError
            ? e.message
            : t('errors.submitFailed'),
      );
      setSubmitting(false);
    }
  }

  /* --- photos ------------------------------------------------------ */

  async function upload(files: FileList | null) {
    if (!files || !id) return;
    setError(null);
    for (const file of Array.from(files).slice(0, 30)) {
      const body = new FormData();
      body.set('propertyId', id);
      body.set('file', file);
      try {
        const response = await fetch('/api/uploads', { method: 'POST', body, credentials: 'same-origin' });
        const payload = await response.json();
        if (!response.ok) {
          setError(payload?.error?.message ?? t('errors.photoUploadFailed'));
          continue;
        }
        setPhotos((list) => [
          ...list,
          { id: payload.id, storageKey: payload.storageKey, isCover: list.length === 0 },
        ]);
      } catch {
        setError(t('errors.photoUploadFailed'));
      }
    }
  }

  async function removePhoto(photoId: string) {
    try {
      await api.delete(`/listings/${id}/photos/${photoId}`);
      setPhotos((list) => {
        const rest = list.filter((p) => p.id !== photoId);
        // The domain promotes the next photo; mirror that so the badge is
        // not briefly wrong.
        if (rest.length > 0 && !rest.some((p) => p.isCover)) rest[0] = { ...rest[0]!, isCover: true };
        return rest;
      });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('errors.photoRemoveFailed'));
    }
  }

  async function makeCover(photoId: string) {
    try {
      await api.post(`/listings/${id}/photos/${photoId}/cover`, {});
      setPhotos((list) => list.map((p) => ({ ...p, isCover: p.id === photoId })));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('errors.photoCoverFailed'));
    }
  }

  /* --- render ------------------------------------------------------ */

  const groupedAmenities = useMemo(() => groupAmenities(amenities, locale), [amenities, locale]);
  const chosen: string[] = draft.amenities ?? [];
  const progress = Math.round(((step + 1) / STEPS.length) * 100);

  return (
    <div className="wz">
      <header className="wz__top">
        <div className="wz__topRow">
          {/* Saves before leaving, so this is a safe exit at every width —
              the bottom bar drops its own translated exit label on a phone. */}
          <button type="button" className="wz__back" onClick={() => void saveAndExit()}>
            <Icon name="arrowLeft" size={16} />
            {t('saveAndExit')}
          </button>
          <SaveBadge state={saveState} />
        </div>
        <div
          className="wz__progress"
          role="progressbar"
          aria-valuenow={step + 1}
          aria-valuemin={1}
          aria-valuemax={STEPS.length}
          aria-label={t('stepAriaLabel', { step: step + 1, total: STEPS.length })}
        >
          <span className="wz__progressFill" style={{ width: `${progress}%` }} />
        </div>
        <p className="wz__stepLabel">
          {t('stepLabel', { step: step + 1, total: STEPS.length, name: STEPS[step] ?? '' })}
        </p>
      </header>

      <main className="wz__body" data-dir={direction}>
        {noticeOpen && (
          <aside className="wz__rejected" role="status">
            <div className="wz__rejectedHead">
              <Icon name="alert" size={18} />
              <strong>{t('rejected.heading')}</strong>
              <button
                type="button"
                className="wz__rejectedClose"
                onClick={() => setNoticeOpen(false)}
                aria-label={t('rejected.hideAria')}
              >
                <Icon name="close" size={15} />
              </button>
            </div>
            <ul className="wz__rejectedList">
              {((draft.rejectionCodes as string[] | undefined) ?? []).map((code) => (
                <li key={code}>
                  {MODERATION_REASON_TEXT[code as ModerationReasonCode] ?? code}
                  <button
                    type="button"
                    className="link wz__jump"
                    onClick={() => void go(firstStepForReasons([code]))}
                  >
                    {t('rejected.jumpToStep')}
                  </button>
                </li>
              ))}
            </ul>
            {typeof draft.moderatorComment === 'string' && draft.moderatorComment && (
              <p className="wz__rejectedComment">
                {t('rejected.comment', { comment: draft.moderatorComment })}
              </p>
            )}
            <p className="hint">{t('rejected.footer')}</p>
          </aside>
        )}

        {step === 0 && (
          <Step title={t('step0.title')} lead={t('step0.lead')}>
            <div className="wz__cards">
              {PROPERTY_TYPE_META.map((pt) => (
                <button
                  key={pt.value}
                  type="button"
                  className="wz__card"
                  aria-pressed={draft.propertyType === pt.value}
                  onClick={() => (id ? patch({ propertyType: pt.value }) : void start(pt.value))}
                >
                  <Icon name={pt.icon} size={22} />
                  <span className="wz__cardLabel">{t(`propertyTypes.${pt.value}.label`)}</span>
                  <span className="wz__cardHint">{t(`propertyTypes.${pt.value}.hint`)}</span>
                </button>
              ))}
            </div>
            {id && draft.propertyType && <p className="hint">{t('step0.draftSaved')}</p>}
          </Step>
        )}

        {step === 1 && (
          <Step title={t('step1.title')} lead={t('step1.lead')}>
            <Field label={t('step1.cityLabel')} hint={t('step1.cityHint')}>
              <input
                className="input"
                list="wz-cities"
                value={draft.city ?? ''}
                onChange={(e) => {
                  const value = e.target.value;
                  // Typing (or picking a suggestion for) one of the known
                  // centres still pre-fills its point; anything else is a
                  // real city this list doesn't have — its coordinates stay
                  // unset rather than keeping a stale point from whatever was
                  // selected before, which is exactly what `step1.approxPoint`
                  // below is conditioned on.
                  const city = CITIES.find((c) => c.name === value);
                  patch(
                    city
                      ? { city: city.name, latitude: city.latitude, longitude: city.longitude }
                      : { city: value, latitude: null, longitude: null },
                  );
                }}
                placeholder={t('step1.cityPlaceholder')}
              />
              <datalist id="wz-cities">
                {CITIES.map((c) => (
                  <option key={c.name} value={c.name} label={t(`cities.${c.key}`)} />
                ))}
              </datalist>
            </Field>

            {draft.city && (
              <Field label={t('step1.pinLabel')} hint={t('step1.pinHint')}>
                <div className="wz__geoRow">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => void findOnMap()}
                    disabled={geoStatus === 'loading'}
                  >
                    <Icon name="search" size={14} />
                    {geoStatus === 'loading' ? t('step1.findOnMapBusy') : t('step1.findOnMapButton')}
                  </button>
                  <span className="hint">{t('step1.findOnMapHint')}</span>
                </div>
                {geoStatus === 'found' && (
                  <p className="wz__geoNote wz__geoNote--ok">
                    <Icon name="pin" size={14} />
                    {t('step1.findOnMapSuccess', { place: geoPlace ?? '' })}
                  </p>
                )}
                {geoStatus === 'empty' && <p className="wz__geoNote">{t('step1.findOnMapEmpty')}</p>}
                {geoStatus === 'error' && <p className="wz__geoNote">{t('step1.findOnMapError')}</p>}
                <LocationPicker
                  latitude={draft.latitude ?? null}
                  longitude={draft.longitude ?? null}
                  onChange={(latitude, longitude) => patch({ latitude, longitude })}
                  ariaLabel={t('step1.pinLabel')}
                />
              </Field>
            )}

            <Field label={t('step1.districtLabel')} hint={t('step1.districtHint')}>
              <input
                className="input"
                value={draft.district ?? ''}
                onChange={(e) => patch({ district: e.target.value })}
                placeholder={t('step1.districtPlaceholder')}
              />
            </Field>

            <details className="wz__details">
              <summary>{t('step1.exactAddressSummary')}</summary>
              <div className="wz__detailsBody">
                <p className="hint">{t('step1.exactAddressHint')}</p>
                <div className="wz__pair">
                  <Field label={t('step1.streetLabel')}>
                    <input
                      className="input"
                      value={draft.street ?? ''}
                      onChange={(e) => patch({ street: e.target.value })}
                    />
                  </Field>
                  <Field label={t('step1.houseLabel')}>
                    <input
                      className="input"
                      value={draft.houseNumber ?? ''}
                      onChange={(e) => patch({ houseNumber: e.target.value })}
                    />
                  </Field>
                </div>
                <Field label={t('step1.apartmentLabel')} hint={t('step1.apartmentHint')}>
                  <input
                    className="input"
                    value={draft.apartmentNumber ?? ''}
                    onChange={(e) => patch({ apartmentNumber: e.target.value })}
                  />
                </Field>
              </div>
            </details>

            {draft.latitude != null && (
              <p className="wz__note">
                <Icon name="pin" size={16} />
                {t('step1.approxPoint', {
                  lat: Number(draft.latitude).toFixed(3),
                  lng: Number(draft.longitude).toFixed(3),
                })}
              </p>
            )}
          </Step>
        )}

        {step === 2 && (
          <Step title={t('step2.title')} lead={t('step2.lead')}>
            <label className="wz__drop">
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                className="sr-only"
                onChange={(e) => void upload(e.target.files)}
              />
              <Icon name="image" size={26} />
              <span className="wz__dropTitle">{t('step2.dropTitle')}</span>
              <span className="wz__dropHint">{t('step2.dropHint')}</span>
            </label>

            {photos.length > 0 && (
              <ul className="wz__photos">
                {photos.map((p, index) => (
                  <li key={p.id} className="wz__photo">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/media/${p.storageKey}`}
                      alt={t('step2.photoAlt', { index: index + 1, count: photos.length })}
                      loading="lazy"
                    />
                    {p.isCover && <span className="wz__cover">{t('step2.cover')}</span>}
                    <div className="wz__photoActions">
                      {!p.isCover && (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => void makeCover(p.id)}
                        >
                          {t('step2.makeCover')}
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => void removePhoto(p.id)}
                        aria-label={t('step2.removeAria')}
                      >
                        <Icon name="close" size={15} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="hint">
              {photos.length === 0 ? t('step2.needOne') : t('step2.count', { count: photos.length })}
            </p>
          </Step>
        )}

        {step === 3 && (
          <Step title={t('step3.title')} lead={t('step3.lead')}>
            <Field label={t('step3.titleLabel')} hint={t('step3.titleHint')}>
              <input
                className="input"
                value={draft.title ?? ''}
                maxLength={120}
                onChange={(e) => patch({ title: e.target.value })}
                placeholder={t('step3.titlePlaceholder')}
              />
            </Field>

            <div className="wz__grid">
              <Field label={t('step3.roomsLabel')}>
                <NumberInput value={draft.rooms} min={0} max={30} onChange={(v) => patch({ rooms: v })} />
              </Field>
              <Field label={t('step3.areaLabel')}>
                <NumberInput
                  value={draft.areaSqm}
                  min={1}
                  max={9999}
                  onChange={(v) => patch({ areaSqm: v })}
                />
              </Field>
              <Field label={t('step3.floorLabel')}>
                <NumberInput value={draft.floor} min={-5} max={200} onChange={(v) => patch({ floor: v })} />
              </Field>
              <Field label={t('step3.totalFloorsLabel')}>
                <NumberInput
                  value={draft.totalFloors}
                  min={1}
                  max={200}
                  onChange={(v) => patch({ totalFloors: v })}
                />
              </Field>
              <Field label={t('step3.bedsLabel')}>
                <NumberInput value={draft.beds} min={0} max={50} onChange={(v) => patch({ beds: v })} />
              </Field>
              <Field label={t('step3.bathroomsLabel')}>
                <NumberInput
                  value={draft.bathrooms}
                  min={0}
                  max={20}
                  onChange={(v) => patch({ bathrooms: v })}
                />
              </Field>
              <Field label={t('step3.maxGuestsLabel')}>
                <NumberInput
                  value={draft.maxGuests}
                  min={1}
                  max={50}
                  onChange={(v) => patch({ maxGuests: v })}
                />
              </Field>
            </div>

            <Field label={t('step3.descriptionLabel')} hint={t('step3.descriptionHint')}>
              <textarea
                className="textarea"
                rows={7}
                maxLength={6000}
                value={draft.description ?? ''}
                onChange={(e) => patch({ description: e.target.value })}
              />
            </Field>
          </Step>
        )}

        {step === 4 && (
          <Step title={t('step4.title')} lead={t('step4.lead')}>
            {groupedAmenities.map((group) => (
              <fieldset key={group.category} className="wz__set">
                <legend className="wz__legend">{group.label}</legend>
                <div className="wz__chips">
                  {group.items.map((a) => {
                    const on = chosen.includes(a.code);
                    return (
                      <button
                        key={a.code}
                        type="button"
                        className="chip chip-sm"
                        aria-pressed={on}
                        onClick={() =>
                          patch({
                            amenities: on ? chosen.filter((c) => c !== a.code) : [...chosen, a.code],
                          })
                        }
                      >
                        <Icon name={amenityIcon(a.icon)} size={15} />
                        {amenityName(a, locale)}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            ))}
          </Step>
        )}

        {step === 5 && (
          <Step title={t('step5.title')} lead={t('step5.lead')}>
            <Choice
              label={t('step5.smokingLabel')}
              options={SMOKING}
              value={draft.smokingPolicy ?? 'PROHIBITED'}
              onChange={(v) => patch({ smokingPolicy: v })}
            />
            <Choice
              label={t('step5.petsLabel')}
              options={PETS}
              value={draft.petsPolicy ?? 'PROHIBITED'}
              onChange={(v) => patch({ petsPolicy: v })}
            />
            <Choice
              label={t('step5.childrenLabel')}
              options={[
                { value: 'yes', label: t('step5.childrenYes') },
                { value: 'no', label: t('step5.childrenNo') },
              ]}
              value={draft.childrenAllowed === false ? 'no' : 'yes'}
              onChange={(v) => patch({ childrenAllowed: v === 'yes' })}
            />
            <Choice
              label={t('step5.partiesLabel')}
              options={[
                { value: 'no', label: t('step5.partiesNo') },
                { value: 'yes', label: t('step5.partiesYes') },
              ]}
              value={draft.partiesAllowed ? 'yes' : 'no'}
              onChange={(v) => patch({ partiesAllowed: v === 'yes' })}
            />

            <div className="wz__pair">
              <Field label={t('step5.checkInLabel')}>
                <input
                  type="time"
                  className="input"
                  value={timeValue(draft.checkInFrom, '14:00')}
                  onChange={(e) => patch({ checkInFrom: e.target.value })}
                />
              </Field>
              <Field label={t('step5.checkOutLabel')}>
                <input
                  type="time"
                  className="input"
                  value={timeValue(draft.checkOutUntil, '12:00')}
                  onChange={(e) => patch({ checkOutUntil: e.target.value })}
                />
              </Field>
            </div>

            <div className="wz__pair">
              <Field label={t('step5.quietFromLabel')} hint={t('step5.quietFromHint')}>
                <input
                  type="time"
                  className="input"
                  value={timeValue(draft.quietHoursFrom, '')}
                  onChange={(e) => patch({ quietHoursFrom: e.target.value || undefined })}
                />
              </Field>
              <Field label={t('step5.quietToLabel')}>
                <input
                  type="time"
                  className="input"
                  value={timeValue(draft.quietHoursTo, '')}
                  onChange={(e) => patch({ quietHoursTo: e.target.value || undefined })}
                />
              </Field>
            </div>
          </Step>
        )}

        {step === 6 && (
          <DurationStep
            minNights={Number(draft.minNights ?? 1)}
            maxNights={Number(draft.maxNights ?? 365)}
            onChange={(min, max) => patch({ minNights: min, maxNights: max })}
          />
        )}

        {step === 7 && (
          <Step title={t('step7.title')} lead={t('step7.lead')}>
            <Choice
              label={t('step7.priceModeLabel')}
              options={[
                { value: 'NIGHT', label: t('step7.priceModeNight') },
                { value: 'MONTH', label: t('step7.priceModeMonth') },
              ]}
              value={draft.priceUnit ?? 'NIGHT'}
              onChange={(v) => patch({ priceUnit: v })}
            />

            <Field
              label={draft.priceUnit === 'MONTH' ? t('step7.priceLabelMonth') : t('step7.priceLabelNight')}
              hint={t('step7.priceHint')}
            >
              <MoneyInput value={draft.basePriceMinor} onChange={(v) => patch({ basePriceMinor: v })} />
            </Field>

            <Field label={t('step7.cleaningLabel')} hint={t('step7.cleaningHint')}>
              <MoneyInput value={draft.cleaningFeeMinor} onChange={(v) => patch({ cleaningFeeMinor: v })} />
            </Field>

            <Choice
              label={t('step7.utilitiesLabel')}
              options={UTILITIES}
              value={draft.utilitiesMode ?? 'INCLUDED'}
              onChange={(v) => patch({ utilitiesMode: v })}
            />
            {draft.utilitiesMode === 'FIXED_EXTRA' && (
              <Field label={t('step7.utilitiesExtraLabel')}>
                <MoneyInput
                  value={draft.utilitiesFixedMinor}
                  onChange={(v) => patch({ utilitiesFixedMinor: v })}
                />
              </Field>
            )}
            {draft.utilitiesMode === 'VARIABLE_METERED' && (
              <p className="hint">{t('step7.utilitiesMeteredHint')}</p>
            )}

            <Field label={t('step7.depositLabel')} hint={t('step7.depositHint')}>
              <MoneyInput value={draft.depositMinor} onChange={(v) => patch({ depositMinor: v })} />
            </Field>

            <Choice
              label={t('step7.bookingModeLabel')}
              options={BOOKING_MODES}
              value={draft.bookingMode ?? 'REQUEST'}
              onChange={(v) => patch({ bookingMode: v })}
            />

            <label className="wz__toggle">
              <input
                type="checkbox"
                checked={Boolean(draft.negotiationEnabled)}
                onChange={(e) => patch({ negotiationEnabled: e.target.checked })}
              />
              <span>
                <strong>{t('step7.negotiationTitle')}</strong>
                <span className="hint">{t('step7.negotiationHint')}</span>
              </span>
            </label>
          </Step>
        )}

        {step === 8 && (
          <Step title={t('step8.title')} lead={t('step8.lead')}>
            <PreviewSummary draft={draft} photos={photos} amenities={amenities} onEdit={(s) => void go(s)} />

            <div className="wz__submit">
              <p className="hint">{t('step8.submitHint')}</p>
              <button
                type="button"
                className="btn btn-primary btn-lg btn-block"
                disabled={submitting || !id}
                onClick={() => void submit()}
              >
                {submitting ? t('step8.submitting') : t('step8.submit')}
              </button>
            </div>
          </Step>
        )}

        {error && (
          <p className="wz__error error-text" role="alert">
            <Icon name="alert" size={16} />
            {error}
          </p>
        )}
      </main>

      <nav className="wz__nav" aria-label={t('navAriaLabel')}>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void go(step - 1)}
          disabled={step === 0}
        >
          {t('back')}
        </button>
        <button
          type="button"
          className="btn btn-secondary wz__exit"
          onClick={() => void saveAndExit()}
          disabled={!id}
        >
          {t('saveAndExit')}
        </button>
        {step < STEPS.length - 1 && (
          <button type="button" className="btn btn-primary" onClick={() => void go(step + 1)} disabled={!id}>
            {t('next')}
          </button>
        )}
      </nav>

      <style>{`
        .wz { max-width: 46rem; margin-inline: auto; padding: var(--space-4) 1rem 7rem; }
        .wz__top { position: sticky; top: var(--header-height); z-index: 20; background: var(--background); padding-block: var(--space-3); }
        .wz__topRow { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
        .wz__back { display: inline-flex; align-items: center; gap: 0.35rem; min-height: 2.75rem; padding: 0; background: none; border: 0; cursor: pointer; font: inherit; font-size: var(--text-sm); color: var(--text-secondary); }
        .wz__back:hover { color: var(--text-primary); }
        .wz__progress { height: 4px; border-radius: var(--radius-full); background: var(--surface-sunken); overflow: hidden; margin-top: var(--space-3); }
        .wz__progressFill { display: block; height: 100%; background: var(--primary); border-radius: inherit; transition: width 240ms ease; }
        .wz__stepLabel { margin-top: var(--space-2); font-size: var(--text-xs); color: var(--text-tertiary); }

        .wz__body { display: grid; gap: var(--space-5); padding-top: var(--space-4); }
        .wz__head { display: grid; gap: var(--space-2); }
        .wz__title { font-size: var(--text-2xl); font-weight: 650; letter-spacing: -0.022em; }
        .wz__lead { color: var(--text-secondary); font-size: var(--text-sm); max-width: 54ch; line-height: 1.6; }

        /* One step is mounted at a time ({step === N && <Step/>}), so each
           step change is a genuine new element — @starting-style bridges
           the hard cut with a short slide, direction set by .wz__body's
           data-dir (see the direction state and go() above). */
        .wz__section {
          display: grid; gap: var(--space-4);
          transition: opacity 200ms cubic-bezier(0.23, 1, 0.32, 1), transform 200ms cubic-bezier(0.23, 1, 0.32, 1);
        }
        @starting-style {
          .wz__body[data-dir='forward'] .wz__section { opacity: 0; transform: translateX(8px); }
          .wz__body[data-dir='back'] .wz__section { opacity: 0; transform: translateX(-8px); }
        }

        .wz__cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: var(--space-3); }
        .wz__card {
          display: grid; gap: 0.2rem; justify-items: start; text-align: left;
          padding: var(--space-4);
          background: var(--surface); color: var(--text-primary);
          border: 1px solid var(--border-strong); border-radius: var(--radius-md);
          font: inherit; cursor: pointer;
          transition: border-color 140ms ease, background-color 140ms ease;
        }
        .wz__card:hover { border-color: var(--border-control); }
        .wz__card[aria-pressed='true'] { border-color: var(--primary); background: var(--primary-soft); }
        .wz__card > svg { color: var(--primary); margin-bottom: var(--space-2); }
        .wz__cardLabel { font-weight: 600; }
        .wz__cardHint { font-size: var(--text-xs); color: var(--text-secondary); }

        .wz__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: var(--space-3); }
        .wz__pair { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
        .wz__set { border: 0; margin: 0; padding: 0; }
        .wz__legend { padding: 0; font-size: var(--text-sm); font-weight: 600; color: var(--text-secondary); margin-bottom: var(--space-3); }
        .wz__chips { display: flex; flex-wrap: wrap; gap: var(--space-2); }

        .wz__details {
          border-top: 1px solid var(--border);
          padding-top: var(--space-3);
          /* Lets the browser animate ::details-content between its 0 and
             auto heights instead of the native instant snap. */
          interpolate-size: allow-keywords;
        }
        .wz__details summary { cursor: pointer; font-size: var(--text-sm); font-weight: 500; min-height: 2.25rem; display: flex; align-items: center; }
        .wz__details::details-content {
          height: 0;
          overflow: hidden;
          transition: height 200ms ease-out, content-visibility 200ms allow-discrete;
        }
        .wz__details[open]::details-content { height: auto; }
        .wz__detailsBody { display: grid; gap: var(--space-3); padding-top: var(--space-3); }

        .wz__note { display: flex; align-items: center; gap: 0.4rem; font-size: var(--text-sm); color: var(--text-secondary); }
        .wz__note svg { color: var(--primary); }

        .wz__geoRow { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-3); margin-bottom: var(--space-3); }
        .wz__geoNote { display: flex; align-items: center; gap: 0.4rem; font-size: var(--text-xs); color: var(--text-tertiary); margin: 0 0 var(--space-3); }
        .wz__geoNote--ok { color: var(--primary); }
        .wz__geoNote svg { flex-shrink: 0; }

        .wz__drop {
          display: grid; justify-items: center; gap: 0.3rem;
          padding: var(--space-7) var(--space-4);
          border: 1px dashed var(--border-control); border-radius: var(--radius-md);
          background: var(--surface); cursor: pointer; text-align: center;
        }
        .wz__drop:hover { border-color: var(--primary); background: var(--primary-soft); }
        .wz__drop > svg { color: var(--primary); }
        .wz__dropTitle { font-weight: 600; }
        .wz__dropHint { font-size: var(--text-xs); color: var(--text-tertiary); }

        .wz__photos { display: grid; grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr)); gap: var(--space-3); list-style: none; margin: 0; padding: 0; }
        .wz__photo { position: relative; border-radius: var(--radius-md); overflow: hidden; background: var(--surface-sunken); }
        .wz__photo img { width: 100%; aspect-ratio: 3 / 2; object-fit: cover; display: block; }
        .wz__cover { position: absolute; left: var(--space-2); top: var(--space-2); padding: 0.15rem 0.45rem; border-radius: var(--radius-sm); background: var(--surface); font-size: var(--text-2xs); font-weight: 650; box-shadow: var(--shadow-subtle); }
        .wz__photoActions { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); padding: var(--space-2); background: var(--surface); }

        .wz__toggle { display: flex; gap: var(--space-3); align-items: flex-start; padding: var(--space-3); background: var(--surface); border-radius: var(--radius-md); cursor: pointer; }
        .wz__toggle input { margin-top: 0.2rem; width: 1.1rem; height: 1.1rem; accent-color: var(--primary); }
        .wz__toggle span { display: grid; gap: 0.15rem; }

        .wz__submit { display: grid; gap: var(--space-3); padding-top: var(--space-4); border-top: 1px solid var(--border); }
        .wz__error { display: flex; align-items: center; gap: 0.4rem; font-size: var(--text-sm); }

        .wz__rejected {
          display: grid; gap: var(--space-2);
          padding: var(--space-4);
          background: var(--warning-soft);
          border-radius: var(--radius-md);
        }
        .wz__rejectedHead { display: flex; align-items: center; gap: 0.5rem; }
        .wz__rejectedHead > svg { color: var(--warning); flex: 0 0 auto; }
        .wz__rejectedHead > strong { flex: 1 1 auto; font-size: var(--text-sm); }
        .wz__rejectedClose {
          display: grid; place-items: center; width: 2.25rem; height: 2.25rem;
          background: none; border: 0; border-radius: var(--radius-sm);
          cursor: pointer; color: var(--text-secondary);
        }
        .wz__rejectedClose:hover { background: color-mix(in srgb, var(--surface) 60%, transparent); }
        .wz__rejectedList { display: grid; gap: var(--space-2); margin: 0; padding-left: 1.1rem; font-size: var(--text-sm); }
        .wz__rejectedList li { display: flex; align-items: baseline; gap: var(--space-3); flex-wrap: wrap; }
        .wz__jump { background: none; border: 0; cursor: pointer; font: inherit; font-size: var(--text-xs); font-weight: 600; }
        .wz__rejectedComment { font-size: var(--text-sm); font-style: italic; }

        .wz__nav {
          position: fixed; inset-inline: 0; bottom: 0; z-index: 30;
          display: flex; align-items: center; gap: var(--space-2);
          padding: var(--space-3) 1rem;
          padding-bottom: max(var(--space-3), env(safe-area-inset-bottom));
          background: var(--surface); border-top: 1px solid var(--border);
        }
        .wz__nav > .btn:last-child { margin-left: auto; }
        @media (min-width: 768px) {
          .wz__nav { justify-content: center; }
          .wz__nav > .btn:last-child { margin-left: 0; }
        }
        @media (max-width: 480px) {
          .wz__exit { display: none; }
          .wz__pair { grid-template-columns: 1fr; }
        }

        /* A landscape phone (e.g. 812×375) has so little vertical room that
           the sticky progress header plus the fixed action bar can eat most
           of the viewport between them, leaving barely enough to see a card
           without it passing under the header mid-scroll. Both shrink here —
           trimmed padding, and the step name drops out (it already repeats
           the step's own heading below), since the progressbar's own aria
           label still carries "step X of Y" to a screen reader with nothing
           visible needed to say it twice. */
        @media (max-height: 500px) {
          .wz__top { padding-block: var(--space-2); }
          .wz__stepLabel { display: none; }
          .wz__nav { padding-block: var(--space-2); }
        }
      `}</style>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Step({ title, lead, children }: { title: string; lead?: string; children: React.ReactNode }) {
  return (
    <section className="wz__section">
      <div className="wz__head">
        <h1 className="wz__title">{title}</h1>
        {lead && <p className="wz__lead">{lead}</p>}
      </div>
      {children}
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

function Choice({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: string; label: string; hint?: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <fieldset className="wz__set">
      <legend className="wz__legend">{label}</legend>
      <div className="wz__chips">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            className="chip chip-sm"
            aria-pressed={value === o.value}
            onClick={() => onChange(o.value)}
            title={o.hint}
          >
            {o.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function NumberInput({
  value,
  min,
  max,
  onChange,
}: {
  value: unknown;
  min: number;
  max: number;
  onChange: (value: number | undefined) => void;
}) {
  return (
    <input
      className="input"
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={value === null || value === undefined ? '' : String(value)}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === '') return onChange(undefined);
        const n = Number(raw);
        if (Number.isFinite(n)) onChange(n);
      }}
    />
  );
}

/** BYN in, kopecks out. No component multiplies money anywhere else. */
function MoneyInput({ value, onChange }: { value: unknown; onChange: (minor: string | undefined) => void }) {
  const asByn =
    value === null || value === undefined || value === '' || value === '0'
      ? ''
      : String(Math.round(Number(value) / 100));
  return (
    <input
      className="input numeric"
      inputMode="numeric"
      value={asByn}
      placeholder="0"
      onChange={(e) => {
        const raw = e.target.value.replace(/[^\d]/g, '');
        onChange(raw === '' ? undefined : String(Number(raw) * 100));
      }}
    />
  );
}

function SaveBadge({ state }: { state: SaveState }) {
  const t = useTranslations('ListingWizard');
  if (state === 'idle') return null;
  const config = {
    saving: { text: t('saveState.saving'), icon: 'clock' as IconName, tone: 'var(--text-tertiary)' },
    saved: { text: t('saveState.saved'), icon: 'checkCircle' as IconName, tone: 'var(--success)' },
    error: { text: t('errors.saveFailed'), icon: 'alert' as IconName, tone: 'var(--error)' },
  }[state];
  return (
    <span className="wz__save" style={{ color: config.tone }} role="status">
      <Icon name={config.icon} size={15} />
      {config.text}
      <style>{`
        .wz__save { display: inline-flex; align-items: center; gap: 0.3rem; font-size: var(--text-xs); font-weight: 500; }
      `}</style>
    </span>
  );
}

/**
 * Minimum and maximum stay.
 *
 * A literal slider was considered and rejected: the useful range runs
 * from one night to a year, which is three orders of magnitude, and no
 * slider makes "1 ночь" and "12 месяцев" both easy to hit. A unit
 * segment plus a count gives the same expressiveness with none of the
 * precision problem, and the sentence underneath is the real feedback.
 */
const DURATION_PRESETS = [
  { key: 'presetDailyOnly', min: 1, max: 14 },
  { key: 'presetDailyAndMonth', min: 1, max: 90 },
  { key: 'presetFromMonth', min: 30, max: 365 },
  { key: 'presetLongTermOnly', min: 180, max: 365 * 3 },
] as const;

function DurationStep({
  minNights,
  maxNights,
  onChange,
}: {
  minNights: number;
  maxNights: number;
  onChange: (min: number, max: number) => void;
}) {
  const t = useTranslations('ListingWizard');
  const locale = useLocale() as AppLocale;
  const invalid = maxNights < minNights;
  return (
    <Step title={t('step6.title')} lead={t('step6.lead')}>
      <div className="wz__pair">
        <DurationPicker
          label={t('step6.minLabel')}
          nights={minNights}
          onChange={(n) => onChange(n, maxNights)}
        />
        <DurationPicker
          label={t('step6.maxLabel')}
          nights={maxNights}
          onChange={(n) => onChange(minNights, n)}
        />
      </div>

      {invalid ? (
        <p className="error-text" role="alert">
          {t('errors.invalidDuration')}
        </p>
      ) : (
        <p className="wz__note">
          <Icon name="calendar" size={16} />
          {t('step6.rangeNote', {
            min: formatNightsGenitiveLocalized(minNights, locale),
            max: formatNightsGenitiveLocalized(maxNights, locale),
          })}
        </p>
      )}

      <div className="wz__chips">
        {DURATION_PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            className="chip chip-sm"
            aria-pressed={minNights === p.min && maxNights === p.max}
            onClick={() => onChange(p.min, p.max)}
          >
            {t(`step6.${p.key}`)}
          </button>
        ))}
      </div>
    </Step>
  );
}

function DurationPicker({
  label,
  nights,
  onChange,
}: {
  label: string;
  nights: number;
  onChange: (nights: number) => void;
}) {
  const t = useTranslations('ListingWizard');
  const unit = bestUnit(nights);
  const count = Math.max(1, Math.round(nights / unit.nights));
  return (
    <fieldset className="wz__set">
      <legend className="wz__legend">{label}</legend>
      <div className="wz__pair">
        <input
          className="input"
          type="number"
          min={1}
          max={999}
          value={count}
          aria-label={t('step6.quantityAria', { label })}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n) && n >= 1) onChange(clampNights(n * unit.nights));
          }}
        />
        <select
          className="select"
          value={unit.code}
          aria-label={t('step6.unitAria', { label })}
          onChange={(e) => {
            const next = DURATION_UNITS.find((u) => u.code === e.target.value);
            if (next) onChange(clampNights(count * next.nights));
          }}
        >
          {DURATION_UNITS.map((u) => (
            <option key={u.code} value={u.code}>
              {t(`durationUnits.${u.code}`)}
            </option>
          ))}
        </select>
      </div>
    </fieldset>
  );
}

function PreviewSummary({
  draft,
  photos,
  amenities,
  onEdit,
}: {
  draft: Draft;
  photos: Photo[];
  amenities: readonly AmenityOption[];
  onEdit: (step: number) => void;
}) {
  const t = useTranslations('ListingWizard');
  const locale = useLocale() as AppLocale;
  const cover = photos.find((p) => p.isCover) ?? photos[0];
  const names = new Map(amenities.map((a) => [a.code, amenityName(a, locale)]));
  const chosen: string[] = draft.amenities ?? [];
  const price = draft.basePriceMinor ? Math.round(Number(draft.basePriceMinor) / 100) : null;
  const dash = t('preview.dash');
  const propertyType = PROPERTY_TYPE_META.find((pt) => pt.value === draft.propertyType);

  const rows: { step: number; label: string; value: string }[] = [
    {
      step: 0,
      label: t('preview.typeRow'),
      value: propertyType ? t(`propertyTypes.${propertyType.value}.label`) : dash,
    },
    {
      step: 1,
      label: t('preview.cityRow'),
      value: draft.district ? `${draft.city} · ${draft.district}` : (draft.city ?? dash),
    },
    {
      step: 2,
      label: t('preview.photosRow'),
      value: photos.length > 0 ? `${photos.length}` : t('preview.photosNone'),
    },
    {
      step: 3,
      label: t('preview.paramsRow'),
      value:
        [
          draft.rooms != null && t('preview.roomsCount', { count: Number(draft.rooms) }),
          draft.areaSqm != null && `${Math.round(Number(draft.areaSqm))} ${t('preview.areaUnit')}`,
          draft.floor != null &&
            draft.totalFloors != null &&
            `${draft.floor}/${draft.totalFloors} ${t('preview.floorShort')}`,
        ]
          .filter(Boolean)
          .join(' · ') || dash,
    },
    {
      step: 4,
      label: t('preview.amenitiesRow'),
      value: chosen.length
        ? chosen
            .slice(0, 4)
            .map((c) => names.get(c) ?? c)
            .join(', ') +
          (chosen.length > 4 ? ` ${t('preview.amenitiesMore', { count: chosen.length - 4 })}` : '')
        : dash,
    },
    {
      step: 6,
      label: t('preview.durationRow'),
      value: t('preview.durationValue', {
        min: formatNightsGenitiveLocalized(Number(draft.minNights ?? 1), locale),
        max: formatNightsGenitiveLocalized(Number(draft.maxNights ?? 365), locale),
      }),
    },
    {
      step: 7,
      label: t('preview.priceRow'),
      value: price
        ? `${price} ${currencySymbol()} ${draft.priceUnit === 'MONTH' ? t('preview.pricePerMonth') : t('preview.pricePerNight')}`
        : dash,
    },
  ];

  return (
    <div className="pv">
      <article className="pv__card">
        <div className="pv__media">
          {cover ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/media/${cover.storageKey}`} alt={draft.title || t('preview.noTitle')} />
          ) : (
            <span className="pv__nophoto">
              <Icon name="image" size={22} />
              {t('preview.noPhotos')}
            </span>
          )}
        </div>
        <div className="pv__body">
          <h2 className="pv__title">{draft.title || t('preview.noTitle')}</h2>
          <p className="pv__price numeric">
            {price ? `${price} ${currencySymbol()}` : t('preview.noPrice')}{' '}
            <span className="pv__unit">
              {price ? (draft.priceUnit === 'MONTH' ? t('preview.perMonth') : t('preview.perNight')) : ''}
            </span>
          </p>
          <p className="pv__place">
            {draft.district ? `${draft.city} · ${draft.district}` : draft.city || dash}
          </p>
        </div>
      </article>

      <dl className="pv__rows">
        {rows.map((r) => (
          <div key={r.step} className="pv__row">
            <dt>{r.label}</dt>
            <dd>
              <span>{r.value}</span>
              <button type="button" className="link" onClick={() => onEdit(r.step)}>
                {t('preview.edit')}
              </button>
            </dd>
          </div>
        ))}
      </dl>

      <style>{`
        .pv { display: grid; gap: var(--space-5); }
        .pv__card { background: var(--surface); border-radius: var(--radius-md); overflow: hidden; max-width: 22rem; }
        .pv__media { aspect-ratio: 3 / 2; background: var(--surface-sunken); display: grid; place-items: center; }
        .pv__media img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .pv__nophoto { display: grid; justify-items: center; gap: 0.3rem; color: var(--text-tertiary); font-size: var(--text-xs); }
        .pv__body { display: grid; gap: 0.2rem; padding: var(--space-3) var(--space-3) var(--space-4); }
        .pv__title { font-size: var(--text-base); font-weight: 600; }
        .pv__price { font-size: var(--text-lg); font-weight: 650; letter-spacing: -0.02em; }
        .pv__unit { font-size: var(--text-xs); font-weight: 400; color: var(--text-secondary); }
        .pv__place { font-size: var(--text-sm); color: var(--text-secondary); }
        .pv__rows { display: grid; gap: 0; margin: 0; }
        .pv__row { display: grid; grid-template-columns: 8rem 1fr; gap: var(--space-3); padding-block: var(--space-3); border-top: 1px solid var(--border); }
        .pv__row dt { font-size: var(--text-sm); color: var(--text-secondary); }
        .pv__row dd { margin: 0; display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); font-size: var(--text-sm); }
        .pv__row .link { background: none; border: 0; cursor: pointer; font: inherit; font-size: var(--text-xs); font-weight: 600; flex: 0 0 auto; }
        @media (max-width: 560px) { .pv__row { grid-template-columns: 1fr; gap: 0.2rem; } }
      `}</style>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function groupAmenities(amenities: readonly AmenityOption[], locale: AppLocale) {
  const map = new Map<string, AmenityOption[]>();
  for (const a of amenities) {
    const list = map.get(a.category);
    if (list) list.push(a);
    else map.set(a.category, [a]);
  }
  return [...map.entries()]
    .map(([category, items]) => ({
      category,
      items,
      label: amenityCategoryLabel(category, locale),
      order: AMENITY_CATEGORY[category]?.order ?? 99,
    }))
    .sort((a, b) => a.order - b.order);
}

const clampNights = (n: number) => Math.max(1, Math.min(365 * 5, Math.round(n)));

function bestUnit(nights: number) {
  // Largest unit that divides evenly, so 30 reads as "1 месяц" and 45 as
  // "45 ночей" rather than an awkward fraction.
  for (const unit of [...DURATION_UNITS].reverse()) {
    if (nights >= unit.nights && nights % unit.nights === 0) return unit;
  }
  return DURATION_UNITS[0]!;
}

/** Postgres returns `time` as HH:MM:SS; the input wants HH:MM. */
function timeValue(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value === '') return fallback;
  return value.slice(0, 5);
}

function validate(step: number, draft: Draft, photos: Photo[], t: Translate): string | null {
  if (step === 0 && !draft.propertyType) return t('errors.chooseType');
  if (step === 1 && !draft.city) return t('errors.chooseCity');
  if (step === 2 && photos.length === 0) return t('errors.addPhoto');
  if (step === 3) {
    const title = String(draft.title ?? '').trim();
    if (title.length < 8) return t('errors.titleTooShort');
  }
  if (step === 6 && Number(draft.maxNights ?? 365) < Number(draft.minNights ?? 1)) {
    return t('errors.invalidDuration');
  }
  if (step === 7 && !draft.basePriceMinor) return t('errors.setPrice');
  return null;
}

/** Resume where the landlord actually stopped, not at the beginning. */
function firstIncompleteStep(listing: WizardListing): number {
  const photos = (listing.photos as Photo[] | undefined) ?? [];
  if (!listing.city) return 1;
  if (photos.length === 0) return 2;
  if (!listing.title || String(listing.title).trim().length < 8) return 3;
  if (!listing.basePriceMinor) return 7;
  return 8;
}
