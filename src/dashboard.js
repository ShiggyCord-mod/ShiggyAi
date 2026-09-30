import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  searchMemories,
  getAllMemories,
  getMemoryById,
  deleteMemoryById,
  getMemoryOwners,
  getMemoryStats,
  addUserMemory,
  addGuildMemory
} from './db.js';
import { getApiCalls, getApiCall, getAllApiCalls, getTokenStats, clearApiLog, assessTokenPlausibility } from './apiLog.js';
import { getRecentMessages, getAllMessages, clearMessageLog } from './messageLog.js';

const PORT = parseInt(process.env.DASHBOARD_PORT || '1267', 10);

// Standardmaessig NUR lokal erreichbar. Das Dashboard hat bewusst keine Authentifizierung und
// zeigt komplette Chatverlaeufe, Prompts und persoenliche Fakten ueber Dritte - das gehoert
// nicht ungefragt ins Netz. Wer es von aussen braucht, setzt DASHBOARD_HOST=0.0.0.0 bewusst
// und stellt selbst etwas davor (Reverse Proxy mit Auth, SSH-Tunnel, VPN).
const HOST = process.env.DASHBOARD_HOST || '127.0.0.1';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MAX_BODY_BYTES = 64 * 1024;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

/**
 * Startet das Dashboard.
 * @param {{client: import('discord.js').Client, runtime: () => object}} args
 *   runtime() liefert die Live-Werte, die nur index.js kennt (Rate-Limiter-Rest, Lernpuffer,
 *   Structured-Output-Modus) - so bleibt dieses Modul frei von den Interna des Bots.
 */
export function startDashboard({ client, runtime }) {
  const startedAt = Date.now();

  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res, { client, runtime, startedAt });
    } catch (err) {
      console.error('Dashboard-Fehler:', err);
      sendJson(res, 500, { error: 'internal_error', message: String(err?.message ?? err) });
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Dashboard-Port ${PORT} ist belegt - Dashboard startet nicht (der Bot laeuft weiter).`);
      return;
    }
    console.error('Dashboard-Server-Fehler:', err);
  });

  server.listen(PORT, HOST, () => {
    console.log(`Dashboard laeuft auf http://${HOST}:${PORT}`);
    if (HOST === '0.0.0.0') {
      console.warn(
        'WARNUNG: DASHBOARD_HOST=0.0.0.0 - das Dashboard ist ohne Passwort aus dem Netz erreichbar ' +
          'und zeigt Chatverlaeufe, Prompts und persoenliche Daten.'
      );
    }
  });

  return server;
}

async function route(req, res, ctx) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;
  const q = url.searchParams;

  // ---- API ----
  if (pathname === '/api/overview') return sendJson(res, 200, buildOverview(ctx));

  if (pathname === '/api/memories' && req.method === 'GET') {
    return sendJson(res, 200, searchMemories({
      scope: q.get('scope') || null,
      ownerId: q.get('ownerId') || null,
      q: q.get('q') || null,
      limit: intParam(q.get('limit'), 50, 500),
      offset: intParam(q.get('offset'), 0, Number.MAX_SAFE_INTEGER)
    }));
  }

  if (pathname === '/api/memories' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const content = String(body?.content ?? '').trim();
    const ownerId = String(body?.ownerId ?? '').trim();
    const scope = body?.scope === 'guild' ? 'guild' : 'user';
    if (!content || !ownerId) {
      return sendJson(res, 400, { error: 'bad_request', message: 'ownerId und content sind erforderlich.' });
    }
    if (scope === 'guild') addGuildMemory(ownerId, content);
    else addUserMemory(ownerId, content);
    return sendJson(res, 201, { ok: true, scope, ownerId });
  }

  if (pathname === '/api/memories/owners') return sendJson(res, 200, getMemoryOwners());
  if (pathname === '/api/memories/stats') return sendJson(res, 200, getMemoryStats());

  const memoryIdMatch = pathname.match(/^\/api\/memories\/(\d+)$/);
  if (memoryIdMatch) {
    const id = parseInt(memoryIdMatch[1], 10);
    if (req.method === 'DELETE') {
      const existing = getMemoryById(id);
      if (!existing) return sendJson(res, 404, { error: 'not_found' });
      deleteMemoryById(id);
      return sendJson(res, 200, { ok: true, deleted: existing });
    }
    if (req.method === 'GET') {
      const row = getMemoryById(id);
      return row ? sendJson(res, 200, row) : sendJson(res, 404, { error: 'not_found' });
    }
  }

  if (pathname === '/api/messages' && req.method === 'GET') {
    return sendJson(res, 200, getRecentMessages({
      limit: intParam(q.get('limit'), 50, 500),
      offset: intParam(q.get('offset'), 0, Number.MAX_SAFE_INTEGER),
      addressedOnly: q.get('addressedOnly') === '1',
      guildId: q.get('guildId') || null
    }));
  }

  if (pathname === '/api/calls' && req.method === 'GET') {
    return sendJson(res, 200, getApiCalls({
      limit: intParam(q.get('limit'), 50, 500),
      offset: intParam(q.get('offset'), 0, Number.MAX_SAFE_INTEGER),
      kind: q.get('kind') || null,
      onlyErrors: q.get('onlyErrors') === '1'
    }));
  }

  const callIdMatch = pathname.match(/^\/api\/calls\/(\d+)$/);
  if (callIdMatch) {
    const row = getApiCall(parseInt(callIdMatch[1], 10));
    if (!row) return sendJson(res, 404, { error: 'not_found' });
    // Request und Response werden geparst zurueckgegeben, damit das Frontend sie direkt
    // aufklappbar darstellen kann statt Strings in Strings zu zeigen.
    return sendJson(res, 200, {
      ...row,
      request: tryParse(row.request_json),
      response: tryParse(row.response_text),
      usage: tryParse(row.usage_json),
      headers: tryParse(row.response_headers),
      tokenCheck: assessTokenPlausibility(row)
    });
  }

  if (pathname === '/api/tokens') return sendJson(res, 200, getTokenStats());

  // ---- Wartung: Logs leeren ----
  if (pathname === '/api/calls' && req.method === 'DELETE') {
    return sendJson(res, 200, { ok: true, deleted: clearApiLog() });
  }
  if (pathname === '/api/messages' && req.method === 'DELETE') {
    return sendJson(res, 200, { ok: true, deleted: clearMessageLog() });
  }

  // ---- Export ----
  if (pathname === '/api/export/memories') return sendDownload(res, 'memories', buildMemoryExport());
  if (pathname === '/api/export/calls') return sendDownload(res, 'api-calls', buildCallExport());
  if (pathname === '/api/export/all') {
    return sendDownload(res, 'dashboard-export', {
      exported_at: new Date().toISOString(),
      memories: buildMemoryExport(),
      api_calls: buildCallExport(),
      messages: getAllMessages()
    });
  }

  if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not_found' });

  // ---- Statische Dateien ----
  return sendStatic(res, pathname === '/' ? '/index.html' : pathname);
}

function buildOverview({ client, runtime, startedAt }) {
  const live = safeRuntime(runtime);

  const guilds = [...(client?.guilds?.cache?.values?.() ?? [])].map((g) => ({
    id: g.id,
    name: g.name,
    memberCount: g.memberCount ?? null,
    channels: g.channels?.cache?.size ?? null
  }));

  return {
    bot: {
      tag: client?.user?.tag ?? null,
      id: client?.user?.id ?? null,
      ready: Boolean(client?.isReady?.()),
      wsPing: Number.isFinite(client?.ws?.ping) ? Math.round(client.ws.ping) : null,
      uptimeMs: client?.uptime ?? null,
      dashboardUptimeMs: Date.now() - startedAt,
      guildCount: guilds.length,
      guilds
    },
    // Nie den Key selbst, nur ob er da ist und wie er anfaengt - das Dashboard hat keine Auth.
    api: {
      baseUrl: process.env.LLM_BASE_URL || 'https://codecraftapi.com/v1',
      model: process.env.LLM_MODEL || null,
      keyConfigured: Boolean(process.env.LLM_API_KEY),
      keyPreview: maskKey(process.env.LLM_API_KEY),
      reasoningEffort: process.env.LLM_REASONING_EFFORT || null,
      structuredOutputMode: live.structuredOutputMode ?? null
    },
    limits: {
      rateLimitRpm: intParam(process.env.RATE_LIMIT_RPM, 10, 10_000),
      rateLimitRemaining: live.rateLimitRemaining ?? null,
      shortTermContextLimit: intParam(process.env.SHORT_TERM_CONTEXT_LIMIT, 15, 1000)
    },
    learning: {
      enabled: live.learningEnabled ?? null,
      batchSize: intParam(process.env.LEARNING_BATCH_SIZE, 20, 10_000),
      sweepIntervalMinutes: intParam(process.env.LEARNING_SWEEP_INTERVAL_MINUTES, 10, 10_000),
      bufferedChannels: live.bufferedChannels ?? null,
      bufferedMessages: live.bufferedMessages ?? null
    },
    memories: getMemoryStats(),
    tokens: getTokenStats(),
    persona: process.env.BOT_PERSONA || null
  };
}

function safeRuntime(runtime) {
  try {
    return runtime?.() ?? {};
  } catch (err) {
    console.error('Konnte die Live-Werte nicht lesen:', err);
    return {};
  }
}

function buildMemoryExport() {
  return {
    exported_at: new Date().toISOString(),
    stats: getMemoryStats(),
    owners: getMemoryOwners(),
    memories: getAllMemories()
  };
}

/**
 * Verlauf-Export: jeder Eintrag traegt Request UND Response als geparste Objekte plus die
 * Token-Zahlen - genau das, was man zum Nachrechnen des Verbrauchs braucht.
 */
function buildCallExport() {
  return {
    exported_at: new Date().toISOString(),
    token_stats: getTokenStats(),
    calls: getAllApiCalls().map((row) => ({
      id: row.id,
      created_at: row.created_at,
      kind: row.kind,
      model: row.model,
      structured_mode: row.structured_mode,
      status: row.status,
      ok: Boolean(row.ok),
      latency_ms: row.latency_ms,
      finish_reason: row.finish_reason,
      error: row.error,
      usage: tryParse(row.usage_json),
      tokens: {
        prompt: row.prompt_tokens,
        completion: row.completion_tokens,
        total: row.total_tokens
      },
      token_check: assessTokenPlausibility(row),
      response_headers: tryParse(row.response_headers),
      request: tryParse(row.request_json),
      response: tryParse(row.response_text),
      content: row.content
    }))
  };
}

function maskKey(key) {
  if (!key) return null;
  if (key.length <= 8) return '***';
  return `${key.slice(0, 5)}...${key.slice(-3)}`;
}

function tryParse(text) {
  if (typeof text !== 'string') return text ?? null;
  try {
    return JSON.parse(text);
  } catch {
    return text; // Fehlertexte der API sind nicht immer JSON
  }
}

function intParam(value, fallback, max) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request-Body zu gross'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(new Error('Body ist kein valides JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendDownload(res, name, payload) {
  const body = JSON.stringify(payload, null, 2);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="${name}-${stamp}.json"`,
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendStatic(res, requestPath) {
  // Nur Dateien unterhalb von public/ ausliefern - resolve() plus Prefix-Pruefung schliesst
  // ../-Tricks aus, auch wenn sie url-kodiert reinkommen.
  const target = path.resolve(PUBLIC_DIR, '.' + decodeURIComponent(requestPath));
  if (!target.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(target, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(target)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}
