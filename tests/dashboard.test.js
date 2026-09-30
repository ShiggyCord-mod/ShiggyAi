import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

const TEST_DB_PATH = path.join(os.tmpdir(), `shiggyai-dash-${Date.now()}.sqlite`);
process.env.DB_PATH = TEST_DB_PATH;
process.env.DASHBOARD_PORT = '0'; // freien Port vom OS waehlen lassen
process.env.LLM_API_KEY = 'cc_dieser_key_darf_nie_raus';
process.env.LLM_MODEL = 'test-model';
process.env.BOT_PERSONA = 'Testpersona';

const { startDashboard } = await import('../src/dashboard.js');
const { recordApiCall } = await import('../src/apiLog.js');
const { recordMessage } = await import('../src/messageLog.js');
const { addUserMemory, addGuildMemory } = await import('../src/db.js');

const fakeClient = {
  user: { tag: 'Test#0001', id: 'bot-1' },
  isReady: () => true,
  uptime: 60_000,
  ws: { ping: 12 },
  guilds: { cache: new Map([['g1', { id: 'g1', name: 'Testserver', memberCount: 5, channels: { cache: { size: 3 } } }]]) }
};

let server;
let base;

before(async () => {
  addUserMemory('u1', 'mag Kaffee');
  addGuildMemory('g1', 'Server dreht sich um Tests');
  recordApiCall({
    kind: 'reply', model: 'test-model', structuredMode: 'json_schema', status: 200, ok: true,
    latencyMs: 100, request: { model: 'test-model', messages: [{ role: 'system', content: 'sys' }] },
    responseText: '{"ok":true}', content: '{"reply":"x"}',
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
  });
  recordMessage({ guildId: 'g1', authorId: 'u1', authorName: 'Alice', content: 'hi', addressed: true });

  server = startDashboard({ client: fakeClient, runtime: () => ({ rateLimitRemaining: 3, learningEnabled: true, bufferedChannels: 1, bufferedMessages: 2, structuredOutputMode: 'json_schema' }) });
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(TEST_DB_PATH + suffix, { force: true });
});

const get = (p) => fetch(base + p);
const getJson = async (p) => {
  const res = await get(p);
  return { status: res.status, body: await res.json() };
};

test('das Dashboard bindet standardmaessig nur auf localhost', () => {
  // Ohne Auth darf es nicht ungefragt im Netz haengen - der Default ist 127.0.0.1.
  assert.equal(server.address().address, '127.0.0.1');
});

test('/api/overview maskiert den API-Key und gibt ihn nie im Klartext heraus', async () => {
  const res = await get('/api/overview');
  const text = await res.text();
  assert.ok(!text.includes('cc_dieser_key_darf_nie_raus'), 'der Key steht in der Antwort!');

  const d = JSON.parse(text);
  assert.equal(d.api.keyConfigured, true);
  assert.match(d.api.keyPreview, /^cc_di\.\.\./);
  assert.equal(d.api.model, 'test-model');
  assert.equal(d.bot.tag, 'Test#0001');
  assert.equal(d.limits.rateLimitRemaining, 3, 'die Live-Werte kommen aus runtime()');
});

test('/api/overview uebersteht einen werfenden runtime()-Callback', async () => {
  const brokenServer = startDashboard({
    client: fakeClient,
    runtime: () => { throw new Error('kaputt'); }
  });
  await once(brokenServer, 'listening');
  try {
    const res = await fetch(`http://127.0.0.1:${brokenServer.address().port}/api/overview`);
    assert.equal(res.status, 200, 'die Uebersicht muss trotzdem laden');
    const d = await res.json();
    assert.equal(d.limits.rateLimitRemaining, null, 'die Live-Werte fehlen dann eben');
    assert.equal(d.bot.tag, 'Test#0001', 'der Rest ist weiterhin da');
  } finally {
    brokenServer.close();
  }
});

test('Erinnerungen lassen sich filtern und durchsuchen', async () => {
  assert.equal((await getJson('/api/memories')).body.total, 2);
  assert.equal((await getJson('/api/memories?scope=guild')).body.total, 1);
  assert.equal((await getJson('/api/memories?q=Kaffee')).body.total, 1);
  assert.equal((await getJson('/api/memories?ownerId=u1')).body.total, 1);
  assert.equal((await getJson('/api/memories?q=gibtsnicht')).body.total, 0);
});

test('POST /api/memories legt an und weist unvollstaendige Angaben ab', async () => {
  const ok = await fetch(base + '/api/memories', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: 'user', ownerId: 'u2', content: 'per Dashboard' })
  });
  assert.equal(ok.status, 201);

  const bad = await fetch(base + '/api/memories', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: 'user', ownerId: 'u2', content: '   ' })
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'bad_request');
});

test('DELETE /api/memories/:id meldet den geloeschten Eintrag und 404 fuer unbekannte IDs', async () => {
  const { body: list } = await getJson('/api/memories?ownerId=u2');
  const id = list.rows[0].id;

  const res = await fetch(`${base}/api/memories/${id}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).deleted.content, 'per Dashboard');

  const again = await fetch(`${base}/api/memories/${id}`, { method: 'DELETE' });
  assert.equal(again.status, 404);
});

test('/api/calls/:id liefert Request und Antwort geparst statt als String im String', async () => {
  const { body: list } = await getJson('/api/calls');
  const { body: detail } = await getJson(`/api/calls/${list.rows[0].id}`);
  assert.equal(typeof detail.request, 'object');
  assert.equal(detail.request.messages[0].content, 'sys');
  assert.deepEqual(detail.usage, { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
});

test('die Exporte setzen einen Download-Header und tragen Request UND Antwort', async () => {
  for (const [route, key] of [['memories', 'memories'], ['calls', 'calls'], ['all', 'api_calls']]) {
    const res = await get(`/api/export/${route}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /attachment; filename=".*\.json"/);
    const body = await res.json();
    assert.ok(key in body, `${key} fehlt im Export von ${route}`);
  }

  const { calls } = await (await get('/api/export/calls')).json();
  assert.ok(calls[0].request && calls[0].response, 'ein Verlaufseintrag braucht beides');
  assert.deepEqual(calls[0].tokens, { prompt: 10, completion: 2, total: 12 });
});

test('kein Export enthaelt den API-Key', async () => {
  for (const route of ['memories', 'calls', 'all']) {
    const text = await (await get(`/api/export/${route}`)).text();
    assert.ok(!text.includes('cc_dieser_key_darf_nie_raus'), `Key im Export von ${route}!`);
  }
});

test('DELETE auf die Log-Routen loescht, statt die Liste zu liefern', async () => {
  // Regression: die GET-Handler pruefen die Methode, sonst faengt GET das DELETE ab.
  const res = await fetch(base + '/api/messages', { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  assert.equal((await getJson('/api/messages')).body.total, 0);
});

test('Pfad-Traversal wird abgewiesen', async () => {
  for (const p of ['/..%2f..%2f.env', '/%2e%2e%2fsrc%2fllm.js', '/..%2fpackage.json']) {
    const res = await get(p);
    assert.ok(res.status === 403 || res.status === 404, `${p} gab ${res.status}`);
    const text = await res.text();
    assert.ok(!text.includes('DISCORD_TOKEN') && !text.includes('"dependencies"'), `${p} hat Inhalt geleakt`);
  }
});

test('unbekannte API-Routen geben 404 als JSON', async () => {
  const { status, body } = await getJson('/api/gibtsnicht');
  assert.equal(status, 404);
  assert.equal(body.error, 'not_found');
});

test('die statischen Dateien werden mit passendem Content-Type ausgeliefert', async () => {
  for (const [p, type] of [['/', 'text/html'], ['/app.css', 'text/css'], ['/app.js', 'text/javascript'], ['/chart.js', 'text/javascript']]) {
    const res = await get(p);
    assert.equal(res.status, 200, `${p} gab ${res.status}`);
    assert.match(res.headers.get('content-type'), new RegExp(type));
  }
});
