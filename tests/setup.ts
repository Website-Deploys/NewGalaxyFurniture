/**
 * Shared Vitest setup for both the `unit` and `property` projects.
 *
 * Determinism first: the money, date, and message formatters are all
 * locale- and timezone-sensitive, so the suite pins both rather than inheriting
 * whatever the CI runner happens to have.
 */

process.env.TZ ??= 'Asia/Kolkata';
process.env.LANG ??= 'en_IN.UTF-8';

// `formatINR` depends on full ICU for Indian digit grouping (₹1,00,000). If the
// runtime was built with a trimmed ICU, that failure is confusing and remote from
// the assertion, so surface it here instead.
const grouped = new Intl.NumberFormat('en-IN').format(100000);
if (grouped !== '1,00,000') {
  throw new Error(
    `This Node build cannot format en-IN numbers (got "${grouped}", expected "1,00,000"). ` +
      'Full-ICU Node is required — see engines in package.json.',
  );
}
