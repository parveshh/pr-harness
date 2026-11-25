import { GitPullRequestDraft } from 'lucide-react';
import { readableError } from '../../../shared/assistant.js';

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export function formatPrDate(timestamp: string) {
  return dateFormat.format(new Date(timestamp));
}

export function DraftLabel() {
  return (
    <span className="review-tag draft-tag">
      <GitPullRequestDraft size={12} aria-hidden="true" />
      Draft
    </span>
  );
}

export function CommitLink({
  url,
  head,
  onError,
}: {
  url: string;
  head: string;
  onError: (message: string) => void;
}) {
  return (
    <GitHubLink
      href={new URL('../commit/' + encodeURIComponent(head), url).href}
      title={'Open commit ' + head + ' on GitHub'}
      onError={onError}
    >
      {head.slice(0, 8)}
    </GitHubLink>
  );
}

export function PrNumberLink({
  url,
  onError,
}: {
  url: string;
  onError: (message: string) => void;
}) {
  const number = '#' + url.split('/').at(-1);
  return (
    <GitHubLink href={url} title={'Open PR ' + number + ' on GitHub'} onError={onError}>
      {number}
    </GitHubLink>
  );
}

function GitHubLink({
  href,
  title,
  onError,
  children,
}: {
  href: string;
  title: string;
  onError: (message: string) => void;
  children: string;
}) {
  return (
    <a
      className="pr-metadata-link"
      href={href}
      title={title}
      onClick={(event) => {
        event.preventDefault();
        window.reviewer.openChatLink(href).catch((error: unknown) => onError(readableError(error)));
      }}
    >
      <code>{children}</code>
    </a>
  );
}
