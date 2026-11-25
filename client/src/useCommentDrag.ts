import { useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';
import type { CommentAnchor } from '../../shared/publish.js';

type Side = CommentAnchor['side'];
type Range = Pick<CommentAnchor, 'side' | 'line' | 'startLine'>;
type Gesture = {
  pointer: number;
  side: Side;
  origin: number;
  x: number;
  y: number;
  originY: number;
  moved: boolean;
};

export function useCommentDrag(
  pane: RefObject<HTMLDivElement | null>,
  finish: (range: Range) => void,
  // True for a windowed hunk, which must keep the row a drag started on rendered.
  trackOrigin: boolean,
) {
  const gesture = useRef<Gesture | null>(null),
    frame = useRef(0),
    suppressClick = useRef(false);
  const [preview, setPreview] = useState<Range | null>(null);
  // The line whose comment button holds the pointer. A windowed hunk keeps that row rendered
  // while the pane scrolls, because removing the button would drop its pointer capture.
  const [origin, setOrigin] = useState<Pick<Range, 'side' | 'line'> | null>(null);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  function hit(g: Gesture): Range | null {
    const row = document.elementFromPoint(g.x, g.y)?.closest<HTMLElement>('.diff-line');
    if (!row || !pane.current?.contains(row)) return null;
    if (g.side === 'old' && !row.classList.contains('deletion')) return null;
    const number = Number(g.side === 'old' ? row.dataset.oldLine : row.dataset.newLine);
    if (!number) return null;
    return {
      side: g.side,
      line: Math.max(g.origin, number),
      startLine: Math.min(g.origin, number),
    };
  }
  function track() {
    frame.current = 0;
    const g = gesture.current,
      element = pane.current;
    if (!g?.moved || !element) return;
    const next = hit(g);
    setPreview((previous) =>
      previous?.startLine === next?.startLine && previous?.line === next?.line ? previous : next,
    );
    const rect = element.getBoundingClientRect();
    if (g.x < rect.left || g.x > rect.right || g.y < rect.top || g.y > rect.bottom) return;
    const delta = g.y < rect.top + 24 ? -8 : g.y > rect.bottom - 24 ? 8 : 0;
    if (
      delta &&
      ((delta < 0 && element.scrollTop > 0) ||
        (delta > 0 && element.scrollTop + element.clientHeight < element.scrollHeight))
    ) {
      element.scrollTop += delta;
      frame.current = requestAnimationFrame(track);
    }
  }
  function clear() {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    gesture.current = null;
    setPreview(null);
    if (trackOrigin) setOrigin(null);
  }
  return {
    preview,
    origin,
    suppressClick,
    start(e: PointerEvent<HTMLButtonElement>, side: Side, line: number) {
      if (!e.isPrimary || e.button !== 0) return;
      suppressClick.current = false;
      gesture.current = {
        pointer: e.pointerId,
        side,
        origin: line,
        x: e.clientX,
        y: e.clientY,
        originY: e.clientY,
        moved: false,
      };
      if (trackOrigin) setOrigin({ side, line });
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    move: (e: PointerEvent<HTMLButtonElement>) => {
      const g = gesture.current;
      if (!g || g.pointer !== e.pointerId) return;
      g.x = e.clientX;
      g.y = e.clientY;
      if (Math.abs(g.y - g.originY) >= 4) g.moved = true;
      if (g.moved && !frame.current) track();
    },
    end: (e: PointerEvent<HTMLButtonElement>) => {
      const g = gesture.current;
      if (!g || g.pointer !== e.pointerId) return;
      g.x = e.clientX;
      g.y = e.clientY;
      suppressClick.current = g.moved || Math.abs(g.y - g.originY) >= 4;
      const range = suppressClick.current ? hit(g) : null;
      if (!e.currentTarget.contains(document.elementFromPoint(g.x, g.y)))
        suppressClick.current = true;
      clear();
      if (range) finish(range);
    },
    cancel: () => {
      if (!gesture.current) return;
      suppressClick.current = true;
      clear();
    },
  };
}
