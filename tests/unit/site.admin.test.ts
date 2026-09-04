import { describe, expect, it } from 'vitest';

import {
  applyHomepagePatch,
  applySettingsPatch,
  applyTaglineToHomepage,
  effectiveTagline,
  homepagePlaceholderKeys,
  HomepagePatchInput,
  recomputePlaceholders,
  SettingsPatchInput,
  taglineOf,
  validateHomepage,
  validateSettings,
} from '@/lib/site/store';
import { buildNewProduct, ProductCreateInput } from '@/lib/products/input';
import { getHomepage, getSiteSettings } from '@/lib/content/site';
import { HOMEPAGE_SECTION_KEYS } from '@/schemas/homepage';

/**
 * Settings, homepage, and product provenance.
 *
 * The seeded `data/site/*.json` files are used as the starting point rather than fixtures, so these
 * tests also assert that the shipped content is patchable — a settings file the admin endpoint
 * cannot round-trip is a settings screen that is broken on day one.
 *
 * Requirements: 7.7, 7.8, 7.13, 8.8, 14.11, 16.4, 19.1, 19.2, 19.6, 19.7, 19.8.
 */

const SETTINGS = getSiteSettings();
const HOMEPAGE = getHomepage();

describe('settings patches', () => {
  it('round-trips the shipped settings unchanged through an empty patch', () => {
    const patched = applySettingsPatch(SETTINGS, {});
    const validated = validateSettings(patched);
    expect(validated.ok).toBe(true);
  });

  it('accepts an additional number without a change to the stored structure', () => {
    const parsed = SettingsPatchInput.safeParse({
      patch: {
        whatsapp: [...SETTINGS.whatsapp, { label: 'Orders & Enquiries 3', e164: '+919876543210' }],
      },
    });
    expect(parsed.success).toBe(true);

    const patched = applySettingsPatch(SETTINGS, parsed.success ? parsed.data.patch : {});
    const validated = validateSettings(patched);
    expect(validated.ok).toBe(true);
    if (validated.ok) expect(validated.settings.whatsapp).toHaveLength(3);
  });

  it('refuses a number that is not well-formed E.164', () => {
    for (const bad of ['9513443606', '+91 95134 43606', '', '+0123456789', 'not a number']) {
      const parsed = SettingsPatchInput.safeParse({
        patch: { phone: [{ label: 'Orders', e164: bad }] },
      });
      expect(parsed.success, `accepted "${bad}"`).toBe(false);
    }
    expect(
      SettingsPatchInput.safeParse({
        patch: { phone: [{ label: 'Orders', e164: '+919513443606' }] },
      }).success,
    ).toBe(true);
  });

  it('refuses an empty contact list — the conversion path cannot be saved away', () => {
    expect(SettingsPatchInput.safeParse({ patch: { whatsapp: [] } }).success).toBe(false);
    expect(SettingsPatchInput.safeParse({ patch: { phone: [] } }).success).toBe(false);
  });

  it('stores an unsupplied optional value as null rather than an empty string', () => {
    const patched = applySettingsPatch(SETTINGS, {
      location: {
        addressLines: ['  ', 'Line one', ''],
        city: ' Bengaluru ',
        state: 'Karnataka',
        postalCode: '   ',
        mapUrl: '',
        geo: null,
      },
      social: { instagram: '   ', facebook: null },
    });

    const validated = validateSettings(patched);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    // Blank means unsupplied, so the public surfaces omit it (Requirement 19.6). An empty string
    // is a supplied value and would render as one.
    expect(validated.settings.location.postalCode).toBeNull();
    expect(validated.settings.location.mapUrl).toBeNull();
    expect(validated.settings.social.instagram).toBeNull();
    // Blank address lines are dropped, not stored as gaps.
    expect(validated.settings.location.addressLines).toEqual(['Line one']);
    expect(validated.settings.location.city).toBe('Bengaluru');
  });

  it('rejects an unrecognised key rather than silently dropping it', () => {
    expect(
      SettingsPatchInput.safeParse({ patch: { businessName: 'X', yearsInBusiness: 25 } }).success,
    ).toBe(false);
  });
});

describe('the content checklist', () => {
  it('drops a key once its value is supplied, and keeps untracked keys', () => {
    const before = recomputePlaceholders(SETTINGS, SETTINGS.placeholders);
    expect(before).toContain('site.location.city');
    // Page-level keys have no settings field, so this pass must not shorten the operator's list
    // by pretending they are done.
    expect(before).toContain('page.about.body');

    const patched = applySettingsPatch(SETTINGS, {
      location: {
        addressLines: ['Line one'],
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560001',
        mapUrl: null,
        geo: null,
      },
    });
    const validated = validateSettings(patched);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    expect(validated.settings.placeholders).not.toContain('site.location.city');
    expect(validated.settings.placeholders).not.toContain('site.location.addressLines');
    // Still unsupplied, so still listed.
    expect(validated.settings.placeholders).toContain('site.location.mapUrl');
    expect(validated.settings.placeholders).toContain('page.about.body');
  });

  it('re-adds a key when its value is cleared', () => {
    const supplied = applySettingsPatch(SETTINGS, {
      logo: {
        src: '/brand/logo.svg',
        wordmarkFallback: SETTINGS.logo.wordmarkFallback,
        width: 240,
        height: 64,
      },
    });
    const first = validateSettings(supplied);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.settings.placeholders).not.toContain('site.logo.src');

    const cleared = applySettingsPatch(first.settings, {
      logo: { src: '', wordmarkFallback: SETTINGS.logo.wordmarkFallback },
    });
    const second = validateSettings(cleared);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.settings.placeholders).toContain('site.logo.src');
    // Clearing the path clears the dimensions with it, rather than leaving them describing nothing.
    if (second.ok) expect(second.settings.logo.width).toBeNull();
  });

  it('refuses a brand mark path with no intrinsic dimensions, naming both fields', () => {
    /*
     * Every image on the site carries intrinsic dimensions so its box is reserved before it loads,
     * and the brand mark is the one image whose dimensions cannot come from the product schema. An
     * asset without them is a header that shifts sideways on every page, so it is a validation
     * failure the operator can fix rather than a silent regression.
     */
    const withoutBox = applySettingsPatch(SETTINGS, {
      logo: { src: '/brand/logo.svg', wordmarkFallback: SETTINGS.logo.wordmarkFallback },
    });
    const validated = validateSettings(withoutBox);
    expect(validated.ok).toBe(false);
    if (validated.ok) return;
    expect(Object.keys(validated.fields).sort()).toEqual(['logo.height', 'logo.width']);
  });

  it('lists every homepage section still holding a placeholder', () => {
    const keys = homepagePlaceholderKeys(HOMEPAGE);
    expect(keys).toContain('homepage.craftsmanship.body');
    expect(keys.every((key) => key.startsWith('homepage.'))).toBe(true);
  });
});

describe('the positioning line', () => {
  it('falls back to the hero’s value until one is saved in settings', () => {
    expect(taglineOf(SETTINGS)).toBeNull();
    expect(effectiveTagline(SETTINGS, HOMEPAGE)).toBe('Furniture made to outlast the trend');
  });

  it('accepts 1 to 120 characters and refuses either side of that', () => {
    expect(SettingsPatchInput.safeParse({ patch: { tagline: 'a' } }).success).toBe(true);
    expect(SettingsPatchInput.safeParse({ patch: { tagline: 'a'.repeat(120) } }).success).toBe(
      true,
    );
    expect(SettingsPatchInput.safeParse({ patch: { tagline: '' } }).success).toBe(false);
    expect(SettingsPatchInput.safeParse({ patch: { tagline: 'a'.repeat(121) } }).success).toBe(
      false,
    );
  });

  it('propagates to the hero, and produces no write when it already agrees', () => {
    const changed = applyTaglineToHomepage(HOMEPAGE, 'Made to be lived on');
    expect(changed).not.toBeNull();
    const validated = validateHomepage(changed);
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      const hero = validated.homepage.sections.find((section) => section.key === 'hero');
      expect(hero?.tagline).toBe('Made to be lived on');
    }

    // Already equal: null, so a settings save that did not touch the line makes no commit.
    expect(applyTaglineToHomepage(HOMEPAGE, 'Furniture made to outlast the trend')).toBeNull();
    expect(applyTaglineToHomepage(HOMEPAGE, null)).toBeNull();
  });
});

describe('homepage patches', () => {
  it('preserves the required order, whatever order the patch arrives in', () => {
    const reversed = [...HOMEPAGE.sections].reverse().map((section) => ({ key: section.key }));
    const parsed = HomepagePatchInput.safeParse({ sections: reversed });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const patched = applyHomepagePatch(HOMEPAGE, parsed.data.sections);
    const validated = validateHomepage(patched);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    // The patch cannot express a reorder: sections are matched by key and rewritten in place.
    expect(validated.homepage.sections.map((section) => section.key)).toEqual(
      HOMEPAGE.sections.map((section) => section.key),
    );
  });

  it('has no field through which a position could be sent', () => {
    expect(HomepagePatchInput.safeParse({ sections: [{ key: 'hero', order: 5 }] }).success).toBe(
      false,
    );
    expect(HomepagePatchInput.safeParse({ sections: [{ key: 'hero', position: 0 }] }).success).toBe(
      false,
    );
    expect(HomepagePatchInput.safeParse({ sections: [{ key: 'not-a-section' }] }).success).toBe(
      false,
    );
  });

  it('enables and disables a section without moving it', () => {
    const index = HOMEPAGE.sections.findIndex((section) => section.key === 'gallery');
    const patched = applyHomepagePatch(HOMEPAGE, [{ key: 'gallery', enabled: false }]);
    const validated = validateHomepage(patched);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    expect(validated.homepage.sections[index]?.key).toBe('gallery');
    expect(validated.homepage.sections[index]?.enabled).toBe(false);
    // Every other section is untouched.
    expect(validated.homepage.sections.filter((section) => section.enabled).length).toBe(
      HOMEPAGE.sections.filter((section) => section.enabled).length - 1,
    );
  });

  it('derives awaitingCopy from the body rather than trusting the request', () => {
    const replaced = applyHomepagePatch(HOMEPAGE, [
      { key: 'craftsmanship', body: 'We select and season our own timber before cutting it.' },
    ]);
    const validated = validateHomepage(replaced);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const section = validated.homepage.sections.find((entry) => entry.key === 'craftsmanship');
    expect(section?.awaitingCopy).toBe(false);
    expect(homepagePlaceholderKeys(validated.homepage)).not.toContain(
      'homepage.craftsmanship.body',
    );

    // And a body that still holds a marker is flagged again, so the flag cannot be lied about.
    const reverted = applyHomepagePatch(validated.homepage, [
      { key: 'craftsmanship', body: '[PLACEHOLDER — still to write]' },
    ]);
    const second = validateHomepage(reverted);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(
        second.homepage.sections.find((entry) => entry.key === 'craftsmanship')?.awaitingCopy,
      ).toBe(true);
    }
  });

  it('clears a copy field with null, deleting the key rather than storing an empty string', () => {
    const patched = applyHomepagePatch(HOMEPAGE, [{ key: 'bestSellers', subheading: null }]);
    const validated = validateHomepage(patched);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const section = validated.homepage.sections.find((entry) => entry.key === 'bestSellers');
    expect(section?.subheading).toBeUndefined();
  });

  it('covers all fifteen sections', () => {
    expect(HOMEPAGE_SECTION_KEYS).toHaveLength(15);
    expect(HOMEPAGE.sections.map((section) => section.key)).toEqual([...HOMEPAGE_SECTION_KEYS]);
  });
});

describe('AI provenance on create', () => {
  const taken = { slugs: new Set<string>(), skus: new Set<string>() };

  it('records aiAssisted and the field paths the assistant contributed', () => {
    const parsed = ProductCreateInput.safeParse({
      name: 'Rolled-Arm Three-Seater Sofa',
      category: 'sofas',
      description: 'A three-seater sofa with rolled arms and removable cushions on a low frame.',
      seoTitle: 'Rolled-Arm Three-Seater Sofa',
      aiAssisted: true,
      aiFields: ['description', 'seoTitle'],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const product = buildNewProduct(parsed.data, { taken });
    expect(product.aiAssisted).toBe(true);
    expect(product.aiFields).toEqual(['description', 'seoTitle']);
    // Always a draft, never published — the AI flow's only reachable status.
    expect(product.status).toBe('DRAFT');
    expect(product.published).toBe(false);
  });

  it('drops a provenance claim about a field the record does not carry', () => {
    const parsed = ProductCreateInput.safeParse({
      name: 'A Sofa',
      category: 'sofas',
      aiAssisted: true,
      // `status` is not a storable field, and `material` was never sent.
      aiFields: ['status', 'published', 'material', 'sku', 'id'],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const product = buildNewProduct(parsed.data, { taken });
    // Provenance is only worth having if it is true.
    expect(product.aiFields).toEqual([]);
  });

  it('defaults to no AI provenance for a manual create', () => {
    const parsed = ProductCreateInput.safeParse({ name: 'A Sofa', category: 'sofas' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const product = buildNewProduct(parsed.data, { taken });
    expect(product.aiAssisted).toBe(false);
    expect(product.aiFields).toEqual([]);
  });

  it('still refuses a status on create, however it is spelled', () => {
    for (const attempt of [
      { name: 'A Sofa', category: 'sofas', status: 'PUBLISHED' },
      { name: 'A Sofa', category: 'sofas', published: true },
    ]) {
      expect(ProductCreateInput.safeParse(attempt).success).toBe(false);
    }
  });
});
