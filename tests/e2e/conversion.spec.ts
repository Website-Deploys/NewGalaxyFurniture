import { expect, test } from '@playwright/test';

import { callerAddress } from './helpers';

/**
 * Conversion: the two numbers and the enquiry form.
 *
 * Every other page on this site exists to bring someone to one of three actions — WhatsApp, a phone
 * call, or an enquiry form — so these are the assertions that matter most commercially. Each one is
 * about a *destination*, not an appearance: a CTA that looks perfect and links to a malformed
 * `wa.me` URL is worse than no CTA, because it fails silently and only for the visitor.
 *
 * Requirements: 6.7, 7.1, 7.2, 7.5, 7.9, 10.2, 25.2.
 * Design: Conversion Surfaces.
 */

/** The exact sentence the API returns on a recorded enquiry. */
const CONFIRMATION =
  'Thank you — your enquiry has reached us. We reply on WhatsApp or by phone, usually the same day.';

test('every WhatsApp control on the site points at a well-formed wa.me URL', async ({ page }) => {
  for (const path of ['/', '/collection', '/contact', '/custom-furniture', '/reviews']) {
    await page.goto(path, { waitUntil: 'load' });
    const links = page.locator('a[data-ngf-whatsapp]');
    const count = await links.count();
    expect(count, `${path} offers no WhatsApp control`).toBeGreaterThan(0);

    for (let index = 0; index < count; index += 1) {
      const link = links.nth(index);
      const href = String(await link.getAttribute('href'));
      expect(href, `${path} link ${String(index)}`).toMatch(/^https:\/\/wa\.me\/\d{8,15}\?text=/);

      // The prefilled message is single-encoded and decodes back to real prose.
      const text = decodeURIComponent(new URL(href).searchParams.get('text') ?? '');
      expect(text.length, `${path} link ${String(index)} has an empty message`).toBeGreaterThan(10);
      expect(text, 'the message is double-encoded').not.toContain('%20');

      // Opens in a new tab, without handing the opener over.
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', /noopener/);
      // Named for a screen reader, not just decorated with an icon.
      const label = (await link.getAttribute('aria-label')) ?? (await link.innerText());
      expect(label.trim(), `${path} link ${String(index)} is unnamed`).not.toBe('');
    }
  }
});

test('every call control points at a dialable tel: URL', async ({ page }) => {
  for (const path of ['/', '/contact', '/collection']) {
    await page.goto(path, { waitUntil: 'load' });
    const links = page.locator('a[data-ngf-call]');
    const count = await links.count();
    expect(count, `${path} offers no call control`).toBeGreaterThan(0);

    for (let index = 0; index < count; index += 1) {
      const href = String(await links.nth(index).getAttribute('href'));
      // No spaces, no dashes, no parentheses — a dialer must be able to use it verbatim.
      expect(href, `${path} link ${String(index)}`).toMatch(/^tel:\+\d{8,15}$/);
      // A call must not open a new tab; it hands off to the dialer in place.
      await expect(links.nth(index)).not.toHaveAttribute('target', '_blank');
    }
  }
});

test('both numbers are described as reaching the same people', async ({ page }) => {
  await page.goto('/contact', { waitUntil: 'load' });
  const text = await page.locator('main#main').innerText();
  expect(text.toLowerCase()).toContain('orders');
});

test('the contact page enquiry form records an enquiry and confirms it in words', async ({
  page,
}) => {
  // Its own caller address, so the five-per-hour limit on the endpoint is not shared with the other
  // specs that post enquiries — see `callerAddress`.
  await page.setExtraHTTPHeaders(callerAddress('conversion-happy-path'));
  await page.goto('/contact', { waitUntil: 'load' });
  const form = page.locator('[data-ngf-enquiry-form="CONTACT"]');
  await expect(form).toBeVisible();

  await form.getByLabel('Your name').fill('Priya Raman');
  await form.getByLabel('Phone number').fill('9876543210');
  await form
    .getByLabel('Message')
    .fill('Looking for a three seater sofa in teak for a 12 by 14 living room.');

  // The form refuses a submission faster than a human could have filled it, so wait out the floor
  // rather than defeat it.
  await page.waitForTimeout(2000);
  await form.locator('button[type="submit"]').click();

  const sent = page.locator('[data-ngf-enquiry-state="sent"]');
  await expect(sent).toBeVisible({ timeout: 20_000 });
  await expect(sent.locator('[role="status"]')).toContainText(CONFIRMATION);
});

test('an invalid phone number is refused in place, keeping everything the visitor typed', async ({
  page,
}) => {
  await page.setExtraHTTPHeaders(callerAddress('conversion-invalid-phone'));
  await page.goto('/contact', { waitUntil: 'load' });
  const form = page.locator('[data-ngf-enquiry-form="CONTACT"]');

  const message = 'A long enough message to clear the minimum length rule for this field.';
  await form.getByLabel('Your name').fill('Test Visitor');
  await form.getByLabel('Phone number').fill('12345');
  await form.getByLabel('Message').fill(message);
  await page.waitForTimeout(2000);
  await form.locator('button[type="submit"]').click();

  // The phone field is named as the problem, and nothing is cleared.
  await expect(form.locator('.ngf-field-error').first()).toBeVisible({ timeout: 15_000 });
  await expect(form.getByLabel('Message')).toHaveValue(message);
  await expect(form.getByLabel('Your name')).toHaveValue('Test Visitor');
  // Both numbers are offered as the way through.
  await expect(form.locator('.ngf-form-alt')).toBeVisible();
});

test('a submission that trips the honeypot is refused without saying which trap it hit', async ({
  request,
  baseURL,
}) => {
  const response = await request.post('/api/leads', {
    headers: {
      origin: new URL(String(baseURL)).origin,
      'content-type': 'application/json',
      ...callerAddress('conversion-honeypot'),
    },
    data: {
      type: 'CONTACT',
      name: 'Spam Bot',
      phone: '9876543210',
      message: 'Buy cheap backlinks from our totally legitimate marketing service today.',
      honeypot: 'Acme Marketing Ltd',
      renderedAt: Date.now() - 5000,
    },
  });
  expect(response.status()).toBe(422);
  const body = (await response.json()) as { error?: string; message?: string };
  expect(body.error).toBe('SUBMISSION_REJECTED');
  // The refusal must not teach a bot which trap to avoid next time.
  expect(String(body.message).toLowerCase()).not.toContain('honeypot');
  expect(String(body.message).toLowerCase()).not.toContain('too fast');
});

test('a submission faster than a human could type is refused', async ({ request, baseURL }) => {
  const response = await request.post('/api/leads', {
    headers: {
      origin: new URL(String(baseURL)).origin,
      'content-type': 'application/json',
      ...callerAddress('conversion-too-fast'),
    },
    data: {
      type: 'CONTACT',
      name: 'Instant Filler',
      phone: '9876543210',
      message: 'This message arrived in less time than it takes to read the first field label.',
      honeypot: '',
      renderedAt: Date.now(),
    },
  });
  expect(response.status()).toBe(422);
  expect(((await response.json()) as { error?: string }).error).toBe('SUBMISSION_REJECTED');
});

test('an enquiry naming a product that is not published is refused, not silently accepted', async ({
  request,
  baseURL,
}) => {
  const response = await request.post('/api/leads', {
    headers: {
      origin: new URL(String(baseURL)).origin,
      'content-type': 'application/json',
      ...callerAddress('conversion-unknown-product'),
    },
    data: {
      type: 'QUICK_ENQUIRE',
      name: 'Curious Visitor',
      phone: '9876543210',
      message: 'Is this particular sofa still available in walnut, and what is the lead time?',
      productSlug: 'a-sofa-that-was-never-published',
      honeypot: '',
      renderedAt: Date.now() - 5000,
    },
  });
  expect(response.status()).toBe(422);
  expect(((await response.json()) as { error?: string }).error).toBe('PRODUCT_UNAVAILABLE');
});

test('the callback form is present on the contact page and asks only for what it needs', async ({
  page,
}) => {
  await page.goto('/contact', { waitUntil: 'load' });
  const callback = page.locator('[data-ngf-enquiry-form="CALLBACK"]');
  await expect(callback).toBeVisible();
  await expect(callback.getByLabel('Your name')).toBeVisible();
  await expect(callback.getByLabel('Phone number')).toBeVisible();
  await expect(callback.locator('button[type="submit"]')).toHaveText('Request a callback');
});

test('the custom furniture page offers its own enquiry route and an operable comparison', async ({
  page,
}) => {
  await page.goto('/custom-furniture', { waitUntil: 'load' });
  await expect(page.locator('[data-ngf-enquiry-form]')).not.toHaveCount(0);

  const slider = page.locator('[role="slider"]');
  await expect(slider).toHaveCount(1);
  await expect(slider).toHaveAttribute('aria-valuemin', '0');
  await expect(slider).toHaveAttribute('aria-valuemax', '100');
  const before = await slider.getAttribute('aria-valuenow');
  await slider.focus();
  await slider.press('ArrowRight');
  await expect(slider).not.toHaveAttribute('aria-valuenow', String(before));
});

test('the enquiry form still offers a route to the business with JavaScript unavailable', async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto('/contact', { waitUntil: 'domcontentloaded' });

  // The island cannot hydrate, so the noscript fallback is what a visitor gets — and it must reach
  // the same people.
  const html = await page.content();
  expect(html).toContain('https://wa.me/');
  expect(html).toContain('tel:+');
  await context.close();
});
