import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import DashboardCards, { type DashboardCardsProps } from '@/components/admin/DashboardCards';

const PRODUCT_ERROR = 'Product figures are unavailable for this environment.';
const HISTORY_ERROR = 'Content history is unavailable for this environment.';
const COUNTS = { total: 2, published: 1, draft: 1, review: 0, outOfStock: 0, unpublished: 0 };

function render(overrides: Partial<DashboardCardsProps> = {}): string {
  return renderToStaticMarkup(
    createElement(DashboardCards, {
      counts: null,
      countsUnavailable: PRODUCT_ERROR,
      newLeads: 0,
      recent: [],
      recentUnavailable: HISTORY_ERROR,
      canWrite: true,
      ...overrides,
    }),
  );
}

describe('independent dashboard panels', () => {
  it('keeps enquiries and unavailable history visible when product figures fail', () => {
    const html = render();
    expect(html).toContain(PRODUCT_ERROR);
    expect(html).toContain('Enquiries');
    expect(html).toContain('No new enquiries.');
    expect(html).toContain(HISTORY_ERROR);
    expect(html).not.toContain('No products yet');
    expect(html).not.toContain('No content changes recorded yet');
  });

  it('preserves a positive enquiry count and real activity when products fail', () => {
    const html = render({
      newLeads: 3,
      recentUnavailable: undefined,
      recent: [{ subject: 'Stored content change', actor: null, at: null, sha: 'test-commit' }],
    });
    expect(html).toContain('>3</p>');
    expect(html).toContain('/admin/leads?status=NEW');
    expect(html).toContain('Stored content change');
    expect(html).toContain(PRODUCT_ERROR);
  });

  it('does not turn a failed D1 read into a zero while products and activity remain available', () => {
    const html = render({
      counts: COUNTS,
      newLeads: null,
      recentUnavailable: undefined,
      recent: [{ subject: 'Stored content change', actor: null, at: null, sha: 'test-commit' }],
    });
    expect(html).toContain('2 products in total.');
    expect(html).toContain('The enquiry store could not be read');
    expect(html).toContain('Stored content change');
    expect(html).not.toContain('No new enquiries.');
    expect(html).not.toContain(PRODUCT_ERROR);
  });

  it('distinguishes genuinely empty products and history from unavailable data', () => {
    const html = render({
      counts: { ...COUNTS, total: 0, published: 0, draft: 0 },
      recentUnavailable: undefined,
    });
    expect(html).toContain('No products yet');
    expect(html).toContain('Add your first product');
    expect(html).toContain('No new enquiries.');
    expect(html).toContain('No content changes recorded yet');
    expect(html).not.toContain(PRODUCT_ERROR);
  });

  it('keeps loaded product figures and zero enquiries visible when only history fails', () => {
    const html = render({ counts: COUNTS });
    expect(html).toContain('2 products in total.');
    expect(html).toContain('No new enquiries.');
    expect(html).toContain(HISTORY_ERROR);
    expect(html).not.toContain(PRODUCT_ERROR);
  });

  it('uses an unavailable message even when the caller supplies no product error text', () => {
    expect(render({ countsUnavailable: null })).toContain('Product figures could not be read');
  });

  it('passes product failures to the cards instead of gating the entire dashboard page', () => {
    const source = readFileSync(
      new URL('../../src/pages/admin/index.astro', import.meta.url),
      'utf8',
    );
    const template = source.slice(source.indexOf('---', 3) + 3);
    expect(template).not.toMatch(/countsUnavailable\s*!==\s*null\s*\?/);
    expect(template).toContain('countsUnavailable={countsUnavailable}');
    expect(template).toContain(
      'counts={countsUnavailable === null ? catalogueCounts(summaries) : null}',
    );
  });
});
