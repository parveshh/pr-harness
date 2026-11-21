import type { DatabaseSync } from 'node:sqlite';
import {
  defaultPrompt,
  prefs,
  repoOf,
  repository,
  turn,
  type Preferences,
  type Scope,
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
    failure(name: string, error: string) {
      db.prepare('UPDATE repositories SET error=? WHERE name=?').run(error, name);
    },
    preferences(url: string, first: AgentId) {
      for (const scope of ['review', 'repository', 'default'] as const) {
        const row = db
          .prepare('SELECT settings FROM agent_preferences WHERE scope=?')
          .get(key(url, scope));
        if (row) return { scope, settings: prefs.parse(JSON.parse(String(row.settings))) };
      }
      return {
        scope: 'default' as const,
        settings: { agent: first, model: '', provider: 'default' as const, prompt: defaultPrompt },
      };
    },
    savePreferences(url: string, scope: Scope, settings: Preferences) {
      db.prepare('INSERT OR REPLACE INTO agent_preferences VALUES(?,?)').run(
        key(url, scope),
        JSON.stringify(settings),
      );
    },
    clearPreferences(url: string, scope: Scope) {
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
