import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRowWindow,
  explorerWindowThreshold,
  hunkWindowThreshold,
  shouldWindow,
  windowSegments,
} from '../shared/windowing.js';

function measured(count: number, height = 20, options = { overscan: 2, step: 1 }) {
  const rows = createRowWindow(count, options);
  rows.measure([], height);
  return rows;
}

await test('windows only lists longer than their threshold', () => {
  assert.equal(shouldWindow(hunkWindowThreshold, hunkWindowThreshold), false);
  assert.equal(shouldWindow(hunkWindowThreshold + 1, hunkWindowThreshold), true);
  assert.equal(shouldWindow(60, hunkWindowThreshold), false);
  assert.equal(shouldWindow(explorerWindowThreshold + 1, explorerWindowThreshold), true);
});

await test('renders the rows in the viewport plus overscan for a scroll offset', () => {
  const rows = measured(50_000);
  rows.setViewport(0, 100);
  assert.deepEqual(
    { start: rows.getSnapshot().start, end: rows.getSnapshot().end },
    { start: 0, end: 8 },
  );
  // Rows 500 to 505 are in view: 10,000px to 10,100px at 20px a row.
  rows.setViewport(10_000, 100);
  const { start, end, total, measured: known } = rows.getSnapshot();
  assert.deepEqual(
    { start, end, total, known },
    { start: 498, end: 508, total: 1_000_000, known: true },
  );
  rows.setViewport(999_950, 100);
  assert.deepEqual(
    { start: rows.getSnapshot().start, end: rows.getSnapshot().end },
    { start: 49_995, end: 50_000 },
  );
});

await test('moves the rendered range in steps so most scroll events change nothing', () => {
  const rows = createRowWindow(10_000, { overscan: 10, step: 8 });
  rows.measure([], 20);
  let published = 0;
  rows.subscribe(() => published++);
  rows.setViewport(4_000, 200);
  const first = rows.getSnapshot();
  assert.deepEqual({ start: first.start, end: first.end }, { start: 184, end: 224 });
  assert.equal(published, 1);
  rows.setViewport(4_010, 200);
  rows.setViewport(4_039, 200);
  assert.equal(rows.getSnapshot(), first);
  assert.equal(published, 1);
  rows.setViewport(4_200, 200);
  assert.notEqual(rows.getSnapshot(), first);
  assert.equal(published, 2);
});

await test('uses the assumed height until a row is measured', () => {
  const rows = createRowWindow(100, { estimate: 30 });
  assert.equal(rows.getSnapshot().measured, false);
  assert.equal(rows.getSnapshot().total, 3_000);
  rows.measure([[0, 24.75]], 24.75);
  assert.equal(rows.getSnapshot().measured, true);
  assert.equal(rows.getSnapshot().total, 2_475);
  assert.equal(rows.offsetOf(40), 990);
});

await test('offsets and lookups account for rows measured taller than the rest', () => {
  const rows = measured(1_000);
  // A thread under row 10 and an open editor under row 500.
  rows.measure([
    [10, 140],
    [500, 220],
    [3, 20],
  ]);
  assert.equal(rows.heightOf(10), 140);
  assert.equal(rows.heightOf(11), 20);
  assert.equal(rows.offsetOf(10), 200);
  assert.equal(rows.offsetOf(11), 340);
  assert.equal(rows.offsetOf(501), 501 * 20 + 120 + 200);
  assert.equal(rows.offsetOf(1_000), 1_000 * 20 + 120 + 200);
  assert.equal(rows.getSnapshot().total, 20_320);
  assert.equal(rows.indexAt(0), 0);
  assert.equal(rows.indexAt(199.9), 9);
  assert.equal(rows.indexAt(200), 10);
  assert.equal(rows.indexAt(339), 10);
  assert.equal(rows.indexAt(340), 11);
  assert.equal(rows.indexAt(10_000_000), 999);
  for (const index of [0, 9, 10, 11, 499, 500, 501, 999])
    assert.equal(rows.indexAt(rows.offsetOf(index)), index);

  // The editor closes and the thread grows a reply.
  rows.measure([
    [500, 20],
    [10, 180],
  ]);
  assert.equal(rows.offsetOf(1_000), 1_000 * 20 + 160);
  assert.equal(rows.indexAt(rows.offsetOf(700)), 700);
});

await test('a changed common height keeps taller rows and recomputes every offset', () => {
  const rows = measured(100);
  rows.measure([[4, 90]]);
  const before = rows.getSnapshot().layout;
  // A larger code font: plain rows grow, the row with a thread reports its own new height.
  rows.measure([[4, 96]], 26);
  assert.equal(rows.offsetOf(4), 104);
  assert.equal(rows.offsetOf(5), 200);
  assert.equal(rows.getSnapshot().total, 99 * 26 + 96);
  assert.notEqual(rows.getSnapshot().layout, before);
});

await test('ignores measurements that cannot be a row height', () => {
  const rows = measured(10);
  const snapshot = rows.getSnapshot();
  rows.measure([
    [-1, 50],
    [10, 50],
    [2.5, 50],
    [3, Number.NaN],
    [4, 20],
  ]);
  assert.equal(rows.getSnapshot(), snapshot);
  rows.measure([], 0);
  assert.equal(rows.getSnapshot().total, 200);
});

await test('scrolls to a row by the nearest edge or the centre', () => {
  const rows = measured(1_000);
  rows.measure([[10, 140]]);
  rows.setViewport(4_000, 200);
  // Already in view.
  assert.equal(rows.scrollTopFor(rows.indexAt(4_100), 'nearest'), 4_000);
  // Above: align its top. Below: align its bottom.
  assert.equal(rows.scrollTopFor(10, 'nearest'), 200);
  assert.equal(rows.scrollTopFor(600, 'nearest'), rows.offsetOf(601) - 200);
  assert.equal(rows.scrollTopFor(600, 'center'), rows.offsetOf(600) - 90);
  // Clamped to the scrollable range.
  assert.equal(rows.scrollTopFor(0, 'center'), 0);
  assert.equal(rows.scrollTopFor(999, 'center'), rows.getSnapshot().total - 200);
});

await test('handles an empty list', () => {
  const rows = createRowWindow(0);
  rows.setViewport(100, 100);
  assert.deepEqual(
    {
      start: rows.getSnapshot().start,
      end: rows.getSnapshot().end,
      total: rows.getSnapshot().total,
    },
    { start: 0, end: 0, total: 0 },
  );
  assert.equal(rows.indexAt(50), 0);
  assert.deepEqual(windowSegments({ start: 0, end: 0 }, [], 0, rows.offsetOf), []);
});

await test('lays out rendered rows with gaps for the rows left out', () => {
  const rows = measured(1_000);
  rows.measure([[2, 100]]);
  // The window, a pinned row before it, one inside it and one after it.
  const segments = windowSegments(
    { start: 400, end: 403 },
    [2, 401, 900, 900, -1, 1_000],
    1_000,
    rows.offsetOf,
  );
  assert.deepEqual(segments, [
    { kind: 'gap', key: 'gap-before-2', height: 40 },
    { kind: 'row', index: 2 },
    { kind: 'gap', key: 'gap-before-400', height: 397 * 20 },
    { kind: 'row', index: 400 },
    { kind: 'row', index: 401 },
    { kind: 'row', index: 402 },
    { kind: 'gap', key: 'gap-before-900', height: 497 * 20 },
    { kind: 'row', index: 900 },
    { kind: 'gap', key: 'gap-end', height: 99 * 20 },
  ]);
  // Gaps and rows together are as tall as the whole list.
  const height = segments.reduce(
    (sum, segment) =>
      sum + (segment.kind === 'gap' ? segment.height : rows.heightOf(segment.index)),
    0,
  );
  assert.equal(height, rows.getSnapshot().total);
  assert.deepEqual(windowSegments({ start: 0, end: 3 }, [], 3, rows.offsetOf), [
    { kind: 'row', index: 0 },
    { kind: 'row', index: 1 },
    { kind: 'row', index: 2 },
  ]);
});

await test('rows that stay rendered keep their order when the window moves past a pinned row', () => {
  const rows = measured(1_000);
  const keys = (start: number) =>
    windowSegments({ start, end: start + 3 }, [500], 1_000, rows.offsetOf).map((segment) =>
      segment.kind === 'gap' ? segment.key : 'row-' + segment.index,
    );
  // The window scrolls up and leaves the pinned row behind. No kept child changes side.
  const around = keys(499),
    above = keys(200);
  assert.deepEqual(around, ['gap-before-499', 'row-499', 'row-500', 'row-501', 'gap-end']);
  assert.deepEqual(above, [
    'gap-before-200',
    'row-200',
    'row-201',
    'row-202',
    'gap-before-500',
    'row-500',
    'gap-end',
  ]);
  const kept = above.filter((key) => around.includes(key));
  assert.deepEqual(
    kept,
    around.filter((key) => kept.includes(key)),
  );
});

await test('finds rows in lists of one row, a power of two and one more', () => {
  for (const count of [1, 2, 64, 65, 1_024]) {
    const rows = measured(count);
    rows.measure([
      [0, 50],
      [count - 1, 0],
    ]);
    for (let index = 0; index < count - 1; index++)
      assert.equal(rows.indexAt(rows.offsetOf(index)), index, count + ' rows, row ' + index);
    assert.equal(rows.indexAt(rows.offsetOf(count) + 1), count - 1);
    assert.equal(rows.indexAt(-5), 0);
  }
});
