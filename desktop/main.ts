import {
  app,
  BrowserWindow,
  ipcMain,
  nativeTheme,
  Notification,
  type IpcMainInvokeEvent,
} from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { watchLocalChanges } from './local-watch.js';
import { openStore } from './store.js';
import { z } from 'zod';
import { pinQuestion, questionKey } from '../shared/questions.js';
import { fileKey, revisionHead } from '../shared/reader.js';
import { fetchSnapshot, compareHeads, probeRevision } from './github.js';
import { registerWorkspace } from './workspace-ipc.js';
import { prAlerts } from './pr-alerts.js';
import { isLocalReview, reviewKey } from '../shared/reviews.js';
import { registerLocalReviews } from './local-ipc.js';
import {
  localReviewRevision,
  localReviewSnapshot,
  localReviewSource,
  pinnedRevision,
} from './local-branch.js';

import { pinnedSource } from './pr-source.js';

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

const solidWindowBackground = '#1c2c2e';
function applySidebarVibrancy(view: BrowserWindow, enabled: boolean) {
  view.setVibrancy(enabled ? 'sidebar' : null);
  view.setBackgroundColor(enabled ? '#00000000' : solidWindowBackground);
}

function openWindow(sidebarVibrancy: boolean) {
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
    backgroundColor: solidWindowBackground,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (process.platform === 'darwin' && sidebarVibrancy) applySidebarVibrancy(view, true);
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
  function syncMacFrameAppearance() {
    if (process.platform === 'darwin')
      nativeTheme.themeSource = store.getAppearance() === 'light' ? 'light' : 'dark';
  }
  syncMacFrameAppearance();
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
        diffSearchController?.abort();
        assistant.seen(url);
        return openWindow(store.getSidebarVibrancy());
      }
      if (window.isMinimized()) window.restore();
      window.show();
      window.webContents.send('monitor:open', url);
    },
  );
  const assistant = registerWorkspace(store, verifySender, app.getPath('userData'), alerts);
  app.on('browser-window-created', (_, win) => win.on('closed', assistant.cancel));
  const shutdown = new AbortController();
  registerLocalReviews(
    store,
    verifySender,
    () => window,
    app.getPath('documents'),
    shutdown.signal,
  );
  let watched: { url: string; close: () => void } | undefined;
  function stopWatching() {
    watched?.close();
    watched = undefined;
  }
  function watchReview(url: string) {
    if (watched?.url === url) return;
    stopWatching();
    try {
      const close = watchLocalChanges(
        store.local.require(url).path,
        () => {
          if (watched?.close === close) window?.webContents.send('reader:local-changed', url);
        },
        () => {
          if (watched?.close === close) stopWatching();
        },
      );
      watched = { url, close };
    } catch {
      // Filesystem notifications may be unavailable. The periodic Git probe still runs.
    }
  }
  app.on('window-all-closed', stopWatching);
  let diffSearchController: AbortController | undefined;
  let fetchController: AbortController | undefined;
  ipcMain.handle('reader:active', (event) => {
    verifySender(event);
    return reader.active();
  });
  ipcMain.handle('reader:select', (event, url: unknown) => {
    verifySender(event);
    // Answers keep running for the PR they belong to while another PR is open.
    reader.select(url);
    if (url !== watched?.url) stopWatching();
    if (typeof url === 'string') assistant.seen(url);
    diffSearchController?.abort();
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
  ipcMain.handle('reader:search', (event, request: unknown) => {
    verifySender(event);
    diffSearchController?.abort();
    diffSearchController = new AbortController();
    return reader.searchDiff(request, diffSearchController.signal);
  });
  ipcMain.handle('reader:patch', (event, key: unknown) => {
    verifySender(event);
    return reader.patch(key);
  });
  ipcMain.handle('reader:remember', (event, value: unknown) => {
    verifySender(event);
    reader.checkpoint(value);
  });
  const target = z.object({ url: reviewKey, revision: z.string() });
  const etags = new Map<string, string>();
  function activeUrl(input: unknown) {
    const url = reviewKey.parse(input);
    if (url !== reader.active()) throw Error('Select this saved review before fetching.');
    return url;
  }
  // Stage the saved diff inventory. The reader loads direct local commit comparisons on demand.
  const savedDiffs = { ancestry: 'unknown' as const, partial: false, files: [] };
  async function refreshLocal(url: string, controller: AbortController) {
    const snapshot = await localReviewSnapshot(store.local, url, controller.signal);
    controller.signal.throwIfAborted();
    const current = reader.read(url);
    if (!current || snapshot.revision === current.revision) return reader.install(url, snapshot);
    reader.revisions.stage(url, snapshot, savedDiffs, reader.revisions.baseline(url));
    return reader.read(url);
  }
  async function refresh(url: string, controller: AbortController) {
    if (isLocalReview(url)) {
      watchReview(url);
      return refreshLocal(url, controller);
    }
    const snapshot = await fetchSnapshot(url, controller.signal);
    controller.signal.throwIfAborted();
    reader.observePullState(url, snapshot.state, snapshot.updatedAt);
    reader.observeRemoteHead(url, snapshot.meta.head, snapshot.meta.commitCount);
    snapshot.revision = reader.revisions.identify(url, snapshot.revision, snapshot.meta.baseBranch);
    const current = reader.read(url);
    if (!current || snapshot.revision === current.revision) return reader.install(url, snapshot);
    const baseline = reader.revisions.baseline(url);
    const from = baseline.split('...').at(-1) ?? current.meta.head;
    const heads = await compareHeads(url, from, snapshot.meta.head, controller.signal);
    controller.signal.throwIfAborted();
    reader.setDraft(url, snapshot.meta.isDraft);
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
  ipcMain.handle('reader:refresh-local-file', async (event, input: unknown) => {
    verifySender(event);
    const key = fileKey.extend({ incoming: z.string().optional() }).parse(input);
    const url = activeUrl(key.url);
    if (!isLocalReview(url)) throw Error('Choose a local review first.');
    function checkFile() {
      const current = reader.read(url);
      const file = current?.files.find((item) => item.path === key.path);
      if (
        !file ||
        current?.revision !== key.revision ||
        current.selected !== key.path ||
        current.since
      )
        throw Error('Reopen the selected file before retrying.');
      return file;
    }
    const selected = checkFile();
    if (key.incoming !== undefined) {
      const { snapshot, heads } = reader.revisions.pending(url, key.incoming);
      fetchController?.abort();
      return reader.install(url, snapshot, heads, selected);
    }
    const controller = nextFetch();
    const snapshot = await localReviewSnapshot(store.local, url, controller.signal);
    controller.signal.throwIfAborted();
    return reader.install(url, snapshot, savedDiffs, checkFile());
  });
  ipcMain.handle('reader:probe', async (event, input: unknown) => {
    verifySender(event);
    const url = activeUrl(input);
    const controller = nextFetch();
    if (isLocalReview(url)) {
      watchReview(url);
      const revision = await localReviewRevision(store.local, url, controller.signal);
      controller.signal.throwIfAborted();
      const current = reader.read(url);
      if (revision === current?.revision) reader.revisions.clearStage(url);
      else if (revision !== current?.incoming) await refreshLocal(url, controller);
      return { incoming: reader.revisions.info(url).incoming };
    }
    const info = await probeRevision(url, controller.signal, etags.get(url));
    controller.signal.throwIfAborted();
    const current = reader.read(url);
    if (!info) return { incoming: current?.incoming ?? null, isDraft: current?.meta.isDraft };
    const statusChanged = reader.observePullState(url, info.state, info.updatedAt);
    reader.setDraft(url, info.isDraft);
    info.revision = reader.revisions.identify(url, info.revision, info.baseBranch);
    if (info.revision === current?.revision) reader.revisions.clearStage(url);
    else if (info.revision !== current?.incoming) await refresh(url, controller);
    if (info.etag) etags.set(url, info.etag);
    return { incoming: reader.revisions.info(url).incoming, isDraft: info.isDraft, statusChanged };
  });
  ipcMain.handle('reader:open-update', (event, input: unknown) => {
    verifySender(event);
    const { url, revision } = target.parse(input);
    activeUrl(url);
    const { snapshot, heads } = reader.revisions.pending(url, revision);
    fetchController?.abort();
    // Draft status can change again while a new revision is staged.
    if (!isLocalReview(url))
      snapshot.meta.isDraft = reader.read(url)?.meta.isDraft ?? snapshot.meta.isDraft;
    return reader.install(url, snapshot, heads);
  });
  ipcMain.handle('reader:finish', (event, input: unknown) => {
    verifySender(event);
    const { url, revision } = target.parse(input);
    activeUrl(url);
    if (isLocalReview(url)) reader.revisions.checkpoint(url, revision);
    else reader.revisions.finish(url, revision);
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
  ipcMain.handle('reader:evidence', async (event, input: unknown) => {
    verifySender(event);
    const key = fileKey.parse(input);
    activeUrl(key.url);
    const evidence = reader.revisions.evidence(key);
    if (evidence.incremental !== null) return evidence;
    const view = reader.read(key.url);
    const comparison = view?.comparison;
    if (!view || !comparison || !comparison.files.some((file) => file.path === key.path))
      return evidence;
    const before = revisionHead(comparison.baseline);
    try {
      const incremental = isLocalReview(key.url)
        ? await localReviewSource(store.local, key.url, pinnedRevision(view)).changesBetween(
            before,
            key.path,
            shutdown.signal,
          )
        : await pinnedSource(join(app.getPath('userData'), 'pr-source'), key.url).changesBetween(
            before,
            view.meta.head,
            key.path,
            shutdown.signal,
          );
      return { ...evidence, incremental };
    } catch {
      shutdown.signal.throwIfAborted();
      // Missing objects and older working-tree snapshots can still be compared by saved hunks.
      return evidence;
    }
  });
  ipcMain.handle('appearance:sidebar-vibrancy', (event) => {
    verifySender(event);
    return process.platform === 'darwin' && store.getSidebarVibrancy();
  });
  ipcMain.handle('appearance:save-sidebar-vibrancy', (event, value: unknown) => {
    verifySender(event);
    const enabled = z.boolean().parse(value);
    if (process.platform !== 'darwin' || !window)
      throw Error('Sidebar vibrancy requires a Mac window.');
    const previous = store.getSidebarVibrancy();
    try {
      applySidebarVibrancy(window, enabled);
      store.saveSidebarVibrancy(enabled);
    } catch (error) {
      applySidebarVibrancy(window, previous);
      throw error;
    }
  });
  ipcMain.handle('shortcuts:get', (event) => {
    verifySender(event);
    return store.getSingleKeyShortcuts();
  });
  ipcMain.handle('shortcuts:save', (event, value: unknown) => {
    verifySender(event);
    store.saveSingleKeyShortcuts(z.boolean().parse(value));
  });
  ipcMain.handle('appearance:get', (event) => {
    verifySender(event);
    return store.getAppearance();
  });
  ipcMain.handle('appearance:save', (event, value: unknown) => {
    verifySender(event);
    store.saveAppearance(value);
    syncMacFrameAppearance();
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
    stopWatching();
    assistant.close();
    shutdown.abort();
    fetchController?.abort();
    store.close();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (!window) openWindow(store.getSidebarVibrancy());
  });
  openWindow(store.getSidebarVibrancy());
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
