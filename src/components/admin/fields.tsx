/**
 * The form primitives every admin editor is built from.
 *
 * They exist so accessibility is structural rather than remembered: each control gets a real
 * `<label>` bound by `htmlFor`, and when it has an error it gets `aria-invalid` plus an
 * `aria-describedby` pointing at the message. That is the pattern Requirement 24.9 and 26.9
 * ask for, and writing it once per field type is the only way it stays true across a
 * thirty-field form.
 *
 * The controls are uncontrolled-by-value/controlled-by-props React inputs with a plain
 * `onChange(value)` — no form library. The value shapes here are the schema's own
 * (`number | null` for a clearable price, `string[]` for a chip list), so the parent never
 * translates between "what the input said" and "what the record holds".
 *
 * Requirements: 24.8, 24.9, 26.9.
 */

import type { ReactElement, ReactNode } from 'react';

/* -------------------------------------------------------------------------- */
/* Shared shell                                                               */
/* -------------------------------------------------------------------------- */

export interface FieldShellProps {
  id: string;
  label: string;
  /** Field-level messages. Non-empty means the control is invalid. */
  errors?: string[];
  hint?: string;
  required?: boolean;
  children: (aria: { id: string; 'aria-invalid'?: true; 'aria-describedby'?: string }) => ReactNode;
}

const CONTROL_CLASS = [
  'w-full min-h-[44px] border border-taupe bg-white px-3 py-2 text-body text-obsidian',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-champagne',
  'aria-[invalid]:border-[color:var(--color-espresso)]',
].join(' ');

export function FieldShell({
  id,
  label,
  errors,
  hint,
  required,
  children,
}: FieldShellProps): ReactElement {
  const invalid = errors !== undefined && errors.length > 0;
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  const errorId = invalid ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter((value) => value !== undefined).join(' ');

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-small font-medium text-espresso">
        {label}
        {required === true && (
          <span aria-hidden="true" className="ml-1 text-walnut">
            *
          </span>
        )}
      </label>
      {hint !== undefined && (
        <p id={hintId} className="text-small text-walnut">
          {hint}
        </p>
      )}
      {children({
        id,
        ...(invalid ? { 'aria-invalid': true as const } : {}),
        ...(describedBy === '' ? {} : { 'aria-describedby': describedBy }),
      })}
      {invalid && (
        <ul id={errorId} className="text-small text-espresso">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Controls                                                                   */
/* -------------------------------------------------------------------------- */

export interface TextFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  errors?: string[];
  hint?: string;
  required?: boolean;
  maxLength?: number;
  placeholder?: string;
  disabled?: boolean;
}

export function TextField(props: TextFieldProps): ReactElement {
  return (
    <FieldShell
      id={props.id}
      label={props.label}
      {...(props.errors === undefined ? {} : { errors: props.errors })}
      {...(props.hint === undefined ? {} : { hint: props.hint })}
      {...(props.required === undefined ? {} : { required: props.required })}
    >
      {(aria) => (
        <input
          {...aria}
          type="text"
          className={CONTROL_CLASS}
          value={props.value}
          maxLength={props.maxLength}
          placeholder={props.placeholder}
          disabled={props.disabled === true}
          onChange={(event) => props.onChange(event.target.value)}
        />
      )}
    </FieldShell>
  );
}

export interface TextAreaFieldProps extends TextFieldProps {
  rows?: number;
}

export function TextAreaField(props: TextAreaFieldProps): ReactElement {
  return (
    <FieldShell
      id={props.id}
      label={props.label}
      {...(props.errors === undefined ? {} : { errors: props.errors })}
      {...(props.hint === undefined ? {} : { hint: props.hint })}
      {...(props.required === undefined ? {} : { required: props.required })}
    >
      {(aria) => (
        <textarea
          {...aria}
          className={CONTROL_CLASS}
          rows={props.rows ?? 5}
          value={props.value}
          maxLength={props.maxLength}
          placeholder={props.placeholder}
          disabled={props.disabled === true}
          onChange={(event) => props.onChange(event.target.value)}
        />
      )}
    </FieldShell>
  );
}

export interface NumberFieldProps {
  id: string;
  label: string;
  /** `null` is empty, which is how a price is cleared. */
  value: number | null;
  onChange: (value: number | null) => void;
  errors?: string[];
  hint?: string;
  disabled?: boolean;
  min?: number;
  /** Rendered next to the input, e.g. `₹`. */
  prefix?: string;
}

export function NumberField(props: NumberFieldProps): ReactElement {
  return (
    <FieldShell
      id={props.id}
      label={props.label}
      {...(props.errors === undefined ? {} : { errors: props.errors })}
      {...(props.hint === undefined ? {} : { hint: props.hint })}
    >
      {(aria) => (
        <div className="flex items-center gap-2">
          {props.prefix !== undefined && (
            <span aria-hidden="true" className="text-body text-walnut">
              {props.prefix}
            </span>
          )}
          <input
            {...aria}
            type="number"
            inputMode="numeric"
            className={CONTROL_CLASS}
            value={props.value === null ? '' : String(props.value)}
            min={props.min ?? 0}
            step={1}
            disabled={props.disabled === true}
            onChange={(event) => {
              const raw = event.target.value.trim();
              if (raw === '') {
                props.onChange(null);
                return;
              }
              const parsed = Number.parseInt(raw, 10);
              props.onChange(Number.isFinite(parsed) ? parsed : null);
            }}
          />
        </div>
      )}
    </FieldShell>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectFieldProps {
  id: string;
  label: string;
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  errors?: string[];
  hint?: string;
  required?: boolean;
  /** Shown as the first, unselected option. */
  placeholder?: string;
  disabled?: boolean;
}

export function SelectField(props: SelectFieldProps): ReactElement {
  return (
    <FieldShell
      id={props.id}
      label={props.label}
      {...(props.errors === undefined ? {} : { errors: props.errors })}
      {...(props.hint === undefined ? {} : { hint: props.hint })}
      {...(props.required === undefined ? {} : { required: props.required })}
    >
      {(aria) => (
        <select
          {...aria}
          className={CONTROL_CLASS}
          value={props.value}
          disabled={props.disabled === true}
          onChange={(event) => props.onChange(event.target.value)}
        >
          {props.placeholder !== undefined && <option value="">{props.placeholder}</option>}
          {props.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </FieldShell>
  );
}

export interface CheckboxFieldProps {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
  disabled?: boolean;
}

export function CheckboxField(props: CheckboxFieldProps): ReactElement {
  const hintId = props.hint === undefined ? undefined : `${props.id}-hint`;
  return (
    <div className="flex min-h-[44px] items-start gap-3 py-1">
      <input
        id={props.id}
        type="checkbox"
        className="mt-1 h-5 w-5 border-taupe focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-champagne"
        checked={props.checked}
        disabled={props.disabled === true}
        {...(hintId === undefined ? {} : { 'aria-describedby': hintId })}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <div>
        <label htmlFor={props.id} className="text-body text-obsidian">
          {props.label}
        </label>
        {props.hint !== undefined && (
          <p id={hintId} className="text-small text-walnut">
            {props.hint}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * A list of short strings — tags, colours, keywords.
 *
 * Entered as comma-separated text rather than as a tag widget: an operator typing
 * "Brown, Beige" into a text box is a well-understood interaction, and a bespoke chip editor
 * would need its own keyboard model to stay operable (Requirement 24.5). The values are
 * trimmed and de-duplicated on the way out, so the stored array is clean regardless of how
 * the text was typed.
 */
export interface ListFieldProps {
  id: string;
  label: string;
  values: readonly string[];
  onChange: (values: string[]) => void;
  errors?: string[];
  hint?: string;
  disabled?: boolean;
}

export function ListField(props: ListFieldProps): ReactElement {
  return (
    <FieldShell
      id={props.id}
      label={props.label}
      {...(props.errors === undefined ? {} : { errors: props.errors })}
      hint={props.hint ?? 'Separate entries with commas.'}
    >
      {(aria) => (
        <>
          <input
            {...aria}
            type="text"
            className={CONTROL_CLASS}
            defaultValue={props.values.join(', ')}
            disabled={props.disabled === true}
            onBlur={(event) => {
              const parsed = [
                ...new Set(
                  event.target.value
                    .split(',')
                    .map((part) => part.trim())
                    .filter((part) => part !== ''),
                ),
              ];
              props.onChange(parsed);
            }}
          />
          {props.values.length > 0 && (
            <ul className="mt-1 flex flex-wrap gap-1">
              {props.values.map((value) => (
                <li key={value} className="border border-taupe px-2 py-0.5 text-small text-walnut">
                  {value}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </FieldShell>
  );
}

/* -------------------------------------------------------------------------- */
/* Grouping                                                                   */
/* -------------------------------------------------------------------------- */

export interface FormSectionProps {
  id: string;
  title: string;
  description?: string;
  /** Rendered next to the heading — e.g. "2 fields need attention". */
  status?: ReactNode;
  children: ReactNode;
}

/**
 * One of the seven groups of Requirement 13.1, as a real `<section>` with a heading, so the
 * form is navigable by heading for a screen-reader user and skimmable for everyone else.
 */
export function FormSection({
  id,
  title,
  description,
  status,
  children,
}: FormSectionProps): ReactElement {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="border-t border-taupe pt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={`${id}-heading`} className="font-display text-h3 text-espresso">
          {title}
        </h2>
        {status}
      </div>
      {description !== undefined && (
        <p className="mt-1 max-w-[var(--measure-prose)] text-small text-walnut">{description}</p>
      )}
      <div className="mt-4 grid gap-4 md:grid-cols-2">{children}</div>
    </section>
  );
}

/** Full-width cell inside a `FormSection`'s two-column grid. */
export function Wide({ children }: { children: ReactNode }): ReactElement {
  return <div className="md:col-span-2">{children}</div>;
}
