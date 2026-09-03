/**
 * The shared enquiry form.
 *
 * All five forms are this component with a different field list, so there is exactly one
 * implementation of the parts that are easy to get subtly wrong and that Requirements 6.3,
 * 24.8, 24.9, 26.2 and 26.9 all bear on:
 *
 * - **Labels are real `<label for>` elements**, never a placeholder standing in for one. A
 *   placeholder disappears the moment someone types, which is when they most need to know what
 *   the field was.
 * - **Errors are `aria-describedby` targets and set `aria-invalid`**, and the error summary is
 *   an `aria-live` region that is *only* populated after a submission — a live region that
 *   updates while someone types reads their own typing back to them.
 * - **Nothing is ever cleared on failure.** State lives in one `values` record and no failure
 *   path writes to it. That is why the requirement holds for every one of the six failure
 *   modes at once rather than being re-established in each branch (6.5, 6.9, 6.17, 6.18, 6.19).
 * - **The honeypot is not `display: none`.** A field hidden that way is skipped by some
 *   password managers and, more importantly, by some screen readers in a way that makes it a
 *   trap for humans. It is positioned off-canvas, `tabIndex={-1}`, `aria-hidden`, and
 *   `autoComplete="off"` so a human never reaches it and a bot filling every input does.
 * - **`renderedAt` is captured once, on mount**, in a ref rather than in state: it must not
 *   change on re-render, or the 1.5 s minimum would reset every keystroke.
 * - **The WhatsApp and Call alternatives are always present after a failure**, and are real
 *   `<a>` elements built server-side, so they work when the form does not. Requirement 6.19
 *   asks for both numbers on a storage failure; the same block serves the network and
 *   rate-limit cases, where it is equally the honest way through.
 *
 * The submit button is disabled only while a request is in flight, and never as a substitute
 * for validation: a form that greys out its own button until it decides you are finished is
 * a form that cannot tell you what it wants.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.5, 6.8, 6.9, 6.17, 6.18, 6.19, 24.8, 24.9, 26.2, 26.9.
 */

import { useEffect, useId, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, ReactElement } from 'react';

import { LEAD_LIMITS } from '@/schemas/lead';
import { current as currentBatcher } from '@/lib/analytics/client';
import { submitEnquiry, type EnquiryFailure, type FieldErrors } from '@/lib/leads/submit';
import type { LeadTypeValue } from '@/schemas/lead';

/** The fields any form may ask for. Order here is the order they render in. */
export const FIELD_ORDER = [
  'name',
  'phone',
  'requirement',
  'budget',
  'dimensions',
  'message',
  'image',
] as const;

export type FieldKey = (typeof FIELD_ORDER)[number];

/** One published number, with both channels pre-built on the server. */
export interface FallbackNumber {
  display: string;
  whatsappHref: string;
  telHref: string;
}

export interface EnquiryFormProps {
  type: LeadTypeValue;
  /** Which fields this form asks for. `name`, `phone` and `message` are always required. */
  fields: readonly FieldKey[];
  submitLabel: string;
  /** A short sentence above the fields saying what happens after sending. */
  intro?: string;
  /** The product this enquiry is about, for Quick Enquire. Server-resolved on submit. */
  productSlug?: string;
  productName?: string;
  /** Both numbers, for every failure path's alternative. */
  numbers: readonly FallbackNumber[];
  /** Called after a stored enquiry, so a dialog host can close itself. */
  onSuccess?: () => void;
  /** Rendered inside the form's own `<h2>`; omitted when the page supplies the heading. */
  heading?: string;
}

interface FieldSpec {
  label: string;
  /** `input` type, or `textarea`. */
  control: 'text' | 'tel' | 'textarea' | 'file';
  required: boolean;
  maxLength?: number;
  rows?: number;
  autoComplete?: string;
  hint?: string;
  inputMode?: 'text' | 'tel' | 'numeric';
}

const FIELDS: Record<FieldKey, FieldSpec> = {
  name: {
    label: 'Your name',
    control: 'text',
    required: true,
    maxLength: LEAD_LIMITS.nameMax,
    autoComplete: 'name',
  },
  phone: {
    label: 'Phone number',
    control: 'tel',
    required: true,
    maxLength: 24,
    autoComplete: 'tel',
    inputMode: 'tel',
    hint: 'A 10-digit Indian mobile number, with or without +91. We reply on WhatsApp or by phone.',
  },
  requirement: {
    label: 'What do you need made?',
    control: 'textarea',
    required: false,
    rows: 3,
    maxLength: LEAD_LIMITS.requirementMax,
    hint: 'The piece, the room it is for, the timber or finish — whatever you know so far.',
  },
  budget: {
    label: 'Approximate budget (optional)',
    control: 'text',
    required: false,
    maxLength: LEAD_LIMITS.budgetMax,
    hint: 'A range is fine. It helps us suggest something realistic rather than guessing.',
  },
  dimensions: {
    label: 'Dimensions (optional)',
    control: 'text',
    required: false,
    maxLength: LEAD_LIMITS.dimensionsMax,
    hint: 'Length × width × height, or the largest size that will fit.',
  },
  message: {
    label: 'Message',
    control: 'textarea',
    required: true,
    rows: 4,
    maxLength: LEAD_LIMITS.messageMax,
    hint: `At least ${String(LEAD_LIMITS.messageMin)} characters.`,
  },
  image: {
    label: 'A photograph or sketch (optional)',
    control: 'file',
    required: false,
    hint: 'One JPEG, PNG, WebP or AVIF image, up to 12 MB. Only we see it — it is never published.',
  },
};

type TextValues = Record<Exclude<FieldKey, 'image'>, string>;

const EMPTY_VALUES: TextValues = {
  name: '',
  phone: '',
  requirement: '',
  budget: '',
  dimensions: '',
  message: '',
};

type Phase =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent'; message: string }
  | { kind: 'failed'; failure: EnquiryFailure };

/** The alternatives block, shown after any failure. Both numbers, both channels. */
function Alternatives({ numbers }: { numbers: readonly FallbackNumber[] }): ReactElement | null {
  if (numbers.length === 0) return null;
  return (
    <div className="ngf-form-alt">
      <p className="ngf-form-alt-label">Both numbers reach the same people. Neither has a limit.</p>
      <ul className="ngf-form-alt-list">
        {numbers.map((number) => (
          <li key={number.display}>
            <a href={number.whatsappHref} target="_blank" rel="noopener">
              WhatsApp {number.display}
            </a>
            <a href={number.telHref}>Call {number.display}</a>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function EnquiryForm(props: EnquiryFormProps): ReactElement {
  const idPrefix = useId();
  const [values, setValues] = useState<TextValues>(EMPTY_VALUES);
  const [image, setImage] = useState<File | null>(null);
  const [honeypot, setHoneypot] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const summaryRef = useRef<HTMLParagraphElement | null>(null);

  /**
   * The moment this form became fillable.
   *
   * A ref, not state: it must survive every re-render unchanged, and it must not be a
   * dependency of anything. `useState`'s initialiser would also work, but a ref says "this
   * value is never rendered and never changes" out loud.
   */
  const renderedAt = useRef<number>(Date.now());

  /** Move focus to the failure summary so a keyboard or screen-reader user is told. */
  useEffect(() => {
    if (phase.kind === 'failed') summaryRef.current?.focus();
  }, [phase]);

  const asked = FIELD_ORDER.filter((key) => props.fields.includes(key));

  function setValue(key: Exclude<FieldKey, 'image'>, value: string): void {
    setValues((current) => ({ ...current, [key]: value }));
    // Clearing the error for the field being edited, and nothing else, keeps the other
    // messages visible — they are still true.
    setErrors((current) => {
      if (current[key] === undefined) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (phase.kind === 'sending') return;
    setPhase({ kind: 'sending' });
    setErrors({});

    const payload = {
      type: props.type,
      name: values.name,
      phone: values.phone,
      message: values.message,
      ...(props.productSlug === undefined ? {} : { productSlug: props.productSlug }),
      ...(asked.includes('requirement') && values.requirement !== ''
        ? { requirement: values.requirement }
        : {}),
      ...(asked.includes('budget') && values.budget !== '' ? { budget: values.budget } : {}),
      ...(asked.includes('dimensions') && values.dimensions !== ''
        ? { dimensions: values.dimensions }
        : {}),
      honeypot,
      renderedAt: renderedAt.current,
    };

    const result = await submitEnquiry(payload, asked.includes('image') ? image : null);
    if (result.ok) {
      // Counted only on a stored enquiry, so the event count and the lead count can be compared
      // and the difference between them means something (see `AnalyticsSummary`).
      currentBatcher()?.track('enquiry_submit', props.productSlug ?? '');
      setPhase({ kind: 'sent', message: result.message });
      props.onSuccess?.();
      return;
    }
    setErrors(result.fields);
    setPhase({ kind: 'failed', failure: result });
  }

  /* --- The confirmation. Replaces the form; nothing to correct. ------------- */
  if (phase.kind === 'sent') {
    return (
      <div className="ngf-form" data-ngf-enquiry-state="sent">
        <p className="ngf-form-sent" role="status">
          {phase.message}
        </p>
        {props.productName !== undefined && (
          <p className="ngf-form-sent-detail">
            We have your enquiry about the {props.productName}.
          </p>
        )}
        <Alternatives numbers={props.numbers} />
      </div>
    );
  }

  const failure = phase.kind === 'failed' ? phase.failure : null;
  const sending = phase.kind === 'sending';

  return (
    <form
      className="ngf-form"
      noValidate
      onSubmit={(event) => void onSubmit(event)}
      data-ngf-enquiry-form={props.type}
      aria-describedby={failure === null ? undefined : `${idPrefix}-summary`}
    >
      {props.heading !== undefined && <h2 className="ngf-form-heading">{props.heading}</h2>}
      {props.intro !== undefined && <p className="ngf-form-intro">{props.intro}</p>}
      {props.productName !== undefined && (
        <p className="ngf-form-product">
          About: <strong>{props.productName}</strong>
        </p>
      )}

      {/*
        The failure summary. `tabIndex={-1}` so it can be focused programmatically without
        entering the tab order, and `role="alert"` so it is announced whether or not focus
        actually lands (some browsers refuse to move focus during a submit).
      */}
      {failure !== null && (
        <p
          id={`${idPrefix}-summary`}
          className="ngf-form-error-summary"
          role="alert"
          tabIndex={-1}
          ref={summaryRef}
        >
          {failure.message}
        </p>
      )}

      {failure?.kind === 'product-unavailable' && (
        <p className="ngf-form-recovery">
          <a href={failure.catalogueHref ?? '/collection'}>Browse the Catalogue</a>
        </p>
      )}

      {asked.map((key) => {
        const spec = FIELDS[key];
        const id = `${idPrefix}-${key}`;
        const messages = errors[key] ?? [];
        const invalid = messages.length > 0;
        const hintId = spec.hint === undefined ? null : `${id}-hint`;
        const errorId = invalid ? `${id}-error` : null;
        const describedBy = [hintId, errorId].filter((value) => value !== null).join(' ');

        return (
          <div className="ngf-field" key={key}>
            <label className="ngf-field-label" htmlFor={id}>
              {spec.label}
              {spec.required && (
                <span className="ngf-field-required" aria-hidden="true">
                  {' '}
                  *
                </span>
              )}
            </label>
            {spec.hint !== undefined && (
              <p className="ngf-field-hint" id={hintId ?? undefined}>
                {spec.hint}
              </p>
            )}

            {spec.control === 'textarea' ? (
              <textarea
                id={id}
                name={key}
                rows={spec.rows ?? 3}
                maxLength={spec.maxLength}
                required={spec.required}
                value={values[key as Exclude<FieldKey, 'image'>]}
                aria-invalid={invalid || undefined}
                aria-describedby={describedBy === '' ? undefined : describedBy}
                disabled={sending}
                onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
                  setValue(key as Exclude<FieldKey, 'image'>, event.target.value);
                }}
              />
            ) : spec.control === 'file' ? (
              <input
                id={id}
                name="image"
                type="file"
                accept="image/jpeg,image/png,image/webp,image/avif"
                aria-invalid={invalid || undefined}
                aria-describedby={describedBy === '' ? undefined : describedBy}
                disabled={sending}
                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                  setImage(event.target.files?.[0] ?? null);
                  setErrors((current) => {
                    if (current.image === undefined) return current;
                    const next = { ...current };
                    delete next.image;
                    return next;
                  });
                }}
              />
            ) : (
              <input
                id={id}
                name={key}
                type={spec.control === 'tel' ? 'tel' : 'text'}
                inputMode={spec.inputMode}
                autoComplete={spec.autoComplete}
                maxLength={spec.maxLength}
                required={spec.required}
                value={values[key as Exclude<FieldKey, 'image'>]}
                aria-invalid={invalid || undefined}
                aria-describedby={describedBy === '' ? undefined : describedBy}
                disabled={sending}
                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                  setValue(key as Exclude<FieldKey, 'image'>, event.target.value);
                }}
              />
            )}

            {invalid && (
              <p className="ngf-field-error" id={errorId ?? undefined}>
                {messages.join(' ')}
              </p>
            )}
          </div>
        );
      })}

      {/*
        The honeypot. Off-canvas rather than `display: none`, and labelled, so the only things
        that fill it are the things that fill every input they find.
      */}
      <div className="ngf-honeypot" aria-hidden="true">
        <label htmlFor={`${idPrefix}-company`}>Company (leave this blank)</label>
        <input
          id={`${idPrefix}-company`}
          name="honeypot"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={honeypot}
          onChange={(event) => setHoneypot(event.target.value)}
        />
      </div>

      {/* Errors that belong to no rendered control still have to be readable somewhere. */}
      {errors.productSlug !== undefined && failure?.kind === 'validation' && (
        <p className="ngf-field-error">{errors.productSlug.join(' ')}</p>
      )}
      {errors._ !== undefined && <p className="ngf-field-error">{errors._.join(' ')}</p>}

      <div className="ngf-form-actions">
        {/*
          After a failure the same control is the retry the design's recovery column names — the
          values are all still in the form, so pressing it again re-sends exactly what was typed. It
          says so, because "Send enquiry" beside an error message reads as though the error has to be
          cleared first.
        */}
        <button type="submit" className="ngf-form-submit" disabled={sending}>
          {sending ? 'Sending…' : failure === null ? props.submitLabel : 'Try again'}
        </button>
        <p className="ngf-form-note">We use your number to reply to this enquiry. Nothing else.</p>
      </div>

      {/* After any failure: the direct alternative, always both numbers. */}
      {failure !== null && <Alternatives numbers={props.numbers} />}
    </form>
  );
}
