/**
 * What the mailed "confirm your registration" link may carry.
 *
 * The verify-email page shows the address it was opened for, in the site's own
 * words, directly above a password field. Query values are attacker-controlled
 * (anyone can send someone a link), so they are checked to be what a real link
 * carries before they reach the page: an email or a +375 phone number, and the
 * numeric code. Anything else is a broken link and is never echoed back as text.
 */
const EMAIL = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,180}\.[^\s@<>"']{2,}$/;
const PHONE = /^\+375\d{9}$/;
const CODE = /^\d{4,10}$/;

export function parseVerifyLink(
  identifier: string | string[] | undefined,
  code: string | string[] | undefined,
): { identifier: string; code: string } | null {
  if (typeof identifier !== 'string' || typeof code !== 'string') return null;
  const id = identifier.trim();
  const digits = code.trim();
  if (id.length > 200 || !(EMAIL.test(id) || PHONE.test(id)) || !CODE.test(digits)) return null;
  return { identifier: id, code: digits };
}
