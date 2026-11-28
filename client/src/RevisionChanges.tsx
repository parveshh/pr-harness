import type { TreeFile } from './ChangedFiles.js';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { QuestionLinks } from './PinnedQuestions.js';
import { shortRevision, splitHunks } from '../../shared/reader.js';
import { isLocalReview } from '../../shared/reviews.js';
import type { ReaderFile, ReaderView } from '../../shared/reader.js';
import type { ChangeEvidence, Comparison } from '../../shared/rereview.js';
import { readableError } from '../../shared/assistant.js';

const labels = {
  changed: 'Changed',
  entered: 'New to PR diff',
  left: 'Left PR diff',
  unconfirmed: 'Partial coverage',
  'head-only': 'Changed between commits',
};
function SavedPatch({ title, patch }: { title: string; patch: string | null }) {
  const offsets = useMemo(() => {
    const starts = [0];
    if (patch) {
      let rows = 0;
      for (let at = patch.indexOf('\n'); at >= 0; at = patch.indexOf('\n', at + 1)) {
        if (++rows % 1000 === 0 && at + 1 < patch.length) starts.push(at + 1);
      }
    }
    return starts;
  }, [patch]);
  const [chosen, setPage] = useState(0);
  const page = Math.min(chosen, offsets.length - 1);
  return (
    <section>
      <h3>{title}</h3>
      {offsets.length > 1 && (
        <div className="hunk-nav">
          <button disabled={!page} onClick={() => setPage(page - 1)}>
            Previous page
          </button>
          <span>
            Page {page + 1} of {offsets.length}
          </span>
          <button disabled={page + 1 === offsets.length} onClick={() => setPage(page + 1)}>
            Next page
          </button>
        </div>
      )}
      {patch ? (
        <pre>
          {patch
            .slice(offsets[page], offsets[page + 1])
            .replace(/\n$/, '')
            .split('\n')
            .map((line, i) => (
              <span
                key={i}
                className={
                  line.startsWith('+') ? 'addition' : line.startsWith('-') ? 'deletion' : undefined
                }
              >
                {line}
              </span>
            ))}
        </pre>
      ) : (
        <p>{patch === null ? 'Outside the saved file list.' : 'No text patch available.'}</p>
      )}
    </section>
  );
}

function changedHunks(patch: string | null, other: string | null) {
  if (!patch || !other) return patch;
  const existing = new Set(splitHunks(other));
  return splitHunks(patch)
    .filter((h) => !existing.has(h))
    .join('\n');
}

export function revisionQueue(view: ReaderView, comparison: Comparison) {
  const changes = new Map(comparison.files.map((f) => [f.path, f]));
  const current = new Map(view.files.map((f) => [f.path, f]));
  const pins = view.questions?.filter((q) => !q.addressed) ?? [];
  const paths = [
    ...new Set([
      ...view.files.filter((f) => f.needsReview).map((f) => f.path),
      ...changes.keys(),
      ...pins.map((q) => q.filePath ?? q.origin.path),
      ...view.files.filter((f) => !f.reviewed).map((f) => f.path),
    ]),
  ];
  const files: TreeFile[] = paths.map((path) => {
    const file = current.get(path);
    const change = changes.get(path);
    const reviewed = file?.reviewed || !!change?.reviewed;
    const detail = [
      change ? labels[change.state] : file && !reviewed ? 'Previously unread' : '',
      pins.some((q) => (q.filePath ?? q.origin.path) === path) ? 'Open question' : '',
      file?.needsReview ? 'Needs another look' : reviewed ? 'Reviewed' : '',
    ]
      .filter(Boolean)
      .join(' · ');
    return { path, detail, reviewed };
  });
  const path = view.changePath && paths.includes(view.changePath) ? view.changePath : paths[0];
  return { files, path };
}

export function RevisionChanges({
  url,
  view,
  comparison,
  inspectQuestion,
  fileConversations,
  openFile,
  mark,
  markAbsent,
  path,
}: {
  url: string;
  view: ReaderView;
  comparison: Comparison;
  inspectQuestion: (id: string) => void;
  path: string | undefined;
  openFile: (file: ReaderFile) => void;
  fileConversations: ReactNode;
  markAbsent: (path: string, reviewed: boolean) => void;
  mark: (file: ReaderFile) => void;
}) {
  const needsReview = view.files.filter((f) => f.needsReview).length;
  const file = view.files.find((f) => f.path === path);
  const change = comparison.files.find((f) => f.path === path);
  const questions =
    view.questions?.filter((q) => !q.addressed && (q.filePath ?? q.origin.path) === path) ?? [];
  const [evidence, setEvidence] = useState<{ path: string; data: ChangeEvidence } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!path) return;
    let live = true;
    window.reviewer
      .changeEvidence({ url, revision: view.revision, path })
      .then((data) => {
        if (live) {
          setEvidence({ path, data });
          setError('');
        }
      })
      .catch((e) => {
        if (live) setError(readableError(e));
      });
    return () => {
      live = false;
    };
  }, [url, path, view.revision]);
  const data = evidence?.path === path ? evidence?.data : null;
  const baseline = shortRevision(comparison.baseline);
  return (
    <>
      <div className="revision-context">
        <code>
          {baseline} → {shortRevision(view.revision)}
        </code>
        {comparison.baseChanged && <strong>Base changed</strong>}
        {comparison.ancestry === 'rewritten' && <strong>Rewritten history</strong>}
        {comparison.ancestry === 'unknown' &&
          (isLocalReview(url) ? (
            <span>Local revision comparison</span>
          ) : (
            <span>Commit ancestry unavailable</span>
          ))}
        {comparison.partial && <span>Comparison has partial coverage</span>}
        <span>
          {needsReview} previously reviewed {needsReview === 1 ? 'file needs' : 'files need'}{' '}
          another look
        </span>
      </div>
      <article>
        {path ? (
          <>
            <div className="file-heading">
              <h2>{path}</h2>
            </div>
            <div
              key={path}
              className="diff-scroll revision-diff"
              role="region"
              aria-label="Changes since checkpoint"
              tabIndex={0}
            >
              <QuestionLinks questions={questions} inspect={inspectQuestion} />
              {error && <p role="alert">{error}</p>}
              {!data && !error && <p role="status">Loading saved comparison…</p>}
              {data && (
                <>
                  {data.incremental !== null &&
                    (data.incremental ? (
                      <SavedPatch title="Changes between heads" patch={data.incremental} />
                    ) : (
                      <p>No text changes between these revisions.</p>
                    ))}
                  {!change ? (
                    <p>
                      {comparison.partial
                        ? 'No change recorded for this file in the available comparison.'
                        : 'No changes to this file since the checkpoint.'}
                    </p>
                  ) : data.incremental === null || comparison.baseChanged ? (
                    <>
                      {data.incremental === null && (
                        <p>
                          The direct comparison is unavailable. Showing changes in the saved PR
                          diffs.
                        </p>
                      )}
                      <SavedPatch
                        title="Changed hunks at checkpoint"
                        patch={changedHunks(data.before, data.after)}
                      />
                      <SavedPatch
                        title="Changed hunks in current PR"
                        patch={changedHunks(data.after, data.before)}
                      />
                    </>
                  ) : null}
                </>
              )}
              {fileConversations}
            </div>
            {!file && change && (
              <div className="file-actions">
                <button
                  aria-pressed={!!change.reviewed}
                  onClick={() => markAbsent(path, !change.reviewed)}
                >
                  {change.reviewed ? 'Reviewed ✓' : 'Mark reviewed'}
                </button>
              </div>
            )}
            {file && (
              <div className="file-actions">
                <button onClick={() => openFile(file)}>Open full PR diff</button>
                <button
                  className="secondary"
                  aria-pressed={file.reviewed}
                  onClick={() => mark(file)}
                >
                  {file.reviewed ? 'Reviewed ✓' : 'Mark reviewed'}
                </button>
              </div>
            )}
          </>
        ) : (
          <p className="patch-note">No changed or unread files at this checkpoint.</p>
        )}
      </article>
    </>
  );
}
