import { z } from 'zod';
import { githubApi, githubGraphql } from './github.js';
import { login, repoName, readableError } from '../shared/assistant.js';
import type { AssistantStore } from './assistant-store.js';

const author = z.object({ login });
const pr = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  user: author.nullable(),
});
async function pages<T>(
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
    repository: z.record(
      z.string(),
      z
        .object({
          latestOpinionatedReviews: z.object({
            nodes: z.array(
              z.object({ author: z.object({ login: z.string() }).nullable(), state: z.string() }),
            ),
          }),
        })
        .nullable(),
    ),
  }),
});
// One request answers, for up to fifty PRs, whether the signed-in reviewer approved each.
// GitHub's "opinionated" reviews are each person's latest approval, change request or
// dismissal, so a later plain comment or thread reply does not hide an approval.
async function approvedPulls(
  name: string,
  numbers: number[],
  signal: AbortSignal,
  graphql: typeof githubGraphql,
) {
  const approved = new Set<number>();
  const [owner = '', repo = ''] = name.split('/');
  for (let at = 0; at < numbers.length; at += 50) {
    const fields = numbers
      .slice(at, at + 50)
      .map(
        (n) =>
          'p' +
          n +
          ':pullRequest(number:' +
          n +
          '){latestOpinionatedReviews(first:100){nodes{author{login} state}}}',
      );
    const query =
      'query($owner:String!,$name:String!){viewer{login} repository(owner:$owner,name:$name){' +
      fields.join(' ') +
      '}}';
    const { viewer, repository } = reviewStates.parse(
      JSON.parse(await graphql(query, { owner, name: repo }, signal)),
    ).data;
    const me = viewer.login.toLowerCase();
    for (const [alias, pull] of Object.entries(repository))
      if (
        pull?.latestOpinionatedReviews.nodes.some(
          (review) => review.author?.login.toLowerCase() === me && review.state === 'APPROVED',
        )
      )
        approved.add(Number(alias.slice(1)));
  }
  return approved;
}
export function monitor(
  store: AssistantStore,
  signal: AbortSignal,
  api = githubApi,
  graphql = githubGraphql,
) {
  const pending = new Map<string, Promise<void>>();
  async function sync(name: string, discover: boolean) {
    const repo = store.repositories().find((r) => r.name === name);
    if (!repo) return;
    try {
      const prefix = 'repos/' + name;
      const authors = new Set(repo.authors);
      const pulls: { number: number; title: string; author: string; approved: boolean }[] = [];
      // GitHub's issues listing also returns PRs and supports an exact creator filter.
      for (const creator of repo.watching) {
        const items = await pages(
          prefix + '/issues?state=open&creator=' + encodeURIComponent(creator),
          pr.extend({ pull_request: z.object({}).optional() }),
          signal,
          api,
        );
        for (const item of items)
          if (item.pull_request && item.user?.login === creator)
            pulls.push({
              number: item.number,
              title: item.title,
              author: creator,
              approved: false,
            });
      }
      pulls.sort((a, b) => b.number - a.number);
      if (pulls.length) {
        // The PR list is still worth saving when the review states cannot be read.
        const approved = await approvedPulls(
          name,
          pulls.map((p) => p.number),
          signal,
          graphql,
        ).catch(() => {
          signal.throwIfAborted();
          return new Set(repo.pulls.filter((p) => p.approved).map((p) => p.number));
        });
        for (const pull of pulls) pull.approved = approved.has(pull.number);
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
      store.update(name, [...authors].sort(), pulls);
    } catch (error) {
      if (!signal.aborted) store.failure(name, readableError(error));
    }
  }
  return async (input: unknown, discover: boolean) => {
    const name = repoName.parse(input);
    const previous = pending.get(name) ?? Promise.resolve();
    const work = previous.then(() => sync(name, discover));
    pending.set(name, work);
    try {
      await work;
    } finally {
      if (pending.get(name) === work) pending.delete(name);
    }
    return store.repositories();
  };
}
