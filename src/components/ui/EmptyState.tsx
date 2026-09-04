import type { ReactElement, ReactNode } from 'react';

/**
 * The composed empty state, for the islands.
 *
 * The same three parts as `EmptyState.astro` — an illustration, a heading and a message, and a next
 * action — because Requirement 26.14's seven states span both halves of the application: four of
 * them are public Astro pages and five are React admin views, and the design's rule that none may
 * render as "a bare 'nothing here'" does not stop at the trust boundary.
 *
 * Before this existed, each admin view wrote its own `border-dashed` box. They were all reasonable
 * and they were all slightly different, and two of them had no next action at all — which is the
 * part of the composition that does the work: "No enquiries yet" tells an operator nothing they did
 * not already know, and "No enquiries yet — here is the form visitors submit" tells them where to
 * look.
 *
 * The action is `children` rather than a prop so a call site can pass a link, a button, a pair, or
 * nothing, while the spacing and the tone stay fixed.
 *
 * Requirements: 26.12, 26.14.
 * Design: Error Handling → Empty states.
 */
export interface EmptyStateProps {
  heading: string;
  message: string;
  /**
   * `drop-zone` for the image manager, which needs a drop target rather than a bench;
   * `none` where the surface supplies its own figure or is a compact inline state.
   */
  illustration?: 'bench' | 'drop-zone' | 'none';
  /** The next action. A link, a button, or several. */
  children?: ReactNode;
  className?: string;
}

/** The hairline bench. Decorative: the heading and the message carry the meaning. */
function Bench(): ReactElement {
  return (
    <svg
      className="text-taupe"
      viewBox="0 0 96 64"
      width="96"
      height="64"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8 52V22a4 4 0 0 1 4-4h72a4 4 0 0 1 4 4v30" />
      <path d="M8 52h80" />
      <path d="M24 52v8M72 52v8" />
      <path d="M30 18v-6h36v6" />
    </svg>
  );
}

/**
 * The drop target, for "no images yet".
 *
 * Exported because the image manager's empty state *is* its drop zone — the dashed box has to keep
 * its own drag handlers, so it borrows the glyph rather than wrapping itself in an `EmptyState`.
 */
export function DropZoneGlyph(): ReactElement {
  return (
    <svg
      className="text-taupe"
      viewBox="0 0 96 64"
      width="96"
      height="64"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M10 14h76v36H10z" strokeDasharray="4 4" />
      <path d="M24 42l14-16 12 12 8-8 14 12" />
      <circle cx="66" cy="24" r="4" />
    </svg>
  );
}

export default function EmptyState({
  heading,
  message,
  illustration = 'bench',
  children,
  className,
}: EmptyStateProps): ReactElement {
  return (
    <div
      className={`flex flex-col items-center gap-4 border border-dashed border-taupe bg-white px-6 py-12 text-center${
        className === undefined ? '' : ` ${className}`
      }`}
      data-ngf-empty-state
    >
      {illustration === 'bench' && <Bench />}
      {illustration === 'drop-zone' && <DropZoneGlyph />}
      <h2 className="font-display text-h3 text-espresso">{heading}</h2>
      <p className="mx-auto max-w-[56ch] text-body text-walnut">{message}</p>
      {children !== undefined && children !== null && (
        <div className="flex flex-wrap justify-center gap-3">{children}</div>
      )}
    </div>
  );
}
