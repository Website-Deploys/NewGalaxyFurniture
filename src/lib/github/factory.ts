/**
 * Constructs the GitHub client from the Worker bindings.
 *
 * A separate module from `client.ts` on purpose. `client.ts` is pure with respect to the
 * platform — it takes a token, a repo, and an injectable `fetch` — which is what lets
 * `tests/unit/github.pipeline.integration.test.ts` drive it against a stub API without a
 * Worker runtime. This file is the one place that reads secrets, and nothing imports it
 * except request handlers.
 *
 * `GITHUB_TOKEN` is read here and passed straight into the client's private field. It is
 * never returned to a caller, never placed on an object that gets serialized, and never
 * included in an error message.
 *
 * Requirements: 17.2, 25.12.
 */

import { GitHubContentClient } from './client';
import { optionalConfig, requireSecret } from '../env';
import type { RuntimeCarrier } from '../env';

/** Throws `CONFIG_UNAVAILABLE` when the pipeline is not configured for this environment. */
export function createGitHubClient(context: RuntimeCarrier): GitHubContentClient {
  return new GitHubContentClient({
    token: requireSecret(context, 'GITHUB_TOKEN'),
    repo: requireSecret(context, 'GITHUB_REPO'),
    // The design's default. A preview environment may point at a different branch.
    branch: optionalConfig(context, 'GITHUB_BRANCH') ?? 'main',
  });
}
