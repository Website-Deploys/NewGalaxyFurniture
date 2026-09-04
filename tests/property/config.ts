import fc from 'fast-check';

/**
 * Shared fast-check configuration for every property suite.
 *
 * Design: Testing Strategy → Property-based testing (fast-check, Vitest integration).
 * Requirements: 27.12.
 */

const isCI = process.env.CI === 'true' || process.env.CI === '1';

/** Cases per property. High enough to reach the interesting corners of the input space. */
export const NUM_RUNS = 300;

/**
 * Set `FC_SEED` (and optionally `FC_PATH`) to replay a reported counterexample:
 *   FC_SEED=-1234567 FC_PATH=12:3 npm test
 */
const seedFromEnv = process.env.FC_SEED === undefined ? undefined : Number(process.env.FC_SEED);

export const PROPERTY_CONFIG: fc.Parameters<unknown> = {
  numRuns: NUM_RUNS,
  // fast-check prints `seed`, `path`, and the shrunk counterexample on failure;
  // Verbose additionally lists every failing case, which is what CI logs need.
  verbose: isCI ? fc.VerbosityLevel.Verbose : fc.VerbosityLevel.None,
  includeErrorInReport: true,
  ...(seedFromEnv === undefined ? {} : { seed: seedFromEnv }),
  ...(process.env.FC_PATH === undefined ? {} : { path: process.env.FC_PATH }),
};

fc.configureGlobal(PROPERTY_CONFIG);

/**
 * Run a property with the shared configuration.
 *
 * Prefer this over a bare `fc.assert` so a suite cannot silently drop to
 * fast-check's default 100 runs.
 */
export function assertProperty<Ts extends [unknown, ...unknown[]]>(
  property: fc.IPropertyWithHooks<Ts>,
  overrides: fc.Parameters<Ts> = {},
): void {
  fc.assert(property, { ...(PROPERTY_CONFIG as fc.Parameters<Ts>), ...overrides });
}

/**
 * The `fc.asyncProperty` counterpart.
 *
 * It exists as a separate function rather than a widened return type on
 * `assertProperty` so that the `await` is not optional: `fc.assert` over an async
 * property returns a promise, and a forgotten `await` makes the test pass without
 * running a single case. A caller that forgets it here gets a floating-promise lint
 * error instead of a green suite that checks nothing.
 */
export async function assertAsyncProperty<Ts extends [unknown, ...unknown[]]>(
  property: fc.IAsyncPropertyWithHooks<Ts>,
  overrides: fc.Parameters<Ts> = {},
): Promise<void> {
  await fc.assert(property, { ...(PROPERTY_CONFIG as fc.Parameters<Ts>), ...overrides });
}
