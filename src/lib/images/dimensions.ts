/**
 * Header-level dimension parsing.
 *
 * This exists so the pixel-count and minimum-width checks happen **before** a full decode
 * (Requirement 15.2). That ordering is the decompression-bomb defence: a 200 MP PNG is a
 * few hundred kilobytes on the wire and gigabytes in memory, so the size check alone does
 * not protect the Worker. Reading the declared dimensions out of the header costs a few
 * bytes and refuses the file before any pixel is allocated.
 *
 * The parsers are deliberately minimal and total — each returns `null` rather than
 * throwing on anything malformed, and a `null` is treated as "cannot be verified, reject"
 * by the caller. They are not a substitute for the decode: the decode is what proves the
 * file is really an image, and it runs afterwards.
 *
 * Design: Image Pipeline → Upload validation (step 5).
 * Requirements: 15.2, 15.5, 25.6.
 */

import type { SniffedFormat } from './sniff';

export interface HeaderDimensions {
  width: number;
  height: number;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

function u16be(bytes: Uint8Array, offset: number): number | null {
  if (offset + 1 >= bytes.length) return null;
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function u32be(bytes: Uint8Array, offset: number): number | null {
  if (offset + 3 >= bytes.length) return null;
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function u24le(bytes: Uint8Array, offset: number): number | null {
  if (offset + 2 >= bytes.length) return null;
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

/** PNG: `IHDR` is the first chunk, so width and height sit at fixed offsets. */
function pngDimensions(bytes: Uint8Array): HeaderDimensions | null {
  if (ascii(bytes, 12, 4) !== 'IHDR') return null;
  const width = u32be(bytes, 16);
  const height = u32be(bytes, 20);
  if (width === null || height === null || width === 0 || height === 0) return null;
  return { width, height };
}

/**
 * JPEG: walk the marker segments to the first Start-Of-Frame.
 *
 * Progressive and arithmetic-coded frames use different SOF markers, hence the range
 * check rather than a comparison with `0xC0`. `0xC4`, `0xC8` and `0xCC` are excluded
 * because they are Huffman/arithmetic tables, not frames.
 */
function jpegDimensions(bytes: Uint8Array): HeaderDimensions | null {
  let offset = 2; // skip SOI
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = u16be(bytes, offset + 2);
    if (length === null || length < 2) return null;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) {
      const height = u16be(bytes, offset + 5);
      const width = u16be(bytes, offset + 7);
      if (width === null || height === null || width === 0 || height === 0) return null;
      return { width, height };
    }
    offset += 2 + length;
  }
  return null;
}

/** WebP: one of three chunk layouts — lossy (VP8), lossless (VP8L), extended (VP8X). */
function webpDimensions(bytes: Uint8Array): HeaderDimensions | null {
  const chunk = ascii(bytes, 12, 4);
  if (chunk === 'VP8X') {
    const width = u24le(bytes, 24);
    const height = u24le(bytes, 27);
    if (width === null || height === null) return null;
    return { width: width + 1, height: height + 1 };
  }
  if (chunk === 'VP8 ') {
    // 3-byte frame tag, then the 3-byte start code 0x9d012a, then two little-endian
    // 16-bit fields whose top two bits are a scale factor, not part of the dimension.
    if (bytes.length < 31) return null;
    const width = (((bytes[27] ?? 0) | ((bytes[28] ?? 0) << 8)) & 0x3fff) >>> 0;
    const height = (((bytes[29] ?? 0) | ((bytes[30] ?? 0) << 8)) & 0x3fff) >>> 0;
    if (width === 0 || height === 0) return null;
    return { width, height };
  }
  if (chunk === 'VP8L') {
    // A 1-byte signature at offset 20, then 14 bits of width-1 and 14 bits of height-1,
    // little-endian bit order.
    if (bytes.length < 25) return null;
    const packed =
      ((bytes[21] ?? 0) |
        ((bytes[22] ?? 0) << 8) |
        ((bytes[23] ?? 0) << 16) |
        ((bytes[24] ?? 0) << 24)) >>>
      0;
    return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

/**
 * AVIF: find the `ispe` box and read the image spatial extents.
 *
 * A full ISO-BMFF walk would mean implementing box nesting for `meta`/`iprp`/`ipco`, and
 * `ispe` is uniquely identified by its own four-character code, so scanning for it is both
 * shorter and harder to get wrong. The first `ispe` is the primary item's in every encoder
 * this project can encounter; a wrong guess here can only over-report dimensions, which
 * fails *closed* against the pixel ceiling.
 */
function avifDimensions(bytes: Uint8Array): HeaderDimensions | null {
  const limit = Math.min(bytes.length, 65_536);
  for (let offset = 0; offset + 20 <= limit; offset += 1) {
    if (ascii(bytes, offset, 4) !== 'ispe') continue;
    // 4 bytes version+flags follow the box type, then width and height.
    const width = u32be(bytes, offset + 8);
    const height = u32be(bytes, offset + 12);
    if (width === null || height === null || width === 0 || height === 0) continue;
    return { width, height };
  }
  return null;
}

/** Declared dimensions, or `null` when the header cannot be trusted to state them. */
export function readHeaderDimensions(
  bytes: Uint8Array,
  format: SniffedFormat,
): HeaderDimensions | null {
  switch (format) {
    case 'png':
      return pngDimensions(bytes);
    case 'jpeg':
      return jpegDimensions(bytes);
    case 'webp':
      return webpDimensions(bytes);
    case 'avif':
      return avifDimensions(bytes);
  }
}
