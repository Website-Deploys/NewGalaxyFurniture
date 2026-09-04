/**
 * The build-time search index asset: built once, reused by every page that needs its URL.
 *
 * Two responsibilities, both build-time only:
 *
 * 1. **Build the index once per build.** `getCatalogue()` is cheap but the serialization,
 *   hashing, and Brotli measurement are not, and every prerendered page asks for the index URL
 *   so the header search knows where to fetch from. The memo makes that one computation for a
 *   build of any size.
 * 2. **Enforce the budget.** `assertSearchIndexBudget` runs on first access, which is during
 *   the build, so a catalogue that outgrows the client-side architecture fails the build rather
 *   than degrading every visitor's search silently (Requirement 22.14).
 *
 * The URL is handed to the browser as a `data-` attribute on the document, never as an inlined
 * index: Requirement 22.8 and the design both require the index to stay out of the initial
 * payload and be fetched on first search intent.
 *
 * Requirements: 2.11, 22.7, 22.8, 22.14.
 */

import { getCatalogue } from '@/lib/content/catalogue';
import { assertSearchIndexBudget } from './budget';
import type { BudgetReport } from './budget';
import {
  buildSearchIndex,
  searchIndexHash,
  searchIndexPath,
  serializeSearchIndex,
} from './build-index';
import type { SearchDoc } from './types';

export interface SearchIndexAsset {
  docs: SearchDoc[];
  serialized: string;
  hash: string;
  /** `/search-index/{hash}.json` */
  path: string;
  budget: BudgetReport;
}

let memo: Promise<SearchIndexAsset> | null = null;

async function build(): Promise<SearchIndexAsset> {
  const docs = buildSearchIndex(await getCatalogue());
  const serialized = serializeSearchIndex(docs);
  const budget = assertSearchIndexBudget(serialized, docs.length);
  const hash = searchIndexHash(serialized);
  return { docs, serialized, hash, path: searchIndexPath(hash), budget };
}

export function getSearchIndexAsset(): Promise<SearchIndexAsset> {
  memo ??= build();
  return memo;
}

/** Just the URL — what the layout puts on the document for `SearchBox` to fetch. */
export async function getSearchIndexUrl(): Promise<string> {
  return (await getSearchIndexAsset()).path;
}
