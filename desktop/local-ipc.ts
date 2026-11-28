import { clipboard, dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { localOperations } from './local-operations.js';
import type { openStore } from './store.js';

type Store = ReturnType<typeof openStore>;

// Thin Electron wrappers: each handler checks the sending frame, then runs the operation.
export function registerLocalReviews(
  store: Store,
  verify: (e: IpcMainInvokeEvent) => void,
  window: () => BrowserWindow | null,
  documents: string,
  shutdown: AbortSignal,
) {
  const operations = localOperations(store, {
    documents,
    signal: shutdown,
    async chooseFolder() {
      const owner = window();
      const options = {
        title: 'Choose a local Git repository',
        buttonLabel: 'Choose repository',
        properties: ['openDirectory' as const],
      };
      const choice = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options);
      return choice.canceled ? null : (choice.filePaths[0] ?? null);
    },
    async chooseSaveFile(defaultPath) {
      const owner = window();
      const options = {
        title: 'Save review for the coding agent',
        defaultPath,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      };
      const choice = owner
        ? await dialog.showSaveDialog(owner, options)
        : await dialog.showSaveDialog(options);
      return choice.canceled ? null : choice.filePath || null;
    },
    writeClipboard: (text) => clipboard.writeText(text),
  });
  const handle = (name: string, fn: (...args: unknown[]) => unknown) =>
    ipcMain.handle(name, (event, ...args: unknown[]) => {
      verify(event);
      return fn(...args);
    });
  handle('local:folders', () => store.local.folders());
  handle('local:add-folder', () => operations.addFolder());
  handle('local:choose', (savedPath) => operations.choose(savedPath));
  handle('local:start', (input) => operations.start(input));
  handle('local:brief', (input) => operations.brief(input));
  handle('local:copy-brief', (input, version, revision) =>
    operations.copy(input, version, revision),
  );
  handle('local:save-brief', (input, version, revision) =>
    operations.save(input, version, revision),
  );
}
