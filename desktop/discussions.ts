import { z } from 'zod';
import {
  discussionLink,
  type DiscussionMessage,
  type DiscussionThread,
  type DiscussionReply,
} from '../shared/discussions.js';
import { pullRequestUrl } from '../shared/reviews.js';
import { githubApi, replySession, UnconfirmedReply } from './github.js';

const comment = z.object({
  id: z.number().int().positive(),
  body: z.string().nullish(),
  user: z.object({ login: z.string() }).nullable(),
  created_at: z.string().optional(),
  submitted_at: z.string().nullish(),
  path: z.string().optional(),
  line: z.number().int().positive().nullish(),
  side: z.enum(['LEFT', 'RIGHT']).nullish(),
  start_line: z.number().int().positive().nullish(),
  start_side: z.enum(['LEFT', 'RIGHT']).nullish(),
  original_line: z.number().int().positive().nullish(),
  in_reply_to_id: z.number().int().positive().nullish(),
  state: z.string().optional(),
});
type Remote = z.infer<typeof comment>;
function message(row: Remote): DiscussionMessage {
  return {
    id: row.id,
    author: row.user?.login ?? 'Deleted account',
    body: row.body ?? '',
    created: row.created_at ?? row.submitted_at ?? '',
  };
}
function endpoints(url: string) {
  const [, owner, repo, , number] = new URL(pullRequestUrl.parse(url)).pathname.split('/');
  const root = 'repos/' + owner + '/' + repo;
  return {
    inline: root + '/pulls/' + number + '/comments',
    conversation: root + '/issues/' + number + '/comments',
    review: root + '/pulls/' + number + '/reviews',
  };
}
async function activeAccount(signal: AbortSignal) {
  return z
    .object({ login: z.string() })
    .parse(JSON.parse(await githubApi('user', signal)))
    .login.toLowerCase();
}
export async function listDiscussions(
  url: string,
  signal: AbortSignal,
  connect = replySession,
  identity = activeAccount,
  pinLines = false,
) {
  const session = await connect(signal);
  const routes = endpoints(url);
  async function revision() {
    if (!pinLines) return null;
    try {
      const meta = z
        .object({
          head: z.object({ sha: z.string() }),
          base: z.object({ sha: z.string(), ref: z.string() }),
        })
        .parse(JSON.parse(await session.api(routes.inline.slice(0, -'/comments'.length), signal)));
      return { head: meta.head.sha, base: meta.base.sha, baseBranch: meta.base.ref };
    } catch {
      signal.throwIfAborted();
      return null;
    }
  }
  const before = await revision();
  async function pages(endpoint: string) {
    const rows = new Map<number, Remote>();
    for (let page = 1; ; page++) {
      signal.throwIfAborted();
      const batch = comment
        .array()
        .parse(JSON.parse(await session.api(endpoint + '?per_page=100&page=' + page, signal)));
      for (const row of batch) rows.set(row.id, row);
      if (batch.length < 100) break;
    }
    return [...rows.values()];
  }
  const [inline, conversation, reviews] = await Promise.all([
    pages(routes.inline),
    pages(routes.conversation),
    pages(routes.review),
  ]);
  function thread(kind: DiscussionThread['kind'], row: Remote): DiscussionThread {
    return {
      kind,
      id: row.id,
      path: row.path ?? null,
      line: row.line ?? null,
      originalLine: row.original_line ?? null,
      side: row.side,
      startLine: row.start_line,
      startSide: row.start_side,
      messages: [message(row)],
    };
  }
  const threads = inline.filter((r) => !r.in_reply_to_id).map((row) => thread('inline', row));
  const byRoot = new Map(threads.map((t) => [t.id, t]));
  for (const row of inline.filter((r) => r.in_reply_to_id).sort((a, b) => a.id - b.id)) {
    const root = byRoot.get(row.in_reply_to_id ?? 0);
    if (root) root.messages.push(message(row));
  }
  threads.push(
    ...conversation.map((row) => thread('conversation', row)),
    ...reviews
      .filter((row) => row.state !== 'PENDING' && row.body?.replace(/<!--[\s\S]*?-->/g, '').trim())
      .map((row) => thread('review', row)),
  );
  threads.sort((a, b) =>
    (b.messages.at(-1)?.created ?? '').localeCompare(a.messages.at(-1)?.created ?? ''),
  );
  const after = before ? await revision() : null;
  const anchorRevision =
    before &&
    after &&
    before.head === after.head &&
    before.base === after.base &&
    before.baseBranch === after.baseBranch
      ? before
      : null;
  if ((await identity(signal)) !== session.actor)
    throw Error('GitHub account changed. Refresh discussions.');
  return { account: session.actor, threads, anchorRevision };
}
export async function sendDiscussionReply(
  req: DiscussionReply,
  signal: AbortSignal,
  connect = replySession,
  identity = activeAccount,
) {
  const session = await connect(signal);
  if (session.actor !== req.account)
    throw Error('The connected GitHub account changed. Refresh the discussions before posting.');
  const routes = endpoints(req.url);
  const inline = req.kind === 'inline';
  const snapshot = await listDiscussions(req.url, signal, () => Promise.resolve(session), identity);
  const target = snapshot.threads.find((t) => t.id === req.id && t.kind === req.kind);
  if (!target) throw Error('The original comment is no longer on this PR. Refresh discussions.');
  const marker = '<!-- local-reviewer-reply:' + req.token + ' -->';
  const previous = (
    inline
      ? target.messages
      : snapshot.threads.filter((t) => t.kind === 'conversation').flatMap((t) => t.messages)
  ).find((m) => m.author.toLowerCase() === session.actor && m.body.endsWith(marker));
  if (previous) return previous;
  const body = inline
    ? req.body
    : '[In reply to this ' +
      (req.kind === 'review' ? 'review' : 'comment') +
      '](' +
      discussionLink(req.url, req.kind, req.id) +
      ')\n\n' +
      req.body;
  const response = await session.postComment(
    inline ? routes.inline + '/' + req.id + '/replies' : routes.conversation,
    body + '\n\n' + marker,
    signal,
  );
  try {
    return message(comment.parse(JSON.parse(response)));
  } catch {
    throw new UnconfirmedReply(
      'GitHub returned an unreadable reply receipt. Refresh the discussion and check before posting again.',
    );
  }
}
