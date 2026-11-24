import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { defaultPrompt, type Preferences } from '../shared/assistant.js';
import { openStore } from './store.js';

await test('a saved PR survives restart and links to its files tab share the same entry', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'reviewer-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'workspace.sqlite');
  const first = openStore(path);
  const original = first.save('https://github.com/Org/Repo/pull/2/files#diff-abc');
  first.close();
  const reopened = openStore(path);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.list(), original);
  assert.deepEqual(reopened.save('https://github.com/org/repo/pull/2'), original);
  assert.equal(original[0]?.url, 'https://github.com/org/repo/pull/2');
});

await test('invalid input leaves the workspace empty', (t) => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  for (const invalid of [
    null,
    {},
    'https://github.com/org/../pull/1',
    'https://example.org/org/repo/pull/1',
  ]) {
    assert.throws(() => store.save(invalid));
  }
  assert.deepEqual(store.list(), []);
});

await test('upgrade built-in prompts, keep custom prompts, and turn the app default harness and model into the global choice', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'reviewer-prompt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'workspace.sqlite');
  const url = 'https://github.com/org/repo/pull/1';
  openStore(path).close();
  const settings: Preferences = {
    agent: 'claude',
    model: 'chosen',
    provider: 'default',
    prompt:
      'Explain the behaviour before and after the change. Cite the file and lines for each material claim. For a possible defect, describe the triggering conditions and the effect on the caller. If the answer depends on missing evidence, name what you would inspect. Treat the author’s stated intent as a claim to check. Keep routine changes brief.',
  };
  // Version 10 stored a harness and model beside the prompt in every scope.
  const legacy = new DatabaseSync(path);
  legacy.exec(
    'DROP TABLE review_lessons; ALTER TABLE workspace DROP COLUMN accent; DROP TABLE agent_selection; PRAGMA user_version=10',
  );
  const insert = legacy.prepare('INSERT INTO agent_preferences VALUES(?,?)');
  insert.run('default', JSON.stringify(settings));
  insert.run(
    url,
    JSON.stringify({
      ...settings,
      agent: 'codex',
      model: 'per-pr',
      prompt: 'Focus on concurrency.',
    }),
  );
  legacy.close();
  const upgraded = openStore(path);
  t.after(() => upgraded.close());
  assert.deepEqual(upgraded.assistant.preferences(url, 'codex'), {
    scope: 'review',
    settings: { ...settings, prompt: 'Focus on concurrency.' },
  });
  assert.deepEqual(upgraded.assistant.preferences(url + '2', 'codex').settings, {
    ...settings,
    prompt: defaultPrompt,
  });
});

await test('version 14 saved built-in prompts upgrade while custom instructions keep their scope', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'reviewer-prompt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'workspace.sqlite');
  const url = 'https://github.com/org/repo/pull/1';
  const old = openStore(path);
  old.assistant.savePrompt(url, 'default', 'Check compatibility.');
  old.assistant.savePrompt(
    url,
    'repository',
    'Answer the reviewer’s question directly. When asked for a file overview, describe what a newly added file introduces and how it fits into the PR, or explain how an existing file’s behaviour changed. Cite the file and lines for each material claim. For a possible defect, describe the triggering conditions and the effect on the caller. If the answer depends on missing evidence, name what you would inspect. Treat the author’s stated intent as a claim to check. Keep routine changes brief.',
  );
  old.assistant.savePrompt(url, 'review', 'Trace retries.');
  old.close();
  const legacy = new DatabaseSync(path);
  legacy.exec('PRAGMA user_version=14');
  legacy.close();

  const upgraded = openStore(path);
  t.after(() => upgraded.close());
  const promptFor = (pr: string) => upgraded.assistant.preferences(pr, 'codex').settings.prompt;
  assert.equal(promptFor(url), 'Trace retries.');
  assert.equal(promptFor(url + '2'), defaultPrompt);
  assert.equal(promptFor('https://github.com/org/other/pull/1'), 'Check compatibility.');
});

await test('an upgrade without a saved app default leaves the harness choice to the first installed agent', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'reviewer-selection-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'workspace.sqlite');
  openStore(path).close();
  const legacy = new DatabaseSync(path);
  legacy.exec(
    'DROP TABLE review_lessons; ALTER TABLE workspace DROP COLUMN accent; DROP TABLE agent_selection; PRAGMA user_version=11',
  );
  legacy
    .prepare('INSERT INTO agent_preferences VALUES(?,?)')
    .run(
      'org/repo',
      JSON.stringify({ agent: 'codex', model: 'm', provider: 'default', prompt: 'Repo.' }),
    );
  legacy.close();
  const upgraded = openStore(path);
  t.after(() => upgraded.close());
  assert.deepEqual(upgraded.assistant.selection('claude'), {
    agent: 'claude',
    model: '',
    provider: 'default',
  });
  assert.equal(
    upgraded.assistant.preferences('https://github.com/org/repo/pull/1', 'claude').settings.prompt,
    'Repo.',
  );
});

await test('an app default with an unusable model or provider still upgrades to a valid global choice', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'reviewer-partial-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'workspace.sqlite');
  openStore(path).close();
  const legacy = new DatabaseSync(path);
  legacy.exec(
    'DROP TABLE review_lessons; ALTER TABLE workspace DROP COLUMN accent; DROP TABLE agent_selection; PRAGMA user_version=11',
  );
  legacy
    .prepare('INSERT INTO agent_preferences VALUES(?,?)')
    .run('default', JSON.stringify({ agent: 'claude', model: 7, provider: 'x', prompt: 'Keep.' }));
  legacy.close();
  const upgraded = openStore(path);
  t.after(() => upgraded.close());
  assert.deepEqual(upgraded.assistant.preferences('https://github.com/org/repo/pull/1', 'codex'), {
    scope: 'default',
    settings: { agent: 'claude', model: '', provider: 'default', prompt: 'Keep.' },
  });
});

await test('a version 17 workspace with draft flags on observations opens and keeps tracking the PR', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'reviewer-draft-status-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'workspace.sqlite');
  const url = 'https://github.com/org/repo/pull/1';
  const disputed = 'https://github.com/org/repo/pull/2';
  const first = openStore(path);
  first.save(url);
  first.save(disputed);
  first.drafts.write(url, 0, { ...first.drafts.get(url), summary: 'Pending feedback' });
  first.close();

  const legacy = new DatabaseSync(path);
  legacy.exec(`
    DROP TABLE pull_draft_status;
    ALTER TABLE review_observations ADD COLUMN draft INTEGER NOT NULL;
    PRAGMA user_version=17;
  `);
  const observe = legacy.prepare('INSERT INTO review_observations VALUES(?,?,?,?,?)');
  observe.run('reader', url, 'first', 0, 1);
  observe.run('reader', disputed, 'first', 0, 1);
  observe.run('other', disputed, 'first', 0, 0);
  legacy.close();

  const upgraded = openStore(path);
  try {
    assert.equal(upgraded.list().find((pr) => pr.url === url)?.isDraft, true);
    assert.equal(upgraded.list().find((pr) => pr.url === disputed)?.isDraft, undefined);
    assert.equal(upgraded.drafts.get(url).summary, 'Pending feedback');
    const target = upgraded.replies.targets().find((item) => item.url === url);
    assert.ok(target);
    const changes = upgraded.replies.observe(
      'reader',
      url,
      target.registered,
      {
        state: 'OPEN',
        headRefOid: 'second',
        commitCount: 2,
        approvalStage: 'partial',
        isDraft: false,
        dismissed: { totalCount: 0 },
        latest: { nodes: [{ commit: { oid: 'first' } }] },
      },
      new Date().toISOString(),
    );
    assert.deepEqual(
      changes.map((change) => change.kind),
      ['push'],
    );
  } finally {
    upgraded.close();
  }
  const reopened = openStore(path);
  t.after(() => reopened.close());
  assert.equal(reopened.list().find((pr) => pr.url === url)?.isDraft, false);
  assert.equal(reopened.replies.changes('reader').length, 1);
});

await test('version 17 workspaces already using PR-wide draft flags keep their saved status', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'reviewer-status-upgrade-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'workspace.sqlite');
  const url = 'https://github.com/org/repo/pull/1';
  const first = openStore(path);
  first.save(url);
  first.reader.setDraft(url, true);
  const saved = first.list();
  first.close();
  const previous = new DatabaseSync(path);
  previous.exec('PRAGMA user_version=17');
  previous.close();

  const upgraded = openStore(path);
  t.after(() => upgraded.close());
  assert.deepEqual(upgraded.list(), saved);
});

await test('version 19 status rows retain approvals and accept a new head before reviews load', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'reviewer-v19-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'workspace.sqlite');
  const url = 'https://github.com/org/repo/pull/1';
  const first = openStore(path);
  first.save(url);
  first.drafts.write(url, 0, { ...first.drafts.get(url), summary: 'Keep pending review' });
  first.close();
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    DROP TABLE pull_review_status;
    CREATE TABLE pull_review_status (
      url TEXT PRIMARY KEY REFERENCES reply_targets(url) ON DELETE CASCADE,
      head TEXT NOT NULL, commit_count INTEGER NOT NULL, approval_stage TEXT NOT NULL
    ) STRICT;
    PRAGMA user_version=19;
  `);
  legacy.prepare('INSERT INTO pull_review_status VALUES(?,?,?,?)').run(url, 'first', 2, 'partial');
  legacy.close();
  const upgraded = openStore(path);
  t.after(() => upgraded.close());
  assert.equal(upgraded.list()[0]?.approvalStage, 'partial');
  assert.equal(upgraded.list()[0]?.commitCount, 2);
  assert.equal(upgraded.drafts.get(url).summary, 'Keep pending review');
  upgraded.reader.observeRemoteHead(url, 'second', undefined);
  const row = upgraded.list()[0];
  assert.equal(row?.head, 'second');
  assert.equal(row?.approvalStage, undefined);
  assert.equal(row?.commitCount, undefined);
});

await test('opening a newer schema preserves its version and contents', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'reviewer-version-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'workspace.sqlite');
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  db.exec(
    "CREATE TABLE future (value TEXT); INSERT INTO future VALUES ('preserve'); PRAGMA user_version=24",
  );
  assert.throws(() => openStore(path), /newer Local Reviewer/);
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 24);
  assert.equal(db.prepare('SELECT value FROM future').get()?.value, 'preserve');
});

await test('upgrading a version 22 workspace adds opt-in sidebar vibrancy', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'reviewer-vibrancy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'workspace.sqlite');
  const original = openStore(path);
  const reviews = original.save('https://github.com/org/repo/pull/2');
  original.close();
  const old = new DatabaseSync(path);
  old.exec('ALTER TABLE workspace DROP COLUMN sidebar_vibrancy; PRAGMA user_version=22');
  old.close();
  const upgraded = openStore(path);
  assert.deepEqual(upgraded.list(), reviews);
  assert.equal(upgraded.getSidebarVibrancy(), false);
  upgraded.saveSidebarVibrancy(true);
  upgraded.close();
  const reopened = openStore(path);
  t.after(() => reopened.close());
  assert.equal(reopened.getSidebarVibrancy(), true);
});

await test('an unknown saved palette opens with Ink and can be replaced in Settings', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'reviewer-palette-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'workspace.sqlite');
  openStore(path).close();
  const db = new DatabaseSync(path);
  db.prepare('UPDATE workspace SET appearance=? WHERE id=1').run('unknown');
  db.close();
  const store = openStore(path);
  t.after(() => store.close());
  assert.equal(store.getAppearance(), 'ink');
  assert.throws(() => store.saveAppearance('unknown'));
  store.saveAppearance('light');
  assert.equal(store.getAppearance(), 'light');
});

await test('the accent colour is added to an existing workspace and survives a restart', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'reviewer-accent-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'workspace.sqlite');
  openStore(path).close();
  const legacy = new DatabaseSync(path);
  legacy.exec("UPDATE workspace SET appearance='midnight' WHERE id=1");
  legacy.exec(
    'DROP TABLE review_lessons; ALTER TABLE workspace DROP COLUMN accent; PRAGMA user_version=12',
  );
  legacy.close();
  const upgraded = openStore(path);
  assert.equal(upgraded.getAccent(), 'neutral');
  assert.equal(upgraded.getAppearance(), 'midnight');
  upgraded.saveAccent('violet');
  assert.throws(() => upgraded.saveAccent('chartreuse'));
  upgraded.close();
  const reopened = openStore(path);
  t.after(() => reopened.close());
  assert.equal(reopened.getAccent(), 'violet');
});

await test('a fresh conversation excludes earlier turns for only its PR and keeps the boundary after restart', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'reviewer-chat-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'workspace.sqlite');
  const a = 'https://github.com/org/repo/pull/1',
    b = 'https://github.com/org/repo/pull/2';
  const previous = openStore(path);
  previous.save(a);
  previous.save(b);
  const original = {
    run: randomUUID(),
    question: 'Previous question',
    answer: 'Previous answer',
    revision: 'same',
    path: 'a.ts',
    citations: [],
    promptVersion: 'v',
    reportedModel: null,
    settings: previous.assistant.preferences(a, 'claude').settings,
  };
  previous.assistant.append(a, original, 0);
  previous.assistant.append(b, { ...original, run: randomUUID() }, 0);
  previous.close();
  const old = new DatabaseSync(path);
  old.exec(
    'DROP TABLE chat_sessions; ALTER TABLE conversation DROP COLUMN generation; PRAGMA user_version=20',
  );
  old.close();
  const upgraded = openStore(path);
  assert.deepEqual(upgraded.assistant.history(a, upgraded.assistant.generation(a)), [original]);
  const otherWindow = openStore(path);
  const originalGeneration = otherWindow.assistant.generation(a);
  upgraded.assistant.newConversation(a);
  upgraded.assistant.newConversation(a);
  assert.deepEqual(upgraded.assistant.history(a, upgraded.assistant.generation(a)), []);
  const latest = { ...original, run: randomUUID(), question: 'Fresh question' };
  upgraded.assistant.append(a, latest, upgraded.assistant.generation(a));
  const late = {
    ...original,
    run: randomUUID(),
    answer: 'Late answer from the previous conversation',
  };
  assert.deepEqual(otherWindow.assistant.append(a, late, originalGeneration), {
    ...late,
    archived: true,
  });
  otherWindow.close();
  upgraded.close();
  const reopened = openStore(path);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.assistant.history(a), [
    { ...original, archived: true },
    latest,
    { ...late, archived: true },
  ]);
  assert.deepEqual(reopened.assistant.history(a, reopened.assistant.generation(a)), [latest]);
  assert.equal(
    reopened.assistant.history(b, reopened.assistant.generation(b))[0]?.question,
    original.question,
  );
});

await test('a version 21 workspace keeps its earlier messages outside the active conversation', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'reviewer-chat-upgrade-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'workspace.sqlite'),
    url = 'https://github.com/org/repo/pull/3';
  const previous = openStore(path);
  previous.save(url);
  const turn = {
    run: randomUUID(),
    revision: 'same',
    path: 'a.ts',
    question: 'Earlier?',
    answer: 'Earlier.',
    citations: [],
    settings: previous.assistant.preferences(url, 'claude').settings,
    promptVersion: 'v',
    reportedModel: null,
  };
  previous.assistant.append(url, turn, 0);
  previous.assistant.append(url, { ...turn, run: randomUUID(), question: 'Current?' }, 0);
  previous.close();
  const old = new DatabaseSync(path);
  old.exec(`DROP TABLE chat_sessions; ALTER TABLE conversation DROP COLUMN generation;
    CREATE TABLE chat_boundaries(url TEXT PRIMARY KEY REFERENCES saved_reviews(url), last_archived_id INTEGER NOT NULL) STRICT;
    INSERT INTO chat_boundaries SELECT url,min(id) FROM conversation GROUP BY url;
    PRAGMA user_version=21`);
  old.close();
  const upgraded = openStore(path);
  t.after(() => upgraded.close());
  assert.deepEqual(
    upgraded.assistant.history(url).map((msg) => !!msg.archived),
    [true, false],
  );
  assert.deepEqual(
    upgraded.assistant.history(url, upgraded.assistant.generation(url)).map((msg) => msg.question),
    ['Current?'],
  );
});
