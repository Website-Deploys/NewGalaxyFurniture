import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  clampPosition,
  clipFor,
  DEFAULT_POSITION,
  handleOffset,
  PAGE_STEP,
  positionFromKey,
  positionFromPointer,
  STEP,
  valueText,
} from '@/lib/motion/before-after';
import { createFrameLoop, type FrameScheduler } from '@/lib/motion/frame-loop';
import {
  createRevealController,
  REVEAL_ATTRIBUTE,
  REVEALED_ATTRIBUTE,
  type ObserverEntryLike,
  type ObserverFactory,
  type ObserverLike,
} from '@/lib/motion/reveal';
import { createMotionValue, viewportProgress } from '@/lib/motion/useScrollProgress';
import { motionAllowed, NO_PREFERENCE_QUERY } from '@/lib/motion/preference';
import {
  MAX_PLANE_OFFSET_PX,
  NEUTRAL_TRANSFORM,
  parallaxProgress,
  planeOffset,
  planeTransform,
} from '@/lib/motion/parallax';
import { PRIMITIVE_NAMES, primitiveAttrs } from '@/components/motion/primitive';

/**
 * The motion system's decisions, without a browser.
 *
 * Everything asserted here is a rule from Requirement 21: what may animate, when a loop may run,
 * what reduced motion does, and what the budgets are. They are unit tests rather than e2e ones
 * because each is a statement about a value or a call sequence — "no frame is requested while the
 * element is off-screen" is checkable by counting calls to an injected scheduler, and is far more
 * precise than watching a rendered page.
 *
 * The reduced-motion assertions are the ones worth reading twice. Requirement 21.11 is a set of
 * claims about what happens when nothing animates, and the usual way to get it wrong is to make the
 * animation faster instead of absent — so several tests below assert that nothing was *allocated*,
 * not merely that nothing moved.
 *
 * Requirements: 21.5, 21.7, 21.8, 21.9, 21.10, 21.11, 21.13, 21.15, 24.5, 24.10.
 */

/* -------------------------------------------------------------------------- */
/* The preference gate (Requirements 21.11, 21.13)                            */
/* -------------------------------------------------------------------------- */

describe('the preference gate', () => {
  it('allows motion only when the platform has no preference and the visitor has not opted out', () => {
    expect(motionAllowed({ noPreference: true, override: null })).toBe(true);
    expect(motionAllowed({ noPreference: true, override: 'auto' })).toBe(true);
    // Either signal alone suppresses motion.
    expect(motionAllowed({ noPreference: false, override: null })).toBe(false);
    expect(motionAllowed({ noPreference: true, override: 'off' })).toBe(false);
    expect(motionAllowed({ noPreference: false, override: 'off' })).toBe(false);
  });

  it('cannot be used to override the platform preference back on', () => {
    // The footer toggle only ever *adds* `data-motion="off"`. Even if something set it to a value
    // meaning "on", a platform request for reduced motion still wins — which is the whole point of
    // OR-ing rather than letting the site have the last word.
    for (const override of [null, 'auto', 'on', 'yes', '']) {
      expect(motionAllowed({ noPreference: false, override }), String(override)).toBe(false);
    }
  });

  it('asks the media query in the positive, as the design specifies', () => {
    expect(NO_PREFERENCE_QUERY).toBe('(prefers-reduced-motion: no-preference)');
  });

  it('treats an unknown platform answer as a request for stillness', () => {
    // `noPreference: false` is what a browser with no `matchMedia` produces. Erring towards a
    // plainer page is the recoverable direction of that error.
    expect(motionAllowed({ noPreference: false, override: null })).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The reveal controller (Requirements 21.10, 21.11)                          */
/* -------------------------------------------------------------------------- */

/** Enough of an `Element` for the controller. Records the attributes it is given. */
function fakeElement(): Element & { attrs: Record<string, string>; style: { willChange: string } } {
  const attrs: Record<string, string> = {};
  return {
    attrs,
    style: { willChange: '' },
    setAttribute(name: string, value: string) {
      attrs[name] = value;
    },
    hasAttribute(name: string) {
      return name in attrs;
    },
    removeAttribute(name: string) {
      delete attrs[name];
    },
  } as unknown as Element & { attrs: Record<string, string>; style: { willChange: string } };
}

interface FakeObserver extends ObserverLike {
  observed: Element[];
  unobserved: Element[];
  disconnects: number;
  fire(entries: ObserverEntryLike[]): void;
}

function observerHarness(): { created: FakeObserver[]; factory: ObserverFactory } {
  const created: FakeObserver[] = [];
  const factory: ObserverFactory = (callback) => {
    const observer: FakeObserver = {
      observed: [],
      unobserved: [],
      disconnects: 0,
      observe(target) {
        this.observed.push(target);
      },
      unobserve(target) {
        this.unobserved.push(target);
      },
      disconnect() {
        this.disconnects += 1;
      },
      fire(entries) {
        callback(entries);
      },
    };
    created.push(observer);
    return observer;
  };
  return { created, factory };
}

describe('the reveal controller', () => {
  it('uses one observer for every element on the page', () => {
    const { created, factory } = observerHarness();
    const controller = createRevealController({ observerFactory: factory });
    const elements = Array.from({ length: 20 }, () => fakeElement());
    for (const element of elements) controller.observe(element);

    // Requirement 21.10's spirit and the design's tier two: "one observer instance for the whole
    // page", not one per element. Sixty product cards must not mean sixty observers.
    expect(created).toHaveLength(1);
    expect(created[0]?.observed).toHaveLength(20);
    expect(controller.pending()).toBe(20);
  });

  it('sets data-revealed and unobserves, so an element reveals exactly once', () => {
    const { created, factory } = observerHarness();
    const controller = createRevealController({ observerFactory: factory });
    const element = fakeElement();
    controller.observe(element);

    created[0]?.fire([{ target: element, isIntersecting: true }]);
    expect(element.attrs[REVEALED_ATTRIBUTE]).toBe('');
    expect(created[0]?.unobserved).toEqual([element]);
    expect(controller.pending()).toBe(0);
  });

  it('ignores an entry that is not intersecting', () => {
    const { created, factory } = observerHarness();
    const controller = createRevealController({ observerFactory: factory });
    const element = fakeElement();
    controller.observe(element);

    created[0]?.fire([{ target: element, isIntersecting: false }]);
    expect(element.attrs[REVEALED_ATTRIBUTE]).toBeUndefined();
    expect(controller.pending()).toBe(1);
  });

  it('releases the observer once nothing is left to watch', () => {
    const { created, factory } = observerHarness();
    const controller = createRevealController({ observerFactory: factory });
    const a = fakeElement();
    const b = fakeElement();
    controller.observe(a);
    controller.observe(b);

    created[0]?.fire([{ target: a, isIntersecting: true }]);
    expect(created[0]?.disconnects).toBe(0);
    created[0]?.fire([{ target: b, isIntersecting: true }]);
    // A page that has finished revealing costs nothing at all.
    expect(created[0]?.disconnects).toBe(1);
  });

  it('does not observe an element twice', () => {
    const { created, factory } = observerHarness();
    const controller = createRevealController({ observerFactory: factory });
    const element = fakeElement();
    controller.observe(element);
    controller.observe(element);
    expect(created[0]?.observed).toHaveLength(1);
  });

  it('applies will-change on trigger and removes it on completion', () => {
    vi.useFakeTimers();
    try {
      const { created, factory } = observerHarness();
      const controller = createRevealController({ observerFactory: factory });
      const element = fakeElement();
      controller.observe(element);

      created[0]?.fire([{ target: element, isIntersecting: true }]);
      expect(element.style.willChange).toBe('transform, opacity');

      // "never left standing": a promoted layer costs memory for as long as it exists.
      vi.advanceTimersByTime(2000);
      expect(element.style.willChange).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('promotes an SVG primitive too, not only HTML elements', () => {
    // The nine primitives are `SVGElement`, not `HTMLElement`. An `instanceof HTMLElement` guard
    // here would skip `will-change` on every illustration in the system — the elements with the
    // most paths to composite.
    vi.useFakeTimers();
    try {
      const { created, factory } = observerHarness();
      const controller = createRevealController({ observerFactory: factory });
      const svgLike = fakeElement();
      controller.observe(svgLike);
      created[0]?.fire([{ target: svgLike, isIntersecting: true }]);
      expect(svgLike.style.willChange).toBe('transform, opacity');
    } finally {
      vi.useRealTimers();
    }
  });

  it('under reduced motion allocates no observer at all and reveals immediately', () => {
    const { created, factory } = observerHarness();
    const controller = createRevealController({ animate: false, observerFactory: factory });
    const element = fakeElement();
    controller.observe(element);

    // Requirement 21.11: the element is in its final state, and nothing was allocated to get it
    // there. Not a faster animation — no animation, and no observer.
    expect(created).toHaveLength(0);
    expect(element.attrs[REVEALED_ATTRIBUTE]).toBe('');
    expect(element.style.willChange).toBe('');
    expect(controller.pending()).toBe(0);
  });

  it('names its attributes as the stylesheet expects', () => {
    expect(REVEAL_ATTRIBUTE).toBe('data-reveal');
    expect(REVEALED_ATTRIBUTE).toBe('data-revealed');
  });
});

/* -------------------------------------------------------------------------- */
/* The frame loop (Requirements 21.10, 21.11)                                 */
/* -------------------------------------------------------------------------- */

interface LoopHarness {
  scheduler: FrameScheduler;
  requests: number;
  cancels: number;
  setIntersecting(value: boolean): void;
  setHidden(value: boolean): void;
  /** Run one scheduled frame, if any. */
  frame(): void;
}

function loopHarness(): LoopHarness {
  let pending: (() => void) | null = null;
  let onIntersect: ((value: boolean) => void) | null = null;
  let onHidden: ((value: boolean) => void) | null = null;
  const harness: LoopHarness = {
    requests: 0,
    cancels: 0,
    scheduler: {
      request(callback) {
        harness.requests += 1;
        pending = callback;
        return harness.requests;
      },
      cancel() {
        harness.cancels += 1;
        pending = null;
      },
      observe(_target, onChange) {
        onIntersect = onChange;
        return () => {
          onIntersect = null;
        };
      },
      onVisibilityChange(listener) {
        onHidden = listener;
        return () => {
          onHidden = null;
        };
      },
    },
    setIntersecting(value) {
      onIntersect?.(value);
    },
    setHidden(value) {
      onHidden?.(value);
    },
    frame() {
      const next = pending;
      pending = null;
      next?.();
    },
  };
  return harness;
}

describe('the frame loop', () => {
  const target = fakeElement();

  it('requests no frame until its element is on screen', () => {
    const harness = loopHarness();
    const onFrame = vi.fn();
    const loop = createFrameLoop({ target, animate: true, onFrame, scheduler: harness.scheduler });

    loop.start();
    // Started, observing, and not running: Requirement 21.10 forbids a loop while the target is
    // off-screen, and "forbids" here means no frame is scheduled — not a frame that returns early.
    expect(harness.requests).toBe(0);
    expect(loop.running()).toBe(false);

    harness.setIntersecting(true);
    expect(loop.running()).toBe(true);
    harness.frame();
    expect(onFrame).toHaveBeenCalledTimes(1);
  });

  it('cancels when the element leaves the viewport, and settles it', () => {
    const harness = loopHarness();
    const onIdle = vi.fn();
    const loop = createFrameLoop({
      target,
      animate: true,
      onFrame: () => undefined,
      onIdle,
      scheduler: harness.scheduler,
    });

    loop.start();
    harness.setIntersecting(true);
    harness.setIntersecting(false);
    expect(harness.cancels).toBe(1);
    expect(loop.running()).toBe(false);
    expect(onIdle).toHaveBeenCalled();
  });

  it('cancels on visibilitychange to hidden and resumes only when still intersecting', () => {
    const harness = loopHarness();
    const loop = createFrameLoop({
      target,
      animate: true,
      onFrame: () => undefined,
      scheduler: harness.scheduler,
    });

    loop.start();
    harness.setIntersecting(true);
    expect(loop.running()).toBe(true);

    harness.setHidden(true);
    expect(loop.running()).toBe(false);

    harness.setHidden(false);
    expect(loop.running()).toBe(true);

    // Hidden *and* scrolled away: coming back to the tab must not restart a loop for an element
    // that is no longer on screen.
    harness.setHidden(true);
    harness.setIntersecting(false);
    harness.setHidden(false);
    expect(loop.running()).toBe(false);
  });

  it('promotes its planes only while it is running', () => {
    const harness = loopHarness();
    const plane = { style: { willChange: '' } } as unknown as HTMLElement;
    const loop = createFrameLoop({
      target,
      animate: true,
      promote: [plane],
      onFrame: () => undefined,
      scheduler: harness.scheduler,
    });

    loop.start();
    expect(plane.style.willChange).toBe('');
    harness.setIntersecting(true);
    expect(plane.style.willChange).toBe('transform');
    harness.setIntersecting(false);
    expect(plane.style.willChange).toBe('');
  });

  it('under reduced motion never starts, and settles once', () => {
    const harness = loopHarness();
    const onFrame = vi.fn();
    const onIdle = vi.fn();
    const loop = createFrameLoop({
      target,
      animate: false,
      onFrame,
      onIdle,
      scheduler: harness.scheduler,
    });

    loop.start();
    // Requirement 21.11: "the rAF hooks return early and never start". Nothing was observed, no
    // visibility listener was added, and no frame was requested — and the one thing that did happen
    // is the neutral settle, which is what flattens the parallax planes.
    expect(harness.requests).toBe(0);
    expect(onFrame).not.toHaveBeenCalled();
    expect(onIdle).toHaveBeenCalledTimes(1);

    // And it stays that way: an intersection change cannot start it, because nothing subscribed.
    harness.setIntersecting(true);
    expect(harness.requests).toBe(0);
    expect(loop.running()).toBe(false);
  });

  it('is idempotent on start and releases everything on destroy', () => {
    const harness = loopHarness();
    const loop = createFrameLoop({
      target,
      animate: true,
      onFrame: () => undefined,
      scheduler: harness.scheduler,
    });
    loop.start();
    loop.start();
    harness.setIntersecting(true);
    expect(harness.requests).toBe(1);

    loop.destroy();
    expect(loop.running()).toBe(false);
    harness.setIntersecting(true);
    expect(harness.requests).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Parallax (Requirements 7.6, 7.11, 21.8)                                    */
/* -------------------------------------------------------------------------- */

describe('the hero parallax geometry', () => {
  it('is 0 at rest and 1 once the hero has scrolled past, clamped outside', () => {
    const hero = { heroHeight: 800, viewportHeight: 900 };
    expect(parallaxProgress({ heroTop: 0, ...hero })).toBe(0);
    expect(parallaxProgress({ heroTop: -400, ...hero })).toBe(0.5);
    expect(parallaxProgress({ heroTop: -800, ...hero })).toBe(1);
    // Bounce-scroll overshoot in both directions.
    expect(parallaxProgress({ heroTop: 300, ...hero })).toBe(0);
    expect(parallaxProgress({ heroTop: -5000, ...hero })).toBe(1);
  });

  it('returns 0 for a degenerate box rather than NaN', () => {
    // The "something went wrong" state and the reduced-motion state are the same state, and it is
    // the state the hero already renders.
    expect(parallaxProgress({ heroTop: Number.NaN, heroHeight: 800, viewportHeight: 900 })).toBe(0);
    expect(parallaxProgress({ heroTop: -100, heroHeight: 0, viewportHeight: 900 })).toBe(0);
    expect(parallaxProgress({ heroTop: -100, heroHeight: 800, viewportHeight: 0 })).toBe(0);
  });

  it('never moves a plane further than the cap, and never moves a depth-0 plane', () => {
    expect(planeOffset(1, 0)).toBe(0);
    expect(planeOffset(1, 1)).toBe(-MAX_PLANE_OFFSET_PX);
    expect(Math.abs(planeOffset(1, 0.6))).toBeLessThanOrEqual(MAX_PLANE_OFFSET_PX);
    // Out-of-range inputs are clamped rather than extrapolated.
    expect(planeOffset(5, 5)).toBe(-MAX_PLANE_OFFSET_PX);
    expect(planeOffset(Number.NaN, 0.5)).toBe(0);
  });

  it('is monotone in progress and in depth, so deeper planes move less', () => {
    const shallow = Math.abs(planeOffset(0.5, 0.15));
    const deep = Math.abs(planeOffset(0.5, 0.6));
    expect(deep).toBeGreaterThan(shallow);
    expect(Math.abs(planeOffset(0.8, 0.35))).toBeGreaterThan(Math.abs(planeOffset(0.2, 0.35)));
  });

  it('emits translate3d and nothing else — never a scale, opacity or filter', () => {
    // Requirement 21.8 and the design's "three depth planes, `translate3d` only". The function's
    // output is the only transform the loop writes, so this is the whole surface to check.
    for (const progress of [0, 0.25, 0.5, 1]) {
      const transform = planeTransform(planeOffset(progress, 0.35));
      expect(transform).toMatch(/^translate3d\(0, -?\d+px, 0\)$/);
    }
    expect(NEUTRAL_TRANSFORM).toBe('translate3d(0, 0px, 0)');
  });

  it('rounds to whole pixels, so a text plane is not re-rastered for a sub-pixel move', () => {
    expect(Number.isInteger(planeOffset(0.333, 0.37))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The before/after slider (Requirements 21.6, 21.11, 24.5)                   */
/* -------------------------------------------------------------------------- */

describe('the before/after slider', () => {
  it('clamps every position into 0–100 and rounds it', () => {
    expect(clampPosition(-40)).toBe(0);
    expect(clampPosition(140)).toBe(100);
    expect(clampPosition(49.6)).toBe(50);
    expect(clampPosition(Number.NaN)).toBe(DEFAULT_POSITION);
  });

  it('maps a pointer to a position within its box', () => {
    const box = { left: 100, width: 400 };
    expect(positionFromPointer(100, box)).toBe(0);
    expect(positionFromPointer(300, box)).toBe(50);
    expect(positionFromPointer(500, box)).toBe(100);
    // A drag beyond either edge pins rather than escaping.
    expect(positionFromPointer(-50, box)).toBe(0);
    expect(positionFromPointer(9999, box)).toBe(100);
  });

  it('returns the current position for a zero-width box rather than dividing by zero', () => {
    expect(positionFromPointer(120, { left: 0, width: 0 }, 37)).toBe(37);
  });

  it('implements the full keyboard slider contract', () => {
    // Requirement 24.5: a drag control that only works with a pointer is not operable. Every key
    // the ARIA slider pattern specifies is here.
    expect(positionFromKey('ArrowRight', 50)).toBe(50 + STEP);
    expect(positionFromKey('ArrowUp', 50)).toBe(50 + STEP);
    expect(positionFromKey('ArrowLeft', 50)).toBe(50 - STEP);
    expect(positionFromKey('ArrowDown', 50)).toBe(50 - STEP);
    expect(positionFromKey('PageUp', 50)).toBe(50 + PAGE_STEP);
    expect(positionFromKey('PageDown', 50)).toBe(50 - PAGE_STEP);
    expect(positionFromKey('Home', 50)).toBe(0);
    expect(positionFromKey('End', 50)).toBe(100);
    // Stepping at the ends stays in range.
    expect(positionFromKey('ArrowLeft', 0)).toBe(0);
    expect(positionFromKey('ArrowRight', 100)).toBe(100);
  });

  it('returns null for a key it does not own, so Tab and Enter still work', () => {
    for (const key of ['Tab', 'Enter', ' ', 'Escape', 'a']) {
      expect(positionFromKey(key, 50), key).toBeNull();
    }
  });

  it('reveals the after layer with clip-path, never with width', () => {
    // Requirement 21.8: `width` is forbidden, and it is the obvious way to build this.
    expect(clipFor(0)).toBe('inset(0 100% 0 0)');
    expect(clipFor(50)).toBe('inset(0 50% 0 0)');
    expect(clipFor(100)).toBe('inset(0 0% 0 0)');
    expect(handleOffset(25)).toBe('25%');
  });

  it('describes what is showing rather than announcing a bare number', () => {
    expect(valueText(0, 'the empty room', 'the furnished room')).toBe(
      'Showing the empty room only',
    );
    expect(valueText(100, 'the empty room', 'the furnished room')).toBe(
      'Showing the furnished room only',
    );
    expect(valueText(30, 'the empty room', 'the furnished room')).toBe(
      '30% the furnished room, 70% the empty room',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Scroll progress                                                            */
/* -------------------------------------------------------------------------- */

describe('scroll progress', () => {
  it('runs from 0 to 1 as an element crosses the viewport', () => {
    expect(viewportProgress({ top: 900, height: 300 }, 900)).toBe(0);
    expect(viewportProgress({ top: -300, height: 300 }, 900)).toBe(1);
    expect(viewportProgress({ top: 300, height: 300 }, 900)).toBeCloseTo(0.5, 2);
  });

  it('is 0 for a degenerate viewport', () => {
    expect(viewportProgress({ top: 0, height: 100 }, 0)).toBe(0);
    expect(viewportProgress({ top: 0, height: 100 }, Number.NaN)).toBe(0);
  });

  it('notifies subscribers only on a change, so most frames cost nothing', () => {
    const value = createMotionValue(0);
    const listener = vi.fn();
    const off = value.on(listener);

    value.set(0);
    expect(listener).not.toHaveBeenCalled();
    value.set(0.25);
    expect(listener).toHaveBeenCalledExactlyOnceWith(0.25);
    value.set(0.25);
    expect(listener).toHaveBeenCalledTimes(1);

    off();
    value.set(0.5);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(value.get()).toBe(0.5);
  });
});

/* -------------------------------------------------------------------------- */
/* The primitive contract (Requirements 21.1, 21.5, 24.10)                    */
/* -------------------------------------------------------------------------- */

describe('the shared primitive contract', () => {
  it('strokes in currentColor and sets colour through the palette tokens', () => {
    const plain = primitiveAttrs({}, 'chair', 600);
    expect(plain.svg.stroke).toBe('currentColor');
    expect(plain.svg.fill).toBe('none');
    // A named stroke sets `color`, so the stroke stays `currentColor` and the value is a token.
    const gold = primitiveAttrs({ stroke: 'champagne' }, 'chair', 600);
    expect(gold.svg.stroke).toBe('currentColor');
    expect(String(gold.svg.style)).toContain('color:var(--color-champagne)');
    // No hex anywhere: Requirement 21.1 fixes the palette, and a primitive cannot introduce one.
    expect(String(gold.svg.style)).not.toMatch(/#[0-9a-f]{3,6}/i);
  });

  it('is either decorative and hidden, or meaningful and titled — never both', () => {
    const decorative = primitiveAttrs({}, 'sofa', 900);
    expect(decorative.svg['aria-hidden']).toBe('true');
    expect(decorative.svg.role).toBeUndefined();
    expect(decorative.title).toBeNull();

    const meaningful = primitiveAttrs({ title: 'A three-seater sofa' }, 'sofa', 900);
    expect(meaningful.svg.role).toBe('img');
    expect(meaningful.svg['aria-hidden']).toBeUndefined();
    expect(meaningful.title).toBe('A three-seater sofa');
  });

  it('emits the reveal attribute for a triggered instance and none for a static one', () => {
    expect(primitiveAttrs({}, 'room', 1400).svg['data-reveal']).toBe('');
    expect(primitiveAttrs({ trigger: 'none' }, 'room', 1400).svg['data-reveal']).toBeUndefined();
    expect(primitiveAttrs({ variant: 'static' }, 'room', 1400).svg['data-reveal']).toBeUndefined();
  });

  it('declares the path length the dash animation needs', () => {
    expect(String(primitiveAttrs({}, 'bed', 880).svg.style)).toContain('--ngf-path-length:880');
  });

  it('keeps the stroke width on the hairline scale', () => {
    expect(primitiveAttrs({}, 'table', 700).svg['stroke-width']).toBe(1.5);
    for (const width of [1, 1.5, 2] as const) {
      expect(primitiveAttrs({ strokeWidth: width }, 'table', 700).svg['stroke-width']).toBe(width);
    }
  });

  it('clamps a negative delay rather than emitting one', () => {
    expect(String(primitiveAttrs({ delay: -500 }, 'chair', 600).svg.style)).toContain(
      '--ngf-draw-delay:0ms',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The budgets, as source-level assertions (Requirements 21.8, 21.15)         */
/* -------------------------------------------------------------------------- */

const MOTION_DIR = fileURLToPath(new URL('../../src/components/motion/', import.meta.url));
const STYLES_DIR = fileURLToPath(new URL('../../src/styles/', import.meta.url));

const PRIMITIVE_FILES = [
  'AnimatedFurnitureLine.astro',
  'AnimatedChair.astro',
  'AnimatedSofa.astro',
  'AnimatedBed.astro',
  'AnimatedTable.astro',
  'AnimatedRoom.astro',
  'CraftsmanshipLines.astro',
  'FurnitureAssembly.astro',
  'CategoryIllustration.astro',
] as const;

/** The `<svg>…</svg>` of one primitive source file. */
function svgOf(file: string): string {
  const contents = readFileSync(`${MOTION_DIR}${file}`, 'utf8');
  const start = contents.indexOf('<svg');
  const end = contents.lastIndexOf('</svg>');
  expect(start, `${file} has an <svg>`).toBeGreaterThan(-1);
  return contents.slice(start, end + 6);
}

describe('the illustration set', () => {
  it('has exactly nine primitives, and the contract names all nine', () => {
    // Requirement 21.5 fixes the number. `PRIMITIVE_NAMES` is what the build-time budget check
    // asserts against the rendered output, so the two lists must agree.
    expect(PRIMITIVE_FILES).toHaveLength(9);
    expect(PRIMITIVE_NAMES).toHaveLength(9);
  });

  it('keeps the combined inline markup inside the 18 KB budget', () => {
    // A source-level proxy for the build-time check in `scripts/check-motion-budget.ts`, which
    // measures the rendered output. This one fails in the editor rather than in CI.
    const combined = PRIMITIVE_FILES.reduce(
      (total, file) => total + Buffer.byteLength(svgOf(file), 'utf8'),
      0,
    );
    expect(combined).toBeLessThanOrEqual(18 * 1024);
  });

  it('uses no raster asset and no external animation runtime', () => {
    // Requirement 21.5: hand-authored vector, nothing fetched, nothing imported to animate it.
    for (const file of PRIMITIVE_FILES) {
      const contents = readFileSync(`${MOTION_DIR}${file}`, 'utf8');
      expect(contents, file).not.toMatch(/<image\b/);
      expect(contents, file).not.toMatch(/url\(/);
      expect(contents, file).not.toMatch(/from 'motion/);
      expect(contents, file).not.toMatch(/from 'gsap/);
      expect(contents, file).not.toMatch(/<script/);
      // Strokes are `currentColor`; a literal hex would break the palette rule.
      expect(svgOf(file), file).not.toMatch(/#[0-9a-fA-F]{3,6}/);
    }
  });
});

describe('the reduced-motion inversion in motion.css', () => {
  // Comments are stripped first: this file explains the inversion in prose, and a sentence
  // containing the words `opacity: 0` is documentation rather than a declaration.
  const css = readFileSync(`${STYLES_DIR}motion.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  /** Strip every at-rule block whose name starts with `marker`, balancing braces. */
  function withoutBlocks(source: string, marker: string): string {
    let out = '';
    let index = 0;
    while (index < source.length) {
      const at = source.indexOf(marker, index);
      if (at === -1) {
        out += source.slice(index);
        break;
      }
      out += source.slice(index, at);
      let cursor = source.indexOf('{', at) + 1;
      let depth = 1;
      while (cursor < source.length && depth > 0) {
        if (source[cursor] === '{') depth += 1;
        else if (source[cursor] === '}') depth -= 1;
        cursor += 1;
      }
      index = cursor;
    }
    return out;
  }

  /**
   * The CSS that applies unconditionally.
   *
   * `@keyframes` definitions are stripped along with the gated blocks, and for a specific reason: a
   * keyframe definition is inert. `@keyframes ngf-reveal-in { from { opacity: 0 } }` hides nothing
   * on its own — only an `animation:` declaration referencing it does, and every one of those is
   * asserted below to be inside the gate. Counting the definition as a from-state would make the
   * test unsatisfiable for any keyframed reveal at all.
   */
  function unconditionalCss(source: string): string {
    return withoutBlocks(
      withoutBlocks(source, '@media (prefers-reduced-motion: no-preference)'),
      '@keyframes',
    );
  }

  const withoutNoPreferenceBlocks = unconditionalCss;

  it('declares every from-state inside a no-preference block, so nothing is hidden by default', () => {
    const unconditional = withoutNoPreferenceBlocks(css);
    // This is the whole safety property of the system: with no JavaScript, with a failed observer,
    // or under reduced motion, every element is in its final state. A from-state outside the
    // no-preference block would turn a script failure into a blank page (Requirement 21.11).
    expect(unconditional).not.toMatch(/opacity:\s*0\b/);
    expect(unconditional).not.toMatch(/scale3d\(\s*0\b/);
    expect(unconditional).not.toMatch(/inset\(0 0 100%/);
    expect(unconditional).not.toMatch(/stroke-dashoffset:\s*var\(--ngf-path-length/);
  });

  it('declares the shared underline reveal drawn by default and collapses it only inside the gate', () => {
    // The shared `.ngf-underline` inline-link micro-interaction follows the same inversion as the
    // scroll reveals: the DRAWN line (`scaleX(1)`) is the default, so with no JavaScript, under
    // reduced motion, or with the motion toggle off the link carries a plain visible underline. The
    // collapsed from-state (`scaleX(0)`) must exist ONLY inside the no-preference gate, or a visitor
    // who asked for reduced motion would see the underline vanish (Requirement 21.11 / 21.12).
    const unconditional = withoutNoPreferenceBlocks(css);
    expect(css).toMatch(/\.ngf-underline::after\s*\{[^}]*transform:\s*scaleX\(1\)/);
    expect(unconditional).not.toMatch(/scaleX\(0\)/);
    expect(css).toMatch(/scaleX\(0\)/);
  });

  it('references no keyframed animation outside the gate', () => {
    // The counterpart of the assertion above: a keyframe definition is inert, so what matters is
    // that nothing *applies* one unconditionally. Every `animation:` in this file — the reveal, the
    // mask wipe, the hero wipe and the drift — must be inside the no-preference block, or a visitor
    // who asked for reduced motion would see it (Requirement 21.11).
    expect(unconditionalCss(css)).not.toMatch(/\banimation:\s*ngf-/);
  });

  it('sets the drawn state and no dash offset as the default for every primitive', () => {
    expect(css).toMatch(/\[data-ngf-primitive\]\s+\.ngf-draw\s*\{[^}]*stroke-dashoffset:\s*0/);
  });

  it('keeps the only continuous animation inside the no-preference block', () => {
    // Requirement 21.11: drift is *removed* under reduced motion, not slowed. So the rule that
    // applies it must not exist outside the gate.
    expect(withoutNoPreferenceBlocks(css)).not.toMatch(/animation:\s*ngf-drift/);
    expect(css).toMatch(/animation:\s*ngf-drift/);
  });

  it('animates only transform, opacity, clip-path and stroke-dashoffset', () => {
    // The same rule `scripts/lint-motion.ts` enforces across every stylesheet, asserted here for
    // the one file that carries most of the motion.
    const transitions = [...css.matchAll(/transition:\s*([^;}]+)/g)].map((match) => match[1] ?? '');
    const allowed = /^(opacity|transform|clip-path|stroke-dashoffset|border-color|color)$/;
    for (const declaration of transitions) {
      for (const part of declaration.split(',')) {
        const property = part.trim().split(/\s+/)[0] ?? '';
        if (property === '' || property === 'none') continue;
        expect(property, `transition of ${property}`).toMatch(allowed);
      }
    }
  });
});
