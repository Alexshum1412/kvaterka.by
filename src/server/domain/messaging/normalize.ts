/**
 * Text normalisation for contact detection.
 *
 * Kept separate from the detectors because normalisation is where almost all of
 * the evasion resistance lives, and because the safe-span masking below is what
 * keeps ordinary Belarusian rental chat from being flagged.
 *
 * IMPORTANT (learned the hard way): JavaScript's `\b` is defined over ASCII word
 * characters only, so `/\bвайбер\b/` never matches — Cyrillic letters are not
 * "word characters" and the boundary assertion fails at both ends. Every pattern
 * in this file therefore uses the explicit Unicode boundaries below instead.
 */

/** Left/right word boundaries that understand Cyrillic. Require the `u` flag. */
export const LB = '(?<![\\p{L}\\p{N}_])';
export const RB = '(?![\\p{L}\\p{N}_])';

const u = (source: string, flags = 'gu'): RegExp => new RegExp(source, flags);

/**
 * Cyrillic letters that are visually identical to Latin ones. "tеlegram" with a
 * Cyrillic е renders identically and defeats a naive keyword match, so the
 * detectors that look for Latin words fold these first.
 *
 * Folding is applied ONLY inside the latin-oriented detectors: applying it to
 * the whole message would mangle real Russian words.
 */
const CYRILLIC_TO_LATIN: ReadonlyMap<string, string> = new Map(
  Object.entries({
    а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p',
    с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ѕ: 's', ј: 'j', һ: 'h', ԁ: 'd',
    ԛ: 'q', ԝ: 'w', ɡ: 'g', з: '3', ч: '4', б: '6',
  }),
);

export function foldHomoglyphs(input: string): string {
  let out = '';
  for (const ch of input) out += CYRILLIC_TO_LATIN.get(ch) ?? ch;
  return out;
}

/**
 * Unicode-normalise, strip zero-width characters, and collapse whitespace.
 * Zero-width joiners are a favourite way to break a phone number up invisibly.
 */
export function normalize(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '') // zero-width & soft hyphen
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

export interface Span {
  readonly start: number;
  readonly end: number;
  readonly reason: string;
}

/**
 * Patterns that look numeric but are perfectly ordinary rental conversation.
 * These are masked out BEFORE any phone heuristic runs — the single most
 * important defence against false positives, and the spec names exactly these
 * cases (§26).
 *
 * Every date/time pattern is deliberately strict about its components. An
 * earlier, looser version matched "123-45-67" as a date and silently swallowed
 * half the phone numbers in the corpus.
 */
const SAFE_PATTERNS: readonly { re: RegExp; reason: string }[] = [
  // Time: 12:00, 14.00. Rejects 62.5 (needs two digits after the separator)
  // and refuses to start or end mid-number.
  { re: u('(?<![\\d:.])\\d{1,2}[:.]\\d{2}(?![\\d:.])'), reason: 'TIME' },

  // ISO date: 2026-09-01
  {
    re: u('(?<![\\d./-])(?:19|20)\\d{2}[./-](?:0?[1-9]|1[0-2])[./-](?:0?[1-9]|[12]\\d|3[01])(?![\\d./-])'),
    reason: 'DATE',
  },
  // Day-first date: 01.09.2026, 1/9/26
  {
    re: u('(?<![\\d./-])(?:0?[1-9]|[12]\\d|3[01])[./-](?:0?[1-9]|1[0-2])[./-](?:19|20)?\\d{2}(?![\\d./-])'),
    reason: 'DATE',
  },

  // Day + month name (ru/be): "5 сентября", "12 верасня"
  {
    re: u(
      LB +
        '\\d{1,2}\\s?(?:янв|фев|мар|апр|мая|май|июн|июл|авг|сен|окт|ноя|дек|студз|лют|сакав|красав|траўн|чэрв|ліп|жніў|верас|кастр|лістап|снеж)\\p{L}*',
      'giu',
    ),
    reason: 'DATE_WORD',
  },

  // "кв. 42", "этаж 5", "дом 12", "подъезд 3"
  {
    re: u(
      LB +
        '(?:кв|квартира|кватэра|дом|д|под[ʼ\'’]?езд|пад[ʼ\'’]?езд|этаж|паверх|корпус|комната|пакой|номер|нумар)\\s*\\.?\\s*№?\\s*\\d{1,4}' +
        RB,
      'giu',
    ),
    reason: 'ADDRESS_PART',
  },
  // Reversed word order: "42 квартира", "5 этаж"
  {
    re: u(
      LB + '\\d{1,4}\\s*(?:кв|квартира|кватэра|этаж|паверх|комната|пакой|под[ʼ\'’]?езд|пад[ʼ\'’]?езд)' + RB,
      'giu',
    ),
    reason: 'ADDRESS_PART',
  },

  // Area: "50 м²" (NFKC turns ² into 2), "50 кв.м"
  {
    re: u(LB + '\\d{1,4}(?:[.,]\\d{1,2})?\\s*(?:м2|м²|кв\\.?\\s?м|м\\.\\s?кв)' + RB, 'giu'),
    reason: 'AREA',
  },

  // Money: "1 200 BYN", "90 руб.", "300 у.е."
  {
    re: u(
      LB +
        '\\d[\\d\\s.,]{0,12}?\\s*(?:byn|byr|руб|рублей|рубля|бел\\.?\\s?руб|usd|eur|у\\.?\\s?е\\.?)' +
        RB,
      'giu',
    ),
    reason: 'MONEY',
  },
  { re: u('[$€]\\s?\\d[\\d\\s.,]*'), reason: 'MONEY' },

  // Counts: "2 комнаты", "7 ночей", "4 человека", "100 мбит"
  {
    re: u(
      LB +
        '\\d{1,4}\\s*(?:комнат|пако|гост|чалавек|человек|ноч|сут|дней|дзён|дня|дней|месяц|месяцаў|год|года|лет|спальн|мбит|мбіт|минут|мин|хвілін|км|метр)\\p{L}*',
      'giu',
    ),
    reason: 'COUNT',
  },

  // Floor written as "5/9"
  { re: u('(?<![\\d/])\\d{1,2}\\s?/\\s?\\d{1,2}(?![\\d/])'), reason: 'FLOOR_OF' },

  // The platform's own booking references, e.g. KV-7Q2M-9XTB
  { re: u(LB + 'KV-[A-Z0-9]{4}-[A-Z0-9]{4}' + RB, 'gu'), reason: 'BOOKING_REF' },

  // Percentages
  { re: u(LB + '\\d{1,3}\\s?%'), reason: 'PERCENT' },
];

/** Find the spans that must not be treated as contact information. */
export function findSafeSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const { re, reason } of SAFE_PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      if (m.index === undefined) continue;
      spans.push({ start: m.index, end: m.index + m[0].length, reason });
    }
  }
  return mergeSpans(spans);
}

export function mergeSpans(spans: readonly Span[]): Span[] {
  if (spans.length === 0) return [];
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Span[] = [{ ...sorted[0]! }];
  for (const s of sorted.slice(1)) {
    const last = out[out.length - 1]!;
    if (s.start <= last.end) {
      if (s.end > last.end) out[out.length - 1] = { ...last, end: s.end };
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/**
 * Replace safe spans with a filler of the same length, preserving every offset
 * so that matches found afterwards still point at the right characters.
 */
export function maskSpans(text: string, spans: readonly Span[], filler = ''): string {
  if (spans.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const s of mergeSpans(spans)) {
    out += text.slice(cursor, s.start) + filler.repeat(s.end - s.start);
    cursor = s.end;
  }
  return out + text.slice(cursor);
}

/** Digit words in Russian and Belarusian, used to spell a number out loud. */
export const DIGIT_WORDS: ReadonlyMap<string, string> = new Map(
  Object.entries({
    ноль: '0', нуль: '0', зеро: '0',
    один: '1', адзін: '1', адзин: '1',
    два: '2', две: '2', дзве: '2',
    три: '3', тры: '3',
    четыре: '4', чатыры: '4',
    пять: '5', пяць: '5',
    шесть: '6', шэсць: '6',
    семь: '7', сем: '7',
    восемь: '8', восем: '8',
    девять: '9', дзевяць: '9',
  }),
);
