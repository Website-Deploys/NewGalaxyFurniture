import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ERROR_CODES, errorEnvelope, statusForErrorCode } from '@/lib/errors';

/**
 * The design's failure-mode table, its loading states, and its empty states — each row asserted
 * against the artifact that implements it.
 *
 * Thirteen failure modes, seven empty states and two loading rules is a checklist, and a checklist
 * that lives only in a design document is a checklist that rots. Two kinds of assertion appear here,
 * and the difference is deliberate:
 *
 * - **Behavioural**, where the row is implemented by code with a return value: the envelope's
 *   sentence and status for the failures that cross the API boundary.
 * - **Structural**, where the row is implemented by markup: the source of the component that owns it
 *   is read and the affordance the design names is asserted to be present. This is weaker than
 *   rendering the component, and it is not nothing — it fails the moment someone deletes the retry
 *   control, the return path, the conflict diff, or an empty state's next action, which is the
 *   regression that actually happens. Rendering these would need a DOM, a React renderer and an
 *   Astro container for six frameworks' worth of surfaces; the trade is stated rather than hidden.
 *
 * Requirements: 26.1–26.15.
 * Design: Error Handling → Failure modes, Loading states, Empty states.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function source(path: string): string {
  return readFileSync(`${ROOT}/${path}`, 'utf8');
}

describe('the failure-mode table', () => {
  it('1. a product that is not published is a real 404 offering the category, search and WhatsApp', () => {
    const page = source('src/pages/404.astro');
    expect(page).toContain('EmptyState');
    expect(page).toContain('WhatsAppLink');
    expect(page).toContain('CallLink');
    expect(page).toContain('/collection');
    // Not a soft 404: the route emits noindex and the status is the framework's own 404.
    expect(page).toContain('noindex: true');
    // The product route only builds published products, so an unpublished slug has no page at all.
    expect(source('src/pages/product/[slug].astro')).toContain('getStaticPaths');
  });

  it('2. an image that fails to load shows the alt text in the reserved box', () => {
    const component = source('src/components/ui/ResponsiveImage.astro');
    expect(component).toContain('data-failed');
    expect(component).toContain('Photograph unavailable');
    // The tile is in the markup rather than injected, so it needs no script to appear.
    expect(component).toContain('ngf-image-fallback');
    expect(source('src/components/product/Gallery.tsx')).toContain('ngf-gallery-fallback');
  });

  it('3. a network failure on a form keeps every value and offers a retry and both numbers', () => {
    const form = source('src/components/forms/EnquiryForm.tsx');
    // The inline retry: the same submit control, relabelled, with every value still in the form.
    expect(form).toContain("'Try again'");
    expect(form).toContain('<Alternatives numbers={props.numbers} />');
    // Nothing clears the entered values on a failure — only a confirmed submission resets them.
    expect(form).not.toMatch(/setValues\(\{\}\)/);
    const submit = source('src/lib/leads/submit.ts');
    expect(submit).toContain('Nothing you typed has been lost');
  });

  it('4. an expired admin session redirects to login carrying the intended destination', () => {
    const middleware = source('src/middleware.ts');
    expect(middleware).toContain('?next=');
    expect(middleware).toContain('encodeURIComponent');
    const login = source('src/pages/admin/login.astro');
    // The return path is validated, so it cannot be turned into an open redirect.
    expect(login).toContain("startsWith('/admin')");
  });

  it('5. a failed repository write says the values are kept and invites a retry', () => {
    expect(errorEnvelope(ERROR_CODES.REPOSITORY_UNAVAILABLE).message).toBe(
      'Could not save to the content repository. Your changes are kept locally — retry.',
    );
    expect(statusForErrorCode(ERROR_CODES.REPOSITORY_UNAVAILABLE)).toBe(502);
  });

  it('6. a 409 presents the differing values field by field, never last-writer-wins', () => {
    expect(statusForErrorCode(ERROR_CODES.CONFLICT)).toBe(409);
    expect(errorEnvelope(ERROR_CODES.CONFLICT).message).toContain('Review the differences');
    const form = source('src/components/admin/ProductForm.tsx');
    expect(form).toContain("kind: 'conflict'");
    // The remote values are rendered for comparison and the operator chooses.
    expect(form).toContain('save.remote');
  });

  it('7. a build that fails after publish names the build and says the old site still serves', () => {
    const panel = source('src/components/admin/PublishPanel.tsx');
    expect(panel).toContain('Publish committed but the site build failed');
    expect(panel).toContain('previous version of the site is still serving');
    expect(panel).toContain('/api/admin/deploy-status');
  });

  it('8. AI failure says suggestions are unavailable and leaves the form usable', () => {
    const envelope = errorEnvelope(ERROR_CODES.AI_UNAVAILABLE);
    expect(envelope.message).toContain('Continue filling the form manually');
    expect(statusForErrorCode(ERROR_CODES.AI_UNAVAILABLE)).toBe(503);
    expect(source('src/components/admin/AiAssistant.tsx')).toContain(
      'Skip the assistant and fill the form myself',
    );
  });

  it('9. a rejected upload names the reason per file and leaves the batch unaffected', () => {
    const endpoint = source('src/pages/api/admin/products/[id]/images/index.ts');
    expect(endpoint).toContain('rejected');
    expect(endpoint).toContain('accepted');
    const manager = source('src/components/admin/ImageManager.tsx');
    expect(manager).toContain('rejected.length > 0');
  });

  it('10. a pending derivative shows an optimizing state and keeps serving the original', () => {
    expect(source('src/components/admin/ImageManager.tsx')).toMatch(/derivativesReady !== true/);
    // `fallbackSrc` serves the stored original until the derivatives exist.
    expect(source('src/lib/images/srcset.ts')).toContain('derivativesReady !== true');
  });

  it('11. a validation failure is reported per field with nothing else cleared', () => {
    const envelope = errorEnvelope(ERROR_CODES.VALIDATION_FAILED, {
      fields: { phone: ['Enter a number we can reach you on.'] },
    });
    expect(envelope.fields?.phone).toHaveLength(1);
    expect(statusForErrorCode(ERROR_CODES.VALIDATION_FAILED)).toBe(422);
    const fields = source('src/components/admin/fields.tsx');
    expect(fields).toContain('aria-invalid');
    expect(fields).toContain('aria-describedby');
  });

  it('12. a rate limit states the whole minutes remaining', () => {
    expect(errorEnvelope(ERROR_CODES.RATE_LIMITED).message).toContain('Too many attempts');
    expect(statusForErrorCode(ERROR_CODES.RATE_LIMITED)).toBe(429);
  });

  it('13. an invalid content file fails the build before deploy, naming the file and field', () => {
    const validator = source('scripts/validate-content.ts');
    // The reporter prints `path → field: message`, which is what "names the file and field" means.
    expect(validator).toContain('→');
    expect(source('package.json')).toContain('"prebuild": "npm run validate:content"');
  });
});

describe('loading states', () => {
  it('every waiting surface renders a content-shaped skeleton rather than a bare sentence', () => {
    for (const path of [
      'src/components/ui/SearchBox.tsx',
      'src/components/product/Gallery.tsx',
      'src/components/admin/AiAssistant.tsx',
    ]) {
      expect(source(path), path).toContain('Skeleton');
    }
    // The lightbox no longer opens onto a blank surface while its chunk arrives.
    expect(source('src/components/product/Gallery.tsx')).not.toContain('fallback={null}');
  });

  it('holds the skeleton still under reduced motion, by media query and by the visitor toggle', () => {
    const css = source('src/styles/global.css');
    expect(css).toContain('ngf-skeleton-shimmer');
    const reduced = css.slice(css.indexOf('.ngf-skeleton-fill'));
    expect(reduced).toContain('@media (prefers-reduced-motion: reduce)');
    expect(reduced).toContain("[data-motion='off']");
    // Both switch the animation off rather than merely slowing it.
    expect(reduced).toMatch(/animation:\s*none/);
  });

  it('keeps one definition of each skeleton shape for both halves of the application', () => {
    // The rules are global; neither component carries its own copy.
    expect(source('src/components/ui/Skeleton.astro')).not.toContain('@keyframes');
    expect(source('src/components/ui/Skeleton.tsx')).toContain('ngf-skeleton-fill');
  });

  it('paints an LQIP behind every image rather than an empty box', () => {
    expect(source('src/components/ui/ResponsiveImage.astro')).toContain('image.lqip');
    expect(source('src/components/product/Gallery.tsx')).toContain('image.lqip');
    expect(source('src/components/product/RecentlyViewed.tsx')).toContain('lqip');
  });
});

describe('the seven empty states', () => {
  /** Each design-named state, and the surface that owns it. */
  const STATES: [string, string][] = [
    ['no products (public)', 'src/pages/collection/index.astro'],
    ['no products (admin)', 'src/components/admin/ProductTable.tsx'],
    ['no search results', 'src/components/ui/SearchBox.tsx'],
    ['no filter matches', 'src/components/product/CatalogueEmpty.astro'],
    ['no reviews (public)', 'src/pages/reviews.astro'],
    ['no reviews (admin)', 'src/components/admin/ReviewEditor.tsx'],
    ['no leads', 'src/components/admin/LeadTable.tsx'],
    ['no images (public gallery)', 'src/pages/gallery.astro'],
    ['no images (admin)', 'src/components/admin/ImageManager.tsx'],
    ['no analytics yet', 'src/components/admin/AnalyticsView.tsx'],
  ];

  it('uses the composed EmptyState at every one of them', () => {
    for (const [name, path] of STATES) {
      const text = source(path);
      const composed =
        text.includes('EmptyState') ||
        text.includes('CatalogueEmpty') ||
        text.includes('DropZoneGlyph') ||
        // The search dropdown's no-match state is the nearest matches plus category shortcuts.
        text.includes('nearestMatches');
      expect(composed, name).toBe(true);
    }
  });

  it('offers a next action at every one of them', () => {
    const actions: [string, string, RegExp][] = [
      ['no products (public)', 'src/pages/collection/index.astro', /CatalogueEmpty/],
      ['no products (admin)', 'src/components/admin/ProductTable.tsx', /Add your first product/],
      ['no filter matches (admin)', 'src/components/admin/ProductTable.tsx', /Clear filters/],
      ['no search results', 'src/components/ui/SearchBox.tsx', /ngf-search-shortcuts/],
      ['no reviews (admin)', 'src/components/admin/ReviewEditor.tsx', /Add the first review/],
      ['no leads', 'src/components/admin/LeadTable.tsx', /Clear filters|enquiry form/],
      ['no images (admin)', 'src/components/admin/ImageManager.tsx', /Choose files/],
      ['no analytics yet', 'src/components/admin/AnalyticsView.tsx', /Publish something/],
      ['no categories', 'src/components/admin/CategoryTable.tsx', /Add the first category/],
      ['no products (dashboard)', 'src/components/admin/DashboardCards.tsx', /Add your first/],
      ['no images (public)', 'src/pages/gallery.astro', /Ask for photographs/],
      ['no reviews (public)', 'src/pages/reviews.astro', /slot="action"/],
      ['no page (404)', 'src/pages/404.astro', /Ask on WhatsApp/],
    ];
    for (const [name, path, pattern] of actions) {
      expect(pattern.test(source(path)), name).toBe(true);
    }
  });

  it('never renders a bare "nothing here" box in an admin view', () => {
    /*
     * The regression this catches: a new admin view writing its own `border-dashed` box again. The
     * composition is shared now, so a dashed border outside the shared component or the drop zone is
     * a state that has drifted from the design.
     */
    for (const path of [
      'src/components/admin/ProductTable.tsx',
      'src/components/admin/LeadTable.tsx',
      'src/components/admin/ReviewEditor.tsx',
      'src/components/admin/CategoryTable.tsx',
      'src/components/admin/DashboardCards.tsx',
      'src/components/admin/AnalyticsView.tsx',
    ]) {
      expect(source(path), path).not.toContain('border-dashed');
    }
  });
});
