import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatRuns } from './chat-runs.js';

await test('each PR runs one answer at a time, independently of other PRs', () => {
  const runs = chatRuns(2);
  const first = runs.begin('pr-a', 'run-1');
  assert.throws(() => runs.begin('pr-a', 'run-2'), /already running for this PR/);
  const second = runs.begin('pr-b', 'run-3');
  assert.throws(() => runs.begin('pr-c', 'run-4'), /2 answers are already running/);
  runs.cancel('run-1');
  assert.equal(first.aborted, true);
  assert.equal(second.aborted, false);
  // A cancelled run still holds its PR until it has finished unwinding.
  assert.throws(() => runs.begin('pr-a', 'run-5'), /already running for this PR/);
  runs.end('pr-a', 'run-1');
  const next = runs.begin('pr-a', 'run-5');
  // The earlier run finishing again must not release the newer one.
  runs.end('pr-a', 'run-1');
  assert.throws(() => runs.begin('pr-a', 'run-6'), /already running for this PR/);
  runs.cancelAll();
  assert.equal(next.aborted, true);
  assert.equal(second.aborted, true);
});
