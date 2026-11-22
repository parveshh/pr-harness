import { z } from 'zod';
import { pullRequestUrl } from './reviews.js';

const positive = z.number().int().positive();
export const attemptKey = z.object({
  url: pullRequestUrl,
  revision: z.string().min(1),
  head: z.string().regex(/^[0-9a-f]{40}$/),
  run: positive,
  attempt: positive,
});
export const failureKey = attemptKey.extend({ job: positive, session: z.uuid() });
const sourceRange = z.object({
  path: z.string().min(1),
  start: positive,
  end: positive,
});
export type FailureRange = z.infer<typeof sourceRange>;
export const failureAnnotation = z.object({
  location: sourceRange.nullable(),
  title: z.string(),
  message: z.string(),
  level: z.enum(['failure', 'warning', 'notice']),
});
export const failureReport = z.object({
  annotations: failureAnnotation.array(),
  notice: z.string().nullable(),
});
const codeRow = z.object({
  oldLine: positive.nullable(),
  newLine: positive.nullable(),
  text: z.string(),
});
export const failureLocation = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hunk'), hunk: positive, heading: z.string(), rows: codeRow.array() }),
  z.object({ kind: z.literal('source'), rows: codeRow.array() }),
  z.object({ kind: z.literal('unavailable'), reason: z.string() }),
]);
export type AttemptKey = z.infer<typeof attemptKey>;
export type FailureKey = z.infer<typeof failureKey>;
export type FailureAnnotation = z.infer<typeof failureAnnotation>;
export type FailureReport = z.infer<typeof failureReport>;
export type FailureLocation = z.infer<typeof failureLocation>;
