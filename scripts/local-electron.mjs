import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import electron from 'electron';
import electronPackage from 'electron/package.json' with { type: 'json' };
import manifest from '../package.json' with { type: 'json' };

// AppKit takes the application menu title from the running bundle's Info.plist.
// Keep the installed Electron distribution intact for packaging and other tools.
async function macExecutable() {
  const name = manifest.productName;
  const cache = resolve(
    import.meta.dirname,
    '../node_modules/.cache/local-reviewer',
    electronPackage.version + '-' + process.arch,
  );
  const bundle = join(cache, name + '.app');
  const executable = join(bundle, 'Contents/MacOS', basename(electron));
  if (existsSync(executable)) return executable;

  await mkdir(cache, { recursive: true });
  const staging = await mkdtemp(join(cache, 'prepare-'));
  try {
    const copy = join(staging, name + '.app');
    execFileSync('/usr/bin/ditto', [resolve(dirname(electron), '../..'), copy]);
    for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
      execFileSync('/usr/bin/plutil', [
        '-replace',
        key,
        '-string',
        name,
        join(copy, 'Contents/Info.plist'),
      ]);
    }
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', copy]);
    try {
      await rename(copy, bundle);
    } catch (error) {
      if (!['ENOTEMPTY', 'EEXIST'].includes(error.code) || !existsSync(executable)) throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return executable;
}

export const localElectron =
  process.env.ELECTRON_EXEC_PATH ||
  (process.platform === 'darwin' ? await macExecutable() : electron);
process.env.ELECTRON_EXEC_PATH = localElectron;
