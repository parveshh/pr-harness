import type { DatabaseSync } from 'node:sqlite';
import { turn, type Turn } from '../shared/assistant.js';
import { maxFindingChars, type AssessFinding, type DraftFindings } from '../shared/findings.js';
import type { CommentAnchor } from '../shared/publish.js';
import type { draftStore } from './draft-store.js';
import { excerpt } from './anchors.js';
import { appendSuggestion } from '../shared/suggestions.js';

export function findingStore(
  db: DatabaseSync,
  drafts: ReturnType<typeof draftStore>,
  currentRevision: (url: string) => string | undefined,
  patch: (url: string, revision: string, path: string) => string,
) {
  function change<T>(url: string, run: string, update: (msg: Turn) => T) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare('SELECT data FROM conversation WHERE url=? AND run=?').get(url, run);
      if (!row) throw Error('Reopen the findings report for this pull request.');
      const msg = turn.parse(JSON.parse(String(row.data)));
      if (currentRevision(url) !== msg.revision)
        throw Error('The reviewed revision changed. Run Review PR again.');
      const result = update(msg);
      db.prepare('UPDATE conversation SET data=? WHERE url=? AND run=?').run(
        JSON.stringify(msg),
        url,
        run,
      );
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return {
    assess({ url, run, id, verdict }: AssessFinding) {
      return change(url, run, (msg) => {
        const finding = msg.findings?.find((f) => f.id === id);
        if (!finding || finding.drafted) throw Error('This finding can no longer be assessed.');
        finding.verdict = verdict;
        return msg;
      });
    },
    draft({ url, run, version, ids }: DraftFindings) {
      return change(url, run, (msg) => {
        const bundle = drafts.get(url);
        const selected = [...new Set(ids)].map((id) => msg.findings?.find((f) => f.id === id));
        if (selected.every((f) => f?.drafted)) return { turn: msg, bundle };
        if (bundle.pending) throw Error('Check the previous submission before adding drafts.');
        if (bundle.version !== version)
          throw Error('Drafts changed. Reopen the review and try again.');
        const comments = [...bundle.comments];
        for (const f of selected) {
          if (f?.drafted) continue;
          if (!f || f.verdict !== 'valid' || !f.location)
            throw Error('Select valid findings with verified diff locations.');
          const anchor: CommentAnchor = f.location;
          const text = excerpt(patch(url, msg.revision, anchor.path), anchor, maxFindingChars);
          if (text === undefined || text !== f.location.excerpt)
            throw Error('The cited lines changed. Run Review PR again.');
          comments.push({
            ...anchor,
            id: f.id,
            revision: msg.revision,
            excerpt: text,
            // A suggestion can only replace new-side lines, so an old-side anchor keeps prose.
            body:
              f.suggestion && anchor.side === 'new'
                ? appendSuggestion(f.comment, f.suggestion.split('\n')).body
                : f.comment,
          });
          f.drafted = true;
        }
        return { turn: msg, bundle: drafts.write(url, version, { ...bundle, comments }) };
      });
    },
  };
}
