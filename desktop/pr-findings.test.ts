import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { turn, type Citation, type Turn } from '../shared/assistant.js';
import type { Snapshot } from './github.js';
import { readFindings } from './pr-findings.js';
import { openStore } from './store.js';

const url = 'https://github.com/org/repo/pull/3';
const patch = '@@ -1,2 +1,2 @@\n-one\n-two\n+first\n+second';
const refs: Citation[] = [
  { id: 1, path: 'f.ts', side: 'new', hunk: 0, line: 1, excerpt: '+first' },
  { id: 2, path: 'f.ts', side: 'new', hunk: 0, line: 2, excerpt: '+second' },
  { id: 3, path: 'f.ts', side: 'old', hunk: 0, line: 2, excerpt: '-two' },
];
function report(startId: number, endId: number) {
  return JSON.stringify({
    coverage: 'Read the changed function.',
    findings: [
      {
        title: 'Lost write',
        priority: 'high',
        comment: 'Retried writes lose their update.',
        startId,
        endId,
      },
    ],
  });
}
const snapshot: Snapshot = {
  revision: 'base...head',
  meta: {
    title: 'Changes',
    description: '',
    author: 'author',
    totalFiles: 1,
    head: 'head',
    base: 'base',
    baseBranch: 'main',
    headBranch: 'topic',
  },
  files: [
    {
      info: {
        path: 'f.ts',
        previousPath: null,
        kind: 'text',
        additions: 2,
        deletions: 2,
        status: 'modified',
      },
      signature: 'first',
      patch,
    },
  ],
};
await test('review reports resolve diff IDs to verified single lines and ranges, including deletions', () => {
  const locate = (a: number, b: number) =>
    readFindings(report(a, b), refs, () => patch).findings[0]?.location;
  assert.equal(locate(3, 3)?.excerpt, '-two');
  assert.equal(locate(1, 2)?.excerpt, '+first\n+second');
  assert.equal(
    readFindings(report(1, 1), refs, () => '@@ -0,0 +1 @@\n+' + 'x'.repeat(5000)).findings[0]
      ?.location,
    null,
  );
  const distant = refs.map((ref) => (ref.id === 2 ? { ...ref, line: 10000 } : ref));
  assert.equal(
    readFindings(report(1, 2), distant, () =>
      assert.fail('Distant endpoints must not expand the patch.'),
    ).findings[0]?.location,
    null,
  );
  for (const [a, b] of [
    [1, 3],
    [2, 1],
    [1, 99],
  ] as const)
    assert.equal(locate(a, b), null);
  assert.deepEqual(
    readFindings('{"coverage":"Read the diff.","findings":[]}', [], () => patch).findings,
    [],
  );
  assert.throws(() => readFindings('I found nothing', [], () => patch), /unreadable findings/);
});
await test('only validated findings become drafts, atomically and once, on their reviewed revision', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'review-findings-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'db');
  const first = openStore(path);
  first.save(url);
  first.reader.install(url, snapshot);
  const { findings } = readFindings(report(1, 2), refs, () => patch);
  const f = findings[0];
  assert.ok(f);
  const msg: Turn = {
    run: randomUUID(),
    path: 'f.ts',
    revision: snapshot.revision,
    question: 'Review PR',
    answer: 'Read the diff.',
    citations: [],
    settings: first.assistant.preferences(url, 'claude').settings,
    promptVersion: 'v',
    reportedModel: null,
    findings,
  };
  first.assistant.append(url, msg, first.assistant.generation(url));
  const key = { url, run: msg.run };
  const request = { ...key, version: 0, ids: [f.id] };
  assert.throws(() => first.findings.draft(request), /valid findings/);
  first.findings.assess({ ...key, id: f.id, verdict: 'dismissed' });
  assert.throws(() => first.findings.draft(request), /valid findings/);
  first.findings.assess({ ...key, id: f.id, verdict: 'valid' });
  first.close();
  const db = openStore(path);
  t.after(() => db.close());
  assert.equal(db.assistant.history(url)[0]?.findings?.[0]?.verdict, 'valid');
  assert.throws(
    () => db.findings.draft({ ...request, ids: [f.id, randomUUID()] }),
    /valid findings/,
  );
  assert.equal(db.drafts.get(url).comments.length, 0);
  const result = db.findings.draft(request);
  assert.deepEqual(
    result.bundle.comments.map((d) => [d.path, d.startLine, d.line, d.excerpt, d.body]),
    [['f.ts', 1, 2, '+first\n+second', f.comment]],
  );
  assert.deepEqual(db.findings.draft(request), result);
  db.reader.install(url, {
    ...snapshot,
    revision: 'base...new',
    meta: { ...snapshot.meta, head: 'new' },
  });
  assert.throws(() => db.findings.draft(request), /revision changed/);
});

function suggesting(startId: number, endId: number, suggestion: unknown) {
  return JSON.stringify({
    coverage: 'Read the diff.',
    findings: [{ title: 'T', priority: 'low', comment: 'C', startId, endId, suggestion }],
  });
}
await test('a suggestion is kept only for a new-side range and only when it changes the code', () => {
  const read = (a: number, b: number, suggestion: unknown) =>
    readFindings(suggesting(a, b, suggestion), refs, () => patch).findings[0];
  assert.equal(read(1, 2, 'first!\nsecond!')?.suggestion, 'first!\nsecond!');
  assert.equal(read(1, 1, 'first!\r\n')?.suggestion, 'first!');
  // Absent, null, empty, repeated, oversized, malformed and old-side suggestions are dropped.
  for (const dropped of [
    read(1, 1, undefined),
    read(1, 1, null),
    read(1, 1, ''),
    read(1, 2, 'first\nsecond'),
    read(1, 1, 'x'.repeat(4001)),
    read(1, 1, 42),
    read(3, 3, 'two'),
  ]) {
    assert.ok(dropped);
    assert.equal('suggestion' in dropped, false);
  }
  // Without an inline location there is nothing to replace, but the finding survives.
  const located = readFindings(suggesting(99, 99, 'x'), refs, () => patch).findings[0];
  assert.equal(located?.location, null);
  assert.equal(located?.suggestion, undefined);
  // The report is still readable when the agent omits the field entirely.
  assert.equal(readFindings(report(1, 1), refs, () => patch).findings[0]?.suggestion, undefined);
});

await test('drafting a finding appends its suggestion only for new-side anchors, and older findings still load', (t) => {
  const db = openStore(':memory:');
  t.after(() => db.close());
  db.save(url);
  db.reader.install(url, snapshot);
  const parsed = (a: number, b: number, suggestion: unknown) => {
    const found = readFindings(suggesting(a, b, suggestion), refs, () => patch).findings[0];
    assert.ok(found);
    return { ...found, verdict: 'valid' as const };
  };
  const withSuggestion = parsed(1, 2, 'first!\nsecond!');
  const plain = { ...parsed(1, 1, undefined), id: randomUUID() };
  // An old-side finding that somehow carries a suggestion must not produce one.
  const removed = { ...parsed(3, 3, undefined), id: randomUUID(), suggestion: 'two!' };
  const findings = [withSuggestion, plain, removed];
  const msg: Turn = {
    run: randomUUID(),
    path: 'f.ts',
    revision: snapshot.revision,
    question: 'Review PR',
    answer: 'Read the diff.',
    citations: [],
    settings: db.assistant.preferences(url, 'claude').settings,
    promptVersion: 'v',
    reportedModel: null,
    findings,
  };
  // Turns stored before suggestions existed had no such key and must still load.
  const stored = JSON.parse(JSON.stringify(msg)) as { findings: Record<string, unknown>[] };
  delete stored.findings[0]?.suggestion;
  delete stored.findings[2]?.suggestion;
  assert.equal(JSON.stringify(stored).includes('"suggestion"'), false);
  assert.equal(turn.parse(stored).findings?.[0]?.suggestion, undefined);
  assert.equal(turn.parse(stored).findings?.length, 3);
  db.assistant.append(url, msg, db.assistant.generation(url));
  const result = db.findings.draft({
    url,
    run: msg.run,
    version: 0,
    ids: findings.map((f) => f.id),
  });
  assert.deepEqual(
    result.bundle.comments.map((d) => [d.side, d.body]),
    [
      ['new', 'C\n\n```suggestion\nfirst!\nsecond!\n```'],
      ['new', 'C'],
      ['old', 'C'],
    ],
  );
  assert.equal(db.assistant.history(url)[0]?.findings?.[0]?.suggestion, 'first!\nsecond!');
});
