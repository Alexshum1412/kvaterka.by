import { randomUUID, randomFillSync } from 'node:crypto';

/**
 * UUIDv7 — time-ordered identifiers.
 *
 * Chosen over v4 (DEC-011) because these values are primary keys on tables that
 * grow forever (bookings, messages, audit rows). Random v4 keys scatter inserts
 * across the whole B-tree, which fragments the index and hurts write throughput;
 * v7 keys are monotonic-ish, so inserts stay at the right edge of the index and
 * "most recent first" queries read sequential pages.
 *
 * Layout (RFC 9562): 48-bit big-endian Unix milliseconds, version nibble 7,
 * 12 random bits, variant bits, 62 random bits.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);

  // 48-bit timestamp.
  const ms = BigInt(now);
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);

  randomFillSync(bytes, 6, 10);

  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 9562 variant

  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Extract the creation time back out of a v7 id. Useful in admin tooling. */
export function uuidv7Timestamp(id: string): Date {
  const hex = id.replace(/-/g, '').slice(0, 12);
  return new Date(Number(BigInt('0x' + hex)));
}

export { randomUUID };

const REFERENCE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O/1/I

/**
 * Short human-quotable reference, e.g. "KV-7Q2M-9XTB", for booking and case
 * numbers that people read aloud to support.
 */
export function humanReference(prefix: string, length = 8): string {
  const bytes = new Uint8Array(length);
  randomFillSync(bytes);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    if (i === 4) out += '-';
    out += REFERENCE_ALPHABET[bytes[i]! % REFERENCE_ALPHABET.length];
  }
  return `${prefix}-${out}`;
}
