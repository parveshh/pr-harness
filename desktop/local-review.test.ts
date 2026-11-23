import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { localReviewBrief, inlineCode, type BriefInput } from '../shared/local.js';
import { bundleKey, draftKey, publishKey, type Draft } from '../shared/publish.js';
import { discussionReply } from '../shared/discussions.js';
import { lessonKey } from '../shared/lessons.js';
import { attemptKey } from '../shared/failure.js';
import { chatRequest } from '../shared/assistant.js';
import { fileKey, shortRevision } from '../shared/reader.js';
import { isLocalReview, pullRequestUrl, reviewKey } from '../shared/reviews.js';
import { localReviewRevision, localReviewSnapshot } from './local-branch.js';
import { reviewPublisher } from './publish.js';
import { openStore } from './store.js';
import { ensureLocalReviewSchema } from './local-store.js';

const signal = new AbortController().signal;
// The app passes the user's Git configuration through, so tests run with an empty home.
const home = mkdtempSync(join(tmpdir(), 'local-review-home-'));
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
  const root = mkdtempSync(join(tmpdir(), 'local-review-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '--quiet', '-b', 'main');
  write(root, 'src/app.ts', 'export const one = 1;\nexport const two = 2;\n');
  write(root, 'README.md', 'Project\n');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'Start');
  git(root, 'checkout', '--quiet', '-b', 'topic');
  write(root, 'src/app.ts', 'export const one = 1;\nexport const two = 22;\n');
  write(root, 'README.md', 'Project\nNotes\n');
  git(root, 'commit', '--quiet', '-am', 'Change two');
  return root;
}
const github = 'https://github.com/octo/project/pull/7';

// The table and reply tracking as they stood at user_version 15.
const version15 = `DROP TABLE local_reviews;
DROP VIEW tracked_pulls;
CREATE VIEW tracked_pulls AS SELECT url FROM saved_reviews UNION SELECT 'https://github.com/'||name||'/pull/'||json_extract(p.value,'$.number') FROM repositories,json_each(pulls) p,json_each(watching) w WHERE json_extract(p.value,'$.author')=w.value;
DROP TRIGGER track_saved;
CREATE TRIGGER track_saved AFTER INSERT ON saved_reviews BEGIN INSERT OR IGNORE INTO reply_targets VALUES(NEW.url,NEW.saved_at); END;
PRAGMA user_version=15;`;

await test('version 15 workspaces gain local reviews and keep their saved PRs, drafts and reply targets', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'local-migration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'workspace.sqlite');
  const first = openStore(path);
  const saved = first.save(github);
  first.drafts.write(github, 0, {
    ...first.drafts.get(github),
    summary: 'Keep me',
  });
  first.close();
  const legacy = new DatabaseSync(path);
  legacy.exec(version15);
  legacy.close();
  const upgraded = openStore(path);
  t.after(() => upgraded.close());
  assert.deepEqual(upgraded.list(), saved);
  assert.equal(upgraded.drafts.get(github).summary, 'Keep me');
  assert.deepEqual(
    upgraded.replies.targets().map((r) => r.url),
    [github],
  );
  const url = upgraded.local.save({
    path: '/work/project',
    baseRef: 'refs/heads/main',
    baseName: 'main',
    repository: 'project',
    branch: 'topic',
    detached: null,
  });
  assert.ok(isLocalReview(url));
  // A local review is listed with its folder name and branch, but never becomes a GitHub reply target.
  assert.deepEqual(upgraded.list().find((r) => r.url === url)?.local, {
    repository: 'project',
    branch: 'topic',
    baseBranch: 'main',
    path: '/work/project',
  });
  assert.deepEqual(
    upgraded.replies.targets().map((r) => r.url),
    [github],
  );
  // Reopening the same branch and base continues the same review.
  assert.equal(
    upgraded.local.save({
      path: '/work/project',
      baseRef: 'refs/heads/main',
      baseName: 'main',
      repository: 'project',
      branch: 'topic',
      detached: null,
    }),
    url,
  );
  const reopened = new DatabaseSync(path);
  t.after(() => reopened.close());
  assert.equal(reopened.prepare('PRAGMA user_version').get()?.user_version, 17);
});

await test('a version 16 workspace without the local table still opens and gains it', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'local-v16-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'workspace.sqlite');
  const first = openStore(path);
  first.save(github);
  first.close();
  // Another build reached version 16 without local reviews and with the old reply tracking.
  const other = new DatabaseSync(path);
  other.exec(version15.replace('PRAGMA user_version=15;', 'PRAGMA user_version=16;'));
  other.close();
  const reopened = openStore(path);
  t.after(() => reopened.close());
  assert.deepEqual(
    reopened.list().map((r) => r.url),
    [github],
  );
  const url = reopened.local.save({
    path: '/work/project',
    baseRef: 'refs/heads/main',
    baseName: 'main',
    repository: 'project',
    branch: 'topic',
    detached: null,
  });
  assert.ok(reopened.local.get(url));
  assert.deepEqual(
    reopened.replies.targets().map((r) => r.url),
    [github],
  );
  // A table from before the detached column gains it.
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(
    'CREATE TABLE saved_reviews (url TEXT PRIMARY KEY, saved_at TEXT NOT NULL) STRICT; CREATE TABLE local_reviews (url TEXT PRIMARY KEY, repo_path TEXT NOT NULL, base_ref TEXT NOT NULL, base_name TEXT NOT NULL, repository TEXT NOT NULL, branch TEXT, created TEXT NOT NULL) STRICT;',
  );
  ensureLocalReviewSchema(db);
  assert.ok(
    db
      .prepare("SELECT name FROM pragma_table_info('local_reviews')")
      .all()
      .some((c) => c.name === 'detached'),
  );
});

await test('each detached commit is its own review, which follows commits made on top of it', async (t) => {
  const root = repository(t);
  const store = openStore(':memory:');
  t.after(() => store.close());
  const first = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '--quiet', '--detach');
  const review = (detached: string) =>
    store.local.save({
      path: root,
      baseRef: 'refs/heads/main',
      baseName: 'main',
      repository: 'project',
      branch: null,
      detached,
    });
  const url = review(first);
  assert.equal(review(first), url);
  write(root, 'README.md', 'Project\nNotes\nDetached\n');
  git(root, 'commit', '--quiet', '-am', 'On top');
  const descendant = git(root, 'rev-parse', 'HEAD');
  assert.notEqual(review(descendant), url);
  // The first review keeps following the detached HEAD while it descends from its commit.
  assert.equal((await localReviewSnapshot(store.local, url, signal)).meta.head, descendant);
  git(root, 'checkout', '--quiet', '--detach', 'main');
  await assert.rejects(localReviewSnapshot(store.local, url, signal), /different detached commit/);
  await assert.rejects(localReviewRevision(store.local, url, signal), /different detached commit/);
});

await test('shared review operations accept a local key and GitHub-only ones reject it', (t) => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const url = store.local.save({
    path: '/work/project',
    baseRef: 'refs/heads/main',
    baseName: 'main',
    repository: 'project',
    branch: 'topic',
    detached: null,
  });
  for (const schema of [reviewKey, fileKey.shape.url, chatRequest.shape.url, draftKey.shape.url])
    assert.equal(schema.parse(url), url);
  assert.throws(() => store.save(url));
  assert.throws(() => pullRequestUrl.parse(url));
  assert.throws(() => publishKey.parse({ url, version: 1, revision: 'r', actor: 'me' }));
  assert.throws(() => bundleKey.parse({ url, version: 1 }));
  assert.throws(() =>
    discussionReply.parse({
      url,
      account: 'me',
      token: crypto.randomUUID(),
      id: 1,
      kind: 'inline',
      body: 'x',
    }),
  );
  assert.throws(() => lessonKey.parse({ sourceUrl: url, threadId: 1 }));
  assert.throws(() => attemptKey.parse({ url, revision: 'r', head: 'h', run: 1, attempt: 1 }));
  assert.throws(() => reviewKey.parse('local:///etc/passwd'));
  store.reader.select(url);
  assert.equal(store.reader.active(), url);
  assert.equal(store.assistant.seen(url), false);
  store.assistant.savePrompt(url, 'review', 'Local instructions');
  assert.equal(store.assistant.preferences(url, 'codex').settings.prompt, 'Local instructions');
  assert.throws(() => store.assistant.savePrompt(url, 'repository', 'No repository'));
  assert.equal(store.assistant.summaryPreferences(url).scope, 'default');
});

await test('a local update keeps reviewed marks by fingerprint and reattaches drafts', async (t) => {
  const root = repository(t);
  const store = openStore(':memory:');
  t.after(() => store.close());
  const url = store.local.save({
    path: root,
    baseRef: 'refs/heads/main',
    baseName: 'main',
    repository: 'project',
    branch: 'topic',
    detached: null,
  });
  store.reader.select(url);
  const first = await localReviewSnapshot(store.local, url, signal);
  store.reader.install(url, first);
  for (const path of ['src/app.ts', 'README.md'])
    store.reader.checkpoint({
      url,
      revision: first.revision,
      path,
      hunk: 0,
      scroll: 0,
      reviewed: true,
    });
  const publisher = reviewPublisher(store);
  const drafted = publisher.edit(url, 0, {
    action: 'draft',
    id: null,
    body: 'Explain the new value.',
    target: { path: 'src/app.ts', hunk: 0, side: 'new', line: 2, revision: first.revision },
  });
  // The agent edits one file without committing.
  write(root, 'README.md', 'Project\nNotes\nMore notes\n');
  const probed = await localReviewRevision(store.local, url, signal);
  assert.notEqual(probed, first.revision);
  assert.match(shortRevision(probed), /^[0-9a-f]{8}\+[0-9a-f]{6}$/);
  const second = await localReviewSnapshot(store.local, url, signal);
  assert.equal(second.revision, probed);
  const unknown = { ancestry: 'unknown' as const, partial: false, files: [] };
  store.reader.revisions.stage(url, second, unknown, store.reader.revisions.baseline(url));
  assert.equal(store.reader.read(url)?.incoming, second.revision);
  // The reviewer saves the checkpoint after the agent already changed the clone: the staged
  // update stays available instead of blocking the checkpoint.
  assert.throws(() => store.reader.revisions.finish(url, first.revision), /latest update/);
  store.reader.revisions.checkpoint(url, first.revision);
  assert.equal(store.reader.revisions.baseline(url), first.revision);
  assert.equal(store.reader.read(url)?.incoming, second.revision);
  const pending = store.reader.revisions.pending(url, second.revision);
  const view = store.reader.install(url, pending.snapshot, pending.heads);
  assert.equal(view?.revision, second.revision);
  const byPath = new Map(view?.files.map((f) => [f.path, f]));
  assert.equal(byPath.get('src/app.ts')?.reviewed, true);
  assert.equal(byPath.get('README.md')?.reviewed, false);
  assert.equal(byPath.get('README.md')?.needsReview, true);
  assert.deepEqual(view?.comparison?.files, [{ path: 'README.md', state: 'changed' }]);
  const draft = store.drafts.get(url).comments[0];
  assert.equal(draft?.id, drafted.comments[0]?.id);
  assert.equal(draft?.revision, second.revision);
  // Switching branches in the clone is refused rather than reviewed under the old key.
  git(root, 'checkout', '--quiet', '-b', 'other');
  await assert.rejects(localReviewSnapshot(store.local, url, signal), /now on other/);
  await assert.rejects(localReviewRevision(store.local, url, signal), /now on other/);
});

function draft(change: Partial<Draft>): Draft {
  return {
    id: crypto.randomUUID(),
    path: 'src/app.ts',
    hunk: 0,
    side: 'new',
    line: 12,
    revision: 'base...head',
    excerpt: '+  return retry(count);',
    body: 'Cap the retries.',
    ...change,
  };
}
const brief = (change: Partial<BriefInput>) =>
  localReviewBrief({
    repository: 'project',
    branch: 'agent/retry',
    baseBranch: 'main',
    revision: 'b'.repeat(40) + '...' + 'c'.repeat(40) + '+0123456789ab',
    mergeBase: 'b'.repeat(40),
    summary: '',
    comments: [],
    ...change,
  });

await test('the agent brief names the reviewed revision and lists each comment with its code', () => {
  const revision = 'b'.repeat(40) + '...' + 'c'.repeat(40) + '+0123456789ab';
  const text = brief({
    summary: 'Mostly good.\nTwo fixes needed.',
    comments: [
      draft({ revision }),
      draft({
        revision,
        path: 'src/old.ts',
        side: 'old',
        startLine: 3,
        line: 5,
        excerpt: '-a\n-b\n-c',
        body: 'Why remove this?\n\nIt guarded nulls.',
      }),
    ],
  });
  assert.equal(
    text,
    [
      '# Review of `agent/retry` against `main`',
      '',
      'A reviewer read the changes in the `project` repository and left the comments below. Address each comment, then summarise what you changed. Reviewed revision: commit `cccccccccccc` with uncommitted changes (working tree state `0123456789ab`), compared with merge base `bbbbbbbbbbbb` of `main`. New-side line numbers refer to the files as they were in that reviewed revision. Old-side line numbers refer to the merge base. If the code has moved since, find it by its excerpt.',
      '',
      '## Summary',
      '',
      '> Mostly good.',
      '> Two fixes needed.',
      '',
      '## Comments (2)',
      '',
      '### 1. `src/app.ts:12` (new side)',
      '',
      '```diff',
      '+  return retry(count);',
      '```',
      '',
      '> Cap the retries.',
      '',
      '### 2. `src/old.ts:3–5` (old side, removed lines)',
      '',
      '```diff',
      '-a',
      '-b',
      '-c',
      '```',
      '',
      '> Why remove this?',
      '>',
      '> It guarded nulls.',
      '',
    ].join('\n'),
  );
});

await test('outdated drafts are kept in a marked section and an empty review says so', () => {
  const text = brief({ comments: [draft({ revision: 'older...head' })] });
  assert.doesNotMatch(text, /## Summary|## Comments/);
  assert.match(
    text,
    /## Outdated comments \(1\)\n\nThese comments were written against an earlier revision/,
  );
  assert.match(text, /### 1\. `src\/app\.ts:12` \(new side\)/);
  assert.match(brief({}), /The reviewer recorded no comments\.\n$/);
  assert.match(brief({ branch: null, revision: 'b...c' }), /^# Review of `detached HEAD`/);
  assert.doesNotMatch(brief({ revision: 'b...c' }), /uncommitted/);
});

await test('backticks in code, paths and comments cannot break the brief’s Markdown', () => {
  const revision = 'b...c';
  const text = brief({
    revision,
    comments: [
      draft({
        revision,
        path: 'docs/`odd`.md',
        excerpt: '+```js\n+const a = `x`;\n+```',
        body: 'Use ```` fences ````\n# not a heading',
      }),
    ],
  });
  assert.match(text, /### 1\. ``docs\/`odd`\.md:12`` \(new side\)/);
  assert.equal(inlineCode('`edge'), '`` `edge ``');
  assert.match(text, /\n````diff\n\+```js\n\+const a = `x`;\n\+```\n````\n/);
  assert.match(text, /\n> Use ```` fences ````\n> # not a heading\n$/);
  assert.equal(inlineCode('a\nb'), '`a b`');
});
