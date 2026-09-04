/**
 * The published business numbers, as one list, with one label.
 *
 * Requirements 5.9 and 5.10 are unusually prescriptive, and for a good reason: NGF has two
 * numbers that are genuinely interchangeable, and any copy that implies otherwise ("Sales",
 * "Support", "Number 2") sends a customer to the wrong expectation and makes the operator
 * look bigger and more departmentalised than the business is. So:
 *
 * - Every surface renders **the same label text** for both numbers. That text is
 *   `NUMBER_LABEL` and it lives here, once. The stored `label` field in settings
 *   (`Orders & Enquiries 1` / `… 2`) is an operator-facing key for the admin form; it is
 *   deliberately **not** the visible label, because its trailing index is exactly the kind
 *   of distinction 5.10 prohibits from reaching a visitor.
 * - The two rows are told apart by the number itself, not by their labels.
 *
 * `contactChannels` merges the `whatsapp` and `phone` arrays by E.164 value rather than by
 * index, so settings that list a number in only one of the two arrays still renders
 * correctly, and a third number added to either array appears with no code change
 * (Requirement 19.2).
 *
 * Requirements: 5.9, 5.10, 5.13, 19.2, 19.3.
 */

import { formatDisplayPhone } from '@/lib/phone';
import type { ContactNumberValue, SiteSettings } from '@/schemas/site';

/** The one visible label both numbers carry, everywhere. */
export const NUMBER_LABEL = 'Orders & enquiries';

/**
 * The same label spelled out, for accessible names.
 *
 * `&` is read differently by different screen readers — some say "and", some say "ampersand",
 * some say nothing — so an `aria-label` built by lowercasing the visible label would not reliably
 * state what Requirement 5.9 says it must state. The spoken form is written out instead. Both
 * forms carry the identical meaning for both numbers, which is the requirement's actual concern.
 */
export const NUMBER_LABEL_SPOKEN = 'orders and enquiries';

/** The shared caption that states the numbers are equivalent. */
export const NUMBERS_CAPTION = 'Both numbers are for orders and enquiries.';

export interface ContactChannel {
  /** Canonical E.164, for `wa.me` and `tel:`. */
  e164: string;
  /** `+91 95134 43606` — for reading aloud and for display. */
  display: string;
  /** The stored settings entry, so callers can pass it to the link components. */
  entry: ContactNumberValue;
  /** Whether this number is published as a WhatsApp destination. */
  whatsapp: boolean;
  /** Whether this number is published as a dialable destination. */
  phone: boolean;
}

/**
 * Every published number, WhatsApp order first, each with the channels it supports.
 *
 * Order is stable and derived from the settings file, so the header, the footer, the PDP,
 * and the contact page all list the numbers in the same sequence.
 */
export function contactChannels(settings: SiteSettings): ContactChannel[] {
  const byNumber = new Map<string, ContactChannel>();

  const upsert = (entry: ContactNumberValue, channel: 'whatsapp' | 'phone'): void => {
    const existing = byNumber.get(entry.e164);
    if (existing !== undefined) {
      existing[channel] = true;
      return;
    }
    byNumber.set(entry.e164, {
      e164: entry.e164,
      display: formatDisplayPhone(entry.e164),
      entry,
      whatsapp: channel === 'whatsapp',
      phone: channel === 'phone',
    });
  };

  for (const entry of settings.whatsapp) upsert(entry, 'whatsapp');
  for (const entry of settings.phone) upsert(entry, 'phone');

  return [...byNumber.values()];
}

/** An accessible name that disambiguates by number, never by role. */
export function channelAriaLabel(channel: ContactChannel, kind: 'whatsapp' | 'call'): string {
  const verb = kind === 'whatsapp' ? 'Message' : 'Call';
  return `${verb} ${channel.display} — ${NUMBER_LABEL_SPOKEN}`;
}
