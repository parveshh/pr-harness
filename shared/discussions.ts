import { z } from 'zod';
import { pullRequestUrl } from './reviews.js';

export const discussionKind = z.enum(['inline', 'conversation', 'review']);
const id = z.number().int().positive();
export const discussionMessage = z.object({
  id,
  author: z.string(),
  body: z.string(),
  created: z.string(),
});
// A review thread's GitHub node ID and whether it is resolved. Absent when GitHub did not
// report it, for example on conversation comments, which cannot be resolved.
const threadNode = z.string().regex(/^[\w=+/-]{1,200}$/);
export const threadResolution = z.object({
  node: threadNode,
  resolved: z.boolean(),
  canResolve: z.boolean(),
  canUnresolve: z.boolean(),
});
export const discussionThread = z.object({
  id,
  kind: discussionKind,
  path: z.string().nullable(),
  line: id.nullable(),
  originalLine: id.nullable(),
  side: z.enum(['LEFT', 'RIGHT']).nullish(),
  startLine: id.nullish(),
  startSide: z.enum(['LEFT', 'RIGHT']).nullish(),
  messages: z.array(discussionMessage).min(1),
  resolution: threadResolution.nullish(),
});
export const discussionRevision = z.object({
  head: z.string(),
  base: z.string(),
  baseBranch: z.string(),
});
export const discussions = z.object({
  anchorRevision: discussionRevision.nullish(),
  account: z.string(),
  threads: z.array(discussionThread),
});
export const discussionReply = z.object({
  url: pullRequestUrl,
  account: z.string().min(1),
  token: z.uuid(),
  id,
  kind: discussionKind,
  body: z.string().trim().min(1).max(60000),
});
export const resolveRequest = z.object({
  url: pullRequestUrl,
  account: z.string().min(1),
  node: threadNode,
  resolved: z.boolean(),
});
export const resolveResult = z.object({ resolved: z.boolean() });
export type ResolveRequest = z.infer<typeof resolveRequest>;
export type ThreadResolution = z.infer<typeof threadResolution>;
export type Discussions = z.infer<typeof discussions>;
export type DiscussionThread = z.infer<typeof discussionThread>;
export type DiscussionReply = z.infer<typeof discussionReply>;
export type DiscussionMessage = z.infer<typeof discussionMessage>;

export function discussionLink(url: string, kind: DiscussionThread['kind'], id: number) {
  const fragment = {
    inline: 'discussion_r',
    conversation: 'issuecomment-',
    review: 'pullrequestreview-',
  };
  return url + '#' + fragment[kind] + id;
}
