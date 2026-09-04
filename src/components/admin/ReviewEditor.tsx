/**
 * Review management: add, edit, delete, publish, unpublish, feature, reorder.
 *
 * The one thing this component must never do is help. There is no suggested wording, no
 * "generate a testimonial", no default rating, no pre-filled date, and no AI affordance
 * anywhere on this screen (Requirement 18.9) — a review is a customer's words or it is
 * nothing. The rating control starts empty rather than at 5, because a default is an
 * invented value the operator might not notice.
 *
 * Publication is a separate control from Save, and the list says in words what each status
 * means for a visitor, so "saved" is never mistaken for "live" (Requirement 18.8).
 *
 * Review media (`customerPhotoKey`, `productPhotoKey`, `videoKey`) are shown as read-only
 * object keys with an explicit note: the design declares no upload endpoint for review media
 * and `/img/**` resolves only product image keys, so there is nothing to upload into yet.
 * An input that appeared to accept a photograph and then silently dropped it would be worse
 * than saying so.
 *
 * Requirements: 18.6, 18.7, 18.8, 18.9, 10.17, 24.5, 26.9, 26.14.
 */

import { useState } from 'react';
import type { ReactElement } from 'react';

import { adminFetch, type FieldErrors } from '@/lib/admin/client';
import { CheckboxField, NumberField, SelectField, TextAreaField, TextField } from './fields';
import type { Review, ReviewStatusValue } from '@/schemas/review';
import EmptyState from '@/components/ui/EmptyState';

export interface ReviewEditorProps {
  reviews: readonly Review[];
  /** For the optional product link — id and name, from the admin product index. */
  products: readonly { id: string; name: string }[];
  canWrite: boolean;
  canDelete: boolean;
}

interface Draft {
  customerName: string;
  rating: number | null;
  text: string;
  productId: string;
  date: string;
  featured: boolean;
}

const EMPTY_DRAFT: Draft = {
  customerName: '',
  rating: null,
  text: '',
  productId: '',
  date: '',
  featured: false,
};

/**
 * What the editor pane is currently editing.
 *
 * A tagged union rather than `string | 'new'`, which is just `string`: the sentinel has to
 * stay distinguishable from a review id, and a widened union would silently route a review
 * whose id happened to be `new` into the create path.
 */
type EditTarget = { mode: 'new' } | { mode: 'edit'; id: string };

const STATUS_MEANING: Record<ReviewStatusValue, string> = {
  DRAFT: 'Draft — not visible to visitors',
  PUBLISHED: 'Published — visible on the site after the next build',
  UNPUBLISHED: 'Unpublished — was live, now hidden',
};

function draftOf(review: Review): Draft {
  return {
    customerName: review.customerName,
    rating: review.rating,
    text: review.text,
    productId: review.productId ?? '',
    date: review.date ?? '',
    featured: review.featured,
  };
}

export default function ReviewEditor(props: ReviewEditorProps): ReactElement {
  const [rows, setRows] = useState<readonly Review[]>(props.reviews);
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const productOptions = props.products.map((product) => ({
    value: product.id,
    label: product.name,
  }));

  async function reload(): Promise<void> {
    const result = await adminFetch<{ reviews: Review[] }>('/api/admin/reviews');
    if (result.ok) setRows(result.value.reviews);
  }

  function payload(): Record<string, unknown> {
    return {
      customerName: draft.customerName.trim(),
      rating: draft.rating,
      text: draft.text.trim(),
      productId: draft.productId === '' ? null : draft.productId,
      date: draft.date === '' ? null : draft.date,
      featured: draft.featured,
    };
  }

  async function create(): Promise<void> {
    setBusy(true);
    setErrors({});
    const result = await adminFetch<{ id: string }>('/api/admin/reviews', {
      method: 'POST',
      body: payload(),
    });
    setBusy(false);
    if (!result.ok) {
      setStatus(result.error.message);
      setErrors(result.error.fields ?? {});
      return;
    }
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setStatus('Review saved as a draft. It is not visible to visitors until you publish it.');
    await reload();
  }

  async function save(id: string): Promise<void> {
    setBusy(true);
    setErrors({});
    const result = await adminFetch<unknown>(`/api/admin/reviews/${id}`, {
      method: 'PATCH',
      body: { patch: payload() },
    });
    setBusy(false);
    if (!result.ok) {
      setStatus(result.error.message);
      setErrors(result.error.fields ?? {});
      return;
    }
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setStatus('Review saved. Its published state is unchanged.');
    await reload();
  }

  async function setStatusOf(review: Review, next: ReviewStatusValue): Promise<void> {
    setBusy(true);
    const result = await adminFetch<unknown>(`/api/admin/reviews/${review.id}`, {
      method: 'PATCH',
      body: { patch: {}, status: next },
    });
    setBusy(false);
    if (!result.ok) {
      setStatus(result.error.message);
      return;
    }
    setStatus(
      next === 'PUBLISHED'
        ? `Published. The review appears on the site after the next build.`
        : `Hidden. The review comes off the site after the next build.`,
    );
    await reload();
  }

  async function setFeatured(review: Review, featured: boolean): Promise<void> {
    setBusy(true);
    const result = await adminFetch<unknown>(`/api/admin/reviews/${review.id}`, {
      method: 'PATCH',
      body: { patch: { featured } },
    });
    setBusy(false);
    if (!result.ok) {
      setStatus(result.error.message);
      return;
    }
    await reload();
  }

  async function move(index: number, delta: number): Promise<void> {
    const target = index + delta;
    if (target < 0 || target >= rows.length) return;
    const order = rows.map((row) => row.id);
    const moved = order[index];
    const displaced = order[target];
    if (moved === undefined || displaced === undefined) return;
    order[index] = displaced;
    order[target] = moved;

    setBusy(true);
    const result = await adminFetch<unknown>('/api/admin/reviews', {
      method: 'PATCH',
      body: { order },
    });
    setBusy(false);
    if (!result.ok) {
      setStatus(result.error.message);
      return;
    }
    setStatus('Order saved.');
    await reload();
  }

  async function remove(id: string): Promise<void> {
    setBusy(true);
    const result = await adminFetch<unknown>(`/api/admin/reviews/${id}`, {
      method: 'DELETE',
      body: { confirmId: id },
    });
    setBusy(false);
    if (!result.ok) {
      setStatus(result.error.message);
      setErrors(result.error.fields ?? {});
      return;
    }
    setConfirmDelete(null);
    setStatus('Review deleted.');
    await reload();
  }

  const form = (
    <div className="mt-4 grid gap-4 md:grid-cols-2">
      <TextField
        id="review-name"
        label="Customer name"
        value={draft.customerName}
        onChange={(customerName) => setDraft({ ...draft, customerName })}
        required
        maxLength={80}
        hint="As the customer gave it. Never shortened, expanded or invented."
        {...(errors.customerName === undefined ? {} : { errors: errors.customerName })}
      />
      <NumberField
        id="review-rating"
        label="Rating (1–5)"
        value={draft.rating}
        onChange={(rating) => setDraft({ ...draft, rating })}
        min={1}
        hint="Left empty until you enter the rating the customer gave."
        {...(errors.rating === undefined ? {} : { errors: errors.rating })}
      />
      <div className="md:col-span-2">
        <TextAreaField
          id="review-text"
          label="Review text"
          value={draft.text}
          onChange={(text) => setDraft({ ...draft, text })}
          required
          maxLength={1500}
          rows={5}
          hint="The customer’s own words."
          {...(errors.text === undefined ? {} : { errors: errors.text })}
        />
      </div>
      <SelectField
        id="review-product"
        label="Linked product (optional)"
        value={draft.productId}
        options={productOptions}
        placeholder="No product linked"
        onChange={(productId) => setDraft({ ...draft, productId })}
        hint="A star rating is only ever emitted in structured data for a product that has reviews linked to it."
      />
      <TextField
        id="review-date"
        label="Date (optional, YYYY-MM-DD)"
        value={draft.date}
        onChange={(date) => setDraft({ ...draft, date })}
        placeholder="2026-03-14"
        {...(errors.date === undefined ? {} : { errors: errors.date })}
      />
      <div className="md:col-span-2">
        <CheckboxField
          id="review-featured"
          label="Feature this review"
          checked={draft.featured}
          onChange={(featured) => setDraft({ ...draft, featured })}
          hint="Featured reviews are ordered first wherever reviews are shown."
        />
      </div>
      <p className="text-small text-walnut md:col-span-2">
        Photographs and video: the review record can carry object keys for a customer photo, a
        product photo and a video, but there is no upload route for review media yet, so these stay
        empty. They are shown read-only on each review below.
      </p>
      <div className="flex gap-3 md:col-span-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (editing === null) return;
            if (editing.mode === 'new') void create();
            else void save(editing.id);
          }}
          className="min-h-[44px] bg-espresso px-5 py-2 text-ivory disabled:opacity-50"
        >
          {editing?.mode === 'new' ? 'Save as draft' : 'Save review'}
        </button>
        <button
          type="button"
          onClick={() => {
            setEditing(null);
            setDraft(EMPTY_DRAFT);
            setErrors({});
          }}
          className="min-h-[44px] border border-espresso px-4 py-2 text-espresso"
        >
          Cancel
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      {status !== null && (
        <p role="status" className="border border-taupe bg-white px-4 py-3 text-small">
          {status}
        </p>
      )}

      {props.canWrite && editing === null && (
        <button
          type="button"
          onClick={() => {
            setEditing({ mode: 'new' });
            setDraft(EMPTY_DRAFT);
            setErrors({});
          }}
          className="self-start min-h-[44px] bg-espresso px-5 py-3 text-ivory"
        >
          Add a review
        </button>
      )}

      {editing !== null && (
        <section aria-labelledby="review-form" className="border border-espresso bg-white p-4">
          <h2 id="review-form" className="font-display text-h3 text-espresso">
            {editing.mode === 'new' ? 'New review' : 'Edit review'}
          </h2>
          {form}
        </section>
      )}

      {rows.length === 0 ? (
        <EmptyState
          heading="No reviews yet"
          message="Reviews are entered from what customers actually said. Nothing here is generated, and nothing appears on the site until you publish it."
        >
          {props.canWrite && (
            <button
              type="button"
              onClick={() => {
                setEditing({ mode: 'new' });
                setDraft(EMPTY_DRAFT);
                setErrors({});
              }}
              className="min-h-[44px] bg-espresso px-5 py-3 text-ivory"
            >
              Add the first review
            </button>
          )}
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((review, index) => (
            <li key={review.id} className="border border-taupe bg-white p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-display text-h3 text-espresso">
                  {review.customerName}{' '}
                  <span className="text-body text-walnut">{review.rating}/5</span>
                </h3>
                <p className="text-small text-walnut">{STATUS_MEANING[review.status]}</p>
              </div>
              <p className="mt-2 max-w-[70ch] text-body">{review.text}</p>
              <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-small text-walnut">
                <div>
                  <dt className="inline">Id: </dt>
                  <dd className="inline font-mono">{review.id}</dd>
                </div>
                {review.date !== undefined && (
                  <div>
                    <dt className="inline">Date: </dt>
                    <dd className="inline">{review.date}</dd>
                  </div>
                )}
                <div>
                  <dt className="inline">Linked product: </dt>
                  <dd className="inline">
                    {review.productId === undefined
                      ? 'None'
                      : (props.products.find((product) => product.id === review.productId)?.name ??
                        review.productId)}
                  </dd>
                </div>
                <div>
                  <dt className="inline">Featured: </dt>
                  <dd className="inline">{review.featured ? 'Yes' : 'No'}</dd>
                </div>
                <div>
                  <dt className="inline">Media keys: </dt>
                  <dd className="inline font-mono">
                    {[review.customerPhotoKey, review.productPhotoKey, review.videoKey]
                      .filter((key) => key !== undefined)
                      .join(', ') || 'none'}
                  </dd>
                </div>
              </dl>

              {props.canWrite && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    aria-label={`Move review by ${review.customerName} up`}
                    disabled={busy || index === 0}
                    onClick={() => void move(index, -1)}
                    className="min-h-[44px] min-w-[44px] border border-taupe disabled:opacity-40"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Move review by ${review.customerName} down`}
                    disabled={busy || index === rows.length - 1}
                    onClick={() => void move(index, 1)}
                    className="min-h-[44px] min-w-[44px] border border-taupe disabled:opacity-40"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setEditing({ mode: 'edit', id: review.id });
                      setDraft(draftOf(review));
                      setErrors({});
                    }}
                    className="min-h-[44px] border border-espresso px-3 text-espresso"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void setStatusOf(
                        review,
                        review.status === 'PUBLISHED' ? 'UNPUBLISHED' : 'PUBLISHED',
                      )
                    }
                    className="min-h-[44px] border border-espresso px-3 text-espresso"
                  >
                    {review.status === 'PUBLISHED' ? 'Unpublish' : 'Publish'}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void setFeatured(review, !review.featured)}
                    className="min-h-[44px] border border-espresso px-3 text-espresso"
                  >
                    {review.featured ? 'Unfeature' : 'Feature'}
                  </button>
                  {props.canDelete && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmDelete(review.id)}
                      className="min-h-[44px] border border-espresso px-3 text-espresso"
                    >
                      Delete
                    </button>
                  )}
                </div>
              )}

              {confirmDelete === review.id && (
                <div className="mt-3 border border-espresso p-3">
                  <p className="text-small">
                    Delete this review permanently? It comes off the site at the next build.
                  </p>
                  <div className="mt-2 flex gap-3">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void remove(review.id)}
                      className="min-h-[44px] bg-espresso px-4 py-2 text-ivory disabled:opacity-50"
                    >
                      Delete review
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(null)}
                      className="min-h-[44px] border border-espresso px-4 py-2 text-espresso"
                    >
                      Keep it
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
