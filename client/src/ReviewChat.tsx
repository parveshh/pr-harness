import { replaceCitations } from '../../shared/markdown-citations.js';
import { ChatMarkdown } from './components/ChatMarkdown.js';
import { WorkspaceDialog } from './components/WorkspaceDialog.js';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  defaultPrompt,
  readableError,
  type Config,
  type ContextMode,
  type Preferences,
  type Scope,
  type Turn,
  type Anchor,
  type Citation,
} from '../../shared/assistant.js';
import { Sparkles, ArrowUp } from 'lucide-react';
import { splitHunks } from '../../shared/reader.js';
import type { ReaderView, ReaderFile } from '../../shared/reader.js';

export function ReviewChat({
  url,
  view,
  file,
  selection,
  jump,
  onDraft,
}: {
  url: string;
  view: ReaderView;
  file: ReaderFile;
  selection: Anchor | null;
  jump: (cite: Citation) => void;
  onDraft: ((cite: Citation, body: string) => void) | undefined;
}) {
  const [config, setConfig] = useState<Config | null>(null),
    [settings, setSettings] = useState<Preferences | null>(null),
    [scope, setScope] = useState<Scope>('default');
  const [messages, setMessages] = useState<Turn[]>([]),
    [question, setQuestion] = useState(''),
    [error, setError] = useState(''),
    [extra, setExtra] = useState(''),
    [contextMode, setContextMode] = useState<ContextMode>('focused'),
    [running, setRunning] = useState(false),
    [partial, setPartial] = useState(''),
    [pending, setPending] = useState(''),
    [notice, setNotice] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const active = useRef<string | null>(null),
    alive = useRef(false),
    cancelled = useRef<string | null>(null);
  function apply(c: Config) {
    setConfig(c);
    setSettings(c.settings);
    setScope(c.scope);
  }
  useEffect(() => {
    alive.current = true;
    let current = true;
    window.reviewer
      .agentConfig(url)
      .then((c) => {
        if (current) {
          apply(c);
        }
      })
      .catch((e) => {
        if (current) setError(readableError(e));
      });
    const off = window.reviewer.onActivity((e) => {
      if (current && active.current === e.run) setPartial(e.text);
    });
    return () => {
      current = false;
      alive.current = false;
      off();
      if (active.current) void window.reviewer.cancelAsk(active.current).catch(() => {});
    };
  }, [url]);
  useEffect(() => {
    let live = true;
    window.reviewer
      .history(url)
      .then((history) => {
        if (live)
          setMessages((current) => [
            ...history,
            ...current.filter((m) => !history.some((h) => h.run === m.run)),
          ]);
      })
      .catch((e) => {
        if (live) setError(readableError(e));
      });
    return () => {
      live = false;
    };
  }, [url, view.revision]);
  const agent = config?.agents.find((a) => a.id === settings?.agent);
  function change(p: Partial<Preferences>) {
    if (settings) {
      setSettings({ ...settings, ...p });
      setNotice('');
    }
  }
  async function save() {
    if (!settings) throw Error('Select an agent first.');
    const c = await window.reviewer.saveConfig(url, scope, settings);
    if (alive.current) {
      apply(c);
      setNotice('Settings saved.');
    }
    return c;
  }
  function configure() {
    setError('');
    save().catch((e) => setError(readableError(e)));
  }
  async function send(text: string) {
    if (active.current || !settings || !agent || !text.trim()) return;
    const run = crypto.randomUUID();
    active.current = run;
    setRunning(true);
    setError('');
    setPartial('');
    setPending(text);
    try {
      if (!config || scope !== config.scope || settings !== config.settings) await save();
      if (!alive.current || active.current !== run) return;
      if (cancelled.current === run) throw Error('Request cancelled.');
      const result = await window.reviewer.ask({
        run,
        contextMode,
        url,
        revision: view.revision,
        path: file.path,
        hunk: file.hunk,
        selection,
        extra: extra || null,
        question: text.trim(),
      });
      if (alive.current) {
        setMessages((h) => [...h.filter((m) => m.run !== result.run), result]);
        setQuestion('');
      }
    } catch (e) {
      if (alive.current) setError(readableError(e));
    } finally {
      if (alive.current) {
        setRunning(false);
        setPartial('');
        setPending('');
      }
      active.current = null;
    }
  }
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
        <small>{view.meta.head.slice(0, 8)}</small>
      </div>
      {settings && config && (
        <fieldset disabled={running}>
          <div className="agent-picker">
            <label>
              Agent
              <select
                aria-label="Agent"
                value={settings.agent}
                onChange={(e) =>
                  change({
                    agent: e.target.value === 'claude' ? 'claude' : 'codex',
                    model: '',
                    provider: 'default',
                  })
                }
              >
                {(['codex', 'claude'] as const).map((id) => (
                  <option key={id} value={id}>
                    {id === 'codex' ? 'Codex CLI' : 'Claude Code'}
                    {config.agents.some((a) => a.id === id) ? '' : ' (not found)'}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Model
              <input
                list="agent-models"
                value={settings.model}
                placeholder="Agent default"
                onChange={(e) => change({ model: e.target.value })}
              />
              <datalist id="agent-models">
                {(settings.provider === 'default' ? agent?.models : [])?.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </label>
          </div>
          <button
            type="button"
            className="chat-settings-toggle"
            onClick={() => setSettingsOpen(true)}
          >
            Review instructions &amp; settings
          </button>
          {settingsOpen && (
            <WorkspaceDialog
              title="Review instructions & settings"
              icon={<Sparkles size={18} />}
              onClose={() => setSettingsOpen(false)}
            >
              <div className="chat-settings">
                <label>
                  Save settings for
                  <select value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
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
                    onClick={() => {
                      window.reviewer
                        .clearConfig(url, config.scope)
                        .then((next) => {
                          apply(next);
                          setNotice('Using inherited settings.');
                        })
                        .catch((e) => setError(readableError(e)));
                    }}
                  >
                    Use inherited settings
                  </button>
                )}
                {settings.agent === 'codex' && (
                  <label>
                    Inference provider
                    <select
                      value={settings.provider}
                      onChange={(e) =>
                        change({ provider: e.target.value as Preferences['provider'], model: '' })
                      }
                    >
                      <option value="default">Codex default</option>
                      <option value="ollama">Local · Ollama</option>
                      <option value="lmstudio">Local · LM Studio</option>
                    </select>
                  </label>
                )}
                <label>
                  Review prompt
                  <textarea
                    rows={6}
                    value={settings.prompt}
                    onChange={(e) => change({ prompt: e.target.value })}
                  />
                </label>
                <button type="button" onClick={() => change({ prompt: defaultPrompt })}>
                  Restore default prompt
                </button>{' '}
                <button type="button" onClick={configure}>
                  Save settings
                </button>
                <p>
                  {agent?.version ?? 'Executable not found'} ·{' '}
                  {settings.provider === 'default' ? 'Uses agent provider' : 'Local inference'}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    window.reviewer
                      .chooseExecutable(settings.agent)
                      .then(async (chosen) => {
                        if (chosen) {
                          const c = await window.reviewer.agentConfig(url);
                          setConfig(c);
                        }
                      })
                      .catch((e) => setError(readableError(e)));
                  }}
                >
                  Choose executable…
                </button>
                {notice && <small role="status">{notice}</small>}
                {error && <p role="alert">{error}</p>}
              </div>
            </WorkspaceDialog>
          )}
        </fieldset>
      )}
      <div className="chat-log" aria-label="Conversation">
        {messages.map((m) => (
          <div className="exchange" key={m.run}>
            <div className="chat-question">
              <ChatMarkdown text={m.question} />
            </div>
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
              onDraft={onDraft}
            />
          </div>
        ))}
        {running && (
          <div role="status">
            <div className="chat-question">
              <ChatMarkdown text={pending} />
            </div>
            <div className="chat-answer">
              <ChatMarkdown text={partial || 'Reading the diff…'} />
            </div>
          </div>
        )}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(question);
        }}
      >
        <label htmlFor="chat-question">Ask about the diff</label>
        <small className="context-file">
          {file.path} ·{' '}
          {selection
            ? 'line ' + selection.line + ' (' + selection.side + ')'
            : file.status === 'added'
              ? 'new file'
              : 'hunk ' + (file.hunk + 1)}
        </small>
        <textarea
          id="chat-question"
          rows={3}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          disabled={running}
          placeholder="Ask a question about this change…"
        />
        <label className="chat-context-mode">
          Context
          <select
            aria-label="Context"
            value={contextMode}
            disabled={running}
            onChange={(e) => setContextMode(e.target.value === 'full-pr' ? 'full-pr' : 'focused')}
          >
            <option value="focused">Focused</option>
            <option value="full-pr">Full PR</option>
          </select>
        </label>
        {contextMode === 'full-pr' && (
          <small className="context-help">
            Searches saved diffs and reads requested source from the pinned repository. First source
            lookup downloads that revision.
          </small>
        )}
        <details>
          <summary>Related file</summary>
          <label>
            Prioritise another diff
            <select value={extra} onChange={(e) => setExtra(e.target.value)}>
              <option value="">Automatic</option>
              {view.files
                .filter((f) => f.path !== file.path)
                .map((f) => (
                  <option key={f.path}>{f.path}</option>
                ))}
            </select>
          </label>
        </details>
        <div className="composer-actions">
          <button
            type="button"
            disabled={!canAsk}
            onClick={() =>
              void send(
                file.status === 'added'
                  ? 'Explain this new file. What does it introduce, how does it work, and how does it fit into this PR?'
                  : 'Explain what changed in this file and why it matters, starting with the selected hunk.',
              )
            }
          >
            Explain file
          </button>
          {running ? (
            <button
              type="button"
              onClick={() => {
                cancelled.current = active.current;
                if (active.current)
                  void window.reviewer
                    .cancelAsk(active.current)
                    .catch((e) => setError(readableError(e)));
              }}
            >
              Cancel
            </button>
          ) : (
            <button disabled={!canAsk || !question.trim()}>
              <ArrowUp size={14} /> Send
            </button>
          )}
        </div>
      </form>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
const Answer = memo(function Answer({
  url,
  turn,
  current,
  jump,
  onDraft,
}: {
  url: string;
  turn: Turn;
  current: boolean;
  jump: (cite: Citation) => void;
  onDraft: ((cite: Citation, body: string) => void) | undefined;
}) {
  const draft = useMemo(() => {
    let anchor: Citation | undefined;
    const body = replaceCitations(turn.answer, (id, marker) => {
      const cite = turn.citations.find((c) => c.id === id);
      if (!cite) {
        const source = turn.sourceCitations?.find((s) => s.id === id);
        return source ? source.url : marker;
      }
      anchor ??= cite;
      return cite.path + ':' + cite.line;
    });
    return anchor ? { anchor, body } : null;
  }, [turn.answer, turn.citations, turn.sourceCitations]);
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
            if (current) jump(cite);
            else {
              setOriginal('');
              setArchive(cite);
            }
          }}
        />
      </div>
      {current && draft && onDraft && (
        <button className="secondary" onClick={() => onDraft(draft.anchor, draft.body)}>
          Draft from answer
        </button>
      )}
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
