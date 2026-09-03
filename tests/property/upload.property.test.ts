import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { sniffImageType } from '@/lib/images/sniff';
import { UPLOAD_CONSTRAINTS, validateUpload } from '@/lib/images/validate';
import { fileFrom, makePng } from '../fixtures/images';
import { assertAsyncProperty, assertProperty } from './config';

/**
 * Upload acceptance is decided by the file's leading bytes.
 *
 * Design: Image Pipeline → Upload validation.
 */

/** Leading bytes of formats that are **not** acceptable product imagery. */
const HOSTILE_SIGNATURES: readonly { label: string; bytes: number[] }[] = [
  { label: 'svg', bytes: [...Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">', 'ascii')] },
  { label: 'svg-xml-prolog', bytes: [...Buffer.from('<?xml version="1.0"?><svg>', 'ascii')] },
  { label: 'php', bytes: [...Buffer.from('<?php system($_GET[0]); ?>', 'ascii')] },
  { label: 'html', bytes: [...Buffer.from('<!DOCTYPE html><html><script>', 'ascii')] },
  { label: 'elf', bytes: [0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00] },
  { label: 'zip', bytes: [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00] },
  { label: 'gif', bytes: [...Buffer.from('GIF89a', 'ascii')] },
  { label: 'pdf', bytes: [...Buffer.from('%PDF-1.7', 'ascii')] },
  {
    label: 'riff-wave',
    bytes: [...Buffer.from('RIFF', 'ascii'), 0, 0, 0, 0, ...Buffer.from('WAVE', 'ascii')],
  },
  { label: 'bmp', bytes: [0x42, 0x4d, 0x00, 0x00, 0x00, 0x00] },
  { label: 'tiff-le', bytes: [0x49, 0x49, 0x2a, 0x00] },
  { label: 'mp4-ftyp', bytes: [0, 0, 0, 0x20, ...Buffer.from('ftypisom', 'ascii'), 0, 0, 0, 0] },
];

/** Declared content types and extensions an attacker would choose — all advisory only. */
const declaredTypeArb = fc.constantFrom(
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/svg+xml',
  'application/octet-stream',
  '',
);
const filenameArb = fc.constantFrom(
  'photo.jpg',
  'photo.jpeg',
  'photo.png',
  'photo.webp',
  'photo.avif',
  'photo.JPG',
  'photo.php.jpg',
  'photo',
);

const hostileBytesArb = fc
  .tuple(fc.constantFrom(...HOSTILE_SIGNATURES), fc.uint8Array({ minLength: 64, maxLength: 512 }))
  .map(([signature, tail]) => ({
    label: signature.label,
    bytes: new Uint8Array([...signature.bytes, ...tail]),
  }));

describe('Property 46: Magic bytes decide upload acceptance', () => {
  it('rejects every non-image signature regardless of declared type or extension', async () => {
    await assertAsyncProperty(
      fc.asyncProperty(
        hostileBytesArb,
        declaredTypeArb,
        filenameArb,
        async (hostile, declaredType, filename) => {
          const outcome = await validateUpload(fileFrom(filename, declaredType, hostile.bytes));
          expect(outcome.ok).toBe(false);
          if (!outcome.ok) {
            // SVG gets its own reason; everything else is "not an image". Either way the file
            // never reaches a decode, a key, or R2.
            expect(['SVG_REJECTED', 'NOT_AN_IMAGE', 'DIMENSIONS_UNREADABLE']).toContain(
              outcome.error.code,
            );
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('rejects an SVG specifically as an SVG, so the operator learns the real reason', async () => {
    await assertAsyncProperty(
      fc.asyncProperty(declaredTypeArb, filenameArb, async (declaredType, filename) => {
        const svg = new Uint8Array(
          Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>', 'ascii'),
        );
        const outcome = await validateUpload(fileFrom(filename, declaredType, svg));
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.error.code).toBe('SVG_REJECTED');
      }),
    );
  });

  it('accepts a real image whatever its declared type and extension claim', async () => {
    await assertAsyncProperty(
      fc.asyncProperty(declaredTypeArb, filenameArb, async (declaredType, filename) => {
        const png = makePng(900, 600);
        const outcome = await validateUpload(fileFrom(filename, declaredType, png));
        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
          expect(outcome.image.type.mime).toBe('image/png');
          expect(outcome.image.width).toBe(900);
          expect(outcome.image.height).toBe(600);
        }
      }),
      { numRuns: 50 },
    );
  });

  it('is total: arbitrary bytes yield a verdict rather than an exception', () => {
    assertProperty(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 200 }), (bytes) => {
        const result = sniffImageType(bytes);
        expect(typeof result.ok).toBe('boolean');
      }),
    );
  });

  it('rejects a valid image that breaches the size, pixel or width bounds', async () => {
    // 12 MB + 1 of leading-byte-valid PNG: the size check precedes everything else.
    const oversized = new Uint8Array(UPLOAD_CONSTRAINTS.maxBytes + 1);
    oversized.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const tooBig = await validateUpload(fileFrom('big.png', 'image/png', oversized));
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.error.code).toBe('TOO_LARGE');

    const narrow = await validateUpload(fileFrom('narrow.png', 'image/png', makePng(799, 600)));
    expect(narrow.ok).toBe(false);
    if (!narrow.ok) expect(narrow.error.code).toBe('TOO_NARROW');

    // A PNG header claiming 40 MP + 1, without the pixels to back it: the header is checked
    // before anything is allocated, which is the decompression-bomb defence.
    const bomb = makePng(8, 8);
    const header = new Uint8Array(bomb);
    // 20001 × 2001 = 40,022,001 pixels.
    new DataView(header.buffer).setUint32(16, 20001);
    new DataView(header.buffer).setUint32(20, 2001);
    const bombOutcome = await validateUpload(fileFrom('bomb.png', 'image/png', header));
    expect(bombOutcome.ok).toBe(false);
    if (!bombOutcome.ok) expect(bombOutcome.error.code).toBe('TOO_MANY_PIXELS');
  });
});
