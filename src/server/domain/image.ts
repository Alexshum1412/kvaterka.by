/**
 * Photograph hygiene: what must come off a picture before it is published.
 *
 * WHY THIS EXISTS
 *
 * This platform withholds a flat's exact position until a booking is
 * confirmed. `property` stores `public_latitude`/`public_longitude` beside the
 * true pair for exactly that reason, the listing page renders the blurred one,
 * and the map says so. It is one of the product's load-bearing privacy
 * promises.
 *
 * And every photograph taken on a phone with location services on carries the
 * exact coordinates in its EXIF, to five decimal places. The upload endpoint
 * wrote the uploaded bytes verbatim, so the address the product carefully
 * refuses to show was published inside the first photo of the listing — to
 * anonymous visitors, on the public page, from the day the feature shipped.
 * Nothing in the codebase was wrong; something was simply absent, and its
 * absence quietly undid a decision made three migrations earlier.
 *
 * WHY IT IS WRITTEN BY HAND
 *
 * The usual answer is to re-encode through an image library, which strips
 * metadata as a side effect and also caps decompression bombs. That is a
 * native dependency on the path where untrusted bytes arrive, in a project
 * whose dependency list is five packages long on purpose.
 *
 * Removing metadata does not require decoding an image. All three accepted
 * formats are containers of length-prefixed segments, and the metadata lives in
 * segments that can be dropped without touching a single pixel. The upload
 * route already walks JPEG segments to read dimensions; this walks the same
 * structures with intent.
 *
 * WHAT IT DOES NOT DO, STATED PLAINLY
 *
 * It does not re-encode, so it is not a defence against a malformed image that
 * attacks a decoder — the browser's decoder, since nothing here decodes. It
 * does not resize. Decompression bombs are handled separately and bluntly, by
 * refusing absurd dimensions before the bytes are stored (`exceedsPixelBudget`)
 * rather than by rendering them.
 */

type Bytes = Buffer<ArrayBufferLike>;

export type ImageKind = 'jpg' | 'png' | 'webp';

/**
 * The largest picture worth accepting, in pixels.
 *
 * 50 megapixels is far beyond any phone or camera a landlord will use — a
 * 48 MP phone sensor produces about 8000×6000 — and far below the point where
 * a decoder allocates dangerous amounts of memory. A 30000×30000 PNG is
 * 25 KB compressed and 3.6 GB decoded, which is the whole trick.
 */
export const MAX_PIXELS = 50_000_000;

/** Neither side may exceed this, so a 1×60000000 strip is refused too. */
export const MAX_DIMENSION = 20_000;

export function exceedsPixelBudget(width: number | null, height: number | null): boolean {
  if (width === null || height === null) return false; // unknown: the byte cap governs
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) return true;
  return width * height > MAX_PIXELS;
}

/* ------------------------------------------------------------------ *
 * JPEG
 * ------------------------------------------------------------------ */

/**
 * Segments dropped from a JPEG.
 *
 * APP1  — EXIF (including GPS) and XMP. The reason this module exists.
 * APP13 — Photoshop IRB, which carries IPTC, and often a location too.
 * COM   — free-text comment; some cameras and editors put paths in it.
 *
 * APP0 (JFIF) and APP2 (ICC colour profile) are KEPT. They carry no personal
 * data, and dropping the colour profile visibly shifts the colours of a
 * photograph — which would make this function a picture editor rather than a
 * metadata scrubber.
 */
const JPEG_DROP = new Set([0xe1, 0xed, 0xfe]);

function stripJpeg(buf: Bytes): Bytes {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return buf;

  const out: Bytes[] = [buf.subarray(0, 2)]; // SOI
  let offset = 2;

  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) {
      // Not at a marker boundary: the file is not shaped the way this walker
      // understands. Copy the remainder untouched rather than guess — a
      // corrupted photograph is the uploader's problem, a corrupted photograph
      // this function created would be ours.
      out.push(buf.subarray(offset));
      return Buffer.concat(out);
    }

    const marker = buf[offset + 1]!;

    // Start of scan: entropy-coded data follows to the end. Nothing beyond
    // here is a segment, so copy it whole.
    if (marker === 0xda) {
      out.push(buf.subarray(offset));
      return Buffer.concat(out);
    }

    // Standalone markers carry no length.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      out.push(buf.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }

    const length = buf.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buf.length) {
      out.push(buf.subarray(offset));
      return Buffer.concat(out);
    }

    if (!JPEG_DROP.has(marker)) out.push(buf.subarray(offset, offset + 2 + length));
    offset += 2 + length;
  }

  if (offset < buf.length) out.push(buf.subarray(offset));
  return Buffer.concat(out);
}

/* ------------------------------------------------------------------ *
 * PNG
 * ------------------------------------------------------------------ */

/**
 * Ancillary chunks dropped from a PNG.
 *
 * `eXIf` is the modern container and can hold GPS exactly as JPEG's does.
 * `tEXt`/`zTXt`/`iTXt` hold arbitrary text, which is where editors put author
 * names, software versions and, occasionally, file paths. `tIME` is the last
 * modification time — small, but it is metadata about the person, not the
 * picture.
 *
 * Every dropped chunk is ancillary by definition (lowercase first letter), so
 * removing it cannot make the image undecodable. Chunks carry their own CRC,
 * so dropping whole chunks needs no recomputation.
 */
const PNG_DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function stripPng(buf: Bytes): Bytes {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return buf;

  const out: Bytes[] = [buf.subarray(0, 8)];
  let offset = 8;

  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const total = 12 + length; // length + type + data + crc

    if (length > buf.length || offset + total > buf.length) {
      out.push(buf.subarray(offset));
      return Buffer.concat(out);
    }

    if (!PNG_DROP.has(type)) out.push(buf.subarray(offset, offset + total));
    offset += total;

    if (type === 'IEND') break;
  }

  // Anything the walker could not read as a chunk — a truncated tail, or bytes
  // after IEND — is copied rather than dropped. A stripper that silently
  // shortens a file it did not understand is worse than one that leaves
  // metadata behind, because the damage is invisible until the image fails to
  // open. A test with a deliberately impossible chunk length caught this.
  if (offset < buf.length) out.push(buf.subarray(offset));

  return Buffer.concat(out);
}

/* ------------------------------------------------------------------ *
 * WebP
 * ------------------------------------------------------------------ */

/**
 * WebP is a RIFF container: "RIFF", a 32-bit size, "WEBP", then chunks of a
 * four-character code, a 32-bit size, the payload, and a pad byte when the
 * size is odd.
 *
 * `EXIF` and `XMP ` are dropped. The RIFF size field counts everything after
 * itself, so it has to be rewritten — the one place here where a length must
 * be recomputed rather than copied.
 */
const WEBP_DROP = new Set(['EXIF', 'XMP ']);

function stripWebp(buf: Bytes): Bytes {
  if (
    buf.length < 12 ||
    buf.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    buf.subarray(8, 12).toString('ascii') !== 'WEBP'
  ) {
    return buf;
  }

  const kept: Bytes[] = [];
  let offset = 12;
  let dropped = false;

  while (offset + 8 <= buf.length) {
    const fourcc = buf.subarray(offset, offset + 4).toString('ascii');
    const size = buf.readUInt32LE(offset + 4);
    const padded = size + (size % 2);
    if (offset + 8 + padded > buf.length) {
      kept.push(buf.subarray(offset));
      offset = buf.length;
      break;
    }

    if (WEBP_DROP.has(fourcc)) dropped = true;
    else kept.push(buf.subarray(offset, offset + 8 + padded));

    offset += 8 + padded;
  }

  // Same reasoning as the PNG tail: a remainder too short to be a chunk header
  // is carried, never discarded.
  if (offset < buf.length) kept.push(buf.subarray(offset));

  if (!dropped) return buf;

  const body = Buffer.concat(kept);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(4 + body.length, 4); // "WEBP" plus the chunks
  header.write('WEBP', 8, 'ascii');
  return Buffer.concat([header, body]);
}

/* ------------------------------------------------------------------ */

/**
 * Remove personal metadata from an image without decoding it.
 *
 * Returns the original buffer unchanged when the format is not recognised or
 * the file is malformed: this function's job is to remove something, never to
 * repair or reject. Acceptance is decided by the caller, which has already
 * sniffed the type by magic bytes.
 */
export function stripMetadata(buf: Bytes, kind: ImageKind): Bytes {
  switch (kind) {
    case 'jpg':
      return stripJpeg(buf);
    case 'png':
      return stripPng(buf);
    case 'webp':
      return stripWebp(buf);
  }
}

/**
 * Whether a buffer still carries any metadata segment this module removes.
 *
 * Exists for the tests and for a future audit surface: asserting "no EXIF
 * remains" is a stronger statement than asserting "the stripper ran".
 */
export function hasStrippableMetadata(buf: Bytes, kind: ImageKind): boolean {
  if (kind === 'jpg') {
    let offset = 2;
    while (offset + 4 <= buf.length) {
      if (buf[offset] !== 0xff) return false;
      const marker = buf[offset + 1]!;
      if (marker === 0xda) return false;
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
        offset += 2;
        continue;
      }
      const length = buf.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > buf.length) return false;
      if (JPEG_DROP.has(marker)) return true;
      offset += 2 + length;
    }
    return false;
  }

  if (kind === 'png') {
    let offset = 8;
    while (offset + 12 <= buf.length) {
      const length = buf.readUInt32BE(offset);
      const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
      if (PNG_DROP.has(type)) return true;
      offset += 12 + length;
      if (type === 'IEND') break;
    }
    return false;
  }

  let offset = 12;
  while (offset + 8 <= buf.length) {
    const fourcc = buf.subarray(offset, offset + 4).toString('ascii');
    const size = buf.readUInt32LE(offset + 4);
    if (WEBP_DROP.has(fourcc)) return true;
    offset += 8 + size + (size % 2);
  }
  return false;
}
