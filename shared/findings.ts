import { z } from 'zod';
import { pullRequestUrl } from './reviews.js';

// Keep stored excerpts bounded even when model-supplied endpoints are far apart.
export const maxFindingLines = 50;
export const maxFindingChars = 4000;
const positive = z.number().int().positive();
export const verdict = z.enum(['unreviewed', 'valid', 'dismissed']);
export const finding = z.object({
  id: z.uuid(),
  title: z.string(),
  comment: z.string(),
  priority: z.enum(['high', 'medium', 'low']),
  location: z
    .object({
      path: z.string(),
      hunk: z.number().int().nonnegative(),
      side: z.enum(['new', 'old']),
      line: positive,
      startLine: positive.optional(),
      excerpt: z.string().max(maxFindingChars),
    })
    .nullable(),
  verdict,
  drafted: z.boolean(),
});
export const findingKey = z.object({ url: pullRequestUrl, run: z.uuid() });
export const assessFinding = findingKey.extend({ id: z.uuid(), verdict });
export const draftFindings = findingKey.extend({
  version: z.number().int().nonnegative(),
  ids: z.array(z.uuid()).min(1).max(40),
});
export type Finding = z.infer<typeof finding>;
export type AssessFinding = z.infer<typeof assessFinding>;
export type DraftFindings = z.infer<typeof draftFindings>;
