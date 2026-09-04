/**
 * The product editor — the admin surface that matters most.
 *
 * It is organised as the seven groups Requirement 13.1 names (Basic Information, Pricing,
 * Product, Inventory, Marketing, SEO, Images) because that is the order a person describes a
 * piece of furniture in, not because the schema is shaped that way. Everything on it is
 * completable without the AI assistant (13.12).
 *
 * The parts that are easy to get wrong and are deliberate here:
 *
 * - **Pricing is a single coherent control group.** Marking price-on-enquiry clears *and*
 *   disables the numeric price (13.11), and the discount is displayed read-only as a derived
 *   value (13.10) — there is no way to type a discount that the price does not support.
 * - **Errors are field-level and additive.** A failed save merges the server's `422 { fields }`
 *   into the same map the local validation writes to, so a message looks and reads identically
 *   whichever side produced it, and nothing else on the form is cleared (26.9).
 * - **Publish readiness is shown, not enforced by hiding.** The gate's failures appear as a
 *   checklist against the fields that fail, so "why can't I publish" is answerable without
 *   pressing Publish and being refused (14.5).
 * - **Saving is explicit and its result is honest.** The last-saved time comes from the
 *   record's own `updatedAt` after the server confirmed the commit (12.8) — never from a
 *   local clock at the moment of clicking.
 * - **A rename is a decision.** The server refuses a slug-changing rename until it is
 *   confirmed; the form surfaces that as a question naming both addresses (12.11, 12.12).
 *
 * Requirements: 12.1, 12.3, 12.8, 13.1–13.13, 14.4, 14.5, 24.8, 24.9, 26.9.
 */

import { useCallback, useMemo, useState } from 'react';
import type { ReactElement } from 'react';

import {
  CheckboxField,
  FormSection,
  ListField,
  NumberField,
  SelectField,
  TextAreaField,
  TextField,
  Wide,
} from './fields';
import { adminFetch, mergeFieldErrors, type FieldErrors } from '@/lib/admin/client';
import { derivedDiscount } from '@/lib/products/input';
import { fieldIssues, groupFor, labelFor, publishBlockers } from '@/lib/products/form-validation';
import { formatINR, PRICE_ON_ENQUIRY_LABEL } from '@/lib/money';
import ImageManager from './ImageManager';
import PublishPanel from './PublishPanel';
import type { Product, StockStatusValue } from '@/schemas/product';

export interface CategoryOption {
  slug: string;
  name: string;
  subcategories: readonly { slug: string; name: string }[];
}

export interface ProductFormProps {
  mode: 'create' | 'edit';
  /** For `edit`, the stored record. For `create`, a client-side skeleton. */
  product: Product;
  categories: readonly CategoryOption[];
  /** Hides every mutating control for a role without `product.write` (10.17). */
  canWrite: boolean;
  canPublish: boolean;
  canDelete: boolean;
}

const STOCK_OPTIONS: readonly { value: StockStatusValue; label: string }[] = [
  { value: 'IN_STOCK', label: 'In stock' },
  { value: 'LIMITED_STOCK', label: 'Limited stock' },
  { value: 'OUT_OF_STOCK', label: 'Out of stock' },
  { value: 'MADE_TO_ORDER', label: 'Made to order' },
];

/** The editable fields, as the API's patch shape. */
function patchFrom(draft: Product): Record<string, unknown> {
  return {
    name: draft.name,
    category: draft.category,
    subcategory: draft.subcategory ?? null,
    description: draft.description,
    shortDescription: draft.shortDescription ?? null,
    price: draft.price,
    priceOnEnquiry: draft.priceOnEnquiry,
    originalPrice: draft.originalPrice,
    material: draft.material ?? null,
    color: draft.color ?? null,
    availableColors: draft.availableColors,
    dimensions: draft.dimensions ?? null,
    size: draft.size ?? null,
    variants: draft.variants,
    customization: draft.customization ?? null,
    deliveryInformation: draft.deliveryInformation ?? null,
    stockStatus: draft.stockStatus,
    madeToOrder: draft.madeToOrder,
    featured: draft.featured,
    trending: draft.trending,
    bestSeller: draft.bestSeller,
    newArrival: draft.newArrival,
    tags: draft.tags,
    relatedProductIds: draft.relatedProductIds,
    seoTitle: draft.seoTitle ?? null,
    seoDescription: draft.seoDescription ?? null,
    keywords: draft.keywords,
    primaryImage: draft.primaryImage ?? null,
  };
}

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: string }
  | { kind: 'failed'; message: string }
  | { kind: 'conflict'; message: string; remote: Product | null }
  | { kind: 'rename'; message: string; proposedSlug: string };

export default function ProductForm(props: ProductFormProps): ReactElement {
  const [draft, setDraft] = useState<Product>(props.product);
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });

  const localErrors = useMemo(() => fieldIssues(draft), [draft]);
  const errors = useMemo(
    () => mergeFieldErrors(localErrors, serverErrors),
    [localErrors, serverErrors],
  );
  const blockers = useMemo(() => publishBlockers(draft), [draft]);

  const update = useCallback((patch: Partial<Product>) => {
    setDraft((current) => ({ ...current, ...patch }));
    // A server message about a field the operator is now editing is stale by definition.
    setServerErrors((current) => {
      const next = { ...current };
      for (const key of Object.keys(patch)) delete next[key];
      return next;
    });
    setSave((current) => (current.kind === 'saved' ? { kind: 'idle' } : current));
  }, []);

  const readOnly = !props.canWrite;

  const subcategoryOptions = useMemo(() => {
    const category = props.categories.find((entry) => entry.slug === draft.category);
    return (category?.subcategories ?? []).map((entry) => ({
      value: entry.slug,
      label: entry.name,
    }));
  }, [props.categories, draft.category]);

  const discount = derivedDiscount(
    draft.priceOnEnquiry ? null : draft.price,
    draft.priceOnEnquiry ? null : draft.originalPrice,
  );

  const doSave = useCallback(
    async (options: { confirmSlugChange?: boolean } = {}) => {
      setSave({ kind: 'saving' });
      setServerErrors({});

      if (props.mode === 'create') {
        const created = await adminFetch<{ id: string; slug: string; sku: string }>(
          '/api/admin/products',
          { method: 'POST', body: patchFrom(draft) },
        );
        if (!created.ok) {
          setServerErrors(created.error.fields ?? {});
          setSave({ kind: 'failed', message: created.error.message });
          return;
        }
        // The editor for a saved product is a different URL, and the operator should land
        // there — the record now has an id, a slug and a SKU it did not have a moment ago.
        window.location.assign(`/admin/products/${created.value.id}?created=1`);
        return;
      }

      const result = await adminFetch<{ product: Product; savedAt?: string }>(
        `/api/admin/products/${draft.id}`,
        {
          method: 'PATCH',
          body: {
            patch: patchFrom(draft),
            expectedUpdatedAt: draft.updatedAt,
            ...(options.confirmSlugChange === true ? { confirmSlugChange: true } : {}),
          },
        },
      );

      if (result.ok) {
        setDraft(result.value.product);
        setSave({ kind: 'saved', at: result.value.product.updatedAt });
        return;
      }

      setServerErrors(result.error.fields ?? {});
      if (result.error.code === 'CONFIRMATION_REQUIRED') {
        const remote = result.error.remote as { proposedSlug?: string } | undefined;
        setSave({
          kind: 'rename',
          message: result.error.message,
          proposedSlug: remote?.proposedSlug ?? '',
        });
        return;
      }
      if (result.error.code === 'CONFLICT') {
        setSave({
          kind: 'conflict',
          message: result.error.message,
          remote: (result.error.remote as Product | null) ?? null,
        });
        return;
      }
      setSave({ kind: 'failed', message: result.error.message });
    },
    [draft, props.mode],
  );

  const errorEntries = Object.entries(errors);

  return (
    <form
      className="flex flex-col gap-8"
      onSubmit={(event) => {
        event.preventDefault();
        void doSave();
      }}
    >
      {/* Save state, stated plainly and never optimistically. */}
      <div
        aria-live="polite"
        className="flex flex-wrap items-center justify-between gap-3 border border-taupe bg-white px-4 py-3"
      >
        <div className="text-small">
          {save.kind === 'saving' && <span>Saving…</span>}
          {save.kind === 'saved' && (
            <span>
              Draft saved at{' '}
              {new Date(save.at).toLocaleString('en-IN', {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </span>
          )}
          {save.kind === 'idle' && props.mode === 'edit' && (
            <span className="text-walnut">
              Last saved{' '}
              {new Date(draft.updatedAt).toLocaleString('en-IN', {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </span>
          )}
          {save.kind === 'idle' && props.mode === 'create' && (
            <span className="text-walnut">Not saved yet.</span>
          )}
          {save.kind === 'failed' && <span className="text-espresso">{save.message}</span>}
          {save.kind === 'conflict' && <span className="text-espresso">{save.message}</span>}
        </div>
        {!readOnly && (
          <button
            type="submit"
            disabled={save.kind === 'saving'}
            className="min-h-[44px] bg-espresso px-5 py-2 text-ivory hover:bg-obsidian focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-champagne disabled:opacity-60"
          >
            {props.mode === 'create' ? 'Create draft' : 'Save draft'}
          </button>
        )}
      </div>

      {save.kind === 'rename' && (
        <div className="border border-champagne bg-white px-4 py-3">
          <p className="text-body">{save.message}</p>
          <div className="mt-3 flex gap-3">
            <button
              type="button"
              onClick={() => void doSave({ confirmSlugChange: true })}
              className="min-h-[44px] bg-espresso px-4 py-2 text-ivory"
            >
              Rename and redirect the old address
            </button>
            <button
              type="button"
              onClick={() => setSave({ kind: 'idle' })}
              className="min-h-[44px] border border-espresso px-4 py-2 text-espresso"
            >
              Keep the current address
            </button>
          </div>
        </div>
      )}

      {save.kind === 'conflict' && save.remote !== null && (
        <div className="border border-espresso bg-white px-4 py-3">
          <p className="text-body">
            The stored copy was changed by someone else. Yours is still on screen — compare and
            decide.
          </p>
          <dl className="mt-2 grid gap-1 text-small md:grid-cols-2">
            <div>
              <dt className="text-walnut">Stored name</dt>
              <dd>{save.remote.name}</dd>
            </div>
            <div>
              <dt className="text-walnut">Stored price</dt>
              <dd>
                {save.remote.priceOnEnquiry || save.remote.price === null
                  ? PRICE_ON_ENQUIRY_LABEL
                  : formatINR(save.remote.price)}
              </dd>
            </div>
          </dl>
          <button
            type="button"
            onClick={() => {
              if (save.remote !== null) setDraft(save.remote);
              setSave({ kind: 'idle' });
            }}
            className="mt-3 min-h-[44px] border border-espresso px-4 py-2 text-espresso"
          >
            Discard mine and load the stored copy
          </button>
        </div>
      )}

      {errorEntries.length > 0 && (
        <div className="border border-espresso bg-white px-4 py-3">
          <h2 className="text-body font-medium text-espresso">These fields need attention</h2>
          <ul className="mt-2 flex flex-col gap-1 text-small">
            {errorEntries.map(([path, messages]) => (
              <li key={path}>
                <a href={`#${groupFor(path)}`} className="underline">
                  {labelFor(path)}
                </a>
                : {messages.join(' ')}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ---------------------------------------------------------------- Basic */}
      <FormSection
        id="basic"
        title="Basic information"
        description="What the product is called and how it is described. The name decides the web address."
      >
        <Wide>
          <TextField
            id="field-name"
            label="Product name"
            required
            value={draft.name}
            maxLength={120}
            disabled={readOnly}
            errors={errors.name}
            onChange={(value) => update({ name: value })}
          />
        </Wide>
        <SelectField
          id="field-category"
          label="Category"
          required
          value={draft.category}
          placeholder="Choose a category"
          disabled={readOnly}
          errors={errors.category}
          options={props.categories.map((entry) => ({ value: entry.slug, label: entry.name }))}
          onChange={(value) => update({ category: value, subcategory: undefined })}
        />
        <SelectField
          id="field-subcategory"
          label="Subcategory"
          value={draft.subcategory ?? ''}
          placeholder={subcategoryOptions.length === 0 ? 'None for this category' : 'Optional'}
          disabled={readOnly || subcategoryOptions.length === 0}
          errors={errors.subcategory}
          options={subcategoryOptions}
          onChange={(value) => update({ subcategory: value === '' ? undefined : value })}
        />
        <Wide>
          <TextAreaField
            id="field-description"
            label="Description"
            required
            rows={7}
            value={draft.description}
            maxLength={6000}
            disabled={readOnly}
            errors={errors.description}
            hint="At least 20 characters are required to publish."
            onChange={(value) => update({ description: value })}
          />
        </Wide>
        <Wide>
          <TextAreaField
            id="field-shortDescription"
            label="Short description"
            rows={2}
            value={draft.shortDescription ?? ''}
            maxLength={240}
            disabled={readOnly}
            errors={errors.shortDescription}
            hint="Used on cards and in search results. Up to 240 characters."
            onChange={(value) => update({ shortDescription: value === '' ? undefined : value })}
          />
        </Wide>
      </FormSection>

      {/* -------------------------------------------------------------- Pricing */}
      <FormSection
        id="pricing"
        title="Pricing"
        description="Either a price or price-on-enquiry. A strike-through price must be higher than the price you are charging."
      >
        <Wide>
          <CheckboxField
            id="field-priceOnEnquiry"
            label="Price on enquiry"
            checked={draft.priceOnEnquiry}
            disabled={readOnly}
            hint={`Shows “${PRICE_ON_ENQUIRY_LABEL}” instead of an amount, and clears the price.`}
            onChange={(checked) =>
              update(
                checked
                  ? { priceOnEnquiry: true, price: null, originalPrice: null, discount: null }
                  : { priceOnEnquiry: false },
              )
            }
          />
        </Wide>
        <NumberField
          id="field-price"
          label="Price"
          prefix="₹"
          value={draft.price}
          disabled={readOnly || draft.priceOnEnquiry}
          errors={errors.price}
          hint={draft.priceOnEnquiry ? 'Disabled while price-on-enquiry is on.' : 'Whole rupees.'}
          onChange={(value) => update({ price: value })}
        />
        <NumberField
          id="field-originalPrice"
          label="Original price (strike-through)"
          prefix="₹"
          value={draft.originalPrice}
          disabled={readOnly || draft.priceOnEnquiry}
          errors={errors.originalPrice}
          hint="Leave empty if this product is not discounted."
          onChange={(value) => update({ originalPrice: value })}
        />
        <div className="flex flex-col gap-1">
          <span className="text-small font-medium text-espresso">Discount</span>
          <p className="min-h-[44px] border border-dashed border-taupe px-3 py-2 text-body text-walnut">
            {discount === null
              ? 'No discount — set an original price higher than the price.'
              : `${String(discount)}% off ${formatINR(draft.originalPrice ?? 0)}`}
          </p>
          <p className="text-small text-walnut">
            Calculated from the two prices. It cannot be typed in, so a displayed discount is always
            real.
          </p>
        </div>
      </FormSection>

      {/* -------------------------------------------------------------- Product */}
      <FormSection
        id="product"
        title="Product"
        description="Materials, finish, size and what a customer can have changed."
      >
        <TextField
          id="field-material"
          label="Material"
          value={draft.material ?? ''}
          maxLength={120}
          disabled={readOnly}
          errors={errors.material}
          onChange={(value) => update({ material: value === '' ? undefined : value })}
        />
        <TextField
          id="field-color"
          label="Colour"
          value={draft.color ?? ''}
          maxLength={60}
          disabled={readOnly}
          errors={errors.color}
          onChange={(value) => update({ color: value === '' ? undefined : value })}
        />
        <ListField
          id="field-availableColors"
          label="Available colours"
          values={draft.availableColors}
          disabled={readOnly}
          errors={errors.availableColors}
          onChange={(values) => update({ availableColors: values })}
        />
        <TextField
          id="field-size"
          label="Size"
          value={draft.size ?? ''}
          maxLength={60}
          disabled={readOnly}
          errors={errors.size}
          hint="Free text, e.g. “3 Seater” or “Queen”."
          onChange={(value) => update({ size: value === '' ? undefined : value })}
        />
        <NumberField
          id="field-length"
          label="Length (cm)"
          value={draft.dimensions?.lengthCm ?? null}
          disabled={readOnly}
          errors={errors['dimensions.lengthCm']}
          onChange={(value) =>
            update({
              dimensions: {
                ...draft.dimensions,
                ...(value === null ? { lengthCm: undefined } : { lengthCm: value }),
              },
            })
          }
        />
        <NumberField
          id="field-width"
          label="Width (cm)"
          value={draft.dimensions?.widthCm ?? null}
          disabled={readOnly}
          errors={errors['dimensions.widthCm']}
          onChange={(value) =>
            update({
              dimensions: {
                ...draft.dimensions,
                ...(value === null ? { widthCm: undefined } : { widthCm: value }),
              },
            })
          }
        />
        <NumberField
          id="field-height"
          label="Height (cm)"
          value={draft.dimensions?.heightCm ?? null}
          disabled={readOnly}
          errors={errors['dimensions.heightCm']}
          onChange={(value) =>
            update({
              dimensions: {
                ...draft.dimensions,
                ...(value === null ? { heightCm: undefined } : { heightCm: value }),
              },
            })
          }
        />
        <NumberField
          id="field-depth"
          label="Depth (cm)"
          value={draft.dimensions?.depthCm ?? null}
          disabled={readOnly}
          errors={errors['dimensions.depthCm']}
          onChange={(value) =>
            update({
              dimensions: {
                ...draft.dimensions,
                ...(value === null ? { depthCm: undefined } : { depthCm: value }),
              },
            })
          }
        />
        <Wide>
          <TextField
            id="field-dimensionsDisplay"
            label="Dimensions as written on the page"
            value={draft.dimensions?.display ?? ''}
            maxLength={120}
            disabled={readOnly}
            errors={errors['dimensions.display']}
            hint="Optional. Shown to customers as typed, e.g. “7 ft × 3 ft × 2.5 ft”."
            onChange={(value) =>
              update({
                dimensions: {
                  ...draft.dimensions,
                  ...(value === '' ? { display: undefined } : { display: value }),
                },
              })
            }
          />
        </Wide>
        <Wide>
          <TextAreaField
            id="field-customization"
            label="Customization"
            rows={3}
            value={draft.customization ?? ''}
            maxLength={2000}
            disabled={readOnly}
            errors={errors.customization}
            hint="What a customer can change: size, fabric, finish, configuration."
            onChange={(value) => update({ customization: value === '' ? undefined : value })}
          />
        </Wide>
        <Wide>
          <TextAreaField
            id="field-deliveryInformation"
            label="Delivery information"
            rows={3}
            value={draft.deliveryInformation ?? ''}
            maxLength={2000}
            disabled={readOnly}
            errors={errors.deliveryInformation}
            hint="Only what you can commit to. Do not state a delivery time you cannot honour."
            onChange={(value) => update({ deliveryInformation: value === '' ? undefined : value })}
          />
        </Wide>
        <Wide>
          <VariantEditor
            variants={draft.variants}
            disabled={readOnly}
            onChange={(variants) => update({ variants })}
          />
        </Wide>
      </FormSection>

      {/* ------------------------------------------------------------ Inventory */}
      <FormSection
        id="inventory"
        title="Inventory"
        description="Availability as customers will see it."
      >
        <SelectField
          id="field-stockStatus"
          label="Stock status"
          required
          value={draft.stockStatus}
          disabled={readOnly || draft.madeToOrder}
          errors={errors.stockStatus}
          options={STOCK_OPTIONS}
          hint={
            draft.madeToOrder
              ? 'Fixed to “Made to order” while made-to-order is on.'
              : 'Marking a product out of stock here does not unpublish it — use the status controls for that.'
          }
          onChange={(value) => update({ stockStatus: value as StockStatusValue })}
        />
        <CheckboxField
          id="field-madeToOrder"
          label="Made to order"
          checked={draft.madeToOrder}
          disabled={readOnly}
          hint="Sets the stock status to “Made to order”."
          onChange={(checked) =>
            update(
              checked
                ? { madeToOrder: true, stockStatus: 'MADE_TO_ORDER' }
                : { madeToOrder: false, stockStatus: 'IN_STOCK' },
            )
          }
        />
      </FormSection>

      {/* ------------------------------------------------------------ Marketing */}
      <FormSection
        id="marketing"
        title="Marketing"
        description="Where this product is highlighted, and what it is grouped with."
      >
        <CheckboxField
          id="field-featured"
          label="Featured"
          checked={draft.featured}
          disabled={readOnly}
          onChange={(checked) => update({ featured: checked })}
        />
        <CheckboxField
          id="field-trending"
          label="Trending"
          checked={draft.trending}
          disabled={readOnly}
          onChange={(checked) => update({ trending: checked })}
        />
        <CheckboxField
          id="field-bestSeller"
          label="Best seller"
          checked={draft.bestSeller}
          disabled={readOnly}
          onChange={(checked) => update({ bestSeller: checked })}
        />
        <CheckboxField
          id="field-newArrival"
          label="New arrival"
          checked={draft.newArrival}
          disabled={readOnly}
          onChange={(checked) => update({ newArrival: checked })}
        />
        <Wide>
          <ListField
            id="field-tags"
            label="Tags"
            values={draft.tags}
            disabled={readOnly}
            errors={errors.tags}
            onChange={(values) => update({ tags: values })}
          />
        </Wide>
        <Wide>
          <ListField
            id="field-relatedProductIds"
            label="Related products"
            values={draft.relatedProductIds}
            disabled={readOnly}
            errors={errors.relatedProductIds}
            hint="Product identifiers, separated by commas. Leave empty to let the site choose."
            onChange={(values) => update({ relatedProductIds: values })}
          />
        </Wide>
      </FormSection>

      {/* ------------------------------------------------------------------ SEO */}
      <FormSection
        id="seo"
        title="Search engines"
        description="Leave these empty and the site generates them from the product name and description."
      >
        <Wide>
          <TextField
            id="field-seoTitle"
            label="SEO title"
            value={draft.seoTitle ?? ''}
            maxLength={70}
            disabled={readOnly}
            errors={errors.seoTitle}
            hint="Up to 70 characters."
            onChange={(value) => update({ seoTitle: value === '' ? undefined : value })}
          />
        </Wide>
        <Wide>
          <TextAreaField
            id="field-seoDescription"
            label="SEO description"
            rows={2}
            value={draft.seoDescription ?? ''}
            maxLength={170}
            disabled={readOnly}
            errors={errors.seoDescription}
            hint="Up to 170 characters."
            onChange={(value) => update({ seoDescription: value === '' ? undefined : value })}
          />
        </Wide>
        <Wide>
          <ListField
            id="field-keywords"
            label="Keywords"
            values={draft.keywords}
            disabled={readOnly}
            errors={errors.keywords}
            onChange={(values) => update({ keywords: values })}
          />
        </Wide>
      </FormSection>

      {/* --------------------------------------------------------------- Images */}
      <FormSection
        id="images"
        title="Images"
        description="Up to 20 photographs. The first image is used on cards and as the main product photograph unless you choose another."
        status={
          errors.images === undefined ? undefined : (
            <span className="text-small text-espresso">{errors.images.join(' ')}</span>
          )
        }
      >
        <Wide>
          {props.mode === 'create' ? (
            <p className="border border-dashed border-taupe px-4 py-6 text-small text-walnut">
              Create the draft first — photographs are attached to a saved product.
            </p>
          ) : (
            <ImageManager
              productId={draft.id}
              images={draft.images}
              primaryImage={draft.primaryImage ?? null}
              canWrite={props.canWrite}
              onChange={(images, primaryImage) =>
                setDraft((current) => ({
                  ...current,
                  images,
                  ...(primaryImage === null ? {} : { primaryImage }),
                }))
              }
            />
          )}
        </Wide>
      </FormSection>

      {/* ------------------------------------------------------------ Lifecycle */}
      {props.mode === 'edit' && (
        <FormSection
          id="lifecycle"
          title="Status and publishing"
          description="Save your edits first — publishing acts on the stored draft."
        >
          <Wide>
            <PublishPanel
              product={draft}
              blockers={blockers}
              canPublish={props.canPublish}
              canWrite={props.canWrite}
              canDelete={props.canDelete}
              onProduct={(next) => setDraft(next)}
            />
          </Wide>
        </FormSection>
      )}
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* Variants                                                                   */
/* -------------------------------------------------------------------------- */

interface VariantEditorProps {
  variants: Product['variants'];
  disabled: boolean;
  onChange: (variants: Product['variants']) => void;
}

/**
 * A fresh variant id, from WebCrypto only.
 *
 * This id is persisted in the product file and is what a variant-level SKU and stock status hang
 * off, so it is a real identifier rather than a render key. `Math.random` is not used even here:
 * the admin runs in a browser that has `crypto.getRandomValues` in every context, and having one
 * identifier in the codebase minted from a weaker source is exactly the inconsistency a reviewer
 * has to re-audit later.
 */
function newVariantId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `var_${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Variants: a label, an optional SKU, and a price difference.
 *
 * `priceDelta` rather than an absolute price, matching the schema — a variant that costs
 * ₹4,000 more stays correct when the base price changes, which an absolute price would not.
 */
function VariantEditor({ variants, disabled, onChange }: VariantEditorProps): ReactElement {
  return (
    <fieldset className="border border-taupe p-4">
      <legend className="px-1 text-small font-medium text-espresso">Variants</legend>
      {variants.length === 0 && (
        <p className="text-small text-walnut">
          No variants. Add one for each size or configuration a customer can choose.
        </p>
      )}
      <ul className="flex flex-col gap-3">
        {variants.map((variant, index) => (
          <li key={variant.id} className="grid gap-2 md:grid-cols-[2fr_2fr_1fr_auto]">
            <TextField
              id={`variant-${variant.id}-label`}
              label="Label"
              value={variant.label}
              disabled={disabled}
              onChange={(value) => {
                const next = [...variants];
                next[index] = { ...variant, label: value };
                onChange(next);
              }}
            />
            <TextField
              id={`variant-${variant.id}-sku`}
              label="Variant SKU"
              value={variant.sku ?? ''}
              disabled={disabled}
              onChange={(value) => {
                const next = [...variants];
                next[index] = {
                  ...variant,
                  ...(value === '' ? { sku: undefined } : { sku: value }),
                };
                onChange(next);
              }}
            />
            <NumberField
              id={`variant-${variant.id}-delta`}
              label="Price difference"
              prefix="₹"
              value={variant.priceDelta ?? null}
              disabled={disabled}
              onChange={(value) => {
                const next = [...variants];
                next[index] = {
                  ...variant,
                  ...(value === null ? { priceDelta: undefined } : { priceDelta: value }),
                };
                onChange(next);
              }}
            />
            {!disabled && (
              <button
                type="button"
                className="min-h-[44px] self-end border border-espresso px-3 py-2 text-small text-espresso"
                onClick={() => onChange(variants.filter((entry) => entry.id !== variant.id))}
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      {!disabled && (
        <button
          type="button"
          className="mt-3 min-h-[44px] border border-espresso px-4 py-2 text-small text-espresso"
          onClick={() => onChange([...variants, { id: newVariantId(), label: '' }])}
        >
          Add a variant
        </button>
      )}
    </fieldset>
  );
}
