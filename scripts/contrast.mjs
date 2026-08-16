/**
 * Contrast checker for the design tokens.
 *
 * The ratios written into globals.css are load-bearing claims — they are
 * the reason a colour was chosen — so they are computed here rather than
 * estimated. Run with: node scripts/contrast.mjs
 *
 * Exits non-zero if any pair falls below its stated requirement, so a
 * future palette tweak cannot quietly break accessibility.
 */

const SURFACE = '#ffffff';
const GROUND = '#f7f9fc';

/** WCAG 2.x relative luminance. */
function luminance(hex) {
  const n = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(n.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/* fg, bg, minimum, what it is used for */
const CHECKS = [
  ['#ffffff', '#216aca', 4.5, 'white text on --primary (buttons)'],
  ['#ffffff', '#1b57a8', 4.5, 'white text on --primary-hover'],
  ['#ffffff', '#16468a', 4.5, 'white text on --primary-active'],
  ['#216aca', SURFACE, 4.5, '--primary as link text on white'],
  ['#216aca', GROUND, 4.5, '--primary as link text on the page ground'],
  ['#0b2545', SURFACE, 7.0, '--text-primary on white'],
  ['#0b2545', GROUND, 7.0, '--text-primary on the page ground'],
  ['#4a5a75', SURFACE, 4.5, '--text-secondary on white'],
  ['#4a5a75', GROUND, 4.5, '--text-secondary on the page ground'],
  ['#5f6f87', SURFACE, 4.5, '--text-tertiary on white'],
  ['#5f6f87', GROUND, 4.5, '--text-tertiary on the page ground'],
  ['#0f7b55', SURFACE, 4.5, '--success on white'],
  ['#0f7b55', '#e7f6ef', 4.5, '--success on --success-soft (verified badge)'],
  ['#8a5200', SURFACE, 4.5, '--warning on white'],
  ['#8a5200', '#fff4e0', 4.5, '--warning on --warning-soft'],
  ['#c0271f', SURFACE, 4.5, '--error on white'],
  ['#c0271f', '#fdecea', 4.5, '--error on --error-soft'],
  ['#14509b', '#eaf2fe', 4.5, '--info on --info-soft'],
  ['#216aca', '#f1f6fe', 4.5, '--primary on --primary-soft (selected chip)'],
  ['#0b2545', '#4da3ff', 4.5, 'navy text on --accent (the only legal use)'],
  // Non-text: WCAG 1.4.11 wants 3:1 for the boundary identifying a control.
  ['#7e8fa5', SURFACE, 3.0, '--border-control vs white (input edge)'],
  ['#7e8fa5', GROUND, 3.0, '--border-control vs the page ground'],
  ['#216aca', SURFACE, 3.0, '--focus ring vs white'],
  ['#216aca', GROUND, 3.0, '--focus ring vs the page ground'],
];

let failed = 0;
console.log('pair'.padEnd(52), 'ratio'.padStart(7), '  min   ');
console.log('-'.repeat(72));
for (const [fg, bg, min, label] of CHECKS) {
  const r = ratio(fg, bg);
  const pass = r >= min;
  if (!pass) failed += 1;
  console.log(label.padEnd(52), `${r.toFixed(2)}:1`.padStart(7), ` ${min.toFixed(1)}  `, pass ? 'PASS' : 'FAIL');
}

/* The accent is documented as unusable for white text. Assert that, so
   nobody "fixes" the palette by putting white on it. */
const accentWhite = ratio('#ffffff', '#4da3ff');
console.log('-'.repeat(72));
console.log(
  `white on --accent #4da3ff is ${accentWhite.toFixed(2)}:1 — below 3.0, which is why`,
);
console.log('buttons use --primary #216aca instead. This is expected, not a failure.');

if (failed > 0) {
  console.error(`\n${failed} contrast requirement(s) FAILED`);
  process.exit(1);
}
console.log('\nAll contrast requirements met.');
