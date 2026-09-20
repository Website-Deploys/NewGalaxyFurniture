/// <reference types="astro/client" />

import type { NetlifyLocals } from '@astrojs/netlify';
import type { Session } from '@/lib/auth/session';

/**
 * `App.Locals` augmentation.
 *
 * Extends `NetlifyLocals` so `Astro.locals.netlify.context` (client IP, geo, cookies) is typed on
 * on-demand routes, and adds `adminSession`, set by `src/middleware.ts` for authenticated
 * `/admin/**` page renders only. Its presence is not an authorization decision — pages read the
 * role off it to hide controls, and every mutation still goes through an API endpoint that
 * re-derives authority from `ADMIN_ROUTES`.
 *
 * `declare global` is required because this file has top-level imports (it is a module); a bare
 * `declare namespace App` would augment nothing.
 */
declare global {
  namespace App {
    interface Locals extends NetlifyLocals {
      adminSession?: Session;
    }
  }
}
