import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FRAMEWORK_INLINE_SCRIPTS } from '@/lib/security/inline-script-hashes';
import {
  applySecurityHeaders,
  CONTENT_SECURITY_POLICY,
  SECURITY_HEADERS,
} from '@/lib/security/headers';

/**
 * The security headers, and the one thing that can silently go wrong with them.
 *
 * They are applied in two places because the platform requires it: `src/middleware.ts` for whatever
 * the Worker answers, and `public/_headers` for the prerendered HTML that Cloudflare serves from the
 * asset store without invoking the Worker at all. Two application points is a fact; two *values* is
 * a defect, and a silent one — the static pages would quietly carry a weaker policy than the
 * authenticated ones, which is precisely backwards.
 *
 * So the load-bearing test in this file is the one that parses `public/_headers` and compares every
 * value against the module. The rest assert the policy's content.
 *
 * Requirements: 25.9, 25.10.
 */

const HEADERS_FILE = fileURLToPath(new URL('../../public/_headers', import.meta.url));

/** `_headers` blocks: a path line in column 0, then indented `Name: value` pairs. */
function parseHeadersFile(text: string): Map<string, Map<string, string>> {
  const blocks = new Map<string, Map<string, string>>();
  let current: Map<string, string> | null = null;

  for (const raw of text.split('\n')) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      current = new Map();
      blocks.set(raw.trim(), current);
      continue;
    }
    const separator = raw.indexOf(':');
    if (separator === -1 || current === null) continue;
    current.set(raw.slice(0, separator).trim().toLowerCase(), raw.slice(separator + 1).trim());
  }
  return blocks;
}

describe('the security header set', () => {
  it('carries every header the design names', () => {
    expect(SECURITY_HEADERS['strict-transport-security']).toBe(
      'max-age=31536000; includeSubDomains; preload',
    );
    expect(SECURITY_HEADERS['x-content-type-options']).toBe('nosniff');
    expect(SECURITY_HEADERS['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(SECURITY_HEADERS['x-frame-options']).toBe('DENY');
    expect(SECURITY_HEADERS['cross-origin-opener-policy']).toBe('same-origin');
    expect(SECURITY_HEADERS['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()');
  });

  it('denies camera, microphone and geolocation with an empty allowlist, not a wildcard', () => {
    const policy = SECURITY_HEADERS['permissions-policy'] ?? '';
    for (const feature of ['camera', 'microphone', 'geolocation']) {
      expect(policy).toContain(`${feature}=()`);
      expect(policy).not.toContain(`${feature}=*`);
      expect(policy).not.toContain(`${feature}=(self)`);
    }
  });

  it('sets, rather than appends, so two policies are never intersected', () => {
    const response = new Response('ok', {
      headers: { 'content-security-policy': 'default-src *' },
    });
    applySecurityHeaders(response);
    expect(response.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    // `Headers.get` joins duplicates with ", "; a single value proves there is exactly one.
    expect(response.headers.get('content-security-policy')).not.toContain(',');
  });

  it('applies to every response the Worker returns', () => {
    const response = applySecurityHeaders(new Response(null, { status: 301 }));
    for (const name of Object.keys(SECURITY_HEADERS)) {
      expect(response.headers.get(name), name).toBe(SECURITY_HEADERS[name]);
    }
  });
});

describe('the content security policy', () => {
  const directives = new Map(
    CONTENT_SECURITY_POLICY.split(';')
      .map((part) => part.trim())
      .filter((part) => part !== '')
      .map((part) => {
        const [name = '', ...values] = part.split(/\s+/);
        return [name, values.join(' ')] as const;
      }),
  );

  it('states every directive the design lists', () => {
    expect(directives.get('default-src')).toBe("'self'");
    expect(directives.get('img-src')).toBe("'self' data:");
    expect(directives.get('style-src')).toBe("'self' 'unsafe-inline'");
    expect(directives.get('connect-src')).toBe("'self' https://api.whatsapp.com");
    expect(directives.get('font-src')).toBe("'self'");
    expect(directives.get('frame-src')).toBe("'none'");
    expect(directives.get('object-src')).toBe("'none'");
    expect(directives.get('base-uri')).toBe("'none'");
    expect(directives.get('form-action')).toBe("'self'");
    expect(directives.get('frame-ancestors')).toBe("'none'");
  });

  it("allows scripts from 'self' and the four framework hashes, and nothing else", () => {
    const scriptSrc = (directives.get('script-src') ?? '').split(' ');
    expect(scriptSrc[0]).toBe("'self'");
    expect(scriptSrc.slice(1).sort()).toEqual(
      FRAMEWORK_INLINE_SCRIPTS.map((entry) => `'${entry.hash}'`).sort(),
    );
  });

  it("never grants 'unsafe-inline' or 'unsafe-eval' to scripts", () => {
    const scriptSrc = directives.get('script-src') ?? '';
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(scriptSrc).not.toContain('unsafe-eval');
    expect(scriptSrc).not.toContain('strict-dynamic');
    expect(scriptSrc).not.toContain('*');
  });

  it('grants unsafe-inline to styles only, which is the one concession the design makes', () => {
    const unsafeInline = [...directives.entries()].filter(([, value]) =>
      value.includes("'unsafe-inline'"),
    );
    expect(unsafeInline.map(([name]) => name)).toEqual(['style-src']);
  });

  it('keeps the inline-script allowlist to a closed set of framework bootstraps', () => {
    // Four: the astro-island runtime plus the three client directives the site uses. Growth here
    // is the signal that something started inlining a script of ours.
    expect(FRAMEWORK_INLINE_SCRIPTS).toHaveLength(4);
    for (const entry of FRAMEWORK_INLINE_SCRIPTS) {
      expect(entry.hash).toMatch(/^sha256-[A-Za-z0-9+/]{43}=$/);
      expect(entry.source).toContain('astro');
    }
  });
});

describe('public/_headers', () => {
  const blocks = parseHeadersFile(readFileSync(HEADERS_FILE, 'utf8'));

  it('applies the set to every path', () => {
    expect([...blocks.keys()]).toContain('/*');
  });

  it('carries the identical value for every header in the module', () => {
    const wildcard = blocks.get('/*');
    expect(wildcard).toBeDefined();
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(wildcard?.get(name), `${name} in public/_headers`).toBe(value);
    }
  });

  it('declares no header the module does not know about', () => {
    const wildcard = blocks.get('/*') ?? new Map<string, string>();
    expect([...wildcard.keys()].sort()).toEqual(Object.keys(SECURITY_HEADERS).sort());
  });

  it('caches the unhashed pre-paint script for a bounded time, not immutably', () => {
    const cacheControl = blocks.get('/ngf-motion-preference.js')?.get('cache-control') ?? '';
    expect(cacheControl).toContain('max-age=');
    // Immutable on an unhashed URL means a fix can never be shipped to a returning visitor.
    expect(cacheControl).not.toContain('immutable');
  });
});
