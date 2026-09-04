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

/**
 * The largest intrinsic dimension a photograph may declare, in px.
 *
 * Not a limit on what can be uploaded — a sanity bound on what can be *declared*. A record claiming
 * 100000 px is a typo or a corrupted field, and honouring it would emit an `<img width>` that
 * reserves a slot taller than the document.
 */
const MAX_DIMENSION_PX = 20_000;

/** A declared intrinsic dimension that a browser can actually reserve a box from. */
function isUsableDimension(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_DIMENSION_PX
  );
}

/**
 * The operator's photograph, or `null` when the settings record does not describe a usable one.
 *
 * Every field is validated rather than trusted, because this record reaches the page through the
 * schema's `passthrough()` — it is unvalidated by construction, which is what makes swapping the
 * hero a settings change rather than a code change, and what makes checking it here mandatory.
 *
 * The dimensions get the strictest treatment. `typeof width === 'number'` is true of `NaN`,
 * `Infinity`, `-1` and `0`, and each of those produces an `<img width>` a browser cannot reserve a
 * box from: `NaN` and `Infinity` serialise to attributes the parser discards, and zero or negative
 * values collapse the slot. The result in every case is the layout shift this module exists to
 * prevent — and it would appear only after an operator edited a settings file, long after anyone
 * was looking. `null` instead falls back to the designed composition, which always has usable
 * dimensions.
 */
function suppliedHeroImage(settings: SiteSettings): HeroImage | null {
  const raw = (settings as unknown as Record<string, unknown>).heroImage;
  if (typeof raw !== 'object' || raw === null) return null;
  const { src, width, height, alt, lqip } = raw as Record<string, unknown>;
  if (typeof src !== 'string' || src.trim() === '') return null;
  // Intrinsic dimensions are not optional: without them the slot cannot be reserved, and the whole
  // point of the swap-in is that it does not reintroduce layout shift.
  if (!isUsableDimension(width) || !isUsableDimension(height)) return null;
  return {
    src: src.trim(),
    width,
    height,
    alt: typeof alt === 'string' ? alt : '',
    ...(typeof lqip === 'string' && lqip.trim() !== '' ? { lqip: lqip.trim() } : {}),
    supplied: true,
  };
}

export function heroImageOf(settings: SiteSettings): HeroImage {
  return suppliedHeroImage(settings) ?? HERO_COMPOSITION;
}
