'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Fades a section up into place the first time it crosses the viewport.
 *
 * Safe by construction: the wrapper renders as an ordinary `<div>` with no
 * hidden state. Only after mount, and only if the element starts below the
 * fold, does effect add `.reveal-init` (see globals.css) — so a crawler, a
 * no-JS visitor, or a slow hydration never sees content that a script was
 * supposed to reveal and didn't. Once visible it stays visible; this is an
 * introduction, not a toggle.
 */
export function Reveal({ children, className, as: As = 'div' }: { children: ReactNode; className?: string; as?: 'div' | 'section' }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    // Already on screen at mount (typical for anything near the top of the
    // page) — introducing it would just be a flash, not a reveal.
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight * 0.92) return;

    el.classList.add('reveal-init');
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          el.classList.add('reveal-in');
          observer.disconnect();
        }
      },
      { threshold: 0.12 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const Comp = As as 'div';
  return (
    <Comp ref={ref} className={className}>
      {children}
    </Comp>
  );
}
