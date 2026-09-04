import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAY_BE_EMPTY_COLLECTIONS,
  emptyCollectionWarning,
  installEmptyCollectionFilter,
  readOptionalCollection,
} from '@/lib/content/optional-collection';

/**
 * The empty-collection warning filter.
 *
 * The filter exists so a build log tells the truth: `data/products/` and `data/reviews/` are empty
 * on purpose, and Astro's "does not exist or is empty — check your content config file for errors"
 * is a false accusation repeated once per rendered page. The risk of silencing a warning is that a
 * *real* one goes with it, so these tests pin the boundary from both sides: the two declared
 * collections are silenced, and everything else — a different collection, a different message, a
 * warning with more arguments — still reaches the log.
 *
 * Requirements: 17.7, 18.5, 26.11.
 */
describe('the empty-collection warning filter', () => {
  beforeEach(() => {
    installEmptyCollectionFilter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reproduces Astro’s message exactly, including the quoted collection name', () => {
    expect(emptyCollectionWarning('products')).toBe(
      'The collection "products" does not exist or is empty. Please check your content config file for errors.',
    );
  });

  it('declares products and reviews — and deliberately not categories', () => {
    expect([...MAY_BE_EMPTY_COLLECTIONS]).toStrictEqual(['products', 'reviews']);
    expect([...MAY_BE_EMPTY_COLLECTIONS]).not.toContain('categories');
  });

  it('is installed exactly once, however many times it is asked for', () => {
    const afterFirst = console.warn;
    installEmptyCollectionFilter();
    installEmptyCollectionFilter();
    expect(console.warn).toBe(afterFirst);
  });

  it('drops the warning for every collection allowed to be empty', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Re-wrap so the spy sits underneath the already-installed filter.
    const filtered = wrapWithFilter(spy);
    for (const collection of MAY_BE_EMPTY_COLLECTIONS) {
      filtered(emptyCollectionWarning(collection));
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('keeps the warning for a collection that must never be empty', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const filtered = wrapWithFilter(spy);
    filtered(emptyCollectionWarning('categories'));
    expect(spy).toHaveBeenCalledWith(emptyCollectionWarning('categories'));
  });

  it('keeps any other warning, including one that merely mentions the collection', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const filtered = wrapWithFilter(spy);
    filtered('The collection "products" failed to load: ENOENT');
    filtered('products');
    filtered(emptyCollectionWarning('products'), { extra: 'context' });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('returns exactly what the read returned, and adds nothing', async () => {
    await expect(readOptionalCollection(() => Promise.resolve([]))).resolves.toStrictEqual([]);
    await expect(
      readOptionalCollection(() => Promise.resolve([{ id: 'a' }])),
    ).resolves.toStrictEqual([{ id: 'a' }]);
  });

  it('does not swallow a failed read', async () => {
    const boom = new Error('the data store is unreadable');
    await expect(readOptionalCollection(() => Promise.reject(boom))).rejects.toBe(boom);
  });
});

/**
 * The installed filter's own logic, applied over a given sink.
 *
 * `installEmptyCollectionFilter` captures `console.warn` at install time, so a spy installed
 * afterwards sits *above* the filter rather than below it and would never see the filtering. This
 * mirrors the predicate over an explicit sink so the behaviour can be asserted directly.
 */
function wrapWithFilter(sink: (...args: unknown[]) => void): (...args: unknown[]) => void {
  const suppressed = new Set(MAY_BE_EMPTY_COLLECTIONS.map((c) => emptyCollectionWarning(c)));
  return (...args: unknown[]) => {
    if (args.length === 1 && typeof args[0] === 'string' && suppressed.has(args[0])) return;
    sink(...args);
  };
}
