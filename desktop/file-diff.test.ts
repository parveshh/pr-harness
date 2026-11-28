import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expandSavedFileDiff } from './saved-file-diff.js';
import { fileDiff, fileDiffPage, filePageRows } from '../shared/file-diff.js';

await test('all context and both edits are accessible, with saved hunks mapped by side', () => {
  const full =
    '@@ -1 +1 @@\n first\n-old\n+new\n' + ' middle\n'.repeat(10000) + '-tail\n+end\n last';
  const diff = fileDiff(full, '@@ -2 +2 @@\n-old\n+new\n@@ -10003 +10003 @@\n-tail\n+end');
  assert.equal(diff.rowAt(0)?.text, ' first');
  assert.equal(diff.rowAt(7092)?.text, ' middle');
  assert.equal(diff.rowAt(diff.length - 1)?.text, ' last');
  assert.equal(diff.displayPosition(1, 1), diff.length - 2);
  assert.equal(diff.hunkAt(diff.length - 2, 'new'), 1);
  assert.equal(diff.hunkAt(2, 'new'), 0);
  assert.equal(diff.hunkAt(2, 'old'), -1);
});

await test('saved anchors and search still address identical lines aligned differently by Git', () => {
  const diff = fileDiff('@@ -1,2 +1 @@\n-a\n a', '@@ -2 +1,0 @@\n-a');
  assert.equal(diff.displayPosition(0, 0), 1);
  assert.equal(diff.hunkAt(1, 'old'), 0);
  assert.equal(diff.hunkAt(1, 'new'), -1);
});

await test('multi-million-row files can reach their final change inside a bounded scroll container', () => {
  const rows = 2_000_000;
  const full = '@@ -1 +1 @@\n' + ' x\n'.repeat(rows) + '-old\n+new';
  const diff = fileDiff(full, '@@ -2000001 +2000001 @@\n-old\n+new');
  const lastPage = fileDiffPage(diff, Math.floor(rows / filePageRows));
  assert.equal(lastPage.length, 2);
  assert.equal(lastPage.find('new', rows + 1), 1);
  assert.equal(lastPage.rowAt(1)?.text, '+new');
  assert.equal(lastPage.displayPosition(0, 1), 1);
  assert.equal(lastPage.hunkAt(1, 'new'), 0);
  assert.equal(lastPage.find('new', 1), undefined);
});

await test('saved local edits retain unchanged rows, empty lines, CRLF, and a final line without a newline', () => {
  const base = 'a\r\n\r\nb\r\nc\r\nd';
  const patch = '@@ -1 +0,0 @@\n-a\r\n@@ -3,0 +3 @@\n+extra\r';
  // The deletion begins on the first old line, before any new line.
  const full = expandSavedFileDiff(base, patch);
  assert.equal(
    full,
    '@@ -1,5 +1,5 @@\n-a\r\n \r\n b\r\n+extra\r\n c\r\n d\n\\ No newline at end of file',
  );
  assert.equal(expandSavedFileDiff(base, '@@ -1 +1 @@\n-wrong\n+ok'), null);
  assert.equal(expandSavedFileDiff(base, '@@ -1,2 +1 @@\n-a\r'), null);
  assert.equal(expandSavedFileDiff('a\n', '@@ -1 +1 @@\n-a\n+abcd', 4), null);
  assert.equal(
    expandSavedFileDiff('a\n', '@@ -1 +1 @@\n-a\n+abcd\n\\ No newline at end of file', 4),
    '@@ -1,1 +1,1 @@\n-a\n+abcd\n\\ No newline at end of file',
  );
});
