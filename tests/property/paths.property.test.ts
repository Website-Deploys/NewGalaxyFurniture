import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ALLOWED_PATTERNS, resolveContentPath } from '@/lib/github/paths';
import { toSlug } from '@/lib/slug';
import { assertProperty } from './config';
import { slugArb } from './arbitraries';

/**
 * Properties 21–24 — the path allowlist.
 *
 * These four properties are the ones that make "path traversal is not a class of bug
 * here" checkable rather than aspirational. Together they pin the function from both
 * sides: 21 and 22 bound what it *accepts*, 23 bounds what it *rejects*, and 24 says
 * it always answers.
 *
 * Design → Correctness Properties → Properties 21, 22, 23, 24.
 */

/** The legitimate paths the pipeline actually derives. */
const legitimatePathArb: fc.Arbitrary<string> = fc.oneof(
  slugArb.map((slug) => `data/products/${slug}.json`),
  slugArb.map((slug) => `data/categories/${slug}.json`),
  fc
    .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {
      minLength: 10,
      maxLength: 10,
    })
    .map((chars) => `data/reviews/rev_${chars.join('')}.json`),
  fc.constantFrom(
    'data/site/settings.json',
    'data/site/homepage.json',
    'data/site/rankings.json',
    'data/site/redirects.json',
    // The nightly analytics snapshot (task 18.5). It is written by the scheduled handler through
    // the same client, so it goes through the same allowlist as every operator write.
    'data/snapshots/analytics.json',
  ),
);

/**
 * The tokens that turn a path into an attack. Percent-encoded, double-encoded,
 * over-long UTF-8, and separator variants are all here because each has historically
 * defeated a filter that handled only the literal form.
 */
const TRAVERSAL_TOKENS = [
  '..',
  '../',
  '/..',
  '..\\',
  '.',
  './',
  '//',
  '\\',
  '\0',
  '%2e%2e%2f',
  '%2e%2e/',
  '%2E%2E%2F',
  '%252e%252e%252f',
  '%252e',
  '%2f',
  '%5c',
  '%00',
  '%c0%ae%c0%ae/', // over-long UTF-8 encoding of '.'
  '....//',
  '..;/',
] as const;

const traversalTokenArb = fc.constantFrom(...TRAVERSAL_TOKENS);

/**
 * A mutation arbitrary: splice a hostile token into an otherwise-legitimate path at
 * an arbitrary position, which is what the design's strategy asks for. Splicing at
 * *every* position matters — a filter that checks only the prefix passes a token
 * buried mid-path.
 */
const splicedAttackArb: fc.Arbitrary<string> = fc
  .tuple(legitimatePathArb, traversalTokenArb, fc.nat())
  .map(([path, token, offset]) => {
    const at = offset % (path.length + 1);
    return `${path.slice(0, at)}${token}${path.slice(at)}`;
  });

/** Traversal attempts that reach outside `data/` in the classic shapes. */
const escapeAttemptArb: fc.Arbitrary<string> = fc.constantFrom(
  '../package.json',
  '../../package.json',
  'data/products/../../package.json',
  'data/products/../../.github/workflows/ci.yml',
  'data/../src/lib/auth/password.ts',
  'data/products/%2e%2e%2f%2e%2e%2fwrangler.toml',
  '/etc/passwd',
  '/data/products/sofa.json',
  'data//products/sofa.json',
  'data/products//sofa.json',
  'data/products/./sofa.json',
  'data\\products\\sofa.json',
  'data/products/sofa.json\0.png',
  'data/products/sofa.json%00.png',
  'C:\\data\\products\\sofa.json',
  'file:///data/products/sofa.json',
  // `data/snapshots/analytics.json` is now allowlisted — it is the cron's one write — so the
  // neighbouring shapes are what must still be refused: the directory admits exactly one filename.
  'data/snapshots/analytics.json.bak',
  'data/snapshots/analytics.JSON',
  'data/snapshots/rankings.json',
  'data/snapshots/2025-01-01/analytics.json',
  'data/products/sofa.JSON',
  'data/products/Sofa.json',
  'data/products/sofa.json.bak',
  'data/products/sofa.yaml',
  'migrations/0001_admin.sql',
  '.env',
  'wrangler.toml',
);

/** Adversarial strings that must not crash the resolver. */
const hostileStringArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 5, arbitrary: fc.string({ unit: 'binary', maxLength: 120 }) },
  { weight: 3, arbitrary: fc.string({ maxLength: 120 }) },
  { weight: 2, arbitrary: splicedAttackArb },
  { weight: 2, arbitrary: escapeAttemptArb },
  { weight: 1, arbitrary: legitimatePathArb },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      '',
      '%',
      '%%',
      '%2',
      '%zz',
      '%e0%80',
      '%f0%9f', // truncated 4-byte sequence
      '\uD800', // lone high surrogate
      '\uDFFF', // lone low surrogate
      '\uD800\uD800',
      'data/products/\uD800.json',
      'data/products/cafe\u0301.json', // NFD
      'data/products/café.json', // NFC
      'data/products/\uFEFFsofa.json',
      'data/products/ｓｏｆａ.json', // fullwidth
      'a'.repeat(5000),
      '../'.repeat(500),
      '\n',
      '\r\n',
      '\t',
    ),
  },
);

describe('Property 21: Traversal and encoding attacks are rejected', () => {
  it('rejects every path carrying a traversal or encoding token', () => {
    assertProperty(
      fc.property(splicedAttackArb, (candidate) => {
        expect(resolveContentPath(candidate)).toBeNull();
      }),
    );
  });

  it('rejects the classic escape shapes explicitly', () => {
    for (const candidate of [
      '../package.json',
      '../../package.json',
      'data/products/../../package.json',
      'data/products/%2e%2e%2fsofa.json',
      'data/products/%252e%252e%252fsofa.json',
      '/data/products/sofa.json',
      'data\\products\\sofa.json',
      'data/products/sofa.json\0.png',
      'data/products/sofa.json%00.png',
      'data/products/./sofa.json',
      'data//products/sofa.json',
    ]) {
      expect(resolveContentPath(candidate), candidate).toBeNull();
    }
  });

  it('rejects an NFD form even when its NFC form would be admitted', () => {
    assertProperty(
      fc.property(fc.constantFrom('cafe\u0301', 'nin\u0303o', 'A\u030A'), (decomposed) => {
        const candidate = `data/products/${decomposed}.json`;
        // Guard the premise: these are genuinely not NFC, so the property is not
        // vacuous.
        expect(candidate).not.toBe(candidate.normalize('NFC'));
        expect(resolveContentPath(candidate)).toBeNull();
      }),
    );
  });

  it('rejects any candidate whose token set includes an attack marker, generically', () => {
    // The universally quantified form of Property 21: not a fixed corpus, but any
    // string at all that *contains* one of the markers.
    assertProperty(
      fc.property(hostileStringArb, (candidate) => {
        const hasMarker =
          candidate.includes('..') ||
          candidate.startsWith('/') ||
          candidate.includes('\\') ||
          candidate.includes('\0') ||
          /%2e/i.test(candidate) ||
          /%2f/i.test(candidate) ||
          /%5c/i.test(candidate) ||
          /%00/i.test(candidate);
        if (hasMarker) expect(resolveContentPath(candidate)).toBeNull();
      }),
      { numRuns: 1000 },
    );
  });
});

describe('Property 22: Accepted paths are always allowlisted data paths', () => {
  it('returns only strings matching an ALLOWED_PATTERNS entry and starting with data/', () => {
    assertProperty(
      fc.property(hostileStringArb, (candidate) => {
        const resolved = resolveContentPath(candidate);
        if (resolved === null) return; // post-condition applies to non-null results only
        expect(resolved.startsWith('data/')).toBe(true);
        expect(ALLOWED_PATTERNS.some((pattern) => pattern.test(resolved))).toBe(true);
        // The output is fully validated in its final form: re-resolving is a fixed
        // point, so nothing downstream can decode or normalize it into a new value.
        expect(resolveContentPath(resolved)).toBe(resolved);
      }),
      { numRuns: 1000 },
    );
  });

  it('holds over unconstrained Unicode, as the design’s strategy specifies', () => {
    assertProperty(
      fc.property(fc.string({ unit: 'binary', maxLength: 200 }), (candidate) => {
        const resolved = resolveContentPath(candidate);
        if (resolved === null) return;
        expect(ALLOWED_PATTERNS.some((pattern) => pattern.test(resolved))).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  it('admits nothing outside the five allowlisted content directories', () => {
    assertProperty(
      fc.property(hostileStringArb, (candidate) => {
        const resolved = resolveContentPath(candidate);
        if (resolved === null) return;
        const directory = resolved.slice(0, resolved.lastIndexOf('/'));
        expect([
          'data/products',
          'data/categories',
          'data/reviews',
          'data/site',
          'data/snapshots',
        ]).toContain(directory);
        expect(resolved.endsWith('.json')).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('Property 23: Legitimate product paths are never rejected', () => {
  it('resolves every well-formed slug', () => {
    assertProperty(
      fc.property(slugArb, (slug) => {
        const path = `data/products/${slug}.json`;
        expect(resolveContentPath(path)).toBe(path);
      }),
    );
  });

  it('resolves paths built from toSlug output, which is what the pipeline derives', () => {
    // Closing the loop with the real generator: whatever `toSlug` can produce must be
    // writable, or a legitimately named product becomes unsaveable.
    assertProperty(
      fc.property(
        fc.oneof(
          fc.string({ minLength: 1, maxLength: 140 }),
          fc.string({ unit: 'grapheme', minLength: 1, maxLength: 140 }),
          fc.constantFrom(
            'Luxury L-Shape Sofa',
            'Café Chaise Longue',
            'सोफा सेट',
            'Sofa 🛋️ Set',
            '   ',
            '---',
            'A'.repeat(200),
          ),
        ),
        (name) => {
          const slug = toSlug(name);
          const path = `data/products/${slug}.json`;
          expect(resolveContentPath(path)).toBe(path);
        },
      ),
    );
  });

  it('resolves every legitimate category, review and site path', () => {
    assertProperty(
      fc.property(legitimatePathArb, (path) => {
        expect(resolveContentPath(path)).toBe(path);
      }),
    );
  });
});

describe('Property 24: Path resolution is total', () => {
  it('never throws, for any input', () => {
    assertProperty(
      fc.property(hostileStringArb, (candidate) => {
        // A throw here is the failure; the return value is irrelevant to this property.
        expect(() => resolveContentPath(candidate)).not.toThrow();
        const result = resolveContentPath(candidate);
        expect(result === null || typeof result === 'string').toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  it('never throws on lone surrogates or malformed percent sequences', () => {
    assertProperty(
      fc.property(
        fc.oneof(
          // Lone surrogates: unpaired code units that break naive UTF-8 handling.
          fc.integer({ min: 0xd800, max: 0xdfff }).map((code) => String.fromCharCode(code)),
          fc
            .array(fc.integer({ min: 0xd800, max: 0xdfff }), { minLength: 1, maxLength: 6 })
            .map((codes) => codes.map((code) => String.fromCharCode(code)).join('')),
          // Malformed percent sequences of every truncation length.
          fc
            .tuple(fc.constantFrom('%', '%2', '%e0', '%f0%9f', '%c0'), fc.string({ maxLength: 8 }))
            .map(([head, tail]) => `${head}${tail}`),
          fc.string({ unit: 'binary', maxLength: 60 }).map((s) => `data/products/${s}.json`),
        ),
        (candidate) => {
          expect(() => resolveContentPath(candidate)).not.toThrow();
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('never throws on a non-string, despite the signature', () => {
    // Totality has to survive the JSON boundary: a caller upstream of `JSON.parse`
    // cannot guarantee the type, and this function must not be the place that learns
    // it the hard way.
    for (const value of [null, undefined, 0, 1, true, {}, [], Symbol.iterator]) {
      const candidate: string = value as never;
      expect(() => resolveContentPath(candidate)).not.toThrow();
      expect(resolveContentPath(candidate)).toBeNull();
    }
  });
});
