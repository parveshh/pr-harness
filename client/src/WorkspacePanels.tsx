import { useEffect, useState } from 'react';
import { Bell, Check, ExternalLink, Settings, UserRound, RefreshCw } from 'lucide-react';
import { WorkspaceDialog } from './components/WorkspaceDialog.js';
import {
  accent as accents,
  accentNames,
  appearance,
  appearanceNames,
  type Accent,
  type Appearance,
} from '../../shared/appearance.js';
import { readableError } from '../../shared/assistant.js';
import { typography, type Typography, type Inbox, type SignIn } from '../../shared/workspace.js';

const fonts: Record<Typography['font'], string> = {
  system: 'System sans',
  humanist: 'Humanist sans',
  serif: 'Serif',
  mono: 'Monospace',
};
const sizes: Record<Typography['size'], string> = {
  small: 'Small',
  standard: 'Default',
  large: 'Large',
  larger: 'Larger',
};
export function applyTypography(settings: Typography) {
  document.documentElement.dataset.font = settings.font;
  document.documentElement.dataset.textSize = settings.size;
}
export function SettingsPane({
  theme,
  chooseTheme,
  accent,
  chooseAccent,
  type,
  chooseType,
  onLoginStart,
  onConnected,
  close,
  error,
}: {
  theme: Appearance;
  chooseTheme: (v: Appearance) => void;
  accent: Accent;
  chooseAccent: (v: Accent) => void;
  type: Typography;
  chooseType: (v: Partial<Typography>) => void;
  onLoginStart: () => void;
  onConnected: () => void;
  close: () => void;
  error: string;
}) {
  const [auth, setAuth] = useState<SignIn>({ state: 'idle' }),
    [problem, setProblem] = useState(''),
    [starting, setStarting] = useState(false);
  const [account, setAccount] = useState<string | null>(null);
  const [identityError, setIdentityError] = useState('');
  useEffect(() => {
    let live = true;
    window.reviewer
      .reviewIdentity()
      .then((name) => {
        if (live) {
          setAccount(name);
          setIdentityError('');
        }
      })
      .catch((e) => {
        if (live) {
          setAccount(null);
          setIdentityError(readableError(e));
        }
      });
    return () => {
      live = false;
    };
  }, [auth.state]);
  useEffect(() => {
    let live = true;
    window.reviewer
      .loginProgress()
      .then((v) => {
        if (live) setAuth(v);
      })
      .catch((e) => {
        if (live) setProblem(readableError(e));
      });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (auth.state !== 'waiting') return;
    let live = true;
    const timer = window.setInterval(() => {
      window.reviewer
        .loginProgress()
        .then((v) => {
          if (!live) return;
          setAuth(v);
          if (v.state === 'complete') onConnected();
        })
        .catch((e) => {
          if (live) setProblem(readableError(e));
        });
    }, 800);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [auth.state, onConnected]);
  function connect() {
    onLoginStart();
    setStarting(true);
    setProblem('');
    window.reviewer
      .startLogin()
      .then(setAuth)
      .catch((e) => setProblem(readableError(e)))
      .finally(() => setStarting(false));
  }
  return (
    <WorkspaceDialog title="Settings" icon={<Settings size={22} />} wide onClose={close}>
      <section className="settings-group">
        <h3>Appearance</h3>
        <fieldset className="palette-options">
          <legend>Theme</legend>
          {appearance.options.map((value) => (
            <label key={value} className="palette-choice" data-selected={theme === value}>
              <input
                type="radio"
                name="workspace-theme"
                value={value}
                checked={theme === value}
                onChange={() => chooseTheme(value)}
              />
              <span className="palette-tile" data-palette={value}>
                <i />
                <i />
                <i />
                {theme === value && <Check size={13} />}
              </span>
              <span>{appearanceNames[value]}</span>
            </label>
          ))}
        </fieldset>
        <fieldset className="accent-options">
          <legend>Accent colour</legend>
          {accents.options.map((value) => (
            <label key={value} className="accent-choice" data-selected={accent === value}>
              <input
                type="radio"
                name="workspace-accent"
                value={value}
                checked={accent === value}
                onChange={() => chooseAccent(value)}
              />
              <span className="accent-dot" data-accent={value}>
                {accent === value && <Check size={13} />}
              </span>
              <span>{accentNames[value]}</span>
            </label>
          ))}
        </fieldset>
        <div className="settings-line">
          <label htmlFor="ui-font">Interface font</label>
          <select
            id="ui-font"
            value={type.font}
            onChange={(e) => chooseType({ font: typography.shape.font.parse(e.target.value) })}
          >
            {typography.shape.font.options.map((f) => (
              <option key={f} value={f}>
                {fonts[f]}
              </option>
            ))}
          </select>
        </div>
        <fieldset className="type-size">
          <legend>Text size</legend>
          {typography.shape.size.options.map((size) => (
            <label key={size}>
              <input
                type="radio"
                name="text-size"
                value={size}
                checked={size === type.size}
                onChange={() => chooseType({ size })}
              />
              <span>{sizes[size]}</span>
            </label>
          ))}
        </fieldset>
      </section>
      <section className="settings-group">
        <h3>GitHub account</h3>
        <div className="account-row">
          <span className="account-icon">
            <UserRound size={18} />
          </span>
          <div>
            <strong>{account ? '@' + account : 'Connect GitHub'}</strong>
            <small>
              {account ? 'Connected through GitHub CLI' : 'Sign in through your browser'}
            </small>
          </div>
          {auth.state !== 'waiting' && (
            <button className="quiet" disabled={starting} onClick={connect}>
              {account ? 'Switch account' : 'Connect account'} <ExternalLink size={13} />
            </button>
          )}
        </div>
        {auth.state === 'waiting' && (
          <div className="device-login">
            <p role="status">
              {auth.code ? 'Enter this one-time code on GitHub.' : 'Waiting for GitHub sign-in…'}
            </p>
            {auth.code && <code>{auth.code}</code>}
            <div className="dialog-actions">
              <button
                className="quiet"
                onClick={() =>
                  void window.reviewer
                    .cancelLogin()
                    .then(() => setAuth({ state: 'idle' }))
                    .catch((e) => setProblem(readableError(e)))
                }
              >
                Cancel sign-in
              </button>
              <button
                onClick={() =>
                  void window.reviewer.openDevicePage().catch((e) => setProblem(readableError(e)))
                }
              >
                Open GitHub
              </button>
            </div>
          </div>
        )}
        {identityError && auth.state !== 'waiting' && <small>{identityError}</small>}
        {auth.state === 'error' && <p role="alert">{auth.message}</p>}
      </section>
      {(problem || error) && <p role="alert">{problem || error}</p>}
    </WorkspaceDialog>
  );
}
export function RepliesPane({
  inbox,
  busy,
  refresh,
  close,
  update,
  settings,
}: {
  inbox: Inbox;
  busy: boolean;
  refresh: () => void;
  close: () => void;
  update: (i: Inbox) => void;
  settings: () => void;
}) {
  const [error, setError] = useState('');
  const unread = inbox.items.filter((i) => i.unread).length;
  function act(task: Promise<Inbox>) {
    setError('');
    task.then(update).catch((e) => {
      setError(readableError(e));
      refresh();
    });
  }
  return (
    <WorkspaceDialog title="Review replies" icon={<Bell size={21} />} wide onClose={close}>
      <div className="inbox-actions">
        <small>
          {inbox.account
            ? '@' + inbox.account + ' · ' + unread + ' unread'
            : 'GitHub review threads'}
        </small>
        <button className="quiet" disabled={busy} aria-label="Refresh replies" onClick={refresh}>
          <RefreshCw size={15} />
        </button>
        {unread > 0 && inbox.account && (
          <button
            className="quiet"
            onClick={() => {
              if (inbox.account) act(window.reviewer.readReplies(inbox.account));
            }}
          >
            Mark all read
          </button>
        )}
      </div>
      {(error || inbox.error) && <p role="status">{error || inbox.error}</p>}
      {!inbox.account && !busy && <button onClick={settings}>GitHub account settings</button>}
      {!inbox.items.length && (
        <div className="inbox-empty">
          <Bell size={24} />
          <h3>{busy ? 'Checking for replies…' : 'No new replies'}</h3>
          <p>New replies to review comments on saved and monitored pull requests appear here.</p>
        </div>
      )}
      <div className="inbox-list">
        {inbox.items.map((item) => (
          <button
            key={item.id}
            className="reply-item"
            data-unread={item.unread}
            onClick={() => {
              if (inbox.account) act(window.reviewer.openReply(inbox.account, item.id));
            }}
          >
            <span className="visually-hidden">
              {item.unread ? 'Unread reply. ' : 'Read reply. '}
            </span>
            <span className="reply-by">
              <strong>@{item.author}</strong>
              <time dateTime={item.created}>
                {new Date(item.created).toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </time>
            </span>
            <small>
              {new URL(item.url).pathname.slice(1).replace('/pull/', ' #')} · {item.path}
            </small>
            <span className="reply-body">{item.body || 'Open review reply'}</span>
          </button>
        ))}
      </div>
    </WorkspaceDialog>
  );
}
