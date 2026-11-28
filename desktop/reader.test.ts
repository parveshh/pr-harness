import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { z } from 'zod';
import { fetchSnapshot } from './github.js';
import { openStore } from './store.js';
import { diffLines } from '../shared/diff.js';

const fixture = z
  .object({
    meta: z.record(z.string(), z.unknown()),
    files: z.array(z.record(z.string(), z.unknown())),
    raw: z.string(),
  })
  .parse(
    JSON.parse(readFileSync(new URL('../fixtures/github/review.json', import.meta.url), 'utf8')),
  );
const url = 'https://github.com/example/project/pull/12';
const signal = new AbortController().signal;
const api = async (endpoint: string, _signal: AbortSignal, raw?: boolean) =>
  Promise.resolve(
    raw ? fixture.raw : JSON.stringify(endpoint.includes('/files?') ? fixture.files : fixture.meta),
  );

await test('load and migrate a saved PR, preserve matching file checkpoints, reject obsolete writes', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'reader-migration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'v1.sqlite');
  const old = new DatabaseSync(path);
  old.exec(
    'CREATE TABLE saved_reviews (url TEXT PRIMARY KEY, saved_at TEXT NOT NULL) STRICT; PRAGMA user_version=1',
  );
  old.prepare('INSERT INTO saved_reviews VALUES(?,?)').run(url, new Date().toISOString());
  old.close();
  const store = openStore(path);
  t.after(() => store.close());
  assert.equal(store.list()[0]?.url, url);
  const snapshot = await fetchSnapshot(url, signal, api);
  store.reader.select(url);
  const initial = store.reader.install(url, snapshot);
  assert.equal(store.list()[0]?.title, snapshot.meta.title);
  assert.equal(store.list()[0]?.author, snapshot.meta.author);

  assert.deepEqual(
    initial?.files.map((f) => [f.status, f.kind]),
    [
      ['added', 'text'],
      ['modified', 'text'],
      ['removed', 'text'],
      ['renamed', 'metadata'],
      ['modified', 'binary'],
    ],
  );
  const cursor = {
    url,
    revision: snapshot.revision,
    path: 'src/reader.ts',
    hunk: 1,
    scroll: 180,
    reviewed: true,
  };
  store.reader.checkpoint(cursor);
  assert.match(store.reader.patch(cursor), /@@ -40/);
  store.reader.install(url, {
    ...snapshot,
    files: snapshot.files.map((file) =>
      file.info.path === cursor.path
        ? { ...file, info: { ...file.info, kind: 'unavailable' }, patch: '', signature: 'missing' }
        : file,
    ),
  });
  assert.match(store.reader.patch(cursor), /@@ -40/);
  assert.equal(store.reader.read(url)?.files[1]?.scroll, 180);
  const next = {
    ...snapshot,
    revision: 'new',
    files: snapshot.files.filter((f) => f.info.status !== 'removed'),
  };
  const updated = store.reader.install(url, next);
  assert.equal(updated?.selected, 'src/reader.ts');
  assert.deepEqual(
    updated?.files.find((f) => f.path === cursor.path),
    { ...snapshot.files[1]?.info, hunk: 1, scroll: 180, reviewed: true },
  );
  assert.throws(() => store.reader.checkpoint(cursor), /older view/);
  const changed = { ...next, files: next.files.map((f) => ({ ...f, signature: 'changed' })) };
  assert.equal(store.reader.install(url, changed)?.files[1]?.reviewed, false);
});
await test('search a pinned diff across files, counting literal occurrences on the requested sides', async (t) => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  store.save(url);
  const snapshot = await fetchSnapshot(url, signal, api);
  const [first, second] = snapshot.files;
  assert.ok(first && second);
  first.patch = '@@ -1,2 +1,2 @@ foo.bar\n foo.bar\n-Foo.bar FooXbar\n+foo.BAR foo.bar';
  second.patch = '@@ -1 +1 @@\n-before\n+after\n@@ -10 +11 @@\n-foo.bar\n+change';
  store.reader.install(url, snapshot);
  const paths = [first.info.path, second.info.path];
  const request = { url, revision: snapshot.revision, paths, query: 'foo.bar' };
  const before = store.reader.read(url);
  assert.deepEqual(await store.reader.searchDiff({ ...request, filter: 'both' }), [
    { path: first.info.path, hunk: 0, count: 3 },
    { path: second.info.path, hunk: 1, count: 1 },
  ]);
  assert.deepEqual(await store.reader.searchDiff({ ...request, filter: 'added' }), [
    { path: first.info.path, hunk: 0, count: 2 },
  ]);
  assert.deepEqual(await store.reader.searchDiff({ ...request, filter: 'removed' }), [
    { path: first.info.path, hunk: 0, count: 1 },
    { path: second.info.path, hunk: 1, count: 1 },
  ]);
  assert.deepEqual(await store.reader.searchDiff({ ...request, query: '+', filter: 'both' }), []);
  await assert.rejects(
    () => store.reader.searchDiff({ ...request, revision: 'obsolete', filter: 'both' }),
    /saved diff changed/,
  );
  assert.deepEqual(store.reader.read(url), before);
});

await test('separate sides of a diff have independent line numbers', () => {
  assert.deepEqual(
    diffLines('@@ -4,2 +8,2 @@\n same\n-old\n+new').lines.map((line) => [
      line.oldLine,
      line.newLine,
    ]),
    [
      [4, 8],
      [5, null],
      [null, 9],
    ],
  );
});
await test('paginate file lists and refuse a snapshot that changed while loading', async () => {
  const pages: string[] = [];
  const source = async (endpoint: string) => {
    if (!endpoint.includes('/files?'))
      return Promise.resolve(JSON.stringify({ ...fixture.meta, changed_files: 101 }));
    pages.push(endpoint);
    const count = endpoint.endsWith('page=1') ? 100 : 1;
    return Promise.resolve(
      JSON.stringify(
        Array.from({ length: count }, (_, i) => ({
          ...fixture.files[0],
          filename: pages.length + '-' + i,
        })),
      ),
    );
  };
  assert.equal((await fetchSnapshot(url, signal, source)).files.length, 101);
  assert.equal(pages.length, 2);
  let reads = 0;
  await assert.rejects(
    fetchSnapshot(url, signal, async (endpoint, signal, diff) => {
      if (
        !endpoint.includes('/compare/') &&
        !endpoint.includes('/files?') &&
        !diff &&
        ++reads === 2
      )
        return JSON.stringify({ ...fixture.meta, head: { sha: 'new', ref: 'reader' } });
      return api(endpoint, signal, diff);
    }),
    /changed during the fetch/,
  );
});

await test('opening a staged revision offline preserves a newer observed approval', async (t) => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  store.save(url);
  const snapshot = await fetchSnapshot(url, signal, api);
  store.reader.install(url, snapshot);
  // Opening an older staged snapshot must preserve a newer remote head and its approval.
  const staged = {
    ...snapshot,
    revision: snapshot.meta.base + '...' + 'b'.repeat(40),
    meta: { ...snapshot.meta, head: 'b'.repeat(40) },
  };
  const comparison = { ancestry: 'ahead' as const, partial: false, files: [] };
  store.reader.revisions.stage(url, staged, comparison, snapshot.revision);
  const remoteHead = 'c'.repeat(40);
  const target = store.replies.targets().find((row) => row.url === url);
  assert.ok(target);
  store.replies.observe(
    'reader',
    url,
    target.registered,
    {
      state: 'OPEN',
      headRefOid: remoteHead,
      isDraft: false,
      commitCount: 5,
      approvalStage: 'partial',
      latest: { nodes: [] },
      dismissed: { totalCount: 0 },
    },
    new Date().toISOString(),
  );
  const pending = store.reader.revisions.pending(url, staged.revision);
  store.reader.install(url, pending.snapshot, pending.heads);
  assert.equal(store.list()[0]?.head, remoteHead);
  assert.equal(store.list()[0]?.approvalStage, 'partial');
  store.reader.observeRemoteHead(url, snapshot.meta.head, 4);
  assert.equal(store.list()[0]?.approvalStage, undefined);
  assert.equal(store.list()[0]?.commitCount, 4);
});

await test('file retry follows a rename and preserves the selected revision when the file disappears', async (t) => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  store.save(url);
  store.reader.select(url);
  const original = await fetchSnapshot(url, signal, api);
  const file = original.files.find((f) => f.info.path === 'src/reader.ts');
  assert.ok(file);
  store.reader.install(url, original);
  store.reader.checkpoint({
    url,
    revision: original.revision,
    path: file.info.path,
    hunk: 1,
    scroll: 182,
    reviewed: false,
  });
  const renamed = {
    ...file,
    info: {
      ...file.info,
      path: 'src/renamed.ts',
      previousPath: file.info.path,
      status: 'renamed' as const,
    },
  };
  const next = {
    ...original,
    revision: 'base...new',
    files: original.files.map((f) => (f === file ? renamed : f)),
  };
  const view = store.reader.install(url, next, undefined, file.info);
  assert.equal(view?.selected, renamed.info.path);
  const currentFile = view?.files.find((f) => f.path === renamed.info.path);
  assert.equal(currentFile?.hunk, 1);
  assert.equal(currentFile.scroll, 182);
  assert.equal(view?.since, false);
  assert.throws(
    () =>
      store.reader.install(
        url,
        {
          ...next,
          revision: 'base...reverted',
          files: next.files.filter((f) => f !== renamed),
        },
        undefined,
        renamed.info,
      ),
    /Could not find this file/,
  );
  assert.deepEqual(store.reader.read(url), view);
});
