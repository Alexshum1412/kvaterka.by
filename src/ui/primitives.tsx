/**
 * Shared UI primitives.
 *
 * Small and unclever on purpose: these wrap the CSS component classes in
 * globals.css so screens compose from one vocabulary instead of accumulating
 * per-page styles.
 */

import type { ReactNode } from 'react';
import { formatMoney, fromStorage } from '@/server/domain/money.ts';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/* ------------------------------------------------------------------ */

export function Money({
  minor,
  className,
  showCurrency = true,
}: {
  minor: string | bigint;
  className?: string;
  showCurrency?: boolean;
}) {
  // Money arrives as a decimal string of minor units and is formatted once,
  // here. No component multiplies or divides an amount.
  return (
    <span className={cx('numeric', className)}>{formatMoney(fromStorage(minor), { showCurrency })}</span>
  );
}

export function Badge({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'verified' | 'warning' | 'danger' | 'primary';
  title?: string;
}) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

/**
 * Verification badges. Wording is deliberately literal: "Личность
 * подтверждена" and "Объект проверен" are different claims and must never be
 * merged into a vague "Verified" that overstates what was checked (spec §16).
 */
export function VerificationBadges({
  identityLevel,
  propertyVerified,
}: {
  identityLevel: number;
  propertyVerified: boolean;
}) {
  return (
    <span className="row" style={{ gap: '0.375rem', flexWrap: 'wrap' }}>
      {identityLevel >= 1 ? (
        <Badge tone="verified" title="Платформа проверила документы, удостоверяющие личность">
          Личность подтверждена
        </Badge>
      ) : (
        <Badge tone="warning" title="Подтверждены только телефон и email">
          Документы не проверены
        </Badge>
      )}
      {propertyVerified && (
        <Badge tone="verified" title="Платформа проверила право сдавать этот объект">
          Объект проверен
        </Badge>
      )}
    </span>
  );
}

/* ------------------------------------------------------------------ */

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div
      className="panel stack"
      style={{ alignItems: 'center', textAlign: 'center', gap: '0.75rem', padding: '3rem 1.5rem' }}
    >
      <h3 style={{ fontSize: 'var(--text-lg)' }}>{title}</h3>
      {description && (
        <p style={{ color: 'var(--text-secondary)', maxWidth: '38ch', fontSize: 'var(--text-sm)' }}>{description}</p>
      )}
      {action}
    </div>
  );
}

export function ErrorState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="panel stack" role="alert" style={{ gap: '0.5rem', borderColor: 'var(--error)' }}>
      <strong>{title}</strong>
      {/* Users get a plain explanation and a next step, never a stack trace. */}
      {detail && <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>{detail}</p>}
    </div>
  );
}

export function CardSkeleton() {
  return (
    <div className="card stack" aria-hidden="true" style={{ overflow: 'hidden' }}>
      <div className="skeleton" style={{ aspectRatio: '4 / 3', borderRadius: 0 }} />
      <div className="stack" style={{ gap: '0.5rem', padding: '0.875rem' }}>
        <div className="skeleton" style={{ height: '0.9rem', width: '70%' }} />
        <div className="skeleton" style={{ height: '0.75rem', width: '45%' }} />
        <div className="skeleton" style={{ height: '1.1rem', width: '35%' }} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

/** Calendar freshness, shown to tenants as a trust signal (spec §24). */
export function FreshnessIndicator({ freshness }: { freshness: 'FRESH' | 'AGEING' | 'STALE' }) {
  const config = {
    FRESH: { tone: 'verified' as const, label: 'Календарь обновлён недавно' },
    AGEING: { tone: 'neutral' as const, label: 'Календарь обновлялся давно' },
    STALE: { tone: 'warning' as const, label: 'Календарь может быть неактуален' },
  }[freshness];
  return <Badge tone={config.tone}>{config.label}</Badge>;
}

/** Human-readable rental duration, in Russian, with correct plural forms. */
export function formatNights(nights: number): string {
  if (nights >= 365) {
    const years = Math.round(nights / 365);
    return `${years} ${plural(years, 'год', 'года', 'лет')}`;
  }
  if (nights >= 30) {
    const months = Math.round(nights / 30);
    return `${months} ${plural(months, 'месяц', 'месяца', 'месяцев')}`;
  }
  return `${nights} ${plural(nights, 'ночь', 'ночи', 'ночей')}`;
}

/**
 * Duration in the genitive case, for "от X до Y" phrasing.
 *
 * Russian requires the genitive after «от» and «до»: "от 2 ночей до 3 месяцев",
 * not "от 2 ночи до 3 месяца". Numbers ending in 1 (but not 11) take the
 * genitive singular — "от 1 ночи".
 */
export function formatNightsGenitive(nights: number): string {
  const endsInOne = nights % 10 === 1 && nights % 100 !== 11;
  if (nights >= 365) {
    const years = Math.round(nights / 365);
    return `${years} ${years % 10 === 1 && years % 100 !== 11 ? 'года' : 'лет'}`;
  }
  if (nights >= 30) {
    const months = Math.round(nights / 30);
    return `${months} ${months % 10 === 1 && months % 100 !== 11 ? 'месяца' : 'месяцев'}`;
  }
  return `${nights} ${endsInOne ? 'ночи' : 'ночей'}`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

export const PROPERTY_TYPE_LABEL: Record<string, string> = {
  APARTMENT: 'Квартира',
  ROOM: 'Комната',
  HOUSE: 'Дом',
  COTTAGE: 'Коттедж',
  STUDIO: 'Студия',
  TOWNHOUSE: 'Таунхаус',
};

export const BOOKING_STATUS_LABEL: Record<string, string> = {
  INQUIRY: 'Вопрос',
  REQUESTED: 'Запрос отправлен',
  OFFER_PENDING: 'Обсуждение условий',
  DECLINED: 'Отклонено',
  WITHDRAWN: 'Отозвано',
  EXPIRED: 'Истекло',
  CONFIRMED: 'Подтверждено',
  CHECKED_IN: 'Заселение состоялось',
  COMPLETION_PENDING: 'Ожидает подтверждения',
  COMPLETED: 'Завершено',
  NOT_TAKEN_PLACE: 'Не состоялось',
  CANCELLED_BY_TENANT: 'Отменено арендатором',
  CANCELLED_BY_LANDLORD: 'Отменено хозяином',
  DISPUTED: 'Спор',
};

export function bookingTone(status: string): 'neutral' | 'verified' | 'warning' | 'danger' | 'primary' {
  if (status === 'COMPLETED' || status === 'CONFIRMED' || status === 'CHECKED_IN') return 'verified';
  if (status === 'DISPUTED') return 'danger';
  if (status.startsWith('CANCELLED') || status === 'DECLINED' || status === 'EXPIRED') return 'neutral';
  if (status === 'COMPLETION_PENDING' || status === 'REQUESTED') return 'warning';
  return 'primary';
}
