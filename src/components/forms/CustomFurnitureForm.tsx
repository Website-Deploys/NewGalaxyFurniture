/**
 * The Custom Furniture Enquiry form.
 *
 * Requirement 6.2 names its fields exactly: name, phone, requirement, approximate budget,
 * dimensions, message, and one optional image. All seven, in that order, and no others — this
 * is the only form of the five that accepts an attachment, because it is the only one where a
 * photograph or a sketch is the fastest way to say what is wanted.
 *
 * The image is validated with the same checks as an admin upload, stored under a quarantined
 * prefix, and never rendered on a public surface (Requirement 6.11). The field's own hint says
 * so, because a visitor sending a photograph of their living room deserves to be told where it
 * goes.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.11, 6.18, 8.7.
 */

import type { ReactElement } from 'react';

import EnquiryForm, { type FallbackNumber } from './EnquiryForm';

export interface CustomFurnitureFormProps {
  numbers: readonly FallbackNumber[];
  heading?: string;
  /**
   * A custom enquiry started from a product page — "something like this, but 7 ft". Resolved on
   * the server like any other reference, so the operator sees which piece prompted it.
   */
  productSlug?: string;
  productName?: string;
}

export default function CustomFurnitureForm(props: CustomFurnitureFormProps): ReactElement {
  return (
    <EnquiryForm
      type="CUSTOM"
      // Requirement 6.2's seven fields, in the order the requirement lists them.
      fields={['name', 'phone', 'requirement', 'budget', 'dimensions', 'message', 'image']}
      submitLabel="Send custom enquiry"
      intro="Send us the size, the timber, the finish, or a photograph of what you have in mind. We will tell you what is possible and what it costs."
      numbers={props.numbers}
      {...(props.heading === undefined ? {} : { heading: props.heading })}
      {...(props.productSlug === undefined ? {} : { productSlug: props.productSlug })}
      {...(props.productName === undefined ? {} : { productName: props.productName })}
    />
  );
}
