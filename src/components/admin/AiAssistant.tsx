/**
 * The AI product assistant.
 *
 * The screen is deliberately two-phase, and the phases are not interchangeable:
 *
 * 1. **Facts.** The operator states what they know. Every field here is labelled as a fact, and
 *    the panel says plainly that anything left blank will be left blank in the result rather than
 *    guessed (Requirement 16.5). This is the only place a factual claim can enter.
 * 2. **Review.** Every suggested value arrives pre-filled and editable, each carrying a chip
 *    saying where it came from. Editing an `ai` field flips that field's provenance to `admin`
 *    and the chip disappears (Requirement 16.4) — the chip is bound to the provenance, not merely
 *    hidden, so what the stored `aiFields` records is what the operator saw.
 *
 * Three properties this component must not lose:
 *
 * - **Failure is a non-event.** A 503 leaves every typed fact intact and shows "Suggestions
 *   unavailable, continue manually", with a link to the manual form. The assistant is an
 *   accelerator, never a dependency (Requirement 16.12).
 * - **Nothing publishes.** Create sends `status`-free input to `POST /api/admin/products`, which
 *   always produces a `DRAFT`. There is no publish control on this screen at all
 *   (Requirement 16.11).
 * - **Warnings are shown in full, not summarised.** Every blanked field and every scrubbed claim
 *   the guard reported is listed, because the guard's value to the operator is that they can see
 *   what it caught (Requirements 16.5, 16.8).
 *
 * Requirements: 14.11, 16.1, 16.3, 16.4, 16.5, 16.8, 16.11, 16.12, 26.7, 26.9.
 */

import { useState } from 'react';
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
import { adminFetch, type FieldErrors } from '@/lib/admin/client';
import type { ProductDraftSuggestion, Suggested } from '@/lib/ai/fact-guard';
import type { StockStatusValue } from '@/schemas/product';
import Skeleton from '@/components/ui/Skeleton';

export interface AiAssistantProps {
  categories: readonly { slug: string; name: string }[];
  /** Draft products with images, so a suggestion can be based on real photographs. */
  productsWithImages: readonly {
    id: string;
    name: string;
    images: readonly { id: string; alt: string }[];
  }[];
  canWrite: boolean;
}

const STOCK_OPTIONS: readonly { value: StockStatusValue; label: string }[] = [
  { value: 'IN_STOCK', label: 'In stock' },
  { value: 'LIMITED_STOCK', label: 'Limited stock' },
  { value: 'OUT_OF_STOCK', label: 'Out of stock' },
  { value: 'MADE_TO_ORDER', label: 'Made to order' },
];

interface FactsDraft {
  rawNotes: string;
  name: string;
  category: string;
  price: number | null;
  priceOnEnquiry: boolean;
  material: string;
  color: string;
  availableColors: string[];
  dimensionsDisplay: string;
  size: string;
  stockStatus: StockStatusValue | '';
  madeToOrder: boolean;
  customization: string;
  deliveryInformation: string;
  adminTags: string[];
}

const EMPTY_FACTS: FactsDraft = {
  rawNotes: '',
  name: '',
  category: '',
  price: null,
  priceOnEnquiry: false,
  material: '',
  color: '',
  availableColors: [],
  dimensionsDisplay: '',
  size: '',
  stockStatus: '',
  madeToOrder: false,
  customization: '',
  deliveryInformation: '',
  adminTags: [],
};

/** The suggested values, as the review form holds them, with provenance per field. */
interface ReviewDraft {
  name: string;
  shortDescription: string;
  description: string;
  category: string;
  subcategory: string;
  styleTags: string[];
  features: string[];
  seoTitle: string;
  seoDescription: string;
  keywords: string[];
  whatsappText: string;
  alt: { imageId: string; alt: string }[];
}

type ReviewField = keyof Omit<ReviewDraft, 'alt'>;

/** The fields whose provenance the chip reports, and the label each shows. */
const REVIEW_FIELDS: readonly (readonly [ReviewField, string])[] = [
  ['name', 'Product name'],
  ['shortDescription', 'Short description'],
  ['description', 'Description'],
  ['category', 'Category'],
  ['subcategory', 'Subcategory'],
  ['styleTags', 'Style tags'],
  ['features', 'Features'],
  ['seoTitle', 'SEO title'],
  ['seoDescription', 'SEO description'],
  ['keywords', 'Keywords'],
  ['whatsappText', 'WhatsApp enquiry text'],
];

function reviewFrom(suggestion: ProductDraftSuggestion): ReviewDraft {
  return {
    name: suggestion.name.value,
    shortDescription: suggestion.shortDescription.value,
    description: suggestion.description.value,
    category: suggestion.category.value ?? '',
    subcategory: suggestion.subcategory.value ?? '',
    styleTags: suggestion.styleTags.value,
    features: suggestion.features.value,
    seoTitle: suggestion.seoTitle.value,
    seoDescription: suggestion.seoDescription.value,
    keywords: suggestion.keywords.value,
    whatsappText: suggestion.whatsappText.value,
    alt: suggestion.imageAltText.value.map((entry) => ({ ...entry })),
  };
}

/** The guard's per-field provenance, as the initial chip state. */
function provenanceFrom(suggestion: ProductDraftSuggestion): Record<ReviewField, string> {
  const read = (entry: Suggested<unknown>): string => entry.source;
  return {
    name: read(suggestion.name),
    shortDescription: read(suggestion.shortDescription),
    description: read(suggestion.description),
    category: read(suggestion.category),
    subcategory: read(suggestion.subcategory),
    styleTags: read(suggestion.styleTags),
    features: read(suggestion.features),
    seoTitle: read(suggestion.seoTitle),
    seoDescription: read(suggestion.seoDescription),
    keywords: read(suggestion.keywords),
    whatsappText: read(suggestion.whatsappText),
  };
}

/** The chip. Rendered only while a field's provenance is still the assistant's. */
function SuggestionChip({ provenance }: { provenance: string }): ReactElement | null {
  if (provenance !== 'ai' && provenance !== 'ai-derived-from-admin') return null;
  return (
    <span
      title="Suggested by the assistant. Edit the value and this becomes yours."
      className="ml-2 border border-champagne bg-cream px-2 py-0.5 text-small tracking-[0.1em] text-walnut uppercase"
    >
      AI suggestion
    </span>
  );
}

export default function AiAssistant(props: AiAssistantProps): ReactElement {
  const [facts, setFacts] = useState<FactsDraft>(EMPTY_FACTS);
  const [sourceProductId, setSourceProductId] = useState('');
  const [selectedImages, setSelectedImages] = useState<string[]>([]);

  const [review, setReview] = useState<ReviewDraft | null>(null);
  const [provenance, setProvenance] = useState<Record<ReviewField, string> | null>(null);
  const [warnings, setWarnings] = useState<readonly string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);

  const sourceProduct = props.productsWithImages.find((product) => product.id === sourceProductId);

  function updateFacts<K extends keyof FactsDraft>(key: K, value: FactsDraft[K]): void {
    setFacts((current) => ({ ...current, [key]: value }));
  }

  /** Edit a suggested value: the value changes and its provenance becomes the operator's. */
  function editReview(field: ReviewField, value: string | string[]): void {
    setReview((current) => (current === null ? null : { ...current, [field]: value }));
    setProvenance((current) => (current === null ? null : { ...current, [field]: 'admin' }));
  }

  /** The facts payload. Blank fields are omitted, which is what makes them "not supplied". */
  function factsPayload(): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    const text = (key: keyof FactsDraft, target = key): void => {
      const value = facts[key];
      if (typeof value === 'string' && value.trim() !== '') payload[target] = value.trim();
    };
    text('rawNotes');
    text('name');
    text('category');
    text('material');
    text('color');
    text('size');
    text('customization');
    text('deliveryInformation');
    if (facts.price !== null) payload.price = facts.price;
    if (facts.priceOnEnquiry) payload.priceOnEnquiry = true;
    if (facts.availableColors.length > 0) payload.availableColors = facts.availableColors;
    if (facts.dimensionsDisplay.trim() !== '') {
      payload.dimensions = { display: facts.dimensionsDisplay.trim() };
    }
    if (facts.stockStatus !== '') payload.stockStatus = facts.stockStatus;
    if (facts.madeToOrder) payload.madeToOrder = true;
    if (facts.adminTags.length > 0) payload.adminTags = facts.adminTags;
    return payload;
  }

  async function generate(): Promise<void> {
    setBusy(true);
    setUnavailable(false);
    setStatus(null);
    setErrors({});

    const result = await adminFetch<{
      suggestion: ProductDraftSuggestion;
      warnings: string[];
    }>('/api/admin/ai/generate', {
      method: 'POST',
      body: {
        facts: factsPayload(),
        ...(sourceProductId === '' ? {} : { productId: sourceProductId }),
        imageIds: selectedImages,
      },
    });
    setBusy(false);

    if (!result.ok) {
      // Every failure mode arrives as AI_UNAVAILABLE. The typed facts are untouched, which is
      // the whole of "the form stays fully usable".
      if (result.error.code === 'AI_UNAVAILABLE' || result.error.status === 503) {
        setUnavailable(true);
        setStatus(null);
        return;
      }
      setErrors(result.error.fields ?? {});
      setStatus(result.error.message);
      return;
    }

    setReview(reviewFrom(result.value.suggestion));
    setProvenance(provenanceFrom(result.value.suggestion));
    setWarnings(result.value.warnings);
    setStatus(
      'Suggestions ready. Every value is editable, and the badges show which came from the assistant. Read the notes below before saving.',
    );
  }

  /** Create the product as a DRAFT, recording which fields are still the assistant's. */
  async function create(): Promise<void> {
    if (review === null || provenance === null) return;
    setBusy(true);
    setErrors({});

    const aiFields = REVIEW_FIELDS.map(([field]) => field).filter(
      (field) => provenance[field] === 'ai' || provenance[field] === 'ai-derived-from-admin',
    );

    const payload: Record<string, unknown> = {
      name: review.name.trim(),
      category: review.category,
      description: review.description,
      shortDescription: review.shortDescription.trim() === '' ? null : review.shortDescription,
      subcategory: review.subcategory.trim() === '' ? null : review.subcategory,
      seoTitle: review.seoTitle.trim() === '' ? null : review.seoTitle,
      seoDescription: review.seoDescription.trim() === '' ? null : review.seoDescription,
      keywords: review.keywords,
      tags: review.styleTags,
      aiAssisted: true,
      aiFields,
    };
    // The facts, from the facts panel — not from the suggestion. The guard already ensured the
    // two agree, and sending the operator's own values is one fewer place for that to be untrue.
    if (facts.material.trim() !== '') payload.material = facts.material.trim();
    if (facts.color.trim() !== '') payload.color = facts.color.trim();
    if (facts.availableColors.length > 0) payload.availableColors = facts.availableColors;
    if (facts.size.trim() !== '') payload.size = facts.size.trim();
    if (facts.dimensionsDisplay.trim() !== '') {
      payload.dimensions = { display: facts.dimensionsDisplay.trim() };
    }
    if (facts.stockStatus !== '') payload.stockStatus = facts.stockStatus;
    if (facts.madeToOrder) payload.madeToOrder = true;
    if (facts.customization.trim() !== '') payload.customization = facts.customization.trim();
    if (facts.deliveryInformation.trim() !== '') {
      payload.deliveryInformation = facts.deliveryInformation.trim();
    }
    if (facts.price !== null) payload.price = facts.price;
    if (facts.priceOnEnquiry) payload.priceOnEnquiry = true;

    const result = await adminFetch<{ id: string; status: string }>('/api/admin/products', {
      method: 'POST',
      body: payload,
    });
    setBusy(false);

    if (!result.ok) {
      setErrors(result.error.fields ?? {});
      setStatus(result.error.message);
      return;
    }
    setCreatedId(result.value.id);
    setStatus(
      `Saved as a draft (${result.value.status}). Nothing is visible to visitors. Open it to add photographs, check every value, and publish when you are ready.`,
    );
  }

  const categoryOptions = props.categories.map((category) => ({
    value: category.slug,
    label: category.name,
  }));

  return (
    <div className="flex flex-col gap-8">
      {status !== null && (
        <p role="status" className="border border-taupe bg-white px-4 py-3 text-body">
          {status}
          {createdId !== null && (
            <>
              {' '}
              <a href={`/admin/products/${createdId}`} className="underline">
                Open the draft
              </a>
            </>
          )}
        </p>
      )}

      {unavailable && (
        <div role="alert" className="border border-espresso bg-white px-4 py-3">
          <p className="text-body text-espresso">Suggestions unavailable, continue manually.</p>
          <p className="mt-1 max-w-[70ch] text-small text-walnut">
            Everything you typed is still here. The assistant only ever drafts wording — every field
            it would have filled can be completed on the product form, and nothing about the product
            depends on it.
          </p>
          <a
            href="/admin/products/new"
            className="mt-3 inline-block min-h-[44px] border border-espresso px-4 py-2 text-espresso no-underline"
          >
            Create the product manually
          </a>
        </div>
      )}

      {/* ---- Phase 1: the facts ---------------------------------------------- */}
      <FormSection
        id="facts"
        title="What you know about this piece"
        description="These are the only facts the assistant may state. Anything you leave blank is left blank in the result and reported as unsupplied — it is never guessed from the photographs."
      >
        <Wide>
          <TextAreaField
            id="raw-notes"
            label="Notes"
            value={facts.rawNotes}
            rows={4}
            maxLength={4000}
            hint="Write freely: “modern beige 3-seater, fabric, 7 ft, beige/grey/brown”. Anything you state here counts as a fact you supplied."
            onChange={(value) => updateFacts('rawNotes', value)}
          />
        </Wide>
        <TextField
          id="fact-name"
          label="Product name (optional)"
          value={facts.name}
          maxLength={120}
          hint="Supply one and it is used exactly. Leave it blank for a suggestion."
          onChange={(value) => updateFacts('name', value)}
        />
        <SelectField
          id="fact-category"
          label="Category (optional)"
          value={facts.category}
          options={categoryOptions}
          placeholder="Let the assistant suggest one"
          onChange={(value) => updateFacts('category', value)}
        />
        <TextField
          id="fact-material"
          label="Material (optional)"
          value={facts.material}
          maxLength={120}
          hint="Blank means blank. The assistant cannot tell teak from a photograph."
          onChange={(value) => updateFacts('material', value)}
        />
        <TextField
          id="fact-color"
          label="Colour (optional)"
          value={facts.color}
          maxLength={60}
          onChange={(value) => updateFacts('color', value)}
        />
        <Wide>
          <ListField
            id="fact-colors"
            label="Available colours (optional)"
            values={facts.availableColors}
            onChange={(values) => updateFacts('availableColors', values)}
          />
        </Wide>
        <TextField
          id="fact-dimensions"
          label="Dimensions (optional)"
          value={facts.dimensionsDisplay}
          maxLength={120}
          hint="As you would write them, e.g. 7 ft × 3 ft × 2.5 ft."
          onChange={(value) => updateFacts('dimensionsDisplay', value)}
        />
        <TextField
          id="fact-size"
          label="Size (optional)"
          value={facts.size}
          maxLength={60}
          hint="e.g. 3 Seater, Queen."
          onChange={(value) => updateFacts('size', value)}
        />
        <NumberField
          id="fact-price"
          label="Price (optional)"
          value={facts.price}
          prefix="₹"
          hint="The assistant never states a price. Any price it writes is removed, and you are told."
          disabled={facts.priceOnEnquiry}
          onChange={(value) => updateFacts('price', value)}
        />
        <SelectField
          id="fact-stock"
          label="Stock status (optional)"
          value={facts.stockStatus}
          options={STOCK_OPTIONS}
          placeholder="Not supplied"
          onChange={(value) => updateFacts('stockStatus', value as StockStatusValue | '')}
        />
        <Wide>
          <CheckboxField
            id="fact-poe"
            label="Price on enquiry"
            checked={facts.priceOnEnquiry}
            onChange={(checked) => {
              updateFacts('priceOnEnquiry', checked);
              if (checked) updateFacts('price', null);
            }}
          />
        </Wide>
        <Wide>
          <CheckboxField
            id="fact-mto"
            label="Made to order"
            checked={facts.madeToOrder}
            onChange={(checked) => updateFacts('madeToOrder', checked)}
          />
        </Wide>
        <Wide>
          <TextAreaField
            id="fact-customization"
            label="Customisation (optional)"
            value={facts.customization}
            rows={2}
            maxLength={2000}
            onChange={(value) => updateFacts('customization', value)}
          />
        </Wide>
        <Wide>
          <TextAreaField
            id="fact-delivery"
            label="Delivery information (optional)"
            value={facts.deliveryInformation}
            rows={2}
            maxLength={2000}
            hint="Only what you actually promise. The assistant cannot invent a delivery time."
            onChange={(value) => updateFacts('deliveryInformation', value)}
          />
        </Wide>
        <Wide>
          <ListField
            id="fact-tags"
            label="Your own tags (optional)"
            values={facts.adminTags}
            hint="Comma-separated. These are added to the allowed vocabulary for this generation."
            onChange={(values) => updateFacts('adminTags', values)}
          />
        </Wide>
      </FormSection>

      {/* ---- Phase 1b: images ------------------------------------------------ */}
      <FormSection
        id="images"
        title="Photographs (optional)"
        description="Photographs already uploaded to an existing product can be analysed for shape, colour and arrangement. Upload first on the product’s own screen; the assistant reads, never writes."
      >
        <Wide>
          <SelectField
            id="image-source"
            label="Take photographs from"
            value={sourceProductId}
            options={props.productsWithImages.map((product) => ({
              value: product.id,
              label: `${product.name} (${String(product.images.length)} image${product.images.length === 1 ? '' : 's'})`,
            }))}
            placeholder="No photographs — work from the notes alone"
            onChange={(value) => {
              setSourceProductId(value);
              setSelectedImages([]);
            }}
          />
        </Wide>
        {sourceProduct !== undefined && (
          <Wide>
            <fieldset className="border border-taupe p-3">
              <legend className="px-2 text-small font-medium text-espresso">
                Images to analyse (up to 6)
              </legend>
              <ul className="flex flex-col">
                {sourceProduct.images.map((image) => (
                  <li key={image.id}>
                    <CheckboxField
                      id={`image-${image.id}`}
                      label={image.alt === '' ? image.id : `${image.id} — ${image.alt}`}
                      checked={selectedImages.includes(image.id)}
                      onChange={(checked) => {
                        setSelectedImages((current) =>
                          checked
                            ? [...current, image.id].slice(0, 6)
                            : current.filter((id) => id !== image.id),
                        );
                      }}
                    />
                  </li>
                ))}
              </ul>
            </fieldset>
          </Wide>
        )}
      </FormSection>

      {props.canWrite && (
        <div className="flex flex-wrap gap-3 border-t border-taupe pt-6">
          <button
            type="button"
            disabled={busy}
            onClick={() => void generate()}
            className="min-h-[44px] bg-espresso px-5 py-3 text-ivory disabled:opacity-50"
          >
            {busy ? 'Generating…' : review === null ? 'Generate suggestions' : 'Generate again'}
          </button>
          <a
            href="/admin/products/new"
            className="min-h-[44px] border border-espresso px-4 py-3 text-espresso no-underline"
          >
            Skip the assistant and fill the form myself
          </a>
        </div>
      )}

      {/*
        While a suggestion is being generated, the shape of the review panel that is coming
        (Requirement 26.12) — a heading line and a set of field rows — rather than a disabled button
        and empty space. The button already says "Generating…", which is what a screen reader needs;
        this is what the eye needs.
      */}
      {busy && review === null && (
        <section aria-labelledby="ai-generating" className="border border-taupe bg-white p-4">
          <h2 id="ai-generating" className="font-display text-h3 text-espresso">
            Generating suggestions
          </h2>
          <p className="mt-1 max-w-[75ch] text-small text-walnut">
            Every value it returns will be shown for review before anything is saved. The form below
            stays usable if this fails.
          </p>
          <Skeleton variant="text" count={4} lines={2} className="mt-4" />
        </section>
      )}

      {/* ---- Phase 2: review ------------------------------------------------- */}
      {review !== null && provenance !== null && (
        <>
          {warnings.length > 0 && (
            <section
              aria-labelledby="guard-warnings"
              className="border border-espresso bg-white p-4"
            >
              <h2 id="guard-warnings" className="font-display text-h3 text-espresso">
                What was blanked or removed
              </h2>
              <p className="mt-1 max-w-[75ch] text-small text-walnut">
                Every item below is something the assistant produced and the site refused to keep.
                This list is the whole of it — nothing was corrected silently.
              </p>
              <ul className="mt-3 flex flex-col gap-1">
                {warnings.map((warning) => (
                  <li key={warning} className="max-w-[75ch] text-small text-obsidian">
                    {warning}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <FormSection
            id="review"
            title="Review and edit"
            description="Everything here is editable. A badge means the value is still the assistant’s wording; edit it and the value becomes yours."
          >
            {REVIEW_FIELDS.filter(([field]) => field !== 'category').map(([field, label]) => {
              const value = review[field];
              const heading = (
                <>
                  {label}
                  <SuggestionChip provenance={provenance[field]} />
                </>
              );
              if (Array.isArray(value)) {
                return (
                  <Wide key={field}>
                    <ListField
                      id={`review-${field}`}
                      label={label}
                      values={value}
                      onChange={(values) => editReview(field, values)}
                      {...(errors[field] === undefined ? {} : { errors: errors[field] })}
                    />
                    <p className="text-small text-walnut">{heading}</p>
                  </Wide>
                );
              }
              const long = field === 'description' || field === 'whatsappText';
              const shared = {
                id: `review-${field}`,
                label,
                value,
                onChange: (next: string) => editReview(field, next),
                ...(errors[field] === undefined ? {} : { errors: errors[field] }),
              };
              return (
                <div key={field} className={long ? 'md:col-span-2' : undefined}>
                  {long ? (
                    <TextAreaField {...shared} rows={field === 'description' ? 6 : 3} />
                  ) : (
                    <TextField {...shared} />
                  )}
                  <p className="text-small text-walnut">{heading}</p>
                </div>
              );
            })}

            <Wide>
              <SelectField
                id="review-category"
                label="Category"
                value={review.category}
                options={categoryOptions}
                placeholder="Choose a category"
                required
                onChange={(value) => editReview('category', value)}
                {...(errors.category === undefined ? {} : { errors: errors.category })}
              />
              <p className="text-small text-walnut">
                Category
                <SuggestionChip provenance={provenance.category} />
                {review.category === '' &&
                  ' — none was assigned, so choose one. A product cannot be published without it.'}
              </p>
            </Wide>

            {review.alt.length > 0 && (
              <Wide>
                <fieldset className="border border-taupe p-3">
                  <legend className="px-2 text-small font-medium text-espresso">
                    Suggested image alt text
                  </legend>
                  <p className="mb-2 max-w-[70ch] text-small text-walnut">
                    Saved with the images on the product’s own screen, where each is marked as
                    assistant-written until you edit it. Alt text describes the photograph for
                    someone who cannot see it.
                  </p>
                  <ul className="flex flex-col gap-2">
                    {review.alt.map((entry, index) => (
                      <li key={entry.imageId}>
                        <TextField
                          id={`alt-${entry.imageId}`}
                          label={entry.imageId}
                          value={entry.alt}
                          maxLength={180}
                          onChange={(value) => {
                            setReview((current) =>
                              current === null
                                ? null
                                : {
                                    ...current,
                                    alt: current.alt.map((item, position) =>
                                      position === index ? { ...item, alt: value } : item,
                                    ),
                                  },
                            );
                          }}
                        />
                      </li>
                    ))}
                  </ul>
                </fieldset>
              </Wide>
            )}
          </FormSection>

          {props.canWrite && (
            <div className="flex flex-wrap gap-3 border-t border-taupe pt-6">
              <button
                type="button"
                disabled={busy || review.category === ''}
                onClick={() => void create()}
                className="min-h-[44px] bg-espresso px-5 py-3 text-ivory disabled:opacity-50"
              >
                {busy ? 'Saving…' : 'Save as a draft'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setReview(null);
                  setProvenance(null);
                  setWarnings([]);
                  setStatus('Suggestions discarded. Your facts are still here.');
                }}
                className="min-h-[44px] border border-espresso px-4 py-3 text-espresso"
              >
                Discard these suggestions
              </button>
              <p className="w-full text-small text-walnut">
                Saving creates a draft. Nothing on this screen can publish a product, and nothing
                you have not read will reach the site.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
