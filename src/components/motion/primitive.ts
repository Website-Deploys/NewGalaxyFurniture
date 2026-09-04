/**
 * The shared contract every animated 2D primitive implements.
 *
 * All nine primitives are the same component with different paths: the same props, the same
 * attribute set, the same accessibility rules, the same trigger. Centralising that here is what
 * keeps the nine of them inside Requirement 21.15's 18 KB of combined markup — nine copies of the
 * same fifteen attributes would be a meaningful share of the budget on their own — and it makes the
 * rules checkable in one place rather than nine.
 *
 * The rules, each of which is a requirement:
 *
 * - **`currentColor` strokes, never a hard-coded hex.** A primitive inherits its colour from its
 *   container, so it is correct on ivory, on cream, and on the dark bands, and it cannot introduce
 *   a colour outside the palette (Requirement 21.1). The `stroke` prop selects among the four
 *   palette tokens by setting `color`, not `stroke`.
 * - **Decorative instances are `aria-hidden`; meaningful instances carry a `<title>`.** Those are
 *   the only two states, and they are mutually exclusive: an `aria-hidden` element with a title is
 *   a title nobody can read, and a titled element that is also hidden is a lie in the markup. The
 *   presence of `title` decides, so a caller cannot produce the incoherent combination.
 * - **`stroke-width` is 1, 1.5 or 2.** The design's contract says so, and the type says so, so a
 *   2.5 px stroke that would break the hairline language cannot be passed.
 * - **The trigger is an attribute, not a script.** `trigger: 'inView'` emits `data-reveal`, which
 *   the CSS tier animates with no JavaScript and the observer tier animates as a fallback. There is
 *   no per-primitive JavaScript at all — Requirement 21.5's "no external animation runtime" is
 *   satisfied by there being no runtime of any kind.
 *
 * Design: Motion System → The animated 2D component set.
 * Requirements: 21.1, 21.5, 21.7, 21.8, 21.11, 24.10.
 */

/** The design's props contract, verbatim. */
export interface MotionPrimitiveProps {
  variant?: 'draw' | 'assemble' | 'float' | 'static';
  trigger?: 'inView' | 'hover' | 'mount' | 'scrollLinked' | 'none';
  duration?: 'fast' | 'normal' | 'reveal' | 'story';
  delay?: number;
  stroke?: 'obsidian' | 'champagne' | 'taupe' | 'currentColor';
  strokeWidth?: 1 | 1.5 | 2;
  className?: string;
  /** A `<title>` for a meaningful instance. Omit for a decorative one, which is `aria-hidden`. */
  title?: string;
}

/** The names of the nine primitives, for the budget check and the dispatcher. */
export const PRIMITIVE_NAMES = [
  'furniture-line',
  'chair',
  'sofa',
  'bed',
  'table',
  'room',
  'craftsmanship',
  'assembly',
  'category',
] as const;

export type PrimitiveName = (typeof PRIMITIVE_NAMES)[number];

/** The palette token each `stroke` value resolves to. `currentColor` inherits instead. */
const STROKE_COLOR: Record<NonNullable<MotionPrimitiveProps['stroke']>, string | null> = {
  obsidian: 'var(--color-obsidian)',
  champagne: 'var(--color-champagne)',
  taupe: 'var(--color-taupe)',
  currentColor: null,
};

/** The duration token each `duration` value resolves to. */
const DURATION_TOKEN: Record<NonNullable<MotionPrimitiveProps['duration']>, string> = {
  fast: 'var(--dur-fast)',
  normal: 'var(--dur-normal)',
  reveal: 'var(--dur-reveal)',
  story: 'var(--dur-story)',
};

export interface PrimitiveAttrs {
  /** Spread onto the `<svg>` element. */
  svg: Record<string, string | number | boolean | undefined>;
  /** The `<title>` text, or null for a decorative instance. */
  title: string | null;
}

/**
 * Resolve the props into the attribute set for one primitive's `<svg>`.
 *
 * @param pathLength the total length of the drawn paths, in user units. Declared per primitive as
 * a constant rather than measured at runtime: `getTotalLength()` would need JavaScript on a
 * component that has none, and a value a little larger than the truth only means the draw starts
 * from slightly further away — which is invisible — while a value smaller than the truth would
 * leave part of the illustration permanently hidden. Each primitive's constant is rounded up.
 */
export function primitiveAttrs(
  props: MotionPrimitiveProps,
  name: PrimitiveName,
  pathLength: number,
): PrimitiveAttrs {
  const variant = props.variant ?? 'draw';
  const trigger = props.trigger ?? 'inView';
  const duration = props.duration ?? (variant === 'assemble' ? 'story' : 'story');
  const strokeWidth = props.strokeWidth ?? 1.5;
  const color = STROKE_COLOR[props.stroke ?? 'currentColor'];
  const title = props.title ?? null;

  const style = [
    `--ngf-path-length:${String(Math.ceil(pathLength))}`,
    `--ngf-draw-duration:${DURATION_TOKEN[duration]}`,
    props.delay === undefined ? null : `--ngf-draw-delay:${String(Math.max(0, props.delay))}ms`,
    props.delay === undefined ? null : `--ngf-part-delay:${String(Math.max(0, props.delay))}ms`,
    color === null ? null : `color:${color}`,
  ]
    .filter((part): part is string => part !== null)
    .join(';');

  return {
    title,
    svg: {
      'data-ngf-primitive': name,
      'data-variant': variant,
      // `static` and `none` opt out of the trigger entirely and render the final state.
      ...(variant === 'static' || trigger === 'none' ? {} : { 'data-reveal': '' }),
      class: ['ngf-primitive', props.className].filter((part) => part !== undefined).join(' '),
      style,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': strokeWidth,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      // Exactly one of the two, decided by whether a title was supplied.
      ...(title === null ? { 'aria-hidden': 'true', focusable: 'false' } : { role: 'img' }),
    },
  };
}
