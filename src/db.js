import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = process.env.DB_PATH || './data/memory.sqlite';

// Ordner fuer die DB-Datei anlegen, falls er noch nicht existiert
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Zwei Arten von Erinnerungen in einer Tabelle, unterschieden per "scope":
// - 'user'  Fakten ueber einen einzelnen Discord-User, serveruebergreifend (DM, jeder Server gleich)
// - 'guild' Fakten ueber einen Server, gemeinsam fuer alle dortigen User, aber nicht serveruebergreifend
const hasScopeColumn = db
  .prepare("PRAGMA table_info(memories)")
  .all()
  .some((col) => col.name === 'scope');

if (!hasScopeColumn) {
  const oldTableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories'")
    .get();

  if (oldTableExists) {
    // Alte Tabelle war (guild_id, user_id) - war inhaltlich immer eine User-Erinnerung,
    // nur faelschlich pro Guild dupliziert. Wird 1:1 in den neuen User-Scope migriert.
    db.exec('ALTER TABLE memories RENAME TO memories_old_guild_scoped');
  }

  db.exec(`
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL CHECK (scope IN ('user', 'guild')),
      user_id TEXT,
      guild_id TEXT,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  if (oldTableExists) {
    db.exec(`
      INSERT INTO memories (scope, user_id, guild_id, content, created_at)
      SELECT 'user', user_id, NULL, content, created_at FROM memories_old_guild_scoped;
    `);
    db.exec('DROP TABLE memories_old_guild_scoped');
  }
} else {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL CHECK (scope IN ('user', 'guild')),
      user_id TEXT,
      guild_id TEXT,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

// Die Dashboard-Ansichten filtern und gruppieren nach scope + Besitzer, nicht nur punktuell
// nach einer ID - deshalb hier Indizes statt Table-Scans.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_memories_user ON memories (scope, user_id);
  CREATE INDEX IF NOT EXISTS idx_memories_guild ON memories (scope, guild_id);
`);

const insertUserStmt = db.prepare("INSERT INTO memories (scope, user_id, content) VALUES ('user', ?, ?)");
const insertGuildStmt = db.prepare("INSERT INTO memories (scope, guild_id, content) VALUES ('guild', ?, ?)");
const listUserStmt = db.prepare(
  "SELECT id, content, created_at FROM memories WHERE scope = 'user' AND user_id = ? ORDER BY id DESC LIMIT ?"
);
const listGuildStmt = db.prepare(
  "SELECT id, content, created_at FROM memories WHERE scope = 'guild' AND guild_id = ? ORDER BY id DESC LIMIT ?"
);
const deleteUserStmt = db.prepare("DELETE FROM memories WHERE id = ? AND scope = 'user' AND user_id = ?");
const deleteUserAdminStmt = db.prepare("DELETE FROM memories WHERE id = ? AND scope = 'user'");
const deleteGuildStmt = db.prepare("DELETE FROM memories WHERE id = ? AND scope = 'guild' AND guild_id = ?");
const clearUserStmt = db.prepare("DELETE FROM memories WHERE scope = 'user' AND user_id = ?");
const countUserStmt = db.prepare("SELECT COUNT(*) as count FROM memories WHERE scope = 'user' AND user_id = ?");
const countGuildStmt = db.prepare("SELECT COUNT(*) as count FROM memories WHERE scope = 'guild' AND guild_id = ?");
const trimOldestUserStmt = db.prepare(`
  DELETE FROM memories WHERE id IN (
    SELECT id FROM memories WHERE scope = 'user' AND user_id = ? ORDER BY id ASC LIMIT ?
  )
`);
const trimOldestGuildStmt = db.prepare(`
  DELETE FROM memories WHERE id IN (
    SELECT id FROM memories WHERE scope = 'guild' AND guild_id = ? ORDER BY id ASC LIMIT ?
  )
`);

// Deckel pro User bzw. pro Guild, damit die DB nicht unbegrenzt waechst
const MAX_MEMORIES_PER_SCOPE = 50;

/**
 * Fakt ueber einen Discord-User - gilt serveruebergreifend (DM, jeder Server gleich).
 */
export function addUserMemory(userId, content) {
  const trimmed = content.trim();
  if (!trimmed) return;

  insertUserStmt.run(userId, trimmed);

  const { count } = countUserStmt.get(userId);
  if (count > MAX_MEMORIES_PER_SCOPE) {
    trimOldestUserStmt.run(userId, count - MAX_MEMORIES_PER_SCOPE);
  }
}

/**
 * Fakt ueber einen Server - gilt fuer alle dortigen User, aber nicht serveruebergreifend.
 */
export function addGuildMemory(guildId, content) {
  const trimmed = content.trim();
  if (!trimmed) return;

  insertGuildStmt.run(guildId, trimmed);

  const { count } = countGuildStmt.get(guildId);
  if (count > MAX_MEMORIES_PER_SCOPE) {
    trimOldestGuildStmt.run(guildId, count - MAX_MEMORIES_PER_SCOPE);
  }
}

export function getUserMemories(userId, limit = 20) {
  return listUserStmt.all(userId, limit);
}

export function getGuildMemories(guildId, limit = 100) {
  return listGuildStmt.all(guildId, limit);
}

/** Self-Service Loeschen (/memory forget) - nur die eigenen User-Memories. */
export function deleteUserMemory(id, userId) {
  const result = deleteUserStmt.run(id, userId);
  return result.changes > 0;
}

/** Admin-Loeschen (/memory admin forget-user) - serveruebergreifend per ID. */
export function deleteUserMemoryAdmin(id) {
  const result = deleteUserAdminStmt.run(id);
  return result.changes > 0;
}

/** Admin-Loeschen (/memory admin forget-server) - auf den aktuellen Server begrenzt. */
export function deleteGuildMemory(id, guildId) {
  const result = deleteGuildStmt.run(id, guildId);
  return result.changes > 0;
}

export function clearUserMemories(userId) {
  const result = clearUserStmt.run(userId);
  return result.changes;
}

// ---- Ansichten fuer das Dashboard ----
// Bewusst scope-uebergreifend und mit Besitzer-Spalten: der Erinnerungsmanager zeigt User- und
// Server-Erinnerungen in einer Liste, die Slash-Commands oben bleiben absichtlich pro Scope.

const searchStmt = db.prepare(`
  SELECT id, scope, user_id, guild_id, content, created_at, LENGTH(content) AS length
  FROM memories
  WHERE (@scope IS NULL OR scope = @scope)
    AND (@ownerId IS NULL OR user_id = @ownerId OR guild_id = @ownerId)
    AND (@q IS NULL OR content LIKE '%' || @q || '%')
  ORDER BY id DESC
  LIMIT @limit OFFSET @offset
`);

const searchCountStmt = db.prepare(`
  SELECT COUNT(*) AS count FROM memories
  WHERE (@scope IS NULL OR scope = @scope)
    AND (@ownerId IS NULL OR user_id = @ownerId OR guild_id = @ownerId)
    AND (@q IS NULL OR content LIKE '%' || @q || '%')
`);

/** Gefilterte, blaetterbare Liste ueber beide Scopes. */
export function searchMemories({ scope = null, ownerId = null, q = null, limit = 50, offset = 0 } = {}) {
  const params = { scope, ownerId, q: q || null, limit, offset };
  return {
    total: searchCountStmt.get(params).count,
    rows: searchStmt.all(params)
  };
}

/** Alle Erinnerungen fuer den JSON-Export. */
export function getAllMemories() {
  return db
    .prepare('SELECT id, scope, user_id, guild_id, content, created_at FROM memories ORDER BY id DESC')
    .all();
}

export function getMemoryById(id) {
  return db.prepare('SELECT id, scope, user_id, guild_id, content, created_at FROM memories WHERE id = ?').get(id) ?? null;
}

/** Loeschen per ID ohne Scope-Angabe - fuer den Manager, der beide Arten in einer Liste zeigt. */
export function deleteMemoryById(id) {
  return db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0;
}

/**
 * Wer hat wieviele Erinnerungen. Zwei Listen, weil ein Eintrag entweder an einer User-ID
 * oder an einer Guild-ID haengt, nie an beiden.
 */
export function getMemoryOwners() {
  const users = db
    .prepare(
      `SELECT user_id AS id, COUNT(*) AS count, MAX(created_at) AS last_at
       FROM memories WHERE scope = 'user' AND user_id IS NOT NULL
       GROUP BY user_id ORDER BY count DESC`
    )
    .all();

  const guilds = db
    .prepare(
      `SELECT guild_id AS id, COUNT(*) AS count, MAX(created_at) AS last_at
       FROM memories WHERE scope = 'guild' AND guild_id IS NOT NULL
       GROUP BY guild_id ORDER BY count DESC`
    )
    .all();

  return { users, guilds };
}

export function getMemoryStats() {
  const byScope = db.prepare('SELECT scope, COUNT(*) AS count FROM memories GROUP BY scope').all();
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COUNT(DISTINCT CASE WHEN scope = 'user' THEN user_id END) AS distinct_users,
              COUNT(DISTINCT CASE WHEN scope = 'guild' THEN guild_id END) AS distinct_guilds,
              MAX(LENGTH(content)) AS longest,
              CAST(AVG(LENGTH(content)) AS INTEGER) AS avg_length,
              MAX(created_at) AS newest_at
       FROM memories`
    )
    .get();

  // Der Deckel gilt pro Scope-Besitzer; wer ihn erreicht hat, verliert bei jedem neuen Fakt
  // den aeltesten - im Dashboard sichtbar zu machen ist der halbe Sinn der Uebung.
  const atCap = db
    .prepare(
      `SELECT owner, scope, count FROM (
         SELECT user_id AS owner, 'user' AS scope, COUNT(*) AS count FROM memories
           WHERE scope = 'user' GROUP BY user_id
         UNION ALL
         SELECT guild_id AS owner, 'guild' AS scope, COUNT(*) AS count FROM memories
           WHERE scope = 'guild' GROUP BY guild_id
       ) WHERE count >= ? ORDER BY count DESC`
    )
    .all(MAX_MEMORIES_PER_SCOPE);

  return { totals, byScope, atCap, cap: MAX_MEMORIES_PER_SCOPE };
}
