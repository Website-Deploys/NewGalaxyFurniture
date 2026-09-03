import { describe, expect, it } from 'vitest';

import {
  acceptsFormat,
  keyCandidates,
  negotiatedFormats,
  parseImageRequest,
} from '@/lib/images/delivery';
import { DELETED_PREFIX } from '@/lib/images/srcset';

/**
 * `/img/**` parsing and negotiation.
 *
 * The parser is a security boundary, not a convenience: the route is public and unauthenticated
 * and reads from a bucket that also holds soft-deleted objects. Anything it accepts becomes a
 * readable R2 key, so the tests below are as much about what it refuses as about what it maps.
 *
 * Requirements: 15.9, 15.13, 25.5.
 */

const PRODUCT = 'p_abcdefghij';
const IMAGE = 'img_abcdefghij';

describe('parsing', () => {
  it('maps a derivative URL to its width and format', () => {
    expect(parseImageRequest(`${PRODUCT}/${IMAGE}-960.webp`)).toStrictEqual({
      kind: 'derivative',
      productId: PRODUCT,
      imageId: IMAGE,
      width: 960,
      format: 'webp',
    });
    expect(parseImageRequest(`/${PRODUCT}/${IMAGE}-1280.avif`)).toMatchObject({ format: 'avif' });
    // `.jpg` in a URL is `jpeg` in the vocabulary.
    expect(parseImageRequest(`${PRODUCT}/${IMAGE}-1280.jpg`)).toMatchObject({ format: 'jpeg' });
  });

  it('maps the original URL to its stored extension', () => {
    expect(parseImageRequest(`${PRODUCT}/${IMAGE}-original.webp`)).toStrictEqual({
      kind: 'original',
      productId: PRODUCT,
      imageId: IMAGE,
      ext: 'webp',
    });
  });

  it('refuses anything that is not a product image', () => {
    const hostile = [
      '',
      '/',
      `${PRODUCT}`,
      `${PRODUCT}/${IMAGE}`,
      `${PRODUCT}/${IMAGE}-960`,
      `${PRODUCT}/${IMAGE}-960.gif`,
      `${PRODUCT}/${IMAGE}-960.svg`,
      `${PRODUCT}/${IMAGE}-abc.webp`,
      `${PRODUCT}/${IMAGE}-4000.webp`, // off the ladder and above every original
      `${PRODUCT}/nope-960.webp`,
      `p_short/${IMAGE}-960.webp`,
      `P_ABCDEFGHIJ/${IMAGE}-960.webp`,
      `${PRODUCT}/../${IMAGE}-960.webp`,
      `${DELETED_PREFIX}${PRODUCT}/${IMAGE}-960.webp`,
      `${PRODUCT}/${IMAGE}/960.webp`,
      `${PRODUCT}/${IMAGE}-960.webp/extra`,
      `${PRODUCT}/${IMAGE}-original.php`,
    ];
    for (const path of hostile) {
      expect(parseImageRequest(path), path).toBeNull();
    }
  });

  it('never resolves a soft-deleted object', () => {
    const request = parseImageRequest(`${PRODUCT}/${IMAGE}-960.webp`);
    expect(request).not.toBeNull();
    for (const candidate of keyCandidates(request!, 'image/webp')) {
      expect(candidate.key.startsWith(DELETED_PREFIX)).toBe(false);
      expect(candidate.key.startsWith(`products/${PRODUCT}/${IMAGE}/`)).toBe(true);
    }
  });
});

describe('format negotiation', () => {
  it('prefers AVIF, then WebP, then what was asked for', () => {
    expect(negotiatedFormats('webp', 'image/avif,image/webp,*/*')).toStrictEqual(['avif', 'webp']);
    expect(negotiatedFormats('webp', 'image/webp,image/jpeg')).toStrictEqual(['webp']);
    expect(negotiatedFormats('jpeg', 'image/jpeg')).toStrictEqual(['jpeg']);
    // A wildcard is an acceptance of everything, so the best format is offered.
    expect(negotiatedFormats('jpeg', '*/*')).toStrictEqual(['avif', 'webp', 'jpeg']);
  });

  it('always includes the requested format, so negotiation can only add candidates', () => {
    for (const accept of [null, '', 'text/html', 'image/png', 'image/avif']) {
      expect(negotiatedFormats('jpeg', accept)).toContain('jpeg');
    }
  });

  it('reads Accept without being fooled by an adjacent token', () => {
    expect(acceptsFormat('image/avif', 'image/avif')).toBe(true);
    expect(acceptsFormat('text/html,application/xhtml+xml', 'image/avif')).toBe(false);
    expect(acceptsFormat(null, 'image/webp')).toBe(false);
  });

  it('ends every derivative candidate list with the stored original', () => {
    const request = parseImageRequest(`${PRODUCT}/${IMAGE}-320.webp`);
    const candidates = keyCandidates(request!, 'image/webp');
    expect(candidates.at(-1)?.key).toContain('/original.');
  });
});
