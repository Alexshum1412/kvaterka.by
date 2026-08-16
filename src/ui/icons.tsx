/**
 * The icon system.
 *
 * ONE family, defined once. Every glyph is a 24×24 outline drawn with a
 * 1.6 stroke in currentColor, round caps and joins — which is the whole
 * point: the previous interface mixed emoji, arrow characters (→), a
 * filled star and ad-hoc inline SVGs, and that mixture is a large part
 * of why it read as assembled rather than designed.
 *
 * Paths live in a map rather than in separate components so the geometry
 * cannot drift between them. Two glyphs are allowed to fill — star and
 * heart — because a rating and a saved item are states, and an outline
 * cannot express "on" as clearly as a solid can.
 *
 * Amenity glyphs are keyed by the `icon` column of the `amenity` table,
 * so the database stays the source of truth and an unknown key degrades
 * to a neutral dot instead of throwing.
 */

import type { SVGProps } from 'react';

/* ------------------------------------------------------------------ *
 * Paths
 * ------------------------------------------------------------------ */

const PATHS = {
  /* --- navigation & controls --- */
  search: ['M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0', 'm20.5 20.5-4.2-4.2'],
  pin: ['M12 21s7-5.3 7-11a7 7 0 1 0-14 0c0 5.7 7 11 7 11Z', 'M14.5 10a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0'],
  heart: ['M12 20.3 4.7 13a4.6 4.6 0 0 1 6.5-6.5l.8.8.8-.8A4.6 4.6 0 1 1 19.3 13Z'],
  star: ['m12 3.6 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9Z'],
  check: ['m5 12.5 4.5 4.5L19 7.5'],
  checkCircle: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0', 'm8.4 12.2 2.4 2.4 4.8-4.8'],
  shieldCheck: ['M12 3 5 6v5.4c0 4.2 2.9 8.2 7 9.6 4.1-1.4 7-5.4 7-9.6V6Z', 'm9.2 12 2 2 3.6-3.6'],
  calendar: [
    'M5.5 5h13A1.5 1.5 0 0 1 20 6.5v12a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-12A1.5 1.5 0 0 1 5.5 5Z',
    'M4 9.5h16',
    'M8 3v3M16 3v3',
  ],
  users: [
    'M16 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20',
    'M13 7a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0',
    'M17 3.8a3.5 3.5 0 0 1 0 6.4',
    'M21 20v-1.5a4 4 0 0 0-3-3.9',
  ],
  sliders: [
    'M4 7h16M4 12h16M4 17h16',
    'M11 7a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
    'M17 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
    'M13 17a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
  ],
  arrowRight: ['M4 12h15', 'm13 6 6 6-6 6'],
  arrowLeft: ['M20 12H5', 'm11 18-6-6 6-6'],
  chevronDown: ['m6 9.5 6 6 6-6'],
  chevronRight: ['m9.5 6 6 6-6 6'],
  close: ['M6 6l12 12M18 6 6 18'],
  map: ['m9 4-5.5 2.2v13.6L9 17.6l6 2.2 5.5-2.2V4L15 6.2Z', 'M9 4v13.6M15 6.2v13.6'],
  list: ['M4 6.5h16M4 12h16M4 17.5h16'],
  plus: ['M12 5v14M5 12h14'],
  edit: ['M4 20h4L19.1 8.9a2.1 2.1 0 0 0-3-3L5 17Z', 'm14.6 6.4 3 3'],
  message: ['M20.5 12a7.6 7.6 0 0 1-11.2 6.7L4 20.2l1.5-5.1A7.6 7.6 0 1 1 20.5 12Z'],
  bell: ['M18 9.5a6 6 0 0 0-12 0c0 4.6-2 6-2 6h16s-2-1.4-2-6', 'M13.8 19a2 2 0 0 1-3.6 0'],
  home: ['m3 11 9-7 9 7', 'M6 9.6V20h12V9.6'],
  clock: ['M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0', 'M12 7.4V12l3 1.8'],
  info: ['M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0', 'M12 11.2v5', 'M12 8h.01'],
  alert: ['M12 4 2.6 20h18.8Z', 'M12 10v4', 'M12 17.4h.01'],
  image: [
    'M4.5 5h15A1.5 1.5 0 0 1 21 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-11A1.5 1.5 0 0 1 4.5 5Z',
    'm3.4 16.6 4.6-4.6 4 4 3-3 5.6 5.6',
    'M10 9.4a1.3 1.3 0 1 1-2.6 0 1.3 1.3 0 0 1 2.6 0',
  ],
  eye: ['M2.6 12S6.4 5.8 12 5.8 21.4 12 21.4 12 17.6 18.2 12 18.2 2.6 12 2.6 12Z', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0'],

  /* --- property facts --- */
  rooms: ['M6 21V4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21', 'M4 21h16', 'M14.5 12.4h.01'],
  area: [
    'M3.8 14.4 14.4 3.8a1.5 1.5 0 0 1 2.1 0l3.7 3.7a1.5 1.5 0 0 1 0 2.1L9.6 20.2a1.5 1.5 0 0 1-2.1 0l-3.7-3.7a1.5 1.5 0 0 1 0-2.1Z',
    'm7.4 10.8 1.8 1.8M10.7 7.5l1.8 1.8M4.1 14.1l1.8 1.8',
  ],
  floors: [
    'M5 21V4.5A1.5 1.5 0 0 1 6.5 3h7A1.5 1.5 0 0 1 15 4.5V21',
    'M15 10.5h3.5A1.5 1.5 0 0 1 20 12v9',
    'M3 21h18',
    'M8.5 7h3M8.5 11h3M8.5 15h3',
  ],
  bed: ['M2.5 20v-8a2 2 0 0 1 2-2h15a2 2 0 0 1 2 2v8', 'M2.5 16h19', 'M6.5 10V7.2a1.2 1.2 0 0 1 1.2-1.2h8.6a1.2 1.2 0 0 1 1.2 1.2V10'],

  /* --- amenity glyphs, keyed by amenity.icon --- */
  wifi: ['M2.6 9.2a15 15 0 0 1 18.8 0', 'M6 12.6a10 10 0 0 1 12 0', 'M9.4 16a5 5 0 0 1 5.2 0', 'M12 19.4h.01'],
  heater: ['M4.5 5h13a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-13Z', 'M8.5 5v14M12.5 5v14M16.5 5v14'],
  snowflake: ['M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9', 'm9 4.8 3 2 3-2M9 19.2l3-2 3 2'],
  droplet: ['M12 21a6 6 0 0 0 6-6c0-4-6-12-6-12S6 11 6 15a6 6 0 0 0 6 6Z'],
  flame: ['M12 21a6 6 0 0 0 6-6c0-4.2-3.1-5.6-3.6-9.6-2 1.5-3 3.6-3 5.6C10.2 9.2 9.2 7.6 9.2 7.6S6 10 6 15a6 6 0 0 0 6 6Z'],
  'chef-hat': ['M6.6 13.8A4 4 0 1 1 9.7 7a4.2 4.2 0 0 1 7.8 1.3 4 4 0 0 1-.1 5.5V18h-10.8Z', 'M6.6 21h10.8'],
  box: [
    'M5 3.5h14A1.5 1.5 0 0 1 20.5 5v14a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V5A1.5 1.5 0 0 1 5 3.5Z',
    'M3.5 10h17',
    'M7 6.4v1.4M7 13v2',
  ],
  oven: [
    'M4.5 4h15A1.5 1.5 0 0 1 21 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5v-13A1.5 1.5 0 0 1 4.5 4Z',
    'M3 9h18',
    'M7 6.5h.01M10 6.5h.01',
    'M7.5 12h9v5.5h-9Z',
  ],
  dishes: [
    'M4.5 3.5h15A1.5 1.5 0 0 1 21 5v14a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 19V5a1.5 1.5 0 0 1 1.5-1.5Z',
    'M3 8h18',
    'M7 5.6h.01M10 5.6h.01',
    'M16 14a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  ],
  cup: ['M5 8h11v5.2A5.5 5.5 0 0 1 5 13.2Z', 'M16 9.2h1.8a2.2 2.2 0 0 1 0 4.4H16', 'M4 20.5h13'],
  coffee: ['M5 8h11v5.2A5.5 5.5 0 0 1 5 13.2Z', 'M16 9.2h1.8a2.2 2.2 0 0 1 0 4.4H16', 'M4 20.5h13', 'M8 3.6v1.8M12 3.6v1.8'],
  washer: [
    'M5 3.5h14A1.5 1.5 0 0 1 20.5 5v14a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V5A1.5 1.5 0 0 1 5 3.5Z',
    'M3.5 8h17',
    'M7 5.7h.01M10 5.7h.01',
    'M16.5 14a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0',
  ],
  wind: ['M3 8h9.5a3 3 0 1 0-3-3', 'M3 12h10.5a3 3 0 1 1-3 3', 'M3 16h7'],
  bath: ['M4 12.5h16v2.6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4Z', 'M6.6 12.5V6.6A2.6 2.6 0 0 1 9.2 4h.2a2.6 2.6 0 0 1 2.6 2.6', 'm7 19.1-1 2M17 19.1l1 2'],
  shower: ['M5 21v-9.5a4.5 4.5 0 0 1 4.5-4.5', 'm13.4 4.2 5.4 5.4', 'M9.5 14h.01M12.5 16.4h.01M15.5 14h.01'],
  soap: ['M7 10.2h10V19a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2Z', 'M10 10.2V6.6A1.6 1.6 0 0 1 11.6 5h1A1.6 1.6 0 0 1 14.2 6.6v3.6', 'M10 15h4'],
  towel: ['M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z', 'M6 3a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3'],
  desk: ['M4 6.6A1.6 1.6 0 0 1 5.6 5h12.8A1.6 1.6 0 0 1 20 6.6V16H4Z', 'M2 19h20'],
  tv: ['M4 7.6h16A1.6 1.6 0 0 1 21.6 9.2v7.6A1.6 1.6 0 0 1 20 18.4H4a1.6 1.6 0 0 1-1.6-1.6V9.2A1.6 1.6 0 0 1 4 7.6Z', 'm8 3 4 4 4-4'],
  gauge: ['M4 16.5a8 8 0 1 1 16 0', 'm12 16.5 3.6-5.2'],
  elevator: [
    'M6.5 3h11A1.5 1.5 0 0 1 19 4.5v15a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5v-15A1.5 1.5 0 0 1 6.5 3Z',
    'M12 3v18',
    'm7.6 10.6 1.4-2 1.4 2',
    'm13.6 13.4 1.4 2 1.4-2',
  ],
  car: [
    'M3.6 16.4v-3.2a2 2 0 0 1 .2-.9l1.9-3.8A2 2 0 0 1 7.5 7.4h9a2 2 0 0 1 1.8 1.1l1.9 3.8a2 2 0 0 1 .2.9v3.2Z',
    'M4 16.4v2.2h3v-2.2M17 16.4v2.2h3v-2.2',
    'M7.4 13h.01M16.6 13h.01',
  ],
  balcony: ['M4 12h16', 'M5 12V6h14v6', 'M6.5 12v8M10 12v8M14 12v8M17.5 12v8', 'M3 20h18'],
  phone: ['M7.5 3h9A1.5 1.5 0 0 1 18 4.5v15a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19.5v-15A1.5 1.5 0 0 1 7.5 3Z', 'M10.4 17.4h3.2'],
  shield: ['M12 3 5 6v5.4c0 4.2 2.9 8.2 7 9.6 4.1-1.4 7-5.4 7-9.6V6Z'],
  door: ['M6 21V4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21', 'M4 21h16', 'M14.5 12.4h.01'],
  baby: ['M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0', 'M9.4 11h.01M14.6 11h.01', 'M9.8 15.2a3.6 3.6 0 0 0 4.4 0'],
  accessible: [
    'M13.8 5.2a1.6 1.6 0 1 1-3.2 0 1.6 1.6 0 0 1 3.2 0',
    'M12.2 9v4.2h4l2.3 5.4',
    'M12.2 13.2H9.8a4.4 4.4 0 1 0 3.8 6.2',
  ],
  alarm: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0'],
  extinguisher: ['M9.2 8.4h4.6V20a1 1 0 0 1-1 1h-2.6a1 1 0 0 1-1-1Z', 'M10.4 8.4V6.4a1.6 1.6 0 0 1 3.2 0v2', 'M13.8 10.6h3.4l1-3.2'],
  kit: [
    'M4.5 7h15A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-9A1.5 1.5 0 0 1 4.5 7Z',
    'M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7',
    'M12 10.4v5.2M9.4 13h5.2',
  ],

  /* --- house rules --- */
  smoking: ['M3.5 15.6h12.4v3H3.5Z', 'M18.2 15.6h2.3v3h-2.3Z', 'M16.8 12.6a3.1 3.1 0 0 0 0-6.2'],
  noSmoking: ['M3.5 15.6h12.4v3H3.5Z', 'M18.2 15.6h2.3v3h-2.3Z', 'M16.8 12.6a3.1 3.1 0 0 0 0-6.2', 'M4 20 20 4'],
  paw: [
    'M9.4 6.4a2 2.5 0 1 1-4 0 2 2.5 0 0 1 4 0',
    'M18.6 6.4a2 2.5 0 1 1-4 0 2 2.5 0 0 1 4 0',
    'M5.6 12.2a1.8 2.2 0 1 1-3.6 0 1.8 2.2 0 0 1 3.6 0',
    'M22 12.2a1.8 2.2 0 1 1-3.6 0 1.8 2.2 0 0 1 3.6 0',
    'M12 12.6c2.6 0 4.7 2.1 4.7 4.7 0 2-1.6 3.3-3.4 2.9a6 6 0 0 0-2.6 0c-1.8.4-3.4-.9-3.4-2.9 0-2.6 2.1-4.7 4.7-4.7Z',
  ],
  party: ['M8.2 3h7.6l-3 8v7', 'M5.4 3h13.2', 'M9 18h6', 'M18.5 6.5v3M20 8h-3'],
  key: ['M15.5 8.5a4 4 0 1 1-8 0 4 4 0 0 1 8 0', 'm12.6 11.4 6.4 6.4', 'm16.2 15 2-2M18.4 17.2l1.6-1.6'],
  dot: ['M14 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0'],
} as const;

export type IconName = keyof typeof PATHS;

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
  /** Solid fill. Only meaningful for `star` and `heart`. */
  solid?: boolean;
  /** Stroke weight override; the default is tuned for 20–24px. */
  weight?: number;
}

export function Icon({ name, size = 20, solid = false, weight, ...rest }: IconProps) {
  const paths = PATHS[name];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={solid ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={weight ?? (solid ? 0 : 1.6)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      // Icons never shrink below their intended size inside a flex row.
      style={{ flex: '0 0 auto', display: 'block', ...(rest.style ?? {}) }}
      {...rest}
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 * Amenity vocabulary
 *
 * Shared by the listing page, search filters and (later) the listing
 * wizard, so an amenity is presented identically wherever it appears.
 * ------------------------------------------------------------------ */

/** `amenity.icon` → glyph. Unknown keys fall back to a neutral dot. */
export function amenityIcon(icon: string | null | undefined): IconName {
  if (icon && icon in PATHS) return icon as IconName;
  return 'dot';
}

export const AMENITY_CATEGORY: Record<string, { label: string; order: number; icon: IconName }> = {
  ESSENTIALS: { label: 'Основное', order: 1, icon: 'check' },
  KITCHEN: { label: 'Кухня', order: 2, icon: 'chef-hat' },
  BATHROOM: { label: 'Ванная и стирка', order: 3, icon: 'bath' },
  WORK: { label: 'Работа и отдых', order: 4, icon: 'desk' },
  BUILDING: { label: 'Дом и двор', order: 5, icon: 'elevator' },
  FAMILY: { label: 'С детьми', order: 6, icon: 'baby' },
  ACCESSIBILITY: { label: 'Доступность', order: 7, icon: 'accessible' },
  SAFETY: { label: 'Безопасность', order: 8, icon: 'alarm' },
};

/**
 * Amenities a tenant actually decides on, in the order they decide.
 * Used to pick the two or three worth showing on a card — a card that
 * lists every amenity has stopped being scannable.
 */
export const AMENITY_HEADLINE_ORDER: readonly string[] = [
  'WIFI',
  'WASHING_MACHINE',
  'AIR_CONDITIONING',
  'PARKING_FREE',
  'DISHWASHER',
  'WORKSPACE',
  'BALCONY',
  'ELEVATOR',
  'TV',
];
