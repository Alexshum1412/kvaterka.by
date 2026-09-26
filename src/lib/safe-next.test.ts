import { describe, expect, it } from 'vitest';
import { safeNextPath } from './safe-next.ts';

const FALLBACK = '/dashboard';

describe('safeNextPath', () => {
  it('keeps ordinary paths on this site, query and hash included', () => {
    for (const ok of [
      '/dashboard',
      '/dashboard/bookings/abc',
      '/listing/0192f5a0-1111-7000-8000-000000000000?from=search#photos',
      '/be/search?city=%D0%9C%D0%B8%D0%BD%D1%81%D0%BA',
      '/en',
      '/',
      '/search?next=https://example.by', // a URL in a query value is just text
    ]) {
      expect(safeNextPath(ok), ok).toBe(ok);
    }
  });

  it('refuses every way of naming another host that a string test misses', () => {
    for (const bad of [
      '//evil.example',
      '///evil.example',
      '/\\evil.example', // a backslash is a slash to the URL parser
      '/\\/evil.example',
      '\\\\evil.example',
      '/\t/evil.example', // tab, LF and CR are dropped before the parser looks at slashes
      '/\n/evil.example',
      '/\r/evil.example',
      '/\u0000/evil.example',
      '/\u007f/evil.example',
      '/ /../\\evil.example',
      'https://evil.example',
      'HTTP://evil.example/x',
      'javascript:alert(1)',
      'data:text/html,<b>x</b>',
      'evil.example',
      ' /dashboard', // leading space: not a path, and the parser would trim it
      '',
    ]) {
      expect(safeNextPath(bad), JSON.stringify(bad)).toBe(FALLBACK);
    }
  });

  it('does not decode: a percent-encoded tab or backslash stays inside this site', () => {
    // These never reach the parser as a separator, so they are harmless and are kept.
    expect(safeNextPath('/%09/evil.example')).toBe('/%09/evil.example');
    expect(safeNextPath('/%5Cevil.example')).toBe('/%5Cevil.example');
  });

  it('percent-encodes non-ASCII so the value can go into a Location header', () => {
    expect(safeNextPath('/поиск?city=Минск')).toBe(
      '/%D0%BF%D0%BE%D0%B8%D1%81%D0%BA?city=%D0%9C%D0%B8%D0%BD%D1%81%D0%BA',
    );
    expect(safeNextPath('/éж')).toBe('/%C3%A9%D0%B6');
    expect(safeNextPath('/emoji-\u{1F3E0}')).toBe('/emoji-%F0%9F%8F%A0');
    // Already-encoded input is left as it is, not encoded twice.
    expect(safeNextPath('/%D0%BF')).toBe('/%D0%BF');
    // What comes out is plain ASCII, which is what a Headers value has to be.
    for (const p of ['/поиск', '/éж', '/x/\u{1F3E0}']) {
      expect(/^[\x20-\x7e]*$/.test(safeNextPath(p)), p).toBe(true);
      expect(() => new Headers({ Location: `https://kvaterka.by${safeNextPath(p)}` })).not.toThrow();
    }
    // A lone surrogate cannot be encoded: refused.
    expect(safeNextPath('/\ud800')).toBe(FALLBACK);
  });

  it('refuses non-strings and absurd lengths', () => {
    for (const bad of [undefined, null, 42, {}, ['/a', '/b']]) expect(safeNextPath(bad)).toBe(FALLBACK);
    expect(safeNextPath('/' + 'a'.repeat(3000))).toBe(FALLBACK);
  });

  it('uses the fallback it is given', () => {
    expect(safeNextPath('//evil.example', '/verify-phone')).toBe('/verify-phone');
    expect(safeNextPath(undefined, '/')).toBe('/');
  });

  it('agrees with the real URL parser: whatever it lets through stays on the origin', () => {
    const probes = [
      '/a',
      '/a/../../b',
      '/%2F%2Fevil.example',
      '/a?x=//evil.example',
      '/a#//evil.example',
      '/éж', // non-ASCII path
      '/a b',
      '/∕evil.example', // division slash: not a separator, must not become one
    ];
    for (const p of probes) {
      const kept = safeNextPath(p);
      expect(new URL(kept, 'https://kvaterka.by').origin, JSON.stringify(p)).toBe('https://kvaterka.by');
    }
  });
});
