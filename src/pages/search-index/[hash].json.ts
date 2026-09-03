/**
 * The search index, emitted as a content-addressed static asset at build time.
 *
 * `[hash]` is the fingerprint of the serialized index, so the URL changes whenever the
 * catalogue does and never otherwise. That is what makes an immutable cache safe: a visitor's
 * browser keeps the file for a year and picks up a new one the moment the content changes,
 * with no revalidation request.
 *
 * This route is prerendered, so its module executes in Node during the build and never inside
 * the Worker — which is why importing the Brotli budget check (a `node:zlib` consumer) through
 * `getSearchIndexAsset` is safe here.
 *
 * Requirements: 22.7, 22.8, 22.14.
 */

import type { APIRoute, GetStaticPaths } from 'astro';

import { getSearchIndexAsset } from '@/lib/search/index-asset';

export const prerender = true;

export const getStaticPaths: GetStaticPaths = async () => {
  // Builds the index and asserts the 60 KB Brotli budget. A breach fails the build here.
  const asset = await getSearchIndexAsset();
  return [{ params: { hash: asset.hash }, props: { serialized: asset.serialized } }];
};

export const GET: APIRoute = ({ props }) => {
  const serialized = (props as { serialized?: string }).serialized ?? '[]';
  return new Response(serialized, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
};
