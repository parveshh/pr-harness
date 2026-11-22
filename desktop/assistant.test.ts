import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  defaultPrompt,
  defaultSummaryPrompt,
  type Citation,
  type Selection,
} from '../shared/assistant.js';
import type { ReaderView } from '../shared/reader.js';
import { buildAgentContext, citedAnswer } from './evidence.js';
import { monitor } from './monitor.js';
import { openStore } from './store.js';

const url = 'https://github.com/example/project/pull/12';
await test('one harness and model apply to every PR while prompts fall back through PR, repository and app scopes', (t) => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const data = store.assistant;
  const other = url.replace('project', 'other');
  assert.deepEqual(data.preferences(url, 'claude'), {
    scope: 'default',
    settings: { agent: 'claude', model: '', provider: 'default', prompt: defaultPrompt },
  });
  const chosen: Selection = { agent: 'codex', model: 'a', provider: 'ollama' };
  data.saveSelection(chosen);
  assert.deepEqual(data.selection('claude'), chosen);
  data.savePrompt(url, 'default', 'app');
  data.savePrompt(url, 'repository', 'repository');
  data.savePrompt(url, 'review', 'review');
  assert.deepEqual(data.preferences(url, 'claude'), {
    scope: 'review',
    settings: { ...chosen, prompt: 'review' },
  });
  assert.equal(data.preferences(url.replace('12', '13'), 'claude').settings.prompt, 'repository');
  assert.deepEqual(data.preferences(other, 'claude'), {
    scope: 'default',
    settings: { ...chosen, prompt: 'app' },
  });
  assert.equal(data.summaryPreferences(url).prompt, defaultSummaryPrompt);
  data.savePrompt(url, 'default', 'Summarise briefly.', 'summary');
  data.savePrompt(url, 'repository', 'Summarise by caller.', 'summary');
  assert.equal(data.summaryPreferences(url).prompt, 'Summarise by caller.');
  assert.equal(data.summaryPreferences(other).prompt, 'Summarise briefly.');
  data.clearPrompt(url, 'repository', 'summary');
  assert.equal(data.summaryPreferences(url).prompt, 'Summarise briefly.');
  assert.equal(data.preferences(url, 'claude').settings.prompt, 'review');
  data.clearPrompt(url, 'review');
  assert.equal(data.preferences(url, 'claude').scope, 'repository');
  data.saveSelection({ agent: 'claude', model: 'b', provider: 'default' });
  for (const pr of [url, other]) assert.equal(data.preferences(pr, 'codex').settings.model, 'b');
});

await test('citations resolve only to supplied evidence and preserve deletion-side lines', () => {
  const ref: Citation = {
    id: 1,
    path: 'src/reviewer.ts',
    hunk: 2,
    side: 'old',
    line: 17,
    excerpt: '-old',
  };
  assert.deepEqual(citedAnswer('See [[1]], [[1]] or [[999]].', [ref]), {
    answer: 'See [[1]], [[1]] or [unverified reference].',
    citations: [ref],
  });
  const literals = [
    '`[[999]]`',
    '```ts\nconst id = "[[999]]";\n```',
    '[doc](https://example.com/[[999]])',
    '\\[[999]]',
  ].join('\n\n');
  assert.deepEqual(citedAnswer(literals + '\n\n**See [[1]]**', [ref]), {
    answer: literals + '\n\n**See [[1]]**',
    citations: [ref],
  });
});

await test('new-file context sends ordered source, reports coverage and keeps citation anchors intact', () => {
  const file = {
    path: 'capture.ts',
    status: 'added',
    kind: 'text' as const,
    hunk: 0,
    scroll: 0,
    reviewed: false,
    previousPath: null,
    additions: 122,
    deletions: 0,
  };
  const view: ReaderView = {
    files: [file, { ...file, path: 'caller.ts', status: 'modified', additions: 2, deletions: 1 }],
    selected: file.path,
    revision: 'snapshot',
    comparison: null,
    changePath: null,
    since: false,
    incoming: null,
    meta: {
      title: 'Add capture',
      description: 'Connect the caller',
      author: 'octo',
      head: 'head',
      base: 'base',
      baseBranch: 'main',
      headBranch: 'capture',
      totalFiles: 2,
    },
  };
  const lines = Array.from({ length: 122 }, (_, i) => '+  run(' + i + ');');
  const patches = new Map([
    [file.path, '@@ -0,0 +1,122 @@\n' + lines.join('\n')],
    ['caller.ts', '@@ -1 +1 @@\n-before()\n+after()\n@@ -10,0 +10 @@\n+capture()'],
  ]);
  const req = {
    url,
    run: 'run',
    revision: view.revision,
    path: file.path,
    hunk: 0,
    selection: { path: file.path, hunk: 0, side: 'new' as const, startLine: 82, line: 90 },
    extra: null,
    question: 'Explain this new file.',
  };
  const build = (request = req) =>
    buildAgentContext(view, request, [], (path) => patches.get(path) ?? '');
  const { context, sources } = build();
  const added = context.selected.addedFile;
  assert.ok(added);
  assert.equal(added.coverage, 'complete');
  assert.deepEqual(
    added.lines.map((s) => s.text),
    lines.map((s) => s.slice(1)),
  );
  const last = added.lines.at(-1);
  assert.ok(last);
  assert.deepEqual(
    citedAnswer('[[' + last.id + ']]', sources).citations.map((c) => [c.hunk, c.line, c.path]),
    [[0, 122, file.path]],
  );
  assert.equal(context.selected.hunk, undefined);
  assert.equal(context.selected.line?.line, 90);
  assert.equal(context.selected.line?.startLine, 82);
  assert.equal(context.pullRequest.totalChangedFiles, 2);
  assert.equal(
    context.evidence.every((s) => s.path === 'caller.ts'),
    true,
  );
  const modified = build({
    ...req,
    path: 'caller.ts',
    hunk: 1,
    selection: { path: 'caller.ts', hunk: 1, side: 'new', startLine: 10, line: 10 },
  });
  const caller = modified.context.evidence.find((s) => s.path === 'caller.ts' && s.line === 10);
  assert.equal(caller?.hunk, 2);
  assert.equal(modified.context.selected.hunk, 2);
  assert.equal(modified.context.selected.line?.hunk, 2);
  assert.equal(modified.sources.find((s) => s.id === caller?.id)?.hunk, 1);
  patches.set(file.path, '@@ -0,0 +1,122 @@\n' + lines.map((s) => s + 'x'.repeat(800)).join('\n'));
  const limited = build().context.selected.addedFile;
  assert.ok(limited && limited.coverage === 'partial' && limited.lines.length < 122);
  assert.ok(limited.lines.some((s) => s.line === 90));
  patches.set(file.path, '@@ -0,0 +1,122 @@\n' + lines.join('\n') + 'x'.repeat(1300));
  assert.equal(build().context.selected.addedFile?.coverage, 'partial');
});

await test('repository monitoring filters issues and other authors, pages results, and keeps cached PRs offline', async (t) => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const data = store.assistant;
  const repo = 'example/project';
  let offline = false;
  let nextPr = 4;
  // The latest opinionated review of each person, as GitHub reports them for the PR.
  let reviews: [login: string, state: string][] | Error = [];
  const queries: [string, Record<string, string>][] = [];
  const graphql = (query: string, variables: Record<string, string>) => {
    queries.push([query, variables]);
    if (reviews instanceof Error) return Promise.reject(reviews);
    const nodes = reviews.map(([login, state]) => ({ author: { login }, state }));
    return Promise.resolve(
      JSON.stringify({
        data: {
          viewer: { login: 'Reviewer' },
          repository: {
            ['p' + nextPr]: {
              latestOpinionatedReviews: { nodes: [...nodes, { author: null, state: 'APPROVED' }] },
            },
          },
        },
      }),
    );
  };
  const api = (endpoint: string) => {
    if (offline) return Promise.reject(Error('Offline'));
    const item = {
      number: nextPr,
      title: 'Review this',
      user: { login: 'OCTO' },
      pull_request: {},
    };
    if (endpoint.includes('contributors')) return Promise.resolve('[{"login":"octo"}]');
    if (endpoint.includes('/pulls?'))
      return Promise.resolve(JSON.stringify([{ ...item, user: { login: 'guest' } }]));
    assert.match(endpoint, /creator=octo/);
    return Promise.resolve(
      JSON.stringify(
        endpoint.endsWith('page=1')
          ? Array.from({ length: 100 }, (_, i) => ({
              number: i + 1,
              title: 'Issue',
              user: { login: 'octo' },
            }))
          : [item, { ...item, number: 9, user: { login: 'unwatched' } }],
      ),
    );
  };
  const announced: [string, number[]][] = [];
  const sync = monitor(data, new AbortController().signal, api, graphql, (name, pulls) =>
    announced.push([name, pulls.map((p) => p.number)]),
  );
  data.add(repo);
  assert.deepEqual((await sync(repo, true, false))[0]?.authors, ['guest', 'octo']);
  data.watch(repo, ['octo']);
  // PRs listed because an author was just chosen are not new on GitHub.
  assert.deepEqual(
    (await sync(repo, false, false))[0]?.pulls.map((p) => [p.number, p.unseen]),
    [[4, false]],
  );
  assert.equal(data.unseen(), 0);
  assert.deepEqual(queries.at(-1), [
    'query($owner:String!,$name:String!){viewer{login} repository(owner:$owner,name:$name){p4:pullRequest(number:4){latestOpinionatedReviews(first:100){nodes{author{login} state}}}}}',
    { owner: 'example', name: 'project' },
  ]);
  nextPr = 10;
  const approved = () => data.repositories()[0]?.pulls.map((p) => [p.number, p.approved]);
  for (const [state, expected] of [
    // Only the signed-in reviewer's own approval counts, whatever the login's case.
    [[['reviewer', 'APPROVED']], true],
    [[['reviewer', 'CHANGES_REQUESTED']], false],
    [[['someone-else', 'APPROVED']], false],
    [[['reviewer', 'DISMISSED']], false],
    [
      [
        ['someone-else', 'CHANGES_REQUESTED'],
        ['REVIEWER', 'APPROVED'],
      ],
      true,
    ],
    // The PR list is still saved, with the last known approval, when review states fail.
    [Error('GraphQL unavailable'), true],
  ] as const) {
    reviews = state instanceof Error ? state : state.map(([login, s]) => [login, s]);
    await sync(repo, false);
    assert.deepEqual(approved(), [[10, expected]]);
    assert.equal(data.repositories()[0]?.error, null);
  }
  // PR 10 appeared after the list was first read: announced once and marked until opened.
  assert.deepEqual(announced, [[repo, [10]]]);
  assert.equal(data.repositories()[0]?.pulls[0]?.unseen, true);
  assert.equal(data.unseen(), 1);
  assert.equal(data.seen('https://github.com/example/project/pull/11'), false);
  assert.equal(data.seen('https://github.com/example/project/pull/10'), true);
  assert.equal(data.seen('https://github.com/example/project/pull/10'), false);
  assert.equal(data.unseen(), 0);
  await sync(repo, false);
  assert.equal(data.repositories()[0]?.pulls[0]?.unseen, false);
  assert.equal(announced.length, 1);
  // A PR from an author who is no longer watched does not count towards the badge.
  nextPr = 12;
  await sync(repo, false);
  assert.equal(data.unseen(), 1);
  data.watch(repo, []);
  assert.equal(data.unseen(), 0);
  data.watch(repo, ['octo']);
  offline = true;
  nextPr = 10;
  const cached = (await sync(repo, false))[0];
  assert.deepEqual(
    cached?.pulls.map((p) => p.number),
    [12],
  );
  assert.equal(cached?.error, 'Offline');
});

await test('opening a new pull request while the list is being refreshed keeps it marked as seen', async (t) => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const data = store.assistant;
  const repo = 'example/project';
  const pr = 'https://github.com/example/project/pull/5';
  let numbers = [4];
  let hold: Promise<void> | null = null;
  const sync = monitor(
    data,
    new AbortController().signal,
    async (endpoint) => {
      if (!endpoint.includes('/issues?')) return '[]';
      await hold;
      return JSON.stringify(
        numbers.map((number) => ({
          number,
          title: 'PR',
          user: { login: 'octo' },
          pull_request: {},
        })),
      );
    },
    () => Promise.reject(Error('GraphQL unavailable')),
    () => {
      // A notification that cannot be shown must not fail the check.
      throw Error('Notifications unavailable');
    },
  );
  data.add(repo);
  data.watch(repo, ['octo']);
  await sync(repo, false, false);
  numbers = [5, 4];
  await sync(repo, false);
  assert.equal(data.repositories()[0]?.error, null);
  assert.equal(data.unseen(), 1);
  let release: () => void = () => {};
  hold = new Promise((resolve) => (release = resolve));
  const refreshing = sync(repo, false);
  assert.equal(data.seen(pr), true);
  release();
  await refreshing;
  assert.equal(data.unseen(), 0);
  assert.equal(data.seen(pr + '/files'), false);
});
