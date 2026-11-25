import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';
import { createRowWindow, windowSegments, type Segment } from '../../shared/windowing.js';

// Renders only the rows of a long list that are near the viewport of `scroller`.
//
// The caller renders `segments` inside `list`: each row as a direct child carrying
// `data-row={index}`, plus `data-plain` when nothing sits beneath the row, and each gap as an
// empty element of the given height. Row heights are measured as rows appear and resize.
// `pinned` rows stay rendered wherever the window is, as does the row that holds focus.
export function useRowWindow({
  enabled,
  count,
  scroller: scrollerRef,
  list: listRef,
  pinned,
  initialScroll = 0,
}: {
  enabled: boolean;
  count: number;
  scroller: RefObject<HTMLElement | null>;
  list: RefObject<HTMLElement | null>;
  pinned: readonly number[];
  // Where to scroll once row heights are known, for a restored reading position.
  initialScroll?: number;
}) {
  const rows = enabled ? count : 0;
  const rowWindow = useMemo(() => createRowWindow(rows), [rows]);
  const snapshot = useSyncExternalStore(rowWindow.subscribe, rowWindow.getSnapshot);
  const [focused, setFocused] = useState<number | null>(null);
  const segments: Segment[] | null = enabled
    ? windowSegments(
        snapshot,
        focused === null ? pinned : [...pinned, focused],
        rows,
        rowWindow.offsetOf,
      )
    : null;

  // Rows start below anything else in the scroller, such as a hunk header or padding.
  const lead = useCallback(() => {
    const pane = scrollerRef.current,
      host = listRef.current;
    if (!pane || !host) return 0;
    return host.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
  }, [scrollerRef, listRef]);
  const sync = useCallback(() => {
    const pane = scrollerRef.current;
    if (pane) rowWindow.setViewport(pane.scrollTop - lead(), pane.clientHeight);
  }, [scrollerRef, rowWindow, lead]);
  const measure = useCallback(
    (elements: Iterable<Element>) => {
      const heights: [number, number][] = [];
      // Plain rows share one height. Take the most frequent, so a line made taller by an
      // unusual glyph is recorded as an exception instead of redefining every row.
      const plain = new Map<number, number>();
      let smallest = Infinity;
      for (const element of elements) {
        if (!(element instanceof HTMLElement) || element.dataset.row === undefined) continue;
        const height = element.getBoundingClientRect().height;
        // A hidden pane reports no height. Keep what was measured while it was visible.
        if (!height) continue;
        heights.push([Number(element.dataset.row), height]);
        smallest = Math.min(smallest, height);
        if (element.dataset.plain === undefined) continue;
        const rounded = Math.round(height * 100) / 100;
        plain.set(rounded, (plain.get(rounded) ?? 0) + 1);
      }
      if (!heights.length) return;
      let common: number | undefined,
        most = 0;
      for (const [height, rows] of plain)
        if (rows > most) {
          common = height;
          most = rows;
        }
      const known = rowWindow.getSnapshot().measured;
      // Once known, the shared height changes only when several rows agree, as after a new font.
      if (known && most < 3) common = undefined;
      else if (!known) common ??= smallest;
      rowWindow.measure(heights, common);
    },
    [rowWindow],
  );

  const observer = useRef<ResizeObserver | null>(null);
  const observed = useRef(new Set<Element>());
  useLayoutEffect(() => {
    const pane = scrollerRef.current,
      host = listRef.current;
    if (!enabled || !pane || !host) return;
    const watching = observed.current;
    const resize = new ResizeObserver((entries) => {
      const changed: Element[] = [];
      for (const entry of entries) if (entry.target !== pane) changed.push(entry.target);
      measure(changed);
      sync();
    });
    observer.current = resize;
    resize.observe(pane);
    function focusIn(event: FocusEvent) {
      const row = event.target instanceof Element ? event.target.closest('[data-row]') : null;
      setFocused(
        row instanceof HTMLElement && row.parentElement === host ? Number(row.dataset.row) : null,
      );
    }
    function focusOut(event: FocusEvent) {
      if (!(event.relatedTarget instanceof Node) || !host?.contains(event.relatedTarget))
        setFocused(null);
    }
    pane.addEventListener('scroll', sync, { passive: true });
    host.addEventListener('focusin', focusIn);
    host.addEventListener('focusout', focusOut);
    // Measure before the first paint so a restored position lands on the right rows.
    measure(host.children);
    sync();
    return () => {
      resize.disconnect();
      observer.current = null;
      watching.clear();
      pane.removeEventListener('scroll', sync);
      host.removeEventListener('focusin', focusIn);
      host.removeEventListener('focusout', focusOut);
    };
  }, [enabled, scrollerRef, listRef, measure, sync]);
  // Watch each rendered row for a change of height, and stop watching rows that left.
  useLayoutEffect(() => {
    const resize = observer.current,
      host = listRef.current;
    if (!resize || !host) return;
    const present = new Set<Element>();
    for (const element of host.children) {
      if (!(element instanceof HTMLElement) || element.dataset.row === undefined) continue;
      present.add(element);
      if (observed.current.has(element)) continue;
      observed.current.add(element);
      resize.observe(element);
    }
    for (const element of observed.current)
      if (!present.has(element)) {
        observed.current.delete(element);
        resize.unobserve(element);
      }
  });

  // The snapshot the DOM was last rendered from. Scrolling waits for it to match the store,
  // because a position set against an out-of-date layout is clamped to that layout's height.
  const rendered = useRef(snapshot);
  const restored = useRef(false);
  const wanted = useRef<{ index: number; target: string | null } | null>(null);
  const settle = useCallback(() => {
    const pane = scrollerRef.current,
      host = listRef.current;
    const current = rowWindow.getSnapshot();
    if (!enabled || !pane || !host || !current.measured || rendered.current !== current) return;
    if (!restored.current) {
      restored.current = true;
      if (initialScroll) {
        pane.scrollTop = initialScroll;
        sync();
      }
    }
    const want = wanted.current;
    if (!want) return;
    const row = host.querySelector(':scope > [data-row="' + want.index + '"]');
    if (row) {
      wanted.current = null;
      const target = (want.target ? row.querySelector(want.target) : null) ?? row;
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } else pane.scrollTop = lead() + rowWindow.scrollTopFor(want.index, 'center');
    // Rendering the rows now in view runs this again, which finishes a jump to an unrendered row.
    sync();
  }, [enabled, scrollerRef, listRef, rowWindow, initialScroll, sync, lead]);
  useLayoutEffect(() => {
    rendered.current = snapshot;
    settle();
  }, [settle, snapshot]);

  // Scrolls row `index` into view, rendering it first when it is outside the window.
  // `target` selects the part of the row to show, such as a search match.
  const reveal = useCallback(
    (index: number, target: string | null = null) => {
      if (index < 0 || index >= rows) return;
      wanted.current = { index, target };
      settle();
    },
    [rows, settle],
  );
  return { segments, reveal };
}
