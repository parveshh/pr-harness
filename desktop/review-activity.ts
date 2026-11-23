import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { pullRequestUrl } from '../shared/reviews.js';
import { reviewChange, type ReviewChange } from '../shared/workspace.js';
import type { Graphql } from './github.js';

export const reviewActivityMigration = `
CREATE TABLE IF NOT EXISTS pull_draft_status (
  url TEXT PRIMARY KEY REFERENCES reply_targets(url) ON DELETE CASCADE, draft INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS review_observations (
  account TEXT NOT NULL, url TEXT NOT NULL REFERENCES reply_targets(url) ON DELETE CASCADE,
  head TEXT NOT NULL, dismissed INTEGER NOT NULL,
  PRIMARY KEY(account,url)
) STRICT;
CREATE TABLE IF NOT EXISTS review_changes (
  id INTEGER PRIMARY KEY, account TEXT NOT NULL, url TEXT NOT NULL, kind TEXT NOT NULL,
  head TEXT NOT NULL, created TEXT NOT NULL, unread INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE INDEX IF NOT EXISTS review_changes_inbox ON review_changes(account,created);
PRAGMA user_version=17;`;

const status = z.object({
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  headRefOid: z.string().min(1),
  isDraft: z.boolean(),
  dismissed: z.object({ totalCount: z.number().int().nonnegative() }),
  latest: z.object({
    nodes: z.array(z.object({ commit: z.object({ oid: z.string() }).nullable() })),
  }),
});
const response = z.object({ data: z.object({ repository: z.object({ pullRequest: status }) }) });

export async function readReviewStatus(
  url: string,
  account: string,
  graphql: Graphql,
  signal: AbortSignal,
) {
  const [, owner = '', name = '', , number] = new URL(pullRequestUrl.parse(url)).pathname.split(
    '/',
  );
  const query = `query ReviewStatus($owner:String!,$name:String!,$author:String!){
    repository(owner:$owner,name:$name){pullRequest(number:${number}){
      state headRefOid isDraft
      latest:reviews(last:1,author:$author,states:[APPROVED,CHANGES_REQUESTED,COMMENTED,DISMISSED]){nodes{commit{oid}}}
      dismissed:reviews(first:1,author:$author,states:[DISMISSED]){totalCount}
    }}
  }`;
  return response.parse(JSON.parse(await graphql(query, { owner, name, author: account }, signal)))
    .data.repository.pullRequest;
}

export function saveDraftStatus(db: DatabaseSync, url: string, isDraft: boolean | undefined) {
  if (isDraft !== undefined)
    db.prepare(
      'INSERT OR REPLACE INTO pull_draft_status(url,draft) SELECT url,? FROM reply_targets WHERE url=?',
    ).run(Number(isDraft), url);
}

export function reviewActivityStore(db: DatabaseSync) {
  return {
    observe(
      account: string,
      url: string,
      registered: string,
      current: z.infer<typeof status>,
      created: string,
    ) {
      const added: ReviewChange[] = [];
      db.exec('BEGIN IMMEDIATE');
      try {
        if (
          db
            .prepare('SELECT 1 FROM reply_targets WHERE url=? AND registered=?')
            .get(url, registered)
        ) {
          const previous = db
            .prepare('SELECT head,dismissed FROM review_observations WHERE account=? AND url=?')
            .get(account, url);
          const record = (kind: ReviewChange['kind']) => {
            const { lastInsertRowid } = db
              .prepare(
                'INSERT INTO review_changes(account,url,kind,head,created) VALUES(?,?,?,?,?)',
              )
              .run(account, url, kind, current.headRefOid, created);
            added.push({
              id: Number(lastInsertRowid),
              kind,
              url,
              head: current.headRefOid,
              created,
              unread: true,
            });
          };
          saveDraftStatus(db, url, current.isDraft);
          const review = current.latest.nodes[0];
          if (previous) {
            if (current.dismissed.totalCount > Number(previous.dismissed)) record('dismissed');
            if (
              current.state === 'OPEN' &&
              previous.head !== current.headRefOid &&
              review &&
              review.commit?.oid !== current.headRefOid
            )
              record('push');
          }
          db.prepare(
            'INSERT OR REPLACE INTO review_observations(account,url,head,dismissed) VALUES(?,?,?,?)',
          ).run(account, url, current.headRefOid, current.dismissed.totalCount);
        }
        db.exec('COMMIT');
        return added;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    changes(account: string) {
      return db
        .prepare('SELECT * FROM review_changes WHERE account=? ORDER BY id DESC')
        .all(account)
        .map((row) => reviewChange.parse({ ...row, unread: row.unread === 1 }));
    },
    markChange(account: string, id?: number) {
      if (id === undefined)
        db.prepare('UPDATE review_changes SET unread=0 WHERE account=? AND unread=1').run(account);
      else
        db.prepare('UPDATE review_changes SET unread=0 WHERE account=? AND id=?').run(account, id);
    },
  };
}
