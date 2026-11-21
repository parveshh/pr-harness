import { z } from 'zod';

export const ancestry = z.enum(['ahead', 'rewritten', 'same', 'unknown']);
export const changeFile = z.object({
  path: z.string(),
  reviewed: z.boolean().optional(),
  state: z.enum(['changed', 'entered', 'left', 'unconfirmed', 'head-only']),
});
export const comparison = z.object({
  baseline: z.string(),
  baseChanged: z.boolean(),
  ancestry,
  partial: z.boolean(),
  files: changeFile.array(),
});
export const changeEvidence = z.object({
  before: z.string().nullable(),
  after: z.string().nullable(),
  incremental: z.string().nullable(),
});
export type Comparison = z.infer<typeof comparison>;
export type ChangeEvidence = z.infer<typeof changeEvidence>;
