import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { annotatedHunk, locateFailure, readFailure } from './check-failures.js';
import { pipelineReader } from './pipelines.js';
import type { githubApi } from './github.js';

const key = {
  url: 'https://github.com/team/pull/pull/8',
  revision: 'saved',
  head: 'a'.repeat(40),
  run: 70,
  attempt: 2,
  job: 91,
  session: randomUUID(),
};
const signal = new AbortController().signal;
const root = 'repos/team/pull';
const attemptJobs = root + '/actions/runs/70/attempts/2/jobs?per_page=100&page=1';
const check = root + '/check-runs/123';
const job = {
  id: 91,
  run_id: 70,
  run_attempt: 2,
  head_sha: key.head,
  name: 'tests',
  status: 'completed',
  conclusion: 'failure',
  check_run_url: 'https://api.github.com/repos/team/pull/check-runs/123',
};
const row = {
  annotation_level: 'failure',
  title: 'Expected 2',
  message: 'Assertion failed',
  path: 'src/math.ts',
  start_line: 2,
  end_line: 3,
};

await test('annotations come only from the failed job’s own check run and attempt, using read requests', async () => {
  const calls: string[] = [];
  const api: typeof githubApi = (endpoint) => {
    calls.push(endpoint);
    if (endpoint === attemptJobs) return Promise.resolve(JSON.stringify({ jobs: [job] }));
    if (endpoint === check) return Promise.resolve(JSON.stringify({ id: 123, head_sha: key.head }));
    if (endpoint === check + '/annotations?per_page=100&page=1')
      return Promise.resolve(JSON.stringify(Array.from({ length: 100 }, () => row)));
    if (endpoint === check + '/annotations?per_page=100&page=2')
      return Promise.resolve(
        JSON.stringify([
          { ...row, path: null, start_line: null, end_line: null, message: 'Runner setup failed.' },
        ]),
      );
    throw Error('Unexpected endpoint');
  };
  const report = await readFailure(key, pipelineReader(api).attemptJobs, signal, api);
  assert.deepEqual(calls, [
    attemptJobs,
    check,
    check + '/annotations?per_page=100&page=1',
    check + '/annotations?per_page=100&page=2',
  ]);
  assert.equal(report.annotations.length, 101);
  assert.deepEqual(report.annotations[0]?.location, { path: row.path, start: 2, end: 3 });
  assert.equal(report.annotations.at(-1)?.location, null);
  assert.equal(report.annotations.at(-1)?.message, 'Runner setup failed.');
  assert.equal(report.notice, null);
});

await test('mismatched jobs and check runs never produce source jumps', async () => {
  for (const different of [
    { head_sha: 'b'.repeat(40) },
    { run_id: 71 },
    { run_attempt: 1 },
    { conclusion: 'success' },
  ]) {
    const api: typeof githubApi = (endpoint) => {
      assert.equal(endpoint, attemptJobs);
      return Promise.resolve(JSON.stringify({ jobs: [{ ...job, ...different }] }));
    };
    await assert.rejects(readFailure(key, pipelineReader(api).attemptJobs, signal, api), /job/i);
  }
  for (const result of [
    { id: 123, head_sha: 'b'.repeat(40) },
    { id: 91, head_sha: key.head },
  ]) {
    const calls: string[] = [];
    const api: typeof githubApi = (endpoint) => {
      calls.push(endpoint);
      return Promise.resolve(JSON.stringify(endpoint === attemptJobs ? { jobs: [job] } : result));
    };
    const report = await readFailure(key, pipelineReader(api).attemptJobs, signal, api);
    assert.deepEqual(calls, [attemptJobs, check]);
    assert.deepEqual(report.annotations, []);
    assert.match(report.notice ?? '', /matched/);
  }
});

await test('ranges use head-side lines and unchanged context opens pinned source', async () => {
  const patch =
    '@@ -1,2 +1,2 @@\n-old first\n+new first\n context\n@@ -10 +10,2 @@\n-removed\n+new\n+more';
  const range = { path: 'a.ts', start: 9, end: 11 };
  const location = await annotatedHunk(patch, range, signal);
  assert.ok(location?.kind === 'hunk');
  assert.equal(location.hunk, 2);
  assert.deepEqual(
    location.rows.filter((r) => r.newLine !== null).map((r) => r.newLine),
    [10, 11],
  );
  const source = await locateFailure(
    { ...range, start: 2, end: 2 },
    key.head,
    patch,
    {
      read: (sha, path, line) => {
        assert.deepEqual([sha, path, line], [key.head, 'a.ts', 2]);
        return Promise.resolve({
          path,
          commit: sha,
          totalLines: 2,
          lines: [{ line: 2, text: 'context' }],
          link: 'fixture',
          nextStart: null,
        });
      },
    },
    signal,
  );
  assert.equal(source.kind, 'source');
  assert.equal(
    await annotatedHunk('@@ -2,1 +1,0 @@\n-gone', { ...range, start: 1, end: 1 }, signal),
    null,
  );
});

await test('late failures in a large hunk return a bounded excerpt and allow cancellation', async () => {
  const rows = 150000;
  const patch = '@@ -0,0 +1,' + rows + ' @@\n' + '+added\n'.repeat(rows);
  const range = { path: 'big.ts', start: rows - 2, end: rows - 2 };
  const found = await annotatedHunk(patch, range, signal);
  assert.ok(found?.kind === 'hunk');
  assert.equal(found.rows[6]?.newLine, range.start);
  assert.equal(found.rows.length, 9);
  const controller = new AbortController();
  const pending = annotatedHunk(patch, range, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});
