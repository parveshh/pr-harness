import type { ReactNode, RefObject } from 'react';
import { ChatMarkdown } from './components/ChatMarkdown.js';
import { WorkspaceDialog } from './components/WorkspaceDialog.js';
import { memo, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { chatRuns, usePrChat } from './chatRuns.js';
import type { ActiveRun, RunKind } from '../../shared/chat-runs.js';
import {
  agentNames,
  defaultPrompt,
  readableError,
  reviewPrompt,
  scope as scopeSchema,
  summaryQuestion,
  type AgentCatalog,
  type Config,
  type ContextMode,
  type Scope,
  type Turn,
  type ChatRequest,
  type Citation,
  type SourceCitation,
} from '../../shared/assistant.js';
import {
  UserRound,
  Sparkles,
  ArrowUp,
  LoaderCircle,
  SlidersHorizontal,
  ChevronRight,
} from 'lucide-react';
import { splitHunks } from '../../shared/reader.js';
import type { ReaderView, ReaderFile } from '../../shared/reader.js';

export function ReviewChat({
  agents,
  agentPicker,
  summaryRequest,
  onSummaryStarted,
  url,
  view,
  file,
  selection,
  jump,
  openSource,
  collapse,
  composerRef,
}: {
  agents: AgentCatalog | null;
  agentPicker: ReactNode;
  // Set when a summary was asked for outside this pane, such as from the sidebar.
  summaryRequest: number | null;
  onSummaryStarted: () => void;
  url: string;
  view: ReaderView;
  file: ReaderFile;
  selection: ChatRequest['selection'];
  jump: (cite: Citation) => void;
  openSource: (run: string, cite: SourceCitation) => void;
  collapse: () => void;
  composerRef: RefObject<HTMLTextAreaElement | null>;
}) {
  // The harness and model come from the app-wide choice. This pane owns the scoped prompt.
  const [config, setConfig] = useState<Config | null>(null),
    [prompt, setPrompt] = useState<string | null>(null),
    [scope, setScope] = useState<Scope>('default');
  // Runs, answers and the composer draft belong to the PR and live in the chat store, so
  // they survive opening another PR. This pane keeps only what it shows while mounted.
  const chat = usePrChat(url);
  const running = !!chat.active,
    question = chat.draft;
  const [history, setHistory] = useState<Turn[]>([]),
    [error, setError] = useState(''),
    [extra, setExtra] = useState(''),
    [contextMode, setContextMode] = useState<ContextMode>('focused'),
    [notice, setNotice] = useState(''),
    [configFailed, setConfigFailed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const alive = useRef(false);
  const loadedConfigUrl = useRef<string | null>(null);
  const messages = useMemo(
    () => [...history, ...chat.completed.filter((m) => !history.some((h) => h.run === m.run))],
    [history, chat.completed],
  );
  function apply(c: Config) {
    setConfig(c);
    setPrompt(c.settings.prompt);
    setScope(c.scope);
  }
  useEffect(() => {
    alive.current = true;
    let current = true;
    // Revealing the chat after an update must preserve edits to its instructions.
    if (loadedConfigUrl.current !== url) {
      window.reviewer
        .agentConfig(url)
        .then((c) => {
          if (current) {
            loadedConfigUrl.current = url;
            apply(c);
          }
        })
        .catch((e) => {
          if (!current) return;
          setError(readableError(e));
          setConfigFailed(true);
        });
    }
    return () => {
      current = false;
      alive.current = false;
    };
  }, [url]);
  useEffect(() => {
    let live = true;
    window.reviewer
      .history(url)
      .then((history) => {
        if (live) setHistory(history);
      })
      .catch((e) => {
        if (live) setError(readableError(e));
      });
    return () => {
      live = false;
    };
  }, [url, view.revision]);
  const agent = agents?.agents.find((a) => a.id === agents.selection.agent);
  async function save() {
    const text = reviewPrompt.safeParse(prompt);
    if (!text.success) throw Error('Enter a review prompt of up to 16,000 characters.');
    const c = await window.reviewer.savePrompt(url, scope, text.data);
    if (alive.current) {
      apply(c);
      setNotice('Instructions saved.');
    }
    return c;
  }
  function configure() {
    setError('');
    save().catch((e) => setError(readableError(e)));
  }
  // `typed` marks a question from the composer, which is cleared once it is answered.
  function send(
    text: string,
    mode: ContextMode = contextMode,
    typed = false,
    kind: RunKind = 'question',
  ) {
    if (running || prompt === null || !agent || !text.trim()) return;
    setError('');
    const edited = !config || scope !== config.scope || prompt !== config.settings.prompt;
    chatRuns.start(
      {
        run: crypto.randomUUID(),
        contextMode: mode,
        url,
        revision: view.revision,
        path: file.path,
        hunk: file.hunk,
        selection,
        extra: extra || null,
        question: text.trim(),
      },
      kind,
      // Edited instructions are saved first so the answer uses them.
      { clearDraft: typed, ...(edited ? { before: save } : {}) },
    );
  }
  // Follow the conversation while the reviewer is at its end. A new run always brings its
  // progress into view.
  const log = useRef<HTMLDivElement>(null),
    following = useRef(true);
  const activeRun = chat.active?.run,
    progress = chat.active?.partial;
  useLayoutEffect(() => {
    if (activeRun) following.current = true;
  }, [activeRun]);
  useLayoutEffect(() => {
    if (following.current && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [activeRun, progress, messages.length]);
  const canSummarise = !!agent && !running && prompt !== null;
  // A summary asked for from the sidebar waits only while the harness list or the prompt is
  // still loading. After that it either starts or says why not, so it never fires later.
  const takeSummaryRequest = useEffectEvent(() => {
    if (!agents || (prompt === null && !configFailed)) return;
    onSummaryStarted();
    if (canSummarise) send(summaryQuestion, 'full-pr', false, 'summary');
    else
      setError(
        running
          ? 'Another answer is running. Summarise the PR when it finishes.'
          : agent
            ? 'Review instructions could not be loaded, so the summary did not start.'
            : 'Choose an installed harness in the model picker, then summarise the PR.',
      );
  });
  useEffect(() => {
    // Starting a run is the external action here, and marking it as running or refused is
    // part of answering the request. The request is cleared in the same step.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (summaryRequest !== null) takeSummaryRequest();
  }, [summaryRequest, agents, prompt, configFailed]);
  const canAsk =
    !!agent && !running && (contextMode === 'full-pr' || ['text', 'partial'].includes(file.kind));
  return (
    <section className="review-chat" aria-label="Review chat">
      <div className="chat-heading">
        <h2>
          <span className="agent-glyph">
            <Sparkles size={16} />
          </span>{' '}
          Review chat
        </h2>
        <div className="chat-agent-picker">{agentPicker}</div>
        <div className="chat-heading-tools">
          {prompt !== null && config && (
            <fieldset disabled={running}>
              <button
                type="button"
                className="chat-settings-toggle"
                aria-label="Review instructions"
                title="Review instructions"
                onClick={() => setSettingsOpen(true)}
              >
                <SlidersHorizontal size={15} aria-hidden />
              </button>
              {settingsOpen && (
                <WorkspaceDialog
                  title="Review instructions"
                  icon={<Sparkles size={18} />}
                  wide
                  onClose={() => setSettingsOpen(false)}
                >
                  <div className="chat-settings">
                    <label>
                      Save instructions for
                      <select
                        value={scope}
                        onChange={(e) => {
                          setScope(scopeSchema.parse(e.target.value));
                          setNotice('');
                        }}
                      >
                        <option value="default" disabled={config.scope !== 'default'}>
                          App default
                        </option>
                        <option value="repository" disabled={config.scope === 'review'}>
                          This repository
                        </option>
                        <option value="review">This pull request</option>
                      </select>
                    </label>
                    {config.scope !== 'default' && (
                      <button
                        type="button"
                        className="quiet"
                        onClick={() => {
                          window.reviewer
                            .clearPrompt(url, config.scope)
                            .then((next) => {
                              apply(next);
                              setNotice('Using inherited instructions.');
                            })
                            .catch((e) => setError(readableError(e)));
                        }}
                      >
                        Use inherited instructions
                      </button>
                    )}
                    <label>
                      Review prompt
                      <textarea
                        rows={14}
                        value={prompt}
                        onChange={(e) => {
                          setPrompt(e.target.value);
                          setNotice('');
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      className="quiet"
                      onClick={() => {
                        setPrompt(defaultPrompt);
                        setNotice('');
                      }}
                    >
                      Restore default prompt
                    </button>{' '}
                    <button type="button" onClick={configure}>
                      Save instructions
                    </button>
                    {notice && <small role="status">{notice}</small>}
                    {error && <p role="alert">{error}</p>}
                  </div>
                </WorkspaceDialog>
              )}
            </fieldset>
          )}
          <button
            className="pane-toggle"
            title="Collapse review chat"
            aria-label="Collapse review chat"
            onClick={collapse}
          >
            <ChevronRight size={17} />
          </button>
        </div>
      </div>
      {!agent && agents && (
        <p className="chat-harness-hint">
          {agentNames[agents.selection.agent]} was not found. Choose an installed harness in the
          Review chat header.
        </p>
      )}
      <div
        className="chat-log"
        aria-label="Conversation"
        ref={log}
        onScroll={(e) => {
          const el = e.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {messages.map((m) => (
          <div className="exchange" key={m.run}>
            <strong className="chat-speaker">
              <UserRound size={14} /> You
            </strong>
            <div className="chat-question">
              <ChatMarkdown text={m.question} />
            </div>
            <strong className="chat-speaker assistant-speaker">
              <Sparkles size={13} /> Assistant
            </strong>
            <small>
              {m.settings.agent} · {m.reportedModel || m.settings.model || 'agent default'} ·{' '}
              {m.revision.split('...').at(-1)?.slice(0, 8)}
              {m.contextMode === 'full-pr' && ' · Full PR'}
            </small>
            {!!m.changedEvidence?.length && (
              <small>Evidence needs another look · {m.changedEvidence.join(', ')}</small>
            )}
            <Answer
              url={url}
              turn={m}
              current={m.revision === view.revision}
              jump={jump}
              openSource={openSource}
            />
          </div>
        ))}
        {chat.active && <RunProgress run={chat.active} />}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(question, contextMode, true);
        }}
      >
        <div className="chat-suggestions">
          <button
            type="button"
            className="summarise-pr"
            disabled={!canSummarise}
            title="Uses Full PR context"
            onClick={() => send(summaryQuestion, 'full-pr', false, 'summary')}
          >
            Summarise PR
          </button>
          <button
            type="button"
            disabled={!canAsk}
            onClick={() =>
              send(
                file.status === 'added'
                  ? 'Explain this new file. What does it introduce, how does it work, and how does it fit into this PR?'
                  : 'Explain what changed in this file and why it matters, starting with the selected hunk.',
              )
            }
          >
            Explain file
          </button>
        </div>
        <div className="composer-box">
          <small className="context-file">
            {file.path} ·{' '}
            {selection
              ? (selection.startLine && selection.startLine !== selection.line
                  ? 'lines ' + selection.startLine + '–' + selection.line
                  : 'line ' + selection.line) +
                ' (' +
                selection.side +
                ')'
              : file.status === 'added'
                ? 'new file'
                : 'hunk ' + (file.hunk + 1)}
          </small>
          <textarea
            ref={composerRef}
            id="chat-question"
            aria-label="Ask about the diff"
            rows={4}
            value={question}
            onChange={(e) => chatRuns.setDraft(url, e.target.value)}
            disabled={running}
            placeholder="Ask a question about this change…"
          />
          <div className="composer-actions">
            <select
              aria-label="Context"
              title={
                contextMode === 'full-pr'
                  ? 'Searches saved diffs and reads requested source from the pinned repository. The first source lookup downloads that revision.'
                  : 'Answers from the selected file and hunk.'
              }
              value={contextMode}
              disabled={running}
              onChange={(e) => setContextMode(e.target.value === 'full-pr' ? 'full-pr' : 'focused')}
            >
              <option value="focused">Focused</option>
              <option value="full-pr">Full PR</option>
            </select>
            <select
              aria-label="Related file"
              className="related-file"
              title={extra || "Prioritise another file's diff alongside this one"}
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
            >
              <option value="">Related file: auto</option>
              {view.files
                .filter((f) => f.path !== file.path)
                .map((f) => (
                  <option key={f.path}>{f.path}</option>
                ))}
            </select>
            {running ? (
              <button type="button" onClick={() => chatRuns.cancel(url)}>
                Cancel
              </button>
            ) : (
              <button disabled={!canAsk || !question.trim()}>
                <ArrowUp size={14} /> Send
              </button>
            )}
          </div>
        </div>
      </form>
      {(error || chat.error) && <p role="alert">{error || chat.error}</p>}
    </section>
  );
}
// The run in progress: what was asked, how long it has taken, and the agent's latest text.
function RunProgress({ run }: { run: ActiveRun }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.round((now - run.startedAt) / 1000));
  return (
    <div className="chat-progress">
      <div className="chat-question">
        <ChatMarkdown text={run.question} />
      </div>
      <p className="chat-progress-line">
        <LoaderCircle className="spin" size={14} aria-hidden />
        {/* Only the label is announced. The clock and streamed text change too often. */}
        <span role="status">
          {run.kind === 'summary' ? 'Summarising the pull request' : 'Working on an answer'}
          {run.contextMode === 'full-pr' && ' · Full PR'}
        </span>
        <span aria-hidden> · {seconds}s</span>
      </p>
      <div className="chat-answer">
        <ChatMarkdown text={run.partial || 'Reading the diff…'} />
      </div>
    </div>
  );
}
const Answer = memo(function Answer({
  url,
  turn,
  current,
  jump,
  openSource,
}: {
  url: string;
  turn: Turn;
  current: boolean;
  jump: (cite: Citation) => void;
  openSource: (run: string, cite: SourceCitation) => void;
}) {
  const [archive, setArchive] = useState<Citation | null>(null);
  const [original, setOriginal] = useState('');
  useEffect(() => {
    if (!archive) return;
    let live = true;
    window.reviewer
      .filePatch({ url, revision: turn.revision, path: archive.path })
      .then((patch) => {
        if (live) setOriginal(splitHunks(patch)[archive.hunk] ?? archive.excerpt);
      })
      .catch(() => {
        if (live) setOriginal(archive.excerpt);
      });
    return () => {
      live = false;
    };
  }, [archive, turn.revision, url]);
  return (
    <>
      <div className="chat-answer">
        <ChatMarkdown
          text={turn.answer}
          citations={turn.citations}
          sourceCitations={turn.sourceCitations}
          onCite={(cite) => {
            if ('commit' in cite) openSource(turn.run, cite);
            else if (current) jump(cite);
            else {
              setOriginal('');
              setArchive(cite);
            }
          }}
        />
      </div>
      {archive && (
        <blockquote>
          <strong>
            {archive.path}:{archive.line} · saved revision
          </strong>
          <pre>{archive.excerpt}</pre>
          {original && original !== archive.excerpt && (
            <details>
              <summary>Original hunk</summary>
              <pre>{original}</pre>
            </details>
          )}
        </blockquote>
      )}
    </>
  );
});
