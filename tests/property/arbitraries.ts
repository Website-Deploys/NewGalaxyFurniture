import fc from 'fast-check';

import type { SearchDoc } from '@/lib/search/types';
import type { Product, ProductImageValue } from '@/schemas/product';

/**
 * Shared fast-check generators.
 *
 * These are deliberately *smart* generators: they constrain to the real input
 * space rather than throwing raw strings at every parameter, so a failure points
 * at a defect instead of at an input the system never receives. Where a property
 * needs hostile input (the slug and message properties do), the adversarial
 * generators below are used explicitly.
 *
 * `validProductArb` is typed against the canonical `Product` inferred from
 * `src/schemas/product.ts` (task 2.1), which is what makes it useful: the compiler
 * now rejects a generator that drifts from the schema, and the round-trip property
 * compares like with like. The temporary `ProductLike` structural type this module
 * carried until the schema existed has been deleted as its header instructed.
 *
 * Design: Data Models → Canonical product schema; Catalogue → SearchDoc.
 * Requirements: 27.12.
 */

/* -------------------------------------------------------------------------- */
/* Primitives                                                                 */
/* -------------------------------------------------------------------------- */

const LOWER_ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';
const UPPER_ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function fixedLengthFrom(charset: string, length: number): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(...charset.split('')), { minLength: length, maxLength: length })
    .map((chars) => chars.join(''));
}

/** The nine seeded category slugs (data/categories/*.json). */
export const CATEGORY_SLUGS = [
  'sofas',
  'beds',
  'dining-tables',
  'dining-chairs',
  'accent-chairs',
  'coffee-side-tables',
  'storage-display',
  'office',
  'outdoor',
] as const;

export const categorySlugArb: fc.Arbitrary<string> = fc.constantFrom(...CATEGORY_SLUGS);

/**
 * A well-formed slug: `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, at most 80 characters.
 * Built from segments so hyphens are always interior and never doubled.
 */
export const slugArb: fc.Arbitrary<string> = fc
  .array(
    fc
      .array(fc.constantFrom(...LOWER_ALNUM.split('')), { minLength: 1, maxLength: 12 })
      .map((chars) => chars.join('')),
    { minLength: 1, maxLength: 6 },
  )
  .map((segments) => segments.join('-'))
  .filter((slug) => slug.length <= 80);

/**
 * Names as an operator would actually type them, plus the cases that break naive
 * slug code: diacritics, Devanagari, emoji, punctuation runs, leading/trailing
 * separators, very long input, and whitespace-only input.
 */
export const productNameArb: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.constantFrom(
      'Luxury L-Shape Sofa',
      'Solid Sheesham Wood Queen Bed',
      '6-Seater Dining Table',
      'Brown Accent Chair',
      'Coffee & Side Table Set',
    ),
  },
  { weight: 3, arbitrary: fc.string({ minLength: 1, maxLength: 140 }) },
  { weight: 2, arbitrary: fc.string({ unit: 'grapheme', minLength: 1, maxLength: 140 }) },
  {
    weight: 1,
    arbitrary: fc.constantFrom(
      '   ',
      '---',
      '!!!',
      'Café Chaise Longue',
      'सोफा सेट',
      'Sofa 🛋️ Set',
      '--leading and trailing--',
      'A'.repeat(200),
      'ｆｕｌｌｗｉｄｔｈ',
    ),
  },
);

/** `/^[A-Z0-9][A-Z0-9-]{2,31}$/` — total length 3..32. */
export const skuArb: fc.Arbitrary<string> = fc
  .tuple(
    fixedLengthFrom(UPPER_ALNUM, 1),
    fc
      .array(fc.constantFrom(...`${UPPER_ALNUM}-`.split('')), { minLength: 2, maxLength: 31 })
      .map((chars) => chars.join('')),
  )
  .map(([head, tail]) => `${head}${tail}`);

/** The SKU shape this codebase mints: `NGF-{PREFIX}-{6 base36 chars}`. */
export const ngfSkuArb: fc.Arbitrary<string> = fc
  .tuple(fixedLengthFrom(UPPER_ALNUM, 3), fixedLengthFrom(UPPER_ALNUM, 6))
  .map(([prefix, body]) => `NGF-${prefix}-${body}`);

/** Any valid E.164 number: `+` then 1..15 digits, never leading zero. */
export const e164Arb: fc.Arbitrary<string> = fc
  .tuple(fc.integer({ min: 1, max: 9 }), fixedLengthFrom('0123456789', 12))
  .chain(([lead, rest]) =>
    fc.integer({ min: 0, max: 12 }).map((keep) => `+${lead}${rest.slice(0, keep)}`),
  );

/** An Indian mobile in E.164: `+91` then a 10-digit number starting 6–9. */
export const indianE164Arb: fc.Arbitrary<string> = fc
  .tuple(fc.integer({ min: 6, max: 9 }), fixedLengthFrom('0123456789', 9))
  .map(([lead, rest]) => `+91${lead}${rest}`);

/**
 * The same Indian number written the way visitors type it: bare 10-digit, with a
 * leading 0, with the country code and no `+`, and with spaces, hyphens or
 * parentheses anywhere inside.
 */
export const messyIndianPhoneArb: fc.Arbitrary<string> = indianE164Arb.chain((e164) => {
  const digits = e164.slice(3);
  return fc
    .tuple(
      fc.constantFrom(`${digits}`, `0${digits}`, `91${digits}`, `+91${digits}`, `+91 ${digits}`),
      fc.array(fc.constantFrom(' ', '-', '(', ')'), { minLength: 0, maxLength: 3 }),
    )
    .map(([base, noise]) => {
      let out = base;
      for (const ch of noise) {
        const at = 1 + ((out.length - 1) >>> 1);
        out = `${out.slice(0, at)}${ch}${out.slice(at)}`;
      }
      return out;
    });
});

/** Free text that has broken URL builders before: quotes, newlines, `&`, `#`, RTL marks, emoji. */
export const adversarialTextArb: fc.Arbitrary<string> = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 400 }),
  fc.constantFrom(
    'Sofa & "Chair" <set>',
    'line one\nline two\r\nline three',
    '100% off?utm_source=x&y=z#frag',
    'price ₹1,00,000 / ~15% off',
    '\u202Ereversed\u202C',
    '🛋️🪑🛏️',
    'a'.repeat(2000),
    '',
  ),
);

const isoDatetimeArb: fc.Arbitrary<string> = fc
  .date({
    min: new Date('2020-01-01T00:00:00.000Z'),
    max: new Date('2035-12-31T23:59:59.000Z'),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString());

/* -------------------------------------------------------------------------- */
/* SearchDoc                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `SearchDoc` is now a real exported type (`src/lib/search/types.ts`, task 14.3), so the
 * structural `SearchDocLike` this module carried as a stand-in has been deleted for the same
 * reason `ProductLike` was: generating against the real type means the compiler rejects a
 * generator that drifts from it.
 */

const MATERIALS = [
  'Sheesham Wood',
  'Teak',
  'Mango Wood',
  'Fabric',
  'Leatherette',
  'Metal',
] as const;
const COLOURS = ['Brown', 'Walnut', 'Beige', 'Grey', 'Black', 'Ivory', 'Natural'] as const;
const TAGS = ['l-shape', '3-seater', 'queen', 'king', 'compact', 'premium', 'handcrafted'] as const;
const SIZES = ['2 Seater', '3 Seater', 'Queen', 'King', 'Small', 'Large'] as const;
export const STOCK_STATUSES = [
  'IN_STOCK',
  'LIMITED_STOCK',
  'OUT_OF_STOCK',
  'MADE_TO_ORDER',
] as const;
export const PRODUCT_STATUSES = [
  'DRAFT',
  'REVIEW',
  'PUBLISHED',
  'UNPUBLISHED',
  'OUT_OF_STOCK',
] as const;

export const searchDocArb: fc.Arbitrary<SearchDoc> = fc.record<SearchDoc>({
  i: slugArb,
  n: fc.string({ minLength: 2, maxLength: 120 }),
  k: ngfSkuArb,
  c: categorySlugArb,
  s: fc.option(fc.constantFrom('sectional', 'recliner', 'bunk', 'study'), { nil: undefined }),
  m: fc.option(fc.constantFrom(...MATERIALS), { nil: undefined }),
  o: fc.uniqueArray(fc.constantFrom(...COLOURS), { maxLength: 5 }),
  t: fc.uniqueArray(fc.constantFrom(...TAGS), { maxLength: 6 }),
  p: fc.option(fc.integer({ min: 500, max: 5_000_000 }), { nil: null }),
  st: fc.constantFrom(...STOCK_STATUSES),
  // Bitmask: featured|trending|bestSeller|newArrival|madeToOrder.
  f: fc.integer({ min: 0, max: 31 }),
  ts: fc.integer({ min: 1_577_836_800, max: 2_082_758_400 }),
  th: fixedLengthFrom(LOWER_ALNUM, 10).map((s) => `/img/p_${s}/img_${s}-320.webp`),
  lq: fc.constant('data:image/webp;base64,UklGRg=='),
  sz: fc.option(fc.constantFrom(...SIZES), { nil: undefined }),
});

/**
 * Documents with **distinct slugs**, which several properties need rather than want:
 *
 * - Property 34 (total order) states "no two *distinct* products compare equal", and the
 *   universal tie-break is the slug — so two documents sharing a slug legitimately compare equal
 *   and are not counterexamples.
 * - Property 39 (exact SKU ranks first) is only well-posed when SKUs are unique.
 *
 * Slugs and SKUs are therefore re-stamped from the array index, which keeps every other generated
 * attribute intact.
 */
export const distinctSearchDocsArb = (
  options: { minLength?: number; maxLength?: number } = {},
): fc.Arbitrary<SearchDoc[]> =>
  fc
    .array(searchDocArb, { minLength: options.minLength ?? 0, maxLength: options.maxLength ?? 12 })
    .map((docs) =>
      docs.map((doc, index) => ({
        ...doc,
        i: `${doc.i}-${index}`,
        k: `${doc.k}-${index}`,
      })),
    );

/* -------------------------------------------------------------------------- */
/* Product                                                                    */
/* -------------------------------------------------------------------------- */

export const productIdArb: fc.Arbitrary<string> = fixedLengthFrom(LOWER_ALNUM, 10).map(
  (s) => `p_${s}`,
);
export const imageIdArb: fc.Arbitrary<string> = fixedLengthFrom(LOWER_ALNUM, 10).map(
  (s) => `img_${s}`,
);

/** Images with `order` contiguous from 0, as the schema requires. */
export const imagesArb: fc.Arbitrary<ProductImageValue[]> = fc
  .uniqueArray(imageIdArb, { minLength: 0, maxLength: 6 })
  .chain((ids) =>
    fc
      .array(fc.tuple(fc.integer({ min: 400, max: 4000 }), fc.integer({ min: 400, max: 4000 })), {
        minLength: ids.length,
        maxLength: ids.length,
      })
      .map((dims) =>
        ids.map((id, index) => {
          const dim = dims[index] ?? [1600, 1200];
          return {
            id,
            key: `originals/${id}.jpg`,
            alt: `Product photograph ${index + 1}`,
            width: dim[0],
            height: dim[1],
            order: index,
            altSource: 'admin' as const,
          };
        }),
      ),
  );

/**
 * Pricing that satisfies the schema's price invariants by construction:
 * price XOR priceOnEnquiry, `originalPrice > price`, and `discount` equal to the
 * computed percentage (which therefore never exceeds the schema's 95 ceiling).
 */
interface PricingLike {
  price: number | null;
  priceOnEnquiry: boolean;
  originalPrice: number | null;
  discount: number | null;
}

const pricingArb: fc.Arbitrary<PricingLike> = fc.oneof(
  // Priced, no strike-through.
  fc.integer({ min: 500, max: 5_000_000 }).map((price): PricingLike => ({
    price,
    priceOnEnquiry: false,
    originalPrice: null,
    discount: null,
  })),
  // Priced with a genuine discount.
  fc.integer({ min: 1000, max: 5_000_000 }).chain((originalPrice) =>
    fc
      .integer({ min: Math.ceil(originalPrice * 0.06), max: originalPrice - 1 })
      .map((price): PricingLike => ({
        price,
        priceOnEnquiry: false,
        originalPrice,
        discount: Math.round(((originalPrice - price) / originalPrice) * 100),
      })),
  ),
  // Price on enquiry.
  fc.constant<PricingLike>({
    price: null,
    priceOnEnquiry: true,
    originalPrice: null,
    discount: null,
  }),
);

/**
 * Inventory and lifecycle that satisfy the coupled invariants:
 * `status OUT_OF_STOCK ⟺ stockStatus OUT_OF_STOCK`,
 * `madeToOrder ⟹ stockStatus MADE_TO_ORDER`, and
 * `published ⟺ status ∈ {PUBLISHED, OUT_OF_STOCK}`.
 */
const lifecycleArb = fc
  .oneof(
    fc.constant({ status: 'OUT_OF_STOCK' as const, stockStatus: 'OUT_OF_STOCK' as const }),
    fc
      .tuple(
        fc.constantFrom(
          'DRAFT' as const,
          'REVIEW' as const,
          'PUBLISHED' as const,
          'UNPUBLISHED' as const,
        ),
        fc.constantFrom('IN_STOCK' as const, 'LIMITED_STOCK' as const, 'MADE_TO_ORDER' as const),
      )
      .map(([status, stockStatus]) => ({ status, stockStatus })),
  )
  .map(({ status, stockStatus }) => ({
    status,
    stockStatus,
    madeToOrder: stockStatus === 'MADE_TO_ORDER',
    published: status === 'PUBLISHED' || status === 'OUT_OF_STOCK',
  }));

/** A product that the canonical schema accepts, including every cross-field invariant. */
export const validProductArb: fc.Arbitrary<Product> = fc
  .tuple(
    productIdArb,
    ngfSkuArb,
    slugArb,
    fc.string({ minLength: 2, maxLength: 120 }).filter((n) => n.trim().length >= 2),
    categorySlugArb,
    fc.string({ minLength: 20, maxLength: 600 }),
    pricingArb,
    lifecycleArb,
    imagesArb,
    fc.tuple(isoDatetimeArb, isoDatetimeArb),
    fc.tuple(fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean()),
    fc.uniqueArray(fc.constantFrom(...TAGS), { maxLength: 6 }),
    fc.uniqueArray(fc.constantFrom(...COLOURS), { maxLength: 5 }),
    fc.option(fc.constantFrom(...MATERIALS), { nil: undefined }),
  )
  .map(
    ([
      id,
      sku,
      slug,
      name,
      category,
      description,
      pricing,
      lifecycle,
      images,
      [createdAt, updatedAt],
      [featured, trending, bestSeller, newArrival],
      tags,
      availableColors,
      material,
    ]): Product => {
      const first = images[0];
      return {
        id,
        sku,
        slug,
        name,
        category,
        tags,
        description,
        currency: 'INR',
        ...pricing,
        ...lifecycle,
        ...(material === undefined ? {} : { material }),
        ...(availableColors[0] === undefined ? {} : { color: availableColors[0] }),
        availableColors,
        variants: [],
        images,
        // Defaults to the lowest-order image, and must reference an owned image.
        ...(first === undefined ? {} : { primaryImage: first.id }),
        featured,
        trending,
        bestSeller,
        newArrival,
        relatedProductIds: [],
        keywords: [],
        createdAt,
        updatedAt,
        aiAssisted: false,
        aiFields: [],
      };
    },
  );

/* -------------------------------------------------------------------------- */
/* Schema-adjacent generators                                                 */
/* -------------------------------------------------------------------------- */

/** Every key the product schema declares — the complement is an "unknown field". */
export const PRODUCT_KEYS: readonly string[] = [
  'id',
  'sku',
  'slug',
  'name',
  'category',
  'subcategory',
  'tags',
  'description',
  'shortDescription',
  'currency',
  'price',
  'priceOnEnquiry',
  'originalPrice',
  'discount',
  'stockStatus',
  'madeToOrder',
  'material',
  'color',
  'availableColors',
  'dimensions',
  'size',
  'variants',
  'customization',
  'deliveryInformation',
  'images',
  'primaryImage',
  'imageAltText',
  'featured',
  'trending',
  'bestSeller',
  'newArrival',
  'relatedProductIds',
  'status',
  'published',
  'seoTitle',
  'seoDescription',
  'keywords',
  'createdAt',
  'updatedAt',
  'aiAssisted',
  'aiFields',
];

/**
 * A key the schema does not declare, for the unknown-field-tolerance property.
 *
 * `__proto__` is excluded, and the exclusion is a fact about JavaScript rather
 * than a weakening of the property: `obj['__proto__'] = v` mutates the prototype
 * instead of defining an own property, so a `__proto__` key cannot survive *any*
 * object copy in any library — including the write pipeline's read-merge-write.
 * It is therefore not a representable content field, and no product file can
 * carry one.
 */
export const unknownKeyArb: fc.Arbitrary<string> = fc
  .oneof(
    { weight: 3, arbitrary: fc.string({ minLength: 1, maxLength: 24 }) },
    {
      weight: 1,
      arbitrary: fc.constantFrom('legacyId', 'importedFrom', 'v2:pricing', 'notes ', 'ॐ', '0', ''),
    },
  )
  .filter((key) => !PRODUCT_KEYS.includes(key) && key !== '__proto__');

/** Prices as the catalogue holds them, plus the lakh/crore boundaries. */
export const inrAmountArb: fc.Arbitrary<number> = fc.oneof(
  { weight: 5, arbitrary: fc.integer({ min: 0, max: 100_000_000 }) },
  {
    weight: 1,
    arbitrary: fc.constantFrom(
      0,
      1,
      9,
      10,
      99,
      100,
      999,
      1000,
      9999,
      24_999,
      25_000,
      50_000,
      99_999,
      100_000,
      999_999,
      1_000_000,
      9_999_999,
      10_000_000,
      100_000_000,
    ),
  },
);

/* -------------------------------------------------------------------------- */
/* Enquiry context                                                            */
/* -------------------------------------------------------------------------- */

/** Mirrors `EnquiryContext` in the design (Conversion → Message and URL construction). */
export interface EnquiryContextLike {
  kind: 'product' | 'general' | 'custom' | 'category';
  productName?: string;
  sku?: string;
  productUrl?: string;
  categoryName?: string;
}

const CATEGORY_NAMES = [
  'Sofas & Sectionals',
  'Beds',
  'Dining Tables',
  'Coffee & Side Tables',
] as const;

/**
 * Product-kind contexts with hostile names: the name and SKU must survive into the
 * message and back out of the URL unchanged.
 */
export const productEnquiryContextArb: fc.Arbitrary<EnquiryContextLike> = fc
  .tuple(
    fc.oneof(productNameArb, adversarialTextArb).filter((n) => n.length > 0),
    ngfSkuArb,
    fc.option(
      slugArb.map((s) => `https://example.test/product/${s}`),
      { nil: undefined },
    ),
  )
  .map(([productName, sku, productUrl]) => ({
    kind: 'product' as const,
    productName,
    sku,
    ...(productUrl === undefined ? {} : { productUrl }),
  }));

/** Every kind of enquiry context, including the ones that must carry no product. */
export const enquiryContextArb: fc.Arbitrary<EnquiryContextLike> = fc.oneof(
  { weight: 3, arbitrary: productEnquiryContextArb },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom(...CATEGORY_NAMES)
      .map((categoryName) => ({ kind: 'category' as const, categoryName })),
  },
  { weight: 1, arbitrary: fc.constant({ kind: 'general' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'custom' as const }) },
);

/* -------------------------------------------------------------------------- */
/* Filter and sort state                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A `FilterState` in the shape `serializeFilters` produces and `parseFilters` accepts.
 *
 * Three constraints are deliberate, and each one reflects a real property of the parser rather
 * than a convenience for the test:
 *
 * - **Values are unique per dimension, comparing case- and diacritic-folded.** `parseFilters`
 *   de-duplicates on the folded key, so a state carrying both `Brown` and `brown` is not a state
 *   the parser can ever produce and is therefore not a valid input to the round-trip claim.
 * - **`q` is trimmed and non-empty or absent.** Requirement 2.2 specifies the query is trimmed,
 *   so `'  sofa  '` and `'sofa'` are the same query by design.
 * - **Values are non-empty after trimming**, because a valueless parameter is one of the things
 *   Requirement 3.19 says to ignore.
 *
 * The generated values deliberately include `&`, `=`, `,`, `+`, `%`, and non-Latin characters:
 * those are what break a comma-joined serializer, which is exactly why the URL layer repeats
 * parameters instead.
 */
const facetValueArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(...COLOURS, ...MATERIALS, ...TAGS, ...SIZES) },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      'Fabric, hardwood frame',
      'Brown & Beige',
      'a=b',
      '50%+ cotton',
      'Sheesham/Teak',
      'सागवान',
      'Café Noir',
    ),
  },
  {
    weight: 1,
    arbitrary: fc
      .string({ unit: 'grapheme', minLength: 1, maxLength: 20 })
      .map((value) => value.trim())
      .filter((value) => value !== ''),
  },
);

/** Folded uniqueness, matching `facetKey` in `src/lib/search/filter.ts`. */
function foldFacet(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const facetValuesArb: fc.Arbitrary<string[]> = fc
  .uniqueArray(facetValueArb, { maxLength: 4, selector: foldFacet })
  .filter((values) => values.every((value) => foldFacet(value) !== ''));

export const PRICE_BAND_FILTERS = ['any', 'under25k', '25k-50k', '50k-1L', '1L+'] as const;
export const AVAILABILITY_FILTERS = ['any', 'inStock', 'madeToOrder'] as const;
export const SORT_KEY_VALUES = [
  'newest',
  'priceAsc',
  'priceDesc',
  'mostViewed',
  'bestSelling',
  'trending',
] as const;

export interface FilterStateLike {
  category: string[];
  priceBand: (typeof PRICE_BAND_FILTERS)[number];
  availability: (typeof AVAILABILITY_FILTERS)[number];
  material: string[];
  colour: string[];
  size: string[];
  style: string[];
  sort: (typeof SORT_KEY_VALUES)[number];
  q: string;
}

export const filterStateArb: fc.Arbitrary<FilterStateLike> = fc.record<FilterStateLike>({
  category: facetValuesArb,
  priceBand: fc.constantFrom(...PRICE_BAND_FILTERS),
  availability: fc.constantFrom(...AVAILABILITY_FILTERS),
  material: facetValuesArb,
  colour: facetValuesArb,
  size: facetValuesArb,
  style: facetValuesArb,
  sort: fc.constantFrom(...SORT_KEY_VALUES),
  q: fc.oneof(
    fc.constant(''),
    fc
      .string({ unit: 'grapheme', minLength: 1, maxLength: 40 })
      .map((value) => value.trim())
      .filter((value) => value !== ''),
    fc.constantFrom('sofa', 'NGF-SOF-4F2K9C', 'brown & beige', 'a=b&c=d', '₹25,000'),
  ),
});

/**
 * A filter state whose facet values are drawn from the documents on hand, so the state actually
 * selects something. A state of random strings would make almost every property trivially true by
 * returning the empty set.
 */
export const filterStateForArb = (docs: readonly SearchDoc[]): fc.Arbitrary<FilterStateLike> => {
  const pick = (values: string[]): fc.Arbitrary<string[]> =>
    values.length === 0
      ? fc.constant<string[]>([])
      : fc.uniqueArray(fc.constantFrom(...values), { maxLength: 3, selector: foldFacet });

  const categories = [...new Set(docs.map((doc) => doc.c))];
  const materials = [...new Set(docs.flatMap((doc) => (doc.m === undefined ? [] : [doc.m])))];
  const colours = [...new Set(docs.flatMap((doc) => doc.o))];
  const sizes = [...new Set(docs.flatMap((doc) => (doc.sz === undefined ? [] : [doc.sz])))];
  const styles = [...new Set(docs.flatMap((doc) => doc.t))];

  return fc.record<FilterStateLike>({
    category: pick(categories),
    priceBand: fc.constantFrom(...PRICE_BAND_FILTERS),
    availability: fc.constantFrom(...AVAILABILITY_FILTERS),
    material: pick(materials),
    colour: pick(colours),
    size: pick(sizes),
    style: pick(styles),
    sort: fc.constantFrom(...SORT_KEY_VALUES),
    q: fc.constant(''),
  });
};
