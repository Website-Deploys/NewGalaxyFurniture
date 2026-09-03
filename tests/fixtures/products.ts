/**
 * ============================================================================
 *  DEMO PRODUCTS — TEST FIXTURES ONLY.
 *
 *  These objects MUST NEVER be written to `data/products/`.
 *
 *  `data/products/` is the live catalogue: anything in it is validated by
 *  `validate:content`, baked into the build, given a product page, a search
 *  index entry, a sitemap entry, and structured data. A demo product there would
 *  publish fake merchandise on a real furniture business's website.
 *
 *  No real product data or photography exists yet (design → Open Items item 5),
 *  so the catalogue ships empty and every surface renders its designed empty
 *  state. Tests that need a product import it from here.
 * ============================================================================
 */

import type { Product } from '@/schemas/product';

/** A fully populated, publish-ready product: priced, in stock, two images. */
export const demoSofa: Product = {
  id: 'p_demo000001',
  sku: 'NGF-SOF-D00001',
  slug: 'demo-l-shape-sofa',
  name: '[DEMO] Brown L-Shape Sofa',
  category: 'sofas',
  tags: ['l-shape', 'premium'],
  description:
    '[DEMO FIXTURE] A six-seater L-shape sofa in a brown fabric finish, used only to exercise the ' +
    'product surfaces in tests. This text exists to clear the schema minimum description length.',
  currency: 'INR',
  price: 42000,
  priceOnEnquiry: false,
  originalPrice: 52500,
  discount: 20,
  stockStatus: 'IN_STOCK',
  madeToOrder: false,
  material: 'Sheesham Wood',
  color: 'Brown',
  availableColors: ['Brown', 'Beige'],
  variants: [],
  images: [
    {
      id: 'img_demo000001',
      key: 'originals/img_demo000001.jpg',
      alt: 'Brown L-shape fabric sofa seen from the front left',
      width: 2400,
      height: 1600,
      order: 0,
      altSource: 'admin',
    },
    {
      id: 'img_demo000002',
      key: 'originals/img_demo000002.jpg',
      alt: 'Close-up of the sofa armrest stitching',
      width: 1800,
      height: 1800,
      order: 1,
      altSource: 'admin',
    },
  ],
  primaryImage: 'img_demo000001',
  featured: true,
  trending: false,
  bestSeller: false,
  newArrival: true,
  relatedProductIds: [],
  status: 'PUBLISHED',
  published: true,
  keywords: [],
  createdAt: '2025-01-15T10:00:00.000Z',
  updatedAt: '2025-01-15T10:00:00.000Z',
  aiAssisted: false,
  aiFields: [],
};

/** A price-on-enquiry, made-to-order product: the other side of every pricing branch. */
export const demoDiningTable: Product = {
  id: 'p_demo000002',
  sku: 'NGF-DTB-D00002',
  slug: 'demo-8-seater-dining-table',
  name: '[DEMO] 8-Seater Dining Table',
  category: 'dining-tables',
  tags: ['handcrafted'],
  description:
    '[DEMO FIXTURE] An eight-seater dining table in solid teak, made to order. Used in tests to ' +
    'cover the price-on-enquiry and made-to-order branches of the schema and the UI.',
  currency: 'INR',
  price: null,
  priceOnEnquiry: true,
  originalPrice: null,
  discount: null,
  stockStatus: 'MADE_TO_ORDER',
  madeToOrder: true,
  material: 'Teak',
  color: 'Natural',
  availableColors: ['Natural'],
  variants: [],
  images: [
    {
      id: 'img_demo000003',
      key: 'originals/img_demo000003.jpg',
      alt: 'Solid teak eight-seater dining table with six chairs',
      width: 2400,
      height: 1350,
      order: 0,
      altSource: 'admin',
    },
  ],
  primaryImage: 'img_demo000003',
  featured: false,
  trending: true,
  bestSeller: false,
  newArrival: false,
  relatedProductIds: ['p_demo000001'],
  status: 'PUBLISHED',
  published: true,
  keywords: [],
  createdAt: '2025-02-01T08:30:00.000Z',
  updatedAt: '2025-02-02T09:15:00.000Z',
  aiAssisted: false,
  aiFields: [],
};

/** An incomplete draft: no images, short description — fails the publish gate on purpose. */
export const demoDraftChair: Product = {
  id: 'p_demo000003',
  sku: 'NGF-ACH-D00003',
  slug: 'demo-accent-chair',
  name: '[DEMO] Accent Chair',
  category: 'accent-chairs',
  tags: [],
  description: '[DEMO FIXTURE] Draft copy awaiting photography and final details.',
  currency: 'INR',
  price: 8500,
  priceOnEnquiry: false,
  originalPrice: null,
  discount: null,
  stockStatus: 'IN_STOCK',
  madeToOrder: false,
  availableColors: [],
  variants: [],
  images: [],
  featured: false,
  trending: false,
  bestSeller: false,
  newArrival: false,
  relatedProductIds: [],
  status: 'DRAFT',
  published: false,
  keywords: [],
  createdAt: '2025-03-10T12:00:00.000Z',
  updatedAt: '2025-03-10T12:00:00.000Z',
  aiAssisted: false,
  aiFields: [],
};

export const demoProducts: readonly Product[] = [demoSofa, demoDiningTable, demoDraftChair];
