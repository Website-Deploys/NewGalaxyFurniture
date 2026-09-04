import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import {
  DECORATIVE_ONLY_PAIRS,
  MIN_CONTRAST,
  MOTION_DURATION,
  MOTION_EASING,
  MOTION_STAGGER,
  PALETTE,
  PALETTE_PAIRS,
  type PaletteToken,
} from '@/styles/tokens';

/**
 * Palette contrast gate.
 *
 * Every foreground/background pairing the site uses must clear WCAG 2.2 AA for
 * what it is used for: 4.5:1 for body text (SC 1.4.3), 3:1 for large text
 * (SC 1.4.3) and for interface strokes that carry meaning (SC 1.4.11).
 *
 * Design: Visual Design System → Palette tokens.
 * Requirements: 21.2, 21.3.
 */

/** sRGB relative luminance, per WCAG 2.x. */
function relativeLuminance(hex: string): number {
  const value = hex.replace('#', '');
  const channels = [value.slice(0, 2), value.slice(2, 4), value.slice(4, 6)].map((pair) => {
    const srgb = Number.parseInt(pair, 16) / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  const [r, g, b] = channels as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1:1 … 21:1. */
export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

function ratioOf(fg: PaletteToken, bg: PaletteToken): number {
  return contrastRatio(PALETTE[fg], PALETTE[bg]);
}

describe('contrastRatio', () => {
  it('returns 21:1 for black on white and 1:1 for a colour on itself', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#B88A45', '#B88A45')).toBeCloseTo(1, 10);
  });

  it('is symmetric in its arguments', () => {
    expect(contrastRatio(PALETTE.obsidian, PALETTE.ivory)).toBeCloseTo(
      contrastRatio(PALETTE.ivory, PALETTE.obsidian),
      10,
    );
  });

  it('agrees with the ratio the design states for obsidian on ivory', () => {
    // Design: "obsidian on ivory is ~15:1".
    expect(ratioOf('obsidian', 'ivory')).toBeGreaterThan(14);
  });
});

describe('palette pairs meet WCAG AA for their declared use', () => {
  it.each(PALETTE_PAIRS)('$fg on $bg ($use) — $where', ({ fg, bg, use, where }) => {
    const ratio = ratioOf(fg, bg);
    const required = MIN_CONTRAST[use];
    expect(
      ratio,
      `${fg} (${PALETTE[fg]}) on ${bg} (${PALETTE[bg]}) is ${ratio.toFixed(2)}:1 but ${use} ` +
        `requires ${required}:1 — used for: ${where}`,
    ).toBeGreaterThanOrEqual(required);
  });

  it('declares no pair against itself and no duplicate use of the same pair', () => {
    const seen = new Set<string>();
    for (const { fg, bg, use } of PALETTE_PAIRS) {
      expect(fg, 'a pair must have two different tokens').not.toBe(bg);
      const key = `${fg}|${bg}|${use}`;
      expect(seen.has(key), `duplicate pair declaration: ${key}`).toBe(false);
      seen.add(key);
    }
  });
});

describe('champagne gold usage rule', () => {
  it('is absent from every body-text pair', () => {
    const bodyPairs = PALETTE_PAIRS.filter((pair) => pair.use === 'body');
    const withGold = bodyPairs.filter((pair) => pair.fg === 'champagne' || pair.bg === 'champagne');
    expect(
      withGold,
      'champagne gold may not carry or sit behind body copy (Requirement 21.2)',
    ).toHaveLength(0);
  });

  it('only ever appears over the dark surfaces', () => {
    const goldPairs = PALETTE_PAIRS.filter((pair) => pair.fg === 'champagne');
    expect(goldPairs.length).toBeGreaterThan(0);
    for (const pair of goldPairs) {
      expect(
        ['obsidian', 'espresso'],
        `champagne on ${pair.bg} is ${ratioOf('champagne', pair.bg).toFixed(2)}:1`,
      ).toContain(pair.bg);
    }
  });

  it('keeps every decorative-only pair out of the text and interface pair table', () => {
    expect(DECORATIVE_ONLY_PAIRS.length).toBeGreaterThan(0);
    for (const { fg, bg } of DECORATIVE_ONLY_PAIRS) {
      const declaredElsewhere = PALETTE_PAIRS.some((pair) => pair.fg === fg && pair.bg === bg);
      expect(
        declaredElsewhere,
        `${fg} on ${bg} (${ratioOf(fg, bg).toFixed(2)}:1) is decorative-only and must not also ` +
          'be declared as a text or interface pair',
      ).toBe(false);
    }
  });

  it('confirms the light-surface gold pairings could not carry text or a control stroke', () => {
    // The reason the champagne-on-light pairings are decorative-only: they do not
    // reach the 3:1 floor, so a gold hairline on ivory or cream can never be
    // promoted to an underline, an icon that means something, or a focus ring.
    expect(ratioOf('champagne', 'ivory')).toBeLessThan(MIN_CONTRAST.uiStroke);
    expect(ratioOf('champagne', 'cream')).toBeLessThan(MIN_CONTRAST.uiStroke);
    expect(ratioOf('champagne', 'ivory')).toBeLessThan(MIN_CONTRAST.body);
  });
});

describe('tokens.ts mirrors tokens.css', () => {
  it('declares the same ten palette values as the stylesheet', async () => {
    const css = await readFile(new URL('../../src/styles/tokens.css', import.meta.url), 'utf8');
    const entries = Object.entries(PALETTE) as [PaletteToken, string][];
    expect(entries).toHaveLength(10);
    for (const [token, hex] of entries) {
      expect(css, `--color-${token} must be ${hex} in tokens.css`).toContain(`--color-${token}:`);
      const match = new RegExp(`--color-${token}:\\s*(#[0-9A-Fa-f]{6})`).exec(css);
      expect(match?.[1]?.toUpperCase()).toBe(hex.toUpperCase());
    }
  });

  it('declares the same motion tokens as the stylesheet', async () => {
    const css = await readFile(new URL('../../src/styles/tokens.css', import.meta.url), 'utf8');
    for (const [name, ms] of Object.entries(MOTION_DURATION)) {
      expect(css).toContain(`--dur-${name}:`);
      const match = new RegExp(`--dur-${name}:\\s*(\\d+)ms`).exec(css);
      expect(Number(match?.[1]), `--dur-${name} must be ${ms}ms`).toBe(ms);
    }
    for (const [name, curve] of Object.entries(MOTION_EASING)) {
      const match = new RegExp(`--ease-${name}:\\s*(cubic-bezier\\([^)]*\\))`).exec(css);
      expect(match?.[1], `--ease-${name} must be ${curve}`).toBe(curve);
    }
    for (const [name, ms] of Object.entries(MOTION_STAGGER)) {
      const match = new RegExp(`--stagger-${name}:\\s*(\\d+)ms`).exec(css);
      expect(Number(match?.[1]), `--stagger-${name} must be ${ms}ms`).toBe(ms);
    }
  });
});
