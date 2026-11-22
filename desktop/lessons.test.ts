import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { matchesLessonFile, matchesLessonLines, saveLesson } from '../shared/lessons.js';
import { openStore } from './store.js';

const sourceUrl = 'https://github.com/team/pull/pull/11';
const later = 'https://github.com/team/pull/pull/12';
const unrelated = 'https://github.com/team/export-tools/pull/12';
const lesson = {
  sourceUrl,
  threadId: 83,
  path: 'src/export.ts',
  note: 'Use the account timezone.',
  fragment: 'dateRange',
};

await test('a v13 workspace gains private repository lessons and remembers edits across restarts', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'review-lessons-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'workspace.sqlite');
  const initial = openStore(path);
  const saved = initial.save(sourceUrl);
  initial.close();
  const legacy = new DatabaseSync(path);
  legacy.exec('DROP TABLE review_lessons; PRAGMA user_version=13');
  legacy.close();
  const store = openStore(path);
  assert.deepEqual(store.list(), saved);
  assert.deepEqual(store.lessons.list(later), []);
  store.lessons.save(lesson);
  const edited = { ...lesson, note: 'Test midnight in the account timezone.' };
  store.lessons.save(edited);
  store.close();
  const reopened = openStore(path);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.lessons.list(unrelated), []);
  reopened.lessons.forget(unrelated, lesson);
  assert.deepEqual(reopened.lessons.list(later), [edited]);
  reopened.lessons.forget(later, lesson);
  assert.deepEqual(reopened.lessons.list(sourceUrl), []);
});

await test('fragment reminders match literal changed text on either side and ignore context', () => {
  assert.ok(matchesLessonLines(lesson, ['+let start = dateRange.start']));
  assert.ok(matchesLessonLines(lesson, ['-dateRange()']));
  assert.equal(matchesLessonLines(lesson, [' dateRange()', '+DateRange()', '+unrelated']), false);
  assert.equal(matchesLessonLines({ ...lesson, fragment: '' }, ['+dateRange']), false);
  assert.equal(matchesLessonLines({ ...lesson, fragment: '.*' }, ['+dateRange']), false);
  const spaced = { ...lesson, ...saveLesson.parse({ ...lesson, fragment: 'return ' }) };
  assert.equal(matchesLessonLines(spaced, ['+returnValue']), false);
  assert.ok(matchesLessonLines(spaced, ['+return value']));
  assert.equal(saveLesson.parse({ ...lesson, fragment: '  ' }).fragment, '');
  assert.equal(saveLesson.safeParse({ ...lesson, note: '  ' }).success, false);
});

await test('a file reminder follows the original path or a reported rename', () => {
  const reminder = { ...lesson, fragment: '' };
  const original = { path: reminder.path, previousPath: null, status: 'modified' };
  const renamed = { path: 'new/export.ts', previousPath: reminder.path, status: 'renamed' };
  assert.ok(matchesLessonFile(reminder, original));
  assert.ok(matchesLessonFile(reminder, renamed));
  assert.equal(matchesLessonFile(reminder, { ...original, path: 'test/export.ts' }), false);
  assert.equal(matchesLessonFile(reminder, { ...renamed, status: 'copied' }), false);
  assert.equal(matchesLessonFile(lesson, original), false);
});
