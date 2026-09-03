/**
 * Magic-byte sniffing — what decides an upload's type.
 *
 * The declared `Content-Type` and the filename extension are **advisory only**. Both are
 * attacker-controlled, and the whole class of "stored file served back as active content"
 * begins with trusting one of them. So the leading bytes decide, and nothing else does
 * (Requirement 15.3).
 *
 * SVG gets its own rejection reason rather than being lumped in with "not an image",
 * because it *is* an image and an operator who uploads one deserves the actual reason:
 * SVG is an active-content format — it can carry `<script>`, external references and
 * event handlers — so accepting one for product imagery would be a stored-XSS vector
 * (Requirement 15.4). The only SVGs in this system are hand-authored motion components
 * added through the repository.
 *
 * The function is total: any byte sequence yields a verdict, never an exception.
 *
 * Design: Image Pipeline → Upload validation.
 * Requirements: 15.1, 15.3, 15.4, 25.6.
 */

export type SniffedFormat = 'jpeg' | 'png' | 'webp' | 'avif';

/** How many leading bytes the sniffer needs. The design's figure. */
export const SNIFF_BYTES = 32;

export interface SniffedType {
  format: SniffedFormat;
  mime: `image/${SniffedFormat}`;
  /** The extension the server-generated object key uses. Never the client's. */
  ext: 'jpg' | 'png' | 'webp' | 'avif';
}

export type SniffResult =
  | { ok: true; type: SniffedType }
  /** `svg` and `unsupported` are distinguished so the operator gets the real reason. */
  | { ok: false; reason: 'svg' | 'unsupported' | 'empty' };

/** The four accepted formats, in the order the design lists them. */
export const ALLOWED_MIME: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
];

const TYPES: Record<SniffedFormat, SniffedType> = {
  jpeg: { format: 'jpeg', mime: 'image/jpeg', ext: 'jpg' },
  png: { format: 'png', mime: 'image/png', ext: 'png' },
  webp: { format: 'webp', mime: 'image/webp', ext: 'webp' },
  avif: { format: 'avif', mime: 'image/avif', ext: 'avif' },
};

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

/** ASCII at a fixed offset — used for the RIFF/WEBP and ISO-BMFF brand tags. */
function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) return '';
  let out = '';
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** ISO-BMFF brands that mean "this is an AVIF still or sequence". */
const AVIF_BRANDS: readonly string[] = ['avif', 'avis'];

/**
 * Does this look like SVG or XML-wrapped SVG?
 *
 * Checked on the leading bytes only, after skipping whitespace and an optional BOM, and
 * deliberately loose: `<?xml`, `<!DOCTYPE`, `<svg` and any leading comment all count. A
 * loose check here can only cause a rejection, and the alternative — a precise check with a
 * gap — causes an acceptance.
 */
function looksLikeSvgOrXml(bytes: Uint8Array): boolean {
  const head = asciiAt(bytes, 0, Math.min(bytes.length, SNIFF_BYTES))
    .replace(/^\uFEFF/, '')
    .replace(/^\xEF\xBB\xBF/, '')
    .trimStart()
    .toLowerCase();
  return (
    head.startsWith('<svg') ||
    head.startsWith('<?xml') ||
    head.startsWith('<!doctype svg') ||
    head.startsWith('<!--') ||
    head.startsWith('<!doctype')
  );
}

/**
 * Decide the type from the leading bytes.
 *
 * @param bytes the whole file or at least its first {@link SNIFF_BYTES} bytes.
 */
export function sniffImageType(bytes: Uint8Array): SniffResult {
  if (bytes.length === 0) return { ok: false, reason: 'empty' };

  if (startsWith(bytes, JPEG)) return { ok: true, type: TYPES.jpeg };
  if (startsWith(bytes, PNG)) return { ok: true, type: TYPES.png };

  // RIFF container whose form type is WEBP. Both tags are required: a RIFF WAVE file
  // would otherwise pass.
  if (asciiAt(bytes, 0, 4) === 'RIFF' && asciiAt(bytes, 8, 4) === 'WEBP') {
    return { ok: true, type: TYPES.webp };
  }

  // ISO-BMFF: `ftyp` at offset 4, major brand at 8. `mif1`/`msf1` files declare their real
  // brand in the compatible-brands list that follows, so that list is scanned too — within
  // the sniff window only, which is where a legitimate AVIF puts it.
  if (asciiAt(bytes, 4, 4) === 'ftyp') {
    const major = asciiAt(bytes, 8, 4);
    if (AVIF_BRANDS.includes(major)) return { ok: true, type: TYPES.avif };
    for (let offset = 16; offset + 4 <= Math.min(bytes.length, SNIFF_BYTES); offset += 4) {
      if (AVIF_BRANDS.includes(asciiAt(bytes, offset, 4))) return { ok: true, type: TYPES.avif };
    }
    return { ok: false, reason: 'unsupported' };
  }

  if (looksLikeSvgOrXml(bytes)) return { ok: false, reason: 'svg' };
  return { ok: false, reason: 'unsupported' };
}

/**
 * A display-only label for the client's filename.
 *
 * Kept so the operator can tell two photographs apart in the image manager, and used
 * nowhere else — never in an object key, a path, a header, or a URL (Requirement 15.7).
 * Path separators, control characters and leading dots are removed rather than escaped,
 * because this value has no path semantics to preserve.
 */
export function sanitizeFilenameLabel(name: string): string {
  const cleaned = name
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex -- control characters are the point here
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 180);
  return cleaned === '' ? 'photograph' : cleaned;
}
