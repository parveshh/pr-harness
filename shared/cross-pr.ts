import { z } from 'zod';
import { agentId, repoName } from './assistant.js';

const number = z.number().int().positive();
export const commitSha = z.string().regex(/^[a-f0-9]{40}$/);
export const candidate = z.object({ number, title: z.string(), baseBranch: z.string().min(1) });
export const pairRequest = z
  .object({ run: z.uuid(), repo: repoName, left: number, right: number })
  .refine((value) => value.left !== value.right, 'Choose two different pull requests.');
export const pairPin = candidate.extend({ base: commitSha, head: commitSha, mergeBase: commitSha });
export const excerpt = z.object({
  path: z.string(),
  line: number,
  text: z.string(),
  commit: commitSha,
  change: z.enum(['added', 'removed', 'source']),
});
export const pairSummary = z.object({
  left: pairPin,
  right: pairPin,
  overlaps: z.array(
    z.object({ path: z.string(), left: excerpt.nullable(), right: excerpt.nullable() }),
  ),
  gaps: z.array(z.string()),
});
export const pairAnalysis = z.object({
  findings: z.array(z.object({ consequence: z.string(), left: excerpt, right: excerpt })),
  gaps: z.array(z.string()),
  agent: agentId,
  requestedModel: z.string(),
  reportedModel: z.string().nullable(),
  run: z.uuid(),
  promptVersion: z.string(),
});
export const freshness = z.object({
  changed: z.array(number),
  unknown: z.array(z.object({ number, reason: z.string() })),
});
export type Freshness = z.infer<typeof freshness>;
export type PairRequest = z.infer<typeof pairRequest>;
export type PairPin = z.infer<typeof pairPin>;
export type PairSummary = z.infer<typeof pairSummary>;
export type PairAnalysis = z.infer<typeof pairAnalysis>;
export type Candidate = z.infer<typeof candidate>;
export type Excerpt = z.infer<typeof excerpt>;
export interface CrossPrBridge {
  comparisonCandidates(repo: string, run: string): Promise<Candidate[]>;
  cancelCandidateScan(run: string): Promise<void>;
  preparePair(request: PairRequest): Promise<PairSummary>;
  analyzePair(run: string): Promise<PairAnalysis>;
  checkPair(run: string): Promise<Freshness>;
  closePair(run: string): Promise<void>;
}
