/**
 * Site configuration loader.
 *
 * The three `data/site/*.json` files are imported (not read from disk) so they are
 * bundled: the same accessor works during the static build and inside the Worker,
 * with no filesystem access in either. Validation happens once at module load —
 * an invalid settings file fails the build with the failing field path rather than
 * rendering a page with a missing phone number.
 *
 * Design: Data Models → Other collections; Architecture → Request / Render Path.
 * Requirements: 7.7, 7.13, 8.8, 19.1, 19.6, 19.8, 26.11.
 */

import homepageJson from '../../../data/site/homepage.json';
import rankingsJson from '../../../data/site/rankings.json';
import redirectsJson from '../../../data/site/redirects.json';
import settingsJson from '../../../data/site/settings.json';
import { HOMEPAGE_SECTION_KEYS, HomepageSchema } from '@/schemas/homepage';
import type { Homepage, HomepageSection } from '@/schemas/homepage';
import { RankingsSchema } from '@/schemas/rankings';
import type { Rankings } from '@/schemas/rankings';
import { safeHref, safeText } from '@/lib/security/sanitize';
import { RedirectsSchema, SiteSettingsSchema } from '@/schemas/site';
import type { Redirects, SiteSettings } from '@/schemas/site';
import type { z } from 'zod';

/** Stable, greppable failure: the file is named, then every failing field path. */
function must<T>(
  schema: { safeParse: (input: unknown) => z.ZodSafeParseResult<T> },
  file: string,
  input: unknown,
): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
  throw new Error(`CONTENT_INVALID data/site/${file}: ${detail}`);
}

const settings: SiteSettings = must(SiteSettingsSchema, 'settings.json', settingsJson);
const homepage: Homepage = must(HomepageSchema, 'homepage.json', homepageJson);
const rankings: Rankings = must(RankingsSchema, 'rankings.json', rankingsJson);
const redirects: Redirects = must(RedirectsSchema, 'redirects.json', redirectsJson);

export function getSiteSettings(): SiteSettings {
  return settings;
}

export function getHomepage(): Homepage {
  return homepage;
}

export function getRankings(): Rankings {
  return rankings;
}

export function getRedirects(): Redirects {
  return redirects;
}

/**
 * The operator-editable copy on one homepage section, sanitized (Requirement 25.2, Property 55).
 *
 * These six fields are written from Admin → Homepage, so they are operator-supplied text rendered on
 * the site's most visited page. `ctaHref` goes through `safeHref` instead: it becomes an attribute
 * rather than a text node, so the question is not "does it contain markup" but "is this a scheme a
 * link may use" — a `javascript:` CTA href would be a stored XSS with a click target. An unusable
 * href becomes `undefined`, which the sections already treat as "render no CTA".
 */
function sanitizeSection(section: HomepageSection): HomepageSection {
  const href = section.ctaHref === undefined ? undefined : safeHref(section.ctaHref);
  return {
    ...section,
    ...(section.tagline === undefined ? {} : { tagline: safeText(section.tagline) }),
    ...(section.eyebrow === undefined ? {} : { eyebrow: safeText(section.eyebrow) }),
    ...(section.heading === undefined ? {} : { heading: safeText(section.heading) }),
    ...(section.subheading === undefined ? {} : { subheading: safeText(section.subheading) }),
    ...(section.body === undefined ? {} : { body: safeText(section.body) }),
    ...(section.ctaLabel === undefined ? {} : { ctaLabel: safeText(section.ctaLabel) }),
    ...(href === null || href === undefined ? {} : { ctaHref: href }),
  };
}

/**
 * Enabled sections in the required order (requirement 7.1). Omission is allowed;
 * reordering is not, which the schema already rejects — this sort is belt and
 * braces so a hand-edited file cannot change the rendered order.
 */
export function getEnabledSections(): HomepageSection[] {
  return homepage.sections
    .filter((section) => section.enabled)
    .map(sanitizeSection)
    .sort((a, b) => HOMEPAGE_SECTION_KEYS.indexOf(a.key) - HOMEPAGE_SECTION_KEYS.indexOf(b.key));
}

/** The content keys still awaiting real copy — the admin content checklist (8.8). */
export function getPlaceholderKeys(): string[] {
  const fromSections = homepage.sections
    .filter((section) => section.awaitingCopy)
    .map((section) => `homepage.${section.key}.body`);
  return [...new Set([...settings.placeholders, ...fromSections])].sort();
}
