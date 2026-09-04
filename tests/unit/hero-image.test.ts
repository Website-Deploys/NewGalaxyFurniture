import { describe, expect, it } from 'vitest';

import { HERO_COMPOSITION, heroImageOf } from '@/lib/site/hero-image';
import type { SiteSettings } from '@/schemas/site';

/**
 * The homepage hero image, and the settings record it is read from.
 *
 * `heroImage` reaches this module through the site schema's `passthrough()`, so it is *unvalidated by
 * construction* — that is what makes swapping the hero a settings edit rather than a code change,
 * and it is what makes validating it here mandatory rather than defensive. The failure this guards
 * is quiet and late: a malformed dimension emits an `<img width>` a browser cannot reserve a box
 * from, the hero shifts on load, and nothing says why, weeks after anyone looked at the file.
 *
 * `typeof value === 'number'` is true of `NaN`, `Infinity`, `0` and `-1`. Each is asserted.
 *
 * Requirements: 7.4, 7.12, 22.10.
 */

/** A settings object carrying an arbitrary `heroImage`, as the passthrough schema would produce. */
function withHero(heroImage: unknown): SiteSettings {
  return { heroImage } as unknown as SiteSettings;
}

describe('heroImageOf', () => {
  it('falls back to the designed composition when nothing is supplied', () => {
    expect(heroImageOf({} as unknown as SiteSettings)).toStrictEqual(HERO_COMPOSITION);
    expect(heroImageOf(withHero(null))).toStrictEqual(HERO_COMPOSITION);
    expect(heroImageOf(withHero('/photo.jpg'))).toStrictEqual(HERO_COMPOSITION);
  });

  it('accepts a well-formed photograph and marks it as supplied', () => {
    const hero = heroImageOf(
      withHero({ src: '/img/hero.jpg', width: 2000, height: 1250, alt: 'A finished room.' }),
    );
    expect(hero).toStrictEqual({
      src: '/img/hero.jpg',
      width: 2000,
      height: 1250,
      alt: 'A finished room.',
      supplied: true,
    });
  });

  it('carries a low-quality placeholder when one is supplied, and omits it when it is blank', () => {
    const withLqip = heroImageOf(
      withHero({ src: '/img/hero.jpg', width: 800, height: 600, lqip: 'data:image/webp;base64,x' }),
    );
    expect(withLqip.lqip).toBe('data:image/webp;base64,x');

    const blank = heroImageOf(
      withHero({ src: '/img/hero.jpg', width: 800, height: 600, lqip: '  ' }),
    );
    expect('lqip' in blank).toBe(false);
  });

  it('defaults alt to empty rather than inventing a description', () => {
    // An operator who supplies no alt text gets a decorative image, not a sentence written for them.
    expect(heroImageOf(withHero({ src: '/img/hero.jpg', width: 800, height: 600 })).alt).toBe('');
  });

  it('refuses a src that is missing or blank', () => {
    for (const src of [undefined, '', '   ', 42, null]) {
      expect(heroImageOf(withHero({ src, width: 800, height: 600 })), String(src)).toStrictEqual(
        HERO_COMPOSITION,
      );
    }
  });

  it('trims a padded src rather than emitting a URL with whitespace in it', () => {
    expect(heroImageOf(withHero({ src: '  /img/hero.jpg  ', width: 800, height: 600 })).src).toBe(
      '/img/hero.jpg',
    );
  });

  it('refuses every dimension a browser cannot reserve a box from', () => {
    const unusable = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      0,
      -1,
      -1600,
      12.5,
      20_001,
      '1600',
      null,
      undefined,
    ];
    for (const value of unusable) {
      expect(
        heroImageOf(withHero({ src: '/img/hero.jpg', width: value, height: 600 })),
        `width ${String(value)}`,
      ).toStrictEqual(HERO_COMPOSITION);
      expect(
        heroImageOf(withHero({ src: '/img/hero.jpg', width: 800, height: value })),
        `height ${String(value)}`,
      ).toStrictEqual(HERO_COMPOSITION);
    }
  });

  it('accepts the boundary dimensions on both ends', () => {
    expect(heroImageOf(withHero({ src: '/a.jpg', width: 1, height: 1 })).supplied).toBe(true);
    expect(heroImageOf(withHero({ src: '/a.jpg', width: 20_000, height: 20_000 })).supplied).toBe(
      true,
    );
  });

  it('never returns a hero whose slot cannot be reserved', () => {
    // The property that matters, stated once: whatever the settings say, the returned dimensions are
    // always usable — because the fallback's are.
    for (const heroImage of [
      undefined,
      null,
      {},
      { src: '/a.jpg' },
      { src: '/a.jpg', width: Number.NaN, height: Number.NaN },
      { src: '/a.jpg', width: 0, height: 0 },
      { src: '/a.jpg', width: 1600, height: 1200 },
    ]) {
      const hero = heroImageOf(withHero(heroImage));
      expect(Number.isInteger(hero.width) && hero.width > 0).toBe(true);
      expect(Number.isInteger(hero.height) && hero.height > 0).toBe(true);
    }
  });
});
