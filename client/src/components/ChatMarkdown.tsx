import { memo, useId, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { replaceCitations } from '../../../shared/markdown-citations.js';
import type { Citation, SourceCitation } from '../../../shared/assistant.js';
import { webLink } from '../../../shared/workspace.js';

export const ChatMarkdown = memo(function ChatMarkdown({
  text,
  citations,
  sourceCitations,
  onCite,
}: {
  text: string;
  citations?: Citation[];
  sourceCitations?: SourceCitation[] | undefined;
  onCite?: (citation: Citation) => void;
}) {
  const [error, setError] = useState('');
  const prefix = 'chat-' + useId() + '-';
  const referencePrefix = '#' + prefix + 'citation-';
  const markdown =
    citations?.length || sourceCitations?.length
      ? replaceCitations(text, (id, marker) =>
          citations?.some((c) => c.id === id) || sourceCitations?.some((c) => c.id === id)
            ? '[reference](' + referencePrefix + id + ')'
            : marker,
        )
      : text;
  return (
    <div className="chat-markdown">
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        remarkRehypeOptions={{ clobberPrefix: prefix }}
        components={{
          img: ({ alt }) => <>{alt}</>,
          a({ href, children, id, 'aria-label': label }) {
            let destination = href,
              labelText = children;
            if (href?.startsWith(referencePrefix)) {
              const cite = citations?.find(
                (c) => c.id === Number(href.slice(referencePrefix.length)),
              );
              if (cite && onCite)
                return (
                  <button
                    type="button"
                    className="cite"
                    title={cite.path + ' · ' + cite.side + ' line ' + cite.line}
                    onClick={() => onCite(cite)}
                  >
                    {cite.path}:{cite.line}
                    {cite.side === 'old' ? ' (old)' : ''}
                  </button>
                );
              const source = sourceCitations?.find(
                (c) => c.id === Number(href.slice(referencePrefix.length)),
              );
              if (source) {
                destination = source.url;
                labelText = source.path + ':' + source.line;
              }
            }
            if (destination === href && href?.startsWith('#' + prefix))
              return (
                <a
                  href={href}
                  onClick={(event) => {
                    event.preventDefault();
                    const target = event.currentTarget
                      .closest('.chat-markdown')
                      ?.querySelector<HTMLElement>('#' + CSS.escape(href.slice(1)));
                    if (target) {
                      if (!target.matches('a[href]')) target.tabIndex = -1;
                      target.focus({ preventScroll: true });
                      target.scrollIntoView({ block: 'nearest' });
                    }
                  }}
                  id={id}
                  aria-label={label}
                >
                  {children}
                </a>
              );
            const link = webLink.safeParse(destination);
            if (!link.success) return <>{children}</>;
            return (
              <a
                href={link.data}
                title={link.data}
                onClick={(e) => {
                  e.preventDefault();
                  setError('');
                  void window.reviewer
                    .openChatLink(link.data)
                    .catch(() => setError('Could not open the link in your browser.'));
                }}
              >
                {labelText}
              </a>
            );
          },
          table: ({ children }) => (
            <div className="markdown-table">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {markdown}
      </Markdown>
      {error && <small role="alert">{error}</small>}
    </div>
  );
});
