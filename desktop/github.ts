import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { pullRequestUrl } from '../shared/reviews.js';
import type { FileInfo, ReviewMeta } from '../shared/reader.js';

const run = promisify(execFile);
const ref = z.object({ sha: z.string(), ref: z.string() });
const pr = z.object({
  title: z.string(),
  body: z.string().nullable(),
  user: z.object({ login: z.string() }).nullable(),
  base: ref,
  head: ref,
  changed_files: z.number().int().nonnegative(),
});
const entry = z.object({
  filename: z.string(),
  previous_filename: z.string().optional(),
  status: z.string(),
  sha: z.string().nullable(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string().nullish(),
});
type Entry = z.infer<typeof entry>;
export type SnapshotFile = { info: FileInfo; patch: string; signature: string };
export type Snapshot = { meta: ReviewMeta; revision: string; files: SnapshotFile[] };
type Api = (endpoint: string, signal: AbortSignal, diff?: boolean) => Promise<string>;

export function githubEnvironment() {
  return {
    ...process.env,
    PATH:
      process.platform === 'darwin'
        ? [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(':')
        : process.env.PATH,
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
  };
}

export const githubApi: Api = (endpoint, signal, diff) =>
  apiRequest(endpoint, signal, githubEnvironment(), diff);
function apiRequest(
  endpoint: string,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
  diff?: boolean,
  headers = false,
) {
  const args = ['api', '--hostname', 'github.com', endpoint];
  if (headers) args.push('--include');
  if (diff) args.push('-H', 'Accept: application/vnd.github.diff');
  return runGh(args, signal, env);
}
export type Graphql = (
  query: string,
  variables: Record<string, string>,
  signal: AbortSignal,
) => Promise<string>;
// Variables travel as raw string fields, so gh never reads a value as a file or a number.
const graphqlArgs = (query: string, variables: Record<string, string>) => [
  'api',
  'graphql',
  '--hostname',
  'github.com',
  '-f',
  'query=' + query,
  ...Object.entries(variables).flatMap(([name, value]) => ['-f', name + '=' + value]),
];
export const githubGraphql: Graphql = (query, variables, signal) =>
  runGh(graphqlArgs(query, variables), signal, githubEnvironment());
async function runGh(args: string[], signal: AbortSignal, env: NodeJS.ProcessEnv) {
  try {
    const result = await run('gh', args, {
      signal,
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024,
      env,
    });
    return result.stdout;
  } catch (error) {
    signal.throwIfAborted();
    const details = z
      .object({ code: z.union([z.string(), z.number()]).optional(), stderr: z.string().optional() })
      .safeParse(error).data;
    if (details?.code === 'ENOENT')
      throw new Error('Install GitHub CLI (gh) and reopen Local Reviewer.', { cause: error });
    const reason = details?.stderr ?? '';
    if (/auth login|HTTP 401|authentication token/i.test(reason))
      throw new Error('Sign in with gh auth login, then retry.', { cause: error });
    if (/rate limit/i.test(reason))
      throw new Error('GitHub rate limit reached. Retry after the limit resets.', { cause: error });
    if (/HTTP (403|404)/i.test(reason))
      throw new Error('GitHub could not open this PR. Check the URL and your gh account access.', {
        cause: error,
      });
    if (details?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
      throw new Error('This GitHub response exceeds the local size limit.', { cause: error });
    throw new Error('Could not reach GitHub. Check your connection and retry.', { cause: error });
  }
}
export class UnconfirmedReply extends Error {}

export async function replySession(signal: AbortSignal) {
  const env: NodeJS.ProcessEnv = githubEnvironment();
  // Bind every page of a sweep to one credential. The credential stays in process
  // memory and child environments, never in argv, SQLite, IPC or diagnostics.
  if (!env.GH_TOKEN && !env.GITHUB_TOKEN) {
    let missingCli = false;
    try {
      const token = await run('gh', ['auth', 'token', '--hostname', 'github.com'], {
        signal,
        env,
        timeout: 10000,
        maxBuffer: 16384,
      });
      env.GH_TOKEN = token.stdout.trim();
    } catch (e) {
      signal.throwIfAborted();
      // A subprocess error can include token output. Retain only the missing-executable flag.
      missingCli = z.object({ code: z.literal('ENOENT') }).safeParse(e).success;
    }
    if (missingCli) throw Error('Install GitHub CLI to connect an account.');
    if (!env.GH_TOKEN) throw Error('Connect your GitHub account in Settings.');
  }
  const response = await apiRequest('user', signal, env, false, true);
  const separator = /\r?\n\r?\n/.exec(response);
  if (!separator) throw Error('GitHub did not return a server time. Retry the reply check.');
  const stamp = /^date:\s*(.+)$/im.exec(response.slice(0, separator.index))?.[1];
  const serverTime = Date.parse(stamp ?? '');
  if (!Number.isFinite(serverTime)) throw Error('GitHub did not return a valid server time.');
  const { login } = z
    .object({ login: z.string().min(1) })
    .parse(JSON.parse(response.slice(separator.index + separator[0].length)));
  const api: Api = (endpoint, signal) => apiRequest(endpoint, signal, env);
  function postComment(endpoint: string, body: string, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        'gh',
        ['api', '--hostname', 'github.com', '--method', 'POST', endpoint, '--input', '-'],
        { signal, env, timeout: 30000, maxBuffer: 2 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (!error) return resolve(stdout);
          const status = /\(HTTP (4\d\d)\)/.exec(stderr)?.[1];
          reject(
            status
              ? Error(
                  'GitHub rejected this reply (HTTP ' +
                    status +
                    '). Check the thread and your account permissions.',
                )
              : new UnconfirmedReply(
                  'GitHub did not confirm the reply. Refresh the discussion and check before posting again.',
                ),
          );
        },
      );
      child.stdin?.on('error', () => {
        /* The exit callback reports the request outcome. */
      });
      child.stdin?.end(JSON.stringify({ body }));
    });
  }
  const graphql: Graphql = (query, variables, signal) =>
    runGh(graphqlArgs(query, variables), signal, env);
  return { actor: login.toLowerCase(), serverTime, api, postComment, graphql };
}

function completePatch(patch: string, file: Entry) {
  if (!patch.startsWith('@@ ')) return false;
  let added = 0,
    removed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+')) added++;
    if (line.startsWith('-')) removed++;
  }
  return added === file.additions && removed === file.deletions;
}

// Git surrounds non-ASCII and control bytes with C-style quotes in raw diff headers.
function gitPath(path: string) {
  const escapes: Record<number, string> = {
    7: 'a',
    8: 'b',
    9: 't',
    10: 'n',
    11: 'v',
    12: 'f',
    13: 'r',
    34: '"',
    92: '\\',
  };
  let quoted = '';
  for (const byte of Buffer.from(path)) {
    if (escapes[byte]) quoted += '\\' + escapes[byte];
    else if (byte < 32 || byte >= 127) quoted += '\\' + byte.toString(8).padStart(3, '0');
    else quoted += String.fromCharCode(byte);
  }
  return quoted === path ? path : '"' + quoted + '"';
}

function findRawFiles(diff: string, files: Entry[]) {
  const headers = new Map<string, string>();
  for (const file of files) {
    const before = 'a/' + (file.previous_filename ?? file.filename),
      after = 'b/' + file.filename;
    headers.set('diff --git ' + gitPath(before) + ' ' + gitPath(after), file.filename);
    headers.set('diff --git ' + before + ' ' + after, file.filename);
  }
  const bodies = new Map<string, string>();
  for (const part of diff.split(/\n(?=diff --git )/)) {
    const end = part.indexOf('\n');
    const path = headers.get(part.slice(0, end));
    if (path) bodies.set(path, part.slice(end + 1));
  }
  return bodies;
}

function makeFile(file: Entry, raw: string | undefined): SnapshotFile {
  const rawHunk = raw?.match(/^@@ [\s\S]*/m)?.[0];
  const patch = rawHunk ?? file.patch ?? '';
  let kind: FileInfo['kind'];
  if (patch.startsWith('@@ ')) kind = completePatch(patch, file) ? 'text' : 'partial';
  else if (raw && /^(Binary files |GIT binary patch$)/m.test(raw)) kind = 'binary';
  else if (raw && file.additions === 0 && file.deletions === 0) kind = 'metadata';
  else kind = 'unavailable';
  const info = {
    path: file.filename,
    previousPath: file.previous_filename ?? null,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    kind,
  };
  const signature = createHash('sha256')
    .update(
      JSON.stringify(
        kind === 'binary' || kind === 'metadata' ? [info, file.sha, raw] : [info, file.sha, patch],
      ),
    )
    .digest('hex');
  return { info, patch, signature };
}

export async function fetchSnapshot(
  url: string,
  signal: AbortSignal,
  api: Api = githubApi,
): Promise<Snapshot> {
  const [owner, repo, , number] = new URL(pullRequestUrl.parse(url)).pathname.slice(1).split('/');
  const endpoint = `repos/${owner}/${repo}/pulls/${number}`;
  const readMeta = async () => pr.parse(JSON.parse(await api(endpoint, signal)));
  const start = await readMeta();
  const entries: Entry[] = [];
  let bytes = 0;
  for (let page = 1; entries.length < Math.min(start.changed_files, 3000); page++) {
    const json = await api(endpoint + '/files?per_page=100&page=' + page, signal);
    bytes += Buffer.byteLength(json);
    if (bytes > 64 * 1024 * 1024) throw new Error('This PR exceeds the local snapshot size limit.');
    const items = z.array(entry).parse(JSON.parse(json));
    entries.push(...items);
    if (items.length < 100) break;
  }
  const missing = entries.filter((file) => !completePatch(file.patch ?? '', file));
  let raw = new Map<string, string>();
  if (missing.length) {
    try {
      raw = findRawFiles(await api(endpoint, signal, true), missing);
    } catch {
      signal.throwIfAborted();
    } // Individual files will show their available coverage.
  }
  let mergeBase: string | null = null;
  try {
    const result = comparisonResponse.parse(
      JSON.parse(await api(compareEndpoint(url, start.base.sha, start.head.sha), signal)),
    );
    mergeBase = result.merge_base_commit.sha;
  } catch {
    signal.throwIfAborted();
  }
  const end = await readMeta();
  if (
    start.head.sha !== end.head.sha ||
    start.base.sha !== end.base.sha ||
    start.base.ref !== end.base.ref ||
    start.changed_files !== end.changed_files ||
    new Set(entries.map((f) => f.filename)).size !== entries.length
  ) {
    throw new Error('The PR changed during the fetch. Retry to load the new revision.');
  }
  return {
    meta: {
      title: end.title,
      author: end.user?.login ?? 'Unknown author',
      description: end.body ?? '',
      base: end.base.sha,
      mergeBase,
      head: end.head.sha,
      baseBranch: end.base.ref,
      headBranch: end.head.ref,
      totalFiles: end.changed_files,
    },
    revision: end.base.sha + '...' + end.head.sha,
    files: entries.map((file) => makeFile(file, raw.get(file.filename))),
  };
}

const comparisonResponse = z.object({
  status: z.enum(['ahead', 'behind', 'diverged', 'identical']),
  merge_base_commit: z.object({ sha: z.string() }),
  files: entry.array().optional(),
});
export type HeadComparison = {
  ancestry: 'ahead' | 'rewritten' | 'same' | 'unknown';
  files: { path: string; patch: string | null }[];
  partial: boolean;
};
function repoEndpoint(url: string) {
  return (
    'repos/' + new URL(pullRequestUrl.parse(url)).pathname.slice(1).split('/').slice(0, 2).join('/')
  );
}
function compareEndpoint(url: string, from: string, to: string) {
  return (
    repoEndpoint(url) +
    '/compare/' +
    encodeURIComponent(from) +
    '...' +
    encodeURIComponent(to) +
    '?per_page=1'
  );
}
export async function compareHeads(
  url: string,
  from: string,
  to: string,
  signal: AbortSignal,
  api: Api = githubApi,
): Promise<HeadComparison> {
  if (from === to) return { ancestry: 'same', files: [], partial: false };
  try {
    const result = comparisonResponse.parse(
      JSON.parse(await api(compareEndpoint(url, from, to), signal)),
    );
    // GitHub returns a merge-base diff for diverged commits. Only a fast-forward is a direct head-to-head patch.
    if (result.status !== 'ahead' || result.merge_base_commit.sha !== from)
      return { ancestry: 'rewritten', files: [], partial: false };
    const files = result.files ?? [];
    return {
      ancestry: 'ahead',
      partial: !result.files || files.length >= 300,
      files: files.map((f) => ({
        path: f.filename,
        patch: completePatch(f.patch ?? '', f) ? (f.patch ?? null) : null,
      })),
    };
  } catch {
    signal.throwIfAborted();
    return { ancestry: 'unknown', files: [], partial: true };
  }
}

type ProbeRequest = (args: string[], signal: AbortSignal) => Promise<{ stdout: string }>;
const probeRequest: ProbeRequest = (args, signal) =>
  run('gh', args, {
    signal,
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
    env: githubEnvironment(),
  });
const notModified = /^HTTP\/\S+ 304\b/;

export async function probeRevision(
  url: string,
  signal: AbortSignal,
  etag?: string,
  request: ProbeRequest = probeRequest,
) {
  const endpoint =
    'repos/' + new URL(pullRequestUrl.parse(url)).pathname.slice(1).replace('/pull/', '/pulls/');
  const args = ['api', '--hostname', 'github.com', '--include', endpoint];
  if (etag) args.push('-H', 'If-None-Match: ' + etag);
  let stdout: string;
  try {
    ({ stdout } = await request(args, signal));
  } catch (error) {
    signal.throwIfAborted();
    // gh exits non-zero for 304 Not Modified but still prints the response status line.
    const printed = z.object({ stdout: z.string() }).safeParse(error).data?.stdout;
    if (printed === undefined || !notModified.test(printed)) throw error;
    return null;
  }
  if (notModified.test(stdout)) return null;
  const boundary = /\r?\n\r?\n/.exec(stdout);
  const headers = boundary ? stdout.slice(0, boundary.index) : '';
  const body = boundary ? stdout.slice(boundary.index + boundary[0].length) : stdout;
  const result = pr.parse(JSON.parse(body));
  return {
    baseBranch: result.base.ref,
    revision: result.base.sha + '...' + result.head.sha,
    etag: /^etag:\s*(.+)$/im.exec(headers)?.[1]?.trim(),
  };
}
