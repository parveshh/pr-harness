import { z } from 'zod';
import { githubApi } from './github.js';
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
export function monitor(store: AssistantStore, signal: AbortSignal, api = githubApi) {
  const pending = new Map<string, Promise<void>>();
  async function sync(name: string, discover: boolean) {
    const repo = store.repositories().find((r) => r.name === name);
    if (!repo) return;
    try {
      const prefix = 'repos/' + name;
      const authors = new Set(repo.authors);
      const pulls = [];
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
            pulls.push({ number: item.number, title: item.title, author: creator });
      }
      pulls.sort((a, b) => b.number - a.number);
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
