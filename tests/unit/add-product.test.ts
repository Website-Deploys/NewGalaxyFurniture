import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assertWhatsAppRoundTrip, parseDimensions, run } from '../../scripts/add-product';
import { buildNewProduct, validateProduct } from '@/lib/products/input';
import { serializeContentJson } from '@/lib/github/serialize';
import type { RunSuccess } from '../../scripts/add-product';
import type { SiteSettings } from '@/schemas/site';

/**
 * The `product:add` CLI, exercised over a real directory tree.
 *
 * The fixture tree is a temp directory, never `data/`: a demo product must not land in the
 * live catalogue, which is also the reason the "writes exactly one file" assertion below is
 * a whole-tree comparison rather than a check that one expected file exists. The former
 * catches a stray write; the latter cannot.
 *
 * No test here passes `--images`. That is deliberate and not a gap: the image path compiles
 * ~4.6 MB of WebAssembly and encodes a dozen derivatives per photograph, and it is already
 * covered against the real codec by `images.derivatives.test.ts` and
 * `images.upload.integration.test.ts` — the same two modules the CLI calls. What is specific
 * to this command is the argument surface, the category gate, identity uniqueness against
 * files on disk, the publish gate, the enquiry-link assertion, and the write footprint.
 *
 * Requirements: 27.2, 27.3, 27.6, 27.8, 27.9, 27.11.
 */

let root: string;

/** Pinned so `createdAt`/`updatedAt` are reproducible across a replay. */
const NOW = new Date('2026-03-01T09:30:00.000Z');
const SITE_URL = 'https://example-preview.workers.dev';

const sofas = {
  slug: 'sofas',
  name: 'Sofas & Sectionals',
  shortDescription: 'Sofas, sectionals, and L-shape seating for living rooms.',
  order: 1,
  illustration: 'sofa',
  subcategories: [],
  published: true,
};

const beds = {
  slug: 'beds',
  name: 'Beds & Bedroom',
  shortDescription: 'Beds, headboards and bedroom storage.',
  order: 2,
  illustration: 'bed',
  subcategories: [],
  published: true,
};

const settings = {
  businessName: 'New Galaxy Furniture',
  logo: { src: null, wordmarkFallback: 'NEW GALAXY FURNITURE' },
  whatsapp: [
    { label: 'Orders & Enquiries 1', e164: '+919513443606' },
    { label: 'Orders & Enquiries 2', e164: '+917676453606' },
  ],
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

/** Every file in the tree, as `/`-joined relative paths, sorted. */
async function tree(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();
}

/** The flags every run needs, so each test states only what it is about. */
function baseArgs(overrides: readonly string[] = []): string[] {
  return ['--name', 'Luxury L-Shape Sofa', '--category', 'sofas', '--data', root, ...overrides];
}

async function expectSuccess(argv: readonly string[]): Promise<RunSuccess> {
  const result = await run(argv, { now: NOW, siteUrl: SITE_URL });
  if (result === 'help' || !result.ok) {
    throw new Error(
      `Expected a successful run, got: ${result === 'help' ? 'help' : JSON.stringify(result)}`,
    );
  }
  return result;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ngf-add-product-'));
  await writeJson('categories/sofas.json', sofas);
  await writeJson('categories/beds.json', beds);
  await writeJson('site/settings.json', settings);
  await mkdir(join(root, 'products'), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('the category gate', () => {
  it('rejects an unknown category, lists the valid slugs, and creates nothing', async () => {
    const before = await tree(root);

    const result = await run(baseArgs(['--category', 'couches']), { now: NOW, siteUrl: SITE_URL });

    expect(result).not.toBe('help');
    if (result === 'help' || result.ok) throw new Error('Expected an unknown category to fail.');

    // The failing field is named, and the message carries every valid slug so the operator
    // does not have to go looking (Requirement 27.2).
    expect(Object.keys(result.fields)).toEqual(['category']);
    const message = result.fields.category?.join(' ') ?? '';
    expect(message).toContain('"couches"');
    expect(message).toContain('beds');
    expect(message).toContain('sofas');
    expect(message).toMatch(/never creates a category/i);

    // No category was invented and no product was written.
    expect(await tree(root)).toEqual(before);
  });

  it('accepts a category whose file exists', async () => {
    const result = await expectSuccess(baseArgs(['--category', 'beds', '--name', 'Teak Bed']));
    expect(result.product.category).toBe('beds');
  });
});

describe('the write footprint', () => {
  it('writes exactly one file under products/ and touches nothing else', async () => {
    const before = await tree(root);

    const result = await expectSuccess(baseArgs());

    const after = await tree(root);
    const added = after.filter((path) => !before.includes(path));

    // Exactly one new file, under products/, named for the slug (Requirement 27.9).
    expect(added).toEqual(['products/luxury-l-shape-sofa.json']);
    // And nothing that existed was removed.
    expect(before.every((path) => after.includes(path))).toBe(true);

    expect(result.written).toBe(true);
    expect(result.path).toBe('data/products/luxury-l-shape-sofa.json');
    expect(await readFile(result.absolutePath, 'utf8')).toBe(result.contents);

    // The diff the operator reviews is the file that was written.
    expect(result.diff).toContain('new file mode 100644');
    expect(result.diff).toContain('+++ b/data/products/luxury-l-shape-sofa.json');
  });

  it('writes nothing under --dry-run but still reports the diff', async () => {
    const before = await tree(root);

    const result = await expectSuccess(baseArgs(['--dry-run']));

    expect(result.written).toBe(false);
    expect(result.diff).toContain('+  "slug": "luxury-l-shape-sofa",');
    expect(await tree(root)).toEqual(before);
  });
});

describe('identity uniqueness against the files on disk', () => {
  it('gives a second product of the same name a distinct slug and SKU', async () => {
    const first = await expectSuccess(baseArgs());
    const second = await expectSuccess(baseArgs());

    expect(first.product.slug).toBe('luxury-l-shape-sofa');
    expect(second.product.slug).toBe('luxury-l-shape-sofa-2');
    expect(second.product.sku).not.toBe(first.product.sku);
    expect(second.product.id).not.toBe(first.product.id);

    // Both files survive; the second run overwrote nothing.
    expect(await tree(root)).toContain('products/luxury-l-shape-sofa.json');
    expect(await tree(root)).toContain('products/luxury-l-shape-sofa-2.json');
  });

  it('reads identifiers from a pre-existing file it did not write', async () => {
    // A hand-authored file, as a repository would actually contain.
    await writeJson('products/luxury-l-shape-sofa.json', {
      slug: 'luxury-l-shape-sofa',
      sku: 'NGF-SOF-000001',
    });

    const result = await expectSuccess(baseArgs());

    expect(result.product.slug).toBe('luxury-l-shape-sofa-2');
    expect(result.product.sku).not.toBe('NGF-SOF-000001');
    // The pre-existing file is untouched.
    expect(
      JSON.parse(await readFile(join(root, 'products/luxury-l-shape-sofa.json'), 'utf8')),
    ).toEqual({ slug: 'luxury-l-shape-sofa', sku: 'NGF-SOF-000001' });
  });
});

describe('the publish gate', () => {
  it('refuses --status PUBLISHED on an incomplete product, naming images, and writes nothing', async () => {
    const before = await tree(root);

    const result = await run(baseArgs(['--status', 'PUBLISHED', '--price', '42000']), {
      now: NOW,
      siteUrl: SITE_URL,
    });

    expect(result).not.toBe('help');
    if (result === 'help' || result.ok) throw new Error('Expected the publish gate to refuse.');

    // The gate names every unmet field; `images` is the one this run cannot satisfy at all
    // (Requirement 27.6).
    expect(Object.keys(result.fields)).toContain('images');
    expect(result.message).toMatch(/publish gate/i);
    expect(result.message).toMatch(/Nothing was written/i);

    expect(await tree(root)).toEqual(before);
  });

  it('does not apply the publish gate to a draft', async () => {
    const result = await expectSuccess(baseArgs(['--status', 'DRAFT']));
    expect(result.product.status).toBe('DRAFT');
    expect(result.product.published).toBe(false);
    expect(result.product.images).toEqual([]);
  });
});

describe('the enquiry link assertion', () => {
  it('builds one round-tripping wa.me URL per configured number', async () => {
    const result = await expectSuccess(baseArgs(['--price', '42000']));

    expect(result.whatsappUrls).toHaveLength(settings.whatsapp.length);

    for (const [index, url] of result.whatsappUrls.entries()) {
      const parsed = new URL(url);
      expect(parsed.host).toBe('wa.me');
      // The digits of the configured number, with no punctuation and no leading '+'.
      expect(parsed.pathname).toBe(`/${(settings.whatsapp[index]?.e164 ?? '').replace(/\D/g, '')}`);

      // A single decode must return the intended message: the product's identity, and the
      // canonical URL it will live at (Requirement 27.8).
      const text = decodeURIComponent(url.slice(url.indexOf('?text=') + '?text='.length));
      expect(text).toBe(parsed.searchParams.get('text'));
      expect(text).toContain(result.product.name);
      expect(text).toContain(result.product.sku);
      expect(text).toContain(`${SITE_URL}/product/${result.product.slug}`);
    }
  });

  it('fails when the settings file carries no number to enquire on', async () => {
    const product = (await expectSuccess(baseArgs())).product;
    const numberless = { ...settings, whatsapp: [] } as unknown as SiteSettings;

    const result = assertWhatsAppRoundTrip(product, numberless, SITE_URL);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected the assertion to fail with no numbers.');
    expect(Object.keys(result.fields)).toEqual(['whatsapp']);
  });

  it('round-trips a name carrying the characters a naive encoder mangles', async () => {
    // `&` would end the parameter, `+` would decode to a space under form rules, `%` and `#`
    // break a single-pass decode, and a newline is what the message itself uses as a
    // separator. If any of these survive the assertion, the encoding is genuinely correct
    // rather than accidentally correct for plain ASCII.
    const product = (await expectSuccess(baseArgs())).product;
    const hostile = 'Sofa & Chair 100% Cotton + #2';

    const result = assertWhatsAppRoundTrip(
      { ...product, name: hostile },
      settings as unknown as SiteSettings,
      SITE_URL,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('The production builder must round-trip.');

    const url = result.urls[0] ?? '';
    const raw = url.slice(url.indexOf('?text=') + '?text='.length);
    // Every one of those characters is percent-escaped on the wire.
    expect(raw).not.toContain('&');
    expect(raw).not.toContain('#');
    // And a single decode returns the message, which is what the assertion guarantees.
    expect(decodeURIComponent(raw)).toContain(hostile);
    expect(new URL(url).searchParams.get('text')).toContain(hostile);
  });
});

describe('the record itself', () => {
  it('generates SEO fallbacks and stores them where none were supplied', async () => {
    const result = await expectSuccess(baseArgs(['--price', '42000']));

    expect(result.product.seoTitle).toContain('Luxury L-Shape Sofa');
    expect((result.product.seoTitle ?? '').length).toBeLessThanOrEqual(70);
    expect((result.product.seoDescription ?? '').length).toBeGreaterThan(0);
    expect((result.product.seoDescription ?? '').length).toBeLessThanOrEqual(170);
  });

  it('keeps an operator-supplied SEO value verbatim', async () => {
    const result = await expectSuccess(
      baseArgs(['--seo-title', 'Handmade L-Shape Sofa in Bengaluru']),
    );
    expect(result.product.seoTitle).toBe('Handmade L-Shape Sofa in Bengaluru');
  });

  it('maps the command-line field flags onto the record', async () => {
    const result = await expectSuccess(
      baseArgs([
        '--price',
        '42000',
        '--material',
        'Fabric upholstery, seasoned hardwood frame',
        '--dimensions',
        '213x91x76',
        '--colors',
        'Beige,Grey,Brown',
        '--stock-status',
        'MADE_TO_ORDER',
        '--featured',
      ]),
    );

    expect(result.product.price).toBe(42000);
    expect(result.product.priceOnEnquiry).toBe(false);
    expect(result.product.material).toBe('Fabric upholstery, seasoned hardwood frame');
    expect(result.product.dimensions).toMatchObject({
      lengthCm: 213,
      widthCm: 91,
      heightCm: 76,
    });
    expect(result.product.availableColors).toEqual(['Beige', 'Grey', 'Brown']);
    expect(result.product.stockStatus).toBe('MADE_TO_ORDER');
    expect(result.product.featured).toBe(true);
  });

  it('rejects a malformed --dimensions value without writing', async () => {
    const before = await tree(root);
    const result = await run(baseArgs(['--dimensions', '213 by 91']), {
      now: NOW,
      siteUrl: SITE_URL,
    });

    if (result === 'help' || result.ok) throw new Error('Expected malformed dimensions to fail.');
    expect(Object.keys(result.fields)).toEqual(['dimensions']);
    expect(await tree(root)).toEqual(before);
  });

  it('parses dimensions in centimetres and never invents a display string', () => {
    expect(parseDimensions('213x91x76')).toEqual({ lengthCm: 213, widthCm: 91, heightCm: 76 });
    expect(parseDimensions('213×91×76×40')).toEqual({
      lengthCm: 213,
      widthCm: 91,
      heightCm: 76,
      depthCm: 40,
    });
    expect(parseDimensions('213x91')).toBeNull();
    expect(parseDimensions('213x91x-76')).toBeNull();
    expect(parseDimensions('big x small x tall')).toBeNull();
  });
});

describe('byte compatibility with the admin creator', () => {
  /**
   * Requirement 27.11: all three creation routes produce byte-compatible files.
   *
   * The CLI does not re-implement assembly — it calls `buildNewProduct` and
   * `serializeContentJson`, the same two functions `POST /api/admin/products` calls. This
   * test replays that admin sequence over the input the CLI recorded and compares bytes.
   *
   * `id` and `sku` are randomly generated by design (`generateProductId`, `generateSku`), so
   * two runs of the same input legitimately differ in exactly those two fields. They are
   * substituted before comparison; every other byte must match, including key order,
   * indentation and the trailing newline.
   */
  it('produces the bytes the admin creation path would produce for the same input', async () => {
    const result = await expectSuccess(
      baseArgs([
        '--price',
        '42000',
        '--description',
        'A generously proportioned L-shape sofa in a hardwood frame with fabric upholstery.',
        '--colors',
        'Beige,Grey',
      ]),
    );

    // The admin path: validated input → buildNewProduct → validateProduct → serialize.
    const candidate = buildNewProduct(result.input, { taken: result.taken, now: result.now });
    const validated = validateProduct(candidate);
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error('The admin path must validate.');

    const adminBytes = serializeContentJson({
      ...validated.product,
      id: result.product.id,
      sku: result.product.sku,
    });

    expect(adminBytes).toBe(result.contents);

    // The substitution above must not be hiding anything: the slug is derived, not random,
    // so it has to agree without help.
    expect(validated.product.slug).toBe(result.product.slug);
  });
});
