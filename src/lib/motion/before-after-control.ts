/**
 * Wiring the before/after slider to a real element.
 *
 * The arithmetic is in `before-after.ts`; this is the DOM half. It is kept separate so the
 * position logic stays testable in Node, and so the one thing this file must get right is
 * visible at a glance: the control is operable whether or not motion is allowed.
 *
 * The markup it enhances is already a working control before this runs — `BeforeAfterRoom.astro`
 * renders a `role="slider"` with `tabindex="0"`, its ARIA value attributes, and a starting
 * `clip-path` — so with no JavaScript the visitor sees a legible half-and-half comparison rather
 * than a broken widget. What this adds is dragging, keyboard stepping, and the ARIA values
 * following the position.
 *
 * **Pointer events, not mouse plus touch.** One code path for finger, mouse and stylus, with
 * `setPointerCapture` so a drag that leaves the element still tracks — the alternative is a
 * divider that sticks when someone drags past the edge, which is most of the time.
 *
 * Requirements: 21.6, 21.8, 21.11, 24.5.
 */

import {
  clampPosition,
  clipFor,
  DEFAULT_POSITION,
  handleOffset,
  positionFromKey,
  positionFromPointer,
  valueText,
} from './before-after';

/** The root the astro component marks. */
export const BEFORE_AFTER_ATTRIBUTE = 'data-ngf-before-after';

/** Set while easing is permitted; the stylesheet's transition rule hangs off it. */
export const EASING_ATTRIBUTE = 'data-eased';

export interface BeforeAfterInstance {
  /** Turn the CSS transition on or off. Called when the visitor changes their preference. */
  setEasing(eased: boolean): void;
  destroy(): void;
}

interface Parts {
  root: HTMLElement;
  slider: HTMLElement;
  after: HTMLElement;
  handle: HTMLElement | null;
}

function partsOf(root: HTMLElement): Parts | null {
  const slider = root.querySelector<HTMLElement>('[role="slider"]');
  const after = root.querySelector<HTMLElement>('[data-ngf-after-layer]');
  if (slider === null || after === null) return null;
  return { root, slider, after, handle: root.querySelector<HTMLElement>('[data-ngf-divider]') };
}

function install(root: HTMLElement, animate: boolean): BeforeAfterInstance | null {
  const parts = partsOf(root);
  if (parts === null) return null;

  const beforeLabel = root.dataset.ngfBeforeLabel ?? 'the empty room';
  const afterLabel = root.dataset.ngfAfterLabel ?? 'the furnished room';

  let position = clampPosition(Number.parseFloat(parts.slider.getAttribute('aria-valuenow') ?? ''));
  if (!Number.isFinite(position)) position = DEFAULT_POSITION;
  let dragging = false;

  const render = (): void => {
    parts.after.style.clipPath = clipFor(position);
    if (parts.handle !== null) parts.handle.style.left = handleOffset(position);
    parts.slider.setAttribute('aria-valuenow', String(position));
    parts.slider.setAttribute('aria-valuetext', valueText(position, beforeLabel, afterLabel));
  };

  const setPosition = (next: number): void => {
    const clamped = clampPosition(next);
    if (clamped === position) return;
    position = clamped;
    render();
  };

  const onPointerDown = (event: PointerEvent): void => {
    dragging = true;
    parts.slider.setPointerCapture(event.pointerId);
    // Easing is suppressed *while dragging* even when motion is allowed: a divider that lags the
    // finger holding it feels broken rather than smooth.
    parts.root.removeAttribute(EASING_ATTRIBUTE);
    setPosition(positionFromPointer(event.clientX, parts.root.getBoundingClientRect(), position));
    // Keeps a drag from selecting the surrounding text.
    event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging) return;
    setPosition(positionFromPointer(event.clientX, parts.root.getBoundingClientRect(), position));
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    if (parts.slider.hasPointerCapture(event.pointerId)) {
      parts.slider.releasePointerCapture(event.pointerId);
    }
    if (animate) parts.root.setAttribute(EASING_ATTRIBUTE, '');
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const next = positionFromKey(event.key, position);
    // `null` means the key is not ours — Tab, Enter and everything else keep their behaviour.
    if (next === null) return;
    event.preventDefault();
    setPosition(next);
  };

  parts.slider.addEventListener('pointerdown', onPointerDown);
  parts.slider.addEventListener('pointermove', onPointerMove);
  parts.slider.addEventListener('pointerup', onPointerUp);
  parts.slider.addEventListener('pointercancel', onPointerUp);
  parts.slider.addEventListener('keydown', onKeyDown);

  if (animate) parts.root.setAttribute(EASING_ATTRIBUTE, '');
  else parts.root.removeAttribute(EASING_ATTRIBUTE);
  render();

  return {
    setEasing(eased) {
      if (eased) parts.root.setAttribute(EASING_ATTRIBUTE, '');
      else parts.root.removeAttribute(EASING_ATTRIBUTE);
    },
    destroy() {
      parts.slider.removeEventListener('pointerdown', onPointerDown);
      parts.slider.removeEventListener('pointermove', onPointerMove);
      parts.slider.removeEventListener('pointerup', onPointerUp);
      parts.slider.removeEventListener('pointercancel', onPointerUp);
      parts.slider.removeEventListener('keydown', onKeyDown);
    },
  };
}

/** Enhance every before/after control in `root`. Returns one instance per control. */
export function installBeforeAfter(root: ParentNode, animate: boolean): BeforeAfterInstance[] {
  const instances: BeforeAfterInstance[] = [];
  for (const element of root.querySelectorAll(`[${BEFORE_AFTER_ATTRIBUTE}]`)) {
    if (!(element instanceof HTMLElement)) continue;
    const instance = install(element, animate);
    if (instance !== null) instances.push(instance);
  }
  return instances;
}
