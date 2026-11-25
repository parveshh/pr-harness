import { useEffect, useEffectEvent } from 'react';
import { isEditableElement, shortcutFor, type ShortcutAction } from '../../shared/shortcuts.js';

const overlays =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [aria-modal="true"], dialog[open]';

function editableTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  for (let element: Element | null = target; element; element = element.parentElement)
    if (
      isEditableElement({
        tagName: element.tagName,
        isContentEditable: element instanceof HTMLElement && element.isContentEditable,
        role: element.getAttribute('role'),
      })
    )
      return true;
  return false;
}

// Routes single-key reader shortcuts to `onAction`. The listener exists only while `enabled`.
export function useShortcuts(enabled: boolean, onAction: (action: ShortcutAction) => void) {
  const handle = useEffectEvent((event: KeyboardEvent) => {
    const action = shortcutFor(event, {
      enabled,
      overlayOpen: document.querySelector(overlays) !== null,
      editableTarget: editableTarget(event.target),
    });
    if (!action) return;
    event.preventDefault();
    onAction(action);
  });
  useEffect(() => {
    if (!enabled) return;
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [enabled]);
}
