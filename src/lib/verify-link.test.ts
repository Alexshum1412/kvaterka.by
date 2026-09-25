import { describe, expect, it } from 'vitest';
import { parseVerifyLink } from './verify-link.ts';

describe('parseVerifyLink', () => {
  it('accepts what a mailed link really carries', () => {
    expect(parseVerifyLink('anna@example.by', '123456')).toEqual({ identifier: 'anna@example.by', code: '123456' });
    expect(parseVerifyLink('+375291234567', '004512')).toEqual({ identifier: '+375291234567', code: '004512' });
  });

  it('trims stray whitespace around either value', () => {
    expect(parseVerifyLink('  anna@example.by ', ' 123456 ')).toEqual({ identifier: 'anna@example.by', code: '123456' });
  });

  it('refuses text that would read as the site speaking, or as markup', () => {
    for (const identifier of [
      'Ваш аккаунт заблокирован, введите пароль от почты',
      'call +375291234567 now',
      '<b>admin@example.by</b>',
      'anna@example.by"><script>alert(1)</script>',
      'a@b',
      '+375 29 123 45 67',
      '+3752912345',
      'x'.repeat(201) + '@example.by',
    ]) {
      expect(parseVerifyLink(identifier, '123456'), identifier).toBeNull();
    }
  });

  it('refuses a code that is not the numeric code', () => {
    for (const code of ['', '12', '12345678901', 'abcdef', '12 34 56', '123456<i>']) {
      expect(parseVerifyLink('anna@example.by', code), code).toBeNull();
    }
  });

  it('refuses missing or repeated parameters', () => {
    expect(parseVerifyLink(undefined, '123456')).toBeNull();
    expect(parseVerifyLink('anna@example.by', undefined)).toBeNull();
    expect(parseVerifyLink(['anna@example.by', 'b@example.by'], '123456')).toBeNull();
    expect(parseVerifyLink('anna@example.by', ['123456', '654321'])).toBeNull();
  });
});
