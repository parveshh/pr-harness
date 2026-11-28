import assert from 'node:assert/strict';
import test from 'node:test';
import { diffLines } from '../shared/diff.js';
import {
  adjacentFile,
  firstChangedLine,
  isEditableElement,
  shortcutFor,
  stepHunk,
  type KeyInput,
  type ShortcutContext,
} from '../shared/shortcuts.js';

const open: ShortcutContext = { enabled: true, overlayOpen: false, editableTarget: false };
const press = (key: string, extra: Partial<KeyInput> = {}): KeyInput => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  repeat: false,
  defaultPrevented: false,
  ...extra,
});

await test('each key maps to its reader action', () => {
  const expected = {
    j: 'next-hunk',
    k: 'previous-hunk',
    ']': 'next-file',
    '[': 'previous-file',
    n: 'next-file',
    p: 'previous-file',
    u: 'next-unread',
    v: 'toggle-reviewed',
    c: 'comment',
    a: 'ask',
    '?': 'show-help',
  };
  for (const [key, action] of Object.entries(expected))
    assert.equal(shortcutFor(press(key, { shiftKey: key === '?' }), open), action, key);
  for (const key of ['x', 'Enter', 'Escape', 'F3', 'ArrowDown', ' ', 'constructor', '__proto__'])
    assert.equal(shortcutFor(press(key), open), null, key);
});

await test('shortcuts are ignored in editable fields, overlays, with the setting off and while composing', () => {
  assert.equal(shortcutFor(press('j'), { ...open, editableTarget: true }), null);
  assert.equal(shortcutFor(press('j'), { ...open, overlayOpen: true }), null);
  assert.equal(shortcutFor(press('?', { shiftKey: true }), { ...open, overlayOpen: true }), null);
  assert.equal(shortcutFor(press('j'), { ...open, enabled: false }), null);
  assert.equal(shortcutFor(press('?', { shiftKey: true }), { ...open, enabled: false }), null);
  assert.equal(shortcutFor(press('j', { isComposing: true }), open), null);
  assert.equal(shortcutFor(press('Process'), open), null);
  assert.equal(shortcutFor(press('j', { defaultPrevented: true }), open), null);
});

await test('Ctrl, Meta and Alt disable shortcuts, so find and AltGr layouts are untouched', () => {
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey'] as const) {
    assert.equal(shortcutFor(press('j', { [modifier]: true }), open), null, modifier);
    assert.equal(shortcutFor(press('f', { [modifier]: true }), open), null, modifier);
    assert.equal(shortcutFor(press('?', { [modifier]: true, shiftKey: true }), open), null);
  }
  assert.equal(shortcutFor(press('['), { ...open }), 'previous-file');
  assert.equal(shortcutFor(press('[', { ctrlKey: true, altKey: true }), open), null);
});

await test('Shift is accepted only for the question mark', () => {
  assert.equal(shortcutFor(press('?', { shiftKey: true }), open), 'show-help');
  assert.equal(shortcutFor(press('?'), open), 'show-help');
  assert.equal(shortcutFor(press('J', { shiftKey: true }), open), null);
  assert.equal(shortcutFor(press('c', { shiftKey: true }), open), null);
  // Caps Lock alone reports an upper case letter without Shift.
  assert.equal(shortcutFor(press('J'), open), 'next-hunk');
});

await test('holding a key repeats navigation but not toggles', () => {
  assert.equal(shortcutFor(press('j', { repeat: true }), open), 'next-hunk');
  assert.equal(shortcutFor(press(']', { repeat: true }), open), 'next-file');
  for (const key of ['v', 'c', 'a', 'f', 'u'])
    assert.equal(shortcutFor(press(key, { repeat: true }), open), null, key);
});

await test('editable elements are recognised', () => {
  const element = (tagName: string, isContentEditable = false, role: string | null = null) =>
    isEditableElement({ tagName, isContentEditable, role });
  for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) assert.equal(element(tag), true, tag);
  assert.equal(element('DIV', true), true);
  assert.equal(element('DIV', false, 'textbox'), true);
  assert.equal(element('DIV', false, 'combobox'), true);
  assert.equal(element('BUTTON'), false);
  assert.equal(element('DIV'), false);
});

// Files by hunk count: a.ts has 2, b.png is binary, c.ts has 1, d.md has none, e.ts has 3.
const counts = [2, 0, 1, 0, 3];
const count = (index: number) => counts[index] ?? 0;
const step = (index: number, hunk: number, direction: 1 | -1) =>
  stepHunk(counts.length, { index, hunk }, direction, count);

await test('next hunk crosses file boundaries and skips files without hunks', async () => {
  assert.deepEqual(await step(0, 0, 1), { index: 0, hunk: 1 });
  assert.deepEqual(await step(0, 1, 1), { index: 2, hunk: 0 });
  assert.deepEqual(await step(2, 0, 1), { index: 4, hunk: 0 });
  assert.deepEqual(await step(4, 1, 1), { index: 4, hunk: 2 });
  assert.equal(await step(4, 2, 1), null);
});

await test('previous hunk crosses file boundaries and lands on the last hunk', async () => {
  assert.deepEqual(await step(4, 1, -1), { index: 4, hunk: 0 });
  assert.deepEqual(await step(4, 0, -1), { index: 2, hunk: 0 });
  assert.deepEqual(await step(2, 0, -1), { index: 0, hunk: 1 });
  assert.deepEqual(await step(0, 1, -1), { index: 0, hunk: 0 });
  assert.equal(await step(0, 0, -1), null);
});

await test('a position on a file without hunks moves to the nearest file that has them', async () => {
  assert.deepEqual(await step(1, 0, 1), { index: 2, hunk: 0 });
  assert.deepEqual(await step(1, 0, -1), { index: 0, hunk: 1 });
  assert.deepEqual(await step(3, 0, 1), { index: 4, hunk: 0 });
  assert.equal(await stepHunk(2, { index: 1, hunk: 0 }, 1, () => 0), null);
  assert.equal(await stepHunk(0, { index: -1, hunk: 0 }, 1, count), null);
});

await test('traversal reads each file only as far as it needs and accepts async counts', async () => {
  const read: number[] = [];
  const later = async (index: number) => {
    read.push(index);
    await Promise.resolve();
    return count(index);
  };
  assert.deepEqual(await stepHunk(counts.length, { index: 0, hunk: 1 }, 1, later), {
    index: 2,
    hunk: 0,
  });
  assert.deepEqual(read, [0, 1, 2]);
});

await test('file steps stop at the ends', () => {
  assert.equal(adjacentFile(3, 0, 1), 1);
  assert.equal(adjacentFile(3, 2, 1), null);
  assert.equal(adjacentFile(3, 0, -1), null);
  assert.equal(adjacentFile(3, 2, -1), 1);
  assert.equal(adjacentFile(3, -1, 1), 0);
  assert.equal(adjacentFile(3, -1, -1), null);
  assert.equal(adjacentFile(0, -1, 1), null);
});

await test('the comment starts on the first added line, or the first removed line when only deleting', () => {
  const mixed = diffLines('@@ -10,4 +10,5 @@\n keep\n-old\n+new one\n+new two\n tail');
  assert.deepEqual(firstChangedLine(mixed.lines), { side: 'new', line: 11, text: '+new one' });
  const deleting = diffLines('@@ -3,3 +3,2 @@\n keep\n-gone\n tail');
  assert.deepEqual(firstChangedLine(deleting.lines), { side: 'old', line: 4, text: '-gone' });
  assert.equal(firstChangedLine(diffLines('@@ -1 +1 @@\n same').lines), null);
});
