import { reviewFileBytes } from './file-diff-limits.js';

// A complete saved Git patch pins every edit. Fill the gaps between its hunks
// from the immutable base blob, even if the local working tree has since moved.
export function expandSavedFileDiff(
  base: string,
  patch: string,
  maxBytes = reviewFileBytes,
): string | null {
  let newBytes = Buffer.byteLength(base);
  if (newBytes > maxBytes) return null;
  const output: string[] = [];
  let offset = 0,
    oldLines = 0,
    newLines = 0;
  function nextBaseLine() {
    const lf = base.indexOf('\n', offset);
    return lf < 0 ? base.length : lf + 1;
  }
  // Flush in chunks so a tall file doesn't allocate one string per unchanged line.
  function context(until: number) {
    let start = offset;
    function flush() {
      if (offset === start) return;
      const chunk = base.slice(start, offset).replace(/\n$/, '');
      output.push(' ' + chunk.replaceAll('\n', '\n '));
      start = offset;
    }
    while (offset < base.length && oldLines < until) {
      offset = nextBaseLine();
      oldLines++;
      newLines++;
      if (offset - start >= 65536) flush();
    }
    flush();
  }
  for (const hunk of patch.split(/\n(?=@@ )/)) {
    const [header, ...rows] = hunk.split('\n');
    const range = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header ?? '');
    if (!range) return null;
    const oldCount = Number(range[2] ?? 1),
      newCount = Number(range[4] ?? 1);
    const oldStart = Number(range[1]) - Number(oldCount > 0);
    const newStart = Number(range[3]) - Number(newCount > 0);
    context(oldStart);
    if (oldLines !== oldStart || newLines !== newStart) return null;
    for (const row of rows) {
      if (row.startsWith(' ') || row.startsWith('-')) {
        const end = nextBaseLine();
        if (end === offset || base.slice(offset, end).replace(/\n$/, '') !== row.slice(1))
          return null;
        if (row.startsWith('-')) newBytes -= Buffer.byteLength(base.slice(offset, end));
        offset = end;
        oldLines++;
      } else if (!row.startsWith('+') && row !== '\\ No newline at end of file') return null;
      if (row.startsWith('+')) newBytes += Buffer.byteLength(row.slice(1)) + 1;
      if (row.startsWith('\\') && output.at(-1)?.startsWith('+')) newBytes--;
      if (row.startsWith(' ') || row.startsWith('+')) newLines++;
      output.push(row);
    }
    if (oldLines !== oldStart + oldCount || newLines !== newStart + newCount) return null;
  }
  if (newBytes > maxBytes) return null;
  const hasTail = offset < base.length;
  context(Infinity);
  if (hasTail && !base.endsWith('\n')) output.push('\\ No newline at end of file');
  const range = (count: number) => (count ? '1,' + count : '0,0');
  return '@@ -' + range(oldLines) + ' +' + range(newLines) + ' @@\n' + output.join('\n');
}
