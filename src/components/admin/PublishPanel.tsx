/**
 * Lifecycle controls: the transitions that are legal right now, and an honest account of what
 * happens after one is taken.
 *
 * The requirement this component exists to satisfy is 14.12 — "indicate that publishing is in
 * progress and report the actual deployment outcome rather than reporting success before the
 * change is live". So there is no success state on the commit. Publishing goes:
 *
 *   Publishing — live in about a minute   →   Live now
 *                                         →   Publish committed but the site build failed
 *                                         →   Publish committed. Deployment status is
 *                                             unavailable in this environment.
 *
 * The middle branch is the one that is usually missing from admin tools: the commit succeeded
 * and the site did not change, and the previous deployment is still serving (14.13). The third
 * exists because deploy status needs Cloudflare API credentials that a given environment may
 * not have — and "we cannot tell you" is a different statement from "it worked".
 *
 * Only transitions legal from the current status are rendered, from the same
 * `availableTransitions` the server enforces. When the publish gate would refuse, the reason
 * is shown against the fields that fail rather than as a disabled button with no explanation
 * (14.5).
 *
 * Requirements: 12.5, 12.7, 14.2, 14.4, 14.5, 14.12, 14.13, 26.6.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import { adminFetch, type FieldErrors } from '@/lib/admin/client';
import { availableTransitions } from '@/lib/products/transitions';
import { labelFor } from '@/lib/products/form-validation';
import type { Product, ProductStatusValue } from '@/schemas/product';
import type { Role } from '@/lib/auth/permissions';

export interface PublishPanelProps {
  product: Product;
  /** Publish-gate failures for the current draft, keyed by field. */
  blockers: FieldErrors;
  canWrite: boolean;
  canPublish: boolean;
  canDelete: boolean;
  onProduct: (product: Product) => void;
}

const STATUS_LABELS: Record<ProductStatusValue, string> = {
  DRAFT: 'Draft',
  REVIEW: 'In review',
  PUBLISHED: 'Published',
  UNPUBLISHED: 'Unpublished',
  OUT_OF_STOCK: 'Published — out of stock',
};

const ACTION_LABELS: Record<ProductStatusValue, string> = {
  DRAFT: 'Return to draft',
  REVIEW: 'Submit for review',
  PUBLISHED: 'Publish',
  UNPUBLISHED: 'Unpublish',
  OUT_OF_STOCK: 'Mark out of stock',
};

type DeployState = 'queued' | 'building' | 'success' | 'failure' | 'unknown';

type Phase =
  | { kind: 'idle' }
  | { kind: 'working'; to: ProductStatusValue }
  | { kind: 'gate'; fields: FieldErrors }
  | { kind: 'error'; message: string }
  | { kind: 'done'; to: ProductStatusValue }
  | { kind: 'deploying'; to: ProductStatusValue; state: DeployState; commitSha: string | null }
  | { kind: 'deployed'; commitSha: string | null }
  | { kind: 'deployFailed'; commitSha: string | null }
  | { kind: 'deployUnknown'; message: string };

const POLL_INTERVAL_MS = 5000;
/** Two minutes: a content-only build is about a minute, so this is generous, not hopeful. */
const POLL_LIMIT = 24;

export default function PublishPanel(props: PublishPanelProps): ReactElement {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [confirmDelete, setConfirmDelete] = useState('');
  const polls = useRef(0);

  // The role is not read from the session here: the panel is told what the operator may do,
  // and the server re-derives it anyway. `role` is reconstructed only to ask the transition
  // machine which targets to draw.
  const role: Role = props.canPublish ? 'owner' : props.canWrite ? 'editor' : 'viewer';
  const targets = availableTransitions(props.product.status, role);

  const blockerEntries = Object.entries(props.blockers);

  const poll = useCallback(async () => {
    const result = await adminFetch<{ state: DeployState; commitSha: string | null }>(
      '/api/admin/deploy-status',
    );
    if (!result.ok) {
      // A missing deploy-status configuration is not a publish failure. Saying so plainly is
      // the whole point of this branch.
      setPhase({ kind: 'deployUnknown', message: result.error.message });
      return true;
    }
    if (result.value.state === 'success') {
      setPhase({ kind: 'deployed', commitSha: result.value.commitSha });
      return true;
    }
    if (result.value.state === 'failure') {
      setPhase({ kind: 'deployFailed', commitSha: result.value.commitSha });
      return true;
    }
    setPhase((current) =>
      current.kind === 'deploying'
        ? { ...current, state: result.value.state, commitSha: result.value.commitSha }
        : current,
    );
    return false;
  }, []);

  useEffect(() => {
    if (phase.kind !== 'deploying') return;
    polls.current = 0;
    let cancelled = false;
    const timer = setInterval(() => {
      polls.current += 1;
      if (polls.current > POLL_LIMIT) {
        clearInterval(timer);
        setPhase({
          kind: 'deployUnknown',
          message:
            'The publish was committed. The build is taking longer than expected — check the build in Cloudflare.',
        });
        return;
      }
      void poll().then((finished) => {
        if (finished && !cancelled) clearInterval(timer);
      });
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // `poll` is stable; `phase.kind` is the trigger.
  }, [phase.kind, poll]);

  const transition = useCallback(
    async (to: ProductStatusValue) => {
      setPhase({ kind: 'working', to });
      const result = await adminFetch<{
        product: Product;
        deployTriggered: boolean;
        commitSha: string | null;
      }>(`/api/admin/products/${props.product.id}/transition`, { method: 'POST', body: { to } });

      if (!result.ok) {
        if (result.error.code === 'PUBLISH_GATE_FAILED') {
          setPhase({ kind: 'gate', fields: result.error.fields ?? {} });
          return;
        }
        setPhase({ kind: 'error', message: result.error.message });
        return;
      }

      props.onProduct(result.value.product);
      if (result.value.deployTriggered) {
        setPhase({ kind: 'deploying', to, state: 'queued', commitSha: result.value.commitSha });
      } else {
        setPhase({ kind: 'done', to });
      }
    },
    [props],
  );

  const duplicate = useCallback(async () => {
    setPhase({ kind: 'working', to: props.product.status });
    const result = await adminFetch<{ id: string }>(
      `/api/admin/products/${props.product.id}/duplicate`,
      { method: 'POST' },
    );
    if (!result.ok) {
      setPhase({ kind: 'error', message: result.error.message });
      return;
    }
    window.location.assign(`/admin/products/${result.value.id}?duplicated=1`);
  }, [props.product.id, props.product.status]);

  const remove = useCallback(async () => {
    setPhase({ kind: 'working', to: props.product.status });
    const result = await adminFetch<undefined>(`/api/admin/products/${props.product.id}`, {
      method: 'DELETE',
      body: { confirmSlug: confirmDelete },
    });
    if (!result.ok) {
      setPhase({ kind: 'error', message: result.error.message });
      return;
    }
    window.location.assign('/admin/products?deleted=1');
  }, [confirmDelete, props.product.id, props.product.status]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-body">
        Current status: <strong>{STATUS_LABELS[props.product.status]}</strong>
        {props.product.published && (
          <>
            {' — '}
            <span className="text-walnut">visible to customers</span>
          </>
        )}
      </p>

      {blockerEntries.length > 0 && (
        <div className="border border-taupe bg-white px-4 py-3">
          <h3 className="text-body font-medium text-espresso">Before this can be published</h3>
          <ul className="mt-2 flex flex-col gap-1 text-small">
            {blockerEntries.map(([path, messages]) => (
              <li key={path}>
                <strong>{labelFor(path)}</strong>: {messages.join(' ')}
              </li>
            ))}
          </ul>
        </div>
      )}

      {targets.length === 0 ? (
        <p className="text-small text-walnut">
          Your role cannot change this product&rsquo;s status.
        </p>
      ) : (
        <div className="flex flex-wrap gap-3">
          {targets.map((to) => (
            <button
              key={to}
              type="button"
              disabled={phase.kind === 'working'}
              onClick={() => void transition(to)}
              className="min-h-[44px] border border-espresso px-4 py-2 text-espresso hover:bg-espresso hover:text-ivory focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-champagne disabled:opacity-60"
            >
              {ACTION_LABELS[to]}
            </button>
          ))}
        </div>
      )}

      {/* Status of the last action. `aria-live` so it is announced, not just drawn. */}
      <div aria-live="polite" className="text-small">
        {phase.kind === 'working' && <span>Working…</span>}
        {phase.kind === 'gate' && (
          <div className="border border-espresso bg-white px-4 py-3">
            <p className="font-medium text-espresso">This product is not ready to publish yet.</p>
            <ul className="mt-2 flex flex-col gap-1">
              {Object.entries(phase.fields).map(([path, messages]) => (
                <li key={path}>
                  <strong>{labelFor(path)}</strong>: {messages.join(' ')}
                </li>
              ))}
            </ul>
          </div>
        )}
        {phase.kind === 'error' && <span className="text-espresso">{phase.message}</span>}
        {phase.kind === 'done' && (
          <span>
            Saved as {STATUS_LABELS[phase.to]}. This status is not visible to customers, so no site
            build was started.
          </span>
        )}
        {phase.kind === 'deploying' && (
          <span>
            {phase.state === 'building'
              ? 'Publishing — the site is building, live in about a minute.'
              : 'Publishing — live in about a minute.'}
          </span>
        )}
        {phase.kind === 'deployed' && <span>Live now.</span>}
        {phase.kind === 'deployFailed' && (
          <span className="text-espresso">
            Publish committed but the site build failed
            {phase.commitSha === null ? '' : ` (build ${phase.commitSha.slice(0, 8)})`}. The
            previous version of the site is still serving — fix the content and publish again.
          </span>
        )}
        {phase.kind === 'deployUnknown' && <span className="text-espresso">{phase.message}</span>}
      </div>

      <div className="flex flex-col gap-3 border-t border-taupe pt-4">
        {props.canWrite && (
          <div>
            <button
              type="button"
              onClick={() => void duplicate()}
              className="min-h-[44px] border border-espresso px-4 py-2 text-espresso"
            >
              Duplicate this product
            </button>
            <p className="mt-1 text-small text-walnut">
              Creates a new draft with a new SKU and web address. This product is untouched.
            </p>
          </div>
        )}

        {props.canDelete && (
          <div className="flex flex-col gap-2">
            <label htmlFor="confirm-delete" className="text-small font-medium text-espresso">
              Delete this product
            </label>
            <p className="text-small text-walnut">
              Type its web address <code>{props.product.slug}</code> to confirm. This removes the
              page, the listing, the search entry and the sitemap entry at the next build.
            </p>
            <div className="flex flex-wrap gap-2">
              <input
                id="confirm-delete"
                type="text"
                value={confirmDelete}
                onChange={(event) => setConfirmDelete(event.target.value)}
                className="min-h-[44px] border border-taupe px-3 py-2"
              />
              <button
                type="button"
                disabled={confirmDelete !== props.product.slug}
                onClick={() => void remove()}
                className="min-h-[44px] border border-espresso px-4 py-2 text-espresso disabled:opacity-50"
              >
                Delete permanently
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
