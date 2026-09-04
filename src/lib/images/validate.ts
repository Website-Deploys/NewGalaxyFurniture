/**
 * Upload validation, in the design's order: cheapest and most decisive first.
 *
 * ```
 * 1. session / CSRF / permission / rate limit   ← the endpoint, before this module runs
 * 2. Content-Length vs maxBytes                 ← before the body is read
 * 3. magic-byte sniff of the first 32 bytes     ← the declared type is advisory only
 * 4. SVG rejected outright
 * 5. header dimension parse vs maxPixels/minWidth
 * 6. full decode — which also strips all metadata, EXIF GPS included
 * 7. server-generated object key
 * ```
 *
 * Two design points are load-bearing:
 *
 * - **The client's filename never becomes a path.** The object key is built here from the
 *   product id, a server-generated image id and the *sniffed* extension. The filename
 *   survives only as a sanitized display label (Requirement 15.7). There is no code path
 *   from a client string to an R2 key.
 * - **Every rejection names its own reason** and concerns exactly one file, so one bad
 *   photograph in a batch of twelve does not fail the other eleven (Requirement 15.5,
 *   26.8).
 *
 * Steps 2–5 need no codec, which is what makes them exhaustively property-testable
 * (Property 46): a file whose leading bytes are a PHP script is refused whatever it claims
 * to be, without a decoder in the loop. Step 6 takes an injected decoder so the same
 * function is used by the endpoint (Photon in the Worker) and by the tests (Photon in
 * Node) — there is no second, weaker validation path.
 *
 * Design: Image Pipeline → Upload validation.
 * Requirements: 15.1–15.7, 25.6, 26.8.
 */

import { readHeaderDimensions } from './dimensions';
import { sanitizeFilenameLabel, sniffImageType, SNIFF_BYTES, type SniffedType } from './sniff';

/** The design's constraints, verbatim. */
export const UPLOAD_CONSTRAINTS = {
  maxBytes: 12_582_912, // 12 MB
  maxPixels: 40_000_000, // 40 MP guards decompression bombs
  minWidth: 800, // below this it cannot serve a PDP hero
  allowedMime: ['image/jpeg', 'image/png', 'image/webp', 'image/avif'],
} as const;

export type UploadErrorCode =
  | 'EMPTY_FILE'
  | 'TOO_LARGE'
  | 'NOT_AN_IMAGE'
  | 'SVG_REJECTED'
  | 'DIMENSIONS_UNREADABLE'
  | 'TOO_MANY_PIXELS'
  | 'TOO_NARROW'
  | 'DECODE_FAILED';

export interface UploadError {
  code: UploadErrorCode;
  /** Names the specific reason, safe to show next to the file's row. */
  message: string;
}

export interface DecodedImage {
  /** The bytes as uploaded. */
  bytes: Uint8Array;
  type: SniffedType;
  width: number;
  height: number;
  /** Display label only — never part of a key, path, header or URL. */
  label: string;
  /** Present when a decoder was supplied: RGBA pixels, metadata already gone. */
  pixels?: Uint8Array;
}

export type UploadResult = { ok: true; image: DecodedImage } | { ok: false; error: UploadError };

/** Enough of a `File` to validate. Astro/Workers `File` satisfies it structurally. */
export interface UploadCandidate {
  name: string;
  /** Advisory only. Recorded nowhere and trusted for nothing. */
  type?: string;
  size?: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** RGBA pixels plus intrinsic dimensions — what a real decode yields. */
export interface DecodedPixels {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** Step 6. Returns null on any decode failure; must not throw. */
export type DecodeFn = (bytes: Uint8Array, type: SniffedType) => Promise<DecodedPixels | null>;

const MESSAGES: Record<UploadErrorCode, string> = {
  EMPTY_FILE: 'This file is empty.',
  TOO_LARGE: 'This image is larger than 12 MB. Export it at a smaller file size and try again.',
  NOT_AN_IMAGE:
    'This file is not a JPEG, PNG, WebP or AVIF image. The file’s contents decide, not its name.',
  SVG_REJECTED:
    'SVG files are not accepted for product photography. Upload a JPEG, PNG, WebP or AVIF instead.',
  DIMENSIONS_UNREADABLE:
    'This image’s dimensions could not be read, so it may be damaged. Re-export it and try again.',
  TOO_MANY_PIXELS: 'This image is above 40 megapixels. Export it at a smaller size and try again.',
  // Worded for both callers. The admin uploads product photography; a visitor attaching a
  // photograph to a custom enquiry runs the same checks (Requirement 6.11), and telling them their
  // sketch is "too small for a product page" would be a message about someone else's problem.
  TOO_NARROW:
    'This image is narrower than 800 pixels. Export or photograph it at a larger size and try again.',
  DECODE_FAILED: 'This file could not be opened as an image. Re-export it and try again.',
};

function fail(code: UploadErrorCode, message?: string): { ok: false; error: UploadError } {
  return { ok: false, error: { code, message: message ?? MESSAGES[code] } };
}

/**
 * Step 2, before the body is read.
 *
 * Separate from `validateUpload` because the whole point is to answer without touching the
 * body: the endpoint calls this with the request's `Content-Length` and refuses a 40 MB
 * upload without buffering 40 MB.
 */
export function checkContentLength(contentLength: number | null): UploadResult | null {
  if (contentLength === null) return null;
  if (contentLength > UPLOAD_CONSTRAINTS.maxBytes) return fail('TOO_LARGE');
  return null;
}

/**
 * Validate one uploaded file.
 *
 * @param decode optional step 6. Omitted, validation stops after the header checks, which
 * is what the property test exercises; supplied, a file that cannot be decoded is refused
 * and the decoded pixels come back for derivative generation.
 */
export async function validateUpload(
  file: UploadCandidate,
  decode?: DecodeFn,
): Promise<UploadResult> {
  // 2. Size. Checked from the declared size first, then again from the actual bytes, since
  // a declared size is as trustworthy as a declared type.
  if (file.size !== undefined && file.size > UPLOAD_CONSTRAINTS.maxBytes) return fail('TOO_LARGE');

  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes.length === 0) return fail('EMPTY_FILE');
  if (bytes.length > UPLOAD_CONSTRAINTS.maxBytes) return fail('TOO_LARGE');

  // 3 & 4. The sniff decides. `file.type` and the extension are never consulted.
  const sniffed = sniffImageType(bytes.subarray(0, SNIFF_BYTES));
  if (!sniffed.ok) {
    if (sniffed.reason === 'svg') return fail('SVG_REJECTED');
    if (sniffed.reason === 'empty') return fail('EMPTY_FILE');
    return fail('NOT_AN_IMAGE');
  }

  // 5. Declared dimensions, before any allocation proportional to them.
  const header = readHeaderDimensions(bytes, sniffed.type.format);
  if (header === null) return fail('DIMENSIONS_UNREADABLE');
  if (header.width * header.height > UPLOAD_CONSTRAINTS.maxPixels) return fail('TOO_MANY_PIXELS');
  if (header.width < UPLOAD_CONSTRAINTS.minWidth) return fail('TOO_NARROW');

  const label = sanitizeFilenameLabel(file.name);

  if (decode === undefined) {
    return { ok: true, image: { bytes, type: sniffed.type, ...header, label } };
  }

  // 6. Full decode. Proves the file really is an image and yields pixels with no metadata
  // attached — EXIF, GPS, colour profiles and any appended payload are all gone, because
  // what comes back is a pixel buffer rather than a container.
  let decoded: DecodedPixels | null;
  try {
    decoded = await decode(bytes, sniffed.type);
  } catch {
    decoded = null;
  }
  if (decoded === null) return fail('DECODE_FAILED');

  // The decoder's dimensions win over the header's: the header is a claim, the decode is
  // the fact, and the intrinsic width/height stored on the record must be the fact
  // (Requirement 15.10).
  if (decoded.width * decoded.height > UPLOAD_CONSTRAINTS.maxPixels) return fail('TOO_MANY_PIXELS');
  if (decoded.width < UPLOAD_CONSTRAINTS.minWidth) return fail('TOO_NARROW');

  return {
    ok: true,
    image: {
      bytes,
      type: sniffed.type,
      width: decoded.width,
      height: decoded.height,
      label,
      pixels: decoded.rgba,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Server-side identity                                                       */
/* -------------------------------------------------------------------------- */

const LOWER_ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** `img_` + 10 lowercase alphanumerics, matching the schema's image id pattern. */
export function generateImageId(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let out = 'img_';
  for (const byte of bytes) out += LOWER_ALNUM[byte % LOWER_ALNUM.length];
  return out;
}
