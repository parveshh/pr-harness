import { z } from 'zod';
import { repoOf } from '../shared/assistant.js';
import type {
  FailureAnnotation,
  FailureKey,
  FailureRange,
  FailureLocation,
  FailureReport,
} from '../shared/failure.js';
import { outcomeOf } from '../shared/pipelines.js';
import { hunkLineCounter } from '../shared/diff.js';
import { setImmediate as yieldToApp } from 'node:timers/promises';
import { githubApi } from './github.js';
import type { pinnedSource } from './pr-source.js';
import type { pipelineReader } from './pipelines.js';

const positive = z.number().int().positive();
const check = z.object({ id: positive, head_sha: z.string() });
const remoteAnnotation = z.object({
  path: z.string().nullish(),
  start_line: z.number().int().nullish(),
  end_line: z.number().int().nullish(),
  title: z.string().nullish(),
  message: z.string().nullish(),
  annotation_level: z.enum(['notice', 'warning', 'failure']),
});

export async function readFailure(
  key: FailureKey,
  jobs: ReturnType<typeof pipelineReader>['attemptJobs'],
  signal: AbortSignal,
  api = githubApi,
): Promise<FailureReport> {
  const job = (await jobs(key, signal)).find((j) => j.id === key.job);
  if (!job || outcomeOf(job) !== 'failed')
    throw Error('This failed job is unavailable for the selected commit and attempt.');
  const annotations: FailureAnnotation[] = [];
  if (!job.checkId)
    return { annotations, notice: 'GitHub did not supply a check run for this job.' };
  const root = 'repos/' + repoOf(key.url) + '/check-runs/' + job.checkId;
  let notice: string | null = null;
  try {
    const owner = check.parse(JSON.parse(await api(root, signal)));
    if (owner.id !== job.checkId || owner.head_sha !== key.head) {
      return {
        annotations,
        notice:
          'The check run could not be matched to the reviewed commit. Inspect the original job on GitHub.',
      };
    }
    let textBudget = 512000;
    for (let page = 1; page <= 5; page++) {
      const batch = z
        .array(z.unknown())
        .parse(JSON.parse(await api(root + '/annotations?per_page=100&page=' + page, signal)));
      for (const value of batch) {
        const parsed = remoteAnnotation.safeParse(value);
        if (!parsed.success) {
          notice =
            'Some annotations have incomplete locations or severity and could not be displayed.';
          continue;
        }
        const a = parsed.data;
        annotations.push({
          location:
            a.path && a.start_line && a.start_line > 0 && a.end_line && a.end_line >= a.start_line
              ? { path: a.path, start: a.start_line, end: a.end_line }
              : null,
          title: a.title ?? '',
          message: a.message ?? '',
          level: a.annotation_level,
        });
        textBudget -= (a.path?.length ?? 0) + (a.title?.length ?? 0) + (a.message?.length ?? 0);
        if (textBudget <= 0)
          return {
            annotations,
            notice:
              'Showing the first part of the annotation output. Open the original job for the remainder.',
          };
      }
      if (batch.length < 100) break;
      if (page === 5)
        notice =
          'Showing up to 500 annotations. Additional annotations may be available on GitHub.';
    }
  } catch {
    signal.throwIfAborted();
    notice = annotations.length
      ? 'The remaining annotations could not be read. Retry or open the original job.'
      : 'Check annotations are unavailable. Retry or open the original job.';
  }
  return { annotations, notice };
}

// Only new-side coordinates belong to the reviewed head. Deleted rows remain visible as context.
export async function annotatedHunk(
  patch: string,
  annotation: FailureRange,
  signal: AbortSignal,
): Promise<FailureLocation | null> {
  let hunk = 0,
    scanned = 0;
  for (const header of patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@[^\n]*/gm)) {
    hunk++;
    if (hunk % 8192 === 0) await yieldToApp();
    signal.throwIfAborted();
    const first = Number(header[1]),
      count = Number(header[2] ?? 1);
    if (!count || first > annotation.end || first + count <= annotation.start) continue;
    const heading = header[0],
      numberRow = hunkLineCounter(heading);
    const rows: Extract<FailureLocation, { kind: 'hunk' }>['rows'] = [];
    let following: number | null = null;
    for (let at = header.index + heading.length + 1; at < patch.length;) {
      if (patch.startsWith('@@ ', at)) break;
      if (++scanned % 8192 === 0) {
        await yieldToApp();
        signal.throwIfAborted();
      }
      const next = patch.indexOf('\n', at);
      const row = numberRow(patch.slice(at, next < 0 ? undefined : next));
      const { oldLine, newLine } = row;
      if (following === null && newLine !== null && newLine > annotation.end) break;
      if (
        following === null &&
        row.kind === 'addition' &&
        newLine !== null &&
        newLine >= annotation.start
      )
        following = 12;
      else if (following !== null) following--;
      rows.push({ oldLine, newLine, text: excerpt(row.text) });
      if (following === null && rows.length > 6) rows.shift();
      if (following === 0 || next < 0) break;
      at = next + 1;
    }
    if (following !== null) return { kind: 'hunk', hunk, heading: excerpt(heading), rows };
  }
  return null;
}
function excerpt(text: string) {
  return text.length <= 2000 ? text : text.slice(0, 2000) + '…';
}

export async function locateFailure(
  annotation: FailureRange,
  head: string,
  patch: string | null,
  source: Pick<ReturnType<typeof pinnedSource>, 'read'>,
  signal: AbortSignal,
): Promise<FailureLocation> {
  const hunk = patch && (await annotatedHunk(patch, annotation, signal));
  if (hunk) return hunk;
  try {
    // Start at the cited line so even long preceding lines cannot consume the excerpt budget.
    const page = await source.read(head, annotation.path, annotation.start, signal);
    if (page.lines?.some((row) => row.line === annotation.start))
      return {
        kind: 'source',
        rows: page.lines.slice(0, 15).map((row) => ({
          oldLine: null,
          newLine: row.line,
          text: row.text + (row.truncated ? '…' : ''),
        })),
      };
    return {
      kind: 'unavailable',
      reason: page.unavailable ?? 'The annotated line is outside this file at the reviewed commit.',
    };
  } catch {
    signal.throwIfAborted();
    return {
      kind: 'unavailable',
      reason:
        'Could not read this path at the reviewed commit. Check repository access or inspect the original job.',
    };
  }
}
