import { Component, createRef, Fragment, type ReactNode } from 'react';
import type { GroupImperativeHandle, Layout } from 'react-resizable-panels';
import { ResizableHandle, ResizablePanelGroup } from './Resizable.js';
import { reviewLayouts, type ReviewLayout, type ReviewPane } from '../reviewLayouts.js';

interface Props {
  layout: ReviewLayout;
  pane: ReviewPane;
  files: ReactNode;
  chat: ReactNode;
  chatOpen: boolean;
  children: ReactNode;
}

type ScrollPosition = { element: HTMLElement; left: number; top: number };

type PaneSnapshot = { positions: ScrollPosition[]; sizes: Layout };

export class ReviewPanes extends Component<Props> {
  private group = createRef<HTMLDivElement>();
  private sizes = createRef<GroupImperativeHandle>();

  // Moving existing panel DOM nodes can reset their native scroll offsets. Capture the
  // scrollable surfaces before React moves them, including full-file and re-review diffs.
  getSnapshotBeforeUpdate(previous: Props): PaneSnapshot | null {
    if (previous.layout === this.props.layout || !this.group.current) return null;
    const positions = Array.from(
      this.group.current.querySelectorAll<HTMLElement>(
        '.review-center, .diff-scroll, .pr-detail, .pr-conversation, .files-scroll, .chat-log, .review-chat form, .review-chat textarea',
      ),
      (element) => ({ element, left: element.scrollLeft, top: element.scrollTop }),
    );
    return { positions, sizes: this.sizes.current?.getLayout() ?? {} };
  }

  componentDidUpdate(_previous: Props, _state: unknown, snapshot: PaneSnapshot | null) {
    if (!snapshot) return;
    // Separators register their new neighbors in layout effects. Restore the widths by
    // panel ID once registration finishes, including a zero-width collapsed explorer.
    queueMicrotask(() => {
      const group = this.sizes.current;
      if (!group) return;
      const current = Object.keys(group.getLayout());
      if (
        current.length &&
        current.length === Object.keys(snapshot.sizes).length &&
        current.every((id) => id in snapshot.sizes)
      )
        group.setLayout(snapshot.sizes);
      for (const { element, left, top } of snapshot.positions) {
        if (element.scrollLeft !== left) element.scrollLeft = left;
        if (element.scrollTop !== top) element.scrollTop = top;
      }
    });
  }

  render() {
    const { layout, pane, files, chat, chatOpen, children } = this.props;
    const panels = { files, diff: children, chat };
    const order = reviewLayouts[layout];
    const visible = order.filter((id) => panels[id] && (id !== 'chat' || chatOpen));
    return (
      <ResizablePanelGroup
        id={chatOpen ? 'review-with-chat' : 'review-reading'}
        elementRef={this.group}
        groupRef={this.sizes}
        className="reading-grid workbench"
        data-pane={pane}
      >
        {order.map((id) => {
          const index = visible.indexOf(id);
          const next = index >= 0 ? visible[index + 1] : undefined;
          return (
            <Fragment key={id}>
              {panels[id]}
              {next && <ResizableHandle key={next} label={'Resize ' + id + ' and ' + next} />}
            </Fragment>
          );
        })}
      </ResizablePanelGroup>
    );
  }
}
