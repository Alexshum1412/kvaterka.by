/**
 * The one place that decides whether a `next` query value may be followed.
 *
 * `next` is attacker-controllable (anyone can send a link) and ends up in
 * `location.assign()`, a server-side `redirect()` or a `Location` header, so it
 * has to be a path on this site and nothing else. The check that used to be
 * repeated in three places, `startsWith('/') && !startsWith('//')`, misses the
 * ways a browser reads a URL that a string test does not:
 *
 *   - `/\evil.example` — the URL parser treats a backslash as a slash, so this
 *     is `//evil.example`, a different host.
 *   - `/<TAB>/evil.example`, `/<LF>/evil.example` — the parser drops tab and
 *     line breaks anywhere in the input before it looks at the slashes.
 *
 * So it refuses control characters and backslashes outright, then asks the URL
 * parser itself whether the result still lands on the base origin. A refused
 * value falls back to `fallback`; nothing is "repaired", because a repaired
 * attacker string is still the attacker's string.
 */
const PROBE_ORIGIN = 'https://kvaterka.invalid';
const MAX_LENGTH = 2048;

// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\\\u0000-\u001f\u007f]/;

export function safeNextPath(value: unknown, fallback = '/dashboard'): string {
  if (typeof value !== 'string') return fallback;
  if (value.length === 0 || value.length > MAX_LENGTH) return fallback;
  if (!value.startsWith('/') || value.startsWith('//')) return fallback;
  if (FORBIDDEN.test(value)) return fallback;
  try {
    // Non-ASCII is percent-encoded rather than refused: the path is the same place, and this
    // value ends up in a `Location` header, where a character above U+00FF makes the Headers
    // constructor throw (the Google callback would then fail the sign-in it had just made).
    // A lone surrogate cannot be encoded and is refused with the rest.
    // (Control characters were refused above, so what is not printable ASCII here is non-ASCII.)
    const path = value.replace(/[^ -~]/gu, (c) => encodeURIComponent(c));
    if (new URL(path, PROBE_ORIGIN).origin !== PROBE_ORIGIN) return fallback;
    return path;
  } catch {
    return fallback;
  }
}
