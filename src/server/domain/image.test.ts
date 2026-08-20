import { describe, expect, it } from 'vitest';
import {
  exceedsPixelBudget,
  hasStrippableMetadata,
  MAX_DIMENSION,
  MAX_PIXELS,
  stripMetadata,
} from './image.ts';

/* `Buffer.concat` and `subarray` yield `Buffer<ArrayBufferLike>` while
   `Buffer.from` yields `Buffer<ArrayBuffer>`; the alias keeps the builders
   below from tripping over that distinction, which is irrelevant here. */
type Bytes = Buffer<ArrayBufferLike>;

/* ------------------------------------------------------------------ *
 * Builders. Nothing here decodes an image, so a structurally faithful
 * container is enough — and it is what the stripper actually walks.
 * ------------------------------------------------------------------ */

/** A JPEG segment: FF, marker, big-endian length that includes itself. */
function segment(marker: number, payload: Bytes): Bytes {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

/** The bytes a phone actually writes: an APP1 whose payload begins "Exif\0\0". */
const EXIF_WITH_GPS = Buffer.concat([
  Buffer.from('Exif\0\0', 'latin1'),
  // Not a real TIFF tree — the stripper drops the whole segment by marker, and
  // the point of the recognisable coordinates is that a test can search for
  // them and prove they are gone.
  Buffer.from('II*\0', 'latin1'),
  Buffer.from('GPSLatitude=53.9045 GPSLongitude=27.5615', 'latin1'),
]);

function jpeg(opts: { exif?: boolean; iptc?: boolean; comment?: boolean; icc?: boolean } = {}): Bytes {
  const parts: Bytes[] = [Buffer.from([0xff, 0xd8])]; // SOI
  parts.push(segment(0xe0, Buffer.concat([Buffer.from('JFIF\0', 'latin1'), Buffer.alloc(9)]))); // APP0
  if (opts.exif) parts.push(segment(0xe1, EXIF_WITH_GPS));
  if (opts.icc) parts.push(segment(0xe2, Buffer.from('ICC_PROFILE\0 colour data', 'latin1')));
  if (opts.iptc) parts.push(segment(0xed, Buffer.from('Photoshop 3.0 Минск, ул. Немига 5', 'utf8')));
  if (opts.comment) parts.push(segment(0xfe, Buffer.from('C:\\Users\\Алесь\\photos\\flat.jpg', 'utf8')));

  // SOF0: precision, height, width, components.
  const sof = Buffer.alloc(9);
  sof.writeUInt8(8, 0);
  sof.writeUInt16BE(1200, 1);
  sof.writeUInt16BE(1600, 3);
  parts.push(segment(0xc0, sof));

  parts.push(Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 0, 0, 0x3f, 0])); // SOS
  parts.push(Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55])); // entropy-coded data
  parts.push(Buffer.from([0xff, 0xd9])); // EOI
  return Buffer.concat(parts);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Bytes): Bytes {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  // The CRC is never verified here — chunks are dropped whole, so no CRC is
  // ever recomputed, which is precisely why dropping them is safe.
  return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
}

function png(opts: { exif?: boolean; text?: boolean; time?: boolean } = {}): Bytes {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1600, 0);
  ihdr.writeUInt32BE(1200, 4);
  const parts: Bytes[] = [PNG_SIGNATURE, chunk('IHDR', ihdr)];
  if (opts.exif) parts.push(chunk('eXIf', Buffer.from('GPSLatitude=53.9045', 'latin1')));
  if (opts.text) parts.push(chunk('tEXt', Buffer.from('Author\0Алесь Кавалёк', 'utf8')));
  if (opts.time) parts.push(chunk('tIME', Buffer.alloc(7)));
  parts.push(chunk('IDAT', Buffer.from([0x78, 0x9c, 0x01])));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function riffChunk(fourcc: string, data: Bytes): Bytes {
  const head = Buffer.alloc(8);
  head.write(fourcc, 0, 'ascii');
  head.writeUInt32LE(data.length, 4);
  const pad = data.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([head, data, pad]);
}

function webp(opts: { exif?: boolean; xmp?: boolean } = {}): Bytes {
  const chunks: Bytes[] = [riffChunk('VP8 ', Buffer.from([1, 2, 3, 4]))];
  if (opts.exif) chunks.push(riffChunk('EXIF', Buffer.from('GPSLatitude=53.9045', 'latin1')));
  if (opts.xmp) chunks.push(riffChunk('XMP ', Buffer.from('<x:xmpmeta>Минск</x:xmpmeta>', 'utf8')));
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(4 + body.length, 4);
  header.write('WEBP', 8, 'ascii');
  return Buffer.concat([header, body]);
}

/* ================================================================== */

describe('the coordinates never leave with the photograph', () => {
  it('removes EXIF from a JPEG, which is the whole reason this exists', () => {
    const before = jpeg({ exif: true });
    expect(before.toString('latin1')).toContain('GPSLatitude=53.9045');

    const after = stripMetadata(before, 'jpg');

    // The flat's coordinates are the thing the product refuses to show until a
    // booking is confirmed. They must not travel inside the first photo.
    expect(after.toString('latin1')).not.toContain('GPSLatitude');
    expect(after.toString('latin1')).not.toContain('Exif');
    expect(hasStrippableMetadata(after, 'jpg')).toBe(false);
  });

  it('removes an eXIf chunk from a PNG', () => {
    const after = stripMetadata(png({ exif: true }), 'png');
    expect(after.toString('latin1')).not.toContain('GPSLatitude');
    expect(hasStrippableMetadata(after, 'png')).toBe(false);
  });

  it('removes an EXIF chunk from a WebP and repairs the RIFF length', () => {
    const after = stripMetadata(webp({ exif: true }), 'webp');
    expect(after.toString('latin1')).not.toContain('GPSLatitude');

    // The RIFF size counts everything after itself. Leaving it stale would
    // produce a file whose declared length disagrees with its content.
    expect(after.readUInt32LE(4)).toBe(after.length - 8);
    expect(hasStrippableMetadata(after, 'webp')).toBe(false);
  });

  it('removes IPTC and free-text comments, which also carry addresses', () => {
    const after = stripMetadata(jpeg({ iptc: true, comment: true }), 'jpg');
    const text = after.toString('utf8');
    expect(text).not.toContain('Немига');
    expect(text).not.toContain('Алесь');
  });

  it('removes PNG text chunks that carry the author’s name', () => {
    const after = stripMetadata(png({ text: true, time: true }), 'png');
    expect(after.toString('utf8')).not.toContain('Алесь Кавалёк');
    expect(hasStrippableMetadata(after, 'png')).toBe(false);
  });

  it('removes XMP from a WebP', () => {
    const after = stripMetadata(webp({ xmp: true }), 'webp');
    expect(after.toString('utf8')).not.toContain('Минск');
  });
});

describe('and the photograph itself is left alone', () => {
  it('keeps the JFIF header and the colour profile', () => {
    // Dropping APP2 would visibly shift the colours of the photograph, which
    // would make this a picture editor rather than a metadata scrubber.
    const after = stripMetadata(jpeg({ exif: true, icc: true }), 'jpg');
    expect(after.toString('latin1')).toContain('JFIF');
    expect(after.toString('latin1')).toContain('ICC_PROFILE');
  });

  it('keeps the image data and the frame header', () => {
    const after = stripMetadata(jpeg({ exif: true }), 'jpg');
    // SOF0 survives, so dimensions are still readable.
    expect(after.includes(Buffer.from([0xff, 0xc0]))).toBe(true);
    // The entropy-coded data and EOI survive byte for byte.
    expect(after.subarray(-7).equals(Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55, 0xff, 0xd9]))).toBe(true);
  });

  it('keeps IHDR, IDAT and IEND in a PNG', () => {
    const after = stripMetadata(png({ exif: true, text: true }), 'png');
    expect(after.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    for (const type of ['IHDR', 'IDAT', 'IEND']) {
      expect(after.toString('latin1')).toContain(type);
    }
  });

  it('keeps the pixel chunk in a WebP', () => {
    const after = stripMetadata(webp({ exif: true }), 'webp');
    expect(after.toString('latin1')).toContain('VP8 ');
  });

  it('returns a clean file unchanged rather than rewriting it', () => {
    // A photograph that carries nothing to remove must come out byte-identical.
    // Re-serialising it would be a chance to corrupt something for no gain.
    const clean = jpeg();
    expect(stripMetadata(clean, 'jpg').equals(clean)).toBe(true);

    const cleanWebp = webp();
    expect(stripMetadata(cleanWebp, 'webp').equals(cleanWebp)).toBe(true);
  });
});

describe('malformed input is passed through, never mangled', () => {
  it.each([
    ['empty', Buffer.alloc(0)],
    ['too short', Buffer.from([0xff, 0xd8])],
    ['truncated mid-segment', jpeg({ exif: true }).subarray(0, 12)],
    ['not a JPEG at all', Buffer.from('this is not an image', 'utf8')],
  ])('returns %s unchanged', (_label, input) => {
    // This function removes things; it is not a validator and not a repairer.
    // Acceptance is the caller's job, and it has already sniffed the type.
    expect(stripMetadata(input, 'jpg').equals(input)).toBe(true);
  });

  it('does not lose data when a PNG chunk length is impossible', () => {
    const broken = Buffer.concat([PNG_SIGNATURE, Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from('tEXt')]);
    const after = stripMetadata(broken, 'png');
    expect(after.length).toBe(broken.length);
  });

  it('terminates on a WebP whose chunk size overruns the file', () => {
    const head = Buffer.alloc(12);
    head.write('RIFF', 0, 'ascii');
    head.writeUInt32LE(1000, 4);
    head.write('WEBP', 8, 'ascii');
    const bad = Buffer.concat([head, Buffer.from('EXIF'), Buffer.from([0xff, 0xff, 0xff, 0x7f])]);
    expect(() => stripMetadata(bad, 'webp')).not.toThrow();
  });
});

describe('a decompression bomb is refused by its dimensions', () => {
  it('accepts an ordinary photograph', () => {
    expect(exceedsPixelBudget(6000, 4000)).toBe(false);
    expect(exceedsPixelBudget(8000, 6000)).toBe(false); // a 48 MP phone
  });

  it('refuses a picture that is small on disk and enormous in memory', () => {
    // 30000x30000 is about 25 KB compressed and 3.6 GB decoded. Nothing here
    // decodes it — the browser of everyone who opens the listing would.
    expect(exceedsPixelBudget(30_000, 30_000)).toBe(true);
  });

  it('refuses a long thin strip, not only a large square', () => {
    expect(exceedsPixelBudget(1, MAX_DIMENSION + 1)).toBe(true);
    expect(exceedsPixelBudget(MAX_DIMENSION + 1, 1)).toBe(true);
  });

  it('refuses on total pixels even when both sides are individually allowed', () => {
    const side = MAX_DIMENSION;
    expect(side * side).toBeGreaterThan(MAX_PIXELS);
    expect(exceedsPixelBudget(side, side)).toBe(true);
  });

  it('defers to the byte cap when the dimensions are unknown', () => {
    // WebP dimensions are not parsed; the 10 MB limit governs those.
    expect(exceedsPixelBudget(null, null)).toBe(false);
    expect(exceedsPixelBudget(4000, null)).toBe(false);
  });
});
