import type { ReviewLesson, SaveLesson, LessonKey } from './lessons.js';
import type {
  DiscussionMessage,
  DiscussionReply,
  Discussions,
  ResolveRequest,
} from './discussions.js';
import { z } from 'zod';
import { pullRequestUrl } from './reviews.js';
export const typography = z.object({
  font: z.enum(['system', 'humanist', 'serif', 'mono']),
  size: z.enum(['small', 'standard', 'large', 'larger']),
});
export type Typography = z.infer<typeof typography>;
export const defaultTypography: Typography = { font: 'system', size: 'standard' };
export const signIn = z.discriminatedUnion('state', [
  z.object({ state: z.literal('idle') }),
  z.object({ state: z.literal('waiting'), code: z.string().nullable() }),
  z.object({ state: z.literal('complete') }),
  z.object({ state: z.literal('error'), message: z.string() }),
]);
export type SignIn = z.infer<typeof signIn>;
export const reply = z.object({
  id: z.number().int().positive(),
  url: pullRequestUrl,
  author: z.string(),
  path: z.string(),
  body: z.string(),
  created: z.string(),
  unread: z.boolean(),
});
export const reviewChange = z.object({
  id: z.number().int().positive(),
  kind: z.enum(['dismissed', 'push']),
  url: pullRequestUrl,
  head: z.string(),
  created: z.iso.datetime(),
  unread: z.boolean(),
});
export type ReviewChange = z.infer<typeof reviewChange>;
export const reviewChangeTitle = (kind: ReviewChange['kind']) =>
  kind === 'push' ? 'New push after your review' : 'Your review was dismissed';
export const inbox = z.object({
  account: z.string().nullable(),
  items: reply.array(),
  changes: reviewChange.array(),
  error: z.string().nullable(),
  added: z.number().int().nonnegative(),
});
export type Inbox = z.infer<typeof inbox>;
export const webLink = z.url({ protocol: /^https?$/, normalize: true });
export interface WorkspaceBridge {
  reviewLessons(url: string): Promise<ReviewLesson[]>;
  saveReviewLesson(input: SaveLesson): Promise<ReviewLesson[]>;
  forgetReviewLesson(url: string, key: LessonKey): Promise<ReviewLesson[]>;
  discussions(url: string): Promise<Discussions>;
  replyToDiscussion(request: DiscussionReply): Promise<DiscussionMessage>;
  resolveDiscussion(request: ResolveRequest): Promise<{ resolved: boolean }>;
  openChatLink(url: string): Promise<void>;
  typography(): Promise<Typography>;
  saveTypography(value: Typography): Promise<Typography>;
  syncReplies(): Promise<Inbox>;
  readReplies(account: string): Promise<Inbox>;
  readReviewChange(account: string, id: number): Promise<Inbox>;
  openReply(account: string, id: number): Promise<Inbox>;
  startLogin(): Promise<SignIn>;
  loginProgress(): Promise<SignIn>;
  cancelLogin(): Promise<void>;
  openDevicePage(): Promise<void>;
}
