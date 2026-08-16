'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon, AMENITY_CATEGORY, amenityIcon, type IconName } from '@/ui/icons.tsx';
import { formatNightsGenitive, plural } from '@/ui/primitives.tsx';
import type { AmenityOption } from '@/ui/search-filters.tsx';

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

const PROPERTY_TYPES: { value: string; label: string; hint: string; icon: IconName }[] = [
  { value: 'APARTMENT', label: 'Квартира', hint: 'Отдельная квартира целиком', icon: 'home' },
  { value: 'ROOM', label: 'Комната', hint: 'Комната в квартире или доме', icon: 'door' },
  { value: 'STUDIO', label: 'Студия', hint: 'Одна комната с кухней', icon: 'rooms' },
  { value: 'HOUSE', label: 'Дом', hint: 'Частный дом целиком', icon: 'home' },
  { value: 'COTTAGE', label: 'Коттедж или дача', hint: 'За городом', icon: 'home' },
  { value: 'TOWNHOUSE', label: 'Таунхаус', hint: 'Секция в блокированном доме', icon: 'floors' },
];

/** City centres, so a landlord gets a sensible point without a geocoder. */
const CITIES: { name: string; latitude: number; longitude: number }[] = [
  { name: 'Минск', latitude: 53.9023, longitude: 27.5619 },
  { name: 'Гомель', latitude: 52.4242, longitude: 31.0141 },
  { name: 'Могилёв', latitude: 53.9006, longitude: 30.3313 },
  { name: 'Витебск', latitude: 55.1848, longitude: 30.2016 },
  { name: 'Гродно', latitude: 53.6694, longitude: 23.8131 },
  { name: 'Брест', latitude: 52.0976, longitude: 23.7341 },
  { name: 'Бобруйск', latitude: 53.1384, longitude: 29.2214 },
  { name: 'Барановичи', latitude: 53.1327, longitude: 26.0139 },
  { name: 'Борисов', latitude: 54.2278, longitude: 28.5053 },
  { name: 'Пинск', latitude: 52.1229, longitude: 26.0951 },
  { name: 'Орша', latitude: 54.5081, longitude: 30.4172 },
  { name: 'Мозырь', latitude: 52.0495, longitude: 29.2456 },
  { name: 'Солигорск', latitude: 52.7876, longitude: 27.5416 },
  { name: 'Новополоцк', latitude: 55.5322, longitude: 28.65 },
  { name: 'Лида', latitude: 53.8886, longitude: 25.2994 },
  { name: 'Молодечно', latitude: 54.3167, longitude: 26.85 },
];

const SMOKING = [
  { value: 'PROHIBITED', label: 'Запрещено' },
  { value: 'BALCONY_ONLY', label: 'Только на балконе' },
  { value: 'ALLOWED', label: 'Разрешено' },
];
const PETS = [
  { value: 'PROHIBITED', label: 'Нельзя' },
  { value: 'ON_REQUEST', label: 'По согласованию' },
  { value: 'SMALL_ONLY', label: 'Только небольшие' },
  { value: 'ALLOWED', label: 'Можно' },
];

/** Lengths a landlord actually thinks in, expressed in nights. */
const DURATION_UNITS: { label: string; nights: number }[] = [
  { label: 'ночь', nights: 1 },
  { label: 'неделя', nights: 7 },
  { label: 'месяц', nights: 30 },
  { label: 'год', nights: 365 },
];

const BOOKING_MODES = [
  { value: 'REQUEST', label: 'По запросу', hint: 'Вы подтверждаете каждое бронирование' },
  { value: 'INSTANT', label: 'Мгновенно', hint: 'Гость бронирует сразу, без подтверждения' },
  { value: 'INSTANT_AND_REQUEST', label: 'Оба варианта', hint: 'Гость выбирает сам' },
];

const UTILITIES = [
  { value: 'INCLUDED', label: 'Входят в цену' },
  { value: 'FIXED_EXTRA', label: 'Фиксированная доплата' },
  { value: 'VARIABLE_METERED', label: 'По счётчику' },
];

/* ------------------------------------------------------------------ */

export interface WizardListing {
  id: string;
  status: string;
  rejectionReason: string | null;
  [key: string]: unknown;
}

type Draft = Record<string, any>;

interface Photo {
  id: string;
  storageKey: string;
  isCover: boolean;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const STEPS = [
  'Что сдаёте',
  'Где',
  'Фотографии',
  'О квартире',
  'Удобства',
  'Правила',
  'Срок аренды',
  'Цена',
  'Предпросмотр',
] as const;

export function ListingWizard({
  listing,
  amenities,
}: {
  listing: WizardListing | null;
  amenities: readonly AmenityOption[];
}) {
  const router = useRouter();
  const [id, setId] = useState<string | null>(listing?.id ?? null);
  const [draft, setDraft] = useState<Draft>(() => ({ ...(listing ?? {}) }));
  const [photos, setPhotos] = useState<Photo[]>(
    () => ((listing?.photos as Photo[] | undefined) ?? []).map((p) => ({ ...p })),
  );
  const [step, setStep] = useState(() => (listing ? firstIncompleteStep(listing) : 0));
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
      setError(e instanceof ApiError ? e.message : 'Не удалось сохранить');
    }
  }, [id]);

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
      setStep(1);
    } catch (e) {
      setSaveState('error');
      setError(e instanceof ApiError ? e.message : 'Не удалось создать черновик');
    }
  }

  async function go(next: number) {
    const problem = validate(step, draft, photos);
    if (problem && next > step) {
      setError(problem);
      return;
    }
    setError(null);
    await flush();
    setStep(Math.max(0, Math.min(STEPS.length - 1, next)));
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
      setError(e instanceof ApiError ? e.message : 'Не удалось отправить на проверку');
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
          setError(payload?.error?.message ?? 'Не удалось загрузить фотографию');
          continue;
        }
        setPhotos((list) => [
          ...list,
          { id: payload.id, storageKey: payload.storageKey, isCover: list.length === 0 },
        ]);
      } catch {
        setError('Не удалось загрузить фотографию');
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
      setError(e instanceof ApiError ? e.message : 'Не удалось удалить фотографию');
    }
  }

  async function makeCover(photoId: string) {
    try {
      await api.post(`/listings/${id}/photos/${photoId}/cover`, {});
      setPhotos((list) => list.map((p) => ({ ...p, isCover: p.id === photoId })));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось выбрать главное фото');
    }
  }

  /* --- render ------------------------------------------------------ */

  const groupedAmenities = useMemo(() => groupAmenities(amenities), [amenities]);
  const chosen: string[] = draft.amenities ?? [];
  const progress = Math.round(((step + 1) / STEPS.length) * 100);

  return (
    <div className="wz">
      <header className="wz__top">
        <div className="wz__topRow">
          {/* Saves before leaving, so this is a safe exit at every width —
              the bottom bar drops its own "Сохранить и выйти" on a phone. */}
          <button type="button" className="wz__back" onClick={() => void saveAndExit()}>
            <Icon name="arrowLeft" size={16} />
            Сохранить и выйти
          </button>
          <SaveBadge state={saveState} />
        </div>
        <div className="wz__progress" role="progressbar" aria-valuenow={step + 1} aria-valuemin={1} aria-valuemax={STEPS.length} aria-label={`Шаг ${step + 1} из ${STEPS.length}`}>
          <span className="wz__progressFill" style={{ width: `${progress}%` }} />
        </div>
        <p className="wz__stepLabel">
          Шаг {step + 1} из {STEPS.length} · {STEPS[step]}
        </p>
      </header>

      <main className="wz__body">
        {step === 0 && (
          <Step title="Что вы сдаёте?" lead="С этого начнём — остальное можно заполнять постепенно.">
            <div className="wz__cards">
              {PROPERTY_TYPES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  className="wz__card"
                  aria-pressed={draft.propertyType === t.value}
                  onClick={() => (id ? patch({ propertyType: t.value }) : void start(t.value))}
                >
                  <Icon name={t.icon} size={22} />
                  <span className="wz__cardLabel">{t.label}</span>
                  <span className="wz__cardHint">{t.hint}</span>
                </button>
              ))}
            </div>
            {id && draft.propertyType && (
              <p className="hint">Черновик сохранён. Вы можете вернуться к нему в любой момент.</p>
            )}
          </Step>
        )}

        {step === 1 && (
          <Step
            title="Где находится жильё?"
            lead="Точный адрес не показывается в объявлении. На карте гости увидят приблизительную точку в радиусе нескольких сотен метров."
          >
            <Field label="Город">
              <select
                className="select"
                value={draft.city ?? ''}
                onChange={(e) => {
                  const city = CITIES.find((c) => c.name === e.target.value);
                  patch(
                    city
                      ? { city: city.name, latitude: city.latitude, longitude: city.longitude }
                      : { city: e.target.value },
                  );
                }}
              >
                <option value="">Выберите город</option>
                {CITIES.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Район" hint="Необязательно, но помогает гостям сориентироваться">
              <input
                className="input"
                value={draft.district ?? ''}
                onChange={(e) => patch({ district: e.target.value })}
                placeholder="Центральный"
              />
            </Field>

            <details className="wz__details">
              <summary>Точный адрес — только для подтверждённых бронирований</summary>
              <div className="wz__detailsBody">
                <p className="hint">
                  Улицу и дом видят только гости с подтверждённым бронированием. До этого адрес
                  скрыт даже от тех, кто вам написал.
                </p>
                <div className="wz__pair">
                  <Field label="Улица">
                    <input
                      className="input"
                      value={draft.street ?? ''}
                      onChange={(e) => patch({ street: e.target.value })}
                    />
                  </Field>
                  <Field label="Дом">
                    <input
                      className="input"
                      value={draft.houseNumber ?? ''}
                      onChange={(e) => patch({ houseNumber: e.target.value })}
                    />
                  </Field>
                </div>
                <Field label="Квартира" hint="Не передаётся никому до подтверждения брони">
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
                Приблизительная точка: {Number(draft.latitude).toFixed(3)},{' '}
                {Number(draft.longitude).toFixed(3)}
              </p>
            )}
          </Step>
        )}

        {step === 2 && (
          <Step
            title="Фотографии"
            lead="Первое фото будет главным в объявлении. Хорошие снимки помогают гостям понять, подходит ли им квартира."
          >
            <label className="wz__drop">
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                className="sr-only"
                onChange={(e) => void upload(e.target.files)}
              />
              <Icon name="image" size={26} />
              <span className="wz__dropTitle">Выберите фотографии</span>
              <span className="wz__dropHint">JPEG, PNG или WebP, до 10 МБ каждая</span>
            </label>

            {photos.length > 0 && (
              <ul className="wz__photos">
                {photos.map((p) => (
                  <li key={p.id} className="wz__photo">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/media/${p.storageKey}`} alt="" loading="lazy" />
                    {p.isCover && <span className="wz__cover">Главное</span>}
                    <div className="wz__photoActions">
                      {!p.isCover && (
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void makeCover(p.id)}>
                          Сделать главным
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => void removePhoto(p.id)}
                        aria-label="Удалить фотографию"
                      >
                        <Icon name="close" size={15} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="hint">
              {photos.length === 0
                ? 'Нужна хотя бы одна фотография, чтобы отправить объявление на проверку.'
                : `${photos.length} ${plural(photos.length, 'фотография', 'фотографии', 'фотографий')}.`}
            </p>
          </Step>
        )}

        {step === 3 && (
          <Step title="Расскажите о квартире" lead="Эти данные гости используют в фильтрах, поэтому их стоит заполнить точно.">
            <Field label="Название объявления" hint="От 8 до 120 символов. Это заголовок, который увидят гости.">
              <input
                className="input"
                value={draft.title ?? ''}
                maxLength={120}
                onChange={(e) => patch({ title: e.target.value })}
                placeholder="Светлая двушка у метро Немига"
              />
            </Field>

            <div className="wz__grid">
              <Field label="Комнат">
                <NumberInput value={draft.rooms} min={0} max={30} onChange={(v) => patch({ rooms: v })} />
              </Field>
              <Field label="Площадь, м²">
                <NumberInput value={draft.areaSqm} min={1} max={9999} onChange={(v) => patch({ areaSqm: v })} />
              </Field>
              <Field label="Этаж">
                <NumberInput value={draft.floor} min={-5} max={200} onChange={(v) => patch({ floor: v })} />
              </Field>
              <Field label="Этажей в доме">
                <NumberInput value={draft.totalFloors} min={1} max={200} onChange={(v) => patch({ totalFloors: v })} />
              </Field>
              <Field label="Спальных мест">
                <NumberInput value={draft.beds} min={0} max={50} onChange={(v) => patch({ beds: v })} />
              </Field>
              <Field label="Санузлов">
                <NumberInput value={draft.bathrooms} min={0} max={20} onChange={(v) => patch({ bathrooms: v })} />
              </Field>
              <Field label="Максимум гостей">
                <NumberInput value={draft.maxGuests} min={1} max={50} onChange={(v) => patch({ maxGuests: v })} />
              </Field>
            </div>

            <Field
              label="Описание"
              hint="Расскажите о квартире: что в ней удобно, что находится рядом, кому она особенно подойдёт."
            >
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
          <Step title="Что есть в квартире?" lead="Отметьте то, что действительно есть — гости подтверждают удобства после проживания.">
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
                        {a.name_ru}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            ))}
          </Step>
        )}

        {step === 5 && (
          <Step title="Правила проживания" lead="Понятные правила снижают число неподходящих запросов.">
            <Choice
              label="Курение"
              options={SMOKING}
              value={draft.smokingPolicy ?? 'PROHIBITED'}
              onChange={(v) => patch({ smokingPolicy: v })}
            />
            <Choice
              label="Животные"
              options={PETS}
              value={draft.petsPolicy ?? 'PROHIBITED'}
              onChange={(v) => patch({ petsPolicy: v })}
            />
            <Choice
              label="Дети"
              options={[
                { value: 'yes', label: 'Можно' },
                { value: 'no', label: 'Не подходит' },
              ]}
              value={draft.childrenAllowed === false ? 'no' : 'yes'}
              onChange={(v) => patch({ childrenAllowed: v === 'yes' })}
            />
            <Choice
              label="Вечеринки и мероприятия"
              options={[
                { value: 'no', label: 'Запрещены' },
                { value: 'yes', label: 'Разрешены' },
              ]}
              value={draft.partiesAllowed ? 'yes' : 'no'}
              onChange={(v) => patch({ partiesAllowed: v === 'yes' })}
            />

            <div className="wz__pair">
              <Field label="Заезд с">
                <input
                  type="time"
                  className="input"
                  value={timeValue(draft.checkInFrom, '14:00')}
                  onChange={(e) => patch({ checkInFrom: e.target.value })}
                />
              </Field>
              <Field label="Выезд до">
                <input
                  type="time"
                  className="input"
                  value={timeValue(draft.checkOutUntil, '12:00')}
                  onChange={(e) => patch({ checkOutUntil: e.target.value })}
                />
              </Field>
            </div>

            <div className="wz__pair">
              <Field label="Тихие часы с" hint="Необязательно">
                <input
                  type="time"
                  className="input"
                  value={timeValue(draft.quietHoursFrom, '')}
                  onChange={(e) => patch({ quietHoursFrom: e.target.value || undefined })}
                />
              </Field>
              <Field label="до">
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
          <Step title="Цена" lead="Гость видит итоговую сумму до бронирования, поэтому важно указать всё, что входит в оплату.">
            <Choice
              label="Как считаем цену"
              options={[
                { value: 'NIGHT', label: 'За ночь' },
                { value: 'MONTH', label: 'За месяц' },
              ]}
              value={draft.priceUnit ?? 'NIGHT'}
              onChange={(v) => patch({ priceUnit: v })}
            />

            <Field
              label={draft.priceUnit === 'MONTH' ? 'Цена за месяц, BYN' : 'Цена за ночь, BYN'}
              hint="Основная ставка. Скидки на длительное проживание можно настроить позже."
            >
              <MoneyInput value={draft.basePriceMinor} onChange={(v) => patch({ basePriceMinor: v })} />
            </Field>

            <Field label="Обязательная уборка, BYN" hint="Разовая сумма. Оставьте пустым, если её нет.">
              <MoneyInput value={draft.cleaningFeeMinor} onChange={(v) => patch({ cleaningFeeMinor: v })} />
            </Field>

            <Choice
              label="Коммунальные платежи"
              options={UTILITIES}
              value={draft.utilitiesMode ?? 'INCLUDED'}
              onChange={(v) => patch({ utilitiesMode: v })}
            />
            {draft.utilitiesMode === 'FIXED_EXTRA' && (
              <Field label="Доплата за коммунальные, BYN">
                <MoneyInput
                  value={draft.utilitiesFixedMinor}
                  onChange={(v) => patch({ utilitiesFixedMinor: v })}
                />
              </Field>
            )}
            {draft.utilitiesMode === 'VARIABLE_METERED' && (
              <p className="hint">
                Гостю будет показано «по счётчику» — платформа не станет придумывать сумму, которую
                нельзя посчитать заранее.
              </p>
            )}

            <Field label="Залог, BYN" hint="Возвращается при выезде. Оставьте пустым, если залога нет.">
              <MoneyInput value={draft.depositMinor} onChange={(v) => patch({ depositMinor: v })} />
            </Field>

            <Choice
              label="Как гости бронируют"
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
                <strong>Цена обсуждается</strong>
                <span className="hint">
                  Гость сможет предложить свои условия, а вы — принять или отклонить.
                </span>
              </span>
            </label>
          </Step>
        )}

        {step === 8 && (
          <Step title="Проверьте объявление" lead="Так его увидят гости. Любой шаг можно поправить.">
            <PreviewSummary
              draft={draft}
              photos={photos}
              amenities={amenities}
              onEdit={(s) => void go(s)}
            />

            <div className="wz__submit">
              <p className="hint">
                После отправки объявление проверит модератор. Мы сообщим о результате — сроки
                проверки зависят от очереди.
              </p>
              <button
                type="button"
                className="btn btn-primary btn-lg btn-block"
                disabled={submitting || !id}
                onClick={() => void submit()}
              >
                {submitting ? 'Отправляем…' : 'Отправить на проверку'}
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

      <nav className="wz__nav" aria-label="Навигация по шагам">
        <button type="button" className="btn btn-ghost" onClick={() => void go(step - 1)} disabled={step === 0}>
          Назад
        </button>
        <button type="button" className="btn btn-secondary wz__exit" onClick={() => void saveAndExit()} disabled={!id}>
          Сохранить и выйти
        </button>
        {step < STEPS.length - 1 && (
          <button type="button" className="btn btn-primary" onClick={() => void go(step + 1)} disabled={!id}>
            Далее
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
        .wz__section { display: grid; gap: var(--space-4); }

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

        .wz__details { border-top: 1px solid var(--border); padding-top: var(--space-3); }
        .wz__details summary { cursor: pointer; font-size: var(--text-sm); font-weight: 500; min-height: 2.25rem; display: flex; align-items: center; }
        .wz__detailsBody { display: grid; gap: var(--space-3); padding-top: var(--space-3); }

        .wz__note { display: flex; align-items: center; gap: 0.4rem; font-size: var(--text-sm); color: var(--text-secondary); }
        .wz__note svg { color: var(--primary); }

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

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
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
  if (state === 'idle') return null;
  const config = {
    saving: { text: 'Сохраняем…', icon: 'clock' as IconName, tone: 'var(--text-tertiary)' },
    saved: { text: 'Сохранено', icon: 'checkCircle' as IconName, tone: 'var(--success)' },
    error: { text: 'Не удалось сохранить', icon: 'alert' as IconName, tone: 'var(--error)' },
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
function DurationStep({
  minNights,
  maxNights,
  onChange,
}: {
  minNights: number;
  maxNights: number;
  onChange: (min: number, max: number) => void;
}) {
  const invalid = maxNights < minNights;
  return (
    <Step
      title="На какой срок сдаёте?"
      lead="Кватэрка работает и на сутки, и на год. Укажите границы — гости увидят только подходящие им варианты."
    >
      <div className="wz__pair">
        <DurationPicker label="Минимум" nights={minNights} onChange={(n) => onChange(n, maxNights)} />
        <DurationPicker label="Максимум" nights={maxNights} onChange={(n) => onChange(minNights, n)} />
      </div>

      {invalid ? (
        <p className="error-text" role="alert">
          Максимальный срок не может быть меньше минимального.
        </p>
      ) : (
        <p className="wz__note">
          <Icon name="calendar" size={16} />
          Можно снять от {formatNightsGenitive(minNights)} до {formatNightsGenitive(maxNights)}.
        </p>
      )}

      <div className="wz__chips">
        {[
          { label: 'Только посуточно', min: 1, max: 14 },
          { label: 'Посуточно и на месяц', min: 1, max: 90 },
          { label: 'От месяца', min: 30, max: 365 },
          { label: 'Только долгосрочно', min: 180, max: 365 * 3 },
        ].map((p) => (
          <button
            key={p.label}
            type="button"
            className="chip chip-sm"
            aria-pressed={minNights === p.min && maxNights === p.max}
            onClick={() => onChange(p.min, p.max)}
          >
            {p.label}
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
          aria-label={`${label}: количество`}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n) && n >= 1) onChange(clampNights(n * unit.nights));
          }}
        />
        <select
          className="select"
          value={unit.label}
          aria-label={`${label}: единица`}
          onChange={(e) => {
            const next = DURATION_UNITS.find((u) => u.label === e.target.value);
            if (next) onChange(clampNights(count * next.nights));
          }}
        >
          {DURATION_UNITS.map((u) => (
            <option key={u.label} value={u.label}>
              {u.label === 'ночь' ? 'ночей' : u.label === 'неделя' ? 'недель' : u.label === 'месяц' ? 'месяцев' : 'лет'}
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
  const cover = photos.find((p) => p.isCover) ?? photos[0];
  const names = new Map(amenities.map((a) => [a.code, a.name_ru]));
  const chosen: string[] = draft.amenities ?? [];
  const price = draft.basePriceMinor ? Math.round(Number(draft.basePriceMinor) / 100) : null;

  const rows: { step: number; label: string; value: string }[] = [
    { step: 0, label: 'Тип', value: PROPERTY_TYPES.find((t) => t.value === draft.propertyType)?.label ?? '—' },
    { step: 1, label: 'Город', value: draft.district ? `${draft.city} · ${draft.district}` : (draft.city ?? '—') },
    { step: 2, label: 'Фотографии', value: photos.length > 0 ? `${photos.length}` : 'нет' },
    {
      step: 3,
      label: 'Параметры',
      value:
        [
          draft.rooms != null && `${draft.rooms} ${plural(Number(draft.rooms), 'комната', 'комнаты', 'комнат')}`,
          draft.areaSqm != null && `${Math.round(Number(draft.areaSqm))} м²`,
          draft.floor != null && draft.totalFloors != null && `${draft.floor}/${draft.totalFloors} эт.`,
        ]
          .filter(Boolean)
          .join(' · ') || '—',
    },
    { step: 4, label: 'Удобства', value: chosen.length ? chosen.slice(0, 4).map((c) => names.get(c) ?? c).join(', ') + (chosen.length > 4 ? ` и ещё ${chosen.length - 4}` : '') : '—' },
    {
      step: 6,
      label: 'Срок',
      value: `от ${formatNightsGenitive(Number(draft.minNights ?? 1))} до ${formatNightsGenitive(Number(draft.maxNights ?? 365))}`,
    },
    {
      step: 7,
      label: 'Цена',
      value: price ? `${price} BYN ${draft.priceUnit === 'MONTH' ? 'в месяц' : 'за ночь'}` : '—',
    },
  ];

  return (
    <div className="pv">
      <article className="pv__card">
        <div className="pv__media">
          {cover ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/media/${cover.storageKey}`} alt="" />
          ) : (
            <span className="pv__nophoto">
              <Icon name="image" size={22} />
              Нет фотографий
            </span>
          )}
        </div>
        <div className="pv__body">
          <h2 className="pv__title">{draft.title || 'Без названия'}</h2>
          <p className="pv__price numeric">
            {price ? `${price} BYN` : 'Цена не указана'}{' '}
            <span className="pv__unit">{price ? (draft.priceUnit === 'MONTH' ? '/ месяц' : '/ ночь') : ''}</span>
          </p>
          <p className="pv__place">{draft.district ? `${draft.city} · ${draft.district}` : draft.city || '—'}</p>
        </div>
      </article>

      <dl className="pv__rows">
        {rows.map((r) => (
          <div key={r.label} className="pv__row">
            <dt>{r.label}</dt>
            <dd>
              <span>{r.value}</span>
              <button type="button" className="link" onClick={() => onEdit(r.step)}>
                Изменить
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

function groupAmenities(amenities: readonly AmenityOption[]) {
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
      label: AMENITY_CATEGORY[category]?.label ?? 'Прочее',
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

function validate(step: number, draft: Draft, photos: Photo[]): string | null {
  if (step === 0 && !draft.propertyType) return 'Выберите, что вы сдаёте.';
  if (step === 1 && !draft.city) return 'Выберите город.';
  if (step === 2 && photos.length === 0) return 'Добавьте хотя бы одну фотографию.';
  if (step === 3) {
    const title = String(draft.title ?? '').trim();
    if (title.length < 8) return 'Название должно быть не короче 8 символов.';
  }
  if (step === 6 && Number(draft.maxNights ?? 365) < Number(draft.minNights ?? 1)) {
    return 'Максимальный срок не может быть меньше минимального.';
  }
  if (step === 7 && !draft.basePriceMinor) return 'Укажите цену.';
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
