import assert from 'node:assert/strict';
import { test } from 'node:test';
import { currentRuns, outcomeOf, overallOutcome, pipelines } from '../shared/pipelines.js';
import { pipelineReader } from './pipelines.js';

const url = 'https://github.com/example/project/pull/7';
const head = 'a'.repeat(40);
const signal = new AbortController().signal;
const step = (number: number, status: string, conclusion: string | null) => ({
  number,
  name: 'Step ' + number,
  status,
  conclusion,
  started_at: '2026-01-01T00:00:0' + number + 'Z',
  completed_at: conclusion ? '2026-01-01T00:00:1' + number + 'Z' : null,
});
const run = (id: number, status: string, conclusion: string | null) => ({
  id,
  name: 'Check ' + id,
  display_title: 'Guard retries',
  event: 'pull_request',
  status,
  conclusion,
  run_attempt: 1,
  run_number: id,
  workflow_id: 100 + id,
  run_started_at: '2026-01-01T00:00:30Z',
  html_url: 'https://github.com/example/project/actions/runs/' + id,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:01:00Z',
});

await test('runs, jobs and steps are read for the pinned commit, and only unfinished runs are read again', async () => {
  const requests: string[] = [];
  let building = true;
  const read = pipelineReader((endpoint) => {
    requests.push(endpoint);
    if (endpoint.includes('/actions/runs?'))
      return Promise.resolve(
        JSON.stringify({
          total_count: 20,
          workflow_runs: [
            run(3, building ? 'in_progress' : 'completed', building ? null : 'failure'),
            run(2, 'completed', 'success'),
            run(1, 'waiting', null),
          ],
        }),
      );
    if (endpoint.includes('/runs/1/')) return Promise.reject(new Error('Not found'));
    const live = endpoint.includes('/runs/3/') && building;
    return Promise.resolve(
      JSON.stringify({
        jobs: [
          {
            id: 30,
            name: 'build',
            status: live ? 'in_progress' : 'completed',
            conclusion: live ? null : endpoint.includes('/runs/3/') ? 'failure' : 'success',
            started_at: '2026-01-01T00:00:00Z',
            completed_at: live ? null : '2026-01-01T00:01:00Z',
            html_url: 'https://github.com/example/project/actions/runs/3/job/30',
            // GitHub does not promise step order.
            steps: [
              step(2, live ? 'in_progress' : 'completed', live ? null : 'failure'),
              step(1, 'completed', 'success'),
            ],
          },
        ],
      }),
    );
  });
  const first = pipelines.parse(await read(url, head, signal));
  assert.equal(requests[0], 'repos/example/project/actions/runs?head_sha=' + head + '&per_page=15');
  assert.equal(first.truncated, true);
  // Durations run from when the attempt started, not from when it was queued.
  assert.deepEqual(
    [first.runs[0]?.startedAt, first.runs[0]?.workflowId],
    ['2026-01-01T00:00:30Z', 103],
  );
  assert.deepEqual(
    first.runs.map((r) => [r.id, r.state, outcomeOf(r), r.jobsLoaded, r.jobs.length]),
    [
      [3, 'in_progress', 'running', true, 1],
      [2, 'completed', 'passed', true, 1],
      // An unfamiliar status counts as queued, and unreadable jobs do not hide the run.
      [1, 'queued', 'queued', false, 0],
    ],
  );
  assert.deepEqual(
    first.runs[0]?.jobs[0]?.steps.map((s) => [s.number, outcomeOf(s)]),
    [
      [1, 'passed'],
      [2, 'running'],
    ],
  );
  assert.equal(overallOutcome(first.runs), 'running');
  building = false;
  requests.length = 0;
  const second = await read(url, head, signal);
  // The finished run's jobs are reused. The others are read again.
  assert.deepEqual(
    requests.filter((r) => r.includes('/jobs')).map((r) => /runs\/(\d+)\//.exec(r)?.[1]),
    ['3', '1'],
  );
  assert.equal(second.runs[1]?.jobs.length, 1);
  assert.equal(overallOutcome(second.runs), 'failed');
  await assert.rejects(read(url, 'main', signal), /no pinned commit/);
  const unavailable = pipelineReader(() => Promise.reject(new Error('HTTP 404')));
  await assert.rejects(unavailable(url, head, signal), /Could not read GitHub Actions runs/);
});

await test('overall standing ranks failure over work in progress over a pass, counting only the newest run of each workflow', () => {
  let next = 1;
  const item = (
    state: 'queued' | 'in_progress' | 'completed',
    conclusion: string | null,
    workflowId = 0,
    event = 'pull_request',
  ) => {
    const id = next++;
    return pipelines.shape.runs.element.parse({
      id,
      workflowId: workflowId || 1000 + id,
      workflow: 'w',
      title: '',
      event,
      state,
      conclusion,
      attempt: 1,
      number: id,
      url: 'https://github.com/o/r/actions/runs/' + id,
      startedAt: '',
      updatedAt: '',
      jobs: [],
      jobsLoaded: true,
    });
  };
  assert.equal(overallOutcome([]), 'none');
  assert.equal(
    overallOutcome([item('completed', 'success'), item('completed', 'skipped')]),
    'passed',
  );
  assert.equal(
    overallOutcome([item('completed', 'skipped'), item('completed', 'stale')]),
    'skipped',
  );
  assert.equal(overallOutcome([item('completed', 'success'), item('queued', null)]), 'queued');
  assert.equal(overallOutcome([item('in_progress', null), item('queued', null)]), 'running');
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'startup_failure', null])
    assert.equal(
      overallOutcome([item('in_progress', null), item('completed', conclusion)]),
      'failed',
    );
  // A fork PR whose workflows await a maintainer's approval has not failed.
  const awaiting = item('completed', 'action_required');
  assert.equal(outcomeOf(awaiting), 'waiting');
  assert.equal(overallOutcome([awaiting, item('completed', 'success')]), 'waiting');
  assert.equal(overallOutcome([awaiting, item('in_progress', null)]), 'running');
  // A cancelled or failed run that a newer run of the same workflow replaced is history.
  const failed = item('completed', 'failure', 7),
    cancelled = item('completed', 'cancelled', 7),
    rerun = item('completed', 'success', 7),
    onPush = item('completed', 'failure', 7, 'push');
  assert.equal(overallOutcome([rerun, cancelled, failed]), 'passed');
  assert.deepEqual([...currentRuns([failed, rerun, cancelled])], [rerun]);
  // The same workflow triggered by another event is judged separately.
  assert.equal(overallOutcome([rerun, failed, onPush]), 'failed');
});
