/**
 * Site settings: business name, brand mark, numbers, location, service area, socials, SEO
 * defaults, and the positioning line.
 *
 * The two rules this screen exists to make operable:
 *
 * - **Numbers are a list the operator can grow.** Add and Remove act on an array, and each
 *   entry is validated as E.164 before it can be saved — client-side for an immediate message,
 *   and again on the server, which is the check that counts (Requirements 19.2, 19.8). The
 *   label is the operator's words, and the hint says plainly that both numbers are for orders
 *   and enquiries and must not be labelled as separate departments (Requirement 5.10).
 * - **Blank means unsupplied, and the form says what that does.** Clearing the map URL removes
 *   it from every public surface and from structured data rather than rendering a guess
 *   (Requirement 19.6). Each optional field's hint says so, because "leave it empty" is only
 *   safe advice if the operator knows what empty produces.
 *
 * No value on this screen is generated or suggested. The brand mark field takes a path to a
 * file the operator has added; until it is set, the site renders the typographic wordmark
 * (Requirements 19.4, 19.5).
 *
 * Requirements: 5.10, 7.8, 19.1, 19.2, 19.4, 19.5, 19.6, 19.7, 19.8, 24.9, 26.9.
 */

import { useState } from 'react';
import type { ReactElement } from 'react';

import { adminFetch, type FieldErrors } from '@/lib/admin/client';
import { E164_PATTERN, normalizeIndianPhone } from '@/lib/phone';
import { FormSection, NumberField, TextAreaField, TextField, Wide } from './fields';
import type { ContactNumberValue, SiteSettings } from '@/schemas/site';

export interface SettingsFormProps {
  settings: SiteSettings;
  /** The positioning line in force — the settings key, or the hero's until one is saved. */
  tagline: string | null;
  canWrite: boolean;
}

interface Draft {
  businessName: string;
  logoSrc: string;
  /** The asset's intrinsic pixels. Required as soon as a path is set — see `SiteSettingsSchema`. */
  logoWidth: number | null;
  logoHeight: number | null;
  wordmarkFallback: string;
  whatsapp: ContactNumberValue[];
  phone: ContactNumberValue[];
  addressLines: string;
  city: string;
  state: string;
  postalCode: string;
  mapUrl: string;
  serviceArea: string;
  social: { key: string; url: string }[];
  titleSuffix: string;
  seoDescription: string;
  ogImageKey: string;
  tagline: string;
}

function draftOf(settings: SiteSettings, tagline: string | null): Draft {
  return {
    businessName: settings.businessName,
    logoSrc: settings.logo.src ?? '',
    logoWidth: settings.logo.width ?? null,
    logoHeight: settings.logo.height ?? null,
    wordmarkFallback: settings.logo.wordmarkFallback,
    whatsapp: settings.whatsapp.map((entry) => ({ ...entry })),
    phone: settings.phone.map((entry) => ({ ...entry })),
    addressLines: settings.location.addressLines.join('\n'),
    city: settings.location.city,
    state: settings.location.state,
    postalCode: settings.location.postalCode ?? '',
    mapUrl: settings.location.mapUrl ?? '',
    serviceArea: settings.serviceArea.join(', '),
    social: Object.entries(settings.social).map(([key, url]) => ({ key, url: url ?? '' })),
    titleSuffix: settings.seoDefaults.titleSuffix,
    seoDescription: settings.seoDefaults.description,
    ogImageKey: settings.seoDefaults.ogImageKey ?? '',
    tagline: tagline ?? '',
  };
}

const blank = (value: string): string | null => (value.trim() === '' ? null : value.trim());

/**
 * Client-side E.164 check, with a helpful normalisation offer for Indian input.
 *
 * The server validates independently; this exists so an operator typing `9513443606` is told
 * what the canonical form is instead of being refused after a round trip.
 */
function numberProblem(entry: ContactNumberValue): string | null {
  if (entry.label.trim() === '') return 'Give this number a label.';
  if (E164_PATTERN.test(entry.e164)) return null;
  const normalized = normalizeIndianPhone(entry.e164);
  return normalized.ok
    ? `Use the international form: ${normalized.e164}`
    : 'Enter a full international number, starting with + and the country code.';
}

export default function SettingsForm(props: SettingsFormProps): ReactElement {
  const [draft, setDraft] = useState<Draft>(() => draftOf(props.settings, props.tagline));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function update<K extends keyof Draft>(key: K, value: Draft[K]): void {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function updateNumber(
    list: 'whatsapp' | 'phone',
    index: number,
    patch: Partial<ContactNumberValue>,
  ): void {
    setDraft((current) => ({
      ...current,
      [list]: current[list].map((entry, position) =>
        position === index ? { ...entry, ...patch } : entry,
      ),
    }));
  }

  async function save(): Promise<void> {
    // Every number is checked before a request is made, so an invalid list produces a
    // message next to the offending field rather than a 422 for the whole form.
    const numberErrors: FieldErrors = {};
    for (const list of ['whatsapp', 'phone'] as const) {
      draft[list].forEach((entry, index) => {
        const problem = numberProblem(entry);
        if (problem !== null) numberErrors[`${list}.${String(index)}.e164`] = [problem];
      });
    }
    if (Object.keys(numberErrors).length > 0) {
      setErrors(numberErrors);
      setStatus('Some numbers need attention. Nothing has been saved.');
      return;
    }

    setBusy(true);
    setErrors({});
    const social: Record<string, string | null> = {};
    for (const entry of draft.social) {
      if (entry.key.trim() !== '') social[entry.key.trim()] = blank(entry.url);
    }

    const result = await adminFetch<{ taglineWarning: string | null }>('/api/admin/settings', {
      method: 'PATCH',
      body: {
        patch: {
          businessName: draft.businessName,
          logo: {
            src: blank(draft.logoSrc),
            wordmarkFallback: draft.wordmarkFallback,
            width: draft.logoWidth,
            height: draft.logoHeight,
          },
          whatsapp: draft.whatsapp,
          phone: draft.phone,
          location: {
            addressLines: draft.addressLines.split('\n'),
            city: draft.city,
            state: draft.state,
            postalCode: blank(draft.postalCode),
            mapUrl: blank(draft.mapUrl),
            geo: props.settings.location.geo,
          },
          serviceArea: draft.serviceArea
            .split(',')
            .map((part) => part.trim())
            .filter((part) => part !== ''),
          social,
          seoDefaults: {
            titleSuffix: draft.titleSuffix,
            description: draft.seoDescription,
            ogImageKey: blank(draft.ogImageKey),
          },
          ...(draft.tagline.trim() === '' ? {} : { tagline: draft.tagline.trim() }),
        },
      },
    });
    setBusy(false);

    if (!result.ok) {
      setErrors(result.error.fields ?? {});
      setStatus(result.error.message);
      return;
    }
    setStatus(
      result.value.taglineWarning ??
        'Saved. The site rebuilds with these values, so they appear publicly after the next deploy completes.',
    );
  }

  const numberList = (list: 'whatsapp' | 'phone', label: string): ReactElement => (
    <Wide>
      <fieldset className="border border-taupe p-4">
        <legend className="px-2 text-small font-medium text-espresso">{label}</legend>
        <p className="mb-3 max-w-[70ch] text-small text-walnut">
          Both numbers are for orders and enquiries. Label them so, and never as different
          departments, teams or functions — the site presents them as equals everywhere.
        </p>
        <ul className="flex flex-col gap-3">
          {draft[list].map((entry, index) => {
            const errorKey = `${list}.${String(index)}.e164`;
            const problem = errors[errorKey];
            return (
              <li
                key={`${list}-${String(index)}`}
                className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]"
              >
                <TextField
                  id={`${list}-label-${String(index)}`}
                  label="Label"
                  value={entry.label}
                  disabled={!props.canWrite}
                  onChange={(value) => updateNumber(list, index, { label: value })}
                />
                <TextField
                  id={`${list}-e164-${String(index)}`}
                  label="Number (international form)"
                  value={entry.e164}
                  placeholder="+919513443606"
                  disabled={!props.canWrite}
                  onChange={(value) => updateNumber(list, index, { e164: value })}
                  {...(problem === undefined ? {} : { errors: problem })}
                />
                {props.canWrite && draft[list].length > 1 && (
                  <button
                    type="button"
                    onClick={() => {
                      update(
                        list,
                        draft[list].filter((_, position) => position !== index),
                      );
                    }}
                    className="mt-6 min-h-[44px] self-start border border-espresso px-3 py-2 text-espresso"
                  >
                    Remove
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {props.canWrite && (
          <button
            type="button"
            onClick={() => {
              update(list, [...draft[list], { label: 'Orders & Enquiries', e164: '' }]);
            }}
            className="mt-3 min-h-[44px] border border-espresso px-4 py-2 text-espresso"
          >
            Add a number
          </button>
        )}
      </fieldset>
    </Wide>
  );

  return (
    <div className="flex flex-col gap-8">
      {status !== null && (
        <p role="status" className="border border-taupe bg-white px-4 py-3 text-small">
          {status}
        </p>
      )}

      <FormSection
        id="business"
        title="Business"
        description="The name and positioning line the site presents. Both are yours to write; neither is generated."
      >
        <TextField
          id="business-name"
          label="Business name"
          value={draft.businessName}
          required
          disabled={!props.canWrite}
          onChange={(value) => update('businessName', value)}
          {...(errors.businessName === undefined ? {} : { errors: errors.businessName })}
        />
        <TextField
          id="tagline"
          label="Positioning line"
          value={draft.tagline}
          maxLength={120}
          hint="1–120 characters. Shown in the hero. Saving also updates the homepage hero so the two never disagree."
          disabled={!props.canWrite}
          onChange={(value) => update('tagline', value)}
          {...(errors.tagline === undefined ? {} : { errors: errors.tagline })}
        />
      </FormSection>

      <FormSection
        id="brand"
        title="Brand mark"
        description="Until a file is supplied, the site renders the typographic wordmark in the header, footer, hero, social preview and admin. Supplying one needs no code change."
      >
        <TextField
          id="logo-src"
          label="Brand mark path (optional)"
          value={draft.logoSrc}
          placeholder="/brand/logo.svg"
          hint="Leave empty to keep the wordmark. Add the file to public/brand/ first."
          disabled={!props.canWrite}
          onChange={(value) => update('logoSrc', value)}
          {...(errors['logo.src'] === undefined ? {} : { errors: errors['logo.src'] })}
        />
        {/*
          The intrinsic box. Asked for beside the path rather than derived, because the file is
          dropped into `public/brand/` by hand and nothing on the server reads it — and an image
          without its dimensions shifts the header on every page the moment it loads.
        */}
        <NumberField
          id="logo-width"
          label="Brand mark width in pixels"
          value={draft.logoWidth}
          min={1}
          hint="Required once a path is set."
          disabled={!props.canWrite}
          onChange={(value) => update('logoWidth', value)}
          {...(errors['logo.width'] === undefined ? {} : { errors: errors['logo.width'] })}
        />
        <NumberField
          id="logo-height"
          label="Brand mark height in pixels"
          value={draft.logoHeight}
          min={1}
          hint="Required once a path is set."
          disabled={!props.canWrite}
          onChange={(value) => update('logoHeight', value)}
          {...(errors['logo.height'] === undefined ? {} : { errors: errors['logo.height'] })}
        />
        <TextField
          id="wordmark"
          label="Wordmark text"
          value={draft.wordmarkFallback}
          required
          disabled={!props.canWrite}
          onChange={(value) => update('wordmarkFallback', value)}
        />
      </FormSection>

      <FormSection id="contact" title="Contact numbers">
        {numberList('whatsapp', 'WhatsApp numbers')}
        {numberList('phone', 'Phone numbers')}
      </FormSection>

      <FormSection
        id="location"
        title="Location and service area"
        description="Anything left empty is omitted from every public surface and from structured data, rather than being shown as a guess."
      >
        <Wide>
          <TextAreaField
            id="address"
            label="Address lines (one per line, optional)"
            value={draft.addressLines}
            rows={3}
            hint="Empty means no address is published anywhere."
            disabled={!props.canWrite}
            onChange={(value) => update('addressLines', value)}
          />
        </Wide>
        <TextField
          id="city"
          label="City (optional)"
          value={draft.city}
          disabled={!props.canWrite}
          onChange={(value) => update('city', value)}
        />
        <TextField
          id="state"
          label="State (optional)"
          value={draft.state}
          disabled={!props.canWrite}
          onChange={(value) => update('state', value)}
        />
        <TextField
          id="postal"
          label="Postal code (optional)"
          value={draft.postalCode}
          disabled={!props.canWrite}
          onChange={(value) => update('postalCode', value)}
        />
        <TextField
          id="map-url"
          label="Map link (optional)"
          value={draft.mapUrl}
          hint="Paste the full share link to your location, or leave it empty for no map link."
          disabled={!props.canWrite}
          onChange={(value) => update('mapUrl', value)}
          {...(errors['location.mapUrl'] === undefined
            ? {}
            : { errors: errors['location.mapUrl'] })}
        />
        <TextField
          id="service-area"
          label="Service area"
          value={draft.serviceArea}
          hint="Comma-separated. Add locations freely — the stored structure is a list."
          disabled={!props.canWrite}
          onChange={(value) => update('serviceArea', value)}
        />
      </FormSection>

      <FormSection
        id="social"
        title="Social profiles"
        description="A profile left empty is omitted from the footer and from structured data. No profile is ever guessed from the business name."
      >
        <Wide>
          <ul className="flex flex-col gap-3">
            {draft.social.map((entry, index) => (
              <li key={entry.key} className="grid gap-2 sm:grid-cols-2">
                <TextField
                  id={`social-key-${String(index)}`}
                  label="Network"
                  value={entry.key}
                  disabled={!props.canWrite}
                  onChange={(value) => {
                    update(
                      'social',
                      draft.social.map((item, position) =>
                        position === index ? { ...item, key: value } : item,
                      ),
                    );
                  }}
                />
                <TextField
                  id={`social-url-${String(index)}`}
                  label="Profile URL (optional)"
                  value={entry.url}
                  hint="The full address of your profile on this network, or empty."
                  disabled={!props.canWrite}
                  onChange={(value) => {
                    update(
                      'social',
                      draft.social.map((item, position) =>
                        position === index ? { ...item, url: value } : item,
                      ),
                    );
                  }}
                  {...(errors[`social.${entry.key}`] === undefined
                    ? {}
                    : { errors: errors[`social.${entry.key}`] })}
                />
              </li>
            ))}
          </ul>
          {props.canWrite && (
            <button
              type="button"
              onClick={() => update('social', [...draft.social, { key: '', url: '' }])}
              className="mt-3 min-h-[44px] border border-espresso px-4 py-2 text-espresso"
            >
              Add a network
            </button>
          )}
        </Wide>
      </FormSection>

      <FormSection
        id="seo"
        title="SEO defaults"
        description="Used for any page that does not set its own title or description."
      >
        <TextField
          id="title-suffix"
          label="Title suffix"
          value={draft.titleSuffix}
          maxLength={60}
          disabled={!props.canWrite}
          onChange={(value) => update('titleSuffix', value)}
        />
        <TextField
          id="og-image"
          label="Social preview image key (optional)"
          value={draft.ogImageKey}
          hint="Empty means the wordmark preview is used."
          disabled={!props.canWrite}
          onChange={(value) => update('ogImageKey', value)}
        />
        <Wide>
          <TextAreaField
            id="seo-description"
            label="Default description"
            value={draft.seoDescription}
            rows={3}
            maxLength={300}
            disabled={!props.canWrite}
            onChange={(value) => update('seoDescription', value)}
          />
        </Wide>
      </FormSection>

      {props.canWrite && (
        <div className="flex gap-3 border-t border-taupe pt-6">
          <button
            type="button"
            disabled={busy}
            onClick={() => void save()}
            className="min-h-[44px] bg-espresso px-5 py-3 text-ivory disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save settings'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setDraft(draftOf(props.settings, props.tagline));
              setErrors({});
              setStatus('Reverted to the stored values. Nothing was saved.');
            }}
            className="min-h-[44px] border border-espresso px-4 py-3 text-espresso"
          >
            Revert
          </button>
        </div>
      )}
    </div>
  );
}
