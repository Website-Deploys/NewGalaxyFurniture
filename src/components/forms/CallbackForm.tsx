/**
 * Request a Callback (Requirement 6.1).
 *
 * The shortest of the five, and intentionally so: someone asking to be phoned has already
 * decided they would rather talk than type. The message field remains required because
 * Requirement 6.3 requires it on every form — and because "call me" with no subject makes the
 * operator's return call a cold one.
 *
 * Requirements: 6.1, 6.3.
 */

import type { ReactElement } from 'react';

import EnquiryForm, { type FallbackNumber } from './EnquiryForm';

export interface CallbackFormProps {
  numbers: readonly FallbackNumber[];
  /** The product this callback is about, when it is requested from a product page. */
  productSlug?: string;
  productName?: string;
  heading?: string;
  onSuccess?: () => void;
}

export default function CallbackForm(props: CallbackFormProps): ReactElement {
  return (
    <EnquiryForm
      type="CALLBACK"
      fields={['name', 'phone', 'message']}
      submitLabel="Request a callback"
      intro="Leave your number and a line about what you need. We will call you back."
      numbers={props.numbers}
      {...(props.productSlug === undefined ? {} : { productSlug: props.productSlug })}
      {...(props.productName === undefined ? {} : { productName: props.productName })}
      {...(props.heading === undefined ? {} : { heading: props.heading })}
      {...(props.onSuccess === undefined ? {} : { onSuccess: props.onSuccess })}
    />
  );
}
