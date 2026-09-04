/**
 * Visitor-facing labels for stored enum values.
 *
 * One table, because Requirement 1.5 asks for "a visible stock status label corresponding to
 * the product's Stock_Status" on the card and Requirement 4.2 asks for the same on the PDP —
 * and a product that reads "Limited stock" on a listing and "Few left" on its own page looks
 * like two different products.
 *
 * Requirements: 1.5, 4.2, 4.12.
 */

import type { StockStatusValue } from '@/schemas/product';

export const STOCK_LABELS: Readonly<Record<StockStatusValue, string>> = {
  IN_STOCK: 'In stock',
  LIMITED_STOCK: 'Limited stock',
  OUT_OF_STOCK: 'Currently out of stock',
  MADE_TO_ORDER: 'Made to order',
};

export function stockLabel(status: string): string {
  return STOCK_LABELS[status as StockStatusValue] ?? status;
}
