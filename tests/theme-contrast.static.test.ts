/**
 * The primary button's text against its own ground, in BOTH themes.
 *
 * `scripts/contrast.mjs` reads `--gradient-brand` once, from the light `:root`,
 * and checks white text on it. The dark theme flips `--text-on-primary` to navy
 * but used to inherit that same light gradient, so every resting `.btn-primary`
 * painted navy on corn-600 to corn-700 (3.4:1 to 2.5:1) and nothing noticed.
 * This resolves the tokens each theme really ends up with, cascade included,
 * and holds every ground the button can sit on to AA.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** The declarations of the first rule that opens with `selector {`. */
function ruleBody(selector: string): string {
  const open = css.indexOf(`${selector} {`);
  if (open === -1) throw new Error(`no ${selector} rule in globals.css`);
  const from = css.indexOf('{', open) + 1;
  let depth = 1;
  let i = from;
  while (depth > 0 && i < css.length) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') depth -= 1;
    i += 1;
  }
  return css.slice(from, i - 1);
}

const light = ruleBody(':root');
const dark = ruleBody(":root[data-theme='dark']");

function declared(body: string, name: string): string | undefined {
  return body.match(new RegExp(`(?:^|[;{\\s])--${name}:\\s*([^;]+);`))?.[1]?.trim();
}

/** A custom property as the theme resolves it: its own block, then `:root`, then the `@theme` palette. */
function resolve(themeBody: string, name: string): string {
  const raw = declared(themeBody, name) ?? declared(light, name) ?? declared(css, name);
  if (raw === undefined) throw new Error(`--${name} is not declared`);
  return raw.replace(/var\(--([\w-]+)\)/g, (_, inner: string) => resolve(themeBody, inner));
}

function luminance(hex: string): number {
  const n = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(n.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe.each([
  ['light', light],
  ['dark', dark],
])('%s theme: --text-on-primary on every ground a primary button paints', (_name, body) => {
  const text = resolve(body, 'text-on-primary');

  it('holds AA over each stop of --gradient-brand (the resting .btn-primary)', () => {
    const stops = resolve(body, 'gradient-brand').match(/#[0-9a-f]{6}/gi) ?? [];
    expect(stops.length).toBeGreaterThanOrEqual(2);
    for (const stop of stops) expect(ratio(text, stop), `${text} on ${stop}`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['primary', 'primary-hover', 'primary-active'])(
    'holds AA on --%s (hover, press, badges)',
    (token) => {
      const ground = resolve(body, token);
      expect(ratio(text, ground), `${text} on ${ground}`).toBeGreaterThanOrEqual(4.5);
    },
  );
});
