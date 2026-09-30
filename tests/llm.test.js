import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLM_API_KEY = 'test-key';
process.env.LLM_MODEL = 'test-model';

const {
  askLlm,
  extractMemories,
  LlmRateLimitError,
  LlmBillingError,
  GENERIC_FALLBACK_REPLY,
  MAX_MEMORY_ITEMS,
  MAX_MEMORY_LENGTH,
  resetStructuredOutputMode,
  getStructuredOutputMode,
  setCallRecorder,
  LlmUnavailableError
} = await import('../src/llm.js');

function mockFetchOnce(response) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return response;
  };
  const restore = () => {
    globalThis.fetch = original;
  };
  restore.calls = calls;
  return restore;
}

/** Chat-Completion-Antwort im OpenAI-kompatiblen Format. */
function completion(text, finishReason = 'stop') {
  return {
    ok: true,
    json: async () => ({
      choices: [{ finish_reason: finishReason, message: { role: 'assistant', content: text } }]
    })
  };
}

/** 429-Antwort mit optionalen Rate-Limit-Headern. */
function rateLimited(errText, headers = {}) {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: false,
    status: 429,
    headers: { get: (name) => lower.get(name.toLowerCase()) ?? null },
    text: async () => errText
  };
}

const baseArgs = {
  persona: 'Testpersona',
  shortTermMessages: [],
  userMemories: [],
  serverMemories: [],
  currentUserName: 'Alice',
  currentUserMessage: 'Hallo'
};

test('askLlm parst reply, new_user_memories und new_server_memories aus einer erfolgreichen Antwort', async () => {
  const restore = mockFetchOnce(
    completion(
      JSON.stringify({
        reply: 'Hallo Alice!',
        new_user_memories: ['mag Kaffee'],
        new_server_memories: ['Server dreht sich um Minecraft']
      })
    )
  );

  try {
    const result = await askLlm(baseArgs);
    assert.deepEqual(result, {
      reply: 'Hallo Alice!',
      newUserMemories: ['mag Kaffee'],
      newServerMemories: ['Server dreht sich um Minecraft']
    });
  } finally {
    restore();
  }
});

test('askLlm liefert leere Arrays, wenn new_user_memories/new_server_memories fehlen', async () => {
  const restore = mockFetchOnce(completion(JSON.stringify({ reply: 'ok' })));

  try {
    const result = await askLlm(baseArgs);
    assert.deepEqual(result, { reply: 'ok', newUserMemories: [], newServerMemories: [] });
  } finally {
    restore();
  }
});

test('askLlm gibt eine generische Fallback-Antwort zurueck statt kaputtem Rohtext', async () => {
  const restore = mockFetchOnce(completion('kein json hier, '.repeat(500), 'length'));

  try {
    const result = await askLlm(baseArgs);
    assert.deepEqual(result, { reply: GENERIC_FALLBACK_REPLY, newUserMemories: [], newServerMemories: [] });
  } finally {
    restore();
  }
});

test('askLlm kappt die Anzahl der Erinnerungen auf MAX_MEMORY_ITEMS und kuerzt moderat zu lange', async () => {
  // Moderates Ueberschreiten wird gekuerzt: der Satz ist dann zwar beschnitten, aber noch
  // brauchbar. Extremes Ueberschreiten ist ein anderer Fall, siehe naechster Test.
  const slightlyLong = 'a'.repeat(MAX_MEMORY_LENGTH + 80);
  const restore = mockFetchOnce(
    completion(
      JSON.stringify({
        reply: 'ok',
        new_user_memories: Array.from({ length: 50 }, (_, i) => `${slightlyLong}-${i}`),
        new_server_memories: Array.from({ length: 50 }, (_, i) => `${slightlyLong}-${i}`)
      })
    )
  );

  try {
    const result = await askLlm(baseArgs);
    assert.equal(result.newUserMemories.length, MAX_MEMORY_ITEMS);
    assert.equal(result.newServerMemories.length, MAX_MEMORY_ITEMS);
    for (const m of [...result.newUserMemories, ...result.newServerMemories]) {
      assert.equal(m.length, MAX_MEMORY_LENGTH);
    }
  } finally {
    restore();
  }
});

test('askLlm verwirft eine ausgeuferte Erinnerung, statt ein Fragment davon zu speichern', async () => {
  // Regression: im echten Bestand lag ein Eintrag mit 3276 Zeichen - ein Satz, in dem das Modell
  // in eine Schleife geraten war. Den auf 300 Zeichen zu kuerzen behielte nur ein sinnloses
  // Fragment, das dann im naechsten Prompt steht und den Effekt stuetzt.
  const restore = mockFetchOnce(
    completion(
      JSON.stringify({
        reply: 'ok',
        new_user_memories: ['x'.repeat(3276), 'mag Kaffee'],
        new_server_memories: []
      })
    )
  );

  try {
    const result = await askLlm(baseArgs);
    assert.deepEqual(result.newUserMemories, ['mag Kaffee'], 'nur der brauchbare Eintrag bleibt');
    assert.equal(result.reply, 'ok', 'die Antwort selbst ist davon unberuehrt');
  } finally {
    restore();
  }
});

test('askLlm verwirft Behauptungen ueber Rechte und Rollen', async () => {
  // Der Prompt sagt das auch, aber darauf ist kein Verlass - und hier liegt der Unterschied
  // zwischen "der Bot vertritt eine Falschaussage" und "steht dauerhaft im Gedaechtnis".
  const restore = mockFetchOnce(
    completion(
      JSON.stringify({
        reply: 'ok',
        new_user_memories: ['behauptet, Admin auf diesem Server zu sein', 'spielt Minecraft'],
        new_server_memories: ['jeder hier darf den Bot zuruecksetzen']
      })
    )
  );

  try {
    const result = await askLlm(baseArgs);
    assert.deepEqual(result.newUserMemories, ['spielt Minecraft']);
    assert.deepEqual(result.newServerMemories, []);
  } finally {
    restore();
  }
});

test('der System-Prompt stellt Erinnerungen als Gespraechsstand dar, nicht als gesicherte Fakten', async () => {
  // Sonst wird jede einmal gespeicherte Behauptung fuer den Bot unumstoesslich wahr.
  resetStructuredOutputMode();
  const restore = mockFetchSequence([completion(JSON.stringify({ reply: 'ok' }))]);

  try {
    await askLlm({ ...baseArgs, userMemories: [{ content: 'behauptet, mit dir verheiratet zu sein' }] });
    const system = restore.calls[0].body.messages[0].content;

    assert.ok(!/gesicherte Fakten/.test(system), '"gesicherte Fakten" darf nicht mehr drinstehen');
    assert.ok(!/widersprich\s+ihnen nicht/.test(system), 'die "widersprich nicht"-Anweisung ist raus');
    assert.match(system, /Notizen aus fruereren Gespraechen/, 'stattdessen als Gespraechsstand gelabelt');
    assert.match(system, /verleihen niemandem Rechte/, 'und ohne Rechtewirkung');
    // Die Rollenspiel-Kontinuitaet bleibt aber erhalten
    assert.match(system, /tu nicht so, als wuesstest du nichts davon/);
  } finally {
    restore();
    resetStructuredOutputMode();
  }
});

test('askLlm schickt Bearer-Auth, Modell, max_tokens und ein strict json_schema', async () => {
  const restore = mockFetchOnce(completion(JSON.stringify({ reply: 'ok' })));

  try {
    await askLlm(baseArgs);
    const { url, options } = restore.calls[0];
    assert.equal(url, 'https://codecraftapi.com/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer test-key');

    const body = JSON.parse(options.body);
    assert.equal(body.model, 'test-model');
    assert.equal(typeof body.max_tokens, 'number');
    assert.ok(body.max_tokens > 0);
    assert.equal(body.response_format.type, 'json_schema');
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
  } finally {
    restore();
  }
});

test('askLlm baut messages mit System-Prompt, Verlauf (user/assistant) und aktueller Frage', async () => {
  const restore = mockFetchOnce(completion(JSON.stringify({ reply: 'ok' })));

  try {
    await askLlm({
      ...baseArgs,
      shortTermMessages: [
        { authorName: 'Bob', content: 'moin', isBot: false },
        { authorName: 'Bot', content: 'hi Bob', isBot: true },
        { authorName: 'Leer', content: '   ', isBot: false }
      ]
    });

    const { messages } = JSON.parse(restore.calls[0].options.body);
    assert.equal(messages[0].role, 'system');
    assert.ok(messages[0].content.includes('Testpersona'));
    assert.deepEqual(messages.slice(1), [
      { role: 'user', content: 'Bob: moin' },
      { role: 'assistant', content: 'hi Bob' },
      { role: 'user', content: 'Alice: Hallo' }
    ]);
  } finally {
    restore();
  }
});

test('askLlm liest content auch, wenn es als Array von Text-Parts kommt', async () => {
  const restore = mockFetchOnce({
    ok: true,
    json: async () => ({
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', reasoning: 'kurz nachgedacht', content: [{ type: 'text', text: '{"reply":"ok"}' }] }
        }
      ]
    })
  });

  try {
    const result = await askLlm(baseArgs);
    assert.equal(result.reply, 'ok');
  } finally {
    restore();
  }
});

test('askLlm wirft LlmRateLimitError mit retryAfterSeconds bei 429 (kein Tageslimit)', async () => {
  const restore = mockFetchOnce(
    rateLimited(JSON.stringify({ error: { message: 'Rate limit exceeded: requests per minute', type: 'too_many_requests' } }), {
      'retry-after': '23',
      'x-ratelimit-remaining-requests-day': '412'
    })
  );

  try {
    await assert.rejects(
      () => askLlm(baseArgs),
      (err) => {
        assert.ok(err instanceof LlmRateLimitError);
        assert.equal(err.retryAfterSeconds, 23);
        assert.equal(err.isDailyQuota, false);
        assert.equal(err.dailyQuotaLimit, null);
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('askLlm erkennt das Tageskontingent an den Rate-Limit-Headern', async () => {
  const restore = mockFetchOnce(rateLimited(JSON.stringify({ error: { message: 'token quota exceeded' } }), {
    'x-ratelimit-limit-requests-day': '1000',
    'x-ratelimit-remaining-requests-day': '0',
    'retry-after': '11'
  }));

  try {
    await assert.rejects(
      () => askLlm(baseArgs),
      (err) => {
        assert.ok(err instanceof LlmRateLimitError);
        assert.equal(err.isDailyQuota, true);
        assert.equal(err.dailyQuotaLimit, 1000);
        assert.equal(err.retryAfterSeconds, 11);
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('askLlm erkennt das Tageskontingent auch ohne Header am Fehlertext', async () => {
  const restore = mockFetchOnce(
    rateLimited(JSON.stringify({ error: { message: 'You exceeded your tokens per day quota', code: 'tokens_per_day_exceeded' } }))
  );

  try {
    await assert.rejects(
      () => askLlm(baseArgs),
      (err) => {
        assert.ok(err instanceof LlmRateLimitError);
        assert.equal(err.isDailyQuota, true);
        assert.equal(err.dailyQuotaLimit, null);
        assert.equal(err.retryAfterSeconds, null);
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('askLlm wirft LlmBillingError bei 402 (payment_required)', async () => {
  const restore = mockFetchOnce({
    ok: false,
    status: 402,
    headers: { get: () => null },
    text: async () =>
      '{"message":"Payment required to access this resource. Visit your billing tab.","type":"payment_required_error","param":"quota","code":"payment_required"}'
  });

  try {
    await assert.rejects(
      () => askLlm(baseArgs),
      (err) => {
        assert.ok(err instanceof LlmBillingError);
        assert.ok(!(err instanceof LlmRateLimitError));
        assert.match(err.message, /payment_required/);
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('askLlm wirft einen normalen Error bei anderen HTTP-Fehlern', async () => {
  const restore = mockFetchOnce({
    ok: false,
    status: 500,
    headers: { get: () => null },
    text: async () => 'internal server error'
  });

  try {
    await assert.rejects(() => askLlm(baseArgs), /LLM API Fehler \(500\)/);
  } finally {
    restore();
  }
});

test('extractMemories mappt user_id/content und server_memories aus dem Batch-Transcript', async () => {
  const restore = mockFetchOnce(
    completion(
      JSON.stringify({
        user_memories: [
          { user_id: '111', content: 'mag Tee' },
          { user_id: '222', content: 'arbeitet an einem Discord-Bot' }
        ],
        server_memories: ['Server dreht sich um Minecraft']
      })
    )
  );

  try {
    const result = await extractMemories({
      persona: 'Testpersona',
      messages: [
        { authorId: '111', authorName: 'Alice', content: 'ich trink grad Tee' },
        { authorId: '222', authorName: 'Bob', content: 'ich bau an meinem Discord-Bot' }
      ]
    });
    assert.deepEqual(result, {
      userMemories: [
        { userId: '111', content: 'mag Tee' },
        { userId: '222', content: 'arbeitet an einem Discord-Bot' }
      ],
      serverMemories: ['Server dreht sich um Minecraft']
    });
  } finally {
    restore();
  }
});

test('extractMemories gibt leere Arrays zurueck, wenn Felder fehlen oder Eintraege ungueltig sind', async () => {
  const restore = mockFetchOnce(completion(JSON.stringify({ user_memories: [{ user_id: '111' }, { content: 'ohne user_id' }] })));

  try {
    const result = await extractMemories({ persona: 'Testpersona', messages: [] });
    assert.deepEqual(result, { userMemories: [], serverMemories: [] });
  } finally {
    restore();
  }
});

test('extractMemories gibt leere Arrays bei kaputtem JSON zurueck (kein Fallback wie bei askLlm)', async () => {
  const restore = mockFetchOnce(completion('kein json'));

  try {
    const result = await extractMemories({ persona: 'Testpersona', messages: [] });
    assert.deepEqual(result, { userMemories: [], serverMemories: [] });
  } finally {
    restore();
  }
});

// ---- Structured Outputs: json_schema mit Fallback auf json_object ----
// Nicht jeder OpenAI-kompatible Endpoint kann json_schema mit strict:true. Welcher Fall
// vorliegt, zeigt erst ein echter Request, also wird beim ersten passenden 400 einmal
// heruntergestuft - und das gemerkt, damit nicht jeder Call einen Fehlversuch bezahlt.

/** Liefert der Reihe nach die uebergebenen Antworten (fuer Retry-Pfade). */
function mockFetchSequence(responses) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return responses[Math.min(calls.length - 1, responses.length - 1)];
  };
  const restore = () => {
    globalThis.fetch = original;
  };
  restore.calls = calls;
  return restore;
}

/** 400er-Antwort, z.B. weil der Endpoint response_format/json_schema nicht kennt. */
function badRequest(errText) {
  return { ok: false, status: 400, headers: { get: () => null }, text: async () => errText };
}

test('askLlm schickt standardmaessig json_schema mit strict:true', async () => {
  resetStructuredOutputMode();
  const restore = mockFetchSequence([completion(JSON.stringify({ reply: 'ok' }))]);

  try {
    await askLlm(baseArgs);
    const { response_format } = restore.calls[0].body;
    assert.equal(response_format.type, 'json_schema');
    assert.equal(response_format.json_schema.strict, true);
    assert.equal(response_format.json_schema.name, 'discord_reply');
    assert.equal(getStructuredOutputMode(), 'json_schema');
  } finally {
    restore();
    resetStructuredOutputMode();
  }
});

test('askLlm stuft bei einem 400 wegen json_schema auf json_object herunter und wiederholt den Call', async () => {
  resetStructuredOutputMode();
  const restore = mockFetchSequence([
    badRequest('{"error":{"message":"response_format.json_schema is not supported"}}'),
    completion(JSON.stringify({ reply: 'ok' }))
  ]);

  try {
    const result = await askLlm(baseArgs);
    assert.equal(result.reply, 'ok');
    assert.equal(restore.calls.length, 2, 'erwartet: ein Fehlversuch plus ein Retry');
    assert.equal(restore.calls[0].body.response_format.type, 'json_schema');
    assert.deepEqual(restore.calls[1].body.response_format, { type: 'json_object' });
  } finally {
    restore();
    resetStructuredOutputMode();
  }
});

test('askLlm merkt sich die Herabstufung und probiert json_schema nicht erneut', async () => {
  resetStructuredOutputMode();
  const first = mockFetchSequence([
    badRequest('unsupported response_format'),
    completion(JSON.stringify({ reply: 'ok' }))
  ]);
  try {
    await askLlm(baseArgs);
  } finally {
    first();
  }
  assert.equal(getStructuredOutputMode(), 'json_object');

  const second = mockFetchSequence([completion(JSON.stringify({ reply: 'zwei' }))]);
  try {
    await askLlm(baseArgs);
    assert.equal(second.calls.length, 1, 'kein Fehlversuch mehr');
    assert.deepEqual(second.calls[0].body.response_format, { type: 'json_object' });
  } finally {
    second();
    resetStructuredOutputMode();
  }
});

test('askLlm wiederholt einen 400 NICHT, wenn er nichts mit response_format zu tun hat', async () => {
  resetStructuredOutputMode();
  const restore = mockFetchSequence([badRequest('{"error":{"message":"unknown model: nope"}}')]);

  try {
    await assert.rejects(() => askLlm(baseArgs), /LLM API Fehler \(400\).*unknown model/s);
    assert.equal(restore.calls.length, 1, 'kein Retry bei fachfremdem 400');
    assert.equal(getStructuredOutputMode(), 'json_schema', 'Modus bleibt unangetastet');
  } finally {
    restore();
    resetStructuredOutputMode();
  }
});

test('extractMemories nennt die JSON-Form im Prompt, damit sie auch ohne json_schema stimmt', async () => {
  resetStructuredOutputMode();
  const restore = mockFetchSequence([
    completion(JSON.stringify({ user_memories: [], server_memories: [] }))
  ]);

  try {
    await extractMemories({ persona: 'P', messages: [{ authorId: '1', authorName: 'A', content: 'hi' }] });
    const system = restore.calls[0].body.messages[0].content;
    assert.equal(restore.calls[0].body.messages[0].role, 'system');
    assert.ok(system.includes('"user_memories"'), 'Form der Antwort fehlt im System-Prompt');
    assert.ok(system.includes('"server_memories"'));
  } finally {
    restore();
    resetStructuredOutputMode();
  }
});

test('callLlm meldet fehlende Konfiguration klar, statt mit halbem Request loszulaufen', async () => {
  // Frische Modul-Instanz ohne Key: die Env wird beim Import gelesen, ein Query-Suffix
  // umgeht den ESM-Modulcache.
  const savedKey = process.env.LLM_API_KEY;
  const savedModel = process.env.LLM_MODEL;

  try {
    delete process.env.LLM_API_KEY;
    process.env.LLM_MODEL = 'test-model';
    const noKey = await import('../src/llm.js?case=nokey');
    await assert.rejects(() => noKey.askLlm(baseArgs), /LLM_API_KEY ist nicht gesetzt/);

    process.env.LLM_API_KEY = 'test-key';
    delete process.env.LLM_MODEL;
    const noModel = await import('../src/llm.js?case=nomodel');
    await assert.rejects(() => noModel.askLlm(baseArgs), /LLM_MODEL ist nicht gesetzt/);
  } finally {
    process.env.LLM_API_KEY = savedKey;
    process.env.LLM_MODEL = savedModel;
  }
});

test('LLM_BASE_URL laesst sich auf einen anderen OpenAI-kompatiblen Endpoint umbiegen', async () => {
  const saved = process.env.LLM_BASE_URL;
  try {
    process.env.LLM_BASE_URL = 'https://example.invalid/v1/'; // mit Slash am Ende
    const mod = await import('../src/llm.js?case=baseurl');
    const restore = mockFetchSequence([completion(JSON.stringify({ reply: 'ok' }))]);
    try {
      await mod.askLlm(baseArgs);
      assert.equal(restore.calls[0].url, 'https://example.invalid/v1/chat/completions');
    } finally {
      restore();
    }
  } finally {
    if (saved === undefined) delete process.env.LLM_BASE_URL;
    else process.env.LLM_BASE_URL = saved;
  }
});

// ---- Call-Recorder: Datenbasis fuer Verlauf und Token-Aufschluesselung ----

test('setCallRecorder bekommt Request, Antwort, usage und Laufzeit gemeldet', async () => {
  resetStructuredOutputMode();
  const seen = [];
  setCallRecorder((entry) => seen.push(entry));
  const restore = mockFetchSequence([{
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ reply: 'hi' }) } }],
      usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 }
    })
  }]);

  try {
    await askLlm(baseArgs);
    assert.equal(seen.length, 1);
    const e = seen[0];
    assert.equal(e.kind, 'reply');
    assert.equal(e.ok, true);
    assert.equal(e.status, 200);
    assert.deepEqual(e.usage, { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 });
    assert.equal(e.finishReason, 'stop');
    assert.equal(e.structuredMode, 'json_schema');
    assert.equal(e.request.messages[0].role, 'system', 'der System-Prompt gehoert in den Mitschnitt');
    assert.ok(Number.isFinite(e.latencyMs));
    assert.ok(e.responseText.includes('usage'), 'der ganze Envelope wird festgehalten');
  } finally {
    restore();
    setCallRecorder(null);
    resetStructuredOutputMode();
  }
});

test('extractMemories meldet sich als kind "extract"', async () => {
  resetStructuredOutputMode();
  const seen = [];
  setCallRecorder((entry) => seen.push(entry));
  const restore = mockFetchSequence([completion(JSON.stringify({ user_memories: [], server_memories: [] }))]);

  try {
    await extractMemories({ persona: 'P', messages: [{ authorId: '1', authorName: 'A', content: 'hi' }] });
    assert.equal(seen[0].kind, 'extract');
  } finally {
    restore();
    setCallRecorder(null);
    resetStructuredOutputMode();
  }
});

test('auch der fehlgeschlagene Versuch einer Herabstufung wird mitgeschrieben', async () => {
  // Sonst fehlen im Verlauf genau die Calls, die Geld gekostet haben aber nichts geliefert haben.
  resetStructuredOutputMode();
  const seen = [];
  setCallRecorder((entry) => seen.push(entry));
  const restore = mockFetchSequence([
    badRequest('response_format json_schema not supported'),
    completion(JSON.stringify({ reply: 'ok' }))
  ]);

  try {
    await askLlm(baseArgs);
    assert.equal(seen.length, 2, 'Fehlversuch und Retry');
    assert.equal(seen[0].ok, false);
    assert.equal(seen[0].status, 400);
    assert.equal(seen[0].structuredMode, 'json_schema');
    assert.match(seen[0].error, /HTTP 400/);
    assert.equal(seen[1].ok, true);
    assert.equal(seen[1].structuredMode, 'json_object');
  } finally {
    restore();
    setCallRecorder(null);
    resetStructuredOutputMode();
  }
});

test('ein 429 wird mitgeschrieben, bevor der Fehler geworfen wird', async () => {
  resetStructuredOutputMode();
  const seen = [];
  setCallRecorder((entry) => seen.push(entry));
  const restore = mockFetchSequence([rateLimited('{"error":{"message":"slow down"}}', { 'retry-after': '30' })]);

  try {
    await assert.rejects(() => askLlm(baseArgs), LlmRateLimitError);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].ok, false);
    assert.equal(seen[0].status, 429);
    assert.equal(seen[0].usage, null, 'ein Fehlversuch liefert keine Tokenzahlen');
  } finally {
    restore();
    setCallRecorder(null);
    resetStructuredOutputMode();
  }
});

test('ein werfender Recorder bringt den Bot nicht um', async () => {
  resetStructuredOutputMode();
  setCallRecorder(() => { throw new Error('Log kaputt'); });
  const restore = mockFetchSequence([completion(JSON.stringify({ reply: 'trotzdem da' }))]);

  try {
    const result = await askLlm(baseArgs);
    assert.equal(result.reply, 'trotzdem da');
  } finally {
    restore();
    setCallRecorder(null);
    resetStructuredOutputMode();
  }
});

// ---- Transiente Ausfaelle des Endpoints ----
// Anlass: im Betrieb kam eine Cloudflare-502-Seite von 6442 Zeichen zurueck. Minuten spaeter
// lief derselbe Endpoint wieder - ohne Retry kostet so ein Blip jedes Mal eine Antwort.

/** 502 mit einer HTML-Fehlerseite, wie Cloudflare sie liefert. */
function badGateway() {
  const page = '<!DOCTYPE html><html lang="en-US"><head><title>codecraftapi.com | 502: Bad gateway</title>'
    + '<meta charset="UTF-8" />'.repeat(200) + '</head><body>error</body></html>';
  return { ok: false, status: 502, headers: { get: () => null }, text: async () => page };
}

test('askLlm wiederholt einen 502 und liefert die Antwort des gelungenen Versuchs', async () => {
  resetStructuredOutputMode();
  const restore = mockFetchSequence([badGateway(), completion(JSON.stringify({ reply: 'endlich da' }))]);

  try {
    const result = await askLlm(baseArgs);
    assert.equal(result.reply, 'endlich da');
    assert.equal(restore.calls.length, 2, 'ein Fehlversuch plus ein erfolgreicher');
  } finally {
    restore();
    resetStructuredOutputMode();
  }
});

test('askLlm wirft LlmUnavailableError, wenn der Endpoint dauerhaft mit 502 antwortet', async () => {
  resetStructuredOutputMode();
  const restore = mockFetchSequence([badGateway()]);

  try {
    await assert.rejects(() => askLlm(baseArgs), (err) => {
      assert.equal(err.name, 'LlmUnavailableError');
      assert.equal(err.status, 502);
      assert.ok(err.attempts >= 2, 'es wurde wiederholt');
      assert.match(err.message, /502: Bad gateway/, 'der Titel der Fehlerseite steht in der Meldung');
      return true;
    });
  } finally {
    restore();
    resetStructuredOutputMode();
  }
});

test('eine HTML-Fehlerseite landet zusammengefasst im Log, nicht in voller Laenge', async () => {
  // Sonst frisst eine einzige 502-Seite mehrere Kilobyte im Ringpuffer und im Export.
  resetStructuredOutputMode();
  const seen = [];
  setCallRecorder((entry) => seen.push(entry));
  const restore = mockFetchSequence([badGateway()]);

  try {
    await assert.rejects(() => askLlm(baseArgs));
    assert.ok(seen.length >= 2, 'jeder Versuch wird protokolliert');
    for (const entry of seen) {
      assert.ok(entry.responseText.length < 200, `Log-Eintrag ist ${entry.responseText.length} Zeichen lang`);
      assert.match(entry.responseText, /HTML-Fehlerseite, \d+ Zeichen\] codecraftapi\.com \| 502/);
    }
  } finally {
    restore();
    setCallRecorder(null);
    resetStructuredOutputMode();
  }
});

test('askLlm wiederholt auch einen Netzwerkfehler und meldet ihn danach als nicht erreichbar', async () => {
  resetStructuredOutputMode();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError('fetch failed'); };

  try {
    await assert.rejects(() => askLlm(baseArgs), (err) => {
      assert.equal(err.name, 'LlmUnavailableError');
      assert.match(err.message, /nicht erreichbar/);
      return true;
    });
    assert.ok(calls >= 2, `es wurde wiederholt (${calls} Versuche)`);
  } finally {
    globalThis.fetch = original;
    resetStructuredOutputMode();
  }
});

test('ein 500 wird NICHT wiederholt - das ist die Anwendung des Anbieters, nicht das Gateway', async () => {
  resetStructuredOutputMode();
  const restore = mockFetchSequence([
    { ok: false, status: 500, headers: { get: () => null }, text: async () => 'internal server error' }
  ]);

  try {
    await assert.rejects(() => askLlm(baseArgs), /LLM API Fehler \(500\)/);
    assert.equal(restore.calls.length, 1, 'genau ein Versuch');
  } finally {
    restore();
    resetStructuredOutputMode();
  }
});

test('ein 429 wird NICHT wiederholt - dafuer ist der Rate Limiter da', async () => {
  resetStructuredOutputMode();
  const restore = mockFetchSequence([rateLimited('{"error":{"message":"slow down"}}')]);

  try {
    await assert.rejects(() => askLlm(baseArgs), LlmRateLimitError);
    assert.equal(restore.calls.length, 1);
  } finally {
    restore();
    resetStructuredOutputMode();
  }
});

test('sendWithRetry bricht ab, wenn das Zeitbudget keinen weiteren Anlauf mehr traegt', async () => {
  // Am echten Endpoint braucht ein Versuch 4,6-6,6s. Ohne Zeitdeckel wartet der User rund 19
  // Sekunden auf einen Fehler, obwohl der Typing-Indikator nach 10s ausgelaufen ist.
  resetStructuredOutputMode();
  const original = globalThis.fetch;
  let calls = 0;
  const SLOW_MS = 7000;

  // Der Aufruf selbst wird nicht wirklich langsam gemacht - stattdessen meldet der Mock eine
  // hohe Latenz zurueck, denn genau die rechnet das Budget gegen.
  globalThis.fetch = async () => {
    calls++;
    return {
      ok: false,
      status: 502,
      headers: { get: () => null },
      text: async () => '<html><head><title>502: Bad gateway</title></head></html>'
    };
  };
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => (clock += SLOW_MS); // jeder Zeitabruf springt um die Dauer eines Versuchs

  try {
    await assert.rejects(() => askLlm(baseArgs), (err) => {
      assert.equal(err.name, 'LlmUnavailableError');
      assert.ok(err.attempts < 3, `nach ${err.attempts} Versuchen abgebrochen, nicht erst nach 3`);
      return true;
    });
    assert.ok(calls < 3, `${calls} Versuche - das Budget hat weitere verhindert`);
  } finally {
    Date.now = realNow;
    globalThis.fetch = original;
    resetStructuredOutputMode();
  }
});
