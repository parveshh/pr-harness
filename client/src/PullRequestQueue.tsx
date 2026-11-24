import {
  GitPullRequest,
  ListChecks,
  Sparkles,
  CircleCheck,
  LoaderCircle,
  FolderGit2,
} from 'lucide-react';
import type { RepositoryGroup } from '../../shared/repository-groups.js';
import { PrNumberLink } from './components/PrMetadata.js';
import { useWorkingPrs } from './chatRuns.js';
import type { PrCommand } from './Reader.js';

export function PullRequestQueue({
  group: { key: repository, monitored, pulls, saved },
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
          {pulls.map(({ url: pr, pull: p }) => {
            // An answer for this PR may be running while another PR is open.
            const run = workingPrs.get(pr);
            const working = run
              ? run === 'summary'
                ? 'Summarising'
                : run === 'review'
                  ? 'Reviewing'
                  : 'Answering a question in'
              : null;
            return (
              <div
                key={p.number}
                className="monitored-pr"
                data-approved={p.approved || undefined}
                data-new={p.unseen || undefined}
                data-working={!!run || undefined}
              >
                <PrNumberLink url={pr} onError={onError} />
                <button className="monitored-open" onClick={() => open(pr)}>
                  <strong>{p.title}</strong>
                  <small>@{p.author}</small>
                  {p.isDraft && <small className="review-tag">Draft</small>}
                  {p.unseen && <b className="monitored-new">New</b>}
                </button>
                <span className="monitored-actions">
                  {working ? (
                    <span
                      className="monitored-working"
                      role="status"
                      aria-label={working + ' pull request #' + p.number}
                      title={working + ' this PR. Open it to follow or cancel.'}
                    >
                      <LoaderCircle className="spin" size={14} aria-hidden />
                    </span>
                  ) : (
                    <>
                      <button
                        aria-label={'Review pull request #' + p.number}
                        title="Review this PR for findings"
                        onClick={() => open(pr, 'review')}
                      >
                        <ListChecks size={14} />
                      </button>
                      <button
                        aria-label={'Summarise pull request #' + p.number}
                        title="Summarise this PR"
                        onClick={() => open(pr, 'summarise')}
                      >
                        <Sparkles size={14} />
                      </button>
                    </>
                  )}
                  <button
                    aria-label={
                      (p.approved ? 'Approved. Review' : 'Approve') + ' pull request #' + p.number
                    }
                    title={
                      p.approved
                        ? 'You approved this PR. Review it again'
                        : 'Approve this PR. You confirm before it is sent'
                    }
                    onClick={() => open(pr, 'approve')}
                  >
                    <CircleCheck size={14} />
                  </button>
                </span>
              </div>
            );
          })}
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
                    {item.isDraft && <span className="review-tag">Draft</span>}
                  </>
                )}
              </button>
            </div>
          ))}
        </section>
      )}
      {!pulls.length && !saved.length && (
        <div className="queue-empty">
          <GitPullRequest size={26} />
          <h2>
            {!monitored?.watching.length
              ? 'Choose authors to follow'
              : monitored.error || !monitored.checked
                ? 'No pull requests loaded'
                : 'You’re all caught up'}
          </h2>
          <p>
            {!monitored?.watching.length
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
