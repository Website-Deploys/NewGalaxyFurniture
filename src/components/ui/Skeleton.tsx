import type { ReactElement } from 'react';

/**
 * The loading placeholder, for the islands.
 *
 * The same composition and the same classes as `Skeleton.astro` — the rules are in `global.css`,
 * which both shells load, so there is one definition of each shape rather than two that drift.
 *
 * Every island that waits on something renders one of these instead of a bare sentence:
 * `SearchBox` while the index arrives, `Gallery` while the zoom chunk arrives, `AiAssistant` while a
 * suggestion is generated. Requirement 26.12 asks for a placeholder shaped like the expected
 * content, and "Loading…" is not a shape.
 *
 * `aria-hidden` plus `role="presentation"`: the skeleton is not content. The surface that renders it
 * owns the live region that says what is happening, so a screen-reader user hears one sentence
 * rather than a description of four empty boxes.
 *
 * Requirements: 26.12, 26.13.
 * Design: Error Handling → Loading states.
 */
export interface SkeletonProps {
  variant?: 'text' | 'image' | 'card' | 'row';
  /** Repetitions — three skeleton rows for a three-row list. */
  count?: number;
  /** Text lines, for the `text`, `card` and `row` variants. */
  lines?: number;
  /** The reserved aspect ratio for `image`, the card's media box, and the row's thumbnail. */
  ratio?: string;
  className?: string;
}

export default function Skeleton({
  variant = 'text',
  count = 1,
  lines = 2,
  ratio = '4 / 3',
  className,
}: SkeletonProps): ReactElement {
  const items = Array.from({ length: Math.max(1, count) }, (_unused, index) => index);
  const textLines = Array.from({ length: Math.max(1, lines) }, (_unused, index) => index);

  return (
    <div
      className={className === undefined ? 'ngf-skeleton' : `ngf-skeleton ${className}`}
      data-variant={variant}
      role="presentation"
      aria-hidden="true"
      data-ngf-skeleton
    >
      {items.map((item) => (
        <div key={item} className="ngf-skeleton-item">
          {(variant === 'image' || variant === 'card' || variant === 'row') && (
            <span className="ngf-skeleton-media ngf-skeleton-fill" style={{ aspectRatio: ratio }} />
          )}
          {variant !== 'image' && (
            <span className="ngf-skeleton-lines">
              {textLines.map((line) => (
                <span
                  key={line}
                  className="ngf-skeleton-line ngf-skeleton-fill"
                  style={line === textLines.length - 1 ? { width: '60%' } : undefined}
                />
              ))}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
