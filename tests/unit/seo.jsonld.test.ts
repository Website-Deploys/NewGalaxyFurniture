import { describe, expect, it } from 'vitest';

import { aggregateRatingFor, filterPublishedReviews } from '@/lib/content/reviews';
import {
  availabilityFor,
  breadcrumbJsonLd,
  itemListJsonLd,
  localBusinessJsonLd,
  productJsonLd,
  webSiteJsonLd,
} from '@/lib/seo/jsonld';
import { categoryCrumbs, productCrumbs } from '@/lib/site/breadcrumbs';
import type { Product, StockStatusValue } from '@/schemas/product';
import type { Review } from '@/schemas/review';
import type { SiteSettings } from '@/schemas/site';

import { demoSofa } from '../fixtures/products';

/**
 * The structured-data generators.
 *
 * The assertions worth reading are the negative ones. A generator that emits a `Product` with a name
 * and a SKU is easy; what this file pins down is what the generators *refuse* to emit — no price for
 * a price-on-enquiry product, no rating without product-linked reviews, no address the operator has
 * not supplied, no `openingHours` at all. Every one of those absences is a claim the site would
 * otherwise be making to a search engine on no evidence.
 *
 * Requirements: 18.10, 19.6, 23.7, 23.8, 23.9, 23.10, 23.11.
 */

const ORIGIN = 'https://example.test';
const BUSINESS = 'New Galaxy Furniture';

function settingsWith(overrides: Partial<SiteSettings> = {}): SiteSettings {
  return {
    businessName: BUSINESS,
    logo: { src: null, wordmarkFallback: 'NGF', width: null, height: null },
    whatsapp: [
      { label: 'Orders 1', e164: '+919513443606' },
      { label: 'Orders 2', e164: '+918147083703' },
    ],
    phone: [
      { label: 'Orders 1', e164: '+919513443606' },
      { label: 'Orders 2', e164: '+918147083703' },
    ],
    location: {
      addressLines: [],
      city: '',
      state: '',
      postalCode: null,
      mapUrl: null,
      geo: null,
    },
    serviceArea: ['Karnataka'],
    social: { instagram: null, facebook: null },
    seoDefaults: { titleSuffix: ' | NGF', description: 'A catalogue.', ogImageKey: null },
    placeholders: [],
    ...overrides,
  };
}

function record(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function productWith(overrides: Partial<Product>): Product {
  return { ...demoSofa, ...overrides };
}

function reviewFor(productId: string | undefined, rating: number, id: string): Review {
  return {
    id,
    customerName: 'A Customer',
    rating,
    text: 'The sofa arrived as photographed and the frame is solid.',
    status: 'PUBLISHED',
    featured: false,
    order: 0,
    ...(productId === undefined ? {} : { productId }),
  };
}

/* -------------------------------------------------------------------------- */
/* Product                                                                    */
/* -------------------------------------------------------------------------- */

describe('productJsonLd', () => {
  const canonical = `${ORIGIN}/product/demo-sofa`;

  function build(
    product: Product,
    extra: { aggregateRating?: null | ReturnType<typeof aggregateRatingFor> } = {},
  ) {
    return record(
      productJsonLd({
        product,
        canonical,
        images: [`${ORIGIN}/img/p_1/img_1-1200.webp`],
        description: 'A three-seater sofa.',
        businessName: BUSINESS,
        ...extra,
      }),
    );
  }

  it('carries every required property', () => {
    const jsonLd = build(productWith({ material: 'Fabric', color: 'Beige' }));
    expect(jsonLd['@context']).toBe('https://schema.org');
    expect(jsonLd['@type']).toBe('Product');
    expect(jsonLd.name).toBe(demoSofa.name);
    expect(jsonLd.sku).toBe(demoSofa.sku);
    expect(jsonLd.description).toBe('A three-seater sofa.');
    expect(jsonLd.brand).toEqual({ '@type': 'Brand', name: BUSINESS });
    expect(jsonLd.material).toBe('Fabric');
    expect(jsonLd.color).toBe('Beige');
    expect(jsonLd.url).toBe(canonical);
  });

  it('emits absolute image URLs only', () => {
    const images = build(productWith({})).image as string[];
    expect(images.length).toBeGreaterThan(0);
    for (const url of images) expect(url.startsWith('https://')).toBe(true);
  });

  it('omits material and colour rather than emitting empty strings', () => {
    const jsonLd = build(productWith({ material: undefined, color: undefined }));
    expect('material' in jsonLd).toBe(false);
    expect('color' in jsonLd).toBe(false);
  });

  it('emits an offers block with INR pricing and a seller', () => {
    const offers = record(
      build(productWith({ price: 42000, priceOnEnquiry: false })).offers as object,
    );
    expect(offers['@type']).toBe('Offer');
    expect(offers.priceCurrency).toBe('INR');
    expect(offers.price).toBe('42000');
    expect(offers.seller).toEqual({ '@type': 'Organization', name: BUSINESS });
    expect(offers.url).toBe(canonical);
  });

  it('omits the whole offers block for a price-on-enquiry product', () => {
    const jsonLd = build(productWith({ price: null, priceOnEnquiry: true }));
    expect('offers' in jsonLd).toBe(false);
    // And nothing anywhere in the payload names a price or a currency.
    expect(JSON.stringify(jsonLd)).not.toContain('price');
    expect(JSON.stringify(jsonLd)).not.toContain('INR');
  });

  const AVAILABILITY: [StockStatusValue, string][] = [
    ['IN_STOCK', 'https://schema.org/InStock'],
    ['LIMITED_STOCK', 'https://schema.org/LimitedAvailability'],
    ['OUT_OF_STOCK', 'https://schema.org/OutOfStock'],
    ['MADE_TO_ORDER', 'https://schema.org/PreOrder'],
  ];

  it.each(AVAILABILITY)('maps stockStatus %s to %s', (stockStatus, expected) => {
    expect(availabilityFor(stockStatus)).toBe(expected);
    const offers = record(
      build(productWith({ stockStatus, madeToOrder: stockStatus === 'MADE_TO_ORDER' }))
        .offers as object,
    );
    expect(offers.availability).toBe(expected);
  });

  it('emits no aggregateRating when no review is linked to this product', () => {
    const reviews = [reviewFor(undefined, 5, 'r_site'), reviewFor('p_other00000', 5, 'r_other')];
    const jsonLd = build(productWith({}), {
      aggregateRating: aggregateRatingFor(reviews, demoSofa.id),
    });
    expect('aggregateRating' in jsonLd).toBe(false);
  });

  it('emits aggregateRating from approved reviews linked to this product', () => {
    const id = demoSofa.id;
    const reviews = [reviewFor(id, 5, 'r_1'), reviewFor(id, 4, 'r_2')];
    const jsonLd = build(productWith({}), {
      aggregateRating: aggregateRatingFor(reviews, id),
    });
    expect(jsonLd.aggregateRating).toEqual({
      '@type': 'AggregateRating',
      ratingValue: 4.5,
      reviewCount: 2,
      bestRating: 5,
      worstRating: 1,
    });
  });

  it('ignores an unpublished review even when it is linked to this product', () => {
    const id = demoSofa.id;
    const draft = { ...reviewFor(id, 1, 'r_draft'), status: 'DRAFT' } as Review;
    expect(aggregateRatingFor([draft], id)).toBeNull();
    expect(filterPublishedReviews([draft])).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* BreadcrumbList                                                             */
/* -------------------------------------------------------------------------- */

describe('breadcrumbJsonLd', () => {
  it('mirrors the visible product trail exactly, position by position', () => {
    const crumbs = productCrumbs({ name: 'Luxury Sofa', category: 'sofas' }, 'Sofas & Sectionals');
    const jsonLd = record(breadcrumbJsonLd(crumbs, ORIGIN));
    const items = jsonLd.itemListElement as Record<string, unknown>[];

    expect(jsonLd['@type']).toBe('BreadcrumbList');
    expect(items).toHaveLength(crumbs.length);
    expect(items.map((item) => item.name)).toEqual(crumbs.map((crumb) => crumb.label));
    expect(items.map((item) => item.position)).toEqual([1, 2, 3]);
    expect(items[0]?.item).toBe(`${ORIGIN}/collection`);
    expect(items[1]?.item).toBe(`${ORIGIN}/collection/sofas`);
  });

  it('gives the final crumb no item, matching the unlinked current page', () => {
    const crumbs = productCrumbs({ name: 'Luxury Sofa', category: 'sofas' }, 'Sofas');
    const items = record(breadcrumbJsonLd(crumbs, ORIGIN)).itemListElement as Record<
      string,
      unknown
    >[];
    expect(crumbs.at(-1)?.href).toBeUndefined();
    expect('item' in (items.at(-1) ?? {})).toBe(false);
  });

  it('uses the category name, never the slug, when a name is known', () => {
    const crumbs = productCrumbs(
      { name: 'X', category: 'coffee-side-tables' },
      'Coffee & Side Tables',
    );
    expect(crumbs[1]?.label).toBe('Coffee & Side Tables');
  });

  it('renders the category page trail as Collection then the category', () => {
    const crumbs = categoryCrumbs({ slug: 'beds', name: 'Beds' });
    expect(crumbs.map((crumb) => crumb.label)).toEqual(['Collection', 'Beds']);
    expect(crumbs[1]?.href).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* LocalBusiness                                                              */
/* -------------------------------------------------------------------------- */

describe('localBusinessJsonLd', () => {
  it('emits the verifiable fields', () => {
    const jsonLd = record(localBusinessJsonLd(settingsWith(), ORIGIN));
    expect(jsonLd['@type']).toBe('FurnitureStore');
    expect(jsonLd.name).toBe(BUSINESS);
    expect(jsonLd.url).toBe(`${ORIGIN}/`);
    expect(jsonLd.areaServed).toEqual([{ '@type': 'AdministrativeArea', name: 'Karnataka' }]);
  });

  it('emits both telephone numbers, deduplicated, because both reach the same people', () => {
    expect(record(localBusinessJsonLd(settingsWith(), ORIGIN)).telephone).toEqual([
      '+919513443606',
      '+918147083703',
    ]);
  });

  it('omits openingHours, priceRange, foundingDate and geo entirely while unsupplied', () => {
    const jsonLd = record(localBusinessJsonLd(settingsWith(), ORIGIN));
    for (const key of ['openingHours', 'priceRange', 'foundingDate', 'geo', 'hasMap']) {
      expect(key in jsonLd, key).toBe(false);
    }
  });

  it('omits the address entirely rather than emitting a country code alone', () => {
    expect('address' in record(localBusinessJsonLd(settingsWith(), ORIGIN))).toBe(false);
  });

  it('emits the address once the operator supplies it, with no code change', () => {
    const settings = settingsWith({
      location: {
        addressLines: ['12 Workshop Road', 'Unit 3'],
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560001',
        mapUrl: null,
        geo: null,
      },
    });
    expect(record(localBusinessJsonLd(settings, ORIGIN)).address).toEqual({
      '@type': 'PostalAddress',
      streetAddress: '12 Workshop Road, Unit 3',
      addressLocality: 'Bengaluru',
      addressRegion: 'Karnataka',
      postalCode: '560001',
      addressCountry: 'IN',
    });
  });

  it('emits geo and hasMap only once those are supplied', () => {
    const settings = settingsWith({
      location: {
        addressLines: [],
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: null,
        mapUrl: 'https://maps.example.test/ngf',
        geo: { lat: 12.97, lng: 77.59 },
      },
    });
    const jsonLd = record(localBusinessJsonLd(settings, ORIGIN));
    expect(jsonLd.geo).toEqual({ '@type': 'GeoCoordinates', latitude: 12.97, longitude: 77.59 });
    expect(jsonLd.hasMap).toBe('https://maps.example.test/ngf');
  });

  it('omits sameAs while every social link is null', () => {
    expect('sameAs' in record(localBusinessJsonLd(settingsWith(), ORIGIN))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* WebSite + SearchAction, ItemList                                           */
/* -------------------------------------------------------------------------- */

describe('webSiteJsonLd', () => {
  it('points the SearchAction at the route the site itself searches with', () => {
    const jsonLd = record(webSiteJsonLd(settingsWith(), ORIGIN));
    const action = record(jsonLd.potentialAction as object);
    expect(jsonLd['@type']).toBe('WebSite');
    expect(action['@type']).toBe('SearchAction');
    expect(record(action.target as object).urlTemplate).toBe(`${ORIGIN}/collection?q={query}`);
    expect(action['query-input']).toBe('required name=query');
  });
});

describe('itemListJsonLd', () => {
  it('lists the rendered order with 1-based positions and absolute URLs', () => {
    const jsonLd = record(
      itemListJsonLd(
        [
          { name: 'A Sofa', url: '/product/a-sofa' },
          { name: 'B Sofa', url: '/product/b-sofa' },
        ],
        ORIGIN,
        { name: 'Sofas' },
      ),
    );
    expect(jsonLd['@type']).toBe('ItemList');
    expect(jsonLd.name).toBe('Sofas');
    expect(jsonLd.numberOfItems).toBe(2);
    const items = jsonLd.itemListElement as Record<string, unknown>[];
    expect(items.map((item) => item.position)).toEqual([1, 2]);
    expect(items[0]?.url).toBe(`${ORIGIN}/product/a-sofa`);
  });

  it('reports zero items on an empty category rather than omitting the count', () => {
    const jsonLd = record(itemListJsonLd([], ORIGIN, { name: 'Outdoor' }));
    expect(jsonLd.numberOfItems).toBe(0);
    expect('itemListElement' in jsonLd).toBe(false);
  });
});
