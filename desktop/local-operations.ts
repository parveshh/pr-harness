import { randomUUID } from 'node:crypto';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  localCandidate,
  localReviewBrief,
  localStart,
  type LocalCandidate,
} from '../shared/local.js';
import { localReviewKey } from '../shared/reviews.js';
import {
  insideFolder,
  inspectRepository,
  LocalReviewError,
  localSnapshot,
} from './local-branch.js';
import type { openStore } from './store.js';

type Store = ReturnType<typeof openStore>;
// What the operations need from the desktop shell. Electron provides these in local-ipc.ts;
// tests pass plain functions.
export type LocalPlatform = {
  chooseFolder(): Promise<string | null>;
  chooseSaveFile(defaultPath: string): Promise<string | null>;
  writeClipboard(text: string): Promise<void>;
  documents: string;
  signal: AbortSignal;
};

const version = z.number().int().nonnegative();
const revision = z.string().min(1).max(400);

export function localOperations(store: Store, platform: LocalPlatform) {
  const { signal } = platform;
  // The folder chosen in the dialog. Starting a review refers to it by id, so the window
  // never supplies a filesystem path.
  let candidate: (LocalCandidate & { root: string }) | undefined;

  function brief(input: unknown, expected?: { version: unknown; revision: unknown }) {
    const url = localReviewKey.parse(input);
    const review = store.local.require(url);
    const view = store.reader.read(url);
    if (!view || store.reader.active() !== url) throw Error('Reopen this local review first.');
    const bundle = store.drafts.get(url);
    // Copy and save rebuild the brief, so it must match the preview the reviewer read.
    if (expected) {
      if (bundle.version !== version.parse(expected.version))
        throw Error('Drafts changed. Review the brief again.');
      if (view.revision !== revision.parse(expected.revision))
        throw Error('The review moved to another revision. Review the brief again.');
    }
    return {
      review,
      version: bundle.version,
      revision: view.revision,
      text: localReviewBrief({
        repository: review.repository,
        branch: review.branch,
        baseBranch: view.meta.baseBranch,
        revision: view.revision,
        mergeBase: view.meta.mergeBase ?? null,
        summary: bundle.summary,
        comments: bundle.comments,
      }),
    };
  }

  return {
    async choose() {
      const folder = await platform.chooseFolder();
      if (!folder) return null;
      candidate = undefined;
      const info = await inspectRepository(folder, signal);
      if (!info.bases.length)
        throw new LocalReviewError(
          'This repository has no branches to compare with. Create or fetch a base branch first.',
        );
      const chosen = localCandidate.parse({
        id: randomUUID(),
        path: info.root,
        repository: info.repository,
        branch: info.branch,
        head: info.head,
        bases: info.bases,
        defaultBase: info.defaultBase,
      });
      candidate = { ...chosen, root: info.root };
      return chosen;
    },
    async start(input: unknown) {
      const request = localStart.parse(input);
      const chosen = candidate;
      if (chosen?.id !== request.id) throw Error('Choose the repository folder again.');
      const base = chosen.bases.find((b) => b.ref === request.base);
      if (!base) throw Error('Choose a base branch from the list.');
      const snapshot = await localSnapshot(chosen.root, base.ref, signal);
      // The review is keyed by what the dialog showed: the branch, or the detached commit.
      const moved =
        snapshot.meta.headBranch !== (chosen.branch ?? 'HEAD') ||
        (chosen.branch === null && snapshot.meta.head !== chosen.head);
      if (moved) {
        candidate = undefined;
        throw new LocalReviewError(
          'The repository switched branches after it was chosen. Choose the folder again.',
        );
      }
      if (!snapshot.files.length)
        throw new LocalReviewError(
          'There are no changes between ' +
            (chosen.branch ?? 'HEAD') +
            ' and ' +
            base.name +
            '. Choose another base branch.',
        );
      const url = store.local.save({
        path: chosen.root,
        baseRef: base.ref,
        baseName: base.name,
        repository: chosen.repository,
        branch: chosen.branch,
        detached: chosen.branch ? null : snapshot.meta.head,
      });
      // A reopened review keeps its progress. Opening it loads the newer revision as an update.
      if (!store.reader.read(url)) store.reader.install(url, snapshot);
      candidate = undefined;
      return { url, reviews: store.list() };
    },
    brief(input: unknown) {
      const { version, revision, text } = brief(input);
      return { version, revision, text };
    },
    async copy(input: unknown, version: unknown, revision: unknown) {
      await platform.writeClipboard(brief(input, { version, revision }).text);
    },
    async save(input: unknown, version: unknown, revision: unknown) {
      const { review } = brief(input, { version, revision });
      const name = (review.repository + '-' + (review.branch ?? 'review'))
        .replace(/[^\w.-]+/g, '-')
        .slice(0, 80);
      const chosen = await platform.chooseSaveFile(join(platform.documents, name + '-review.md'));
      if (!chosen) return false;
      const target = resolve(chosen);
      // Writing into the reviewed repository would change the working tree under review.
      let folder: string;
      try {
        folder = await realpath(dirname(target));
      } catch {
        throw new LocalReviewError('That folder is unavailable. Choose another folder.');
      }
      const root = await realpath(review.path).catch(() => review.path);
      const destination = join(folder, basename(target));
      if (insideFolder(root, destination))
        throw new LocalReviewError(
          'Choose a folder outside the reviewed repository. Saving inside it would change the working tree under review.',
        );
      const { text } = brief(input, { version, revision });
      const temporary = join(folder, '.local-reviewer-' + randomUUID() + '.tmp');
      let created = false;
      try {
        const existing = await lstat(destination).catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
          throw error;
        });
        if (existing && !existing.isFile()) throw Error('Choose a regular file.');
        // Replace the directory entry atomically so other links keep their original contents.
        const file = await open(temporary, 'wx', 0o600);
        created = true;
        try {
          await file.writeFile(text, 'utf8');
        } finally {
          await file.close();
        }
        await rename(temporary, destination);
        created = false;
      } catch {
        throw new LocalReviewError('The brief could not be saved there. Choose another file.');
      } finally {
        if (created) await unlink(temporary).catch(() => {});
      }
      return true;
    },
  };
}
