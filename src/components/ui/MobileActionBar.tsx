/**
 * The sticky mobile action bar: WhatsApp | Call, below 768 px only.
 *
 * The scroll behaviour is specified precisely (Requirements 5.16, 5.17) and is easy to get
 * subtly wrong, so it is worth being explicit about what "cumulative" means here: the
 * accumulator tracks distance travelled **in the current direction** and resets the moment
 * the direction reverses. That is what makes a slow 3 px-per-frame scroll eventually hide the
 * bar while a 10 px jitter down-and-up leaves it alone. A naive `delta > 24` per event never
 * fires on a slow scroll; a naive absolute-position comparison fires on jitter.
 *
 * Three further rules, each with a reason:
 *
 * - **Always visible within 24 px of the top** (5.17), whatever the last direction was. A
 *   visitor who has just arrived, or who has scrolled back to the hero, gets the bar.
 * - **Never sized in JS.** The 56 px height, the `env(safe-area-inset-bottom)` padding, and
 *   the below-768 px visibility are all CSS (see `src/styles/shell.css`), so they hold before
 *   this island hydrates and on a device where hydration never happens. The island only
 *   toggles one attribute.
 * - **Reduced motion needs no branch here.** The transition is declared in CSS and the global
 *   `prefers-reduced-motion` block clamps it, so both states render with no animation and both
 *   remain operable (5.18).
 *
 * The bar's height is reserved as page bottom padding by `BaseLayout`, so the footer is never
 * covered at any scroll position (5.19).
 *
 * Requirements: 5.14, 5.15, 5.16, 5.17, 5.18, 5.19, 24.3.
 */

import { useEffect, useState } from 'react';

/** Requirements 5.16 and 5.17 both use 24 px. */
export const SCROLL_THRESHOLD_PX = 24;

export interface MobileActionBarProps {
  /** Pre-built server-side by `buildWhatsAppUrl`. */
  whatsappHref: string;
  telHref: string;
  /** The one shared label; neither control is a different department (5.10). */
  numberLabel: string;
}

export default function MobileActionBar({
  whatsappHref,
  telHref,
  numberLabel,
}: MobileActionBarProps): React.JSX.Element {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    let lastY = window.scrollY;
    let travelled = 0;
    let frame = 0;

    const evaluate = (): void => {
      frame = 0;
      const y = window.scrollY;
      const delta = y - lastY;
      lastY = y;

      // Near the top the bar is shown unconditionally, and the accumulator is cleared so the
      // next gesture starts from zero rather than from a stale downward total.
      if (y <= SCROLL_THRESHOLD_PX) {
        travelled = 0;
        setVisible(true);
        return;
      }

      if (delta === 0) return;
      // Direction reversal restarts the count — this is what makes the threshold cumulative
      // per gesture rather than per event.
      travelled = Math.sign(travelled) === Math.sign(delta) ? travelled + delta : delta;

      if (travelled >= SCROLL_THRESHOLD_PX) {
        travelled = 0;
        setVisible(false);
      } else if (travelled <= -SCROLL_THRESHOLD_PX) {
        travelled = 0;
        setVisible(true);
      }
    };

    const onScroll = (): void => {
      // One evaluation per frame: a scroll listener that does work per event is the classic
      // cause of a janky sticky bar, and the design forbids always-on rAF loops.
      if (frame === 0) frame = window.requestAnimationFrame(evaluate);
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div
      className="ngf-actionbar"
      data-visible={visible ? 'true' : 'false'}
      inert={!visible}
      aria-label={numberLabel}
      role="group"
    >
      <a href={whatsappHref} target="_blank" rel="noopener" className="ngf-actionbar-whatsapp">
        WhatsApp
      </a>
      <a href={telHref} className="ngf-actionbar-call">
        Call
      </a>
    </div>
  );
}
