import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { openStore } from './store.js';
import { changedPulls, investigate, prepareComparison } from './cross-pr.js';
import type { Snapshot } from './github.js';
import { pairRequest } from '../shared/cross-pr.js';

const repo = 'team/pull';
const base = 'a'.repeat(40),
  mergeBase = 'b'.repeat(40);
const req = { repo, left: 12, right: 13, run: randomUUID() };
const signal = new AbortController().signal;
const url = (n: number) => 'https://github.com/' + repo + '/pull/' + n;
function fixture(n: number): Snapshot {
  const left = n === 12;
  const head = (left ? 'c' : 'd').repeat(40);
  return {
    revision: base + '...' + head,
    meta: {
      title: 'PR ' + n,
      head,
      base,
      mergeBase,
      baseBranch: 'main',
      headBranch: 'feature-' + n,
      author: 'reader',
      description: '',
      totalFiles: left ? 2 : 1,
    },
    files: [
      {
        info: {
          path: left ? 'new name.ts' : 'old name.ts',
          previousPath: left ? 'old name.ts' : null,
          status: left ? 'renamed' : 'modified',
          additions: 1,
          deletions: 1,
          kind: left ? 'partial' : 'text',
        },
        signature: 'file-' + n,
        patch: '@@ -7 +8 @@\n-old()\n+revised()',
      },
    ],
  };
}
function setup() {
  const store = openStore(':memory:');
  for (const n of [12, 13]) {
    store.save(url(n));
    store.reader.install(url(n), fixture(n));
  }
  store.reader.select(url(12));
  const live = new Map(
    [12, 13].map((n) => [
      n,
      { state: 'open', head: { sha: fixture(n).meta.head }, base: { ref: 'main', sha: base } },
    ]),
  );
  const api = (endpoint: string) => {
    const n = Number(endpoint.split('/').at(-1));
    assert.equal(endpoint, 'repos/team/pull/pulls/' + n);
    return Promise.resolve(JSON.stringify(live.get(n)));
  };
  return { store, live, api };
}
await test('pair reuses saved revisions, includes rename overlap, preserves reader progress and identifies changed or closed PRs', async (t) => {
  const { store, live, api } = setup();
  t.after(() => store.close());
  const original = store.reader.read(url(12));
  const pair = await prepareComparison(req, store.reader, signal, api);
  assert.deepEqual(
    pair.summary.overlaps.map((x) => x.path),
    ['old name.ts'],
  );
  assert.deepEqual(
    pair.left.map((e) => [e.path, e.commit, e.line]),
    [
      ['old name.ts', mergeBase, 7],
      ['new name.ts', fixture(12).meta.head, 8],
    ],
  );
  assert.match(pair.summary.gaps.join(' '), /1 of 2/);
  assert.match(pair.summary.gaps.join(' '), /partial/);
  assert.equal(store.reader.active(), url(12));
  assert.deepEqual(store.reader.read(url(12)), original);
  assert.deepEqual(await changedPulls(repo, pair.summary, signal, api), {
    changed: [],
    unknown: [],
  });
  const right = live.get(13);
  assert.ok(right);
  right.base.ref = 'release';
  assert.deepEqual(await changedPulls(repo, pair.summary, signal, api), {
    changed: [13],
    unknown: [],
  });
  const partial = await changedPulls(repo, pair.summary, signal, (endpoint) =>
    endpoint.endsWith('/12') ? Promise.reject(Error('Rate limited.')) : api(endpoint),
  );
  assert.deepEqual(partial, { changed: [13], unknown: [{ number: 12, reason: 'Rate limited.' }] });
  right.state = 'closed';
  await assert.rejects(prepareComparison(req, store.reader, signal, api), /closed/);
  assert.equal(pairRequest.safeParse({ ...req, right: req.left }).success, false);
});

await test('comparison source requests stay at the pinned commit and invented evidence IDs fail explicitly', async (t) => {
  const { store, api } = setup();
  t.after(() => store.close());
  const pair = await prepareComparison(req, store.reader, signal, api);
  let round = 0;
  const result = await investigate(
    pair,
    (_instructions, input) => {
      if (round++) assert.match(input, /pinned caller/);
      const response =
        round === 1
          ? { reads: [{ side: 'right', version: 'before', path: 'caller.ts', start: 8 }] }
          : {
              findings: [
                { left: 1, right: 3, consequence: 'The caller still uses the old contract.' },
              ],
              gaps: [],
            };
      return Promise.resolve({ answer: JSON.stringify(response), reportedModel: 'fixture' });
    },
    (commit, path, start) => {
      assert.deepEqual([commit, path, start], [mergeBase, 'caller.ts', 8]);
      return Promise.resolve({
        path,
        commit,
        totalLines: 8,
        lines: [{ line: 8, text: 'pinned caller' }],
        nextStart: null,
        link: 'fixture',
      });
    },
    signal,
  );
  assert.equal(result.findings[0]?.right.commit, mergeBase);
  assert.equal(result.findings[0]?.right.text, 'pinned caller');
  await assert.rejects(
    investigate(
      pair,
      () =>
        Promise.resolve({
          answer: '{"findings":[{"left":1,"right":99,"consequence":"invalid"}],"gaps":[]}',
          reportedModel: null,
        }),
      () => {
        throw Error('unexpected read');
      },
      signal,
    ),
    /outside this comparison/,
  );
});
