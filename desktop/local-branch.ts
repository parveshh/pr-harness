import { expandSavedFileDiff } from './saved-file-diff.js';
import { commitFileDiff } from './commit-file-diff.js';
import { fullContext, reviewDiffBytes, reviewFileBytes } from './file-diff-limits.js';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdtemp,
  open,
  readlink,
  realpath,
  rm,
  stat,
  utimes,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { devNull, tmpdir } from 'node:os';
import type { FileInfo } from '../shared/reader.js';
import { revisionHead, uncommittedDigest } from '../shared/reader.js';
import type { BaseOption } from '../shared/local.js';
import { githubEnvironment, gitPath, type Snapshot, type SnapshotFile } from './github.js';

// Everything here only reads the reviewer's repository: no checkout, fetch, index refresh or
// object writes. Commands that read the working tree use a private copy of the index, because
// `git diff` refreshes the index it reads even with `--no-optional-locks`. Lazy fetching in
// partial clones is switched off, and no transport protocol is allowed.
export class LocalReviewError extends Error {}
export class StaleLocalRevision extends LocalReviewError {
  constructor() {
    super(
      'The working tree changed after this revision was loaded. Refresh the review to continue.',
    );
  }
}
class UnsupportedFile extends LocalReviewError {}

export const limits = {
  files: 3000,
  filePatch: 1024 * 1024,
  totalPatch: 32 * 1024 * 1024,
  sourceFile: 2 * 1024 * 1024,
  untrackedHash: 8 * 1024 * 1024,
  commits: 50,
};

type GitOptions = {
  signal: AbortSignal;
  limit?: number;
  allowExit?: number[];
  index?: string;
  sink?: (chunk: Buffer) => void;
  timeout?: number;
};
type GitResult = { stdout: Buffer; truncated: boolean; code: number };
// Settings that would run configured programs or change the diff text are pinned, so the
// review shows the same patch whatever the user's or repository's Git configuration says.
const baseArgs = [
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=' + devNull,
  '-c',
  'core.quotePath=true',
  '-c',
  'color.ui=false',
  '-c',
  'log.showSignature=false',
  '-c',
  'diff.algorithm=myers',
  '-c',
  'diff.indentHeuristic=true',
  '-c',
  'diff.interHunkContext=0',
  '-c',
  'diff.suppressBlankEmpty=false',
  '-c',
  'core.splitIndex=false',
  '-c',
  'protocol.allow=never',
];
// Commands that may run clean or process filters on working tree files.
const filtering = new Set(['diff', 'grep']);
// Commands that read the index together with the working tree, and may rewrite the index.
const indexReaders = new Set(['diff', 'grep', 'ls-files']);
// Git is started outside the reviewed repository, so a `git` executable placed in the
// repository is never the one that runs.
const neutralFolder = dirname(process.execPath);
function gitEnvironment(index: string | undefined) {
  return {
    ...Object.fromEntries(
      Object.entries(githubEnvironment()).filter(
        ([name]) => !name.toUpperCase().startsWith('GIT_'),
      ),
    ),
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    // Set after the GIT_* variables are removed, so it always applies.
    GIT_NO_LAZY_FETCH: '1',
    ...(index && { GIT_INDEX_FILE: index }),
    LC_ALL: 'C',
  };
}

// Run git with an argument array and no shell. Output beyond `limit` is dropped and the
// process stopped, so a huge diff yields a labelled prefix instead of failing the review.
export async function runGit(cwd: string, args: string[], options: GitOptions) {
  const command = args[0] ?? '';
  const overrides = filtering.has(command) ? await filterOverrides(cwd, options.signal) : [];
  if (!indexReaders.has(command)) return spawnGit(cwd, [...overrides, ...args], options);
  return withPrivateIndex(cwd, options.signal, (index) =>
    spawnGit(cwd, [...overrides, ...args], { ...options, index }),
  );
}
// Each command gets its own copy of the index in a temporary folder outside the repository.
// Git may refresh and rewrite that copy; the repository's index and its lock are untouched.
const indexPaths = new Map<string, string>();
async function withPrivateIndex<T>(
  cwd: string,
  signal: AbortSignal,
  task: (index: string) => Promise<T>,
) {
  let source = indexPaths.get(cwd);
  if (!source) {
    const out = (
      await spawnGit(cwd, ['rev-parse', '--git-path', 'index'], { signal })
    ).stdout.toString('utf8');
    source = resolve(cwd, out.replace(/\n$/, ''));
    indexPaths.set(cwd, source);
  }
  const folder = await mkdtemp(join(tmpdir(), 'local-reviewer-index-'));
  try {
    const index = join(folder, 'index');
    try {
      const { atime, mtimeMs } = await stat(source);
      await copyFile(source, index, constants.COPYFILE_FICLONE);
      // Git trusts cached file stats only for entries older than the index file itself
      // ("racy git"). The copy keeps the original's time, rounded down to the second, so a
      // same-size edit made just after the index was written is still compared by content.
      await utimes(index, atime, new Date(Math.floor(mtimeMs / 1000) * 1000));
    } catch (error) {
      // A repository without an index reads as an empty one, as Git itself would.
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
        throw new LocalReviewError(
          'Git could not read this repository. Check the folder and retry.',
        );
    }
    return await task(index);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
// Clean and process filters (Git LFS, for example) run programs and may write objects into
// the repository. Every configured filter driver is switched off for commands that read
// working tree files, so the diff compares the bytes on disk.
async function filterOverrides(cwd: string, signal: AbortSignal) {
  const names = (
    await spawnGit(cwd, ['config', '-z', '--name-only', '--get-regexp', '^filter\\.'], {
      signal,
      allowExit: [1],
    })
  ).stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((key) => key.slice('filter.'.length, key.lastIndexOf('.')))
    .filter(Boolean);
  const overrides: string[] = [];
  for (const name of new Set(names)) {
    if (/[=\n]/.test(name))
      throw new LocalReviewError(
        'This repository configures a Git filter that Local Reviewer cannot switch off.',
      );
    for (const key of ['clean', 'smudge', 'process'])
      overrides.push('-c', 'filter.' + name + '.' + key + '=');
    overrides.push('-c', 'filter.' + name + '.required=false');
  }
  return overrides;
}
function spawnGit(cwd: string, args: string[], options: GitOptions): Promise<GitResult> {
  const { signal, limit = 16 * 1024 * 1024, allowExit = [], sink, timeout = 60000 } = options;
  const { index } = options;
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn('git', ['-C', cwd, ...baseArgs, ...args], {
      cwd: neutralFolder,
      env: gitEnvironment(index),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
      timeout,
    });
    const chunks: Buffer[] = [];
    let size = 0,
      truncated = false,
      stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      if (sink) return sink(chunk);
      if (truncated) return;
      if (size + chunk.length > limit) {
        chunks.push(chunk.subarray(0, limit - size));
        size = limit;
        truncated = true;
        child.kill();
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString('utf8');
    });
    const aborted = () => (signal.reason instanceof Error ? signal.reason : new Error('Aborted.'));
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (signal.aborted) return reject(aborted());
      if (error.code === 'ENOENT')
        return reject(new LocalReviewError('Install Git and try again.', { cause: error }));
      reject(error);
    });
    child.on('close', (code) => {
      if (signal.aborted) return reject(aborted());
      const stdout = Buffer.concat(chunks);
      if (truncated) return resolve({ stdout, truncated, code: code ?? 0 });
      if (code === 0 || (code !== null && allowExit.includes(code)))
        return resolve({ stdout, truncated, code });
      reject(new GitFailure(stderr.trim(), code));
    });
  });
}
export class GitFailure extends Error {
  constructor(
    readonly stderr: string,
    readonly code: number | null,
  ) {
    super('Git could not read this repository.');
  }
}
// Command output that must be complete: a cut listing would silently drop files.
async function text(cwd: string, args: string[], options: GitOptions) {
  const result = await runGit(cwd, args, options);
  if (result.truncated)
    throw new LocalReviewError('Git output for this repository is too large to read.');
  return result.stdout.toString('utf8');
}

// ----- Pure helpers, tested directly -----

export type RawEntry = {
  status: string;
  path: string;
  previousPath: string | null;
  oldBlob: string;
  // A file replaced by a symbolic link, or the reverse. The patch prints it as two sections.
  typeChange: boolean;
};
// `git diff --raw -z --no-abbrev`: ":old new oldsha newsha STATUS\0path\0[path\0]".
export function parseRawDiff(output: string): RawEntry[] {
  const tokens = output.split('\0');
  const entries: RawEntry[] = [];
  for (let i = 0; i < tokens.length;) {
    const meta = tokens[i++] ?? '';
    if (!meta) continue;
    const fields = /^:\d+ \d+ ([0-9a-f]+) [0-9a-f]+ ([A-Z])\d*$/.exec(meta);
    if (!fields) throw new Error('Unexpected git diff output.');
    const [, oldBlob = '', letter = 'M'] = fields;
    const first = tokens[i++] ?? '';
    const second = letter === 'R' || letter === 'C' ? (tokens[i++] ?? '') : null;
    entries.push({
      status: statusName(letter),
      path: second ?? first,
      previousPath: second === null ? null : first,
      oldBlob,
      typeChange: letter === 'T',
    });
  }
  return entries;
}
function statusName(letter: string) {
  return (
    { A: 'added', D: 'removed', R: 'renamed', C: 'copied', T: 'changed' }[letter] ?? 'modified'
  );
}
export function splitPatchSections(output: string) {
  return output ? output.split(/\n(?=diff --git )/) : [];
}
export function sectionMatches(section: string, entry: Pick<RawEntry, 'path' | 'previousPath'>) {
  const end = section.indexOf('\n');
  const header = end < 0 ? section : section.slice(0, end);
  const before = 'a/' + (entry.previousPath ?? entry.path),
    after = 'b/' + entry.path;
  return header === 'diff --git ' + gitPath(before) + ' ' + gitPath(after);
}
export function countChanges(patch: string) {
  let additions = 0,
    deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+')) additions++;
    else if (line.startsWith('-')) deletions++;
  }
  return { additions, deletions };
}
// Keep whole hunks where possible. A single oversized hunk is cut at a line boundary.
export function truncatePatch(patch: string, max: number) {
  if (Buffer.byteLength(patch) <= max) return { patch, truncated: false };
  const hunks = patch.split(/\n(?=@@ )/);
  let kept = '';
  for (const hunk of hunks) {
    const next = kept ? kept + '\n' + hunk : hunk;
    if (Buffer.byteLength(next) > max) break;
    kept = next;
  }
  if (!kept) {
    const bytes = Buffer.from(patch).subarray(0, max).toString('utf8');
    kept = bytes.slice(0, Math.max(0, bytes.lastIndexOf('\n')));
  }
  return { patch: kept, truncated: true };
}
export function sectionPatch(section: string) {
  const start = /^@@ /m.exec(section);
  return start ? section.slice(start.index).replace(/\n$/, '') : '';
}
// Git prints a type change as a deletion followed by a creation of the same path. One hunk
// that removes every old line and adds every new line shows it as a single file.
export function joinTypeChange(removed: string, created: string) {
  const binary = /^(Binary files |GIT binary patch$)/m;
  if (binary.test(removed) || binary.test(created)) return removed + '\n' + created;
  const body = (section: string) => {
    const patch = sectionPatch(section);
    const end = patch.indexOf('\n');
    return end < 0 ? '' : patch.slice(end + 1);
  };
  const old = body(removed),
    next = body(created);
  const count = (lines: string, mark: string) =>
    lines.split('\n').filter((line) => line.startsWith(mark)).length;
  const range = (n: number) => (n === 0 ? '0,0' : n === 1 ? '1' : '1,' + n);
  const end = removed.search(/\n@@ /);
  const header = end < 0 ? removed.replace(/\n$/, '') : removed.slice(0, end);
  const lines = [old, next].filter(Boolean).join('\n');
  if (!lines) return header;
  return (
    header + '\n@@ -' + range(count(old, '-')) + ' +' + range(count(next, '+')) + ' @@\n' + lines
  );
}
// The same unified hunk git prints for a new file, built from its bytes.
export function addedFilePatch(content: string) {
  if (!content) return '';
  const lines = content.split('\n');
  const endsWithNewline = content.endsWith('\n');
  if (endsWithNewline) lines.pop();
  const body = lines.map((line) => '+' + line).join('\n');
  const count = lines.length === 1 ? '1' : '1,' + lines.length;
  return (
    '@@ -0,0 +' + count + ' @@\n' + body + (endsWithNewline ? '' : '\n\\ No newline at end of file')
  );
}
export function looksBinary(bytes: Buffer) {
  return bytes.subarray(0, 8000).includes(0);
}
export function revisionId(mergeBase: string, head: string, digest: string | null) {
  return mergeBase + '...' + head + (digest ? '+' + digest : '');
}
export function workingStateId(state: { head: string; digest: string | null }) {
  return state.head + (state.digest ? '+' + state.digest : '');
}
export function parseRefs(output: string): BaseOption[] {
  return output
    .split('\n')
    .map((line) => line.split('\0'))
    .filter(([ref, name, symref]) => !!ref && !!name && !symref && !ref.endsWith('/HEAD'))
    .map(([ref = '', name = '']) => ({ ref, name }));
}
export function chooseDefaultBase(
  bases: BaseOption[],
  originHead: string | null,
  branch: string | null,
) {
  const current = branch ? 'refs/heads/' + branch : null;
  const order = [
    originHead,
    'refs/heads/main',
    'refs/heads/master',
    'refs/remotes/origin/main',
    'refs/remotes/origin/master',
  ];
  for (const ref of order)
    if (ref && ref !== current && bases.some((b) => b.ref === ref)) return ref;
  return null;
}
const baseRefPattern = /^refs\/(?:heads|remotes)\/(?!.*\.\.)[^\0\s~^:?*[\\]+$/;
export function validBaseRef(ref: string) {
  return baseRefPattern.test(ref) && !ref.endsWith('.lock') && !ref.endsWith('/');
}

// ----- Repository inspection -----

function gitFailureMessage(error: unknown): Error {
  if (error instanceof LocalReviewError) return error;
  if (error instanceof GitFailure) {
    if (/not a git repository/i.test(error.stderr))
      return new LocalReviewError('This folder is not a Git repository. Choose a Git work tree.');
    if (/dubious ownership/i.test(error.stderr))
      return new LocalReviewError(
        'Git does not trust this folder’s owner. Mark it as a safe directory in Git, then try again.',
      );
    // Git's own message can name local paths, so it stays out of errors that reach logs.
    return new LocalReviewError('Git could not read this repository. Check the folder and retry.');
  }
  return error instanceof Error ? error : new Error('Git could not read this repository.');
}

export async function repositoryRoot(folder: string, signal: AbortSignal) {
  let resolved: string;
  try {
    resolved = await realpath(folder);
    if (!(await stat(resolved)).isDirectory()) throw new Error('Not a folder.');
  } catch (cause) {
    throw new LocalReviewError('Choose an existing folder.', { cause });
  }
  try {
    const [bare = '', inside = '', top = ''] = (
      await text(
        resolved,
        ['rev-parse', '--is-bare-repository', '--is-inside-work-tree', '--show-toplevel'],
        {
          signal,
        },
      )
    )
      .trim()
      .split('\n');
    if (bare === 'true' || inside !== 'true')
      throw new LocalReviewError('Choose a folder with a working tree, not a bare repository.');
    const root = await realpath(top);
    if (root !== resolved)
      throw new LocalReviewError(
        'Choose the top-level folder of this repository (' + basename(root) + ').',
      );
    return root;
  } catch (error) {
    signal.throwIfAborted();
    throw gitFailureMessage(error);
  }
}

async function headCommit(root: string, signal: AbortSignal) {
  const head = (
    await text(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], {
      signal,
      allowExit: [1],
    })
  ).trim();
  if (/^[0-9a-f]{64}$/.test(head))
    throw new LocalReviewError('Repositories that use SHA-256 object names are not supported yet.');
  if (!/^[0-9a-f]{40}$/.test(head))
    throw new LocalReviewError('This repository has no commits yet. Commit once, then try again.');
  return head;
}
async function currentBranch(root: string, signal: AbortSignal) {
  const name = (
    await text(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { signal, allowExit: [1] })
  ).trim();
  return name || null;
}

export async function inspectRepository(folder: string, signal: AbortSignal) {
  const root = await repositoryRoot(folder, signal);
  try {
    const head = await headCommit(root, signal);
    const branch = await currentBranch(root, signal);
    const bases = parseRefs(
      await text(
        root,
        [
          'for-each-ref',
          '--format=%(refname)%00%(refname:short)%00%(symref)',
          'refs/heads',
          'refs/remotes',
        ],
        { signal },
      ),
    );
    const originHead =
      (
        await text(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], {
          signal,
          allowExit: [1],
        })
      ).trim() || null;
    return {
      root,
      repository: basename(root) || root,
      branch,
      head,
      bases,
      defaultBase: chooseDefaultBase(bases, originHead, branch),
    };
  } catch (error) {
    signal.throwIfAborted();
    throw gitFailureMessage(error);
  }
}

// ----- Working tree state -----

// HEAD plus a digest of everything uncommitted: staged and unstaged edits, including binary
// content, and untracked files that are not ignored. The digest is absent for a clean tree.
export async function workingState(root: string, signal: AbortSignal) {
  try {
    const head = await headCommit(root, signal);
    const hash = createHash('sha256');
    let changed = 0;
    await runGit(
      root,
      [
        'diff',
        'HEAD',
        '--binary',
        '--full-index',
        '--no-renames',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--no-relative',
        // Submodule commits are compared, but their working trees are not entered: that would run
        // filters configured inside the submodule.
        '--ignore-submodules=dirty',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        '--',
      ],
      {
        signal,
        sink: (chunk) => {
          changed += chunk.length;
          hash.update(chunk);
        },
      },
    );
    const untracked = (
      await text(root, ['ls-files', '--others', '--exclude-standard', '--full-name', '-z'], {
        signal,
      })
    )
      .split('\0')
      .filter(Boolean)
      .sort();
    for (const path of untracked) {
      signal.throwIfAborted();
      hash.update('\0untracked\0' + path + '\0');
      hash.update(await fileFingerprint(root, path));
    }
    const digest = changed > 0 || untracked.length ? hash.digest('hex').slice(0, 12) : null;
    return { head, digest, untracked };
  } catch (error) {
    signal.throwIfAborted();
    throw gitFailureMessage(error);
  }
}
// Untracked files are hashed on every update check, so a file's digest is reused while its
// size, inode and nanosecond timestamps stay the same.
const fingerprints = new Map<string, { stamp: string; digest: string }>();
async function fileFingerprint(root: string, path: string): Promise<string> {
  const full = join(root, path);
  try {
    const info = await lstat(full, { bigint: true });
    if (info.isSymbolicLink()) return 'link:' + (await readlink(full));
    if (!info.isFile()) return 'other';
    const stamp = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
    if (info.size > BigInt(limits.untrackedHash)) return 'large:' + stamp;
    const known = fingerprints.get(full);
    if (known?.stamp === stamp) return known.digest;
    const digest = hashOf(await readPrefix(full, limits.untrackedHash));
    if (fingerprints.size >= 20000) fingerprints.clear();
    fingerprints.set(full, { stamp, digest });
    return digest;
  } catch {
    return 'unreadable';
  }
}
async function readPrefix(path: string, max: number) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(max);
    let filled = 0;
    while (filled < max) {
      const { bytesRead } = await handle.read(buffer, filled, max - filled, filled);
      if (!bytesRead) break;
      filled += bytesRead;
    }
    return buffer.subarray(0, filled);
  } finally {
    await handle.close();
  }
}

export async function resolveBase(root: string, ref: string, signal: AbortSignal) {
  const name = ref.replace(/^refs\/(?:heads|remotes)\//, '');
  const missing = () =>
    new LocalReviewError('The base branch ' + name + ' was not found. Choose another base branch.');
  if (!validBaseRef(ref)) throw missing();
  try {
    const base = (
      await text(root, ['rev-parse', '--verify', '--quiet', ref + '^{commit}'], {
        signal,
        allowExit: [1],
      })
    ).trim();
    if (!/^[0-9a-f]{40}$/.test(base)) throw missing();
    const result = await runGit(root, ['merge-base', 'HEAD', base], { signal, allowExit: [1] });
    const mergeBase = result.stdout.toString().trim();
    if (!/^[0-9a-f]{40}$/.test(mergeBase))
      throw new LocalReviewError(
        'This branch has no history in common with ' + name + '. Choose another base branch.',
      );
    return { base, mergeBase, name };
  } catch (error) {
    signal.throwIfAborted();
    throw gitFailureMessage(error);
  }
}

// ----- Snapshot -----

export type LocalSnapshot = Snapshot & { dirty: boolean };
const missingContent =
  'This file’s content is not in the local clone (a partial clone without this object). Local Reviewer does not fetch it.';
// A partial clone fetches missing objects on demand from its promisor remote.
async function isPartialClone(root: string, signal: AbortSignal) {
  const result = await runGit(
    root,
    ['config', '--get-regexp', '^(extensions\\.partialclone|remote\\..*\\.promisor)$'],
    { signal, allowExit: [1] },
  );
  return result.code === 0 && result.stdout.length > 0;
}
export async function localSnapshot(
  root: string,
  baseRef: string,
  signal: AbortSignal,
): Promise<LocalSnapshot> {
  const before = await workingState(root, signal);
  const { mergeBase, name } = await resolveBase(root, baseRef, signal);
  try {
    const head = before.head;
    const diffArgs = [
      'diff',
      mergeBase,
      '-M',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--no-relative',
      // Submodule commits are compared, but their working trees are not entered: that would run
      // filters configured inside the submodule.
      '--ignore-submodules=dirty',
    ];
    let raw: RawEntry[], patches: GitResult;
    let contentMissing = false;
    try {
      raw = parseRawDiff(
        await text(root, [...diffArgs, '--raw', '-z', '--no-abbrev', '--'], { signal }),
      );
      patches = await runGit(
        root,
        [...diffArgs, '--src-prefix=a/', '--dst-prefix=b/', '--unified=3', '--'],
        { signal, limit: limits.totalPatch },
      );
    } catch (error) {
      if (!(error instanceof GitFailure) || !(await isPartialClone(root, signal))) throw error;
      // Without the objects there is no patch. The file list still comes from the raw diff,
      // and every changed tracked file is labelled unavailable.
      contentMissing = true;
      raw = parseRawDiff(
        await text(
          root,
          [
            ...diffArgs.filter((a) => a !== '-M'),
            '--no-renames',
            '--raw',
            '-z',
            '--no-abbrev',
            '--',
          ],
          { signal },
        ),
      );
      patches = { stdout: Buffer.alloc(0), truncated: false, code: 0 };
    }
    const sections = splitPatchSections(patches.stdout.toString('utf8'));
    const files: SnapshotFile[] = [];
    let paired = true,
      cursor = 0,
      budget = limits.totalPatch;
    for (const entry of raw) {
      // Raw entries and patch sections come in the same order; a type change has two.
      const count = entry.typeChange ? 2 : 1;
      const parts = sections.slice(cursor, cursor + count);
      cursor += count;
      if (paired && (parts.length < count || !parts.every((s) => sectionMatches(s, entry))))
        paired = false;
      const [first = '', second = ''] = parts;
      const section = entry.typeChange ? joinTypeChange(first, second) : first;
      const lastSection = patches.truncated && cursor >= sections.length;
      const file = paired
        ? await trackedFile(root, entry, section, lastSection, budget)
        : unavailableFile(entry.status, entry.path, entry.previousPath);
      budget -= Buffer.byteLength(file.patch);
      files.push(file);
    }
    const tracked = new Set(files.map((f) => f.info.path));
    for (const path of before.untracked) {
      if (tracked.has(path)) continue;
      const file = await untrackedFile(root, path, budget);
      budget -= Buffer.byteLength(file.patch);
      files.push(file);
    }
    files.sort((a, b) => (a.info.path < b.info.path ? -1 : a.info.path > b.info.path ? 1 : 0));
    const after = await workingState(root, signal);
    if (workingStateId(after) !== workingStateId(before))
      throw new LocalReviewError(
        'The working tree changed while it was being read. Refresh to load the latest changes.',
      );
    const branch = await currentBranch(root, signal);
    const subjects = (
      await text(
        root,
        [
          'log',
          '--no-color',
          '--no-show-signature',
          '--format=%s%x00',
          '--max-count=' + (limits.commits + 1),
          mergeBase + '..' + head,
          '--',
        ],
        { signal },
      )
    )
      .split('\0')
      .map((s) => s.trim())
      .filter(Boolean);
    const user = (
      await text(root, ['config', '--get', 'user.name'], { signal, allowExit: [1] })
    ).trim();
    const dirty = before.digest !== null;
    const description = [
      subjects.length
        ? 'Commits since the merge base:\n\n' +
          subjects
            .slice(0, limits.commits)
            .map((s) => '- ' + s)
            .join('\n') +
          (subjects.length > limits.commits ? '\n- … and more commits' : '')
        : 'No commits since the merge base.',
      ...(dirty
        ? [
            'Includes uncommitted changes: staged, unstaged and untracked files in the working tree.',
          ]
        : []),
      ...(contentMissing
        ? [
            'This partial clone lacks some file contents, so changed tracked files are shown as unavailable. Fetch the missing objects in the clone, then refresh.',
          ]
        : []),
    ].join('\n\n');
    return {
      dirty,
      revision: revisionId(mergeBase, head, before.digest),
      meta: {
        title: branch ?? subjects.at(-1) ?? 'Detached HEAD at ' + head.slice(0, 8),
        author: user || 'local',
        description,
        totalFiles: files.length,
        // The diff is taken from the merge base, so the base branch advancing alone does not
        // change what is under review.
        base: mergeBase,
        mergeBase,
        head,
        baseBranch: name,
        headBranch: branch ?? 'HEAD',
      },
      files: files.slice(0, limits.files),
    };
  } catch (error) {
    signal.throwIfAborted();
    throw gitFailureMessage(error);
  }
}

function signature(info: FileInfo, ...parts: unknown[]) {
  return createHash('sha256')
    .update(JSON.stringify([info, ...parts]))
    .digest('hex');
}
function unavailableFile(status: string, path: string, previousPath: string | null): SnapshotFile {
  const info: FileInfo = {
    path,
    previousPath,
    status,
    additions: 0,
    deletions: 0,
    kind: 'unavailable',
  };
  return { info, patch: '', signature: signature(info, 'unavailable') };
}

async function trackedFile(
  root: string,
  entry: RawEntry,
  section: string,
  cut: boolean,
  budget: number,
): Promise<SnapshotFile> {
  if (budget <= 0) return unavailableFile(entry.status, entry.path, entry.previousPath);
  const full = sectionPatch(section);
  const { patch, truncated } = truncatePatch(
    cut ? full.slice(0, Math.max(0, full.lastIndexOf('\n'))) : full,
    Math.min(limits.filePatch, budget),
  );
  const counts = countChanges(patch);
  let kind: FileInfo['kind'];
  if (patch) kind = truncated || cut ? 'partial' : 'text';
  else if (/^(Binary files |GIT binary patch$)/m.test(section)) kind = 'binary';
  else kind = cut ? 'unavailable' : 'metadata';
  const info: FileInfo = {
    path: entry.path,
    previousPath: entry.previousPath,
    status: entry.status,
    ...counts,
    kind,
  };
  if (kind !== 'binary' && kind !== 'metadata')
    return { info, patch, signature: signature(info, patch) };
  // Binary and metadata changes print no content. The old blob, the header's modes and the
  // working tree bytes identify them instead.
  const header = section.slice(0, section.search(/\n(?:@@ |Binary files )|$/));
  const current = entry.status === 'removed' ? 'absent' : await fileFingerprint(root, entry.path);
  return { info, patch, signature: signature(info, entry.oldBlob, header, hashOf(current)) };
}
async function untrackedFile(root: string, path: string, budget: number): Promise<SnapshotFile> {
  const base = (kind: FileInfo['kind'], patch: string): FileInfo => ({
    path,
    previousPath: null,
    status: 'added',
    ...countChanges(patch),
    kind,
  });
  if (budget <= 0 || path.endsWith('/'))
    return unavailableFile('added', path.replace(/\/$/, ''), null);
  const full = join(root, path);
  try {
    const info = await lstat(full);
    if (info.isSymbolicLink()) {
      const patch = addedFilePatch(await readlink(full));
      const fileInfo = base('text', patch);
      return { info: fileInfo, patch, signature: signature(fileInfo, patch) };
    }
    if (!info.isFile()) return unavailableFile('added', path, null);
    const max = Math.min(limits.filePatch, budget);
    const bytes = await readPrefix(full, max + 1);
    if (looksBinary(bytes)) {
      const fileInfo = base('binary', '');
      const content = await fileFingerprint(root, path);
      return { info: fileInfo, patch: '', signature: signature(fileInfo, hashOf(content)) };
    }
    let content = bytes.toString('utf8');
    let patch = addedFilePatch(content);
    const complete = bytes.length <= max && info.size <= max && Buffer.byteLength(patch) <= max;
    // Keep whole lines that fit with their markers, so the hunk header stays accurate.
    if (!complete) content = content.replace(/[^\n]*$/, '');
    while (!complete && content && Buffer.byteLength((patch = addedFilePatch(content))) > max)
      content = content.slice(0, Math.floor(content.length * 0.9)).replace(/[^\n]*$/, '');
    if (!complete && !content) patch = '';
    const kind = !patch && complete ? 'metadata' : complete ? 'text' : 'partial';
    const fileInfo = base(kind, patch);
    return { info: fileInfo, patch, signature: signature(fileInfo, patch) };
  } catch {
    return unavailableFile('added', path, null);
  }
}
const hashOf = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

// ----- Source reads for the reader, citations and Full PR lookups -----

type Side = 'head' | 'before';
export type LocalRevision = {
  revision: string;
  head: string;
  mergeBase: string | null | undefined;
};

// A path from the reader or an agent, resolved inside the repository root. Symbolic links
// may not lead outside it, Git's own directory is never read, and only files that are part of
// the review (tracked, or untracked and not ignored) are served.
export async function workingTreeFile(
  root: string,
  path: string,
  signal: AbortSignal,
  limit = limits.sourceFile,
) {
  const outside = () => new UnsupportedFile('That path is outside the repository.');
  if (
    !path ||
    path.includes('\0') ||
    isAbsolute(path) ||
    path.split(/[\\/]/).some((part) => part === '..' || part.toLowerCase() === '.git')
  )
    throw outside();
  let top: string;
  try {
    top = await realpath(root);
  } catch {
    throw new LocalReviewError('The repository folder is unavailable. Check that it still exists.');
  }
  const full = join(top, path);
  const rel = relative(top, full);
  if (!rel || !insideFolder(top, full)) throw outside();
  let target: string;
  try {
    target = await realpath(full);
  } catch {
    throw new UnsupportedFile('No file at that path in the working tree.');
  }
  if (!target.startsWith(top + sep))
    throw new UnsupportedFile('That file links outside the repository.');
  const targetRel = relative(top, target).split(sep).join('/');
  const gitDirs = (
    await text(top, ['rev-parse', '--absolute-git-dir', '--git-common-dir'], { signal })
  )
    .split('\n')
    .filter(Boolean)
    .map((dir) => resolve(top, dir));
  const realGitDirs = await Promise.all(gitDirs.map((dir) => realpath(dir).catch(() => dir)));
  if (
    targetRel.split('/').some((part) => part.toLowerCase() === '.git') ||
    realGitDirs.some((dir) => target === dir || insideFolder(dir, target))
  )
    throw outside();
  const wanted = [...new Set([rel.split(sep).join('/'), targetRel])];
  const listed = new Set(
    (
      await text(
        top,
        [
          'ls-files',
          '-z',
          '--cached',
          '--others',
          '--exclude-standard',
          '--full-name',
          '--',
          ...wanted.map((p) => ':(literal)' + p),
        ],
        { signal },
      )
    ).split('\0'),
  );
  if (!wanted.every((p) => listed.has(p)))
    throw new UnsupportedFile('That file is ignored or not part of this review.');
  try {
    const info = await stat(target);
    if (!info.isFile())
      throw new UnsupportedFile('No regular file at that path in the working tree.');
    if (info.size > limit)
      throw new UnsupportedFile('File exceeds the ' + limit / (1024 * 1024) + ' MiB read limit.');
    const bytes = await readPrefix(target, limit + 1);
    if (bytes.length > limit)
      throw new UnsupportedFile('File exceeds the ' + limit / (1024 * 1024) + ' MiB read limit.');
    if (bytes.includes(0)) throw new UnsupportedFile('Binary file.');
    return bytes.toString('utf8');
  } catch (error) {
    // Filesystem errors name absolute paths, so they are replaced before reaching the window.
    if (error instanceof UnsupportedFile) throw error;
    throw new UnsupportedFile('That file could not be read from the working tree.');
  }
}
// Whether `path` is `folder` itself or inside it. `..review.md` is a name, not a parent.
export function insideFolder(folder: string, path: string) {
  const rel = relative(folder, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
}

const staleMessage = new StaleLocalRevision().message;
export const localReadFailure =
  'Could not read the local repository. Refresh the review and retry. Cached diffs remain available.';
export function localSource(root: string, pinned: LocalRevision) {
  const expected = revisionHead(pinned.revision);
  const dirty = uncommittedDigest(pinned.revision) !== null;
  async function verify(signal: AbortSignal) {
    const state = await workingState(root, signal);
    if (workingStateId(state) !== expected) throw new StaleLocalRevision();
  }
  async function commitFile(
    commit: string,
    path: string,
    signal: AbortSignal,
    limit = limits.sourceFile,
  ) {
    if (!/^[0-9a-f]{40}$/.test(commit))
      throw new UnsupportedFile('The requested commit is unavailable.');
    const entry = (
      await text(root, ['ls-tree', '-z', commit, '--', ':(literal)' + path], { signal })
    ).toString();
    const blob = /^100(?:644|755) blob ([0-9a-f]{40})\t/.exec(entry)?.[1];
    if (!blob || entry.slice(entry.indexOf('\t') + 1) !== path + '\0')
      throw new UnsupportedFile('No regular file at that path in this commit.');
    let size: number, bytes: Buffer;
    try {
      size = Number(await text(root, ['cat-file', '-s', blob], { signal }));
      if (size > limit)
        throw new UnsupportedFile('File exceeds the ' + limit / (1024 * 1024) + ' MiB read limit.');
      bytes = (await runGit(root, ['cat-file', 'blob', blob], { signal, limit })).stdout;
    } catch (error) {
      if (!(error instanceof GitFailure)) throw error;
      // A partial clone can lack the blob. It is never fetched on the reviewer's behalf.
      throw new UnsupportedFile(missingContent);
    }
    if (bytes.includes(0)) throw new UnsupportedFile('Binary file.');
    return bytes.toString('utf8');
  }
  // A clean revision is exactly its HEAD commit, so it is read from Git objects. Uncommitted
  // content is read from the working tree, then checked against the pinned revision.
  async function headFile(path: string, signal: AbortSignal, limit = limits.sourceFile) {
    if (!dirty) return commitFile(pinned.head, path, signal, limit);
    const content = await workingTreeFile(root, path, signal, limit);
    await verify(signal);
    return content;
  }
  async function file(commit: string, path: string, side: Side, signal: AbortSignal) {
    if (side === 'head') {
      if (commit !== pinned.head) throw new StaleLocalRevision();
      return headFile(path, signal);
    }
    return commitFile(commit, path, signal);
  }
  const link = (side: Side, path: string) =>
    'local-source:' + side + ':' + path.split('/').map(encodeURIComponent).join('/');
  return {
    verify,
    failure: localReadFailure,
    async text(commit: string, path: string, signal: AbortSignal, side: Side = 'head') {
      try {
        return await file(commit, path, side, signal);
      } catch (error) {
        signal.throwIfAborted();
        throw gitFailureMessage(error);
      }
    },
    async changesBetween(before: string, path: string, signal: AbortSignal) {
      if (!/^[0-9a-f]{40}$/.test(before) || !/^[0-9a-f]{40}$/.test(pinned.head)) return null;
      // Untracked files are absent from a working-tree git diff.
      if (dirty) return null;
      return commitFileDiff(before, pinned.head, path, (args) =>
        text(root, args, { signal, limit: reviewDiffBytes }),
      );
    },
    async fullFile(
      info: { path: string; previousPath: string | null; status: string },
      signal: AbortSignal,
      savedPatch?: string,
    ) {
      try {
        const oldPath = info.previousPath ?? info.path;
        if (info.status === 'added' || info.status === 'removed') {
          const added = info.status === 'added';
          const content = added
            ? await headFile(info.path, signal, reviewFileBytes)
            : await commitFile(pinned.mergeBase ?? '', oldPath, signal, reviewFileBytes);
          if (!content) return '';
          const marker = added ? '+' : '-';
          return (
            '@@ -' +
            (added ? '0,0' : '1') +
            ' +' +
            (added ? '1' : '0,0') +
            ' @@\n' +
            marker +
            content.replace(/\n$/, '').replaceAll('\n', '\n' + marker)
          );
        }
        if (!pinned.mergeBase)
          throw new LocalReviewError('The merge base is unavailable. Refresh the review.');
        // Both sides must be readable regular text files within the size limit.
        const base = await commitFile(pinned.mergeBase, oldPath, signal, reviewFileBytes);
        if (dirty && savedPatch) {
          const full = expandSavedFileDiff(base, savedPatch);
          if (full !== null) return full;
        }
        const current = await (dirty
          ? workingTreeFile(root, info.path, signal, reviewFileBytes)
          : commitFile(pinned.head, info.path, signal, reviewFileBytes));
        const result = await runGit(
          root,
          [
            'diff',
            pinned.mergeBase,
            ...(dirty ? [] : [pinned.head]),
            '-M',
            '--no-ext-diff',
            '--no-textconv',
            '--no-color',
            '--no-relative',
            '--text',
            fullContext,
            '--',
            ':(literal)' + oldPath,
            ':(literal)' + info.path,
          ],
          { signal, limit: reviewDiffBytes },
        );
        if (result.truncated) throw new UnsupportedFile('The full diff exceeds the display limit.');
        const diff = result.stdout.toString('utf8');
        if (dirty) await verify(signal);
        const patch = sectionPatch(diff);
        if (patch) return patch;
        return current ? '@@ -1 +1 @@\n ' + current.replace(/\n$/, '').replaceAll('\n', '\n ') : '';
      } catch (error) {
        signal.throwIfAborted();
        throw gitFailureMessage(error);
      }
    },
    async read(
      commit: string,
      path: string,
      start: number,
      signal: AbortSignal,
      query?: string,
      side: Side = 'head',
    ) {
      let content: string;
      try {
        content = await file(commit, path, side, signal);
      } catch (e) {
        signal.throwIfAborted();
        if (e instanceof StaleLocalRevision) return { unavailable: e.message };
        if (e instanceof UnsupportedFile) return { unavailable: e.message };
        throw e;
      }
      const lines = content.split('\n');
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
        const slice = value.slice(column, column + 1000);
        rows.push({
          line: index + 1,
          text: slice,
          ...(column && { startColumn: column + 1 }),
          ...(value.length > slice.length && { truncated: true }),
        });
        chars += slice.length;
      }
      return {
        path,
        commit,
        totalLines: lines.length,
        lines: rows,
        nextStart: start + rows.length <= lines.length ? start + rows.length : null,
        link: link(side, path),
      };
    },
    async find(
      commit: string,
      query: string,
      offset: number,
      signal: AbortSignal,
      side: Side = 'head',
    ) {
      const worktree = side === 'head' && dirty;
      // The same answer `read` gives, so the agent learns why rather than seeing a failure.
      if (side === 'head' && commit !== pinned.head) return { unavailable: staleMessage };
      let result: GitResult;
      try {
        result = await runGit(
          root,
          [
            'grep',
            '--no-textconv',
            '--no-color',
            '-I',
            '-l',
            '-z',
            '-F',
            ...(worktree ? ['--untracked'] : []),
            '-e',
            query,
            ...(worktree ? [] : [commit]),
            '--',
          ],
          { signal, allowExit: [1] },
        );
        if (worktree) await verify(signal);
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof LocalReviewError) return { unavailable: error.message };
        return { unavailable: localReadFailure };
      }
      const paths = result.stdout
        .toString()
        .split('\0')
        .filter(Boolean)
        .map((p) => (worktree ? p : p.slice(commit.length + 1)));
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
export type LocalSource = ReturnType<typeof localSource>;

// ----- A saved local review -----

type SavedLocalReviews = {
  require(url: string): {
    path: string;
    baseRef: string;
    branch: string | null;
    detached: string | null;
  };
};
// The repository must still be on the branch this review started from. A detached-HEAD
// review follows commits made on top of its starting commit, but not a jump elsewhere.
async function checkBranch(
  review: { path: string; branch: string | null; detached: string | null },
  head: string,
  branch: string | null,
  signal: AbortSignal,
) {
  if (branch !== review.branch)
    throw new LocalReviewError(
      'The repository is now on ' +
        (branch ?? 'a detached HEAD') +
        '. Switch back to ' +
        (review.branch ?? 'the detached HEAD') +
        ' or start a new local review.',
    );
  if (review.branch || !review.detached || head === review.detached) return;
  const descends = await runGit(
    review.path,
    ['merge-base', '--is-ancestor', review.detached, head],
    { signal, allowExit: [1] },
  ).catch(() => {
    signal.throwIfAborted();
    return { code: 1 };
  });
  if (descends.code !== 0)
    throw new LocalReviewError(
      'The repository is now at a different detached commit (' +
        head.slice(0, 8) +
        '). Start a new local review for it.',
    );
}
export async function localReviewSnapshot(
  reviews: SavedLocalReviews,
  url: string,
  signal: AbortSignal,
) {
  const review = reviews.require(url);
  const root = await repositoryRoot(review.path, signal);
  const snapshot = await localSnapshot(root, review.baseRef, signal);
  await checkBranch(
    review,
    snapshot.meta.head,
    snapshot.meta.headBranch === 'HEAD' ? null : snapshot.meta.headBranch,
    signal,
  );
  return snapshot;
}
// The revision a refresh would load, without building the diff.
export async function localReviewRevision(
  reviews: SavedLocalReviews,
  url: string,
  signal: AbortSignal,
) {
  const review = reviews.require(url);
  const root = await repositoryRoot(review.path, signal);
  const state = await workingState(root, signal);
  const { mergeBase } = await resolveBase(root, review.baseRef, signal);
  await checkBranch(review, state.head, await currentBranch(root, signal), signal);
  return revisionId(mergeBase, state.head, state.digest);
}
export const pinnedRevision = (view: {
  revision: string;
  meta: { head: string; mergeBase?: string | null | undefined };
}): LocalRevision => ({
  revision: view.revision,
  head: view.meta.head,
  mergeBase: view.meta.mergeBase,
});
export function localReviewSource(reviews: SavedLocalReviews, url: string, pinned: LocalRevision) {
  return localSource(reviews.require(url).path, pinned);
}
