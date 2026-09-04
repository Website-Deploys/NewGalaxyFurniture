import { expect, test } from '@playwright/test';

/**
 * The motion performance trace.
 *
 * The three claims Requirements 21.9, 21.10 and 22.1 make about motion at runtime are claims about
 * *behaviour over time*, and none of them is observable from a unit test: whether a long task
 * exceeds 120 ms, whether a layout shift can be attributed to a revealing element, and whether a
 * frame loop is running while its target is off-screen are all questions about a real scroll in a
 * real browser.
 *
 * How each is measured:
 *
 * - **Long tasks** come from `PerformanceObserver` on the `longtask` entry type, collected in the
 *   page during the scroll rather than from a trace file — a trace would have to be parsed and the
 *   entry type is the same one the trace records.
 * - **Layout shift attribution** comes from `layout-shift` entries' own `sources` array, which names
 *   the element that moved. A shift whose source carries `data-reveal` or sits inside a parallax
 *   plane is a motion-caused shift, which is the thing that must not happen; a shift from a late
 *   font or image is a different defect and is not this test's subject.
 * - **rAF while off-screen** is measured by counting frames. The page is scrolled well past the
 *   hero, `requestAnimationFrame` is instrumented, and the count is compared before and after a
 *   wait — a loop that kept running would show a per-frame call count, and a loop that stopped
 *   shows only the probe's own frames.
 *
 * Run with `npm run test:e2e`. It is not part of `npm test`, which is the unit and property suites.
 *
 * Requirements: 21.9, 21.10, 22.1.
 */

/** Requirement 22.1's long-task ceiling for this test. */
const MAX_LONG_TASK_MS = 120;

interface CollectedShift {
  value: number;
  sources: string[];
}

test.describe('homepage motion', () => {
  test('scrolling the homepage produces no long task over 120 ms', async ({ page }) => {
    await page.goto('/');

    await page.evaluate(() => {
      const store: number[] = [];
      (window as unknown as { __longTasks: number[] }).__longTasks = store;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) store.push(entry.duration);
      }).observe({ type: 'longtask', buffered: true });
    });

    // A scroll in steps rather than one jump: a single `scrollTo` to the bottom reveals every
    // section in one frame, which is not what a visitor does and would make the measurement
    // meaningless.
    const height = await page.evaluate(() => document.body.scrollHeight);
    for (let offset = 0; offset < height; offset += 400) {
      await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), offset);
      await page.waitForTimeout(120);
    }

    const longTasks = await page.evaluate(
      () => (window as unknown as { __longTasks: number[] }).__longTasks,
    );
    const worst = longTasks.length === 0 ? 0 : Math.max(...longTasks);
    expect(worst, `longest task during the scroll was ${String(worst)} ms`).toBeLessThanOrEqual(
      MAX_LONG_TASK_MS,
    );
  });

  test('no layout shift is attributable to a motion element', async ({ page }) => {
    await page.goto('/');

    await page.evaluate(() => {
      const store: { value: number; sources: string[] }[] = [];
      (window as unknown as { __shifts: typeof store }).__shifts = store;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & {
            value: number;
            hadRecentInput: boolean;
            sources?: { node?: Node }[];
          };
          if (shift.hadRecentInput) continue;
          const sources = (shift.sources ?? [])
            .map((source) => source.node)
            .filter((node): node is Element => node instanceof Element)
            .map((node) => node.outerHTML.slice(0, 160));
          store.push({ value: shift.value, sources });
        }
      }).observe({ type: 'layout-shift', buffered: true });
    });

    const height = await page.evaluate(() => document.body.scrollHeight);
    for (let offset = 0; offset < height; offset += 400) {
      await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), offset);
      await page.waitForTimeout(120);
    }

    const shifts: CollectedShift[] = await page.evaluate(
      () => (window as unknown as { __shifts: CollectedShift[] }).__shifts,
    );
    const motionShifts = shifts.filter((shift) =>
      shift.sources.some(
        (html) =>
          html.includes('data-reveal') ||
          html.includes('data-parallax-plane') ||
          html.includes('data-ngf-primitive'),
      ),
    );
    expect(motionShifts, JSON.stringify(motionShifts, null, 2)).toHaveLength(0);
  });

  test('no frame loop runs while the hero is off-screen', async ({ page }) => {
    await page.goto('/');

    // Instrument rAF before scrolling, then scroll the hero well out of view.
    await page.evaluate(() => {
      const counter = { frames: 0 };
      (window as unknown as { __raf: typeof counter }).__raf = counter;
      const original = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback: FrameRequestCallback) => {
        counter.frames += 1;
        return original(callback);
      };
    });

    await page.evaluate(() => window.scrollTo({ top: 3000, behavior: 'instant' }));
    await page.waitForTimeout(500);

    const before = await page.evaluate(
      () => (window as unknown as { __raf: { frames: number } }).__raf.frames,
    );
    await page.waitForTimeout(1000);
    const after = await page.evaluate(
      () => (window as unknown as { __raf: { frames: number } }).__raf.frames,
    );

    // A running loop requests one frame per frame — roughly sixty over a second. A handful of
    // frames from other work is expected; sixty is a loop that did not stop.
    expect(after - before, 'frames requested while the hero was off-screen').toBeLessThan(10);
  });

  test('no frame loop runs while the tab is hidden', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      const counter = { frames: 0 };
      (window as unknown as { __raf: typeof counter }).__raf = counter;
      const original = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback: FrameRequestCallback) => {
        counter.frames += 1;
        return original(callback);
      };
    });

    // The hero is in view, so the loop is running.
    await page.waitForTimeout(300);

    // Emulate a hidden tab. `visibilitychange` is what the loop listens for.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    const before = await page.evaluate(
      () => (window as unknown as { __raf: { frames: number } }).__raf.frames,
    );
    await page.waitForTimeout(800);
    const after = await page.evaluate(
      () => (window as unknown as { __raf: { frames: number } }).__raf.frames,
    );
    expect(after - before, 'frames requested while the tab was hidden').toBeLessThan(10);
  });

  test('under reduced motion every illustration is fully drawn on the first paint', async ({
    browser,
  }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.goto('/');

    // Requirement 21.11: the final drawn state, immediately — nothing invisible, nothing
    // half-drawn, and no parallax offset held.
    const primitives = page.locator('[data-ngf-primitive]');
    const count = await primitives.count();
    expect(count).toBeGreaterThan(0);

    for (let index = 0; index < count; index += 1) {
      const svg = primitives.nth(index);
      const drawn = await svg.evaluate((element) =>
        [...element.querySelectorAll('.ngf-draw')].every(
          (path) => getComputedStyle(path).strokeDashoffset === '0px',
        ),
      );
      expect(drawn, `primitive ${String(index)} is fully drawn`).toBe(true);
    }

    for (const plane of await page.locator('[data-parallax-plane]').all()) {
      const transform = await plane.evaluate((element) => getComputedStyle(element).transform);
      expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(transform);
    }

    // And the control that must stay operable: the before/after slider on the custom page.
    await page.goto('/custom-furniture');
    const slider = page.locator('[role="slider"]');
    await slider.focus();
    const start = await slider.getAttribute('aria-valuenow');
    await slider.press('ArrowRight');
    expect(await slider.getAttribute('aria-valuenow')).not.toBe(start);

    await context.close();
  });
});
