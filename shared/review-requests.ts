import { z } from 'zod';
import { login, repoName } from './assistant.js';

// An open pull request on github.com that asks the signed-in GitHub CLI account for a review.
export const reviewRequest = z.object({
  repo: repoName,
  number: z.number().int().positive(),
  title: z.string(),
  author: z.string().min(1),
  isDraft: z.boolean(),
  updatedAt: z.iso.datetime(),
  head: z.string().min(1).nullable(),
  // Whether GitHub names the account itself, or only a team it belongs to.
  via: z.enum(['direct', 'team']),
  // Whether the account's latest review on GitHub approves the PR.
  approved: z.boolean(),
  // Requested since the previous check and not opened yet.
  unseen: z.boolean(),
});
export type ReviewRequest = z.infer<typeof reviewRequest>;
export function reviewRequestUrl(request: Pick<ReviewRequest, 'repo' | 'number'>) {
  return 'https://github.com/' + request.repo + '/pull/' + request.number;
}
export const reviewRequestInbox = z.discriminatedUnion('state', [
  // Nothing has been read from GitHub yet and no earlier list is saved.
  z.object({ state: z.literal('pending') }),
  z.object({ state: z.literal('signed-out'), message: z.string() }),
  // The check failed and there is no saved list to fall back on.
  z.object({ state: z.literal('unavailable'), message: z.string() }),
  // `error` is set when the latest check failed and `requests` is the last saved list.
  z.object({
    state: z.literal('listed'),
    account: login,
    requests: reviewRequest.array(),
    checked: z.iso.datetime(),
    error: z.string().nullable(),
  }),
]);
export type ReviewRequestInbox = z.infer<typeof reviewRequestInbox>;
export interface ReviewRequestBridge {
  // The saved list, without contacting GitHub.
  reviewRequests(): Promise<ReviewRequestInbox>;
  syncReviewRequests(): Promise<ReviewRequestInbox>;
}
