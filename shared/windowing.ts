// Row windowing for long lists: which rows to render for a scroll position, and where each row
// sits when most rows share one height and a few (a line with a thread or an open editor) are
// taller. It holds no DOM state, so the reader and the file explorer share it and Node tests it.

// A hunk with more rows than this renders only the rows near the viewport.
export const hunkWindowThreshold = 1000;
// A file explorer that could show more rows than this does the same.
export const explorerWindowThreshold = 300;

export function shouldWindow(rows: number, threshold: number) {
  return rows > threshold;
}

export type RowRange = { start: number; end: number };
export type WindowSnapshot = RowRange & {
  // Height of all rows together.
  total: number;
  // False until a rendered row has supplied the common row height.
  measured: boolean;
  // Changes whenever a row offset may have changed.
  layout: number;
};
export type RowWindowOptions = {
  // Assumed height of a row until one has been measured.
  estimate?: number;
  // Rows kept rendered beyond each edge of the viewport.
  overscan?: number;
  // The rendered range moves in steps of this many rows, so most scroll events change nothing.
  step?: number;
};
export type Segment = { kind: 'row'; index: number } | { kind: 'gap'; key: string; height: number };
export type Align = 'nearest' | 'center';

export type RowWindow = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => WindowSnapshot;
  // `scrollTop` is measured from the top of the first row.
  setViewport: (scrollTop: number, height: number) => void;
  // Records measured row heights. `common` is the height of a row with nothing beneath it.
  measure: (heights: Iterable<readonly [index: number, height: number]>, common?: number) => void;
  offsetOf: (index: number) => number;
  heightOf: (index: number) => number;
  // The row that contains `offset`, clamped to the list.
  indexAt: (offset: number) => number;
  // The scroll position that shows row `index`, from the current viewport.
  scrollTopFor: (index: number, align: Align) => number;
};

const sameHeight = (a: number, b: number) => Math.abs(a - b) < 0.01;

export function createRowWindow(count: number, options: RowWindowOptions = {}): RowWindow {
  const overscan = options.overscan ?? 24,
    step = Math.max(1, options.step ?? 8);
  let estimate = options.estimate ?? 24,
    measured = false,
    scrollTop = 0,
    viewport = 0,
    layout = 0;
  // Only rows whose height differs from the common one are stored.
  const exceptions = new Map<number, number>();
  // A Fenwick tree over each row's difference from the common height.
  let tree = new Float64Array(count + 1);
  const listeners = new Set<() => void>();

  function add(index: number, delta: number) {
    for (let at = index + 1; at <= count; at += at & -at) tree[at] = (tree[at] ?? 0) + delta;
  }
  function rebuild() {
    tree = new Float64Array(count + 1);
    for (const [index, height] of exceptions) add(index, height - estimate);
  }
  function offsetOf(index: number) {
    const rows = Math.max(0, Math.min(count, Math.floor(index)));
    let extra = 0;
    for (let at = rows; at > 0; at -= at & -at) extra += tree[at] ?? 0;
    return rows * estimate + extra;
  }
  function heightOf(index: number) {
    return index < 0 || index >= count ? 0 : (exceptions.get(index) ?? estimate);
  }
  function indexAt(offset: number) {
    if (count === 0) return 0;
    // Descend the tree to the last row that starts at or before `offset`.
    let at = 0,
      before = 0;
    let top = 1;
    while (top * 2 <= count) top *= 2;
    for (let bit = top; bit >= 1; bit /= 2) {
      const next = at + bit;
      if (next > count) continue;
      const end = before + bit * estimate + (tree[next] ?? 0);
      if (end <= offset) {
        at = next;
        before = end;
      }
    }
    return Math.min(count - 1, at);
  }
  function range(): RowRange {
    if (count === 0) return { start: 0, end: 0 };
    const first = indexAt(scrollTop),
      last = indexAt(scrollTop + Math.max(viewport, estimate));
    return {
      start: Math.max(0, Math.floor((first - overscan) / step) * step),
      end: Math.min(count, Math.ceil((last + 1 + overscan) / step) * step),
    };
  }
  let snapshot: WindowSnapshot = { ...range(), total: offsetOf(count), measured, layout };
  function publish() {
    const next = range();
    if (
      next.start === snapshot.start &&
      next.end === snapshot.end &&
      measured === snapshot.measured &&
      layout === snapshot.layout
    )
      return;
    snapshot = { ...next, total: offsetOf(count), measured, layout };
    for (const listener of [...listeners]) listener();
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    setViewport(top, height) {
      scrollTop = Math.max(0, top);
      viewport = Math.max(0, height);
      publish();
    },
    measure(heights, common) {
      let changed = false;
      if (common !== undefined && common > 0 && (!measured || !sameHeight(common, estimate))) {
        estimate = common;
        measured = true;
        for (const [index, height] of exceptions)
          if (sameHeight(height, estimate)) exceptions.delete(index);
        rebuild();
        changed = true;
      }
      for (const [index, height] of heights) {
        if (!Number.isInteger(index) || index < 0 || index >= count || !(height >= 0)) continue;
        const known = heightOf(index);
        if (sameHeight(known, height)) continue;
        if (sameHeight(height, estimate)) exceptions.delete(index);
        else exceptions.set(index, height);
        add(index, height - known);
        changed = true;
      }
      if (changed) layout++;
      publish();
    },
    offsetOf,
    heightOf,
    indexAt,
    scrollTopFor(index, align) {
      const top = offsetOf(index),
        height = heightOf(index),
        limit = Math.max(0, offsetOf(count) - viewport);
      let target = scrollTop;
      if (align === 'center') target = top - (viewport - height) / 2;
      else if (top < scrollTop) target = top;
      else if (top + height > scrollTop + viewport) target = top + height - viewport;
      return Math.max(0, Math.min(limit, target));
    },
  };
}

// The rows to render, in order, with a gap standing in for each run of rows left out.
// `pinned` rows are rendered wherever the window is: they hold state, focus or a measurement.
export function windowSegments(
  range: RowRange,
  pinned: Iterable<number>,
  count: number,
  offsetOf: (index: number) => number,
): Segment[] {
  const rows = new Set<number>();
  for (const index of pinned)
    if (Number.isInteger(index) && index >= 0 && index < count) rows.add(index);
  for (let index = Math.max(0, range.start); index < Math.min(count, range.end); index++)
    rows.add(index);
  const segments: Segment[] = [];
  let next = 0;
  // A gap is keyed by the row after it, so rows that stay rendered never change order among
  // the list's children. Reordering would move a row's element, which drops a pointer capture.
  const gap = (until: number) =>
    segments.push({
      kind: 'gap',
      key: until < count ? 'gap-before-' + until : 'gap-end',
      height: offsetOf(until) - offsetOf(next),
    });
  for (const index of [...rows].sort((a, b) => a - b)) {
    if (index > next) gap(index);
    segments.push({ kind: 'row', index });
    next = index + 1;
  }
  if (next < count) gap(count);
  return segments;
}
