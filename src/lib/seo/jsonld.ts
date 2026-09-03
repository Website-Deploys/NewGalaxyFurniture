/**
 * The typed structured-data generators. Every JSON-LD block on the site comes from one of these.
 *
 * The governing rule is stated once and applied everywhere below: **an incomplete-but-true entity
 * beats a rich-but-false one.** Structured data is a machine-readable claim, and every field here
 * is either something the content actually says or is absent.
 *
 * That rule does the following concrete work:
 *
 * - **No fabricated price.** A `priceOnEnquiry` product omits the whole `offers` block rather than
 *   carrying a placeholder, a zero, or a "from" figure. Google penalises a price that does not
 *   match the page, and there is no price on the page to match (Requirement 23.8).
 * - **No fabricated rating.** `aggregateRating` is emitted only from approved reviews linked to
 *   *that* product. A site-wide testimonial is not product review data, and an average over an
 *   empty set is not a rating (Requirement 18.10). The caller passes `null` and the property
 *   disappears.
 * - **No invented location facts.** `FurnitureStore` emits name, url, both telephone numbers, and
 *   `areaServed` because all four are supplied. `address`, `openingHours`, `priceRange`,
 *   `foundingDate`, and `geo` appear only once the operator supplies them in Settings; until then
 *   the fields are absent, not guessed (Requirements 19.6, 23.9).
 * - **Breadcrumbs mirror the rendered trail.** The generator consumes the same `Crumb[]` the
 *   visible `Breadcrumbs` component renders, so the two cannot drift: there is one list.
 *
 * Absolute URLs throughout, built from the caller's `siteUrl`, which comes from
 * `PUBLIC_SITE_URL`.
 *
 * Design: SEO and Structured Data → Structured data.
 * Requirements: 18.10, 19.6, 23.7, 23.8, 23.9, 23.10, 23.11, 23.18.
 */

import type { AggregateRating } from '@/lib/content/reviews';
import type { Crumb } from '@/lib/site/breadcrumbs';
import type { Product, StockStatusValue } from '@/schemas/product';
import type { SiteSettings } from '@/schemas/site';

import { absoluteUrl } from './meta';

const CONTEXT = 'https://schema.org';

/** `stockStatus` → schema.org availability. Made-to-order is `PreOrder`: it is orderable now and
 *  built after the order, which is exactly what `PreOrder` means. */
const AVAILABILITY: Record<StockStatusValue, string> = {
  IN_STOCK: `${CONTEXT}/InStock`,
  LIMITED_STOCK: `${CONTEXT}/LimitedAvailability`,
  OUT_OF_STOCK: `${CONTEXT}/OutOfStock`,
  MADE_TO_ORDER: `${CONTEXT}/PreOrder`,
};

export function availabilityFor(stockStatus: StockStatusValue): string {
  return AVAILABILITY[stockStatus];
}

/** Drop every `undefined`, empty-string, and empty-array member. Absent means "not claimed". */
function compact<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    output[key] = value;
  }
  return output;
}

/* -------------------------------------------------------------------------- */
/* Product                                                                    */
/* -------------------------------------------------------------------------- */

export interface ProductJsonLdInput {
  product: Product;
  /** The canonical PDP URL, absolute. */
  canonical: string;
  /** Absolute image URLs, primary first. May be empty for a product with no photography yet. */
  images: readonly string[];
  /** The description the page shows — the same fallback chain the metadata uses. */
  description: string;
  /** `SiteSettings.businessName` — the brand and the seller are the same entity here. */
  businessName: string;
  /** Approved, product-linked reviews only. `null` omits the property. */
  aggregateRating?: AggregateRating | null;
}

/**
 * `Product` for a PDP.
 *
 * `offers` is present exactly when there is a real price to state. `priceOnEnquiry` products, and
 * any product whose price is null, carry the entity without the offer — the visitor is told to
 * enquire and so is the crawler.
 */
export function productJsonLd(input: ProductJsonLdInput): object {
  const { product, canonical, images, description, businessName, aggregateRating } = input;

  const offers =
    product.priceOnEnquiry || product.price === null
      ? undefined
      : compact({
          '@type': 'Offer',
          url: canonical,
          priceCurrency: product.currency,
          price: String(product.price),
          availability: availabilityFor(product.stockStatus),
          itemCondition: `${CONTEXT}/NewCondition`,
          seller: { '@type': 'Organization', name: businessName },
        });

  const rating =
    aggregateRating === undefined || aggregateRating === null
      ? undefined
      : {
          '@type': 'AggregateRating',
          ratingValue: aggregateRating.ratingValue,
          reviewCount: aggregateRating.reviewCount,
          bestRating: aggregateRating.bestRating,
          worstRating: aggregateRating.worstRating,
        };

  return {
    '@context': CONTEXT,
    ...compact({
      '@type': 'Product',
      name: product.name,
      sku: product.sku,
      url: canonical,
      image: [...images],
      description,
      brand: { '@type': 'Brand', name: businessName },
      material: product.material,
      color: product.color,
      // The size the page states, when it states one — never a computed guess.
      size: product.size,
      offers,
      aggregateRating: rating,
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* BreadcrumbList                                                             */
/* -------------------------------------------------------------------------- */

/**
 * `BreadcrumbList` from the trail the page renders.
 *
 * `item` is emitted only for a crumb that is a link, which makes the final crumb — the page you
 * are already on — a named position without a URL. That mirrors the rendered trail exactly, where
 * the last crumb is text with `aria-current="page"` rather than a self-link.
 */
export function breadcrumbJsonLd(items: readonly Crumb[], siteUrl: string): object {
  return {
    '@context': CONTEXT,
    '@type': 'BreadcrumbList',
    itemListElement: items.map((crumb, index) =>
      compact({
        '@type': 'ListItem',
        position: index + 1,
        name: crumb.label,
        item: crumb.href === undefined ? undefined : absoluteUrl(siteUrl, crumb.href),
      }),
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* LocalBusiness                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The postal address, or `undefined`.
 *
 * `undefined` when the operator has supplied neither a street nor a locality — a `PostalAddress`
 * carrying only a country code is not an address, and inventing the rest is the failure this
 * whole module is arranged to prevent. The Settings form and the Admin → Content checklist track
 * these fields; when they are filled, this starts emitting them with no code change.
 */
function addressOf(site: SiteSettings): Record<string, unknown> | undefined {
  const streetAddress = site.location.addressLines
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(', ');
  const locality = site.location.city.trim();
  if (streetAddress === '' && locality === '') return undefined;

  return compact({
    '@type': 'PostalAddress',
    streetAddress,
    addressLocality: locality,
    addressRegion: site.location.state.trim(),
    postalCode: site.location.postalCode ?? undefined,
    addressCountry: 'IN',
  });
}

/**
 * `FurnitureStore` for `/` and `/contact`.
 *
 * Both telephone numbers are emitted, because both are order-and-enquiry numbers reaching the same
 * people — neither is a department and neither is secondary (Requirement 5.10). `openingHours`,
 * `priceRange`, `foundingDate`, and `geo` are deliberately not constructed here at all: they are
 * unknown, and the schema's `null` is the truthful value.
 */
export function localBusinessJsonLd(site: SiteSettings, siteUrl: string): object {
  const telephone = [...site.phone, ...site.whatsapp]
    .map((entry) => entry.e164)
    .filter((value, index, all) => all.indexOf(value) === index);

  const socialProfiles = Object.values(site.social).filter(
    (value): value is string => typeof value === 'string' && value.trim() !== '',
  );

  return {
    '@context': CONTEXT,
    ...compact({
      '@type': 'FurnitureStore',
      '@id': `${absoluteUrl(siteUrl, '/')}#business`,
      name: site.businessName,
      url: absoluteUrl(siteUrl, '/'),
      telephone,
      address: addressOf(site),
      areaServed: site.serviceArea.map((area) => ({ '@type': 'AdministrativeArea', name: area })),
      geo:
        site.location.geo === null
          ? undefined
          : {
              '@type': 'GeoCoordinates',
              latitude: site.location.geo.lat,
              longitude: site.location.geo.lng,
            },
      hasMap: site.location.mapUrl ?? undefined,
      sameAs: socialProfiles,
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* WebSite + SearchAction                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `WebSite` with the homepage `SearchAction`, pointing at the real search route.
 *
 * `/collection?q={query}` is the URL the site's own search box navigates to, so the action a
 * crawler offers is the action the site performs — not a search endpoint invented for the markup.
 */
export function webSiteJsonLd(site: SiteSettings, siteUrl: string): object {
  const home = absoluteUrl(siteUrl, '/');
  return {
    '@context': CONTEXT,
    '@type': 'WebSite',
    '@id': `${home}#website`,
    name: site.businessName,
    url: home,
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: `${absoluteUrl(siteUrl, '/collection')}?q={query}`,
      },
      'query-input': 'required name=query',
    },
  };
}

/* -------------------------------------------------------------------------- */
/* ItemList                                                                   */
/* -------------------------------------------------------------------------- */

export interface ItemListEntry {
  name: string;
  /** Site-relative or absolute. */
  url: string;
}

/**
 * `ItemList` for a category listing.
 *
 * Positions are 1-based and follow the rendered order, so the list a crawler reads is the list a
 * visitor sees. `numberOfItems` is the length of what is listed, which for a category page is the
 * published product count — the same number the page prints.
 */
export function itemListJsonLd(
  entries: readonly ItemListEntry[],
  siteUrl: string,
  options: { name?: string } = {},
): object {
  return {
    '@context': CONTEXT,
    ...compact({
      '@type': 'ItemList',
      name: options.name,
      numberOfItems: entries.length,
      itemListOrder: `${CONTEXT}/ItemListOrderAscending`,
      itemListElement: entries.map((entry, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: entry.name,
        url: absoluteUrl(siteUrl, entry.url),
      })),
    }),
  };
}
