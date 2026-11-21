import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from './components/Resizable.js';
import { useEffect, useState } from 'react';
import { QuestionLinks } from './PinnedQuestions.js';
import { splitHunks } from '../../shared/reader.js';
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
  return (
    <section>
      <h3>{title}</h3>
      {patch ? (
        <pre>
          {patch.split('\n').map((line, i) => (
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

export function RevisionChanges({
  url,
  view,
  comparison,
  inspectQuestion,
  openFile,
  mark,
  markAbsent,
  choose,
}: {
  url: string;
  view: ReaderView;
  comparison: Comparison;
  inspectQuestion: (id: string) => void;
  choose: (path: string) => void;
  openFile: (file: ReaderFile) => void;
  markAbsent: (path: string, reviewed: boolean) => void;
  mark: (file: ReaderFile) => void;
}) {
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
  const needsReview = view.files.filter((f) => f.needsReview).length;
  const chosen = view.changePath;
  const path = chosen && paths.includes(chosen) ? chosen : paths[0];
  const file = path ? current.get(path) : undefined;
  const [showFiles, setShowFiles] = useState(false);
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
  const baseline = comparison.baseline.split('...').at(-1)?.slice(0, 8);
  return (
    <>
      <div className="revision-context">
        <code>
          {baseline} → {view.meta.head.slice(0, 8)}
        </code>
        {comparison.baseChanged && <strong>Base changed</strong>}
        {comparison.ancestry === 'rewritten' && <strong>Rewritten history</strong>}
        {comparison.ancestry === 'unknown' && <span>Commit ancestry unavailable</span>}
        {comparison.partial && <span>Comparison has partial coverage</span>}
        <span>
          {needsReview} {needsReview === 1 ? 'file needs' : 'files need'} another look
        </span>
      </div>
      <div className="pane-switch">
        <button aria-pressed={showFiles} onClick={() => setShowFiles(true)}>
          Files
        </button>
        <button aria-pressed={!showFiles} onClick={() => setShowFiles(false)}>
          Diff
        </button>
      </div>
      <ResizablePanelGroup
        id="revision-layout"
        className="reading-grid revision-grid"
        data-pane={showFiles ? 'files' : 'diff'}
      >
        <ResizablePanel id="revision-files" defaultSize="25%" minSize="155px">
          <nav aria-label="Re-review queue">
            <div className="nav-heading">
              <h2>Re-review queue</h2>
              <small>{comparison.files.length} changed since checkpoint</small>
            </div>
            <div className="files-scroll">
              {paths.map((p) => {
                const info = current.get(p);
                const state = changes.get(p);
                return (
                  <button
                    key={p}
                    className="file-row"
                    aria-current={path === p ? 'true' : undefined}
                    onClick={() => {
                      choose(p);
                      setShowFiles(false);
                    }}
                  >
                    <span className="file-path">
                      <strong>{p}</strong>
                      <small>
                        {[
                          state
                            ? labels[state.state]
                            : info?.reviewed || !info
                              ? ''
                              : 'Previously unread',
                          pins.some((q) => (q.filePath ?? q.origin.path) === p)
                            ? 'Open question'
                            : '',
                          info?.needsReview
                            ? 'Needs another look'
                            : info?.reviewed || state?.reviewed
                              ? 'Reviewed'
                              : '',
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </small>
                    </span>
                  </button>
                );
              })}
            </div>
          </nav>
        </ResizablePanel>
        <ResizableHandle label="Resize re-review queue and diff" />
        <ResizablePanel id="revision-diff" minSize="300px">
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
                  <QuestionLinks
                    questions={pins.filter((q) => (q.filePath ?? q.origin.path) === path)}
                    inspect={inspectQuestion}
                  />
                  {error && <p role="alert">{error}</p>}
                  {!data && !error && <p role="status">Loading saved comparison…</p>}
                  {data && (
                    <>
                      {data.incremental !== null && (
                        <SavedPatch title="Changes between heads" patch={data.incremental} />
                      )}
                      {!changes.has(path) ? (
                        <SavedPatch
                          title={file?.reviewed ? 'Current PR diff' : 'Previously unread PR diff'}
                          patch={data.after}
                        />
                      ) : data.incremental === null || comparison.baseChanged ? (
                        <>
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
                </div>
                {!file && changes.has(path) && (
                  <div className="file-actions">
                    <button
                      aria-pressed={!!changes.get(path)?.reviewed}
                      onClick={() => markAbsent(path, !changes.get(path)?.reviewed)}
                    >
                      {changes.get(path)?.reviewed ? 'Reviewed ✓' : 'Mark reviewed'}
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
        </ResizablePanel>
      </ResizablePanelGroup>
    </>
  );
}
