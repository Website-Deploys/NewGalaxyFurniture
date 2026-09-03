/**
 * `robots.txt`. The document itself is `@/lib/seo/robots`; this is the route.
 *
 * Requirements: 23.13, 23.14.
 */

import { renderRobots } from '@/lib/seo/robots';
import { resolveSiteUrl } from '@/lib/seo/site-url';
import type { APIContext } from 'astro';

export function GET(context: APIContext): Response {
  return new Response(renderRobots(resolveSiteUrl(context.site ?? null)), {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
}
