/**
 * Кватэрка.by brand marks.
 *
 * The symbol is the cornflower (васілёк) — the flower most readable as
 * "Belarusian" without resorting to state iconography, and warm rather than
 * corporate.
 *
 * It is drawn as five tapered ray-florets around a solid centre. Five, not the
 * botanical dozen: at 16 px a favicon has roughly four usable strokes, and a
 * faithful cornflower turns into a blue smudge. The centre disc stays large so
 * the mark still reads when the petals collapse.
 *
 * Everything uses `currentColor` and flat fills — no gradients — so it works
 * monochrome, on light, on dark, and in a print/fax-grade context.
 */

export function CornflowerMark({
  size = 28,
  title,
  className,
}: {
  size?: number;
  title?: string;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      role={title ? 'img' : 'presentation'}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {/* Five ray-florets at 72° intervals. The notch at each tip is what makes
          it a cornflower rather than a generic daisy. */}
      {[0, 72, 144, 216, 288].map((angle) => (
        <path
          key={angle}
          d="M16 4.2 L18.6 8.4 L17.4 9.9 L18.3 12.1 L16 13.6 L13.7 12.1 L14.6 9.9 L13.4 8.4 Z"
          fill="currentColor"
          transform={`rotate(${angle} 16 16)`}
        />
      ))}
      <circle cx="16" cy="16" r="3.4" fill="currentColor" />
      {/* Negative-space ring keeps the centre from blobbing into the petals. */}
      <circle cx="16" cy="16" r="3.4" fill="none" stroke="var(--brand-mark-gap, transparent)" strokeWidth="1.4" />
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
