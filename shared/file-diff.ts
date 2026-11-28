import { diffLines } from './diff.js';
import { splitHunks } from './reader.js';

type Row = ReturnType<typeof diffLines>['lines'][number];
type Side = 'old' | 'new';
type Block = { row: number; at: number; end: number; old: number; new: number; hunk: number };
const blockSize = 256;

function lastAtOrBefore<T>(items: T[], target: number, position: (item: T) => number) {
  let low = 0,
    high = items.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const item = items[mid];
    if (item !== undefined && position(item) <= target) low = mid + 1;
    else high = mid;
  }
  return items[low - 1];
}

// Index one offset per block. Only visible blocks need line objects, even when most
// of a multi-megabyte file consists of blank lines.
function indexPatch(patch: string) {
  const hunks = splitHunks(patch);
  const blocks: Block[] = [],
    oldBlocks: Block[] = [],
    newBlocks: Block[] = [];
  const starts: number[] = [];
  const firstChanges: (number | undefined)[] = [];
  let length = 0,
    widest = '',
    columns = -1;
  for (const [hunk, text] of hunks.entries()) {
    const headerEnd = text.indexOf('\n');
    starts.push(length);
    if (headerEnd < 0) continue;
    const heading = text.slice(0, headerEnd);
    const ranges = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(heading);
    let old = Number(ranges?.[1] ?? 0),
      next = Number(ranges?.[2] ?? 0);
    let addition: number | undefined, deletion: number | undefined;
    for (let at = headerEnd + 1; at < text.length;) {
      const block: Block = { row: length, at, end: at, old, new: next, hunk };
      for (let i = 0; i < blockSize && at < text.length; i++, length++) {
        const lf = text.indexOf('\n', at);
        const end = lf < 0 ? text.length : lf;
        const marker = text[at];
        if (marker === '+') addition ??= length;
        if (marker === '-') deletion ??= length;
        if (marker === ' ' || marker === '-') old++;
        if (marker === ' ' || marker === '+') next++;
        let width = end - at;
        for (let j = at; j < end; j++) if (text.charCodeAt(j) === 9) width += 3;
        if (width > columns) {
          columns = width;
          widest = text.slice(at, end);
        }
        at = end + 1;
        block.end = end;
      }
      blocks.push(block);
      if (old > block.old) oldBlocks.push(block);
      if (next > block.new) newBlocks.push(block);
    }
    firstChanges[hunk] = addition ?? deletion;
  }
  const cache = new Map<Block, Row[]>();
  function rows(block: Block) {
    const cached = cache.get(block);
    if (cached) return cached;
    const body = (hunks[block.hunk] ?? '').slice(block.at, block.end);
    const parsed = diffLines('@@ -' + block.old + ' +' + block.new + ' @@\n' + body).lines;
    if (cache.size >= 12) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    cache.set(block, parsed);
    return parsed;
  }
  function blockFor(row: number) {
    return row >= 0 && row < length ? lastAtOrBefore(blocks, row, (b) => b.row) : undefined;
  }
  function rowAt(row: number) {
    const block = blockFor(row);
    return block && rows(block)[row - block.row];
  }
  function find(side: Side, line: number) {
    const block = lastAtOrBefore(side === 'old' ? oldBlocks : newBlocks, line, (b) => b[side]);
    if (!block) return undefined;
    const index = rows(block).findIndex((r) => (side === 'old' ? r.oldLine : r.newLine) === line);
    return index < 0 ? undefined : block.row + index;
  }
  return { length, hunks, starts, firstChanges, widest, rowAt, find, blockFor };
}

export function fileDiff(full: string | null, saved: string) {
  const original = indexPatch(saved);
  const displayed = full === null || full === saved ? original : indexPatch(full);
  // Git and GitHub can align repeated lines differently. Each side still names the
  // same immutable source line, even when it has a different diff marker.
  function corresponding(row: Row | undefined, side: Side, target: typeof original) {
    const line = side === 'old' ? row?.oldLine : row?.newLine;
    if (!row || line == null) return undefined;
    const index = target.find(side, line);
    if (index === undefined) return undefined;
    return target.rowAt(index)?.text.slice(1) === row.text.slice(1) ? index : undefined;
  }
  function hunkAt(index: number, side: Side) {
    const row = displayed.rowAt(index);
    if (!row || (side === 'old' ? row.oldLine : row.newLine) === null) return -1;
    const savedRow = original === displayed ? index : corresponding(row, side, original);
    return savedRow === undefined ? -1 : (original.blockFor(savedRow)?.hunk ?? -1);
  }
  function displayPosition(hunk: number, row = 0) {
    const start = original.starts[hunk];
    if (start === undefined) return undefined;
    if (original === displayed) return start + row;
    const source = original.rowAt(start + row);
    return corresponding(source, source?.newLine == null ? 'old' : 'new', displayed);
  }
  return {
    length: displayed.length,
    widest: displayed.widest,
    rowAt: displayed.rowAt,
    find: displayed.find,
    savedHunks: original.hunks,
    firstChange(hunk: number) {
      const row = original.rowAt(original.firstChanges[hunk] ?? -1);
      if (!row || original === displayed) return row;
      return corresponding(row, row.newLine === null ? 'old' : 'new', displayed) === undefined
        ? undefined
        : row;
    },
    hunkAt,
    displayPosition,
  };
}
export type FileDiff = ReturnType<typeof fileDiff>;

// Chromium caps the height of a scroll container. Keep exceptionally tall files in
// independently scrollable sections, with the same absolute line numbers throughout.
export const filePageRows = 100_000;
export const filePageScroll = 100_000_000;

export function fileDiffPage(diff: FileDiff, page: number): FileDiff {
  if (diff.length <= filePageRows) return diff;
  const start = page * filePageRows;
  const length = Math.min(filePageRows, diff.length - start);
  function relative(row: number | undefined) {
    return row !== undefined && row >= start && row < start + length ? row - start : undefined;
  }
  return {
    ...diff,
    length,
    rowAt: (i) => (i >= 0 && i < length ? diff.rowAt(start + i) : undefined),
    find: (side, line) => relative(diff.find(side, line)),
    hunkAt: (i, side) => (i >= 0 && i < length ? diff.hunkAt(start + i, side) : -1),
    displayPosition: (hunk, row) => relative(diff.displayPosition(hunk, row)),
  };
}
