import { GitPullRequest, RefreshCw, UserRound } from 'lucide-react';
import type { ReactNode } from 'react';
import { reviewRequestUrl, type ReviewRequestInbox } from '../../shared/review-requests.js';
import { PullRequestRow } from './PullRequestQueue.js';
import { useWorkingPrs } from './chatRuns.js';
import type { PrCommand } from './Reader.js';

// Open pull requests that ask the signed-in GitHub CLI account for a review.
export function ReviewRequests({
  inbox,
  busy,
  refresh,
  open,
  openSettings,
  onError,
}: {
  // Null until the saved list has been read.
  inbox: ReviewRequestInbox | null;
  busy: boolean;
  refresh: () => void;
  open: (url: string, kind?: PrCommand['kind']) => void;
  openSettings: () => void;
  onError: (message: string) => void;
}) {
  const workingPrs = useWorkingPrs();
  const refreshButton = (
    <button className="quiet" disabled={busy} onClick={refresh}>
      <RefreshCw size={14} aria-hidden="true" /> {busy ? 'Refreshing…' : 'Refresh'}
    </button>
  );
  if (inbox === null || inbox.state === 'pending')
    return <p role="status">Loading review requests…</p>;
  if (inbox.state === 'signed-out')
    return (
      <Notice
        icon={<UserRound size={26} aria-hidden="true" />}
        title="Connect GitHub to see review requests"
        detail={inbox.message}
      >
        <button onClick={openSettings}>GitHub account settings</button>
        {refreshButton}
      </Notice>
    );
  if (inbox.state === 'unavailable')
    return (
      <Notice
        icon={<GitPullRequest size={26} aria-hidden="true" />}
        title="Review requests could not be loaded"
        detail={inbox.message}
      >
        {refreshButton}
      </Notice>
    );
  const { account, requests, checked, error } = inbox;
  return (
    <>
      <div className="queue-status">
        <span>
          Requested from @{account} · Checked {new Date(checked).toLocaleString()}
        </span>
        {refreshButton}
      </div>
      {error && <p role="status">Refresh failed. Showing saved results. {error}</p>}
      {requests.length > 0 ? (
        <section className="pr-queue" aria-label="Review requests">
          {requests.map((request) => {
            const url = reviewRequestUrl(request);
            return (
              <PullRequestRow
                key={url}
                url={url}
                pull={request}
                repository={request.repo}
                {...(request.via === 'team' ? { note: 'Team request' } : {})}
                run={workingPrs.get(url)}
                open={open}
                onError={onError}
              />
            );
          })}
        </section>
      ) : (
        <Notice
          icon={<GitPullRequest size={26} aria-hidden="true" />}
          title={error ? 'No review requests saved' : 'No review requests'}
          detail={
            error
              ? 'Refresh once GitHub can be reached.'
              : 'No open pull request on github.com is waiting for a review from @' + account + '.'
          }
        />
      )}
    </>
  );
}

function Notice({
  icon,
  title,
  detail,
  children,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  children?: ReactNode;
}) {
  return (
    <div className="queue-empty">
      {icon}
      <h2>{title}</h2>
      <p>{detail}</p>
      {children && <div className="queue-empty-actions">{children}</div>}
    </div>
  );
}
