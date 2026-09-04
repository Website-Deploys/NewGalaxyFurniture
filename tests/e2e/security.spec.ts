import { expect, test } from '@playwright/test';

import {
  ADMIN_API_PROBES,
  ADMIN_PAGES,
  PUBLIC_PAGES,
  SECURITY_HEADERS,
  callerAddress as fromAddress,
} from './helpers';

/**
 * The security probes.
 *
 * Three separate claims, each checked against the running Worker rather than the module that
 * implements it:
 *
 * 1. **The policy is real and nothing violates it.** `scripts/audit-csp.ts` proves the built HTML
 *    contains nothing the policy forbids; this proves the browser agrees, by failing on any
 *    `securitypolicyviolation` event fired while a page loads and hydrates. A policy that is served
 *    but breaks the page is worse than none, because the breakage is silent.
 * 2. **Every guarded route refuses an unauthenticated caller, and refuses it before doing
 *    anything.** The status code is the observable part; the property test
 *    (`tests/property/admin-guard.property.test.ts`, Properties 52 and 53) is what proves no
 *    binding was touched, with spies this layer cannot install.
 * 3. **A file's contents decide whether it is an image, not its name or its declared type.** The
 *    magic-byte allowlist is re-checked end to end through the public enquiry field, with a
 *    disguised SVG, PHP, HTML, ELF and ZIP payload — each one named `.jpg` and declared
 *    `image/jpeg`, which is precisely the attack the sniffer exists to defeat.
 *
 * Requirements: 10.1, 10.8, 10.9, 15.3, 15.4, 25.4, 25.6, 25.9, 25.10.
 * Design: Testing Strategy → Cross-cutting checklists (Security).
 */

/** Payloads that are not images, each disguised as one. The first bytes are what matters. */
const DISGUISED_PAYLOADS: readonly { name: string; body: Buffer }[] = [
  { name: 'svg', body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>') },
  { name: 'php', body: Buffer.from('<?php system($_GET["c"]); ?>') },
  { name: 'html', body: Buffer.from('<!doctype html><html><script>alert(1)</script></html>') },
  { name: 'elf', body: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00]) },
  { name: 'zip', body: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]) },
  { name: 'xml-prologue-svg', body: Buffer.from('<?xml version="1.0"?><svg><g/></svg>') },
];

test('no page produces a content security policy violation', async ({ page }) => {
  const violations: string[] = [];
  await page.addInitScript(() => {
    const store: string[] = [];
    (window as unknown as { __csp: string[] }).__csp = store;
    document.addEventListener('securitypolicyviolation', (event) => {
      store.push(`${event.violatedDirective} ← ${event.blockedURI}`);
    });
  });

  for (const path of [...PUBLIC_PAGES, '/admin/login']) {
    await page.goto(path, { waitUntil: 'load' });
    // Hydration is idle-scheduled; give the islands a chance to run and be blocked if they would be.
    await page.waitForTimeout(400);
    const found = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
    for (const violation of found) violations.push(`${path}: ${violation}`);
  }

  expect(violations, violations.join('\n')).toStrictEqual([]);
});

test('every response carries every required security header', async ({ request }) => {
  for (const path of ['/', '/collection', '/contact', '/robots.txt', '/sitemap.xml']) {
    const response = await request.get(path);
    expect(response.status(), `${path} did not answer 200`).toBe(200);
    const headers = response.headers();
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(headers[name], `${path} is missing ${name}`).toBe(value);
    }
    const csp = headers['content-security-policy'];
    expect(csp, `${path} has no content security policy`).toBeTruthy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'self'");
    // Scripts are allowlisted by hash, never by a blanket exemption.
    const scriptSrc = /script-src ([^;]+)/.exec(csp ?? '')?.[1] ?? '';
    expect(scriptSrc, 'script-src permits inline script').not.toContain("'unsafe-inline'");
    expect(scriptSrc, 'script-src permits eval').not.toContain("'unsafe-eval'");
  }
});

test('a public page is not marked noindex and an admin page always is', async ({ request }) => {
  const publicResponse = await request.get('/');
  expect(publicResponse.headers()['x-robots-tag']).toBeUndefined();

  for (const path of ADMIN_PAGES) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.headers()['x-robots-tag'], `${path}`).toBe('noindex, nofollow');
    expect(response.headers()['cache-control'], `${path}`).toContain('no-store');
  }
});

test('every admin page redirects a signed-out visitor to the sign-in page, preserving the target', async ({
  request,
}) => {
  for (const path of ADMIN_PAGES) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect([302, 303, 307], `${path} did not redirect`).toContain(response.status());
    const location = String(response.headers()['location']);
    const url = new URL(location, 'http://x');
    expect(url.pathname, `${path} redirected somewhere other than the sign-in page`).toBe(
      '/admin/login',
    );
    expect(url.searchParams.get('next'), `${path} lost the requested target`).toBe(path);
  }
});

test('the sign-in page never bounces the visitor to an off-site target', async ({ page }) => {
  await page.goto('/admin/login?next=https://evil.example/steal', { waitUntil: 'load' });
  const next = await page.locator('input[name="next"]').inputValue();
  expect(next.startsWith('/admin')).toBe(true);
  expect(next).not.toContain('evil.example');
});

test('every guarded admin route refuses an unauthenticated caller', async ({
  request,
  baseURL,
}) => {
  const origin = new URL(String(baseURL)).origin;

  for (const probe of ADMIN_API_PROBES) {
    const safe = probe.method === 'GET';
    const response = await request.fetch(probe.path, {
      method: probe.method,
      // A same-origin Origin header on the unsafe methods, so the origin check passes and the
      // *session* check is what refuses — otherwise every probe would stop at ORIGIN_MISMATCH and
      // prove nothing about authentication.
      //
      // And no payload, deliberately: the guard refuses before it would read one, so a body adds
      // nothing to the assertion, and an unread request body is what makes `wrangler dev`'s local
      // proxy drop the connection mid-suite (`disconnected: Connection reset by peer` inside
      // workerd's own IO, not in any application frame). The content-type header alone is what the
      // guard's media-type check reads.
      headers: safe ? {} : { origin, 'content-type': 'application/json' },
      maxRedirects: 0,
    });

    expect(
      response.status(),
      `${probe.method} ${probe.path} answered ${String(response.status())}`,
    ).toBe(401);
    const body = (await response.json()) as { error?: string; message?: string };
    expect(body.error).toBe('UNAUTHENTICATED');
    // The refusal clears any cookie the caller might be holding, and is never cached.
    expect(response.headers()['cache-control']).toContain('no-store');
    expect(response.headers()['x-robots-tag']).toBe('noindex, nofollow');
  }
});

test('an unsafe admin request with no origin is refused before the session is read', async ({
  request,
}) => {
  const response = await request.post('/api/admin/products', {
    headers: { 'content-type': 'application/json' },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(403);
  expect(((await response.json()) as { error?: string }).error).toBe('ORIGIN_MISMATCH');
});

test('a cross-origin unsafe admin request is refused', async ({ request }) => {
  const response = await request.post('/api/admin/login', {
    headers: {
      origin: 'https://evil.example',
      'content-type': 'application/json',
      ...fromAddress('login-cross-origin'),
    },
    data: { email: 'e2e@localhost.invalid', password: 'irrelevant' },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(403);
  expect(((await response.json()) as { error?: string }).error).toBe('ORIGIN_MISMATCH');
});

test('a method an endpoint does not implement is refused, and reveals nothing', async ({
  request,
  baseURL,
}) => {
  // Asked of the public enquiry endpoint rather than an admin one, deliberately. `/api/leads`
  // exports an `ALL` handler, so an unimplemented method reaches application code and is answered by
  // it — which is the behaviour worth asserting. An admin route with no handler for the method never
  // reaches the guard at all: Astro's router does not match it and the static 404 page is served,
  // which asserts nothing about the guard and, under `wrangler dev`, reliably resets the local proxy
  // connection.
  const response = await request.fetch('/api/leads', {
    method: 'PUT',
    headers: { origin: new URL(String(baseURL)).origin, 'content-type': 'application/json' },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(405);
  const body = await response.text();
  expect(body).not.toContain('ADMIN_ROUTES');
  expect(body).not.toContain('GITHUB');
  // No internal detail: no source path, no module frame, no thrown value.
  expect(body).not.toContain('/projects/');
  expect(body).not.toContain('node_modules');
  expect(body).not.toMatch(/\bat async\b/);
});

test('a disguised payload is rejected by the public enquiry image field regardless of its name or declared type', async ({
  request,
  baseURL,
}) => {
  for (const payload of DISGUISED_PAYLOADS) {
    const response = await request.post('/api/leads', {
      headers: {
        origin: new URL(String(baseURL)).origin,
        ...fromAddress(`upload-${payload.name}`),
      },
      multipart: {
        type: 'CONTACT',
        name: 'Upload probe',
        phone: '9876543210',
        message: 'Checking that the file contents decide what this file is, not its name.',
        honeypot: '',
        // Old enough to clear the minimum form age.
        renderedAt: String(Date.now() - 5_000),
        image: {
          name: `${payload.name}-disguised.jpg`,
          mimeType: 'image/jpeg',
          buffer: payload.body,
        },
      },
    });

    expect(
      response.status(),
      `${payload.name} disguised as a JPEG answered ${String(response.status())}`,
    ).toBe(422);
    const body = (await response.json()) as {
      error?: string;
      fields?: Record<string, string[]>;
    };
    expect(body.error).toBe('VALIDATION_FAILED');
    expect(
      body.fields?.['image']?.join(' '),
      `${payload.name} was rejected without naming the image field`,
    ).toBeTruthy();
  }
});

test('an oversized enquiry body is refused without being read', async ({ request, baseURL }) => {
  const response = await request.post('/api/leads', {
    headers: {
      origin: new URL(String(baseURL)).origin,
      'content-type': 'application/json',
      'content-length': String(20 * 1024 * 1024),
      ...fromAddress('oversized'),
    },
    data: { type: 'CONTACT', name: 'x', phone: '9876543210', message: 'x'.repeat(64) },
  });
  expect([413, 422]).toContain(response.status());
});

test('the enquiry endpoint stops accepting after five submissions from one address', async ({
  request,
  baseURL,
}) => {
  const origin = new URL(String(baseURL)).origin;
  const address = fromAddress('rate-limit-probe');
  const statuses: number[] = [];

  // Six identical, *valid-shaped* submissions. The limit is consumed before validation, so what is
  // being counted here is attempts, not successes — which is the point of a limiter.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await request.post('/api/leads', {
      headers: { origin, 'content-type': 'application/json', ...address },
      data: {
        type: 'CONTACT',
        name: 'Rate Limit Probe',
        phone: '9876543210',
        message: `Submission number ${String(attempt + 1)} from a single address, in one hour.`,
        honeypot: '',
        renderedAt: Date.now() - 5000,
      },
    });
    statuses.push(response.status());
    if (response.status() === 429) {
      expect(((await response.json()) as { error?: string }).error).toBe('RATE_LIMITED');
      expect(response.headers()['retry-after'], 'a 429 must say when to come back').toBeTruthy();
      break;
    }
  }

  expect(statuses, `statuses were ${statuses.join(', ')}`).toContain(429);
  expect(statuses.indexOf(429), 'the limit fired before the fifth submission').toBeGreaterThan(4);
});

test('the enquiry endpoint refuses a method it does not implement', async ({ request }) => {
  const response = await request.get('/api/leads', { maxRedirects: 0 });
  expect(response.status()).toBe(405);
});

test('no credential-shaped string is served to a browser', async ({ request }) => {
  // A last, coarse net over what the browser can actually fetch. The exhaustive version of this is
  // Property 51 over every file under `dist/` (`tests/unit/security.build-output.test.ts`).
  const patterns = [
    /gh[pousr]_[A-Za-z0-9]{16,}/,
    /AKIA[0-9A-Z]{16}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /sk-[A-Za-z0-9]{20,}/,
    /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  ];
  for (const path of ['/', '/collection', '/contact', '/admin/login']) {
    const body = await (await request.get(path)).text();
    for (const pattern of patterns) {
      expect(pattern.test(body), `${path} matches ${String(pattern)}`).toBe(false);
    }
  }
});
