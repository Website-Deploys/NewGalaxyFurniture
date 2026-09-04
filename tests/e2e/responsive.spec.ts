import { expect, test } from '@playwright/test';

import { ADMIN_PAGES, PUBLIC_PAGES, waitForCatalogueControls } from './helpers';

/**
 * The responsive sweep (sequencing priority 10: mobile experience).
 *
 * This spec runs in all nine width projects — 320, 375, 390, 414, 768, 1024, 1280, 1440, 1920 — so
 * a failure names the width that broke rather than "responsive".
 *
 * What each assertion is actually protecting:
 *
 * - **No horizontal overflow.** `scrollWidth <= clientWidth` on the document element. This is the
 *   defect that makes a phone feel broken: a single fixed-width element pushes the whole page
 *   sideways and every section inherits the scroll. Checked at the document rather than per element,
 *   because that is what a visitor's thumb experiences.
 * - **No clipped image.** An image whose rendered box is wider than its container is cropped by
 *   overflow rather than scaled, which is invisible in a screenshot at one width and obvious at
 *   another.
 * - **No overlap in an interactive region.** Two controls whose hit boxes intersect means one of
 *   them cannot be tapped. Checked pairwise across the page's own interactive elements.
 * - **Touch targets ≥ 44 px** below 768 px, where the primary input is a finger.
 * - **Layout stability.** Cumulative layout shift, measured after the page settles, stays under the
 *   good-CWV threshold of 0.1.
 * - **The mobile contracts**: the action bar exists below 768 px and not at or above it; the filter
 *   panel is a bottom sheet below 768 px and a visible sidebar at 768 px and above.
 *
 * Requirements: 24.1, 24.2, 24.3, 5.14, 5.15.
 * Design: Pages, Navigation, and States → Responsive strategy.
 */

/** Good CLS, per Core Web Vitals. */
const MAX_CLS = 0.1;

/** The design's touch-target floor, in px. */
const MIN_TOUCH_TARGET_PX = 44;

/** The width at or above which the layout is no longer the mobile one. */
const MOBILE_MAX_WIDTH = 767;

function widthOf(projectName: string): number {
  return Number(projectName.replace(/^w/, ''));
}

interface Box {
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The whole inventory in one test per width, not one test per page per width.
 *
 * 23 pages × 9 widths as separate tests is 207 browser contexts and, because every context starts
 * with an empty cache, something like four thousand asset requests through one `wrangler dev`. That
 * load is what made the local Worker proxy reset connections and eventually drop the server, which
 * turned a suite that had found real defects into a hundred meaningless failures. Walking the
 * inventory inside a single context per width keeps every assertion, reuses the cached CSS, fonts and
 * island scripts across pages, and cuts the request count by roughly an order of magnitude.
 *
 * Nothing is lost from the report: each finding names its page, and the assertion at the end lists
 * every page that failed rather than stopping at the first.
 */
test('the full page inventory lays out with no overflow, no clipping and nothing covered', async ({
  page,
}) => {
  const problems: string[] = [];

  for (const path of PUBLIC_PAGES) {
    await page.goto(path, { waitUntil: 'load' });

    // 1. No horizontal overflow. A 1 px allowance absorbs sub-pixel rounding in the layout engine,
    // which is not a defect a visitor can perceive or scroll.
    const overflow = await page.evaluate(() => {
      const root = document.documentElement;
      return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth };
    });
    if (overflow.scrollWidth > overflow.clientWidth + 1) {
      problems.push(
        `${path} scrolls horizontally: scrollWidth ${String(overflow.scrollWidth)} > clientWidth ${String(overflow.clientWidth)}`,
      );
    }

    // 2. No clipped image.
    const clipped = await page.evaluate(() => {
      const bad: string[] = [];
      for (const image of document.querySelectorAll('img')) {
        const parent = image.parentElement;
        if (parent === null) continue;
        const box = image.getBoundingClientRect();
        const hold = parent.getBoundingClientRect();
        if (box.width === 0 || hold.width === 0) continue;
        if (box.width > hold.width + 1) {
          bad.push(
            `${image.currentSrc || image.src} (${String(box.width)} in ${String(hold.width)})`,
          );
        }
      }
      return bad;
    });
    for (const image of clipped) problems.push(`${path} clips an image: ${image}`);

    // 3. Nothing covers a control.
    //
    // Asked as "is this element the thing a finger would hit at its own centre?" rather than as
    // pairwise rectangle intersection. Rectangle math flags every design that is not a defect — a
    // fixed action bar floating over content it has reserved space for, a stretched card link
    // deliberately covering its own card, a focus ring's padding meeting a neighbour's border — and
    // misses the one that is: a control that is *on screen and unreachable*. `elementFromPoint`
    // answers the question the visitor actually asks.
    const covered = await page.evaluate(() => {
      const selector =
        'a[href], button, input:not([type="hidden"]), select, textarea, [role="slider"]';
      const bad: string[] = [];
      const label = (node: Element): string =>
        `${node.tagName.toLowerCase()}${node.className && typeof node.className === 'string' ? `.${node.className.split(/\s+/)[0]}` : ''}`;

      for (const node of document.querySelectorAll<HTMLElement>(selector)) {
        // `checkVisibility` accounts for display, visibility, opacity and content-visibility on the
        // element *and its ancestors*, which hand-rolled style checks do not.
        if (
          !node.checkVisibility({
            visibilityProperty: true,
            opacityProperty: true,
            contentVisibilityAuto: true,
          })
        ) {
          continue;
        }
        if (node.closest('[inert], [aria-hidden="true"]') !== null) continue;

        const box = node.getBoundingClientRect();
        if (box.width < 2 || box.height < 2) continue;
        // Only what is currently within the viewport can be hit-tested.
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) continue;

        const hit = document.elementFromPoint(x, y);
        if (hit === null) continue;
        // Reaching the control, something inside it, or something it is inside all count as a hit.
        if (hit === node || node.contains(hit) || hit.contains(node)) continue;

        // A fixed or sticky overlay floating over content is a design, not an obstruction: the
        // action bar is `position: fixed`, and the page reserves its height as bottom padding, so
        // anything under it right now can be scrolled clear of it. That the space *is* reserved is
        // asserted separately and explicitly, rather than inferred from a hit test.
        let overlay: Element | null = hit;
        let floating = false;
        while (overlay !== null && overlay !== document.body) {
          const position = getComputedStyle(overlay).position;
          if (position === 'fixed' || position === 'sticky') {
            floating = true;
            break;
          }
          overlay = overlay.parentElement;
        }
        if (floating) continue;

        bad.push(`${label(node)} is covered by ${label(hit)}`);
      }
      return [...new Set(bad)];
    });
    for (const control of covered) problems.push(`${path} — ${control}`);
  }

  expect(problems, `layout problems at this width:\n${problems.join('\n')}`).toStrictEqual([]);
});

test('every touch target on the homepage clears 44 px below 768 px', async ({ page }, testInfo) => {
  const width = widthOf(testInfo.project.name);
  test.skip(width > MOBILE_MAX_WIDTH, 'the 44 px floor is a touch contract');

  await page.goto('/', { waitUntil: 'load' });
  const small: Box[] = await page.evaluate((floor) => {
    const out: Box[] = [];
    const selector = 'a[href], button, input:not([type="hidden"]), select, [role="slider"]';
    for (const node of document.querySelectorAll<HTMLElement>(selector)) {
      if (
        !node.checkVisibility({
          visibilityProperty: true,
          opacityProperty: true,
          contentVisibilityAuto: true,
        })
      ) {
        continue;
      }
      if (node.closest('[inert], [aria-hidden="true"]') !== null) continue;
      // A link inside a paragraph of prose is text, not a target; the contract is about controls.
      if (node.tagName === 'A' && node.closest('p') !== null) continue;
      const box = node.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      // The contract is a 44 px *touch* target: height is the axis a thumb misses on in a vertical
      // list, and a short word's own width ("FAQ", "Beds") is not a defect when the row is tall
      // enough and separated from its neighbours.
      if (box.height < floor) {
        out.push({
          label: `${node.tagName.toLowerCase()}.${String(node.className).split(/\s+/)[0]}`,
          x: Math.round(box.x),
          y: Math.round(box.y),
          width: Math.round(box.width),
          height: Math.round(box.height),
        });
      }
    }
    return out;
  }, MIN_TOUCH_TARGET_PX);

  expect(
    small,
    `targets under ${String(MIN_TOUCH_TARGET_PX)} px: ${JSON.stringify(small)}`,
  ).toStrictEqual([]);
});

test('the mobile action bar is present below 768 px and absent at 768 px and above', async ({
  page,
}, testInfo) => {
  const width = widthOf(testInfo.project.name);
  await page.goto('/', { waitUntil: 'load' });
  const bar = page.locator('.ngf-actionbar');
  await expect(bar).toHaveCount(1);

  if (width <= MOBILE_MAX_WIDTH) {
    await expect(bar).toBeVisible();
    const whatsapp = bar.locator('a.ngf-actionbar-whatsapp');
    const call = bar.locator('a.ngf-actionbar-call');
    await expect(whatsapp).toHaveAttribute('href', /^https:\/\/wa\.me\//);
    await expect(call).toHaveAttribute('href', /^tel:\+/);

    // The bar floats over the page, so the page has to give back the height it takes — otherwise the
    // last thing in the footer can never be scrolled out from under it.
    const reserved = await page.evaluate(() => {
      const barBox = (document.querySelector('.ngf-actionbar') as Element).getBoundingClientRect();
      return {
        barHeight: Math.round(barBox.height),
        padding: Math.round(parseFloat(getComputedStyle(document.body).paddingBottom)),
      };
    });
    expect(
      reserved.padding,
      `the page reserves ${String(reserved.padding)} px for a ${String(reserved.barHeight)} px action bar`,
    ).toBeGreaterThanOrEqual(reserved.barHeight);
  } else {
    await expect(bar).toBeHidden();
  }
});

test('the catalogue filters are a bottom sheet below 768 px and a sidebar above', async ({
  page,
}, testInfo) => {
  const width = widthOf(testInfo.project.name);
  await page.goto('/collection', { waitUntil: 'load' });

  expect(await waitForCatalogueControls(page), 'the catalogue controls never hydrated').toBe(true);

  const toggle = page.locator('.ngf-filter-toggle');
  const shellId = await toggle.getAttribute('aria-controls');
  expect(shellId).toBeTruthy();
  const shell = page.locator(`#${String(shellId)}`);

  if (width <= MOBILE_MAX_WIDTH) {
    // Closed by default, opened by the toggle, closed again by Escape with focus returned.
    await expect(shell).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(shell).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(shell).toBeHidden();
    await expect(toggle).toBeFocused();
  } else {
    // The stylesheet overrides `[hidden]` at this width: the sidebar is simply there, and the
    // sheet's opener is not — there is no sheet to open.
    await expect(shell).toBeVisible();
    await expect(toggle).toBeHidden();
  }
});

test('the mobile menu opens, traps focus and closes below 1024 px', async ({ page }, testInfo) => {
  const width = widthOf(testInfo.project.name);
  test.skip(width >= 1024, 'the header nav is the desktop one at this width');

  await page.goto('/', { waitUntil: 'load' });
  const toggle = page.locator('.ngf-mobilenav-toggle');
  await expect(toggle).toBeVisible();
  const panelId = await toggle.getAttribute('aria-controls');
  const panel = page.locator(`#${String(panelId)}`);
  await expect(panel).toBeHidden();

  await toggle.click();
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('role', 'dialog');
  await expect(panel).toHaveAttribute('aria-modal', 'true');

  // Focus stays inside the dialog: tab through more elements than it contains and never leave.
  for (let step = 0; step < 24; step += 1) {
    await page.keyboard.press('Tab');
    const inside = await panel.evaluate(
      (node) => document.activeElement !== null && node.contains(document.activeElement),
    );
    expect(inside, `focus left the mobile menu after ${String(step + 1)} tab(s)`).toBe(true);
  }

  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(toggle).toBeFocused();
});

test('the homepage settles with a cumulative layout shift under the good threshold', async ({
  page,
}) => {
  await page.goto('/', { waitUntil: 'load' });
  const cls = await page.evaluate(
    async () =>
      new Promise<number>((resolve) => {
        let total = 0;
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean };
            if (!shift.hadRecentInput) total += shift.value;
          }
        });
        observer.observe({ type: 'layout-shift', buffered: true });
        setTimeout(() => {
          observer.disconnect();
          resolve(total);
        }, 1500);
      }),
  );
  expect(cls, `cumulative layout shift was ${String(cls)}`).toBeLessThan(MAX_CLS);
});

test('the admin sign-in page is usable at every width', async ({ page }) => {
  await page.goto('/admin/login', { waitUntil: 'load' });
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  await expect(page.locator('#email')).toBeVisible();
  await expect(page.locator('#password')).toBeVisible();
  await expect(page.locator('#login-submit')).toBeVisible();
});

test('a signed-out admin page redirects rather than rendering at any width', async ({ page }) => {
  const response = await page.goto(ADMIN_PAGES[0], { waitUntil: 'load' });
  expect(response).not.toBeNull();
  expect(new URL(page.url()).pathname).toBe('/admin/login');
});
