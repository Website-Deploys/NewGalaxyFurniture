import type { KVNamespace } from '@cloudflare/workers-types';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  applyProductPatch,
  buildNewProduct,
  derivedDiscount,
  DRAFT_DESCRIPTION_PLACEHOLDER,
  normalizeProduct,
  ProductCreateInput,
  ProductPatchInput,
  proposedSlugFor,
  validateProduct,
} from '@/lib/products/input';
import { applyTransition } from '@/lib/products/transitions';
import { catalogueCounts, pageOfProducts, parseProductQuery } from '@/lib/products/query';
import {
  deleteProductState,
  getDraft,
  resolveProduct,
  saveProductState,
} from '@/lib/github/drafts';
import { duplicateProduct } from '@/lib/products/duplicate';
import { fieldIssues, isPublishReady, publishBlockers } from '@/lib/products/form-validation';
import { GitHubContentClient } from '@/lib/github/client';
import {
  listProductSummaries,
  readProductIndex,
  takenIdentifiers,
} from '@/lib/products/index-store';
import { productContentPath, siteContentPath } from '@/lib/github/paths';
import { renameProductState, withRenameRedirect } from '@/lib/github/rename';
import { GitHubApiStub, MemoryKV } from '../fixtures/github-api';
import { demoSofa } from '../fixtures/products';
import type { InteractiveActor } from '@/lib/auth/actor';
import type { Product } from '@/schemas/product';

/**
 * The admin product path, end to end over the real write pipeline.
 *
 * This is the checkpoint the plan asks for — create → draft save → preview resolution → publish
 * → unpublish → duplicate → delete — driven against a protocol-level GitHub stub and an
 * in-memory KV. The endpoints are thin wrappers over exactly these calls; what is exercised here
 * is every decision they delegate: identity generation, derived-field coherence, the publish
 * gate, the transition machine, the atomic rename, and the index the list and dashboard read.
 *
 * Requirements: 11.2, 11.3, 12.1–12.13, 13.9–13.13, 14.1–14.9.
 */

const OWNER = { email: 'owner@example.test', role: 'owner', sessionId: 's1' } as InteractiveActor;
const EDITOR = {
  email: 'editor@example.test',
  role: 'editor',
  sessionId: 's2',
} as InteractiveActor;

let stub: GitHubApiStub;
let client: GitHubContentClient;
let drafts: KVNamespace;

beforeEach(() => {
  stub = new GitHubApiStub({ files: { 'data/site/redirects.json': '{}\n' } });
  client = new GitHubContentClient({
    token: 'test-token',
    repo: stub.repo,
    branch: stub.branch,
    apiBase: 'https://api.github.com',
    fetchImpl: stub.fetch,
  });
  drafts = new MemoryKV() as unknown as KVNamespace;
});

/** The create endpoint's body, minus the HTTP. */
async function create(input: Record<string, unknown>): Promise<Product> {
  const parsed = ProductCreateInput.parse(input);
  const product = buildNewProduct(parsed, { taken: await takenIdentifiers(drafts) });
  const validated = validateProduct(product);
  expect(validated.ok).toBe(true);
  if (!validated.ok) throw new Error('unreachable');
  await saveProductState({
    drafts,
    client,
    product: validated.product,
    from: null,
    actor: OWNER,
    action: 'create',
  });
  return validated.product;
}

describe('create: the server owns identity, and a draft may be incomplete', () => {
  it('generates the id, slug and SKU from the name and category', async () => {
    const product = await create({ name: 'Luxury L-Shape Sofa', category: 'sofas' });

    expect(product.id).toMatch(/^p_[a-z0-9]{10}$/);
    expect(product.slug).toBe('luxury-l-shape-sofa');
    expect(product.sku).toMatch(/^NGF-SOF-[A-Z0-9]{6}$/);
    expect(product.status).toBe('DRAFT');
    expect(product.published).toBe(false);

    // Committed to the repository *and* kept in KV, with `[skip ci]` so a draft save does not
    // spend a production build.
    expect(stub.read(productContentPath('luxury-l-shape-sofa') ?? '')).not.toBeNull();
    expect(stub.lastCommit?.message).toContain('[skip ci]');
    expect(await getDraft(drafts, product.id)).not.toBeNull();
  });

  it('refuses to invent product copy, and keeps the record storable', async () => {
    const product = await create({ name: 'Accent Chair', category: 'accent-chairs' });
    // The one string the system writes into a product is visibly a to-do, and the publish gate
    // will not accept it as a description without the operator replacing it.
    expect(product.description).toBe(DRAFT_DESCRIPTION_PLACEHOLDER);
    expect(product.description).toContain('PLACEHOLDER');
  });

  it('never lets a create request set identity or lifecycle', () => {
    const rejected = ProductCreateInput.safeParse({
      name: 'Sofa',
      category: 'sofas',
      slug: 'chosen-by-the-client',
      status: 'PUBLISHED',
      published: true,
      discount: 90,
    });
    expect(rejected.success).toBe(false);
  });

  it('suffixes a colliding slug rather than overwriting the first product', async () => {
    const first = await create({ name: 'Teak Bed', category: 'beds' });
    const second = await create({ name: 'Teak Bed', category: 'beds' });
    expect(second.slug).toBe(`${first.slug}-2`);
    expect(stub.read(productContentPath(first.slug) ?? '')).not.toBeNull();
    expect(stub.read(productContentPath(second.slug) ?? '')).not.toBeNull();
  });
});

describe('derived fields cannot be authored', () => {
  it('computes the discount from the two prices', () => {
    expect(derivedDiscount(42_000, 52_500)).toBe(20);
    expect(derivedDiscount(42_000, 42_000)).toBeNull();
    expect(derivedDiscount(null, 52_500)).toBeNull();
  });

  it('ignores a discount supplied in a patch', () => {
    const rejected = ProductPatchInput.safeParse({
      patch: { discount: 90 },
      expectedUpdatedAt: demoSofa.updatedAt,
    });
    expect(rejected.success).toBe(false);
  });

  it('clears the price when price-on-enquiry is set, and recomputes the discount', () => {
    const patched = applyProductPatch(demoSofa, { priceOnEnquiry: true });
    expect(patched.price).toBeNull();
    expect(patched.originalPrice).toBeNull();
    expect(patched.discount).toBeNull();
    expect(validateProduct(patched).ok).toBe(true);
  });

  it('keeps an original price that does not exceed the price, so the schema reports the field', () => {
    const patched = applyProductPatch(demoSofa, { price: 60_000, originalPrice: 50_000 });
    const validated = validateProduct(patched);
    expect(validated.ok).toBe(false);
    if (!validated.ok) expect(Object.keys(validated.fields)).toContain('originalPrice');
  });

  it('renumbers image order contiguously and keeps the primary designation valid', () => {
    const shuffled = normalizeProduct({
      ...demoSofa,
      images: [
        { ...demoSofa.images[1]!, order: 7 },
        { ...demoSofa.images[0]!, order: 3 },
      ],
      primaryImage: 'img_notmine01',
    });
    expect(shuffled.images.map((image) => image.order)).toStrictEqual([0, 1]);
    expect(shuffled.primaryImage).toBe(shuffled.images[0]?.id);
    expect(validateProduct(shuffled).ok).toBe(true);
  });

  it('forces the made-to-order stock status', () => {
    const patched = applyProductPatch(demoSofa, { madeToOrder: true });
    expect(patched.stockStatus).toBe('MADE_TO_ORDER');
    expect(validateProduct(patched).ok).toBe(true);
  });
});

describe('the editor’s inline validation is the server’s validation', () => {
  it('reports the same field keys the API would return', () => {
    const broken: Product = { ...demoSofa, price: 60_000, originalPrice: 50_000 };

    const inline = fieldIssues(broken);
    const server = validateProduct(normalizeProduct(broken));
    expect(server.ok).toBe(false);
    if (server.ok) return;

    // Not "both report something" — the *same* keys, because they are the same code path.
    expect(Object.keys(inline).sort()).toStrictEqual(Object.keys(server.fields).sort());
    expect(Object.keys(inline)).toContain('originalPrice');
  });

  it('lists publish blockers against the fields that fail, for an incomplete draft', () => {
    const draft: Product = {
      ...demoSofa,
      status: 'DRAFT',
      published: false,
      images: [],
      description: 'Too short',
    };
    const blockers = publishBlockers(draft);
    expect(Object.keys(blockers)).toContain('images');
    expect(Object.keys(blockers)).toContain('description');
    expect(isPublishReady(draft)).toBe(false);
  });

  it('does not flag a short description while the product is still a draft', () => {
    const draft: Product = { ...demoSofa, status: 'DRAFT', published: false, description: 'Short' };
    expect(fieldIssues(draft).description).toBeUndefined();
  });

  it('reports no blockers for a complete product', () => {
    expect(publishBlockers(demoSofa)).toStrictEqual({});
    expect(isPublishReady(demoSofa)).toBe(true);
  });
});

describe('the lifecycle', () => {
  it('refuses to publish a product that fails the gate, naming the fields', async () => {
    const product = await create({ name: 'Bare Draft Sofa', category: 'sofas' });
    const outcome = applyTransition(product, 'PUBLISHED', OWNER);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('PUBLISH_GATE_FAILED');
    if (outcome.code !== 'PUBLISH_GATE_FAILED') return;
    expect(Object.keys(outcome.fields)).toContain('images');
    // Nothing was written: the repository still holds the draft.
    expect(stub.readJson(productContentPath(product.slug) ?? '')?.status).toBe('DRAFT');
  });

  it('publishes a complete product, deletes the draft, and triggers a build', async () => {
    // A complete draft: the demo fixture's content with a fresh identity.
    const product = await create({
      name: 'Complete Sofa',
      category: 'sofas',
      description: demoSofa.description,
      price: 42_000,
    });
    const withImages: Product = {
      ...product,
      images: demoSofa.images,
      primaryImage: demoSofa.images[0]?.id,
    };
    await saveProductState({
      drafts,
      client,
      product: withImages,
      from: 'DRAFT',
      actor: OWNER,
      action: 'update',
    });

    const outcome = applyTransition(withImages, 'PUBLISHED', OWNER);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.product.published).toBe(true);

    const result = await saveProductState({
      drafts,
      client,
      product: outcome.product,
      from: 'DRAFT',
      actor: OWNER,
      action: 'publish',
    });

    expect(result.deployTriggered).toBe(true);
    expect(stub.lastCommit?.message).not.toContain('[skip ci]');
    expect(stub.lastCommit?.message).toContain('Status: DRAFT -> PUBLISHED');
    expect(stub.lastCommit?.message).toContain('Actor: owner@example.test (owner)');
    // The KV working copy is gone: the repository is the source of truth for a live product.
    expect(await getDraft(drafts, product.id)).toBeNull();
    expect(stub.readJson(productContentPath(product.slug) ?? '')?.status).toBe('PUBLISHED');
  });

  it('refuses a publish by a role without publish permission', () => {
    const publish = applyTransition(
      { ...demoSofa, status: 'DRAFT', published: false },
      'PUBLISHED',
      EDITOR,
    );
    expect(publish.ok).toBe(false);
    if (!publish.ok) expect(publish.code).toBe('TRANSITION_NOT_ALLOWED');

    // The permission gate is on *public* targets only, so an editor may take a product off the
    // site — that is the machine the design declares, and it is the safe direction.
    expect(applyTransition(demoSofa, 'UNPUBLISHED', EDITOR).ok).toBe(true);
  });

  it('unpublishes and rebuilds, so the live page comes down', async () => {
    const outcome = applyTransition(demoSofa, 'UNPUBLISHED', OWNER);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const result = await saveProductState({
      drafts,
      client,
      product: outcome.product,
      from: 'PUBLISHED',
      actor: OWNER,
      action: 'unpublish',
    });
    expect(result.deployTriggered).toBe(true);
    expect(outcome.product.published).toBe(false);
  });

  it('marks out of stock and keeps the two status fields in step', () => {
    const outcome = applyTransition(demoSofa, 'OUT_OF_STOCK', OWNER);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.product.stockStatus).toBe('OUT_OF_STOCK');
    expect(outcome.product.published).toBe(true);
    expect(validateProduct(outcome.product).ok).toBe(true);
  });
});

describe('duplicate', () => {
  it('creates a new draft and leaves the source byte-identical', async () => {
    const source = await create({
      name: 'Original Sofa',
      category: 'sofas',
      description: demoSofa.description,
      price: 42_000,
    });
    const sourcePath = productContentPath(source.slug) ?? '';
    const sourceBytesBefore = stub.read(sourcePath);
    const snapshot = structuredClone(source);

    const copy = duplicateProduct(source, await takenIdentifiers(drafts));
    const validated = validateProduct(copy);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    await saveProductState({
      drafts,
      client,
      product: validated.product,
      from: null,
      actor: OWNER,
      action: 'duplicate',
    });

    expect(validated.product.id).not.toBe(source.id);
    expect(validated.product.sku).not.toBe(source.sku);
    expect(validated.product.slug).not.toBe(source.slug);
    expect(validated.product.status).toBe('DRAFT');
    expect(validated.product.published).toBe(false);

    // The source object was not mutated, and neither was its file.
    expect(source).toStrictEqual(snapshot);
    expect(stub.read(sourcePath)).toBe(sourceBytesBefore);
    expect(stub.read(productContentPath(validated.product.slug) ?? '')).not.toBeNull();

    // Both are in the index, so the list shows two products.
    expect(Object.keys(await readProductIndex(drafts))).toHaveLength(2);
  });
});

describe('rename', () => {
  it('writes the new file, deletes the old, and records the 301 in one commit', async () => {
    const product = await create({
      name: 'Walnut Coffee Table',
      category: 'coffee-side-tables',
      description: demoSofa.description,
      price: 18_000,
    });
    const oldPath = productContentPath(product.slug) ?? '';

    const taken = await takenIdentifiers(drafts, { exceptProductId: product.id });
    const proposed = proposedSlugFor(product, 'Walnut Coffee Table Mark II', taken);
    expect(proposed).toBe('walnut-coffee-table-mark-ii');

    const next: Product = { ...product, name: 'Walnut Coffee Table Mark II', slug: proposed! };
    const commitsBefore = stub.commits.length;
    const result = await renameProductState({
      drafts,
      client,
      current: product,
      next,
      actor: OWNER,
    });

    // One commit, three paths.
    expect(stub.commits.length).toBe(commitsBefore + 1);
    expect(stub.lastCommit?.kind).toBe('tree');
    expect(stub.lastCommit?.paths.sort()).toStrictEqual(
      [oldPath, productContentPath(proposed!) ?? '', siteContentPath('redirects') ?? ''].sort(),
    );
    expect(stub.read(oldPath)).toBeNull();
    expect(stub.read(productContentPath(proposed!) ?? '')).not.toBeNull();

    const redirects = stub.readJson(siteContentPath('redirects') ?? '');
    expect(redirects?.[`/product/${product.slug}`]).toBe(`/product/${proposed!}`);
    expect(result.redirect).toStrictEqual({
      from: `/product/${product.slug}`,
      to: `/product/${proposed!}`,
    });

    // The index follows the slug, so the resolver still finds the product by id.
    const resolved = await resolveProduct({ drafts, client }, product.id);
    expect(resolved?.product.slug).toBe(proposed);
  });

  it('proposes no rename when the name change does not move the slug', async () => {
    const product = await create({ name: 'Oak Sideboard', category: 'storage-display' });
    expect(product.slug).toBe('oak-sideboard');
    // Punctuation and case do not change the slug, so there is nothing to confirm and no
    // redirect to write.
    const taken = await takenIdentifiers(drafts, { exceptProductId: product.id });
    expect(proposedSlugFor(product, 'Oak Sideboard!', taken)).toBeNull();
    expect(proposedSlugFor(product, 'OAK  sideboard', taken)).toBeNull();
    expect(proposedSlugFor(product, 'Oak Sideboard Large', taken)).toBe('oak-sideboard-large');
  });

  it('collapses redirect chains and never points a URL at itself', () => {
    const chained = withRenameRedirect({ '/product/a': '/product/b' }, 'b', 'c');
    expect(chained).toStrictEqual({ '/product/a': '/product/c', '/product/b': '/product/c' });

    // A round trip back to `a` must not leave `/product/a → /product/a`.
    const roundTrip = withRenameRedirect({ '/product/a': '/product/b' }, 'b', 'a');
    expect(roundTrip['/product/a']).toBeUndefined();
    expect(roundTrip['/product/b']).toBe('/product/a');
  });
});

describe('delete', () => {
  it('removes the file, the draft and the index entry, and always rebuilds', async () => {
    const product = await create({ name: 'Doomed Sofa', category: 'sofas' });
    const path = productContentPath(product.slug) ?? '';
    expect(stub.read(path)).not.toBeNull();

    const result = await deleteProductState({ drafts, client, product, actor: OWNER });

    expect(result.deployTriggered).toBe(true);
    expect(stub.read(path)).toBeNull();
    expect(await getDraft(drafts, product.id)).toBeNull();
    expect(await readProductIndex(drafts)).toStrictEqual({});
    expect(stub.lastCommit?.message).not.toContain('[skip ci]');
    expect(stub.lastCommit?.message).toContain('Action: DELETE');
    // And it is no longer resolvable, so the editor shows a not-found state rather than a form.
    expect(await resolveProduct({ drafts, client }, product.id)).toBeNull();
  });
});

describe('the list and the dashboard read stored records only', () => {
  it('filters by status, category and text, and paginates deterministically', async () => {
    await create({ name: 'Alpha Sofa', category: 'sofas' });
    await create({ name: 'Beta Bed', category: 'beds' });
    await create({ name: 'Gamma Sofa', category: 'sofas' });

    const summaries = await listProductSummaries(drafts);
    expect(summaries).toHaveLength(3);

    expect(pageOfProducts(summaries, { category: 'sofas' }).total).toBe(2);
    expect(pageOfProducts(summaries, { status: 'DRAFT' }).total).toBe(3);
    expect(pageOfProducts(summaries, { status: 'PUBLISHED' }).total).toBe(0);
    expect(pageOfProducts(summaries, { q: 'beta' }).total).toBe(1);
    // Search folds diacritics and case.
    expect(pageOfProducts(summaries, { q: 'GAMMA' }).total).toBe(1);
    // A SKU search finds exactly its product.
    const sku = summaries[0]?.sku ?? '';
    expect(pageOfProducts(summaries, { q: sku }).total).toBe(1);

    const page = pageOfProducts(summaries, { page: 99 });
    expect(page.page).toBe(1);
    expect(page.items).toHaveLength(3);
  });

  it('parses a query string, ignoring anything unrecognised', () => {
    const query = parseProductQuery(
      new URLSearchParams('status=NONSENSE&category=&q=%20%20&page=-3&colour=red'),
    );
    expect(query).toStrictEqual({});
    expect(parseProductQuery(new URLSearchParams('status=DRAFT&page=2'))).toStrictEqual({
      status: 'DRAFT',
      page: 2,
    });
  });

  it('counts by status, and reports an empty catalogue as empty rather than as zeros', async () => {
    expect(catalogueCounts([]).total).toBe(0);

    await create({ name: 'Counted Sofa', category: 'sofas' });
    const counts = catalogueCounts(await listProductSummaries(drafts));
    expect(counts).toStrictEqual({
      published: 0,
      draft: 1,
      review: 0,
      unpublished: 0,
      outOfStock: 0,
      total: 1,
    });
  });
});
