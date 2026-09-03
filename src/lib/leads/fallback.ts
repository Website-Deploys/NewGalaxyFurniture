/**
 * The WhatsApp and Call alternatives an enquiry form falls back to.
 *
 * Built on the server and passed to the island as plain strings, for two reasons:
 *
 * 1. **The hrefs exist before any JavaScript runs.** Requirements 6.9 and 6.19 want both
 *    numbers offered when a submission is refused or cannot be stored — which are exactly the
 *    moments when trusting the client to construct a URL is least appealing.
 * 2. **`buildWhatsAppUrl` stays out of the client bundle.** It is a pure function, but pulling
 *    it in would pull `buildEnquiryMessage` and the settings record with it, and the message
 *    template is not something a marketing page needs to ship.
 *
 * Both numbers, always, with the one shared label — `contactChannels` is the same merge the
 * header, footer and PDP read, so the order is identical everywhere (Requirements 5.9, 5.10).
 *
 * Requirements: 5.9, 5.10, 6.9, 6.19.
 */

import { buildEnquiryMessage, buildTelUrl, buildWhatsAppUrl } from '@/lib/whatsapp';
import { contactChannels } from '@/lib/site/contact';
import type { EnquiryContext } from '@/lib/whatsapp';
import type { SiteSettings } from '@/schemas/site';

export interface FallbackNumber {
  display: string;
  whatsappHref: string;
  telHref: string;
}

/**
 * Every published number, with both channels pre-built for the given enquiry context.
 *
 * A number published for only one of the two channels still appears: its unavailable channel
 * points at the other, because a row with one working control is more use than no row. That
 * cannot happen with the seeded settings — both numbers are in both arrays — and the
 * `contactChannels` merge makes it representable, so it is handled rather than assumed away.
 */
export function fallbackNumbers(
  settings: SiteSettings,
  context: EnquiryContext = { kind: 'general' },
): FallbackNumber[] {
  const message = buildEnquiryMessage(context, settings);
  return contactChannels(settings).map((channel) => ({
    display: channel.display,
    whatsappHref: buildWhatsAppUrl(channel.e164, message),
    telHref: buildTelUrl(channel.e164),
  }));
}
