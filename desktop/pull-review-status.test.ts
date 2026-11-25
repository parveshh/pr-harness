import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupReviews } from '../shared/repository-groups.js';
import type { Repository } from '../shared/assistant.js';
import type { SavedReview } from '../shared/reviews.js';
import { summarizePullReviews } from './pull-review-status.js';

await test('approval on a later review page is independent of the viewer and aggregate decision', async () => {
  for (const [decision, stage] of [
    ['REVIEW_REQUIRED', 'partial'],
    ['APPROVED', 'approved'],
    ['CHANGES_REQUESTED', 'mixed'],
    [null, 'approval-recorded'],
  ] as const) {
    const summary = await summarizePullReviews(
      {
        headRefOid: 'abc1234',
        commits: { totalCount: 5 },
        reviewDecision: decision,
        latestOpinionatedReviews: {
          nodes: [{ author: { login: 'me' }, state: 'DISMISSED' }],
          pageInfo: { hasNextPage: true, endCursor: 'next' },
        },
      },
      'me',
      'org',
      'repo',
      7,
      async (query, variables) => {
        assert.match(query, /after:\$after/);
        assert.deepEqual(variables, { owner: 'org', name: 'repo', after: 'next' });
        return Promise.resolve(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  headRefOid: 'abc1234',
                  latestOpinionatedReviews: {
                    nodes: [{ author: { login: 'other' }, state: 'APPROVED' }],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          }),
        );
      },
      new AbortController().signal,
    );
    assert.deepEqual(summary, {
      head: 'abc1234',
      commitCount: 5,
      approved: false,
      approvalStage: stage,
    });
  }
});

await test('an older monitored row uses the saved status only for the matching revision', () => {
  const pull = { number: 2, title: 'Change', author: 'dev', approved: false, unseen: false };
  const repo: Repository = {
    name: 'org/repo',
    authors: ['dev'],
    watching: ['dev'],
    pulls: [pull],
    checked: null,
    error: null,
  };
  const saved: SavedReview = {
    url: 'https://github.com/org/repo/pull/2',
    savedAt: new Date().toISOString(),
    head: 'old',
    commitCount: 3,
    approvalStage: 'partial',
  };
  const grouped = () => groupReviews([repo], [saved]).get(repo.name)?.pulls[0]?.pull;
  assert.deepEqual(grouped(), { ...pull, head: 'old', commitCount: 3, approvalStage: 'partial' });
  repo.pulls = [{ ...pull, head: 'new' }];
  assert.deepEqual(grouped(), { ...pull, head: 'new' });
  repo.pulls = [{ ...pull, head: 'old', approvalStage: 'none' }];
  assert.equal(grouped()?.approvalStage, 'none');
  saved.isDraft = true;
  assert.equal(grouped()?.isDraft, true);
  repo.pulls = [{ ...pull, isDraft: false }];
  assert.equal(grouped()?.isDraft, false);
});
