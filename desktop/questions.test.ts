import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openStore } from './store.js';
import type { Snapshot, SnapshotFile } from './github.js';

const url = 'https://github.com/example/read/pull/4';
const original = '@@ -10,3 +10,4 @@ function retry()\n enter();\n+send();\n close();\n exit();';
function file(path: string, patch: string, previousPath: string | null = null): SnapshotFile {
  return {
    info: {
      path,
      previousPath,
      status: previousPath ? 'renamed' : 'modified',
      kind: 'text',
      additions: 1,
      deletions: 0,
    },
    patch,
    signature: path + patch,
  };
}
function snapshot(
  head: string,
  files: SnapshotFile[],
  base = 'main',
  total = files.length,
): Snapshot {
  return {
    revision: base + '...' + head,
    meta: {
      base,
      head,
      mergeBase: base,
      baseBranch: base,
      headBranch: 'feature',
      title: 'Retry',
      description: '',
      author: 'octo',
      totalFiles: total,
    },
    files,
  };
}
function setup(filename: string) {
  const store = openStore(filename);
  store.save(url);
  store.reader.select(url);
  const first = snapshot('one', [file('retry.ts', original)]);
  store.reader.install(url, first);
  const req = {
    id: randomUUID(),
    url,
    revision: first.revision,
    path: 'retry.ts',
    hunk: 0,
    question: 'Can simultaneous retries both send?',
  };
  const [pin] = store.reader.questions.pin(req);
  assert.equal(pin?.status, 'pinned');
  return { store, req, first };
}

await test('a local question follows its edited and renamed hunk across pushes and checkpoints until explicitly addressed', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'reviewer-pins-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, 'work.sqlite');
  const { store, req, first } = setup(filename);
  assert.equal(store.reader.questions.pin(req).length, 1);
  const guard = original.replace('send();', 'sendOnce();');
  const lead = '@@ -1 +1 @@\n-before\n+after';
  const second = snapshot('two', [file('retry-guard.ts', lead + '\n' + guard, 'retry.ts')]);
  store.reader.revisions.stage(
    url,
    second,
    { ancestry: 'ahead', partial: false, files: [] },
    first.revision,
  );
  assert.equal(store.reader.read(url)?.questions?.[0]?.status, 'pinned');
  const q = store.reader.install(url, second)?.questions?.[0];
  assert.equal(q?.addressed, false);
  assert.equal(q?.status, 'changed');
  assert.deepEqual(q?.current, { path: 'retry-guard.ts', hunk: 1 });
  const key = { ...req, revision: second.revision };
  assert.deepEqual(store.reader.questions.evidence(key), {
    original,
    current: guard,
    originalPartial: false,
  });
  assert.throws(() => store.reader.questions.address(req, true), /current PR revision/);
  store.reader.revisions.finish(url, second.revision);
  assert.equal(store.reader.questions.address(key, true)[0]?.addressed, true);
  store.close();
  const again = openStore(filename);
  t.after(() => again.close());
  const third = snapshot('three', [file('retry-guard.ts', guard, 'retry.ts')]);
  const saved = again.reader.install(url, third)?.questions?.[0];
  assert.equal(saved?.addressed, true);
  assert.deepEqual(saved?.current, { path: 'retry-guard.ts', hunk: 0 });
  assert.equal(
    again.reader.questions.evidence({ ...key, revision: third.revision }).original,
    original,
  );
  assert.equal(
    again.reader.questions.address({ ...key, revision: third.revision }, false)[0]?.addressed,
    false,
  );
});

await test('missing, partial, and ambiguous evidence remain inspectable after a rewrite; switching PRs rejects stale actions', (t) => {
  const { store, req } = setup(':memory:');
  t.after(() => store.close());
  const moved = original.replace('-10,3 +10,4', '-30,3 +30,4');
  const second = snapshot('two', [file('retry.ts', moved)], 'new-base');
  assert.equal(store.reader.install(url, second)?.questions?.[0]?.status, 'moved');
  const ambiguous = snapshot(
    'three',
    [file('retry.ts', original + '\n' + moved)],
    'rewritten-base',
  );
  const q = store.reader.install(url, ambiguous)?.questions?.[0];
  assert.equal(q?.status, 'ambiguous');
  assert.equal(q?.current, null);
  assert.equal(
    store.reader.questions.evidence({ ...req, revision: ambiguous.revision }).current,
    null,
  );
  for (const [total, status] of [
    [1, 'unavailable'],
    [0, 'missing'],
  ] as const) {
    const removed = snapshot('empty' + total, [], 'new-base', total);
    const pin = store.reader.install(url, removed)?.questions?.[0];
    assert.equal(pin?.status, status);
    assert.equal(pin?.addressed, false);
    assert.equal(
      store.reader.questions.evidence({ ...req, revision: removed.revision }).original,
      original,
    );
  }
  const restored = snapshot('restore', [file('retry.ts', original)]);
  const pins = store.reader.install(url, restored)?.questions;
  assert.equal(pins?.[0]?.status, 'unchanged');
  const key = { ...req, revision: restored.revision };
  assert.throws(
    () => store.reader.questions.pin({ ...key, id: randomUUID(), hunk: 12 }),
    /visible text hunk/,
  );
  const another = 'https://github.com/example/read/pull/5';
  store.save(another);
  store.reader.select(another);
  store.reader.install(another, restored);
  assert.deepEqual(store.reader.read(another)?.questions, []);
  assert.throws(() => store.reader.questions.address(key, true), /current PR revision/);
  assert.throws(
    () => store.reader.questions.address({ ...key, url: another }, true),
    /unavailable/,
  );
});

await test('immutable base lines win over surviving duplicates and a reverted rename restores the path', (t) => {
  const { store, req } = setup(':memory:');
  t.after(() => store.close());
  const duplicate = original.replace('-10,3 +10,4', '-90,3 +90,4');
  const second = snapshot('two', [
    file('b.ts', original.replace('send();', 'guard();') + '\n' + duplicate, 'retry.ts'),
  ]);
  const pin = store.reader.install(url, second)?.questions?.[0];
  assert.deepEqual(pin?.current, { path: 'b.ts', hunk: 0 });
  assert.equal(pin?.status, 'changed');
  const reverted = snapshot('three', [file('retry.ts', original)]);
  assert.equal(store.reader.install(url, reverted)?.questions?.[0]?.status, 'unchanged');
  const partial = file('partial.ts', '@@ -0,0 +1,3 @@\n+enter();\n+retry();');
  partial.info.kind = 'partial';
  const same = snapshot('four', [partial]);
  store.reader.install(url, same);
  const key = { ...req, id: randomUUID(), path: 'partial.ts', revision: same.revision };
  store.reader.questions.pin(key);
  const full = snapshot('four', [file('partial.ts', partial.patch + '\n+final();')]);
  store.reader.install(url, full);
  const evidence = store.reader.questions.evidence(key);
  assert.equal(evidence.originalPartial, true);
  assert.match(evidence.current ?? '', /final/);
});
