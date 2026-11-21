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
export const inbox = z.object({
  account: z.string().nullable(),
  items: reply.array(),
  error: z.string().nullable(),
  added: z.number().int().nonnegative(),
});
export type Inbox = z.infer<typeof inbox>;
export const webLink = z.url({ protocol: /^https?$/, normalize: true });
export interface WorkspaceBridge {
  discussions(url: string): Promise<Discussions>;
  replyToDiscussion(request: DiscussionReply): Promise<DiscussionMessage>;
  resolveDiscussion(request: ResolveRequest): Promise<{ resolved: boolean }>;
  openChatLink(url: string): Promise<void>;
  typography(): Promise<Typography>;
  saveTypography(value: Typography): Promise<Typography>;
  syncReplies(): Promise<Inbox>;
  readReplies(account: string): Promise<Inbox>;
  openReply(account: string, id: number): Promise<Inbox>;
  startLogin(): Promise<SignIn>;
  loginProgress(): Promise<SignIn>;
  cancelLogin(): Promise<void>;
  openDevicePage(): Promise<void>;
}
