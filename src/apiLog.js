import { db } from './db.js';

// Ringpuffer-Groesse: jeder Eintrag haelt den vollstaendigen Request-Body (inkl. System-Prompt
// und Chatverlauf) und den Response-Envelope, das sind je nach Kontext einige KB. 1000 Zeilen
// sind fuer die Dashboard-Ansicht reichlich und halten die DB in vernuenftiger Groesse.
const MAX_ROWS = parseInt(process.env.API_LOG_MAX_ROWS || '1000', 10);

db.exec(`
  CREATE TABLE IF NOT EXISTS api_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    kind TEXT NOT NULL,
    model TEXT,
    structured_mode TEXT,
    status INTEGER,
    ok INTEGER NOT NULL,
    latency_ms INTEGER,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    total_tokens INTEGER,
    usage_json TEXT,
    request_json TEXT,
    response_text TEXT,
    content TEXT,
    finish_reason TEXT,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_api_calls_kind ON api_calls (kind);
`);

// Nachtraeglich ergaenzt: bei einem Proxy-Endpoint sind die Antwort-Header die einzige Spur,
// aus der sich ablesen laesst, was zwischen dem Bot und dem eigentlichen Modell sitzt.
// ALTER TABLE, weil die Tabelle in bestehenden Installationen schon existiert.
const columns = db.prepare('PRAGMA table_info(api_calls)').all().map((c) => c.name);
if (!columns.includes('response_headers')) {
  db.exec('ALTER TABLE api_calls ADD COLUMN response_headers TEXT');
}

const insertStmt = db.prepare(`
  INSERT INTO api_calls (
    kind, model, structured_mode, status, ok, latency_ms,
    prompt_tokens, completion_tokens, total_tokens, usage_json,
    request_json, response_text, content, finish_reason, error, response_headers
  ) VALUES (
    @kind, @model, @structuredMode, @status, @ok, @latencyMs,
    @promptTokens, @completionTokens, @totalTokens, @usageJson,
    @requestJson, @responseText, @content, @finishReason, @error, @responseHeaders
  )
`);

const countStmt = db.prepare('SELECT COUNT(*) AS count FROM api_calls');
const trimStmt = db.prepare(`
  DELETE FROM api_calls WHERE id IN (SELECT id FROM api_calls ORDER BY id ASC LIMIT ?)
`);

// Listenansicht ohne die grossen Felder - der Verlauf soll auch mit 1000 Eintraegen schnell
// laden, die vollen Bodies holt das Dashboard erst beim Aufklappen eines Eintrags.
const listStmt = db.prepare(`
  SELECT id, created_at, kind, model, structured_mode, status, ok, latency_ms,
         prompt_tokens, completion_tokens, total_tokens, finish_reason, error,
         LENGTH(request_json) AS request_bytes, LENGTH(response_text) AS response_bytes
  FROM api_calls
  WHERE (@kind IS NULL OR kind = @kind)
    AND (@onlyErrors = 0 OR ok = 0)
  ORDER BY id DESC
  LIMIT @limit OFFSET @offset
`);
const filteredCountStmt = db.prepare(`
  SELECT COUNT(*) AS count FROM api_calls
  WHERE (@kind IS NULL OR kind = @kind) AND (@onlyErrors = 0 OR ok = 0)
`);
const getStmt = db.prepare('SELECT * FROM api_calls WHERE id = ?');
const allStmt = db.prepare('SELECT * FROM api_calls ORDER BY id DESC');

/**
 * Schreibt einen HTTP-Versuch an die LLM-API mit. Wird von llm.js ueber setCallRecorder()
 * eingehaengt und bekommt auch fehlgeschlagene Versuche, damit die Token-Abrechnung stimmt.
 */
export function recordApiCall(entry) {
  const usage = entry.usage ?? null;

  insertStmt.run({
    kind: entry.kind ?? 'unknown',
    model: entry.model ?? null,
    structuredMode: entry.structuredMode ?? null,
    status: entry.status ?? null,
    ok: entry.ok ? 1 : 0,
    latencyMs: entry.latencyMs ?? null,
    promptTokens: numberOrNull(usage?.prompt_tokens),
    completionTokens: numberOrNull(usage?.completion_tokens),
    totalTokens: numberOrNull(usage?.total_tokens),
    usageJson: usage ? JSON.stringify(usage) : null,
    requestJson: entry.request ? JSON.stringify(entry.request) : null,
    responseText: entry.responseText ?? null,
    content: entry.content ?? null,
    finishReason: entry.finishReason ?? null,
    error: entry.error ?? null,
    responseHeaders: entry.responseHeaders ? JSON.stringify(entry.responseHeaders) : null
  });

  const { count } = countStmt.get();
  if (count > MAX_ROWS) {
    trimStmt.run(count - MAX_ROWS);
  }
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

export function getApiCalls({ limit = 50, offset = 0, kind = null, onlyErrors = false } = {}) {
  const params = { limit, offset, kind, onlyErrors: onlyErrors ? 1 : 0 };
  return {
    total: filteredCountStmt.get(params).count,
    rows: listStmt.all(params)
  };
}

export function getApiCall(id) {
  return getStmt.get(id) ?? null;
}

/** Vollstaendiger Verlauf fuer den JSON-Export (inkl. Request-Bodies und Antworten). */
export function getAllApiCalls() {
  return allStmt.all();
}

/**
 * Token-Aufschluesselung. Zeilen ohne usage (Fehlversuche, oder Anbieter die kein usage
 * mitliefern) zaehlen bei den Calls mit, bei den Tokens aber als 0 - deshalb wird
 * calls_with_usage separat ausgewiesen, damit im Dashboard klar ist, worauf sich die
 * Summen beziehen.
 */
export function getTokenStats() {
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS calls,
              SUM(ok) AS ok_calls,
              SUM(CASE WHEN total_tokens IS NOT NULL THEN 1 ELSE 0 END) AS calls_with_usage,
              COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
              COALESCE(SUM(total_tokens), 0) AS total_tokens,
              CAST(AVG(latency_ms) AS INTEGER) AS avg_latency_ms
       FROM api_calls`
    )
    .get();

  const byKind = db
    .prepare(
      `SELECT kind, COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
              COALESCE(SUM(total_tokens), 0) AS total_tokens
       FROM api_calls GROUP BY kind ORDER BY total_tokens DESC`
    )
    .all();

  const byModel = db
    .prepare(
      `SELECT model, COUNT(*) AS calls,
              COALESCE(SUM(total_tokens), 0) AS total_tokens
       FROM api_calls GROUP BY model ORDER BY total_tokens DESC`
    )
    .all();

  const byDay = db
    .prepare(
      `SELECT DATE(created_at) AS day, COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
              COALESCE(SUM(total_tokens), 0) AS total_tokens
       FROM api_calls GROUP BY day ORDER BY day DESC LIMIT 30`
    )
    .all();

  return { totals, byKind, byModel, byDay };
}

export function clearApiLog() {
  return db.prepare('DELETE FROM api_calls').run().changes;
}

/**
 * Grobe Plausibilitaetspruefung der gemeldeten Completion-Tokens gegen die Laenge der Antwort.
 *
 * Anlass: ein Call meldete 412 completion_tokens fuer eine Antwort von grob 65 Tokens. Dafuer
 * gibt es zwei Erklaerungen - verstecktes Reasoning, das nicht mitgeliefert wird, oder eine
 * Zaehlung, die nicht stimmt. Beides will man wissen, wenn man nach Tokens bezahlt. Die
 * Schaetzung ist absichtlich grob (rund 4 Zeichen pro Token) und taugt nur dazu, eine
 * Groessenordnung auseinanderzuhalten, nicht zum Nachrechnen auf den Token.
 */
export function assessTokenPlausibility(row) {
  const reported = row?.completion_tokens;
  if (!Number.isFinite(reported) || !row?.content) return null;

  const estimate = Math.max(1, Math.round(row.content.length / 4));
  const ratio = reported / estimate;
  const usage = safeParse(row.usage_json);
  const reasoning =
    usage?.completion_tokens_details?.reasoning_tokens ??
    usage?.output_tokens_details?.reasoning_tokens ??
    null;

  return {
    reported,
    estimate,
    ratio: Number(ratio.toFixed(2)),
    reasoningTokens: reasoning,
    // Ab Faktor 2 lohnt das Hinsehen; ein mitgeliefertes reasoning_tokens erklaert es bereits.
    suspicious: ratio >= 2 && !reasoning
  };
}

function safeParse(text) {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
