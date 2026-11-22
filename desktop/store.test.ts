import assert from 'node:assert/strict';
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

await test('opening a newer schema preserves its version and contents', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'reviewer-version-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'workspace.sqlite');
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  db.exec(
    "CREATE TABLE future (value TEXT); INSERT INTO future VALUES ('preserve'); PRAGMA user_version=16",
  );
  assert.throws(() => openStore(path), /newer Local Reviewer/);
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 16);
  assert.equal(db.prepare('SELECT value FROM future').get()?.value, 'preserve');
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
