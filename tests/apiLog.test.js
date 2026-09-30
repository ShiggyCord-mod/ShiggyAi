import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_DB_PATH = path.join(os.tmpdir(), `shiggyai-apilog-${Date.now()}.sqlite`);
process.env.DB_PATH = TEST_DB_PATH;
process.env.API_LOG_MAX_ROWS = '5';
process.env.MESSAGE_LOG_MAX_ROWS = '4';

const { recordApiCall, getApiCalls, getApiCall, getAllApiCalls, getTokenStats, clearApiLog, assessTokenPlausibility } =
  await import('../src/apiLog.js');
const { recordMessage, setBotReply, getRecentMessages, getAllMessages, clearMessageLog } =
  await import('../src/messageLog.js');

after(() => {
  for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(TEST_DB_PATH + suffix, { force: true });
});

function call(overrides = {}) {
  return {
    kind: 'reply',
    model: 'test-model',
    structuredMode: 'json_schema',
    status: 200,
    ok: true,
    latencyMs: 500,
    request: { model: 'test-model', messages: [{ role: 'system', content: 'sys' }] },
    responseText: '{"choices":[]}',
    content: '{"reply":"hi"}',
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    finishReason: 'stop',
    ...overrides
  };
}

test('recordApiCall haelt Request, Antwort und Tokenzahlen fest', () => {
  clearApiLog();
  recordApiCall(call());

  const { rows, total } = getApiCalls();
  assert.equal(total, 1);
  assert.equal(rows[0].prompt_tokens, 100);
  assert.equal(rows[0].completion_tokens, 20);
  assert.equal(rows[0].total_tokens, 120);

  const full = getApiCall(rows[0].id);
  assert.deepEqual(JSON.parse(full.request_json).messages[0], { role: 'system', content: 'sys' });
  assert.equal(full.content, '{"reply":"hi"}');
});

test('die Listenansicht laesst die grossen Felder weg und nennt nur deren Groesse', () => {
  clearApiLog();
  recordApiCall(call());
  const row = getApiCalls().rows[0];
  assert.equal(row.request_json, undefined, 'Request-Body gehoert nicht in die Liste');
  assert.equal(row.response_text, undefined);
  assert.ok(row.request_bytes > 0, 'stattdessen die Groesse');
});

test('ein Call ohne usage zaehlt bei den Calls mit, bei den Tokens aber nicht', () => {
  clearApiLog();
  recordApiCall(call());
  recordApiCall(call({ ok: false, status: 429, usage: null, error: 'HTTP 429', latencyMs: 40 }));

  const { totals } = getTokenStats();
  assert.equal(totals.calls, 2, 'beide Versuche werden gezaehlt');
  assert.equal(totals.ok_calls, 1);
  assert.equal(totals.calls_with_usage, 1, 'nur einer meldet usage');
  assert.equal(totals.total_tokens, 120, 'der Fehlversuch traegt keine Tokens bei');
});

test('Prompt- und Completion-Tokens summieren sich zur Gesamtzahl', () => {
  clearApiLog();
  recordApiCall(call({ usage: { prompt_tokens: 300, completion_tokens: 50, total_tokens: 350 } }));
  recordApiCall(call({ kind: 'extract', usage: { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230 } }));

  const { totals, byKind } = getTokenStats();
  assert.equal(totals.prompt_tokens + totals.completion_tokens, totals.total_tokens);
  assert.equal(totals.total_tokens, 580);
  assert.deepEqual(byKind.map((r) => [r.kind, r.total_tokens]).sort(), [['extract', 230], ['reply', 350]]);
});

test('das API-Log ist ein Ringpuffer und waechst nicht ueber MAX_ROWS', () => {
  clearApiLog();
  for (let i = 0; i < 12; i++) recordApiCall(call({ latencyMs: i }));

  const { total, rows } = getApiCalls({ limit: 50 });
  assert.equal(total, 5, 'API_LOG_MAX_ROWS=5 im Test');
  assert.equal(rows[0].latency_ms, 11, 'die neuesten bleiben stehen');
  assert.equal(getAllApiCalls().length, 5);
});

test('Filter nach Art und nur-Fehler wirken auf Liste und Gesamtzahl', () => {
  clearApiLog();
  recordApiCall(call({ kind: 'reply' }));
  recordApiCall(call({ kind: 'extract' }));
  recordApiCall(call({ kind: 'reply', ok: false, status: 500, error: 'kaputt' }));

  assert.equal(getApiCalls({ kind: 'reply' }).total, 2);
  assert.equal(getApiCalls({ kind: 'extract' }).total, 1);
  assert.equal(getApiCalls({ onlyErrors: true }).total, 1);
  assert.equal(getApiCalls({ kind: 'extract', onlyErrors: true }).total, 0);
});

test('recordMessage haelt die Nachricht fest und setBotReply traegt die Antwort nach', () => {
  clearMessageLog();
  const id = recordMessage({
    guildId: 'g1', guildName: 'Server', channelName: 'allgemein',
    authorId: 'u1', authorName: 'Alice', content: 'Hallo Bot', addressed: true
  });
  assert.ok(id > 0);
  setBotReply(id, 'Hallo Alice');

  const { rows } = getRecentMessages();
  assert.equal(rows[0].content, 'Hallo Bot');
  assert.equal(rows[0].bot_reply, 'Hallo Alice');
  assert.equal(rows[0].addressed, 1);
});

test('setBotReply ohne ID tut nichts, statt zu werfen', () => {
  assert.doesNotThrow(() => setBotReply(null, 'egal'));
});

test('addressedOnly trennt angesprochene von passiv mitgelesenen Nachrichten', () => {
  clearMessageLog();
  recordMessage({ authorId: 'u1', content: 'an den Bot', addressed: true });
  recordMessage({ authorId: 'u2', content: 'nur mitgelesen', addressed: false });

  assert.equal(getRecentMessages().total, 2);
  assert.equal(getRecentMessages({ addressedOnly: true }).total, 1);
  assert.equal(getRecentMessages({ addressedOnly: true }).rows[0].content, 'an den Bot');
});

test('das Nachrichten-Log ist ebenfalls ein Ringpuffer', () => {
  clearMessageLog();
  for (let i = 0; i < 10; i++) recordMessage({ authorId: 'u', content: `nr ${i}` });
  assert.equal(getRecentMessages({ limit: 50 }).total, 4, 'MESSAGE_LOG_MAX_ROWS=4 im Test');
  assert.equal(getAllMessages()[0].content, 'nr 9');
});

test('recordApiCall haelt die Antwort-Header fest', () => {
  clearApiLog();
  recordApiCall(call({ responseHeaders: { server: 'cloudflare', 'x-request-id': 'abc123', via: '1.1 proxy' } }));

  const row = getApiCall(getApiCalls().rows[0].id);
  const headers = JSON.parse(row.response_headers);
  assert.equal(headers.server, 'cloudflare');
  assert.equal(headers.via, '1.1 proxy');
});

test('assessTokenPlausibility schlaegt an, wenn viel mehr Tokens gemeldet werden als Text da ist', () => {
  // Anlass: 412 gemeldete Completion-Tokens fuer eine Antwort von grob 65 Tokens.
  const check = assessTokenPlausibility({ completion_tokens: 412, content: 'x'.repeat(260), usage_json: null });
  assert.equal(check.reported, 412);
  assert.equal(check.estimate, 65);
  assert.ok(check.ratio >= 6);
  assert.equal(check.suspicious, true);
});

test('assessTokenPlausibility schweigt, wenn der Anbieter Reasoning-Tokens ausweist', () => {
  // Dann ist die Differenz erklaert und kein Hinweis noetig.
  const check = assessTokenPlausibility({
    completion_tokens: 412,
    content: 'x'.repeat(260),
    usage_json: JSON.stringify({ completion_tokens_details: { reasoning_tokens: 350 } })
  });
  assert.equal(check.reasoningTokens, 350);
  assert.equal(check.suspicious, false);
});

test('assessTokenPlausibility schweigt bei plausiblen Zahlen', () => {
  const check = assessTokenPlausibility({ completion_tokens: 70, content: 'x'.repeat(260), usage_json: null });
  assert.equal(check.suspicious, false);
});

test('assessTokenPlausibility gibt null zurueck, wenn die Grundlage fehlt', () => {
  assert.equal(assessTokenPlausibility({ completion_tokens: null, content: 'abc' }), null);
  assert.equal(assessTokenPlausibility({ completion_tokens: 10, content: null }), null);
  assert.equal(assessTokenPlausibility(null), null);
});
