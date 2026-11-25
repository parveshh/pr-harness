import { diffLines } from '../shared/diff.js';
import { splitHunks } from '../shared/reader.js';
import type { CommentAnchor, Draft } from '../shared/publish.js';

export function excerpt(patch: string, anchor: CommentAnchor, maxChars = Infinity) {
  const hunk = splitHunks(patch)[anchor.hunk];
  if (hunk === undefined) return undefined;
  const start = anchor.startLine ?? anchor.line;
  if (start > anchor.line) return undefined;
  const range = diffLines(hunk).lines.filter((row) => {
    const n = anchor.side === 'old' ? row.oldLine : row.newLine;
    return n !== null && n >= start && n <= anchor.line;
  });
  if (
    range.length !== anchor.line - start + 1 ||
    (anchor.side === 'old' && (range[0]?.kind !== 'deletion' || range.at(-1)?.kind !== 'deletion'))
  )
    return undefined;
  let length = range.length - 1;
  for (const row of range) {
    length += row.text.length;
    if (length > maxChars) return undefined;
  }
  return range.map((row) => row.text).join('\n');
}

// Match the entire range and its adjacent lines on the original side. A repeated
// match or missing surrounding evidence requires a decision from the reviewer.
export function relocate(
  draft: Draft,
  before: string,
  after: string,
  identical: boolean,
): CommentAnchor | null {
  if (excerpt(before, draft) !== draft.excerpt) return null;
  if (identical && excerpt(after, draft) === draft.excerpt) return draft;
  const side = draft.side === 'old' ? 'oldLine' : 'newLine';
  const rows = (hunk: string) => diffLines(hunk).lines.filter((row) => row[side] !== null);
  const original = rows(splitHunks(before)[draft.hunk] ?? '');
  const start = draft.startLine ?? draft.line;
  const at = original.findIndex((row) => row[side] === start);
  const length = draft.line - start + 1;
  const contextBefore = original.slice(Math.max(0, at - 2), at);
  const contextAfter = original.slice(at + length, at + length + 2);
  if (!contextBefore.length && !contextAfter.length) return null;
  const pattern = [...contextBefore, ...original.slice(at, at + length), ...contextAfter].map(
    (row) => row.text,
  );
  let match: CommentAnchor | null = null;
  for (const [hunk, text] of splitHunks(after).entries()) {
    const lines = rows(text);
    for (let i = 0; i + pattern.length <= lines.length; i++) {
      if (!pattern.every((value, j) => value === lines[i + j]?.text)) continue;
      const first = lines[i + contextBefore.length]?.[side];
      const last = lines[i + contextBefore.length + length - 1]?.[side];
      if (!first || !last || match) return null;
      match = {
        path: draft.path,
        side: draft.side,
        hunk,
        line: last,
        ...(draft.startLine ? { startLine: first } : {}),
      };
    }
  }
  return match;
}
