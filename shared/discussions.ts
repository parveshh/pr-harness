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
