import type { ReactNode } from 'react';

/**
 * The reading layout.
 *
 * Seven addresses were linked from the footer of every page and none of them
 * existed: how it works, trust, hosting, fees, terms, privacy, support. A
 * marketplace that collects identity documents and 404s on its own privacy
 * link is not a small cosmetic gap, so these pages are real rather than
 * placeholders — but only as real as the facts allow, which is the whole
 * difficulty with two of them.
 *
 * One measure column, generous line height, no decoration. A page of text
 * needs a reading width and nothing else.
 */
export function Prose({
  title,
  lede,
  children,
}: {
  title: string;
  lede?: string;
  children: ReactNode;
}) {
  return (
    <div className="container prose">
      <header className="prose__head">
        <h1>{title}</h1>
        {lede && <p className="prose__lede">{lede}</p>}
      </header>
      <div className="prose__body">{children}</div>

      <style>{`
        .prose { max-width: 42rem; padding-block: var(--space-6) var(--space-8); }
        .prose__head { margin-bottom: var(--space-5); }
        .prose__head h1 { font-size: var(--text-2xl); font-weight: 600; letter-spacing: -0.01em; }
        .prose__lede { font-size: var(--text-base); color: var(--text-secondary); line-height: 1.65; margin-top: var(--space-3); }

        .prose__body { font-size: var(--text-sm); line-height: 1.7; color: var(--text-primary); }
        .prose__body h2 { font-size: var(--text-lg); font-weight: 600; margin-top: var(--space-6); margin-bottom: var(--space-2); }
        .prose__body h3 { font-size: var(--text-base); font-weight: 600; margin-top: var(--space-4); margin-bottom: var(--space-1); }
        .prose__body p { margin-bottom: var(--space-3); color: var(--text-secondary); }
        .prose__body ul, .prose__body ol { margin: 0 0 var(--space-3); padding-inline-start: 1.25rem; color: var(--text-secondary); }
        .prose__body li { margin-bottom: 0.35rem; }
        .prose__body strong { color: var(--text-primary); font-weight: 600; }

        /* A short, quiet panel for the one thing on a page that is a caveat
           rather than content. */
        .prose__note {
          padding: var(--space-4);
          background: var(--surface-sunken);
          border-radius: var(--radius-md);
          margin-bottom: var(--space-4);
        }
        .prose__note p:last-child { margin-bottom: 0; }

        .prose__steps { list-style: none; padding: 0; counter-reset: step; }
        .prose__steps li {
          position: relative;
          padding-inline-start: 2.25rem;
          margin-bottom: var(--space-4);
          color: var(--text-secondary);
        }
        .prose__steps li::before {
          counter-increment: step;
          content: counter(step);
          position: absolute;
          inset-inline-start: 0;
          top: 0;
          width: 1.6rem;
          height: 1.6rem;
          border-radius: 50%;
          background: var(--primary-soft);
          color: var(--primary);
          font-size: var(--text-xs);
          font-weight: 700;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .prose__steps b { display: block; color: var(--text-primary); font-weight: 600; margin-bottom: 0.15rem; }
      `}</style>
    </div>
  );
}
