import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.js';
import { replyMonitor } from './replies.js';

const url = 'https://github.com/example/project/pull/12';
const graphql = () =>
  Promise.resolve(
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            state: 'OPEN',
            headRefOid: 'head',
            isDraft: false,
            commits: { totalCount: 1 },
            reviewDecision: null,
            latestOpinionatedReviews: null,
            latest: { nodes: [] },
            dismissed: { totalCount: 0 },
          },
        },
      },
    }),
  );
const signal = new AbortController().signal;
const comment = (id: number, author: string, date: string, parent: number | null) => ({
  id,
  user: { login: author },
  in_reply_to_id: parent,
  created_at: date,
  updated_at: date,
  body: 'Covers retries.',
  path: 'retry.ts',
});
await test('removing a later watch during polling skips that PR and its alerts', async (t) => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  store.save(url);
  const repo = 'example/watched';
  store.assistant.add(repo);
  store.assistant.update(
    repo,
    ['author'],
    [{ number: 9, title: 'Another PR', author: 'author', approved: false, unseen: false }],
  );
  store.assistant.watch(repo, ['author']);
  const requests: string[] = [];
  const monitor = replyMonitor(
    store.replies,
    signal,
    async () =>
      Promise.resolve({
        graphql,
        actor: 'reader',
        serverTime: Date.now(),
        api: async (endpoint: string) => {
          requests.push(endpoint);
          store.assistant.watch(repo, []);
          return Promise.resolve(
            JSON.stringify([comment(123, 'author', new Date().toISOString(), 1)]),
          );
        },
      }),
    async () => Promise.resolve('reader'),
  );
  const inbox = await monitor.sync();
  assert.equal(inbox.error, null);
  assert.equal(requests.length, 1);
  assert.match(requests[0] ?? '', /example\/project/);
  assert.deepEqual(
    inbox.items.map((item) => item.url),
    [url],
  );
});
await test('first successful scan uses registration and server time, restarts and pagination preserve unread replies', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'replies-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, 'workspace.sqlite');
  const first = openStore(filename);
  const registered = Date.parse(first.save(url)[0]!.savedAt);
  first.close();
  const store = openStore(filename);
  t.after(() => store.close());
  // The client clock is five minutes fast. The first network scan happens
  // ten minutes after the PR was saved while offline.
  const skew = 300000,
    serverRegistered = registered - skew;
  let serverTime = serverRegistered + 600000,
    failPage = true;
  const fresh = new Date(serverRegistered + 2500).toISOString(),
    old = new Date(serverRegistered - 60000).toISOString();
  const rows = [
    comment(1, 'octo', old, 1),
    comment(2, 'reader', fresh, 1),
    comment(3, 'octo', fresh, null),
    comment(4, 'octo', fresh, 1),
    ...Array.from({ length: 96 }, (_, i) => comment(i + 5, 'reader', fresh, null)),
    comment(105, 'octo', fresh, 1),
  ];
  const session = async () =>
    Promise.resolve({
      graphql,
      actor: 'reader',
      serverTime,
      api: async (endpoint: string) => {
        const query = new URL(endpoint, 'https://api.github.com').searchParams;
        const since = Date.parse(query.get('since') ?? '');
        const page = Number(query.get('page'));
        if (page === 2 && failPage) throw Error('Offline');
        const filtered = rows.filter((r) => Date.parse(r.updated_at) > since);
        return Promise.resolve(JSON.stringify(filtered.slice((page - 1) * 100, page * 100)));
      },
    });
  const monitor = replyMonitor(
    store.replies,
    signal,
    session,
    async () => Promise.resolve('reader'),
    () => serverTime + skew,
  );
  assert.match((await monitor.sync()).error ?? '', /Offline/);
  failPage = false;
  assert.deepEqual(
    (await monitor.sync()).items.map((i) => i.id),
    [105, 4],
  );
  store.replies.mark('reader', 4);
  rows.push(comment(106, 'octo', new Date(serverTime + 1000).toISOString(), 1));
  serverTime += 120000;
  assert.equal((await monitor.sync()).added, 1);
  assert.equal((await monitor.sync()).added, 0);
  assert.equal(store.replies.thread('reader', 4), url + '#discussion_r4');
  assert.equal(monitor.state().items.find((i) => i.id === 4)?.unread, false);
  store.replies.mark('reader');
  assert.ok(monitor.state().items.every((i) => !i.unread));
});
await test('switching account during pagination binds all rows to the original session and rejects stale inbox actions', async (t) => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  store.save(url);
  let actor = 'alice',
    swap = true;
  const time = Date.now(),
    stamp = new Date(time + 2000).toISOString();
  const session = async () => {
    const owner = actor;
    return Promise.resolve({
      graphql,
      actor: owner,
      serverTime: time,
      api: async (endpoint: string) => {
        if (owner === 'bob') return Promise.resolve('[]');
        if (endpoint.endsWith('page=1')) {
          if (swap) actor = 'bob';
          return Promise.resolve(
            JSON.stringify(
              Array.from({ length: 100 }, (_, i) => comment(i + 1, 'author', stamp, 1)),
            ),
          );
        }
        return Promise.resolve(JSON.stringify([comment(201, 'author', stamp, 1)]));
      },
    });
  };
  const monitor = replyMonitor(store.replies, signal, session, async () => Promise.resolve(actor));
  const switched = await monitor.sync();
  assert.deepEqual(switched.items, []);
  assert.match(switched.error ?? '', /account changed/);
  assert.equal(store.replies.items('alice').length, 101);
  assert.equal(store.replies.items('bob').length, 0);
  assert.equal((await monitor.sync()).account, 'bob');
  actor = 'alice';
  swap = false;
  await assert.rejects(monitor.verify('bob'), /Refresh/);
  assert.equal((await monitor.sync()).added, 0);
  await monitor.verify('alice');
  monitor.invalidate();
  assert.equal(monitor.state().account, null);
});

await test('a push and dismissal on a reviewed PR survive restart and are announced once for the signed-in reviewer', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'review-changes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'workspace.sqlite');
  let store = openStore(file);
  t.after(() => store.close());
  store.save(url);
  let account = 'reader',
    head = 'first',
    dismissed = 1,
    reviewedHead: string | null = null,
    isDraft = true,
    fail = false;
  const notifications: string[][] = [];
  function start() {
    return replyMonitor(
      store.replies,
      signal,
      () =>
        Promise.resolve({
          actor: account,
          serverTime: Date.now(),
          api: () => Promise.resolve('[]'),
          graphql: (query, variables) => {
            assert.match(query, /pullRequest\(number:12\)/);
            assert.match(query, /author:\$author/);
            assert.deepEqual(variables, { owner: 'example', name: 'project', author: account });
            if (fail) return Promise.reject(Error('Offline'));
            return Promise.resolve(
              JSON.stringify({
                data: {
                  repository: {
                    pullRequest: {
                      state: 'OPEN',
                      headRefOid: head,
                      isDraft,
                      commits: { totalCount: 3 },
                      reviewDecision: isDraft ? 'REVIEW_REQUIRED' : 'APPROVED',
                      latestOpinionatedReviews: {
                        nodes: [{ author: { login: 'another-reviewer' }, state: 'APPROVED' }],
                        pageInfo: { hasNextPage: false, endCursor: null },
                      },
                      latest: { nodes: reviewedHead ? [{ commit: { oid: reviewedHead } }] : [] },
                      dismissed: { totalCount: dismissed },
                    },
                  },
                },
              }),
            );
          },
        }),
      () => Promise.resolve(account),
      Date.now,
      (changes) => {
        if (changes.length) notifications.push(changes.map((change) => change.kind));
      },
    );
  }
  let monitor = start();
  await monitor.sync();
  assert.equal(store.list()[0]?.isDraft, true);
  assert.equal(store.list()[0]?.approvalStage, 'partial');
  assert.equal(store.list()[0]?.head, head);
  assert.equal(store.list()[0]?.commitCount, 3);
  head = 'unreviewed';
  assert.deepEqual((await monitor.sync()).changes, []);
  reviewedHead = head;
  isDraft = false;
  await monitor.sync();
  assert.equal(store.list()[0]?.isDraft, false);
  store.close();
  store = openStore(file);
  monitor = start();
  assert.equal(store.list()[0]?.approvalStage, 'approved');
  head = 'force-pushed';
  dismissed++;
  fail = true;
  assert.match((await monitor.sync()).error ?? '', /Offline/);
  fail = false;
  const changed = await monitor.sync();
  assert.deepEqual(
    changed.changes.map((c) => [c.kind, c.url, c.unread, c.head]),
    [
      ['push', url, true, head],
      ['dismissed', url, true, head],
    ],
  );
  assert.equal(changed.added, 2);
  store.replies.markChange(account, changed.changes[0]!.id);
  assert.deepEqual(
    (await monitor.sync()).changes.map((c) => c.unread),
    [false, true],
  );
  assert.deepEqual(notifications, [['dismissed', 'push']]);
  dismissed++;
  assert.deepEqual(
    (await monitor.sync()).changes.slice(0, 1).map((c) => c.kind),
    ['dismissed'],
  );
  account = 'other';
  assert.deepEqual((await monitor.sync()).changes, []);
  assert.equal(notifications.length, 2);
});
