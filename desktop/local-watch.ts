import { watch } from 'node:fs';

// Watch directories so an editor's atomic replacement of a file keeps generating events.
// Git still decides whether the working tree actually changed when the reader probes it.
export function watchLocalChanges(path: string, changed: () => void, unavailable: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watcher = watch(path, { recursive: true, persistent: false }, (_, filename) => {
    const name = filename?.replaceAll('\\', '/');
    if (name?.startsWith('.git/') && !/^\.git\/(?:HEAD$|index$|packed-refs$|refs\/)/.test(name))
      return;
    if (!timer)
      timer = setTimeout(() => {
        timer = undefined;
        changed();
      }, 400);
  });
  watcher.on('error', unavailable);
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}
