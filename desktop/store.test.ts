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

await test('upgrade previously saved built-in prompts while preserving custom prompts and model choices', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'reviewer-prompt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'workspace.sqlite');
  const url = 'https://github.com/org/repo/pull/1';
  const first = openStore(path);
  const settings: Preferences = {
    agent: 'claude',
    model: 'chosen',
    provider: 'default',
    prompt:
      'Explain the behaviour before and after the change. Cite the file and lines for each material claim. For a possible defect, describe the triggering conditions and the effect on the caller. If the answer depends on missing evidence, name what you would inspect. Treat the author’s stated intent as a claim to check. Keep routine changes brief.',
  };
  first.assistant.savePreferences(url, 'default', settings);
  first.assistant.savePreferences(url, 'review', { ...settings, prompt: 'Focus on concurrency.' });
  first.close();
  const legacy = new DatabaseSync(path);
  legacy.exec('PRAGMA user_version=10');
  legacy.close();
  const upgraded = openStore(path);
  t.after(() => upgraded.close());
  assert.deepEqual(upgraded.assistant.preferences(url, 'codex').settings, {
    ...settings,
    prompt: 'Focus on concurrency.',
  });
  assert.deepEqual(upgraded.assistant.preferences(url + '2', 'codex').settings, {
    ...settings,
    prompt: defaultPrompt,
  });
});

await test('opening a newer schema preserves its version and contents', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'reviewer-version-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'workspace.sqlite');
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  db.exec(
    "CREATE TABLE future (value TEXT); INSERT INTO future VALUES ('preserve'); PRAGMA user_version=12",
  );
  assert.throws(() => openStore(path), /newer Local Reviewer/);
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 12);
  assert.equal(db.prepare('SELECT value FROM future').get()?.value, 'preserve');
});
