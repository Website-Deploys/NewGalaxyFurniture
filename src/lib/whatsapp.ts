/**
 * WhatsApp and telephone URL construction.
 *
 * No per-product message string is ever stored. A message is generated at render
 * time from one template plus the current context, so a renamed product cannot
 * leave a stale message behind (requirement 5.1).
 *
 * The encoding rule is the one thing in this file that has to be exactly right:
 * the message is encoded **once**, with `encodeURIComponent`, so `&`, `#`, `+`,
 * `?`, `%`, `=`, newlines, `₹`, and emoji all survive and a single decode returns
 * the original text character for character. Double encoding is the classic bug
 * here — `?text=100%2525` instead of `?text=100%25` — and Properties 8 and 11 exist
 * to keep it from coming back.
 *
 * Design: Conversion → Message and URL construction.
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.13.
 */

import type { SiteSettings } from '@/schemas/site';

export interface EnquiryContext {
  kind: 'product' | 'general' | 'custom' | 'category';
  productName?: string;
  sku?: string;
  productUrl?: string;
  categoryName?: string;
}

/** Requirement 5.8: the whole message stays at or under this length. */
export const MESSAGE_MAX_LENGTH = 900;

/**
 * Pure. Produces the plain-text message body.
 *
 * The product variant is exactly the specified copy:
 *
 *   Hi New Galaxy Furniture, I'm interested in the Luxury L-Shape Sofa (SKU: NGF-SOF-4F2K9C).
 *   I would like to enquire about the price, availability and order details.
 *
 * No amount ever appears: the message asks about price, so a price-on-enquiry
 * product needs no special case (requirement 5.3). A category message carries the
 * category name only; a general or custom message carries neither name nor SKU
 * (requirement 5.4).
 */
export function buildEnquiryMessage(ctx: EnquiryContext, site: SiteSettings): string {
  const business = site.businessName;

  switch (ctx.kind) {
    case 'product': {
      // The identity line is never shortened: the operator must always be able to
      // tell which item a conversation is about (requirements 5.2, 5.8).
      const name = ctx.productName ?? '';
      const sku = ctx.sku ?? '';
      const identity =
        sku.length > 0
          ? `Hi ${business}, I'm interested in the ${name} (SKU: ${sku}).`
          : `Hi ${business}, I'm interested in the ${name}.`;
      const descriptive = [
        'I would like to enquire about the price, availability and order details.',
      ];
      if (ctx.productUrl !== undefined && ctx.productUrl.length > 0) {
        descriptive.push(ctx.productUrl);
      }
      return assemble(identity, descriptive);
    }

    case 'category': {
      const category = ctx.categoryName ?? '';
      const identity = `Hi ${business}, I'm interested in your ${category}.`;
      return assemble(identity, [
        'I would like to enquire about the range, prices and availability.',
      ]);
    }

    case 'custom': {
      const identity = `Hi ${business}, I would like to enquire about custom furniture.`;
      return assemble(identity, [
        'I would like to discuss sizes, materials, finishes and a quote.',
      ]);
    }

    case 'general':
    default: {
      const identity = `Hi ${business}, I would like to enquire about your furniture.`;
      return assemble(identity, ['Please let me know about availability and prices.']);
    }
  }
}

/**
 * Join the retained identity line with as much of the descriptive tail as fits.
 * Lines are dropped whole from the end first; only if a single descriptive line is
 * itself too long is it cut, and the identity line is never touched.
 */
function assemble(identity: string, descriptive: readonly string[]): string {
  let message = identity;
  for (const line of descriptive) {
    const candidate = `${message}\n${line}`;
    if (candidate.length <= MESSAGE_MAX_LENGTH) {
      message = candidate;
      continue;
    }
    const room = MESSAGE_MAX_LENGTH - message.length - 1;
    if (room > 0) message = `${message}\n${line.slice(0, room)}`;
    break;
  }
  return message;
}

/** Digits only: `wa.me` rejects `+`, spaces, and punctuation (requirement 5.6). */
export function toDigits(value: string): string {
  return value.replace(/\D+/g, '');
}

/**
 * Pure. Produces a `wa.me` URL with exactly one layer of encoding.
 *
 * `wa.me` is used rather than an `api.whatsapp.com` variant or user-agent sniffing
 * because it resolves per platform on its own: mobile hands off to the installed
 * app, desktop opens WhatsApp Web or the desktop app.
 */
export function buildWhatsAppUrl(e164: string, message: string): string {
  const digits = toDigits(e164);
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

/** Pure. `tel:` URL from an E.164 number: a leading `+`, then digits only (5.13). */
export function buildTelUrl(e164: string): string {
  return `tel:+${toDigits(e164)}`;
}

/** Convenience for the surfaces that render both controls for one context. */
export function buildEnquiryLinks(
  ctx: EnquiryContext,
  site: SiteSettings,
): { label: string; whatsapp: string; tel: string }[] {
  const message = buildEnquiryMessage(ctx, site);
  return site.whatsapp.map((entry, index) => ({
    label: entry.label,
    whatsapp: buildWhatsAppUrl(entry.e164, message),
    tel: buildTelUrl(site.phone[index]?.e164 ?? entry.e164),
  }));
}
