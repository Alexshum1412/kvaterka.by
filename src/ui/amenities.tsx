import { AMENITY_CATEGORY, Icon, amenityIcon } from './icons.tsx';

export interface AmenityRow {
  code: string;
  category: string;
  name_ru: string;
  icon: string | null;
}

export interface ConfirmedFact {
  confirmed: number;
  total: number;
}

/**
 * Amenities.
 *
 * A flat wall of pills is unreadable at twenty amenities and says nothing
 * about which ones a tenant actually decides on, so the list is grouped by
 * the vocabulary in icons.tsx and laid out as a scannable icon grid.
 *
 * The «подтвердили N из M» line is the point of the whole block: what a
 * landlord claims and what guests found are different facts, and merging
 * them would quietly destroy the only evidence a tenant has (spec §35).
 */
export function Amenities({
  rows,
  confirmedFacts,
}: {
  rows: readonly AmenityRow[];
  confirmedFacts?: Record<string, ConfirmedFact>;
}) {
  if (rows.length === 0) return null;

  const facts = confirmedFacts ?? {};

  const grouped = new Map<string, AmenityRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.category);
    if (list) list.push(row);
    else grouped.set(row.category, [row]);
  }

  const groups = [...grouped.entries()]
    .map(([category, items]) => ({
      category,
      items,
      label: AMENITY_CATEGORY[category]?.label ?? 'Прочее',
      // An amenity category added to the database before it is added to the
      // vocabulary still renders, at the end, instead of disappearing.
      order: AMENITY_CATEGORY[category]?.order ?? 99,
    }))
    .sort((a, b) => a.order - b.order);

  const hasEvidence = rows.some((row) => (facts[row.code]?.total ?? 0) > 0);

  return (
    <div className="amn">
      {groups.map((group) => (
        <div key={group.category} className="amn__group">
          <h3 className="amn__cat">{group.label}</h3>
          <ul className="amn__grid">
            {group.items.map((item) => {
              const fact = facts[item.code];
              return (
                <li key={item.code} className="amn__item">
                  <Icon name={amenityIcon(item.icon)} size={20} className="amn__icon" />
                  <span className="amn__body">
                    <span className="amn__name">{item.name_ru}</span>
                    {fact && fact.total > 0 && (
                      <span className="amn__confirm">
                        <Icon name="checkCircle" size={13} />
                        подтвердили {fact.confirmed} из {fact.total}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      {hasEvidence && (
        <p className="hint amn__note">
          Отметку «подтвердили» ставят гости после завершённой аренды — это их наблюдение, а не
          обещание хозяина.
        </p>
      )}

      <style>{`
        .amn { display: grid; gap: var(--space-5); }
        .amn__cat {
          font-size: var(--text-sm);
          font-weight: 600;
          color: var(--text-secondary);
          margin-bottom: var(--space-3);
        }
        .amn__grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
          gap: var(--space-3) var(--space-4);
          margin: 0;
          padding: 0;
          list-style: none;
        }
        .amn__item { display: flex; gap: 0.625rem; align-items: flex-start; min-width: 0; }
        .amn__icon { color: var(--text-tertiary); margin-top: 0.125rem; }
        .amn__body { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; }
        .amn__name { font-size: var(--text-sm); line-height: 1.4; }
        .amn__confirm {
          display: inline-flex;
          align-items: center;
          gap: 0.25rem;
          font-size: var(--text-2xs);
          font-weight: 600;
          color: var(--success);
        }
        .amn__note { max-width: 56ch; }
      `}</style>
    </div>
  );
}
