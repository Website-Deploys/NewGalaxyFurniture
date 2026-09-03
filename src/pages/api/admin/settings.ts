/**
 * `GET` / `PATCH /api/admin/settings` — `data/site/settings.json`.
 *
 * Every business fact the site displays is here, which is the whole of Requirement 19.1:
 * nothing is hard-coded in a component and nothing is invented. The endpoint's job is to make
 * sure a save cannot produce a file the build would then reject, so the patch is applied, the
 * result is validated against `SiteSettingsSchema`, and only then committed.
 *
 * Two behaviours are worth calling out:
 *
 * - **The commit never carries `[skip ci]`.** Settings change the header, the footer, the
 *   contact page and the structured data, so the operator's change has to reach the site
 *   (Requirement 17.15).
 * - **The positioning line is propagated to the homepage hero in the same request.** It is one
 *   sentence with one meaning; writing it in two files without keeping them equal would make
 *   "which one is live" depend on which surface you looked at. The homepage write is a second
 *   commit and is reported separately, so a failure there is visible rather than silent.
 *
 * Requirements: 7.8, 8.8, 19.1, 19.2, 19.6, 19.7, 19.8, 17.7, 17.15.
 */

import type { APIContext } from 'astro';

import {
  applySettingsPatch,
  applyTaglineToHomepage,
  effectiveTagline,
  SettingsPatchInput,
  taglineOf,
  validateHomepage,
  validateSettings,
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
import { SiteSettingsSchema } from '@/schemas/site';

export const prerender = false;

export async function GET(context: APIContext): Promise<Response> {
  const opened = await openAdminContext(context, 'product.read');
  if (!opened.ok) return opened.response;

  const settingsPath = siteContentPath('settings');
  const homepagePath = siteContentPath('homepage');
  if (settingsPath === null || homepagePath === null) {
    return errorResponse(ERROR_CODES.PATH_NOT_ALLOWED);
  }

  try {
    const settings = await readContentRecord(
      opened.context.client,
      settingsPath,
      SiteSettingsSchema,
    );
    if (settings === null) return errorResponse(ERROR_CODES.NOT_FOUND);
    const homepage = await readContentRecord(opened.context.client, homepagePath, HomepageSchema);

    return jsonResponse({
      settings: settings.value,
      tagline:
        homepage === null
          ? taglineOf(settings.value)
          : effectiveTagline(settings.value, homepage.value),
    });
  } catch (error) {
    logServerError('settings: read failed', error);
    return toClientErrorResponse(error);
  }
}

export async function PATCH(context: APIContext): Promise<Response> {
  const opened = await openAdminContext(context, 'settings.write');
  if (!opened.ok) return opened.response;

  const body = await readValidatedJson(context.request, SettingsPatchInput);
  if (!body.ok) return body.response;

  const settingsPath = siteContentPath('settings');
  if (settingsPath === null) return errorResponse(ERROR_CODES.PATH_NOT_ALLOWED);

  const { client, actor } = opened.context;
  try {
    const record = await readContentRecord(client, settingsPath, SiteSettingsSchema);
    if (record === null || record.sha === undefined) return errorResponse(ERROR_CODES.NOT_FOUND);

    const candidate = applySettingsPatch(record.value, body.value.patch);
    const validated = validateSettings(candidate);
    if (!validated.ok) {
      return errorResponse(ERROR_CODES.VALIDATION_FAILED, { fields: validated.fields });
    }

    const result = await writeContentRecord({
      client,
      path: settingsPath,
      record: validated.settings,
      scope: 'site',
      action: 'update',
      subject: { name: 'site settings' },
      actor,
      skipCi: false,
      sha: record.sha,
    });

    // --- Keep the hero's positioning line equal to the settings one -----------
    let taglineCommitSha: string | null = null;
    let taglineWarning: string | null = null;
    const tagline = taglineOf(validated.settings);
    if (tagline !== null) {
      const homepagePath = siteContentPath('homepage');
      try {
        if (homepagePath === null) throw new Error('homepage path not allowlisted');
        const homepage = await readContentRecord(client, homepagePath, HomepageSchema);
        if (homepage !== null && homepage.sha !== undefined) {
          const next = applyTaglineToHomepage(homepage.value, tagline);
          if (next !== null) {
            const checked = validateHomepage(next);
            if (!checked.ok) throw new Error('homepage would become invalid');
            const propagated = await writeContentRecord({
              client,
              path: homepagePath,
              record: checked.homepage,
              scope: 'site',
              action: 'update',
              subject: { name: 'homepage positioning line' },
              actor,
              skipCi: false,
              sha: homepage.sha,
            });
            taglineCommitSha = propagated.commitSha;
          }
        }
      } catch (error) {
        // Reported, not thrown: the settings save already succeeded and reversing it
        // would lose the operator's other edits. They are told what did not happen.
        logServerError('settings: could not propagate the positioning line', error);
        taglineWarning =
          'The settings were saved, but the homepage hero’s positioning line could not be updated to match. Edit it on the Homepage screen.';
      }
    }

    return jsonResponse({
      settings: validated.settings,
      commitSha: result.commitSha,
      taglineCommitSha,
      taglineWarning,
      deployTriggered: true,
    });
  } catch (error) {
    logServerError('settings: update failed', error);
    return toClientErrorResponse(error);
  }
}
