import type { Turn } from './assistant.js';
import type { DraftFindings } from './findings.js';
import { z } from 'zod';
import { lineRange } from './assistant.js';
import { pullRequestUrl, reviewKey } from './reviews.js';

export const decision = z.enum(['COMMENT', 'APPROVE', 'REQUEST_CHANGES']);
const text = z.string().max(60000);
export const commentAnchor = lineRange;
export type CommentAnchor = z.infer<typeof commentAnchor>;
export const draft = commentAnchor.extend({
  id: z.uuid(),
  revision: z.string(),
  excerpt: z.string(),
  body: text,
});
export const reviewDetails = z.object({ summary: text, event: decision });
export const pendingReview = z.object({
  token: z.uuid(),
  started: z.number(),
  revision: z.string().optional(),
  head: z.string(),
  actor: z.string(),
});
export const reviewBundle = reviewDetails.extend({
  version: z.number().int().nonnegative(),
  comments: z.array(draft),
  pending: pendingReview.nullable(),
  receipt: z.number().int().positive().nullable(),
});
export const editRequest = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('draft'),
    id: z.uuid().nullable(),
    body: text.trim().min(1),
    target: commentAnchor.extend({ revision: z.string() }).nullable(),
  }),
  reviewDetails.extend({ action: z.literal('to-summary'), id: z.uuid() }),
  z.object({ action: z.literal('discard'), id: z.uuid() }),
  reviewDetails.extend({ action: z.literal('details') }),
]);
// Drafts belong to any review. Publishing and receipts are GitHub-only.
export const draftKey = z.object({ url: reviewKey, version: z.number().int().nonnegative() });
export const bundleKey = z.object({ url: pullRequestUrl, version: z.number().int().nonnegative() });
export const publishKey = bundleKey.extend({ revision: z.string(), actor: z.string().min(1) });
export type Draft = z.infer<typeof draft>;
export type Bundle = z.infer<typeof reviewBundle>;
export type Edit = z.infer<typeof editRequest>;
export type PublishKey = z.infer<typeof publishKey>;
export type Pending = z.infer<typeof pendingReview>;
export interface PublishBridge {
  draftFindings(request: DraftFindings): Promise<{ turn: Turn; bundle: Bundle }>;
  reviewDrafts(url: string): Promise<Bundle>;
  editDrafts(url: string, version: number, edit: Edit): Promise<Bundle>;
  reviewIdentity(): Promise<string>;
  publishReview(key: PublishKey): Promise<Bundle>;
  checkSubmission(url: string): Promise<Bundle>;
  reopenDrafts(url: string, version: number): Promise<Bundle>;
  openReceipt(url: string): Promise<void>;
}
