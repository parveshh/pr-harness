import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { devNull } from 'node:os';
import { githubEnvironment } from './github.js';
import { pullRequestUrl } from '../shared/reviews.js';

class UnsupportedFile extends Error {}

const cacheWrites = new Map<string, Promise<void>>();

const exec = promisify(execFile);
const sha = /^[0-9a-f]{40}$/;
type Git = (args: string[], signal: AbortSignal) => Promise<Buffer>;

const git: Git = async (args, signal) =>
  (
    await exec(
      'git',
      [
        '-c',
        'core.hooksPath=' + devNull,
        '-c',
        'protocol.allow=never',
        '-c',
        'protocol.https.allow=always',
        ...args,
      ],
      {
        encoding: 'buffer',
        signal,
        timeout: 120000,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...Object.fromEntries(
            Object.entries(githubEnvironment()).filter(
              ([name]) => !name.toUpperCase().startsWith('GIT_'),
            ),
          ),
          GIT_TERMINAL_PROMPT: '0',
          GIT_CONFIG_GLOBAL: devNull,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_NO_REPLACE_OBJECTS: '1',
        },
      },
    )
  ).stdout;

// Cache immutable Git objects in a bare repository. Never check out PR files or run their hooks.
export function pinnedSource(root: string, url: string, run: Git = git) {
  const repo = new URL(pullRequestUrl.parse(url)).pathname.split('/').slice(1, 3).join('/');
  const directory = join(root, createHash('sha256').update(repo).digest('hex'));
  const inRepo = (args: string[], signal: AbortSignal) =>
    run(['--git-dir=' + directory, ...args], signal);
  const ready = new Set<string>();
  async function ensure(commit: string, signal: AbortSignal) {
    if (!sha.test(commit)) throw Error('The requested commit is unavailable.');
    if (ready.has(commit)) return;
    signal.throwIfAborted();
    const previous = cacheWrites.get(directory) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(async () => {
        signal.throwIfAborted();
        if (ready.has(commit)) return;
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await run(['init', '--bare', '--template=', directory], signal);
        try {
          await inRepo(['cat-file', '-e', commit + '^{commit}'], signal);
        } catch {
          signal.throwIfAborted();
          await inRepo(
            [
              '-c',
              'credential.helper=',
              '-c',
              'credential.helper=!gh auth git-credential',
              'fetch',
              '--quiet',
              '--no-tags',
              '--no-recurse-submodules',
              '--no-write-fetch-head',
              '--depth=1',
              'https://github.com/' + repo + '.git',
              commit + ':refs/reviewer/' + commit,
            ],
            signal,
          );
        }
        ready.add(commit);
      })
      .finally(() => {
        if (cacheWrites.get(directory) === current) cacheWrites.delete(directory);
      });
    cacheWrites.set(directory, current);
    // Cancellation stops this reader immediately. The queue advances only when the Git writer exits.
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(new Error('Source read cancelled.'));
      signal.addEventListener('abort', abort, { once: true });
      void current.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
  async function regularFile(commit: string, path: string, signal: AbortSignal) {
    await ensure(commit, signal);
    const entry = (
      await inRepo(['ls-tree', '-z', commit, '--', ':(literal)' + path], signal)
    ).toString();
    const blob = /^100(?:644|755) blob ([0-9a-f]{40})\t/.exec(entry)?.[1];
    if (!blob || entry.slice(entry.indexOf('\t') + 1) !== path + '\0')
      throw new UnsupportedFile('No regular file at that path in this commit.');
    const size = Number((await inRepo(['cat-file', '-s', blob], signal)).toString());
    if (size > 2 * 1024 * 1024)
      throw new UnsupportedFile('File exceeds the 2 MiB source-read limit.');
    const bytes = await inRepo(['cat-file', 'blob', blob], signal);
    if (bytes.includes(0)) throw new UnsupportedFile('Binary file.');
    return { blob, text: bytes.toString('utf8') };
  }
  return {
    async text(commit: string, path: string, signal: AbortSignal) {
      return (await regularFile(commit, path, signal)).text;
    },
    async fullFile(
      head: string,
      before: string | null | undefined,
      file: { path: string; previousPath: string | null; status: string },
      signal: AbortSignal,
    ) {
      const oldPath = file.previousPath ?? file.path;
      const old =
        file.status === 'added' ? null : before ? await regularFile(before, oldPath, signal) : null;
      if (file.status !== 'added' && !old)
        throw Error('The merge base is unavailable. Refresh the PR to load its full file.');
      const current = file.status === 'removed' ? null : await regularFile(head, file.path, signal);
      if (!old || !current || old.blob === current.blob) {
        const text = (current ?? old)?.text ?? '';
        if (!text) return '';
        const marker = !old ? '+' : !current ? '-' : ' ';
        const body = marker + text.replace(/\n$/, '').replaceAll('\n', '\n' + marker);
        return '@@ -' + (old ? '1' : '0,0') + ' +' + (current ? '1' : '0,0') + ' @@\n' + body;
      }
      const diff = await inRepo(
        [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '--text',
          '--unified=4194304',
          old.blob,
          current.blob,
        ],
        signal,
      );
      const patch = diff.toString('utf8');
      const start = patch.indexOf('\n@@ ');
      if (start < 0) throw Error('Git could not compare these file versions.');
      return patch.slice(start + 1).replace(/\n$/, '');
    },
    async read(commit: string, path: string, start: number, signal: AbortSignal, query?: string) {
      let text: string;
      try {
        text = (await regularFile(commit, path, signal)).text;
      } catch (e) {
        signal.throwIfAborted();
        if (e instanceof UnsupportedFile) return { unavailable: e.message };
        throw e;
      }
      const lines = text.split('\n');
      if (lines.at(-1) === '') lines.pop();
      if (query) {
        const match = lines.findIndex((l, i) => i >= start - 1 && l.includes(query));
        if (match < 0)
          return {
            path,
            commit,
            totalLines: lines.length,
            lines: [],
            message: 'No matching line in this range.',
          };
        start = Math.max(start, match + 1 - 4);
      }
      const rows = [];
      let chars = 0;
      for (
        let index = start - 1;
        index < lines.length && rows.length < 60 && chars < 8000;
        index++
      ) {
        const value = lines[index] ?? '';
        const match = query ? value.indexOf(query) : -1;
        const column = Math.max(0, match - 300);
        const text = value.slice(column, column + 1000);
        rows.push({
          line: index + 1,
          text,
          ...(column && { startColumn: column + 1 }),
          ...(value.length > text.length && { truncated: true }),
        });
        chars += text.length;
      }
      return {
        path,
        commit,
        totalLines: lines.length,
        lines: rows,
        nextStart: start + rows.length <= lines.length ? start + rows.length : null,
        link:
          'https://github.com/' +
          repo +
          '/blob/' +
          commit +
          '/' +
          path.split('/').map(encodeURIComponent).join('/'),
      };
    },
    async find(commit: string, query: string, offset: number, signal: AbortSignal) {
      await ensure(commit, signal);
      let result: Buffer;
      try {
        result = await inRepo(
          ['grep', '--no-textconv', '-I', '-l', '-z', '-F', '-e', query, commit, '--'],
          signal,
        );
      } catch (e) {
        signal.throwIfAborted();
        if (e && typeof e === 'object' && 'code' in e && e.code === 1)
          return { paths: [], total: 0 };
        throw e;
      }
      const paths = result
        .toString()
        .split('\0')
        .filter(Boolean)
        .map((p) => p.slice(commit.length + 1));
      const page = [];
      let chars = 0;
      for (const path of paths.slice(offset, offset + 40)) {
        page.push(path);
        chars += path.length;
        if (chars >= 8000) break;
      }
      const end = offset + page.length;
      return { paths: page, total: paths.length, nextOffset: end < paths.length ? end : null };
    },
  };
}
