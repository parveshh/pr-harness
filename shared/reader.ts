import { pinnedQuestion } from './questions.js';
import { comparison } from './rereview.js';
import { z } from 'zod';
import { reviewKey } from './reviews.js';

const count = z.number().int().nonnegative();
export const metadata = z.object({
  title: z.string(),
  isDraft: z.boolean().optional(),
  author: z.string(),
  description: z.string(),
  totalFiles: count,
  mergeBase: z.string().nullable().optional(),
  base: z.string(),
  head: z.string(),
  baseBranch: z.string(),
  headBranch: z.string(),
});
export const fileInfo = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  status: z.string(),
  additions: count,
  deletions: count,
  kind: z.enum(['text', 'binary', 'metadata', 'unavailable', 'partial']),
});
export const position = z.object({ hunk: count, scroll: count, reviewed: z.boolean() });
export const readerFile = fileInfo.extend({
  ...position.shape,
  needsReview: z.literal(true).optional(),
});
export const readerView = z.object({
  meta: metadata,
  questions: pinnedQuestion.array().optional(),
  incoming: z.string().nullable().optional(),
  comparison: comparison.nullable().optional(),
  since: z.boolean().optional(),
  changePath: z.string().nullable().optional(),
  revision: z.string(),
  selected: z.string().nullable(),
  files: z.array(readerFile),
});
export const reviewUpdate = z.object({
  incoming: z.string().nullable(),
  isDraft: z.boolean().optional(),
});
export const fileKey = z.object({ url: reviewKey, revision: z.string(), path: z.string() });
export const checkpoint = fileKey.extend(position.shape);
export type FileKey = z.infer<typeof fileKey>;
export type Checkpoint = z.infer<typeof checkpoint>;
export type ReviewMeta = z.infer<typeof metadata>;
export type FileInfo = z.infer<typeof fileInfo>;
export type ReaderFile = z.infer<typeof readerFile>;
export type ReaderView = z.infer<typeof readerView>;

// A GitHub revision is `base...head`. A local branch revision is `mergeBase...head`, with
// `+digest` appended when the working tree has uncommitted changes.
export function revisionHead(revision: string) {
  return revision.split('...').at(-1) ?? revision;
}
export function uncommittedDigest(revision: string) {
  return /\+([0-9a-f]{12})$/.exec(revisionHead(revision))?.[1] ?? null;
}
export function shortRevision(revision: string) {
  const head = revisionHead(revision);
  const digest = uncommittedDigest(revision);
  return head.slice(0, 8) + (digest ? '+' + digest.slice(0, 6) : '');
}

export function splitHunks(patch: string) {
  return patch ? patch.replace(/\n$/, '').split(/\n(?=@@ )/) : [];
}
