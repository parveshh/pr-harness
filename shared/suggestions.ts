// GitHub "suggested changes" live inside a comment body as a fenced block whose info string
// is `suggestion`. These helpers are pure so the client, the publisher and the brief agree.
import { diffLines } from './diff.js';
import type { CommentAnchor } from './publish.js';

export type BodySegment = { kind: 'text'; text: string } | { kind: 'suggestion'; lines: string[] };

const opening = /^ {0,3}(`{3,})[ \t]*([^`]*?)[ \t]*$/;
const closing = /^ {0,3}(`{3,})[ \t]*$/;

// Split a comment body into prose and suggestion blocks. A fence of three or more backticks
// opens a block, and a closing fence needs at least as many. Other fenced code is prose, and
// a fence that never closes is prose, as it is for GitHub.
export function parseBody(body: string): BodySegment[] {
  const rows = body.split(/\r\n|\r|\n/);
  const segments: BodySegment[] = [];
  let prose: string[] = [];
  const flush = () => {
    // Blank lines around a fence are layout, not part of the prose.
    const text = prose.join('\n').replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, '');
    if (text.trim()) segments.push({ kind: 'text', text });
    prose = [];
  };
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] ?? '';
    const open = opening.exec(row);
    if (!open) {
      prose.push(row);
      continue;
    }
    const size = open[1]?.length ?? 3;
    let end = -1;
    for (let j = i + 1; j < rows.length; j++) {
      const close = closing.exec(rows[j] ?? '');
      if (close && (close[1]?.length ?? 0) >= size) {
        end = j;
        break;
      }
    }
    if (end < 0) {
      // Unterminated: this fence and everything after it is prose.
      prose.push(...rows.slice(i));
      break;
    }
    if (open[2] === 'suggestion') {
      flush();
      segments.push({ kind: 'suggestion', lines: rows.slice(i + 1, end) });
    } else prose.push(...rows.slice(i, end + 1));
    i = end;
  }
  flush();
  return segments;
}
export const hasSuggestion = (body: string) =>
  parseBody(body).some((segment) => segment.kind === 'suggestion');

// A fence longer than any backtick run inside the replacement, so the code cannot close it.
export function suggestionFence(lines: readonly string[]) {
  let longest = 0;
  for (const line of lines)
    for (const run of line.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return [fence + 'suggestion', ...lines, fence].join('\n');
}
export function appendSuggestion(body: string, lines: readonly string[]) {
  const fence = suggestionFence(lines);
  const prefix = body.trim() ? body.replace(/\s+$/, '') + '\n\n' : '';
  // The caret sits at the end of the replacement text, inside the fence.
  const caret = prefix.length + fence.indexOf('\n') + 1 + lines.join('\n').length;
  return { body: prefix + fence, caret };
}

// Diff excerpts keep the leading marker of each line. Drop it to get the source text.
export const excerptSource = (excerpt: string) =>
  excerpt === '' ? [] : excerpt.split('\n').map((line) => line.slice(1));

// The new-side source of an inclusive line range within one hunk, or null unless every line
// of the range is shown there. Deleted lines have no new-side number, so they never match.
export function newSideLines(
  hunk: string,
  range: Pick<CommentAnchor, 'line' | 'startLine'>,
): string[] | null {
  const start = range.startLine ?? range.line;
  if (start > range.line) return null;
  const rows = diffLines(hunk).lines.filter(
    (row) => row.newLine !== null && row.newLine >= start && row.newLine <= range.line,
  );
  return rows.length === range.line - start + 1 ? rows.map((row) => row.text.slice(1)) : null;
}
