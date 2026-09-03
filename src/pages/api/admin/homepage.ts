/**
 * `GET` / `PATCH /api/admin/homepage` — `data/site/homepage.json`.
 *
 * The operator controls what each of the fifteen sections says and whether it renders. The
 * operator does not control the order, because the order is Requirement 7.1's and is pinned by
 * `HOMEPAGE_SECTION_KEYS`. That is enforced structurally rather than by validation: the patch
 * input carries no position field at all, and `applyHomepagePatch` rewrites sections in place
 * by key, so there is no request that could express a reorder (Requirements 7.7, 7.13).
 *
 * Disabling a section is a content change a visitor sees, so the commit rebuilds
 * (Requirement 17.15) — a section the operator turned off must actually disappear.
 *
 * Requirements: 7.7, 7.8, 7.10, 7.13, 8.8, 17.15.
 */

import type { APIContext } from 'astro';

import {
  applyHomepagePatch,
  homepagePlaceholderKeys,
  HomepagePatchInput,
  validateHomepage,
} from '@/lib/site/store';
import {
  ERROR_CODES,
  errorResponse,
  jsonResponse,
  logServerError,
  toClientErrorResponse,
} from '@/lib/errors';
import { HomepageSchema } from '@/schemas/homepage';
import { openAdminContext } from '@/lib/admin/context';
import { readContentRecord, writeContentRecord } from '@/lib/github/content-writer';
import { readValidatedJson } from '@/lib/auth/guard';
import { siteContentPath } from '@/lib/github/paths';

export const prerender = false;

export async function GET(context: APIContext): Promise<Response> {
  const opened = await openAdminContext(context, 'product.read');
  if (!opened.ok) return opened.response;

  const path = siteContentPath('homepage');
  if (path === null) return errorResponse(ERROR_CODES.PATH_NOT_ALLOWED);

  try {
    const record = await readContentRecord(opened.context.client, path, HomepageSchema);
    if (record === null) return errorResponse(ERROR_CODES.NOT_FOUND);
    return jsonResponse({
      homepage: record.value,
      awaitingCopy: homepagePlaceholderKeys(record.value),
    });
  } catch (error) {
    logServerError('homepage: read failed', error);
    return toClientErrorResponse(error);
  }
}

export async function PATCH(context: APIContext): Promise<Response> {
  const opened = await openAdminContext(context, 'settings.write');
  if (!opened.ok) return opened.response;

  const body = await readValidatedJson(context.request, HomepagePatchInput);
  if (!body.ok) return body.response;

  const path = siteContentPath('homepage');
  if (path === null) return errorResponse(ERROR_CODES.PATH_NOT_ALLOWED);

  const { client, actor } = opened.context;
  try {
    const record = await readContentRecord(client, path, HomepageSchema);
    if (record === null || record.sha === undefined) return errorResponse(ERROR_CODES.NOT_FOUND);

    const candidate = applyHomepagePatch(record.value, body.value.sections);
    const validated = validateHomepage(candidate);
    if (!validated.ok) {
      return errorResponse(ERROR_CODES.VALIDATION_FAILED, { fields: validated.fields });
    }

    const result = await writeContentRecord({
      client,
      path,
      record: validated.homepage,
      scope: 'site',
      action: 'update',
      subject: { name: 'homepage sections' },
      actor,
      skipCi: false,
      sha: record.sha,
    });

    return jsonResponse({
      homepage: validated.homepage,
      awaitingCopy: homepagePlaceholderKeys(validated.homepage),
      commitSha: result.commitSha,
      deployTriggered: true,
    });
  } catch (error) {
    logServerError('homepage: update failed', error);
    return toClientErrorResponse(error);
  }
}
