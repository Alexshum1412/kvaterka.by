'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon, AMENITY_CATEGORY, amenityIcon } from './icons.tsx';
import { plural } from './primitives.tsx';

export interface AmenityOption {
  code: string;
  category: string;
  name_ru: string;
  icon: string | null;
}

/**
 * Search filters.
 *
 * Two rules shape this component.
 *
 * Nothing is rendered that the server does not actually read. A control
 * that quietly changes no results is worse than a missing one, because
 * the user believes they have narrowed the search and blames the
 * inventory for the outcome. Every field here maps to a query parameter
 * that src/app/search/page.tsx forwards to SearchService.
 *
 * And the applied state lives in the URL, not in this component. The
 * chips are derived from the query the SERVER used, handed down as a
 * prop, so what is shown as active is by construction what was filtered
 * on — a shared link reproduces the same page, and the back button does
 * the obvious thing. Reading it with `useSearchParams()` instead would
 * suspend the component, and a suspended filter bar renders as a grey
 * bar that never becomes a filter bar.
 *
 * Prices travel the wire in minor units, because that is what the search
 * endpoint expects; the person filling in the box types BYN.
 */

const DURATIONS: { value: string; label: string }[] = [
  { value: 'SHORT', label: 'До месяца' },
  { value: 'MEDIUM', label: '1–6 месяцев' },
  { value: 'LONG', label: 'От полугода' },
];

const SORTS: { value: string; label: string }[] = [
  { value: 'RELEVANCE', label: 'По релевантности' },
  { value: 'PRICE_ASC', label: 'Сначала дешевле' },
  { value: 'PRICE_DESC', label: 'Сначала дороже' },
  { value: 'RATING', label: 'По рейтингу' },
  { value: 'NEWEST', label: 'Сначала новые' },
];

const PROPERTY_TYPES: { value: string; label: string }[] = [
  { value: 'APARTMENT', label: 'Квартира' },
  { value: 'ROOM', label: 'Комната' },
  { value: 'STUDIO', label: 'Студия' },
  { value: 'HOUSE', label: 'Дом' },
  { value: 'COTTAGE', label: 'Коттедж' },
  { value: 'TOWNHOUSE', label: 'Таунхаус' },
];

/** Parameters that describe the search itself, not the narrowing of it. */
const KEPT_ON_RESET = ['city', 'district', 'q', 'from', 'to'];

const toMinor = (byn: string): string | null => {
  const n = Number(byn.replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? String(Math.round(n * 100)) : null;
};
const toByn = (minor: string | null): string => {
  const n = Number(minor);
  return Number.isFinite(n) && n > 0 ? String(Math.round(n / 100)) : '';
};

export function SearchFilters({
  amenities,
  applied: appliedQuery,
}: {
  amenities: readonly AmenityOption[];
  /** The query string the server filtered on, as plain key/value pairs. */
  applied: Readonly<Record<string, string>>;
}) {
  const router = useRouter();
  const params = useMemo(() => new URLSearchParams(appliedQuery), [appliedQuery]);
  const [open, setOpen] = useState(false);
  const [showAllAmenities, setShowAllAmenities] = useState(false);

  const [priceMin, setPriceMin] = useState(() => toByn(params.get('priceMin')));
  const [priceMax, setPriceMax] = useState(() => toByn(params.get('priceMax')));
  const [rooms, setRooms] = useState(() => params.get('rooms') ?? '');
  const [guests, setGuests] = useState(() => params.get('guests') ?? '');
  const [durationMode, setDurationMode] = useState(() => params.get('durationMode') ?? '');
  const [pets, setPets] = useState(() => params.get('pets') === 'true');
  const [verified, setVerified] = useState(() => params.get('verified') === 'true');
  const [instant, setInstant] = useState(() => params.get('instant') === 'true');
  const [chosen, setChosen] = useState<Set<string>>(
    () => new Set((params.get('amenities') ?? '').split(',').filter(Boolean)),
  );
  const [types, setTypes] = useState<Set<string>>(
    () => new Set((params.get('types') ?? '').split(',').filter(Boolean)),
  );
  const [beds, setBeds] = useState(() => params.get('beds') ?? '');
  const [rating, setRating] = useState(() => params.get('rating') ?? '');
  const [smoking, setSmoking] = useState(() => params.get('smoking') === 'true');
  const [children, setChildren] = useState(() => params.get('children') === 'true');

  const amenityNames = useMemo(
    () => new Map(amenities.map((a) => [a.code, a.name_ru])),
    [amenities],
  );

  /* The chips describe the APPLIED search, read straight off the URL. */
  const applied = useMemo(() => {
    const out: { key: string; label: string }[] = [];
    const min = params.get('priceMin');
    const max = params.get('priceMax');
    if (min && max) out.push({ key: 'price', label: `${toByn(min)}–${toByn(max)} BYN` });
    else if (min) out.push({ key: 'price', label: `от ${toByn(min)} BYN` });
    else if (max) out.push({ key: 'price', label: `до ${toByn(max)} BYN` });

    const r = params.get('rooms');
    if (r) out.push({ key: 'rooms', label: `${r}${r === '4' ? '+' : ''} ${plural(Number(r), 'комната', 'комнаты', 'комнат')}` });

    const g = params.get('guests');
    if (g) out.push({ key: 'guests', label: `${g} ${plural(Number(g), 'гость', 'гостя', 'гостей')}` });

    const d = params.get('durationMode');
    const duration = DURATIONS.find((x) => x.value === d);
    if (duration) out.push({ key: 'durationMode', label: duration.label });

    for (const t of (params.get('types') ?? '').split(',').filter(Boolean)) {
      out.push({ key: `type:${t}`, label: PROPERTY_TYPES.find((x) => x.value === t)?.label ?? t });
    }

    const b = params.get('beds');
    if (b) out.push({ key: 'beds', label: `от ${b} ${plural(Number(b), 'спального места', 'спальных мест', 'спальных мест')}` });

    const rt = params.get('minRating');
    if (rt) out.push({ key: 'minRating', label: `рейтинг от ${rt}` });

    if (params.get('smoking') === 'true') out.push({ key: 'smoking', label: 'Можно курить' });
    if (params.get('children') === 'true') out.push({ key: 'children', label: 'Можно с детьми' });
    if (params.get('pets') === 'true') out.push({ key: 'pets', label: 'Можно с животными' });
    if (params.get('verified') === 'true') out.push({ key: 'verified', label: 'Только проверенные' });
    if (params.get('instant') === 'true') out.push({ key: 'instant', label: 'Мгновенное бронирование' });

    for (const code of (params.get('amenities') ?? '').split(',').filter(Boolean)) {
      out.push({ key: `amenity:${code}`, label: amenityNames.get(code) ?? code });
    }
    return out;
  }, [params, amenityNames]);

  function push(next: URLSearchParams) {
    const qs = next.toString();
    router.push(qs ? `/search?${qs}` : '/search');
  }

  function apply() {
    const next = new URLSearchParams(params.toString());
    const set = (key: string, value: string | null) => {
      if (value) next.set(key, value);
      else next.delete(key);
    };

    set('priceMin', toMinor(priceMin));
    set('priceMax', toMinor(priceMax));
    set('rooms', rooms || null);
    set('guests', guests || null);
    set('durationMode', durationMode || null);
    set('pets', pets ? 'true' : null);
    set('verified', verified ? 'true' : null);
    set('instant', instant ? 'true' : null);
    set('amenities', chosen.size > 0 ? [...chosen].join(',') : null);
    set('types', types.size > 0 ? [...types].join(',') : null);
    set('beds', beds || null);
    set('minRating', rating || null);
    set('smoking', smoking ? 'true' : null);
    set('children', children ? 'true' : null);

    setOpen(false);
    push(next);
  }

  function removeChip(key: string) {
    const next = new URLSearchParams(params.toString());
    if (key.startsWith('amenity:')) {
      const code = key.slice('amenity:'.length);
      const rest = [...chosen].filter((c) => c !== code);
      setChosen(new Set(rest));
      if (rest.length > 0) next.set('amenities', rest.join(','));
      else next.delete('amenities');
    } else if (key.startsWith('type:')) {
      const value = key.slice('type:'.length);
      const rest = [...types].filter((t) => t !== value);
      setTypes(new Set(rest));
      if (rest.length > 0) next.set('types', rest.join(','));
      else next.delete('types');
    } else if (key === 'price') {
      next.delete('priceMin');
      next.delete('priceMax');
      setPriceMin('');
      setPriceMax('');
    } else {
      next.delete(key);
      if (key === 'rooms') setRooms('');
      if (key === 'guests') setGuests('');
      if (key === 'durationMode') setDurationMode('');
      if (key === 'beds') setBeds('');
      if (key === 'minRating') setRating('');
      if (key === 'smoking') setSmoking(false);
      if (key === 'children') setChildren(false);
      if (key === 'pets') setPets(false);
      if (key === 'verified') setVerified(false);
      if (key === 'instant') setInstant(false);
    }
    push(next);
  }

  function reset() {
    const next = new URLSearchParams();
    for (const key of KEPT_ON_RESET) {
      const value = params.get(key);
      if (value) next.set(key, value);
    }
    setPriceMin('');
    setPriceMax('');
    setRooms('');
    setGuests('');
    setDurationMode('');
    setPets(false);
    setVerified(false);
    setInstant(false);
    setChosen(new Set());
    setTypes(new Set());
    setBeds('');
    setRating('');
    setSmoking(false);
    setChildren(false);
    setOpen(false);
    push(next);
  }

  function changeSort(value: string) {
    const next = new URLSearchParams(params.toString());
    if (value && value !== 'RELEVANCE') next.set('sort', value);
    else next.delete('sort');
    push(next);
  }

  function toggleAmenity(code: string) {
    setChosen((prev) => {
      const copy = new Set(prev);
      if (copy.has(code)) copy.delete(code);
      else copy.add(code);
      return copy;
    });
  }

  const grouped = useMemo(() => {
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
  }, [amenities]);

  const visibleGroups = showAllAmenities ? grouped : grouped.slice(0, 2);

  return (
    <div className="fl">
      <div className="fl__bar">
        <button
          type="button"
          className="btn btn-secondary fl__toggle"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-controls="filters-panel"
        >
          <Icon name="sliders" size={17} />
          Фильтры
          {applied.length > 0 && <span className="fl__count">{applied.length}</span>}
        </button>

        {applied.length > 0 && (
          <ul className="fl__chips">
            {applied.map((chip) => (
              <li key={chip.key}>
                <button type="button" className="fl__chip" onClick={() => removeChip(chip.key)}>
                  {chip.label}
                  <Icon name="close" size={13} />
                  <span className="sr-only">— убрать фильтр</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="fl__end">
          <a href="#map" className="btn btn-ghost btn-sm fl__map">
            <Icon name="map" size={16} />
            На карте
          </a>
          <label className="fl__sort">
            <span className="sr-only">Сортировка</span>
            <select
              className="select"
              value={params.get('sort') ?? 'RELEVANCE'}
              onChange={(e) => changeSort(e.target.value)}
            >
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {open && (
        <div className="fl__panel" id="filters-panel">
          <div className="fl__grid">
            <fieldset className="fl__set">
              <legend className="fl__legend">Цена за ночь или месяц, BYN</legend>
              <div className="fl__pair">
                <label className="field">
                  <span className="label">От</span>
                  <input
                    className="input"
                    inputMode="numeric"
                    value={priceMin}
                    onChange={(e) => setPriceMin(e.target.value)}
                    placeholder="0"
                  />
                </label>
                <label className="field">
                  <span className="label">До</span>
                  <input
                    className="input"
                    inputMode="numeric"
                    value={priceMax}
                    onChange={(e) => setPriceMax(e.target.value)}
                    placeholder="Любая"
                  />
                </label>
              </div>
            </fieldset>

            <fieldset className="fl__set">
              <legend className="fl__legend">Комнат</legend>
              <div className="fl__row">
                {['1', '2', '3', '4'].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className="chip chip-sm"
                    aria-pressed={rooms === n}
                    onClick={() => setRooms(rooms === n ? '' : n)}
                  >
                    {n}
                    {n === '4' ? '+' : ''}
                  </button>
                ))}
              </div>
            </fieldset>

            <fieldset className="fl__set">
              <legend className="fl__legend">Срок аренды</legend>
              <div className="fl__row">
                {DURATIONS.map((d) => (
                  <button
                    key={d.value}
                    type="button"
                    className="chip chip-sm"
                    aria-pressed={durationMode === d.value}
                    onClick={() => setDurationMode(durationMode === d.value ? '' : d.value)}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </fieldset>

            <fieldset className="fl__set">
              <legend className="fl__legend">Гостей</legend>
              <div className="fl__row">
                {['1', '2', '3', '4', '5', '6'].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className="chip chip-sm"
                    aria-pressed={guests === n}
                    onClick={() => setGuests(guests === n ? '' : n)}
                  >
                    {n}
                    {n === '6' ? '+' : ''}
                  </button>
                ))}
              </div>
            </fieldset>

            <fieldset className="fl__set fl__set--wide">
              <legend className="fl__legend">Тип жилья</legend>
              <div className="fl__row">
                {PROPERTY_TYPES.map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    className="chip chip-sm"
                    aria-pressed={types.has(t.value)}
                    onClick={() =>
                      setTypes((prev) => {
                        const copy = new Set(prev);
                        if (copy.has(t.value)) copy.delete(t.value);
                        else copy.add(t.value);
                        return copy;
                      })
                    }
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </fieldset>

            <fieldset className="fl__set">
              <legend className="fl__legend">Спальных мест, не меньше</legend>
              <div className="fl__row">
                {['1', '2', '3', '4', '6'].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className="chip chip-sm"
                    aria-pressed={beds === n}
                    onClick={() => setBeds(beds === n ? '' : n)}
                  >
                    {n}
                    {n === '6' ? '+' : ''}
                  </button>
                ))}
              </div>
            </fieldset>

            <fieldset className="fl__set">
              <legend className="fl__legend">Рейтинг хозяина</legend>
              <div className="fl__row">
                {['4', '4.5'].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className="chip chip-sm"
                    aria-pressed={rating === n}
                    onClick={() => setRating(rating === n ? '' : n)}
                  >
                    <Icon name="star" size={14} solid />
                    от {n}
                  </button>
                ))}
              </div>
            </fieldset>

            <fieldset className="fl__set fl__set--wide">
              <legend className="fl__legend">Правила и бронирование</legend>
              <div className="fl__row">
                <button type="button" className="chip chip-sm" aria-pressed={pets} onClick={() => setPets(!pets)}>
                  <Icon name="paw" size={15} />
                  Можно с животными
                </button>
                <button type="button" className="chip chip-sm" aria-pressed={children} onClick={() => setChildren(!children)}>
                  <Icon name="baby" size={15} />
                  Можно с детьми
                </button>
                <button type="button" className="chip chip-sm" aria-pressed={smoking} onClick={() => setSmoking(!smoking)}>
                  <Icon name="smoking" size={15} />
                  Можно курить
                </button>
                <button
                  type="button"
                  className="chip chip-sm"
                  aria-pressed={verified}
                  onClick={() => setVerified(!verified)}
                >
                  <Icon name="shieldCheck" size={15} />
                  Только проверенные
                </button>
                <button
                  type="button"
                  className="chip chip-sm"
                  aria-pressed={instant}
                  onClick={() => setInstant(!instant)}
                >
                  <Icon name="check" size={15} />
                  Мгновенное бронирование
                </button>
              </div>
            </fieldset>

            {visibleGroups.map((group) => (
              <fieldset key={group.category} className="fl__set fl__set--wide">
                <legend className="fl__legend">{group.label}</legend>
                <div className="fl__row">
                  {group.items.map((a) => (
                    <button
                      key={a.code}
                      type="button"
                      className="chip chip-sm"
                      aria-pressed={chosen.has(a.code)}
                      onClick={() => toggleAmenity(a.code)}
                    >
                      <Icon name={amenityIcon(a.icon)} size={15} />
                      {a.name_ru}
                    </button>
                  ))}
                </div>
              </fieldset>
            ))}

            {grouped.length > 2 && (
              <button
                type="button"
                className="link fl__more"
                onClick={() => setShowAllAmenities(!showAllAmenities)}
              >
                {showAllAmenities ? 'Свернуть удобства' : 'Показать все удобства'}
                <Icon name="chevronDown" size={15} style={{ rotate: showAllAmenities ? '180deg' : '0deg' }} />
              </button>
            )}
          </div>

          <div className="fl__actions">
            <button type="button" className="btn btn-ghost" onClick={reset}>
              Сбросить
            </button>
            <button type="button" className="btn btn-primary" onClick={apply}>
              Показать результаты
            </button>
          </div>
        </div>
      )}

      <style>{`
        .fl { display: grid; gap: var(--space-3); }
        .fl__bar { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
        .fl__toggle { gap: 0.4rem; }
        .fl__count {
          display: inline-grid; place-items: center;
          min-width: 1.25rem; height: 1.25rem; padding-inline: 0.25rem;
          border-radius: var(--radius-full);
          background: var(--primary); color: var(--text-on-primary);
          font-size: var(--text-2xs); font-weight: 700;
        }
        .fl__chips {
          display: flex; gap: var(--space-2); flex-wrap: wrap;
          list-style: none; margin: 0; padding: 0; min-width: 0;
        }
        .fl__chip {
          display: inline-flex; align-items: center; gap: 0.35rem;
          min-height: 2.125rem; padding: 0.3rem 0.7rem;
          border: 0; border-radius: var(--radius-full);
          background: var(--primary-soft); color: var(--primary);
          font: inherit; font-size: var(--text-xs); font-weight: 600;
          cursor: pointer;
        }
        .fl__chip:hover { background: var(--primary-soft-hover); }
        .fl__end { display: flex; align-items: center; gap: var(--space-2); margin-left: auto; }
        .fl__sort .select { min-height: 2.5rem; font-size: var(--text-sm); border-color: var(--border-strong); }
        /* The map lives below the listings on a phone; this is the way up to
           it. On desktop the map is already beside the results. */
        @media (min-width: 1024px) { .fl__map { display: none; } }

        .fl__panel {
          background: var(--surface);
          border-radius: var(--radius-md);
          padding: var(--space-5);
          box-shadow: var(--shadow-raised);
          display: grid;
          gap: var(--space-5);
        }
        .fl__grid {
          display: grid;
          gap: var(--space-5);
          grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
        }
        .fl__set { border: 0; margin: 0; padding: 0; min-width: 0; }
        .fl__set--wide { grid-column: 1 / -1; }
        .fl__legend {
          padding: 0;
          font-size: var(--text-sm); font-weight: 600;
          color: var(--text-secondary);
          margin-bottom: var(--space-3);
        }
        .fl__pair { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
        .fl__row { display: flex; flex-wrap: wrap; gap: var(--space-2); }
        .fl__more { grid-column: 1 / -1; justify-self: start; background: none; border: 0; cursor: pointer; font: inherit; }
        .fl__actions {
          display: flex; justify-content: flex-end; gap: var(--space-2);
          border-top: 1px solid var(--border);
          padding-top: var(--space-4);
        }
        @media (max-width: 560px) {
          .fl__end { width: 100%; margin-left: 0; }
          .fl__sort { flex: 1 1 auto; }
          .fl__actions > .btn { flex: 1 1 auto; }
        }
      `}</style>
    </div>
  );
}
