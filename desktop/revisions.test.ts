import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.js';
import { compareHeads, probeRevision, type Snapshot, type SnapshotFile } from './github.js';
import { reviewPublisher } from './publish.js';

const url = 'https://github.com/octo/project/pull/15';
const signal = new AbortController().signal;
function file(path: string, patch: string): SnapshotFile {
  return {
    info: { path, previousPath: null, kind: 'text', status: 'added', additions: 3, deletions: 0 },
    patch,
    signature: path + patch,
  };
}
function snap(base: string, head: string, files: SnapshotFile[]): Snapshot {
  return {
    revision: base + '...' + head,
    meta: {
      base,
      head,
      mergeBase: base,
      baseBranch: 'main',
      headBranch: 'topic',
      title: 'Guard retries',
      description: '',
      author: 'octo',
      totalFiles: files.length,
    },
    files,
  };
}
const patch = '@@ -0,0 +10,4 @@\n+enter\n+retry\n+stop\n+exit';
const first = file('retry.ts', patch),
  keep = file('keep.ts', patch),
  other = file('old.ts', patch);
const start = snap('base', 'one', [first, keep, other]);
const ahead = {
  ancestry: 'ahead' as const,
  partial: false,
  files: [{ path: first.info.path, patch: '@@ -10 +10 @@\n-retry\n+guard' }],
};
const cursor = {
  url,
  revision: start.revision,
  path: first.info.path,
  hunk: 0,
  scroll: 42,
  reviewed: true,
};
await test('upgrade both revision-state layouts from v9 and reopen a saved PR with its review progress', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'revision-upgrade-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const legacy of [true, false]) {
    const database = join(dir, legacy ? 'early.sqlite' : 'complete.sqlite');
    const initial = openStore(database);
    initial.save(url);
    initial.reader.select(url);
    initial.reader.install(url, start);
    initial.reader.checkpoint(cursor);
    const next = snap('base', 'next', [first, keep]);
    initial.reader.install(url, next, ahead);
    initial.reader.revisions.position(url, next.revision, true, first.info.path);
    initial.close();
    const old = new DatabaseSync(database);
    if (legacy) {
      old.exec(
        'ALTER TABLE revision_state DROP COLUMN since; ALTER TABLE revision_state DROP COLUMN change_path; DROP TABLE absent_files',
      );
    }
    // The global harness choice arrived in version 12.
    old.exec(
      'DROP TABLE review_lessons; ALTER TABLE workspace DROP COLUMN accent; DROP TABLE agent_selection; PRAGMA user_version=9',
    );
    old.close();
    const upgraded = openStore(database);
    try {
      assert.equal(upgraded.reader.active(), url);
      const view = upgraded.reader.read(url);
      assert.equal(view?.comparison?.baseline, start.revision);
      assert.equal(view?.since, !legacy);
      assert.equal(view?.changePath, legacy ? null : first.info.path);
      assert.equal(view?.files[0]?.scroll, 42);
      assert.equal(view?.files[0]?.reviewed, true);
      assert.equal(upgraded.reader.patch({ ...cursor, revision: next.revision }), patch);
      assert.equal(upgraded.reader.install(url, start)?.files.length, start.files.length);
    } finally {
      upgraded.close();
    }
  }
});
await test('stage and coalesce pushes without moving the reader, restore the return queue offline, and advance only on review', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'revision-queue-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const database = join(dir, 'review.sqlite');
  let store = openStore(database);
  store.save(url);
  store.reader.select(url);
  store.reader.install(url, start);
  store.reader.checkpoint(cursor);
  store.reader.checkpoint({ ...cursor, path: other.info.path });
  store.reader.checkpoint({ ...cursor, path: keep.info.path });
  const inserted = file('new.test.ts', patch);
  const intermediate = snap('base', 'two', [first, keep]);
  const changed = file(first.info.path, patch.replace('retry', 'guard'));
  const latest = snap('base', 'three', [changed, keep, inserted]);
  store.reader.revisions.stage(url, intermediate, ahead, start.revision);
  store.reader.revisions.stage(url, latest, ahead, start.revision);
  assert.equal(store.reader.read(url)?.selected, keep.info.path);
  assert.throws(() => store.reader.revisions.pending(url, intermediate.revision), /newer update/);
  store.close();
  store = openStore(database);
  t.after(() => store.close());
  assert.equal(store.reader.read(url)?.incoming, latest.revision);
  const pending = store.reader.revisions.pending(url, latest.revision);
  const current = store.reader.install(url, pending.snapshot, pending.heads);
  assert.ok(current?.comparison);
  assert.deepEqual(
    current.comparison.files.map((f) => [f.path, f.state]),
    [
      ['retry.ts', 'changed'],
      ['new.test.ts', 'entered'],
      ['old.ts', 'left'],
    ],
  );
  assert.deepEqual(
    current.files.map((f) => [f.reviewed, !!f.needsReview]),
    [
      [false, true],
      [true, false],
      [false, false],
    ],
  );
  assert.equal(
    store.reader.revisions.evidence({ ...cursor, revision: latest.revision }).incremental,
    ahead.files[0]?.patch,
  );
  assert.equal(store.reader.patch(cursor), patch);
  assert.equal(store.reader.revisions.citationChanged(url, start.revision, 'retry.ts'), true);
  assert.equal(store.reader.revisions.citationChanged(url, start.revision, 'keep.ts'), false);
  store.reader.revisions.position(url, latest.revision, true, inserted.info.path);
  store.close();
  store = openStore(database);
  assert.equal(store.reader.read(url)?.changePath, inserted.info.path);
  store.reader.revisions.markAbsent({ ...cursor, path: 'old.ts', revision: latest.revision }, true);
  assert.equal(
    store.reader.read(url)?.comparison?.files.find((f) => f.path === 'old.ts')?.reviewed,
    true,
  );
  assert.notEqual(
    store.reader.revisions.identify(url, latest.revision, 'release'),
    latest.revision,
  );
  const rewritten = snap('base', 'four', [first, keep, other]);
  const rewrite = store.reader.install(url, rewritten, {
    ancestry: 'rewritten',
    partial: false,
    files: [],
  });
  assert.equal(rewrite?.comparison?.baseline, start.revision);
  assert.equal(rewrite?.files[0]?.reviewed, true);
  assert.equal(rewrite?.files[2]?.reviewed, true);
  assert.equal(rewrite?.files[2]?.scroll, 42);
  store.reader.revisions.finish(url, rewritten.revision);
  const retarget = snap('release', 'four', [changed, keep]);
  const next = store.reader.install(url, retarget, { ancestry: 'same', partial: false, files: [] });
  assert.equal(next?.comparison?.baseline, rewritten.revision);
  assert.equal(next?.comparison?.baseChanged, true);
  assert.deepEqual(store.reader.revisions.evidence({ ...cursor, revision: retarget.revision }), {
    before: patch,
    after: changed.patch,
    incremental: null,
  });
});

await test('re-anchor a shifted range once, preserve ambiguous ranges and their original excerpt on a force-push', (t) => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  store.save(url);
  store.reader.select(url);
  store.reader.install(url, start);
  const publisher = reviewPublisher(store);
  publisher.edit(url, 0, {
    action: 'draft',
    id: null,
    target: {
      path: 'retry.ts',
      side: 'new',
      hunk: 0,
      startLine: 11,
      line: 12,
      revision: start.revision,
    },
    body: 'Test simultaneous retries.',
  });
  const shifted = patch.replace('+10,4', '+20,4');
  const moved = snap('base', 'two', [file('retry.ts', shifted), keep]);
  store.reader.install(url, moved, ahead);
  const bundle = store.drafts.get(url);
  assert.equal(bundle.comments[0]?.line, 22);
  assert.equal(bundle.comments[0]?.startLine, 21);
  assert.equal(bundle.comments[0]?.revision, moved.revision);
  const duplicate = shifted + '\n' + shifted.replace('+20,4', '+50,4');
  const rewrite = snap('base', 'rewrite', [file('retry.ts', duplicate), keep]);
  store.reader.install(url, rewrite, { ancestry: 'rewritten', files: [], partial: false });
  assert.deepEqual(store.drafts.get(url), bundle);
  const stale = bundle.comments[0];
  assert.ok(stale);
  assert.equal(stale.excerpt, '+retry\n+stop');
  const summary = publisher.edit(url, bundle.version, {
    action: 'to-summary',
    id: stale.id,
    event: 'COMMENT',
    summary: 'Other concerns',
  });
  assert.match(summary.summary, /Other concerns[\s\S]*Test simultaneous retries/);
  assert.equal(summary.comments.length, 0);
});
await test('only fast-forward compare responses supply a direct patch; ambiguous ancestry falls back to snapshots', async () => {
  const response = {
    status: 'ahead',
    merge_base_commit: { sha: 'one' },
    files: [
      {
        filename: 'x',
        sha: 'blob',
        status: 'added',
        additions: 1,
        deletions: 0,
        patch: '@@ -0,0 +1 @@\n+new',
      },
    ],
  };
  assert.equal(
    (
      await compareHeads(url, 'one', 'two', signal, async () =>
        Promise.resolve(JSON.stringify(response)),
      )
    ).files[0]?.path,
    'x',
  );
  const rewrite = await compareHeads(url, 'one', 'two', signal, async () =>
    Promise.resolve(JSON.stringify({ ...response, status: 'diverged' })),
  );
  assert.deepEqual(rewrite, { ancestry: 'rewritten', partial: false, files: [] });
  assert.equal(
    (await compareHeads(url, 'one', 'two', signal, async () => Promise.reject(Error('offline'))))
      .ancestry,
    'unknown',
  );
});

await test('an unchanged probe is recognised when gh exits non-zero for 304; other failures still surface', async () => {
  const seen: string[][] = [];
  const failure = (stdout: string) => (args: string[]) => {
    seen.push(args);
    return Promise.reject(Object.assign(Error('exit 1'), { stdout, stderr: 'gh: HTTP 304' }));
  };
  assert.equal(
    await probeRevision(
      url,
      signal,
      '"tag"',
      failure('HTTP/2.0 304 Not Modified\r\nEtag: "tag"\r\n\r\n'),
    ),
    null,
  );
  assert.deepEqual(seen[0]?.slice(-2), ['-H', 'If-None-Match: "tag"']);
  await assert.rejects(
    probeRevision(url, signal, '"tag"', failure('HTTP/2.0 502 Bad Gateway\r\n\r\n')),
    /exit 1/,
  );
  const body = JSON.stringify({
    title: 'Guard retries',
    body: null,
    user: { login: 'octo' },
    base: { sha: 'base', ref: 'main' },
    head: { sha: 'two', ref: 'topic' },
    changed_files: 1,
  });
  assert.deepEqual(
    await probeRevision(url, signal, undefined, () =>
      Promise.resolve({ stdout: 'HTTP/2.0 200 OK\r\nEtag: "next"\r\n\r\n' + body }),
    ),
    { baseBranch: 'main', revision: 'base...two', etag: '"next"' },
  );
});
