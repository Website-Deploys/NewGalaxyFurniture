# New Galaxy Furniture

A premium furniture catalogue site with a GitHub-backed admin platform, built on Astro and
deployed to Cloudflare Workers.

Enquiries convert on WhatsApp and by phone — there is no cart, no checkout and no payment
processing. The catalogue is content, the content is JSON in this repository, and the
repository is the source of truth.

- [Overview](#overview)
- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Folder structure](#folder-structure)
- [Local setup](#local-setup)
- [Environment variables](#environment-variables)
- [Cloudflare setup](#cloudflare-setup)
- [Admin setup](#admin-setup)
- [AI assistant configuration](#ai-assistant-configuration)
- [GitHub integration](#github-integration)
- [Deployment](#deployment)
- [Creating a product](#creating-a-product)
- [The Kiro product workflow](#the-kiro-product-workflow)
- [Content operations](#content-operations)
  - [Adding a category](#adding-a-category)
  - [Managing reviews](#managing-reviews)
  - [Managing leads](#managing-leads)
  - [Changing the WhatsApp and phone numbers](#changing-the-whatsapp-and-phone-numbers)
  - [Configuring the domain](#configuring-the-domain)
- [Security](#security)
- [Testing](#testing)
- [What is not supplied](#what-is-not-supplied)
- [Troubleshooting](#troubleshooting)

---

## Overview

The site has two halves.

**The public catalogue** is prerendered. Products, categories, reviews and site copy are read
from `data/**` at build time and baked into HTML and into a client-side search index, so a
visitor's request costs no database read and no API call. Nine categories are seeded;
products arrive as content.

**The admin platform** at `/admin` runs on demand inside the Worker. An operator edits
products, categories, reviews, homepage copy and settings; every save writes a draft to KV
immediately and commits the canonical JSON to this repository through the GitHub API.
Publishing is a commit, and a Cloudflare build follows it.

Conversion is instrumented as far as it honestly can be: WhatsApp and call _clicks_ are
recorded, enquiry forms write leads to D1, and the admin analytics view states its own limits
next to its numbers.

### Publish latency: 60–150 seconds

Published content is baked at build time. A publish is therefore not visible to a visitor
until a Cloudflare build completes — **60 to 150 seconds** in practice. This is a deliberate
trade: it buys a zero-cost read path, and three things make it acceptable.

1. Publishing is deliberate and infrequent.
2. Draft iteration never waits for a build. Every admin save writes to KV, and
   `/admin/preview/{id}` renders the real customer-facing product page against that draft,
   server-side, in under a second.
3. Commits that change only draft or review content carry `[skip ci]`, so they do not
   trigger a build at all. Only publish, unpublish, delete, and category/site-config commits
   deploy.

The admin UI says "live in about a minute" after a publish rather than claiming success
immediately.

---

## Architecture

```text
     Visitor                                  Operator
        │                                        │
        │ GET /                                  │ GET /admin/**
        ▼                                        ▼
┌──────────────────────────────────────────────────────────────┐
│  Cloudflare                                                  │
│                                                              │
│  Static asset store            Worker (on demand)            │
│  prerendered HTML,             /admin/**  /api/**  /img/**    │
│  hashed JS/CSS, fonts                 │                      │
│                                       ├── KV  SESSIONS       │
│                                       ├── KV  DRAFTS         │
│                                       ├── KV  RATELIMIT      │
│                                       ├── D1  DB             │
│                                       ├── R2  MEDIA          │
│                                       └── Rate Limiting      │
└───────────────────────────────────────┬──────────────────────┘
                                        │ GitHub Contents API
                                        ▼
                            ┌───────────────────────────┐
                            │  This repository          │
                            │  data/**  (source of      │
                            │  truth, reviewable diffs) │
                            └─────────────┬─────────────┘
                                          │ push to main
                                          ▼
                                Cloudflare Workers Builds
                                  → new deployment
```

**What lives where, and why:**

| Store           | Contents                                                                                  | Why not in Git                                                |
| --------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `data/**` (Git) | Products, categories, reviews, site settings, homepage copy, rankings, analytics snapshot | — it _is_ the Git half: diffable, reviewable, revertible      |
| KV `DRAFTS`     | Draft product JSON for instant preview                                                    | Needs to be writable per keystroke without a commit           |
| KV `SESSIONS`   | Opaque admin sessions, 12 h TTL                                                           | Session material must never be version-controlled             |
| KV `RATELIMIT`  | Counters for windows longer than 60 s, plus short write locks                             | Ephemeral                                                     |
| D1 `DB`         | Admin credentials, login attempts, leads, analytics events and daily rollups              | Credentials and visitor data must never be version-controlled |
| R2 `MEDIA`      | Image originals and generated derivatives, served through `/img/**`                       | See below                                                     |

**Image binaries are not version-controlled.** Originals and every generated derivative live
in R2. Deleting an image in the admin moves its objects to a `deleted/` prefix rather than
removing them, which gives a 30-day recovery window — but the expiry itself is an **R2 bucket
lifecycle rule**, which `wrangler.toml` cannot express. It must be set out of band, once per
bucket:

```bash
wrangler r2 bucket lifecycle add ngf-media \
  --name expire-deleted --prefix deleted/ --expire-days 30
```

Without that rule nothing breaks and nothing is lost; deleted objects simply accumulate.

**Cloudflare Workers Paid is assumed** ($5/month), for R2, for the Rate Limiting binding, and
for the CPU headroom the image pipeline needs. The pipeline carries roughly 2.1 MB gzipped of
WebAssembly (Photon for decode/resize/WebP/JPEG, jSquash for AVIF encode and decode), which
fits the paid plan's 10 MB Worker ceiling comfortably and leaves very little room under the
free plan's 3 MB. On the free plan, derivative generation would have to move to a Queue
consumer or to Cloudflare Images, and R2 needs enabling separately.

---

## Tech stack

These are the versions actually installed, not floors:

| Layer      | Choice                                                                 |
| ---------- | ---------------------------------------------------------------------- |
| Framework  | Astro 7.2.10 (prerendering + on-demand routes)                         |
| Islands    | React 19.2.8 via `@astrojs/react` 6.0.5                                |
| Runtime    | Cloudflare Workers via `@astrojs/cloudflare` 14.2.6                    |
| Styling    | Tailwind 4.3.3 with a token layer in `src/styles/tokens.css`           |
| Validation | Zod 4.3.6 — one schema set shared by the build, the Worker and the CLI |
| Search     | MiniSearch 7.2.0, client-side over a build-generated index             |
| Images     | `@cf-wasm/photon` 0.4.0 + `@jsquash/avif` 2.1.1, in-Worker             |
| Tests      | Vitest 4.1.11, fast-check 4.9.0, Playwright 1.62.1                     |
| Tooling    | ESLint 10, Prettier 3, size-limit 13, tsx, Wrangler 4                  |

Node **≥ 22.12.0** is required — locally, in CI, and in Workers Builds.

Zod 4 is not optional: Astro 7's content layer rejects any schema without a Zod-v4 marker, so
a v3 schema cannot serve as a collection schema at all.

---

## Folder structure

```text
/
├── data/                       # source of truth — human-, admin- and CLI-editable
│   ├── products/{slug}.json    # ships empty; only .gitkeep is committed
│   ├── categories/{slug}.json  # nine seeded categories
│   ├── reviews/{id}.json
│   ├── site/
│   │   ├── settings.json       # business name, numbers, location, socials, SEO defaults
│   │   ├── homepage.json       # section copy and which sections are enabled
│   │   ├── rankings.json       # curated ordering for trending / best-seller / most-viewed
│   │   └── redirects.json
│   └── snapshots/analytics.json  # written by the nightly cron; absent until there are events
├── migrations/                 # D1 schema — admin users, leads, events
├── public/
│   ├── brand/                  # hero composition SVG; the logo slot is empty
│   ├── fonts/
│   ├── _headers                # static-asset security headers
│   └── .assetsignore
├── scripts/
│   ├── add-product.ts          # the `product:add` CLI
│   ├── validate-content.ts     # schema gate, runs pre-build and in CI
│   ├── seed-admin.ts           # one-time admin account creation
│   ├── scan-secrets.ts         # credential scan over dist/
│   └── audit-*.ts, lint-*.ts   # post-build SEO/CSP/budget/motion audits
├── src/
│   ├── content.config.ts       # Astro content collections + Zod schemas
│   ├── schemas/                # canonical schemas shared by build, Worker and CLI
│   ├── middleware.ts           # security headers, CSP, trailing-slash normalisation
│   ├── worker.ts               # Worker entry; exports the scheduled handler
│   ├── pages/                  # public routes, /admin/**, /api/**, /img/**
│   ├── components/{ui,product,home,forms,motion,admin}/
│   ├── lib/
│   │   ├── github/             # commit pipeline, path allowlist, serialization
│   │   ├── auth/               # PBKDF2, sessions, CSRF, rate limits, permissions
│   │   ├── ai/                 # provider-agnostic assistant + fact guard
│   │   ├── images/             # upload validation, derivatives, delivery
│   │   ├── search/             # index build, query, filter, sort
│   │   ├── products/           # input schemas, lifecycle, related, duplicate
│   │   ├── analytics/          # event write, rollups, nightly snapshot
│   │   └── slug.ts, whatsapp.ts, phone.ts, money.ts
│   └── styles/tokens.css
├── tests/{unit,property,e2e,fixtures}/
├── .env.example
├── wrangler.toml
└── lighthouserc.json
```

`data/products/` contains only `.gitkeep`. Demo products live in `tests/fixtures/` and never
in `data/` — every catalogue surface renders its designed empty state until real products
arrive.

---

## Local setup

```bash
# 1. Node 22.12 or later
node --version

# 2. Install
npm ci

# 3. Local variables (gitignored)
cp .env.example .dev.vars
#    Edit .dev.vars: set SESSION_SECRET, and GITHUB_* if you want to exercise the
#    write pipeline. The public values work as shipped for local development.

# 4. D1 tables, locally
npm run db:migrate:local

# 5. The admin account (interactive; nothing is echoed)
npx tsx scripts/seed-admin.ts --local

# 6. Develop
npm run dev              # http://localhost:4321
```

`npm run dev` runs `astro dev`. Bindings are provided by the adapter's local platform proxy,
backed by the filesystem under `.wrangler/state/v3/`.

To exercise the real thing — Worker routing, the static asset store, prerendered HTML — build
and serve it:

```bash
npm run build
npm run preview          # wrangler dev on http://localhost:8788
```

### Commands

| Command                                           | What it does                                                                                                                           |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                                     | Astro dev server                                                                                                                       |
| `npm run build`                                   | `validate:content` → Astro build → post-build audits (motion budget, redirects, SEO, CSP, page budget, image loading, keyword density) |
| `npm run preview`                                 | `wrangler dev` against the built output, port 8788                                                                                     |
| `npm run check`                                   | `astro check` + `tsc --noEmit`                                                                                                         |
| `npm run lint`                                    | ESLint, Prettier check, motion lint, error-disclosure audit, keyword density                                                           |
| `npm run format`                                  | Prettier write                                                                                                                         |
| `npm test`                                        | Vitest — unit and property suites                                                                                                      |
| `npm run test:e2e`                                | Playwright (see [Testing](#testing) — browsers must be installed first)                                                                |
| `npm run e2e:prepare`                             | Migrates the **local** D1 and seeds a throwaway admin account for the e2e suite (`--local` only)                                       |
| `npm run e2e:preview`                             | `npm run preview` with `PUBLIC_SITE_URL` pointed at `localhost:8788`, so the admin's origin check passes                               |
| `npm run validate:content`                        | Zod over every file in `data/**`                                                                                                       |
| `npm run size-limit`                              | Per-route asset budgets                                                                                                                |
| `npm run scan:secrets`                            | Credential scan over `dist/`                                                                                                           |
| `npm run db:migrate:local` / `npm run db:migrate` | Apply D1 migrations                                                                                                                    |
| `npm run seed:admin`                              | Create the owner account                                                                                                               |
| `npm run product:add`                             | Add a product from the command line                                                                                                    |

---

## Environment variables

`.env.example` is the reference and contains **placeholder values only**. Copy it to
`.dev.vars` for local development; in deployed environments set the secret block with
`wrangler secret put NAME`, per environment. No secret appears in `wrangler.toml`, in the
repository, or in build logs.

### Public — safe to expose

Set in `wrangler.toml` under `[vars]` (and `[env.preview.vars]`). Astro inlines anything
prefixed `PUBLIC_` into the client bundle.

| Variable                  | Purpose                                                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_SITE_URL`         | Canonical origin. Drives canonical tags, the sitemap, OG URLs and JSON-LD. No hostname is hard-coded in `src/` — a test asserts it. |
| `PUBLIC_WHATSAPP_NUMBERS` | Comma-separated E.164 WhatsApp numbers.                                                                                             |
| `PUBLIC_PHONE_NUMBERS`    | Comma-separated E.164 click-to-call numbers.                                                                                        |

> **Accuracy note.** The numbers the site actually renders come from
> `data/site/settings.json`, not from these two variables. `publicConfig()` parses them and
> exposes them, but no render path currently reads that result — see
> [Changing the WhatsApp and phone numbers](#changing-the-whatsapp-and-phone-numbers).
> Keep them in step with settings so they do not become misleading, and treat
> `data/site/settings.json` as authoritative.

### Secret — server-side only

Set with `wrangler secret put NAME`. Never sent to a browser.

| Variable             | Required                   | Purpose                                                                                                       |
| -------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`       | for the admin              | Fine-grained PAT, `contents: write` on this repository only                                                   |
| `GITHUB_REPO`        | for the admin              | `owner/repo` the write pipeline commits to                                                                    |
| `GITHUB_BRANCH`      | for the admin              | Branch content commits land on, e.g. `main`                                                                   |
| `SESSION_SECRET`     | yes                        | 32+ random bytes for admin session material — `openssl rand -base64 32`                                       |
| `AI_PROVIDER`        | for the assistant          | `openai`, `anthropic`, or `workers-ai`                                                                        |
| `AI_API_KEY`         | for `openai` / `anthropic` | Provider key. Not used by `workers-ai` — the binding is the credential                                        |
| `AI_MODEL`           | optional                   | Model id; each adapter has a default                                                                          |
| `CF_DEPLOY_HOOK_URL` | optional                   | Deploy hook the Worker POSTs to in order to _start_ a build. Write-only: it reports nothing about the outcome |
| `CF_ACCOUNT_ID`      | optional                   | Read side of `GET /api/admin/deploy-status`                                                                   |
| `CF_API_TOKEN`       | optional                   | Token for the above; needs `Workers Scripts:Read` on the account only                                         |
| `CF_WORKER_NAME`     | optional                   | Script name to poll; defaults to the wrangler `name`                                                          |

When the three optional `CF_*` read credentials are unset, `/api/admin/deploy-status` returns
a stable `CONFIGURATION_INCOMPLETE` and the admin says "publish committed, deploy status
unavailable" rather than reporting a false success or failure. Nothing else depends on them.

---

## Cloudflare setup

The `id` fields in `wrangler.toml` are placeholders. They are resource identifiers, not
credentials — replace them with the real values printed by the create commands.

```bash
# 1. KV namespaces (repeat with --env preview for the preview environment)
wrangler kv namespace create SESSIONS
wrangler kv namespace create DRAFTS
wrangler kv namespace create RATELIMIT

# 2. D1
wrangler d1 create ngf-content

# 3. R2
wrangler r2 bucket create ngf-media
wrangler r2 bucket lifecycle add ngf-media \
  --name expire-deleted --prefix deleted/ --expire-days 30

# 4. Paste every printed id into wrangler.toml, replacing the REPLACE_WITH_* placeholders.

# 5. Migrations — required before first use
npm run db:migrate           # applies both --local and --remote

# 6. Secrets, per environment
wrangler secret put GITHUB_TOKEN
wrangler secret put GITHUB_REPO
wrangler secret put GITHUB_BRANCH
wrangler secret put SESSION_SECRET
wrangler secret put AI_PROVIDER
wrangler secret put AI_API_KEY
wrangler secret put AI_MODEL
# optional
wrangler secret put CF_DEPLOY_HOOK_URL
wrangler secret put CF_ACCOUNT_ID
wrangler secret put CF_API_TOKEN
wrangler secret put CF_WORKER_NAME

# 7. The admin account (see Admin setup)
npx tsx scripts/seed-admin.ts --remote
```

Bindings declared in `wrangler.toml`: `SESSIONS`, `DRAFTS`, `RATELIMIT` (KV), `DB` (D1),
`MEDIA` (R2), `ASSETS` (static assets), `RL_ADMIN_API` and `RL_EVENTS` (Rate Limiting).

A nightly cron at `30 19 * * *` (19:30 UTC = 01:00 IST) runs the analytics snapshot. The
preview environment declares an empty `crons` list deliberately: `triggers` is inheritable, and
without that override the preview Worker would commit its own snapshot — computed from the
_preview_ database — into the same content repository production builds from.

---

## Admin setup

**Migrations and seeding must both run before first use.** There is no bootstrap UI: an
unseeded environment has no account to log in with.

```bash
npm run db:migrate                        # tables must exist first
npx tsx scripts/seed-admin.ts --local     # local development
npx tsx scripts/seed-admin.ts --remote    # deployed environment
```

The script creates the single `owner` account. It is deliberately austere:

- **No default password ships.** There is no `--password` flag, no environment-variable
  fallback, and no generated-and-printed value. You type a password (minimum 12 characters)
  or the script exits non-zero.
- **Nothing is echoed** — no characters, no asterisks, no length.
- The plaintext never reaches stdout, a file, a shell argument, or the repository. The SQL
  goes through a `0600` temp file inside the ignored `.wrangler/` directory, unlinked in a
  `finally`.
- It imports `hashPassword` from the runtime, so a seeded credential can never be derived
  under parameters the Worker will not accept (PBKDF2-SHA256, 600k iterations, algorithm
  identifier stored with the hash).

Then sign in at `/admin/login`.

### Roles

`owner`, `editor`, `viewer`. `product.publish` belongs to `owner` alone — so publishing, and
direct `DRAFT → PUBLISHED` transitions, are the owner's authority. `viewer` holds no mutating
permission. Every admin route declares the permission it requires, and a property test
enumerates the route table to prove it.

### Admin surfaces

`/admin` (dashboard), `/admin/products`, `/admin/products/new`, `/admin/products/{id}`,
`/admin/preview/{id}`, `/admin/categories`, `/admin/reviews`, `/admin/leads`,
`/admin/homepage`, `/admin/content`, `/admin/settings`, `/admin/analytics`,
`/admin/ai-assistant`.

### Product lifecycle

```text
DRAFT ⇄ REVIEW          both can go to PUBLISHED (owner only)
PUBLISHED → UNPUBLISHED | OUT_OF_STOCK | DRAFT
OUT_OF_STOCK → PUBLISHED | UNPUBLISHED
UNPUBLISHED → PUBLISHED | DRAFT
```

`PUBLISHED` and `OUT_OF_STOCK` are the public statuses; out-of-stock products stay visible
with degraded CTAs. Reaching either requires the **publish gate**: a description of at least
20 real characters, a price or explicit price-on-enquiry, at least one image, and alt text on
every image. SEO title and description are not hard-required because they are generated when
absent. The gate is enforced on the transition endpoint, so no sequence of transitions can
publish an incomplete product.

---

## AI assistant configuration

The assistant drafts product copy. It is provider-agnostic and is called only from the
Worker; the key never reaches a browser.

```bash
wrangler secret put AI_PROVIDER    # openai | anthropic | workers-ai
wrangler secret put AI_API_KEY     # not needed for workers-ai
wrangler secret put AI_MODEL       # optional
```

For `workers-ai`, add an `AI` binding to `wrangler.toml` — the binding _is_ the credential, so
no key is set. An unset or unsupported `AI_PROVIDER` disables the assistant with a stable
reason rather than failing a request; the misconfigured name is logged, never the key.

**The assistant cannot invent facts and cannot publish.** `applyFactGuard` is a pure function
that runs on every generation and reads the model's output as data, never as instruction:

- Factual fields the operator did not supply are **blanked with a warning**, not filled. A
  plausible-but-invented material is worse than an empty one.
- Where the operator did supply a value, the operator's value wins byte for byte.
- `category` must be an existing category slug or it becomes `null`; tags and keywords are
  filtered against an allowed vocabulary plus the operator's own.
- Every string is stripped of markup and clamped to its schema maximum.
- There is no `status` or `published` field on the suggestion type, so publication is
  unreachable from this path by construction.

Generated fields are recorded on the product as `aiAssisted` and `aiFields`, filtered against
the keys the record actually carries — provenance is only worth having if it is true.

The generate endpoint returns suggestions; it writes nothing. The record is written by the
same admin create/patch endpoints a manual edit uses.

---

## GitHub integration

Every admin write is a commit to this repository through the GitHub Contents API.

- **Token**: a fine-grained PAT with `contents: write` scoped to this repository only, set as
  `GITHUB_TOKEN`. `GITHUB_REPO` (`owner/repo`) and `GITHUB_BRANCH` complete the target.
- **Path allowlist**: `src/lib/github/paths.ts` admits only `data/**` paths matching the
  declared patterns. `migrations/`, `src/`, workflows and `wrangler.toml` are structurally
  unreachable from the admin API. Traversal and percent-encoding attacks are rejected, and
  property tests cover both directions — attacks rejected, legitimate paths never rejected.
- **Deterministic bytes**: every file is written with sorted keys, two-space indent and a
  trailing newline, so two writes of the same logical content are byte-identical and a diff
  shows only what changed.
- **Unknown fields survive**: a write merges the operator's patch over the parsed _raw_ file,
  not over a schema projection, so a field this codebase does not know about is not dropped.
- **Optimistic locking**: a stale write gets a 409 rather than clobbering. A single operator
  is assumed, so there is no collaborative merge.
- **Build noise control**: draft- and review-only commits carry `[skip ci]`.

---

## Deployment

Cloudflare Workers Builds, connected to this repository. `main` is production; pull requests
get preview deployments with a distinct `PUBLIC_SITE_URL` so preview content is never indexed
and never leaks into a canonical tag.

Gate order — the cheapest gate that can reject a change runs first, and nothing deploys behind
a failed gate:

```text
install
  → npm run validate:content     # Zod over every data/** file
  → npm run check                # astro check + tsc --noEmit
  → npm run lint
  → npm test                     # unit + property
  → npm run build
  → npm run size-limit           # per-route asset budgets
  → npm run scan:secrets         # credential scan over dist/
  → Lighthouse CI                # Core Web Vitals against the built artifact
  → deploy
```

A failed build leaves the previous deployment serving.

### The environment is selected at BUILD time

```bash
CLOUDFLARE_ENV=preview npm run build && wrangler deploy
```

Under `@astrojs/cloudflare` v14 the build emits a fully resolved, **single-environment**
config into the client output plus a deploy redirect at `.wrangler/deploy/config.json`, so
`wrangler deploy` reads that generated file rather than `wrangler.toml`. **`wrangler deploy
--env preview` therefore no longer selects anything** — it silently deploys whatever
environment was baked in at build time. The flag is inert, not an error.

Building without `CLOUDFLARE_ENV` and deploying with `--env preview` would ship the
_production_ site URL and the _production_ KV/D1/R2 bindings under the preview Worker name:
the preview would advertise the production canonical URL and point preview traffic at
production data. Any script or CI job that names an environment must set `CLOUDFLARE_ENV`
before the build and must not rely on `--env` at deploy time.

### Build output layout

The adapter splits the build into `dist/client/**` (public assets, uploaded to the asset
store) and `dist/server/**` (the Worker bundle, never publicly reachable). `[assets]
directory` points at `./dist/client` specifically, so the server bundle sits structurally
outside the uploaded tree; `public/.assetsignore` is a second line of defence, not the only
one.

---

## Creating a product

Three routes, one code path. The CLI, the admin form and the AI-assisted admin flow all call
the same `toSlug`/`uniqueSlug`/`generateSku`, the same `buildNewProduct`, the same
`ProductSchema` and publish gate, the same upload validation and derivative pipeline, and the
same serializer — so all three produce byte-compatible files by construction rather than by
comparison. `id` and `sku` are randomly generated, so they legitimately differ between runs;
everything else, key order included, matches.

### 1. The admin form

`/admin/products/new`. Fill the fields, upload images, save. The draft goes to KV instantly
and to `data/products/{slug}.json` as a `[skip ci]` commit; preview it at
`/admin/preview/{id}`; publish when the gate is satisfied.

### 2. The AI-assisted admin flow

`/admin/ai-assistant`, or the assist controls on the product form. Supply the facts you know,
generate, review what came back — unsupplied factual fields come back **blank with a
warning** — then save through the same form. See
[AI assistant configuration](#ai-assistant-configuration).

### 3. The CLI

```bash
npm run product:add -- \
  --name "Luxury L-Shape Sofa" \
  --category sofas \
  --price 42000 \
  --material "Fabric upholstery, seasoned hardwood frame" \
  --dimensions "213x91x76" \
  --colors "Beige,Grey,Brown" \
  --images ./incoming/sofa-1.jpg ./incoming/sofa-2.jpg \
  --alt "Beige L-shape sofa in a panelled living room" \
  --status DRAFT
```

Adding a product touches **exactly one data file and zero frontend files**. In order, the
command:

1. verifies `data/categories/{slug}.json` exists, failing with the list of valid slugs rather
   than silently creating a category;
2. generates a unique slug and SKU against the identifiers already on disk;
3. validates each image with the admin's own magic-byte sniff and full decode, capturing
   intrinsic dimensions, then generates every derivative and the LQIP through the admin's own
   pipeline;
4. assembles the record, generating SEO title and description where none were supplied;
5. validates against `ProductSchema`, and additionally against `PublishReadySchema` when a
   public status is requested;
6. asserts the product's `wa.me` URL builds and that a single decode returns the intended
   message;
7. writes `data/products/{slug}.json` and prints the diff.

Any failure writes **no file** and names the failing field. `npm run product:add -- --help`
lists every flag; `--dry-run` validates and prints the diff without writing.

#### Where the CLI's images actually go

The derivative pipeline writes to an R2 _binding_, and a binding exists only inside a Worker.
The CLI runs in Node, so it obtains one the only way a local process can: wrangler's
`getPlatformProxy()`, which reads `wrangler.toml` and returns the `MEDIA` binding backed by
the filesystem-persisted local bucket under `.wrangler/state/v3/r2`.

That is a real R2 API and a real write. It is **not** the deployed bucket, and nothing the CLI
does puts bytes where a deployed `/img/**` request will find them. Consequently the written
record carries `derivativesReady: false` with empty `derivativeWidths`/`derivativeFormats` —
the same initial state the admin upload endpoint records — and the run report names the bucket
it reached and what remains to be done. Options:

- `--images-out <dir>` also writes every generated object to disk, so the bytes can be pushed
  to the deployed bucket with `wrangler r2 object put`;
- `--r2 none` skips object writes entirely: validation, decode, intrinsic dimensions and the
  LQIP still run, derivatives do not, and the report says so.

Uploading the same photographs through the admin is the only path that can legitimately flip
`derivativesReady`, because it is the only one that writes to the bucket the deployment reads.

---

## The Kiro product workflow

```bash
npm run product:add -- --name "…" --category sofas --price … --images …
npm run validate:content
npm run check
npm run lint
npm test
npm run build
npm run scan:secrets
# then commit the one new file, push a branch, open a PR
```

Because every catalogue surface reads the content collection rather than a hard-coded list,
the new product's detail page, category listing, search-index entry, sitemap entry and
structured data all appear after the next build with no further edits.

---

## Content operations

### Adding a category

Categories are content files, and the CLI will not create one. Add
`data/categories/{slug}.json` — through `/admin/categories` or by hand — with:

| Field                                                 | Notes                                                                                                            |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `slug`                                                | lowercase, digits and hyphens only                                                                               |
| `name`                                                | display name, e.g. `Sofas & Sectionals`                                                                          |
| `shortDescription`                                    | max 200 characters                                                                                               |
| `order`                                               | integer; controls display order                                                                                  |
| `illustration`                                        | one of `sofa`, `bed`, `diningTable`, `diningChair`, `accentChair`, `coffeeTable`, `storage`, `office`, `outdoor` |
| `subcategories`                                       | array of `{ slug, name }`, default `[]`                                                                          |
| `intro`, `seoTitle`, `seoDescription`, `heroImageKey` | optional                                                                                                         |
| `published`                                           | default `true`                                                                                                   |

Then `npm run validate:content`. The nine seeded categories are the illustration set above;
adding a tenth needs a new illustration value in `CategoryIllustration`, which is a code
change — that enum is closed on purpose, because a category with no drawing has no card.

### Managing reviews

`/admin/reviews`, stored as `data/reviews/{id}.json`: `customerName`, `rating` (1–5), `text`
(5–1500 characters), optional `customerPhotoKey`, `productPhotoKey`, `videoKey`, `productId`,
`date`, `featured`, `order`, and a `DRAFT`/`PUBLISHED`/`UNPUBLISHED` status.

Reviews are **operator-entered testimonials, not verified purchase reviews**. For that reason
`aggregateRating` structured data is withheld by default; enabling it would be a claim about
verification this system cannot make.

### Managing leads

Enquiry forms write to D1, and leads are read and worked at `/admin/leads`: status,
assignment, notes. Leads never enter the repository — the path allowlist admits only `data/**`
and there is no lead path in it.

**What the analytics honestly cannot tell you**, stated in the admin UI beside the numbers as
well as here:

- **Attribution ends at the click.** A WhatsApp or call figure counts the act of opening
  WhatsApp or a dialler. Whether a conversation happened, and whether an order followed, is
  not measurable — it is recorded only by you, as a lead's status.
- **Every measured count is a lower bound.** Ad blockers, privacy browsers and dropped
  background requests mean some visits are never reported, and the shortfall is not knowable.
  Page views are counted in the browser, so a visitor with JavaScript disabled is invisible.
- **There is no campaign attribution.** Traffic source is limited to what the browser
  volunteers; direct traffic cannot be attributed at all unless the link carried UTM
  parameters.
- Enquiry _events_ and enquiry _records_ are counted separately and will not always agree.

**Best Selling is curated, permanently.** The system records no transactions, so there is
nothing to measure — not "no data yet" but "never". It reads the operator's ordering in
`data/site/rankings.json` and is labelled `(curated)` in the sort control.

**Most Viewed and Trending read a dated snapshot.** The nightly cron writes
`data/snapshots/analytics.json` from the D1 daily rollups and commits it with `[skip ci]`, so
the next build serves fresh numbers without an extra deploy. `views` is lifetime, `velocity`
is the last seven days. Until the snapshot exists both sorts fall back to the curated ordering
and say so; when it exists they carry its date. An unchanged snapshot is not committed, and a
snapshot whose numbers are all absent is rejected rather than written as an empty object —
before launch, the cron runs nightly and writes nothing.

### Changing the WhatsApp and phone numbers

The numbers the site renders come from `data/site/settings.json`:

```json
"whatsapp": [
  { "label": "Orders & Enquiries 1", "e164": "+91…" },
  { "label": "Orders & Enquiries 2", "e164": "+91…" }
],
"phone": [ … ]
```

Edit them through `/admin/settings` or in the file directly, then `npm run validate:content`.
`e164` is the canonical form and drives both `wa.me` links and `tel:` links; the stored
`label` is an operator-facing key for the admin form and is **not** what a visitor sees —
every surface renders one shared label, "Orders & enquiries", for both numbers, because the
two are genuinely interchangeable. The lists are merged by E.164 value, not by index, so a
number listed in only one array still renders correctly and a third number appears with no
code change.

Also update `PUBLIC_WHATSAPP_NUMBERS` and `PUBLIC_PHONE_NUMBERS` in `wrangler.toml` to match.
They are configuration mirrors — no render path reads them today — but leaving them stale
makes them misleading.

### Configuring the domain

The domain is not purchased yet, and buying it is a **configuration change, not a code
change**. Nothing in `src/` hard-codes a hostname, and a test asserts it.

1. Set `PUBLIC_SITE_URL` in `wrangler.toml` under `[vars]` (production) and
   `[env.preview.vars]` (preview, which must stay distinct).
2. Add the custom domain to the Worker in the Cloudflare dashboard.
3. Rebuild and deploy — canonical tags, the sitemap, `robots.txt`, OG URLs and JSON-LD all
   follow.

---

## Security

- **Authentication.** PBKDF2-SHA256 at 600k iterations via WebCrypto, algorithm identifier
  stored with the hash so a future migration to Argon2id can be transparent. Password
  verification is constant-time and leaks no plaintext.
- **Sessions.** Opaque identifiers in KV: a 12-hour absolute cap matching the KV TTL, plus a
  2-hour idle timeout checked on every read. The cookie carries no claims.
- **CSRF.** Every mutating admin request requires a token; a missing or wrong token is
  refused. A property test enumerates the whole admin route table to prove that
  unauthenticated requests write nothing and that CSRF failures write nothing.
- **Authorization.** Every admin route declares a required permission, checked before any
  binding is touched.
- **Rate limits.** Per-minute windows use the Rate Limiting binding (10 s and 60 s periods
  only); longer windows — 15-minute login windows, hourly AI and lead caps, 10-minute upload
  caps — use KV counters, along with short write locks.
- **Uploads.** Acceptance is decided by magic bytes, never by declared MIME type or
  extension. SVG is refused outright. Disguised SVG, PHP, HTML, ELF and ZIP payloads are all
  rejected, and every accepted file is fully decoded and re-encoded before storage.
- **Write path.** The GitHub path allowlist admits only `data/**`. Traversal and
  percent-encoding attacks are rejected; path resolution is total.
- **Queries.** Every D1 access uses bound parameters. No query is built from unvalidated
  input.
- **Output.** Visitor- and operator-supplied values are escaped before rendering: no
  `<script`, no event-handler attribute, no `javascript:` URL survives.
- **Error disclosure.** A single `{ error, message, fields? }` envelope crosses the boundary.
  No stack trace, file path, internal identifier, upstream provider body or credential is ever
  included; full detail is logged server-side with credentials redacted.
- **Headers**, on every response: HSTS with `includeSubDomains; preload`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`, and a
  `Permissions-Policy` denying camera, microphone and geolocation.
- **CSP**: `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline';
script-src 'self' <four sha256 hashes>; connect-src 'self' https://api.whatsapp.com;
font-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self';
frame-ancestors 'none'`. Two exemptions, both stated rather than hidden:
  - `'unsafe-inline'` for **styles only**, because Astro inlines critical CSS.
  - Four **SHA-256 hashes** in `script-src`, for Astro's island bootstrap. `getPrescripts`
    writes the `astro-island` runtime and the client-directive loader as literal inline
    `<script>` elements with no way to externalise them, and a nonce is meaningless on a
    prerendered artifact served to everyone. A hash grants execution to those exact byte
    sequences and nothing else — an injected `<script>` still does not run — which is a
    strictly smaller grant than `'unsafe-inline'`. Every script this project writes is
    external: the pre-paint motion bootstrap lives in `public/ngf-motion-preference.js` and
    `assetsInlineLimit: 0` stops Astro inlining component scripts.
  - `scripts/audit-csp.ts` runs in `postbuild` and enforces the policy against the built
    artifact in both directions: any inline script that does not hash to a member of the
    closed set of four fails the build, and so does a cross-origin script, stylesheet, font
    or image, an inline event-handler attribute, a `javascript:` URL, an `<iframe>`,
    `<object>`, `<embed>` or `<base>`, or a cross-origin form action. An Astro upgrade that
    changes one of those four bytes fails the gate, prints the new hash, and requires a human
    to look.
- **No third-party script** loads on any public critical path.
- **Secrets.** None in the repository. `npm run scan:secrets` fails the build if any secret
  pattern appears anywhere under `dist/`, asserted exhaustively over every file rather than a
  sample.

---

## Testing

```bash
npm test                 # unit + property (Vitest)
npx vitest run --project unit
npx vitest run --project property

npx playwright install --with-deps   # REQUIRED once, before the first e2e run
npm run test:e2e                     # migrates local D1, seeds, builds, serves, runs
```

Playwright browsers are **not** installed by `npm ci`. `npm run test:e2e` fails with a missing
executable until `npx playwright install --with-deps` has been run in that environment. (On a
distribution without `apt-get`, `npx playwright install chromium` alone is enough — only the OS
dependency step needs a package manager.)

`npm run test:e2e` needs nothing else set up. Its `webServer` runs `e2e:prepare` → `build` →
`e2e:preview`, so the local D1 is migrated, a throwaway `owner` account exists, and the Worker is
serving `dist/` before the first test starts. `e2e:prepare` touches `--local` state only: it wipes
`.wrangler/state/v3/kv` so the rate limiters do not carry counters between runs, and writes the
generated password to the git-ignored `test-results/e2e-admin.json`. No credential is committed and
nothing it runs can reach a remote database.

Playwright targets `wrangler dev` on port 8788, not the dev server, because Worker routing,
the asset store, the security headers and the prerendered HTML are part of what is under test.

Two project families. The nine viewport widths — 320, 375, 390, 414, 768, 1024, 1280, 1440, 1920 —
run the suites whose _subject_ is the viewport (`responsive.spec.ts`, `motion-trace.spec.ts`), so a
failure names the width that broke. Everything else runs once, at 1280, in the `functional` project;
the few tests that care about a narrow viewport resize themselves.

| Spec           | What it holds to account                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `homepage`     | The shell on every page: skip link, header nav, footer inventory, motion toggle persistence, no invented business fact      |
| `catalogue`    | The nine category routes, the honest count, the designed empty states, the controls, sort in the URL                        |
| `search`       | The index is not in the initial payload and is fetched once on intent; a no-match query is still useful                     |
| `filters`      | The URL is the state: canonical, shareable, restored by back and forward, zero-count options disabled                       |
| `pdp`          | Today's real behaviour for a product URL, plus the product assertions, gated until the first product is published           |
| `conversion`   | Every `wa.me` and `tel:` destination, the enquiry form's success and failure paths, the traps, the no-JavaScript fallback   |
| `admin-auth`   | The sign-in form, the session cookie's attributes, `?next=` preservation, CSRF refusal, sign-out revocation                 |
| `responsive`   | Overflow, clipping, occlusion, 44 px touch targets, CLS, and the mobile contracts, at all nine widths                       |
| `a11y`         | axe-core on every page with zero tolerance, plus keyboard walkthroughs, duplicate ids, and label/ARIA reference resolution  |
| `seo`          | Unique titles and descriptions, canonicals, JSON-LD, the sitemap, `robots.txt`, trailing-slash redirects, nothing indexable |
| `security`     | Zero CSP violations, every security header, the unauthenticated admin sweep, magic-byte rejection of disguised uploads      |
| `motion-trace` | Long tasks, layout shift attributable to motion, frame loops off-screen and hidden, reduced motion                          |

`workers` is pinned to 1 in `playwright.config.ts`. Every worker drives the same `wrangler dev`
process, and its local proxy resets connections under concurrency and eventually exits — which turns
two real failures into a hundred `ERR_CONNECTION_REFUSED` ones. A related rule when adding a spec:
**never send a request body on a request the handler refuses before reading it.** An unread body
reliably resets that proxy, and the guard's refusals happen before any body is read, so the probes
send headers only.

What e2e does _not_ cover, and why: the admin lifecycle (create → review → publish, image upload, AI
generation, reviews, leads, settings) writes through the GitHub Contents API and needs a
`GITHUB_TOKEN` for a real repository. Those flows are covered against a mocked GitHub by
`tests/unit/github.pipeline.integration.test.ts`, `products.admin.test.ts`,
`images.upload.integration.test.ts`, `ai.generate.integration.test.ts` and
`categories.reviews.admin.test.ts`, which can assert things a browser cannot — that a refused write
touched no binding, for instance.

Property tests use fast-check and are named against the design's numbered properties, so
traceability runs design → property → test. Unit and property suites use real code, real
schemas and the real image codec; the codec differs from the Worker's only in module
resolution.

---

## What is not supplied

These are flagged rather than invented. No business fact — years in business, certifications,
awards, counts, delivery times, warranty terms, market position — is hard-coded, generated or
inferred anywhere in this codebase. Unknown facts render a marked placeholder and appear in the
admin content checklist (`placeholders` in `data/site/settings.json`).

| Missing                                                            | Current behaviour                                                                                                                                                                                                                                                                                                                    | How to supply it                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The real logo**                                                  | `logo.src` is `null`, so the header, footer, hero, OG image and admin chrome render `logo.wordmarkFallback` — a typographic "NEW GALAXY FURNITURE" wordmark. Visually distinct enough that nobody mistakes it for the final mark.                                                                                                    | **One file plus one field:** drop the asset at `public/brand/logo.svg` and set `logo.src` to `/brand/logo.svg` in `data/site/settings.json` (or the Logo field in `/admin/settings`). SVG, or transparent PNG ≥ 1000 px. It will not be recoloured, stretched or redrawn. No code change. |
| **The real hero photograph**                                       | `settings.heroImage` is unset, so `HERO_COMPOSITION` renders — the project's own hairline room drawing at `public/brand/hero-composition.svg`, a design asset rather than a claim about the business.                                                                                                                                | **One field:** set `site.heroImage` in `data/site/settings.json` to `{ src, width, height, alt, lqip? }`. `width` and `height` are mandatory — without them the slot cannot be reserved and the swap-in would reintroduce layout shift. No code change.                                   |
| **Products and photography**                                       | The catalogue ships with zero products and renders its designed empty states.                                                                                                                                                                                                                                                        | Any of the three routes in [Creating a product](#creating-a-product).                                                                                                                                                                                                                     |
| **Address, opening hours, map link, geo**                          | `/contact` and the LocalBusiness JSON-LD render only what settings contains; hours, `priceRange` and `geo` are omitted rather than guessed.                                                                                                                                                                                          | `location` in `data/site/settings.json`.                                                                                                                                                                                                                                                  |
| **Policy copy** (Privacy, Terms, Shipping, Returns, Warranty, FAQ) | Structure only. Each page names what the finished policy will state and states none of it, behind a visible "This policy is being finalised — contact us for current terms" notice, with an inline `[FOR BUSINESS REVIEW]` comment emitted by `PolicyPage.astro`. No delivery timeframe, return window or warranty term is invented. | Needs legal and business review, then editing `src/pages/{privacy,terms,shipping,returns,warranty}.astro` and `src/pages/faq.astro`. **This copy lives in page source, so supplying it is a code change** — `/admin/content` only tracks that it is outstanding.                          |
| **Social profile URLs**                                            | Nullable in settings; the footer renders only non-null entries, so there are no dead icons.                                                                                                                                                                                                                                          | `social` in `data/site/settings.json`.                                                                                                                                                                                                                                                    |
| **OG image**                                                       | `seoDefaults.ogImageKey` is `null`; the wordmark composition answers instead.                                                                                                                                                                                                                                                        | Upload and set the key in settings.                                                                                                                                                                                                                                                       |

### Known tooling gap

`eslint-plugin-jsx-a11y` is **not installed**: its latest release does not admit ESLint 10 in
its peer range. There is therefore no lint-time accessibility rule — the accessibility gate
rests on the axe-core pass per page plus Lighthouse Accessibility 100, which catch rendered
violations but not authoring mistakes at the source level, and catch nothing on a component no
test renders. This is a real reduction in coverage, not an equivalent substitution. The fix is
upstream; pinning ESLint back to 9 to obtain the plugin was rejected as trading a broad
toolchain downgrade for one rule set.

---

## Troubleshooting

**`npm run dev` or any admin route 500s with a missing-binding error.**
Bindings only exist on on-demand routes, and locally they come from `wrangler.toml`. Check the
`REPLACE_WITH_*` ids have been replaced and that `.dev.vars` exists.

**`/admin/login` rejects every password.**
The account was never seeded, or was seeded against a different environment. `npm run
db:migrate` then `npx tsx scripts/seed-admin.ts --local` (or `--remote`). There is no default
password and no reset endpoint — re-run the seed script.

**A publish "succeeded" but the site is unchanged.**
Expected for up to ~150 seconds: published content is baked at build time. Check the deploy
indicator; if it says status is unavailable, the optional `CF_ACCOUNT_ID` / `CF_API_TOKEN` /
`CF_WORKER_NAME` are unset, which suppresses reporting but not the deploy.

**A draft commit did not trigger a build.**
Correct. Draft- and review-only commits carry `[skip ci]`.

**`npm run build` fails in `validate:content`.**
A file under `data/**` does not satisfy its schema. The error names the file and the field.
Nothing else runs until it passes.

**`npm run size-limit` fails.**
A route exceeded its asset budget. The budgets are in `.size-limit.mjs` and are intentionally
hard failures — find the newly-eager import rather than raising the number. Check that islands
are `client:visible`/`client:idle` and that heavy modules are dynamically imported.

**`npm run test:e2e` fails with a missing browser executable.**
Run `npx playwright install --with-deps` once per environment.

**e2e tests fail to connect on port 8788.**
They target `wrangler dev`, not the dev server. `npm run build` then `npm run preview` first,
or set `PLAYWRIGHT_BASE_URL`.

**`product:add` says "No category …".**
Correct, and it will never create one. Add `data/categories/{slug}.json` first — the error
lists every valid slug.

**`product:add` cannot open the local R2 binding.**
`getPlatformProxy()` failed — usually an unreplaced `REPLACE_WITH_*` id or a missing `MEDIA`
binding in `wrangler.toml`. Re-run with `--r2 none` to validate and measure the images without
writing objects; the report will say exactly what was and was not done.

**`--status PUBLISHED` is refused.**
The publish gate is unmet. The error names each failing field; `images` is the usual one.
Nothing was written.

**Images 404 on `/img/**` after a CLI run.**
Expected. The CLI reaches the _local_ bucket, not the deployed one. Re-run with
`--images-out <dir>` and push with `wrangler r2 object put`, or upload the photographs through
the admin — the only path that can legitimately flip `derivativesReady`.

**A preview deployment shows production content or the production canonical URL.**
The environment was not selected at build time. `CLOUDFLARE_ENV=preview npm run build &&
wrangler deploy`. `wrangler deploy --env preview` is silently inert under this adapter.

**Deleted images are accumulating in R2.**
The lifecycle rule was never created. See [Cloudflare setup](#cloudflare-setup) — it cannot be
expressed in `wrangler.toml`.
