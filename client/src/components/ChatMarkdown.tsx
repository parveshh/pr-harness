import {
  createContext,
  memo,
  useContext,
  useId,
  useMemo,
  useState,
  type ComponentPropsWithoutRef,
} from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { BookOpen, ChevronDown } from 'lucide-react';
import { Button, Dialog, DialogTrigger, Popover } from 'react-aria-components';
import { citationMarkers } from '../../../shared/markdown-citations.js';
import type { Citation, SourceCitation } from '../../../shared/assistant.js';
import { webLink } from '../../../shared/workspace.js';

type CitationGroup = { start: number; end: number; sources: Set<Citation | SourceCitation> };
const ChatLinks = createContext<{
  prefix: string;
  referencePrefix: string;
  groups: CitationGroup[];
  openLink: (url: string) => void;
  onCite: ((cite: Citation | SourceCitation) => void) | undefined;
} | null>(null);
function useChatLinks() {
  const context = useContext(ChatLinks);
  if (!context) throw Error('Chat links require a Markdown answer.');
  return context;
}

function ReferenceLink({
  cite,
  full = false,
  close,
}: {
  cite: Citation | SourceCitation;
  full?: boolean;
  close?: () => void;
}) {
  const { onCite } = useChatLinks();
  const location =
    cite.path +
    ':' +
    cite.line +
    (cite.side === 'old' || cite.side === 'before' ? ' (original)' : '');
  const label = 'Open ' + location;
  const props = {
    className: full ? 'source-location' : 'cite',
    title: location,
    'aria-label': label,
  };
  const content = full ? location : location.slice(location.lastIndexOf('/') + 1);
  return (
    <button
      {...props}
      type="button"
      onClick={() => {
        close?.();
        onCite?.(cite);
      }}
    >
      {content}
    </button>
  );
}

function MarkdownLink({ href, children, id, 'aria-label': label }: ComponentPropsWithoutRef<'a'>) {
  const { prefix, referencePrefix, groups, openLink } = useChatLinks();
  if (href?.startsWith(referencePrefix)) {
    const group = groups[Number(href.slice(referencePrefix.length))];
    if (group) {
      const sources = Array.from(group.sources);
      const first = sources[0];
      if (sources.length === 1 && first) return <ReferenceLink cite={first} />;
      return (
        <DialogTrigger>
          <Button className="cite source-picker-trigger">
            <BookOpen size={12} aria-hidden />
            <span>{sources.length} sources</span>
            <ChevronDown size={12} aria-hidden />
          </Button>
          <Popover className="citation-popover" placement="bottom start">
            <Dialog aria-label="Cited lines">
              {({ close }) => (
                <>
                  <strong>Cited lines</strong>
                  <ul>
                    {sources.map((cite) => (
                      <li key={cite.id}>
                        <ReferenceLink cite={cite} full close={close} />
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </Dialog>
          </Popover>
        </DialogTrigger>
      );
    }
  }
  if (href?.startsWith('#' + prefix))
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
  const link = webLink.safeParse(href);
  if (!link.success) return <>{children}</>;
  return (
    <a
      href={link.data}
      title={link.data}
      onClick={(e) => {
        e.preventDefault();
        openLink(link.data);
      }}
    >
      {children}
    </a>
  );
}

const markdownComponents: Components = {
  img: ({ alt }) => <>{alt}</>,
  a: MarkdownLink,
  table: ({ children }) => (
    <div className="markdown-table">
      <table>{children}</table>
    </div>
  ),
};

export const ChatMarkdown = memo(function ChatMarkdown({
  text,
  citations,
  sourceCitations,
  onCite,
}: {
  text: string;
  citations?: Citation[];
  sourceCitations?: SourceCitation[] | undefined;
  onCite?: (citation: Citation | SourceCitation) => void;
}) {
  const [error, setError] = useState('');
  const prefix = 'chat-' + useId() + '-';
  const referencePrefix = '#' + prefix + 'citation-';
  const { markdown, references, groups } = useMemo(() => {
    const available = new Map<number, Citation | SourceCitation>();
    for (const source of sourceCitations ?? []) available.set(source.id, source);
    for (const cite of citations ?? []) available.set(cite.id, cite);
    const references = new Map<number, Citation | SourceCitation>();
    const groups: CitationGroup[] = [];
    for (const marker of available.size ? citationMarkers(text) : []) {
      const cite = available.get(marker.id);
      if (!cite) continue;
      references.set(cite.id, cite);
      const previous = groups.at(-1);
      if (previous && /^[ \t]*(?:,[ \t]*)?$/.test(text.slice(previous.end, marker.start))) {
        previous.end = marker.end;
        previous.sources.add(cite);
      } else {
        groups.push({ start: marker.start, end: marker.end, sources: new Set([cite]) });
      }
    }
    let cursor = 0;
    const parts = groups.map(({ start, end }, index) => {
      const fragment = text.slice(cursor, start) + '[source](' + referencePrefix + index + ')';
      cursor = end;
      return fragment;
    });
    return { markdown: parts.join('') + text.slice(cursor), references, groups };
  }, [text, citations, sourceCitations, referencePrefix]);
  function openLink(url: string) {
    setError('');
    const source = sourceCitations?.find((cite) => cite.url === url);
    if (source && onCite) {
      onCite(source);
      return;
    }
    void window.reviewer
      .openChatLink(url)
      .catch(() => setError('Could not open the link in your browser.'));
  }
  return (
    <ChatLinks.Provider value={{ prefix, referencePrefix, groups, openLink, onCite }}>
      <div className="chat-markdown">
        <Markdown
          skipHtml
          remarkPlugins={[remarkGfm]}
          remarkRehypeOptions={{ clobberPrefix: prefix }}
          components={markdownComponents}
        >
          {markdown}
        </Markdown>
        {references.size > 0 && (
          <details className="answer-sources">
            <summary>Sources ({references.size})</summary>
            <ul>
              {Array.from(references.values(), (cite) => (
                <li key={cite.id}>
                  <ReferenceLink cite={cite} full />
                </li>
              ))}
            </ul>
          </details>
        )}
        {error && <small role="alert">{error}</small>}
      </div>
    </ChatLinks.Provider>
  );
});
