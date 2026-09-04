/**
 * Category management: create, edit, reorder, publish, unpublish, delete.
 *
 * Reordering is done with Move up / Move down buttons rather than drag-and-drop. Drag is
 * the obvious gesture and it is the wrong primary one here: a drag handle needs a parallel
 * keyboard model to be operable at all (Requirement 24.5), and nine categories reordered
 * twice a year do not justify one. The buttons *are* the keyboard model, and each press
 * sends the whole ordering so the server commits it as one change.
 *
 * Two honesty rules are visible in the UI rather than buried in the endpoint:
 *
 * - A category with products assigned shows the count and its Delete control is disabled
 *   with the reason attached, so the refusal (Requirement 18.4) is legible *before* the
 *   attempt rather than only after it.
 * - Nothing about a category is generated. An empty description is shown as "No
 *   description yet" — a to-do, not filled in with a sentence about furniture.
 *
 * Requirements: 18.2, 18.3, 18.4, 10.17, 24.5, 26.9, 26.14.
 */

import { useState } from 'react';
import type { ReactElement } from 'react';

import { adminFetch, type FieldErrors } from '@/lib/admin/client';
import { CategoryIllustration, type Category } from '@/schemas/category';
import { CheckboxField, SelectField, TextAreaField, TextField } from './fields';
import EmptyState from '@/components/ui/EmptyState';

export interface CategoryRow extends Category {
  assigned: { total: number; published: number };
}

export interface CategoryTableProps {
  categories: readonly CategoryRow[];
  canWrite: boolean;
}

interface Draft {
  name: string;
  shortDescription: string;
  illustration: Category['illustration'];
  seoTitle: string;
  seoDescription: string;
  published: boolean;
}

function draftOf(category: Category): Draft {
  return {
    name: category.name,
    shortDescription: category.shortDescription,
    illustration: category.illustration,
    seoTitle: category.seoTitle ?? '',
    seoDescription: category.seoDescription ?? '',
    published: category.published,
  };
}

/** The nine drawn illustrations, read from the schema so the list cannot drift from it. */
const ILLUSTRATION_OPTIONS = CategoryIllustration.options.map((value) => ({
  value,
  label: value,
}));

export default function CategoryTable(props: CategoryTableProps): ReactElement {
  const [rows, setRows] = useState<readonly CategoryRow[]>(props.categories);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newIllustration, setNewIllustration] = useState<Category['illustration']>('sofa');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');

  function fail(message: string, fields?: FieldErrors): void {
    setStatus(message);
    setErrors(fields ?? {});
  }

  async function reload(): Promise<void> {
    const result = await adminFetch<{ categories: CategoryRow[] }>('/api/admin/categories');
    if (result.ok) setRows(result.value.categories);
  }

  async function save(slug: string): Promise<void> {
    if (draft === null) return;
    setBusy(true);
    setErrors({});
    const result = await adminFetch<unknown>(`/api/admin/categories/${slug}`, {
      method: 'PATCH',
      body: {
        patch: {
          name: draft.name,
          shortDescription: draft.shortDescription,
          illustration: draft.illustration,
          seoTitle: draft.seoTitle.trim() === '' ? null : draft.seoTitle.trim(),
          seoDescription: draft.seoDescription.trim() === '' ? null : draft.seoDescription.trim(),
          published: draft.published,
        },
      },
    });
    setBusy(false);
    if (!result.ok) {
      fail(result.error.message, result.error.fields);
      return;
    }
    setEditing(null);
    setDraft(null);
    setStatus('Saved. The change appears on the site at the next build.');
    await reload();
  }

  async function setPublished(row: CategoryRow, published: boolean): Promise<void> {
    setBusy(true);
    const result = await adminFetch<unknown>(`/api/admin/categories/${row.slug}`, {
      method: 'PATCH',
      body: { patch: { published } },
    });
    setBusy(false);
    if (!result.ok) {
      fail(result.error.message, result.error.fields);
      return;
    }
    setStatus(
      published
        ? `“${row.name}” will be visible after the next build.`
        : `“${row.name}” will be hidden after the next build.`,
    );
    await reload();
  }

  async function move(index: number, delta: number): Promise<void> {
    const target = index + delta;
    if (target < 0 || target >= rows.length) return;
    const order = rows.map((row) => row.slug);
    const moved = order[index];
    const displaced = order[target];
    if (moved === undefined || displaced === undefined) return;
    order[index] = displaced;
    order[target] = moved;

    setBusy(true);
    const result = await adminFetch<unknown>('/api/admin/categories', {
      method: 'PATCH',
      body: { order },
    });
    setBusy(false);
    if (!result.ok) {
      fail(result.error.message, result.error.fields);
      return;
    }
    setStatus('Order saved.');
    await reload();
  }

  async function create(): Promise<void> {
    setBusy(true);
    setErrors({});
    const result = await adminFetch<{ slug: string }>('/api/admin/categories', {
      method: 'POST',
      body: { name: newName, illustration: newIllustration },
    });
    setBusy(false);
    if (!result.ok) {
      fail(result.error.message, result.error.fields);
      return;
    }
    setCreating(false);
    setNewName('');
    setStatus(
      `Created “${newName}”. Its listing page, navigation entry and filter option appear after the next build — no code change needed.`,
    );
    await reload();
  }

  async function remove(row: CategoryRow): Promise<void> {
    setBusy(true);
    setErrors({});
    const result = await adminFetch<unknown>(`/api/admin/categories/${row.slug}`, {
      method: 'DELETE',
      body: { confirmSlug: confirmText },
    });
    setBusy(false);
    if (!result.ok) {
      fail(result.error.message, result.error.fields);
      return;
    }
    setConfirmDelete(null);
    setConfirmText('');
    setStatus(`Deleted “${row.name}”.`);
    await reload();
  }

  return (
    <div className="flex flex-col gap-6">
      {status !== null && (
        <p role="status" className="border border-taupe bg-white px-4 py-3 text-small">
          {status}
        </p>
      )}
      {errors._ !== undefined && (
        <ul className="border border-espresso bg-white px-4 py-3 text-small text-espresso">
          {errors._.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      {errors.category !== undefined && (
        <ul className="border border-espresso bg-white px-4 py-3 text-small text-espresso">
          {errors.category.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}

      {props.canWrite && (
        <section aria-labelledby="new-category" className="border border-taupe bg-white p-4">
          <h2 id="new-category" className="font-display text-h3 text-espresso">
            Add a category
          </h2>
          {creating ? (
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <TextField
                id="new-category-name"
                label="Name"
                value={newName}
                onChange={setNewName}
                required
                maxLength={80}
                {...(errors.name === undefined ? {} : { errors: errors.name })}
                hint="The web address is derived from this name and cannot be changed afterwards."
              />
              <SelectField
                id="new-category-illustration"
                label="Illustration"
                value={newIllustration}
                options={ILLUSTRATION_OPTIONS}
                onChange={(value) => setNewIllustration(value as Category['illustration'])}
                hint="Which of the nine drawn illustrations represents this category."
              />
              <div className="flex gap-3 md:col-span-2">
                <button
                  type="button"
                  disabled={busy || newName.trim() === ''}
                  onClick={() => void create()}
                  className="min-h-[44px] bg-espresso px-5 py-2 text-ivory disabled:opacity-50"
                >
                  Create category
                </button>
                <button
                  type="button"
                  onClick={() => setCreating(false)}
                  className="min-h-[44px] border border-espresso px-4 py-2 text-espresso"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="mt-4 min-h-[44px] border border-espresso px-4 py-2 text-espresso"
            >
              New category
            </button>
          )}
        </section>
      )}

      {rows.length === 0 ? (
        <EmptyState
          heading="No categories yet"
          message="Categories organise the catalogue. Add one and its listing page appears at the next build."
        >
          {props.canWrite && (
            <a
              href="#new-category"
              className="min-h-[44px] border border-espresso px-4 py-2 text-espresso no-underline"
            >
              Add the first category
            </a>
          )}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-small">
            <caption className="sr-only">Categories, in the order visitors see them</caption>
            <thead>
              <tr className="border-b border-taupe text-left">
                <th scope="col" className="px-2 py-2">
                  Order
                </th>
                <th scope="col" className="px-2 py-2">
                  Name
                </th>
                <th scope="col" className="px-2 py-2">
                  Slug
                </th>
                <th scope="col" className="px-2 py-2">
                  Description
                </th>
                <th scope="col" className="px-2 py-2">
                  Products
                </th>
                <th scope="col" className="px-2 py-2">
                  Visible
                </th>
                {props.canWrite && (
                  <th scope="col" className="px-2 py-2">
                    Actions
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={row.slug} className="border-b border-taupe align-top">
                  <td className="px-2 py-2">
                    {props.canWrite ? (
                      <span className="flex gap-1">
                        <button
                          type="button"
                          aria-label={`Move ${row.name} up`}
                          disabled={busy || index === 0}
                          onClick={() => void move(index, -1)}
                          className="min-h-[44px] min-w-[44px] border border-taupe disabled:opacity-40"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${row.name} down`}
                          disabled={busy || index === rows.length - 1}
                          onClick={() => void move(index, 1)}
                          className="min-h-[44px] min-w-[44px] border border-taupe disabled:opacity-40"
                        >
                          ↓
                        </button>
                      </span>
                    ) : (
                      index + 1
                    )}
                  </td>
                  <td className="px-2 py-2">{row.name}</td>
                  <td className="px-2 py-2 font-mono">{row.slug}</td>
                  <td className="max-w-[36ch] px-2 py-2">
                    {row.shortDescription.trim() === '' ? (
                      <span className="text-walnut">No description yet</span>
                    ) : (
                      row.shortDescription
                    )}
                  </td>
                  <td className="px-2 py-2">
                    {row.assigned.total === 0 ? (
                      <span className="text-walnut">None</span>
                    ) : (
                      `${String(row.assigned.total)} (${String(row.assigned.published)} live)`
                    )}
                  </td>
                  <td className="px-2 py-2">{row.published ? 'Visible' : 'Hidden'}</td>
                  {props.canWrite && (
                    <td className="px-2 py-2">
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setEditing(row.slug);
                            setDraft(draftOf(row));
                            setErrors({});
                          }}
                          className="min-h-[44px] border border-espresso px-3 text-espresso"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void setPublished(row, !row.published)}
                          className="min-h-[44px] border border-espresso px-3 text-espresso"
                        >
                          {row.published ? 'Unpublish' : 'Publish'}
                        </button>
                        <button
                          type="button"
                          disabled={busy || row.assigned.total > 0}
                          title={
                            row.assigned.total > 0
                              ? `${String(row.assigned.total)} product(s) are assigned to this category. Move them first.`
                              : undefined
                          }
                          onClick={() => {
                            setConfirmDelete(row.slug);
                            setConfirmText('');
                          }}
                          className="min-h-[44px] border border-espresso px-3 text-espresso disabled:opacity-40"
                        >
                          Delete
                        </button>
                      </div>
                      {row.assigned.total > 0 && (
                        <p className="mt-1 text-small text-walnut">
                          {row.assigned.total} product{row.assigned.total === 1 ? '' : 's'} assigned
                          — deletion is refused until they are moved.
                        </p>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing !== null && draft !== null && (
        <section aria-labelledby="edit-category" className="border border-espresso bg-white p-4">
          <h2 id="edit-category" className="font-display text-h3 text-espresso">
            Edit “{draft.name}”
          </h2>
          <p className="mt-1 text-small text-walnut">
            The slug <code>{editing}</code> is the category’s web address and does not change.
          </p>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <TextField
              id="category-name"
              label="Name"
              value={draft.name}
              onChange={(name) => setDraft({ ...draft, name })}
              required
              maxLength={80}
              {...(errors.name === undefined ? {} : { errors: errors.name })}
            />
            <SelectField
              id="category-illustration"
              label="Illustration"
              value={draft.illustration}
              options={ILLUSTRATION_OPTIONS}
              onChange={(value) =>
                setDraft({ ...draft, illustration: value as Category['illustration'] })
              }
            />
            <div className="md:col-span-2">
              <TextAreaField
                id="category-description"
                label="Short description"
                value={draft.shortDescription}
                onChange={(shortDescription) => setDraft({ ...draft, shortDescription })}
                maxLength={200}
                rows={3}
                hint="Shown on the listing page. Left blank until you write it — nothing is generated."
                {...(errors.shortDescription === undefined
                  ? {}
                  : { errors: errors.shortDescription })}
              />
            </div>
            <TextField
              id="category-seo-title"
              label="SEO title"
              value={draft.seoTitle}
              onChange={(seoTitle) => setDraft({ ...draft, seoTitle })}
              maxLength={70}
            />
            <TextField
              id="category-seo-description"
              label="SEO description"
              value={draft.seoDescription}
              onChange={(seoDescription) => setDraft({ ...draft, seoDescription })}
              maxLength={170}
            />
            <div className="md:col-span-2">
              <CheckboxField
                id="category-published"
                label="Visible to visitors"
                checked={draft.published}
                onChange={(published) => setDraft({ ...draft, published })}
              />
            </div>
            <div className="flex gap-3 md:col-span-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void save(editing)}
                className="min-h-[44px] bg-espresso px-5 py-2 text-ivory disabled:opacity-50"
              >
                Save category
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditing(null);
                  setDraft(null);
                }}
                className="min-h-[44px] border border-espresso px-4 py-2 text-espresso"
              >
                Cancel
              </button>
            </div>
          </div>
        </section>
      )}

      {confirmDelete !== null && (
        <section aria-labelledby="delete-category" className="border border-espresso bg-white p-4">
          <h2 id="delete-category" className="font-display text-h3 text-espresso">
            Delete this category?
          </h2>
          <p className="mt-1 max-w-[60ch] text-small text-walnut">
            Type <code>{confirmDelete}</code> to confirm. The listing page comes down at the next
            build.
          </p>
          <div className="mt-3 max-w-sm">
            <TextField
              id="confirm-category-slug"
              label="Category slug"
              value={confirmText}
              onChange={setConfirmText}
              {...(errors.confirmSlug === undefined ? {} : { errors: errors.confirmSlug })}
            />
          </div>
          <div className="mt-3 flex gap-3">
            <button
              type="button"
              disabled={busy || confirmText !== confirmDelete}
              onClick={() => {
                const row = rows.find((entry) => entry.slug === confirmDelete);
                if (row !== undefined) void remove(row);
              }}
              className="min-h-[44px] bg-espresso px-5 py-2 text-ivory disabled:opacity-50"
            >
              Delete category
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmDelete(null);
                setConfirmText('');
              }}
              className="min-h-[44px] border border-espresso px-4 py-2 text-espresso"
            >
              Keep it
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
