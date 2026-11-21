import { useEffect } from 'react';

export function useScrollIndicators() {
  useEffect(() => {
    const timers = new Map<HTMLElement, number>();
    function show(event: Event) {
      const pane = event.target;
      if (!(pane instanceof HTMLElement)) return;
      pane.dataset.scrolling = 'true';
      window.clearTimeout(timers.get(pane));
      timers.set(
        pane,
        window.setTimeout(() => {
          delete pane.dataset.scrolling;
          timers.delete(pane);
        }, 650),
      );
    }
    document.addEventListener('scroll', show, { capture: true, passive: true });
    return () => {
      document.removeEventListener('scroll', show, true);
      for (const [pane, timer] of timers) {
        window.clearTimeout(timer);
        delete pane.dataset.scrolling;
      }
    };
  }, []);
}
