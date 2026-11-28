import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { localOperations, type LocalPlatform } from './local-operations.js';
import { reviewPublisher } from './publish.js';
import { openStore } from './store.js';

// The app passes the user's Git configuration through, so tests run with an empty home.
const home = mkdtempSync(join(tmpdir(), 'local-operations-home-'));
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
const write = (root: string, path: string, content: string) => {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), content);
};
function repository(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'local-operations-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '--quiet', '-b', 'main');
  write(root, 'src/app.ts', 'export const two = 2;\n');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'Start');
  git(root, 'checkout', '--quiet', '-b', 'topic');
  write(root, 'src/app.ts', 'export const two = 22;\n');
  git(root, 'commit', '--quiet', '-am', 'Change two');
  return root;
}
// Dialog and clipboard stand-ins. `saveAs` is the file the save dialog returns.
function platform(t: TestContext, folder: string) {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'local-operations-out-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const state = { saveAs: join(outside, 'review.md') as string | null, clipboard: '' };
  const shell: LocalPlatform = {
    documents: outside,
    signal: new AbortController().signal,
    chooseFolder: () => Promise.resolve(folder),
    chooseSaveFile: () => Promise.resolve(state.saveAs),
    writeClipboard: (text) => {
      state.clipboard = text;
      return Promise.resolve();
    },
  };
  return { shell, state, outside };
}
async function started(t: TestContext) {
  const root = repository(t);
  const store = openStore(':memory:');
  t.after(() => store.close());
  const { shell, state, outside } = platform(t, root);
  const operations = localOperations(store, shell);
  const candidate = await operations.choose();
  assert.ok(candidate);
  const { url } = await operations.start({ id: candidate.id, base: 'refs/heads/main' });
  store.reader.select(url);
  return { root, store, operations, state, outside, url, shell };
}

await test('adding a folder persists it once and allows a review without choosing it again', async (t) => {
  const root = repository(t);
  const { shell, outside } = platform(t, root);
  const dbFile = join(outside, 'workspace.sqlite');
  const initial = openStore(dbFile);
  try {
    const operations = localOperations(initial, shell);
    const folder = await operations.addFolder();
    assert.equal(folder?.path, root);
    await operations.addFolder();
    assert.deepEqual(initial.local.folders(), [folder]);
    assert.deepEqual(initial.list(), []);
  } finally {
    initial.close();
  }
  const reopened = openStore(dbFile);
  t.after(() => reopened.close());
  shell.chooseFolder = () => Promise.resolve(null);
  const operations = localOperations(reopened, shell);
  assert.equal(await operations.addFolder(), null);
  await assert.rejects(operations.choose(outside), /Add this local folder first/);
  const candidate = await operations.choose(root);
  assert.equal(candidate?.branch, 'topic');
  const started = await operations.start({ id: candidate?.id, base: 'refs/heads/main' });
  assert.equal(started.reviews[0]?.local?.path, root);
});

await test('a saved folder moved behind a symlink must be chosen again', async (t) => {
  const root = repository(t);
  const { shell, outside } = platform(t, root);
  const store = openStore(':memory:');
  t.after(() => store.close());
  const operations = localOperations(store, shell);
  await operations.addFolder();
  const candidate = await operations.choose(root);
  const moved = join(outside, 'moved');
  renameSync(root, moved);
  symlinkSync(moved, root, 'junction');
  await assert.rejects(
    operations.start({ id: candidate?.id, base: 'refs/heads/main' }),
    /current location/,
  );
  await assert.rejects(operations.choose(root), /current location/);
  assert.deepEqual(store.list(), []);
});

await test('starting refuses a clone that switched branches after it was chosen', async (t) => {
  const root = repository(t);
  const store = openStore(':memory:');
  t.after(() => store.close());
  const operations = localOperations(store, platform(t, root).shell);
  const candidate = await operations.choose();
  assert.equal(candidate?.branch, 'topic');
  git(root, 'checkout', '--quiet', '-b', 'other');
  await assert.rejects(
    operations.start({ id: candidate?.id, base: 'refs/heads/main' }),
    /switched branches/,
  );
  assert.deepEqual(store.list(), []);
  // The candidate is spent, so the reviewer chooses the folder again.
  await assert.rejects(
    operations.start({ id: candidate?.id, base: 'refs/heads/main' }),
    /Choose the repository folder again/,
  );
});

await test('the brief is copied and saved only as previewed', async (t) => {
  const { store, operations, state, outside, url } = await started(t);
  const preview = operations.brief(url);
  await operations.copy(url, preview.version, preview.revision);
  assert.equal(state.clipboard, preview.text);
  assert.equal(await operations.save(url, preview.version, preview.revision), true);
  assert.equal(readFileSync(join(outside, 'review.md'), 'utf8'), preview.text);
  await assert.rejects(
    operations.copy(url, preview.version, 'other...revision'),
    /another revision/,
  );
  reviewPublisher(store).edit(url, preview.version, {
    action: 'draft',
    id: null,
    body: 'Explain the new value.',
    target: { path: 'src/app.ts', hunk: 0, side: 'new', line: 1, revision: preview.revision },
  });
  await assert.rejects(operations.save(url, preview.version, preview.revision), /Drafts changed/);
  state.saveAs = null;
  const current = operations.brief(url);
  assert.equal(await operations.save(url, current.version, current.revision), false);
});

await test('saving refuses the reviewed repository and a symbolic link at the chosen name', async (t) => {
  const { root, operations, state, outside, url } = await started(t);
  const { version, revision } = operations.brief(url);
  for (const inside of [join(root, 'review.md'), join(root, 'src', 'review.md')]) {
    state.saveAs = inside;
    await assert.rejects(
      operations.save(url, version, revision),
      /outside the reviewed repository/,
    );
    assert.equal(existsSync(inside), false);
  }
  // A name that only starts with two dots is still inside.
  state.saveAs = join(root, '..review.md');
  await assert.rejects(operations.save(url, version, revision), /outside the reviewed repository/);
  const link = join(outside, 'linked.md');
  symlinkSync(join(root, 'src', 'app.ts'), link);
  state.saveAs = link;
  await assert.rejects(operations.save(url, version, revision), /could not be saved/);
  assert.equal(readFileSync(join(root, 'src', 'app.ts'), 'utf8'), 'export const two = 22;\n');
});

await test('export replaces only the selected file and rechecks the preview after the save dialog', async (t) => {
  const { store, operations, state, shell, outside, url } = await started(t);
  const { version, revision, text } = operations.brief(url);
  const original = join(outside, 'first.md');
  const selected = join(outside, 'second.md');
  writeFileSync(original, 'earlier brief');
  linkSync(original, selected);
  state.saveAs = selected;
  assert.equal(await operations.save(url, version, revision), true);
  assert.equal(readFileSync(original, 'utf8'), 'earlier brief');
  assert.equal(readFileSync(selected, 'utf8'), text);
  shell.chooseSaveFile = () => {
    store.reader.select(null);
    return Promise.resolve(original);
  };
  await assert.rejects(operations.save(url, version, revision), /Reopen this local review/);
  assert.equal(readFileSync(original, 'utf8'), 'earlier brief');
});
