import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { listDiscussions, sendDiscussionReply } from './discussions.js';

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
