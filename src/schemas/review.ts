/**
 * Review schema.
 *
 * Reviews are operator-entered testimonials. Nothing here is ever generated: no
 * review text, no rating, no customer name (requirement 18.9), and nothing is
 * public until an operator sets `status: 'PUBLISHED'` (requirement 18.8).
 *
 * Design: Data Models → Other collections.
 * Requirements: 18.6, 18.7, 18.8, 18.9.
 */

import { z } from 'zod';

export const ReviewStatus = z.enum(['DRAFT', 'PUBLISHED', 'UNPUBLISHED']);

export const ReviewSchema = z
  .object({
    id: z.string(),
    customerName: z.string().min(1).max(80),
    rating: z.number().int().min(1).max(5),
    text: z.string().min(5).max(1500),
    customerPhotoKey: z.string().optional(),
    productPhotoKey: z.string().optional(),
    videoKey: z.string().optional(),
    productId: z.string().optional(),
    date: z.string().date().optional(),
    status: ReviewStatus,
    featured: z.boolean().default(false),
    order: z.number().int().default(0),
  })
  .passthrough();

export type Review = z.infer<typeof ReviewSchema>;
export type ReviewStatusValue = z.infer<typeof ReviewStatus>;
