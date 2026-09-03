/**
 * The image manager: upload, order, designate a primary, write alt text, remove.
 *
 * Four things it deliberately does:
 *
 * - **Reports each file's own outcome.** The upload endpoint answers with an accepted list and
 *   a rejected list, and the rejected reasons are shown per file — "narrower than 800 pixels"
 *   next to the file it applies to, with the other eleven photographs unaffected (26.8).
 * - **Reorders from the keyboard.** Drag-and-drop is offered, and every reorder is also a pair
 *   of buttons, because a drag-only interaction is unusable without a pointer (24.5). Either
 *   way the server renumbers `order` contiguously from 0.
 * - **Shows "optimizing" honestly.** While `derivativesReady` is false the row says so and the
 *   original is what serves — the image is usable, just not yet in every size (15.13).
 * - **Records who wrote the alt text.** Editing it here sets `altSource: 'admin'`; only the AI
 *   assistant sets `ai`. The badge reflects the stored value rather than a guess (15.15).
 *
 * Requirements: 13.8, 14.14, 14.15, 15.13, 15.14, 15.15, 15.16, 24.5, 26.8, 26.14.
 */

import { useCallback, useRef, useState } from 'react';
import type { DragEvent, ReactElement } from 'react';

import { adminFetch } from '@/lib/admin/client';
import { originalUrl, derivativeUrl, extFromMime } from '@/lib/images/srcset';
import type { ProductImageValue } from '@/schemas/product';
import { DropZoneGlyph } from '@/components/ui/EmptyState';

export interface ImageManagerProps {
  productId: string;
  images: readonly ProductImageValue[];
  primaryImage: string | null;
  canWrite: boolean;
  onChange: (images: ProductImageValue[], primaryImage: string | null) => void;
}

interface Rejection {
  filename: string;
  code: string;
  message: string;
}

interface UploadResponse {
  images: ProductImageValue[];
  rejected: Rejection[];
}

/** The thumbnail source: a small derivative once it exists, the original until then. */
function thumbnailFor(productId: string, image: ProductImageValue): string {
  if (image.derivativesReady === true && (image.derivativeWidths ?? []).length > 0) {
    const width = [...(image.derivativeWidths ?? [])].sort((a, b) => a - b)[0] ?? 320;
    return derivativeUrl(productId, image.id, width, 'webp');
  }
  return originalUrl(productId, image.id, extFromMime(image.mime));
}

export default function ImageManager(props: ImageManagerProps): ReactElement {
  const [busy, setBusy] = useState(false);
  const [rejected, setRejected] = useState<Rejection[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const dragFrom = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const upload = useCallback(
    async (files: FileList | File[]) => {
      const list = [...files];
      if (list.length === 0) return;
      setBusy(true);
      setMessage(`Uploading ${String(list.length)} file${list.length === 1 ? '' : 's'}…`);
      setRejected([]);

      const form = new FormData();
      for (const file of list) form.append('file', file);

      const result = await adminFetch<UploadResponse>(
        `/api/admin/products/${props.productId}/images`,
        { method: 'POST', formData: form },
      );
      setBusy(false);

      if (!result.ok) {
        // A 422 whose body carries per-file reasons still arrives as a failure envelope; the
        // per-file detail is more useful than the summary, so it is preferred when present.
        setMessage(result.error.message);
        return;
      }

      setRejected(result.value.rejected);
      const accepted = result.value.images;
      if (accepted.length > 0) {
        const next = [...props.images, ...accepted].map((image, index) => ({
          ...image,
          order: index,
        }));
        props.onChange(next, props.primaryImage ?? next[0]?.id ?? null);
      }
      setMessage(
        accepted.length === 0
          ? 'No files were accepted.'
          : `${String(accepted.length)} image${accepted.length === 1 ? '' : 's'} added. Optimized sizes are being generated.`,
      );
    },
    [props],
  );

  const commitOrder = useCallback(
    async (images: ProductImageValue[]) => {
      // Renumbered locally for an immediate redraw, and renumbered again by the server, which
      // is the copy that counts.
      const renumbered = images.map((image, index) => ({ ...image, order: index }));
      props.onChange(renumbered, props.primaryImage);
      const result = await adminFetch<{ images: ProductImageValue[] }>(
        `/api/admin/products/${props.productId}/images/order`,
        { method: 'PATCH', body: { orderedIds: renumbered.map((image) => image.id) } },
      );
      if (!result.ok) {
        setMessage(result.error.message);
        return;
      }
      props.onChange(result.value.images, props.primaryImage);
    },
    [props],
  );

  const move = useCallback(
    (from: number, to: number) => {
      if (to < 0 || to >= props.images.length || from === to) return;
      const next = [...props.images];
      const [moved] = next.splice(from, 1);
      if (moved === undefined) return;
      next.splice(to, 0, moved);
      void commitOrder(next);
    },
    [commitOrder, props.images],
  );

  const setAlt = useCallback(
    async (imageId: string, alt: string) => {
      const result = await adminFetch<{ images: ProductImageValue[]; primaryImage: string | null }>(
        `/api/admin/products/${props.productId}/images/${imageId}`,
        { method: 'PATCH', body: { alt } },
      );
      if (!result.ok) {
        setMessage(result.error.message);
        return;
      }
      props.onChange(result.value.images, result.value.primaryImage);
    },
    [props],
  );

  const setPrimary = useCallback(
    async (imageId: string) => {
      const result = await adminFetch<{ images: ProductImageValue[]; primaryImage: string | null }>(
        `/api/admin/products/${props.productId}/images/${imageId}`,
        { method: 'PATCH', body: { primary: true } },
      );
      if (!result.ok) {
        setMessage(result.error.message);
        return;
      }
      props.onChange(result.value.images, result.value.primaryImage);
    },
    [props],
  );

  const remove = useCallback(
    async (imageId: string) => {
      const result = await adminFetch<undefined>(
        `/api/admin/products/${props.productId}/images/${imageId}`,
        { method: 'DELETE' },
      );
      if (!result.ok) {
        setMessage(result.error.message);
        return;
      }
      const next = props.images
        .filter((image) => image.id !== imageId)
        .map((image, index) => ({ ...image, order: index }));
      props.onChange(
        next,
        props.primaryImage === imageId ? (next[0]?.id ?? null) : props.primaryImage,
      );
      setMessage('Image removed. It can be recovered for 30 days.');
    },
    [props],
  );

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragOver(false);
    if (!props.canWrite) return;
    void upload(event.dataTransfer.files);
  };

  return (
    <div className="flex flex-col gap-4">
      {props.canWrite && (
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={[
            'flex flex-col items-center gap-2 border-2 border-dashed px-6 py-8 text-center',
            dragOver ? 'border-champagne bg-white' : 'border-taupe',
          ].join(' ')}
        >
          {/*
            The designed "no images" empty state Requirement 26.14 asks for is this drop zone, with
            the drop-zone illustration the design names. The glyph appears only when there is nothing
            yet: above a list of photographs it would be decoration competing with the content.
          */}
          {props.images.length === 0 && <DropZoneGlyph />}
          <p className="text-body text-espresso">
            {props.images.length === 0
              ? 'No photographs yet — drop images here'
              : 'Drop more images here'}
          </p>
          <p className="max-w-[46ch] text-small text-walnut">
            JPEG, PNG, WebP or AVIF. At least 800 pixels wide, up to 12 MB each. Up to 20 images per
            product.
          </p>
          <input
            ref={inputRef}
            id="image-upload"
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp,image/avif"
            className="sr-only"
            onChange={(event) => {
              if (event.target.files !== null) void upload(event.target.files);
              event.target.value = '';
            }}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            className="min-h-[44px] border border-espresso px-4 py-2 text-espresso disabled:opacity-60"
          >
            Choose files
          </button>
        </div>
      )}

      <div aria-live="polite" className="text-small">
        {message !== null && <p>{message}</p>}
        {rejected.length > 0 && (
          <ul className="mt-2 flex flex-col gap-1">
            {rejected.map((rejection) => (
              <li key={`${rejection.filename}-${rejection.code}`} className="text-espresso">
                <strong>{rejection.filename}</strong>: {rejection.message}
              </li>
            ))}
          </ul>
        )}
      </div>

      {props.images.length === 0 ? (
        <p className="text-small text-walnut">
          A product needs at least one photograph with alt text before it can be published.
        </p>
      ) : (
        <ol className="flex flex-col gap-3">
          {props.images
            .slice()
            .sort((a, b) => a.order - b.order)
            .map((image, index) => {
              const isPrimary = (props.primaryImage ?? props.images[0]?.id) === image.id;
              return (
                <li
                  key={image.id}
                  draggable={props.canWrite}
                  onDragStart={() => {
                    dragFrom.current = index;
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (dragFrom.current !== null) move(dragFrom.current, index);
                    dragFrom.current = null;
                  }}
                  className="grid gap-3 border border-taupe bg-white p-3 md:grid-cols-[96px_1fr_auto]"
                >
                  <div className="relative">
                    <img
                      src={thumbnailFor(props.productId, image)}
                      alt={image.alt === '' ? 'Product photograph awaiting alt text' : image.alt}
                      width={96}
                      height={Math.max(1, Math.round((image.height * 96) / image.width))}
                      loading="lazy"
                      decoding="async"
                      className="w-24 bg-cream object-cover"
                      style={
                        image.lqip === undefined
                          ? undefined
                          : { backgroundImage: `url(${image.lqip})`, backgroundSize: 'cover' }
                      }
                    />
                    {image.derivativesReady !== true && (
                      <span className="mt-1 block text-small text-walnut">Optimizing…</span>
                    )}
                  </div>

                  <div className="flex flex-col gap-2">
                    <label
                      htmlFor={`alt-${image.id}`}
                      className="text-small font-medium text-espresso"
                    >
                      Alt text
                      <span className="ml-2 font-normal text-walnut">
                        {image.altSource === 'ai' ? 'AI suggestion' : 'Written by you'}
                      </span>
                    </label>
                    <input
                      id={`alt-${image.id}`}
                      type="text"
                      defaultValue={image.alt}
                      maxLength={180}
                      disabled={!props.canWrite}
                      onBlur={(event) => {
                        if (event.target.value !== image.alt)
                          void setAlt(image.id, event.target.value);
                      }}
                      className="min-h-[44px] border border-taupe px-3 py-2"
                      aria-describedby={`alt-hint-${image.id}`}
                    />
                    <p id={`alt-hint-${image.id}`} className="text-small text-walnut">
                      Describe the photograph for someone who cannot see it. Required to publish.
                      {image.filename === undefined ? '' : ` Uploaded as “${image.filename}”.`}{' '}
                      {image.width}×{image.height} pixels.
                    </p>
                  </div>

                  {props.canWrite && (
                    <div className="flex flex-col gap-1">
                      <span className="text-small text-walnut">Position {index + 1}</span>
                      <button
                        type="button"
                        onClick={() => move(index, index - 1)}
                        disabled={index === 0}
                        className="min-h-[44px] border border-taupe px-3 text-small disabled:opacity-40"
                      >
                        Move up
                      </button>
                      <button
                        type="button"
                        onClick={() => move(index, index + 1)}
                        disabled={index === props.images.length - 1}
                        className="min-h-[44px] border border-taupe px-3 text-small disabled:opacity-40"
                      >
                        Move down
                      </button>
                      <button
                        type="button"
                        onClick={() => void setPrimary(image.id)}
                        disabled={isPrimary}
                        className="min-h-[44px] border border-taupe px-3 text-small disabled:opacity-40"
                      >
                        {isPrimary ? 'Main photograph' : 'Make main'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void remove(image.id)}
                        className="min-h-[44px] border border-espresso px-3 text-small text-espresso"
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
        </ol>
      )}
    </div>
  );
}
