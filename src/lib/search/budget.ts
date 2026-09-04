/**
 * The search index size budget, enforced at build time.
 *
 * Requirement 22.14 and the design both put the ceiling at **60 KB Brotli**, and the point of
 * asserting it during the build rather than measuring it in a dashboard is that the client-side
 * search architecture has a known scaling limit (~500 products). Past the budget, every visitor
 * who focuses the search field pays for a download that no longer fits the "instant, zero-cost"
 * premise. The escape hatch is designed (per-category indexes, then a server search endpoint),
 * so the correct response to breaching the budget is to take it — which cannot happen if
 * nobody notices.
 *
 * `node:zlib` is imported here and nowhere else. This module is used by the prerendered
 * `/search-index/[hash].json` route (which executes in Node at build time) and by the unit
 * tests, never by client code and never by a Worker route, so no Node built-in reaches a
 * bundle.
 *
 * Requirements: 22.8, 22.14.
 */

import { brotliCompressSync, constants } from 'node:zlib';

/** 60 KB, Brotli-compressed. */
export const SEARCH_INDEX_BUDGET_BYTES = 60 * 1024;

/**
 * Brotli-compressed size in bytes, at the quality Cloudflare serves.
 *
 * Quality 11 is the right measurement even though the edge may use a lower level: it is the
 * best case, so a failure here is a real failure rather than an artefact of a conservative
 * setting. `SIZE_HINT` lets the encoder pick a window suited to the input.
 */
export function brotliSize(serialized: string): number {
  const input = Buffer.from(serialized, 'utf8');
  return brotliCompressSync(input, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: input.byteLength,
    },
  }).byteLength;
}

export interface BudgetReport {
  ok: boolean;
  rawBytes: number;
  brotliBytes: number;
  budgetBytes: number;
}

export function measureSearchIndex(serialized: string): BudgetReport {
  const brotliBytes = brotliSize(serialized);
  return {
    ok: brotliBytes <= SEARCH_INDEX_BUDGET_BYTES,
    rawBytes: Buffer.byteLength(serialized, 'utf8'),
    brotliBytes,
    budgetBytes: SEARCH_INDEX_BUDGET_BYTES,
  };
}

/**
 * Fail the build when the index exceeds its budget.
 *
 * The message names the measured size, the budget, and the designed remedy, because the person
 * who hits this will be adding the 500th product and needs to know the architecture has an
 * answer rather than that something is broken.
 */
export function assertSearchIndexBudget(serialized: string, docCount: number): BudgetReport {
  const report = measureSearchIndex(serialized);
  if (!report.ok) {
    throw new Error(
      `SEARCH_INDEX_OVER_BUDGET: ${docCount} products serialize to ${report.brotliBytes} bytes Brotli, ` +
        `over the ${report.budgetBytes} byte budget (${report.rawBytes} bytes raw). ` +
        'Take the designed escape hatch: split into per-category indexes loaded on the category ' +
        'route plus a name/SKU-only global index for the header search (design → Catalogue → ' +
        'Client-side, with a measured budget and a defined escape hatch).',
    );
  }
  return report;
}
