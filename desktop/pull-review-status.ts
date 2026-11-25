import { z } from 'zod';
import type { ApprovalStage } from '../shared/reviews.js';
import type { Graphql } from './github.js';

const reviewPage = z.object({
  nodes: z.array(
    z.object({ author: z.object({ login: z.string() }).nullable(), state: z.string() }),
  ),
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
});
const reviewFields = 'nodes{author{login} state} pageInfo{hasNextPage endCursor}';
export const pullReviewFields =
  'headRefOid commits(first:1){totalCount} reviewDecision latestOpinionatedReviews(first:100){' +
  reviewFields +
  '}';
export const pullReviewInfo = z.object({
  headRefOid: z.string().min(1),
  commits: z.object({ totalCount: z.number().int().nonnegative() }),
  reviewDecision: z.enum(['APPROVED', 'REVIEW_REQUIRED', 'CHANGES_REQUESTED']).nullable(),
  latestOpinionatedReviews: reviewPage.nullable(),
});
const continuation = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        headRefOid: z.string(),
        latestOpinionatedReviews: reviewPage,
      }),
    }),
  }),
});

// The aggregate decision and each reviewer's latest opinion describe different things.
// Keep the signed-in user's own approval independent of the PR-wide indicator.
export async function summarizePullReviews(
  pull: z.infer<typeof pullReviewInfo>,
  viewer: string,
  owner: string,
  name: string,
  number: number,
  graphql: Graphql,
  signal: AbortSignal,
) {
  let page = pull.latestOpinionatedReviews;
  let anyApproval = false;
  let approved = false;
  const cursors = new Set<string>();
  while (page) {
    for (const review of page.nodes) {
      if (review.state !== 'APPROVED') continue;
      anyApproval = true;
      if (review.author?.login.toLowerCase() === viewer.toLowerCase()) approved = true;
    }
    if (approved || !page.pageInfo.hasNextPage) break;
    const after = page.pageInfo.endCursor;
    if (!after || cursors.has(after)) throw new Error('Could not page through PR reviews.');
    cursors.add(after);
    const query =
      'query($owner:String!,$name:String!,$after:String!){repository(owner:$owner,name:$name){pullRequest(number:' +
      number +
      '){headRefOid latestOpinionatedReviews(first:100,after:$after){' +
      reviewFields +
      '}}}}';
    const next = continuation.parse(
      JSON.parse(await graphql(query, { owner, name, after }, signal)),
    ).data.repository.pullRequest;
    if (next.headRefOid !== pull.headRefOid)
      throw new Error('The PR changed while reading reviews.');
    page = next.latestOpinionatedReviews;
  }
  let stage: ApprovalStage = 'none';
  switch (pull.reviewDecision) {
    case 'APPROVED':
      stage = 'approved';
      break;
    case 'CHANGES_REQUESTED':
      stage = anyApproval ? 'mixed' : 'changes-requested';
      break;
    case 'REVIEW_REQUIRED':
      if (anyApproval) stage = 'partial';
      break;
    case null:
      if (anyApproval) stage = 'approval-recorded';
      break;
  }
  return {
    approved,
    head: pull.headRefOid,
    commitCount: pull.commits.totalCount,
    approvalStage: stage,
  };
}
