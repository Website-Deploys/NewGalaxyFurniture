/**
 * The homepage hero image — read once, used twice.
 *
 * The hero renders it and the homepage preloads it, and those two have to agree on the URL or the
 * page fetches two images and preloads the wrong one. It was previously resolved inside
 * `HeroSection.astro`, where the page could not see it, which is why the homepage's LCP image was
 * the one image on the site that was `fetchpriority="high"` and never preloaded.
 *
 * `heroImage` is read defensively off the passthrough settings record, exactly as the tagline is:
 * no photograph has been supplied (design Open Items item 5), so `null` means "not supplied" and
 * the designed hairline composition answers instead. Setting `site.heroImage` swaps it in with no
 * code change.
 *
 * Requirements: 7.4, 7.12, 15.10, 19.6, 22.10.
 */

import type { SiteSettings } from '@/schemas/site';

export interface HeroImage {
  src: string;
  width: number;
  height: number;
  alt: string;
  lqip?: string;
  /** False for the project's own composition, true for an operator-supplied photograph. */
  supplied: boolean;
}

/** The project's own hairline room drawing: a design asset, not a claim about the business. */
export const HERO_COMPOSITION: HeroImage = {
  src: '/brand/hero-composition.svg',
  width: 1600,
  height: 1200,
  alt: 'A hairline drawing of a furnished room: a low sofa, a side table, and a floor lamp against a panelled wall.',
  supplied: false,
};

function suppliedHeroImage(settings: SiteSettings): HeroImage | null {
  const raw = (settings as unknown as Record<string, unknown>).heroImage;
  if (typeof raw !== 'object' || raw === null) return null;
  const { src, width, height, alt, lqip } = raw as Record<string, unknown>;
  if (typeof src !== 'string' || src.trim() === '') return null;
  // Intrinsic dimensions are not optional: without them the slot cannot be reserved, and the whole
  // point of the swap-in is that it does not reintroduce layout shift.
  if (typeof width !== 'number' || typeof height !== 'number') return null;
  return {
    src,
    width,
    height,
    alt: typeof alt === 'string' ? alt : '',
    ...(typeof lqip === 'string' ? { lqip } : {}),
    supplied: true,
  };
}

export function heroImageOf(settings: SiteSettings): HeroImage {
  return suppliedHeroImage(settings) ?? HERO_COMPOSITION;
}
