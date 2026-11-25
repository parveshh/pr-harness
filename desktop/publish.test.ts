import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchSnapshot } from './github.js';
import { reviewPublisher } from './publish.js';
import { openStore } from './store.js';

await test('a push, changed evidence, switched account or obsolete preview keeps every draft local', async (t) => {
  const url = 'https://github.com/example/project/pull/1';
  const db = openStore(':memory:');
  t.after(() => db.close());
  let head = 'head1',
    replacement = 'new',
    posts = 0;
  const api = (path: string) =>
    Promise.resolve(
      JSON.stringify(
        path === 'user'
          ? { login: 'reviewer' }
          : path.includes('/files?')
            ? [
                {
                  filename: 'f.ts',
                  status: 'modified',
                  sha: 'blob',
                  additions: 1,
                  deletions: 1,
                  patch: '@@ -1 +1 @@\n-old\n+' + replacement,
                },
              ]
            : {
                title: 'Test',
                body: '',
                user: { login: 'author' },
                base: { sha: 'base', ref: 'main' },
                head: { sha: head, ref: 'feature' },
                changed_files: 1,
              },
      ),
    );
  db.save(url);
  db.reader.select(url);
  const snapshot = await fetchSnapshot(url, new AbortController().signal, api);
  db.reader.install(url, snapshot);
  const publisher = reviewPublisher(db, api, () => Promise.resolve(++posts));
  const target = {
    path: 'f.ts',
    hunk: 0,
    side: 'new' as const,
    line: 1,
    revision: snapshot.revision,
  };
  const saved = publisher.edit(url, 0, {
    action: 'draft',
    id: null,
    body: 'Check this line.',
    target,
  });
  const key = { url, version: saved.version, revision: snapshot.revision, actor: 'reviewer' };
  assert.throws(
    () => publisher.edit(url, 0, { action: 'details', summary: 'old preview', event: 'COMMENT' }),
    /Drafts changed/,
  );
  head = 'head2';
  await assert.rejects(publisher.publish(key), /changed/);
  head = 'head1';
  replacement = 'different';
  await assert.rejects(publisher.publish(key), /location changed/);
  replacement = 'new';
  await assert.rejects(publisher.publish({ ...key, actor: 'other' }), /identity changed/);
  assert.deepEqual(db.drafts.get(url), saved);
  assert.equal(posts, 0);
  const [first, second] = await Promise.allSettled([
    publisher.publish(key),
    publisher.publish(key),
  ]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'rejected');
  assert.equal(posts, 1);
  assert.equal(db.drafts.get(url).receipt, 1);
  await assert.rejects(publisher.publish(key), /Drafts changed/);
});

await test('deleted ranges retain all lines, reject gaps and check the middle of the excerpt before submission', async (t) => {
  const url = 'https://github.com/example/project/pull/2';
  const db = openStore(':memory:');
  t.after(() => db.close());
  let middle = 'two';
  const api = (path: string) =>
    Promise.resolve(
      JSON.stringify(
        path === 'user'
          ? { login: 'reviewer' }
          : path.includes('/files?')
            ? [
                {
                  filename: 'f.ts',
                  status: 'modified',
                  sha: 'blob',
                  additions: 0,
                  deletions: 3,
                  patch: '@@ -7,3 +6,0 @@\n-one\n-' + middle + '\n-three',
                },
              ]
            : {
                title: 'Remove code',
                body: '',
                user: { login: 'author' },
                base: { sha: 'base', ref: 'main' },
                head: { sha: 'head', ref: 'feature' },
                changed_files: 1,
              },
      ),
    );
  db.save(url);
  db.reader.select(url);
  const snap = await fetchSnapshot(url, new AbortController().signal, api);
  db.reader.install(url, snap);
  let posts = 0;
  const publisher = reviewPublisher(db, api, (_, payload) => {
    posts++;
    assert.deepEqual(payload.comments, [
      { path: 'f.ts', side: 'LEFT', line: 9, start_side: 'LEFT', start_line: 7, body: 'Range' },
    ]);
    return Promise.resolve(2);
  });
  const target = {
    path: 'f.ts',
    hunk: 0,
    side: 'old' as const,
    startLine: 7,
    line: 9,
    revision: snap.revision,
  };
  const request = { action: 'draft' as const, id: null, body: 'Range', target };
  for (const invalid of [
    { ...target, startLine: 6 },
    { ...target, startLine: 10 },
    { ...target, side: 'new' as const },
  ]) {
    assert.throws(() => publisher.edit(url, 0, { ...request, target: invalid }), /same hunk/);
  }
  const bundle = publisher.edit(url, 0, request);
  assert.equal(bundle.comments[0]?.excerpt, '-one\n-two\n-three');
  const key = { url, actor: 'reviewer', revision: snap.revision, version: bundle.version };
  middle = 'changed';
  await assert.rejects(publisher.publish(key), /location changed/);
  assert.equal(posts, 0);
  middle = 'two';
  await publisher.publish(key);
  assert.equal(posts, 1);
});

await test('a lost receipt locks the drafts until the review GitHub accepted is reconciled once', async (t) => {
  const url = 'https://github.com/example/project/pull/3';
  const db = openStore(':memory:');
  t.after(() => db.close());
  let remote: unknown[] = [],
    posts = 0,
    sentBody = '';
  const api = (path: string) =>
    Promise.resolve(
      JSON.stringify(
        path === 'user'
          ? { login: 'reviewer' }
          : path.includes('/reviews?')
            ? remote
            : path.includes('/files?')
              ? [
                  {
                    filename: 'f.ts',
                    status: 'modified',
                    sha: 'blob',
                    additions: 1,
                    deletions: 1,
                    patch: '@@ -1 +1 @@\n-old\n+new',
                  },
                ]
              : {
                  title: 'Test',
                  body: '',
                  user: { login: 'author' },
                  base: { sha: 'base', ref: 'main' },
                  head: { sha: 'head1', ref: 'feature' },
                  changed_files: 1,
                },
      ),
    );
  db.save(url);
  db.reader.select(url);
  const snapshot = await fetchSnapshot(url, new AbortController().signal, api);
  db.reader.install(url, snapshot);
  const publisher = reviewPublisher(db, api, (_, payload) => {
    posts++;
    sentBody = payload.body;
    return Promise.reject(Error('timed out'));
  });
  const saved = publisher.edit(url, 0, {
    action: 'draft',
    id: null,
    body: 'Check this line.',
    target: { path: 'f.ts', hunk: 0, side: 'new', line: 1, revision: snapshot.revision },
  });
  // GitHub logins are case-insensitive, so a differently cased preview identity still matches.
  const key = { url, version: saved.version, revision: snapshot.revision, actor: 'Reviewer' };
  await assert.rejects(publisher.publish(key), /outcome unknown/);
  const locked = db.drafts.get(url);
  assert.ok(locked.pending);
  assert.equal(locked.comments.length, 1);
  assert.throws(
    () => publisher.edit(url, locked.version, { action: 'discard', id: saved.comments[0]!.id }),
    /Check the previous submission/,
  );
  await assert.rejects(
    publisher.publish({ ...key, version: locked.version }),
    /Check the previous submission/,
  );
  await assert.rejects(publisher.reconcile(url), /No matching review/);
  await assert.rejects(publisher.reconcile(url, true, locked.version), /Allow one minute/);
  assert.deepEqual(db.drafts.get(url), locked);
  remote = [
    {
      id: 76,
      user: { login: 'reviewer' },
      body: 'Unrelated',
      commit_id: 'head1',
      state: 'COMMENTED',
    },
    { id: 77, user: { login: 'Reviewer' }, body: sentBody, commit_id: 'head1', state: 'COMMENTED' },
  ];
  const published = await publisher.reconcile(url);
  assert.equal(published.receipt, 77);
  assert.equal(published.pending, null);
  assert.equal(published.comments.length, 0);
  assert.equal(posts, 1);
});

// A pull request whose patch and head can change between installs, with a recording publisher.
async function suggestionFixture(
  t: { after(fn: () => void): void },
  number: number,
  firstPatch: string,
) {
  const url = 'https://github.com/example/project/pull/' + number;
  const db = openStore(':memory:');
  t.after(() => db.close());
  let patch = firstPatch,
    head = 'head1';
  const api = (path: string) =>
    Promise.resolve(
      JSON.stringify(
        path === 'user'
          ? { login: 'reviewer' }
          : path.includes('/files?')
            ? [
                {
                  filename: 'f.ts',
                  status: 'modified',
                  sha: 'blob' + patch.length,
                  additions: 1,
                  deletions: 1,
                  patch,
                },
              ]
            : {
                title: 'Test',
                body: '',
                user: { login: 'author' },
                base: { sha: 'base', ref: 'main' },
                head: { sha: head, ref: 'feature' },
                changed_files: 1,
              },
      ),
    );
  db.save(url);
  db.reader.select(url);
  const install = async () => {
    const snapshot = await fetchSnapshot(url, new AbortController().signal, api);
    db.reader.install(url, snapshot);
    return snapshot;
  };
  const snapshot = await install();
  const sent: string[] = [];
  const publisher = reviewPublisher(db, api, (_, payload) => {
    sent.push(...payload.comments.map((c) => c.body));
    return Promise.resolve(9);
  });
  const draftOn = (side: 'old' | 'new', line: number, body: string) =>
    publisher.edit(url, db.drafts.get(url).version, {
      action: 'draft',
      id: null,
      body,
      target: { path: 'f.ts', hunk: 0, side, line, revision: snapshot.revision },
    });
  return {
    url,
    db,
    publisher,
    sent,
    snapshot,
    draftOn,
    change(next: { patch?: string; head?: string }) {
      patch = next.patch ?? patch;
      head = next.head ?? head;
      return install();
    },
    key: (revision = snapshot.revision) => ({
      url,
      version: db.drafts.get(url).version,
      revision,
      actor: 'reviewer',
    }),
  };
}
const fence = '```suggestion\nbetter\n```';

await test('a suggestion on a removed line is rejected before anything is sent', async (t) => {
  const f = await suggestionFixture(t, 4, '@@ -1,2 +1,2 @@\n keep\n-old\n+new');
  const saved = f.draftOn('old', 2, 'Use this instead.\n\n' + fence);
  const before = f.db.drafts.get(f.url);
  await assert.rejects(f.publisher.publish(f.key()), /removed line.*only applies suggestions/);
  assert.deepEqual(f.db.drafts.get(f.url), before);
  assert.equal(f.sent.length, 0);
  // Prose on the same removed line is still fine.
  f.publisher.edit(f.url, saved.version, {
    action: 'draft',
    id: saved.comments[0]!.id,
    body: 'Why remove this?',
    target: null,
  });
  await f.publisher.publish(f.key());
  assert.deepEqual(f.sent, ['Why remove this?']);
});

await test('a suggestion moved to different code is refused, and a normal one is sent unchanged', async (t) => {
  const f = await suggestionFixture(t, 5, '@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+tail');
  const body = 'Prefer this.\r\n\r\n````suggestion\r\nbetter ```\r\n````\r\n';
  const saved = f.draftOn('new', 2, body);
  // Reattaching to other lines without rewriting the suggestion cannot make it current.
  assert.throws(
    () =>
      f.publisher.edit(f.url, saved.version, {
        action: 'draft',
        id: saved.comments[0]!.id,
        body,
        target: { path: 'f.ts', hunk: 0, side: 'new', line: 3, revision: f.snapshot.revision },
      }),
    /written against different code/,
  );
  assert.deepEqual(f.db.drafts.get(f.url), saved);
  // The snapshot is later served with other text on that line: the stored excerpt no longer matches.
  await f.change({ patch: '@@ -1,2 +1,3 @@\n keep\n-old\n+changed\n+tail' });
  await assert.rejects(f.publisher.publish(f.key()), /suggestion on f\.ts line 2.*different code/);
  assert.equal(f.sent.length, 0);
  // Plain comments keep the generic message.
  const plain = f.db.drafts.get(f.url);
  f.publisher.edit(f.url, plain.version, {
    action: 'draft',
    id: plain.comments[0]!.id,
    body: 'No suggestion.',
    target: null,
  });
  await assert.rejects(f.publisher.publish(f.key()), /draft location changed/);
  // Rewriting for the new lines through a reattach is accepted and refreshes the excerpt.
  const again = f.db.drafts.get(f.url);
  const rewritten = f.publisher.edit(f.url, again.version, {
    action: 'draft',
    id: again.comments[0]!.id,
    body,
    target: { path: 'f.ts', hunk: 0, side: 'new', line: 2, revision: f.snapshot.revision },
  });
  assert.equal(rewritten.comments[0]?.excerpt, '+changed');
  await f.publisher.publish(f.key());
  assert.deepEqual(f.sent, [body]);
});

await test('a suggestion follows its lines when a push shifts them', async (t) => {
  const f = await suggestionFixture(t, 6, '@@ -1,3 +1,3 @@\n one\n-two\n+three\n four');
  const body = 'Tidy.\n\n' + fence;
  f.draftOn('new', 2, body);
  const next = await f.change({
    head: 'head2',
    patch: '@@ -1,4 +1,4 @@\n zero\n one\n-two\n+three\n four',
  });
  const moved = f.db.drafts.get(f.url).comments[0];
  assert.equal(moved?.revision, next.revision);
  assert.equal(moved?.line, 3);
  await f.publisher.publish(f.key(next.revision));
  assert.deepEqual(f.sent, [body]);
});
