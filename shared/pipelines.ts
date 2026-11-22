import type { AttemptKey, FailureKey, FailureReport, FailureLocation } from './failure.js';
import { z } from 'zod';

// A GitHub Actions workflow run for the PR's head commit, its jobs and their steps.
export const pipelineState = z.enum(['queued', 'in_progress', 'completed']);
const moment = z.string().nullable();
const link = z.string().startsWith('https://github.com/');
const progress = { state: pipelineState, conclusion: z.string().nullable() };
export const pipelineStep = z.object({
  number: z.number().int(),
  name: z.string(),
  ...progress,
  startedAt: moment,
  completedAt: moment,
});
export const pipelineJob = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  ...progress,
  startedAt: moment,
  completedAt: moment,
  url: link,
  steps: z.array(pipelineStep),
});
export const pipelineRun = z.object({
  id: z.number().int().positive(),
  // Runs of one workflow share this ID. Zero when GitHub did not report it.
  workflowId: z.number().int().nonnegative(),
  workflow: z.string(),
  title: z.string(),
  event: z.string(),
  ...progress,
  attempt: z.number().int().positive(),
  number: z.number().int().positive(),
  url: link,
  // When this attempt began running, which is later than when it was queued.
  startedAt: z.string(),
  updatedAt: z.string(),
  jobs: z.array(pipelineJob),
  // False when the run's jobs could not be read.
  jobsLoaded: z.boolean(),
});
export const pipelines = z.object({
  head: z.string(),
  runs: z.array(pipelineRun),
  // True when the commit has more runs than are shown.
  truncated: z.boolean(),
});
export type Pipelines = z.infer<typeof pipelines>;
export type PipelineRun = z.infer<typeof pipelineRun>;
export type PipelineJob = z.infer<typeof pipelineJob>;
export type PipelineStep = z.infer<typeof pipelineStep>;
export type PipelineOutcome = 'running' | 'queued' | 'waiting' | 'failed' | 'passed' | 'skipped';
export interface PipelineBridge {
  pipelineAttempt(key: AttemptKey, session: string): Promise<PipelineJob[]>;
  investigateFailure(key: FailureKey): Promise<FailureReport>;
  failureLocation(session: string, index: number, request: string): Promise<FailureLocation>;
  closeFailureLocation(request: string): Promise<void>;
  closeFailure(session: string): Promise<void>;
  pipelines(url: string): Promise<Pipelines>;
}

const neutral = new Set(['skipped', 'neutral', 'stale']);
type Progress = { state: z.infer<typeof pipelineState>; conclusion: string | null };
// How one run, job or step stands. A run that needs a maintainer's approval before it may
// start is waiting, as GitHub treats it. Anything else finished that neither succeeded
// nor was skipped counts as failed, including cancelled and timed-out work.
export function outcomeOf(item: Progress): PipelineOutcome {
  if (item.state === 'queued') return 'queued';
  if (item.state === 'in_progress') return 'running';
  if (item.conclusion === 'success') return 'passed';
  if (item.conclusion === 'action_required') return 'waiting';
  return item.conclusion && neutral.has(item.conclusion) ? 'skipped' : 'failed';
}
// The newest run of each workflow for each event. An earlier run of the same workflow on
// the same commit, such as one cancelled or re-triggered, no longer speaks for the PR.
export function currentRuns(runs: PipelineRun[]) {
  const newest = new Map<string, PipelineRun>();
  for (const run of runs) {
    const key = (run.workflowId || run.workflow) + ':' + run.event;
    const other = newest.get(key);
    if (
      !other ||
      run.number > other.number ||
      (run.number === other.number && run.attempt > other.attempt)
    )
      newest.set(key, run);
  }
  return new Set(newest.values());
}
// The PR's overall standing: a failure outranks work in progress, which outranks a pass.
export function overallOutcome(runs: PipelineRun[]): PipelineOutcome | 'none' {
  if (!runs.length) return 'none';
  const outcomes = new Set([...currentRuns(runs)].map(outcomeOf));
  for (const outcome of ['failed', 'running', 'queued', 'waiting', 'passed'] as const)
    if (outcomes.has(outcome)) return outcome;
  return 'skipped';
}
