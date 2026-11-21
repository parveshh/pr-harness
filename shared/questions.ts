import { z } from 'zod';
import { pullRequestUrl } from './reviews.js';

export const questionKey = z.object({ url: pullRequestUrl, revision: z.string(), id: z.uuid() });
export const hunkLocation = z.object({ path: z.string(), hunk: z.number().int().nonnegative() });
export const pinQuestion = questionKey.extend({
  ...hunkLocation.shape,
  question: z.string().trim().min(1).max(4000),
});
export const questionStatus = z.enum([
  'pinned',
  'unchanged',
  'moved',
  'changed',
  'ambiguous',
  'unavailable',
  'missing',
  'unmatched',
]);
export const pinnedQuestion = z.object({
  id: z.uuid(),
  question: z.string(),
  addressed: z.boolean(),
  status: questionStatus,
  origin: hunkLocation.extend({ revision: z.string() }),
  current: hunkLocation.nullable(),
  filePath: z.string().nullable(),
});
export const questionEvidence = z.object({
  original: z.string(),
  current: z.string().nullable(),
  originalPartial: z.boolean(),
});
export type PinnedQuestion = z.infer<typeof pinnedQuestion>;
export type QuestionKey = z.infer<typeof questionKey>;
export type PinQuestion = z.infer<typeof pinQuestion>;
export type QuestionEvidence = z.infer<typeof questionEvidence>;
