import { useState } from 'react';
import { Button, Dialog, DialogTrigger, Popover } from 'react-aria-components';
import { Code2, Columns3, FolderTree, MessageSquare } from 'lucide-react';
import {
  layoutChoices,
  paneLabels,
  reviewLayouts,
  saveReviewLayout,
  type ReviewLayout,
} from '../reviewLayouts.js';

const icons = { files: FolderTree, diff: Code2, chat: MessageSquare };

export function ReviewLayoutPicker({
  layout,
  onChange,
}: {
  layout: ReviewLayout;
  onChange: (layout: ReviewLayout) => void;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  function choose(choice: ReviewLayout) {
    try {
      saveReviewLayout(choice);
      onChange(choice);
      setOpen(false);
    } catch {
      setError('Could not save the layout. Try again.');
    }
  }
  return (
    <DialogTrigger
      isOpen={open}
      onOpenChange={(next) => {
        setOpen(next);
        setError('');
      }}
    >
      <span title="Review layout">
        <Button aria-label="Review layout">
          <Columns3 size={18} aria-hidden="true" />
        </Button>
      </span>
      <Popover placement="right bottom" offset={8} className="layout-popover">
        <Dialog aria-label="Review layout">
          <h2>Review layout</h2>
          <p>Pane order after Repositories in wide windows</p>
          <div className="layout-choices">
            {layoutChoices.map((choice) => {
              const order = reviewLayouts[choice];
              return (
                <button
                  key={choice}
                  aria-pressed={layout === choice}
                  onClick={() => choose(choice)}
                >
                  <span className="layout-preview" aria-hidden="true">
                    {order.map((pane) => {
                      const Icon = icons[pane];
                      return (
                        <span key={pane} data-pane={pane}>
                          <Icon size={14} />
                        </span>
                      );
                    })}
                  </span>
                  {order.map((pane) => paneLabels[pane]).join(' → ')}
                </button>
              );
            })}
          </div>
          {error && <p role="alert">{error}</p>}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
