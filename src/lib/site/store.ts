/**
 * What an admin request may say about `data/site/settings.json` and `data/site/homepage.json`.
 *
 * Same discipline as categories and reviews: a narrow input schema, a pure function that
 * derives the stored record from the current one plus the patch, and validation against the
 * canonical schema before anything is written. Keeping the derivation pure is what lets the
 * interesting rules be tested without a repository:
 *
 * - **Every number is validated as E.164** (Requirement 19.8), by the same `E164` schema the
 *   canonical settings schema uses. Adding a number is appending to an array, which is the
 *   whole of the "additional numbers without a change to the stored structure" requirement
 *   (19.2) — there is no schema migration and no code change.
 * - **An unsupplied location or social value stays `null`**, never becomes `""`. The public
 *   surfaces omit `null` (Requirement 19.6); an empty string is a supplied value that happens
 *   to be blank, and would render as one.
 * - **The homepage's order is not patchable.** `applyHomepagePatch` matches sections by key
 *   and rewrites copy and `enabled` in place, so the fifteen sections keep the order
 *   `HOMEPAGE_SECTION_KEYS` declares (Requirements 7.7, 7.13). There is no input through
 *   which an operator could reorder them, which is stronger than validating that they did
 *   not.
 * - **`placeholders` is derived, not typed in.** A location or social field the operator has
 *   just filled in is removed from the checklist by the same pass that stored it, so the
 *   checklist cannot drift from the data it describes (Requirement 8.8).
 *
 * Design: Data Models → Other collections; Pages, Navigation, and States → Homepage
 * composition.
 * Requirements: 7.7, 7.8, 7.13, 8.8, 19.1, 19.2, 19.6, 19.7, 19.8.
 */

import { z } from 'zod';

import { E164, SiteSettingsSchema, type SiteSettings } from '@/schemas/site';
import { HOMEPAGE_SECTION_KEYS, HomepageSchema, type Homepage } from '@/schemas/homepage';

export type FieldErrors = Record<string, string[]>;

/* -------------------------------------------------------------------------- */
/* Input schemas                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A contact number. The label is required and free text on purpose: Requirement 5.10 forbids
 * characterising either number as a different department, and the honest way to keep that
 * true is to let the operator write the label and to ship both as "Orders & Enquiries".
 * A validator that tried to police the wording would be guessing.
 */
const ContactNumberInput = z.object({
  label: z.string().trim().min(1).max(60),
  e164: E164,
});

const LocationInput = z.object({
  addressLines: z.array(z.string().trim().max(120)).max(6),
  city: z.string().trim().max(80),
  state: z.string().trim().max(80),
  postalCode: z.string().trim().max(12).nullable(),
  mapUrl: z.string().url().max(500).nullable(),
  geo: z.object({ lat: z.number(), lng: z.number() }).nullable(),
});

export const SettingsPatchInput = z
  .object({
    patch: z
      .object({
        businessName: z.string().trim().min(1).max(120),
        logo: z.object({
          src: z.string().trim().max(300).nullable(),
          wordmarkFallback: z.string().trim().min(1).max(120),
          /*
           * The asset's intrinsic pixels. Optional in the patch and mandatory in the settings schema
           * whenever `src` is set, so an operator who supplies a path without dimensions gets a
           * field-level message naming `logo.width`/`logo.height` rather than a header that shifts on
           * every page the moment the file loads.
           */
          width: z.number().int().positive().max(10_000).nullable().optional(),
          height: z.number().int().positive().max(10_000).nullable().optional(),
        }),
        // `.min(1)`: the site's contact controls are its conversion path, so an empty list
        // is not a state the operator can save their way into.
        whatsapp: z.array(ContactNumberInput).min(1).max(10),
        phone: z.array(ContactNumberInput).min(1).max(10),
        location: LocationInput,
        serviceArea: z.array(z.string().trim().min(1).max(80)).min(1).max(50),
        social: z.record(z.string().min(1).max(40), z.string().url().max(300).nullable()),
        seoDefaults: z.object({
          titleSuffix: z.string().max(60),
          description: z.string().trim().max(300),
          ogImageKey: z.string().trim().max(300).nullable(),
        }),
        /** The hero's positioning line, 1–120 characters (Requirement 7.8). */
        tagline: z.string().trim().min(1).max(120),
      })
      .partial()
      .strict(),
  })
  .strict();

export type SettingsPatch = z.infer<typeof SettingsPatchInput>['patch'];

/** One section's operator-editable copy. `key` identifies it; order is not patchable. */
const HomepageSectionPatch = z
  .object({
    key: z.enum(HOMEPAGE_SECTION_KEYS),
    enabled: z.boolean().optional(),
    eyebrow: z.string().trim().max(60).nullable().optional(),
    heading: z.string().trim().max(120).nullable().optional(),
    subheading: z.string().trim().max(240).nullable().optional(),
    body: z.string().trim().max(2000).nullable().optional(),
    ctaLabel: z.string().trim().max(40).nullable().optional(),
    ctaHref: z.string().trim().max(200).nullable().optional(),
  })
  .strict();

export const HomepagePatchInput = z
  .object({ sections: z.array(HomepageSectionPatch).min(1).max(HOMEPAGE_SECTION_KEYS.length) })
  .strict();

export type HomepageSectionPatchValue = z.infer<typeof HomepageSectionPatch>;

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

function fieldErrorsOf(error: z.ZodError): FieldErrors {
  const fields: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_';
    const bucket = fields[key];
    if (bucket === undefined) fields[key] = [issue.message];
    else if (!bucket.includes(issue.message)) bucket.push(issue.message);
  }
  return fields;
}

export function validateSettings(
  candidate: unknown,
): { ok: true; settings: SiteSettings } | { ok: false; fields: FieldErrors } {
  const parsed = SiteSettingsSchema.safeParse(candidate);
  return parsed.success
    ? { ok: true, settings: parsed.data }
    : { ok: false, fields: fieldErrorsOf(parsed.error) };
}

export function validateHomepage(
  candidate: unknown,
): { ok: true; homepage: Homepage } | { ok: false; fields: FieldErrors } {
  const parsed = HomepageSchema.safeParse(candidate);
  return parsed.success
    ? { ok: true, homepage: parsed.data }
    : { ok: false, fields: fieldErrorsOf(parsed.error) };
}

/* -------------------------------------------------------------------------- */
/* The placeholder checklist                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The settings keys the content checklist tracks, paired with the test for "still unsupplied".
 *
 * Written as data rather than as a chain of `if`s so that the checklist and the fields it
 * describes cannot fall out of step: adding a tracked key is one entry here, and it is
 * simultaneously added to the checklist and removed from it when filled.
 */
const TRACKED_SETTINGS_KEYS: readonly (readonly [string, (settings: SiteSettings) => boolean])[] = [
  ['site.logo.src', (s) => s.logo.src === null || s.logo.src.trim() === ''],
  ['site.location.addressLines', (s) => s.location.addressLines.length === 0],
  ['site.location.city', (s) => s.location.city.trim() === ''],
  ['site.location.state', (s) => s.location.state.trim() === ''],
  ['site.location.postalCode', (s) => s.location.postalCode === null],
  ['site.location.mapUrl', (s) => s.location.mapUrl === null],
  ['site.location.geo', (s) => s.location.geo === null],
  ['site.seoDefaults.ogImageKey', (s) => s.seoDefaults.ogImageKey === null],
];

/** Social keys are dynamic, so they are tracked by iterating whatever the record holds. */
function socialPlaceholders(settings: SiteSettings): string[] {
  return Object.entries(settings.social)
    .filter(([, value]) => value === null || value.trim() === '')
    .map(([key]) => `site.social.${key}`);
}

/**
 * Recompute `placeholders` for a settings record.
 *
 * Keys this function does not know about are preserved. That is not laziness: the checklist
 * also carries page-level keys (`page.about.body`, `content.reviews`, …) that no settings
 * field corresponds to, and dropping them because this pass cannot verify them would quietly
 * shorten the operator's to-do list.
 */
export function recomputePlaceholders(
  settings: SiteSettings,
  previous: readonly string[],
): string[] {
  const managed = new Set([
    ...TRACKED_SETTINGS_KEYS.map(([key]) => key),
    ...Object.keys(settings.social).map((key) => `site.social.${key}`),
  ]);

  const stillUnsupplied = [
    ...TRACKED_SETTINGS_KEYS.filter(([, isUnsupplied]) => isUnsupplied(settings)).map(
      ([key]) => key,
    ),
    ...socialPlaceholders(settings),
  ];
  const untracked = previous.filter((key) => !managed.has(key));

  return [...new Set([...untracked, ...stillUnsupplied])].sort();
}

/* -------------------------------------------------------------------------- */
/* Derivation                                                                 */
/* -------------------------------------------------------------------------- */

/** Trim, and turn a blank into `null` — the "unsupplied" representation (19.6). */
function nullableText(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Apply a settings patch.
 *
 * The `tagline` deserves a note. The design puts the positioning line in site settings
 * (Requirement 7.8) and `SiteSettingsSchema` does not declare a field for it — the schema is
 * `.passthrough()`, so it round-trips, but nothing types it. It is stored as a top-level
 * `tagline` key here and read by the hero through the homepage's `hero.tagline`, which the
 * homepage schema *does* declare with the same 1–120 bound. Writing it in both places would
 * be two sources of truth for one sentence, so this function writes the settings key and
 * `applyTaglineToHomepage` propagates it to the hero section, keeping the two consistent by
 * construction.
 */
export function applySettingsPatch(
  current: SiteSettings,
  patch: SettingsPatch,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };

  if (patch.businessName !== undefined) next.businessName = patch.businessName;
  if (patch.logo !== undefined) {
    const src = nullableText(patch.logo.src);
    next.logo = {
      src,
      wordmarkFallback: patch.logo.wordmarkFallback,
      // Cleared alongside the path: dimensions for an asset that is no longer set describe nothing.
      width: src === null ? null : (patch.logo.width ?? null),
      height: src === null ? null : (patch.logo.height ?? null),
    };
  }
  if (patch.whatsapp !== undefined) next.whatsapp = patch.whatsapp;
  if (patch.phone !== undefined) next.phone = patch.phone;
  if (patch.location !== undefined) {
    next.location = {
      // Blank lines are dropped rather than stored: an address with an empty line in it
      // renders as a gap on every surface that prints it.
      addressLines: patch.location.addressLines
        .map((line) => line.trim())
        .filter((line) => line !== ''),
      city: patch.location.city.trim(),
      state: patch.location.state.trim(),
      postalCode: nullableText(patch.location.postalCode),
      mapUrl: nullableText(patch.location.mapUrl),
      geo: patch.location.geo,
    };
  }
  if (patch.serviceArea !== undefined) next.serviceArea = patch.serviceArea;
  if (patch.social !== undefined) {
    const social: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(patch.social)) social[key] = nullableText(value);
    next.social = social;
  }
  if (patch.seoDefaults !== undefined) {
    next.seoDefaults = {
      titleSuffix: patch.seoDefaults.titleSuffix,
      description: patch.seoDefaults.description.trim(),
      ogImageKey: nullableText(patch.seoDefaults.ogImageKey),
    };
  }
  if (patch.tagline !== undefined) next.tagline = patch.tagline;

  const validated = SiteSettingsSchema.safeParse(next);
  if (validated.success) {
    next.placeholders = recomputePlaceholders(validated.data, current.placeholders);
  }
  return next;
}

/** The stored positioning line, or `null` when the operator has not set one. */
export function taglineOf(settings: SiteSettings): string | null {
  const raw = (settings as Record<string, unknown>).tagline;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

/** The hero section's positioning line, which the seeded content ships with. */
export function heroTaglineOf(homepage: Homepage): string | null {
  const hero = homepage.sections.find((section) => section.key === 'hero');
  return hero?.tagline ?? null;
}

/**
 * The positioning line in force: the settings key, falling back to the hero's.
 *
 * The fallback exists because the seeded content carries the line on the hero section only.
 * Rather than migrate the file, the settings key wins once it is written and the hero's value
 * answers until then — so the admin form is never blank on a fresh install, and the two never
 * disagree, because a save writes both.
 */
export function effectiveTagline(settings: SiteSettings, homepage: Homepage): string | null {
  return taglineOf(settings) ?? heroTaglineOf(homepage);
}

/**
 * Propagate the settings tagline onto the hero section, so the hero has one source.
 *
 * Returns the homepage unchanged when there is nothing to propagate, so a settings save that
 * did not touch the tagline produces no homepage commit.
 */
export function applyTaglineToHomepage(
  homepage: Homepage,
  tagline: string | null,
): Record<string, unknown> | null {
  if (tagline === null) return null;
  const hero = homepage.sections.find((section) => section.key === 'hero');
  if (hero === undefined || hero.tagline === tagline) return null;
  return {
    ...homepage,
    sections: homepage.sections.map((section) =>
      section.key === 'hero' ? { ...section, tagline } : section,
    ),
  };
}

/**
 * Apply a homepage patch: copy and `enabled`, matched by key, order untouched.
 *
 * `awaitingCopy` is recomputed rather than accepted from the request. It means "this section
 * still shows a placeholder", which is a fact about the body text, and the schema rejects a
 * record where the flag and the body disagree — so deriving it is the only way a save cannot
 * produce an invalid file.
 */
export function applyHomepagePatch(
  current: Homepage,
  patch: readonly HomepageSectionPatchValue[],
): Record<string, unknown> {
  const byKey = new Map(patch.map((entry) => [entry.key, entry]));

  const sections = current.sections.map((section) => {
    const entry = byKey.get(section.key);
    if (entry === undefined) return section;

    const next: Record<string, unknown> = { ...section };
    if (entry.enabled !== undefined) next.enabled = entry.enabled;

    for (const field of [
      'eyebrow',
      'heading',
      'subheading',
      'body',
      'ctaLabel',
      'ctaHref',
    ] as const) {
      const value = entry[field];
      if (value === undefined) continue;
      const cleaned = nullableText(value);
      // The schema declares these `optional()`, so "cleared" is an absent key rather than
      // an empty string — the same distinction the category patch makes.
      if (cleaned === null) delete next[field];
      else next[field] = cleaned;
    }

    const body = typeof next.body === 'string' ? next.body : undefined;
    next.awaitingCopy = body !== undefined && /\[PLACEHOLDER/i.test(body);
    return next;
  });

  return { ...current, sections };
}

/** Homepage keys still holding a placeholder — the checklist's homepage half (8.8). */
export function homepagePlaceholderKeys(homepage: Homepage): string[] {
  return homepage.sections
    .filter((section) => section.awaitingCopy)
    .map((section) => `homepage.${section.key}.body`);
}
