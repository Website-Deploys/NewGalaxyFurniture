import { describe, expect, it, vi } from 'vitest';

import {
  AppError,
  ERROR_CODES,
  disclosureRisk,
  errorEnvelope,
  isDisclosureSafe,
  logServerError,
  minutesPhrase,
  redactSecrets,
  statusForErrorCode,
  toClientError,
  toClientErrorResponse,
} from '@/lib/errors';

import { auditSource, catchBlocks, withoutComments } from '../../scripts/audit-error-disclosure';

/**
 * The disclosure boundary: nothing internal crosses it, everything internal is logged.
 *
 * Requirement 25.14 is a negative claim — "no stack trace, file path, internal identifier, upstream
 * provider body, or credential" — and a negative claim needs adversarial inputs rather than a happy
 * path. Each case below is a value something in this codebase genuinely throws: a `TypeError` from a
 * bad property read, a GitHub error object carrying a token in a header echo, a D1 error naming a
 * table, a bundler path, a provider URL.
 *
 * The companion property test generates them (`tests/property/errors.property.test.ts`); these pin
 * the specific shapes and the log's behaviour, which a property test cannot assert as precisely.
 *
 * Requirements: 25.13, 25.14, 25.15, 26.10.
 */

/** Things that must never appear in a response body. */
const LEAKY_VALUES = [
  'Error: connect ECONNREFUSED 10.0.0.5:443\n    at Socket.emit (node:events:517:28)',
  '/projects/sandbox/NewGalaxyFurniture/src/lib/github/client.ts:198:11',
  'file:///var/task/index.js',
  'C:\\Users\\operator\\ngf\\src\\lib\\env.ts',
  '/root/.npm/_cacache is unreadable',
  'node_modules/@octokit/request/dist-node/index.js',
  'https://api.github.com/repos/owner/repo/contents/data/products/x.json returned 401',
  'D1_ERROR: no such table: sessions',
  'SELECT * FROM admin_users WHERE email = ?',
  `Authorization: Bearer ghp_${'a'.repeat(36)}`,
  `{"api_key":"sk-${'b'.repeat(32)}"}`,
  'GITHUB_TOKEN is not set',
  'the SESSIONS binding is undefined',
  'TypeError: Cannot read properties of undefined (reading \u0027sha\u0027)',
];

describe('the disclosure filter', () => {
  it('recognises every shape of internal detail this codebase can throw', () => {
    for (const value of LEAKY_VALUES) {
      expect(disclosureRisk(value), value.slice(0, 48)).not.toBeNull();
      expect(isDisclosureSafe(value)).toBe(false);
    }
  });

  it('passes the sentences the design actually specifies', () => {
    const safe = [
      'Could not save to the content repository. Your changes are kept locally — retry.',
      'Too many attempts. Try again in 3 minutes.',
      'Suggestions are unavailable right now. Continue filling the form manually — nothing you have typed is affected.',
      'This product is not ready to publish yet.',
      'Enter a phone number we can reach you on, like 98765 43210.',
      'The image is 640 px wide. Photographs need to be at least 800 px wide.',
      // A URL path in a message is fine: the site's own routes are public by definition.
      'Browse the Catalogue at /collection and pick another piece.',
    ];
    for (const sentence of safe) {
      expect(disclosureRisk(sentence), sentence.slice(0, 48)).toBeNull();
    }
  });
});

describe('toClientError', () => {
  it('turns an unrecognised throw into INTERNAL_ERROR and says nothing else', () => {
    for (const thrown of [
      new TypeError('Cannot read properties of undefined (reading \u0027sha\u0027)'),
      { status: 401, body: `{"message":"Bad credentials","token":"ghp_${'c'.repeat(36)}"}` },
      'SELECT * FROM leads',
      undefined,
      null,
      42,
    ]) {
      const envelope = toClientError(thrown);
      expect(envelope.error).toBe(ERROR_CODES.INTERNAL_ERROR);
      expect(envelope.message).toBe('Something went wrong. Nothing was changed — try again.');
      expect(envelope.fields).toBeUndefined();
      expect(isDisclosureSafe(JSON.stringify(envelope))).toBe(true);
    }
  });

  it('carries an AppError through with its code, message and fields', () => {
    const envelope = toClientError(
      new AppError(ERROR_CODES.PUBLISH_GATE_FAILED, {
        fields: { images: ['Add at least one photograph before publishing.'] },
      }),
    );
    expect(envelope.error).toBe(ERROR_CODES.PUBLISH_GATE_FAILED);
    expect(envelope.message).toBe('This product is not ready to publish yet.');
    expect(envelope.fields?.images).toEqual(['Add at least one photograph before publishing.']);
  });

  it('replaces an AppError message that carries internal detail, rather than redacting it', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      // The careless call site the filter exists for.
      const envelope = toClientError(
        new AppError(ERROR_CODES.REPOSITORY_UNAVAILABLE, {
          message: String(new Error('write to /var/task/data/products/x.json failed')),
        }),
      );
      expect(envelope.message).toBe(
        'Could not save to the content repository. Your changes are kept locally — retry.',
      );
      expect(envelope.message).not.toContain('/var/task');
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('replaces a field message that carries internal detail, keeping the field name', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const envelope = errorEnvelope(ERROR_CODES.VALIDATION_FAILED, {
        fields: {
          images: ['D1_ERROR: no such table: product_images'],
          name: ['Enter a name of at least 2 characters.'],
        },
      });
      expect(envelope.fields?.images).toEqual(['This value could not be accepted.']);
      // An honest validation message beside it is untouched.
      expect(envelope.fields?.name).toEqual(['Enter a name of at least 2 characters.']);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('holds for every response the envelope builds, headers included', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = toClientErrorResponse(
        new Error('ECONNREFUSED at /home/runner/work/src/lib/github/client.ts:12:3'),
      );
      expect(response.status).toBe(500);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
      const body = await response.text();
      expect(isDisclosureSafe(body)).toBe(true);
      expect(body).not.toContain('github');
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps the status table and the code union in step', () => {
    for (const code of Object.values(ERROR_CODES)) {
      const status = statusForErrorCode(code);
      expect(status, code).toBeGreaterThanOrEqual(400);
      expect(status, code).toBeLessThan(600);
      const envelope = errorEnvelope(code);
      expect(envelope.message.length, code).toBeGreaterThan(0);
      expect(isDisclosureSafe(envelope.message), code).toBe(true);
    }
  });

  it('states whole minutes, and never zero', () => {
    expect(minutesPhrase(0.2)).toBe('1 minute');
    expect(minutesPhrase(1)).toBe('1 minute');
    expect(minutesPhrase(2.1)).toBe('3 minutes');
    expect(minutesPhrase(-5)).toBe('1 minute');
  });
});

describe('the no-leak guarantee, over every combination this codebase can produce', () => {
  /*
   * Exhaustive rather than sampled, and deterministic rather than generated.
   *
   * The input space that matters is small and enumerable: every error code × every leaky fragment ×
   * every position the fragment can occupy in a sentence × the three channels a string can travel on
   * (message, field message, thrown value). That is 14 × 4 × 3 × 20 combinations, which runs in
   * milliseconds — so there is no reason to sample it, and a numbered property would be a weaker
   * claim over the same space.
   *
   * The positional variants exist because a filter written against `^` or `$` anchors, or one that
   * only inspects the first line, passes a leading-position test and leaks everywhere else.
   */
  const positions = (fragment: string): string[] => [
    fragment,
    `Could not save. ${fragment}`,
    `${fragment} — try again.`,
    `Something went wrong:\n${fragment}\nRetry when you can.`,
  ];

  it('never lets a leaky fragment through any channel, in any position, under any code', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      for (const code of Object.values(ERROR_CODES)) {
        for (const fragment of LEAKY_VALUES) {
          for (const message of positions(fragment)) {
            const asMessage = JSON.stringify(errorEnvelope(code, { message }));
            const asField = JSON.stringify(errorEnvelope(code, { fields: { name: [message] } }));
            const asThrown = JSON.stringify(
              toClientError(new AppError(code, { message, fields: { name: [message] } })),
            );
            for (const body of [asMessage, asField, asThrown]) {
              expect(isDisclosureSafe(body), `${code}: ${fragment.slice(0, 40)}`).toBe(true);
            }
          }
        }
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('never lets a raw throw through, whatever was thrown', () => {
    const thrownValues: unknown[] = [
      ...LEAKY_VALUES.map((value) => new Error(value)),
      ...LEAKY_VALUES.map((value) => value),
      ...LEAKY_VALUES.map((value) => ({ message: value, stack: value })),
      new TypeError('undefined is not a function'),
      Object.assign(new Error('upstream'), {
        response: { status: 401, url: 'https://api.github.com/x' },
      }),
      Symbol('sym'),
      () => 'a function',
      new Map([['GITHUB_TOKEN', 'ghp_secret']]),
    ];
    for (const thrown of thrownValues) {
      const envelope = toClientError(thrown);
      expect(isDisclosureSafe(JSON.stringify(envelope)), String(thrown).slice(0, 40)).toBe(true);
      expect(envelope.error).toBe(ERROR_CODES.INTERNAL_ERROR);
    }
  });
});

describe('logServerError', () => {
  function captured(run: () => void): string {
    const lines: string[] = [];
    const spy = vi
      .spyOn(console, 'error')
      .mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' ')));
    try {
      run();
    } finally {
      spy.mockRestore();
    }
    return lines.join('\n');
  }

  it('records the detail the response withholds', () => {
    const error = new Error('write failed for data/products/sofa.json');
    const line = captured(() => {
      logServerError('products: patch failed', error, { id: 'p_abc1234567', attempt: 2 });
    });
    expect(line).toContain('[products: patch failed]');
    expect(line).toContain('write failed for data/products/sofa.json');
    // The stack is the point of the log: a path and a line number are useful here.
    expect(line).toContain('errors.disclosure.test');
    expect(line).toContain('id=p_abc1234567');
    expect(line).toContain('attempt=2');
  });

  it('redacts every credential shape before it reaches the log', () => {
    const token = `ghp_${'d'.repeat(36)}`;
    const line = captured(() => {
      logServerError('github: write failed', {
        status: 401,
        headers: { authorization: `Bearer ${token}` },
        body: `{"api_key":"sk-${'e'.repeat(32)}"}`,
      });
    });
    expect(line).not.toContain(token);
    expect(line).not.toContain('e'.repeat(32));
    expect(line).toContain('[REDACTED]');
  });

  it('follows a cause chain and survives an unserialisable throw', () => {
    const line = captured(() => {
      logServerError('drafts: read failed', new Error('outer', { cause: new Error('inner') }));
    });
    expect(line).toContain('caused by Error: inner');

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const cyclicLine = captured(() => {
      logServerError('anything', cyclic);
    });
    expect(cyclicLine).toContain('unserialisable');

    const nullish = captured(() => {
      logServerError('anything', null);
    });
    expect(nullish).toContain('nullish');
  });

  it('bounds an upstream body so one log line cannot consume the budget', () => {
    const line = captured(() => {
      logServerError('ai: generation failed', { body: 'x'.repeat(10_000) });
    });
    expect(line.length).toBeLessThan(4_000);
  });

  it('shares its redactor with the AI module rather than keeping a second copy', async () => {
    const { redactSecrets: fromAi } = await import('@/lib/ai/generate');
    expect(fromAi).toBe(redactSecrets);
  });
});

describe('the source audit that keeps the boundary a chokepoint', () => {
  it('rejects an error body built outside the envelope module', () => {
    const source = `
      export function GET() {
        return new Response(JSON.stringify({ error: 'BOOM', message: 'x' }), { status: 500 });
      }`;
    expect(auditSource('src/pages/api/x.ts', source, true).map((p) => p.rule)).toContain(
      'only src/lib/errors.ts builds an error body',
    );
  });

  it('rejects a catch block that constructs its own Response', () => {
    const source = `
      export async function POST() {
        try { await write(); } catch (error) {
          logServerError('x', error);
          return new Response('failed', { status: 500 });
        }
      }`;
    expect(auditSource('src/pages/api/x.ts', source, true).map((p) => p.rule)).toContain(
      'a catch block answers through the envelope',
    );
  });

  it('rejects a caught value handed to console.error', () => {
    const source = `
      try { await write(); } catch (error) { console.error('[x] failed', error); }`;
    expect(auditSource('src/lib/x.ts', source, false).map((p) => p.rule)).toContain(
      'a caught value is logged through logServerError',
    );
  });

  it('rejects a 5xx answered with nothing logged, and allows a 4xx branch', () => {
    const serverFault = `
      export async function POST() {
        try { bind(); } catch (error) {
          return errorResponse(ERROR_CODES.CONFIGURATION_INCOMPLETE);
        }
      }`;
    expect(auditSource('src/pages/api/x.ts', serverFault, true).map((p) => p.rule)).toContain(
      'a catch block that answers a server-side fault also logs it',
    );

    const clientFault = `
      export async function POST() {
        try { await request.formData(); } catch {
          return errorResponse(ERROR_CODES.VALIDATION_FAILED, { fields: { files: ['Bad body.'] } });
        }
      }`;
    expect(auditSource('src/pages/api/x.ts', clientFault, true)).toEqual([]);
  });

  it('accepts the shape every route in this codebase actually uses', () => {
    const source = `
      export async function POST() {
        try { return jsonResponse(await write()); } catch (error) {
          logServerError('products: create failed', error);
          return toClientErrorResponse(error);
        }
      }`;
    expect(auditSource('src/pages/api/x.ts', source, true)).toEqual([]);
  });

  it('reads catch bodies and ignores prose about them', () => {
    const source = `
      // console.error('[x] failed', error) — described, not called
      /* new Response(JSON.stringify({ error: 'X' })) in a comment */
      try { a(); } catch (error) { logServerError('x', error); }`;
    expect(auditSource('src/pages/api/x.ts', source, true)).toEqual([]);
    expect(catchBlocks(source)).toHaveLength(1);
    expect(withoutComments(source)).not.toContain('described, not called');
  });
});
