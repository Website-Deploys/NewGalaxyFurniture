/**
 * Homepage composition: re-word and enable or disable each of the fifteen sections.
 *
 * There is no reorder control on this screen, and its absence is the design. Requirement 7.1
 * fixes the relative order of the fifteen sections; the operator's authority is over the words
 * and over whether a section appears at all (Requirements 7.7, 7.13). The sections are rendered
 * in their canonical order with their position shown, so the operator can see the order they
 * are working within rather than wondering why they cannot change it.
 *
 * Placeholder copy is shown as what it is. A section whose body still holds a
 * `[PLACEHOLDER — …]` marker is flagged here and listed on the Content screen, and the hint
 * says why it is there: no manufacturing process, timeline, capability or achievement is
 * invented, so the marker stands until the operator writes the real thing (Requirement 7.10).
 *
 * Requirements: 7.1, 7.7, 7.10, 7.13, 8.8, 24.9, 26.9, 26.14.
 */

import { useState } from 'react';
import type { ReactElement } from 'react';

import { adminFetch, type FieldErrors } from '@/lib/admin/client';
import { CheckboxField, TextAreaField, TextField } from './fields';
import { HOMEPAGE_SECTION_KEYS } from '@/schemas/homepage';
import type { Homepage, HomepageSection, HomepageSectionKeyValue } from '@/schemas/homepage';

export interface HomepageEditorProps {
  homepage: Homepage;
  canWrite: boolean;
}

/** What each section is for, so "disable" is an informed decision. */
const SECTION_PURPOSE: Record<HomepageSectionKeyValue, string> = {
  hero: 'The first screen: brand mark, positioning line and the three calls to action.',
  shopByCategory: 'The category grid.',
  featuredProducts: 'Products you have marked as featured.',
  newArrivals: 'Products you have marked as new arrivals.',
  bestSellers: 'Products you have marked as best sellers — your judgement, not a sales figure.',
  trending: 'Products you have marked as trending, or the measured most-viewed list.',
  craftsmanship: 'How the furniture is made, in your words.',
  directManufacturer: 'What buying direct from you means for the customer.',
  customFurniture: 'What can be customised and how an enquiry proceeds.',
  workshopStory: 'The showroom and workshop, in your words.',
  customerReviews: 'Published customer reviews.',
  gallery: 'The image gallery.',
  whatsappCta: 'The full-width WhatsApp and call invitation.',
  contactLocation: 'Address, numbers and map, from settings.',
  footer: 'The footer.',
};

/** The editable copy fields, in the order they read on the page. */
const COPY_FIELDS: readonly (readonly [
  'eyebrow' | 'heading' | 'subheading' | 'body' | 'ctaLabel' | 'ctaHref',
  string,
  number,
])[] = [
  ['eyebrow', 'Eyebrow', 60],
  ['heading', 'Heading', 120],
  ['subheading', 'Subheading', 240],
  ['body', 'Body', 2000],
  ['ctaLabel', 'Button label', 40],
  ['ctaHref', 'Button link', 200],
];

type Draft = Record<string, string | boolean>;

function keyFor(section: HomepageSectionKeyValue, field: string): string {
  return `${section}.${field}`;
}

function draftOf(homepage: Homepage): Draft {
  const draft: Draft = {};
  for (const section of homepage.sections) {
    draft[keyFor(section.key, 'enabled')] = section.enabled;
    for (const [field] of COPY_FIELDS) {
      draft[keyFor(section.key, field)] = section[field] ?? '';
    }
  }
  return draft;
}

export default function HomepageEditor(props: HomepageEditorProps): ReactElement {
  const [draft, setDraft] = useState<Draft>(() => draftOf(props.homepage));
  const [sections, setSections] = useState<readonly HomepageSection[]>(props.homepage.sections);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ordered = [...sections].sort(
    (a, b) => HOMEPAGE_SECTION_KEYS.indexOf(a.key) - HOMEPAGE_SECTION_KEYS.indexOf(b.key),
  );

  function text(section: HomepageSectionKeyValue, field: string): string {
    const value = draft[keyFor(section, field)];
    return typeof value === 'string' ? value : '';
  }

  function enabled(section: HomepageSectionKeyValue): boolean {
    return draft[keyFor(section, 'enabled')] === true;
  }

  function set(section: HomepageSectionKeyValue, field: string, value: string | boolean): void {
    setDraft((current) => ({ ...current, [keyFor(section, field)]: value }));
  }

  async function save(): Promise<void> {
    setBusy(true);
    setErrors({});
    const payload = ordered.map((section) => {
      const entry: Record<string, unknown> = {
        key: section.key,
        enabled: enabled(section.key),
      };
      for (const [field] of COPY_FIELDS) {
        const value = text(section.key, field);
        // Null clears the field; the endpoint deletes the key rather than storing "".
        entry[field] = value.trim() === '' ? null : value;
      }
      return entry;
    });

    const result = await adminFetch<{ homepage: Homepage }>('/api/admin/homepage', {
      method: 'PATCH',
      body: { sections: payload },
    });
    setBusy(false);

    if (!result.ok) {
      setErrors(result.error.fields ?? {});
      setStatus(result.error.message);
      return;
    }
    setSections(result.value.homepage.sections);
    setDraft(draftOf(result.value.homepage));
    setStatus(
      'Saved. The homepage rebuilds with these words, so the change appears publicly after the next deploy completes. The order of the sections is unchanged.',
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {status !== null && (
        <p role="status" className="border border-taupe bg-white px-4 py-3 text-small">
          {status}
        </p>
      )}

      <ol className="flex flex-col gap-4">
        {ordered.map((section, index) => {
          const isEnabled = enabled(section.key);
          const body = text(section.key, 'body');
          const holdsPlaceholder = /\[PLACEHOLDER/i.test(body);

          return (
            <li key={section.key} className="border border-taupe bg-white p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="font-display text-h3 text-espresso">
                  {index + 1}. {section.key}
                </h2>
                <p className="text-small text-walnut">
                  {isEnabled ? 'Renders on the homepage' : 'Hidden from the homepage'}
                </p>
              </div>
              <p className="mt-1 max-w-[70ch] text-small text-walnut">
                {SECTION_PURPOSE[section.key]}
              </p>

              <div className="mt-3">
                <CheckboxField
                  id={`enabled-${section.key}`}
                  label="Show this section"
                  checked={isEnabled}
                  disabled={!props.canWrite}
                  onChange={(value) => set(section.key, 'enabled', value)}
                  hint="Turning it off removes it after the next deploy; turning it back on restores it in this same position."
                />
              </div>

              {holdsPlaceholder && (
                <p className="mt-2 border-l-2 border-espresso pl-3 text-small text-espresso">
                  This section still shows a placeholder to visitors. It is listed on the Content
                  screen. Nothing about your process, timeline or achievements will be written for
                  you — replace the bracketed text with your own words.
                </p>
              )}

              <div className="mt-3 grid gap-3 md:grid-cols-2">
                {COPY_FIELDS.map(([field, label, maxLength]) => {
                  const errorKey = `sections.${String(
                    props.homepage.sections.findIndex((entry) => entry.key === section.key),
                  )}.${field}`;
                  const fieldErrors = errors[errorKey];
                  const shared = {
                    id: `${section.key}-${field}`,
                    label: `${label} (optional)`,
                    value: text(section.key, field),
                    maxLength,
                    disabled: !props.canWrite,
                    onChange: (value: string) => set(section.key, field, value),
                    ...(fieldErrors === undefined ? {} : { errors: fieldErrors }),
                  };
                  return field === 'body' || field === 'subheading' ? (
                    <div key={field} className="md:col-span-2">
                      <TextAreaField {...shared} rows={field === 'body' ? 5 : 2} />
                    </div>
                  ) : (
                    <TextField key={field} {...shared} />
                  );
                })}
              </div>
            </li>
          );
        })}
      </ol>

      {props.canWrite && (
        <div className="flex gap-3 border-t border-taupe pt-6">
          <button
            type="button"
            disabled={busy}
            onClick={() => void save()}
            className="min-h-[44px] bg-espresso px-5 py-3 text-ivory disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save homepage'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setDraft(draftOf(props.homepage));
              setErrors({});
              setStatus('Reverted to the stored words. Nothing was saved.');
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
