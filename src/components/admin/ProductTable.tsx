/**
 * The product list.
 *
 * A real `<table>` with a header row, because that is what a list of records with columns is,
 * and it is what a screen reader can navigate by column. Rows are keyboard-operable: the
 * product name is a link, and the row's controls are separate focusable buttons rather than
 * click handlers on the row itself.
 *
 * With no products at all it renders the designed empty state — "No products yet, add your
 * first product" — rather than an empty table with headers, which reads as a fault
 * (Requirement 26.14). A filter that matches nothing says so distinctly, and offers to clear
 * the filters: "no products exist" and "no products match this filter" are different
 * situations and a shared message would be wrong for both.
 *
 * Mutating controls are omitted for a role without `product.write`. That is presentation only
 * — every endpoint re-derives authority (Requirement 10.17).
 *
 * Requirements: 10.17, 12.2, 24.5, 26.14.
 */

import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';

import { formatINR, PRICE_ON_ENQUIRY_LABEL } from '@/lib/money';
import { pageOfProducts, type ProductQuery } from '@/lib/products/query';
import { derivativeUrl, extFromMime, originalUrl } from '@/lib/images/srcset';
import type { ProductStatusValue } from '@/schemas/product';
import type { ProductSummary } from '@/lib/products/index-store';
import EmptyState from '@/components/ui/EmptyState';

export interface ProductTableProps {
  summaries: readonly ProductSummary[];
  categories: readonly { slug: string; name: string }[];
  canWrite: boolean;
}

const STATUS_LABELS: Record<ProductStatusValue, string> = {
  DRAFT: 'Draft',
  REVIEW: 'In review',
  PUBLISHED: 'Published',
  UNPUBLISHED: 'Unpublished',
  OUT_OF_STOCK: 'Out of stock',
};

const STOCK_LABELS: Record<string, string> = {
  IN_STOCK: 'In stock',
  LIMITED_STOCK: 'Limited',
  OUT_OF_STOCK: 'Out of stock',
  MADE_TO_ORDER: 'Made to order',
};

const STATUS_FILTERS: readonly { value: ProductStatusValue | 'ALL'; label: string }[] = [
  { value: 'ALL', label: 'All statuses' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'REVIEW', label: 'In review' },
  { value: 'PUBLISHED', label: 'Published' },
  { value: 'OUT_OF_STOCK', label: 'Out of stock' },
  { value: 'UNPUBLISHED', label: 'Unpublished' },
];

function thumbnail(summary: ProductSummary): string | null {
  const thumb = summary.thumbnail;
  if (thumb === null) return null;
  return thumb.derivativesReady
    ? derivativeUrl(thumb.productId, thumb.imageId, 320, 'webp')
    : originalUrl(thumb.productId, thumb.imageId, extFromMime(undefined));
}

export default function ProductTable(props: ProductTableProps): ReactElement {
  const [query, setQuery] = useState<ProductQuery>({ status: 'ALL', page: 1 });

  const page = useMemo(() => pageOfProducts(props.summaries, query), [props.summaries, query]);
  const filtered = query.status !== 'ALL' || query.category !== undefined || query.q !== undefined;

  if (props.summaries.length === 0) {
    return (
      <EmptyState
        heading="No products yet"
        message="The catalogue is empty. Add your first product and it will appear here as a draft — it stays invisible to customers until you publish it."
      >
        {props.canWrite && (
          <a
            href="/admin/products/new"
            className="min-h-[44px] bg-espresso px-5 py-3 text-ivory no-underline"
          >
            Add your first product
          </a>
        )}
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="filter-q" className="text-small font-medium text-espresso">
            Search
          </label>
          <input
            id="filter-q"
            type="search"
            className="min-h-[44px] border border-taupe px-3 py-2"
            placeholder="Name, SKU or category"
            onChange={(event) => {
              const value = event.target.value.trim();
              setQuery((current) => {
                const next = { ...current, page: 1 };
                if (value === '') delete next.q;
                else next.q = value;
                return next;
              });
            }}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="filter-status" className="text-small font-medium text-espresso">
            Status
          </label>
          <select
            id="filter-status"
            className="min-h-[44px] border border-taupe px-3 py-2"
            value={query.status ?? 'ALL'}
            onChange={(event) =>
              setQuery((current) => ({
                ...current,
                status: event.target.value as ProductStatusValue | 'ALL',
                page: 1,
              }))
            }
          >
            {STATUS_FILTERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="filter-category" className="text-small font-medium text-espresso">
            Category
          </label>
          <select
            id="filter-category"
            className="min-h-[44px] border border-taupe px-3 py-2"
            value={query.category ?? ''}
            onChange={(event) =>
              setQuery((current) => {
                const next = { ...current, page: 1 };
                if (event.target.value === '') delete next.category;
                else next.category = event.target.value;
                return next;
              })
            }
          >
            <option value="">All categories</option>
            {props.categories.map((category) => (
              <option key={category.slug} value={category.slug}>
                {category.name}
              </option>
            ))}
          </select>
        </div>

        <p className="text-small text-walnut" aria-live="polite">
          {page.total} of {props.summaries.length} product{props.summaries.length === 1 ? '' : 's'}
        </p>
      </div>

      {page.items.length === 0 ? (
        <EmptyState
          heading="No products match these filters"
          message="Nothing has been hidden or deleted. Clear the filters to see every product again."
          illustration="none"
        >
          <button
            type="button"
            onClick={() => setQuery({ status: 'ALL', page: 1 })}
            className="min-h-[44px] border border-espresso px-4 py-2 text-espresso"
          >
            Clear filters
          </button>
        </EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-small">
            <caption className="sr-only">
              Products, most recently edited first{filtered ? ', filtered' : ''}
            </caption>
            <thead>
              <tr className="border-b border-taupe text-left">
                <th scope="col" className="px-2 py-2">
                  Image
                </th>
                <th scope="col" className="px-2 py-2">
                  Name
                </th>
                <th scope="col" className="px-2 py-2">
                  SKU
                </th>
                <th scope="col" className="px-2 py-2">
                  Category
                </th>
                <th scope="col" className="px-2 py-2">
                  Status
                </th>
                <th scope="col" className="px-2 py-2">
                  Stock
                </th>
                <th scope="col" className="px-2 py-2">
                  Price
                </th>
                <th scope="col" className="px-2 py-2">
                  Updated
                </th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((summary) => {
                const src = thumbnail(summary);
                return (
                  <tr key={summary.id} className="border-b border-taupe align-middle">
                    <td className="px-2 py-2">
                      {src === null ? (
                        <span className="flex h-12 w-12 items-center justify-center bg-cream text-small text-walnut">
                          None
                        </span>
                      ) : (
                        <img
                          src={src}
                          alt={summary.thumbnail?.alt ?? ''}
                          width={48}
                          height={48}
                          loading="lazy"
                          decoding="async"
                          className="h-12 w-12 bg-cream object-cover"
                        />
                      )}
                    </td>
                    <td className="px-2 py-2">
                      <a href={`/admin/products/${summary.id}`} className="underline">
                        {summary.name}
                      </a>
                      {summary.aiAssisted && <span className="ml-2 text-walnut">AI-assisted</span>}
                    </td>
                    <td className="px-2 py-2 font-mono">{summary.sku}</td>
                    <td className="px-2 py-2">
                      {props.categories.find((entry) => entry.slug === summary.category)?.name ??
                        summary.category}
                    </td>
                    <td className="px-2 py-2">{STATUS_LABELS[summary.status]}</td>
                    <td className="px-2 py-2">
                      {STOCK_LABELS[summary.stockStatus] ?? summary.stockStatus}
                    </td>
                    <td className="px-2 py-2">
                      {summary.priceOnEnquiry || summary.price === null
                        ? PRICE_ON_ENQUIRY_LABEL
                        : formatINR(summary.price)}
                    </td>
                    <td className="px-2 py-2">
                      {new Date(summary.updatedAt).toLocaleDateString('en-IN', {
                        dateStyle: 'medium',
                      })}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {page.pageCount > 1 && (
        <nav aria-label="Pages" className="flex items-center gap-3">
          <button
            type="button"
            disabled={page.page <= 1}
            onClick={() => setQuery((current) => ({ ...current, page: page.page - 1 }))}
            className="min-h-[44px] border border-taupe px-3 disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-small">
            Page {page.page} of {page.pageCount}
          </span>
          <button
            type="button"
            disabled={page.page >= page.pageCount}
            onClick={() => setQuery((current) => ({ ...current, page: page.page + 1 }))}
            className="min-h-[44px] border border-taupe px-3 disabled:opacity-40"
          >
            Next
          </button>
        </nav>
      )}
    </div>
  );
}
