import { z } from 'zod';
import { pullRequestUrl } from '../shared/reviews.js';
import type { PipelineJob, Pipelines, PipelineRun } from '../shared/pipelines.js';
import { githubApi } from './github.js';

// GitHub also reports waiting, requested and pending. All of them mean not started yet.
const status = z
  .string()
  .transform((value): 'queued' | 'in_progress' | 'completed' =>
    value === 'completed' ? 'completed' : value === 'in_progress' ? 'in_progress' : 'queued',
  );
const progress = { status, conclusion: z.string().nullable() };
const remoteJob = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  ...progress,
  started_at: z.string().nullish(),
  completed_at: z.string().nullish(),
  html_url: z.string().nullish(),
  steps: z
    .array(
      z.object({
        number: z.number().int(),
        name: z.string(),
        ...progress,
        started_at: z.string().nullish(),
        completed_at: z.string().nullish(),
      }),
    )
    .nullish(),
});
const remoteRun = z.object({
  id: z.number().int().positive(),
  name: z.string().nullish(),
  display_title: z.string().nullish(),
  event: z.string(),
  ...progress,
  run_attempt: z.number().int().positive().nullish(),
  run_number: z.number().int().positive(),
  workflow_id: z.number().int().positive().nullish(),
  run_started_at: z.string().nullish(),
  html_url: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
const runList = z.object({
  total_count: z.number().int().nonnegative(),
  workflow_runs: z.array(remoteRun),
});
const jobList = z.object({ jobs: z.array(remoteJob) });
const shown = 15;

// Reads the GitHub Actions runs for one commit of a PR. Finished runs never change, so
// their jobs are kept and only runs still in progress are read again on each refresh.
export function pipelineReader(api = githubApi) {
  const finished = new Map<string, PipelineJob[]>();
  async function jobs(root: string, runUrl: string, id: number, signal: AbortSignal) {
    const rows: PipelineJob[] = [];
    for (let page = 1; page <= 5; page++) {
      const batch = jobList.parse(
        JSON.parse(
          await api(
            root + '/actions/runs/' + id + '/jobs?filter=latest&per_page=100&page=' + page,
            signal,
          ),
        ),
      ).jobs;
      for (const job of batch)
        rows.push({
          id: job.id,
          name: job.name,
          state: job.status,
          conclusion: job.conclusion,
          startedAt: job.started_at ?? null,
          completedAt: job.completed_at ?? null,
          url: job.html_url?.startsWith('https://github.com/') ? job.html_url : runUrl,
          steps: (job.steps ?? [])
            .map((step) => ({
              number: step.number,
              name: step.name,
              state: step.status,
              conclusion: step.conclusion,
              startedAt: step.started_at ?? null,
              completedAt: step.completed_at ?? null,
            }))
            .sort((a, b) => a.number - b.number),
        });
      if (batch.length < 100) break;
    }
    return rows;
  }
  return async function read(url: string, head: string, signal: AbortSignal): Promise<Pipelines> {
    if (!/^[0-9a-f]{40}$/.test(head)) throw new Error('This PR has no pinned commit to check.');
    const [, owner, repo] = new URL(pullRequestUrl.parse(url)).pathname.split('/');
    const root = 'repos/' + owner + '/' + repo;
    let list: z.infer<typeof runList>;
    try {
      list = runList.parse(
        JSON.parse(
          await api(root + '/actions/runs?head_sha=' + head + '&per_page=' + shown, signal),
        ),
      );
    } catch (error) {
      signal.throwIfAborted();
      // The shared GitHub errors speak of opening a PR. Say what could not be read here.
      throw new Error(
        'Could not read GitHub Actions runs for this PR. Actions may be turned off for the repository, or your account may lack access.',
        { cause: error },
      );
    }
    const runs: PipelineRun[] = [];
    for (const run of list.workflow_runs.slice(0, shown)) {
      const attempt = run.run_attempt ?? 1;
      const key = run.id + ':' + attempt;
      let found = finished.get(key),
        jobsLoaded = true;
      if (!found) {
        try {
          found = await jobs(root, run.html_url, run.id, signal);
          if (run.status === 'completed') {
            // Bound the memory kept for a long session.
            if (finished.size >= 200) finished.clear();
            finished.set(key, found);
          }
        } catch {
          // The run is still worth showing when its jobs cannot be read.
          signal.throwIfAborted();
          found = [];
          jobsLoaded = false;
        }
      }
      runs.push({
        id: run.id,
        workflowId: run.workflow_id ?? 0,
        workflow: run.name ?? 'Workflow',
        title: run.display_title ?? '',
        event: run.event,
        state: run.status,
        conclusion: run.conclusion,
        attempt,
        number: run.run_number,
        url: run.html_url,
        startedAt: run.run_started_at ?? run.created_at,
        updatedAt: run.updated_at,
        jobs: found,
        jobsLoaded,
      });
    }
    return { head, runs, truncated: list.total_count > runs.length };
  };
}
