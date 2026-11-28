import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { discussions } from '../shared/discussions.js';
import { listDiscussions, resolveDiscussion, sendDiscussionReply } from './discussions.js';

await test('discussion pagination, reply targets, account switching and recovery after a lost receipt', async () => {
  const url = 'https://github.com/example/pull/pull/7';
  const signal = new AbortController().signal;
  const identity = () => Promise.resolve('alice');
  const req = {
    url,
    account: 'alice',
    id: 1,
    kind: 'inline' as const,
    body: 'Answered in the caller.',
    token: randomUUID(),
  };
  const row = (id: number, body = 'Question?') => ({
    id,
    body,
    user: { login: 'alice' },
    created_at: '2026-01-01T00:00:00Z',
  });
  const root = { ...row(1), path: 'src/feature.ts', line: null, original_line: 28 };
  const replies = Array.from({ length: 99 }, (_, i) => ({ ...row(i + 2), in_reply_to_id: 1 }));
  const writes: string[] = [];
  let loseReceipt = true;
  const connect = () =>
    Promise.resolve({
      actor: 'alice',
      serverTime: Date.now(),
      api: (path: string) => {
        assert.ok(path.startsWith('repos/example/pull/'));
        if (path.includes('/reviews?'))
          return Promise.resolve(
            JSON.stringify([
              { ...row(202), state: 'COMMENTED' },
              { ...row(203), state: 'PENDING' },
            ]),
          );
        if (path.includes('/issues/7/comments?'))
          return Promise.resolve(JSON.stringify([row(301)]));
        assert.match(path, /pulls\/7\/comments\?/);
        const page = path.endsWith('page=1') ? [root, ...replies.slice(0, 99)] : replies.slice(99);
        return Promise.resolve(JSON.stringify(page));
      },
      // This PR's resolved state cannot be read. Its comments are listed all the same.
      graphql: () => Promise.reject(Error('GraphQL unavailable')),
      postComment: (endpoint: string, body: string) => {
        writes.push(endpoint);
        const receipt = { ...row(1000 + writes.length, body), in_reply_to_id: 1 };
        if (endpoint.endsWith('/replies')) replies.push(receipt);
        if (loseReceipt) {
          loseReceipt = false;
          return Promise.reject(Error('Unknown delivery'));
        }
        return Promise.resolve(JSON.stringify(receipt));
      },
    });
  const snapshot = await listDiscussions(url, signal, connect, identity);
  assert.equal(snapshot.threads.length, 3);
  assert.equal(snapshot.threads.find((t) => t.kind === 'inline')?.messages.length, 100);
  assert.equal(snapshot.threads.find((t) => t.kind === 'inline')?.resolution, null);
  await assert.rejects(
    listDiscussions(url, signal, connect, () => Promise.resolve('other')),
    /account changed/,
  );
  await assert.rejects(
    sendDiscussionReply({ ...req, account: 'other' }, signal, connect, identity),
    /account changed/,
  );
  await assert.rejects(
    sendDiscussionReply({ ...req, kind: 'conversation', id: 404 }, signal, connect, identity),
    /no longer/,
  );
  await assert.rejects(sendDiscussionReply(req, signal, connect, identity), /Unknown delivery/);
  assert.equal((await sendDiscussionReply(req, signal, connect, identity)).id, 1001);
  assert.deepEqual(writes, ['repos/example/pull/pulls/7/comments/1/replies']);
  for (const [kind, id, anchor] of [
    ['review', 202, 'pullrequestreview-202'],
    ['conversation', 301, 'issuecomment-301'],
  ] as const) {
    const result = await sendDiscussionReply(
      { ...req, kind, id, token: randomUUID() },
      signal,
      connect,
      identity,
    );
    assert.ok(result.body.includes(url + '#' + anchor));
    assert.equal(writes.at(-1), 'repos/example/pull/issues/7/comments');
  }
});

await test('review threads carry their resolved state across pages and can be resolved or reopened', async () => {
  const url = 'https://github.com/example/project/pull/7';
  const signal = new AbortController().signal;
  const resolved = new Set(['T_two']);
  const calls: [string, Record<string, string>][] = [];
  const comment = (id: number) => ({
    id,
    body: 'Question?',
    user: { login: 'alice' },
    created_at: '2026-01-01T00:00:00Z',
    path: 'src/feature.ts',
    line: id,
    node_id: 'comment_' + id,
  });
  const node = (id: string, root: number | null) => ({
    id,
    isResolved: resolved.has(id),
    viewerCanResolve: !resolved.has(id),
    viewerCanUnresolve: resolved.has(id),
    comments: { nodes: root ? [{ id: 'comment_' + root }] : [] },
  });
  const connect = () =>
    Promise.resolve({
      actor: 'alice',
      serverTime: Date.now(),
      api: (path: string) =>
        Promise.resolve(
          JSON.stringify(
            path.includes('/pulls/7/comments?') ? [comment(1), comment(2), comment(3)] : [],
          ),
        ),
      postComment: () => Promise.reject(Error('unused')),
      graphql: (query: string, variables: Record<string, string>) => {
        calls.push([query, variables]);
        if (query.startsWith('mutation')) {
          const mutation = query.includes('unresolveReviewThread')
            ? 'unresolveReviewThread'
            : 'resolveReviewThread';
          if (variables.thread === 'T_gone') return Promise.resolve(JSON.stringify({ data: {} }));
          if (mutation === 'resolveReviewThread') resolved.add(variables.thread ?? '');
          else resolved.delete(variables.thread ?? '');
          const thread = { isResolved: resolved.has(variables.thread ?? '') };
          return Promise.resolve(JSON.stringify({ data: { [mutation]: { thread } } }));
        }
        const first = !variables.after;
        return Promise.resolve(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    pageInfo: { hasNextPage: first, endCursor: first ? 'cursor-1' : null },
                    nodes: first ? [node('T_one', 1), node('T_empty', null)] : [node('T_two', 2)],
                  },
                },
              },
            },
          }),
        );
      },
    });
  const list = async () =>
    new Map(
      (await listDiscussions(url, signal, connect, () => Promise.resolve('alice'))).threads.map(
        (t) => [t.id, t.resolution],
      ),
    );
  assert.deepEqual(
    await list(),
    new Map([
      [1, { node: 'T_one', resolved: false, canResolve: true, canUnresolve: false }],
      [2, { node: 'T_two', resolved: true, canResolve: false, canUnresolve: true }],
      // A comment GitHub reports no thread for cannot be resolved here.
      [3, null],
    ]),
  );
  assert.deepEqual(calls.at(-1)?.[1], { owner: 'example', name: 'project', after: 'cursor-1' });
  assert.match(
    calls.at(-1)?.[0] ?? '',
    /pullRequest\(number:7\)\{reviewThreads\(first:100,after:\$after\)/,
  );
  const request = { url, account: 'alice', node: 'T_one', resolved: true };
  assert.deepEqual(await resolveDiscussion(request, signal, connect), { resolved: true });
  assert.deepEqual(calls.at(-1), [
    'mutation($thread:ID!){resolveReviewThread(input:{threadId:$thread}){thread{isResolved}}}',
    { thread: 'T_one' },
  ]);
  assert.equal((await list()).get(1)?.resolved, true);
  assert.deepEqual(await resolveDiscussion({ ...request, resolved: false }, signal, connect), {
    resolved: false,
  });
  const before = calls.length;
  await assert.rejects(
    resolveDiscussion({ ...request, account: 'bob' }, signal, connect),
    /account changed/,
  );
  assert.equal(calls.length, before);
  await assert.rejects(
    resolveDiscussion({ ...request, node: 'T_gone' }, signal, connect),
    /did not confirm/,
  );
});

await test('inline comments remain readable when the review summaries request fails', async () => {
  const identity = () => Promise.resolve('alice');
  const connect = () =>
    Promise.resolve({
      actor: 'alice',
      serverTime: 0,
      api: (path: string) => {
        if (path.includes('/reviews?'))
          return Promise.reject(Error('review summaries unavailable'));
        if (path.includes('/pulls/7/comments?'))
          return Promise.resolve(
            JSON.stringify([
              {
                id: 1,
                user: { login: 'alice' },
                node_id: 'C_1',
                body: 'Resolved on an older diff.',
                path: 'src/feature.ts',
                line: 0,
                original_line: 28,
                side: 'RIGHT',
              },
            ]),
          );
        if (path.endsWith('/pulls/7'))
          return Promise.resolve(
            JSON.stringify({ head: { sha: 'head' }, base: { sha: 'base', ref: 'main' } }),
          );
        return Promise.resolve('[]');
      },
      graphql: (_query: string, variables: Record<string, string>) =>
        variables.after
          ? Promise.reject(Error('Later thread statuses unavailable'))
          : Promise.resolve(
              JSON.stringify({
                data: {
                  repository: {
                    pullRequest: {
                      reviewThreads: {
                        pageInfo: { hasNextPage: true, endCursor: 'next' },
                        nodes: [
                          {
                            id: 'T_1',
                            isResolved: true,
                            viewerCanResolve: false,
                            viewerCanUnresolve: true,
                            comments: { nodes: [{ id: 'C_1' }] },
                          },
                        ],
                      },
                    },
                  },
                },
              }),
            ),
      postComment: () => Promise.reject(Error('unused')),
    });
  const result = discussions.parse(
    await listDiscussions(
      'https://github.com/example/project/pull/7',
      new AbortController().signal,
      connect,
      identity,
      true,
    ),
  );
  assert.equal(result.threads[0]?.messages[0]?.body, 'Resolved on an older diff.');
  assert.equal(result.threads[0]?.resolution?.resolved, true);
  assert.equal(result.threads[0]?.line, null);
  assert.equal(result.threads[0]?.originalLine, 28);
  assert.deepEqual(result.unavailable?.sort(), ['review summaries', 'thread status']);
  await assert.rejects(
    listDiscussions(
      'https://github.com/example/project/pull/7',
      new AbortController().signal,
      connect,
      identity,
    ),
    /review summaries unavailable/,
  );
  assert.deepEqual(result.anchorRevision, { head: 'head', base: 'base', baseBranch: 'main' });
});
