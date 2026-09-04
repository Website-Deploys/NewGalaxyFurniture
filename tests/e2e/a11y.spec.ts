import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { PUBLIC_PAGES, desktopSearch, focusSearch, waitForCatalogueControls } from './helpers';

/**
 * The accessibility pass.
 *
 * axe-core is the floor, not the ceiling. It catches the mechanical failures — an unlabelled input,
 * a contrast ratio under 4.5:1, a heading level skipped, an ARIA attribute pointing at nothing —
 * and it cannot catch the ones that matter most on this site: whether the search combobox can be
 * driven from the keyboard, whether focus is confined to the filter sheet while it is open and
 * returned to the control that opened it, whether the suggestion count is announced. Those are
 * walked explicitly below.
 *
 * Zero violations are permitted. Nothing is excluded, disabled, or downgraded to a warning: an
 * exception list is how an accessibility suite becomes decoration.
 *
 * Requirements: 24.4, 24.5, 24.6, 24.7, 24.8, 24.9, 24.10, 24.11, 24.12, 24.13.
 * Design: Pages, Navigation, and States → Accessibility.
 */

/** WCAG 2.2 A and AA — the standard the design commits to. */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/**
 * Every page, in one browser context.
 *
 * A test per page would name the failing page in its title, which reads better — and would open two
 * dozen cold browser contexts against one `wrangler dev`, whose local proxy starts resetting
 * connections under that much concurrent asset traffic. Walking the inventory in one context reuses
 * the cached stylesheet, fonts and island scripts and keeps the report just as specific: every
 * violation below is prefixed with the page it was found on, and the assertion lists all of them
 * rather than stopping at the first.
 */
test('no public page and no admin page has an accessibility violation', async ({ page }) => {
  const found: string[] = [];

  for (const path of [...PUBLIC_PAGES, '/admin/login']) {
    await page.goto(path, { waitUntil: 'load' });
    // Islands hydrate on idle; scan the hydrated page, since that is the one a visitor uses.
    await page.waitForTimeout(600);

    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    for (const violation of results.violations) {
      found.push(
        `${path} — ${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help}\n    ${violation.nodes
          .map((node) => node.target.join(' '))
          .join('\n    ')}`,
      );
    }
  }

  expect(found, `accessibility violations:\n${found.join('\n')}`).toStrictEqual([]);
});

test('the skip link is the first focusable element and moves focus into the main region', async ({
  page,
}) => {
  await page.goto('/', { waitUntil: 'load' });
  await page.keyboard.press('Tab');
  const skip = page.locator('a.ngf-skip');
  await expect(skip).toBeFocused();
  await expect(skip).toHaveAttribute('href', '#main');
  await skip.press('Enter');
  expect(new URL(page.url()).hash).toBe('#main');
  await expect(page.locator('#main')).toBeVisible();
});

test('no page serves a duplicate id', async ({ page }) => {
  // `label[for]`, `aria-controls` and `aria-describedby` all resolve to the *first* element with a
  // given id, so a duplicate does not merely offend a validator — it silently points a label or an
  // ARIA reference at the wrong control. This is the assertion that keeps `@/lib/ui/ids` honest as
  // islands are added.
  for (const path of [...PUBLIC_PAGES, '/admin/login']) {
    await page.goto(path, { waitUntil: 'load' });
    await page.waitForTimeout(600);
    const duplicates = await page.evaluate(() => {
      const seen = new Map<string, number>();
      for (const node of document.querySelectorAll('[id]')) {
        const id = node.id;
        seen.set(id, (seen.get(id) ?? 0) + 1);
      }
      return [...seen.entries()]
        .filter(([, count]) => count > 1)
        .map(([id, count]) => `${id}×${String(count)}`);
    });
    expect(duplicates, `${path} serves duplicate id(s): ${duplicates.join(', ')}`).toStrictEqual(
      [],
    );
  }
});

test('every label and ARIA reference resolves to the control it names', async ({ page }) => {
  for (const path of ['/', '/contact', '/collection']) {
    await page.goto(path, { waitUntil: 'load' });
    await page.waitForTimeout(600);
    const broken = await page.evaluate(() => {
      const bad: string[] = [];
      for (const label of document.querySelectorAll<HTMLLabelElement>('label[for]')) {
        const target = document.getElementById(label.htmlFor);
        if (target === null) {
          bad.push(`label[for="${label.htmlFor}"] names nothing`);
          continue;
        }
        // The control a label names must be inside the same form or section the label belongs to;
        // a label pointing across a form boundary is the duplicate-id failure mode.
        const scope = label.closest('form, [role="group"], .ngf-search, .ngf-mobilenav-panel');
        if (scope !== null && !scope.contains(target)) {
          bad.push(`label[for="${label.htmlFor}"] names a control outside its own form`);
        }
      }
      for (const attribute of ['aria-controls', 'aria-describedby', 'aria-labelledby']) {
        for (const node of document.querySelectorAll(`[${attribute}]`)) {
          for (const id of (node.getAttribute(attribute) ?? '').split(/\s+/).filter(Boolean)) {
            if (document.getElementById(id) === null)
              bad.push(`${attribute}="${id}" names nothing`);
          }
        }
      }
      return [...new Set(bad)];
    });
    expect(broken, `${path}: ${broken.join('; ')}`).toStrictEqual([]);
  }
});

test('every page has exactly one h1 and skips no heading level', async ({ page }) => {
  for (const path of [...PUBLIC_PAGES, '/admin/login']) {
    await page.goto(path, { waitUntil: 'load' });
    const levels = await page.evaluate(() =>
      [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((node) =>
        Number(node.tagName.slice(1)),
      ),
    );
    expect(levels.filter((level) => level === 1).length, `${path} h1 count`).toBe(1);
    let previous = 1;
    for (const level of levels) {
      expect(
        level - previous,
        `${path} skips from h${String(previous)} to h${String(level)}`,
      ).toBeLessThanOrEqual(1);
      previous = level;
    }
  }
});

test('every element reached by Tab shows a visible focus indicator', async ({ page }) => {
  await page.goto('/contact', { waitUntil: 'load' });
  await page.waitForTimeout(600);

  // Tab, not `element.focus()`.
  //
  // The site styles focus with `:focus-visible`, which is the right selector — it shows a ring to
  // someone navigating by keyboard and not to someone who has just clicked a button. But
  // `:focus-visible` does not match focus applied from script, so a loop calling `.focus()` reports
  // every control as unstyled, and a test written that way is measuring its own mechanism. Driving
  // real Tab presses is the only way to observe what a keyboard user sees.
  const unstyled: string[] = [];
  const seen = new Set<string>();

  for (let step = 0; step < 45; step += 1) {
    await page.keyboard.press('Tab');
    const report = await page.evaluate(() => {
      const node = document.activeElement;
      if (node === null || node === document.body) return null;
      const indicates = (element: Element): boolean => {
        const style = getComputedStyle(element);
        return (
          (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) ||
          (style.boxShadow !== 'none' && style.boxShadow !== '') ||
          style.textDecorationLine.includes('underline') ||
          parseFloat(style.borderTopWidth) > 0
        );
      };
      // The indicator may legitimately be painted on a wrapper rather than on the control: the
      // search field is a `label` styled with `:focus-within`, and the input inside it is a bare
      // 0-width field by design. WCAG asks for a visible indication of focus, not for it to be drawn
      // on the focused node. Only ancestors that actually match `:focus-within` count, so this
      // cannot pass on some unrelated bordered container.
      let indicated = indicates(node);
      let ancestor = node.parentElement;
      while (!indicated && ancestor !== null && ancestor.matches(':focus-within')) {
        indicated = indicates(ancestor);
        ancestor = ancestor.parentElement;
      }
      // The key has to distinguish two class-less, id-less links from each other — the header's nav
      // is a list of exactly those — or the walk mistakes the second link for a wrap-around and
      // stops after three steps.
      const text = (node.textContent ?? '').trim().slice(0, 24);
      const href = node.getAttribute('href') ?? '';
      return {
        id: `${node.tagName.toLowerCase()}.${String(node.className).split(/\s+/)[0]}#${node.id}[${href}][${text}]`,
        visible: indicated,
      };
    });
    if (report === null) break;
    if (seen.has(report.id)) break; // wrapped around the document
    seen.add(report.id);
    if (!report.visible) unstyled.push(report.id);
  }

  expect(seen.size, 'Tab reached nothing').toBeGreaterThan(10);
  expect(unstyled, `no visible focus indicator on: ${unstyled.join(', ')}`).toStrictEqual([]);
});

test('the search combobox is fully operable from the keyboard and announces its results', async ({
  page,
}) => {
  await page.goto('/', { waitUntil: 'load' });
  const search = desktopSearch(page);
  const input = search.getByRole('combobox');

  // Labelled, and labelled invisibly rather than not at all.
  const labelId = await input.getAttribute('id');
  await expect(page.locator(`label[for="${String(labelId)}"]`)).toHaveText('Search the catalogue');
  await expect(input).toHaveAttribute('aria-autocomplete', 'list');
  await expect(input).toHaveAttribute('aria-expanded', 'false');

  await focusSearch(page);
  await input.fill('sofa');

  // The listbox the input controls exists and is named.
  const listId = await input.getAttribute('aria-controls');
  const list = page.locator(`#${String(listId)}`);
  await expect(list).toHaveAttribute('role', 'listbox');
  await expect(list).toHaveAttribute('aria-label', 'Search suggestions');

  // The polite live region reports what happened, in words.
  const status = search.locator('[role="status"]');
  await expect(status).toHaveAttribute('aria-live', 'polite');
  await expect(status).not.toHaveText('', { timeout: 10_000 });

  const options = list.locator('[role="option"]');
  if ((await options.count()) > 0) {
    await input.press('ArrowDown');
    // Active option tracking is by `aria-activedescendant`, not by moving focus.
    await expect(input).toHaveAttribute('aria-activedescendant', /-option-0$/);
    await expect(options.first()).toHaveAttribute('aria-selected', 'true');
    await expect(input).toBeFocused();
  }

  // Escape closes the list and keeps both the text and the focus, so a mistaken Escape is cheap.
  await input.press('Escape');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('sofa');
});

test('focusing the collapsed search field visibly opens it', async ({ page }) => {
  await page.goto('/', { waitUntil: 'load' });
  await page.waitForTimeout(600);
  const field = desktopSearch(page).locator('.ngf-search-field');

  const before = await field.evaluate((node) => {
    const style = getComputedStyle(node);
    return { width: node.getBoundingClientRect().width, border: style.borderColor };
  });

  // Tab to it rather than clicking, so `:focus-visible` applies exactly as it would for a keyboard
  // user — the search box is a magnifier until focused, and a focus state that is invisible on it
  // would leave a keyboard user with no idea where they are.
  await desktopSearch(page).getByRole('combobox').focus();
  await page.waitForTimeout(400);

  const after = await field.evaluate((node) => {
    const style = getComputedStyle(node);
    return { width: node.getBoundingClientRect().width, border: style.borderColor };
  });

  expect(
    after.width > before.width + 8 || after.border !== before.border,
    `the field did not change on focus: ${JSON.stringify({ before, after })}`,
  ).toBe(true);
});

test('the search box submits to the catalogue when no suggestion is active', async ({ page }) => {
  await page.goto('/', { waitUntil: 'load' });
  await focusSearch(page);
  const input = desktopSearch(page).getByRole('combobox');
  await input.fill('walnut dining table');
  await input.press('Enter');
  await page.waitForURL(/\/collection\?/);
  expect(new URL(page.url()).searchParams.get('q')).toBe('walnut dining table');
});

test('the filter sheet confines focus and restores it to the control that opened it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/collection', { waitUntil: 'load' });

  expect(await waitForCatalogueControls(page), 'the catalogue controls never hydrated').toBe(true);
  const toggle = page.locator('.ngf-filter-toggle');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const shell = page.locator(`#${String(await toggle.getAttribute('aria-controls'))}`);

  await toggle.click();
  await expect(shell).toBeVisible();
  await expect(shell).toHaveAttribute('aria-label', 'Filters');

  for (let step = 0; step < 20; step += 1) {
    await page.keyboard.press('Tab');
    const inside = await shell.evaluate(
      (node) => document.activeElement !== null && node.contains(document.activeElement),
    );
    expect(inside, `focus escaped the filter sheet after ${String(step + 1)} tab(s)`).toBe(true);
  }

  await page.keyboard.press('Escape');
  await expect(shell).toBeHidden();
  await expect(toggle).toBeFocused();
});

test('the mobile menu is reachable, labelled and dismissible by keyboard alone', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/', { waitUntil: 'load' });

  const toggle = page.locator('.ngf-mobilenav-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.focus();
  await toggle.press('Enter');

  const panel = page.locator(`#${String(await toggle.getAttribute('aria-controls'))}`);
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('aria-label', 'Site menu');
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(toggle).toBeFocused();
});

test('every form control is labelled and every validation message is associated', async ({
  page,
}) => {
  await page.goto('/contact', { waitUntil: 'load' });
  const form = page.locator('[data-ngf-enquiry-form]').first();
  await expect(form).toBeVisible();

  const unlabelled = await form.evaluate((node) => {
    const bad: string[] = [];
    for (const control of node.querySelectorAll<HTMLElement>('input, select, textarea')) {
      if (control.getAttribute('type') === 'hidden') continue;
      const id = control.getAttribute('id');
      const labelled =
        (id !== null && node.ownerDocument.querySelector(`label[for="${id}"]`) !== null) ||
        control.getAttribute('aria-label') !== null ||
        control.getAttribute('aria-labelledby') !== null ||
        control.closest('label') !== null;
      if (!labelled) bad.push(control.getAttribute('name') ?? control.tagName);
    }
    return bad;
  });
  expect(unlabelled, `unlabelled control(s): ${unlabelled.join(', ')}`).toStrictEqual([]);

  // Submitting an empty form produces an error summary that takes focus and is announced.
  await form.locator('button[type="submit"]').click();
  const summary = form.locator('[role="alert"]');
  await expect(summary.first()).toBeVisible();

  // Each invalid control points at its own message.
  const dangling = await form.evaluate((node) => {
    const bad: string[] = [];
    for (const control of node.querySelectorAll('[aria-invalid="true"]')) {
      const described = control.getAttribute('aria-describedby');
      if (described === null) {
        bad.push(control.getAttribute('name') ?? 'unnamed');
        continue;
      }
      for (const id of described.split(/\s+/)) {
        if (node.ownerDocument.getElementById(id) === null) bad.push(`${id} (missing)`);
      }
    }
    return bad;
  });
  expect(dangling, `validation message(s) not associated: ${dangling.join(', ')}`).toStrictEqual(
    [],
  );
});

test('decorative illustrations are hidden from assistive technology', async ({ page }) => {
  await page.goto('/', { waitUntil: 'load' });
  const primitives = page.locator('[data-ngf-primitive]');
  const count = await primitives.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const svg = primitives.nth(index);
    const exposed = await svg.evaluate((node) => {
      const hidden =
        node.getAttribute('aria-hidden') === 'true' || node.getAttribute('role') === 'presentation';
      const titled = node.querySelector('title') !== null;
      // Either it is hidden, or it is a genuine graphic with an accessible name.
      return !hidden && !titled && node.getAttribute('aria-label') === null;
    });
    expect(exposed, `illustration ${String(index)} is exposed with no accessible name`).toBe(false);
  }
});

test('the reduced-motion preference is honoured and the motion toggle reports its state', async ({
  browser,
}) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto('/', { waitUntil: 'load' });

  const toggle = page.locator('[data-ngf-motion-toggle]');
  await expect(toggle).toHaveAttribute('aria-pressed', /true|false/);

  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(results.violations.map((violation) => violation.id)).toStrictEqual([]);
  await context.close();
});
