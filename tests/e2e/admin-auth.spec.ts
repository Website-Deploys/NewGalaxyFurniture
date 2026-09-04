import { expect, test } from '@playwright/test';

import { ADMIN_PAGES, callerAddress, e2eCredentials, signIn } from './helpers';

/**
 * Admin authentication, end to end.
 *
 * The session policy itself — the 2 h idle window, the 12 h absolute cap, the 1/5/15/60 lockout
 * ladder, the per-address isolation, the hashed rate-limit keys — is asserted against *real local
 * bindings* by `tests/unit/auth.session.integration.test.ts`, which can manipulate time and inspect
 * KV in ways a browser cannot. This spec covers the part only a browser can: that the form works,
 * that the cookie the browser receives is the one the design specifies, that a wrong password is
 * refused without telling an attacker which half was wrong, that a signed-out visitor is redirected
 * with their destination preserved, and that signing out actually revokes the session rather than
 * just navigating away.
 *
 * The credentials come from `npm run e2e:prepare`, which seeds a local-only `owner` account with a
 * generated password. Nothing is hard-coded, and nothing here can reach a remote database.
 *
 * **Not covered here, and why.** The create → review → publish lifecycle, image upload, the AI
 * assistant, and review/lead management all write through the GitHub Contents API, which needs a
 * `GITHUB_TOKEN` for a real repository. Exercising them locally would either require a live token in
 * a test run or a mocked GitHub, and the mocked version already exists and is more thorough than a
 * browser could be (`tests/unit/github.pipeline.integration.test.ts`,
 * `tests/unit/products.admin.test.ts`, `tests/unit/images.upload.integration.test.ts`,
 * `tests/unit/ai.generate.integration.test.ts`, `tests/unit/categories.reviews.admin.test.ts`).
 *
 * Requirements: 10.1, 10.2, 10.5, 10.8, 10.10, 10.14, 25.4.
 * Design: Admin Authentication.
 */

const credentials = e2eCredentials();

test.describe('the sign-in page', () => {
  test('renders a labelled form and names itself', async ({ page }) => {
    await page.goto('/admin/login', { waitUntil: 'load' });

    await expect(page.locator('h1')).toHaveText('Admin sign in');
    await expect(page.locator('label[for="email"]')).toHaveText('Email address');
    await expect(page.locator('label[for="password"]')).toHaveText('Password');
    await expect(page.locator('#email')).toHaveAttribute('autocomplete', 'username');
    await expect(page.locator('#password')).toHaveAttribute('autocomplete', 'current-password');
    await expect(page.locator('#login-submit')).toHaveText('Sign in');
    await expect(page.locator('#login-error')).toBeHidden();
  });

  test('is the one admin page a signed-out visitor may see', async ({ page }) => {
    const response = await page.goto('/admin/login', { waitUntil: 'load' });
    expect(response?.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe('/admin/login');
  });

  test('refuses a wrong password without revealing which half was wrong', async ({ page }) => {
    await page.setExtraHTTPHeaders(callerAddress('login-wrong-password'));
    await page.goto('/admin/login', { waitUntil: 'load' });
    await page.locator('#email').fill('nobody@localhost.invalid');
    await page.locator('#password').fill('definitely-not-the-password');
    await page.locator('#login-submit').click();

    const error = page.locator('#login-error');
    await expect(error).toBeVisible({ timeout: 15_000 });
    const message = (await error.innerText()).toLowerCase();
    // The message must not distinguish "no such account" from "wrong password".
    expect(message).not.toContain('no such');
    expect(message).not.toContain('unknown email');
    expect(message).not.toContain('does not exist');
    // Still on the sign-in page, with the fields marked and focus placed usefully.
    expect(new URL(page.url()).pathname).toBe('/admin/login');
    await expect(page.locator('#password')).toHaveAttribute('aria-invalid', 'true');
  });

  test('answers the same status for an unknown address as for a wrong password', async ({
    request,
    baseURL,
  }) => {
    const origin = new URL(String(baseURL)).origin;
    const unknown = await request.post('/api/admin/login', {
      headers: {
        origin,
        'content-type': 'application/json',
        ...callerAddress('login-unknown-address'),
      },
      data: { email: 'nobody-at-all@localhost.invalid', password: 'x'.repeat(20) },
    });
    expect(unknown.status()).toBe(401);
    expect(((await unknown.json()) as { error?: string }).error).toBe('INVALID_CREDENTIALS');
  });

  test('refuses a login attempt that is not JSON', async ({ request, baseURL }) => {
    const response = await request.post('/api/admin/login', {
      headers: {
        origin: new URL(String(baseURL)).origin,
        'content-type': 'text/plain',
        ...callerAddress('login-wrong-media-type'),
      },
      data: 'email=x&password=y',
    });
    expect(response.status()).toBe(415);
    expect(((await response.json()) as { error?: string }).error).toBe('UNSUPPORTED_MEDIA_TYPE');
  });
});

test.describe('route protection', () => {
  for (const path of ADMIN_PAGES) {
    test(`${path} sends a signed-out visitor to sign in, remembering where they were going`, async ({
      page,
    }) => {
      await page.goto(path, { waitUntil: 'load' });
      const url = new URL(page.url());
      expect(url.pathname).toBe('/admin/login');
      expect(url.searchParams.get('next')).toBe(path);
      // And the form carries the destination forward, so signing in lands where they meant to go.
      await expect(page.locator('input[name="next"]')).toHaveValue(path);
    });
  }

  test('a preview URL is never cacheable and never public', async ({ request }) => {
    const response = await request.get('/admin/preview/p_probe000001', { maxRedirects: 0 });
    expect(response.headers()['cache-control']).toContain('no-store');
    expect(response.headers()['x-robots-tag']).toBe('noindex, nofollow');
    expect([302, 303, 307]).toContain(response.status());
  });
});

test.describe('a real session', () => {
  // Serial, because every test here signs in: five concurrent logins against one local KV namespace
  // and one 700 ms response floor is contention this suite has no reason to create.
  test.describe.configure({ mode: 'serial' });

  test.skip(
    credentials === null,
    'no local admin account was seeded — run `npm run e2e:prepare` (the Playwright webServer does it automatically)',
  );

  test('signing in issues a hardened session cookie and lands on the dashboard', async ({
    page,
    context,
  }) => {
    const { email, password } = credentials as { email: string; password: string };

    await signIn(page, email, password);
    await expect(page.locator('h1')).toHaveCount(1);

    const cookie = (await context.cookies()).find((candidate) => candidate.name === 'ngf_session');
    expect(cookie, 'no session cookie was issued').toBeTruthy();
    expect(cookie?.httpOnly, 'the session cookie is readable from script').toBe(true);
    expect(cookie?.sameSite).toBe('Lax');
    expect(cookie?.path).toBe('/');
    // Opaque: the cookie must carry no email, no role and no signature to pick apart.
    expect(String(cookie?.value)).not.toContain('@');
    expect(String(cookie?.value)).not.toContain('owner');
    expect(String(cookie?.value).length).toBeGreaterThan(20);
  });

  test('the session endpoint issues a CSRF token that is not the session id', async ({ page }) => {
    const { email, password } = credentials as { email: string; password: string };
    await signIn(page, email, password);

    const session = await page.request.get('/api/admin/session');
    expect(session.status()).toBe(200);
    const body = (await session.json()) as {
      user?: { email?: string; role?: string };
      csrfToken?: string;
      permissions?: string[];
    };
    expect(body.user?.email).toBe(email);
    expect(body.user?.role).toBe('owner');
    expect(String(body.csrfToken).length).toBeGreaterThan(20);
    expect(body.permissions?.length ?? 0).toBeGreaterThan(0);
    // Never cached — a shared browser must not hand the next person a session document.
    expect(session.headers()['cache-control']).toContain('no-store');

    const cookie = (await page.context().cookies()).find((c) => c.name === 'ngf_session');
    expect(body.csrfToken, 'the CSRF token is the session id').not.toBe(cookie?.value);
  });

  test('an authenticated write with no CSRF token is refused', async ({ page, baseURL }) => {
    const { email, password } = credentials as { email: string; password: string };
    await signIn(page, email, password);

    const origin = new URL(String(baseURL)).origin;
    // No request body on any of these, deliberately. The guard refuses before it would read one, so a
    // payload adds nothing to the assertion — and a request whose body the handler never consumes is
    // what makes `wrangler dev`'s local proxy reset the connection and, often enough, take the whole
    // server down mid-suite. The content-type header is all the media-type check reads.
    const noToken = await page.request.post('/api/admin/rehydrate', {
      headers: { origin, 'content-type': 'application/json' },
    });
    expect(noToken.status()).toBe(403);
    expect(((await noToken.json()) as { error?: string }).error).toBe('CSRF_INVALID');

    const wrongToken = await page.request.post('/api/admin/rehydrate', {
      headers: { origin, 'content-type': 'application/json', 'x-csrf-token': 'not-the-token' },
    });
    expect(wrongToken.status()).toBe(403);
    expect(((await wrongToken.json()) as { error?: string }).error).toBe('CSRF_INVALID');
  });

  test('signing out revokes the session rather than merely navigating away', async ({
    page,
    baseURL,
  }) => {
    const { email, password } = credentials as { email: string; password: string };
    await signIn(page, email, password);

    const before = (await page.context().cookies()).find((c) => c.name === 'ngf_session');
    const token = (
      (await (await page.request.get('/api/admin/session')).json()) as {
        csrfToken?: string;
      }
    ).csrfToken;

    const logout = await page.request.post('/api/admin/logout', {
      headers: {
        origin: new URL(String(baseURL)).origin,
        'content-type': 'application/json',
        'x-csrf-token': String(token),
      },
    });
    expect(logout.status()).toBe(204);

    // Replaying the captured cookie must not work: the record is gone, not just the cookie.
    const replay = await page.request.get('/api/admin/session', {
      headers: { cookie: `ngf_session=${String(before?.value)}` },
    });
    expect(replay.status()).toBe(401);

    await page.goto('/admin', { waitUntil: 'load' });
    expect(new URL(page.url()).pathname).toBe('/admin/login');
  });

  test('an admin page is reachable once signed in and still marked noindex', async ({ page }) => {
    const { email, password } = credentials as { email: string; password: string };
    await signIn(page, email, password);

    const response = await page.goto('/admin/settings', { waitUntil: 'load' });
    expect(response?.status()).toBe(200);
    expect(response?.headers()['x-robots-tag']).toBe('noindex, nofollow');
    expect(new URL(page.url()).pathname).toBe('/admin/settings');
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('nav[aria-label="Admin navigation"]')).toBeVisible();
  });
});
