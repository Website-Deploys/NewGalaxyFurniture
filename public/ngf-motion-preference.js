/**
 * The visitor's motion preference, applied before first paint.
 *
 * Blocking and external: blocking because applying `data-motion="off"` after paint would animate
 * one frame of precisely what the visitor asked not to see, and external because inline execution
 * is incompatible with `script-src 'self'` and this project keeps the policy rather than granting
 * itself an exemption.
 *
 * The OS-level `prefers-reduced-motion` is handled entirely in CSS — every from-state lives inside
 * a `no-preference` block — so this file exists only for the in-page toggle, whose value is stored
 * under `ngf:motion`.
 *
 * Requirements: 21.11, 21.13, 25.10.
 */
try {
  if (window.localStorage.getItem('ngf:motion') === 'off') {
    document.documentElement.dataset.motion = 'off';
  }
} catch (error) {
  /* storage blocked (private mode, third-party context) — the OS media query still applies */
}
