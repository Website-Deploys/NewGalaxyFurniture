/**
 * Get a Quote (Requirement 6.1).
 *
 * Adds the two fields that make a first quote useful rather than a request for more
 * information: an approximate budget and the dimensions the piece has to fit. Both are optional
 * — a visitor who does not know either should still be able to ask — and both are bounded at
 * Requirement 6.3's limits by the shared field table.
 *
 * Requirements: 6.1, 6.3.
 */

import type { ReactElement } from 'react';

import EnquiryForm, { type FallbackNumber } from './EnquiryForm';

export interface QuoteFormProps {
  numbers: readonly FallbackNumber[];
  productSlug?: string;
  productName?: string;
  heading?: string;
  onSuccess?: () => void;
}

export default function QuoteForm(props: QuoteFormProps): ReactElement {
  return (
    <EnquiryForm
      type="QUOTE"
      fields={['name', 'phone', 'budget', 'dimensions', 'message']}
      submitLabel="Get a quote"
      intro="Tell us the size and roughly what you have in mind. We will come back with a price and an honest date."
      numbers={props.numbers}
      {...(props.productSlug === undefined ? {} : { productSlug: props.productSlug })}
      {...(props.productName === undefined ? {} : { productName: props.productName })}
      {...(props.heading === undefined ? {} : { heading: props.heading })}
      {...(props.onSuccess === undefined ? {} : { onSuccess: props.onSuccess })}
    />
  );
}
