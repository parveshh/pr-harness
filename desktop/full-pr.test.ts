import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { z } from 'zod';
import { pinnedSource } from './pr-source.js';
import { prLookups, runWithPrLookups } from './full-pr.js';
import { citedAnswer } from './evidence.js';
import type { Citation, SourceCitation } from '../shared/assistant.js';
import type { ReaderView } from '../shared/reader.js';

const exec = promisify(execFile);
const url = 'https://github.com/example/project/pull/12';
const signal = new AbortController().signal;

await test('full context follows a diff to an unchanged caller at both commits, including after an offline restart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'review-source-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = join(directory, 'fixture');
  await mkdir(repo);
  const git = async (...args: string[]) =>
    (
      await exec(
        'git',
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.com',
          '-c',
          'commit.gpgsign=false',
          ...args,
        ],
        { cwd: repo },
      )
    ).stdout.trim();
  await git('init', '--template=');
  await mkdir(join(repo, 'tests'));
  const caller = 'tests/caller [1].ts';
  await writeFile(join(repo, caller), 'callTarget();\n');
  await writeFile(join(repo, 'target.ts'), 'before();\n');
  await symlink('target.ts', join(repo, 'alias'));
  await writeFile(join(repo, 'binary'), Buffer.from([0, 1]));
  await git('add', '.');
  await git('commit', '-m', 'baseline');
  const before = await git('rev-parse', 'HEAD');
  await writeFile(join(repo, 'target.ts'), 'x'.repeat(1400) + 'callTarget();\n');
  await git('commit', '-am', 'change');
  const head = await git('rev-parse', 'HEAD');
  let downloads = 0;
  const cache = join(directory, 'cache');
  const makeSource = () =>
    pinnedSource(cache, url, async (args, signal) => {
      const remote = args.indexOf('https://github.com/example/project.git');
      if (remote >= 0) {
        args[remote] = repo;
        downloads++;
      }
      return (await exec('git', args, { signal, encoding: 'buffer' })).stdout;
    });
  const src = makeSource();
  const full = await Promise.all(
    Array.from({ length: 4 }, () =>
      makeSource().fullFile(
        head,
        before,
        { path: 'target.ts', previousPath: null, status: 'modified' },
        signal,
      ),
    ),
  );
  assert.equal(new Set(full).size, 1);
  assert.match(full[0] ?? '', /-before\(\);\n\+x/);
  assert.equal((await src.read(before, 'target.ts', 1, signal)).lines?.[0]?.text, 'before();');
  assert.match(
    (await src.read(head, 'target.ts', 1, signal, 'callTarget')).lines?.[0]?.text ?? '',
    /callTarget/,
  );
  assert.equal(downloads, 2);
  const offline = pinnedSource(cache, url);
  const previous = process.env.GIT_OBJECT_DIRECTORY;
  process.env.GIT_OBJECT_DIRECTORY = join(directory, 'irrelevant');
  t.after(() => {
    if (previous === undefined) delete process.env.GIT_OBJECT_DIRECTORY;
    else process.env.GIT_OBJECT_DIRECTORY = previous;
  });
  assert.deepEqual((await offline.find(head, 'callTarget', 0, signal)).paths, [
    'target.ts',
    caller,
  ]);
  for (const path of ['tests/', 'alias', 'binary'])
    assert.ok((await offline.read(head, path, 1, signal)).unavailable);
  const files = Array.from({ length: 42 }, (_, i) => ({
    path: 'change-' + i,
    previousPath: null,
    status: 'modified',
    kind: 'text' as const,
    hunk: 0,
    scroll: 0,
    reviewed: false,
    additions: 1,
    deletions: 1,
  }));
  const view: ReaderView = {
    meta: {
      totalFiles: 42,
      head,
      base: before,
      mergeBase: before,
      title: 'Change',
      author: 'a',
      description: '',
      headBranch: 'new',
      baseBranch: 'main',
    },
    revision: 'r',
    files,
    selected: 'change-0',
  };
  const refs: Citation[] = [],
    sourceRefs: SourceCitation[] = [];
  const read = prLookups(
    view,
    (p) => (p === 'change-41' ? '@@ -6 +7 @@\n-old\n+' + 'x'.repeat(1500) + 'callTarget();' : ''),
    refs,
    offline,
    sourceRefs,
    {
      url,
      load: () =>
        Promise.resolve({
          account: 'octo',
          threads: [
            {
              id: 60,
              kind: 'inline',
              path: 'change-41',
              line: null,
              originalLine: 8,
              messages: [{ id: 60, author: 'octo', body: 'Why here?', created: 'yesterday' }],
            },
          ],
        }),
    },
  );
  await read({ op: 'read_diff', path: 'change-41', offset: 0 }, signal);
  const discussion = await read({ op: 'discussions', offset: 0 }, signal);
  assert.deepEqual(
    z
      .object({
        messages: z.array(
          z.object({ id: z.number(), kind: z.string(), originalLine: z.number(), line: z.null() }),
        ),
      })
      .parse(discussion).messages,
    [{ id: 60, kind: 'inline', originalLine: 8, line: null }],
  );
  const manifest = await read({ op: 'files', offset: 40 }, signal);
  assert.equal(
    z.object({ files: z.array(z.object({ path: z.string() })) }).parse(manifest).files[1]?.path,
    'change-41',
  );
  let calls = 0;
  const result = await runWithPrLookups(
    { question: 'Trace the caller' },
    (input) => {
      calls++;
      if (calls === 1)
        return Promise.resolve({
          answer: JSON.stringify({
            prLookup: [
              { op: 'search_diff', query: 'callTarget' },
              { op: 'read_source', path: caller },
            ],
          }),
          reportedModel: null,
        });
      const pages = z
        .object({
          lookups: z.tuple([
            z.object({
              result: z.object({ rows: z.array(z.object({ id: z.number(), line: z.number() })) }),
            }),
            z.object({ result: z.object({ lines: z.array(z.object({ id: z.number() })) }) }),
          ]),
        })
        .parse(JSON.parse(input));
      const row = pages.lookups[0].result.rows[0],
        source = pages.lookups[1].result.lines[0];
      assert.ok(row && source);
      assert.equal(row.line, 7);
      return Promise.resolve({
        answer: 'Changed [[' + row.id + ']] called by [[' + source.id + ']] [[999]].',
        reportedModel: null,
      });
    },
    read,
    signal,
    () => {},
  );
  const answer = citedAnswer(result.answer, refs, sourceRefs);
  assert.match(answer.citations[0]?.excerpt ?? '', /callTarget/);
  assert.equal(answer.citations[0]?.path, 'change-41');
  assert.equal(
    answer.sourceCitations?.[0]?.url,
    'https://github.com/example/project/blob/' + head + '/tests/caller%20%5B1%5D.ts#L1',
  );
  assert.match(answer.answer, /unverified reference/);
  await assert.rejects(read({ op: 'files', offset: 0 }, AbortSignal.abort()));
});
