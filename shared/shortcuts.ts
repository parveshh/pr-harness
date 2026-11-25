import type { diffLines } from './diff.js';

// Single-key reader shortcuts. Everything here is pure so the mapping, the ignore rules and the
// traversal order can be tested without a DOM.
export type ShortcutAction =
  | 'next-hunk'
  | 'previous-hunk'
  | 'next-file'
  | 'previous-file'
  | 'next-unread'
  | 'toggle-reviewed'
  | 'comment'
  | 'ask'
  | 'toggle-full-file'
  | 'show-help';

const bindings: Record<string, ShortcutAction> = {
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
  f: 'toggle-full-file',
  '?': 'show-help',
};

// Holding a navigation key keeps stepping. Anything that toggles or opens something fires once.
const repeatable = new Set<ShortcutAction>([
  'next-hunk',
  'previous-hunk',
  'next-file',
  'previous-file',
]);

export const shortcutHelp: readonly { keys: readonly string[]; action: string }[] = [
  { keys: ['j', 'k'], action: 'Next or previous hunk, continuing into the next or previous file' },
  { keys: [']', 'n'], action: 'Next file' },
  { keys: ['[', 'p'], action: 'Previous file' },
  { keys: ['u'], action: 'Next unread file' },
  { keys: ['v'], action: 'Mark the file reviewed, or clear it' },
  { keys: ['c'], action: 'Comment on the selected lines, or the first changed line of the hunk' },
  { keys: ['a'], action: 'Ask the assistant about the selected lines' },
  { keys: ['f'], action: 'Switch between Full file and Diff only' },
  { keys: ['?'], action: 'Show this list' },
  { keys: ['Esc'], action: 'Close the comment editor and return to the hunk' },
];

export interface KeyInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
  repeat: boolean;
  defaultPrevented: boolean;
}
export interface ShortcutContext {
  // The Single-key shortcuts setting.
  enabled: boolean;
  // A dialog, menu or listbox is open.
  overlayOpen: boolean;
  // Focus is in an input, textarea, select or contenteditable element.
  editableTarget: boolean;
}

export function shortcutFor(input: KeyInput, context: ShortcutContext): ShortcutAction | null {
  if (!context.enabled || context.overlayOpen || context.editableTarget) return null;
  if (input.defaultPrevented || input.isComposing || input.key === 'Process') return null;
  // Ctrl, Meta and Alt belong to the application, the OS and keyboard layouts (AltGr reports
  // Ctrl+Alt). Shift is only meaningful for `?`, which some layouts type without it.
  if (input.ctrlKey || input.metaKey || input.altKey) return null;
  if (input.shiftKey && input.key !== '?') return null;
  // Caps Lock reports upper case letters without Shift.
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  const action = Object.hasOwn(bindings, key) ? bindings[key] : undefined;
  if (!action) return null;
  if (input.repeat && !repeatable.has(action)) return null;
  return action;
}

// Whether an element takes typed characters, so a letter must reach it rather than a shortcut.
export interface ElementInfo {
  tagName: string;
  isContentEditable: boolean;
  role: string | null;
}
export function isEditableElement(element: ElementInfo) {
  const tag = element.tagName.toLowerCase();
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    element.isContentEditable ||
    element.role === 'textbox' ||
    element.role === 'combobox' ||
    element.role === 'searchbox'
  );
}

export interface HunkPosition {
  index: number;
  hunk: number;
}

// Move one hunk forward or back through files in list order. A file with no hunks (binary,
// metadata only, unavailable or empty) is skipped. Returns null at the first or last hunk.
// `countHunks` may be asynchronous because a file's patch is read on demand.
export async function stepHunk(
  fileCount: number,
  from: HunkPosition,
  direction: 1 | -1,
  countHunks: (index: number) => Promise<number> | number,
): Promise<HunkPosition | null> {
  if (from.index < 0 || from.index >= fileCount) return null;
  const here = await countHunks(from.index);
  if (direction === 1) {
    if (from.hunk + 1 < here) return { index: from.index, hunk: from.hunk + 1 };
    for (let index = from.index + 1; index < fileCount; index++) {
      if ((await countHunks(index)) > 0) return { index, hunk: 0 };
    }
    return null;
  }
  const before = Math.min(from.hunk, here) - 1;
  if (before >= 0) return { index: from.index, hunk: before };
  for (let index = from.index - 1; index >= 0; index--) {
    const count = await countHunks(index);
    if (count > 0) return { index, hunk: count - 1 };
  }
  return null;
}

// The neighbouring file in list order, or null past either end. With nothing selected, forward
// starts at the first file.
export function adjacentFile(fileCount: number, index: number, direction: 1 | -1) {
  const next = index < 0 ? (direction === 1 ? 0 : -1) : index + direction;
  return next >= 0 && next < fileCount ? next : null;
}

// Where `c` starts a comment when no line is selected: the first added line, or for a hunk that
// only deletes, the first removed line.
export function firstChangedLine(lines: ReturnType<typeof diffLines>['lines']) {
  for (const line of lines)
    if (line.kind === 'addition' && line.newLine !== null)
      return { side: 'new' as const, line: line.newLine, text: line.text };
  for (const line of lines)
    if (line.kind === 'deletion' && line.oldLine !== null)
      return { side: 'old' as const, line: line.oldLine, text: line.text };
  return null;
}
