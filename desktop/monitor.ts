import { pullReviewFields, pullReviewInfo, summarizePullReviews } from './pull-review-status.js';
import { z } from 'zod';
import { githubApi, githubGraphql } from './github.js';
import { login, repoName, readableError } from '../shared/assistant.js';
import type { AssistantStore } from './assistant-store.js';
import type { Repository } from '../shared/assistant.js';

const author = z.object({ login });
const pr = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  user: author.nullable(),
});
export async function pages<T>(
  endpoint: string,
  schema: z.ZodType<T>,
  signal: AbortSignal,
  api: typeof githubApi,
) {
  const rows: T[] = [];
  for (let page = 1; ; page++) {
    const part = z
      .array(schema)
      .parse(
        JSON.parse(
          (await api(
            endpoint + (endpoint.includes('?') ? '&' : '?') + 'per_page=100&page=' + page,
            signal,
          )) || '[]',
        ),
      );
    rows.push(...part);
    if (part.length < 100) return rows;
  }
}
const reviewStates = z.object({
  data: z.object({
    viewer: z.object({ login: z.string() }),
    repository: z.record(z.string(), pullReviewInfo.extend({ isDraft: z.boolean() }).nullable()),
  }),
});
// One request answers, for up to fifty PRs, whether the signed-in reviewer approved each.
// GitHub's "opinionated" reviews are each person's latest approval, change request or
// dismissal, so a later plain comment or thread reply does not hide an approval.
async function pullStatuses(
  name: string,
  numbers: number[],
  signal: AbortSignal,
  graphql: typeof githubGraphql,
) {
  const statuses = new Map<
    number,
    Awaited<ReturnType<typeof summarizePullReviews>> & { isDraft: boolean }
  >();
  const [owner = '', repo = ''] = name.split('/');
  for (let at = 0; at < numbers.length; at += 50) {
    const fields = numbers
      .slice(at, at + 50)
      .map((n) => 'p' + n + ':pullRequest(number:' + n + '){isDraft ' + pullReviewFields + '}');
    const query =
      'query($owner:String!,$name:String!){viewer{login} repository(owner:$owner,name:$name){' +
      fields.join(' ') +
      '}}';
    const { viewer, repository } = reviewStates.parse(
      JSON.parse(await graphql(query, { owner, name: repo }, signal)),
    ).data;
    for (const [alias, pull] of Object.entries(repository)) {
      if (!pull) continue;
      const number = Number(alias.slice(1));
      statuses.set(number, {
        isDraft: pull.isDraft,
        ...(await summarizePullReviews(pull, viewer.login, owner, repo, number, graphql, signal)),
      });
    }
  }
  return statuses;
}
export function monitor(
  store: AssistantStore,
  signal: AbortSignal,
  api = githubApi,
  graphql = githubGraphql,
  // Told about pull requests that appeared since the previous check.
  onNew: (repo: string, pulls: Repository['pulls']) => void = () => {},
) {
  const pending = new Map<string, Promise<void>>();
  // `announce` is false for the check that follows adding a repository or changing its
  // watched authors, where every listed PR is new to the list but not new on GitHub.
  async function sync(name: string, discover: boolean, announce: boolean) {
    const repo = store.repositories().find((r) => r.name === name);
    if (!repo) return;
    try {
      const prefix = 'repos/' + name;
      const authors = new Set(repo.authors);
      const pulls: Repository['pulls'] = [];
      const known = new Map(repo.pulls.map((p) => [p.number, p]));
      const fresh = announce && !!repo.checked;
      // GitHub's issues listing also returns PRs and supports an exact creator filter.
      for (const creator of repo.watching) {
        const items = await pages(
          prefix + '/issues?state=open&creator=' + encodeURIComponent(creator),
          pr.extend({
            pull_request: z.object({}).optional(),
            created_at: z.iso.datetime().optional(),
          }),
          signal,
          api,
        );
        for (const item of items)
          if (item.pull_request && item.user?.login === creator)
            pulls.push({
              ...known.get(item.number),
              number: item.number,
              title: item.title,
              author: creator,
              openedAt: item.created_at ?? known.get(item.number)?.openedAt,
              approved: known.get(item.number)?.approved ?? false,
              isDraft: known.get(item.number)?.isDraft,
              unseen: known.get(item.number)?.unseen ?? fresh,
            });
      }
      pulls.sort((a, b) => b.number - a.number);
      if (pulls.length) {
        // The PR list is still worth saving when the review states cannot be read.
        const statuses = await pullStatuses(
          name,
          pulls.map((p) => p.number),
          signal,
          graphql,
        ).catch(() => {
          signal.throwIfAborted();
          return null;
        });
        for (const pull of pulls) Object.assign(pull, statuses?.get(pull.number));
      }
      if (discover || !repo.checked) {
        const contributors = await pages(prefix + '/contributors', author, signal, api);
        for (const user of contributors) authors.add(user.login);
        const recent = z
          .array(pr)
          .parse(JSON.parse(await api(prefix + '/pulls?state=all&per_page=100', signal)));
        for (const p of recent) if (p.user) authors.add(p.user.login);
      }
      signal.throwIfAborted();
      // The reviewer may have opened a PR while GitHub was being read. Take each known
      // PR's mark from what is stored now, so that is not undone.
      const stored = new Map(
        store
          .repositories()
          .find((r) => r.name === name)
          ?.pulls.map((p) => [p.number, p.unseen]),
      );
      for (const pull of pulls)
        if (known.has(pull.number)) pull.unseen = stored.get(pull.number) ?? pull.unseen;
      store.update(name, [...authors].sort(), pulls);
      const arrived = pulls.filter((p) => p.unseen && !known.has(p.number));
      try {
        if (arrived.length) onNew(name, arrived);
      } catch {
        // The list is saved. A notification that could not be shown is not a failed check.
      }
    } catch (error) {
      if (!signal.aborted) store.failure(name, readableError(error));
    }
  }
  return async (input: unknown, discover: boolean, announce = true) => {
    const name = repoName.parse(input);
    const previous = pending.get(name) ?? Promise.resolve();
    const work = previous.then(() => sync(name, discover, announce));
    pending.set(name, work);
    try {
      await work;
    } finally {
      if (pending.get(name) === work) pending.delete(name);
    }
    return store.repositories();
  };
}
