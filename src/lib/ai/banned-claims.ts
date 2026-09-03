/**
 * The banned-claim pattern list and the scrubber that enforces it.
 *
 * This is the automated half of the content rule. The prompt asks the model not to invent
 * credentials; this module makes it not matter whether it complied. Prompt instructions are a
 * request, and a request is not a guarantee — so the guarantee is a deterministic filter the
 * model has no way to talk past (Requirement 16.8).
 *
 * **What is banned and why.** Each family below is a claim a furniture business could be sued,
 * fined or simply disbelieved over, and none of them is derivable from a photograph or a few
 * notes about a sofa:
 *
 * | Family | Why a machine must not assert it |
 * |---|---|
 * | Years in business, "since 1998", "established …" | A verifiable date the operator never supplied |
 * | ISO / certification / "certified" | A regulated claim; asserting one falsely is actionable |
 * | Awards, "award-winning" | A verifiable fact about a third party |
 * | Customer counts, "10,000+ happy customers" | A number with no source |
 * | Employee and showroom counts | Same |
 * | Delivery-time guarantees, "delivered in 7 days" | A contractual promise the operator did not make |
 * | Warranty terms, "10-year warranty" | A contractual promise, and a legal obligation |
 * | Market-position superlatives, "best in Bangalore", "No. 1" | Comparative advertising with no basis |
 * | Prices not in the admin facts | An invented price the customer may hold them to |
 *
 * **How the scrubbing works, and its deliberate bluntness.** A match takes the *whole sentence*
 * containing it, not just the matched span. Removing "ISO 9001 certified" from "Our workshop is
 * ISO 9001 certified and uses seasoned teak" would leave "Our workshop is and uses seasoned
 * teak" — grammatical wreckage that reads as a bug, and worse, a sentence whose surviving half
 * may still imply the claim. Dropping the sentence is honest and legible: the operator sees a
 * warning naming what was removed and can write the truth themselves.
 *
 * **Why the pattern list is imperfect and that is acknowledged.** No regular expression set
 * catches every phrasing of "we are the best". The list catches the phrasings a language model
 * actually produces, and every removal is reported so the operator reviews what remains. The
 * guard is a floor under the review, not a replacement for it — and the field-level rules in
 * `fact-guard.ts` are what make the *factual* fields safe regardless of prose.
 *
 * Design: AI Product Assistant → Hallucination guardrails.
 * Requirements: 7.10, 8.4, 16.8, 18.9, 19.6, 20.9, 23.10, 23.18.
 */

/** One family of forbidden claim. `label` is what the operator is told was removed. */
export interface BannedClaimPattern {
  id: string;
  label: string;
  pattern: RegExp;
}

/**
 * The maintained list.
 *
 * Every pattern is written without the `g` flag and matched with `RegExp.test`/`match` on a
 * per-sentence basis, so there is no `lastIndex` to leak between calls — a stateful regex shared
 * across invocations is a classic source of "it worked the first time" bugs in a filter like
 * this.
 */
export const BANNED_CLAIM_PATTERNS: readonly BannedClaimPattern[] = [
  {
    id: 'years-in-business',
    label: 'a claim about how long the business has operated',
    pattern:
      /\b(?:since\s+(?:19|20)\d{2}|established\s+(?:in\s+)?(?:19|20)\d{2}|est\.\s*(?:19|20)\d{2}|(?:over|more\s+than|nearly|almost)?\s*\d{1,3}\+?\s*(?:\+\s*)?years?\s+(?:of\s+)?(?:experience|in\s+business|in\s+the\s+(?:business|trade|industry)|serving|of\s+craftsmanship)|(?:a\s+)?(?:decade|century)(?:s)?\s+of\b|(?:two|three|four|five)\s+decades)/i,
  },
  {
    id: 'certification',
    label: 'a certification or standards claim',
    pattern:
      /\b(?:ISO[\s-]*\d{3,5}(?::\d{4})?|ISO[\s-]*certified|certified\s+(?:by|manufacturer|workshop|supplier|business|craftsm(?:an|en))|(?:BIS|FSC|CE|GREENGUARD|OEKO[\s-]*TEX)[\s-]*(?:certified|approved|mark)?|accredited|government[\s-]*approved|(?:quality|safety)\s+certifi(?:ed|cation))/i,
  },
  {
    id: 'awards',
    label: 'an award claim',
    pattern:
      /\b(?:award[\s-]*winning|winner\s+of|(?:won|received|awarded)\s+(?:the\s+|an?\s+)?(?:award|prize|recognition)|prize[\s-]*winning|recognised\s+(?:as|by)\s+(?:the\s+)?best|rated\s+(?:the\s+)?(?:number|no\.?)\s*1)/i,
  },
  {
    id: 'customer-count',
    label: 'a customer-count claim',
    pattern:
      /\b(?:\d[\d,]*\s*(?:\+|plus|k|lakh|million)?\s*(?:happy\s+|satisfied\s+|delighted\s+)?(?:customers?|clients?|families|homes?\s+furnished|orders\s+(?:delivered|completed))|(?:thousands|hundreds|lakhs|millions)\s+of\s+(?:happy\s+|satisfied\s+)?(?:customers?|clients?|families|homes))/i,
  },
  {
    id: 'staff-and-showroom-count',
    label: 'an employee, workshop or showroom count',
    pattern:
      /\b(?:\d[\d,]*\s*(?:\+|plus)?\s*(?:employees?|staff|craftsmen|artisans?|carpenters?|workers?|showrooms?|outlets?|stores?|branch(?:es)?|factor(?:y|ies)|workshops?)|(?:team|workforce)\s+of\s+(?:\d[\d,]*|over\s+\d[\d,]*)|(?:our\s+)?\d[\d,]*[\s,-]*(?:sq\.?\s*ft|square\s+(?:feet|foot))\s+(?:showroom|factory|workshop|facility))/i,
  },
  {
    id: 'delivery-guarantee',
    label: 'a delivery-time guarantee',
    pattern:
      /\b(?:(?:deliver(?:ed|y)?|dispatch(?:ed)?|ship(?:ped|ping)?|install(?:ed|ation)?)\s+(?:with)?in\s+(?:just\s+)?\d{1,3}\s*(?:-\s*\d{1,3}\s*)?(?:hours?|hrs?|days?|weeks?|months?)|(?:same|next)[\s-]*day\s+(?:delivery|dispatch|shipping)|guaranteed\s+(?:delivery|dispatch|installation)|(?:free|fast|express|quick|prompt|timely)\s+(?:and\s+\w+\s+)?delivery\s+(?:guarantee|assured|promised)|delivery\s+(?:guarantee|assured|promise)|\d{1,3}\s*(?:-\s*\d{1,3}\s*)?(?:day|week)\s+delivery)/i,
  },
  {
    id: 'warranty',
    label: 'a warranty or guarantee term',
    pattern:
      /\b(?:\d{1,3}[\s-]*(?:year|yr|month|day)s?[\s-]*(?:manufacturer'?s?\s+)?(?:warranty|guarantee|assurance)|(?:warranty|guarantee)\s+(?:of|for)\s+\d{1,3}\s*(?:year|yr|month)s?|(?:lifetime|unlimited|full|comprehensive|extended)\s+(?:warranty|guarantee)|(?:money[\s-]*back|satisfaction)\s+guarantee|guaranteed\s+for\s+(?:life|\d+))/i,
  },
  {
    id: 'market-position',
    label: 'a market-position or superlative claim',
    pattern:
      /\b(?:(?:the\s+)?(?:best|finest|top|leading|foremost|premier|largest|biggest|most\s+trusted|most\s+popular|fastest[\s-]*growing|number\s*(?:one|1)|no\.?\s*1|#\s*1)\s+(?:\w+\s+){0,3}?(?:in|of|across)\s+(?:the\s+)?(?:bangalore|bengaluru|karnataka|india|city|region|country|market|state|south\s+india)|market\s+leader|industry\s+leader|(?:unbeatable|unmatched|lowest)\s+(?:price|prices|quality)|voted\s+(?:the\s+)?best|(?:india|bangalore|bengaluru|karnataka)'?s\s+(?:best|finest|leading|largest|number\s*(?:one|1)|no\.?\s*1|most\s+trusted))/i,
  },
];

/**
 * A money amount in Indian prose: `₹42,000`, `Rs. 42000`, `INR 42,000`, `42,000 rupees`,
 * `42k`, `1.5 lakh`.
 *
 * Global, because every amount in a sentence has to be checked against the admin facts, not
 * just the first. It is re-created per call by `priceMentions` for the `lastIndex` reason above.
 */
function priceRegex(): RegExp {
  return /(?:(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d+)?)\s*(k|lakhs?|lacs?|crores?)?|\b([\d,]+(?:\.\d+)?)\s*(k|lakhs?|lacs?|crores?)?\s*(?:rupees|₹|rs\b|inr\b))/gi;
}

/** `42,000` → 42000; `1.5 lakh` → 150000; `42k` → 42000. */
function toAmount(digits: string, unit: string | undefined): number | null {
  const base = Number.parseFloat(digits.replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;
  const scale = (unit ?? '').toLowerCase();
  if (scale.startsWith('k')) return Math.round(base * 1_000);
  if (scale.startsWith('lakh') || scale.startsWith('lac')) return Math.round(base * 100_000);
  if (scale.startsWith('crore')) return Math.round(base * 10_000_000);
  return Math.round(base);
}

/** Every money amount a piece of text asserts, in rupees. */
export function priceMentions(text: string): number[] {
  const amounts: number[] = [];
  for (const match of text.matchAll(priceRegex())) {
    const amount = toAmount(match[1] ?? match[3] ?? '', match[2] ?? match[4]);
    if (amount !== null && amount > 0) amounts.push(amount);
  }
  return amounts;
}

/**
 * Fold typographic punctuation to ASCII **for matching only**.
 *
 * This is not cosmetic — it closes a bypass the property suite found. The market-position pattern
 * matches `india's finest`, and a language model writes `India’s finest` with U+2019, so the
 * unfolded text sailed past the filter and the claim would have reached the operator's catalogue.
 * The same held for every pattern containing an apostrophe, and would hold for en dashes in
 * `10–year warranty` and non-breaking spaces anywhere.
 *
 * The fold is applied to a *copy* used for testing; the text that survives is the original, so
 * the operator's copy keeps its proper punctuation. Fold and original are the same length for
 * every substitution here (each is one character for one character), which is what makes it safe
 * to decide about a sentence by examining its folded form.
 */
export function foldForMatching(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201b\u2032\u00b4`]/g, "'")
    .replace(/[\u201c\u201d\u201f\u2033]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ');
}

/**
 * Split into sentences, keeping the terminators.
 *
 * Newlines terminate too: generated copy uses them as paragraph breaks without punctuation, and
 * without this a whole multi-line description would count as one sentence and be removed
 * wholesale for a single bad clause.
 */
function sentences(text: string): string[] {
  const parts = text.match(/[^.!?\n]+(?:[.!?]+|\n+|$)/g);
  return parts === null ? [text] : parts;
}

export interface ScrubResult {
  text: string;
  /** One sentence per removal, naming what was removed and quoting what it said. */
  removals: string[];
}

/**
 * Remove every sentence carrying a banned claim, and report each removal.
 *
 * `allowedPrices` is the set of amounts the admin actually supplied. Any other amount in the
 * text is a price the machine invented, which is the last row of the banned list — and the one
 * with the most direct consequence, since a customer may reasonably hold the business to a
 * price they read on its own website.
 */
export function scrubBannedClaims(
  text: string,
  allowedPrices: readonly number[] = [],
): ScrubResult {
  if (text === '') return { text: '', removals: [] };

  const allowed = new Set(allowedPrices.filter((price) => Number.isFinite(price) && price > 0));
  const kept: string[] = [];
  const removals: string[] = [];

  for (const sentence of sentences(text)) {
    const trimmed = sentence.trim();
    if (trimmed === '') {
      kept.push(sentence);
      continue;
    }

    const folded = foldForMatching(trimmed);
    const matched = BANNED_CLAIM_PATTERNS.find((claim) => claim.pattern.test(folded));
    if (matched !== undefined) {
      removals.push(`Removed ${matched.label}: “${trimmed}”`);
      continue;
    }

    const invented = priceMentions(folded).filter((amount) => !allowed.has(amount));
    if (invented.length > 0) {
      removals.push(
        `Removed a price you did not supply (₹${invented
          .map((amount) => amount.toLocaleString('en-IN'))
          .join(', ₹')}): “${trimmed}”`,
      );
      continue;
    }

    kept.push(sentence);
  }

  // Collapse the whitespace the removals left behind, so the result does not advertise where
  // the surgery happened with a double space or a stranded blank line.
  const text_ = kept
    .join('')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: text_, removals };
}

/** True when any banned pattern matches. Folds punctuation first, as the scrubber does. */
export function containsBannedClaim(text: string): boolean {
  const folded = foldForMatching(text);
  return BANNED_CLAIM_PATTERNS.some((claim) => claim.pattern.test(folded));
}
