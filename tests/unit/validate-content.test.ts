import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { validateContent } from '../../scripts/validate-content';
import { demoSofa } from '../fixtures/products';

/**
 * The content gate, exercised over a real directory tree.
 *
 * The fixture tree is written to a temp directory rather than into `data/`, for the
 * reason stated in `tests/fixtures/products.ts`: a demo product must never land in
 * the live catalogue.
 *
 * Requirements: 1.16, 17.7, 17.8, 18.5, 26.11.
 */

let root: string;

const category = {
  slug: 'sofas',
  name: 'Sofas & Sectionals',
  shortDescription: 'Sofas, sectionals, and L-shape seating for living rooms.',
  order: 1,
  illustration: 'sofa',
  subcategories: [],
  published: true,
};

const settings = {
  businessName: 'New Galaxy Furniture',
  logo: { src: null, wordmarkFallback: 'NEW GALAXY FURNITURE' },
  whatsapp: [{ label: 'Orders & Enquiries 1', e164: '+919513443606' }],
  phone: [{ label: 'Orders & Enquiries 1', e164: '+919513443606' }],
  location: {
    addressLines: [],
    city: '',
    state: '',
    postalCode: null,
    mapUrl: null,
    geo: null,
  },
  serviceArea: ['Karnataka'],
  social: {},
  seoDefaults: { titleSuffix: ' | NGF', description: 'Catalogue.', ogImageKey: null },
  placeholders: [],
};

async function writeJson(relativePath: string, value: unknown): Promise<void> {
  const target = join(root, relativePath);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ngf-content-'));
  await writeJson('categories/sofas.json', category);
  await writeJson('site/settings.json', settings);
  await writeJson('site/homepage.json', {
    sections: [
      { key: 'hero', enabled: true, tagline: 'Furniture made to outlast the trend' },
      { key: 'footer', enabled: true },
    ],
  });
  await writeJson('site/rankings.json', { trending: [], bestSeller: [], mostViewed: [] });
  await writeJson('site/redirects.json', {});
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('validateContent', () => {
  it('passes a well-formed tree', async () => {
    await writeJson(`products/${demoSofa.slug}.json`, demoSofa);
    expect(await validateContent(root)).toEqual([]);
  });

  it('passes the tree with no products at all', async () => {
    expect(await validateContent(root)).toEqual([]);
  });

  it('fails a product whose category does not exist, naming the field', async () => {
    await writeJson(`products/${demoSofa.slug}.json`, { ...demoSofa, category: 'hammocks' });

    const failures = await validateContent(root);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.file).toContain(`${demoSofa.slug}.json`);
    expect(failures[0]?.path).toBe('category');
    expect(failures[0]?.message).toContain('hammocks');
  });

  it('fails malformed JSON, naming the file', async () => {
    await mkdir(join(root, 'products'), { recursive: true });
    await writeFile(join(root, 'products', 'broken.json'), '{ "name": "no closing brace"', 'utf8');

    const failures = await validateContent(root);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.file).toContain('broken.json');
    expect(failures[0]?.path).toBe('<file>');
  });

  it('fails a schema violation against the failing field path', async () => {
    await writeJson(`products/${demoSofa.slug}.json`, {
      ...demoSofa,
      images: demoSofa.images.map((image, index) => ({ ...image, order: index + 3 })),
    });

    const failures = await validateContent(root);
    expect(failures.map((f) => f.path)).toContain('images');
  });

  it('fails a cross-field invariant violation, not just a field type', async () => {
    await writeJson(`products/${demoSofa.slug}.json`, { ...demoSofa, published: false });

    const failures = await validateContent(root);
    expect(failures.map((f) => f.path)).toContain('published');
  });

  it('fails when the filename and the slug disagree', async () => {
    await writeJson('products/some-other-name.json', demoSofa);

    const failures = await validateContent(root);
    expect(failures.map((f) => f.path)).toContain('slug');
  });

  it('fails a file in a location no schema owns', async () => {
    await writeJson('site/unexpected.json', { anything: true });

    const failures = await validateContent(root);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.file).toContain('unexpected.json');
  });

  it('fails an invalid business number in site settings', async () => {
    await writeJson('site/settings.json', {
      ...settings,
      whatsapp: [{ label: 'Orders & Enquiries 1', e164: '9513443606' }],
    });

    const failures = await validateContent(root);
    expect(failures.map((f) => f.path)).toContain('whatsapp.0.e164');
  });

  it('fails a homepage file whose sections are out of the required order', async () => {
    await writeJson('site/homepage.json', {
      sections: [
        { key: 'footer', enabled: true },
        { key: 'hero', enabled: true, tagline: 'Furniture made to outlast the trend' },
      ],
    });

    const failures = await validateContent(root);
    expect(failures.map((f) => f.path)).toContain('sections.1.key');
  });
});
