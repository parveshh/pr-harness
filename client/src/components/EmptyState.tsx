// Adapted from Dethink Components' EmptyState. See Dethink-LICENSE.txt.
import type { ReactNode } from 'react';

export function EmptyState({
  visual,
  title,
  description,
}: {
  visual: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div data-slot="empty-state" className="empty-state">
      <div aria-hidden="true" data-slot="empty-state-visual">
        {visual}
      </div>
      <div data-slot="empty-state-copy">
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
    </div>
  );
}
