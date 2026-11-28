import {
  GitPullRequest,
  ListChecks,
  Sparkles,
  CircleCheck,
  LoaderCircle,
  FolderGit2,
} from 'lucide-react';
import type { RepositoryGroup } from '../../shared/repository-groups.js';
import { DraftLabel, PrNumberLink } from './components/PrMetadata.js';
import { useWorkingPrs } from './chatRuns.js';
import type { PrCommand } from './Reader.js';
import type { Repository } from '../../shared/assistant.js';
import type { RunKind } from '../../shared/chat-runs.js';

type QueuePull = Pick<
  Repository['pulls'][number],
  'number' | 'title' | 'author' | 'isDraft' | 'approved' | 'unseen'
>;
// One open pull request with its review, summarise and approve actions. `repository` is
// given where a list spans repositories, and then also tells same-numbered PRs apart.
export function PullRequestRow({
  url,
  pull: p,
  repository,
  note,
  run,
  open,
  onError,
}: {
  url: string;
  pull: QueuePull;
  repository?: string;
  note?: string;
  // The kind of answer being written for this PR, if one is running.
  run: RunKind | undefined;
  open: (url: string, kind?: PrCommand['kind']) => void;
  onError: (message: string) => void;
}) {
  const subject = 'pull request ' + (repository ? repository + ' ' : '') + '#' + p.number;
  const working = run
    ? run === 'summary'
      ? 'Summarising'
      : run === 'review'
        ? 'Reviewing'
        : 'Answering a question in'
    : null;
  return (
    <div
      className="monitored-pr"
      data-approved={p.approved || undefined}
      data-new={p.unseen || undefined}
      data-working={!!run || undefined}
    >
      <PrNumberLink url={url} onError={onError} />
      <button className="monitored-open" onClick={() => open(url)}>
        <strong>{p.title}</strong>
        {repository && <small>{repository}</small>}
        <small>@{p.author}</small>
        {note && <small>{note}</small>}
        {p.isDraft && <DraftLabel />}
        {p.unseen && <b className="monitored-new">New</b>}
      </button>
      <span className="monitored-actions">
        {working ? (
          <span
            className="monitored-working"
            role="status"
            aria-label={working + ' ' + subject}
            title={working + ' this PR. Open it to follow or cancel.'}
          >
            <LoaderCircle className="spin" size={14} aria-hidden />
          </span>
        ) : (
          <>
            <button
              aria-label={'Review ' + subject}
              title="Review this PR for findings"
              onClick={() => open(url, 'review')}
            >
              <ListChecks size={14} />
            </button>
            <button
              aria-label={'Summarise ' + subject}
              title="Summarise this PR"
              onClick={() => open(url, 'summarise')}
            >
              <Sparkles size={14} />
            </button>
          </>
        )}
        <button
          aria-label={(p.approved ? 'Approved. Review ' : 'Approve ') + subject}
          title={
            p.approved
              ? 'You approved this PR. Review it again'
              : 'Approve this PR. You confirm before it is sent'
          }
          onClick={() => open(url, 'approve')}
        >
          <CircleCheck size={14} />
        </button>
      </span>
    </div>
  );
}

export function PullRequestQueue({
  group: { kind, key: repository, monitored, pulls, saved },
  open,
  openSaved,
  onError,
}: {
  onError: (message: string) => void;
  group: RepositoryGroup;
  open: (url: string, kind?: PrCommand['kind']) => void;
  openSaved: (url: string) => void;
}) {
  const workingPrs = useWorkingPrs();
  return (
    <>
      {(pulls.length > 0 || saved.length > 0) && (
        <p className="queue-hint">
          {saved.some((item) => item.local)
            ? 'Select a branch to continue reviewing.'
            : 'Select a pull request to start reviewing.'}
        </p>
      )}
      {monitored?.error && <p role="status">Refresh failed. Showing saved results.</p>}
      {pulls.length > 0 && (
        <section className="pr-queue" aria-label="Monitored pull requests">
          {pulls.map(({ url, pull }) => (
            // An answer for this PR may be running while another PR is open.
            <PullRequestRow
              key={pull.number}
              url={url}
              pull={pull}
              run={workingPrs.get(url)}
              open={open}
              onError={onError}
            />
          ))}
        </section>
      )}
      {saved.length > 0 && (
        <section aria-label="Saved reviews" className="pr-queue">
          {pulls.length > 0 && <h2>Saved reviews</h2>}
          {saved.map((item) => (
            <div key={item.url} className="saved-review-row">
              {!item.local && <PrNumberLink url={item.url} onError={onError} />}
              <button
                aria-label={
                  item.local
                    ? undefined
                    : [
                        '#' + item.url.split('/').at(-1),
                        item.title ?? repository,
                        item.isDraft && 'Draft',
                      ]
                        .filter(Boolean)
                        .join(' ')
                }
                className="saved-link"
                title={item.local?.path}
                onClick={() => openSaved(item.url)}
              >
                {item.local ? (
                  <>
                    <FolderGit2 size={16} />
                    {item.local.branch ?? 'Detached HEAD'} → {item.local.baseBranch}
                  </>
                ) : (
                  <>
                    <GitPullRequest size={16} />
                    <strong>{item.title ?? repository}</strong>
                    {item.isDraft && <DraftLabel />}
                  </>
                )}
              </button>
            </div>
          ))}
        </section>
      )}
      {kind === 'github' && !pulls.length && !saved.length && (
        <div className="queue-empty">
          <GitPullRequest size={26} />
          <h2>
            {!monitored
              ? 'No open pull requests'
              : !monitored.watching.length
                ? 'Choose authors to follow'
                : monitored.error || !monitored.checked
                  ? 'No pull requests loaded'
                  : 'You’re all caught up'}
          </h2>
          <p>
            {!monitored
              ? 'Use Open review to open a pull request by URL.'
              : !monitored.watching.length
                ? 'Use Manage authors beside the repository to choose whose pull requests appear here.'
                : monitored.error || !monitored.checked
                  ? 'Refresh the repository from Manage authors.'
                  : 'No open pull requests from the authors you follow in ' + repository + '.'}
          </p>
        </div>
      )}
    </>
  );
}
