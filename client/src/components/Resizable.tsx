// Adapted from the Dethink resizable primitives. See Dethink-LICENSE.txt.
import { z } from 'zod';
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
  type GroupProps,
  type PanelProps,
} from 'react-resizable-panels';

const sizes = z.record(z.string(), z.number().min(0).max(100));
const layoutStorage = {
  getItem(key: string) {
    try {
      const value = localStorage.getItem(key);
      if (!value) return null;
      const layout = sizes.parse(JSON.parse(value));
      const total = Object.values(layout).reduce((sum, size) => sum + size, 0);
      return Math.abs(total - 100) < 0.1 ? value : null;
    } catch {
      return null;
    }
  },
  setItem(key: string, value: string) {
    localStorage.setItem(key, value);
  },
};

export function ResizablePanelGroup({
  id,
  restoreLayout = true,
  ...props
}: GroupProps & { id: string; restoreLayout?: boolean }) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id,
    storage: layoutStorage,
    onlySaveAfterUserInteractions: true,
  });
  return (
    <Group
      {...props}
      id={id}
      orientation="horizontal"
      defaultLayout={restoreLayout ? defaultLayout : undefined}
      onLayoutChanged={props.onLayoutChanged ?? onLayoutChanged}
      resizeTargetMinimumSize={{ coarse: 44, fine: 12 }}
      onPointerCancel={(event) => {
        if (event.currentTarget.querySelector(':scope > [data-separator="active"]')) {
          event.currentTarget.ownerDocument.dispatchEvent(
            new PointerEvent('pointerup', {
              pointerId: event.pointerId,
              pointerType: event.pointerType,
              clientX: event.clientX,
              clientY: event.clientY,
              button: 0,
            }),
          );
        }
      }}
    />
  );
}

export function ResizablePanel(props: PanelProps) {
  return <Panel {...props} style={{ overflow: 'hidden' }} />;
}

export function ResizableHandle({
  label,
  disabled = false,
}: {
  label: string;
  disabled?: boolean;
}) {
  return (
    <Separator className="pane-divider" aria-label={label} disabled={disabled} title={label} />
  );
}
