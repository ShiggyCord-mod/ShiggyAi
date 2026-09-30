import { db } from './db.js';

// Wie beim API-Log ein Ringpuffer: der Verlauf ist eine Ansicht der letzten Aktivitaet,
// kein Archiv. Discord selbst bleibt die Quelle der Wahrheit fuer den Chatverlauf.
const MAX_ROWS = parseInt(process.env.MESSAGE_LOG_MAX_ROWS || '500', 10);

db.exec(`
  CREATE TABLE IF NOT EXISTS recent_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    guild_id TEXT,
    guild_name TEXT,
    channel_id TEXT,
    channel_name TEXT,
    author_id TEXT,
    author_name TEXT,
    content TEXT,
    source TEXT NOT NULL,
    addressed INTEGER NOT NULL DEFAULT 0,
    bot_reply TEXT
  );
`);

const insertStmt = db.prepare(`
  INSERT INTO recent_messages (
    guild_id, guild_name, channel_id, channel_name,
    author_id, author_name, content, source, addressed, bot_reply
  ) VALUES (
    @guildId, @guildName, @channelId, @channelName,
    @authorId, @authorName, @content, @source, @addressed, @botReply
  )
`);
const countStmt = db.prepare('SELECT COUNT(*) AS count FROM recent_messages');
const trimStmt = db.prepare(`
  DELETE FROM recent_messages WHERE id IN (SELECT id FROM recent_messages ORDER BY id ASC LIMIT ?)
`);
const listStmt = db.prepare(`
  SELECT * FROM recent_messages
  WHERE (@addressedOnly = 0 OR addressed = 1)
    AND (@guildId IS NULL OR guild_id = @guildId)
  ORDER BY id DESC LIMIT @limit OFFSET @offset
`);
const filteredCountStmt = db.prepare(`
  SELECT COUNT(*) AS count FROM recent_messages
  WHERE (@addressedOnly = 0 OR addressed = 1) AND (@guildId IS NULL OR guild_id = @guildId)
`);
const allStmt = db.prepare('SELECT * FROM recent_messages ORDER BY id DESC');

/**
 * Haelt eine gesehene Nachricht fuer die Dashboard-Ansicht fest. `addressed` unterscheidet,
 * ob der Bot angesprochen wurde (Mention/Reply//ask) oder nur passiv mitgelesen hat.
 */
export function recordMessage({
  guildId = null,
  guildName = null,
  channelId = null,
  channelName = null,
  authorId = null,
  authorName = null,
  content = '',
  source = 'message',
  addressed = false,
  botReply = null
}) {
  const info = insertStmt.run({
    guildId,
    guildName,
    channelId,
    channelName,
    authorId,
    authorName,
    content,
    source,
    addressed: addressed ? 1 : 0,
    botReply
  });

  const { count } = countStmt.get();
  if (count > MAX_ROWS) {
    trimStmt.run(count - MAX_ROWS);
  }

  return Number(info.lastInsertRowid);
}

const setReplyStmt = db.prepare('UPDATE recent_messages SET bot_reply = ? WHERE id = ?');

/**
 * Traegt die Antwort des Bots nach. Die Nachricht wird schon beim Eingang festgehalten, damit
 * sie auch im Log steht, wenn der API-Call danach scheitert - der Fehler landet dann hier.
 */
export function setBotReply(id, text) {
  if (!id) return;
  setReplyStmt.run(text ?? null, id);
}

export function getRecentMessages({ limit = 50, offset = 0, addressedOnly = false, guildId = null } = {}) {
  const params = { limit, offset, addressedOnly: addressedOnly ? 1 : 0, guildId };
  return {
    total: filteredCountStmt.get(params).count,
    rows: listStmt.all(params)
  };
}

export function getAllMessages() {
  return allStmt.all();
}

export function clearMessageLog() {
  return db.prepare('DELETE FROM recent_messages').run().changes;
}
