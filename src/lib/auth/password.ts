/**
 * Password derivation and verification.
 *
 * PBKDF2-HMAC-SHA-256 via WebCrypto, because it is the only KDF available in both
 * the Workers runtime and Node without a native dependency, and because it is the
 * one the design specifies. 600,000 iterations is the OWASP 2023 floor for
 * PBKDF2-SHA-256; it costs a few hundred milliseconds per login, which is
 * acceptable for a handful of daily admin logins and is the same cost an attacker
 * pays per guess.
 *
 * Three properties this module exists to guarantee:
 *
 * 1. **The plaintext never leaves the caller's frame.** It is encoded, imported as
 *    a non-extractable key, and dropped. It is never logged, never stored, never
 *    put in an error message, and never part of the serialized hash — Property 54
 *    asserts the last of these directly.
 * 2. **The parameters travel with the hash.** `pbkdf2$sha256$<iterations>$<salt>$<key>`
 *    means raising the iteration count later is a one-line change plus
 *    `needsRehash`, not a migration that locks every operator out.
 * 3. **Comparison is constant-time.** A byte-wise early return would let an
 *    attacker who can submit candidate hashes recover the stored key a byte at a
 *    time.
 *
 * Design: Admin Authentication → Credential storage.
 * Requirements: 10.4, 25.16.
 */

/** The KDF identifier written into every hash this module produces. */
export const PASSWORD_ALGORITHM = 'pbkdf2';
/** The PRF identifier written into every hash this module produces. */
export const PASSWORD_DIGEST = 'sha256';
/** OWASP 2023 floor for PBKDF2-HMAC-SHA-256. Raise it; never lower it. */
export const PBKDF2_ITERATIONS = 600_000;
/** Salt length in bytes. 16 bytes is 128 bits of uniqueness per credential. */
export const SALT_BYTES = 16;
/** Derived key length in bytes. 32 bytes matches the SHA-256 output width. */
export const KEY_BYTES = 32;

/**
 * The lowest iteration count this module will produce or accept as current.
 * Anything below it is treated as legacy by `needsRehash` and upgraded on the next
 * successful login.
 */
const MIN_ACCEPTABLE_ITERATIONS = PBKDF2_ITERATIONS;

export interface HashOptions {
  /**
   * Iteration count override.
   *
   * This exists because the parameter is *stored with the hash* — that is the
   * design's stated reason for the serialization format, and a format whose
   * parameters can only ever hold one value is not actually parameterized. Two
   * callers use it: a future cost increase, and the property suite, which must
   * exercise `hashPassword`/`verifyPassword` across hundreds of generated inputs
   * and cannot spend 600,000 iterations on each. Production callers pass nothing
   * and get {@link PBKDF2_ITERATIONS}.
   */
  iterations?: number;
}

const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array | null {
  // `atob` is lenient about some malformed input and throws on the rest; a stored
  // hash that does not decode is a corrupt record, not an authentication success.
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function derive(plain: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(plain) as unknown as ArrayBuffer,
    'PBKDF2',
    false, // not extractable: the plaintext-derived key cannot be read back out
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as unknown as ArrayBuffer, iterations },
    material,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Derive a storable hash for `plain`.
 *
 * The returned string is the complete record: algorithm, digest, iteration count,
 * salt, and key. Nothing else needs to be stored alongside it, and by construction
 * it contains no substring of the plaintext.
 */
export async function hashPassword(plain: string, options: HashOptions = {}): Promise<string> {
  const iterations = options.iterations ?? PBKDF2_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error('PASSWORD_ITERATIONS_INVALID');
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await derive(plain, salt, iterations);
  return [
    PASSWORD_ALGORITHM,
    PASSWORD_DIGEST,
    String(iterations),
    toBase64(salt),
    toBase64(key),
  ].join('$');
}

interface ParsedHash {
  algorithm: string;
  digest: string;
  iterations: number;
  salt: Uint8Array;
  key: Uint8Array;
}

/** Parse a stored hash. Returns null for anything this module did not produce. */
function parseStoredHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 5) return null;
  const [algorithm, digest, iterationsRaw, saltRaw, keyRaw] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (algorithm !== PASSWORD_ALGORITHM || digest !== PASSWORD_DIGEST) return null;
  if (!/^[0-9]+$/.test(iterationsRaw)) return null;
  const iterations = Number(iterationsRaw);
  if (!Number.isInteger(iterations) || iterations < 1) return null;
  const salt = fromBase64(saltRaw);
  const key = fromBase64(keyRaw);
  if (salt === null || key === null) return null;
  if (salt.length === 0 || key.length === 0) return null;
  return { algorithm, digest, iterations, salt, key };
}

/**
 * Constant-time byte comparison.
 *
 * Lengths are compared up front. That is not a leak here: both operands are
 * fixed-width derived keys, so their length carries no information about the
 * secret — only the *contents* do, and those are compared without branching.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * Verify `plain` against a stored hash.
 *
 * Re-derives with the parameters recorded in `stored`, so a hash produced under an
 * older iteration count still verifies. Returns false — never throws — for a
 * malformed or truncated stored value, because a corrupt credential row must fail
 * closed rather than surface a 500 that distinguishes it from a wrong password.
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parsed = parseStoredHash(stored);
  if (parsed === null) return false;
  const candidate = await derive(plain, parsed.salt, parsed.iterations);
  return timingSafeEqual(candidate, parsed.key);
}

/**
 * True when `stored` should be replaced with a fresh hash on the next successful
 * login: unparseable, a different algorithm, or a cost below the current floor.
 *
 * The caller does the upgrade at the one moment it has the plaintext in hand and
 * has already proved it correct.
 */
export function needsRehash(stored: string): boolean {
  const parsed = parseStoredHash(stored);
  if (parsed === null) return true;
  if (parsed.iterations < MIN_ACCEPTABLE_ITERATIONS) return true;
  if (parsed.salt.length < SALT_BYTES) return true;
  if (parsed.key.length < KEY_BYTES) return true;
  return false;
}

/**
 * A syntactically valid hash of a value no one holds, for the unknown-email login
 * path.
 *
 * `POST /api/admin/login` must spend the same CPU whether or not the address
 * exists, otherwise the response time answers "is this an account?" on its own.
 * The salt is fixed and the key is arbitrary: nothing verifies against it, and it
 * is never stored.
 */
export const DUMMY_PASSWORD_HASH = [
  PASSWORD_ALGORITHM,
  PASSWORD_DIGEST,
  String(PBKDF2_ITERATIONS),
  toBase64(new Uint8Array(SALT_BYTES)),
  toBase64(new Uint8Array(KEY_BYTES)),
].join('$');
