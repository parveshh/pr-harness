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
