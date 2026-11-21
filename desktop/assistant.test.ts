import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultPrompt, type Citation, type Preferences } from '../shared/assistant.js';
import type { ReaderView } from '../shared/reader.js';
import { buildAgentContext, citedAnswer } from './evidence.js';
import { monitor } from './monitor.js';
import { openStore } from './store.js';

const url = 'https://github.com/example/project/pull/12';
await test('prompt and model overrides fall back through PR, repository and app scopes', (t) => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const data = store.assistant;
  const defaults: Preferences = {
    agent: 'codex',
    model: 'a',
    provider: 'default',
    prompt: defaultPrompt,
  };
  assert.equal(data.preferences(url, 'claude').settings.agent, 'claude');
  data.savePreferences(url, 'default', defaults);
  data.savePreferences(url, 'repository', { ...defaults, model: 'b' });
  data.savePreferences(url, 'review', { ...defaults, model: 'c' });
  assert.equal(data.preferences(url, 'codex').settings.model, 'c');
  assert.equal(data.preferences(url.replace('12', '13'), 'codex').settings.model, 'b');
  assert.equal(data.preferences(url.replace('project', 'other'), 'codex').settings.model, 'a');
  data.clearPreferences(url, 'review');
  assert.equal(data.preferences(url, 'codex').settings.model, 'b');
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
    selection: { path: file.path, hunk: 0, side: 'new' as const, line: 90 },
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
  assert.equal(context.pullRequest.totalChangedFiles, 2);
  assert.equal(
    context.evidence.every((s) => s.path === 'caller.ts'),
    true,
  );
  const modified = build({
    ...req,
    path: 'caller.ts',
    hunk: 1,
    selection: { path: 'caller.ts', hunk: 1, side: 'new', line: 10 },
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
  const sync = monitor(data, new AbortController().signal, (endpoint) => {
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
  });
  data.add(repo);
  assert.deepEqual((await sync(repo, true))[0]?.authors, ['guest', 'octo']);
  data.watch(repo, ['octo']);
  assert.deepEqual(
    (await sync(repo, false))[0]?.pulls.map((p) => p.number),
    [4],
  );
  nextPr = 10;
  assert.deepEqual(
    (await sync(repo, false))[0]?.pulls.map((p) => p.number),
    [10],
  );
  offline = true;
  const cached = (await sync(repo, false))[0];
  assert.deepEqual(
    cached?.pulls.map((p) => p.number),
    [10],
  );
  assert.equal(cached?.error, 'Offline');
});
