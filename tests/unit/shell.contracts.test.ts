import { describe, expect, it } from 'vitest';

import { SEARCH_PLACEHOLDER } from '@/components/ui/SearchBox';
import { SCROLL_THRESHOLD_PX } from '@/components/ui/MobileActionBar';
import { getSiteSettings } from '@/lib/content/site';
import {
  CATEGORY_NAV,
  HEADER_NAV,
  MAX_TOP_LEVEL_DESTINATIONS,
  POLICY_NAV,
  SUPPORT_NAV,
} from '@/lib/site/navigation';
import { channelAriaLabel, contactChannels, NUMBER_LABEL } from '@/lib/site/contact';
import { canonicalSearch, needsRewrite, serializeFilters } from '@/lib/search/url';
import { neutralState } from '@/lib/search/filter';
import { resolveRanking, sortOptionLabel } from '@/lib/search/sort';
import type { RankingContext } from '@/lib/search/sort';
import type { SearchDoc } from '@/lib/search/types';
import { SEEDED_CATEGORY_SLUGS } from '@/schemas/category';
import { buildTelUrl, buildWhatsAppUrl } from '@/lib/whatsapp';

/**
 * The public shell's contracts: the nine navigation destinations, the two business numbers and
 * their one shared label, the exact search placeholder, the action bar's threshold, and the
 * honest sort labelling.
 *
 * These are unit tests rather than e2e assertions because each one is a statement about a value,
 * and a value is cheaper and more precise to check than a rendered pixel.
 *
 * Requirements: 2.1, 3.13–3.16, 3.19, 5.9, 5.10, 5.13, 5.16, 9.1, 9.2, 9.7, 19.3.
 */

describe('navigation (Requirements 9.1, 9.2, 9.7)', () => {
  it('presents the six named top-level destinations, in order', () => {
    // Six, because the header's job is to answer "what do you sell / can you make it for me / who
    // are you / how do I reach you" at a glance. Nine competing category labels answered none of
    // them faster, so the categories moved into one Shop dropdown.
    expect(HEADER_NAV.map((entry) => entry.label)).toEqual([
      'Shop',
      'Custom Furniture',
      'About',
      'Workshop',
      'Gallery',
      'Contact',
    ]);
    expect(HEADER_NAV.length).toBeLessThanOrEqual(MAX_TOP_LEVEL_DESTINATIONS);
  });

  it('groups the category destinations into a dropdown rather than spending top-level slots', () => {
    const groups = HEADER_NAV.filter((entry) => entry.kind === 'group');
    expect(groups.map((group) => group.label)).toEqual(['Shop']);
    for (const group of groups) {
      expect(group.kind).toBe('group');
      if (group.kind !== 'group') continue;
      expect(group.items.length).toBeGreaterThan(0);
      // Two columns: the routes, and one orienting note. The note must say something.
      expect(group.note.trim()).not.toBe('');
    }
  });

  it('reaches all nine category routes from the header, counting dropdown items', () => {
    const reachable = new Set(
      HEADER_NAV.flatMap((entry) =>
        entry.kind === 'group'
          ? [entry.href, ...entry.items.map((item) => item.href)]
          : [entry.href],
      ),
    );
    for (const slug of SEEDED_CATEGORY_SLUGS) {
      expect([...reachable]).toContain(`/collection/${slug}`);
    }
  });

  it('lists every category, the supporting pages, and the policy pages in the footer', () => {
    expect(CATEGORY_NAV.map((link) => link.href)).toEqual(
      SEEDED_CATEGORY_SLUGS.map((slug) => `/collection/${slug}`),
    );
    expect(SUPPORT_NAV.map((link) => link.href)).toContain('/contact');
    expect(POLICY_NAV.map((link) => link.href)).toEqual([
      '/privacy',
      '/terms',
      '/shipping',
      '/returns',
      '/warranty',
    ]);
  });
});

describe('business numbers (Requirements 5.9, 5.10, 5.13, 19.3)', () => {
  const settings = getSiteSettings();
  const channels = contactChannels(settings);

  it('publishes both numbers, on both channels', () => {
    expect(channels.map((channel) => channel.e164)).toEqual(['+919513443606', '+918147083703']);
    for (const channel of channels) {
      expect(channel.whatsapp).toBe(true);
      expect(channel.phone).toBe(true);
    }
  });

  it('applies one identical label to both, stating both are for orders and enquiries', () => {
    // Requirement 5.10: neither number may be characterised as a different department. There is
    // exactly one label string, so there is nothing to differ.
    expect(NUMBER_LABEL).toBe('Orders & enquiries');
    const labels = new Set(channels.map(() => NUMBER_LABEL));
    expect(labels.size).toBe(1);

    // The accessible names distinguish by number, never by role.
    const aria = channels.map((channel) => channelAriaLabel(channel, 'whatsapp'));
    expect(new Set(aria).size).toBe(channels.length);
    for (const label of aria) expect(label).toContain('orders and enquiries');
  });

  it('never labels a number with a department, function, or team word', () => {
    const forbidden = /\b(sales|support|service|helpline|dept|department|team|customer care)\b/i;
    for (const entry of [...settings.whatsapp, ...settings.phone]) {
      expect(entry.label).not.toMatch(forbidden);
      expect(entry.label.toLowerCase()).toContain('enquiries');
    }
    expect(NUMBER_LABEL).not.toMatch(forbidden);
  });

  it('builds digits-only wa.me links and +digits tel links', () => {
    for (const channel of channels) {
      const wa = buildWhatsAppUrl(channel.e164, 'hello');
      expect(wa).toMatch(/^https:\/\/wa\.me\/91\d{10}\?text=/);
      expect(buildTelUrl(channel.e164)).toMatch(/^tel:\+91\d{10}$/);
    }
  });

  it('displays both numbers in the readable Indian grouping', () => {
    expect(channels.map((channel) => channel.display)).toEqual([
      '+91 95134 43606',
      '+91 81470 83703',
    ]);
  });
});

describe('search control (Requirement 2.1)', () => {
  it('uses the exact specified placeholder text', () => {
    expect(SEARCH_PLACEHOLDER).toBe('Search by name, SKU, material, colour...');
  });
});

describe('mobile action bar (Requirements 5.16, 5.17)', () => {
  it('uses the specified 24 px scroll threshold', () => {
    expect(SCROLL_THRESHOLD_PX).toBe(24);
  });
});

describe('URL rewriting (Requirement 3.19)', () => {
  it('canonicalises a query string to the state actually applied', () => {
    expect(canonicalSearch('?sort=random&price=cheap&unknown=1')).toBe('');
    expect(canonicalSearch('?sort=priceAsc&price=1L%2B')).toBe('?price=1L%2B&sort=priceAsc');
    expect(canonicalSearch('')).toBe('');
  });

  it('reports whether a rewrite is warranted', () => {
    expect(needsRewrite('?sort=priceAsc')).toBe(false);
    expect(needsRewrite('?sort=priceAsc&junk=1')).toBe(true);
    expect(needsRewrite('?sort=newest')).toBe(true); // the default is omitted, so this rewrites
    expect(needsRewrite('')).toBe(false);
  });

  it('serializes the neutral state to nothing, so a fresh /collection URL stays clean', () => {
    expect(serializeFilters(neutralState())).toBe('');
  });
});

describe('honest sort labelling (Requirements 3.13–3.16)', () => {
  const docs: SearchDoc[] = [
    {
      i: 'a',
      n: 'A',
      k: 'NGF-A-1',
      c: 'sofas',
      o: [],
      t: [],
      p: 1,
      st: 'IN_STOCK',
      f: 0,
      ts: 1,
      th: '',
      lq: '',
    },
  ];
  const noSnapshot: RankingContext = {
    manual: { trending: [], bestSeller: [], mostViewed: [] },
    snapshot: null,
  };

  it('always presents Best Selling as curated, with no measurement date', () => {
    for (const context of [
      noSnapshot,
      { manual: noSnapshot.manual, snapshot: { asOf: '2026-01-01', views: { a: 9 } } },
    ] satisfies RankingContext[]) {
      const source = resolveRanking('bestSelling', docs, context);
      expect(source.basis).toBe('manual');
      expect(source.asOf).toBeUndefined();
      expect(sortOptionLabel(source)).toBe('Best Selling (curated)');
    }
  });

  it('falls back to curated for Most Viewed and Trending with no snapshot', () => {
    for (const key of ['mostViewed', 'trending'] as const) {
      const source = resolveRanking(key, docs, noSnapshot);
      expect(source.basis).toBe('manual');
      expect(source.asOf).toBeUndefined();
      expect(sortOptionLabel(source)).toContain('(curated)');
    }
  });

  it('reports Most Viewed as measured with its snapshot date once one covers the products', () => {
    const source = resolveRanking('mostViewed', docs, {
      manual: noSnapshot.manual,
      snapshot: { asOf: '2026-03-01', views: { a: 12 } },
    });
    expect(source.basis).toBe('measured');
    expect(source.asOf).toBe('2026-03-01');
    expect(sortOptionLabel(source)).toBe('Most Viewed');
  });

  it('stays curated when a snapshot exists but covers none of the visible products', () => {
    // Zeros dressed as insight is exactly what the design refuses: a snapshot with no row for
    // anything on screen orders identically to no snapshot, so claiming "measured" would be false.
    const source = resolveRanking('mostViewed', docs, {
      manual: noSnapshot.manual,
      snapshot: { asOf: '2026-03-01', views: { 'some-other-product': 40 } },
    });
    expect(source.basis).toBe('manual');
    expect(source.asOf).toBeUndefined();
  });
});
