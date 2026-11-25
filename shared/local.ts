import { z } from 'zod';
import type { Draft } from './publish.js';
import { revisionHead, uncommittedDigest } from './reader.js';
import { localReviewKey, reviewList } from './reviews.js';
import { parseBody } from './suggestions.js';

export const baseOption = z.object({ ref: z.string().min(1), name: z.string().min(1) });
// A repository the reviewer chose in the folder dialog. The main process keeps the path
// for `id`; starting a review names only the id and one of the listed base refs.
export const localCandidate = z.object({
  id: z.uuid(),
  path: z.string(),
  repository: z.string(),
  branch: z.string().nullable(),
  head: z.string(),
  bases: baseOption.array(),
  defaultBase: z.string().nullable(),
});
export const localStart = z.object({ id: z.uuid(), base: z.string().min(1).max(1024) });
export const localStarted = z.object({ url: localReviewKey, reviews: reviewList });
export const localBrief = z.object({
  version: z.number().int().nonnegative(),
  revision: z.string(),
  text: z.string(),
});
export type BaseOption = z.infer<typeof baseOption>;
export type LocalCandidate = z.infer<typeof localCandidate>;
export type LocalStarted = z.infer<typeof localStarted>;
export type LocalBrief = z.infer<typeof localBrief>;
export interface LocalBridge {
  chooseLocalRepository(): Promise<LocalCandidate | null>;
  startLocalReview(id: string, base: string): Promise<LocalStarted>;
  localBrief(url: string): Promise<LocalBrief>;
  // Both name the previewed brief, so a changed draft or revision is refused.
  copyLocalBrief(url: string, version: number, revision: string): Promise<void>;
  // Resolves false when the reviewer cancels the save dialog.
  saveLocalBrief(url: string, version: number, revision: string): Promise<boolean>;
}

export type BriefInput = {
  repository: string;
  branch: string | null;
  baseBranch: string;
  revision: string;
  mergeBase: string | null;
  summary: string;
  comments: Draft[];
};

function longestRun(text: string, char: string) {
  let longest = 0,
    run = 0;
  for (const c of text) {
    run = c === char ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest;
}
// A code span that survives backticks and line breaks in its content.
export function inlineCode(text: string) {
  const value = text.replace(/\r?\n/g, ' ');
  const ticks = '`'.repeat(longestRun(value, '`') + 1);
  const pad = value.startsWith('`') || value.endsWith('`') ? ' ' : '';
  return ticks + pad + value + pad + ticks;
}
export function fencedBlock(text: string, info = '') {
  const fence = '`'.repeat(Math.max(3, longestRun(text, '`') + 1));
  return fence + info + '\n' + text.replace(/\n$/, '') + '\n' + fence;
}
function quote(text: string) {
  return text
    .replace(/\r\n/g, '\n')
    .trim()
    .split('\n')
    .map((line) => (line ? '> ' + line : '>'))
    .join('\n');
}
export function briefLocation(d: Draft) {
  const lines = d.startLine && d.startLine !== d.line ? d.startLine + '–' + d.line : d.line;
  return (
    inlineCode(d.path + ':' + lines) +
    (d.side === 'old' ? ' (old side, removed lines)' : ' (new side)')
  );
}
// Prose is quoted. A suggestion becomes a code block the agent can paste over the commented lines.
function commentBody(body: string) {
  const parts = parseBody(body).map((segment) =>
    segment.kind === 'text'
      ? quote(segment.text)
      : segment.lines.length
        ? '**Suggested replacement** for the commented lines:\n\n' +
          fencedBlock(segment.lines.join('\n'))
        : '**Suggested replacement:** delete the commented lines.',
  );
  return parts.length ? parts.join('\n\n') : '> (empty comment)';
}
function comment(d: Draft, index: number) {
  return [
    '### ' + (index + 1) + '. ' + briefLocation(d),
    d.excerpt ? fencedBlock(d.excerpt, 'diff') : '_No code excerpt was saved._',
    commentBody(d.body),
  ].join('\n\n');
}

// The Markdown handed back to the coding agent when a local branch review is finished.
export function localReviewBrief(input: BriefInput) {
  const head = revisionHead(input.revision);
  const digest = uncommittedDigest(input.revision);
  const commit = head.replace(/\+.*$/, '');
  const branch = input.branch ?? 'detached HEAD';
  const current = input.comments.filter((d) => d.revision === input.revision);
  const outdated = input.comments.filter((d) => d.revision !== input.revision);
  const parts = [
    '# Review of ' + inlineCode(branch) + ' against ' + inlineCode(input.baseBranch),
    [
      'A reviewer read the changes in the ' +
        inlineCode(input.repository) +
        ' repository and left the comments below. Address each comment, then summarise what you changed.',
      'Reviewed revision: commit ' +
        inlineCode(commit.slice(0, 12)) +
        (digest
          ? ' with uncommitted changes (working tree state ' + inlineCode(digest) + ')'
          : '') +
        ', compared with merge base ' +
        inlineCode((input.mergeBase ?? 'unknown').slice(0, 12)) +
        ' of ' +
        inlineCode(input.baseBranch) +
        '.',
      'New-side line numbers refer to the files as they were in that reviewed revision. Old-side line numbers refer to the merge base. If the code has moved since, find it by its excerpt.',
    ].join(' '),
  ];
  if (input.summary.trim()) parts.push('## Summary', quote(input.summary));
  if (current.length)
    parts.push('## Comments (' + current.length + ')', ...current.map((d, i) => comment(d, i)));
  if (outdated.length)
    parts.push(
      '## Outdated comments (' + outdated.length + ')',
      'These comments were written against an earlier revision and could not be matched to the reviewed lines. Their line numbers refer to that earlier revision. Use the excerpt to locate the code before acting on them.',
      ...outdated.map((d, i) => comment(d, i)),
    );
  if (!current.length && !outdated.length && !input.summary.trim())
    parts.push('The reviewer recorded no comments.');
  return parts.join('\n\n') + '\n';
}
