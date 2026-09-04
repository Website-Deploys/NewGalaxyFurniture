/**
 * The general Contact form (Requirement 6.1).
 *
 * Name, phone, message — the three fields Requirement 6.3 requires of every form and nothing
 * else. A contact form that asks for a subject, a company and a preferred contact method is a
 * contact form that gets abandoned; the message field can carry all three when the visitor
 * wants it to.
 *
 * Requirements: 6.1, 6.3.
 */

import type { ReactElement } from 'react';

import EnquiryForm, { type FallbackNumber } from './EnquiryForm';

export interface ContactFormProps {
  numbers: readonly FallbackNumber[];
  heading?: string;
  /** Present when the form is placed on a product page; resolved on the server. */
  productSlug?: string;
  productName?: string;
}

export default function ContactForm(props: ContactFormProps): ReactElement {
  return (
    <EnquiryForm
      type="CONTACT"
      fields={['name', 'phone', 'message']}
      submitLabel="Send enquiry"
      intro="Tell us what you are looking for. We reply on WhatsApp or by phone, usually the same day."
      numbers={props.numbers}
      {...(props.heading === undefined ? {} : { heading: props.heading })}
      {...(props.productSlug === undefined ? {} : { productSlug: props.productSlug })}
      {...(props.productName === undefined ? {} : { productName: props.productName })}
    />
  );
}
