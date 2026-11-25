import type { DatabaseSync } from 'node:sqlite';
import { pullReviewFields, pullReviewInfo, summarizePullReviews } from './pull-review-status.js';
import { z } from 'zod';
import { pullRequestUrl, pullState, type PullState } from '../shared/reviews.js';
import { reviewChange, type ReviewChange } from '../shared/workspace.js';
import type { Graphql } from './github.js';

export function migrateReviewActivity(db: DatabaseSync) {
  db.exec(`
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
  `);
  // Early v17 workspaces kept a required draft flag on each account's observation.
  if (
    db.prepare("SELECT 1 FROM pragma_table_info('review_observations') WHERE name='draft'").get()
  ) {
    // Accounts can have different cached values with no observation time to order them.
    // Leave disputed flags unknown until refresh and keep any existing PR-wide status.
    db.exec(`
      INSERT INTO pull_draft_status(url,draft)
      SELECT url, MIN(draft) FROM review_observations GROUP BY url HAVING MIN(draft)=MAX(draft)
      ON CONFLICT(url) DO NOTHING;
      ALTER TABLE review_observations DROP COLUMN draft;
    `);
  }
  db.exec('PRAGMA user_version=18');
}

// A v19 preview required a count and approval for every head. A fresh GitHub
// snapshot may arrive before its reviews, so those two fields can now be unknown.
export function migratePullReviewStatus(db: DatabaseSync, version: number) {
  if (version === 19) db.exec('ALTER TABLE pull_review_status RENAME TO pull_review_status_v19');
  db.exec(`CREATE TABLE IF NOT EXISTS pull_review_status (
    url TEXT PRIMARY KEY REFERENCES reply_targets(url) ON DELETE CASCADE,
    head TEXT NOT NULL, commit_count INTEGER, approval_stage TEXT
  ) STRICT`);
  if (version === 19)
    db.exec(`
    INSERT INTO pull_review_status(url, head, commit_count, approval_stage)
    SELECT url, head, commit_count, approval_stage FROM pull_review_status_v19;
    DROP TABLE pull_review_status_v19;
  `);
  db.exec('PRAGMA user_version=20');
}

const status = pullReviewInfo.extend({
  state: pullState,
  updatedAt: z.iso.datetime().optional(),
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
      state updatedAt isDraft ${pullReviewFields}
      latest:reviews(last:1,author:$author,states:[APPROVED,CHANGES_REQUESTED,COMMENTED,DISMISSED]){nodes{commit{oid}}}
      dismissed:reviews(first:1,author:$author,states:[DISMISSED]){totalCount}
    }}
  }`;
  const pull = response.parse(
    JSON.parse(await graphql(query, { owner, name, author: account }, signal)),
  ).data.repository.pullRequest;
  const summary = await summarizePullReviews(
    pull,
    account,
    owner,
    name,
    Number(number),
    graphql,
    signal,
  );
  return {
    state: pull.state,
    ...(pull.updatedAt ? { updatedAt: pull.updatedAt } : {}),
    isDraft: pull.isDraft,
    headRefOid: pull.headRefOid,
    latest: pull.latest,
    dismissed: pull.dismissed,
    commitCount: summary.commitCount,
    approvalStage: summary.approvalStage,
  };
}

// Reader and background refreshes can finish out of order. A merge is final, and
// GitHub's update time orders close/reopen observations independently of the local clock.
export function savePullState(
  db: DatabaseSync,
  url: string,
  state: PullState | undefined,
  updatedAt: string | undefined,
) {
  if (!state) return false;
  return (
    db
      .prepare(
        `INSERT INTO pull_lifecycle(url,state,updated_at)
    SELECT url,?,? FROM reply_targets WHERE url=?
    ON CONFLICT(url) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at
    WHERE pull_lifecycle.state != 'MERGED' AND
      (excluded.state='MERGED' OR excluded.updated_at >= pull_lifecycle.updated_at) AND
      (excluded.state != pull_lifecycle.state OR excluded.updated_at != pull_lifecycle.updated_at)`,
      )
      .run(state, updatedAt ? new Date(updatedAt).toISOString() : '', url).changes > 0
  );
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
      current: Awaited<ReturnType<typeof readReviewStatus>>,
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
          savePullState(db, url, current.state, current.updatedAt);
          saveDraftStatus(db, url, current.isDraft);
          db.prepare(
            'INSERT OR REPLACE INTO pull_review_status(url,head,commit_count,approval_stage) VALUES(?,?,?,?)',
          ).run(url, current.headRefOid, current.commitCount, current.approvalStage);
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
