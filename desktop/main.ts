import { app, BrowserWindow, ipcMain, Notification, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStore } from './store.js';
import { z } from 'zod';
import { pinQuestion, questionKey } from '../shared/questions.js';
import { fileKey } from '../shared/reader.js';
import { fetchSnapshot, compareHeads, probeRevision } from './github.js';
import { registerWorkspace } from './workspace-ipc.js';
import { prAlerts } from './pr-alerts.js';
import { pullRequestUrl } from '../shared/reviews.js';

const html = join(import.meta.dirname, '../renderer/index.html');
const appIcon = join(app.getAppPath(), 'resources', 'local-reviewer.png');
const devUrl = import.meta.env.DEV ? process.env.ELECTRON_RENDERER_URL : undefined;
const rendererUrl = devUrl ? new URL('/', devUrl).href : pathToFileURL(html).href;
let window: BrowserWindow | null = null;

function verifySender(event: IpcMainInvokeEvent) {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    event.senderFrame?.url !== rendererUrl
  ) {
    throw new Error('Unrecognised review window.');
  }
}

function openWindow() {
  const view = new BrowserWindow({
    title: 'Local Reviewer',
    icon: appIcon,
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 14, y: 19 } }
      : {}),
    width: 1380,
    height: 720,
    minWidth: 570,
    minHeight: 440,
    backgroundColor: '#1c2c2e',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window = view;
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  view.webContents.on('will-navigate', (event) => event.preventDefault());
  view.on('closed', () => {
    window = null;
  });
  void view.loadURL(rendererUrl).catch(() => {
    console.error('Unable to load the Local Reviewer window.');
    app.exit(1);
  });
}

function startWorkspace() {
  app.dock?.setIcon(appIcon);
  const store = openStore(join(app.getPath('userData'), 'workspace.sqlite'));
  const reader = store.reader;
  // Notifications are kept until dismissed, or they could be collected before a click.
  const shown = new Set<Notification>();
  const alerts = prAlerts(
    {
      notify(title, body, onClick) {
        if (!Notification.isSupported()) return;
        const notice = new Notification({ title, body });
        // The system does not always report a dismissal, so keep only the latest few.
        if (shown.size >= 20)
          for (const oldest of shown) if (shown.size >= 20) shown.delete(oldest);
        shown.add(notice);
        const forget = () => shown.delete(notice);
        notice.on('click', () => {
          forget();
          onClick();
        });
        notice.on('close', forget);
        notice.on('failed', forget);
        notice.show();
      },
      // A count on the Dock or launcher icon. Windows has no equivalent here.
      badge: (count) => void app.setBadgeCount(count),
    },
    (url) => {
      if (!window) {
        // With no window to tell, make the PR the one a new window opens on.
        store.save(url);
        reader.select(url);
        assistant.seen(url);
        return openWindow();
      }
      if (window.isMinimized()) window.restore();
      window.show();
      window.webContents.send('monitor:open', url);
    },
  );
  const assistant = registerWorkspace(store, verifySender, app.getPath('userData'), alerts);
  app.on('browser-window-created', (_, win) => win.on('closed', assistant.cancel));
  let fetchController: AbortController | undefined;
  ipcMain.handle('reader:active', (event) => {
    verifySender(event);
    return reader.active();
  });
  ipcMain.handle('reader:select', (event, url: unknown) => {
    verifySender(event);
    // Answers keep running for the PR they belong to while another PR is open.
    reader.select(url);
    if (typeof url === 'string') assistant.seen(url);
    fetchController?.abort();
  });
  ipcMain.handle('reader:cached', (event, url: unknown) => {
    verifySender(event);
    return reader.read(url);
  });
  ipcMain.handle('questions:pin', (event, input: unknown) => {
    verifySender(event);
    return reader.questions.pin(pinQuestion.parse(input));
  });
  ipcMain.handle('questions:address', (event, input: unknown, value: unknown) => {
    verifySender(event);
    return reader.questions.address(questionKey.parse(input), z.boolean().parse(value));
  });
  ipcMain.handle('questions:evidence', (event, input: unknown) => {
    verifySender(event);
    return reader.questions.evidence(questionKey.parse(input));
  });
  ipcMain.handle('reader:patch', (event, key: unknown) => {
    verifySender(event);
    return reader.patch(key);
  });
  ipcMain.handle('reader:remember', (event, value: unknown) => {
    verifySender(event);
    reader.checkpoint(value);
  });
  const target = z.object({ url: pullRequestUrl, revision: z.string() });
  const etags = new Map<string, string>();
  function activeUrl(input: unknown) {
    const url = pullRequestUrl.parse(input);
    if (url !== reader.active()) throw Error('Select this saved PR before fetching.');
    return url;
  }
  async function refresh(url: string, controller: AbortController) {
    const snapshot = await fetchSnapshot(url, controller.signal);
    controller.signal.throwIfAborted();
    snapshot.revision = reader.revisions.identify(url, snapshot.revision, snapshot.meta.baseBranch);
    const current = reader.read(url);
    if (!current || snapshot.revision === current.revision) return reader.install(url, snapshot);
    const baseline = reader.revisions.baseline(url);
    const from = baseline.split('...').at(-1) ?? current.meta.head;
    const heads = await compareHeads(url, from, snapshot.meta.head, controller.signal);
    controller.signal.throwIfAborted();
    reader.revisions.stage(url, snapshot, heads, baseline);
    return reader.read(url);
  }
  function nextFetch() {
    fetchController?.abort();
    fetchController = new AbortController();
    return fetchController;
  }
  ipcMain.handle('reader:refresh', async (event, input: unknown) => {
    verifySender(event);
    const url = activeUrl(input);
    etags.delete(url);
    return refresh(url, nextFetch());
  });
  ipcMain.handle('reader:probe', async (event, input: unknown) => {
    verifySender(event);
    const url = activeUrl(input);
    const controller = nextFetch();
    const info = await probeRevision(url, controller.signal, etags.get(url));
    controller.signal.throwIfAborted();
    const current = reader.read(url);
    if (!info) return current?.incoming ?? null;
    info.revision = reader.revisions.identify(url, info.revision, info.baseBranch);
    if (info.revision === current?.revision) reader.revisions.clearStage(url);
    else if (info.revision !== current?.incoming) await refresh(url, controller);
    if (info.etag) etags.set(url, info.etag);
    return reader.revisions.info(url).incoming;
  });
  ipcMain.handle('reader:open-update', (event, input: unknown) => {
    verifySender(event);
    const { url, revision } = target.parse(input);
    activeUrl(url);
    const { snapshot, heads } = reader.revisions.pending(url, revision);
    fetchController?.abort();
    return reader.install(url, snapshot, heads);
  });
  ipcMain.handle('reader:finish', (event, input: unknown) => {
    verifySender(event);
    const { url, revision } = target.parse(input);
    activeUrl(url);
    reader.revisions.finish(url, revision);
    fetchController?.abort();
    return reader.read(url);
  });
  ipcMain.handle('reader:comparison-position', (event, input: unknown) => {
    verifySender(event);
    const { url, revision, since, path } = target
      .extend({ since: z.boolean(), path: z.string().nullable() })
      .parse(input);
    activeUrl(url);
    reader.revisions.position(url, revision, since, path);
  });
  ipcMain.handle('reader:comparison-mark', (event, input: unknown, value: unknown) => {
    verifySender(event);
    const key = fileKey.parse(input);
    activeUrl(key.url);
    reader.revisions.markAbsent(key, z.boolean().parse(value));
    return reader.read(key.url);
  });
  ipcMain.handle('reader:evidence', (event, input: unknown) => {
    verifySender(event);
    return reader.revisions.evidence(input);
  });
  ipcMain.handle('appearance:get', (event) => {
    verifySender(event);
    return store.getAppearance();
  });
  ipcMain.handle('appearance:save', (event, value: unknown) => {
    verifySender(event);
    store.saveAppearance(value);
  });
  ipcMain.handle('accent:get', (event) => {
    verifySender(event);
    return store.getAccent();
  });
  ipcMain.handle('accent:save', (event, value: unknown) => {
    verifySender(event);
    store.saveAccent(value);
  });
  ipcMain.handle('reviews:list', (event) => {
    verifySender(event);
    return store.list();
  });
  ipcMain.handle('reviews:save', (event, url: unknown) => {
    verifySender(event);
    return store.save(url);
  });
  app.once('will-quit', () => {
    assistant.close();
    fetchController?.abort();
    store.close();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (!window) openWindow();
  });
  openWindow();
}

app
  .whenReady()
  .then(startWorkspace)
  .catch((error: unknown) => {
    console.error(
      'Unable to initialise the workspace.',
      error instanceof Error ? error.message : 'Unknown error',
    );
    app.exit(1);
  });
