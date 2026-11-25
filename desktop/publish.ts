import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { excerpt } from './anchors.js';
import { hasSuggestion } from '../shared/suggestions.js';
import type { Bundle, Edit, Pending, PublishKey } from '../shared/publish.js';
import { fetchSnapshot, githubApi, githubEnvironment } from './github.js';
import type { openStore } from './store.js';

class RejectedReview extends Error {}
const reviewId = z.object({ id: z.number().int().positive() });
const remoteReview = reviewId.extend({
  user: z.object({ login: z.string() }).nullable(),
  body: z.string().nullable(),
  commit_id: z.string().nullable(),
  state: z.string(),
});
type Payload = {
  commit_id: string;
  body: string;
  event: Bundle['event'];
  comments: {
    path: string;
    body: string;
    line: number;
    side: 'LEFT' | 'RIGHT';
    start_line?: number;
    start_side?: 'LEFT' | 'RIGHT';
  }[];
};

function postReview(endpoint: string, payload: Payload): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'gh',
      ['api', '--hostname', 'github.com', '--method', 'POST', endpoint, '--input', '-'],
      { env: githubEnvironment(), timeout: 30000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const status = /\(HTTP (\d{3})\)/.exec(stderr)?.[1];
          if (status && ['400', '401', '403', '404', '409', '413', '422', '429'].includes(status))
            reject(
              new RejectedReview(
                'GitHub rejected the review (HTTP ' +
                  status +
                  '). Check your account, review decision, and line locations. Your drafts are saved.',
              ),
            );
          else reject(Error('GitHub did not confirm submission.'));
          return;
        }
        try {
          resolve(reviewId.parse(JSON.parse(stdout)).id);
        } catch {
          reject(Error('GitHub returned an unreadable receipt.'));
        }
      },
    );
    child.stdin?.on('error', () => {
      /* The exit callback handles early CLI exits. */
    });
    child.stdin?.end(JSON.stringify(payload));
  });
}
const marker = (pending: Pending) => '<!-- local-reviewer:' + pending.token + ' -->';
const endpoint = (url: string) =>
  'repos/' + new URL(url).pathname.slice(1).replace('/pull/', '/pulls/') + '/reviews';

export function reviewPublisher(
  store: ReturnType<typeof openStore>,
  api = githubApi,
  post = postReview,
  // Aborting cancels GitHub reads. A review POST already in flight is left to finish
  // and is reconciled through its pending marker.
  signal: AbortSignal = new AbortController().signal,
) {
  const drafts = store.drafts;
  const active = new Set<string>();
  function current(url: string, version: number) {
    const bundle = drafts.get(url);
    if (bundle.version !== version) throw Error('Drafts changed. Reopen the review preview.');
    if (bundle.pending) throw Error('Check the previous submission before editing this review.');
    return bundle;
  }
  function edit(url: string, version: number, request: Edit) {
    const bundle = current(url, version);
    if (request.action === 'details')
      return drafts.write(url, version, {
        ...bundle,
        summary: request.summary,
        event: request.event,
      });
    const existing = bundle.comments.find((d) => d.id === request.id);
    if (request.id && !existing) throw Error('This draft no longer exists.');
    if (request.action === 'to-summary' && existing) {
      const summary = [
        request.summary,
        existing.path + ' (' + existing.side + ' line ' + existing.line + ')\n' + existing.body,
      ]
        .filter(Boolean)
        .join('\n\n');
      if (summary.length > 60000)
        throw Error('Shorten the review summary before moving this draft.');
      return drafts.write(url, version, {
        ...bundle,
        summary,
        event: request.event,
        comments: bundle.comments.filter((d) => d.id !== existing.id),
      });
    }
    if (request.action === 'to-summary') throw Error('This draft no longer exists.');
    if (request.action === 'discard')
      return drafts.write(url, version, {
        ...bundle,
        comments: bundle.comments.filter((d) => d.id !== request.id),
      });
    const target = request.target;
    let anchor = existing;
    if (target) {
      if (store.reader.read(url)?.revision !== target.revision)
        throw Error('Select a line in the current revision.');
      const text = excerpt(
        store.reader.patch({ url, revision: target.revision, path: target.path }),
        target,
      );
      if (text === undefined)
        throw Error(
          'Select lines on one side of the same hunk. Use the updated side for unchanged context.',
        );
      // Moving a draft to other lines replaces its excerpt. A suggestion written against the
      // earlier lines must be edited for the new ones first, or it would pass as current.
      if (
        existing &&
        hasSuggestion(existing.body) &&
        text !== existing.excerpt &&
        request.body === existing.body
      )
        throw Error(
          'This draft holds a suggestion written against different code. Edit the suggestion to fit the selected lines, then save.',
        );
      anchor = { ...target, excerpt: text, id: existing?.id ?? randomUUID(), body: request.body };
    }
    if (!anchor) throw Error('Select a diff line first.');
    const updated = { ...anchor, body: request.body };
    const comments = existing
      ? bundle.comments.map((d) => (d.id === existing.id ? updated : d))
      : [...bundle.comments, updated];
    return drafts.write(url, version, { ...bundle, comments });
  }
  async function identity() {
    return z.object({ login: z.string().min(1) }).parse(JSON.parse(await api('user', signal)))
      .login;
  }
  function record(url: string, bundle: Bundle, id: number) {
    return store.recordPublication(
      url,
      bundle.version,
      {
        ...bundle,
        comments: [],
        summary: '',
        event: 'COMMENT',
        pending: null,
        receipt: id,
      },
      bundle.pending?.revision,
    );
  }
  async function reconcile(url: string, release = false, version?: number) {
    const bundle = drafts.get(url);
    const p = bundle.pending;
    if (!p) return bundle;
    if (active.has(url)) throw Error('Submission is still in progress.');
    if (release && version !== bundle.version) throw Error('Reopen the latest review preview.');
    if ((await identity()).toLowerCase() !== p.actor.toLowerCase())
      throw Error('Switch GitHub CLI back to @' + p.actor + ' to check this submission.');
    for (let page = 1; ; page++) {
      const reviews = remoteReview
        .array()
        .parse(JSON.parse(await api(endpoint(url) + '?per_page=100&page=' + page, signal)));
      const match = reviews.find(
        (r) =>
          r.commit_id === p.head &&
          r.user?.login.toLowerCase() === p.actor.toLowerCase() &&
          r.state.toUpperCase() !== 'PENDING' &&
          r.body?.endsWith(marker(p)),
      );
      if (match) return record(url, bundle, match.id);
      if (reviews.length < 100) break;
    }
    if (release) {
      if (Date.now() - p.started < 60000)
        throw Error('Allow one minute for GitHub to finish processing, then check again.');
      return drafts.write(url, bundle.version, { ...bundle, pending: null });
    }
    throw Error(
      'No matching review is visible yet. Check again, or verify the PR on GitHub before reopening the drafts.',
    );
  }
  async function publish(key: PublishKey) {
    const { url, version, revision, actor } = key;
    const bundle = current(url, version);
    if (!bundle.summary.trim() && !bundle.comments.length && bundle.event !== 'APPROVE')
      throw Error('Add a comment or review summary.');
    if (bundle.event === 'REQUEST_CHANGES' && !bundle.summary.trim())
      throw Error('Add a summary explaining the requested changes.');
    if (active.has(url)) throw Error('Submission is already in progress.');
    active.add(url);
    try {
      const [snapshot, who] = await Promise.all([fetchSnapshot(url, signal, api), identity()]);
      if (actor.toLowerCase() !== who.toLowerCase())
        throw Error('Your GitHub identity changed. Preview the review again.');
      if (
        store.reader.active() !== url ||
        store.reader.revisions.identify(url, snapshot.revision, snapshot.meta.baseBranch) !==
          revision
      )
        throw Error('The target review changed. Refresh the PR and check your draft locations.');
      if (bundle.event !== 'COMMENT' && who.toLowerCase() === snapshot.meta.author.toLowerCase())
        throw Error('Choose Comment when reviewing your own PR.');
      for (const d of bundle.comments) {
        const label = d.path + ' line ' + d.line;
        const suggests = hasSuggestion(d.body);
        if (suggests && d.side === 'old')
          throw Error(
            'The suggestion on ' +
              label +
              ' is on a removed line. GitHub only applies suggestions to updated lines. Remove the suggestion or comment on the updated side.',
          );
        const file = snapshot.files.find((f) => f.info.path === d.path);
        if (d.revision !== revision || !file || excerpt(file.patch, d) !== d.excerpt)
          throw Error(
            suggests
              ? 'The suggestion on ' +
                  label +
                  ' was written against different code. Refresh the PR, choose its line again, and update the suggestion before submitting, or remove it.'
              : 'A draft location changed. Refresh the PR and choose its line again.',
          );
      }
      const pending = {
        token: randomUUID(),
        revision,
        head: snapshot.meta.head,
        actor: who,
        started: Date.now(),
      };
      const locked = drafts.write(url, version, { ...bundle, pending });
      const payload: Payload = {
        commit_id: pending.head,
        event: bundle.event,
        body: [bundle.summary, marker(pending)].filter(Boolean).join('\n\n'),
        comments: bundle.comments.map((d) => ({
          path: d.path,
          line: d.line,
          side: d.side === 'old' ? 'LEFT' : 'RIGHT',
          ...(d.startLine && d.startLine < d.line
            ? {
                start_line: d.startLine,
                start_side: d.side === 'old' ? ('LEFT' as const) : ('RIGHT' as const),
              }
            : {}),
          body: d.body,
        })),
      };
      let id: number;
      try {
        id = await post(endpoint(url), payload);
      } catch (error) {
        if (error instanceof RejectedReview) {
          drafts.write(url, locked.version, { ...locked, pending: null });
          throw error;
        }
        throw Error(
          'Submission outcome unknown. Check GitHub for the receipt before trying again.',
          { cause: error },
        );
      }
      return record(url, locked, id);
    } finally {
      active.delete(url);
    }
  }
  return { edit, identity, publish, reconcile };
}
