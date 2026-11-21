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
