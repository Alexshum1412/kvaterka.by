import { describe, expect, it } from 'vitest';
import { contactExchangeAllowed, filterMessage, type DetectorName } from './contact-filter.ts';

const flagged = (s: string) => filterMessage(s).decision !== 'ALLOW';
const detectors = (s: string): DetectorName[] => [...filterMessage(s).detectors].sort();

/* ================================================================== *
 * MUST NOT FLAG — ordinary Belarusian rental conversation.
 *
 * These matter more than the detections. A filter that mangles "квартира 42,
 * 5 этаж" trains users to distrust the chat, and they leave the platform for
 * exactly the reason the filter exists to prevent.
 * ================================================================== */

describe('ordinary rental chat passes untouched', () => {
  const innocent = [
    'Квартира 42, 5 этаж, лифт есть',
    'Заезд в 14:00, выезд до 12:00',
    'Площадь 50 м², две комнаты',
    'Площадь 62.5 м2, кухня отдельная',
    'Дом 12, подъезд 3, код от домофона скажу после подтверждения',
    'Цена 1 200 BYN в месяц, коммуналка отдельно',
    'Стоимость 90 руб. за сутки',
    'Можно заехать 5 сентября и выехать 12 сентября?',
    'Даты 01.09.2026 - 10.09.2026 свободны',
    'Мы приедем вдвоём, 2 гостя, на 7 ночей',
    'Этаж 7 из 9, окна во двор',
    'Кватэра 15, пяты паверх, ліфт ёсць',
    'Плошча 48 м², дзве пакоі',
    'Заезд у 15:00, выезд да 11:00',
    'Ваш номер бронирования KV-7Q2M-9XTB',
    'Скидка 10% при бронировании на месяц',
    'В квартире 3 спальных места и 1 диван',
    'Метро в 8 минутах пешком',
    'Депозит 300 у.е., возвращается при выезде',
    'Wi-Fi есть, скорость около 100 мбит',
    'Тихий час с 23:00 до 7:00',
    'Дом 2026 года постройки',
    'Можем встретиться в 18:30 у подъезда',
    'Квартира на 4 человека, есть детская кроватка',
  ];

  it.each(innocent)('allows: %s', (text) => {
    const r = filterMessage(text);
    expect(
      r.decision,
      `FALSE POSITIVE on "${text}" — detectors: ${r.detectors.join(', ')}, matched: ${r.matches
        .map((m) => JSON.stringify(m.text))
        .join(' | ')}`,
    ).toBe('ALLOW');
  });

  it('leaves the text exactly as written', () => {
    const text = 'Квартира 42, 5 этаж, заезд в 14:00, площадь 50 м²';
    expect(filterMessage(text).sanitized).toBe(text);
  });
});

/* ================================================================== *
 * MUST FLAG — phone numbers, in every shape people actually use.
 * ================================================================== */

describe('phone numbers', () => {
  const phones = [
    'Звоните +375 29 123-45-67',
    'Мой номер 375291234567',
    'тел. 8 029 123 45 67',
    '+3 7 5 2 9 1 2 3 4 5 6 7 — звоните в любое время',
    'Телефон: 29-123-45-67',
    'Набирайте 80291234567',
    'номер +375(29)1234567',
    'звони 375*29*123*45*67',
    'мой моб 44 123 45 67',
    'my number is 375 33 765 43 21',
  ];

  it.each(phones)('detects: %s', (text) => {
    expect(flagged(text), `MISSED phone in "${text}"`).toBe(true);
  });

  it('redacts the number but keeps the rest of the message readable', () => {
    const r = filterMessage('Звоните +375 29 123-45-67 после 18:00');
    expect(r.decision).toBe('REDACT');
    expect(r.sanitized).toContain('Звоните');
    expect(r.sanitized).toContain('18:00');
    expect(r.sanitized).not.toMatch(/\d{7,}/);
    expect(r.sanitized).toContain('[контакт скрыт]');
  });

  it('catches a number spelled out in Russian words', () => {
    expect(detectors('три семь пять два девять один два три')).toContain('PHONE_SPELLED_OUT');
  });

  it('catches a number spelled out in Belarusian words', () => {
    expect(detectors('тры сем пяць дзве дзевяць адзін')).toContain('PHONE_SPELLED_OUT');
  });

  it('does not treat a couple of number words as a phone', () => {
    // "два три" is a normal phrase, not a phone number.
    expect(filterMessage('можно на два или три дня').decision).toBe('ALLOW');
  });

  it('sees through zero-width characters inserted between digits', () => {
    const sneaky = '375​29​123​45​67';
    expect(flagged(sneaky)).toBe(true);
  });
});

/* ================================================================== */

describe('email addresses', () => {
  const emails = [
    'пишите на ivan.petrov@gmail.com',
    'моя почта: landlord2026@mail.ru',
    'ivan (собака) mail точка ru',
    'ivan at gmail dot com',
    'contact: owner@example.by',
  ];

  it.each(emails)('detects: %s', (text) => {
    expect(flagged(text), `MISSED email in "${text}"`).toBe(true);
  });

  it('does not mistake a price for an email', () => {
    expect(filterMessage('90 руб/сутки, всё включено').decision).toBe('ALLOW');
  });
});

/* ================================================================== */

describe('messengers and handles', () => {
  it('detects a telegram handle', () => {
    expect(detectors('пишите в телеграм @minsk_flats_2026')).toContain('HANDLE');
  });

  it('detects a t.me link', () => {
    expect(flagged('вот ссылка t.me/minskflats')).toBe(true);
  });

  it('detects a handle hidden with Cyrillic lookalike letters', () => {
    // "tеlеgram" here uses Cyrillic е — visually identical, byte-wise different.
    expect(flagged('пишите в tеlеgram @ivan_minsk')).toBe(true);
  });

  it('detects WhatsApp and Viber written in Russian', () => {
    expect(flagged('есть вайбер? напишите +375291234567')).toBe(true);
    expect(detectors('ватсап тот же номер')).toContain('MESSENGER_KEYWORD');
  });

  it('only flags a bare messenger question rather than redacting it', () => {
    // No contact detail is actually present, so the message goes through
    // unchanged and is recorded for pattern analysis.
    const r = filterMessage('а вайбер у вас есть?');
    expect(r.decision).toBe('FLAG');
    expect(r.sanitized).toBe('а вайбер у вас есть?');
  });

  it('does not flag an email-shaped word inside a normal sentence', () => {
    expect(filterMessage('встретимся у подъезда').decision).toBe('ALLOW');
  });
});

/* ================================================================== */

describe('links', () => {
  const links = [
    'подробнее на https://kufar.by/item/123',
    'смотрите www.example.by/flat',
    'мой сайт example.by',
    'инстаграм тут instagram.com/minskflats',
    'пишите мне вконтакте vk.com/ivan',
    'сайт example точка бай',
  ];

  it.each(links)('detects: %s', (text) => {
    expect(flagged(text), `MISSED link in "${text}"`).toBe(true);
  });

  it('does not treat a decimal number as a domain', () => {
    expect(filterMessage('площадь 62.5 м2').decision).toBe('ALLOW');
  });

  it('does not treat a price with a decimal as a domain', () => {
    expect(filterMessage('итого 1250.50 BYN').decision).toBe('ALLOW');
  });
});

/* ================================================================== */

describe('escalation', () => {
  it('blocks a message that is a deliberate multi-channel handoff', () => {
    const r = filterMessage(
      'Давайте не через сайт: телеграм @ivan_minsk, почта ivan@mail.ru, телефон +375291234567',
    );
    expect(r.decision).toBe('BLOCK');
    expect(r.detectors.length).toBeGreaterThanOrEqual(3);
  });

  it('redacts a single lapse rather than blocking it', () => {
    expect(filterMessage('звоните +375291234567').decision).toBe('REDACT');
  });

  it('reports which detectors fired so the rule can be tuned', () => {
    const r = filterMessage('телеграм @ivan_minsk');
    expect(r.detectors).toContain('HANDLE');
    expect(r.matches.every((m) => m.confidence > 0)).toBe(true);
  });

  it('explains itself to the sender', () => {
    expect(filterMessage('+375291234567').reason).toMatch(/подтверждения/);
    expect(filterMessage('+375291234567', { locale: 'en' }).reason).toMatch(/confirmed/);
    expect(filterMessage('+375291234567', { locale: 'be' }).reason).toMatch(/пацвярджэння/);
  });
});

/* ================================================================== */

describe('after contact release', () => {
  it('stops filtering once the booking is confirmed', () => {
    const text = 'Мой номер +375 29 123-45-67, звоните перед заездом';
    const r = filterMessage(text, { contactReleased: true });
    expect(r.decision).toBe('ALLOW');
    expect(r.sanitized).toBe(text);
    expect(r.matches).toEqual([]);
  });

  it('permits contact exchange only from a confirmed booking onwards', () => {
    for (const s of ['CONFIRMED', 'CHECKED_IN', 'COMPLETION_PENDING', 'COMPLETED', 'DISPUTED']) {
      expect(contactExchangeAllowed(s)).toBe(true);
    }
    for (const s of ['INQUIRY', 'REQUESTED', 'OFFER_PENDING', 'DECLINED', 'EXPIRED', 'WITHDRAWN']) {
      expect(contactExchangeAllowed(s)).toBe(false);
    }
    expect(contactExchangeAllowed(null)).toBe(false);
  });
});

/* ================================================================== */

describe('robustness', () => {
  it('handles an empty message', () => {
    expect(filterMessage('').decision).toBe('ALLOW');
  });

  it('handles a very long message without pathological slowdown', () => {
    const text = 'Квартира 42, 5 этаж, заезд в 14:00. '.repeat(500);
    const started = performance.now();
    const r = filterMessage(text);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(r.decision).toBe('ALLOW');
  });

  it('finds a phone buried in a long innocent message', () => {
    const text = `${'Квартира тихая, окна во двор. '.repeat(100)}звоните +375291234567`;
    expect(flagged(text)).toBe(true);
  });

  it('never returns overlapping redactions', () => {
    const r = filterMessage('ivan@mail.ru и +375291234567 и t.me/ivan');
    expect(r.sanitized).not.toMatch(/\[контакт скрыт\]\s*\[контакт скрыт\]\[/);
  });

  it('is deterministic', () => {
    const text = 'телеграм @ivan_minsk или +375291234567';
    const a = filterMessage(text);
    const b = filterMessage(text);
    expect(a.sanitized).toBe(b.sanitized);
    expect(a.decision).toBe(b.decision);
  });
});
