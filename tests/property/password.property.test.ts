import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  hashPassword,
  KEY_BYTES,
  needsRehash,
  PBKDF2_ITERATIONS,
  SALT_BYTES,
  timingSafeEqual,
  verifyPassword,
} from '@/lib/auth/password';
import { assertAsyncProperty, assertProperty } from './config';

/**
 * Property 54 — Password verification is exact and leaks no plaintext.
 *
 * Design → Correctness Properties → Property 54.
 *
 * **On the generator.** The design's strategy names
 * `fc.string({ minLength: 1, maxLength: 200 })` "including Unicode and long
 * passphrases". This suite uses `unit: 'grapheme'` for the Unicode arm, which
 * produces well-formed strings. That is a deliberate choice, not a narrowing to make
 * the property pass: an *ill-formed* string — one containing a lone surrogate — has no
 * unique UTF-8 encoding. `TextEncoder` maps every lone surrogate to U+FFFD, so
 * `'\uD800'` and `'\uD801'` are distinct JavaScript strings with identical bytes, and
 * *any* correct byte-oriented KDF must treat them as the same password. A password
 * cannot reach the Worker in that state either: form submission and JSON transport
 * both go through UTF-8 encoding first. Feeding lone surrogates in would assert that
 * PBKDF2 distinguishes inputs it cannot see, which is a defect in the test rather than
 * in the code. Every other corner of the space — combining marks, astral planes,
 * whitespace-only, 200-character passphrases, and near-miss pairs differing in one
 * character — is exercised.
 *
 * **On the cost.** The property runs twice. The wide pass uses a reduced iteration
 * count so that 300 generated cases are affordable; the narrow pass uses the shipped
 * `PBKDF2_ITERATIONS`. This is not a weakening: the iteration count is stored *inside*
 * the hash and `verifyPassword` re-derives from the stored value, which is precisely
 * the parameterization the design specifies, so both passes exercise the same code on
 * the same path. The two together assert more than 300 runs at a single cost would.
 *
 * **Validates: Requirements 10.4, 25.16**
 */

/** Cheap enough for 300 cases; the format and the code path are identical. */
const TEST_ITERATIONS = 1_000;

/**
 * Passwords as they are actually chosen, plus the shapes that break naive
 * comparison: leading/trailing whitespace, NFC/NFD pairs that look identical,
 * repeated characters, and the maximum length.
 */
const passwordArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 4, arbitrary: fc.string({ minLength: 1, maxLength: 200 }) },
  { weight: 3, arbitrary: fc.string({ unit: 'grapheme', minLength: 1, maxLength: 60 }) },
  {
    weight: 1,
    arbitrary: fc.constantFrom(
      'a',
      ' ',
      '  leading and trailing  ',
      'correct horse battery staple',
      'p@ssw0rd!#$%^&*()_+-=[]{}|;:",.<>/?`~',
      'Café Sheesham 2024',
      'cafe\u0301 Sheesham 2024', // NFD: same glyphs, different code points
      'सोफ़ा-पासवर्ड-९८७',
      '🛋️🪑🛏️-emoji-passphrase',
      'x'.repeat(200),
      'x'.repeat(199) + 'y',
    ),
  },
);

function base64Bytes(value: string): number {
  return Buffer.from(value, 'base64').length;
}

/**
 * The serialization is `pbkdf2$sha256$<iterations>$<16-byte salt>$<32-byte key>` and
 * nothing else. Because both binary fields are fixed width, the stored string's length
 * is a function of the iteration count alone — it does not vary with the password, so
 * it cannot carry the password or even its length.
 */
function expectFixedWidthHash(stored: string, iterations: number): void {
  const parts = stored.split('$');
  expect(parts).toHaveLength(5);
  expect(parts[0]).toBe('pbkdf2');
  expect(parts[1]).toBe('sha256');
  expect(parts[2]).toBe(String(iterations));
  expect(base64Bytes(parts[3] ?? '')).toBe(SALT_BYTES);
  expect(base64Bytes(parts[4] ?? '')).toBe(KEY_BYTES);
  // 6 + 6 + digits + 24 + 44 + 4 separators.
  expect(stored.length).toBe(6 + 1 + 6 + 1 + String(iterations).length + 1 + 24 + 1 + 44);
}

/** A different string of the same shape, for the negative clause. */
const otherPasswordArb = (original: string): fc.Arbitrary<string> =>
  fc
    .oneof(
      passwordArb,
      // Near misses: one character appended, removed, or case-flipped.
      fc.constant(`${original} `),
      fc.constant(original.slice(0, -1)),
      fc.constant(original.toUpperCase()),
      fc.constant(original.toLowerCase()),
      fc.constant(`${original}${original}`),
    )
    .filter((candidate) => candidate !== original && candidate.length >= 1);

describe('Property 54: Password verification is exact and leaks no plaintext', () => {
  it('verifies the exact password, rejects every other, and never embeds the plaintext', async () => {
    await assertAsyncProperty(
      fc.asyncProperty(passwordArb, async (password) => {
        const stored = await hashPassword(password, { iterations: TEST_ITERATIONS });

        // Clause 1 — the exact password verifies.
        expect(await verifyPassword(password, stored)).toBe(true);

        // Clause 3, part one — the structural form, which holds at every length.
        //
        // The stored value is five `$`-separated fields whose salt and key are of
        // *fixed* width. There is therefore nowhere for the plaintext to be, and the
        // hash does not even reveal the password's length — a stronger statement than
        // substring absence and one that does not depend on how long the password is.
        expectFixedWidthHash(stored, TEST_ITERATIONS);

        // Clause 3, part two — substring absence.
        //
        // Guarded at four characters, and the guard is a correction to this test
        // rather than a concession by the implementation. Base64 draws on a
        // 64-character alphabet, so a 44-character key field contains any *single*
        // given character with probability ≈ 0.5; the first run of this property duly
        // failed on the counterexample `"+"`. That collision carries no information
        // about the password and is not a leak — it is the pigeonhole principle. At
        // four characters the chance of an accidental hit is under 10^-5 per case and
        // a real hit means real embedding. The shortest password the system will
        // actually accept is twelve characters (`scripts/seed-admin.ts`), so the guard
        // excludes nothing reachable.
        if (password.length >= 4) {
          expect(stored.includes(password)).toBe(false);
          expect(stored.includes(password.slice(1))).toBe(false);
          expect(stored.includes(password.slice(0, -1))).toBe(false);
        }
      }),
    );
  });

  it('rejects every password other than the exact one', async () => {
    await assertAsyncProperty(
      fc.asyncProperty(
        passwordArb.chain((password) =>
          otherPasswordArb(password).map((other) => [password, other] as const),
        ),
        async ([password, other]) => {
          const stored = await hashPassword(password, { iterations: TEST_ITERATIONS });
          // Clause 2 — anything that is not the password fails.
          expect(await verifyPassword(other, stored)).toBe(false);
        },
      ),
    );
  });

  it('holds identically at the shipped iteration count', async () => {
    await assertAsyncProperty(
      fc.asyncProperty(passwordArb, async (password) => {
        const stored = await hashPassword(password);
        expectFixedWidthHash(stored, PBKDF2_ITERATIONS);
        expect(await verifyPassword(password, stored)).toBe(true);
        expect(await verifyPassword(`${password}!`, stored)).toBe(false);
        if (password.length >= 4) expect(stored.includes(password)).toBe(false);
      }),
      // 600,000 iterations costs ~80–300 ms per derivation and this case performs
      // three. The wide pass above covers the input space; this one covers the
      // shipped parameters.
      { numRuns: 30 },
    );
  });

  it('produces a distinct salt per hash, so identical passwords do not collide', async () => {
    await assertAsyncProperty(
      fc.asyncProperty(passwordArb, async (password) => {
        const a = await hashPassword(password, { iterations: TEST_ITERATIONS });
        const b = await hashPassword(password, { iterations: TEST_ITERATIONS });
        // Same input, different stored value: the salt is doing its job, and a hash
        // therefore cannot be used as an equality oracle for passwords.
        expect(a).not.toBe(b);
        expect(await verifyPassword(password, a)).toBe(true);
        expect(await verifyPassword(password, b)).toBe(true);
      }),
    );
  });

  it('fails closed on a corrupt or foreign stored value, and never throws', async () => {
    await assertAsyncProperty(
      fc.asyncProperty(
        passwordArb,
        fc.oneof(
          fc.string({ maxLength: 120 }),
          fc.constantFrom(
            '',
            '$$$$',
            'pbkdf2$sha256$600000$$',
            'pbkdf2$sha256$0$AAAA$AAAA',
            'pbkdf2$sha512$600000$AAAA$AAAA',
            'argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA',
            'pbkdf2$sha256$600000$not-base64!!$also-not-base64!!',
          ),
        ),
        async (password, stored) => {
          // Totality: a malformed credential row is a false, not an exception, so it
          // cannot be distinguished from a wrong password by the response.
          await expect(verifyPassword(password, stored)).resolves.toBe(false);
        },
      ),
    );
  });
});

describe('needsRehash marks anything below the current cost', () => {
  it('accepts a current hash and rejects a cheaper or foreign one', async () => {
    const current = await hashPassword('a-real-password-of-length', {
      iterations: PBKDF2_ITERATIONS,
    });
    expect(needsRehash(current)).toBe(false);

    const cheap = await hashPassword('a-real-password-of-length', { iterations: TEST_ITERATIONS });
    expect(needsRehash(cheap)).toBe(true);
    // A legacy hash must still verify — otherwise the upgrade path locks the
    // operator out instead of upgrading them.
    expect(await verifyPassword('a-real-password-of-length', cheap)).toBe(true);

    expect(needsRehash('not-a-hash')).toBe(true);
    expect(needsRehash('')).toBe(true);
  });
});

describe('timingSafeEqual', () => {
  it('agrees with byte equality for every generated pair', () => {
    assertProperty(
      fc.property(fc.uint8Array({ maxLength: 64 }), fc.uint8Array({ maxLength: 64 }), (a, b) => {
        const expected = a.length === b.length && a.every((byte, index) => byte === b[index]);
        expect(timingSafeEqual(a, b)).toBe(expected);
      }),
    );
  });
});
