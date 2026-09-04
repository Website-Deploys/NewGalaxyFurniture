/// <reference types="astro/client" />

import type { Session } from '@/lib/auth/session';

/**
 * `App.Locals` augmentation.
 *
 * Two things this file used to get wrong and no longer does:
 *
 * 1. **`declare global`.** This file has top-level imports, so it is a module, and a
 *    bare `declare namespace App` inside a module declares a *local* namespace that
 *    augments nothing. Without the `global` wrapper the augmentation silently had no
 *    effect and `locals.adminSession` was a type error.
 * 2. **No `runtime`.** @astrojs/cloudflare v14 removed `locals.runtime`; its `env`
 *    getter now throws a migration error. Bindings are read through
 *    `src/lib/env.ts`, which sources them from `cloudflare:workers`. The adapter's
 *    own `App.Locals extends Runtime` supplies `cfContext` for `waitUntil`.
 */
declare global {
  namespace App {
    interface Locals {
      /**
       * Set by `src/middleware.ts` for authenticated `/admin/**` page renders only.
       * Its presence is not an authorization decision — pages read the role off it
       * to hide controls, and every mutation still goes through an API endpoint
       * that re-derives authority from `ADMIN_ROUTES`.
       */
      adminSession?: Session;
    }
  }
}
