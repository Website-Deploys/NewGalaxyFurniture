/**
 * `npm run product:add` — the single-command product creation CLI.
 *
 * Adding a product must touch **exactly one data file and zero frontend files**. That is
 * the whole requirement, and it is only true because nothing here is bespoke: every
 * decision that shapes the written record is made by the same function the admin API and
 * the AI assistant call.
 *
 * | Concern | Shared module this CLI calls |
 * |---|---|
 * | slug, SKU | `toSlug` / `uniqueSlug` / `generateSku` (`src/lib/slug.ts`) |
 * | product id, record assembly, derived fields | `buildNewProduct` / `normalizeProduct` (`src/lib/products/input.ts`) |
 * | schema gate | `validateProduct` → `ProductSchema` |
 * | publish gate | `checkPublishGate` → `PublishReadySchema` |
 * | upload validation | `validateUpload` (`src/lib/images/validate.ts`) |
 * | derivatives, LQIP, sanitized original | `generateDerivatives` / `buildLqip` / `sanitizeOriginal` |
 * | R2 keys and writes | `originalKey` / `putImageObject` |
 * | SEO fallbacks | `productTitleFallback` / `productDescriptionFallback` |
 * | write path | `productContentPath` — the admin's path allowlist |
 * | bytes on disk | `serializeContentJson` — sorted keys, 2-space indent, trailing newline |
 *
 * There is no second implementation of any of those, which is what makes Requirement
 * 27.11 (byte-compatible files from all three creation routes) true by construction
 * rather than by comparison.
 *
 * ## What the image step can and cannot do — stated plainly
 *
 * The derivative pipeline writes to an **R2 binding**, and a binding exists only inside a
 * Worker. This CLI runs in Node, so it obtains a real binding the only way a local process
 * can: `getPlatformProxy()` from wrangler, which reads `wrangler.toml` and hands back the
 * `MEDIA` binding backed by the filesystem-persisted local bucket under
 * `.wrangler/state/v3/r2`.
 *
 * That is a real R2 API and a real write. It is **not** the deployed bucket. Nothing this
 * CLI does puts bytes where a deployed `/img/**` request will find them. Consequently:
 *
 * - the written record carries `derivativesReady: false` with empty `derivativeWidths` /
 *   `derivativeFormats` — the same initial state the admin upload endpoint records before
 *   its background pass — because claiming readiness would be a claim about a bucket this
 *   process never reached;
 * - the run report names the bucket it actually wrote to, lists every object key, and says
 *   what is still required;
 * - `--images-out <dir>` writes the same bytes to disk so they can be pushed to the
 *   deployed bucket with `wrangler r2 object put`;
 * - `--r2 none` skips object writes entirely. Validation, the decode, intrinsic dimensions
 *   and the LQIP still run; derivatives do not, and the report says so.
 *
 * ## Usage
 *
 * ```bash
 * npm run product:add -- \
 *   --name "Luxury L-Shape Sofa" \
 *   --category sofas \
 *   --price 42000 \
 *   --material "Fabric upholstery, seasoned hardwood frame" \
 *   --dimensions "213x91x76" \
 *   --colors "Beige,Grey,Brown" \
 *   --images ./incoming/sofa-1.jpg ./incoming/sofa-2.jpg \
 *   --status DRAFT
 * ```
 *
 * Exit contract: `0` on success, `1` on any failure. **A failure writes no content file**
 * and names the failing field.
 *
 * Design: Kiro / Developer Product Workflow.
 * Requirements: 27.1 – 27.11.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { buildLqip, generateDerivatives, sanitizeOriginal } from '../src/lib/images/derivatives.ts';
import { buildEnquiryMessage, buildWhatsAppUrl, toDigits } from '../src/lib/whatsapp.ts';
import { CategorySchema } from '../src/schemas/category.ts';
import { checkPublishGate } from '../src/schemas/publish-gate.ts';
import { createCodec, type ImageCodec, type RawImage } from '../src/lib/images/codec.ts';
import { generateImageId, validateUpload } from '../src/lib/images/validate.ts';
import { originalKey } from '../src/lib/images/srcset.ts';
import { productContentPath } from '../src/lib/github/paths.ts';
import {
  buildNewProduct,
  normalizeProduct,
  validateProduct,
  type FieldErrors,
  type ProductCreateInputValue,
} from '../src/lib/products/input.ts';
import {
  DESCRIPTION_MAX,
  productDescriptionFallback,
  productTitleFallback,
  truncateAtWord,
} from '../src/lib/seo/meta.ts';
import { putImageObject } from '../src/lib/images/store.ts';
import { serializeContentJson } from '../src/lib/github/serialize.ts';
import { SiteSettingsSchema } from '../src/schemas/site.ts';
import type { R2Bucket } from '@cloudflare/workers-types';
import type { Product, ProductImageValue, ProductStatusValue } from '../src/schemas/product.ts';
import type { SiteSettings } from '../src/schemas/site.ts';
import type { TakenIdentifiers } from '../src/lib/products/duplicate.ts';

/* -------------------------------------------------------------------------- */
/* Result types                                                              */
/* -------------------------------------------------------------------------- */

/** `seoTitle` is schema-capped at 70; the render layer appends the site suffix. */
const SEO_TITLE_MAX = 70;

export type R2Mode = 'local' | 'none';

export interface ImageReport {
  source: string;
  imageId: string;
  width: number;
  height: number;
  /** Every R2 key this run produced, original first. */
  keys: string[];
  /** Widths actually encoded, whatever bucket they landed in. */
  generatedWidths: number[];
  generatedFormats: string[];
  lqip: boolean;
}

export interface RunSuccess {
  ok: true;
  /** Repository-relative path of the one file written (or that would be written). */
  path: string;
  /** Absolute path on disk. */
  absolutePath: string;
  /** The exact bytes written. */
  contents: string;
  product: Product;
  /**
   * The `ProductCreateInput` handed to `buildNewProduct`, including any SEO value this
   * run generated. Returned so a test can drive the admin creator with the identical
   * input and compare bytes (Requirement 27.11).
   */
  input: ProductCreateInputValue;
  taken: TakenIdentifiers;
  now: Date;
  /** False for `--dry-run`. */
  written: boolean;
  images: ImageReport[];
  /** Where the image objects went, in words. `null` when there were no images. */
  imageDestination: string | null;
  /** The `wa.me` URLs asserted to round-trip. */
  whatsappUrls: string[];
  diff: string;
}

export interface RunFailure {
  ok: false;
  /** Field-keyed messages where a field is identifiable, `_` otherwise. */
  fields: FieldErrors;
  /** One-line summary, already safe to print. */
  message: string;
}

export type RunResult = RunSuccess | RunFailure;

function failure(message: string, fields: FieldErrors = {}): RunFailure {
  return { ok: false, message, fields };
}

function fieldFailure(field: string, message: string): RunFailure {
  return { ok: false, message, fields: { [field]: [message] } };
}

/* -------------------------------------------------------------------------- */
/* Argument parsing                                                          */
/* -------------------------------------------------------------------------- */

interface CliOptions {
  name: string;
  category: string;
  status: ProductStatusValue;
  dataDir: string;
  r2: R2Mode;
  imagesOut: string | null;
  dryRun: boolean;
  images: string[];
  alt: string;
  /** Everything that maps straight onto `ProductCreateInput`. */
  fields: Partial<ProductCreateInputValue>;
}

const STATUSES: readonly ProductStatusValue[] = [
  'DRAFT',
  'REVIEW',
  'PUBLISHED',
  'UNPUBLISHED',
  'OUT_OF_STOCK',
];

const STOCK_STATUSES = ['IN_STOCK', 'LIMITED_STOCK', 'OUT_OF_STOCK', 'MADE_TO_ORDER'] as const;

/** Flags that take no value. */
const BOOLEAN_FLAGS = new Set([
  '--price-on-enquiry',
  '--made-to-order',
  '--featured',
  '--trending',
  '--best-seller',
  '--new-arrival',
  '--dry-run',
  '--help',
  '-h',
]);

/** Flags whose value is a list of paths, consuming every following non-flag token. */
const VARIADIC_FLAGS = new Set(['--images']);

export const USAGE = `npm run product:add -- --name <name> --category <slug> [options]

Required
  --name <string>             Product name (2–120 characters)
  --category <slug>           Must match an existing data/categories/<slug>.json

Pricing
  --price <rupees>            Integer INR; omitting it means price on enquiry
  --original-price <rupees>   Strike-through price; must exceed --price
  --price-on-enquiry          Force price-on-enquiry and clear any price

Product
  --description <string>      Long copy (20+ characters to pass the publish gate)
  --short-description <s>     Card/summary copy (max 240)
  --subcategory <string>
  --material <string>
  --color <string>            Primary colour
  --colors <a,b,c>            Available colours
  --size <string>
  --dimensions <LxWxH[xD]>    Centimetres, e.g. 213x91x76
  --dimensions-display <s>    Human-readable form, e.g. "7 ft x 3 ft x 2.5 ft"
  --customization <string>
  --delivery-information <s>

Inventory
  --stock-status <value>      ${STOCK_STATUSES.join(' | ')}
  --made-to-order

Merchandising
  --featured --trending --best-seller --new-arrival
  --tags <a,b>                --keywords <a,b>
  --related <id,id>

SEO (generated from name/category/description when omitted)
  --seo-title <string>        Max 70
  --seo-description <string>  Max 170

Images
  --images <path...>          One or more local image files
  --alt <string>              Alt text applied to every supplied image
  --image-alt-text <string>   Product-level alt used for the OG image
  --r2 <local|none>           Where image objects are written (default: local)
  --images-out <dir>          Also write every generated object to this directory

Lifecycle
  --status <value>            ${STATUSES.join(' | ')} (default: DRAFT)

Other
  --data <dir>                Content root (default: data)
  --dry-run                   Validate and print the diff; write nothing
  -h, --help                  Show this message`;

function parseIntegerFlag(flag: string, raw: string): number | RunFailure {
  if (!/^\d+$/.test(raw))
    return fieldFailure(
      flag.replace(/^--/, ''),
      `${flag} must be a positive whole number of rupees`,
    );
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return fieldFailure(
      flag.replace(/^--/, ''),
      `${flag} must be a positive whole number of rupees`,
    );
  }
  return value;
}

function parseList(raw: string): string[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/**
 * `LxWxH` or `LxWxHxD` in centimetres.
 *
 * The admin form has four separate numeric controls; a command line does not, so the CLI
 * accepts the shorthand an operator would actually type and expands it into the same
 * `Dimensions` object. `display` is never inferred — an invented human-readable string is
 * still an invented product fact — and is set only by `--dimensions-display`.
 */
export function parseDimensions(
  raw: string,
): { lengthCm: number; widthCm: number; heightCm: number; depthCm?: number } | null {
  const parts = raw
    .toLowerCase()
    .split(/[x×*]/)
    .map((part) => part.trim());
  if (parts.length < 3 || parts.length > 4) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    if (!/^\d+(?:\.\d+)?$/.test(part)) return null;
    const value = Number.parseFloat(part);
    if (!Number.isFinite(value) || value <= 0) return null;
    numbers.push(value);
  }
  const [lengthCm, widthCm, heightCm, depthCm] = numbers as [number, number, number, number?];
  return {
    lengthCm,
    widthCm,
    heightCm,
    ...(depthCm === undefined ? {} : { depthCm }),
  };
}

export function parseArgs(argv: readonly string[]): CliOptions | RunFailure | 'help' {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const images: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith('--') && token !== '-h') {
      return failure(`Unexpected argument "${token}". Every value must follow its flag.`);
    }
    if (BOOLEAN_FLAGS.has(token)) {
      flags.add(token);
      continue;
    }
    if (VARIADIC_FLAGS.has(token)) {
      while (index + 1 < argv.length && !(argv[index + 1] as string).startsWith('--')) {
        index += 1;
        images.push(argv[index] as string);
      }
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      return failure(`${token} needs a value.`);
    }
    values.set(token, next);
    index += 1;
  }

  if (flags.has('--help') || flags.has('-h')) return 'help';

  const known = new Set([
    ...BOOLEAN_FLAGS,
    ...VARIADIC_FLAGS,
    '--name',
    '--category',
    '--price',
    '--original-price',
    '--description',
    '--short-description',
    '--subcategory',
    '--material',
    '--color',
    '--colors',
    '--size',
    '--dimensions',
    '--dimensions-display',
    '--customization',
    '--delivery-information',
    '--stock-status',
    '--tags',
    '--keywords',
    '--related',
    '--seo-title',
    '--seo-description',
    '--alt',
    '--image-alt-text',
    '--status',
    '--data',
    '--r2',
    '--images-out',
  ]);
  for (const key of values.keys()) {
    if (!known.has(key))
      return failure(`Unknown flag "${key}". Run with --help for the flag list.`);
  }

  const name = values.get('--name');
  if (name === undefined || name.trim() === '') {
    return fieldFailure('name', '--name is required.');
  }
  const category = values.get('--category');
  if (category === undefined || category.trim() === '') {
    return fieldFailure('category', '--category is required.');
  }

  const statusRaw = values.get('--status') ?? 'DRAFT';
  if (!STATUSES.includes(statusRaw as ProductStatusValue)) {
    return fieldFailure('status', `--status must be one of ${STATUSES.join(', ')}.`);
  }
  const status = statusRaw as ProductStatusValue;

  const r2Raw = values.get('--r2') ?? 'local';
  if (r2Raw !== 'local' && r2Raw !== 'none') {
    return fieldFailure(
      'r2',
      '--r2 must be "local" (write through the wrangler platform proxy) or "none" (skip object writes).',
    );
  }

  const fields: Partial<ProductCreateInputValue> = {};

  const price = values.get('--price');
  if (price !== undefined) {
    const parsed = parseIntegerFlag('--price', price);
    if (typeof parsed !== 'number') return parsed;
    fields.price = parsed;
  }
  const originalPrice = values.get('--original-price');
  if (originalPrice !== undefined) {
    const parsed = parseIntegerFlag('--original-price', originalPrice);
    if (typeof parsed !== 'number') return parsed;
    fields.originalPrice = parsed;
  }
  if (flags.has('--price-on-enquiry')) fields.priceOnEnquiry = true;

  const stringFields: [string, keyof ProductCreateInputValue][] = [
    ['--description', 'description'],
    ['--short-description', 'shortDescription'],
    ['--subcategory', 'subcategory'],
    ['--material', 'material'],
    ['--color', 'color'],
    ['--size', 'size'],
    ['--customization', 'customization'],
    ['--delivery-information', 'deliveryInformation'],
    ['--seo-title', 'seoTitle'],
    ['--seo-description', 'seoDescription'],
    ['--image-alt-text', 'imageAltText'],
  ];
  for (const [flag, key] of stringFields) {
    const value = values.get(flag);
    if (value !== undefined) (fields as Record<string, unknown>)[key] = value;
  }

  const listFields: [string, keyof ProductCreateInputValue][] = [
    ['--colors', 'availableColors'],
    ['--tags', 'tags'],
    ['--keywords', 'keywords'],
    ['--related', 'relatedProductIds'],
  ];
  for (const [flag, key] of listFields) {
    const value = values.get(flag);
    if (value !== undefined) (fields as Record<string, unknown>)[key] = parseList(value);
  }

  const stockStatus = values.get('--stock-status');
  if (stockStatus !== undefined) {
    if (!STOCK_STATUSES.includes(stockStatus as (typeof STOCK_STATUSES)[number])) {
      return fieldFailure(
        'stockStatus',
        `--stock-status must be one of ${STOCK_STATUSES.join(', ')}.`,
      );
    }
    fields.stockStatus = stockStatus as (typeof STOCK_STATUSES)[number];
  }
  if (flags.has('--made-to-order')) fields.madeToOrder = true;
  if (flags.has('--featured')) fields.featured = true;
  if (flags.has('--trending')) fields.trending = true;
  if (flags.has('--best-seller')) fields.bestSeller = true;
  if (flags.has('--new-arrival')) fields.newArrival = true;

  const dimensions = values.get('--dimensions');
  const dimensionsDisplay = values.get('--dimensions-display');
  if (dimensions !== undefined || dimensionsDisplay !== undefined) {
    let parsed: Record<string, unknown> = {};
    if (dimensions !== undefined) {
      const measured = parseDimensions(dimensions);
      if (measured === null) {
        return fieldFailure(
          'dimensions',
          '--dimensions must be centimetres as LxWxH or LxWxHxD, e.g. 213x91x76.',
        );
      }
      parsed = { ...measured };
    }
    if (dimensionsDisplay !== undefined) parsed.display = dimensionsDisplay;
    fields.dimensions = parsed;
  }

  return {
    name: name.trim(),
    category: category.trim(),
    status,
    dataDir: values.get('--data') ?? 'data',
    r2: r2Raw,
    imagesOut: values.get('--images-out') ?? null,
    dryRun: flags.has('--dry-run'),
    images,
    alt: values.get('--alt') ?? '',
    fields,
  };
}

/* -------------------------------------------------------------------------- */
/* Content reads                                                             */
/* -------------------------------------------------------------------------- */

async function jsonFilesIn(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

interface CategoryInfo {
  slugs: string[];
  nameOf: Map<string, string>;
}

async function readCategories(dataDir: string): Promise<CategoryInfo> {
  const nameOf = new Map<string, string>();
  for (const file of await jsonFilesIn(join(dataDir, 'categories'))) {
    const parsed = CategorySchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
    if (parsed.success) nameOf.set(parsed.data.slug, parsed.data.name);
  }
  return { slugs: [...nameOf.keys()].sort(), nameOf };
}

/**
 * The slugs and SKUs already in use.
 *
 * The admin reads these from the KV product index; there is no KV here, so the files
 * themselves are the index — which is the same set of identifiers, read from the source of
 * truth rather than from its cache. Fields are read individually rather than through
 * `ProductSchema` on purpose: an existing file that fails validation must still reserve its
 * slug, otherwise this command would happily mint a colliding one. Reporting that file is
 * `validate:content`'s job.
 */
async function readTakenIdentifiers(dataDir: string): Promise<TakenIdentifiers> {
  const slugs = new Set<string>();
  const skus = new Set<string>();
  for (const file of await jsonFilesIn(join(dataDir, 'products'))) {
    let record: unknown;
    try {
      record = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      // Unparseable: its filename still reserves a slug.
      slugs.add(basename(file, '.json'));
      continue;
    }
    slugs.add(basename(file, '.json'));
    if (typeof record === 'object' && record !== null) {
      const row = record as Record<string, unknown>;
      if (typeof row.slug === 'string') slugs.add(row.slug);
      if (typeof row.sku === 'string') skus.add(row.sku);
    }
  }
  return { slugs, skus };
}

async function readSettings(dataDir: string): Promise<SiteSettings | null> {
  try {
    const raw = await readFile(join(dataDir, 'site', 'settings.json'), 'utf8');
    const parsed = SiteSettingsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Image processing                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The production codec, resolved for Node.
 *
 * Photon's `workerd` build and jSquash's `.wasm` module imports only resolve inside the
 * Cloudflare build, so Node gets `@cf-wasm/photon/node` and modules compiled from disk —
 * exactly what the test suite does. The adapters and `createCodec` are the production ones;
 * only module resolution differs, so the derivatives this command writes are the bytes the
 * Worker would have written.
 *
 * Imported dynamically: ~4.6 MB of WebAssembly must not be compiled by a run that has no
 * `--images`.
 */
async function nodeCodec(): Promise<ImageCodec> {
  const [{ avifApiFrom, photonApiFrom }, photonNode, encode, decode, { readFileSync }] =
    await Promise.all([
      import('../src/lib/images/codec-adapters.ts'),
      import('@cf-wasm/photon/node'),
      import('@jsquash/avif/encode.js'),
      import('@jsquash/avif/decode.js'),
      import('node:fs'),
    ]);

  const wasm = (relative: string): WebAssembly.Module =>
    new WebAssembly.Module(readFileSync(new URL(`../node_modules/${relative}`, import.meta.url)));

  const avifLib = {
    initEncode: (module: WebAssembly.Module) => encode.init(module),
    encode: (
      image: { data: Uint8ClampedArray; width: number; height: number },
      options: { quality: number; speed: number },
    ) => encode.default(image as unknown as ImageData, options),
    initDecode: (module: WebAssembly.Module) => decode.init(module),
    decode: async (bytes: ArrayBuffer) => await decode.default(bytes),
  };

  return createCodec(
    photonApiFrom(photonNode as unknown as Parameters<typeof photonApiFrom>[0]),
    avifApiFrom(
      avifLib,
      wasm('@jsquash/avif/codec/enc/avif_enc.wasm'),
      wasm('@jsquash/avif/codec/dec/avif_dec.wasm'),
    ),
  );
}

/** An in-process bucket used to capture bytes when `--r2 none` or `--images-out` is set. */
function captureBucket(sink: Map<string, { bytes: Uint8Array; contentType: string }>): R2Bucket {
  return {
    put: (
      key: string,
      value: ArrayBuffer | Uint8Array,
      options?: { httpMetadata?: { contentType?: string } },
    ) => {
      sink.set(key, {
        bytes: value instanceof Uint8Array ? value.slice() : new Uint8Array(value),
        contentType: options?.httpMetadata?.contentType ?? 'application/octet-stream',
      });
      return Promise.resolve(undefined);
    },
  } as unknown as R2Bucket;
}

/** Fan a single write out to every destination this run has. */
function teeBucket(targets: readonly R2Bucket[]): R2Bucket {
  return {
    put: async (
      key: string,
      value: ArrayBuffer | Uint8Array,
      options?: { httpMetadata?: { contentType?: string } },
    ) => {
      for (const target of targets) {
        await (
          target as unknown as { put: (k: string, v: unknown, o?: unknown) => Promise<void> }
        ).put(key, value instanceof Uint8Array ? value.slice() : value, options);
      }
      return undefined;
    },
  } as unknown as R2Bucket;
}

interface R2Target {
  bucket: R2Bucket | null;
  description: string;
  dispose: () => Promise<void>;
}

/**
 * The `MEDIA` binding, via wrangler's platform proxy.
 *
 * This is the only way a Node process gets a genuine R2 binding, and it is genuinely the
 * local bucket — see the header. Failure to start is reported, never swallowed: silently
 * degrading to "no upload" while printing a success line is precisely the dishonesty this
 * command must not commit.
 */
async function openLocalR2(): Promise<R2Target | RunFailure> {
  try {
    const { getPlatformProxy } = await import('wrangler');
    const proxy = await getPlatformProxy<{ MEDIA?: R2Bucket }>({
      configPath: 'wrangler.toml',
      persist: { path: '.wrangler/state/v3' },
      remoteBindings: false,
    });
    const bucket = proxy.env.MEDIA;
    if (bucket === undefined) {
      await proxy.dispose();
      return fieldFailure(
        'images',
        'wrangler.toml exposes no MEDIA R2 binding, so there is nowhere to write image objects.',
      );
    }
    return {
      bucket,
      description:
        'the LOCAL R2 simulator — the MEDIA binding from wrangler.toml, persisted at .wrangler/state/v3/r2. This is NOT the deployed bucket.',
      dispose: () => proxy.dispose(),
    };
  } catch (error) {
    return fieldFailure(
      'images',
      `Could not open the local R2 binding through wrangler (${error instanceof Error ? error.message : String(error)}). ` +
        'Re-run with --r2 none to validate and measure the images without writing objects.',
    );
  }
}

interface ProcessedImages {
  records: ProductImageValue[];
  reports: ImageReport[];
  /** Key → bytes, present when the objects need writing to `--images-out`. */
  captured: Map<string, { bytes: Uint8Array; contentType: string }>;
}

async function processImages(input: {
  paths: readonly string[];
  alt: string;
  productId: string;
  codec: ImageCodec;
  bucket: R2Bucket | null;
  capture: Map<string, { bytes: Uint8Array; contentType: string }> | null;
}): Promise<ProcessedImages | RunFailure> {
  const records: ProductImageValue[] = [];
  const reports: ImageReport[] = [];
  const captured = input.capture ?? new Map<string, { bytes: Uint8Array; contentType: string }>();

  const sinks: R2Bucket[] = [];
  if (input.bucket !== null) sinks.push(input.bucket);
  if (input.capture !== null) sinks.push(captureBucket(captured));
  const target =
    sinks.length === 0 ? null : sinks.length === 1 ? (sinks[0] as R2Bucket) : teeBucket(sinks);

  for (const [index, path] of input.paths.entries()) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(path));
    } catch {
      return fieldFailure('images', `Could not read image file "${path}".`);
    }

    // The identical validation the admin upload endpoint runs: magic-byte sniff, SVG
    // refusal, header dimension bounds, then a full decode whose pixels are the record's
    // intrinsic dimensions (Requirement 27.5).
    const outcome = await validateUpload(
      {
        name: basename(path),
        type: '',
        size: bytes.length,
        arrayBuffer: () => Promise.resolve(bytes.slice().buffer),
      },
      (candidate, type) => input.codec.decode(candidate, type),
    );
    if (!outcome.ok) {
      return fieldFailure('images', `${path}: ${outcome.error.message}`);
    }
    const decoded = outcome.image;
    const pixels = decoded.pixels;
    if (pixels === undefined) {
      return fieldFailure('images', `${path}: the decoder returned no pixels.`);
    }
    const raw: RawImage = { width: decoded.width, height: decoded.height, rgba: pixels };

    const imageId = generateImageId();
    const sanitized = await sanitizeOriginal(input.codec, raw, decoded.type.format);
    const key = originalKey(input.productId, imageId, sanitized.ext);
    const keys: string[] = [];
    let generatedWidths: number[] = [];
    let generatedFormats: string[] = [];

    if (target !== null) {
      await putImageObject(target, { key, bytes: sanitized.bytes, contentType: sanitized.mime });
      keys.push(key);
      const generated = await generateDerivatives({
        bucket: target,
        codec: input.codec,
        raw,
        productId: input.productId,
        imageId,
      });
      if (generated.failed.length > 0) {
        return fieldFailure(
          'images',
          `${path}: ${String(generated.failed.length)} derivative(s) could not be encoded or stored ` +
            `(first: ${generated.failed[0]?.reason ?? 'unknown'}).`,
        );
      }
      keys.push(...generated.written.map((entry) => entry.key));
      generatedWidths = generated.widths;
      generatedFormats = generated.formats;
    }

    const lqip = await buildLqip(input.codec, raw);

    records.push({
      id: imageId,
      key,
      alt: input.alt,
      width: decoded.width,
      height: decoded.height,
      order: index,
      altSource: 'admin',
      mime: sanitized.mime,
      filename: decoded.label,
      ...(lqip === null ? {} : { lqip }),
      /*
       * Recorded exactly as the admin upload endpoint records it on first write, and left
       * that way. `derivativesReady` is a claim about the bucket the deployment reads, and
       * this process never reached that bucket — see the file header. `/img/**` therefore
       * serves the sanitized original, which is the designed pre-derivative behaviour
       * (Requirement 15.13), until the objects are in place and the admin's own pipeline
       * asserts readiness.
       */
      derivativesReady: false,
      derivativeWidths: [],
      derivativeFormats: [],
    });

    reports.push({
      source: path,
      imageId,
      width: decoded.width,
      height: decoded.height,
      keys,
      generatedWidths,
      generatedFormats,
      lqip: lqip !== null,
    });
  }

  return { records, reports, captured };
}

/* -------------------------------------------------------------------------- */
/* WhatsApp round trip                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Requirement 27.8: the enquiry link is generated **and decodes back** to the intended
 * message.
 *
 * Two decodes, not one, because they fail differently. `URLSearchParams` applies
 * `application/x-www-form-urlencoded` rules and turns a raw `+` into a space, so it catches
 * a message assembled with the wrong encoder; a plain `decodeURIComponent` of the raw query
 * segment catches double encoding, which is the classic defect here and the one
 * `URLSearchParams` would hide.
 */
export function assertWhatsAppRoundTrip(
  product: Product,
  settings: SiteSettings,
  siteUrl: string | undefined,
): { ok: true; urls: string[] } | RunFailure {
  const productUrl =
    siteUrl === undefined || siteUrl.trim() === ''
      ? undefined
      : `${siteUrl.replace(/\/+$/, '')}/product/${product.slug}`;

  const message = buildEnquiryMessage(
    {
      kind: 'product',
      productName: product.name,
      sku: product.sku,
      ...(productUrl === undefined ? {} : { productUrl }),
    },
    settings,
  );

  if (settings.whatsapp.length === 0) {
    return fieldFailure(
      'whatsapp',
      'data/site/settings.json lists no WhatsApp number, so no enquiry link can be generated.',
    );
  }

  const urls: string[] = [];
  for (const entry of settings.whatsapp) {
    const url = buildWhatsAppUrl(entry.e164, message);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return fieldFailure('whatsapp', `The enquiry link for ${entry.label} is not a valid URL.`);
    }
    if (parsed.host !== 'wa.me') {
      return fieldFailure(
        'whatsapp',
        `The enquiry link for ${entry.label} does not point at wa.me.`,
      );
    }
    if (parsed.pathname !== `/${toDigits(entry.e164)}`) {
      return fieldFailure(
        'whatsapp',
        `The enquiry link for ${entry.label} does not address that number's digits.`,
      );
    }
    if (parsed.searchParams.get('text') !== message) {
      return fieldFailure(
        'whatsapp',
        `The enquiry link for ${entry.label} does not decode back to the intended message.`,
      );
    }
    const rawQuery = url.slice(url.indexOf('?text=') + '?text='.length);
    if (decodeURIComponent(rawQuery) !== message) {
      return fieldFailure(
        'whatsapp',
        `The enquiry link for ${entry.label} is encoded more than once — a single decode must return the message.`,
      );
    }
    urls.push(url);
  }

  return { ok: true, urls };
}

/* -------------------------------------------------------------------------- */
/* Diff                                                                     */
/* -------------------------------------------------------------------------- */

/** A `git`-shaped unified diff for a newly added file. */
export function newFileDiff(path: string, contents: string): string {
  const lines = contents.replace(/\n$/, '').split('\n');
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${String(lines.length)} @@`,
    ...lines.map((line) => `+${line}`),
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* The command                                                               */
/* -------------------------------------------------------------------------- */

export interface RunOverrides {
  /** Pinned in tests so `createdAt`/`updatedAt` are reproducible. */
  now?: Date;
  /** Origin used for the enquiry link's product URL. Defaults to `PUBLIC_SITE_URL`. */
  siteUrl?: string;
}

export async function run(
  argv: readonly string[],
  overrides: RunOverrides = {},
): Promise<RunResult | 'help'> {
  const parsed = parseArgs(argv);
  if (parsed === 'help') return 'help';
  if ('ok' in parsed) return parsed;
  const options = parsed;

  const dataDir = resolve(options.dataDir);

  /* 1. The category must exist. Never created, and the valid slugs are listed. */
  const categories = await readCategories(dataDir);
  if (!categories.nameOf.has(options.category)) {
    const known = categories.slugs.length > 0 ? categories.slugs.join(', ') : '<none>';
    return fieldFailure(
      'category',
      `No category "${options.category}". Valid category slugs: ${known}. ` +
        'This command never creates a category — add data/categories/<slug>.json first.',
    );
  }

  /* 2. Identity, from the same generators the admin uses. */
  const taken = await readTakenIdentifiers(dataDir);
  const now = overrides.now ?? new Date();

  const input: ProductCreateInputValue = {
    ...options.fields,
    name: options.name,
    category: options.category,
  };

  let product = buildNewProduct(input, { taken, now });

  /* 3. Images: same validation, same derivative pipeline, real intrinsic dimensions. */
  let imageReports: ImageReport[] = [];
  let imageDestination: string | null = null;
  let captured: Map<string, { bytes: Uint8Array; contentType: string }> | null = null;

  if (options.images.length > 0) {
    let target: R2Target;
    if (options.dryRun) {
      // A dry run writes nothing anywhere. Derivatives are still encoded — into memory —
      // so the run really does verify the pipeline rather than merely claiming it would.
      target = {
        bucket: null,
        description:
          'nowhere — --dry-run: every derivative was encoded and verified in memory, and no object was written to any bucket or to disk.',
        dispose: () => Promise.resolve(),
      };
    } else if (options.r2 === 'local') {
      const opened = await openLocalR2();
      if ('ok' in opened) return opened;
      target = opened;
    } else {
      target = {
        bucket: null,
        description:
          'nowhere — --r2 none was requested, so no original and no derivative was written to any bucket.',
        dispose: () => Promise.resolve(),
      };
    }

    // Capture is needed whenever there is no bucket to prove the encode against, and
    // whenever the bytes have to reach `--images-out`.
    const needsCapture = options.imagesOut !== null || options.dryRun;

    try {
      const codec = await nodeCodec();
      const processed = await processImages({
        paths: options.images,
        alt: options.alt,
        productId: product.id,
        codec,
        bucket: target.bucket,
        capture: needsCapture ? new Map() : null,
      });
      if ('ok' in processed) return processed;

      imageReports = processed.reports;
      captured = options.imagesOut === null ? null : processed.captured;
      imageDestination = target.description;

      const images = processed.records.map((image, index) => ({ ...image, order: index }));
      product = {
        ...product,
        images,
        ...(images[0] === undefined ? {} : { primaryImage: images[0].id }),
      };
    } finally {
      await target.dispose();
    }
  }

  /* 4. Lifecycle. `normalizeProduct` keeps `published` mirroring `status`. */
  if (options.status !== 'DRAFT') {
    product = normalizeProduct({
      ...product,
      status: options.status,
      ...(options.status === 'OUT_OF_STOCK' ? { stockStatus: 'OUT_OF_STOCK' as const } : {}),
    });
  }

  /* 5. SEO fallbacks where none were supplied (Requirement 27.7).
   *
   * These are the *same* strings the render-time fallback chain would compute, so storing
   * them changes no output; what it buys is that the generated value is visible in the diff
   * the operator reviews. Both are set exactly as `buildNewProduct` would have set them had
   * they been supplied as input, and the input record is updated to match — which is what
   * keeps the admin creator byte-compatible for the same input. */
  if (product.seoTitle === undefined) {
    const generated = truncateAtWord(
      productTitleFallback(product, categories.nameOf.get(options.category)),
      SEO_TITLE_MAX,
    );
    product = { ...product, seoTitle: generated };
    input.seoTitle = generated;
  }
  if (product.seoDescription === undefined) {
    const generated = truncateAtWord(productDescriptionFallback(product), DESCRIPTION_MAX);
    product = { ...product, seoDescription: generated };
    input.seoDescription = generated;
  }

  /* 6. The canonical schema. */
  const validated = validateProduct(product);
  if (!validated.ok) {
    return {
      ok: false,
      message: 'The assembled product does not satisfy the product schema. Nothing was written.',
      fields: validated.fields,
    };
  }
  product = validated.product;

  /* 7. The publish gate, only when a public status was requested. */
  if (product.status === 'PUBLISHED' || product.status === 'OUT_OF_STOCK') {
    const gate = checkPublishGate(product);
    if (!gate.ok) {
      return {
        ok: false,
        message: `A ${product.status} product must pass the publish gate. Nothing was written.`,
        fields: gate.fields,
      };
    }
  }

  /* 8. The enquiry link builds and round-trips. */
  const settings = await readSettings(dataDir);
  if (settings === null) {
    return fieldFailure(
      'settings',
      `Could not read a valid ${join(options.dataDir, 'site', 'settings.json')}, so the WhatsApp enquiry link cannot be verified.`,
    );
  }
  const whatsapp = assertWhatsAppRoundTrip(
    product,
    settings,
    overrides.siteUrl ?? process.env.PUBLIC_SITE_URL,
  );
  if ('fields' in whatsapp) return whatsapp;

  /* 9. One file, at the path the admin's own allowlist resolves. */
  const path = productContentPath(product.slug);
  if (path === null) {
    return fieldFailure(
      'slug',
      `The generated slug "${product.slug}" does not resolve to an allowed content path.`,
    );
  }
  const absolutePath = join(dataDir, 'products', `${product.slug}.json`);
  const contents = serializeContentJson(product);

  if (taken.slugs.has(product.slug)) {
    return fieldFailure('slug', `Refusing to overwrite an existing product at ${path}.`);
  }

  if (!options.dryRun) {
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents, 'utf8');

    if (options.imagesOut !== null && captured !== null) {
      const outDir = resolve(options.imagesOut);
      for (const [key, object] of captured) {
        const file = join(outDir, key);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, object.bytes);
      }
    }
  }

  return {
    ok: true,
    path,
    absolutePath,
    contents,
    product,
    input,
    taken,
    now,
    written: !options.dryRun,
    images: imageReports,
    imageDestination,
    whatsappUrls: whatsapp.urls,
    diff: newFileDiff(path, contents),
  };
}

/* -------------------------------------------------------------------------- */
/* Reporting                                                                 */
/* -------------------------------------------------------------------------- */

function reportImages(result: RunSuccess): void {
  if (result.images.length === 0) {
    console.log('images: none supplied — the product has no media and cannot be published.');
    return;
  }

  console.log(`\nimages: ${String(result.images.length)} processed through the admin pipeline.`);
  for (const image of result.images) {
    const dims = `${String(image.width)}x${String(image.height)}`;
    const derivatives =
      image.generatedWidths.length === 0
        ? 'no derivatives generated'
        : `${String(image.generatedWidths.length)} width(s) x ${image.generatedFormats.join('/')} = ${String(image.keys.length - 1)} derivative object(s)`;
    console.log(
      `  ${image.source}\n    ${image.imageId}  intrinsic ${dims}  ${derivatives}  lqip: ${image.lqip ? 'inlined' : 'unavailable'}`,
    );
  }
  console.log(`\n  Objects were written to: ${result.imageDestination ?? 'nowhere'}`);
  console.log(
    '  The product record therefore carries derivativesReady: false with empty\n' +
      '  derivativeWidths/derivativeFormats. That is not a placeholder — it is the truth:\n' +
      '  this command reached no deployed bucket, so /img/** will serve the sanitized\n' +
      '  original (the designed pre-derivative behaviour) once the bytes are in place.\n' +
      '\n' +
      '  To put the bytes in the deployed bucket, re-run with --images-out <dir> and then,\n' +
      '  for each file in that directory:\n' +
      '      wrangler r2 object put ngf-media/<key> --file <dir>/<key> --remote \\\n' +
      '        --content-type <type> --cache-control "public, max-age=31536000, immutable"\n' +
      '  Uploading the same photographs through the admin instead is the only path that can\n' +
      '  legitimately flip derivativesReady, because it is the only one that writes to the\n' +
      '  bucket the deployment reads.',
  );
}

function reportSuccess(result: RunSuccess): void {
  console.log(result.diff);
  console.log('');
  console.log(
    result.written
      ? `product:add — wrote 1 file: ${result.path}`
      : `product:add — DRY RUN, nothing written. Would write 1 file: ${result.path}`,
  );
  console.log(
    `  id ${result.product.id}  sku ${result.product.sku}  slug ${result.product.slug}  status ${result.product.status}`,
  );
  console.log(`  seoTitle:       ${result.product.seoTitle ?? '<none>'}`);
  console.log(`  seoDescription: ${result.product.seoDescription ?? '<none>'}`);
  console.log(
    `  whatsapp: ${String(result.whatsappUrls.length)} enquiry link(s) built and round-tripped.`,
  );
  reportImages(result);
  console.log(
    '\nNo application source file was touched. The product page, category listing, search\n' +
      'index entry, sitemap entry and structured data all appear after the next build.',
  );
}

function reportFailure(result: RunFailure): void {
  console.error(`product:add — FAILED. ${result.message}`);
  const entries = Object.entries(result.fields);
  if (entries.length > 0) {
    for (const [field, messages] of entries) {
      for (const message of messages) console.error(`  ${field}: ${message}`);
    }
  }
  console.error('No content file was written.');
}

async function main(): Promise<void> {
  const result = await run(process.argv.slice(2));
  if (result === 'help') {
    console.log(USAGE);
    return;
  }
  if (result.ok) {
    reportSuccess(result);
    return;
  }
  reportFailure(result);
  process.exitCode = 1;
}

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].endsWith('add-product.ts');
if (invokedDirectly) {
  await main();
}
