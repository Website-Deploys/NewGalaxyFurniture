# Recovered image records for p_322e7n6mth (brown-sofa)

These four images were recovered from the local (git-ignored) R2 bucket
`.wrangler/state/v3/r2/ngf-media` for product id `p_322e7n6mth`. They are the
genuine uploads for the "Premium 3+1+1 Sofa Set". Do NOT use the `p_eg3vtxpioj`
images — that id was a stray duplicate repaired out of local KV in a prior task.

Each image original is stored at `products/p_322e7n6mth/{imageId}/original.webp`
(contentType image/webp). Derivatives exist at widths 320,480,640,960,1280 in
avif + webp, plus a 1280 jpeg fallback (formats: avif, webp, jpeg).

Intrinsic dimensions (parsed from the stored WebP originals):

| imageId          | width | height | R2 original key                                    | lqip |
| ---------------- | ----- | ------ | -------------------------------------------------- | ---- |
| img_tchmzkuoeb   | 1470  | 1070   | products/p_322e7n6mth/img_tchmzkuoeb/original.webp | yes (see lqip below) |
| img_ey2dy4u4kt   | 1468  | 1071   | products/p_322e7n6mth/img_ey2dy4u4kt/original.webp | none |
| img_s8k3oxoflo   | 1468  | 1071   | products/p_322e7n6mth/img_s8k3oxoflo/original.webp | none |
| img_tlutq0cci2   | 1469  | 1071   | products/p_322e7n6mth/img_tlutq0cci2/original.webp | none |

## Decisions confirmed by the user

- **Primary image:** `img_tchmzkuoeb` (has the LQIP; was the admin thumbnail),
  `order: 0`. The other three follow in id order:
  `img_ey2dy4u4kt` (order 1), `img_s8k3oxoflo` (order 2), `img_tlutq0cci2` (order 3).
- **Alt text:** use the product's own `imageAltText`
  ("Premium 3+1+1 Sofa Set by New Galaxy Furniture"), numbered per image:
  - img_tchmzkuoeb: "Premium 3+1+1 Sofa Set by New Galaxy Furniture"
  - img_ey2dy4u4kt: "Premium 3+1+1 Sofa Set by New Galaxy Furniture — view 2"
  - img_s8k3oxoflo: "Premium 3+1+1 Sofa Set by New Galaxy Furniture — view 3"
  - img_tlutq0cci2: "Premium 3+1+1 Sofa Set by New Galaxy Furniture — view 4"

## ProductImage schema (src/schemas/product.ts) — required + relevant fields

- `id`: matches `^img_[a-z0-9]{10}$` (all four ids conform)
- `key`: R2 object key of the original (the `products/.../original.webp` string above)
- `alt`: string, max 180 (required non-empty for the publish gate)
- `width`, `height`: positive ints (intrinsic dims above)
- `order`: nonnegative int; MUST be a contiguous permutation of 0..n-1 (invariant 6)
- `altSource`: 'admin' (default)
- `mime`: 'image/webp' (optional but accurate)
- `lqip`: optional; only img_tchmzkuoeb has one (below)
- `derivativesReady`: true
- `derivativeWidths`: [320, 480, 640, 960, 1280]
- `derivativeFormats`: ['avif', 'webp', 'jpeg']

Also set on the product record when publishing:
- `primaryImage`: "img_tchmzkuoeb"
- `status`: "PUBLISHED"
- `published`: true  (schema invariant 3 requires published === (status is PUBLISHED|OUT_OF_STOCK))
- keep `stockStatus`: "IN_STOCK" (invariant: OUT_OF_STOCK status <=> OUT_OF_STOCK stock; PUBLISHED keeps IN_STOCK)
- bump `updatedAt` to publish time (ISO string)
- The `imageStatus`, `pendingImageAlt`, `pendingImageOrder` keys are inert passthrough;
  leave them or remove them, but if removing note that a unit test asserts
  `pendingImageOrder` equals ["front","top","left","right"] and `imageStatus` equals the
  em-dash marker — that test is being rewritten in this task (see FEAT).

## lqip for img_tchmzkuoeb

The exact data URL is stored at
`.agents/tasks/task-publish-brown-sofa/img_tchmzkuoeb.lqip.txt`. It is a
`data:image/webp;base64,...` string, length ~1423 chars, well under the schema's 4000 max.
Read it verbatim from that file. If that file is gone, the lqip may be omitted (optional field).
