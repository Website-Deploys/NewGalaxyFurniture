# Implementation Plan: New Galaxy Furniture Website

## Overview

Greenfield build of the NGF catalogue site: Astro 5 + React 19 islands on Cloudflare Workers, JSON content under `/data` as source of truth, admin writes through a Worker → GitHub commit pipeline, published content baked at build time. Language for all implementation is **TypeScript** (strict), as specified throughout the design.

The plan reaches a running, deployable site early (tasks 1–3 give a buildable app with validated content and tested shared libraries), then deepens in the operator-mandated priority order: admin product management → catalogue → product detail → conversion → premium UI/UX → motion → performance → security → SEO → mobile. Foundational scaffolding, schemas, and shared libraries come first only because every later task depends on them.

Two standing constraints, called out again where they apply:

- **No logo asset exists.** Task 13.2 implements the typographic wordmark fallback path and the single swap-in point (`SiteSettings.logo.src`). Do not block on the asset; do not draw a substitute mark.
- **No real product content exists.** `data/products/` ships empty. Every catalogue surface must render its designed empty state. Any demo product needed for tests lives in `tests/fixtures/` only — never in `data/products/`.

Design references below name the section of `design.md` the task follows. Requirement references name granular acceptance criteria in `requirements.md`. Property numbers refer to `design.md` → Correctness Properties (`### Property N`, 55 total).

---

## Tasks

### Phase A — Foundation

- [x] 1. Scaffold the Astro/Cloudflare project, design tokens, test harness, and CI gates
  - [x] 1.1 Initialize the Astro 5 + React 19 + Cloudflare project skeleton
    - Create `package.json`, `astro.config.mjs` (integrations: `@astrojs/react`, `@astrojs/cloudflare` adapter, Tailwind v4 Vite plugin; `output: 'static'` with per-route `prerender` opt-out), `tsconfig.json` (`strict: true`, `noUncheckedIndexedAccess`, path alias `@/* → src/*`), `.gitignore`, `.editorconfig`
    - Create the empty directory skeleton exactly as the design's Folder Structure defines: `src/{schemas,pages,components/{ui,product,motion,admin},lib/{github,auth,ai,images,search,analytics},styles}`, `data/{products,categories,reviews,site,snapshots}`, `scripts/`, `tests/{unit,property,e2e,fixtures}`, `public/brand/`
    - Add a placeholder `src/pages/index.astro` so `npm run build` succeeds from this task onward
    - _Requirements: 28.9_
    - _Design: Technology Decisions; Architecture → Folder Structure_

  - [x] 1.2 Define the Tailwind v4 theme: palette, typography, and motion tokens
    - Create `src/styles/tokens.css` with the `@theme` block carrying exactly the eight palette custom properties (`--color-obsidian` `#171513`, `--color-espresso` `#3B2A21`, `--color-walnut` `#6B4A36`, `--color-champagne` `#B88A45`, `--color-ivory` `#F8F2EA`, `--color-cream` `#EFE4D7`, `--color-taupe` `#CBBBA9`, `--color-white` `#FFFFFF`) and the motion tokens (`--dur-fast` 180ms, `--dur-normal` 320ms, `--dur-reveal` 640ms, `--dur-story` 1000ms, the four easing curves, `--stagger-tight` 45ms, `--stagger-loose` 90ms)
    - Create `src/styles/global.css` with the fluid `clamp()` type scale (h1/h2/h3/body/small per the design), the serif-display / sans-body family assignments, self-hosted `@font-face` declarations subsetted to `latin` + `₹` with `font-display: swap`, radius scale limited to `0`/`2px`/`4px`, and the two-level elevation scale
    - Add the global `prefers-reduced-motion: reduce` block from the Motion System (duration clamp to 1ms, iteration count 1, `scroll-behavior: auto`)
    - Export the palette pairs actually in use as a typed table in `src/styles/tokens.ts` so the contrast test in 1.6 can enumerate them
    - _Requirements: 21.1, 21.4, 21.7_
    - _Design: Visual Design System → Palette tokens, Typography, Layout language; Motion System → Tokens, Reduced motion_

  - [x] 1.3 Wire the test harness: Vitest, fast-check, and Playwright
    - Create `vitest.config.ts` (two projects: `unit` over `tests/unit`, `property` over `tests/property`; Node environment; `@/*` alias resolution) and `tests/setup.ts`
    - Add fast-check with a shared config in `tests/property/config.ts` (`numRuns: 300`, `seed` reporting on failure, `verbose` on CI) and a `tests/property/arbitraries.ts` module for the shared generators the design's strategies name (slug arbitrary, SKU arbitrary, E.164 arbitrary, `SearchDoc` arbitrary, valid-`Product` arbitrary)
    - Create `playwright.config.ts` with the nine viewport widths (320, 375, 390, 414, 768, 1024, 1280, 1440, 1920) as named projects, `webServer` pointing at the preview build, and traces on failure
    - Create `tests/fixtures/products.ts` holding the demo product objects used by tests, with a file header stating that demo products must never be written to `data/products/`
    - _Requirements: 27.12_
    - _Design: Testing Strategy → Unit, Property-based, End-to-end testing; Open Items item 5_

  - [x] 1.4 Configure Cloudflare bindings and the environment variable example
    - Create `wrangler.toml` declaring KV namespaces `SESSIONS`, `DRAFTS`, `RATELIMIT`, D1 binding `DB`, R2 binding `MEDIA`, the Rate Limiting binding, and the `compatibility_date`/`nodejs_compat` flags the adapter needs; include a `[env.preview]` block with a distinct `PUBLIC_SITE_URL`
    - Declare no secret values in `wrangler.toml`; document that `GITHUB_TOKEN`, `GITHUB_REPO`, `GITHUB_BRANCH`, `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`, `SESSION_SECRET`, and `CF_DEPLOY_HOOK_URL` are set with `wrangler secret put`
    - Create `.env.example` listing every variable name above plus `PUBLIC_SITE_URL`, `PUBLIC_WHATSAPP_NUMBERS`, `PUBLIC_PHONE_NUMBERS`, each with a placeholder value only and a comment naming what it is for
    - Create `src/lib/env.ts` exposing a typed accessor that reads bindings from the Astro/Worker runtime context and throws a stable error code when a required binding is absent
    - _Requirements: 25.12, 25.13, 28.5, 28.7, 28.9_
    - _Design: Architecture → Folder Structure (Bindings); Deployment_

  - [x] 1.5 Add the npm scripts and the CI pipeline in the design's gate order
    - Add scripts to `package.json`: `dev`, `build`, `preview`, `check` (`astro check` + `tsc --noEmit`), `lint` (ESLint + Prettier check), `test` (Vitest unit + property), `test:e2e`, `validate:content`, `scan:secrets`, `size-limit`, `product:add`
    - Create `scripts/scan-secrets.ts`: walks every file under `dist/` and fails with a non-zero exit and the offending file/offset on any match of `ghp_`, `github_pat_`, `sk-`, `AI_API_KEY`, `SESSION_SECRET`, `-----BEGIN * PRIVATE KEY-----`
    - Create `.github/workflows/ci.yml` running, in this exact order: install → `validate:content` → `check` → `lint` → `test` → `build` → `size-limit` → `scan:secrets`; any failure stops the job before any deploy step
    - Create `eslint.config.js` and `.prettierrc`; add a `size-limit` config stub in `package.json` (real budgets are filled in task 21.1)
    - _Requirements: 27.12, 28.3, 28.4, 28.6_
    - _Design: Testing Strategy → CI gates; Deployment_

  - [x]* 1.6 Write the palette contrast unit test
    - `tests/unit/tokens.contrast.test.ts`: compute the WCAG contrast ratio for every foreground/background pair exported from `src/styles/tokens.ts` and assert each meets AA for its declared use (4.5:1 body, 3:1 large text and UI strokes)
    - Assert champagne gold is absent from the body-text pair set
    - _Requirements: 21.2, 21.3_
    - _Design: Visual Design System → Palette tokens_

### Phase B — Data layer

- [x] 2. Build the content schemas, content collections, validation gate, and seed content
  - [x] 2.1 Implement the canonical product schema with its cross-field invariants
    - Create `src/schemas/product.ts` exactly as the design specifies: `ProductStatus`, `StockStatus`, `ProductImage`, `Dimensions`, `ProductVariant`, and `ProductSchema` with `.passthrough()` and `.superRefine(enforceProductInvariants)`; export the inferred `Product` type
    - Implement `enforceProductInvariants` with all six checks: price XOR `priceOnEnquiry`; `originalPrice > price` and `discount` equal to the computed percentage; `published` mirrors `status ∈ {PUBLISHED, OUT_OF_STOCK}`; `status OUT_OF_STOCK ⟺ stockStatus OUT_OF_STOCK`; `madeToOrder ⟹ stockStatus MADE_TO_ORDER`; `primaryImage` references an owned image; `images[].order` contiguous from 0
    - Create `src/schemas/issue.ts` with the shared `issue`/`requireNonEmpty`/`requireMinLength` refinement helpers so every field error carries the failing field path
    - _Requirements: 13.9, 13.10, 13.11, 14.1, 14.7, 14.8, 14.14, 14.15, 17.1, 17.9_
    - _Design: Data Models → Canonical product schema, Cross-field invariants_

  - [x]* 2.2 Write property tests for the product schema
    - `tests/property/product-schema.property.test.ts`
    - **Property 12: Product serialization round-trips** — Validates: Requirements 17.1, 17.7, 25.1, 26.11, 27.11
    - **Property 13: Unknown fields survive the round-trip** — Validates: Requirements 17.9
    - **Property 14: Price and price-on-enquiry are mutually exclusive** — Validates: Requirements 1.7, 13.11, 23.8
    - **Property 15: Discounts cannot be fabricated by original price** — Validates: Requirements 13.9
    - **Property 16: Discount percentage must be the computed value** — Validates: Requirements 13.10
    - **Property 17: The published flag mirrors status** — Validates: Requirements 14.1, 14.7, 14.9
    - **Property 20: Image order is a contiguous permutation** — Validates: Requirements 14.14, 14.15, 15.14

  - [x] 2.3 Implement the publish gate schema
    - Create `src/schemas/publish-gate.ts` exporting `PublishReadySchema` = `ProductSchema` plus the tightening refinements: non-empty name, category, SKU; description ≥ 20 chars; price or `priceOnEnquiry`; at least one image; stock status present; non-empty trimmed `alt` on every image
    - Export `checkPublishGate(product): { ok: true } | { ok: false; fields: Record<string, string[]> }` returning field-keyed failures for the admin UI, never a thrown error
    - _Requirements: 12.3, 14.4, 14.5_
    - _Design: Data Models → Publish gate_

  - [x]* 2.4 Write property tests for the publish gate
    - `tests/property/publish-gate.property.test.ts`
    - **Property 18: The publish gate is stricter than the base schema** — Validates: Requirements 12.3, 14.4, 14.5, 24.10
    - **Property 19: Publish-ready implies schema-valid** — Validates: Requirements 14.4, 17.7, 17.8, 25.1, 26.9, 27.6

  - [x] 2.5 Implement the category, review, and site settings schemas
    - Create `src/schemas/category.ts`, `src/schemas/review.ts`, `src/schemas/site.ts` with `CategorySchema`, `ReviewSchema`, `SiteSettingsSchema` exactly as the design lists them, each `.passthrough()`
    - `SiteSettingsSchema` keeps `whatsapp` and `phone` as arrays of `{ label, e164 }` with the E.164 regex, `logo` as `{ src: string | null, wordmarkFallback: string }`, nullable `location.mapUrl`/`geo`/`postalCode`, nullable social values, and `placeholders: string[]`
    - Add `src/schemas/homepage.ts` (`HomepageSchema`: ordered section records with `key`, `enabled`, and per-section copy fields) and `src/schemas/rankings.ts` (`RankingsSchema`: manual ordering arrays for trending, bestSeller, mostViewed)
    - _Requirements: 18.1, 18.7, 19.1, 19.2, 19.8, 7.7, 7.13, 8.8_
    - _Design: Data Models → Other collections_

  - [x] 2.6 Wire the Astro content collections and the build-time validation gate
    - Create `src/content.config.ts` declaring collections `products`, `categories`, `reviews` with glob loaders over `data/**` and the Zod schemas from 2.1/2.5 as the collection schemas
    - Create `src/lib/content/site.ts` loading and validating `data/site/settings.json`, `homepage.json`, `rankings.json` at build time, and `src/lib/content/catalogue.ts` exporting `getCatalogue()` (products with `status ∈ {PUBLISHED, OUT_OF_STOCK}`) and `getPublishedCategories()` — the single filter every public surface reads
    - Create `scripts/validate-content.ts`: validates every file under `data/` against its schema, additionally validates that each product's `category` resolves to an existing category file, and exits non-zero naming the file and the failing field path
    - Wire `validate:content` as a pre-build step so an invalid content file fails the build before deploy
    - _Requirements: 17.1, 17.7, 18.5, 26.11, 28.3_
    - _Design: Data Models → File layout rules; Testing Strategy → CI gates_

  - [x] 2.7 Seed the nine categories and the three site configuration files
    - Create `data/categories/{sofas,beds,dining-tables,dining-chairs,accent-chairs,coffee-side-tables,storage-display,office,outdoor}.json`, each with `slug`, `name`, `shortDescription`, `order`, and the matching `illustration` key from the `CategorySchema` enum; `published: true`; no invented product counts or claims
    - Create `data/site/settings.json` with `businessName`, `logo: { src: null, wordmarkFallback: "NEW GALAXY FURNITURE" }`, both numbers `+919513443606` and `+918147083703` in **both** the `whatsapp` and `phone` arrays with the neutral labels `Orders & Enquiries 1` / `Orders & Enquiries 2`, `location` with null `mapUrl`/`geo`/`postalCode` and empty address lines, `serviceArea: ["Karnataka"]`, all social values null, SEO defaults, and a `placeholders` array listing every content key still awaiting real copy
    - Create `data/site/homepage.json` with the fifteen section entries in the required order, each `enabled: true`, craftsmanship/direct-manufacturer/workshop copy left as explicit `[PLACEHOLDER — …]` markers; create `data/site/rankings.json` with empty manual ordering arrays; create `data/site/redirects.json` as an empty map
    - Leave `data/products/` empty apart from a `.gitkeep`, and add `data/snapshots/.gitkeep`
    - _Requirements: 18.1, 19.3, 19.4, 19.6, 7.1, 7.10, 8.8_
    - _Design: Data Models → Other collections; Open Items items 1, 2, 5_

  - [x]* 2.8 Write unit tests for the content loaders and the validation gate
    - `tests/unit/validate-content.test.ts`: a well-formed fixture tree passes; a product with an unknown category fails naming the field; a malformed JSON file fails naming the file
    - `tests/unit/catalogue-filter.test.ts`: `getCatalogue()` includes `PUBLISHED` and `OUT_OF_STOCK` and excludes `DRAFT`, `REVIEW`, `UNPUBLISHED`
    - _Requirements: 1.16, 2.11, 17.7, 26.11_

- [x] 3. Implement the shared pure libraries with their property tests
  - [x] 3.1 Implement slug and SKU generation
    - Create `src/lib/slug.ts` with `toSlug(name)`, `uniqueSlug(name, taken)`, `generateSku(categorySlug, taken)` and the category→prefix map (e.g. `sofas → SOF`)
    - `toSlug` follows the design algorithm exactly: NFKD normalize → strip diacritics → lowercase → replace every non-`[a-z0-9]` run with `-` → collapse repeats → trim leading/trailing `-` → truncate to 80 chars at a `-` boundary → fall back to `item` when empty
    - `uniqueSlug` suffixes `-2`, `-3`, … and never mutates an existing slug; `generateSku` emits `NGF-{PREFIX}-{6 base36 chars}` matching `/^[A-Z0-9][A-Z0-9-]{2,31}$/` and retries on collision with `taken`
    - _Requirements: 13.13, 17.19, 27.4_
    - _Design: Data Models → Slug and SKU generation_

  - [x]* 3.2 Write property tests for slug and SKU generation
    - `tests/property/slug.property.test.ts`
    - **Property 1: Slug output charset is closed** — Validates: Requirements 13.13, 23.12, 27.4
    - **Property 2: Slug generation is idempotent** — Validates: Requirements 13.13, 27.4
    - **Property 3: Slug length is bounded** — Validates: Requirements 13.13, 23.12, 27.4
    - **Property 4: Unique slug avoids collisions and preserves its prefix** — Validates: Requirements 12.11, 12.12, 17.19, 27.4
    - **Property 5: Folding unique slug over a growing set yields distinct slugs** — Validates: Requirements 17.19, 27.4
    - **Property 6: SKU generation is unique and well-formed** — Validates: Requirements 12.5, 13.13, 27.4

  - [x] 3.3 Implement the WhatsApp and telephone URL builders
    - Create `src/lib/whatsapp.ts` with `EnquiryContext`, `buildEnquiryMessage(ctx, site)`, `buildWhatsAppUrl(e164, message)`, `buildTelUrl(e164)` — all pure, no per-product stored message string
    - Product messages include the product name and SKU verbatim and omit any amount when `priceOnEnquiry`; category messages carry the category name only; general messages carry neither; messages longer than 900 characters are shortened in the descriptive portion only, never in the name or SKU
    - `buildWhatsAppUrl` emits `https://wa.me/<digits>?text=<encodeURIComponent(message)>` — digits only after stripping `+`/spaces/punctuation, encoded exactly once; `buildTelUrl` emits `tel:+91…` with a leading `+` and digits only
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.13_
    - _Design: Conversion → Message and URL construction_

  - [x]* 3.4 Write property tests for enquiry URL construction
    - `tests/property/whatsapp.property.test.ts`
    - **Property 8: Enquiry URLs are encoded exactly once** — Validates: Requirements 5.5, 27.8
    - **Property 9: Product enquiries always name the product and SKU** — Validates: Requirements 5.1, 5.2
    - **Property 10: wa.me numbers are digits only** — Validates: Requirements 5.6, 5.13, 19.8
    - **Property 11: Adversarial message text still yields a parseable URL** — Validates: Requirements 5.7

  - [x] 3.5 Implement INR formatting
    - Create `src/lib/money.ts` with `formatINR(amount)` producing the `₹` symbol with Indian digit grouping and no fractional digits (100000 → `₹1,00,000`), `parseINR(text)` as its inverse, and the exported `PRICE_ON_ENQUIRY_LABEL = 'Price on enquiry'` used by every surface
    - Export `priceBandOf(price)` mapping a price to the five required bands, returning `null` for `priceOnEnquiry` products so banded filters exclude them
    - _Requirements: 1.6, 1.7, 3.2, 3.9_
    - _Design: Catalogue → Filters; Data Models → Canonical product schema_

  - [x]* 3.6 Write property tests for INR formatting
    - `tests/property/money.property.test.ts`
    - **Property 44: INR formatting uses Indian grouping and round-trips** — Validates: Requirements 1.6, 1.7

  - [x] 3.7 Implement Indian phone normalization
    - Create `src/lib/phone.ts` with `normalizeIndianPhone(input)` accepting `9513443606`, `09513443606`, `+91 95134 43606`, `919513443606` (with or without internal spaces, hyphens, parentheses) and returning canonical `+919513443606`, plus `isE164(value)` and a `formatDisplayPhone(e164)` helper for the UI
    - Anything not normalizable returns a typed failure carrying a human message for field-level display; never throws
    - _Requirements: 6.4, 6.5, 19.8_
    - _Design: Conversion → Lead capture_

  - [x]* 3.8 Write property tests for phone normalization
    - `tests/property/phone.property.test.ts`
    - **Property 42: Indian phone normalization is canonical and idempotent** — Validates: Requirements 6.4, 6.5, 19.8

  - [x] 3.9 Implement product duplication
    - Create `src/lib/products/duplicate.ts` with `duplicateProduct(source, taken)` returning a deep copy carrying a fresh `id`, a fresh `sku` from `generateSku`, a slug from `uniqueSlug` seeded with the source name plus " copy", `status: 'DRAFT'`, `published: false`, and new `createdAt`/`updatedAt`
    - Deep-clone `images`, `tags`, `variants`, and `availableColors` so no nested array is aliased with the source; the source object is never mutated
    - _Requirements: 12.5, 12.6_
    - _Design: Data Models → Slug and SKU generation (Duplicate must not overwrite the original)_

  - [x]* 3.10 Write property tests for product duplication
    - `tests/property/duplicate.property.test.ts`
    - **Property 7: Duplicate never mutates or clobbers its source** — Validates: Requirements 12.5, 12.6

- [x] 4. Checkpoint — foundation and data layer
  - Run `npm run validate:content`, `npm run check`, `npm run lint`, `npm test`, `npm run build`. Ensure all tests pass, ask the user if questions arise.


### Phase C — Admin (sequencing priority 1: Admin Product Management)

- [x] 5. Build admin authentication, sessions, CSRF, rate limiting, and the permission model
  - [x] 5.1 Create the D1 schema and the admin seeding script
    - Create `migrations/0001_admin.sql` with the `admin_users` and `login_attempts` tables exactly as the design's SQL defines them, including the unique lowercased email index
    - Create `scripts/seed-admin.ts`: prompts for email and password, derives the hash locally through the same `hashPassword` used at runtime, inserts one `owner` row via `wrangler d1 execute`; ships no default password and prints no password to stdout or logs
    - Add an `db:migrate` npm script applying migrations to local and remote D1
    - _Requirements: 10.4, 10.13, 10.18_
    - _Design: Admin Authentication → Credential storage_

  - [x] 5.2 Implement password hashing and verification
    - Create `src/lib/auth/password.ts` with `hashPassword(plain)` and `verifyPassword(plain, stored)` using WebCrypto PBKDF2-HMAC-SHA-256, 600,000 iterations, 16-byte random salt, 32-byte key, serialized as `pbkdf2$sha256$600000$<b64 salt>$<b64 key>` so the iteration count can be raised later
    - Compare with a constant-time byte comparison; never log, store, or echo the plaintext; expose `needsRehash(stored)` for transparent upgrade on next successful login
    - _Requirements: 10.4, 25.16_
    - _Design: Admin Authentication → Credential storage_

  - [x]* 5.3 Write property tests for password verification
    - `tests/property/password.property.test.ts`
    - **Property 54: Password verification is exact and leaks no plaintext** — Validates: Requirements 10.4, 25.16

  - [x] 5.4 Implement opaque KV sessions
    - Create `src/lib/auth/session.ts` with the `Session` interface from the design and `createSession`, `readSession`, `touchSession`, `destroySession` over KV `SESSIONS` at `session:{id}`, TTL matching the 12-hour absolute cap
    - 32 random bytes base64url for both the session id and `csrfToken`; 2-hour idle expiry enforced on read; `lastSeenAt` written at most once every 5 minutes to avoid a KV write per request
    - Set/clear the `ngf_session` cookie as `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200`; logout deletes the KV record so the previous cookie value is no longer accepted
    - _Requirements: 10.3, 10.6, 10.7, 25.11_
    - _Design: Admin Authentication → Sessions_

  - [x] 5.5 Implement the CSRF and origin guard middleware
    - Create `src/lib/auth/guard.ts` exporting `requireAdmin(context, permission)` implementing the design's guard order exactly: origin/referer match → session read → `X-CSRF-Token` equality with `session.csrfToken` → permission check → Zod payload validation; each failure returns the uniform envelope with 403/401/403/422 respectively and performs no data change
    - Enforce `application/json` on every admin endpoint except the multipart upload route, which still requires the CSRF header
    - Create `src/middleware.ts` applying the guard to every `/api/admin/**` and `/admin/**` route and emitting `noindex, nofollow` on admin and preview responses
    - _Requirements: 10.1, 10.8, 10.9, 11.5, 12.10, 25.4_
    - _Design: Admin Authentication → CSRF; Endpoint contracts (error envelope)_

  - [x] 5.6 Implement rate limiting, login lockout, and the auth endpoints
    - Create `src/lib/auth/rate-limit.ts` implementing every row of the design's abuse-control table: 5 failures per email per 15 min with progressive 1/5/15/60-minute locks (D1 `login_attempts`), 20 login attempts per IP per 15 min, 120 `/api/admin/*` requests per minute per session, 30 uploads per 10 min per session, 20 AI generations per hour per session, 5 leads per hour per IP, 200 events per minute per IP
    - Create `src/pages/api/admin/login.ts`, `logout.ts`, `session.ts`: login returns a uniform `401 {error:'INVALID_CREDENTIALS'}` for both unknown email and wrong password with an enforced minimum response time; rate-limit responses state the whole number of minutes remaining
    - _Requirements: 10.5, 10.10, 10.11, 10.12, 25.8, 26.10_
    - _Design: Admin Authentication → Brute-force and abuse control_

  - [x] 5.7 Implement the role and permission model with the route permission table
    - Create `src/lib/auth/permissions.ts` with `Role`, the `Permission` union, `ROLE_PERMISSIONS` (owner: all; editor: read/write plus `ai.generate`, `lead.*`, `review.write`; viewer: read-only), and `can(role, permission)`
    - Create `src/lib/auth/routes.ts` exporting `ADMIN_ROUTES`: one entry per admin API route with its method, path pattern, and required permission — the single table the guard and the property test both read, so a new endpoint cannot exist without a declared permission
    - _Requirements: 10.13, 10.14, 10.15, 10.16, 10.18_
    - _Design: Admin Authentication → Role model_

  - [x]* 5.8 Write property tests for the permission model
    - `tests/property/permissions.property.test.ts`
    - **Property 29: Viewers hold no mutating permission** — Validates: Requirements 10.16
    - **Property 30: Every admin route declares a permission** — Validates: Requirements 10.15

  - [x] 5.9 Build the login page and the admin application shell
    - Create `src/pages/admin/login.astro` with the login form (labelled controls, `aria-invalid`/`aria-describedby` errors, lockout message) and `src/layouts/AdminLayout.astro` emitting `noindex, nofollow` and bootstrapping the CSRF token into the SSR payload
    - Create `src/components/admin/AdminNav.tsx` with persistent navigation to all eleven admin areas (Dashboard, Products, Add Product, AI Product Assistant, Categories, Reviews, Leads, Homepage, Content, Analytics, Settings), hiding entries the session's role lacks permission for
    - Unauthenticated `/admin/**` requests redirect to `/admin/login?next=<path>` and return the operator to that path after success; an expired session takes the same path
    - _Requirements: 10.2, 10.17, 11.1, 11.5, 24.8, 26.3_
    - _Design: Pages, Navigation, and States → Route inventory; Admin Authentication_

  - [x]* 5.10 Write integration tests for the session lifecycle
    - `tests/unit/auth.session.integration.test.ts` against local KV/D1 bindings: issue, idle renewal, idle expiry at 2 h, absolute expiry at 12 h, logout revocation invalidating the prior cookie, email lockout escalation through 1/5/15/60 minutes, and per-IP login cap
    - _Requirements: 10.3, 10.6, 10.7, 10.10, 10.11_

- [x] 6. Build the Worker → GitHub content write pipeline and the status transition machine
  - [x] 6.1 Implement the path allowlist resolver
    - Create `src/lib/github/paths.ts` with `ALLOWED_PATTERNS` (products, categories, `rev_*` reviews, and `data/site/(settings|homepage|rankings|redirects).json`) and `resolveContentPath(candidate)` implemented exactly as the design's total function: NFC check, NUL/backslash rejection, single safe decode rejecting double-encoding, segment check for empty/`.`/`..`, leading-separator rejection, then allowlist match; returns `string | null` and never throws
    - _Requirements: 17.3, 17.4, 17.5, 17.6, 17.13, 25.5_
    - _Design: Write Pipeline → Path allowlist_

  - [x]* 6.2 Write property tests for the path allowlist
    - `tests/property/paths.property.test.ts`
    - **Property 21: Traversal and encoding attacks are rejected** — Validates: Requirements 6.16, 15.7, 17.3, 17.5, 25.5
    - **Property 22: Accepted paths are always allowlisted data paths** — Validates: Requirements 17.3, 17.4, 17.13, 17.18, 25.5, 27.2
    - **Property 23: Legitimate product paths are never rejected** — Validates: Requirements 17.6
    - **Property 24: Path resolution is total** — Validates: Requirements 17.6

  - [x] 6.3 Implement the GitHub commit client
    - Create `src/lib/github/client.ts`: `readFile(path)` returning content plus blob `sha`, `writeFile({path, content, sha, message})` via the Contents API, `writeTree(changes[], message)` via the Git Data API for atomic multi-file actions (rename = write new + delete old + update `redirects.json` in one commit), and `deleteFile(path, sha)`
    - Every write resolves its path through `resolveContentPath` server-side from the stored record — no browser-supplied path is ever accepted; the token is read from the Worker binding and never returned in any response
    - Structured commit messages per the design: `content(product): <action> "<name>" [<SKU>]` with `Actor`, `Action`, and `Status: FROM -> TO` trailers; append ` [skip ci]` for draft/review-only changes
    - Merge semantics preserve unknown fields: read raw JSON, apply the field patch, re-serialize with stable key order and a trailing newline
    - `409`/`422` from GitHub becomes `409 CONFLICT` carrying the current remote value for field-level diffing; failures retain the operator's values and offer retry; a short-lived KV lock `lock:product:{id}` (10 s TTL) serializes concurrent writes to the same product
    - _Requirements: 12.13, 17.2, 17.9, 17.10, 17.11, 17.12, 17.14, 17.15, 17.16, 17.17, 17.18, 25.12, 26.4, 26.5_
    - _Design: Write Pipeline → Principles, Commit strategy, Conflict handling_

  - [x]* 6.4 Write integration tests for the write pipeline
    - `tests/unit/github.pipeline.integration.test.ts` against a mocked GitHub API: single-file update path, atomic multi-file rename, `[skip ci]` presence on draft commits and absence on publish commits, commit-message trailer contents, unknown-field preservation, and the 409 conflict path returning the remote value
    - _Requirements: 17.9, 17.10, 17.12, 17.14, 17.15, 17.16_

  - [x] 6.5 Implement the status transition machine
    - Create `src/lib/products/transitions.ts` with the `TRANSITIONS` map exactly as the design declares it and `canTransition(from, to, role)` returning false for self-transitions, for undeclared targets, and for `PUBLISHED`/`OUT_OF_STOCK` targets when `can(role, 'product.publish')` is false
    - Create `applyTransition(product, to, role)` which additionally runs `checkPublishGate` before any public state and returns field-keyed failures otherwise; reachable only from an authenticated interactive request — no scheduled or automated caller
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.10, 14.11_
    - _Design: Write Pipeline → Status transition machine_

  - [x]* 6.6 Write property tests for transitions and publishing
    - `tests/property/transitions.property.test.ts`
    - **Property 25: There are no self-transitions** — Validates: Requirements 14.2
    - **Property 26: Transitions respect the declared machine** — Validates: Requirements 14.1, 14.2
    - **Property 27: Reaching a public state requires publish permission** — Validates: Requirements 10.14, 14.3
    - **Property 28: No transition sequence can publish an incomplete product** — Validates: Requirements 14.6, 14.10

  - [x] 6.7 Implement the KV draft store and the state→repository mapping
    - Create `src/lib/github/drafts.ts` with `putDraft`, `getDraft`, `deleteDraft`, `listDrafts` over KV `DRAFTS` at `draft:{productId}`, and `resolveProduct(id)` returning `{ product, source: 'draft' | 'repo' }`
    - Implement the design's state→repository table: `DRAFT`/`REVIEW` write both KV and the repo with `[skip ci]`; `PUBLISHED`/`OUT_OF_STOCK`/`UNPUBLISHED`/delete write the repo and trigger a build, deleting the KV draft; every save is readable for preview within one second
    - Create `src/pages/api/admin/rehydrate.ts` rebuilding KV from the repository
    - _Requirements: 12.4, 14.9, 17.14, 17.15_
    - _Design: Write Pipeline → State → repository mapping_

  - [x] 6.8 Implement the deploy status endpoint
    - Create `src/pages/api/admin/deploy-status.ts` returning `{ state, startedAt, commitSha }` from the Cloudflare deployments API for the latest build of the content branch, with a stable error code when the upstream call fails and no upstream body echoed
    - _Requirements: 14.12, 14.13, 26.6_
    - _Design: Write Pipeline → Publish flow, end to end_

- [x] 7. Build admin product management: endpoints, list, editor, lifecycle, duplicate/delete, preview, dashboard
  - [x] 7.1 Implement the product CRUD endpoints
    - Create `src/pages/api/admin/products/index.ts` (`GET` list with `status`/`q`/`category`/`page`, `POST` create) and `src/pages/api/admin/products/[id].ts` (`GET`, `PATCH` with `expectedUpdatedAt` optimistic concurrency, `DELETE` requiring `confirmSlug`)
    - Create requires a name and category only, generates `id`, `slug` (`uniqueSlug` against every existing product slug), and `sku` (`generateSku`), stores as `DRAFT` without applying the publish gate, and returns `201 { id, slug, sku }`
    - Every payload is re-validated server-side against `ProductSchema` (partial for `PATCH`) before any write; `422` returns field-keyed errors
    - _Requirements: 12.1, 12.2, 12.3, 12.13, 13.13, 17.7, 17.8, 17.19, 25.1_
    - _Design: Write Pipeline → Endpoint contracts_

  - [x] 7.2 Build the product list view
    - Create `src/pages/admin/products/index.astro` + `src/components/admin/ProductTable.tsx`: columns for image, name, SKU, category, status, stock status, updated date; filter by `Product_Status` and category; text search; keyboard-operable rows and controls
    - Render the designed empty state ("No products yet — add your first product") rather than an empty table, and hide mutating controls for roles lacking permission
    - _Requirements: 12.2, 10.17, 24.5, 26.14_
    - _Design: Pages, Navigation, and States → Route inventory; Error Handling → Empty states_

  - [x] 7.3 Build the manual product creator and editor form
    - Create `src/pages/admin/products/new.astro`, `src/pages/admin/products/[id].astro`, and `src/components/admin/ProductForm.tsx` with the seven required groups: Basic Information (name, category, subcategory, description, short description), Pricing (price, price-on-enquiry, original price, derived discount), Product (material, colour, available colours, dimensions, size, variants, customization, delivery information), Inventory (stock status, made-to-order), Marketing (featured/trending/best seller/new arrival flags, tags, related products), SEO (title, description, keywords), Images (up to 20)
    - Client-side field validation mirrors the Zod schema: original price must exceed price, discount is derived and read-only, price-on-enquiry clears and disables the numeric price; every message is field-level and clears nothing else
    - Every field is completable without the AI assistant; save writes a draft through 7.1 and shows the last-saved time
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8, 13.9, 13.10, 13.11, 13.12, 12.8, 24.8, 24.9, 26.9_
    - _Design: Data Models → Canonical product schema; Write Pipeline → Endpoint contracts_

  - [x] 7.4 Build the lifecycle transition endpoint and publish UI
    - Create `src/pages/api/admin/products/[id]/transition.ts` calling `applyTransition`, committing through the pipeline, deleting the KV draft on publish, and returning `{ product, deployTriggered }` or `422 { fields }` on a gate failure
    - Create `src/components/admin/PublishPanel.tsx`: shows only the transitions legal from the current status, renders gate failures against the specific fields that failed, then shows "Publishing — live in about a minute" while polling `/api/admin/deploy-status`, resolving to "Live now" or "Publish committed but the site build failed" with the build reference — never a success state before the deploy confirms
    - _Requirements: 14.2, 14.4, 14.5, 14.12, 14.13, 12.8, 26.6_
    - _Design: Write Pipeline → Publish flow, end to end; Error Handling → Failure modes_

  - [x] 7.5 Implement duplicate, delete, and the slug-rename redirect path
    - Create `src/pages/api/admin/products/[id]/duplicate.ts` wiring `duplicateProduct` from 3.9, writing the copy with create-if-absent semantics (no blob `sha`) so it can never clobber its source, returning `201 { id, slug, sku }`
    - Delete requires an explicit confirmation naming the product's slug, removes the repo file and the KV draft in one commit, and triggers a deploy that removes the page, listing, search entry, and sitemap entry
    - Rename detection: when the name change would change the slug, require explicit confirmation in the UI, then write the new file, delete the old, and append the entry to `data/site/redirects.json` in a single atomic commit; the build turns each entry into a 301
    - _Requirements: 12.5, 12.6, 12.7, 12.11, 12.12, 14.9_
    - _Design: Data Models → Slug and SKU generation; Write Pipeline → Commit strategy_

  - [x] 7.6 Build the draft preview route
    - Create `src/pages/admin/preview/[id].astro`: SSR, session-guarded, `noindex, nofollow`, reading the KV draft and rendering the **same** components the public product detail page uses, so preview and production cannot diverge
    - Where the PDP components do not yet exist, render against the shared block components and wire the full page in task 15.4 — leave no duplicate preview-only markup behind
    - _Requirements: 12.4, 12.9, 12.10, 23.15_
    - _Design: Architecture → Request / Render Path; Write Pipeline → State → repository mapping_

  - [x] 7.7 Build the admin dashboard
    - Create `src/pages/admin/index.astro` + `src/components/admin/DashboardCards.tsx` showing counts of published products, drafts, products awaiting review, out-of-stock products, and new leads, each derived from stored records only
    - A metric with no underlying records renders an explicit empty state, never a zero dressed as a result; recent activity reads the content change history from the commit log of `data/`
    - _Requirements: 11.2, 11.3, 11.4, 11.6, 26.14_
    - _Design: Pages, Navigation, and States; Error Handling → Empty states_

- [x] 8. Build the image pipeline: validation, derivatives, delivery, and the image manager
  - [x] 8.1 Implement upload validation
    - Create `src/lib/images/validate.ts` with `UploadConstraints` (12 MB, 40 MP, 800 px minimum width, JPEG/PNG/WebP/AVIF) and `validateUpload(file)` following the design's order: `Content-Length` before reading the body → magic-byte sniff of the first 32 bytes (declared MIME and extension are advisory only) → SVG rejected outright → header dimension parse against max pixels and min width → full decode, which also strips all metadata including EXIF GPS
    - Object keys are generated server-side as `products/{productId}/{imageId}/original.{ext}`; the client filename is kept only as a sanitized display label and never used in a path
    - Each rejection names its specific reason and leaves other files in the batch unaffected
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 25.6, 26.8_
    - _Design: Image Pipeline → Upload validation_

  - [x]* 8.2 Write property tests for upload validation
    - `tests/property/upload.property.test.ts`
    - **Property 46: Magic bytes decide upload acceptance** — Validates: Requirements 6.11, 15.1, 15.2, 15.3, 15.4, 25.6, 26.8, 27.5

  - [x] 8.3 Implement derivative generation, R2 storage, and the image delivery route
    - Create `src/lib/images/derivatives.ts` generating widths 320/480/640/960/1280/1600/2000 (never above the original) in AVIF q50 and WebP q78 plus one JPEG at 1280, using `@cf-wasm/photon` inside `ctx.waitUntil` after a fast `201`, with `derivativesReady` on the image record
    - Generate the 24 px WebP LQIP and inline it into the product JSON; record intrinsic width and height on every image
    - Create `src/lib/images/srcset.ts` with `buildSrcSet(image, widths)` (never upscales, never empty) and `pickSizes(context)` for `card`/`galleryPrimary`/`galleryThumb`/`hero`
    - Create `src/pages/img/[...path].ts` serving R2 objects with `public, max-age=31536000, immutable` and format negotiation from the `Accept` header
    - Create `src/components/ui/ResponsiveImage.astro` emitting intrinsic dimensions, `srcset`/`sizes`, LQIP background, `loading`/`fetchpriority` per the delivery budget table, and the styled alt-text fallback tile on load failure
    - _Requirements: 15.8, 15.9, 15.10, 15.11, 15.12, 15.13, 15.17, 15.18, 22.9, 22.10_
    - _Design: Image Pipeline → Derivative generation and delivery, Delivery budget on the page_

  - [x]* 8.4 Write property tests for the srcset builder
    - `tests/property/srcset.property.test.ts`
    - **Property 45: srcset never upscales and is never empty** — Validates: Requirements 15.8, 15.12, 22.9, 27.5

  - [x] 8.5 Build the image manager UI and image endpoints
    - Create `src/pages/api/admin/products/[id]/images/index.ts` (multipart `POST`), `order.ts` (`PATCH` ordered ids), `[imgId].ts` (`PATCH` alt/primary, `DELETE` soft-delete moving the object to the `deleted/` prefix with a 30-day lifecycle)
    - Create `src/components/admin/ImageManager.tsx`: drag-and-drop upload with per-file progress and per-file rejection reasons, keyboard-operable reordering, primary-image designation, alt-text editing recording `altSource` as `admin` or `ai`, an "optimizing" state while `derivativesReady` is false, and the drop-zone empty state
    - Reordering always writes a contiguous `order` sequence from 0 so the schema invariant holds
    - _Requirements: 15.14, 15.15, 15.16, 13.8, 14.14, 14.15, 24.5, 26.8, 26.14_
    - _Design: Image Pipeline → Delivery budget on the page; Data Models → Cross-field invariants_

- [x] 9. Checkpoint — admin publish path end to end
  - Verify create → draft save → preview → publish → deploy-status → unpublish → duplicate → delete works against local bindings and a mocked GitHub. Ensure all tests pass, ask the user if questions arise.

- [x] 10. Build the remaining admin areas: categories, reviews, leads, settings, homepage, analytics
  - [x] 10.1 Build category management
    - Create `src/pages/api/admin/categories/[...slug].ts` (`GET`/`POST`/`PATCH`/`DELETE`) and `src/pages/admin/categories.astro` + `src/components/admin/CategoryTable.tsx` supporting create, edit, reorder, publish, unpublish, delete
    - Deleting a category with assigned products is refused with a message reporting the number of assigned products; a new category's route, navigation entry, and filter option all derive from the collection so they appear after the next deploy with no code change
    - _Requirements: 18.2, 18.3, 18.4, 18.5_
    - _Design: Data Models → Other collections; Write Pipeline → Path allowlist_

  - [x] 10.2 Build review management
    - Create `src/pages/api/admin/reviews/[...id].ts` and `src/pages/admin/reviews.astro` + `src/components/admin/ReviewEditor.tsx` collecting customer name, rating 1–5, text, optional customer photo, optional product photo, optional video, optional linked product, optional date; supporting add, edit, delete, publish, unpublish, feature, reorder
    - No review content, rating, or customer name is ever generated or pre-filled; nothing is publicly visible until an operator publishes it
    - _Requirements: 18.6, 18.7, 18.8, 18.9_
    - _Design: Data Models → Other collections_

  - [x] 10.3 Build lead storage and the leads admin
    - Create `migrations/0002_leads.sql` with the `leads` table and `leads_status_created` index exactly as the design's SQL defines them
    - Create `src/pages/api/admin/leads/index.ts` (`GET` with `status`/`q`/`from`/`to`/`page`, plus a CSV export of the current filter) and `[id].ts` (`PATCH` status and note)
    - Create `src/pages/admin/leads.astro` + `src/components/admin/LeadTable.tsx` showing name, phone, referenced product, message, server-recorded date/time, originating page, and status; text search, status and date-range filters; one-action WhatsApp and call links to the lead's own number; inline status changes across NEW/CONTACTED/FOLLOW_UP/CONVERTED/CLOSED; attached enquiry images viewable here only, never on a public surface
    - Render the no-leads empty state; leads are never written to the content repository
    - _Requirements: 6.12, 6.13, 6.14, 6.15, 6.16, 6.11, 20.12, 25.7, 26.14_
    - _Design: Conversion → Lead capture_

  - [x] 10.4 Build settings, homepage, and the content checklist
    - Create `src/pages/api/admin/settings.ts` and `homepage.ts` (`GET`/`PATCH`) writing `data/site/settings.json` and `data/site/homepage.json` through the pipeline
    - Create `src/pages/admin/settings.astro` editing business name, brand mark source, WhatsApp numbers, phone numbers (add/remove entries, each validated as E.164), location details, service area, social links, SEO defaults, and the positioning line (1–120 characters)
    - Create `src/pages/admin/homepage.astro` letting the operator re-word and enable/disable each of the fifteen sections without changing their relative order, and `src/pages/admin/content.astro` rendering `SiteSettings.placeholders` as the checklist of content keys still awaiting real copy
    - _Requirements: 19.1, 19.2, 19.5, 19.6, 19.7, 19.8, 7.7, 7.8, 7.13, 8.8_
    - _Design: Data Models → Other collections; Pages, Navigation, and States → Homepage composition_

  - [x] 10.5 Build the analytics tables and the analytics admin view
    - Create `migrations/0003_events.sql` with `event_daily` and `search_queries` exactly as the design's SQL defines them
    - Create `src/lib/analytics/queries.ts` with the rollup reads and `src/pages/api/admin/analytics.ts` (`GET` with `from`/`to`) returning `AnalyticsSummary`
    - Create `src/pages/admin/analytics.astro` presenting most viewed products, most viewed categories, WhatsApp and call click counts, most frequent searches, zero-result searches, and enquiry counts over a selectable range — every figure labelled `Measured` or `Operator-set`, with the standing notes that clicks record only the act of opening WhatsApp or a dialler and that counts are a lower bound
    - No fabricated, sample, or extrapolated figure anywhere; an empty range renders "No data yet — metrics begin accruing after launch"
    - _Requirements: 20.5, 20.6, 20.7, 20.8, 20.9, 20.10, 20.12, 26.14_
    - _Design: Conversion → Analytics_

- [x] 11. Build the AI product assistant with the deterministic fact guard
  - [x] 11.1 Implement the provider-agnostic AI abstraction and endpoint
    - Create `src/lib/ai/provider.ts` (`AIProvider`, `AIRequest`, `AIResponse`), `src/lib/ai/providers/{openai,anthropic,workers-ai}.ts` as thin adapters, and `src/lib/ai/factory.ts` selecting by the `AI_PROVIDER` secret — adding a provider is one file plus one switch case
    - Create `src/pages/api/admin/ai/generate.ts`: guard + `ai.generate` permission + 20/hour session limit, fetches the 640 px derivatives of the referenced images from R2, calls the provider with a 20-second timeout and one jittered retry, then `503 {error:'AI_UNAVAILABLE'}`; the provider name, model, key, and raw error body never reach the browser and are logged server-side with the key redacted
    - _Requirements: 16.1, 16.2, 16.12, 16.13, 16.14, 16.15, 25.12, 25.14, 25.15_
    - _Design: AI Product Assistant → Provider-agnostic abstraction, Failure handling_

  - [x] 11.2 Implement the fact guard
    - Create `src/lib/ai/fact-guard.ts` with `FACTUAL_FIELDS`, `AdminFacts`, `Suggested<T>`, `ProductDraftSuggestion`, and `applyFactGuard(raw, facts)` implementing all five rules: blank any factual field absent from `facts` with a warning; replace any AI value that differs from a supplied admin value with the admin value; force `category` to an existing category slug or `null` with a warning; filter `styleTags`/`keywords` against the allowed vocabulary plus admin tags; truncate every string to its schema maximum and strip markup and control characters
    - Create `src/lib/ai/banned-claims.ts` with the maintained pattern list (years in business, ISO/certification, awards, customer/employee/showroom counts, delivery-time guarantees, warranty terms, market-position superlatives, prices not in `facts`) and the scrubber that removes matches and reports each removal
    - The guard returns a suggestion object only — it can never set `status` or `published`
    - _Requirements: 16.4, 16.5, 16.6, 16.7, 16.8, 16.9, 16.10, 16.11, 14.11_
    - _Design: AI Product Assistant → Fact / suggestion separation, Hallucination guardrails_

  - [x]* 11.3 Write property tests for the fact guard
    - `tests/property/fact-guard.property.test.ts`
    - **Property 47: Unsupplied factual fields are blanked with a warning** — Validates: Requirements 15.15, 16.2, 16.5, 16.7, 16.9
    - **Property 48: Admin facts always win** — Validates: Requirements 16.4, 16.6, 16.7
    - **Property 49: Banned claims are scrubbed from free text** — Validates: Requirements 16.8, 18.9, 19.6, 20.9, 23.10, 23.18
    - **Property 50: The guard can never publish or exceed schema bounds** — Validates: Requirements 14.10, 14.11, 16.10, 16.11

  - [x] 11.4 Build the AI assistant UI
    - Create `src/pages/admin/ai-assistant.astro` + `src/components/admin/AiAssistant.tsx`: an admin-facts form (notes plus the factual fields), image selection, a Generate action, then every suggested value pre-filled into the product form and fully editable
    - Render an "AI suggestion" chip on each `source: 'ai'` field that disappears on edit, flipping that field's provenance to `admin` and recording the field path in `product.aiFields`; list every warning the guard returned, including each blanked field and each scrubbed claim
    - Every AI-assisted product is created as `DRAFT` with `aiAssisted: true` through the normal create endpoint; on failure the form stays fully usable with "Suggestions unavailable, continue manually"
    - _Requirements: 16.3, 16.4, 16.5, 16.8, 16.12, 14.11, 26.7_
    - _Design: AI Product Assistant → Fact / suggestion separation, Failure handling_

- [x] 12. Checkpoint — admin complete
  - Exercise categories, reviews, leads, settings, homepage, analytics, and the AI assistant against local bindings. Ensure all tests pass, ask the user if questions arise.


### Phase D — Public site (sequencing priorities 2–4: Catalogue, Product Detail, Conversion)

- [x] 13. Build the public shell: conversion controls, layout, header, footer, mobile nav, action bar
  - [x] 13.1 Build the WhatsApp and Call link components
    - Create `src/components/ui/WhatsAppLink.astro` and `src/components/ui/CallLink.astro` wrapping `buildWhatsAppUrl`/`buildTelUrl` from 3.3, taking an `EnquiryContext` and rendering a real `<a>` with the destination in `href`, `target="_blank" rel="noopener"` for WhatsApp — so long-press, middle-click, copy-link, and open-in-new-tab all resolve to the same destination
    - Create `src/components/ui/ContactNumbers.astro` rendering both numbers from settings with identical label text stating both are for orders and enquiries, never characterising either as a different department, function, or team
    - Activating either control must not change scroll position, active filters, search text, or gallery position; targets are ≥ 44 px in each dimension
    - _Requirements: 5.9, 5.10, 5.11, 5.12, 5.13, 24.3_
    - _Design: Conversion → Message and URL construction_

  - [x] 13.2 Build the base layout, header with the brand-mark fallback, and footer
    - Create `src/layouts/BaseLayout.astro` with semantic landmarks, exactly one `h1` slot per page, the skip-to-content link as the first focusable element, `tokens.css`/`global.css`, font preload for the display face, and the page-bottom spacing reservation the mobile action bar needs
    - Create `src/components/ui/BrandMark.astro`: when `settings.logo.src` is `null` it renders the typographic wordmark fallback — "NEW GALAXY FURNITURE" in the display serif, letterspaced small caps with a champagne hairline rule — and when the setting is set it renders that asset instead. **This is the one swap-in point; the real logo asset does not exist yet, so implement the fallback path and the settings-driven swap and do not block on or invent an asset.**
    - Create `src/components/ui/SiteHeader.astro`: desktop (≥1024 px) shows the brand mark plus exactly the nine destinations Sofas, Beds, Dining, Chairs, Tables, Storage, Custom Furniture, Collection, Contact with Dining/Chairs/Tables opening a two-column dropdown, plus the search trigger and the WhatsApp CTA; transparent over the hero at the top of the homepage and transitioning to solid obsidian on scroll by changing background and opacity only
    - Create `src/components/ui/SiteFooter.astro` with the same category destinations, both business numbers, the supporting pages, non-null social links only, and the visitor-facing reduce-motion toggle persisted to `localStorage`
    - _Requirements: 9.1, 9.2, 9.3, 9.7, 19.4, 19.5, 19.6, 21.13, 24.4, 24.12_
    - _Design: Pages, Navigation, and States → Navigation; Open Items item 1_

  - [x] 13.3 Build the mobile navigation panel
    - Create `src/components/ui/MobileNav.tsx` (`client:idle`): header below 1024 px shows the brand mark, a search control, a menu control, and a persistent enquiry affordance
    - Opening the menu renders a full-height panel, confines keyboard focus to it, and locks body scroll; `Escape` closes it and returns focus to the control that opened it; every target is ≥ 44 px
    - _Requirements: 9.4, 9.5, 9.6, 24.3, 24.5, 24.7_
    - _Design: Pages, Navigation, and States → Navigation_

  - [x] 13.4 Build the sticky mobile action bar
    - Create `src/components/ui/MobileActionBar.tsx` (`client:idle`): displayed only below 768 px, 56 px tall with `env(safe-area-inset-bottom)` padding, offering exactly two controls labelled for WhatsApp and Call
    - Hides within 300 ms after 24 px of cumulative downward scroll, restores within 300 ms after 24 px upward, and is always shown within 24 px of the top of the page regardless of the last scroll direction; under reduced motion it hides and restores with no transition and stays operable in both states
    - Reserve at least 56 px plus the safe-area inset of page bottom spacing in `BaseLayout` so the footer is never obscured at any scroll position
    - _Requirements: 5.14, 5.15, 5.16, 5.17, 5.18, 5.19_
    - _Design: Pages, Navigation, and States → Navigation_

- [x] 14. Build the catalogue: cards, routes, search index, filter/sort engine, and the search UI
  - [x] 14.1 Build the product card
    - Create `src/components/product/ProductCard.astro` rendering the primary image through `ResponsiveImage`, the name, the price via `formatINR` or the "Price on enquiry" label, a stock status label for the product's `Stock_Status`, exactly one category or tag label, and a Quick Enquire control
    - The whole card is a link to `/product/{slug}` operable by pointer and by keyboard; Quick Enquire is a separate ≥ 44 px target that stops propagation and opens the product enquiry affordance without navigating away or discarding scroll position or listing state
    - Hover (≥768 px with hover capability) raises the card 2 px, cross-fades to the second image where one exists, and reveals the directional arrow; leaving hover restores all three. On no-hover devices the second image is never requested. Under reduced motion both states render with no animated transition and stay fully readable and operable
    - The media slot renders the LQIP or a designed placeholder with the alt text until load and on load failure, so it never paints empty
    - _Requirements: 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 1.11, 1.12, 1.13, 1.14, 15.17, 15.18, 24.3_
    - _Design: Catalogue → Product cards, PDP, and related products; Image Pipeline → Delivery budget_

  - [x] 14.2 Build `/collection`, the nine category routes, and their empty and not-found states
    - Create `src/pages/collection/index.astro` listing every Catalogue product (including `OUT_OF_STOCK`) and `src/pages/collection/[category].astro` with `getStaticPaths` over the published categories, presenting every Catalogue product assigned to that category — a product in more than one category appears on each
    - An unmatched `/collection/{slug}` renders a not-found state stating the category does not exist and offering search plus links to the nine category routes, never an empty listing
    - **`data/products/` is empty at this point, so the designed empty state is the normal rendering path**: a composed empty state offering search and other categories, with correct product counts (drafts and unpublished excluded from every count). Eager-load only the first six card images; lazy-load the rest with `content-visibility: auto` on rows
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.15, 1.16, 15.17, 22.10, 26.14_
    - _Design: Catalogue; Error Handling → Empty states; Open Items item 5_

  - [x] 14.3 Build the search index generation with its size budget
    - Create `src/lib/search/build-index.ts` emitting the compact `SearchDoc` array (short keys `i,n,k,c,s,m,o,t,p,st,f,ts,th,lq`) for every Catalogue product, written to a hashed static asset at build time
    - Add a build-time assertion that fails the build when the Brotli-compressed index exceeds 60 KB, and keep the index out of every page's initial payload
    - _Requirements: 22.7, 22.8, 22.14_
    - _Design: Catalogue → Client-side, with a measured budget and a defined escape hatch_

  - [x] 14.4 Implement the filter and sort engine with URL serialization
    - Create `src/lib/search/filter.ts` with `FilterState`, `filter(docs, state)` (OR within a dimension, AND across dimensions, unconstrained dimensions impose nothing, order-preserving), `facetCounts(docs, state)` recomputing each option's count as the number of products that would be returned if that option were selected alongside the currently active selections in every other dimension, and the five exact price bands and three availability options with `any` as the default
    - Create `src/lib/search/sort.ts` with the six `SortKey`s, a total-order comparator per key breaking every tie on ascending slug, `priceOnEnquiry` products tailing both price directions, and `RankingSource` resolution: measured from `data/snapshots/analytics.json` with its `asOf` date, falling back to `data/site/rankings.json` as `manual` while retaining the visitor's selected sort; `bestSelling` is always `manual`
    - Create `src/lib/search/url.ts` with `serializeFilters(state)`/`parseFilters(search)` round-tripping exactly, ignoring only unrecognised, malformed, or absent-value parameters and rewriting the query string to the state actually applied; the neutral state applies no filters and the Newest sort
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.7, 3.9, 3.10, 3.11, 3.12, 3.13, 3.14, 3.15, 3.16, 3.18, 3.19_
    - _Design: Catalogue → Filters, Sorting with honest fallbacks_

  - [x]* 14.5 Write property tests for the filter and sort engine
    - `tests/property/filter-sort.property.test.ts`
    - **Property 31: Filtering is an order-preserving subsequence** — Validates: Requirements 1.3, 3.4
    - **Property 32: Sorting is a permutation** — Validates: Requirements 3.10, 3.12
    - **Property 33: Sorting is idempotent and stable** — Validates: Requirements 3.12
    - **Property 34: Every comparator is a total order** — Validates: Requirements 3.12
    - **Property 35: Price sort orders prices and tails price-on-enquiry** — Validates: Requirements 3.9, 3.11
    - **Property 36: Filtering never grows the set, and the neutral state is the identity** — Validates: Requirements 3.4, 3.7, 3.9
    - **Property 37: Adding a constraint is monotone** — Validates: Requirements 1.3, 3.4
    - **Property 38: Filter state round-trips through the URL** — Validates: Requirements 3.5, 3.6

  - [x] 14.6 Build the filter and sort UI
    - Create `src/components/product/FilterPanel.tsx` (`client:visible`) presenting all seven dimensions simultaneously with per-option result counts, zero-count options rendered disabled showing `0` and rejecting selection, and a sidebar layout at ≥768 px that becomes a bottom sheet below 768 px with focus trapping and `Escape` to close
    - Create `src/components/product/SortControl.tsx` offering exactly the six options, labelling curated options ("Best Selling (curated)") with no measurement date and measured options with their snapshot date
    - Results and counts update within 300 ms of a selection with the full state reflected in the URL query string and no page reload; `popstate` restores the state recorded for the target history entry; the no-match state shows a message and a single control that clears every filter parameter while retaining the sort
    - _Requirements: 3.1, 3.5, 3.6, 3.7, 3.8, 3.13, 3.14, 3.15, 3.16, 3.17, 3.20, 24.2, 24.5, 24.7_
    - _Design: Catalogue → Filters, Sorting with honest fallbacks; Responsive strategy_

  - [x] 14.7 Build the search UI with live suggestions
    - Create `src/lib/search/query.ts` configuring MiniSearch over `n,k,m,o,t,c,s` with the design's boosts, prefix matching on, fuzzy `0.2` enabled only for terms of four or more characters, and exact-and-prefix case-folded SKU matching; export `suggest(q, limit = 8)`
    - Create `src/components/ui/SearchBox.tsx` (`client:idle`) in the header of every public page with the placeholder "Search by name, SKU, material, colour...", reachable by tab order without opening any menu; the index loads on first search intent, not on page load
    - Suggestions are debounced 120 ms, show at most eight ordered products → categories → filters, discard superseded query results, and are keyboard operable (`ArrowUp`/`ArrowDown`/`Enter`/`Escape` retaining text and focus) with `role="combobox"`/`role="listbox"`, `aria-activedescendant`, and a polite live region announcing result counts
    - Empty focus shows up to five recent searches from `localStorage` (at most five distinct entries, most recent first); a no-match query shows the three nearest matches plus category shortcuts; when the index cannot load, the typed text is retained with a "search temporarily unavailable" message and category navigation
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11, 2.12, 2.13, 2.14, 22.8, 24.11_
    - _Design: Catalogue → Matching_

  - [x]* 14.8 Write property tests for search ranking
    - `tests/property/search.property.test.ts`
    - **Property 39: Exact SKU search ranks its product first** — Validates: Requirements 2.2, 2.5, 2.6

- [x] 15. Build the product detail page
  - [x] 15.1 Implement the related products engine
    - Create `src/lib/products/related.ts` with `relatedProducts(target, all, limit = 8)`: operator-specified `relatedProductIds` first in the operator's own order, then scored by same subcategory +5, same category +4, shared tag +2 each capped at +6, same material +2, price within ±35% +2, shared colour +1, excluding zero-scoring candidates, excluding the target, restricted to Catalogue products, ties broken on slug — fully deterministic and never time-varying
    - _Requirements: 4.7, 4.8, 4.9_
    - _Design: Catalogue → Product cards, PDP, and related products_

  - [x]* 15.2 Write property tests for related products
    - `tests/property/related.property.test.ts`
    - **Property 40: Related products are relevant, deduplicated, and bounded** — Validates: Requirements 4.7, 4.8, 4.9
    - **Property 41: Related products are deterministic** — Validates: Requirements 4.7

  - [x] 15.3 Build the responsive gallery
    - Create `src/components/product/Gallery.tsx` (`client:visible`): at ≥1024 px a large primary image with a thumbnail rail marking the current thumbnail and swapping the primary on activation without navigation; from 768–1023 px a single primary image with position indicators and pointer- and touch-operable previous/next controls; below 768 px a swipeable sequence with position indicators and ≥44 px touch controls
    - Zoom/fullscreen loads the largest available derivative via dynamic import, traps focus, and returns focus to the opening control on `Escape` or close; keyboard within the gallery moves on `ArrowLeft`/`ArrowRight` with no action at either end, opens zoom on `Enter`/`Space`, and exposes the displayed position and total count to assistive technology
    - A single-image product renders that image alone with no rail, indicators, or previous/next controls, keeping zoom operable; a failed image renders the styled alt-text fallback inside its reserved slot without shifting layout while the remaining images stay navigable; under reduced motion image changes have no transition
    - _Requirements: 4.4, 4.5, 4.6, 4.14, 4.15, 4.16, 4.17, 4.18, 24.3, 24.5, 24.7_
    - _Design: Catalogue → Product cards, PDP; Image Pipeline → Delivery budget_

  - [x] 15.4 Build the product detail route and its content blocks
    - Create `src/pages/product/[slug].astro` with `getStaticPaths` over the Catalogue so every `PUBLISHED`/`OUT_OF_STOCK` product gets a page automatically with no manual authoring, plus `src/components/product/{Breadcrumbs,PriceBlock,StockBadge,SpecList,VariantList,RelatedProducts}.astro`
    - Render the breadcrumb trail from the catalogue root through the category to the product name, then name, SKU, price or "Price on enquiry", stock status, gallery, description, material, dimensions, colour, available colours, variants, customization, delivery information, made-to-order information, the WhatsApp enquiry control, the Call control, related products, and recently viewed
    - A field with no value omits its whole display block — never an empty label or a placeholder value; a related-products set with no members omits the section entirely
    - `OUT_OF_STOCK` products keep a 200 response with the stock status shown as out of stock and both conversion controls present as an availability enquiry, never removed, hidden, or disabled; an unknown slug returns a real 404 offering the relevant category and search, never a redirect and never a soft 404
    - The primary image is the only eager image, `fetchpriority="high"` and preloaded
    - _Requirements: 4.1, 4.2, 4.3, 4.9, 4.12, 4.13, 5.20, 15.17, 22.10, 26.1_
    - _Design: Catalogue → Product cards, PDP, and related products; Architecture → Request / Render Path_

  - [x] 15.5 Implement recently viewed
    - Create `src/components/product/RecentlyViewed.tsx` (`client:idle`) with a `localStorage` ring buffer of at most eight `{slug, ts}` entries written on PDP view, moving an existing entry to the most recent position rather than duplicating it and discarding the oldest beyond eight — no account, no cookie, no server-side visitor record
    - Renders most recent first excluding the current product, and omits the section entirely when it holds fewer than two other products or the device retains no list
    - _Requirements: 4.10, 4.11_
    - _Design: Catalogue → Product cards, PDP, and related products_

- [x] 16. Build the homepage, supporting pages, policy pages, and the 404
  - [x] 16.1 Build the fifteen homepage sections
    - Create `src/pages/index.astro` and `src/components/home/*.astro` rendering exactly the fifteen sections in the required order — animated hero, shop by category, featured products, new arrivals, best sellers, trending, craftsmanship, direct manufacturer, custom furniture, showroom and workshop story, customer reviews, gallery, WhatsApp call-to-action, contact and location, footer — preserving that relative order whenever a section is omitted, with presence and copy read from `data/site/homepage.json`
    - The hero carries the brand mark, the settings-sourced positioning line, and exactly the three CTAs Explore Collection / Order or Enquire on WhatsApp / Call Now, each ≥44 px, with no fourth CTA; exactly one responsive optimised image is the largest content element with intrinsic dimensions emitted and its LQIP rendered at final layout dimensions until load, introducing no layout shift; **no background video anywhere**
    - Featured, new arrivals, best sellers, and trending each use a different composition (large-left editorial pair, horizontal scroll rail, asymmetric 2-up, numbered editorial list) so no two share the same combination of items-per-row at 1280 px, aspect ratio, and scroll axis; any of the four resolving to zero Catalogue products omits its heading, container, and controls with no residual vertical gap and no substituted products
    - Craftsmanship, direct-manufacturer, and showroom/workshop sections render their unsupplied copy as a visually distinguished placeholder labelled as awaiting content, add that key to the admin content checklist, and state no manufacturing process, timeline, capability, or achievement the operator has not supplied
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.9, 7.10, 7.12, 7.13, 8.6, 24.3_
    - _Design: Pages, Navigation, and States → Homepage composition; Visual Design System → Layout language_

  - [x] 16.2 Build the supporting public pages
    - Create `src/pages/{custom-furniture,about,workshop,gallery,reviews,contact,faq}.astro` using the shared layout, editorial composition, and both conversion controls
    - `/contact` renders the business location details, both numbers, and the map link only where settings supply each one; `/reviews` and the homepage reviews section render only reviews whose status is published; `/custom-furniture` carries the Custom Furniture Enquiry form slot (wired in 18.3) and both conversion controls
    - `/about` and `/workshop` carry the genuine Bengaluru-manufacturer / Karnataka-service location content with no invented business facts
    - _Requirements: 8.1, 8.5, 8.6, 8.7, 19.6, 23.17_
    - _Design: Pages, Navigation, and States → Route inventory; SEO → Local SEO content strategy_

  - [x] 16.3 Build the policy pages as structured placeholders
    - Create `src/pages/{privacy,terms,shipping,returns,warranty}.astro`, each professionally structured with a visible notice that the policy is being finalised and directing the visitor to contact the business for current terms, plus an inline `[FOR BUSINESS REVIEW]` source marker
    - State no delivery timeframe, return window, cancellation term, or warranty term the operator has not supplied; register each unfinished page's content key in `SiteSettings.placeholders`
    - _Requirements: 8.2, 8.3, 8.4, 8.8_
    - _Design: Open Items item 3_

  - [x] 16.4 Build the 404 page and the loading/empty state primitives
    - Create `src/pages/404.astro` offering the relevant category, search, and a WhatsApp enquiry
    - Create `src/components/ui/{EmptyState,Skeleton}.astro`: content-shaped skeletons with a shimmer suppressed under reduced motion, and a composed empty state taking an illustration slot, a message, and a next action — used by the no-products, no-search-results, no-filter-matches, no-reviews, no-leads, no-images, and no-analytics states
    - _Requirements: 26.1, 26.12, 26.13, 26.14_
    - _Design: Error Handling → Loading states, Empty states_

- [x] 17. Checkpoint — public site renders end to end
  - Build and preview the site with zero products, confirming every catalogue and homepage surface renders its designed empty state. Ensure all tests pass, ask the user if questions arise.


### Phase E — Conversion, motion, SEO, performance, hardening (sequencing priorities 5–10)

- [ ] 18. Build lead capture, the enquiry forms, and the analytics event pipeline
  - [x] 18.1 Implement the lead submission endpoint
    - Create `src/schemas/lead.ts` with `LeadSchema` exactly as the design defines it (typed enquiry kind, name 2–80, phone through `normalizeIndianPhone` refined to E.164, message, optional `productSlug`, `budget` ≤ 100, `dimensions` ≤ 200, `requirement` ≤ 500, `honeypot` must be empty, `renderedAt`) and `src/pages/api/leads.ts`
    - Enforce, in order: honeypot and a minimum 1.5 s form age returning one identical generic rejection for both cases; 5 submissions per rolling 60 minutes per client address with a message stating the whole number of minutes remaining; Zod validation returning field-level messages naming each failing field while retaining every other value; server-side resolution of `productSlug` to the product's name, SKU, and canonical URL (browser-supplied product values are never trusted), rejecting a slug that resolves to no `PUBLISHED`/`OUT_OF_STOCK` product with a message and a control leading to the Catalogue
    - Store exactly one lead with status `NEW`, the server-clock timestamp, and the originating page path; confirm receipt within 3 seconds; a submission matching another spam heuristic is stored with a spam indicator rather than discarded; a storage failure reports that the enquiry was not recorded and presents both numbers' WhatsApp and Call controls as the direct alternative while retaining every entered value except the image
    - Optional enquiry images run through the same `validateUpload` checks into a quarantined R2 prefix, are never served publicly, and a rejection names the image field and the specific limit while retaining every other value
    - _Requirements: 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 6.11, 6.17, 6.18, 6.19, 25.1, 25.6, 25.7, 26.10_
    - _Design: Conversion → Lead capture_

  - [x]* 18.2 Write property tests for the spam traps
    - `tests/property/lead.property.test.ts`
    - **Property 43: Spam traps reject bot submissions** — Validates: Requirements 6.8

  - [x] 18.3 Build the five enquiry forms
    - Create `src/components/forms/{QuickEnquire,CallbackForm,QuoteForm,CustomFurnitureForm,ContactForm}.tsx` plus a shared `EnquiryForm` base handling the honeypot, `renderedAt`, submission state, and error mapping
    - Quick Enquire opens from a product card or PDP without navigating away and carries the product reference; the Custom Furniture form collects name, phone, requirement, approximate budget, dimensions, message, and one optional image
    - Every control is labelled, every validation message is associated with its control and announced, failing controls are marked invalid for assistive technology, and nothing else entered is cleared; a network failure retains every value and offers both a retry and the WhatsApp/Call alternative
    - Wire the forms into `/contact`, `/custom-furniture`, the PDP, and the product cards
    - _Requirements: 6.1, 6.2, 6.3, 24.8, 24.9, 26.2, 26.9_
    - _Design: Conversion → Lead capture_

  - [x] 18.4 Implement the analytics event pipeline
    - Create `src/lib/analytics/client.ts` batching the eight event types, flushing with `navigator.sendBeacon` on `visibilitychange` or after five events, and emit events from the product view, category view, WhatsApp click, call click, search, enquiry submit, quick-enquire open, and gallery open surfaces
    - Create `src/pages/api/events.ts` validating each batch (max 20 events, known types, entity length ≤ 120, timestamps within ±10 minutes of server time), applying the 200/minute per-address limit, dropping obvious bot traffic, and upserting daily aggregates into `event_daily` and `search_queries` — storing no per-visitor identifier, cookie id, fingerprint, or retained client address
    - Wire measured view counts into the Most Viewed sort's snapshot input
    - _Requirements: 20.1, 20.2, 20.3, 20.4, 20.11, 25.8_
    - _Design: Conversion → Analytics_

  - [x]* 18.5 Add the nightly analytics snapshot cron (optional — Most Viewed falls back to the curated ordering without it)
    - Add a scheduled Worker handler exporting the D1 rollups to `data/snapshots/analytics.json` and committing with `[skip ci]` so the next build picks up fresh Most Viewed data with no extra deploy
    - _Requirements: 20.11, 3.14, 3.15_
    - _Design: Conversion → Analytics_

- [x] 19. Build the motion system (sequencing priorities 5 and 6: Premium UI/UX and Major 2D Animation)
  - [x] 19.1 Implement the motion trigger tier and reduced-motion gating
    - Create `src/lib/motion/useReveal.ts` and `src/lib/motion/useScrollProgress.ts` implementing the three tiers: a `@supports (animation-timeline: view())` CSS-only path in `src/styles/motion.css`, a single shared `IntersectionObserver` fallback setting `data-revealed` and unobserving after reveal, and `requestAnimationFrame` only for the hero parallax and the before/after slider
    - rAF loops run only while their element intersects and cancel on `visibilitychange`; `will-change` is set on trigger and removed on completion; `motionOK` from `matchMedia('(prefers-reduced-motion: no-preference)')` with a `change` listener gates the JS tier, ORed with the visitor's footer toggle from 13.2
    - Under reduced motion, hooks return early and never start, parallax planes flatten to neutral, continuous animations are removed, and focus rings, menu open/close, gallery changes, and loading indication stay at `--dur-fast`
    - _Requirements: 21.7, 21.8, 21.10, 21.11, 21.12, 21.13, 26.13_
    - _Design: Motion System → Trigger mechanism, Reduced motion_

  - [x] 19.2 Build the nine animated SVG primitives
    - Create `src/components/motion/{AnimatedFurnitureLine,AnimatedChair,AnimatedSofa,AnimatedBed,AnimatedTable,AnimatedRoom,CraftsmanshipLines,FurnitureAssembly,CategoryIllustration}.astro` sharing the `MotionPrimitiveProps` contract, hand-authored inline SVG with `currentColor` strokes, no raster asset and no external animation runtime
    - Each implements its signature motion from the design's component table using only `stroke-dasharray`/`stroke-dashoffset`, `transform`, `opacity`, and `clip-path`; `CategoryIllustration` dispatches on the category schema's `illustration` key
    - Decorative instances are `aria-hidden`; meaningful instances take a `<title>`; under reduced motion each renders its final drawn state immediately with nothing left invisible or half-drawn
    - _Requirements: 21.5, 21.8, 21.11, 24.10_
    - _Design: Motion System → The animated 2D component set_

  - [x] 19.3 Apply the motion system across the public surfaces
    - Wire the hero's layered `AnimatedRoom` + `CraftsmanshipLines` assembly across at most three parallax depth planes animating only transform and opacity, holding all planes neutral for the whole visit under reduced motion while the brand mark, positioning line, and all three CTAs stay visible and operable
    - Add scroll-triggered section and product reveals, per-line text reveals via `clip-path` with CSS `@property`, image mask reveals, section transitions, hover micro-interactions, the shared `ArrowMotion` component, decorative hairline rules scaling from 0 on X, subtle continuous drift, scroll-linked transforms, and the before/after room comparison slider (draggable `clip-path` divider, fully functional with no easing under reduced motion)
    - Enforce the champagne-gold usage rule while applying accents: at most one gold element per viewport height of scroll, never a large fill and never body text
    - _Requirements: 21.2, 21.6, 21.8, 21.11, 7.6, 7.11_
    - _Design: Motion System → The animated 2D component set; Visual Design System → Palette tokens_

  - [x] 19.4 Enforce the motion budgets in the build
    - Add `size-limit` entries capping motion-related client script at 14 KB Brotli and a build-time assertion capping combined inline illustration markup at 18 KB with at most four primitives per page
    - Add a dev-mode assertion that no public page animates more than 12 elements simultaneously (staggered groups sharing a parent animation count as one) and a lint rule rejecting animation of `width`, `height`, `top`, `left`, `margin`, `filter`, or `box-shadow`
    - Verify no animation gates the largest content element: the hero LCP image's reveal is a `clip-path` wipe starting at frame one
    - _Requirements: 21.8, 21.9, 21.14, 21.15, 22.14_
    - _Design: Motion System → Keeping motion inside the budget_

  - [x]* 19.5 Write the motion performance trace test
    - `tests/e2e/motion-trace.spec.ts`: trace a homepage scroll asserting no long task exceeds 120 ms and no layout-shift event is attributable to a motion element; assert no rAF loop runs while its target is off-screen or the tab is hidden
    - _Requirements: 21.9, 21.10, 22.1_

- [x] 20. Implement SEO metadata, structured data, sitemap, and robots
  - [x] 20.1 Implement the single metadata builder and apply it to every route
    - Create `src/lib/seo/meta.ts` with `PageMeta`, `PageMetaInput`, and `buildPageMeta(input, site)` as the only path by which any page emits metadata: unique title ≤ 60 chars, unique description ≤ 155 chars, absolute canonical derived solely from `PUBLIC_SITE_URL`, social preview metadata (type, title, description, image, `summary_large_image`), and per-page robots
    - Product fallbacks: `seoTitle` → `` `${name} — ${category} | ${titleSuffix}` ``; `seoDescription` → `shortDescription` → the description truncated at a word boundary. Admin and preview routes emit `noindex, nofollow`
    - Apply `buildPageMeta` on every public route created in tasks 14–16; no hostname appears anywhere in `src/`
    - _Requirements: 23.1, 23.2, 23.3, 23.4, 23.5, 23.6, 23.15, 23.18_
    - _Design: SEO and Structured Data → Metadata_

  - [x] 20.2 Implement the JSON-LD generators
    - Create `src/lib/seo/jsonld.ts` with typed generators for Product (name, SKU, absolute image URLs, description, brand, material, colour, `offers` with INR price and availability mapped from `stockStatus`, omitting the whole `offers` block for `priceOnEnquiry` products), BreadcrumbList matching the visible trail exactly, LocalBusiness/`FurnitureStore` emitting only operator-supplied fields and omitting `openingHours`, `priceRange`, `foundingDate`, and `geo` until supplied, SearchAction on the homepage pointing at `/collection?q={query}`, and ItemList on category pages
    - Emit `aggregateRating` only where published reviews are linked to that specific product
    - _Requirements: 23.7, 23.8, 23.9, 23.10, 23.11, 18.10, 19.6, 23.18_
    - _Design: SEO and Structured Data → Structured data_

  - [x] 20.3 Generate the sitemap, robots, and redirects
    - Create `src/pages/sitemap.xml.ts` listing every public static page, every Catalogue product, and every published category with `lastmod` from `updatedAt`, excluding every draft, preview, and admin page
    - Create `src/pages/robots.txt.ts` disallowing `/admin`, `/api`, and `/img/*/*-2000.*` and referencing the sitemap
    - Add trailing-slash normalisation to the canonical form with a 301 in `src/middleware.ts`, and generate 301s from `data/site/redirects.json` for renamed slugs
    - _Requirements: 23.12, 23.13, 23.14, 23.15, 23.16, 12.11_
    - _Design: SEO and Structured Data → URLs, sitemap, robots_

  - [x] 20.4 Add the local SEO content and the keyword density lint
    - Add the genuine location content to the category page intros, `/about`, `/workshop`, and `/contact` — Bengaluru manufacturer serving Karnataka — with at most one natural placement of any target phrase per page
    - Create `scripts/lint-keyword-density.ts` flagging any built page whose single target phrase density exceeds 2%, and wire it into the `lint` script
    - _Requirements: 23.17_
    - _Design: SEO and Structured Data → Local SEO content strategy_

  - [x]* 20.5 Write unit tests for the SEO layer
    - `tests/unit/seo.meta.test.ts`: title/description length bounds, canonical absoluteness, product title and description fallback chains, and an assertion that no hard-coded hostname exists anywhere under `src/`
    - `tests/unit/seo.jsonld.test.ts`: required properties per generator, `offers` omitted for price-on-enquiry, null LocalBusiness fields omitted, breadcrumbs matching the visible trail
    - _Requirements: 23.1, 23.2, 23.3, 23.5, 23.6, 23.7, 23.8, 23.9, 23.10_

- [ ] 21. Enforce performance budgets and harden security
  - [x] 21.1 Configure the asset budgets and verify the image loading strategy
    - Fill in the `size-limit` config with every row of the design's asset budget table: JS 45/70/55/20/220 KB, CSS 24/24/24/20/40 KB, search index 60 KB, fonts 55 KB, and the per-route total initial transfer caps of 320/320/340/160 KB — exceeding any budget fails the build
    - Audit and correct route-level code splitting and dynamic imports for the gallery lightbox, before/after slider, search index, and every admin view; confirm `client:visible`/`client:idle` on every island, that no marketing component hydrates eagerly, that at most one image per page is preloaded, that no card receives a full-resolution image, and that no page exceeds 1,500 DOM nodes
    - Confirm zero third-party scripts on any public critical path
    - _Requirements: 22.4, 22.5, 22.6, 22.7, 22.9, 22.10, 22.11, 22.12, 22.13, 22.14_
    - _Design: Performance Budgets → Asset budgets, Techniques_

  - [x] 21.2 Wire Lighthouse CI against the Core Web Vitals table
    - Add `lighthouserc.json` asserting mobile Performance ≥ 95, Accessibility 100, SEO 100, Best Practices ≥ 95, and the hard-fail thresholds LCP > 2.5 s, INP > 200 ms, CLS > 0.05, TBT > 250 ms across the homepage, `/collection`, a product detail page, and a static content page; wire it into CI after the build
    - _Requirements: 22.1, 22.2, 22.3, 22.14_
    - _Design: Performance Budgets → Core Web Vitals targets_

  - [x] 21.3 Emit the security headers and content security policy
    - Add to `src/middleware.ts` (and the static asset header config) `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`, a `Permissions-Policy` denying camera, microphone, and geolocation, and the design's exact CSP including `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`, and `form-action 'self'`
    - Ensure no inline script execution anywhere so `script-src 'self'` holds with no nonce or hash exemption
    - _Requirements: 25.9, 25.10_
    - _Design: Deployment_

  - [x] 21.4 Implement output sanitization and parameterised queries
    - Create `src/lib/security/sanitize.ts` escaping or removing markup from every visitor- or operator-supplied value before it is rendered, such that no output carries `<script`, an event-handler attribute, or a `javascript:` URL; apply it in the product card, PDP, review, homepage copy, and lead-detail templates
    - Audit every D1 access to use bound parameters only, with no query built from unvalidated input
    - _Requirements: 25.2, 25.3, 16.10_
    - _Design: Error Handling → Disclosure policy; Correctness Properties → Property 55_

  - [x]* 21.5 Write property tests for output sanitization
    - `tests/property/sanitize.property.test.ts`
    - **Property 55: Rendered user input contains no executable markup** — Validates: Requirements 16.10, 25.2

  - [x] 21.6 Implement the error disclosure mapper and sweep the loading and empty states
    - Create `src/lib/errors.ts` with the `{ error, message, fields? }` envelope, the stable error code union, and `toClientError(unknown)` guaranteeing no stack trace, file path, internal identifier, upstream provider body, or credential ever crosses the boundary, while `logServerError` records full detail with credentials redacted
    - Apply the envelope to every API route from tasks 5–11 and 18, and verify every row of the design's failure-mode table renders its specified message and recovery path
    - Sweep the public and admin surfaces so every loading state uses a content-shaped skeleton (never a blank page, never animated under reduced motion) and every listed empty state uses the composed `EmptyState` component with a next action
    - _Requirements: 25.14, 25.15, 26.2, 26.4, 26.5, 26.6, 26.7, 26.8, 26.9, 26.10, 26.12, 26.13, 26.14, 26.15_
    - _Design: Error Handling → Disclosure policy, Failure modes, Loading states, Empty states_

- [ ] 22. Build the developer product-addition workflow and the project documentation
  - [x] 22.1 Implement the `product:add` CLI
    - Create `scripts/add-product.ts` accepting `--name`, `--category`, `--price`, `--material`, `--dimensions`, `--colors`, `--images`, `--status`, and reusing the exact same `toSlug`/`uniqueSlug`/`generateSku`, upload validation, derivative generation, SEO fallback, and schema code paths the admin uses, so all three creation routes produce byte-compatible files
    - Verify the category file exists, failing with the list of valid slugs and creating no category; generate a unique slug and SKU; process images through the same validation and derivative pipeline capturing intrinsic dimensions; generate SEO title and description where not supplied; validate against `ProductSchema` and additionally `PublishReadySchema` when a published status is requested; assert the product's WhatsApp URL builds and decodes back to the intended message; write exactly one file at `data/products/{slug}.json` and no application source file; print the diff
    - Any validation failure writes no file and reports the failing field
    - _Requirements: 27.1, 27.2, 27.3, 27.4, 27.5, 27.6, 27.7, 27.8, 27.9, 27.10, 27.11_
    - _Design: Kiro / Developer Product Workflow_

  - [x]* 22.2 Write tests for the CLI
    - `tests/unit/add-product.test.ts`: an unknown category fails listing the valid slugs and writes nothing; a successful run writes exactly one file under `data/products/` and no source file; `--status PUBLISHED` with no image fails the publish gate naming `images`; the produced file byte-matches the admin creator's output for the same input
    - _Requirements: 27.2, 27.3, 27.6, 27.9, 27.11_

  - [x] 22.3 Write the project documentation
    - Create `README.md` covering setup, local development, every environment variable and how to set it as a secret, the `/data` content structure, the admin workflow, the product lifecycle and publish gate, the deployment pipeline and its gate order, the Cloudflare binding and D1 migration steps, the admin seeding command, and the operator checklist of outstanding content (logo asset, address and hours, policy copy, social links, product data)
    - Confirm `.env.example` lists every required variable name with placeholder values only, and document that the production site URL is a single configuration change when the domain is purchased
    - _Requirements: 28.7, 28.8, 28.9_
    - _Design: Deployment; Open Items_

- [ ] 23. Run the full verification pass
  - [ ] 23.1 Run the static, unit, build, and secret-scan gates
    - Run `npm run lint`, `npm run check`, `npm run validate:content`, `npm test` (unit + all property suites), `npm run build`, `npm run size-limit`, and `npm run scan:secrets` in the CI gate order; fix every failure
    - **Property 51: No secret pattern appears in the build output** — Validates: Requirements 25.12, 25.13, 28.5, 28.6, 28.7 — assert exhaustively over every file under `dist/`, not a sample
    - _Requirements: 27.12, 28.3, 28.4, 28.6_
    - _Design: Testing Strategy → CI gates_

  - [ ] 23.2 Run the end-to-end suite
    - Create `tests/e2e/{homepage,catalogue,search,filters,pdp,conversion,admin-auth,admin-lifecycle,admin-images,admin-ai,admin-reviews,admin-leads,admin-settings}.spec.ts` covering the design's e2e inventory: homepage, catalogue, search suggestions, every filter dimension and every sort option, PDP, WhatsApp and `tel:` link destinations, enquiry submission, admin login/logout/wrong-password/unauthorized-route, the full lifecycle create → draft → edit → submit → publish → unpublish → duplicate → delete, image upload/reorder/primary/alt, AI generation, review management, lead management, and settings
    - Use only `tests/fixtures/` products — never write a demo product into `data/products/`
    - _Requirements: 12.1, 12.5, 12.7, 12.9, 14.2, 15.14, 16.3, 18.6, 6.7, 10.1, 10.2_
    - _Design: Testing Strategy → End-to-end testing_

  - [ ] 23.3 Run the responsive sweep (sequencing priority 10: mobile experience)
    - Create `tests/e2e/responsive.spec.ts` walking the full page inventory at 320, 375, 390, 414, 768, 1024, 1280, 1440, and 1920 px, asserting `scrollWidth <= clientWidth`, no overlap in any interactive region, no clipped image, and CLS under threshold
    - Assert the mobile-specific contracts: single-column editorial layout, swipeable galleries, horizontally scrolling product rails, filters in a bottom sheet below 768 px, every interactive target ≥ 44 px on touch, the action bar present below 768 px and absent at 768 px and above
    - _Requirements: 24.1, 24.2, 24.3, 5.14, 5.15_
    - _Design: Pages, Navigation, and States → Responsive strategy; Testing Strategy → Cross-cutting checklists_

  - [ ] 23.4 Run the accessibility pass
    - Create `tests/e2e/a11y.spec.ts` running axe-core on every public page and every admin page with zero violations permitted
    - Add keyboard-only walkthroughs of the search combobox, the gallery, the filter bottom sheet, the mobile menu, and every admin table; assert exactly one `h1` per page with no skipped heading levels, a visible focus indicator on every focusable element, focus confinement and restoration for every modal and panel, labelled controls with associated and announced validation messages, alt text on every product image, decorative illustrations hidden from assistive technology, the polite live region announcing suggestion counts, and the skip-to-content link as the first focusable element
    - _Requirements: 24.4, 24.5, 24.6, 24.7, 24.8, 24.9, 24.10, 24.11, 24.12, 24.13_
    - _Design: Pages, Navigation, and States → Accessibility_

  - [ ] 23.5 Run the SEO assertions
    - Create `tests/e2e/seo.spec.ts` asserting unique titles and descriptions across every page, correct absolute canonicals, present and valid Product/BreadcrumbList/LocalBusiness/SearchAction/ItemList structured data, alt text presence, a fetchable `sitemap.xml` and `robots.txt` with the required disallows, clean ID-free URLs, trailing-slash 301s, and that no draft, preview, or admin URL appears in the sitemap or is indexable
    - _Requirements: 23.1, 23.2, 23.4, 23.7, 23.9, 23.11, 23.12, 23.13, 23.14, 23.15, 23.16_
    - _Design: Testing Strategy → Cross-cutting checklists (SEO)_

  - [ ] 23.6 Run the security probes
    - Create `tests/e2e/security.spec.ts` asserting zero CSP violations on every public page and the presence of every required security header
    - Create `tests/property/admin-surface.property.test.ts` enumerating `ADMIN_ROUTES` with spies on the D1, GitHub, and R2 bindings:
    - **Property 52: Unauthenticated admin requests write nothing** — Validates: Requirements 10.1, 10.14, 25.4
    - **Property 53: Missing or wrong CSRF tokens are refused** — Validates: Requirements 10.8, 10.9, 25.4
    - Re-run the magic-byte upload rejection assertion end to end against `POST /api/admin/products/:id/images` and the public enquiry image field, confirming a disguised SVG, PHP, HTML, ELF, and ZIP payload are all rejected regardless of declared MIME or extension
    - _Requirements: 10.1, 10.8, 10.9, 15.3, 15.4, 25.4, 25.6, 25.9, 25.10_
    - _Design: Testing Strategy → Cross-cutting checklists (Security)_

- [ ] 24. Deliver the work through a pull request
  - [ ] 24.1 Create the implementation branch, review the diff, and commit
    - Create a branch (e.g. `feat/ngf-website`) off `main` — never commit directly to `main`
    - Review the complete diff for correctness and for anything that must not ship: no secret values, no real credentials in `.env.example` or `wrangler.toml`, no demo product under `data/products/`, no lead or session data, no hard-coded production hostname, no invented business fact, no committed image binary
    - Re-run `npm run scan:secrets` against the fresh build output, then stage the intended files by name and commit with a message describing the feature set
    - _Requirements: 28.5, 28.6, 28.10, 17.18, 25.12_
    - _Design: Deployment; Testing Strategy → Definition of done_

  - [ ] 24.2 Push the branch and open the pull request against `main`
    - Push the branch and open a PR against `main` via `gh api repos/{owner}/{repo}/pulls`
    - The description must cover: the delivered features (public catalogue, search/filter/sort, PDP, conversion, admin, AI assistant, motion system); the architecture (GitHub content source of truth, Cloudflare Workers runtime, build-time baking, KV drafts, D1 leads and analytics, R2 images); security (auth, sessions, CSRF, rate limits, path allowlist, upload validation, headers and CSP); performance (Core Web Vitals targets and the enforced asset budgets); testing (unit, 55 property tests, integration, e2e, responsive, a11y, SEO, security probes); and the deployment and secret-setup requirements (bindings to create, D1 migrations to apply, every secret to set with `wrangler secret put`, the admin seeding command, and `PUBLIC_SITE_URL` for the eventual domain)
    - Note the two outstanding operator inputs explicitly: the logo asset (wordmark fallback is live; swapping it in is one file plus one settings field) and real product content (the catalogue ships empty and renders its designed empty states)
    - _Requirements: 28.1, 28.2, 28.10_
    - _Design: Deployment; Open Items_

## Notes

- Sub-tasks marked `*` are optional and can be skipped for a faster MVP; every one of them is a test, a post-launch convenience, or both. The task 23 verification sub-tasks are **not** optional — they are the demanded verification pass.
- Tasks 4, 9, 12, and 17 are checkpoints: run the gates, confirm the phase works, and raise questions before continuing.
- Every property test task names the design's `### Property N` heading and the requirement criteria that property validates, so traceability runs design → property → test.
- `data/products/` stays empty for the whole build. Demo products live only in `tests/fixtures/`. Any catalogue surface that would list products must render its designed empty state instead.
- The logo asset does not exist. Task 13.2 delivers the wordmark fallback and the single settings-driven swap-in point; no task waits on the asset and no task invents a mark.
- No business fact — years in business, certifications, awards, counts, delivery times, warranty terms, or market-position claims — is ever hard-coded, generated, or inferred. Unknown facts render a marked placeholder and appear in the admin content checklist.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4"] },
    { "id": 2, "tasks": ["1.5", "1.6", "2.1"] },
    { "id": 3, "tasks": ["2.2", "2.3", "3.1", "3.3", "3.5", "3.7"] },
    { "id": 4, "tasks": ["2.4", "2.5", "3.2", "3.4", "3.6", "3.8", "3.9"] },
    { "id": 5, "tasks": ["2.6", "2.7", "3.10", "5.1", "5.2"] },
    { "id": 6, "tasks": ["2.8", "5.3", "5.4", "6.1"] },
    { "id": 7, "tasks": ["5.5", "6.2", "6.5"] },
    { "id": 8, "tasks": ["5.6", "6.3", "6.6"] },
    { "id": 9, "tasks": ["5.7", "6.4", "6.7"] },
    { "id": 10, "tasks": ["5.8", "5.9", "6.8", "8.1"] },
    { "id": 11, "tasks": ["5.10", "7.1", "8.2", "8.3"] },
    { "id": 12, "tasks": ["7.2", "7.3", "8.4", "11.1"] },
    { "id": 13, "tasks": ["7.4", "7.5", "8.5", "11.2"] },
    { "id": 14, "tasks": ["7.6", "7.7", "10.1", "11.3"] },
    { "id": 15, "tasks": ["10.2", "10.3", "10.4", "11.4"] },
    { "id": 16, "tasks": ["10.5", "13.1", "14.3"] },
    { "id": 17, "tasks": ["13.2", "14.1", "14.4"] },
    { "id": 18, "tasks": ["13.3", "13.4", "14.5", "15.1"] },
    { "id": 19, "tasks": ["14.2", "14.6", "15.2", "15.3"] },
    { "id": 20, "tasks": ["14.7", "15.4"] },
    { "id": 21, "tasks": ["14.8", "15.5", "16.2", "16.3", "16.4"] },
    { "id": 22, "tasks": ["16.1", "18.1", "19.1"] },
    { "id": 23, "tasks": ["18.2", "18.3", "18.4", "19.2"] },
    { "id": 24, "tasks": ["18.5", "19.3", "20.1"] },
    { "id": 25, "tasks": ["20.2", "20.3", "21.3"] },
    { "id": 26, "tasks": ["19.4", "19.5", "20.4", "20.5"] },
    { "id": 27, "tasks": ["21.1", "21.4", "22.1"] },
    { "id": 28, "tasks": ["21.2", "21.5", "21.6", "22.2"] },
    { "id": 29, "tasks": ["22.3", "23.1"] },
    { "id": 30, "tasks": ["23.2", "23.3", "23.4", "23.5", "23.6"] },
    { "id": 31, "tasks": ["24.1"] },
    { "id": 32, "tasks": ["24.2"] }
  ]
}
```
