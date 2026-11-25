import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { ReviewRequest } from '../shared/review-requests.js';
import { missingCliMessage, signInMessage, type Graphql } from './github.js';
import {
  fetchReviewRequests,
  parseReviewRequestPage,
  requestsToAnnounce,
  reviewRequestMonitor,
  reviewRequestSearch,
} from './review-requests.js';
import { openStore } from './store.js';

type Node = Record<string, unknown> | null;
function pull(number: number, repo = 'Example/Project', extra: Record<string, unknown> = {}): Node {
  return {
    __typename: 'PullRequest',
    number,
    title: 'Change ' + number,
    isDraft: false,
    updatedAt: '2026-11-2' + (number % 10) + 'T12:00:00Z',
    headRefOid: String(number).repeat(40).slice(0, 40),
    author: { login: 'octo' },
    repository: { nameWithOwner: repo },
    reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'Reviewer' } }] },
    ...extra,
  };
}
function page(nodes: Node[], viewer = 'Reviewer', endCursor: string | null = null) {
  return JSON.stringify({
    data: {
      viewer: { login: viewer },
      search: { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes },
    },
  });
}
// A GitHub CLI stand-in whose account and list the test changes between checks.
function github(remote: { viewer: string; nodes: Node[]; failure?: string }) {
  const calls: Record<string, string>[] = [];
  const graphql: Graphql = (_, variables) => {
    calls.push(variables);
    return remote.failure
      ? Promise.reject(new Error(remote.failure))
      : Promise.resolve(page(remote.nodes, remote.viewer));
  };
  return { calls, graphql };
}
const listed = (inbox: Awaited<ReturnType<ReturnType<typeof reviewRequestMonitor>['sync']>>) => {
  assert.equal(inbox.state, 'listed');
  return inbox;
};
const numbers = (requests: ReviewRequest[]) => requests.map((r) => [r.number, r.unseen]);

await test('a search page yields the account, each requested PR and how it was requested', () => {
  const parsed = parseReviewRequestPage(
    page(
      [
        pull(7),
        pull(8, 'example/tools', {
          viewerLatestReview: { state: 'APPROVED' },
          isDraft: true,
          author: null,
          headRefOid: null,
          reviewRequests: {
            nodes: [
              { requestedReviewer: { __typename: 'Team' } },
              { requestedReviewer: { __typename: 'User', login: 'someone-else' } },
              { requestedReviewer: null },
            ],
          },
        }),
        // Search can return entries the token may not read, and other result kinds.
        null,
        { __typename: 'Issue' },
        // An owner the app cannot address by URL is left out, not treated as a failure.
        pull(9, 'managed_user/project'),
      ],
      'Reviewer',
      'cursor-1',
    ),
  );
  assert.equal(parsed.account, 'reviewer');
  assert.equal(parsed.next, 'cursor-1');
  assert.deepEqual(parsed.requests, [
    {
      repo: 'example/project',
      number: 7,
      title: 'Change 7',
      author: 'octo',
      isDraft: false,
      updatedAt: '2026-11-27T12:00:00Z',
      head: '7'.repeat(40),
      via: 'direct',
      approved: false,
    },
    {
      repo: 'example/tools',
      number: 8,
      title: 'Change 8',
      author: 'ghost',
      isDraft: true,
      updatedAt: '2026-11-28T12:00:00Z',
      head: null,
      via: 'team',
      approved: true,
    },
  ]);
});

await test('a malformed search response is rejected with a readable error', async () => {
  const signal = new AbortController().signal;
  assert.throws(() => parseReviewRequestPage('{"data":{"viewer":{"login":"reviewer"}}}'));
  assert.throws(() => parseReviewRequestPage(page([pull(7, 'example/project', { number: '7' })])));
  assert.throws(() =>
    parseReviewRequestPage(page([pull(7, 'example/project', { updatedAt: 'yesterday' })])),
  );
  for (const body of ['not json', '{"message":"Bad credentials"}', page([{ number: 7 }])])
    await assert.rejects(
      fetchReviewRequests(signal, () => Promise.resolve(body)),
      /could not read/,
    );
});

await test('every page of the search is read for one account', async () => {
  const signal = new AbortController().signal;
  const cursors: (string | undefined)[] = [];
  const result = await fetchReviewRequests(signal, (query, variables) => {
    assert.match(query, /^query ReviewRequests/);
    assert.equal(variables.q, reviewRequestSearch);
    cursors.push(variables.after);
    return Promise.resolve(
      variables.after ? page([pull(7), pull(6)]) : page([pull(8), pull(7)], 'Reviewer', 'next'),
    );
  });
  assert.deepEqual(cursors, [undefined, 'next']);
  assert.equal(result.account, 'reviewer');
  // A PR that moved between pages while they were read is listed once.
  assert.deepEqual(
    result.requests.map((r) => r.number),
    [8, 7, 6],
  );
  // An account that changes between pages would mix two people's requests.
  await assert.rejects(
    fetchReviewRequests(signal, (_, variables) =>
      Promise.resolve(
        variables.after ? page([pull(6)], 'other') : page([pull(8)], 'Reviewer', 'next'),
      ),
    ),
    /account changed/,
  );
});

await test('the first list is not announced, later arrivals are, and opening one clears it', async (t) => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const remote = { viewer: 'reviewer', nodes: [pull(7), pull(6)] };
  const { graphql } = github(remote);
  const announced: number[][] = [];
  const monitor = reviewRequestMonitor(
    store.reviewRequests,
    new AbortController().signal,
    graphql,
    (requests) => announced.push(requests.map((r) => r.number)),
  );
  assert.deepEqual(monitor.state(), { state: 'pending' });
  const first = listed(await monitor.sync());
  assert.equal(first.account, 'reviewer');
  assert.deepEqual(numbers(first.requests), [
    [7, false],
    [6, false],
  ]);
  assert.deepEqual(announced, []);
  assert.deepEqual(monitor.unseen(), []);

  remote.nodes = [pull(8, 'example/tools'), pull(7), pull(6)];
  const second = listed(await monitor.sync());
  assert.deepEqual(numbers(second.requests), [
    [8, true],
    [7, false],
    [6, false],
  ]);
  assert.deepEqual(announced, [[8]]);
  assert.deepEqual(monitor.unseen(), ['https://github.com/example/tools/pull/8']);
  // The PR open on screen is left out of the notification, and alone it raises none.
  const arrived = second.requests.filter((r) => r.unseen);
  assert.deepEqual(requestsToAnnounce(arrived, 'https://github.com/example/tools/pull/8'), []);
  assert.deepEqual(requestsToAnnounce(arrived, 'https://github.com/example/tools/pull/7'), arrived);
  assert.deepEqual(requestsToAnnounce(arrived, null), arrived);
  // A changes-requested or commented review is not an approval.
  remote.nodes = [
    pull(8, 'example/tools', { viewerLatestReview: { state: 'CHANGES_REQUESTED' } }),
    pull(7, 'Example/Project', { viewerLatestReview: { state: 'APPROVED' } }),
    pull(6),
  ];
  assert.deepEqual(
    listed(await monitor.sync()).requests.map((r) => r.approved),
    [false, true, false],
  );

  // The same list again announces nothing and keeps the mark.
  assert.deepEqual(numbers(listed(await monitor.sync()).requests)[0], [8, true]);
  assert.deepEqual(announced, [[8]]);

  assert.equal(store.reviewRequests.seen('https://github.com/example/project/pull/8'), false);
  assert.equal(store.reviewRequests.seen('local://not-a-pull-request'), false);
  assert.equal(store.reviewRequests.seen('https://github.com/example/tools/pull/8'), true);
  assert.deepEqual(monitor.unseen(), []);
  assert.deepEqual(numbers(listed(await monitor.sync()).requests)[0], [8, false]);
  assert.deepEqual(announced, [[8]]);
});

await test('a PR opened while GitHub is being read is not marked new again', async (t) => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const remote = { viewer: 'reviewer', nodes: [pull(6)] };
  const { graphql } = github(remote);
  let opened = false;
  const monitor = reviewRequestMonitor(
    store.reviewRequests,
    new AbortController().signal,
    (...args) => {
      if (opened) store.reviewRequests.seen('https://github.com/example/project/pull/7');
      return graphql(...args);
    },
  );
  await monitor.sync();
  remote.nodes = [pull(7), pull(6)];
  assert.deepEqual(numbers(listed(await monitor.sync()).requests)[0], [7, true]);
  opened = true;
  assert.deepEqual(numbers(listed(await monitor.sync()).requests)[0], [7, false]);
});

await test('a satisfied request leaves the list and is announced if it is requested again', async (t) => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const remote = { viewer: 'reviewer', nodes: [pull(7), pull(6)] };
  const { graphql } = github(remote);
  const announced: number[][] = [];
  const monitor = reviewRequestMonitor(
    store.reviewRequests,
    new AbortController().signal,
    graphql,
    (requests) => announced.push(requests.map((r) => r.number)),
  );
  await monitor.sync();
  remote.nodes = [pull(8), pull(7), pull(6)];
  await monitor.sync();
  // The review was submitted for one, and the other was closed before it was opened here.
  remote.nodes = [pull(6)];
  const after = listed(await monitor.sync());
  assert.deepEqual(numbers(after.requests), [[6, false]]);
  assert.deepEqual(monitor.unseen(), []);
  assert.deepEqual(store.reviewRequests.list('reviewer').length, 1);
  remote.nodes = [pull(7), pull(6)];
  assert.deepEqual(numbers(listed(await monitor.sync()).requests)[0], [7, true]);
  assert.deepEqual(announced, [[8], [7]]);
  remote.nodes = [];
  assert.deepEqual(listed(await monitor.sync()).requests, []);
});

await test('each GitHub account keeps its own list and its own first check', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'reviewer-requests-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'workspace.sqlite');
  const store = openStore(path);
  const remote = { viewer: 'first', nodes: [pull(6)] };
  const { graphql } = github(remote);
  const announced: [string, number[]][] = [];
  let clock = Date.parse('2026-11-25T10:00:00Z');
  const monitor = reviewRequestMonitor(
    store.reviewRequests,
    new AbortController().signal,
    graphql,
    (requests, account) => announced.push([account, requests.map((r) => r.number)]),
    () => (clock += 60_000),
  );
  await monitor.sync();
  remote.nodes = [pull(7), pull(6)];
  await monitor.sync();
  assert.deepEqual(announced, [['first', [7]]]);

  // Signing in as someone else lists that account's requests without announcing them.
  monitor.invalidate();
  remote.viewer = 'second';
  remote.nodes = [pull(9, 'other/project'), pull(7)];
  const second = listed(await monitor.sync());
  assert.equal(second.account, 'second');
  assert.deepEqual(numbers(second.requests), [
    [9, false],
    [7, false],
  ]);
  assert.deepEqual(announced, [['first', [7]]]);
  assert.deepEqual(monitor.unseen(), []);
  assert.deepEqual(numbers(store.reviewRequests.list('first')), [
    [7, true],
    [6, false],
  ]);

  // Back on the first account, its unopened request is still new and is not announced twice.
  monitor.invalidate();
  remote.viewer = 'first';
  remote.nodes = [pull(8), pull(7), pull(6)];
  const again = listed(await monitor.sync());
  assert.deepEqual(numbers(again.requests), [
    [8, true],
    [7, true],
    [6, false],
  ]);
  assert.deepEqual(announced, [
    ['first', [7]],
    ['first', [8]],
  ]);
  assert.deepEqual(numbers(store.reviewRequests.list('second')), [
    [9, false],
    [7, false],
  ]);
  store.close();

  // After a restart with no connection, the account checked last is shown from SQLite.
  const reopened = openStore(path);
  t.after(() => reopened.close());
  const offline = reviewRequestMonitor(reopened.reviewRequests, new AbortController().signal, () =>
    Promise.reject(new Error('Could not reach GitHub. Check your connection and retry.')),
  );
  const saved = listed(offline.state());
  assert.equal(saved.account, 'first');
  assert.equal(saved.error, null);
  assert.deepEqual(offline.unseen().length, 2);
  const failed = listed(await offline.sync());
  assert.deepEqual(numbers(failed.requests), numbers(again.requests));
  assert.equal(failed.checked, again.checked);
  assert.match(failed.error ?? '', /Could not reach GitHub/);
});

await test('signed-out, unavailable and recovered states are told apart', async (t) => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const remote: { viewer: string; nodes: Node[]; failure?: string } = {
    viewer: 'reviewer',
    nodes: [pull(6)],
    failure: 'GitHub rate limit reached. Retry after the limit resets.',
  };
  const { graphql, calls } = github(remote);
  const monitor = reviewRequestMonitor(store.reviewRequests, new AbortController().signal, graphql);
  assert.deepEqual(await monitor.sync(), { state: 'unavailable', message: remote.failure });
  for (const message of [signInMessage, missingCliMessage]) {
    remote.failure = message;
    assert.deepEqual(await monitor.sync(), { state: 'signed-out', message });
  }
  delete remote.failure;
  // Checks that overlap share one request to GitHub.
  const before = calls.length;
  const [one, two] = await Promise.all([monitor.sync(), monitor.sync()]);
  assert.equal(calls.length, before + 1);
  assert.equal(one, two);
  assert.equal(listed(one).error, null);
  // Signing out later hides the list. A later connection failure shows the saved one again.
  remote.failure = signInMessage;
  assert.equal((await monitor.sync()).state, 'signed-out');
  assert.deepEqual(monitor.unseen(), []);
  remote.failure = 'Could not reach GitHub. Check your connection and retry.';
  const saved = listed(await monitor.sync());
  assert.equal(saved.error, remote.failure);
  assert.equal(saved.requests.length, 1);
});

await test('a check dropped by a new sign-in saves nothing', async (t) => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  let release: (json: string) => void = () => {};
  const monitor = reviewRequestMonitor(
    store.reviewRequests,
    new AbortController().signal,
    () => new Promise<string>((resolve) => (release = resolve)),
  );
  const dropped = monitor.sync();
  monitor.invalidate();
  release(page([pull(6)]));
  assert.deepEqual(await dropped, { state: 'pending' });
  assert.equal(store.reviewRequests.lastAccount(), null);
});

await test('upgrading a version 25 workspace adds review requests and keeps saved work', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'reviewer-requests-upgrade-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'workspace.sqlite');
  const url = 'https://github.com/org/repo/pull/1';
  const current = openStore(path);
  current.save(url);
  current.assistant.add('org/repo');
  current.assistant.watch('org/repo', ['octo']);
  current.assistant.update(
    'org/repo',
    ['octo'],
    [{ number: 1, title: 'Saved PR', author: 'octo', approved: false, unseen: true }],
  );
  const saved = current.list();
  const repositories = current.assistant.repositories();
  current.close();
  const old = new DatabaseSync(path);
  old.exec(
    'DROP TABLE review_requests; DROP TABLE review_request_accounts; PRAGMA user_version=25',
  );
  old.close();

  const upgraded = openStore(path);
  assert.deepEqual(upgraded.list(), saved);
  assert.deepEqual(upgraded.assistant.repositories(), repositories);
  assert.equal(upgraded.assistant.unseen(), 1);
  assert.equal(upgraded.reviewRequests.lastAccount(), null);
  assert.deepEqual(upgraded.reviewRequests.list('reviewer'), []);
  assert.deepEqual(
    upgraded.reviewRequests.replace(
      'reviewer',
      [
        {
          repo: 'org/repo',
          number: 1,
          title: 'Saved PR',
          author: 'octo',
          isDraft: false,
          updatedAt: '2026-11-25T10:00:00Z',
          head: null,
          via: 'direct',
          approved: true,
        },
      ],
      '2026-11-25T10:01:00.000Z',
    ),
    [],
  );
  upgraded.close();
  const check = new DatabaseSync(path);
  t.after(() => check.close());
  assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 26);
  assert.equal(check.prepare('SELECT approved FROM review_requests').get()?.approved, 1);
});
