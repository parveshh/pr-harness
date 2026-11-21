import { pinnedQuestion } from './questions.js';
import { comparison } from './rereview.js';
import { z } from 'zod';
import { pullRequestUrl } from './reviews.js';

const count = z.number().int().nonnegative();
export const metadata = z.object({
  title: z.string(),
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
export const fileKey = z.object({ url: pullRequestUrl, revision: z.string(), path: z.string() });
export const checkpoint = fileKey.extend(position.shape);
export type FileKey = z.infer<typeof fileKey>;
export type Checkpoint = z.infer<typeof checkpoint>;
export type ReviewMeta = z.infer<typeof metadata>;
export type FileInfo = z.infer<typeof fileInfo>;
export type ReaderFile = z.infer<typeof readerFile>;
export type ReaderView = z.infer<typeof readerView>;

export function splitHunks(patch: string) {
  return patch ? patch.replace(/\n$/, '').split(/\n(?=@@ )/) : [];
}
