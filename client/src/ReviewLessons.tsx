import { useEffect, useState } from 'react';
import { Bookmark } from 'lucide-react';
import { readableError } from '../../shared/assistant.js';
import { discussionLink, type DiscussionThread } from '../../shared/discussions.js';
import type { ReviewLesson } from '../../shared/lessons.js';
import { WorkspaceDialog } from './components/WorkspaceDialog.js';

// Reader is keyed by PR URL. Repository data is available even when GitHub is offline.
export function useReviewLessons(url: string, ready: boolean) {
  const [items, setItems] = useState<ReviewLesson[] | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!ready) return;
    let current = true;
    window.reviewer
      .reviewLessons(url)
      .then((rows) => {
        if (current) setItems(rows);
      })
      .catch((e: unknown) => {
        if (current) setError(readableError(e));
      });
    return () => {
      current = false;
    };
  }, [url, ready, attempt]);
  return {
    items,
    setItems,
    error,
    retry: () => {
      setError('');
      setAttempt((n) => n + 1);
    },
  };
}

export function LessonEditor({
  url,
  thread,
  saved,
  onSaved,
  onClose,
}: {
  url: string;
  thread: DiscussionThread;
  saved: ReviewLesson | undefined;
  onSaved: (rows: ReviewLesson[]) => void;
  onClose: () => void;
}) {
  const [note, setNote] = useState(saved?.note ?? '');
  const [fragment, setFragment] = useState(saved?.fragment ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setBusy(true);
    setError('');
    try {
      onSaved(
        await window.reviewer.saveReviewLesson({
          sourceUrl: url,
          threadId: thread.id,
          note,
          fragment,
        }),
      );
      onClose();
    } catch (e) {
      setError(readableError(e));
      setBusy(false);
    }
  }
  return (
    <WorkspaceDialog
      title={saved ? 'Edit review lesson' : 'Remember review lesson'}
      icon={<Bookmark size={20} />}
      busy={busy}
      onClose={onClose}
    >
      <form
        className="lesson-editor"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && note.trim()) void save();
        }}
      >
        <label>
          Private reminder
          <textarea
            required
            autoFocus
            maxLength={2000}
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What should you check next time?"
          />
        </label>
        <label>
          Code fragment (optional)
          <input maxLength={160} value={fragment} onChange={(e) => setFragment(e.target.value)} />
        </label>
        <small>
          {fragment.trim() ? (
            'Show beside hunks that add or remove this exact text anywhere in this repository.'
          ) : (
            <>
              Show when another pull request changes <code>{thread.path}</code>.
            </>
          )}
        </small>
        {error && <p role="alert">{error}</p>}
        <div className="composer-actions">
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button disabled={busy || !note.trim()}>Save lesson</button>
        </div>
      </form>
    </WorkspaceDialog>
  );
}

export function LessonList({
  items,
  title,
  forget,
}: {
  items: ReviewLesson[];
  title: string;
  forget?: (lesson: ReviewLesson) => Promise<void>;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function act(action: () => Promise<void>) {
    setError('');
    setBusy(true);
    try {
      await action();
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  }
  if (!items.length) return null;
  return (
    <section className="review-lessons" aria-label={title}>
      <h3>
        <Bookmark size={14} />
        {title}
      </h3>
      <ul>
        {items.map((lesson) => {
          const link = discussionLink(lesson.sourceUrl, 'inline', lesson.threadId);
          return (
            <li key={link}>
              <p>{lesson.note}</p>
              <small>
                {lesson.fragment ? (
                  <>
                    Changed text <code>{lesson.fragment}</code>
                  </>
                ) : (
                  <>
                    File <code>{lesson.path}</code>
                  </>
                )}
              </small>
              {' · '}
              <button
                type="button"
                className="link"
                onClick={() => void act(() => window.reviewer.openChatLink(link))}
              >
                Source discussion · PR #{lesson.sourceUrl.split('/').at(-1)}
              </button>
              {forget && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => void act(() => forget(lesson))}
                >
                  Forget lesson
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
