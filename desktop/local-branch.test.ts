import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  addedFilePatch,
  insideFolder,
  inspectRepository,
  limits,
  LocalReviewError,
  localSnapshot,
  localSource,
  parseRawDiff,
  sectionMatches,
  StaleLocalRevision,
  truncatePatch,
  workingState,
  workingTreeFile,
} from './local-branch.js';

const signal = new AbortController().signal;
// The app passes the user's Git configuration through, so tests run with an empty home.
const home = mkdtempSync(join(tmpdir(), 'local-branch-home-'));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = home;
process.on('exit', () => rmSync(home, { recursive: true, force: true }));
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Agent',
  GIT_AUTHOR_EMAIL: 'agent@example.invalid',
  GIT_COMMITTER_NAME: 'Agent',
  GIT_COMMITTER_EMAIL: 'agent@example.invalid',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, env })
    .toString()
    .trim();
const write = (root: string, path: string, content: string | Buffer) => {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), content);
};
// A repository with `main` and a `topic` branch that changed one file in a commit.
function repository(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'local-branch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '--quiet', '-b', 'main');
  write(root, 'src/app.ts', 'export const one = 1;\nexport const two = 2;\n');
  write(root, 'README.md', 'Project\n');
  write(root, '.gitignore', 'build/\n');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'Start');
  git(root, 'checkout', '--quiet', '-b', 'topic');
  write(root, 'src/app.ts', 'export const one = 1;\nexport const two = 22;\n');
  git(root, 'commit', '--quiet', '-am', 'Change two');
  return root;
}
const fileAt = (snapshot: Awaited<ReturnType<typeof localSnapshot>>, path: string) => {
  const file = snapshot.files.find((f) => f.info.path === path);
  assert.ok(file, 'missing ' + path);
  return file;
};

await test('a committed change on a clean branch is keyed by its merge base and head', async (t) => {
  const root = repository(t);
  const snapshot = await localSnapshot(root, 'refs/heads/main', signal);
  const head = git(root, 'rev-parse', 'HEAD'),
    mergeBase = git(root, 'rev-parse', 'main');
  assert.equal(snapshot.revision, mergeBase + '...' + head);
  assert.equal(snapshot.dirty, false);
  assert.deepEqual(
    { ...snapshot.meta, description: undefined },
    {
      title: 'topic',
      author: snapshot.meta.author,
      description: undefined,
      totalFiles: 1,
      base: mergeBase,
      mergeBase,
      head,
      baseBranch: 'main',
      headBranch: 'topic',
    },
  );
  assert.ok(snapshot.meta.author);
  assert.match(snapshot.meta.description, /- Change two/);
  assert.doesNotMatch(snapshot.meta.description, /uncommitted/i);
  const file = fileAt(snapshot, 'src/app.ts');
  assert.deepEqual(file.info, {
    path: 'src/app.ts',
    previousPath: null,
    status: 'modified',
    additions: 1,
    deletions: 1,
    kind: 'text',
  });
  assert.equal(
    file.patch,
    '@@ -1,2 +1,2 @@\n export const one = 1;\n-export const two = 2;\n+export const two = 22;',
  );
  // Reading again without changes yields the same revision and fingerprints.
  const again = await localSnapshot(root, 'refs/heads/main', signal);
  assert.equal(again.revision, snapshot.revision);
  assert.deepEqual(again.files, snapshot.files);
});

await test('staged, unstaged and untracked work appears, and ignored files do not', async (t) => {
  const root = repository(t);
  write(root, 'README.md', 'Project\nStaged line\n');
  git(root, 'add', 'README.md');
  write(root, 'README.md', 'Project\nStaged line\nUnstaged line\n');
  write(root, 'notes/todo.txt', 'first\nsecond');
  write(root, 'build/output.js', 'ignored');
  const snapshot = await localSnapshot(root, 'refs/heads/main', signal);
  assert.equal(snapshot.dirty, true);
  assert.match(snapshot.revision, /^[0-9a-f]{40}\.\.\.[0-9a-f]{40}\+[0-9a-f]{12}$/);
  assert.match(snapshot.meta.description, /uncommitted changes/i);
  assert.deepEqual(
    snapshot.files.map((f) => f.info.path),
    ['README.md', 'notes/todo.txt', 'src/app.ts'],
  );
  assert.equal(
    fileAt(snapshot, 'README.md').patch,
    '@@ -1 +1,3 @@\n Project\n+Staged line\n+Unstaged line',
  );
  const untracked = fileAt(snapshot, 'notes/todo.txt');
  assert.equal(untracked.info.status, 'added');
  assert.equal(untracked.info.kind, 'text');
  assert.equal(untracked.info.additions, 2);
  assert.equal(untracked.patch, '@@ -0,0 +1,2 @@\n+first\n+second\n\\ No newline at end of file');
  // Reading leaves the index alone: the unstaged line is still unstaged.
  assert.equal(git(root, 'diff', '--name-only'), 'README.md');
  assert.equal(git(root, 'diff', '--cached', '--name-only'), 'README.md');
});

await test('renames, deletions and binary files map to their reader kinds', async (t) => {
  const root = repository(t);
  write(root, 'assets/logo.bin', Buffer.from([0, 1, 2, 3, 0, 255]));
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'Add logo');
  git(root, 'mv', 'README.md', 'GUIDE.md');
  unlinkSync(join(root, 'src/app.ts'));
  const snapshot = await localSnapshot(root, 'refs/heads/main', signal);
  const renamed = fileAt(snapshot, 'GUIDE.md');
  assert.equal(renamed.info.status, 'renamed');
  assert.equal(renamed.info.previousPath, 'README.md');
  assert.equal(renamed.info.kind, 'metadata');
  assert.equal(fileAt(snapshot, 'src/app.ts').info.status, 'removed');
  assert.equal(
    fileAt(snapshot, 'src/app.ts').patch,
    '@@ -1,2 +0,0 @@\n-export const one = 1;\n-export const two = 2;',
  );
  const binary = fileAt(snapshot, 'assets/logo.bin');
  assert.equal(binary.info.kind, 'binary');
  assert.equal(binary.patch, '');
  // Changing binary content changes both the revision and the file fingerprint.
  write(root, 'assets/logo.bin', Buffer.from([0, 9, 9, 9]));
  const changed = await localSnapshot(root, 'refs/heads/main', signal);
  assert.notEqual(changed.revision, snapshot.revision);
  assert.notEqual(fileAt(changed, 'assets/logo.bin').signature, binary.signature);
  assert.equal(fileAt(changed, 'GUIDE.md').signature, renamed.signature);
});

await test('the revision tracks the working tree content, not timestamps', async (t) => {
  const root = repository(t);
  const clean = await workingState(root, signal);
  assert.equal(clean.digest, null);
  write(root, 'src/app.ts', 'export const one = 1;\nexport const two = 23;\n');
  const dirty = await workingState(root, signal);
  assert.match(dirty.digest ?? '', /^[0-9a-f]{12}$/);
  write(root, 'scratch.txt', 'new');
  const untracked = await workingState(root, signal);
  assert.notEqual(untracked.digest, dirty.digest);
  unlinkSync(join(root, 'scratch.txt'));
  assert.equal((await workingState(root, signal)).digest, dirty.digest);
  write(root, 'src/app.ts', 'export const one = 1;\nexport const two = 22;\n');
  assert.deepEqual(await workingState(root, signal), clean);
});

await test('a detached HEAD is reviewed under its first commit subject', async (t) => {
  const root = repository(t);
  git(root, 'checkout', '--quiet', '--detach');
  const info = await inspectRepository(root, signal);
  assert.equal(info.branch, null);
  const snapshot = await localSnapshot(root, 'refs/heads/main', signal);
  assert.equal(snapshot.meta.headBranch, 'HEAD');
  assert.equal(snapshot.meta.title, 'Change two');
});

await test('inspection lists bases, prefers main, and explains unusable folders', async (t) => {
  const root = repository(t);
  const info = await inspectRepository(root, signal);
  assert.equal(info.repository, root.split('/').at(-1));
  assert.equal(info.branch, 'topic');
  assert.deepEqual(info.bases, [
    { ref: 'refs/heads/main', name: 'main' },
    { ref: 'refs/heads/topic', name: 'topic' },
  ]);
  assert.equal(info.defaultBase, 'refs/heads/main');
  await assert.rejects(inspectRepository(join(root, 'src'), signal), /top-level folder/);
  const plain = mkdtempSync(join(tmpdir(), 'not-a-repo-'));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  await assert.rejects(inspectRepository(plain, signal), /not a Git repository/);
  const empty = join(plain, 'empty');
  mkdirSync(empty);
  git(empty, 'init', '--quiet');
  await assert.rejects(inspectRepository(empty, signal), /no commits/);
  await assert.rejects(inspectRepository(join(plain, 'missing'), signal), /existing folder/);
});

await test('a missing base branch is reported before anything is read', async (t) => {
  const root = repository(t);
  await assert.rejects(localSnapshot(root, 'refs/heads/gone', signal), (error: unknown) => {
    assert.ok(error instanceof LocalReviewError);
    assert.match(error.message, /base branch gone was not found/);
    return true;
  });
  await assert.rejects(localSnapshot(root, '--output=/tmp/x', signal), /was not found/);
});

await test('oversized patches and file lists are labelled instead of failing', async (t) => {
  const root = repository(t);
  const saved = { ...limits };
  t.after(() => Object.assign(limits, saved));
  write(root, 'big.txt', Array.from({ length: 400 }, (_, i) => 'line ' + i).join('\n') + '\n');
  write(root, 'z1.txt', 'a\n');
  write(root, 'z2.txt', 'b\n');
  limits.filePatch = 1000;
  limits.files = 3;
  const snapshot = await localSnapshot(root, 'refs/heads/main', signal);
  assert.equal(snapshot.meta.totalFiles, 4);
  assert.equal(snapshot.files.length, 3);
  const big = fileAt(snapshot, 'big.txt');
  assert.equal(big.info.kind, 'partial');
  assert.ok(Buffer.byteLength(big.patch) <= 1000);
  const shown = /^@@ -0,0 \+1,(\d+) @@\n\+line 0\n/.exec(big.patch);
  assert.ok(shown && Number(shown[1]) < 400);
  assert.equal(big.info.additions, Number(shown[1]));
});

await test('source reads follow the pinned revision and refuse a changed working tree', async (t) => {
  const root = repository(t);
  write(root, 'src/app.ts', 'export const one = 1;\nexport const two = 23;\n');
  const snapshot = await localSnapshot(root, 'refs/heads/main', signal);
  const pinned = {
    revision: snapshot.revision,
    head: snapshot.meta.head,
    mergeBase: snapshot.meta.mergeBase,
  };
  const source = localSource(root, pinned);
  const file = fileAt(snapshot, 'src/app.ts').info;
  assert.equal(
    await source.fullFile(file, signal),
    '@@ -1,2 +1,2 @@\n export const one = 1;\n-export const two = 2;\n+export const two = 23;',
  );
  assert.equal(
    await source.text(snapshot.meta.head, 'src/app.ts', signal, 'head'),
    'export const one = 1;\nexport const two = 23;\n',
  );
  assert.equal(
    await source.text(pinned.mergeBase ?? '', 'src/app.ts', signal, 'before'),
    'export const one = 1;\nexport const two = 2;\n',
  );
  const found = await source.find(snapshot.meta.head, 'two = 23', 0, signal, 'head');
  assert.deepEqual(found.paths, ['src/app.ts']);
  const page = await source.read(snapshot.meta.head, 'src/app.ts', 2, signal, undefined, 'head');
  assert.deepEqual('lines' in page && page.lines, [{ line: 2, text: 'export const two = 23;' }]);
  // The agent keeps editing: uncommitted content no longer matches the reviewed revision.
  write(root, 'src/app.ts', 'export const one = 1;\nexport const two = 24;\n');
  await assert.rejects(source.fullFile(file, signal), StaleLocalRevision);
  await assert.rejects(source.text(snapshot.meta.head, 'src/app.ts', signal), StaleLocalRevision);
  const stale = await source.read(snapshot.meta.head, 'src/app.ts', 1, signal, undefined, 'head');
  assert.match(String('unavailable' in stale && stale.unavailable), /working tree changed/);
  // A clean revision is read from its commit, whatever the working tree holds now.
  const committed = localSource(root, {
    revision: pinned.mergeBase + '...' + snapshot.meta.head,
    head: snapshot.meta.head,
    mergeBase: pinned.mergeBase,
  });
  assert.equal(
    await committed.text(snapshot.meta.head, 'src/app.ts', signal),
    'export const one = 1;\nexport const two = 22;\n',
  );
});

await test('working tree reads stay inside the repository', async (t) => {
  const root = repository(t);
  const outside = mkdtempSync(join(tmpdir(), 'outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'secret.txt'), 'secret');
  symlinkSync(join(outside, 'secret.txt'), join(root, 'escape.txt'));
  symlinkSync('README.md', join(root, 'inside.txt'));
  const { realpathSync } = await import('node:fs');
  const real = realpathSync(root);
  for (const path of [
    '../outside/secret.txt',
    '/etc/hosts',
    'src/../../x',
    '.git/config',
    '.GIT/config',
  ])
    await assert.rejects(workingTreeFile(real, path, signal), /outside the repository/);
  await assert.rejects(workingTreeFile(real, 'escape.txt', signal), /links outside/);
  assert.equal(await workingTreeFile(real, 'inside.txt', signal), 'Project\n');
  write(root, 'blob.bin', Buffer.from([1, 0, 2]));
  await assert.rejects(workingTreeFile(real, 'blob.bin', signal), /Binary file/);
  // A link to Git's own files, and ignored files such as local secrets, are not served.
  symlinkSync('.git/config', join(root, 'config-link'));
  await assert.rejects(workingTreeFile(real, 'config-link', signal), /outside the repository/);
  write(root, 'build/.env', 'SECRET=1\n');
  symlinkSync('build/.env', join(root, 'env-link'));
  await assert.rejects(workingTreeFile(real, 'build/.env', signal), /ignored/);
  await assert.rejects(workingTreeFile(real, 'env-link', signal), /ignored/);
  // A name that starts with two dots is inside the folder; a parent path is not.
  assert.ok(insideFolder(real, join(real, '..review.md')));
  assert.ok(insideFolder(real, join(real, 'notes', 'review.md')));
  assert.ok(!insideFolder(real, join(real, '..', 'review.md')));
  assert.ok(!insideFolder(real, join(outside, 'review.md')));
});

await test('Git filters configured for the repository never run', async (t) => {
  const root = repository(t);
  const marker = join(root, '..', 'filter-ran-' + Date.now());
  t.after(() => rmSync(marker, { force: true }));
  write(root, '.gitattributes', '*.txt filter=probe\n');
  write(root, 'notes.txt', 'one\n');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'Notes');
  git(root, 'config', 'filter.probe.clean', 'touch "' + marker + '"; cat');
  git(root, 'config', 'filter.probe.process', 'touch "' + marker + '"');
  git(root, 'config', 'filter.probe.required', 'true');
  write(root, 'notes.txt', 'one\ntwo\n');
  const snapshot = await localSnapshot(root, 'refs/heads/main', signal);
  assert.equal(fileAt(snapshot, 'notes.txt').info.kind, 'text');
  const source = localSource(root, {
    revision: snapshot.revision,
    head: snapshot.meta.head,
    mergeBase: snapshot.meta.mergeBase,
  });
  const info = fileAt(snapshot, 'notes.txt').info;
  assert.match(await source.fullFile(info, signal), /\+two/);
  await source.find(snapshot.meta.head, 'two', 0, signal);
  assert.equal(existsSync(marker), false);
});

// Every file under `.git` with its bytes, to show that reading changed nothing there.
function gitDirectoryState(root: string) {
  const entries: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const info = lstatSync(path);
      if (info.isDirectory()) walk(path);
      else
        entries.push(
          path.slice(root.length) +
            ':' +
            createHash('sha256').update(readFileSync(path)).digest('hex'),
        );
    }
  };
  walk(join(root, '.git'));
  return entries;
}

await test('reading a stat-dirty working tree leaves the repository index and .git untouched', async (t) => {
  const root = repository(t);
  write(root, 'notes.txt', 'draft\n');
  write(root, 'README.md', 'Project\nMore\n');
  // Same content, newer timestamps: Git would refresh the index for these.
  const later = new Date(Date.now() + 60_000);
  for (const path of ['src/app.ts', '.gitignore']) utimesSync(join(root, path), later, later);
  const before = gitDirectoryState(root);
  const snapshot = await localSnapshot(root, 'refs/heads/main', signal);
  await workingState(root, signal);
  const source = localSource(root, {
    revision: snapshot.revision,
    head: snapshot.meta.head,
    mergeBase: snapshot.meta.mergeBase,
  });
  await source.fullFile(fileAt(snapshot, 'README.md').info, signal);
  await source.fullFile(fileAt(snapshot, 'src/app.ts').info, signal);
  await source.find(snapshot.meta.head, 'Project', 0, signal);
  await source.text(snapshot.meta.head, 'notes.txt', signal);
  assert.deepEqual(gitDirectoryState(root), before);
  assert.deepEqual(
    snapshot.files.map((f) => [f.info.path, f.info.kind]),
    [
      ['README.md', 'text'],
      ['notes.txt', 'text'],
      ['src/app.ts', 'text'],
    ],
  );
});

await test('a partial clone is never fetched into and missing contents are labelled', async (t) => {
  const origin = repository(t);
  git(origin, 'config', 'uploadpack.allowFilter', 'true');
  const clone = join(mkdtempSync(join(tmpdir(), 'local-partial-')), 'clone');
  t.after(() => rmSync(join(clone, '..'), { recursive: true, force: true }));
  git(
    tmpdir(),
    'clone',
    '--quiet',
    '--filter=blob:none',
    '--branch',
    'topic',
    'file://' + origin,
    clone,
  );
  const before = gitDirectoryState(clone);
  const snapshot = await localSnapshot(clone, 'refs/remotes/origin/main', signal);
  assert.equal(fileAt(snapshot, 'src/app.ts').info.kind, 'unavailable');
  assert.match(snapshot.meta.description, /partial clone/);
  const source = localSource(clone, {
    revision: snapshot.revision,
    head: snapshot.meta.head,
    mergeBase: snapshot.meta.mergeBase,
  });
  const read = await source.read(
    snapshot.meta.mergeBase ?? '',
    'src/app.ts',
    1,
    signal,
    undefined,
    'before',
  );
  assert.match(String('unavailable' in read && read.unavailable), /partial clone/);
  // The head side was checked out, so it is still readable.
  assert.match(await source.text(snapshot.meta.head, 'src/app.ts', signal), /two = 22/);
  assert.deepEqual(gitDirectoryState(clone), before);
});

await test('a filter configured inside a submodule does not run, and its commit still shows', async (t) => {
  const root = repository(t);
  const sub = mkdtempSync(join(tmpdir(), 'local-sub-'));
  t.after(() => rmSync(sub, { recursive: true, force: true }));
  git(sub, 'init', '--quiet', '-b', 'main');
  write(sub, '.gitattributes', '*.txt filter=sp\n');
  write(sub, 'notes.txt', 'abc\n');
  git(sub, 'add', '.');
  git(sub, 'commit', '--quiet', '-m', 'Sub');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', sub, 'sub');
  git(root, 'commit', '--quiet', '-m', 'Add submodule');
  git(root, 'branch', 'with-sub');
  const marker = join(sub, '..', 'sub-filter-ran-' + Date.now());
  t.after(() => rmSync(marker, { force: true }));
  const inner = join(root, 'sub');
  git(inner, 'config', 'filter.sp.clean', 'touch "' + marker + '"; cat');
  write(inner, 'notes.txt', 'xyz\n');
  await localSnapshot(root, 'refs/heads/with-sub', signal);
  await workingState(root, signal);
  assert.equal(existsSync(marker), false);
  git(inner, 'config', '--unset', 'filter.sp.clean');
  git(inner, 'commit', '--quiet', '-am', 'Sub change');
  const moved = await localSnapshot(root, 'refs/heads/with-sub', signal);
  assert.ok(moved.files.some((f) => f.info.path === 'sub'));
});

await test('a file replaced by a symbolic link stays paired with its patch', async (t) => {
  const root = repository(t);
  write(root, 'a.txt', 'a\n');
  write(root, 'b.txt', 'b\n');
  write(root, 'c.txt', 'c\n');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'Letters');
  git(root, 'branch', 'letters');
  unlinkSync(join(root, 'a.txt'));
  symlinkSync('README.md', join(root, 'a.txt'));
  write(root, 'b.txt', 'b\nb2\n');
  write(root, 'c.txt', 'c\nc2\n');
  const snapshot = await localSnapshot(root, 'refs/heads/letters', signal);
  const changed = fileAt(snapshot, 'a.txt');
  assert.equal(changed.info.kind, 'text');
  assert.equal(changed.patch, '@@ -1 +1 @@\n-a\n+README.md\n\\ No newline at end of file');
  for (const path of ['b.txt', 'c.txt']) assert.equal(fileAt(snapshot, path).info.kind, 'text');
});

await test('a moved file without git mv appears as a deletion and an addition', async (t) => {
  const root = repository(t);
  renameSync(join(root, 'README.md'), join(root, 'GUIDE.md'));
  const snapshot = await localSnapshot(root, 'refs/heads/main', signal);
  assert.equal(fileAt(snapshot, 'README.md').info.status, 'removed');
  assert.equal(fileAt(snapshot, 'GUIDE.md').info.status, 'added');
});

await test('git output helpers parse quoted paths, renames and new-file hunks', () => {
  const zero = '0'.repeat(40),
    blob = 'a'.repeat(40);
  assert.deepEqual(
    parseRawDiff(
      `:100644 100644 ${blob} ${zero} M\0src/a.ts\0:100644 100644 ${blob} ${zero} R091\0old.ts\0new.ts\0:000000 100644 ${zero} ${zero} A\0café.ts\0`,
    ),
    [
      {
        status: 'modified',
        path: 'src/a.ts',
        previousPath: null,
        oldBlob: blob,
        typeChange: false,
      },
      {
        status: 'renamed',
        path: 'new.ts',
        previousPath: 'old.ts',
        oldBlob: blob,
        typeChange: false,
      },
      { status: 'added', path: 'café.ts', previousPath: null, oldBlob: zero, typeChange: false },
    ],
  );
  assert.ok(
    sectionMatches('diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"\nnew file mode', {
      path: 'café.ts',
      previousPath: null,
    }),
  );
  assert.ok(!sectionMatches('diff --git a/x b/y', { path: 'y', previousPath: null }));
  assert.equal(addedFilePatch('one\n'), '@@ -0,0 +1 @@\n+one');
  assert.equal(addedFilePatch(''), '');
  const patch = '@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@\n-c\n+d';
  assert.deepEqual(truncatePatch(patch, 1000), { patch, truncated: false });
  assert.deepEqual(truncatePatch(patch, 20), { patch: '@@ -1 +1 @@\n-a\n+b', truncated: true });
});
