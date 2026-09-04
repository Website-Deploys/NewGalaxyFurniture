/**
 * Typed mirror of the design tokens declared in `tokens.css`.
 *
 * `tokens.css` is what the browser reads; this module is what tests and TypeScript
 * read. The palette hex values must stay identical in both files — the contrast
 * test in `tests/unit/tokens.contrast.test.ts` enumerates `PALETTE_PAIRS` and a
 * parity assertion checks the hex values against the stylesheet.
 *
 * Design: Visual Design System → Palette tokens; Motion System → Tokens.
 * Requirements: 21.1, 21.2, 21.3, 21.7.
 */

/** The eight palette tokens. No other colour value may appear in the codebase. */
export const PALETTE = {
  obsidian: '#171513',
  espresso: '#3B2A21',
  walnut: '#6B4A36',
  champagne: '#B88A45',
  ivory: '#F8F2EA',
  cream: '#EFE4D7',
  taupe: '#CBBBA9',
  white: '#FFFFFF',
} as const;

export type PaletteToken = keyof typeof PALETTE;

/**
 * What a pairing is used for, which sets the WCAG threshold it must clear:
 * - `body`      — text below 18.66px regular / 24px bold → 4.5:1 (SC 1.4.3)
 * - `largeText` — display text at or above that size → 3:1 (SC 1.4.3)
 * - `uiStroke`  — focus rings, control borders, informational icon strokes,
 *                 informational separators → 3:1 (SC 1.4.11)
 */
export type PairUse = 'body' | 'largeText' | 'uiStroke';

export const MIN_CONTRAST: Readonly<Record<PairUse, number>> = {
  body: 4.5,
  largeText: 3,
  uiStroke: 3,
} as const;

export interface PalettePair {
  /** Foreground: text colour, or stroke colour for `uiStroke`. */
  readonly fg: PaletteToken;
  /** The colour immediately behind the foreground. */
  readonly bg: PaletteToken;
  readonly use: PairUse;
  /** Where this pairing is actually used, so a reviewer can verify the claim. */
  readonly where: string;
}

/**
 * Every foreground/background pairing the site actually uses.
 *
 * Adding a pairing to the UI without adding it here is the failure mode this
 * table exists to prevent: the contrast test only protects what it can enumerate.
 *
 * Champagne gold appears only with `largeText` and `uiStroke`, and only over the
 * dark surfaces — never as body copy (Requirement 21.2, enforced by test).
 */
export const PALETTE_PAIRS: readonly PalettePair[] = [
  // --- Body copy on light surfaces ---
  { fg: 'obsidian', bg: 'ivory', use: 'body', where: 'primary body copy on the page background' },
  { fg: 'obsidian', bg: 'cream', use: 'body', where: 'body copy in cream-banded sections' },
  { fg: 'obsidian', bg: 'white', use: 'body', where: 'body copy on cards and admin surfaces' },
  { fg: 'espresso', bg: 'ivory', use: 'body', where: 'secondary copy, captions, product meta' },
  { fg: 'espresso', bg: 'cream', use: 'body', where: 'secondary copy in cream-banded sections' },
  { fg: 'espresso', bg: 'white', use: 'body', where: 'secondary copy on cards, admin table text' },
  {
    fg: 'walnut',
    bg: 'ivory',
    use: 'body',
    where: 'inline links and hover text on the background',
  },
  { fg: 'walnut', bg: 'cream', use: 'body', where: 'inline links in cream-banded sections' },
  { fg: 'walnut', bg: 'white', use: 'body', where: 'inline links on cards' },

  // --- Body copy on dark surfaces ---
  { fg: 'ivory', bg: 'obsidian', use: 'body', where: 'copy in obsidian-banded sections' },
  { fg: 'ivory', bg: 'espresso', use: 'body', where: 'labels on espresso buttons and nav states' },
  { fg: 'ivory', bg: 'walnut', use: 'body', where: 'labels on walnut hover states' },
  { fg: 'cream', bg: 'obsidian', use: 'body', where: 'secondary copy in obsidian sections' },
  { fg: 'cream', bg: 'espresso', use: 'body', where: 'secondary copy on espresso surfaces' },
  { fg: 'white', bg: 'obsidian', use: 'body', where: 'strong CTA label on obsidian' },
  { fg: 'white', bg: 'espresso', use: 'body', where: 'primary CTA label on espresso' },
  { fg: 'taupe', bg: 'obsidian', use: 'body', where: 'muted meta text in obsidian sections' },
  { fg: 'taupe', bg: 'espresso', use: 'body', where: 'muted meta text on espresso surfaces' },

  // --- Display text ---
  { fg: 'obsidian', bg: 'ivory', use: 'largeText', where: 'h1/h2 on the page background' },
  { fg: 'ivory', bg: 'obsidian', use: 'largeText', where: 'h1/h2 in obsidian-banded sections' },
  {
    fg: 'champagne',
    bg: 'obsidian',
    use: 'largeText',
    where: 'small-caps eyebrow labels and the single hero accent, on obsidian only',
  },
  {
    fg: 'champagne',
    bg: 'espresso',
    use: 'largeText',
    where: 'small-caps eyebrow labels on espresso surfaces',
  },

  // --- Interface strokes that carry meaning ---
  {
    fg: 'obsidian',
    bg: 'ivory',
    use: 'uiStroke',
    where: 'focus ring and control borders on light',
  },
  { fg: 'obsidian', bg: 'white', use: 'uiStroke', where: 'focus ring and input borders on cards' },
  { fg: 'espresso', bg: 'ivory', use: 'uiStroke', where: 'chip and input borders on light' },
  { fg: 'espresso', bg: 'cream', use: 'uiStroke', where: 'chip borders in cream sections' },
  { fg: 'ivory', bg: 'obsidian', use: 'uiStroke', where: 'focus ring on dark surfaces' },
  { fg: 'walnut', bg: 'ivory', use: 'uiStroke', where: 'hover stroke on light surfaces' },
  {
    fg: 'champagne',
    bg: 'obsidian',
    use: 'uiStroke',
    where: 'active-state underline and icon strokes on dark surfaces',
  },
  {
    fg: 'champagne',
    bg: 'espresso',
    use: 'uiStroke',
    where: 'active-state underline on espresso surfaces',
  },
  { fg: 'taupe', bg: 'obsidian', use: 'uiStroke', where: 'informational separators on dark' },
  { fg: 'taupe', bg: 'espresso', use: 'uiStroke', where: 'informational separators on espresso' },
];

/**
 * Pairings permitted **only** for purely decorative graphics — hairline section
 * rules and ornamental strokes that convey nothing a sighted user would lose.
 * WCAG 1.4.11 exempts purely decorative graphics, so these are excluded from the
 * contrast assertion, and none of them may carry text, an icon that means
 * something, a focus indicator, or a control boundary.
 *
 * Measured: champagne/ivory 2.79:1, champagne/cream 2.48:1, champagne/white
 * 3.11:1, taupe/ivory 1.68:1, taupe/cream 1.49:1, taupe/white 1.87:1.
 *
 * Note that champagne on white does clear 3:1. It is still listed here because
 * the gold usage rule confines meaningful gold to the dark surfaces — the reason
 * is the design rule, not the ratio. The other five are below 3:1 and could not
 * be used for anything meaningful even if the rule allowed it.
 */
export const DECORATIVE_ONLY_PAIRS: readonly { fg: PaletteToken; bg: PaletteToken }[] = [
  { fg: 'champagne', bg: 'ivory' },
  { fg: 'champagne', bg: 'cream' },
  { fg: 'champagne', bg: 'white' },
  { fg: 'taupe', bg: 'ivory' },
  { fg: 'taupe', bg: 'cream' },
  { fg: 'taupe', bg: 'white' },
];

/** Motion durations in milliseconds, mirroring `--dur-*`. Requirement 21.7. */
export const MOTION_DURATION = {
  fast: 180,
  normal: 320,
  reveal: 640,
  story: 1000,
} as const;

export type MotionDuration = keyof typeof MOTION_DURATION;

/** Easing curves, mirroring `--ease-*`. */
export const MOTION_EASING = {
  standard: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
  entrance: 'cubic-bezier(0.16, 1, 0.30, 1)',
  exit: 'cubic-bezier(0.55, 0, 0.55, 0.2)',
  draw: 'cubic-bezier(0.65, 0, 0.35, 1)',
} as const;

export type MotionEasing = keyof typeof MOTION_EASING;

/** Stagger steps in milliseconds, mirroring `--stagger-*`. */
export const MOTION_STAGGER = {
  tight: 45,
  loose: 90,
} as const;

/** The only radii permitted anywhere in the UI (design → "avoid" list). */
export const RADIUS_SCALE = [0, 2, 4] as const;
