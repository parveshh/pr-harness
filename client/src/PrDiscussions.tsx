import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { ReviewMeta } from '../../shared/reader.js';
import type { Discussions, DiscussionThread } from '../../shared/discussions.js';
import { readableError } from '../../shared/assistant.js';
import { ChatMarkdown } from './components/ChatMarkdown.js';

const keyOf = (thread: DiscussionThread) => thread.kind + '-' + thread.id;

const sectionForKind = {
  inline: 'inline comments',
  review: 'review summaries',
  conversation: 'PR conversation',
} as const;

function mergePartialRead(previous: Discussions | null, fresh: Discussions): Discussions {
  const missing = fresh.unavailable;
  const base = fresh.anchorRevision;
  const prior = previous?.anchorRevision;
  if (
    !missing?.length ||
    !previous ||
    previous.account !== fresh.account ||
    !base ||
    !prior ||
    base.head !== prior.head ||
    base.base !== prior.base ||
    base.baseBranch !== prior.baseBranch
  )
    return fresh;
  const remaining = new Map(previous.threads.map((thread) => [keyOf(thread), thread]));
  const threads = fresh.threads.map((thread) => {
    const key = keyOf(thread);
    const old = remaining.get(key);
    remaining.delete(key);
    if (!old) return thread;
    const resolution =
      thread.resolution ?? (missing.includes('thread status') ? old.resolution : null);
    if (!missing.includes(sectionForKind[thread.kind])) return { ...thread, resolution };
    const messages = new Map(old.messages.map((m) => [m.id, m]));
    for (const m of thread.messages) messages.set(m.id, m);
    return { ...thread, resolution, messages: [...messages.values()].sort((a, b) => a.id - b.id) };
  });
  for (const old of remaining.values()) {
    if (missing.includes(sectionForKind[old.kind])) threads.push(old);
  }
  return { ...fresh, threads };
}

const pendingReplies = z.record(z.string(), z.object({ token: z.uuid(), body: z.string() }));
type PendingReplies = z.infer<typeof pendingReplies>;
function storageKey(url: string, account: string) {
  return 'discussion-replies:' + url + ':' + account;
}
function savePending(url: string, account: string, pending: PendingReplies) {
  const key = storageKey(url, account);
  if (Object.keys(pending).length) localStorage.setItem(key, JSON.stringify(pending));
  else localStorage.removeItem(key);
}
function location(thread: DiscussionThread) {
  if (thread.kind === 'review') return 'Review summary';
  if (!thread.path) return 'PR conversation';
  if (thread.line)
    return (
      thread.path +
      ':' +
      (thread.startLine && thread.startLine !== thread.line ? thread.startLine + '–' : '') +
      thread.line +
      (thread.side === 'LEFT' ? ' · original side' : '')
    );
  if (thread.originalLine) return thread.path + ':' + thread.originalLine + ' · original diff';
  return thread.path;
}

export function usePrDiscussions(
  url: string,
  revision: string | undefined,
  accountEpoch: string | null,
  lessonAction: (thread: DiscussionThread) => ReactNode,
) {
  const epoch = JSON.stringify([url, revision, accountEpoch]);
  const [loaded, setLoaded] = useState<{ epoch: string; value: Discussions } | null>(null);
  const data = loaded?.epoch === epoch ? loaded.value : null;
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState('');
  const [active, setActive] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<PendingReplies>({});
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [trackingUnavailable, setTrackingUnavailable] = useState(false);
  // The thread being resolved or reopened, and the last failure to do so.
  const [resolving, setResolving] = useState('');
  const [resolveError, setResolveError] = useState<{ key: string; message: string } | null>(null);
  const actor = useRef('');
  const version = useRef(0);
  const scope = useRef(epoch);
  useLayoutEffect(() => {
    version.current++;
    scope.current = epoch;
    return () => {
      scope.current = '';
    };
  }, [epoch]);
  const replyButtons = useRef(new Map<string, HTMLButtonElement>());
  function finish(key: string) {
    setActive('');
    requestAnimationFrame(() => replyButtons.current.get(key)?.focus());
  }

  useEffect(() => {
    if (!revision) return;
    let current = true;
    window.reviewer
      .discussions(url)
      .then((result) => {
        if (current) {
          setLoaded((prev) => ({
            epoch,
            value: mergePartialRead(prev?.epoch === epoch ? prev.value : null, result),
          }));
          setError('');
          setTrackingUnavailable(false);
          let saved: PendingReplies;
          try {
            saved = pendingReplies.parse(
              JSON.parse(localStorage.getItem(storageKey(url, result.account)) ?? '{}'),
            );
          } catch {
            setNeedsRefresh(true);
            setTrackingUnavailable(true);
            setActive('');
            setDrafts({});
            setPending({});
            actor.current = result.account;
            setError(
              'Your local reply recovery record is unavailable. You can still read the discussions. Check GitHub for any unconfirmed posts before clearing local reply tracking.',
            );
            return;
          }
          const recovered: string[] = [];
          for (const thread of result.threads) {
            for (const m of thread.messages) {
              if (m.author.toLowerCase() !== result.account) continue;
              const token = /<!-- local-reviewer-reply:([a-f0-9-]+) -->$/.exec(m.body)?.[1];
              if (!token) continue;
              for (const [key, attempt] of Object.entries(saved)) {
                if (token === attempt.token) {
                  recovered.push(key);
                  delete saved[key];
                }
              }
            }
          }
          if (recovered.length) {
            // The matching messages are already verified. A read-only browser store can reconcile again on reopen.
            try {
              savePending(url, result.account, saved);
            } catch {
              setError('Recovered the posted reply. Local tracking could not be updated.');
            }
          }
          const sameAccount = actor.current === result.account;
          actor.current = result.account;
          setDrafts((prev) => {
            const next = sameAccount ? { ...prev } : {};
            for (const key of recovered) delete next[key];
            for (const [key, attempt] of Object.entries(saved)) next[key] = attempt.body;
            return next;
          });
          setActive((prev) => (sameAccount && !recovered.includes(prev) ? prev : ''));
          setPending(saved);
          setNeedsRefresh(false);
        }
      })
      .catch((e: unknown) => {
        if (current) {
          // A failed read may mean the active GitHub account or its access changed.
          setLoaded(null);
          setError(readableError(e));
        }
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [url, refresh, revision, epoch]);

  async function post(thread: DiscussionThread) {
    const key = keyOf(thread);
    const body = drafts[key]?.trim();
    if (!data || !body || posting || resolving || loading || needsRefresh) return;
    const started = version.current;
    const reconcile = () => {
      if (scope.current === epoch && actor.current === data.account) {
        setLoading(true);
        setRefresh((n) => n + 1);
      }
    };
    const sentToken = pending[key]?.token ?? crypto.randomUUID();
    setPosting(true);
    setError('');
    try {
      const attempt = pending[key] ?? { token: sentToken, body };
      const updated = { ...pending, [key]: attempt };
      savePending(url, data.account, updated);
      setPending(updated);
      const reply = await window.reviewer.replyToDiscussion({
        token: attempt.token,
        url,
        account: data.account,
        id: thread.id,
        kind: thread.kind,
        body,
      });
      if (started !== version.current || scope.current !== epoch) {
        // A refresh or account change owns the visible data. Let a fresh read reconcile the saved token.
        reconcile();
        return;
      }
      const threads =
        thread.kind === 'inline'
          ? data.threads.map((t) =>
              keyOf(t) === key ? { ...t, messages: [...t.messages, reply] } : t,
            )
          : [
              {
                id: reply.id,
                kind: 'conversation' as const,
                path: null,
                line: null,
                originalLine: null,
                messages: [reply],
              },
              ...data.threads,
            ];
      const remaining = { ...pending };
      delete remaining[key];
      savePending(url, data.account, remaining);
      setPending(remaining);
      setLoaded({ epoch, value: { ...data, threads } });
      setDrafts((prev) => ({ ...prev, [key]: '' }));
      finish(key);
    } catch (e) {
      if (started !== version.current || scope.current !== epoch) {
        if (!pending[key] && readableError(e).startsWith('Reply was not sent.')) {
          // A definite rejection can release this attempt even if the user has changed accounts.
          try {
            const saved = pendingReplies.parse(
              JSON.parse(localStorage.getItem(storageKey(url, data.account)) ?? '{}'),
            );
            if (saved[key]?.token === sentToken) {
              delete saved[key];
              savePending(url, data.account, saved);
            }
          } catch {
            /* Preserve the recovery record for its owner to inspect. */
          }
        }
        reconcile();
        return;
      }
      const reason = readableError(e);
      if (!pending[key] && reason.startsWith('Reply was not sent.')) {
        try {
          savePending(url, data.account, pending);
          setPending(pending);
        } catch {
          /* Refresh exposes local tracking recovery when storage is unavailable. */
        }
      }
      setError(reason);
      setNeedsRefresh(true);
    } finally {
      setPosting(false);
    }
  }
  // Resolving is sent to GitHub at once. It is idempotent there, so a retry is safe.
  async function resolve(thread: DiscussionThread, resolved: boolean) {
    const key = keyOf(thread);
    if (!data || !thread.resolution || resolving || posting || loading || needsRefresh) return;
    const started = version.current;
    setResolving(key);
    setResolveError(null);
    try {
      const result = await window.reviewer.resolveDiscussion({
        url,
        account: data.account,
        node: thread.resolution.node,
        resolved,
      });
      // A refresh or account change owns the visible data and already has the new state.
      if (started !== version.current || scope.current !== epoch) return;
      // Apply to whatever is loaded now, so a change made meanwhile is kept.
      setLoaded((current) =>
        current?.epoch !== epoch
          ? current
          : {
              epoch,
              value: {
                ...current.value,
                threads: current.value.threads.map((t) =>
                  keyOf(t) === key && t.resolution
                    ? {
                        ...t,
                        resolution: {
                          ...t.resolution,
                          resolved: result.resolved,
                          canResolve: !result.resolved,
                          canUnresolve: result.resolved,
                        },
                      }
                    : t,
                ),
              },
            },
      );
    } catch (e) {
      if (scope.current === epoch) setResolveError({ key, message: readableError(e) });
    } finally {
      setResolving('');
    }
  }
  const reload = useCallback(() => {
    version.current++;
    setLoading(true);
    setError('');
    setRefresh((n) => n + 1);
  }, []);
  function renderThread(thread: DiscussionThread) {
    if (!data) return null;
    const key = keyOf(thread);
    const resolution = thread.resolution ?? null;
    const canReply =
      !posting &&
      !loading &&
      !needsRefresh &&
      !data.unavailable?.includes(sectionForKind[thread.kind]);
    const idle = !resolving && canReply && !data.unavailable?.includes('thread status');
    return (
      <section
        role="article"
        className="pr-discussion"
        data-resolved={resolution?.resolved || undefined}
        aria-label={location(thread) + ' · ' + thread.messages[0]?.author + ' · ' + thread.id}
        key={key}
      >
        <div className="discussion-heading">
          <strong>{location(thread)}</strong>
          {resolution?.resolved && <span className="discussion-resolved">Resolved</span>}
        </div>
        {thread.messages.map((m) => (
          <div className="discussion-message" key={m.id}>
            <small>
              @{m.author}
              {m.created && (
                <>
                  {' '}
                  · <time dateTime={m.created}>{new Date(m.created).toLocaleString()}</time>
                </>
              )}
            </small>
            <ChatMarkdown text={m.body} />
          </div>
        ))}
        {pending[key] && (
          <div>
            <p role="status">
              Delivery is unconfirmed. Check the discussion before retrying. A delayed reply may
              still appear on GitHub.
            </p>
            <button
              type="button"
              className="secondary"
              disabled={posting || loading}
              onClick={() => {
                const next = { ...pending };
                delete next[key];
                try {
                  savePending(url, data.account, next);
                } catch {
                  setError('Could not update local reply tracking.');
                  return;
                }
                setPending(next);
                setDrafts((previous) => ({ ...previous, [key]: '' }));
                finish(key);
              }}
            >
              Discard local attempt
            </button>
          </div>
        )}
        {active === key ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void post(thread);
            }}
          >
            <label>
              Reply as @{data.account}
              <textarea
                autoFocus
                rows={3}
                maxLength={60000}
                value={drafts[key] ?? ''}
                onChange={(e) => setDrafts({ ...drafts, [key]: e.target.value })}
                disabled={posting}
                readOnly={!!pending[key]}
              />
            </label>
            {thread.kind !== 'inline' && (
              <small>
                Your reply will appear in the PR conversation with a link to the original.
              </small>
            )}
            <div className="composer-actions">
              <button
                type="button"
                className="secondary"
                disabled={posting}
                onClick={() => finish(key)}
              >
                Cancel
              </button>
              <button type="submit" disabled={!canReply || !!resolving || !drafts[key]?.trim()}>
                {pending[key] ? 'Retry unconfirmed reply' : 'Post reply to GitHub'}
              </button>
            </div>
          </form>
        ) : (
          <div className="discussion-actions">
            <button
              type="button"
              className="secondary"
              disabled={!canReply}
              ref={(node) => {
                if (node) replyButtons.current.set(key, node);
                else replyButtons.current.delete(key);
              }}
              onClick={() => setActive(key)}
            >
              Reply
            </button>
            {resolution && !resolution.resolved && resolution.canResolve && (
              <button
                type="button"
                className="secondary"
                disabled={!idle}
                onClick={() => void resolve(thread, true)}
              >
                {resolving === key ? 'Resolving…' : 'Resolve conversation'}
              </button>
            )}
            {resolution?.resolved &&
              thread.path &&
              !data.unavailable?.includes('inline comments') &&
              !data.unavailable?.includes('thread status') &&
              lessonAction(thread)}
            {resolution?.resolved && resolution.canUnresolve && (
              <button
                type="button"
                className="secondary"
                disabled={!idle}
                onClick={() => void resolve(thread, false)}
              >
                {resolving === key ? 'Reopening…' : 'Reopen conversation'}
              </button>
            )}
          </div>
        )}
        {resolveError?.key === key && <p role="alert">{resolveError.message}</p>}
      </section>
    );
  }
  const problem =
    error ||
    (data?.unavailable?.length ? 'Could not load ' + data.unavailable.join(', ') + '.' : '');
  function overview(displayedPath: string | undefined) {
    // The selected file owns all its threads, including ones without a visible line.
    const threads =
      data?.threads.filter(
        (t) => t.kind !== 'inline' || !displayedPath || t.path !== displayedPath,
      ) ?? [];
    return (
      <div className="pr-conversation" aria-label="PR conversation">
        <h2>PR conversation{threads.length ? ' · ' + threads.length : ''}</h2>
        <div className="discussions-toolbar">
          <span>{data ? '@' + data.account : 'GitHub'}</span>
          <button className="secondary" disabled={posting || loading} onClick={reload}>
            Refresh discussions
          </button>
        </div>
        {problem && <p role="alert">{problem}</p>}
        {data && trackingUnavailable && (
          <button
            type="button"
            className="secondary"
            disabled={posting || loading}
            onClick={() => {
              try {
                localStorage.removeItem(storageKey(url, data.account));
                setError('');
                setLoading(true);
                setLoaded(null);
                setRefresh((n) => n + 1);
              } catch {
                setError(
                  'Local storage is unavailable. Restore storage access and refresh discussions.',
                );
              }
            }}
          >
            Clear local reply tracking
          </button>
        )}
        {loading && <p role="status">Loading discussions…</p>}
        {data && !loading && !problem && !threads.length && <p>No additional PR conversations.</p>}
        <div className="pr-discussions">{threads.map(renderThread)}</div>
      </div>
    );
  }
  function fileConversations(path: string | undefined, placed?: ReadonlySet<number>) {
    const threads = data?.threads.filter(
      (t) => t.kind === 'inline' && t.path === path && !placed?.has(t.id),
    );
    if (!threads?.length) return null;
    return (
      <section className="file-conversations" aria-label="File conversations">
        <h3>File conversations</h3>
        {threads.map(renderThread)}
      </section>
    );
  }
  return {
    data,
    renderThread,
    fileConversations,
    overview,
    reload,
    posting,
    loading,
    error: problem,
  };
}

function canAnchor(thread: DiscussionThread, data: Discussions, meta: ReviewMeta) {
  const revision = data.anchorRevision;
  return (
    thread.kind === 'inline' &&
    thread.path &&
    thread.line &&
    thread.side &&
    revision &&
    revision.head === meta.head &&
    revision.base === meta.base &&
    revision.baseBranch === meta.baseBranch
  );
}
export function discussionsByLine(
  data: Discussions | null,
  meta: ReviewMeta | undefined,
  path: string | undefined,
) {
  const result = new Map<string, DiscussionThread[]>();
  if (!data || !meta || !path) return result;
  for (const thread of data.threads) {
    if (thread.path !== path || !canAnchor(thread, data, meta)) continue;
    const key = thread.side + ':' + thread.line;
    const threads = result.get(key);
    if (threads) threads.push(thread);
    else result.set(key, [thread]);
  }
  return result;
}
