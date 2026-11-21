import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  defaultPrompt,
  repoOf,
  reviewPrompt,
  selection,
  repository,
  turn,
  type Scope,
  type Selection,
  type Repository,
  type Turn,
  type AgentId,
} from '../shared/assistant.js';
export const assistantMigration = `
CREATE TABLE repositories (name TEXT PRIMARY KEY,authors TEXT NOT NULL DEFAULT '[]',watching TEXT NOT NULL DEFAULT '[]',pulls TEXT NOT NULL DEFAULT '[]',checked TEXT,error TEXT) STRICT;
CREATE TABLE agent_preferences(scope TEXT PRIMARY KEY,settings TEXT NOT NULL) STRICT;
CREATE TABLE agent_paths(agent TEXT PRIMARY KEY,path TEXT NOT NULL) STRICT;
CREATE TABLE conversation(id INTEGER PRIMARY KEY,run TEXT NOT NULL UNIQUE,url TEXT NOT NULL REFERENCES saved_reviews(url),data TEXT NOT NULL) STRICT;
CREATE INDEX conversation_pr ON conversation(url,id);
PRAGMA user_version=3;`;
// Choosing an agent or model in earlier versions also saved a copy of the built-in prompt.
export function migrateDefaultPrompt(db: DatabaseSync) {
  const previous =
    'Explain the behaviour before and after the change. Cite the file and lines for each material claim. For a possible defect, describe the triggering conditions and the effect on the caller. If the answer depends on missing evidence, name what you would inspect. Treat the author’s stated intent as a claim to check. Keep routine changes brief.';
  db.prepare(
    "UPDATE agent_preferences SET settings=json_set(settings,'$.prompt',?) WHERE CASE WHEN json_valid(settings) THEN json_extract(settings,'$.prompt') END = ?",
  ).run(defaultPrompt, previous);
  db.exec('PRAGMA user_version=11');
}
// Earlier versions stored a harness and model with every prompt scope. The app default
// becomes the single app-wide choice. Scoped rows keep supplying their prompt.
export function migrateGlobalSelection(db: DatabaseSync) {
  db.exec(`CREATE TABLE agent_selection(id INTEGER PRIMARY KEY CHECK(id=1),agent TEXT NOT NULL,model TEXT NOT NULL,provider TEXT NOT NULL) STRICT;
INSERT INTO agent_selection SELECT 1,json_extract(settings,'$.agent'),
  CASE WHEN json_type(settings,'$.model')='text' THEN json_extract(settings,'$.model') ELSE '' END,
  CASE WHEN json_extract(settings,'$.provider') IN ('ollama','lmstudio') THEN json_extract(settings,'$.provider') ELSE 'default' END
  FROM agent_preferences WHERE scope='default' AND json_valid(settings) AND json_extract(settings,'$.agent') IN ('codex','claude');
PRAGMA user_version=12;`);
}
const scopedPrompt = z.object({ prompt: reviewPrompt });
export function assistantStore(db: DatabaseSync) {
  function repositories() {
    return db
      .prepare('SELECT * FROM repositories ORDER BY name')
      .all()
      .map((row) =>
        repository.parse({
          ...row,
          authors: JSON.parse(String(row.authors)) as unknown,
          watching: JSON.parse(String(row.watching)) as unknown,
          pulls: JSON.parse(String(row.pulls)) as unknown,
        }),
      );
  }
  // `first` is the harness to use until the reviewer picks one.
  function chosen(first: AgentId): Selection {
    const row = db.prepare('SELECT agent,model,provider FROM agent_selection WHERE id=1').get();
    return (
      selection.safeParse(row).data ?? { agent: first, model: '', provider: 'default' as const }
    );
  }
  const key = (url: string, scope: Scope) =>
    scope === 'review' ? url : scope === 'repository' ? repoOf(url) : 'default';
  return {
    repositories,
    add(name: string) {
      db.prepare('INSERT INTO repositories(name) VALUES(?) ON CONFLICT DO NOTHING').run(name);
    },
    remove(name: string) {
      db.prepare('DELETE FROM repositories WHERE name=?').run(name);
    },
    watch(name: string, authors: string[]) {
      db.prepare('UPDATE repositories SET watching=? WHERE name=?').run(
        JSON.stringify([...new Set(authors)]),
        name,
      );
    },
    update(name: string, authors: string[], pulls: Repository['pulls']) {
      db.prepare('UPDATE repositories SET authors=?,pulls=?,checked=?,error=NULL WHERE name=?').run(
        JSON.stringify(authors),
        JSON.stringify(pulls),
        new Date().toISOString(),
        name,
      );
    },
    // Opening a PR clears its new mark. Returns whether anything changed.
    seen(url: string) {
      const name = repoOf(url),
        number = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
      const repo = repositories().find((r) => r.name === name);
      if (!repo?.pulls.some((p) => p.number === number && p.unseen)) return false;
      db.prepare('UPDATE repositories SET pulls=? WHERE name=?').run(
        JSON.stringify(repo.pulls.map((p) => (p.number === number ? { ...p, unseen: false } : p))),
        name,
      );
      return true;
    },
    // New PRs from authors still being watched, across every repository.
    unseen() {
      return repositories().reduce(
        (count, r) =>
          count + r.pulls.filter((p) => p.unseen && r.watching.includes(p.author)).length,
        0,
      );
    },
    failure(name: string, error: string) {
      db.prepare('UPDATE repositories SET error=? WHERE name=?').run(error, name);
    },
    selection: chosen,
    saveSelection(value: Selection) {
      db.prepare('INSERT OR REPLACE INTO agent_selection VALUES(1,?,?,?)').run(
        value.agent,
        value.model,
        value.provider,
      );
    },
    preferences(url: string, first: AgentId) {
      const agent = chosen(first);
      for (const scope of ['review', 'repository', 'default'] as const) {
        const row = db
          .prepare('SELECT settings FROM agent_preferences WHERE scope=?')
          .get(key(url, scope));
        if (row)
          return {
            scope,
            settings: { ...agent, ...scopedPrompt.parse(JSON.parse(String(row.settings))) },
          };
      }
      return { scope: 'default' as const, settings: { ...agent, prompt: defaultPrompt } };
    },
    savePrompt(url: string, scope: Scope, prompt: string) {
      db.prepare('INSERT OR REPLACE INTO agent_preferences VALUES(?,?)').run(
        key(url, scope),
        JSON.stringify({ prompt }),
      );
    },
    clearPrompt(url: string, scope: Scope) {
      db.prepare('DELETE FROM agent_preferences WHERE scope=?').run(key(url, scope));
    },
    executable(agent: AgentId) {
      const value = db.prepare('SELECT path FROM agent_paths WHERE agent=?').get(agent)?.path;
      return typeof value === 'string' ? value : null;
    },
    setExecutable(agent: AgentId, path: string) {
      db.prepare('INSERT OR REPLACE INTO agent_paths VALUES(?,?)').run(agent, path);
    },
    history(url: string) {
      return db
        .prepare('SELECT data FROM conversation WHERE url=? ORDER BY id')
        .all(url)
        .map((row) => turn.parse(JSON.parse(String(row.data))));
    },
    append(url: string, msg: Turn) {
      db.prepare('INSERT INTO conversation(url,run,data) VALUES(?,?,?)').run(
        url,
        msg.run,
        JSON.stringify(msg),
      );
    },
  };
}
export type AssistantStore = ReturnType<typeof assistantStore>;
