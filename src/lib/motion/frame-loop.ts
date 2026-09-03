/**
 * Tier three: the only `requestAnimationFrame` loops in the codebase.
 *
 * There are exactly two callers — the hero parallax and the before/after slider — and they exist
 * because both are genuinely continuous: a value that tracks scroll position or a pointer cannot
 * be expressed as a keyframed animation with a fixed duration. Everything else is tiers one and
 * two.
 *
 * Requirement 21.10 is absolute — no frame loop while the target is off-screen or the tab is
 * hidden — so this module makes that structural rather than a rule the two callers have to
 * remember:
 *
 * - The loop **cannot start** without an element to watch. `target` is required.
 * - An `IntersectionObserver` on that element starts and stops the loop. Off-screen, there is no
 *   scheduled frame at all; not a frame that returns early, which would still cost a callback per
 *   16 ms.
 * - `visibilitychange` to `hidden` cancels the pending frame, and returning to visible restarts it
 *   only if the element is still intersecting.
 * - Under reduced motion `start()` returns immediately and no observer and no frame is ever
 *   requested (Requirement 21.11: "the rAF hooks return early and never start").
 *
 * `will-change` is applied when the loop starts and removed when it stops, so a promoted layer
 * exists only while it is being written to.
 *
 * Design: Motion System → Trigger mechanism.
 * Requirements: 21.8, 21.10, 21.11.
 */

export interface FrameLoopOptions {
  /** The element whose visibility gates the loop. Required — see the header. */
  target: Element;
  /** Called once per animation frame while the loop is running. */
  onFrame: () => void;
  /**
   * Called once when the loop stops, so a caller can return its element to a neutral state.
   * Also called when `start()` is refused under reduced motion, which is what flattens the
   * parallax planes rather than leaving them wherever the last frame put them.
   */
  onIdle?: () => void;
  /** Elements to promote while the loop runs. Defaults to none. */
  promote?: readonly HTMLElement[];
  /** False under reduced motion: the loop never starts. */
  animate: boolean;
  /** Injectable for tests. */
  scheduler?: FrameScheduler;
}

/** The platform functions the loop needs, as an injectable seam. */
export interface FrameScheduler {
  request(callback: () => void): number;
  cancel(handle: number): void;
  observe(target: Element, onChange: (intersecting: boolean) => void): () => void;
  onVisibilityChange(listener: (hidden: boolean) => void): () => void;
}

export interface FrameLoop {
  start(): void;
  stop(): void;
  /** True while frames are actually being scheduled. */
  running(): boolean;
  /** Release every listener. Idempotent. */
  destroy(): void;
}

/** The real platform. */
export function browserScheduler(): FrameScheduler {
  return {
    request: (callback) => window.requestAnimationFrame(callback),
    cancel: (handle) => {
      window.cancelAnimationFrame(handle);
    },
    observe(target, onChange) {
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) onChange(entry.isIntersecting);
        },
        // A little slack so the loop is already running by the time the element is on screen,
        // rather than starting on the frame it appears.
        { rootMargin: '10% 0px' },
      );
      observer.observe(target);
      return () => observer.disconnect();
    },
    onVisibilityChange(listener) {
      const handler = (): void => listener(document.visibilityState === 'hidden');
      document.addEventListener('visibilitychange', handler, { passive: true });
      return () => document.removeEventListener('visibilitychange', handler);
    },
  };
}

/**
 * Create a gated frame loop.
 *
 * Nothing is observed until `start()`, and `start()` under reduced motion allocates nothing at
 * all — it calls `onIdle` once so the caller can settle its element, and returns.
 */
export function createFrameLoop(options: FrameLoopOptions): FrameLoop {
  const scheduler = options.scheduler ?? browserScheduler();
  const promote = options.promote ?? [];

  let handle: number | null = null;
  let intersecting = false;
  let hidden = false;
  let started = false;
  let teardown: (() => void)[] = [];

  const promoteOn = (): void => {
    for (const element of promote) element.style.willChange = 'transform';
  };
  const promoteOff = (): void => {
    for (const element of promote) element.style.willChange = '';
  };

  const tick = (): void => {
    options.onFrame();
    handle = scheduler.request(tick);
  };

  const resume = (): void => {
    if (handle !== null || !started) return;
    if (!intersecting || hidden) return;
    promoteOn();
    handle = scheduler.request(tick);
  };

  const suspend = (): void => {
    if (handle === null) return;
    scheduler.cancel(handle);
    handle = null;
    promoteOff();
    options.onIdle?.();
  };

  return {
    start() {
      if (started) return;
      // Requirement 21.11: under reduced motion this returns early and never starts. The one
      // thing it does is settle the caller's element into its neutral state.
      if (!options.animate) {
        options.onIdle?.();
        return;
      }
      started = true;
      teardown = [
        scheduler.observe(options.target, (next) => {
          intersecting = next;
          if (next) resume();
          else suspend();
        }),
        scheduler.onVisibilityChange((isHidden) => {
          hidden = isHidden;
          if (isHidden) suspend();
          else resume();
        }),
      ];
    },
    stop() {
      suspend();
      started = false;
    },
    running: () => handle !== null,
    destroy() {
      suspend();
      started = false;
      for (const release of teardown) release();
      teardown = [];
    },
  };
}
