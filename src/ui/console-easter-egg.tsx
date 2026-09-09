'use client';

import { useEffect } from 'react';

/**
 * A cornflower for whoever opens devtools.
 *
 * Renders nothing — the only output is a `console.log`, once per page load,
 * gated behind the same `prefers-reduced-motion`-style courtesy every other
 * decorative thing here gets: it never runs twice and never throws if the
 * console API is missing (an old embedded webview, a locked-down browser).
 */
export function ConsoleEasterEgg() {
  useEffect(() => {
    if (typeof console === 'undefined' || typeof console.log !== 'function') return;

    const flower = [
      '          ✾              ',
      '       ✾  ✾  ✾           ',
      '     ✾   ❁❁❁   ✾         ',
      '       ✾ ❁●❁ ✾           ',
      '     ✾   ❁❁❁   ✾         ',
      '       ✾  ✾  ✾           ',
      '          ✾              ',
      '          │              ',
      '          │              ',
      '         ╱ ╲             ',
    ].join('\n');

    try {
      console.log('%c' + flower, 'color:#216aca; font-weight:bold; line-height:1.1; font-family:monospace;');
      console.log(
        '%cКватэрка.by%c\nЦветы не любят bugs. 🌼',
        'color:#216aca; font-weight:700; font-size:14px;',
        'color:#4a5a75; font-size:12px;',
      );
    } catch {
      // A console that throws on .log is not worth failing the page for.
    }
  }, []);

  return null;
}
