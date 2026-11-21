import type { ReactNode } from 'react';
import { Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components';
import { FolderGit2, X } from 'lucide-react';

export function WorkspaceDialog({
  title,
  onClose,
  children,
  busy = false,
  icon,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  busy?: boolean;
  icon?: ReactNode;
  wide?: boolean;
}) {
  return (
    <ModalOverlay
      className="overlay"
      isOpen
      isDismissable={!busy}
      isKeyboardDismissDisabled={busy}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Modal className={wide ? 'repo-dialog review-dialog' : 'repo-dialog'}>
        <Dialog className="dialog-body" aria-label={title}>
          <div className="dialog-head">
            <span className="dialog-emblem">{icon ?? <FolderGit2 size={23} />}</span>
            <button
              className="icon-control"
              type="button"
              aria-label="Close"
              disabled={busy}
              onClick={onClose}
            >
              <X size={17} />
            </button>
          </div>
          <Heading slot="title" className="dialog-title">
            {title}
          </Heading>
          {children}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
