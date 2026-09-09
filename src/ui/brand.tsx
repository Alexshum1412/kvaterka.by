/**
 * Кватэрка.by brand marks.
 *
 * The symbol is the cornflower (васілёк) — the flower most readable as
 * "Belarusian" without resorting to state iconography, and warm rather than
 * corporate.
 *
 * Six ray-florets around a spiky centre disc, with six threadlike stamens
 * alternating between them — this replaces an earlier five-petal
 * simplification with a closer, more botanically-drawn mark (matching a
 * reference the product owner supplied directly). Each petal ends in a
 * shallow three-tooth fringe rather than a smooth curve or a straight edge:
 * cornflower ray florets are genuinely notched at the tip, and the teeth are
 * what makes the silhouette read as "flower" rather than "badge" or
 * "snowflake" once it is reduced to a flat fill.
 *
 * Two renderings share the same geometry: `currentColor` flat fill (the
 * default — works monochrome, on light, on dark, in print) and an optional
 * radial-gradient fill for large decorative use (hero art, the loading
 * mark) where the mark is never doing double duty as body text. The centre
 * and stamens stay a fixed dark navy in both modes — they are the one part
 * of the mark that is never just "the brand colour", the same way the
 * reference photo keeps its filament tips dark against blue petals.
 */

const PETAL_D =
  'M50 6 L53.2 11 L57 7.5 L58.5 13 C61 18 63 21 61 26 C58 34 54 40 50 48 C46 40 42 34 39 26 C37 21 39 18 41.5 13 L43 7.5 L46.8 11 Z';

const CENTER_D =
  'M50 43 L52.2 47 L57 46.5 L53.8 50 L57 53.5 L52.2 53 L50 57 L47.8 53 L43 53.5 L46.2 50 L43 46.5 L47.8 47 Z';

/** Six stamens, offset 30° from the petals, threadlike with a small ball tip. */
const STAMENS: { x1: number; y1: number; x2: number; y2: number }[] = [
  { x1: 54.5, y1: 42.2, x2: 60, y2: 32.68 },
  { x1: 59, y1: 50, x2: 70, y2: 50 },
  { x1: 54.5, y1: 57.8, x2: 60, y2: 67.32 },
  { x1: 45.5, y1: 57.8, x2: 40, y2: 67.32 },
  { x1: 41, y1: 50, x2: 30, y2: 50 },
  { x1: 45.5, y1: 42.2, x2: 40, y2: 32.68 },
];

const PETAL_ANGLES = [0, 60, 120, 180, 240, 300];

/** The dark navy of the reference mark's centre and filament tips — always this, in both flat and gradient modes. */
const CENTER_INK = '#1c2f6e';

let gradientSeq = 0;

export function CornflowerMark({
  size = 28,
  title,
  className,
  gradient = false,
  /** Force-drop the stamens regardless of size — for a dense scatter like
   * `CornflowerField`, where six filaments per mark, repeated across eight
   * overlapping marks, is noise rather than detail. Leave unset everywhere
   * else: below 36px the mark drops its own stamens automatically (a
   * filament this thin anti-aliases into mud at header/footer size rather
   * than reading as a line — verified by eye, not assumed), so a header
   * logo and a 104px empty-state mark can call this the same way. */
  simple,
}: {
  size?: number;
  title?: string;
  className?: string;
  /** Radial-gradient petals for large decorative use. Never for body-sized UI. */
  gradient?: boolean;
  simple?: boolean;
}) {
  const showDetail = !simple && size >= 36;
  // Stable-enough per-mount id so two gradient marks on one page never share
  // a `<radialGradient>` (SVG ids are document-global, not scoped to a tree).
  const gid = gradient ? `cf-grad-${(gradientSeq += 1)}` : undefined;
  const petalFill = gid ? `url(#${gid})` : 'currentColor';

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      className={className}
      role={title ? 'img' : 'presentation'}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {gid && (
        <defs>
          <radialGradient id={gid} cx="50" cy="66" r="52" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#6fb3ff" />
            <stop offset="0.55" stopColor="#2f79dc" />
            <stop offset="1" stopColor="#164b96" />
          </radialGradient>
        </defs>
      )}
      {/* Six fringed ray-florets at 60° intervals. */}
      {PETAL_ANGLES.map((angle) => (
        <path key={angle} d={PETAL_D} fill={petalFill} transform={`rotate(${angle} 50 50)`} />
      ))}
      {showDetail &&
        STAMENS.map((s, i) => (
          <g key={i} stroke={CENTER_INK} strokeWidth="2.4" strokeLinecap="round">
            <line x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} />
            <circle cx={s.x2} cy={s.y2} r="3.4" fill={CENTER_INK} stroke="none" />
          </g>
        ))}
      <path d={CENTER_D} fill={CENTER_INK} />
    </svg>
  );
}

/**
 * Full lockup. The «.by» is set lighter and smaller — it is a domain, not part
 * of the spoken name, and giving it equal weight makes the wordmark read as a
 * URL rather than as a brand.
 */
export function BrandLockup({ size = 28, href }: { size?: number; href?: string }) {
  const content = (
    <span className="brand-lockup">
      <CornflowerMark size={size} title="Кватэрка" />
      <span className="brand-lockup__word">
        Кватэрка<span className="brand-lockup__tld">.by</span>
      </span>
      <style>{`
        .brand-lockup {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          color: var(--primary);
        }
        .brand-lockup__word {
          font-weight: 700;
          font-size: var(--text-lg);
          letter-spacing: -0.02em;
          color: var(--text-primary);
          white-space: nowrap;
        }
        .brand-lockup__tld {
          font-weight: 500;
          color: var(--text-secondary);
        }
      `}</style>
    </span>
  );

  return href ? <a href={href}>{content}</a> : content;
}

/**
 * A loose scatter of cornflower marks for decorative backgrounds (the home
 * hero, empty states that want more presence than `EmptyState`'s single
 * watermark). Purely `aria-hidden` — it never carries information, only mood.
 *
 * Positions are hand-placed rather than randomised: `Math.random()` would
 * reseed on every server render and make the field jump on hydration, and a
 * hand-tuned scatter reads as designed rather than as scattered.
 */
const FIELD_MARKS: { x: number; y: number; size: number; rot: number; opacity: number }[] = [
  { x: 6, y: 18, size: 46, rot: -12, opacity: 0.5 },
  { x: 16, y: 62, size: 30, rot: 8, opacity: 0.35 },
  { x: 30, y: 8, size: 26, rot: 20, opacity: 0.4 },
  { x: 46, y: 40, size: 54, rot: -6, opacity: 0.22 },
  { x: 62, y: 12, size: 34, rot: 14, opacity: 0.45 },
  { x: 74, y: 55, size: 42, rot: -18, opacity: 0.3 },
  { x: 88, y: 22, size: 28, rot: 5, opacity: 0.5 },
  { x: 96, y: 68, size: 22, rot: -10, opacity: 0.35 },
];

export function CornflowerField({ className }: { className?: string }) {
  return (
    <div className={className} aria-hidden="true" style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      {FIELD_MARKS.map((m, i) => (
        <CornflowerMark key={i} size={m.size} className="cf-field__mark" gradient simple />
      ))}
      <style>{`
        .cf-field__mark { position: absolute; }
        ${FIELD_MARKS.map(
          (m, i) =>
            `.cf-field__mark:nth-of-type(${i + 1}) { left: ${m.x}%; top: ${m.y}%; opacity: ${m.opacity}; transform: rotate(${m.rot}deg); }`,
        ).join('\n')}
      `}</style>
    </div>
  );
}
